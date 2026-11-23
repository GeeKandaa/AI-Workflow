---
description: Phase prompt — write the Plan Extension after the human cancelled an implementation
argument-hint: <plan>
---
The human cancelled the implementation of plan `$ARGUMENTS`; it is back in planning with a new
`## Plan Extension N` section containing TODOs.

1. Inspect the plan's worktrees (`git status`, `git diff`) to establish exactly what was implemented. Other plans
   may have changes in the same worktree; `node .claude/workflow/plan.mjs overlaps $ARGUMENTS` shows shared files.
2. In the new Plan Extension write a detailed brief of the current state of implementation and what is yet to do.
   Update Outstanding Questions, Testing, Files Affected and Commit Messages beneath it for the remaining work
   and remove every TODO.
3. Run `node .claude/workflow/plan.mjs validate $ARGUMENTS`, summarise the revised plan, and stop.
