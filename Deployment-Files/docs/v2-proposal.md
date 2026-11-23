# v2 proposal — close the remaining workflow gaps

<!-- A plan-format proposal for the template itself. It lives in docs/ rather than plans/, so plan.mjs does not
manage it: there is no front-matter, and `validate` has not been run on it. -->

## Brief

**Why.** The stress test of 2026-11-08 (28 checks against real worktrees) found 15 gaps. v1.1 fixed two of them:
the archive-lock race and branch drift. This plan collects everything still open, ordered by severity, with the
proposed approach for each. Every item is a change to the package in `Deployment-Files/`. The plan UI is a separate
project and out of scope, except where it consumes `status --json`.

**What.** After v2:
- A plan only counts as holding a file if it can actually have edits in the worktree. Stray edits and mixed edits
  are refused instead of being credited to whichever plan lists the file.
- Gate transitions can't be faked by editing a plan's front-matter or writing a plan file by hand.
- A plan can't quietly grow into files another plan is implementing.
- `status --json` is fast enough to poll, and reports every plan, including broken and archived ones.
- Plans can be abandoned through the CLI.
- The low-severity rough edges give clear errors.

**How**, in the order it will be applied:

### 1. Holding plans (high: stress gaps 2 and 3)

A plan *holds* its files when it has been staged at least once (`attempt ≥ 1`) and is not archived. That covers
plans that are staged, in confirmation, or cancelled back to planning with their edits left in the worktree.
Plans that are only drafted hold nothing.

- `lib.mjs`: add `holdingPlans()`. Make `claims()` and `overlaps()` take a `holdingOnly` option.
- `stage` and `rework`: refuse when any holding plan lists one of the same files. Today they only refuse against
  plans that are currently staged. Overlaps with drafted plans stay a note.
- `complete`, `archive-begin` and `archive-finish`: credit an unlisted changed file only to a holding plan. A
  change that only a drafted plan lists counts as unlisted, so it blocks like any other stray edit.
- Trade-off: a second plan can't start on a file until the first plan's edits to it are archived or cancelled.
  This ordering is what keeps whole-file commits from mixing two plans' work.

### 2. Tamper-resistant gates (high: stress gap 5)

Today, editing `status:` by hand, or writing a plan file directly, is accepted.

- Every plan.mjs transition appends to `.claude/state/ledger.jsonl`: plan, from-status, to-status, time, and a
  hash of the front-matter it wrote.
- Every command that reads a plan checks its front-matter against the ledger's last entry for that plan. A
  mismatch, or a plan with no ledger entries (a plan file not created by `new`), is refused with a message naming
  the difference. Archived plans are checked against their final entry.
- `settings.json`: deny the AI `Edit`/`Write` on `.claude/state/**`, for the Bash and PowerShell file-writing
  routes as far as prefix rules allow.
- `status --json`: report ledger mismatches per plan, so the UI can show them.
- Migration: on first run, plans that predate the ledger get a `migrated` entry built from their current
  front-matter, with a warning.

### 3. Claiming files during implementation (medium: stress gap 6)

Today, Files Affected can grow into another staged plan's files. This is only recorded at `complete`.

- New AI command `plan.mjs claim <plan> <worktree> <path>...`. It adds the files to Files Affected and refuses if
  a holding plan already lists any of them.
- `commands/plan-implement.md`, `plan-rework.md`, `plan-continue.md` and `CLAUDE.template.md`: claim a file before
  editing anything not already listed.
- `complete`: refuse, rather than only record, when Files Affected overlaps a holding plan.

### 4. `status --json` performance and completeness (medium: stress gaps 7 and 8)

- Cache `repositories()` and each plan's parsed files and validation result per CLI invocation. Overlaps go from
  O(n²) parses to O(n). The target is under 300 ms for 60 plans of 10 files each (now 4.7 s).
- Plans with unreadable front-matter are listed with `status: "broken"` and a `problems` entry instead of being
  silently dropped.
- Each plan gets `problems: [...]`: validation errors and warnings, unknown worktrees, branch-check results and
  ledger mismatches.
- `status --json --archived` also lists archived plans: name, title, archived_at, commits and branches.
- Document the JSON shape in the README as the UI contract, with a `schemaVersion` field.

### 5. Abandoning plans (medium: stress gap 9)

- New human gate `plan.mjs abandon <plan> [--reason "…"]`, for planning, staged or confirmation plans. It refuses
  during that plan's archival. It moves the plan to `plans/archive/` with `status: abandoned`, the reason, and a
  list of any uncommitted files it held, which are left in place. No commits.
- Add it to the deny rules in `settings.json`. Make the AI never delete plan files itself.

### 6. Cross-worktree overlap information (medium: stress gap 10)

- `overlaps` and `status --json`: report other active plans that list the same path on a *different* worktree, as
  information ("same path on feat-b: likely merge conflict"). It never blocks.

### 7. Low-severity rough edges (stress gaps 11–14)

- Directory bullets (`src/`): refuse at `validate` with "list files, not directories". The `complete` error
  currently says "has no uncommitted change".
- Git-ignored files: in the working-tree check, run `git check-ignore` on listed-but-unchanged files and say
  "is ignored by git" instead.
- `repos`: list sub-folders that contain `.git` but are skipped because their names start with `.`, with the
  `repositories.map` workaround.
- `new`: the usage message states the slug rules in full (2–80 characters; lowercase letters, digits, hyphens;
  must start with a letter or digit).

### 8. Deny rules miss `git -C` (high, found in real UI runs on 2026-11-21)

Permission rules only match a command's prefix. So `Bash(git commit:*)` denies `git commit`, but not
`git -C feature commit`. With worktrees, `git -C <worktree>` is exactly how a session addresses git, so every
git-write deny rule can be sidestepped this way.

- Add `git -C <worktree> <write>` deny rules for each worktree. Worktrees come and go, so `deploy.ps1` and a new
  `plan.mjs sync-permissions` command would regenerate them from `plan.mjs repos` into `.claude/settings.json`.
- Alternatively, reintroduce one small PreToolUse hook for git writes only, which parses any `git` invocation
  regardless of `-C`. This is the one guard worth having back.

Confirmed in the same runs: `PowerShell(...)` rules are a valid format (an allow rule `PowerShell(node --version:*)`
let the PowerShell tool run it), and `Bash(...)` rules do not cover the PowerShell tool. The package's `PowerShell(...)`
deny rules are therefore needed and correctly written. Testing step 5 only needs to cover path variants now.

### Risks and assumptions

- The ledger raises the bar but isn't a sandbox. An AI that can run arbitrary scripts can still rewrite it.
  Deny rules match by prefix (see Testing, step 5).
- Holding-plan refusals will block some sequences that work today. The messages must name the plan to accept or
  cancel first.
- The `status --json` shape changes. The UI project must follow `schemaVersion`.

### Out of scope

- The plan UI.
- Committing individual hunks of a shared file.
- Isolating sessions that share one worktree. They share its working tree and git index, so one session's builds
  and tests see another's half-finished edits. This is inherent to the design, and documented.

## Testing

1. `node --test Deployment-Files/.claude-template/tests/workflow.test.mjs`: all existing tests pass, plus new tests:
   - staging is refused against a plan in confirmation, and against a cancelled plan with leftover edits;
   - a stray edit to a file only a drafted plan lists blocks `complete`;
   - a hand-edited `status:` and a hand-written plan file are refused (ledger), and pre-ledger plans are migrated;
   - `claim` refuses a held file and adds a free one;
   - `abandon` archives without commits and keeps worktree changes;
   - `status --json` lists broken and archived plans and their `problems`.
2. Rerun the stress scripts (lifecycle and edge cases). Every check passes except the out-of-scope ones. Record
   the `status --json` timing for 60 plans: under 300 ms.
3. Deploy the package into a scratch workspace with `deploy.ps1 -Yes` and run the deployment guide's section 6
   checks.
4. Upgrade a workspace that already has v1.1 plans and check that they migrate into the ledger with a warning.
5. In a live Claude Code session in a deployed workspace, try these and record the results in this plan:
   - `node ./.claude/workflow/plan.mjs stage x`, `node .claude\workflow\plan.mjs stage x`, and
     `cd .claude/workflow; node plan.mjs stage x`, which test whether path variants get past the deny rules;
   - the same through the PowerShell tool, which tests whether `PowerShell(...)` rules are a valid format;
   - an `Edit` of `.claude/state/ledger.jsonl`.

## Files Affected

### AI-Workflow
- `Deployment-Files/.claude-template/workflow/lib.mjs` — holding plans, ledger, caching, status data, check-ignore
- `Deployment-Files/.claude-template/workflow/plan.mjs` — holding checks, claim, abandon, ledger checks, --archived
- `Deployment-Files/.claude-template/settings.json` — deny abandon, state edits and per-worktree `git -C` writes
- `Deployment-Files/deploy.ps1` — generate per-worktree deny rules on deploy
- `Deployment-Files/.claude-template/tests/workflow.test.mjs` — new tests
- `Deployment-Files/.claude-template/commands/plan-implement.md` — claim before editing
- `Deployment-Files/.claude-template/commands/plan-rework.md` — claim before editing
- `Deployment-Files/.claude-template/commands/plan-continue.md` — claim before editing
- `Deployment-Files/.claude-template/workflow/README.md` — holding plans, ledger, JSON contract, new commands
- `Deployment-Files/CLAUDE.template.md` — claim, abandon, never delete plans
- `Deployment-Files/docs/deployment-guide.md` — ledger migration, troubleshooting
- `Deployment-Files/docs/v2-proposal.md` — record the live deny-rule results

## Commit Messages

### AI-Workflow

- `Deployment-Files/.claude-template/workflow/lib.mjs`
- `Deployment-Files/.claude-template/workflow/plan.mjs`
- `Deployment-Files/.claude-template/settings.json`
- `Deployment-Files/deploy.ps1`
- `Deployment-Files/.claude-template/tests/workflow.test.mjs`
- `Deployment-Files/.claude-template/commands/plan-implement.md`
- `Deployment-Files/.claude-template/commands/plan-rework.md`
- `Deployment-Files/.claude-template/commands/plan-continue.md`

```text
feat: hold files per plan, ledger the gates and add claim and abandon

* Count a plan as holding its files once staged; refuse overlaps with any holding plan
  - credit unlisted changes only to holding plans, so stray edits block complete
* Record every transition in .claude/state/ledger.jsonl and refuse front-matter that disagrees
  - migrate plans that predate the ledger with a warning
* Add claim for files found during implementation and abandon as a human gate
* Cache parsing per run and report broken, archived and problem plans in status --json
* Give clear errors for directory bullets, ignored files, skipped worktrees and slugs
* Deny git writes through git -C for each worktree, regenerated by deploy.ps1 and sync-permissions
```

- `Deployment-Files/.claude-template/workflow/README.md`
- `Deployment-Files/CLAUDE.template.md`
- `Deployment-Files/docs/deployment-guide.md`
- `Deployment-Files/docs/v2-proposal.md`

```text
docs: describe holding plans, the ledger and the status JSON contract

* Document claim, abandon and the ledger in the README, CLAUDE template and guide
* Record the live deny-rule results in the v2 proposal
```
