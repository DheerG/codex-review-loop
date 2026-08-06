# Codex Review Loop

A portable independent-review loop for coding agents. It asks a read-only reviewer to inspect the complete current Git scope, lets the host agent repair valid findings, and repeats until the exact delivered snapshot receives a clean result.

Codex is the preferred reviewer. Gemini CLI, Claude Code, OpenCode, and a custom command are also supported. The host harness can be Claude Code, Codex, OpenCode, Gemini CLI, or any Agent Skills-compatible tool.

## What it guarantees

- Every round reviews committed branch changes, staged changes, unstaged changes, and untracked files.
- Repairs never narrow the next round to only the latest patch.
- The reviewer cannot write; the host agent owns edits, verification, and triage.
- Empty or malformed reviewer output is not clean.
- Native Codex review preserves only the user's configured model and reasoning effort.
- Codex-native explicit clean verdicts are accepted without weakening other providers' output contracts.
- A clean result is bound to a content snapshot. Editing afterward invalidates it.
- Runtime state and raw rounds live below the target repository's Git directory.
- There is no Stop hook, daemon, cron job, scheduled task, timer, or heartbeat.
- A prospective commit-message check keeps review-fix commits product-focused without rewriting existing history.

## Requirements

- Git
- Node.js 18 or newer
- At least one reviewer CLI: `codex`, `gemini`, `claude`, `opencode`, or a custom command

Run `node plugins/codex-review-loop/skills/review-until-clean/scripts/review-loop.mjs doctor` to inspect local availability.

## Quick start

### Claude Code

```sh
claude plugin marketplace add DheerG/codex-review-loop
claude plugin install codex-review-loop@codex-review-loop --scope user
```

Restart Claude Code, then invoke:

```text
/codex-review-loop:review-until-clean make this branch ready to ship
```

### Codex

```sh
codex plugin marketplace add DheerG/codex-review-loop
```

Install `codex-review-loop` from that marketplace in the Codex plugin UI, then invoke:

```text
$codex-review-loop:review-until-clean make this branch ready to ship
```

### OpenCode, Gemini CLI, and other Agent Skills harnesses

Clone the repository once:

```sh
git clone https://github.com/DheerG/codex-review-loop.git
cd codex-review-loop
```

Then install the entry points you need:

```sh
node plugins/codex-review-loop/scripts/install.mjs --harness opencode
node plugins/codex-review-loop/scripts/install.mjs --harness gemini
node plugins/codex-review-loop/scripts/install.mjs --harness agents
```

Use `--harness all` to install all three. Existing targets are preserved unless `--force` is supplied. To update, pull a release tag or the latest `main` and rerun the installer with `--force`.

## Development setup

### Claude Code

For local development, launch Claude Code with:

```sh
claude --plugin-dir ./plugins/codex-review-loop
```

Invoke:

```text
/codex-review-loop:review-until-clean make this branch ready to ship
```

The repository contains `.claude-plugin/marketplace.json` for public marketplace distribution.

### Codex

Add this local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/codex-review-loop
```

Install `codex-review-loop` from that marketplace in the Codex plugin UI, then invoke:

```text
$codex-review-loop:review-until-clean make this branch ready to ship
```

The plugin uses the standard `.codex-plugin/plugin.json` plus `skills/` layout and is catalogued by `.agents/plugins/marketplace.json`.

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

The agent-facing skill drives repairs. The companion command provides durable review state, independent provider calls, response validation, and a prospective check for review-fix commit messages:

```sh
npm link
```

Then, from the repository being reviewed:

```sh
codex-review-loop doctor
codex-review-loop start --outcome "Preserve the public API while fixing retries"
codex-review-loop review
codex-review-loop status
# After a finding is repaired, and only when a commit is already authorized:
codex-review-loop check-commit-message \
  --subject "Preserve errors across retry exhaustion" \
  --body-file /tmp/proposed-commit-body.txt
# Create the repair commit, then review the resulting snapshot:
codex-review-loop review
codex-review-loop finish --reason clean
```

During development, use the script directly:

```sh
node plugins/codex-review-loop/skills/review-until-clean/scripts/review-loop.mjs \
  start --outcome "Preserve the public API while fixing retries"
```

`doctor` reports provider availability after the same Codex isolation preflight used by `start`, resolves a repository subdirectory to its Git top level, honors `--cwd` outside repositories, and includes a Codex rejection reason when managed configuration is unsafe. `finish --reason clean` rejects an unclean last result or a changed post-review snapshot. It never scans or rewrites commit history after a clean review.

Each `review` command invokes exactly one reviewer round. `start` resolves the selected comparison ref to an immutable commit before storing the run, so later repair commits cannot move its boundary. Older active runs resolve their stored ref during migration and fail closed if its original commit cannot be recovered; `finish --reason stopped` remains available to archive that state. An invalid response exits nonzero because it is not clean; inspect the returned status before retrying. Do not attach a shell `||` fallback to `review`, because that can mistake an invalid result for a failed invocation and consume an unintended second round.

## Providers

`--provider auto` selects the first installed provider in this order:

1. Codex
2. Gemini CLI
3. Claude Code
4. OpenCode

Codex runs in native review mode, explicitly forces its read-only sandbox and `never` approval policy, clears legacy notification commands, and disables lifecycle hooks, apps, plugins, automated approval guardians, and every supported current or legacy multi-agent feature variant. Before invoking the reviewer, the adapter verifies that those feature disables are effective, so higher-precedence managed configuration cannot silently restore write-capable tools. User configuration is ignored by the reviewer process except for statically allowlisted `model` and `model_reasoning_effort` values, which are passed as CLI overrides; `--isolate-codex-config` omits even those preferences. The target project is forced untrusted, and user/project execpolicy rules are ignored, so branch-controlled `.codex/config.toml`, hooks, rules, and prompt instructions are never loaded or read by the adapter. System TOML is read through a regular-file and one-megabyte bound to discover MCP server names; prompt-affecting or automated-approval system settings fail closed. Every server name is disabled without launching a process, contacting an endpoint, or forwarding URLs, commands, credentials, or transport details. Managed MCP definitions, notification commands, write-capable sandbox settings, custom or write-capable default-permission profiles, automated approval settings, trusted-project settings, prompt overrides, or forced reviewer features fail closed; only the built-in `:read-only` default-permission profile is accepted. This includes machine policy under ProgramData or the real Codex home on Windows. Cloud-managed MCP requirements are restrictive identity allowlists and cannot introduce server transports. The adapter probes the installed Codex feature inventory and omits flags unknown to older compatible releases. Authentication is still reused from the real Codex home. Codex has no default round cap; other providers stop at 15 rounds unless `--max-rounds` is supplied.

The Codex adapter recognizes structurally isolated native clean verdicts such as `No actionable defects found.`, including a Markdown-formatted `Verdict:` or `Result:` label. Other providers remain bound to the exact clean sentinel. For every provider, the clean verdict must be the sole non-empty output line.

Use `--provider custom` with a directly executed JSON command:

```sh
export CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON='["my-reviewer","--read-only"]'
codex-review-loop start --provider custom --outcome "..."
```

The review prompt is sent to standard input. Custom provider sandboxing is the operator's responsibility.

## Review-fix commit policy

Fixes should read as intentional product work. Do not add “found by Codex,” “AI suggested,” or “review round” narration to code comments, docs, strings, tests, commits, or trailers.

- Existing branch history is immutable input. The loop never audits its message quality or requires an amend, rebase, squash, or commit recreation to pass a post-review gate.
- If a repair commit is already authorized, create it before the next review and group it by product behavior or root cause, not reviewer round.
- Resolve message guidance prospectively: explicit user instructions first, then explicit repository rules, then the plugin default. Repository rules apply where they speak; the default fills unspecified fields. Existing messages are examples, not a policy or compliance target.
- By default, use an imperative subject of at most 72 characters with no trailing period. Use `Failure:`, `Change:`, and `Verification:` body sections, plus `Rationale:` when the implementation choice is non-obvious.
- Preserve the triggering scenario, consequence, resulting behavior, sibling coverage, and exact checks run. Do not defend the change or discuss the review process.
- Review the repository again after creating the commit, because the commit changes the bound Git snapshot.

Validate the proposed message before committing:

```sh
codex-review-loop check-commit-message \
  --subject "Preserve errors across retry exhaustion" \
  --body-file /tmp/proposed-commit-body.txt
```

When explicit user or repository guidance overrides a default field, identify it with `--policy "<user instruction or repository source>"` and `--policy-overrides subject`, `body`, or `all`. Defaults remain active for every field not named by the override, while prospective-only and no-workflow-narration safeguards always remain active. If the repository itself implements reviewer-provider behavior, `--product-terms "<justification>"` permits legitimate product names in that proposal without permitting attribution grammar or AI co-authoring. The command checks only the supplied proposal; it never reads, grades, or mutates Git history. Once a commit exists, leave it unchanged and apply any improvement to the next proposal.

## Development

```sh
npm test
npm run validate
npm run version:check
```

The implementation has no runtime dependencies.

## Releases

Every merge to `main` receives a SemVer bump, immutable `v<version>` tag, and GitHub Release. The merged pull request controls the bump:

- `major` label: increment the major version;
- `minor` label: increment the minor version;
- no release label: increment the patch version.

The release workflow synchronizes `package.json`, both plugin manifests, and both marketplace entries before tagging. CI rejects version drift.

Repository setup:

1. Create the `major` and `minor` pull-request labels.
2. Give GitHub Actions read/write repository permission.
3. Permit `github-actions[bot]` to push its version-only commit to `main`. If branch rules do not allow that, add a write-capable `DEPLOY_KEY` repository secret, as used by the checkout step.

The workflow can be recovered manually from the Actions tab with an optional merge commit SHA. Tags are never force-moved.

## License

MIT. See [NOTICE](NOTICE) for review-rubric provenance.
