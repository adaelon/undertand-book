import { describe, expect, it } from "vitest";
import { compileBuildMode } from "../src/build-capability";
import {
  computeBuildIntentDigest,
  transitionBuildIntent,
  transitionBuildPlan,
  validateBuildIntentV1,
  type BuildIntentV1,
  type BuildPlanV1,
} from "../src/build-intent";
import {
  acceptIntentArtifactCandidate,
  compileIntentArtifactTasks,
  projectIntentArtifactTaskHandoff,
  type IntentArtifactCandidateV1,
  type IntentArtifactTaskEnvelopeV1,
} from "../src/intent-artifact";
import { sidecarPlanOptionFor } from "../src/sidecar-plan";

const availableLids = ["1.1", "1.2", "2.1"];
const resolvedScopeLids = ["1.1", "1.2"];

function confirmedSelection(): { intent: BuildIntentV1; plan: BuildPlanV1 } {
  const draftIntent = validateBuildIntentV1({
    version: "build_intent.v1",
    intent_id: "intent-private-artifacts",
    revision: 1,
    book_id: "book-a",
    source_fingerprint: "source-a",
    content_profile: { id: "technical_learning", version: "technical_learning_v0" },
    user_goal: "PRIVATE_GOAL_SENTINEL compare the sequence, concepts, methods, and claims.",
    goal_kind: "compare",
    source_scope: { whole_book: false, lids: ["1.1", "1.2"], sections: [] },
    desired_artifacts: ["timeline", "concept_map", "comparison_table", "argument_map"],
    usage_horizon: "project",
    privacy: "reader_private",
    status: "draft",
    created_at: "2026-07-26T00:00:00.000Z",
  });
  const draftPlan = compileBuildMode({
    mode: "goal_directed",
    book_id: draftIntent.book_id,
    source_fingerprint: draftIntent.source_fingerprint,
    content_profile: draftIntent.content_profile,
    plan_id: "plan-private-artifacts",
    revision: 1,
    created_at: draftIntent.created_at,
    budget: { max_total_tokens: 40_000, on_exceed: "needs_user" },
    public_freshness: [],
    intent: draftIntent,
  }).plan!;
  return {
    intent: transitionBuildIntent(draftIntent, "confirmed", { at: "2026-07-26T00:01:00.000Z" }),
    plan: transitionBuildPlan(draftPlan, "confirmed", {
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

function candidate(task: IntentArtifactTaskEnvelopeV1, payload: unknown): IntentArtifactCandidateV1 {
  return {
    version: "intent_artifact_candidate.v1",
    task_id: task.task_id,
    book_id: task.book_id,
    source_fingerprint: task.source_fingerprint,
    intent_id: task.intent_id,
    intent_digest: task.intent_digest,
    plan_id: task.plan_id,
    plan_digest: task.plan_digest,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    payload,
  };
}

function accept(
  task: IntentArtifactTaskEnvelopeV1,
  payload: unknown,
  overrides: Partial<IntentArtifactCandidateV1> = {},
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
    expect(compiled.every((task) => task.intent_digest === computeBuildIntentDigest(intent))).toBe(true);
    expect(compiled.every((task) => task.plan_digest === plan.plan_digest)).toBe(true);
    expect(compiled.every((task) => task.allowed_evidence_lids.join(",") === resolvedScopeLids.join(","))).toBe(true);
    for (const task of compiled) {
      const contract = sidecarPlanOptionFor(task.artifact.artifact_type).output_contract;
      expect(task.output_contract).toEqual(contract);
      expect(task.validation_rules).toEqual(sidecarPlanOptionFor(task.artifact.artifact_type).validation_rules);
      expect(task.user_goal).toBe(intent.user_goal);
    }
  });

  it("accepts all four stable schemas and returns a bounded body-free receipt", () => {
    for (const task of tasks().tasks) {
      const result = accept(task, payloadByType[task.artifact.artifact_type]);
      expect(result.accepted).toMatchObject({
        version: "intent_artifact_accepted.v1",
        task_id: task.task_id,
        artifact_id: task.artifact.artifact_id,
        artifact_type: task.artifact.artifact_type,
        payload: payloadByType[task.artifact.artifact_type],
      });
      expect(result.receipt).toMatchObject({
        version: "intent_artifact_task_receipt.v1",
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
    })).toThrow(/reference existing nodes/i);
  });

  it("rejects stale source/intent/plan identity and non-contract candidate fields", () => {
    const task = tasks().tasks[0];
    const payload = payloadByType.timeline;
    expect(() => accept(task, payload, { source_fingerprint: "source-old" })).toThrow(/source_fingerprint/i);
    expect(() => accept(task, payload, { intent_digest: "a".repeat(64) })).toThrow(/intent_digest/i);
    expect(() => accept(task, payload, { plan_digest: "b".repeat(64) })).toThrow(/plan_digest/i);
    expect(() => accept(task, payload, { artifact_type: "concept_map" })).toThrow(/artifact_type/i);
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
      version: "intent_artifact_task_handoff.v1",
      task_id: task.task_id,
      artifact_type: "timeline",
    });
    expect(serialized).toContain("task.json");
    expect(serialized).not.toContain("PRIVATE_GOAL_SENTINEL");
    expect(serialized).not.toContain("output_contract");
    expect(serialized).not.toContain("allowed_evidence_lids");
  });
});
