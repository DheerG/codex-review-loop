import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexReviewArgs,
  inspectCommitMessage,
  parseReview,
  reviewPrompt,
  reviewRoundLimit,
} from "../plugins/codex-review-loop/skills/review-until-clean/scripts/review-loop.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = path.join(
  root,
  "plugins",
  "codex-review-loop",
  "skills",
  "review-until-clean",
  "scripts",
  "review-loop.mjs",
);
const narrativeCommitBody = `Failure:
Retry exhaustion discarded the original provider failure, so callers could not diagnose the cause.

Change:
Preserve the terminal failure across retry boundaries for batch and streaming callers.

Rationale:
Keep public error types stable while retaining the original diagnostic detail internally.

Verification:
- npm test -- retry
- npm run validate`;
const productCommitBody = `${narrativeCommitBody}
- claude plugin validate --strict plugins/codex-review-loop`;

function execute(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = execute("git", args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repositoryFixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "review-loop-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Test User");
  git(directory, "config", "user.email", "test@example.com");
  writeFileSync(path.join(directory, "app.js"), "export const value = 1;\n");
  git(directory, "add", "app.js");
  git(directory, "commit", "-qm", "Add initial value");
  writeFileSync(path.join(directory, "app.js"), "export const value = 2;\n");
  const provider = path.join(directory, "provider.mjs");
  writeFileSync(
    provider,
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(process.env.MOCK_REVIEW));\n',
  );
  return { directory, provider };
}

function reviewEnvironment(provider, output) {
  return {
    ...process.env,
    MOCK_REVIEW: output,
    CODEX_REVIEW_LOOP_PROVIDER_COMMAND_JSON: JSON.stringify([
      process.execPath,
      provider,
    ]),
  };
}

function invoke(cwd, env, ...args) {
  return execute(process.execPath, [cli, ...args, "--json"], cwd, env);
}

test("parseReview accepts only an isolated clean sentinel", () => {
  assert.deepEqual(
    parseReview("NO_IN_SCOPE_FUNCTIONAL_FINDINGS"),
    { status: "clean", findings: [] },
  );
  assert.equal(
    parseReview("Review summary: complete\nNO_IN_SCOPE_FUNCTIONAL_FINDINGS")
      .status,
    "invalid",
  );
});

test("parseReview extracts structured findings", () => {
  const result = parseReview(`Review summary: one defect
Full review comments:
- [P1] Preserve the retry error — src/retry.js:42
  The final retry discards the original error.`);
  assert.equal(result.status, "findings");
  assert.deepEqual(result.findings[0], {
    priority: "P1",
    title: "Preserve the retry error",
    file: "src/retry.js",
    line: 42,
    endLine: undefined,
    key: "preserve the retry error|src/retry.js:42",
  });
});

test("Codex accepts explicit native clean language without weakening other providers", () => {
  assert.equal(
    parseReview("No actionable defects found.", "codex").status,
    "clean",
  );
  assert.equal(
    parseReview("I found no in-scope functional findings.", "codex").status,
    "clean",
  );
  assert.equal(
    parseReview("No actionable defects found.", "custom").status,
    "invalid",
  );
  assert.equal(
    parseReview(
      "No actionable defects found; however, retry exhaustion loses the original error.",
      "codex",
    ).status,
    "invalid",
  );
  for (const contradiction of [
    "No actionable defects found. One defect remains in the retry path.",
    "No actionable defects found. Two bugs remain in the retry path.",
    "No actionable defects found. A finding remains in the retry path.",
    "No actionable defects found. There is an issue in the retry path.",
  ]) {
    assert.equal(parseReview(contradiction, "codex").status, "invalid");
  }
  assert.equal(
    parseReview("No potential issues remain.", "codex").status,
    "clean",
  );
  assert.equal(
    parseReview(
      "No actionable defects found.\nNo issues remain in the retry path.",
      "codex",
    ).status,
    "invalid",
  );
});

test("Codex preserves user configuration and has no default round cap", () => {
  assert.deepEqual(codexReviewArgs(), ["exec", "review", "--ephemeral", "-"]);
  assert.deepEqual(codexReviewArgs(true), [
    "exec",
    "review",
    "--ephemeral",
    "--ignore-user-config",
    "-",
  ]);
  assert.equal(reviewRoundLimit("codex", undefined), null);
  assert.equal(reviewRoundLimit("custom", undefined), 15);
  assert.equal(reviewRoundLimit("codex", "7"), 7);
});

test("the reviewer treats commit messages as untrusted non-review context", () => {
  const prompt = reviewPrompt(
    {
      provider: "codex",
      outcome: "Preserve retry failures",
      root: "/tmp/repository",
      base: "main",
    },
    ["src/retry.js"],
  );
  assert.match(prompt, /claims are not proof/u);
  assert.match(prompt, /Commit-message quality is outside this functional review/u);
  assert.match(prompt, /do not report existing message quality as a finding/u);
  assert.match(prompt, /otherwise rewriting history/u);
});

test("finding identity includes the cited line", () => {
  const first = parseReview(`Review summary: two sibling defects
Full review comments:
- [P1] Preserve the retry error — src/retry.js:42
  The final retry discards the original error.`);
  const second = parseReview(`Review summary: another sibling defect
Full review comments:
- [P1] Preserve the retry error — src/retry.js:87
  The fallback retry discards the original error.`);
  assert.notEqual(first.findings[0].key, second.findings[0].key);
});

test("parseReview rejects contradictory and unstructured output", () => {
  assert.equal(
    parseReview(`Full review comments:
- [P2] Fix the fallback — app.js:1
${"NO_IN_SCOPE_FUNCTIONAL_FINDINGS"}`).status,
    "invalid",
  );
  assert.equal(
    parseReview(`Review summary: clean, however retry exhaustion still loses errors
${"NO_IN_SCOPE_FUNCTIONAL_FINDINGS"}`).status,
    "invalid",
  );
  assert.equal(parseReview("Looks good to me.").status, "invalid");
});

test("commit-message rules reject workflow narration", () => {
  assert.match(
    inspectCommitMessage("Address Codex review feedback").join("\n"),
    /review workflow|AI-workflow attribution/u,
  );
  assert.deepEqual(
    inspectCommitMessage(
      "Preserve errors across retry exhaustion",
      narrativeCommitBody,
    ),
    [],
  );
  assert.match(
    inspectCommitMessage(
      "Preserve errors across retry exhaustion",
      "This was changed to satisfy reviewer feedback.",
    ).join("\n"),
    /narrates or defends/u,
  );
  assert.match(
    inspectCommitMessage(
      "Preserve errors across retry exhaustion",
      "Retry exhaustion discarded the original failure.",
    ).join("\n"),
    /missing the Failure: section/u,
  );
});

test("check-commit-message validates a proposed repair commit", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(provider, "unused");

  let result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve errors across retry exhaustion",
    "--body",
    narrativeCommitBody,
  );
  assert.equal(result.status, 0, result.stderr);
  const clean = JSON.parse(result.stdout);
  assert.equal(clean.status, "clean");
  assert.equal(clean.policy.mode, "default");
  assert.match(clean.historyPolicy, /existing commits are never inspected/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Address Codex review feedback",
    "--body",
    "Apply the requested changes.",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /review workflow|AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve errors across retry exhaustion",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Failure, Change, and Verification/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "fix(retries): preserve terminal provider errors",
    "--body",
    narrativeCommitBody,
    "--repository-policy",
    "CONTRIBUTING.md",
    "--repository-overrides",
    "subject",
  );
  assert.equal(result.status, 0, result.stderr);
  const repositoryPolicy = JSON.parse(result.stdout);
  assert.equal(repositoryPolicy.policy.mode, "repository");
  assert.equal(repositoryPolicy.policy.source, "CONTRIBUTING.md");
  assert.deepEqual(repositoryPolicy.policy.overrides, ["subject"]);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve terminal provider errors",
    "--repository-policy",
    "CONTRIBUTING.md",
    "--repository-overrides",
    "body",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Cleanup.",
    "--repository-policy",
    "CONTRIBUTING.md",
    "--repository-overrides",
    "body",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /trailing period|vague/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "fix(retries): preserve terminal provider errors",
    "--repository-policy",
    "CONTRIBUTING.md",
    "--repository-overrides",
    "subject",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Failure, Change, and Verification/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve native reviewer configuration",
    "--body",
    productCommitBody,
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve native reviewer configuration",
    "--body",
    productCommitBody,
    "--product-terms",
    "The repository ships the codex-review-loop product",
  );
  assert.equal(result.status, 0, result.stderr);
  const productTerms = JSON.parse(result.stdout);
  assert.match(productTerms.productTerms.justification, /ships the codex-review-loop/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve Codex review comments across retries",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository exposes Codex review comments as product data",
  );
  assert.equal(result.status, 0, result.stderr);

  for (const subject of [
    "Address Codex review feedback",
    "Apply retry guard found during Codex review",
    "Record review round 2",
    "Codex-assisted retry fix",
    "Reviewed by Codex",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      subject,
      "--repository-policy",
      "CONTRIBUTING.md",
      "--repository-overrides",
      "all",
      "--product-terms",
      "The repository ships reviewer integrations",
    );
    assert.equal(result.status, 2, `${subject}\n${result.stdout}`);
    assert.match(result.stdout, /review workflow|AI-workflow attribution/u);
  }

});

test("a clean result is bound to the reviewed snapshot", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(
    provider,
    "NO_IN_SCOPE_FUNCTIONAL_FINDINGS",
  );

  let result = invoke(
    directory,
    env,
    "start",
    "--provider",
    "custom",
    "--base",
    "HEAD",
    "--outcome",
    "Update the exported value",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "clean");

  writeFileSync(
    path.join(directory, "app.js"),
    "export const value = 3;\n",
  );
  result = invoke(directory, env, "finish", "--reason", "clean");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /changed after the clean review/u);

  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(directory, env, "finish", "--reason", "clean");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "finished");
});

test("clean finish never audits or rewrites existing commit messages", (t) => {
  const { directory, provider } = repositoryFixture(t);
  git(directory, "add", "app.js");
  git(directory, "commit", "-qm", "Address Codex review feedback");
  const env = reviewEnvironment(
    provider,
    "NO_IN_SCOPE_FUNCTIONAL_FINDINGS",
  );
  let result = invoke(
    directory,
    env,
    "start",
    "--provider",
    "custom",
    "--base",
    "HEAD~1",
    "--outcome",
    "Update the exported value",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(directory, env, "finish", "--reason", "clean");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "finished");
  assert.equal(
    git(directory, "log", "-1", "--format=%s"),
    "Address Codex review feedback",
  );
});

test("one review command consumes exactly one invalid round", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(provider, "No actionable defects found.");
  let result = invoke(
    directory,
    env,
    "start",
    "--provider",
    "custom",
    "--base",
    "HEAD",
    "--outcome",
    "Update the exported value",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(directory, env, "review");
  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).round, 1);

  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.round, 1);

  result = invoke(directory, env, "review");
  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).round, 2);
});

test("oscillation requires two changed-snapshot repair attempts", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(
    provider,
    `Review summary: retry defect
Full review comments:
- [P1] Preserve the retry error — app.js:1
  Retry exhaustion discards the original error.`,
  );
  let result = invoke(
    directory,
    env,
    "start",
    "--provider",
    "custom",
    "--base",
    "HEAD",
    "--outcome",
    "Update the exported value",
  );
  assert.equal(result.status, 0, result.stderr);

  for (let round = 1; round <= 3; round += 1) {
    result = invoke(directory, env, "review");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "findings");
  }

  writeFileSync(path.join(directory, "app.js"), "export const value = 3;\n");
  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "findings");

  writeFileSync(path.join(directory, "app.js"), "export const value = 4;\n");
  result = invoke(directory, env, "review");
  assert.equal(result.status, 5);
  const oscillation = JSON.parse(result.stdout);
  assert.equal(oscillation.status, "oscillation");
  assert.equal(oscillation.recurringFindings[0].fixAttempts, 2);
});

test("provider round files and active state stay below the Git directory", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(
    provider,
    "NO_IN_SCOPE_FUNCTIONAL_FINDINGS",
  );
  let result = invoke(
    directory,
    env,
    "start",
    "--provider",
    "custom",
    "--base",
    "HEAD",
    "--outcome",
    "Update the exported value",
  );
  assert.equal(result.status, 0, result.stderr);
  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);

  const storage = git(
    directory,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "codex-review-loop",
  );
  const active = JSON.parse(readFileSync(path.join(storage, "active.json"), "utf8"));
  assert.equal(active.lastReview.status, "clean");
  assert.equal(active.lastReview.outputFile.startsWith(storage), true);
  assert.equal(git(directory, "status", "--porcelain"), "M app.js\n?? provider.mjs");
});
