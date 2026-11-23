// Headless phase sessions: start `claude -p` in a workspace, stream its stream-json output, keep a transcript.
//   data/runs/<workspaceId>/<runId>/meta.json     what ran, when, outcome, cost, session id
//   data/runs/<workspaceId>/<runId>/events.jsonl  every stdout event, plus {"type":"ui",...} lines from the UI
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA_DIR, loadConfig, canonicalDir, shellRules } from './config.mjs';
import { isSlug } from './workspace.mjs';

export const events = new EventEmitter(); // 'run' (meta) whenever a run starts or ends
events.setMaxListeners(0);

const live = new Map(); // runId -> { meta, proc, listeners:Set<fn>, file }

const runsDir = (wsId) => path.join(DATA_DIR, 'runs', wsId);
const runDir = (wsId, runId) => path.join(runsDir(wsId), runId);
const newRunId = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${crypto.randomBytes(3).toString('hex')}`;
const isRunId = (s) => /^\d{8}T\d{6}-[0-9a-f]{6}$/.test(String(s));

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MAX_TEXT = 8000;

/**
 * Used when a workspace was deployed before the package shipped `/plan-amend`, so amending still works there.
 * Keep in step with Deployment-Files/.claude-template/commands/plan-amend.md.
 */
const AMEND_FALLBACK = (plan, text) => [
  `Amend plan \`${plan}\` with the human's instructions below, following the Planning rules in CLAUDE.md.`,
  `First run \`node .claude/workflow/plan.mjs status ${plan}\`: it must be planning, otherwise stop and say why.`,
  'Update the Brief (or latest Plan Extension) and keep Testing, Files Affected and Commit Messages consistent.',
  'Questions for the human live in "## Outstanding Questions" (create it above Testing if missing): record each answered one as a decision in the Brief and remove it; write "None." when none remain.',
  'Edit only the plan body. Run validate until it passes, then summarise the changes and any open questions, and stop.',
  '', 'Instructions:', text,
].join('\n');

/** The prompt for a phase: its slash command, plus the description (new) or instructions (amend). */
export function promptFor(phaseKey, { plan, description, instructions } = {}, ws = null) {
  const phase = loadConfig().phases[phaseKey];
  if (!phase) throw bad(`Unknown phase "${phaseKey}".`);
  if (phaseKey === 'new') {
    const d = String(description || '').trim();
    if (!d) throw bad('Describe the work for the new plan.');
    return `/${phase.command} ${d.slice(0, MAX_TEXT)}`;
  }
  if (!isSlug(plan)) throw bad('Invalid plan name.');
  if (phaseKey === 'amend') {
    const t = String(instructions || '').trim().slice(0, MAX_TEXT);
    if (!t) throw bad('Say how the plan should change.');
    const hasCommand = !ws || fs.existsSync(path.join(canonicalDir(ws.path), '.claude', 'commands', `${phase.command}.md`));
    return hasCommand ? `/${phase.command} ${plan} ${t}` : AMEND_FALLBACK(plan, t);
  }
  return `/${phase.command} ${plan}`;
}

/** The plan a /plan-new session created, from its `plan.mjs new <slug>` call. */
const NEW_PLAN = /plan\.mjs["']?\s+new\s+([a-z0-9][a-z0-9-]{1,79})\b/;

/**
 * Arguments for `claude` (the prompt is a positional argument, so no shell quoting is involved).
 * `extraTools` are added to the phase's allowlist, e.g. per-worktree read-only git rules.
 */
export function claudeArgs(phaseKey, prompt, cfg = loadConfig(), extraTools = [], { resume = null } = {}) {
  const phase = cfg.phases[phaseKey];
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', resume);
  if (phase.permissionMode) args.push('--permission-mode', phase.permissionMode);
  if (cfg.model || phase.model) args.push('--model', phase.model || cfg.model);
  if (cfg.appendSystemPrompt) args.push('--append-system-prompt', cfg.appendSystemPrompt);
  const tools = [...new Set([...(phase.allowedTools || []), ...extraTools])];
  if (tools.length) args.push('--allowedTools', ...tools); // variadic: must stay last
  return args;
}

function writeMeta(meta) {
  const d = runDir(meta.workspaceId, meta.id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

function append(run, obj) {
  const line = JSON.stringify(obj);
  fs.appendFileSync(run.file, line + '\n');
  for (const fn of run.listeners) fn(obj);
}

export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '');

/** Known setup problems, recognised in a run's output, with what the human should do. */
const KNOWN_PROBLEMS = [
  { code: 'not-logged-in', test: /Not logged in|Please run \/login|Invalid API key/i,
    message: 'Claude Code is not signed in for the account running this server.',
    fix: 'In a terminal, run `claude`, use /login, then start the phase again.' },
  { code: 'untrusted-workspace', test: /has not been trusted/i,
    message: "Claude Code doesn't trust this workspace yet, so it ignored the workspace's permissions.allow rules (deny rules still apply).",
    fix: 'Open a terminal in the workspace, run `claude` once and accept the trust prompt.' },
];

function noteProblems(meta, text) {
  for (const p of KNOWN_PROBLEMS) {
    if (p.test.test(text) && !(meta.problems || []).some((x) => x.code === p.code))
      meta.problems = [...(meta.problems || []), { code: p.code, message: p.message, fix: p.fix }];
  }
}

/**
 * Shell commands Claude Code refused in a run (the result event's permission_denials), each with the allow rules
 * that would let it run: the command's first word as a prefix, for both shell tools. No rules are suggested where
 * allowing can't help: chained commands (no prefix rule matches them), cd prefixes, git and the workflow CLI (the
 * workspace denies their writes; its deny rules win over any allow).
 */
export function deniedCommands(denials) {
  const out = new Map();
  for (const d of denials) {
    const tool = d && d.tool_name;
    const command = typeof d?.tool_input?.command === 'string' ? d.tool_input.command.trim() : null;
    if (!command || (tool !== 'Bash' && tool !== 'PowerShell')) continue;
    const word = command.split(/\s+/)[0];
    let note = null;
    if (/[;&|]|\r|\n/.test(command)) note = 'Chained commands match no rule: the session should run them one at a time.';
    else if (/^(cd|pushd|Set-Location)$/i.test(word)) note = 'Prefixed with cd: the session should run it from the workspace root.';
    else if (/^git$/i.test(word) && /^git\s+(-C\s+("[^"]*"|\S+)\s+)?(status|diff|log|show|branch|rev-parse|worktree list)\b/i.test(command))
      note = 'Read-only git is allowed as `git -C <worktree> status|diff|log|show|branch|rev-parse` for the workspace\'s worktrees; this form isn\'t.';
    else if (/^git$/i.test(word) || /plan\.mjs/.test(command)) note = 'Denied by the workspace (gates and git writes stay with you).';
    else if (!/^[A-Za-z0-9][\w.+-]{0,63}$/.test(word)) note = 'No simple prefix to allow.';
    const key = command.toLowerCase();
    const e = out.get(key) || { command: command.slice(0, 500), tools: [], rules: note ? [] : shellRules([word]), note };
    if (!e.tools.includes(tool)) e.tools.push(tool);
    out.set(key, e);
  }
  return [...out.values()];
}

/** Pull the useful bits out of a stream-json event into the run's metadata. */
function absorb(meta, ev) {
  if (ev.type === 'result' && typeof ev.result === 'string') noteProblems(meta, ev.result);
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content))
    for (const c of ev.message.content) if (c.type === 'text') noteProblems(meta, c.text);
  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) meta.sessionId = ev.session_id;
  // A /plan-new run starts without a plan; link it to the plan it creates so it shows on that plan's page.
  if (!meta.plan && meta.phase === 'new' && ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const c of ev.message.content) {
      const m = c.type === 'tool_use' && typeof c.input?.command === 'string' && NEW_PLAN.exec(c.input.command);
      if (m) { meta.plan = m[1]; writeMeta(meta); }
    }
  }
  if (ev.type === 'result') {
    if (Array.isArray(ev.permission_denials) && ev.permission_denials.length) meta.denied = deniedCommands(ev.permission_denials);
    meta.result = {
      isError: !!ev.is_error, subtype: ev.subtype || null, turns: ev.num_turns ?? null,
      costUsd: ev.total_cost_usd ?? null, durationMs: ev.duration_ms ?? null,
      text: typeof ev.result === 'string' ? ev.result.slice(0, 20000) : null,
    };
  }
}

/** Start a phase. Refuses while another run for the same plan is still going. */
export function start(ws, { phase, plan = null, description = null, instructions = null, extraTools = [], cfg = loadConfig(), spawnImpl = spawn }) {
  const prompt = promptFor(phase, { plan, description, instructions }, ws);
  return launch(ws, { phase, plan, prompt, extraTools, cfg, spawnImpl });
}

/**
 * Reply to a finished run: resume its Claude Code session (`--resume <session id>`) with the human's message, for
 * example answers to the questions a /plan-new session asked. The reply is a run of its own, linked to the one it
 * continues, with the same phase permissions.
 */
export function reply(ws, parentId, { text, extraTools = [], cfg = loadConfig(), spawnImpl = spawn }) {
  const parent = getMeta(ws.id, parentId);
  if (parent.status === 'running') throw bad('That run is still going; reply once it has finished.', 409);
  if (!parent.sessionId) throw bad('That run has no Claude Code session to continue (it never started one).', 409);
  const message = String(text || '').trim().slice(0, MAX_TEXT);
  if (!message) throw bad('Write a reply first.');
  return launch(ws, { phase: parent.phase, plan: parent.plan, prompt: message, resume: parent.sessionId,
    parentRunId: parent.id, extraTools, cfg, spawnImpl });
}

function launch(ws, { phase, plan, prompt, resume = null, parentRunId = null, extraTools, cfg, spawnImpl }) {
  for (const r of live.values()) {
    if (r.meta.workspaceId !== ws.id) continue;
    if (plan && r.meta.plan === plan) throw bad(`A ${r.meta.phase} run for "${plan}" is already running.`, 409);
    if (resume && r.meta.sessionId === resume) throw bad('That session is already being continued.', 409);
  }
  const id = newRunId();
  const meta = { id, workspaceId: ws.id, plan, phase, prompt, status: 'running', startedAt: new Date().toISOString(),
    endedAt: null, exitCode: null, sessionId: resume, parentRunId, result: null, problems: [], denied: [],
    permissionMode: cfg.phases[phase].permissionMode, allowedTools: [...new Set([...(cfg.phases[phase].allowedTools || []), ...extraTools])] };
  writeMeta(meta);
  const run = { meta, proc: null, listeners: new Set(), file: path.join(runDir(ws.id, id), 'events.jsonl') };
  fs.writeFileSync(run.file, '');
  live.set(id, run);

  // claudeCommand is "claude" or a list such as ["wsl", "claude"]: the first entry runs, the rest go before our args.
  const [command, ...prefix] = [].concat(cfg.claudeCommand);
  const args = [...prefix, ...claudeArgs(phase, prompt, cfg, extraTools, { resume })];
  const cwd = canonicalDir(ws.path); // long form: Claude Code refuses edits through 8.3 short-name paths
  append(run, { type: 'ui', event: 'start', command, args, cwd, at: meta.startedAt });
  let proc;
  try {
    proc = spawnImpl(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    finish(run, null, `Could not start ${command}: ${e.message}`);
    return { ...meta };
  }
  run.proc = proc;

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { ev = { type: 'ui', event: 'stdout', text: line }; }
      absorb(meta, ev);
      append(run, ev);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (raw) => { const text = stripAnsi(raw); noteProblems(meta, text); append(run, { type: 'ui', event: 'stderr', text }); });
  proc.on('error', (e) => finish(run, null, `Could not start ${command}: ${e.message}`));
  proc.on('close', (code) => {
    if (buf.trim()) { let ev; try { ev = JSON.parse(buf); } catch { ev = { type: 'ui', event: 'stdout', text: buf }; } absorb(meta, ev); append(run, ev); }
    finish(run, code);
  });
  events.emit('run', { ...meta });
  return { ...meta };
}

function finish(run, code, error = null) {
  if (run.meta.status !== 'running') return;
  const m = run.meta;
  if (error) append(run, { type: 'ui', event: 'error', text: error });
  m.exitCode = code;
  m.endedAt = new Date().toISOString();
  m.status = run.cancelled ? 'cancelled' : error ? 'failed' : (code === 0 && !(m.result && m.result.isError)) ? 'succeeded' : 'failed';
  append(run, { type: 'ui', event: 'end', status: m.status, exitCode: code, at: m.endedAt });
  writeMeta(m);
  for (const fn of run.listeners) fn(null); // end of stream
  live.delete(m.id);
  events.emit('run', { ...m });
}

/** Stop a running phase (the whole process tree on Windows). */
export function stop(runId) {
  const run = live.get(runId);
  if (!run) throw Object.assign(new Error('That run is not running.'), { status: 409 });
  run.cancelled = true;
  append(run, { type: 'ui', event: 'stop-requested', at: new Date().toISOString() });
  if (run.proc && run.proc.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
    else run.proc.kill('SIGTERM');
  }
}

export function getMeta(wsId, runId) {
  if (!isRunId(runId)) throw Object.assign(new Error('Invalid run id.'), { status: 400 });
  const r = live.get(runId);
  if (r && r.meta.workspaceId === wsId) return { ...r.meta };
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(runDir(wsId, runId), 'meta.json'), 'utf8')); } catch {
    throw Object.assign(new Error('Run not found.'), { status: 404 });
  }
  if (!('denied' in m)) backfillDenied(m); // runs recorded before denials were kept
  return m;
}

function backfillDenied(m) {
  m.denied = [];
  try {
    const lines = fs.readFileSync(path.join(runDir(m.workspaceId, m.id), 'events.jsonl'), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"permission_denials"')) continue;
      const ev = JSON.parse(lines[i]);
      if (ev.type === 'result' && Array.isArray(ev.permission_denials)) { m.denied = deniedCommands(ev.permission_denials); break; }
    }
    writeMeta(m);
  } catch {}
}

/** Runs for a workspace (optionally one plan), newest first. */
export function list(wsId, { plan = null, limit = 200 } = {}) {
  let ids = [];
  try { ids = fs.readdirSync(runsDir(wsId)).filter(isRunId); } catch { return []; }
  const out = [];
  for (const id of ids.sort().reverse()) {
    let m; try { m = getMeta(wsId, id); } catch { continue; }
    if (!plan || m.plan === plan) out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Replay a run's events, then follow it live. `send(ev)` gets each event; `send(null)` marks the end.
 * Returns an unsubscribe function.
 */
export function follow(wsId, runId, send) {
  getMeta(wsId, runId); // validates the id and that the run belongs to this workspace
  const file = path.join(runDir(wsId, runId), 'events.jsonl');
  // Reading the file and registering the listener happen in one synchronous step, and events are appended
  // synchronously too, so nothing can be written in between: no event is lost or sent twice.
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
  for (const l of lines) { try { send(JSON.parse(l)); } catch {} }
  const run = live.get(runId);
  if (!run) { send(null); return () => {}; }
  run.listeners.add(send);
  return () => run.listeners.delete(send);
}

/** After a restart, runs still marked running were orphaned by the previous server process. */
export function markInterrupted() {
  let wsIds = [];
  try { wsIds = fs.readdirSync(path.join(DATA_DIR, 'runs')); } catch { return 0; }
  let n = 0;
  for (const ws of wsIds) for (const m of list(ws, { limit: 100000 })) {
    if (m.status === 'running' && !live.has(m.id)) {
      m.status = 'interrupted'; m.endedAt = m.endedAt || new Date().toISOString();
      writeMeta(m); n++;
    }
  }
  return n;
}

export const activeRuns = () => [...live.values()].map((r) => ({ ...r.meta }));

/**
 * Whether the configured claude command works and is signed in (`claude auth status`), cached for a minute.
 * Resolves { ok, loggedIn, version, error }.
 */
let _health = null;
export function claudeHealth(cfg = loadConfig(), { fresh = false } = {}) {
  if (!fresh && _health && Date.now() - _health.at < 60000) return Promise.resolve(_health.value);
  const [command, ...prefix] = [].concat(cfg.claudeCommand);
  const run = (args) => new Promise((resolve) => {
    const p = spawn(command, [...prefix, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill(), 15000);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, out, err: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
  return (async () => {
    const v = await run(['--version']);
    if (v.code !== 0) return { ok: false, loggedIn: false, version: null, error: `Cannot run ${[].concat(cfg.claudeCommand).join(' ')}: ${stripAnsi(v.err || `exit ${v.code}`).trim()}` };
    const a = await run(['auth', 'status']);
    let loggedIn = null;
    try { loggedIn = !!JSON.parse(a.out).loggedIn; } catch {}
    const value = { ok: loggedIn !== false, loggedIn, version: v.out.trim(), error: loggedIn === false ? 'Claude Code is not signed in. In a terminal, run `claude` and use /login.' : null };
    _health = { at: Date.now(), value };
    return value;
  })();
}
