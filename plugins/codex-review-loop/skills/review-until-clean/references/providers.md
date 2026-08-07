# Reviewer providers

The engine selects the first installed provider in this order when `--provider auto` is used: Codex, Gemini CLI, Claude Code, then OpenCode.

| Provider | Command | Read-only mechanism |
| --- | --- | --- |
| `codex` | Isolated `codex exec review` invocation | Read-only sandbox; notifications cleared; optional tools/workflows default-denied; discovered MCP servers disabled and verified |
| `gemini` | `gemini -p ... --output-format json` | Explicit review-only prompt |
| `claude` | `claude -p ... --permission-mode plan --tools Bash,Read,Glob,Grep` | Plan permission mode and read tools |
| `opencode` | `opencode run --agent plan ...` | Plan agent |
| `custom` | JSON command from an environment variable | Explicit review-only prompt; operator supplies sandboxing |

Use `doctor` to see which providers pass their availability checks. Codex uses the same feature and managed-configuration safety preflight as `start`, honors the requested `--cwd`, and explains a rejection. Provider choice is stored in the active run; a saved preference never proves that a binary or account is currently available.

The Codex adapter statically copies only the user's `review_model`, `model`, and `model_reasoning_effort` values into CLI overrides so review depth matches direct Codex use without importing prompt-affecting configuration. `review_model` and selected legacy-profile values take precedence over the general model for native review. If a copied model depends on a custom provider, a built-in endpoint override, or a model catalog that isolation removes, preflight fails; `start --isolate-codex-config` omits all three allowlisted preferences and their dependency check. It invokes Codex with user config ignored, approvals forced to `never`, and the target project forced untrusted, so branch-controlled `.codex/config.toml`, hooks, rules, and prompt instructions remain inactive. System, managed, and requirements files are accepted only as bounded regular files. Active system MCP server names are supplied as disabled definitions without starting a transport, contacting an endpoint, or forwarding original URLs, commands, credentials, or transport details; prompt-affecting settings, including personalities and model catalogs, and automated-approval system settings fail closed. System and macOS MDM requirements must permit read-only execution, `never` approval, user-owned approval review, the built-in `:read-only` permission profile, and disabled reviewer features before Codex is considered ready. Managed MCP definitions, notification commands, write-capable sandbox settings, custom or write-capable default-permission profiles, automated approval settings, trusted-project settings, prompt overrides, or forced reviewer features fail closed; only the built-in `:read-only` default-permission profile is accepted. This includes both ProgramData and real-home policy on Windows.

The adapter feature-probes the installed CLI and disables every supported optional feature except a small allowlist for model transport and sandboxed local shell inspection. This default-deny rule covers current and future external tools, lifecycle hooks, apps, plugins, approval workflows, dependency installers, searches, and subagent variants while omitting flags unknown to older releases. Because the CLI feature-list command cannot ignore user config, every probe uses a private clean Codex home below Git runtime state. The adapter copies only the current authentication identity into that home, performs a configuration-only early-exit probe, and bounds and checks both cloud-managed config fragments and cloud requirements before any session, model, transport, hook, or tool starts. Cloud-defined MCP transports and forced unsafe features therefore fail closed. The real reviewer reuses the resulting authenticated policy snapshot, after which the temporary identity and cache are deleted. It uses the native read-only sandbox unless managed policy selects the built-in `:read-only` permission profile, where adding a sandbox override would conflict, and uses `--ephemeral` to prevent a saved session.

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
