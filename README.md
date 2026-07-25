# Codex Review Loop

A portable independent-review loop for coding agents. It asks a read-only reviewer to inspect the complete current Git scope, lets the host agent repair valid findings, and repeats until the exact delivered snapshot receives a clean result.

Codex is the preferred reviewer. Gemini CLI, Claude Code, OpenCode, and a custom command are also supported. The host harness can be Claude Code, Codex, OpenCode, Gemini CLI, or any Agent Skills-compatible tool.

## What it guarantees

- Every round reviews committed branch changes, staged changes, unstaged changes, and untracked files.
- Repairs never narrow the next round to only the latest patch.
- The reviewer cannot write; the host agent owns edits, verification, and triage.
- Empty or malformed reviewer output is not clean.
- A clean result is bound to a content snapshot. Editing afterward invalidates it.
- Runtime state and raw rounds live below the target repository's Git directory.
- There is no Stop hook, daemon, cron job, scheduled task, timer, or heartbeat.
- A hygiene gate catches whitespace, weak or workflow-narrating commit messages, AI co-author trailers, and attribution added to product artifacts.

## Requirements

- Git
- Node.js 18 or newer
- At least one reviewer CLI: `codex`, `gemini`, `claude`, `opencode`, or a custom command

Run `node plugins/codex-review-loop/skills/review-until-clean/scripts/review-loop.mjs doctor` to inspect local availability.

## Harness setup

### Claude Code

For local development, launch Claude Code with:

```sh
claude --plugin-dir ./plugins/codex-review-loop
```

Invoke:

```text
/codex-review-loop:review-until-clean make this branch ready to ship
```

The repository also contains `.claude-plugin/marketplace.json` for marketplace distribution.

### Codex

Add this local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/codex-review-loop
```

Install `codex-review-loop` from that marketplace in the Codex plugin UI, then invoke:

```text
$codex-review-loop:review-until-clean make this branch ready to ship
```

The plugin uses the standard `.codex-plugin/plugin.json` plus `skills/` layout.

### OpenCode

Install the shared skill and command:

```sh
node plugins/codex-review-loop/scripts/install.mjs --harness opencode
```

Invoke:

```text
/review-until-clean make this branch ready to ship
```

### Gemini CLI

Install the shared skill and command:

```sh
node plugins/codex-review-loop/scripts/install.mjs --harness gemini
```

Invoke:

```text
/review-until-clean make this branch ready to ship
```

### Other Agent Skills harnesses

```sh
node plugins/codex-review-loop/scripts/install.mjs --harness agents
```

This installs `review-until-clean` in `~/.agents/skills/`. Existing targets are never replaced unless `--force` is supplied.

## Put it in a plan

Ask the harness to use the skill while planning:

```text
Use review-until-clean in the implementation plan. The final delivery step
must run after implementation and verification.
```

In a read-only planning mode, the skill adds a required step:

```text
Run review-until-clean after implementation and verification; delivery is
blocked until the loop is clean or an exception is explicitly accepted.
```

The planner does not pretend to execute the loop. The execution step runs after write access is granted.

## Direct command

The agent-facing skill drives repairs. The companion command provides the durable review state, independent provider call, response validation, and hygiene enforcement:

```sh
npm link
```

Then, from the repository being reviewed:

```sh
codex-review-loop doctor
codex-review-loop start --outcome "Preserve the public API while fixing retries"
codex-review-loop review
codex-review-loop status
codex-review-loop hygiene
codex-review-loop finish --reason clean
```

During development, use the script directly:

```sh
node plugins/codex-review-loop/skills/review-until-clean/scripts/review-loop.mjs \
  start --outcome "Preserve the public API while fixing retries"
```

`finish --reason clean` rejects an unclean last result, a changed post-review snapshot, and failed hygiene.

## Providers

`--provider auto` selects the first installed provider in this order:

1. Codex
2. Gemini CLI
3. Claude Code
4. OpenCode

Use `--provider custom` with a directly executed JSON command:

```sh
export CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON='["my-reviewer","--read-only"]'
codex-review-loop start --provider custom --outcome "..."
```

The review prompt is sent to standard input. Custom provider sandboxing is the operator's responsibility.

## Hygiene policy

Fixes should read as intentional product work. Do not add “found by Codex,” “AI suggested,” or “review round” narration to code comments, docs, strings, tests, commits, or trailers. Commit subjects describe product behavior and commits are grouped by behavior or root cause, not reviewer round.

Projects that genuinely implement reviewer-provider behavior can justify product-domain terms for the exact snapshot:

```sh
codex-review-loop hygiene \
  --justify-product-terms "The product exposes reviewer-provider configuration"
```

The exception never waives whitespace or commit-message quality failures.

## Development

```sh
npm test
npm run validate
```

The implementation has no runtime dependencies.

## License

MIT. See [NOTICE](NOTICE) for review-rubric provenance.
