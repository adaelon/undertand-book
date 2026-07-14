import { describe, expect, it } from "vitest";
import type { ProfileMemoryState, ProfileMemoryUpdate } from "./api";
import {
  buildUndoProfileAction,
  evidenceForFact,
  factSemanticKey,
  factsForScope,
} from "./profile-memory";

function fact(overrides: Partial<ProfileMemoryState["facts"][number]> = {}) {
  return {
    fact_id: "fact-current",
    scope_kind: "book",
    scope_value: "book-a",
    applicability_kind: "any",
    applicability_value: null,
    payload_kind: "explanation_preference",
    payload_key: "depth",
    payload_value: "concise",
    source: "user_stated",
    status: "confirmed",
    sensitivity: "normal",
    evidence_ids: ["evidence-current"],
    created_at: "t0",
    updated_at: "t0",
    valid_until: null,
    supersedes: [],
    ...overrides,
  };
}

function state(facts: ProfileMemoryState["facts"]): ProfileMemoryState {
  return {
    current_book_id: "book-a",
    status: {
      document_revision: 4,
      projection_revision: 4,
      profile_status: "current",
      pending_sensitive_confirmation: false,
      pending_review_jobs: 0,
      review_error: null,
    },
    snapshot: {
      source_revision: 4,
      profile_status: "current",
      global_core: [],
      applicable_global: [],
      book_state_core: [],
      profile_projection: [],
      pending_context: [],
    },
    facts,
    pending_candidates: [],
    evidence: [
      {
        fact_id: "fact-current",
        evidence_id: "evidence-z",
        kind: "turn",
        session_id: "session",
        turn_id: "turn-z",
        mem_id: null,
        book_id: null,
        lid: null,
        text: null,
      },
      {
        fact_id: "fact-current",
        evidence_id: "evidence-a",
        kind: "book_location",
        session_id: null,
        turn_id: null,
        mem_id: null,
        book_id: "book-a",
        lid: "1.1",
        text: null,
      },
    ],
    collection_rules: [],
  };
}

function update(kind: ProfileMemoryUpdate["kind"], factId: string): ProfileMemoryUpdate {
  return { kind, operation_id: "op", fact_ids: [factId], message: null };
}

describe("profile memory view helpers", () => {
  it("filters scopes, orders evidence, and derives exact semantic keys", () => {
    const snapshot = state([
      fact({ fact_id: "fact-global", scope_kind: "global", scope_value: null }),
      fact({ fact_id: "fact-history", status: "superseded", payload_key: "history" }),
      fact(),
    ]);

    expect(factsForScope(snapshot, "book").map((item) => item.fact_id)).toEqual(["fact-current"]);
    expect(factsForScope(snapshot, "book", true).map((item) => item.fact_id)).toEqual([
      "fact-current",
      "fact-history",
    ]);
    expect(evidenceForFact(snapshot, "fact-current").map((item) => item.evidence_id)).toEqual([
      "evidence-a",
      "evidence-z",
    ]);
    expect(factSemanticKey(snapshot.facts[0])).toBe("explanation_preference:depth");
  });

  it("undoes only an active remembered fact", () => {
    const snapshot = state([fact()]);
    expect(buildUndoProfileAction(snapshot, update("remembered", "fact-current"), "undo-1"))
      .toEqual({ kind: "forget", operation_id: "undo-1", fact_id: "fact-current" });

    snapshot.facts[0].status = "superseded";
    expect(buildUndoProfileAction(snapshot, update("remembered", "fact-current"), "undo-2"))
      .toBeNull();
  });

  it("reverts an active correction through a new successor without editing history", () => {
    const previous = fact({
      fact_id: "fact-previous",
      status: "superseded",
      payload_value: "detailed",
      valid_until: "2027-01-01",
    });
    const current = fact({ supersedes: [previous.fact_id] });
    const action = buildUndoProfileAction(
      state([previous, current]),
      update("corrected", current.fact_id),
      "undo-correction",
    );

    expect(action).toEqual({
      kind: "correct",
      operation_id: "undo-correction",
      evidence_text: "User undid profile correction fact-current",
      fact_id: "fact-current",
      payload_value: "detailed",
      valid_until: "2027-01-01",
    });
    expect(buildUndoProfileAction(state([current]), update("corrected", current.fact_id), "missing"))
      .toBeNull();
  });
});
