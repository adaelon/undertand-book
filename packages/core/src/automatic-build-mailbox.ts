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
import { TextDecoder } from "node:util";
import type { AutomaticBuildTarget } from "./build-orchestrator";
import {
  assertActiveAutomaticBuildLease,
  automaticBuildTaskPolicyBindingFromLease,
  readAutomaticBuildLease,
  type AutomaticBuildTaskLease,
} from "./automatic-build-lease";
import {
  persistAutomaticBuildTaskMetrics,
  readAutomaticBuildInputObservation,
  readAutomaticBuildUsageReceipt,
  type AutomaticBuildTaskMetricsV1,
} from "./automatic-build-metrics";
import {
  recordAutomaticBuildAttemptEvent,
  recordAutomaticBuildSubmitRevision,
} from "./automatic-build-task-store";
import {
  automaticBuildFailureDiagnosticFromCode,
  automaticBuildFailureDiagnosticFromError,
  legacyAutomaticBuildFailureDiagnostic,
  validateAutomaticBuildFailureDiagnostic,
  type AutomaticBuildFailureDiagnosticV2,
} from "./extractor-contract";
import {
  buildSemanticArtifactEnvelope,
  buildSemanticArtifactEnvelopeV3,
  semanticArtifactMatches,
  writeSemanticArtifactEnvelopeFile,
  type SemanticBuildStage,
} from "./semantic-artifact";

const DEFAULT_MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4_096;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
  target_ref: AutomaticBuildTaskLease["target_ref"];
  stage: AutomaticBuildTaskLease["stage"];
  work_unit_id: string;
  attempt: number;
  attempt_scope_digest?: string;
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

export interface AutomaticBuildTaskReceiptV2
  extends Omit<AutomaticBuildTaskReceiptV1, "version" | "diagnostic_code" | "message"> {
  version: "automatic_build_task_receipt.v2";
  failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
}

export type AutomaticBuildTaskReceipt = AutomaticBuildTaskReceiptV1 | AutomaticBuildTaskReceiptV2;

export interface AutomaticBuildTaskInspectionV1 {
  version: "automatic_build_task_inspection.v1";
  task_ref: string;
  state: "leased";
  stage: AutomaticBuildTaskLease["stage"];
  work_unit_id: string;
  attempt: number;
  attempt_scope_digest?: string;
  candidate_sha256?: string;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function taskRef(lease: AutomaticBuildTaskLease): string {
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

interface AutomaticBuildCandidatePayload {
  record: AutomaticBuildCandidateRecordV1;
  payload_bytes: Buffer;
  had_bom: boolean;
}

function readCandidatePayload(
  candidatePath: string,
  maxBytes = DEFAULT_MAX_CANDIDATE_BYTES,
): AutomaticBuildCandidatePayload {
  if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) {
    throw new Error(`candidate file does not exist: ${candidatePath}`);
  }
  const bytes = readFileSync(candidatePath);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`candidate exceeds ${maxBytes} bytes: ${bytes.byteLength}`);
  }
  const hadBom = bytes.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM);
  const payloadBytes = hadBom ? bytes.subarray(UTF8_BOM.byteLength) : bytes;
  try {
    JSON.parse(UTF8_DECODER.decode(payloadBytes));
  } catch {
    throw new Error(`candidate must contain valid UTF-8 JSON (valid JSON required): ${candidatePath}`);
  }
  return {
    record: {
      version: "automatic_build_candidate_record.v1",
      candidate_path: path.resolve(candidatePath),
      candidate_sha256: sha256(payloadBytes),
      size_bytes: payloadBytes.byteLength,
    },
    payload_bytes: payloadBytes,
    had_bom: hadBom,
  };
}

function candidateInfo(candidatePath: string, maxBytes = DEFAULT_MAX_CANDIDATE_BYTES): AutomaticBuildCandidateRecordV1 {
  return readCandidatePayload(candidatePath, maxBytes).record;
}

function normalizeCandidatePayload(candidate: AutomaticBuildCandidatePayload): void {
  if (!candidate.had_bom) return;
  writeFileSync(candidate.record.candidate_path, candidate.payload_bytes);
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

function ensureReceiptBounded(receipt: AutomaticBuildTaskReceiptV2): void {
  const bytes = Buffer.byteLength(JSON.stringify(receipt));
  if (bytes > MAX_RECEIPT_BYTES) throw new Error(`task receipt exceeds ${MAX_RECEIPT_BYTES} bytes: ${bytes}`);
}

export function normalizeAutomaticBuildTaskReceipt(
  receipt: AutomaticBuildTaskReceipt,
): AutomaticBuildTaskReceiptV2 {
  if (receipt.version === "automatic_build_task_receipt.v2") {
    if (receipt.state === "retryable_failure") {
      if (!receipt.failure_diagnostic) throw new Error("v2 failure receipt is missing its typed diagnostic");
      return {
        ...receipt,
        failure_diagnostic: validateAutomaticBuildFailureDiagnostic(receipt.failure_diagnostic),
      };
    }
    if (receipt.failure_diagnostic !== undefined) {
      throw new Error("committed task receipt contains a failure diagnostic");
    }
    return receipt;
  }
  if (receipt.version !== "automatic_build_task_receipt.v1") {
    throw new Error("automatic build task receipt version is unsupported");
  }
  const { diagnostic_code: _diagnosticCode, message: _message, version: _version, ...safe } = receipt;
  return {
    ...safe,
    version: "automatic_build_task_receipt.v2",
    ...(receipt.state === "retryable_failure"
      ? { failure_diagnostic: legacyAutomaticBuildFailureDiagnostic() }
      : {}),
  };
}

export function readAutomaticBuildTaskReceiptFile(file: string): AutomaticBuildTaskReceiptV2 {
  return normalizeAutomaticBuildTaskReceipt(readJson<AutomaticBuildTaskReceipt>(file));
}

function recordTerminalSuccess(target: AutomaticBuildTarget, lease: AutomaticBuildTaskLease, committedAt: string): void {
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
  const source = readCandidatePayload(path.resolve(sourcePath), options.max_bytes);
  const destination = expectedCandidatePath(leaseRef);
  if (existsSync(destination)) {
    const existing = readCandidatePayload(destination, options.max_bytes);
    if (existing.record.candidate_sha256 === source.record.candidate_sha256) {
      normalizeCandidatePayload(existing);
      return existing.record;
    }
    throw new Error(`candidate already exists with a different hash: ${destination}`);
  }
  assertActiveAutomaticBuildLease(target, leaseRef, token, options.now);
  try {
    writeFileSync(destination, source.payload_bytes, { flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readCandidatePayload(destination, options.max_bytes);
    if (existing.record.candidate_sha256 !== source.record.candidate_sha256) {
      throw new Error(`candidate already exists with a different hash: ${destination}`);
    }
    normalizeCandidatePayload(existing);
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
): AutomaticBuildTaskReceiptV2 {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  const taskBinding = automaticBuildTaskPolicyBindingFromLease(lease);
  if (taskBinding && "proof_digest" in taskBinding) {
    const observation = readAutomaticBuildInputObservation(leaseRef);
    if (!observation || observation.version !== "automatic_build_input_observation.v2"
      || observation.input_sha256 !== taskBinding.input_hash
      || observation.proof_digest !== taskBinding.proof_digest) {
      throw new Error("v3 candidate submission requires a matching proof-bound input observation");
    }
  }
  const candidatePayload = readCandidatePayload(assertCandidatePath(leaseRef, candidatePath));
  const candidate = candidatePayload.record;
  const existingReceiptPath = receiptPath(leaseRef);
  if (existsSync(existingReceiptPath)) {
    const existing = readAutomaticBuildTaskReceiptFile(existingReceiptPath);
    if (existing.candidate_sha256 !== candidate.candidate_sha256) {
      throw new Error(`candidate hash does not match committed receipt: ${candidate.candidate_sha256}`);
    }
    if (existing.attempt_scope_digest !== lease.attempt_scope_digest) {
      throw new Error("committed receipt attempt scope does not match its lease");
    }
    recordAutomaticBuildSubmitRevision(target, {
      stage: lease.stage,
      work_unit_id: lease.work_unit_id,
      physical_attempt: lease.attempt,
      candidate_sha256: candidate.candidate_sha256,
      ...(options.now ? { created_at: options.now } : {}),
    });
    recordTerminalSuccess(target, lease, existing.committed_at ?? new Date().toISOString());
    return existing;
  }
  const usage = readAutomaticBuildUsageReceipt(leaseRef);
  assertActiveAutomaticBuildLease(target, leaseRef, token, options.now);
  recordAutomaticBuildSubmitRevision(target, {
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    physical_attempt: lease.attempt,
    candidate_sha256: candidate.candidate_sha256,
    ...(options.now ? { created_at: options.now } : {}),
  });
  normalizeCandidatePayload(candidatePayload);
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
    if (existsSync(existingReceiptPath)) return readAutomaticBuildTaskReceiptFile(existingReceiptPath);
    throw new Error(`candidate submission is already in progress: ${submissionPath}`);
  }

  try {
    const result = writer(candidate.candidate_path);
    const artifactPath = path.resolve(result.artifact_path);
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
      throw new Error(`writer did not produce an artifact: ${artifactPath}`);
    }
    const committedAt = options.completed_at ?? (options.now ? options.now : new Date().toISOString());
    if (taskBinding) {
      if (lease.stage === "paper_reading_guide") throw new Error("paper_reading_guide cannot emit a semantic task artifact");
      const payload = JSON.parse(readFileSync(artifactPath, "utf8").replace(/^\uFEFF/, "")) as unknown;
      const envelopeInput = {
        target: lease.target_ref,
        stage: lease.stage as SemanticBuildStage,
        work_unit_id: lease.work_unit_id,
        input_hash: taskBinding.input_hash,
        policy_fingerprint: taskBinding.policy_fingerprint,
        provenance: {
          executor: lease.owner,
          ...(usage.model ? { model: usage.model } : {}),
          attempt: lease.attempt,
          generated_at: committedAt,
        },
        payload,
      };
      const writerAlreadyProducedV3 = "proof_digest" in taskBinding
        && payload
        && typeof payload === "object"
        && (payload as { version?: unknown }).version === "semantic_task_artifact.v3";
      if (writerAlreadyProducedV3) {
        if (!semanticArtifactMatches(payload, {
          target: lease.target_ref,
          stage: lease.stage as SemanticBuildStage,
          work_unit_id: lease.work_unit_id,
          input_hash: taskBinding.input_hash,
          proof_digest: taskBinding.proof_digest,
          policy_set_digest: taskBinding.policy_set_digest,
          policy_fingerprint: taskBinding.policy_fingerprint,
        })) {
          throw new Error("v3 writer artifact does not match its proof-bound lease");
        }
      } else {
        writeSemanticArtifactEnvelopeFile(artifactPath, "proof_digest" in taskBinding
          ? buildSemanticArtifactEnvelopeV3({
              ...envelopeInput,
              proof_digest: taskBinding.proof_digest,
              policy_set_digest: taskBinding.policy_set_digest,
            })
          : buildSemanticArtifactEnvelope(envelopeInput));
      }
    }
    const metrics = persistAutomaticBuildTaskMetrics(target, leaseRef, token, {
      status: "committed",
      terminal_at: committedAt,
      writer_started_at: submission.started_at,
      output_bytes: candidate.size_bytes,
      ...(result.output_counts ? { output_items: outputItemCount(result.output_counts) } : {}),
      usage,
    });
    const receipt: AutomaticBuildTaskReceiptV2 = {
      version: "automatic_build_task_receipt.v2",
      task_ref: taskRef(lease),
      state: "committed",
      target_ref: lease.target_ref,
      stage: lease.stage,
      work_unit_id: lease.work_unit_id,
      attempt: lease.attempt,
      ...(lease.attempt_scope_digest ? { attempt_scope_digest: lease.attempt_scope_digest } : {}),
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
    const failureDiagnostic = automaticBuildFailureDiagnosticFromError(error);
    const failedAt = options.completed_at ?? (options.now ? options.now : new Date().toISOString());
    const metrics = persistAutomaticBuildTaskMetrics(target, leaseRef, token, {
      status: "retryable_failure",
      terminal_at: failedAt,
      writer_started_at: submission.started_at,
      output_bytes: candidate.size_bytes,
      diagnostic_code: failureDiagnostic.code,
      usage,
    });
    const failureReceipt = {
      version: "automatic_build_task_receipt.v2",
      task_ref: taskRef(lease),
      state: "retryable_failure",
      target_ref: lease.target_ref,
      stage: lease.stage,
      work_unit_id: lease.work_unit_id,
      attempt: lease.attempt,
      ...(lease.attempt_scope_digest ? { attempt_scope_digest: lease.attempt_scope_digest } : {}),
      candidate_sha256: candidate.candidate_sha256,
      failure_diagnostic: failureDiagnostic,
      failed_at: failedAt,
      metrics,
    } satisfies AutomaticBuildTaskReceiptV2;
    ensureReceiptBounded(failureReceipt);
    writeJsonAtomic(failurePath(leaseRef), failureReceipt);
    recordAutomaticBuildAttemptEvent(target, {
      stage: lease.stage,
      work_unit_id: lease.work_unit_id,
      attempt: lease.attempt,
      event_id: `${lease.stage}:${lease.work_unit_id}:${lease.attempt}:failure`,
      outcome: "failure",
      failure_diagnostic: failureDiagnostic,
      created_at: failedAt,
    });
    return failureReceipt;
  }
}

export function failAutomaticBuildTask(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  input: {
    diagnostic_code?: string;
    failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
    /** @deprecated Free text is accepted for V1 callers but is never persisted. */
    message?: string;
    now?: string;
  },
): AutomaticBuildTaskReceiptV2 {
  const now = input.now ?? new Date().toISOString();
  const lease = assertActiveAutomaticBuildLease(target, leaseRef, token, now);
  const failureDiagnostic = input.failure_diagnostic
    ? validateAutomaticBuildFailureDiagnostic(input.failure_diagnostic)
    : automaticBuildFailureDiagnosticFromCode(input.diagnostic_code);
  const usage = readAutomaticBuildUsageReceipt(leaseRef);
  const candidatePath = expectedCandidatePath(leaseRef);
  const candidate = existsSync(candidatePath) ? candidateInfo(candidatePath) : undefined;
  const metrics = persistAutomaticBuildTaskMetrics(target, leaseRef, token, {
    status: "retryable_failure",
    terminal_at: now,
    output_bytes: candidate?.size_bytes ?? 0,
    diagnostic_code: failureDiagnostic.code,
    usage,
  });
  const receipt: AutomaticBuildTaskReceiptV2 = {
    version: "automatic_build_task_receipt.v2",
    task_ref: taskRef(lease),
    state: "retryable_failure",
    target_ref: lease.target_ref,
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    attempt: lease.attempt,
    ...(lease.attempt_scope_digest ? { attempt_scope_digest: lease.attempt_scope_digest } : {}),
    failure_diagnostic: failureDiagnostic,
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
    failure_diagnostic: failureDiagnostic,
    created_at: now,
  });
  return receipt;
}

export function inspectAutomaticBuildTask(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
): AutomaticBuildTaskReceiptV2 | AutomaticBuildTaskInspectionV1 {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  if (existsSync(receiptPath(leaseRef))) return readAutomaticBuildTaskReceiptFile(receiptPath(leaseRef));
  if (existsSync(failurePath(leaseRef))) return readAutomaticBuildTaskReceiptFile(failurePath(leaseRef));
  const candidatePath = expectedCandidatePath(leaseRef);
  return {
    version: "automatic_build_task_inspection.v1",
    task_ref: taskRef(lease),
    state: "leased",
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    attempt: lease.attempt,
    ...(lease.attempt_scope_digest ? { attempt_scope_digest: lease.attempt_scope_digest } : {}),
    ...(existsSync(candidatePath) ? { candidate_sha256: candidateInfo(candidatePath).candidate_sha256 } : {}),
  };
}
