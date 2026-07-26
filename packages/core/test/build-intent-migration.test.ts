import { describe, expect, it } from "vitest";
import {
  confirmBuildIntentSelection,
  draftBuildIntentSelection,
  mapLegacyBuildInvocation,
  replanBuildIntentSelection,
} from "../src/build-intent-controller";

const NOW = "2026-07-26T04:00:00.000Z";
const LATER = "2026-07-26T04:10:00.000Z";
const FRESH_PASS1 = {
  version: "automatic_build_stage_freshness.v1" as const,
  artifact: "public.pass1" as const,
  stage: "pass1" as const,
  fresh: true,
  freshness_digest: "a".repeat(64),
};

function target(source_fingerprint = "source-v1") {
  return {
    book_id: "migration-book",
    source_fingerprint,
    content_profile: { id: "technical_learning" as const, version: "technical_learning_v0" as const },
    public_freshness: [FRESH_PASS1],
  };
}

function candidate(artifact: "timeline" | "concept_map" = "timeline") {
  return {
    version: "build_intent_planner_candidate.v1" as const,
    goal_kind: "analyze" as const,
    source_scope: { whole_book: true, lids: [], sections: [] },
    desired_artifacts: [artifact],
    usage_horizon: "project" as const,
  };
}

function confirmedGoal() {
  const draft = draftBuildIntentSelection({
    mode: "goal_directed",
    target: target(),
    now: NOW,
    user_goal: "Build a private timeline",
    candidate: candidate(),
  });
  return confirmBuildIntentSelection(draft, {
    plan_id: draft.plan!.plan_id,
    plan_digest: draft.plan!.plan_digest,
    at: NOW,
    confirmation_source: "reader_ui",
  });
}

describe("IP8 replan and legacy migration contracts", () => {
  it("supersedes the prior selection without scheduling a fresh public Pass1 again", () => {
    const previous = confirmedGoal();
    const result = replanBuildIntentSelection(previous, {
      mode: "goal_directed",
      target: target(),
      now: LATER,
      user_goal: "Build a private concept map",
      candidate: candidate("concept_map"),
    });

    expect(result.previous.intent?.status).toBe("superseded");
    expect(result.previous.plan?.status).toBe("superseded");
    expect(result.previous.plan?.plan_digest).toBe(previous.plan?.plan_digest);
    expect(result.current.intent).toMatchObject({
      revision: 2,
      supersedes_intent_id: previous.intent?.intent_id,
      status: "draft",
    });
    expect(result.current.intent?.intent_id).not.toBe(previous.intent?.intent_id);
    expect(result.current.plan).toMatchObject({ revision: 2, public_stage_closure: [] });
    expect(result.current.plan?.create).toEqual(["private.concept_map"]);
    expect(result.current.plan?.create).not.toContain("public.pass1");
  });

  it("marks the prior selection stale when the source identity changes before reconfirmation", () => {
    const result = replanBuildIntentSelection(confirmedGoal(), {
      mode: "goal_directed",
      target: target("source-v2"),
      now: LATER,
      user_goal: "Rebuild against the changed source",
      candidate: candidate("concept_map"),
    });

    expect(result.previous.intent?.status).toBe("stale_source");
    expect(result.previous.plan?.status).toBe("stale_source");
    expect(result.current.intent).toMatchObject({ source_fingerprint: "source-v2", status: "draft" });
    expect(result.current.plan).toMatchObject({ source_fingerprint: "source-v2", status: "draft" });
  });

  it("maps only an explicit legacy full-build invocation to a confirmed standard plan", () => {
    for (const invocation of ["book_open", "book_import", "book_resume"] as const) {
      expect(mapLegacyBuildInvocation({ invocation, target: target(), now: NOW })).toBeNull();
    }

    const explicit = mapLegacyBuildInvocation({
      invocation: "explicit_full_build",
      target: target(),
      now: NOW,
    });
    expect(explicit).not.toBeNull();
    expect(explicit?.intent).toBeNull();
    expect(explicit?.plan).toMatchObject({
      recipe_id: "standard_deep",
      status: "confirmed",
      confirmation_source: "explicit_legacy_command",
      reuse: [{ artifact: "public.pass1", freshness_digest: "a".repeat(64) }],
    });
    expect(explicit?.plan?.create).not.toContain("public.pass1");
  });
});
