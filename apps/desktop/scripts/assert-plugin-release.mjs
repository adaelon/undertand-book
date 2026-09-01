import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const sourceContractOnly = process.argv.includes("--source-contract-only");
const executorServerName = "understand_book_build_executor";
const executorToolNames = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
];
const rootToolProhibition = (toolName) => (
  `The root must not call, probe, enumerate, or use \`${toolName}\` to diagnose a handoff.`
);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function readText(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function readOptionalText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return existsSync(absolutePath) ? readFile(absolutePath, "utf8") : "";
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?|\n/gu, "\n");
}

function normalizeContract(text) {
  return normalizeLineEndings(text).replace(/\n+$/u, "");
}

function expectedDeveloperInstructionsAssignment(wrapper) {
  const escaped = normalizeContract(wrapper).replace(/\\/gu, "\\\\");
  return `developer_instructions = """\n${escaped}\n"""`;
}

function skillBody(skill) {
  const normalized = skill.replace(/\r\n?/gu, "\n");
  assert(normalized.startsWith("---\n"), "executor skill must start with YAML frontmatter");
  const closing = normalized.indexOf("\n---\n", 4);
  assert(closing > 0, "executor skill frontmatter must have a closing delimiter");
  return normalizeContract(normalized.slice(closing + 5));
}

function assertPublishedFile(relativePath, message) {
  assert(existsSync(path.join(repoRoot, ...relativePath.split("/"))), message);
}

function assertSharedExecutorMcp(config, label) {
  const server = config.mcpServers?.[executorServerName];
  assert(server, `${label} must register the root-shared Build Executor server`);
  assert.equal(server.type, "stdio", `${label} shared Executor server must use stdio`);
  assert.equal(server.command, "cmd.exe", `${label} shared Executor server must use the plugin launcher`);
  assert.deepEqual(
    server.args,
    ["/d", "/s", "/c", "scripts\\start-build-executor-mcp.cmd"],
    `${label} shared Executor server must use the plugin-owned Windows resolver`,
  );
  assert.equal(server.cwd, ".", `${label} shared Executor cwd must resolve from plugin root`);
  assert.equal(server.required, false, `${label} shared Executor server must remain optional`);
  assert.deepEqual(
    server.enabled_tools,
    executorToolNames,
    `${label} shared Executor allowlist must contain exactly four tools`,
  );
  assert.equal(
    server.default_tools_approval_mode,
    "approve",
    `${label} shared Executor approval mode must be approve`,
  );
  assert.equal(server.startup_timeout_sec, 10, `${label} shared Executor startup timeout drifted`);
  assert.equal(server.tool_timeout_sec, 120, `${label} shared Executor tool timeout drifted`);
  assert.deepEqual(
    server.env_vars,
    ["UNDERSTAND_BOOK_BUILD_EXE", "UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT", "USERPROFILE"],
    `${label} shared Executor environment surface drifted`,
  );
}

const marketplace = await readJson(".agents/plugins/marketplace.json");
const entry = marketplace.plugins?.find((plugin) => plugin.name === "understand-book");
assert(entry, "marketplace must publish the understand-book plugin");
assert.deepEqual(entry.source, {
  source: "local",
  path: "./plugins/understand-book",
}, "marketplace must publish plugins/understand-book");
const releasePluginRoot = path.join(repoRoot, "plugins", "understand-book");
assert(
  !existsSync(path.join(releasePluginRoot, "agents")),
  "published Codex plugin must remain thin and must not contain agents/",
);
assert(
  !existsSync(path.join(releasePluginRoot, ".codex", "agents")),
  "published Codex plugin must not claim that .codex/agents is auto-registered",
);

const desktopPackage = await readJson("apps/desktop/package.json");
assert(
  desktopPackage.scripts?.["package:windows"]?.includes("smoke-automatic-build-parity.mjs"),
  "package:windows must gate on the thin-plugin automatic-build parity smoke",
);
assert(
  desktopPackage.scripts?.["package:windows"]?.includes("assert-plugin-release.mjs"),
  "package:windows must gate on the plugin release assertion",
);
assert(
  desktopPackage.scripts?.["test:t7-codex-cli-release"]?.includes("smoke-t7-codex-cli-release.ts"),
  "desktop scripts must publish the thread-attributed T7 real Codex CLI release smoke",
);

const rootManifest = await readJson(".codex-plugin/plugin.json");
const releaseManifest = await readJson("plugins/understand-book/.codex-plugin/plugin.json");
assert.deepEqual(
  releaseManifest,
  rootManifest,
  "published plugin manifest must match the root Codex plugin manifest",
);
assert.equal(
  rootManifest.mcpServers,
  "./.mcp.json",
  "plugin manifest must declare the companion MCP config",
);

const rootMcpText = await readText(".mcp.json");
const releaseMcpText = await readText("plugins/understand-book/.mcp.json");
assert.equal(
  releaseMcpText,
  rootMcpText,
  "published plugin MCP config must match the root plugin MCP config byte-for-byte",
);
const rootMcp = JSON.parse(rootMcpText);
const releaseMcp = JSON.parse(releaseMcpText);
assert.deepEqual(
  releaseMcp,
  rootMcp,
  "published plugin MCP config must match the root plugin MCP config",
);
assert.deepEqual(
  rootMcp.mcpServers?.book?.args,
  ["/d", "/s", "/c", "scripts\\start-book-mcp.cmd"],
  "Book MCP must launch through the plugin-owned Windows resolver",
);
assert.equal(rootMcp.mcpServers?.book?.cwd, ".", "Book MCP cwd must resolve from plugin root");

const projectCodexConfig = await readOptionalText(".codex/config.toml");
assert(
  !projectCodexConfig.includes(executorServerName),
  "project Codex config must not duplicate the plugin-owned shared Executor transport",
);
for (const toolName of executorToolNames) {
  assert(
    !projectCodexConfig.includes(toolName),
    `project Codex config must not duplicate shared Executor tool: ${toolName}`,
  );
}
assertSharedExecutorMcp(rootMcp, "root plugin MCP config");
assertSharedExecutorMcp(releaseMcp, "published plugin MCP config");

const rootMcpLauncher = await readText("scripts/start-book-mcp.cmd");
const releaseMcpLauncher = await readText("plugins/understand-book/scripts/start-book-mcp.cmd");
assert.equal(
  releaseMcpLauncher,
  rootMcpLauncher,
  "published Book MCP launcher must match the root plugin launcher",
);
for (const marker of ["UNDERSTAND_BOOK_MCP_BIN", "HKCU\\Software\\UnderstandBook", "book-mcp.exe"]) {
  assert(rootMcpLauncher.includes(marker), `Book MCP launcher is missing resolver marker: ${marker}`);
}

const rootExecutorMcpLauncher = await readText("scripts/start-build-executor-mcp.cmd");
const releaseExecutorMcpLauncher = await readText(
  "plugins/understand-book/scripts/start-build-executor-mcp.cmd",
);
assert.equal(
  releaseExecutorMcpLauncher,
  rootExecutorMcpLauncher,
  "published Executor MCP launcher must match the root plugin launcher",
);
for (const marker of [
  "UNDERSTAND_BOOK_BUILD_EXE",
  "HKCU\\Software\\UnderstandBook",
  "understand-book-build.exe",
  "executor.mcp --bootstrap-version automatic_build_executor_bootstrap.v3 "
    + "--protocol-generation automatic_build_executor_session.v3",
]) {
  assert(
    rootExecutorMcpLauncher.includes(marker),
    `Executor MCP launcher is missing resolver marker: ${marker}`,
  );
}
assert(
  !rootExecutorMcpLauncher.includes("--agent-bootstrap-digest")
    && !rootExecutorMcpLauncher.includes("%*"),
  "Executor MCP launcher must pass only the fixed digest-free V3 bootstrap arguments",
);

const rootSkill = await readText("skills/build/SKILL.md");
const releaseSkill = await readText("plugins/understand-book/skills/build/SKILL.md");
assert.equal(
  releaseSkill,
  rootSkill,
  "published build skill must match the root build skill byte-for-byte",
);

const executorAgentPaths = [
  ".codex/agents/understand-book-executor.toml",
  "assets/codex-agents/understand-book-executor.toml",
  "plugins/understand-book/assets/codex-agents/understand-book-executor.toml",
];
const executorKnownPredecessorPaths = [
  "assets/codex-agents/understand-book-executor.known-predecessor.toml",
  "plugins/understand-book/assets/codex-agents/understand-book-executor.known-predecessor.toml",
];
for (const relativePath of executorAgentPaths) {
  assertPublishedFile(relativePath, `executor custom-agent publication is missing: ${relativePath}`);
}
for (const relativePath of executorKnownPredecessorPaths) {
  assertPublishedFile(relativePath, `executor predecessor publication is missing: ${relativePath}`);
}
const projectExecutorAgent = await readText(executorAgentPaths[0]);
const rootExecutorAgentTemplate = await readText(executorAgentPaths[1]);
const releaseExecutorAgentTemplate = await readText(executorAgentPaths[2]);
assert.equal(
  rootExecutorAgentTemplate,
  projectExecutorAgent,
  "root executor agent template must match the project custom agent byte-for-byte",
);
assert.equal(
  releaseExecutorAgentTemplate,
  projectExecutorAgent,
  "published executor agent template must match the project custom agent byte-for-byte",
);
assert.equal(
  await readText(executorKnownPredecessorPaths[1]),
  await readText(executorKnownPredecessorPaths[0]),
  "published executor predecessor must match the root predecessor byte-for-byte",
);
assert.match(projectExecutorAgent, /^name\s*=\s*"understand_book_executor"\s*$/mu);
assert(
  projectExecutorAgent.includes(
    'description = "Execute exactly one Understand Book opaque handoff through the packaged executor session protocol."',
  ),
  "executor custom agent must carry the bounded single-handoff description",
);
assert(
  !/^model(?:_reasoning_effort)?\s*=/mu.test(projectExecutorAgent),
  "executor custom agent must inherit model and reasoning settings",
);
assert.match(
  projectExecutorAgent,
  /^sandbox_mode\s*=\s*"read-only"\s*$/mu,
  "executor custom agent must default to read-only sandbox mode",
);
for (const [label, agentText] of [
  ["project executor role", projectExecutorAgent],
  ["root executor role template", rootExecutorAgentTemplate],
  ["published executor role template", releaseExecutorAgentTemplate],
]) {
  assert.doesNotMatch(
    agentText,
    /^\[mcp_servers\.[^\]]+\]\s*$/mu,
    `${label} must inherit the plugin-owned shared MCP and contain zero local mcp_servers`,
  );
}
const canonicalExecutorWrapper = await readText("agents/automatic-build-dispatch-executor.md");
assert(
  canonicalExecutorWrapper.includes(
    "Do not activate `$understand-book-build`, `$understand-book-executor`, or any other skill; "
      + "this role already carries the complete bootstrap contract.",
  ),
  "executor bootstrap must prohibit skill activation after role injection",
);
assert(
  normalizeLineEndings(projectExecutorAgent)
    .includes(expectedDeveloperInstructionsAssignment(canonicalExecutorWrapper)),
  "executor custom-agent developer_instructions must contain the full canonical bootstrap body",
);

const rootRegisterScriptPath = "scripts/register-executor-agent.ps1";
const releaseRegisterScriptPath = "plugins/understand-book/scripts/register-executor-agent.ps1";
const rootRegisterSkillPath = "skills/register-executor/SKILL.md";
const releaseRegisterSkillPath = "plugins/understand-book/skills/register-executor/SKILL.md";
for (const relativePath of [
  rootRegisterScriptPath,
  releaseRegisterScriptPath,
  rootRegisterSkillPath,
  releaseRegisterSkillPath,
]) {
  assertPublishedFile(relativePath, `executor agent registration projection is missing: ${relativePath}`);
}
assert.equal(
  await readText(releaseRegisterScriptPath),
  await readText(rootRegisterScriptPath),
  "published executor registration script must match the root script byte-for-byte",
);
assert(
  (await readText(rootRegisterScriptPath)).includes('GetEnvironmentVariable("CODEX_HOME")'),
  "personal executor registration must honor an isolated CODEX_HOME",
);
assert.equal(
  await readText(releaseRegisterSkillPath),
  await readText(rootRegisterSkillPath),
  "published executor registration skill must match the root skill byte-for-byte",
);

const rootExecutorSkillPath = "skills/executor/SKILL.md";
const releaseExecutorSkillPath = "plugins/understand-book/skills/executor/SKILL.md";
for (const relativePath of [rootExecutorSkillPath, releaseExecutorSkillPath]) {
  assertPublishedFile(relativePath, `executor-only skill projection is missing: ${relativePath}`);
}
const rootExecutorSkill = await readText(rootExecutorSkillPath);
const releaseExecutorSkill = await readText(releaseExecutorSkillPath);
assert.equal(
  releaseExecutorSkill,
  rootExecutorSkill,
  "published executor-only skill must match the root skill byte-for-byte",
);
assert.match(rootExecutorSkill, /^name:\s*understand-book-executor\s*$/mu);
assert.equal(
  skillBody(rootExecutorSkill),
  normalizeContract(canonicalExecutorWrapper),
  "executor-only skill body must equal the normalized canonical bootstrap body",
);
for (const forbidden of ["BuildIntent", "BuildPlan", "build.step", "planning.context", "draft.candidate"]) {
  assert(
    !rootExecutorSkill.includes(forbidden),
    `executor-only skill must not contain root orchestration marker: ${forbidden}`,
  );
}

assert(
  /agent_type\s*=\s*understand_book_executor/u.test(rootSkill),
  "build skill must explicitly select agent_type=understand_book_executor when advertised",
);
for (const marker of [
  "$understand-book-executor",
  "Do not use $understand-book-build inside this subagent.",
  "bootstrap_unavailable",
  "live_by_ref",
  "completed_refs",
  "first owned child becomes terminal",
]) {
  assert(rootSkill.includes(marker), `build skill is missing executor provider marker: ${marker}`);
}
assert(
  !/Open this ref with the packaged Build Engine,\s+follow the\s+`executor\.open`\s*\/\s*`executor\.session`\s+protocol/u
    .test(rootSkill),
  "build skill must not retain the unbound generic executor spawn instruction",
);
assert(
  rootSkill.search(/agent_type\s*=\s*understand_book_executor/u)
    < rootSkill.indexOf("$understand-book-executor"),
  "build skill must place the custom-agent provider before the executor skill fallback",
);
const rootActionLoopIndex = rootSkill.indexOf("## Four-action loop");
assert(rootActionLoopIndex > 0, "build skill must retain the bounded four-action loop");
const rootSkillBeforeActionLoop = rootSkill.slice(0, rootActionLoopIndex);
for (const toolName of executorToolNames) {
  assert(
    rootSkillBeforeActionLoop.includes(rootToolProhibition(toolName)),
    `root build skill must explicitly prohibit ${toolName} before the action loop`,
  );
}
const rootHardBoundaries = rootSkill.slice(rootSkill.indexOf("## Hard boundaries"));
for (const toolName of executorToolNames) {
  assert(
    rootHardBoundaries.includes(rootToolProhibition(toolName)),
    `root build skill must explicitly prohibit ${toolName} at hard boundaries`,
  );
}

const realCliReleaseSmoke = await readText("apps/desktop/scripts/smoke-t7-codex-cli-release.ts");
for (const marker of ["capability_isolation: false", "caller_role_authenticated: false"]) {
  assert(
    realCliReleaseSmoke.includes(marker),
    `thread-attributed release evidence must explicitly serialize ${marker}`,
  );
}

const protocolMarkers = [
  "automatic_build_invocation_create.v1",
  "automatic_build_step_request.v1",
  "SPAWN_EXECUTORS",
  "WAIT",
  "NEEDS_USER",
  "DONE",
  "available_agent_slots",
  "opaque_handoff_ref",
  "retry_after_ms",
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
  "The root never reads, receives, summarizes, caches, or forwards semantic input or candidate JSON.",
  "codex_build_intent_command.v2",
  "codex_build_intent_result.v2",
  "codex_build_intent_response.v1",
  "build_planning_context.v1",
  "build_intent_planner_candidate.v2",
  "planning.context",
  "draft.candidate",
  "BUILD_PLANNING_CONTEXT_DRIFT",
  "CODEX_BUILD_INTENT_V2_REQUIRED",
  "free-form string",
  "Never fall back to `codex_build_intent_command.v1`",
  "codex_conversation",
  "plan_confirmation_required",
  "CODEX_BUILD_FOUNDATION_REQUIRED",
  "The Desktop controller response is the only authority for whether foundation is required",
  "Do not inspect `.build/input/manifest.json`",
  "UnderstandBook.exe",
];
for (const marker of protocolMarkers) {
  assert(
    releaseSkill.includes(marker),
    `published build skill is missing automatic-build v2 marker: ${marker}`,
  );
}
for (const removedMarker of [
  "run `legacy-plan` exactly once",
  "automatic_build_plan.v1",
  "automatic_build_next.v1",
  "path.relative(action.cwd, executor_handoff.path)",
  "handoff_relative_path",
  "receipt_aggregation.expected_receipts",
  "input_command",
  "candidate_command",
  "submit_command",
  "fail_command",
  "close_stage",
  "automatic_build_stage_close_result.v1",
  "automatic_build_recovery.v1",
  "artifact.prepare",
  "intent_artifact_mailbox_receipt.v1",
]) {
  assert(
    !releaseSkill.includes(removedMarker),
    `published build skill still contains removed manual protocol marker: ${removedMarker}`,
  );
}

const installedPluginRoot = process.env.UNDERSTAND_BOOK_INSTALLED_PLUGIN_ROOT;
if (installedPluginRoot && !sourceContractOnly) {
  const installedRoot = path.resolve(installedPluginRoot);
  const relativeToRepo = path.relative(repoRoot, installedRoot);
  assert(
    relativeToRepo.startsWith("..") || path.isAbsolute(relativeToRepo),
    "installed plugin root must not resolve inside the source repository",
  );
  const installedSkill = await readFile(path.join(installedPluginRoot, "skills", "build", "SKILL.md"), "utf8");
  assert.equal(
    installedSkill,
    releaseSkill,
    "installed build skill must match the published build skill byte-for-byte",
  );
  assert.equal(
    await readFile(path.join(installedPluginRoot, ".mcp.json"), "utf8"),
    releaseMcpText,
    "installed plugin MCP config must match the published MCP config byte-for-byte",
  );
  assert.equal(
    await readFile(path.join(installedPluginRoot, "scripts", "start-build-executor-mcp.cmd"), "utf8"),
    releaseExecutorMcpLauncher,
    "installed Executor MCP launcher must match the published launcher byte-for-byte",
  );
  assert(
    !existsSync(path.join(installedPluginRoot, "agents")),
    "installed Codex plugin must remain thin and must not contain agents/",
  );
  assert(
    !existsSync(path.join(installedPluginRoot, ".codex", "agents")),
    "installed Codex plugin must not claim that .codex/agents is auto-registered",
  );
  for (const sourceOnlyPath of ["packages", "apps", "node_modules", ".git"]) {
    assert(
      !existsSync(path.join(installedPluginRoot, sourceOnlyPath)),
      `installed Codex plugin must not contain source-only path: ${sourceOnlyPath}`,
    );
  }
  for (const relativePath of [
    "assets/codex-agents/understand-book-executor.toml",
    "assets/codex-agents/understand-book-executor.known-predecessor.toml",
    "scripts/register-executor-agent.ps1",
    "skills/register-executor/SKILL.md",
    "skills/executor/SKILL.md",
  ]) {
    assert(
      existsSync(path.join(installedPluginRoot, ...relativePath.split("/"))),
      `installed Codex plugin is missing executor bootstrap projection: ${relativePath}`,
    );
  }
  assert.equal(
    normalizeLineEndings(await readFile(
      path.join(installedPluginRoot, "assets", "codex-agents", "understand-book-executor.toml"),
      "utf8",
    )),
    normalizeLineEndings(releaseExecutorAgentTemplate),
    "installed executor agent template must match the published release file",
  );
  const installedManifest = JSON.parse(await readFile(
    path.join(installedPluginRoot, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  assert.equal(
    installedManifest.version,
    releaseManifest.version,
    "installed plugin cachebuster must match the published manifest version",
  );
}

const sidecarEntry = await readText("skills/build/sidecar-entry.ts");
for (const command of [
  "build.step",
  "executor.agent-template",
  "executor.mcp-config",
  "executor.mcp-launcher",
  "executor.mcp",
  "executor.open",
  "executor.session",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
  "intent.plan",
  "intent.artifact",
  "intent.metrics",
  "intent.blueprint",
]) {
  assert(
    sidecarEntry.includes(`\"${command}\"`),
    `packaged build sidecar is missing command: ${command}`,
  );
}

const dispatchWrapper = await readText("agents/automatic-build-dispatch-executor.md");
for (const marker of [
  "automatic_build_executor_session.v3",
  "automatic_build_executor_open_request.v3",
  "opaque_handoff_ref",
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
  "action.kind=DELIVER_INPUT",
  "action.kind=INPUT_BATCH",
  "action.kind=GENERATE",
  "action.kind=WAIT",
  "action.kind=DONE",
  "ack_through_ordinal",
  "confirmed_through_ordinal",
  "does not authenticate the caller role",
  "Never return candidate JSON to the caller",
]) {
  assert(dispatchWrapper.includes(marker), `dispatch executor wrapper is missing marker: ${marker}`);
}
for (const removedMarker of [
  "automatic_build_dispatch_executor.v1",
  "next_command",
  "input_command",
  "candidate_command",
  "submit_command",
  "fail_command",
  "interrupt_command",
  "automatic_build_executor_session.v1",
  "automatic_build_executor_session.v2",
  "chunk_receipt",
  "previous_chunk_receipt",
  "agent-only stdio",
  "candidate_path",
  "executor.session",
]) {
  assert(
    !dispatchWrapper.includes(removedMarker),
    `dispatch executor wrapper still contains removed command marker: ${removedMarker}`,
  );
}
assert(
  sidecarEntry.includes("automatic-build-dispatch-executor.md"),
  "packaged build sidecar must import the dispatch executor wrapper asset",
);
if (sourceContractOnly) {
  console.log(`plugin source contract ok: ${releaseManifest.version}`);
  process.exit(0);
}
const sidecarBinary = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "binaries",
  "understand-book-build-x86_64-pc-windows-msvc.exe",
);
const packagedPrompt = spawnSync(sidecarBinary, [
  "prompt",
  "pass1-local-extractor.md",
  "--executor-protocol",
  "dispatch",
], { encoding: "utf8" });
assert.ifError(packagedPrompt.error);
assert.equal(packagedPrompt.status, 0, `packaged executor prompt failed: ${packagedPrompt.stderr}`);
assert.equal(packagedPrompt.stderr, "", "packaged executor prompt must reserve stderr for diagnostics");
for (const marker of [
  "automatic_build_executor_session.v3",
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
  "action.kind=DELIVER_INPUT",
  "action.kind=INPUT_BATCH",
  "action.kind=GENERATE",
  "action.kind=WAIT",
  "action.kind=DONE",
]) {
  assert(packagedPrompt.stdout.includes(marker), `packaged executor prompt is missing marker: ${marker}`);
}

if (!process.argv.includes("--automatic-build-parity-prechecked")) {
  const parity = spawnSync(process.execPath, [
    path.join(scriptDir, "smoke-automatic-build-parity.mjs"),
  ], { cwd: repoRoot, encoding: "utf8", timeout: 240_000 });
  assert.ifError(parity.error);
  assert.equal(
    parity.status,
    0,
    `thin-plugin accepted-next parity failed:\n${parity.stdout}\n${parity.stderr}`,
  );
}

if (!process.argv.includes("--t7-executor-release-prechecked")) {
  const t7ExecutorRelease = spawnSync(process.execPath, [
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(scriptDir, "smoke-t7-executor-release.ts"),
  ], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
  assert.ifError(t7ExecutorRelease.error);
  assert.equal(
    t7ExecutorRelease.status,
    0,
    `T7 compiled executor release smoke failed:\n${t7ExecutorRelease.stdout}\n${t7ExecutorRelease.stderr}`,
  );
}

console.log(`plugin release parity ok: ${releaseManifest.version}`);
