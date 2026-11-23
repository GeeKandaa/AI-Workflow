# {{TITLE}}

## Brief

<!-- TODO: Detailed brief for the human. Cover:
  - Why: the problem / goal (bug, feature, refactor, chore...).
  - What: the behaviour or structure that will exist afterwards.
  - How: the concrete changes, file by file or component by component, in the order they will be applied.
  - Risks, assumptions, out-of-scope items and anything the human must decide.
Write it so the human can approve or reject the approach without reading code. Put questions for the human
under Outstanding Questions, not here. -->

## Outstanding Questions

<!-- TODO: Numbered questions the human must answer before this plan can be approved, each with the options
and your recommendation, e.g. "1. Where should X live? (a) ... (b) ... Recommended: (a), because ...".
If there are none, replace this comment with "None." -->

## Testing

<!-- TODO: Numbered steps the human (or AI) can follow to verify the change: commands to run, expected output,
manual checks. If testing genuinely does not apply, replace this comment with "N/A — <reason>". -->

## Files Affected

<!-- TODO: One "### <worktree>" sub-heading per worktree (names: run `node .claude/workflow/plan.mjs repos`).
Under each, one bullet per file, path relative to that worktree, wrapped in backticks, with a short note:

### my-worktree
- `src/feature/thing.ts` — new
- `src/feature/index.ts` — export thing
-->

## Commit Messages

<!-- TODO: One "### <worktree>" sub-heading per worktree listed above, each containing one or more fenced
commit messages that follow the commit template (.claude/workflow/commit-template.txt).
With ONE commit for a worktree, it commits every file listed for that worktree.
With SEVERAL commits in a worktree, put a bullet list of that commit's files directly above each fenced message.

### my-worktree
```text
feat(feature): add thing

Explain what changed and why.
```
-->
