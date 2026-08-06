---
name: review-until-clean
description: Independently review the complete current Git change scope with Codex or another configured provider, fix in-scope functional findings, and repeat until a valid clean result. Use when the user asks to review until clean, squash all bugs, add an independent reviewer to an implementation plan, or run a pre-ship quality loop.
---

# Review Until Clean

Run an independent reviewer over the whole current change scope after every repair. The host agent owns all edits and decisions; the reviewer stays read-only.

## Invocation modes

- **Execution:** run the loop now when file edits are permitted.
- **Plan:** add a required final execution step named `Run review-until-clean` after implementation and verification. State that delivery is blocked until the loop is clean or the user accepts an explicitly surfaced exception. Do not claim that the loop ran while the harness is read-only.

Arguments may name an outcome, base ref, or reviewer provider. Treat unspecified text as the intended outcome. Supported providers are `auto`, `codex`, `gemini`, `claude`, `opencode`, and `custom`.

## Before running

Read [protocol.md](references/protocol.md), [providers.md](references/providers.md), and [hygiene.md](references/hygiene.md). Resolve `scripts/review-loop.mjs` relative to this skill directory.

Determine:

- the approved or user-stated outcome;
- the comparison base, if the repository default is wrong;
- the provider, if `auto` is not appropriate;
- the repository's verification commands and any local instructions.

Do not fetch, commit, push, rewrite history, or broaden scope unless already authorized.

## Run the loop

From the target repository:

1. Check availability:

   ```sh
   node <skill-dir>/scripts/review-loop.mjs doctor
   ```

2. Start one durable local run:

   ```sh
   node <skill-dir>/scripts/review-loop.mjs start --provider auto --outcome "<approved outcome>"
   ```

   Add `--base <ref>` only when needed. Codex inherits the user's configured model and reasoning effort; add `--isolate-codex-config` only when isolation is intentional. An active run is resumable with `status`; never start a second run over it.

3. Before the first review, run the repository's complete relevant verification, including its diff or whitespace checks when available. Complete any resulting fixes before invoking the reviewer:

   ```sh
   node <skill-dir>/scripts/review-loop.mjs review
   ```

4. Each `review` invocation is exactly one round. Never shell-chain it with a fallback or another review. Before any fix edit, relay one contiguous leading block: `Round N — independent review`, the complete reviewer output verbatim, then a forward-looking disposition such as `Fixing N in-scope; M filed out-of-scope`, `Clean — loop terminating`, or `Invalid response — retrying once`. Relay clean and invalid rounds too.

5. Triage every finding against the outcome. For each in-scope defect, state the violated rule and search reachable sibling sites before editing; fix the class, not merely the cited line. If the class recurs at new locations, centralize the invariant when the outcome requires it or surface the bounded remainder as out of scope. Preserve unrelated user changes. Verify the repair changed the intended behavior—a successful build or a no-op replacement is insufficient.

6. Before the next review, rerun the repository's complete relevant verification. If commits are already authorized and the repairs should be committed, create new product-focused repair commits grouped by behavior or root cause. Existing commits are immutable workflow input: never grade their messages or amend, rebase, squash, or recreate them to satisfy this workflow.

   Resolve the prospective message policy from explicit user instructions, then explicit repository guidance, then the plugin default in [hygiene.md](references/hygiene.md). Apply repository rules where they speak and use the default for unspecified fields. Git history is a weak style hint, not a policy source or compliance target. Do not scan it for compliance. If an already-visible message differs, at most note once that it remains unchanged and the effective policy applies only to future proposals.

   Under the default, write `Failure:`, `Change:`, and `Verification:` sections; add `Rationale:` when the implementation choice is non-obvious. Preserve the triggering scenario, consequence, resulting behavior, sibling coverage, and exact verification rather than compressing them into a vague summary. Check the proposal before creating the commit:

   ```sh
   node <skill-dir>/scripts/review-loop.mjs check-commit-message \
     --subject "<product behavior>" \
     --body-file "<path-to-proposed-body>"
   ```

   When an explicit repository policy conflicts with the default message format, add `--repository-policy "<source>"`; this keeps the prospective-only and no-workflow-narration safeguards while deferring the format to that policy. If the product itself exposes reviewer-provider behavior and its legitimate names trigger the broad attribution check, add `--product-terms "<why these names describe the product>"`; this never permits workflow narration or AI co-authoring. Only create the commit when the proposal is clean. Do not stage unrelated user changes. Once a commit exists, do not run the check against it—apply any improvement to the next proposal instead.

7. Re-run `review` after all repairs, verification, and any authorized commit. Each command invokes exactly one reviewer round over the full current scope, not only the latest patch. Continue until the engine returns `clean`.

8. If all valid findings are out of scope, stop and surface them. If the engine reports oscillation, a round limit, an invalid response, or a provider failure, follow the escalation rules in the protocol. Never reinterpret those states as clean.

9. After a clean result, do not edit, format, stage, commit, amend, or rebase. Finish the exact reviewed snapshot:

   ```sh
   node <skill-dir>/scripts/review-loop.mjs finish --reason clean
   ```

   `finish --reason clean` succeeds only when the current snapshot is exactly the snapshot that received the clean review. Any later Git-scope change requires another review.

10. Report the provider, round count, final verification, and any explicitly accepted out-of-scope items. Do not advertise the workflow in product code, code comments, documentation, commit subjects, commit bodies, or trailers.

## Stop and resume

The engine writes only below the repository's Git directory. It has no timer, daemon, cron, hook, or heartbeat. If the host turn ends, run `status`, continue the pending work, and invoke the next round manually.

To close a deliberately abandoned or wholly out-of-scope run:

```sh
node <skill-dir>/scripts/review-loop.mjs finish --reason stopped
node <skill-dir>/scripts/review-loop.mjs finish --reason out-of-scope
```

Never use either reason to represent a clean review.
