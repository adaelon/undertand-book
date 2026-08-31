import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { failAutomaticBuildTask, submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import {
  claimAutomaticBuildTask,
  heartbeatAutomaticBuildLease,
  startAutomaticBuildLease,
} from "../src/automatic-build-lease";
import {
  automaticBuildStageMetricsSummaryPath,
  automaticBuildTaskMetricsUsageEvent,
  automaticBuildTaskMetricsPath,
  automaticBuildUsageReceiptPath,
  buildAutomaticBuildStageMetricsSummary,
  readAutomaticBuildLifecycleEvents,
  readAutomaticBuildUsageReceipt,
  recordAutomaticBuildInputObservation,
  writeAutomaticBuildStageMetricsSummary,
} from "../src/automatic-build-metrics";
import { attachBuildPlanDigest } from "../src/build-intent";
import { resolveAutomaticBuildTarget, type AutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { buildWorkUnitCost, createWorkUnitDescriptor } from "../src/stage-work-unit";

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
  startAutomaticBuildLease(target, lease.lease_ref, lease.lease.token, {
    now: "2026-07-19T00:00:00.500Z",
    run_ttl_ms: 60_000,
  });
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
  it("bridges terminal automatic metrics into a body-free plan cost event", () => {
    const plan = attachBuildPlanDigest({
      version: "build_plan.v1",
      plan_id: "plan-standard",
      revision: 1,
      book_id: "metrics-book",
      source_fingerprint: "source-a",
      content_profile: { id: "technical_learning", version: "technical_learning_v0" },
      recipe_id: "standard_deep",
      public_stage_closure: ["pass1"],
      private_artifacts: [],
      reuse: [],
      create: ["public.foundation"],
      excluded: [],
      estimate: {
        input_tokens: { lower: 10, upper: 20, coverage: 1 },
        output_tokens: { lower: 5, upper: 10, coverage: 1 },
        wall_clock_minutes: { confidence: "none" },
        unknown_stages: [],
        historical_match: { stage: false, policy: false, model: false, harness: false, sample_count: 0 },
      },
      budget: { on_exceed: "needs_user" },
      status: "confirmed",
      confirmation_source: "reader_ui",
      created_at: "2026-07-26T07:59:00.000Z",
      confirmed_at: "2026-07-26T07:59:30.000Z",
    });
    const metrics = {
      version: "automatic_build_task_metrics.v1" as const,
      task_ref: "pass1/task-1/attempt-2",
      stage: "pass1" as const,
      work_unit_id: "task-1",
      attempt: 2,
      queue_ms: 5,
      lease_wait_ms: 10,
      executor_ms: 20,
      writer_ms: 4,
      input_bytes: 100,
      output_bytes: 20,
      status: "retryable_failure" as const,
      diagnostic_code: "provider_failed",
      usage: {
        source: "executor_reported" as const,
        model: "private-model-detail",
        reasoning_effort: "high",
        harness_release: "harness-private-detail",
        input_tokens: 30,
        output_tokens: 9,
      },
      estimate: { method: "executor_estimate.v1", input_tokens: 35, output_tokens: 10 },
    };
    const event = automaticBuildTaskMetricsUsageEvent({
      plan,
      metrics,
      occurred_at: "2026-07-26T08:00:00.000Z",
    });
    expect(event).toMatchObject({
      mode: "standard_deep",
      kind: "cost_observed",
      plan: {
        plan_id: "plan-standard",
        plan_revision: 1,
        confirmation_source: "reader_ui",
      },
      outcome: "retryable_failure",
      wall_clock_ms: 39,
      usage: {
        source: "executor_reported",
        input_tokens: 30,
        output_tokens: 9,
        estimate_method: "executor_estimate.v1",
        estimated_input_tokens: 35,
        estimated_output_tokens: 10,
      },
    });
    expect(JSON.stringify(event)).not.toMatch(
      /private-model-detail|harness-private-detail|task_ref|work_unit_id|plan_digest/u,
    );
    expect(automaticBuildTaskMetricsUsageEvent({
      plan,
      metrics: { ...metrics, status: "skipped" },
      occurred_at: "2026-07-26T08:00:00.000Z",
    })).toBeNull();
  });

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
      reasoning_effort: "high",
      harness_release: "codex-2026.07",
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
    rmSync(path.dirname(invalid.lease_ref), { recursive: true });

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
      failure_phase_counts: {
        input_delivery: 0,
        generation: 1,
        candidate_sink: 0,
        artifact_writer: 0,
        legacy_unclassified: 0,
      },
    });
    expect(first.latency.writer_ms).toEqual({ p50: 250, p95: 250 });
    expect(first.phase_latency).toMatchObject({
      dispatch_wait_ms: { p50: null, p95: null, observed_attempts: 0, unavailable_attempts: 3 },
      reserve_wait_ms: { p50: 500, p95: 500, observed_attempts: 3, unavailable_attempts: 0 },
      running_executor_ms: { p50: 2_500, p95: 2_500, observed_attempts: 3, unavailable_attempts: 0 },
      writer_ms: { p50: 250, p95: 250, observed_attempts: 2, unavailable_attempts: 1 },
      unobserved_interval_ms: { p50: 0, p95: 0, observed_attempts: 3, unavailable_attempts: 0 },
    });
    expect(first.provenance).toMatchObject({
      model: { known_attempts: 1, unavailable_attempts: 2, coverage: 1 / 3, values: ["codex-test"] },
      reasoning_effort: { known_attempts: 1, unavailable_attempts: 2, coverage: 1 / 3, values: ["high"] },
      harness_release: { known_attempts: 1, unavailable_attempts: 2, coverage: 1 / 3, values: ["codex-2026.07"] },
    });

    const summaryPath = automaticBuildStageMetricsSummaryPath(target, "pass1");
    expect(existsSync(summaryPath)).toBe(true);
    rmSync(summaryPath);
    const rebuilt = writeAutomaticBuildStageMetricsSummary(target, "pass1");
    expect(rebuilt.digest).toBe(first.digest);
  });

  it("rebuilds attempts and all terminal failures from the canonical file union without metrics", () => {
    const { target } = fixture();
    const expired = claim(target, "expired-without-metrics");
    for (let index = 0; index < 10; index += 1) {
      const failed = claim(target, `failure-${index}`);
      startAutomaticBuildLease(target, failed.lease_ref, failed.lease.token, {
        now: "2026-07-19T00:00:00.100Z",
        run_ttl_ms: 60_000,
      });
      failAutomaticBuildTask(target, failed.lease_ref, failed.lease.token, {
        diagnostic_code: "executor_failed",
        message: `failure ${index}`,
        now: "2026-07-19T00:00:01.000Z",
      });
      rmSync(automaticBuildTaskMetricsPath(failed.lease_ref));
    }

    const summary = buildAutomaticBuildStageMetricsSummary(target, "pass1", {
      now: "2026-07-19T00:01:00.000Z",
    });
    expect(summary).toMatchObject({
      attempt_count: 11,
      work_unit_count: 11,
      status_counts: { committed: 0, skipped: 0, retryable_failure: 10, needs_user: 0 },
      retry_count: 10,
      lifecycle_counts: {
        lease_issued: 11,
        lease_expired: 1,
        executor_started: 10,
        task_failed: 10,
        task_committed: 0,
      },
      execution_counts: {
        physical_attempts: 11,
        semantic_attempts: 11,
        lease_epochs: 11,
        submit_revisions: 0,
      },
    });
    expect(summary.diagnostic_counts).toEqual({ executor_failed: 10 });
    const events = readAutomaticBuildLifecycleEvents(target, "pass1", {
      now: "2026-07-19T00:01:00.000Z",
    });
    expect(events.filter((event) => event.kind === "lease_reserved")).toHaveLength(11);
    expect(events.filter((event) => event.kind === "lease_expired")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "task_failed")).toHaveLength(10);
    expect(events.find((event) => event.kind === "lease_expired")).toMatchObject({
      work_unit_id: expired.lease.work_unit_id,
      execution_identity: { semantic_attempt: 1, lease_epoch: 1, submit_revision: 0 },
    });
  });

  it("projects generation and writer failures into distinct lifecycle and stage phase metrics", () => {
    const { root, target } = fixture();
    const generation = claim(target, "generation-phase");
    observeInput(target, generation, 20);
    const generationReceipt = failAutomaticBuildTask(
      target,
      generation.lease_ref,
      generation.lease.token,
      {
        diagnostic_code: "provider_timeout",
        now: "2026-07-19T00:00:02.000Z",
      },
    );
    expect(generationReceipt.metrics).toMatchObject({
      writer_started: false,
      failure_phase: "generation",
    });

    const writer = claim(target, "writer-phase");
    observeInput(target, writer, 30);
    const writerReceipt = submitAutomaticBuildCandidate(
      target,
      writer.lease_ref,
      writer.lease.token,
      candidate(writer, { nodes: [] }),
      () => { throw new Error(`PRIVATE_WRITER_FAILURE at ${root}`); },
      {
        now: "2026-07-19T00:00:03.000Z",
        completed_at: "2026-07-19T00:00:03.250Z",
      },
    );
    expect(writerReceipt.metrics).toMatchObject({
      writer_started: true,
      failure_phase: "artifact_writer",
    });

    const events = readAutomaticBuildLifecycleEvents(target, "pass1");
    expect(events.filter((event) => event.kind === "task_failed")).toContainEqual(expect.objectContaining({
      work_unit_id: "generation-phase",
      diagnostic_code: "provider_timeout",
      failure_phase: "generation",
    }));
    expect(events.filter((event) => event.kind === "writer_failed")).toContainEqual(expect.objectContaining({
      work_unit_id: "writer-phase",
      diagnostic_code: "writer_failed",
      failure_phase: "artifact_writer",
    }));
    expect(buildAutomaticBuildStageMetricsSummary(target, "pass1")).toMatchObject({
      failure_phase_counts: {
        input_delivery: 0,
        generation: 1,
        candidate_sink: 0,
        artifact_writer: 1,
        legacy_unclassified: 0,
      },
    });
  });

  it("keeps every running heartbeat as an append-only lifecycle observation", () => {
    const { target } = fixture();
    const leased = claim(target, "heartbeat-history");
    startAutomaticBuildLease(target, leased.lease_ref, leased.lease.token, {
      now: "2026-07-19T00:00:00.100Z",
      run_ttl_ms: 60_000,
    });
    heartbeatAutomaticBuildLease(target, leased.lease_ref, leased.lease.token, {
      now: "2026-07-19T00:00:01.000Z",
      ttl_ms: 60_000,
    });
    heartbeatAutomaticBuildLease(target, leased.lease_ref, leased.lease.token, {
      now: "2026-07-19T00:00:02.000Z",
      ttl_ms: 60_000,
    });
    const summary = buildAutomaticBuildStageMetricsSummary(target, "pass1", {
      now: "2026-07-19T00:00:03.000Z",
    });
    expect(summary.lifecycle_counts.heartbeat).toBe(2);
    expect(readAutomaticBuildLifecycleEvents(target, "pass1", {
      now: "2026-07-19T00:00:03.000Z",
    }).filter((event) => event.kind === "heartbeat").map((event) => event.observed_at)).toEqual([
      "2026-07-19T00:00:01.000Z",
      "2026-07-19T00:00:02.000Z",
    ]);
  });

  it("emits matched performance samples only when descriptor and full executor provenance are proven", () => {
    const { root, target } = fixture();
    const leased = claim(target, "performance-history");
    observeInput(target, leased, 100);
    writeFileSync(automaticBuildUsageReceiptPath(leased.lease_ref), JSON.stringify({
      version: "automatic_build_usage_receipt.v1",
      source: "native",
      model: "codex-luna-high",
      reasoning_effort: "high",
      harness_release: "codex-2026.07",
      input_tokens: 100,
      output_tokens: 20,
    }), "utf8");
    submit(root, target, leased, candidate(leased, { nodes: [{ id: "1" }] }), { nodes: 1 });
    const descriptor = createWorkUnitDescriptor({
      target: target.target_ref,
      stage: "pass1",
      work_unit_id: "performance-history",
      kind: "pass1_window",
      input_hash: "a".repeat(64),
      policy_fingerprint: automaticBuildExtractionPolicy(
        "pass1",
        resolveContentProfile("technical_learning"),
        "full",
      ),
      evidence_lids: ["1.1"],
      cost: buildWorkUnitCost({ estimated_input_tokens: 100, visible_lids: 1, expected_output_items: 1 }),
    });
    const summary = buildAutomaticBuildStageMetricsSummary(target, "pass1", {
      now: "2026-07-19T00:00:04.000Z",
      work_units: [descriptor],
    });
    expect(summary.performance_history).toMatchObject({
      version: "automatic_build_performance_history.v1",
      lease_count: 1,
      semantic_attempt_count: 1,
      samples: [{
        stage: "pass1",
        kind: "pass1_window",
        router_version: descriptor.policy_fingerprint.router_version,
        model: "codex-luna-high",
        reasoning_effort: "high",
        harness_release: "codex-2026.07",
        service_ms: 2_750,
      }],
    });
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
