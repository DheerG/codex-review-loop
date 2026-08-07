#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROVIDERS = ["auto", "codex", "gemini", "claude", "opencode", "custom"];
const CLEAN_SENTINEL = "NO_IN_SCOPE_FUNCTIONAL_FINDINGS";
const STATE_SCHEMA_VERSION = 3;
const DEFAULT_FALLBACK_MAX_ROUNDS = 15;
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MAX_CODEX_PREFLIGHT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const MAX_CODEX_IDENTITY_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_CLOUD_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CODEX_MCP_OVERRIDE_BYTES = 16 * 1024;
const CODEX_TEMP_HOME_PREFIX = "codex-feature-inventory-";
const MAX_CODEX_TEMP_HOME_AGE_MS = 25 * 60 * 60 * 1_000;
const DEFAULT_COMMIT_SECTIONS = ["Failure", "Change", "Verification"];
const CODEX_REVIEW_DISABLED_FEATURES = [
  "hooks",
  "codex_hooks",
  "plugin_hooks",
  "apps",
  "plugins",
  "multi_agent",
  "multi_agent_v2",
  "multi_agent_mode",
  "collaboration_modes",
  "enable_fanout",
  "guardian_approval",
  "guardianv2",
];
const CODEX_REVIEW_RETAINED_FEATURES = new Set([
  // These features affect only the model transport or the two local inspection
  // tools that remain constrained by Codex's native read-only sandbox.
  "concurrent_reasoning_summaries",
  "enable_request_compression",
  "fast_mode",
  "local_thread_store_compression",
  "remote_compaction_v2",
  "responses_websockets",
  "responses_websockets_v2",
  "shell_tool",
  "unified_exec",
  "use_legacy_landlock",
  "use_linux_sandbox_bwrap",
]);
const GIT_REVISION_SUFFIX_SOURCE = String.raw`(?:\^\{(?:commit|tree|blob|tag|object)?\}|~\d*|\^\d*)`;
const SKILL_SCRIPT = fileURLToPath(import.meta.url);

function codexFeatureRequiresIsolation(feature) {
  return !CODEX_REVIEW_RETAINED_FEATURES.has(feature);
}

class CliError extends Error {
  constructor(message, exitCode = 2, details = undefined) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: MAX_CAPTURE_BYTES,
    timeout: options.timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw new CliError(`${command} could not run: ${result.error.message}`, 2);
  }
  if (!options.allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new CliError(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      2,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(cwd, args, options = {}) {
  return run("git", args, { cwd, allowFailure: options.allowFailure });
}

export function readBoundedCodexConfig(file) {
  let before;
  try {
    before = lstatSync(file);
  } catch (error) {
    throw new CliError(
      `Cannot safely inspect Codex configuration at ${file}: ${error.message}`,
      3,
    );
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new CliError(
      `Codex configuration must be a regular non-symlink file: ${file}.`,
      3,
    );
  }
  if (before.size > MAX_CODEX_CONFIG_BYTES) {
    throw new CliError(
      `Codex configuration exceeds ${MAX_CODEX_CONFIG_BYTES} bytes: ${file}.`,
      3,
    );
  }

  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new CliError(
        `Codex configuration changed while it was inspected: ${file}.`,
        3,
      );
    }
    const buffer = Buffer.alloc(MAX_CODEX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_CODEX_CONFIG_BYTES) {
      throw new CliError(
        `Codex configuration exceeds ${MAX_CODEX_CONFIG_BYTES} bytes: ${file}.`,
        3,
      );
    }
    return buffer.subarray(0, total).toString("utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `Cannot safely read Codex configuration at ${file}: ${error.message}`,
      3,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedCodexRuntimeFile(file, maximumBytes, label) {
  let before;
  try {
    before = lstatSync(file);
  } catch (error) {
    throw new CliError(
      `Cannot safely inspect ${label} at ${file}: ${error.message}`,
      3,
    );
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new CliError(`${label} must be a regular non-symlink file: ${file}.`, 3);
  }
  if (before.size > maximumBytes) {
    throw new CliError(`${label} exceeds ${maximumBytes} bytes: ${file}.`, 3);
  }

  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new CliError(`${label} changed while it was inspected: ${file}.`, 3);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }
    if (total > maximumBytes) {
      throw new CliError(`${label} exceeds ${maximumBytes} bytes: ${file}.`, 3);
    }
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot safely read ${label} at ${file}: ${error.message}`, 3);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function repository(cwd = process.cwd()) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
  let storage;
  const absolutePath = git(
    root,
    ["rev-parse", "--path-format=absolute", "--git-path", "codex-review-loop"],
    { allowFailure: true },
  );
  if (absolutePath.status === 0) {
    storage = absolutePath.stdout.trim();
  } else {
    const relativePath = git(root, ["rev-parse", "--git-path", "codex-review-loop"])
      .stdout.trim();
    storage = path.isAbsolute(relativePath)
      ? relativePath
      : path.resolve(root, relativePath);
  }
  return {
    root,
    storage,
    activeFile: path.join(storage, "active.json"),
    runsDir: path.join(storage, "runs"),
  };
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`Cannot read state at ${file}: ${error.message}`, 2);
  }
}

function loadActive(repo, options = {}) {
  if (!existsSync(repo.activeFile)) {
    throw new CliError("No active review loop. Start one with `start`.", 2);
  }
  const state = readJson(repo.activeFile);
  if (![1, 2, STATE_SCHEMA_VERSION].includes(state.schemaVersion)) {
    throw new CliError(`Unsupported state schema: ${state.schemaVersion}`, 2);
  }
  if (state.schemaVersion < STATE_SCHEMA_VERSION) {
    const previousSchema = state.schemaVersion;
    try {
      state.base = pinPersistedBase(repo.root, state);
    } catch (error) {
      if (!options.allowUnmigrated) throw error;
      state.migrationError = error.message;
      return state;
    }
    state.schemaVersion = STATE_SCHEMA_VERSION;
    if (
      previousSchema === 1 &&
      (state.phase === "clean" || state.lastReview?.status === "clean")
    ) {
      state.phase = "invalid";
      if (state.maxRounds !== null) {
        state.maxRounds = Math.max(state.maxRounds, state.round + 2);
      }
      state.lastReview = {
        ...state.lastReview,
        status: "invalid",
        reason:
          "The clean result predates the current verdict contract. Review the unchanged snapshot again.",
      };
    }
    saveActive(repo, state);
    return state;
  }
  return state;
}

function saveActive(repo, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(repo.activeFile, state);
}

function normalizeRef(ref) {
  if (!ref || ref.startsWith("-") || /[\0-\x20\x7f]/u.test(ref)) {
    throw new CliError(`Unsafe or empty Git ref: ${JSON.stringify(ref)}`, 2);
  }
  return ref;
}

function refExists(root, ref) {
  return (
    git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowFailure: true,
    }).status === 0
  );
}

function resolveBase(root, requested) {
  if (requested) {
    const base = normalizeRef(requested);
    if (!refExists(root, base)) {
      throw new CliError(`Base ref does not resolve to a commit: ${base}`, 2);
    }
    return git(root, ["rev-parse", "--verify", `${base}^{commit}`]).stdout.trim();
  }

  const remoteHead = git(
    root,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { allowFailure: true },
  );
  const candidates = [
    remoteHead.status === 0 ? remoteHead.stdout.trim() : "",
    "origin/main",
    "origin/master",
    "main",
    "master",
    "HEAD",
  ].filter(Boolean);
  const base = candidates.find((candidate) => refExists(root, candidate));
  if (!base) {
    throw new CliError(
      "Could not infer a comparison base. Supply `--base <ref>`.",
      2,
    );
  }
  return git(root, ["rev-parse", "--verify", `${base}^{commit}`]).stdout.trim();
}

function isUnambiguousObjectPrefix(root, value, resolved) {
  if (!/^[0-9a-f]{4,64}$/iu.test(value)) return false;
  const candidates = git(root, ["rev-parse", `--disambiguate=${value}`], {
    allowFailure: true,
  });
  if (candidates.status !== 0) return false;
  const objects = candidates.stdout.split(/\r?\n/u).filter(Boolean);
  if (objects.length !== 1) return false;
  const peeled = git(
    root,
    ["rev-parse", "--verify", "--quiet", `${objects[0]}^{commit}`],
    { allowFailure: true },
  );
  return peeled.status === 0 && peeled.stdout.trim() === resolved;
}

function reflogCovers(root, ref, startedAt) {
  const result = git(root, [
    "reflog",
    "show",
    "--date=unix",
    "--format=%gD",
    ref,
  ], {
    allowFailure: true,
  });
  if (result.status !== 0) return false;
  const startSecond = Math.floor(startedAt.valueOf() / 1_000);
  let earliest = Number.POSITIVE_INFINITY;
  let includesStart = false;
  for (const selector of result.stdout.split(/\r?\n/u)) {
    const timestamp = Number(selector.match(/@\{(-?\d+)\}$/u)?.[1]);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < earliest) earliest = timestamp;
    if (timestamp === startSecond) includesStart = true;
  }
  return earliest < startSecond && !includesStart;
}

function pinPersistedBase(root, state) {
  const base = normalizeRef(state.base);
  const headRelative = base.match(
    new RegExp(
      String.raw`^HEAD(?<suffix>(?:${GIT_REVISION_SUFFIX_SOURCE})*)$`,
      "u",
    ),
  );
  if (headRelative) {
    if (
      typeof state.initialHead !== "string" ||
      !refExists(root, state.initialHead)
    ) {
      throw new CliError(
        `Cannot safely recover stored HEAD-relative comparison base ${base}.`,
        2,
      );
    }
    return resolveBase(
      root,
      `${state.initialHead}${headRelative.groups.suffix}`,
    );
  }
  const resolved = resolveBase(root, base);
  const relative = base.match(
    new RegExp(
      String.raw`^(?<root>.+?)(?<suffix>(?:${GIT_REVISION_SUFFIX_SOURCE})+)$`,
      "u",
    ),
  );
  const historicalRoot = relative?.groups.root ?? base;
  const historicalSuffix = relative?.groups.suffix ?? "";
  const resolvedRoot = relative
    ? resolveBase(root, historicalRoot)
    : resolved;
  if (
    base === resolved ||
    isUnambiguousObjectPrefix(root, base, resolved) ||
    (relative &&
      (historicalRoot === resolvedRoot ||
        isUnambiguousObjectPrefix(root, historicalRoot, resolvedRoot)))
  ) {
    return resolved;
  }

  const startedAt = new Date(state.startedAt);
  if (
    !Number.isNaN(startedAt.valueOf()) &&
    reflogCovers(root, historicalRoot, startedAt)
  ) {
    const historical = git(
      root,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        `${historicalRoot}@{${startedAt.toISOString()}}${historicalSuffix}^{commit}`,
      ],
      { allowFailure: true },
    );
    if (historical.status === 0) return historical.stdout.trim();
  }

  throw new CliError(
    `Cannot safely recover the original commit for persisted comparison base ${base}. Finish this run explicitly and start a new one.`,
    2,
  );
}

function splitNull(value) {
  return value.split("\0").filter(Boolean);
}

function scopeFiles(root, base) {
  const files = new Set();
  const commands = [
    ["diff", "--name-only", "-z", `${base}...HEAD`, "--"],
    ["diff", "--cached", "--name-only", "-z", "--"],
    ["diff", "--name-only", "-z", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  for (const args of commands) {
    for (const file of splitNull(git(root, args).stdout)) {
      files.add(file);
    }
  }
  return [...files].sort();
}

function updateUntrackedHash(hash, root) {
  const files = splitNull(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout,
  ).sort();
  for (const file of files) {
    const absolute = path.join(root, file);
    hash.update(`untracked\0${file}\0`);
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(`link\0${readlinkSync(absolute)}`);
      } else if (stat.isFile()) {
        hash.update(readFileSync(absolute));
      } else {
        hash.update(`other\0${stat.mode}\0${stat.size}`);
      }
    } catch (error) {
      hash.update(`unreadable\0${error.code ?? error.message}`);
    }
  }
}

export function snapshot(root, base) {
  const hash = createHash("sha256");
  const segments = [
    git(root, ["rev-parse", "HEAD"]).stdout,
    git(root, ["diff", "--binary", `${base}...HEAD`, "--"]).stdout,
    git(root, ["diff", "--cached", "--binary", "--"]).stdout,
    git(root, ["diff", "--binary", "--"]).stdout,
  ];
  for (const segment of segments) {
    hash.update(segment);
    hash.update("\0");
  }
  updateUntrackedHash(hash, root);
  return hash.digest("hex");
}

function executableOnPath(name, env = process.env) {
  const pathValue = env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

function codexAvailability(env, context = undefined) {
  if (!executableOnPath("codex", env)) {
    return { available: false, reason: "executable not found" };
  }
  const state = {
    root: context?.root ?? process.cwd(),
    isolateCodexConfig: Boolean(context?.isolateCodexConfig),
  };
  try {
    const mcpServers = codexMcpServersForReview(state, env);
    const preferenceContext = codexReviewPreferenceContext(state, env);
    const disabledFeatures = codexFeaturesForReview(
      state,
      env,
      context?.storage,
      undefined,
      undefined,
      {
        localConfigInventory: mcpServers.localConfigInventory,
        mcpServers,
        preferenceContext,
      },
    );
    codexReviewPreferencesForReview(
      state,
      env,
      undefined,
      {
        preferenceContext,
        selectedLegacyProfile:
          disabledFeatures.selectedLegacyPreferenceProfile,
        preferenceConfigs: disabledFeatures.preferenceConfigs,
      },
    );
    return { available: true };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

function availableProviders(
  env = process.env,
  codexContext = undefined,
  codexStatus = codexAvailability(env, codexContext),
) {
  return {
    codex: codexStatus.available,
    gemini: Boolean(executableOnPath("gemini", env)),
    claude: Boolean(executableOnPath("claude", env)),
    opencode: Boolean(executableOnPath("opencode", env)),
    custom: Boolean(env.CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON),
  };
}

function chooseProvider(requested, env = process.env, codexContext = undefined) {
  if (!PROVIDERS.includes(requested)) {
    throw new CliError(
      `Unknown provider ${JSON.stringify(requested)}. Use ${PROVIDERS.join(", ")}.`,
      2,
    );
  }
  if (requested !== "auto") {
    const available =
      requested === "codex"
        ? availableProviders(env, codexContext).codex
        : requested === "custom"
          ? Boolean(env.CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON)
          : Boolean(executableOnPath(requested, env));
    if (!available) {
      throw new CliError(
        `Provider ${requested} is not available. Run \`doctor\` for details.`,
        3,
      );
    }
    return requested;
  }
  const available = availableProviders(env, codexContext);
  const selected = ["codex", "gemini", "claude", "opencode"].find(
    (provider) => available[provider],
  );
  if (!selected) {
    throw new CliError(
      "No reviewer provider is available. Install Codex, Gemini CLI, Claude Code, or OpenCode; or configure the custom provider.",
      3,
    );
  }
  return selected;
}

export function reviewPrompt(state, files) {
  const fileList = files.map((file) => `- ${file}`).join("\n");
  const cleanInstruction =
    state.provider === "codex"
      ? "No in-scope functional findings."
      : CLEAN_SENTINEL;
  return `You are the independent final reviewer. Work read-only: do not edit files, stage changes, commit, or invoke another writing agent.

Approved outcome:
${state.outcome}

Repository: ${state.root}
Comparison base: ${state.base}

Review the complete current Git scope, including:
- committed branch changes in \`${state.base}...HEAD\`;
- staged changes;
- unstaged changes;
- every untracked file listed by \`git ls-files --others --exclude-standard\`.

Files currently in that union:
${fileList}

Inspect the repository and diff directly. Be exhaustive rather than stopping at the first issue. Report only actionable functional defects introduced by this scope: correctness, security, reliability, data integrity, compatibility, or material performance problems. Do not report style preferences, speculative redesigns, or pre-existing defects. A finding must explain a concrete failure mode and cite the smallest useful location.

Commit subjects and bodies may provide context about intended behavior, but their claims are not proof. Verify them against the complete diff, tests, and reachable sibling sites. Commit-message quality is outside this functional review: do not report existing message quality as a finding or recommend amending, rebasing, squashing, recreating, or otherwise rewriting history.

For findings, return:
Review summary: <brief summary>
Full review comments:
- [P0|P1|P2|P3] <imperative title> — <path>:<line>
  <why this fails and when>

If and only if there are no in-scope functional findings, return:
${cleanInstruction}

Do not state that the review is clean when reporting any finding.`;
}

function parseCustomCommand(env) {
  try {
    const value = JSON.parse(env.CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((part) => typeof part !== "string" || !part)
    ) {
      throw new Error("expected a non-empty array of strings");
    }
    return value;
  } catch (error) {
    throw new CliError(
      `Invalid CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON: ${error.message}`,
      3,
    );
  }
}

function tomlInlineValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => tomlInlineValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}=${tomlInlineValue(item)}`,
      )
      .join(",")}}`;
  }
  throw new CliError("Codex returned an unsupported MCP configuration value.", 3);
}

export function codexMcpDisableOverrides(servers) {
  if (!Array.isArray(servers)) {
    throw new CliError("Codex MCP inventory is not an array.", 3);
  }
  const names = new Set();
  for (const server of servers) {
    const name = typeof server === "string" ? server : server?.name;
    if (typeof name !== "string" || !name) {
      throw new CliError("Codex MCP inventory contains an unnamed server.", 3);
    }
    names.add(name);
  }
  const overrides = [...names].map(
    (name) => `mcp_servers.${JSON.stringify(name)}.enabled=false`,
  );
  const totalBytes = overrides.reduce(
    (total, override) => total + Buffer.byteLength(override) + 3,
    0,
  );
  if (totalBytes > MAX_CODEX_MCP_OVERRIDE_BYTES) {
    throw new CliError(
      "Codex MCP inventory is too large to disable safely on the command line.",
      3,
    );
  }
  return overrides;
}

function codexProjectUntrustedOverride(root) {
  return `projects=${tomlInlineValue({
    [path.resolve(root)]: { trust_level: "untrusted" },
  })}`;
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
    } else if (quote === "'") {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function decodeTomlBasicKey(value, source) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escape = value[(index += 1)];
    const escapes = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (Object.hasOwn(escapes, escape)) {
      decoded += escapes[escape];
      continue;
    }
    if (escape === "u" || escape === "U") {
      const digits = escape === "u" ? 4 : 8;
      const hexadecimal = value.slice(index + 1, index + 1 + digits);
      if (!new RegExp(`^[0-9a-f]{${digits}}$`, "iu").test(hexadecimal)) {
        throw new CliError(`Cannot parse a quoted TOML key in ${source}.`, 3);
      }
      decoded += String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      index += digits;
      continue;
    }
    throw new CliError(
      `Cannot parse a quoted TOML key in ${source}.`,
      3,
    );
  }
  return decoded;
}

function parseTomlKeyPath(value, source) {
  const parts = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    let part;
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index];
      let escaped = false;
      let end = index + 1;
      for (; end < value.length; end += 1) {
        if (quote === '"' && !escaped && value[end] === "\\") {
          escaped = true;
          continue;
        }
        if (!escaped && value[end] === quote) break;
        escaped = false;
      }
      if (end >= value.length) {
        throw new CliError(`Cannot parse a quoted TOML key in ${source}.`, 3);
      }
      const raw = value.slice(index + 1, end);
      part = quote === '"' ? decodeTomlBasicKey(raw, source) : raw;
      index = end + 1;
    } else {
      const match = value.slice(index).match(/^[A-Za-z0-9_-]+/u);
      if (!match) {
        throw new CliError(`Cannot parse a TOML key in ${source}.`, 3);
      }
      [part] = match;
      index += part.length;
    }
    if (!part) throw new CliError(`TOML keys cannot be empty in ${source}.`, 3);
    parts.push(part);
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    if (value[index] !== ".") {
      throw new CliError(`Cannot parse a dotted TOML key in ${source}.`, 3);
    }
    index += 1;
  }
  if (parts.length === 0) {
    throw new CliError(`Cannot parse an empty TOML key in ${source}.`, 3);
  }
  return parts;
}

function tomlAssignmentIndex(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (quote === "'") {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "=") {
      return index;
    }
  }
  return -1;
}

function inlineTomlTableEntries(
  value,
  source,
  failure = `Cannot safely inspect an inline TOML table in ${source}.`,
) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new CliError(failure, 3);
  }
  const entries = [];
  let start = 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      entries.push(trimmed.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(trimmed.slice(start, -1));
  return entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const equals = tomlAssignmentIndex(entry);
      if (equals < 0) {
        throw new CliError(failure, 3);
      }
      const entryValue = entry.slice(equals + 1).trim();
      if (!entryValue) {
        throw new CliError(failure, 3);
      }
      return {
        parts: parseTomlKeyPath(entry.slice(0, equals).trim(), source),
        value: entryValue,
      };
    });
}

function inlineTomlTableKeys(value, source) {
  return inlineTomlTableEntries(
    value,
    source,
    `Cannot safely inventory inline mcp_servers in ${source}.`,
  ).map((entry) => entry.parts[0]);
}

function expandInlineTomlRecords(records, parts, value, source) {
  if (!value.trim().startsWith("{")) return;
  for (const entry of inlineTomlTableEntries(value, source)) {
    const nested = {
      parts: [...parts, ...entry.parts],
      value: entry.value,
    };
    records.push(nested);
    expandInlineTomlRecords(records, nested.parts, nested.value, source);
  }
}

function recordMcpNames(parts, value, names, source) {
  if (parts[0] !== "mcp_servers") return;
  if (parts[1]) {
    names.add(parts[1]);
  } else if (value !== undefined) {
    for (const name of inlineTomlTableKeys(value, source)) names.add(name);
  }
}

function tomlStringValue(value, source) {
  const trimmed = value.trim();
  const delimiter = ['"""', "'''"].find((item) => trimmed.startsWith(item));
  if (delimiter) {
    if (trimmed.length < 6 || !trimmed.endsWith(delimiter)) {
      throw new CliError(
        `Cannot safely parse a multiline TOML string in ${source}.`,
        3,
      );
    }
    let raw = trimmed.slice(3, -3).replace(/^\r?\n/u, "");
    if (delimiter === '"""') {
      if (/\\\r?\n/u.test(raw)) {
        throw new CliError(
          `Cannot safely parse a multiline TOML string in ${source}.`,
          3,
        );
      }
      raw = decodeTomlBasicKey(raw, source);
    }
    return raw;
  }
  if (
    trimmed.length < 2 ||
    !['"', "'"].includes(trimmed[0]) ||
    trimmed.at(-1) !== trimmed[0]
  ) {
    throw new CliError(`Cannot parse a TOML string in ${source}.`, 3);
  }
  const raw = trimmed.slice(1, -1);
  return trimmed[0] === '"' ? decodeTomlBasicKey(raw, source) : raw;
}

function tomlStringArrayValue(value, source) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new CliError(`Cannot parse a TOML string array in ${source}.`, 3);
  }
  const entries = [];
  let start = 1;
  let quote = null;
  let escaped = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (quote === "'") {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ",") {
      entries.push(trimmed.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote) {
    throw new CliError(`Cannot parse a TOML string array in ${source}.`, 3);
  }
  entries.push(trimmed.slice(start, -1).trim());
  if (entries.at(-1) === "") entries.pop();
  if (entries.some((entry) => !entry)) {
    throw new CliError(`Cannot parse a TOML string array in ${source}.`, 3);
  }
  return entries.map((entry) => tomlStringValue(entry, source));
}

function advanceTomlContainerState(state, value) {
  for (const character of value) {
    if (state.quote === '"') {
      if (state.escaped) state.escaped = false;
      else if (character === "\\") state.escaped = true;
      else if (character === state.quote) state.quote = null;
      continue;
    }
    if (state.quote === "'") {
      if (character === state.quote) state.quote = null;
      continue;
    }
    if (character === '"' || character === "'") state.quote = character;
    else if (character === "{" || character === "[") state.balance += 1;
    else if (character === "}" || character === "]") state.balance -= 1;
  }
}

function codexConfigRecords(contents, source) {
  const records = [];
  const lines = contents.split(/\r?\n/u);
  let table = [];
  let selectedLegacyProfile = null;
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const rawLine = lines[lineNumber];
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const arrayTable = line.startsWith("[[");
      const opener = arrayTable ? "[[" : "[";
      const closer = arrayTable ? "]]" : "]";
      if (!line.endsWith(closer)) {
        throw new CliError(`Cannot parse a TOML table in ${source}.`, 3);
      }
      table = parseTomlKeyPath(
        line.slice(opener.length, -closer.length).trim(),
        source,
      );
      records.push({ parts: table, value: undefined });
      continue;
    }
    const equals = tomlAssignmentIndex(line);
    if (equals < 0) continue;
    const key = parseTomlKeyPath(line.slice(0, equals).trim(), source);
    let value = line.slice(equals + 1).trim();
    if (value.startsWith("{") || value.startsWith("[")) {
      const container = { balance: 0, quote: null, escaped: false };
      advanceTomlContainerState(container, value);
      while (container.balance > 0 && lineNumber + 1 < lines.length) {
        lineNumber += 1;
        const continuation = stripTomlComment(lines[lineNumber]).trim();
        value += `\n${continuation}`;
        advanceTomlContainerState(container, `\n${continuation}`);
      }
      if (container.balance !== 0) {
        throw new CliError(
          `Cannot parse a multiline inline TOML value in ${source}.`,
          3,
        );
      }
    }
    for (const delimiter of ['"""', "'''"]) {
      const start = value.indexOf(delimiter);
      if (
        !value.trimStart().startsWith(delimiter) ||
        value.indexOf(delimiter, start + 3) >= 0
      ) {
        continue;
      }
      let closed = false;
      while (lineNumber + 1 < lines.length) {
        lineNumber += 1;
        const continuation = lines[lineNumber];
        const end = continuation.indexOf(delimiter);
        value += `\n${end < 0 ? continuation : continuation.slice(0, end + 3)}`;
        if (end >= 0) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new CliError(
          `Cannot safely parse a multiline TOML string in ${source}.`,
          3,
        );
      }
    }
    const parts = [...table, ...key];
    records.push({ parts, value });
    expandInlineTomlRecords(records, parts, value, source);
    if (parts.length === 1 && parts[0] === "profile") {
      selectedLegacyProfile = tomlStringValue(value, source);
    }
  }
  return { records, selectedLegacyProfile };
}

export function codexSelectedLegacyProfileFromToml(
  contents,
  source = "Codex config",
) {
  return codexConfigRecords(contents, source).selectedLegacyProfile;
}

export function codexSelectedLegacyProfileFromConfigs(configs) {
  let selectedLegacyProfile = null;
  for (const config of configs) {
    const selected = codexSelectedLegacyProfileFromToml(
      config.contents,
      config.file,
    );
    if (selected !== null) selectedLegacyProfile = selected;
  }
  return selectedLegacyProfile;
}

function activeCodexRecordParts(record, options, localSelectedProfile) {
  if (record.parts[0] !== "profiles") return record.parts;
  const selectedProfile = Object.hasOwn(options, "selectedLegacyProfile")
    ? options.selectedLegacyProfile
    : localSelectedProfile;
  if (
    options.legacyProfiles &&
    selectedProfile &&
    record.parts[1] === selectedProfile
  ) {
    return record.parts.slice(2);
  }
  return null;
}

function effectiveCodexRecords(records, options, localSelectedProfile) {
  const ordered = [
    records.filter((record) => record.parts[0] !== "profiles"),
    records.filter((record) => record.parts[0] === "profiles"),
  ];
  const effective = new Map();
  for (const group of ordered) {
    for (const record of group) {
      const parts = activeCodexRecordParts(
        record,
        options,
        localSelectedProfile,
      );
      if (!parts) continue;
      effective.set(JSON.stringify(parts), { ...record, parts });
    }
  }
  return [...effective.values()];
}

function effectiveCodexRecordsFromConfigs(configs, options = {}) {
  const effective = new Map();
  for (const config of configs) {
    const { records, selectedLegacyProfile } = codexConfigRecords(
      config.contents,
      config.file,
    );
    for (const record of effectiveCodexRecords(
      records,
      options,
      selectedLegacyProfile,
    )) {
      effective.set(JSON.stringify(record.parts), {
        ...record,
        retainedForReview: config.retainedForReview === true,
      });
    }
  }
  return [...effective.values()];
}

function codexReviewPreferencesFromRecords(records, source) {
  const preferences = {};
  let modelProvider;
  let modelProviderRecord;
  let modelCatalogRecord;
  let openAiBaseUrlRecord;
  const configuredModelProviders = new Map();
  for (const record of records) {
    const { parts } = record;
    if (
      parts.length === 1 &&
      ["model", "review_model", "model_reasoning_effort"].includes(parts[0])
    ) {
      preferences[parts[0]] = tomlStringValue(record.value ?? "", source);
    } else if (parts.length === 1 && parts[0] === "model_provider") {
      modelProvider = tomlStringValue(record.value ?? "", source);
      modelProviderRecord = record;
    } else if (parts.length === 1 && parts[0] === "model_catalog_json") {
      modelCatalogRecord = record;
    } else if (parts.length === 1 && parts[0] === "openai_base_url") {
      openAiBaseUrlRecord = record;
    } else if (parts[0] === "model_providers" && parts[1]) {
      configuredModelProviders.set(
        parts[1],
        (configuredModelProviders.get(parts[1]) ?? true) &&
          record.retainedForReview === true,
      );
    }
  }
  if (preferences.model || preferences.review_model || modelProvider === "openai") {
    const dependencies = [];
    const effectiveModelProvider = modelProvider ?? "openai";
    if (configuredModelProviders.get(effectiveModelProvider) === false) {
      dependencies.push(`model_providers.${effectiveModelProvider}`);
    } else if (
      modelProvider &&
      modelProvider !== "openai" &&
      modelProviderRecord?.retainedForReview !== true
    ) {
      dependencies.push(`model_provider=${JSON.stringify(modelProvider)}`);
    }
    if (
      (preferences.model || preferences.review_model) &&
      modelCatalogRecord &&
      modelCatalogRecord.retainedForReview !== true
    ) {
      dependencies.push("model_catalog_json");
    }
    if (
      openAiBaseUrlRecord &&
      effectiveModelProvider === "openai" &&
      openAiBaseUrlRecord.retainedForReview !== true
    ) {
      dependencies.push("openai_base_url");
    }
    if (dependencies.length > 0) {
      throw new CliError(
        `Cannot safely copy Codex model preferences without dependent user configuration: ${dependencies.join(", ")}. Use --isolate-codex-config or remove the dependent model preference.`,
        3,
      );
    }
    if (modelProvider === "openai") preferences.model_provider = modelProvider;
  }
  return preferences;
}

export function codexReviewPreferencesFromToml(
  contents,
  source = "Codex user config",
  options = {},
) {
  const { records, selectedLegacyProfile } = codexConfigRecords(
    contents,
    source,
  );
  return codexReviewPreferencesFromRecords(
    effectiveCodexRecords(records, options, selectedLegacyProfile),
    source,
  );
}

export function codexReviewPreferencesFromConfigs(
  configs,
  source = "layered Codex configuration",
  options = {},
) {
  return codexReviewPreferencesFromRecords(
    effectiveCodexRecordsFromConfigs(configs, options),
    source,
  );
}

export function codexPromptHazardsFromToml(
  contents,
  source = "Codex config",
  options = {},
) {
  const { records, selectedLegacyProfile } = codexConfigRecords(
    contents,
    source,
  );
  const hazards = new Set();
  const promptKeys = new Set([
    "allow_login_shell",
    "background_terminal_max_timeout",
    "compact_prompt",
    "developer_instructions",
    "experimental_compact_prompt_file",
    "experimental_instructions_file",
    "experimental_use_unified_exec_tool",
    "include_apps_instructions",
    "include_collaboration_mode_instructions",
    "include_environment_context",
    "include_permissions_instructions",
    "instructions",
    "model_auto_compact_token_limit",
    "model_auto_compact_token_limit_scope",
    "model_catalog_json",
    "model_context_window",
    "model_instructions_file",
    "personality",
    "project_doc_fallback_filenames",
    "project_doc_max_bytes",
    "project_root_markers",
    "tool_output_token_limit",
    "tool_suggest",
  ]);
  const promptRoots = new Set([
    "experimental_network",
    "shell_environment_policy",
    "skills",
    "tools",
  ]);
  for (const record of effectiveCodexRecords(
    records,
    options,
    selectedLegacyProfile,
  )) {
    const { parts } = record;
    if (parts.length === 1 && promptKeys.has(parts[0])) {
      hazards.add(parts[0]);
    } else if (
      parts.length === 1 &&
      ["disabled_tools", "enabled_tools"].includes(parts[0])
    ) {
      // Preserve forward compatibility with Codex releases that expose
      // top-level tool filters. MCP-local filters are safe because every MCP
      // server is independently disabled for review invocations.
      hazards.add(parts[0]);
    } else if (promptRoots.has(parts[0])) {
      hazards.add(parts[0]);
    } else if (parts[0] === "auto_review" && parts[1] === "policy") {
      hazards.add("auto_review.policy");
    }
  }
  return [...hazards].sort();
}

export function codexMcpNamesFromToml(
  contents,
  source = "Codex config",
  options = {},
) {
  const names = new Set();
  const { records, selectedLegacyProfile } = codexConfigRecords(
    contents,
    source,
  );
  for (const record of records) {
    const parts = activeCodexRecordParts(
      record,
      options,
      selectedLegacyProfile,
    );
    if (parts) recordMcpNames(parts, record.value, names, source);
  }
  return [...names].sort();
}

export function codexManagedHazardsFromToml(
  contents,
  source = "managed Codex config",
  options = {},
) {
  const { records, selectedLegacyProfile } = codexConfigRecords(
    contents,
    source,
  );
  const hazards = new Set();
  const effectiveRecords = effectiveCodexRecords(
    records,
    options,
    selectedLegacyProfile,
  );
  const managedFeatures = new Map();
  for (const record of effectiveRecords) {
    const { parts } = record;
    if (
      parts[0] !== "features" ||
      !codexFeatureRequiresIsolation(parts[1])
    ) {
      continue;
    }
    const feature = managedFeatures.get(parts[1]) ?? {};
    if (parts.length === 2) feature.container = record.value;
    else if (parts.length === 3 && parts[2] === "enabled") {
      feature.enabled = record.value;
    }
    managedFeatures.set(parts[1], feature);
  }
  for (const [name, feature] of managedFeatures) {
    const container = feature.container?.trim();
    const value =
      container === undefined || container.startsWith("{")
        ? feature.enabled?.trim()
        : container;
    if (value === undefined) continue;
    if (!["true", "false"].includes(value)) {
      throw new CliError(`Cannot parse a managed feature in ${source}.`, 3);
    }
    if (value === "true") hazards.add(`features.${name}`);
  }
  for (const record of effectiveRecords) {
    const { parts } = record;
    if (parts.length === 1 && parts[0] === "notify") {
      if (
        record.value === undefined ||
        record.value.replace(/\s/gu, "") !== "[]"
      ) {
        hazards.add("notify");
      }
    } else if (parts.length === 1 && parts[0] === "sandbox_mode") {
      const value = tomlStringValue(record.value ?? "", source);
      if (value !== "read-only") hazards.add(parts[0]);
    } else if (
      parts.length === 1 &&
      ["default_permissions", "permission_profile"].includes(parts[0])
    ) {
      const value = tomlStringValue(record.value ?? "", source);
      // Unprefixed permission names may resolve to a user-defined profile.
      // Only Codex's built-in read-only profile is safe to accept here.
      if (value !== ":read-only") hazards.add(parts[0]);
    } else if (parts.length === 1 && parts[0] === "web_search") {
      if (tomlStringValue(record.value ?? "", source) !== "disabled") {
        hazards.add(parts[0]);
      }
    } else if (
      parts[0] === "projects" &&
      parts.at(-1) === "trust_level" &&
      tomlStringValue(record.value ?? "", source) === "trusted"
    ) {
      hazards.add("projects.*.trust_level");
    }
  }
  for (const hazard of codexPromptHazardsFromToml(contents, source, options)) {
    hazards.add(hazard);
  }
  for (const hazard of codexApprovalHazardsFromToml(contents, source, options)) {
    hazards.add(hazard);
  }
  return [...hazards].sort();
}

export function codexApprovalHazardsFromToml(
  contents,
  source = "Codex config",
  options = {},
) {
  const { records, selectedLegacyProfile } = codexConfigRecords(
    contents,
    source,
  );
  const hazards = new Set();
  for (const record of effectiveCodexRecords(
    records,
    options,
    selectedLegacyProfile,
  )) {
    const { parts } = record;
    if (parts.length !== 1) continue;
    if (parts[0] === "approval_policy") {
      if (tomlStringValue(record.value ?? "", source) !== "never") {
        hazards.add("approval_policy");
      }
    } else if (parts[0] === "approvals_reviewer") {
      if (tomlStringValue(record.value ?? "", source) !== "user") {
        hazards.add("approvals_reviewer");
      }
    } else if (
      parts[0] === "permission_profile" &&
      tomlStringValue(record.value ?? "", source) !== ":read-only"
    ) {
      hazards.add("permission_profile");
    }
  }
  return [...hazards].sort();
}

export function codexRequirementsHazardsFromToml(
  contents,
  source = "Codex requirements",
) {
  const { records } = codexConfigRecords(contents, source);
  const hazards = new Set(
    codexPromptHazardsFromToml(contents, source),
  );
  let allowedProfilesPresent = false;
  let readOnlyProfileAllowed = false;
  let defaultPermissions;
  for (const record of records) {
    const [key, child] = record.parts;
    if (record.parts.length === 1 && key === "allowed_approval_policies") {
      if (!tomlStringArrayValue(record.value ?? "", source).includes("never")) {
        hazards.add(key);
      }
    } else if (
      record.parts.length === 1 &&
      key === "allowed_approvals_reviewers"
    ) {
      if (!tomlStringArrayValue(record.value ?? "", source).includes("user")) {
        hazards.add(key);
      }
    } else if (
      record.parts.length === 1 &&
      key === "allowed_sandbox_modes"
    ) {
      if (!tomlStringArrayValue(record.value ?? "", source).includes("read-only")) {
        hazards.add(key);
      }
    } else if (
      record.parts.length === 1 &&
      key === "allowed_web_search_modes"
    ) {
      if (!tomlStringArrayValue(record.value ?? "", source).includes("disabled")) {
        hazards.add(key);
      }
    } else if (record.parts.length === 1 && key === "default_permissions") {
      defaultPermissions = tomlStringValue(record.value ?? "", source);
      if (defaultPermissions !== ":read-only") hazards.add(key);
    } else if (key === "allowed_permission_profiles") {
      allowedProfilesPresent = true;
      if (child === ":read-only") {
        const value = record.value?.trim();
        if (!["true", "false"].includes(value)) {
          throw new CliError(
            `Cannot parse allowed permission profiles in ${source}.`,
            3,
          );
        }
        readOnlyProfileAllowed = value === "true";
      }
    } else if (key === "remote_sandbox_config") {
      hazards.add("remote_sandbox_config");
    } else if (key === "rules") {
      hazards.add("rules");
    } else if (
      record.parts.length === 3 &&
      key === "permissions" &&
      child === "filesystem" &&
      ["allow", "deny_read"].includes(record.parts[2])
    ) {
      hazards.add(`permissions.filesystem.${record.parts[2]}`);
    } else if (
      record.parts.length === 2 &&
      ["features", "feature_requirements"].includes(key) &&
      codexFeatureRequiresIsolation(child)
    ) {
      const value = record.value?.trim();
      if (!["true", "false"].includes(value)) {
        throw new CliError(`Cannot parse a required feature in ${source}.`, 3);
      }
      if (value === "true") hazards.add(`${key}.${child}`);
    }
  }
  if (allowedProfilesPresent) {
    if (defaultPermissions !== ":read-only") hazards.add("default_permissions");
    if (!readOnlyProfileAllowed) {
      hazards.add("allowed_permission_profiles.:read-only");
    }
  }
  return [...hazards].sort();
}

function codexUsesReadOnlyPermissions(
  contents,
  source,
  options = {},
) {
  const { records, selectedLegacyProfile } = codexConfigRecords(
    contents,
    source,
  );
  return effectiveCodexRecords(
    records,
    options,
    selectedLegacyProfile,
  ).some(
    (record) =>
      record.parts.length === 1 &&
      ["default_permissions", "permission_profile"].includes(
        record.parts[0],
      ) &&
      tomlStringValue(record.value ?? "", source) === ":read-only",
  );
}

function withCodexIsolationMetadata(values, metadata) {
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(values, key, { value, enumerable: false });
  }
  return values;
}

function codexHome(env) {
  return path.resolve(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

function codexSystemConfig(env) {
  if (process.platform !== "win32") return "/etc/codex/config.toml";
  const programData = env.ProgramData ?? env.PROGRAMDATA;
  if (!programData) {
    throw new CliError("Cannot locate Windows system Codex configuration.", 3);
  }
  return path.win32.join(programData, "OpenAI", "Codex", "config.toml");
}

export function codexManagedConfigPath(
  env,
  platform = process.platform,
) {
  if (platform !== "win32") return "/etc/codex/managed_config.toml";
  const programData = env.ProgramData ?? env.PROGRAMDATA;
  if (!programData) {
    throw new CliError("Cannot locate Windows managed Codex configuration.", 3);
  }
  return path.win32.join(
    programData,
    "OpenAI",
    "Codex",
    "managed_config.toml",
  );
}

export function codexRequirementsPath(
  env,
  platform = process.platform,
) {
  if (platform !== "win32") return "/etc/codex/requirements.toml";
  const programData = env.ProgramData ?? env.PROGRAMDATA;
  if (!programData) {
    throw new CliError("Cannot locate Windows Codex requirements.", 3);
  }
  return path.win32.join(
    programData,
    "OpenAI",
    "Codex",
    "requirements.toml",
  );
}

function codexManagedConfigPaths(env) {
  const machineConfig = codexManagedConfigPath(env);
  if (process.platform !== "win32") return [machineConfig];
  return [
    machineConfig,
    path.join(codexHome(env), "managed_config.toml"),
  ];
}

export function preserveCodexHomeManagedConfigForIsolation(
  localConfigInventory,
  sourceEnv,
  temporaryHome,
  platform = process.platform,
) {
  if (platform !== "win32") return false;
  const source = path.join(codexHome(sourceEnv), "managed_config.toml");
  const managedConfig = localConfigInventory?.managedConfigs?.find(
    (config) => path.resolve(config.file) === path.resolve(source),
  );
  if (!managedConfig) return false;
  try {
    writeFileSync(
      path.join(temporaryHome, "managed_config.toml"),
      managedConfig.contents,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    throw new CliError(
      `Cannot preserve Windows home-managed Codex configuration for the isolated reviewer: ${error.message}`,
      3,
    );
  }
  return true;
}

function codexManagedPreference(
  env,
  key = "config_toml_base64",
  label = "config",
) {
  if (process.platform !== "darwin") return null;
  const result = run(
    "/usr/bin/defaults",
    ["read", "com.openai.codex", key],
    { env, allowFailure: true },
  );
  if (result.status !== 0) {
    if (/does not exist|domain .* not found/iu.test(result.stderr)) return null;
    throw new CliError(
      `Cannot safely inspect managed Codex ${label} preferences.`,
      3,
    );
  }
  const encoded = result.stdout
    .trim()
    .replace(/^"|"$/gu, "")
    .replace(/\s/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new CliError(
      `Managed Codex ${label} preferences contain invalid base64.`,
      3,
    );
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length > MAX_CODEX_CONFIG_BYTES) {
    throw new CliError(
      `Managed Codex ${label} preferences exceed ${MAX_CODEX_CONFIG_BYTES} bytes.`,
      3,
    );
  }
  return decoded.toString("utf8");
}

function codexManagedRequirementsPreference(env) {
  return codexManagedPreference(
    env,
    "requirements_toml_base64",
    "requirements",
  );
}

function assertManagedCodexConfigSafe(
  contents,
  source,
  legacyProfiles,
  selectedLegacyProfile,
) {
  const options = { legacyProfiles, selectedLegacyProfile };
  if (
    codexMcpNamesFromToml(contents, source, options).length > 0
  ) {
    throw new CliError(
      `Cannot safely override MCP servers from ${source}.`,
      3,
    );
  }
  const hazards = codexManagedHazardsFromToml(contents, source, options);
  if (hazards.length > 0) {
    throw new CliError(
      `Cannot safely override managed Codex settings from ${source}: ${hazards.join(", ")}.`,
      3,
    );
  }
}

function assertCodexRequirementsSafe(contents, source) {
  const hazards = codexRequirementsHazardsFromToml(contents, source);
  if (hazards.length > 0) {
    throw new CliError(
      `Codex requirements in ${source} conflict with safe review isolation: ${hazards.join(", ")}.`,
      3,
    );
  }
}

function codexUsesLegacyProfiles(state, env) {
  const version = run("codex", ["--version"], {
    cwd: state.root,
    env,
    allowFailure: true,
    timeoutMs: codexPreflightTimeout(env),
  });
  const versionMatch = version.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
  if (version.status !== 0 || !versionMatch) {
    throw new CliError("Cannot determine Codex profile compatibility.", 3);
  }
  return Number(versionMatch[1]) === 0 && Number(versionMatch[2]) < 134;
}

function codexConfigFile(file) {
  if (!file || !existsSync(file)) return null;
  return { contents: readBoundedCodexConfig(file), file };
}

function configuredCodexMcpServers(state, env) {
  const legacyProfiles = codexUsesLegacyProfiles(state, env);
  const requirementsConfigs = [];
  const systemRequirements = codexConfigFile(codexRequirementsPath(env));
  if (systemRequirements) requirementsConfigs.push(systemRequirements);
  const managedRequirements = codexManagedRequirementsPreference(env);
  if (managedRequirements) {
    requirementsConfigs.push({
      contents: managedRequirements,
      file: "managed Codex requirements preferences",
    });
  }
  for (const config of requirementsConfigs) {
    assertCodexRequirementsSafe(config.contents, config.file);
  }
  const ordinaryConfigs = [];
  const systemConfig = codexConfigFile(codexSystemConfig(env));
  if (systemConfig) ordinaryConfigs.push(systemConfig);

  const managedConfigs = [];
  for (const managedFile of codexManagedConfigPaths(env)) {
    const config = codexConfigFile(managedFile);
    if (config) managedConfigs.push(config);
  }
  const managedPreference = codexManagedPreference(env);
  if (managedPreference) {
    managedConfigs.push({
      contents: managedPreference,
      file: "managed Codex preferences",
    });
  }

  let selectedLegacyProfile = null;
  if (legacyProfiles) {
    selectedLegacyProfile = codexSelectedLegacyProfileFromConfigs([
      ...ordinaryConfigs,
      ...managedConfigs,
    ]);
  }
  const options = { legacyProfiles, selectedLegacyProfile };
  const names = new Set();
  for (const config of ordinaryConfigs) {
    const promptHazards = codexPromptHazardsFromToml(
      config.contents,
      config.file,
      options,
    );
    if (promptHazards.length > 0) {
      throw new CliError(
        `Cannot safely isolate prompt-affecting Codex settings from ${config.file}: ${promptHazards.join(", ")}.`,
        3,
      );
    }
    const approvalHazards = codexApprovalHazardsFromToml(
      config.contents,
      config.file,
      options,
    );
    if (approvalHazards.length > 0) {
      throw new CliError(
        `Cannot safely isolate Codex approval settings from ${config.file}: ${approvalHazards.join(", ")}.`,
        3,
      );
    }
    for (const name of codexMcpNamesFromToml(
      config.contents,
      config.file,
      options,
    )) {
      names.add(name);
    }
  }
  for (const config of managedConfigs) {
    assertManagedCodexConfigSafe(
      config.contents,
      config.file,
      legacyProfiles,
      selectedLegacyProfile,
    );
  }
  return withCodexIsolationMetadata([...names].sort(), {
    localConfigInventory: {
      ordinaryConfigs,
      managedConfigs,
      requirementsConfigs,
    },
  });
}

function codexAuthOverridesFromRecords(records, source) {
  let mode;
  for (const record of records) {
    if (
      record.parts.length === 1 &&
      record.parts[0] === "cli_auth_credentials_store"
    ) {
      mode = tomlStringValue(record.value ?? "", source);
    }
  }
  if (mode === undefined) return [];
  if (["auto", "file", "keyring"].includes(mode)) {
    return [`cli_auth_credentials_store=${tomlInlineValue(mode)}`];
  }
  throw new CliError(
    `Cannot preserve unsupported Codex authentication storage mode ${JSON.stringify(mode)}.`,
    3,
  );
}

export function codexAuthOverridesFromToml(
  contents,
  source = "Codex user config",
  options = {},
) {
  const { records, selectedLegacyProfile } = codexConfigRecords(
    contents,
    source,
  );
  return codexAuthOverridesFromRecords(
    effectiveCodexRecords(records, options, selectedLegacyProfile),
    source,
  );
}

export function codexAuthOverridesFromConfigs(
  configs,
  source = "layered Codex configuration",
  options = {},
) {
  return codexAuthOverridesFromRecords(
    effectiveCodexRecordsFromConfigs(configs, options),
    source,
  );
}

function configuredCodexAuthOverrides(state, env) {
  const configs = [];
  const systemConfig = codexConfigFile(codexSystemConfig(env));
  if (systemConfig) configs.push(systemConfig);
  const userConfig = codexConfigFile(path.join(codexHome(env), "config.toml"));
  if (userConfig) configs.push(userConfig);
  for (const managedFile of codexManagedConfigPaths(env)) {
    const config = codexConfigFile(managedFile);
    if (config) configs.push(config);
  }
  const managedPreference = codexManagedPreference(env);
  if (managedPreference) {
    configs.push({
      contents: managedPreference,
      file: "managed Codex preferences",
    });
  }
  if (configs.length === 0) return [];
  const legacyProfiles = Object.hasOwn(state, "codexLegacyProfiles")
    ? Boolean(state.codexLegacyProfiles)
    : codexUsesLegacyProfiles(state, env);
  const selectedLegacyProfile = legacyProfiles
    ? codexSelectedLegacyProfileFromConfigs(configs)
    : null;
  return codexAuthOverridesFromConfigs(
    configs,
    "layered Codex authentication configuration",
    { legacyProfiles, selectedLegacyProfile },
  );
}

function codexReviewPreferenceContext(state, env) {
  if (state.isolateCodexConfig) return null;
  const userConfig = codexConfigFile(path.join(codexHome(env), "config.toml"));
  if (!userConfig) return null;
  const legacyProfiles = codexUsesLegacyProfiles(state, env);
  const configs = [];
  const systemConfig = codexConfigFile(codexSystemConfig(env));
  if (systemConfig) {
    configs.push({ ...systemConfig, retainedForReview: true });
  }
  configs.push({ ...userConfig, retainedForReview: false });
  for (const managedFile of codexManagedConfigPaths(env)) {
    const config = codexConfigFile(managedFile);
    if (config) configs.push({ ...config, retainedForReview: true });
  }
  const managedPreference = codexManagedPreference(env);
  if (managedPreference) {
    configs.push({
      contents: managedPreference,
      file: "managed Codex preferences",
      retainedForReview: true,
    });
  }
  return { userConfig, legacyProfiles, configs };
}

function configuredCodexReviewPreferences(state, env, options = {}) {
  const context =
    options.preferenceContext ?? codexReviewPreferenceContext(state, env);
  if (!context) return {};
  const selectedLegacyProfile = Object.hasOwn(
    options,
    "selectedLegacyProfile",
  )
    ? options.selectedLegacyProfile
    : context.legacyProfiles
      ? codexSelectedLegacyProfileFromConfigs(context.configs)
      : null;
  return codexReviewPreferencesFromConfigs(
    options.preferenceConfigs ?? context.configs,
    "layered Codex review configuration",
    { legacyProfiles: context.legacyProfiles, selectedLegacyProfile },
  );
}

export function codexMcpServersForReview(
  state,
  env,
  inventory = configuredCodexMcpServers,
) {
  const servers = inventory(state, env);
  codexMcpDisableOverrides(servers);
  return servers;
}

export function codexReviewPreferencesForReview(
  state,
  env,
  inventory = configuredCodexReviewPreferences,
  options = {},
) {
  return inventory(state, env, options);
}

export function parseCodexFeatureList(output) {
  const features = new Map();
  const stages = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = line
      .trim()
      .match(/^([A-Za-z0-9_-]+)\s+(.+?)\s+(true|false)$/u);
    if (!match) continue;
    features.set(match[1], match[3] === "true");
    stages.set(match[1], match[2]);
  }
  if (features.size === 0) {
    throw new CliError("Cannot parse the Codex feature inventory.", 3);
  }
  Object.defineProperty(features, "stages", { value: stages });
  return features;
}

function runCodexFeatureList(root, env, disabledFeatures = []) {
  const args = [
    "features",
    "list",
    "-c",
    codexProjectUntrustedOverride(root),
  ];
  for (const feature of disabledFeatures) args.push("--disable", feature);
  const result = run("codex", args, {
    cwd: root,
    env,
    allowFailure: true,
    timeoutMs: codexPreflightTimeout(env),
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(
      `Cannot verify Codex feature isolation${detail ? `: ${detail}` : ""}.`,
      3,
    );
  }
  return parseCodexFeatureList(result.stdout);
}

export function codexPreflightTimeout(env) {
  return Math.min(
    integerOption(
      env.CODEX_REVIEW_LOOP_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      "timeout",
      1_000,
      86_400_000,
    ),
    MAX_CODEX_PREFLIGHT_TIMEOUT_MS,
  );
}

export function shareCodexIdentityForProbe(state, sourceEnv, temporaryHome) {
  const authOverrides = configuredCodexAuthOverrides(state, sourceEnv);
  if (authOverrides.includes('cli_auth_credentials_store="keyring"')) {
    return authOverrides;
  }
  const source = path.join(codexHome(sourceEnv), "auth.json");
  if (existsSync(source)) {
    readBoundedCodexRuntimeFile(
      source,
      MAX_CODEX_IDENTITY_BYTES,
      "Codex authentication identity",
    );
    const shared = path.join(temporaryHome, "auth.json");
    try {
      linkSync(source, shared);
      const sourceDetails = lstatSync(source);
      const sharedDetails = lstatSync(shared);
      if (
        !sourceDetails.isFile() ||
        sourceDetails.isSymbolicLink() ||
        !sharedDetails.isFile() ||
        sharedDetails.isSymbolicLink() ||
        sourceDetails.dev !== sharedDetails.dev ||
        sourceDetails.ino !== sharedDetails.ino
      ) {
        throw new Error("the shared identity is not the authoritative file");
      }
    } catch (error) {
      throw new CliError(
        `Cannot safely share file-backed Codex authentication with the isolated reviewer: ${error.message}. Configure keyring authentication or keep the repository and Codex home on the same filesystem.`,
        3,
      );
    }
  }
  return authOverrides;
}

function codexProcessIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function removeStaleCodexHomes(parent) {
  const now = Date.now();
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(CODEX_TEMP_HOME_PREFIX) || !entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(parent, entry.name);
    let details;
    try {
      details = lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) continue;
    const ownerText = entry.name
      .slice(CODEX_TEMP_HOME_PREFIX.length)
      .match(/^(\d+)-/u)?.[1];
    const owner = ownerText === undefined ? null : Number(ownerText);
    const ownerIsDead = owner !== null && !codexProcessIsRunning(owner);
    const homeIsTooOld =
      now - details.mtimeMs > MAX_CODEX_TEMP_HOME_AGE_MS;
    if (ownerIsDead || homeIsTooOld) {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
}

function retainedCodexHomeCleanup(temporaryHome) {
  let cleaned = false;
  const handlers = new Map();
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
  const cleanup = () => {
    if (cleaned) return;
    removeHandlers();
    rmSync(temporaryHome, { recursive: true, force: true });
    cleaned = true;
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      try {
        cleanup();
      } finally {
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      }
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return cleanup;
}

function cloudFragments(bundle, key, label) {
  const fragments = bundle?.[key]?.enterprise_managed;
  if (fragments === undefined || fragments === null) return [];
  if (!Array.isArray(fragments)) {
    throw new CliError(`Cannot parse ${label} in the Codex cloud bundle.`, 3);
  }
  return fragments.map((fragment, index) => {
    if (
      !fragment ||
      typeof fragment !== "object" ||
      typeof fragment.contents !== "string"
    ) {
      throw new CliError(`Cannot parse ${label} in the Codex cloud bundle.`, 3);
    }
    if (Buffer.byteLength(fragment.contents, "utf8") > MAX_CODEX_CONFIG_BYTES) {
      throw new CliError(
        `${label} fragment ${index + 1} exceeds ${MAX_CODEX_CONFIG_BYTES} bytes.`,
        3,
      );
    }
    const name =
      typeof fragment.name === "string" && fragment.name.trim()
        ? fragment.name.trim()
        : `fragment ${index + 1}`;
    return {
      contents: fragment.contents,
      file: `${label} (${name})`,
    };
  });
}

export function parseCodexCloudBundleCache(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new CliError(
      `Cannot parse the Codex cloud configuration cache: ${error.message}`,
      3,
    );
  }
  const bundle = parsed?.signed_payload?.bundle;
  if (!bundle || typeof bundle !== "object") {
    throw new CliError("Cannot parse the Codex cloud configuration cache.", 3);
  }
  return {
    managedConfigs: cloudFragments(
      bundle,
      "config_toml",
      "cloud-managed Codex config",
    ),
    requirementsConfigs: cloudFragments(
      bundle,
      "requirements_toml",
      "cloud-managed Codex requirements",
    ),
  };
}

export function parseCodexCloudRequirementsCache(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new CliError(
      `Cannot parse the legacy Codex cloud requirements cache: ${error.message}`,
      3,
    );
  }
  const requirements = parsed?.signed_payload?.contents;
  if (requirements === null) return [];
  if (typeof requirements !== "string") {
    throw new CliError(
      "Cannot parse the legacy Codex cloud requirements cache.",
      3,
    );
  }
  if (Buffer.byteLength(requirements, "utf8") > MAX_CODEX_CONFIG_BYTES) {
    throw new CliError(
      `Legacy cloud-managed Codex requirements exceed ${MAX_CODEX_CONFIG_BYTES} bytes.`,
      3,
    );
  }
  return [
    {
      contents: requirements,
      file: "legacy cloud-managed Codex requirements",
    },
  ];
}

function readCodexCloudBundle(temporaryHome) {
  const cache = path.join(temporaryHome, "cloud-config-bundle-cache.json");
  if (existsSync(cache)) {
    const bytes = readBoundedCodexRuntimeFile(
      cache,
      MAX_CODEX_CLOUD_CACHE_BYTES,
      "Codex cloud configuration cache",
    );
    return parseCodexCloudBundleCache(bytes.toString("utf8"));
  }
  const legacyCache = path.join(temporaryHome, "cloud-requirements-cache.json");
  if (!existsSync(legacyCache)) {
    return { managedConfigs: [], requirementsConfigs: [] };
  }
  const bytes = readBoundedCodexRuntimeFile(
    legacyCache,
    MAX_CODEX_CLOUD_CACHE_BYTES,
    "legacy Codex cloud requirements cache",
  );
  return {
    managedConfigs: [],
    requirementsConfigs: parseCodexCloudRequirementsCache(
      bytes.toString("utf8"),
    ),
  };
}

function runCodexManagedConfigProbe(
  root,
  env,
  temporaryHome,
  disabledFeatures,
  authOverrides = [],
) {
  const missingSchema = path.join(
    temporaryHome,
    "configuration-preflight-output-schema-must-not-exist.json",
  );
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    codexProjectUntrustedOverride(root),
  ];
  for (const override of authOverrides) args.push("-c", override);
  for (const feature of disabledFeatures) args.push("--disable", feature);
  args.push(
    "-c",
    'web_search="disabled"',
    "-c",
    "notify=[]",
    "--ephemeral",
    "--output-schema",
    missingSchema,
    "configuration preflight",
  );
  const result = run("codex", args, {
    cwd: root,
    env,
    allowFailure: true,
    timeoutMs: codexPreflightTimeout(env),
  });
  const detail = `${result.stderr}\n${result.stdout}`;
  if (
    result.status === 0 ||
    !detail.includes("Failed to read output schema file") ||
    !detail.includes(path.basename(missingSchema))
  ) {
    throw new CliError(
      `Cannot validate Codex's authenticated managed configuration${detail.trim() ? `: ${detail.trim()}` : ""}.`,
      3,
    );
  }
  return readCodexCloudBundle(temporaryHome);
}

function assertCloudCodexConfigurationSafe(
  state,
  env,
  inventory,
  reviewOptions = {},
) {
  const cloudConfigs = inventory.managedConfigs ?? [];
  const localInventory = reviewOptions.localConfigInventory ?? {};
  const ordinaryConfigs = localInventory.ordinaryConfigs ?? [];
  const managedConfigs = localInventory.managedConfigs ?? [];
  const requirementsConfigs = localInventory.requirementsConfigs ?? [];
  const userPreferenceConfig = reviewOptions.preferenceContext?.userConfig;
  const cloudConfigsByPrecedence = [...cloudConfigs].reverse();
  const mergedConfigs = [
    ...ordinaryConfigs,
    ...managedConfigs,
    ...cloudConfigsByPrecedence,
  ];
  const preferenceConfigs = [
    ...ordinaryConfigs.map((config) => ({
      ...config,
      retainedForReview: true,
    })),
    ...(userPreferenceConfig
      ? [{ ...userPreferenceConfig, retainedForReview: false }]
      : []),
    ...managedConfigs.map((config) => ({
      ...config,
      retainedForReview: true,
    })),
    ...cloudConfigsByPrecedence.map((config) => ({
      ...config,
      retainedForReview: true,
    })),
  ];
  const legacyProfiles =
    mergedConfigs.length === 0
      ? false
      : Object.hasOwn(state, "codexLegacyProfiles")
        ? Boolean(state.codexLegacyProfiles)
        : codexUsesLegacyProfiles(state, env);
  const selectedLegacyProfile = legacyProfiles
    ? codexSelectedLegacyProfileFromConfigs(mergedConfigs)
    : null;
  const selectedLegacyPreferenceProfile = legacyProfiles
    ? codexSelectedLegacyProfileFromConfigs(preferenceConfigs)
    : null;
  const configOptions = { legacyProfiles, selectedLegacyProfile };
  const mcpNames = new Set(reviewOptions.mcpServers ?? []);
  for (const config of ordinaryConfigs) {
    const promptHazards = codexPromptHazardsFromToml(
      config.contents,
      config.file,
      configOptions,
    );
    const approvalHazards = codexApprovalHazardsFromToml(
      config.contents,
      config.file,
      configOptions,
    );
    if (promptHazards.length > 0 || approvalHazards.length > 0) {
      throw new CliError(
        `Cannot safely isolate Codex settings from ${config.file}: ${[
          ...promptHazards,
          ...approvalHazards,
        ]
          .sort()
          .join(", ")}.`,
        3,
      );
    }
    for (const name of codexMcpNamesFromToml(
      config.contents,
      config.file,
      configOptions,
    )) {
      mcpNames.add(name);
    }
  }
  for (const config of [...managedConfigs, ...cloudConfigs]) {
    assertManagedCodexConfigSafe(
      config.contents,
      config.file,
      legacyProfiles,
      selectedLegacyProfile,
    );
  }
  for (const config of [
    ...requirementsConfigs,
    ...(inventory.requirementsConfigs ?? []),
  ]) {
    assertCodexRequirementsSafe(config.contents, config.file);
  }
  const mergedMcpServers = [...mcpNames].sort();
  codexMcpDisableOverrides(mergedMcpServers);
  if (reviewOptions.mcpServers) {
    reviewOptions.mcpServers.splice(
      0,
      reviewOptions.mcpServers.length,
      ...mergedMcpServers,
    );
  }
  const usesReadOnlyDefaultPermissions = [
    ...ordinaryConfigs,
    ...managedConfigs,
    ...requirementsConfigs,
    ...cloudConfigs,
    ...(inventory.requirementsConfigs ?? []),
  ].some((config) =>
    codexUsesReadOnlyPermissions(
      config.contents,
      config.file,
      configOptions,
    ),
  );
  return {
    selectedLegacyProfile,
    selectedLegacyPreferenceProfile,
    preferenceConfigs,
    usesReadOnlyDefaultPermissions,
  };
}

export function codexFeaturesForReview(
  state,
  env,
  storage,
  inventory = runCodexFeatureList,
  managedInventory = runCodexManagedConfigProbe,
  options = {},
) {
  let temporaryHome;
  let retained = false;
  let cleanupCodexHome;
  const parent = storage ?? os.tmpdir();
  mkdirSync(parent, { recursive: true });
  removeStaleCodexHomes(parent);
  temporaryHome = mkdtempSync(
    path.join(parent, `${CODEX_TEMP_HOME_PREFIX}${process.pid}-`),
  );
  cleanupCodexHome = retainedCodexHomeCleanup(temporaryHome);
  const probeEnv = { ...env, CODEX_HOME: temporaryHome };
  try {
    preserveCodexHomeManagedConfigForIsolation(
      options.localConfigInventory,
      env,
      temporaryHome,
    );
    const supported = inventory(state.root, probeEnv);
    const disabled = [...supported.keys()].filter((feature) =>
      codexFeatureRequiresIsolation(feature) &&
      supported.stages?.get(feature) !== "removed",
    );
    const effective = inventory(state.root, probeEnv, disabled);
    const active = disabled.filter(
      (feature) => effective.get(feature) !== false,
    );
    if (active.length > 0) {
      throw new CliError(
        `Cannot safely disable managed Codex features: ${active.join(", ")}.`,
        3,
      );
    }
    const authOverrides =
      managedInventory === runCodexManagedConfigProbe
        ? shareCodexIdentityForProbe(state, env, temporaryHome)
        : [];
    const authenticated = managedInventory(
      state.root,
      probeEnv,
      temporaryHome,
      disabled,
      authOverrides,
    );
    const configuration = assertCloudCodexConfigurationSafe(
      state,
      probeEnv,
      authenticated,
      options,
    );
    retained = Boolean(options.retainHome);
    return withCodexIsolationMetadata(disabled, {
      codexHome: retained ? temporaryHome : null,
      cleanupCodexHome: retained ? cleanupCodexHome : null,
      selectedLegacyProfile: configuration.selectedLegacyProfile,
      selectedLegacyPreferenceProfile:
        configuration.selectedLegacyPreferenceProfile,
      preferenceConfigs: configuration.preferenceConfigs,
      usesReadOnlyDefaultPermissions:
        configuration.usesReadOnlyDefaultPermissions,
      authOverrides,
    });
  } finally {
    if (temporaryHome && !retained) {
      cleanupCodexHome();
    }
  }
}

export function codexReviewArgs(
  isolateUserConfig = false,
  mcpServers = [],
  disabledFeatures = CODEX_REVIEW_DISABLED_FEATURES,
  reviewConfig = {},
) {
  const mcpOverrides = codexMcpDisableOverrides(mcpServers);
  const preferences = isolateUserConfig
    ? {}
    : (reviewConfig.preferences ?? {});
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    codexProjectUntrustedOverride(reviewConfig.root ?? process.cwd()),
  ];
  if (!reviewConfig.usesReadOnlyDefaultPermissions) {
    args.splice(3, 0, "--sandbox", "read-only");
  }
  for (const override of reviewConfig.authOverrides ?? []) {
    args.push("-c", override);
  }
  const reviewModel = preferences.review_model ?? preferences.model;
  if (preferences.model_provider) {
    args.push(
      "-c",
      `model_provider=${tomlInlineValue(preferences.model_provider)}`,
    );
  }
  if (reviewModel) args.push("--model", reviewModel);
  if (preferences.model_reasoning_effort) {
    args.push(
      "-c",
      `model_reasoning_effort=${tomlInlineValue(preferences.model_reasoning_effort)}`,
    );
  }
  for (const feature of disabledFeatures) args.push("--disable", feature);
  args.push(
    "-c",
    'web_search="disabled"',
    "-c",
    "notify=[]",
    ...mcpOverrides.flatMap((override) => ["-c", override]),
    "review",
    "--ephemeral",
    "-",
  );
  return args;
}

function providerInvocation(state, prompt, env, repo) {
  switch (state.provider) {
    case "codex": {
      const mcpServers = codexMcpServersForReview(state, env);
      const preferenceContext = codexReviewPreferenceContext(state, env);
      const disabledFeatures = codexFeaturesForReview(
        state,
        env,
        repo.storage,
        runCodexFeatureList,
        runCodexManagedConfigProbe,
        {
          retainHome: true,
          localConfigInventory: mcpServers.localConfigInventory,
          mcpServers,
          preferenceContext,
        },
      );
      const temporaryHome = disabledFeatures.codexHome;
      const cleanupCodexHome = disabledFeatures.cleanupCodexHome;
      try {
        const preferences = codexReviewPreferencesForReview(
          state,
          env,
          undefined,
          {
            preferenceContext,
            selectedLegacyProfile:
              disabledFeatures.selectedLegacyPreferenceProfile,
            preferenceConfigs: disabledFeatures.preferenceConfigs,
          },
        );
        return {
          command: "codex",
          args: codexReviewArgs(
            Boolean(state.isolateCodexConfig),
            mcpServers,
            disabledFeatures,
            {
              root: state.root,
              preferences,
              usesReadOnlyDefaultPermissions: Boolean(
                disabledFeatures.usesReadOnlyDefaultPermissions,
              ),
              authOverrides: disabledFeatures.authOverrides,
            },
          ),
          input: prompt,
          env: { ...env, CODEX_HOME: temporaryHome },
          cleanup: cleanupCodexHome,
        };
      } catch (error) {
        cleanupCodexHome();
        throw error;
      }
    }
    case "gemini":
      return {
        command: "gemini",
        args: ["-p", prompt, "--output-format", "json"],
      };
    case "claude":
      return {
        command: "claude",
        args: [
          "-p",
          prompt,
          "--permission-mode",
          "plan",
          "--tools",
          "Bash,Read,Glob,Grep",
          "--output-format",
          "text",
        ],
      };
    case "opencode":
      return {
        command: "opencode",
        args: ["run", "--agent", "plan", prompt],
      };
    case "custom": {
      const [command, ...args] = parseCustomCommand(env);
      return { command, args, input: prompt };
    }
    default:
      throw new CliError(`Unsupported provider: ${state.provider}`, 3);
  }
}

export function captureProcess(invocation, options) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    let forcedKind = null;
    let killTimer;
    let timer;
    let resolveChildExited;
    const childExited = new Promise((resolveExit) => {
      resolveChildExited = resolveExit;
    });
    const maxCaptureBytes = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (value, preserveKillTimer = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!preserveKillTimer) clearTimeout(killTimer);
      resolve({ ...value, childExited });
    };
    const terminate = () => {
      if (killTimer) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const append = (kind, chunk) => {
      if (forcedKind) return;
      capturedBytes += chunk.length;
      if (capturedBytes > maxCaptureBytes) {
        forcedKind = "output_limit";
        stderr = `${stderr}\nProvider output exceeded ${maxCaptureBytes} bytes.`;
        terminate();
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ ok: false, kind: forcedKind, stdout, stderr }, true);
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolveChildExited();
    });
    child.on("error", (error) => {
      clearTimeout(killTimer);
      resolveChildExited();
      finish({
        ok: false,
        kind: error.code === "ENOENT" ? "unavailable" : "failed",
        stdout,
        stderr: `${stderr}\n${error.message}`,
      });
    });
    child.on("close", (code, signal) => {
      if (forcedKind) {
        finish({ ok: false, kind: forcedKind, stdout, stderr });
      } else {
        finish({ ok: code === 0, code, signal, stdout, stderr });
      }
    });

    timer = setTimeout(() => {
      forcedKind = "timeout";
      terminate();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ ok: false, kind: forcedKind, stdout, stderr }, true);
    }, options.timeoutMs);
    timer.unref();

    if (invocation.input !== undefined) child.stdin.end(invocation.input);
    else child.stdin.end();
  });
}

async function cleanupProviderInvocation(invocation, result) {
  await result?.childExited;
  try {
    invocation?.cleanup?.();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function persistProviderCapture(rawFile, result, invocation) {
  let cleanupError;
  try {
    mkdirSync(path.dirname(rawFile), { recursive: true });
    const rawCapture = `${result.stdout ?? ""}${
      result.stderr ? `\n\n[provider stderr]\n${result.stderr}` : ""
    }`;
    writeFileSync(rawFile, rawCapture, { encoding: "utf8", mode: 0o600 });
  } finally {
    cleanupError = await cleanupProviderInvocation(invocation, result);
  }
  return cleanupError;
}

function normalizeProviderOutput(provider, stdout) {
  if (provider !== "gemini") return stdout.trim();
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.response === "string") return parsed.response.trim();
    throw new Error("JSON did not contain a string `response` field");
  } catch (error) {
    throw new CliError(`Gemini returned invalid JSON: ${error.message}`, 4);
  }
}

function providerErrorKind(result) {
  if (result.kind) return result.kind;
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    /rate.?limit|usage.?limit|quota|resource_exhausted|too many requests|\b429\b/u.test(
      text,
    )
  ) {
    return "rate_limited";
  }
  if (/unauthorized|forbidden|authentication|login required|\b401\b|\b403\b/u.test(text)) {
    return "authentication";
  }
  return "failed";
}

function codexExplicitClean(text) {
  const patterns = [
    /^no\s+(?:(?:in-scope\s+functional|actionable|unresolved)\s+)?(?:findings?|defects?|issues?|bugs?)(?:\s+(?:(?:were\s+)?(?:found|identified|detected)|remains?))?[.!]?$/iu,
    /^(?:i\s+)?(?:found|identified|detected)\s+no\s+(?:(?:in-scope\s+functional|actionable|unresolved)\s+)?(?:findings?|defects?|issues?|bugs?)[.!]?$/iu,
    /^(?:i\s+)?(?:did\s+not|didn't)\s+(?:find|identify|detect)\s+(?:any\s+)?(?:(?:in-scope\s+functional|actionable|unresolved)\s+)?(?:findings?|defects?|issues?|bugs?)[.!]?$/iu,
  ];
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && patterns.some((pattern) => pattern.test(lines[0]));
}

function normalizeCodexCleanLine(line) {
  return line
    .trim()
    .replace(/^(?:[-*>#]\s*)+/u, "")
    .replace(/[*_`]/gu, "")
    .replace(
      /^(?:(?:overall\s+)?(?:review\s+)?(?:summary|verdict|result|assessment|conclusion|status))\s*(?::|—|-)\s*/iu,
      "",
    )
    .trim();
}

function containsCodexCleanVerdict(text) {
  return text
    .split(/\r?\n/u)
    .some((line) => codexExplicitClean(normalizeCodexCleanLine(line)));
}

function parseCodexStructuredReview(text) {
  if (!text.startsWith("{")) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.findings) ||
    typeof value.overall_explanation !== "string" ||
    !value.overall_explanation.trim() ||
    typeof value.overall_confidence_score !== "number" ||
    !Number.isFinite(value.overall_confidence_score) ||
    value.overall_confidence_score < 0 ||
    value.overall_confidence_score > 1 ||
    !["patch is correct", "patch is incorrect"].includes(
      value.overall_correctness,
    )
  ) {
    return {
      status: "invalid",
      findings: [],
      reason: "Codex returned an invalid structured review object.",
    };
  }
  const findings = [];
  for (const finding of value.findings) {
    const title =
      typeof finding?.title === "string" ? finding.title : null;
    const normalizedTitle =
      title?.replace(/^\[P[0-3]\]\s*/u, "").trim() ?? "";
    const titlePriority = title?.match(/^\[P([0-3])\]\s*/u);
    const declaredPriority = finding?.priority;
    const priority =
      declaredPriority === undefined || declaredPriority === null
        ? titlePriority
          ? Number(titlePriority[1])
          : null
        : declaredPriority;
    const location = finding?.code_location;
    const range = location?.line_range;
    if (
      !finding ||
      title === null ||
      !normalizedTitle ||
      typeof finding.body !== "string" ||
      !finding.body.trim() ||
      typeof finding.confidence_score !== "number" ||
      !Number.isFinite(finding.confidence_score) ||
      finding.confidence_score < 0 ||
      finding.confidence_score > 1 ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 3 ||
      (titlePriority && Number(titlePriority[1]) !== priority) ||
      typeof location?.absolute_file_path !== "string" ||
      !location.absolute_file_path.trim() ||
      !path.isAbsolute(location.absolute_file_path) ||
      !Number.isInteger(range?.start) ||
      !Number.isInteger(range?.end) ||
      range.start < 1 ||
      range.end < range.start
    ) {
      return {
        status: "invalid",
        findings: [],
        reason: "Codex returned an invalid structured review finding.",
      };
    }
    findings.push({
      priority: `P${priority}`,
      title: normalizedTitle,
      file: location.absolute_file_path,
      line: range.start,
      endLine: range.end,
      key: `${normalizedTitle.toLowerCase()}|${location.absolute_file_path.toLowerCase()}:${range.start}`,
    });
  }
  if (
    findings.length === 0 &&
    value.overall_correctness === "patch is correct" &&
    codexExplicitClean(normalizeCodexCleanLine(value.overall_explanation))
  ) {
    return { status: "clean", findings: [] };
  }
  if (
    findings.length > 0 &&
    value.overall_correctness === "patch is incorrect" &&
    !codexExplicitClean(normalizeCodexCleanLine(value.overall_explanation))
  ) {
    return { status: "findings", findings };
  }
  return {
    status: "invalid",
    findings,
    reason: "Codex structured findings contradict the overall correctness verdict.",
  };
}

export function parseReview(output, provider = "custom") {
  const text = output.trim();
  if (provider === "codex") {
    const structured = parseCodexStructuredReview(text);
    if (structured) return structured;
  }
  const hasSentinel = text
    .split(/\r?\n/u)
    .some((line) => line.trim() === CLEAN_SENTINEL);
  const heading = /^(?:Full review comments|Review comment):\s*$/imu.test(text);
  const prioritySyntax = /^\s*-\s+\[P[0-3]\]/imu.test(text);
  const findings = [];
  const pattern =
    /^\s*-\s+\[(P[0-3])\]\s+(.+?)\s+(?:—|--|-)\s+(.+?):(\d+)(?:-(\d+))?\s*$/gmu;
  for (const match of text.matchAll(pattern)) {
    findings.push({
      priority: match[1],
      title: match[2].trim(),
      file: match[3].trim(),
      line: Number(match[4]),
      endLine: match[5] ? Number(match[5]) : undefined,
      key: `${match[2].trim().toLowerCase()}|${match[3]
        .trim()
        .toLowerCase()}:${Number(match[4])}`,
    });
  }
  const hasNativeCodexClean =
    provider === "codex" &&
    !heading &&
    !prioritySyntax &&
    codexExplicitClean(normalizeCodexCleanLine(text));
  const containsNativeCodexClean =
    provider === "codex" && containsCodexCleanVerdict(text);
  const nonemptyLines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasValidSentinel =
    nonemptyLines.length === 1 && nonemptyLines[0] === CLEAN_SENTINEL;

  if (
    (hasValidSentinel || hasNativeCodexClean) &&
    findings.length === 0 &&
    !heading &&
    !prioritySyntax
  ) {
    return { status: "clean", findings: [] };
  }
  if (!hasSentinel && !containsNativeCodexClean && heading && findings.length > 0) {
    return { status: "findings", findings };
  }
  return {
    status: "invalid",
    findings,
    reason:
      hasSentinel || containsNativeCodexClean
        ? "The clean verdict was mixed with finding syntax or a findings heading."
        : provider === "codex"
          ? "Expected structured findings or an explicit Codex no-findings verdict."
          : "Expected a findings heading with structured findings or the exact clean sentinel.",
  };
}

function roundFile(repo, state, round) {
  return path.join(repo.runsDir, state.runId, `round-${round}.txt`);
}

function reviewSummary(state) {
  return {
    runId: state.runId,
    phase: state.phase,
    provider: state.provider,
    requestedProvider: state.requestedProvider,
    base: state.base,
    outcome: state.outcome,
    round: state.round,
    maxRounds: state.maxRounds,
    isolateCodexConfig: Boolean(state.isolateCodexConfig),
    lastReview: state.lastReview,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

function parseArguments(argv) {
  const options = {};
  const positional = [];
  const booleans = new Set(["json", "help", "isolate-codex-config"]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (booleans.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Option --${key} requires a value.`, 2);
    }
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

function outcomeFromOptions(options) {
  if (options.outcome && options["outcome-file"]) {
    throw new CliError("Use only one of --outcome and --outcome-file.", 2);
  }
  if (options["outcome-file"]) {
    return readFileSync(path.resolve(options["outcome-file"]), "utf8").trim();
  }
  return options.outcome?.trim() ?? "";
}

function integerOption(value, fallback, name, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliError(
      `--${name} must be an integer between ${minimum} and ${maximum}.`,
      2,
    );
  }
  return parsed;
}

export function reviewRoundLimit(provider, configured) {
  if (configured === undefined) {
    return provider === "codex" ? null : DEFAULT_FALLBACK_MAX_ROUNDS;
  }
  return integerOption(configured, null, "max-rounds", 1, 100);
}

async function startCommand(repo, options, env) {
  if (existsSync(repo.activeFile)) {
    const active = loadActive(repo);
    throw new CliError(
      `Run ${active.runId} is already active at round ${active.round}. Use \`status\` or finish it explicitly.`,
      2,
    );
  }
  const outcome = outcomeFromOptions(options);
  if (!outcome) {
    throw new CliError(
      "An approved outcome is required. Supply --outcome or --outcome-file.",
      2,
    );
  }
  const base = resolveBase(repo.root, options.base);
  const files = scopeFiles(repo.root, base);
  if (files.length === 0) {
    throw new CliError(
      `The review scope is empty relative to ${base}; there is nothing to review.`,
      2,
    );
  }
  const requestedProvider = options.provider ?? "auto";
  const isolateCodexConfig = Boolean(options["isolate-codex-config"]);
  const provider = chooseProvider(requestedProvider, env, {
    root: repo.root,
    storage: repo.storage,
    isolateCodexConfig,
  });
  const now = new Date().toISOString();
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId: `${now.slice(0, 10)}-${randomUUID()}`,
    phase: "active",
    root: repo.root,
    base,
    outcome,
    requestedProvider,
    provider,
    round: 0,
    maxRounds: reviewRoundLimit(provider, options["max-rounds"]),
    isolateCodexConfig,
    initialHead: git(repo.root, ["rev-parse", "HEAD"]).stdout.trim(),
    findingHistory: {},
    lastReview: null,
    startedAt: now,
    updatedAt: now,
  };
  saveActive(repo, state);
  return {
    status: "started",
    files,
    state: reviewSummary(state),
    stateFile: repo.activeFile,
  };
}

async function reviewCommand(repo, env) {
  const state = loadActive(repo);
  state.root = repo.root;
  if (!["active", "provider_error", "invalid", "clean"].includes(state.phase)) {
    throw new CliError(
      `Run phase is ${state.phase}; it cannot start another review round.`,
      5,
    );
  }
  if (state.maxRounds !== null && state.round >= state.maxRounds) {
    state.phase = "round_limit";
    saveActive(repo, state);
    return {
      status: "round_limit",
      round: state.round,
      maxRounds: state.maxRounds,
    };
  }

  const files = scopeFiles(repo.root, state.base);
  if (files.length === 0) {
    throw new CliError("The active run's Git scope is now empty.", 2);
  }
  const before = snapshot(repo.root, state.base);
  const prompt = reviewPrompt(state, files);
  const timeoutMs = integerOption(
    env.CODEX_REVIEW_LOOP_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "timeout",
    1_000,
    86_400_000,
  );
  let invocation;
  let result;
  try {
    invocation = providerInvocation(state, prompt, env, repo);
    state.round += 1;
    state.phase = "reviewing";
    state.lastReview = {
      status: "running",
      round: state.round,
      snapshot: before,
      startedAt: new Date().toISOString(),
    };
    saveActive(repo, state);

    result = await captureProcess(invocation, {
      cwd: repo.root,
      env: invocation.env ?? env,
      timeoutMs,
    });
  } catch (error) {
    await cleanupProviderInvocation(invocation, result);
    throw error;
  }
  const rawFile = roundFile(repo, state, state.round);
  const cleanupError = await persistProviderCapture(
    rawFile,
    result,
    invocation,
  );

  if (!result.ok) {
    const kind = providerErrorKind(result);
    state.phase = "provider_error";
    state.lastReview = {
      status: "provider_error",
      kind,
      round: state.round,
      snapshot: before,
      outputFile: rawFile,
      finishedAt: new Date().toISOString(),
      ...(cleanupError ? { cleanupError } : {}),
    };
    saveActive(repo, state);
    return {
      status: "provider_error",
      kind,
      round: state.round,
      outputFile: rawFile,
      reviewerOutput: result.stdout.trim(),
      providerError: result.stderr.trim(),
      ...(cleanupError ? { cleanupError } : {}),
    };
  }

  if (cleanupError) {
    state.phase = "provider_error";
    state.lastReview = {
      status: "provider_error",
      kind: "cleanup_failed",
      cleanupError,
      round: state.round,
      snapshot: before,
      outputFile: rawFile,
      finishedAt: new Date().toISOString(),
    };
    saveActive(repo, state);
    return {
      status: "provider_error",
      kind: "cleanup_failed",
      cleanupError,
      round: state.round,
      outputFile: rawFile,
      reviewerOutput: result.stdout.trim(),
      providerError: result.stderr.trim(),
    };
  }

  let reviewerOutput;
  try {
    reviewerOutput = normalizeProviderOutput(state.provider, result.stdout);
  } catch (error) {
    state.phase = "invalid";
    state.lastReview = {
      status: "invalid",
      reason: error.message,
      round: state.round,
      snapshot: before,
      outputFile: rawFile,
      finishedAt: new Date().toISOString(),
    };
    saveActive(repo, state);
    return {
      status: "invalid",
      reason: error.message,
      round: state.round,
      outputFile: rawFile,
      reviewerOutput: result.stdout.trim(),
    };
  }

  const after = snapshot(repo.root, state.base);
  if (before !== after) {
    state.phase = "invalid";
    state.lastReview = {
      status: "invalid",
      reason: "The Git scope changed while the reviewer was running.",
      round: state.round,
      snapshot: before,
      outputFile: rawFile,
      finishedAt: new Date().toISOString(),
    };
    saveActive(repo, state);
    return {
      status: "invalid",
      reason: state.lastReview.reason,
      round: state.round,
      outputFile: rawFile,
      reviewerOutput,
    };
  }

  const parsed = parseReview(reviewerOutput, state.provider);
  state.findingHistory ??= {};
  const recurring = [];
  if (parsed.status === "findings") {
    const uniqueFindings = new Map(
      parsed.findings.map((finding) => [finding.key, finding]),
    );
    for (const finding of uniqueFindings.values()) {
      const history = state.findingHistory[finding.key] ?? {
        appearances: 0,
        fixAttempts: 0,
        lastSnapshot: null,
      };
      if (history.lastSnapshot && history.lastSnapshot !== before) {
        history.fixAttempts += 1;
      }
      history.appearances += 1;
      history.lastSnapshot = before;
      history.lastSeenRound = state.round;
      state.findingHistory[finding.key] = history;
      if (history.fixAttempts >= 2) {
        recurring.push({ ...finding, fixAttempts: history.fixAttempts });
      }
    }
  }
  const status = recurring.length > 0 ? "oscillation" : parsed.status;
  state.phase =
    status === "clean"
      ? "clean"
      : status === "oscillation"
        ? "oscillation"
        : status === "invalid"
          ? "invalid"
          : "active";
  state.lastReview = {
    status,
    reason: parsed.reason,
    findings: parsed.findings,
    recurringFindings: recurring,
    round: state.round,
    snapshot: before,
    outputFile: rawFile,
    finishedAt: new Date().toISOString(),
  };
  saveActive(repo, state);
  return {
    status,
    reason: parsed.reason,
    findings: parsed.findings,
    recurringFindings: recurring,
    round: state.round,
    outputFile: rawFile,
    reviewerOutput,
  };
}

const AI_ATTRIBUTION_IDENTITY_SOURCE = String.raw`(?:ai|artificial intelligence|llm|language model|assistant|agent|bot|reviewer|codex|claude|gemini|chatgpt|gpt(?:-\d+(?:\.\d+)*)?|openai|anthropic|opencode|(?:github[\s-]+)?copilot|cursor|windsurf|aider|devin|codeium|tabnine|qodo|amazon\s+q|sourcegraph\s+cody)`;
const WORKFLOW_ACTION_SOURCE = String.raw`(?:address(?:es|ed|ing)?|appl(?:y|ies|ied|ying)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|handl(?:e|es|ed|ing)|incorporat(?:e|es|ed|ing)|implement(?:s|ed|ing)?|clos(?:e|es|ed|ing)|clear(?:s|ed|ing)?|tackl(?:e|es|ed|ing)|satisf(?:y|ies|ied|ying)|(?:respond|react)(?:s|ed|ing)?\s+to)`;
const WORKFLOW_ARTIFACT_SOURCE = String.raw`(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)`;

const PRODUCT_TERM_PATTERNS = [
  /\b(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\b.{0,50}\b(?:review|reviewer|feedback|findings?|comments?|loop|suggestions?|requests?|recommendations?|instructions?|guidance)\b/iu,
  /\b(?:review|reviewer|feedback|findings?|comments?|loop|suggestions?|requests?|recommendations?|instructions?|guidance)\b.{0,50}\b(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\b/iu,
  /\b(?:after|during|from|following)\s+(?:(?:the|a)\s+)?(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?(?:review|reviewer)\b/iu,
  /\b(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+(?:found|identified|reported|flagged|raised|caught|suggested|requested|required)\b/iu,
];

const WORKFLOW_ATTRIBUTION_PATTERNS = [
  new RegExp(
    String.raw`\b${WORKFLOW_ACTION_SOURCE}\s+(?:the\s+)?${AI_ATTRIBUTION_IDENTITY_SOURCE}(?:['’]s)?(?:\s+review(?:er)?(?:['’]s)?)?\s+${WORKFLOW_ARTIFACT_SOURCE}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b${WORKFLOW_ARTIFACT_SOURCE}\s+(?:from|by)\s+(?:(?:an?|the)\s+)?${AI_ATTRIBUTION_IDENTITY_SOURCE}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b${AI_ATTRIBUTION_IDENTITY_SOURCE}\s+review(?:er)?\s+(?:asked|requested|required|suggested|said|recommended|instructed|flagged|identified)\b`,
    "iu",
  ),
  /\b(?:reviewed|generated|suggested|assisted|authored|co[ -]?authored|written|created|made|produced)\s+(?:by|with)\s+(?:(?:an?|the)\s+)?(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode|ai|llm|reviewer)\b/iu,
  /\b(?:(?:an?|the)\s+)?(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode|ai|llm|reviewer)[\s-]+(?:reviewed|generated|suggested|assisted|authored|co[ -]?authored|written|created|made|produced)\b/iu,
  /\b(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)\s+(?:from|by)\s+(?:(?:an?|the)\s+)?(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode|ai|llm|reviewer)\b/iu,
  /\b(?:found|identified|reported|flagged|raised|caught|suggested|requested|required)\s+(?:by|during|in|from|through)\s+(?:(?:the|a)\s+)?(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?(?:review|reviewer|feedback|findings?|comments?)|(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu,
  /\b(?:based\s+on|because\s+of|prompted\s+by|in\s+response\s+to)\s+(?:(?:the|a)\s+)?(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?(?:review|reviewer|feedback|findings?|comments?)|(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu,
  /\b(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+)?(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)\s+(?:prompted|caused|drove|motivated|triggered|led\s+to|resulted\s+in)\s+(?:(?:this|the|these)\s+)?(?:changes?|code|implementation|commits?|patch|work)\b/iu,
  /\bper\s+(?:(?:the|a)\s+(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?(?:review|reviewer|feedback|findings?|comments?)|(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))|(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu,
  /\bfollowing\s+(?:(?:the|a)\s+)?(?:(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+)?(?:feedback|findings?|comments?)|(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?|(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode))\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu,
  /\b(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+(?:asked|requested|required|suggested|said|recommended|instructed|flagged|identified)\b/iu,
  /\b(?:(?:an?|the)\s+)?(?:(?:ai|llm)(?:\s+review(?:er)?)?|review(?:er)?)\s+(?:found|identified|reported|flagged|raised|caught|suggested|requested|required)\b/iu,
  /\b(?:found|identified|reported|flagged|raised|caught|suggested|requested|required)\s+(?:by|during|in|from|through)\s+(?:(?:an?|the)\s+)?(?:(?:ai|llm)(?:\s+review(?:er)?)?|review(?:er)?)\b/iu,
  /\b(?:address(?:es|ed|ing)?|appl(?:y|ies|ied|ying)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|handl(?:e|es|ed|ing)|incorporat(?:e|es|ed|ing)|implement(?:s|ed|ing)?|clos(?:e|es|ed|ing)|clear(?:s|ed|ing)?|tackl(?:e|es|ed|ing)|satisf(?:y|ies|ied|ying)|(?:respond|react)(?:s|ed|ing)?\s+to)\s+(?:the\s+)?(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+review(?:er)?|(?:ai|llm)(?:\s+review(?:er)?)?|review(?:er)?)\s+(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)\b/iu,
  /\b(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)\s+(?:was|were|is|are|has\s+been|have\s+been)\s+(?:addressed|applied|fixed|resolved|handled|incorporated|implemented|closed|cleared|tackled|satisfied)\b/iu,
  /\b(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?(?:\s+loop)?\s+(?:passed|completed|succeeded|finished|approved|was\s+clean)\b/iu,
  /\b(?:ai|llm)[ -]?(?:generated|assisted|reviewed|suggested)\b/iu,
  /\breview(?:er)?[ -]?round\s*#?\d+\b/iu,
];

const PRODUCT_PROVENANCE_IDENTITY_SOURCE = String.raw`(?:ai|llm|reviewer|codex|claude|gemini|chatgpt|gpt(?:-\d+(?:\.\d+)*)?|openai|anthropic|opencode|(?:github\s+)?copilot)`;
const PRODUCT_PROVENANCE_ARTIFACT_SOURCE = String.raw`(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance|reviews?|outputs?|results?|reports?|metadata|artifacts?|records?|events?|diagnostics?)`;
const PRODUCT_PROVENANCE_SOURCE = String.raw`\b${PRODUCT_PROVENANCE_IDENTITY_SOURCE}[\s-]+(?:generated|authored|written|created|produced)\s+(?:review\s+)?${PRODUCT_PROVENANCE_ARTIFACT_SOURCE}\b`;
const PASSIVE_PRODUCT_PROVENANCE_SOURCE = String.raw`\b${PRODUCT_PROVENANCE_ARTIFACT_SOURCE}\s+(?:generated|authored|written|created|produced)\s+by\s+(?:(?:an?|the)\s+)?${PRODUCT_PROVENANCE_IDENTITY_SOURCE}\b`;
const PRODUCT_PROVENANCE_SOURCES = [
  PRODUCT_PROVENANCE_SOURCE,
  PASSIVE_PRODUCT_PROVENANCE_SOURCE,
];
const PRODUCT_PROVENANCE_PATTERNS = PRODUCT_PROVENANCE_SOURCES.map(
  (source) => new RegExp(source, "giu"),
);
const PRODUCT_PROVENANCE_CAUSAL_PATTERNS = PRODUCT_PROVENANCE_SOURCES.flatMap(
  (source) => [
    new RegExp(
      String.raw`\b(?:changes?|code|implementation|commits?|patch)\b.{0,40}(?:\b(?:created|made|produced|generated|authored|written|implemented)\s+)?(?:from|with|using|via|through|based\s+on)\s+${source}`,
      "iu",
    ),
    new RegExp(
      String.raw`${source}.{0,40}\b(?:prompted|caused|drove|motivated|triggered|informed|guided|led\s+to|resulted\s+in)\s+(?:(?:this|the|these)\s+)?(?:changes?|code|implementation|commits?|patch|work)\b`,
      "iu",
    ),
    new RegExp(
      String.raw`\b(?:changes?|code|implementation|commits?|patch|work)\b\s+(?:was|were|is|are|has\s+been|have\s+been)\s+(?:prompted|caused|driven|motivated|triggered|informed|guided)\s+by\s+${source}`,
      "iu",
    ),
  ],
);

function attributionProse(text, allowProductTerms) {
  if (!allowProductTerms) return text;
  return PRODUCT_PROVENANCE_PATTERNS.reduce(
    (prose, pattern) => prose.replace(pattern, "product artifact"),
    text,
  );
}

function hasAttribution(text, allowProductTerms) {
  if (
    allowProductTerms &&
    PRODUCT_PROVENANCE_CAUSAL_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return true;
  }
  const prose = attributionProse(text, allowProductTerms);
  if (
    hasExplicitAiAuthorship(prose, allowProductTerms) ||
    WORKFLOW_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(prose))
  ) {
    return true;
  }
  return (
    !allowProductTerms &&
    PRODUCT_TERM_PATTERNS.some((pattern) => pattern.test(text))
  );
}

export function inspectCommitMessage(subject, body = "") {
  return inspectCommitMessageWithPolicy(subject, body, {
    allowProductTerms: false,
    useDefaultBodyFormat: true,
    useDefaultSubjectFormat: true,
  });
}

function commitSection(body, name) {
  const lines = body.split(/\r?\n/u);
  const heading = `${name}:`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      /^(?:Failure|Change|Rationale|Verification):\s*$/u.test(line.trim()),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

function isVerbatimVerificationCommand(line) {
  const trimmed = line.trim();
  const bullet = trimmed.match(/^[-*]\s+(.+)/u);
  return isCommandShapedVerification(bullet?.[1] ?? trimmed);
}

function hasWorkflowAttribution(text) {
  return (
    hasExplicitAiAuthorship(text) ||
    WORKFLOW_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function startsWithWorkflowAttribution(text) {
  return WORKFLOW_ATTRIBUTION_PATTERNS.some(
    (pattern) => pattern.exec(text)?.index === 0,
  );
}

function hasCommandPathPrefix(text) {
  return /^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/]|\\\\|\.{1,2}\\)/u.test(
    text,
  );
}

function startsWithCommandPath(text) {
  if (hasCommandPathPrefix(text) && /^\S+/u.test(text)) return true;
  const quoted = text.match(/^(?:&\s*)?(["'])(.+?)\1(?:\s|$)/u);
  return Boolean(quoted && hasCommandPathPrefix(quoted[2]));
}

function withoutLeadingEnvironmentAssignments(text) {
  return text.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'[^']*'|\S+)\s+)+/u,
    "",
  );
}

function isCommandShapedVerification(text) {
  const shellPrompt = text.match(/^\$\s+(.+)/u);
  if (shellPrompt) {
    return (
      !startsWithWorkflowAttribution(shellPrompt[1]) &&
      !startsWithExplicitAiAuthorship(shellPrompt[1])
    );
  }
  const markdownCommand = text.match(/^`([^`]+)`$/u);
  if (markdownCommand) {
    return (
      !startsWithWorkflowAttribution(markdownCommand[1].trim()) &&
      !startsWithExplicitAiAuthorship(markdownCommand[1].trim())
    );
  }
  if (
    startsWithWorkflowAttribution(text) ||
    startsWithExplicitAiAuthorship(text)
  ) {
    return false;
  }
  const command = withoutLeadingEnvironmentAssignments(text);
  const hasEnvironment = command !== text;
  const pathCommand = startsWithCommandPath(command);
  const executable = command.match(
    /^([a-z0-9][A-Za-z0-9_.@+/-]*)(?:\s|$)/u,
  )?.[1];
  const powerShellCmdlet =
    /^[A-Z][A-Za-z0-9]*-[A-Z][A-Za-z0-9]*(?:\s|$)/u.test(command);
  if (!pathCommand && !executable && !powerShellCmdlet) return false;
  const commonCommand = /^(?:ava|bash|biome|bun|bundle|cargo|claude|cmake|codex|composer|ctest|deno|dotnet|eslint|gemini|gh|git|go|gradle|jest|make|mix|mocha|mvn|node|npm|npx|opencode|php|pip|pip3|pnpm|powershell|prettier|pytest|python|python3|rake|rebar3|ruby|rustc|sh|swift|tsc|uv|vitest|xcodebuild|yarn|zsh)$/u.test(
    executable ?? "",
  ) || powerShellCmdlet;
  const explicitSyntax =
    hasEnvironment || pathCommand || hasUnambiguousShellSyntax(text);
  if (!commonCommand && !explicitSyntax) return false;
  const attributionLike = hasWorkflowAttribution(text);
  return !attributionLike || explicitSyntax;
}

function hasUnambiguousShellSyntax(text) {
  return (
    /^\$\s+\S/u.test(text) ||
    /^`[^`]+`$/u.test(text) ||
    startsWithCommandPath(text) ||
    /(?:^|\s)(?:--?[A-Za-z0-9]|[A-Za-z_][A-Za-z0-9_]*=)/u.test(text) ||
    /(?:^|\s)(?:&&|\|\||[|;<>])(?:\s|$)/u.test(text) ||
    /\\\s*$/u.test(text)
  );
}

function verificationEvidenceLines(
  body,
  anySection = false,
  allowProductTerms = false,
) {
  const evidence = new Set();
  let section = null;
  let commandContinues = false;
  const lines = body.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const heading = line.trim().match(
      /^(Failure|Change|Rationale|Verification):\s*$/u,
    );
    if (heading) {
      section = heading[1];
      commandContinues = false;
      continue;
    }
    if (!anySection && section !== "Verification") continue;
    if (isVerbatimVerificationCommand(line)) {
      evidence.add(index);
      commandContinues = hasShellContinuationMarker(line);
    } else if (
      commandContinues &&
      /^\s+\S/u.test(line) &&
      isVerbatimVerificationContinuation(line, allowProductTerms)
    ) {
      evidence.add(index);
      commandContinues = hasShellContinuationMarker(line);
    } else {
      commandContinues = false;
    }
  }
  return evidence;
}

function hasShellContinuationMarker(line) {
  const trimmed = line.trimEnd();
  const trailingBackticks = trimmed.match(/`+$/u)?.[0].length ?? 0;
  const trailingBackslashes = trimmed.match(/\\+$/u)?.[0].length ?? 0;
  const trailingCarets = trimmed.match(/\^+$/u)?.[0].length ?? 0;
  const controlOperator = trimmed.match(/(?:&&|\|\||\|)$/u)?.[0];
  const beforeControl = controlOperator
    ? trimmed.slice(0, -controlOperator.length)
    : "";
  const controlEscapes = beforeControl.match(/(?:\\|\^)+$/u)?.[0] ?? "";
  return (
    trailingBackticks % 2 === 1 ||
    trailingBackslashes % 2 === 1 ||
    trailingCarets % 2 === 1 ||
    Boolean(controlOperator && controlEscapes.length % 2 === 0)
  );
}

function isVerbatimVerificationContinuation(line, allowProductTerms = false) {
  const trimmed = line.trim();
  const option = /^--?[A-Za-z0-9][A-Za-z0-9_-]*(?:=|\s|$)/u.test(trimmed);
  return (
    (!hasWorkflowAttribution(trimmed) || (allowProductTerms && option)) &&
    (
      isCommandShapedVerification(trimmed) ||
      /^[A-Za-z][A-Za-z0-9]*-[A-Za-z][A-Za-z0-9]*(?:\s|$)/u.test(trimmed) ||
      option ||
      /^(?:\.{0,2}[\\/])?[A-Za-z0-9_@+.-]+(?:[\\/][A-Za-z0-9_@+.-]+)+(?:\s|$)/u.test(trimmed) ||
      /^[A-Za-z0-9_@+-]+\.[A-Za-z0-9_.-]+(?:\s|$)/u.test(trimmed) ||
      /^(?:["'`]|\$\{)/u.test(trimmed)
    )
  );
}

function commitProseBody(
  body,
  anySection = false,
  allowProductTerms = false,
) {
  const evidence = verificationEvidenceLines(
    body,
    anySection,
    allowProductTerms,
  );
  return body
    .split(/\r?\n/u)
    .filter((_, index) => !evidence.has(index))
    .join("\n");
}

function longCommitProseLine(body, allowProductTerms = false) {
  const evidence = verificationEvidenceLines(body, false, allowProductTerms);
  const lines = body.split(/\r?\n/u);
  return lines.findIndex(
    (line, index) => line.length > 100 && !evidence.has(index),
  );
}

const AI_AUTHORSHIP_ACTION_SOURCE = String.raw`(?:reviewed|generated|suggested|assisted|authored|co[ -]?authored|written|wrote|created|made|produced|build(?:s|ing)?|built|implement(?:s|ed|ing)?|develop(?:s|ed|ing)?|programmed|pair[ -]?programmed|help(?:ed|s|ing)?(?:\s+(?:to\s+)?author)?)`;
const AI_ATTRIBUTION_IDENTITY = new RegExp(
  String.raw`\b${AI_ATTRIBUTION_IDENTITY_SOURCE}\b`,
  "iu",
);
const AI_ATTRIBUTION_TRAILER_IDENTITY = new RegExp(
  String.raw`^(?:(?:automated|generative)\s+)?${AI_ATTRIBUTION_IDENTITY_SOURCE}(?:\s+(?:assistant|agent|bot|reviewer|tool|cli|code|codex|developer|claude|gemini|chatgpt|gpt(?:-\d+(?:\.\d+)*)?|sonnet|opus|haiku|pro|max|mini|nano|flash|ultra|preview|thinking|coder|\d+(?:\.\d+)*|\d+[a-z][a-z0-9.]*)){0,4}$`,
  "iu",
);
const EXPLICIT_AI_AUTHORSHIP_PATTERNS = [
  new RegExp(
    String.raw`\b${AI_AUTHORSHIP_ACTION_SOURCE}\b.{0,50}\b(?:by|with|using|via|from)\s+(?:(?:an?|the)\s+)?${AI_ATTRIBUTION_IDENTITY_SOURCE}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b${AI_ATTRIBUTION_IDENTITY_SOURCE}\b[\s-]+${AI_AUTHORSHIP_ACTION_SOURCE}\b`,
    "iu",
  ),
];
const CHANGE_AUTHORSHIP_OBJECT_SOURCE = String.raw`(?:changes?|code|implementation|commits?|patch|message|work)`;
const PRODUCT_EXCEPTION_AI_AUTHORSHIP_PATTERNS = [
  new RegExp(
    String.raw`\b${CHANGE_AUTHORSHIP_OBJECT_SOURCE}\b.{0,50}\b${AI_AUTHORSHIP_ACTION_SOURCE}\b.{0,50}\b(?:by|with|using|via|from)\s+(?:(?:an?|the)\s+)?${AI_ATTRIBUTION_IDENTITY_SOURCE}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b${AI_ATTRIBUTION_IDENTITY_SOURCE}\b.{0,50}\b${AI_AUTHORSHIP_ACTION_SOURCE}\b.{0,50}\b${CHANGE_AUTHORSHIP_OBJECT_SOURCE}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b${AI_ATTRIBUTION_IDENTITY_SOURCE}\b.{0,50}\b${AI_AUTHORSHIP_ACTION_SOURCE}\b.{0,20}\b(?:this|that|it|these|those)\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:pair[ -]?programmed|co[ -]?authored|authored|help(?:ed|s|ing)?\s+(?:to\s+)?author)\b.{0,50}\b(?:by|with|using|via|from)?\s*(?:(?:an?|the)\s+)?${AI_ATTRIBUTION_IDENTITY_SOURCE}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:built|implemented|developed)\b.{0,50}\b(?:by|with|using|via|from)\s+(?:(?:an?|the)\s+)?${AI_ATTRIBUTION_IDENTITY_SOURCE}\b`,
    "iu",
  ),
];

function hasExplicitAiAuthorship(text, productException = false) {
  const patterns = productException
    ? PRODUCT_EXCEPTION_AI_AUTHORSHIP_PATTERNS
    : EXPLICIT_AI_AUTHORSHIP_PATTERNS;
  return patterns.some((pattern) => pattern.test(text));
}

function startsWithExplicitAiAuthorship(text) {
  return EXPLICIT_AI_AUTHORSHIP_PATTERNS.some(
    (pattern) => pattern.exec(text)?.index === 0,
  );
}

function hasAiAttributionTrailer(message) {
  const trailers = message.matchAll(new RegExp(
    String.raw`^[\t ]*(?:[-*]\s+)?(?:[A-Za-z0-9][A-Za-z0-9-]*-(?:by|with)|${AI_AUTHORSHIP_ACTION_SOURCE})[\t ]*:(?<identity>.*)$`,
    "gimu",
  ));
  return [...trailers].some((trailer) => {
    const displayIdentity = trailer.groups.identity
      .replace(/<[^<>]*>\s*$/u, "")
      .trim();
    const decoratedCandidates = [
      displayIdentity,
      displayIdentity.replace(/\s*\[(?:bot|ai|agent)\]\s*$/iu, "").trim(),
      displayIdentity.replace(/\s*\([^()]{1,64}\)\s*$/u, "").trim(),
    ];
    const candidates = decoratedCandidates.flatMap((identity) => [
      identity,
      identity.replace(/[-_]+/gu, " "),
    ]);
    return candidates.some((identity) =>
      AI_ATTRIBUTION_TRAILER_IDENTITY.test(identity),
    );
  });
}

function inspectCommitMessageWithPolicy(subject, body, options) {
  const issues = [];
  const proseBody = commitProseBody(
    body,
    !options.useDefaultBodyFormat,
    options.allowProductTerms,
  );
  if (!subject.trim()) {
    issues.push("subject is empty");
  }
  if (/[\r\n]/u.test(subject)) {
    issues.push("subject must be a single line");
  }
  if (
    /\b(?:address(?:es|ed|ing)?|appl(?:y|ies|ied|ying)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|handl(?:e|es|ed|ing)|incorporat(?:e|es|ed|ing)|implement(?:s|ed|ing)?|clos(?:e|es|ed|ing)|clear(?:s|ed|ing)?|tackl(?:e|es|ed|ing)|satisf(?:y|ies|ied|ying))\s+(?:the\s+)?(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)\b/iu.test(
      subject,
    ) ||
    /\b(?:review(?:er)?[ -]?round|codex fixes|claude fixes|ai review)\b/iu.test(
      subject,
    )
  ) {
    issues.push("subject describes the review workflow instead of product behavior");
  }
  if (hasAttribution(`${subject}\n${proseBody}`, options.allowProductTerms)) {
    issues.push("message contains reviewer or AI-workflow attribution");
  }
  if (
    /\b(?:to satisfy|in response to|as requested by|based\s+on|because\s+of|prompted\s+by)\s+(?:the\s+)?(?:(?:review|reviewer|feedback|findings?|comments?)|(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance)|(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu.test(
      proseBody,
    ) ||
    /\bfollowing\s+(?:the\s+)?(?:(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+)?(?:feedback|findings?|comments?)|(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?|(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode))\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu.test(
      proseBody,
    ) ||
    /\b(?:(?:review|reviewer|feedback|findings?|comments?)|(?:(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+)?review(?:er)?\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance)|(?:codex|claude|gemini|chatgpt|openai|anthropic|opencode)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\s+(?:asked|requested|required|suggested|said)\b/iu.test(
      proseBody,
    )
  ) {
    issues.push(
      "message narrates or defends the review process instead of the product change",
    );
  }
  if (hasAiAttributionTrailer(`${subject}\n${body}`)) {
    issues.push("message contains an AI attribution trailer");
  }
  if (options.useDefaultSubjectFormat) {
    if (subject.length > 72) {
      issues.push(`subject is ${subject.length} characters; maximum is 72`);
    }
    if (subject.endsWith(".")) {
      issues.push("subject has a trailing period");
    }
    if (
      /^(?:fix(?:es|ed)? issues?|cleanup|updates?|changes?)$/iu.test(
        subject.trim(),
      )
    ) {
      issues.push("subject is vague");
    }
  }
  if (options.useDefaultBodyFormat) {
    if (!body.trim()) {
      issues.push(
        "body is required; use Failure, Change, and Verification sections",
      );
    } else {
      for (const section of DEFAULT_COMMIT_SECTIONS) {
        const content = commitSection(body, section);
        if (content === null) {
          issues.push(`body is missing the ${section}: section`);
        } else if (!content) {
          issues.push(`${section}: section is empty`);
        }
      }
      const verification = commitSection(body, "Verification");
      if (
        verification &&
        verificationEvidenceLines(body, false, options.allowProductTerms)
          .size === 0
      ) {
        issues.push(
          "Verification: section must include an exact command that was run",
        );
      }
    }
    const longLine = longCommitProseLine(body, options.allowProductTerms);
    if (longLine >= 0) {
      issues.push(`body line ${longLine + 1} exceeds 100 characters`);
    }
  }
  return issues;
}

function checkCommitMessageCommand(options) {
  if (options.body && options["body-file"]) {
    throw new CliError("Use only one of --body and --body-file.", 2);
  }
  const subject = options.subject?.trim() ?? "";
  const body = options["body-file"]
    ? readFileSync(
        path.resolve(options.cwd ?? process.cwd(), options["body-file"]),
        "utf8",
      ).trim()
    : options.body?.trim() ?? "";
  const policySource = options["policy"]?.trim();
  const policyOverrides = options["policy-overrides"]?.trim();
  if (policyOverrides && !policySource) {
    throw new CliError(
      "--policy-overrides requires --policy <source>.",
      2,
    );
  }
  const overriddenFields = new Set();
  if (policyOverrides) {
    for (const field of policyOverrides.split(",")) {
      const normalized = field.trim().toLowerCase();
      if (normalized === "all") {
        overriddenFields.add("subject");
        overriddenFields.add("body");
      } else if (["subject", "body"].includes(normalized)) {
        overriddenFields.add(normalized);
      } else {
        throw new CliError(
          "--policy-overrides must be subject, body, all, or a comma-separated combination.",
          2,
        );
      }
    }
  }
  const productTerms = options["product-terms"]?.trim();
  const issues = inspectCommitMessageWithPolicy(subject, body, {
    allowProductTerms: Boolean(productTerms),
    useDefaultBodyFormat: !overriddenFields.has("body"),
    useDefaultSubjectFormat: !overriddenFields.has("subject"),
  });
  return {
    status: issues.length === 0 ? "clean" : "issues",
    subject,
    policy: policySource
      ? {
          mode: "override",
          source: policySource,
          overrides: [...overriddenFields].sort(),
          note:
            "User or repository guidance controls only the named fields; defaults and prospective-only safeguards remain active elsewhere.",
        }
      : {
          mode: "default",
          requiredSections: DEFAULT_COMMIT_SECTIONS,
          optionalSections: ["Rationale"],
        },
    historyPolicy:
      "prospective-only; existing commits are never inspected or rewritten",
    ...(productTerms
      ? {
          productTerms: {
            justification: productTerms,
            note: "Product-domain terms are allowed; workflow narration and AI co-authoring remain prohibited.",
          },
        }
      : {}),
    issues,
  };
}

function archiveRun(repo, state, reason) {
  const finalState = {
    ...state,
    phase: "finished",
    finishReason: reason,
    finishedAt: new Date().toISOString(),
  };
  const destination = path.join(repo.runsDir, state.runId, "final.json");
  writeJsonAtomic(destination, finalState);
  rmSync(repo.activeFile);
  return destination;
}

function finishCommand(repo, options) {
  const reason = options.reason;
  if (!["clean", "out-of-scope", "stopped"].includes(reason)) {
    throw new CliError(
      "--reason must be clean, out-of-scope, or stopped.",
      2,
    );
  }
  const state = loadActive(repo, { allowUnmigrated: reason !== "clean" });
  if (reason === "clean") {
    if (state.lastReview?.status !== "clean") {
      throw new CliError(
        "The latest valid review is not clean. Run another review or finish with an explicit non-clean reason.",
        2,
      );
    }
    const current = snapshot(repo.root, state.base);
    if (current !== state.lastReview.snapshot) {
      throw new CliError(
        "The Git scope changed after the clean review. Review the current snapshot before finishing.",
        2,
      );
    }
  }
  const archive = archiveRun(repo, state, reason);
  return {
    status: "finished",
    reason,
    runId: state.runId,
    rounds: state.round,
    provider: state.provider,
    archive,
  };
}

function doctorCommand(env, cwd = process.cwd()) {
  const requested = path.resolve(cwd);
  const topLevel = git(requested, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  const root =
    topLevel.status === 0 ? path.resolve(topLevel.stdout.trim()) : requested;
  const context = {
    root,
    ...(topLevel.status === 0 ? { storage: repository(root).storage } : {}),
  };
  const codexStatus = codexAvailability(env, context);
  const providers = availableProviders(env, context, codexStatus);
  return {
    status: Object.values(providers).some(Boolean) ? "ready" : "unavailable",
    cwd: root,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    providers,
    providerDiagnostics: {
      codex: codexStatus.reason ?? "ready",
    },
    customProviderVariable: "CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON",
    script: SKILL_SCRIPT,
  };
}

function help() {
  return `codex-review-loop

Usage:
  codex-review-loop doctor [--json]
  codex-review-loop start --outcome <text> [--base <ref>] [--provider <name>]
                          [--max-rounds <1-100>] [--isolate-codex-config]
                          [--json]
  codex-review-loop status [--json]
  codex-review-loop review [--json]
  codex-review-loop check-commit-message --subject <text>
                          [--body <text> | --body-file <path>]
                          [--policy <source>]
                          [--policy-overrides subject,body|all]
                          [--product-terms <justification>] [--json]
  codex-review-loop finish --reason clean|out-of-scope|stopped [--json]

All repository commands accept --cwd <path>. Runtime state is stored below the
target repository's Git directory. check-commit-message only validates a proposed
message; it never inspects or changes Git history. Without an explicit policy
field override, new messages use the default subject rules plus Failure, Change,
and Verification sections. No background process or heartbeat is used.
--product-terms permits legitimate product-domain names without permitting
workflow narration. Codex has no default round cap; other providers default to
15.`;
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.reviewerOutput !== undefined) {
    process.stdout.write(`${result.reviewerOutput}\n`);
    process.stdout.write(
      `\n[review-loop] status=${result.status} round=${result.round}\n`,
    );
    if (result.reason) process.stdout.write(`[review-loop] ${result.reason}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function main(argv, runtime = {}) {
  const env = runtime.env ?? process.env;
  try {
    const { positional, options } = parseArguments(argv);
    const command = positional[0];
    if (options.help || command === "help" || !command) {
      process.stdout.write(`${help()}\n`);
      return 0;
    }
    if (positional.length > 1) {
      throw new CliError(`Unexpected argument: ${positional[1]}`, 2);
    }

    let result;
    if (command === "doctor") {
      result = doctorCommand(env, options.cwd ?? process.cwd());
    } else if (command === "check-commit-message") {
      result = checkCommitMessageCommand(options);
    } else {
      const repo = repository(options.cwd ?? process.cwd());
      switch (command) {
        case "start":
          result = await startCommand(repo, options, env);
          break;
        case "status":
          result = { status: "active", state: reviewSummary(loadActive(repo)) };
          break;
        case "review":
          result = await reviewCommand(repo, env);
          break;
        case "finish":
          result = finishCommand(repo, options);
          break;
        default:
          throw new CliError(`Unknown command: ${command}`, 2);
      }
    }
    printResult(result, options.json);
    if (result.status === "provider_error") return 3;
    if (result.status === "invalid") return 4;
    if (["oscillation", "round_limit"].includes(result.status)) return 5;
    if (result.status === "issues" || result.status === "unavailable") return 2;
    return 0;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    const payload = {
      status: "error",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
    if (argv.includes("--json")) {
      process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stderr.write(`codex-review-loop: ${error.message}\n`);
    }
    return exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SKILL_SCRIPT)) {
  process.exitCode = await main(process.argv.slice(2));
}
