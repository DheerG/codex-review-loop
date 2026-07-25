# Contribution instructions

- Keep the review engine dependency-free and compatible with Node.js 18 or newer.
- Keep provider adapters read-only. The host harness, never the reviewer process, owns edits.
- Preserve full-scope review semantics across committed, staged, unstaged, and untracked changes.
- Store runtime state below the target repository's Git directory; do not add project files.
- Do not add timers, hooks, daemons, cron jobs, or heartbeat behavior.
- Product code and Git history describe product behavior, not reviewer rounds or AI attribution.
- Keep the five release versions synchronized with `npm run version:check`; use
  `npm run version:set -- <semver>` when changing them locally.
- Run `npm run validate` and both plugin validators before delivery.
