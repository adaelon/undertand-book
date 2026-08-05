import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_BUILD_RECOVERY_LIMITS,
  blockedAutomaticBuildRoute,
  canonicalAutomaticBuildRecoveryJson,
  createAutomaticBuildRecoveryEnvelope,
  parseAutomaticBuildRecoveryEnvelope,
  readyAutomaticBuildRoute,
} from "../src/automatic-build-recovery";

const target = {
  version: "build_target_ref.v2" as const,
  workspace_dir: "C:/private/library/.understand-book/secret-book",
  book_id: "secret-book",
  profile_id: "technical_learning" as const,
  input_fingerprint: "a".repeat(64),
};

function recoveryInput() {
  return {
    phase: "routing" as const,
    code: "model_input_unsplittable" as const,
    stage: "profile_sidecar" as const,
    target_ref: target,
    router_version: "profile_sidecar_semantic_units.v3",
    policy_digest: "b".repeat(64),
    affected_work_units: [{
      work_unit_id: "profile-discourse:1.7.2",
      evidence_lids: ["1.7.2"],
      estimated_tokens: 6_992,
      limit_tokens: 5_000,
    }],
    retryable: false,
    recovery_actions: ["upgrade_executor" as const],
  };
}

describe("BR7 automatic build recovery envelope", () => {
  it("builds a closed allowlisted envelope and emits stable canonical JSON", () => {
    const first = createAutomaticBuildRecoveryEnvelope(recoveryInput());
    const second = createAutomaticBuildRecoveryEnvelope(recoveryInput());

    expect(first).toEqual({
      version: "automatic_build_recovery.v1",
      phase: "routing",
      code: "model_input_unsplittable",
      stage: "profile_sidecar",
      target: {
        book_id: "secret-book",
        profile_id: "technical_learning",
        input_fingerprint: "a".repeat(64),
      },
      router_version: "profile_sidecar_semantic_units.v3",
      policy_digest: "b".repeat(64),
      affected_work_units: [{
        work_unit_id: "profile-discourse:1.7.2",
        evidence_lids: ["1.7.2"],
        estimated_tokens: 6_992,
        limit_tokens: 5_000,
      }],
      retryable: false,
      recovery_actions: ["upgrade_executor"],
    });
    expect(parseAutomaticBuildRecoveryEnvelope(first)).toEqual(first);
    expect(canonicalAutomaticBuildRecoveryJson(first)).toBe(
      canonicalAutomaticBuildRecoveryJson(second),
    );
    expect(canonicalAutomaticBuildRecoveryJson(first).endsWith("\n")).toBe(true);
    expect(canonicalAutomaticBuildRecoveryJson(first)).not.toContain("private/library");
  });

  it("rejects unknown enum values, unknown keys, private payloads, and oversized arrays", () => {
    const valid = createAutomaticBuildRecoveryEnvelope(recoveryInput());
    const prohibited = [
      "source_text",
      "candidate",
      "prompt",
      "raw_goal",
      "path",
      "stderr",
      "stack",
    ];
    for (const field of prohibited) {
      expect(() => parseAutomaticBuildRecoveryEnvelope({ ...valid, [field]: "private" }))
        .toThrow();
    }
    expect(() => parseAutomaticBuildRecoveryEnvelope({ ...valid, phase: "executor" })).toThrow();
    expect(() => parseAutomaticBuildRecoveryEnvelope({ ...valid, code: "raw_error" })).toThrow();
    expect(() => parseAutomaticBuildRecoveryEnvelope({
      ...valid,
      recovery_actions: ["run_raw_command"],
    })).toThrow();
    expect(() => parseAutomaticBuildRecoveryEnvelope({
      ...valid,
      affected_work_units: Array.from(
        { length: AUTOMATIC_BUILD_RECOVERY_LIMITS.max_affected_work_units + 1 },
        (_, index) => ({ work_unit_id: `unit-${index}`, evidence_lids: ["1.1"] }),
      ),
    })).toThrow();
    expect(() => parseAutomaticBuildRecoveryEnvelope({
      ...valid,
      affected_work_units: [{
        work_unit_id: "x".repeat(AUTOMATIC_BUILD_RECOVERY_LIMITS.max_string_bytes + 1),
        evidence_lids: ["1.1"],
      }],
    })).toThrow();
  });

  it("summarizes work-unit and LID overflow with only a count and digest", () => {
    const workUnitCount = AUTOMATIC_BUILD_RECOVERY_LIMITS.max_affected_work_units + 3;
    const lidCount = AUTOMATIC_BUILD_RECOVERY_LIMITS.max_evidence_lids_per_work_unit + 2;
    const envelope = createAutomaticBuildRecoveryEnvelope({
      ...recoveryInput(),
      affected_work_units: Array.from({ length: workUnitCount }, (_, index) => ({
        work_unit_id: `unit-${index}`,
        evidence_lids: Array.from({ length: lidCount }, (__, lidIndex) => `${index + 1}.${lidIndex + 1}`),
      })),
    });

    expect(envelope.affected_work_units).toHaveLength(
      AUTOMATIC_BUILD_RECOVERY_LIMITS.max_affected_work_units,
    );
    expect(envelope.omitted_affected_work_units).toEqual({
      count: 3,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(envelope.affected_work_units[0].evidence_lids).toHaveLength(
      AUTOMATIC_BUILD_RECOVERY_LIMITS.max_evidence_lids_per_work_unit,
    );
    expect(envelope.affected_work_units[0].omitted_evidence_lids).toEqual({
      count: 2,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(parseAutomaticBuildRecoveryEnvelope(envelope)).toEqual(envelope);
  });

  it("exposes only ready(value) or blocked(recovery) route states", () => {
    const recovery = createAutomaticBuildRecoveryEnvelope(recoveryInput());
    expect(readyAutomaticBuildRoute({ snapshot: "safe" })).toEqual({
      status: "ready",
      value: { snapshot: "safe" },
    });
    expect(blockedAutomaticBuildRoute(recovery)).toEqual({
      status: "blocked",
      recovery,
    });
  });
});
