# Reviewer providers

The engine selects the first installed provider in this order when `--provider auto` is used: Codex, Gemini CLI, Claude Code, then OpenCode.

| Provider | Command | Read-only mechanism |
| --- | --- | --- |
| `codex` | Isolated `codex exec review` invocation | Read-only sandbox; notifications cleared; hooks, apps, plugins, supported subagent features, and discovered MCP servers disabled and verified |
| `gemini` | `gemini -p ... --output-format json` | Explicit review-only prompt |
| `claude` | `claude -p ... --permission-mode plan --tools Bash,Read,Glob,Grep` | Plan permission mode and read tools |
| `opencode` | `opencode run --agent plan ...` | Plan agent |
| `custom` | JSON command from an environment variable | Explicit review-only prompt; operator supplies sandboxing |

Use `doctor` to see which providers pass their availability checks. Codex uses the same feature and managed-configuration safety preflight as `start`, honors the requested `--cwd`, and explains a rejection. Provider choice is stored in the active run; a saved preference never proves that a binary or account is currently available.

The Codex adapter inherits the user's configured model and reasoning effort so review depth matches direct Codex use. Before each round it statically reads ordinary user and system TOML plus project TOML only when effective project trust is `trusted`, including multiline inline tables, for active MCP server names. Pre-0.134 profile selection is resolved across the complete active layer stack before any layer is inspected. It supplies disabled server definitions without starting a transport, contacting an endpoint, or forwarding original URLs, commands, credentials, or transport details. It also clears legacy notification commands. MCP definitions, notification commands, write-capable sandbox/default-permission settings, or forced reviewer features in higher-precedence managed defaults fail closed, including both ProgramData and real-home policy on Windows. Cloud-managed MCP requirements are restrictive identity allowlists and cannot introduce transports. The adapter feature-probes the installed CLI, disables lifecycle hooks, apps, plugins, and every exposed current or legacy multi-agent variant, then verifies their effective states so managed defaults cannot silently re-enable them. Unknown newer feature names are omitted for compatibility with older Codex releases. The adapter also forces the native read-only sandbox and uses `--ephemeral` to prevent a saved session. `start --isolate-codex-config` skips user config while keeping its temporary feature-probe home below the repository's Git runtime-state directory and separately inspecting real managed layers. Authentication is still reused.

Codex keeps its native review output. An explicit native verdict such as `No actionable defects found.` or `No in-scope functional findings.` is clean only when it is the sole non-empty output line; Markdown emphasis and a `Verdict:` or `Result:` label are allowed on that line. Other providers use the exact clean sentinel under the same isolated-line rule.

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
