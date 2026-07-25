# Code and Git hygiene

The workflow should disappear into the quality of the result. Product artifacts describe the product change, not the review machinery that found it.

## Code

- Preserve repository conventions and keep the repair proportional to the defect.
- Prefer the root-cause fix and remove superseded branches or comments.
- Add comments only for durable, non-obvious behavior. Never add comments such as “fixed after Codex review,” “AI suggested,” or “review round 2.”
- Do not add workflow narration to user-facing documentation, changelogs, tests, strings, or identifiers unless the product itself exposes review-provider functionality.
- Do not reformat unrelated files or stage unrelated user changes.

## Commits

Only commit or push when the user or containing workflow already authorized it.

- Group commits by product behavior or root cause, never by reviewer round.
- Use an imperative subject of at most 72 characters with no trailing period.
- Avoid vague subjects such as `Fix issues` or `Cleanup`.
- Never use subjects such as `Address review feedback`, `Codex fixes`, or `Review round 3`.
- Use a body only when the technical reason, compatibility constraint, or behavioral tradeoff is not clear from the diff. Keep body lines near 100 characters.
- Do not add AI/reviewer attribution or AI co-author trailers.

The `hygiene` command runs `git diff --check`, examines added lines for workflow attribution, and checks commit messages in the delivery scope. Attribution matches are candidates because a project may legitimately implement AI review features. In that exceptional product-domain case, rerun:

```sh
node <skill-dir>/scripts/review-loop.mjs hygiene \
  --justify-product-terms "<why these terms are part of the product>"
```

The non-empty justification is tied to the exact Git snapshot. It does not waive whitespace errors, vague messages, overlong subjects, or reviewer-round commits.
