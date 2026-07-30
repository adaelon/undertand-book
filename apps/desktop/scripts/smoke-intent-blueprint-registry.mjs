import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const sidecar = path.join(desktopRoot, "src-tauri", "binaries", "understand-book-build-x86_64-pc-windows-msvc.exe");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const source = path.join(repoRoot, "skills", "build", "intent-blueprint.ts");
const nodeRoot = mkdtempSync(path.join(tmpdir(), "intent-blueprint-node-"));
const sidecarRoot = mkdtempSync(path.join(tmpdir(), "intent-blueprint-sidecar-"));
const PRIVATE_SENTINEL = "PRIVATE_GOAL_SENTINEL";

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function run(program, args, command, label, expectedStatus = 0) {
  const result = spawnSync(program, args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: JSON.stringify(command),
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== expectedStatus) throw new Error(`${label} returned ${result.status}: ${result.stderr}`);
  if (result.stdout.includes(PRIVATE_SENTINEL) || result.stderr.includes(PRIVATE_SENTINEL)) {
    throw new Error(`${label} leaked rejected private input`);
  }
  if (expectedStatus !== 0) return result;
  const parsed = JSON.parse(result.stdout);
  const canonical = `${stableJson(parsed)}\n`;
  if (result.stdout !== canonical) throw new Error(`${label} did not emit canonical JSON`);
  return result.stdout;
}

function node(command, expectedStatus = 0) {
  return run(process.execPath, [tsx, source], command, "Node intent.blueprint", expectedStatus);
}

function packaged(command, expectedStatus = 0) {
  return run(sidecar, ["intent.blueprint"], command, "packaged intent.blueprint", expectedStatus);
}

function command(operation, privateRoot, input = {}) {
  return {
    version: "artifact_blueprint_registry_command.v1",
    operation,
    input: { private_root: privateRoot, ...input },
  };
}

function blueprint(origin = "user_private", blueprintId = "user.parity_checklist") {
  return {
    version: "artifact_blueprint.v1",
    blueprint_id: blueprintId,
    blueprint_version: "1.0.0",
    origin,
    title: "Parity checklist",
    purpose: "Verify Node and packaged registry behavior.",
    shape: "collection",
    record_schema: {
      type: "object",
      properties: { action: { type: "string", max_length: 200 } },
      required: ["action"],
      additional_properties: false,
      max_properties: 1,
    },
    routing: {
      use_when: ["A bounded checklist is useful."],
      avoid_when: ["Verbatim source evidence is required."],
      covered_topics: ["parity"],
      scope_label: "confirmed source scope",
    },
    search_fields: [{ path: "/action", weight: 10, analyzer: "text" }],
    summary_fields: ["/action"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: { max_records: 100, max_relations: 0, max_text_chars: 20_000 },
  };
}

function parity(operation, input) {
  const nodeOutput = node(command(operation, nodeRoot, input));
  const packagedOutput = packaged(command(operation, sidecarRoot, input));
  if (nodeOutput !== packagedOutput) throw new Error(`Node/Bun ${operation} bytes diverged`);
  return nodeOutput;
}

function allFileText(root) {
  const chunks = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) chunks.push(readFileSync(target, "utf8"));
    }
  };
  visit(root);
  return chunks.join("\n");
}

try {
  const candidate = blueprint();
  const identity = {
    blueprint_id: candidate.blueprint_id,
    blueprint_version: candidate.blueprint_version,
  };
  const empty = parity("list");
  if (!empty.includes('"user_candidates":[]') || empty.indexOf("system_presets") > empty.indexOf("user_candidates")) {
    throw new Error("empty registry did not retain system-first lookup order");
  }
  parity("upsert", { blueprint: candidate, created_at: "2026-07-29T10:00:00.000Z" });
  const repeated = parity("upsert", { blueprint: candidate, created_at: "2026-07-29T10:01:00.000Z" });
  if (!repeated.includes('"disposition":"existing"')) throw new Error("create-only upsert was not idempotent");
  parity("record_use", { ...identity, usage_id: "plan-1", used_at: "2026-07-29T10:02:00.000Z" });
  const active = parity("get", identity);
  if (!active.includes('"usage_count":1') || !active.includes('"status":"active"')) {
    throw new Error("usage count or active status diverged");
  }
  const shadow = blueprint("one_off", "system.timeline");
  const system = parity("resolve", { blueprint_id: "system.timeline", blueprint_version: "1.0.0", one_off: shadow });
  if (!system.includes('"source":"system"') || !system.includes('"title":"Timeline"')) {
    throw new Error("system preset did not win resolution");
  }
  parity("retire", { ...identity, retired_at: "2026-07-29T10:03:00.000Z" });
  const retired = parity("get", identity);
  if (!retired.includes('"status":"retired"')) throw new Error("retirement did not preserve readable metadata");
  const oneOff = blueprint("one_off", "one-off.parity");
  const resolvedOneOff = parity("resolve", {
    blueprint_id: oneOff.blueprint_id,
    blueprint_version: oneOff.blueprint_version,
    one_off: oneOff,
  });
  if (!resolvedOneOff.includes('"source":"one_off"')) throw new Error("empty private match did not allow one-off");

  const rejectedNode = command("list", nodeRoot, { raw_goal: PRIVATE_SENTINEL });
  const rejectedSidecar = command("list", sidecarRoot, { raw_goal: PRIVATE_SENTINEL });
  const nodeFailure = node(rejectedNode, 2);
  const sidecarFailure = packaged(rejectedSidecar, 2);
  if (nodeFailure.stderr !== sidecarFailure.stderr || nodeFailure.stdout !== "" || sidecarFailure.stdout !== "") {
    throw new Error("Node/Bun rejection surface diverged");
  }
  if (allFileText(nodeRoot).includes(PRIVATE_SENTINEL) || allFileText(sidecarRoot).includes(PRIVATE_SENTINEL)) {
    throw new Error("rejected private payload reached registry storage");
  }
  console.log("ArtifactBlueprint private registry Node/Bun parity and redaction smoke passed");
} finally {
  rmSync(nodeRoot, { recursive: true, force: true });
  rmSync(sidecarRoot, { recursive: true, force: true });
}
