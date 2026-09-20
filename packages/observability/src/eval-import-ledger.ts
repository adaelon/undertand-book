import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type EvalExperimentState =
  | { status: "pending" }
  | { status: "confirmed"; remote_experiment_id?: string; remote_dataset_id?: string }
  | { status: "uncertain"; error_code: string };

export interface EvalImportLedger {
  rowId(datasetRevision: string, caseId: string, repetition: number): string;
  experimentState(experimentId: string): EvalExperimentState;
  confirmExperiment(experimentId: string, result: {
    remote_experiment_id?: string;
    remote_dataset_id?: string;
  }): void;
  markExperimentUncertain(experimentId: string, errorCode: string): void;
}

interface EvalImportLedgerFileV1 {
  version: "ub_eval_import_ledger.v1";
  rows: Record<string, string>;
  experiments: Record<string, EvalExperimentState>;
}

function rowKey(datasetRevision: string, caseId: string, repetition: number): string {
  return JSON.stringify([datasetRevision, caseId, repetition]);
}

export class MemoryEvalImportLedger implements EvalImportLedger {
  readonly rows = new Map<string, string>();
  readonly experiments = new Map<string, EvalExperimentState>();

  rowId(datasetRevision: string, caseId: string, repetition: number): string {
    const key = rowKey(datasetRevision, caseId, repetition);
    const existing = this.rows.get(key);
    if (existing) return existing;
    const id = randomUUID();
    this.rows.set(key, id);
    return id;
  }

  experimentState(experimentId: string): EvalExperimentState {
    return this.experiments.get(experimentId) ?? { status: "pending" };
  }

  confirmExperiment(experimentId: string, result: {
    remote_experiment_id?: string;
    remote_dataset_id?: string;
  }): void {
    this.experiments.set(experimentId, { status: "confirmed", ...result });
  }

  markExperimentUncertain(experimentId: string, errorCode: string): void {
    this.experiments.set(experimentId, { status: "uncertain", error_code: errorCode });
  }
}

export class FileEvalImportLedger implements EvalImportLedger {
  private readonly file: string;
  private readonly value: EvalImportLedgerFileV1;

  constructor(file: string) {
    this.file = path.resolve(file);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as EvalImportLedgerFileV1;
      if (parsed.version !== "ub_eval_import_ledger.v1" || !parsed.rows || !parsed.experiments) {
        throw new Error("unsupported eval import ledger");
      }
      this.value = parsed;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
      this.value = { version: "ub_eval_import_ledger.v1", rows: {}, experiments: {} };
    }
  }

  rowId(datasetRevision: string, caseId: string, repetition: number): string {
    const key = rowKey(datasetRevision, caseId, repetition);
    const existing = this.value.rows[key];
    if (existing) return existing;
    const id = randomUUID();
    this.value.rows[key] = id;
    this.persist();
    return id;
  }

  experimentState(experimentId: string): EvalExperimentState {
    return this.value.experiments[experimentId] ?? { status: "pending" };
  }

  confirmExperiment(experimentId: string, result: {
    remote_experiment_id?: string;
    remote_dataset_id?: string;
  }): void {
    this.value.experiments[experimentId] = { status: "confirmed", ...result };
    this.persist();
  }

  markExperimentUncertain(experimentId: string, errorCode: string): void {
    this.value.experiments[experimentId] = { status: "uncertain", error_code: errorCode };
    this.persist();
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, "utf8");
    renameSync(temporary, this.file);
  }
}
