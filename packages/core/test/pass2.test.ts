import { describe, expect, it } from "vitest";
import { gateTechnicalLearningPass2LongRange, type ProfileArtifactHeader, type TechnicalLearningPass2Output } from "../src/pass2";
import type { GraphNode } from "../src/generated/GraphNode";
import type { LidNode } from "../src/generated/LidNode";

const header: ProfileArtifactHeader = {
  book_id: "book-a",
  book_version: "v1",
  profile_id: "technical_learning",
  profile_version: "pass2_longrange_v1",
  core_schema_version: "core_v0",
  generated_at: "2026-06-25T00:00:00Z",
};

const leaf = (lid: string): LidNode => ({
  lid,
  path: lid.split(".").map(Number),
  kind: "paragraph",
  span: { start: 0, end: 1 },
  children: [],
});

const ent = (id: string, name: string, occ: string[]): GraphNode => ({
  id,
  type: "entity",
  name,
  occurrences: occ,
  source_lid: null,
});

const out = (edges: TechnicalLearningPass2Output["edges"]): TechnicalLearningPass2Output => ({ header, edges });

const nodes = [ent("entity:a", "A", ["1.1"]), ent("entity:b", "B", ["2.1"]), ent("entity:c", "C", ["3.1"])];
const lids = [leaf("1.1"), leaf("2.1"), leaf("3.1")];

describe("P1 technical_learning.pass2_longrange_v1 gate", () => {
  it("lowers valid output to GraphEdge(scope=long_range) and audit sidecar", () => {
    const result = gateTechnicalLearningPass2LongRange(
      out([
        {
          source: "entity:a",
          target: "entity:b",
          type: "builds_on",
          direction: "directed",
          scope: "long_range",
          weight: 0.82,
          evidence_lids: ["1.1", "2.1"],
          rationale: "A prepares the definition used by B.",
        },
      ]),
      nodes,
      lids,
    );

    expect(result.dropped).toEqual([]);
    expect(result.edges).toEqual([
      { source: "entity:a", target: "entity:b", type: "builds_on", direction: "directed", scope: "long_range", weight: 0.82 },
    ]);
    expect(result.audit).toEqual({
      header,
      edges: [
        {
          source: "entity:a",
          target: "entity:b",
          type: "builds_on",
          evidence_lids: ["1.1", "2.1"],
          rationale: "A prepares the definition used by B.",
        },
      ],
    });
  });

  it("drops candidates with missing endpoints or dangling evidence", () => {
    const result = gateTechnicalLearningPass2LongRange(
      out([
        { source: "entity:a", target: "entity:ghost", type: "contrasts", direction: "undirected", scope: "long_range", weight: 0.5, evidence_lids: ["1.1"], rationale: "ghost" },
        { source: "entity:a", target: "entity:b", type: "contrasts", direction: "undirected", scope: "long_range", weight: 0.5, evidence_lids: ["9.9"], rationale: "bad evidence" },
        { source: "entity:b", target: "entity:c", type: "contrasts", direction: "undirected", scope: "long_range", weight: 0.5, evidence_lids: [], rationale: "no evidence" },
      ]),
      nodes,
      lids,
    );

    expect(result.edges).toEqual([]);
    expect(result.audit).toEqual({ header, edges: [] });
    expect(result.dropped.map((d) => d.reason)).toEqual(["missing_target", "dangling_evidence", "empty_evidence"]);
    expect(result.dropped[1].evidence_lids).toEqual(["9.9"]);
  });

  it("drops invalid scope or non-profile edge type", () => {
    const result = gateTechnicalLearningPass2LongRange(
      {
        header,
        edges: [
          { source: "entity:a", target: "entity:b", type: "builds_on", direction: "directed", scope: "local", weight: 0.5, evidence_lids: ["1.1"], rationale: "wrong scope" },
          { source: "entity:a", target: "entity:b", type: "related_to", direction: "undirected", scope: "long_range", weight: 0.5, evidence_lids: ["1.1"], rationale: "wrong type" },
        ] as unknown as TechnicalLearningPass2Output["edges"],
      },
      nodes,
      lids,
    );

    expect(result.edges).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["invalid_scope", "invalid_type"]);
  });
});
