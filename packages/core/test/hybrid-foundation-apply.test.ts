import { describe, expect, it } from "vitest";
import {
  mergeHybridFoundationBase,
  semanticGraphDigest,
} from "../src/hybrid-foundation-apply";
import type { ReadOnlyBase } from "../src/generated/ReadOnlyBase";

function base(): ReadOnlyBase {
  return {
    book_id: "paper-a",
    lid_nodes: [
      { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 20 }, children: ["1.1"] },
      { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 1, end: 20 }, children: [] },
    ],
    graph_nodes: [
      {
        id: "concept:alpha",
        type: "concept",
        name: "Alpha",
        occurrences: ["1.1"],
        source_lid: null,
      },
      {
        id: "claim:1.1:result",
        type: "claim",
        name: "Result",
        occurrences: [],
        source_lid: "1.1",
      },
    ],
    graph_edges: [
      {
        source: "concept:alpha",
        target: "claim:1.1:result",
        type: "supports",
        direction: "directed",
        scope: "local",
        weight: 1,
      },
    ],
  };
}

describe("hybrid foundation semantic graph ownership", () => {
  it("keeps the official semantic graph while adopting same-identity candidate LIDs", () => {
    const official = base();
    const candidate = base();
    candidate.lid_nodes[1] = {
      ...candidate.lid_nodes[1],
      span: { start: 2, end: 21 },
    };
    candidate.graph_nodes = [];
    candidate.graph_edges = [];

    const merged = mergeHybridFoundationBase(official, candidate);

    expect(merged.lid_nodes).toEqual(candidate.lid_nodes);
    expect(merged.graph_nodes).toEqual(official.graph_nodes);
    expect(merged.graph_edges).toEqual(official.graph_edges);
    expect(semanticGraphDigest(merged)).toBe(semanticGraphDigest(official));
  });

  it("rejects a candidate with different LID identity", () => {
    const official = base();
    const candidate = base();
    candidate.lid_nodes[1] = { ...candidate.lid_nodes[1], lid: "1.2", path: [1, 2] };

    expect(() => mergeHybridFoundationBase(official, candidate)).toThrow(/LID identity/i);
  });

  it("rejects dangling graph anchors and edge endpoints before staging", () => {
    const danglingAnchor = base();
    danglingAnchor.graph_nodes[0] = { ...danglingAnchor.graph_nodes[0], occurrences: ["9.9"] };
    expect(() => mergeHybridFoundationBase(danglingAnchor, base())).toThrow(/graph anchor/i);

    const danglingEdge = base();
    danglingEdge.graph_edges[0] = { ...danglingEdge.graph_edges[0], target: "claim:missing" };
    expect(() => mergeHybridFoundationBase(danglingEdge, base())).toThrow(/graph edge endpoint/i);
  });
});
