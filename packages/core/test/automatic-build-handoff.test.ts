import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  automaticBuildDispatchFinish,
  automaticBuildDispatchInspect,
  automaticBuildDispatchNext,
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import {
  failAutomaticBuildTask,
  submitAutomaticBuildCandidate,
} from "../src/automatic-build-mailbox";
import { recordAutomaticBuildInputObservation } from "../src/automatic-build-metrics";
import { MODEL_INPUT_RENDER_CONTRACT_VERSION } from "../src/model-input-renderer";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { readAutomaticBuildAttemptSnapshot } from "../src/automatic-build-task-store";
import {
  automaticBuildDispatchManifestPath,
  automaticBuildDispatchRunId,
  persistAutomaticBuildDispatchPlan,
  prepareAutomaticBuildDispatch,
} from "../src/automatic-build-dispatch-runtime";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";
import { writePass1ProductionTaskArtifact } from "./helpers/model-input-routability-fixture";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const EXTRACTOR_PROMPTS = [
  "pass1-local-extractor.md",
  "paper-metadata-extractor.md",
  "paper-lexicon-extractor.md",
  "profile-sidecar-extractor.md",
  "pass1-source-fragment-extractor.md",
  "pass1-lid-stitcher.md",
  "profile-sidecar-discourse-fragment-extractor.md",
  "profile-sidecar-discourse-reducer.md",
  "pass2-longrange-linker.md",
  "book-structure-extractor.md",
];

function dispatchSource(): string {
  return [
    "# Dispatch guide",
    ...Array.from({ length: 320 }, (_, index) => (
      `Paragraph ${index + 1} contains stable evidence for a multi-task executor dispatch.`
    )),
  ].join("\n\n");
}

function commitDispatchTask(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  task: Extract<ReturnType<typeof automaticBuildDispatchNext>["action"], { kind: "task" }>["task"],
  marker: string,
) {
  if (task.descriptor.version === "automatic_build_work_unit.v3") {
    recordAutomaticBuildInputObservation(target, task.lease_ref, task.lease.token, {
      started_at: task.lease.issued_at,
      finished_at: task.lease.issued_at,
      input_bytes: 0,
      input_sha256: task.descriptor.input_hash,
      proof_digest: task.descriptor.input_budget_proof.proof_digest,
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    });
  }
  writeFileSync(task.candidate_path, JSON.stringify({
    content_hash: task.descriptor.input_hash,
    nodes: [],
    edges: [],
    marker,
  }), "utf8");
  return submitAutomaticBuildCandidate(
    target,
    task.lease_ref,
    task.lease.token,
    task.candidate_path,
    () => {
      if (!task.lease.policy_set_digest) throw new Error("expected a v3 policy-set lease");
      return writePass1ProductionTaskArtifact({
        target,
        policy_set_digest: task.lease.policy_set_digest,
        work_unit_id: task.task_id,
        marker,
        generated_at: task.lease.issued_at,
      });
    },
    { now: task.lease.issued_at, completed_at: task.lease.issued_at },
  );
}

function seedLegacyManifestOnly(
  source: string,
  root: string,
  plan: ReturnType<typeof automaticBuildPlan>,
  createdAt: string,
) {
  if (!plan.preflight) throw new Error("expected dispatch preflight");
  const target = resolveAutomaticBuildTarget(source, root);
  persistAutomaticBuildDispatchPlan(
    target,
    plan.preflight.plan_digest,
    plan.preflight.dispatch_plan,
    createdAt,
  );
  const manifest = plan.preflight.dispatch_plan.dispatches[0];
  const publication = prepareAutomaticBuildDispatch(target, manifest, {
    owner: `legacy-dispatch:${manifest.dispatch_id}`,
    created_at: createdAt,
    reserve_ttl_ms: 60_000,
    run_ttl_ms: 1_800_000,
  });
  mkdirSync(path.dirname(publication.manifest_path), { recursive: true });
  writeFileSync(publication.manifest_path, `${JSON.stringify(publication.prepared, null, 2)}\n`, "utf8");
  return { target, manifest, publication };
}

describe("automatic build Codex executor handoff", () => {
  it("emits a lease envelope without a root candidate relay", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-handoff-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const buildPlan = confirmedStandardBuildPlan(source, root);
      const plan = automaticBuildPlan(source, root, { requested_workers: 1, build_plan: buildPlan });
      if (!plan.preflight) throw new Error("expected handoff preflight");
      const result = automaticBuildNext(source, root, 1, {
        protocol: "automatic_build_protocol.v2",
        owner: "handoff-test",
        now: "2026-07-19T00:00:00.000Z",
        lease_ttl_ms: 60_000,
        accepted_plan_digest: plan.preflight.plan_digest,
        build_plan: buildPlan,
      });
      expect(result.action.kind).toBe("extract");
      if (!("tasks" in result.action) || !result.action.tasks) {
        throw new Error("expected executor task");
      }
      const task = result.action.tasks[0];
      if (!("input_command" in task)) throw new Error("expected executor command envelope");
      expect(task).toMatchObject({
        task_id: "0",
        attempt_number: 1,
        execution_identity: {
          semantic_attempt: 1,
          lease_epoch: 1,
          submit_revision: 0,
          identity_source: "native",
        },
        candidate_path: expect.stringContaining("candidate.json"),
        usage_path: expect.stringContaining("usage.json"),
        descriptor: {
          version: "automatic_build_work_unit.v3",
          work_unit_id: "0",
          kind: "pass1_window",
          cost: { score: expect.any(Number) },
        },
        lease: {
          version: "automatic_build_task_lease.v2",
          phase: "reserved",
          reserved_at: "2026-07-19T00:00:00.000Z",
          reserve_expires_at: "2026-07-19T00:01:00.000Z",
          proof_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          policy_set_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      const executable = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      expect(task.input_command.slice(0, 3)).toEqual([executable, "input", expect.any(String)]);
      expect(task.input_command).toContain("--run-ttl-ms");
      expect(task.input_command).toContain("1800000");
      expect(task.candidate_command.slice(0, 3)).toEqual([executable, "candidate", expect.any(String)]);
      expect(task.candidate_command).toContain("{candidate_source}");
      expect(task.submit_command.slice(0, 3)).toEqual([executable, "submit", expect.any(String)]);
      expect(task.fail_command.slice(0, 3)).toEqual([executable, "fail", expect.any(String)]);
      expect(task.heartbeat_command.slice(0, 3)).toEqual([executable, "heartbeat", expect.any(String)]);
      expect(task.inspect_command.slice(0, 3)).toEqual([executable, "inspect", expect.any(String)]);
      expect(task).not.toHaveProperty("write_command");
      expect(task).not.toHaveProperty("record_failure_command");
      expect(task).not.toHaveProperty("record_success_command");
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("creates one running start record when the executor reads leased input", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-start-handoff-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    try {
      const buildPlan = confirmedStandardBuildPlan(source, root);
      const plan = automaticBuildPlan(source, root, { requested_workers: 1, build_plan: buildPlan });
      if (!plan.preflight) throw new Error("expected handoff preflight");
      const result = automaticBuildNext(source, root, 1, {
        protocol: "automatic_build_protocol.v2",
        owner: "handoff-test",
        now: "2026-07-19T00:00:00.000Z",
        accepted_plan_digest: plan.preflight.plan_digest,
        build_plan: buildPlan,
      });
      if (result.action.kind !== "extract" || !result.action.tasks) throw new Error("expected executor task");
      const task = result.action.tasks[0];
      if (!("input_command" in task)) throw new Error("expected executor command envelope");
      const run = spawnSync(task.input_command[0], [
        ...task.input_command.slice(1),
        "--now", "2026-07-19T00:00:01.000Z",
      ], { cwd: root, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const start = JSON.parse(readFileSync(path.join(path.dirname(task.lease_ref), "start.json"), "utf8"));
      expect(start).toMatchObject({
        version: "automatic_build_task_start.v1",
        phase: "running",
        owner: "handoff-test",
        lease_token: task.lease.token,
        started_at: "2026-07-19T00:00:01.000Z",
        run_expires_at: "2026-07-19T00:30:01.000Z",
        execution_identity: task.execution_identity,
      });
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("hands off one executor per dispatch and claims its tasks strictly one at a time", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-handoff-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 2,
      available_agent_slots: 2,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const next = automaticBuildNext(source, root, 2, {
      owner: "dispatch-handoff",
      now: "2026-07-25T00:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 2,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    expect(next.action.kind).toBe("dispatch");
    if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch handoff");
    expect(next.action.dispatches).toHaveLength(Math.min(2, plan.preflight.dispatch_plan.dispatches.length));
    expect(next.action.receipt_aggregation.expected_receipts).toBe(next.action.dispatches.length);
    const target = resolveAutomaticBuildTarget(source, root);
    expect(readAutomaticBuildAttemptSnapshot(target).stages).toEqual({});

    const envelope = next.action.dispatches[0];
    const replayed = automaticBuildNext(source, root, 2, {
      owner: "dispatch-handoff-restart",
      now: "2026-07-25T00:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 2,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in replayed.action) || !replayed.action.dispatches) {
      throw new Error("expected idempotent dispatch replay before claim");
    }
    expect(replayed.action.dispatches[0].manifest.dispatch_id).toBe(envelope.manifest.dispatch_id);
    expect(replayed.action.dispatches[0].dispatch_run_id).toBe(envelope.dispatch_run_id);
    expect(replayed.action.dispatches[0].executor_handoff).toEqual(envelope.executor_handoff);
    expect(readAutomaticBuildAttemptSnapshot(target).stages).toEqual({});

    const first = automaticBuildDispatchNext(source, root, envelope.manifest.stage, envelope.manifest.dispatch_id, {
      now: "2026-07-25T00:00:01.000Z",
    });
    expect(first.action.kind).toBe("task");
    if (first.action.kind !== "task") throw new Error("expected first dispatch task");
    expect(first.action.task.task_id).toBe(envelope.manifest.ordered_work_unit_ids[0]);
    expect(Object.keys(readAutomaticBuildAttemptSnapshot(target).stages.pass1 ?? {})).toEqual([
      envelope.manifest.ordered_work_unit_ids[0],
    ]);

    const concurrent = automaticBuildDispatchNext(source, root, envelope.manifest.stage, envelope.manifest.dispatch_id, {
      now: "2026-07-25T00:00:02.000Z",
    });
    expect(concurrent.action).toMatchObject({ kind: "waiting", work_unit_id: first.action.task.task_id });
    expect(Object.keys(readAutomaticBuildAttemptSnapshot(target).stages.pass1 ?? {})).toHaveLength(1);
  });

  it("hands off one self-contained dispatch and task executor prompt by command", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-prompt-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    try {
      const buildPlan = confirmedStandardBuildPlan(source, root);
      const plan = automaticBuildPlan(source, root, {
        requested_workers: 1,
        available_agent_slots: 1,
        build_plan: buildPlan,
      });
      if (!plan.preflight) throw new Error("expected dispatch preflight");
      const next = automaticBuildNext(source, root, 1, {
        now: "2026-07-25T00:30:00.000Z",
        accepted_plan_digest: plan.preflight.plan_digest,
        available_agent_slots: 1,
        executor_dispatches: true,
        build_plan: buildPlan,
      });
      expect(next.action.kind).toBe("dispatch");
      expect(next.action).not.toHaveProperty("extractor_prompt");
      if (!("dispatches" in next.action) || !next.action.dispatches) {
        throw new Error("dispatch handoff must expose one or more executor envelopes");
      }
      const envelope = next.action.dispatches[0] as (typeof next.action.dispatches)[number] & {
        executor_handoff?: {
          version: string;
          path: string;
          sha256: string;
          byte_length: number;
        };
      };
      expect(envelope.executor_handoff).toMatchObject({
        version: "automatic_build_dispatch_executor_handoff_ref.v1",
        path: expect.stringContaining("executor-handoff.json"),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        byte_length: expect.any(Number),
      });
      if (!envelope.executor_handoff) throw new Error("expected short executor handoff reference");
      expect(path.dirname(envelope.executor_handoff.path)).toBe(path.dirname(envelope.manifest_path));
      const handoffBytes = readFileSync(envelope.executor_handoff.path);
      expect(handoffBytes.byteLength).toBe(envelope.executor_handoff.byte_length);
      expect(createHash("sha256").update(handoffBytes).digest("hex")).toBe(envelope.executor_handoff.sha256);
      const handoff = JSON.parse(handoffBytes.toString("utf8"));
      expect(handoff).toMatchObject({
        version: "automatic_build_dispatch_executor_handoff.v1",
        envelope: {
          version: "automatic_build_dispatch_executor.v1",
          dispatch_run_id: envelope.dispatch_run_id,
        },
      });
      expect(handoff.envelope).not.toHaveProperty("executor_handoff");
      expect(handoff.envelope.interrupt_command).toEqual(expect.arrayContaining([
        "--interruption-code",
        "{diagnostic_code}",
        "--interruption-reporter",
        "{reporter}",
        "--interruption-command-role",
        "{last_command_role}",
      ]));
      expect(handoff.prompt).toContain("automatic_build_dispatch_executor.v1");
      expect(handoff.prompt).toContain("automatic_build_executor.v1");
      expect(JSON.stringify(handoff)).not.toContain("PRIVATE_CANDIDATE_MARKER");
      if (!("extractor_prompt_command" in next.action) || !next.action.extractor_prompt_command) {
        throw new Error("dispatch handoff must expose extractor_prompt_command");
      }
      const run = spawnSync(
        next.action.extractor_prompt_command[0],
        next.action.extractor_prompt_command.slice(1),
        { cwd: next.action.cwd, encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      for (const marker of [
        "automatic_build_dispatch_executor.v1",
        "automatic_build_executor.v1",
        "action.kind=task",
        "action.kind=waiting",
        "action.kind=finish",
        "action.kind=finished",
        "interrupt_command",
        "Never return candidate JSON to the caller",
      ]) {
        expect(run.stdout).toContain(marker);
      }
      const rawPrompt = readFileSync(path.join(REPO_ROOT, "agents", "pass1-local-extractor.md"), "utf8");
      expect(createHash("sha256").update(run.stdout).digest("hex"))
        .not.toBe(createHash("sha256").update(rawPrompt).digest("hex"));
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("does not publish a dispatch manifest when handoff preparation conflicts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-handoff-conflict-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const manifest = plan.preflight.dispatch_plan.dispatches[0];
    const now = "2026-08-02T01:00:00.000Z";
    const target = resolveAutomaticBuildTarget(source, root);
    const manifestPath = automaticBuildDispatchManifestPath(
      target,
      manifest.stage,
      manifest.dispatch_id,
      automaticBuildDispatchRunId(now),
    );
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(path.join(path.dirname(manifestPath), "executor-handoff.json"), "conflicting handoff\n", "utf8");

    expect(() => automaticBuildNext(source, root, 1, {
      now,
      accepted_plan_digest: plan.preflight?.plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    })).toThrow("dispatch executor handoff conflicts");
    expect(existsSync(manifestPath)).toBe(false);
    expect(() => automaticBuildDispatchInspect(
      source,
      root,
      manifest.stage,
      manifest.dispatch_id,
      { dispatch_run_id: automaticBuildDispatchRunId(now) },
    )).toThrow("does not exist");
  });

  it("retires an unclaimed legacy manifest-only run and publishes a fresh run", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-legacy-unclaimed-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact semantic paragraph.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    const legacy = seedLegacyManifestOnly(source, root, plan, "2026-08-02T03:00:00.000Z");
    const next = automaticBuildNext(source, root, 1, {
      now: "2026-08-02T03:01:00.000Z",
      accepted_plan_digest: plan.preflight?.plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) {
      throw new Error("expected recovered dispatch handoff");
    }
    expect(next.action.dispatches[0].dispatch_run_id).not.toBe(
      legacy.publication.prepared.dispatch_run_id,
    );
    const legacyReceipt = JSON.parse(readFileSync(
      path.join(path.dirname(legacy.publication.manifest_path), "receipt.json"),
      "utf8",
    ));
    expect(legacyReceipt).toMatchObject({
      terminal_reason: "executor_interrupted",
      task_receipts: [],
      unclaimed_work_unit_ids: legacy.manifest.ordered_work_unit_ids,
      interruption: {
        version: "automatic_build_executor_interruption.v1",
        diagnostic_code: "legacy_handoff_missing",
        phase: "before_first_claim",
        reporter: "build_engine",
        last_command_role: "unknown",
        last_completed_ordinal: -1,
      },
    });
  });

  it("stops on a claimed legacy manifest-only run instead of backfilling a handoff", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-legacy-claimed-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact semantic paragraph.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    const legacy = seedLegacyManifestOnly(source, root, plan, "2026-08-02T04:00:00.000Z");
    const firstWorkUnitId = legacy.manifest.ordered_work_unit_ids[0];
    const claim = claimAutomaticBuildTask(legacy.target, legacy.manifest.stage, firstWorkUnitId, {
      owner: legacy.publication.prepared.owner,
      now: "2026-08-02T04:00:01.000Z",
      reserve_ttl_ms: 60_000,
    });
    if (claim.status !== "leased") throw new Error("expected legacy owner claim");
    const next = automaticBuildNext(source, root, 1, {
      now: "2026-08-02T04:01:00.000Z",
      accepted_plan_digest: plan.preflight?.plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    expect(next.action).toMatchObject({
      kind: "needs_user",
      reason: "legacy_partial_dispatch_run",
      dispatch_id: legacy.manifest.dispatch_id,
      dispatch_run_id: legacy.publication.prepared.dispatch_run_id,
      has_claim_or_progress: true,
    });
    expect(existsSync(path.join(path.dirname(legacy.publication.manifest_path), "executor-handoff.json")))
      .toBe(false);
  });

  it("rejects a published run after its handoff bytes drift", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-handoff-drift-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    const next = automaticBuildNext(source, root, 1, {
      now: "2026-08-02T05:00:00.000Z",
      accepted_plan_digest: plan.preflight?.plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch");
    const envelope = next.action.dispatches[0];
    writeFileSync(envelope.executor_handoff.path, "{}\n", "utf8");
    expect(() => automaticBuildDispatchInspect(
      source,
      root,
      envelope.manifest.stage,
      envelope.manifest.dispatch_id,
      { dispatch_run_id: envelope.dispatch_run_id },
    )).toThrow("handoff digest mismatch");
  });

  it("reads a historical manifest without an embedded ref when its handoff is valid", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-historical-handoff-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact semantic paragraph.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    const next = automaticBuildNext(source, root, 1, {
      now: "2026-08-02T05:30:00.000Z",
      accepted_plan_digest: plan.preflight?.plan_digest,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch");
    const envelope = next.action.dispatches[0];
    const persisted = JSON.parse(readFileSync(envelope.manifest_path, "utf8"));
    delete persisted.executor_handoff;
    writeFileSync(envelope.manifest_path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    expect(automaticBuildDispatchInspect(
      source,
      root,
      envelope.manifest.stage,
      envelope.manifest.dispatch_id,
      { dispatch_run_id: envelope.dispatch_run_id },
    )).toMatchObject({
      state: "active",
      next_work_unit_id: envelope.manifest.ordered_work_unit_ids[0],
    });
  });

  it("continues after semantic failure and returns a bounded candidate-free dispatch receipt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-receipt-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const next = automaticBuildNext(source, root, 1, {
      owner: "dispatch-receipt",
      now: "2026-07-25T01:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch handoff");
    const manifest = next.action.dispatches[0].manifest;
    expect(manifest.ordered_work_unit_ids.length).toBeGreaterThan(1);

    const first = automaticBuildDispatchNext(source, root, manifest.stage, manifest.dispatch_id, {
      now: "2026-07-25T01:00:01.000Z",
    });
    if (first.action.kind !== "task") throw new Error("expected first task");
    failAutomaticBuildTask(
      resolveAutomaticBuildTarget(source, root),
      first.action.task.lease_ref,
      first.action.task.lease.token,
      { diagnostic_code: "semantic_invalid", now: "2026-07-25T01:00:02.000Z" },
    );
    const second = automaticBuildDispatchNext(source, root, manifest.stage, manifest.dispatch_id, {
      now: "2026-07-25T01:00:03.000Z",
    });
    expect(second.action.kind).toBe("task");
    if (second.action.kind !== "task") throw new Error("expected second task");
    expect(second.action.task.task_id).toBe(manifest.ordered_work_unit_ids[1]);

    let current = second;
    while (current.action.kind === "task") {
      commitDispatchTask(resolveAutomaticBuildTarget(source, root), current.action.task, "PRIVATE_CANDIDATE_MARKER");
      current = automaticBuildDispatchNext(source, root, manifest.stage, manifest.dispatch_id, {
        now: "2026-07-25T01:00:04.000Z",
      });
    }
    expect(current.action.kind).toBe("finish");
    const receipt = automaticBuildDispatchFinish(source, root, manifest.stage, manifest.dispatch_id, {
      now: "2026-07-25T01:00:05.000Z",
    });
    expect(receipt.terminal_reason).toBe("task_failure");
    expect(receipt.task_receipts).toHaveLength(manifest.ordered_work_unit_ids.length);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_CANDIDATE_MARKER");
  });

  it("finishes task_failure after the third semantic failure and leaves retry diagnosis to root replan", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-exhausted-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const firstTaskId = plan.preflight.dispatch_plan.dispatches[0].ordered_work_unit_ids[0];
    const target = resolveAutomaticBuildTarget(source, root);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const claim = claimAutomaticBuildTask(target, "pass1", firstTaskId, {
        owner: `seed-semantic-failure-${attempt}`,
        now: `2026-07-25T01:0${attempt}:00.000Z`,
        reserve_ttl_ms: 60_000,
        max_semantic_attempts: 3,
      });
      if (claim.status !== "leased") throw new Error(`expected seed lease ${attempt}`);
      failAutomaticBuildTask(target, claim.lease_ref, claim.lease.token, {
        diagnostic_code: "semantic_invalid",
        now: `2026-07-25T01:0${attempt}:01.000Z`,
      });
    }
    const next = automaticBuildNext(source, root, 1, {
      now: "2026-07-25T02:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch handoff");
    const envelope = next.action.dispatches[0];
    const third = automaticBuildDispatchNext(source, root, envelope.manifest.stage, envelope.manifest.dispatch_id, {
      dispatch_run_id: envelope.dispatch_run_id,
      now: "2026-07-25T02:00:01.000Z",
    });
    if (third.action.kind !== "task") throw new Error("expected third semantic task");
    expect(third.action.task.execution_identity.semantic_attempt).toBe(3);
    failAutomaticBuildTask(target, third.action.task.lease_ref, third.action.task.lease.token, {
      diagnostic_code: "semantic_invalid",
      now: "2026-07-25T02:00:02.000Z",
    });
    const terminal = automaticBuildDispatchNext(source, root, envelope.manifest.stage, envelope.manifest.dispatch_id, {
      dispatch_run_id: envelope.dispatch_run_id,
      now: "2026-07-25T02:00:03.000Z",
    });
    expect(terminal.action.kind).toBe("finish");
    if (terminal.action.kind !== "finish") throw new Error("expected task-failure finish action");
    expect(terminal.action.finish_command).toContain("task_failure");
    const receipt = automaticBuildDispatchFinish(source, root, envelope.manifest.stage, envelope.manifest.dispatch_id, {
      dispatch_run_id: envelope.dispatch_run_id,
      terminal_reason: "task_failure",
      now: "2026-07-25T02:00:04.000Z",
    });
    expect(receipt.unclaimed_work_unit_ids).toEqual(envelope.manifest.ordered_work_unit_ids.slice(1));
    const replanned = automaticBuildNext(source, root, 1, {
      now: "2026-07-25T02:00:05.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    expect(replanned.action).toMatchObject({ kind: "needs_user", reason: "retry_exhausted" });
  });

  it("finishes executor_interrupted after the lease epoch limit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-unstable-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const next = automaticBuildNext(source, root, 1, {
      now: "2026-07-25T03:00:00.000Z",
      lease_ttl_ms: 1_000,
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch handoff");
    const envelope = next.action.dispatches[0];
    for (let epoch = 1; epoch <= 3; epoch += 1) {
      const claimed = automaticBuildDispatchNext(source, root, envelope.manifest.stage, envelope.manifest.dispatch_id, {
        dispatch_run_id: envelope.dispatch_run_id,
        now: `2026-07-25T03:00:0${epoch - 1}.001Z`,
      });
      if (claimed.action.kind !== "task") throw new Error(`expected lease epoch ${epoch}`);
      expect(claimed.action.task.execution_identity).toMatchObject({
        semantic_attempt: 1,
        lease_epoch: epoch,
      });
    }
    const terminal = automaticBuildDispatchNext(source, root, envelope.manifest.stage, envelope.manifest.dispatch_id, {
      dispatch_run_id: envelope.dispatch_run_id,
      now: "2026-07-25T03:00:03.001Z",
    });
    expect(terminal.action.kind).toBe("finish");
    if (terminal.action.kind !== "finish") throw new Error("expected executor-interrupted finish action");
    expect(terminal.action.finish_command).toContain("executor_interrupted");
    expect(terminal.action.finish_command).toEqual(expect.arrayContaining([
      "--interruption-code",
      "executor_lost",
      "--interruption-reporter",
      "build_engine",
      "--interruption-command-role",
      "dispatch_next",
    ]));
  });

  it("finishes an interrupted dispatch without claiming its remaining tasks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-interrupt-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const next = automaticBuildNext(source, root, 1, {
      owner: "dispatch-interrupt",
      now: "2026-07-25T02:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch handoff");
    const manifest = next.action.dispatches[0].manifest;
    const claimed = automaticBuildDispatchNext(source, root, manifest.stage, manifest.dispatch_id, {
      now: "2026-07-25T02:00:01.000Z",
    });
    expect(claimed.action.kind).toBe("task");
    const receipt = automaticBuildDispatchFinish(source, root, manifest.stage, manifest.dispatch_id, {
      terminal_reason: "executor_interrupted",
      now: "2026-07-25T02:00:02.000Z",
      interruption: {
        diagnostic_code: "harness_cancelled",
        reporter: "root_supervisor",
        last_command_role: "dispatch_next",
      },
    });
    expect(receipt.unclaimed_work_unit_ids).toEqual(manifest.ordered_work_unit_ids.slice(1));
    expect(receipt.interruption).toMatchObject({
      phase: "task_reserved",
      active_work_unit_id: manifest.ordered_work_unit_ids[0],
      last_completed_ordinal: -1,
    });
    const target = resolveAutomaticBuildTarget(source, root);
    expect(Object.keys(readAutomaticBuildAttemptSnapshot(target).stages.pass1 ?? {})).toEqual([
      manifest.ordered_work_unit_ids[0],
    ]);
    expect(automaticBuildDispatchInspect(source, root, manifest.stage, manifest.dispatch_id).state).toBe("finished");
    expect(automaticBuildDispatchNext(source, root, manifest.stage, manifest.dispatch_id).action.kind).toBe("finished");
  });

  it("fails closed when the configured packaged prompt provider is unavailable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-packaged-dispatch-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const buildPlan = confirmedStandardBuildPlan(source, root);
      const plan = automaticBuildPlan(source, root, {
        requested_workers: 1,
        available_agent_slots: 1,
        build_plan: buildPlan,
      });
      if (!plan.preflight) throw new Error("expected dispatch preflight");
      const next = automaticBuildNext(source, root, 1, {
        now: "2026-07-25T02:30:00.000Z",
        accepted_plan_digest: plan.preflight.plan_digest,
        available_agent_slots: 1,
        executor_dispatches: true,
        build_plan: buildPlan,
      });
      expect(next.protocol).toBe("automatic_build_protocol.v2_dispatch");
      expect(next.action).toMatchObject({
        kind: "needs_user",
        reason: "executor_prompt_unavailable",
        diagnostic_code: "prompt_provider_unavailable",
        prompt_source: "packaged_sidecar",
      });
      expect(JSON.stringify(next.action)).not.toContain(process.env.UNDERSTAND_BOOK_SIDECAR_SELF);
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("freezes receipt-only execution in the skill and every specialized extractor", () => {
    const skill = readFileSync(path.join(REPO_ROOT, "skills", "build", "SKILL.md"), "utf8");
    const pluginSkill = readFileSync(path.join(
      REPO_ROOT,
      "plugins",
      "understand-book",
      "skills",
      "build",
      "SKILL.md",
    ), "utf8");
    expect(skill).toBe(pluginSkill);
    for (const marker of [
      "automatic_build_executor.v1",
      "needs_user(executor_unavailable)",
      "The root agent must never receive, restate, cache, write, or forward candidate JSON",
      "candidate_command",
      "PowerShell 5.1",
      "`legacy-submit`",
      "automatic_build_dispatch_executor.v1",
      "automatic_build_dispatch_executor_handoff.v1",
      "executor_handoff",
      "interrupt_command",
      "automatic_build_executor_interruption.v1",
      "before_first_claim",
      "consume neither a semantic attempt nor a lease epoch",
      "run `legacy-plan` exactly once",
      "path.relative(action.cwd, executor_handoff.path)",
      "handoff_relative_path",
      "zero semantic attempts and zero lease epochs",
      "Only a canonical failure",
    ]) {
      expect(skill).toContain(marker);
    }

    for (const prompt of EXTRACTOR_PROMPTS) {
      const content = readFileSync(path.join(REPO_ROOT, "agents", prompt), "utf8");
      expect(content, prompt).toContain("Automatic Build Executor Envelope");
      expect(content, prompt).toContain("`candidate_path`");
      expect(content, prompt).toContain("`submit_command`");
      expect(content.toLowerCase(), prompt).toContain("return only");
      expect(content, prompt).toContain("Never return candidate JSON");
    }
  });
});
