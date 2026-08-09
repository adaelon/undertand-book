import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runAutomaticBuildTaskInput,
  submitAutomaticBuildTaskCandidate,
} from "../../../skills/build/automatic-build";
import {
  advanceAutomaticBuildDispatch,
  finishAutomaticBuildDispatch,
  inspectAutomaticBuildDispatch,
  validateAutomaticBuildDispatchHandoff,
  type AutomaticBuildDispatchExecutorHandoffRefV1,
  type AutomaticBuildExecutorInterruptionInputV1,
  type AutomaticBuildPersistedDispatchV1,
} from "./automatic-build-dispatch-runtime";
import {
  heartbeatAutomaticBuildLease,
  inspectAutomaticBuildTaskClaim,
  readAutomaticBuildLease,
  type AutomaticBuildClaimResult,
} from "./automatic-build-lease";
import {
  failAutomaticBuildTask,
  inspectAutomaticBuildTask,
  stageAutomaticBuildCandidate,
} from "./automatic-build-mailbox";
import {
  failIntentArtifactTaskAttempt,
  inspectIntentArtifactTaskAttempt,
  readIntentArtifactTaskAttemptExecutionContext,
  stageIntentArtifactTaskCandidate,
  submitIntentArtifactTaskAttempt,
  type IntentArtifactTaskAttemptExecutionContextV1,
} from "./intent-artifact-mailbox";
import { readAutomaticBuildExecutionIdentity } from "./automatic-build-task-store";
import { canonicalAutomaticBuildJson } from "./automatic-build-protocol";
import {
  validateBuildIntentAny,
  validateBuildPlanAny,
  type BuildIntentAny,
  type BuildPlanAny,
} from "./build-intent-v2";
import { epubToSource } from "./epub-adapter";
import {
  buildAutomaticBuildSnapshot,
  resolveAutomaticBuildTarget,
  type AutomaticBuildStage,
  type AutomaticBuildTarget,
  type BuildTargetRefV2,
} from "./build-orchestrator";
import {
  compileIntentArtifactTasks,
  type IntentArtifactCompatibilityType,
} from "./intent-artifact";
import { markdownToBlocks } from "./md-adapter";
import { segment } from "./segment";
import type { WorkUnitDescriptor } from "./stage-work-unit";
import { ReadOnlyBaseZ } from "./zod";

const MAX_RECORD_BYTES = 1_048_576;
const MAX_STDIN_BYTES = 8_192;
const MAX_REF_BYTES = 1_024;
const MAX_CANDIDATE_BYTES = 4 * 1_048_576;
const MAX_SEMANTIC_ATTEMPTS = 3;
const MAX_LEASE_EPOCHS = 3;
const SEMANTIC_PROMPT_SEPARATOR = "<!-- AUTOMATIC_BUILD_EXECUTOR_SEMANTIC_PROMPT -->";
const OPAQUE_HANDOFF_REF = /^abhandoff1_[a-f0-9]{64}$/u;
const OPAQUE_SESSION_REF = /^absession1_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PRIVATE_ARTIFACT_TYPES = new Set<IntentArtifactCompatibilityType>([
  "timeline",
  "concept_map",
  "comparison_table",
  "argument_map",
  "custom",
]);
const STAGES = new Set<AutomaticBuildStage>([
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
]);

export interface AutomaticBuildDispatchOwnerIdentityV1 {
  version: "automatic_build_dispatch_owner_identity.v1";
  stage: AutomaticBuildStage;
  dispatch_id: string;
  dispatch_run_id: string;
}

export interface AutomaticBuildPrivateArtifactOwnerIdentityV1 {
  version: "automatic_build_private_artifact_owner_identity.v1";
  task_id: string;
  book_id: string;
  source_fingerprint: string;
  intent_id: string;
  intent_digest: string;
  plan_id: string;
  plan_digest: string;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  blueprint_digest: string;
  attempt: number;
}

type AutomaticBuildExecutorOwnerIdentityV1 =
  | AutomaticBuildDispatchOwnerIdentityV1
  | AutomaticBuildPrivateArtifactOwnerIdentityV1;

export interface AutomaticBuildTargetLocatorV1 {
  version: "automatic_build_target_locator.v1";
  kind: AutomaticBuildTarget["kind"];
  profile_id: AutomaticBuildTarget["profile_id"];
  book_id: string;
  root_dir: string;
  workspace_dir: string;
  source_path: string;
}

export interface AutomaticBuildOpaqueHandoffRecordV1 {
  version: "automatic_build_opaque_handoff_record.v1";
  opaque_handoff_ref: string;
  kind: "public_dispatch" | "private_artifact";
  target_ref: BuildTargetRefV2;
  target_locator: AutomaticBuildTargetLocatorV1;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1 | unknown;
  handoff_path: string;
  handoff_sha256: string;
  handoff_byte_length: number;
  issued_at: string;
}

interface AutomaticBuildExecutorOpenRecordV1 {
  version: "automatic_build_executor_open_record.v1";
  opaque_handoff_ref: string;
  opaque_session_ref: string;
  owner_identity: AutomaticBuildExecutorOwnerIdentityV1;
  opened_at: string;
}

interface AutomaticBuildExecutorPrivateSessionRecordV1 {
  version: "automatic_build_executor_private_session_record.v1";
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  open_session_ref: string;
  owner_identity: AutomaticBuildPrivateArtifactOwnerIdentityV1;
  created_at: string;
}

interface AutomaticBuildExecutorTaskSessionRecordV1 {
  version: "automatic_build_executor_task_session_record.v1";
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  open_session_ref: string;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  lease_ref: string;
  lease_token: string;
  created_at: string;
}

export interface AutomaticBuildSemanticCandidateContractV1 {
  version: "automatic_build_semantic_candidate_contract.v1";
  format: "strict_json";
  encoding: "utf-8";
  max_bytes: number;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  work_unit_kind: string;
  input_hash: string;
  semantic_attempt: number;
}

export type AutomaticBuildExecutorSessionActionV1 =
  | {
      kind: "GENERATE";
      opaque_session_ref: string;
      semantic_prompt: string;
      semantic_input: unknown;
      output_contract: unknown;
    }
  | { kind: "WAIT"; retry_after_ms: number }
  | { kind: "DONE"; status: "committed" | "retryable_failure" | "interrupted" };

export interface AutomaticBuildExecutorSessionResponseV1 {
  version: "automatic_build_executor_session.v1";
  action: AutomaticBuildExecutorSessionActionV1;
}

export interface AutomaticBuildPublicOpaqueHandoffIssueV1 {
  target: AutomaticBuildTarget;
  kind: "public_dispatch";
  owner_identity: unknown;
  executor_handoff: AutomaticBuildDispatchExecutorHandoffRefV1;
  issued_at: string;
}

export interface AutomaticBuildPrivateOpaqueHandoffIssueV1 {
  target: AutomaticBuildTarget;
  kind: "private_artifact";
  private_root: string;
  task_path: string;
  issued_at: string;
}

export type AutomaticBuildOpaqueHandoffIssueV1 =
  | AutomaticBuildPublicOpaqueHandoffIssueV1
  | AutomaticBuildPrivateOpaqueHandoffIssueV1;

export interface AutomaticBuildExecutorOpenRequestV1 {
  version: "automatic_build_executor_open_request.v1";
  opaque_handoff_ref: string;
  now?: string;
}

export interface AutomaticBuildExecutorSubmitRequestV1 {
  version: "automatic_build_executor_submit_request.v1";
  opaque_session_ref: string;
  candidate_path: string;
  now?: string;
}

export interface AutomaticBuildExecutorFailRequestV1 {
  version: "automatic_build_executor_fail_request.v1";
  opaque_session_ref: string;
  diagnostic_code: string;
  message?: string;
  now?: string;
}

export interface AutomaticBuildExecutorHeartbeatRequestV1 {
  version: "automatic_build_executor_heartbeat_request.v1";
  opaque_session_ref: string;
  ttl_ms?: number;
  now?: string;
}

export interface AutomaticBuildExecutorInterruptRequestV1
  extends AutomaticBuildExecutorInterruptionInputV1 {
  version: "automatic_build_executor_interrupt_request.v1";
  opaque_session_ref: string;
  now?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("automatic build executor session object has invalid fields");
  }
}

function boundedString(value: unknown, field: string, maxBytes = 16_384): string {
  if (typeof value !== "string" || !value || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = boundedString(value, field, 128);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} is invalid`);
  return timestamp;
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right);
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalAutomaticBuildJson(value), "utf8")
    .digest("hex");
}

function registryRoot(): string {
  const configured = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
  const root = path.resolve(configured ?? path.join(tmpdir(), "understand-book-automatic-build-driver-v1"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("automatic build executor registry root is invalid");
  }
  return realpathSync.native(root);
}

function registryFile(directory: string, id: string): string {
  if (!/^[a-z0-9_-]{1,160}$/u.test(id)) throw new Error("automatic build executor record id is invalid");
  return path.join(registryRoot(), directory, `${id}.json`);
}

function assertRegistryFile(file: string): string {
  const root = registryRoot();
  const resolved = path.resolve(file);
  if (samePath(root, resolved) || isOutside(root, resolved)) {
    throw new Error("automatic build executor record escapes its registry");
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
    throw new Error("automatic build executor record is invalid");
  }
  const real = realpathSync.native(resolved);
  if (samePath(root, real) || isOutside(root, real)) {
    throw new Error("automatic build executor record realpath escapes its registry");
  }
  return real;
}

function decodeJsonRecord(file: string): unknown {
  const bytes = readFileSync(assertRegistryFile(file));
  if (bytes.includes(0) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    throw new Error("automatic build executor record encoding is invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("automatic build executor record is not UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("automatic build executor record JSON is invalid");
  }
}

function writeCreateOnly(file: string, value: unknown): boolean {
  const root = registryRoot();
  const resolved = path.resolve(file);
  if (samePath(root, resolved) || isOutside(root, resolved)) {
    throw new Error("automatic build executor record escapes its registry");
  }
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const realParent = realpathSync.native(path.dirname(resolved));
  if (samePath(root, realParent) || isOutside(root, realParent)) {
    throw new Error("automatic build executor record directory escapes its registry");
  }
  const bytes = Buffer.from(`${canonicalAutomaticBuildJson(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error("automatic build executor record is too large");
  try {
    writeFileSync(path.join(realParent, path.basename(resolved)), bytes, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    return false;
  }
}

function validateTargetRef(value: unknown): BuildTargetRefV2 {
  if (!isRecord(value)) throw new Error("opaque handoff target ref is invalid");
  exactKeys(value, ["version", "workspace_dir", "book_id", "profile_id", "input_fingerprint"]);
  if (value.version !== "build_target_ref.v2"
    || (value.profile_id !== "technical_learning" && value.profile_id !== "paper")
    || typeof value.input_fingerprint !== "string" || !SHA256.test(value.input_fingerprint)) {
    throw new Error("opaque handoff target ref identity is invalid");
  }
  const workspaceDir = boundedString(value.workspace_dir, "target_ref.workspace_dir");
  if (!path.isAbsolute(workspaceDir)) throw new Error("opaque handoff workspace must be absolute");
  return {
    version: value.version,
    workspace_dir: path.resolve(workspaceDir),
    book_id: boundedString(value.book_id, "target_ref.book_id", 512),
    profile_id: value.profile_id,
    input_fingerprint: value.input_fingerprint,
  };
}

function targetLocator(target: AutomaticBuildTarget): AutomaticBuildTargetLocatorV1 {
  return {
    version: "automatic_build_target_locator.v1",
    kind: target.kind,
    profile_id: target.profile_id,
    book_id: target.book_id,
    root_dir: path.resolve(target.root_dir),
    workspace_dir: path.resolve(target.workspace_dir),
    source_path: path.resolve(target.source_path),
  };
}

function validateTargetLocator(value: unknown): AutomaticBuildTargetLocatorV1 {
  if (!isRecord(value)) throw new Error("opaque handoff target locator is invalid");
  exactKeys(value, [
    "version",
    "kind",
    "profile_id",
    "book_id",
    "root_dir",
    "workspace_dir",
    "source_path",
  ]);
  if (value.version !== "automatic_build_target_locator.v1"
    || (value.kind !== "paper_workspace" && value.kind !== "source_file")
    || (value.profile_id !== "technical_learning" && value.profile_id !== "paper")) {
    throw new Error("opaque handoff target locator identity is invalid");
  }
  const locator: AutomaticBuildTargetLocatorV1 = {
    version: value.version,
    kind: value.kind,
    profile_id: value.profile_id,
    book_id: boundedString(value.book_id, "target_locator.book_id", 512),
    root_dir: boundedString(value.root_dir, "target_locator.root_dir"),
    workspace_dir: boundedString(value.workspace_dir, "target_locator.workspace_dir"),
    source_path: boundedString(value.source_path, "target_locator.source_path"),
  };
  if (![locator.root_dir, locator.workspace_dir, locator.source_path].every(path.isAbsolute)) {
    throw new Error("opaque handoff target locator paths must be absolute");
  }
  return {
    ...locator,
    root_dir: path.resolve(locator.root_dir),
    workspace_dir: path.resolve(locator.workspace_dir),
    source_path: path.resolve(locator.source_path),
  };
}

function validateOwnerIdentity(value: unknown): AutomaticBuildDispatchOwnerIdentityV1 {
  if (!isRecord(value)) throw new Error("opaque handoff owner identity is invalid");
  exactKeys(value, ["version", "stage", "dispatch_id", "dispatch_run_id"]);
  if (value.version !== "automatic_build_dispatch_owner_identity.v1"
    || typeof value.stage !== "string" || !STAGES.has(value.stage as AutomaticBuildStage)) {
    throw new Error("opaque handoff owner identity version or stage is invalid");
  }
  return {
    version: value.version,
    stage: value.stage as AutomaticBuildStage,
    dispatch_id: boundedString(value.dispatch_id, "owner_identity.dispatch_id", 512),
    dispatch_run_id: boundedString(value.dispatch_run_id, "owner_identity.dispatch_run_id", 256),
  };
}

function validatePrivateOwnerIdentity(value: unknown): AutomaticBuildPrivateArtifactOwnerIdentityV1 {
  if (!isRecord(value)) throw new Error("private artifact owner identity is invalid");
  exactKeys(value, [
    "version",
    "task_id",
    "book_id",
    "source_fingerprint",
    "intent_id",
    "intent_digest",
    "plan_id",
    "plan_digest",
    "artifact_id",
    "artifact_type",
    "blueprint_digest",
    "attempt",
  ]);
  if (value.version !== "automatic_build_private_artifact_owner_identity.v1"
    || typeof value.intent_digest !== "string" || !SHA256.test(value.intent_digest)
    || typeof value.plan_digest !== "string" || !SHA256.test(value.plan_digest)
    || typeof value.blueprint_digest !== "string" || !SHA256.test(value.blueprint_digest)
    || typeof value.artifact_type !== "string"
    || !PRIVATE_ARTIFACT_TYPES.has(value.artifact_type as IntentArtifactCompatibilityType)) {
    throw new Error("private artifact owner identity fields are invalid");
  }
  return {
    version: value.version,
    task_id: boundedString(value.task_id, "owner_identity.task_id", 512),
    book_id: boundedString(value.book_id, "owner_identity.book_id", 512),
    source_fingerprint: boundedString(
      value.source_fingerprint,
      "owner_identity.source_fingerprint",
      512,
    ),
    intent_id: boundedString(value.intent_id, "owner_identity.intent_id", 512),
    intent_digest: value.intent_digest,
    plan_id: boundedString(value.plan_id, "owner_identity.plan_id", 512),
    plan_digest: value.plan_digest,
    artifact_id: boundedString(value.artifact_id, "owner_identity.artifact_id", 512),
    artifact_type: value.artifact_type as IntentArtifactCompatibilityType,
    blueprint_digest: value.blueprint_digest,
    attempt: positiveSafeInteger(value.attempt, "owner_identity.attempt"),
  };
}

function validateExecutorOwnerIdentity(value: unknown): AutomaticBuildExecutorOwnerIdentityV1 {
  if (isRecord(value) && value.version === "automatic_build_private_artifact_owner_identity.v1") {
    return validatePrivateOwnerIdentity(value);
  }
  return validateOwnerIdentity(value);
}

function validateExecutorHandoffRef(value: unknown): AutomaticBuildDispatchExecutorHandoffRefV1 {
  if (!isRecord(value)) throw new Error("opaque handoff file ref is invalid");
  exactKeys(value, ["version", "path", "sha256", "byte_length"]);
  if (value.version !== "automatic_build_dispatch_executor_handoff_ref.v1"
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)
    || !Number.isSafeInteger(value.byte_length) || (value.byte_length as number) < 1) {
    throw new Error("opaque handoff file ref identity is invalid");
  }
  const handoffPath = boundedString(value.path, "executor_handoff.path");
  if (!path.isAbsolute(handoffPath)) throw new Error("opaque handoff file path must be absolute");
  return {
    version: value.version,
    path: path.resolve(handoffPath),
    sha256: value.sha256,
    byte_length: value.byte_length as number,
  };
}

function sameTargetRef(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && samePath(left.workspace_dir, right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function resolveRecordTarget(
  locator: AutomaticBuildTargetLocatorV1,
  targetRef: BuildTargetRefV2,
): AutomaticBuildTarget {
  if (!samePath(locator.workspace_dir, targetRef.workspace_dir)
    || locator.book_id !== targetRef.book_id
    || locator.profile_id !== targetRef.profile_id) {
    throw new Error("opaque handoff target locator does not match its target ref");
  }
  const input = locator.kind === "paper_workspace" ? locator.workspace_dir : locator.source_path;
  const resolved = resolveAutomaticBuildTarget(input, locator.root_dir, { book_id: locator.book_id });
  if (!sameTargetRef(resolved.target_ref, targetRef)) {
    throw new Error("opaque handoff target identity drifted");
  }
  return resolved;
}

function opaqueHandoffIdentity(input: {
  kind: "public_dispatch" | "private_artifact";
  target_ref: BuildTargetRefV2;
  target_locator: AutomaticBuildTargetLocatorV1;
  owner_identity: unknown;
  handoff_path: string;
  handoff_sha256: string;
  handoff_byte_length: number;
}): unknown {
  return { version: "automatic_build_opaque_handoff_identity.v1", ...input };
}

function opaqueHandoffRefFor(input: Parameters<typeof opaqueHandoffIdentity>[0]): string {
  return `abhandoff1_${sha256(opaqueHandoffIdentity(input))}`;
}

function validateOpaqueHandoffRef(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
    || !OPAQUE_HANDOFF_REF.test(value)) {
    throw new Error("opaque handoff ref is invalid");
  }
  return value;
}

function validateOpaqueHandoffRecord(value: unknown, expectedRef: string): AutomaticBuildOpaqueHandoffRecordV1 {
  if (!isRecord(value)) throw new Error("opaque handoff record is invalid");
  exactKeys(value, [
    "version",
    "opaque_handoff_ref",
    "kind",
    "target_ref",
    "target_locator",
    "owner_identity",
    "handoff_path",
    "handoff_sha256",
    "handoff_byte_length",
    "issued_at",
  ]);
  if (value.version !== "automatic_build_opaque_handoff_record.v1"
    || value.opaque_handoff_ref !== expectedRef
    || (value.kind !== "public_dispatch" && value.kind !== "private_artifact")
    || typeof value.handoff_sha256 !== "string" || !SHA256.test(value.handoff_sha256)
    || !Number.isSafeInteger(value.handoff_byte_length) || (value.handoff_byte_length as number) < 1) {
    throw new Error("opaque handoff record identity is invalid");
  }
  const targetRef = validateTargetRef(value.target_ref);
  const locator = validateTargetLocator(value.target_locator);
  const handoffPath = boundedString(value.handoff_path, "handoff_path");
  if (!path.isAbsolute(handoffPath)) throw new Error("opaque handoff record path must be absolute");
  const record: AutomaticBuildOpaqueHandoffRecordV1 = {
    version: value.version,
    opaque_handoff_ref: expectedRef,
    kind: value.kind,
    target_ref: targetRef,
    target_locator: locator,
    owner_identity: value.owner_identity,
    handoff_path: path.resolve(handoffPath),
    handoff_sha256: value.handoff_sha256,
    handoff_byte_length: value.handoff_byte_length as number,
    issued_at: isoTimestamp(value.issued_at, "issued_at"),
  };
  const identity = {
    kind: record.kind,
    target_ref: record.target_ref,
    target_locator: record.target_locator,
    owner_identity: record.owner_identity,
    handoff_path: record.handoff_path,
    handoff_sha256: record.handoff_sha256,
    handoff_byte_length: record.handoff_byte_length,
  };
  if (opaqueHandoffRefFor(identity) !== expectedRef) {
    throw new Error("opaque handoff record digest is invalid");
  }
  return record;
}

function readOpaqueHandoffRecord(opaqueHandoffRef: string): AutomaticBuildOpaqueHandoffRecordV1 {
  const file = registryFile("opaque-handoffs", opaqueHandoffRef);
  if (!existsSync(file)) throw new Error("opaque handoff ref does not exist");
  return validateOpaqueHandoffRecord(decodeJsonRecord(file), opaqueHandoffRef);
}

function semanticPromptFromPublishedHandoff(
  handoff: AutomaticBuildDispatchExecutorHandoffRefV1,
): string {
  const bytes = readFileSync(handoff.path);
  if (bytes.includes(0) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    throw new Error("dispatch executor handoff encoding is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("dispatch executor handoff JSON is invalid");
  }
  if (!isRecord(value) || typeof value.prompt !== "string") {
    throw new Error("dispatch executor handoff prompt is invalid");
  }
  const marker = value.prompt.indexOf(SEMANTIC_PROMPT_SEPARATOR);
  if (marker < 0 || marker !== value.prompt.lastIndexOf(SEMANTIC_PROMPT_SEPARATOR)) {
    throw new Error("dispatch executor semantic prompt boundary is invalid");
  }
  const suffix = value.prompt.slice(marker + SEMANTIC_PROMPT_SEPARATOR.length);
  if (!suffix.startsWith("\n\n") || !suffix.slice(2).trim() || suffix.slice(2).includes("\0")) {
    throw new Error("dispatch executor semantic prompt is invalid");
  }
  return suffix.slice(2);
}

function validatePublishedPublicDispatch(
  record: AutomaticBuildOpaqueHandoffRecordV1,
): {
  target: AutomaticBuildTarget;
  owner: AutomaticBuildDispatchOwnerIdentityV1;
  handoff: AutomaticBuildDispatchExecutorHandoffRefV1;
  persisted: AutomaticBuildPersistedDispatchV1;
  semantic_prompt: string;
} {
  if (record.kind !== "public_dispatch") {
    throw new Error("private artifact executor sessions are not available in S2");
  }
  const owner = validateOwnerIdentity(record.owner_identity);
  const handoff = validateExecutorHandoffRef({
    version: "automatic_build_dispatch_executor_handoff_ref.v1",
    path: record.handoff_path,
    sha256: record.handoff_sha256,
    byte_length: record.handoff_byte_length,
  });
  const target = resolveRecordTarget(record.target_locator, record.target_ref);
  const persisted = validateAutomaticBuildDispatchHandoff(target, {
    stage: owner.stage,
    dispatch_id: owner.dispatch_id,
    dispatch_run_id: owner.dispatch_run_id,
    executor_handoff: handoff,
  });
  if (persisted.manifest.stage !== owner.stage
    || persisted.manifest.dispatch_id !== owner.dispatch_id
    || persisted.dispatch_run_id !== owner.dispatch_run_id
    || !sameTargetRef(persisted.manifest.target_ref, record.target_ref)) {
    throw new Error("opaque handoff dispatch identity drifted");
  }
  return {
    target,
    owner,
    handoff,
    persisted,
    semantic_prompt: semanticPromptFromPublishedHandoff(handoff),
  };
}

function privateOwnerFromContext(
  context: IntentArtifactTaskAttemptExecutionContextV1,
): AutomaticBuildPrivateArtifactOwnerIdentityV1 {
  const task = context.task;
  return {
    version: "automatic_build_private_artifact_owner_identity.v1",
    task_id: task.task_id,
    book_id: task.book_id,
    source_fingerprint: task.source_fingerprint,
    intent_id: task.intent_id,
    intent_digest: task.intent_digest,
    plan_id: task.plan_id,
    plan_digest: task.plan_digest,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    blueprint_digest: task.artifact.blueprint_digest,
    attempt: context.attempt,
  };
}

function assertPrivateTaskTarget(
  target: AutomaticBuildTarget,
  context: IntentArtifactTaskAttemptExecutionContextV1,
): void {
  const task = context.task;
  if (task.book_id !== target.book_id
    || task.source_fingerprint !== target.target_ref.input_fingerprint
    || task.content_profile.id !== target.profile_id) {
    throw new Error("private artifact task does not match the current build target");
  }
}

function privateTaskHandoffRef(
  context: IntentArtifactTaskAttemptExecutionContextV1,
): AutomaticBuildDispatchExecutorHandoffRefV1 {
  const stat = lstatSync(context.task_path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
    throw new Error("private artifact task handoff is invalid");
  }
  const bytes = readFileSync(context.task_path);
  return {
    version: "automatic_build_dispatch_executor_handoff_ref.v1",
    path: context.task_path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
  };
}

export function issueAutomaticBuildOpaqueHandoff(input: AutomaticBuildOpaqueHandoffIssueV1): {
  version: "automatic_build_opaque_handoff_ref.v1";
  opaque_handoff_ref: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("opaque handoff issue input is invalid");
  }
  const targetRef = validateTargetRef(input.target.target_ref);
  const locator = targetLocator(input.target);
  const resolvedTarget = resolveRecordTarget(locator, targetRef);
  const issuedAt = isoTimestamp(input.issued_at, "issued_at");
  let owner: AutomaticBuildExecutorOwnerIdentityV1;
  let handoff: AutomaticBuildDispatchExecutorHandoffRefV1;
  if (input.kind === "public_dispatch") {
    owner = validateOwnerIdentity(input.owner_identity);
    handoff = validateExecutorHandoffRef(input.executor_handoff);
    const persisted = validateAutomaticBuildDispatchHandoff(resolvedTarget, {
      stage: owner.stage,
      dispatch_id: owner.dispatch_id,
      dispatch_run_id: owner.dispatch_run_id,
      executor_handoff: handoff,
    });
    if (!sameTargetRef(persisted.manifest.target_ref, targetRef)) {
      throw new Error("opaque handoff target does not match the published dispatch");
    }
  } else {
    const context = readIntentArtifactTaskAttemptExecutionContext({
      private_root: input.private_root,
      task_path: input.task_path,
    });
    assertPrivateTaskTarget(resolvedTarget, context);
    owner = privateOwnerFromContext(context);
    handoff = privateTaskHandoffRef(context);
  }
  const identity = {
    kind: input.kind,
    target_ref: targetRef,
    target_locator: locator,
    owner_identity: owner,
    handoff_path: handoff.path,
    handoff_sha256: handoff.sha256,
    handoff_byte_length: handoff.byte_length,
  };
  const opaqueHandoffRef = opaqueHandoffRefFor(identity);
  const record: AutomaticBuildOpaqueHandoffRecordV1 = {
    version: "automatic_build_opaque_handoff_record.v1",
    opaque_handoff_ref: opaqueHandoffRef,
    ...identity,
    issued_at: issuedAt,
  };
  const file = registryFile("opaque-handoffs", opaqueHandoffRef);
  if (!writeCreateOnly(file, record)) {
    const existing = readOpaqueHandoffRecord(opaqueHandoffRef);
    const existingIdentity = opaqueHandoffIdentity({
      kind: existing.kind,
      target_ref: existing.target_ref,
      target_locator: existing.target_locator,
      owner_identity: existing.owner_identity,
      handoff_path: existing.handoff_path,
      handoff_sha256: existing.handoff_sha256,
      handoff_byte_length: existing.handoff_byte_length,
    });
    if (canonicalAutomaticBuildJson(existingIdentity) !== canonicalAutomaticBuildJson(
      opaqueHandoffIdentity(identity),
    )) {
      throw new Error("opaque handoff ref conflicts with its create-only record");
    }
  }
  return {
    version: "automatic_build_opaque_handoff_ref.v1",
    opaque_handoff_ref: opaqueHandoffRef,
  };
}

function validateOpenRecord(
  value: unknown,
  opaqueHandoffRef: string,
  owner: AutomaticBuildExecutorOwnerIdentityV1,
): AutomaticBuildExecutorOpenRecordV1 {
  if (!isRecord(value)) throw new Error("executor open record is invalid");
  exactKeys(value, [
    "version",
    "opaque_handoff_ref",
    "opaque_session_ref",
    "owner_identity",
    "opened_at",
  ]);
  if (value.version !== "automatic_build_executor_open_record.v1"
    || value.opaque_handoff_ref !== opaqueHandoffRef
    || typeof value.opaque_session_ref !== "string" || !OPAQUE_SESSION_REF.test(value.opaque_session_ref)) {
    throw new Error("executor open record identity is invalid");
  }
  const existingOwner = validateExecutorOwnerIdentity(value.owner_identity);
  if (canonicalAutomaticBuildJson(existingOwner) !== canonicalAutomaticBuildJson(owner)) {
    throw new Error("executor open record owner identity changed");
  }
  return {
    version: value.version,
    opaque_handoff_ref: opaqueHandoffRef,
    opaque_session_ref: value.opaque_session_ref,
    owner_identity: existingOwner,
    opened_at: isoTimestamp(value.opened_at, "opened_at"),
  };
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${field} is invalid`);
  return Number(value);
}

function validateOpaqueSessionRef(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
    || !OPAQUE_SESSION_REF.test(value)) {
    throw new Error("opaque session ref is invalid");
  }
  return value;
}

function privateRootFromTaskPath(
  taskPathInput: string,
  owner: AutomaticBuildPrivateArtifactOwnerIdentityV1,
): string {
  const taskPath = path.resolve(taskPathInput);
  const attemptDirectory = path.dirname(taskPath);
  const attemptsDirectory = path.dirname(attemptDirectory);
  const artifactDirectory = path.dirname(attemptsDirectory);
  const intentDirectory = path.dirname(artifactDirectory);
  const artifactsDirectory = path.dirname(intentDirectory);
  const bookDirectory = path.dirname(artifactsDirectory);
  const privateRoot = path.dirname(bookDirectory);
  if (path.basename(taskPath) !== "task.json"
    || path.basename(attemptDirectory) !== String(owner.attempt).padStart(6, "0")
    || path.basename(attemptsDirectory) !== "attempts"
    || path.basename(artifactDirectory) !== owner.artifact_id
    || path.basename(intentDirectory) !== owner.intent_id
    || path.basename(artifactsDirectory) !== "artifacts"
    || path.basename(bookDirectory) !== owner.book_id) {
    throw new Error("private artifact task path does not match its owner identity");
  }
  return privateRoot;
}

function readPrivateSelectionJson(privateRoot: string, fileInput: string, label: string): unknown {
  const file = path.resolve(fileInput);
  if (samePath(privateRoot, file) || isOutside(privateRoot, file)) {
    throw new Error(`${label} escapes the private artifact root`);
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  const real = realpathSync.native(file);
  if (samePath(privateRoot, real) || isOutside(privateRoot, real)) {
    throw new Error(`${label} realpath escapes the private artifact root`);
  }
  const bytes = readFileSync(real);
  if (bytes.includes(0) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    throw new Error(`${label} encoding is invalid`);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} JSON is invalid`);
  }
}

interface AutomaticBuildPrivateArtifactContextV1 {
  target: AutomaticBuildTarget;
  owner: AutomaticBuildPrivateArtifactOwnerIdentityV1;
  attempt: IntentArtifactTaskAttemptExecutionContextV1;
  intent: BuildIntentAny;
  plan: BuildPlanAny;
  available_lids: string[];
  resolved_scope_lids: string[];
  inspection: ReturnType<typeof inspectIntentArtifactTaskAttempt>;
}

function deriveAutomaticBuildTargetLids(target: AutomaticBuildTarget): string[] {
  const bytes = readFileSync(target.source_path);
  const loaded = /\.epub$/iu.test(target.source_path)
    ? epubToSource(new Uint8Array(bytes))
    : (() => {
        const source = bytes.toString("utf8");
        return { source, blocks: markdownToBlocks(source) };
      })();
  return segment(loaded.blocks).map((node) => node.lid);
}

export function resolveAutomaticBuildTargetLids(target: AutomaticBuildTarget): string[] {
  const basePath = path.join(target.workspace_dir, "base.json");
  if (!existsSync(basePath)) return deriveAutomaticBuildTargetLids(target);
  const base = ReadOnlyBaseZ.parse(readPrivateSelectionJson(
    path.resolve(target.workspace_dir),
    basePath,
    "current base",
  ));
  if (base.book_id !== target.book_id) {
    throw new Error("private artifact current base identity drifted");
  }
  return base.lid_nodes.map((node) => node.lid);
}

function resolvePrivateArtifactContext(
  record: AutomaticBuildOpaqueHandoffRecordV1,
): AutomaticBuildPrivateArtifactContextV1 {
  if (record.kind !== "private_artifact") {
    throw new Error("opaque handoff is not a private artifact");
  }
  const owner = validatePrivateOwnerIdentity(record.owner_identity);
  const target = resolveRecordTarget(record.target_locator, record.target_ref);
  const privateRootInput = privateRootFromTaskPath(record.handoff_path, owner);
  const attempt = readIntentArtifactTaskAttemptExecutionContext({
    private_root: privateRootInput,
    task_path: record.handoff_path,
  });
  if (!samePath(attempt.private_root, privateRootInput)) {
    throw new Error("private artifact root identity changed");
  }
  const handoff = privateTaskHandoffRef(attempt);
  if (handoff.sha256 !== record.handoff_sha256
    || handoff.byte_length !== record.handoff_byte_length
    || !samePath(handoff.path, record.handoff_path)) {
    throw new Error("private artifact task handoff identity drifted");
  }
  const currentOwner = privateOwnerFromContext(attempt);
  if (canonicalAutomaticBuildJson(currentOwner) !== canonicalAutomaticBuildJson(owner)) {
    throw new Error("private artifact task owner identity drifted");
  }
  assertPrivateTaskTarget(target, attempt);

  const planPath = path.join(
    attempt.private_root,
    owner.book_id,
    "plans",
    `${owner.plan_id}.json`,
  );
  const intentPath = path.join(
    attempt.private_root,
    owner.book_id,
    "intents",
    owner.intent_id,
    "intent.json",
  );
  const plan = validateBuildPlanAny(readPrivateSelectionJson(
    attempt.private_root,
    planPath,
    "private BuildPlan",
  ));
  const intent = validateBuildIntentAny(readPrivateSelectionJson(
    attempt.private_root,
    intentPath,
    "private BuildIntent",
  ));
  if (plan.plan_id !== owner.plan_id
    || plan.plan_digest !== owner.plan_digest
    || plan.intent_id !== owner.intent_id
    || plan.intent_digest !== owner.intent_digest
    || plan.book_id !== owner.book_id
    || plan.source_fingerprint !== owner.source_fingerprint
    || (plan.status !== "confirmed" && plan.status !== "completed")
    || intent.intent_id !== owner.intent_id
    || intent.book_id !== owner.book_id
    || intent.source_fingerprint !== owner.source_fingerprint
    || intent.status !== "confirmed") {
    throw new Error("private artifact current intent or plan identity drifted");
  }
  const availableLids = resolveAutomaticBuildTargetLids(target);
  const resolvedScopeLids = intent.source_scope.whole_book
    ? [...availableLids]
    : [...intent.source_scope.lids];
  const expected = compileIntentArtifactTasks({
    intent,
    plan,
    available_lids: availableLids,
    resolved_scope_lids: resolvedScopeLids,
  }).find((task) => task.task_id === owner.task_id);
  if (!expected || canonicalAutomaticBuildJson(expected) !== canonicalAutomaticBuildJson(attempt.task)) {
    throw new Error("private artifact task no longer matches the current intent and plan");
  }
  return {
    target,
    owner,
    attempt,
    intent,
    plan,
    available_lids: availableLids,
    resolved_scope_lids: resolvedScopeLids,
    inspection: inspectIntentArtifactTaskAttempt({
      private_root: attempt.private_root,
      task_path: attempt.task_path,
    }),
  };
}

function privateSessionIdentity(input: Omit<
  AutomaticBuildExecutorPrivateSessionRecordV1,
  "version" | "opaque_session_ref" | "created_at"
>): unknown {
  return { version: "automatic_build_executor_private_session_identity.v1", ...input };
}

function privateSessionRefFor(input: Parameters<typeof privateSessionIdentity>[0]): string {
  return `absession1_${sha256(privateSessionIdentity(input))}`;
}

function validatePrivateSessionRecord(
  value: unknown,
  expectedRef: string,
): AutomaticBuildExecutorPrivateSessionRecordV1 {
  if (!isRecord(value)) throw new Error("executor private session record is invalid");
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "opaque_handoff_ref",
    "open_session_ref",
    "owner_identity",
    "created_at",
  ]);
  if (value.version !== "automatic_build_executor_private_session_record.v1"
    || value.opaque_session_ref !== expectedRef) {
    throw new Error("executor private session record identity is invalid");
  }
  const record: AutomaticBuildExecutorPrivateSessionRecordV1 = {
    version: value.version,
    opaque_session_ref: expectedRef,
    opaque_handoff_ref: validateOpaqueHandoffRef(value.opaque_handoff_ref),
    open_session_ref: validateOpaqueSessionRef(value.open_session_ref),
    owner_identity: validatePrivateOwnerIdentity(value.owner_identity),
    created_at: isoTimestamp(value.created_at, "created_at"),
  };
  if (privateSessionRefFor({
    opaque_handoff_ref: record.opaque_handoff_ref,
    open_session_ref: record.open_session_ref,
    owner_identity: record.owner_identity,
  }) !== expectedRef) {
    throw new Error("executor private session record digest is invalid");
  }
  return record;
}

function persistPrivateSessionRecord(input: {
  opaque_handoff_ref: string;
  open_record: AutomaticBuildExecutorOpenRecordV1;
  owner: AutomaticBuildPrivateArtifactOwnerIdentityV1;
  created_at: string;
}): AutomaticBuildExecutorPrivateSessionRecordV1 {
  const identity = {
    opaque_handoff_ref: input.opaque_handoff_ref,
    open_session_ref: input.open_record.opaque_session_ref,
    owner_identity: input.owner,
  };
  const opaqueSessionRef = privateSessionRefFor(identity);
  const record: AutomaticBuildExecutorPrivateSessionRecordV1 = {
    version: "automatic_build_executor_private_session_record.v1",
    opaque_session_ref: opaqueSessionRef,
    ...identity,
    created_at: input.created_at,
  };
  const file = registryFile("executor-private-sessions", opaqueSessionRef);
  if (!writeCreateOnly(file, record)) {
    return validatePrivateSessionRecord(decodeJsonRecord(file), opaqueSessionRef);
  }
  return record;
}

function readPrivateSessionRecord(
  opaqueSessionRefValue: string,
): AutomaticBuildExecutorPrivateSessionRecordV1 | undefined {
  const opaqueSessionRef = validateOpaqueSessionRef(opaqueSessionRefValue);
  const file = registryFile("executor-private-sessions", opaqueSessionRef);
  if (!existsSync(file)) return undefined;
  return validatePrivateSessionRecord(decodeJsonRecord(file), opaqueSessionRef);
}

function taskSessionIdentity(input: Omit<
  AutomaticBuildExecutorTaskSessionRecordV1,
  "version" | "opaque_session_ref" | "created_at"
>): unknown {
  return { version: "automatic_build_executor_task_session_identity.v1", ...input };
}

function taskSessionRefFor(input: Parameters<typeof taskSessionIdentity>[0]): string {
  return `absession1_${sha256(taskSessionIdentity(input))}`;
}

function validateTaskSessionRecord(
  value: unknown,
  expectedRef: string,
): AutomaticBuildExecutorTaskSessionRecordV1 {
  if (!isRecord(value)) throw new Error("executor task session record is invalid");
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "opaque_handoff_ref",
    "open_session_ref",
    "owner_identity",
    "stage",
    "work_unit_id",
    "physical_attempt",
    "semantic_attempt",
    "lease_epoch",
    "lease_ref",
    "lease_token",
    "created_at",
  ]);
  if (value.version !== "automatic_build_executor_task_session_record.v1"
    || value.opaque_session_ref !== expectedRef) {
    throw new Error("executor task session record identity is invalid");
  }
  const opaqueHandoffRef = validateOpaqueHandoffRef(value.opaque_handoff_ref);
  const openSessionRef = validateOpaqueSessionRef(value.open_session_ref);
  const owner = validateOwnerIdentity(value.owner_identity);
  if (typeof value.stage !== "string" || !STAGES.has(value.stage as AutomaticBuildStage)
    || value.stage !== owner.stage) {
    throw new Error("executor task session stage is invalid");
  }
  const leaseRef = boundedString(value.lease_ref, "lease_ref");
  if (!path.isAbsolute(leaseRef)) throw new Error("executor task session lease ref must be absolute");
  const record: AutomaticBuildExecutorTaskSessionRecordV1 = {
    version: value.version,
    opaque_session_ref: expectedRef,
    opaque_handoff_ref: opaqueHandoffRef,
    open_session_ref: openSessionRef,
    owner_identity: owner,
    stage: value.stage as AutomaticBuildStage,
    work_unit_id: boundedString(value.work_unit_id, "work_unit_id", 512),
    physical_attempt: positiveSafeInteger(value.physical_attempt, "physical_attempt"),
    semantic_attempt: positiveSafeInteger(value.semantic_attempt, "semantic_attempt"),
    lease_epoch: positiveSafeInteger(value.lease_epoch, "lease_epoch"),
    lease_ref: path.resolve(leaseRef),
    lease_token: boundedString(value.lease_token, "lease_token", 512),
    created_at: isoTimestamp(value.created_at, "created_at"),
  };
  const identity = {
    opaque_handoff_ref: record.opaque_handoff_ref,
    open_session_ref: record.open_session_ref,
    owner_identity: record.owner_identity,
    stage: record.stage,
    work_unit_id: record.work_unit_id,
    physical_attempt: record.physical_attempt,
    semantic_attempt: record.semantic_attempt,
    lease_epoch: record.lease_epoch,
    lease_ref: record.lease_ref,
    lease_token: record.lease_token,
  };
  if (taskSessionRefFor(identity) !== expectedRef) {
    throw new Error("executor task session record digest is invalid");
  }
  return record;
}

function readTaskSessionRecord(opaqueSessionRefValue: string): AutomaticBuildExecutorTaskSessionRecordV1 {
  const opaqueSessionRef = validateOpaqueSessionRef(opaqueSessionRefValue);
  const file = registryFile("executor-task-sessions", opaqueSessionRef);
  if (!existsSync(file)) throw new Error("opaque session ref does not exist");
  return validateTaskSessionRecord(decodeJsonRecord(file), opaqueSessionRef);
}

type ActiveAutomaticBuildClaim = Extract<
  AutomaticBuildClaimResult,
  { status: "leased" | "already_leased" }
>;

function persistTaskSessionRecord(input: {
  opaque_handoff_ref: string;
  open_record: AutomaticBuildExecutorOpenRecordV1;
  owner: AutomaticBuildDispatchOwnerIdentityV1;
  claim: ActiveAutomaticBuildClaim;
  created_at: string;
}): AutomaticBuildExecutorTaskSessionRecordV1 {
  const identity = {
    opaque_handoff_ref: input.opaque_handoff_ref,
    open_session_ref: input.open_record.opaque_session_ref,
    owner_identity: input.owner,
    stage: input.claim.lease.stage,
    work_unit_id: input.claim.lease.work_unit_id,
    physical_attempt: input.claim.lease.attempt,
    semantic_attempt: input.claim.execution_identity.semantic_attempt,
    lease_epoch: input.claim.execution_identity.lease_epoch,
    lease_ref: path.resolve(input.claim.lease_ref),
    lease_token: input.claim.lease.token,
  };
  const opaqueSessionRef = taskSessionRefFor(identity);
  const record: AutomaticBuildExecutorTaskSessionRecordV1 = {
    version: "automatic_build_executor_task_session_record.v1",
    opaque_session_ref: opaqueSessionRef,
    ...identity,
    created_at: input.created_at,
  };
  const file = registryFile("executor-task-sessions", opaqueSessionRef);
  if (!writeCreateOnly(file, record)) return validateTaskSessionRecord(decodeJsonRecord(file), opaqueSessionRef);
  return record;
}

function normalizedCandidateBytes(fileInput: string): Buffer {
  const file = path.resolve(fileInput);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CANDIDATE_BYTES) {
    throw new Error("executor candidate source is invalid");
  }
  const bytes = readFileSync(file);
  const payload = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new Error("executor candidate source must contain strict UTF-8 JSON");
  }
  return payload;
}

function assertCandidateReplayMatches(
  record: AutomaticBuildExecutorTaskSessionRecordV1,
  candidatePath: string,
): void {
  const canonicalPath = path.join(path.dirname(record.lease_ref), "candidate.json");
  if (!existsSync(canonicalPath)) throw new Error("committed executor task is missing its candidate mailbox");
  const source = normalizedCandidateBytes(candidatePath);
  const canonical = normalizedCandidateBytes(canonicalPath);
  if (createHash("sha256").update(source).digest("hex")
    !== createHash("sha256").update(canonical).digest("hex")) {
    throw new Error("candidate already exists with a different hash");
  }
}

function doneResponse(
  status: Extract<AutomaticBuildExecutorSessionActionV1, { kind: "DONE" }>["status"],
): AutomaticBuildExecutorSessionResponseV1 {
  return {
    version: "automatic_build_executor_session.v1",
    action: { kind: "DONE", status },
  };
}

function waitResponse(retryAfterMs: number): AutomaticBuildExecutorSessionResponseV1 {
  return {
    version: "automatic_build_executor_session.v1",
    action: { kind: "WAIT", retry_after_ms: Math.max(1, Math.min(retryAfterMs, 300_000)) },
  };
}

function taskDescriptor(
  target: AutomaticBuildTarget,
  persisted: AutomaticBuildPersistedDispatchV1,
  workUnitId: string,
): {
  descriptor: WorkUnitDescriptor;
  descriptors: WorkUnitDescriptor[];
  task_bindings: NonNullable<ReturnType<typeof buildAutomaticBuildSnapshot>["stages"][number]["task_bindings"]>;
} {
  const snapshot = buildAutomaticBuildSnapshot(target, {
    quality_profile: persisted.manifest.policy_fingerprint.quality_profile,
  });
  const stageState = snapshot.stages.find((candidate) => candidate.stage === persisted.manifest.stage);
  if (!stageState?.work_units) {
    throw new Error("executor dispatch stage descriptor plan is unavailable");
  }
  const descriptor = stageState.work_units.find((candidate) => candidate.work_unit_id === workUnitId);
  if (!descriptor) throw new Error("executor dispatch work unit descriptor is unavailable");
  return {
    descriptor,
    descriptors: stageState.work_units,
    task_bindings: stageState.task_bindings ?? {},
  };
}

function generateAction(input: {
  target: AutomaticBuildTarget;
  persisted: AutomaticBuildPersistedDispatchV1;
  semantic_prompt: string;
  task_session: AutomaticBuildExecutorTaskSessionRecordV1;
  descriptor: WorkUnitDescriptor;
  now: string;
}): AutomaticBuildExecutorSessionResponseV1 {
  const taskInspection = inspectAutomaticBuildTask(
    input.target,
    input.task_session.lease_ref,
    input.task_session.lease_token,
  );
  if (taskInspection.state !== "leased") {
    throw new Error("terminal executor task must be advanced before GENERATE");
  }
  if (taskInspection.candidate_sha256) {
    submitAutomaticBuildTaskCandidate(
      input.target,
      input.task_session.stage,
      input.task_session.work_unit_id,
      input.task_session.lease_ref,
      input.task_session.lease_token,
      { now: input.now },
    );
    return drivePublicExecutorSession({
      opaque_handoff_ref: input.task_session.opaque_handoff_ref,
      open_record: validateOpenRecord(
        decodeJsonRecord(registryFile("executor-opens", input.task_session.opaque_handoff_ref)),
        input.task_session.opaque_handoff_ref,
        input.task_session.owner_identity,
      ),
      target: input.target,
      owner: input.task_session.owner_identity,
      persisted: input.persisted,
      semantic_prompt: input.semantic_prompt,
      now: input.now,
    });
  }
  const semanticInput = runAutomaticBuildTaskInput(
    input.target,
    input.task_session.stage,
    input.task_session.work_unit_id,
    input.task_session.lease_ref,
    input.task_session.lease_token,
    { now: input.now, run_ttl_ms: input.persisted.run_ttl_ms },
  ).stdout;
  const outputContract: AutomaticBuildSemanticCandidateContractV1 = {
    version: "automatic_build_semantic_candidate_contract.v1",
    format: "strict_json",
    encoding: "utf-8",
    max_bytes: MAX_CANDIDATE_BYTES,
    stage: input.descriptor.stage,
    work_unit_id: input.descriptor.work_unit_id,
    work_unit_kind: input.descriptor.kind,
    input_hash: input.descriptor.input_hash,
    semantic_attempt: input.task_session.semantic_attempt,
  };
  return {
    version: "automatic_build_executor_session.v1",
    action: {
      kind: "GENERATE",
      opaque_session_ref: input.task_session.opaque_session_ref,
      semantic_prompt: input.semantic_prompt,
      semantic_input: semanticInput,
      output_contract: outputContract,
    },
  };
}

function terminalResponseFromReceipt(
  terminalReason: "complete" | "task_failure" | "executor_interrupted",
): AutomaticBuildExecutorSessionResponseV1 {
  return doneResponse(terminalStatus(terminalReason));
}

function drivePublicExecutorSession(input: {
  opaque_handoff_ref: string;
  open_record: AutomaticBuildExecutorOpenRecordV1;
  target: AutomaticBuildTarget;
  owner: AutomaticBuildDispatchOwnerIdentityV1;
  persisted: AutomaticBuildPersistedDispatchV1;
  semantic_prompt: string;
  now: string;
}): AutomaticBuildExecutorSessionResponseV1 {
  const inspection = inspectAutomaticBuildDispatch(
    input.target,
    input.owner.stage,
    input.owner.dispatch_id,
    input.now,
    input.owner.dispatch_run_id,
  );
  if (inspection.state === "finished") {
    return terminalResponseFromReceipt(inspection.receipt.terminal_reason);
  }
  const nextWorkUnitId = inspection.next_work_unit_id;
  if (!nextWorkUnitId) {
    const receipt = finishAutomaticBuildDispatch(
      input.target,
      input.owner.stage,
      input.owner.dispatch_id,
      { now: input.now, dispatch_run_id: input.owner.dispatch_run_id },
    );
    return terminalResponseFromReceipt(receipt.terminal_reason);
  }
  const stage = taskDescriptor(input.target, input.persisted, nextWorkUnitId);
  const advanced = advanceAutomaticBuildDispatch(
    input.target,
    input.owner.stage,
    input.owner.dispatch_id,
    {
      descriptors: stage.descriptors,
      task_bindings: stage.task_bindings,
      dispatch_run_id: input.owner.dispatch_run_id,
      now: input.now,
      max_semantic_attempts: MAX_SEMANTIC_ATTEMPTS,
      max_lease_epochs: MAX_LEASE_EPOCHS,
    },
  );
  if (advanced.status === "finished") {
    return terminalResponseFromReceipt(advanced.receipt.terminal_reason);
  }
  if (advanced.status === "ready_to_finish") {
    const receipt = finishAutomaticBuildDispatch(
      input.target,
      input.owner.stage,
      input.owner.dispatch_id,
      { now: input.now, dispatch_run_id: input.owner.dispatch_run_id },
    );
    return terminalResponseFromReceipt(receipt.terminal_reason);
  }
  if (advanced.status === "retry_exhausted") {
    const receipt = finishAutomaticBuildDispatch(
      input.target,
      input.owner.stage,
      input.owner.dispatch_id,
      {
        terminal_reason: "task_failure",
        now: input.now,
        dispatch_run_id: input.owner.dispatch_run_id,
      },
    );
    return terminalResponseFromReceipt(receipt.terminal_reason);
  }
  if (advanced.status === "executor_instability") {
    const receipt = finishAutomaticBuildDispatch(
      input.target,
      input.owner.stage,
      input.owner.dispatch_id,
      {
        terminal_reason: "executor_interrupted",
        interruption: {
          diagnostic_code: "executor_lost",
          reporter: "build_engine",
          last_command_role: "dispatch_next",
        },
        now: input.now,
        dispatch_run_id: input.owner.dispatch_run_id,
      },
    );
    return terminalResponseFromReceipt(receipt.terminal_reason);
  }
  let claim: ActiveAutomaticBuildClaim;
  if (advanced.status === "leased") {
    claim = advanced.claim;
  } else {
    if (advanced.status !== "waiting") {
      throw new Error(`unhandled executor dispatch state: ${advanced.status}`);
    }
    const current = inspectAutomaticBuildTaskClaim(
      input.target,
      input.owner.stage,
      advanced.work_unit_id,
      {
        now: input.now,
        max_semantic_attempts: MAX_SEMANTIC_ATTEMPTS,
        max_lease_epochs: MAX_LEASE_EPOCHS,
      },
    );
    if (current.status !== "already_leased" || current.lease.owner !== input.persisted.owner) {
      return waitResponse(advanced.retry_after_ms);
    }
    claim = current;
  }
  const descriptor = taskDescriptor(input.target, input.persisted, claim.lease.work_unit_id).descriptor;
  const taskSession = persistTaskSessionRecord({
    opaque_handoff_ref: input.opaque_handoff_ref,
    open_record: input.open_record,
    owner: input.owner,
    claim,
    created_at: input.now,
  });
  return generateAction({
    target: input.target,
    persisted: input.persisted,
    semantic_prompt: input.semantic_prompt,
    task_session: taskSession,
    descriptor,
    now: input.now,
  });
}

function resolveTaskSession(opaqueSessionRefValue: string): {
  task_session: AutomaticBuildExecutorTaskSessionRecordV1;
  target: AutomaticBuildTarget;
  owner: AutomaticBuildDispatchOwnerIdentityV1;
  persisted: AutomaticBuildPersistedDispatchV1;
  semantic_prompt: string;
  open_record: AutomaticBuildExecutorOpenRecordV1;
} {
  const taskSession = readTaskSessionRecord(opaqueSessionRefValue);
  const handoffRecord = readOpaqueHandoffRecord(taskSession.opaque_handoff_ref);
  const published = validatePublishedPublicDispatch(handoffRecord);
  if (canonicalAutomaticBuildJson(published.owner)
    !== canonicalAutomaticBuildJson(taskSession.owner_identity)) {
    throw new Error("executor task session owner identity changed");
  }
  const openFile = registryFile("executor-opens", taskSession.opaque_handoff_ref);
  if (!existsSync(openFile)) throw new Error("executor task session open record is missing");
  const openRecord = validateOpenRecord(
    decodeJsonRecord(openFile),
    taskSession.opaque_handoff_ref,
    published.owner,
  );
  if (openRecord.opaque_session_ref !== taskSession.open_session_ref) {
    throw new Error("executor task session open identity changed");
  }
  const lease = readAutomaticBuildLease(
    published.target,
    taskSession.lease_ref,
    taskSession.lease_token,
  );
  if (lease.stage !== taskSession.stage
    || lease.work_unit_id !== taskSession.work_unit_id
    || lease.attempt !== taskSession.physical_attempt
    || lease.owner !== published.persisted.owner) {
    throw new Error("executor task session lease identity changed");
  }
  const execution = readAutomaticBuildExecutionIdentity(
    published.target,
    lease.stage,
    lease.work_unit_id,
    lease.attempt,
  );
  if (!execution
    || execution.semantic_attempt !== taskSession.semantic_attempt
    || execution.lease_epoch !== taskSession.lease_epoch) {
    throw new Error("executor task session execution identity changed");
  }
  return {
    task_session: taskSession,
    target: published.target,
    owner: published.owner,
    persisted: published.persisted,
    semantic_prompt: published.semantic_prompt,
    open_record: openRecord,
  };
}

function submitPrivateArtifactContext(
  context: AutomaticBuildPrivateArtifactContextV1,
  now: string,
): ReturnType<typeof submitIntentArtifactTaskAttempt> {
  return submitIntentArtifactTaskAttempt({
    private_root: context.attempt.private_root,
    task_path: context.attempt.task_path,
    current_intent: context.intent,
    current_plan: context.plan,
    current_source_fingerprint: context.target.target_ref.input_fingerprint,
    available_lids: context.available_lids,
    resolved_scope_lids: context.resolved_scope_lids,
    accepted_at: now,
  });
}

function privateGenerateAction(
  context: AutomaticBuildPrivateArtifactContextV1,
  session: AutomaticBuildExecutorPrivateSessionRecordV1,
  now: string,
): AutomaticBuildExecutorSessionResponseV1 {
  if (context.inspection.state === "committed") return doneResponse("committed");
  if (context.inspection.state === "retryable_failure") return doneResponse("retryable_failure");
  if (existsSync(context.attempt.candidate_path)) {
    submitPrivateArtifactContext(context, now);
    return doneResponse("committed");
  }
  return {
    version: "automatic_build_executor_session.v1",
    action: {
      kind: "GENERATE",
      opaque_session_ref: session.opaque_session_ref,
      semantic_prompt: [
        "Generate exactly one reader-private intent_artifact_candidate.v2.",
        "Use the task goal, frozen Blueprint, validation rules, and allowed evidence LIDs.",
        "Return strict JSON only; do not include the candidate in the executor final message.",
      ].join("\n"),
      semantic_input: context.attempt.task,
      output_contract: {
        version: "automatic_build_private_artifact_candidate_contract.v1",
        format: "strict_json",
        encoding: "utf-8",
        max_bytes: MAX_CANDIDATE_BYTES,
        candidate_version: "intent_artifact_candidate.v2",
        artifact_instance: context.attempt.task.output_contract,
      },
    },
  };
}

function resolvePrivateExecutorSession(opaqueSessionRefValue: string): {
  session: AutomaticBuildExecutorPrivateSessionRecordV1;
  open_record: AutomaticBuildExecutorOpenRecordV1;
  context: AutomaticBuildPrivateArtifactContextV1;
} | undefined {
  const session = readPrivateSessionRecord(opaqueSessionRefValue);
  if (!session) return undefined;
  const handoffRecord = readOpaqueHandoffRecord(session.opaque_handoff_ref);
  const context = resolvePrivateArtifactContext(handoffRecord);
  if (canonicalAutomaticBuildJson(context.owner)
    !== canonicalAutomaticBuildJson(session.owner_identity)) {
    throw new Error("executor private session owner identity changed");
  }
  const openFile = registryFile("executor-opens", session.opaque_handoff_ref);
  if (!existsSync(openFile)) throw new Error("executor private session open record is missing");
  const openRecord = validateOpenRecord(
    decodeJsonRecord(openFile),
    session.opaque_handoff_ref,
    context.owner,
  );
  if (openRecord.opaque_session_ref !== session.open_session_ref) {
    throw new Error("executor private session open identity changed");
  }
  return { session, open_record: openRecord, context };
}

function terminalStatus(
  terminalReason: "complete" | "task_failure" | "executor_interrupted",
): Extract<AutomaticBuildExecutorSessionActionV1, { kind: "DONE" }>["status"] {
  if (terminalReason === "complete") return "committed";
  if (terminalReason === "task_failure") return "retryable_failure";
  return "interrupted";
}

export function openAutomaticBuildExecutorSession(
  opaqueHandoffRefValue: string,
  options: { now?: string } = {},
): AutomaticBuildExecutorSessionResponseV1 {
  const opaqueHandoffRef = validateOpaqueHandoffRef(opaqueHandoffRefValue);
  const now = options.now === undefined ? new Date().toISOString() : isoTimestamp(options.now, "now");
  const record = readOpaqueHandoffRecord(opaqueHandoffRef);
  if (record.kind === "private_artifact") {
    const context = resolvePrivateArtifactContext(record);
    if (context.inspection.state === "committed") return doneResponse("committed");
    if (context.inspection.state === "retryable_failure") return doneResponse("retryable_failure");
    const openFile = registryFile("executor-opens", opaqueHandoffRef);
    const openRecord: AutomaticBuildExecutorOpenRecordV1 = {
      version: "automatic_build_executor_open_record.v1",
      opaque_handoff_ref: opaqueHandoffRef,
      opaque_session_ref: `absession1_${sha256({
        version: "automatic_build_executor_session_identity.v1",
        opaque_handoff_ref: opaqueHandoffRef,
        nonce: randomUUID(),
      })}`,
      owner_identity: context.owner,
      opened_at: now,
    };
    let activeOpen = openRecord;
    if (!writeCreateOnly(openFile, openRecord)) {
      activeOpen = validateOpenRecord(decodeJsonRecord(openFile), opaqueHandoffRef, context.owner);
    }
    const session = persistPrivateSessionRecord({
      opaque_handoff_ref: opaqueHandoffRef,
      open_record: activeOpen,
      owner: context.owner,
      created_at: now,
    });
    return privateGenerateAction(context, session, now);
  }
  const published = validatePublishedPublicDispatch(record);
  const { target, owner } = published;
  const inspection = inspectAutomaticBuildDispatch(
    target,
    owner.stage,
    owner.dispatch_id,
    now,
    owner.dispatch_run_id,
  );
  if (inspection.state === "finished") {
    return terminalResponseFromReceipt(inspection.receipt.terminal_reason);
  }

  const openFile = registryFile("executor-opens", opaqueHandoffRef);
  const openRecord: AutomaticBuildExecutorOpenRecordV1 = {
    version: "automatic_build_executor_open_record.v1",
    opaque_handoff_ref: opaqueHandoffRef,
    opaque_session_ref: `absession1_${sha256({
      version: "automatic_build_executor_session_identity.v1",
      opaque_handoff_ref: opaqueHandoffRef,
      nonce: randomUUID(),
    })}`,
    owner_identity: owner,
    opened_at: now,
  };
  let activeOpen = openRecord;
  if (!writeCreateOnly(openFile, openRecord)) {
    activeOpen = validateOpenRecord(decodeJsonRecord(openFile), opaqueHandoffRef, owner);
  }
  return drivePublicExecutorSession({
    opaque_handoff_ref: opaqueHandoffRef,
    open_record: activeOpen,
    target,
    owner,
    persisted: published.persisted,
    semantic_prompt: published.semantic_prompt,
    now,
  });
}

export function submitAutomaticBuildExecutorCandidate(
  opaqueSessionRefValue: string,
  candidatePathValue: string,
  options: { now?: string } = {},
): AutomaticBuildExecutorSessionResponseV1 {
  const now = options.now === undefined ? new Date().toISOString() : isoTimestamp(options.now, "now");
  const candidatePath = path.resolve(boundedString(candidatePathValue, "candidate_path"));
  const privateResolved = resolvePrivateExecutorSession(opaqueSessionRefValue);
  if (privateResolved) {
    stageIntentArtifactTaskCandidate({
      private_root: privateResolved.context.attempt.private_root,
      task_path: privateResolved.context.attempt.task_path,
      candidate_path: candidatePath,
      max_candidate_bytes: MAX_CANDIDATE_BYTES,
    });
    submitPrivateArtifactContext(privateResolved.context, now);
    return doneResponse("committed");
  }
  const resolved = resolveTaskSession(opaqueSessionRefValue);
  const taskState = inspectAutomaticBuildTask(
    resolved.target,
    resolved.task_session.lease_ref,
    resolved.task_session.lease_token,
  );
  if (taskState.state !== "leased") {
    assertCandidateReplayMatches(resolved.task_session, candidatePath);
  } else {
    stageAutomaticBuildCandidate(
      resolved.target,
      resolved.task_session.lease_ref,
      resolved.task_session.lease_token,
      candidatePath,
      { now },
    );
    submitAutomaticBuildTaskCandidate(
      resolved.target,
      resolved.task_session.stage,
      resolved.task_session.work_unit_id,
      resolved.task_session.lease_ref,
      resolved.task_session.lease_token,
      { now },
    );
  }
  return drivePublicExecutorSession({
    opaque_handoff_ref: resolved.task_session.opaque_handoff_ref,
    open_record: resolved.open_record,
    target: resolved.target,
    owner: resolved.owner,
    persisted: resolved.persisted,
    semantic_prompt: resolved.semantic_prompt,
    now,
  });
}

export function failAutomaticBuildExecutorSession(
  opaqueSessionRefValue: string,
  input: { diagnostic_code: string; message?: string; now?: string },
): AutomaticBuildExecutorSessionResponseV1 {
  const now = input.now === undefined ? new Date().toISOString() : isoTimestamp(input.now, "now");
  const diagnosticCode = boundedString(input.diagnostic_code, "diagnostic_code", 256);
  const message = input.message === undefined
    ? undefined
    : boundedString(input.message, "message", 2_048);
  const privateResolved = resolvePrivateExecutorSession(opaqueSessionRefValue);
  if (privateResolved) {
    if (privateResolved.context.inspection.state === "committed") return doneResponse("committed");
    failIntentArtifactTaskAttempt({
      private_root: privateResolved.context.attempt.private_root,
      task_path: privateResolved.context.attempt.task_path,
      diagnostic_code: diagnosticCode,
      ...(message ? { message } : {}),
      failed_at: now,
    });
    return doneResponse("retryable_failure");
  }
  const resolved = resolveTaskSession(opaqueSessionRefValue);
  const taskState = inspectAutomaticBuildTask(
    resolved.target,
    resolved.task_session.lease_ref,
    resolved.task_session.lease_token,
  );
  if (taskState.state === "leased") {
    failAutomaticBuildTask(
      resolved.target,
      resolved.task_session.lease_ref,
      resolved.task_session.lease_token,
      {
        diagnostic_code: diagnosticCode,
        ...(message ? { message } : {}),
        now,
      },
    );
  }
  return drivePublicExecutorSession({
    opaque_handoff_ref: resolved.task_session.opaque_handoff_ref,
    open_record: resolved.open_record,
    target: resolved.target,
    owner: resolved.owner,
    persisted: resolved.persisted,
    semantic_prompt: resolved.semantic_prompt,
    now,
  });
}

export function heartbeatAutomaticBuildExecutorSession(
  opaqueSessionRefValue: string,
  options: { now?: string; ttl_ms?: number } = {},
): AutomaticBuildExecutorSessionResponseV1 {
  const resolved = resolveTaskSession(opaqueSessionRefValue);
  const now = options.now === undefined ? new Date().toISOString() : isoTimestamp(options.now, "now");
  const taskState = inspectAutomaticBuildTask(
    resolved.target,
    resolved.task_session.lease_ref,
    resolved.task_session.lease_token,
  );
  if (taskState.state !== "leased") {
    return drivePublicExecutorSession({
      opaque_handoff_ref: resolved.task_session.opaque_handoff_ref,
      open_record: resolved.open_record,
      target: resolved.target,
      owner: resolved.owner,
      persisted: resolved.persisted,
      semantic_prompt: resolved.semantic_prompt,
      now,
    });
  }
  const ttlMs = options.ttl_ms === undefined
    ? undefined
    : positiveSafeInteger(options.ttl_ms, "ttl_ms");
  heartbeatAutomaticBuildLease(
    resolved.target,
    resolved.task_session.lease_ref,
    resolved.task_session.lease_token,
    { now, ...(ttlMs === undefined ? {} : { ttl_ms: ttlMs }) },
  );
  return waitResponse(1_000);
}

export function interruptAutomaticBuildExecutorSession(
  opaqueSessionRefValue: string,
  input: AutomaticBuildExecutorInterruptionInputV1 & { now?: string },
): AutomaticBuildExecutorSessionResponseV1 {
  const resolved = resolveTaskSession(opaqueSessionRefValue);
  const now = input.now === undefined ? new Date().toISOString() : isoTimestamp(input.now, "now");
  const receipt = finishAutomaticBuildDispatch(
    resolved.target,
    resolved.owner.stage,
    resolved.owner.dispatch_id,
    {
      terminal_reason: "executor_interrupted",
      interruption: {
        diagnostic_code: input.diagnostic_code,
        reporter: input.reporter,
        last_command_role: input.last_command_role,
      },
      now,
      dispatch_run_id: resolved.owner.dispatch_run_id,
    },
  );
  return terminalResponseFromReceipt(receipt.terminal_reason);
}

function validateOpenRequest(value: unknown): AutomaticBuildExecutorOpenRequestV1 {
  if (!isRecord(value)) throw new Error("executor.open request must be an object");
  exactKeys(value, ["version", "opaque_handoff_ref"], ["now"]);
  if (value.version !== "automatic_build_executor_open_request.v1") {
    throw new Error("executor.open request version is unsupported");
  }
  return {
    version: value.version,
    opaque_handoff_ref: validateOpaqueHandoffRef(value.opaque_handoff_ref),
    ...(value.now === undefined ? {} : { now: isoTimestamp(value.now, "now") }),
  };
}

function validateSubmitRequest(value: unknown): AutomaticBuildExecutorSubmitRequestV1 {
  if (!isRecord(value)) throw new Error("executor submit request must be an object");
  exactKeys(value, ["version", "opaque_session_ref", "candidate_path"], ["now"]);
  if (value.version !== "automatic_build_executor_submit_request.v1") {
    throw new Error("executor submit request version is unsupported");
  }
  return {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    candidate_path: boundedString(value.candidate_path, "candidate_path"),
    ...(value.now === undefined ? {} : { now: isoTimestamp(value.now, "now") }),
  };
}

function validateFailRequest(value: unknown): AutomaticBuildExecutorFailRequestV1 {
  if (!isRecord(value)) throw new Error("executor fail request must be an object");
  exactKeys(
    value,
    ["version", "opaque_session_ref", "diagnostic_code"],
    ["message", "now"],
  );
  if (value.version !== "automatic_build_executor_fail_request.v1") {
    throw new Error("executor fail request version is unsupported");
  }
  return {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    diagnostic_code: boundedString(value.diagnostic_code, "diagnostic_code", 256),
    ...(value.message === undefined ? {} : { message: boundedString(value.message, "message", 2_048) }),
    ...(value.now === undefined ? {} : { now: isoTimestamp(value.now, "now") }),
  };
}

function validateHeartbeatRequest(value: unknown): AutomaticBuildExecutorHeartbeatRequestV1 {
  if (!isRecord(value)) throw new Error("executor heartbeat request must be an object");
  exactKeys(value, ["version", "opaque_session_ref"], ["ttl_ms", "now"]);
  if (value.version !== "automatic_build_executor_heartbeat_request.v1") {
    throw new Error("executor heartbeat request version is unsupported");
  }
  return {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    ...(value.ttl_ms === undefined ? {} : { ttl_ms: positiveSafeInteger(value.ttl_ms, "ttl_ms") }),
    ...(value.now === undefined ? {} : { now: isoTimestamp(value.now, "now") }),
  };
}

function validateInterruptRequest(value: unknown): AutomaticBuildExecutorInterruptRequestV1 {
  if (!isRecord(value)) throw new Error("executor interrupt request must be an object");
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "diagnostic_code",
    "reporter",
    "last_command_role",
  ], ["now"]);
  if (value.version !== "automatic_build_executor_interrupt_request.v1") {
    throw new Error("executor interrupt request version is unsupported");
  }
  return {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    diagnostic_code: boundedString(value.diagnostic_code, "diagnostic_code", 128) as AutomaticBuildExecutorInterruptionInputV1["diagnostic_code"],
    reporter: boundedString(value.reporter, "reporter", 64) as AutomaticBuildExecutorInterruptionInputV1["reporter"],
    last_command_role: boundedString(value.last_command_role, "last_command_role", 64) as AutomaticBuildExecutorInterruptionInputV1["last_command_role"],
    ...(value.now === undefined ? {} : { now: isoTimestamp(value.now, "now") }),
  };
}

export function runAutomaticBuildExecutorSessionCommand(value: unknown): AutomaticBuildExecutorSessionResponseV1 {
  if (!isRecord(value) || typeof value.version !== "string") {
    throw new Error("executor session request must be a versioned object");
  }
  if (value.version === "automatic_build_executor_open_request.v1") {
    const request = validateOpenRequest(value);
    return openAutomaticBuildExecutorSession(request.opaque_handoff_ref, { now: request.now });
  }
  if (value.version === "automatic_build_executor_submit_request.v1") {
    const request = validateSubmitRequest(value);
    return submitAutomaticBuildExecutorCandidate(
      request.opaque_session_ref,
      request.candidate_path,
      { now: request.now },
    );
  }
  if (value.version === "automatic_build_executor_fail_request.v1") {
    const request = validateFailRequest(value);
    return failAutomaticBuildExecutorSession(request.opaque_session_ref, {
      diagnostic_code: request.diagnostic_code,
      ...(request.message ? { message: request.message } : {}),
      ...(request.now ? { now: request.now } : {}),
    });
  }
  if (value.version === "automatic_build_executor_heartbeat_request.v1") {
    const request = validateHeartbeatRequest(value);
    return heartbeatAutomaticBuildExecutorSession(request.opaque_session_ref, {
      ...(request.ttl_ms === undefined ? {} : { ttl_ms: request.ttl_ms }),
      ...(request.now ? { now: request.now } : {}),
    });
  }
  if (value.version === "automatic_build_executor_interrupt_request.v1") {
    const request = validateInterruptRequest(value);
    return interruptAutomaticBuildExecutorSession(request.opaque_session_ref, {
      diagnostic_code: request.diagnostic_code,
      reporter: request.reporter,
      last_command_role: request.last_command_role,
      ...(request.now ? { now: request.now } : {}),
    });
  }
  throw new Error("executor session request version is unsupported");
}

function readStdinRequest(): unknown {
  const bytes = readFileSync(0);
  if (!bytes.byteLength || bytes.byteLength > MAX_STDIN_BYTES || bytes.includes(0)) {
    throw new Error("executor session stdin is empty or exceeds its byte limit");
  }
  // TextDecoder consumes one leading UTF-8 BOM, matching Windows PowerShell 5.1 native pipelines.
  // Additional BOMs remain U+FEFF and are rejected by JSON.parse below.
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function isCommandEntrypoint(): boolean {
  return path.basename(process.argv[1] ?? "") === "automatic-build-executor-session.ts";
}

if (isCommandEntrypoint()) {
  try {
    process.stdout.write(`${canonicalAutomaticBuildJson(runAutomaticBuildExecutorSessionCommand(
      readStdinRequest(),
    ))}\n`);
  } catch {
    process.stderr.write("executor session failed; inspect deterministic build state for diagnostics\n");
    process.exitCode = 2;
  }
}
