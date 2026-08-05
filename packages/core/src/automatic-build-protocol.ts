export const AUTOMATIC_BUILD_PROTOCOL_V2 = "automatic_build_protocol.v2" as const;
export const AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1 = "automatic_build_protocol.v2_dispatch" as const;
export const AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1 = "automatic_build_protocol.v1" as const;
export const AUTOMATIC_BUILD_PRODUCTION_DEFAULT = AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1;

export const AUTOMATIC_BUILD_ROUTING_RELEASE = {
  version: "automatic_build_routing_release.v1" as const,
  descriptor_generation: "automatic_build_work_unit.v3" as const,
  policy_set: "automatic_build_stage_policy_set.v2" as const,
  quality_report: "automatic_build_stage_quality_report.v2" as const,
  pass1_router: "pass1_model_slice.v1" as const,
  profile_sidecar_router: "profile_sidecar_discourse_map_reduce.v1" as const,
  new_claim_policy: "v3_only" as const,
  activated_at: "2026-08-04T00:00:00.000Z" as const,
};

export const AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1 = {
  stage_body_limit_tokens: 6_000,
  executor_context_floor_tokens: 8_192,
  prompt_reserve_tokens: 512,
  protocol_reserve_tokens: 256,
  output_reserve_tokens: 1_024,
  safety_margin_tokens: 256,
} as const;

export const AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1 = [
  {
    stage: "pass1",
    kind: "pass1_window",
    extractor: "pass1-local-extractor",
    prompt_name: "pass1-local-extractor.md",
    stage_policy_version: "pass1_policy.v1",
    router_version: "pass1_window.v1",
    prompt_sha256: "7f95eb6352042a9d37866488d71418f2a730e78eeedfdbdebe646cc912cb1330",
    schema_version: "pass1_output.v1",
  },
  {
    stage: "pass1",
    kind: "pass1_source_slice",
    extractor: "pass1-source-fragment-extractor",
    prompt_name: "pass1-source-fragment-extractor.md",
    stage_policy_version: "pass1_source_fragment_policy.v1",
    router_version: "pass1_model_slice.v1",
    prompt_sha256: "87889ca048baf6d31303650dfb953d58eb30d1a260d2ff448c6c3f41281d88eb",
    schema_version: "pass1_source_fragment_output.v1",
  },
  {
    stage: "pass1",
    kind: "pass1_lid_stitch",
    extractor: "pass1-lid-stitcher",
    prompt_name: "pass1-lid-stitcher.md",
    stage_policy_version: "pass1_lid_stitch_policy.v1",
    router_version: "pass1_model_slice.v1",
    prompt_sha256: "2c3d8e9e7c6813231d67de9fa768a98336d9ec670e5d8aee1a6cc2da9d5fbc1b",
    schema_version: "pass1_lid_stitch_output.v1",
  },
  {
    stage: "profile_sidecar",
    kind: "profile_sidecar_discourse",
    extractor: "profile-sidecar-extractor",
    prompt_name: "profile-sidecar-extractor.md",
    stage_policy_version: "profile_sidecar_policy.v1",
    router_version: "profile_sidecar_semantic_units.v2",
    prompt_sha256: "0a56b04e68fc4fc86ae292eb0a57f59d2c85bd9b27e61e7da2d3b5c503da297a",
    schema_version: "profile_sidecar_output.v2",
  },
  {
    stage: "profile_sidecar",
    kind: "profile_sidecar_discourse_fragment",
    extractor: "profile-sidecar-discourse-fragment-extractor",
    prompt_name: "profile-sidecar-discourse-fragment-extractor.md",
    stage_policy_version: "profile_sidecar_discourse_fragment_policy.v1",
    router_version: "profile_sidecar_discourse_map_reduce.v1",
    prompt_sha256: "6a55eab027ec04049bf01bcf3c6a9cd143a8f7023617230416449bac4f89f761",
    schema_version: "profile_sidecar_discourse_observation.v1",
  },
  {
    stage: "profile_sidecar",
    kind: "profile_sidecar_discourse_reduce",
    extractor: "profile-sidecar-discourse-reducer",
    prompt_name: "profile-sidecar-discourse-reducer.md",
    stage_policy_version: "profile_sidecar_discourse_reduce_policy.v1",
    router_version: "profile_sidecar_discourse_map_reduce.v1",
    prompt_sha256: "b411666b94c557eb3b9aad21f44285510fd39df0b7fb3ec53004f90208cb6703",
    schema_version: "profile_sidecar_discourse_reduce_output.v1",
  },
  {
    stage: "profile_sidecar",
    kind: "profile_sidecar_formula",
    extractor: "profile-sidecar-extractor",
    prompt_name: "profile-sidecar-extractor.md",
    stage_policy_version: "profile_sidecar_policy.v1",
    router_version: "profile_sidecar_semantic_units.v2",
    prompt_sha256: "0a56b04e68fc4fc86ae292eb0a57f59d2c85bd9b27e61e7da2d3b5c503da297a",
    schema_version: "profile_sidecar_output.v2",
  },
] as const;

export type AutomaticBuildClaimProtocol =
  | typeof AUTOMATIC_BUILD_PROTOCOL_V2
  | typeof AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalAutomaticBuildJson(value: unknown): string {
  return `${stableJson(value)}\n`;
}

export function resolveAutomaticBuildClaimProtocol(
  requested?: string,
  executorDispatchesAlias = false,
): AutomaticBuildClaimProtocol {
  if (requested && executorDispatchesAlias && requested !== AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1) {
    throw new Error("--executor-dispatches conflicts with the requested automatic-build protocol");
  }
  const protocol = requested
    ?? (executorDispatchesAlias ? AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1 : AUTOMATIC_BUILD_PRODUCTION_DEFAULT);
  if (protocol !== AUTOMATIC_BUILD_PROTOCOL_V2
    && protocol !== AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1) {
    throw new Error(`automatic-build claim protocol is not supported: ${protocol}`);
  }
  return protocol;
}

export const AUTOMATIC_BUILD_RELEASE_V1 = {
  version: "automatic_build_release.v1" as const,
  production_default: AUTOMATIC_BUILD_PROTOCOL_V2,
  parallel_dispatch_protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
  legacy_protocol: AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
  max_workers: 3,
  candidate_handoff: "executor_owned_task_mailbox" as const,
  exact_usage_policy: "receipt_or_unknown" as const,
  legacy_policy: "explicit_legacy_resume_or_v2_rebuild" as const,
};

export const AUTOMATIC_BUILD_RELEASE_V2 = {
  version: "automatic_build_release.v2" as const,
  production_default: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  new_claim_protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
  readable_protocols: [
    AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
    AUTOMATIC_BUILD_PROTOCOL_V2,
    AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
  ] as const,
  rollback: {
    protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
    artifact_migration: "none" as const,
    task_state_rewrite: "none" as const,
  },
  max_workers: 3,
  candidate_handoff: "executor_owned_task_mailbox" as const,
  exact_usage_policy: "receipt_or_unknown" as const,
  legacy_policy: "explicit_legacy_resume_or_v2_rebuild" as const,
};

export const AUTOMATIC_BUILD_RELEASE_V3 = {
  version: "automatic_build_release.v3" as const,
  production_default: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  new_claim_protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
  readable_protocols: [
    AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
    AUTOMATIC_BUILD_PROTOCOL_V2,
    AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
  ] as const,
  rollback: {
    protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
    artifact_migration: "none" as const,
    task_state_rewrite: "none" as const,
  },
  routing_release: AUTOMATIC_BUILD_ROUTING_RELEASE,
  model_work_unit: "automatic_build_work_unit.v3" as const,
  policy_set: "automatic_build_stage_policy_set.v2" as const,
  policy_migration_receipt: "automatic_build_policy_migration_receipt.v1" as const,
  recovery_envelope: "automatic_build_recovery.v1" as const,
  quality_report: "automatic_build_stage_quality_report.v2" as const,
  stage_batch_result: "automatic_build_stage_batch_result.v1" as const,
  close_result: "automatic_build_stage_close_result.v1" as const,
  close_success_next: "replan" as const,
  model_input: {
    render_contract: "model_input_render.v1" as const,
    estimator: "weighted_codepoint_estimator.v1" as const,
    budget: AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1,
  },
  release_policy_members: AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1,
  max_workers: 3,
  candidate_handoff: "executor_owned_task_mailbox" as const,
  exact_usage_policy: "receipt_or_unknown" as const,
  legacy_policy: "explicit_legacy_resume_or_v2_rebuild" as const,
  activated_at: "2026-08-05T00:00:00.000Z" as const,
};

export const AUTOMATIC_BUILD_ACTIVE_RELEASE = AUTOMATIC_BUILD_RELEASE_V3;
