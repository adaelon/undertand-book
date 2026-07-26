import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILD_CAPABILITY_REGISTRY,
  compileBuildMode,
  standardDeepStageClosure,
  validateBuildCapabilityRegistry,
  type BuildModeCompilationV1,
} from "../src/build-capability";
import type { BuildContentProfile, BuildIntentV1 } from "../src/build-intent";
import {
  inspectAutomaticBuildStageFreshness,
  type AutomaticBuildSnapshot,
  type AutomaticBuildTarget,
} from "../src/build-orchestrator";
import { sidecarPlanOptionFor } from "../src/sidecar-plan";

const GOLDEN = JSON.parse(readFileSync(
  new URL("./fixtures/build-capability-plans.v1.golden.json", import.meta.url),
  "utf8",
)) as unknown;

const NOW = "2026-07-25T08:00:00.000Z";

function profile(id: BuildContentProfile["id"]): BuildContentProfile {
  return id === "paper"
    ? { id: "paper", version: "paper_v0" }
    : { id: "technical_learning", version: "technical_learning_v0" };
}

function intent(
  contentProfile: BuildContentProfile,
  desiredArtifacts: BuildIntentV1["desired_artifacts"],
): BuildIntentV1 {
  return {
    version: "build_intent.v1",
    intent_id: `intent-${contentProfile.id}`,
    revision: 1,
    book_id: `book-${contentProfile.id}`,
    source_fingerprint: `source-${contentProfile.id}`,
    content_profile: contentProfile,
    user_goal: "reader-private goal",
    goal_kind: "analyze",
    source_scope: { whole_book: false, lids: ["1.1", "2.1"], sections: [] },
    desired_artifacts: desiredArtifacts,
    usage_horizon: "project",
    privacy: "reader_private",
    status: "draft",
    created_at: NOW,
  };
}

function target(profileId: BuildContentProfile["id"]): AutomaticBuildTarget {
  const bookId = `book-${profileId}`;
  return {
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
      input_fingerprint: `source-${profileId}`,
    },
  };
}

function snapshot(
  profileId: BuildContentProfile["id"],
  closedStages: string[],
): AutomaticBuildSnapshot {
  const stages = standardDeepStageClosure(profile(profileId)).map((stage) => ({
    stage,
    pending_tasks: [],
    closed: closedStages.includes(stage),
  }));
  return { target: target(profileId), stages };
}

function compilation(
  profileId: BuildContentProfile["id"],
  mode: "read_now" | "standard_deep" | "goal_directed",
): BuildModeCompilationV1 {
  const contentProfile = profile(profileId);
  const buildIntent = mode === "goal_directed"
    ? intent(
        contentProfile,
        profileId === "paper" ? ["concept_map", "argument_map"] : ["timeline", "comparison_table"],
      )
    : undefined;
  const closed = profileId === "paper" ? ["pass1", "paper_metadata"] : ["pass1"];
  return compileBuildMode({
    mode,
    book_id: `book-${profileId}`,
    source_fingerprint: `source-${profileId}`,
    content_profile: contentProfile,
    plan_id: `plan-${profileId}-${mode}`,
    revision: 1,
    created_at: NOW,
    budget: { max_total_tokens: 100_000, on_exceed: "needs_user" },
    public_freshness: inspectAutomaticBuildStageFreshness(snapshot(profileId, closed)),
    ...(buildIntent ? {
      intent: buildIntent,
      requested_capability_ids: buildIntent.desired_artifacts.map((artifact) => `private.${artifact}`),
    } : {}),
  });
}

function goldenProjection(value: BuildModeCompilationV1): unknown {
  return {
    mode: value.mode,
    estimate_input: value.estimate_input ?? null,
    plan: value.plan
      ? {
          plan_id: value.plan.plan_id,
          recipe_id: value.plan.recipe_id,
          public_stage_closure: value.plan.public_stage_closure,
          private_artifacts: value.plan.private_artifacts,
          reuse: value.plan.reuse,
          create: value.plan.create,
          excluded: value.plan.excluded,
          estimate: value.plan.estimate,
          budget: value.plan.budget,
          plan_digest: value.plan.plan_digest,
        }
      : null,
  };
}

describe("IP3 capability registry and deterministic BuildPlan compiler", () => {
  it("freezes the selectable registry and rejects unknown or profile-incomplete definitions", () => {
    expect(Object.keys(BUILD_CAPABILITY_REGISTRY)).toEqual([
      "public.standard_deep",
      "private.timeline",
      "private.concept_map",
      "private.comparison_table",
      "private.argument_map",
    ]);
    expect(() => validateBuildCapabilityRegistry(BUILD_CAPABILITY_REGISTRY)).not.toThrow();
    expect(Object.isFrozen(BUILD_CAPABILITY_REGISTRY)).toBe(true);
    expect(Object.isFrozen(BUILD_CAPABILITY_REGISTRY["private.timeline"].output_contract)).toBe(true);

    const missingProfile = structuredClone(BUILD_CAPABILITY_REGISTRY) as Record<string, unknown>;
    (missingProfile["private.timeline"] as { supported_profiles: string[] }).supported_profiles = ["paper"];
    expect(() => validateBuildCapabilityRegistry(missingProfile)).toThrow("both content profiles");

    const goal = intent(profile("paper"), ["timeline"]);
    expect(() => compileBuildMode({
      mode: "goal_directed",
      book_id: goal.book_id,
      source_fingerprint: goal.source_fingerprint,
      content_profile: goal.content_profile,
      plan_id: "plan-unknown",
      revision: 1,
      created_at: NOW,
      budget: { on_exceed: "needs_user" },
      intent: goal,
      requested_capability_ids: ["private.timeline", "private.unknown"],
      public_freshness: [],
    })).toThrow("unknown build capability");
  });

  it("derives stable profile-specific standard closures from the current DAG", () => {
    expect(standardDeepStageClosure(profile("technical_learning"))).toEqual([
      "pass1",
      "profile_sidecar",
      "pass2",
      "book_structure",
    ]);
    expect(standardDeepStageClosure(profile("paper"))).toEqual([
      "pass1",
      "paper_metadata",
      "paper_lexicon",
      "profile_sidecar",
      "pass2",
      "book_structure",
      "paper_reading_guide",
    ]);

    const paperFreshness = inspectAutomaticBuildStageFreshness(
      snapshot("paper", ["pass1", "paper_metadata"]),
    ).reverse();
    const compiled = compileBuildMode({
      mode: "standard_deep",
      book_id: "book-paper",
      source_fingerprint: "source-paper",
      content_profile: profile("paper"),
      plan_id: "plan-paper-order",
      revision: 1,
      created_at: NOW,
      budget: { on_exceed: "needs_user" },
      public_freshness: paperFreshness,
    });
    expect(compiled.plan?.reuse.map((artifact) => artifact.artifact)).toEqual([
      "public.pass1",
      "public.paper_metadata",
    ]);
    expect(compiled.plan?.create).toEqual([
      "public.paper_lexicon",
      "public.profile_sidecar",
      "public.pass2",
      "public.book_structure",
      "public.paper_reading_guide",
    ]);
  });

  it("reuses the four SidecarPlan contracts as private lid-required overlays", () => {
    for (const artifact of ["timeline", "concept_map", "comparison_table", "argument_map"] as const) {
      const capability = BUILD_CAPABILITY_REGISTRY[`private.${artifact}`];
      const sidecar = sidecarPlanOptionFor(artifact);
      expect(capability.visibility).toBe("reader_private");
      expect(capability.required_public_capabilities).toEqual(["foundation.lid"]);
      expect(capability.evidence_policy).toBe("lid_required");
      expect(capability.output_contract).toEqual(sidecar.output_contract);
      expect(capability.validation_rules).toEqual(sidecar.validation_rules);
    }
  });

  it("projects current orchestrator freshness without writing or treating pending stages as reusable", () => {
    const inspected = inspectAutomaticBuildStageFreshness(snapshot("technical_learning", ["pass1"]));
    expect(inspected.map(({ artifact, fresh }) => ({ artifact, fresh }))).toEqual([
      { artifact: "public.pass1", fresh: true },
      { artifact: "public.profile_sidecar", fresh: false },
      { artifact: "public.pass2", fresh: false },
      { artifact: "public.book_structure", fresh: false },
    ]);
    expect(inspected[0].freshness_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspected[1].freshness_digest).toBeUndefined();
  });

  it("does not accept the legacy SidecarBuildIntent as a top-level BuildIntent", () => {
    expect(() => compileBuildMode({
      mode: "goal_directed",
      book_id: "paper-a",
      source_fingerprint: "source-a",
      content_profile: profile("paper"),
      plan_id: "plan-sidecar",
      revision: 1,
      created_at: NOW,
      budget: { on_exceed: "needs_user" },
      intent: {
        version: "sidecar_build_intent.v1",
        user_request: "Map the claims",
        target_view: "argument_map",
        source_scope: { whole_book: true },
        output_contract: sidecarPlanOptionFor("argument_map").output_contract,
      },
      requested_capability_ids: ["private.argument_map"],
      public_freshness: [],
    })).toThrow();
  });

  it("matches the two-profile by three-mode golden plans", () => {
    const actual = ["technical_learning", "paper"].flatMap((profileId) =>
      ["read_now", "standard_deep", "goal_directed"].map((mode) => ({
        profile: profileId,
        ...goldenProjection(compilation(
          profileId as BuildContentProfile["id"],
          mode as "read_now" | "standard_deep" | "goal_directed",
        )) as object,
      })),
    );
    expect(actual).toEqual(GOLDEN);
  });
});
