import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeArtifactBlueprintDigest, getSystemArtifactBlueprintV1 } from "../src/artifact-blueprint";
import { compileBuildModeV2 } from "../src/build-capability";
import {
  canonicalBuildJson,
  validateBuildPlanV1,
} from "../src/build-intent";
import {
  adaptBuildPlanV1PrivateArtifacts,
  attachBuildPlanDigestV2,
  computeBuildIntentDigestV2,
  computeBuildPlanDigestV2,
  validateBuildIntentV2,
  validateBuildPlanV2,
  type BuildIntentV2,
  type BuildPlanV2,
} from "../src/build-intent-v2";
import legacyGolden from "./fixtures/build-intent.v1.golden.json";
import v2Golden from "./fixtures/build-intent.v2.golden.json";

const NOW = "2026-07-29T11:00:00.000Z";

function intent(): BuildIntentV2 {
  return validateBuildIntentV2({
    version: "build_intent.v2",
    intent_id: "intent-v2",
    revision: 1,
    book_id: "book-v2",
    source_fingerprint: "source-v2",
    content_profile: { id: "technical_learning", version: "technical_learning_v0" },
    user_goal: "Prepare only the structures needed for implementation.",
    goal_kind: "write",
    source_scope: { whole_book: true, lids: [], sections: [] },
    usage_horizon: "project",
    privacy: "reader_private",
    status: "draft",
    created_at: NOW,
  });
}

function planInput(privateArtifacts: BuildPlanV2["private_artifacts"]): Omit<BuildPlanV2, "plan_digest"> {
  const currentIntent = intent();
  return {
    version: "build_plan.v2",
    plan_id: "plan-v2",
    revision: 1,
    book_id: currentIntent.book_id,
    source_fingerprint: currentIntent.source_fingerprint,
    content_profile: currentIntent.content_profile,
    recipe_id: "goal_directed",
    intent_id: currentIntent.intent_id,
    intent_digest: computeBuildIntentDigestV2(currentIntent),
    public_stage_closure: [],
    private_artifacts: privateArtifacts,
    reuse: [{ artifact: "public.foundation", freshness_digest: "a".repeat(64) }],
    create: privateArtifacts.map((artifact) => `private.${artifact.artifact_id}`),
    excluded: [],
    estimate: {
      input_tokens: { lower: 0, upper: 0, coverage: 0 },
      output_tokens: { lower: 0, upper: 0, coverage: 0 },
      wall_clock_minutes: { confidence: "none" },
      unknown_stages: privateArtifacts.map((artifact) => `private.${artifact.artifact_id}`),
      historical_match: { stage: false, policy: false, model: false, harness: false, sample_count: 0 },
    },
    budget: { max_total_tokens: 50_000, on_exceed: "needs_user" },
    status: "draft",
    created_at: NOW,
  };
}

describe("AA3 BuildIntentV2 and BuildPlanV2", () => {
  it("keeps the V2 intent, plan, Blueprint, and payload canonical digests frozen", () => {
    const currentIntent = validateBuildIntentV2(v2Golden.intent);
    const currentPlan = validateBuildPlanV2(v2Golden.plan);
    expect(computeBuildIntentDigestV2(currentIntent)).toBe(v2Golden.intent_digest);
    expect(computeBuildPlanDigestV2(currentPlan)).toBe(v2Golden.plan.plan_digest);
    expect(computeArtifactBlueprintDigest(currentPlan.private_artifacts[0].blueprint))
      .toBe(v2Golden.plan.private_artifacts[0].blueprint_digest);
    expect(createHash("sha256").update(canonicalBuildJson(v2Golden.payload), "utf8").digest("hex"))
      .toBe(v2Golden.payload_digest);
    expect(canonicalBuildJson(v2Golden.canonical_number_cases.values))
      .toBe(v2Golden.canonical_number_cases.json);
  });

  it("allows a goal-directed plan to choose zero blueprints without restoring the V1 enum", () => {
    const currentIntent = intent();
    expect(currentIntent).not.toHaveProperty("desired_artifacts");
    const plan = attachBuildPlanDigestV2(planInput([]));
    expect(validateBuildPlanV2(plan).private_artifacts).toEqual([]);
  });

  it("binds the complete immutable Blueprint snapshot and digest into plan identity", () => {
    const preset = getSystemArtifactBlueprintV1("comparison_table");
    const artifact = {
      artifact_id: "artifact-comparison",
      source_scope: intent().source_scope,
      blueprint: preset.blueprint,
      blueprint_digest: preset.digest,
      required_public_capabilities: ["foundation.lid"],
    };
    const plan = attachBuildPlanDigestV2(planInput([artifact]));
    expect(validateBuildPlanV2(plan)).toEqual(plan);

    const changedBlueprint = { ...preset.blueprint, title: "Changed after confirmation" };
    expect(() => validateBuildPlanV2({
      ...plan,
      private_artifacts: [{ ...artifact, blueprint: changedBlueprint }],
    })).toThrow(/blueprint_digest|digest/i);
    expect(computeBuildPlanDigestV2({
      ...planInput([{ ...artifact, blueprint: changedBlueprint, blueprint_digest: preset.digest }]),
    })).not.toBe(plan.plan_digest);
  });

  it("adapts a V1 plan through fixed system presets without changing its golden digest", () => {
    const legacy = validateBuildPlanV1(legacyGolden.plan);
    expect(legacy.plan_digest).toBe(legacyGolden.plan_digest);
    const adapted = adaptBuildPlanV1PrivateArtifacts(legacy);
    expect(adapted).toHaveLength(legacy.private_artifacts.length);
    expect(adapted[0]).toMatchObject({
      artifact_id: legacy.private_artifacts[0].artifact_id,
      blueprint: { blueprint_id: `system.${legacy.private_artifacts[0].artifact_type}` },
    });
  });

  it("compiles new drafts as V2 and preserves the public-stage closure rules", () => {
    const preset = getSystemArtifactBlueprintV1("argument_map");
    const currentIntent = intent();
    const compiled = compileBuildModeV2({
      mode: "goal_directed",
      book_id: currentIntent.book_id,
      source_fingerprint: currentIntent.source_fingerprint,
      content_profile: currentIntent.content_profile,
      plan_id: "plan-compiled-v2",
      revision: 1,
      created_at: NOW,
      budget: { on_exceed: "needs_user" },
      public_freshness: [],
      intent: currentIntent,
      selected_blueprints: [{
        version: "artifact_blueprint_resolution.v1",
        source: "system",
        blueprint: preset.blueprint,
        digest: preset.digest,
      }],
    });
    expect(compiled.plan).toMatchObject({
      version: "build_plan.v2",
      public_stage_closure: [],
      private_artifacts: [{
        blueprint: { blueprint_id: "system.argument_map" },
        blueprint_digest: preset.digest,
      }],
    });
  });
});
