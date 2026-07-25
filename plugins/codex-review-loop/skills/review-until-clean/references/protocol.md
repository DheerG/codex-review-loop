# Independent review protocol

## Invariants

1. The reviewer is independent and read-only. The host agent is the only writer.
2. Every round examines the entire current Git scope:
   - committed changes from the selected base through `HEAD`;
   - staged changes;
   - unstaged changes;
   - untracked files.
3. A repair never narrows the next review to the repair patch.
4. Only the exact clean sentinel produced by a structurally valid response is clean.
5. Reviewer text is relayed verbatim before repair work, followed by a one-line host disposition.
6. Delivery follows a clean review of the exact delivered snapshot plus passing hygiene.

## Triage

A finding is in scope when it identifies an actionable correctness, security, reliability, data-integrity, compatibility, or material performance problem introduced by the current change and repairing it supports the approved outcome.

Fix in-scope findings. Record ambiguous and out-of-scope findings without silently expanding the task. When every finding in a valid round is out of scope, stop the loop and ask the user whether to expand scope; do not manufacture an extra clean round.

Treat style preferences, speculative redesigns, pre-existing defects, and requests contrary to the approved outcome as out of scope unless they reveal a functional defect in the current change.

## Valid responses

A finding response contains `Full review comments:` and one or more lines shaped like:

```text
- [P1] Short imperative title — path/to/file.ext:42
```

Priorities are `P0` through `P3`. A clean response contains this exact line and no finding lines:

```text
NO_IN_SCOPE_FUNCTIONAL_FINDINGS
```

Empty output, malformed output, a clean sentinel mixed with findings, or general praise without the sentinel is invalid.

## Escalation

- **Invalid response:** retry once with the same provider. If still invalid, select another available provider or ask the user.
- **Provider unavailable or rate limited:** do not wait in the background. Report the condition and let the user retry or select another provider.
- **Oscillation:** when substantially the same finding returns in three rounds, stop and show the finding plus the attempted fixes. Ask whether to change approach, accept the issue, or expand scope.
- **Round limit:** the default backstop is 20. Stop and summarize the unresolved findings and repair attempts.
- **Verification failure:** diagnose and repair if caused by in-scope changes; otherwise surface it. Never call the run clean while relevant verification fails.

The loop has no heartbeat. Progress occurs only through explicit `review`, repair, verification, and `finish` actions.
