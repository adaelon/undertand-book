import { describe, expect, it } from "vitest";
import { TECHNICAL_LEARNING_LONG_RANGE_EDGE_TYPES } from "../src/pass2";
import { buildLidToWindowIndex, buildLongRangeCandidates, gatePass2BuildOutput, isCrossWindow } from "../src/pass2-build";
import type { Pass2GateDropReason, TechnicalLearningAcceptedEdge } from "../src/pass2-build";
import type { GraphNode } from "../src/generated/GraphNode";
import type { LidNode } from "../src/generated/LidNode";
import type { FormulaSemantics } from "../src/generated/FormulaSemantics";
import type { TechnicalLearningLongRangeEdgeType } from "../src/pass2";
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

describe("PB3-2b candidate builder (formula bridge, signal 3)", () => {
  const idx = buildLidToWindowIndex([{ leafLids: ["1.1"] }, { leafLids: ["2.1"] }, { leafLids: ["3.1"] }, { leafLids: ["4.1"] }]);
  const formula = (formulaLid: string, targetLid: string): FormulaSemantics => ({
    formula_lid: formulaLid,
    parameters: [],
    composition: { source_lid: formulaLid, meaning: "m", terms: [], evidence_lids: [formulaLid] },
    context_links: [{ target_lid: targetLid, relation: "applied_in", description: "d", evidence_lids: [targetLid] }],
  });

  it("bridges the nodes at a formula LID and its cross-window context link", () => {
    const result = buildLongRangeCandidates({
      graphNodes: [concept("concept:formula_x", ["2.1"]), concept("concept:applied", ["4.1"])],
      lidToWindowIndex: idx,
      formulaSemantics: [formula("2.1", "4.1")],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      candidate_id: "cand:concept:formula_x->concept:applied",
      source_lids: ["2.1"],
      target_lids: ["4.1"],
      relation_hints: ["applies", "builds_on"],
    });
    expect(result[0].seed_reasons).toContain("signal3_formula_bridge:2.1");
    expect(result[0].seed_score).toBeCloseTo(0.7);
  });

  it("does not bridge when the formula link stays inside one window", () => {
    const sameWindowIdx = buildLidToWindowIndex([{ leafLids: ["2.1", "2.2"] }]);
    const result = buildLongRangeCandidates({
      graphNodes: [concept("concept:formula_x", ["2.1"]), concept("concept:applied", ["2.2"])],
      lidToWindowIndex: sameWindowIdx,
      formulaSemantics: [formula("2.1", "2.2")],
    });

    expect(result).toEqual([]);
  });
});

describe("PB3-3 PB3 gate", () => {
  const leaf = (lid: string): LidNode => ({ lid, path: lid.split(".").map(Number), kind: "paragraph", span: { start: 0, end: 1 }, children: [] });
  const gateNodes = [concept("entity:a", []), concept("entity:b", [])];
  const gateLids = [leaf("1.1"), leaf("3.1")];
  const idx = buildLidToWindowIndex([{ leafLids: ["1.1"] }, { leafLids: ["2.1"] }, { leafLids: ["3.1"] }]);

  const baseEdge = (over: Partial<TechnicalLearningAcceptedEdge> = {}): TechnicalLearningAcceptedEdge => ({
    candidate_id: "c1",
    source: "entity:a",
    target: "entity:b",
    type: "builds_on",
    direction: "directed",
    scope: "long_range",
    weight: 0.8,
    source_evidence_lids: ["1.1"],
    target_evidence_lids: ["3.1"],
    evidence_lids: ["1.1", "3.1"],
    support_level: "explicit",
    rationale: "r",
    ...over,
  });

  it("lowers a valid accepted edge and routes pending/rejected to audit only", () => {
    const result = gatePass2BuildOutput(
      {
        accepted_edges: [baseEdge()],
        pending_edges: [baseEdge({ candidate_id: "p1", support_level: "weak_inference" })],
        rejected_candidates: [{ candidate_id: "r1", reason: "topical_overlap_only" }],
      },
      header,
      gateNodes,
      gateLids,
      idx,
    );

    expect(result.edges).toEqual([
      { source: "entity:a", target: "entity:b", type: "builds_on", direction: "directed", scope: "long_range", weight: 0.8 },
    ]);
    expect(result.audit.accepted).toHaveLength(1);
    expect(result.audit.accepted[0]).toMatchObject({
      candidate_id: "c1",
      source_evidence_lids: ["1.1"],
      target_evidence_lids: ["3.1"],
      support_level: "explicit",
    });
    expect(result.audit.pending.map((p) => p.candidate_id)).toEqual(["p1"]);
    expect(result.audit.rejected).toEqual([{ candidate_id: "r1", reason: "topical_overlap_only" }]);
    expect(result.audit.gate_dropped).toEqual([]);
  });

  it("hard-drops accepted edges that violate the gate, with the right reason", () => {
    const cases: Array<[Partial<TechnicalLearningAcceptedEdge>, Pass2GateDropReason]> = [
      [{ type: "related_to" as TechnicalLearningLongRangeEdgeType }, "invalid_type"],
      [{ scope: "local" as "long_range" }, "invalid_scope"],
      [{ source: "entity:ghost" }, "missing_source"],
      [{ target: "entity:ghost" }, "missing_target"],
      [{ source_evidence_lids: [] }, "empty_source_evidence"],
      [{ target_evidence_lids: [] }, "empty_target_evidence"],
      [{ evidence_lids: ["1.1"] }, "evidence_not_covering"],
      [{ evidence_lids: ["1.1", "3.1", "9.9"] }, "dangling_evidence"],
      [{ support_level: "weak_inference" }, "weak_inference"],
      [{ weight: 0.3 }, "below_weight_threshold"],
      [{ source_evidence_lids: ["1.1"], target_evidence_lids: ["1.1"], evidence_lids: ["1.1"] }, "not_cross_window"],
    ];

    for (const [over, reason] of cases) {
      const result = gatePass2BuildOutput(
        { accepted_edges: [baseEdge(over)], pending_edges: [], rejected_candidates: [] },
        header,
        gateNodes,
        gateLids,
        idx,
      );
      expect(result.edges).toEqual([]);
      expect(result.audit.gate_dropped).toEqual([{ candidate_id: "c1", reason }]);
    }
  });
});
