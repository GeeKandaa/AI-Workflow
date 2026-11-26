// Plan Workflow UI — plain ES modules, no build step. Hash routes:
//   #/                      workspaces            #/settings            settings
//   #/ws/<id>               plan board            #/ws/<id>/plan/<p>    plan detail
//   #/ws/<id>/run/<runId>   phase run (live)
import { renderMarkdown, esc } from './md.js';

const $app = document.getElementById('app');
const $sel = document.getElementById('ws-select');
const $conn = document.getElementById('conn');
const state = { config: null, wsId: localStorageGet('ws'), snap: null, es: null, runEs: null };
const STATUSES = ['planning', 'staged', 'confirmation'];

function localStorageGet(k) { try { return localStorage.getItem(`planui.${k}`); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(`planui.${k}`, v); } catch {} }

// --- breadcrumbs: ← up one level, → forward to the last opened or latest item one level down -------------------------

// Remembered in this browser only; everything falls back to the latest item without it.
const lastPlanKey = (wsId) => `lastPlan.${wsId}`;
const lastRunKey = (wsId, plan) => `lastRun.${wsId}.${plan}`;
function rememberOpened(wsId, plan, run = null) {
  if (!plan) return;
  localStorageSet(lastPlanKey(wsId), plan);
  if (run) localStorageSet(lastRunKey(wsId, plan), run);
}

/**
 * Forward links, from items newest first as [{ id, href, label }]. The last opened one if it still exists, plus the
 * latest when that is a different one; just the latest when none has been opened.
 */
function forwardLinks(items, lastId) {
  const latest = items[0];
  if (!latest) return '';
  const last = items.find((x) => x.id === lastId);
  const link = (x, what) => `<a href="${esc(x.href)}" title="${esc(what)}"><span class="muted">${esc(what)}:</span> ${esc(x.label)} →</a>`;
  return [last && last !== latest ? link(last, 'Last opened') : '', link(latest, last === latest ? 'Last opened' : 'Latest')].filter(Boolean).join('');
}
const crumbs = (back, forward) => `<nav class="crumbs small" aria-label="Breadcrumbs"><span>${back}</span><span class="forward">${forward}</span></nav>`;

// --- API ------------------------------------------------------------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Plan-UI': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
const ws = () => state.config?.workspaces.find((w) => w.id === state.wsId) || null;

function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `show${error ? ' error' : ''}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), error ? 12000 : 4000);
}

// --- live status ----------------------------------------------------------------------------------------------------

function connect() {
  if (state.es) { state.es.close(); state.es = null; }
  state.snap = null;
  if (!state.wsId) return;
  const es = new EventSource(`/api/ws/${state.wsId}/events`);
  state.es = es;
  es.onopen = () => ($conn.className = 'conn on');
  es.onerror = () => ($conn.className = 'conn off');
  es.addEventListener('status', (e) => { state.snap = JSON.parse(e.data); route(); });
  es.addEventListener('status-error', (e) => toast(`Status failed: ${JSON.parse(e.data).message}`, true));
  es.addEventListener('run', (e) => {
    const m = JSON.parse(e.data);
    if (m.status !== 'running') toast(`${m.phase}${m.plan ? ` ${m.plan}` : ''}: ${m.status}`, m.status === 'failed');
  });
}

function selectWorkspace(id) {
  state.wsId = id; localStorageSet('ws', id || '');
  renderSelect(); connect();
}

function renderSelect() {
  const list = state.config?.workspaces || [];
  $sel.innerHTML = list.length ? list.map((w) => `<option value="${esc(w.id)}"${w.id === state.wsId ? ' selected' : ''}>${esc(w.name)}</option>`).join('')
    : '<option value="">No workspaces</option>';
  $sel.disabled = !list.length;
}
$sel.addEventListener('change', () => { selectWorkspace($sel.value); location.hash = `#/ws/${$sel.value}`; });

// --- routing --------------------------------------------------------------------------------------------------------

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'ws' && parts[1]) {
    if (parts[2] === 'plan' && parts[3]) return { view: 'plan', ws: parts[1], plan: parts[3] };
    if (parts[2] === 'run' && parts[3]) return { view: 'run', ws: parts[1], run: parts[3] };
    return { view: 'board', ws: parts[1] };
  }
  return { view: 'workspaces' };
}

let lastView = null;
function route() {
  const r = parseHash();
  if (r.ws && r.ws !== state.wsId && state.config?.workspaces.some((w) => w.id === r.ws)) selectWorkspace(r.ws);
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === r.view);
  const key = JSON.stringify(r);
  if (r.view !== 'run' && state.runEs) { state.runEs.close(); state.runEs = null; }
  // Views that hold form input only re-render on navigation, not on every status push; nor while a dialog is open.
  if ((r.view === 'settings' || r.view === 'run' || document.querySelector('dialog[open]')) && key === lastView) return;
  lastView = key;
  document.body.classList.toggle('fill', r.view === 'run'); // the run view fits the window; its transcript scrolls
  ({ workspaces: viewWorkspaces, settings: viewSettings, board: viewBoard, plan: viewPlan, run: viewRun })[r.view](r);
}
window.addEventListener('hashchange', route);

// --- views: workspaces ----------------------------------------------------------------------------------------------

// A banner when the claude command can't run headless phases (missing, or not signed in).
async function healthBanner(fresh = false) {
  try { state.health = await api('GET', `/api/health${fresh ? '?fresh' : ''}`); } catch { return; }
  const el = document.getElementById('health');
  if (el) el.innerHTML = state.health.ok ? '' : `<div class="banner error" style="margin-bottom:12px">${esc(state.health.error)}
    <button class="small" id="recheck">Check again</button></div>`;
  document.getElementById('recheck')?.addEventListener('click', () => healthBanner(true));
}

function viewWorkspaces() {
  const list = state.config.workspaces;
  $app.innerHTML = `
    <div id="health"></div>
    <h1>Workspaces</h1>
    <p class="muted">A workspace is a folder where the plan workflow template has been deployed (it contains
    <code>.claude/workflow/plan.mjs</code>).</p>
    <div class="panel stack">
      ${list.length ? `<ul class="plain">${list.map((w) => `
        <li class="row"><a href="#/ws/${esc(w.id)}"><strong>${esc(w.name)}</strong></a>
          <span class="muted small">${esc(w.path)}</span>
          <button class="danger small" data-remove="${esc(w.id)}">Remove</button>
          <details style="flex-basis:100%"><summary class="small">Allowed commands, every phase (${(w.allowedTools || []).length})</summary>
            <form class="stack" data-rules="${esc(w.id)}" style="margin-top:6px">
              <textarea name="rules" rows="4" placeholder="One rule per line, e.g. Bash(dotnet:*) and PowerShell(dotnet:*)">${esc((w.allowedTools || []).join('\n'))}</textarea>
              <div class="row"><button class="small">Save</button><span class="muted small">Added to every headless run in this workspace, on top of each phase's rules.</span></div>
            </form></details></li>`).join('')}</ul>`
        : '<p class="muted">No workspaces yet.</p>'}
      <form id="add-ws" class="row">
        <input type="text" name="path" placeholder="Workspace folder, e.g. C:\\Code\\my-project" size="48" required>
        <input type="text" name="name" placeholder="Display name (optional)">
        <button class="primary">Add workspace</button>
      </form>
    </div>
    <p class="muted small">Each workspace must be trusted by Claude Code: open a terminal there, run <code>claude</code> once and
    accept the trust prompt. Until then, headless runs ignore the workspace's <code>permissions.allow</code> rules.</p>`;
  healthBanner();
  $app.querySelector('#add-ws').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      const w = await api('POST', '/api/workspaces', { path: f.get('path'), name: f.get('name') });
      await loadConfig(); selectWorkspace(w.id); location.hash = `#/ws/${w.id}`;
    } catch (err) { toast(err.message, true); }
  });
  for (const f of $app.querySelectorAll('[data-rules]')) f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rules = String(new FormData(f).get('rules') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    try { await api('PUT', `/api/workspaces/${f.dataset.rules}/allow`, { rules }); await loadConfig(); toast('Saved.'); route(); }
    catch (err) { toast(err.message, true); }
  });
  for (const b of $app.querySelectorAll('[data-remove]')) b.addEventListener('click', async () => {
    if (!confirm('Remove this workspace from the UI? Its files and plans are not touched.')) return;
    try { await api('DELETE', `/api/workspaces/${b.dataset.remove}`); await loadConfig();
      if (state.wsId === b.dataset.remove) selectWorkspace(state.config.workspaces[0]?.id || null); route();
    } catch (err) { toast(err.message, true); }
  });
}

// --- views: board ---------------------------------------------------------------------------------------------------

function viewBoard() {
  const w = ws();
  if (!w) { location.hash = '#/'; return; }
  if (!state.snap) { $app.innerHTML = '<p class="muted">Loading…</p>'; return; }
  const { status, archived, runs } = state.snap;
  const running = new Map(runs.map((r) => [r.plan, r]));
  const draft = document.getElementById('desc'); // keep a half-typed description across live re-renders
  const keep = draft ? { value: draft.value, focused: document.activeElement === draft, sel: [draft.selectionStart, draft.selectionEnd] } : null;
  const card = (p) => `
    <a class="card ${esc(p.status)}" href="#/ws/${esc(w.id)}/plan/${esc(p.name)}">
      <div class="title">${esc(p.title)}</div>
      <div class="meta small muted">${esc(p.name)} · ${p.worktrees.map(esc).join(', ') || 'no worktree'}${p.attempt ? ` · attempt ${p.attempt}` : ''}</div>
      <div class="meta row small">
        ${p.pendingDecision ? '<span class="badge warn">deviation pending</span>' : ''}
        ${p.overlaps.length ? `<span class="badge warn">shares files (${p.overlaps.length})</span>` : ''}
        ${p.mergedInto ? `<span class="badge archived">merged into ${esc(p.mergedInto)}</span>` : ''}
        ${p.mergedFrom?.length ? `<span class="badge ${p.mergeGaps?.length ? 'warn' : 'archived'}">+${p.mergedFrom.length} merged</span>` : ''}
        ${p.openQuestions?.length ? `<span class="badge planning" title="Outstanding questions for you">${p.openQuestions.length} question${p.openQuestions.length > 1 ? 's' : ''}</span>` : ''}
        ${running.has(p.name) ? `<span class="badge running">${esc(running.get(p.name).phase)} running</span>` : ''}
        ${status.lock?.plan === p.name ? '<span class="badge confirmation">archiving</span>' : ''}
      </div>
    </a>`;
  $app.innerHTML = `
    <div id="health">${state.health && !state.health.ok ? `<div class="banner error" style="margin-bottom:12px">${esc(state.health.error)}</div>` : ''}</div>
    ${crumbs('<a href="#/">← Workspaces</a>', forwardLinks([
      ...status.plans.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || ''))).map((p) => ({ id: p.name, label: p.title })),
      ...archived.slice().reverse().map((a) => ({ id: a.id, label: `${a.title} (archived)` })),
    ].map((x) => ({ ...x, href: `#/ws/${w.id}/plan/${x.id}` })), localStorageGet(lastPlanKey(w.id))))}
    <div class="row"><h1>${esc(w.name)}</h1><span class="muted small">${esc(w.path)}</span></div>
    <div class="panel" style="margin:12px 0">
      <form id="new-plan" class="stack">
        <label for="desc"><strong>New plan</strong> <span class="muted small">— describe the work; a headless session writes the plan</span></label>
        <textarea id="desc" name="description" placeholder="e.g. Add retry with backoff to the payment client" required></textarea>
        <div class="row"><button class="primary">Write plan</button>
          ${runs.filter((r) => !r.plan).map((r) => `<a class="badge running" href="#/ws/${esc(w.id)}/run/${esc(r.id)}">plan-new running</a>`).join('')}</div>
      </form>
    </div>
    <div class="board">
      ${STATUSES.map((s) => { const list = status.plans.filter((p) => p.status === s); return `
        <section class="col"><h2><span>${s[0].toUpperCase() + s.slice(1)}</span><span class="muted">${list.length}</span></h2>
          ${list.map(card).join('') || '<p class="muted small">None</p>'}</section>`; }).join('')}
    </div>
    <details style="margin-top:16px"><summary>Archived (${archived.length})</summary>
      <ul class="plain" style="margin-top:8px">${archived.slice().reverse().map((a) => `
        <li><a href="#/ws/${esc(w.id)}/plan/${esc(a.id)}">${esc(a.title)}</a> <span class="muted small">${esc(a.archived_at || '')}</span></li>`).join('') || '<li class="muted">None</li>'}</ul>
    </details>`;
  if (keep) {
    const d = document.getElementById('desc'); d.value = keep.value;
    if (keep.focused) { d.focus(); d.setSelectionRange(keep.sel[0], keep.sel[1]); }
  }
  $app.querySelector('#new-plan').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const run = await api('POST', `/api/ws/${w.id}/runs`, { phase: 'new', description: new FormData(e.target).get('description') });
      location.hash = `#/ws/${w.id}/run/${run.id}`;
    } catch (err) { toast(err.message, true); }
  });
}

/**
 * Live status pushes re-render the page; this keeps half-typed text in textareas marked data-keep="<key>".
 * Call before replacing the page, then call the returned function after.
 */
function keepDrafts() {
  const saved = [...document.querySelectorAll('textarea[data-keep]')].map((t) => ({
    key: t.dataset.keep, value: t.value, focused: document.activeElement === t, sel: [t.selectionStart, t.selectionEnd] }));
  return () => {
    for (const s of saved) {
      const t = [...document.querySelectorAll('textarea[data-keep]')].find((x) => x.dataset.keep === s.key);
      if (!t || !s.value) continue;
      t.value = s.value;
      if (s.focused) { t.focus(); t.setSelectionRange(s.sel[0], s.sel[1]); }
    }
  };
}

// --- views: plan detail ---------------------------------------------------------------------------------------------

const GATE_UI = {
  planning:     [{ action: 'stage', label: 'Approve & implement', primary: true },
                 { action: 'merge', label: 'Merge into…', dialog: 'merge' }],
  staged:       [{ action: 'continue', label: 'Approve deviation…', primary: true, needsPending: true, dialog: 'continue' },
                 { action: 'cancel', label: 'Cancel to planning', danger: true }],
  confirmation: [{ action: 'archive-begin', label: 'Accept & archive…', primary: true, dialog: 'archive' },
                 { action: 'rework', label: 'Send back…', dialog: 'rework' },
                 { action: 'merge', label: 'Merge into…', dialog: 'merge' },
                 { action: 'cancel', label: 'Cancel to planning', danger: true }],
};

async function viewPlan(r) {
  const w = ws();
  if (!w) { location.hash = '#/'; return; }
  const p = state.snap?.status.plans.find((x) => x.name === r.plan) || null;
  let doc, runs;
  try { [doc, runs] = await Promise.all([api('GET', `/api/ws/${w.id}/plans/${r.plan}`), api('GET', `/api/ws/${w.id}/runs?plan=${encodeURIComponent(r.plan)}`)]); }
  catch (err) { $app.innerHTML = `<div class="banner error">${esc(err.message)}</div>`; return; }
  if (parseHash().plan !== r.plan) return; // navigated away while loading
  rememberOpened(w.id, r.plan);
  const running = runs.find((x) => x.status === 'running');
  const locked = state.snap?.status.lock;
  const status = p ? p.status : 'archived';
  const archiving = !!(locked && locked.plan === r.plan);
  const gates = p?.mergedInto ? [] : (GATE_UI[status] || []).filter((g) => (!g.needsPending || p?.pendingDecision) && !(archiving && g.action === 'archive-begin'));
  const phases = Object.entries(state.config.phases).filter(([k]) => !['new', 'amend', 'merge'].includes(k));
  const mergeGaps = p?.mergeGaps || [];
  const body = doc.text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lastAsk = runs.find((x) => x.status !== 'running' && x.sessionId && x.result?.text);
  const questions = p?.openQuestions || [];
  const restore = keepDrafts();

  $app.innerHTML = `
    ${crumbs(`<a href="#/ws/${esc(w.id)}">← ${esc(w.name)}</a>`, forwardLinks(runs.map((x) => ({ id: x.id, href: `#/ws/${w.id}/run/${x.id}`,
      label: `${x.parentRunId ? `reply (${x.phase})` : x.phase}${x.status === 'running' ? ' (running)' : ''}` })), localStorageGet(lastRunKey(w.id, r.plan))))}
    <div class="row"><h1>${esc(p?.title || r.plan)}</h1><span class="badge ${esc(status)}">${esc(status)}</span>
      ${running ? `<a class="badge running" href="#/ws/${esc(w.id)}/run/${esc(running.id)}">${esc(running.phase)} running</a>` : ''}</div>
    <p class="muted small">${esc(doc.file)}</p>
    ${p?.pendingDecision ? `<div class="banner" style="margin:10px 0"><strong>Substantial deviation awaiting your decision.</strong> Approve it with your choice of option, or cancel to planning.
      <div class="small" style="margin-top:6px">${renderMarkdown(p.pendingDetail || p.pendingSummary || '')}</div></div>` : ''}
    ${p?.mergedInto ? `<div class="banner row" style="margin:10px 0"><span>Merged into <a href="#/ws/${esc(w.id)}/plan/${esc(p.mergedInto)}">${esc(p.mergedInto)}</a>: it is archived together with that plan.</span>
      <button data-gate="unmerge" ${running ? 'disabled' : ''}>Unmerge</button></div>` : ''}
    ${p?.mergedFrom?.length ? `<div class="banner row" style="margin:10px 0"><span>Merged into this plan: ${p.mergedFrom.map((m) => `<a href="#/ws/${esc(w.id)}/plan/${esc(m)}">${esc(m)}</a>`).join(', ')}. They're archived with it.
      ${mergeGaps.length ? `<br><strong>Not folded in yet:</strong> ${esc(mergeGaps.map((g) => `${g.plan} (${g.files.join(', ')})`).join('; '))}` : ''}</span>
      <button data-phase="merge" class="${mergeGaps.length ? 'primary' : ''}" ${running ? 'disabled' : ''}>Fold merged plans</button></div>` : ''}
    ${locked && locked.plan === r.plan ? `<div class="banner" style="margin:10px 0">Archival in progress (${locked.manualCommit ? 'manual commit' : 'automatic'}). Run the archive phase to reconcile and commit, or abort.</div>` : ''}
    <div class="detail" style="margin-top:12px">
      <article class="panel md">${renderMarkdown(body)}</article>
      <aside class="stack">
        ${p ? `<section class="panel stack">
          <h2 style="margin:0">Decisions</h2>
          <div class="row">${gates.map((g) => `<button class="${g.primary ? 'primary' : g.danger ? 'danger' : ''}" data-gate="${g.action}" data-dialog="${g.dialog || ''}" ${running ? 'disabled' : ''}>${esc(g.label)}</button>`).join('') || '<span class="muted small">Nothing to decide right now.</span>'}
            ${locked && locked.plan === r.plan ? `<button data-gate="archive-abort" ${running ? 'disabled' : ''}>Abort archival</button>` : ''}</div>
          <label class="small row"><input type="checkbox" id="run-next" checked> Start the follow-up phase automatically</label>
        </section>
        <section class="panel stack">
          <h2 style="margin:0">Amend plan</h2>
          ${questions.length ? `<div class="questions md small"><strong>Outstanding questions (${questions.length})</strong>
            ${renderMarkdown(questions.map((q, i) => `${i + 1}. ${q}`).join('\n'))}</div>` : ''}
          ${status === 'planning' ? `
          <form id="amend" class="stack">
            <textarea name="instructions" data-keep="amend:${esc(r.plan)}" placeholder="${questions.length ? 'Answer by number, e.g. &quot;1. (a)  2. Call it greeting.md&quot;, and say anything else to change.' : 'Say what to change, e.g. &quot;Use LF line endings; also cover the empty-file case.&quot;'}" required ${running ? 'disabled' : ''}></textarea>
            <div class="row"><button class="primary" ${running ? 'disabled' : ''}>Amend</button>
              ${lastAsk ? `<a class="small" href="#/ws/${esc(w.id)}/run/${esc(lastAsk.id)}">or reply to the last ${esc(lastAsk.phase)} session</a>` : ''}</div>
          </form>
          <p class="muted small">A headless session revises the plan with your instructions and validates it.</p>`
          : `<p class="muted small">Plans can be amended while in planning. ${status === 'staged' ? 'Cancel it back to planning first, or approve a deviation the session raised.' : status === 'confirmation' ? 'Use <em>Send back…</em> to ask for changes to the implementation.' : ''}</p>`}
        </section>
        <section class="panel stack">
          <h2 style="margin:0">Run a phase</h2>
          <div class="row">${phases.map(([k, ph]) => `<button data-phase="${esc(k)}" ${running ? 'disabled' : ''}>${esc(ph.label)}</button>`).join('')}</div>
          <p class="muted small">Each phase runs <code>claude -p "/plan-… ${esc(r.plan)}"</code> headless in the workspace. A phase that doesn't fit the plan's status stops and says so.</p>
        </section>
        <section class="panel"><h2 style="margin-top:0">Details</h2><dl class="kv small">
          <dt>Attempt</dt><dd>${esc(String(p.attempt))}</dd>
          <dt>Worktrees</dt><dd>${p.worktrees.map(esc).join(', ') || '—'}</dd>
          <dt>Branches</dt><dd>${Object.entries(p.branches || {}).map(([k, v]) => `${esc(k)} <code>${esc(v)}</code>`).join(', ') || '—'}</dd>
          <dt>Updated</dt><dd>${esc(p.updated || '')}</dd></dl>
          ${p.overlaps.length ? `<h2>Shares files with</h2><ul class="plain small">${p.overlaps.map((o) => `
            <li><a href="#/ws/${esc(w.id)}/plan/${esc(o.plan)}">${esc(o.plan)}</a> <span class="badge ${esc(o.status)}">${esc(o.status)}</span><br>
            <span class="muted">${o.files.map(esc).join(', ')}</span></li>`).join('')}</ul>` : ''}
          <h2>History</h2><ul class="plain small muted">${(p.history || []).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
        </section>` : ''}
        <section class="panel"><h2 style="margin-top:0">Runs</h2>${runList(w, runs)}</section>
      </aside>
    </div>
    <dialog id="dlg"></dialog>`;

  restore();
  $app.querySelector('#amend')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const run = await api('POST', `/api/ws/${w.id}/runs`, { phase: 'amend', plan: r.plan, instructions: new FormData(e.target).get('instructions') });
      e.target.reset(); location.hash = `#/ws/${w.id}/run/${run.id}`;
    } catch (err) { toast(err.message, true); }
  });
  for (const b of $app.querySelectorAll('[data-gate]')) b.addEventListener('click', () => onGate(w, r.plan, b.dataset.gate, b.dataset.dialog));
  for (const b of $app.querySelectorAll('[data-phase]')) b.addEventListener('click', async () => {
    try { const run = await api('POST', `/api/ws/${w.id}/runs`, { phase: b.dataset.phase, plan: r.plan }); location.hash = `#/ws/${w.id}/run/${run.id}`; }
    catch (err) { toast(err.message, true); }
  });
}

function runList(w, runs) {
  if (!runs.length) return '<p class="muted small">No runs yet.</p>';
  return `<ul class="plain small">${runs.map((x) => `
    <li>${x.parentRunId ? '↳ ' : ''}<a href="#/ws/${esc(w.id)}/run/${esc(x.id)}">${esc(x.parentRunId ? `reply (${x.phase})` : x.phase)}</a> <span class="badge ${esc(x.status)}">${esc(x.status)}</span>
      <span class="muted">${esc(new Date(x.startedAt).toLocaleString())}${x.result?.costUsd != null ? ` · ${costLabel(x.result.costUsd)}` : ''}</span></li>`).join('')}</ul>`;
}

async function onGate(w, plan, action, dialog) {
  let body = { action, runNext: document.getElementById('run-next')?.checked ?? true };
  if (dialog) { const extra = await gateDialog(dialog, plan); if (!extra) return; body = { ...body, ...extra }; }
  else if (action === 'cancel' && !confirm(`Return "${plan}" to planning? Uncommitted changes stay in the worktree.`)) return;
  else if (action === 'unmerge' && !confirm(`Unmerge "${plan}"? It becomes a plan of its own again; the plan it was merged into may still contain what was folded in.`)) return;
  try {
    const res = await api('POST', `/api/ws/${w.id}/plans/${plan}/gate`, body);
    if (!res.ok) { toast(res.output, true); return; }
    toast(res.output.split('\n')[0]);
    if (res.run) location.hash = `#/ws/${w.id}/run/${res.run.id}`; else route();
  } catch (err) { toast(err.message, true); }
}

function gateDialog(kind, plan) {
  const dlg = document.getElementById('dlg');
  if (kind === 'merge') return mergeDialog(dlg, plan);
  if (kind === 'continue') return continueDialog(dlg, plan);
  dlg.innerHTML = kind === 'rework' ? `
    <form method="dialog" class="stack">
      <h2 style="margin-top:0">Send "${esc(plan)}" back</h2>
      <textarea name="feedback" placeholder="What should change?" required></textarea>
      <div class="row"><button value="ok" class="primary">Send back</button><button value="cancel" formnovalidate>Cancel</button></div>
    </form>` : `
    <form method="dialog" class="stack">
      <h2 style="margin-top:0">Accept and archive "${esc(plan)}"</h2>
      <label class="row"><input type="radio" name="mode" value="auto" checked> Commit the plan's files with its commit messages</label>
      <label class="row"><input type="checkbox" name="allowUnlisted"> Leave changes no plan lists uncommitted (--allow-unlisted)</label>
      <label class="row"><input type="radio" name="mode" value="manual"> I committed it myself (--manual-commit)</label>
      <input type="text" name="refs" placeholder="Commit hashes: abc1234, or worktree=abc1234 …">
      <div class="row"><button value="ok" class="primary">Accept</button><button value="cancel" formnovalidate>Cancel</button></div>
    </form>`;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const f = new FormData(dlg.querySelector('form'));
      if (kind === 'rework') return resolve({ feedback: f.get('feedback') });
      if (f.get('mode') === 'manual') return resolve({ manualCommit: true, commitRefs: String(f.get('refs') || '').split(/[\s,]+/).filter(Boolean) });
      resolve({ allowUnlisted: f.get('allowUnlisted') === 'on' });
    }, { once: true });
  });
}

/**
 * Numbered options in a deviation's text: one per line ("1. …", "- Option 2: …", "(3) …"), or inline in one line
 * ("Options: (1) …; (2) …"). Only a run numbered 1, 2, … counts, so stray numbers aren't taken for options.
 */
function deviationOptions(text) {
  const clean = (s) => s.replace(/\*\*/g, '').replace(/[;,]\s*$/, '').trim();
  const seq = (list) => (list.length >= 2 && list.every((o, i) => o.n === i + 1) ? list.map((o) => clean(o.text)) : null);
  const lines = String(text || '').split(/\r?\n/).map((l) => /^\s*(?:[-*]\s*)?(?:\*\*)?(?:option\s*)?\(?(\d+)[.):]\)?\s*(?:\*\*)?\s*(.+)$/i.exec(l)).filter(Boolean);
  const fromLines = seq(lines.map((m) => ({ n: Number(m[1]), text: m[2] })));
  if (fromLines) return fromLines;
  const inline = [...String(text || '').replace(/\s+/g, ' ').matchAll(/(?:^|\s)(?:option\s*)?\((\d+)\)\s*(.+?)(?=\s(?:option\s*)?\(\d+\)\s|$)/gi)];
  return seq(inline.map((m) => ({ n: Number(m[1]), text: m[2] }))) || [];
}

/** Approve a deviation, choosing one of the options it offered and/or adding conditions. */
function continueDialog(dlg, plan) {
  const p = state.snap?.status.plans.find((x) => x.name === plan);
  const detail = p?.pendingDetail || p?.pendingSummary || '';
  const options = deviationOptions(detail);
  const supported = p && 'pendingDetail' in p; // packages before --decision ignore it
  dlg.innerHTML = `
    <form method="dialog" class="stack" style="max-width:640px">
      <h2 style="margin-top:0">Approve the deviation in "${esc(plan)}"</h2>
      <div class="panel small" style="max-height:40vh;overflow:auto">${renderMarkdown(detail || '(no description)')}</div>
      ${options.length ? `<fieldset class="stack" style="border:0;padding:0;margin:0"><legend><strong>Your choice</strong></legend>
        ${options.map((o, i) => `<label class="row" style="align-items:flex-start"><input type="radio" name="option" value="${i + 1}"> <span><strong>${i + 1}.</strong> ${esc(o)}</span></label>`).join('')}
        <label class="row"><input type="radio" name="option" value="" checked> <span class="muted">No particular option (or explained below)</span></label></fieldset>` : ''}
      <label for="decision"><strong>${options.length ? 'Notes or conditions' : 'Your decision'}</strong> <span class="muted small">— optional; the AI follows this over its own recommendation</span></label>
      <textarea id="decision" name="decision" placeholder="${options.length ? 'e.g. but keep the old API as a wrapper' : 'e.g. Go with option 2, and keep the old API as a wrapper'}"></textarea>
      ${supported ? '' : '<div class="banner small">This workspace\'s package predates recorded decisions: redeploy it, or the decision is not saved.</div>'}
      <div class="row"><button value="ok" class="primary">Approve</button><button value="cancel" formnovalidate>Cancel</button></div>
    </form>`;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const f = new FormData(dlg.querySelector('form'));
      const n = Number(f.get('option')) || 0;
      const note = String(f.get('decision') || '').trim();
      resolve({ decision: [n ? `Option ${n}: ${options[n - 1]}` : '', note].filter(Boolean).join('. ') });
    }, { once: true });
  });
}

/**
 * Choose the plan to merge into: active plans in the same phase (not merged themselves), or an archived plan,
 * which archives this one at once with a note of the merge.
 */
function mergeDialog(dlg, plan) {
  const { status, archived } = state.snap;
  const me = status.plans.find((x) => x.name === plan);
  const active = status.plans.filter((x) => x.name !== plan && !x.mergedInto && x.status === me?.status);
  const old = archived.slice().reverse();
  const opt = (name, label) => `<option value="${esc(name)}">${esc(label)}</option>`;
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <h2 style="margin-top:0">Merge "${esc(plan)}" into another plan</h2>
      <p class="small muted">The other plan takes over this plan's work: a headless session folds this plan's brief, testing,
        files and commit messages into it, and this plan is archived together with it. Plans can be merged while both
        are in planning or both are in confirmation.</p>
      <select name="into" required>
        <option value="">Choose a plan…</option>
        ${active.length ? `<optgroup label="Active (${esc(me?.status || '')})">${active.map((x) => opt(x.name, `${x.name} — ${x.title}`)).join('')}</optgroup>` : ''}
        ${old.length ? `<optgroup label="Archived (this plan is archived now, noting the merge)">${old.map((a) => opt(a.id, `${a.id} — ${a.title}`)).join('')}</optgroup>` : ''}
      </select>
      <div class="row"><button value="ok" class="primary">Merge</button><button value="cancel" formnovalidate>Cancel</button></div>
    </form>`;
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    const into = new FormData(dlg.querySelector('form')).get('into');
    resolve(dlg.returnValue === 'ok' && into ? { into } : null);
  }, { once: true }));
}

// --- views: run -----------------------------------------------------------------------------------------------------

async function viewRun(r) {
  const w = ws();
  if (!w) { location.hash = '#/'; return; }
  let meta;
  try { meta = await api('GET', `/api/ws/${w.id}/runs/${r.run}`); } catch (err) { $app.innerHTML = `<div class="banner error">${esc(err.message)}</div>`; return; }
  rememberOpened(w.id, meta.plan, meta.id);
  $app.innerHTML = `<div class="run-view"><div class="run-head">
    <p class="small">${meta.plan ? `<a href="#/ws/${esc(w.id)}/plan/${esc(meta.plan)}">← ${esc(meta.plan)}</a>` : `<a href="#/ws/${esc(w.id)}">← ${esc(w.name)}</a>`}</p>
    <div class="row"><h1>${esc(meta.parentRunId ? `reply · ${meta.phase}` : meta.phase)}${meta.plan ? ` · ${esc(meta.plan)}` : ''}</h1><span id="run-status" class="badge ${esc(meta.status)}">${esc(meta.status)}</span>
      <button id="stop" class="danger" ${meta.status === 'running' ? '' : 'hidden'}>Stop</button></div>
    ${meta.parentRunId ? `<p class="small">Continues <a href="#/ws/${esc(w.id)}/run/${esc(meta.parentRunId)}">the earlier ${esc(meta.phase)} session</a>. Your reply:</p>
      <blockquote class="panel small prompt" style="white-space:pre-wrap;margin:0 0 8px">${esc(meta.prompt)}</blockquote>`
      : `<p class="muted small prompt"><code style="white-space:pre-wrap">${esc(meta.prompt)}</code></p>`}
    <p class="muted small">${esc(meta.permissionMode || '')} · started ${esc(new Date(meta.startedAt).toLocaleString())}</p>
    <div id="problems">${problemsHtml(meta)}</div>
    <div id="denied"></div>
    <div id="summary"></div></div>
    <div class="panel log" id="log"></div>
    <div id="reply"></div></div>`;
  const showReply = (m) => {
    const el = document.getElementById('reply');
    if (!el || m.status === 'running' || !m.sessionId) return;
    el.innerHTML = `
      <form id="reply-form" class="panel stack" style="margin-top:12px">
        <label for="reply-text"><strong>Reply</strong> <span class="muted small">— continue this session, e.g. answer the questions it asked</span></label>
        <textarea id="reply-text" name="text" data-keep="reply:${esc(m.id)}" required></textarea>
        <div class="row"><button class="primary">Send reply</button>
          ${m.plan ? `<a class="small" href="#/ws/${esc(w.id)}/plan/${esc(m.plan)}">or amend the plan from its page</a>` : ''}</div>
      </form>`;
    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const run = await api('POST', `/api/ws/${w.id}/runs/${m.id}/reply`, { text: new FormData(e.target).get('text') });
        location.hash = `#/ws/${w.id}/run/${run.id}`; } catch (err) { toast(err.message, true); }
    });
  };
  showReply(meta);
  showDenied(w, meta);
  const $log = document.getElementById('log');
  document.getElementById('stop').addEventListener('click', async () => {
    try { await api('POST', `/api/ws/${w.id}/runs/${meta.id}/stop`); } catch (err) { toast(err.message, true); }
  });
  if (state.runEs) state.runEs.close();
  const es = new EventSource(`/api/ws/${w.id}/runs/${meta.id}/events`);
  state.runEs = es;
  let stick = true;
  // Follow new output while the transcript is scrolled to its end; stop following once the user scrolls up.
  $log.addEventListener('scroll', () => { stick = $log.scrollTop + $log.clientHeight >= $log.scrollHeight - 40; });
  es.addEventListener('event', (e) => {
    const html = renderEvent(JSON.parse(e.data));
    if (html) { $log.insertAdjacentHTML('beforeend', html); if (stick) $log.scrollTop = $log.scrollHeight; }
  });
  es.addEventListener('end', async () => {
    es.close(); state.runEs = null;
    try {
      const m = await api('GET', `/api/ws/${w.id}/runs/${meta.id}`);
      const s = document.getElementById('run-status'); if (!s) return;
      rememberOpened(w.id, m.plan, m.id); // a plan-new run only learns its plan while it runs
      s.textContent = m.status; s.className = `badge ${m.status}`;
      document.getElementById('stop').hidden = true;
      document.getElementById('problems').innerHTML = problemsHtml(m);
      showReply(m);
      showDenied(w, m);
      if ((m.problems || []).some((x) => x.code === 'not-logged-in')) healthBanner(true);
      if (m.result) document.getElementById('summary').innerHTML = `<p class="small muted">${m.result.turns ?? '?'} turns · ${m.result.durationMs ? `${Math.round(m.result.durationMs / 1000)} s` : ''}${m.result.costUsd != null ? ` · ${costLabel(m.result.costUsd, true)}` : ''}${m.sessionId ? ` · session <code>${esc(m.sessionId)}</code>` : ''}</p>`;
    } catch {}
  });
}

/**
 * Claude Code's total_cost_usd is what the usage would cost at API prices. With a claude.ai sign-in, nothing is
 * charged per run (usage counts against the plan's limits), so it is always shown as an estimate.
 */
const COST_TITLE = 'Estimated cost at API prices, as reported by Claude Code. With a claude.ai subscription sign-in this is not charged; usage counts against your plan limits.';
const costLabel = (usd, long = false) =>
  `<span title="${esc(COST_TITLE)}">≈ $${usd.toFixed(2)} ${long ? 'API-equivalent estimate' : 'est.'}</span>`;

/**
 * Shell commands the session was refused, with a one-click allow for the run's phase. Headless sessions take their
 * permissions from the phase settings, so this is where a build or test command gets allowed; a reply then retries.
 */
function showDenied(w, m) {
  const el = document.getElementById('denied');
  if (!el || m.status === 'running' || !(m.denied || []).length) return;
  const wsRules = state.config.workspaces.find((x) => x.id === w.id)?.allowedTools || [];
  const allowed = new Set([...(state.config.phases[m.phase]?.allowedTools || []), ...wsRules]);
  const rows = m.denied.map((d) => {
    const rules = d.rules.map((r) => `<label class="row small"><input type="checkbox" name="rule" value="${esc(r)}" ${allowed.has(r) ? 'checked disabled' : 'checked'}>
      <code>${esc(r)}</code>${allowed.has(r) ? ' <span class="muted">allowed now</span>' : ''}</label>`).join('');
    return `<li><code>${esc(d.command)}</code> <span class="muted small">(${esc(d.tools.join(', '))})</span>
      ${d.note ? `<div class="small muted">${esc(d.note)}</div>` : rules}</li>`;
  }).join('');
  const pending = m.denied.some((d) => d.rules.some((r) => !allowed.has(r)));
  el.innerHTML = `<form class="banner stack" style="margin:8px 0">
    <div><strong>The session was refused ${m.denied.length === 1 ? 'a command' : `${m.denied.length} commands`}.</strong>
      Headless sessions only run what the UI allows: the <em>${esc(m.phase)}</em> phase's rules (Settings) and this workspace's rules (Workspaces).</div>
    <ul style="margin:0">${rows}</ul>
    ${pending ? `<div class="row"><button class="primary" value="workspace">Allow in ${esc(w.name)} (every phase)</button>
      <button value="phase">Only the ${esc(m.phase)} phase</button>
      <span class="small muted">Then reply to retry, or run the phase again.</span></div>` : m.sessionId ? '<div class="small">These are allowed now: reply below to retry.</div>' : ''}
  </form>`;
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const scope = e.submitter?.value || 'workspace';
    const rules = [...e.target.querySelectorAll('input[name=rule]:checked:not(:disabled)')].map((i) => i.value);
    if (!rules.length) return toast('Tick a rule to allow.', true);
    try {
      if (scope === 'phase') {
        const r = await api('POST', `/api/phases/${encodeURIComponent(m.phase)}/allow`, { rules });
        state.config.phases[m.phase] = { ...state.config.phases[m.phase], allowedTools: r.allowedTools };
        toast(`Allowed for the ${m.phase} phase.`);
      } else {
        const r = await api('POST', `/api/workspaces/${encodeURIComponent(w.id)}/allow`, { rules });
        state.config.workspaces = state.config.workspaces.map((x) => (x.id === w.id ? { ...x, allowedTools: r.allowedTools } : x));
        toast(`Allowed in every phase of ${w.name}.`);
      }
      showDenied(w, m);
      const t = document.getElementById('reply-text');
      if (t && !t.value) { t.value = `${m.denied.filter((d) => d.rules.length).map((d) => d.command.split(/\s+/)[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')} is now allowed. Please run it again and continue.`; t.focus(); }
    } catch (err) { toast(err.message, true); }
  });
}

const problemsHtml = (m) => (m.problems || []).map((p) =>
  `<div class="banner ${p.code === 'not-logged-in' ? 'error' : ''}" style="margin:8px 0"><strong>${esc(p.message)}</strong><br>${renderMarkdown(p.fix)}</div>`).join('');
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '');

const clip = (s, n = 1500) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
function toolInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return input.command;
  if (input.file_path) return input.file_path + (input.old_string ? ' (edit)' : '');
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
  return JSON.stringify(input);
}

function renderEvent(ev) {
  if (ev.type === 'ui') {
    if (ev.event === 'start') return `<div class="ev"><div class="label">started</div><pre>${esc([ev.command, ...ev.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' '))}</pre></div>`;
    if (ev.event === 'stderr' || ev.event === 'error') return `<div class="ev ${ev.event}"><div class="label">${ev.event}</div><pre>${esc(clip(stripAnsi(ev.text)))}</pre></div>`;
    if (ev.event === 'stdout') return `<div class="ev"><pre>${esc(clip(ev.text))}</pre></div>`;
    if (ev.event === 'end') return `<div class="ev result"><div class="label">ended</div>${esc(ev.status)} (exit ${esc(String(ev.exitCode))})</div>`;
    if (ev.event === 'stop-requested') return '<div class="ev error"><div class="label">stop requested</div></div>';
    return '';
  }
  if (ev.type === 'system' && ev.subtype === 'init') return `<div class="ev"><div class="label">session</div>${esc(ev.model || '')} · ${esc(ev.permissionMode || '')} · ${esc((ev.tools || []).length)} tools</div>`;
  if (ev.type === 'assistant' && ev.message?.content) return ev.message.content.map((c) => {
    if (c.type === 'text' && c.text.trim()) return `<div class="ev assistant md">${renderMarkdown(c.text)}</div>`;
    if (c.type === 'tool_use') return `<div class="ev tool"><div class="label">${esc(c.name)}</div><pre>${esc(clip(toolInput(c.input), 600))}</pre></div>`;
    return '';
  }).join('');
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) return ev.message.content.map((c) => {
    if (c.type !== 'tool_result') return '';
    const text = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n');
    return `<details class="ev ${c.is_error ? 'error' : ''}"><summary class="label">${c.is_error ? 'tool error' : 'tool result'} · ${text.split('\n').length} lines</summary><pre>${esc(clip(text, 4000))}</pre></details>`;
  }).join('');
  if (ev.type === 'result') return `<div class="ev result"><div class="label">result${ev.is_error ? ' (error)' : ''}</div>${typeof ev.result === 'string' ? renderMarkdown(ev.result) : ''}</div>`;
  return '';
}

// --- views: settings ------------------------------------------------------------------------------------------------

function viewSettings() {
  const { claudeCommand, model, pollSeconds, phases, appendSystemPrompt } = state.config;
  $app.innerHTML = `
    <h1>Settings</h1>
    <p class="muted">Stored in <code>${esc(state.config.dataDir)}\\config.json</code>. Each phase runs
      <code>claude -p "/&lt;command&gt; …" --permission-mode &lt;mode&gt; --allowedTools …</code> in the workspace.
      The workspace's own <code>.claude/settings.json</code> deny rules always apply on top.
      Permission modes: <code>dontAsk</code> refuses anything not allowed; <code>acceptEdits</code> allows file edits;
      <code>bypassPermissions</code> allows everything not denied; <code>plan</code> is read-only.</p>
    <form id="settings" class="panel stack">
      <div class="row"><label>Claude command <input type="text" name="claudeCommand" value="${esc(Array.isArray(claudeCommand) ? JSON.stringify(claudeCommand) : claudeCommand)}" title='"claude", or a JSON list such as ["wsl", "claude"]'></label>
        <label>Model <input type="text" name="model" value="${esc(model || '')}" placeholder="default"></label>
        <label>Poll seconds <input type="text" name="pollSeconds" value="${esc(String(pollSeconds))}" size="4"></label></div>
      <label>Appended system prompt <span class="muted small">(added to every headless session)</span>
        <textarea name="appendSystemPrompt">${esc(appendSystemPrompt || '')}</textarea></label>
      <label>Phases (JSON)<textarea class="code" name="phases">${esc(JSON.stringify(phases, null, 2))}</textarea></label>
      <div class="row"><button class="primary">Save</button></div>
    </form>`;
  $app.querySelector('#settings').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    let ph; try { ph = JSON.parse(f.get('phases')); } catch (err) { return toast(`Phases is not valid JSON: ${err.message}`, true); }
    let cmd = String(f.get('claudeCommand') || '').trim();
    if (cmd.startsWith('[')) { try { cmd = JSON.parse(cmd); } catch (err) { return toast(`Claude command is not valid JSON: ${err.message}`, true); } }
    try { state.config = { ...state.config, ...(await api('PUT', '/api/config', { claudeCommand: cmd, model: f.get('model'), pollSeconds: f.get('pollSeconds'), appendSystemPrompt: f.get('appendSystemPrompt'), phases: ph })) };
      toast('Saved.'); healthBanner(true); } catch (err) { toast(err.message, true); }
  });
}

// --- start ----------------------------------------------------------------------------------------------------------

async function loadConfig() { state.config = await api('GET', '/api/config'); renderSelect(); }

(async () => {
  try { await loadConfig(); } catch (err) { $app.innerHTML = `<div class="banner error">Cannot reach the server: ${esc(err.message)}</div>`; return; }
  if (!state.config.workspaces.some((w) => w.id === state.wsId)) state.wsId = state.config.workspaces[0]?.id || null;
  renderSelect(); connect(); route();
  healthBanner().then(() => { if (parseHash().view === 'board') route(); });
})();
