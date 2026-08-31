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
import { getSystemArtifactBlueprintV1 } from "../src/artifact-blueprint";
import { BuildDecisionRequestV2Z } from "../src/build-intent";
import { projectLegacyBuildDecisionRequestV2 } from "../src/build-workbench";

const target = {
  book_id: "reader-book",
  source_fingerprint: "source-v1",
  content_profile: { id: "technical_learning" as const, version: "technical_learning_v0" as const },
  public_freshness: [],
};
const now = "2026-07-25T10:00:00.000Z";

function candidate(artifacts: Array<"timeline" | "concept_map" | "comparison_table" | "argument_map">) {
  return {
    version: "build_intent_planner_candidate.v2" as const,
    goal_kind: "compare" as const,
    source_scope: { whole_book: true, lids: [] as string[], sections: [] as string[] },
    artifacts: artifacts.map((artifact) => ({
      source: "system" as const,
      blueprint_id: `system.${artifact}`,
      blueprint_version: "1.0.0",
    })),
    usage_horizon: "project" as const,
  };
}

function resolutions(artifacts: Array<"timeline" | "concept_map" | "comparison_table" | "argument_map">) {
  return artifacts.map((artifact) => {
    const preset = getSystemArtifactBlueprintV1(artifact);
    return {
      version: "artifact_blueprint_resolution.v2" as const,
      source: "system" as const,
      blueprint: preset.blueprint,
      blueprint_id: preset.blueprint.blueprint_id,
      blueprint_version: preset.blueprint.blueprint_version,
    };
  });
}

function ownerIdentity(suffix: string) {
  return {
    intent_id: `intent-${suffix}`,
    intent_revision: 1,
    plan_id: `plan-${suffix}`,
    plan_revision: 1,
  } as const;
}

describe("IP5 resident build-intent controller", () => {
  it("keeps read-now and standard-deep deterministic without a private intent", () => {
    expect(draftBuildIntentSelection({ mode: "read_now", target, now })).toEqual({
      version: "build_intent_selection.v3",
      mode: "read_now",
      intent: null,
      plan: null,
      estimate_input: null,
      decision_request: null,
    });
    const standard = draftBuildIntentSelection({
      mode: "standard_deep",
      target,
      now,
      plan_id: "plan-standard",
      plan_revision: 1,
    });
    expect(standard.intent).toBeNull();
    expect(standard.plan).toMatchObject({ recipe_id: "standard_deep", status: "draft" });
    expect(standard.decision_request).toMatchObject({
      version: "build_decision_request.v3",
      scope: {
        kind: "build_plan",
        plan_id: standard.plan?.plan_id,
        plan_revision: standard.plan?.plan_revision,
      },
      kind: "build_intent_plan",
      status: "pending",
    });
  });

  it("compiles zero or more validated Blueprint selections and rejects resolution drift", () => {
    const selected = ["comparison_table", "argument_map"] as const;
    const selection = draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: "Compare the two approaches for my private report",
      ...ownerIdentity("selected"),
      candidate: candidate([...selected]),
      resolved_blueprints: resolutions([...selected]),
    });
    expect(selection.intent).toMatchObject({ version: "build_intent.v3", privacy: "reader_private" });
    expect(selection.intent).not.toHaveProperty("desired_artifacts");
    expect(selection.plan).toMatchObject({
      version: "build_plan.v3",
      recipe_id: "goal_directed",
      private_artifacts: [
        {
          blueprint_id: "system.comparison_table",
          blueprint_version: "1.0.0",
          blueprint: { blueprint_id: "system.comparison_table" },
        },
        {
          blueprint_id: "system.argument_map",
          blueprint_version: "1.0.0",
          blueprint: { blueprint_id: "system.argument_map" },
        },
      ],
    });
    expect(draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: "No additional artifact is useful",
      ...ownerIdentity("zero"),
      candidate: candidate([]),
      resolved_blueprints: [],
    }).plan?.private_artifacts).toEqual([]);
    expect(() => draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: "private raw goal",
      ...ownerIdentity("drift"),
      candidate: candidate(["timeline"]),
      resolved_blueprints: resolutions(["concept_map"]),
    })).toThrow(/Blueprint|resolution|identity/i);
  });

  it("binds confirmation to the exact current plan revision and redacts raw goal from status metadata", () => {
    const rawGoal = "PRIVATE_RAW_GOAL_DO_NOT_LOG";
    const draft = draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: rawGoal,
      ...ownerIdentity("confirmation"),
      candidate: { ...candidate(["concept_map"]), goal_kind: "analyze", usage_horizon: "long_term" },
      resolved_blueprints: resolutions(["concept_map"]),
    });
    expect(() => confirmBuildIntentSelection(draft, {
      plan_id: draft.plan!.plan_id,
      plan_revision: draft.plan!.plan_revision + 1,
      at: now,
      confirmation_source: "reader_ui",
    })).toThrow(/revision/i);
    const confirmed = confirmBuildIntentSelection(draft, {
      plan_id: draft.plan!.plan_id,
      plan_revision: draft.plan!.plan_revision,
      at: now,
      confirmation_source: "reader_ui",
    });
    expect(confirmed.intent?.status).toBe("confirmed");
    expect(confirmed.plan?.status).toBe("confirmed");
    expect(confirmed.decision_request?.status).toBe("answered");
    expect(JSON.stringify(redactBuildIntentSelection(confirmed))).not.toContain(rawGoal);
    expect(rejectBuildIntentSelection(draft).plan?.status).toBe("superseded");
  });

  it("accepts a deterministically validated one-off Blueprint draft", () => {
    const oneOff = {
      ...getSystemArtifactBlueprintV1("timeline").blueprint,
      blueprint_id: "one-off.implementation_steps",
      origin: "one_off" as const,
      title: "Implementation steps",
      purpose: "Track evidence-backed implementation steps for this goal.",
    };
    const draft = draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: "Turn the book into an implementation sequence",
      ...ownerIdentity("one-off"),
      candidate: {
        version: "build_intent_planner_candidate.v2",
        goal_kind: "write",
        source_scope: { whole_book: true, lids: [], sections: [] },
        artifacts: [{
          source: "one_off",
          blueprint_id: oneOff.blueprint_id,
          blueprint_version: oneOff.blueprint_version,
          blueprint: oneOff,
        }],
        usage_horizon: "one_off",
      },
      resolved_blueprints: [{
        version: "artifact_blueprint_resolution.v2",
        source: "one_off",
        blueprint: oneOff,
        blueprint_id: oneOff.blueprint_id,
        blueprint_version: oneOff.blueprint_version,
      }],
    });
    expect(draft.plan?.private_artifacts[0]).toMatchObject({
      blueprint: { blueprint_id: "one-off.implementation_steps", origin: "one_off" },
    });
  });

  it("projects an auditable Codex plan without the private raw goal", () => {
    const rawGoal = "PRIVATE_CODEX_GOAL_DO_NOT_RETURN";
    const draft = draftBuildIntentSelection({
      mode: "goal_directed",
      target,
      now,
      user_goal: rawGoal,
      ...ownerIdentity("projection"),
      candidate: {
        ...candidate(["comparison_table"]),
        source_scope: { whole_book: false, lids: ["2.1"], sections: [] },
      },
      resolved_blueprints: resolutions(["comparison_table"]),
    });
    const projection = projectCodexBuildIntentSelection(draft);
    expect(projection).toMatchObject({
      version: "codex_build_intent_plan.v3",
      mode: "goal_directed",
      intent: {
        intent_id: draft.intent?.intent_id,
        intent_revision: draft.intent?.intent_revision,
        goal_kind: "compare",
        source_scope: { whole_book: false, lids: ["2.1"], sections: [] },
      },
      plan: {
        plan_id: draft.plan?.plan_id,
        plan_revision: draft.plan?.plan_revision,
        create: draft.plan?.create,
        reuse: draft.plan?.reuse,
        estimate: draft.plan?.estimate,
        budget: draft.plan?.budget,
        artifact_summaries: [{
          title: "Comparison table",
          purpose: expect.any(String),
          shape: "table",
          reuse_source: "system",
        }],
      },
      decision_request: draft.decision_request,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(rawGoal);
    expect(serialized).not.toContain("user_goal");

    const confirmed = confirmBuildIntentSelection(draft, {
      plan_id: draft.plan!.plan_id,
      plan_revision: draft.plan!.plan_revision,
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
