import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createAutomaticBuildStagePolicySet,
  freezeAutomaticBuildStagePolicySet,
  resolveAutomaticBuildStagePolicyMember,
} from "../src/automatic-build-policy-generation";
import { resolveContentProfile } from "../src/content-profile";
import {
  PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_NAME,
  PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_SHA256,
  PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_NAME,
  PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_SHA256,
  createProfileSidecarDiscourseShadowTask,
  freezeProfileSidecarDiscourseShadowTask,
  profileSidecarDiscourseFragmentPolicy,
  profileSidecarDiscourseReducePolicy,
  profileSidecarDiscourseShadowTaskPrivateDirectory,
  profileSidecarMapReducePolicyMembers,
  routeProfileSidecarDiscourseFragmentWorkUnits,
  routeProfileSidecarDiscourseReductionLevel,
  verifyProfileSidecarDiscourseShadowArtifact,
  writeProfileSidecarDiscourseShadowCandidate,
  type ProfileSidecarDiscourseObservationV1,
  type ProfileSidecarDiscourseShadowTaskV1,
  type ProfileSidecarDiscourseShadowWorkUnitV1,
  type ProfileSidecarDiscourseVerifiedChildV1,
} from "../src/profile-sidecar-reduction";
import type {
  SemanticArtifactEnvelopeV3,
  SemanticArtifactProvenanceV2,
} from "../src/semantic-artifact";
import type { ModelInputBudgetRequestV1 } from "../src/model-input-budget";
import { createSyntheticRoutabilityFixture } from "./helpers/model-input-routability-fixture";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const BUDGET: Omit<ModelInputBudgetRequestV1, "rendered_input" | "router_version" | "prompt_sha256"> = {
  stage_body_limit_tokens: 5_000,
  executor_context_floor_tokens: 8_192,
  prompt_reserve_tokens: 512,
  protocol_reserve_tokens: 256,
  output_reserve_tokens: 1_024,
  safety_margin_tokens: 256,
};
const PROVENANCE: SemanticArtifactProvenanceV2 = {
  executor: "profile-sidecar-shadow-cli-test",
  model: "codex-test",
  attempt: 1,
  generated_at: "2026-08-03T12:00:00.000Z",
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function observationFor(unit: ProfileSidecarDiscourseShadowWorkUnitV1): ProfileSidecarDiscourseObservationV1 {
  if (unit.route.role !== "fragment" || unit.descriptor.input_basis.kind !== "source_slices") {
    throw new Error("expected one profile sidecar fragment unit");
  }
  const slice = unit.descriptor.input_basis.slices[0];
  return {
    version: "profile_sidecar_discourse_observation.v1",
    parent_lid: unit.route.parent_lid,
    source_slice_ordinal: slice.ordinal,
    core_sha256: slice.core_sha256,
    mode_candidates: [{ value: "informative", confidence: 0.9 }],
    local_function_candidates: [{ value: "explanation", confidence: 0.8 }],
    rhetorical_move_candidates: [{ value: "concept_elaboration", confidence: 0.8 }],
    summary_fragments: [`Bounded observation for source slice ${slice.ordinal}.`],
    relation_candidates: [],
  };
}

function runProfileSidecarCli(input: {
  root: string;
  source_file: string;
  script: "profile-sidecar-input.ts" | "profile-sidecar-write.ts" | "profile-sidecar-batch.ts";
  args: string[];
}) {
  return spawnSync(process.execPath, [
    TSX,
    path.join(REPO_ROOT, "skills", "build", input.script),
    input.source_file,
    ...input.args,
    "--content-profile",
    "technical_learning",
  ], {
    cwd: input.root,
    encoding: "utf8",
  });
}

function freezeTask(input: {
  target: ReturnType<typeof createSyntheticRoutabilityFixture>["target"];
  work_unit: ProfileSidecarDiscourseShadowWorkUnitV1;
  source_fingerprint: string;
  policy_generation_id: string;
  fragment_count: number;
}): ProfileSidecarDiscourseShadowTaskV1 {
  const task = createProfileSidecarDiscourseShadowTask(input);
  freezeProfileSidecarDiscourseShadowTask(input.target, task);
  return task;
}

function policyGenerationIdFor(
  policySet: ReturnType<typeof createAutomaticBuildStagePolicySet>,
  unit: ProfileSidecarDiscourseShadowWorkUnitV1,
): string {
  return resolveAutomaticBuildStagePolicyMember(
    policySet,
    unit.descriptor.kind,
    unit.descriptor.policy_fingerprint,
  ).policy_generation_id;
}

function readEnvelope(file: string): SemanticArtifactEnvelopeV3<unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as SemanticArtifactEnvelopeV3<unknown>;
}

describe("profile sidecar shadow CLI", () => {
  it("replays fragment/reducer tasks, validates task-private candidates, and folds one root final", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const profile = resolveContentProfile("technical_learning");
    const fragmentPolicy = profileSidecarDiscourseFragmentPolicy(profile);
    const reducePolicy = profileSidecarDiscourseReducePolicy(profile);
    const members = profileSidecarMapReducePolicyMembers(profile);
    expect(members.map((member) => [member.kind, member.extractor])).toEqual([
      ["profile_sidecar_discourse", "profile-sidecar-extractor"],
      ["profile_sidecar_discourse_fragment", "profile-sidecar-discourse-fragment-extractor"],
      ["profile_sidecar_discourse_reduce", "profile-sidecar-discourse-reducer"],
      ["profile_sidecar_formula", "profile-sidecar-extractor"],
    ]);
    expect(fragmentPolicy.prompt_sha256).toBe(PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_SHA256);
    expect(reducePolicy.prompt_sha256).toBe(PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_SHA256);
    expect(sha256(readFileSync(path.join(REPO_ROOT, "agents", PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_NAME), "utf8")))
      .toBe(PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_SHA256);
    expect(sha256(readFileSync(path.join(REPO_ROOT, "agents", PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_NAME), "utf8")))
      .toBe(PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_SHA256);

    const policySet = freezeAutomaticBuildStagePolicySet(
      fixture.target,
      createAutomaticBuildStagePolicySet({
        target_ref: fixture.target.target_ref,
        stage: "profile_sidecar",
        members,
        frozen_at: "2026-08-03T12:00:00.000Z",
      }),
    );
    const parent = fixture.by_lid.get(fixture.paragraph_lid)!;
    const routed = routeProfileSidecarDiscourseFragmentWorkUnits({
      target: fixture.target.target_ref,
      source: fixture.source,
      source_fingerprint: fixture.identity.source_sha256,
      parent,
      content_profile_id: profile.id,
      policy: fragmentPolicy,
      budget: BUDGET,
      context_overlap_utf16: 64,
    });
    expect(routed.status).toBe("routed");
    if (routed.status !== "routed") throw new Error("synthetic paragraph should be routable");
    expect(routed.units.length).toBeGreaterThan(1);
    expect(routed.units.length).toBeLessThanOrEqual(8);

    const children: ProfileSidecarDiscourseVerifiedChildV1[] = [];
    const artifactFiles: string[] = [];
    for (const [index, unit] of routed.units.entries()) {
      const task = freezeTask({
        target: fixture.target,
        work_unit: unit,
        source_fingerprint: fixture.identity.source_sha256,
        policy_generation_id: policyGenerationIdFor(policySet, unit),
        fragment_count: routed.units.length,
      });
      const candidate = observationFor(unit);
      let artifactFile: string;
      if (index === 0) {
        const inputResult = runProfileSidecarCli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "profile-sidecar-input.ts",
          args: [
            unit.descriptor.work_unit_id,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", task.policy_generation_id,
          ],
        });
        expect(inputResult.status, inputResult.stderr).toBe(0);
        expect(inputResult.stdout).toBe(unit.rendered_input);

        const outsideCandidate = path.join(fixture.root, "outside-candidate.json");
        writeFileSync(outsideCandidate, JSON.stringify(candidate), "utf8");
        const outsideWrite = runProfileSidecarCli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "profile-sidecar-write.ts",
          args: [
            unit.descriptor.work_unit_id,
            outsideCandidate,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", task.policy_generation_id,
          ],
        });
        expect(outsideWrite.status).toBe(1);
        expect(outsideWrite.stderr).toMatch(/task-private mailbox/i);

        const candidateDirectory = profileSidecarDiscourseShadowTaskPrivateDirectory(
          fixture.target,
          task.policy_generation_id,
          unit.descriptor.work_unit_id,
        );
        mkdirSync(candidateDirectory, { recursive: true });
        const candidatePath = path.join(candidateDirectory, "candidate.json");
        writeFileSync(candidatePath, JSON.stringify(candidate), "utf8");
        const writeResult = runProfileSidecarCli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "profile-sidecar-write.ts",
          args: [
            unit.descriptor.work_unit_id,
            candidatePath,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", task.policy_generation_id,
            "--attempt", "1",
            "--generated-at", PROVENANCE.generated_at,
            "--executor", PROVENANCE.executor,
            "--model", PROVENANCE.model!,
          ],
        });
        expect(writeResult.status, writeResult.stderr).toBe(0);
        artifactFile = (JSON.parse(writeResult.stdout) as { artifact_path: string }).artifact_path;

        writeFileSync(candidatePath, JSON.stringify({
          ...candidate,
          summary_fragments: ["A conflicting second candidate."],
        }), "utf8");
        const conflictingWrite = runProfileSidecarCli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "profile-sidecar-write.ts",
          args: [
            unit.descriptor.work_unit_id,
            candidatePath,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", task.policy_generation_id,
            "--generated-at", PROVENANCE.generated_at,
          ],
        });
        expect(conflictingWrite.status).toBe(1);
        expect(conflictingWrite.stderr).toMatch(/policy_generation_conflict/i);
      } else {
        artifactFile = writeProfileSidecarDiscourseShadowCandidate({
          target: fixture.target,
          source: fixture.source,
          task,
          candidate,
          provenance: PROVENANCE,
        }).artifact_path;
      }
      artifactFiles.push(artifactFile);
      children.push(verifyProfileSidecarDiscourseShadowArtifact({
        work_unit: unit,
        artifact: readEnvelope(artifactFile),
        policy_generation_id: task.policy_generation_id,
      }));
    }

    const reduction = routeProfileSidecarDiscourseReductionLevel({
      target: fixture.target.target_ref,
      parent_lid: fixture.paragraph_lid,
      fragment_count: routed.units.length,
      children,
      policy: reducePolicy,
      budget: BUDGET,
    });
    expect(reduction.status).toBe("routed");
    if (reduction.status !== "routed") throw new Error("root reduction should fit");
    expect(reduction.role).toBe("final");
    expect(reduction.units).toHaveLength(1);
    const finalUnit = reduction.units[0];
    const finalTask = freezeTask({
      target: fixture.target,
      work_unit: finalUnit,
      source_fingerprint: fixture.identity.source_sha256,
      policy_generation_id: policyGenerationIdFor(policySet, finalUnit),
      fragment_count: routed.units.length,
    });

    const firstArtifactBytes = readFileSync(artifactFiles[0], "utf8");
    const tamperedArtifact = JSON.parse(firstArtifactBytes) as SemanticArtifactEnvelopeV3<Record<string, unknown>>;
    tamperedArtifact.payload = { ...tamperedArtifact.payload, summary_fragments: ["tampered"] };
    writeFileSync(artifactFiles[0], `${JSON.stringify(tamperedArtifact, null, 2)}\n`, "utf8");
    const staleInput = runProfileSidecarCli({
      root: fixture.root,
      source_file: fixture.source_file,
      script: "profile-sidecar-input.ts",
      args: [
        finalUnit.descriptor.work_unit_id,
        "--book-id", fixture.target.book_id,
        "--shadow-generation", finalTask.policy_generation_id,
      ],
    });
    expect(staleInput.status).toBe(1);
    expect(staleInput.stdout).toBe("");
    expect(staleInput.stderr).toMatch(/stale or invalid/i);
    writeFileSync(artifactFiles[0], firstArtifactBytes, "utf8");

    const finalInput = runProfileSidecarCli({
      root: fixture.root,
      source_file: fixture.source_file,
      script: "profile-sidecar-input.ts",
      args: [
        finalUnit.descriptor.work_unit_id,
        "--book-id", fixture.target.book_id,
        "--shadow-generation", finalTask.policy_generation_id,
      ],
    });
    expect(finalInput.status, finalInput.stderr).toBe(0);
    expect(finalInput.stdout).toBe(finalUnit.rendered_input);

    const finalCandidateDirectory = profileSidecarDiscourseShadowTaskPrivateDirectory(
      fixture.target,
      finalTask.policy_generation_id,
      finalUnit.descriptor.work_unit_id,
    );
    mkdirSync(finalCandidateDirectory, { recursive: true });
    const finalCandidatePath = path.join(finalCandidateDirectory, "candidate.json");
    writeFileSync(finalCandidatePath, JSON.stringify({
      discourse_items: [{
        lid: fixture.paragraph_lid,
        mode: "informative",
        local_function: "explanation",
        rhetorical_move: "concept_elaboration",
        local_summary: "One final item for the original paragraph LID.",
        relations: [],
      }],
    }), "utf8");
    const finalWrite = runProfileSidecarCli({
      root: fixture.root,
      source_file: fixture.source_file,
      script: "profile-sidecar-write.ts",
      args: [
        finalUnit.descriptor.work_unit_id,
        finalCandidatePath,
        "--book-id", fixture.target.book_id,
        "--shadow-generation", finalTask.policy_generation_id,
        "--generated-at", PROVENANCE.generated_at,
      ],
    });
    expect(finalWrite.status, finalWrite.stderr).toBe(0);

    const batch = runProfileSidecarCli({
      root: fixture.root,
      source_file: fixture.source_file,
      script: "profile-sidecar-batch.ts",
      args: [
        "--book-id", fixture.target.book_id,
        "--shadow-generation", finalTask.policy_generation_id,
        "--shadow-final", finalUnit.descriptor.work_unit_id,
      ],
    });
    expect(batch.status, batch.stderr).toBe(0);
    const batchResult = JSON.parse(batch.stdout) as {
      candidate_path: string;
      candidate_sha256: string;
      parent_lid: string;
    };
    expect(batchResult.parent_lid).toBe(fixture.paragraph_lid);
    expect(batchResult.candidate_path).toContain(path.join("v3", "shadow", "profile_sidecar"));
    const publicCandidateBytes = readFileSync(batchResult.candidate_path, "utf8");
    expect(sha256(publicCandidateBytes)).toBe(batchResult.candidate_sha256);
    expect(JSON.parse(publicCandidateBytes)).toMatchObject({
      discourse_items: [{ lid: fixture.paragraph_lid }],
      formula_semantics: [],
    });
    expect(existsSync(path.join(fixture.target.workspace_dir, "discourse_index.json"))).toBe(false);
    expect(existsSync(path.join(fixture.target.workspace_dir, "formula_semantics.json"))).toBe(false);
  }, 60_000);
});
