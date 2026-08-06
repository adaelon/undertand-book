import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAutomaticBuildStagePolicySet,
  freezeAutomaticBuildStagePolicySet,
  recordAutomaticBuildPolicyMigration,
} from "../src/automatic-build-policy-generation";
import { buildPass1Artifact } from "../src/build-resume";
import type { AutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import type { GraphEdge } from "../src/generated/GraphEdge";
import type { GraphNode } from "../src/generated/GraphNode";
import type { LidNode } from "../src/generated/LidNode";
import {
  evaluateModelInputBudget,
  verifyModelInputBudgetProof,
  type ModelInputBudgetRequestV1,
} from "../src/model-input-budget";
import {
  renderPass1ModelInput,
  renderPass1SourceFragmentModelInput,
} from "../src/model-input-renderer";
import { buildProfiledPass1Input } from "../src/pass1-profile-input";
import {
  PASS1_LID_STITCH_SCHEMA_VERSION,
  PASS1_SHADOW_GRAPH_ARTIFACT_VERSION,
  PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
  PASS1_STITCH_MAX_CHILDREN,
  buildPass1ShadowFinalCandidate,
  createPass1ShadowTask,
  freezePass1ShadowTask,
  parsePass1LidStitchCandidate,
  parsePass1SourceFragmentCandidate,
  pass1LidStitchPolicy,
  pass1ModelSlicePolicyMembers,
  pass1ShadowTaskPrivateDirectory,
  pass1SourceFragmentPolicy,
  routePass1ShadowWorkUnits,
  routePass1StitchLevel,
  verifyPass1ShadowArtifact,
  writePass1ShadowCandidate,
  type Pass1ShadowGraphArtifactV1,
  type Pass1ShadowVerifiedChildV1,
  type Pass1ShadowWorkUnitV1,
} from "../src/pass1-reduction";
import {
  automaticBuildExtractionPolicy,
  automaticBuildGenerationArtifactPath,
  buildSemanticArtifactEnvelope,
  buildSemanticArtifactEnvelopeV3,
  freezeAutomaticBuildStagePolicy,
  writeAutomaticBuildGenerationArtifact,
  type SemanticArtifactEnvelopeV3,
  type SemanticArtifactProvenanceV2,
} from "../src/semantic-artifact";
import {
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptorV3,
  routePass1WindowWorkUnits,
  validateWorkUnitDescriptorV3,
} from "../src/stage-work-unit";
import { estimateTokens, type Window } from "../src/window";
import { createSyntheticRoutabilityFixture } from "./helpers/model-input-routability-fixture";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const BUDGET: Omit<ModelInputBudgetRequestV1, "rendered_input" | "router_version" | "prompt_sha256"> = {
  stage_body_limit_tokens: 5_000,
  executor_context_floor_tokens: 8_192,
  prompt_reserve_tokens: 512,
  protocol_reserve_tokens: 256,
  output_reserve_tokens: 1_024,
  safety_margin_tokens: 256,
};
const PRODUCTION_STITCH_BUDGET = {
  ...BUDGET,
  stage_body_limit_tokens: 6_000,
};
const TINY_BUDGET = {
  stage_body_limit_tokens: 1,
  executor_context_floor_tokens: 100_000,
  prompt_reserve_tokens: 0,
  protocol_reserve_tokens: 0,
  output_reserve_tokens: 0,
  safety_margin_tokens: 0,
};
const POLICY_SET_DIGEST = sha256("pass1-fragment-stitch-policy-set.v1");
const PROVENANCE: SemanticArtifactProvenanceV2 = {
  executor: "pass1-reduction-test",
  model: "codex-test",
  attempt: 1,
  generated_at: "2026-08-03T12:00:00.000Z",
};

function sharedNode(lid: string): GraphNode {
  return {
    id: "concept:shared-pass1-node",
    type: "concept",
    name: "Shared Pass1 node",
    occurrences: [lid],
    source_lid: null,
  };
}

function localEdge(source: string, target: string, weight = 0.8): GraphEdge {
  return {
    source,
    target,
    type: "explains",
    direction: "directed",
    scope: "local",
    weight,
  };
}

function graphEnvelopeFor(unit: Pass1ShadowWorkUnitV1): SemanticArtifactEnvelopeV3<unknown> {
  const lid = unit.route.evidence_lids[0];
  const payload: Pass1ShadowGraphArtifactV1 = {
    version: PASS1_SHADOW_GRAPH_ARTIFACT_VERSION,
    window_id: unit.route.window_id,
    role: unit.route.role,
    source_unit_range: { ...unit.route.source_unit_range },
    evidence_lids: [...unit.route.evidence_lids],
    ...((unit.route.role === "stitch" || unit.route.role === "final")
      ? { reducer_level: unit.route.reducer_level }
      : {}),
    nodes: [sharedNode(lid)],
    edges: [],
  };
  return buildSemanticArtifactEnvelopeV3({
    target: unit.descriptor.target,
    stage: "pass1",
    work_unit_id: unit.descriptor.work_unit_id,
    input_hash: unit.descriptor.input_hash,
    proof_digest: unit.descriptor.input_budget_proof.proof_digest,
    policy_set_digest: POLICY_SET_DIGEST,
    policy_fingerprint: unit.descriptor.policy_fingerprint,
    provenance: PROVENANCE,
    payload,
  });
}

function verifiedChild(unit: Pass1ShadowWorkUnitV1): Pass1ShadowVerifiedChildV1 {
  return verifyPass1ShadowArtifact({
    work_unit: unit,
    artifact: graphEnvelopeFor(unit),
    policy_set_digest: POLICY_SET_DIGEST,
  });
}

function realisticGraphChild(
  unit: Pass1ShadowWorkUnitV1,
  childOrdinal: number,
  nodeCount: number,
  edgeCount: number,
  policySetDigest = POLICY_SET_DIGEST,
  nodeNameLength = 10,
): Pass1ShadowVerifiedChildV1 {
  const lid = unit.route.evidence_lids[0];
  const nodes = Array.from({ length: nodeCount }, (_, nodeOrdinal): GraphNode => ({
    id: `concept:synthetic_${childOrdinal}_${nodeOrdinal}_${"x".repeat(18)}`,
    type: "concept",
    name: "图".repeat(nodeNameLength),
    occurrences: [lid],
    source_lid: null,
  }));
  const edges = Array.from({ length: edgeCount }, (_, edgeOrdinal): GraphEdge => ({
    source: nodes[edgeOrdinal % nodes.length].id,
    target: nodes[(edgeOrdinal + 1) % nodes.length].id,
    type: "explains",
    direction: "directed",
    scope: "local",
    weight: 0.8,
  }));
  const payload: Pass1ShadowGraphArtifactV1 = {
    version: PASS1_SHADOW_GRAPH_ARTIFACT_VERSION,
    window_id: unit.route.window_id,
    role: unit.route.role,
    source_unit_range: { ...unit.route.source_unit_range },
    evidence_lids: [...unit.route.evidence_lids],
    nodes,
    edges,
  };
  const artifact = buildSemanticArtifactEnvelopeV3({
    target: unit.descriptor.target,
    stage: "pass1",
    work_unit_id: unit.descriptor.work_unit_id,
    input_hash: unit.descriptor.input_hash,
    proof_digest: unit.descriptor.input_budget_proof.proof_digest,
    policy_set_digest: policySetDigest,
    policy_fingerprint: unit.descriptor.policy_fingerprint,
    provenance: PROVENANCE,
    payload,
  });
  return verifyPass1ShadowArtifact({
    work_unit: unit,
    artifact,
    policy_set_digest: policySetDigest,
  });
}

function preparedFragmentUnits(count: number): {
  source: string;
  parent: LidNode;
  units: Pass1ShadowWorkUnitV1[];
} {
  const fixture = createSyntheticRoutabilityFixture(64);
  const profile = resolveContentProfile("technical_learning");
  const fragmentPolicy = pass1SourceFragmentPolicy(profile);
  const source = "x".repeat(count);
  const sourceFingerprint = sha256(source);
  const parent: LidNode = {
    lid: "1.1",
    path: [1, 1],
    kind: "paragraph",
    span: { start: 0, end: source.length },
    children: [],
  };
  const target = { ...fixture.target.target_ref, input_fingerprint: sourceFingerprint };
  const units = Array.from({ length: count }, (_, ordinal): Pass1ShadowWorkUnitV1 => {
    const core = source.slice(ordinal, ordinal + 1);
    const renderedInput = renderPass1SourceFragmentModelInput({
      version: "model_input_slice_render_context.v1",
      content_profile_id: profile.id,
      parent_lid: parent.lid,
      ordinal,
      core_sha256: sha256(core),
      boundary_kind: "grapheme",
      core_span_utf16: { start: ordinal, end: ordinal + 1 },
      context_span_utf16: { start: ordinal, end: ordinal + 1 },
      context_before: "",
      core,
      context_after: "",
    });
    const evaluated = evaluateModelInputBudget({
      ...BUDGET,
      rendered_input: renderedInput,
      router_version: fragmentPolicy.router_version,
      prompt_sha256: fragmentPolicy.prompt_sha256,
    });
    if (evaluated.status !== "within_limit") throw new Error("synthetic Pass1 fragment should fit");
    const slice = {
      version: "model_input_slice.v1" as const,
      source_fingerprint: sourceFingerprint,
      parent_lid: parent.lid,
      ordinal,
      core_span_utf16: { start: ordinal, end: ordinal + 1 },
      context_span_utf16: { start: ordinal, end: ordinal + 1 },
      boundary_kind: "grapheme" as const,
      core_sha256: sha256(core),
      context_sha256: sha256(core),
    };
    const descriptor = createWorkUnitDescriptorV3({
      target,
      stage: "pass1",
      work_unit_id: `pass1-fragment-${ordinal}`,
      kind: "pass1_source_slice",
      input_basis: { kind: "source_slices", slices: [slice] },
      input_hash: evaluated.proof.rendered_input_sha256,
      input_budget_proof: evaluated.proof,
      policy_fingerprint: fragmentPolicy,
      evidence_lids: [parent.lid],
      dependencies: [],
      cost: buildWorkUnitCostFromBudgetProof({
        rendered_input: renderedInput,
        proof: evaluated.proof,
        visible_lids: 1,
        expected_output_items: 1,
      }),
      aggregation: { parent_lid: parent.lid, role: "fragment" },
    });
    return {
      descriptor,
      rendered_input: renderedInput,
      route: {
        role: "fragment",
        window_id: 0,
        parent_lid: parent.lid,
        source_slice_ordinal: ordinal,
        source_unit_range: { start_ordinal: ordinal, end_ordinal_exclusive: ordinal + 1 },
        evidence_lids: [parent.lid],
      },
    };
  });
  return { source, parent, units };
}

function replayTree(
  count: number,
  reverseChildren = false,
  prepared = preparedFragmentUnits(count),
): {
  levelCounts: number[];
  levels: Pass1ShadowWorkUnitV1[][];
} {
  const policy = pass1LidStitchPolicy(resolveContentProfile("technical_learning"));
  let children = prepared.units.map(verifiedChild);
  if (reverseChildren) children = [...children].reverse();
  const levels: Pass1ShadowWorkUnitV1[][] = [];
  while (true) {
    const routed = routePass1StitchLevel({
      target: prepared.units[0].descriptor.target,
      window_id: 0,
      source_unit_count: count,
      children,
      policy_set_digest: POLICY_SET_DIGEST,
      policy,
      budget: BUDGET,
    });
    if (routed.status !== "routed") throw new Error("synthetic Pass1 stitch level should fit");
    levels.push(routed.units);
    if (routed.units.length === 1 && routed.units[0].route.role === "final") break;
    children = routed.units.map(verifiedChild);
  }
  return { levelCounts: levels.map((level) => level.length), levels };
}

describe("Pass1 dormant fragment/stitch routing", () => {
  it("keeps a fitting whole window byte-identical and eligible for exact v2 artifact adoption", () => {
    const fixture = createSyntheticRoutabilityFixture(32);
    const profile = resolveContentProfile("technical_learning");
    const window = fixture.windows.find((candidate) => candidate.leafLids.includes(fixture.paragraph_lid));
    if (!window) throw new Error("synthetic fixture is missing its paragraph window");
    const wholePolicy = automaticBuildExtractionPolicy("pass1", profile, "full");
    const expectedInput = renderPass1ModelInput(buildProfiledPass1Input(
      window,
      fixture.by_lid,
      fixture.source,
      profile,
    ));
    const routed = routePass1ShadowWorkUnits({
      target: fixture.target.target_ref,
      window,
      by_lid: fixture.by_lid,
      source: fixture.source,
      source_fingerprint: fixture.identity.source_sha256,
      content_profile: profile,
      whole_policy: wholePolicy,
      fragment_policy: pass1SourceFragmentPolicy(profile),
      whole_budget: BUDGET,
      fragment_budget: BUDGET,
    });
    expect(routed.status).toBe("routed");
    if (routed.status !== "routed") throw new Error("small Pass1 window should fit");
    expect(routed.mode).toBe("whole");
    expect(routed.units).toHaveLength(1);
    const current = routed.units[0];
    expect(current.route.role).toBe("whole");
    expect(current.descriptor.work_unit_id).toBe(String(window.id));
    expect(current.rendered_input).toBe(expectedInput);
    expect(current.descriptor.input_hash).toBe(sha256(expectedInput));
    expect(verifyModelInputBudgetProof(current.rendered_input, current.descriptor.input_budget_proof))
      .toBe(current.descriptor.input_budget_proof);

    const previous = routePass1WindowWorkUnits({
      target: fixture.target.target_ref,
      windows: [window],
      byLid: fixture.by_lid,
      source: fixture.source,
      policy_fingerprint: wholePolicy,
      content_profile: profile,
    })[0];
    expect(previous.work_unit_id).toBe(current.descriptor.work_unit_id);
    expect(previous.kind).toBe(current.descriptor.kind);
    expect(previous.input_hash).toBe(current.descriptor.input_hash);

    const output = {
      nodes: [sharedNode(window.leafLids[0])],
      edges: [] as GraphEdge[],
    };
    const legacyPayload = buildPass1Artifact(window, fixture.by_lid, fixture.source, output, profile);
    const legacyEnvelope = buildSemanticArtifactEnvelope({
      target: fixture.target.target_ref,
      stage: "pass1",
      work_unit_id: previous.work_unit_id,
      input_hash: previous.input_hash,
      policy_fingerprint: previous.policy_fingerprint,
      provenance: PROVENANCE,
      payload: legacyPayload,
    });
    const legacyPath = path.join(fixture.target.workspace_dir, ".build", "pass1", `${window.id}.json`);
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, `${JSON.stringify(legacyEnvelope, null, 2)}\n`, "utf8");
    const oldLock = freezeAutomaticBuildStagePolicy(
      fixture.target,
      "pass1",
      wholePolicy,
      "2026-08-03T12:00:00.000Z",
    );
    const policySet = createAutomaticBuildStagePolicySet({
      target_ref: fixture.target.target_ref,
      stage: "pass1",
      members: pass1ModelSlicePolicyMembers(profile),
      frozen_at: "2026-08-03T12:00:01.000Z",
    });
    const receipt = recordAutomaticBuildPolicyMigration({
      target: fixture.target,
      stage: "pass1",
      from_policy_digest: oldLock.policy_digest,
      policy_set: policySet,
      current: { route: "model", descriptor: current.descriptor, rendered_input: current.rendered_input },
      previous: { descriptor: previous, rendered_input: expectedInput, artifact_path: legacyPath },
      now: "2026-08-03T12:00:02.000Z",
    });
    expect(receipt).toMatchObject({
      decision: "adopt_exact",
      reason: "exact_input_and_policy",
      adopted_artifact: { artifact_hash: legacyEnvelope.artifact_hash },
    });
    expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual(legacyEnvelope);
  });

  it("routes the 6,992-token paragraph into exact-cover fragments without changing source or LID evidence", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const profile = resolveContentProfile("technical_learning");
    const window = fixture.windows.find((candidate) => candidate.leafLids.includes(fixture.paragraph_lid));
    if (!window) throw new Error("synthetic fixture is missing its paragraph window");
    const before = JSON.stringify({
      source: fixture.identity.source_sha256,
      blocks: fixture.identity.source_blocks_sha256,
      lids: fixture.identity.lid_tree_sha256,
      spans: fixture.identity.lid_spans_sha256,
    });
    const route = () => routePass1ShadowWorkUnits({
      target: fixture.target.target_ref,
      window,
      by_lid: fixture.by_lid,
      source: fixture.source,
      source_fingerprint: fixture.identity.source_sha256,
      content_profile: profile,
      whole_policy: automaticBuildExtractionPolicy("pass1", profile, "full"),
      fragment_policy: pass1SourceFragmentPolicy(profile),
      whole_budget: BUDGET,
      fragment_budget: BUDGET,
      context_overlap_utf16: 64,
    });
    const first = route();
    const second = route();
    expect(first.status).toBe("routed");
    expect(second).toEqual(first);
    if (first.status !== "routed") throw new Error("long Pass1 window should be fragment-routable");
    expect(first.mode).toBe("split");
    const fragments = first.units.filter((unit) => unit.route.role === "fragment");
    expect(fragments.length).toBeGreaterThan(1);
    expect(first.coverages).toContainEqual(expect.objectContaining({
      parent_lid: fixture.paragraph_lid,
      gap_utf16: 0,
      core_overlap_utf16: 0,
      expected_core_utf16: fixture.paragraph_text.length,
      covered_core_utf16: fixture.paragraph_text.length,
    }));
    expect(first.units.map((unit) => unit.route.source_unit_range.start_ordinal))
      .toEqual(first.units.map((_, ordinal) => ordinal));
    for (const unit of fragments) {
      expect(validateWorkUnitDescriptorV3(unit.descriptor)).toBe(unit.descriptor);
      expect(unit.descriptor.kind).toBe("pass1_source_slice");
      expect(unit.route.evidence_lids).toEqual([fixture.paragraph_lid]);
      expect(unit.descriptor.evidence_lids).toEqual([fixture.paragraph_lid]);
      expect(verifyModelInputBudgetProof(unit.rendered_input, unit.descriptor.input_budget_proof))
        .toBe(unit.descriptor.input_budget_proof);
    }
    expect(JSON.stringify({
      source: fixture.identity.source_sha256,
      blocks: fixture.identity.source_blocks_sha256,
      lids: fixture.identity.lid_tree_sha256,
      spans: fixture.identity.lid_spans_sha256,
    })).toBe(before);
  });

  it("enforces closed fragment/stitch schemas and original-LID/node closure", () => {
    const coreHash = sha256("core");
    const fragment = {
      version: PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
      parent_lid: "1.1",
      source_slice_ordinal: 0,
      core_sha256: coreHash,
      nodes: [
        { id: "concept:a", type: "concept" as const, name: "A", occurrences: ["1.1"], source_lid: null },
        { id: "concept:b", type: "concept" as const, name: "B", occurrences: ["1.1"], source_lid: null },
      ],
      edges: [localEdge("concept:a", "concept:b")],
    };
    expect(parsePass1SourceFragmentCandidate(fragment, {
      parent_lid: "1.1",
      source_slice_ordinal: 0,
      core_sha256: coreHash,
    })).toEqual(fragment);
    expect(() => parsePass1SourceFragmentCandidate({ ...fragment, raw_source: "forbidden" }, {
      parent_lid: "1.1",
      source_slice_ordinal: 0,
      core_sha256: coreHash,
    })).toThrow(/schema_invalid/i);
    expect(() => parsePass1SourceFragmentCandidate({
      ...fragment,
      nodes: [{ ...fragment.nodes[0], occurrences: ["9.9"] }],
      edges: [],
    }, {
      parent_lid: "1.1",
      source_slice_ordinal: 0,
      core_sha256: coreHash,
    })).toThrow(/evidence/i);
    expect(() => parsePass1SourceFragmentCandidate({
      ...fragment,
      edges: [{ ...fragment.edges[0], scope: "long_range" }],
    }, {
      parent_lid: "1.1",
      source_slice_ordinal: 0,
      core_sha256: coreHash,
    })).toThrow(/schema_invalid/i);

    const stitch = {
      version: PASS1_LID_STITCH_SCHEMA_VERSION,
      edges: [localEdge("concept:a", "concept:b")],
    };
    expect(parsePass1LidStitchCandidate(stitch, ["concept:a", "concept:b"])).toEqual(stitch);
    expect(() => parsePass1LidStitchCandidate(stitch, ["concept:a"])).toThrow(/outside verified children/i);
    expect(() => parsePass1LidStitchCandidate({ ...stitch, nodes: [] }, ["concept:a", "concept:b"]))
      .toThrow(/schema_invalid/i);
  });

  it.each([
    [2, [1]],
    [20, [3, 1]],
    [200, [25, 4, 1]],
  ] as const)("forms a stable proof-bound 8-ary stitch tree for %i fragments", (count, expectedCounts) => {
    const prepared = preparedFragmentUnits(count);
    const forward = replayTree(count, false, prepared);
    const reversed = replayTree(count, true, prepared);
    expect(PASS1_STITCH_MAX_CHILDREN).toBe(8);
    expect(forward.levelCounts).toEqual(expectedCounts);
    expect(reversed.levelCounts).toEqual(expectedCounts);
    expect(reversed.levels).toEqual(forward.levels);
    for (const level of forward.levels) {
      for (const unit of level) {
        expect(unit.descriptor.input_basis.kind).toBe("artifact_reduction");
        if (unit.descriptor.input_basis.kind !== "artifact_reduction") continue;
        expect(unit.descriptor.input_basis.dependency_artifacts.length).toBeLessThanOrEqual(8);
        expect(verifyModelInputBudgetProof(unit.rendered_input, unit.descriptor.input_budget_proof))
          .toBe(unit.descriptor.input_budget_proof);
      }
    }
    expect(forward.levels.at(-1)![0].route.role).toBe("final");
  });

  it("packs stitch groups by rendered boundary bytes before the eight-child ceiling", () => {
    const prepared = preparedFragmentUnits(8);
    const children = prepared.units.map((unit, index) => realisticGraphChild(
      unit,
      index,
      1,
      0,
      POLICY_SET_DIGEST,
      1_024,
    ));
    const routed = routePass1StitchLevel({
      target: prepared.units[0].descriptor.target,
      window_id: 0,
      source_unit_count: prepared.units.length,
      children,
      policy_set_digest: POLICY_SET_DIGEST,
      policy: pass1LidStitchPolicy(resolveContentProfile("technical_learning")),
      budget: PRODUCTION_STITCH_BUDGET,
    });

    expect(routed).toMatchObject({ status: "routed", role: "stitch" });
    if (routed.status !== "routed") return;
    expect(routed.units.length).toBeGreaterThan(1);
    expect(routed.units.reduce((count, unit) => {
      if (unit.descriptor.input_basis.kind !== "artifact_reduction") return count;
      expect(unit.descriptor.input_basis.dependency_artifacts.length).toBeGreaterThanOrEqual(2);
      expect(unit.descriptor.input_basis.dependency_artifacts.length).toBeLessThan(8);
      expect(unit.descriptor.input_budget_proof.estimated_rendered_tokens)
        .toBeLessThanOrEqual(PRODUCTION_STITCH_BUDGET.stage_body_limit_tokens);
      return count + unit.descriptor.input_basis.dependency_artifacts.length;
    }, 0)).toBe(8);
  });

  it("routes the real 86-node/77-edge four-child shape through a bounded boundary projection", () => {
    const prepared = preparedFragmentUnits(4);
    const graphSizes = [[18, 17], [23, 21], [22, 20], [23, 19]] as const;
    const children = prepared.units.map((unit, index) => realisticGraphChild(
      unit,
      index,
      graphSizes[index][0],
      graphSizes[index][1],
    ));
    const routed = routePass1StitchLevel({
      target: prepared.units[0].descriptor.target,
      window_id: 0,
      source_unit_count: prepared.units.length,
      children,
      policy_set_digest: POLICY_SET_DIGEST,
      policy: pass1LidStitchPolicy(resolveContentProfile("technical_learning")),
      budget: PRODUCTION_STITCH_BUDGET,
    });

    expect(routed).toMatchObject({ status: "routed" });
    if (routed.status !== "routed") return;
    expect(routed.role).toBe("final");
    expect(routed.units).toHaveLength(1);
    const unit = routed.units[0];
    if (unit.route.role !== "final") throw new Error("expected one final stitch unit");
    const rendered = JSON.parse(unit.rendered_input) as {
      children: Array<{ payload: { nodes: Array<Record<string, unknown>>; edges: GraphEdge[] } }>;
    };
    expect(rendered.children.flatMap((child) => child.payload.nodes)).toHaveLength(86);
    expect(rendered.children.flatMap((child) => child.payload.nodes))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String), name: expect.any(String) })]));
    expect(rendered.children.flatMap((child) => child.payload.nodes)
      .every((node) => Object.keys(node).sort().join(",") === "id,name,type"))
      .toBe(true);
    expect(rendered.children.flatMap((child) => child.payload.edges).length).toBeLessThan(77);
    const legacyInput = {
      version: "pass1_lid_stitch_input.v1",
      work_unit_id: unit.descriptor.work_unit_id,
      window_id: unit.route.window_id,
      reducer_level: unit.route.reducer_level,
      group_ordinal: unit.route.group_ordinal,
      role: unit.route.role,
      source_unit_range: unit.route.source_unit_range,
      children: children.map((child) => ({
        work_unit_id: child.work_unit.descriptor.work_unit_id,
        artifact_hash: child.artifact.artifact_hash,
        source_unit_range: child.payload.source_unit_range,
        payload: child.payload,
      })),
    };
    expect(estimateTokens(`${JSON.stringify(legacyInput)}\n`))
      .toBeGreaterThan(PRODUCTION_STITCH_BUDGET.stage_body_limit_tokens);
    expect(routed.units[0].descriptor.input_budget_proof.estimated_rendered_tokens)
      .toBeLessThanOrEqual(PRODUCTION_STITCH_BUDGET.stage_body_limit_tokens);
  });

  it("deterministically merges the complete 86-node/77-edge graph behind the bounded final projection", () => {
    const prepared = preparedFragmentUnits(4);
    const profile = resolveContentProfile("technical_learning");
    const targetRef = prepared.units[0].descriptor.target;
    const target: AutomaticBuildTarget = {
      kind: "source_file",
      profile_id: targetRef.profile_id,
      book_id: targetRef.book_id,
      root_dir: path.dirname(path.dirname(targetRef.workspace_dir)),
      workspace_dir: targetRef.workspace_dir,
      source_path: path.join(path.dirname(targetRef.workspace_dir), "synthetic.md"),
      target_ref: targetRef,
    };
    const policySet = freezeAutomaticBuildStagePolicySet(
      target,
      createAutomaticBuildStagePolicySet({
        target_ref: targetRef,
        stage: "pass1",
        members: pass1ModelSlicePolicyMembers(profile),
        frozen_at: "2026-08-06T01:00:00.000Z",
      }),
    );
    const graphSizes = [[18, 17], [23, 21], [22, 20], [23, 19]] as const;
    const children = prepared.units.map((unit, index) => {
      const task = createPass1ShadowTask({
        work_unit: unit,
        source_fingerprint: sha256(prepared.source),
        policy_set_digest: policySet.policy_set_digest,
        source_unit_count: prepared.units.length,
      });
      freezePass1ShadowTask(target, task);
      const child = realisticGraphChild(
        unit,
        index,
        graphSizes[index][0],
        graphSizes[index][1],
        policySet.policy_set_digest,
      );
      writeAutomaticBuildGenerationArtifact(target, child.artifact);
      return child;
    });
    const routed = routePass1StitchLevel({
      target: targetRef,
      window_id: 0,
      source_unit_count: prepared.units.length,
      children,
      policy_set_digest: policySet.policy_set_digest,
      policy: pass1LidStitchPolicy(profile),
      budget: PRODUCTION_STITCH_BUDGET,
    });
    if (routed.status !== "routed" || routed.units.length !== 1 || routed.units[0].route.role !== "final") {
      throw new Error("expected one bounded Pass1 final projection");
    }
    const finalTask = createPass1ShadowTask({
      work_unit: routed.units[0],
      source_fingerprint: sha256(prepared.source),
      policy_set_digest: policySet.policy_set_digest,
      source_unit_count: prepared.units.length,
    });
    freezePass1ShadowTask(target, finalTask);
    const written = writePass1ShadowCandidate({
      target,
      source: prepared.source,
      task: finalTask,
      candidate: { version: PASS1_LID_STITCH_SCHEMA_VERSION, edges: [] },
      provenance: PROVENANCE,
    });
    const envelope = JSON.parse(readFileSync(written.artifact_path, "utf8")) as SemanticArtifactEnvelopeV3<
      Pass1ShadowGraphArtifactV1
    >;
    expect(envelope.payload.nodes).toHaveLength(86);
    expect(envelope.payload.edges).toHaveLength(77);
    expect(buildPass1ShadowFinalCandidate({ target, source: prepared.source, task: finalTask }))
      .toMatchObject({ nodes: { length: 86 }, edges: { length: 77 } });
  });

  it("fails closed on child gaps, duplicates, stale artifacts, invalid proofs, and invalid candidate writes", () => {
    const prepared = preparedFragmentUnits(2);
    const children = prepared.units.map(verifiedChild);
    const policy = pass1LidStitchPolicy(resolveContentProfile("technical_learning"));
    const base = {
      target: prepared.units[0].descriptor.target,
      window_id: 0,
      source_unit_count: 2,
      policy_set_digest: POLICY_SET_DIGEST,
      policy,
      budget: BUDGET,
    };
    expect(() => routePass1StitchLevel({ ...base, children: [children[0]] })).toThrow(/cover|count/i);
    expect(() => routePass1StitchLevel({ ...base, children: [children[0], children[0]] }))
      .toThrow(/unique/i);

    const stale = graphEnvelopeFor(prepared.units[0]) as SemanticArtifactEnvelopeV3<Record<string, unknown>>;
    stale.payload = { ...stale.payload, nodes: [] };
    expect(() => verifyPass1ShadowArtifact({
      work_unit: prepared.units[0],
      artifact: stale,
      policy_set_digest: POLICY_SET_DIGEST,
    })).toThrow(/stale|invalid/i);

    const invalidProofUnit: Pass1ShadowWorkUnitV1 = {
      ...prepared.units[0],
      descriptor: {
        ...prepared.units[0].descriptor,
        input_budget_proof: {
          ...prepared.units[0].descriptor.input_budget_proof,
          rendered_input_sha256: sha256("different input"),
        },
      },
    };
    expect(() => verifyPass1ShadowArtifact({
      work_unit: invalidProofUnit,
      artifact: graphEnvelopeFor(prepared.units[0]),
      policy_set_digest: POLICY_SET_DIGEST,
    })).toThrow(/proof|input_hash|digest/i);

    const fixture = createSyntheticRoutabilityFixture();
    const profile = resolveContentProfile("technical_learning");
    const window = fixture.windows.find((candidate) => candidate.leafLids.includes(fixture.paragraph_lid));
    if (!window) throw new Error("synthetic fixture is missing its paragraph window");
    const routed = routePass1ShadowWorkUnits({
      target: fixture.target.target_ref,
      window,
      by_lid: fixture.by_lid,
      source: fixture.source,
      source_fingerprint: fixture.identity.source_sha256,
      content_profile: profile,
      whole_policy: automaticBuildExtractionPolicy("pass1", profile, "full"),
      fragment_policy: pass1SourceFragmentPolicy(profile),
      whole_budget: BUDGET,
      fragment_budget: BUDGET,
      context_overlap_utf16: 64,
    });
    if (routed.status !== "routed") throw new Error("synthetic long paragraph should route");
    const fragmentUnit = routed.units.find((unit) => unit.route.role === "fragment");
    if (!fragmentUnit) throw new Error("expected a Pass1 fragment unit");
    const fragmentRoute = fragmentUnit.route;
    const fragmentBasis = fragmentUnit.descriptor.input_basis;
    if (fragmentRoute.role !== "fragment" || fragmentBasis.kind !== "source_slices") {
      throw new Error("expected a Pass1 fragment unit");
    }
    const policySet = freezeAutomaticBuildStagePolicySet(
      fixture.target,
      createAutomaticBuildStagePolicySet({
        target_ref: fixture.target.target_ref,
        stage: "pass1",
        members: pass1ModelSlicePolicyMembers(profile),
        frozen_at: "2026-08-03T12:30:00.000Z",
      }),
    );
    const task = createPass1ShadowTask({
      work_unit: fragmentUnit,
      source_fingerprint: fixture.identity.source_sha256,
      policy_set_digest: policySet.policy_set_digest,
      source_unit_count: routed.units.length,
    });
    freezePass1ShadowTask(fixture.target, task);
    const artifactPath = automaticBuildGenerationArtifactPath(
      fixture.target,
      "pass1",
      policySet.policy_set_digest,
      fragmentUnit.descriptor.work_unit_id,
    );
    const slice = fragmentBasis.slices[0];
    expect(() => writePass1ShadowCandidate({
      target: fixture.target,
      source: fixture.source,
      task,
      candidate: {
        version: PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
        parent_lid: fragmentRoute.parent_lid,
        source_slice_ordinal: slice.ordinal,
        core_sha256: slice.core_sha256,
        nodes: [sharedNode(fragmentRoute.parent_lid)],
        edges: [localEdge("concept:shared-pass1-node", "concept:missing")],
      },
      provenance: PROVENANCE,
    })).toThrow(/outside the candidate/i);
    expect(existsSync(artifactPath)).toBe(false);
    expect(pass1ShadowTaskPrivateDirectory(
      fixture.target,
      policySet.policy_set_digest,
      fragmentUnit.descriptor.work_unit_id,
    )).toContain(path.join("v3", "shadow", "pass1"));
  });

  it("rejects a self-consistent root artifact whose graph route differs from its frozen final task", () => {
    const prepared = preparedFragmentUnits(2);
    const profile = resolveContentProfile("technical_learning");
    const targetRef = prepared.units[0].descriptor.target;
    const target: AutomaticBuildTarget = {
      kind: "source_file",
      profile_id: targetRef.profile_id,
      book_id: targetRef.book_id,
      root_dir: path.dirname(path.dirname(targetRef.workspace_dir)),
      workspace_dir: targetRef.workspace_dir,
      source_path: path.join(path.dirname(targetRef.workspace_dir), "synthetic.md"),
      target_ref: targetRef,
    };
    const policySet = freezeAutomaticBuildStagePolicySet(
      target,
      createAutomaticBuildStagePolicySet({
        target_ref: targetRef,
        stage: "pass1",
        members: pass1ModelSlicePolicyMembers(profile),
        frozen_at: "2026-08-03T12:45:00.000Z",
      }),
    );
    const children = prepared.units.map((unit) => {
      const task = createPass1ShadowTask({
        work_unit: unit,
        source_fingerprint: sha256(prepared.source),
        policy_set_digest: policySet.policy_set_digest,
        source_unit_count: prepared.units.length,
      });
      freezePass1ShadowTask(target, task);
      if (unit.route.role !== "fragment" || unit.descriptor.input_basis.kind !== "source_slices") {
        throw new Error("expected a synthetic Pass1 fragment");
      }
      const slice = unit.descriptor.input_basis.slices[0];
      const artifactPath = writePass1ShadowCandidate({
        target,
        source: prepared.source,
        task,
        candidate: {
          version: PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
          parent_lid: unit.route.parent_lid,
          source_slice_ordinal: slice.ordinal,
          core_sha256: slice.core_sha256,
          nodes: [sharedNode(unit.route.parent_lid)],
          edges: [],
        },
        provenance: PROVENANCE,
      }).artifact_path;
      return verifyPass1ShadowArtifact({
        work_unit: unit,
        artifact: JSON.parse(readFileSync(artifactPath, "utf8")) as SemanticArtifactEnvelopeV3<unknown>,
        policy_set_digest: policySet.policy_set_digest,
      });
    });
    const routed = routePass1StitchLevel({
      target: targetRef,
      window_id: 0,
      source_unit_count: prepared.units.length,
      children,
      policy_set_digest: policySet.policy_set_digest,
      policy: pass1LidStitchPolicy(profile),
      budget: BUDGET,
    });
    if (routed.status !== "routed" || routed.units.length !== 1 || routed.units[0].route.role !== "final") {
      throw new Error("expected one synthetic Pass1 root final");
    }
    const finalUnit = routed.units[0];
    const finalTask = createPass1ShadowTask({
      work_unit: finalUnit,
      source_fingerprint: sha256(prepared.source),
      policy_set_digest: policySet.policy_set_digest,
      source_unit_count: prepared.units.length,
    });
    freezePass1ShadowTask(target, finalTask);
    const finalArtifactPath = writePass1ShadowCandidate({
      target,
      source: prepared.source,
      task: finalTask,
      candidate: { version: PASS1_LID_STITCH_SCHEMA_VERSION, edges: [] },
      provenance: PROVENANCE,
    }).artifact_path;
    const original = JSON.parse(readFileSync(finalArtifactPath, "utf8")) as SemanticArtifactEnvelopeV3<
      Pass1ShadowGraphArtifactV1
    >;
    const forged = buildSemanticArtifactEnvelopeV3({
      target: finalTask.target_ref,
      stage: "pass1",
      work_unit_id: finalTask.descriptor.work_unit_id,
      input_hash: finalTask.descriptor.input_hash,
      proof_digest: finalTask.descriptor.input_budget_proof.proof_digest,
      policy_set_digest: finalTask.policy_set_digest,
      policy_fingerprint: finalTask.descriptor.policy_fingerprint,
      provenance: original.provenance,
      payload: { ...original.payload, window_id: original.payload.window_id + 1 },
    });
    writeFileSync(finalArtifactPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");

    expect(() => buildPass1ShadowFinalCandidate({ target, source: prepared.source, task: finalTask }))
      .toThrow(/route|window/i);
  });

  it.each(["code", "table", "formula", "image"] as const)(
    "returns a structured block instead of executing an over-limit atomic %s LID",
    (kind) => {
      const fixture = createSyntheticRoutabilityFixture(32);
      const profile = resolveContentProfile("technical_learning");
      const source = "x".repeat(200);
      const lid = "1.1";
      const node: LidNode = { lid, path: [1, 1], kind, span: { start: 0, end: source.length }, children: [] };
      const window: Window = {
        id: 0,
        leafLids: [lid],
        tokens: estimateTokens(source),
        spans: [{ ...node.span }],
        overBudget: true,
      };
      const routed = routePass1ShadowWorkUnits({
        target: { ...fixture.target.target_ref, input_fingerprint: sha256(source) },
        window,
        by_lid: new Map([[lid, node]]),
        source,
        source_fingerprint: sha256(source),
        content_profile: profile,
        whole_policy: automaticBuildExtractionPolicy("pass1", profile, "full"),
        fragment_policy: pass1SourceFragmentPolicy(profile),
        whole_budget: TINY_BUDGET,
        fragment_budget: TINY_BUDGET,
      });
      expect(routed).toMatchObject({
        status: "blocked",
        recovery: {
          version: "automatic_build_recovery_draft.v1",
          phase: "routing",
          code: "model_input_unsplittable",
          parent_lid: lid,
          lid_kind: kind,
          retryable: false,
        },
      });
      expect(JSON.stringify(routed)).not.toContain(source);
    },
  );
});
