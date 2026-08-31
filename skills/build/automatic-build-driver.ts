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
import { tmpdir } from "node:os";
import path from "node:path";
import {
  automaticBuildPreflightEvaluationEvidence,
  DEFAULT_AUTOMATIC_BUILD_BUDGET,
  sameAutomaticBuildBudgetEvidence,
  validateAutomaticBuildPlanBudgetEvaluation,
  type AutomaticBuildBudgetLimitsV1,
  type AutomaticBuildExecutorProvenanceV1,
  type AutomaticBuildPlanBudgetEvaluationV2,
  type AutomaticBuildPreflightEvaluationEvidenceV2,
  type AutomaticBuildWallBudgetV1,
} from "../../packages/core/src/automatic-build-budget";
import {
  validateBuildPlanV1,
  type BuildPlanV1,
} from "../../packages/core/src/build-intent";
import {
  adaptAutomaticBuildPrivateArtifactSelectionV3,
  issueAutomaticBuildOpaqueHandoff,
  resolveAutomaticBuildTargetLids,
} from "../../packages/core/src/automatic-build-executor-session";
import { readAutomaticBuildDispatch } from "../../packages/core/src/automatic-build-dispatch-runtime";
import { validateBuildIntentAny } from "../../packages/core/src/build-intent-v2";
import {
  resolveAutomaticBuildTarget,
  type AutomaticBuildStage,
  type BuildTargetRefV2,
} from "../../packages/core/src/build-orchestrator";
import { isAutomaticBuildTaskPolicyBindingV2 } from "../../packages/core/src/semantic-artifact";
import { canonicalAutomaticBuildJson } from "../../packages/core/src/automatic-build-protocol";
import {
  createAutomaticBuildAttemptScope,
  prepareAutomaticBuildRetryRecovery,
  readAutomaticBuildRetryBoundary,
  recordAutomaticBuildRetryRecovery,
} from "../../packages/core/src/automatic-build-task-store";
import {
  validateAutomaticBuildRetryBoundary,
  type AutomaticBuildRetryBoundaryV1,
} from "../../packages/core/src/automatic-build-attempt-recovery";
import {
  createAutomaticBuildFailureDiagnostic,
  createAutomaticBuildFailureDiagnosticV3,
  isAutomaticBuildFailureDiagnosticV3,
  legacyAutomaticBuildFailureDiagnostic,
  requiredRecoveryForAutomaticBuildFailure,
  validateAutomaticBuildFailureDiagnostic,
  type AutomaticBuildFailureCategory,
  type AutomaticBuildFailureDiagnosticV2,
  type AutomaticBuildFailurePhase,
  type AutomaticBuildRequiredRecovery,
} from "../../packages/core/src/extractor-contract";
import {
  automaticBuildNext,
  automaticBuildPlan,
  automaticBuildProtocolDoctor,
  runAutomaticBuildCloseStage,
} from "./automatic-build";
import { prepareIntentArtifactMailboxes } from "./intent-artifact";

const MAX_STDIN_BYTES = 65_536;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_TRANSITIONS = 8;
const INVOCATION_REF = /^abinv1_[a-f0-9]{64}$/u;
const REQUEST_ID = /^abreq1_[a-f0-9]{64}$/u;
const HANDOFF_REF = /^abhandoff1_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_ROOT_FIELDS = new Set([
  "command",
  "cwd",
  "path",
  "sha256",
  "byte_length",
  "semantic_prompt",
  "extractor_prompt",
  "envelope",
  "candidate",
  "task_input",
  "receipt_body",
  "receipt",
  "receipts",
  "failure_diagnostic",
  "diagnostic_digest",
  "json_pointer",
  "expected",
  "plan_digest",
  "plan_id",
  "policy_set_digest",
  "proof_digest",
  "private_root",
  "task_path",
  "task_id",
  "artifact_id",
  "artifact_type",
  "intent_id",
  "intent_digest",
  "blueprint_digest",
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
const USER_DECISION_REASONS = new Set<AutomaticBuildUserDecisionReasonV1>([
  "plan_confirmation_required",
  "plan_changed",
  "pass2_choice_required",
  "budget_exceeded",
  "low_confidence_wall_budget",
  "wall_budget_exceeded",
  "executor_unavailable",
  "foundation_required",
  "legacy_migration_required",
  "quality_gate_failed",
  "retry_exhausted",
  "recovery_not_satisfied",
  "executor_instability",
  "installation_incompatible",
]);

export type AutomaticBuildUserDecisionReasonV1 =
  | "plan_confirmation_required"
  | "plan_changed"
  | "pass2_choice_required"
  | "budget_exceeded"
  | "low_confidence_wall_budget"
  | "wall_budget_exceeded"
  | "executor_unavailable"
  | "foundation_required"
  | "legacy_migration_required"
  | "quality_gate_failed"
  | "retry_exhausted"
  | "recovery_not_satisfied"
  | "executor_instability"
  | "installation_incompatible";

export interface AutomaticBuildUserDecisionProjectionV1 {
  category: AutomaticBuildUserDecisionReasonV1 | AutomaticBuildFailureCategory;
  code?: string;
  phase?: AutomaticBuildFailurePhase;
  stage?: AutomaticBuildStage;
  work_unit_count?: number;
  required_recovery?: AutomaticBuildRequiredRecovery;
  violations?: Array<{ code: string; actual: number; limit: number }>;
  confidence?: "high" | "medium" | "low";
  gate_status?: string;
}

export interface AutomaticBuildCompletionSummaryV1 {
  status: "complete";
  completed_stages: number;
}

export type AutomaticBuildStepActionV1 =
  | {
      kind: "SPAWN_EXECUTORS";
      executors: Array<{ opaque_handoff_ref: string }>;
    }
  | {
      kind: "WAIT";
      reason: "active_executors" | "active_lease" | "backoff";
      retry_after_ms: number;
    }
  | {
      kind: "NEEDS_USER";
      request_id: string;
      reason: AutomaticBuildUserDecisionReasonV1;
      message: string;
      choices: Array<{ choice_id: string; label: string; consequence: string }>;
      projection?: AutomaticBuildUserDecisionProjectionV1;
    }
  | {
      kind: "DONE";
      summary: AutomaticBuildCompletionSummaryV1;
    };

export interface AutomaticBuildStepResponseV1 {
  version: "automatic_build_step.v1";
  action: AutomaticBuildStepActionV1;
}

export interface AutomaticBuildStepRequestV1 {
  version: "automatic_build_step_request.v1";
  invocation_ref: string;
  available_agent_slots: 0 | 1 | 2 | 3;
  decision?: { request_id: string; choice_id: string };
}

export interface AutomaticBuildInvocationCreateV1 {
  version: "automatic_build_invocation_create.v1";
  target_input: string;
  root_dir: string;
  build_plan_path: string;
  quality_profile: "full";
  max_parallel: 1 | 2 | 3;
  created_at: string;
  budget?: AutomaticBuildBudgetLimitsV1;
  wall_budget?: AutomaticBuildWallBudgetV1;
  executor_provenance?: AutomaticBuildExecutorProvenanceV1;
}

interface AutomaticBuildInvocationRecordV1 {
  version: "automatic_build_invocation_record.v1";
  invocation_ref: string;
  input: AutomaticBuildInvocationCreateV1;
  initial_target_ref: BuildTargetRefV2;
  initial_build_plan_digest: string;
}

interface DriverStateIdentityV1 {
  build_plan_digest: string;
  descriptor_plan_digest?: string;
  preflight_evaluation?: AutomaticBuildPreflightEvaluationEvidenceV2;
}

interface DecisionBoundaryV1 {
  reason: AutomaticBuildUserDecisionReasonV1;
  internal_reason: string;
  state: DriverStateIdentityV1;
  stage?: AutomaticBuildStage;
  projection?: AutomaticBuildUserDecisionProjectionV1;
  plan_budget_evidence?: AutomaticBuildPlanBudgetEvaluationV2;
  attempt_scopes?: Array<{ work_unit_id: string; attempt_scope_digest: string }>;
  retry_boundaries?: Array<AutomaticBuildRetryBoundaryV1 & { work_unit_id: string }>;
}

interface AutomaticBuildDecisionRequestRecordV1 extends DecisionBoundaryV1 {
  version: "automatic_build_decision_request_record.v1";
  invocation_ref: string;
  request_id: string;
  choices: Array<{ choice_id: string; label: string; consequence: string }>;
}

interface AutomaticBuildDecisionReceiptV1 {
  version: "automatic_build_decision_receipt.v1";
  invocation_ref: string;
  request_id: string;
  choice_id: string;
  state: DriverStateIdentityV1;
}

interface AutomaticBuildDriverHandoffProjectionV1 {
  version: "automatic_build_driver_handoff_projection.v1";
  invocation_ref: string;
  opaque_handoff_ref: string;
  dispatch_identity: {
    stage: AutomaticBuildStage;
    dispatch_id: string;
    dispatch_run_id: string;
    handoff_digest: string;
  };
}

interface AutomaticBuildDriverDispatchProjectionV1 {
  version: "automatic_build_driver_dispatch_projection.v1";
  invocation_ref: string;
  dispatch_id: string;
  dispatch_run_id: string;
  opaque_handoff_ref: string;
}

interface DriverState {
  invocation: AutomaticBuildInvocationRecordV1;
  plan: BuildPlanV1;
  plan_result: ReturnType<typeof automaticBuildPlan>;
}

type AutomaticBuildPrivateArtifactWaveV1 =
  | { state: "complete" }
  | { state: "waiting" }
  | { state: "retry_exhausted" }
  | { state: "spawn"; executors: Array<{ opaque_handoff_ref: string }> };

interface DecisionEffect {
  bypass_budget?: true;
  bypass_wall_budget?: true;
  accepted_plan_budget_evidence?: AutomaticBuildPlanBudgetEvaluationV2;
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
    throw new Error("automatic build driver object has invalid fields");
  }
}

function boundedString(value: unknown, field: string, maxBytes = 16_384): string {
  if (typeof value !== "string" || !value || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} is invalid`);
  return value as number;
}

function validateBudget(value: unknown): AutomaticBuildBudgetLimitsV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("budget is invalid");
  exactKeys(value, [
    "version",
    "max_tasks",
    "max_total_score",
    "max_estimated_total_tokens",
    "max_batch_score",
    "max_parallel_cost",
  ]);
  if (value.version !== "automatic_build_budget_limits.v1") {
    throw new Error("budget version is invalid");
  }
  return {
    version: value.version,
    max_tasks: nonNegativeSafeInteger(value.max_tasks, "budget.max_tasks"),
    max_total_score: nonNegativeSafeInteger(value.max_total_score, "budget.max_total_score"),
    max_estimated_total_tokens: nonNegativeSafeInteger(
      value.max_estimated_total_tokens,
      "budget.max_estimated_total_tokens",
    ),
    max_batch_score: nonNegativeSafeInteger(value.max_batch_score, "budget.max_batch_score"),
    max_parallel_cost: nonNegativeSafeInteger(value.max_parallel_cost, "budget.max_parallel_cost"),
  };
}

function validateWallBudget(value: unknown): AutomaticBuildWallBudgetV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("wall_budget is invalid");
  exactKeys(
    value,
    ["version", "on_exceed"],
    ["max_wall_clock_minutes", "max_agent_starts", "max_duplicate_lease_ratio"],
  );
  if (value.version !== "automatic_build_wall_budget.v1"
    || (value.on_exceed !== "needs_user" && value.on_exceed !== "stop")) {
    throw new Error("wall_budget version or policy is invalid");
  }
  const maxWallClockMinutes = value.max_wall_clock_minutes;
  if (maxWallClockMinutes !== undefined
    && (typeof maxWallClockMinutes !== "number" || !Number.isFinite(maxWallClockMinutes)
      || maxWallClockMinutes < 0)) {
    throw new Error("wall_budget.max_wall_clock_minutes is invalid");
  }
  const maxAgentStarts = value.max_agent_starts === undefined
    ? undefined
    : nonNegativeSafeInteger(value.max_agent_starts, "wall_budget.max_agent_starts");
  const maxDuplicateLeaseRatio = value.max_duplicate_lease_ratio;
  if (maxDuplicateLeaseRatio !== undefined
    && (typeof maxDuplicateLeaseRatio !== "number" || !Number.isFinite(maxDuplicateLeaseRatio)
      || maxDuplicateLeaseRatio < 0 || maxDuplicateLeaseRatio > 1)) {
    throw new Error("wall_budget.max_duplicate_lease_ratio is invalid");
  }
  return {
    version: value.version,
    ...(maxWallClockMinutes === undefined ? {} : { max_wall_clock_minutes: maxWallClockMinutes }),
    ...(maxAgentStarts === undefined ? {} : { max_agent_starts: maxAgentStarts }),
    ...(maxDuplicateLeaseRatio === undefined ? {} : {
      max_duplicate_lease_ratio: maxDuplicateLeaseRatio,
    }),
    on_exceed: value.on_exceed,
  };
}

function validateExecutorProvenance(value: unknown): AutomaticBuildExecutorProvenanceV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("executor_provenance is invalid");
  exactKeys(value, ["model", "reasoning_effort", "harness_release"]);
  return {
    model: boundedString(value.model, "executor_provenance.model", 512),
    reasoning_effort: boundedString(value.reasoning_effort, "executor_provenance.reasoning_effort", 128),
    harness_release: boundedString(value.harness_release, "executor_provenance.harness_release", 512),
  };
}

function validateCreateInput(value: unknown): AutomaticBuildInvocationCreateV1 {
  if (!isRecord(value)) throw new Error("automatic build invocation create request is invalid");
  exactKeys(
    value,
    [
      "version",
      "target_input",
      "root_dir",
      "build_plan_path",
      "quality_profile",
      "max_parallel",
      "created_at",
    ],
    ["budget", "wall_budget", "executor_provenance"],
  );
  if (value.version !== "automatic_build_invocation_create.v1" || value.quality_profile !== "full") {
    throw new Error("automatic build invocation create version or quality profile is invalid");
  }
  const maxParallel = nonNegativeSafeInteger(value.max_parallel, "max_parallel");
  if (maxParallel < 1 || maxParallel > 3) throw new Error("max_parallel must be 1, 2, or 3");
  const createdAt = boundedString(value.created_at, "created_at", 128);
  if (!Number.isFinite(new Date(createdAt).getTime())) throw new Error("created_at is invalid");
  return {
    version: value.version,
    target_input: boundedString(value.target_input, "target_input"),
    root_dir: boundedString(value.root_dir, "root_dir"),
    build_plan_path: boundedString(value.build_plan_path, "build_plan_path"),
    quality_profile: value.quality_profile,
    max_parallel: maxParallel as 1 | 2 | 3,
    created_at: createdAt,
    ...(value.budget === undefined ? {} : { budget: validateBudget(value.budget)! }),
    ...(value.wall_budget === undefined ? {} : { wall_budget: validateWallBudget(value.wall_budget)! }),
    ...(value.executor_provenance === undefined ? {} : {
      executor_provenance: validateExecutorProvenance(value.executor_provenance)!,
    }),
  };
}

function validateStepRequest(value: unknown): AutomaticBuildStepRequestV1 {
  if (!isRecord(value)) throw new Error("automatic build step request is invalid");
  exactKeys(value, ["version", "invocation_ref", "available_agent_slots"], ["decision"]);
  if (value.version !== "automatic_build_step_request.v1"
    || typeof value.invocation_ref !== "string" || !INVOCATION_REF.test(value.invocation_ref)) {
    throw new Error("automatic build step request version or invocation ref is invalid");
  }
  const availableAgentSlots = nonNegativeSafeInteger(value.available_agent_slots, "available_agent_slots");
  if (availableAgentSlots > 3) throw new Error("available_agent_slots must be between 0 and 3");
  let decision: AutomaticBuildStepRequestV1["decision"];
  if (value.decision !== undefined) {
    if (!isRecord(value.decision)) throw new Error("automatic build decision is invalid");
    exactKeys(value.decision, ["request_id", "choice_id"]);
    if (typeof value.decision.request_id !== "string" || !REQUEST_ID.test(value.decision.request_id)) {
      throw new Error("automatic build decision request_id is invalid");
    }
    decision = {
      request_id: value.decision.request_id,
      choice_id: boundedString(value.decision.choice_id, "decision.choice_id", 128),
    };
  }
  return {
    version: value.version,
    invocation_ref: value.invocation_ref,
    available_agent_slots: availableAgentSlots as 0 | 1 | 2 | 3,
    ...(decision ? { decision } : {}),
  };
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
    throw new Error("automatic build driver registry root is invalid");
  }
  return realpathSync(root);
}

function staysWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function recordFile(directory: string, id: string): string {
  if (!/^[a-z0-9_-]{1,160}$/u.test(id)) throw new Error("automatic build record id is invalid");
  return path.join(registryRoot(), directory, `${id}.json`);
}

function writeCreateOnly(file: string, value: unknown): void {
  const root = registryRoot();
  const resolved = path.resolve(file);
  if (!staysWithin(root, resolved)) throw new Error("automatic build record escapes registry root");
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(path.dirname(resolved));
  if (realParent !== root && !staysWithin(root, realParent)) {
    throw new Error("automatic build record directory escapes registry root");
  }
  const target = path.join(realParent, path.basename(resolved));
  const bytes = Buffer.from(`${canonicalAutomaticBuildJson(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error("automatic build record exceeds its byte limit");
  try {
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readFileSync(target);
    if (!existing.equals(bytes)) throw new Error("automatic build create-only record conflicts");
  }
}

function readJsonRecord(file: string): unknown {
  const root = registryRoot();
  const resolved = path.resolve(file);
  if (!staysWithin(root, resolved)) throw new Error("automatic build record escapes registry root");
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
    throw new Error("automatic build record is invalid");
  }
  const real = realpathSync(resolved);
  if (!staysWithin(root, real)) throw new Error("automatic build record realpath escapes registry root");
  const bytes = readFileSync(real);
  if (bytes.includes(0)) throw new Error("automatic build record contains NUL");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function readBuildPlan(fileInput: string): BuildPlanV1 {
  const file = path.resolve(fileInput);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
    throw new Error("automatic build BuildPlan file is invalid");
  }
  const bytes = readFileSync(realpathSync(file));
  if (bytes.includes(0)) throw new Error("automatic build BuildPlan contains NUL");
  return validateBuildPlanV1(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
}

function normalizedCreateInput(
  input: AutomaticBuildInvocationCreateV1,
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
): AutomaticBuildInvocationCreateV1 {
  return {
    ...input,
    target_input: target.kind === "paper_workspace" ? target.workspace_dir : target.source_path,
    root_dir: target.root_dir,
    build_plan_path: path.resolve(input.build_plan_path),
  };
}

function invocationRefFor(input: AutomaticBuildInvocationCreateV1, targetRef: BuildTargetRefV2): string {
  return `abinv1_${sha256({
    version: "automatic_build_invocation_identity.v1",
    input,
    target_ref: targetRef,
  })}`;
}

function invocationRecordPath(invocationRef: string): string {
  if (!INVOCATION_REF.test(invocationRef)) throw new Error("automatic build invocation ref is invalid");
  return recordFile("invocations", invocationRef);
}

function validateTargetRef(value: unknown): BuildTargetRefV2 {
  if (!isRecord(value)) throw new Error("automatic build target ref is invalid");
  exactKeys(value, ["version", "workspace_dir", "book_id", "profile_id", "input_fingerprint"]);
  if (value.version !== "build_target_ref.v2"
    || (value.profile_id !== "technical_learning" && value.profile_id !== "paper")
    || typeof value.input_fingerprint !== "string" || !SHA256.test(value.input_fingerprint)) {
    throw new Error("automatic build target ref identity is invalid");
  }
  return {
    version: value.version,
    workspace_dir: boundedString(value.workspace_dir, "target_ref.workspace_dir"),
    book_id: boundedString(value.book_id, "target_ref.book_id", 512),
    profile_id: value.profile_id,
    input_fingerprint: value.input_fingerprint,
  };
}

function validatePreflightEvaluationEvidence(
  value: unknown,
): AutomaticBuildPreflightEvaluationEvidenceV2 {
  if (!isRecord(value)) throw new Error("automatic build preflight evaluation evidence is invalid");
  exactKeys(
    value,
    ["version", "descriptor_plan_digest", "dispatch_plan_digest", "cost_scope", "wall_clock"],
    ["build_plan"],
  );
  if (value.version !== "automatic_build_preflight_evaluation_evidence.v2"
    || typeof value.descriptor_plan_digest !== "string" || !SHA256.test(value.descriptor_plan_digest)
    || typeof value.dispatch_plan_digest !== "string" || !SHA256.test(value.dispatch_plan_digest)
    || !isRecord(value.cost_scope) || !isRecord(value.wall_clock)) {
    throw new Error("automatic build preflight evaluation evidence fields are invalid");
  }
  if (value.build_plan !== undefined) {
    if (!isRecord(value.build_plan)) throw new Error("automatic build preflight BuildPlan evidence is invalid");
    exactKeys(value.build_plan, ["plan_id", "plan_revision"]);
    if (typeof value.build_plan.plan_id !== "string" || !value.build_plan.plan_id
      || !Number.isSafeInteger(value.build_plan.plan_revision)
      || (value.build_plan.plan_revision as number) < 1) {
      throw new Error("automatic build preflight BuildPlan evidence fields are invalid");
    }
  }
  return value as unknown as AutomaticBuildPreflightEvaluationEvidenceV2;
}

function readInvocation(invocationRef: string): AutomaticBuildInvocationRecordV1 {
  const value = readJsonRecord(invocationRecordPath(invocationRef));
  if (!isRecord(value)) throw new Error("automatic build invocation record is invalid");
  exactKeys(value, [
    "version",
    "invocation_ref",
    "input",
    "initial_target_ref",
    "initial_build_plan_digest",
  ]);
  if (value.version !== "automatic_build_invocation_record.v1"
    || value.invocation_ref !== invocationRef
    || typeof value.initial_build_plan_digest !== "string"
    || !SHA256.test(value.initial_build_plan_digest)) {
    throw new Error("automatic build invocation record identity is invalid");
  }
  const input = validateCreateInput(value.input);
  const initialTargetRef = validateTargetRef(value.initial_target_ref);
  if (invocationRefFor(input, initialTargetRef) !== invocationRef) {
    throw new Error("automatic build invocation record digest is invalid");
  }
  return {
    version: value.version,
    invocation_ref: invocationRef,
    input,
    initial_target_ref: initialTargetRef,
    initial_build_plan_digest: value.initial_build_plan_digest,
  };
}

export function createAutomaticBuildInvocation(inputValue: AutomaticBuildInvocationCreateV1): {
  version: "automatic_build_invocation_ref.v1";
  invocation_ref: string;
} {
  const requested = validateCreateInput(inputValue);
  const target = resolveAutomaticBuildTarget(requested.target_input, path.resolve(requested.root_dir));
  const input = normalizedCreateInput(requested, target);
  const buildPlan = readBuildPlan(input.build_plan_path);
  const invocationRef = invocationRefFor(input, target.target_ref);
  const record: AutomaticBuildInvocationRecordV1 = {
    version: "automatic_build_invocation_record.v1",
    invocation_ref: invocationRef,
    input,
    initial_target_ref: target.target_ref,
    initial_build_plan_digest: buildPlan.plan_digest,
  };
  writeCreateOnly(invocationRecordPath(invocationRef), record);
  return { version: "automatic_build_invocation_ref.v1", invocation_ref: invocationRef };
}

function stateIdentity(state: DriverState): DriverStateIdentityV1 {
  const preflight = state.plan_result.preflight;
  return {
    build_plan_digest: state.plan.plan_digest,
    ...(preflight ? { descriptor_plan_digest: preflight.descriptor_plan_digest } : {}),
    ...(preflight ? {
      preflight_evaluation: automaticBuildPreflightEvaluationEvidence(preflight),
    } : {}),
  };
}

function transitionStateKey(
  state: DriverState,
  availableAgentSlots: number,
  effect: DecisionEffect,
): string {
  return sha256({
    version: "automatic_build_driver_transition_state.v1",
    invocation_ref: state.invocation.invocation_ref,
    available_agent_slots: availableAgentSlots,
    identity: stateIdentity(state),
    effect,
    stages: state.plan_result.snapshot.stages.map((stage) => ({
      stage: stage.stage,
      closed: stage.closed,
      pending_tasks: stage.pending_tasks,
    })),
  });
}

function readTransitionClock(file: string, invocationRef: string, stateKey: string): string {
  const value = readJsonRecord(file);
  if (!isRecord(value)) throw new Error("automatic build transition clock is invalid");
  exactKeys(value, ["version", "invocation_ref", "state_key", "now"]);
  if (value.version !== "automatic_build_transition_clock.v1"
    || value.invocation_ref !== invocationRef
    || value.state_key !== stateKey
    || typeof value.now !== "string"
    || !Number.isFinite(Date.parse(value.now))) {
    throw new Error("automatic build transition clock identity is invalid");
  }
  return value.now;
}

function transitionNow(
  state: DriverState,
  availableAgentSlots: number,
  effect: DecisionEffect,
): string {
  const stateKey = transitionStateKey(state, availableAgentSlots, effect);
  const file = recordFile(path.join("transition-clocks", state.invocation.invocation_ref), stateKey);
  if (existsSync(file)) return readTransitionClock(file, state.invocation.invocation_ref, stateKey);
  const record = {
    version: "automatic_build_transition_clock.v1",
    invocation_ref: state.invocation.invocation_ref,
    state_key: stateKey,
    now: new Date().toISOString(),
  };
  try {
    writeCreateOnly(file, record);
    return record.now;
  } catch (error) {
    if (!existsSync(file)) throw error;
    return readTransitionClock(file, state.invocation.invocation_ref, stateKey);
  }
}

function loadDriverState(
  invocation: AutomaticBuildInvocationRecordV1,
  availableAgentSlots: number,
  effect: DecisionEffect = {},
): DriverState {
  const input = invocation.input;
  const target = resolveAutomaticBuildTarget(input.target_input, input.root_dir);
  if (target.book_id !== invocation.initial_target_ref.book_id
    || target.profile_id !== invocation.initial_target_ref.profile_id
    || path.resolve(target.workspace_dir) !== path.resolve(invocation.initial_target_ref.workspace_dir)) {
    throw new Error("automatic build invocation target boundary changed");
  }
  const plan = readBuildPlan(input.build_plan_path);
  const planResult = automaticBuildPlan(input.target_input, input.root_dir, {
    requested_workers: input.max_parallel,
    available_agent_slots: availableAgentSlots,
    quality_profile: input.quality_profile,
    budget: effect.bypass_budget ? DEFAULT_AUTOMATIC_BUILD_BUDGET : input.budget,
    wall_budget: effect.bypass_wall_budget ? undefined : input.wall_budget,
    executor_provenance: input.executor_provenance,
    build_plan: plan,
  });
  return { invocation, plan, plan_result: planResult };
}

function planAuthorizationPath(invocationRef: string, planDigest: string): string {
  if (!SHA256.test(planDigest)) throw new Error("automatic build plan authorization digest is invalid");
  return recordFile(path.join("authorizations", invocationRef), planDigest);
}

function isPlanAuthorized(invocation: AutomaticBuildInvocationRecordV1, planDigest: string): boolean {
  if (planDigest === invocation.initial_build_plan_digest) return true;
  const file = planAuthorizationPath(invocation.invocation_ref, planDigest);
  if (!existsSync(file)) return false;
  const value = readJsonRecord(file);
  if (!isRecord(value)) throw new Error("automatic build plan authorization is invalid");
  exactKeys(value, [
    "version",
    "invocation_ref",
    "request_id",
    "choice_id",
    "build_plan_digest",
  ]);
  if (value.version !== "automatic_build_plan_authorization.v1"
    || value.invocation_ref !== invocation.invocation_ref
    || typeof value.request_id !== "string" || !REQUEST_ID.test(value.request_id)
    || value.choice_id !== "confirm_current"
    || value.build_plan_digest !== planDigest) {
    throw new Error("automatic build plan authorization identity is invalid");
  }
  return true;
}

function authorizePlan(
  invocation: AutomaticBuildInvocationRecordV1,
  requestId: string,
  choiceId: string,
  planDigest: string,
): void {
  writeCreateOnly(planAuthorizationPath(invocation.invocation_ref, planDigest), {
    version: "automatic_build_plan_authorization.v1",
    invocation_ref: invocation.invocation_ref,
    request_id: requestId,
    choice_id: choiceId,
    build_plan_digest: planDigest,
  });
}

function externalReason(internalReason: string): AutomaticBuildUserDecisionReasonV1 {
  switch (internalReason) {
    case "build_plan_required":
    case "build_plan_unconfirmed":
    case "preflight_required":
    case "evaluation_required":
      return "plan_confirmation_required";
    case "build_plan_invalid":
    case "build_plan_digest_drift":
    case "build_plan_book_drift":
    case "build_plan_source_drift":
    case "build_plan_profile_drift":
    case "build_plan_policy_drift":
    case "build_plan_closure_drift":
    case "build_plan_freshness_drift":
    case "plan_changed":
    case "evaluation_changed":
    case "invocation_build_plan_drift":
      return "plan_changed";
    case "budget_exceeded":
    case "build_plan_budget_changed":
      return "budget_exceeded";
    case "low_confidence_wall_budget": return "low_confidence_wall_budget";
    case "wall_budget_exceeded": return "wall_budget_exceeded";
    case "executor_unavailable": return "executor_unavailable";
    case "legacy_migration_required":
    case "legacy_resume_selected":
    case "legacy_partial_dispatch_run":
      return "legacy_migration_required";
    case "quality_gate_failed": return "quality_gate_failed";
    case "retry_exhausted": return "retry_exhausted";
    case "recovery_not_satisfied": return "recovery_not_satisfied";
    case "executor_instability": return "executor_instability";
    case "executor_prompt_unavailable":
    case "protocol_incompatible":
      return "installation_incompatible";
    default: return "foundation_required";
  }
}

function userMessage(reason: AutomaticBuildUserDecisionReasonV1): string {
  switch (reason) {
    case "plan_confirmation_required": return "Confirm the current build plan before model work starts.";
    case "plan_changed": return "The authoritative build plan changed and requires a fresh confirmation.";
    case "pass2_choice_required": return "Choose whether the confirmed plan should include Pass2 enrichment.";
    case "budget_exceeded": return "The current build forecast exceeds the confirmed budget.";
    case "low_confidence_wall_budget": return "The wall-clock forecast exceeds its limit with low confidence.";
    case "wall_budget_exceeded": return "The current wall-clock forecast exceeds the confirmed limit.";
    case "executor_unavailable": return "No dedicated executor slot is currently available.";
    case "foundation_required": return "The deterministic build foundation requires attention before continuing.";
    case "legacy_migration_required": return "Legacy build state requires an explicit migration choice.";
    case "quality_gate_failed": return "The stage quality gate failed and publication remains closed.";
    case "retry_exhausted": return "Semantic retries are exhausted and require explicit recovery.";
    case "recovery_not_satisfied": return "The bound terminal state does not satisfy same-scope retry recovery.";
    case "executor_instability": return "Executor lease recovery is exhausted and requires explicit recovery.";
    case "installation_incompatible": return "The installed build runtime is incompatible with this protocol.";
  }
}

function choicesFor(reason: AutomaticBuildUserDecisionReasonV1) {
  switch (reason) {
    case "plan_confirmation_required":
    case "plan_changed":
      return [{
        choice_id: "confirm_current",
        label: "Confirm current plan",
        consequence: "Bind authorization to the current authoritative plan state.",
      }];
    case "budget_exceeded":
    case "low_confidence_wall_budget":
    case "wall_budget_exceeded":
      return [{
        choice_id: "continue_current",
        label: "Continue current build",
        consequence: "Authorize this current forecast without changing the plan identity.",
      }];
    case "legacy_migration_required":
      return [
        {
          choice_id: "v2_rebuild",
          label: "Rebuild current state",
          consequence: "Use the current protocol and leave legacy artifacts unchanged.",
        },
        {
          choice_id: "legacy_resume",
          label: "Resume legacy state",
          consequence: "Keep using the frozen legacy recovery path.",
        },
      ];
    case "quality_gate_failed":
    case "retry_exhausted":
    case "recovery_not_satisfied":
    case "executor_instability":
      return [{
        choice_id: "retry_current",
        label: "Validate recovery and retry",
        consequence: "Re-read durable state after the required recovery action is complete.",
      }];
    default:
      return [];
  }
}

function safeStage(value: unknown): AutomaticBuildStage | undefined {
  return typeof value === "string" && STAGES.has(value as AutomaticBuildStage)
    ? value as AutomaticBuildStage
    : undefined;
}

function failureProjectionFor(
  reason: AutomaticBuildUserDecisionReasonV1,
  action: Record<string, unknown>,
): {
  diagnostic: AutomaticBuildFailureDiagnosticV2;
  work_unit_count: number;
  required_recovery: AutomaticBuildRequiredRecovery;
} | undefined {
  if (reason !== "retry_exhausted" && reason !== "executor_instability") return undefined;
  const tasks = Array.isArray(action.tasks) ? action.tasks : [];
  const workUnitCount = tasks.length;
  let diagnostic: AutomaticBuildFailureDiagnosticV2;
  if (reason === "executor_instability") {
    diagnostic = createAutomaticBuildFailureDiagnosticV3({
      category: "executor",
      code: "executor_instability",
      phase: "generation",
    });
  } else {
    const diagnostics = tasks.flatMap((task) => {
      if (!isRecord(task) || task.status !== "retry_exhausted" || task.failure_diagnostic === undefined) return [];
      try {
        return [validateAutomaticBuildFailureDiagnostic(task.failure_diagnostic)];
      } catch {
        return [];
      }
    });
    if (!diagnostics.length) {
      diagnostic = legacyAutomaticBuildFailureDiagnostic();
    } else if (diagnostics.every((item) => (
      item.version === diagnostics[0].version
      && item.category === diagnostics[0].category
      && item.code === diagnostics[0].code
      && (!isAutomaticBuildFailureDiagnosticV3(item)
        || (isAutomaticBuildFailureDiagnosticV3(diagnostics[0])
          && item.phase === diagnostics[0].phase))
    ))) {
      diagnostic = diagnostics[0];
    } else {
      const phases = diagnostics.flatMap((item) => (
        isAutomaticBuildFailureDiagnosticV3(item) ? [item.phase] : []
      ));
      diagnostic = phases.length === diagnostics.length
        && phases.every((phase) => phase === phases[0])
        ? createAutomaticBuildFailureDiagnosticV3({
            category: "internal",
            code: "multiple_failure_causes",
            phase: phases[0],
          })
        : createAutomaticBuildFailureDiagnostic({
            category: "internal",
            code: "multiple_failure_causes",
          });
    }
  }
  return {
    diagnostic,
    work_unit_count: workUnitCount,
    required_recovery: requiredRecoveryForAutomaticBuildFailure(diagnostic),
  };
}

function projectionFor(
  reason: AutomaticBuildUserDecisionReasonV1,
  action: Record<string, unknown>,
): AutomaticBuildUserDecisionProjectionV1 {
  const stage = safeStage(action.stage);
  const failure = failureProjectionFor(reason, action);
  const violations = Array.isArray(action.violations)
    ? action.violations.flatMap((item) => {
        if (!isRecord(item) || typeof item.code !== "string" || Buffer.byteLength(item.code, "utf8") > 128
          || typeof item.actual !== "number" || !Number.isFinite(item.actual)
          || typeof item.limit !== "number" || !Number.isFinite(item.limit)) return [];
        return [{ code: item.code, actual: item.actual, limit: item.limit }];
      }).slice(0, 16)
    : undefined;
  const confidence = action.confidence === "high" || action.confidence === "medium" || action.confidence === "low"
    ? action.confidence
    : undefined;
  const gateStatus = typeof action.gate_status === "string" && Buffer.byteLength(action.gate_status, "utf8") <= 128
    ? action.gate_status
    : undefined;
  return {
    category: failure?.diagnostic.category ?? reason,
    ...(failure ? { code: failure.diagnostic.code } : {}),
    ...(failure && isAutomaticBuildFailureDiagnosticV3(failure.diagnostic)
      ? { phase: failure.diagnostic.phase }
      : {}),
    ...(stage ? { stage } : {}),
    ...(failure ? {
      work_unit_count: failure.work_unit_count,
      required_recovery: failure.required_recovery,
    } : {}),
    ...(violations?.length ? { violations } : {}),
    ...(confidence ? { confidence } : {}),
    ...(gateStatus ? { gate_status: gateStatus } : {}),
  };
}

function attemptScopesForAction(
  action: Record<string, unknown>,
): Array<{ work_unit_id: string; attempt_scope_digest: string }> | undefined {
  if (!Array.isArray(action.tasks)) return undefined;
  const scopes = action.tasks.flatMap((task) => {
    if (!isRecord(task)
      || typeof task.task_id !== "string"
      || !task.task_id
      || Buffer.byteLength(task.task_id, "utf8") > 512
      || typeof task.attempt_scope_digest !== "string"
      || !SHA256.test(task.attempt_scope_digest)) return [];
    return [{ work_unit_id: task.task_id, attempt_scope_digest: task.attempt_scope_digest }];
  }).sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id));
  if (!scopes.length) return undefined;
  for (let index = 1; index < scopes.length; index += 1) {
    if (scopes[index - 1].work_unit_id === scopes[index].work_unit_id) {
      throw new Error("automatic build decision contains duplicate attempt scopes");
    }
  }
  return scopes;
}

function retryBoundariesForAction(
  action: Record<string, unknown>,
): Array<AutomaticBuildRetryBoundaryV1 & { work_unit_id: string }> | undefined {
  if (!Array.isArray(action.tasks)) return undefined;
  const boundaries = action.tasks.flatMap((task) => {
    if (!isRecord(task)
      || typeof task.task_id !== "string"
      || !task.task_id
      || Buffer.byteLength(task.task_id, "utf8") > 512
      || task.retry_boundary === undefined) return [];
    try {
      return [{
        work_unit_id: task.task_id,
        ...validateAutomaticBuildRetryBoundary(task.retry_boundary),
      }];
    } catch {
      throw new Error("automatic build decision contains an invalid retry boundary");
    }
  }).sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id));
  if (!boundaries.length) return undefined;
  for (let index = 1; index < boundaries.length; index += 1) {
    if (boundaries[index - 1].work_unit_id === boundaries[index].work_unit_id) {
      throw new Error("automatic build decision contains duplicate retry boundaries");
    }
  }
  return boundaries;
}

function boundaryFromAction(
  action: Record<string, unknown>,
  state: DriverStateIdentityV1,
): DecisionBoundaryV1 {
  const internalReason = typeof action.reason === "string" ? action.reason : "automatic_build_routing_blocked";
  const reason = externalReason(internalReason);
  const stage = safeStage(action.stage);
  const planBudgetEvidence = action.plan_budget_evidence === undefined
    ? undefined
    : validateAutomaticBuildPlanBudgetEvaluation(
        action.plan_budget_evidence as AutomaticBuildPlanBudgetEvaluationV2,
      );
  const attemptScopes = attemptScopesForAction(action);
  const retryBoundaries = retryBoundariesForAction(action);
  return {
    reason,
    internal_reason: internalReason,
    state,
    ...(stage ? { stage } : {}),
    projection: projectionFor(reason, action),
    ...(planBudgetEvidence ? { plan_budget_evidence: planBudgetEvidence } : {}),
    ...(attemptScopes ? { attempt_scopes: attemptScopes } : {}),
    ...(retryBoundaries ? { retry_boundaries: retryBoundaries } : {}),
  };
}

function syntheticBoundary(
  reason: AutomaticBuildUserDecisionReasonV1,
  internalReason: string,
  state: DriverState,
): DecisionBoundaryV1 {
  const stage = state.plan_result.preflight?.stage;
  return {
    reason,
    internal_reason: internalReason,
    state: stateIdentity(state),
    ...(stage ? { stage } : {}),
    projection: {
      category: reason,
      ...(stage ? { stage } : {}),
    },
  };
}

function requestRecordPath(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error("automatic build decision request id is invalid");
  return recordFile("requests", requestId);
}

function requestIdFor(
  invocation: AutomaticBuildInvocationRecordV1,
  boundary: DecisionBoundaryV1,
  choices: ReturnType<typeof choicesFor>,
): string {
  return `abreq1_${sha256({
    version: "automatic_build_decision_request_identity.v1",
    invocation_ref: invocation.invocation_ref,
    reason: boundary.reason,
    internal_reason: boundary.internal_reason,
    state: boundary.state,
    stage: boundary.stage ?? null,
    projection: boundary.projection ?? null,
    plan_budget_evidence: boundary.plan_budget_evidence ?? null,
    attempt_scopes: boundary.attempt_scopes ?? null,
    retry_boundaries: boundary.retry_boundaries ?? null,
    choices,
  })}`;
}

function issueBoundary(
  invocation: AutomaticBuildInvocationRecordV1,
  boundary: DecisionBoundaryV1,
): AutomaticBuildStepResponseV1 {
  const choices = choicesFor(boundary.reason);
  const requestId = requestIdFor(invocation, boundary, choices);
  const record: AutomaticBuildDecisionRequestRecordV1 = {
    version: "automatic_build_decision_request_record.v1",
    invocation_ref: invocation.invocation_ref,
    request_id: requestId,
    reason: boundary.reason,
    internal_reason: boundary.internal_reason,
    state: boundary.state,
    ...(boundary.stage ? { stage: boundary.stage } : {}),
    ...(boundary.projection ? { projection: boundary.projection } : {}),
    ...(boundary.plan_budget_evidence ? {
      plan_budget_evidence: boundary.plan_budget_evidence,
    } : {}),
    ...(boundary.attempt_scopes ? { attempt_scopes: boundary.attempt_scopes } : {}),
    ...(boundary.retry_boundaries ? { retry_boundaries: boundary.retry_boundaries } : {}),
    choices,
  };
  writeCreateOnly(requestRecordPath(requestId), record);
  return finalizeResponse({
    version: "automatic_build_step.v1",
    action: {
      kind: "NEEDS_USER",
      request_id: requestId,
      reason: boundary.reason,
      message: userMessage(boundary.reason),
      choices,
      ...(boundary.projection ? { projection: boundary.projection } : {}),
    },
  });
}

function readDecisionRequest(requestId: string): AutomaticBuildDecisionRequestRecordV1 {
  const value = readJsonRecord(requestRecordPath(requestId));
  if (!isRecord(value)) throw new Error("automatic build decision request record is invalid");
  exactKeys(
    value,
    [
      "version",
      "invocation_ref",
      "request_id",
      "reason",
      "internal_reason",
      "state",
      "choices",
    ],
    ["stage", "projection", "plan_budget_evidence", "attempt_scopes", "retry_boundaries"],
  );
  if (value.version !== "automatic_build_decision_request_record.v1"
    || value.request_id !== requestId
    || typeof value.invocation_ref !== "string"
    || !INVOCATION_REF.test(value.invocation_ref)
    || typeof value.reason !== "string"
    || !USER_DECISION_REASONS.has(value.reason as AutomaticBuildUserDecisionReasonV1)
    || typeof value.internal_reason !== "string"
    || !isRecord(value.state)
    || !Array.isArray(value.choices)) {
    throw new Error("automatic build decision request record identity is invalid");
  }
  exactKeys(
    value.state,
    ["build_plan_digest"],
    ["descriptor_plan_digest", "preflight_evaluation"],
  );
  if (typeof value.state.build_plan_digest !== "string" || !SHA256.test(value.state.build_plan_digest)
    || (value.state.descriptor_plan_digest !== undefined
      && (typeof value.state.descriptor_plan_digest !== "string"
        || !SHA256.test(value.state.descriptor_plan_digest)))) {
    throw new Error("automatic build decision request state identity is invalid");
  }
  const state: DriverStateIdentityV1 = {
    build_plan_digest: value.state.build_plan_digest,
    ...(typeof value.state.descriptor_plan_digest === "string"
      ? { descriptor_plan_digest: value.state.descriptor_plan_digest }
      : {}),
    ...(value.state.preflight_evaluation !== undefined
      ? { preflight_evaluation: validatePreflightEvaluationEvidence(value.state.preflight_evaluation) }
      : {}),
  };
  const choices = value.choices.map((choice) => {
    if (!isRecord(choice)) throw new Error("automatic build decision request choice is invalid");
    exactKeys(choice, ["choice_id", "label", "consequence"]);
    return {
      choice_id: boundedString(choice.choice_id, "decision choice_id", 128),
      label: boundedString(choice.label, "decision label", 512),
      consequence: boundedString(choice.consequence, "decision consequence", 1_024),
    };
  });
  const stage = value.stage === undefined ? undefined : safeStage(value.stage);
  if (value.stage !== undefined && !stage) throw new Error("automatic build decision request stage is invalid");
  const planBudgetEvidence = value.plan_budget_evidence === undefined
    ? undefined
    : validateAutomaticBuildPlanBudgetEvaluation(
        value.plan_budget_evidence as AutomaticBuildPlanBudgetEvaluationV2,
      );
  const attemptScopes = value.attempt_scopes === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(value.attempt_scopes)) {
          throw new Error("automatic build decision request attempt scopes are invalid");
        }
        const scopes = value.attempt_scopes.map((scope) => {
          if (!isRecord(scope)) throw new Error("automatic build decision request attempt scope is invalid");
          exactKeys(scope, ["work_unit_id", "attempt_scope_digest"]);
          const workUnitId = boundedString(scope.work_unit_id, "attempt scope work_unit_id", 512);
          if (typeof scope.attempt_scope_digest !== "string" || !SHA256.test(scope.attempt_scope_digest)) {
            throw new Error("automatic build decision request attempt scope digest is invalid");
          }
          return { work_unit_id: workUnitId, attempt_scope_digest: scope.attempt_scope_digest };
        });
        if (scopes.some((scope, index) => index > 0
          && scopes[index - 1].work_unit_id >= scope.work_unit_id)) {
          throw new Error("automatic build decision request attempt scopes are not canonical");
        }
        return scopes;
      })();
  const retryBoundaries = value.retry_boundaries === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(value.retry_boundaries)) {
          throw new Error("automatic build decision request retry boundaries are invalid");
        }
        const boundaries = value.retry_boundaries.map((entry) => {
          if (!isRecord(entry)) throw new Error("automatic build decision request retry boundary is invalid");
          exactKeys(entry, [
            "work_unit_id",
            "version",
            "attempt_scope_digest",
            "exhausted_semantic_attempt",
            "terminal_receipt_sha256",
            "diagnostic_digest",
            "required_recovery",
          ]);
          const workUnitId = boundedString(entry.work_unit_id, "retry boundary work_unit_id", 512);
          const boundary = validateAutomaticBuildRetryBoundary({
            version: entry.version,
            attempt_scope_digest: entry.attempt_scope_digest,
            exhausted_semantic_attempt: entry.exhausted_semantic_attempt,
            terminal_receipt_sha256: entry.terminal_receipt_sha256,
            diagnostic_digest: entry.diagnostic_digest,
            required_recovery: entry.required_recovery,
          });
          return { work_unit_id: workUnitId, ...boundary };
        });
        if (boundaries.some((boundary, index) => index > 0
          && boundaries[index - 1].work_unit_id >= boundary.work_unit_id)) {
          throw new Error("automatic build decision request retry boundaries are not canonical");
        }
        return boundaries;
      })();
  if (value.projection !== undefined && !isRecord(value.projection)) {
    throw new Error("automatic build decision request projection is invalid");
  }
  const record: AutomaticBuildDecisionRequestRecordV1 = {
    version: value.version,
    invocation_ref: value.invocation_ref,
    request_id: requestId,
    reason: value.reason as AutomaticBuildUserDecisionReasonV1,
    internal_reason: value.internal_reason,
    state,
    ...(stage ? { stage } : {}),
    ...(value.projection ? {
      projection: value.projection as unknown as AutomaticBuildUserDecisionProjectionV1,
    } : {}),
    ...(planBudgetEvidence ? {
      plan_budget_evidence: planBudgetEvidence,
    } : {}),
    ...(attemptScopes ? { attempt_scopes: attemptScopes } : {}),
    ...(retryBoundaries ? { retry_boundaries: retryBoundaries } : {}),
    choices,
  };
  const expected = `abreq1_${sha256({
    version: "automatic_build_decision_request_identity.v1",
    invocation_ref: record.invocation_ref,
    reason: record.reason,
    internal_reason: record.internal_reason,
    state: record.state,
    stage: record.stage ?? null,
    projection: record.projection ?? null,
    plan_budget_evidence: record.plan_budget_evidence ?? null,
    attempt_scopes: record.attempt_scopes ?? null,
    retry_boundaries: record.retry_boundaries ?? null,
    choices: record.choices,
  })}`;
  if (expected !== requestId) throw new Error("automatic build decision request digest is invalid");
  return record;
}

function persistDecisionReceipt(
  invocation: AutomaticBuildInvocationRecordV1,
  request: AutomaticBuildDecisionRequestRecordV1,
  choiceId: string,
  appliedState: DriverStateIdentityV1 = request.state,
): void {
  const receipt: AutomaticBuildDecisionReceiptV1 = {
    version: "automatic_build_decision_receipt.v1",
    invocation_ref: invocation.invocation_ref,
    request_id: request.request_id,
    choice_id: choiceId,
    state: appliedState,
  };
  writeCreateOnly(decisionReceiptPath(invocation.invocation_ref, request.request_id), receipt);
}

function decisionReceiptPath(invocationRef: string, requestId: string): string {
  if (!INVOCATION_REF.test(invocationRef) || !REQUEST_ID.test(requestId)) {
    throw new Error("automatic build decision receipt identity is invalid");
  }
  return recordFile(path.join("decisions", invocationRef), requestId);
}

function readDecisionReceipt(
  invocation: AutomaticBuildInvocationRecordV1,
  requestId: string,
): AutomaticBuildDecisionReceiptV1 | undefined {
  const file = decisionReceiptPath(invocation.invocation_ref, requestId);
  if (!existsSync(file)) return undefined;
  const value = readJsonRecord(file);
  if (!isRecord(value)) throw new Error("automatic build decision receipt is invalid");
  exactKeys(value, ["version", "invocation_ref", "request_id", "choice_id", "state"]);
  if (value.version !== "automatic_build_decision_receipt.v1"
    || value.invocation_ref !== invocation.invocation_ref
    || value.request_id !== requestId
    || typeof value.choice_id !== "string"
    || !isRecord(value.state)) {
    throw new Error("automatic build decision receipt identity is invalid");
  }
  exactKeys(
    value.state,
    ["build_plan_digest"],
    ["descriptor_plan_digest", "preflight_evaluation"],
  );
  if (typeof value.state.build_plan_digest !== "string" || !SHA256.test(value.state.build_plan_digest)
    || (value.state.descriptor_plan_digest !== undefined
      && (typeof value.state.descriptor_plan_digest !== "string"
        || !SHA256.test(value.state.descriptor_plan_digest)))) {
    throw new Error("automatic build decision receipt state identity is invalid");
  }
  return {
    version: value.version,
    invocation_ref: value.invocation_ref,
    request_id: value.request_id,
    choice_id: value.choice_id,
    state: {
      build_plan_digest: value.state.build_plan_digest,
      ...(typeof value.state.descriptor_plan_digest === "string"
        ? { descriptor_plan_digest: value.state.descriptor_plan_digest }
        : {}),
      ...(value.state.preflight_evaluation !== undefined
        ? { preflight_evaluation: validatePreflightEvaluationEvidence(value.state.preflight_evaluation) }
        : {}),
    },
  };
}

function effectForAcceptedBoundary(
  invocation: AutomaticBuildInvocationRecordV1,
  boundary: DecisionBoundaryV1,
): DecisionEffect | undefined {
  if (boundary.reason !== "budget_exceeded"
    && boundary.reason !== "low_confidence_wall_budget"
    && boundary.reason !== "wall_budget_exceeded") {
    return undefined;
  }
  const choices = choicesFor(boundary.reason);
  const requestId = requestIdFor(invocation, boundary, choices);
  const receipt = readDecisionReceipt(invocation, requestId);
  if (!receipt || !choices.some((choice) => choice.choice_id === receipt.choice_id)
    || canonicalAutomaticBuildJson(receipt.state) !== canonicalAutomaticBuildJson(boundary.state)) {
    return undefined;
  }
  return {
    ...(boundary.reason === "budget_exceeded" ? { bypass_budget: true as const } : {}),
    ...(boundary.plan_budget_evidence ? {
      accepted_plan_budget_evidence: boundary.plan_budget_evidence,
    } : {}),
    ...(boundary.reason === "low_confidence_wall_budget" || boundary.reason === "wall_budget_exceeded"
      ? { bypass_wall_budget: true as const }
      : {}),
  };
}

function currentAttemptScopeDigest(
  current: DriverState,
  stage: AutomaticBuildStage,
  workUnitId: string,
): string | undefined {
  const stageState = current.plan_result.snapshot.stages.find((candidate) => candidate.stage === stage);
  const descriptor = stageState?.work_units?.find((unit) => unit.work_unit_id === workUnitId);
  const binding = stageState?.task_bindings?.[workUnitId];
  if (!descriptor
    || (descriptor.version !== "automatic_build_work_unit.v3"
      && descriptor.version !== "automatic_build_work_unit.v4")
    || !binding
    || !isAutomaticBuildTaskPolicyBindingV2(binding)) return undefined;
  return createAutomaticBuildAttemptScope({
    target_ref: descriptor.target,
    stage: descriptor.stage,
    work_unit_id: descriptor.work_unit_id,
    task_binding: binding,
  }).attempt_scope_digest;
}

function retryAttemptScopeChanged(
  request: AutomaticBuildDecisionRequestRecordV1,
  current: DriverState,
): boolean {
  if ((request.reason !== "retry_exhausted" && request.reason !== "executor_instability")
    || !request.attempt_scopes?.length
    || !request.stage) return false;
  let changed = false;
  for (const previous of request.attempt_scopes) {
    const currentScopeDigest = currentAttemptScopeDigest(current, request.stage, previous.work_unit_id);
    if (!currentScopeDigest) return false;
    changed ||= currentScopeDigest !== previous.attempt_scope_digest;
  }
  return changed;
}

function retryBoundaryMatches(
  left: AutomaticBuildRetryBoundaryV1,
  right: AutomaticBuildRetryBoundaryV1,
): boolean {
  return left.version === right.version
    && left.attempt_scope_digest === right.attempt_scope_digest
    && left.exhausted_semantic_attempt === right.exhausted_semantic_attempt
    && left.terminal_receipt_sha256 === right.terminal_receipt_sha256
    && left.diagnostic_digest === right.diagnostic_digest
    && left.required_recovery === right.required_recovery;
}

function unresolvedRetryResponse(
  request: AutomaticBuildDecisionRequestRecordV1,
  reason: "plan_changed" | "recovery_not_satisfied",
): AutomaticBuildStepResponseV1 {
  return finalizeResponse({
    version: "automatic_build_step.v1",
    action: {
      kind: "NEEDS_USER",
      request_id: request.request_id,
      reason,
      message: userMessage(reason),
      choices: reason === "recovery_not_satisfied" ? request.choices : [],
      ...(request.projection ? { projection: request.projection } : {}),
    },
  });
}

type PreparedRetryRecovery = {
  target: ReturnType<typeof resolveAutomaticBuildTarget>;
  input: Parameters<typeof prepareAutomaticBuildRetryRecovery>[1];
};

function prepareRetryRecoveries(
  invocation: AutomaticBuildInvocationRecordV1,
  request: AutomaticBuildDecisionRequestRecordV1,
  current: DriverState,
): { status: "ready"; recoveries: PreparedRetryRecovery[] }
  | { status: "stale" | "not_satisfied" } {
  if (request.reason !== "retry_exhausted" || !request.stage || !request.retry_boundaries?.length) {
    return { status: "not_satisfied" };
  }
  const target = resolveAutomaticBuildTarget(invocation.input.target_input, invocation.input.root_dir);
  const recoveries: PreparedRetryRecovery[] = [];
  for (const previous of request.retry_boundaries) {
    const currentScopeDigest = currentAttemptScopeDigest(current, request.stage, previous.work_unit_id);
    if (!currentScopeDigest || currentScopeDigest !== previous.attempt_scope_digest) {
      return { status: "stale" };
    }
    const currentBoundary = readAutomaticBuildRetryBoundary(
      target,
      request.stage,
      previous.work_unit_id,
      currentScopeDigest,
    );
    if (!currentBoundary || !retryBoundaryMatches(previous, currentBoundary)) {
      return { status: "stale" };
    }
    if (currentBoundary.required_recovery !== "authorize_transient_retry") {
      return { status: "not_satisfied" };
    }
    const input: Parameters<typeof prepareAutomaticBuildRetryRecovery>[1] = {
      ...currentBoundary,
      stage: request.stage,
      work_unit_id: previous.work_unit_id,
      decision_request_id: request.request_id,
      created_at: invocation.input.created_at,
    };
    prepareAutomaticBuildRetryRecovery(target, input);
    recoveries.push({ target, input });
  }
  return { status: "ready", recoveries };
}

function applyDecision(
  invocation: AutomaticBuildInvocationRecordV1,
  decision: NonNullable<AutomaticBuildStepRequestV1["decision"]>,
  current: DriverState,
): DecisionEffect | AutomaticBuildStepResponseV1 {
  const request = readDecisionRequest(decision.request_id);
  if (request.invocation_ref !== invocation.invocation_ref) {
    throw new Error("automatic build decision belongs to a different invocation");
  }
  const identity = stateIdentity(current);
  if (!request.choices.some((choice) => choice.choice_id === decision.choice_id)) {
    throw new Error("automatic build decision choice is not allowed");
  }
  const scopeChanged = decision.choice_id === "retry_current"
    && retryAttemptScopeChanged(request, current);
  if (!scopeChanged
    && (request.state.build_plan_digest !== identity.build_plan_digest
      || request.state.descriptor_plan_digest !== identity.descriptor_plan_digest)) {
    if (decision.choice_id === "retry_current") return unresolvedRetryResponse(request, "plan_changed");
    return issueBoundary(invocation, syntheticBoundary("plan_changed", "plan_changed", current));
  }
  if (!scopeChanged
    && !sameAutomaticBuildBudgetEvidence(
      request.state.preflight_evaluation,
      identity.preflight_evaluation,
    )) {
    const wallStatus = current.plan_result.preflight?.wall_clock.budget.status;
    const reason = wallStatus === "low_confidence" ? "low_confidence_wall_budget" : "wall_budget_exceeded";
    if (decision.choice_id === "retry_current") return unresolvedRetryResponse(request, "plan_changed");
    return issueBoundary(invocation, syntheticBoundary(reason, reason, current));
  }
  let retryRecoveries: PreparedRetryRecovery[] = [];
  if (decision.choice_id === "retry_current" && request.reason === "retry_exhausted" && !scopeChanged) {
    const prepared = prepareRetryRecoveries(invocation, request, current);
    if (prepared.status !== "ready") {
      return unresolvedRetryResponse(
        request,
        prepared.status === "stale" ? "plan_changed" : "recovery_not_satisfied",
      );
    }
    retryRecoveries = prepared.recoveries;
  }
  for (const recovery of retryRecoveries) {
    recordAutomaticBuildRetryRecovery(recovery.target, recovery.input);
  }
  persistDecisionReceipt(invocation, request, decision.choice_id, identity);
  if (request.reason === "plan_changed" || request.reason === "plan_confirmation_required") {
    authorizePlan(invocation, request.request_id, decision.choice_id, identity.build_plan_digest);
  }
  return {
    ...(request.reason === "budget_exceeded" ? { bypass_budget: true as const } : {}),
    ...(request.plan_budget_evidence ? {
      accepted_plan_budget_evidence: request.plan_budget_evidence,
    } : {}),
    ...(request.reason === "low_confidence_wall_budget" || request.reason === "wall_budget_exceeded"
      ? { bypass_wall_budget: true as const }
      : {}),
  };
}

function dispatchHandoffRefs(
  invocation: AutomaticBuildInvocationRecordV1,
  dispatches: unknown,
): Array<{ opaque_handoff_ref: string }> {
  if (!Array.isArray(dispatches) || !dispatches.length) {
    throw new Error("automatic build dispatch action has no dispatches");
  }
  return dispatches.map((value) => {
    if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.executor_handoff)) {
      throw new Error("automatic build dispatch action is invalid");
    }
    const stage = safeStage(value.manifest.stage);
    const dispatchId = boundedString(value.manifest.dispatch_id, "dispatch_id", 512);
    const dispatchRunId = boundedString(value.dispatch_run_id, "dispatch_run_id", 512);
    const handoffDigest = value.executor_handoff.sha256;
    const opaqueHandoffRef = value.opaque_handoff_ref;
    if (!stage || typeof handoffDigest !== "string" || !SHA256.test(handoffDigest)) {
      throw new Error("automatic build dispatch identity is invalid");
    }
    if (typeof opaqueHandoffRef !== "string" || !HANDOFF_REF.test(opaqueHandoffRef)) {
      throw new Error("automatic build handoff ref is invalid");
    }
    const projection: AutomaticBuildDriverHandoffProjectionV1 = {
      version: "automatic_build_driver_handoff_projection.v1",
      invocation_ref: invocation.invocation_ref,
      opaque_handoff_ref: opaqueHandoffRef,
      dispatch_identity: {
        stage,
        dispatch_id: dispatchId,
        dispatch_run_id: dispatchRunId,
        handoff_digest: handoffDigest,
      },
    };
    writeCreateOnly(recordFile(
      path.join("handoff-projections", invocation.invocation_ref),
      opaqueHandoffRef,
    ), projection);
    const dispatchProjection: AutomaticBuildDriverDispatchProjectionV1 = {
      version: "automatic_build_driver_dispatch_projection.v1",
      invocation_ref: invocation.invocation_ref,
      dispatch_id: dispatchId,
      dispatch_run_id: dispatchRunId,
      opaque_handoff_ref: opaqueHandoffRef,
    };
    writeCreateOnly(
      recordFile(
        path.join("dispatch-projections", invocation.invocation_ref),
        sha256({ dispatch_id: dispatchId, dispatch_run_id: dispatchRunId }),
      ),
      dispatchProjection,
    );
    return { opaque_handoff_ref: opaqueHandoffRef };
  });
}

function replayDispatchHandoffRefs(
  invocation: AutomaticBuildInvocationRecordV1,
  activeDispatchIdsValue: unknown,
): Array<{ opaque_handoff_ref: string }> | undefined {
  if (!Array.isArray(activeDispatchIdsValue) || !activeDispatchIdsValue.length) return undefined;
  const activeDispatchIds = activeDispatchIdsValue.map((value) => boundedString(
    value,
    "active_dispatch_id",
    512,
  ));
  const directory = path.join(registryRoot(), "dispatch-projections", invocation.invocation_ref);
  if (!existsSync(directory)) return undefined;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("automatic build dispatch projection directory is invalid");
  }
  const realDirectory = realpathSync(directory);
  const root = registryRoot();
  if (!staysWithin(root, realDirectory)) {
    throw new Error("automatic build dispatch projection directory escapes registry root");
  }
  const entries = readdirSync(realDirectory, { withFileTypes: true });
  if (entries.length > 512 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("automatic build dispatch projection directory is invalid");
  }
  const active = new Set(activeDispatchIds);
  const latest = new Map<string, AutomaticBuildDriverDispatchProjectionV1>();
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      throw new Error("automatic build dispatch projection filename is invalid");
    }
    const value = readJsonRecord(path.join(realDirectory, entry.name));
    if (!isRecord(value)) throw new Error("automatic build dispatch projection is invalid");
    exactKeys(value, [
      "version",
      "invocation_ref",
      "dispatch_id",
      "dispatch_run_id",
      "opaque_handoff_ref",
    ]);
    if (value.version !== "automatic_build_driver_dispatch_projection.v1"
      || value.invocation_ref !== invocation.invocation_ref
      || typeof value.dispatch_id !== "string"
      || typeof value.dispatch_run_id !== "string"
      || typeof value.opaque_handoff_ref !== "string"
      || !HANDOFF_REF.test(value.opaque_handoff_ref)) {
      throw new Error("automatic build dispatch projection identity is invalid");
    }
    if (entry.name !== `${sha256({
      dispatch_id: value.dispatch_id,
      dispatch_run_id: value.dispatch_run_id,
    })}.json`) {
      throw new Error("automatic build dispatch projection digest is invalid");
    }
    if (!active.has(value.dispatch_id)) continue;
    const candidate = value as unknown as AutomaticBuildDriverDispatchProjectionV1;
    const current = latest.get(candidate.dispatch_id);
    if (!current || candidate.dispatch_run_id.localeCompare(current.dispatch_run_id) > 0) {
      latest.set(candidate.dispatch_id, candidate);
    }
  }
  if (activeDispatchIds.some((dispatchId) => !latest.has(dispatchId))) return undefined;
  return activeDispatchIds.map((dispatchId) => ({
    opaque_handoff_ref: latest.get(dispatchId)!.opaque_handoff_ref,
  }));
}

function reissueActiveDispatchHandoffRefs(
  invocation: AutomaticBuildInvocationRecordV1,
  stageValue: unknown,
  activeDispatchIdsValue: unknown,
  dispatchRunIdValue: unknown,
  issuedAt: string,
): Array<{ opaque_handoff_ref: string }> {
  const stage = safeStage(stageValue);
  if (!stage || !Array.isArray(activeDispatchIdsValue) || !activeDispatchIdsValue.length) {
    throw new Error("automatic build active dispatch reissue input is invalid");
  }
  const dispatchRunId = boundedString(dispatchRunIdValue, "dispatch_run_id", 512);
  const activeDispatchIds = activeDispatchIdsValue.map((value) => boundedString(
    value,
    "active_dispatch_id",
    512,
  ));
  const target = resolveAutomaticBuildTarget(
    invocation.input.target_input,
    invocation.input.root_dir,
  );
  const dispatches = activeDispatchIds.map((dispatchId) => {
    const persisted = readAutomaticBuildDispatch(target, stage, dispatchId, dispatchRunId);
    if (persisted.manifest.stage !== stage
      || persisted.manifest.dispatch_id !== dispatchId
      || persisted.dispatch_run_id !== dispatchRunId) {
      throw new Error("automatic build durable dispatch identity changed during reissue");
    }
    const issued = issueAutomaticBuildOpaqueHandoff({
      target,
      kind: "public_dispatch",
      owner_identity: {
        version: "automatic_build_dispatch_owner_identity.v1",
        stage,
        dispatch_id: dispatchId,
        dispatch_run_id: dispatchRunId,
      },
      executor_handoff: persisted.executor_handoff,
      issued_at: issuedAt,
    });
    return {
      manifest: persisted.manifest,
      dispatch_run_id: persisted.dispatch_run_id,
      executor_handoff: persisted.executor_handoff,
      opaque_handoff_ref: issued.opaque_handoff_ref,
    };
  });
  return dispatchHandoffRefs(invocation, dispatches);
}

function readBoundedJsonWithin(rootInput: string, fileInput: string, label: string): unknown {
  const root = path.resolve(rootInput);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root is invalid`);
  }
  const realRoot = realpathSync.native(root);
  const file = path.resolve(fileInput);
  if (!staysWithin(root, file)) throw new Error(`${label} escapes its root`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  const real = realpathSync.native(file);
  if (!staysWithin(realRoot, real)) throw new Error(`${label} realpath escapes its root`);
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

function privateArtifactRootFromPlan(
  invocation: AutomaticBuildInvocationRecordV1,
  plan: BuildPlanV1,
): string {
  if (!plan.intent_id) throw new Error("private artifact BuildPlan has no intent identity");
  const planPath = path.resolve(invocation.input.build_plan_path);
  const plansDirectory = path.dirname(planPath);
  const bookDirectory = path.dirname(plansDirectory);
  const privateRoot = path.dirname(bookDirectory);
  if (path.basename(planPath) !== `${plan.plan_id}.json`
    || path.basename(plansDirectory) !== "plans"
    || path.basename(bookDirectory) !== plan.book_id) {
    throw new Error("private artifact BuildPlan path does not match its identity");
  }
  return privateRoot;
}

function privateArtifactWave(
  invocation: AutomaticBuildInvocationRecordV1,
  current: DriverState,
  availableAgentSlots: number,
  issuedAt: string,
): AutomaticBuildPrivateArtifactWaveV1 | undefined {
  const plan = current.plan;
  if (!plan.private_artifacts.length) return undefined;
  if (plan.recipe_id !== "goal_directed" || !plan.intent_id || !plan.intent_digest) {
    throw new Error("private artifact BuildPlan identity is invalid");
  }
  const target = resolveAutomaticBuildTarget(invocation.input.target_input, invocation.input.root_dir);
  const privateRoot = privateArtifactRootFromPlan(invocation, plan);
  const storedPlan = validateBuildPlanV1(readBoundedJsonWithin(
    privateRoot,
    invocation.input.build_plan_path,
    "private BuildPlan",
  ));
  if (canonicalAutomaticBuildJson(storedPlan) !== canonicalAutomaticBuildJson(plan)) {
    throw new Error("private BuildPlan changed while preparing artifact tasks");
  }
  const intentPath = path.join(privateRoot, plan.book_id, "intents", plan.intent_id, "intent.json");
  const intent = validateBuildIntentAny(readBoundedJsonWithin(
    privateRoot,
    intentPath,
    "private BuildIntent",
  ));
  if (intent.intent_id !== plan.intent_id
    || intent.book_id !== plan.book_id
    || intent.source_fingerprint !== plan.source_fingerprint
    || intent.content_profile.id !== target.profile_id
    || intent.status !== "confirmed") {
    throw new Error("private BuildIntent does not match the current BuildPlan and target");
  }
  const explicitSelection = adaptAutomaticBuildPrivateArtifactSelectionV3(intent, storedPlan);
  const availableLids = resolveAutomaticBuildTargetLids(target);
  const resolvedScopeLids = explicitSelection.intent.source_scope.whole_book
    ? [...availableLids]
    : [...explicitSelection.intent.source_scope.lids];
  let prepared: ReturnType<typeof prepareIntentArtifactMailboxes>;
  try {
    prepared = prepareIntentArtifactMailboxes({
      private_root: privateRoot,
      intent: explicitSelection.intent,
      plan: explicitSelection.plan,
      available_lids: availableLids,
      resolved_scope_lids: resolvedScopeLids,
      created_at: issuedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/retry limit reached/iu.test(message)) return { state: "retry_exhausted" };
    throw error;
  }
  if (!prepared.tasks.length) return { state: "complete" };
  const capacity = availableAgentSlots;
  if (capacity < 1) return { state: "waiting" };
  return {
    state: "spawn",
    executors: prepared.tasks.slice(0, capacity).map((task) => {
      const issued = issueAutomaticBuildOpaqueHandoff({
        target,
        kind: "private_artifact",
        private_root: privateRoot,
        task_path: task.task_path,
        issued_at: issuedAt,
      });
      return { opaque_handoff_ref: issued.opaque_handoff_ref };
    }),
  };
}

function collectForbiddenFields(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectForbiddenFields(item, found));
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ROOT_FIELDS.has(key)) found.push(key);
    collectForbiddenFields(child, found);
  }
  return found;
}

function finalizeResponse(response: AutomaticBuildStepResponseV1): AutomaticBuildStepResponseV1 {
  if (response.version !== "automatic_build_step.v1"
    || collectForbiddenFields(response).length
    || Buffer.byteLength(canonicalAutomaticBuildJson(response), "utf8") > MAX_STDIN_BYTES) {
    throw new Error("automatic build root response violates its boundary contract");
  }
  return response;
}

export function automaticBuildStep(inputValue: AutomaticBuildStepRequestV1): AutomaticBuildStepResponseV1 {
  const input = validateStepRequest(inputValue);
  const invocation = readInvocation(input.invocation_ref);
  let current = loadDriverState(invocation, input.available_agent_slots);
  let effect: DecisionEffect = {};
  if (input.decision) {
    const applied = applyDecision(invocation, input.decision, current);
    if ("version" in applied) return applied;
    effect = applied;
    current = loadDriverState(invocation, input.available_agent_slots, effect);
  }

  if (!isPlanAuthorized(invocation, current.plan.plan_digest)) {
    return issueBoundary(invocation, syntheticBoundary(
      "plan_changed",
      "invocation_build_plan_drift",
      current,
    ));
  }

  const doctor = automaticBuildProtocolDoctor(
    invocation.input.target_input,
    invocation.input.root_dir,
    {
      requested_workers: invocation.input.max_parallel,
      available_agent_slots: input.available_agent_slots,
      quality_profile: invocation.input.quality_profile,
      budget: effect.bypass_budget ? DEFAULT_AUTOMATIC_BUILD_BUDGET : invocation.input.budget,
      wall_budget: effect.bypass_wall_budget ? undefined : invocation.input.wall_budget,
      executor_provenance: invocation.input.executor_provenance,
      build_plan: current.plan,
    },
  );
  if (doctor.status !== "compatible") {
    return issueBoundary(invocation, syntheticBoundary(
      "installation_incompatible",
      "protocol_incompatible",
      current,
    ));
  }

  for (let transition = 0; transition < MAX_TRANSITIONS; transition += 1) {
    current = loadDriverState(invocation, input.available_agent_slots, effect);
    const planAction = current.plan_result.next_action;
    if (planAction.kind === "needs_user") {
      return issueBoundary(
        invocation,
        boundaryFromAction(planAction as unknown as Record<string, unknown>, stateIdentity(current)),
      );
    }
    const preflight = current.plan_result.preflight;
    const next = automaticBuildNext(
      invocation.input.target_input,
      invocation.input.root_dir,
      invocation.input.max_parallel,
      {
        owner: `automatic-build-driver:${invocation.invocation_ref}`,
        now: transitionNow(current, input.available_agent_slots, effect),
        quality_profile: invocation.input.quality_profile,
        budget: effect.bypass_budget ? DEFAULT_AUTOMATIC_BUILD_BUDGET : invocation.input.budget,
        wall_budget: effect.bypass_wall_budget ? undefined : invocation.input.wall_budget,
        executor_provenance: invocation.input.executor_provenance,
        available_agent_slots: input.available_agent_slots,
        accepted_plan_digest: preflight?.descriptor_plan_digest,
        accepted_evaluation_evidence: preflight
          ? automaticBuildPreflightEvaluationEvidence(preflight)
          : undefined,
        accepted_plan_budget_evidence: effect.accepted_plan_budget_evidence,
        executor_dispatches: true,
        build_plan: current.plan,
      },
    );
    const action = next.action as unknown as Record<string, unknown>;
    if (action.kind === "needs_user") {
      const boundary = boundaryFromAction(action, stateIdentity(current));
      const accepted = effectForAcceptedBoundary(invocation, boundary);
      if (accepted) {
        effect = { ...effect, ...accepted };
        continue;
      }
      return issueBoundary(invocation, boundary);
    }
    if (action.kind === "dispatch") {
      return finalizeResponse({
        version: "automatic_build_step.v1",
        action: {
          kind: "SPAWN_EXECUTORS",
          executors: dispatchHandoffRefs(invocation, action.dispatches),
        },
      });
    }
    if (action.kind === "waiting") {
      if (action.reason === "active_dispatches") {
        const replayed = replayDispatchHandoffRefs(invocation, action.active_dispatch_ids);
        const executors = replayed ?? reissueActiveDispatchHandoffRefs(
          invocation,
          action.stage,
          action.active_dispatch_ids,
          action.dispatch_run_id,
          transitionNow(current, input.available_agent_slots, effect),
        );
        return finalizeResponse({
          version: "automatic_build_step.v1",
          action: { kind: "SPAWN_EXECUTORS", executors },
        });
      }
      const waitReason = action.reason === "active_leases" ? "active_lease" : "active_executors";
      const retryAfter = typeof action.retry_after_ms === "number" && Number.isSafeInteger(action.retry_after_ms)
        ? Math.max(1, Math.min(action.retry_after_ms, 300_000))
        : 1_000;
      return finalizeResponse({
        version: "automatic_build_step.v1",
        action: { kind: "WAIT", reason: waitReason, retry_after_ms: retryAfter },
      });
    }
    if (action.kind === "close_stage") {
      const stage = safeStage(action.stage);
      if (!stage) throw new Error("automatic build close action stage is invalid");
      const outcome = runAutomaticBuildCloseStage(
        invocation.input.target_input,
        invocation.input.root_dir,
        stage,
        { quality_profile: invocation.input.quality_profile },
      ) as unknown as Record<string, unknown>;
      if (outcome.next === "replan") continue;
      const internalReason = typeof outcome.code === "string" ? outcome.code : "stage_close_postcondition_failed";
      return issueBoundary(invocation, {
        reason: externalReason(internalReason),
        internal_reason: internalReason,
        state: stateIdentity(current),
        stage,
        projection: { category: externalReason(internalReason), stage },
      });
    }
    if (action.kind === "done") {
      const privateWave = privateArtifactWave(
        invocation,
        current,
        input.available_agent_slots,
        transitionNow(current, input.available_agent_slots, effect),
      );
      if (privateWave?.state === "spawn") {
        return finalizeResponse({
          version: "automatic_build_step.v1",
          action: { kind: "SPAWN_EXECUTORS", executors: privateWave.executors },
        });
      }
      if (privateWave?.state === "waiting") {
        return finalizeResponse({
          version: "automatic_build_step.v1",
          action: { kind: "WAIT", reason: "backoff", retry_after_ms: 1_000 },
        });
      }
      if (privateWave?.state === "retry_exhausted") {
        return issueBoundary(invocation, syntheticBoundary(
          "retry_exhausted",
          "private_artifact_retry_exhausted",
          current,
        ));
      }
      return finalizeResponse({
        version: "automatic_build_step.v1",
        action: {
          kind: "DONE",
          summary: {
            status: "complete",
            completed_stages: current.plan.public_stage_closure.length,
          },
        },
      });
    }
    throw new Error("automatic build reducer received an unsupported internal action");
  }
  return finalizeResponse({
    version: "automatic_build_step.v1",
    action: { kind: "WAIT", reason: "backoff", retry_after_ms: 50 },
  });
}

export function runAutomaticBuildDriverCommand(value: unknown): unknown {
  if (!isRecord(value) || typeof value.version !== "string") {
    throw new Error("build.step requires a versioned JSON request");
  }
  if (value.version === "automatic_build_invocation_create.v1") {
    return createAutomaticBuildInvocation(value as unknown as AutomaticBuildInvocationCreateV1);
  }
  if (value.version === "automatic_build_step_request.v1") {
    return automaticBuildStep(value as unknown as AutomaticBuildStepRequestV1);
  }
  throw new Error("build.step request version is unsupported");
}

function readStdinRequest(): unknown {
  const bytes = readFileSync(0);
  if (!bytes.byteLength || bytes.byteLength > MAX_STDIN_BYTES || bytes.includes(0)) {
    throw new Error("build.step stdin is empty or exceeds its byte limit");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function isCommandEntrypoint(): boolean {
  return path.basename(process.argv[1] ?? "") === "automatic-build-driver.ts";
}

if (isCommandEntrypoint()) {
  try {
    process.stdout.write(`${canonicalAutomaticBuildJson(runAutomaticBuildDriverCommand(readStdinRequest()))}\n`);
  } catch {
    process.stderr.write("build.step failed; inspect deterministic build state for diagnostics\n");
    process.exitCode = 2;
  }
}
