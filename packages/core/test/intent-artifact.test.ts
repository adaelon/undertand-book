import { describe, expect, it } from "vitest";
import { compileBuildModeV3 } from "../src/build-capability";
import {
  transitionBuildIntentV3,
  transitionBuildPlanV3,
  validateBuildIntentV3,
  type BuildIntentV3,
  type BuildPlanV3,
} from "../src/build-intent-v2";
import { getSystemArtifactBlueprintV1 } from "../src/artifact-blueprint";
import {
  acceptIntentArtifactCandidate,
  adaptIntentArtifactPayloadV1,
  compileIntentArtifactTasks,
  projectIntentArtifactTaskHandoff,
  type IntentArtifactCandidateV3,
  type IntentArtifactTaskEnvelopeV3,
} from "../src/intent-artifact";

const availableLids = ["1.1", "1.2", "2.1"];
const resolvedScopeLids = ["1.1", "1.2"];

function confirmedSelection(): { intent: BuildIntentV3; plan: BuildPlanV3 } {
  const draftIntent = validateBuildIntentV3({
    version: "build_intent.v3",
    intent_id: "intent-private-artifacts",
    intent_revision: 1,
    book_id: "book-a",
    source_fingerprint: "source-a",
    content_profile: { id: "technical_learning", version: "technical_learning_v0" },
    user_goal: "PRIVATE_GOAL_SENTINEL compare the sequence, concepts, methods, and claims.",
    goal_kind: "compare",
    source_scope: { whole_book: false, lids: ["1.1", "1.2"], sections: [] },
    usage_horizon: "project",
    privacy: "reader_private",
    status: "draft",
    created_at: "2026-07-26T00:00:00.000Z",
  });
  const selected_blueprints = ["timeline", "concept_map", "comparison_table", "argument_map"].map(
    (artifactType) => {
      const preset = getSystemArtifactBlueprintV1(
        artifactType as "timeline" | "concept_map" | "comparison_table" | "argument_map",
      );
      return {
        version: "artifact_blueprint_resolution.v2" as const,
        source: "system" as const,
        blueprint: preset.blueprint,
        blueprint_id: preset.blueprint.blueprint_id,
        blueprint_version: preset.blueprint.blueprint_version,
      };
    },
  );
  const draftPlan = compileBuildModeV3({
    mode: "goal_directed",
    book_id: draftIntent.book_id,
    source_fingerprint: draftIntent.source_fingerprint,
    content_profile: draftIntent.content_profile,
    plan_id: "plan-private-artifacts",
    plan_revision: 1,
    created_at: draftIntent.created_at,
    budget: { max_total_tokens: 40_000, on_exceed: "needs_user" },
    public_freshness: [],
    intent: draftIntent,
    selected_blueprints,
  }).plan!;
  return {
    intent: transitionBuildIntentV3(draftIntent, "confirmed", { at: "2026-07-26T00:01:00.000Z" }),
    plan: transitionBuildPlanV3(draftPlan, "confirmed", {
      at: "2026-07-26T00:01:00.000Z",
      confirmation_source: "reader_ui",
    }),
  };
}

function tasks() {
  const selection = confirmedSelection();
  return {
    ...selection,
    tasks: compileIntentArtifactTasks({
      ...selection,
      available_lids: availableLids,
      resolved_scope_lids: resolvedScopeLids,
    }),
  };
}

const payloadByType = {
  timeline: {
    items: [{ id: "event-1", label: "First event", order_hint: "1", evidence_lids: ["1.1"] }],
  },
  concept_map: {
    nodes: [
      { id: "concept-a", label: "Concept A", evidence_lids: ["1.1"] },
      { id: "concept-b", label: "Concept B", evidence_lids: ["1.2"] },
    ],
    links: [{ source: "concept-a", target: "concept-b", relation: "enables", evidence_lids: ["1.2"] }],
  },
  comparison_table: {
    rows: [{ subject: "Method A", dimensions: { mechanism: "retrieval", tradeoff: "latency" }, evidence_lids: ["1.1"] }],
  },
  argument_map: {
    claims: [
      { id: "claim-a", claim: "The method improves recall.", role: "result", evidence_lids: ["1.1"] },
      { id: "claim-b", claim: "The evaluation is narrow.", role: "limitation", evidence_lids: ["1.2"] },
    ],
    relations: [{ source: "claim-b", target: "claim-a", relation: "qualifies", evidence_lids: ["1.2"] }],
  },
} as const;

function legacyType(task: IntentArtifactTaskEnvelopeV3) {
  if (task.artifact.artifact_type === "custom") throw new Error("expected a legacy system Blueprint");
  return task.artifact.artifact_type;
}

function candidate(task: IntentArtifactTaskEnvelopeV3, payload: unknown): IntentArtifactCandidateV3 {
  const adapted = adaptIntentArtifactPayloadV1(legacyType(task), payload);
  return {
    version: "intent_artifact_candidate.v3",
    task_id: task.task_id,
    book_id: task.book_id,
    source_fingerprint: task.source_fingerprint,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
    payload: {
      version: "artifact_instance.v3",
      blueprint_id: task.artifact.blueprint_id,
      blueprint_version: task.artifact.blueprint_version,
      records: adapted.records,
      ...(adapted.relations === undefined ? {} : { relations: adapted.relations }),
    },
  };
}

function accept(
  task: IntentArtifactTaskEnvelopeV3,
  payload: unknown,
  overrides: Partial<IntentArtifactCandidateV3> = {},
) {
  const { intent, plan } = confirmedSelection();
  return acceptIntentArtifactCandidate({
    task,
    candidate: { ...candidate(task, payload), ...overrides },
    current_intent: intent,
    current_plan: plan,
    current_source_fingerprint: "source-a",
    available_lids: availableLids,
    resolved_scope_lids: resolvedScopeLids,
    accepted_at: "2026-07-26T00:02:00.000Z",
  });
}

describe("IP7 reader-private intent artifact gate", () => {
  it("compiles one private task per confirmed plan artifact from the frozen Sidecar contracts", () => {
    const { intent, plan, tasks: compiled } = tasks();
    expect(compiled.map((task) => task.artifact.artifact_type)).toEqual([
      "timeline",
      "concept_map",
      "comparison_table",
      "argument_map",
    ]);
    expect(new Set(compiled.map((task) => task.task_id)).size).toBe(4);
    expect(compiled.every((task) => task.privacy === "reader_private")).toBe(true);
    expect(compiled.every((task) => task.intent_id === intent.intent_id
      && task.intent_revision === intent.intent_revision)).toBe(true);
    expect(compiled.every((task) => task.plan_id === plan.plan_id
      && task.plan_revision === plan.plan_revision)).toBe(true);
    expect(compiled.every((task) => task.allowed_evidence_lids.join(",") === resolvedScopeLids.join(","))).toBe(true);
    for (const task of compiled) {
      expect(task.version).toBe("intent_artifact_task_envelope.v3");
      expect(task.output_contract).toEqual({
        version: "artifact_instance_output_contract.v3",
        payload_version: "artifact_instance.v3",
        blueprint_id: task.artifact.blueprint_id,
        blueprint_version: task.artifact.blueprint_version,
      });
      expect(task.validation_rules).toContain("record_and_relation_data_match_restricted_schema");
      expect(task.user_goal).toBe(intent.user_goal);
    }
  });

  it("accepts all four stable schemas and returns a bounded body-free receipt", () => {
    for (const task of tasks().tasks) {
      const artifactType = legacyType(task);
      const result = accept(task, payloadByType[artifactType]);
      expect(result.accepted).toMatchObject({
        version: "intent_artifact_accepted.v3",
        task_id: task.task_id,
        artifact_id: task.artifact.artifact_id,
        blueprint_id: task.artifact.blueprint_id,
        blueprint_version: task.artifact.blueprint_version,
        payload: {
          version: "artifact_instance.v3",
          blueprint_id: task.artifact.blueprint_id,
          blueprint_version: task.artifact.blueprint_version,
        },
      });
      expect(result.receipt).toMatchObject({
        version: "intent_artifact_task_receipt.v2",
        state: "committed",
        task_id: task.task_id,
        artifact_id: task.artifact.artifact_id,
      });
      const receipt = JSON.stringify(result.receipt);
      expect(receipt).not.toContain("PRIVATE_GOAL_SENTINEL");
      expect(receipt).not.toContain("evidence_lids");
      expect(receipt).not.toContain("The method improves recall");
      expect(Buffer.byteLength(receipt)).toBeLessThanOrEqual(4_096);
    }
  });

  it("rejects fabricated and cross-scope evidence plus broken graph references", () => {
    const timeline = tasks().tasks.find((task) => task.artifact.artifact_type === "timeline")!;
    expect(() => accept(timeline, {
      items: [{ id: "bad", label: "Bad", evidence_lids: ["9.9"] }],
    })).toThrow(/current book LID/i);
    expect(() => accept(timeline, {
      items: [{ id: "bad", label: "Bad", evidence_lids: ["2.1"] }],
    })).toThrow(/source scope/i);

    const concept = tasks().tasks.find((task) => task.artifact.artifact_type === "concept_map")!;
    expect(() => accept(concept, {
      nodes: [{ id: "known", label: "Known", evidence_lids: ["1.1"] }],
      links: [{ source: "known", target: "missing", relation: "points", evidence_lids: ["1.1"] }],
    })).toThrow(/reference an existing record/i);
  });

  it("rejects stale source/intent/plan identity and non-contract candidate fields", () => {
    const task = tasks().tasks[0];
    const payload = payloadByType.timeline;
    expect(() => accept(task, payload, { source_fingerprint: "source-old" })).toThrow(/source_fingerprint/i);
    expect(() => accept(task, payload, { intent_revision: task.intent_revision + 1 })).toThrow(/intent_revision/i);
    expect(() => accept(task, payload, { plan_revision: task.plan_revision + 1 })).toThrow(/plan_revision/i);
    expect(() => accept(task, payload, { blueprint_version: "2.0.0" })).toThrow(/blueprint_version/i);
    expect(() => acceptIntentArtifactCandidate({
      task,
      candidate: { ...candidate(task, payload), candidate_path: "C:/public/candidate.json" },
      current_intent: confirmedSelection().intent,
      current_plan: confirmedSelection().plan,
      current_source_fingerprint: "source-a",
      available_lids: availableLids,
      resolved_scope_lids: resolvedScopeLids,
      accepted_at: "2026-07-26T00:02:00.000Z",
    })).toThrow(/unrecognized key/i);
  });

  it("exposes only an opaque private task path to the root handoff", () => {
    const task = tasks().tasks[0];
    const handoff = projectIntentArtifactTaskHandoff(
      task,
      "C:/reader-private/book-a/artifacts/intent-private-artifacts/task.json",
    );
    const serialized = JSON.stringify(handoff);
    expect(handoff).toMatchObject({
      version: "intent_artifact_task_handoff.v2",
      task_id: task.task_id,
      intent_id: task.intent_id,
      intent_revision: task.intent_revision,
      plan_id: task.plan_id,
      plan_revision: task.plan_revision,
      artifact_type: "timeline",
    });
    expect(serialized).toContain("task.json");
    expect(serialized).not.toContain("PRIVATE_GOAL_SENTINEL");
    expect(serialized).not.toContain("output_contract");
    expect(serialized).not.toContain("allowed_evidence_lids");
  });
});
