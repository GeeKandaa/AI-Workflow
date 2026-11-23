---
description: Phase prompt — fold the plans the human merged into this one
argument-hint: <plan>
---
The human merged one or more plans into plan `$ARGUMENTS`. They stay in `plans/` with `merged_into: $ARGUMENTS`
and are archived automatically when `$ARGUMENTS` is archived. Your job is to make `$ARGUMENTS` describe all of the
work, so that archiving it commits everything.

1. Run `node .claude/workflow/plan.mjs status --json` and find the plans whose `mergedInto` is `$ARGUMENTS`, and
   `$ARGUMENTS`'s `status` and `mergeGaps`. Read `plans/$ARGUMENTS.md` and each merged plan in full.
2. Edit `plans/$ARGUMENTS.md` only (its body, never the front-matter):
   - **Brief** (or its latest Plan Extension): add a short account of each merged plan's goal, approach and
     decisions, naming the plan, and how the pieces fit together.
   - **Outstanding Questions**: carry over any that are still open.
   - **Testing**: include the merged plans' verification steps, without duplicates.
   - **Files Affected**: the union of all the plans' files, per worktree. Every file a merged plan lists must
     appear, or archival refuses.
   - **Commit Messages**: describe the combined work. Each file belongs to exactly one commit; files shared by
     the plans are committed whole, once. One commit per worktree covering all of it is often simplest. Follow
     `.claude/workflow/commit-template.txt`.
   - **AI Feedback**: record how you combined them (`plan.mjs note` only works while staged, so edit the section).
3. Don't edit or move the merged plans themselves; the workflow archives them with `$ARGUMENTS`.
4. If the plan is in confirmation, check its Files Affected against the working tree (`git -C <worktree> status`)
   and say if anything doesn't match.
5. Run `node .claude/workflow/plan.mjs validate $ARGUMENTS` until it passes with no merged-plan warnings.
   Summarise the combined plan. Then stop: the human stages it (planning) or accepts it (confirmation) in the UI.
