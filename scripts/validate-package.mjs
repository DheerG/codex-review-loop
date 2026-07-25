#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  "plugins/codex-review-loop/.codex-plugin/plugin.json",
  "plugins/codex-review-loop/.claude-plugin/plugin.json",
  "plugins/codex-review-loop/skills/review-until-clean/SKILL.md",
  "plugins/codex-review-loop/harnesses/opencode/commands/review-until-clean.md",
  "plugins/codex-review-loop/harnesses/gemini/commands/review-until-clean.toml",
];

function fail(message) {
  throw new Error(message);
}

for (const relativePath of requiredFiles) {
  if (!existsSync(path.join(root, relativePath))) {
    fail(`Missing required package file: ${relativePath}`);
  }
}

const codexMarketplace = JSON.parse(
  readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"),
);
const claudeMarketplace = JSON.parse(
  readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"),
);
const codexManifest = JSON.parse(
  readFileSync(
    path.join(root, "plugins/codex-review-loop/.codex-plugin/plugin.json"),
    "utf8",
  ),
);
const claudeManifest = JSON.parse(
  readFileSync(
    path.join(root, "plugins/codex-review-loop/.claude-plugin/plugin.json"),
    "utf8",
  ),
);

for (const [name, value] of [
  ["Codex manifest", codexManifest.name],
  ["Claude manifest", claudeManifest.name],
  ["Codex marketplace entry", codexMarketplace.plugins?.[0]?.name],
  ["Claude marketplace entry", claudeMarketplace.plugins?.[0]?.name],
]) {
  if (value !== "codex-review-loop") {
    fail(`${name} has unexpected plugin name: ${String(value)}`);
  }
}

const codexSource = codexMarketplace.plugins?.[0]?.source?.path;
if (
  typeof codexSource !== "string" ||
  !existsSync(path.resolve(root, codexSource))
) {
  fail("Codex marketplace source does not resolve to the plugin directory");
}
const claudeSource = claudeMarketplace.plugins?.[0]?.source;
if (
  typeof claudeSource !== "string" ||
  !existsSync(path.resolve(root, claudeSource))
) {
  fail("Claude marketplace source does not resolve to the plugin directory");
}

const skill = readFileSync(
  path.join(
    root,
    "plugins/codex-review-loop/skills/review-until-clean/SKILL.md",
  ),
  "utf8",
);
if (
  !/^---\nname: review-until-clean\ndescription: .+\n---\n/u.test(skill) ||
  skill.includes("[TODO:")
) {
  fail("Skill frontmatter is invalid or contains a scaffold placeholder");
}

const openCodeCommand = readFileSync(
  path.join(
    root,
    "plugins/codex-review-loop/harnesses/opencode/commands/review-until-clean.md",
  ),
  "utf8",
);
if (!openCodeCommand.includes("$ARGUMENTS")) {
  fail("OpenCode command does not forward command arguments");
}

const geminiCommand = readFileSync(
  path.join(
    root,
    "plugins/codex-review-loop/harnesses/gemini/commands/review-until-clean.toml",
  ),
  "utf8",
);
if (
  !geminiCommand.includes('description = "') ||
  !geminiCommand.includes('prompt = """') ||
  !geminiCommand.includes("{{args}}")
) {
  fail("Gemini command is missing required TOML fields or argument forwarding");
}

for (const relativePath of [
  "bin/codex-review-loop.mjs",
  "plugins/codex-review-loop/scripts/install.mjs",
  "plugins/codex-review-loop/skills/review-until-clean/scripts/review-loop.mjs",
]) {
  if ((statSync(path.join(root, relativePath)).mode & 0o111) === 0) {
    fail(`Command is not executable: ${relativePath}`);
  }
}

process.stdout.write("Package structure is valid\n");
