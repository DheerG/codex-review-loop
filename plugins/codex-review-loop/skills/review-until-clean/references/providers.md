# Reviewer providers

The engine selects the first installed provider in this order when `--provider auto` is used: Codex, Gemini CLI, Claude Code, then OpenCode.

| Provider | Command | Read-only mechanism |
| --- | --- | --- |
| `codex` | Isolated `codex exec review` invocation | Read-only sandbox; hooks, apps, subagents, and discovered MCP servers disabled |
| `gemini` | `gemini -p ... --output-format json` | Explicit review-only prompt |
| `claude` | `claude -p ... --permission-mode plan --tools Bash,Read,Glob,Grep` | Plan permission mode and read tools |
| `opencode` | `opencode run --agent plan ...` | Plan agent |
| `custom` | JSON command from an environment variable | Explicit review-only prompt; operator supplies sandboxing |

Use `doctor` to see which binaries are available. Provider choice is stored in the active run; a saved preference never proves that a binary or account is currently available.

The Codex adapter inherits the user's configured model and reasoning effort so review depth matches direct Codex use. Before each non-isolated round it inventories effective MCP servers and supplies inert disabled definitions for every enabled server without forwarding original URLs, commands, credentials, or transport details. It also disables lifecycle hooks, apps, and subagents, forces the native read-only sandbox, and uses `--ephemeral` to prevent a saved session. If the MCP inventory cannot be read safely, the round fails closed. `start --isolate-codex-config` skips user MCP discovery because that configuration is ignored; authentication is still reused.

Codex keeps its native review output. An explicit native verdict such as `No actionable defects found.` or `No in-scope functional findings.` is clean only when it is the sole non-empty output line. Other providers use the exact clean sentinel under the same isolated-line rule.

## Custom provider

Set `CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON` to a JSON array. The engine sends the review prompt on standard input and treats standard output as the review:

```sh
export CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON='["my-reviewer","--read-only"]'
node <skill-dir>/scripts/review-loop.mjs start --provider custom --outcome "..."
```

The command is executed directly without a shell. Do not place secrets in its arguments.

`CODEX_REVIEW_LOOP_TIMEOUT_MS` controls one provider call and defaults to 1,200,000 milliseconds. A timeout stops that round; it does not create a waiter.

Codex has no default round cap. Other providers default to 15 rounds. `start --max-rounds <1-100>` sets an explicit cap for any provider.

## Switching providers

Close a stopped run and start a new run with another provider. Do not edit the state file by hand. The next run still reviews the full current scope.
