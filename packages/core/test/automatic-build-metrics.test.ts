import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { failAutomaticBuildTask, submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import {
  automaticBuildStageMetricsSummaryPath,
  automaticBuildTaskMetricsPath,
  automaticBuildUsageReceiptPath,
  readAutomaticBuildUsageReceipt,
  recordAutomaticBuildInputObservation,
  writeAutomaticBuildStageMetricsSummary,
} from "../src/automatic-build-metrics";
import { resolveAutomaticBuildTarget, type AutomaticBuildTarget } from "../src/build-orchestrator";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-metrics-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  return { root, target: resolveAutomaticBuildTarget(source, root) };
}

function claim(target: AutomaticBuildTarget, taskId: string) {
  const result = claimAutomaticBuildTask(target, "pass1", taskId, {
    owner: `metrics-${taskId}`,
    now: "2026-07-19T00:00:00.000Z",
    ttl_ms: 60_000,
  });
  if (result.status !== "leased") throw new Error("expected lease");
  return result;
}

function observeInput(target: AutomaticBuildTarget, lease: ReturnType<typeof claim>, inputBytes: number) {
  return recordAutomaticBuildInputObservation(target, lease.lease_ref, lease.lease.token, {
    started_at: "2026-07-19T00:00:01.000Z",
    finished_at: "2026-07-19T00:00:01.200Z",
    input_bytes: inputBytes,
  });
}

function candidate(lease: ReturnType<typeof claim>, value: unknown): string {
  const file = path.join(path.dirname(lease.lease_ref), "candidate.json");
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function submit(
  root: string,
  target: AutomaticBuildTarget,
  lease: ReturnType<typeof claim>,
  candidatePath: string,
  outputCounts?: Record<string, number>,
) {
  const artifact = path.join(root, `artifact-${lease.lease.work_unit_id}.json`);
  return submitAutomaticBuildCandidate(target, lease.lease_ref, lease.lease.token, candidatePath, () => {
    writeFileSync(artifact, JSON.stringify({ ok: true }), "utf8");
    return { artifact_path: artifact, ...(outputCounts ? { output_counts: outputCounts } : {}) };
  }, {
    now: "2026-07-19T00:00:03.000Z",
    completed_at: "2026-07-19T00:00:03.250Z",
  });
}

describe("automatic build task metrics", () => {
  it("keeps unavailable exact usage unknown while preserving measured bytes and timing", () => {
    const { root, target } = fixture();
    const lease = claim(target, "missing-usage");
    observeInput(target, lease, 120);
    const receipt = submit(root, target, lease, candidate(lease, { nodes: [], edges: [] }), { nodes: 0, edges: 0 });

    expect(receipt.metrics).toMatchObject({
      status: "committed",
      queue_ms: 0,
      lease_wait_ms: 1_000,
      executor_ms: 1_800,
      writer_ms: 250,
      input_bytes: 120,
      output_items: 0,
      usage: { source: "unavailable" },
    });
    expect(receipt.metrics?.usage).not.toHaveProperty("input_tokens");
    expect(receipt.metrics?.usage).not.toHaveProperty("output_tokens");
    expect(receipt.metrics).not.toHaveProperty("estimate");
    expect(JSON.parse(readFileSync(automaticBuildTaskMetricsPath(lease.lease_ref), "utf8"))).toEqual(receipt.metrics);
  });

  it("validates usage receipts and aggregates native, partial, and missing coverage", () => {
    const { root, target } = fixture();
    const native = claim(target, "native");
    observeInput(target, native, 100);
    writeFileSync(automaticBuildUsageReceiptPath(native.lease_ref), JSON.stringify({
      version: "automatic_build_usage_receipt.v1",
      source: "native",
      model: "codex-test",
      input_tokens: 120,
      cached_input_tokens: 30,
      output_tokens: 40,
      estimate: { method: "executor_estimate.v1", input_tokens: 140, output_tokens: 45 },
    }), "utf8");
    submit(root, target, native, candidate(native, { nodes: [] }), { nodes: 0 });

    const partial = claim(target, "partial");
    observeInput(target, partial, 80);
    writeFileSync(automaticBuildUsageReceiptPath(partial.lease_ref), JSON.stringify({
      version: "automatic_build_usage_receipt.v1",
      source: "executor_reported",
      input_tokens: 80,
    }), "utf8");
    failAutomaticBuildTask(target, partial.lease_ref, partial.lease.token, {
      diagnostic_code: "executor_failed",
      message: "provider unavailable",
      now: "2026-07-19T00:00:02.000Z",
    });

    const missing = claim(target, "missing");
    observeInput(target, missing, 60);
    submit(root, target, missing, candidate(missing, { nodes: [{ id: "1" }, { id: "2" }] }), { nodes: 2 });

    const invalid = claim(target, "invalid");
    writeFileSync(automaticBuildUsageReceiptPath(invalid.lease_ref), JSON.stringify({
      version: "automatic_build_usage_receipt.v1",
      source: "unavailable",
      input_tokens: 0,
    }), "utf8");
    expect(() => readAutomaticBuildUsageReceipt(invalid.lease_ref)).toThrow("unavailable usage");

    const first = writeAutomaticBuildStageMetricsSummary(target, "pass1");
    expect(first).toMatchObject({
      attempt_count: 3,
      work_unit_count: 3,
      status_counts: { committed: 2, skipped: 0, retryable_failure: 1, needs_user: 0 },
      retry_count: 1,
      usage: {
        fully_known_attempts: 1,
        partially_known_attempts: 1,
        unavailable_attempts: 1,
        known_usage_coverage: 2 / 3,
        input_tokens: 200,
        cached_input_tokens: 30,
        output_tokens: 40,
      },
      estimate: {
        methods: ["executor_estimate.v1"],
        input_tokens: 140,
        output_tokens: 45,
      },
      empty_output: { known_attempts: 2, empty_attempts: 1, rate: 0.5 },
      diagnostic_counts: { executor_failed: 1 },
    });
    expect(first.latency.writer_ms).toEqual({ p50: 250, p95: 250 });

    const summaryPath = automaticBuildStageMetricsSummaryPath(target, "pass1");
    expect(existsSync(summaryPath)).toBe(true);
    rmSync(summaryPath);
    const rebuilt = writeAutomaticBuildStageMetricsSummary(target, "pass1");
    expect(rebuilt.digest).toBe(first.digest);
  });

  it("keeps concurrent task metrics in independent attempt directories", async () => {
    const { root, target } = fixture();
    const leases = Array.from({ length: 12 }, (_, index) => claim(target, `parallel-${index}`));
    await Promise.all(leases.map(async (lease, index) => {
      observeInput(target, lease, 10 + index);
      submit(root, target, lease, candidate(lease, { nodes: [{ id: index }] }), { nodes: 1 });
    }));

    const metricPaths = leases.map((lease) => automaticBuildTaskMetricsPath(lease.lease_ref));
    expect(new Set(metricPaths).size).toBe(12);
    expect(metricPaths.every(existsSync)).toBe(true);
    expect(writeAutomaticBuildStageMetricsSummary(target, "pass1")).toMatchObject({
      attempt_count: 12,
      work_unit_count: 12,
      status_counts: { committed: 12 },
    });
  });
});
