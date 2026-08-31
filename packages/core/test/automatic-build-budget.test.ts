import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptiveAutomaticBuildRunTtlMs,
  automaticBuildPreflightEvaluationEvidence,
  buildAutomaticBuildPreflight,
  evaluateAutomaticBuildPlanBudget,
  listScheduleAutomaticBuildWallClock,
  migrateAutomaticBuildPlanBudgetEvaluationV1,
  selectAutomaticBuildCostBatch,
  type AutomaticBuildBudgetLimitsV1,
  type AutomaticBuildExecutorProvenanceV1,
  type AutomaticBuildWallBudgetV1,
} from "../src/automatic-build-budget";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { buildWorkUnitCost, createWorkUnitDescriptor, type WorkUnitDescriptorV2 } from "../src/stage-work-unit";
import { automaticBuildNext, automaticBuildPlan } from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";

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
  it("uses remaining work for execution gates while preserving lifetime and scheduled cost", () => {
    const units = Array.from({ length: 10 }, (_, index) => unit(`unit-${index}`, 100 + index, 1, 0));
    const remaining = units.at(-1)!;
    const result = buildAutomaticBuildPreflight({
      target_ref: target,
      stage: "pass1",
      work_units: units,
      pending_ids: [remaining.work_unit_id],
      quality_profile: "full",
      requested_workers: 3,
      available_agent_slots: 3,
      budget: {
        ...generousBudget,
        max_tasks: 2,
        max_total_score: remaining.cost.score,
        max_estimated_total_tokens: 1_000,
      },
    });

    expect(result.budget.status).toBe("within_budget");
    expect(result.cost_scope).toMatchObject({
      lifetime: { work_units: 10 },
      remaining: { work_units: 1, score: remaining.cost.score },
      scheduled: { work_units: 1, dispatches: 1, agent_starts: 1 },
    });
    expect(result.cost_scope.lifetime.score).toBeGreaterThan(result.cost_scope.remaining.score);
  });

  it("predicts wall clock from direct history fields without plan or evaluation digest wrappers", () => {
    const units = Array.from({ length: 8 }, (_, index) => unit(`history-${index}`, 100, 1, 0));
    const executor: AutomaticBuildExecutorProvenanceV1 = {
      model: "codex-luna-high",
      reasoning_effort: "high",
      harness_release: "codex-2026.07",
    };
    const wallBudget: AutomaticBuildWallBudgetV1 = {
      version: "automatic_build_wall_budget.v1",
      max_wall_clock_minutes: 120,
      max_agent_starts: 10,
      max_duplicate_lease_ratio: 0.05,
      on_exceed: "needs_user",
    };
    const samples = [600_000, 800_000, 1_000_000, 1_200_000].map((serviceMs, index) => ({
      sample_id: `sample-${index}`,
      stage: "pass1" as const,
      kind: "pass1_window" as const,
      router_version: policy.router_version,
      model: executor.model,
      reasoning_effort: executor.reasoning_effort,
      harness_release: executor.harness_release,
      service_ms: serviceMs,
    }));
    const input = {
      target_ref: target,
      stage: "pass1" as const,
      work_units: units,
      pending_ids: units.map((item) => item.work_unit_id),
      quality_profile: "full" as const,
      requested_workers: 2,
      available_agent_slots: 2,
      budget: generousBudget,
      wall_budget: wallBudget,
      executor_provenance: executor,
      historical_performance: {
        version: "automatic_build_performance_history.v1" as const,
        samples,
        lease_count: 10,
        semantic_attempt_count: 10,
      },
    };
    const first = buildAutomaticBuildPreflight(input);
    const changed = buildAutomaticBuildPreflight({
      ...input,
      historical_performance: {
        ...input.historical_performance,
        samples: input.historical_performance.samples.map((sample, index) => index === 3
          ? { ...sample, service_ms: 1_300_000 }
          : sample),
      },
    });

    expect(first.wall_clock).toMatchObject({
      confidence: {
        level: "matched",
        sample_count: 4,
        model_match: true,
        policy_match: true,
        harness_match: true,
      },
      duplicate_lease_ratio: 0,
      budget: { status: "within_budget", violations: [] },
    });
    expect(first.wall_clock.predicted.remaining.p50_ms).toBeGreaterThan(0);
    expect(first.wall_clock.predicted.remaining.p95_ms)
      .toBeGreaterThanOrEqual(first.wall_clock.predicted.remaining.p50_ms);
    expect(first.wall_clock.adaptive_run_ttl_ms_by_kind.pass1_window).toBe(1_800_000);
    expect(first.work_units).toEqual(changed.work_units);
    expect(first.target_ref).toEqual(changed.target_ref);
    expect(first.stage).toBe(changed.stage);
    expect(first.quality_profile).toBe(changed.quality_profile);
    expect(first.wall_clock.predicted).not.toEqual(changed.wall_clock.predicted);

    const present = [
      Object.hasOwn(first, "plan_digest") ? "plan_digest" : undefined,
      Object.hasOwn(first, "preflight_evaluation_digest") ? "preflight_evaluation_digest" : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: H1 binds authorization to plan_id+plan_revision; H2 persists and compares
    // the concrete forecast/history fields above instead of a preflight evaluation digest.
    expect(present).toEqual([]);
  });

  it("keeps plan-budget usage fields direct and rejects its plan/evaluation/receipt digest wrappers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-plan-budget-h0-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA direct budget evidence fixture.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const evaluation = evaluateAutomaticBuildPlanBudget({
      plan: buildPlan,
      actual_usage: {
        known_usage_coverage: 0.5,
        exact_input_tokens: 120,
        exact_output_tokens: 30,
      },
      current_forecast: {
        estimated_total_tokens_upper: 1_000,
        wall_clock_p95_minutes: 2,
      },
    });

    expect(buildPlan).toMatchObject({ plan_id: expect.any(String), revision: expect.any(Number) });
    expect(evaluation).toMatchObject({
      plan_id: buildPlan.plan_id,
      plan_revision: buildPlan.revision,
      known_usage_coverage: 0.5,
      actual_input_tokens: 120,
      actual_output_tokens: 30,
      remaining_forecast_tokens_upper: expect.any(Number),
    });
    const present = [
      Object.hasOwn(evaluation, "plan_digest") ? "plan_digest" : undefined,
      Object.hasOwn(evaluation, "preflight_evaluation_digest") ? "preflight_evaluation_digest" : undefined,
      Object.hasOwn(evaluation, "receipt_digest") ? "receipt_digest" : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: H1 uses plan_id+revision, and H2 directly compares the finite usage/forecast
    // fields above when claim/execution is retried; no plan-budget receipt wrapper remains.
    expect(present).toEqual([]);

    const migrated = migrateAutomaticBuildPlanBudgetEvaluationV1({
      ...evaluation,
      version: "automatic_build_plan_budget_evaluation.v1",
      preflight_evaluation_digest: "e".repeat(64),
      receipt_digest: "f".repeat(64),
    });
    expect(migrated).toEqual(evaluation);
  });

  it("fails closed on an unmatched agent-start budget and exposes deterministic scheduling goldsets", () => {
    expect(listScheduleAutomaticBuildWallClock([10, 9, 8, 7], 2)).toBe(17);
    expect(adaptiveAutomaticBuildRunTtlMs(5 * 60_000)).toBe(15 * 60_000);
    expect(adaptiveAutomaticBuildRunTtlMs(20 * 60_000)).toBe(30 * 60_000);
    expect(adaptiveAutomaticBuildRunTtlMs(50 * 60_000)).toBe(60 * 60_000);

    const units = Array.from({ length: 9 }, (_, index) => unit(`low-${index}`, 100, 1, 0));
    const result = buildAutomaticBuildPreflight({
      target_ref: target,
      stage: "pass1",
      work_units: units,
      pending_ids: units.map((item) => item.work_unit_id),
      quality_profile: "full",
      requested_workers: 3,
      available_agent_slots: 3,
      budget: generousBudget,
      wall_budget: {
        version: "automatic_build_wall_budget.v1",
        max_agent_starts: 1,
        on_exceed: "needs_user",
      },
    });
    expect(result.wall_clock).toMatchObject({
      confidence: { level: "low", sample_count: 0 },
      budget: {
        status: "low_confidence",
        violations: [{ code: "max_agent_starts", actual: 3, limit: 1 }],
      },
    });
  });

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

    expect(noHistory.work_units).toEqual(partialHistory.work_units);
    expect(noHistory.cost_scope).toEqual(partialHistory.cost_scope);
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

  it("binds plan-budget recovery to the BuildPlan id and revision", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-plan-budget-recovery-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA synthetic BuildPlan authority fixture.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root, {
      budget: { max_total_tokens: 0, on_exceed: "needs_user" },
    });

    const blocked = automaticBuildNext(source, root, 1, { build_plan: buildPlan });

    expect(blocked.action).toMatchObject({
      kind: "needs_user",
      reason: "build_plan_budget_changed",
      stage: "pass1",
      plan_id: buildPlan.plan_id,
      plan_revision: buildPlan.revision,
      plan_budget_evidence: {
        version: "automatic_build_plan_budget_evaluation.v2",
        plan_id: buildPlan.plan_id,
        plan_revision: buildPlan.revision,
        status: "exceeded",
      },
      recovery: { code: "build_plan_budget_changed" },
    });
    expect(blocked.action).not.toHaveProperty("plan_digest");
    expect(blocked).toMatchObject({
      plan_budget: {
        plan_id: buildPlan.plan_id,
        plan_revision: buildPlan.revision,
        status: "exceeded",
      },
    });
    expect(blocked.plan_budget).not.toHaveProperty("preflight_evaluation_digest");
    expect(blocked.plan_budget).not.toHaveProperty("receipt_digest");
  });

  it("does not claim before plan acceptance or after budget rejection", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-budget-gate-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact source paragraph for deterministic planning.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);

    const plan = automaticBuildPlan(source, root, {
      budget: generousBudget,
      requested_workers: 3,
      quality_profile: "full",
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected model-work preflight");
    const taskRoot = path.join(root, ".understand-book", "guide", ".build", "automatic-build", "v2", "tasks");
    expect(plan.preflight.budget.status).toBe("within_budget");
    expect(plan.preflight.build_plan).toEqual({
      plan_id: buildPlan.plan_id,
      plan_revision: buildPlan.revision,
    });
    expect(plan.preflight.build_plan).not.toHaveProperty("plan_digest");
    expect(plan.preflight.worker_plan.max_workers).toBe(1);
    expect(existsSync(taskRoot)).toBe(false);

    const unaccepted = automaticBuildNext(source, root, 3, {
      budget: generousBudget,
      quality_profile: "full",
      build_plan: buildPlan,
    });
    expect(unaccepted.action).toMatchObject({ kind: "needs_user", reason: "preflight_required" });
    expect(existsSync(taskRoot)).toBe(false);

    const rejectedPlan = automaticBuildPlan(source, root, {
      budget: { ...generousBudget, max_total_score: 0 },
      quality_profile: "full",
      build_plan: buildPlan,
    });
    if (!rejectedPlan.preflight) throw new Error("expected rejected model-work preflight");
    const rejected = automaticBuildNext(source, root, 3, {
      budget: { ...generousBudget, max_total_score: 0 },
      accepted_plan_digest: rejectedPlan.preflight.descriptor_plan_digest,
      quality_profile: "full",
      build_plan: buildPlan,
    });
    expect(rejected.action).toMatchObject({ kind: "needs_user", reason: "budget_exceeded" });
    expect(existsSync(taskRoot)).toBe(false);

    const accepted = automaticBuildNext(source, root, 3, {
      protocol: "automatic_build_protocol.v2",
      budget: generousBudget,
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      owner: "budget-test",
      now: "2026-07-19T00:00:00.000Z",
      quality_profile: "full",
      build_plan: buildPlan,
    });
    expect(accepted.action).toMatchObject({ kind: "extract", tasks: [{ lease: { owner: "budget-test" } }] });
    expect("tasks" in accepted.action && accepted.action.tasks).toHaveLength(1);
    expect(existsSync(taskRoot)).toBe(true);
    if (accepted.action.kind !== "extract" || !("plan_acceptance_path" in accepted.action)) {
      throw new Error("expected direct preflight acceptance evidence");
    }
    expect(JSON.parse(readFileSync(accepted.action.plan_acceptance_path, "utf8"))).toMatchObject({
      version: "automatic_build_plan_acceptance.v2",
      plan_evidence: {
        descriptor_plan_digest: plan.preflight.descriptor_plan_digest,
        quality_profile: "full",
      },
    });
  });

  it("returns low_confidence_wall_budget before claim when unmatched agent starts exceed the limit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-wall-budget-gate-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, [
      "# Guide",
      ...Array.from({ length: 320 }, (_, index) => `Paragraph ${index} carries semantic evidence for wall planning.`),
    ].join("\n\n"), "utf8");
    const wallBudget: AutomaticBuildWallBudgetV1 = {
      version: "automatic_build_wall_budget.v1",
      max_agent_starts: 0,
      on_exceed: "needs_user",
    };
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      budget: generousBudget,
      wall_budget: wallBudget,
      requested_workers: 3,
      available_agent_slots: 3,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected wall-budget preflight");
    const next = automaticBuildNext(source, root, 3, {
      budget: generousBudget,
      wall_budget: wallBudget,
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      accepted_evaluation_evidence: automaticBuildPreflightEvaluationEvidence(plan.preflight),
      available_agent_slots: 3,
      build_plan: buildPlan,
    });
    expect(next.action).toMatchObject({
      kind: "needs_user",
      reason: "low_confidence_wall_budget",
      descriptor_plan_digest: plan.preflight.descriptor_plan_digest,
      evaluation_evidence: automaticBuildPreflightEvaluationEvidence(plan.preflight),
    });
    const taskRoot = path.join(root, ".understand-book", "guide", ".build", "automatic-build", "v2", "tasks");
    expect(existsSync(taskRoot)).toBe(false);
  });

  it("requires current direct evaluation evidence and forwards a matched adaptive run TTL", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-adaptive-ttl-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA semantic paragraph for adaptive lease history.\n", "utf8");
    const workspace = path.join(root, ".understand-book", "guide");
    const summaryPath = path.join(workspace, ".build", "automatic-build", "v2", "metrics", "pass1.json");
    mkdirSync(path.dirname(summaryPath), { recursive: true });
    const executor: AutomaticBuildExecutorProvenanceV1 = {
      model: "codex-luna-high",
      reasoning_effort: "high",
      harness_release: "codex-2026.07",
    };
    writeFileSync(summaryPath, JSON.stringify({
      version: "automatic_build_stage_metrics_summary.v1",
      usage: { known_usage_coverage: 0, input_tokens: 0, output_tokens: 0 },
      performance_history: {
        version: "automatic_build_performance_history.v1",
        samples: [{
          sample_id: "pass1-history",
          stage: "pass1",
          kind: "pass1_window",
          router_version: policy.router_version,
          ...executor,
          service_ms: 600_000,
        }],
        lease_count: 1,
        semantic_attempt_count: 1,
      },
    }), "utf8");
    const wallBudget: AutomaticBuildWallBudgetV1 = {
      version: "automatic_build_wall_budget.v1",
      max_wall_clock_minutes: 60,
      max_agent_starts: 10,
      on_exceed: "needs_user",
    };
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      budget: generousBudget,
      wall_budget: wallBudget,
      executor_provenance: executor,
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected adaptive preflight");
    expect(plan.preflight.wall_clock.adaptive_run_ttl_ms_by_kind.pass1_window).toBe(900_000);
    const staleEvaluation = automaticBuildPreflightEvaluationEvidence(plan.preflight);
    staleEvaluation.wall_clock = {
      ...staleEvaluation.wall_clock,
      predicted: {
        ...staleEvaluation.wall_clock.predicted,
        remaining: {
          ...staleEvaluation.wall_clock.predicted.remaining,
          p95_ms: staleEvaluation.wall_clock.predicted.remaining.p95_ms + 1,
        },
      },
    };
    const changed = automaticBuildNext(source, root, 1, {
      budget: generousBudget,
      wall_budget: wallBudget,
      executor_provenance: executor,
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      accepted_evaluation_evidence: staleEvaluation,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    expect(changed.action).toMatchObject({ kind: "needs_user", reason: "evaluation_changed" });
    const taskRoot = path.join(workspace, ".build", "automatic-build", "v2", "tasks");
    expect(existsSync(taskRoot)).toBe(false);

    const accepted = automaticBuildNext(source, root, 1, {
      protocol: "automatic_build_protocol.v2",
      budget: generousBudget,
      wall_budget: wallBudget,
      executor_provenance: executor,
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
      accepted_evaluation_evidence: automaticBuildPreflightEvaluationEvidence(plan.preflight),
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (accepted.action.kind !== "extract" || !accepted.action.tasks) throw new Error("expected adaptive extract");
    const task = accepted.action.tasks[0];
    if (!("input_command" in task)) throw new Error("expected leased input command");
    expect(task.input_command).toContain("900000");
    expect("evaluation_acceptance_path" in accepted.action && accepted.action.evaluation_acceptance_path)
      .toContain("evaluations");
  });
});
