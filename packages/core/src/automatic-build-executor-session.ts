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
import { isAutomaticBuildTaskPolicyBindingV2 } from "./semantic-artifact";
import {
  renderAutomaticBuildTaskInput,
  runAutomaticBuildFrozenTaskInput,
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
  stageAutomaticBuildCandidateValue,
  type AutomaticBuildJsonValue,
} from "./automatic-build-mailbox";
import {
  automaticBuildFailureDiagnosticFromExecutorReport,
  createAutomaticBuildFailureDiagnosticV3,
  type AutomaticBuildFailureDiagnosticV3,
} from "./extractor-contract";
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
  CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1,
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  measureExecutorTransportResponse,
  packExecutorTransportBatches,
  packExecutorTransportPayload,
  serializeExecutorMcpToolResult,
  validateExecutorTransportPack,
  validateExecutorTransportProfile,
  type ExecutorTransportChunkFrameV2,
  type PackedExecutorTransportBatchV1,
  type ExecutorTransportPackWithinLimitV2,
  type ExecutorTransportProfileV2,
} from "./executor-transport";
import {
  validateBuildIntentV3,
  validateBuildPlanV3,
  adaptBuildPlanV1PrivateArtifacts,
  migratePlanningControlV2ToV3,
  validateBuildIntentAny,
  validateBuildPlanAny,
  type BuildIntentV3,
  type BuildPlanV3,
} from "./build-intent-v2";
import {
  computeBuildIntentDigest,
  type BuildIntentV1,
  type BuildPlanV1,
} from "./build-intent";

export type AutomaticBuildExecutorServerPhaseBoundaryV1 =
  | "current-state/claim"
  | "input-render-or-reuse"
  | "candidate-gate"
  | "writer/commit";

export interface AutomaticBuildExecutorServerTimingObserverV1 {
  complete_phase: (phase: AutomaticBuildExecutorServerPhaseBoundaryV1) => void;
}
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
  type IntentArtifactTaskEnvelopeV3,
} from "./intent-artifact";
import { markdownToBlocks } from "./md-adapter";
import { segment } from "./segment";
import type { WorkUnitDescriptor } from "./stage-work-unit";
import { estimateTokens } from "./window";
import { ReadOnlyBaseZ } from "./zod";

const MAX_RECORD_BYTES = 1_048_576;
const MAX_CONTROL_STDIN_BYTES = 8_192;
const MAX_STDIN_BYTES = CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes;
const MAX_REF_BYTES = 1_024;
const MAX_CANDIDATE_BYTES = 4 * 1_048_576;
const MAX_SEMANTIC_ATTEMPTS = 3;
const MAX_LEASE_EPOCHS = 3;
const SEMANTIC_PROMPT_SEPARATOR = "<!-- AUTOMATIC_BUILD_EXECUTOR_SEMANTIC_PROMPT -->";
const OPAQUE_HANDOFF_REF = /^abhandoff1_[a-f0-9]{64}$/u;
const OPAQUE_SESSION_REF = /^absession1_[a-f0-9]{64}$/u;
const GENERATION_INPUT_REF = /^abinput1_[a-f0-9]{64}$/u;
const GENERATION_GRANT_REF = /^abgrant1_[a-f0-9]{64}$/u;
const CANDIDATE_SINK_REF = /^absink1_[a-f0-9]{64}$/u;
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

export class AutomaticBuildExecutorTransportError extends Error {
  readonly failure_diagnostic: AutomaticBuildFailureDiagnosticV3;

  constructor() {
    super("automatic build executor input transport budget is exceeded");
    this.name = "AutomaticBuildExecutorTransportError";
    this.failure_diagnostic = createAutomaticBuildFailureDiagnosticV3({
      category: "budget",
      code: "input_transport_budget_exceeded",
      phase: "input_delivery",
    });
  }
}

export interface AutomaticBuildDispatchOwnerIdentityV1 {
  version: "automatic_build_dispatch_owner_identity.v1";
  stage: AutomaticBuildStage;
  dispatch_id: string;
  dispatch_run_id: string;
}

export interface AutomaticBuildPrivateArtifactOwnerIdentityV2 {
  version: "automatic_build_private_artifact_owner_identity.v2";
  task_id: string;
  book_id: string;
  source_fingerprint: string;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  blueprint_id: string;
  blueprint_version: string;
  attempt: number;
}

type AutomaticBuildExecutorOwnerIdentityV1 =
  | AutomaticBuildDispatchOwnerIdentityV1
  | AutomaticBuildPrivateArtifactOwnerIdentityV2;

export function adaptAutomaticBuildPrivateArtifactSelectionV3(
  intentInput: unknown,
  planInput: unknown,
): { intent: BuildIntentV3; plan: BuildPlanV3 } {
  const intent = validateBuildIntentAny(intentInput);
  const plan = validateBuildPlanAny(planInput);
  if (intent.version === "build_intent.v3" && plan.version === "build_plan.v3") {
    return {
      intent: validateBuildIntentV3(intent),
      plan: validateBuildPlanV3(plan),
    };
  }
  if (intent.version === "build_intent.v2" && plan.version === "build_plan.v2") {
    const migrated = migratePlanningControlV2ToV3({ intent, plan });
    if (!migrated.intent) throw new Error("goal-directed private selection lost its BuildIntent");
    return { intent: migrated.intent, plan: migrated.plan };
  }
  if (intent.version !== "build_intent.v1" || plan.version !== "build_plan.v1") {
    throw new Error("private BuildIntent and BuildPlan generations do not match");
  }
  const legacyIntent = intent as BuildIntentV1;
  const legacyPlan = plan as BuildPlanV1;
  if (legacyPlan.recipe_id !== "goal_directed"
    || legacyPlan.intent_id !== legacyIntent.intent_id
    || legacyPlan.intent_digest !== computeBuildIntentDigest(legacyIntent)) {
    throw new Error("legacy private BuildPlan does not match its fully validated BuildIntent");
  }
  const {
    revision: intentRevision,
    desired_artifacts: _desiredArtifacts,
    ...intentBody
  } = legacyIntent;
  const migratedIntent = validateBuildIntentV3({
    ...intentBody,
    version: "build_intent.v3",
    intent_revision: intentRevision,
  });
  const {
    revision: planRevision,
    intent_digest: _intentDigest,
    plan_digest: _planDigest,
    private_artifacts: _privateArtifacts,
    ...planBody
  } = legacyPlan;
  const migratedPlan = validateBuildPlanV3({
    ...planBody,
    version: "build_plan.v3",
    plan_revision: planRevision,
    intent_revision: migratedIntent.intent_revision,
    private_artifacts: adaptBuildPlanV1PrivateArtifacts(legacyPlan).map((artifact) => {
      const { blueprint_digest: _blueprintDigest, ...artifactBody } = artifact;
      return {
        ...artifactBody,
        blueprint_id: artifact.blueprint.blueprint_id,
        blueprint_version: artifact.blueprint.blueprint_version,
      };
    }),
  });
  return { intent: migratedIntent, plan: migratedPlan };
}

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

export interface AutomaticBuildOpaqueHandoffRecordV3 {
  version: "automatic_build_opaque_handoff_record.v3";
  session_protocol: "automatic_build_executor_session.v3";
  opaque_handoff_ref: string;
  kind: "public_dispatch";
  target_ref: BuildTargetRefV2;
  target_locator: AutomaticBuildTargetLocatorV1;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  handoff_path: string;
  handoff_sha256: string;
  handoff_byte_length: number;
  issued_at: string;
}

type AutomaticBuildOpaqueHandoffRecord =
  | AutomaticBuildOpaqueHandoffRecordV1
  | AutomaticBuildOpaqueHandoffRecordV3;

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
  owner_identity: AutomaticBuildPrivateArtifactOwnerIdentityV2;
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

interface AutomaticBuildExecutorDeliverySessionRecordV3 {
  version: "automatic_build_executor_delivery_session_record.v3";
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  open_session_ref: string;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  generation_input_ref: string;
  transport_profile: typeof CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  semantic_prompt_sha256: string;
  semantic_prompt_byte_length: number;
  semantic_input_sha256: string;
  semantic_input_byte_length: number;
  semantic_prompt_chunk_count: number;
  semantic_input_chunk_count: number;
  total_chunk_count: number;
  output_schema_version: string;
  created_at: string;
}

interface AutomaticBuildExecutorPrivateDeliverySessionRecordV3 {
  version: "automatic_build_executor_private_delivery_session_record.v3";
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  open_session_ref: string;
  owner_identity: AutomaticBuildPrivateArtifactOwnerIdentityV2;
  task_id: string;
  generation_input_ref: string;
  transport_profile: typeof CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  semantic_prompt_sha256: string;
  semantic_prompt_byte_length: number;
  semantic_input_sha256: string;
  semantic_input_byte_length: number;
  semantic_prompt_chunk_count: number;
  semantic_input_chunk_count: number;
  total_chunk_count: number;
  output_schema_version: string;
  created_at: string;
}

type AutomaticBuildExecutorAnyDeliverySessionRecordV3 =
  | AutomaticBuildExecutorDeliverySessionRecordV3
  | AutomaticBuildExecutorPrivateDeliverySessionRecordV3;

interface AutomaticBuildExecutorGenerationInputRecordV1 {
  version: "automatic_build_executor_generation_input_record.v1";
  opaque_session_ref: string;
  generation_input_ref: string;
  semantic_prompt: string;
  semantic_input: string;
  semantic_prompt_sha256: string;
  semantic_input_sha256: string;
  created_at: string;
}

interface AutomaticBuildExecutorDeliveryReceiptRecordV2 {
  version: "automatic_build_executor_delivery_receipt_record.v2";
  opaque_session_ref: string;
  generation_input_ref: string;
  ordinal: number;
  confirmed_at: string;
}

interface AutomaticBuildExecutorBatchOfferRecordV1 {
  version: "automatic_build_executor_batch_offer_record.v1";
  opaque_session_ref: string;
  generation_input_ref: string;
  first_ordinal: number;
  last_ordinal: number;
  offered_at: string;
}

interface AutomaticBuildExecutorGenerationGrantRecordV2 {
  version: "automatic_build_executor_generation_grant_record.v2";
  opaque_session_ref: string;
  generation_input_ref: string;
  generation_grant_ref: string;
  final_delivered_ordinal: number;
  output_schema_version: string;
  issued_at: string;
}

interface AutomaticBuildExecutorGenerationStartAcceptanceV1 {
  version: "automatic_build_executor_generation_start_acceptance.v1";
  opaque_session_ref: string;
  generation_input_ref: string;
  generation_grant_ref: string;
  accepted_at: string;
}

interface AutomaticBuildExecutorGenerationStartRecordV2 {
  version: "automatic_build_executor_generation_start_record.v2";
  opaque_session_ref: string;
  generation_input_ref: string;
  generation_grant_ref: string;
  task_session_ref: string;
  semantic_attempt: number;
  response: AutomaticBuildExecutorSessionResponseV3;
  started_at: string;
}

interface AutomaticBuildExecutorCandidateSinkRecordV2 {
  version: "automatic_build_executor_candidate_sink_record.v2";
  candidate_sink_ref: string;
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  delivery_session_ref: string;
  generation_input_ref: string;
  generation_grant_ref: string;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  output_schema_version: string;
  created_at: string;
}

interface AutomaticBuildExecutorPrivateCandidateSinkRecordV3 {
  version: "automatic_build_executor_private_candidate_sink_record.v3";
  candidate_sink_ref: string;
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  delivery_session_ref: string;
  generation_input_ref: string;
  generation_grant_ref: string;
  owner_identity: AutomaticBuildPrivateArtifactOwnerIdentityV2;
  task_id: string;
  attempt: number;
  output_schema_version: string;
  created_at: string;
}

type AutomaticBuildExecutorAnyCandidateSinkRecord =
  | AutomaticBuildExecutorCandidateSinkRecordV2
  | AutomaticBuildExecutorPrivateCandidateSinkRecordV3;

export type JsonValue = AutomaticBuildJsonValue;

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

export interface AutomaticBuildSemanticCandidateContractV2 {
  version: "automatic_build_semantic_candidate_contract.v2";
  format: "strict_json";
  encoding: "utf-8";
  max_bytes: number;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  work_unit_kind: string;
  input_hash: string;
}

export interface AutomaticBuildPrivateArtifactCandidateContractV2 {
  version: "automatic_build_private_artifact_candidate_contract.v2";
  format: "strict_json";
  encoding: "utf-8";
  max_bytes: number;
  candidate_version: "intent_artifact_candidate.v3";
  task_id: string;
  artifact_id: string;
  blueprint_id: string;
  blueprint_version: string;
  artifact_instance: IntentArtifactTaskEnvelopeV3["output_contract"];
}

type AutomaticBuildExecutorOutputContractV3 =
  | AutomaticBuildSemanticCandidateContractV2
  | AutomaticBuildPrivateArtifactCandidateContractV2;

export interface AutomaticBuildExecutorInputManifestV3 {
  version: "automatic_build_executor_input_manifest.v3";
  opaque_session_ref: string;
  generation_input_ref: string;
  transport_profile: typeof CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  segments: Array<{
    kind: "semantic_prompt" | "semantic_input";
    byte_length: number;
    sha256: string;
    chunk_count: number;
  }>;
  total_chunk_count: number;
}

export interface AutomaticBuildExecutorInputNextRequestV4 {
  version: "automatic_build_executor_input_next_request.v4";
  opaque_session_ref: string;
  generation_input_ref: string;
  ack_through_ordinal?: number;
  now?: string;
}

export interface AutomaticBuildExecutorInputChunkV3 {
  version: "automatic_build_executor_input_chunk.v3";
  opaque_session_ref: string;
  generation_input_ref: string;
  segment: "semantic_prompt" | "semantic_input";
  ordinal: number;
  byte_range: { start: number; end: number };
  payload_utf8: string;
  final_for_segment: boolean;
  final_for_generation: boolean;
}

export interface AutomaticBuildExecutorInputBatchV1 {
  version: "automatic_build_executor_input_batch.v1";
  opaque_session_ref: string;
  generation_input_ref: string;
  first_ordinal: number;
  last_ordinal: number;
  final_for_generation: boolean;
  chunks: AutomaticBuildExecutorInputChunkV3[];
}

export interface AutomaticBuildExecutorGenerationGrantV2 {
  version: "automatic_build_executor_generation_grant.v2";
  opaque_session_ref: string;
  generation_input_ref: string;
  generation_grant_ref: string;
  final_delivered_ordinal: number;
  output_schema_version: string;
}

export interface AutomaticBuildExecutorGenerationStartRequestV3 {
  version: "automatic_build_executor_generation_start_request.v3";
  opaque_session_ref: string;
  generation_input_ref: string;
  confirmed_through_ordinal: number;
  now?: string;
}

export type AutomaticBuildExecutorSessionActionV3 =
  | {
      kind: "DELIVER_INPUT";
      input_manifest: AutomaticBuildExecutorInputManifestV3;
      next_request: AutomaticBuildExecutorInputNextRequestV4;
    }
  | { kind: "INPUT_BATCH"; batch: AutomaticBuildExecutorInputBatchV1 }
  | {
      kind: "GENERATE";
      opaque_session_ref: string;
      candidate_sink_ref: string;
      semantic_attempt: number;
      output_contract: AutomaticBuildExecutorOutputContractV3;
    }
  | { kind: "WAIT"; retry_after_ms: number }
  | { kind: "DONE"; status: "committed" | "retryable_failure" | "interrupted" };

export interface AutomaticBuildExecutorSessionResponseV3 {
  version: "automatic_build_executor_session.v3";
  action: AutomaticBuildExecutorSessionActionV3;
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

export interface AutomaticBuildExecutorOpenRequestV3 {
  version: "automatic_build_executor_open_request.v3";
  opaque_handoff_ref: string;
  now?: string;
}

export interface AutomaticBuildExecutorSubmitRequestV1 {
  version: "automatic_build_executor_submit_request.v1";
  opaque_session_ref: string;
  candidate_path: string;
  now?: string;
}

export interface AutomaticBuildExecutorCandidateSubmitV3 {
  version: "automatic_build_executor_candidate_submit.v3";
  opaque_session_ref: string;
  candidate_sink_ref: string;
  candidate: JsonValue;
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

export function resolveAutomaticBuildExecutorRegistryRoot(): string {
  return registryRoot();
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

function validatePrivateOwnerIdentity(value: unknown): AutomaticBuildPrivateArtifactOwnerIdentityV2 {
  if (!isRecord(value)) throw new Error("private artifact owner identity is invalid");
  exactKeys(value, [
    "version",
    "task_id",
    "book_id",
    "source_fingerprint",
    "intent_id",
    "intent_revision",
    "plan_id",
    "plan_revision",
    "artifact_id",
    "artifact_type",
    "blueprint_id",
    "blueprint_version",
    "attempt",
  ]);
  if (value.version !== "automatic_build_private_artifact_owner_identity.v2"
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
    intent_revision: positiveSafeInteger(value.intent_revision, "owner_identity.intent_revision"),
    plan_id: boundedString(value.plan_id, "owner_identity.plan_id", 512),
    plan_revision: positiveSafeInteger(value.plan_revision, "owner_identity.plan_revision"),
    artifact_id: boundedString(value.artifact_id, "owner_identity.artifact_id", 512),
    artifact_type: value.artifact_type as IntentArtifactCompatibilityType,
    blueprint_id: boundedString(value.blueprint_id, "owner_identity.blueprint_id", 512),
    blueprint_version: boundedString(value.blueprint_version, "owner_identity.blueprint_version", 128),
    attempt: positiveSafeInteger(value.attempt, "owner_identity.attempt"),
  };
}

function validateExecutorOwnerIdentity(value: unknown): AutomaticBuildExecutorOwnerIdentityV1 {
  if (isRecord(value) && value.version === "automatic_build_private_artifact_owner_identity.v2") {
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

function opaqueHandoffIdentityV3(input: {
  kind: "public_dispatch";
  target_ref: BuildTargetRefV2;
  target_locator: AutomaticBuildTargetLocatorV1;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  handoff_path: string;
  handoff_sha256: string;
  handoff_byte_length: number;
}): unknown {
  return {
    version: "automatic_build_opaque_handoff_identity.v3",
    session_protocol: "automatic_build_executor_session.v3",
    ...input,
  };
}

function opaqueHandoffRefForV3(input: Parameters<typeof opaqueHandoffIdentityV3>[0]): string {
  return `abhandoff1_${sha256(opaqueHandoffIdentityV3(input))}`;
}

function validateOpaqueHandoffRef(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
    || !OPAQUE_HANDOFF_REF.test(value)) {
    throw new Error("opaque handoff ref is invalid");
  }
  return value;
}

function validateLegacyOpaqueHandoffRecord(
  value: unknown,
  expectedRef: string,
): AutomaticBuildOpaqueHandoffRecordV1 {
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

function validateV3OpaqueHandoffRecord(
  value: unknown,
  expectedRef: string,
): AutomaticBuildOpaqueHandoffRecordV3 {
  if (!isRecord(value)) throw new Error("opaque handoff record is invalid");
  exactKeys(value, [
    "version",
    "session_protocol",
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
  if (value.version !== "automatic_build_opaque_handoff_record.v3"
    || value.session_protocol !== "automatic_build_executor_session.v3"
    || value.opaque_handoff_ref !== expectedRef
    || value.kind !== "public_dispatch"
    || typeof value.handoff_sha256 !== "string" || !SHA256.test(value.handoff_sha256)
    || !Number.isSafeInteger(value.handoff_byte_length) || (value.handoff_byte_length as number) < 1) {
    throw new Error("V3 opaque handoff record identity is invalid");
  }
  const targetRef = validateTargetRef(value.target_ref);
  const locator = validateTargetLocator(value.target_locator);
  const owner = validateOwnerIdentity(value.owner_identity);
  const handoffPath = boundedString(value.handoff_path, "handoff_path");
  if (!path.isAbsolute(handoffPath)) throw new Error("opaque handoff record path must be absolute");
  const record: AutomaticBuildOpaqueHandoffRecordV3 = {
    version: value.version,
    session_protocol: value.session_protocol,
    opaque_handoff_ref: expectedRef,
    kind: value.kind,
    target_ref: targetRef,
    target_locator: locator,
    owner_identity: owner,
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
  if (opaqueHandoffRefForV3(identity) !== expectedRef) {
    throw new Error("V3 opaque handoff record locator is invalid");
  }
  return record;
}

function validateOpaqueHandoffRecord(
  value: unknown,
  expectedRef: string,
): AutomaticBuildOpaqueHandoffRecord {
  return isRecord(value) && value.version === "automatic_build_opaque_handoff_record.v3"
    ? validateV3OpaqueHandoffRecord(value, expectedRef)
    : validateLegacyOpaqueHandoffRecord(value, expectedRef);
}

function readOpaqueHandoffRecord(opaqueHandoffRef: string): AutomaticBuildOpaqueHandoffRecord {
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
  record: AutomaticBuildOpaqueHandoffRecord,
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
): AutomaticBuildPrivateArtifactOwnerIdentityV2 {
  const task = context.task;
  return {
    version: "automatic_build_private_artifact_owner_identity.v2",
    task_id: task.task_id,
    book_id: task.book_id,
    source_fingerprint: task.source_fingerprint,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
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
  if (input.kind === "public_dispatch") {
    const owner = validateOwnerIdentity(input.owner_identity);
    const handoff = validateExecutorHandoffRef(input.executor_handoff);
    const persisted = validateAutomaticBuildDispatchHandoff(resolvedTarget, {
      stage: owner.stage,
      dispatch_id: owner.dispatch_id,
      dispatch_run_id: owner.dispatch_run_id,
      executor_handoff: handoff,
    });
    if (!sameTargetRef(persisted.manifest.target_ref, targetRef)) {
      throw new Error("opaque handoff target does not match the published dispatch");
    }
    const identity = {
      kind: "public_dispatch" as const,
      target_ref: targetRef,
      target_locator: locator,
      owner_identity: owner,
      handoff_path: handoff.path,
      handoff_sha256: handoff.sha256,
      handoff_byte_length: handoff.byte_length,
    };
    const opaqueHandoffRef = opaqueHandoffRefForV3(identity);
    const record: AutomaticBuildOpaqueHandoffRecordV3 = {
      version: "automatic_build_opaque_handoff_record.v3",
      session_protocol: "automatic_build_executor_session.v3",
      opaque_handoff_ref: opaqueHandoffRef,
      ...identity,
      issued_at: issuedAt,
    };
    const file = registryFile("opaque-handoffs", opaqueHandoffRef);
    if (!writeCreateOnly(file, record)) {
      const existing = readOpaqueHandoffRecord(opaqueHandoffRef);
      if (existing.version !== "automatic_build_opaque_handoff_record.v3") {
        throw new Error("opaque handoff ref conflicts with its current session protocol");
      }
      const existingIdentity = opaqueHandoffIdentityV3({
        kind: existing.kind,
        target_ref: existing.target_ref,
        target_locator: existing.target_locator,
        owner_identity: existing.owner_identity,
        handoff_path: existing.handoff_path,
        handoff_sha256: existing.handoff_sha256,
        handoff_byte_length: existing.handoff_byte_length,
      });
      if (canonicalAutomaticBuildJson(existingIdentity) !== canonicalAutomaticBuildJson(
        opaqueHandoffIdentityV3(identity),
      )) {
        throw new Error("opaque handoff ref conflicts with its create-only record");
      }
    }
    return {
      version: "automatic_build_opaque_handoff_ref.v1",
      opaque_handoff_ref: opaqueHandoffRef,
    };
  }

  const context = readIntentArtifactTaskAttemptExecutionContext({
    private_root: input.private_root,
    task_path: input.task_path,
  });
  assertPrivateTaskTarget(resolvedTarget, context);
  const owner = privateOwnerFromContext(context);
  const handoff = privateTaskHandoffRef(context);
  const identity = {
    kind: "private_artifact" as const,
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

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} is invalid`);
  return Number(value);
}

function validateOpaqueSessionRef(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
    || !OPAQUE_SESSION_REF.test(value)) {
    throw new Error("opaque session ref is invalid");
  }
  return value;
}

function validateGenerationInputRef(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
    || !GENERATION_INPUT_REF.test(value)) {
    throw new Error("generation input ref is invalid");
  }
  return value;
}

function validateGenerationGrantRef(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
    || !GENERATION_GRANT_REF.test(value)) {
    throw new Error("generation grant ref is invalid");
  }
  return value;
}

function validateCandidateSinkRef(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
    || !CANDIDATE_SINK_REF.test(value)) {
    throw new Error("candidate sink ref is invalid");
  }
  return value;
}

function privateRootFromTaskPath(
  taskPathInput: string,
  owner: AutomaticBuildPrivateArtifactOwnerIdentityV2,
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
    || path.basename(attemptsDirectory) !== "attempts-v3"
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
  owner: AutomaticBuildPrivateArtifactOwnerIdentityV2;
  attempt: IntentArtifactTaskAttemptExecutionContextV1;
  intent: BuildIntentV3;
  plan: BuildPlanV3;
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
  record: AutomaticBuildOpaqueHandoffRecord,
): AutomaticBuildPrivateArtifactContextV1 {
  if (record.version !== "automatic_build_opaque_handoff_record.v1"
    || record.kind !== "private_artifact") {
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
  const storedPlan = readPrivateSelectionJson(
    attempt.private_root,
    planPath,
    "private BuildPlan",
  );
  const storedIntent = readPrivateSelectionJson(
    attempt.private_root,
    intentPath,
    "private BuildIntent",
  );
  const { intent, plan } = adaptAutomaticBuildPrivateArtifactSelectionV3(
    storedIntent,
    storedPlan,
  );
  if (plan.plan_id !== owner.plan_id
    || plan.plan_revision !== owner.plan_revision
    || plan.intent_id !== owner.intent_id
    || plan.intent_revision !== owner.intent_revision
    || plan.book_id !== owner.book_id
    || plan.source_fingerprint !== owner.source_fingerprint
    || (plan.status !== "confirmed" && plan.status !== "completed")
    || intent.intent_id !== owner.intent_id
    || intent.intent_revision !== owner.intent_revision
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
  owner: AutomaticBuildPrivateArtifactOwnerIdentityV2;
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

interface AutomaticBuildExecutorDeliveryMaterialV3 {
  semantic_prompt: string;
  semantic_input: string;
  output_contract: AutomaticBuildExecutorOutputContractV3;
  manifest: AutomaticBuildExecutorInputManifestV3;
  chunks: AutomaticBuildExecutorInputChunkV3[];
  batches: PackedExecutorTransportBatchV1<AutomaticBuildExecutorInputChunkV3>[];
}

function semanticCandidateContractV2(
  descriptor: WorkUnitDescriptor,
): AutomaticBuildSemanticCandidateContractV2 {
  return {
    version: "automatic_build_semantic_candidate_contract.v2",
    format: "strict_json",
    encoding: "utf-8",
    max_bytes: Math.min(
      MAX_CANDIDATE_BYTES,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes,
    ),
    stage: descriptor.stage,
    work_unit_id: descriptor.work_unit_id,
    work_unit_kind: descriptor.kind,
    input_hash: descriptor.input_hash,
  };
}

function deliverySessionFile(opaqueSessionRef: string): string {
  return registryFile("executor-v3-delivery-sessions", validateOpaqueSessionRef(opaqueSessionRef));
}

function generationInputFile(generationInputRef: string): string {
  return registryFile("executor-v3-generation-inputs", validateGenerationInputRef(generationInputRef));
}

function deliveryReceiptFile(opaqueSessionRef: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("delivery receipt ordinal is invalid");
  }
  return registryFile(
    "executor-v3-delivery-receipts",
    `${validateOpaqueSessionRef(opaqueSessionRef)}-${String(ordinal).padStart(4, "0")}`,
  );
}

function batchOfferFile(
  opaqueSessionRef: string,
  firstOrdinal: number,
  lastOrdinal: number,
): string {
  if (!Number.isSafeInteger(firstOrdinal) || firstOrdinal < 0
    || !Number.isSafeInteger(lastOrdinal) || lastOrdinal < firstOrdinal) {
    throw new Error("delivery batch offer ordinals are invalid");
  }
  return registryFile(
    "executor-v3-delivery-batch-offers",
    `${validateOpaqueSessionRef(opaqueSessionRef)}-${String(firstOrdinal).padStart(4, "0")}-${String(lastOrdinal).padStart(4, "0")}`,
  );
}

function generationGrantFile(opaqueSessionRef: string): string {
  return registryFile("executor-v3-generation-grants", validateOpaqueSessionRef(opaqueSessionRef));
}

function generationStartAcceptanceFile(generationGrantRef: string): string {
  return registryFile(
    "executor-v3-generation-start-acceptances",
    validateGenerationGrantRef(generationGrantRef),
  );
}

function generationStartRecordFile(generationGrantRef: string): string {
  return registryFile(
    "executor-v3-generation-starts",
    validateGenerationGrantRef(generationGrantRef),
  );
}

function candidateSinkRecordFile(opaqueSessionRef: string): string {
  return registryFile(
    "executor-v3-candidate-sinks",
    validateOpaqueSessionRef(opaqueSessionRef),
  );
}

function generationInputRefFor(input: {
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  descriptor_input_hash: string;
  semantic_prompt_sha256: string;
  semantic_input_sha256: string;
  transport_profile: ExecutorTransportProfileV2;
  output_schema_version: string;
}): string {
  return `abinput1_${sha256({
    version: "automatic_build_executor_generation_input_identity.v2",
    ...input,
  })}`;
}

function privateGenerationInputRefFor(input: {
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  owner_identity: AutomaticBuildPrivateArtifactOwnerIdentityV2;
  task_id: string;
  semantic_prompt_sha256: string;
  semantic_input_sha256: string;
  transport_profile: ExecutorTransportProfileV2;
  output_schema_version: string;
}): string {
  return `abinput1_${sha256({
    version: "automatic_build_executor_private_generation_input_identity.v3",
    ...input,
  })}`;
}

function deliverySessionRefFor(input: {
  open_session_ref: string;
  opaque_handoff_ref: string;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  descriptor_input_hash: string;
  transport_profile: ExecutorTransportProfileV2;
}): string {
  return `absession1_${sha256({
    version: "automatic_build_executor_delivery_session_identity.v2",
    ...input,
  })}`;
}

function privateDeliverySessionRefFor(input: {
  open_session_ref: string;
  opaque_handoff_ref: string;
  owner_identity: AutomaticBuildPrivateArtifactOwnerIdentityV2;
  task_id: string;
  transport_profile: ExecutorTransportProfileV2;
}): string {
  return `absession1_${sha256({
    version: "automatic_build_executor_private_delivery_session_identity.v3",
    ...input,
  })}`;
}

function packDeliverySegment(input: {
  opaque_session_ref: string;
  generation_input_ref: string;
  segment: "semantic_prompt" | "semantic_input";
  payload_utf8: string;
  ordinal_offset: number;
}): ExecutorTransportPackWithinLimitV2 {
  const packed = packExecutorTransportPayload({
    profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    payload_utf8: input.payload_utf8,
    envelope_for_chunk: (frame: ExecutorTransportChunkFrameV2): AutomaticBuildExecutorInputChunkV3 => {
      const ordinal = input.ordinal_offset + frame.ordinal;
      const finalForGeneration = input.segment === "semantic_input" && frame.final;
      const chunk: AutomaticBuildExecutorInputChunkV3 = {
        version: "automatic_build_executor_input_chunk.v3",
        opaque_session_ref: input.opaque_session_ref,
        generation_input_ref: input.generation_input_ref,
        segment: input.segment,
        ordinal,
        byte_range: frame.byte_range,
        payload_utf8: frame.payload_utf8,
        final_for_segment: frame.final,
        final_for_generation: finalForGeneration,
      };
      return chunk;
    },
  });
  if (packed.status !== "within_limit") {
    throw new AutomaticBuildExecutorTransportError();
  }
  return validateExecutorTransportPack(
    packed,
    CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    input.payload_utf8,
  );
}

function packedDeliveryMaterial(input: {
  opaque_session_ref: string;
  generation_input_ref: string;
  semantic_prompt: string;
  semantic_input: string;
  output_contract: AutomaticBuildExecutorOutputContractV3;
}): AutomaticBuildExecutorDeliveryMaterialV3 {
  const semanticPromptSha256 = sha256(input.semantic_prompt);
  const semanticInputSha256 = sha256(input.semantic_input);
  const promptPack = packDeliverySegment({
    opaque_session_ref: input.opaque_session_ref,
    generation_input_ref: input.generation_input_ref,
    segment: "semantic_prompt",
    payload_utf8: input.semantic_prompt,
    ordinal_offset: 0,
  });
  const inputPack = packDeliverySegment({
    opaque_session_ref: input.opaque_session_ref,
    generation_input_ref: input.generation_input_ref,
    segment: "semantic_input",
    payload_utf8: input.semantic_input,
    ordinal_offset: promptPack.chunk_count,
  });
  const totalChunkCount = promptPack.chunk_count + inputPack.chunk_count;
  if (totalChunkCount > CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_input_chunks) {
    throw new AutomaticBuildExecutorTransportError();
  }
  const chunks = [...promptPack.chunks, ...inputPack.chunks].map((chunk) => {
    const response = chunk.response;
    if (!isRecord(response)
      || response.version !== "automatic_build_executor_input_chunk.v3") {
      throw new Error("executor input transport produced an invalid chunk envelope");
    }
    return response as unknown as AutomaticBuildExecutorInputChunkV3;
  });
  if (chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal
    || chunk.final_for_generation !== (ordinal === chunks.length - 1))) {
    throw new Error("executor input transport chunk ordering is invalid");
  }
  const batchPack = packExecutorTransportBatches({
    chunks,
    limit: CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1,
    envelope_for_chunks: (batchChunks): AutomaticBuildExecutorSessionResponseV3 => ({
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "INPUT_BATCH",
        batch: {
          version: "automatic_build_executor_input_batch.v1",
          opaque_session_ref: input.opaque_session_ref,
          generation_input_ref: input.generation_input_ref,
          first_ordinal: batchChunks[0].ordinal,
          last_ordinal: batchChunks.at(-1)!.ordinal,
          final_for_generation: batchChunks.at(-1)!.final_for_generation,
          chunks: batchChunks,
        },
      },
    }),
  });
  if (batchPack.status !== "within_limit") {
    throw new AutomaticBuildExecutorTransportError();
  }
  return {
    semantic_prompt: input.semantic_prompt,
    semantic_input: input.semantic_input,
    output_contract: input.output_contract,
    manifest: {
      version: "automatic_build_executor_input_manifest.v3",
      opaque_session_ref: input.opaque_session_ref,
      generation_input_ref: input.generation_input_ref,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      segments: [
        {
          kind: "semantic_prompt",
          byte_length: Buffer.byteLength(input.semantic_prompt, "utf8"),
          sha256: semanticPromptSha256,
          chunk_count: promptPack.chunk_count,
        },
        {
          kind: "semantic_input",
          byte_length: Buffer.byteLength(input.semantic_input, "utf8"),
          sha256: semanticInputSha256,
          chunk_count: inputPack.chunk_count,
        },
      ],
      total_chunk_count: totalChunkCount,
    },
    chunks,
    batches: batchPack.batches,
  };
}

function renderDeliveryMaterial(input: {
  target: AutomaticBuildTarget;
  persisted: AutomaticBuildPersistedDispatchV1;
  semantic_prompt: string;
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  owner: AutomaticBuildDispatchOwnerIdentityV1;
  work_unit_id: string;
  semantic_input?: string;
}): AutomaticBuildExecutorDeliveryMaterialV3 {
  const stage = taskDescriptor(input.target, input.persisted, input.work_unit_id);
  const descriptor = stage.descriptor;
  const binding = stage.task_bindings[input.work_unit_id];
  if (!binding) {
    throw new Error(`executor delivery task is missing policy binding: ${descriptor.stage}/${descriptor.work_unit_id}`);
  }
  const semanticInput = input.semantic_input ?? renderAutomaticBuildTaskInput(
    input.target,
    descriptor.stage,
    descriptor.work_unit_id,
    isAutomaticBuildTaskPolicyBindingV2(binding)
      ? { policy_generation_id: binding.policy_generation_id }
      : {},
  ).stdout;
  const outputContract = semanticCandidateContractV2(descriptor);
  const semanticPromptSha256 = sha256(input.semantic_prompt);
  const semanticInputSha256 = sha256(semanticInput);
  const generationInputRef = generationInputRefFor({
    opaque_session_ref: input.opaque_session_ref,
    opaque_handoff_ref: input.opaque_handoff_ref,
    owner_identity: input.owner,
    stage: descriptor.stage,
    work_unit_id: descriptor.work_unit_id,
    descriptor_input_hash: descriptor.input_hash,
    semantic_prompt_sha256: semanticPromptSha256,
    semantic_input_sha256: semanticInputSha256,
    transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    output_schema_version: outputContract.version,
  });
  return packedDeliveryMaterial({
    opaque_session_ref: input.opaque_session_ref,
    generation_input_ref: generationInputRef,
    semantic_prompt: input.semantic_prompt,
    semantic_input: semanticInput,
    output_contract: outputContract,
  });
}

function deliveryRecordFromMaterial(input: {
  opaque_handoff_ref: string;
  open_record: AutomaticBuildExecutorOpenRecordV1;
  delivery_session_ref: string;
  owner: AutomaticBuildDispatchOwnerIdentityV1;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  material: AutomaticBuildExecutorDeliveryMaterialV3;
  created_at: string;
}): AutomaticBuildExecutorDeliverySessionRecordV3 {
  const [prompt, semanticInput] = input.material.manifest.segments;
  return {
    version: "automatic_build_executor_delivery_session_record.v3",
    opaque_session_ref: input.delivery_session_ref,
    opaque_handoff_ref: input.opaque_handoff_ref,
    open_session_ref: input.open_record.opaque_session_ref,
    owner_identity: input.owner,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    generation_input_ref: input.material.manifest.generation_input_ref,
    transport_profile: input.material.manifest.transport_profile,
    semantic_prompt_sha256: prompt.sha256,
    semantic_prompt_byte_length: prompt.byte_length,
    semantic_input_sha256: semanticInput.sha256,
    semantic_input_byte_length: semanticInput.byte_length,
    semantic_prompt_chunk_count: prompt.chunk_count,
    semantic_input_chunk_count: semanticInput.chunk_count,
    total_chunk_count: input.material.manifest.total_chunk_count,
    output_schema_version: input.material.output_contract.version,
    created_at: input.created_at,
  };
}

function privateArtifactCandidateContractV2(
  task: IntentArtifactTaskEnvelopeV3,
): AutomaticBuildPrivateArtifactCandidateContractV2 {
  return {
    version: "automatic_build_private_artifact_candidate_contract.v2",
    format: "strict_json",
    encoding: "utf-8",
    max_bytes: Math.min(
      MAX_CANDIDATE_BYTES,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes,
    ),
    candidate_version: "intent_artifact_candidate.v3",
    task_id: task.task_id,
    artifact_id: task.artifact.artifact_id,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
    artifact_instance: task.output_contract,
  };
}

function renderPrivateDeliveryMaterial(input: {
  context: AutomaticBuildPrivateArtifactContextV1;
  opaque_session_ref: string;
  opaque_handoff_ref: string;
  semantic_input?: string;
}): AutomaticBuildExecutorDeliveryMaterialV3 {
  const semanticPrompt = [
    "Generate exactly one reader-private intent_artifact_candidate.v3.",
    "Use the task goal, frozen Blueprint, validation rules, and allowed evidence LIDs.",
    "Return strict JSON only; do not include the candidate in the executor final message.",
  ].join("\n");
  const semanticInput = input.semantic_input
    ?? canonicalAutomaticBuildJson(input.context.attempt.task);
  const outputContract = privateArtifactCandidateContractV2(input.context.attempt.task);
  const generationInputRef = privateGenerationInputRefFor({
    opaque_session_ref: input.opaque_session_ref,
    opaque_handoff_ref: input.opaque_handoff_ref,
    owner_identity: input.context.owner,
    task_id: input.context.attempt.task.task_id,
    semantic_prompt_sha256: sha256(semanticPrompt),
    semantic_input_sha256: sha256(semanticInput),
    transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    output_schema_version: outputContract.version,
  });
  return packedDeliveryMaterial({
    opaque_session_ref: input.opaque_session_ref,
    generation_input_ref: generationInputRef,
    semantic_prompt: semanticPrompt,
    semantic_input: semanticInput,
    output_contract: outputContract,
  });
}

function privateDeliveryRecordFromMaterial(input: {
  opaque_handoff_ref: string;
  open_record: AutomaticBuildExecutorOpenRecordV1;
  delivery_session_ref: string;
  context: AutomaticBuildPrivateArtifactContextV1;
  material: AutomaticBuildExecutorDeliveryMaterialV3;
  created_at: string;
}): AutomaticBuildExecutorPrivateDeliverySessionRecordV3 {
  const [prompt, semanticInput] = input.material.manifest.segments;
  return {
    version: "automatic_build_executor_private_delivery_session_record.v3",
    opaque_session_ref: input.delivery_session_ref,
    opaque_handoff_ref: input.opaque_handoff_ref,
    open_session_ref: input.open_record.opaque_session_ref,
    owner_identity: input.context.owner,
    task_id: input.context.attempt.task.task_id,
    generation_input_ref: input.material.manifest.generation_input_ref,
    transport_profile: input.material.manifest.transport_profile,
    semantic_prompt_sha256: prompt.sha256,
    semantic_prompt_byte_length: prompt.byte_length,
    semantic_input_sha256: semanticInput.sha256,
    semantic_input_byte_length: semanticInput.byte_length,
    semantic_prompt_chunk_count: prompt.chunk_count,
    semantic_input_chunk_count: semanticInput.chunk_count,
    total_chunk_count: input.material.manifest.total_chunk_count,
    output_schema_version: input.material.output_contract.version,
    created_at: input.created_at,
  };
}

function validatePrivateDeliverySessionRecord(
  value: Record<string, unknown>,
  expectedSessionRef: string,
): AutomaticBuildExecutorPrivateDeliverySessionRecordV3 {
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "opaque_handoff_ref",
    "open_session_ref",
    "owner_identity",
    "task_id",
    "generation_input_ref",
    "transport_profile",
    "semantic_prompt_sha256",
    "semantic_prompt_byte_length",
    "semantic_input_sha256",
    "semantic_input_byte_length",
    "semantic_prompt_chunk_count",
    "semantic_input_chunk_count",
    "total_chunk_count",
    "output_schema_version",
    "created_at",
  ]);
  if (value.version !== "automatic_build_executor_private_delivery_session_record.v3"
    || value.opaque_session_ref !== expectedSessionRef
    || typeof value.semantic_prompt_sha256 !== "string" || !SHA256.test(value.semantic_prompt_sha256)
    || typeof value.semantic_input_sha256 !== "string" || !SHA256.test(value.semantic_input_sha256)
    || typeof value.output_schema_version !== "string") {
    throw new Error("executor private delivery session record identity is invalid");
  }
  const transportProfile = validateExecutorTransportProfile(
    value.transport_profile as ExecutorTransportProfileV2,
  );
  if (canonicalAutomaticBuildJson(transportProfile)
    !== canonicalAutomaticBuildJson(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2)) {
    throw new Error("executor private delivery session transport profile changed");
  }
  const owner = validatePrivateOwnerIdentity(value.owner_identity);
  const record: AutomaticBuildExecutorPrivateDeliverySessionRecordV3 = {
    version: value.version,
    opaque_session_ref: expectedSessionRef,
    opaque_handoff_ref: validateOpaqueHandoffRef(value.opaque_handoff_ref),
    open_session_ref: validateOpaqueSessionRef(value.open_session_ref),
    owner_identity: owner,
    task_id: boundedString(value.task_id, "task_id", 512),
    generation_input_ref: validateGenerationInputRef(value.generation_input_ref),
    transport_profile: transportProfile,
    semantic_prompt_sha256: value.semantic_prompt_sha256,
    semantic_prompt_byte_length: positiveSafeInteger(
      value.semantic_prompt_byte_length,
      "semantic_prompt_byte_length",
    ),
    semantic_input_sha256: value.semantic_input_sha256,
    semantic_input_byte_length: positiveSafeInteger(
      value.semantic_input_byte_length,
      "semantic_input_byte_length",
    ),
    semantic_prompt_chunk_count: positiveSafeInteger(
      value.semantic_prompt_chunk_count,
      "semantic_prompt_chunk_count",
    ),
    semantic_input_chunk_count: positiveSafeInteger(
      value.semantic_input_chunk_count,
      "semantic_input_chunk_count",
    ),
    total_chunk_count: positiveSafeInteger(value.total_chunk_count, "total_chunk_count"),
    output_schema_version: boundedString(
      value.output_schema_version,
      "output_schema_version",
      256,
    ),
    created_at: isoTimestamp(value.created_at, "created_at"),
  };
  if (record.owner_identity.task_id !== record.task_id
    || record.semantic_prompt_chunk_count + record.semantic_input_chunk_count
      !== record.total_chunk_count
    || record.total_chunk_count > CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_input_chunks) {
    throw new Error("executor private delivery session record counts are invalid");
  }
  return record;
}

function validateDeliverySessionRecord(
  value: unknown,
  expectedSessionRef: string,
): AutomaticBuildExecutorAnyDeliverySessionRecordV3 {
  if (!isRecord(value)) throw new Error("executor delivery session record is invalid");
  if (value.version === "automatic_build_executor_private_delivery_session_record.v3") {
    return validatePrivateDeliverySessionRecord(value, expectedSessionRef);
  }
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "opaque_handoff_ref",
    "open_session_ref",
    "owner_identity",
    "stage",
    "work_unit_id",
    "generation_input_ref",
    "transport_profile",
    "semantic_prompt_sha256",
    "semantic_prompt_byte_length",
    "semantic_input_sha256",
    "semantic_input_byte_length",
    "semantic_prompt_chunk_count",
    "semantic_input_chunk_count",
    "total_chunk_count",
    "output_schema_version",
    "created_at",
  ]);
  if (value.version !== "automatic_build_executor_delivery_session_record.v3"
    || value.opaque_session_ref !== expectedSessionRef
    || typeof value.stage !== "string" || !STAGES.has(value.stage as AutomaticBuildStage)
    || typeof value.semantic_prompt_sha256 !== "string" || !SHA256.test(value.semantic_prompt_sha256)
    || typeof value.semantic_input_sha256 !== "string" || !SHA256.test(value.semantic_input_sha256)
    || typeof value.output_schema_version !== "string") {
    throw new Error("executor delivery session record identity is invalid");
  }
  const transportProfile = validateExecutorTransportProfile(
    value.transport_profile as ExecutorTransportProfileV2,
  );
  if (canonicalAutomaticBuildJson(transportProfile)
    !== canonicalAutomaticBuildJson(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2)) {
    throw new Error("executor delivery session transport profile changed");
  }
  const record: AutomaticBuildExecutorDeliverySessionRecordV3 = {
    version: value.version,
    opaque_session_ref: expectedSessionRef,
    opaque_handoff_ref: validateOpaqueHandoffRef(value.opaque_handoff_ref),
    open_session_ref: validateOpaqueSessionRef(value.open_session_ref),
    owner_identity: validateOwnerIdentity(value.owner_identity),
    stage: value.stage as AutomaticBuildStage,
    work_unit_id: boundedString(value.work_unit_id, "work_unit_id", 512),
    generation_input_ref: validateGenerationInputRef(value.generation_input_ref),
    transport_profile: transportProfile,
    semantic_prompt_sha256: value.semantic_prompt_sha256,
    semantic_prompt_byte_length: positiveSafeInteger(
      value.semantic_prompt_byte_length,
      "semantic_prompt_byte_length",
    ),
    semantic_input_sha256: value.semantic_input_sha256,
    semantic_input_byte_length: positiveSafeInteger(
      value.semantic_input_byte_length,
      "semantic_input_byte_length",
    ),
    semantic_prompt_chunk_count: positiveSafeInteger(
      value.semantic_prompt_chunk_count,
      "semantic_prompt_chunk_count",
    ),
    semantic_input_chunk_count: positiveSafeInteger(
      value.semantic_input_chunk_count,
      "semantic_input_chunk_count",
    ),
    total_chunk_count: positiveSafeInteger(value.total_chunk_count, "total_chunk_count"),
    output_schema_version: boundedString(
      value.output_schema_version,
      "output_schema_version",
      256,
    ),
    created_at: isoTimestamp(value.created_at, "created_at"),
  };
  if (record.owner_identity.stage !== record.stage
    || record.semantic_prompt_chunk_count + record.semantic_input_chunk_count
      !== record.total_chunk_count
    || record.total_chunk_count > CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_input_chunks) {
    throw new Error("executor delivery session record counts are invalid");
  }
  return record;
}

function readDeliverySessionRecord(
  opaqueSessionRef: string,
): AutomaticBuildExecutorAnyDeliverySessionRecordV3 {
  const file = deliverySessionFile(opaqueSessionRef);
  if (!existsSync(file)) throw new Error("executor delivery session does not exist");
  return validateDeliverySessionRecord(decodeJsonRecord(file), opaqueSessionRef);
}

function assertDeliveryMaterialMatches(
  record: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  material: AutomaticBuildExecutorDeliveryMaterialV3,
): void {
  const [prompt, semanticInput] = material.manifest.segments;
  if (material.manifest.opaque_session_ref !== record.opaque_session_ref
    || material.manifest.generation_input_ref !== record.generation_input_ref
    || canonicalAutomaticBuildJson(material.manifest.transport_profile)
      !== canonicalAutomaticBuildJson(record.transport_profile)
    || prompt.sha256 !== record.semantic_prompt_sha256
    || prompt.byte_length !== record.semantic_prompt_byte_length
    || prompt.chunk_count !== record.semantic_prompt_chunk_count
    || semanticInput.sha256 !== record.semantic_input_sha256
    || semanticInput.byte_length !== record.semantic_input_byte_length
    || semanticInput.chunk_count !== record.semantic_input_chunk_count
    || material.manifest.total_chunk_count !== record.total_chunk_count
    || material.output_contract.version !== record.output_schema_version) {
    throw new Error("executor delivery input identity drifted");
  }
}

function persistDeliverySessionRecord(
  record: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
): AutomaticBuildExecutorAnyDeliverySessionRecordV3 {
  const file = deliverySessionFile(record.opaque_session_ref);
  if (writeCreateOnly(file, record)) return record;
  const existing = validateDeliverySessionRecord(decodeJsonRecord(file), record.opaque_session_ref);
  const { created_at: _existingCreatedAt, ...existingIdentity } = existing;
  const { created_at: _recordCreatedAt, ...recordIdentity } = record;
  if (canonicalAutomaticBuildJson(existingIdentity) !== canonicalAutomaticBuildJson(recordIdentity)) {
    throw new Error("executor delivery session conflicts with its create-only identity");
  }
  return existing;
}

function validateGenerationInputRecord(
  value: unknown,
  expectedGenerationInputRef: string,
): AutomaticBuildExecutorGenerationInputRecordV1 {
  if (!isRecord(value)) throw new Error("executor generation input record is invalid");
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "generation_input_ref",
    "semantic_prompt",
    "semantic_input",
    "semantic_prompt_sha256",
    "semantic_input_sha256",
    "created_at",
  ]);
  if (value.version !== "automatic_build_executor_generation_input_record.v1"
    || value.generation_input_ref !== expectedGenerationInputRef
    || typeof value.semantic_prompt_sha256 !== "string" || !SHA256.test(value.semantic_prompt_sha256)
    || typeof value.semantic_input_sha256 !== "string" || !SHA256.test(value.semantic_input_sha256)) {
    throw new Error("executor generation input record identity is invalid");
  }
  const record: AutomaticBuildExecutorGenerationInputRecordV1 = {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    generation_input_ref: validateGenerationInputRef(value.generation_input_ref),
    semantic_prompt: boundedString(value.semantic_prompt, "semantic_prompt", MAX_RECORD_BYTES),
    semantic_input: boundedString(value.semantic_input, "semantic_input", MAX_RECORD_BYTES),
    semantic_prompt_sha256: value.semantic_prompt_sha256,
    semantic_input_sha256: value.semantic_input_sha256,
    created_at: isoTimestamp(value.created_at, "created_at"),
  };
  if (sha256(record.semantic_prompt) !== record.semantic_prompt_sha256
    || sha256(record.semantic_input) !== record.semantic_input_sha256) {
    throw new Error("executor generation input record body digest is invalid");
  }
  return record;
}

function persistGenerationInputRecord(
  material: AutomaticBuildExecutorDeliveryMaterialV3,
  createdAt: string,
): AutomaticBuildExecutorGenerationInputRecordV1 {
  const record: AutomaticBuildExecutorGenerationInputRecordV1 = {
    version: "automatic_build_executor_generation_input_record.v1",
    opaque_session_ref: material.manifest.opaque_session_ref,
    generation_input_ref: material.manifest.generation_input_ref,
    semantic_prompt: material.semantic_prompt,
    semantic_input: material.semantic_input,
    semantic_prompt_sha256: material.manifest.segments[0].sha256,
    semantic_input_sha256: material.manifest.segments[1].sha256,
    created_at: createdAt,
  };
  const file = generationInputFile(record.generation_input_ref);
  if (writeCreateOnly(file, record)) return record;
  const existing = validateGenerationInputRecord(
    decodeJsonRecord(file),
    record.generation_input_ref,
  );
  const { created_at: _existingCreatedAt, ...existingIdentity } = existing;
  const { created_at: _recordCreatedAt, ...recordIdentity } = record;
  if (canonicalAutomaticBuildJson(existingIdentity) !== canonicalAutomaticBuildJson(recordIdentity)) {
    throw new Error("executor generation input conflicts with its create-only identity");
  }
  return existing;
}

function readGenerationInputRecord(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
): AutomaticBuildExecutorGenerationInputRecordV1 {
  const file = generationInputFile(delivery.generation_input_ref);
  if (!existsSync(file)) throw new Error("executor generation input record is missing");
  const record = validateGenerationInputRecord(
    decodeJsonRecord(file),
    delivery.generation_input_ref,
  );
  if (record.opaque_session_ref !== delivery.opaque_session_ref
    || record.semantic_prompt_sha256 !== delivery.semantic_prompt_sha256
    || record.semantic_input_sha256 !== delivery.semantic_input_sha256
    || Buffer.byteLength(record.semantic_prompt, "utf8") !== delivery.semantic_prompt_byte_length
    || Buffer.byteLength(record.semantic_input, "utf8") !== delivery.semantic_input_byte_length) {
    throw new Error("executor generation input record does not match its delivery session");
  }
  return record;
}

function materialFromFrozenGenerationInput(input: {
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3;
  expected_semantic_prompt?: string;
  expected_semantic_input?: string;
  build_material: (
    generationInput: AutomaticBuildExecutorGenerationInputRecordV1,
  ) => AutomaticBuildExecutorDeliveryMaterialV3;
}): AutomaticBuildExecutorDeliveryMaterialV3 {
  const generationInput = readGenerationInputRecord(input.delivery);
  if (input.expected_semantic_prompt !== undefined
    && generationInput.semantic_prompt !== input.expected_semantic_prompt) {
    throw new Error("executor delivery semantic prompt changed after input freeze");
  }
  if (input.expected_semantic_input !== undefined
    && generationInput.semantic_input !== input.expected_semantic_input) {
    throw new Error("executor private frozen task, Blueprint, or output contract changed after input freeze");
  }
  const material = input.build_material(generationInput);
  assertDeliveryMaterialMatches(input.delivery, material);
  return material;
}

function validateDeliveryReceiptRecord(
  value: unknown,
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  chunk: AutomaticBuildExecutorInputChunkV3,
): AutomaticBuildExecutorDeliveryReceiptRecordV2 {
  if (!isRecord(value)) throw new Error("executor delivery receipt record is invalid");
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "generation_input_ref",
    "ordinal",
    "confirmed_at",
  ]);
  if (value.version !== "automatic_build_executor_delivery_receipt_record.v2"
    || value.opaque_session_ref !== delivery.opaque_session_ref
    || value.generation_input_ref !== delivery.generation_input_ref
    || value.ordinal !== chunk.ordinal) {
    throw new Error("executor delivery receipt record identity is invalid");
  }
  return {
    version: value.version,
    opaque_session_ref: delivery.opaque_session_ref,
    generation_input_ref: delivery.generation_input_ref,
    ordinal: chunk.ordinal,
    confirmed_at: isoTimestamp(value.confirmed_at, "confirmed_at"),
  };
}

function confirmedDeliveryReceipts(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  material: AutomaticBuildExecutorDeliveryMaterialV3,
): AutomaticBuildExecutorDeliveryReceiptRecordV2[] {
  const receipts: AutomaticBuildExecutorDeliveryReceiptRecordV2[] = [];
  let missingSeen = false;
  for (const chunk of material.chunks) {
    const file = deliveryReceiptFile(delivery.opaque_session_ref, chunk.ordinal);
    if (!existsSync(file)) {
      missingSeen = true;
      continue;
    }
    if (missingSeen) throw new Error("executor delivery receipt ledger is not contiguous");
    receipts.push(validateDeliveryReceiptRecord(decodeJsonRecord(file), delivery, chunk));
  }
  return receipts;
}

function confirmDeliveryChunk(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  chunk: AutomaticBuildExecutorInputChunkV3,
  confirmedAt: string,
): AutomaticBuildExecutorDeliveryReceiptRecordV2 {
  const record: AutomaticBuildExecutorDeliveryReceiptRecordV2 = {
    version: "automatic_build_executor_delivery_receipt_record.v2",
    opaque_session_ref: delivery.opaque_session_ref,
    generation_input_ref: delivery.generation_input_ref,
    ordinal: chunk.ordinal,
    confirmed_at: confirmedAt,
  };
  const file = deliveryReceiptFile(delivery.opaque_session_ref, chunk.ordinal);
  if (writeCreateOnly(file, record)) return record;
  return validateDeliveryReceiptRecord(decodeJsonRecord(file), delivery, chunk);
}

function inputBatchFromPacked(
  batch: PackedExecutorTransportBatchV1<AutomaticBuildExecutorInputChunkV3>,
): AutomaticBuildExecutorInputBatchV1 {
  const first = batch.chunks[0];
  const last = batch.chunks.at(-1);
  if (!first || !last
    || first.ordinal !== batch.first_ordinal
    || last.ordinal !== batch.last_ordinal) {
    throw new Error("executor input batch ordering is invalid");
  }
  return {
    version: "automatic_build_executor_input_batch.v1",
    opaque_session_ref: first.opaque_session_ref,
    generation_input_ref: first.generation_input_ref,
    first_ordinal: first.ordinal,
    last_ordinal: last.ordinal,
    final_for_generation: last.final_for_generation,
    chunks: batch.chunks,
  };
}

function offerDeliveryBatch(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  batch: PackedExecutorTransportBatchV1<AutomaticBuildExecutorInputChunkV3>,
  offeredAt: string,
): AutomaticBuildExecutorBatchOfferRecordV1 {
  const inputBatch = inputBatchFromPacked(batch);
  if (inputBatch.opaque_session_ref !== delivery.opaque_session_ref
    || inputBatch.generation_input_ref !== delivery.generation_input_ref) {
    throw new Error("executor input batch does not match its delivery session");
  }
  const proposed: AutomaticBuildExecutorBatchOfferRecordV1 = {
    version: "automatic_build_executor_batch_offer_record.v1",
    opaque_session_ref: delivery.opaque_session_ref,
    generation_input_ref: delivery.generation_input_ref,
    first_ordinal: inputBatch.first_ordinal,
    last_ordinal: inputBatch.last_ordinal,
    offered_at: offeredAt,
  };
  const file = batchOfferFile(
    delivery.opaque_session_ref,
    inputBatch.first_ordinal,
    inputBatch.last_ordinal,
  );
  if (writeCreateOnly(file, proposed)) return proposed;
  const existing = decodeJsonRecord(file);
  if (!isRecord(existing)) throw new Error("executor input batch offer is invalid");
  exactKeys(existing, [
    "version",
    "opaque_session_ref",
    "generation_input_ref",
    "first_ordinal",
    "last_ordinal",
    "offered_at",
  ]);
  if (existing.version !== proposed.version
    || existing.opaque_session_ref !== proposed.opaque_session_ref
    || existing.generation_input_ref !== proposed.generation_input_ref
    || existing.first_ordinal !== proposed.first_ordinal
    || existing.last_ordinal !== proposed.last_ordinal) {
    throw new Error("executor input batch offer conflicts with its delivery session");
  }
  return {
    ...proposed,
    offered_at: isoTimestamp(existing.offered_at, "offered_at"),
  };
}

function requireDeliveryBatchOffer(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  batch: PackedExecutorTransportBatchV1<AutomaticBuildExecutorInputChunkV3>,
): void {
  const file = batchOfferFile(delivery.opaque_session_ref, batch.first_ordinal, batch.last_ordinal);
  if (!existsSync(file)) throw new Error("executor generation.start requires the final batch delivery");
  offerDeliveryBatch(delivery, batch, new Date(0).toISOString());
}

function confirmDeliveryBatch(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  batch: PackedExecutorTransportBatchV1<AutomaticBuildExecutorInputChunkV3>,
  confirmedAt: string,
): void {
  for (const chunk of batch.chunks) confirmDeliveryChunk(delivery, chunk, confirmedAt);
}

function inputBatchResponse(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  batch: PackedExecutorTransportBatchV1<AutomaticBuildExecutorInputChunkV3>,
  offeredAt: string,
): AutomaticBuildExecutorSessionResponseV3 {
  offerDeliveryBatch(delivery, batch, offeredAt);
  return boundedV3Response({
    version: "automatic_build_executor_session.v3",
    action: { kind: "INPUT_BATCH", batch: inputBatchFromPacked(batch) },
  });
}

function validateGenerationGrantRecord(
  value: unknown,
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  material: AutomaticBuildExecutorDeliveryMaterialV3,
): AutomaticBuildExecutorGenerationGrantRecordV2 {
  const finalChunk = material.chunks.at(-1);
  if (!finalChunk) throw new Error("executor generation grant is missing its final chunk");
  if (!isRecord(value)) throw new Error("executor generation grant record is invalid");
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "generation_input_ref",
    "generation_grant_ref",
    "final_delivered_ordinal",
    "output_schema_version",
    "issued_at",
  ]);
  if (value.version !== "automatic_build_executor_generation_grant_record.v2"
    || value.opaque_session_ref !== delivery.opaque_session_ref
    || value.generation_input_ref !== delivery.generation_input_ref
    || value.final_delivered_ordinal !== finalChunk.ordinal
    || value.output_schema_version !== delivery.output_schema_version) {
    throw new Error("executor generation grant record identity is invalid");
  }
  const record: AutomaticBuildExecutorGenerationGrantRecordV2 = {
    version: value.version,
    opaque_session_ref: delivery.opaque_session_ref,
    generation_input_ref: delivery.generation_input_ref,
    generation_grant_ref: validateGenerationGrantRef(value.generation_grant_ref),
    final_delivered_ordinal: nonNegativeSafeInteger(
      value.final_delivered_ordinal,
      "final_delivered_ordinal",
    ),
    output_schema_version: boundedString(
      value.output_schema_version,
      "output_schema_version",
      256,
    ),
    issued_at: isoTimestamp(value.issued_at, "issued_at"),
  };
  const expectedRef = `abgrant1_${sha256({
    version: "automatic_build_executor_generation_grant_identity.v2",
    opaque_session_ref: record.opaque_session_ref,
    generation_input_ref: record.generation_input_ref,
    final_delivered_ordinal: record.final_delivered_ordinal,
    output_schema_version: record.output_schema_version,
  })}`;
  if (record.generation_grant_ref !== expectedRef) {
    throw new Error("executor generation grant ref does not match its direct identity");
  }
  return record;
}

function issueGenerationGrant(
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  material: AutomaticBuildExecutorDeliveryMaterialV3,
  issuedAt: string,
): AutomaticBuildExecutorGenerationGrantRecordV2 {
  const finalChunk = material.chunks.at(-1);
  if (!finalChunk || !finalChunk.final_for_generation) {
    throw new Error("executor delivery is missing its final generation chunk");
  }
  const receipts = confirmedDeliveryReceipts(delivery, material);
  if (receipts.length !== material.chunks.length
    || receipts.at(-1)?.ordinal !== finalChunk.ordinal) {
    throw new Error("executor generation grant requires complete ordinal delivery");
  }
  const generationGrantRef = `abgrant1_${sha256({
    version: "automatic_build_executor_generation_grant_identity.v2",
    opaque_session_ref: delivery.opaque_session_ref,
    generation_input_ref: delivery.generation_input_ref,
    final_delivered_ordinal: finalChunk.ordinal,
    output_schema_version: delivery.output_schema_version,
  })}`;
  const record: AutomaticBuildExecutorGenerationGrantRecordV2 = {
    version: "automatic_build_executor_generation_grant_record.v2",
    opaque_session_ref: delivery.opaque_session_ref,
    generation_input_ref: delivery.generation_input_ref,
    generation_grant_ref: generationGrantRef,
    final_delivered_ordinal: finalChunk.ordinal,
    output_schema_version: delivery.output_schema_version,
    issued_at: issuedAt,
  };
  const file = generationGrantFile(delivery.opaque_session_ref);
  if (writeCreateOnly(file, record)) return record;
  return validateGenerationGrantRecord(decodeJsonRecord(file), delivery, material);
}

function boundedV3Response(
  response: AutomaticBuildExecutorSessionResponseV3,
  payloadUtf8 = "",
): AutomaticBuildExecutorSessionResponseV3 {
  if (response.action.kind === "INPUT_BATCH") {
    const serializedBytes = Buffer.byteLength(serializeExecutorMcpToolResult(response), "utf8");
    if (serializedBytes > CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1.max_serialized_batch_bytes) {
      throw new Error("executor V3 input batch exceeds its delivery batch limit");
    }
    return response;
  }
  const measured = measureExecutorTransportResponse(
    response,
    payloadUtf8,
    CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  );
  if (measured.status !== "within_limit") {
    throw new Error(`executor V3 response exceeds its transport profile: ${measured.blocking_reasons.join(",")}`);
  }
  return response;
}

function v3DoneResponse(
  status: Extract<AutomaticBuildExecutorSessionActionV3, { kind: "DONE" }>["status"],
): AutomaticBuildExecutorSessionResponseV3 {
  return boundedV3Response({
    version: "automatic_build_executor_session.v3",
    action: { kind: "DONE", status },
  });
}

function candidateSinkRefFor(input: Omit<
  AutomaticBuildExecutorCandidateSinkRecordV2,
  "version" | "candidate_sink_ref" | "created_at"
>): string {
  return `absink1_${sha256({
    version: "automatic_build_executor_candidate_sink_identity.v2",
    ...input,
  })}`;
}

function validateCandidateSinkRecord(
  value: unknown,
  expected?: {
    task_session: AutomaticBuildExecutorTaskSessionRecordV1;
    delivery: AutomaticBuildExecutorDeliverySessionRecordV3;
    grant: AutomaticBuildExecutorGenerationGrantRecordV2;
    output_contract: AutomaticBuildSemanticCandidateContractV2;
  },
): AutomaticBuildExecutorCandidateSinkRecordV2 {
  if (!isRecord(value)) throw new Error("executor candidate sink record is invalid");
  exactKeys(value, [
    "version",
    "candidate_sink_ref",
    "opaque_session_ref",
    "opaque_handoff_ref",
    "delivery_session_ref",
    "generation_input_ref",
    "generation_grant_ref",
    "owner_identity",
    "stage",
    "work_unit_id",
    "physical_attempt",
    "semantic_attempt",
    "lease_epoch",
    "output_schema_version",
    "created_at",
  ]);
  const owner = validateOwnerIdentity(value.owner_identity);
  if (value.version !== "automatic_build_executor_candidate_sink_record.v2"
    || owner.version !== "automatic_build_dispatch_owner_identity.v1"
    || typeof value.stage !== "string" || !STAGES.has(value.stage as AutomaticBuildStage)
    || typeof value.work_unit_id !== "string" || !value.work_unit_id) {
    throw new Error("executor candidate sink record identity is invalid");
  }
  const unsigned = {
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    opaque_handoff_ref: validateOpaqueHandoffRef(value.opaque_handoff_ref),
    delivery_session_ref: validateOpaqueSessionRef(value.delivery_session_ref),
    generation_input_ref: validateGenerationInputRef(value.generation_input_ref),
    generation_grant_ref: validateGenerationGrantRef(value.generation_grant_ref),
    owner_identity: owner,
    stage: value.stage as AutomaticBuildStage,
    work_unit_id: boundedString(value.work_unit_id, "work_unit_id", 512),
    physical_attempt: positiveSafeInteger(value.physical_attempt, "physical_attempt"),
    semantic_attempt: positiveSafeInteger(value.semantic_attempt, "semantic_attempt"),
    lease_epoch: positiveSafeInteger(value.lease_epoch, "lease_epoch"),
    output_schema_version: boundedString(
      value.output_schema_version,
      "output_schema_version",
      256,
    ),
  };
  const record: AutomaticBuildExecutorCandidateSinkRecordV2 = {
    version: value.version,
    candidate_sink_ref: validateCandidateSinkRef(value.candidate_sink_ref),
    ...unsigned,
    created_at: isoTimestamp(value.created_at, "created_at"),
  };
  if (record.candidate_sink_ref !== candidateSinkRefFor(unsigned)) {
    throw new Error("executor candidate sink ref does not match its identity");
  }
  if (expected) {
    const task = expected.task_session;
    const delivery = expected.delivery;
    const grant = expected.grant;
    if (record.opaque_session_ref !== task.opaque_session_ref
      || record.opaque_handoff_ref !== task.opaque_handoff_ref
      || record.delivery_session_ref !== delivery.opaque_session_ref
      || record.generation_input_ref !== delivery.generation_input_ref
      || record.generation_grant_ref !== grant.generation_grant_ref
      || canonicalAutomaticBuildJson(record.owner_identity)
        !== canonicalAutomaticBuildJson(task.owner_identity)
      || record.stage !== task.stage
      || record.work_unit_id !== task.work_unit_id
      || record.physical_attempt !== task.physical_attempt
      || record.semantic_attempt !== task.semantic_attempt
      || record.lease_epoch !== task.lease_epoch
      || record.output_schema_version !== expected.output_contract.version
      || record.output_schema_version !== grant.output_schema_version
      || record.output_schema_version !== delivery.output_schema_version) {
      throw new Error("executor candidate sink binding changed");
    }
  }
  return record;
}

function issueCandidateSink(input: {
  task_session: AutomaticBuildExecutorTaskSessionRecordV1;
  delivery: AutomaticBuildExecutorDeliverySessionRecordV3;
  grant: AutomaticBuildExecutorGenerationGrantRecordV2;
  output_contract: AutomaticBuildSemanticCandidateContractV2;
  created_at: string;
}): AutomaticBuildExecutorCandidateSinkRecordV2 {
  const task = input.task_session;
  const unsigned = {
    opaque_session_ref: task.opaque_session_ref,
    opaque_handoff_ref: task.opaque_handoff_ref,
    delivery_session_ref: input.delivery.opaque_session_ref,
    generation_input_ref: input.delivery.generation_input_ref,
    generation_grant_ref: input.grant.generation_grant_ref,
    owner_identity: task.owner_identity,
    stage: task.stage,
    work_unit_id: task.work_unit_id,
    physical_attempt: task.physical_attempt,
    semantic_attempt: task.semantic_attempt,
    lease_epoch: task.lease_epoch,
    output_schema_version: input.output_contract.version,
  };
  const proposed: AutomaticBuildExecutorCandidateSinkRecordV2 = {
    version: "automatic_build_executor_candidate_sink_record.v2",
    candidate_sink_ref: candidateSinkRefFor(unsigned),
    ...unsigned,
    created_at: input.created_at,
  };
  const file = candidateSinkRecordFile(task.opaque_session_ref);
  if (writeCreateOnly(file, proposed)) return proposed;
  return validateCandidateSinkRecord(decodeJsonRecord(file), input);
}

function privateCandidateSinkRefFor(input: Omit<
  AutomaticBuildExecutorPrivateCandidateSinkRecordV3,
  "version" | "candidate_sink_ref" | "created_at"
>): string {
  return `absink1_${sha256({
    version: "automatic_build_executor_private_candidate_sink_identity.v3",
    ...input,
  })}`;
}

function validatePrivateCandidateSinkRecord(
  value: unknown,
  expected?: {
    private_session: AutomaticBuildExecutorPrivateSessionRecordV1;
    delivery: AutomaticBuildExecutorPrivateDeliverySessionRecordV3;
    grant: AutomaticBuildExecutorGenerationGrantRecordV2;
    output_contract: AutomaticBuildPrivateArtifactCandidateContractV2;
  },
): AutomaticBuildExecutorPrivateCandidateSinkRecordV3 {
  if (!isRecord(value)) throw new Error("executor private candidate sink record is invalid");
  exactKeys(value, [
    "version",
    "candidate_sink_ref",
    "opaque_session_ref",
    "opaque_handoff_ref",
    "delivery_session_ref",
    "generation_input_ref",
    "generation_grant_ref",
    "owner_identity",
    "task_id",
    "attempt",
    "output_schema_version",
    "created_at",
  ]);
  if (value.version !== "automatic_build_executor_private_candidate_sink_record.v3") {
    throw new Error("executor private candidate sink record identity is invalid");
  }
  const unsigned = {
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    opaque_handoff_ref: validateOpaqueHandoffRef(value.opaque_handoff_ref),
    delivery_session_ref: validateOpaqueSessionRef(value.delivery_session_ref),
    generation_input_ref: validateGenerationInputRef(value.generation_input_ref),
    generation_grant_ref: validateGenerationGrantRef(value.generation_grant_ref),
    owner_identity: validatePrivateOwnerIdentity(value.owner_identity),
    task_id: boundedString(value.task_id, "task_id", 512),
    attempt: positiveSafeInteger(value.attempt, "attempt"),
    output_schema_version: boundedString(
      value.output_schema_version,
      "output_schema_version",
      256,
    ),
  };
  const record: AutomaticBuildExecutorPrivateCandidateSinkRecordV3 = {
    version: value.version,
    candidate_sink_ref: validateCandidateSinkRef(value.candidate_sink_ref),
    ...unsigned,
    created_at: isoTimestamp(value.created_at, "created_at"),
  };
  if (record.candidate_sink_ref !== privateCandidateSinkRefFor(unsigned)
    || record.owner_identity.task_id !== record.task_id
    || record.owner_identity.attempt !== record.attempt) {
    throw new Error("executor private candidate sink ref does not match its identity");
  }
  if (expected) {
    if (record.opaque_session_ref !== expected.private_session.opaque_session_ref
      || record.opaque_handoff_ref !== expected.private_session.opaque_handoff_ref
      || record.delivery_session_ref !== expected.delivery.opaque_session_ref
      || record.generation_input_ref !== expected.delivery.generation_input_ref
      || record.generation_grant_ref !== expected.grant.generation_grant_ref
      || canonicalAutomaticBuildJson(record.owner_identity)
        !== canonicalAutomaticBuildJson(expected.private_session.owner_identity)
      || record.task_id !== expected.private_session.owner_identity.task_id
      || record.attempt !== expected.private_session.owner_identity.attempt
      || record.output_schema_version !== expected.output_contract.version
      || record.output_schema_version !== expected.grant.output_schema_version
      || record.output_schema_version !== expected.delivery.output_schema_version) {
      throw new Error("executor private candidate sink binding changed");
    }
  }
  return record;
}

function issuePrivateCandidateSink(input: {
  private_session: AutomaticBuildExecutorPrivateSessionRecordV1;
  delivery: AutomaticBuildExecutorPrivateDeliverySessionRecordV3;
  grant: AutomaticBuildExecutorGenerationGrantRecordV2;
  output_contract: AutomaticBuildPrivateArtifactCandidateContractV2;
  created_at: string;
}): AutomaticBuildExecutorPrivateCandidateSinkRecordV3 {
  const unsigned = {
    opaque_session_ref: input.private_session.opaque_session_ref,
    opaque_handoff_ref: input.private_session.opaque_handoff_ref,
    delivery_session_ref: input.delivery.opaque_session_ref,
    generation_input_ref: input.delivery.generation_input_ref,
    generation_grant_ref: input.grant.generation_grant_ref,
    owner_identity: input.private_session.owner_identity,
    task_id: input.private_session.owner_identity.task_id,
    attempt: input.private_session.owner_identity.attempt,
    output_schema_version: input.output_contract.version,
  };
  const proposed: AutomaticBuildExecutorPrivateCandidateSinkRecordV3 = {
    version: "automatic_build_executor_private_candidate_sink_record.v3",
    candidate_sink_ref: privateCandidateSinkRefFor(unsigned),
    ...unsigned,
    created_at: input.created_at,
  };
  const file = candidateSinkRecordFile(input.private_session.opaque_session_ref);
  if (writeCreateOnly(file, proposed)) return proposed;
  return validatePrivateCandidateSinkRecord(decodeJsonRecord(file), input);
}

function readCandidateSinkRecord(
  opaqueSessionRef: string,
): AutomaticBuildExecutorAnyCandidateSinkRecord | undefined {
  const file = candidateSinkRecordFile(opaqueSessionRef);
  if (!existsSync(file)) return undefined;
  const value = decodeJsonRecord(file);
  return isRecord(value) && value.version === "automatic_build_executor_private_candidate_sink_record.v3"
    ? validatePrivateCandidateSinkRecord(value)
    : validateCandidateSinkRecord(value);
}

function validateGenerationStartRecord(
  value: unknown,
  grant: AutomaticBuildExecutorGenerationGrantRecordV2,
): AutomaticBuildExecutorGenerationStartRecordV2 {
  if (!isRecord(value)) throw new Error("executor generation start record is invalid");
  exactKeys(value, [
    "version",
    "opaque_session_ref",
    "generation_input_ref",
    "generation_grant_ref",
    "task_session_ref",
    "semantic_attempt",
    "response",
    "started_at",
  ]);
  if (value.version !== "automatic_build_executor_generation_start_record.v2"
    || value.opaque_session_ref !== grant.opaque_session_ref
    || value.generation_input_ref !== grant.generation_input_ref
    || value.generation_grant_ref !== grant.generation_grant_ref
    || !isRecord(value.response)
    || value.response.version !== "automatic_build_executor_session.v3") {
    throw new Error("executor generation start record identity is invalid");
  }
  const response = value.response as unknown as AutomaticBuildExecutorSessionResponseV3;
  if (response.action.kind !== "GENERATE"
    || response.action.opaque_session_ref !== value.task_session_ref
    || response.action.semantic_attempt !== value.semantic_attempt
    || !CANDIDATE_SINK_REF.test(response.action.candidate_sink_ref)) {
    throw new Error("executor generation start response is invalid");
  }
  const sink = readCandidateSinkRecord(response.action.opaque_session_ref);
  if (!sink || sink.candidate_sink_ref !== response.action.candidate_sink_ref) {
    throw new Error("executor generation start candidate sink is missing or changed");
  }
  const record: AutomaticBuildExecutorGenerationStartRecordV2 = {
    version: value.version,
    opaque_session_ref: grant.opaque_session_ref,
    generation_input_ref: grant.generation_input_ref,
    generation_grant_ref: grant.generation_grant_ref,
    task_session_ref: validateOpaqueSessionRef(value.task_session_ref),
    semantic_attempt: positiveSafeInteger(value.semantic_attempt, "semantic_attempt"),
    response,
    started_at: isoTimestamp(value.started_at, "started_at"),
  };
  boundedV3Response(record.response);
  return record;
}

function readGenerationStartRecord(
  grant: AutomaticBuildExecutorGenerationGrantRecordV2,
): AutomaticBuildExecutorGenerationStartRecordV2 | undefined {
  const file = generationStartRecordFile(grant.generation_grant_ref);
  if (!existsSync(file)) return undefined;
  return validateGenerationStartRecord(decodeJsonRecord(file), grant);
}

function deliveryProgressResponse(input: {
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3;
  material: AutomaticBuildExecutorDeliveryMaterialV3;
}): AutomaticBuildExecutorSessionResponseV3 {
  const receipts = confirmedDeliveryReceipts(input.delivery, input.material);
  const acknowledgedThroughOrdinal = receipts.length === input.material.chunks.length
    ? undefined
    : receipts.at(-1)?.ordinal;
  return boundedV3Response({
    version: "automatic_build_executor_session.v3",
    action: {
      kind: "DELIVER_INPUT",
      input_manifest: input.material.manifest,
      next_request: {
        version: "automatic_build_executor_input_next_request.v4",
        opaque_session_ref: input.delivery.opaque_session_ref,
        generation_input_ref: input.delivery.generation_input_ref,
        ...(acknowledgedThroughOrdinal === undefined
          ? {}
          : { ack_through_ordinal: acknowledgedThroughOrdinal }),
      },
    },
  });
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
  if (record.version !== "automatic_build_opaque_handoff_record.v1") {
    throw new Error("legacy Executor session requires a V2 handoff ref");
  }
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

type AutomaticBuildExecutorDeliveryContextV3 =
  | {
      kind: "public_dispatch";
      delivery: AutomaticBuildExecutorDeliverySessionRecordV3;
      target: AutomaticBuildTarget;
      owner: AutomaticBuildDispatchOwnerIdentityV1;
      persisted: AutomaticBuildPersistedDispatchV1;
      semantic_prompt: string;
      open_record: AutomaticBuildExecutorOpenRecordV1;
      material: AutomaticBuildExecutorDeliveryMaterialV3;
    }
  | {
      kind: "private_artifact";
      delivery: AutomaticBuildExecutorPrivateDeliverySessionRecordV3;
      context: AutomaticBuildPrivateArtifactContextV1;
      open_record: AutomaticBuildExecutorOpenRecordV1;
      material: AutomaticBuildExecutorDeliveryMaterialV3;
    };

function resolveDeliverySessionContext(
  opaqueSessionRefValue: string,
): AutomaticBuildExecutorDeliveryContextV3 {
  const delivery = readDeliverySessionRecord(validateOpaqueSessionRef(opaqueSessionRefValue));
  const handoffRecord = readOpaqueHandoffRecord(delivery.opaque_handoff_ref);
  if (delivery.version === "automatic_build_executor_private_delivery_session_record.v3") {
    const context = resolvePrivateArtifactContext(handoffRecord);
    if (canonicalAutomaticBuildJson(context.owner)
      !== canonicalAutomaticBuildJson(delivery.owner_identity)
      || context.attempt.task.task_id !== delivery.task_id) {
      throw new Error("executor private delivery owner identity changed");
    }
    const openFile = registryFile("executor-opens", delivery.opaque_handoff_ref);
    if (!existsSync(openFile)) throw new Error("executor private delivery open record is missing");
    const openRecord = validateOpenRecord(
      decodeJsonRecord(openFile),
      delivery.opaque_handoff_ref,
      context.owner,
    );
    if (openRecord.opaque_session_ref !== delivery.open_session_ref) {
      throw new Error("executor private delivery open identity changed");
    }
    const material = materialFromFrozenGenerationInput({
      delivery,
      expected_semantic_input: canonicalAutomaticBuildJson(context.attempt.task),
      build_material: (generationInput) => renderPrivateDeliveryMaterial({
        context,
        opaque_session_ref: delivery.opaque_session_ref,
        opaque_handoff_ref: delivery.opaque_handoff_ref,
        semantic_input: generationInput.semantic_input,
      }),
    });
    return {
      kind: "private_artifact",
      delivery,
      context,
      open_record: openRecord,
      material,
    };
  }
  const published = validatePublishedPublicDispatch(handoffRecord);
  if (canonicalAutomaticBuildJson(published.owner)
    !== canonicalAutomaticBuildJson(delivery.owner_identity)
    || published.owner.stage !== delivery.stage) {
    throw new Error("executor delivery owner identity changed");
  }
  const openFile = registryFile("executor-opens", delivery.opaque_handoff_ref);
  if (!existsSync(openFile)) throw new Error("executor delivery open record is missing");
  const openRecord = validateOpenRecord(
    decodeJsonRecord(openFile),
    delivery.opaque_handoff_ref,
    published.owner,
  );
  if (openRecord.opaque_session_ref !== delivery.open_session_ref) {
    throw new Error("executor delivery open identity changed");
  }
  const stage = taskDescriptor(published.target, published.persisted, delivery.work_unit_id);
  if (stage.descriptor.stage !== delivery.stage) {
    throw new Error("executor delivery work unit stage changed");
  }
  const material = materialFromFrozenGenerationInput({
    delivery,
    expected_semantic_prompt: published.semantic_prompt,
    build_material: (generationInput) => renderDeliveryMaterial({
      target: published.target,
      persisted: published.persisted,
      semantic_prompt: generationInput.semantic_prompt,
      opaque_session_ref: delivery.opaque_session_ref,
      opaque_handoff_ref: delivery.opaque_handoff_ref,
      owner: published.owner,
      work_unit_id: delivery.work_unit_id,
      semantic_input: generationInput.semantic_input,
    }),
  });
  return {
    kind: "public_dispatch",
    delivery,
    target: published.target,
    owner: published.owner,
    persisted: published.persisted,
    semantic_prompt: published.semantic_prompt,
    open_record: openRecord,
    material,
  };
}

export function openAutomaticBuildExecutorSessionV3(
  opaqueHandoffRefValue: string,
  options: { now?: string } = {},
): AutomaticBuildExecutorSessionResponseV3 {
  const opaqueHandoffRef = validateOpaqueHandoffRef(opaqueHandoffRefValue);
  const now = options.now === undefined ? new Date().toISOString() : isoTimestamp(options.now, "now");
  const record = readOpaqueHandoffRecord(opaqueHandoffRef);
  if (record.version === "automatic_build_opaque_handoff_record.v1"
    && record.kind === "private_artifact") {
    const context = resolvePrivateArtifactContext(record);
    if (context.inspection.state === "committed") return v3DoneResponse("committed");
    if (context.inspection.state === "retryable_failure") {
      return v3DoneResponse("retryable_failure");
    }
    const openFile = registryFile("executor-opens", opaqueHandoffRef);
    const proposedOpen: AutomaticBuildExecutorOpenRecordV1 = {
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
    let openRecord = proposedOpen;
    if (!writeCreateOnly(openFile, proposedOpen)) {
      openRecord = validateOpenRecord(decodeJsonRecord(openFile), opaqueHandoffRef, context.owner);
    }
    const deliverySessionRef = privateDeliverySessionRefFor({
      open_session_ref: openRecord.opaque_session_ref,
      opaque_handoff_ref: opaqueHandoffRef,
      owner_identity: context.owner,
      task_id: context.attempt.task.task_id,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    });
    const material = renderPrivateDeliveryMaterial({
      context,
      opaque_session_ref: deliverySessionRef,
      opaque_handoff_ref: opaqueHandoffRef,
    });
    persistGenerationInputRecord(material, now);
    const delivery = persistDeliverySessionRecord(privateDeliveryRecordFromMaterial({
      opaque_handoff_ref: opaqueHandoffRef,
      open_record: openRecord,
      delivery_session_ref: deliverySessionRef,
      context,
      material,
      created_at: now,
    }));
    return deliveryProgressResponse({ delivery, material });
  }
  if (record.version !== "automatic_build_opaque_handoff_record.v3"
    || record.session_protocol !== "automatic_build_executor_session.v3"
    || record.kind !== "public_dispatch") {
    throw new Error("automatic build executor session V3 currently requires a public dispatch");
  }
  const published = validatePublishedPublicDispatch(record);
  const inspection = inspectAutomaticBuildDispatch(
    published.target,
    published.owner.stage,
    published.owner.dispatch_id,
    now,
    published.owner.dispatch_run_id,
  );
  if (inspection.state === "finished") {
    return v3DoneResponse(terminalStatus(inspection.receipt.terminal_reason));
  }
  const workUnitId = inspection.next_work_unit_id;
  if (!workUnitId) {
    const receipt = finishAutomaticBuildDispatch(
      published.target,
      published.owner.stage,
      published.owner.dispatch_id,
      { now, dispatch_run_id: published.owner.dispatch_run_id },
    );
    return v3DoneResponse(terminalStatus(receipt.terminal_reason));
  }
  const openFile = registryFile("executor-opens", opaqueHandoffRef);
  const proposedOpen: AutomaticBuildExecutorOpenRecordV1 = {
    version: "automatic_build_executor_open_record.v1",
    opaque_handoff_ref: opaqueHandoffRef,
    opaque_session_ref: `absession1_${sha256({
      version: "automatic_build_executor_session_identity.v1",
      opaque_handoff_ref: opaqueHandoffRef,
      nonce: randomUUID(),
    })}`,
    owner_identity: published.owner,
    opened_at: now,
  };
  let openRecord = proposedOpen;
  if (!writeCreateOnly(openFile, proposedOpen)) {
    openRecord = validateOpenRecord(decodeJsonRecord(openFile), opaqueHandoffRef, published.owner);
  }
  const stage = taskDescriptor(published.target, published.persisted, workUnitId);
  const deliverySessionRef = deliverySessionRefFor({
    open_session_ref: openRecord.opaque_session_ref,
    opaque_handoff_ref: opaqueHandoffRef,
    owner_identity: published.owner,
    stage: stage.descriptor.stage,
    work_unit_id: stage.descriptor.work_unit_id,
    descriptor_input_hash: stage.descriptor.input_hash,
    transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  });
  const material = renderDeliveryMaterial({
    target: published.target,
    persisted: published.persisted,
    semantic_prompt: published.semantic_prompt,
    opaque_session_ref: deliverySessionRef,
    opaque_handoff_ref: opaqueHandoffRef,
    owner: published.owner,
    work_unit_id: workUnitId,
  });
  persistGenerationInputRecord(material, now);
  const delivery = persistDeliverySessionRecord(deliveryRecordFromMaterial({
    opaque_handoff_ref: opaqueHandoffRef,
    open_record: openRecord,
    delivery_session_ref: deliverySessionRef,
    owner: published.owner,
    stage: stage.descriptor.stage,
    work_unit_id: workUnitId,
    material,
    created_at: now,
  }));
  assertDeliveryMaterialMatches(delivery, material);
  return deliveryProgressResponse({ delivery, material });
}

function validateInputNextRequest(
  value: unknown,
): AutomaticBuildExecutorInputNextRequestV4 {
  if (!isRecord(value)) throw new Error("executor input.next request must be an object");
  exactKeys(
    value,
    ["version", "opaque_session_ref", "generation_input_ref"],
    ["ack_through_ordinal", "now"],
  );
  if (value.version !== "automatic_build_executor_input_next_request.v4") {
    throw new Error("executor input.next request version is unsupported");
  }
  return {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    generation_input_ref: validateGenerationInputRef(value.generation_input_ref),
    ...(value.ack_through_ordinal === undefined
      ? {}
      : {
          ack_through_ordinal: nonNegativeSafeInteger(
            value.ack_through_ordinal,
            "ack_through_ordinal",
          ),
        }),
    ...(value.now === undefined ? {} : { now: isoTimestamp(value.now, "now") }),
  };
}

export function nextAutomaticBuildExecutorInput(
  requestValue: AutomaticBuildExecutorInputNextRequestV4,
  options: { now?: string } = {},
): AutomaticBuildExecutorSessionResponseV3 {
  const request = validateInputNextRequest(requestValue);
  const nowValue = options.now ?? request.now;
  const now = nowValue === undefined ? new Date().toISOString() : isoTimestamp(nowValue, "now");
  const context = resolveDeliverySessionContext(request.opaque_session_ref);
  if (request.generation_input_ref !== context.delivery.generation_input_ref) {
    throw new Error("executor input.next generation input ref does not match its session");
  }
  const batches = context.material.batches;
  let receipts = confirmedDeliveryReceipts(context.delivery, context.material);
  const allConfirmed = receipts.length === context.material.chunks.length;
  if (request.ack_through_ordinal === undefined) {
    if (!allConfirmed && receipts.length !== 0) {
      throw new Error("executor input.next is missing the latest batch acknowledgement");
    }
    return inputBatchResponse(context.delivery, batches[0], now);
  }

  const ackOrdinal = request.ack_through_ordinal;
  const acknowledgedBatchIndex = batches.findIndex((batch) => batch.last_ordinal === ackOrdinal);
  if (acknowledgedBatchIndex < 0) {
    throw new Error("executor input.next ack ordinal is not a batch boundary");
  }
  if (acknowledgedBatchIndex === batches.length - 1) {
    throw new Error("executor input.next cannot acknowledge the final batch; use generation.start");
  }
  if (!allConfirmed) {
    const confirmedThrough = receipts.at(-1)?.ordinal;
    if (confirmedThrough !== undefined && ackOrdinal < confirmedThrough) {
      throw new Error("executor input.next ack ordinal moved backwards");
    }
    if (ackOrdinal !== confirmedThrough) {
      const nextUnconfirmedBatch = batches.find(
        (batch) => batch.first_ordinal === receipts.length,
      );
      if (!nextUnconfirmedBatch || ackOrdinal !== nextUnconfirmedBatch.last_ordinal) {
        throw new Error("executor input.next ack ordinal is out of order");
      }
      requireDeliveryBatchOffer(context.delivery, nextUnconfirmedBatch);
      confirmDeliveryBatch(context.delivery, nextUnconfirmedBatch, now);
      receipts = confirmedDeliveryReceipts(context.delivery, context.material);
      if (receipts.at(-1)?.ordinal !== ackOrdinal) {
        throw new Error("executor input.next batch acknowledgement did not remain contiguous");
      }
    }
  }
  return inputBatchResponse(context.delivery, batches[acknowledgedBatchIndex + 1], now);
}

function validateGenerationStartRequest(
  value: unknown,
): AutomaticBuildExecutorGenerationStartRequestV3 {
  if (!isRecord(value)) throw new Error("executor generation.start request must be an object");
  exactKeys(
    value,
    ["version", "opaque_session_ref", "generation_input_ref", "confirmed_through_ordinal"],
    ["now"],
  );
  if (value.version !== "automatic_build_executor_generation_start_request.v3") {
    throw new Error("executor generation.start request version is unsupported");
  }
  return {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    generation_input_ref: validateGenerationInputRef(value.generation_input_ref),
    confirmed_through_ordinal: nonNegativeSafeInteger(
      value.confirmed_through_ordinal,
      "confirmed_through_ordinal",
    ),
    ...(value.now === undefined ? {} : { now: isoTimestamp(value.now, "now") }),
  };
}

function generationStartAcceptance(
  request: AutomaticBuildExecutorGenerationStartRequestV3,
  delivery: AutomaticBuildExecutorAnyDeliverySessionRecordV3,
  grant: AutomaticBuildExecutorGenerationGrantRecordV2,
  acceptedAt: string,
): AutomaticBuildExecutorGenerationStartAcceptanceV1 {
  const proposed: AutomaticBuildExecutorGenerationStartAcceptanceV1 = {
    version: "automatic_build_executor_generation_start_acceptance.v1",
    opaque_session_ref: delivery.opaque_session_ref,
    generation_input_ref: delivery.generation_input_ref,
    generation_grant_ref: grant.generation_grant_ref,
    accepted_at: acceptedAt,
  };
  const file = generationStartAcceptanceFile(grant.generation_grant_ref);
  if (writeCreateOnly(file, proposed)) return proposed;
  const existing = decodeJsonRecord(file);
  if (!isRecord(existing)) throw new Error("executor generation start acceptance is invalid");
  exactKeys(existing, [
    "version",
    "opaque_session_ref",
    "generation_input_ref",
    "generation_grant_ref",
    "accepted_at",
  ]);
  if (existing.version !== proposed.version
    || existing.opaque_session_ref !== proposed.opaque_session_ref
    || existing.generation_input_ref !== proposed.generation_input_ref
    || existing.generation_grant_ref !== proposed.generation_grant_ref) {
    throw new Error("executor generation start acceptance conflicts with its grant");
  }
  return {
    ...proposed,
    accepted_at: isoTimestamp(existing.accepted_at, "accepted_at"),
  };
}

export function startAutomaticBuildExecutorGeneration(
  requestValue: AutomaticBuildExecutorGenerationStartRequestV3,
  options: {
    now?: string;
    timing?: AutomaticBuildExecutorServerTimingObserverV1;
  } = {},
): AutomaticBuildExecutorSessionResponseV3 {
  const request = validateGenerationStartRequest(requestValue);
  const nowValue = options.now ?? request.now;
  const now = nowValue === undefined ? new Date().toISOString() : isoTimestamp(nowValue, "now");
  const context = resolveDeliverySessionContext(request.opaque_session_ref);
  if (request.generation_input_ref !== context.delivery.generation_input_ref) {
    throw new Error("executor generation.start generation input ref does not match its session");
  }
  const finalBatch = context.material.batches.at(-1);
  const finalChunk = context.material.chunks.at(-1);
  if (!finalBatch || !finalChunk
    || request.confirmed_through_ordinal !== finalChunk.ordinal
    || finalBatch.last_ordinal !== finalChunk.ordinal) {
    throw new Error("executor generation.start must confirm the final batch ordinal");
  }
  requireDeliveryBatchOffer(context.delivery, finalBatch);
  let receipts = confirmedDeliveryReceipts(context.delivery, context.material);
  if (receipts.length !== context.material.chunks.length) {
    if (receipts.length !== finalBatch.first_ordinal) {
      throw new Error("executor generation.start requires every non-final batch acknowledgement");
    }
    confirmDeliveryBatch(context.delivery, finalBatch, now);
    receipts = confirmedDeliveryReceipts(context.delivery, context.material);
  }
  if (receipts.length !== context.material.chunks.length) {
    throw new Error("executor generation.start requires complete input delivery");
  }
  const grant = issueGenerationGrant(context.delivery, context.material, now);
  const existingStart = readGenerationStartRecord(grant);
  if (existingStart) {
    options.timing?.complete_phase("current-state/claim");
    options.timing?.complete_phase("input-render-or-reuse");
    return existingStart.response;
  }
  const acceptance = generationStartAcceptance(request, context.delivery, grant, now);
  if (context.kind === "private_artifact") {
    if (context.context.inspection.state !== "pending") {
      throw new Error("executor private generation.start task is already terminal");
    }
    options.timing?.complete_phase("current-state/claim");
    const privateSession = persistPrivateSessionRecord({
      opaque_handoff_ref: context.delivery.opaque_handoff_ref,
      open_record: context.open_record,
      owner: context.context.owner,
      created_at: acceptance.accepted_at,
    });
    const outputContract = privateArtifactCandidateContractV2(
      context.context.attempt.task,
    );
    if (outputContract.version !== grant.output_schema_version
      || canonicalAutomaticBuildJson(outputContract)
        !== canonicalAutomaticBuildJson(context.material.output_contract)) {
      throw new Error("executor private generation.start output contract changed after grant");
    }
    options.timing?.complete_phase("input-render-or-reuse");
    const candidateSink = issuePrivateCandidateSink({
      private_session: privateSession,
      delivery: context.delivery,
      grant,
      output_contract: outputContract,
      created_at: acceptance.accepted_at,
    });
    const response = boundedV3Response({
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "GENERATE",
        opaque_session_ref: privateSession.opaque_session_ref,
        candidate_sink_ref: candidateSink.candidate_sink_ref,
        semantic_attempt: context.context.owner.attempt,
        output_contract: outputContract,
      },
    });
    const record: AutomaticBuildExecutorGenerationStartRecordV2 = {
      version: "automatic_build_executor_generation_start_record.v2",
      opaque_session_ref: context.delivery.opaque_session_ref,
      generation_input_ref: context.delivery.generation_input_ref,
      generation_grant_ref: grant.generation_grant_ref,
      task_session_ref: privateSession.opaque_session_ref,
      semantic_attempt: context.context.owner.attempt,
      response,
      started_at: acceptance.accepted_at,
    };
    const file = generationStartRecordFile(grant.generation_grant_ref);
    if (writeCreateOnly(file, record)) return response;
    return validateGenerationStartRecord(decodeJsonRecord(file), grant).response;
  }
  const inspection = inspectAutomaticBuildDispatch(
    context.target,
    context.owner.stage,
    context.owner.dispatch_id,
    acceptance.accepted_at,
    context.owner.dispatch_run_id,
  );
  if (inspection.state === "finished" || inspection.next_work_unit_id !== context.delivery.work_unit_id) {
    throw new Error("executor generation.start delivery is no longer the current dispatch task");
  }
  const stage = taskDescriptor(context.target, context.persisted, context.delivery.work_unit_id);
  const currentBinding = stage.task_bindings[context.delivery.work_unit_id];
  if (!currentBinding) {
    throw new Error("executor generation.start current task policy binding is unavailable");
  }
  if (isAutomaticBuildTaskPolicyBindingV2(currentBinding)
    && currentBinding.input_hash !== context.delivery.semantic_input_sha256) {
    throw new Error("executor generation.start frozen input no longer matches the current task binding");
  }
  const advanced = advanceAutomaticBuildDispatch(
    context.target,
    context.owner.stage,
    context.owner.dispatch_id,
    {
      descriptors: stage.descriptors,
      task_bindings: stage.task_bindings,
      dispatch_run_id: context.owner.dispatch_run_id,
      now: acceptance.accepted_at,
      max_semantic_attempts: MAX_SEMANTIC_ATTEMPTS,
      max_lease_epochs: MAX_LEASE_EPOCHS,
    },
  );
  let claim: ActiveAutomaticBuildClaim;
  if (advanced.status === "leased") {
    claim = advanced.claim;
  } else if (advanced.status === "waiting") {
    const current = inspectAutomaticBuildTaskClaim(
      context.target,
      context.owner.stage,
      context.delivery.work_unit_id,
      {
        now: acceptance.accepted_at,
        max_semantic_attempts: MAX_SEMANTIC_ATTEMPTS,
        max_lease_epochs: MAX_LEASE_EPOCHS,
      },
    );
    if (current.status !== "already_leased"
      || current.lease.owner !== context.persisted.owner) {
      throw new Error("executor generation.start could not recover its accepted task claim");
    }
    claim = current;
  } else {
    throw new Error(`executor generation.start cannot claim task: ${advanced.status}`);
  }
  if (claim.lease.work_unit_id !== context.delivery.work_unit_id) {
    throw new Error("executor generation.start claimed a different work unit");
  }
  const taskSession = persistTaskSessionRecord({
    opaque_handoff_ref: context.delivery.opaque_handoff_ref,
    open_record: context.open_record,
    owner: context.owner,
    claim,
    created_at: acceptance.accepted_at,
  });
  options.timing?.complete_phase("current-state/claim");
  runAutomaticBuildFrozenTaskInput(
    context.target,
    taskSession.stage,
    taskSession.work_unit_id,
    taskSession.lease_ref,
    taskSession.lease_token,
    context.material.semantic_input,
    { now: acceptance.accepted_at, run_ttl_ms: context.persisted.run_ttl_ms },
  );
  const outputContract = semanticCandidateContractV2(stage.descriptor);
  if (outputContract.version !== grant.output_schema_version) {
    throw new Error("executor generation.start output contract changed after grant");
  }
  options.timing?.complete_phase("input-render-or-reuse");
  const candidateSink = issueCandidateSink({
    task_session: taskSession,
    delivery: context.delivery,
    grant,
    output_contract: outputContract,
    created_at: acceptance.accepted_at,
  });
  const response = boundedV3Response({
    version: "automatic_build_executor_session.v3",
    action: {
      kind: "GENERATE",
      opaque_session_ref: taskSession.opaque_session_ref,
      candidate_sink_ref: candidateSink.candidate_sink_ref,
      semantic_attempt: taskSession.semantic_attempt,
      output_contract: outputContract,
    },
  });
  const record: AutomaticBuildExecutorGenerationStartRecordV2 = {
    version: "automatic_build_executor_generation_start_record.v2",
    opaque_session_ref: context.delivery.opaque_session_ref,
    generation_input_ref: context.delivery.generation_input_ref,
    generation_grant_ref: grant.generation_grant_ref,
    task_session_ref: taskSession.opaque_session_ref,
    semantic_attempt: taskSession.semantic_attempt,
    response,
    started_at: acceptance.accepted_at,
  };
  const file = generationStartRecordFile(grant.generation_grant_ref);
  if (writeCreateOnly(file, record)) return response;
  return validateGenerationStartRecord(decodeJsonRecord(file), grant).response;
}

function stagePrivateArtifactCandidateValue(
  context: AutomaticBuildPrivateArtifactContextV1,
  candidate: JsonValue,
  maxBytes: number,
): void {
  const candidatePath = context.attempt.candidate_path;
  const bytes = Buffer.from(`${canonicalAutomaticBuildJson(candidate)}\n`, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new Error(`candidate exceeds ${maxBytes} bytes`);
  }
  const assertExisting = (): void => {
    const stat = lstatSync(candidatePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
      throw new Error("private artifact candidate mailbox is invalid");
    }
    const existing = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(candidatePath)),
    ) as unknown;
    if (canonicalAutomaticBuildJson(existing) !== canonicalAutomaticBuildJson(candidate)) {
      throw new Error("private artifact candidate already exists with different fields");
    }
  };
  if (existsSync(candidatePath)) {
    assertExisting();
    return;
  }
  try {
    writeFileSync(candidatePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    assertExisting();
  }
}

export function submitAutomaticBuildExecutorCandidateV3(
  requestValue: AutomaticBuildExecutorCandidateSubmitV3,
  options: {
    now?: string;
    timing?: AutomaticBuildExecutorServerTimingObserverV1;
  } = {},
): AutomaticBuildExecutorSessionResponseV3 {
  const request = validateCandidateSubmitRequestV3(requestValue);
  const nowValue = options.now ?? request.now;
  const now = nowValue === undefined ? new Date().toISOString() : isoTimestamp(nowValue, "now");
  const directSink = readCandidateSinkRecord(request.opaque_session_ref);
  if (directSink?.version === "automatic_build_executor_private_candidate_sink_record.v3") {
    if (directSink.candidate_sink_ref !== request.candidate_sink_ref) {
      throw new Error("executor private candidate sink does not match its V3 session");
    }
    const privateResolved = resolvePrivateExecutorSession(request.opaque_session_ref);
    if (!privateResolved) throw new Error("executor private V3 session does not exist");
    const deliveryContext = resolveDeliverySessionContext(directSink.delivery_session_ref);
    if (deliveryContext.kind !== "private_artifact") {
      throw new Error("executor private candidate sink points to a public delivery");
    }
    const grant = issueGenerationGrant(
      deliveryContext.delivery,
      deliveryContext.material,
      directSink.created_at,
    );
    const outputContract = privateArtifactCandidateContractV2(
      privateResolved.context.attempt.task,
    );
    const sink = validatePrivateCandidateSinkRecord(
      decodeJsonRecord(candidateSinkRecordFile(request.opaque_session_ref)),
      {
        private_session: privateResolved.session,
        delivery: deliveryContext.delivery,
        grant,
        output_contract: outputContract,
      },
    );
    if (sink.candidate_sink_ref !== request.candidate_sink_ref) {
      throw new Error("executor private candidate sink ref changed before submit");
    }
    stagePrivateArtifactCandidateValue(
      privateResolved.context,
      request.candidate,
      Math.min(
        outputContract.max_bytes,
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes,
      ),
    );
    options.timing?.complete_phase("candidate-gate");
    submitPrivateArtifactContext(privateResolved.context, now);
    options.timing?.complete_phase("writer/commit");
    return openAutomaticBuildExecutorSessionV3(sink.opaque_handoff_ref, { now });
  }
  const taskSession = resolveTaskSession(request.opaque_session_ref);
  const storedSink = directSink
    ?? readCandidateSinkRecord(taskSession.task_session.opaque_session_ref);
  if (!storedSink
    || storedSink.version !== "automatic_build_executor_candidate_sink_record.v2"
    || storedSink.candidate_sink_ref !== request.candidate_sink_ref) {
    throw new Error("executor candidate sink does not match its V3 session");
  }
  const deliveryContext = resolveDeliverySessionContext(storedSink.delivery_session_ref);
  if (deliveryContext.kind !== "public_dispatch") {
    throw new Error("executor public candidate sink points to a private delivery");
  }
  const grant = issueGenerationGrant(
    deliveryContext.delivery,
    deliveryContext.material,
    storedSink.created_at,
  );
  const stage = taskDescriptor(
    taskSession.target,
    taskSession.persisted,
    taskSession.task_session.work_unit_id,
  );
  const outputContract = semanticCandidateContractV2(stage.descriptor);
  const sink = validateCandidateSinkRecord(
    decodeJsonRecord(candidateSinkRecordFile(taskSession.task_session.opaque_session_ref)),
    {
      task_session: taskSession.task_session,
      delivery: deliveryContext.delivery,
      grant,
      output_contract: outputContract,
    },
  );
  if (sink.candidate_sink_ref !== request.candidate_sink_ref) {
    throw new Error("executor candidate sink ref changed before submit");
  }
  stageAutomaticBuildCandidateValue(
    taskSession.target,
    taskSession.task_session.lease_ref,
    taskSession.task_session.lease_token,
    request.candidate,
    {
      max_bytes: Math.min(
        outputContract.max_bytes,
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes,
      ),
      max_tokens: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_tokens,
      now,
    },
  );
  options.timing?.complete_phase("candidate-gate");
  submitAutomaticBuildTaskCandidate(
    taskSession.target,
    taskSession.task_session.stage,
    taskSession.task_session.work_unit_id,
    taskSession.task_session.lease_ref,
    taskSession.task_session.lease_token,
    { now },
  );
  options.timing?.complete_phase("writer/commit");
  return openAutomaticBuildExecutorSessionV3(sink.opaque_handoff_ref, { now });
}

export function submitAutomaticBuildExecutorCandidate(
  opaqueSessionRefValue: string,
  candidatePathValue: string,
  options: { now?: string } = {},
): AutomaticBuildExecutorSessionResponseV1 {
  const now = options.now === undefined ? new Date().toISOString() : isoTimestamp(options.now, "now");
  const opaqueSessionRef = validateOpaqueSessionRef(opaqueSessionRefValue);
  if (readCandidateSinkRecord(opaqueSessionRef)) {
    throw new Error("V3 executor sessions reject candidate_path submit");
  }
  const candidatePath = path.resolve(boundedString(candidatePathValue, "candidate_path"));
  const privateResolved = resolvePrivateExecutorSession(opaqueSessionRef);
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
  const resolved = resolveTaskSession(opaqueSessionRef);
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
): AutomaticBuildExecutorSessionResponseV1 | AutomaticBuildExecutorSessionResponseV3 {
  const now = input.now === undefined ? new Date().toISOString() : isoTimestamp(input.now, "now");
  const diagnosticCode = boundedString(input.diagnostic_code, "diagnostic_code", 256);
  const failureDiagnostic = automaticBuildFailureDiagnosticFromExecutorReport(
    diagnosticCode,
    "generation",
  );
  const message = input.message === undefined
    ? undefined
    : boundedString(input.message, "message", 2_048);
  const privateResolved = resolvePrivateExecutorSession(opaqueSessionRefValue);
  if (privateResolved) {
    const privateV3 = readCandidateSinkRecord(opaqueSessionRefValue)?.version
      === "automatic_build_executor_private_candidate_sink_record.v3";
    if (privateResolved.context.inspection.state === "committed") {
      return privateV3 ? v3DoneResponse("committed") : doneResponse("committed");
    }
    failIntentArtifactTaskAttempt({
      private_root: privateResolved.context.attempt.private_root,
      task_path: privateResolved.context.attempt.task_path,
      diagnostic_code: diagnosticCode,
      ...(message ? { message } : {}),
      failed_at: now,
    });
    return privateV3 ? v3DoneResponse("retryable_failure") : doneResponse("retryable_failure");
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
        failure_diagnostic: failureDiagnostic,
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

function validateOpenRequestV3(value: unknown): AutomaticBuildExecutorOpenRequestV3 {
  if (!isRecord(value)) throw new Error("executor.open V3 request must be an object");
  exactKeys(value, ["version", "opaque_handoff_ref"], ["now"]);
  if (value.version !== "automatic_build_executor_open_request.v3") {
    throw new Error("executor.open V3 request version is unsupported");
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

function validateCandidateSubmitRequestV3(
  value: unknown,
): AutomaticBuildExecutorCandidateSubmitV3 {
  if (!isRecord(value)) throw new Error("executor candidate submit V3 request must be an object");
  exactKeys(
    value,
    ["version", "opaque_session_ref", "candidate_sink_ref", "candidate"],
    ["now"],
  );
  if (value.version !== "automatic_build_executor_candidate_submit.v3") {
    throw new Error("executor candidate submit V3 request version is unsupported");
  }
  const serialized = canonicalAutomaticBuildJson(value);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  const serializedTokens = estimateTokens(serialized);
  if (serializedBytes > CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes) {
    throw new Error(
      `executor candidate request exceeds ${CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes} bytes`,
    );
  }
  if (serializedTokens > CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_tokens) {
    throw new Error(
      `executor candidate request exceeds ${CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_tokens} estimated tokens`,
    );
  }
  return {
    version: value.version,
    opaque_session_ref: validateOpaqueSessionRef(value.opaque_session_ref),
    candidate_sink_ref: validateCandidateSinkRef(value.candidate_sink_ref),
    candidate: value.candidate as JsonValue,
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

export function runAutomaticBuildExecutorSessionCommand(
  value: unknown,
  options: { timing?: AutomaticBuildExecutorServerTimingObserverV1 } = {},
): AutomaticBuildExecutorSessionResponseV1 | AutomaticBuildExecutorSessionResponseV3 {
  if (!isRecord(value) || typeof value.version !== "string") {
    throw new Error("executor session request must be a versioned object");
  }
  if (value.version === "automatic_build_executor_open_request.v1") {
    const request = validateOpenRequest(value);
    return openAutomaticBuildExecutorSession(request.opaque_handoff_ref, { now: request.now });
  }
  if (value.version === "automatic_build_executor_open_request.v3") {
    const request = validateOpenRequestV3(value);
    return openAutomaticBuildExecutorSessionV3(request.opaque_handoff_ref, { now: request.now });
  }
  if (value.version === "automatic_build_executor_input_next_request.v4") {
    const request = validateInputNextRequest(value);
    return nextAutomaticBuildExecutorInput(request, { now: request.now });
  }
  if (value.version === "automatic_build_executor_generation_start_request.v3") {
    const request = validateGenerationStartRequest(value);
    return startAutomaticBuildExecutorGeneration(request, {
      now: request.now,
      timing: options.timing,
    });
  }
  if (value.version === "automatic_build_executor_candidate_submit.v3") {
    const request = validateCandidateSubmitRequestV3(value);
    return submitAutomaticBuildExecutorCandidateV3(request, {
      now: request.now,
      timing: options.timing,
    });
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
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (bytes.byteLength > MAX_CONTROL_STDIN_BYTES
    && (!isRecord(value) || value.version !== "automatic_build_executor_candidate_submit.v3")) {
    throw new Error("executor control stdin exceeds its byte limit");
  }
  return value;
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
