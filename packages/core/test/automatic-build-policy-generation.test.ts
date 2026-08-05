import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  automaticBuildPolicyMigrationReceiptPath,
  automaticBuildStagePolicySetPath,
  createAutomaticBuildStagePolicySet,
  freezeAutomaticBuildStagePolicySet,
  recordAutomaticBuildPolicyMigration,
  resolveAutomaticBuildPolicyGeneration,
  type AutomaticBuildPolicyMigrationCurrent,
} from "../src/automatic-build-policy-generation";
import { migrateAutomaticBuildPolicyAndReplan } from "../src/automatic-build-shadow-routing";
import { readyAutomaticBuildRoute } from "../src/automatic-build-recovery";
import {
  assertActiveAutomaticBuildLease,
  claimAutomaticBuildTask,
} from "../src/automatic-build-lease";
import { automaticBuildLegacyStageArtifactPath } from "../src/automatic-build-legacy";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { evaluateModelInputBudget } from "../src/model-input-budget";
import {
  automaticBuildExtractionPolicy,
  buildSemanticArtifactEnvelope,
  buildSemanticArtifactEnvelopeV3,
  freezeAutomaticBuildStagePolicy,
  writeAutomaticBuildGenerationArtifact,
} from "../src/semantic-artifact";
import {
  buildWorkUnitCost,
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptor,
  createWorkUnitDescriptorV3,
  taskPolicyBindingForWorkUnit,
  type WorkUnitDescriptorV2,
  type WorkUnitDescriptorV3,
} from "../src/stage-work-unit";

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

function treeDigest(root: string): string {
  const identities = filesRecursive(root).map((file) => ({
    path: path.relative(root, file).replaceAll("\\", "/"),
    sha256: sha256(readFileSync(file)),
  }));
  return sha256(JSON.stringify(identities));
}

function fixture(label: string) {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-policy-generation-${label}-`));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA canonical paragraph.\n", "utf8");
  const target = resolveAutomaticBuildTarget(source, root);
  const oldPolicy = automaticBuildExtractionPolicy(
    "profile_sidecar",
    resolveContentProfile("technical_learning"),
    "full",
  );
  const currentPolicy = {
    ...oldPolicy,
    router_version: "profile_sidecar_semantic_units.v3",
  };
  const policySet = createAutomaticBuildStagePolicySet({
    target_ref: target.target_ref,
    stage: "profile_sidecar",
    members: [
      {
        kind: "profile_sidecar_discourse",
        extractor: "profile-sidecar-extractor",
        policy_fingerprint: currentPolicy,
      },
      {
        kind: "profile_sidecar_formula",
        extractor: "profile-sidecar-extractor",
        policy_fingerprint: currentPolicy,
      },
    ],
    frozen_at: "2026-08-03T08:00:00.000Z",
  });
  const oldLock = freezeAutomaticBuildStagePolicy(
    target,
    "profile_sidecar",
    oldPolicy,
    "2026-08-03T07:00:00.000Z",
  );
  return { root, target, oldPolicy, currentPolicy, policySet, oldLock };
}

function oldDescriptor(
  input: ReturnType<typeof fixture>,
  workUnitId: string,
  rendered: string,
): WorkUnitDescriptorV2 {
  return createWorkUnitDescriptor({
    target: input.target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: workUnitId,
    kind: "profile_sidecar_discourse",
    input_hash: sha256(rendered),
    policy_fingerprint: input.oldPolicy,
    evidence_lids: ["1.1"],
    cost: buildWorkUnitCost({ estimated_input_tokens: 20, visible_lids: 1, expected_output_items: 1 }),
  });
}

function writeOldArtifact(
  input: ReturnType<typeof fixture>,
  descriptor: WorkUnitDescriptorV2,
): string {
  const artifactPath = automaticBuildLegacyStageArtifactPath(
    input.target,
    "profile_sidecar",
    descriptor.work_unit_id,
  );
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(buildSemanticArtifactEnvelope({
    target: input.target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: descriptor.work_unit_id,
    input_hash: descriptor.input_hash,
    policy_fingerprint: descriptor.policy_fingerprint,
    provenance: {
      executor: "codex-harness",
      model: "gpt-5.4-codex",
      attempt: 1,
      generated_at: "2026-08-03T07:30:00.000Z",
    },
    payload: {
      content_hash: descriptor.input_hash,
      discourse_items: [{ lid: "1.1", local_function: "explanation", relations: [] }],
      formula_semantics: [],
    },
  }), null, 2)}\n`, "utf8");
  return artifactPath;
}

function currentDescriptor(
  input: ReturnType<typeof fixture>,
  workUnitId: string,
  rendered: string,
): WorkUnitDescriptorV3 {
  const evaluated = evaluateModelInputBudget({
    rendered_input: rendered,
    router_version: input.currentPolicy.router_version,
    prompt_sha256: input.currentPolicy.prompt_sha256,
    stage_body_limit_tokens: 5_000,
    executor_context_floor_tokens: 8_192,
    prompt_reserve_tokens: 512,
    protocol_reserve_tokens: 256,
    output_reserve_tokens: 512,
    safety_margin_tokens: 256,
  });
  if (evaluated.status !== "within_limit") throw new Error("policy generation fixture exceeded its budget");
  return createWorkUnitDescriptorV3({
    target: input.target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: workUnitId,
    kind: "profile_sidecar_discourse",
    input_basis: {
      kind: "source_slices",
      slices: [{
        version: "model_input_slice.v1",
        source_fingerprint: input.target.target_ref.input_fingerprint,
        parent_lid: "1.1",
        ordinal: 0,
        core_span_utf16: { start: 0, end: 8 },
        context_span_utf16: { start: 0, end: 8 },
        boundary_kind: "whole_lid",
        core_sha256: sha256("12345678"),
        context_sha256: sha256("12345678"),
      }],
    },
    input_hash: evaluated.proof.rendered_input_sha256,
    input_budget_proof: evaluated.proof,
    policy_fingerprint: input.currentPolicy,
    evidence_lids: ["1.1"],
    cost: buildWorkUnitCostFromBudgetProof({
      rendered_input: rendered,
      proof: evaluated.proof,
      visible_lids: 1,
      expected_output_items: 1,
    }),
    aggregation: { parent_lid: "1.1", role: "final" },
  });
}

function modelCurrent(descriptor: WorkUnitDescriptorV3, renderedInput: string): AutomaticBuildPolicyMigrationCurrent {
  return { route: "model", descriptor, rendered_input: renderedInput };
}

describe("automatic build policy generation and selective migration", () => {
  it("freezes canonical policy sets and adopts exact v2 artifacts without mutating v2 history", () => {
    const input = fixture("adopt");
    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const previousDescriptor = oldDescriptor(input, "old-discourse", rendered);
    const previousArtifactPath = writeOldArtifact(input, previousDescriptor);
    const descriptor = currentDescriptor(input, "current-discourse", rendered);
    const current = modelCurrent(descriptor, rendered);
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);
    expect(freezeAutomaticBuildStagePolicySet(input.target, createAutomaticBuildStagePolicySet({
      target_ref: input.target.target_ref,
      stage: "profile_sidecar",
      members: [...input.policySet.members].reverse(),
      frozen_at: "2026-08-03T08:05:00.000Z",
    }))).toEqual(frozen);
    const v2Tree = path.join(input.target.workspace_dir, ".build", "automatic-build", "v2");
    const legacyTree = path.join(input.target.workspace_dir, ".build", "profile-sidecar");
    const before = { v2: treeDigest(v2Tree), legacy: treeDigest(legacyTree) };

    const first = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T08:10:00.000Z",
    });
    const replay = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T08:20:00.000Z",
    });

    expect(first).toMatchObject({
      version: "automatic_build_policy_migration_receipt.v1",
      decision: "adopt_exact",
      work_unit_id: descriptor.work_unit_id,
      adopted_artifact: {
        work_unit_id: previousDescriptor.work_unit_id,
        artifact_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        file_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(replay).toEqual(first);
    expect(resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set_digest: frozen.policy_set_digest,
      current_units: [current],
    })).toMatchObject({ status: "ready", adopted_units: [descriptor.work_unit_id] });
    expect({ v2: treeDigest(v2Tree), legacy: treeDigest(legacyTree) }).toEqual(before);
    expect(existsSync(automaticBuildStagePolicySetPath(
      input.target,
      "profile_sidecar",
      frozen.policy_set_digest,
    ))).toBe(true);

    let replans = 0;
    expect(migrateAutomaticBuildPolicyAndReplan({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T08:30:00.000Z",
    }, () => {
      replans += 1;
      return readyAutomaticBuildRoute({ next: "continued" as const });
    })).toEqual({ status: "ready", value: { next: "continued" } });
    expect(replans).toBe(1);
  });

  it("persists rebuild and deterministic-skip decisions, then resolves only after the v3 artifact is fresh", () => {
    const input = fixture("rebuild");
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);
    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA changed paragraph.\n";
    const descriptor = currentDescriptor(input, "rebuild-discourse", rendered);
    const current = modelCurrent(descriptor, rendered);
    const skip: AutomaticBuildPolicyMigrationCurrent = {
      route: "deterministic_skip",
      work_unit_id: "formula-skip",
      work_unit_kind: "profile_sidecar_formula",
      policy_fingerprint: input.currentPolicy,
      evidence_lids: ["1.1"],
      skip_code: "formula_without_grounding",
    };
    const rebuild = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      now: "2026-08-03T09:00:00.000Z",
    });
    const deterministicSkip = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current: skip,
      now: "2026-08-03T09:00:01.000Z",
    });
    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      now: "2026-08-03T09:01:00.000Z",
    })).toEqual(rebuild);
    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current: skip,
      now: "2026-08-03T09:01:01.000Z",
    })).toEqual(deterministicSkip);

    expect(rebuild).toMatchObject({ decision: "rebuild", reason: "no_previous_artifact" });
    expect(deterministicSkip).toMatchObject({ decision: "deterministic_skip", reason: "current_router_skip" });
    expect(resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set_digest: frozen.policy_set_digest,
      current_units: [current, skip],
    })).toMatchObject({ status: "pending", pending_rebuild_units: [descriptor.work_unit_id] });

    const generationArtifact = buildSemanticArtifactEnvelopeV3({
      target: input.target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      proof_digest: descriptor.input_budget_proof.proof_digest,
      policy_set_digest: frozen.policy_set_digest,
      policy_fingerprint: descriptor.policy_fingerprint,
      provenance: {
        executor: "codex-harness",
        model: "gpt-5.4-codex",
        attempt: 1,
        generated_at: "2026-08-03T09:10:00.000Z",
      },
      payload: {
        content_hash: descriptor.input_hash,
        discourse_items: [{ lid: "1.1", local_function: "explanation", relations: [] }],
        formula_semantics: [],
      },
    });
    const generationArtifactPath = writeAutomaticBuildGenerationArtifact(input.target, generationArtifact);
    expect(writeAutomaticBuildGenerationArtifact(input.target, generationArtifact)).toBe(generationArtifactPath);
    expect(() => writeAutomaticBuildGenerationArtifact(input.target, {
      ...generationArtifact,
      artifact_hash: "f".repeat(64),
    })).toThrow(/invalid/);
    expect(resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set_digest: frozen.policy_set_digest,
      current_units: [current, skip],
    })).toMatchObject({
      status: "ready",
      rebuilt_units: [descriptor.work_unit_id],
      deterministic_skip_units: [skip.work_unit_id],
    });
  });

  it("does not freeze a half migration while a v2 lease is active and forbids new v2 claims in v3-only mode", () => {
    const input = fixture("active-lease");
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);
    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const previousDescriptor = oldDescriptor(input, "active-v2", rendered);
    const previousArtifactPath = writeOldArtifact(input, previousDescriptor);
    const previousBinding = taskPolicyBindingForWorkUnit(previousDescriptor);
    const lease = claimAutomaticBuildTask(input.target, "profile_sidecar", previousDescriptor.work_unit_id, {
      owner: "old-generation-executor",
      now: "2026-08-03T10:00:00.000Z",
      reserve_ttl_ms: 60_000,
      binding: previousBinding,
      descriptor: previousDescriptor,
    });
    expect(lease.status).toBe("leased");
    if (lease.status !== "leased") throw new Error("expected an old-generation lease");
    const descriptor = currentDescriptor(input, "current-after-active-v2", rendered);
    const current = modelCurrent(descriptor, rendered);
    const blocked = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T10:00:30.000Z",
    });
    expect(blocked).toMatchObject({
      version: "automatic_build_policy_migration_block.v1",
      decision: "blocked",
      reason: "active_lease",
    });
    expect(existsSync(automaticBuildPolicyMigrationReceiptPath(
      input.target,
      "profile_sidecar",
      input.oldLock.policy_digest,
      frozen.policy_set_digest,
      descriptor.work_unit_id,
    ))).toBe(false);
    expect(assertActiveAutomaticBuildLease(
      input.target,
      lease.lease_ref,
      lease.lease.token,
      "2026-08-03T10:00:30.000Z",
    )).toEqual(lease.lease);

    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T10:02:00.000Z",
    })).toMatchObject({ decision: "adopt_exact" });

    const forbiddenV2 = oldDescriptor(input, "forbidden-new-v2", `${rendered}new\n`);
    expect(() => claimAutomaticBuildTask(input.target, "profile_sidecar", forbiddenV2.work_unit_id, {
      owner: "must-not-claim-v2",
      now: "2026-08-03T10:02:01.000Z",
      policy_generation: "v3_only",
      binding: taskPolicyBindingForWorkUnit(forbiddenV2),
      descriptor: forbiddenV2,
    })).toThrow(/v3 release forbids new v2 claims/);
  });

  it("fails closed on unverifiable old bytes and conflicting create-only decisions", () => {
    const input = fixture("conflict");
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);
    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const previousDescriptor = oldDescriptor(input, "old-conflict", rendered);
    const previousArtifactPath = writeOldArtifact(input, previousDescriptor);
    const descriptor = currentDescriptor(input, "current-conflict", rendered);
    const current = modelCurrent(descriptor, rendered);

    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current: {
        route: "blocked",
        work_unit_id: "atomic-formula",
        work_unit_kind: "profile_sidecar_formula",
        policy_fingerprint: input.currentPolicy,
        evidence_lids: ["1.1"],
        block_reason: "model_input_unsplittable",
        retryable: false,
      },
      now: "2026-08-03T10:59:59.000Z",
    })).toMatchObject({
      version: "automatic_build_policy_migration_block.v1",
      decision: "blocked",
      reason: "model_input_unsplittable",
    });
    expect(existsSync(automaticBuildPolicyMigrationReceiptPath(
      input.target,
      "profile_sidecar",
      input.oldLock.policy_digest,
      frozen.policy_set_digest,
      "atomic-formula",
    ))).toBe(false);

    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      previous: { descriptor: previousDescriptor, artifact_path: previousArtifactPath },
      now: "2026-08-03T11:00:00.000Z",
    })).toMatchObject({ decision: "blocked", reason: "previous_input_unverifiable" });

    const adopted = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T11:00:01.000Z",
    });
    const changedRendered = `${rendered}changed\n`;
    const changedCurrent = modelCurrent(currentDescriptor(input, descriptor.work_unit_id, changedRendered), changedRendered);
    expect(() => recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current: changedCurrent,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T11:00:02.000Z",
    })).toThrow(/policy_generation_conflict/);
    let conflictReplans = 0;
    expect(migrateAutomaticBuildPolicyAndReplan({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: input.oldLock.policy_digest,
      policy_set: frozen,
      current: changedCurrent,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-03T11:00:03.000Z",
    }, () => {
      conflictReplans += 1;
      return readyAutomaticBuildRoute({ next: "must-not-run" as const });
    })).toMatchObject({
      status: "blocked",
      recovery: {
        phase: "migration",
        code: "policy_generation_conflict",
        stage: "profile_sidecar",
        recovery_actions: ["migrate_policy"],
      },
    });
    expect(conflictReplans).toBe(0);
    const receiptPath = automaticBuildPolicyMigrationReceiptPath(
      input.target,
      "profile_sidecar",
      input.oldLock.policy_digest,
      frozen.policy_set_digest,
      descriptor.work_unit_id,
    );
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(adopted);
  });
});
