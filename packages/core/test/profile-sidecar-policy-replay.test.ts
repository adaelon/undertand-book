import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { recordAutomaticBuildInputObservation } from "../src/automatic-build-metrics";
import {
  failAutomaticBuildTask,
  stageAutomaticBuildCandidate,
  submitAutomaticBuildCandidate,
} from "../src/automatic-build-mailbox";
import {
  publishAutomaticBuildArtifactSet,
  validateAutomaticBuildPublicationReceipt,
} from "../src/automatic-build-publication";
import { evaluateAutomaticBuildStageQualityV2 } from "../src/automatic-build-quality";
import {
  automaticBuildTaskAttemptDirectory,
  automaticBuildTaskStoreRoot,
  nextAutomaticBuildExecutionIdentity,
} from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import {
  createAutomaticBuildFailureDiagnostic,
  parseExtractorCandidate,
} from "../src/extractor-contract";
import {
  buildSemanticArtifactEnvelopeV3,
  writeAutomaticBuildGenerationArtifact,
} from "../src/semantic-artifact";
import { MODEL_INPUT_RENDER_CONTRACT_VERSION } from "../src/model-input-renderer";
import { profileSidecarPolicyScopeFixture } from "./fixtures/profile-sidecar-contract-drift/policy-scope";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function filesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(root, entry.name);
    return entry.isDirectory() ? filesRecursive(item) : entry.isFile() ? [item] : [];
  }).sort();
}

function attemptTreeSnapshot(attemptDirectories: string[]): Array<{ path: string; sha256: string }> {
  const commonRoot = path.dirname(attemptDirectories[0]!);
  return attemptDirectories.flatMap((directory) => filesRecursive(directory).map((file) => ({
    path: path.relative(commonRoot, file).replaceAll("\\", "/"),
    sha256: sha256(readFileSync(file)),
  }))).sort((left, right) => left.path.localeCompare(right.path));
}

describe("SR6 profile-sidecar policy replay", () => {
  it("rebuilds v2 at semantic attempt one and publishes without rewriting exhausted v1 history", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-profile-policy-replay-"));
    const source = path.join(root, "synthetic-paper.md");
    writeFileSync(source, "# Synthetic paper\n\nSynthetic profile-sidecar evidence.\n", "utf8");
    const resolvedTarget = resolveAutomaticBuildTarget(source, root);
    const target = {
      ...resolvedTarget,
      kind: "paper_workspace" as const,
      profile_id: "paper" as const,
      target_ref: { ...resolvedTarget.target_ref, profile_id: "paper" as const },
    };
    const fixture = profileSidecarPolicyScopeFixture(target);
    const scopeA = fixture.replay.v1;
    const scopeB = fixture.replay.v2;
    const schemaInvalid = createAutomaticBuildFailureDiagnostic({
      category: "schema",
      code: "schema_invalid",
      json_pointer: "/discourse_items/0/local_summary",
      expected: "string length <= 200",
    });

    for (let semanticAttempt = 1; semanticAttempt <= 3; semanticAttempt += 1) {
      const claim = claimAutomaticBuildTask(
        target,
        scopeA.descriptor.stage,
        scopeA.descriptor.work_unit_id,
        {
          owner: `profile-policy-v1-${semanticAttempt}`,
          now: `2026-08-10T04:00:0${semanticAttempt}.000Z`,
          descriptor: scopeA.descriptor,
          binding: scopeA.scope.task_binding,
          policy_generation: "v3_only",
          max_semantic_attempts: 3,
        },
      );
      if (claim.status !== "leased") throw new Error(`expected v1 semantic attempt ${semanticAttempt}`);
      failAutomaticBuildTask(target, claim.lease_ref, claim.lease.token, {
        failure_diagnostic: schemaInvalid,
        now: `2026-08-10T04:00:0${semanticAttempt}.100Z`,
      });
    }

    expect(nextAutomaticBuildExecutionIdentity(
      target,
      scopeA.descriptor.stage,
      scopeA.descriptor.work_unit_id,
      {
        max_semantic_attempts: 3,
        max_lease_epochs: 3,
        attempt_scope: scopeA.scope,
      },
    )).toMatchObject({
      status: "retry_exhausted",
      semantic_attempt: 3,
      attempt_scope_digest: scopeA.scope.attempt_scope_digest,
      failure_diagnostic: { category: "schema", code: "schema_invalid" },
    });

    const scopeAAttempts = [1, 2, 3].map((attempt) => automaticBuildTaskAttemptDirectory(
      target,
      scopeA.descriptor.stage,
      scopeA.descriptor.work_unit_id,
      attempt,
    ));
    const scopeABefore = attemptTreeSnapshot(scopeAAttempts);
    expect(scopeABefore.some((entry) => entry.path.endsWith("failure.json"))).toBe(true);

    const claimB = claimAutomaticBuildTask(
      target,
      scopeB.descriptor.stage,
      scopeB.descriptor.work_unit_id,
      {
        owner: "profile-policy-v2-1",
        now: "2026-08-11T04:00:04.000Z",
        descriptor: scopeB.descriptor,
        binding: scopeB.scope.task_binding,
        policy_generation: "v3_only",
        max_semantic_attempts: 3,
      },
    );
    expect(claimB).toMatchObject({
      status: "leased",
      lease: {
        attempt: 4,
        attempt_scope_digest: scopeB.scope.attempt_scope_digest,
      },
      execution_identity: {
        semantic_attempt: 1,
        lease_epoch: 1,
        attempt_scope_digest: scopeB.scope.attempt_scope_digest,
      },
    });
    if (claimB.status !== "leased") throw new Error("expected the v2 policy scope to claim");
    expect(scopeB.scope.attempt_scope_digest).not.toBe(scopeA.scope.attempt_scope_digest);
    recordAutomaticBuildInputObservation(target, claimB.lease_ref, claimB.lease.token, {
      started_at: "2026-08-11T04:00:04.050Z",
      finished_at: "2026-08-11T04:00:04.075Z",
      input_bytes: 0,
      input_sha256: scopeB.descriptor.input_hash,
      proof_digest: scopeB.descriptor.input_budget_proof.proof_digest,
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    });

    const candidateSource = path.join(root, "profile-sidecar-v2-candidate.json");
    writeFileSync(candidateSource, `${JSON.stringify({
      discourse_items: [{
        lid: "1.1",
        mode: "informative",
        local_function: "explanation",
        rhetorical_move: "main_point",
        local_summary: "Explains the synthetic profile-sidecar evidence.",
        relations: [],
      }],
    })}\n`, "utf8");
    const staged = stageAutomaticBuildCandidate(
      target,
      claimB.lease_ref,
      claimB.lease.token,
      candidateSource,
      { now: "2026-08-11T04:00:04.100Z" },
    );
    let artifactPath = "";
    const committed = submitAutomaticBuildCandidate(
      target,
      claimB.lease_ref,
      claimB.lease.token,
      staged.candidate_path,
      () => {
        const candidate = parseExtractorCandidate(
          "profile_sidecar",
          JSON.parse(readFileSync(staged.candidate_path, "utf8")),
          { allowed_evidence_lids: ["1.1"], formula_lids: [] },
        );
        const envelope = buildSemanticArtifactEnvelopeV3({
          target: target.target_ref,
          stage: "profile_sidecar",
          work_unit_id: scopeB.descriptor.work_unit_id,
          input_hash: scopeB.descriptor.input_hash,
          proof_digest: scopeB.descriptor.input_budget_proof.proof_digest,
          policy_set_digest: scopeB.policy_set.policy_set_digest,
          policy_fingerprint: scopeB.descriptor.policy_fingerprint,
          provenance: {
            executor: "sr6-synthetic-replay",
            model: "codex-test",
            attempt: claimB.lease.attempt,
            generated_at: "2026-08-11T04:00:04.200Z",
          },
          payload: { content_hash: scopeB.descriptor.input_hash, ...candidate },
        });
        artifactPath = writeAutomaticBuildGenerationArtifact(target, envelope);
        return {
          artifact_path: artifactPath,
          output_counts: {
            discourse_items: candidate.discourse_items?.length ?? 0,
            formula_semantics: candidate.formula_semantics?.length ?? 0,
          },
        };
      },
      { now: "2026-08-11T04:00:04.300Z", completed_at: "2026-08-11T04:00:04.300Z" },
    );
    expect(committed).toMatchObject({
      state: "committed",
      attempt: 4,
      attempt_scope_digest: scopeB.scope.attempt_scope_digest,
    });

    const slice = scopeB.descriptor.input_basis.kind === "source_slices"
      ? scopeB.descriptor.input_basis.slices[0]
      : undefined;
    if (!slice) throw new Error("expected one synthetic profile-sidecar source slice");
    const spanLength = slice.core_span_utf16.end - slice.core_span_utf16.start;
    const quality = evaluateAutomaticBuildStageQualityV2({
      target_ref: target.target_ref,
      stage: "profile_sidecar",
      quality_profile: "full",
      work_units: [scopeB.descriptor],
      artifacts: {
        [scopeB.descriptor.work_unit_id]: JSON.parse(readFileSync(artifactPath, "utf8")),
      },
      routing: {
        policy_set: scopeB.policy_set,
        coverage: [{
          version: "model_input_slice_coverage.v1",
          parent_lid: slice.parent_lid,
          parent_span_utf16: { ...slice.core_span_utf16 },
          slice_count: 1,
          expected_core_utf16: spanLength,
          covered_core_utf16: spanLength,
          gap_utf16: 0,
          core_overlap_utf16: 0,
          coverage_digest: sha256("sr6-profile-sidecar-v2-coverage"),
        }],
        public_contributors: [{
          contributor_id: `profile-sidecar:${slice.parent_lid}`,
          work_unit_id: scopeB.descriptor.work_unit_id,
          parent_lids: [slice.parent_lid],
        }],
        reduction_parents: [],
      },
    });
    expect(quality).toMatchObject({
      gate_status: "passed",
      integrity: { status: "passed", policy_generations: 1 },
      quality: { status: "passed", grounded_units: 1 },
    });

    const publication = publishAutomaticBuildArtifactSet({
      workspace_dir: target.workspace_dir,
      stage: "profile_sidecar",
      artifacts: {
        "discourse_index.json": `${JSON.stringify({
          version: "synthetic_discourse_index.v1",
          items: [{ lid: "1.1", summary: "Explains the synthetic evidence." }],
        }, null, 2)}\n`,
        "formula_semantics.json": `${JSON.stringify({
          version: "synthetic_formula_semantics.v1",
          items: [],
        }, null, 2)}\n`,
      },
      validate_candidates: (candidatePaths) => {
        const discourse = JSON.parse(readFileSync(candidatePaths["discourse_index.json"]!, "utf8"));
        const formula = JSON.parse(readFileSync(candidatePaths["formula_semantics.json"]!, "utf8"));
        if (!Array.isArray(discourse.items) || !Array.isArray(formula.items)) {
          throw new Error("synthetic profile-sidecar public candidates are invalid");
        }
      },
    });
    expect(validateAutomaticBuildPublicationReceipt(publication, {
      stage: "profile_sidecar",
      transaction_id: publication.transaction_id,
    })).toEqual(publication);
    expect(publication.artifacts.map((artifact) => artifact.path)).toEqual([
      "discourse_index.json",
      "formula_semantics.json",
    ]);

    expect(attemptTreeSnapshot(scopeAAttempts)).toEqual(scopeABefore);
    const taskFiles = filesRecursive(automaticBuildTaskStoreRoot(target));
    expect(taskFiles.filter((file) => /(?:reset|recovery)\.json$/u.test(file))).toEqual([]);
  });
});
