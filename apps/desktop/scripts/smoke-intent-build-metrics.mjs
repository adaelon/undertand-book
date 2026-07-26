import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const sidecar = path.join(desktopRoot, "src-tauri", "binaries", "understand-book-build-x86_64-pc-windows-msvc.exe");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const source = path.join(repoRoot, "skills", "build", "intent-metrics.ts");
const nodeRoot = mkdtempSync(path.join(tmpdir(), "intent-metrics-node-"));
const sidecarRoot = mkdtempSync(path.join(tmpdir(), "intent-metrics-sidecar-"));

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function run(program, args, command, label) {
  const result = spawnSync(program, args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: JSON.stringify(command),
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const canonical = `${stableJson(parsed)}\n`;
  if (result.stdout !== canonical) throw new Error(`${label} did not emit canonical JSON`);
  return result.stdout;
}

function node(command) {
  return run(process.execPath, [tsx, source], command, "Node intent.metrics");
}

function packaged(command) {
  return run(sidecar, ["intent.metrics"], command, "packaged intent.metrics");
}

function command(operation, privateRoot, input) {
  return {
    version: "intent_build_usage_command.v1",
    operation,
    input: { private_root: privateRoot, ...input },
  };
}

const plan = {
  plan_id: "plan-standard",
  revision: 1,
  plan_digest: "a".repeat(64),
  confirmation_source: "explicit_legacy_command",
};
const events = [
  {
    version: "intent_build_usage_event.v1",
    event_id: "selected-standard",
    book_id: "parity-book",
    mode: "standard_deep",
    occurred_at: "2026-07-26T09:00:00.000Z",
    kind: "plan_selected",
    plan,
    estimate: {
      token_lower: 100,
      token_upper: 200,
      token_coverage: 0.8,
      wall_clock_confidence: "low",
      unknown_item_count: 1,
    },
  },
  {
    version: "intent_build_usage_event.v1",
    event_id: "ready-standard",
    book_id: "parity-book",
    mode: "standard_deep",
    occurred_at: "2026-07-26T09:00:00.250Z",
    kind: "reader_ready",
    plan,
  },
  {
    version: "intent_build_usage_event.v1",
    event_id: "failed-standard",
    book_id: "parity-book",
    mode: "standard_deep",
    occurred_at: "2026-07-26T09:01:00.000Z",
    kind: "cost_observed",
    plan,
    attempt_id: "attempt-1",
    outcome: "retryable_failure",
    wall_clock_ms: 2_000,
    usage: { source: "unavailable", estimate_method: "executor_estimate.v1", estimated_input_tokens: 30, estimated_output_tokens: 8 },
  },
  {
    version: "intent_build_usage_event.v1",
    event_id: "committed-standard",
    book_id: "parity-book",
    mode: "standard_deep",
    occurred_at: "2026-07-26T09:02:00.000Z",
    kind: "cost_observed",
    plan,
    attempt_id: "attempt-2",
    outcome: "committed",
    wall_clock_ms: 3_000,
    usage: { source: "native", input_tokens: 40, cached_input_tokens: 5, output_tokens: 12 },
  },
];

try {
  for (const event of events) {
    const nodeOutput = node(command("append", nodeRoot, { event }));
    const sidecarOutput = packaged(command("append", sidecarRoot, { event }));
    if (nodeOutput !== sidecarOutput) throw new Error("Node/Bun append result diverged");
  }
  const nodeRepeat = node(command("append", nodeRoot, { event: events[0] }));
  const sidecarRepeat = packaged(command("append", sidecarRoot, { event: events[0] }));
  if (nodeRepeat !== sidecarRepeat || !nodeRepeat.includes('"disposition":"existing"')) {
    throw new Error("Node/Bun create-only idempotence diverged");
  }
  const reportInput = {
    book_id: "parity-book",
    as_of: "2026-07-26T10:00:00.000Z",
    window_days: 7,
  };
  const nodeReport = node(command("report", nodeRoot, reportInput));
  const sidecarReport = packaged(command("report", sidecarRoot, reportInput));
  if (nodeReport !== sidecarReport) throw new Error("Node/Bun ablation report bytes diverged");
  if (!nodeReport.includes('"event_count":4')
    || !nodeReport.includes('"retryable_failure":1')
    || /user_goal|evidence_lids|artifact_body|PRIVATE_SENTINEL/u.test(nodeReport.replace('"artifact_body":false', ""))) {
    throw new Error("ablation report lost cost accumulation or privacy constraints");
  }
  console.log("intent build usage create-only ledger and Node/Bun ablation parity smoke passed");
} finally {
  rmSync(nodeRoot, { recursive: true, force: true });
  rmSync(sidecarRoot, { recursive: true, force: true });
}
