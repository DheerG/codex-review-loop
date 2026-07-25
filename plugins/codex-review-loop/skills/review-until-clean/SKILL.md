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

   Add `--base <ref>` only when needed. An active run is resumable with `status`; never start a second run over it.

3. Invoke one independent review:

   ```sh
   node <skill-dir>/scripts/review-loop.mjs review
   ```

4. Relay the reviewer's complete output verbatim before making fixes, then add a one-line disposition: fix, out of scope, ambiguous, invalid response, or provider failure. A clean round is relayed too.

5. Triage every finding against the outcome. Fix in-scope functional defects at their cause, not merely at the cited line. Preserve unrelated user changes. Run the smallest relevant verification after each repair set.

6. Re-run `review`. Each round reviews the full current scope, not only the latest patch. Continue until the engine returns `clean`.

7. If all valid findings are out of scope, stop and surface them. If the engine reports oscillation, a round limit, an invalid response, or a provider failure, follow the escalation rules in the protocol. Never reinterpret those states as clean.

8. Run repository verification, then enforce hygiene:

   ```sh
   node <skill-dir>/scripts/review-loop.mjs hygiene
   node <skill-dir>/scripts/review-loop.mjs finish --reason clean
   ```

   `finish --reason clean` succeeds only when the current snapshot is exactly the snapshot that received a clean review and hygiene passes. Any later edit requires another review.

9. Report the provider, round count, final verification, and any explicitly accepted out-of-scope items. Do not advertise the workflow in product code, code comments, documentation, commit subjects, commit bodies, or trailers.

## Stop and resume

The engine writes only below the repository's Git directory. It has no timer, daemon, cron, hook, or heartbeat. If the host turn ends, run `status`, continue the pending work, and invoke the next round manually.

To close a deliberately abandoned or wholly out-of-scope run:

```sh
node <skill-dir>/scripts/review-loop.mjs finish --reason stopped
node <skill-dir>/scripts/review-loop.mjs finish --reason out-of-scope
```

Never use either reason to represent a clean review.
