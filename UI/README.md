# Plan Workflow UI

A local web UI for the AI plan workflow. It shows a workspace's plans, runs the human gates, and runs each phase
as a headless Claude Code session (`claude -p`) whose output streams live into the page. It's plain Node with no
dependencies and no build step.

## Before the first run

1. **Sign in the Claude Code CLI.** Headless phases use the standalone `claude` command, which has its own sign-in,
   separate from the desktop app. In a terminal, run `claude` and use `/login`. To check: `claude auth status` should
   report `"loggedIn": true`.
2. **Trust each workspace.** Open a terminal in the workspace folder, run `claude` once and accept the trust prompt.
   Until then, headless runs ignore the workspace's `permissions.allow` rules (deny rules still apply).

The UI checks the first at startup and on the Workspaces page. It recognises both in a run's output and says how
to fix them.

## Run it

From this folder:

```bash
npm start
```

(or `node server.mjs`; from the parent folder, `node UI/server.mjs`).

Open <http://localhost:4317>, then add a workspace: a folder where the workflow package has been deployed (it
contains `.claude/workflow/plan.mjs`). You can add several and switch between them in the header.

| Option | Default | Meaning |
|---|---|---|
| `--port <n>` | `4317` | Port to listen on |
| `--host <addr>` | `127.0.0.1` | Interface to bind. Requests are only accepted with a local `Host` header in any case |
| `--data <dir>` | `./data` | Where settings, the workspace list and run history are kept (also `PLAN_UI_DATA`) |

Requirements: Node.js 18+, git, and Claude Code (`claude`) on `PATH`, signed in.

## What it does

- **Board.** Plans in Planning, Staged and Confirmation columns, with archived plans below. Cards show deviations
  awaiting a decision, shared files, running phases and archival in progress. Updates arrive live: the server
  watches the workspace's `plans/` and `.claude/state/` folders, and also polls.
- **Plan detail.** The rendered plan, plus its attempt, worktrees, branches, overlaps, history and runs.
- **Getting around.** Each page links back up a level (session → plan → board → workspaces) and, on the right,
  forward: a plan to its last-opened and latest session, the board to the last-opened and latest plan. What was
  last opened is remembered per browser.
- **Deviations.** *Approve deviation…* shows the deviation in full, lists its numbered options to choose from, and
  takes notes or conditions. The choice is recorded in the plan (`continue --decision`), and the continue phase
  follows it over the AI's own recommendation. Older workspaces need a redeploy for the choice to be recorded.
- **Decisions (human gates).** Approve & implement (`stage`), Approve deviation (`continue`), Cancel to planning
  (`cancel`), Send back (`rework --feedback`), Accept & archive (`archive-begin`, with `--allow-unlisted` or
  `--manual-commit`), and Abort archival. With *Start the follow-up phase automatically* ticked, a successful gate
  starts the matching phase: stage → implement, continue → continue, rework → rework, cancel → write extension,
  archive-begin → reconcile + archive.
- **Merging plans.** *Merge into…* (planning or confirmation) merges a plan into another one in the same phase.
  Use it when plans can't be archived one at a time, for example two plans in confirmation editing the same
  file. The follow-up phase (*Fold merged plans*, `/plan-merge <target>`) folds the merged plan's brief, testing,
  files and commit messages into the target. The merged plan is then archived along with the target. Pick an
  archived plan instead, and the merged plan is archived at once with a note of the merge; that rescues a plan
  left behind after its partner was archived. *Unmerge* undoes a merge before archival. This needs a workspace
  deployed with the `merge` command.
- **Phases.** *Write plan* on the board, and any phase from a plan's page. Each runs `claude -p "/plan-<phase> …"`
  in the workspace with `--output-format stream-json`. Only one run per plan at a time; Stop ends it (on Windows,
  the whole process tree).
- **Replying to a session.** Under any finished run, *Reply* continues that Claude Code session
  (`claude -p "<your reply>" --resume <session id>`). Use it to answer the questions a *Write plan* session asked,
  with the session's full context. The reply is a run of its own, linked to the one it continues, with the same
  permissions. A *Write plan* run is linked to the plan it creates, so it shows up on that plan's page.
- **Amending a plan.** While a plan is in planning, its page has an *Amend plan* box. A headless session runs
  `/plan-amend <plan> <your instructions>`: it revises the plan, records answered questions as decisions, and
  validates it. This needs no earlier session. Workspaces deployed before the package shipped `/plan-amend` get an
  equivalent inline prompt.
- **History.** Every run is kept under `data/runs/<workspace>/<run>/`: `meta.json` (phase, prompt, permissions,
  outcome, turns, estimated cost, session id) and `events.jsonl` (every event, replayable in the page). The cost
  is Claude Code's `total_cost_usd`: what the run would cost at API prices. With a claude.ai sign-in it isn't charged
  per run (usage counts against your plan's limits), so the page labels it as an estimate. Runs left
  running when the server stopped are marked *interrupted* at the next start.

## Permissions per phase

Headless sessions can't ask you for permission, so each phase has its own `permissionMode` and `allowedTools`
(Settings page, or `data/config.json → phases`). The default for every phase is `dontAsk`, which refuses anything
not allowed. The allowed tools are reading files, editing files, the workflow CLI, and read-only git. The phases
that change code (implement, continue, rework) may also move, copy and delete files: `mv`, `cp`, `rm`, `mkdir`,
`rmdir`, and in PowerShell `Move-Item`, `Copy-Item`, `Remove-Item`, `New-Item`, `Rename-Item` and their aliases.
The workspace's own `.claude/settings.json` deny rules, which deny gates and git writes (including `git mv` and
`git rm`), always apply on top.

`data/config.json` keeps the full phase lists once saved. When a new version adds default permissions, the server
adds them to a saved config at startup (`configVersion`), keeping anything you added or removed yourself.

When a session is refused a shell command, its run page lists the command with the rules that would allow it
(its first word, for both shells). *Allow in <workspace> (every phase)* adds them to the workspace's own rules,
which every run in that workspace gets; *Only the … phase* adds them to that phase for all workspaces. A reply
then retries with them. Chained commands, `cd` prefixes, git and the workflow CLI get no suggestion: allowing
them can't help. The workspace rules are listed and editable on the Workspaces page (*Allowed commands*). They
live in the UI's config, not the workspace's `.claude/settings.json`, so they apply whether or not Claude Code
trusts the folder.

Read-only `git -C <worktree>` rules are generated for each worktree by its relative name and its absolute path
(with forward or back slashes, quoted or not).

If implementation needs to run builds or tests, add them to that phase, for example `"Bash(npm test:*)"`. On
Windows, add the matching `"PowerShell(npm test:*)"` too: Claude Code has a PowerShell tool there, and `Bash(...)`
rules don't cover it. The defaults already list both forms.

At the start of each run, the UI also allows read-only `git -C <worktree> status|diff|log|show|branch
--show-current` for each of the workspace's worktrees. Rules only match a prefix, so `git status:*` wouldn't
cover them.

Every session also gets an appended system prompt (Settings → *Appended system prompt*). It tells the session that
it's headless and to run one command at a time without chaining. Without it, a session that had one chained
command refused tended to conclude it had no shell at all.

Workspace paths are stored and used in their long form. Claude Code refuses Edit/Write on files addressed
through Windows 8.3 short names (`C:\Users\ABCDEF~1\…`), and a session builds its file paths from the folder it
starts in.

`claudeCommand` can be a list, for example `["wsl", "claude"]`; the first entry runs and the rest go in front of
the arguments.

## Security

- The server binds to `127.0.0.1` and rejects requests whose `Host` isn't local. This blocks DNS rebinding.
- Every write (POST, PUT or DELETE) must carry the `X-Plan-UI: 1` header. A cross-site page can't send that
  without a CORS preflight, which this server never grants.
- Plan names, commit refs and paths are validated before they reach the CLI. Processes are started without a
  shell.
- Anyone who can reach the server can approve plans and start Claude sessions. Don't expose it beyond your own
  machine.

## Tests

```bash
npm test
```

The end-to-end tests deploy the package from `../Deployment-Files` (or `$PLAN_UI_PACKAGE`) into a temp folder and
drive the server with a fake `claude` (`test/fixtures/fake-claude.mjs`).

## Layout

```
server.mjs            routes, live status, startup
lib/config.mjs        settings, phases and the workspace registry (data/config.json)
lib/workspace.mjs     plan.mjs calls: status, gates, plan text, archived plans, folder watching
lib/runs.mjs          headless phase runs: spawn, stream-json parsing, transcripts, stop, history
lib/http.mjs          router, JSON, static files, server-sent events
public/               index.html, app.js (views), md.js (safe Markdown), style.css (light/dark)
test/                 node:test suite and the fake claude
```
