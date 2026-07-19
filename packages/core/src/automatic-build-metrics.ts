import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutomaticBuildStage, AutomaticBuildTarget, BuildTargetRefV2 } from "./build-orchestrator";
import {
  assertActiveAutomaticBuildLease,
  readAutomaticBuildLease,
  type AutomaticBuildTaskLeaseV1,
} from "./automatic-build-lease";
import { automaticBuildTaskStoreRoot } from "./automatic-build-task-store";

export interface AutomaticBuildUsageReceiptV1 {
  version: "automatic_build_usage_receipt.v1";
  source: "native" | "executor_reported" | "unavailable";
  model?: string;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  estimate?: {
    method: string;
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AutomaticBuildInputObservationV1 {
  version: "automatic_build_input_observation.v1";
  started_at: string;
  finished_at: string;
  input_bytes: number;
}

export interface AutomaticBuildTaskMetricsV1 {
  version: "automatic_build_task_metrics.v1";
  task_ref: string;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  attempt: number;
  queue_ms: number;
  lease_wait_ms: number;
  executor_ms?: number;
  writer_ms: number;
  input_bytes: number;
  output_bytes: number;
  output_items?: number;
  status: "committed" | "skipped" | "retryable_failure" | "needs_user";
  diagnostic_code?: string;
  usage: Omit<AutomaticBuildUsageReceiptV1, "version" | "estimate">;
  estimate?: AutomaticBuildUsageReceiptV1["estimate"];
}

interface PercentilesV1 {
  p50: number | null;
  p95: number | null;
}

export interface AutomaticBuildStageMetricsSummaryV1 {
  version: "automatic_build_stage_metrics_summary.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  attempt_count: number;
  work_unit_count: number;
  status_counts: Record<AutomaticBuildTaskMetricsV1["status"], number>;
  retry_count: number;
  bytes: {
    input_total: number;
    output_total: number;
    output_average: number;
  };
  usage: {
    fully_known_attempts: number;
    partially_known_attempts: number;
    unavailable_attempts: number;
    known_usage_coverage: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
  estimate: {
    methods: string[];
    input_tokens: number;
    output_tokens: number;
  };
  latency: {
    queue_ms: PercentilesV1;
    lease_wait_ms: PercentilesV1;
    executor_ms: PercentilesV1;
    writer_ms: PercentilesV1;
  };
  empty_output: {
    known_attempts: number;
    empty_attempts: number;
    rate: number | null;
  };
  diagnostic_counts: Record<string, number>;
  digest: string;
}

export interface AutomaticBuildTerminalMetricsInput {
  status: AutomaticBuildTaskMetricsV1["status"];
  terminal_at: string;
  writer_started_at?: string;
  output_bytes?: number;
  output_items?: number;
  diagnostic_code?: string;
  usage?: AutomaticBuildUsageReceiptV1;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    if (!existsSync(file)) throw error;
    rmSync(file);
    renameSync(temp, file);
  }
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return parsed;
}

function durationMs(start: string, end: string, field: string): number {
  const duration = timestampMs(end, `${field}.end`) - timestampMs(start, `${field}.start`);
  if (duration < 0) throw new Error(`${field} must not be negative`);
  return duration;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function taskRef(lease: AutomaticBuildTaskLeaseV1): string {
  return `${lease.target_ref.book_id}:${lease.stage}:${lease.work_unit_id}:${lease.attempt}`;
}

export function automaticBuildInputObservationPath(leaseRef: string): string {
  return path.join(path.dirname(path.resolve(leaseRef)), "input-observation.json");
}

export function automaticBuildUsageReceiptPath(leaseRef: string): string {
  return path.join(path.dirname(path.resolve(leaseRef)), "usage.json");
}

export function automaticBuildTaskMetricsPath(leaseRef: string): string {
  return path.join(path.dirname(path.resolve(leaseRef)), "metrics.json");
}

export function automaticBuildStageMetricsSummaryPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): string {
  return path.join(target.workspace_dir, ".build", "automatic-build", "v2", "metrics", `${stage}.json`);
}

export function readAutomaticBuildUsageReceipt(leaseRef: string): AutomaticBuildUsageReceiptV1 {
  const file = automaticBuildUsageReceiptPath(leaseRef);
  if (!existsSync(file)) return { version: "automatic_build_usage_receipt.v1", source: "unavailable" };
  const receipt = readJson<AutomaticBuildUsageReceiptV1>(file);
  if (receipt.version !== "automatic_build_usage_receipt.v1"
    || !["native", "executor_reported", "unavailable"].includes(receipt.source)) {
    throw new Error(`invalid automatic build usage receipt: ${file}`);
  }
  const exactFields = ["input_tokens", "cached_input_tokens", "output_tokens"] as const;
  for (const field of exactFields) {
    if (receipt[field] !== undefined) nonNegativeInteger(receipt[field], `usage.${field}`);
  }
  const hasExact = exactFields.some((field) => receipt[field] !== undefined);
  if (receipt.source === "unavailable" && hasExact) {
    throw new Error("unavailable usage must omit exact token fields");
  }
  if (receipt.source !== "unavailable" && !hasExact) {
    throw new Error(`${receipt.source} usage must contain at least one exact token field`);
  }
  if (receipt.model !== undefined && (typeof receipt.model !== "string" || !receipt.model.trim())) {
    throw new Error("usage.model must be a non-empty string when provided");
  }
  if (receipt.estimate !== undefined) {
    if (typeof receipt.estimate.method !== "string" || !/(?:^|[._-])v\d+$/.test(receipt.estimate.method)) {
      throw new Error("usage.estimate.method must be a non-empty versioned method");
    }
    nonNegativeInteger(receipt.estimate.input_tokens, "usage.estimate.input_tokens");
    nonNegativeInteger(receipt.estimate.output_tokens, "usage.estimate.output_tokens");
  }
  return receipt;
}

export function recordAutomaticBuildInputObservation(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  input: Omit<AutomaticBuildInputObservationV1, "version">,
): AutomaticBuildInputObservationV1 {
  const lease = assertActiveAutomaticBuildLease(target, leaseRef, token, input.finished_at);
  durationMs(input.started_at, input.finished_at, "input_observation");
  const observation: AutomaticBuildInputObservationV1 = {
    version: "automatic_build_input_observation.v1",
    started_at: input.started_at,
    finished_at: input.finished_at,
    input_bytes: nonNegativeInteger(input.input_bytes, "input_bytes"),
  };
  const file = automaticBuildInputObservationPath(leaseRef);
  try {
    writeFileSync(file, `${JSON.stringify(observation, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return observation;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readJson<AutomaticBuildInputObservationV1>(file);
    if (existing.version !== observation.version || existing.input_bytes !== observation.input_bytes) {
      throw new Error(`input observation conflicts with the current attempt: ${taskRef(lease)}`);
    }
    return existing;
  }
}

export function persistAutomaticBuildTaskMetrics(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  terminal: AutomaticBuildTerminalMetricsInput,
): AutomaticBuildTaskMetricsV1 {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  const inputPath = automaticBuildInputObservationPath(leaseRef);
  const input = existsSync(inputPath) ? readJson<AutomaticBuildInputObservationV1>(inputPath) : undefined;
  if (input && input.version !== "automatic_build_input_observation.v1") {
    throw new Error(`invalid automatic build input observation: ${inputPath}`);
  }
  const usageReceipt = terminal.usage ?? readAutomaticBuildUsageReceipt(leaseRef);
  const executorEnd = terminal.writer_started_at ?? terminal.terminal_at;
  const metrics: AutomaticBuildTaskMetricsV1 = {
    version: "automatic_build_task_metrics.v1",
    task_ref: taskRef(lease),
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    attempt: lease.attempt,
    // V1 discovers and claims in the same `next` call; AP9 may introduce a distinct queued_at.
    queue_ms: 0,
    lease_wait_ms: durationMs(lease.issued_at, input?.started_at ?? executorEnd, "lease_wait_ms"),
    ...(input ? { executor_ms: durationMs(input.finished_at, executorEnd, "executor_ms") } : {}),
    writer_ms: terminal.writer_started_at
      ? durationMs(terminal.writer_started_at, terminal.terminal_at, "writer_ms")
      : 0,
    input_bytes: input?.input_bytes ?? 0,
    output_bytes: nonNegativeInteger(terminal.output_bytes ?? 0, "output_bytes"),
    ...(terminal.output_items !== undefined
      ? { output_items: nonNegativeInteger(terminal.output_items, "output_items") }
      : {}),
    status: terminal.status,
    ...(terminal.diagnostic_code ? { diagnostic_code: terminal.diagnostic_code } : {}),
    usage: {
      source: usageReceipt.source,
      ...(usageReceipt.model ? { model: usageReceipt.model } : {}),
      ...(usageReceipt.input_tokens !== undefined ? { input_tokens: usageReceipt.input_tokens } : {}),
      ...(usageReceipt.cached_input_tokens !== undefined ? { cached_input_tokens: usageReceipt.cached_input_tokens } : {}),
      ...(usageReceipt.output_tokens !== undefined ? { output_tokens: usageReceipt.output_tokens } : {}),
    },
    ...(usageReceipt.estimate ? { estimate: usageReceipt.estimate } : {}),
  };
  writeJsonAtomic(automaticBuildTaskMetricsPath(leaseRef), metrics);
  return metrics;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[rank - 1];
}

function percentiles(values: number[]): PercentilesV1 {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function readStageMetrics(target: AutomaticBuildTarget, stage: AutomaticBuildStage): AutomaticBuildTaskMetricsV1[] {
  const stageRoot = path.join(automaticBuildTaskStoreRoot(target), stage);
  if (!existsSync(stageRoot)) return [];
  const metrics: AutomaticBuildTaskMetricsV1[] = [];
  for (const taskEntry of readdirSync(stageRoot, { withFileTypes: true })) {
    if (!taskEntry.isDirectory()) continue;
    const attemptsRoot = path.join(stageRoot, taskEntry.name, "attempts");
    if (!existsSync(attemptsRoot)) continue;
    for (const attemptEntry of readdirSync(attemptsRoot, { withFileTypes: true })) {
      if (!attemptEntry.isDirectory()) continue;
      const file = path.join(attemptsRoot, attemptEntry.name, "metrics.json");
      if (!existsSync(file)) continue;
      const value = readJson<AutomaticBuildTaskMetricsV1>(file);
      if (value.version !== "automatic_build_task_metrics.v1" || value.stage !== stage) {
        throw new Error(`invalid automatic build task metrics: ${file}`);
      }
      metrics.push(value);
    }
  }
  return metrics.sort((left, right) => left.task_ref.localeCompare(right.task_ref));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildAutomaticBuildStageMetricsSummary(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): AutomaticBuildStageMetricsSummaryV1 {
  const metrics = readStageMetrics(target, stage);
  const statusCounts: AutomaticBuildStageMetricsSummaryV1["status_counts"] = {
    committed: 0,
    skipped: 0,
    retryable_failure: 0,
    needs_user: 0,
  };
  const diagnosticCounts: Record<string, number> = {};
  let fullyKnown = 0;
  let partiallyKnown = 0;
  let unavailable = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let estimateInput = 0;
  let estimateOutput = 0;
  const estimateMethods = new Set<string>();
  let emptyKnown = 0;
  let emptyAttempts = 0;
  for (const item of metrics) {
    statusCounts[item.status] += 1;
    if (item.diagnostic_code) diagnosticCounts[item.diagnostic_code] = (diagnosticCounts[item.diagnostic_code] ?? 0) + 1;
    const hasInput = item.usage.input_tokens !== undefined;
    const hasOutput = item.usage.output_tokens !== undefined;
    const hasAny = hasInput || hasOutput || item.usage.cached_input_tokens !== undefined;
    if (hasInput && hasOutput) fullyKnown += 1;
    else if (hasAny) partiallyKnown += 1;
    else unavailable += 1;
    inputTokens += item.usage.input_tokens ?? 0;
    cachedInputTokens += item.usage.cached_input_tokens ?? 0;
    outputTokens += item.usage.output_tokens ?? 0;
    if (item.estimate) {
      estimateMethods.add(item.estimate.method);
      estimateInput += item.estimate.input_tokens;
      estimateOutput += item.estimate.output_tokens;
    }
    if (item.status === "committed" && item.output_items !== undefined) {
      emptyKnown += 1;
      if (item.output_items === 0) emptyAttempts += 1;
    }
  }
  const core = {
    version: "automatic_build_stage_metrics_summary.v1" as const,
    target_ref: target.target_ref,
    stage,
    attempt_count: metrics.length,
    work_unit_count: new Set(metrics.map((item) => item.work_unit_id)).size,
    status_counts: statusCounts,
    retry_count: statusCounts.retryable_failure,
    bytes: {
      input_total: metrics.reduce((sum, item) => sum + item.input_bytes, 0),
      output_total: metrics.reduce((sum, item) => sum + item.output_bytes, 0),
      output_average: metrics.length
        ? metrics.reduce((sum, item) => sum + item.output_bytes, 0) / metrics.length
        : 0,
    },
    usage: {
      fully_known_attempts: fullyKnown,
      partially_known_attempts: partiallyKnown,
      unavailable_attempts: unavailable,
      known_usage_coverage: metrics.length ? (fullyKnown + partiallyKnown) / metrics.length : 0,
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
    },
    estimate: {
      methods: [...estimateMethods].sort(),
      input_tokens: estimateInput,
      output_tokens: estimateOutput,
    },
    latency: {
      queue_ms: percentiles(metrics.map((item) => item.queue_ms)),
      lease_wait_ms: percentiles(metrics.map((item) => item.lease_wait_ms)),
      executor_ms: percentiles(metrics.flatMap((item) => item.executor_ms === undefined ? [] : [item.executor_ms])),
      writer_ms: percentiles(metrics.map((item) => item.writer_ms)),
    },
    empty_output: {
      known_attempts: emptyKnown,
      empty_attempts: emptyAttempts,
      rate: emptyKnown ? emptyAttempts / emptyKnown : null,
    },
    diagnostic_counts: Object.fromEntries(Object.entries(diagnosticCounts).sort(([left], [right]) => left.localeCompare(right))),
  };
  return { ...core, digest: digest(core) };
}

export function writeAutomaticBuildStageMetricsSummary(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): AutomaticBuildStageMetricsSummaryV1 {
  const summary = buildAutomaticBuildStageMetricsSummary(target, stage);
  writeJsonAtomic(automaticBuildStageMetricsSummaryPath(target, stage), summary);
  return summary;
}
