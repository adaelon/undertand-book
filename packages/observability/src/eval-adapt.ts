import {
  EVAL_EXPORT_SCHEMA_VERSION,
  validateEvalExport,
  type EvalRow,
  type EvalScore,
  type EvalTiming,
  type UbEvalExportV1,
} from "./eval-export-contract.js";

type Primitive = string | number | boolean | null;

export interface AgentEvalRowSource {
  id: string;
  system: string;
  category?: string;
  kind?: string;
  started_at?: string;
  finished_at?: string;
  elapsed_ms?: number;
  error?: string;
  outcome?: { incomplete?: boolean };
  answer?: string;
  score?: Record<string, unknown>;
  success?: boolean;
  navigation_ok?: boolean;
  setup_ok?: boolean;
  persistence_ok?: boolean;
  new_chat_empty?: boolean;
  memory_observed_by_agent?: boolean;
  execution_trace_id?: string;
}

export interface AgentEvalReportSource {
  version: string;
  started_at?: string;
  finished_at?: string;
  status: string;
  experiment?: { arms?: string[] } | null;
  config?: { repeats?: number };
  summary?: Record<string, Record<string, unknown>>;
  qa?: AgentEvalRowSource[];
  navigation?: AgentEvalRowSource[];
  restart?: AgentEvalRowSource[];
}

export interface QualitySampleSource {
  sample_id: string;
  task_id: string;
  system: string;
  execution: string;
  historical_success: boolean;
  quality_status: string;
  order_disagreement: boolean;
  judgments: Array<{
    job_id: string;
    status: string;
    evaluation?: {
      dimensions?: Record<string, { verdict?: string }>;
    };
  }>;
}

export interface QualityReportSource {
  version: string;
  status: string;
  systems: Record<string, Record<string, number>>;
  dimension_summary: Record<string, Record<string, Record<string, number>>>;
  comparison: Array<{ case_id: string; winner: string; system?: string | null }>;
  samples: QualitySampleSource[];
  expected_judge_calls: number;
  judge_calls: number;
  missing_usage: number;
  total_tokens: number | null;
}

export interface QualityJobSource {
  id: string;
  case_id: string;
  mapping: Record<string, string>;
}

export interface EvalAdaptOptions {
  comparison_group_id: string;
  external_experiment_id_prefix: string;
  external_dataset_id: string;
  dataset_revision: string;
  source_revision_ref: string;
  execution_config_ref: string;
  calibration_ref?: string;
}

export interface EvalAdaptInput {
  run: AgentEvalReportSource;
  options: EvalAdaptOptions;
  quality?: QualityReportSource;
  quality_jobs?: QualityJobSource[];
}

const dimensions = ["accuracy", "completeness", "grounding", "explanation"] as const;
const rawSummaryKeys = [
  "count", "succeeded", "success_rate", "semantic_accuracy", "evidence_recall",
  "citation_support", "p95_seconds", "mean_tokens", "total_requests", "missing_usage",
  "errors", "incomplete",
] as const;
const qualitySystemKeys = ["total", "delivered", "pass", "fail", "unscorable", "product_failed"] as const;
const qualityDimensionKeys = ["met", "partial", "failed", "unknown", "not_applicable", "unscorable"] as const;

function timing(source: { started_at?: string; finished_at?: string; elapsed_ms?: number }): EvalTiming {
  const startedMs = source.started_at ? Date.parse(source.started_at) : Number.NaN;
  const finishedMs = source.finished_at ? Date.parse(source.finished_at) : Number.NaN;
  if (source.started_at && source.finished_at
    && Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs) {
    return {
      source: "recorded",
      started_at: source.started_at,
      finished_at: source.finished_at,
      ...(Number.isFinite(source.elapsed_ms) && source.elapsed_ms! >= 0
        ? { elapsed_ms: source.elapsed_ms }
        : {}),
    };
  }
  if (Number.isFinite(source.elapsed_ms) && source.elapsed_ms! >= 0) {
    return { source: "elapsed_only", elapsed_ms: source.elapsed_ms! };
  }
  return { source: "unavailable" };
}

function execution(row: AgentEvalRowSource, taskType: "qa" | "navigation" | "restart"): string {
  if (row.error) return "error";
  if (taskType === "restart") return "completed";
  if (row.outcome?.incomplete) return "incomplete";
  return row.answer?.trim() ? "delivered" : "empty";
}

function measured(key: string, value: boolean | number, evaluatorVersion: string): EvalScore {
  return {
    key,
    source: "deterministic",
    evaluator_version: evaluatorVersion,
    status: "measured",
    score: typeof value === "boolean" ? Number(value) : value,
  };
}

function actualOutputs(row: AgentEvalRowSource, taskType: "qa" | "navigation" | "restart"): Record<string, Primitive> {
  const output: Record<string, Primitive> = {};
  const add = (key: string, value: unknown) => {
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) output[key] = value;
  };
  if (taskType === "restart") {
    add("success", row.success);
    add("setup_ok", row.setup_ok);
    add("persistence_ok", row.persistence_ok);
    add("new_chat_empty", row.new_chat_empty);
    add("memory_observed_by_agent", row.memory_observed_by_agent);
  } else {
    add("success", row.score?.success);
    add("semantic_correct", row.score?.semantic_correct);
    add("evidence_recall", row.score?.evidence_recall);
    if (taskType === "navigation") add("navigation_ok", row.navigation_ok);
  }
  return output;
}

function deterministicScores(
  row: AgentEvalRowSource,
  taskType: "qa" | "navigation" | "restart",
  evaluatorVersion: string,
): EvalScore[] {
  return Object.entries(actualOutputs(row, taskType))
    .map(([key, value]) => measured(`product.${key}`, value as boolean | number, evaluatorVersion));
}

function addSafeSummary(
  target: Record<string, number | string | null>,
  prefix: string,
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): void {
  if (!source) return;
  for (const key of keys) {
    const value = source[key];
    if (value === null || typeof value === "string"
      || (typeof value === "number" && Number.isFinite(value))) {
      target[`${prefix}${key}`] = value;
    }
  }
}

function addQualitySummary(
  target: Record<string, number | string | null>,
  system: string,
  quality: QualityReportSource,
): void {
  addSafeSummary(target, "quality.", quality.systems[system], qualitySystemKeys);
  for (const dimension of dimensions) {
    addSafeSummary(
      target,
      `quality.${dimension}.`,
      quality.dimension_summary[system]?.[dimension],
      qualityDimensionKeys,
    );
  }
  target["quality.expected_judge_calls"] = quality.expected_judge_calls;
  target["quality.judge_calls"] = quality.judge_calls;
  target["quality.missing_usage"] = quality.missing_usage;
  target["quality.total_tokens"] = quality.total_tokens;
}

function qualityScores(
  sample: QualitySampleSource,
  jobs: Map<string, QualityJobSource>,
  qualitySampleToExport: Map<string, string>,
  evaluatorVersion: string,
): EvalScore[] {
  const scores: EvalScore[] = [
    measured("historical.success", sample.historical_success, evaluatorVersion),
    {
      key: "quality.status",
      source: "llm_judge",
      evaluator_version: evaluatorVersion,
      status: "measured",
      value: sample.quality_status,
    },
  ];
  for (const judgment of sample.judgments) {
    const job = jobs.get(judgment.job_id);
    const candidateOrder = job
      ? Object.keys(job.mapping).sort().map((candidate) => qualitySampleToExport.get(job.mapping[candidate]))
        .filter((value): value is string => value !== undefined)
      : [];
    scores.push({
      key: "quality.judgment",
      source: "llm_judge",
      evaluator_version: evaluatorVersion,
      judgment_id: judgment.job_id,
      ...(candidateOrder.length ? { candidate_order: candidateOrder } : {}),
      status: "measured",
      value: judgment.status,
    });
    for (const dimension of dimensions) {
      const verdict = judgment.evaluation?.dimensions?.[dimension]?.verdict;
      if (!verdict) continue;
      scores.push({
        key: `quality.${dimension}`,
        source: "llm_judge",
        evaluator_version: evaluatorVersion,
        judgment_id: judgment.job_id,
        ...(candidateOrder.length ? { candidate_order: candidateOrder } : {}),
        status: verdict === "not_applicable" ? "not_applicable" : "measured",
        value: verdict,
      });
    }
  }
  return scores;
}

function rowSources(run: AgentEvalReportSource): Array<{
  taskType: "qa" | "navigation" | "restart";
  row: AgentEvalRowSource;
}> {
  return [
    ...(run.qa ?? []).map((row) => ({ taskType: "qa" as const, row })),
    ...(run.navigation ?? []).map((row) => ({ taskType: "navigation" as const, row })),
    ...(run.restart ?? []).map((row) => ({ taskType: "restart" as const, row })),
  ];
}

export function adaptLocalEvaluation(input: EvalAdaptInput): UbEvalExportV1[] {
  const sources = rowSources(input.run);
  const systems = [...new Set(sources.map(({ row }) => row.system))];
  const sampleBySource = new Map<AgentEvalRowSource, string>();
  const repetitionByKey = new Map<string, number>();
  sources.forEach(({ taskType, row }, index) => {
    const systemIndex = systems.indexOf(row.system) + 1;
    sampleBySource.set(row, `sample-${String(systemIndex).padStart(2, "0")}-${String(index + 1).padStart(5, "0")}`);
  });
  const qualityByTaskSystem = new Map(
    (input.quality?.samples ?? []).map((sample) => [`${sample.task_id}\u0000${sample.system}`, sample]),
  );
  const qualitySampleToExport = new Map<string, string>();
  for (const { taskType, row } of sources) {
    if (taskType !== "qa") continue;
    const quality = qualityByTaskSystem.get(`${row.id}\u0000${row.system}`);
    if (quality) qualitySampleToExport.set(quality.sample_id, sampleBySource.get(row)!);
  }
  const jobs = new Map((input.quality_jobs ?? []).map((job) => [job.id, job]));
  const rowsBySystem = new Map<string, EvalRow[]>();
  for (const { taskType, row } of sources) {
    const repetitionKey = `${taskType}\u0000${row.id}\u0000${row.system}`;
    const repetition = (repetitionByKey.get(repetitionKey) ?? 0) + 1;
    repetitionByKey.set(repetitionKey, repetition);
    const quality = taskType === "qa"
      ? qualityByTaskSystem.get(`${row.id}\u0000${row.system}`)
      : undefined;
    const evalRow: EvalRow = {
      sample_id: sampleBySource.get(row)!,
      case_id: `${taskType}:${row.id}`,
      repetition,
      ...(row.execution_trace_id ? { execution_trace_id: row.execution_trace_id } : {}),
      timing: timing(row),
      execution_status: quality?.execution ?? execution(row, taskType),
      ...(quality ? {
        quality_status: quality.quality_status,
        order_disagreement: quality.order_disagreement,
      } : {}),
      permitted_inputs: {
        task_type: taskType,
        ...(row.category ? { category: row.category } : {}),
        ...(row.kind ? { kind: row.kind } : {}),
      },
      permitted_actual_outputs: actualOutputs(row, taskType),
      scores: [
        ...deterministicScores(row, taskType, input.run.version),
        ...(quality
          ? qualityScores(quality, jobs, qualitySampleToExport, input.quality!.version)
          : []),
      ],
    };
    rowsBySystem.set(row.system, [...(rowsBySystem.get(row.system) ?? []), evalRow]);
  }

  const comparisons = (input.quality?.comparison ?? []).map((comparison) => {
    const mappedSampleIds = [...new Set((input.quality_jobs ?? [])
      .filter((job) => job.case_id === comparison.case_id)
      .flatMap((job) => Object.keys(job.mapping).sort().map((candidate) => job.mapping[candidate])))];
    const samples = input.quality!.samples.filter((sample) => mappedSampleIds.length
      ? mappedSampleIds.includes(sample.sample_id)
      : sample.sample_id.startsWith(`${comparison.case_id}-`));
    const sampleIds = samples.map((sample) => qualitySampleToExport.get(sample.sample_id))
      .filter((value): value is string => value !== undefined);
    const first = samples[0];
    const caseId = first ? `qa:${first.task_id}` : `qa:${comparison.case_id}`;
    return {
      case_id: caseId,
      repetition: 1,
      sample_ids: sampleIds,
      outcome: qualitySampleToExport.get(comparison.winner) ?? comparison.winner,
    };
  });

  return systems.map((system, systemIndex) => {
    const rows = rowsBySystem.get(system) ?? [];
    const summary: Record<string, number | string | null> = {
      "rows.total": rows.length,
      "rows.qa": rows.filter((row) => row.permitted_inputs.task_type === "qa").length,
      "rows.navigation": rows.filter((row) => row.permitted_inputs.task_type === "navigation").length,
      "rows.restart": rows.filter((row) => row.permitted_inputs.task_type === "restart").length,
    };
    addSafeSummary(summary, "agent.", input.run.summary?.[system], rawSummaryKeys);
    if (input.quality) addQualitySummary(summary, system, input.quality);
    return validateEvalExport({
      schema_version: EVAL_EXPORT_SCHEMA_VERSION,
      comparison_group_id: input.options.comparison_group_id,
      external_experiment_id: `${input.options.external_experiment_id_prefix}-${String(systemIndex + 1).padStart(2, "0")}`,
      external_dataset_id: input.options.external_dataset_id,
      dataset_revision: input.options.dataset_revision,
      source_revision_ref: input.options.source_revision_ref,
      system,
      execution_config_ref: input.options.execution_config_ref,
      timing: timing(input.run),
      evaluation_status: input.quality?.status ?? input.run.status,
      ...(input.options.calibration_ref ? { calibration_ref: input.options.calibration_ref } : {}),
      summary,
      comparisons,
      rows,
    });
  });
}
