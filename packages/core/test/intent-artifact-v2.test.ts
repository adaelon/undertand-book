import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computeArtifactBlueprintDigest,
  type ArtifactBlueprintV1,
} from "../src/artifact-blueprint";
import { compileBuildModeV2 } from "../src/build-capability";
import { canonicalBuildJson } from "../src/build-intent";
import {
  transitionBuildIntentV2,
  transitionBuildPlanV2,
  migratePlanningControlV2ToV3,
  validateBuildIntentV2,
  type BuildIntentV2,
  type BuildPlanV2,
  type BuildIntentV3,
  type BuildPlanV3,
} from "../src/build-intent-v2";
import {
  acceptIntentArtifactCandidate,
  compileIntentArtifactTasks,
  projectAcceptedIntentArtifactV1AsV2,
  type IntentArtifactCandidateV3,
  type IntentArtifactTaskEnvelopeV3,
} from "../src/intent-artifact";

const availableLids = ["1.1", "1.2", "2.1"];
const resolvedScopeLids = ["1.1", "1.2"];

const blueprint: ArtifactBlueprintV1 = {
  version: "artifact_blueprint.v1",
  blueprint_id: "one-off.method-tradeoffs",
  blueprint_version: "1.0.0",
  origin: "one_off",
  title: "Method trade-offs",
  purpose: "Compare methods and connect explicit trade-offs.",
  shape: "graph",
  record_schema: {
    type: "object",
    properties: {
      label: { type: "string", min_length: 1, max_length: 20 },
      score: { type: "number", minimum: 0, maximum: 10 },
    },
    required: ["label", "score"],
    additional_properties: false,
    max_properties: 2,
  },
  relation_schema: {
    type: "object",
    properties: {
      kind: { type: "string", min_length: 1, max_length: 20 },
    },
    required: ["kind"],
    additional_properties: false,
    max_properties: 1,
  },
  routing: {
    use_when: ["The question compares method trade-offs."],
    avoid_when: [],
    covered_topics: ["methods", "trade-offs"],
    scope_label: "selected methods",
  },
  search_fields: [
    { path: "/label", weight: 10, analyzer: "text" },
    { path: "/kind", weight: 5, analyzer: "keyword" },
  ],
  summary_fields: ["/label", "/score", "/kind"],
  evidence_policy: { required_per_record: true, anchor: "lid" },
  limits: { max_records: 2, max_relations: 1, max_text_chars: 30 },
};
const blueprintDigest = computeArtifactBlueprintDigest(blueprint);

function legacyConfirmedSelection(): { intent: BuildIntentV2; plan: BuildPlanV2 } {
  const draftIntent = validateBuildIntentV2({
    version: "build_intent.v2",
    intent_id: "intent-artifact-v2",
    revision: 1,
    book_id: "book-a",
    source_fingerprint: "source-a",
    content_profile: { id: "technical_learning", version: "technical_learning_v0" },
    user_goal: "PRIVATE_V2_GOAL compare method trade-offs.",
    goal_kind: "compare",
    source_scope: { whole_book: false, lids: ["1.1", "1.2"], sections: [] },
    usage_horizon: "project",
    privacy: "reader_private",
    status: "draft",
    created_at: "2026-07-29T12:00:00.000Z",
  });
  const draftPlan = compileBuildModeV2({
    mode: "goal_directed",
    book_id: draftIntent.book_id,
    source_fingerprint: draftIntent.source_fingerprint,
    content_profile: draftIntent.content_profile,
    plan_id: "plan-artifact-v2",
    revision: 1,
    created_at: draftIntent.created_at,
    budget: { max_total_tokens: 20_000, on_exceed: "needs_user" },
    public_freshness: [],
    intent: draftIntent,
    selected_blueprints: [{
      version: "artifact_blueprint_resolution.v1",
      source: "one_off",
      blueprint,
      digest: blueprintDigest,
    }],
  }).plan!;
  return {
    intent: transitionBuildIntentV2(draftIntent, "confirmed", { at: "2026-07-29T12:01:00.000Z" }),
    plan: transitionBuildPlanV2(draftPlan, "confirmed", {
      at: "2026-07-29T12:01:00.000Z",
      confirmation_source: "reader_ui",
    }),
  };
}

function confirmedSelection(): { intent: BuildIntentV3; plan: BuildPlanV3 } {
  const legacy = legacyConfirmedSelection();
  const migrated = migratePlanningControlV2ToV3(legacy);
  if (!migrated.intent) throw new Error("expected migrated goal-directed BuildIntent");
  return { intent: migrated.intent, plan: migrated.plan };
}

function task(): IntentArtifactTaskEnvelopeV3 {
  const selection = confirmedSelection();
  return compileIntentArtifactTasks({
    ...selection,
    available_lids: availableLids,
    resolved_scope_lids: resolvedScopeLids,
  })[0];
}

function payload(overrides: Partial<IntentArtifactCandidateV3["payload"]> = {}): IntentArtifactCandidateV3["payload"] {
  return {
    version: "artifact_instance.v3",
    blueprint_id: blueprint.blueprint_id,
    blueprint_version: blueprint.blueprint_version,
    records: [
      { record_id: "method-a", data: { label: "Method A", score: 8 }, evidence_lids: ["1.1"] },
      { record_id: "method-b", data: { label: "Method B", score: 6 }, evidence_lids: ["1.2"] },
    ],
    relations: [{
      relation_id: "tradeoff-a-b",
      source: "method-a",
      target: "method-b",
      data: { kind: "tradeoff" },
      evidence_lids: ["1.2"],
    }],
    ...overrides,
  };
}

function candidate(currentTask: IntentArtifactTaskEnvelopeV3, instance = payload()): IntentArtifactCandidateV3 {
  return {
    version: "intent_artifact_candidate.v3",
    task_id: currentTask.task_id,
    book_id: currentTask.book_id,
    source_fingerprint: currentTask.source_fingerprint,
    intent_id: currentTask.intent_id,
    intent_revision: currentTask.intent_revision,
    plan_id: currentTask.plan_id,
    plan_revision: currentTask.plan_revision,
    artifact_id: currentTask.artifact.artifact_id,
    blueprint_id: currentTask.artifact.blueprint_id,
    blueprint_version: currentTask.artifact.blueprint_version,
    payload: instance,
  };
}

function accept(candidateInput: unknown) {
  const selection = confirmedSelection();
  return acceptIntentArtifactCandidate({
    task: task(),
    candidate: candidateInput,
    current_intent: selection.intent,
    current_plan: selection.plan,
    current_source_fingerprint: "source-a",
    available_lids: availableLids,
    resolved_scope_lids: resolvedScopeLids,
    accepted_at: "2026-07-29T12:02:00.000Z",
  });
}

describe("AA4 generic ArtifactInstance V3 gate after V2 migration", () => {
  it("compiles a Blueprint-frozen V3 task and accepts a schema-valid instance", () => {
    const currentTask = task();
    expect(currentTask).toMatchObject({
      version: "intent_artifact_task_envelope.v3",
      artifact: {
        blueprint,
        blueprint_id: blueprint.blueprint_id,
        blueprint_version: blueprint.blueprint_version,
      },
      output_contract: { version: "artifact_instance_output_contract.v3" },
    });
    const result = accept(candidate(currentTask));
    expect(result.accepted).toMatchObject({
      version: "intent_artifact_accepted.v3",
      artifact_id: currentTask.artifact.artifact_id,
      blueprint_id: blueprint.blueprint_id,
      blueprint_version: blueprint.blueprint_version,
      payload: {
        version: "artifact_instance.v3",
        blueprint_id: blueprint.blueprint_id,
        blueprint_version: blueprint.blueprint_version,
      },
    });
    expect(result.receipt).toMatchObject({
      version: "intent_artifact_task_receipt.v2",
      record_count: 2,
      relation_count: 1,
      evidence_reference_count: 3,
    });
    expect(JSON.stringify(result.receipt)).not.toContain("PRIVATE_V2_GOAL");
  });

  it("rejects stale Blueprint identity, invalid schema, duplicate/dangling IDs, and old candidates", () => {
    const currentTask = task();
    const valid = candidate(currentTask);
    expect(() => accept({ ...valid, blueprint_version: "2.0.0" })).toThrow(/blueprint_version|version/i);
    expect(() => accept(candidate(currentTask, payload({ blueprint_id: "one-off.other" })))).toThrow(/Blueprint id|blueprint_id/i);
    expect(() => accept(candidate(currentTask, payload({
      records: [{ record_id: "method-a", data: { label: "Method A", score: 99 }, evidence_lids: ["1.1"] }],
      relations: [],
    })))).toThrow(/numeric bounds/i);
    expect(() => accept(candidate(currentTask, payload({
      records: [
        { record_id: "duplicate", data: { label: "A", score: 1 }, evidence_lids: ["1.1"] },
        { record_id: "duplicate", data: { label: "B", score: 2 }, evidence_lids: ["1.2"] },
      ],
      relations: [],
    })))).toThrow(/record_id.*unique/i);
    expect(() => accept(candidate(currentTask, payload({
      relations: [{
        relation_id: "dangling",
        source: "method-a",
        target: "missing",
        data: { kind: "depends_on" },
        evidence_lids: ["1.1"],
      }],
    })))).toThrow(/existing record/i);
    expect(() => accept({ ...valid, version: "intent_artifact_candidate.v2", artifact_type: "timeline" })).toThrow(/candidate\.v3/i);
  });

  it("rejects fabricated/cross-scope evidence and every Blueprint size limit", () => {
    const currentTask = task();
    expect(() => accept(candidate(currentTask, payload({
      records: [{ record_id: "bad", data: { label: "Bad", score: 1 }, evidence_lids: ["9.9"] }],
      relations: [],
    })))).toThrow(/current book LID/i);
    expect(() => accept(candidate(currentTask, payload({
      records: [{ record_id: "bad", data: { label: "Bad", score: 1 }, evidence_lids: ["2.1"] }],
      relations: [],
    })))).toThrow(/source scope/i);
    expect(() => accept(candidate(currentTask, payload({
      records: [
        { record_id: "a", data: { label: "A", score: 1 }, evidence_lids: ["1.1"] },
        { record_id: "b", data: { label: "B", score: 2 }, evidence_lids: ["1.1"] },
        { record_id: "c", data: { label: "C", score: 3 }, evidence_lids: ["1.2"] },
      ],
      relations: [],
    })))).toThrow(/max_records/i);
    expect(() => accept(candidate(currentTask, payload({
      relations: [
        { relation_id: "r1", source: "method-a", target: "method-b", data: { kind: "depends_on" }, evidence_lids: ["1.1"] },
        { relation_id: "r2", source: "method-b", target: "method-a", data: { kind: "opposes" }, evidence_lids: ["1.2"] },
      ],
    })))).toThrow(/max_relations/i);
    expect(() => accept(candidate(currentTask, payload({
      records: [{ record_id: "long", data: { label: "12345678901234567890", score: 1 }, evidence_lids: ["1.1"] }],
      relations: [{ relation_id: "r", source: "long", target: "long", data: { kind: "12345678901234567890" }, evidence_lids: ["1.1"] }],
    })))).toThrow(/max_text_chars/i);
  });

  it("adapts all four accepted v1 fixtures to stable v2 instances without rewriting v1 digests", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/artifact-blueprint-presets.v1.golden.json", import.meta.url),
      "utf8",
    )) as {
      cases: Array<{
        artifact_type: "timeline" | "concept_map" | "comparison_table" | "argument_map";
        blueprint_digest: string;
        legacy_payload: unknown;
        mapped_records: unknown[];
        mapped_relations: unknown[];
      }>;
    };
    for (const [index, entry] of fixture.cases.entries()) {
      const legacyPayloadDigest = createHash("sha256")
        .update(canonicalBuildJson(entry.legacy_payload), "utf8")
        .digest("hex");
      const legacy = {
        version: "intent_artifact_accepted.v1",
        task_id: `legacy-task-${index}`,
        book_id: "book-a",
        source_fingerprint: "source-a",
        intent_id: "intent-v1",
        intent_digest: "a".repeat(64),
        plan_id: "plan-v1",
        plan_digest: "b".repeat(64),
        artifact_id: `artifact-v1-${index}`,
        artifact_type: entry.artifact_type,
        payload: entry.legacy_payload,
        payload_digest: legacyPayloadDigest,
        accepted_at: "2026-07-29T12:03:00.000Z",
      } as const;
      const originalBytes = JSON.stringify(legacy);
      const adapted = projectAcceptedIntentArtifactV1AsV2(legacy);
      expect(adapted.payload.blueprint_digest).toBe(entry.blueprint_digest);
      expect(adapted.payload.records).toEqual(entry.mapped_records);
      expect(adapted.payload.relations ?? []).toEqual(entry.mapped_relations);
      expect(adapted.legacy_payload_digest).toBe(legacyPayloadDigest);
      expect(JSON.stringify(legacy)).toBe(originalBytes);
    }
  });
});
