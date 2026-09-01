import { inspectAutomaticBuildTaskActivity } from "./automatic-build-lease";
import type {
  AutomaticBuildSnapshot,
  AutomaticBuildStage,
} from "./build-orchestrator";
import type { WorkUnitKind } from "./stage-work-unit";

export interface AutomaticBuildRemainingWorkV1 {
  stage: AutomaticBuildStage;
  kind: WorkUnitKind;
  pending: number;
  reserved: number;
  running: number;
  terminal: number;
}

export type ExecutorSlotIdleReason =
  | "no_ready_work"
  | "root_refill_gap"
  | "stage_barrier"
  | "tail_imbalance";

export interface ExecutorSlotObservationV1 {
  live_slots: number;
  idle_slots: number;
  idle_reason: ExecutorSlotIdleReason;
  observed_ms: number;
}

export interface ExecutorSlotLifecycleSampleV1 {
  observed_at_ms: number;
  live_slots: number;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function observeAutomaticBuildRemainingWork(
  snapshot: AutomaticBuildSnapshot,
  options: { now?: string } = {},
): AutomaticBuildRemainingWorkV1[] {
  const aggregates = new Map<string, AutomaticBuildRemainingWorkV1>();
  for (const stage of snapshot.stages) {
    const workUnits = stage.work_units ?? [];
    const pendingIds = new Set(stage.pending_tasks);
    for (const workUnit of workUnits) {
      if (workUnit.stage !== stage.stage) {
        throw new Error("automatic build remaining-work descriptor stage changed");
      }
      const key = `${stage.stage}\u0000${workUnit.kind}`;
      const aggregate = aggregates.get(key) ?? {
        stage: stage.stage,
        kind: workUnit.kind,
        pending: 0,
        reserved: 0,
        running: 0,
        terminal: 0,
      };
      if (!pendingIds.has(workUnit.work_unit_id)) {
        aggregate.terminal += 1;
      } else {
        const binding = stage.task_bindings?.[workUnit.work_unit_id];
        const activity = inspectAutomaticBuildTaskActivity(
          snapshot.target,
          stage.stage,
          workUnit.work_unit_id,
          {
            ...(options.now ? { now: options.now } : {}),
            ...(binding ? { descriptor: workUnit, binding } : {}),
          },
        );
        aggregate[activity] += 1;
      }
      aggregates.set(key, aggregate);
    }
  }
  return [...aggregates.values()].sort((left, right) => (
    left.stage.localeCompare(right.stage) || left.kind.localeCompare(right.kind)
  ));
}

export function observeExecutorSlots(input: {
  slot_capacity: number;
  live_slots: number;
  observed_ms: number;
  remaining_work: readonly AutomaticBuildRemainingWorkV1[];
  stage_barrier: boolean;
}): ExecutorSlotObservationV1 | null {
  const capacity = nonNegativeInteger(input.slot_capacity, "executor slot capacity");
  const liveSlots = nonNegativeInteger(input.live_slots, "executor live slots");
  if (liveSlots > capacity) throw new Error("executor live slots exceed slot capacity");
  if (!Number.isFinite(input.observed_ms) || input.observed_ms < 0) {
    throw new Error("executor slot observed_ms must be non-negative");
  }
  let pending = 0;
  for (const aggregate of input.remaining_work) {
    pending += nonNegativeInteger(aggregate.pending, "remaining-work pending count");
    nonNegativeInteger(aggregate.reserved, "remaining-work reserved count");
    nonNegativeInteger(aggregate.running, "remaining-work running count");
    nonNegativeInteger(aggregate.terminal, "remaining-work terminal count");
  }
  const idleSlots = capacity - liveSlots;
  if (idleSlots === 0) return null;
  const idleReason: ExecutorSlotIdleReason = pending > 0
    ? "root_refill_gap"
    : input.stage_barrier
      ? "stage_barrier"
      : liveSlots > 0
        ? "tail_imbalance"
        : "no_ready_work";
  return {
    live_slots: liveSlots,
    idle_slots: idleSlots,
    idle_reason: idleReason,
    observed_ms: input.observed_ms,
  };
}

export function observeExecutorSlotInterval(input: {
  slot_capacity: number;
  start: ExecutorSlotLifecycleSampleV1;
  end_observed_at_ms: number;
  remaining_work: readonly AutomaticBuildRemainingWorkV1[];
  stage_barrier: boolean;
}): ExecutorSlotObservationV1 | null {
  if (!Number.isFinite(input.start.observed_at_ms) || input.start.observed_at_ms < 0
    || !Number.isFinite(input.end_observed_at_ms)
    || input.end_observed_at_ms < input.start.observed_at_ms) {
    throw new Error("executor slot lifecycle interval is invalid");
  }
  return observeExecutorSlots({
    slot_capacity: input.slot_capacity,
    live_slots: input.start.live_slots,
    observed_ms: input.end_observed_at_ms - input.start.observed_at_ms,
    remaining_work: input.remaining_work,
    stage_barrier: input.stage_barrier,
  });
}
