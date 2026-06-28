import { describe, expect, it } from "vitest";
import { TECHNICAL_LEARNING_LONG_RANGE_EDGE_TYPES } from "../src/pass2";
import { buildLidToWindowIndex, buildLongRangeCandidates, isCrossWindow } from "../src/pass2-build";
import type { GraphNode } from "../src/generated/GraphNode";
import type { TechnicalLearningDiscourseIndex, TechnicalLearningDiscourseItem } from "../src/discourse-index";

const header = {
  book_id: "book-a",
  book_version: "v1",
  profile_id: "technical_learning" as const,
  profile_version: "technical_learning_v0",
  core_schema_version: "core_v0",
  generated_at: "2026-06-28T00:00:00.000Z",
};

const concept = (id: string, occurrences: string[]): GraphNode => ({ id, type: "concept", name: id, occurrences, source_lid: null });

const discourse = (items: TechnicalLearningDiscourseItem[]): TechnicalLearningDiscourseIndex => ({ header, items });

describe("PB3-1 edge type vocabulary", () => {
  it("extends the closed set to 11 types including supports/rebuts/summarizes", () => {
    expect(TECHNICAL_LEARNING_LONG_RANGE_EDGE_TYPES).toHaveLength(11);
    for (const t of ["supports", "rebuts", "summarizes"]) {
      expect(TECHNICAL_LEARNING_LONG_RANGE_EDGE_TYPES).toContain(t);
    }
  });

  it("does not include the forbidden types", () => {
    for (const t of ["related_to", "same_problem", "reuses_formula"]) {
      expect(TECHNICAL_LEARNING_LONG_RANGE_EDGE_TYPES).not.toContain(t);
    }
  });
});

describe("PB3-1 cross-window helpers", () => {
  const windows = [{ leafLids: ["1.1", "1.2"] }, { leafLids: ["2.1", "2.2"] }, { leafLids: ["3.1"] }];

  it("maps leaf LIDs to their window index", () => {
    const map = buildLidToWindowIndex(windows);
    expect(map.get("1.2")).toBe(0);
    expect(map.get("2.1")).toBe(1);
    expect(map.get("3.1")).toBe(2);
    expect(map.get("9.9")).toBeUndefined();
  });

  it("is cross-window when source and target evidence sit in different windows", () => {
    const map = buildLidToWindowIndex(windows);
    expect(isCrossWindow(["1.1"], ["3.1"], map)).toBe(true);
    expect(isCrossWindow(["1.1", "2.1"], ["1.2"], map)).toBe(true); // 2.1(w1) vs 1.2(w0)
  });

  it("is not cross-window when all evidence is in one window", () => {
    const map = buildLidToWindowIndex(windows);
    expect(isCrossWindow(["1.1"], ["1.2"], map)).toBe(false);
  });

  it("is not cross-window when evidence LIDs do not resolve", () => {
    const map = buildLidToWindowIndex(windows);
    expect(isCrossWindow(["9.9"], ["3.1"], map)).toBe(false);
    expect(isCrossWindow(["1.1"], ["8.8"], map)).toBe(false);
  });
});

describe("PB3-2a candidate builder (shared-node bridge)", () => {
  const idx = buildLidToWindowIndex([
    { leafLids: ["1.1", "1.2"] },
    { leafLids: ["2.1", "2.2"] },
    { leafLids: ["3.1", "3.2"] },
  ]);
  // concept:command recurs in w0(1.1) and w2(3.1) -> the bridge; concept:undo co-located in w2(3.2).
  const nodes = [concept("concept:command", ["1.1", "3.1"]), concept("concept:undo", ["3.2"]), concept("entity:tree", ["1.2"])];

  it("bridges a recurring node to a co-located node and sets signal-1 hints from discourse function", () => {
    const result = buildLongRangeCandidates({
      graphNodes: nodes,
      lidToWindowIndex: idx,
      discourseIndex: discourse([
        { lid: "1.1", mode: "informative", local_function: "definition", relations: [] },
        { lid: "3.2", mode: "descriptive", local_function: "example", relations: [] },
      ]),
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      candidate_id: "cand:concept:command->concept:undo",
      source_node_id: "concept:command",
      target_node_id: "concept:undo",
      source_lids: ["1.1"],
      target_lids: ["3.2"],
      relation_hints: ["exemplifies", "applies"],
    });
    expect(result[0].seed_reasons).toContain("shared_node_bridge:concept:command");
    expect(result[0].seed_reasons).toContain("signal1_definition_to_use");
    expect(result[0].seed_score).toBeCloseTo(0.7);
  });

  it("emits the bridge with empty hints when no discourse index is given", () => {
    const result = buildLongRangeCandidates({ graphNodes: nodes, lidToWindowIndex: idx });

    expect(result).toHaveLength(1);
    expect(result[0].relation_hints).toEqual([]);
    expect(result[0].seed_score).toBeCloseTo(0.4);
  });

  it("sets signal-2 hints from rhetorical_move complementarity", () => {
    const result = buildLongRangeCandidates({
      graphNodes: nodes,
      lidToWindowIndex: idx,
      discourseIndex: discourse([
        { lid: "1.1", mode: "informative", rhetorical_move: "main_point", relations: [] },
        { lid: "3.2", mode: "informative", rhetorical_move: "concept_elaboration", relations: [] },
      ]),
    });

    expect(result[0].relation_hints).toEqual(["builds_on", "prerequisite"]);
    expect(result[0].seed_reasons).toContain("signal2_prerequisite_to_elaboration");
  });

  it("produces nothing when no node recurs across distinct windows", () => {
    const result = buildLongRangeCandidates({
      graphNodes: [concept("concept:flyweight", ["2.1", "2.2"]), concept("entity:tree", ["1.2"])],
      lidToWindowIndex: idx,
    });

    expect(result).toEqual([]);
  });

  it("merges the same ordered pair found across multiple later windows", () => {
    const idx4 = buildLidToWindowIndex([
      { leafLids: ["1.1"] },
      { leafLids: ["2.1"] },
      { leafLids: ["3.1", "3.2"] },
      { leafLids: ["4.1", "4.2"] },
    ]);
    // Both nodes recur, so both directed candidates are emitted (v1 high recall);
    // the command->undo pair must merge its w2 and w3 evidence into one candidate.
    const result = buildLongRangeCandidates({
      graphNodes: [concept("concept:command", ["1.1", "3.1", "4.1"]), concept("concept:undo", ["3.2", "4.2"])],
      lidToWindowIndex: idx4,
    });

    expect(result).toHaveLength(2);
    const forward = result.find((c) => c.candidate_id === "cand:concept:command->concept:undo");
    expect(forward).toBeDefined();
    expect(forward!.source_lids).toEqual(["1.1"]);
    expect(forward!.target_lids).toEqual(["3.2", "4.2"]);
  });
});
