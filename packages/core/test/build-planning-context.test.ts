import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPlanningContextV1,
  createCodexBuildIntentErrorResultV2,
  issueBuildPlanningContextV2,
  reconcileBuildPlanningContextV2,
  validateBuildPlanningContextV1,
  validateBuildPlanningContextV2,
  validateCodexBuildIntentCommandV2,
  validateCodexBuildIntentCommandV3,
  validateCodexBuildIntentResultV2,
} from "../src/build-planning-context";

const fixture = JSON.parse(readFileSync(
  path.join(__dirname, "fixtures", "build-planning-context.v1.golden.json"),
  "utf8",
));

describe("CB1 BuildPlanningContext and Codex v2 controller contract", () => {
  it("matches the cross-language golden and ignores Registry input order", () => {
    const context = buildPlanningContextV1(fixture.input);
    expect(context).toEqual(fixture.context);
    expect(buildPlanningContextV1({
      ...fixture.input,
      blueprint_registry: [...fixture.input.blueprint_registry].reverse(),
    })).toEqual(fixture.context);
    expect(validateBuildPlanningContextV1(context)).toEqual(context);
  });

  it("samples large catalogs deterministically and fails closed on unknown or invalid fields", () => {
    const context = buildPlanningContextV1({
      ...fixture.input,
      available_lids: Array.from({ length: 1_981 }, (_, index) => `${index + 1}.1`),
    });
    expect(context.scope_catalog.available_lids).toHaveLength(128);
    expect(context.scope_catalog.available_lids).toEqual(buildPlanningContextV1({
      ...fixture.input,
      available_lids: Array.from({ length: 1_981 }, (_, index) => `${index + 1}.1`),
    }).scope_catalog.available_lids);
    expect(context.scope_catalog).toMatchObject({ available_lid_count: 1_981, truncated: true });
    expect(() => validateBuildPlanningContextV1({ ...fixture.context, unexpected: true })).toThrow();
    expect(() => validateBuildPlanningContextV1({ ...fixture.context, context_digest: "f".repeat(64) })).toThrow(/digest/i);
  });

  it("validates strict v2 commands without changing the existing v1 envelope", () => {
    expect(validateCodexBuildIntentCommandV2(fixture.commands.planning_context)).toEqual(fixture.commands.planning_context);
    expect(validateCodexBuildIntentCommandV2(fixture.commands.draft_candidate)).toEqual(fixture.commands.draft_candidate);
    expect(() => validateCodexBuildIntentCommandV2({
      ...fixture.commands.planning_context,
      input: { user_goal: "must not enter inspect" },
    })).toThrow();
  });

  it("issues owner-controlled context revisions and validates digest-free Codex v3 commands", () => {
    const planning = {
      ...fixture.input,
      blueprint_registry: fixture.input.blueprint_registry.map(
        ({ digest: _digest, ...entry }: { digest: string } & Record<string, unknown>) => entry,
      ),
    };
    const first = issueBuildPlanningContextV2({
      context_id: "context-paper-a",
      planning,
    });
    expect(validateBuildPlanningContextV2(first)).toEqual(first);
    expect(first).toMatchObject({
      version: "build_planning_context.v2",
      context_id: "context-paper-a",
      context_revision: 1,
    });
    expect(first).not.toHaveProperty("context_digest");
    expect(issueBuildPlanningContextV2({
      context_id: "context-paper-a",
      planning,
      previous: first,
    })).toEqual(first);

    const second = issueBuildPlanningContextV2({
      context_id: "context-paper-a",
      planning: { ...planning, available_lids: [...planning.available_lids, "9.9"] },
      previous: first,
    });
    expect(second.context_revision).toBe(2);
    expect(reconcileBuildPlanningContextV2(first, second)).toEqual(second);

    expect(validateCodexBuildIntentCommandV3({
      version: "codex_build_intent_command.v3",
      operation: "draft.candidate",
      target: { workspace_dir: "C:\\books\\paper-a" },
      input: {
        user_goal: "Compare the two methods",
        context_id: first.context_id,
        context_revision: first.context_revision,
        candidate: {
          version: "build_intent_planner_candidate.v2",
          goal_kind: "compare",
          source_scope: { whole_book: true, lids: [], sections: [] },
          artifacts: [],
          usage_horizon: "project",
        },
      },
    })).toMatchObject({
      version: "codex_build_intent_command.v3",
      input: { context_id: "context-paper-a", context_revision: 1 },
    });
    expect(validateCodexBuildIntentCommandV3({
      version: "codex_build_intent_command.v3",
      operation: "confirm",
      target: { workspace_dir: "C:\\books\\paper-a" },
      input: { plan_id: "plan-paper-a", plan_revision: 3 },
    })).toMatchObject({ input: { plan_id: "plan-paper-a", plan_revision: 3 } });
  });

  it("returns one bounded redacted error envelope", () => {
    const goal = "PRIVATE_GOAL_SENTINEL";
    const result = createCodexBuildIntentErrorResultV2({
      error_code: "BUILD_INTENT_CANDIDATE_INVALID",
      category: "validation",
      phase: "candidate",
      retryable: false,
      message: `candidate for ${goal}\nwas rejected`,
      sensitive_values: [goal],
    });
    expect(validateCodexBuildIntentResultV2(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(goal);
    expect(result).toMatchObject({ status: "error", error: { phase: "candidate", retryable: false } });
  });
});
