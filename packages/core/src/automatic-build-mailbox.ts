import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AutomaticBuildTarget } from "./build-orchestrator";
import {
  assertActiveAutomaticBuildLease,
  readAutomaticBuildLease,
  type AutomaticBuildTaskLeaseV1,
} from "./automatic-build-lease";
import {
  persistAutomaticBuildTaskMetrics,
  readAutomaticBuildUsageReceipt,
  type AutomaticBuildTaskMetricsV1,
} from "./automatic-build-metrics";
import { recordAutomaticBuildAttemptEvent } from "./automatic-build-task-store";
import {
  buildSemanticArtifactEnvelope,
  writeSemanticArtifactEnvelopeFile,
  type SemanticBuildStage,
} from "./semantic-artifact";

const DEFAULT_MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4_096;

export interface AutomaticBuildCandidateRecordV1 {
  version: "automatic_build_candidate_record.v1";
  candidate_path: string;
  candidate_sha256: string;
  size_bytes: number;
}

export interface AutomaticBuildWriterResult {
  artifact_path: string;
  output_counts?: Record<string, number>;
}

export interface AutomaticBuildTaskReceiptV1 {
  version: "automatic_build_task_receipt.v1";
  task_ref: string;
  state: "committed" | "retryable_failure";
  target_ref: AutomaticBuildTaskLeaseV1["target_ref"];
  stage: AutomaticBuildTaskLeaseV1["stage"];
  work_unit_id: string;
  attempt: number;
  candidate_sha256?: string;
  artifact_path?: string;
  artifact_sha256?: string;
  output_counts?: Record<string, number>;
  diagnostic_code?: string;
  message?: string;
  committed_at?: string;
  failed_at?: string;
  metrics?: AutomaticBuildTaskMetricsV1;
}

export interface AutomaticBuildTaskInspectionV1 {
  version: "automatic_build_task_inspection.v1";
  task_ref: string;
  state: "leased";
  stage: AutomaticBuildTaskLeaseV1["stage"];
  work_unit_id: string;
  attempt: number;
  candidate_sha256?: string;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function taskRef(lease: AutomaticBuildTaskLeaseV1): string {
  return `${lease.target_ref.book_id}:${lease.stage}:${lease.work_unit_id}:${lease.attempt}`;
}

function writeJsonAtomic(file: string, value: unknown): void {
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

function candidateInfo(candidatePath: string, maxBytes = DEFAULT_MAX_CANDIDATE_BYTES): AutomaticBuildCandidateRecordV1 {
  if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) {
    throw new Error(`candidate file does not exist: ${candidatePath}`);
  }
  const bytes = readFileSync(candidatePath);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`candidate exceeds ${maxBytes} bytes: ${bytes.byteLength}`);
  }
  try {
    JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`candidate must contain valid JSON: ${candidatePath}`);
  }
  return {
    version: "automatic_build_candidate_record.v1",
    candidate_path: path.resolve(candidatePath),
    candidate_sha256: sha256(bytes),
    size_bytes: bytes.byteLength,
  };
}

function expectedCandidatePath(leaseRef: string): string {
  return path.join(path.dirname(path.resolve(leaseRef)), "candidate.json");
}

function assertCandidatePath(leaseRef: string, candidatePath: string): string {
  const expected = expectedCandidatePath(leaseRef);
  if (path.resolve(candidatePath) !== expected) {
    throw new Error(`candidate path must be the current attempt mailbox: ${expected}`);
  }
  return expected;
}

function receiptPath(leaseRef: string): string {
  return path.join(path.dirname(path.resolve(leaseRef)), "receipt.json");
}

function failurePath(leaseRef: string): string {
  return path.join(path.dirname(path.resolve(leaseRef)), "failure.json");
}

function ensureReceiptBounded(receipt: AutomaticBuildTaskReceiptV1): void {
  const bytes = Buffer.byteLength(JSON.stringify(receipt));
  if (bytes > MAX_RECEIPT_BYTES) throw new Error(`task receipt exceeds ${MAX_RECEIPT_BYTES} bytes: ${bytes}`);
}

function recordTerminalSuccess(target: AutomaticBuildTarget, lease: AutomaticBuildTaskLeaseV1, committedAt: string): void {
  recordAutomaticBuildAttemptEvent(target, {
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    attempt: lease.attempt,
    event_id: `${lease.stage}:${lease.work_unit_id}:${lease.attempt}:success`,
    outcome: "success",
    created_at: committedAt,
  });
}

function outputItemCount(outputCounts: Record<string, number> | undefined): number | undefined {
  if (!outputCounts) return undefined;
  let total = 0;
  for (const [name, value] of Object.entries(outputCounts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`writer output count must be a non-negative safe integer: ${name}`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("writer output count total exceeds safe integer range");
  }
  return total;
}

export function stageAutomaticBuildCandidate(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  sourcePath: string,
  options: { max_bytes?: number; now?: string } = {},
): AutomaticBuildCandidateRecordV1 {
  readAutomaticBuildLease(target, leaseRef, token);
  const source = candidateInfo(path.resolve(sourcePath), options.max_bytes);
  const destination = expectedCandidatePath(leaseRef);
  if (existsSync(destination)) {
    const existing = candidateInfo(destination, options.max_bytes);
    if (existing.candidate_sha256 === source.candidate_sha256) return existing;
    throw new Error(`candidate already exists with a different hash: ${destination}`);
  }
  assertActiveAutomaticBuildLease(target, leaseRef, token, options.now);
  try {
    writeFileSync(destination, readFileSync(source.candidate_path), { flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = candidateInfo(destination, options.max_bytes);
    if (existing.candidate_sha256 !== source.candidate_sha256) {
      throw new Error(`candidate already exists with a different hash: ${destination}`);
    }
  }
  const staged = candidateInfo(destination, options.max_bytes);
  writeJsonAtomic(path.join(path.dirname(destination), "validation.json"), {
    version: "automatic_build_candidate_validation.v1",
    valid_json: true,
    candidate_sha256: staged.candidate_sha256,
    size_bytes: staged.size_bytes,
  });
  return staged;
}

export function submitAutomaticBuildCandidate(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  candidatePath: string,
  writer: (candidatePath: string) => AutomaticBuildWriterResult,
  options: { now?: string; completed_at?: string } = {},
): AutomaticBuildTaskReceiptV1 {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  const candidate = candidateInfo(assertCandidatePath(leaseRef, candidatePath));
  const existingReceiptPath = receiptPath(leaseRef);
  if (existsSync(existingReceiptPath)) {
    const existing = readJson<AutomaticBuildTaskReceiptV1>(existingReceiptPath);
    if (existing.candidate_sha256 !== candidate.candidate_sha256) {
      throw new Error(`candidate hash does not match committed receipt: ${candidate.candidate_sha256}`);
    }
    recordTerminalSuccess(target, lease, existing.committed_at ?? new Date().toISOString());
    return existing;
  }
  const usage = readAutomaticBuildUsageReceipt(leaseRef);
  assertActiveAutomaticBuildLease(target, leaseRef, token, options.now);
  const submissionPath = path.join(path.dirname(path.resolve(leaseRef)), "submission.json");
  const submission = {
    version: "automatic_build_submission.v1",
    candidate_sha256: candidate.candidate_sha256,
    started_at: options.now ?? new Date().toISOString(),
  };
  try {
    writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readJson<{ candidate_sha256?: string }>(submissionPath);
    if (existing.candidate_sha256 !== candidate.candidate_sha256) {
      throw new Error(`submission candidate hash conflict: ${submissionPath}`);
    }
    if (existsSync(existingReceiptPath)) return readJson<AutomaticBuildTaskReceiptV1>(existingReceiptPath);
    throw new Error(`candidate submission is already in progress: ${submissionPath}`);
  }

  try {
    const result = writer(candidate.candidate_path);
    const artifactPath = path.resolve(result.artifact_path);
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
      throw new Error(`writer did not produce an artifact: ${artifactPath}`);
    }
    const committedAt = options.completed_at ?? (options.now ? options.now : new Date().toISOString());
    if (Boolean(lease.input_hash) !== Boolean(lease.policy_fingerprint)) {
      throw new Error("semantic task lease must bind input_hash and policy_fingerprint together");
    }
    if (lease.input_hash && lease.policy_fingerprint) {
      if (lease.stage === "paper_reading_guide") throw new Error("paper_reading_guide cannot emit a semantic task artifact");
      const payload = JSON.parse(readFileSync(artifactPath, "utf8").replace(/^\uFEFF/, "")) as unknown;
      writeSemanticArtifactEnvelopeFile(artifactPath, buildSemanticArtifactEnvelope({
        target: lease.target_ref,
        stage: lease.stage as SemanticBuildStage,
        work_unit_id: lease.work_unit_id,
        input_hash: lease.input_hash,
        policy_fingerprint: lease.policy_fingerprint,
        provenance: {
          executor: lease.owner,
          ...(usage.model ? { model: usage.model } : {}),
          attempt: lease.attempt,
          generated_at: committedAt,
        },
        payload,
      }));
    }
    const metrics = persistAutomaticBuildTaskMetrics(target, leaseRef, token, {
      status: "committed",
      terminal_at: committedAt,
      writer_started_at: submission.started_at,
      output_bytes: candidate.size_bytes,
      ...(result.output_counts ? { output_items: outputItemCount(result.output_counts) } : {}),
      usage,
    });
    const receipt: AutomaticBuildTaskReceiptV1 = {
      version: "automatic_build_task_receipt.v1",
      task_ref: taskRef(lease),
      state: "committed",
      target_ref: lease.target_ref,
      stage: lease.stage,
      work_unit_id: lease.work_unit_id,
      attempt: lease.attempt,
      candidate_sha256: candidate.candidate_sha256,
      artifact_path: artifactPath,
      artifact_sha256: sha256(readFileSync(artifactPath)),
      ...(result.output_counts ? { output_counts: result.output_counts } : {}),
      committed_at: committedAt,
      metrics,
    };
    ensureReceiptBounded(receipt);
    writeJsonAtomic(existingReceiptPath, receipt);
    recordTerminalSuccess(target, lease, committedAt);
    return receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = options.completed_at ?? (options.now ? options.now : new Date().toISOString());
    const metrics = persistAutomaticBuildTaskMetrics(target, leaseRef, token, {
      status: "retryable_failure",
      terminal_at: failedAt,
      writer_started_at: submission.started_at,
      output_bytes: candidate.size_bytes,
      diagnostic_code: "writer_failed",
      usage,
    });
    const failureReceipt = {
      version: "automatic_build_task_receipt.v1",
      task_ref: taskRef(lease),
      state: "retryable_failure",
      target_ref: lease.target_ref,
      stage: lease.stage,
      work_unit_id: lease.work_unit_id,
      attempt: lease.attempt,
      candidate_sha256: candidate.candidate_sha256,
      diagnostic_code: "writer_failed",
      message,
      failed_at: failedAt,
      metrics,
    } satisfies AutomaticBuildTaskReceiptV1;
    ensureReceiptBounded(failureReceipt);
    writeJsonAtomic(failurePath(leaseRef), failureReceipt);
    rmSync(submissionPath, { force: true });
    throw error;
  }
}

export function failAutomaticBuildTask(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  input: { diagnostic_code: string; message?: string; now?: string },
): AutomaticBuildTaskReceiptV1 {
  const now = input.now ?? new Date().toISOString();
  const lease = assertActiveAutomaticBuildLease(target, leaseRef, token, now);
  const usage = readAutomaticBuildUsageReceipt(leaseRef);
  const candidatePath = expectedCandidatePath(leaseRef);
  const candidate = existsSync(candidatePath) ? candidateInfo(candidatePath) : undefined;
  const metrics = persistAutomaticBuildTaskMetrics(target, leaseRef, token, {
    status: "retryable_failure",
    terminal_at: now,
    output_bytes: candidate?.size_bytes ?? 0,
    diagnostic_code: input.diagnostic_code,
    usage,
  });
  const receipt: AutomaticBuildTaskReceiptV1 = {
    version: "automatic_build_task_receipt.v1",
    task_ref: taskRef(lease),
    state: "retryable_failure",
    target_ref: lease.target_ref,
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    attempt: lease.attempt,
    diagnostic_code: input.diagnostic_code,
    ...(input.message ? { message: input.message } : {}),
    failed_at: now,
    metrics,
  };
  ensureReceiptBounded(receipt);
  writeJsonAtomic(failurePath(leaseRef), receipt);
  recordAutomaticBuildAttemptEvent(target, {
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    attempt: lease.attempt,
    event_id: `${lease.stage}:${lease.work_unit_id}:${lease.attempt}:failure`,
    outcome: "failure",
    diagnostic: input.message ?? input.diagnostic_code,
    created_at: now,
  });
  return receipt;
}

export function inspectAutomaticBuildTask(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
): AutomaticBuildTaskReceiptV1 | AutomaticBuildTaskInspectionV1 {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  if (existsSync(receiptPath(leaseRef))) return readJson<AutomaticBuildTaskReceiptV1>(receiptPath(leaseRef));
  if (existsSync(failurePath(leaseRef))) return readJson<AutomaticBuildTaskReceiptV1>(failurePath(leaseRef));
  const candidatePath = expectedCandidatePath(leaseRef);
  return {
    version: "automatic_build_task_inspection.v1",
    task_ref: taskRef(lease),
    state: "leased",
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    attempt: lease.attempt,
    ...(existsSync(candidatePath) ? { candidate_sha256: candidateInfo(candidatePath).candidate_sha256 } : {}),
  };
}
