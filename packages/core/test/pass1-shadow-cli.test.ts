import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createAutomaticBuildStagePolicySet,
  freezeAutomaticBuildStagePolicySet,
} from "../src/automatic-build-policy-generation";
import { resolveContentProfile } from "../src/content-profile";
import type { GraphEdge } from "../src/generated/GraphEdge";
import type { GraphNode } from "../src/generated/GraphNode";
import type { ModelInputBudgetRequestV1 } from "../src/model-input-budget";
import type { Pass1LidStitchRenderInputV1 } from "../src/model-input-renderer";
import {
  PASS1_LID_STITCH_PROMPT_NAME,
  PASS1_LID_STITCH_PROMPT_SHA256,
  PASS1_LID_STITCH_SCHEMA_VERSION,
  PASS1_SOURCE_FRAGMENT_PROMPT_NAME,
  PASS1_SOURCE_FRAGMENT_PROMPT_SHA256,
  PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
  createPass1ShadowTask,
  freezePass1ShadowTask,
  pass1LidStitchPolicy,
  pass1ModelSlicePolicyMembers,
  pass1ShadowTaskPrivateDirectory,
  pass1SourceFragmentPolicy,
  routePass1ShadowWorkUnits,
  routePass1StitchLevel,
  verifyPass1ShadowArtifact,
  writePass1ShadowCandidate,
  type Pass1ShadowTaskV1,
  type Pass1ShadowVerifiedChildV1,
  type Pass1ShadowWorkUnitV1,
} from "../src/pass1-reduction";
import {
  automaticBuildExtractionPolicy,
  automaticBuildGenerationArtifactPath,
  type SemanticArtifactEnvelopeV3,
  type SemanticArtifactProvenanceV2,
} from "../src/semantic-artifact";
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
  executor: "pass1-shadow-cli-test",
  model: "codex-test",
  attempt: 1,
  generated_at: "2026-08-03T13:00:00.000Z",
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeFor(unit: Pass1ShadowWorkUnitV1): GraphNode {
  return {
    id: `concept:${sha256(unit.descriptor.work_unit_id).slice(0, 20)}`,
    type: "concept",
    name: `Pass1 node ${unit.route.source_unit_range.start_ordinal}`,
    occurrences: [unit.route.evidence_lids[0]],
    source_lid: null,
  };
}

function edge(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    type: "explains",
    direction: "directed",
    scope: "local",
    weight: 0.8,
  };
}

function initialCandidate(unit: Pass1ShadowWorkUnitV1): unknown {
  const node = nodeFor(unit);
  if (unit.route.role === "whole" || unit.route.role === "group") {
    return { nodes: [node], edges: [] };
  }
  if (unit.route.role !== "fragment" || unit.descriptor.input_basis.kind !== "source_slices") {
    throw new Error("expected an initial Pass1 source unit");
  }
  const slice = unit.descriptor.input_basis.slices[0];
  return {
    version: PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
    parent_lid: unit.route.parent_lid,
    source_slice_ordinal: slice.ordinal,
    core_sha256: slice.core_sha256,
    nodes: [node],
    edges: [],
  };
}

function stitchRenderInput(unit: Pass1ShadowWorkUnitV1): Pass1LidStitchRenderInputV1 {
  if (unit.route.role !== "stitch" && unit.route.role !== "final") {
    throw new Error("expected a Pass1 stitch work unit");
  }
  return JSON.parse(unit.rendered_input) as Pass1LidStitchRenderInputV1;
}

function projectedEdge(
  input: Pass1LidStitchRenderInputV1,
  minimumChildDistance: number,
  maximumChildDistance: number,
): GraphEdge | undefined {
  for (const [sourceIndex, sourceChild] of input.children.entries()) {
    for (let targetIndex = sourceIndex + minimumChildDistance;
      targetIndex < input.children.length && targetIndex <= sourceIndex + maximumChildDistance;
      targetIndex += 1) {
      for (const sourceNode of sourceChild.payload.nodes) {
        const targetNode = input.children[targetIndex].payload.nodes.find((node) => node.id !== sourceNode.id);
        if (targetNode) return edge(sourceNode.id, targetNode.id);
      }
    }
  }
  return undefined;
}

function stitchCandidate(unit: Pass1ShadowWorkUnitV1): unknown {
  const candidateEdge = projectedEdge(stitchRenderInput(unit), 1, 1);
  return {
    version: PASS1_LID_STITCH_SCHEMA_VERSION,
    edges: candidateEdge ? [candidateEdge] : [],
  };
}

function nonAdjacentStitchCandidate(unit: Pass1ShadowWorkUnitV1): unknown | undefined {
  const candidateEdge = projectedEdge(stitchRenderInput(unit), 2, Number.MAX_SAFE_INTEGER);
  return candidateEdge
    ? { version: PASS1_LID_STITCH_SCHEMA_VERSION, edges: [candidateEdge] }
    : undefined;
}

function runPass1Cli(input: {
  root: string;
  source_file: string;
  script: "emit-input.ts" | "pass1-write.ts" | "pass1-batch.ts";
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
  work_unit: Pass1ShadowWorkUnitV1;
  source_fingerprint: string;
  policy_set_digest: string;
  source_unit_count: number;
}): Pass1ShadowTaskV1 {
  const task = createPass1ShadowTask(input);
  freezePass1ShadowTask(input.target, task);
  return task;
}

function readEnvelope(file: string): SemanticArtifactEnvelopeV3<unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as SemanticArtifactEnvelopeV3<unknown>;
}

describe("Pass1 shadow CLI", () => {
  it("replays fragment/stitch tasks and emits one task-private legacy-compatible final candidate", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const profile = resolveContentProfile("technical_learning");
    const fragmentPolicy = pass1SourceFragmentPolicy(profile);
    const stitchPolicy = pass1LidStitchPolicy(profile);
    const members = pass1ModelSlicePolicyMembers(profile);
    expect(members.map((member) => [member.kind, member.extractor])).toEqual([
      ["pass1_window", "pass1-local-extractor"],
      ["pass1_source_slice", "pass1-source-fragment-extractor"],
      ["pass1_lid_stitch", "pass1-lid-stitcher"],
    ]);
    expect(fragmentPolicy.prompt_sha256).toBe(PASS1_SOURCE_FRAGMENT_PROMPT_SHA256);
    expect(stitchPolicy.prompt_sha256).toBe(PASS1_LID_STITCH_PROMPT_SHA256);
    expect(sha256(readFileSync(path.join(REPO_ROOT, "agents", PASS1_SOURCE_FRAGMENT_PROMPT_NAME), "utf8")))
      .toBe(PASS1_SOURCE_FRAGMENT_PROMPT_SHA256);
    expect(sha256(readFileSync(path.join(REPO_ROOT, "agents", PASS1_LID_STITCH_PROMPT_NAME), "utf8")))
      .toBe(PASS1_LID_STITCH_PROMPT_SHA256);

    const policySet = freezeAutomaticBuildStagePolicySet(
      fixture.target,
      createAutomaticBuildStagePolicySet({
        target_ref: fixture.target.target_ref,
        stage: "pass1",
        members,
        frozen_at: "2026-08-03T13:00:00.000Z",
      }),
    );
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
      fragment_policy: fragmentPolicy,
      whole_budget: BUDGET,
      fragment_budget: BUDGET,
      context_overlap_utf16: 64,
    });
    expect(routed.status).toBe("routed");
    if (routed.status !== "routed") throw new Error("synthetic long window should route");
    expect(routed.mode).toBe("split");
    expect(routed.units.some((unit) => unit.route.role === "fragment")).toBe(true);

    const initialChildren: Pass1ShadowVerifiedChildV1[] = [];
    let exercisedCliWrite = false;
    for (const unit of routed.units) {
      const task = freezeTask({
        target: fixture.target,
        work_unit: unit,
        source_fingerprint: fixture.identity.source_sha256,
        policy_set_digest: policySet.policy_set_digest,
        source_unit_count: routed.units.length,
      });
      const candidate = initialCandidate(unit);
      let artifactPath: string;
      if (!exercisedCliWrite && unit.route.role === "fragment") {
        exercisedCliWrite = true;
        const inputResult = runPass1Cli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "emit-input.ts",
          args: [
            unit.descriptor.work_unit_id,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", policySet.policy_set_digest,
          ],
        });
        expect(inputResult.status, inputResult.stderr).toBe(0);
        expect(inputResult.stdout).toBe(unit.rendered_input);

        const outsideCandidate = path.join(fixture.root, "outside-pass1-candidate.json");
        writeFileSync(outsideCandidate, JSON.stringify(candidate), "utf8");
        const outsideWrite = runPass1Cli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "pass1-write.ts",
          args: [
            unit.descriptor.work_unit_id,
            outsideCandidate,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", policySet.policy_set_digest,
          ],
        });
        expect(outsideWrite.status).toBe(1);
        expect(outsideWrite.stderr).toMatch(/task-private mailbox/i);

        const candidateDirectory = pass1ShadowTaskPrivateDirectory(
          fixture.target,
          policySet.policy_set_digest,
          unit.descriptor.work_unit_id,
        );
        mkdirSync(candidateDirectory, { recursive: true });
        const candidatePath = path.join(candidateDirectory, "candidate.json");
        writeFileSync(candidatePath, JSON.stringify(candidate), "utf8");
        const writeResult = runPass1Cli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "pass1-write.ts",
          args: [
            unit.descriptor.work_unit_id,
            candidatePath,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", policySet.policy_set_digest,
            "--attempt", "1",
            "--generated-at", PROVENANCE.generated_at,
            "--executor", PROVENANCE.executor,
            "--model", PROVENANCE.model!,
          ],
        });
        expect(writeResult.status, writeResult.stderr).toBe(0);
        artifactPath = (JSON.parse(writeResult.stdout) as { artifact_path: string }).artifact_path;

        const conflicting = unit.route.role === "fragment"
          ? { ...(candidate as Record<string, unknown>), nodes: [{ ...nodeFor(unit), name: "Conflicting name" }] }
          : candidate;
        writeFileSync(candidatePath, JSON.stringify(conflicting), "utf8");
        const conflictingWrite = runPass1Cli({
          root: fixture.root,
          source_file: fixture.source_file,
          script: "pass1-write.ts",
          args: [
            unit.descriptor.work_unit_id,
            candidatePath,
            "--book-id", fixture.target.book_id,
            "--shadow-generation", policySet.policy_set_digest,
            "--generated-at", PROVENANCE.generated_at,
          ],
        });
        expect(conflictingWrite.status).toBe(1);
        expect(conflictingWrite.stderr).toMatch(/policy_generation_conflict/i);
      } else {
        artifactPath = writePass1ShadowCandidate({
          target: fixture.target,
          source: fixture.source,
          task,
          candidate,
          provenance: PROVENANCE,
        }).artifact_path;
      }
      initialChildren.push(verifyPass1ShadowArtifact({
        work_unit: unit,
        artifact: readEnvelope(artifactPath),
        policy_set_digest: policySet.policy_set_digest,
      }));
    }
    expect(exercisedCliWrite).toBe(true);

    let children = initialChildren;
    let finalUnit: Pass1ShadowWorkUnitV1 | undefined;
    let finalTask: Pass1ShadowTaskV1 | undefined;
    let finalCandidatePath: string | undefined;
    while (!finalUnit) {
      const level = routePass1StitchLevel({
        target: fixture.target.target_ref,
        window_id: window.id,
        source_unit_count: routed.units.length,
        children,
        policy_set_digest: policySet.policy_set_digest,
        policy: stitchPolicy,
        budget: BUDGET,
      });
      expect(level.status).toBe("routed");
      if (level.status !== "routed") throw new Error("Pass1 stitch level should fit");
      const nextChildren: Pass1ShadowVerifiedChildV1[] = [];
      for (const unit of level.units) {
        const task = freezeTask({
          target: fixture.target,
          work_unit: unit,
          source_fingerprint: fixture.identity.source_sha256,
          policy_set_digest: policySet.policy_set_digest,
          source_unit_count: routed.units.length,
        });
        const candidate = stitchCandidate(unit);
        if (unit.route.role === "final") {
          finalUnit = unit;
          finalTask = task;

          const dependency = unit.descriptor.input_basis.kind === "artifact_reduction"
            ? unit.descriptor.input_basis.dependency_artifacts[0]
            : undefined;
          if (!dependency) throw new Error("final Pass1 stitch is missing dependencies");
          const dependencyArtifact = children.find((child) => (
            child.work_unit.descriptor.work_unit_id === dependency.work_unit_id
          ));
          if (!dependencyArtifact) throw new Error("final Pass1 dependency is missing");
          const dependencyPath = automaticBuildGenerationArtifactPath(
            fixture.target,
            "pass1",
            policySet.policy_set_digest,
            dependency.work_unit_id,
          );
          const dependencyBytes = readFileSync(dependencyPath, "utf8");
          const tampered = JSON.parse(dependencyBytes) as SemanticArtifactEnvelopeV3<Record<string, unknown>>;
          tampered.payload = { ...tampered.payload, nodes: [] };
          writeFileSync(dependencyPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
          const staleInput = runPass1Cli({
            root: fixture.root,
            source_file: fixture.source_file,
            script: "emit-input.ts",
            args: [
              unit.descriptor.work_unit_id,
              "--book-id", fixture.target.book_id,
              "--shadow-generation", policySet.policy_set_digest,
            ],
          });
          expect(staleInput.status).toBe(1);
          expect(staleInput.stdout).toBe("");
          expect(staleInput.stderr).toMatch(/stale or invalid/i);
          writeFileSync(dependencyPath, dependencyBytes, "utf8");

          const finalInput = runPass1Cli({
            root: fixture.root,
            source_file: fixture.source_file,
            script: "emit-input.ts",
            args: [
              unit.descriptor.work_unit_id,
              "--book-id", fixture.target.book_id,
              "--shadow-generation", policySet.policy_set_digest,
            ],
          });
          expect(finalInput.status, finalInput.stderr).toBe(0);
          expect(finalInput.stdout).toBe(unit.rendered_input);

          const candidateDirectory = pass1ShadowTaskPrivateDirectory(
            fixture.target,
            policySet.policy_set_digest,
            unit.descriptor.work_unit_id,
          );
          mkdirSync(candidateDirectory, { recursive: true });
          finalCandidatePath = path.join(candidateDirectory, "candidate.json");
          const nonAdjacentCandidate = nonAdjacentStitchCandidate(unit);
          expect(nonAdjacentCandidate).toBeDefined();
          if (nonAdjacentCandidate) {
            writeFileSync(finalCandidatePath, JSON.stringify(nonAdjacentCandidate), "utf8");
            const nonAdjacentWrite = runPass1Cli({
              root: fixture.root,
              source_file: fixture.source_file,
              script: "pass1-write.ts",
              args: [
                unit.descriptor.work_unit_id,
                finalCandidatePath,
                "--book-id", fixture.target.book_id,
                "--shadow-generation", policySet.policy_set_digest,
                "--generated-at", PROVENANCE.generated_at,
              ],
            });
            expect(nonAdjacentWrite.status).toBe(1);
            expect(nonAdjacentWrite.stderr).toMatch(/outside adjacent child boundary projections/i);
          }
          writeFileSync(finalCandidatePath, JSON.stringify(candidate), "utf8");
          const finalWrite = runPass1Cli({
            root: fixture.root,
            source_file: fixture.source_file,
            script: "pass1-write.ts",
            args: [
              unit.descriptor.work_unit_id,
              finalCandidatePath,
              "--book-id", fixture.target.book_id,
              "--shadow-generation", policySet.policy_set_digest,
              "--generated-at", PROVENANCE.generated_at,
            ],
          });
          expect(finalWrite.status, finalWrite.stderr).toBe(0);
        } else {
          const artifactPath = writePass1ShadowCandidate({
            target: fixture.target,
            source: fixture.source,
            task,
            candidate,
            provenance: PROVENANCE,
          }).artifact_path;
          nextChildren.push(verifyPass1ShadowArtifact({
            work_unit: unit,
            artifact: readEnvelope(artifactPath),
            policy_set_digest: policySet.policy_set_digest,
          }));
        }
      }
      if (!finalUnit) children = nextChildren;
    }
    if (!finalTask || !finalCandidatePath) throw new Error("Pass1 root final was not written");

    const nonFinalBatch = runPass1Cli({
      root: fixture.root,
      source_file: fixture.source_file,
      script: "pass1-batch.ts",
      args: [
        "--book-id", fixture.target.book_id,
        "--shadow-generation", policySet.policy_set_digest,
        "--shadow-final", routed.units[0].descriptor.work_unit_id,
      ],
    });
    expect(nonFinalBatch.status).toBe(1);
    expect(nonFinalBatch.stderr).toMatch(/root final/i);

    const batch = runPass1Cli({
      root: fixture.root,
      source_file: fixture.source_file,
      script: "pass1-batch.ts",
      args: [
        "--book-id", fixture.target.book_id,
        "--shadow-generation", policySet.policy_set_digest,
        "--shadow-final", finalUnit.descriptor.work_unit_id,
      ],
    });
    expect(batch.status, batch.stderr).toBe(0);
    const batchResult = JSON.parse(batch.stdout) as {
      candidate_path: string;
      candidate_sha256: string;
      work_unit_id: string;
      window_id: number;
    };
    expect(batchResult.work_unit_id).toBe(finalUnit.descriptor.work_unit_id);
    expect(batchResult.window_id).toBe(window.id);
    expect(batchResult.candidate_path).toContain(path.join("v3", "shadow", "pass1"));
    const publicCandidateBytes = readFileSync(batchResult.candidate_path, "utf8");
    expect(sha256(publicCandidateBytes)).toBe(batchResult.candidate_sha256);
    const publicCandidate = JSON.parse(publicCandidateBytes) as {
      content_hash: string;
      nodes: GraphNode[];
      edges: GraphEdge[];
    };
    expect(publicCandidate.content_hash).toBe(finalUnit.descriptor.input_hash);
    expect(publicCandidate.nodes.length).toBeGreaterThan(0);
    expect(publicCandidate.nodes.every((node) => (
      node.type === "claim"
        ? node.source_lid !== null && window.leafLids.includes(node.source_lid)
        : node.occurrences.every((lid) => window.leafLids.includes(lid))
    ))).toBe(true);
    expect(publicCandidate.edges.every((candidateEdge) => candidateEdge.scope === "local")).toBe(true);
    expect(existsSync(path.join(fixture.target.workspace_dir, "base.json"))).toBe(false);
    expect(existsSync(path.join(fixture.target.workspace_dir, ".build", "pass1", `${window.id}.json`))).toBe(false);

    writeFileSync(batchResult.candidate_path, "{}\n", "utf8");
    const conflictingBatch = runPass1Cli({
      root: fixture.root,
      source_file: fixture.source_file,
      script: "pass1-batch.ts",
      args: [
        "--book-id", fixture.target.book_id,
        "--shadow-generation", policySet.policy_set_digest,
        "--shadow-final", finalUnit.descriptor.work_unit_id,
      ],
    });
    expect(conflictingBatch.status).toBe(1);
    expect(conflictingBatch.stderr).toMatch(/policy_generation_conflict/i);
  }, 60_000);
});
