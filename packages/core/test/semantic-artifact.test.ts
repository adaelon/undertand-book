import { describe, expect, it } from "vitest";
import { resolveContentProfile } from "../src/content-profile";
import type { BuildTargetRefV2 } from "../src/build-orchestrator";
import {
  automaticBuildExtractionPolicy,
  buildSemanticArtifactEnvelope,
  buildSemanticArtifactEnvelopeV3,
  semanticContractFromExtractionPolicy,
  semanticArtifactMatches,
} from "../src/semantic-artifact";

const TARGET: BuildTargetRefV2 = {
  version: "build_target_ref.v2",
  workspace_dir: "C:\\synthetic-book",
  book_id: "synthetic-book",
  profile_id: "technical_learning",
  input_fingerprint: "a".repeat(64),
};
const INPUT_HASH = "b".repeat(64);
const POLICY = automaticBuildExtractionPolicy(
  "pass1",
  resolveContentProfile("technical_learning"),
  "full",
);
const POLICY_GENERATION_ID = "pass1-window.full.v2";
const SEMANTIC_CONTRACT = semanticContractFromExtractionPolicy(POLICY);
const PROVENANCE = {
  executor: "codex-harness",
  model: "gpt-5.4-codex",
  attempt: 1,
  generated_at: "2026-08-30T00:00:00.000Z",
} as const;

function payload(label: string) {
  return {
    content_hash: INPUT_HASH,
    nodes: [{ id: `concept:${label}`, label }],
    edges: [],
  };
}

describe("H0 HERO semantic artifact hash utility contract", () => {
  it("keeps artifact payload identity because it selects the same snapshot and rejects changed or tampered bodies", () => {
    const first = buildSemanticArtifactEnvelope({
      target: TARGET,
      stage: "pass1",
      work_unit_id: "pass1-window-0",
      input_hash: INPUT_HASH,
      policy_fingerprint: POLICY,
      provenance: PROVENANCE,
      payload: payload("stable"),
    });
    const replay = buildSemanticArtifactEnvelope({
      target: TARGET,
      stage: "pass1",
      work_unit_id: "pass1-window-0",
      input_hash: INPUT_HASH,
      policy_fingerprint: POLICY,
      provenance: { ...PROVENANCE, attempt: 2 },
      payload: payload("stable"),
    });
    const changed = buildSemanticArtifactEnvelope({
      target: TARGET,
      stage: "pass1",
      work_unit_id: "pass1-window-0",
      input_hash: INPUT_HASH,
      policy_fingerprint: POLICY,
      provenance: PROVENANCE,
      payload: payload("changed"),
    });
    const expected = {
      target: TARGET,
      stage: "pass1" as const,
      work_unit_id: "pass1-window-0",
      input_hash: INPUT_HASH,
      semantic_contract: SEMANTIC_CONTRACT,
    };

    expect(replay.artifact_hash).toBe(first.artifact_hash);
    expect(changed.artifact_hash).not.toBe(first.artifact_hash);
    expect(semanticArtifactMatches(first, expected)).toBe(true);
    expect(semanticArtifactMatches({ ...first, payload: changed.payload }, expected)).toBe(false);
  });

  it("removes execution proof wrappers after direct input and semantic-contract mismatches already make the artifact stale", () => {
    const artifact = buildSemanticArtifactEnvelopeV3({
      target: TARGET,
      stage: "pass1",
      work_unit_id: "pass1-window-0",
      input_hash: INPUT_HASH,
      policy_generation_id: POLICY_GENERATION_ID,
      semantic_contract: SEMANTIC_CONTRACT,
      provenance: PROVENANCE,
      payload: payload("stable"),
    });
    const expected = {
      target: TARGET,
      stage: "pass1" as const,
      work_unit_id: "pass1-window-0",
      input_hash: INPUT_HASH,
      policy_generation_id: POLICY_GENERATION_ID,
      semantic_contract: SEMANTIC_CONTRACT,
    };

    expect(semanticArtifactMatches(artifact, expected)).toBe(true);
    expect(semanticArtifactMatches(artifact, {
      ...expected,
      input_hash: "e".repeat(64),
    })).toBe(false);
    expect(semanticArtifactMatches(artifact, {
      ...expected,
      semantic_contract: { ...SEMANTIC_CONTRACT, schema_version: "pass1_output.v2" },
    })).toBe(false);

    const forbidden = ["proof_digest", "policy_digest", "policy_set_digest"]
      .filter((field) => Object.hasOwn(artifact, field));
    expect(forbidden).toEqual([]);
    expect(artifact).toMatchObject({
      policy_generation_id: POLICY_GENERATION_ID,
      semantic_contract: SEMANTIC_CONTRACT,
    });
  });
});
