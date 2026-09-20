import path from "node:path";
import {
  readAutomaticBuildLifecycleEvents,
  readAutomaticBuildUsageReceipt,
  type AutomaticBuildLifecycleEventV1,
  type AutomaticBuildUsageReceiptV1,
} from "../../core/src/automatic-build-metrics.js";
import {
  listAutomaticBuildStoredAttempts,
  type AutomaticBuildExecutionIdentity,
} from "../../core/src/automatic-build-task-store.js";
import type {
  AutomaticBuildStage,
  AutomaticBuildTarget,
} from "../../core/src/build-orchestrator.js";

export const PREBUILD_OBSERVATION_SCHEMA_VERSION = "ub_prebuild_observation.v1" as const;

export interface PrebuildAttemptFact {
  work_unit_id: string;
  physical_attempt: number;
  execution_identity?: AutomaticBuildExecutionIdentity;
  usage: AutomaticBuildUsageReceiptV1;
}

export interface PrebuildProjectionInput {
  target_ref: string;
  source_revision_ref: string;
  stage: AutomaticBuildStage;
  lifecycle: AutomaticBuildLifecycleEventV1[];
  attempts: PrebuildAttemptFact[];
}

export interface PrebuildObservationV1 {
  schema_version: typeof PREBUILD_OBSERVATION_SCHEMA_VERSION;
  projection_source: "durable_receipts";
  observation_identity: string;
  revision: number;
  target_ref: string;
  source_revision_ref: string;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  semantic_attempt: number | null;
  lease_epoch: number | null;
  submit_revision: number | null;
  attempt_scope: string | null;
  identity_source: "native" | "legacy_inferred" | "unavailable";
  status: "running" | "committed" | "failed" | "lease_expired" | "unknown";
  timing: {
    source: "recorded" | "derived" | "unavailable";
    started_at: string | null;
    finished_at: string | null;
  };
  usage: {
    source: "provider_reported" | "executor_reported" | "unavailable";
    input_tokens: number | null;
    cached_input_tokens: number | null;
    output_tokens: number | null;
    estimate_input_tokens: number | null;
    estimate_output_tokens: number | null;
    estimate_method: string | null;
  };
  lifecycle: Array<{
    kind: AutomaticBuildLifecycleEventV1["kind"];
    observed_at: string;
    submit_revision: number | null;
    diagnostic_code: string | null;
  }>;
}

function identityKey(
  targetRef: string,
  stage: AutomaticBuildStage,
  workUnitId: string,
  physicalAttempt: number,
  identity?: AutomaticBuildExecutionIdentity,
): string {
  const semantic = identity?.semantic_attempt ?? "unknown";
  const lease = identity?.lease_epoch ?? "unknown";
  const scope = identity && "attempt_scope_digest" in identity
    ? identity.attempt_scope_digest
    : "unavailable";
  return [targetRef, stage, workUnitId, physicalAttempt, semantic, lease, scope].join(":");
}

function status(events: AutomaticBuildLifecycleEventV1[]): PrebuildObservationV1["status"] {
  const kinds = new Set(events.map((event) => event.kind));
  if (kinds.has("task_committed")) return "committed";
  if (kinds.has("task_failed") || kinds.has("writer_failed")) return "failed";
  if (kinds.has("lease_expired")) return "lease_expired";
  if (kinds.has("executor_started") || kinds.has("candidate_submitted")) return "running";
  return "unknown";
}

function timing(events: AutomaticBuildLifecycleEventV1[]): PrebuildObservationV1["timing"] {
  if (events.length === 0) {
    return { source: "unavailable", started_at: null, finished_at: null };
  }
  const executorStart = events.find((event) => event.kind === "executor_started")?.observed_at;
  const terminal = [...events].reverse().find((event) => [
    "task_committed", "task_failed", "writer_failed", "lease_expired",
  ].includes(event.kind))?.observed_at;
  const startedAt = executorStart ?? events[0].observed_at;
  const finishedAt = terminal ?? events.at(-1)?.observed_at ?? null;
  const startedMs = Date.parse(startedAt);
  const finishedMs = finishedAt === null ? Number.NaN : Date.parse(finishedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs) {
    return { source: "unavailable", started_at: null, finished_at: null };
  }
  return {
    source: executorStart && terminal ? "recorded" : "derived",
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function projectUsage(receipt: AutomaticBuildUsageReceiptV1): PrebuildObservationV1["usage"] {
  return {
    source: receipt.source === "native"
      ? "provider_reported"
      : receipt.source === "executor_reported"
        ? "executor_reported"
        : "unavailable",
    input_tokens: receipt.input_tokens ?? null,
    cached_input_tokens: receipt.cached_input_tokens ?? null,
    output_tokens: receipt.output_tokens ?? null,
    estimate_input_tokens: receipt.estimate?.input_tokens ?? null,
    estimate_output_tokens: receipt.estimate?.output_tokens ?? null,
    estimate_method: receipt.estimate?.method ?? null,
  };
}

export function projectPrebuildReceipts(input: PrebuildProjectionInput): PrebuildObservationV1[] {
  return input.attempts.map((attempt) => {
    const events = input.lifecycle
      .filter((event) => event.work_unit_id === attempt.work_unit_id
        && event.physical_attempt === attempt.physical_attempt)
      .sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at)
        || left.kind.localeCompare(right.kind)
        || (left.submit_revision ?? 0) - (right.submit_revision ?? 0));
    const identity = attempt.execution_identity
      ?? events.find((event) => event.execution_identity)?.execution_identity;
    const submitRevision = events.reduce(
      (maximum, event) => Math.max(maximum, event.submit_revision ?? 0),
      identity?.submit_revision ?? 0,
    );
    return {
      schema_version: PREBUILD_OBSERVATION_SCHEMA_VERSION,
      projection_source: "durable_receipts",
      observation_identity: identityKey(
        input.target_ref,
        input.stage,
        attempt.work_unit_id,
        attempt.physical_attempt,
        identity,
      ),
      revision: Math.max(1, events.length + submitRevision),
      target_ref: input.target_ref,
      source_revision_ref: input.source_revision_ref,
      stage: input.stage,
      work_unit_id: attempt.work_unit_id,
      physical_attempt: attempt.physical_attempt,
      semantic_attempt: identity?.semantic_attempt ?? null,
      lease_epoch: identity?.lease_epoch ?? null,
      submit_revision: submitRevision || null,
      attempt_scope: identity && "attempt_scope_digest" in identity
        ? identity.attempt_scope_digest
        : null,
      identity_source: identity?.identity_source ?? "unavailable",
      status: status(events),
      timing: timing(events),
      usage: projectUsage(attempt.usage),
      lifecycle: events.map((event) => ({
        kind: event.kind,
        observed_at: event.observed_at,
        submit_revision: event.submit_revision ?? null,
        diagnostic_code: event.diagnostic_code ?? null,
      })),
    };
  });
}

export function readPrebuildProjection(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  sourceRevisionRef: string,
  options: { now?: string } = {},
): PrebuildObservationV1[] {
  if (!sourceRevisionRef.trim()) throw new Error("source revision ref is required");
  const attempts = listAutomaticBuildStoredAttempts(target, stage).map((attempt) => ({
    work_unit_id: attempt.work_unit_id,
    physical_attempt: attempt.physical_attempt,
    ...(attempt.execution_identity ? { execution_identity: attempt.execution_identity } : {}),
    usage: readAutomaticBuildUsageReceipt(path.join(attempt.attempt_dir, "lease.json")),
  }));
  return projectPrebuildReceipts({
    target_ref: `${target.target_ref.version}:${target.book_id}`,
    source_revision_ref: sourceRevisionRef,
    stage,
    lifecycle: readAutomaticBuildLifecycleEvents(target, stage, options),
    attempts,
  });
}
