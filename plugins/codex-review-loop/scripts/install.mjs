#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Install portable review-until-clean entry points.

Usage:
  node scripts/install.mjs --harness agents|opencode|gemini|all [--force]
                           [--home <path>] [--dry-run]

agents    Install the shared Agent Skill in ~/.agents/skills
opencode  Install the shared skill plus an OpenCode command
gemini    Install the shared skill plus a Gemini CLI command
all       Install all three targets

Existing targets are preserved unless --force is supplied.`;
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (["--force", "--dry-run", "--help"].includes(item)) {
      options[item.slice(2)] = true;
      continue;
    }
    if (!["--harness", "--home"].includes(item)) {
      throw new Error(`Unknown option: ${item}`);
    }
    if (!argv[index + 1]) throw new Error(`${item} requires a value`);
    options[item.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function copy(source, destination, options, installed) {
  if (existsSync(destination) && !options.force) {
    throw new Error(
      `Target exists: ${destination}. Re-run with --force to replace it.`,
    );
  }
  installed.push({ source, destination });
  if (options["dry-run"]) return;
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    force: Boolean(options.force),
    errorOnExist: !options.force,
  });
}

function main(argv) {
  const options = parse(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const harness = options.harness;
  if (!["agents", "opencode", "gemini", "all"].includes(harness)) {
    throw new Error("--harness must be agents, opencode, gemini, or all");
  }
  const userHome = path.resolve(options.home ?? os.homedir());
  const installed = [];
  const wantsSkill = ["agents", "opencode", "gemini", "all"].includes(harness);
  if (wantsSkill) {
    copy(
      path.join(pluginRoot, "skills", "review-until-clean"),
      path.join(userHome, ".agents", "skills", "review-until-clean"),
      options,
      installed,
    );
  }
  if (["opencode", "all"].includes(harness)) {
    copy(
      path.join(
        pluginRoot,
        "harnesses",
        "opencode",
        "commands",
        "review-until-clean.md",
      ),
      path.join(
        userHome,
        ".config",
        "opencode",
        "commands",
        "review-until-clean.md",
      ),
      options,
      installed,
    );
  }
  if (["gemini", "all"].includes(harness)) {
    copy(
      path.join(
        pluginRoot,
        "harnesses",
        "gemini",
        "commands",
        "review-until-clean.toml",
      ),
      path.join(userHome, ".gemini", "commands", "review-until-clean.toml"),
      options,
      installed,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      { status: options["dry-run"] ? "dry-run" : "installed", installed },
      null,
      2,
    )}\n`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`install: ${error.message}\n`);
  process.exitCode = 1;
}
