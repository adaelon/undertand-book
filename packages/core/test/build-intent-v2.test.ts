import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSameArtifactBlueprintVersionV2,
  computeArtifactBlueprintDigest,
  getSystemArtifactBlueprintV1,
} from "../src/artifact-blueprint";
import { compileBuildModeV2, compileBuildModeV3 } from "../src/build-capability";
import {
  canonicalBuildJson,
  validateBuildPlanV1,
} from "../src/build-intent";
import {
  adaptBuildPlanV1PrivateArtifacts,
  attachBuildPlanDigestV2,
  computeBuildIntentDigestV2,
  computeBuildPlanDigestV2,
  migrateBuildIntentV2ToV3,
  migratePlanningControlV2ToV3,
  reconcileBuildIntentV3,
  reconcileBuildPlanV3,
  validateBuildIntentV2,
  validateBuildPlanV2,
  type BuildIntentV2,
  type BuildPlanV2,
} from "../src/build-intent-v2";
import {
  buildPlanningContextV1,
  issueBuildPlanningContextV2,
  reconcileBuildPlanningContextV2,
} from "../src/build-planning-context";
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
  it("H0 uses explicit context, intent, plan, and Blueprint generations instead of control-object digests", () => {
    const context = issueBuildPlanningContextV2({
      context_id: "context-book-v2",
      planning: {
        target: {
          book_id: "book-v2",
          source_fingerprint: "a".repeat(64),
          content_profile: "technical_learning",
        },
        available_lids: ["1.1"],
        available_sections: ["Introduction"],
        blueprint_registry: [],
      },
    });
    const currentIntent = migrateBuildIntentV2ToV3(intent());
    const preset = getSystemArtifactBlueprintV1("comparison_table");
    const currentPlan = compileBuildModeV3({
      mode: "goal_directed",
      book_id: currentIntent.book_id,
      source_fingerprint: currentIntent.source_fingerprint,
      content_profile: currentIntent.content_profile,
      plan_id: "plan-v3",
      plan_revision: 1,
      created_at: NOW,
      budget: { max_total_tokens: 50_000, on_exceed: "needs_user" },
      public_freshness: [],
      intent: currentIntent,
      selected_blueprints: [{
        version: "artifact_blueprint_resolution.v2",
        source: "system",
        blueprint: preset.blueprint,
        blueprint_id: preset.blueprint.blueprint_id,
        blueprint_version: preset.blueprint.blueprint_version,
      }],
    }).plan!;

    expect(context).toMatchObject({ context_id: "context-book-v2", context_revision: 1 });
    expect(currentIntent).toMatchObject({ intent_id: "intent-v2", intent_revision: 1 });
    expect(currentPlan).toMatchObject({ plan_id: "plan-v3", plan_revision: 1 });
    expect(currentPlan.private_artifacts[0].blueprint).toMatchObject({
      blueprint_id: preset.blueprint.blueprint_id,
      blueprint_version: preset.blueprint.blueprint_version,
    });
    expect(context.target).toMatchObject({ book_id: "book-v2" });

    const present = [
      Object.hasOwn(context, "context_digest") ? "context_digest" : undefined,
      Object.hasOwn(currentIntent, "intent_digest") ? "intent_digest" : undefined,
      Object.hasOwn(currentPlan, "intent_digest") ? "intent_digest" : undefined,
      Object.hasOwn(currentPlan, "plan_digest") ? "plan_digest" : undefined,
      Object.hasOwn(currentPlan.private_artifacts[0], "blueprint_digest") ? "blueprint_digest" : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: H1 replaces these fields with context_id/context_revision,
    // intent_id/revision, plan_id/plan_revision, and blueprint_id/blueprint_version.
    expect(present).toEqual([]);
  });

  it("rejects divergent control bodies at the same owner revision or Blueprint version", () => {
    const currentIntent = migrateBuildIntentV2ToV3(intent());
    expect(() => reconcileBuildIntentV3(currentIntent, {
      ...currentIntent,
      user_goal: "Different body at the same intent revision",
    })).toThrow(/same revision/i);

    const currentPlan = compileBuildModeV3({
      mode: "goal_directed",
      book_id: currentIntent.book_id,
      source_fingerprint: currentIntent.source_fingerprint,
      content_profile: currentIntent.content_profile,
      plan_id: "plan-revision-contract",
      plan_revision: 1,
      created_at: NOW,
      budget: { on_exceed: "needs_user" },
      public_freshness: [],
      intent: currentIntent,
      selected_blueprints: [],
    }).plan!;
    expect(() => reconcileBuildPlanV3(currentPlan, {
      ...currentPlan,
      budget: { max_total_tokens: 1, on_exceed: "needs_user" },
    })).toThrow(/same revision/i);

    const context = issueBuildPlanningContextV2({
      context_id: "context-revision-contract",
      planning: {
        target: {
          book_id: "book-v2",
          source_fingerprint: "a".repeat(64),
          content_profile: "technical_learning",
        },
        available_lids: ["1.1"],
        available_sections: [],
        blueprint_registry: [],
      },
    });
    expect(() => reconcileBuildPlanningContextV2(context, {
      ...context,
      target: { ...context.target, source_fingerprint: "b".repeat(64) },
    })).toThrow(/same revision/i);

    const blueprint = getSystemArtifactBlueprintV1("timeline").blueprint;
    expect(() => assertSameArtifactBlueprintVersionV2(blueprint, {
      ...blueprint,
      title: "Different schema body at the same version",
    })).toThrow(/same id and version|different schema/i);
  });

  it("migrates a fully validated V2 fixture to V3 with business fields and authorization unchanged", () => {
    const migrated = migratePlanningControlV2ToV3({
      intent: v2Golden.intent,
      plan: v2Golden.plan,
    });
    expect(migrated).toMatchObject({
      version: "planning_control_migration.v2_to_v3",
      intent: {
        version: "build_intent.v3",
        intent_id: v2Golden.intent.intent_id,
        intent_revision: v2Golden.intent.revision,
        user_goal: v2Golden.intent.user_goal,
        status: v2Golden.intent.status,
        confirmed_at: v2Golden.intent.confirmed_at,
      },
      plan: {
        version: "build_plan.v3",
        plan_id: v2Golden.plan.plan_id,
        plan_revision: v2Golden.plan.revision,
        intent_id: v2Golden.plan.intent_id,
        intent_revision: v2Golden.intent.revision,
        public_stage_closure: v2Golden.plan.public_stage_closure,
        reuse: v2Golden.plan.reuse,
        create: v2Golden.plan.create,
        excluded: v2Golden.plan.excluded,
        estimate: v2Golden.plan.estimate,
        budget: v2Golden.plan.budget,
        status: v2Golden.plan.status,
        confirmation_source: v2Golden.plan.confirmation_source,
        confirmed_at: v2Golden.plan.confirmed_at,
      },
    });
    expect(migrated.plan.private_artifacts[0]).toMatchObject({
      artifact_id: v2Golden.plan.private_artifacts[0].artifact_id,
      blueprint_id: v2Golden.plan.private_artifacts[0].blueprint.blueprint_id,
      blueprint_version: v2Golden.plan.private_artifacts[0].blueprint.blueprint_version,
      blueprint: v2Golden.plan.private_artifacts[0].blueprint,
      required_public_capabilities: v2Golden.plan.private_artifacts[0].required_public_capabilities,
    });
    expect(JSON.stringify(migrated)).not.toMatch(/intent_digest|plan_digest|blueprint_digest/u);
  });

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

  it("binds a disabled Pass2 choice into a V2 standard-deep plan", () => {
    const compiled = compileBuildModeV2({
      mode: "standard_deep",
      pass2: "disabled",
      book_id: "book-v2-no-pass2",
      source_fingerprint: "source-v2-no-pass2",
      content_profile: { id: "technical_learning", version: "technical_learning_v0" },
      plan_id: "plan-v2-no-pass2",
      revision: 1,
      created_at: NOW,
      budget: { on_exceed: "needs_user" },
      public_freshness: [],
    });

    expect(compiled.plan?.public_stage_closure).toEqual(["pass1", "profile_sidecar", "book_structure"]);
    expect(compiled.plan?.create).toEqual(["public.pass1", "public.profile_sidecar", "public.book_structure"]);
    expect(compiled.plan?.excluded).toContainEqual({
      artifact: "public.pass2",
      reason: "disabled by the confirmed standard_deep plan",
    });
  });
});
