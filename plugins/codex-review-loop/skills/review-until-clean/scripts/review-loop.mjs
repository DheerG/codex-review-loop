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
const DEFAULT_MAX_ROUNDS = 20;
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
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
  if (state.schemaVersion !== 1) {
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

function reviewPrompt(state, files) {
  const fileList = files.map((file) => `- ${file}`).join("\n");
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

For findings, return:
Review summary: <brief summary>
Full review comments:
- [P0|P1|P2|P3] <imperative title> — <path>:<line>
  <why this fails and when>

If and only if there are no in-scope functional findings, return:
Review summary: <brief summary>
${CLEAN_SENTINEL}

Do not emit the clean sentinel with any finding.`;
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

function providerInvocation(provider, prompt, env) {
  switch (provider) {
    case "codex":
      return {
        command: "codex",
        args: ["exec", "review", "--ephemeral", "--ignore-user-config", "-"],
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
      throw new CliError(`Unsupported provider: ${provider}`, 3);
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

export function parseReview(output) {
  const text = output.trim();
  const hasClean = text
    .split(/\r?\n/u)
    .some((line) => line.trim() === CLEAN_SENTINEL);
  const heading = /^Full review comments:\s*$/imu.test(text);
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
      key: `${match[2].trim().toLowerCase()}|${match[3].trim().toLowerCase()}`,
    });
  }

  if (hasClean && findings.length === 0 && !heading) {
    return { status: "clean", findings: [] };
  }
  if (!hasClean && heading && findings.length > 0) {
    return { status: "findings", findings };
  }
  return {
    status: "invalid",
    findings,
    reason: hasClean
      ? "The clean sentinel was mixed with finding syntax or a findings heading."
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
    lastReview: state.lastReview,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

function parseArguments(argv) {
  const options = {};
  const positional = [];
  const booleans = new Set(["json", "help"]);
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
    schemaVersion: 1,
    runId: `${now.slice(0, 10)}-${randomUUID()}`,
    phase: "active",
    root: repo.root,
    base,
    outcome,
    requestedProvider,
    provider,
    round: 0,
    maxRounds: integerOption(
      options["max-rounds"],
      DEFAULT_MAX_ROUNDS,
      "max-rounds",
      1,
      100,
    ),
    initialHead: git(repo.root, ["rev-parse", "HEAD"]).stdout.trim(),
    findingCounts: {},
    lastReview: null,
    hygieneJustification: null,
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
  if (state.round >= state.maxRounds) {
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
  const invocation = providerInvocation(state.provider, prompt, env);
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

  const parsed = parseReview(reviewerOutput);
  if (parsed.status === "findings") {
    for (const finding of parsed.findings) {
      state.findingCounts[finding.key] =
        (state.findingCounts[finding.key] ?? 0) + 1;
    }
  }
  const recurring =
    parsed.status === "findings"
      ? parsed.findings.filter(
          (finding) => state.findingCounts[finding.key] >= 3,
        )
      : [];
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

const ATTRIBUTION_PATTERNS = [
  /\b(?:codex|claude|gemini|chatgpt|openai|anthropic)\b.{0,50}\b(?:review|reviewer|feedback|finding|loop|suggest)/iu,
  /\b(?:review|reviewer|feedback|finding|loop|suggest)\b.{0,50}\b(?:codex|claude|gemini|chatgpt|openai|anthropic)\b/iu,
  /\b(?:ai|llm)[ -]?(?:generated|assisted|reviewed|suggested)\b/iu,
  /\breview(?:er)?[ -]?round\s*#?\d+\b/iu,
];

function hasAttribution(text) {
  return ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function inspectCommitMessage(subject, body = "") {
  const issues = [];
  if (subject.length > 72) {
    issues.push(`subject is ${subject.length} characters; maximum is 72`);
  }
  if (subject.endsWith(".")) {
    issues.push("subject has a trailing period");
  }
  if (/^(?:fix(?:es|ed)? issues?|cleanup|updates?|changes?)$/iu.test(subject.trim())) {
    issues.push("subject is vague");
  }
  if (
    /\b(?:address|apply|fix)(?:es|ed|ing)?\s+(?:the\s+)?review(?:er)?\s+(?:feedback|findings?|comments?)\b/iu.test(
      subject,
    ) ||
    /\b(?:review(?:er)?[ -]?round|codex fixes|claude fixes|ai review)\b/iu.test(
      subject,
    )
  ) {
    issues.push("subject describes the review workflow instead of product behavior");
  }
  if (hasAttribution(`${subject}\n${body}`)) {
    issues.push("message contains reviewer or AI-workflow attribution");
  }
  if (
    /^co-authored-by:.*(?:codex|claude|gemini|chatgpt|openai|anthropic|\bai\b)/imu.test(
      body,
    )
  ) {
    issues.push("message contains an AI co-author trailer");
  }
  const longLine = body
    .split(/\r?\n/u)
    .findIndex((line) => line.length > 100);
  if (longLine >= 0) {
    issues.push(`body line ${longLine + 1} exceeds 100 characters`);
  }
  return issues;
}

function addedLinesFromDiff(diff, source) {
  const matches = [];
  let file = source;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (hasAttribution(line.slice(1))) {
        matches.push({ file, line: newLine || null, text: line.slice(1).trim() });
      }
      newLine += 1;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      if (newLine) newLine += 1;
    }
  }
  return matches;
}

function untrackedAttribution(root) {
  const matches = [];
  const files = splitNull(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout,
  );
  for (const file of files) {
    const absolute = path.join(root, file);
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
      const content = readFileSync(absolute, "utf8");
      if (content.includes("\0")) continue;
      content.split(/\r?\n/u).forEach((line, index) => {
        if (hasAttribution(line)) {
          matches.push({ file, line: index + 1, text: line.trim() });
        }
      });
    } catch {
      // Unreadable untracked files are still in the reviewer scope.
    }
  }
  return matches;
}

function commitMessages(root, base) {
  const output = git(root, [
    "log",
    "--format=%H%x00%s%x00%b%x00",
    `${base}..HEAD`,
    "--",
  ]).stdout;
  const fields = output.split("\0");
  const messages = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const hash = fields[index].trim();
    if (!hash) continue;
    messages.push({
      hash,
      subject: fields[index + 1] ?? "",
      body: fields[index + 2] ?? "",
    });
  }
  return messages;
}

function hygieneResult(repo, state) {
  const hardIssues = [];
  const diffChecks = [
    ["diff", "--check", `${state.base}...HEAD`, "--"],
    ["diff", "--cached", "--check", "--"],
    ["diff", "--check", "--"],
  ];
  for (const args of diffChecks) {
    const result = git(repo.root, args, { allowFailure: true });
    if (result.status !== 0) {
      hardIssues.push({
        kind: "whitespace",
        detail: (result.stdout || result.stderr).trim(),
      });
    }
  }

  for (const commit of commitMessages(repo.root, state.base)) {
    for (const detail of inspectCommitMessage(commit.subject, commit.body)) {
      hardIssues.push({
        kind: "commit_message",
        commit: commit.hash,
        subject: commit.subject,
        detail,
      });
    }
  }

  const attribution = [];
  const diffs = [
    git(repo.root, ["diff", "--unified=0", `${state.base}...HEAD`, "--"]).stdout,
    git(repo.root, ["diff", "--cached", "--unified=0", "--"]).stdout,
    git(repo.root, ["diff", "--unified=0", "--"]).stdout,
  ];
  for (const diff of diffs) {
    attribution.push(...addedLinesFromDiff(diff, "diff"));
  }
  attribution.push(...untrackedAttribution(repo.root));

  const deduplicated = [
    ...new Map(
      attribution.map((item) => [
        `${item.file}:${item.line}:${item.text}`,
        { kind: "workflow_attribution", ...item },
      ]),
    ).values(),
  ];
  const currentSnapshot = snapshot(repo.root, state.base);
  const waived =
    deduplicated.length > 0 &&
    state.hygieneJustification?.snapshot === currentSnapshot;
  return {
    ok: hardIssues.length === 0 && (deduplicated.length === 0 || waived),
    snapshot: currentSnapshot,
    hardIssues,
    attributionCandidates: deduplicated,
    attributionWaived: waived,
    justification: waived ? state.hygieneJustification.justification : undefined,
  };
}

function hygieneCommand(repo, options) {
  const state = loadActive(repo);
  let result = hygieneResult(repo, state);
  const justification = options["justify-product-terms"]?.trim();
  if (justification) {
    if (result.attributionCandidates.length === 0) {
      throw new CliError(
        "No product-term attribution candidates need justification.",
        2,
      );
    }
    state.hygieneJustification = {
      justification,
      snapshot: result.snapshot,
      createdAt: new Date().toISOString(),
    };
    saveActive(repo, state);
    result = hygieneResult(repo, state);
  }
  return { status: result.ok ? "clean" : "issues", ...result };
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
    const hygiene = hygieneResult(repo, state);
    if (!hygiene.ok) {
      throw new CliError(
        "Hygiene checks failed. Run `hygiene` for details before finishing.",
        2,
        hygiene,
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
                          [--max-rounds <1-100>] [--json]
  codex-review-loop status [--json]
  codex-review-loop review [--json]
  codex-review-loop hygiene [--justify-product-terms <reason>] [--json]
  codex-review-loop finish --reason clean|out-of-scope|stopped [--json]

All repository commands accept --cwd <path>. Runtime state is stored below the
target repository's Git directory. No background process or heartbeat is used.`;
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
        case "hygiene":
          result = hygieneCommand(repo, options);
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
