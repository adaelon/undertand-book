import { createHash } from "node:crypto";
import { canonicalBuildJson } from "./build-intent";
import {
  blockedAutomaticBuildRoute,
  createAutomaticBuildRecoveryEnvelope,
  parseAutomaticBuildRecoveryEnvelope,
  readyAutomaticBuildRoute,
  type AutomaticBuildRecoveryEnvelopeV1,
  type AutomaticBuildRouteResult,
} from "./automatic-build-recovery";
import { verifyModelInputBudgetProof } from "./model-input-budget";
import {
  extractionPolicyDigest,
  type SemanticBuildStage,
} from "./semantic-artifact";
import {
  AutomaticBuildPolicyGenerationConflictError,
  recordAutomaticBuildPolicyMigration,
  type AutomaticBuildPolicyMigrationBlockReason,
} from "./automatic-build-policy-generation";
import {
  validateWorkUnitDescriptorV3,
  workUnitPlanDigest,
  type WorkUnitDescriptorV3,
} from "./stage-work-unit";
import type { BuildTargetRefV2 } from "./build-orchestrator";

export const SEMANTIC_AUTOMATIC_BUILD_STAGES = [
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
] as const satisfies readonly SemanticBuildStage[];

export interface AutomaticBuildShadowWorkUnitV1 {
  descriptor: WorkUnitDescriptorV3;
  rendered_input: string;
}

export interface AutomaticBuildShadowStageInputV1 {
  stage: SemanticBuildStage;
  work_units: AutomaticBuildShadowWorkUnitV1[];
  deterministic_skips: number;
  blocked_recovery?: AutomaticBuildRecoveryEnvelopeV1;
}

export interface AutomaticBuildShadowStageAuditV1 {
  stage: SemanticBuildStage;
  eligible_work_units: number;
  proof_valid_work_units: number;
  deterministic_skips: number;
  descriptor_plan_digest: string;
  router_versions: string[];
  policy_digests: string[];
}

export interface AutomaticBuildShadowRoutingAuditV1 {
  version: "automatic_build_shadow_routing_audit.v1";
  target: {
    book_id: string;
    profile_id: BuildTargetRefV2["profile_id"];
    input_fingerprint: string;
  };
  stages: AutomaticBuildShadowStageAuditV1[];
  eligible_work_units: number;
  proof_valid_work_units: number;
  deterministic_skips: number;
  audit_digest: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return canonicalBuildJson(left) === canonicalBuildJson(right);
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function validateStageSet(stages: AutomaticBuildShadowStageInputV1[]): void {
  if (stages.length !== SEMANTIC_AUTOMATIC_BUILD_STAGES.length) {
    throw new Error("shadow routing audit requires all six semantic stages");
  }
  for (const [index, expected] of SEMANTIC_AUTOMATIC_BUILD_STAGES.entries()) {
    if (stages[index]?.stage !== expected) {
      throw new Error(`shadow routing stages must use canonical order: expected ${expected} at ${index}`);
    }
  }
}

function migrationRecoveryCode(
  reason: AutomaticBuildPolicyMigrationBlockReason,
): AutomaticBuildRecoveryEnvelopeV1["code"] {
  if (reason === "budget_proof_invalid") return "budget_proof_invalid";
  if (reason === "model_input_unsplittable") return "model_input_unsplittable";
  if (reason === "policy_generation_conflict") return "policy_generation_conflict";
  return "policy_generation_migration_required";
}

function migrationRecoveryActions(
  reason: AutomaticBuildPolicyMigrationBlockReason,
): AutomaticBuildRecoveryEnvelopeV1["recovery_actions"] {
  if (reason === "model_input_unsplittable") return ["upgrade_executor"];
  if (reason === "budget_proof_invalid" || reason === "active_lease") return ["retry_plan"];
  return ["migrate_policy"];
}

/**
 * Persist one modeled migration decision, then immediately recompute the
 * shadow plan when no user authorization boundary changed.
 */
export function migrateAutomaticBuildPolicyAndReplan<T>(
  input: Parameters<typeof recordAutomaticBuildPolicyMigration>[0],
  replan: () => AutomaticBuildRouteResult<T>,
): AutomaticBuildRouteResult<T> {
  const current = input.current;
  const workUnit = current.route === "model" ? current.descriptor : current;
  const proof = current.route === "model"
    ? "execution_budget_proof" in current.descriptor
      ? current.descriptor.execution_budget_proof
      : current.descriptor.input_budget_proof
    : undefined;
  const policy = current.route === "model"
    ? current.descriptor.policy_fingerprint
    : current.policy_fingerprint;
  let migration: ReturnType<typeof recordAutomaticBuildPolicyMigration>;
  try {
    migration = recordAutomaticBuildPolicyMigration(input);
  } catch (error) {
    if (!(error instanceof AutomaticBuildPolicyGenerationConflictError)) throw error;
    return blockedAutomaticBuildRoute(createAutomaticBuildRecoveryEnvelope({
      phase: "migration",
      code: "policy_generation_conflict",
      stage: input.stage,
      target_ref: input.target.target_ref,
      router_version: policy.router_version,
      policy_digest: extractionPolicyDigest(policy),
      affected_work_units: [{
        work_unit_id: workUnit.work_unit_id,
        evidence_lids: current.route === "model"
          ? current.descriptor.evidence_lids
          : current.evidence_lids,
        ...(proof ? {
          estimated_tokens: proof.estimated_rendered_tokens,
          limit_tokens: proof.effective_body_limit_tokens,
        } : {}),
      }],
      retryable: false,
      recovery_actions: ["migrate_policy"],
    }));
  }
  if (migration.decision !== "blocked") return replan();
  return blockedAutomaticBuildRoute(createAutomaticBuildRecoveryEnvelope({
    phase: "migration",
    code: migrationRecoveryCode(migration.reason),
    stage: input.stage,
    target_ref: input.target.target_ref,
    router_version: policy.router_version,
    policy_digest: migration.current_policy_digest,
    affected_work_units: [{
      work_unit_id: workUnit.work_unit_id,
      evidence_lids: current.route === "model"
        ? current.descriptor.evidence_lids
        : current.evidence_lids,
      ...(proof ? {
        estimated_tokens: proof.estimated_rendered_tokens,
        limit_tokens: proof.effective_body_limit_tokens,
      } : {}),
    }],
    retryable: migration.retryable,
    recovery_actions: migrationRecoveryActions(migration.reason),
  }));
}

export function auditAutomaticBuildShadowRouting(input: {
  target_ref: BuildTargetRefV2;
  stages: AutomaticBuildShadowStageInputV1[];
  executor_context_window_tokens?: number;
}): AutomaticBuildRouteResult<AutomaticBuildShadowRoutingAuditV1> {
  validateStageSet(input.stages);
  if (input.executor_context_window_tokens !== undefined
    && (!Number.isSafeInteger(input.executor_context_window_tokens)
      || input.executor_context_window_tokens < 1)) {
    throw new Error("executor_context_window_tokens must be a positive safe integer");
  }
  const stageAudits: AutomaticBuildShadowStageAuditV1[] = [];
  for (const stage of input.stages) {
    nonNegativeSafeInteger(stage.deterministic_skips, `${stage.stage}.deterministic_skips`);
    if (stage.blocked_recovery) {
      const recovery = parseAutomaticBuildRecoveryEnvelope(stage.blocked_recovery);
      if (recovery.stage !== stage.stage) {
        throw new Error("shadow routing blocked recovery stage mismatch");
      }
      return blockedAutomaticBuildRoute(recovery);
    }
    const routerVersions = new Set<string>();
    const policyDigests = new Set<string>();
    let valid = 0;
    for (const unit of stage.work_units) {
      try {
        const descriptor = validateWorkUnitDescriptorV3(unit.descriptor);
        if (descriptor.stage !== stage.stage || !sameTarget(descriptor.target, input.target_ref)) {
          throw new Error("shadow work-unit identity does not match its stage or target");
        }
        const proof = verifyModelInputBudgetProof(unit.rendered_input, descriptor.input_budget_proof);
        if (proof.rendered_input_sha256 !== descriptor.input_hash) {
          throw new Error("shadow work-unit input hash does not match its proof");
        }
        if (input.executor_context_window_tokens !== undefined
          && input.executor_context_window_tokens < proof.executor_context_floor_tokens) {
          const selectedLimit = Math.min(
            proof.stage_body_limit_tokens,
            Math.max(
              0,
              input.executor_context_window_tokens
                - proof.prompt_reserve_tokens
                - proof.protocol_reserve_tokens
                - proof.output_reserve_tokens
                - proof.safety_margin_tokens,
            ),
          );
          return blockedAutomaticBuildRoute(createAutomaticBuildRecoveryEnvelope({
            phase: "preflight",
            code: "executor_context_too_small",
            stage: stage.stage,
            target_ref: input.target_ref,
            router_version: proof.router_version,
            policy_digest: extractionPolicyDigest(descriptor.policy_fingerprint),
            affected_work_units: [{
              work_unit_id: descriptor.work_unit_id,
              evidence_lids: descriptor.evidence_lids,
              estimated_tokens: proof.estimated_rendered_tokens,
              limit_tokens: selectedLimit,
            }],
            retryable: false,
            recovery_actions: ["upgrade_executor"],
          }));
        }
        routerVersions.add(proof.router_version);
        policyDigests.add(extractionPolicyDigest(descriptor.policy_fingerprint));
        valid += 1;
      } catch {
        const descriptor = unit.descriptor;
        return blockedAutomaticBuildRoute(createAutomaticBuildRecoveryEnvelope({
          phase: "preflight",
          code: "budget_proof_invalid",
          stage: stage.stage,
          target_ref: input.target_ref,
          ...(descriptor?.policy_fingerprint?.router_version
            ? { router_version: descriptor.policy_fingerprint.router_version }
            : {}),
          ...(descriptor?.policy_fingerprint
            ? { policy_digest: extractionPolicyDigest(descriptor.policy_fingerprint) }
            : {}),
          affected_work_units: descriptor ? [{
            work_unit_id: descriptor.work_unit_id,
            evidence_lids: descriptor.evidence_lids,
            estimated_tokens: descriptor.input_budget_proof?.estimated_rendered_tokens,
            limit_tokens: descriptor.input_budget_proof?.effective_body_limit_tokens,
          }] : [],
          retryable: false,
          recovery_actions: ["retry_plan"],
        }));
      }
    }
    const descriptors = stage.work_units.map((unit) => unit.descriptor);
    stageAudits.push({
      stage: stage.stage,
      eligible_work_units: descriptors.length,
      proof_valid_work_units: valid,
      deterministic_skips: stage.deterministic_skips,
      descriptor_plan_digest: workUnitPlanDigest(descriptors),
      router_versions: [...routerVersions].sort(),
      policy_digests: [...policyDigests].sort(),
    });
  }
  const identity = {
    version: "automatic_build_shadow_routing_audit.v1" as const,
    target: {
      book_id: input.target_ref.book_id,
      profile_id: input.target_ref.profile_id,
      input_fingerprint: input.target_ref.input_fingerprint,
    },
    stages: stageAudits,
    eligible_work_units: stageAudits.reduce((sum, stage) => sum + stage.eligible_work_units, 0),
    proof_valid_work_units: stageAudits.reduce((sum, stage) => sum + stage.proof_valid_work_units, 0),
    deterministic_skips: stageAudits.reduce((sum, stage) => sum + stage.deterministic_skips, 0),
  };
  return readyAutomaticBuildRoute({
    ...identity,
    audit_digest: sha256(canonicalBuildJson(identity)),
  });
}
