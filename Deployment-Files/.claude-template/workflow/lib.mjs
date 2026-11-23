// Shared library for the AI plan workflow. No dependencies beyond Node.js (>= 18).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Workspace / config
// ---------------------------------------------------------------------------

/** The folder holding this file (…/.claude/workflow); config and templates are resolved relative to it. */
export const WORKFLOW_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(WORKFLOW_DIR, '..', '..');
export const IS_WIN = process.platform === 'win32';

export const STATUS = Object.freeze({
  PLANNING: 'planning',
  STAGED: 'staged',
  CONFIRMATION: 'confirmation',
  ARCHIVED: 'archived',
});

export const SECTION = Object.freeze({
  BRIEF: 'Brief',
  EXTENSION: 'Plan Extension',
  QUESTIONS: 'Outstanding Questions',
  TESTING: 'Testing',
  FEEDBACK: 'AI Feedback',
  FILES: 'Files Affected',
  COMMITS: 'Commit Messages',
  RECORD: 'Archive Record',
});

const DEFAULTS = {
  plansDir: 'plans',
  archiveDir: 'plans/archive',
  stateDir: '.claude/state',
  archivePrefixFormat: 'YYYYMMDD-HHmmss_',
  repositories: { autoDiscover: true, includeRoot: false, rootName: 'root', map: {} },
  commit: {
    templateFile: '.claude/workflow/commit-template.txt',
    subjectPattern: '^.+$',
    maxSubjectLength: 72,
    maxBodyLineLength: 100,
    blankLineAfterSubject: true,
    requiredTrailers: [],
  },
  archive: { allowUnlistedByDefault: false },
};

/** Workspace paths that never count as a repository's own changes when the root itself is a repository. */
const WORKFLOW_PATHS = ['.claude', 'CLAUDE.md'];

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

let _config;
export function config() {
  if (_config) return _config;
  const file = path.join(WORKFLOW_DIR, 'config.json');
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Invalid ${file}: ${e.message}`);
  }
  _config = merge(DEFAULTS, user);
  return _config;
}

export const abs = (rel) => path.resolve(ROOT, rel);
export const plansDir = () => abs(config().plansDir);
export const archiveDir = () => abs(config().archiveDir);
export const stateDir = () => abs(config().stateDir);

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

/** Normalise a path for comparisons: forward slashes, no leading ./, case-folded on Windows. */
export function normPath(p) {
  let s = String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return IS_WIN ? s.toLowerCase() : s;
}

/** Workspace-relative, normalised path, or null if outside the workspace. */
export function relToRoot(p) {
  const r = path.relative(ROOT, path.resolve(ROOT, p));
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return normPath(r);
}

export function isUnder(rel, dirRel) {
  const d = normPath(dirRel);
  return rel === d || rel.startsWith(d + '/');
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function formatDate(fmt, d = new Date()) {
  return fmt
    .replace(/YYYY/g, d.getFullYear())
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const nowHuman = () => formatDate('YYYY-MM-DD HH:mm');

// ---------------------------------------------------------------------------
// Front-matter (minimal YAML subset: `key: value` scalars and `key:` + `  - item` lists)
// ---------------------------------------------------------------------------

const FM_ORDER = ['id', 'title', 'status', 'merged_into', 'pending_decision', 'pending_summary', 'attempt', 'created', 'updated',
  'staged_at', 'completed_at', 'archived_at', 'archive_file', 'branches', 'commit_mode', 'commits', 'history'];

export function parseFrontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const fm = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = /^\s+-\s?(.*)$/.exec(line);
    if (item && listKey) { fm[listKey].push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === '') { fm[kv[1]] = []; listKey = kv[1]; }
    else { fm[kv[1]] = unquote(kv[2]); listKey = null; }
  }
  return { fm, raw: m[0], body: text.slice(m[0].length) };
}

function unquote(v) {
  v = v.trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
const quote = (v) => (/^[\w.:/@+ -]*$/.test(v) && !/^\s|\s$/.test(v) && v !== '' ? v : JSON.stringify(v));

export function serializeFrontMatter(fm) {
  const keys = [...FM_ORDER.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !FM_ORDER.includes(k))];
  const lines = ['---'];
  for (const k of keys) {
    const v = fm[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`);
      for (const it of v) lines.push(`  - ${quote(String(it))}`);
    } else lines.push(`${k}: ${quote(String(v))}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** Canonical string used to detect any change to front-matter. */
export function fmFingerprint(fm) { return fm ? serializeFrontMatter(fm) : '<none>'; }

// ---------------------------------------------------------------------------
// Markdown sections (H2 level; fenced code blocks respected)
// ---------------------------------------------------------------------------

export function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let cur = { title: null, lines: [] }; // preamble
  let fence = null;
  for (const line of lines) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; }
    const h = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && !line.startsWith('###')) {
      sections.push(cur);
      cur = { title: h[1].trim(), lines: [line] };
    } else cur.lines.push(line);
  }
  sections.push(cur);
  return sections;
}

export const joinSections = (sections) =>
  sections.map((s) => s.lines.join('\n').replace(/\s+$/, '')).filter((t, i) => t || i > 0).join('\n\n') + '\n';

export const sectionKind = (title) => {
  if (!title) return null;
  const t = title.toLowerCase();
  if (t.startsWith(SECTION.EXTENSION.toLowerCase())) return 'extension';
  for (const [k, v] of Object.entries(SECTION)) if (t === v.toLowerCase()) return k.toLowerCase();
  return 'other';
};

/**
 * Reorder so the tail is always:
 * [...others, newSections..., Outstanding Questions, Testing, AI Feedback, Files Affected, Commit Messages, Archive Record].
 * The Archive Record exists only in archived plans (written by archive-finish).
 */
export function normaliseSections(sections, insert = []) {
  const pick = (kind) => sections.filter((s) => sectionKind(s.title) === kind);
  const tailKinds = ['questions', 'testing', 'feedback', 'files', 'commits', 'record'];
  const head = sections.filter((s) => !tailKinds.includes(sectionKind(s.title)));
  return [...head, ...insert, ...tailKinds.flatMap(pick)];
}

const sectionText = (s) => s.lines.slice(1).join('\n');

/**
 * The open questions in a plan's "## Outstanding Questions" section: its list items (numbered or bulleted,
 * comments ignored). "None", an empty section or no section at all means there are none.
 */
export function openQuestions(body) {
  const sec = splitSections(body).find((s) => sectionKind(s.title) === 'questions');
  if (!sec) return [];
  return stripComments(sectionText(sec)).split(/\r?\n/)
    .map((l) => /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*\S)/.exec(l)?.[1]).filter(Boolean);
}

export const DEVIATION_MARK = '**Substantial deviation proposed (awaiting human):**';

/**
 * The full text of the pending deviation (front matter keeps a 300-character summary): the newest AI Feedback
 * entry raised by `deviate`, up to the next entry. Null when none is pending.
 */
export function pendingDeviation(p) {
  if (!isPending(p)) return null;
  const sec = splitSections(p.body).find((s) => sectionKind(s.title) === 'feedback');
  if (!sec) return p.fm.pending_summary || null;
  const lines = sec.lines;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(DEVIATION_MARK)) { start = i; break; }
  if (start < 0) return p.fm.pending_summary || null;
  const out = [lines[start].slice(lines[start].indexOf(DEVIATION_MARK) + DEVIATION_MARK.length).trim()];
  for (let i = start + 1; i < lines.length && !/^- \*\*/.test(lines[i]); i++) out.push(lines[i].replace(/^ {2}/, ''));
  return out.join('\n').trim() || null;
}

/** Parse `### repo` sub-headings into { repo: [lines] }. */
function subsections(text) {
  const out = {}; let cur = null; let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; }
    const h = !fence && /^###\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { cur = h[1].replace(/`/g, '').trim(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

function bulletPath(line) {
  const m = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (!m) return null;
  const tick = /`([^`]+)`/.exec(m[1]);
  const p = (tick ? tick[1] : m[1].split(/\s+/)[0]).trim();
  return p ? p.replace(/\\/g, '/').replace(/^\.\//, '') : null;
}

export function parseFilesAffected(text) {
  const out = {};
  for (const [repo, lines] of Object.entries(subsections(stripComments(text)))) {
    out[repo] = lines.map(bulletPath).filter(Boolean);
  }
  return out;
}

export function parseCommits(text) {
  const out = {};
  for (const [repo, lines] of Object.entries(subsections(stripComments(text)))) {
    const commits = []; let files = []; let buf = null; let fenceCh = null;
    for (const line of lines) {
      const f = /^\s*(```+|~~~+)/.exec(line);
      if (buf === null && f) { buf = []; fenceCh = f[1][0]; continue; }
      if (buf !== null) {
        if (f && f[1][0] === fenceCh) { commits.push({ message: buf.join('\n').replace(/\s+$/, ''), files }); buf = null; files = []; }
        else buf.push(line);
        continue;
      }
      const p = bulletPath(line);
      if (p) files.push(p);
    }
    out[repo] = commits;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export function readPlan(file) {
  const text = fs.readFileSync(file, 'utf8');
  const p = parseFrontMatter(text);
  return {
    file,
    name: path.basename(file, '.md'),
    text,
    fm: p ? p.fm : null,
    body: p ? p.body : text,
  };
}

export function writePlan(plan, body = plan.body) {
  plan.fm.updated = nowIso();
  const text = serializeFrontMatter(plan.fm) + body.replace(/^\s*\n/, '');
  fs.writeFileSync(plan.file, text);
  plan.text = text; plan.body = body;
}

export function addHistory(plan, entry) {
  plan.fm.history = [...(plan.fm.history || []), `${nowIso()} ${entry}`];
}

export function listPlans({ includeArchived = false } = {}) {
  const out = [];
  const dirs = [plansDir()];
  if (includeArchived) dirs.push(archiveDir());
  for (const d of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || /^readme\.md$/i.test(e.name)) continue;
      const plan = readPlan(path.join(d, e.name));
      if (plan.fm && plan.fm.status) out.push(plan);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findPlan(ref) {
  if (!ref) throw new Error('A plan name is required.');
  const name = path.basename(String(ref).trim().replace(/\\/g, '/'), '.md');
  const file = path.join(plansDir(), `${name}.md`);
  if (!fs.existsSync(file)) {
    const archived = listPlans({ includeArchived: true }).find((p) => p.fm.id === name);
    if (archived) throw new Error(`Plan "${name}" is archived (${path.relative(ROOT, archived.file)}) and can no longer change.`);
    throw new Error(`Plan "${name}" not found in ${config().plansDir}/.`);
  }
  const plan = readPlan(file);
  if (!plan.fm || !plan.fm.status) throw new Error(`${path.relative(ROOT, file)} has no workflow front-matter.`);
  return plan;
}

export const activePlans = () => listPlans().filter((p) => p.fm.status !== STATUS.ARCHIVED);

/** The newest archived plan with this id, or null. */
export const findArchived = (id) =>
  listPlans({ includeArchived: true }).filter((p) => p.fm.id === id && p.fm.status === STATUS.ARCHIVED).pop() || null;

/**
 * Merging: a plan the human merged into another carries `merged_into: <target>`. It stays in plans/ until the
 * target is archived, and is then archived with it. Its files count as the target's: it takes no part in
 * overlaps or claims, and the target must list every file it lists before archival.
 */
export const mergedSources = (targetName) => activePlans().filter((p) => p.fm.merged_into === targetName);

/** Files that plans merged into `target` list but the target's Files Affected doesn't: [{plan, files}]. */
export function mergeGaps(target) {
  const mine = planFiles(target);
  return mergedSources(target.name)
    .map((s) => ({ plan: s.name, files: [...planFiles(s)].filter(([k]) => !mine.has(k)).map(([, v]) => v) }))
    .filter((g) => g.files.length);
}
export const stagedPlan = () => activePlans().find((p) => p.fm.status === STATUS.STAGED) || null;
export const isPending = (plan) => String(plan.fm.pending_decision) === 'true';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateCommitMessage(msg) {
  const c = config().commit;
  const errs = [];
  const lines = msg.split(/\r?\n/);
  const subject = lines[0] || '';
  if (!subject.trim()) errs.push('empty subject line');
  if (!new RegExp(c.subjectPattern).test(subject)) errs.push(`subject "${subject}" does not match commit template pattern /${c.subjectPattern}/`);
  if (subject.length > c.maxSubjectLength) errs.push(`subject is ${subject.length} chars (max ${c.maxSubjectLength})`);
  if (c.blankLineAfterSubject && lines.length > 1 && lines[1].trim() !== '') errs.push('second line must be blank');
  lines.slice(2).forEach((l, i) => {
    if (l.length > c.maxBodyLineLength && !/^\S+:\s/.test(l) && !/https?:\/\//.test(l))
      errs.push(`body line ${i + 3} is ${l.length} chars (max ${c.maxBodyLineLength})`);
  });
  for (const t of c.requiredTrailers || []) {
    if (!lines.some((l) => l.startsWith(`${t}:`))) errs.push(`missing trailer "${t}:"`);
  }
  return errs;
}

/**
 * Structural validation of a plan. `strict` additionally rejects TODO placeholders and
 * requires Files Affected / Commit Messages to be fully consistent.
 */
export function validatePlan(plan, { strict = true } = {}) {
  const errors = []; const warnings = [];
  if (!plan.fm) return { errors: ['missing front-matter'], warnings, files: {}, commits: {} };
  const sections = splitSections(plan.body);
  const kinds = sections.map((s) => sectionKind(s.title));
  const count = (k) => kinds.filter((x) => x === k).length;

  if (!/^#\s+\S/m.test(sections[0].lines.join('\n'))) warnings.push('plan has no "# Title" heading');
  for (const k of ['brief', 'files', 'commits']) {
    const name = SECTION[k === 'brief' ? 'BRIEF' : k === 'files' ? 'FILES' : 'COMMITS'];
    if (count(k) === 0) errors.push(`missing "## ${name}" section`);
    if (count(k) > 1) errors.push(`"## ${name}" appears ${count(k)} times — it must be moved, not duplicated`);
  }
  for (const k of ['questions', 'testing', 'feedback']) if (count(k) > 1) errors.push(`"## ${SECTION[k.toUpperCase()]}" appears more than once`);
  if (count('record') > 1) errors.push(`"## ${SECTION.RECORD}" appears ${count('record')} times`);
  if (count('record') && kinds[kinds.length - 1] !== 'record') errors.push(`"## ${SECTION.RECORD}" must be the final section`);

  // Ordering: Files Affected then Commit Messages must be the final two sections (ignoring one trailing
  // Archive Record); AI Feedback directly before them; Testing after the last brief/extension.
  const n = kinds.length - (kinds[kinds.length - 1] === 'record' ? 1 : 0);
  if (count('files') === 1 && count('commits') === 1 && !(kinds[n - 2] === 'files' && kinds[n - 1] === 'commits'))
    errors.push(`"## ${SECTION.FILES}" and "## ${SECTION.COMMITS}" must be the last two sections (run: plan.mjs normalise)`);
  const iBrief = kinds.indexOf('brief');
  const iLastExt = kinds.lastIndexOf('extension');
  const iTesting = kinds.indexOf('testing');
  const iFeedback = kinds.indexOf('feedback');
  const iQuestions = kinds.indexOf('questions');
  if (iLastExt !== -1 && iBrief > iLastExt) errors.push('"## Brief" must precede all plan extensions');
  if (iTesting !== -1 && iTesting < Math.max(iBrief, iLastExt)) errors.push('"## Testing" must sit beneath the latest brief / plan extension (run: plan.mjs normalise)');
  if (iQuestions !== -1 && (iQuestions < Math.max(iBrief, iLastExt) || (iTesting !== -1 && iQuestions > iTesting)))
    errors.push(`"## ${SECTION.QUESTIONS}" must sit beneath the latest brief / plan extension, above "## ${SECTION.TESTING}" (run: plan.mjs normalise)`);
  if (iFeedback !== -1 && iFeedback !== n - 3) errors.push('"## AI Feedback" must sit directly above "## Files Affected" (run: plan.mjs normalise)');

  if (strict) {
    sections.forEach((s) => {
      const t = s.lines.join('\n');
      if (/<!--\s*TODO/i.test(t)) errors.push(`section "${s.title || '(preamble)'}" still contains a <!-- TODO --> placeholder`);
    });
    const brief = sections.find((s) => sectionKind(s.title) === 'brief');
    if (brief && !stripComments(sectionText(brief)).trim()) errors.push('"## Brief" is empty');
    const lastExt = iLastExt !== -1 ? sections[iLastExt] : null;
    if (lastExt && !stripComments(sectionText(lastExt)).trim()) errors.push(`"## ${lastExt.title}" is empty`);
  }
  const questions = openQuestions(plan.body);
  if (questions.length) warnings.push(`${questions.length} outstanding question(s) for the human in "## ${SECTION.QUESTIONS}"`);

  const filesSec = sections.find((s) => sectionKind(s.title) === 'files');
  const commitsSec = sections.find((s) => sectionKind(s.title) === 'commits');
  const files = filesSec ? parseFilesAffected(sectionText(filesSec)) : {};
  const commits = commitsSec ? parseCommits(sectionText(commitsSec)) : {};
  const repos = repositories();

  for (const [repo, list] of Object.entries(files)) {
    if (!repos[repo]) errors.push(`Files Affected: unknown repository "${repo}" (known: ${Object.keys(repos).join(', ') || 'none'})`);
    if (!list.length) errors.push(`Files Affected: repository "${repo}" lists no files`);
    const seen = new Set();
    for (const f of list) { const k = normPath(f); if (seen.has(k)) errors.push(`Files Affected: "${f}" listed twice under ${repo}`); seen.add(k); }
  }
  if (strict && filesSec && !Object.keys(files).length) errors.push('Files Affected: no "### <repository>" sub-sections with file bullets');

  for (const [repo, list] of Object.entries(commits)) {
    if (!files[repo]) errors.push(`Commit Messages: repository "${repo}" has no Files Affected entry`);
    if (!list.length) errors.push(`Commit Messages: repository "${repo}" has no fenced commit message`);
    list.forEach((c, i) => validateCommitMessage(c.message).forEach((e) => errors.push(`Commit Messages: ${repo} #${i + 1}: ${e}`)));
    if (files[repo] && list.length > 1) {
      const all = new Set(files[repo].map(normPath)); const used = new Map();
      list.forEach((c, i) => {
        if (!c.files.length) errors.push(`Commit Messages: ${repo} has ${list.length} commits, so commit #${i + 1} must list its files as bullets above its message`);
        for (const f of c.files) {
          const k = normPath(f);
          if (!all.has(k)) errors.push(`Commit Messages: ${repo} #${i + 1} lists "${f}" which is not in Files Affected`);
          if (used.has(k)) errors.push(`Commit Messages: "${f}" is in both ${repo} #${used.get(k)} and #${i + 1}`);
          used.set(k, i + 1);
        }
      });
      for (const f of files[repo]) if (!used.has(normPath(f))) errors.push(`Commit Messages: ${repo} file "${f}" is not assigned to any commit`);
    } else if (files[repo] && list.length === 1 && list[0].files.length) {
      const want = new Set(files[repo].map(normPath));
      const got = new Set(list[0].files.map(normPath));
      if (want.size !== got.size || [...want].some((f) => !got.has(f))) errors.push(`Commit Messages: ${repo} single commit's file list differs from Files Affected (omit the list to commit all of them)`);
    }
  }
  for (const repo of Object.keys(files)) if (!commits[repo]) errors.push(`Commit Messages: no commit message for repository "${repo}"`);

  return { errors, warnings, files, commits };
}

/** Resolve the commits to make: [{repo, repoPath, message, files[]}] */
export function commitPlanFor(validation) {
  const repos = repositories(); const out = [];
  for (const [repo, list] of Object.entries(validation.commits)) {
    list.forEach((c, i) => out.push({
      repo, index: i + 1, repoPath: repos[repo], message: c.message,
      files: list.length === 1 ? validation.files[repo] : c.files,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archival options, manual commits and the Archive Record
// ---------------------------------------------------------------------------

/**
 * Parse the words after the plan name in `plan.mjs archive-begin <plan> ...`.
 * @returns {{allowUnlisted: boolean, requireListed: boolean, manualCommit: boolean, commitRefs: string[], errors: string[]}}
 */
export function parseArchiveOptions(args = []) {
  const o = { allowUnlisted: false, requireListed: false, manualCommit: false, commitRefs: [], errors: [] };
  for (const a of args.map((s) => String(s).trim()).filter(Boolean)) {
    if (a === '--allow-unlisted') o.allowUnlisted = true;
    else if (a === '--require-listed') o.requireListed = true;
    else if (a === '--manual-commit') o.manualCommit = true;
    else if (a.startsWith('-')) o.errors.push(`unknown option "${a}"`);
    else if (!o.manualCommit) o.errors.push(`"${a}" is not an option; a commit hash is only accepted after --manual-commit`);
    else if (a.includes('=') && !/^[A-Za-z0-9._-]+=[^=\s-][^=\s]*$/.test(a)) o.errors.push(`"${a}" is malformed; expected <repo>=<hash>`);
    else o.commitRefs.push(a);
  }
  if (o.manualCommit && o.allowUnlisted)
    o.errors.push('--manual-commit and --allow-unlisted cannot be combined (a manual-commit archival commits nothing, so unlisted changes do not matter)');
  if (o.allowUnlisted && o.requireListed) o.errors.push('--allow-unlisted and --require-listed cannot be combined');
  return o;
}

/**
 * Map `--manual-commit` refs onto the plan's repositories. A bare ref is allowed only for a one-repository plan.
 * @returns {{byRepo: Object<string, string|null>, errors: string[]}}  null = MISSING
 */
export function resolveManualCommits(refs, planRepos) {
  const byRepo = Object.fromEntries(planRepos.map((r) => [r, null])); const errors = [];
  for (const ref of refs) {
    const m = /^([^=]+)=(.+)$/.exec(ref);
    let repo; let hash;
    if (m) {
      [, repo, hash] = m;
      if (!Object.hasOwn(byRepo, repo)) { errors.push(`"${repo}" is not one of this plan's repositories (${planRepos.join(', ')})`); continue; }
    } else {
      if (planRepos.length !== 1) {
        errors.push(`the bare hash "${ref}" is ambiguous: this plan touches ${planRepos.length} repositories (${planRepos.join(', ')}); use <repo>=<hash>`);
        continue;
      }
      [repo] = planRepos; hash = ref;
    }
    if (byRepo[repo] !== null) { errors.push(`repository "${repo}" is given more than one hash`); continue; }
    byRepo[repo] = hash;
  }
  return { byRepo, errors };
}

/** Whether unlisted working-tree changes are tolerated: --require-listed > --allow-unlisted > config. */
export function effectiveAllowUnlisted({ allowUnlisted = false, requireListed = false } = {}, cfg = config()) {
  if (requireListed) return false;
  if (allowUnlisted) return true;
  return !!(cfg.archive && cfg.archive.allowUnlistedByDefault);
}

/** Human-readable state for a `git status --porcelain` code. */
export function porcelainState(code) {
  if (code === '??') return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A') || code.includes('C')) return 'added';
  return 'modified';
}

export const MISSING = 'MISSING';
export const MISSING_TEXT = 'MISSING — archived with --manual-commit and no commit hash given';

/**
 * Render the generated `## Archive Record` section.
 * entries: [{repo, index?, sha|null, subject?}]; leftUncommitted: [{repo, path, state}]; branches: {repo: branch}.
 */
export function archiveRecordSection({ mode, at, entries = [], warnings = [], leftUncommitted = [], branches = {} }) {
  const lines = [`## ${SECTION.RECORD}`, '',
    '<!-- Generated by archive-finish. -->', '',
    `- **Archived:** ${at}`,
    mode === 'manual'
      ? '- **Mode:** manual — committed by the human (`--manual-commit`); the workflow made no commit'
      : '- **Mode:** auto — committed by `archive-finish` with the planned messages'];
  const b = Object.entries(branches);
  if (b.length) lines.push(`- **Branches:** ${b.map(([r, br]) => `${r} \`${br}\``).join(', ')}`);
  lines.push('', '**Commits**', '');
  if (!entries.length) lines.push('- (none)');
  for (const e of entries) {
    const label = mode === 'manual' ? e.repo : `${e.repo} #${e.index}`;
    if (!e.sha) lines.push(`- ${label}: **${MISSING_TEXT}**`);
    else lines.push(`- ${label}: \`${e.sha}\`${e.subject ? ` ${e.subject}` : ''}`);
  }
  if (warnings.length) { lines.push('', '**Warnings**', ''); for (const w of warnings) lines.push(`- ${w}`); }
  if (leftUncommitted.length) {
    lines.push('', '**Left uncommitted (not in Files Affected)**', '');
    for (const f of leftUncommitted) lines.push(`- ${f.repo}: \`${f.path}\` (${f.state})`);
  }
  return lines.join('\n') + '\n';
}

/** The `## Archive Record` of a plan archived as part of the plan it was merged into. */
export function mergedRecordSection({ at, target, targetFile, commits = [] }) {
  const lines = [`## ${SECTION.RECORD}`, '',
    '<!-- Generated when the plan this one was merged into was archived. -->', '',
    `- **Archived:** ${at}`,
    `- **Merged into:** \`${target}\`${targetFile ? ` (${targetFile})` : ''}. This plan made no commits of its own;`,
    '  its work was committed with that plan.', '', `**Commits of ${target}**`, ''];
  if (!commits.length) lines.push('- (none recorded)');
  for (const c of commits) lines.push(`- \`${c}\``);
  return lines.join('\n') + '\n';
}

function groupByRepo(list) {
  const out = [];
  const repos = [...new Set(list.map((f) => f.repo))];
  for (const r of repos) {
    out.push(`  ${r}`);
    for (const f of list.filter((x) => x.repo === r)) out.push(`    ${f.state.padEnd(10)} ${f.path}`);
  }
  return out;
}

export const CLI = 'node .claude/workflow/plan.mjs';

/**
 * The grouped, actionable refusal printed when the working tree does not match the plan at archival.
 * The choices are human gates: the UI offers them, or the human runs them in their own terminal.
 * unlisted / unchanged: [{repo, path, state}]; other: plain messages; locked: an archival lock is held.
 */
export function formatTreeRefusal({ plan, unlisted = [], unchanged = [], other = [], locked = false }) {
  const lines = [locked
    ? `Archival of "${plan}" stopped before anything was committed. An archival lock is held: the AI must run\n` +
      `\`${CLI} archive-abort ${plan}\` before the human chooses again.`
    : `Archival of "${plan}" stopped before anything was committed or locked.`];
  if (unlisted.length) {
    lines.push('', 'Uncommitted changes that no active plan lists in Files Affected:', ...groupByRepo(unlisted), '',
      'Only the files in Files Affected are ever committed. The human chooses one:',
      '  - These belong to other work; leave them uncommitted and archive:',
      `      ${CLI} archive-begin ${plan} --allow-unlisted`,
      '  - They belong to this plan; send it back to add them:',
      `      ${CLI} rework ${plan} --feedback "add the unlisted files to Files Affected"`,
      '  - Commit them yourself instead and only record your commit:',
      `      ${CLI} archive-begin ${plan} --manual-commit <hash>`,
      '(To make leaving them uncommitted the default: config.json -> archive.allowUnlistedByDefault.)');
  }
  if (unchanged.length) {
    lines.push('', 'Files listed in the plan\'s Files Affected that have no uncommitted change:', ...groupByRepo(unchanged), '',
      'Every listed file must have a change to commit. The human chooses one:',
      '  - Send the plan back to correct its file list or finish the work:',
      `      ${CLI} rework ${plan} --feedback "<what to correct>"`,
      '  - Return the plan to planning:',
      `      ${CLI} cancel ${plan}`,
      '  - If the work was already committed by hand, only record that commit:',
      `      ${CLI} archive-begin ${plan} --manual-commit <hash>`);
  }
  if (other.length) { lines.push('', 'Other problems:'); for (const o of other) lines.push(`  - ${o}`); }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Repositories / git
// ---------------------------------------------------------------------------

export function repositories() {
  const cfg = config().repositories; const out = {};
  if (cfg.includeRoot && fs.existsSync(path.join(ROOT, '.git'))) out[cfg.rootName] = ROOT;
  if (cfg.autoDiscover) {
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(ROOT, e.name, '.git'))) out[e.name] = path.join(ROOT, e.name);
    }
  }
  for (const [name, rel] of Object.entries(cfg.map || {})) out[name] = abs(rel);
  return out;
}

export function git(repoPath, args, opts = {}) {
  const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trimEnd() };
}

/** The branch checked out in a worktree, or null when HEAD is detached. Works on a branch with no commits yet. */
export function currentBranch(repoPath) {
  const r = git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (r.code === 0 && r.out) return r.out;
  if (r.code === 1) return null; // detached
  throw new Error(`git symbolic-ref failed in ${repoPath}: ${r.err || `exit ${r.code}`}`);
}

/** `branches:` front-matter entries (`<worktree>=<branch>`) as an object. */
export function recordedBranches(plan) {
  const out = {};
  for (const e of plan.fm.branches || []) { const i = e.indexOf('='); if (i > 0) out[e.slice(0, i)] = e.slice(i + 1); }
  return out;
}

/**
 * Compare each worktree's checked-out branch with the one recorded when the plan was staged.
 * Returns { current: {repo: branch|null}, errors: [...] }. Worktrees with nothing recorded only need a branch.
 */
export function branchProblems(plan, repoNames) {
  const repos = repositories(); const rec = recordedBranches(plan); const current = {}; const errors = [];
  for (const repo of repoNames) {
    if (!repos[repo]) continue; // unknown worktrees are reported by validatePlan
    const cur = currentBranch(repos[repo]);
    current[repo] = cur;
    if (!cur) errors.push(`${repo}: HEAD is detached, so commits would not be on any branch. Check out ${rec[repo] ? `"${rec[repo]}"` : 'a branch'} in that worktree.`);
    else if (rec[repo] && rec[repo] !== cur) errors.push(`${repo}: on branch "${cur}", but the plan was staged on "${rec[repo]}". Switch the worktree back, or cancel and re-stage the plan.`);
  }
  return { current, errors };
}

/** Set `branches:` from `current`, keeping recorded entries unless `overwrite`. */
export function setBranches(plan, current, { overwrite = false } = {}) {
  const merged = overwrite ? {} : recordedBranches(plan);
  for (const [repo, br] of Object.entries(current)) if (br && (overwrite || !merged[repo])) merged[repo] = br;
  plan.fm.branches = Object.entries(merged).map(([r, b]) => `${r}=${b}`);
}

/** Changed paths (relative to repo, normalised) from `git status`. */
export function changedFiles(repoPath) {
  const r = git(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.code !== 0) throw new Error(`git status failed in ${repoPath}: ${r.err}`);
  const parts = r.out.split('\0').filter(Boolean); const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2); const p = parts[i].slice(3);
    out.push({ code, path: normPath(p), raw: p });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip rename source
  }
  return out;
}

export function stagedFiles(repoPath) {
  const r = git(repoPath, ['diff', '--cached', '--name-only', '-z']);
  return r.out.split('\0').filter(Boolean).map(normPath);
}

/** Paths that must never be counted as "unlisted changes" for a repo (workflow files, nested repos). */
export function ignoredForRepo(repoPath) {
  const cfg = config(); const ig = [];
  if (path.resolve(repoPath) === ROOT) {
    ig.push(cfg.plansDir, cfg.archiveDir, ...WORKFLOW_PATHS, path.relative(ROOT, path.dirname(WORKFLOW_DIR)));
    for (const [, p] of Object.entries(repositories())) if (p !== ROOT) ig.push(path.relative(ROOT, p));
  }
  return ig.map(normPath);
}


// ---------------------------------------------------------------------------
// Archive lock (one archival at a time across the workspace)
// ---------------------------------------------------------------------------

const lockFile = () => path.join(stateDir(), 'archive.lock.json');

function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

export const readLock = () => readJson(lockFile(), null);
export const clearLock = () => { try { fs.unlinkSync(lockFile()); } catch {} };

/**
 * Take the archive lock atomically: the file is created only if it does not exist yet, so of several simultaneous
 * callers exactly one wins. Returns null on success, or the holder's lock contents (possibly {}) when already held.
 */
export function acquireLock(v) {
  const f = lockFile();
  ensureDir(path.dirname(f));
  let fd;
  try { fd = fs.openSync(f, 'wx'); } catch (e) {
    if (e.code === 'EEXIST') return readJson(f, {}) || {};
    throw e;
  }
  try { fs.writeSync(fd, JSON.stringify(v, null, 2) + '\n'); } finally { fs.closeSync(fd); }
  return null;
}

// ---------------------------------------------------------------------------
// File ownership across plans. Each repository folder is one worktree, so two plans listing the same
// `### <worktree>` + path touch the same file in the same working tree.
// ---------------------------------------------------------------------------

/** Map of `<repo>:<normalised path>` -> `<repo>/<path as written>` for every file a plan lists (drafts too). */
export function planFiles(plan) {
  const m = new Map();
  for (const [repo, list] of Object.entries(validatePlan(plan, { strict: false }).files))
    for (const f of list) m.set(`${repo}:${normPath(f)}`, `${repo}/${f}`);
  return m;
}

/** Display paths of the files both maps (from planFiles) contain. */
export const sharedFiles = (a, b) => [...a.keys()].filter((k) => b.has(k)).map((k) => a.get(k));

/**
 * Other active plans that list any of this plan's files: [{plan, status, files: ['repo/path', ...]}].
 * `statuses` limits which other plans are considered.
 */
export function overlaps(plan, { statuses = null } = {}) {
  if (plan.fm?.merged_into) return [];
  const mine = planFiles(plan);
  return activePlans()
    .filter((o) => o.name !== plan.name && !o.fm.merged_into && (!statuses || statuses.includes(o.fm.status)))
    .map((o) => ({ plan: o.name, status: o.fm.status, files: sharedFiles(mine, planFiles(o)) }))
    .filter((o) => o.files.length);
}

/** `<repo>:<normalised path>` -> [plan names] for every active plan except `except`. */
export function claims({ except = null } = {}) {
  const out = new Map();
  for (const p of activePlans()) {
    if (p.name === except || p.fm.merged_into) continue;
    for (const k of planFiles(p).keys()) out.set(k, [...(out.get(k) || []), p.name]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function statusSummary() {
  const plans = activePlans();
  if (!plans.length) return 'No active plans.';
  return plans.map((p) => {
    const wts = Object.keys(validatePlan(p, { strict: false }).files);
    let s = `- ${p.name}: ${p.fm.status}${wts.length ? ` [${wts.join(', ')}]` : ''}`;
    if (p.fm.status === STATUS.STAGED && isPending(p)) s += ' (AWAITING HUMAN DECISION on a substantial deviation)';
    if (p.fm.merged_into) s += ` (merged into ${p.fm.merged_into}; archived with it)`;
    return s;
  }).join('\n');
}

const toSlash = (p) => p.replace(/\\/g, '/');

/** Machine-readable status for the UI (`plan.mjs status --json`). */
export function statusData() {
  return {
    root: ROOT,
    lock: readLock(),
    worktrees: Object.fromEntries(Object.entries(repositories()).map(([n, p]) => [n, toSlash(path.relative(ROOT, p)) || '.'])),
    plans: activePlans().map((p) => {
      const v = validatePlan(p, { strict: false });
      return {
        name: p.name, title: p.fm.title || p.name, status: p.fm.status, attempt: Number(p.fm.attempt || 0),
        pendingDecision: isPending(p), pendingSummary: p.fm.pending_summary || null,
        pendingDetail: pendingDeviation(p), branches: recordedBranches(p),
        file: toSlash(path.relative(ROOT, p.file)), created: p.fm.created || null, updated: p.fm.updated || null,
        worktrees: Object.keys(v.files), files: v.files, overlaps: overlaps(p), history: p.fm.history || [],
        openQuestions: openQuestions(p.body),
        mergedInto: p.fm.merged_into || null, mergedFrom: mergedSources(p.name).map((s) => s.name),
        mergeGaps: p.fm.merged_into ? [] : mergeGaps(p),
      };
    }),
  };
}
