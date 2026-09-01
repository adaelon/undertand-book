import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_BUILD_PROTOCOL_V2,
  AUTOMATIC_BUILD_ROUTING_RELEASE,
} from "../src/automatic-build-protocol";
import {
  automaticBuildNext,
  automaticBuildPlan,
  runAutomaticBuildStageWriter,
} from "../../../skills/build/automatic-build";
import {
  stageAutomaticBuildCandidate,
  submitAutomaticBuildCandidate,
} from "../src/automatic-build-mailbox";
import { automaticBuildLegacyStageArtifactPath } from "../src/automatic-build-legacy";
import {
  automaticBuildPolicyMigrationReceiptPath,
} from "../src/automatic-build-policy-generation";
import { buildPass1Artifact } from "../src/build-resume";
import {
  automaticBuildGenerationArtifactPath,
  automaticBuildExtractionPolicy,
  buildSemanticArtifactEnvelope,
  freezeAutomaticBuildStagePolicy,
} from "../src/semantic-artifact";
import {
  assertPass1ShadowCandidatePath,
  pass1ShadowTaskPrivateDirectory,
  readPass1ShadowTask,
  writePass1ShadowFinalCandidate,
} from "../src/pass1-reduction";
import {
  renderPass1ModelInput,
  renderProfileSidecarModelInput,
} from "../src/model-input-renderer";
import { analyzeProfileSidecarSemanticUnits } from "../src/profile-sidecar-router";
import { profileSidecarDiscourseShadowTaskPath } from "../src/profile-sidecar-reduction";
import { resolveContentProfile } from "../src/content-profile";
import { buildProfiledPass1Input } from "../src/pass1-profile-input";
import {
  routePass1WindowWorkUnits,
  taskPolicyBindingForWorkUnit,
} from "../src/stage-work-unit";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";
import {
  closeSyntheticPass1,
  createSyntheticRoutabilityFixture,
  writeSyntheticPass1ProductionGeneration,
} from "./helpers/model-input-routability-fixture";

describe("BR8 production v3 routing release", () => {
  it("atomically selects policy-set-qualified Pass1 routing for a real 6,992-token paragraph", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const result = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
    });
    const pass1 = result.snapshot.stages.find((stage) => stage.stage === "pass1");

    expect(AUTOMATIC_BUILD_ROUTING_RELEASE).toEqual({
      version: "automatic_build_routing_release.v1",
      descriptor_generation: "automatic_build_work_unit.v3",
      policy_set: "automatic_build_stage_policy_set.v3",
      quality_report: "automatic_build_stage_quality_report.v2",
      pass1_router: "pass1_model_slice.v1",
      profile_sidecar_router: "profile_sidecar_discourse_map_reduce.v1",
      new_claim_policy: "v3_only",
      activated_at: "2026-08-04T00:00:00.000Z",
    });
    expect(result.routing_release).toBe(AUTOMATIC_BUILD_ROUTING_RELEASE);
    expect(pass1?.policy_set?.version).toBe("automatic_build_stage_policy_set.v3");
    expect(pass1?.work_units?.length).toBeGreaterThan(1);
    expect(pass1?.work_units?.every((unit) => unit.version === "automatic_build_work_unit.v3"))
      .toBe(true);
    expect(pass1?.pending_work_units?.some((unit) => unit.kind === "pass1_source_slice"))
      .toBe(true);
    expect(result.next_action).toMatchObject({
      kind: "extract",
      stage: "pass1",
      extractor: "pass1-local-extractor",
    });
    expect(result.preflight).toMatchObject({
      policy_generations: expect.arrayContaining([
        expect.objectContaining({
          kind: "pass1_source_slice",
          policy_generation_id: pass1?.policy_set?.members.find(
            (member) => member.kind === "pass1_source_slice",
          )?.policy_generation_id,
        }),
      ]),
    });
    expect(existsSync(path.join(
      fixture.target.workspace_dir,
      ".build",
      "automatic-build",
      "v2",
      "tasks",
    ))).toBe(false);
  });

  it("creates only proof-bound v3 claims after the release switch", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const plan = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected BR8 v3 preflight");
    const next = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      owner: "br8-v3-claim",
      now: "2026-08-04T00:10:00.000Z",
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });

    expect(next.routing_release).toBe(AUTOMATIC_BUILD_ROUTING_RELEASE);
    expect(next.action).toMatchObject({
      kind: "extract",
      stage: "pass1",
      tasks: [{
        descriptor: { version: "automatic_build_work_unit.v3" },
        lease: {
          policy_generation_id: expect.stringMatching(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
          semantic_contract: expect.any(Object),
        },
      }],
    });
  });

  it("blocks the release switch while an old v2 generation lease is still active", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    const profile = resolveContentProfile("technical_learning");
    const legacyUnits = routePass1WindowWorkUnits({
      target: fixture.target.target_ref,
      windows: fixture.windows,
      byLid: fixture.by_lid,
      source: fixture.source,
      policy_fingerprint: automaticBuildExtractionPolicy("pass1", profile, "full"),
      content_profile: profile,
    });
    const legacyUnit = legacyUnits[0];
    if (!legacyUnit) throw new Error("expected a legacy Pass1 work unit");
    claimAutomaticBuildTask(
      fixture.target,
      "pass1",
      legacyUnit.work_unit_id,
      {
        owner: "br8-active-v2-lease",
        now: new Date(Date.now() - 60_000).toISOString(),
        reserve_ttl_ms: 86_400_000,
        descriptor: legacyUnit,
        binding: taskPolicyBindingForWorkUnit(legacyUnit),
      },
    );

    expect(automaticBuildPlan(fixture.source_file, fixture.root)).toMatchObject({
      snapshot: { stages: [] },
      next_action: {
        kind: "needs_user",
        reason: "automatic_build_routing_blocked",
        recovery: {
          phase: "migration",
          code: "policy_generation_migration_required",
          stage: "pass1",
          affected_work_units: [{ work_unit_id: legacyUnit.work_unit_id }],
          retryable: true,
          recovery_actions: ["retry_plan"],
        },
      },
    });
  });

  it("binds each heterogeneous dispatch to the extractor prompt for its own v3 kind", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const plan = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 2,
      available_agent_slots: 2,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected heterogeneous BR8 dispatch preflight");
    const next = automaticBuildNext(fixture.source_file, fixture.root, 2, {
      owner: "br8-dynamic-prompts",
      now: "2026-08-04T00:15:00.000Z",
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      available_agent_slots: 2,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) {
      throw new Error("expected heterogeneous BR8 dispatch handoffs");
    }
    expect(new Set(next.action.dispatches.map((dispatch) => dispatch.manifest.kind))).toEqual(
      new Set(["pass1_window", "pass1_source_slice"]),
    );
    const promptHeadingByKind = {
      pass1_window: "# pass1-local-extractor",
      pass1_source_slice: "# pass1-source-fragment-extractor",
    } as const;
    for (const dispatch of next.action.dispatches) {
      const handoff = JSON.parse(readFileSync(dispatch.executor_handoff.path, "utf8")) as {
        prompt: string;
      };
      const heading = promptHeadingByKind[dispatch.manifest.kind as keyof typeof promptHeadingByKind];
      expect(heading).toBeDefined();
      expect(handoff.prompt).toContain(heading);
    }
  }, 30_000);

  it("commits a whole-window production task in-process without claiming an extra stitch", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const plan = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected BR8 execution preflight");
    const next = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      owner: "br8-v3-executor",
      now: "2026-08-04T00:20:00.000Z",
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (next.action.kind !== "extract"
      || !("tasks" in next.action)
      || !next.action.tasks?.length
      || !("cwd" in next.action)) {
      throw new Error("expected a leased BR8 task");
    }
    const task = next.action.tasks[0];
    if (!("lease" in task) || !("lease_ref" in task) || !("input_command" in task)) {
      throw new Error("expected a proof-bound leased BR8 task");
    }
    const [inputCommand, ...inputArgs] = task.input_command;
    const input = spawnSync(inputCommand, [
      ...inputArgs,
      "--now",
      "2026-08-04T00:20:01.000Z",
    ], {
      cwd: next.action.cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(input.status, input.stderr).toBe(0);
    expect(input.stdout).not.toBe("");
    expect(task.lease.policy_generation_id).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/u);

    const candidateSource = path.join(fixture.root, "pass1-candidate.json");
    writeFileSync(candidateSource, JSON.stringify({ nodes: [], edges: [] }), "utf8");
    const candidate = stageAutomaticBuildCandidate(
      fixture.target,
      task.lease_ref,
      task.lease.token,
      candidateSource,
      { now: "2026-08-04T00:20:02.000Z" },
    );
    const previousSidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = path.join(fixture.root, "missing-writer-sidecar.exe");
    let receipt: ReturnType<typeof submitAutomaticBuildCandidate>;
    try {
      receipt = submitAutomaticBuildCandidate(
        fixture.target,
        task.lease_ref,
        task.lease.token,
        candidate.candidate_path,
        (candidatePath) => runAutomaticBuildStageWriter(
          fixture.target,
          "pass1",
          task.task_id,
          candidatePath,
          {
            policy_generation_id: task.lease.policy_generation_id!,
            attempt: task.lease.attempt,
            executor: task.lease.owner,
            generated_at: "2026-08-04T00:20:03.000Z",
          },
        ),
        { now: "2026-08-04T00:20:03.000Z" },
      );
    } finally {
      if (previousSidecar === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previousSidecar;
    }
    expect(JSON.parse(readFileSync(receipt.artifact_path!, "utf8"))).toMatchObject({
      version: "semantic_task_artifact.v3",
      policy_generation_id: task.lease.policy_generation_id,
      semantic_contract: task.lease.semantic_contract,
    });

    const resumed = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
    });
    const resumedPass1 = resumed.snapshot.stages.find((stage) => stage.stage === "pass1");
    expect(resumed.next_action).toEqual({ kind: "close_stage", stage: "pass1" });
    expect(resumedPass1?.pending_work_units).toEqual([]);
    expect(resumedPass1?.work_units?.some((unit) => unit.kind === "pass1_lid_stitch"))
      .toBe(false);
  }, 30_000);

  it("keeps retry candidates isolated after an earlier writer failure", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const plan = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected BR8 retry isolation preflight");
    const next = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      owner: "br8-shadow-retry-isolation",
      now: "2026-08-04T00:25:00.000Z",
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (next.action.kind !== "extract"
      || !("tasks" in next.action)
      || !next.action.tasks?.length) {
      throw new Error("expected a leased BR8 retry-isolation task");
    }
    const task = next.action.tasks[0];
    if (!("lease" in task) || !task.lease.policy_generation_id) {
      throw new Error("expected a proof-bound retry-isolation lease");
    }
    const invalidCandidate = path.join(fixture.root, "pass1-invalid-retry-candidate.json");
    const validCandidate = path.join(fixture.root, "pass1-valid-retry-candidate.json");
    writeFileSync(invalidCandidate, JSON.stringify({ nodes: "invalid", edges: [] }), "utf8");
    writeFileSync(validCandidate, JSON.stringify({ nodes: [], edges: [] }), "utf8");
    const generation = {
      policy_generation_id: task.lease.policy_generation_id,
      executor: task.lease.owner,
      generated_at: "2026-08-04T00:25:01.000Z",
    };

    expect(() => runAutomaticBuildStageWriter(
      fixture.target,
      "pass1",
      task.task_id,
      invalidCandidate,
      { ...generation, attempt: 1 },
    )).toThrow();
    expect(() => runAutomaticBuildStageWriter(
      fixture.target,
      "pass1",
      task.task_id,
      validCandidate,
      { ...generation, attempt: 2, generated_at: "2026-08-04T00:25:02.000Z" },
    )).not.toThrow();

    const mailbox = pass1ShadowTaskPrivateDirectory(
      fixture.target,
      task.lease.policy_generation_id,
      task.task_id,
    );
    const stagedCandidates = readdirSync(mailbox, { recursive: true })
      .filter((entry) => String(entry).endsWith("candidate.json"));
    expect(stagedCandidates).toHaveLength(2);
  }, 30_000);

  it("adopts an exact v2 whole-window artifact without a model claim and projects a direct public candidate", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    const profile = resolveContentProfile("technical_learning");
    const window = fixture.windows[0];
    if (!window || fixture.windows.length !== 1) {
      throw new Error("expected one fitting Pass1 window for exact adoption");
    }
    const legacyPolicy = automaticBuildExtractionPolicy("pass1", profile, "full");
    const legacyDescriptor = routePass1WindowWorkUnits({
      target: fixture.target.target_ref,
      windows: fixture.windows,
      byLid: fixture.by_lid,
      source: fixture.source,
      policy_fingerprint: legacyPolicy,
      content_profile: profile,
    })[0];
    if (!legacyDescriptor) throw new Error("expected a legacy Pass1 descriptor");
    const renderedInput = renderPass1ModelInput(buildProfiledPass1Input(
      window,
      fixture.by_lid,
      fixture.source,
      profile,
    ));
    expect(legacyDescriptor.input_hash).toBe(
      createHash("sha256").update(renderedInput).digest("hex"),
    );
    const legacyPayload = buildPass1Artifact(
      window,
      fixture.by_lid,
      fixture.source,
      { nodes: [], edges: [] },
      profile,
    );
    const legacyEnvelope = buildSemanticArtifactEnvelope({
      target: fixture.target.target_ref,
      stage: "pass1",
      work_unit_id: legacyDescriptor.work_unit_id,
      input_hash: legacyDescriptor.input_hash,
      policy_fingerprint: legacyDescriptor.policy_fingerprint,
      provenance: {
        executor: "br8-v2-adoption-fixture",
        attempt: 1,
        generated_at: "2026-08-03T23:50:00.000Z",
      },
      payload: legacyPayload,
    });
    const legacyPath = automaticBuildLegacyStageArtifactPath(
      fixture.target,
      "pass1",
      legacyDescriptor.work_unit_id,
    );
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, `${JSON.stringify(legacyEnvelope, null, 2)}\n`, "utf8");
    const legacyBytes = readFileSync(legacyPath, "utf8");
    const legacyLock = freezeAutomaticBuildStagePolicy(
      fixture.target,
      "pass1",
      `pass1.${legacyPolicy.stage_policy_version}.${legacyPolicy.quality_profile}`,
      legacyPolicy,
      "2026-08-03T23:55:00.000Z",
    );

    const adopted = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
    });
    const pass1 = adopted.snapshot.stages.find((stage) => stage.stage === "pass1");
    const policyGenerationId = pass1?.policy_set?.members.find(
      (member) => member.kind === "pass1_window",
    )?.policy_generation_id;
    if (!pass1?.policy_set || !policyGenerationId) {
      throw new Error("expected a Pass1 v3 policy set after exact adoption");
    }
    expect(adopted.next_action).toEqual({ kind: "close_stage", stage: "pass1" });
    expect(pass1.pending_work_units).toEqual([]);
    expect(existsSync(path.join(
      fixture.target.workspace_dir,
      ".build",
      "automatic-build",
      "v2",
      "tasks",
    ))).toBe(false);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);

    const migrationReceipt = JSON.parse(readFileSync(automaticBuildPolicyMigrationReceiptPath(
      fixture.target,
      "pass1",
      legacyLock.policy_generation_id,
      policyGenerationId,
      legacyDescriptor.work_unit_id,
    ), "utf8"));
    expect(migrationReceipt).toMatchObject({
      decision: "adopt_exact",
      adopted_artifact: {
        work_unit_id: legacyDescriptor.work_unit_id,
        envelope_version: "semantic_task_artifact.v2",
      },
    });
    const generationArtifact = JSON.parse(readFileSync(automaticBuildGenerationArtifactPath(
      fixture.target,
      "pass1",
      policyGenerationId,
      legacyDescriptor.work_unit_id,
    ), "utf8"));
    expect(generationArtifact).toMatchObject({
      version: "semantic_task_artifact.v3",
      work_unit_id: legacyDescriptor.work_unit_id,
      payload: {
        version: "pass1_shadow_graph_artifact.v1",
        role: "whole",
        nodes: legacyPayload.nodes,
        edges: legacyPayload.edges,
      },
    });

    const task = readPass1ShadowTask(
      fixture.target,
      policyGenerationId,
      legacyDescriptor.work_unit_id,
    );
    const candidate = writePass1ShadowFinalCandidate({
      target: fixture.target,
      source: fixture.source,
      task,
    });
    expect(candidate.candidate).toEqual(legacyPayload);
    expect(assertPass1ShadowCandidatePath({
      target: fixture.target,
      task,
      candidate_path: candidate.candidate_path,
    })).toBe(candidate.candidate_path);
    const candidateBytes = readFileSync(candidate.candidate_path, "utf8");
    expect(writePass1ShadowFinalCandidate({
      target: fixture.target,
      source: fixture.source,
      task,
    })).toEqual(candidate);
    expect(readFileSync(candidate.candidate_path, "utf8")).toBe(candidateBytes);
  }, 30_000);

  it("publishes Pass1 directly from v3 public contributors when the legacy artifact directory is empty", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    writeSyntheticPass1ProductionGeneration(fixture, { grounded: true });
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const closing = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      owner: "br8-pass1-close",
      now: "2026-08-04T00:35:00.000Z",
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (closing.action.kind !== "close_stage" || !("command" in closing.action)) {
      throw new Error("expected a v3 Pass1 close command");
    }
    expect(existsSync(path.join(fixture.target.workspace_dir, ".build", "pass1"))).toBe(false);
    const [command, ...args] = closing.action.command;
    const close = spawnSync(command, args, {
      cwd: closing.action.cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(close.status, close.stderr).toBe(0);
    expect(JSON.parse(close.stdout)).toMatchObject({
      version: "automatic_build_stage_close_result.v2",
      status: "closed",
      stage: "pass1",
      next: "replan",
    });
    expect(JSON.parse(readFileSync(path.join(fixture.target.workspace_dir, "base.json"), "utf8")))
      .toMatchObject({
        book_id: fixture.target.book_id,
        graph_nodes: [expect.objectContaining({ source_lid: expect.any(String) })],
      });
    const resumed = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
    });
    expect(resumed.snapshot.stages.find((stage) => stage.stage === "pass1")?.closed).toBe(true);
    expect(resumed.snapshot.stages.some((stage) => stage.stage === "profile_sidecar")).toBe(true);
  }, 30_000);

  it("publishes a fragmented Pass1 window from its final v3 stitch contributor", () => {
    const fixture = createSyntheticRoutabilityFixture();
    writeSyntheticPass1ProductionGeneration(fixture, { grounded: true });
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const planned = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    const pass1 = planned.snapshot.stages.find((stage) => stage.stage === "pass1");
    const contributor = pass1?.quality_routing?.public_contributors[0];
    if (!pass1?.policy_set || !contributor) {
      throw new Error("expected one completed fragmented Pass1 contributor");
    }
    const task = readPass1ShadowTask(
      fixture.target,
      pass1.generation_tasks?.[contributor.work_unit_id]?.task.policy_generation_id ?? "",
      contributor.work_unit_id,
    );
    expect(task.route.role).toBe("final");
    const finalCandidate = writePass1ShadowFinalCandidate({
      target: fixture.target,
      source: fixture.source,
      task,
    });
    const legacyWholeWindowHash = buildPass1Artifact(
      fixture.windows[0],
      fixture.by_lid,
      fixture.source,
      { nodes: [], edges: [] },
      resolveContentProfile("technical_learning"),
    ).content_hash;
    expect(finalCandidate.candidate.content_hash).not.toBe(legacyWholeWindowHash);

    const closing = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      owner: "br8-fragmented-pass1-close",
      now: "2026-08-04T00:37:00.000Z",
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (closing.action.kind !== "close_stage" || !("command" in closing.action)) {
      throw new Error("expected a fragmented v3 Pass1 close command");
    }
    const [command, ...args] = closing.action.command;
    const close = spawnSync(command, args, {
      cwd: closing.action.cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(close.status, close.stderr).toBe(0);
    expect(JSON.parse(close.stdout)).toMatchObject({
      version: "automatic_build_stage_close_result.v2",
      status: "closed",
      stage: "pass1",
      next: "replan",
    });
  }, 30_000);

  it("routes a real 6,992-token profile paragraph through production fragment/reduce", () => {
    const fixture = createSyntheticRoutabilityFixture();
    closeSyntheticPass1(fixture);

    const result = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
    });
    const profile = result.snapshot.stages.find((stage) => stage.stage === "profile_sidecar");

    expect(profile?.policy_set).toMatchObject({
      version: "automatic_build_stage_policy_set.v3",
      stage: "profile_sidecar",
    });
    expect(profile?.work_units?.length).toBeGreaterThan(1);
    expect(profile?.work_units?.every((unit) => unit.version === "automatic_build_work_unit.v3"))
      .toBe(true);
    expect(profile?.pending_work_units?.some((unit) => (
      unit.kind === "profile_sidecar_discourse_fragment"
      && unit.evidence_lids.includes(fixture.paragraph_lid)
    ))).toBe(true);
    expect(result.next_action).toMatchObject({
      kind: "extract",
      stage: "profile_sidecar",
      extractor: "profile-sidecar-discourse-fragment-extractor",
    });
    expect(result.preflight).toMatchObject({
      policy_generations: expect.arrayContaining([
        expect.objectContaining({
          kind: "profile_sidecar_discourse_fragment",
          policy_generation_id: profile?.policy_set?.members.find(
            (member) => member.kind === "profile_sidecar_discourse_fragment",
          )?.policy_generation_id,
        }),
      ]),
    });

    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const executable = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!executable.preflight) throw new Error("expected profile v3 preflight");
    const next = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      owner: "br8-profile-fragment",
      now: "2026-08-04T00:40:00.000Z",
      accepted_plan_digest: executable.preflight.descriptor_plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (next.action.kind !== "extract"
      || !("tasks" in next.action)
      || !next.action.tasks?.length
      || !("cwd" in next.action)) {
      throw new Error("expected a leased profile fragment task");
    }
    const task = next.action.tasks[0];
    if (!("lease" in task) || !("input_command" in task)) {
      throw new Error("expected a proof-bound profile fragment lease");
    }
    expect(task.descriptor).toMatchObject({
      version: "automatic_build_work_unit.v3",
      kind: "profile_sidecar_discourse_fragment",
    });
    expect(existsSync(profileSidecarDiscourseShadowTaskPath(
      fixture.target,
      task.lease.policy_generation_id!,
      task.task_id,
    ))).toBe(true);
    const [inputCommand, ...inputArgs] = task.input_command;
    const input = spawnSync(inputCommand, [
      ...inputArgs,
      "--now",
      "2026-08-04T00:40:01.000Z",
    ], {
      cwd: next.action.cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(input.status, input.stderr).toBe(0);
    expect(input.stdout).not.toBe("");
  }, 30_000);

  it("keeps a small profile whole-unit input byte-identical while committing v3", () => {
    const fixture = createSyntheticRoutabilityFixture(200);
    closeSyntheticPass1(fixture);
    const buildPlan = confirmedStandardBuildPlan(fixture.source_file, fixture.root);
    const plan = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected profile fast-path preflight");
    const next = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      owner: "br8-profile-fast-path",
      now: "2026-08-04T00:50:00.000Z",
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (next.action.kind !== "extract"
      || !("tasks" in next.action)
      || !next.action.tasks?.length
      || !("cwd" in next.action)) {
      throw new Error("expected a leased profile fast-path task");
    }
    const task = next.action.tasks[0];
    if (!("lease" in task) || !("lease_ref" in task) || !("input_command" in task)) {
      throw new Error("expected a proof-bound profile fast-path lease");
    }
    expect(task.descriptor).toMatchObject({
      version: "automatic_build_work_unit.v3",
      kind: "profile_sidecar_discourse",
    });
    const analysis = analyzeProfileSidecarSemanticUnits({
      windows: fixture.windows,
      byLid: fixture.by_lid,
      source: fixture.source,
      content_profile: resolveContentProfile("technical_learning"),
    });
    const packet = analysis.packets[task.task_id];
    if (!packet) throw new Error("expected the legacy-compatible profile packet");
    const [inputCommand, ...inputArgs] = task.input_command;
    const input = spawnSync(inputCommand, [
      ...inputArgs,
      "--now",
      "2026-08-04T00:50:01.000Z",
    ], {
      cwd: next.action.cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(input.status, input.stderr).toBe(0);
    expect(input.stdout).toBe(renderProfileSidecarModelInput(packet));

    const candidateSource = path.join(fixture.root, "profile-fast-path-candidate.json");
    writeFileSync(candidateSource, JSON.stringify({
      discourse_items: [{
        lid: packet.visible_lids[0],
        mode: "informative",
        relations: [],
      }],
    }), "utf8");
    const candidate = stageAutomaticBuildCandidate(
      fixture.target,
      task.lease_ref,
      task.lease.token,
      candidateSource,
      { now: "2026-08-04T00:50:02.000Z" },
    );
    const receipt = submitAutomaticBuildCandidate(
      fixture.target,
      task.lease_ref,
      task.lease.token,
      candidate.candidate_path,
      (candidatePath) => runAutomaticBuildStageWriter(
        fixture.target,
        "profile_sidecar",
        task.task_id,
        candidatePath,
        {
          policy_generation_id: task.lease.policy_generation_id!,
          attempt: task.lease.attempt,
          executor: task.lease.owner,
          generated_at: "2026-08-04T00:50:03.000Z",
        },
      ),
      { now: "2026-08-04T00:50:03.000Z" },
    );
    expect(JSON.parse(readFileSync(receipt.artifact_path!, "utf8"))).toMatchObject({
      version: "semantic_task_artifact.v3",
      stage: "profile_sidecar",
      policy_generation_id: task.lease.policy_generation_id,
      semantic_contract: task.lease.semantic_contract,
    });
    const closing = automaticBuildNext(fixture.source_file, fixture.root, 1, {
      owner: "br8-profile-fast-path-close",
      now: "2026-08-04T00:50:04.000Z",
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (closing.action.kind !== "close_stage" || !("command" in closing.action)) {
      throw new Error("expected a v3 profile-sidecar close command");
    }
    expect(existsSync(path.join(fixture.target.workspace_dir, ".build", "profile-sidecar")))
      .toBe(false);
    const [closeCommand, ...closeArgs] = closing.action.command;
    const close = spawnSync(closeCommand, closeArgs, {
      cwd: closing.action.cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(close.status, close.stderr).toBe(0);
    expect(JSON.parse(close.stdout)).toMatchObject({
      version: "automatic_build_stage_close_result.v2",
      status: "closed",
      stage: "profile_sidecar",
      next: "replan",
    });
    expect(JSON.parse(readFileSync(
      path.join(fixture.target.workspace_dir, "discourse_index.json"),
      "utf8",
    ))).toMatchObject({
      items: [expect.objectContaining({ lid: packet.visible_lids[0] })],
    });
  }, 30_000);
});
