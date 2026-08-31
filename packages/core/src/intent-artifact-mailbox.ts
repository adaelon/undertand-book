import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalBuildJson } from "./build-intent";
import {
  acceptIntentArtifactCandidate,
  type AcceptIntentArtifactCandidateInput,
  type AcceptedIntentArtifactV3,
  type IntentArtifactCompatibilityType,
  type IntentArtifactTaskEnvelopeV3,
} from "./intent-artifact";

const DEFAULT_MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4_096;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DIAGNOSTIC_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const V3_ATTEMPTS_DIRECTORY = "attempts-v3";
const V3_OWNER_FILE = "owner.v2.json";
const V3_ACCEPTED_FILE = "accepted.v3.json";

interface IntentArtifactMailboxOwnerV2 {
  version: "intent_artifact_mailbox_owner.v2";
  task_id: string;
  book_id: string;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  blueprint_id: string;
  blueprint_version: string;
}

interface IntentArtifactTaskAttemptV1 {
  version: "intent_artifact_task_attempt.v1";
  task_id: string;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  attempt: number;
  state: "pending";
  created_at: string;
}

export interface IntentArtifactTaskAttemptHandoffV2 {
  version: "intent_artifact_task_attempt_handoff.v2";
  task_id: string;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  blueprint_id: string;
  blueprint_version: string;
  attempt: number;
  task_path: string;
}

export interface IntentArtifactMailboxReceiptV2 {
  version: "intent_artifact_mailbox_receipt.v2";
  state: "committed" | "retryable_failure";
  task_id: string;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  blueprint_id: string;
  blueprint_version: string;
  attempt: number;
  candidate_sha256?: string;
  payload_digest?: string;
  record_count?: number;
  relation_count?: number;
  evidence_reference_count?: number;
  diagnostic_code?: string;
  terminal_at: string;
}

export interface IntentArtifactTaskAttemptInspectionV1 {
  version: "intent_artifact_task_attempt_inspection.v1";
  state: "pending";
  task_id: string;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  attempt: number;
  created_at: string;
}

export interface IntentArtifactTaskAttemptExecutionContextV1 {
  version: "intent_artifact_task_attempt_execution_context.v1";
  private_root: string;
  artifact_directory: string;
  attempt_directory: string;
  task_path: string;
  candidate_path: string;
  task: IntentArtifactTaskEnvelopeV3;
  attempt: number;
}

export interface OpenIntentArtifactTaskAttemptInput {
  private_root: string;
  artifact_directory: string;
  task: IntentArtifactTaskEnvelopeV3;
  created_at: string;
  max_attempts?: number;
}

export interface FailIntentArtifactTaskAttemptInput {
  private_root: string;
  task_path: string;
  diagnostic_code: string;
  message?: string;
  failed_at: string;
}

export interface SubmitIntentArtifactTaskAttemptInput extends Omit<AcceptIntentArtifactCandidateInput, "task" | "candidate"> {
  private_root: string;
  task_path: string;
  max_candidate_bytes?: number;
}

interface AttemptPaths {
  privateRoot: string;
  artifactDirectory: string;
  attemptDirectory: string;
  taskPath: string;
  candidatePath: string;
  receiptPath: string;
  failurePath: string;
  failureDetailPath: string;
  acceptedPath: string;
}

interface CandidateFile {
  value: unknown;
  sha256: string;
  bytes: Buffer;
}

export interface IntentArtifactCandidateStagingV1 {
  version: "intent_artifact_candidate_staging.v1";
  candidate_sha256: string;
  byte_length: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: unknown): string {
  return sha256(canonicalBuildJson(value));
}

function assertIsoDateTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value)) || !/[zZ]|[+-]\d\d:\d\d$/u.test(value)) {
    throw new Error(`${field} must be an ISO date-time with an offset`);
  }
}

function readJson<T>(file: string): T {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new Error(`intent artifact mailbox JSON must be a real file: ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(`intent artifact mailbox contains invalid JSON: ${file}`, { cause: error });
  }
}

function ensureBounded(value: IntentArtifactMailboxReceiptV2): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_RECEIPT_BYTES) throw new Error(`intent artifact mailbox receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
}

function writeJsonOnce(file: string, value: unknown, label: string): void {
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
      throw new Error(`${label} path must be a real file without symlinks`);
    }
    if (canonicalBuildJson(readJson(file)) !== canonicalBuildJson(value)) {
      throw new Error(`${label} already exists with a conflicting body`);
    }
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (canonicalBuildJson(readJson(file)) !== canonicalBuildJson(value)) {
      throw new Error(`${label} already exists with a conflicting body`);
    }
  }
}

function assertDirectoryWithoutSymlink(directory: string, field: string): string {
  if (!path.isAbsolute(directory)) throw new Error(`${field} must be an absolute path`);
  if (!existsSync(directory)) throw new Error(`${field} does not exist: ${directory}`);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${field} must be a real directory without symlinks`);
  return realpathSync.native(directory);
}

function isOutside(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function assertPrivateDescendant(privateRootInput: string, targetInput: string, field: string): {
  privateRoot: string;
  target: string;
} {
  const privateRoot = assertDirectoryWithoutSymlink(privateRootInput, "private_root");
  if (!path.isAbsolute(targetInput)) throw new Error(`${field} must be an absolute path`);
  const target = path.resolve(targetInput);
  const lexicalRelative = path.relative(path.resolve(privateRootInput), target);
  if (!lexicalRelative || isOutside(lexicalRelative)) {
    throw new Error(`${field} must stay within the private root`);
  }
  let cursor = path.resolve(privateRootInput);
  for (const segment of lexicalRelative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${field} path must not contain a symlink`);
    }
  }
  if (existsSync(target)) {
    const realTarget = realpathSync.native(target);
    const realRelative = path.relative(privateRoot, realTarget);
    if (!realRelative || isOutside(realRelative)) throw new Error(`${field} must stay within the private root`);
    return { privateRoot, target: realTarget };
  }
  return { privateRoot, target };
}

function artifactOwner(task: IntentArtifactTaskEnvelopeV3): IntentArtifactMailboxOwnerV2 {
  return {
    version: "intent_artifact_mailbox_owner.v2",
    task_id: task.task_id,
    book_id: task.book_id,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
  };
}

function assertTaskEnvelope(task: IntentArtifactTaskEnvelopeV3): void {
  canonicalBuildJson(task);
  if (task.version !== "intent_artifact_task_envelope.v3"
    || task.privacy !== "reader_private"
    || !task.task_id
    || !task.book_id
    || !task.intent_id
    || !task.plan_id
    || !Number.isSafeInteger(task.intent_revision) || task.intent_revision < 1
    || !Number.isSafeInteger(task.plan_revision) || task.plan_revision < 1
    || !task.artifact
    || !task.artifact.artifact_id
    || !task.artifact.artifact_type
    || !task.artifact.blueprint_id
    || !task.artifact.blueprint_version) {
    throw new Error("invalid intent artifact task envelope");
  }
}

function handoff(task: IntentArtifactTaskEnvelopeV3, attempt: number, taskPath: string): IntentArtifactTaskAttemptHandoffV2 {
  return {
    version: "intent_artifact_task_attempt_handoff.v2",
    task_id: task.task_id,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
    attempt,
    task_path: taskPath,
  };
}

function attemptDirectories(artifactDirectory: string): Array<{ attempt: number; directory: string }> {
  const root = path.join(artifactDirectory, V3_ATTEMPTS_DIRECTORY);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{6}$/u.test(entry.name))
    .map((entry) => ({ attempt: Number(entry.name), directory: path.join(root, entry.name) }))
    .sort((left, right) => left.attempt - right.attempt);
}

function resolveAttemptPaths(privateRootInput: string, taskPathInput: string): AttemptPaths {
  const checked = assertPrivateDescendant(privateRootInput, taskPathInput, "task_path");
  if (!existsSync(checked.target) || lstatSync(checked.target).isSymbolicLink() || !lstatSync(checked.target).isFile()) {
    throw new Error(`task_path must identify a real task file: ${taskPathInput}`);
  }
  if (path.basename(checked.target) !== "task.json") throw new Error("task_path must end with task.json");
  const attemptDirectory = path.dirname(checked.target);
  const attemptsDirectory = path.dirname(attemptDirectory);
  if (path.basename(attemptsDirectory) !== V3_ATTEMPTS_DIRECTORY || !/^\d{6}$/u.test(path.basename(attemptDirectory))) {
    throw new Error("task_path is not inside an intent artifact attempt directory");
  }
  const artifactDirectory = path.dirname(attemptsDirectory);
  return {
    privateRoot: checked.privateRoot,
    artifactDirectory,
    attemptDirectory,
    taskPath: checked.target,
    candidatePath: path.join(attemptDirectory, "candidate.json"),
    receiptPath: path.join(attemptDirectory, "receipt.json"),
    failurePath: path.join(attemptDirectory, "failure.json"),
    failureDetailPath: path.join(attemptDirectory, "failure-detail.json"),
    acceptedPath: path.join(artifactDirectory, V3_ACCEPTED_FILE),
  };
}

function readTask(paths: AttemptPaths): { task: IntentArtifactTaskEnvelopeV3; attempt: IntentArtifactTaskAttemptV1 } {
  const task = readJson<IntentArtifactTaskEnvelopeV3>(paths.taskPath);
  const attempt = readJson<IntentArtifactTaskAttemptV1>(path.join(paths.attemptDirectory, "attempt.json"));
  assertTaskEnvelope(task);
  if (task.version !== "intent_artifact_task_envelope.v3" || attempt.version !== "intent_artifact_task_attempt.v1") {
    throw new Error("unsupported intent artifact task attempt version");
  }
  if (attempt.task_id !== task.task_id
    || attempt.artifact_id !== task.artifact.artifact_id
    || attempt.artifact_type !== task.artifact.artifact_type
    || attempt.attempt !== Number(path.basename(paths.attemptDirectory))) {
    throw new Error("intent artifact attempt identity does not match task_path");
  }
  const owner = readJson<IntentArtifactMailboxOwnerV2>(path.join(paths.artifactDirectory, V3_OWNER_FILE));
  if (canonicalBuildJson(owner) !== canonicalBuildJson(artifactOwner(task))) {
    throw new Error("intent artifact mailbox owner does not match task envelope");
  }
  return { task, attempt };
}

function readCandidate(file: string, maxBytes: number): CandidateFile {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new Error("candidate must be written to the current task-owned attempt mailbox");
  }
  const bytes = readFileSync(file);
  if (bytes.byteLength > maxBytes) throw new Error(`candidate exceeds ${maxBytes} bytes`);
  const payload = bytes.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM)
    ? bytes.subarray(UTF8_BOM.byteLength)
    : bytes;
  try {
    return {
      value: JSON.parse(UTF8_DECODER.decode(payload)),
      sha256: sha256(payload),
      bytes: payload,
    };
  } catch (error) {
    throw new Error("candidate must contain valid UTF-8 JSON", { cause: error });
  }
}

function candidateStaging(candidate: CandidateFile): IntentArtifactCandidateStagingV1 {
  return {
    version: "intent_artifact_candidate_staging.v1",
    candidate_sha256: candidate.sha256,
    byte_length: candidate.bytes.byteLength,
  };
}

export function stageIntentArtifactTaskCandidate(input: {
  private_root: string;
  task_path: string;
  candidate_path: string;
  max_candidate_bytes?: number;
}): IntentArtifactCandidateStagingV1 {
  const paths = resolveAttemptPaths(input.private_root, input.task_path);
  const { task, attempt } = readTask(paths);
  if (existsSync(paths.failurePath)) {
    readStoredReceipt(paths, task, attempt, "retryable_failure");
    throw new Error("intent artifact attempt already failed; open a retry attempt");
  }
  const maxBytes = input.max_candidate_bytes ?? DEFAULT_MAX_CANDIDATE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("max_candidate_bytes must be a positive safe integer");
  }
  const source = readCandidate(path.resolve(input.candidate_path), maxBytes);
  if (existsSync(paths.candidatePath)) {
    const existing = readCandidate(paths.candidatePath, maxBytes);
    if (existing.sha256 !== source.sha256) {
      throw new Error("intent artifact candidate already exists with a different hash");
    }
    return candidateStaging(existing);
  }
  if (existsSync(paths.receiptPath)) {
    readStoredReceipt(paths, task, attempt, "committed");
    throw new Error("committed intent artifact attempt is missing its candidate mailbox");
  }
  try {
    writeFileSync(paths.candidatePath, source.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readCandidate(paths.candidatePath, maxBytes);
    if (existing.sha256 !== source.sha256) {
      throw new Error("intent artifact candidate already exists with a different hash");
    }
    return candidateStaging(existing);
  }
  return candidateStaging(source);
}

export function openIntentArtifactTaskAttempt(
  input: OpenIntentArtifactTaskAttemptInput,
): IntentArtifactTaskAttemptHandoffV2 {
  assertTaskEnvelope(input.task);
  assertIsoDateTime(input.created_at, "created_at");
  const maxAttempts = input.max_attempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("max_attempts must be a positive safe integer");
  }
  const checked = assertPrivateDescendant(input.private_root, input.artifact_directory, "artifact_directory");
  mkdirSync(checked.target, { recursive: true });
  const artifactDirectory = assertPrivateDescendant(
    checked.privateRoot,
    realpathSync.native(checked.target),
    "artifact_directory",
  ).target;
  const owner = artifactOwner(input.task);
  const ownerPath = path.join(artifactDirectory, V3_OWNER_FILE);
  if (existsSync(ownerPath) && canonicalBuildJson(readJson(ownerPath)) !== canonicalBuildJson(owner)) {
    throw new Error("intent artifact mailbox already has a different owner");
  }
  writeJsonOnce(ownerPath, owner, "intent artifact mailbox owner");
  if (existsSync(path.join(artifactDirectory, V3_ACCEPTED_FILE))) {
    throw new Error("intent artifact mailbox is already committed");
  }

  const prior = attemptDirectories(artifactDirectory);
  const latest = prior.at(-1);
  if (latest) {
    const latestTaskPath = path.join(latest.directory, "task.json");
    if (!existsSync(latestTaskPath)) throw new Error("intent artifact mailbox contains an incomplete attempt");
    if (!existsSync(path.join(latest.directory, "failure.json"))) {
      if (existsSync(path.join(latest.directory, "receipt.json"))) {
        throw new Error("intent artifact mailbox is already committed");
      }
      const existingTask = readJson<IntentArtifactTaskEnvelopeV3>(latestTaskPath);
      if (canonicalBuildJson(existingTask) !== canonicalBuildJson(input.task)) {
        throw new Error("pending intent artifact attempt has a conflicting task body");
      }
      return handoff(input.task, latest.attempt, latestTaskPath);
    }
  }
  const nextAttempt = (latest?.attempt ?? 0) + 1;
  if (nextAttempt > maxAttempts) throw new Error(`intent artifact retry limit reached: ${maxAttempts}`);
  const attemptDirectory = path.join(
    artifactDirectory,
    V3_ATTEMPTS_DIRECTORY,
    String(nextAttempt).padStart(6, "0"),
  );
  if (existsSync(attemptDirectory)) throw new Error(`intent artifact attempt already exists: ${nextAttempt}`);
  mkdirSync(attemptDirectory, { recursive: true });
  const taskPath = path.join(attemptDirectory, "task.json");
  writeJsonOnce(taskPath, input.task, "intent artifact task envelope");
  writeJsonOnce(path.join(attemptDirectory, "attempt.json"), {
    version: "intent_artifact_task_attempt.v1",
    task_id: input.task.task_id,
    artifact_id: input.task.artifact.artifact_id,
    artifact_type: input.task.artifact.artifact_type,
    attempt: nextAttempt,
    state: "pending",
    created_at: input.created_at,
  } satisfies IntentArtifactTaskAttemptV1, "intent artifact attempt metadata");
  return handoff(input.task, nextAttempt, taskPath);
}

function writeFailure(
  paths: AttemptPaths,
  task: IntentArtifactTaskEnvelopeV3,
  attempt: IntentArtifactTaskAttemptV1,
  input: { diagnostic_code: string; message?: string; failed_at: string },
): IntentArtifactMailboxReceiptV2 {
  if (!DIAGNOSTIC_CODE.test(input.diagnostic_code)) {
    throw new Error("diagnostic_code must be a path-safe lowercase code");
  }
  assertIsoDateTime(input.failed_at, "failed_at");
  if (existsSync(paths.receiptPath)) throw new Error("cannot fail a committed intent artifact attempt");
  const receipt: IntentArtifactMailboxReceiptV2 = {
    version: "intent_artifact_mailbox_receipt.v2",
    state: "retryable_failure",
    task_id: task.task_id,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
    attempt: attempt.attempt,
    diagnostic_code: input.diagnostic_code,
    terminal_at: input.failed_at,
  };
  ensureBounded(receipt);
  writeJsonOnce(paths.failurePath, receipt, "intent artifact failure receipt");
  if (input.message) {
    writeJsonOnce(paths.failureDetailPath, {
      version: "intent_artifact_failure_detail.v1",
      task_id: task.task_id,
      attempt: attempt.attempt,
      diagnostic_code: input.diagnostic_code,
      message: input.message,
      failed_at: input.failed_at,
    }, "intent artifact private failure detail");
  }
  return receipt;
}

export function failIntentArtifactTaskAttempt(
  input: FailIntentArtifactTaskAttemptInput,
): IntentArtifactMailboxReceiptV2 {
  const paths = resolveAttemptPaths(input.private_root, input.task_path);
  const { task, attempt } = readTask(paths);
  if (existsSync(paths.failurePath)) {
    const existing = readStoredReceipt(paths, task, attempt, "retryable_failure");
    if (existing.diagnostic_code !== input.diagnostic_code) {
      throw new Error("intent artifact attempt already failed with a different diagnostic code");
    }
    return existing;
  }
  return writeFailure(paths, task, attempt, input);
}

export function inspectIntentArtifactTaskAttempt(input: {
  private_root: string;
  task_path: string;
}): IntentArtifactMailboxReceiptV2 | IntentArtifactTaskAttemptInspectionV1 {
  const paths = resolveAttemptPaths(input.private_root, input.task_path);
  const { task, attempt } = readTask(paths);
  if (existsSync(paths.receiptPath)) return readStoredReceipt(paths, task, attempt, "committed");
  if (existsSync(paths.failurePath)) return readStoredReceipt(paths, task, attempt, "retryable_failure");
  return {
    version: "intent_artifact_task_attempt_inspection.v1",
    state: "pending",
    task_id: task.task_id,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    attempt: attempt.attempt,
    created_at: attempt.created_at,
  };
}

export function readIntentArtifactTaskAttemptExecutionContext(input: {
  private_root: string;
  task_path: string;
}): IntentArtifactTaskAttemptExecutionContextV1 {
  const paths = resolveAttemptPaths(input.private_root, input.task_path);
  const { task, attempt } = readTask(paths);
  return {
    version: "intent_artifact_task_attempt_execution_context.v1",
    private_root: paths.privateRoot,
    artifact_directory: paths.artifactDirectory,
    attempt_directory: paths.attemptDirectory,
    task_path: paths.taskPath,
    candidate_path: paths.candidatePath,
    task,
    attempt: attempt.attempt,
  };
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new Error(`${label} has unrecognized keys: ${unknown.join(", ")}`);
}

function readStoredReceipt(
  paths: AttemptPaths,
  task: IntentArtifactTaskEnvelopeV3,
  attempt: IntentArtifactTaskAttemptV1,
  expectedState: IntentArtifactMailboxReceiptV2["state"],
): IntentArtifactMailboxReceiptV2 {
  const file = expectedState === "committed" ? paths.receiptPath : paths.failurePath;
  const value = readJson<unknown>(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("intent artifact mailbox receipt must be an object");
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, [
    "version",
    "state",
    "task_id",
    "intent_id",
    "intent_revision",
    "plan_id",
    "plan_revision",
    "artifact_id",
    "artifact_type",
    "blueprint_id",
    "blueprint_version",
    "attempt",
    "candidate_sha256",
    "payload_digest",
    "record_count",
    "relation_count",
    "evidence_reference_count",
    "diagnostic_code",
    "terminal_at",
  ], "intent artifact mailbox receipt");
  const receipt = record as unknown as IntentArtifactMailboxReceiptV2;
  ensureBounded(receipt);
  if (receipt.version !== "intent_artifact_mailbox_receipt.v2"
    || receipt.state !== expectedState
    || receipt.task_id !== task.task_id
    || receipt.intent_id !== task.intent_id
    || receipt.intent_revision !== task.intent_revision
    || receipt.plan_id !== task.plan_id
    || receipt.plan_revision !== task.plan_revision
    || receipt.artifact_id !== task.artifact.artifact_id
    || receipt.artifact_type !== task.artifact.artifact_type
    || receipt.blueprint_id !== task.artifact.blueprint_id
    || receipt.blueprint_version !== task.artifact.blueprint_version
    || receipt.attempt !== attempt.attempt
  ) {
    throw new Error("intent artifact mailbox receipt identity mismatch");
  }
  assertIsoDateTime(receipt.terminal_at, "receipt terminal_at");
  if (expectedState === "retryable_failure") {
    if (!receipt.diagnostic_code || !DIAGNOSTIC_CODE.test(receipt.diagnostic_code)) {
      throw new Error("intent artifact failure receipt requires a valid diagnostic_code");
    }
    return receipt;
  }
  if (!receipt.candidate_sha256 || !SHA256.test(receipt.candidate_sha256)
    || !receipt.payload_digest || !SHA256.test(receipt.payload_digest)
    || !Number.isSafeInteger(receipt.record_count) || receipt.record_count! < 0
    || !Number.isSafeInteger(receipt.relation_count) || receipt.relation_count! < 0
    || !Number.isSafeInteger(receipt.evidence_reference_count) || receipt.evidence_reference_count! < 0
    || receipt.diagnostic_code) {
    throw new Error("committed intent artifact receipt is incomplete");
  }
  const candidate = readCandidate(paths.candidatePath, DEFAULT_MAX_CANDIDATE_BYTES);
  if (candidate.sha256 !== receipt.candidate_sha256) {
    throw new Error("candidate hash does not match committed intent artifact receipt");
  }
  const accepted = readJson<AcceptedIntentArtifactV3>(paths.acceptedPath);
  if (accepted.version !== "intent_artifact_accepted.v3"
    || accepted.payload_digest !== receipt.payload_digest
    || digestJson(accepted.payload) !== receipt.payload_digest
    || accepted.task_id !== task.task_id
    || accepted.book_id !== task.book_id
    || accepted.source_fingerprint !== task.source_fingerprint
    || accepted.intent_id !== task.intent_id
    || accepted.intent_revision !== task.intent_revision
    || accepted.plan_id !== task.plan_id
    || accepted.plan_revision !== task.plan_revision
    || accepted.artifact_id !== task.artifact.artifact_id
    || accepted.blueprint_id !== task.artifact.blueprint_id
    || accepted.blueprint_version !== task.artifact.blueprint_version
    || accepted.payload.blueprint_id !== task.artifact.blueprint_id
    || accepted.payload.blueprint_version !== task.artifact.blueprint_version) {
    throw new Error("accepted artifact does not match committed intent artifact receipt");
  }
  return receipt;
}

function committedReceipt(
  task: IntentArtifactTaskEnvelopeV3,
  attempt: IntentArtifactTaskAttemptV1,
  candidateSha256: string,
  accepted: AcceptedIntentArtifactV3,
  gateReceipt: ReturnType<typeof acceptIntentArtifactCandidate>["receipt"],
): IntentArtifactMailboxReceiptV2 {
  void accepted;
  return {
    version: "intent_artifact_mailbox_receipt.v2",
    state: "committed",
    task_id: task.task_id,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
    attempt: attempt.attempt,
    candidate_sha256: candidateSha256,
    payload_digest: gateReceipt.payload_digest,
    record_count: gateReceipt.record_count,
    relation_count: gateReceipt.relation_count,
    evidence_reference_count: gateReceipt.evidence_reference_count,
    terminal_at: gateReceipt.accepted_at,
  };
}

export function submitIntentArtifactTaskAttempt(
  input: SubmitIntentArtifactTaskAttemptInput,
): IntentArtifactMailboxReceiptV2 {
  const paths = resolveAttemptPaths(input.private_root, input.task_path);
  const { task, attempt } = readTask(paths);
  const candidate = readCandidate(paths.candidatePath, input.max_candidate_bytes ?? DEFAULT_MAX_CANDIDATE_BYTES);
  if (existsSync(paths.receiptPath)) {
    return readStoredReceipt(paths, task, attempt, "committed");
  }
  if (existsSync(paths.failurePath)) {
    readStoredReceipt(paths, task, attempt, "retryable_failure");
    throw new Error("intent artifact attempt already failed; open a retry attempt");
  }

  let gate: ReturnType<typeof acceptIntentArtifactCandidate>;
  try {
    gate = acceptIntentArtifactCandidate({
      task,
      candidate: candidate.value,
      current_intent: input.current_intent,
      current_plan: input.current_plan,
      current_source_fingerprint: input.current_source_fingerprint,
      available_lids: input.available_lids,
      resolved_scope_lids: input.resolved_scope_lids,
      accepted_at: input.accepted_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFailure(paths, task, attempt, {
      diagnostic_code: "candidate_rejected",
      message,
      failed_at: input.accepted_at,
    });
    throw error;
  }
  writeJsonOnce(paths.acceptedPath, gate.accepted, "accepted intent artifact");
  const receipt = committedReceipt(task, attempt, candidate.sha256, gate.accepted, gate.receipt);
  ensureBounded(receipt);
  writeJsonOnce(paths.receiptPath, receipt, "intent artifact committed receipt");
  return readStoredReceipt(paths, task, attempt, "committed");
}
