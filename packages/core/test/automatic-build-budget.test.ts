import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAutomaticBuildPreflight,
  selectAutomaticBuildCostBatch,
  type AutomaticBuildBudgetLimitsV1,
} from "../src/automatic-build-budget";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { buildWorkUnitCost, createWorkUnitDescriptor, type WorkUnitDescriptorV2 } from "../src/stage-work-unit";
import { automaticBuildNext, automaticBuildPlan } from "../../../skills/build/automatic-build";

const target = {
  version: "build_target_ref.v2" as const,
  workspace_dir: "C:/repo/.understand-book/guide",
  book_id: "guide",
  profile_id: "technical_learning" as const,
  input_fingerprint: "source-fingerprint",
};
const policy = automaticBuildExtractionPolicy("pass1", resolveContentProfile("technical_learning"), "full");

function unit(id: string, inputTokens: number, visibleLids: number, formulaLids: number, outputItems = visibleLids): WorkUnitDescriptorV2 {
  return createWorkUnitDescriptor({
    target,
    stage: "pass1",
    work_unit_id: id,
    kind: "pass1_window",
    input_hash: id.padEnd(64, "a").slice(0, 64),
    policy_fingerprint: policy,
    evidence_lids: Array.from({ length: visibleLids }, (_, index) => `${id}.${index + 1}`),
    cost: buildWorkUnitCost({
      estimated_input_tokens: inputTokens,
      visible_lids: visibleLids,
      formula_lids: formulaLids,
      expected_output_items: outputItems,
    }),
  });
}

const generousBudget: AutomaticBuildBudgetLimitsV1 = {
  version: "automatic_build_budget_limits.v1",
  max_tasks: 100,
  max_total_score: 1_000_000,
  max_estimated_total_tokens: 1_000_000,
  max_batch_score: 1_000_000,
  max_parallel_cost: 1_000_000,
};

describe("automatic build preflight budget and cost scheduler", () => {
  it("reports a stable cost/token distribution and keeps partial exact usage separate", () => {
    const units = [unit("tiny", 3, 1, 0), unit("outlier", 8_000, 80, 39, 80)];
    const input = {
      target_ref: target,
      stage: "pass1" as const,
      work_units: units,
      pending_ids: units.map((item) => item.work_unit_id),
      quality_profile: "full" as const,
      requested_workers: 3,
      budget: generousBudget,
    };
    const noHistory = buildAutomaticBuildPreflight(input);
    const partialHistory = buildAutomaticBuildPreflight({
      ...input,
      historical_metrics: {
        source: "automatic_build_stage_metrics.v1",
        known_usage_coverage: 0.5,
        exact_input_tokens: 120,
        exact_output_tokens: 30,
      },
    });

    expect(noHistory.plan_digest).toBe(partialHistory.plan_digest);
    expect(noHistory.cost.score).toMatchObject({ min: units[0].cost.score, max: units[1].cost.score });
    if (noHistory.cost.score.min === null) throw new Error("expected non-empty score distribution");
    expect(noHistory.cost.score.max).toBeGreaterThan(noHistory.cost.score.min * 100);
    expect(noHistory.token_estimate).toMatchObject({ method: "work_unit_descriptor_tokens.v1", input_tokens: 8_003 });
    expect(noHistory.token_estimate.total_upper).toBeGreaterThan(noHistory.token_estimate.total_lower);
    expect(noHistory).not.toHaveProperty("historical_usage");
    expect(partialHistory.historical_usage).toEqual({
      source: "automatic_build_stage_metrics.v1",
      known_usage_coverage: 0.5,
      exact_input_tokens: 120,
      exact_output_tokens: 30,
    });
    expect(partialHistory.worker_plan).toMatchObject({
      requested_workers: 3,
      available_agent_slots: 3,
      max_workers: 2,
      hard_worker_limit: 3,
      concurrency_release: "ap14_safe_concurrency.v1",
    });
    expect(partialHistory.policy_fingerprint).toEqual(policy);
  });

  it("treats exact budget boundaries as allowed and one-unit overflow as exceeded", () => {
    const units = [unit("a", 10, 2, 0), unit("b", 20, 3, 1)];
    const totalScore = units.reduce((sum, item) => sum + item.cost.score, 0);
    const base = {
      target_ref: target,
      stage: "pass1" as const,
      work_units: units,
      pending_ids: ["a", "b"],
      quality_profile: "full" as const,
      requested_workers: 1,
    };
    const exact = buildAutomaticBuildPreflight({
      ...base,
      budget: { ...generousBudget, max_tasks: 2, max_total_score: totalScore },
    });
    const exceeded = buildAutomaticBuildPreflight({
      ...base,
      budget: { ...generousBudget, max_tasks: 1, max_total_score: totalScore - 1 },
    });

    expect(exact.budget.status).toBe("within_budget");
    expect(exact.budget.violations).toEqual([]);
    expect(exceeded.budget.status).toBe("exceeded");
    expect(exceeded.budget.violations.map((item) => item.code)).toEqual(expect.arrayContaining(["max_tasks", "max_total_score"]));
  });

  it("selects a deterministic batch by cumulative cost rather than task count", () => {
    const units = [unit("outlier", 1_000, 80, 39), unit("small-b", 10, 1, 0), unit("small-a", 8, 1, 0)];
    const smallScore = units[1].cost.score + units[2].cost.score;
    const selected = selectAutomaticBuildCostBatch(units, { max_tasks: 3, max_total_score: smallScore });

    expect(selected.units.map((item) => item.work_unit_id)).toEqual(["small-a", "small-b"]);
    expect(selected.total_score).toBe(smallScore);
    expect(selected.deferred_ids).toContain("outlier");
  });

  it("does not claim before plan acceptance or after budget rejection", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-budget-gate-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact source paragraph for deterministic planning.\n", "utf8");

    const plan = automaticBuildPlan(source, root, {
      budget: generousBudget,
      requested_workers: 3,
      quality_profile: "full",
    });
    if (!plan.preflight) throw new Error("expected model-work preflight");
    const taskRoot = path.join(root, ".understand-book", "guide", ".build", "automatic-build", "v2", "tasks");
    expect(plan.preflight.budget.status).toBe("within_budget");
    expect(plan.preflight.worker_plan.max_workers).toBe(1);
    expect(existsSync(taskRoot)).toBe(false);

    const unaccepted = automaticBuildNext(source, root, 3, { budget: generousBudget, quality_profile: "full" });
    expect(unaccepted.action).toMatchObject({ kind: "needs_user", reason: "preflight_required" });
    expect(existsSync(taskRoot)).toBe(false);

    const rejectedPlan = automaticBuildPlan(source, root, {
      budget: { ...generousBudget, max_total_score: 0 },
      quality_profile: "full",
    });
    if (!rejectedPlan.preflight) throw new Error("expected rejected model-work preflight");
    const rejected = automaticBuildNext(source, root, 3, {
      budget: { ...generousBudget, max_total_score: 0 },
      accepted_plan_digest: rejectedPlan.preflight.plan_digest,
      quality_profile: "full",
    });
    expect(rejected.action).toMatchObject({ kind: "needs_user", reason: "budget_exceeded" });
    expect(existsSync(taskRoot)).toBe(false);

    const accepted = automaticBuildNext(source, root, 3, {
      budget: generousBudget,
      accepted_plan_digest: plan.preflight.plan_digest,
      owner: "budget-test",
      now: "2026-07-19T00:00:00.000Z",
      quality_profile: "full",
    });
    expect(accepted.action).toMatchObject({ kind: "extract", tasks: [{ lease: { owner: "budget-test" } }] });
    expect("tasks" in accepted.action && accepted.action.tasks).toHaveLength(1);
    expect(existsSync(taskRoot)).toBe(true);
    const acceptance = path.join(root, ".understand-book", "guide", ".build", "automatic-build", "v2", "preflight", "pass1", `${plan.preflight.plan_digest}.json`);
    expect(JSON.parse(readFileSync(acceptance, "utf8"))).toMatchObject({ plan_digest: plan.preflight.plan_digest, quality_profile: "full" });
  });
});
