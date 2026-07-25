import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { readAutomaticBuildAttemptSnapshot } from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const EXTRACTOR_PROMPTS = [
  "pass1-local-extractor.md",
  "paper-metadata-extractor.md",
  "paper-lexicon-extractor.md",
  "profile-sidecar-extractor.md",
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
  writeFileSync(task.candidate_path, JSON.stringify({
    content_hash: task.descriptor.input_hash,
    nodes: [],
    edges: [],
    marker,
  }), "utf8");
  const artifactPath = path.join(target.workspace_dir, ".build", "pass1", `${task.task_id}.json`);
  return submitAutomaticBuildCandidate(
    target,
    task.lease_ref,
    task.lease.token,
    task.candidate_path,
    (candidatePath) => {
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, readFileSync(candidatePath));
      return { artifact_path: artifactPath, output_counts: { nodes: 0, edges: 0 } };
    },
    { now: task.lease.issued_at, completed_at: task.lease.issued_at },
  );
}

describe("automatic build Codex executor handoff", () => {
  it("emits a lease envelope without a root candidate relay", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-handoff-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const plan = automaticBuildPlan(source, root, { requested_workers: 1 });
      if (!plan.preflight) throw new Error("expected handoff preflight");
      const result = automaticBuildNext(source, root, 1, {
        protocol: "automatic_build_protocol.v2",
        owner: "handoff-test",
        now: "2026-07-19T00:00:00.000Z",
        lease_ttl_ms: 60_000,
        accepted_plan_digest: plan.preflight.plan_digest,
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
          version: "automatic_build_work_unit.v2",
          work_unit_id: "0",
          kind: "pass1_window",
          cost: { score: expect.any(Number) },
        },
        lease: {
          version: "automatic_build_task_lease.v2",
          phase: "reserved",
          reserved_at: "2026-07-19T00:00:00.000Z",
          reserve_expires_at: "2026-07-19T00:01:00.000Z",
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
      const plan = automaticBuildPlan(source, root, { requested_workers: 1 });
      if (!plan.preflight) throw new Error("expected handoff preflight");
      const result = automaticBuildNext(source, root, 1, {
        protocol: "automatic_build_protocol.v2",
        owner: "handoff-test",
        now: "2026-07-19T00:00:00.000Z",
        accepted_plan_digest: plan.preflight.plan_digest,
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
    const plan = automaticBuildPlan(source, root, { requested_workers: 2, available_agent_slots: 2 });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const next = automaticBuildNext(source, root, 2, {
      owner: "dispatch-handoff",
      now: "2026-07-25T00:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 2,
      executor_dispatches: true,
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
    });
    if (!("dispatches" in replayed.action) || !replayed.action.dispatches) {
      throw new Error("expected idempotent dispatch replay before claim");
    }
    expect(replayed.action.dispatches[0].manifest.dispatch_id).toBe(envelope.manifest.dispatch_id);
    expect(replayed.action.dispatches[0].dispatch_run_id).toBe(envelope.dispatch_run_id);
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

  it("continues after semantic failure and returns a bounded candidate-free dispatch receipt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-receipt-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const plan = automaticBuildPlan(source, root, { requested_workers: 1, available_agent_slots: 1 });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const next = automaticBuildNext(source, root, 1, {
      owner: "dispatch-receipt",
      now: "2026-07-25T01:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
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

  it("finishes an interrupted dispatch without claiming its remaining tasks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-interrupt-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const plan = automaticBuildPlan(source, root, { requested_workers: 1, available_agent_slots: 1 });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const next = automaticBuildNext(source, root, 1, {
      owner: "dispatch-interrupt",
      now: "2026-07-25T02:00:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
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
    });
    expect(receipt.unclaimed_work_unit_ids).toEqual(manifest.ordered_work_unit_ids.slice(1));
    const target = resolveAutomaticBuildTarget(source, root);
    expect(Object.keys(readAutomaticBuildAttemptSnapshot(target).stages.pass1 ?? {})).toEqual([
      manifest.ordered_work_unit_ids[0],
    ]);
    expect(automaticBuildDispatchInspect(source, root, manifest.stage, manifest.dispatch_id).state).toBe("finished");
    expect(automaticBuildDispatchNext(source, root, manifest.stage, manifest.dispatch_id).action.kind).toBe("finished");
  });

  it("emits self-contained packaged dispatch commands with an explicit run identity", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-packaged-dispatch-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, dispatchSource(), "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const plan = automaticBuildPlan(source, root, { requested_workers: 1, available_agent_slots: 1 });
      if (!plan.preflight) throw new Error("expected dispatch preflight");
      const next = automaticBuildNext(source, root, 1, {
        now: "2026-07-25T02:30:00.000Z",
        accepted_plan_digest: plan.preflight.plan_digest,
        available_agent_slots: 1,
        executor_dispatches: true,
      });
      if (!("dispatches" in next.action) || !next.action.dispatches) throw new Error("expected dispatch handoff");
      const envelope = next.action.dispatches[0];
      expect(next.protocol).toBe("automatic_build_protocol.v2_dispatch");
      expect(envelope.dispatch_run_id).toMatch(/^run-/);
      expect(envelope.next_command.slice(0, 2)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "dispatch.next"]);
      expect(envelope.inspect_command.slice(0, 2)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "dispatch.inspect"]);
      expect(envelope.finish_command.slice(0, 2)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "dispatch.finish"]);
      expect(envelope.next_command).toContain("--dispatch-run");
      expect(envelope.next_command).toContain(envelope.dispatch_run_id);
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
    expect(skill).toContain("automatic_build_executor.v1");
    expect(skill).toContain("needs_user(executor_unavailable)");
    expect(skill).toContain("root 禁止接收、复述、缓存、写入或转发 candidate JSON");
    expect(skill).toContain("candidate_command");
    expect(skill).toContain("PowerShell 5.1");
    expect(skill).toContain("也禁止调用");
    expect(skill).toContain("`legacy-submit`");
    expect(skill).toContain("automatic_build_dispatch_executor.v1");
    expect(skill).toContain("subagent,不得按");
    expect(skill).toContain("interrupt_command");
    expect(pluginSkill).toContain("candidate_command");
    expect(pluginSkill).toContain("PowerShell 5.1");
    expect(pluginSkill).toContain("automatic_build_dispatch_executor.v1");
    expect(pluginSkill).toContain("interrupt_command");

    for (const prompt of EXTRACTOR_PROMPTS) {
      const content = readFileSync(path.join(REPO_ROOT, "agents", prompt), "utf8");
      expect(content, prompt).toContain("Automatic Build Executor Envelope");
      expect(content, prompt).toContain("directly at `candidate_path`");
      expect(content, prompt).toContain("return only its receipt JSON");
      expect(content, prompt).toContain("Never return candidate JSON to the caller");
    }
  });
});
