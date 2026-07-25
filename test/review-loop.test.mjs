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
  inspectCommitMessage,
  parseReview,
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

test("parseReview accepts the exact clean sentinel", () => {
  assert.deepEqual(
    parseReview(
      "Review summary: complete scope checked\nNO_IN_SCOPE_FUNCTIONAL_FINDINGS",
    ),
    { status: "clean", findings: [] },
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
    key: "preserve the retry error|src/retry.js",
  });
});

test("parseReview rejects contradictory and unstructured output", () => {
  assert.equal(
    parseReview(`Full review comments:
- [P2] Fix the fallback — app.js:1
${"NO_IN_SCOPE_FUNCTIONAL_FINDINGS"}`).status,
    "invalid",
  );
  assert.equal(parseReview("Looks good to me.").status, "invalid");
});

test("commit-message hygiene rejects workflow narration", () => {
  assert.match(
    inspectCommitMessage("Address Codex review feedback").join("\n"),
    /review workflow|AI-workflow attribution/u,
  );
  assert.deepEqual(
    inspectCommitMessage("Preserve errors across retry exhaustion"),
    [],
  );
});

test("a clean result is bound to the reviewed snapshot", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(
    provider,
    "Review summary: complete scope checked\nNO_IN_SCOPE_FUNCTIONAL_FINDINGS",
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

test("hygiene flags attribution and permits a snapshot-bound product exception", (t) => {
  const { directory, provider } = repositoryFixture(t);
  writeFileSync(
    path.join(directory, "app.js"),
    "// fixed after Codex review\nexport const value = 2;\n",
  );
  const env = reviewEnvironment(
    provider,
    "Review summary: complete scope checked\nNO_IN_SCOPE_FUNCTIONAL_FINDINGS",
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
    "Expose reviewer-provider behavior",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(directory, env, "hygiene");
  assert.equal(result.status, 2);
  const first = JSON.parse(result.stdout);
  assert.equal(first.status, "issues");
  assert.equal(first.attributionCandidates.length, 1);

  result = invoke(
    directory,
    env,
    "hygiene",
    "--justify-product-terms",
    "This fixture models a product that exposes reviewer metadata",
  );
  assert.equal(result.status, 0, result.stderr);
  const justified = JSON.parse(result.stdout);
  assert.equal(justified.attributionWaived, true);

  writeFileSync(
    path.join(directory, "app.js"),
    "// fixed after Codex review\nexport const value = 4;\n",
  );
  result = invoke(directory, env, "hygiene");
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).attributionWaived, false);
});

test("provider round files and active state stay below the Git directory", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(
    provider,
    "Review summary: complete scope checked\nNO_IN_SCOPE_FUNCTIONAL_FINDINGS",
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
