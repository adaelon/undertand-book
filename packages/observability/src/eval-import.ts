import { authorizeEvalImport, type EvalImportConsentV1 } from "./eval-consent.js";
import type { EvalImportLedger } from "./eval-import-ledger.js";
import { evalScoreFeedback, summaryFeedback, type LangSmithFeedback } from "./eval-feedback.js";
import { validateEvalExport, type EvalRow, type UbEvalExportV1 } from "./eval-export-contract.js";

export interface LangSmithExperimentUploadBody {
  experiment_name: string;
  experiment_start_time: string;
  experiment_end_time: string;
  dataset_id: string;
  experiment_metadata: Record<string, unknown>;
  summary_experiment_scores: LangSmithFeedback[];
  results: Array<{
    row_id: string;
    inputs: Record<string, unknown>;
    expected_outputs?: Record<string, unknown>;
    actual_outputs?: Record<string, unknown>;
    evaluation_scores: LangSmithFeedback[];
    start_time: string;
    end_time: string;
    run_name: string;
    error?: string;
    run_metadata: Record<string, unknown>;
  }>;
}

export type EvalUploadResult =
  | { status: "confirmed"; remote_experiment_id?: string; remote_dataset_id?: string }
  | { status: "rejected"; error_code: string };

export interface EvalUploadTransport {
  upload(body: LangSmithExperimentUploadBody): Promise<EvalUploadResult>;
}

export class HttpEvalUploadTransport implements EvalUploadTransport {
  private readonly endpoint: string;

  constructor(private readonly options: {
    apiKey: string;
    apiUrl?: string;
    workspaceId?: string;
    timeoutMs?: number;
  }) {
    const base = new URL(options.apiUrl ?? "https://api.smith.langchain.com");
    const prefix = base.pathname.replace(/\/$/u, "");
    base.pathname = `${prefix.endsWith("/api/v1") ? prefix : `${prefix}/api/v1`}/datasets/upload-experiment`;
    base.search = "";
    base.hash = "";
    this.endpoint = base.toString();
  }

  async upload(body: LangSmithExperimentUploadBody): Promise<EvalUploadResult> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        ...(this.options.workspaceId ? { "X-Tenant-Id": this.options.workspaceId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { status: "rejected", error_code: `LANGSMITH_UPLOAD_REJECTED_${response.status}` };
    }
    const value = await response.json() as {
      experiment?: { id?: string };
      dataset?: { id?: string };
    };
    return {
      status: "confirmed",
      ...(value.experiment?.id ? { remote_experiment_id: value.experiment.id } : {}),
      ...(value.dataset?.id ? { remote_dataset_id: value.dataset.id } : {}),
    };
  }
}

export interface EvalImportResult {
  status: "complete" | "unsupported_missing_timing" | "unauthorized" | "incomplete";
  missing_sample_ids: string[];
  experiments: Array<{
    external_experiment_id: string;
    status: "confirmed" | "skipped" | "rejected" | "uncertain";
    error_code?: string;
  }>;
}

function timingFailures(packages: readonly UbEvalExportV1[]): string[] {
  const missing = new Set<string>();
  for (const item of packages) {
    if (item.timing.source !== "recorded") {
      item.rows.forEach((row) => missing.add(row.sample_id));
      continue;
    }
    const experimentStart = Date.parse(item.timing.started_at);
    const experimentEnd = Date.parse(item.timing.finished_at);
    for (const row of item.rows) {
      if (row.timing.source !== "recorded") {
        missing.add(row.sample_id);
        continue;
      }
      const rowStart = Date.parse(row.timing.started_at);
      const rowEnd = Date.parse(row.timing.finished_at);
      if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd)
        || rowEnd < rowStart || rowStart < experimentStart || rowEnd > experimentEnd) {
        missing.add(row.sample_id);
      }
    }
  }
  return [...missing].sort();
}

function assertComparisonGroup(packages: readonly UbEvalExportV1[]): void {
  if (!packages.length) throw new Error("evaluation comparison group is empty");
  packages.forEach(validateEvalExport);
  const first = packages[0];
  const same = packages.every((item) =>
    item.comparison_group_id === first.comparison_group_id
    && item.external_dataset_id === first.external_dataset_id
    && item.dataset_revision === first.dataset_revision
    && item.source_revision_ref === first.source_revision_ref);
  if (!same) throw new Error("evaluation comparison group identity mismatch");
  if (new Set(packages.map((item) => item.system)).size !== packages.length
    || new Set(packages.map((item) => item.external_experiment_id)).size !== packages.length) {
    throw new Error("evaluation comparison group contains duplicate experiments");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(first.external_dataset_id)) {
    throw new Error("external_dataset_id must be a UUID for LangSmith upload");
  }
}

function productError(row: EvalRow): string | undefined {
  return ["delivered", "completed"].includes(row.execution_status)
    ? undefined
    : `PRODUCT_${row.execution_status.toUpperCase()}`;
}

export function buildExperimentUpload(
  value: UbEvalExportV1,
  ledger: EvalImportLedger,
): LangSmithExperimentUploadBody {
  if (value.timing.source !== "recorded") throw new Error("experiment timing is unavailable");
  return {
    experiment_name: value.external_experiment_id,
    experiment_start_time: value.timing.started_at,
    experiment_end_time: value.timing.finished_at,
    dataset_id: value.external_dataset_id,
    experiment_metadata: {
      comparison_group_id: value.comparison_group_id,
      dataset_revision: value.dataset_revision,
      source_revision_ref: value.source_revision_ref,
      system: value.system,
      execution_config_ref: value.execution_config_ref,
      evaluation_status: value.evaluation_status ?? null,
      calibration_ref: value.calibration_ref ?? null,
      comparisons: value.comparisons,
    },
    summary_experiment_scores: summaryFeedback(value),
    results: value.rows.map((row) => {
      if (row.timing.source !== "recorded") throw new Error("row timing is unavailable");
      const error = productError(row);
      return {
        row_id: ledger.rowId(value.dataset_revision, row.case_id, row.repetition),
        inputs: row.permitted_inputs,
        ...(row.permitted_expected_outputs ? { expected_outputs: row.permitted_expected_outputs } : {}),
        ...(row.permitted_actual_outputs ? { actual_outputs: row.permitted_actual_outputs } : {}),
        evaluation_scores: row.scores.map(evalScoreFeedback),
        start_time: row.timing.started_at,
        end_time: row.timing.finished_at,
        run_name: `${value.system}:${row.case_id}:${row.repetition}`,
        ...(error ? { error } : {}),
        run_metadata: {
          sample_id: row.sample_id,
          case_id: row.case_id,
          repetition: row.repetition,
          execution_status: row.execution_status,
          quality_status: row.quality_status ?? null,
          order_disagreement: row.order_disagreement ?? null,
          execution_trace_id: row.execution_trace_id ?? null,
          score_identities: row.scores.map((score) => ({
            key: score.key,
            judgment_id: score.judgment_id ?? null,
            candidate_order: score.candidate_order ?? [],
            status: score.status,
          })),
        },
      };
    }),
  };
}

export async function importEvaluationComparisonGroup(input: {
  packages: readonly UbEvalExportV1[];
  consent: EvalImportConsentV1;
  ledger: EvalImportLedger;
  transport: EvalUploadTransport;
}): Promise<EvalImportResult> {
  assertComparisonGroup(input.packages);
  const authorization = authorizeEvalImport(input.packages, input.consent);
  if (!authorization.ok) {
    return {
      status: "unauthorized",
      missing_sample_ids: [],
      experiments: input.packages.map((item) => ({
        external_experiment_id: item.external_experiment_id,
        status: "rejected",
        error_code: authorization.error_code,
      })),
    };
  }
  const missing = timingFailures(input.packages);
  if (missing.length) {
    return {
      status: "unsupported_missing_timing",
      missing_sample_ids: missing,
      experiments: [],
    };
  }

  const experiments: EvalImportResult["experiments"] = [];
  for (const value of input.packages) {
    const state = input.ledger.experimentState(value.external_experiment_id);
    if (state.status === "confirmed") {
      experiments.push({ external_experiment_id: value.external_experiment_id, status: "skipped" });
      continue;
    }
    if (state.status === "uncertain") {
      experiments.push({
        external_experiment_id: value.external_experiment_id,
        status: "uncertain",
        error_code: state.error_code,
      });
      continue;
    }
    try {
      const result = await input.transport.upload(buildExperimentUpload(value, input.ledger));
      if (result.status === "confirmed") {
        input.ledger.confirmExperiment(value.external_experiment_id, result);
        experiments.push({ external_experiment_id: value.external_experiment_id, status: "confirmed" });
      } else {
        experiments.push({
          external_experiment_id: value.external_experiment_id,
          status: "rejected",
          error_code: result.error_code,
        });
      }
    } catch {
      const errorCode = "LANGSMITH_UPLOAD_UNCERTAIN";
      input.ledger.markExperimentUncertain(value.external_experiment_id, errorCode);
      experiments.push({
        external_experiment_id: value.external_experiment_id,
        status: "uncertain",
        error_code: errorCode,
      });
    }
  }
  return {
    status: experiments.every((item) => ["confirmed", "skipped"].includes(item.status))
      ? "complete"
      : "incomplete",
    missing_sample_ids: [],
    experiments,
  };
}
