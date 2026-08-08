import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function readText(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
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

const desktopPackage = await readJson("apps/desktop/package.json");
assert(
  desktopPackage.scripts?.["package:windows"]?.includes("smoke-automatic-build-parity.mjs"),
  "package:windows must gate on the thin-plugin automatic-build parity smoke",
);
assert(
  desktopPackage.scripts?.["package:windows"]?.includes("assert-plugin-release.mjs"),
  "package:windows must gate on the plugin release assertion",
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

const rootMcp = await readJson(".mcp.json");
const releaseMcp = await readJson("plugins/understand-book/.mcp.json");
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

const rootSkill = await readText("skills/build/SKILL.md");
const releaseSkill = await readText("plugins/understand-book/skills/build/SKILL.md");
assert.equal(
  releaseSkill,
  rootSkill,
  "published build skill must match the root build skill byte-for-byte",
);
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
  "executor.session",
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

const releaseSkillSha256 = createHash("sha256").update(releaseSkill).digest("hex");
const installedPluginRoot = process.env.UNDERSTAND_BOOK_INSTALLED_PLUGIN_ROOT;
if (installedPluginRoot) {
  const installedSkill = await readFile(path.join(installedPluginRoot, "skills", "build", "SKILL.md"), "utf8");
  assert.equal(
    createHash("sha256").update(installedSkill).digest("hex"),
    releaseSkillSha256,
    "installed build skill must match the published source snapshot hash",
  );
  assert(
    !existsSync(path.join(installedPluginRoot, "agents")),
    "installed Codex plugin must remain thin and must not contain agents/",
  );
  const installedManifest = JSON.parse(await readFile(
    path.join(installedPluginRoot, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  assert.equal(
    installedManifest.version,
    releaseManifest.version,
    "installed plugin cachebuster must match the published release snapshot",
  );
}

const sidecarEntry = await readText("skills/build/sidecar-entry.ts");
for (const command of [
  "build.step",
  "executor.open",
  "executor.session",
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
  "automatic_build_executor_session.v1",
  "opaque_handoff_ref",
  "executor.open",
  "GENERATE",
  "executor.session",
  "WAIT",
  "DONE",
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
  "automatic_build_executor_session.v1",
  "executor.open",
  "action.kind=GENERATE",
  "action.kind=WAIT",
  "action.kind=DONE",
  "automatic_build_executor.v1",
]) {
  assert(packagedPrompt.stdout.includes(marker), `packaged executor prompt is missing marker: ${marker}`);
}

if (!process.argv.includes("--automatic-build-parity-prechecked")) {
  const parity = spawnSync(process.execPath, [
    path.join(scriptDir, "smoke-automatic-build-parity.mjs"),
  ], { cwd: repoRoot, encoding: "utf8", timeout: 90_000 });
  assert.ifError(parity.error);
  assert.equal(
    parity.status,
    0,
    `thin-plugin accepted-next parity failed:\n${parity.stdout}\n${parity.stderr}`,
  );
}

console.log(`plugin release parity ok: ${releaseManifest.version} skill_sha256=${releaseSkillSha256}`);
