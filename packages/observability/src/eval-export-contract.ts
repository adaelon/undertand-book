export const EVAL_EXPORT_SCHEMA_VERSION = "ub_eval_export.v1" as const;
export const MAX_EVAL_ROWS = 10_000;
export const MAX_EVAL_SCORES_PER_ROW = 64;
export const MAX_EVAL_SUMMARY_FIELDS = 64;
export const MAX_EVAL_RECORD_FIELDS = 32;

export type EvalTiming =
  | { source: "recorded"; started_at: string; finished_at: string; elapsed_ms?: number }
  | { source: "elapsed_only"; elapsed_ms: number }
  | { source: "unavailable" };

export type EvalScore = {
  key: string;
  source: "deterministic" | "llm_judge" | "human";
  evaluator_version: string;
  judgment_id?: string;
  candidate_order?: string[];
  status: "measured" | "not_applicable" | "unavailable";
  score?: number;
  value?: string;
};

export interface EvalRow {
  sample_id: string;
  case_id: string;
  repetition: number;
  execution_trace_id?: string;
  timing: EvalTiming;
  execution_status: string;
  quality_status?: string;
  order_disagreement?: boolean;
  permitted_inputs: Record<string, unknown>;
  permitted_expected_outputs?: Record<string, unknown>;
  permitted_actual_outputs?: Record<string, unknown>;
  scores: EvalScore[];
}

export interface UbEvalExportV1 {
  schema_version: typeof EVAL_EXPORT_SCHEMA_VERSION;
  comparison_group_id: string;
  external_experiment_id: string;
  external_dataset_id: string;
  dataset_revision: string;
  source_revision_ref: string;
  system: string;
  execution_config_ref: string;
  timing: EvalTiming;
  evaluation_status?: string;
  calibration_ref?: string;
  summary: Record<string, number | string | null>;
  comparisons: Array<{
    case_id: string;
    repetition: number;
    sample_ids: string[];
    outcome: string;
  }>;
  rows: EvalRow[];
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const status = /^[a-z][a-z0-9_]{0,63}$/u;

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error(`${name} must be a bounded non-empty string`);
  }
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validateTiming(value: EvalTiming, name: string): void {
  if (value.source === "recorded") {
    if (!validTimestamp(value.started_at) || !validTimestamp(value.finished_at)
      || Date.parse(value.finished_at) < Date.parse(value.started_at)) {
      throw new Error(`${name} recorded interval is invalid`);
    }
    if (value.elapsed_ms !== undefined && (!Number.isFinite(value.elapsed_ms) || value.elapsed_ms < 0)) {
      throw new Error(`${name} elapsed_ms is invalid`);
    }
    return;
  }
  if (value.source === "elapsed_only") {
    if (!Number.isFinite(value.elapsed_ms) || value.elapsed_ms < 0) {
      throw new Error(`${name} elapsed_ms is invalid`);
    }
    return;
  }
  if (value.source !== "unavailable") throw new Error(`${name} source is invalid`);
}

function validateRecord(value: Record<string, unknown>, name: string): void {
  const entries = Object.entries(value);
  if (entries.length > MAX_EVAL_RECORD_FIELDS) throw new Error(`${name} has too many fields`);
  for (const [key, item] of entries) {
    if (!identifier.test(key)) throw new Error(`${name} has an invalid key`);
    if (!(item === null || typeof item === "boolean"
      || (typeof item === "number" && Number.isFinite(item))
      || (typeof item === "string" && item.length <= 256))) {
      throw new Error(`${name} values must be bounded primitives`);
    }
  }
}

function validateScore(score: EvalScore): void {
  nonEmpty(score.key, "score.key");
  nonEmpty(score.evaluator_version, "score.evaluator_version");
  if (!identifier.test(score.key) || !identifier.test(score.evaluator_version)) {
    throw new Error("score identity is invalid");
  }
  if (!["deterministic", "llm_judge", "human"].includes(score.source)
    || !["measured", "not_applicable", "unavailable"].includes(score.status)) {
    throw new Error("score classification is invalid");
  }
  if (score.score !== undefined && !Number.isFinite(score.score)) throw new Error("score is invalid");
  if (score.value !== undefined && score.value.length > 128) throw new Error("score value is too long");
  if (score.judgment_id !== undefined) nonEmpty(score.judgment_id, "score.judgment_id");
  if (score.candidate_order !== undefined) {
    if (score.candidate_order.length > 16) throw new Error("candidate order is too large");
    score.candidate_order.forEach((entry) => nonEmpty(entry, "score.candidate_order"));
  }
}

export function validateEvalExport(value: UbEvalExportV1): UbEvalExportV1 {
  if (value.schema_version !== EVAL_EXPORT_SCHEMA_VERSION) {
    throw new Error("unsupported eval export schema version");
  }
  for (const [name, field] of Object.entries({
    comparison_group_id: value.comparison_group_id,
    external_experiment_id: value.external_experiment_id,
    external_dataset_id: value.external_dataset_id,
    dataset_revision: value.dataset_revision,
    source_revision_ref: value.source_revision_ref,
    system: value.system,
    execution_config_ref: value.execution_config_ref,
  })) nonEmpty(field, name);
  if (value.evaluation_status !== undefined && !status.test(value.evaluation_status)) {
    throw new Error("evaluation_status is invalid");
  }
  if (value.calibration_ref !== undefined) nonEmpty(value.calibration_ref, "calibration_ref");
  validateTiming(value.timing, "experiment timing");
  const summaryEntries = Object.entries(value.summary);
  if (summaryEntries.length > MAX_EVAL_SUMMARY_FIELDS) throw new Error("summary has too many fields");
  for (const [key, item] of summaryEntries) {
    if (!identifier.test(key) || !(item === null || typeof item === "string"
      || (typeof item === "number" && Number.isFinite(item)))) {
      throw new Error("summary contains an invalid field");
    }
  }
  if (value.rows.length > MAX_EVAL_ROWS) throw new Error("eval export has too many rows");
  const sampleIds = new Set<string>();
  for (const row of value.rows) {
    nonEmpty(row.sample_id, "row.sample_id");
    nonEmpty(row.case_id, "row.case_id");
    if (sampleIds.has(row.sample_id)) throw new Error("duplicate sample_id");
    sampleIds.add(row.sample_id);
    if (!Number.isSafeInteger(row.repetition) || row.repetition < 1) {
      throw new Error("row.repetition is invalid");
    }
    if (!status.test(row.execution_status)) throw new Error("execution_status is invalid");
    if (row.quality_status !== undefined && !status.test(row.quality_status)) {
      throw new Error("quality_status is invalid");
    }
    if (row.order_disagreement !== undefined && typeof row.order_disagreement !== "boolean") {
      throw new Error("order_disagreement is invalid");
    }
    validateTiming(row.timing, `row ${row.sample_id} timing`);
    validateRecord(row.permitted_inputs, "permitted_inputs");
    if (row.permitted_expected_outputs) validateRecord(row.permitted_expected_outputs, "permitted_expected_outputs");
    if (row.permitted_actual_outputs) validateRecord(row.permitted_actual_outputs, "permitted_actual_outputs");
    if (row.scores.length > MAX_EVAL_SCORES_PER_ROW) throw new Error("row has too many scores");
    row.scores.forEach(validateScore);
  }
  for (const comparison of value.comparisons) {
    nonEmpty(comparison.case_id, "comparison.case_id");
    nonEmpty(comparison.outcome, "comparison.outcome");
    if (!Number.isSafeInteger(comparison.repetition) || comparison.repetition < 1) {
      throw new Error("comparison.repetition is invalid");
    }
    if (!Array.isArray(comparison.sample_ids) || comparison.sample_ids.length > 16) {
      throw new Error("comparison sample_ids are invalid");
    }
    comparison.sample_ids.forEach((entry) => nonEmpty(entry, "comparison.sample_id"));
  }
  return value;
}
