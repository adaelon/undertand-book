import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalBuildJson, validateBuildPlanV1, type BuildPlanV1 } from "./build-intent";
import type { AutomaticBuildStage, AutomaticBuildTarget, BuildTargetRefV2 } from "./build-orchestrator";
import {
  buildPlanUsageRef,
  validateIntentBuildUsageEventV1,
  type IntentBuildUsageEventV1,
} from "./intent-build-metrics";
import {
  assertActiveAutomaticBuildLease,
  automaticBuildTaskPolicyBindingFromLease,
  readAutomaticBuildLease,
  type AutomaticBuildTaskHeartbeatV1,
  type AutomaticBuildTaskLease,
  type AutomaticBuildTaskStartV1,
} from "./automatic-build-lease";
import {
  listAutomaticBuildStoredAttempts,
  type AutomaticBuildExecutionIdentity,
  type AutomaticBuildStoredAttemptV1,
} from "./automatic-build-task-store";
import type { WorkUnitDescriptor, WorkUnitKind } from "./stage-work-unit";
import {
  legacyAutomaticBuildFailureDiagnostic,
  validateAutomaticBuildFailureDiagnostic,
  type AutomaticBuildFailureDiagnosticV2,
} from "./extractor-contract";

export interface AutomaticBuildUsageReceiptV1 {
  version: "automatic_build_usage_receipt.v1";
  source: "native" | "executor_reported" | "unavailable";
  model?: string;
  reasoning_effort?: string;
  harness_release?: string;
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

export interface AutomaticBuildInputObservationV2 {
  version: "automatic_build_input_observation.v2";
  started_at: string;
  finished_at: string;
  input_bytes: number;
  input_sha256: string;
  proof_digest: string;
  render_contract_version: string;
}

export type AutomaticBuildInputObservation =
  | AutomaticBuildInputObservationV1
  | AutomaticBuildInputObservationV2;

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

interface ObservedPercentilesV1 extends PercentilesV1 {
  observed_attempts: number;
  unavailable_attempts: number;
}

interface ProvenanceDimensionSummaryV1 {
  known_attempts: number;
  unavailable_attempts: number;
  coverage: number;
  values: string[];
}

export type AutomaticBuildLifecycleEventKind =
  | "lease_reserved"
  | "executor_started"
  | "heartbeat"
  | "input_finished"
  | "candidate_submitted"
  | "writer_failed"
  | "task_failed"
  | "task_committed"
  | "lease_expired";

export interface AutomaticBuildLifecycleEventV1 {
  version: "automatic_build_lifecycle_event.v1";
  kind: AutomaticBuildLifecycleEventKind;
  task_ref: string;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  execution_identity?: AutomaticBuildExecutionIdentity;
  observed_at: string;
  diagnostic_code?: string;
  submit_revision?: number;
  provenance: {
    model: string;
    reasoning_effort: string;
    harness_release: string;
  };
}

export interface AutomaticBuildPerformanceSampleV1 {
  sample_id: string;
  stage: AutomaticBuildStage;
  kind: WorkUnitKind;
  router_version: string;
  model: string;
  reasoning_effort: string;
  harness_release: string;
  service_ms: number;
}

export interface AutomaticBuildPerformanceHistoryV1 {
  version: "automatic_build_performance_history.v1";
  revision_digest?: string;
  samples: AutomaticBuildPerformanceSampleV1[];
  lease_count: number;
  semantic_attempt_count: number;
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
  lifecycle_counts: {
    lease_issued: number;
    lease_expired: number;
    executor_started: number;
    heartbeat: number;
    input_finished: number;
    candidate_submitted: number;
    writer_failed: number;
    task_failed: number;
    task_committed: number;
  };
  execution_counts: {
    physical_attempts: number;
    semantic_attempts: number;
    lease_epochs: number;
    submit_revisions: number;
  };
  phase_latency: {
    dispatch_wait_ms: ObservedPercentilesV1;
    reserve_wait_ms: ObservedPercentilesV1;
    running_executor_ms: ObservedPercentilesV1;
    writer_ms: ObservedPercentilesV1;
    unobserved_interval_ms: ObservedPercentilesV1;
  };
  provenance: {
    model: ProvenanceDimensionSummaryV1;
    reasoning_effort: ProvenanceDimensionSummaryV1;
    harness_release: ProvenanceDimensionSummaryV1;
  };
  performance_history: AutomaticBuildPerformanceHistoryV1;
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

export function automaticBuildTaskMetricsUsageEvent(input: {
  plan: BuildPlanV1;
  metrics: AutomaticBuildTaskMetricsV1;
  occurred_at: string;
}): IntentBuildUsageEventV1 | null {
  if (input.metrics.status === "skipped") return null;
  const plan = validateBuildPlanV1(input.plan);
  const identity = createHash("sha256").update(canonicalBuildJson({
    plan_digest: plan.plan_digest,
    task_ref: input.metrics.task_ref,
    stage: input.metrics.stage,
    work_unit_id: input.metrics.work_unit_id,
    attempt: input.metrics.attempt,
  }), "utf8").digest("hex").slice(0, 32);
  return validateIntentBuildUsageEventV1({
    version: "intent_build_usage_event.v1",
    event_id: `automatic-cost-${identity}`,
    book_id: plan.book_id,
    mode: plan.recipe_id,
    occurred_at: input.occurred_at,
    kind: "cost_observed",
    plan: buildPlanUsageRef(plan),
    attempt_id: `automatic-attempt-${identity}`,
    outcome: input.metrics.status,
    wall_clock_ms: input.metrics.queue_ms
      + input.metrics.lease_wait_ms
      + (input.metrics.executor_ms ?? 0)
      + input.metrics.writer_ms,
    usage: {
      source: input.metrics.usage.source,
      ...(input.metrics.usage.input_tokens === undefined
        ? {}
        : { input_tokens: input.metrics.usage.input_tokens }),
      ...(input.metrics.usage.cached_input_tokens === undefined
        ? {}
        : { cached_input_tokens: input.metrics.usage.cached_input_tokens }),
      ...(input.metrics.usage.output_tokens === undefined
        ? {}
        : { output_tokens: input.metrics.usage.output_tokens }),
      ...(input.metrics.estimate === undefined
        ? {}
        : {
            estimate_method: input.metrics.estimate.method,
            estimated_input_tokens: input.metrics.estimate.input_tokens,
            estimated_output_tokens: input.metrics.estimate.output_tokens,
          }),
    },
  });
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

function taskRef(lease: AutomaticBuildTaskLease): string {
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
  for (const field of ["reasoning_effort", "harness_release"] as const) {
    if (receipt[field] !== undefined && (typeof receipt[field] !== "string" || !receipt[field]!.trim())) {
      throw new Error(`usage.${field} must be a non-empty string when provided`);
    }
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
  input: Omit<AutomaticBuildInputObservationV1, "version"> & {
    input_sha256?: string;
    proof_digest?: string;
    render_contract_version?: string;
  },
): AutomaticBuildInputObservation {
  const lease = assertActiveAutomaticBuildLease(target, leaseRef, token, input.finished_at);
  durationMs(input.started_at, input.finished_at, "input_observation");
  const binding = automaticBuildTaskPolicyBindingFromLease(lease);
  const isV3 = binding !== undefined && "proof_digest" in binding;
  if (isV3) {
    if (!input.input_sha256 || !input.proof_digest || !input.render_contract_version) {
      throw new Error("v3 input observation requires input hash, proof digest, and render contract version");
    }
    if (!/^[a-f0-9]{64}$/.test(input.input_sha256)
      || !/^[a-f0-9]{64}$/.test(input.proof_digest)) {
      throw new Error("v3 input observation hashes must be lowercase SHA-256 digests");
    }
    if (input.input_sha256 !== binding.input_hash || input.proof_digest !== binding.proof_digest) {
      throw new Error("v3 input observation drifted from the leased task binding");
    }
  } else if (input.input_sha256 !== undefined || input.proof_digest !== undefined
    || input.render_contract_version !== undefined) {
    throw new Error("v2 input observation cannot add v3 proof fields");
  }
  const observation: AutomaticBuildInputObservation = isV3
    ? {
        version: "automatic_build_input_observation.v2",
        started_at: input.started_at,
        finished_at: input.finished_at,
        input_bytes: nonNegativeInteger(input.input_bytes, "input_bytes"),
        input_sha256: input.input_sha256!,
        proof_digest: input.proof_digest!,
        render_contract_version: input.render_contract_version!,
      }
    : {
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
    const existing = readAutomaticBuildInputObservation(leaseRef)!;
    const sameInputIdentity = existing.version === observation.version
      && existing.input_bytes === observation.input_bytes
      && (existing.version === "automatic_build_input_observation.v1"
        || (observation.version === "automatic_build_input_observation.v2"
          && existing.input_sha256 === observation.input_sha256
          && existing.proof_digest === observation.proof_digest
          && existing.render_contract_version === observation.render_contract_version));
    if (!sameInputIdentity) {
      throw new Error(`input observation conflicts with the current attempt: ${taskRef(lease)}`);
    }
    return existing;
  }
}

export function readAutomaticBuildInputObservation(
  leaseRef: string,
): AutomaticBuildInputObservation | undefined {
  const file = automaticBuildInputObservationPath(leaseRef);
  if (!existsSync(file)) return undefined;
  const input = readJson<AutomaticBuildInputObservation>(file);
  if (!(input.version === "automatic_build_input_observation.v1"
    || input.version === "automatic_build_input_observation.v2")) {
    throw new Error(`invalid automatic build input observation: ${file}`);
  }
  durationMs(input.started_at, input.finished_at, "input_observation");
  nonNegativeInteger(input.input_bytes, "input_bytes");
  if (input.version === "automatic_build_input_observation.v2") {
    if (!/^[a-f0-9]{64}$/.test(input.input_sha256)
      || !/^[a-f0-9]{64}$/.test(input.proof_digest)
      || !input.render_contract_version
      || Buffer.byteLength(input.render_contract_version, "utf8") > 256) {
      throw new Error(`invalid automatic build v2 input observation: ${file}`);
    }
  }
  return input;
}

export function persistAutomaticBuildTaskMetrics(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  terminal: AutomaticBuildTerminalMetricsInput,
): AutomaticBuildTaskMetricsV1 {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  const input = readAutomaticBuildInputObservation(leaseRef);
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
      model: usageReceipt.model ?? "unavailable",
      reasoning_effort: usageReceipt.reasoning_effort ?? "unavailable",
      harness_release: usageReceipt.harness_release ?? "unavailable",
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

interface AutomaticBuildSubmissionV1 {
  version: "automatic_build_submission.v1";
  started_at: string;
}

interface AutomaticBuildTerminalRecord {
  version?: "automatic_build_task_receipt.v1" | "automatic_build_task_receipt.v2";
  state?: "committed" | "retryable_failure";
  diagnostic_code?: string;
  failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
  committed_at?: string;
  failed_at?: string;
}

interface AutomaticBuildAttemptResult {
  version: "automatic_build_attempt_event.v2" | "automatic_build_attempt_event.v3";
  outcome: "failure" | "success" | "reset";
  diagnostic?: string;
  failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
  created_at: string;
}

function terminalDiagnosticCode(record: AutomaticBuildTerminalRecord | undefined): string | undefined {
  if (!record || record.state !== "retryable_failure") return undefined;
  if (record.version === "automatic_build_task_receipt.v2") {
    return record.failure_diagnostic
      ? validateAutomaticBuildFailureDiagnostic(record.failure_diagnostic).code
      : undefined;
  }
  if (record.version === "automatic_build_task_receipt.v1") {
    return legacyAutomaticBuildFailureDiagnostic().code;
  }
  return record.failure_diagnostic
    ? validateAutomaticBuildFailureDiagnostic(record.failure_diagnostic).code
    : record.diagnostic_code;
}

function attemptResultDiagnosticCode(result: AutomaticBuildAttemptResult | undefined): string | undefined {
  if (!result || result.outcome !== "failure") return undefined;
  if (result.version === "automatic_build_attempt_event.v3") {
    return result.failure_diagnostic
      ? validateAutomaticBuildFailureDiagnostic(result.failure_diagnostic).code
      : undefined;
  }
  return legacyAutomaticBuildFailureDiagnostic().code;
}

interface AutomaticBuildSubmitRevisionRecord {
  version: "automatic_build_submit_revision.v1";
  submit_revision: number;
  created_at: string;
}

interface AutomaticBuildAttemptFacts {
  stored: AutomaticBuildStoredAttemptV1;
  lease?: AutomaticBuildTaskLease;
  start?: AutomaticBuildTaskStartV1;
  heartbeat?: AutomaticBuildTaskHeartbeatV1;
  heartbeats: AutomaticBuildTaskHeartbeatV1[];
  input?: AutomaticBuildInputObservation;
  submission?: AutomaticBuildSubmissionV1;
  failure?: AutomaticBuildTerminalRecord;
  receipt?: AutomaticBuildTerminalRecord;
  result?: AutomaticBuildAttemptResult;
  metrics?: AutomaticBuildTaskMetricsV1;
  submit_revisions: AutomaticBuildSubmitRevisionRecord[];
  usage: AutomaticBuildUsageReceiptV1;
}

function readOptionalJson<T>(dir: string, name: string): T | undefined {
  const file = path.join(dir, name);
  return existsSync(file) ? readJson<T>(file) : undefined;
}

function usageFromMetrics(metrics: AutomaticBuildTaskMetricsV1): AutomaticBuildUsageReceiptV1 {
  return {
    version: "automatic_build_usage_receipt.v1",
    source: metrics.usage.source,
    ...(metrics.usage.model && metrics.usage.model !== "unavailable" ? { model: metrics.usage.model } : {}),
    ...(metrics.usage.reasoning_effort && metrics.usage.reasoning_effort !== "unavailable"
      ? { reasoning_effort: metrics.usage.reasoning_effort }
      : {}),
    ...(metrics.usage.harness_release && metrics.usage.harness_release !== "unavailable"
      ? { harness_release: metrics.usage.harness_release }
      : {}),
    ...(metrics.usage.input_tokens !== undefined ? { input_tokens: metrics.usage.input_tokens } : {}),
    ...(metrics.usage.cached_input_tokens !== undefined ? { cached_input_tokens: metrics.usage.cached_input_tokens } : {}),
    ...(metrics.usage.output_tokens !== undefined ? { output_tokens: metrics.usage.output_tokens } : {}),
    ...(metrics.estimate ? { estimate: metrics.estimate } : {}),
  };
}

function readAttemptFacts(target: AutomaticBuildTarget, stage: AutomaticBuildStage): AutomaticBuildAttemptFacts[] {
  return listAutomaticBuildStoredAttempts(target, stage).map((stored) => {
    const lease = readOptionalJson<AutomaticBuildTaskLease>(stored.attempt_dir, "lease.json");
    if (lease && (!(["automatic_build_task_lease.v1", "automatic_build_task_lease.v2"] as string[])
      .includes(lease.version) || lease.stage !== stage || lease.work_unit_id !== stored.work_unit_id
      || lease.attempt !== stored.physical_attempt)) {
      throw new Error(`invalid automatic build lease metrics source: ${stored.attempt_dir}`);
    }
    if (lease) automaticBuildTaskPolicyBindingFromLease(lease);
    const metrics = readOptionalJson<AutomaticBuildTaskMetricsV1>(stored.attempt_dir, "metrics.json");
    if (metrics && (metrics.version !== "automatic_build_task_metrics.v1" || metrics.stage !== stage
      || metrics.work_unit_id !== stored.work_unit_id || metrics.attempt !== stored.physical_attempt)) {
      throw new Error(`invalid automatic build task metrics: ${stored.attempt_dir}`);
    }
    const revisionsDir = path.join(stored.attempt_dir, "submit-revisions");
    const submitRevisions = existsSync(revisionsDir)
      ? readdirSync(revisionsDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
          .map((entry) => readJson<AutomaticBuildSubmitRevisionRecord>(path.join(revisionsDir, entry.name)))
          .sort((left, right) => left.submit_revision - right.submit_revision)
      : [];
    for (const revision of submitRevisions) {
      if (revision.version !== "automatic_build_submit_revision.v1"
        || !Number.isSafeInteger(revision.submit_revision) || revision.submit_revision < 1) {
        throw new Error(`invalid automatic build submit revision metrics source: ${revisionsDir}`);
      }
    }
    const start = readOptionalJson<AutomaticBuildTaskStartV1>(stored.attempt_dir, "start.json");
    const heartbeat = readOptionalJson<AutomaticBuildTaskHeartbeatV1>(stored.attempt_dir, "heartbeat.json");
    const heartbeatHistoryDir = path.join(stored.attempt_dir, "heartbeats");
    const heartbeatHistory = existsSync(heartbeatHistoryDir)
      ? readdirSync(heartbeatHistoryDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => readJson<AutomaticBuildTaskHeartbeatV1>(path.join(heartbeatHistoryDir, entry.name)))
      : [];
    const heartbeats = [...heartbeatHistory,
      ...(heartbeat && !heartbeatHistory.some((item) => item.updated_at === heartbeat.updated_at
        && item.expires_at === heartbeat.expires_at && item.lease_token === heartbeat.lease_token)
        ? [heartbeat]
        : []),
    ].sort((left, right) => timestampMs(left.updated_at, "heartbeat.updated_at")
      - timestampMs(right.updated_at, "heartbeat.updated_at"));
    const input = readAutomaticBuildInputObservation(path.join(stored.attempt_dir, "lease.json"));
    const submission = readOptionalJson<AutomaticBuildSubmissionV1>(stored.attempt_dir, "submission.json");
    const failure = readOptionalJson<AutomaticBuildTerminalRecord>(stored.attempt_dir, "failure.json");
    const receipt = readOptionalJson<AutomaticBuildTerminalRecord>(stored.attempt_dir, "receipt.json");
    const result = readOptionalJson<AutomaticBuildAttemptResult>(stored.attempt_dir, "result.json");
    const usage = metrics ? usageFromMetrics(metrics) : readAutomaticBuildUsageReceipt(path.join(stored.attempt_dir, "lease.json"));
    return {
      stored,
      ...(lease ? { lease } : {}),
      ...(start ? { start } : {}),
      ...(heartbeat ? { heartbeat } : {}),
      heartbeats,
      ...(input ? { input } : {}),
      ...(submission ? { submission } : {}),
      ...(failure ? { failure } : {}),
      ...(receipt ? { receipt } : {}),
      ...(result ? { result } : {}),
      ...(metrics ? { metrics } : {}),
      submit_revisions: submitRevisions,
      usage,
    };
  });
}

function attemptTaskRef(target: AutomaticBuildTarget, facts: AutomaticBuildAttemptFacts): string {
  return facts.lease
    ? taskRef(facts.lease)
    : `${target.book_id}:${facts.stored.stage}:${facts.stored.work_unit_id}:${facts.stored.physical_attempt}`;
}

function provenanceFor(facts: AutomaticBuildAttemptFacts): AutomaticBuildLifecycleEventV1["provenance"] {
  return {
    model: facts.usage.model ?? "unavailable",
    reasoning_effort: facts.usage.reasoning_effort ?? "unavailable",
    harness_release: facts.usage.harness_release ?? "unavailable",
  };
}

function attemptExpiry(facts: AutomaticBuildAttemptFacts): string | undefined {
  if (!facts.lease) return undefined;
  if (facts.heartbeat && facts.start) return facts.heartbeat.expires_at;
  if (facts.start) return facts.start.run_expires_at;
  return facts.lease.version === "automatic_build_task_lease.v2"
    ? facts.lease.reserve_expires_at
    : facts.lease.expires_at;
}

function terminalAt(facts: AutomaticBuildAttemptFacts): string | undefined {
  return facts.receipt?.committed_at
    ?? facts.failure?.failed_at
    ?? facts.result?.created_at;
}

function isExpired(facts: AutomaticBuildAttemptFacts, now: string): boolean {
  const expiry = attemptExpiry(facts);
  return Boolean(expiry && !terminalAt(facts) && timestampMs(now, "now") >= timestampMs(expiry!, "lease_expiry"));
}

export function readAutomaticBuildLifecycleEvents(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  options: { now?: string } = {},
): AutomaticBuildLifecycleEventV1[] {
  const now = options.now ?? new Date().toISOString();
  timestampMs(now, "now");
  const events: AutomaticBuildLifecycleEventV1[] = [];
  for (const facts of readAttemptFacts(target, stage)) {
    const common = {
      version: "automatic_build_lifecycle_event.v1" as const,
      task_ref: attemptTaskRef(target, facts),
      stage,
      work_unit_id: facts.stored.work_unit_id,
      physical_attempt: facts.stored.physical_attempt,
      ...(facts.stored.execution_identity ? { execution_identity: facts.stored.execution_identity } : {}),
      provenance: provenanceFor(facts),
    };
    const add = (kind: AutomaticBuildLifecycleEventKind, observedAt: string, extra: Partial<AutomaticBuildLifecycleEventV1> = {}) => {
      events.push({ ...common, kind, observed_at: observedAt, ...extra });
    };
    if (facts.lease) add("lease_reserved", facts.lease.version === "automatic_build_task_lease.v2"
      ? facts.lease.reserved_at : facts.lease.issued_at);
    if (facts.start) add("executor_started", facts.start.started_at);
    for (const heartbeat of facts.heartbeats) add("heartbeat", heartbeat.updated_at);
    if (facts.input) add("input_finished", facts.input.finished_at);
    if (facts.submit_revisions.length) {
      for (const revision of facts.submit_revisions) {
        add("candidate_submitted", revision.created_at, { submit_revision: revision.submit_revision });
      }
    } else if (facts.submission) {
      add("candidate_submitted", facts.submission.started_at);
    }
    if (facts.failure) {
      const diagnosticCode = terminalDiagnosticCode(facts.failure);
      add(diagnosticCode === "writer_failed" ? "writer_failed" : "task_failed",
        facts.failure.failed_at ?? terminalAt(facts)!,
        diagnosticCode ? { diagnostic_code: diagnosticCode } : {});
    } else if (facts.result?.outcome === "failure") {
      const diagnosticCode = attemptResultDiagnosticCode(facts.result);
      add("task_failed", facts.result.created_at,
        diagnosticCode ? { diagnostic_code: diagnosticCode } : {});
    }
    if (facts.receipt?.committed_at) add("task_committed", facts.receipt.committed_at);
    else if (facts.result?.outcome === "success") add("task_committed", facts.result.created_at);
    if (isExpired(facts, now)) add("lease_expired", attemptExpiry(facts)!);
  }
  return events.sort((left, right) => timestampMs(left.observed_at, "lifecycle.observed_at")
    - timestampMs(right.observed_at, "lifecycle.observed_at")
    || left.task_ref.localeCompare(right.task_ref)
    || left.kind.localeCompare(right.kind)
    || (left.submit_revision ?? 0) - (right.submit_revision ?? 0));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function observedPercentiles(values: number[], attemptCount: number): ObservedPercentilesV1 {
  return {
    ...percentiles(values),
    observed_attempts: values.length,
    unavailable_attempts: attemptCount - values.length,
  };
}

function provenanceDimension(values: Array<string | undefined>): ProvenanceDimensionSummaryV1 {
  const known = values.filter((value): value is string => Boolean(value && value !== "unavailable"));
  return {
    known_attempts: known.length,
    unavailable_attempts: values.length - known.length,
    coverage: values.length ? known.length / values.length : 0,
    values: [...new Set(known)].sort(),
  };
}

function buildPerformanceHistory(
  target: AutomaticBuildTarget,
  attempts: AutomaticBuildAttemptFacts[],
  workUnits: WorkUnitDescriptor[],
): AutomaticBuildPerformanceHistoryV1 {
  const descriptors = new Map(workUnits.map((unit) => [unit.work_unit_id, unit]));
  const samples: AutomaticBuildPerformanceSampleV1[] = [];
  for (const attempt of attempts) {
    const descriptor = descriptors.get(attempt.stored.work_unit_id);
    const end = terminalAt(attempt);
    const provenance = provenanceFor(attempt);
    if (!descriptor || !attempt.start || !end
      || Object.values(provenance).some((value) => value === "unavailable")) continue;
    samples.push({
      sample_id: attemptTaskRef(target, attempt),
      stage: attempt.stored.stage,
      kind: descriptor.kind,
      router_version: descriptor.policy_fingerprint.router_version,
      model: provenance.model,
      reasoning_effort: provenance.reasoning_effort,
      harness_release: provenance.harness_release,
      service_ms: durationMs(attempt.start.started_at, end, "performance.service_ms"),
    });
  }
  samples.sort((left, right) => left.stage.localeCompare(right.stage)
    || left.kind.localeCompare(right.kind)
    || left.sample_id.localeCompare(right.sample_id));
  const semanticAttempts = new Set(attempts.flatMap((attempt) => attempt.stored.execution_identity
    ? [`${attempt.stored.work_unit_id}:${attempt.stored.execution_identity.semantic_attempt}`]
    : [])).size;
  const identity = {
    version: "automatic_build_performance_history.v1" as const,
    samples,
    lease_count: attempts.filter((attempt) => attempt.lease).length,
    semantic_attempt_count: semanticAttempts,
  };
  return { ...identity, revision_digest: digest(identity) };
}

export function buildAutomaticBuildStageMetricsSummary(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  options: { now?: string; work_units?: WorkUnitDescriptor[] } = {},
): AutomaticBuildStageMetricsSummaryV1 {
  const now = options.now ?? new Date().toISOString();
  timestampMs(now, "now");
  const attempts = readAttemptFacts(target, stage);
  const metrics = attempts.flatMap((attempt) => attempt.metrics ? [attempt.metrics] : []);
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
  for (const attempt of attempts) {
    const committed = attempt.receipt?.state === "committed"
      || attempt.result?.outcome === "success"
      || (!attempt.receipt && !attempt.result && attempt.metrics?.status === "committed");
    const failed = Boolean(attempt.failure)
      || attempt.result?.outcome === "failure"
      || (!attempt.failure && !attempt.result && attempt.metrics?.status === "retryable_failure");
    if (committed) statusCounts.committed += 1;
    if (failed) statusCounts.retryable_failure += 1;
    if (attempt.metrics?.status === "skipped") statusCounts.skipped += 1;
    if (attempt.metrics?.status === "needs_user") statusCounts.needs_user += 1;
    const diagnostic = terminalDiagnosticCode(attempt.failure)
      ?? attempt.metrics?.diagnostic_code
      ?? attemptResultDiagnosticCode(attempt.result);
    if (diagnostic) diagnosticCounts[diagnostic] = (diagnosticCounts[diagnostic] ?? 0) + 1;
    const hasInput = attempt.usage.input_tokens !== undefined;
    const hasOutput = attempt.usage.output_tokens !== undefined;
    const hasAny = hasInput || hasOutput || attempt.usage.cached_input_tokens !== undefined;
    if (hasInput && hasOutput) fullyKnown += 1;
    else if (hasAny) partiallyKnown += 1;
    else unavailable += 1;
    inputTokens += attempt.usage.input_tokens ?? 0;
    cachedInputTokens += attempt.usage.cached_input_tokens ?? 0;
    outputTokens += attempt.usage.output_tokens ?? 0;
    if (attempt.usage.estimate) {
      estimateMethods.add(attempt.usage.estimate.method);
      estimateInput += attempt.usage.estimate.input_tokens;
      estimateOutput += attempt.usage.estimate.output_tokens;
    }
    if (committed && attempt.metrics?.output_items !== undefined) {
      emptyKnown += 1;
      if (attempt.metrics.output_items === 0) emptyAttempts += 1;
    }
  }
  const events = readAutomaticBuildLifecycleEvents(target, stage, { now });
  const eventCount = (kind: AutomaticBuildLifecycleEventKind) => events.filter((event) => event.kind === kind).length;
  const reserveWait: number[] = [];
  const runningExecutor: number[] = [];
  const writer: number[] = [];
  const unobserved: number[] = [];
  for (const attempt of attempts) {
    if (!attempt.lease) continue;
    const reservedAt = attempt.lease.version === "automatic_build_task_lease.v2"
      ? attempt.lease.reserved_at
      : attempt.lease.issued_at;
    const expiry = isExpired(attempt, now) ? attemptExpiry(attempt) : undefined;
    const end = terminalAt(attempt) ?? expiry;
    const reserveEnd = attempt.start?.started_at ?? end;
    const runningEnd = attempt.start ? attempt.submission?.started_at ?? end : undefined;
    if (reserveEnd) reserveWait.push(durationMs(reservedAt, reserveEnd, "reserve_wait_ms"));
    if (attempt.start && runningEnd) {
      runningExecutor.push(durationMs(attempt.start.started_at, runningEnd, "running_executor_ms"));
    }
    if (attempt.submission && end) writer.push(durationMs(attempt.submission.started_at, end, "writer_ms"));
    if (end && reserveEnd) {
      const total = durationMs(reservedAt, end, "observed_attempt_ms");
      const observedReserve = durationMs(reservedAt, reserveEnd, "reserve_wait_ms");
      const observedRunning = attempt.start && runningEnd
        ? durationMs(attempt.start.started_at, runningEnd, "running_executor_ms")
        : 0;
      const observedWriter = attempt.submission
        ? durationMs(attempt.submission.started_at, end, "writer_ms")
        : 0;
      unobserved.push(Math.max(0, total - observedReserve - observedRunning - observedWriter));
    }
  }
  const semanticAttempts = new Set(attempts.flatMap((attempt) => attempt.stored.execution_identity
    ? [`${attempt.stored.work_unit_id}:${attempt.stored.execution_identity.semantic_attempt}`]
    : [])).size;
  const core = {
    version: "automatic_build_stage_metrics_summary.v1" as const,
    target_ref: target.target_ref,
    stage,
    attempt_count: attempts.length,
    work_unit_count: new Set(attempts.map((attempt) => attempt.stored.work_unit_id)).size,
    status_counts: statusCounts,
    retry_count: statusCounts.retryable_failure,
    bytes: {
      input_total: metrics.reduce((sum, item) => sum + item.input_bytes, 0),
      output_total: metrics.reduce((sum, item) => sum + item.output_bytes, 0),
      output_average: attempts.length
        ? metrics.reduce((sum, item) => sum + item.output_bytes, 0) / attempts.length
        : 0,
    },
    usage: {
      fully_known_attempts: fullyKnown,
      partially_known_attempts: partiallyKnown,
      unavailable_attempts: unavailable,
      known_usage_coverage: attempts.length ? (fullyKnown + partiallyKnown) / attempts.length : 0,
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
    lifecycle_counts: {
      lease_issued: eventCount("lease_reserved"),
      lease_expired: eventCount("lease_expired"),
      executor_started: eventCount("executor_started"),
      heartbeat: eventCount("heartbeat"),
      input_finished: eventCount("input_finished"),
      candidate_submitted: eventCount("candidate_submitted"),
      writer_failed: eventCount("writer_failed"),
      task_failed: eventCount("task_failed") + eventCount("writer_failed"),
      task_committed: eventCount("task_committed"),
    },
    execution_counts: {
      physical_attempts: attempts.length,
      semantic_attempts: semanticAttempts,
      lease_epochs: attempts.filter((attempt) => attempt.stored.execution_identity).length,
      submit_revisions: attempts.reduce((sum, attempt) => sum + attempt.submit_revisions.length, 0),
    },
    phase_latency: {
      dispatch_wait_ms: observedPercentiles([], attempts.length),
      reserve_wait_ms: observedPercentiles(reserveWait, attempts.length),
      running_executor_ms: observedPercentiles(runningExecutor, attempts.length),
      writer_ms: observedPercentiles(writer, attempts.length),
      unobserved_interval_ms: observedPercentiles(unobserved, attempts.length),
    },
    provenance: {
      model: provenanceDimension(attempts.map((attempt) => attempt.usage.model)),
      reasoning_effort: provenanceDimension(attempts.map((attempt) => attempt.usage.reasoning_effort)),
      harness_release: provenanceDimension(attempts.map((attempt) => attempt.usage.harness_release)),
    },
    performance_history: buildPerformanceHistory(target, attempts, options.work_units ?? []),
  };
  return { ...core, digest: digest(core) };
}

export function writeAutomaticBuildStageMetricsSummary(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  options: { now?: string; work_units?: WorkUnitDescriptor[] } = {},
): AutomaticBuildStageMetricsSummaryV1 {
  const summary = buildAutomaticBuildStageMetricsSummary(target, stage, options);
  writeJsonAtomic(automaticBuildStageMetricsSummaryPath(target, stage), summary);
  return summary;
}
