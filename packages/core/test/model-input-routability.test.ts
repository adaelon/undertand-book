import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditAutomaticBuildShadowRouting,
  SEMANTIC_AUTOMATIC_BUILD_STAGES,
} from "../src/automatic-build-shadow-routing";
import { evaluateModelInputBudget } from "../src/model-input-budget";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import {
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptorV3,
  type WorkUnitKind,
  type WorkUnitStage,
} from "../src/stage-work-unit";
import {
  automaticBuildNext,
  automaticBuildPlan,
  automaticBuildProtocolDoctor,
} from "../../../skills/build/automatic-build";
import { canonicalAutomaticBuildJson } from "../src/automatic-build-protocol";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";
import {
  closeSyntheticPass1,
  createSyntheticRoutabilityFixture,
} from "./helpers/model-input-routability-fixture";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const kindByStage: Record<WorkUnitStage, WorkUnitKind> = {
  pass1: "pass1_window",
  paper_metadata: "metadata_region",
  paper_lexicon: "lexicon_candidate_batch",
  profile_sidecar: "profile_sidecar_discourse",
  pass2: "pass2_candidate_batch",
  book_structure: "structure_unit",
};

describe("BR7 model-input routability", () => {
  it("audits all six semantic stages as proof-valid or one explicit block", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    const profile = resolveContentProfile("technical_learning");
    const parent = fixture.by_lid.get(fixture.paragraph_lid)!;
    const renderedInput = "bounded shadow input";
    const routes = SEMANTIC_AUTOMATIC_BUILD_STAGES.map((stage) => {
      const policy = automaticBuildExtractionPolicy(stage, profile, "full");
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
      if (evaluated.status !== "within_limit") throw new Error("fixture input must fit");
      const slice = {
        version: "model_input_slice.v1" as const,
        source_fingerprint: sha256(fixture.source),
        parent_lid: parent.lid,
        ordinal: 0,
        core_span_utf16: { ...parent.span },
        context_span_utf16: { ...parent.span },
        boundary_kind: "whole_lid" as const,
        core_sha256: sha256(fixture.paragraph_text),
        context_sha256: sha256(fixture.paragraph_text),
      };
      return {
        stage,
        deterministic_skips: 0,
        work_units: [{
          descriptor: createWorkUnitDescriptorV3({
            target: fixture.target.target_ref,
            stage,
            work_unit_id: `${stage}-shadow-unit`,
            kind: kindByStage[stage],
            input_basis: { kind: "source_slices", slices: [slice] },
            input_hash: evaluated.proof.rendered_input_sha256,
            input_budget_proof: evaluated.proof,
            policy_fingerprint: policy,
            evidence_lids: [parent.lid],
            cost: buildWorkUnitCostFromBudgetProof({
              rendered_input: renderedInput,
              proof: evaluated.proof,
              visible_lids: 1,
              expected_output_items: 1,
            }),
          }),
          rendered_input: renderedInput,
        }],
      };
    });

    const result = auditAutomaticBuildShadowRouting({
      target_ref: fixture.target.target_ref,
      stages: routes,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected a ready shadow audit");
    expect(result.value.stages).toHaveLength(6);
    expect(result.value.stages.map((stage) => stage.stage)).toEqual(
      SEMANTIC_AUTOMATIC_BUILD_STAGES,
    );
    expect(result.value.stages.every((stage) => (
      stage.eligible_work_units === stage.proof_valid_work_units
    ))).toBe(true);

    const invalidRoutes = routes.map((stage, index) => index === 3 ? {
      ...stage,
      work_units: stage.work_units.map((unit) => ({
        ...unit,
        descriptor: {
          ...unit.descriptor,
          input_budget_proof: {
            ...unit.descriptor.input_budget_proof,
            estimated_rendered_tokens: unit.descriptor.input_budget_proof.estimated_rendered_tokens + 1,
          },
        },
      })),
    } : stage);
    expect(auditAutomaticBuildShadowRouting({
      target_ref: fixture.target.target_ref,
      stages: invalidRoutes,
    })).toMatchObject({
      status: "blocked",
      recovery: {
        phase: "preflight",
        code: "budget_proof_invalid",
        stage: "profile_sidecar",
      },
    });

    const firstProof = routes[0].work_units[0].descriptor.input_budget_proof;
    const smallerExecutor = auditAutomaticBuildShadowRouting({
      target_ref: fixture.target.target_ref,
      stages: routes,
      executor_context_window_tokens: 4_000,
    });
    expect(smallerExecutor).toMatchObject({
      status: "blocked",
      recovery: {
        phase: "preflight",
        code: "executor_context_too_small",
        stage: "pass1",
        affected_work_units: [{
          work_unit_id: "pass1-shadow-unit",
          limit_tokens: 1_952,
        }],
        recovery_actions: ["upgrade_executor"],
      },
    });
    expect(routes[0].work_units[0].descriptor.input_budget_proof).toEqual(firstProof);
  });

  it("routes an over-limit pending Pass1 window into proof-bound v3 fragments before claim", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const taskRoot = path.join(
      fixture.target.workspace_dir,
      ".build",
      "automatic-build",
      "v2",
      "tasks",
    );

    const plan = automaticBuildPlan(fixture.source_file, fixture.root);
    const pass1 = plan.snapshot.stages.find((stage) => stage.stage === "pass1");
    expect(plan).toMatchObject({
      next_action: { kind: "extract", stage: "pass1" },
      preflight: {
        stage: "pass1",
        policy_generations: expect.arrayContaining([
          expect.objectContaining({
            kind: "pass1_source_slice",
            policy_generation_id: pass1?.policy_set?.members.find(
              (member) => member.kind === "pass1_source_slice",
            )?.policy_generation_id,
          }),
        ]),
      },
    });
    expect(pass1?.pending_work_units?.some((unit) => (
      unit.version === "automatic_build_work_unit.v3"
      && unit.kind === "pass1_source_slice"
      && unit.evidence_lids.includes(fixture.paragraph_lid)
    ))).toBe(true);
    expect(pass1?.work_units?.every((unit) => unit.version === "automatic_build_work_unit.v3"))
      .toBe(true);
    expect(existsSync(taskRoot)).toBe(false);
  });

  it("routes the synthetic 6,992-token profile paragraph canonically with zero implicit claims", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    closeSyntheticPass1(fixture);
    const taskRoot = path.join(
      fixture.target.workspace_dir,
      ".build",
      "automatic-build",
      "v2",
      "tasks",
    );

    const first = automaticBuildPlan(fixture.source_file, fixture.root);
    const second = automaticBuildPlan(fixture.source_file, fixture.root);
    const profile = first.snapshot.stages.find((stage) => stage.stage === "profile_sidecar");
    expect(first).toMatchObject({
      next_action: {
        kind: "extract",
        stage: "profile_sidecar",
        extractor: "profile-sidecar-discourse-fragment-extractor",
      },
      preflight: {
        stage: "profile_sidecar",
        policy_generations: expect.arrayContaining([
          expect.objectContaining({
            kind: "profile_sidecar_discourse_fragment",
            policy_generation_id: profile?.policy_set?.members.find(
              (member) => member.kind === "profile_sidecar_discourse_fragment",
            )?.policy_generation_id,
          }),
        ]),
      },
    });
    expect(profile?.pending_work_units?.some((unit) => (
      unit.version === "automatic_build_work_unit.v3"
      && unit.kind === "profile_sidecar_discourse_fragment"
      && unit.evidence_lids.includes(fixture.paragraph_lid)
    ))).toBe(true);
    expect(canonicalAutomaticBuildJson(first)).toBe(canonicalAutomaticBuildJson(second));
    expect(existsSync(taskRoot)).toBe(false);

    const previousSidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const packaged = automaticBuildPlan(fixture.source_file, fixture.root);
      expect(canonicalAutomaticBuildJson(packaged)).toBe(canonicalAutomaticBuildJson(first));
    } finally {
      if (previousSidecar === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previousSidecar;
    }

    expect(automaticBuildProtocolDoctor(fixture.source_file, fixture.root)).toMatchObject({
      version: "automatic_build_protocol_doctor.v3",
      status: "compatible",
      release: { version: "automatic_build_release.v3" },
      checks: {
        release_contract: {
          status: "compatible",
          model_input: { proven_members: 7 },
          readers: {
            recovery: { status: "compatible" },
            close: { status: "compatible" },
          },
        },
      },
      target_state: { dry_run_mutates_state: false },
    });

    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const productionBatch = spawnSync(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "skills", "build", "profile-sidecar-batch.ts"),
      fixture.source_file,
      "--book-id", fixture.target.book_id,
      "--content-profile", fixture.target.profile_id,
      "--production-policy-contracts", JSON.stringify(profile!.policy_set!.members.map((member) => ({
        kind: member.kind,
        policy_generation_id: member.policy_generation_id,
        semantic_contract: member.semantic_contract,
      }))),
    ], { cwd: fixture.root, encoding: "utf8" });
    expect(productionBatch.status).toBe(1);
    expect(productionBatch.stderr).toContain("production profile-sidecar generation still has pending work units");
    expect(productionBatch.stderr).not.toContain("ProfileSidecarRoutingBudgetBlock");

    const next = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      build_plan: buildPlan,
    });
    expect(next).toMatchObject({
      action: {
        kind: "needs_user",
        reason: "preflight_required",
        stage: "profile_sidecar",
      },
    });
    expect(existsSync(taskRoot)).toBe(false);
  }, 30_000);
});
