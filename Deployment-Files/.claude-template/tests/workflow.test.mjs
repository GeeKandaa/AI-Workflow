// Workflow tests: node --test .claude/tests/workflow.test.mjs   (Node 18+, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../workflow/lib.mjs';

const WORKFLOW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflow');

// --- archival options, manual commits and the Archive Record ---------------------------------------------------------
test('parseArchiveOptions: flags and refs', () => {
  const p = (s) => L.parseArchiveOptions(s ? s.split(' ') : []);
  assert.deepEqual(p(''), { allowUnlisted: false, requireListed: false, manualCommit: false, commitRefs: [], errors: [] });
  assert.equal(p('--allow-unlisted').allowUnlisted, true);
  assert.equal(p('--require-listed').requireListed, true);
  assert.equal(p('--manual-commit').manualCommit, true);
  assert.deepEqual(p('--manual-commit abc1234').commitRefs, ['abc1234']);
  assert.deepEqual(p('--manual-commit a=abc b=HEAD~1').commitRefs, ['a=abc', 'b=HEAD~1']);
});
test('parseArchiveOptions: errors', () => {
  const e = (s) => L.parseArchiveOptions(s.split(' ')).errors;
  assert.equal(e('--manual-commit --allow-unlisted').length, 1);
  assert.equal(e('--allow-unlisted --require-listed').length, 1);
  assert.match(e('abc123')[0], /only accepted after --manual-commit/);
  assert.match(e('--force')[0], /unknown option/);
  assert.match(e('--manual-commit a=')[0], /malformed/);
});

test('resolveManualCommits', () => {
  const r = L.resolveManualCommits;
  assert.deepEqual(r(['abc'], ['wt']), { byRepo: { wt: 'abc' }, errors: [] });
  assert.deepEqual(r([], ['a', 'b']), { byRepo: { a: null, b: null }, errors: [] });
  assert.deepEqual(r(['a=1'], ['a', 'b']).byRepo, { a: '1', b: null });
  assert.match(r(['abc'], ['a', 'b']).errors[0], /ambiguous/);
  assert.match(r(['c=1'], ['a', 'b']).errors[0], /not one of this plan's repositories/);
  assert.match(r(['a=1', 'a=2'], ['a', 'b']).errors[0], /more than one hash/);
});

test('effectiveAllowUnlisted: every combination of flag and config', () => {
  for (const def of [false, true]) {
    const c = { archive: { allowUnlistedByDefault: def } };
    assert.equal(L.effectiveAllowUnlisted({}, c), def);
    assert.equal(L.effectiveAllowUnlisted({ allowUnlisted: true }, c), true);
    assert.equal(L.effectiveAllowUnlisted({ requireListed: true }, c), false);
  }
  assert.equal(L.effectiveAllowUnlisted({}, {}), false);
});

test('archiveRecordSection: auto, manual and MISSING', () => {
  const sha = 'a'.repeat(40);
  const auto = L.archiveRecordSection({ mode: 'auto', at: 'T', entries: [{ repo: 'wt', index: 1, sha, subject: 'feat: x' }],
    leftUncommitted: [{ repo: 'wt', path: 'notes.md', state: 'untracked' }] });
  assert.match(auto, /^## Archive Record\n/);
  assert.ok(auto.includes(`- wt #1: \`${sha}\` feat: x`));
  assert.ok(auto.includes('- wt: `notes.md` (untracked)'));
  const manual = L.archiveRecordSection({ mode: 'manual', at: 'T', entries: [{ repo: 'a', sha, subject: 's' }, { repo: 'b', sha: null }] });
  assert.match(manual, /\*\*Mode:\*\* manual/);
  assert.ok(manual.includes(`- b: **${L.MISSING_TEXT}**`));
});

const FENCE = '`'.repeat(3);
const body = (title, files, msg = 'feat: change things') => ['# ' + title, '', '## Brief', '', 'x', '', '## Testing', '', 'N/A — test',
  '', '## Files Affected', '', '### wt', ...files.map((f) => `- \`${f}\` — x`), '', '## Commit Messages', '', '### wt',
  `${FENCE}text`, msg, FENCE, ''].join('\n');
const RECORD = '## Archive Record\n\n- **Archived:** T\n';

test('outstanding questions: parsed, counted, ordered above Testing', () => {
  const withQ = (q) => body('t', ['a.txt']).replace('## Testing', `## Outstanding Questions\n\n${q}\n\n## Testing`);
  assert.deepEqual(L.openQuestions(withQ('1. Where? (a) x (b) y\n2) Which name?\n- Bullet too')), ['Where? (a) x (b) y', 'Which name?', 'Bullet too']);
  assert.deepEqual(L.openQuestions(withQ('None.')), []);
  assert.deepEqual(L.openQuestions(withQ('<!-- 1. hidden -->')), []);
  assert.deepEqual(L.openQuestions(body('t', ['a.txt'])), []); // older plans without the section
  const v = L.validatePlan({ fm: { id: 't', status: 'planning' }, body: withQ('1. Where?') }, { strict: false });
  assert.ok(v.warnings.some((w) => /1 outstanding question/.test(w)), v.warnings.join('; '));
  const misplaced = body('t', ['a.txt']).replace('## Brief', '## Outstanding Questions\n\nNone.\n\n## Brief');
  assert.ok(L.validatePlan({ fm: { id: 't', status: 'planning' }, body: misplaced }, { strict: false }).errors.some((e) => /Outstanding Questions" must sit/.test(e)));
  const fixed = L.joinSections(L.normaliseSections(L.splitSections(body('t', ['a.txt']) + '\n## Outstanding Questions\n\n1. Late?\n')));
  assert.ok(fixed.indexOf('## Outstanding Questions') < fixed.indexOf('## Testing'));
  assert.ok(fixed.indexOf('## Outstanding Questions') > fixed.indexOf('## Brief'));
});
const orderErrors = (b) => L.validatePlan({ fm: { id: 't', status: 'archived' }, body: b }, { strict: false }).errors
  .filter((e) => /last two sections|Archive Record|AI Feedback/.test(e));
test('validatePlan accepts one trailing Archive Record and rejects misplaced ones', () => {
  const b = body('T', ['a.txt']);
  assert.deepEqual(orderErrors(b), []);
  assert.deepEqual(orderErrors(`${b}\n${RECORD}`), []);
  assert.ok(orderErrors(`${b}\n${RECORD}\n${RECORD}`).some((e) => /appears 2 times/.test(e)));
  assert.ok(orderErrors(b.replace('## Files Affected', `${RECORD}\n## Files Affected`)).some((e) => /must be the final section/.test(e)));
});

test('formatTreeRefusal gives CLI gate commands, not slash commands', () => {
  const s = L.formatTreeRefusal({ plan: 'my-plan', unlisted: [{ repo: 'wt', path: 'x.js', state: 'modified' }] });
  assert.match(s, /stopped before anything was committed or locked/);
  assert.ok(s.includes('\n  wt\n    modified   x.js\n'));
  assert.ok(s.includes(`${L.CLI} archive-begin my-plan --allow-unlisted`));
  assert.ok(s.includes(`${L.CLI} rework my-plan --feedback`));
  assert.ok(!s.includes('/plan-'));
  const u = L.formatTreeRefusal({ plan: 'p', unchanged: [{ repo: 'wt', path: 'a.txt', state: 'unchanged' }], locked: true });
  assert.match(u, /archive-abort p/);
  assert.ok(u.includes(`${L.CLI} cancel p`));
});

test('sharedFiles compares worktree + normalised path', () => {
  const a = new Map([['wt:a.txt', 'wt/a.txt'], ['wt:b.txt', 'wt/b.txt']]);
  const b = new Map([['wt:b.txt', 'wt/b.txt'], ['other:a.txt', 'other/a.txt']]);
  assert.deepEqual(L.sharedFiles(a, b), ['wt/b.txt']);
});

test('porcelainState', () => {
  assert.deepEqual(['??', ' M', 'M ', ' D', 'R ', 'A ', 'AM'].map(L.porcelainState),
    ['untracked', 'modified', 'modified', 'deleted', 'renamed', 'added', 'added']);
});

// --- end to end: several plans in one worktree ----------------------------------------------------------------------
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-wf-'));
  const wf = path.join(root, '.claude', 'workflow');
  fs.mkdirSync(wf, { recursive: true });
  for (const f of ['lib.mjs', 'plan.mjs', 'config.json', 'plan-template.md']) fs.copyFileSync(path.join(WORKFLOW, f), path.join(wf, f));
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  const git = (...a) => { const r = spawnSync('git', ['-C', wt, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(wt, f), `${f}\n`);
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  const cli = (...a) => spawnSync(process.execPath, [path.join(wf, 'plan.mjs'), ...a], { cwd: root, encoding: 'utf8' });
  const plan = (slug, files) => {
    assert.equal(cli('new', slug, '--title', slug).status, 0);
    const file = path.join(root, 'plans', `${slug}.md`);
    const text = fs.readFileSync(file, 'utf8');
    const fm = text.slice(0, text.indexOf('\n---', 4) + 5);
    fs.writeFileSync(file, fm + body(slug, files, `feat: ${slug}`));
    const v = cli('validate', slug); assert.equal(v.status, 0, v.stdout + v.stderr);
  };
  return { root, wt, git, cli, plan, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('complete warns about unlisted changes in worktrees the plan does not list', () => {
  const w = workspace();
  try {
    const wt2 = path.join(w.root, 'wt2');
    fs.mkdirSync(wt2);
    assert.equal(spawnSync('git', ['-C', wt2, 'init', '-q']).status, 0);
    fs.writeFileSync(path.join(wt2, 'generated.lock'), 'x\n');
    w.plan('p1', ['a.txt']);
    assert.equal(w.cli('stage', 'p1').status, 0);
    fs.appendFileSync(path.join(w.wt, 'a.txt'), 'p1\n');
    const done = w.cli('complete', 'p1');
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /warning: wt2: "generated\.lock" changed \(untracked\); no active plan lists it/);
  } finally { w.cleanup(); }
});

test('merge: two confirmed plans sharing a file are archived together; merging into an archived plan', () => {
  const w = workspace();
  try {
    const rewrite = (slug, files) => { // what /plan-merge does: change the body, keep the front-matter
      const file = path.join(w.root, 'plans', `${slug}.md`); const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.slice(0, text.indexOf('\n---', 4) + 5) + body(slug, files, `feat: ${slug}`));
    };
    w.plan('p1', ['a.txt']); w.plan('p2', ['a.txt', 'b.txt']);
    assert.equal(w.cli('stage', 'p1').status, 0);
    fs.appendFileSync(path.join(w.wt, 'a.txt'), 'p1\n');
    assert.equal(w.cli('complete', 'p1').status, 0);
    assert.equal(w.cli('stage', 'p2').status, 0);
    fs.appendFileSync(path.join(w.wt, 'a.txt'), 'p2\n'); fs.appendFileSync(path.join(w.wt, 'b.txt'), 'p2\n');
    assert.equal(w.cli('complete', 'p2').status, 0);

    const m = w.cli('merge', 'p1', 'p2');
    assert.equal(m.status, 0, m.stdout + m.stderr);
    assert.match(m.stdout, /\/plan-merge p1/);
    const json = JSON.parse(w.cli('status', '--json').stdout);
    const [j1, j2] = ['p1', 'p2'].map((n) => json.plans.find((p) => p.name === n));
    assert.equal(j2.mergedInto, 'p1'); assert.deepEqual(j1.mergedFrom, ['p2']);
    assert.deepEqual(j1.overlaps, []); // a merged plan's files count as its target's
    assert.deepEqual(j1.mergeGaps, [{ plan: 'p2', files: ['wt/b.txt'] }]);
    assert.match(w.cli('rework', 'p2', '--feedback', 'x').stderr, /merged into "p1"/);

    const early = w.cli('archive-begin', 'p1'); // b.txt not folded in yet
    assert.equal(early.status, 1); assert.match(early.stderr, /p2: wt\/b\.txt/);
    rewrite('p1', ['a.txt', 'b.txt']);
    const begin = w.cli('archive-begin', 'p1');
    assert.equal(begin.status, 0, begin.stdout + begin.stderr);
    assert.match(begin.stdout, /archived with this one: p2/);
    const fin = w.cli('archive-finish', 'p1', '--plans-reviewed');
    assert.equal(fin.status, 0, fin.stdout + fin.stderr);
    assert.match(fin.stdout, /p2 ARCHIVED \(merged into p1\)/);
    assert.deepEqual(fs.readdirSync(path.join(w.root, 'plans')).filter((f) => f.endsWith('.md')), []);
    const archivedP2 = fs.readdirSync(path.join(w.root, 'plans', 'archive')).find((f) => f.endsWith('p2.md'));
    const p2text = fs.readFileSync(path.join(w.root, 'plans', 'archive', archivedP2), 'utf8');
    assert.match(p2text, /\*\*Merged into:\*\* `p1`/); assert.match(p2text, /status: archived/);
    assert.equal(w.git('status', '--porcelain'), '');

    // The orphan case: a plan left behind after its partner was archived is merged into the archived plan.
    w.plan('p3', ['c.txt']);
    const late = w.cli('merge', 'p1', 'p3');
    assert.equal(late.status, 0, late.stdout + late.stderr);
    assert.match(late.stdout, /p3 ARCHIVED \(merged into p1\)/);
    assert.ok(!fs.existsSync(path.join(w.root, 'plans', 'p3.md')));

    // Unmerge before archival.
    w.plan('p4', ['c.txt']); w.plan('p5', ['c.txt']);
    assert.equal(w.cli('merge', 'p4', 'p5').status, 0);
    assert.equal(w.cli('unmerge', 'p5').status, 0);
    assert.equal(JSON.parse(w.cli('status', '--json').stdout).plans.find((p) => p.name === 'p5').mergedInto, null);
    assert.equal(w.cli('merge', 'p4', 'p4').status, 1);
  } finally { w.cleanup(); }
});

test('several plans per worktree: overlap gating, ownership and whole-file archival', () => {
  const w = workspace();
  try {
    w.plan('p1', ['a.txt']);
    w.plan('p2', ['a.txt', 'b.txt']);
    w.plan('p3', ['c.txt']);

    assert.equal(w.cli('stage', 'p1').status, 0);
    const clash = w.cli('stage', 'p2');
    assert.equal(clash.status, 1);
    assert.match(clash.stderr, /shares files with plans already in implementation:\n {2}- p1: wt\/a\.txt/);
    const ok = w.cli('stage', 'p3');
    assert.equal(ok.status, 0, ok.stderr);

    // p1's edit to a.txt must not block p3; an edit no plan lists must.
    fs.appendFileSync(path.join(w.wt, 'a.txt'), 'p1\n');
    fs.appendFileSync(path.join(w.wt, 'c.txt'), 'p3\n');
    fs.writeFileSync(path.join(w.wt, 'stray.txt'), 'x\n');
    const blocked = w.cli('complete', 'p3');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /stray\.txt" changed but no active plan lists it/);
    assert.match(blocked.stdout, /a\.txt" changed; it belongs to p1/);
    assert.match(blocked.stdout, /generated by <command>/); // guidance for files the work generated
    fs.rmSync(path.join(w.wt, 'stray.txt'));
    const done = w.cli('complete', 'p3');
    assert.equal(done.status, 0, done.stdout + done.stderr);

    const json = JSON.parse(w.cli('status', '--json').stdout);
    assert.deepEqual(json.worktrees, { wt: 'wt' });
    const p2 = json.plans.find((p) => p.name === 'p2');
    assert.deepEqual(p2.overlaps, [{ plan: 'p1', status: 'staged', files: ['wt/a.txt'] }]);

    const begin = w.cli('archive-begin', 'p3');
    assert.equal(begin.status, 0, begin.stdout + begin.stderr);
    const finish = w.cli('archive-finish', 'p3', '--plans-reviewed');
    assert.equal(finish.status, 0, finish.stdout + finish.stderr);
    assert.deepEqual(w.git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['c.txt']);
    assert.equal(w.git('log', '-1', '--format=%s'), 'feat: p3');
    // The output ends with the final commit's full hash and message.
    const tail = finish.stdout.trimEnd().split(/\r?\n/).slice(-3);
    assert.deepEqual(tail, ['FINAL COMMIT (hash and message):', `- wt: ${w.git('rev-parse', 'HEAD')}`, '    feat: p3']);
    assert.equal(w.git('status', '--porcelain'), 'M a.txt'); // p1's work is untouched (helper trims the leading space)
    assert.equal(fs.readdirSync(path.join(w.root, 'plans', 'archive')).filter((f) => f.endsWith('_p3.md')).length, 1);

    // Shared files are reported at archive-begin.
    assert.equal(w.cli('complete', 'p1').status, 0);
    const shared = w.cli('archive-begin', 'p1');
    assert.equal(shared.status, 0, shared.stdout + shared.stderr);
    assert.match(shared.stdout, /Shared files[\s\S]*- p2 \(planning\)\n\s+modified\s+wt\/a\.txt/);
    assert.equal(w.cli('archive-abort', 'p1').status, 0);
  } finally { w.cleanup(); }
});

test('rework takes feedback from --feedback and re-checks overlap', () => {
  const w = workspace();
  try {
    w.plan('p1', ['a.txt']);
    w.plan('p2', ['a.txt']);
    assert.equal(w.cli('stage', 'p1').status, 0);
    fs.appendFileSync(path.join(w.wt, 'a.txt'), 'x\n');
    assert.equal(w.cli('complete', 'p1').status, 0);
    assert.equal(w.cli('stage', 'p2').status, 0); // p1 is no longer staged
    assert.match(w.cli('rework', 'p1', '--feedback', 'more').stderr, /p2: wt\/a\.txt/);
    assert.equal(w.cli('cancel', 'p2').status, 0);
    const p2 = fs.readFileSync(path.join(w.root, 'plans', 'p2.md'), 'utf8'); // cancel adds an Outstanding Questions section
    assert.ok(p2.indexOf('## Plan Extension 1') < p2.indexOf('## Outstanding Questions'));
    assert.ok(p2.indexOf('## Outstanding Questions') < p2.indexOf('## Testing'));
    fs.writeFileSync(path.join(w.root, 'plans', 'p2.md'), p2.replace(/(## Outstanding Questions\n)[\s\S]*?(\n## Testing)/, '$1\n1. Keep b.txt?\n$2'));
    const listed = JSON.parse(w.cli('status', '--json').stdout).plans.find((p) => p.name === 'p2');
    assert.deepEqual(listed.openQuestions, ['Keep b.txt?']);
    assert.equal(w.cli('rework', 'p1', '--feedback', 'add a test').status, 0);
    assert.match(fs.readFileSync(path.join(w.root, 'plans', 'p1.md'), 'utf8'), /Human rework feedback:\*\* add a test/);
  } finally { w.cleanup(); }
});

test('continue records the human\'s chosen option; status shows the full deviation', () => {
  const w = workspace();
  try {
    w.plan('p1', ['a.txt']);
    assert.equal(w.cli('stage', 'p1').status, 0);
    const text = 'The parser cannot stay as planned.\n1. Rewrite it (recommended)\n2. Wrap the old one\n' + 'x'.repeat(400);
    assert.equal(w.cli('deviate', 'p1', text).status, 0);
    const listed = JSON.parse(w.cli('status', '--json').stdout).plans[0];
    assert.equal(listed.pendingDecision, true);
    assert.ok(listed.pendingSummary.length <= 300);
    assert.match(listed.pendingDetail, /^The parser cannot stay as planned\.\n1\. Rewrite it \(recommended\)\n2\. Wrap the old one\nx{400}$/);
    const ok = w.cli('continue', 'p1', '--decision', 'Option 2: Wrap the old one');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Human's decision: Option 2: Wrap the old one/);
    const plan = fs.readFileSync(path.join(w.root, 'plans', 'p1.md'), 'utf8');
    assert.match(plan, /\*\*Deviation approved by human:\*\* .*\*\*Human's decision \(follow this over any recommendation\):\*\* Option 2: Wrap the old one/);
    const after = JSON.parse(w.cli('status', '--json').stdout).plans[0];
    assert.equal(after.pendingDecision, false); assert.equal(after.pendingDetail, null);
    assert.equal(w.cli('deviate', 'p1', 'again').status, 0);
    assert.equal(w.cli('continue', 'p1').status, 0); // a decision stays optional
    assert.doesNotMatch(fs.readFileSync(path.join(w.root, 'plans', 'p1.md'), 'utf8').split('again')[1], /Human's decision/);
  } finally { w.cleanup(); }
});

test('archive lock: only one of several simultaneous archive-begin calls wins', async () => {
  const w = workspace();
  try {
    const names = ['r1', 'r2', 'r3', 'r4'];
    for (const s of names) {
      w.plan(s, [`${s}.txt`]);
      assert.equal(w.cli('stage', s).status, 0);
      fs.writeFileSync(path.join(w.wt, `${s}.txt`), 'x\n');
      assert.equal(w.cli('complete', s).status, 0);
    }
    const { spawn } = await import('node:child_process');
    const run = (s) => new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(w.root, '.claude/workflow/plan.mjs'), 'archive-begin', s], { cwd: w.root });
      p.on('close', (code) => resolve({ s, code }));
    });
    const results = await Promise.all(names.map(run));
    const winners = results.filter((r) => r.code === 0).map((r) => r.s);
    assert.equal(winners.length, 1, `winners: ${winners.join(', ')}`);
    assert.equal(JSON.parse(w.cli('status', '--json').stdout).lock.plan, winners[0]);
  } finally { w.cleanup(); }
});

test('branch: recorded at stage, verified at complete, archive-begin and archive-finish', () => {
  const w = workspace();
  try {
    const branch = w.git('symbolic-ref', '--short', 'HEAD');
    w.plan('p1', ['a.txt']);
    w.git('switch', '-q', '--detach');
    const detached = w.cli('stage', 'p1');
    assert.equal(detached.status, 1);
    assert.match(detached.stderr, /HEAD is detached/);
    w.git('switch', '-q', branch);
    assert.equal(w.cli('stage', 'p1').status, 0);
    assert.match(fs.readFileSync(path.join(w.root, 'plans', 'p1.md'), 'utf8'), new RegExp(`branches:\n  - "?wt=${branch}"?\n`));

    fs.appendFileSync(path.join(w.wt, 'a.txt'), 'x\n');
    w.git('switch', '-q', '-c', 'other');
    const moved = w.cli('complete', 'p1');
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, new RegExp(`on branch "other", but the plan was staged on "${branch}"`));
    w.git('switch', '-q', branch);
    assert.equal(w.cli('complete', 'p1').status, 0);

    w.git('switch', '-q', 'other');
    const begin = w.cli('archive-begin', 'p1');
    assert.equal(begin.status, 1);
    assert.match(begin.stderr, /No lock was written/);
    assert.equal(JSON.parse(w.cli('status', '--json').stdout).lock, null);

    w.git('switch', '-q', branch);
    assert.equal(w.cli('archive-begin', 'p1').status, 0);
    w.git('switch', '-q', 'other');
    const head = w.git('rev-parse', 'HEAD');
    const finish = w.cli('archive-finish', 'p1', '--plans-reviewed');
    assert.equal(finish.status, 1);
    assert.match(finish.stderr, /Nothing more was committed/);
    assert.equal(w.git('rev-parse', 'HEAD'), head);

    w.git('switch', '-q', branch);
    const done = w.cli('archive-finish', 'p1', '--plans-reviewed');
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(w.git('log', '-1', '--format=%s', branch), 'feat: p1');
    assert.ok(done.stdout.includes(`- **Branches:** wt \`${branch}\``), done.stdout);
  } finally { w.cleanup(); }
});
