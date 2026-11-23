---
description: Phase prompt — carry on after the human approved a substantial deviation
argument-hint: <plan>
---
The human approved the pending deviation for plan `$ARGUMENTS`. It is recorded as the newest
"Deviation approved by human" entry under AI Feedback.

Read the plan. If that entry includes a **Human's decision**, it is binding: follow the option or conditions it
names, even where you recommended something else, and note any consequence you can't work around with
`plan.mjs note`. If the decision is unclear or picks an option that turns out to be unworkable, raise it again with
`plan.mjs deviate` and stop rather than guessing.

Continue implementing the plan with the approved change, and finish as in `/plan-implement`: update Files Affected
and Commit Messages, run `node .claude/workflow/plan.mjs complete $ARGUMENTS`, summarise, and stop.
