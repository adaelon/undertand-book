export const AUTOMATIC_BUILD_PROTOCOL_V2 = "automatic_build_protocol.v2" as const;
export const AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1 = "automatic_build_protocol.v1" as const;
export const AUTOMATIC_BUILD_PRODUCTION_DEFAULT = AUTOMATIC_BUILD_PROTOCOL_V2;

export const AUTOMATIC_BUILD_RELEASE_V1 = {
  version: "automatic_build_release.v1" as const,
  production_default: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  legacy_protocol: AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
  max_workers: 3,
  candidate_handoff: "executor_owned_task_mailbox" as const,
  exact_usage_policy: "receipt_or_unknown" as const,
  legacy_policy: "explicit_legacy_resume_or_v2_rebuild" as const,
};
