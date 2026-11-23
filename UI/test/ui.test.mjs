// UI tests: npm test   (Node 18+, no dependencies)
// The end-to-end tests deploy the workflow package from ../Deployment-Files (or $PLAN_UI_PACKAGE) into a temp folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../public/md.js';
import * as C from '../lib/config.mjs';
import { createServer } from '../server.mjs';
import { claudeArgs, promptFor, deniedCommands } from '../lib/runs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = process.env.PLAN_UI_PACKAGE || path.resolve(HERE, '..', '..', 'Deployment-Files');
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ui-'));
C.setDataDir(path.join(tmp, 'data'));

// --- unit -----------------------------------------------------------------------------------------------------------

test('markdown: escapes HTML and hides comments', () => {
  const html = renderMarkdown('# T <b>\n\n<script>alert(1)</script>\n\n<!-- TODO hidden -->\n- `a<b>` **x**');
  assert.ok(!html.includes('<script>') && !html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('TODO hidden'));
  assert.ok(html.includes('<code>a&lt;b&gt;</code>') && html.includes('<strong>x</strong>'));
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href'));
});

test('markdown: fences, tables and nested lists', () => {
  const html = renderMarkdown('```text\n## not a heading\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - two');
  assert.ok(html.includes('<pre><code>## not a heading</code></pre>'));
  assert.ok(html.includes('<th>a</th>') && html.includes('<td>2</td>'));
  assert.match(html, /<ul><li>one<\/li><ul><li>two<\/li><\/ul><\/ul>/);
});

test('phase prompts and claude arguments', () => {
  assert.equal(promptFor('implement', { plan: 'my-plan' }), '/plan-implement my-plan');
  assert.equal(promptFor('new', { description: 'Add retries' }), '/plan-new Add retries');
  assert.throws(() => promptFor('implement', { plan: '../x' }), /Invalid plan name/);
  assert.throws(() => promptFor('new', { description: ' ' }), /Describe the work/);
  const args = claudeArgs('implement', '/plan-implement p');
  assert.deepEqual(args.slice(0, 6), ['-p', '/plan-implement p', '--output-format', 'stream-json', '--verbose', '--permission-mode']);
  assert.equal(args[6], 'dontAsk');
  assert.ok(args.includes('Bash(node .claude/workflow/plan.mjs:*)'));
  assert.ok(args.includes('PowerShell(node .claude/workflow/plan.mjs:*)'), 'shell rules cover the PowerShell tool too');
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /one at a time/);
  const withWt = claudeArgs('implement', '/plan-implement p', C.loadConfig(), C.worktreeGitRules(['feature']));
  assert.ok(withWt.includes('Bash(git -C feature status:*)') && withWt.includes('PowerShell(git -C feature log:*)'));
  assert.ok(!withWt.some((a) => /git -C feature (commit|add|push)/.test(a)), 'only read-only git is allowed');
  assert.equal(args.indexOf('--allowedTools') > args.indexOf('-p'), true, 'variadic --allowedTools goes last');
});

// --- end to end -----------------------------------------------------------------------------------------------------

let server; let port; let wsDir; let wsId;
const hasPkg = fs.existsSync(path.join(PKG, '.claude-template', 'workflow', 'plan.mjs'));

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url,
      headers: { 'Content-Type': 'application/json', 'X-Plan-UI': '1', Host: `localhost:${port}`, ...headers } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, body: j, text: s }); });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

/** Collect a run's SSE events until the stream ends. */
function readRunStream(url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { Host: `localhost:${port}` } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve(s.split('\n\n').filter((b) => b.startsWith('event:'))
        .map((b) => ({ event: /event: (.*)/.exec(b)[1], data: JSON.parse(/data: (.*)/.exec(b)[1]) }))));
    }).on('error', reject);
  });
}

const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };

before(async () => {
  if (!hasPkg) return;
  wsDir = path.join(tmp, 'ws');
  fs.cpSync(path.join(PKG, '.claude-template'), path.join(wsDir, '.claude'), { recursive: true });
  const wt = path.join(wsDir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const git = (...a) => { const r = spawnSync('git', ['-C', wt, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  // A valid plan, written the way /plan-new would.
  const cli = (...a) => spawnSync(process.execPath, [path.join(wsDir, '.claude/workflow/plan.mjs'), ...a], { cwd: wsDir, encoding: 'utf8' });
  assert.equal(cli('new', 'demo', '--title', 'Demo plan').status, 0);
  const f = path.join(wsDir, 'plans', 'demo.md'); const t = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, t.slice(0, t.indexOf('\n---', 4) + 5) + ['# Demo plan', '', '## Brief', '', 'Change a.', '', '## Testing', '', 'N/A — test', '',
    '## Files Affected', '', '### wt', '- `a.txt` — x', '', '## Commit Messages', '', '### wt', '```text', 'feat: demo', '```', ''].join('\n'));
  assert.equal(cli('validate', 'demo').status, 0);

  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('e2e: rejects foreign hosts and header-less writes', { skip: !hasPkg }, async () => {
  assert.equal((await req('GET', '/api/config', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await req('POST', '/api/workspaces', { path: wsDir }, { 'X-Plan-UI': '' })).status, 403);
});

test('e2e: register a workspace, read status, stage through a gate', { skip: !hasPkg }, async () => {
  const bad = await req('POST', '/api/workspaces', { path: tmp });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /not a deployed workspace/);
  const add = await req('POST', '/api/workspaces', { path: wsDir, name: 'Test' });
  assert.equal(add.status, 200, add.text); wsId = add.body.id;

  const st = await req('GET', `/api/ws/${wsId}/status`);
  assert.equal(st.status, 200, st.text);
  assert.deepEqual(st.body.status.plans.map((p) => [p.name, p.status]), [['demo', 'planning']]);
  const doc = await req('GET', `/api/ws/${wsId}/plans/demo`);
  assert.match(doc.body.text, /## Brief/);
  assert.equal((await req('GET', `/api/ws/${wsId}/plans/..%2F..%2Fx`)).status, 400);

  const wrong = await req('POST', `/api/ws/${wsId}/plans/demo/gate`, { action: 'archive-begin' });
  assert.equal(wrong.body.ok, false); assert.match(wrong.body.output, /needs: confirmation/);
  const g = await req('POST', `/api/ws/${wsId}/plans/demo/gate`, { action: 'stage' });
  assert.equal(g.body.ok, true, g.body.output); assert.equal(g.body.next, 'implement');
  const st2 = await req('GET', `/api/ws/${wsId}/status`);
  assert.equal(st2.body.status.plans[0].status, 'staged');
});

test('e2e: run a phase with a fake claude, stream it, keep its history', { skip: !hasPkg }, async () => {
  assert.equal((await req('PUT', '/api/config', { claudeCommand: [process.execPath, FAKE] })).status, 200);
  const r = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'implement', plan: 'demo' });
  assert.equal(r.status, 200, r.text);
  const busy = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'implement', plan: 'demo' });
  assert.ok(busy.status === 409 || busy.status === 200, 'second run refused while the first is live (or the first already ended)');

  const evs = await readRunStream(`/api/ws/${wsId}/runs/${r.body.id}/events`);
  assert.equal(evs.at(-1).event, 'end');
  const kinds = evs.filter((e) => e.event === 'event').map((e) => e.data.type + (e.data.event ? `:${e.data.event}` : ''));
  for (const k of ['ui:start', 'system', 'assistant', 'user', 'ui:stderr', 'result', 'ui:end']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);

  const meta = await waitFor(async () => { const m = (await req('GET', `/api/ws/${wsId}/runs/${r.body.id}`)).body; return m.status !== 'running' && m; });
  assert.equal(meta.status, 'succeeded');
  assert.equal(meta.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(meta.result.costUsd, 0.0123);
  assert.ok(meta.allowedTools.includes('Bash(git -C wt status:*)'), 'per-worktree git rules are added to runs');
  const hist = await req('GET', `/api/ws/${wsId}/runs?plan=demo`);
  assert.ok(hist.body.some((m) => m.id === r.body.id));
  // Replay of a finished run gives the same events.
  const again = await readRunStream(`/api/ws/${wsId}/runs/${r.body.id}/events`);
  assert.equal(again.length, evs.length);
});

test('e2e: a failing run and a stopped run are recorded as such', { skip: !hasPkg }, async () => {
  const fail = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'new', description: 'please fail' });
  const fm = await waitFor(async () => { const m = (await req('GET', `/api/ws/${wsId}/runs/${fail.body.id}`)).body; return m.status !== 'running' && m; });
  assert.equal(fm.status, 'failed');

  const slow = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'new', description: 'be slow' });
  await waitFor(async () => (await req('GET', `/api/ws/${wsId}/runs/${slow.body.id}`)).body.sessionId);
  assert.equal((await req('POST', `/api/ws/${wsId}/runs/${slow.body.id}/stop`)).status, 200);
  const sm = await waitFor(async () => { const m = (await req('GET', `/api/ws/${wsId}/runs/${slow.body.id}`)).body; return m.status !== 'running' && m; });
  assert.equal(sm.status, 'cancelled');
});

test('e2e: the page and its scripts are served', { skip: !hasPkg }, async () => {
  const page = await req('GET', '/');
  assert.match(page.text, /<title>Plan Workflow<\/title>/);
  assert.equal((await req('GET', '/app.js')).status, 200);
  assert.equal((await req('GET', '/..%2F..%2Fserver.mjs')).status === 200 && !(await req('GET', '/..%2F..%2Fserver.mjs')).text.includes('createServer'), true);
});

test('e2e: setup problems are recognised and stderr colour codes stripped', { skip: !hasPkg }, async () => {
  const r = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'new', description: 'nologin please' });
  const m = await waitFor(async () => { const x = (await req('GET', `/api/ws/${wsId}/runs/${r.body.id}`)).body; return x.status !== 'running' && x; });
  assert.equal(m.status, 'failed');
  assert.deepEqual(m.problems.map((p) => p.code).sort(), ['not-logged-in', 'untrusted-workspace']);
  const evs = await readRunStream(`/api/ws/${wsId}/runs/${r.body.id}/events`);
  const err = evs.find((e) => e.data.event === 'stderr');
  assert.ok(err && !err.data.text.includes('\u001b'), 'stderr is stored without ANSI codes');
});

test('e2e: health reports the claude version and sign-in state', { skip: !hasPkg }, async () => {
  const h = await req('GET', '/api/health?fresh');
  assert.equal(h.body.ok, true, JSON.stringify(h.body));
  assert.match(h.body.version, /Fake Claude/);
  process.env.FAKE_LOGGED_IN = '0';
  try {
    const out = await req('GET', '/api/health?fresh');
    assert.equal(out.body.ok, false); assert.match(out.body.error, /not signed in/);
  } finally { delete process.env.FAKE_LOGGED_IN; }
  await req('PUT', '/api/config', { claudeCommand: 'definitely-not-a-real-command-xyz' });
  const missing = await req('GET', '/api/health?fresh');
  assert.equal(missing.body.ok, false); assert.match(missing.body.error, /Cannot run/);
});

test('canonicalDir expands Windows 8.3 short names (Claude Code refuses edits through them)', { skip: process.platform !== 'win32' }, () => {
  const long = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'long folder name ')));
  try {
    const r = spawnSync('cmd.exe', [`/d /s /c "for %I in ("${long}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
    const short = r.stdout.trim();
    assert.equal(C.canonicalDir(long), long);
    if (short && short.toLowerCase() !== long.toLowerCase()) assert.equal(C.canonicalDir(short), long, `short: ${short}`);
    assert.equal(C.canonicalDir(path.join(long, 'missing')), path.join(long, 'missing'), 'non-existent paths are left as resolved');
  } finally { fs.rmSync(long, { recursive: true, force: true }); }
});

test('amend prompts: slash command when the workspace has it, inline fallback when it does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-'));
  try {
    assert.throws(() => promptFor('amend', { plan: 'p1', instructions: '  ' }, { path: dir }), /Say how the plan should change/);
    const inline = promptFor('amend', { plan: 'p1', instructions: 'Use LF.' }, { path: dir });
    assert.match(inline, /^Amend plan `p1`/); assert.match(inline, /Instructions:\nUse LF\.$/);
    fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'commands', 'plan-amend.md'), 'x');
    assert.equal(promptFor('amend', { plan: 'p1', instructions: 'Use LF.' }, { path: dir }), '/plan-amend p1 Use LF.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(fs.existsSync(path.join(PKG, '.claude-template', 'commands', 'plan-amend.md')) || !hasPkg, 'the package ships /plan-amend');
});

const finished = async (id) => waitFor(async () => { const m = (await req('GET', `/api/ws/${wsId}/runs/${id}`)).body; return m.status !== 'running' && m; });

test('e2e: a new-plan run is linked to the plan it creates', { skip: !hasPkg }, async () => {
  await req('PUT', '/api/config', { claudeCommand: [process.execPath, FAKE] });
  const r = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'new', description: 'mkplan for me' });
  const m = await finished(r.body.id);
  assert.equal(m.plan, 'detected-plan');
  assert.ok((await req('GET', `/api/ws/${wsId}/runs?plan=detected-plan`)).body.some((x) => x.id === r.body.id));
});

test('e2e: replying resumes the session as a linked run; amend runs with instructions', { skip: !hasPkg }, async () => {
  const first = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'new', description: 'write a plan and ask questions' });
  const busy = await req('POST', `/api/ws/${wsId}/runs/${first.body.id}/reply`, { text: 'too early' });
  assert.ok(busy.status === 409 || busy.status === 200);
  const parent = await finished(first.body.id);
  assert.equal((await req('POST', `/api/ws/${wsId}/runs/${parent.id}/reply`, { text: ' ' })).status, 400);

  const rep = await req('POST', `/api/ws/${wsId}/runs/${parent.id}/reply`, { text: 'Use LF; skip the docs.' });
  assert.equal(rep.status, 200, rep.text);
  assert.equal(rep.body.parentRunId, parent.id);
  const child = await finished(rep.body.id);
  assert.equal(child.status, 'succeeded');
  assert.equal(child.sessionId, parent.sessionId, 'the reply continues the same session');
  assert.equal(child.phase, parent.phase);
  const evs = await readRunStream(`/api/ws/${wsId}/runs/${child.id}/events`);
  const start = evs.find((e) => e.data.event === 'start').data;
  assert.deepEqual(start.args.slice(start.args.indexOf('-p'), start.args.indexOf('-p') + 2), ['-p', 'Use LF; skip the docs.']);
  assert.equal(start.args[start.args.indexOf('--resume') + 1], parent.sessionId);

  const amend = await req('POST', `/api/ws/${wsId}/runs`, { phase: 'amend', plan: 'demo', instructions: 'Also cover b.txt.' });
  assert.equal(amend.status, 200, amend.text);
  assert.equal(amend.body.prompt, '/plan-amend demo Also cover b.txt.');
  assert.equal((await finished(amend.body.id)).status, 'succeeded');
});

test('code phases may move and delete files; older saved configs are upgraded without losing edits', () => {
  for (const k of ['implement', 'continue', 'rework']) {
    for (const t of ['Bash(mv:*)', 'Bash(rm:*)', 'PowerShell(Move-Item:*)', 'PowerShell(Remove-Item:*)'])
      assert.ok(C.DEFAULT_PHASES[k].allowedTools.includes(t), `${k}: ${t}`);
  }
  for (const k of ['new', 'amend', 'cancel']) assert.ok(!C.DEFAULT_PHASES[k].allowedTools.includes('Bash(rm:*)'), k);
  const oldPrompt = C.HEADLESS_PROMPT.split(' In implementation phases,')[0].replace('for file contents', 'for files');
  const saved = { appendSystemPrompt: oldPrompt, phases: {
    implement: { permissionMode: 'dontAsk', allowedTools: ['Read', 'Bash(godot:*)'] },
    new: { permissionMode: 'dontAsk', allowedTools: ['Read'] } } };
  const m = C.migrate(saved);
  assert.equal(m.configVersion, 2);
  assert.equal(m.appendSystemPrompt, C.HEADLESS_PROMPT);
  assert.ok(m.phases.implement.allowedTools.includes('Bash(godot:*)')); // the user's own addition is kept
  assert.ok(m.phases.implement.allowedTools.includes('PowerShell(Move-Item:*)'));
  assert.deepEqual(m.phases.new.allowedTools, ['Read']);
  assert.equal(C.migrate({ appendSystemPrompt: 'mine' }).appendSystemPrompt, 'mine'); // a customised prompt is kept
});

test('e2e: merge gate merges a plan into another and starts the fold phase on the target', { skip: !hasPkg }, async () => {
  assert.equal((await req('PUT', '/api/config', { claudeCommand: [process.execPath, FAKE] })).status, 200);
  const cli = (...a) => spawnSync(process.execPath, [path.join(wsDir, '.claude/workflow/plan.mjs'), ...a], { cwd: wsDir, encoding: 'utf8' });
  for (const slug of ['m1', 'm2']) {
    assert.equal(cli('new', slug, '--title', slug).status, 0);
    const f = path.join(wsDir, 'plans', `${slug}.md`); const t = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, t.slice(0, t.indexOf('\n---', 4) + 5) + [`# ${slug}`, '', '## Brief', '', 'x', '', '## Testing', '', 'N/A — test', '',
      '## Files Affected', '', '### wt', '- `a.txt` — x', '', '## Commit Messages', '', '### wt', '```text', `feat: ${slug}`, '```', ''].join('\n'));
  }
  const bad = await req('POST', `/api/ws/${wsId}/plans/m2/gate`, { action: 'merge', into: 'm2' });
  assert.equal(bad.status, 400);
  const g = await req('POST', `/api/ws/${wsId}/plans/m2/gate`, { action: 'merge', into: 'm1', runNext: true });
  assert.equal(g.body.ok, true, g.body.output);
  assert.equal(g.body.run.phase, 'merge'); assert.equal(g.body.run.plan, 'm1'); assert.equal(g.body.run.prompt, '/plan-merge m1');
  await readRunStream(`/api/ws/${wsId}/runs/${g.body.run.id}/events`);
  const st = await req('GET', `/api/ws/${wsId}/status`);
  const [m1, m2] = ['m1', 'm2'].map((n) => st.body.status.plans.find((p) => p.name === n));
  assert.equal(m2.mergedInto, 'm1'); assert.deepEqual(m1.mergedFrom, ['m2']);
  const un = await req('POST', `/api/ws/${wsId}/plans/m2/gate`, { action: 'unmerge' });
  assert.equal(un.body.ok, true, un.body.output); assert.equal(un.body.next, null);
});

test('refused shell commands get prefix rules, except where allowing cannot help', () => {
  const d = deniedCommands([
    { tool_name: 'Bash', tool_input: { command: 'dotnet test p.csproj' } },
    { tool_name: 'PowerShell', tool_input: { command: 'dotnet test p.csproj' } },
    { tool_name: 'Bash', tool_input: { command: 'cd x && make' } },
    { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
    { tool_name: 'Edit', tool_input: { file_path: 'a' } },
  ]);
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { command: 'dotnet test p.csproj', tools: ['Bash', 'PowerShell'], rules: ['Bash(dotnet:*)', 'PowerShell(dotnet:*)'], note: null });
  assert.deepEqual(d[1].rules, []); assert.match(d[1].note, /one at a time/);
  assert.deepEqual(d[2].rules, []); assert.match(d[2].note, /workspace/);
});

test('e2e: a refused command is allowed for the phase from the run, and a reply then runs with it', { skip: !hasPkg }, async () => {
  const first = await finished((await req('POST', `/api/ws/${wsId}/runs`, { phase: 'new', description: 'denytest' })).body.id);
  assert.deepEqual(first.denied.map((d) => d.rules), [['Bash(dotnet:*)', 'PowerShell(dotnet:*)']]);
  assert.equal((await req('POST', '/api/phases/new/allow', { rules: ['Bash(dotnet test; rm:*)'] })).status, 400);
  assert.equal((await req('POST', '/api/phases/nope/allow', { rules: ['Bash(dotnet:*)'] })).status, 400);
  const ok = await req('POST', '/api/phases/new/allow', { rules: first.denied[0].rules });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.body.allowedTools.includes('PowerShell(dotnet:*)'));
  const rep = await finished((await req('POST', `/api/ws/${wsId}/runs/${first.id}/reply`, { text: 'denytest again' })).body.id);
  assert.deepEqual(rep.denied, [], 'the reply runs with the newly allowed rule');
});

test('e2e: rules allowed for a workspace reach every phase run in it', { skip: !hasPkg }, async () => {
  const before = await finished((await req('POST', `/api/ws/${wsId}/runs`, { phase: 'amend', plan: 'demo', instructions: 'denytest' })).body.id);
  assert.equal(before.denied.length, 1, 'amend has no dotnet rule of its own');
  assert.equal((await req('POST', `/api/workspaces/${wsId}/allow`, { rules: ['rm -rf /'] })).status, 400);
  const ok = await req('POST', `/api/workspaces/${wsId}/allow`, { rules: before.denied[0].rules });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body.allowedTools, ['Bash(dotnet:*)', 'PowerShell(dotnet:*)']);
  const after = await finished((await req('POST', `/api/ws/${wsId}/runs`, { phase: 'amend', plan: 'demo', instructions: 'denytest' })).body.id);
  assert.deepEqual(after.denied, []);
  assert.ok(after.allowedTools.includes('PowerShell(dotnet:*)'));
  const cleared = await req('PUT', `/api/workspaces/${wsId}/allow`, { rules: [] });
  assert.deepEqual(cleared.body.allowedTools, []);
});

test('worktree git rules cover relative, absolute and quoted absolute paths', () => {
  const root = path.resolve('/ws root');
  const rules = C.worktreeGitRules(['project'], root);
  const abs = path.join(root, 'project');
  for (const r of [`Bash(git -C project status:*)`, `PowerShell(git -C "${abs}" status:*)`, `Bash(git -C "${abs.replace(/\\/g, '/')}" rev-parse:*)`])
    assert.ok(rules.includes(r), r);
});
