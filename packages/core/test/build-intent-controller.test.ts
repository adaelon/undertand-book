import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  confirmBuildIntentSelection,
  draftBuildIntentSelection,
  projectCodexBuildIntentSelection,
  redactBuildIntentSelection,
  rejectBuildIntentSelection,
} from "../src/build-intent-controller";
import { BuildDecisionRequestV2Z } from "../src/build-intent";
import { projectLegacyBuildDecisionRequestV2 } from "../src/build-workbench";

const target = {
  book_id: "reader-book",
  source_fingerprint: "source-v1",
  content_profile: { id: "technical_learning" as const, version: "technical_learning_v0" as const },
  public_freshness: [],
};
const now = "2026-07-25T10:00:00.000Z";

describe("IP5 resident build-intent controller", () => {
  it("keeps read-now and standard-deep deterministic without a private intent", () => {
    expect(draftBuildIntentSelection({ mode: "read_now", target, now })).toEqual({
      version: "build_intent_selection.v1",
      mode: "read_now",
      intent: null,
      intent_digest: null,
      plan: null,
      estimate_input: null,
      decision_request: null,
    });
    const standard = draftBuildIntentSelection({ mode: "standard_deep", target, now });
    expect(standard.intent).toBeNull();
    expect(standard.plan).toMatchObject({ recipe_id: "standard_deep", status: "draft" });
    expect(standard.decision_request).toMatchObject({
      version: "build_decision_request.v2",
      scope: { kind: "build_plan", plan_id: standard.plan?.plan_id, plan_digest: standard.plan?.plan_digest },
      kind: "build_intent_plan",
      status: "pending",
    });
  });

  it("compiles only validated registry candidates and rejects custom or unknown capabilities", () => {
    const selection = draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: "Compare the two approaches for my private report",
      candidate: {
        version: "build_intent_planner_candidate.v1",
        goal_kind: "compare",
        source_scope: { whole_book: true, lids: [], sections: [] },
        desired_artifacts: ["comparison_table", "argument_map"],
        usage_horizon: "project",
      },
    });
    expect(selection.intent).toMatchObject({ privacy: "reader_private", desired_artifacts: ["comparison_table", "argument_map"] });
    expect(selection.plan).toMatchObject({ recipe_id: "goal_directed", create: expect.arrayContaining(["private.comparison_table", "private.argument_map"]) });
    for (const desired_artifacts of [["custom"], ["unknown"]]) {
      expect(() => draftBuildIntentSelection({
        mode: "goal_directed",
        target,
        now,
        user_goal: "private raw goal",
        candidate: {
          version: "build_intent_planner_candidate.v1",
          goal_kind: "other",
          source_scope: { whole_book: true, lids: [], sections: [] },
          desired_artifacts,
          usage_horizon: "one_off",
        },
      })).toThrow(/capability|artifact|registry/i);
    }
  });

  it("binds confirmation to the exact current digest and redacts raw goal from status metadata", () => {
    const rawGoal = "PRIVATE_RAW_GOAL_DO_NOT_LOG";
    const draft = draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: rawGoal,
      candidate: {
        version: "build_intent_planner_candidate.v1",
        goal_kind: "analyze",
        source_scope: { whole_book: true, lids: [], sections: [] },
        desired_artifacts: ["concept_map"],
        usage_horizon: "long_term",
      },
    });
    expect(() => confirmBuildIntentSelection(draft, {
      plan_id: draft.plan!.plan_id,
      plan_digest: "f".repeat(64),
      at: now,
      confirmation_source: "reader_ui",
    })).toThrow(/digest/i);
    const confirmed = confirmBuildIntentSelection(draft, {
      plan_id: draft.plan!.plan_id,
      plan_digest: draft.plan!.plan_digest,
      at: now,
      confirmation_source: "reader_ui",
    });
    expect(confirmed.intent?.status).toBe("confirmed");
    expect(confirmed.plan?.status).toBe("confirmed");
    expect(confirmed.decision_request?.status).toBe("answered");
    expect(JSON.stringify(redactBuildIntentSelection(confirmed))).not.toContain(rawGoal);
    expect(rejectBuildIntentSelection(draft).plan?.status).toBe("superseded");
  });

  it("projects an auditable Codex plan without the private raw goal", () => {
    const rawGoal = "PRIVATE_CODEX_GOAL_DO_NOT_RETURN";
    const draft = draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: rawGoal,
      candidate: {
        version: "build_intent_planner_candidate.v1",
        goal_kind: "compare",
        source_scope: { whole_book: false, lids: ["2.1"], sections: [] },
        desired_artifacts: ["comparison_table"],
        usage_horizon: "project",
      },
    });
    const projection = projectCodexBuildIntentSelection(draft);
    expect(projection).toMatchObject({
      version: "codex_build_intent_plan.v1",
      mode: "goal_directed",
      intent: {
        intent_id: draft.intent?.intent_id,
        intent_digest: draft.intent_digest,
        goal_kind: "compare",
        source_scope: { whole_book: false, lids: ["2.1"], sections: [] },
        desired_artifacts: ["comparison_table"],
      },
      plan: {
        plan_id: draft.plan?.plan_id,
        plan_digest: draft.plan?.plan_digest,
        create: draft.plan?.create,
        reuse: draft.plan?.reuse,
        estimate: draft.plan?.estimate,
        budget: draft.plan?.budget,
      },
      decision_request: draft.decision_request,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(rawGoal);
    expect(serialized).not.toContain("user_goal");

    const confirmed = confirmBuildIntentSelection(draft, {
      plan_id: draft.plan!.plan_id,
      plan_digest: draft.plan!.plan_digest,
      at: now,
      confirmation_source: "codex_conversation",
    });
    expect(confirmed.plan?.confirmation_source).toBe("codex_conversation");
  });

  it("projects V1 workbench decisions into stage-scoped V2 without changing V1", () => {
    const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "build-decision-request.v2.golden.json"), "utf8"));
    const legacy = {
      decision_id: "decision-stage-001",
      job_id: "job-001",
      stage: "source_reconciliation" as const,
      kind: "source_reconciliation_mode" as const,
      prompt: "Choose",
      options: [{ id: "review", label: "Review source" }],
      status: "pending" as const,
      created_at: now,
    };
    expect(projectLegacyBuildDecisionRequestV2(legacy)).toEqual(fixture.legacy_stage);
    expect(BuildDecisionRequestV2Z.parse(fixture.build_plan)).toEqual(fixture.build_plan);
    expect(legacy).toHaveProperty("stage", "source_reconciliation");
  });
});
