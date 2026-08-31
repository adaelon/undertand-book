import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAutomaticBuildPreflight, DEFAULT_AUTOMATIC_BUILD_BUDGET } from "../src/automatic-build-budget";
import {
  planAutomaticBuildExecutorDispatches,
  type AutomaticBuildExecutorDispatchManifestV1,
} from "../src/automatic-build-dispatch";
import {
  advanceAutomaticBuildDispatch,
  persistAutomaticBuildDispatch,
  prepareAutomaticBuildDispatch,
} from "../src/automatic-build-dispatch-runtime";
import {
  automaticBuildTaskPolicyBindingFromLease,
  claimAutomaticBuildTask,
  startAutomaticBuildLease,
} from "../src/automatic-build-lease";
import {
  inspectAutomaticBuildTask,
  stageAutomaticBuildCandidate,
  submitAutomaticBuildCandidate,
} from "../src/automatic-build-mailbox";
import {
  automaticBuildInputObservationPath,
  readAutomaticBuildInputObservation,
  recordAutomaticBuildInputObservation,
} from "../src/automatic-build-metrics";
import {
  createAutomaticBuildStagePolicySet,
  freezeAutomaticBuildStagePolicySet,
} from "../src/automatic-build-policy-generation";
import { automaticBuildTaskStoreRoot, listAutomaticBuildStoredAttempts } from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { evaluateModelInputBudget } from "../src/model-input-budget";
import {
  MODEL_INPUT_RENDER_CONTRACT_VERSION,
  renderPass1ModelInput,
} from "../src/model-input-renderer";
import { buildProfiledPass1Input } from "../src/pass1-profile-input";
import { freezePass1ShadowTask } from "../src/pass1-reduction";
import {
  automaticBuildExtractionPolicy,
  automaticBuildStagePolicyLockPath,
  inspectSemanticArtifact,
  type AutomaticBuildTaskPolicyBindingV2,
} from "../src/semantic-artifact";
import {
  buildWorkUnitCost,
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptor,
  createWorkUnitDescriptorV3,
  taskPolicyBindingForWorkUnit,
  workUnitPlanDigest,
  type WorkUnitDescriptorV3,
} from "../src/stage-work-unit";
import { loadBookWindows } from "../../../skills/build/load-book";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const AUTOMATIC_BUILD_CLI = path.join(REPO_ROOT, "skills", "build", "automatic-build.ts");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(label: string) {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-v3-${label}-`));
  const sourcePath = path.join(root, "guide.md");
  writeFileSync(sourcePath, "# Guide\n\nA canonical paragraph.\n", "utf8");
  const target = resolveAutomaticBuildTarget(sourcePath, root);
  const policy = automaticBuildExtractionPolicy(
    "profile_sidecar",
    resolveContentProfile("technical_learning"),
    "full",
  );
  return { root, sourcePath, target, policy };
}

function v3Descriptor(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  policy: ReturnType<typeof automaticBuildExtractionPolicy>,
  options: {
    id?: string;
    rendered?: string;
    role?: "fragment" | "final";
    sourceFingerprint?: string;
  } = {},
): WorkUnitDescriptorV3 {
  const rendered = options.rendered ?? "MODEL_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
  const evaluated = evaluateModelInputBudget({
    rendered_input: rendered,
    router_version: policy.router_version,
    prompt_sha256: policy.prompt_sha256,
    stage_body_limit_tokens: 5_000,
    executor_context_floor_tokens: 8_192,
    prompt_reserve_tokens: 512,
    protocol_reserve_tokens: 256,
    output_reserve_tokens: 512,
    safety_margin_tokens: 256,
  });
  if (evaluated.status !== "within_limit") throw new Error("v3 fixture input unexpectedly exceeds budget");
  return createWorkUnitDescriptorV3({
    target: target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: options.id ?? "discourse-fragment-0",
    kind: "profile_sidecar_discourse",
    input_basis: {
      kind: "source_slices",
      slices: [{
        version: "model_input_slice.v1",
        source_fingerprint: options.sourceFingerprint ?? target.target_ref.input_fingerprint,
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
    policy_fingerprint: policy,
    evidence_lids: ["1.1"],
    cost: buildWorkUnitCostFromBudgetProof({
      rendered_input: rendered,
      proof: evaluated.proof,
      visible_lids: 1,
      expected_output_items: 1,
    }),
    aggregation: { parent_lid: "1.1", role: options.role ?? "fragment" },
  });
}

function reductionDescriptor(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  policy: ReturnType<typeof automaticBuildExtractionPolicy>,
  dependencyHash: string,
): WorkUnitDescriptorV3 {
  const rendered = `REDUCE\nchild=${dependencyHash}\n`;
  const evaluated = evaluateModelInputBudget({
    rendered_input: rendered,
    router_version: policy.router_version,
    prompt_sha256: policy.prompt_sha256,
    stage_body_limit_tokens: 5_000,
    executor_context_floor_tokens: 8_192,
    prompt_reserve_tokens: 512,
    protocol_reserve_tokens: 256,
    output_reserve_tokens: 512,
    safety_margin_tokens: 256,
  });
  if (evaluated.status !== "within_limit") throw new Error("reduction fixture unexpectedly exceeds budget");
  return createWorkUnitDescriptorV3({
    target: target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: "discourse-reduce-0",
    kind: "profile_sidecar_discourse",
    input_basis: {
      kind: "artifact_reduction",
      dependency_artifacts: [{ work_unit_id: "discourse-fragment-0", artifact_hash: dependencyHash }],
      parent_lids: ["1.1"],
    },
    input_hash: evaluated.proof.rendered_input_sha256,
    input_budget_proof: evaluated.proof,
    policy_fingerprint: policy,
    evidence_lids: ["1.1"],
    dependencies: [{ artifact: "discourse-fragment-0", sha256: dependencyHash }],
    cost: buildWorkUnitCostFromBudgetProof({
      rendered_input: rendered,
      proof: evaluated.proof,
      visible_lids: 1,
      expected_output_items: 1,
    }),
    aggregation: { parent_lid: "1.1", role: "reduce" },
  });
}

function bindingFor(descriptor: WorkUnitDescriptorV3): AutomaticBuildTaskPolicyBindingV2 {
  return taskPolicyBindingForWorkUnit(descriptor, "profile-sidecar-discourse.full.v2");
}

function pass1Descriptor(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  sourcePath: string,
  renderedTransform: (rendered: string) => string = (rendered) => rendered,
): { descriptor: WorkUnitDescriptorV3; rendered: string; taskId: string } {
  const loaded = loadBookWindows(sourcePath);
  const window = loaded.windows[0];
  if (!window) throw new Error("v3 CLI fixture did not produce a Pass1 window");
  const profile = resolveContentProfile("technical_learning");
  const policy = automaticBuildExtractionPolicy("pass1", profile, "full");
  const actualRendered = renderPass1ModelInput(buildProfiledPass1Input(
    window,
    loaded.byLid,
    loaded.source,
    profile,
  ));
  const rendered = renderedTransform(actualRendered);
  const evaluated = evaluateModelInputBudget({
    rendered_input: rendered,
    router_version: policy.router_version,
    prompt_sha256: policy.prompt_sha256,
    stage_body_limit_tokens: 12_000,
    executor_context_floor_tokens: 16_384,
    prompt_reserve_tokens: 1_024,
    protocol_reserve_tokens: 512,
    output_reserve_tokens: 1_024,
    safety_margin_tokens: 512,
  });
  if (evaluated.status !== "within_limit") throw new Error("v3 CLI fixture input unexpectedly exceeds budget");
  const slices = window.leafLids.map((lid) => {
    const node = loaded.byLid.get(lid);
    if (!node) throw new Error(`missing v3 CLI fixture LID: ${lid}`);
    const core = loaded.source.slice(node.span.start, node.span.end);
    return {
      version: "model_input_slice.v1" as const,
      source_fingerprint: target.target_ref.input_fingerprint,
      parent_lid: lid,
      ordinal: 0,
      core_span_utf16: { ...node.span },
      context_span_utf16: { ...node.span },
      boundary_kind: "whole_lid" as const,
      core_sha256: sha256(core),
      context_sha256: sha256(core),
    };
  });
  const taskId = String(window.id);
  return {
    rendered: actualRendered,
    taskId,
    descriptor: createWorkUnitDescriptorV3({
      target: target.target_ref,
      stage: "pass1",
      work_unit_id: taskId,
      kind: "pass1_window",
      input_basis: { kind: "source_slices", slices },
      input_hash: evaluated.proof.rendered_input_sha256,
      input_budget_proof: evaluated.proof,
      policy_fingerprint: policy,
      evidence_lids: window.leafLids,
      cost: buildWorkUnitCostFromBudgetProof({
        rendered_input: rendered,
        proof: evaluated.proof,
        visible_lids: window.leafLids.length,
        expected_output_items: window.leafLids.length,
      }),
    }),
  };
}

function freezePass1CliTask(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  input: ReturnType<typeof pass1Descriptor>,
): AutomaticBuildTaskPolicyBindingV2 {
  const policySet = freezeAutomaticBuildStagePolicySet(target, createAutomaticBuildStagePolicySet({
    target_ref: target.target_ref,
    stage: "pass1",
    members: [{
      kind: input.descriptor.kind,
      extractor: "pass1-local-extractor",
      policy_generation_id: "pass1-window.full.v2",
      policy_fingerprint: input.descriptor.policy_fingerprint,
    }],
    frozen_at: "2026-08-03T04:00:00.000Z",
  }));
  const binding = taskPolicyBindingForWorkUnit(input.descriptor, policySet.members[0].policy_generation_id);
  const sourceUnitCount = input.descriptor.evidence_lids.length;
  freezePass1ShadowTask(target, {
    version: "pass1_shadow_task.v1",
    target_ref: target.target_ref,
    source_fingerprint: target.target_ref.input_fingerprint,
    policy_generation_id: binding.policy_generation_id,
    source_unit_count: sourceUnitCount,
    descriptor: input.descriptor,
    route: {
      role: "whole",
      window_id: Number(input.taskId),
      source_unit_range: { start_ordinal: 0, end_ordinal_exclusive: sourceUnitCount },
      evidence_lids: [...input.descriptor.evidence_lids],
    },
  });
  return binding;
}

function runPass1InputCli(input: {
  root: string;
  sourcePath: string;
  taskId: string;
  leaseRef: string;
  leaseToken: string;
  now: string;
}) {
  return spawnSync(process.execPath, [
    TSX_CLI,
    AUTOMATIC_BUILD_CLI,
    "input",
    input.sourcePath,
    "pass1",
    input.taskId,
    "--root",
    input.root,
    "--lease-ref",
    input.leaseRef,
    "--lease-token",
    input.leaseToken,
    "--now",
    input.now,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
}

function publishDispatch(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  manifest: AutomaticBuildExecutorDispatchManifestV1,
) {
  const options = {
    owner: `v3-dispatch:${manifest.dispatch_id}`,
    created_at: "2026-08-03T02:00:00.000Z",
    reserve_ttl_ms: 60_000,
    run_ttl_ms: 1_800_000,
  };
  const prepared = prepareAutomaticBuildDispatch(target, manifest, options);
  const handoffBytes = Buffer.from(`${JSON.stringify({
    version: "automatic_build_dispatch_executor_handoff.v1",
    prompt_sha256: sha256("v3-test-prompt"),
    prompt: "v3-test-prompt",
    envelope: {
      version: "automatic_build_dispatch_executor.v1",
      manifest,
      dispatch_run_id: prepared.prepared.dispatch_run_id,
      manifest_path: prepared.manifest_path,
    },
  })}\n`, "utf8");
  const handoffPath = path.join(path.dirname(prepared.manifest_path), "executor-handoff.json");
  mkdirSync(path.dirname(handoffPath), { recursive: true });
  writeFileSync(handoffPath, handoffBytes, { flag: "wx" });
  return persistAutomaticBuildDispatch(target, manifest, {
    ...options,
    executor_handoff: {
      version: "automatic_build_dispatch_executor_handoff_ref.v1",
      path: handoffPath,
      sha256: sha256(handoffBytes),
      byte_length: handoffBytes.byteLength,
    },
  });
}

describe("automatic-build v3 proof-bound compatibility", () => {
  it("plans and dispatches valid v3 units while binding proof, basis, aggregation, and dependencies", () => {
    const { target, policy } = fixture("plan");
    const fragment = v3Descriptor(target, policy);
    const reductionA = reductionDescriptor(target, policy, sha256("fragment-artifact-a"));
    const reductionB = reductionDescriptor(target, policy, sha256("fragment-artifact-b"));
    const bindings = {
      [fragment.work_unit_id]: bindingFor(fragment),
      [reductionA.work_unit_id]: bindingFor(reductionA),
    };
    const preflight = buildAutomaticBuildPreflight({
      target_ref: target.target_ref,
      stage: "profile_sidecar",
      work_units: [fragment, reductionA],
      task_bindings: bindings,
      pending_ids: [fragment.work_unit_id, reductionA.work_unit_id],
      quality_profile: "full",
      requested_workers: 2,
      available_agent_slots: 2,
      budget: DEFAULT_AUTOMATIC_BUILD_BUDGET,
    });

    expect(preflight.worker_plan.max_workers).toBe(2);
    expect(preflight.dispatch_plan.dispatches).toHaveLength(2);
    expect(preflight.dispatch_plan.dispatches.map((dispatch) => dispatch.task_bindings)).toEqual([
      { [fragment.work_unit_id]: bindings[fragment.work_unit_id] },
      { [reductionA.work_unit_id]: bindings[reductionA.work_unit_id] },
    ]);
    expect(workUnitPlanDigest([fragment])).not.toBe(workUnitPlanDigest([
      v3Descriptor(target, policy, { sourceFingerprint: "changed-source-fingerprint" }),
    ]));
    expect(workUnitPlanDigest([fragment])).not.toBe(workUnitPlanDigest([
      v3Descriptor(target, policy, { role: "final" }),
    ]));
    expect(workUnitPlanDigest([reductionA])).not.toBe(workUnitPlanDigest([reductionB]));
  });

  it("fails input hash and policy drift before claim with zero task state", () => {
    const { target, policy } = fixture("fail-closed");
    const descriptor = v3Descriptor(target, policy);
    const binding = bindingFor(descriptor);
    const mutations: WorkUnitDescriptorV3[] = [
      { ...descriptor, input_hash: "f".repeat(64) },
      {
        ...descriptor,
        policy_fingerprint: { ...descriptor.policy_fingerprint, prompt_sha256: "d".repeat(64) },
      },
    ];

    for (const changed of mutations) {
      expect(() => buildAutomaticBuildPreflight({
        target_ref: target.target_ref,
        stage: "profile_sidecar",
        work_units: [changed],
        task_bindings: { [changed.work_unit_id]: binding },
        pending_ids: [changed.work_unit_id],
        quality_profile: "full",
        requested_workers: 1,
        available_agent_slots: 1,
        budget: DEFAULT_AUTOMATIC_BUILD_BUDGET,
      })).toThrow();
      expect(() => claimAutomaticBuildTask(target, "profile_sidecar", changed.work_unit_id, {
        owner: "v3-invalid-claim",
        now: "2026-08-03T03:00:00.000Z",
        binding,
        descriptor: changed,
      })).toThrow();
    }

    expect(existsSync(automaticBuildTaskStoreRoot(target))).toBe(false);
    expect(existsSync(automaticBuildStagePolicyLockPath(target, "profile_sidecar"))).toBe(false);
    expect(listAutomaticBuildStoredAttempts(target, "profile_sidecar")).toEqual([]);
  });

  it("persists a v3 lease, observation, and mailbox artifact without exposing rendered input", () => {
    const { root, target, policy } = fixture("mailbox");
    const rendered = "MODEL_INPUT\n[LID 1.1]\nA canonical paragraph.\n";
    const descriptor = v3Descriptor(target, policy, { rendered });
    const binding = bindingFor(descriptor);
    const claim = claimAutomaticBuildTask(target, "profile_sidecar", descriptor.work_unit_id, {
      owner: "v3-mailbox-executor",
      now: "2026-08-03T04:00:00.000Z",
      reserve_ttl_ms: 60_000,
      binding,
      descriptor,
    });
    expect(claim.status).toBe("leased");
    if (claim.status !== "leased") throw new Error("expected a v3 lease");
    expect(automaticBuildTaskPolicyBindingFromLease(claim.lease)).toEqual(binding);
    expect(claim.lease).toMatchObject({
      input_hash: descriptor.input_hash,
      policy_generation_id: binding.policy_generation_id,
      semantic_contract: binding.semantic_contract,
    });

    startAutomaticBuildLease(target, claim.lease_ref, claim.lease.token, {
      now: "2026-08-03T04:00:01.000Z",
      run_ttl_ms: 60_000,
    });
    expect(() => recordAutomaticBuildInputObservation(target, claim.lease_ref, claim.lease.token, {
      started_at: "2026-08-03T04:00:01.000Z",
      finished_at: "2026-08-03T04:00:02.000Z",
      input_bytes: Buffer.byteLength(rendered),
      input_sha256: "b".repeat(64),
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    })).toThrow(/drifted/);
    expect(existsSync(automaticBuildInputObservationPath(claim.lease_ref))).toBe(false);

    const candidateSource = path.join(root, "candidate-source.json");
    writeFileSync(candidateSource, JSON.stringify({ discourse_items: [] }), "utf8");
    const staged = stageAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      candidateSource,
      { now: "2026-08-03T04:00:02.000Z" },
    );
    let writerCalled = false;
    expect(() => submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      () => {
        writerCalled = true;
        return { artifact_path: path.join(root, "must-not-exist.json") };
      },
      { now: "2026-08-03T04:00:02.000Z" },
    )).toThrow(/budget-evidence input observation/);
    expect(writerCalled).toBe(false);

    const observation = recordAutomaticBuildInputObservation(target, claim.lease_ref, claim.lease.token, {
      started_at: "2026-08-03T04:00:01.000Z",
      finished_at: "2026-08-03T04:00:02.000Z",
      input_bytes: Buffer.byteLength(rendered),
      input_sha256: sha256(rendered),
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    });
    expect(observation.version).toBe("automatic_build_input_observation.v3");
    expect(JSON.stringify(observation)).not.toContain(rendered);
    const artifactPath = path.join(target.workspace_dir, ".build", "profile-sidecar", "v3-artifact.json");
    submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      (sourcePath) => {
        mkdirSync(path.dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, readFileSync(sourcePath));
        return { artifact_path: artifactPath, output_counts: { discourse_items: 0 } };
      },
      { now: "2026-08-03T04:00:04.000Z", completed_at: "2026-08-03T04:00:05.000Z" },
    );
    const envelope = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(envelope).toMatchObject({
      version: "semantic_task_artifact.v3",
      input_hash: descriptor.input_hash,
      policy_generation_id: binding.policy_generation_id,
      semantic_contract: binding.semantic_contract,
    });
    expect(inspectSemanticArtifact(envelope, {
      target: target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      policy_generation_id: binding.policy_generation_id,
      semantic_contract: binding.semantic_contract,
    })).toMatchObject({ format: "v3", policy_fresh: true });
  });

  it("replays exact v3 CLI input bytes and fails closed before stdout when the renderer drifts", () => {
    const valid = fixture("cli-valid");
    const validInput = pass1Descriptor(valid.target, valid.sourcePath);
    const validBinding = freezePass1CliTask(valid.target, validInput);
    const validClaim = claimAutomaticBuildTask(valid.target, "pass1", validInput.taskId, {
      owner: "v3-cli-valid-executor",
      now: "2026-08-03T04:30:00.000Z",
      reserve_ttl_ms: 60_000,
      binding: validBinding,
      descriptor: validInput.descriptor,
    });
    expect(validClaim.status).toBe("leased");
    if (validClaim.status !== "leased") throw new Error("expected a valid v3 CLI lease");
    const validRun = runPass1InputCli({
      root: valid.root,
      sourcePath: valid.sourcePath,
      taskId: validInput.taskId,
      leaseRef: validClaim.lease_ref,
      leaseToken: validClaim.lease.token,
      now: "2026-08-03T04:30:01.000Z",
    });
    expect(validRun.error).toBeUndefined();
    expect(validRun.status, validRun.stderr).toBe(0);
    expect(validRun.stdout).toBe(validInput.rendered);
    expect(sha256(validRun.stdout)).toBe(validInput.descriptor.input_hash);
    expect(readAutomaticBuildInputObservation(validClaim.lease_ref)).toMatchObject({
      version: "automatic_build_input_observation.v3",
      input_sha256: validInput.descriptor.input_hash,
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    });

    const drifted = fixture("cli-drift");
    const driftedInput = pass1Descriptor(drifted.target, drifted.sourcePath, (rendered) => `${rendered}DRIFT\n`);
    const driftedBinding = freezePass1CliTask(drifted.target, driftedInput);
    const driftedClaim = claimAutomaticBuildTask(drifted.target, "pass1", driftedInput.taskId, {
      owner: "v3-cli-drift-executor",
      now: "2026-08-03T04:40:00.000Z",
      reserve_ttl_ms: 60_000,
      binding: driftedBinding,
      descriptor: driftedInput.descriptor,
    });
    expect(driftedClaim.status).toBe("leased");
    if (driftedClaim.status !== "leased") throw new Error("expected a drifted v3 CLI lease");
    const driftedRun = runPass1InputCli({
      root: drifted.root,
      sourcePath: drifted.sourcePath,
      taskId: driftedInput.taskId,
      leaseRef: driftedClaim.lease_ref,
      leaseToken: driftedClaim.lease.token,
      now: "2026-08-03T04:40:01.000Z",
    });
    expect(driftedRun.status).not.toBe(0);
    expect(driftedRun.stdout).toBe("");
    expect(driftedRun.stderr).toContain("budget evidence does not match rendered input or policy");
    expect(existsSync(automaticBuildInputObservationPath(driftedClaim.lease_ref))).toBe(false);
    const driftedInspection = inspectAutomaticBuildTask(
      drifted.target,
      driftedClaim.lease_ref,
      driftedClaim.lease.token,
    );
    expect(driftedInspection).toMatchObject({ state: "leased" });
    expect(driftedInspection).not.toHaveProperty("diagnostic_code");
  }, 20_000);

  it("rejects a changed v3 dispatch binding before creating a task or lease", () => {
    const { target, policy } = fixture("dispatch-drift");
    const descriptor = v3Descriptor(target, policy);
    const binding = bindingFor(descriptor);
    const plan = planAutomaticBuildExecutorDispatches({
      target_ref: target.target_ref,
      stage: "profile_sidecar",
      work_units: [descriptor],
      task_bindings: { [descriptor.work_unit_id]: binding },
      pending_ids: [descriptor.work_unit_id],
      available_agent_slots: 1,
    });
    const manifest = plan.dispatches[0];
    publishDispatch(target, manifest);
    const driftedBinding = { ...binding, input_hash: "c".repeat(64) };
    expect(() => advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors: [descriptor],
      task_bindings: { [descriptor.work_unit_id]: driftedBinding },
      now: "2026-08-03T02:00:01.000Z",
    })).toThrow(/binding/);
    expect(listAutomaticBuildStoredAttempts(target, "profile_sidecar")).toEqual([]);
  });

  it("keeps v2 dispatch advancement compatible with current-task-only bindings", () => {
    const { target, policy } = fixture("v2-dispatch-binding");
    const first = createWorkUnitDescriptor({
      target: target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: "legacy-v2-first",
      kind: "profile_sidecar_discourse",
      input_hash: sha256("legacy-v2-first-input"),
      policy_fingerprint: policy,
      evidence_lids: ["1.1"],
      cost: buildWorkUnitCost({ estimated_input_tokens: 10, visible_lids: 1, expected_output_items: 1 }),
    });
    const second = createWorkUnitDescriptor({
      target: target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: "legacy-v2-second",
      kind: "profile_sidecar_discourse",
      input_hash: sha256("legacy-v2-second-input"),
      policy_fingerprint: policy,
      evidence_lids: ["1.2"],
      cost: buildWorkUnitCost({ estimated_input_tokens: 10, visible_lids: 1, expected_output_items: 1 }),
    });
    const firstBinding = taskPolicyBindingForWorkUnit(first);
    const plan = planAutomaticBuildExecutorDispatches({
      target_ref: target.target_ref,
      stage: "profile_sidecar",
      work_units: [first, second],
      pending_ids: [first.work_unit_id, second.work_unit_id],
      available_agent_slots: 1,
    });
    const manifest = plan.dispatches[0];
    publishDispatch(target, manifest);

    const advanced = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors: [first, second],
      task_bindings: { [first.work_unit_id]: firstBinding },
      now: "2026-08-03T02:00:01.000Z",
    });

    expect(advanced.status).toBe("leased");
    expect(listAutomaticBuildStoredAttempts(target, "profile_sidecar").map((attempt) => attempt.work_unit_id))
      .toEqual([first.work_unit_id]);
  });

  it("keeps v2 lease and input-observation bytes unchanged", () => {
    const { target, policy } = fixture("v2-bytes");
    const descriptor = createWorkUnitDescriptor({
      target: target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: "legacy-v2-unit",
      kind: "profile_sidecar_discourse",
      input_hash: sha256("legacy-v2-input"),
      policy_fingerprint: policy,
      evidence_lids: ["1.1"],
      cost: buildWorkUnitCost({ estimated_input_tokens: 10, visible_lids: 1, expected_output_items: 1 }),
    });
    const binding = taskPolicyBindingForWorkUnit(descriptor);
    const claim = claimAutomaticBuildTask(target, "profile_sidecar", descriptor.work_unit_id, {
      owner: "legacy-v2-executor",
      now: "2026-08-03T05:00:00.000Z",
      reserve_ttl_ms: 60_000,
      binding,
      descriptor,
    });
    expect(claim.status).toBe("leased");
    if (claim.status !== "leased") throw new Error("expected a v2 lease");
    const expectedLease = {
      version: "automatic_build_task_lease.v2",
      target_ref: target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: descriptor.work_unit_id,
      attempt: 1,
      phase: "reserved",
      owner: "legacy-v2-executor",
      token: claim.lease.token,
      reserved_at: "2026-08-03T05:00:00.000Z",
      reserve_expires_at: "2026-08-03T05:01:00.000Z",
      issued_at: "2026-08-03T05:00:00.000Z",
      expires_at: "2026-08-03T05:01:00.000Z",
      input_hash: descriptor.input_hash,
      policy_fingerprint: policy,
    };
    expect(readFileSync(claim.lease_ref, "utf8")).toBe(`${JSON.stringify(expectedLease, null, 2)}\n`);
    startAutomaticBuildLease(target, claim.lease_ref, claim.lease.token, {
      now: "2026-08-03T05:00:01.000Z",
      run_ttl_ms: 60_000,
    });
    const observation = recordAutomaticBuildInputObservation(target, claim.lease_ref, claim.lease.token, {
      started_at: "2026-08-03T05:00:01.000Z",
      finished_at: "2026-08-03T05:00:02.000Z",
      input_bytes: 42,
    });
    const expectedObservation = {
      version: "automatic_build_input_observation.v1",
      started_at: "2026-08-03T05:00:01.000Z",
      finished_at: "2026-08-03T05:00:02.000Z",
      input_bytes: 42,
    };
    expect(observation).toEqual(expectedObservation);
    expect(readFileSync(automaticBuildInputObservationPath(claim.lease_ref), "utf8"))
      .toBe(`${JSON.stringify(expectedObservation, null, 2)}\n`);
    expect(readAutomaticBuildInputObservation(claim.lease_ref)).toEqual(expectedObservation);
    expect(recordAutomaticBuildInputObservation(target, claim.lease_ref, claim.lease.token, {
      started_at: "2026-08-03T05:00:03.000Z",
      finished_at: "2026-08-03T05:00:04.000Z",
      input_bytes: 42,
    })).toEqual(expectedObservation);
    expect(readFileSync(automaticBuildInputObservationPath(claim.lease_ref), "utf8"))
      .toBe(`${JSON.stringify(expectedObservation, null, 2)}\n`);
  });
});
