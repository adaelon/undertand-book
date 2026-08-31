import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAutomaticBuildPreflight,
  type AutomaticBuildBudgetLimitsV1,
} from "../src/automatic-build-budget";
import {
  planAutomaticBuildExecutorDispatches,
  selectAutomaticBuildDispatchRefill,
} from "../src/automatic-build-dispatch";
import { submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import { recordAutomaticBuildInputObservation } from "../src/automatic-build-metrics";
import { MODEL_INPUT_RENDER_CONTRACT_VERSION } from "../src/model-input-renderer";
import { readAutomaticBuildAttemptSnapshot } from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import {
  buildWorkUnitCost,
  createWorkUnitDescriptor,
  type WorkUnitDescriptor,
  type WorkUnitDescriptorV2,
} from "../src/stage-work-unit";
import {
  automaticBuildDispatchFinish,
  automaticBuildDispatchNext,
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";
import { writePass1ProductionTaskArtifact } from "./helpers/model-input-routability-fixture";

const targetRef = {
  version: "build_target_ref.v2" as const,
  workspace_dir: "C:/repo/.understand-book/concurrency",
  book_id: "concurrency",
  profile_id: "technical_learning" as const,
  input_fingerprint: "concurrency-fingerprint",
};
const policy = automaticBuildExtractionPolicy("pass1", resolveContentProfile("technical_learning"), "full");
const budget: AutomaticBuildBudgetLimitsV1 = {
  version: "automatic_build_budget_limits.v1",
  max_tasks: 100,
  max_total_score: 1_000_000,
  max_estimated_total_tokens: 1_000_000,
  max_batch_score: 1_000_000,
  max_parallel_cost: 1_000_000,
};

function descriptor(id: string, scoreInput: number): WorkUnitDescriptorV2 {
  return createWorkUnitDescriptor({
    target: targetRef,
    stage: "pass1",
    work_unit_id: id,
    kind: "pass1_window",
    input_hash: id.padEnd(64, "a").slice(0, 64),
    policy_fingerprint: policy,
    evidence_lids: [`${id}.1`],
    cost: buildWorkUnitCost({ estimated_input_tokens: scoreInput, visible_lids: 1, expected_output_items: 1 }),
  });
}

function recordProofBoundFakeInput(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  task: {
    descriptor: WorkUnitDescriptor;
    lease_ref: string;
    lease: { token: string; issued_at: string };
  },
): void {
  if (task.descriptor.version !== "automatic_build_work_unit.v3") return;
  recordAutomaticBuildInputObservation(target, task.lease_ref, task.lease.token, {
    started_at: task.lease.issued_at,
    finished_at: task.lease.issued_at,
    input_bytes: 0,
    input_sha256: task.descriptor.input_hash,
    render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
  });
}

function sourceWithWindows(): string {
  return [
    "# Concurrency guide",
    ...Array.from({ length: 320 }, (_, index) => (
      `Paragraph ${index + 1} contains deterministic semantic evidence for the concurrent build protocol.`
    )),
  ].join("\n\n");
}

async function fakeExecutorRun(workerSlots: 1 | 2 | 3, reduceAfterFirst = false) {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-concurrency-${workerSlots}-`));
  const source = path.join(root, "concurrency-guide.md");
  writeFileSync(source, sourceWithWindows(), "utf8");
  const target = resolveAutomaticBuildTarget(source, root);
  const seen = new Set<string>();
  const artifactHashes: Record<string, string> = {};
  const batchSizes: number[] = [];
  const planDigests = new Set<string>();
  let receiptCount = 0;
  const buildPlan = confirmedStandardBuildPlan(source, root);

  for (let round = 0; round < 20; round += 1) {
    const liveSlots = reduceAfterFirst && round > 0 ? 1 : workerSlots;
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 3,
      available_agent_slots: liveSlots,
      quality_profile: "full",
      budget,
      build_plan: buildPlan,
    });
    if (!plan.preflight) {
      expect(plan.next_action).toMatchObject({ kind: "close_stage", stage: "pass1" });
      break;
    }
    planDigests.add(plan.preflight.descriptor_plan_digest);
    const next = automaticBuildNext(source, root, 3, {
      protocol: "automatic_build_protocol.v2",
      owner: `fake-dispatcher-${workerSlots}`,
      now: `2026-07-19T00:00:${String(round).padStart(2, "0")}.000Z`,
      lease_ttl_ms: 60_000,
      quality_profile: "full",
      budget,
      available_agent_slots: liveSlots,
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      build_plan: buildPlan,
    });
    expect(next.action.kind).toBe("extract");
    if (next.action.kind !== "extract" || !next.action.tasks) throw new Error("expected concurrent extract batch");
    if (!("receipt_aggregation" in next.action)) throw new Error("expected receipt aggregation contract");
    batchSizes.push(next.action.tasks.length);
    expect(next.action.tasks.length).toBeLessThanOrEqual(liveSlots);
    expect(next.action.receipt_aggregation).toMatchObject({
      expected_receipts: next.action.tasks.length,
      max_receipt_bytes: 4_096,
      max_total_bytes: next.action.tasks.length * 4_096,
      candidate_payload_forbidden: true,
    });

    const receipts = await Promise.all(next.action.tasks.map((task) => new Promise<ReturnType<typeof submitAutomaticBuildCandidate>>((resolve, reject) => {
      setImmediate(() => {
        try {
          if (!("candidate_path" in task)) throw new Error("expected leased executor task");
          expect(seen.has(task.task_id)).toBe(false);
          seen.add(task.task_id);
          recordProofBoundFakeInput(target, task);
          writeFileSync(task.candidate_path, JSON.stringify({
            content_hash: task.descriptor.input_hash,
            nodes: [],
            edges: [],
          }), "utf8");
          const receipt = submitAutomaticBuildCandidate(
            target,
            task.lease_ref,
            task.lease.token,
            task.candidate_path,
            () => {
              if (!task.lease.policy_generation_id) throw new Error("expected a v3 policy-set lease");
              return writePass1ProductionTaskArtifact({
                target,
                policy_generation_id: task.lease.policy_generation_id,
                work_unit_id: task.task_id,
                generated_at: task.lease.issued_at,
              });
            },
            { now: task.lease.issued_at, completed_at: task.lease.issued_at },
          );
          resolve(receipt);
        } catch (error) {
          reject(error);
        }
      });
    })));
    receiptCount += receipts.length;
    for (const receipt of receipts) {
      expect(receipt.state).toBe("committed");
      expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(4_096);
      expect(receipt).not.toHaveProperty("payload");
      const artifact = JSON.parse(readFileSync(receipt.artifact_path!, "utf8")) as { artifact_hash: string };
      artifactHashes[receipt.work_unit_id] = artifact.artifact_hash;
    }
  }

  expect(batchSizes[0]).toBe(workerSlots);
  expect(receiptCount).toBe(seen.size);
  const attempts = readAutomaticBuildAttemptSnapshot(target).stages.pass1 ?? {};
  expect(Object.keys(attempts)).toHaveLength(seen.size);
  expect(Object.values(attempts).every((record) => record.last_attempt === 1 && record.failures === 0)).toBe(true);
  return { artifactHashes, seen: [...seen].sort(), batchSizes, planDigests: [...planDigests] };
}

describe("automatic build safe concurrent execution", () => {
  it("refills a free worker immediately without waiting for slower active dispatches", () => {
    const units = Array.from({ length: 16 }, (_, index) => descriptor(`refill-${index}`, 10));
    const plan = planAutomaticBuildExecutorDispatches({
      target_ref: targetRef,
      stage: "pass1",
      work_units: units,
      pending_ids: units.map((unit) => unit.work_unit_id),
      available_agent_slots: 3,
    });
    expect(plan.dispatches).toHaveLength(4);
    const initial = plan.selected_dispatch_ids;
    const refill = selectAutomaticBuildDispatchRefill(plan, {
      active_dispatch_ids: initial.slice(1),
      completed_dispatch_ids: [initial[0]],
      available_agent_slots: 3,
    });
    expect(refill).toEqual([plan.dispatches[3].dispatch_id]);
  });

  it("refills from the accepted runtime plan while slower dispatches remain active", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-runtime-refill-"));
    const source = path.join(root, "concurrency-guide.md");
    writeFileSync(source, [
      "# Runtime refill guide",
      ...Array.from({ length: 1_300 }, (_, index) => (
        `Paragraph ${index + 1} contains stable semantic evidence for runtime refill.`
      )),
    ].join("\n\n"), "utf8");
    const target = resolveAutomaticBuildTarget(source, root);
    const refillBudget: AutomaticBuildBudgetLimitsV1 = {
      ...budget,
      max_tasks: 10_000,
      max_total_score: 1_000_000_000,
      max_estimated_total_tokens: 1_000_000_000,
      max_batch_score: 1_000_000_000,
      max_parallel_cost: 1_000_000_000,
    };
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const initialPlan = automaticBuildPlan(source, root, {
      requested_workers: 3,
      available_agent_slots: 3,
      budget: refillBudget,
      build_plan: buildPlan,
    });
    if (!initialPlan.preflight || initialPlan.preflight.dispatch_plan.dispatches.length < 4) {
      throw new Error("expected at least four executor dispatches");
    }
    const initial = automaticBuildNext(source, root, 3, {
      owner: "runtime-refill",
      now: "2026-07-25T03:00:00.000Z",
      budget: refillBudget,
      available_agent_slots: 3,
      accepted_plan_digest: initialPlan.preflight.descriptor_plan_digest,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in initial.action) || !initial.action.dispatches) {
      throw new Error("expected initial dispatch handoff");
    }
    expect(initial.action.dispatches).toHaveLength(3);
    for (const slow of initial.action.dispatches.slice(1)) {
      expect(automaticBuildDispatchNext(source, root, slow.manifest.stage, slow.manifest.dispatch_id, {
        dispatch_run_id: slow.dispatch_run_id,
        now: "2026-07-25T03:00:01.000Z",
      }).action.kind).toBe("task");
    }
    const fastest = initial.action.dispatches[0].manifest;
    let step = automaticBuildDispatchNext(source, root, fastest.stage, fastest.dispatch_id, {
      now: "2026-07-25T03:00:01.000Z",
    });
    let second = 2;
    while (step.action.kind === "task") {
      const task = step.action.task;
      recordProofBoundFakeInput(target, task);
      writeFileSync(task.candidate_path, JSON.stringify({
        content_hash: task.descriptor.input_hash,
        nodes: [],
        edges: [],
      }), "utf8");
      submitAutomaticBuildCandidate(
        target,
        task.lease_ref,
        task.lease.token,
        task.candidate_path,
        () => {
          if (!task.lease.policy_generation_id) throw new Error("expected a v3 policy-set lease");
          return writePass1ProductionTaskArtifact({
            target,
            policy_generation_id: task.lease.policy_generation_id,
            work_unit_id: task.task_id,
            generated_at: task.lease.issued_at,
          });
        },
        { now: task.lease.issued_at, completed_at: task.lease.issued_at },
      );
      step = automaticBuildDispatchNext(source, root, fastest.stage, fastest.dispatch_id, {
        now: `2026-07-25T03:00:${String(second).padStart(2, "0")}.000Z`,
      });
      second += 1;
    }
    expect(step.action.kind).toBe("finish");
    automaticBuildDispatchFinish(source, root, fastest.stage, fastest.dispatch_id, {
      now: "2026-07-25T03:00:30.000Z",
    });

    const refillPlan = automaticBuildPlan(source, root, {
      requested_workers: 3,
      available_agent_slots: 1,
      budget: refillBudget,
      build_plan: buildPlan,
    });
    if (!refillPlan.preflight) throw new Error("expected refill preflight");
    const refill = automaticBuildNext(source, root, 3, {
      owner: "runtime-refill",
      now: "2026-07-25T03:00:31.000Z",
      budget: refillBudget,
      available_agent_slots: 1,
      accepted_plan_digest: refillPlan.preflight.descriptor_plan_digest,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in refill.action) || !refill.action.dispatches) {
      throw new Error("expected refill dispatch handoff");
    }
    expect(refill.action.dispatches).toHaveLength(1);
    expect(refill.action.dispatches[0].manifest.dispatch_id).toBe(
      initialPlan.preflight.dispatch_plan.dispatches[3].dispatch_id,
    );
  }, 20_000);

  it("caps workers by live slots, hard limit three, and parallel cost without changing plan identity", () => {
    const units = [descriptor("a", 10), descriptor("b", 20), descriptor("c", 30), descriptor("d", 40)];
    const base = {
      target_ref: targetRef,
      stage: "pass1" as const,
      work_units: units,
      pending_ids: units.map((unit) => unit.work_unit_id),
      quality_profile: "full" as const,
      requested_workers: 5,
      budget,
    };
    const three = buildAutomaticBuildPreflight({ ...base, available_agent_slots: 3 });
    const one = buildAutomaticBuildPreflight({ ...base, available_agent_slots: 1 });
    const zero = buildAutomaticBuildPreflight({ ...base, available_agent_slots: 0 });
    const costLimited = buildAutomaticBuildPreflight({
      ...base,
      available_agent_slots: 3,
      budget: { ...budget, max_parallel_cost: units[0].cost.score + units[1].cost.score },
    });

    expect(three.descriptor_plan_digest).toBe(one.descriptor_plan_digest);
    expect(one.descriptor_plan_digest).toBe(zero.descriptor_plan_digest);
    expect(three.worker_plan).toMatchObject({ max_workers: 3, hard_worker_limit: 3, concurrency_release: "ap14_safe_concurrency.v1" });
    expect(one.worker_plan.max_workers).toBe(1);
    expect(zero.worker_plan).toMatchObject({ available_agent_slots: 0, max_workers: 0 });
    expect(costLimited.worker_plan.max_workers).toBe(2);
    expect(three.work_units.pending).toBe(one.work_units.pending);
  });

  it("returns executor_unavailable with zero live slots and creates no task state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-no-slots-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA semantic paragraph.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 3,
      available_agent_slots: 0,
      budget,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected no-slot preflight");
    const next = automaticBuildNext(source, root, 3, {
      available_agent_slots: 0,
      budget,
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      build_plan: buildPlan,
    });
    expect(next.action).toMatchObject({ kind: "needs_user", reason: "executor_unavailable", stage: "pass1" });
    expect(() => readAutomaticBuildAttemptSnapshot(resolveAutomaticBuildTarget(source, root))).not.toThrow();
    expect(readAutomaticBuildAttemptSnapshot(resolveAutomaticBuildTarget(source, root)).stages).toEqual({});
  });

  it("produces identical semantic artifact digests with one, two, or three fake workers", async () => {
    const one = await fakeExecutorRun(1);
    const two = await fakeExecutorRun(2);
    const three = await fakeExecutorRun(3);

    expect(two.seen).toEqual(one.seen);
    expect(three.seen).toEqual(one.seen);
    expect(two.artifactHashes).toEqual(one.artifactHashes);
    expect(three.artifactHashes).toEqual(one.artifactHashes);
  }, 20_000);

  it("keeps every pending task when live slots shrink from three to one", async () => {
    const reduced = await fakeExecutorRun(3, true);
    expect(reduced.batchSizes[0]).toBe(3);
    expect(reduced.batchSizes.slice(1).every((size) => size === 1)).toBe(true);
    expect(reduced.planDigests).toHaveLength(1);
    expect(Object.keys(reduced.artifactHashes)).toHaveLength(reduced.seen.length);
  }, 20_000);
});
