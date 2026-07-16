import { describe, expect, it } from "vitest";
import type { ReadOnlyBase } from "../src/generated/ReadOnlyBase";
import type { Pass2AuditEdge } from "../src/pass2-build";
import { buildPaperSemanticGraphRecovery } from "../src/paper-semantic-graph-recovery";

function foundation(): ReadOnlyBase {
  return {
    book_id: "paper-a",
    lid_nodes: [
      { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 20 }, children: ["1.1"] },
      { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 1, end: 20 }, children: [] },
    ],
    graph_nodes: [],
    graph_edges: [],
  };
}

function candidate(): ReadOnlyBase {
  return {
    ...foundation(),
    lid_nodes: foundation().lid_nodes.map((node) => ({
      ...node,
      span: { start: node.span.start + 1, end: node.span.end + 1 },
    })),
    graph_nodes: [
      { id: "concept:alpha", type: "concept", name: "Alpha", occurrences: ["1.1"], source_lid: null },
      { id: "claim:1.1:result", type: "claim", name: "Result", occurrences: [], source_lid: "1.1" },
    ],
    graph_edges: [{
      source: "concept:alpha",
      target: "claim:1.1:result",
      type: "summarizes",
      direction: "directed",
      scope: "long_range",
      weight: 0.9,
    }],
  };
}

function acceptedEdge(): Pass2AuditEdge {
  return {
    candidate_id: "candidate:alpha-result",
    source: "concept:alpha",
    target: "claim:1.1:result",
    type: "summarizes",
    source_evidence_lids: ["1.1"],
    target_evidence_lids: ["1.1"],
    evidence_lids: ["1.1"],
    support_level: "explicit",
    rationale: "The source explicitly summarizes the result.",
  };
}

describe("paper semantic graph recovery", () => {
  it("adopts a validated graph while preserving the official foundation", () => {
    const official = foundation();
    const recovered = buildPaperSemanticGraphRecovery(official, candidate(), { accepted: [acceptedEdge()] });

    expect(recovered.base.lid_nodes).toEqual(official.lid_nodes);
    expect(recovered.graph_nodes).toBe(2);
    expect(recovered.graph_edges).toBe(1);
    expect(recovered.long_range_edges).toBe(1);
    expect(recovered.accepted_edges).toBe(1);
  });

  it("rejects a different LID identity or a dangling graph anchor", () => {
    const changedIdentity = candidate();
    changedIdentity.lid_nodes[1] = { ...changedIdentity.lid_nodes[1], lid: "1.2", path: [1, 2] };
    expect(() => buildPaperSemanticGraphRecovery(foundation(), changedIdentity, { accepted: [acceptedEdge()] }))
      .toThrow(/LID identity/i);

    const danglingAnchor = candidate();
    danglingAnchor.graph_nodes[0] = { ...danglingAnchor.graph_nodes[0], occurrences: ["9.9"] };
    expect(() => buildPaperSemanticGraphRecovery(foundation(), danglingAnchor, { accepted: [acceptedEdge()] }))
      .toThrow(/graph anchor/i);
  });

  it("rejects audit evidence or accepted relations that do not match the recovered graph", () => {
    const danglingEvidence = acceptedEdge();
    danglingEvidence.source_evidence_lids = ["9.9"];
    expect(() => buildPaperSemanticGraphRecovery(foundation(), candidate(), { accepted: [danglingEvidence] }))
      .toThrow(/evidence LID/i);

    const mismatchedRelation = acceptedEdge();
    mismatchedRelation.type = "supports";
    expect(() => buildPaperSemanticGraphRecovery(foundation(), candidate(), { accepted: [mismatchedRelation] }))
      .toThrow(/do not match/i);
  });
});
