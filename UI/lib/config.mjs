// UI configuration and workspace registry, stored in data/config.json (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export let DATA_DIR = process.env.PLAN_UI_DATA ? path.resolve(process.env.PLAN_UI_DATA) : path.join(UI_ROOT, 'data');
export const setDataDir = (d) => { DATA_DIR = path.resolve(d); _config = null; };
const configFile = () => path.join(DATA_DIR, 'config.json');

/**
 * Read-only git and the workflow CLI, allowed in every phase. Gate subcommands stay denied by the workspace.
 * Each command is allowed for both shell tools: on Windows, Claude Code also has a PowerShell tool, and a Bash(...)
 * rule does not cover it (checked with Claude Code 2.1.330).
 */
const READ_ONLY_GIT = ['status', 'diff', 'log', 'show', 'branch --show-current'];
const SHELL_COMMANDS = ['node .claude/workflow/plan.mjs', ...READ_ONLY_GIT.map((c) => `git ${c}`), 'git worktree list'];

/**
 * Read-only `git -C <worktree> …` rules for a workspace's worktrees. Permission rules only match a prefix, so
 * `git status:*` does not cover `git -C feature status`; these are generated per worktree when a run starts.
 */
export function worktreeGitRules(worktrees, root = null) {
  const forms = (w) => {
    const out = [w];
    if (root) {
      const abs = path.resolve(root, w);
      for (const p of new Set([abs, abs.replace(/\\/g, '/')])) out.push(p, `"${p}"`); // sessions often quote absolute paths
    }
    return [...new Set(out)];
  };
  return shellRules(worktrees.flatMap((w) => forms(w).flatMap((f) => [...READ_ONLY_GIT, 'rev-parse'].map((c) => `git -C ${f} ${c}`))));
}
export const shellRules = (commands) => commands.flatMap((c) => [`Bash(${c}:*)`, `PowerShell(${c}:*)`]);
const BASE_TOOLS = ['Read', 'Glob', 'Grep', ...shellRules(SHELL_COMMANDS)];

/**
 * Appended to every headless session's system prompt. Without it, a session that has one command refused (for
 * example a chain like `a; b`, which no prefix rule matches) tends to conclude it has no shell at all.
 */
export const HEADLESS_PROMPT = [
  'You are running headless from the plan workflow UI: nobody can answer permission prompts, and only allowlisted commands run.',
  'Run shell commands one at a time from the workspace root. Do not chain them with ;, && or |, and do not prefix them with cd.',
  'Run the workflow CLI exactly as `node .claude/workflow/plan.mjs <command> ...`. Use git -C <worktree> for git.',
  'If a command is denied, retry it once in its simplest single-command form before concluding it is unavailable.',
  'Use the Read, Glob, Grep, Edit and Write tools for file contents rather than shell commands.',
  'In implementation phases, move, copy and delete files with mv, cp, rm, mkdir (or Move-Item, Copy-Item, Remove-Item,',
  'New-Item in PowerShell), not git mv or git rm, and list both the old and the new path in Files Affected.',
].join(' ');
/** The prompt before file commands were allowed; a saved copy of it is replaced by the current one. */
const HEADLESS_PROMPT_V1 = HEADLESS_PROMPT.split(' In implementation phases,')[0].replace('for file contents', 'for files');
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];

/**
 * Moving, copying and deleting files, for the phases that change code. Edit/Write can't do these, and a session
 * without them can't finish a plan that renames or removes files. git mv / git rm stay denied by the workspace.
 */
const BASH_FILE_COMMANDS = ['mv', 'cp', 'rm', 'mkdir', 'rmdir'];
const PS_FILE_COMMANDS = ['Move-Item', 'Copy-Item', 'Remove-Item', 'New-Item', 'Rename-Item', 'mv', 'cp', 'rm', 'mkdir', 'rmdir', 'ren'];
export const FILE_TOOLS = [...BASH_FILE_COMMANDS.map((c) => `Bash(${c}:*)`), ...PS_FILE_COMMANDS.map((c) => `PowerShell(${c}:*)`)];
const CODE_PHASES = ['implement', 'continue', 'rework'];

/** Bumped when the defaults change in a way saved configs should pick up (see migrate). */
const CONFIG_VERSION = 2;

/**
 * Phases: the slash command each runs and the permissions its headless session gets.
 * permissionMode is passed to `claude --permission-mode`; allowedTools to `--allowedTools`.
 * "dontAsk" refuses anything not allowed instead of waiting for an answer no one can give.
 */
export const DEFAULT_PHASES = {
  new:       { command: 'plan-new',       label: 'Write plan',        permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS] },
  amend:     { command: 'plan-amend',     label: 'Amend plan',        permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS] },
  implement: { command: 'plan-implement', label: 'Implement',         permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS, ...FILE_TOOLS] },
  continue:  { command: 'plan-continue',  label: 'Continue',          permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS, ...FILE_TOOLS] },
  rework:    { command: 'plan-rework',    label: 'Rework',            permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS, ...FILE_TOOLS] },
  cancel:    { command: 'plan-cancel',    label: 'Write extension',   permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS] },
  archive:   { command: 'plan-archive',   label: 'Reconcile + archive', permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS] },
  merge:     { command: 'plan-merge',     label: 'Fold merged plans', permissionMode: 'dontAsk', allowedTools: [...BASE_TOOLS, ...EDIT_TOOLS] },
};

const DEFAULTS = {
  claudeCommand: 'claude',
  model: null,
  appendSystemPrompt: HEADLESS_PROMPT,
  pollSeconds: 3,
  workspaces: [],
  phases: DEFAULT_PHASES,
};

let _config = null;

export function loadConfig() {
  if (_config) return _config;
  let user = {};
  try { user = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Invalid ${configFile()}: ${e.message}`);
  }
  if (Object.keys(user).length && (user.configVersion || 1) < CONFIG_VERSION) {
    user = migrate(user);
    try { writeConfigFile(user); } catch {} // persist the upgrade; it is re-applied on the next load if this fails
  }
  _config = {
    ...DEFAULTS, ...user, configVersion: CONFIG_VERSION,
    workspaces: Array.isArray(user.workspaces) ? user.workspaces : [],
    phases: Object.fromEntries(Object.entries(DEFAULT_PHASES).map(([k, v]) => [k, { ...v, ...(user.phases || {})[k] }])),
  };
  return _config;
}

/**
 * Bring a config saved by an older version up to date. Saved configs hold full phase lists, so new default
 * permissions would otherwise never reach them. Additions only: nothing the user added or removed is undone.
 *   v2: implement/continue/rework may move, copy and delete files; the appended prompt says how.
 */
export function migrate(user) {
  const out = { ...user, phases: { ...(user.phases || {}) } };
  if ((user.configVersion || 1) < 2) {
    for (const k of CODE_PHASES) {
      const ph = out.phases[k];
      if (ph && Array.isArray(ph.allowedTools)) out.phases[k] = { ...ph, allowedTools: [...new Set([...ph.allowedTools, ...FILE_TOOLS])] };
    }
    if (out.appendSystemPrompt === HEADLESS_PROMPT_V1) out.appendSystemPrompt = HEADLESS_PROMPT;
  }
  out.configVersion = CONFIG_VERSION;
  return out;
}

function writeConfigFile(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${configFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, configFile());
}

export function saveConfig(cfg) {
  writeConfigFile({ ...cfg, configVersion: CONFIG_VERSION });
  _config = null;
  return loadConfig();
}

/** Replace the editable settings (everything except the workspace list), validating phase entries. */
export function updateSettings(patch) {
  const cfg = loadConfig();
  const next = { ...cfg };
  if ('claudeCommand' in patch) {
    const c = patch.claudeCommand;
    next.claudeCommand = Array.isArray(c) && c.length ? c.map(String) : String(c || 'claude');
  }
  if ('model' in patch) next.model = patch.model ? String(patch.model) : null;
  if ('appendSystemPrompt' in patch) next.appendSystemPrompt = String(patch.appendSystemPrompt || '');
  if ('pollSeconds' in patch) next.pollSeconds = Math.max(1, Number(patch.pollSeconds) || 3);
  if (patch.phases) {
    for (const [k, v] of Object.entries(patch.phases)) {
      if (!DEFAULT_PHASES[k]) throw new Error(`Unknown phase "${k}"`);
      if (v.allowedTools && !Array.isArray(v.allowedTools)) throw new Error(`phases.${k}.allowedTools must be a list`);
      next.phases[k] = { ...next.phases[k], ...v, command: DEFAULT_PHASES[k].command };
    }
  }
  return saveConfig(next);
}

const SHELL_RULE = /^(Bash|PowerShell)\([A-Za-z0-9][\w.+ -]{0,99}:\*\)$/;
function checkShellRules(rules, { required = false } = {}) {
  const list = [...new Set([].concat(rules || []).map((r) => String(r).trim()).filter(Boolean))];
  if (required && !list.length) throw Object.assign(new Error('Choose at least one rule.'), { status: 400 });
  for (const r of list) if (!SHELL_RULE.test(r)) throw Object.assign(new Error(`Not a shell prefix rule: ${r}`), { status: 400 });
  return list;
}

/**
 * A workspace's own allow rules, added to every phase run in it (e.g. its build and test commands). Kept in the
 * UI's config rather than the workspace's .claude/settings.json, so they apply whether or not Claude Code trusts
 * the folder and leave the project's files alone. `mode` 'add' merges; 'replace' sets the list (Workspaces page).
 */
export function setWorkspaceRules(id, rules, mode = 'add') {
  const cfg = loadConfig();
  const ws = cfg.workspaces.find((w) => w.id === id);
  if (!ws) throw Object.assign(new Error('Unknown workspace.'), { status: 404 });
  const list = checkShellRules(rules, { required: mode === 'add' });
  const allowedTools = mode === 'add' ? [...new Set([...(ws.allowedTools || []), ...list])] : list;
  saveConfig({ ...cfg, workspaces: cfg.workspaces.map((w) => (w.id === id ? { ...w, allowedTools } : w)) });
  return allowedTools;
}

/**
 * Add shell allow rules to a phase, e.g. after a run had `dotnet test` refused. Only plain prefix rules for the
 * two shell tools are accepted here; anything else goes through the Settings page.
 */
export function allowForPhase(phaseKey, rules) {
  const cfg = loadConfig();
  if (!cfg.phases[phaseKey]) throw Object.assign(new Error(`Unknown phase "${phaseKey}"`), { status: 400 });
  const list = checkShellRules(rules, { required: true });
  const ph = cfg.phases[phaseKey];
  return updateSettings({ phases: { [phaseKey]: { allowedTools: [...new Set([...(ph.allowedTools || []), ...list])] } } });
}

export const isWorkspace =(p) => fs.existsSync(path.join(p, '.claude', 'workflow', 'plan.mjs'));

/**
 * The canonical long form of an existing folder. On Windows this expands 8.3 short names (C:\Users\GEEKAN~1 ->
 * C:\Users\GeeKandaa). This matters: Claude Code refuses Edit/Write on files addressed through a short-name path,
 * and a session builds its file paths from the folder it was started in.
 */
export function canonicalDir(p) {
  try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); }
}

export function addWorkspace(dir, name) {
  const abs = canonicalDir(String(dir || '') || '.');
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!dir || !isWorkspace(abs)) throw bad(`${abs} is not a deployed workspace (no .claude/workflow/plan.mjs).`);
  const cfg = loadConfig();
  if (cfg.workspaces.some((w) => canonicalDir(w.path).toLowerCase() === abs.toLowerCase())) throw bad('That workspace is already registered.');
  const ws = { id: crypto.randomBytes(4).toString('hex'), name: String(name || path.basename(abs)), path: abs };
  saveConfig({ ...cfg, workspaces: [...cfg.workspaces, ws] });
  return ws;
}

export function removeWorkspace(id) {
  const cfg = loadConfig();
  if (!cfg.workspaces.some((w) => w.id === id)) throw new Error('Unknown workspace.');
  saveConfig({ ...cfg, workspaces: cfg.workspaces.filter((w) => w.id !== id) });
}

/** A registered workspace, with its path in canonical long form (entries saved by older versions may be short). */
export function getWorkspace(id) {
  const ws = loadConfig().workspaces.find((w) => w.id === id);
  if (!ws) { const e = new Error('Unknown workspace.'); e.status = 404; throw e; }
  return { ...ws, path: canonicalDir(ws.path) };
}
