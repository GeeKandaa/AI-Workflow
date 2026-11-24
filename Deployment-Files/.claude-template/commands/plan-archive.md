---
description: Phase prompt — reconcile other plans and archive a plan the human accepted
argument-hint: <plan>
---
The human accepted plan `$ARGUMENTS` and has run `archive-begin` (the archive lock is held).

1. Run `node .claude/workflow/plan.mjs status $ARGUMENTS` (it must say "Archival in progress") and
   `node .claude/workflow/plan.mjs overlaps $ARGUMENTS`.
2. For every other active plan, read it and update anything this work affects (paths, assumptions, steps, file
   lists, commit messages). Edit only plan bodies, never front-matter.
3. For each shared file: this plan commits it **whole**, including any other plan's edits in it.
   - If another plan's edits in it are unfinished or should not be committed now, run
     `node .claude/workflow/plan.mjs archive-abort $ARGUMENTS`, explain the conflict to the human, and stop.
   - If the other plan's work is (mostly) in the shared files, so that taking them would leave it with no files
     of its own, don't empty it: it could never be archived. Run `archive-abort $ARGUMENTS` and suggest that the
     human merges the plans (`merge $ARGUMENTS <other plan>`, both must be in the same phase), then stop.
   - Otherwise update the other plan so it no longer expects to commit what this plan commits, and explain the
     decision in both plans' `## AI Feedback`.
4. Run `node .claude/workflow/plan.mjs archive-finish $ARGUMENTS --plans-reviewed`.
5. Report the archive path, the plans you updated (and how), and the Archive Record it printed. End your reply
   with the `FINAL COMMIT(S)` block that `archive-finish` printed last: every commit's full hash and its message,
   copied exactly, under a "Final commit" heading.
   If `archive-finish` refuses before a commit was made, run `archive-abort $ARGUMENTS`, relay its output to the
   human, and stop.
