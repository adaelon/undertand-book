export const AUTOMATIC_BUILD_PROTOCOL_V2 = "automatic_build_protocol.v2" as const;
export const AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1 = "automatic_build_protocol.v2_dispatch" as const;
export const AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1 = "automatic_build_protocol.v1" as const;
export const AUTOMATIC_BUILD_PRODUCTION_DEFAULT = AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1;

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
