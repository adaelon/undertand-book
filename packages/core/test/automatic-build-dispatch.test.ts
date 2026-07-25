import { describe, expect, it } from "vitest";
import {
  planAutomaticBuildExecutorDispatches,
  type AutomaticBuildExecutorDispatchPlanV1,
} from "../src/automatic-build-dispatch";
import { buildAutomaticBuildPreflight, type AutomaticBuildBudgetLimitsV1 } from "../src/automatic-build-budget";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import {
  buildWorkUnitCost,
  createWorkUnitDescriptor,
  workUnitPlanDigest,
  type WorkUnitDescriptorV2,
  type WorkUnitKind,
} from "../src/stage-work-unit";

const target = {
  version: "build_target_ref.v2" as const,
  workspace_dir: "C:/repo/.understand-book/quantification-essence",
  book_id: "quantification-essence",
  profile_id: "technical_learning" as const,
  input_fingerprint: "source-fingerprint",
};
const policy = automaticBuildExtractionPolicy(
  "profile_sidecar",
  resolveContentProfile("technical_learning"),
  "full",
);
const budget: AutomaticBuildBudgetLimitsV1 = {
  version: "automatic_build_budget_limits.v1",
  max_tasks: 1_000,
  max_total_score: 100_000_000,
  max_estimated_total_tokens: 100_000_000,
  max_batch_score: 10_000_000,
  max_parallel_cost: 10_000_000,
};

function unit(id: string, kind: WorkUnitKind, estimatedInputTokens: number): WorkUnitDescriptorV2 {
  return createWorkUnitDescriptor({
    target,
    stage: "profile_sidecar",
    work_unit_id: id,
    kind,
    input_hash: id.padEnd(64, "a").slice(0, 64),
    policy_fingerprint: policy,
    evidence_lids: [`lid-${id}`],
    cost: buildWorkUnitCost({
      estimated_input_tokens: estimatedInputTokens,
      visible_lids: 1,
      formula_lids: kind === "profile_sidecar_formula" ? 1 : 0,
      expected_output_items: 1,
    }),
  });
}

function quantificationPending(): WorkUnitDescriptorV2[] {
  return [
    ...Array.from({ length: 114 }, (_, index) => unit(
      `discourse-${String(index).padStart(3, "0")}`,
      "profile_sidecar_discourse",
      817,
    )),
    ...Array.from({ length: 284 }, (_, index) => unit(
      `formula-${String(index).padStart(3, "0")}`,
      "profile_sidecar_formula",
      181,
    )),
  ];
}

function expectDispatchLimits(plan: AutomaticBuildExecutorDispatchPlanV1): void {
  for (const dispatch of plan.dispatches) {
    expect(new Set(dispatch.ordered_work_unit_ids).size).toBe(dispatch.ordered_work_unit_ids.length);
    expect(dispatch.ordered_work_unit_ids.length).toBeLessThanOrEqual(dispatch.limits.max_units);
    expect(dispatch.accounting.estimated_input_tokens).toBeLessThanOrEqual(dispatch.limits.max_input_tokens);
    expect(dispatch.accounting.predicted_service_ms).toBeLessThanOrEqual(dispatch.limits.max_predicted_service_ms);
    expect(dispatch.target_ref).toEqual(target);
    expect(dispatch.stage).toBe("profile_sidecar");
    expect(dispatch.policy_fingerprint).toEqual(policy);
    expect(dispatch.ordered_work_unit_ids.every((id) => id.startsWith(
      dispatch.kind === "profile_sidecar_formula" ? "formula-" : "discourse-",
    ))).toBe(true);
  }
}

describe("automatic build executor dispatch planner", () => {
  it("accounts for all 398 pending sidecar units exactly once in at most 100 bounded dispatches", () => {
    const units = quantificationPending();
    const before = JSON.stringify(units);
    const plan = planAutomaticBuildExecutorDispatches({
      target_ref: target,
      stage: "profile_sidecar",
      work_units: units,
      pending_ids: units.map((item) => item.work_unit_id),
      available_agent_slots: 3,
    });

    expect(plan.dispatches.length).toBeLessThanOrEqual(100);
    expect(plan.dispatches).toHaveLength(65);
    expect(plan.accounting).toMatchObject({
      pending_units: 398,
      dispatched_units: 398,
      dispatches: 65,
      by_kind: {
        profile_sidecar_formula: { units: 284, dispatches: 36 },
        profile_sidecar_discourse: { units: 114, dispatches: 29 },
      },
    });
    const ids = plan.dispatches.flatMap((dispatch) => dispatch.ordered_work_unit_ids);
    expect(ids).toHaveLength(398);
    expect(new Set(ids).size).toBe(398);
    expect(ids).toEqual(units.map((item) => item.work_unit_id));
    expectDispatchLimits(plan);
    expect(JSON.stringify(units)).toBe(before);
    expect(workUnitPlanDigest(units)).toBe(plan.descriptor_plan_digest);
  });

  it("keeps full plan identity stable while available slots only change this round selection", () => {
    const units = quantificationPending();
    const input = {
      target_ref: target,
      stage: "profile_sidecar" as const,
      work_units: units,
      pending_ids: units.map((item) => item.work_unit_id),
    };
    const one = planAutomaticBuildExecutorDispatches({ ...input, available_agent_slots: 1 });
    const three = planAutomaticBuildExecutorDispatches({ ...input, available_agent_slots: 3 });
    const repeated = planAutomaticBuildExecutorDispatches({ ...input, available_agent_slots: 3 });

    expect(one.dispatch_plan_digest).toBe(three.dispatch_plan_digest);
    expect(three.dispatch_plan_digest).toBe(repeated.dispatch_plan_digest);
    expect(one.dispatches).toEqual(three.dispatches);
    expect(three.dispatches).toEqual(repeated.dispatches);
    expect(one.selected_dispatch_ids).toHaveLength(1);
    expect(three.selected_dispatch_ids).toHaveLength(3);
    expect(one.selected_dispatch_ids[0]).toBe(three.selected_dispatch_ids[0]);

    const preflightOne = buildAutomaticBuildPreflight({
      ...input,
      quality_profile: "full",
      requested_workers: 3,
      available_agent_slots: 1,
      budget,
    });
    const preflightThree = buildAutomaticBuildPreflight({
      ...input,
      quality_profile: "full",
      requested_workers: 3,
      available_agent_slots: 3,
      budget,
    });
    expect(preflightOne.plan_digest).toBe(preflightThree.plan_digest);
    expect(preflightOne.dispatch_plan.dispatch_plan_digest).toBe(preflightThree.dispatch_plan.dispatch_plan_digest);
    expect(preflightOne.dispatch_plan.selected_dispatch_ids).toHaveLength(1);
    expect(preflightThree.dispatch_plan.selected_dispatch_ids).toHaveLength(3);

    const afterOneCommitted = buildAutomaticBuildPreflight({
      ...input,
      pending_ids: input.pending_ids.slice(1),
      quality_profile: "full",
      requested_workers: 3,
      available_agent_slots: 3,
      budget,
    });
    expect(afterOneCommitted.plan_digest).toBe(preflightThree.plan_digest);
    expect(afterOneCommitted.dispatch_plan.dispatch_plan_digest)
      .not.toBe(preflightThree.dispatch_plan.dispatch_plan_digest);
  });

  it("rejects mixed target identity and a unit that cannot fit its kind limits", () => {
    const valid = unit("formula-valid", "profile_sidecar_formula", 181);
    const wrongTarget = { ...unit("formula-wrong-target", "profile_sidecar_formula", 181), target: {
      ...target,
      input_fingerprint: "other-source",
    } };
    expect(() => planAutomaticBuildExecutorDispatches({
      target_ref: target,
      stage: "profile_sidecar",
      work_units: [valid, wrongTarget],
      pending_ids: [valid.work_unit_id, wrongTarget.work_unit_id],
    })).toThrow("target");

    const oversized = unit("formula-oversized", "profile_sidecar_formula", 4_001);
    expect(() => planAutomaticBuildExecutorDispatches({
      target_ref: target,
      stage: "profile_sidecar",
      work_units: [oversized],
      pending_ids: [oversized.work_unit_id],
    })).toThrow("dispatch limits");
  });
});
