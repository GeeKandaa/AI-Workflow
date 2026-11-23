// Talks to a deployed workspace through its own CLI (`.claude/workflow/plan.mjs`). The UI never edits plans itself.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;
export const isSlug = (s) => typeof s === 'string' && SLUG.test(s);

/** The human gates, the CLI command each runs, and the phase that usually follows it. */
export const GATES = {
  stage:          { cli: 'stage',         from: ['planning'],                       next: 'implement' },
  continue:       { cli: 'continue',      from: ['staged'],                         next: 'continue' },
  cancel:         { cli: 'cancel',        from: ['staged', 'confirmation'],         next: 'cancel' },
  rework:         { cli: 'rework',        from: ['confirmation'],                   next: 'rework' },
  'archive-begin':{ cli: 'archive-begin', from: ['confirmation'],                   next: 'archive' },
  'archive-abort':{ cli: 'archive-abort', from: ['confirmation'],                   next: null },
  // merge: `plan` is merged into `options.into`; the follow-up phase runs on `into`. Needs a package with merge.
  merge:          { cli: 'merge',         from: ['planning', 'confirmation'],       next: 'merge' },
  unmerge:        { cli: 'unmerge',       from: ['planning', 'confirmation'],       next: null },
};

/** Run plan.mjs in a workspace. Resolves {code, stdout, stderr}; never rejects on a non-zero exit. */
export function runCli(ws, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ws.path, '.claude', 'workflow', 'plan.mjs'), ...args],
      { cwd: ws.path, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') return reject(err); // spawn failure or timeout
        resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

export async function status(ws) {
  const r = await runCli(ws, ['status', '--json']);
  if (r.code !== 0) throw new Error(`plan.mjs status failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout);
}

/** Run a human gate. `options` carries rework feedback and archive-begin flags. */
export async function gate(ws, plan, action, options = {}) {
  const g = GATES[action];
  if (!g) throw Object.assign(new Error(`Unknown gate "${action}".`), { status: 400 });
  if (!isSlug(plan)) throw Object.assign(new Error('Invalid plan name.'), { status: 400 });
  const args = [g.cli, plan];
  let nextPlan = plan;
  if (action === 'merge') {
    if (!isSlug(options.into) || options.into === plan) throw Object.assign(new Error('Choose another plan to merge into.'), { status: 400 });
    args.splice(1, 1, options.into, plan);
    nextPlan = options.into;
  }
  if (action === 'continue' && String(options.decision || '').trim()) args.push('--decision', String(options.decision).trim().slice(0, 4000));
  if (action === 'rework') args.push('--feedback', String(options.feedback || '').slice(0, 4000) || '(none given)');
  if (action === 'archive-begin') {
    if (options.manualCommit) {
      args.push('--manual-commit');
      for (const ref of [].concat(options.commitRefs || [])) {
        if (!/^[A-Za-z0-9._\/~^=-]{1,200}$/.test(ref)) throw Object.assign(new Error(`Invalid commit ref "${ref}".`), { status: 400 });
        args.push(ref);
      }
    } else if (options.allowUnlisted) args.push('--allow-unlisted');
    else if (options.requireListed) args.push('--require-listed');
  }
  const r = await runCli(ws, args);
  // Merging into an archived plan archives the merged plan at once: there is nothing left to fold.
  const next = r.code === 0 && !(action === 'merge' && /ARCHIVED \(merged into/.test(r.stdout)) ? g.next : null;
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim(), next, nextPlan };
}

const planFile = (ws, name) => path.join(ws.path, 'plans', `${name}.md`);

/** Raw markdown of an active plan, or of the newest archived plan with that id. */
export function readPlan(ws, name) {
  if (!isSlug(name)) throw Object.assign(new Error('Invalid plan name.'), { status: 400 });
  const active = planFile(ws, name);
  if (fs.existsSync(active)) return { archived: false, file: path.relative(ws.path, active), text: fs.readFileSync(active, 'utf8') };
  const a = archived(ws).filter((p) => p.id === name).pop();
  if (a) return { archived: true, file: a.file, text: fs.readFileSync(path.join(ws.path, a.file), 'utf8') };
  throw Object.assign(new Error(`Plan "${name}" not found.`), { status: 404 });
}

/** Minimal front-matter reader for archived plans (status --json only lists active ones). */
function frontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = {}; let list = null;
  if (!m) return fm;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s?(.*)$/.exec(line);
    if (item && list) { fm[list].push(item[1].replace(/^"(.*)"$/, '$1')); continue; }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === '') { fm[kv[1]] = []; list = kv[1]; } else { fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1'); list = null; }
  }
  return fm;
}

export function archived(ws) {
  const dir = path.join(ws.path, 'plans', 'archive');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return []; }
  return names.sort().map((n) => {
    const fm = frontMatter(fs.readFileSync(path.join(dir, n), 'utf8'));
    return { id: fm.id || n.replace(/^\d{8}-\d{6}_/, '').replace(/\.md$/, ''), title: fm.title || n, status: fm.status || 'archived',
      archived_at: fm.archived_at || null, commits: fm.commits || [], branches: fm.branches || [], file: `plans/archive/${n}` };
  });
}

/**
 * Watch a workspace's plans and state folders (those that exist) and call onChange, debounced.
 * The caller also polls, which covers folders created later and platforms where fs.watch is unreliable.
 * Returns a stop function.
 */
export function watchPlans(ws, onChange, debounceMs = 250) {
  let t = null; const fire = () => { clearTimeout(t); t = setTimeout(onChange, debounceMs); };
  const watchers = [];
  for (const d of [path.join(ws.path, 'plans'), path.join(ws.path, '.claude', 'state')]) {
    try { if (fs.existsSync(d)) watchers.push(fs.watch(d, { recursive: true }, fire)); } catch {}
  }
  return () => { clearTimeout(t); for (const w of watchers) try { w.close(); } catch {} };
}
