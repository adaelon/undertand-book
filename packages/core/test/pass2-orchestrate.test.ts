import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/generated/GraphNode";
import type { LidNode } from "../src/generated/LidNode";
import type { FormulaSemantics } from "../src/generated/FormulaSemantics";
import type { TechnicalLearningDiscourseIndex } from "../src/discourse-index";
import type { Window } from "../src/window";
import { buildPass2Artifact, buildPass2Candidates, buildPass2WorkPacket, computePass2Status, pass2PacketHash } from "../src/pass2-orchestrate";

const header = {
  book_id: "book-a",
  book_version: "v1",
  profile_id: "technical_learning" as const,
  profile_version: "technical_learning_v0",
  core_schema_version: "core_v0",
  generated_at: "2026-06-30T00:00:00.000Z",
};

const leaf = (lid: string, start: number, end: number): LidNode => ({
  lid,
  path: lid.split(".").map(Number),
  kind: "paragraph",
  span: { start, end },
  children: [],
});

const windowOf = (id: number, leafLids: string[]): Window => ({ id, leafLids, tokens: 1, spans: [], overBudget: false });

const concept = (id: string, occurrences: string[]): GraphNode => ({ id, type: "concept", name: id, occurrences, source_lid: null });

const formula = (formula_lid: string, target_lid: string): FormulaSemantics => ({
  formula_lid,
  parameters: [],
  composition: { source_lid: formula_lid, meaning: "formula meaning", terms: [], evidence_lids: [formula_lid] },
  context_links: [{ target_lid, relation: "explained_by", description: "d", evidence_lids: [formula_lid, target_lid] }],
});

describe("Pass2 orchestration helpers", () => {
  it("builds a source-window packet from closed sidecars and deterministic candidates", () => {
    const source = "AAAABBBBCCCC";
    const lidNodes = [leaf("1.1", 0, 4), leaf("2.1", 4, 8), leaf("3.1", 8, 12)];
    const byLid = new Map(lidNodes.map((n) => [n.lid, n]));
    const windows = [windowOf(0, ["1.1"]), windowOf(1, ["2.1"]), windowOf(2, ["3.1"])] as Window[];
    const graphNodes = [concept("concept:a", ["1.1", "3.1"]), concept("concept:b", ["3.1"]), concept("concept:f", ["2.1"])] as GraphNode[];
    const discourseIndex: TechnicalLearningDiscourseIndex = {
      header,
      items: [
        { lid: "1.1", mode: "informative", local_function: "definition", relations: [] },
        { lid: "3.1", mode: "informative", local_function: "example", relations: [] },
      ],
    };
    const formulaSemantics = [formula("2.1", "3.1")];
    const candidateIndex = buildPass2Candidates({ graphNodes, windows, discourseIndex, formulaSemantics });

    const packet = buildPass2WorkPacket({
      window: windows[0],
      byLid,
      source,
      graphNodes,
      candidates: candidateIndex.candidates,
      discourseIndex,
      formulaSemantics,
    });

    expect(packet.packet_id).toBe("pass2-window:0");
    expect(packet.source_window.text).toEqual([{ lid: "1.1", text: "AAAA" }]);
    expect(packet.source_nodes.map((n) => n.id)).toEqual(["concept:a"]);
    expect(packet.source_discourse.map((d) => d.lid)).toEqual(["1.1"]);
    expect(packet.source_formula_semantics).toEqual([]);
    expect(packet.candidate_targets.map((c) => c.candidate_id)).toContain("cand:concept:a->concept:b");
  });

  it("hashes packet-shaped artifacts and skips windows without candidates", () => {
    const source = "AAAABBBB";
    const lidNodes = [leaf("1.1", 0, 4), leaf("2.1", 4, 8)];
    const byLid = new Map(lidNodes.map((n) => [n.lid, n]));
    const windows = [windowOf(0, ["1.1"]), windowOf(1, ["2.1"])] as Window[];
    const graphNodes = [concept("concept:a", ["1.1", "2.1"]), concept("concept:b", ["2.1"])] as GraphNode[];
    const candidates = buildPass2Candidates({ graphNodes, windows }).candidates;
    const packet0 = buildPass2WorkPacket({ window: windows[0], byLid, source, graphNodes, candidates });
    const packet1 = buildPass2WorkPacket({ window: windows[1], byLid, source, graphNodes, candidates });
    const output = { accepted_edges: [], pending_edges: [], rejected_candidates: [] };
    const artifact = buildPass2Artifact(packet0, output);

    expect(artifact.content_hash).toBe(pass2PacketHash(packet0));
    expect(computePass2Status(new Map([[0, packet0], [1, packet1]]), new Map([[0, artifact]]))).toEqual({
      done: [0],
      pending: [],
      skipped: [1],
    });
    expect(computePass2Status(new Map([[0, packet0]]), new Map([[0, { content_hash: "stale" }]]))).toEqual({
      done: [],
      pending: [0],
      skipped: [],
    });
  });
});


