import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BuildDecisionRequestV2Z,
  attachBuildPlanDigest,
  buildIntentIdentity,
  buildPlanIdentity,
  canonicalBuildJson,
  computeBuildIntentDigest,
  computeBuildPlanDigest,
  transitionBuildIntent,
  transitionBuildPlan,
  validateBuildIntentV1,
  validateBuildPlanV1,
  validateBuildSourceScope,
  validatePathSafeBuildId,
  type BuildIntentV1,
  type BuildPlanV1,
} from "../src/build-intent";

interface GoldenFixture {
  intent: BuildIntentV1;
  intent_identity_json: string;
  intent_digest: string;
  plan: BuildPlanV1;
  plan_identity_json: string;
  plan_digest: string;
}

const golden = JSON.parse(readFileSync(new URL("./fixtures/build-intent.v1.golden.json", import.meta.url), "utf8")) as GoldenFixture;

function planInput(): Omit<BuildPlanV1, "plan_digest"> {
  const { plan_digest: _digest, ...input } = golden.plan;
  return input;
}

describe("IP1 BuildIntent and BuildPlan contracts", () => {
  it("uses recursively sorted canonical JSON and frozen cross-platform identity digests", () => {
    expect(canonicalBuildJson({ z: 1, a: { d: 4, b: 2 }, c: [2, { y: 1, x: 0 }] }))
      .toBe('{"a":{"b":2,"d":4},"c":[2,{"x":0,"y":1}],"z":1}');
    expect(canonicalBuildJson(buildIntentIdentity(golden.intent))).toBe(golden.intent_identity_json);
    expect(computeBuildIntentDigest(golden.intent)).toBe(golden.intent_digest);
    expect(canonicalBuildJson(buildPlanIdentity(golden.plan))).toBe(golden.plan_identity_json);
    expect(computeBuildPlanDigest(golden.plan)).toBe(golden.plan_digest);
    expect(validateBuildIntentV1(golden.intent)).toEqual(golden.intent);
    expect(validateBuildPlanV1(golden.plan)).toEqual(golden.plan);
  });

  it("keeps timestamps, estimates, confirmation source, and status outside identity", () => {
    const confirmedIntent = transitionBuildIntent(golden.intent, "confirmed", {
      at: "2026-07-25T01:00:00.000Z",
    });
    expect(computeBuildIntentDigest(confirmedIntent)).toBe(golden.intent_digest);

    const changedEstimate = {
      ...golden.plan,
      estimate: {
        ...golden.plan.estimate,
        input_tokens: { lower: 2000, upper: 4000, coverage: 0.4 },
      },
      created_at: "2026-07-26T00:00:00.000Z",
    };
    expect(computeBuildPlanDigest(changedEstimate)).toBe(golden.plan_digest);

    const confirmedPlan = transitionBuildPlan(golden.plan, "confirmed", {
      at: "2026-07-25T01:01:00.000Z",
      confirmation_source: "reader_ui",
    });
    expect(confirmedPlan.plan_digest).toBe(golden.plan_digest);
    expect(computeBuildPlanDigest(confirmedPlan)).toBe(golden.plan_digest);
  });

  it("changes plan identity for every confirmed boundary field", () => {
    const input = planInput();
    const baseline = computeBuildPlanDigest(input);
    const mutations: Array<Omit<BuildPlanV1, "plan_digest">> = [
      { ...input, source_fingerprint: "source-b" },
      { ...input, content_profile: { id: "technical_learning", version: "technical_learning_v0" } },
      { ...input, recipe_id: "standard_deep" },
      {
        ...input,
        private_artifacts: input.private_artifacts.map((artifact) => ({
          ...artifact,
          source_scope: { whole_book: false, lids: ["3.1"], sections: [] },
        })),
      },
      {
        ...input,
        private_artifacts: input.private_artifacts.map((artifact) => ({ ...artifact, artifact_type: "timeline" })),
      },
      { ...input, public_stage_closure: ["pass1"] },
      { ...input, budget: { ...input.budget, max_total_tokens: 120001 } },
    ];
    expect(mutations.map(computeBuildPlanDigest).every((digest) => digest !== baseline)).toBe(true);
  });

  it("validates LID scope, profile capability, recipes, unique artifacts, ids, and digest integrity", () => {
    expect(() => validateBuildSourceScope({ whole_book: false, lids: [], sections: [] }))
      .toThrow(/source scope/i);
    expect(() => validateBuildSourceScope({ whole_book: false, lids: ["1.1", "1.1"], sections: [] }))
      .toThrow(/duplicate/i);
    expect(() => validateBuildSourceScope({ whole_book: false, lids: ["../1"], sections: [] }))
      .toThrow(/LID/i);
    expect(() => validatePathSafeBuildId("../intent", "intent_id")).toThrow(/path-safe/i);
    expect(() => validatePathSafeBuildId("CON", "intent_id")).toThrow(/path-safe/i);

    expect(() => validateBuildIntentV1({
      ...golden.intent,
      content_profile: { id: "paper", version: "paper_v999" },
    })).toThrow(/profile/i);

    expect(() => attachBuildPlanDigest({ ...planInput(), recipe_id: "freeform" as "goal_directed" }))
      .toThrow(/recipe/i);
    expect(() => attachBuildPlanDigest({
      ...planInput(),
      private_artifacts: [planInput().private_artifacts[0], planInput().private_artifacts[0]],
    })).toThrow(/duplicate artifact_id/i);
    expect(() => validateBuildPlanV1({ ...golden.plan, plan_digest: "0".repeat(64) }))
      .toThrow(/plan_digest/i);
    expect(() => validateBuildPlanV1({ ...golden.plan, user_goal: "must remain private" } as BuildPlanV1))
      .toThrow();
  });

  it("fails closed on illegal intent and plan transitions", () => {
    const confirmedIntent = transitionBuildIntent(golden.intent, "confirmed", {
      at: "2026-07-25T01:00:00.000Z",
    });
    expect(confirmedIntent).toMatchObject({
      status: "confirmed",
      confirmed_at: "2026-07-25T01:00:00.000Z",
    });
    expect(() => transitionBuildIntent(confirmedIntent, "draft")).toThrow(/transition/i);

    const confirmedPlan = transitionBuildPlan(golden.plan, "confirmed", {
      at: "2026-07-25T01:01:00.000Z",
      confirmation_source: "reader_ui",
    });
    const completedPlan = transitionBuildPlan(confirmedPlan, "completed");
    expect(completedPlan.status).toBe("completed");
    expect(() => transitionBuildPlan(completedPlan, "draft")).toThrow(/transition/i);
  });

  it("separates stage and build-plan decision scopes", () => {
    expect(BuildDecisionRequestV2Z.parse({
      version: "build_decision_request.v2",
      decision_id: "decision-001",
      scope: { kind: "stage", stage: "source_reconciliation" },
      kind: "source_reconciliation_mode",
      options: [{ id: "review", label: "Review" }],
      status: "pending",
    }).scope.kind).toBe("stage");
    expect(BuildDecisionRequestV2Z.parse({
      version: "build_decision_request.v2",
      decision_id: "decision-002",
      scope: { kind: "build_plan", plan_id: "plan-001", plan_digest: golden.plan_digest },
      kind: "build_intent_plan",
      options: [{ id: "confirm", label: "Confirm" }],
      status: "pending",
    }).scope.kind).toBe("build_plan");
    expect(() => BuildDecisionRequestV2Z.parse({
      version: "build_decision_request.v2",
      decision_id: "decision-003",
      scope: { kind: "build_plan", plan_id: "../plan", plan_digest: golden.plan_digest },
      kind: "build_intent_plan",
      options: [{ id: "confirm", label: "Confirm" }],
      status: "pending",
    })).toThrow();
    expect(() => BuildDecisionRequestV2Z.parse({
      version: "build_decision_request.v2",
      decision_id: "decision-004",
      scope: { kind: "stage", stage: "pass1" },
      kind: "build_intent_plan",
      options: [{ id: "confirm", label: "Confirm" }],
      status: "pending",
    })).toThrow();
  });
});
