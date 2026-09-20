export const OBSERVATION_SCHEMA_VERSION = "ub_observation.v1" as const;
export const MAX_OBSERVATION_SOURCE_REFS = 32;

export type UsageSource = "provider_reported" | "executor_reported" | "estimated" | "unavailable";
export type UsageCompleteness = "complete" | "partial" | "unavailable";
export type ObservationCoverage = "complete" | "partial" | "unknown";

export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  total_tokens: number | null;
  source: UsageSource;
  completeness: UsageCompleteness;
}

export interface ObservationCompleteness {
  sampled: boolean;
  dropped_count: number;
  coverage: ObservationCoverage;
  reconstructed: boolean;
}

export interface ObservationMetadata {
  thread_id: string | null;
  book_ref: string | null;
  source_revision_ref: string | null;
  registered_tool_name: string | null;
  purpose: string | null;
  error_code: string | null;
  result_count: number | null;
  model_first_text_ms: number | null;
  model_first_text_at: string | null;
  answer_first_patch_ms: number | null;
  model_name: string | null;
  model_name_source: "configured" | "provider_reported" | null;
  accepted_evidence_count: number | null;
  evidence_refs: string[];
  final_source_ref_count: number | null;
  delivery_initial_issue_count: number | null;
  delivery_repair_issue_count: number | null;
  delivery_classification: string | null;
  delivery_error_codes: string[];
  request_count: number | null;
  request_message_count: number | null;
  request_tool_schema_count: number | null;
  request_estimated_input_tokens: number | null;
  request_estimate_source: "runtime_estimated" | null;
  interruption_detected_at: string | null;
  source_refs: string[];
  executed: boolean;
  incomplete: boolean;
}

export interface ObservationEnvelope {
  schema_version: typeof OBSERVATION_SCHEMA_VERSION;
  local_run_ref: string;
  span_id: string;
  parent_span_id: string | null;
  revision: number;
  surface: "resident";
  kind: "run" | "model" | "tool" | "activity";
  observed_at: string | null;
  elapsed_ms: number | null;
  duration_ms: number | null;
  timing_source: "runtime_anchor" | "last_observed" | "unavailable";
  execution_state: "running" | "completed" | "failed" | "cancelled" | "interrupted" | null;
  delivery_state: "pending" | "delivered" | "failed" | "not_delivered" | "partial" | "unknown" | null;
  persistence_state: "pending" | "saved" | "failed" | "unknown" | null;
  usage: TokenUsage;
  completeness: ObservationCompleteness;
  metadata: ObservationMetadata;
}

const topLevelKeys = new Set([
  "schema_version", "local_run_ref", "span_id", "parent_span_id", "revision", "surface",
  "kind", "observed_at", "elapsed_ms", "duration_ms", "timing_source", "execution_state",
  "delivery_state", "persistence_state", "usage", "completeness", "metadata",
]);
const usageKeys = new Set([
  "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens",
  "total_tokens", "source", "completeness",
]);
const completenessKeys = new Set(["sampled", "dropped_count", "coverage", "reconstructed"]);
const metadataKeys = new Set([
  "thread_id", "book_ref", "source_revision_ref", "registered_tool_name", "purpose",
  "error_code", "result_count", "model_first_text_ms", "model_first_text_at",
  "answer_first_patch_ms", "model_name", "model_name_source", "accepted_evidence_count",
  "evidence_refs", "final_source_ref_count", "delivery_initial_issue_count",
  "delivery_repair_issue_count", "delivery_classification", "delivery_error_codes",
  "request_count", "request_message_count", "request_tool_schema_count",
  "request_estimated_input_tokens", "request_estimate_source", "interruption_detected_at",
  "source_refs", "executed", "incomplete",
]);
const kinds = new Set(["run", "model", "tool", "activity"]);
const timingSources = new Set(["runtime_anchor", "last_observed", "unavailable"]);
const executionStates = new Set(["running", "completed", "failed", "cancelled", "interrupted", null]);
const deliveryStates = new Set(["pending", "delivered", "failed", "not_delivered", "partial", "unknown", null]);
const persistenceStates = new Set(["pending", "saved", "failed", "unknown", null]);
const usageSources = new Set(["provider_reported", "executor_reported", "estimated", "unavailable"]);
const usageCompleteness = new Set(["complete", "partial", "unavailable"]);
const coverageValues = new Set(["complete", "partial", "unknown"]);

function exactKeys(value: unknown, allowed: Set<string>): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key))
    && [...allowed].every((key) => key in value);
}

export function parseObservation(value: unknown): ObservationEnvelope {
  if (!exactKeys(value, topLevelKeys) || !exactKeys(value.usage, usageKeys)
      || !exactKeys(value.completeness, completenessKeys)
      || !exactKeys(value.metadata, metadataKeys)) {
    throw new Error("observation contains missing or unknown fields");
  }
  if (value.schema_version !== OBSERVATION_SCHEMA_VERSION
      || value.surface !== "resident"
      || typeof value.local_run_ref !== "string" || value.local_run_ref.length === 0
      || typeof value.span_id !== "string" || value.span_id.length === 0
      || !(typeof value.parent_span_id === "string" || value.parent_span_id === null)
      || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !kinds.has(value.kind as string)
      || !(typeof value.observed_at === "string" || value.observed_at === null)
      || !(typeof value.elapsed_ms === "number" || value.elapsed_ms === null)
      || !(typeof value.duration_ms === "number" || value.duration_ms === null)
      || !timingSources.has(value.timing_source as string)
      || !executionStates.has(value.execution_state as string | null)
      || !deliveryStates.has(value.delivery_state as string | null)
      || !persistenceStates.has(value.persistence_state as string | null)) {
    throw new Error("observation identity is invalid");
  }
  const usage = value.usage;
  const tokenKeys = [
    "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "total_tokens",
  ];
  const hasTokenValue = tokenKeys.some((key) => typeof usage[key] === "number");
  if (!usageSources.has(usage.source as string)
      || !usageCompleteness.has(usage.completeness as string)
      || !tokenKeys.every((key) => usage[key] === null
        || (typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0))
      || (usage.source === "unavailable" ? hasTokenValue || usage.completeness !== "unavailable"
        : !hasTokenValue || usage.completeness === "unavailable")) {
    throw new Error("usage source and value disagree");
  }
  const completeness = value.completeness;
  if (typeof completeness.sampled !== "boolean"
      || typeof completeness.dropped_count !== "number"
      || !Number.isSafeInteger(completeness.dropped_count)
      || completeness.dropped_count < 0
      || !coverageValues.has(completeness.coverage as string)
      || typeof completeness.reconstructed !== "boolean") {
    throw new Error("observation completeness is invalid");
  }
  const metadata = value.metadata;
  if (!Array.isArray(value.metadata.source_refs)
      || value.metadata.source_refs.length > MAX_OBSERVATION_SOURCE_REFS
      || !value.metadata.source_refs.every((entry) => typeof entry === "string")
      || !Array.isArray(metadata.evidence_refs)
      || metadata.evidence_refs.length > MAX_OBSERVATION_SOURCE_REFS
      || !metadata.evidence_refs.every((entry) => typeof entry === "string")
      || !Array.isArray(metadata.delivery_error_codes)
      || metadata.delivery_error_codes.length > 16
      || !metadata.delivery_error_codes.every((entry) => typeof entry === "string")
      || !["thread_id", "book_ref", "source_revision_ref", "registered_tool_name", "purpose", "error_code",
        "model_first_text_at", "model_name", "delivery_classification", "interruption_detected_at"]
        .every((key) => typeof metadata[key] === "string" || metadata[key] === null)
      || !(typeof metadata.result_count === "number" || metadata.result_count === null)
      || !(typeof metadata.model_first_text_ms === "number" || metadata.model_first_text_ms === null)
      || !(typeof metadata.answer_first_patch_ms === "number" || metadata.answer_first_patch_ms === null)
      || !new Set(["configured", "provider_reported", null]).has(metadata.model_name_source as string | null)
      || !["accepted_evidence_count", "final_source_ref_count", "delivery_initial_issue_count",
        "delivery_repair_issue_count", "request_count", "request_message_count", "request_tool_schema_count",
        "request_estimated_input_tokens"].every((key) => metadata[key] === null
          || (typeof metadata[key] === "number" && Number.isSafeInteger(metadata[key])
            && (metadata[key] as number) >= 0))
      || !new Set(["runtime_estimated", null]).has(metadata.request_estimate_source as string | null)
      || typeof metadata.executed !== "boolean"
      || typeof metadata.incomplete !== "boolean") {
    throw new Error("source_refs must be string coordinates");
  }
  return value as unknown as ObservationEnvelope;
}
