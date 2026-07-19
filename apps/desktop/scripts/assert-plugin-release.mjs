import assert from "node:assert/strict";
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

const releaseSkill = await readText("plugins/understand-book/skills/build/SKILL.md");
const protocolMarkers = [
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
];
for (const marker of protocolMarkers) {
  assert(
    releaseSkill.includes(marker),
    `published build skill is missing automatic-build v2 marker: ${marker}`,
  );
}

const sidecarEntry = await readText("skills/build/sidecar-entry.ts");
for (const command of [
  "plan",
  "next",
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
]) {
  assert(
    sidecarEntry.includes(`\"${command}\"`),
    `packaged build sidecar is missing command: ${command}`,
  );
}

console.log(`plugin release parity ok: ${releaseManifest.version}`);
