#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const versionFiles = [
  "package.json",
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  "plugins/codex-review-loop/.codex-plugin/plugin.json",
  "plugins/codex-review-loop/.claude-plugin/plugin.json",
];

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function versionFromJson(relativePath) {
  const value = JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
  if (relativePath.endsWith("marketplace.json")) {
    return value.plugins?.[0]?.version;
  }
  return value.version;
}

export function checkVersions() {
  const versions = new Map(
    versionFiles.map((relativePath) => [
      relativePath,
      versionFromJson(relativePath),
    ]),
  );
  const unique = new Set(versions.values());
  if (
    unique.size !== 1 ||
    [...unique].some(
      (version) => typeof version !== "string" || !semver.test(version),
    )
  ) {
    const detail = [...versions]
      .map(([file, version]) => `${file}: ${String(version)}`)
      .join("\n");
    throw new Error(`Release versions are invalid or inconsistent:\n${detail}`);
  }
  return [...unique][0];
}

export function setVersion(nextVersion) {
  if (!semver.test(nextVersion ?? "")) {
    throw new Error(`Invalid SemVer version: ${JSON.stringify(nextVersion)}`);
  }
  for (const relativePath of versionFiles) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const content = readFileSync(absolutePath, "utf8");
    JSON.parse(content);
    const matches = content.match(/"version"\s*:\s*"[^"]+"/gu) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `${relativePath} must contain exactly one JSON version field`,
      );
    }
    const updated = content.replace(
      /("version"\s*:\s*")[^"]+(")/u,
      `$1${nextVersion}$2`,
    );
    writeFileSync(absolutePath, updated, "utf8");
  }
  return checkVersions();
}

function usage() {
  return `Usage:
  node scripts/release-version.mjs check
  node scripts/release-version.mjs get
  node scripts/release-version.mjs set <semver>`;
}

function main(argv) {
  const [command, value] = argv;
  if (command === "check") {
    const current = checkVersions();
    process.stdout.write(`Release versions agree at ${current}\n`);
    return;
  }
  if (command === "get") {
    process.stdout.write(`${checkVersions()}\n`);
    return;
  }
  if (command === "set" && value && argv.length === 2) {
    process.stdout.write(`Set release version to ${setVersion(value)}\n`);
    return;
  }
  throw new Error(usage());
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release-version: ${error.message}\n`);
    process.exitCode = 1;
  }
}
