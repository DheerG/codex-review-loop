# Reviewer providers

The engine selects the first installed provider in this order when `--provider auto` is used: Codex, Gemini CLI, Claude Code, then OpenCode.

| Provider | Command | Read-only mechanism |
| --- | --- | --- |
| `codex` | `codex exec review --ephemeral --ignore-user-config -` | Native Codex review mode |
| `gemini` | `gemini -p ... --output-format json` | Explicit review-only prompt |
| `claude` | `claude -p ... --permission-mode plan --tools Bash,Read,Glob,Grep` | Plan permission mode and read tools |
| `opencode` | `opencode run --agent plan ...` | Plan agent |
| `custom` | JSON command from an environment variable | Explicit review-only prompt; operator supplies sandboxing |

Use `doctor` to see which binaries are available. Provider choice is stored in the active run; a saved preference never proves that a binary or account is currently available.

The Codex adapter ignores user configuration so unrelated or stale settings cannot change or break the reviewer. Codex authentication is still reused. The review is ephemeral and does not add a saved Codex session.

## Custom provider

Set `CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON` to a JSON array. The engine sends the review prompt on standard input and treats standard output as the review:

```sh
export CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON='["my-reviewer","--read-only"]'
node <skill-dir>/scripts/review-loop.mjs start --provider custom --outcome "..."
```

The command is executed directly without a shell. Do not place secrets in its arguments.

`CODEX_REVIEW_LOOP_TIMEOUT_MS` controls one provider call and defaults to 1,200,000 milliseconds. A timeout stops that round; it does not create a waiter.

## Switching providers

Close a stopped run and start a new run with another provider. Do not edit the state file by hand. The next run still reviews the full current scope.
