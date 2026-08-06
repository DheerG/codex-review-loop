# Review-fix hygiene

The workflow should disappear into the quality of the result. Product artifacts describe the product change, not the review machinery that found it.

## Code

- Preserve repository conventions and keep the repair proportional to the defect.
- Prefer the root-cause fix and remove superseded branches or comments.
- Add comments only for durable, non-obvious behavior. Never add comments such as “fixed after Codex review,” “AI suggested,” or “review round 2.”
- Do not add workflow narration to user-facing documentation, changelogs, tests, strings, or identifiers unless the product itself exposes review-provider functionality.
- Do not reformat unrelated files or stage unrelated user changes.

## Commits

Only commit or push when the user or containing workflow already authorized it.

- Treat existing branch history as immutable input. Never audit it for message quality or amend, rebase, squash, or recreate commits solely to satisfy this policy.
- Commit-message guidance is prospective only. Check a proposed message before its commit is created. Once the commit exists, leave it unchanged and improve the next message instead.
- When review repairs need a commit, create a new commit before the next review so the resulting commit is part of the reviewed snapshot.
- Group commits by product behavior or root cause, never by reviewer round.
- Never use subjects such as `Address review feedback`, `Codex fixes`, or `Review round 3`.
- Do not add AI/reviewer attribution or AI co-author trailers.

### Resolve the prospective policy

Before proposing the next commit, resolve its message policy in this order:

1. explicit instructions from the user;
2. explicit repository guidance such as `AGENTS.md`, `CONTRIBUTING.md`, a commit template, or commit-lint configuration;
3. the default product-narrative format below.

Apply user or repository guidance only where it speaks. For example, a Conventional Commits subject rule can coexist with the default body, while an explicit user instruction may omit the body without being misattributed to the repository. When stronger guidance conflicts with a default field, pass `--policy "<user instruction or repository source>"` plus `--policy-overrides subject`, `body`, or `all` to the prospective check. Defaults remain active for every field not named by the override. Existing commit messages are legacy examples, not an authoritative policy and never a compliance target.

Do not scan history merely to grade it. If an already-visible message differs from the effective policy, the host may give one non-blocking notice that existing messages remain unchanged and the policy applies only to new proposals. Never turn that observation into a finding, failed check, or request to rewrite history.

When no stronger rule applies, use an imperative subject of at most 72 characters with no trailing period. Avoid vague subjects such as `Fix issues` or `Cleanup`. Write the body in this format:

```text
Failure:
<triggering state or input, incorrect behavior, and consequence>

Change:
<resulting behavior and the seams or sibling sites covered>

Rationale:
<why this implementation shape was chosen, when non-obvious>

Verification:
- <exact test or command actually run>
```

`Rationale:` is optional. `Failure:`, `Change:`, and `Verification:` are required by the default. For several related defects, use one scenario-and-resolution bullet per behavior. Put unrelated root causes in separate commits. Keep the tone factual rather than defensive and body lines to at most 100 characters. Do not copy priority labels or reviewer prose into history; translate useful information into product failure, behavior, rationale, and evidence.

Check the proposed message before creating the repair commit:

```sh
node <skill-dir>/scripts/review-loop.mjs check-commit-message \
  --subject "Preserve errors across retry exhaustion" \
  --body-file "<path-to-proposed-body>"
```

When an explicit repository rule overrides the default format, identify its source:

```sh
node <skill-dir>/scripts/review-loop.mjs check-commit-message \
  --subject "fix(retries): preserve terminal provider errors" \
  --body-file "<path-to-proposed-body>" \
  --policy "CONTRIBUTING.md" \
  --policy-overrides subject
```

The override does not waive the prospective-only boundary or permit reviewer/AI workflow narration. The command checks only the proposal supplied on its command line. It never reads, grades, amends, or otherwise changes Git history. If it reports issues, revise the proposal before committing. After the commit, run the next independent review. Never run a history-cleanup gate after a clean review, and never make existing message quality a condition of `finish --reason clean`.

A repository that genuinely implements reviewer-provider behavior may need product names in its proposed message or exact verification commands. In that narrow case, add `--product-terms "<why these names describe the product>"`. The justification waives only the broad product-term match for that proposal; workflow narration, defensive language, and AI co-author trailers remain prohibited. It never applies to existing history.
