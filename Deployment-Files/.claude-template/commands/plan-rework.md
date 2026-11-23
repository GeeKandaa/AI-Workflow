---
description: Phase prompt — rework an implementation the human sent back
argument-hint: <plan>
---
The human sent plan `$ARGUMENTS` back for rework. Their feedback is the latest "Human rework feedback" entry under
the plan's `## AI Feedback`.

1. Run `node .claude/workflow/plan.mjs status $ARGUMENTS`; it must be `staged`.
2. Address the feedback within the plan's scope, following the **Implementation** rules in CLAUDE.md.
3. Update Files Affected / Commit Messages if needed, run `plan.mjs complete $ARGUMENTS`, summarise, and stop.
