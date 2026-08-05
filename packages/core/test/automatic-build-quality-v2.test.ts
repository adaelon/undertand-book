import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateAutomaticBuildStageQualityV2,
  type AutomaticBuildStageQualityRoutingEvidenceV2,
} from "../src/automatic-build-quality";
import {
  createAutomaticBuildStagePolicySet,
  type AutomaticBuildStagePolicySetV2,
} from "../src/automatic-build-policy-generation";
import { resolveContentProfile } from "../src/content-profile";
import { evaluateModelInputBudget } from "../src/model-input-budget";
import {
  pass1LidStitchPolicy,
  pass1ModelSlicePolicyMembers,
  pass1SourceFragmentPolicy,
} from "../src/pass1-reduction";
import {
  buildSemanticArtifactEnvelopeV3,
  type SemanticArtifactEnvelopeV3,
} from "../src/semantic-artifact";
import {
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptorV3,
  type WorkUnitDescriptorV3,
} from "../src/stage-work-unit";

const targetRef = {
  version: "build_target_ref.v2" as const,
  workspace_dir: "C:/repo/.understand-book/br8-quality",
  book_id: "br8-quality",
  profile_id: "technical_learning" as const,
  input_fingerprint: "a".repeat(64),
};
const profile = resolveContentProfile("technical_learning");
const fragmentPolicy = pass1SourceFragmentPolicy(profile);
const finalPolicy = pass1LidStitchPolicy(profile);
const parentLid = "1.1";
const parentLength = 200;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function policySet(
  members = pass1ModelSlicePolicyMembers(profile),
): AutomaticBuildStagePolicySetV2 {
  return createAutomaticBuildStagePolicySet({
    target_ref: targetRef,
    stage: "pass1",
    members,
    frozen_at: "2026-08-04T00:00:00.000Z",
  });
}

function proof(renderedInput: string, policy: typeof fragmentPolicy) {
  const evaluated = evaluateModelInputBudget({
    rendered_input: renderedInput,
    router_version: policy.router_version,
    prompt_sha256: policy.prompt_sha256,
    stage_body_limit_tokens: 5_000,
    executor_context_floor_tokens: 8_192,
    prompt_reserve_tokens: 512,
    protocol_reserve_tokens: 256,
    output_reserve_tokens: 1_024,
    safety_margin_tokens: 256,
  });
  if (evaluated.status !== "within_limit") throw new Error("BR8 quality fixture must fit");
  return evaluated.proof;
}

interface ClosureFixture {
  policy_set: AutomaticBuildStagePolicySetV2;
  work_units: WorkUnitDescriptorV3[];
  artifacts: Record<string, SemanticArtifactEnvelopeV3<unknown>>;
  routing: AutomaticBuildStageQualityRoutingEvidenceV2;
  fragment_ids: string[];
  final_id: string;
}

function closure(fragmentCount: number): ClosureFixture {
  const currentPolicySet = policySet();
  const fragmentUnits = Array.from({ length: fragmentCount }, (_, ordinal) => {
    const start = Math.floor(parentLength * ordinal / fragmentCount);
    const end = Math.floor(parentLength * (ordinal + 1) / fragmentCount);
    const rendered = `fragment:${ordinal}:${start}:${end}\n`;
    const budgetProof = proof(rendered, fragmentPolicy);
    return createWorkUnitDescriptorV3({
      target: targetRef,
      stage: "pass1",
      work_unit_id: `fragment-${fragmentCount}-${ordinal}`,
      kind: "pass1_source_slice",
      input_basis: {
        kind: "source_slices",
        slices: [{
          version: "model_input_slice.v1",
          source_fingerprint: targetRef.input_fingerprint,
          parent_lid: parentLid,
          ordinal,
          core_span_utf16: { start, end },
          context_span_utf16: { start, end },
          boundary_kind: "sentence",
          core_sha256: sha256(`core:${start}:${end}`),
          context_sha256: sha256(`core:${start}:${end}`),
        }],
      },
      input_hash: budgetProof.rendered_input_sha256,
      input_budget_proof: budgetProof,
      policy_fingerprint: fragmentPolicy,
      evidence_lids: [parentLid],
      cost: buildWorkUnitCostFromBudgetProof({
        rendered_input: rendered,
        proof: budgetProof,
        visible_lids: 1,
        expected_output_items: 1,
      }),
      aggregation: { parent_lid: parentLid, role: "fragment" },
    });
  });
  const fragmentArtifacts = Object.fromEntries(fragmentUnits.map((descriptor, ordinal) => [
    descriptor.work_unit_id,
    buildSemanticArtifactEnvelopeV3({
      target: targetRef,
      stage: "pass1",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      proof_digest: descriptor.input_budget_proof.proof_digest,
      policy_set_digest: currentPolicySet.policy_set_digest,
      policy_fingerprint: descriptor.policy_fingerprint,
      provenance: {
        executor: "br8-test",
        model: "codex-test",
        attempt: 1,
        generated_at: "2026-08-04T00:01:00.000Z",
      },
      payload: { observation: ordinal },
    }),
  ]));
  const dependencies = fragmentUnits.map((descriptor) => ({
    artifact: descriptor.work_unit_id,
    sha256: fragmentArtifacts[descriptor.work_unit_id].artifact_hash,
  }));
  const finalRendered = `${JSON.stringify(dependencies)}\n`;
  const finalProof = proof(finalRendered, finalPolicy);
  const finalId = `final-${fragmentCount}`;
  const finalUnit = createWorkUnitDescriptorV3({
    target: targetRef,
    stage: "pass1",
    work_unit_id: finalId,
    kind: "pass1_lid_stitch",
    input_basis: {
      kind: "artifact_reduction",
      dependency_artifacts: dependencies.map((dependency) => ({
        work_unit_id: dependency.artifact,
        artifact_hash: dependency.sha256,
      })),
      parent_lids: [parentLid],
    },
    input_hash: finalProof.rendered_input_sha256,
    input_budget_proof: finalProof,
    policy_fingerprint: finalPolicy,
    evidence_lids: [parentLid],
    dependencies,
    cost: buildWorkUnitCostFromBudgetProof({
      rendered_input: finalRendered,
      proof: finalProof,
      visible_lids: 1,
      expected_output_items: 1,
    }),
    aggregation: { parent_lid: parentLid, role: "final" },
  });
  const finalArtifact = buildSemanticArtifactEnvelopeV3({
    target: targetRef,
    stage: "pass1",
    work_unit_id: finalUnit.work_unit_id,
    input_hash: finalUnit.input_hash,
    proof_digest: finalUnit.input_budget_proof.proof_digest,
    policy_set_digest: currentPolicySet.policy_set_digest,
    policy_fingerprint: finalUnit.policy_fingerprint,
    provenance: {
      executor: "br8-test",
      model: "codex-test",
      attempt: 1,
      generated_at: "2026-08-04T00:02:00.000Z",
    },
    payload: {
      nodes: [{
        id: `claim:${parentLid}:grounded`,
        type: "claim",
        name: "Grounded claim",
        occurrences: [],
        source_lid: parentLid,
      }],
      edges: [],
    },
  });
  const routing: AutomaticBuildStageQualityRoutingEvidenceV2 = {
    policy_set: currentPolicySet,
    coverage: [{
      version: "model_input_slice_coverage.v1",
      parent_lid: parentLid,
      parent_span_utf16: { start: 0, end: parentLength },
      slice_count: fragmentCount,
      expected_core_utf16: parentLength,
      covered_core_utf16: parentLength,
      gap_utf16: 0,
      core_overlap_utf16: 0,
      coverage_digest: sha256(`coverage:${fragmentCount}`),
    }],
    public_contributors: [{
      contributor_id: `pass1-parent:${parentLid}`,
      work_unit_id: finalId,
      parent_lids: [parentLid],
    }],
    reduction_parents: [{
      parent_lid: parentLid,
      fragment_work_unit_ids: fragmentUnits.map((descriptor) => descriptor.work_unit_id),
      final_work_unit_ids: [finalId],
    }],
  };
  return {
    policy_set: currentPolicySet,
    work_units: [...fragmentUnits, finalUnit],
    artifacts: { ...fragmentArtifacts, [finalId]: finalArtifact },
    routing,
    fragment_ids: fragmentUnits.map((descriptor) => descriptor.work_unit_id),
    final_id: finalId,
  };
}

function evaluate(input: ClosureFixture) {
  return evaluateAutomaticBuildStageQualityV2({
    target_ref: targetRef,
    stage: "pass1",
    quality_profile: "full",
    work_units: input.work_units,
    artifacts: input.artifacts,
    routing: input.routing,
  });
}

describe("BR8 automatic build quality report v2", () => {
  it("keeps the public quality denominator stable across 1, 2, or 20 fragments", () => {
    const reports = [1, 2, 20].map((count) => evaluate(closure(count)));

    expect(reports.map((report) => report.version)).toEqual([
      "automatic_build_stage_quality_report.v2",
      "automatic_build_stage_quality_report.v2",
      "automatic_build_stage_quality_report.v2",
    ]);
    expect(reports.map((report) => report.accounting.eligible_units)).toEqual([1, 1, 1]);
    expect(reports.map((report) => report.quality.metrics.eligible_unit_coverage)).toEqual([1, 1, 1]);
    expect(reports.map((report) => report.routing.eligible_model_units)).toEqual([2, 3, 21]);
    expect(reports.every((report) => report.gate_status === "passed")).toBe(true);
  });

  it("reports routing, exact coverage, and a fresh reduction closure", () => {
    const input = closure(2);
    const report = evaluate(input);

    expect(report).toMatchObject({
      gate_status: "passed",
      routing: {
        policy_set_digest: input.policy_set.policy_set_digest,
        eligible_model_units: 3,
        proven_model_units: 3,
        invalid_or_missing_proofs: 0,
      },
      coverage: {
        parent_lids: 1,
        expected_core_utf16: parentLength,
        covered_core_utf16: parentLength,
        gap_utf16: 0,
        core_overlap_utf16: 0,
      },
      reduction: {
        fragment_units: 2,
        final_units: 1,
        missing_or_duplicate_parent_lids: 0,
      },
    });
    expect(report.coverage.coverage_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails independently on a coverage gap, duplicate final, missing child, or policy-set outsider", () => {
    const gap = closure(2);
    gap.routing.coverage[0] = {
      ...gap.routing.coverage[0],
      covered_core_utf16: parentLength - 1,
      gap_utf16: 1,
    };
    expect(evaluate(gap)).toMatchObject({
      gate_status: "integrity_failed",
      coverage: { gap_utf16: 1 },
      integrity: { violations: expect.arrayContaining(["source_slice_coverage_invalid"]) },
    });

    const duplicate = closure(2);
    duplicate.routing.reduction_parents[0] = {
      ...duplicate.routing.reduction_parents[0],
      final_work_unit_ids: [duplicate.final_id, `${duplicate.final_id}-duplicate`],
    };
    expect(evaluate(duplicate)).toMatchObject({
      gate_status: "integrity_failed",
      reduction: { missing_or_duplicate_parent_lids: 1 },
      integrity: { violations: expect.arrayContaining(["public_contributor_cardinality_invalid"]) },
    });

    const missing = closure(2);
    delete missing.artifacts[missing.fragment_ids[0]];
    expect(evaluate(missing)).toMatchObject({
      gate_status: "integrity_failed",
      integrity: {
        missing_artifacts: 1,
        violations: expect.arrayContaining(["reduction_dependency_closure_stale"]),
      },
    });

    const outsider = closure(2);
    outsider.routing.policy_set = policySet(
      pass1ModelSlicePolicyMembers(profile).filter((member) => member.kind !== "pass1_lid_stitch"),
    );
    expect(evaluate(outsider)).toMatchObject({
      gate_status: "integrity_failed",
      routing: { invalid_or_missing_proofs: 1 },
      integrity: { violations: expect.arrayContaining(["policy_set_member_invalid"]) },
    });
  });

  it("rejects fresh model units that are orphaned from every public contributor closure", () => {
    const orphaned = closure(2);
    orphaned.routing = {
      ...orphaned.routing,
      coverage: [],
      public_contributors: [],
      reduction_parents: [],
    };

    expect(evaluate(orphaned)).toMatchObject({
      gate_status: "integrity_failed",
      integrity: {
        violations: expect.arrayContaining(["incomplete_eligible_closure"]),
      },
    });
  });
});
