#!/usr/bin/env node
// Plan lifecycle CLI. Every status change goes through this script so transitions are deterministic.
// Human gates (stage, continue, cancel, rework, archive-begin) are run by the UI or by the human; settings.json
// denies them to the AI.
//   node .claude/workflow/plan.mjs help
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const { STATUS, SECTION, CLI } = L;

const HELP = `Plan workflow — ${CLI} <command> [args]

AI and human:
  status [plan] [--json]        Active plans (or one plan's state); --json is the UI's machine-readable view
  repos                         Worktree folders usable in "### <worktree>" headings
  new <slug> --title "<title>"  Create plans/<slug>.md in the planning phase
  validate <plan>               Check structure, commit messages and file lists
  normalise <plan>              Move Testing / AI Feedback / Files / Commits to their canonical place
  overlaps <plan>               Files this plan shares with other active plans, and their uncommitted state
  note <plan> "<text>"          Record a MINOR deviation under "## AI Feedback" (staged only)
  deviate <plan> "<summary>"    Flag a SUBSTANTIAL deviation; implementation pauses until the human decides
  complete <plan> [--allow-unlisted]
                                End implementation: staged -> confirmation (validates plan vs. working tree).
                                Changes listed by other active plans are attributed to them, not flagged
  archive-finish <plan> --plans-reviewed
                                After archive-begin: commit (none in manual-commit mode), append the
                                "## Archive Record", then prefix + move the plan to the archive
  archive-abort <plan>          Release an archival lock; the plan stays in confirmation

Human gates (run by the UI, or by the human in their own terminal; denied to the AI in settings.json):
  stage <plan>                  planning -> staged. Refused while another staged plan lists any of its files
  continue <plan> [--decision "<text>"]
                                Approve a pending substantial deviation, with the option chosen or any
                                conditions (recorded under AI Feedback for the AI to follow)
  cancel <plan>                 staged|confirmation -> planning (adds a Plan Extension for the AI to write)
  rework <plan> --feedback "<text>"
                                confirmation -> staged with the human's feedback recorded
  archive-begin <plan> [--allow-unlisted | --require-listed | --manual-commit [<hash> | <worktree>=<hash> ...]]
                                Accept the work: check the working tree, take the archive lock and list files
                                shared with other plans for the AI to reconcile before archive-finish
  merge <into> <plan> [<plan> ...]
                                Merge plans into <into> (all planning, or all confirmation). They stay in plans/
                                and are archived with <into>; the AI folds them in (/plan-merge <into>). If <into>
                                is already archived, the plans are archived at once with a note of the merge
  unmerge <plan>                Undo a merge that hasn't been archived yet
`;

// ---------------------------------------------------------------------------

const VALUE_FLAGS = ['title', 'feedback', 'decision'];

function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && VALUE_FLAGS.includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
const rel = (p) => path.relative(L.ROOT, p).replace(/\\/g, '/');
const out = (...a) => console.log(...a);

function requireStatus(plan, ...allowed) {
  if (plan.fm.merged_into)
    fail(`Plan "${plan.name}" is merged into "${plan.fm.merged_into}" and is archived with it. To act on it alone, the human runs: unmerge ${plan.name}`);
  if (!allowed.includes(plan.fm.status))
    fail(`Plan "${plan.name}" is "${plan.fm.status}"; this command needs: ${allowed.join(' or ')}.`);
}

/** Refuse when another staged plan lists any of this plan's files: two implementations would edit one file at once. */
function requireNoStagedOverlap(plan) {
  const clash = L.overlaps(plan, { statuses: [STATUS.STAGED] });
  if (clash.length) fail(`"${plan.name}" shares files with plans already in implementation:\n` +
    clash.map((o) => `  - ${o.plan}: ${o.files.join(', ')}`).join('\n') +
    '\nComplete those plans first, or remove the overlap from one of the plans.');
  for (const o of L.overlaps(plan, { statuses: [STATUS.PLANNING, STATUS.CONFIRMATION] }))
    out(`  note: shares files with ${o.plan} (${o.status}): ${o.files.join(', ')}`);
}

/**
 * Refuse when a worktree's HEAD is detached or it has switched away from the branch recorded at stage.
 * Returns the current branch per worktree. Pass `{ fresh: true }` to ignore recorded branches (staging anew).
 */
function requireBranches(p, repoNames, what, { fresh = false, hint = '' } = {}) {
  const b = L.branchProblems(fresh ? { fm: {} } : p, repoNames);
  if (b.errors.length) fail(`${what} refused by the branch check:\n${b.errors.map((e) => `  - ${e}`).join('\n')}${hint ? `\n${hint}` : ''}`);
  return b.current;
}

function printValidation(v, label = 'Validation') {
  for (const w of v.warnings) out(`  warning: ${w}`);
  if (v.errors.length) { out(`${label} failed:`); for (const e of v.errors) out(`  - ${e}`); }
}

function feedbackEntry(plan, text) {
  const sections = L.splitSections(plan.body);
  let fb = sections.find((s) => L.sectionKind(s.title) === 'feedback');
  if (!fb) { fb = { title: SECTION.FEEDBACK, lines: [`## ${SECTION.FEEDBACK}`, ''] }; sections.push(fb); }
  while (fb.lines.length && !fb.lines[fb.lines.length - 1].trim()) fb.lines.pop();
  if (fb.lines.length === 1 || !/^\s*[-*]\s/.test(fb.lines[fb.lines.length - 1])) fb.lines.push('');
  // Continuation lines are indented so multi-line text (e.g. numbered options) stays inside this entry's bullet.
  fb.lines.push(`- **${L.nowHuman()} · attempt ${plan.fm.attempt || 1}** — ${text.trim().replace(/\r?\n/g, '\n  ')}`);
  return L.normaliseSections(sections);
}

/**
 * Compare the plan's Files Affected with each worktree's working tree.
 * Returns flat messages (errors / warnings / unlisted) plus structured lists for formatTreeRefusal:
 * unlistedFiles and unchangedFiles as [{repo, path, state}], ownedFiles (changed, not listed here but listed by
 * another active plan) as [{repo, path, state, owners}], and otherErrors for anything else.
 */
function workingTreeCheck(v, { planName = null, allowUnlisted = false, skip = new Set() } = {}) {
  const errors = []; const warnings = []; const unlisted = []; const repos = L.repositories();
  const unlistedFiles = []; const unchangedFiles = []; const ownedFiles = []; const otherErrors = [];
  const claimed = L.claims({ except: planName });
  for (const [repo, list] of Object.entries(v.files)) {
    const repoPath = repos[repo]; if (!repoPath) continue;
    let changed;
    try { changed = L.changedFiles(repoPath); } catch (e) { errors.push(e.message); otherErrors.push(e.message); continue; }
    const ignore = L.ignoredForRepo(repoPath);
    const changedSet = new Set(changed.map((c) => c.path));
    const listed = new Set(list.map(L.normPath));
    for (const f of list) if (!skip.has(`${repo}:${L.normPath(f)}`) && !changedSet.has(L.normPath(f))) {
      errors.push(`${repo}: "${f}" is listed in Files Affected but has no uncommitted change`);
      unchangedFiles.push({ repo, path: f, state: 'unchanged' });
    }
    for (const c of changed.filter((c) => !listed.has(c.path) && !ignore.some((i) => L.isUnder(c.path, i)))) {
      const owners = claimed.get(`${repo}:${c.path}`);
      if (owners) {
        warnings.push(`${repo}: "${c.raw}" changed; it belongs to ${owners.join(', ')} (left uncommitted)`);
        ownedFiles.push({ repo, path: c.raw, state: L.porcelainState(c.code), owners });
        continue;
      }
      const msg = `${repo}: "${c.raw}" changed but no active plan lists it in Files Affected`;
      (allowUnlisted ? warnings : errors).push(msg);
      unlisted.push(msg);
      unlistedFiles.push({ repo, path: c.raw, state: L.porcelainState(c.code) });
    }
  }
  return { errors, warnings, unlisted, unlistedFiles, unchangedFiles, ownedFiles, otherErrors };
}

/** Guidance printed by complete when changes no plan lists block it. */
const UNLISTED_HELP = [
  'For each change no plan lists, work out where it came from:',
  "  - Generated by this plan's work (a build, code generator, package manager, formatter, test snapshots) and",
  '    meant to be committed: add it to Files Affected with the note "— generated by <command>", add it to the',
  '    right commit, and record it with `note`.',
  '  - Build output that should not be committed: leave it unlisted and tell the human it probably belongs in',
  '    .gitignore.',
  "  - Not from this plan's work: re-run complete with --allow-unlisted and say which files and why.",
].join('\n');

/** Changed files in worktrees this plan doesn't list that no other active plan lists either (warnings only). */
function unlistedElsewhere(v, planName) {
  const claimed = L.claims({ except: planName }); const found = [];
  for (const [repo, repoPath] of Object.entries(L.repositories())) {
    if (v.files[repo]) continue;
    let changed; try { changed = L.changedFiles(repoPath); } catch { continue; }
    const ignore = L.ignoredForRepo(repoPath);
    for (const c of changed) {
      if (ignore.some((i) => L.isUnder(c.path, i)) || claimed.get(`${repo}:${c.path}`)) continue;
      found.push({ repo, path: c.raw, state: L.porcelainState(c.code) });
    }
  }
  return found;
}

/** Archive a plan that was merged into `target` (already archived, or being archived now). Returns a status line. */
function archiveMerged(m, { target, targetFile, commits, at = L.nowIso(), prefix = L.formatDate(L.config().archivePrefixFormat) }) {
  let dest = path.join(L.ensureDir(L.archiveDir()), `${prefix}${m.name}.md`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(L.archiveDir(), `${prefix}${m.name}-${i}.md`);
  const from = m.fm.status;
  m.fm.merged_into = target;
  m.fm.status = STATUS.ARCHIVED;
  m.fm.archived_at = at;
  m.fm.archive_file = rel(dest);
  L.addHistory(m, `${from} -> archived (merged into ${target})`);
  const body = L.joinSections(feedbackEntry(m, `**Archived as part of ${target}**, which it was merged into.`));
  L.writePlan(m, `${body.replace(/\s+$/, '')}\n\n${L.mergedRecordSection({ at, target, targetFile, commits })}`);
  fs.renameSync(m.file, dest);
  return `${m.name} ARCHIVED (merged into ${target}) -> ${rel(dest)}`;
}

/** The grouped refusal for a failed working-tree check (unlisted files count only when they are not allowed). */
function treeRefusal(plan, wt, { allowUnlisted, locked, extra = [] }) {
  return L.formatTreeRefusal({
    plan: plan.name, locked,
    unlisted: allowUnlisted ? [] : wt.unlistedFiles,
    unchanged: wt.unchangedFiles,
    other: [...wt.otherErrors, ...extra],
  });
}

/** Worktree names in the plan's Files Affected. */
const planRepos = (v) => Object.keys(v.files);

/** Lines describing the files a plan shares with other active plans, with each file's uncommitted state. */
function overlapReport(p) {
  const list = L.overlaps(p);
  if (!list.length) return [];
  const repos = L.repositories(); const states = {};
  const stateOf = (repoPath) => {
    if (!(repoPath in states)) {
      try { states[repoPath] = new Map(L.changedFiles(repoPath).map((c) => [c.path, L.porcelainState(c.code)])); }
      catch { states[repoPath] = new Map(); }
    }
    return states[repoPath];
  };
  const lines = [];
  for (const o of list) {
    lines.push(`  - ${o.plan} (${o.status})`);
    for (const f of o.files) {
      const i = f.indexOf('/'); const repo = f.slice(0, i); const file = f.slice(i + 1);
      const st = repos[repo] ? stateOf(repos[repo]).get(L.normPath(file)) : null;
      lines.push(`      ${(st || 'clean').padEnd(10)} ${f}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
  help() { out(HELP); },

  status([ref], flags) {
    if (flags.json) {
      const data = L.statusData();
      out(JSON.stringify(ref ? { ...data, plans: data.plans.filter((p) => p.name === ref) } : data, null, 2));
      return;
    }
    if (ref) {
      const p = L.findPlan(ref);
      out(`${p.name}: ${p.fm.status}${L.isPending(p) ? ' (awaiting human decision)' : ''}`);
      if (L.isPending(p)) out(`Pending deviation: ${p.fm.pending_summary || ''}`);
      for (const h of p.fm.history || []) out(`  ${h}`);
      const lock = L.readLock(); if (lock && lock.plan === p.name) out('Archival in progress.');
      return;
    }
    out(L.statusSummary());
    const lock = L.readLock(); if (lock) out(`Archival in progress for: ${lock.plan}`);
  },

  repos() {
    const r = L.repositories();
    if (!Object.keys(r).length) out('No worktrees found. Add git worktrees as sub-folders of the workspace root or set "repositories.map" in .claude/workflow/config.json.');
    for (const [n, p] of Object.entries(r)) out(`${n}\t${rel(p) || '.'}`);
  },

  new([slug], flags) {
    if (!slug || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) fail('Usage: new <slug> --title "<title>"   (slug: lowercase letters, digits, hyphens)');
    const file = path.join(L.ensureDir(L.plansDir()), `${slug}.md`);
    if (fs.existsSync(file)) fail(`${rel(file)} already exists.`);
    if (L.listPlans({ includeArchived: true }).some((p) => p.fm.id === slug)) fail(`An archived plan already uses the id "${slug}". Pick another slug.`);
    const title = typeof flags.title === 'string' ? flags.title : slug.replace(/-/g, ' ');
    const tpl = fs.readFileSync(path.join(L.WORKFLOW_DIR, 'plan-template.md'), 'utf8').replace(/\{\{TITLE\}\}/g, title);
    const plan = { file, name: slug, fm: { id: slug, title, status: STATUS.PLANNING, attempt: '0', created: L.nowIso() } };
    L.addHistory(plan, 'created -> planning');
    L.writePlan(plan, tpl);
    out(`Created ${rel(file)} (planning). Replace every <!-- TODO --> block, then run: validate ${slug}`);
  },

  validate([ref]) {
    const p = L.findPlan(ref);
    const v = L.validatePlan(p);
    printValidation(v);
    for (const o of L.overlaps(p)) out(`  note: shares files with ${o.plan} (${o.status}): ${o.files.join(', ')}`);
    if (p.fm.merged_into) out(`  note: merged into ${p.fm.merged_into}; it is archived with that plan.`);
    for (const g of L.mergeGaps(p)) out(`  warning: merged plan ${g.plan} lists files this plan doesn't (fold them in before archival): ${g.files.join(', ')}`);
    if (v.errors.length) process.exitCode = 1; else out(`${p.name}: valid.`);
  },

  normalise([ref]) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.PLANNING, STATUS.STAGED, STATUS.CONFIRMATION);
    const lock = L.readLock(); if (lock && lock.plan === p.name) fail('Plan is being archived; it can no longer change.');
    L.writePlan(p, L.joinSections(L.normaliseSections(L.splitSections(p.body))));
    out(`${p.name}: sections normalised.`);
  },

  overlaps([ref]) {
    const p = L.findPlan(ref);
    const lines = overlapReport(p);
    if (!lines.length) out(`${p.name}: shares no files with other active plans.`);
    else { out(`${p.name} shares files with:`); for (const l of lines) out(l); }
  },

  note([ref, ...text]) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.STAGED);
    if (!text.join(' ').trim()) fail('Usage: note <plan> "<what changed and why>"');
    L.writePlan(p, L.joinSections(feedbackEntry(p, `Minor deviation: ${text.join(' ')}`)));
    out(`Noted under "## ${SECTION.FEEDBACK}".`);
  },

  deviate([ref, ...text]) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.STAGED);
    if (L.isPending(p)) fail('A deviation is already awaiting the human\'s decision.');
    const summary = text.join(' ').trim();
    if (!summary) fail('Usage: deviate <plan> "<what must change, why, and the impact>"');
    p.fm.pending_decision = 'true';
    p.fm.pending_summary = summary.replace(/\s+/g, ' ').slice(0, 300);
    L.addHistory(p, 'substantial deviation raised; awaiting human');
    L.writePlan(p, L.joinSections(feedbackEntry(p, `${L.DEVIATION_MARK} ${summary}`)));
    out('Implementation is PAUSED. Explain the deviation to the human, then stop and wait for them to');
    out(`approve it (continue ${p.name}) or cancel the implementation (cancel ${p.name}).`);
  },

  complete([ref], flags) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.STAGED);
    if (L.isPending(p)) fail('A substantial deviation is awaiting the human\'s decision.');
    let body = L.joinSections(L.normaliseSections(L.splitSections(p.body)));
    const v = L.validatePlan({ ...p, body });
    const byConfig = !flags['allow-unlisted'] && L.effectiveAllowUnlisted({}, L.config());
    const allowUnlisted = !!flags['allow-unlisted'] || byConfig;
    const wt = workingTreeCheck(v, { planName: p.name, allowUnlisted });
    printValidation(v);
    for (const w of wt.warnings) out(`  warning: ${w}`);
    if (wt.errors.length) { out('Plan does not match the working tree:'); for (const e of wt.errors) out(`  - ${e}`); }
    if (wt.unlistedFiles.length && !allowUnlisted) out(UNLISTED_HELP);
    const elsewhere = unlistedElsewhere(v, p.name);
    for (const f of elsewhere) out(`  warning: ${f.repo}: "${f.path}" changed (${f.state}); no active plan lists it and this plan doesn't list the ${f.repo} worktree`);
    if (elsewhere.length) out('  If your work generated any of these, add them to Files Affected (with their worktree) before completing.');
    if (v.errors.length || wt.errors.length)
      fail('Update the plan (Files Affected / Commit Messages, and note amendments under AI Feedback) so it reflects the work actually done, then re-run complete.');
    const branches = requireBranches(p, planRepos(v), 'complete',
      { hint: 'Do not switch branches yourself: tell the human, who can switch the worktree back or cancel the plan.' });
    L.setBranches(p, branches); // worktrees added to Files Affected during implementation
    if (wt.unlisted.length) { // unlisted changes were allowed: make them visible to the human at confirmation
      const how = byConfig ? 'archive.allowUnlistedByDefault' : '--allow-unlisted';
      body = L.joinSections(feedbackEntry({ ...p, body }, `Completed with ${how}; left uncommitted and outside every plan: ${wt.unlisted.join('; ')}`));
    }
    // Files Affected may have grown during implementation: surface any new overlap with plans still being implemented.
    const clash = L.overlaps({ ...p, body }, { statuses: [STATUS.STAGED] });
    if (clash.length) {
      const text = clash.map((o) => `${o.plan}: ${o.files.join(', ')}`).join('; ');
      out(`  warning: shares files with plans still in implementation — ${text}`);
      body = L.joinSections(feedbackEntry({ ...p, body }, `**Shares files with plans still in implementation:** ${text}. Reconcile at archival.`));
    }
    p.fm.status = STATUS.CONFIRMATION;
    p.fm.completed_at = L.nowIso();
    L.addHistory(p, 'staged -> confirmation');
    L.writePlan(p, body);
    out(`${p.name} is awaiting CONFIRMATION. Summarise the changes and testing steps for the human, then stop.`);
    out('The human accepts (archive-begin), sends it back with feedback (rework) or cancels it (cancel).');
  },

  // --- human gates ----------------------------------------------------------

  stage([ref]) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.PLANNING);
    const v = L.validatePlan(p);
    if (v.errors.length) { printValidation(v); fail('Fix the plan before staging.'); }
    requireNoStagedOverlap(p);
    const branches = requireBranches(p, planRepos(v), 'Staging', { fresh: true });
    L.setBranches(p, branches, { overwrite: true });
    const questions = L.openQuestions(p.body);
    if (questions.length) out(`  warning: staged with ${questions.length} outstanding question(s) unanswered; the AI will use its own judgement on them.`);
    p.fm.status = STATUS.STAGED;
    p.fm.attempt = String(Number(p.fm.attempt || 0) + 1);
    p.fm.staged_at = L.nowIso();
    delete p.fm.pending_decision; delete p.fm.pending_summary;
    L.addHistory(p, `planning -> staged (human approved, attempt ${p.fm.attempt})`);
    L.writePlan(p);
    out(`${p.name} is STAGED (attempt ${p.fm.attempt}) on ${Object.entries(branches).map(([r, b]) => `${r} "${b}"`).join(', ')}. Implement exactly what the plan describes.`);
    out('Minor deviations: plan.mjs note. Substantial deviations: plan.mjs deviate, then stop and ask the human.');
    out('When done: plan.mjs complete ' + p.name);
  },

  continue([ref, ...rest], flags) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.STAGED);
    if (!L.isPending(p)) fail('No deviation is awaiting a decision.');
    // The human's choice among the options the deviation offered, or any conditions on the approval.
    const decision = String(typeof flags.decision === 'string' ? flags.decision : rest.join(' ')).replace(/\s+/g, ' ').trim().slice(0, 4000);
    const summary = p.fm.pending_summary || '';
    delete p.fm.pending_decision; delete p.fm.pending_summary;
    L.addHistory(p, decision ? 'substantial deviation approved by human, with a decision' : 'substantial deviation approved by human');
    L.writePlan(p, L.joinSections(feedbackEntry(p, `**Deviation approved by human:** ${summary}` +
      (decision ? ` **Human's decision (follow this over any recommendation):** ${decision}` : ''))));
    out('Deviation approved. Continue implementing; update Files Affected / Commit Messages before completing.');
    if (decision) out(`Human's decision: ${decision}`);
  },

  cancel([ref]) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.STAGED, STATUS.CONFIRMATION);
    const lock = L.readLock(); if (lock && lock.plan === p.name) fail('Plan is being archived; run archive-abort first.');
    const from = p.fm.status;
    let sections = feedbackEntry(p, `Implementation cancelled by the human (from ${from}). Continued in a new plan extension.`);
    const n = sections.filter((s) => L.sectionKind(s.title) === 'extension').length + 1;
    const title = `${SECTION.EXTENSION} ${n} — ${L.nowHuman()}`;
    const ext = { title, lines: [`## ${title}`, '',
      `<!-- TODO: Detailed brief of the CURRENT STATE of implementation (what is done, in which files/worktrees,`,
      `what works, what was abandoned and why) and what is YET TO DO, with the approach for the remaining work. -->`] };
    const flag = `<!-- TODO: review/update this section for ${SECTION.EXTENSION} ${n}, then delete this comment. -->`;
    for (const [kind, name] of [['questions', SECTION.QUESTIONS], ['testing', SECTION.TESTING]])
      if (!sections.some((s) => L.sectionKind(s.title) === kind)) sections.push({ title: name, lines: [`## ${name}`, ''] });
    for (const s of sections) if (['questions', 'testing', 'files', 'commits'].includes(L.sectionKind(s.title))) s.lines.splice(1, 0, '', flag);
    sections = L.normaliseSections(sections, [ext]);
    p.fm.status = STATUS.PLANNING;
    delete p.fm.pending_decision; delete p.fm.pending_summary;
    L.addHistory(p, `${from} -> planning (cancelled by human; ${SECTION.EXTENSION} ${n} added)`);
    L.writePlan(p, L.joinSections(sections));
    out(`${p.name} is back in PLANNING with "## ${title}".`);
    out('Next (AI): write the extension brief (state of implementation + what is left), update Testing, Files Affected');
    out('and Commit Messages beneath it, remove the TODO comments, run validate, and present the plan to the human.');
    out('Uncommitted code changes from the attempt are left in place in the worktrees.');
  },

  rework([ref], flags) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.CONFIRMATION);
    const lock = L.readLock(); if (lock && lock.plan === p.name) fail('Plan is being archived; run archive-abort first.');
    requireNoStagedOverlap(p);
    L.setBranches(p, requireBranches(p, planRepos(L.validatePlan(p, { strict: false })), 'Rework'));
    const feedback = typeof flags.feedback === 'string' && flags.feedback.trim() ? flags.feedback.trim() : '(none given)';
    p.fm.status = STATUS.STAGED;
    p.fm.attempt = String(Number(p.fm.attempt || 0) + 1);
    p.fm.staged_at = L.nowIso();
    L.addHistory(p, `confirmation -> staged (rework requested, attempt ${p.fm.attempt})`);
    L.writePlan(p, L.joinSections(feedbackEntry(p, `**Human rework feedback:** ${feedback}`)));
    out(`${p.name} is STAGED again for rework. Human feedback: ${feedback}`);
  },

  'archive-begin'([ref], _flags, raw) {
    const p = L.findPlan(ref);
    requireStatus(p, STATUS.CONFIRMATION);
    const lock = L.readLock(); if (lock) fail(`Archival of "${lock.plan}" is already in progress.`);
    const v = L.validatePlan(p);
    if (v.errors.length) { printValidation(v); fail('The plan is invalid; it cannot be archived.'); }

    const gaps = L.mergeGaps(p);
    if (gaps.length) fail(`Plans merged into "${p.name}" list files it doesn't yet:\n` +
      gaps.map((g) => `  - ${g.plan}: ${g.files.join(', ')}`).join('\n') +
      `\nThe AI folds them in first (/plan-merge ${p.name}). Nothing changed and no lock was written.`);

    const options = L.parseArchiveOptions(raw.slice(raw.indexOf(ref) + 1));
    if (options.errors.length) fail(`Invalid archive options:\n${options.errors.map((e) => `  - ${e}`).join('\n')}`);
    const manualCommit = options.manualCommit;
    const allowUnlisted = manualCommit ? false : L.effectiveAllowUnlisted(options, L.config());
    const manualCommits = {};

    // Every check runs before the lock is written.
    if (manualCommit) {
      const { byRepo, errors } = L.resolveManualCommits(options.commitRefs, planRepos(v));
      const repos = L.repositories();
      for (const [repo, cref] of Object.entries(byRepo)) {
        if (cref === null) { manualCommits[repo] = null; continue; }
        const r = L.git(repos[repo], ['rev-parse', '--verify', '--quiet', `${cref}^{commit}`]);
        if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(r.out)) errors.push(`${repo}: unknown commit "${cref}" (git rev-parse could not resolve it)`);
        else manualCommits[repo] = r.out;
      }
      if (errors.length) {
        out(`Manual-commit archival of "${p.name}" stopped before anything was locked:`);
        for (const e of errors) out(`  - ${e}`);
        fail(`Nothing changed. Retry with, e.g.:\n` +
          `  ${CLI} archive-begin ${p.name} --manual-commit ${planRepos(v).length === 1 ? '<hash>' : planRepos(v).map((r) => `${r}=<hash>`).join(' ')}`);
      }
    } else {
      const wt = workingTreeCheck(v, { planName: p.name, allowUnlisted });
      if (wt.errors.length) {
        out(treeRefusal(p, wt, { allowUnlisted, locked: false }));
        fail('No lock was written, so there is nothing to abort.');
      }
      requireBranches(p, planRepos(v), 'Archival', { hint: 'No lock was written, so there is nothing to abort.' });
    }

    // The early readLock check above gives a friendly message; this is the one that settles a race.
    const holder = L.acquireLock({ plan: p.name, started: L.nowIso(), allowUnlisted, manualCommit, manualCommits: manualCommit ? manualCommits : undefined });
    if (holder) fail(`Archival of "${holder.plan || 'another plan'}" started at the same moment and holds the lock. Nothing changed; try again once it finishes.`);
    out(`Archival of ${p.name} STARTED (human accepted).`);
    if (manualCommit) {
      out('Mode: manual commit — the workflow makes no git write. Recorded commits:');
      for (const [repo, sha] of Object.entries(manualCommits)) out(`  ${repo}: ${sha || L.MISSING_TEXT}`);
    } else {
      out(`Mode: automatic — archive-finish commits the listed files whole, with the planned messages${allowUnlisted ? ' (unlisted changes are left uncommitted)' : ''}.`);
    }
    const merged = L.mergedSources(p.name);
    if (merged.length) out(`Merged plans, archived with this one: ${merged.map((m) => m.name).join(', ')}`);
    const shared = overlapReport(p);
    const others = L.activePlans().filter((o) => o.name !== p.name && !o.fm.merged_into);
    if (!others.length) out('No other active plans.');
    else {
      out('\nNext (AI): review every other active plan and update any that this work affects (stale assumptions, files, steps).');
      for (const o of others) out(`  - ${o.name} (${o.fm.status})`);
      if (shared.length) {
        out('\nShared files (uncommitted state shown). Each will be committed WHOLE by this plan, including any other');
        out("plan's edits in it. Reconcile each one before archive-finish:");
        for (const l of shared) out(l);
        out('  - If the other plan\'s edits in a shared file are not ready to commit, stop and tell the human');
        out(`    (they can run archive-abort ${p.name}) rather than committing them.`);
        out('  - If taking the shared files would leave the other plan with no files of its own, don\'t empty it: run');
        out(`    archive-abort ${p.name} and suggest the human merges the plans (merge ${p.name} <other plan>).`);
        out('  - Otherwise, update the other plan so it no longer expects to commit what this plan commits: adjust its');
        out('    Files Affected / Commit Messages / brief, and explain the decision in BOTH plans\' AI Feedback.');
      }
      out('Edit only plan bodies, never front-matter.');
    }
    out(`\nThen run: ${CLI} archive-finish ${p.name} --plans-reviewed`);
  },

  merge([into, ...names]) {
    if (!into || !names.length) fail('Usage: merge <into> <plan> [<plan> ...]');
    if (names.includes(into)) fail('A plan cannot be merged into itself.');
    const lock = L.readLock();
    const sources = [...new Set(names)].map((n) => L.findPlan(n));
    for (const s of sources) {
      if (s.fm.merged_into) fail(`"${s.name}" is already merged into "${s.fm.merged_into}" (unmerge ${s.name} first).`);
      if (s.fm.status === STATUS.STAGED) fail(`"${s.name}" is staged (being implemented). Wait for it to complete, or cancel it, first.`);
      if (lock && lock.plan === s.name) fail(`"${s.name}" is being archived.`);
    }

    // Already archived target: nothing is left to commit, so the plans are archived now with a note of the merge.
    const archived = fs.existsSync(path.join(L.plansDir(), `${into}.md`)) ? null : L.findArchived(into);
    if (archived) {
      for (const s of sources) out(archiveMerged(s, { target: into, targetFile: archived.fm.archive_file || rel(archived.file), commits: archived.fm.commits || [] }));
      out(`Uncommitted changes in their files, if any, are left in place. Check the worktrees with git status.`);
      return;
    }

    const target = L.findPlan(into);
    if (target.fm.merged_into) fail(`"${into}" is itself merged into "${target.fm.merged_into}"; merge into that plan instead.`);
    if (lock && lock.plan === into) fail(`"${into}" is being archived; merge once that finishes or is aborted.`);
    if (![STATUS.PLANNING, STATUS.CONFIRMATION].includes(target.fm.status))
      fail(`"${into}" is ${target.fm.status}. Plans can be merged in planning or in confirmation.`);
    const odd = sources.filter((s) => s.fm.status !== target.fm.status);
    if (odd.length) fail(`Merged plans must be in the same phase as "${into}" (${target.fm.status}): ${odd.map((s) => `${s.name} is ${s.fm.status}`).join(', ')}.`);

    for (const s of sources) {
      for (const g of L.mergedSources(s.name)) { // plans merged into s now belong to the new target
        g.fm.merged_into = into; L.addHistory(g, `merged into ${into} (via ${s.name})`); L.writePlan(g);
      }
      s.fm.merged_into = into;
      L.addHistory(s, `merged into ${into} by human`);
      L.writePlan(s, L.joinSections(feedbackEntry(s, `**Merged into ${into} by the human.** It is archived together with ${into}.`)));
    }
    const list = sources.map((s) => s.name).join(', ');
    L.addHistory(target, `merged in by human: ${list}`);
    L.writePlan(target, L.joinSections(feedbackEntry(target, `**Merged in by the human:** ${list}. Their briefs, questions, testing, files and commit messages are folded into this plan; they are archived with it.`)));
    out(`Merged ${list} into ${into} (${target.fm.status}).`);
    out(`Next (AI): /plan-merge ${into} folds them into ${into}'s plan. Then the human ${target.fm.status === STATUS.PLANNING ? 'stages' : 'accepts'} ${into} as usual.`);
  },

  unmerge([ref]) {
    const p = L.findPlan(ref);
    const into = p.fm.merged_into;
    if (!into) fail(`"${p.name}" is not merged into another plan.`);
    const lock = L.readLock(); if (lock && lock.plan === into) fail(`"${into}" is being archived; run archive-abort ${into} first.`);
    delete p.fm.merged_into;
    L.addHistory(p, `unmerged from ${into} by human`);
    L.writePlan(p, L.joinSections(feedbackEntry(p, `**Unmerged from ${into} by the human.** It is a plan of its own again.`)));
    if (fs.existsSync(path.join(L.plansDir(), `${into}.md`))) {
      const t = L.findPlan(into);
      L.addHistory(t, `unmerged by human: ${p.name}`);
      L.writePlan(t, L.joinSections(feedbackEntry(t, `**Unmerged by the human:** ${p.name}. Remove what was folded in from it.`)));
    }
    out(`${p.name} is no longer merged into ${into} (${p.fm.status}). ${into} may still contain what was folded in from it.`);
  },

  // --- archival (AI, after archive-begin) -----------------------------------

  'archive-finish'([ref], flags) {
    const p = L.findPlan(ref);
    const lock = L.readLock();
    if (!lock || lock.plan !== p.name) fail(`No archival in progress for "${p.name}". The human must accept it first (archive-begin).`);
    requireStatus(p, STATUS.CONFIRMATION);
    if (!flags['plans-reviewed']) fail('Review the other active plans first (see archive-begin output), then pass --plans-reviewed.');
    const v = L.validatePlan(p);
    if (v.errors.length) { printValidation(v); fail('The plan is invalid; run archive-abort and tell the human.'); }

    const prefix = L.formatDate(L.config().archivePrefixFormat);
    const dest = path.join(L.ensureDir(L.archiveDir()), `${prefix}${p.name}.md`);
    if (fs.existsSync(dest)) fail(`${rel(dest)} already exists.`);
    const gaps = L.mergeGaps(p);
    if (gaps.length) fail(`Plans merged into "${p.name}" list files it doesn't: ${gaps.map((g) => `${g.plan} (${g.files.join(', ')})`).join('; ')}. ` +
      `Add them to this plan, or run archive-abort ${p.name} and tell the human.`);
    const at = L.nowIso();
    let record;

    if (lock.manualCommit) {
      // Manual mode: no working-tree checks and no git writes; only read-only git to describe the commits.
      const repos = L.repositories(); const entries = []; const warnings = [];
      const given = lock.manualCommits || {};
      for (const repo of planRepos(v)) {
        const sha = given[repo] || null;
        if (!sha) { entries.push({ repo, sha: null }); continue; }
        const subject = L.git(repos[repo], ['log', '-1', '--format=%s', sha]);
        if (subject.code !== 0) { warnings.push(`${repo}: commit ${sha} could not be read (${subject.err || 'git log failed'})`); entries.push({ repo, sha }); continue; }
        const touched = new Set(L.git(repos[repo], ['show', '--name-only', '--format=', sha]).out.split(/\r?\n/).filter(Boolean).map(L.normPath));
        if (!v.files[repo].some((f) => touched.has(L.normPath(f))))
          warnings.push(`${repo}: commit ${sha.slice(0, 12)} changes none of the files this plan lists for ${repo}`);
        entries.push({ repo, sha, subject: subject.out });
      }
      for (const w of warnings) out(`  warning: ${w}`);
      p.fm.commit_mode = 'manual';
      p.fm.commits = entries.map((e) => `${e.repo}#manual ${e.sha || L.MISSING}`);
      record = L.archiveRecordSection({ mode: 'manual', at, entries, warnings, branches: L.recordedBranches(p) });
    } else {
      const done = new Set((p.fm.commits || []).map((c) => c.split(' ')[0]));
      const todo = L.commitPlanFor(v).filter((c) => !done.has(`${c.repo}#${c.index}`));
      const skip = new Set();
      for (const c of L.commitPlanFor(v)) if (done.has(`${c.repo}#${c.index}`)) c.files.forEach((f) => skip.add(`${c.repo}:${L.normPath(f)}`));
      // Checked again here: a worktree can switch branch between archive-begin and archive-finish.
      const branches = requireBranches(p, planRepos(v), 'archive-finish', {
        hint: 'Nothing more was committed. Tell the human; once the worktree is back on its branch, re-run archive-finish' +
          (todo.length < L.commitPlanFor(v).length ? ' (archive-abort is not possible: some commits were already made).' : ` (or run archive-abort ${p.name}).`) });
      const wt = workingTreeCheck(v, { planName: p.name, allowUnlisted: lock.allowUnlisted, skip });
      for (const w of wt.warnings) out(`  warning: ${w}`);
      const staged = [];
      for (const c of todo) {
        const mine = new Set(c.files.map(L.normPath));
        const foreign = L.stagedFiles(c.repoPath).filter((f) => !mine.has(f));
        if (foreign.length) staged.push(`${c.repo}: files already staged in the index that are not part of commit #${c.index}: ${foreign.join(', ')}`);
      }
      if (wt.errors.length || staged.length) {
        out(treeRefusal(p, wt, { allowUnlisted: lock.allowUnlisted, locked: true, extra: staged }));
        fail('Nothing was committed. Run archive-abort, then relay the block above to the human and stop.');
      }

      const msgFile = path.join(L.ensureDir(L.stateDir()), 'COMMIT_MSG.txt');
      for (const c of todo) {
        fs.writeFileSync(msgFile, c.message + '\n');
        let r = L.git(c.repoPath, ['add', '-A', '--', ...c.files]);
        if (r.code !== 0) fail(`git add failed in ${c.repo}: ${r.err}\nCommitted so far: ${(p.fm.commits || []).join('; ') || 'none'}. Re-run archive-finish after fixing.`);
        r = L.git(c.repoPath, ['commit', '-F', msgFile]);
        if (r.code !== 0) fail(`git commit failed in ${c.repo}: ${r.err || r.out}\nCommitted so far: ${(p.fm.commits || []).join('; ') || 'none'}. Re-run archive-finish after fixing.`);
        const sha = L.git(c.repoPath, ['rev-parse', 'HEAD']).out;
        p.fm.commit_mode = 'auto';
        p.fm.commits = [...(p.fm.commits || []), `${c.repo}#${c.index} ${sha} ${c.message.split('\n')[0]}`];
        L.writePlan(p); // persist progress so a retry never double-commits
        out(`  committed ${c.repo} #${c.index}: ${sha} ${c.message.split('\n')[0]}`);
      }
      try { fs.unlinkSync(msgFile); } catch {}

      p.fm.commit_mode = 'auto';
      const entries = (p.fm.commits || []).map((c) => {
        const m = /^([^#\s]+)#(\d+) (\S+)(?: (.*))?$/.exec(c);
        return m ? { repo: m[1], index: m[2], sha: m[3], subject: m[4] || '' } : { repo: c, index: '?', sha: null };
      });
      record = L.archiveRecordSection({ mode: 'auto', at, entries, branches,
        leftUncommitted: lock.allowUnlisted ? wt.unlistedFiles : [] });
    }

    p.fm.status = STATUS.ARCHIVED;
    p.fm.archived_at = at;
    p.fm.archive_file = rel(dest);
    L.addHistory(p, `confirmation -> archived (${p.fm.commit_mode} commit)`);
    L.writePlan(p, `${p.body.replace(/\s+$/, '')}\n\n${record}`);
    fs.renameSync(p.file, dest);
    for (const m of L.mergedSources(p.name)) out(archiveMerged(m, { target: p.name, targetFile: rel(dest), commits: p.fm.commits || [], at, prefix }));
    L.clearLock();
    out(`${p.name} ARCHIVED -> ${rel(dest)}\n`);
    out(record.trimEnd());
    if (lock.manualCommit) for (const c of p.fm.commits) if (c.endsWith(` ${L.MISSING}`))
      out(`\nNote: the plan records no commit for ${c.split('#')[0]}; its changes are whatever is committed by hand (or not).`);
  },

  'archive-abort'([ref]) {
    const p = L.findPlan(ref);
    const lock = L.readLock();
    if (!lock || lock.plan !== p.name) fail(`No archival in progress for "${p.name}".`);
    if ((p.fm.commits || []).length) fail(`Commits were already made (${p.fm.commits.join('; ')}); finish with archive-finish instead.`);
    L.clearLock();
    out(`Archival of ${p.name} aborted; it remains in confirmation.`);
  },
};
commands.list = commands.status;
commands.normalize = commands.normalise;

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const { pos, flags } = parseArgs(rest);
try {
  const fn = commands[cmd || 'help'];
  if (!fn) fail(`Unknown command "${cmd}".\n\n${HELP}`);
  fn(pos, flags, rest);
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  if (!(e instanceof Fail) && process.env.PLAN_DEBUG) console.error(e.stack);
  process.exitCode = 1;
}
