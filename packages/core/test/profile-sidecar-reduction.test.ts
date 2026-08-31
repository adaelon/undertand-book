import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LidNode } from "../src/generated/LidNode";
import {
  evaluateModelInputBudget,
  verifyModelInputBudgetProof,
  type ModelInputBudgetRequestV1,
} from "../src/model-input-budget";
import {
  renderProfileSidecarDiscourseFragmentModelInput,
  renderProfileSidecarModelInput,
} from "../src/model-input-renderer";
import type { RoutedModelInputSliceV1 } from "../src/model-input-slice";
import {
  PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION,
  PROFILE_SIDECAR_DISCOURSE_MAP_REDUCE_ROUTER_VERSION,
  PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN,
  PROFILE_SIDECAR_DISCOURSE_REDUCE_SCHEMA_VERSION,
  buildProfileSidecarDiscourseFragmentWorkUnits,
  parseProfileSidecarDiscourseFragmentObservation,
  parseProfileSidecarDiscourseReduceOutput,
  routeProfileSidecarDiscourseFragmentWorkUnits,
  routeProfileSidecarDiscourseReductionLevel,
  verifyProfileSidecarDiscourseShadowArtifact,
  type ProfileSidecarDiscourseObservationV1,
  type ProfileSidecarDiscourseShadowWorkUnitV1,
  type ProfileSidecarDiscourseVerifiedChildV1,
} from "../src/profile-sidecar-reduction";
import {
  buildSemanticArtifactEnvelopeV3,
  semanticContractFromExtractionPolicy,
  type ExtractionPolicyFingerprintV1,
  type SemanticArtifactEnvelopeV3,
} from "../src/semantic-artifact";
import { validateWorkUnitDescriptorV3 } from "../src/stage-work-unit";
import { createSyntheticRoutabilityFixture } from "./helpers/model-input-routability-fixture";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const BUDGET: Omit<ModelInputBudgetRequestV1, "rendered_input" | "router_version" | "prompt_sha256"> = {
  stage_body_limit_tokens: 5_000,
  executor_context_floor_tokens: 8_192,
  prompt_reserve_tokens: 512,
  protocol_reserve_tokens: 256,
  output_reserve_tokens: 1_024,
  safety_margin_tokens: 256,
};

function policy(
  role: "fragment" | "reduce",
  profileVersion = "technical_learning_v0",
): ExtractionPolicyFingerprintV1 {
  return {
    profile_id: "technical_learning",
    profile_version: profileVersion,
    stage_policy_version: `profile_sidecar_discourse_${role}_policy.v1`,
    router_version: PROFILE_SIDECAR_DISCOURSE_MAP_REDUCE_ROUTER_VERSION,
    prompt_sha256: sha256(`profile-sidecar-discourse-${role}-prompt.v1`),
    schema_version: role === "fragment"
      ? PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION
      : PROFILE_SIDECAR_DISCOURSE_REDUCE_SCHEMA_VERSION,
    quality_profile: "full",
  };
}

function observationFor(unit: ProfileSidecarDiscourseShadowWorkUnitV1): ProfileSidecarDiscourseObservationV1 {
  if (unit.route.role !== "fragment") throw new Error("expected a fragment work unit");
  const sourceSlice = unit.descriptor.input_basis.kind === "source_slices"
    ? unit.descriptor.input_basis.slices[0]
    : undefined;
  if (!sourceSlice) throw new Error("fragment descriptor is missing its source slice");
  return {
    version: "profile_sidecar_discourse_observation.v1",
    parent_lid: unit.route.parent_lid,
    source_slice_ordinal: unit.route.source_slice_range.start_ordinal,
    core_sha256: sourceSlice.core_sha256,
    mode_candidates: [{ value: "informative", confidence: 0.9 }],
    local_function_candidates: [{ value: "explanation", confidence: 0.8 }],
    rhetorical_move_candidates: [{ value: "concept_elaboration", confidence: 0.8 }],
    summary_fragments: [`Slice ${sourceSlice.ordinal} contributes bounded evidence.`],
    relation_candidates: [],
  };
}

function policyGenerationIdFor(unit: ProfileSidecarDiscourseShadowWorkUnitV1): string {
  return `profile-sidecar-${unit.descriptor.kind}-test-generation.v1`;
}

function envelopeFor(
  unit: ProfileSidecarDiscourseShadowWorkUnitV1,
): SemanticArtifactEnvelopeV3<unknown> {
  const payload = unit.route.role === "fragment"
    ? observationFor(unit)
    : unit.route.role === "reduce"
      ? {
          reduction: {
            version: "profile_sidecar_discourse_reduction.v1",
            parent_lid: unit.route.parent_lid,
            reducer_level: unit.route.reducer_level,
            source_slice_range: unit.route.source_slice_range,
            mode_candidates: [{ value: "informative", confidence: 0.9 }],
            local_function_candidates: [{ value: "explanation", confidence: 0.8 }],
            rhetorical_move_candidates: [{ value: "concept_elaboration", confidence: 0.8 }],
            summary_fragments: [`Reducer level ${unit.route.reducer_level} summary.`],
            relation_candidates: [],
          },
        }
      : {
          discourse_items: [{
            lid: unit.route.parent_lid,
            mode: "informative",
            local_function: "explanation",
            rhetorical_move: "concept_elaboration",
            local_summary: "One final item for the original paragraph LID.",
            relations: [],
          }],
        };
  return buildSemanticArtifactEnvelopeV3({
    target: unit.descriptor.target,
    stage: "profile_sidecar",
    work_unit_id: unit.descriptor.work_unit_id,
    input_hash: unit.descriptor.input_hash,
    policy_generation_id: policyGenerationIdFor(unit),
    semantic_contract: semanticContractFromExtractionPolicy(unit.descriptor.policy_fingerprint),
    provenance: {
      executor: "test",
      model: "codex-test",
      attempt: 1,
      generated_at: "2026-08-03T00:00:00.000Z",
    },
    payload,
  });
}

function verifiedChild(
  unit: ProfileSidecarDiscourseShadowWorkUnitV1,
): ProfileSidecarDiscourseVerifiedChildV1 {
  return verifyProfileSidecarDiscourseShadowArtifact({
    work_unit: unit,
    artifact: envelopeFor(unit),
    policy_generation_id: policyGenerationIdFor(unit),
  });
}

function preparedFragmentUnits(count: number): {
  parent: LidNode;
  units: ProfileSidecarDiscourseShadowWorkUnitV1[];
} {
  const fixture = createSyntheticRoutabilityFixture(32);
  const source = "x".repeat(count);
  const parent: LidNode = {
    lid: "1.1",
    path: [1, 1],
    kind: "paragraph",
    span: { start: 0, end: source.length },
    children: [],
  };
  const sourceFingerprint = sha256(source);
  const routedSlices: RoutedModelInputSliceV1[] = Array.from({ length: count }, (_, ordinal) => {
    const core = source.slice(ordinal, ordinal + 1);
    const renderContext = {
      version: "model_input_slice_render_context.v1" as const,
      parent_lid: parent.lid,
      ordinal,
      boundary_kind: "grapheme" as const,
      core_span_utf16: { start: ordinal, end: ordinal + 1 },
      context_span_utf16: { start: ordinal, end: ordinal + 1 },
      context_before: "",
      core,
      context_after: "",
    };
    const renderedInput = renderProfileSidecarDiscourseFragmentModelInput({
      content_profile_id: "technical_learning",
      ...renderContext,
    });
    const evaluated = evaluateModelInputBudget({
      ...BUDGET,
      rendered_input: renderedInput,
      router_version: policy("fragment").router_version,
      prompt_sha256: policy("fragment").prompt_sha256,
    });
    if (evaluated.status !== "within_limit") throw new Error("synthetic fragment should fit its budget");
    return {
      slice: {
        version: "model_input_slice.v1",
        source_fingerprint: sourceFingerprint,
        parent_lid: parent.lid,
        ordinal,
        core_span_utf16: { start: ordinal, end: ordinal + 1 },
        context_span_utf16: { start: ordinal, end: ordinal + 1 },
        boundary_kind: "grapheme",
        core_sha256: sha256(core),
        context_sha256: sha256(core),
      },
      rendered_input: renderedInput,
      proof: evaluated.proof,
    };
  });
  const built = buildProfileSidecarDiscourseFragmentWorkUnits({
    target: fixture.target.target_ref,
    source,
    source_fingerprint: sourceFingerprint,
    parent,
    routed_slices: routedSlices,
    policy: policy("fragment"),
  });
  return { parent, units: built.units };
}

function replayTree(
  count: number,
  reverseChildren = false,
  prepared = preparedFragmentUnits(count),
): {
  levelCounts: number[];
  levels: ProfileSidecarDiscourseShadowWorkUnitV1[][];
} {
  const { parent, units } = prepared;
  let children = units.map(verifiedChild);
  if (reverseChildren) children = [...children].reverse();
  const levels: ProfileSidecarDiscourseShadowWorkUnitV1[][] = [];
  while (true) {
    const routed = routeProfileSidecarDiscourseReductionLevel({
      target: units[0].descriptor.target,
      parent_lid: parent.lid,
      fragment_count: count,
      children,
      policy: policy("reduce"),
      budget: BUDGET,
    });
    if (routed.status !== "routed") throw new Error("bounded reducer level should fit its budget");
    levels.push(routed.units);
    if (routed.units.length === 1 && routed.units[0].route.role === "final") break;
    children = routed.units.map(verifiedChild);
  }
  return { levelCounts: levels.map((level) => level.length), levels };
}

describe("profile sidecar dormant fragment/reduce routing", () => {
  it("keeps the existing whole-unit renderer byte-identical and freezes the synthetic source/LID identity", () => {
    const existing = renderProfileSidecarModelInput({
      work_unit_id: "discourse-1-1",
      unit_kind: "profile_sidecar_discourse",
      visible_lids: ["1.1"],
      formula_lids: [],
      text: "[1.1] Body",
    });
    expect(Buffer.byteLength(existing, "utf8")).toBe(151);
    expect(existing.endsWith("\n")).toBe(true);
    expect(sha256(existing)).toBe("c24ebdb992895e4c93fac2a7895314be0e2dcd9e9b324b529f465bbcf17c146b");

    const fixture = createSyntheticRoutabilityFixture();
    expect(fixture.identity).toEqual({
      source_sha256: "91d634d678f2010a7b70eb7d9f50456db43a8b9364da57a3ade6394d487e1bf4",
      source_blocks_sha256: "ce7d1611405e8d35ba3703de7e9cb900e556e4c0ccfcd4b4e172251d6040ac21",
      lid_tree_sha256: "c6ce598a01da15d5cc38a8a7c578358f9f8da1c343ddafa7f2c8ca2bdfb5d142",
      lid_spans_sha256: "fd844c6476da6d5912bef40b31d1f8878a152b418a28c287b7a004a5d35cc3a5",
    });
  });

  it("routes the 6,992-token paragraph into proof-bound dormant fragment descriptors without mutating source/LIDs", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const parent = fixture.by_lid.get(fixture.paragraph_lid)!;
    const before = JSON.stringify({
      source: fixture.source,
      blocks: fixture.blocks,
      nodes: fixture.lid_nodes,
    });
    const first = routeProfileSidecarDiscourseFragmentWorkUnits({
      target: fixture.target.target_ref,
      source: fixture.source,
      source_fingerprint: fixture.identity.source_sha256,
      parent,
      content_profile_id: "technical_learning",
      policy: policy("fragment"),
      budget: BUDGET,
      context_overlap_utf16: 64,
    });
    const second = routeProfileSidecarDiscourseFragmentWorkUnits({
      target: fixture.target.target_ref,
      source: fixture.source,
      source_fingerprint: fixture.identity.source_sha256,
      parent,
      content_profile_id: "technical_learning",
      policy: policy("fragment"),
      budget: BUDGET,
      context_overlap_utf16: 64,
    });
    expect(first.status).toBe("routed");
    expect(second).toEqual(first);
    if (first.status !== "routed") throw new Error("synthetic paragraph should be fragment-routable");
    expect(first.units.length).toBeGreaterThan(1);
    expect(first.coverage.gap_utf16).toBe(0);
    expect(first.coverage.core_overlap_utf16).toBe(0);
    for (const unit of first.units) {
      expect(validateWorkUnitDescriptorV3(unit.descriptor)).toBe(unit.descriptor);
      expect(unit.descriptor.kind).toBe("profile_sidecar_discourse_fragment");
      expect(unit.descriptor.aggregation).toEqual({ parent_lid: parent.lid, role: "fragment" });
      expect(verifyModelInputBudgetProof(unit.rendered_input, unit.descriptor.input_budget_proof))
        .toBe(unit.descriptor.input_budget_proof);
    }
    expect(JSON.stringify({ source: fixture.source, blocks: fixture.blocks, nodes: fixture.lid_nodes })).toBe(before);
  });

  it("enforces bounded closed fragment and role-specific reduce/final schemas", () => {
    const validObservation: ProfileSidecarDiscourseObservationV1 = {
      version: "profile_sidecar_discourse_observation.v1",
      parent_lid: "1.1",
      source_slice_ordinal: 0,
      core_sha256: sha256("core"),
      mode_candidates: [{ value: "informative", confidence: 0.9 }],
      local_function_candidates: [],
      rhetorical_move_candidates: [],
      summary_fragments: ["Bounded observation."],
      relation_candidates: [],
    };
    const fragmentContext = {
      parent_lid: "1.1",
      source_slice_ordinal: 0,
      core_sha256: sha256("core"),
      allowed_evidence_lids: ["1.1"],
    };
    expect(parseProfileSidecarDiscourseFragmentObservation(validObservation, fragmentContext))
      .toEqual(validObservation);
    expect(() => parseProfileSidecarDiscourseFragmentObservation(
      { ...validObservation, raw_source: "forbidden" },
      fragmentContext,
    )).toThrow(/schema/i);
    expect(() => parseProfileSidecarDiscourseFragmentObservation(
      { discourse_items: [{ lid: "1.1", mode: "informative", relations: [] }] },
      fragmentContext,
    )).toThrow(/schema/i);
    expect(() => parseProfileSidecarDiscourseFragmentObservation(
      { ...validObservation, parent_lid: "9.9" },
      fragmentContext,
    )).toThrow(/parent_lid/i);
    expect(() => parseProfileSidecarDiscourseFragmentObservation(
      { ...validObservation, summary_fragments: ["x".repeat(201)] },
      fragmentContext,
    )).toThrow(/schema/i);

    const finalItem = { lid: "1.1", mode: "informative" as const, relations: [] };
    const finalContext = {
      role: "final" as const,
      parent_lid: "1.1",
      reducer_level: 0,
      source_slice_range: { start_ordinal: 0, end_ordinal_exclusive: 2 },
      allowed_evidence_lids: ["1.1"],
    };
    expect(parseProfileSidecarDiscourseReduceOutput({ discourse_items: [finalItem] }, finalContext))
      .toEqual({ discourse_items: [finalItem] });
    expect(() => parseProfileSidecarDiscourseReduceOutput({ discourse_items: [] }, finalContext))
      .toThrow(/schema/i);
    expect(() => parseProfileSidecarDiscourseReduceOutput(
      { discourse_items: [finalItem, finalItem] },
      finalContext,
    )).toThrow(/schema/i);
  });

  it.each([
    [2, [1]],
    [20, [3, 1]],
    [200, [25, 4, 1]],
  ] as const)("forms a stable bounded 8-ary reduction tree for %i fragments", (count, expectedCounts) => {
    const prepared = preparedFragmentUnits(count);
    const forward = replayTree(count, false, prepared);
    const reversed = replayTree(count, true, prepared);
    expect(PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN).toBe(8);
    expect(forward.levelCounts).toEqual(expectedCounts);
    expect(reversed.levelCounts).toEqual(expectedCounts);
    expect(reversed.levels).toEqual(forward.levels);
    for (const level of forward.levels) {
      for (const unit of level) {
        expect(unit.descriptor.input_basis.kind).toBe("artifact_reduction");
        if (unit.descriptor.input_basis.kind !== "artifact_reduction") continue;
        expect(unit.descriptor.input_basis.dependency_artifacts.length)
          .toBeLessThanOrEqual(PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN);
        expect(verifyModelInputBudgetProof(unit.rendered_input, unit.descriptor.input_budget_proof))
          .toBe(unit.descriptor.input_budget_proof);
      }
    }
    expect(forward.levels.at(-1)![0].route.role).toBe("final");
  });

  it("binds each reducer input and identity to verified child artifact hashes", () => {
    const { parent, units } = preparedFragmentUnits(2);
    const children = units.map(verifiedChild);
    const first = routeProfileSidecarDiscourseReductionLevel({
      target: units[0].descriptor.target,
      parent_lid: parent.lid,
      fragment_count: 2,
      children,
      policy: policy("reduce"),
      budget: BUDGET,
    });
    if (first.status !== "routed") throw new Error("first reducer route should fit");

    const changedPayload = {
      ...observationFor(units[0]),
      summary_fragments: ["Changed bounded observation."],
    };
    const changedArtifact = buildSemanticArtifactEnvelopeV3({
      target: units[0].descriptor.target,
      stage: "profile_sidecar",
      work_unit_id: units[0].descriptor.work_unit_id,
      input_hash: units[0].descriptor.input_hash,
      policy_generation_id: policyGenerationIdFor(units[0]),
      semantic_contract: semanticContractFromExtractionPolicy(units[0].descriptor.policy_fingerprint),
      provenance: envelopeFor(units[0]).provenance,
      payload: changedPayload,
    });
    const changedChild = verifyProfileSidecarDiscourseShadowArtifact({
      work_unit: units[0],
      artifact: changedArtifact,
      policy_generation_id: policyGenerationIdFor(units[0]),
    });
    const second = routeProfileSidecarDiscourseReductionLevel({
      target: units[0].descriptor.target,
      parent_lid: parent.lid,
      fragment_count: 2,
      children: [changedChild, children[1]],
      policy: policy("reduce"),
      budget: BUDGET,
    });
    if (second.status !== "routed") throw new Error("changed reducer route should fit");
    expect(second.units[0].descriptor.work_unit_id).not.toBe(first.units[0].descriptor.work_unit_id);
    expect(second.units[0].descriptor.input_hash).not.toBe(first.units[0].descriptor.input_hash);
    expect(second.units[0].descriptor.input_budget_proof.rendered_input_sha256)
      .not.toBe(first.units[0].descriptor.input_budget_proof.rendered_input_sha256);

    const tampered = { ...envelopeFor(units[0]), payload: changedPayload };
    expect(() => verifyProfileSidecarDiscourseShadowArtifact({
      work_unit: units[0],
      artifact: tampered,
      policy_generation_id: policyGenerationIdFor(units[0]),
    })).toThrow(/artifact/i);
  });
});
