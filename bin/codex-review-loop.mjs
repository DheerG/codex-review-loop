#!/usr/bin/env node

import { main } from "../plugins/codex-review-loop/skills/review-until-clean/scripts/review-loop.mjs";

process.exitCode = await main(process.argv.slice(2));
