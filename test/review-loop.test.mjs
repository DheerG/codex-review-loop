import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  captureProcess,
  codexApprovalHazardsFromToml,
  codexAuthOverridesFromConfigs,
  codexAuthOverridesFromToml,
  codexFeaturesForReview,
  codexManagedHazardsFromToml,
  codexManagedConfigPath,
  codexMcpDisableOverrides,
  codexMcpNamesFromToml,
  codexMcpServersForReview,
  codexPreflightTimeout,
  codexPromptHazardsFromToml,
  codexReviewArgs,
  codexReviewPreferencesFromToml,
  codexReviewPreferencesFromConfigs,
  codexRequirementsHazardsFromToml,
  codexRequirementsPath,
  codexSelectedLegacyProfileFromConfigs,
  codexSelectedLegacyProfileFromToml,
  inspectCommitMessage,
  parseCodexCloudBundleCache,
  parseCodexCloudRequirementsCache,
  parseReview,
  parseCodexFeatureList,
  persistProviderCapture,
  preserveCodexHomeManagedConfigForIsolation,
  readBoundedCodexConfig,
  reviewPrompt,
  reviewRoundLimit,
  shareCodexIdentityForProbe,
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
    parseReview("No issues remain.", "codex").status,
    "clean",
  );
  assert.equal(
    parseReview("No material issues found.", "codex").status,
    "invalid",
  );
  assert.equal(
    parseReview(
      "No actionable defects found.\nNo issues remain in the retry path.",
      "codex",
    ).status,
    "invalid",
  );
  assert.equal(
    parseReview(
      `Review summary: contradictory output
Full review comments:
- [P1] Preserve retry failures — src/retry.js:42
No actionable defects found.`,
      "codex",
    ).status,
    "invalid",
  );
  assert.equal(
    parseReview(
      `Review summary: No actionable defects found.
Full review comments:
- [P1] Preserve retry failures — src/retry.js:42`,
      "codex",
    ).status,
    "invalid",
  );
  for (const formattedVerdict of [
    "**Verdict:** No actionable defects found.",
    "Overall verdict: No actionable defects found.",
    "- **Result:** _No actionable defects found._",
  ]) {
    assert.equal(parseReview(formattedVerdict, "codex").status, "clean");
    assert.equal(
      parseReview(
        `Review summary: contradictory output
Full review comments:
- [P1] Preserve retry failures — src/retry.js:42
${formattedVerdict}`,
        "codex",
      ).status,
      "invalid",
    );
  }
  assert.equal(
    parseReview("~~No actionable defects found.~~", "codex").status,
    "invalid",
  );
  assert.equal(
    parseReview(
      JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No defects found.",
        overall_confidence_score: 0.99,
      }),
      "codex",
    ).status,
    "clean",
  );
  assert.equal(
    parseReview(
      JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No defects found.",
        overall_confidence_score: 0.99,
        notes: "One actionable defect remains.",
      }),
      "codex",
    ).status,
    "invalid",
  );
  const structuredFinding = parseReview(
    JSON.stringify({
      findings: [
        {
          title: "[P1] Preserve retry errors",
          body: "The error is discarded.",
          confidence_score: 0.95,
          priority: 1,
          code_location: {
            absolute_file_path: "/tmp/retry.js",
            line_range: { start: 4, end: 5 },
          },
        },
      ],
      overall_correctness: "patch is incorrect",
      overall_explanation: "The retry path is broken.",
      overall_confidence_score: 0.95,
    }),
    "codex",
  );
  assert.equal(structuredFinding.status, "findings");
  assert.equal(structuredFinding.findings[0].priority, "P1");
  assert.equal(structuredFinding.findings[0].title, "Preserve retry errors");
  for (const priority of [undefined, null]) {
    const finding = {
      title: "[P2] Preserve optional priorities",
      body: "The finding remains actionable.",
      confidence_score: 0.9,
      code_location: {
        absolute_file_path: "/tmp/retry.js",
        line_range: { start: 6, end: 6 },
      },
    };
    if (priority === null) finding.priority = null;
    const parsed = parseReview(
      JSON.stringify({
        findings: [finding],
        overall_correctness: "patch is incorrect",
        overall_explanation: "An actionable defect remains.",
        overall_confidence_score: 0.9,
      }),
      "codex",
    );
    assert.equal(parsed.status, "findings");
    assert.equal(parsed.findings[0].priority, "P2");
  }
  assert.equal(
    parseReview(
      JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "One defect remains in the retry path.",
        overall_confidence_score: 0.99,
      }),
      "codex",
    ).status,
    "invalid",
  );
  assert.equal(
    parseReview(
      JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No defects remain.",
        overall_confidence_score: 0.99,
      }),
      "codex",
    ).status,
    "clean",
  );
  assert.equal(
    parseReview(
      JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation:
          "The changed retry path crashes whenever input is empty.",
        overall_confidence_score: 0.99,
      }),
      "codex",
    ).status,
    "invalid",
  );
  assert.equal(
    parseReview(
      JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No unresolved issues remain.",
        overall_confidence_score: 0.99,
      }),
      "codex",
    ).status,
    "clean",
  );
  assert.equal(
    parseReview(
      JSON.stringify({
        findings: [
          {
            title: 42,
            body: "The retry path is broken.",
            confidence_score: 0.9,
            priority: 1,
            code_location: {
              absolute_file_path: "/tmp/retry.js",
              line_range: { start: 7, end: 7 },
            },
          },
        ],
        overall_correctness: "patch is incorrect",
        overall_explanation: "One defect remains.",
        overall_confidence_score: 0.9,
      }),
      "codex",
    ).status,
    "invalid",
  );
  for (const blankFinding of [
    { title: "", body: "The retry path is broken." },
    { title: "   ", body: "The retry path is broken." },
    { title: "[P1] ", body: "The retry path is broken." },
    { title: "Retry path is broken", body: "" },
    { title: "Retry path is broken", body: "   " },
  ]) {
    assert.equal(
      parseReview(
        JSON.stringify({
          findings: [
            {
              ...blankFinding,
              confidence_score: 0.9,
              priority: 1,
              code_location: {
                absolute_file_path: "/tmp/retry.js",
                line_range: { start: 7, end: 7 },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "One defect remains.",
          overall_confidence_score: 0.9,
        }),
        "codex",
      ).status,
      "invalid",
    );
  }
  assert.equal(
    parseReview(
      "Review comment:\n\n- [P2] Preserve retry errors — /tmp/retry.js:4-5\n  The error is discarded.",
      "codex",
    ).status,
    "findings",
  );
});

test("Codex preserves allowlisted preferences and has no default round cap", () => {
  const configuredArgs = codexReviewArgs(
    false,
    [],
    ["hooks", "multi_agent"],
    {
      root: "/tmp/project",
      preferences: {
        model: "gpt-test",
        review_model: "gpt-review",
        model_reasoning_effort: "high",
      },
    },
  );
  assert.deepEqual(configuredArgs, [
    "--ask-for-approval",
    "never",
    "exec",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'projects={"/tmp/project"={"trust_level"="untrusted"}}',
    "--model",
    "gpt-review",
    "-c",
    'model_reasoning_effort="high"',
    "--disable",
    "hooks",
    "--disable",
    "multi_agent",
    "-c",
    'web_search="disabled"',
    "-c",
    "notify=[]",
    "review",
    "--ephemeral",
    "-",
  ]);
  const isolatedArgs = codexReviewArgs(true, [], [], {
    root: "/tmp/project",
    preferences: { model: "must-not-load" },
    authOverrides: ['cli_auth_credentials_store="keyring"'],
  });
  assert.equal(isolatedArgs.includes("--ignore-user-config"), true);
  assert.equal(isolatedArgs.includes("must-not-load"), false);
  assert.equal(
    isolatedArgs.includes('cli_auth_credentials_store="keyring"'),
    true,
  );
  const explicitProviderArgs = codexReviewArgs(false, [], [], {
    root: "/tmp/project",
    preferences: { model: "gpt-test", model_provider: "openai" },
  });
  assert.equal(explicitProviderArgs.includes('model_provider="openai"'), true);
  const defaultArgs = codexReviewArgs();
  assert.equal(defaultArgs.includes("guardian_approval"), true);
  assert.equal(defaultArgs.includes("guardianv2"), true);
  assert.equal(defaultArgs.includes("codex_hooks"), true);
  assert.equal(defaultArgs.includes("plugin_hooks"), true);
  assert.equal(reviewRoundLimit("codex", undefined), null);
  assert.equal(reviewRoundLimit("custom", undefined), 15);
  assert.equal(reviewRoundLimit("codex", "7"), 7);

  const mcpServers = ["__proto__", "docs server", "local"];
  const mcpOverrides = codexMcpDisableOverrides(mcpServers);
  assert.equal(mcpOverrides.length, 3);
  assert.match(mcpOverrides[0], /^mcp_servers\./u);
  assert.match(mcpOverrides.join("\n"), /"docs server"/u);
  assert.match(mcpOverrides.join("\n"), /"__proto__"/u);
  assert.match(mcpOverrides.join("\n"), /\.enabled=false/u);
  assert.doesNotMatch(
    mcpOverrides.join("\n"),
    /SECRET|sensitive-value|docs\.example\.test|command|url/u,
  );
  const args = codexReviewArgs(false, mcpServers);
  for (const mcpOverride of mcpOverrides) {
    const overrideIndex = args.indexOf(mcpOverride) - 1;
    assert.deepEqual(args.slice(overrideIndex, overrideIndex + 2), [
      "-c",
      mcpOverride,
    ]);
  }
  assert.deepEqual(
    codexMcpServersForReview(
      { isolateCodexConfig: true },
      {},
      () => mcpServers,
    ),
    mcpServers,
  );

  assert.throws(
    () =>
      codexMcpServersForReview({}, {}, () => {
        throw new Error("unreadable managed MCP config");
      }),
    /unreadable managed MCP config/u,
  );
  const oversizedMcpInventory = Array.from(
    { length: 256 },
    (_, index) => `server-${index}-${"x".repeat(80)}`,
  );
  assert.throws(
    () =>
      codexMcpServersForReview(
        { isolateCodexConfig: true },
        {},
        () => oversizedMcpInventory,
      ),
    /too large to disable safely/u,
  );
});

test("Codex MCP discovery reads TOML without probing configured transports", () => {
  const config = `
profile = "legacy"
developer_instructions = """
[mcp_servers.not_a_real_server]
"""

[mcp_servers."docs server"]
url = "https://docs.example.test/mcp"

[profiles.legacy.mcp_servers.'__proto__']
command = "dangerous-server"

[mcp_servers]
local = { command = "node", args = ["server.mjs", "--secret"] }
`;
  assert.deepEqual(codexMcpNamesFromToml(config), ["docs server", "local"]);
  assert.deepEqual(codexMcpNamesFromToml(config, "Codex config", {
    legacyProfiles: true,
  }), [
    "__proto__",
    "docs server",
    "local",
  ]);
  assert.deepEqual(
    codexMcpNamesFromToml(
      'mcp_servers = { "inline server" = { url = "https://example.test" }, local.command = "node" }',
    ),
    ["inline server", "local"],
  );
  assert.deepEqual(
    codexMcpNamesFromToml(`mcp_servers = {
      "multiline server" = { url = "https://example.test" },
      local = { command = "node" },
    }`),
    ["local", "multiline server"],
  );
  assert.throws(
    () => codexMcpNamesFromToml('mcp_servers = "unknown"'),
    /Cannot safely inventory inline mcp_servers/u,
  );
  assert.equal(
    codexManagedConfigPath(
      { ProgramData: "C:\\ProgramData" },
      "win32",
    ),
    "C:\\ProgramData\\OpenAI\\Codex\\managed_config.toml",
  );
  assert.equal(
    codexRequirementsPath(
      { ProgramData: "C:\\ProgramData" },
      "win32",
    ),
    "C:\\ProgramData\\OpenAI\\Codex\\requirements.toml",
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('notify = ["dangerous-command"]'),
    ["notify"],
  );
  assert.deepEqual(codexManagedHazardsFromToml("notify = []"), []);
  assert.deepEqual(codexManagedHazardsFromToml("notify = [\n]"), []);
  assert.deepEqual(
    codexManagedHazardsFromToml('sandbox_mode = "workspace-write"'),
    ["sandbox_mode"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('sandbox_mode = "read-only"'),
    [],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('sandbox_mode = """\nread-only"""'),
    [],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('default_permissions = "read-only"'),
    ["default_permissions"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('default_permissions = ":read-only"'),
    [],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('permission_profile = ":read-only"'),
    [],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('permission_profile = ":workspace-write"'),
    ["permission_profile"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('web_search = "disabled"'),
    [],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml('web_search = "live"'),
    ["web_search"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      'default_permissions = "read-only"\n[permissions.read-only]\nextends = "workspace-write"',
    ),
    ["default_permissions"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      "[features]\nmulti_agent_mode = true",
    ),
    ["features.multi_agent_mode"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      '[permissions.filesystem]\ndeny_read = ["/tmp/repository/private"]',
    ),
    ["permissions.filesystem.deny_read"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      '[permissions.filesystem]\nallow = ["/tmp/repository/public"]',
    ),
    ["permissions.filesystem.allow"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      "[features]\nbrowser_use = true\ncode_mode_host = true\nshell_tool = true",
    ),
    ["features.browser_use", "features.code_mode_host"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      "features.multi_agent_v2 = { enabled = false, max_concurrent_threads_per_session = 2 }",
    ),
    [],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 2",
    ),
    ["features.multi_agent_v2"],
  );
  assert.deepEqual(
    codexApprovalHazardsFromToml(
      'approval_policy = "on-request"\napprovals_reviewer = "auto_review"',
    ),
    ["approval_policy", "approvals_reviewer"],
  );
  assert.deepEqual(
    codexApprovalHazardsFromToml(
      'approval_policy = "never"\napprovals_reviewer = "user"',
    ),
    [],
  );

  const selectedLegacyProfile = codexSelectedLegacyProfileFromToml(
    'profile = "work"',
  );
  assert.deepEqual(
    codexMcpNamesFromToml(
      '[profiles.work.mcp_servers.writer]\ncommand = "writer"',
      "system config",
      { legacyProfiles: true, selectedLegacyProfile },
    ),
    ["writer"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      '[profiles.work]\nnotify = ["dangerous-command"]',
      "managed config",
      { legacyProfiles: true, selectedLegacyProfile },
    ),
    ["notify"],
  );
  assert.deepEqual(
    codexMcpNamesFromToml(
      'profiles = { work = { mcp_servers = { writer = { command = "writer" } } } }',
      "system config",
      { legacyProfiles: true, selectedLegacyProfile },
    ),
    ["writer"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      'profiles = { work = { sandbox_mode = "workspace-write", notify = ["write"] } }',
      "managed config",
      { legacyProfiles: true, selectedLegacyProfile },
    ),
    ["notify", "sandbox_mode"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      'sandbox_mode = "workspace-write"\nnotify = ["write"]\napproval_policy = "on-request"\n[profiles.work]\nsandbox_mode = "read-only"\nnotify = []\napproval_policy = "never"',
      "managed config",
      { legacyProfiles: true, selectedLegacyProfile: "work" },
    ),
    [],
  );
  assert.deepEqual(
    codexReviewPreferencesFromToml(
      'model = "gpt-base"\nreview_model = "gpt-review"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = "ignore"',
    ),
    {
      model: "gpt-base",
      review_model: "gpt-review",
      model_reasoning_effort: "high",
    },
  );
  assert.deepEqual(
    codexReviewPreferencesFromToml(
      'model = "gpt-base"\nmodel_provider = "openai"',
    ),
    { model: "gpt-base", model_provider: "openai" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs([
      {
        contents: 'model = "gpt-system"\nmodel_provider = "private"',
        file: "system config",
      },
      {
        contents: 'model_provider = "openai"',
        file: "user config",
      },
    ]),
    { model: "gpt-system", model_provider: "openai" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs([
      {
        contents: 'model_provider = "private"',
        file: "system config",
      },
      {
        contents: 'model_provider = "openai"',
        file: "user config",
      },
    ]),
    { model_provider: "openai" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromToml(
      'profile = "work"\n[profiles.work]\nmodel = "gpt-profile"\nmodel_reasoning_effort = "xhigh"',
      "legacy user config",
      { legacyProfiles: true },
    ),
    { model: "gpt-profile", model_reasoning_effort: "xhigh" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromToml(
      'profile = "work"\nprofiles = { work = { model = "gpt-profile", review_model = "gpt-review" } }\nmodel = "gpt-base"',
      "legacy user config",
      { legacyProfiles: true },
    ),
    { model: "gpt-profile", review_model: "gpt-review" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromToml(
      '[profiles.work]\nmodel = """\ngpt-profile"""\nmodel_reasoning_effort = "high"',
      "legacy user config",
      {
        legacyProfiles: true,
        selectedLegacyProfile: codexSelectedLegacyProfileFromConfigs([
          { contents: 'profile = "work"', file: "system config" },
        ]),
      },
    ),
    { model: "gpt-profile", model_reasoning_effort: "high" },
  );
  assert.deepEqual(
    codexAuthOverridesFromToml(
      'cli_auth_credentials_store = "keyring"',
    ),
    ['cli_auth_credentials_store="keyring"'],
  );
  assert.deepEqual(
    codexAuthOverridesFromToml('cli_auth_credentials_store = "file"'),
    ['cli_auth_credentials_store="file"'],
  );
  assert.deepEqual(
    codexAuthOverridesFromToml('cli_auth_credentials_store = "auto"'),
    ['cli_auth_credentials_store="auto"'],
  );
  const layeredAuthConfigs = [
    {
      contents:
        '[profiles.work]\ncli_auth_credentials_store = "keyring"',
      file: "system config",
    },
    { contents: 'profile = "work"', file: "user config" },
  ];
  assert.deepEqual(
    codexAuthOverridesFromConfigs(
      layeredAuthConfigs,
      "layered authentication config",
      {
        legacyProfiles: true,
        selectedLegacyProfile:
          codexSelectedLegacyProfileFromConfigs(layeredAuthConfigs),
      },
    ),
    ['cli_auth_credentials_store="keyring"'],
  );
  assert.deepEqual(
    codexAuthOverridesFromConfigs(
      [
        {
          contents:
            'profile = "system"\n[profiles.system]\ncli_auth_credentials_store = "keyring"',
          file: "system config",
          retainedForReview: true,
        },
        {
          contents: 'profile = "user"',
          file: "user config",
          retainedForReview: false,
        },
      ],
      "layered legacy authentication",
      {
        legacyProfiles: true,
        selectedLegacyProfile: "user",
        isolatedLegacyProfile: "system",
      },
    ),
    ['cli_auth_credentials_store="auto"'],
  );
  assert.deepEqual(
    codexAuthOverridesFromConfigs([
      {
        contents: 'cli_auth_credentials_store = "keyring"',
        file: "managed config without user config",
      },
    ]),
    ['cli_auth_credentials_store="keyring"'],
  );
  assert.throws(
    () =>
      codexReviewPreferencesFromToml(
        'model = "acme-review"\nmodel_provider = "acme"',
      ),
    /dependent user configuration.*model_provider/u,
  );
  assert.throws(
    () =>
      codexReviewPreferencesFromToml(
        'model = "private-review"\nmodel_provider = "openai"\n[model_providers.openai]\nbase_url = "https://models.example.test"',
      ),
    /dependent user configuration.*model_providers\.openai/u,
  );
  assert.throws(
    () =>
      codexReviewPreferencesFromToml(
        'review_model = "catalog-review"\nmodel_catalog_json = "/models.json"',
      ),
    /dependent user configuration.*model_catalog_json/u,
  );
  assert.throws(
    () =>
      codexReviewPreferencesFromToml(
        'model = "private-openai-model"\nopenai_base_url = "https://models.example.test/v1"',
      ),
    /dependent user configuration.*openai_base_url/u,
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs([
      {
        contents:
          'model = "private-review"\nmodel_provider = "private"\n[model_providers.private]\nbase_url = "https://models.example.test"',
        file: "system config",
        retainedForReview: true,
      },
      {
        contents: 'personality = "friendly"',
        file: "user config",
        retainedForReview: false,
      },
    ]),
    { model: "private-review" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs([
      {
        contents:
          'model = "managed-openai"\nmodel_provider = "openai"\nopenai_base_url = "https://managed.example.test/v1"',
        file: "managed config",
        retainedForReview: true,
      },
      {
        contents: 'personality = "friendly"',
        file: "user config",
        retainedForReview: false,
      },
    ]),
    { model: "managed-openai", model_provider: "openai" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs([
      {
        contents:
          'model_provider = "openai"\nopenai_base_url = "https://shared.example.test"\nmodel_catalog_json = "/shared/models.json"\n[model_providers.openai]\nbase_url = "https://shared.example.test"',
        file: "system config",
        retainedForReview: true,
      },
      {
        contents:
          'review_model = "shared-review"\nmodel_provider = \'openai\'\nopenai_base_url = \'https://shared.example.test\'\nmodel_catalog_json = \'/shared/models.json\'\n[model_providers.openai]\nbase_url = \'https://shared.example.test\'',
        file: "user config",
        retainedForReview: false,
      },
    ]),
    { review_model: "shared-review", model_provider: "openai" },
  );
  assert.throws(
    () =>
      codexReviewPreferencesFromConfigs(
        [
          {
            contents:
              'profile = "system"\n[profiles.user]\nmodel = "private-review"\nmodel_provider = "private"\n[profiles.user.model_providers.private]\nbase_url = "https://models.example.test"',
            file: "system config",
            retainedForReview: true,
          },
          {
            contents: 'profile = "user"',
            file: "user config",
            retainedForReview: false,
          },
        ],
        "layered legacy preferences",
        {
          legacyProfiles: true,
          selectedLegacyProfile: "user",
          retainedLegacyProfile: "system",
        },
      ),
    /dependent user configuration.*model_providers\.private/u,
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs(
      [
        {
          contents:
            'profile = "user"\n[profiles.user]\nmodel = "private-review"\nmodel_provider = "private"\n[profiles.user.model_providers.private]\nbase_url = "https://models.example.test"',
          file: "system config",
          retainedForReview: true,
        },
      ],
      "layered legacy preferences",
      {
        legacyProfiles: true,
        selectedLegacyProfile: "user",
        retainedLegacyProfile: "user",
      },
    ),
    { model: "private-review" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs(
      [
        {
          contents:
            'profile = "shared"\n[profiles.shared]\nmodel_provider = "private"\n[profiles.shared.model_providers.private]\nbase_url = "https://private.example.test"',
          file: "system config",
          retainedForReview: true,
        },
        {
          contents:
            'profile = "shared"\n[profiles.shared]\nreview_model = "private-review"\nmodel_provider = "private"\n[profiles.shared.model_providers.private]\nbase_url = \'https://private.example.test\'',
          file: "user config",
          retainedForReview: false,
        },
      ],
      "layered same-profile legacy transport",
      {
        legacyProfiles: true,
        selectedLegacyProfile: "shared",
        retainedLegacyProfile: "shared",
      },
    ),
    { review_model: "private-review" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs(
      [
        {
          contents:
            'profile = "system"\nmodel_provider = "openai"\nopenai_base_url = "https://shared.example.test"\nmodel_catalog_json = "/shared/models.json"\n[model_providers.openai]\nbase_url = "https://shared.example.test"',
          file: "system config",
          retainedForReview: true,
        },
        {
          contents:
            'profile = "user"\n[profiles.user]\nmodel = "user-model"',
          file: "user config",
          retainedForReview: false,
        },
      ],
      "layered shared legacy transport",
      {
        legacyProfiles: true,
        selectedLegacyProfile: "user",
        retainedLegacyProfile: "system",
      },
    ),
    { model: "user-model", model_provider: "openai" },
  );
  assert.deepEqual(
    codexReviewPreferencesFromConfigs(
      [
        {
          contents:
            'profile = "system"\n[profiles.system]\nmodel_provider = "private"\n[profiles.system.model_providers.private]\nbase_url = \'https://private.example.test\'\ntest_values = ["alpha", "beta"]',
          file: "system config",
          retainedForReview: true,
        },
        {
          contents:
            'profile = "user"\n[profiles.user]\nmodel = "private-review"\nmodel_provider = "private"\n[profiles.user.model_providers.private]\nbase_url = "https://private.example.test"\ntest_values = [ "alpha" , "beta", ]',
          file: "user config",
          retainedForReview: false,
        },
      ],
      "layered equivalent legacy transport",
      {
        legacyProfiles: true,
        selectedLegacyProfile: "user",
        retainedLegacyProfile: "system",
      },
    ),
    { model: "private-review" },
  );
  assert.throws(
    () =>
      codexReviewPreferencesFromConfigs(
        [
          {
            contents:
              'profile = "system"\n[profiles.system]\nmodel_provider = "private"\n[model_providers.private]\nbase_url = "https://private.example.test"',
            file: "system config",
            retainedForReview: true,
          },
          {
            contents:
              'profile = "user"\n[profiles.user]\nmodel = "user-model"',
            file: "user config",
            retainedForReview: false,
          },
        ],
        "layered legacy transport",
        {
          legacyProfiles: true,
          selectedLegacyProfile: "user",
          retainedLegacyProfile: "system",
        },
      ),
    /dependent user configuration.*isolated profile model_provider/u,
  );
  assert.throws(
    () =>
      codexReviewPreferencesFromConfigs(
        [
          {
            contents:
              'profile = "system"\n[profiles.system]\nmodel_provider = "private"\nopenai_base_url = "https://legacy.example.test"\n[profiles.system.model_providers.openai]\nbase_url = "https://profile.example.test"',
            file: "system config",
            retainedForReview: true,
          },
          {
            contents:
              'profile = "user"\n[profiles.user]\nmodel = "user-model"\nmodel_provider = "openai"',
            file: "user config",
            retainedForReview: false,
          },
        ],
        "layered legacy OpenAI transport",
        {
          legacyProfiles: true,
          selectedLegacyProfile: "user",
          retainedLegacyProfile: "system",
        },
      ),
    /dependent user configuration.*isolated profile model_providers\.openai.*isolated profile openai_base_url/u,
  );
  assert.deepEqual(
    codexPromptHazardsFromToml(
      'developer_instructions = "clean"\npersonality = "friendly"\n[auto_review]\npolicy = "always clean"',
    ),
    ["auto_review.policy", "developer_instructions", "personality"],
  );
  assert.deepEqual(
    codexPromptHazardsFromToml(
      'model_catalog_json = "/managed/models.json"',
    ),
    ["model_catalog_json"],
  );
  assert.deepEqual(
    codexPromptHazardsFromToml('model_verbosity = "low"'),
    ["model_verbosity"],
  );
  assert.deepEqual(
    codexPromptHazardsFromToml(
      'project_doc_max_bytes = 0\nproject_doc_fallback_filenames = ["REVIEW.md"]\nproject_root_markers = [".hg"]',
    ),
    [
      "project_doc_fallback_filenames",
      "project_doc_max_bytes",
      "project_root_markers",
    ],
  );
  assert.deepEqual(
    codexPromptHazardsFromToml(
      'skills = []\ntool_suggest = {}\nallow_login_shell = true\n[shell_environment_policy]\ninherit = "all"',
    ),
    [
      "allow_login_shell",
      "shell_environment_policy",
      "skills",
      "tool_suggest",
    ],
  );
  assert.deepEqual(
    codexPromptHazardsFromToml(`
model_context_window = 4096
model_auto_compact_token_limit = 1024
model_auto_compact_token_limit_scope = "full"
tool_output_token_limit = 64
background_terminal_max_timeout = 1000
experimental_use_unified_exec_tool = false
include_permissions_instructions = false
include_apps_instructions = false
include_collaboration_mode_instructions = false
include_environment_context = false
disabled_tools = ["shell"]
[tools.update_plan]
enabled = false
`),
    [
      "background_terminal_max_timeout",
      "disabled_tools",
      "experimental_use_unified_exec_tool",
      "include_apps_instructions",
      "include_collaboration_mode_instructions",
      "include_environment_context",
      "include_permissions_instructions",
      "model_auto_compact_token_limit",
      "model_auto_compact_token_limit_scope",
      "model_context_window",
      "tool_output_token_limit",
      "tools",
    ],
  );
  assert.deepEqual(
    codexPromptHazardsFromToml(
      '[mcp_servers.readonly]\ndisabled_tools = ["write"]\nenabled_tools = ["read"]',
    ),
    [],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      '[experimental_network]\nallowed_domains = ["example.test"]',
    ),
    ["experimental_network"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(`
allowed_approval_policies = ["on-request", "never"]
allowed_approvals_reviewers = ["user"]
allowed_sandbox_modes = ["read-only"]
default_permissions = ":read-only"
[allowed_permission_profiles]
":read-only" = true
`),
    [],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      'allowed_approval_policies = ["on-request"]',
    ),
    ["allowed_approval_policies"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      'rules = [{ command = "git diff", decision = "forbid" }]',
    ),
    ["rules"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      'allowed_web_search_modes = ["disabled", "cached"]',
    ),
    [],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      'allowed_web_search_modes = ["live"]',
    ),
    ["allowed_web_search_modes"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      'allowed_permission_profiles = { ":workspace" = true }',
    ),
    [
      "allowed_permission_profiles.:read-only",
      "default_permissions",
    ],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      'remote_sandbox_config = [{ hostname_patterns = ["*"], allowed_sandbox_modes = ["workspace-write"] }]',
    ),
    ["remote_sandbox_config"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      "features.browser_use = true\nfeatures.unified_exec = true",
    ),
    ["features.browser_use"],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      "[features]\nbrowser_use = false\nunified_exec = false",
    ),
    [],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      "features = { browser_use = false, unified_exec = false }",
    ),
    [],
  );
  assert.deepEqual(
    codexRequirementsHazardsFromToml(
      "[feature_requirements]\ncodex_hooks = true\nunified_exec = true",
    ),
    ["feature_requirements.codex_hooks"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      '[projects."/tmp/project"]\ntrust_level = "trusted"',
    ),
    ["projects.*.trust_level"],
  );
  assert.deepEqual(
    codexManagedHazardsFromToml(
      "[projects.'/tmp/project']\ntrust_level = '''trusted'''",
    ),
    ["projects.*.trust_level"],
  );
  assert.throws(
    () =>
      codexManagedHazardsFromToml(
        "[projects.'/tmp/project']\ntrust_level = '''",
      ),
    /Cannot safely parse a multiline TOML string/u,
  );
});

test("Codex config scanning remains linear for multiline containers", () => {
  const config = `notify = [\n${Array.from(
    { length: 8_000 },
    () => '  "entry",',
  ).join("\n")}\n]`;
  const startedAt = performance.now();
  assert.deepEqual(codexManagedHazardsFromToml(config), ["notify"]);
  assert.ok(
    performance.now() - startedAt < 1_500,
    "an 8,000-line TOML container should parse in linear time",
  );
});

test("Codex config reads reject oversized and non-regular inputs", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "review-loop-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const regular = path.join(directory, "config.toml");
  writeFileSync(regular, 'model = "gpt-test"\n');
  assert.equal(readBoundedCodexConfig(regular), 'model = "gpt-test"\n');

  const oversized = path.join(directory, "oversized.toml");
  writeFileSync(oversized, "x".repeat(1024 * 1024 + 1));
  assert.throws(
    () => readBoundedCodexConfig(oversized),
    /exceeds 1048576 bytes/u,
  );

  assert.throws(
    () => readBoundedCodexConfig(directory),
    /regular non-symlink file/u,
  );
  if (process.platform !== "win32") {
    const linked = path.join(directory, "linked.toml");
    symlinkSync(regular, linked);
    assert.throws(
      () => readBoundedCodexConfig(linked),
      /regular non-symlink file/u,
    );
  }
});

test("Codex feature probing adapts to supported flags and fails closed", () => {
  assert.equal(codexPreflightTimeout({}), 60_000);
  assert.equal(
    codexPreflightTimeout({ CODEX_REVIEW_LOOP_TIMEOUT_MS: "2500" }),
    2_500,
  );
  assert.throws(
    () => codexPreflightTimeout({ CODEX_REVIEW_LOOP_TIMEOUT_MS: "forever" }),
    /timeout must be an integer/u,
  );

  const cloudBundle = parseCodexCloudBundleCache(
    JSON.stringify({
      signed_payload: {
        bundle: {
          config_toml: {
            enterprise_managed: [
              { name: "managed", contents: "features.hooks = false" },
            ],
          },
          requirements_toml: {
            enterprise_managed: [
              {
                name: "requirements",
                contents: 'default_permissions = ":read-only"',
              },
            ],
          },
        },
      },
    }),
  );
  assert.equal(cloudBundle.managedConfigs[0].contents, "features.hooks = false");
  assert.match(cloudBundle.managedConfigs[0].file, /managed/u);
  assert.match(cloudBundle.requirementsConfigs[0].file, /requirements/u);
  assert.throws(
    () => parseCodexCloudBundleCache('{"signed_payload":{}}'),
    /Cannot parse the Codex cloud configuration cache/u,
  );
  const legacyRequirements = parseCodexCloudRequirementsCache(
    JSON.stringify({
      signed_payload: {
        contents: 'allowed_sandbox_modes = ["read-only"]',
      },
    }),
  );
  assert.equal(
    legacyRequirements[0].contents,
    'allowed_sandbox_modes = ["read-only"]',
  );
  assert.deepEqual(
    parseCodexCloudRequirementsCache(
      JSON.stringify({ signed_payload: { contents: null } }),
    ),
    [],
  );

  const parsed = parseCodexFeatureList(`
hooks                              stable             true
codex_hooks                        stable             true
plugin_hooks                       stable             true
apps                               stable             true
browser_use                        stable             true
code_mode_host                     stable             true
multi_agent                        stable             true
remote_plugin                      stable             true
shell_tool                         stable             true
unified_exec                       stable             true
obsolete_external_tool             removed            true
`);
  assert.equal(parsed.get("hooks"), true);
  assert.equal(parsed.get("codex_hooks"), true);
  assert.equal(parsed.get("plugin_hooks"), true);
  assert.equal(parsed.stages.get("obsolete_external_tool"), "removed");
  assert.equal(parsed.has("multi_agent_v2"), false);

  const calls = [];
  const disabled = codexFeaturesForReview(
    { root: "/tmp/repository", isolateCodexConfig: false },
    {},
    undefined,
    (_root, _env, requested = []) => {
      calls.push(requested);
      return new Map(
        [
          "hooks",
          "codex_hooks",
          "plugin_hooks",
          "apps",
          "browser_use",
          "code_mode_host",
          "multi_agent_mode",
          "collaboration_modes",
          "enable_fanout",
          "remote_plugin",
          "shell_tool",
          "unified_exec",
        ].map((feature) => [
          feature,
          !requested.includes(feature),
        ]),
      );
    },
    () => ({ managedConfigs: [], requirementsConfigs: [] }),
  );
  assert.deepEqual(disabled, [
    "hooks",
    "codex_hooks",
    "plugin_hooks",
    "apps",
    "browser_use",
    "code_mode_host",
    "multi_agent_mode",
    "collaboration_modes",
    "enable_fanout",
    "remote_plugin",
  ]);
  assert.deepEqual(calls, [[], disabled]);
  assert.doesNotMatch(codexReviewArgs(false, [], disabled).join(" "), /multi_agent_v2/u);

  assert.throws(
    () =>
      codexFeaturesForReview(
        { root: "/tmp/repository", isolateCodexConfig: false },
        {},
        undefined,
        (_root, _env, requested = []) =>
          new Map([
            ["hooks", true],
            ["apps", !requested.includes("apps")],
            ["multi_agent", !requested.includes("multi_agent")],
          ]),
        () => ({ managedConfigs: [], requirementsConfigs: [] }),
      ),
    /Cannot safely disable managed Codex features: hooks/u,
  );

  assert.throws(
    () =>
      codexFeaturesForReview(
        {
          root: "/tmp/repository",
          isolateCodexConfig: true,
          codexLegacyProfiles: false,
        },
        {},
        undefined,
        (_root, _env, requested = []) =>
          new Map([
            ["hooks", !requested.includes("hooks")],
            ["shell_tool", true],
          ]),
        () => ({
          managedConfigs: [
            {
              contents: "features.hooks = true",
              file: "cloud-managed Codex config (policy)",
            },
          ],
          requirementsConfigs: [],
        }),
      ),
    /cloud-managed Codex config.*features\.hooks/u,
  );

  assert.throws(
    () =>
      codexFeaturesForReview(
        {
          root: "/tmp/repository",
          isolateCodexConfig: true,
          codexLegacyProfiles: false,
        },
        {},
        undefined,
        (_root, _env, requested = []) =>
          new Map([
            ["hooks", !requested.includes("hooks")],
            ["shell_tool", true],
          ]),
        () => ({
          managedConfigs: [
            {
              contents:
                '[mcp_servers.writer]\ncommand = "writes-to-the-repository"',
              file: "cloud-managed Codex config (transport)",
            },
          ],
          requirementsConfigs: [],
        }),
      ),
    /Cannot safely override MCP servers from cloud-managed Codex config/u,
  );

  assert.throws(
    () =>
      codexFeaturesForReview(
        {
          root: "/tmp/repository",
          isolateCodexConfig: true,
          codexLegacyProfiles: true,
        },
        {},
        undefined,
        (_root, _env, requested = []) =>
          new Map([
            ["hooks", !requested.includes("hooks")],
            ["shell_tool", true],
          ]),
        () => ({
          managedConfigs: [
            {
              contents:
                '[profiles.work.mcp_servers.writer]\ncommand = "writer"',
              file: "cloud-managed Codex config (profile)",
            },
          ],
          requirementsConfigs: [],
        }),
        {
          localConfigInventory: {
            ordinaryConfigs: [
              { contents: 'profile = "work"', file: "system config" },
            ],
            managedConfigs: [],
            requirementsConfigs: [],
          },
          mcpServers: [],
        },
      ),
    /Cannot safely override MCP servers from cloud-managed Codex config/u,
  );

  const mergedProfileMcpServers = ["stale-profile-server"];
  const mergedProfileFeatures = codexFeaturesForReview(
    {
      root: "/tmp/repository",
      isolateCodexConfig: true,
      codexLegacyProfiles: true,
    },
    {},
    undefined,
    (_root, _env, requested = []) =>
      new Map([
        ["hooks", !requested.includes("hooks")],
        ["shell_tool", true],
      ]),
    () => ({
      managedConfigs: [
        {
          contents: 'profile = "work"',
          file: "cloud-managed Codex config (profile selection)",
        },
      ],
      requirementsConfigs: [],
    }),
    {
      localConfigInventory: {
        ordinaryConfigs: [
          {
            contents:
              '[profiles.work.mcp_servers.reader]\ncommand = "reader"',
            file: "system config",
          },
        ],
        managedConfigs: [],
        requirementsConfigs: [],
      },
      mcpServers: mergedProfileMcpServers,
      preferenceContext: {
        userConfig: {
          contents: '[profiles.work]\nmodel = "gpt-profile"',
          file: "user config",
        },
      },
    },
  );
  assert.deepEqual(mergedProfileMcpServers, ["reader"]);
  assert.equal(mergedProfileFeatures.selectedLegacyProfile, "work");
  assert.deepEqual(
    codexReviewPreferencesFromToml(
      '[profiles.work]\nmodel = "gpt-profile"',
      "user config",
      {
        legacyProfiles: true,
        selectedLegacyProfile: mergedProfileFeatures.selectedLegacyProfile,
      },
    ),
    { model: "gpt-profile" },
  );

  const cloudSelectedSafeProfileMcpServers = ["writer"];
  const cloudSelectedSafeProfileFeatures = codexFeaturesForReview(
    {
      root: "/tmp/repository",
      isolateCodexConfig: true,
      codexLegacyProfiles: true,
    },
    {},
    undefined,
    (_root, _env, requested = []) =>
      new Map([
        ["hooks", !requested.includes("hooks")],
        ["shell_tool", true],
      ]),
    () => ({
      managedConfigs: [
        {
          contents: 'profile = "safe"',
          file: "cloud-managed Codex config (safe profile)",
        },
      ],
      requirementsConfigs: [],
    }),
    {
      localConfigInventory: {
        ordinaryConfigs: [
          {
            contents:
              'profile = "danger"\n[profiles.danger]\ndeveloper_instructions = "unsafe"\n[profiles.danger.mcp_servers.writer]\ncommand = "writer"\n[profiles.safe.mcp_servers.reader]\ncommand = "reader"',
            file: "system config",
          },
        ],
        managedConfigs: [],
        requirementsConfigs: [],
      },
      mcpServers: cloudSelectedSafeProfileMcpServers,
    },
  );
  assert.equal(
    cloudSelectedSafeProfileFeatures.selectedLegacyProfile,
    "safe",
  );
  assert.deepEqual(cloudSelectedSafeProfileMcpServers, ["reader"]);

  const oversizedProfileMcpConfig = Array.from(
    { length: 400 },
    (_, index) =>
      `[profiles.work.mcp_servers.server_${index}_${"x".repeat(24)}]\ncommand = "reader"`,
  ).join("\n");
  assert.throws(
    () =>
      codexFeaturesForReview(
        {
          root: "/tmp/repository",
          isolateCodexConfig: true,
          codexLegacyProfiles: true,
        },
        {},
        undefined,
        (_root, _env, requested = []) =>
          new Map([
            ["hooks", !requested.includes("hooks")],
            ["shell_tool", true],
          ]),
        () => ({
          managedConfigs: [
            {
              contents: 'profile = "work"',
              file: "cloud-managed Codex config (profile selection)",
            },
          ],
          requirementsConfigs: [],
        }),
        {
          localConfigInventory: {
            ordinaryConfigs: [
              {
                contents: oversizedProfileMcpConfig,
                file: "system config",
              },
            ],
            managedConfigs: [],
            requirementsConfigs: [],
          },
          mcpServers: [],
        },
      ),
    /MCP inventory is too large to disable safely/u,
  );

  const cloudSelectedPermissionFeatures = codexFeaturesForReview(
    {
      root: "/tmp/repository",
      isolateCodexConfig: true,
      codexLegacyProfiles: true,
    },
    {},
    undefined,
    (_root, _env, requested = []) =>
      new Map([
        ["hooks", !requested.includes("hooks")],
        ["shell_tool", true],
      ]),
    () => ({
      managedConfigs: [
        {
          contents: 'profile = "danger"',
          file: "cloud-managed Codex config (profile selection)",
        },
      ],
      requirementsConfigs: [],
    }),
    {
      localConfigInventory: {
        ordinaryConfigs: [
          {
            contents:
              'profile = "safe"\n[profiles.safe]\ndefault_permissions = ":read-only"\n[profiles.danger]\ndefault_permissions = "workspace-write"',
            file: "system config",
          },
        ],
        managedConfigs: [],
        requirementsConfigs: [],
      },
      mcpServers: [],
    },
  );
  assert.equal(
    cloudSelectedPermissionFeatures.usesReadOnlyDefaultPermissions,
    false,
  );
  assert.equal(
    codexReviewArgs(false, [], cloudSelectedPermissionFeatures, {
      usesReadOnlyDefaultPermissions:
        cloudSelectedPermissionFeatures.usesReadOnlyDefaultPermissions,
    }).includes("--sandbox"),
    true,
  );

  const userIgnoredMcpServers = [];
  const separatedProfileFeatures = codexFeaturesForReview(
    {
      root: "/tmp/repository",
      isolateCodexConfig: false,
      codexLegacyProfiles: true,
    },
    {},
    undefined,
    (_root, _env, requested = []) =>
      new Map([
        ["hooks", !requested.includes("hooks")],
        ["shell_tool", true],
      ]),
    () => ({
      managedConfigs: [
        {
          contents: "notify = []",
          file: "cloud-managed Codex config (policy)",
        },
      ],
      requirementsConfigs: [],
    }),
    {
      localConfigInventory: {
        ordinaryConfigs: [
          {
            contents:
              'profile = "danger"\n[profiles.danger.mcp_servers.writer]\ncommand = "writer"',
            file: "system config",
          },
        ],
        managedConfigs: [],
        requirementsConfigs: [],
      },
      mcpServers: userIgnoredMcpServers,
      preferenceContext: {
        userConfig: {
          contents: 'profile = "safe"',
          file: "user config",
        },
      },
    },
  );
  assert.deepEqual(userIgnoredMcpServers, ["writer"]);
  assert.equal(separatedProfileFeatures.selectedLegacyProfile, "danger");
  assert.equal(
    separatedProfileFeatures.selectedLegacyPreferenceProfile,
    "safe",
  );
  assert.deepEqual(
    codexReviewPreferencesFromToml(
      'profile = "safe"\n[profiles.safe]\nmodel = "gpt-profile"',
      "user config",
      {
        legacyProfiles: true,
        selectedLegacyProfile:
          separatedProfileFeatures.selectedLegacyPreferenceProfile,
      },
    ),
    { model: "gpt-profile" },
  );

  assert.throws(
    () =>
      codexFeaturesForReview(
        {
          root: "/tmp/repository",
          isolateCodexConfig: true,
          codexLegacyProfiles: true,
        },
        {},
        undefined,
        (_root, _env, requested = []) =>
          new Map([
            ["hooks", !requested.includes("hooks")],
            ["shell_tool", true],
          ]),
        () => ({
          managedConfigs: [
            {
              contents:
                'profile = "danger"\n[profiles.danger.mcp_servers.writer]\ncommand = "writer"',
              file: "highest-priority cloud config",
            },
            {
              contents: 'profile = "safe"',
              file: "lower-priority cloud config",
            },
          ],
          requirementsConfigs: [],
        }),
      ),
    /highest-priority cloud config/u,
  );

  const permissionProfileFeatures = codexFeaturesForReview(
    { root: "/tmp/repository", isolateCodexConfig: true },
    {},
    undefined,
    (_root, _env, requested = []) =>
      new Map([
        ["hooks", !requested.includes("hooks")],
        ["shell_tool", true],
      ]),
    () => ({
      managedConfigs: [],
      requirementsConfigs: [
        {
          contents: 'default_permissions = ":read-only"',
          file: "cloud-managed Codex requirements (policy)",
        },
      ],
    }),
  );
  assert.equal(permissionProfileFeatures.usesReadOnlyDefaultPermissions, true);
  const permissionProfileArgs = codexReviewArgs(
    false,
    [],
    permissionProfileFeatures,
    { usesReadOnlyDefaultPermissions: true },
  );
  assert.equal(permissionProfileArgs.includes("--sandbox"), false);
  const activePermissionProfileFeatures = codexFeaturesForReview(
    {
      root: "/tmp/repository",
      isolateCodexConfig: true,
      codexLegacyProfiles: false,
    },
    {},
    undefined,
    (_root, _env, requested = []) =>
      new Map([
        ["hooks", !requested.includes("hooks")],
        ["shell_tool", true],
      ]),
    () => ({
      managedConfigs: [
        {
          contents: 'permission_profile = ":read-only"',
          file: "cloud-managed Codex config (permission profile)",
        },
      ],
      requirementsConfigs: [],
    }),
  );
  assert.equal(
    activePermissionProfileFeatures.usesReadOnlyDefaultPermissions,
    true,
  );
  assert.equal(
    codexReviewArgs(false, [], activePermissionProfileFeatures, {
      usesReadOnlyDefaultPermissions: true,
    }).includes("--sandbox"),
    false,
  );
});

test(
  "Codex synchronous preflight enforces its deadline with an unresponsive child",
  { skip: process.platform === "win32" },
  (t) => {
    const { directory } = repositoryFixture(t);
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    const codex = path.join(bin, "codex");
    const nativeCodex = path.join(directory, "native-codex.mjs");
    writeFileSync(
      nativeCodex,
      'process.on("SIGTERM", () => {});\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n',
    );
    writeFileSync(
      codex,
      `#!${process.execPath}\nconst { spawn } = require("node:child_process");\nconst child = spawn(process.execPath, [${JSON.stringify(nativeCodex)}], { stdio: "inherit" });\nchild.on("exit", (code) => process.exit(code ?? 1));\nprocess.stdin.resume();\n`,
    );
    chmodSync(codex, 0o755);
    const startedAt = Date.now();
    const result = execute(
      process.execPath,
      [cli, "doctor", "--cwd", directory, "--json"],
      root,
      {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEX_REVIEW_LOOP_TIMEOUT_MS: "1000",
      },
    );
    assert.ok([0, 2].includes(result.status), result.stderr);
    assert.equal(Date.now() - startedAt < 5_000, true);
    const report = JSON.parse(result.stdout);
    assert.equal(report.providers.codex, false);
    assert.match(report.providerDiagnostics.codex, /ETIMEDOUT|timed out/iu);
  },
);

test("isolated Codex feature probing skips user config without losing invocation identity", () => {
  const storage = mkdtempSync(path.join(os.tmpdir(), "review-loop-git-state-"));
  const authenticatedHome = path.join(storage, "authenticated-codex-home");
  mkdirSync(authenticatedHome);
  const authoritativeAuth = path.join(authenticatedHome, "auth.json");
  writeFileSync(authoritativeAuth, "original credential", { mode: 0o600 });
  const env = {
    CODEX_HOME: authenticatedHome,
    MANAGED_IDENTITY: "cloud-bundle",
  };
  let probeHome;
  try {
    const sharedIdentityHome = path.join(storage, "shared-identity-home");
    mkdirSync(sharedIdentityHome);
    shareCodexIdentityForProbe(
      {
        root: "/tmp/repository",
        isolateCodexConfig: true,
        codexLegacyProfiles: false,
      },
      env,
      sharedIdentityHome,
    );
    const sharedIdentity = path.join(sharedIdentityHome, "auth.json");
    assert.equal(readFileSync(sharedIdentity, "utf8"), "original credential");
    const sourceDetails = lstatSync(authoritativeAuth);
    const sharedDetails = lstatSync(sharedIdentity);
    assert.equal(
      sourceDetails.dev === sharedDetails.dev &&
        sourceDetails.ino === sharedDetails.ino,
      false,
    );
    writeFileSync(sharedIdentity, "refreshed credential");
    assert.equal(readFileSync(sharedIdentity, "utf8"), "refreshed credential");
    assert.equal(readFileSync(authoritativeAuth, "utf8"), "original credential");
    rmSync(sharedIdentityHome, { recursive: true, force: true });
    assert.equal(readFileSync(authoritativeAuth, "utf8"), "original credential");

    const keyringHome = path.join(storage, "keyring-codex-home");
    const keyringProbeHome = path.join(storage, "keyring-probe-home");
    mkdirSync(keyringHome);
    mkdirSync(keyringProbeHome);
    writeFileSync(
      path.join(keyringHome, "config.toml"),
      'cli_auth_credentials_store = "keyring"',
    );
    writeFileSync(path.join(keyringHome, "auth.json"), "stale credential");
    assert.deepEqual(
      shareCodexIdentityForProbe(
        {
          root: "/tmp/repository",
          isolateCodexConfig: true,
          codexLegacyProfiles: false,
        },
        { ...env, CODEX_HOME: keyringHome },
        keyringProbeHome,
      ),
      ['cli_auth_credentials_store="keyring"'],
    );
    assert.equal(existsSync(path.join(keyringProbeHome, "auth.json")), false);

    const staleHome = path.join(
      storage,
      "codex-feature-inventory-999999999999-abandoned",
    );
    const liveHome = path.join(
      storage,
      `codex-feature-inventory-${process.pid}-active`,
    );
    mkdirSync(staleHome);
    mkdirSync(liveHome);
    writeFileSync(path.join(staleHome, "auth.json"), "stale credential");
    const disabled = codexFeaturesForReview(
      { root: "/tmp/repository", isolateCodexConfig: true },
      env,
      storage,
      (_root, probeEnv, requested = []) => {
        probeHome = probeEnv.CODEX_HOME;
        assert.notEqual(probeEnv, env);
        assert.equal(probeEnv.MANAGED_IDENTITY, env.MANAGED_IDENTITY);
        assert.equal(probeHome.startsWith(storage), true);
        assert.equal(existsSync(probeHome), true);
        return new Map([
          ["codex_hooks", !requested.includes("codex_hooks")],
          ["apps", !requested.includes("apps")],
          ["multi_agent", !requested.includes("multi_agent")],
          ["shell_tool", true],
        ]);
      },
      (_root, probeEnv, temporaryHome, requested) => {
        assert.equal(probeEnv.CODEX_HOME, temporaryHome);
        assert.deepEqual(requested, ["codex_hooks", "apps", "multi_agent"]);
        return { managedConfigs: [], requirementsConfigs: [] };
      },
    );
    assert.deepEqual(disabled, ["codex_hooks", "apps", "multi_agent"]);
    assert.equal(env.CODEX_HOME, authenticatedHome);
    assert.equal(readFileSync(authoritativeAuth, "utf8"), "original credential");
    assert.equal(existsSync(probeHome), false);
    assert.equal(existsSync(staleHome), false);
    assert.equal(existsSync(liveHome), true);

    const signalListeners = {
      SIGHUP: process.listenerCount("SIGHUP"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    let retainedFeatures;
    try {
      retainedFeatures = codexFeaturesForReview(
        { root: "/tmp/repository", isolateCodexConfig: true },
        env,
        storage,
        (_root, _probeEnv, requested = []) =>
          new Map([
            ["codex_hooks", !requested.includes("codex_hooks")],
            ["shell_tool", true],
          ]),
        () => ({ managedConfigs: [], requirementsConfigs: [] }),
        { retainHome: true },
      );
      assert.equal(existsSync(retainedFeatures.codexHome), true);
      assert.equal(
        process.listenerCount("SIGHUP"),
        signalListeners.SIGHUP + 1,
      );
      assert.equal(
        process.listenerCount("SIGINT"),
        signalListeners.SIGINT + 1,
      );
      assert.equal(
        process.listenerCount("SIGTERM"),
        signalListeners.SIGTERM + 1,
      );
    } finally {
      retainedFeatures?.cleanupCodexHome();
    }
    assert.equal(existsSync(retainedFeatures.codexHome), false);
    assert.equal(process.listenerCount("SIGHUP"), signalListeners.SIGHUP);
    assert.equal(process.listenerCount("SIGINT"), signalListeners.SIGINT);
    assert.equal(process.listenerCount("SIGTERM"), signalListeners.SIGTERM);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test("Windows home-managed policy is preserved inside isolated Codex homes", (t) => {
  const storage = mkdtempSync(path.join(os.tmpdir(), "review-loop-managed-"));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const sourceHome = path.join(storage, "source-home");
  const temporaryHome = path.join(storage, "temporary-home");
  mkdirSync(sourceHome);
  mkdirSync(temporaryHome);
  const source = path.join(sourceHome, "managed_config.toml");
  const contents = 'default_permissions = ":read-only"\n';
  writeFileSync(source, contents);

  assert.equal(
    preserveCodexHomeManagedConfigForIsolation(
      { managedConfigs: [{ contents, file: source }] },
      { CODEX_HOME: sourceHome },
      temporaryHome,
      "win32",
    ),
    true,
  );
  assert.equal(
    readFileSync(path.join(temporaryHome, "managed_config.toml"), "utf8"),
    contents,
  );
  assert.equal(
    preserveCodexHomeManagedConfigForIsolation(
      { managedConfigs: [] },
      { CODEX_HOME: sourceHome },
      path.join(storage, "unused-home"),
      "win32",
    ),
    false,
  );
});

test("retained Codex homes are deleted when the host is interrupted", async (t) => {
  const storage = mkdtempSync(path.join(os.tmpdir(), "review-loop-signal-state-"));
  const fixture = path.join(storage, "retain-home.mjs");
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  writeFileSync(
    fixture,
    `import { codexFeaturesForReview } from ${JSON.stringify(pathToFileURL(cli).href)};
const retained = codexFeaturesForReview(
  { root: "/tmp/repository", isolateCodexConfig: true },
  {},
  ${JSON.stringify(storage)},
  (_root, _env, requested = []) => new Map([
    ["codex_hooks", !requested.includes("codex_hooks")],
    ["shell_tool", true],
  ]),
  () => ({ managedConfigs: [], requirementsConfigs: [] }),
  { retainHome: true },
);
process.stdout.write(retained.codexHome + "\\n");
process.stdin.resume();
`,
  );
  const interruptionSignals =
    process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
  for (const requestedSignal of interruptionSignals) {
    const child = spawn(process.execPath, [fixture], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    const temporaryHome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        const line = stdout.match(/^(.+)\r?\n/u)?.[1];
        if (line) resolve(line);
      });
    });
    assert.equal(existsSync(temporaryHome), true);
    const exit = once(child, "exit");
    child.kill(requestedSignal);
    const [code, signal] = await exit;
    assert.equal(code, null);
    assert.equal(signal, requestedSignal);
    assert.equal(existsSync(temporaryHome), false);
  }
});

test("doctor reports Codex availability from the target safety preflight", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const nested = path.join(directory, "nested");
  mkdirSync(nested);
  const result = execute(
    process.execPath,
    [cli, "doctor", "--cwd", nested, "--json"],
    root,
    reviewEnvironment(provider, "unused"),
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cwd, git(directory, "rev-parse", "--show-toplevel"));
  assert.equal(typeof report.providers.codex, "boolean");
  assert.equal(typeof report.providerDiagnostics.codex, "string");
  assert.equal(
    report.providers.codex,
    report.providerDiagnostics.codex === "ready",
  );
});

test("resumed reviews refresh a stale persisted repository root", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const repositoryRoot = git(directory, "rev-parse", "--show-toplevel");
  const env = {
    ...reviewEnvironment(provider, "unused"),
    EXPECTED_REPOSITORY: repositoryRoot,
  };
  let result = invoke(
    directory,
    env,
    "start",
    "--outcome",
    "Preserve review scope after moving a repository",
    "--base",
    "HEAD",
    "--provider",
    "custom",
  );
  assert.equal(result.status, 0, result.stderr);

  const activeFile = path.join(
    directory,
    git(directory, "rev-parse", "--git-path", "codex-review-loop/active.json"),
  );
  const state = JSON.parse(readFileSync(activeFile, "utf8"));
  state.root = path.join(directory, "old-location");
  writeFileSync(activeFile, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    provider,
    `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const expected = \`Repository: \${process.env.EXPECTED_REPOSITORY}\`;
  process.stdout.write(input.includes(expected)
    ? "NO_IN_SCOPE_FUNCTIONAL_FINDINGS"
    : "Review output used the stale repository root.");
});
`,
  );

  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);
  const review = JSON.parse(result.stdout);
  assert.equal(review.status, "clean");
  assert.equal(JSON.parse(readFileSync(activeFile, "utf8")).root, repositoryRoot);
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

test("provider output limits settle without waiting for inherited pipes", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "review-loop-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = path.join(directory, "provider.mjs");
  writeFileSync(
    provider,
    `import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1500)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
process.stdout.write("x".repeat(4096));
setInterval(() => {}, 1000);
`,
  );
  const startedAt = Date.now();
  const result = await captureProcess(
    { command: process.execPath, args: [provider] },
    {
      cwd: directory,
      env: process.env,
      timeoutMs: 5_000,
      maxCaptureBytes: 1_024,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, "output_limit");
  assert.match(result.stderr, /exceeded 1024 bytes/u);
  assert.equal(Date.now() - startedAt < 1_000, true);
  await result.childExited;
});

test("provider state cleanup runs when capture persistence fails", async (t) => {
  const storage = mkdtempSync(path.join(os.tmpdir(), "review-loop-capture-"));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const blocker = path.join(storage, "not-a-directory");
  writeFileSync(blocker, "block child paths");
  let cleanupCalls = 0;

  await assert.rejects(
    persistProviderCapture(
      path.join(blocker, "round.txt"),
      {
        stdout: "provider output",
        stderr: "",
        childExited: Promise.resolve(),
      },
      { cleanup: () => { cleanupCalls += 1; } },
    ),
    /EEXIST|ENOTDIR|not a directory/iu,
  );
  assert.equal(cleanupCalls, 1);
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
  for (const placeholder of ["TODO", "Not run"]) {
    assert.match(
      inspectCommitMessage(
        "Preserve errors across retry exhaustion",
        narrativeCommitBody.replace(
          "- npm test -- retry\n- npm run validate",
          placeholder,
        ),
      ).join("\n"),
      /must include an exact command/u,
    );
  }
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

  for (const unknownHeading of [
    "Notes:",
    "Tests (CI):",
    "2. Notes:",
    "**Notes:**",
    "> Notes:",
    "- **Notes:**",
    "> 2. _Notes:_",
    "> ### Notes",
    "- ### Notes",
    "**### Notes**",
    "Tests\n-----",
    "Tests\n=====",
    "### Notes",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Require verification in its declared section",
      "--body",
      `Failure:\nVerification evidence could be counted outside its declared section.\n\nChange:\nStop evidence collection when another heading begins.\n\nVerification:\nNot run.\n\n${unknownHeading}\n- npm test`,
    );
    assert.equal(result.status, 2, `${unknownHeading}\n${result.stdout}`);
    assert.match(result.stdout, /Verification.*exact command/u);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve exact commands ending in colons",
    "--body",
    narrativeCommitBody.replace(
      "- npm test -- retry\n- npm run validate",
      "- npm run test:",
    ),
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve product-domain test selectors",
    "--body",
    narrativeCommitBody.replace(
      "- npm test -- retry\n- npm run validate",
      '- node --test --test-name-pattern="AI-generated responses retain metadata"',
    ),
    "--product-terms",
    "The command verifies product-domain response metadata",
  );
  assert.equal(result.status, 0, result.stderr);

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
    "--policy",
    "CONTRIBUTING.md",
    "--policy-overrides",
    "subject",
  );
  assert.equal(result.status, 0, result.stderr);
  const effectivePolicy = JSON.parse(result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve continued product test names",
    "--body",
    `${narrativeCommitBody}\n- node --test \\\n  --test-name-pattern="reject per reviewer feedback"`,
    "--product-terms",
    "The command verifies the repository's reviewer-product behavior",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve shell-prefixed product test names",
    "--body",
    narrativeCommitBody.replace(
      "- npm test -- retry\n- npm run validate",
      '- $ node --test --test-name-pattern="reject per reviewer feedback"',
    ),
    "--product-terms",
    "The command verifies the repository's reviewer-product behavior",
  );
  assert.equal(result.status, 0, result.stderr);

  assert.equal(effectivePolicy.policy.mode, "override");
  assert.equal(effectivePolicy.policy.source, "CONTRIBUTING.md");
  assert.deepEqual(effectivePolicy.policy.overrides, ["subject"]);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve repository verification evidence",
    "--body",
    "Tests:\n- codex review --base main",
    "--policy",
    "Repository-specific Tests section",
    "--policy-overrides",
    "body",
  );
  assert.equal(result.status, 0, result.stderr);

  for (const attributionBullet of [
    "- Reviewed by Codex",
    "- Reviewed by Codex with --strict",
    "- Address OpenCode review feedback",
    "- Codex review passed",
    "- Tests suggested by Codex all passed",
    "- codex wrote this code --strict",
    "- $ FOO=bar Reviewed by Codex",
    "- `FOO=bar Reviewed by Codex`",
    "- FOO=bar codex wrote this code --strict",
    "- env FOO=bar Reviewed by Codex",
    "- $ env FOO=bar Reviewed by Codex",
    "- $ npm test -- retry # Reviewed by Codex",
    "- `npm test -- retry # Reviewed by Codex`",
    "- npm test -- retry # Reviewed by Codex",
    "- codex requested this change",
    "- claude suggested this patch",
    '- $ echo "Reviewed by Codex"',
    "- $ echo Addressed Codex review feedback",
    '- `echo "Reviewed by Codex"`',
    "- `npm test`\n  --message=Reviewed by Codex",
    "- npm test \\\n  --message=\"Reviewed by Codex\"",
    '- node --message="Addressed Codex review feedback"',
    "- codex review inspired this implementation --strict",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Preserve exact product test names",
      "--body",
      narrativeCommitBody.replace("- npm test -- retry", attributionBullet),
      "--product-terms",
      "The repository implements reviewer-provider behavior",
    );
    assert.equal(result.status, 2, `${attributionBullet}\n${result.stdout}`);
    assert.match(result.stdout, /AI-workflow attribution/u);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve terminal provider errors",
    "--body",
    narrativeCommitBody.replace(
      "- npm test -- retry",
      "- codex review inspired this implementation --strict",
    ),
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve exact product test names",
    "--body",
    narrativeCommitBody.replace(
      "- npm test -- retry",
      "- npm test\n  Reviewed by Codex",
    ),
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Respond to Claude review feedback",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Keep continued prose visible",
    "--body",
    `${narrativeCommitBody}\n- npm test &&\n  Reviewed by Codex`,
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Keep prose after escaped command markers visible",
    "--body",
    `${narrativeCommitBody}\n${"- npm test " + "\\\\"}\n  Reviewed by Codex`,
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  const longContinuation = `  --test-name-pattern="${"preserve exact provider evidence ".repeat(5).trim()}"`;
  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve multiline verification evidence",
    "--body",
    `${narrativeCommitBody}\n- node --test \\\n${longContinuation}`,
  );
  assert.equal(result.status, 0, result.stderr);

  const longEnvironmentContinuation = `  BAR="${"preserve environment continuation ".repeat(5).trim()}" \\`;
  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve multiline environment evidence",
    "--body",
    `${narrativeCommitBody}\n- FOO=one \\\n${longEnvironmentContinuation}\n  npm test`,
  );
  assert.equal(result.status, 0, result.stderr);

  const longRelativePath = `test/${"review-loop-evidence-".repeat(6)}.test.mjs`;
  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve positional verification evidence",
    "--body",
    `${narrativeCommitBody}\n- node --test \\\n  ${longRelativePath}`,
  );
  assert.equal(result.status, 0, result.stdout);

  const longPowerShellCommand = `  Write-Output "${"exact PowerShell evidence ".repeat(6).trim()}"`;
  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve PowerShell continuation evidence",
    "--body",
    `${narrativeCommitBody}\n- Write-Output "first\`nsecond" \`\n${longPowerShellCommand}`,
  );
  assert.equal(result.status, 0, result.stdout);

  const windowsVerificationCommands = [
    String.raw`C:\tools\runner.exe --test "${"native windows evidence ".repeat(6).trim()}"`,
    String.raw`\\server\share\runner.exe --test "${"unc verification evidence ".repeat(6).trim()}"`,
    String.raw`"C:\Program Files\runner.exe" --test "${"quoted executable evidence ".repeat(6).trim()}"`,
  ];
  for (const command of windowsVerificationCommands) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Preserve native Windows verification evidence",
      "--body",
      `${narrativeCommitBody}\n- ${command}`,
    );
    assert.equal(result.status, 0, `${command}\n${result.stdout}`);
  }

  const environmentCommand = `NODE_OPTIONS="--conditions=test" node --test --test-name-pattern="${"environment-prefixed evidence ".repeat(5).trim()}"`;
  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve environment-prefixed verification evidence",
    "--body",
    `${narrativeCommitBody}\n- ${environmentCommand}`,
  );
  assert.equal(result.status, 0, result.stderr);

  for (const command of [
    String.raw`C:\tools\runner.exe --test ^`,
    "powershell -File verify.ps1 `",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Preserve native Windows command continuations",
      "--body",
      `${narrativeCommitBody}\n- ${command}\n${longContinuation}`,
    );
    assert.equal(result.status, 0, `${command}\n${result.stdout}`);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Keep prose after Markdown command spans visible",
    "--body",
    `${narrativeCommitBody}\n- \`npm test\`\n  Reviewed by Codex`,
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve exact product test names",
    "--body",
    `${narrativeCommitBody}\n- node --test --test-name-pattern="reject per reviewer feedback"`,
    "--product-terms",
    "The command verifies the repository's reviewer-product behavior",
  );
  assert.equal(result.status, 0, result.stderr);

  const productFrequencyBody = narrativeCommitBody.replace(
    "Preserve the terminal failure across retry boundaries for batch and streaming callers.",
    "Invoke exactly one provider call per review for batch and streaming callers.",
  );
  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Limit provider calls by review",
    "--body",
    productFrequencyBody,
    "--product-terms",
    "The repository implements review-provider behavior",
  );
  assert.equal(result.status, 0, result.stderr);

  const longVerificationCommand = `uv run pytest --expression "${"provider scope ".repeat(8).trim()}"`;
  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve exact verification evidence",
    "--body",
    `${narrativeCommitBody}\n- ${longVerificationCommand}`,
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve concise change explanations",
    "--body",
    narrativeCommitBody.replace(
      "Preserve the terminal failure across retry boundaries for batch and streaming callers.",
      "A prose explanation remains subject to the normal line-length guard because it can be wrapped without changing exact evidence. ".repeat(2),
    ),
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /exceeds 100 characters/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve terminal provider errors",
    "--policy",
    "User instruction: omit commit bodies",
    "--policy-overrides",
    "body",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Run one provider call per review",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository implements review-provider behavior",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve retry errors per Codex review feedback",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository implements review-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  for (const attribution of [
    "The defect was identified by an AI reviewer.",
    "Applied reviewer feedback.",
    "Reviewer feedback was incorporated.",
    "Changes generated with AI.",
    "Changes authored by the reviewer.",
    "AI co-authored the change.",
    "Claude co-authored the change.",
    "Codex wrote this code.",
    "Codex wrote this.",
    "Claude developed this.",
    "Pair programmed with Claude.",
    "AI helped author these changes.",
    "AI wrote the parser.",
    "The parser was written by AI.",
    "The parser was created using AI.",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Preserve terminal provider errors",
      "--body",
      narrativeCommitBody.replace(
        "Preserve the terminal failure across retry boundaries for batch and streaming callers.",
        attribution,
      ),
      "--product-terms",
      "The repository implements review-provider behavior",
    );
    assert.equal(result.status, 2, `${attribution}\n${result.stdout}`);
    assert.match(result.stdout, /AI-workflow attribution/u);
  }

  for (const attribution of [
    "Changes generated using AI",
    "Changes produced by artificial intelligence",
    "Changes authored with GitHub Copilot",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Describe artifact provenance",
      "--body",
      attribution,
      "--policy",
      "Repository-specific commit format",
      "--policy-overrides",
      "all",
      "--product-terms",
      "The repository implements reviewer-provider behavior",
    );
    assert.equal(result.status, 2, `${attribution}\n${result.stdout}`);
    assert.match(result.stdout, /AI-workflow attribution/u);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Route retries through provider responses",
    "--body",
    "Created retry routing using OpenAI responses.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements an OpenAI response provider",
  );
  assert.equal(result.status, 0, result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Describe implementation provenance",
    "--body",
    "Codex review inspired this implementation.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve folded contributor certification",
    "--body",
    `${narrativeCommitBody}\n\nSigned-off-by:\n Claude Shannon <claude@example.com>`,
  );
  assert.equal(result.status, 0, result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve generated provider responses",
    "--body",
    "AI-generated responses retain their metadata.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository records AI-generated responses as product data",
  );
  assert.equal(result.status, 0, result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve passive finding provenance",
    "--body",
    "Findings generated by the reviewer retain metadata.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 0, result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Describe implementation provenance",
    "--body",
    "Implementation based on Codex-generated feedback preserves errors.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Built with Codex",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  for (const disguisedAttribution of [
    "- $ Reviewed by Codex",
    "- `Address reviewer feedback`",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Preserve terminal provider errors",
      "--body",
      `${narrativeCommitBody}\n${disguisedAttribution}`,
      "--product-terms",
      "The repository implements reviewer-provider behavior",
    );
    assert.equal(
      result.status,
      2,
      `${disguisedAttribution}\n${result.stdout}`,
    );
    assert.match(result.stdout, /AI-workflow attribution/u);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve contributor certification",
    "--body",
    `${narrativeCommitBody}\n\nSigned-off-by: Claude Shannon <claude@example.com>`,
  );
  assert.equal(result.status, 0, result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Describe implementation provenance",
    "--body",
    "Changes created using OpenAI responses.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements an OpenAI response provider",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve finding metadata",
    "--body",
    "Reviewer-generated findings retain metadata.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 0, result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve finding metadata",
    "--body",
    "Changes created from AI-generated review feedback.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Describe commit metadata",
    "--body",
    "Reviewer-generated commits retain metadata.",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  for (const productSubject of [
    "Implement request validation",
    "Fix feedback submission",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      productSubject,
      "--body",
      narrativeCommitBody,
      "--policy",
      "Repository product language",
      "--policy-overrides",
      "all",
    );
    assert.equal(result.status, 0, `${productSubject}\n${result.stdout}`);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve terminal provider errors",
    "--body",
    `${narrativeCommitBody}\n\nReviewed-by: AI reviewer`,
    "--product-terms",
    "The repository implements review-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI attribution trailer/u);

  for (const trailer of [
    "Signed-off-by: Codex",
    "Tested-by: OpenCode",
    "Pair-programmed-with: Claude",
    "Co-authored-by: GPT-5",
    "Co-authored-by : Codex",
    "Co-authored-by\t:\tClaude",
    "Reviewed-by: reviewer",
    "  Co-authored-by: Codex",
    "Co-authored-by: GitHub Copilot <copilot@github.com>",
    "Generated-by: automated AI agent <automation@example.test>",
    "Co-authored: Codex",
    "Reviewed: Codex",
    "Generated: Claude",
    "Co-authored-by: Claude Code Agent",
    "Co-authored-by: Anthropic Claude Code",
    "Co-authored-by: Amazon Q Developer",
    "Co-authored-by: Claude Sonnet <bot@example.com>",
    "Co-authored-by: Claude 3.5 Sonnet <bot@example.com>",
    "Co-authored-by: github-copilot[bot] <bot@example.com>",
    "Co-authored-by: Codex (OpenAI) <bot@example.com>",
    "Co-authored-by: claude-code[bot] <bot@example.com>",
    "Co-authored-by: ChatGPT-4o <bot@example.com>",
    "Reviewed-by: Codex Team <team@example.com>",
    "Signed-off-by: OpenAI Maintainers <maintainers@example.com>",
    "Co-authored-by:\n Codex",
    "Reviewed-by:\n Codex Team <team@example.com>",
    "Helped-by: Claude AI",
    "Co-authored-by: AI Pair Programmer <bot@example.com>",
    "Co-authored-by: AI Coding Assistant <bot@example.com>",
    "Co-authored-by: ai Pair Programmer <bot@example.com>",
    "Co-authored-by: llm Pair Programmer <bot@example.com>",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      "Preserve terminal provider errors",
      "--body",
      `${narrativeCommitBody}\n\n${trailer}`,
      "--product-terms",
      "The repository implements reviewer-provider behavior",
    );
    assert.equal(result.status, 2, `${trailer}\n${result.stdout}`);
    assert.match(result.stdout, /AI attribution trailer/u);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve contributor certification",
    "--body",
    `${narrativeCommitBody}\n\nSigned-off-by: Alice <alice@openai.com>`,
  );
  assert.equal(result.status, 0, result.stdout);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Co-authored-by: Codex",
    "--policy",
    "Repository-specific commit format",
    "--policy-overrides",
    "all",
    "--product-terms",
    "The repository implements reviewer-provider behavior",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI attribution trailer/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Cleanup.",
    "--policy",
    "CONTRIBUTING.md",
    "--policy-overrides",
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
    "--policy",
    "CONTRIBUTING.md",
    "--policy-overrides",
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
  assert.equal(result.status, 0, result.stderr);

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
    "Address OpenCode review feedback",
    "Apply retry guard found during Codex review",
    "Resolve review feedback",
    "Resolved reviewer comments",
    "Incorporating review findings",
    "Apply reviewer suggestions",
    "Handle review requests",
    "Implement reviewer recommendations",
    "Reviewer requested retry preservation",
    "Codex review requested retry preservation",
    "Incorporate feedback from Codex",
    "Apply suggestions from Claude",
    "Preserve code authored by Codex",
    "Record changes made by Codex",
    "Record review round 2",
    "Codex-assisted retry fix",
    "Reviewed by Codex",
    "Reviewer feedback prompted this change",
    "Codex-generated feedback prompted this change",
    "AI-generated findings informed these changes",
    "Implemented according to Codex feedback",
    "Changes follow Codex feedback",
    "Changes were prompted by Codex-generated feedback",
    "Review feedback led to this change",
    "Address GitHub Copilot review feedback",
    "Apply Aider suggestions",
    "Address Aider's feedback",
    "Resolve the AI reviewer's findings",
    "Honor reviewer feedback",
    "Follow reviewer feedback",
    "Address the comments in review",
  ]) {
    result = invoke(
      directory,
      env,
      "check-commit-message",
      "--subject",
      subject,
      "--policy",
      "CONTRIBUTING.md",
      "--policy-overrides",
      "all",
      "--product-terms",
      "The repository ships reviewer integrations",
    );
    assert.equal(result.status, 2, `${subject}\n${result.stdout}`);
    assert.match(result.stdout, /review workflow|AI-workflow attribution/u);
  }

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve retries\n\nCo-authored-by: Codex",
    "--policy",
    "User instruction: omit commit bodies",
    "--policy-overrides",
    "body",
    "--product-terms",
    "The repository ships reviewer integrations",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /single line/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve weak-tag semantics",
    "--body",
    `${narrativeCommitBody}\n\nRationale:\nFollowing guidance in RFC 9110, preserve weak-tag semantics.`,
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve retries based on Codex review feedback",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository ships reviewer integrations",
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve configuration during Codex review",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository runs Codex review as product behavior",
  );
  assert.equal(result.status, 0, result.stderr);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve tool calls Codex requested",
    "--body",
    narrativeCommitBody,
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AI-workflow attribution/u);

  result = invoke(
    directory,
    env,
    "check-commit-message",
    "--subject",
    "Preserve tool calls Codex requested",
    "--body",
    narrativeCommitBody,
    "--product-terms",
    "The repository stores provider tool calls as product data",
  );
  assert.equal(result.status, 0, result.stderr);

});

test("start pins a moving base before later commits", (t) => {
  const { directory, provider } = repositoryFixture(t);
  writeFileSync(
    provider,
    `let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(input.includes("- app.js\\n") ? process.env.MOCK_REVIEW : "missing app.js");
});\n`,
  );
  const env = reviewEnvironment(provider, "NO_IN_SCOPE_FUNCTIONAL_FINDINGS");
  const originalHead = git(directory, "rev-parse", "HEAD");
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
  assert.equal(JSON.parse(result.stdout).state.base, originalHead);

  const storage = git(
    directory,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "codex-review-loop",
  );
  const activeFile = path.join(storage, "active.json");
  const legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "HEAD";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);

  git(directory, "add", "app.js");
  git(directory, "commit", "-qm", "Update exported value");
  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.base, originalHead);
  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "clean");
});

test("stopped finish archives an unmigratable legacy run", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(provider, "unused");
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

  const storage = git(
    directory,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "codex-review-loop",
  );
  const activeFile = path.join(storage, "active.json");
  const legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "refs/heads/deleted-before-migration";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);

  result = invoke(directory, env, "status");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not resolve|recover the original commit/u);

  result = invoke(directory, env, "finish", "--reason", "stopped");
  assert.equal(result.status, 0, result.stderr);
  const finished = JSON.parse(result.stdout);
  const archived = JSON.parse(readFileSync(finished.archive, "utf8"));
  assert.equal(finished.status, "finished");
  assert.match(archived.migrationError, /does not resolve|recover/u);
  assert.equal(existsSync(activeFile), false);
});

test("legacy base migration preserves immutable revisions and rejects ambiguous reflogs", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(provider, "unused");
  git(directory, "add", "app.js");
  git(directory, "commit", "-qm", "Update exported value");
  writeFileSync(path.join(directory, "app.js"), "export const value = 3;\n");
  const originalHead = git(directory, "rev-parse", "HEAD");
  const originalParent = git(directory, "rev-parse", "HEAD~1");
  const originalBranch = git(directory, "symbolic-ref", "--short", "HEAD");
  git(directory, "tag", "-a", "legacy-tag", "-m", "Legacy tag", "HEAD~1");
  const tagObject = git(directory, "rev-parse", "legacy-tag");
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

  const storage = git(
    directory,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "codex-review-loop",
  );
  const activeFile = path.join(storage, "active.json");
  let legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = originalHead.slice(0, 12);
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);

  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.base, originalHead);

  legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "HEAD~1";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  writeFileSync(path.join(directory, "app.js"), "export const value = 2;\n");
  git(directory, "checkout", "-q", "--detach", originalParent);
  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.base, originalParent);

  legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "HEAD^{commit}";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.base, originalHead);
  git(directory, "checkout", "-q", originalBranch);

  let update = execute(
    "git",
    [
      "update-ref",
      "--create-reflog",
      "-m",
      "create relative legacy base",
      "refs/heads/relative-base",
      originalHead,
    ],
    directory,
    { ...process.env, GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
  );
  assert.equal(update.status, 0, update.stderr);
  writeFileSync(path.join(directory, "app.js"), "export const value = 4;\n");
  git(directory, "add", "app.js");
  git(directory, "commit", "-qm", "Add later relative value");
  const laterHead = git(directory, "rev-parse", "HEAD");
  update = execute(
    "git",
    [
      "update-ref",
      "-m",
      "move relative legacy base",
      "refs/heads/relative-base",
      laterHead,
    ],
    directory,
    { ...process.env, GIT_COMMITTER_DATE: "2040-01-01T00:00:00Z" },
  );
  assert.equal(update.status, 0, update.stderr);

  legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "relative-base~1";
  legacy.startedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.base, originalParent);

  update = execute(
    "git",
    [
      "update-ref",
      "-m",
      "shorten relative legacy base",
      "refs/heads/relative-base",
      originalParent,
    ],
    directory,
    { ...process.env, GIT_COMMITTER_DATE: "2050-01-01T00:00:00Z" },
  );
  assert.equal(update.status, 0, update.stderr);
  const unresolvedRelative = execute(
    "git",
    ["rev-parse", "--verify", "--quiet", "relative-base~1^{commit}"],
    directory,
  );
  assert.notEqual(unresolvedRelative.status, 0);
  legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "relative-base~1";
  legacy.startedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.base, originalParent);

  legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "stable-base";
  legacy.startedAt = "2000-01-01T00:00:00.000Z";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  git(directory, "branch", "stable-base", originalParent);
  writeFileSync(path.join(directory, "app.js"), "export const value = 4;\n");
  git(directory, "checkout", "-q", "stable-base");
  result = invoke(directory, env, "status");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /recover the original commit/u);
  git(directory, "checkout", "-q", originalBranch);

  legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = tagObject.slice(0, 12);
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.base, originalParent);

  legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 2;
  legacy.base = "moving-base";
  legacy.startedAt = "2000-01-01T00:00:00.000Z";
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  git(directory, "branch", "moving-base", "HEAD");

  result = invoke(directory, env, "status");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /recover the original commit/u);

  const reflogSecond = Number(
    git(directory, "reflog", "show", "-1", "--format=%ct", "moving-base"),
  );
  legacy.startedAt = new Date(reflogSecond * 1_000).toISOString();
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);
  result = invoke(directory, env, "status");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /recover the original commit/u);
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

test("legacy clean state requires a new review under the current verdict contract", (t) => {
  const { directory, provider } = repositoryFixture(t);
  const env = reviewEnvironment(provider, "NO_IN_SCOPE_FUNCTIONAL_FINDINGS");
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
  const activeFile = path.join(storage, "active.json");
  const legacy = JSON.parse(readFileSync(activeFile, "utf8"));
  legacy.schemaVersion = 1;
  legacy.maxRounds = legacy.round + 1;
  writeFileSync(activeFile, `${JSON.stringify(legacy, null, 2)}\n`);

  result = invoke(directory, env, "status");
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.state.phase, "invalid");
  assert.equal(migrated.state.lastReview.status, "invalid");
  assert.equal(migrated.state.maxRounds, migrated.state.round + 2);
  assert.match(migrated.state.lastReview.reason, /predates the current verdict/u);

  result = invoke(directory, env, "finish", "--reason", "clean");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /latest valid review is not clean/u);

  result = invoke(
    directory,
    reviewEnvironment(provider, "Looks good to me."),
    "review",
  );
  assert.equal(result.status, 4);

  result = invoke(directory, env, "review");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(directory, env, "finish", "--reason", "clean");
  assert.equal(result.status, 0, result.stderr);
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
