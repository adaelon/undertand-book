import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileBuildMode } from "../src/build-capability";
import {
  attachBuildPlanDigest,
  transitionBuildPlan,
  type BuildContentProfile,
  type BuildIntentV1,
  type BuildPlanV1,
} from "../src/build-intent";
import {
  inspectAutomaticBuildStageFreshness,
  nextPlannedAutomaticBuildAction,
  type AutomaticBuildSnapshot,
  type AutomaticBuildStage,
} from "../src/build-orchestrator";
import { evaluateAutomaticBuildPlanBudget } from "../src/automatic-build-budget";
import { automaticBuildNext } from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";

const NOW = "2026-07-25T09:00:00.000Z";

function profile(id: BuildContentProfile["id"]): BuildContentProfile {
  return id === "paper"
    ? { id: "paper", version: "paper_v0" }
    : { id: "technical_learning", version: "technical_learning_v0" };
}

function snapshot(
  profileId: BuildContentProfile["id"] = "technical_learning",
  stages: Array<{ stage: AutomaticBuildStage; closed: boolean }> = [
    { stage: "pass1", closed: false },
    { stage: "profile_sidecar", closed: false },
    { stage: "pass2", closed: false },
    { stage: "book_structure", closed: false },
  ],
): AutomaticBuildSnapshot {
  const bookId = "book-a";
  return {
    target: {
      kind: "source_file",
      profile_id: profileId,
      book_id: bookId,
      root_dir: "C:/library",
      workspace_dir: `C:/library/${bookId}`,
      source_path: `C:/library/${bookId}/source.txt`,
      target_ref: {
        version: "build_target_ref.v2",
        workspace_dir: `C:/library/${bookId}`,
        book_id: bookId,
        profile_id: profileId,
        input_fingerprint: "source-a",
      },
    },
    stages: stages.map((stage) => ({
      ...stage,
      pending_tasks: stage.closed ? [] : ["0"],
    })),
  };
}

function confirmedStandardPlan(
  current: AutomaticBuildSnapshot,
  options: {
    source_fingerprint?: string;
    content_profile?: BuildContentProfile;
    max_total_tokens?: number;
    pass2?: "enabled" | "disabled";
  } = {},
): BuildPlanV1 {
  const draft = compileBuildMode({
    mode: "standard_deep",
    book_id: current.target.book_id,
    source_fingerprint: options.source_fingerprint ?? current.target.target_ref.input_fingerprint,
    content_profile: options.content_profile ?? profile(current.target.profile_id),
    plan_id: "plan-standard",
    revision: 1,
    created_at: NOW,
    budget: {
      ...(options.max_total_tokens !== undefined ? { max_total_tokens: options.max_total_tokens } : {}),
      on_exceed: "needs_user",
    },
    ...(options.pass2 ? { pass2: options.pass2 } : {}),
    public_freshness: inspectAutomaticBuildStageFreshness(current),
  }).plan!;
  return transitionBuildPlan(draft, "confirmed", { at: NOW, confirmation_source: "reader_ui" });
}

function confirmedGoalPlan(current: AutomaticBuildSnapshot): BuildPlanV1 {
  const contentProfile = profile(current.target.profile_id);
  const intent: BuildIntentV1 = {
    version: "build_intent.v1",
    intent_id: "intent-goal",
    revision: 1,
    book_id: current.target.book_id,
    source_fingerprint: current.target.target_ref.input_fingerprint,
    content_profile: contentProfile,
    user_goal: "private timeline",
    goal_kind: "analyze",
    source_scope: { whole_book: true, lids: [], sections: [] },
    desired_artifacts: ["timeline"],
    usage_horizon: "one_off",
    privacy: "reader_private",
    status: "draft",
    created_at: NOW,
  };
  const draft = compileBuildMode({
    mode: "goal_directed",
    book_id: current.target.book_id,
    source_fingerprint: current.target.target_ref.input_fingerprint,
    content_profile: contentProfile,
    plan_id: "plan-goal",
    revision: 1,
    created_at: NOW,
    budget: { on_exceed: "needs_user" },
    public_freshness: inspectAutomaticBuildStageFreshness(current),
    intent,
  }).plan!;
  return transitionBuildPlan(draft, "confirmed", { at: NOW, confirmation_source: "reader_ui" });
}

describe("IP4 confirmed BuildPlan execution gate", () => {
  it("requires a confirmed exact plan before exposing model work", () => {
    const current = snapshot();
    expect(nextPlannedAutomaticBuildAction(current, undefined, 3)).toMatchObject({
      kind: "needs_user",
      reason: "build_plan_required",
    });

    const confirmed = confirmedStandardPlan(current);
    const draft = { ...confirmed, status: "draft", confirmed_at: undefined, confirmation_source: undefined } as BuildPlanV1;
    expect(nextPlannedAutomaticBuildAction(current, draft, 3)).toMatchObject({
      kind: "needs_user",
      reason: "build_plan_unconfirmed",
    });
    expect(nextPlannedAutomaticBuildAction(current, { ...confirmed, plan_digest: "0".repeat(64) }, 3)).toMatchObject({
      kind: "needs_user",
      reason: "build_plan_digest_drift",
    });
    expect(nextPlannedAutomaticBuildAction(current, confirmed, 3)).toMatchObject({
      kind: "extract",
      stage: "pass1",
    });
  });

  it("fails closed on source, profile, closure, or declared reuse drift", () => {
    const current = snapshot();
    expect(nextPlannedAutomaticBuildAction(
      current,
      confirmedStandardPlan(current, { source_fingerprint: "source-b" }),
      1,
    )).toMatchObject({ kind: "needs_user", reason: "build_plan_source_drift" });
    expect(nextPlannedAutomaticBuildAction(
      current,
      confirmedStandardPlan(current, { content_profile: profile("paper") }),
      1,
    )).toMatchObject({ kind: "needs_user", reason: "build_plan_profile_drift" });

    const valid = confirmedStandardPlan(current);
    const malformedDraft = attachBuildPlanDigest({
      ...valid,
      status: "draft",
      confirmed_at: undefined,
      confirmation_source: undefined,
      public_stage_closure: ["pass2"],
      reuse: [],
      create: ["public.pass2"],
    });
    const malformed = transitionBuildPlan(malformedDraft, "confirmed", {
      at: NOW,
      confirmation_source: "reader_ui",
    });
    expect(nextPlannedAutomaticBuildAction(current, malformed, 1)).toMatchObject({
      kind: "needs_user",
      reason: "build_plan_closure_drift",
    });

    const freshAtConfirmation = snapshot("technical_learning", [
      { stage: "pass1", closed: true },
      { stage: "profile_sidecar", closed: false },
      { stage: "pass2", closed: false },
      { stage: "book_structure", closed: false },
    ]);
    const reusePlan = confirmedStandardPlan(freshAtConfirmation);
    expect(nextPlannedAutomaticBuildAction(current, reusePlan, 1)).toMatchObject({
      kind: "needs_user",
      reason: "build_plan_freshness_drift",
    });
  });

  it("does not start public stages outside a goal-directed closure", () => {
    const current = snapshot();
    expect(nextPlannedAutomaticBuildAction(current, confirmedGoalPlan(current), 3)).toEqual({
      kind: "done",
      book_id: "book-a",
      workspace_dir: "C:/library/book-a",
    });
  });

  it("advances from profile sidecar directly to BookStructure when Pass2 is disabled", () => {
    const current = snapshot("technical_learning", [
      { stage: "pass1", closed: true },
      { stage: "profile_sidecar", closed: true },
      { stage: "pass2", closed: false },
      { stage: "book_structure", closed: false },
    ]);
    const plan = confirmedStandardPlan(current, { pass2: "disabled" });

    expect(plan.public_stage_closure).toEqual(["pass1", "profile_sidecar", "book_structure"]);
    expect(nextPlannedAutomaticBuildAction(current, plan, 3)).toMatchObject({
      kind: "extract",
      stage: "book_structure",
    });
  });

  it("combines observed usage with remaining forecast and pauses at the confirmed plan budget", () => {
    const plan = confirmedStandardPlan(snapshot(), { max_total_tokens: 100 });
    const evaluation = evaluateAutomaticBuildPlanBudget({
      plan,
      actual_usage: {
        known_usage_coverage: 1,
        exact_input_tokens: 30,
        exact_output_tokens: 20,
      },
      current_forecast: {
        estimated_total_tokens_upper: 60,
        wall_clock_p95_minutes: 5,
        preflight_evaluation_digest: "a".repeat(64),
      },
    });
    expect(evaluation).toMatchObject({
      version: "automatic_build_plan_budget_evaluation.v1",
      status: "exceeded",
      actual_total_tokens: 50,
      remaining_forecast_tokens_upper: 60,
      projected_total_tokens_upper: 110,
      violations: [{ code: "max_total_tokens", actual: 110, limit: 100 }],
    });
    expect(evaluation.receipt_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("returns build_plan_required before creating a task lease on disk", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-plan-gate-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA source paragraph.\n", "utf8");
    const result = automaticBuildNext(source, root, 1);
    expect(result.action).toMatchObject({ kind: "needs_user", reason: "build_plan_required" });
    expect(existsSync(path.join(root, ".understand-book", "guide", ".build", "automatic-build", "v2", "tasks"))).toBe(false);
  });

  it("projects a changed confirmed BuildPlan budget as bounded recovery before claim", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-plan-budget-change-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA source paragraph whose model work exceeds one token.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root, {
      budget: { max_total_tokens: 1, on_exceed: "needs_user" },
    });
    const result = automaticBuildNext(source, root, 1, { build_plan: buildPlan });

    expect(result.action).toMatchObject({
      kind: "needs_user",
      reason: "build_plan_budget_changed",
      stage: "pass1",
      recovery: {
        version: "automatic_build_recovery.v1",
        phase: "preflight",
        code: "build_plan_budget_changed",
        stage: "pass1",
        recovery_actions: ["reconfirm_build_plan"],
      },
    });
    expect(existsSync(path.join(
      root,
      ".understand-book",
      "guide",
      ".build",
      "automatic-build",
      "v2",
      "tasks",
    ))).toBe(false);
  });
});
