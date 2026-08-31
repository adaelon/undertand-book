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
  automaticBuildPolicyGenerationPath,
  automaticBuildPolicyMigrationReceiptPath,
  createAutomaticBuildStagePolicySet,
  freezeAutomaticBuildStagePolicySet,
  materializeAdoptedAutomaticBuildGenerationArtifact,
  recordAutomaticBuildPriorGenerationAdoption,
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
  automaticBuildGenerationArtifactPath,
  automaticBuildExtractionPolicy,
  buildSemanticArtifactEnvelope,
  buildSemanticArtifactEnvelopeV3,
  freezeAutomaticBuildStagePolicy,
  semanticContractFromExtractionPolicy,
  writeAutomaticBuildGenerationArtifact,
  type ExtractionPolicyFingerprintV1,
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

function fixture(label: string, policies?: {
  oldPolicy: ExtractionPolicyFingerprintV1;
  currentPolicy: ExtractionPolicyFingerprintV1;
}) {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-policy-generation-${label}-`));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA canonical paragraph.\n", "utf8");
  const target = resolveAutomaticBuildTarget(source, root);
  const defaultPolicy = automaticBuildExtractionPolicy(
    "profile_sidecar",
    resolveContentProfile("technical_learning"),
    "full",
  );
  const oldPolicy = policies?.oldPolicy ?? defaultPolicy;
  const currentPolicy = policies?.currentPolicy ?? {
    ...defaultPolicy,
    router_version: "profile_sidecar_semantic_units.v3",
  };
  const policyMembers = [
    {
      kind: "profile_sidecar_discourse" as const,
      extractor: "profile-sidecar-extractor" as const,
      policy_generation_id: "profile-sidecar-discourse.test.v2",
      policy_fingerprint: currentPolicy,
    },
    {
      kind: "profile_sidecar_formula" as const,
      extractor: "profile-sidecar-extractor" as const,
      policy_generation_id: "profile-sidecar-formula.test.v2",
      policy_fingerprint: currentPolicy,
    },
  ];
  const policySet = createAutomaticBuildStagePolicySet({
    target_ref: target.target_ref,
    stage: "profile_sidecar",
    members: policyMembers,
    frozen_at: "2026-08-03T08:00:00.000Z",
  });
  const oldLock = freezeAutomaticBuildStagePolicy(
    target,
    "profile_sidecar",
    `profile_sidecar.${oldPolicy.stage_policy_version}.${oldPolicy.quality_profile}`,
    oldPolicy,
    "2026-08-03T07:00:00.000Z",
  );
  return { root, target, oldPolicy, currentPolicy, policyMembers, policySet, oldLock };
}

function policyMember(
  input: ReturnType<typeof fixture>,
  kind: "profile_sidecar_discourse" | "profile_sidecar_formula",
) {
  const member = input.policySet.members.find((candidate) => candidate.kind === kind);
  if (!member) throw new Error(`missing fixture policy member: ${kind}`);
  return member;
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

function writeDigestBoundGenerationArtifact(
  input: ReturnType<typeof fixture>,
  descriptor: WorkUnitDescriptorV3,
  sourceGenerationId: string,
): string {
  const payload = {
    content_hash: descriptor.input_hash,
    discourse_items: [{ lid: "1.1", local_function: "explanation", relations: [] }],
    formula_semantics: [],
  };
  const currentEnvelope = buildSemanticArtifactEnvelopeV3({
    target: input.target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: descriptor.work_unit_id,
    input_hash: descriptor.input_hash,
    policy_generation_id: sourceGenerationId,
    semantic_contract: semanticContractFromExtractionPolicy(input.currentPolicy),
    provenance: {
      executor: "codex-harness",
      model: "gpt-5.4-codex",
      attempt: 1,
      generated_at: "2026-08-03T07:30:00.000Z",
    },
    payload,
  });
  const predecessor = {
    version: "semantic_task_artifact.v3",
    target: currentEnvelope.target,
    stage: currentEnvelope.stage,
    work_unit_id: currentEnvelope.work_unit_id,
    input_hash: currentEnvelope.input_hash,
    proof_digest: sha256("legacy execution proof"),
    policy_set_digest: sourceGenerationId,
    policy_fingerprint: input.currentPolicy,
    artifact_hash: currentEnvelope.artifact_hash,
    provenance: currentEnvelope.provenance,
    payload: currentEnvelope.payload,
  };
  const artifactPath = automaticBuildGenerationArtifactPath(
    input.target,
    "profile_sidecar",
    sourceGenerationId,
    descriptor.work_unit_id,
  );
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(predecessor, null, 2)}\n`, "utf8");
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

function modelCurrent(
  descriptor: WorkUnitDescriptorV3,
  renderedInput: string,
): Extract<AutomaticBuildPolicyMigrationCurrent, { route: "model" }> {
  return { route: "model", descriptor, rendered_input: renderedInput };
}

describe("automatic build policy generation and selective migration", () => {
  it("keeps policy v1 history immutable and requires rebuild for direct profile_sidecar policy v2 changes", () => {
    const currentPolicy = automaticBuildExtractionPolicy(
      "profile_sidecar",
      resolveContentProfile("technical_learning"),
      "full",
    );
    const oldPolicy = {
      ...currentPolicy,
      stage_policy_version: "profile_sidecar_policy.v1",
      prompt_sha256: "0a56b04e68fc4fc86ae292eb0a57f59d2c85bd9b27e61e7da2d3b5c503da297a",
    };
    const input = fixture("profile-policy-v2", { oldPolicy, currentPolicy });
    const oldPolicySet = createAutomaticBuildStagePolicySet({
      target_ref: input.target.target_ref,
      stage: "profile_sidecar",
      members: input.policyMembers.map((member) => ({
        ...member,
        policy_generation_id: `${member.policy_generation_id}.legacy`,
        policy_fingerprint: oldPolicy,
      })),
      frozen_at: input.policySet.frozen_at,
    });
    expect(currentPolicy.stage_policy_version).toBe("profile_sidecar_policy.v2");
    expect(oldPolicy.stage_policy_version).not.toBe(currentPolicy.stage_policy_version);
    expect(oldPolicy.prompt_sha256).not.toBe(currentPolicy.prompt_sha256);
    expect(oldPolicySet.members[0].semantic_contract)
      .not.toEqual(input.policySet.members[0].semantic_contract);

    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const previousDescriptor = oldDescriptor(input, "policy-v1-discourse", rendered);
    const previousArtifactPath = writeOldArtifact(input, previousDescriptor);
    const previousArtifactBytes = readFileSync(previousArtifactPath);
    const descriptor = currentDescriptor(input, "policy-v2-discourse", rendered);
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);
    const migration = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current: modelCurrent(descriptor, rendered),
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-11T03:00:00.000Z",
    });
    expect(migration).toMatchObject({
      decision: "rebuild",
      reason: "semantic_policy_changed",
    });
    expect(readFileSync(previousArtifactPath)).toEqual(previousArtifactBytes);
    expect(resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current_units: [modelCurrent(descriptor, rendered)],
    })).toMatchObject({ status: "pending", pending_rebuild_units: [descriptor.work_unit_id] });
  });

  it("H0 removes policy-generation wrappers after direct stage, member, input, artifact, and skip fields decide", () => {
    const input = fixture("h0-forbidden-fields");
    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const previousDescriptor = oldDescriptor(input, "h0-old-discourse", rendered);
    const previousArtifactPath = writeOldArtifact(input, previousDescriptor);
    const descriptor = currentDescriptor(input, "h0-current-discourse", rendered);
    const current = modelCurrent(descriptor, rendered);
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);
    const adopted = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current,
      previous: {
        descriptor: previousDescriptor,
        rendered_input: rendered,
        artifact_path: previousArtifactPath,
      },
      now: "2026-08-30T01:00:00.000Z",
    });
    if (adopted.decision === "blocked") throw new Error("expected an H0 adoption receipt");
    const skip: AutomaticBuildPolicyMigrationCurrent = {
      route: "deterministic_skip",
      work_unit_id: "h0-formula-skip",
      work_unit_kind: "profile_sidecar_formula",
      policy_fingerprint: input.currentPolicy,
      evidence_lids: ["1.1"],
      skip_code: "formula_without_grounding",
    };
    const skipped = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current: skip,
      now: "2026-08-30T01:00:01.000Z",
    });
    if (skipped.decision === "blocked") throw new Error("expected an H0 deterministic-skip receipt");
    const resolution = resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current_units: [current, skip],
    });

    expect(input.policySet).toMatchObject({
      stage: "profile_sidecar",
      members: expect.arrayContaining([
        expect.objectContaining({ kind: "profile_sidecar_discourse" }),
        expect.objectContaining({ kind: "profile_sidecar_formula" }),
      ]),
    });
    expect(adopted).toMatchObject({
      decision: "adopt_exact",
      work_unit_id: descriptor.work_unit_id,
      current_input_hash: descriptor.input_hash,
    });
    expect(skipped).toMatchObject({
      decision: "deterministic_skip",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      to_policy_generation_id: policyMember(input, "profile_sidecar_formula").policy_generation_id,
      semantic_contract: policyMember(input, "profile_sidecar_formula").semantic_contract,
      deterministic_skip: { code: "formula_without_grounding", evidence_lids: ["1.1"] },
    });
    expect(resolution).toMatchObject({
      stage: "profile_sidecar",
      status: "ready",
      policy_generations: frozen.members.map((member) => ({
        kind: member.kind,
        policy_generation_id: member.policy_generation_id,
        semantic_contract: member.semantic_contract,
      })),
      adopted_units: [descriptor.work_unit_id],
      deterministic_skip_units: [skip.work_unit_id],
    });

    const present = [
      Object.hasOwn(input.oldLock, "policy_digest") ? "policy_digest" : undefined,
      Object.hasOwn(frozen, "policy_set_digest") ? "policy_set_digest" : undefined,
      Object.hasOwn(adopted, "from_policy_digest") ? "from_policy_digest" : undefined,
      Object.hasOwn(adopted, "to_policy_set_digest") ? "to_policy_set_digest" : undefined,
      Object.hasOwn(adopted, "current_route_digest") ? "current_route_digest" : undefined,
      Object.hasOwn(adopted, "current_policy_digest") ? "current_policy_digest" : undefined,
      Object.hasOwn(adopted, "current_proof_digest") ? "current_proof_digest" : undefined,
      Object.hasOwn(adopted, "receipt_digest") ? "receipt_digest" : undefined,
      Object.hasOwn(adopted.adopted_artifact ?? {}, "file_sha256") ? "file_sha256" : undefined,
      Object.hasOwn(skipped.deterministic_skip ?? {}, "evidence_digest") ? "evidence_digest" : undefined,
      Object.hasOwn(resolution, "resolution_digest") ? "resolution_digest" : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: H3 replaces these wrappers with stage+policy_generation_id and direct
    // member/input/receipt fields; H2 rechecks budget fields, and artifact_hash remains the body identity.
    expect(present).toEqual([]);
  });

  it("freezes canonical policy sets and adopts exact v2 artifacts without mutating v2 history", () => {
    const input = fixture("adopt");
    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const previousDescriptor = oldDescriptor(input, "old-discourse", rendered);
    const previousArtifactPath = writeOldArtifact(input, previousDescriptor);
    const descriptor = currentDescriptor(input, "current-discourse", rendered);
    const current = modelCurrent(descriptor, rendered);
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);
    const replayedPolicySet = freezeAutomaticBuildStagePolicySet(input.target, createAutomaticBuildStagePolicySet({
      target_ref: input.target.target_ref,
      stage: "profile_sidecar",
      members: [...input.policyMembers].reverse(),
      frozen_at: "2026-08-03T08:05:00.000Z",
    }));
    expect(replayedPolicySet.members).toEqual(frozen.members);
    const v2Tree = path.join(input.target.workspace_dir, ".build", "automatic-build", "v2");
    const legacyTree = path.join(input.target.workspace_dir, ".build", "profile-sidecar");
    const before = { v2: treeDigest(v2Tree), legacy: treeDigest(legacyTree) };

    const first = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
      version: "automatic_build_policy_migration_receipt.v2",
      decision: "adopt_exact",
      work_unit_id: descriptor.work_unit_id,
      from_policy_generation_id: input.oldLock.policy_generation_id,
      to_policy_generation_id: policyMember(input, "profile_sidecar_discourse").policy_generation_id,
      semantic_contract: policyMember(input, "profile_sidecar_discourse").semantic_contract,
      adopted_artifact: {
        work_unit_id: previousDescriptor.work_unit_id,
        envelope_version: "semantic_task_artifact.v2",
        artifact_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(replay).toEqual(first);
    expect(resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current_units: [current],
    })).toMatchObject({ status: "ready", adopted_units: [descriptor.work_unit_id] });
    expect({ v2: treeDigest(v2Tree), legacy: treeDigest(legacyTree) }).toEqual(before);
    expect(existsSync(automaticBuildPolicyGenerationPath(
      input.target,
      "profile_sidecar",
      policyMember(input, "profile_sidecar_discourse").policy_generation_id,
    ))).toBe(true);
    expect(policyMember(input, "profile_sidecar_discourse").semantic_contract)
      .toEqual(semanticContractFromExtractionPolicy(input.currentPolicy));
    expect(() => freezeAutomaticBuildStagePolicySet(input.target, createAutomaticBuildStagePolicySet({
      target_ref: input.target.target_ref,
      stage: "profile_sidecar",
      members: input.policyMembers.map((member) => ({
        ...member,
        policy_fingerprint: member.kind === "profile_sidecar_discourse"
          ? { ...input.currentPolicy, router_version: "profile_sidecar_semantic_units.contract-drift" }
          : member.policy_fingerprint,
      })),
      frozen_at: "2026-08-03T08:06:00.000Z",
    }))).toThrow(/policy_set_frozen/);

    let replans = 0;
    expect(migrateAutomaticBuildPolicyAndReplan({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
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

  it("adopts one exact digest-bound v3 predecessor into the explicit generation without rewriting history", () => {
    const input = fixture("digest-bound-v3-adoption");
    const rendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const descriptor = currentDescriptor(input, "digest-bound-discourse", rendered);
    const current = modelCurrent(descriptor, rendered);
    const sourceGenerationId = "a".repeat(64);
    const predecessorPath = writeDigestBoundGenerationArtifact(
      input,
      descriptor,
      sourceGenerationId,
    );
    const predecessorBytes = readFileSync(predecessorPath);
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);

    const first = recordAutomaticBuildPriorGenerationAdoption({
      target: input.target,
      stage: "profile_sidecar",
      policy_set: frozen,
      current,
      now: "2026-08-31T05:00:00.000Z",
    });
    if (!first || first.decision !== "adopt_exact") {
      throw new Error("expected exact prior-generation adoption");
    }
    const projected = materializeAdoptedAutomaticBuildGenerationArtifact({
      target: input.target,
      stage: "profile_sidecar",
      policy_set: frozen,
      current,
      receipt: first,
      project_payload: () => {
        throw new Error("digest-bound v3 adoption must not invoke the v2 payload projector");
      },
    });
    const replay = recordAutomaticBuildPriorGenerationAdoption({
      target: input.target,
      stage: "profile_sidecar",
      policy_set: frozen,
      current,
      now: "2026-08-31T05:01:00.000Z",
    });

    expect(first).toMatchObject({
      version: "automatic_build_policy_migration_receipt.v2",
      decision: "adopt_exact",
      reason: "exact_input_and_policy",
      from_policy_generation_id: sourceGenerationId,
      to_policy_generation_id: policyMember(input, "profile_sidecar_discourse").policy_generation_id,
      adopted_artifact: {
        work_unit_id: descriptor.work_unit_id,
        envelope_version: "semantic_task_artifact.v3",
      },
    });
    expect(replay).toEqual(first);
    expect(projected).toMatchObject({
      version: "semantic_task_artifact.v3",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      policy_generation_id: policyMember(input, "profile_sidecar_discourse").policy_generation_id,
      semantic_contract: semanticContractFromExtractionPolicy(input.currentPolicy),
    });
    expect(projected).not.toHaveProperty("proof_digest");
    expect(projected).not.toHaveProperty("policy_set_digest");
    expect(projected).not.toHaveProperty("policy_fingerprint");
    expect(readFileSync(predecessorPath)).toEqual(predecessorBytes);
    expect(resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: sourceGenerationId,
      policy_set: frozen,
      current_units: [current],
    })).toMatchObject({ status: "ready", adopted_units: [descriptor.work_unit_id] });
  });

  it("stops prior-generation adoption when the semantic input drifted", () => {
    const input = fixture("digest-bound-v3-drift");
    const sourceGenerationId = "b".repeat(64);
    const predecessor = currentDescriptor(
      input,
      "digest-bound-drift",
      "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nOriginal paragraph.\n",
    );
    writeDigestBoundGenerationArtifact(input, predecessor, sourceGenerationId);
    const changedRendered = "PROFILE_SIDECAR_INPUT\n[LID 1.1]\nChanged paragraph.\n";
    const changed = currentDescriptor(input, predecessor.work_unit_id, changedRendered);
    const frozen = freezeAutomaticBuildStagePolicySet(input.target, input.policySet);

    expect(recordAutomaticBuildPriorGenerationAdoption({
      target: input.target,
      stage: "profile_sidecar",
      policy_set: frozen,
      current: modelCurrent(changed, changedRendered),
      now: "2026-08-31T05:10:00.000Z",
    })).toMatchObject({
      decision: "blocked",
      reason: "previous_generation_semantic_drift",
      retryable: false,
    });
    expect(existsSync(automaticBuildGenerationArtifactPath(
      input.target,
      "profile_sidecar",
      policyMember(input, "profile_sidecar_discourse").policy_generation_id,
      changed.work_unit_id,
    ))).toBe(false);
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current,
      now: "2026-08-03T09:00:00.000Z",
    });
    const deterministicSkip = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current: skip,
      now: "2026-08-03T09:00:01.000Z",
    });
    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current,
      now: "2026-08-03T09:01:00.000Z",
    })).toEqual(rebuild);
    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current: skip,
      now: "2026-08-03T09:01:01.000Z",
    })).toEqual(deterministicSkip);

    expect(rebuild).toMatchObject({ decision: "rebuild", reason: "no_previous_artifact" });
    expect(deterministicSkip).toMatchObject({ decision: "deterministic_skip", reason: "current_router_skip" });
    expect(resolveAutomaticBuildPolicyGeneration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current_units: [current, skip],
    })).toMatchObject({ status: "pending", pending_rebuild_units: [descriptor.work_unit_id] });

    const generationArtifact = buildSemanticArtifactEnvelopeV3({
      target: input.target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      policy_generation_id: policyMember(input, "profile_sidecar_discourse").policy_generation_id,
      semantic_contract: policyMember(input, "profile_sidecar_discourse").semantic_contract,
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
      version: "automatic_build_policy_migration_block.v2",
      decision: "blocked",
      reason: "active_lease",
    });
    expect(existsSync(automaticBuildPolicyMigrationReceiptPath(
      input.target,
      "profile_sidecar",
      input.oldLock.policy_generation_id,
      policyMember(input, "profile_sidecar_discourse").policy_generation_id,
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
    })).toThrow(/policy_generation_migration_required: v3 release forbids unscoped claims/);
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
      version: "automatic_build_policy_migration_block.v2",
      decision: "blocked",
      reason: "model_input_unsplittable",
    });
    expect(existsSync(automaticBuildPolicyMigrationReceiptPath(
      input.target,
      "profile_sidecar",
      input.oldLock.policy_generation_id,
      policyMember(input, "profile_sidecar_formula").policy_generation_id,
      "atomic-formula",
    ))).toBe(false);

    expect(recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
      policy_set: frozen,
      current,
      previous: { descriptor: previousDescriptor, artifact_path: previousArtifactPath },
      now: "2026-08-03T11:00:00.000Z",
    })).toMatchObject({ decision: "blocked", reason: "previous_input_unverifiable" });

    const adopted = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
      from_policy_generation_id: input.oldLock.policy_generation_id,
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
      input.oldLock.policy_generation_id,
      policyMember(input, "profile_sidecar_discourse").policy_generation_id,
      descriptor.work_unit_id,
    );
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(adopted);
  });
});
