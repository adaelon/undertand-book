import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  observeAutomaticBuildRemainingWork,
  observeExecutorSlotInterval,
  observeExecutorSlots,
  type AutomaticBuildRemainingWorkV1,
} from "../src/automatic-build-observation";
import {
  claimAutomaticBuildTask,
  startAutomaticBuildLease,
} from "../src/automatic-build-lease";
import {
  resolveAutomaticBuildTarget,
  type AutomaticBuildSnapshot,
} from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import {
  buildWorkUnitCost,
  createWorkUnitDescriptor,
  type WorkUnitDescriptor,
} from "../src/stage-work-unit";
import { automaticBuildRemainingWork } from "../../../skills/build/automatic-build";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:01:00.000Z";

function targetFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-observation-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  return resolveAutomaticBuildTarget(source, root);
}

function descriptor(
  target: ReturnType<typeof targetFixture>,
  workUnitId: string,
): WorkUnitDescriptor {
  return createWorkUnitDescriptor({
    target: target.target_ref,
    stage: "pass1",
    work_unit_id: workUnitId,
    kind: "pass1_window",
    input_hash: workUnitId.padEnd(64, "a").slice(0, 64),
    policy_fingerprint: automaticBuildExtractionPolicy(
      "pass1",
      resolveContentProfile("technical_learning"),
      "full",
    ),
    evidence_lids: [`${workUnitId}.1`],
    cost: buildWorkUnitCost({
      estimated_input_tokens: 1,
      visible_lids: 1,
      expected_output_items: 1,
    }),
  });
}

function remaining(overrides: Partial<AutomaticBuildRemainingWorkV1>): AutomaticBuildRemainingWorkV1 {
  return {
    stage: "pass1",
    kind: "pass1_window",
    pending: 0,
    reserved: 0,
    running: 0,
    terminal: 0,
    ...overrides,
  };
}

describe("automatic build scheduling observations", () => {
  it("aggregates every durable work unit by kind without treating executor sessions as work units", () => {
    const target = targetFixture();
    const workUnits = Array.from({ length: 32 }, (_, index) => descriptor(target, `unit-${index}`));
    const pendingWorkUnits = workUnits.slice(8);
    const snapshot: AutomaticBuildSnapshot = {
      target,
      stages: [{
        stage: "pass1",
        pending_tasks: pendingWorkUnits.map((unit) => unit.work_unit_id),
        pending_work_units: pendingWorkUnits,
        work_units: workUnits,
        closed: false,
      }],
    };

    for (const workUnit of workUnits.slice(16, 24)) {
      const reserved = claimAutomaticBuildTask(target, "pass1", workUnit.work_unit_id, {
        owner: `reserved-owner-${workUnit.work_unit_id}`,
        now: T0,
      });
      if (reserved.status !== "leased") throw new Error("expected reserved observation fixture");
    }
    for (const workUnit of workUnits.slice(24)) {
      const running = claimAutomaticBuildTask(target, "pass1", workUnit.work_unit_id, {
        owner: `running-owner-${workUnit.work_unit_id}`,
        now: T0,
      });
      if (running.status !== "leased") throw new Error("expected running observation fixture");
      startAutomaticBuildLease(target, running.lease_ref, running.lease.token, { now: T1 });
    }

    expect(observeAutomaticBuildRemainingWork(snapshot, { now: T1 })).toEqual([{
      stage: "pass1",
      kind: "pass1_window",
      pending: 8,
      reserved: 8,
      running: 8,
      terminal: 8,
    }]);

    const publicObservation = automaticBuildRemainingWork(
      target.source_path,
      target.root_dir,
      { now: T1 },
    );
    expect(publicObservation.version).toBe("automatic_build_remaining_work_observation.v1");
    expect(publicObservation.remaining_work.reduce(
      (sum, item) => sum + item.pending + item.reserved + item.running + item.terminal,
      0,
    )).toBeGreaterThan(0);
  });

  it("classifies idle slots from ready work, barriers, tail work, and terminal truth", () => {
    expect(observeExecutorSlots({
      slot_capacity: 3,
      live_slots: 2,
      observed_ms: 1_250,
      remaining_work: [remaining({ pending: 1, running: 2 })],
      stage_barrier: false,
    })).toEqual({
      live_slots: 2,
      idle_slots: 1,
      idle_reason: "root_refill_gap",
      observed_ms: 1_250,
    });

    expect(observeExecutorSlots({
      slot_capacity: 3,
      live_slots: 1,
      observed_ms: 2_000,
      remaining_work: [remaining({ running: 1 })],
      stage_barrier: true,
    })?.idle_reason).toBe("stage_barrier");

    expect(observeExecutorSlots({
      slot_capacity: 3,
      live_slots: 1,
      observed_ms: 2_500,
      remaining_work: [remaining({ running: 1 })],
      stage_barrier: false,
    })?.idle_reason).toBe("tail_imbalance");

    expect(observeExecutorSlots({
      slot_capacity: 3,
      live_slots: 0,
      observed_ms: 3_000,
      remaining_work: [remaining({ terminal: 4 })],
      stage_barrier: false,
    })?.idle_reason).toBe("no_ready_work");

    expect(observeExecutorSlots({
      slot_capacity: 3,
      live_slots: 3,
      observed_ms: 3_500,
      remaining_work: [remaining({ running: 3 })],
      stage_barrier: false,
    })).toBeNull();

    expect(() => observeExecutorSlotInterval({
      slot_capacity: 3,
      start: { observed_at_ms: 4_000, live_slots: 1 },
      end_observed_at_ms: 3_999,
      remaining_work: [],
      stage_barrier: false,
    })).toThrow("lifecycle interval");
  });
});
