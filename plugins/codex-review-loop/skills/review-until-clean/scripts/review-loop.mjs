#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
const STATE_SCHEMA_VERSION = 2;
const DEFAULT_FALLBACK_MAX_ROUNDS = 15;
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMMIT_SECTIONS = ["Failure", "Change", "Verification"];
const SKILL_SCRIPT = fileURLToPath(import.meta.url);

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

function loadActive(repo) {
  if (!existsSync(repo.activeFile)) {
    throw new CliError("No active review loop. Start one with `start`.", 2);
  }
  const state = readJson(repo.activeFile);
  if (state.schemaVersion === 1) {
    state.schemaVersion = STATE_SCHEMA_VERSION;
    if (state.phase === "clean" || state.lastReview?.status === "clean") {
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
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new CliError(`Unsupported state schema: ${state.schemaVersion}`, 2);
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
    return base;
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
  return base;
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

function availableProviders(env = process.env) {
  return {
    codex: Boolean(executableOnPath("codex", env)),
    gemini: Boolean(executableOnPath("gemini", env)),
    claude: Boolean(executableOnPath("claude", env)),
    opencode: Boolean(executableOnPath("opencode", env)),
    custom: Boolean(env.CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON),
  };
}

function chooseProvider(requested, env = process.env) {
  if (!PROVIDERS.includes(requested)) {
    throw new CliError(
      `Unknown provider ${JSON.stringify(requested)}. Use ${PROVIDERS.join(", ")}.`,
      2,
    );
  }
  const available = availableProviders(env);
  if (requested !== "auto") {
    if (!available[requested]) {
      throw new CliError(
        `Provider ${requested} is not available. Run \`doctor\` for details.`,
        3,
      );
    }
    return requested;
  }
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

export function codexMcpDisableOverride(servers) {
  if (!Array.isArray(servers)) {
    throw new CliError("Codex MCP inventory is not an array.", 3);
  }
  const disabled = {};
  for (const server of servers) {
    if (!server?.enabled) continue;
    if (typeof server.name !== "string" || !server.name) {
      throw new CliError("Codex MCP inventory contains an unnamed server.", 3);
    }
    if (server.transport?.type === "stdio") {
      if (typeof server.transport.command !== "string") {
        throw new CliError(`Codex MCP server ${server.name} has no command.`, 3);
      }
      disabled[server.name] = {
        enabled: false,
        command: "codex-review-loop-disabled-mcp",
      };
    } else if (server.transport?.type === "streamable_http") {
      if (typeof server.transport.url !== "string") {
        throw new CliError(`Codex MCP server ${server.name} has no URL.`, 3);
      }
      disabled[server.name] = {
        enabled: false,
        url: "https://disabled.invalid/mcp",
      };
    } else {
      throw new CliError(
        `Codex MCP server ${server.name} has an unsupported transport.`,
        3,
      );
    }
  }
  return Object.keys(disabled).length > 0
    ? `mcp_servers=${tomlInlineValue(disabled)}`
    : null;
}

function configuredCodexMcpServers(state, env) {
  const result = run("codex", ["mcp", "list", "--json"], {
    cwd: state.root,
    env,
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new CliError(
      "Cannot safely isolate Codex MCP tools: `codex mcp list --json` failed.",
      3,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new CliError(
      `Cannot safely parse the Codex MCP inventory: ${error.message}`,
      3,
    );
  }
}

export function codexMcpServersForReview(state, env) {
  return state.isolateCodexConfig
    ? []
    : configuredCodexMcpServers(state, env);
}

export function codexReviewArgs(isolateUserConfig = false, mcpServers = []) {
  const mcpOverride = codexMcpDisableOverride(mcpServers);
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--disable",
    "hooks",
    "--disable",
    "apps",
    "--disable",
    "multi_agent",
    ...(mcpOverride ? ["-c", mcpOverride] : []),
    "review",
    "--ephemeral",
    ...(isolateUserConfig ? ["--ignore-user-config"] : []),
    "-",
  ];
}

function providerInvocation(state, prompt, env) {
  switch (state.provider) {
    case "codex":
      return {
        command: "codex",
        args: codexReviewArgs(
          Boolean(state.isolateCodexConfig),
          codexMcpServersForReview(state, env),
        ),
        input: prompt,
      };
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

function captureProcess(invocation, options) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    let timedOut = false;
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const append = (kind, chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        child.kill("SIGTERM");
        finish({
          ok: false,
          kind: "output_limit",
          stdout,
          stderr: `${stderr}\nProvider output exceeded ${MAX_CAPTURE_BYTES} bytes.`,
        });
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) =>
      finish({
        ok: false,
        kind: error.code === "ENOENT" ? "unavailable" : "failed",
        stdout,
        stderr: `${stderr}\n${error.message}`,
      }),
    );
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({ ok: false, kind: "timeout", stdout, stderr });
      } else {
        finish({ ok: code === 0, code, signal, stdout, stderr });
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    timer.unref();

    if (invocation.input !== undefined) child.stdin.end(invocation.input);
    else child.stdin.end();
  });
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
    /^no\s+(?:(?:in-scope\s+functional|actionable)\s+)?(?:findings?|defects?|issues?|bugs?)(?:\s+(?:(?:were\s+)?(?:found|identified|detected)|remains?))?[.!]?$/iu,
    /^(?:i\s+)?(?:found|identified|detected)\s+no\s+(?:(?:in-scope\s+functional|actionable)\s+)?(?:findings?|defects?|issues?|bugs?)[.!]?$/iu,
    /^(?:i\s+)?(?:did\s+not|didn't)\s+(?:find|identify|detect)\s+(?:any\s+)?(?:(?:in-scope\s+functional|actionable)\s+)?(?:findings?|defects?|issues?|bugs?)[.!]?$/iu,
  ];
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && patterns.some((pattern) => pattern.test(lines[0]));
}

function containsCodexCleanVerdict(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) =>
      codexExplicitClean(
        line.replace(
          /^(?:review\s+summary|summary|verdict|result):\s*/iu,
          "",
        ),
      ),
    );
}

export function parseReview(output, provider = "custom") {
  const text = output.trim();
  const hasSentinel = text
    .split(/\r?\n/u)
    .some((line) => line.trim() === CLEAN_SENTINEL);
  const heading = /^Full review comments:\s*$/imu.test(text);
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
    codexExplicitClean(text);
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
  const provider = chooseProvider(requestedProvider, env);
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
    isolateCodexConfig: Boolean(options["isolate-codex-config"]),
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
  const invocation = providerInvocation(state, prompt, env);
  const timeoutMs = integerOption(
    env.CODEX_REVIEW_LOOP_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "timeout",
    1_000,
    86_400_000,
  );

  state.round += 1;
  state.phase = "reviewing";
  state.lastReview = {
    status: "running",
    round: state.round,
    snapshot: before,
    startedAt: new Date().toISOString(),
  };
  saveActive(repo, state);

  const result = await captureProcess(invocation, {
    cwd: repo.root,
    env,
    timeoutMs,
  });
  const rawFile = roundFile(repo, state, state.round);
  mkdirSync(path.dirname(rawFile), { recursive: true });
  const rawCapture = `${result.stdout ?? ""}${
    result.stderr ? `\n\n[provider stderr]\n${result.stderr}` : ""
  }`;
  writeFileSync(rawFile, rawCapture, { encoding: "utf8", mode: 0o600 });

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
    };
    saveActive(repo, state);
    return {
      status: "provider_error",
      kind,
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

const PRODUCT_TERM_PATTERNS = [
  /\b(?:codex|claude|gemini|chatgpt|openai|anthropic)\b.{0,50}\b(?:review|reviewer|feedback|findings?|comments?|loop|suggestions?|requests?|recommendations?|instructions?|guidance)\b/iu,
  /\b(?:review|reviewer|feedback|findings?|comments?|loop|suggestions?|requests?|recommendations?|instructions?|guidance)\b.{0,50}\b(?:codex|claude|gemini|chatgpt|openai|anthropic)\b/iu,
  /\b(?:after|during|from|following)\s+(?:(?:the|a)\s+)?(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?(?:review|reviewer)\b/iu,
  /\b(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+(?:found|identified|reported|flagged|raised|caught|suggested|requested|required)\b/iu,
];

const WORKFLOW_ATTRIBUTION_PATTERNS = [
  /\b(?:reviewed|generated|suggested|assisted|authored|written|created|made|produced)\s+(?:by|with)\s+(?:codex|claude|gemini|chatgpt|openai|anthropic)\b/iu,
  /\b(?:codex|claude|gemini|chatgpt|openai|anthropic)[\s-]+(?:reviewed|generated|suggested|assisted|authored|written|created|made|produced)\b/iu,
  /\b(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)\s+(?:from|by)\s+(?:codex|claude|gemini|chatgpt|openai|anthropic)\b/iu,
  /\b(?:found|identified|reported|flagged|raised|caught|suggested|requested|required)\s+(?:by|during|in|from|through)\s+(?:(?:the|a)\s+)?(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?(?:review|reviewer|feedback|findings?|comments?)|(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu,
  /\b(?:per|based\s+on|because\s+of|prompted\s+by|in\s+response\s+to)\s+(?:(?:the|a)\s+)?(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?(?:review|reviewer|feedback|findings?|comments?)|(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu,
  /\bfollowing\s+(?:(?:the|a)\s+)?(?:(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?\s+)?(?:feedback|findings?|comments?)|(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?|(?:codex|claude|gemini|chatgpt|openai|anthropic))\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu,
  /\b(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?\s+(?:asked|requested|required|suggested|said|recommended|instructed|flagged|identified)\b/iu,
  /\b(?:ai|llm)[ -]?(?:generated|assisted|reviewed|suggested)\b/iu,
  /\breview(?:er)?[ -]?round\s*#?\d+\b/iu,
];

function hasAttribution(text, allowProductTerms) {
  if (WORKFLOW_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(text))) {
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

function inspectCommitMessageWithPolicy(subject, body, options) {
  const issues = [];
  if (!subject.trim()) {
    issues.push("subject is empty");
  }
  if (/[\r\n]/u.test(subject)) {
    issues.push("subject must be a single line");
  }
  if (
    /\b(?:address(?:es|ed|ing)?|appl(?:y|ies|ied|ying)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|handl(?:e|es|ed|ing)|incorporat(?:e|es|ed|ing)|implement(?:s|ed|ing)?|clos(?:e|es|ed|ing)|clear(?:s|ed|ing)?|tackl(?:e|es|ed|ing)|satisf(?:y|ies|ied|ying))\s+(?:the\s+)?(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?\s+(?:feedback|findings?|comments?|suggestions?|requests?|recommendations?|instructions?|guidance)\b/iu.test(
      subject,
    ) ||
    /\b(?:review(?:er)?[ -]?round|codex fixes|claude fixes|ai review)\b/iu.test(
      subject,
    )
  ) {
    issues.push("subject describes the review workflow instead of product behavior");
  }
  if (hasAttribution(`${subject}\n${body}`, options.allowProductTerms)) {
    issues.push("message contains reviewer or AI-workflow attribution");
  }
  if (
    /\b(?:to satisfy|in response to|as requested by|per|based\s+on|because\s+of|prompted\s+by)\s+(?:the\s+)?(?:(?:review|reviewer|feedback|findings?|comments?)|(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance)|(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu.test(
      body,
    ) ||
    /\bfollowing\s+(?:the\s+)?(?:(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?\s+)?(?:feedback|findings?|comments?)|(?:(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?|(?:codex|claude|gemini|chatgpt|openai|anthropic))\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\b/iu.test(
      body,
    ) ||
    /\b(?:(?:review|reviewer|feedback|findings?|comments?)|(?:(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+)?review(?:er)?\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance)|(?:codex|claude|gemini|chatgpt|openai|anthropic)\s+(?:suggestions?|requests?|recommendations?|instructions?|guidance))\s+(?:asked|requested|required|suggested|said)\b/iu.test(
      body,
    )
  ) {
    issues.push(
      "message narrates or defends the review process instead of the product change",
    );
  }
  if (
    /^co-authored-by:.*(?:codex|claude|gemini|chatgpt|openai|anthropic|\bai\b)/imu.test(
      body,
    )
  ) {
    issues.push("message contains an AI co-author trailer");
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
    }
    const longLine = body
      .split(/\r?\n/u)
      .findIndex((line) => line.length > 100);
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
  const state = loadActive(repo);
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

function doctorCommand(env) {
  const providers = availableProviders(env);
  return {
    status: Object.values(providers).some(Boolean) ? "ready" : "unavailable",
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    providers,
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
      result = doctorCommand(env);
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
