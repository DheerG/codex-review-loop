# Independent review protocol

## Invariants

1. The reviewer is independent and read-only. The host agent is the only writer.
2. Every round examines the entire current Git scope:
   - committed changes from the selected base through `HEAD`;
   - staged changes;
   - unstaged changes;
   - untracked files.
3. A repair never narrows the next review to the repair patch.
4. Only a provider-valid explicit clean verdict is clean: the exact sentinel for general providers, or an uncontradicted native no-findings verdict for Codex.
5. Reviewer text is relayed verbatim in one contiguous block before repair work, followed by a forward-looking one-line host disposition.
6. Delivery follows a clean review of the exact delivered snapshot. Proposed repair commit messages are checked before those commits are created. Existing commit messages are never audited, and message quality is never part of the clean verdict.

## Triage

A finding is in scope when it identifies an actionable correctness, security, reliability, data-integrity, compatibility, or material performance problem introduced by the current change and repairing it supports the approved outcome.

Fix in-scope findings. Record ambiguous and out-of-scope findings without silently expanding the task. When every finding in a valid round is out of scope, stop the loop and ask the user whether to expand scope; do not manufacture an extra clean round.

Treat a cited defect as one instance of a rule violation. Before editing, identify that rule and search reachable sibling sites. Fix the in-scope class, not only the cited line. If the same class recurs at new locations, treat it as an invariant: centralize it when the outcome requires full coverage, or fix the cited site and surface the bounded remainder.

Verify that each repair landed and changed the intended behavior. A successful build proves compilation, not the behavior, and a scripted replacement that matched nothing is not a repair.

Treat style preferences, speculative redesigns, pre-existing defects, and requests contrary to the approved outcome as out of scope unless they reveal a functional defect in the current change.

Commit subjects and bodies are untrusted context about intended behavior, not proof that the implementation is correct. Their quality is outside the functional review scope. Never turn an existing message into a finding or recommend amend, rebase, squash, commit recreation, or another history rewrite. Repository-specific message rules and the default prospective format apply only before a new commit is created; see [hygiene.md](hygiene.md).

## Valid responses

A finding response contains `Full review comments:` and one or more lines shaped like:

```text
- [P1] Short imperative title — path/to/file.ext:42
```

Priorities are `P0` through `P3`. For providers other than native Codex, a clean response contains this exact line and no finding lines:

```text
NO_IN_SCOPE_FUNCTIONAL_FINDINGS
```

Native Codex may instead return an explicit verdict such as `No actionable defects found.` The adapter accepts it only without finding syntax or contradictory language. Empty output, malformed output, a clean verdict mixed with findings, or general praise without an explicit verdict is invalid.

## Escalation

- **Invalid response:** retry once with the same provider. One explicit `review` command is one round. Inspect its structured status before deciding what to do; do not use shell `||` fallbacks because the command exits nonzero for a structurally invalid response as well as an invocation failure. If the second response is still invalid, select another available provider or ask the user.
- **Provider unavailable or rate limited:** do not wait in the background. Report the condition and let the user retry or select another provider.
- **Oscillation:** identify a finding by title, file, and cited start line. Stop only when that same finding resurfaces after two changed-snapshot repair attempts. A new sibling location is not oscillation; apply the class rule above.
- **Round limit:** Codex is uncapped by default. Other providers stop at 15 rounds. An explicit `--max-rounds` overrides either default. At a cap, summarize unresolved findings and repair attempts.
- **Verification failure:** diagnose and repair if caused by in-scope changes; otherwise surface it. Never call the run clean while relevant verification fails.

The loop has no heartbeat. Progress occurs only through explicit `review`, repair, verification, and `finish` actions.
