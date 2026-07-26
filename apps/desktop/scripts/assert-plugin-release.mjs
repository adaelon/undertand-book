import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const releaseSkill = await readText("plugins/understand-book/skills/build/SKILL.md");
const protocolMarkers = [
  "automatic_build_protocol.v2_dispatch",
  "protocol-doctor",
  "legacy-plan",
  "explicit_legacy_command",
  "--protocol automatic_build_protocol.v2",
  "automatic_build_plan.v1",
  "--accepted-plan",
  "--available-agent-slots",
  "worker_plan.max_workers",
  "candidate_path",
  "usage_path",
  "submit_command",
  "automatic_build_task_receipt.v1",
  "receipt_aggregation",
  "executor_unavailable",
  "legacy_migration_required",
  "quality_gate_failed",
  "codex_build_intent_command.v1",
  "codex_build_intent_response.v1",
  "codex_conversation",
  "plan_confirmation_required",
  "artifact.prepare",
  "intent_artifact_mailbox_receipt.v1",
  "UnderstandBook.exe",
];
for (const marker of protocolMarkers) {
  assert(
    releaseSkill.includes(marker),
    `published build skill is missing automatic-build v2 marker: ${marker}`,
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
}

const sidecarEntry = await readText("skills/build/sidecar-entry.ts");
for (const command of [
  "legacy-plan",
  "protocol-doctor",
  "plan",
  "next",
  "dispatch.next",
  "dispatch.inspect",
  "dispatch.finish",
  "audit-legacy",
  "migration-mode",
  "quality",
  "metrics",
  "record-attempt",
  "heartbeat",
  "candidate",
  "submit",
  "legacy-submit",
  "fail",
  "inspect",
  "input",
  "write",
  "close",
  "intent.plan",
  "intent.artifact",
  "intent.metrics",
]) {
  assert(
    sidecarEntry.includes(`\"${command}\"`),
    `packaged build sidecar is missing command: ${command}`,
  );
}

console.log(`plugin release parity ok: ${releaseManifest.version} skill_sha256=${releaseSkillSha256}`);
