import { createHash } from "node:crypto";
import {
  createAutomaticBuildStagePolicySet,
  type AutomaticBuildStagePolicySetV2,
} from "../../../src/automatic-build-policy-generation";
import { canonicalAutomaticBuildJson } from "../../../src/automatic-build-protocol";
import type { AutomaticBuildTarget } from "../../../src/build-orchestrator";
import { resolveContentProfile } from "../../../src/content-profile";
import { evaluateModelInputBudget } from "../../../src/model-input-budget";
import {
  automaticBuildExtractionPolicy,
  type AutomaticBuildTaskPolicyBindingV2,
  type ExtractionPolicyFingerprintV1,
} from "../../../src/semantic-artifact";
import {
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptorV3,
  taskPolicyBindingForWorkUnit,
  type WorkUnitDescriptorV3,
} from "../../../src/stage-work-unit";

export interface SyntheticAutomaticBuildAttemptScopeV1 {
  version: "automatic_build_attempt_scope.v1";
  target_ref: AutomaticBuildTarget["target_ref"];
  stage: "profile_sidecar";
  work_unit_id: string;
  task_binding: AutomaticBuildTaskPolicyBindingV2;
  attempt_scope_digest: string;
}

export interface ProfileSidecarPolicyScopeFixture {
  descriptor: WorkUnitDescriptorV3;
  scope_a: SyntheticAutomaticBuildAttemptScopeV1;
  scope_b: SyntheticAutomaticBuildAttemptScopeV1;
  replay: {
    v1: ProfileSidecarPolicyReplayGeneration;
    v2: ProfileSidecarPolicyReplayGeneration;
  };
}

export interface ProfileSidecarPolicyReplayGeneration {
  descriptor: WorkUnitDescriptorV3;
  policy_set: AutomaticBuildStagePolicySetV2;
  scope: SyntheticAutomaticBuildAttemptScopeV1;
}

export const PROFILE_SIDECAR_POLICY_V1_FIXTURE = {
  stage_policy_version: "profile_sidecar_policy.v1",
  prompt_sha256: "0a56b04e68fc4fc86ae292eb0a57f59d2c85bd9b27e61e7da2d3b5c503da297a",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function attemptScope(
  target: AutomaticBuildTarget,
  descriptor: WorkUnitDescriptorV3,
  taskBinding: AutomaticBuildTaskPolicyBindingV2,
): SyntheticAutomaticBuildAttemptScopeV1 {
  if (descriptor.stage !== "profile_sidecar") {
    throw new Error("synthetic attempt scope requires a profile_sidecar descriptor");
  }
  const identity = {
    target_ref: target.target_ref,
    stage: "profile_sidecar" as const,
    work_unit_id: descriptor.work_unit_id,
    task_binding: taskBinding,
  };
  return {
    version: "automatic_build_attempt_scope.v1",
    ...identity,
    attempt_scope_digest: sha256(canonicalAutomaticBuildJson(identity)),
  };
}

function descriptorForPolicy(
  target: AutomaticBuildTarget,
  policy: ExtractionPolicyFingerprintV1,
): WorkUnitDescriptorV3 {
  const evidence = "Synthetic profile-sidecar evidence.";
  const rendered = `PROFILE_SIDECAR_SYNTHETIC\n[LID 1.1]\n${evidence}\n`;
  const evaluated = evaluateModelInputBudget({
    rendered_input: rendered,
    router_version: policy.router_version,
    prompt_sha256: policy.prompt_sha256,
    stage_body_limit_tokens: 5_000,
    executor_context_floor_tokens: 8_192,
    prompt_reserve_tokens: 512,
    protocol_reserve_tokens: 256,
    output_reserve_tokens: 512,
    safety_margin_tokens: 256,
  });
  if (evaluated.status !== "within_limit") {
    throw new Error("synthetic profile-sidecar scope fixture exceeds its budget");
  }
  return createWorkUnitDescriptorV3({
    target: target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: "profile-sidecar-contract-drift",
    kind: "profile_sidecar_discourse",
    input_basis: {
      kind: "source_slices",
      slices: [{
        version: "model_input_slice.v1",
        source_fingerprint: target.target_ref.input_fingerprint,
        parent_lid: "1.1",
        ordinal: 0,
        core_span_utf16: { start: 0, end: evidence.length },
        context_span_utf16: { start: 0, end: evidence.length },
        boundary_kind: "whole_lid",
        core_sha256: sha256(evidence),
        context_sha256: sha256(evidence),
      }],
    },
    input_hash: evaluated.proof.rendered_input_sha256,
    input_budget_proof: evaluated.proof,
    policy_fingerprint: policy,
    evidence_lids: ["1.1"],
    cost: buildWorkUnitCostFromBudgetProof({
      rendered_input: rendered,
      proof: evaluated.proof,
      visible_lids: 1,
      expected_output_items: 1,
    }),
  });
}

function replayGeneration(
  target: AutomaticBuildTarget,
  descriptor: WorkUnitDescriptorV3,
  frozenAt: string,
): ProfileSidecarPolicyReplayGeneration {
  const policySet = createAutomaticBuildStagePolicySet({
    target_ref: target.target_ref,
    stage: "profile_sidecar",
    members: [{
      kind: "profile_sidecar_discourse",
      extractor: "profile-sidecar-extractor",
      policy_fingerprint: descriptor.policy_fingerprint,
    }],
    frozen_at: frozenAt,
  });
  const binding = taskPolicyBindingForWorkUnit(descriptor, policySet.policy_set_digest);
  return {
    descriptor,
    policy_set: policySet,
    scope: attemptScope(target, descriptor, binding),
  };
}

export function profileSidecarPolicyScopeFixture(
  target: AutomaticBuildTarget,
): ProfileSidecarPolicyScopeFixture {
  const currentPolicy = automaticBuildExtractionPolicy(
    "profile_sidecar",
    resolveContentProfile(target.target_ref.profile_id),
    "full",
  );
  const oldPolicy: ExtractionPolicyFingerprintV1 = {
    ...currentPolicy,
    ...PROFILE_SIDECAR_POLICY_V1_FIXTURE,
  };
  const descriptor = descriptorForPolicy(target, currentPolicy);
  const bindingA = taskPolicyBindingForWorkUnit(descriptor, sha256("synthetic-policy-scope-a"));
  const bindingB = taskPolicyBindingForWorkUnit(descriptor, sha256("synthetic-policy-scope-b"));
  return {
    descriptor,
    scope_a: attemptScope(target, descriptor, bindingA),
    scope_b: attemptScope(target, descriptor, bindingB),
    replay: {
      v1: replayGeneration(target, descriptorForPolicy(target, oldPolicy), "2026-08-10T00:00:00.000Z"),
      v2: replayGeneration(target, descriptor, "2026-08-11T00:00:00.000Z"),
    },
  };
}
