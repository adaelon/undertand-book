import { describe, expect, it } from "vitest";
import {
  buildBookStructureSidecar,
  buildBookStructureStitchArtifact,
  buildBookStructureStitchPacket,
  buildBookStructureUnitArtifact,
  buildBookStructureUnitSources,
  computeBookStructureStatus,
  type BookStructureCandidate,
} from "../src/book-structure";
import { BookStructureSidecarZ } from "../src/zod";
import type { LidNode } from "../src/generated/LidNode";

const nodes: LidNode[] = [
  { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 100 }, children: ["1.1", "1.2"] },
  { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 0, end: 20 }, children: [] },
  { lid: "1.2", path: [1, 2], kind: "formula", span: { start: 21, end: 40 }, children: [] },
  { lid: "2", path: [2], kind: "chapter", span: { start: 101, end: 200 }, children: ["2.1"] },
  { lid: "2.1", path: [2, 1], kind: "paragraph", span: { start: 101, end: 140 }, children: [] },
];

const header = {
  book_id: "book-a",
  book_version: "v1",
  profile_id: "technical_learning" as const,
  profile_version: "technical_learning_v0",
  core_schema_version: "core_v0",
  generated_at: "2026-07-04T00:00:00.000Z",
};

function validCandidate(): BookStructureCandidate {
  return {
    key_stops: [
      {
        id: "ks:def-risk",
        lid: "1.1",
        type: "definition",
        title: "Risk definition",
        reason: { text: "Defines the central risk term.", evidence_lids: ["1.1"] },
      },
      {
        id: "ks:formula",
        lid: "1.2",
        type: "formula",
        reason: { text: "Introduces the core formula.", evidence_lids: ["1.2"] },
      },
    ],
    spine: [
      {
        lid: "1",
        role: "foundation",
        summary: { text: "Establishes the foundation.", evidence_lids: ["1.1"] },
        key_stop_ids: ["ks:def-risk", "ks:formula"],
        depends_on: [],
      },
      {
        lid: "2",
        role: "application",
        summary: { text: "Applies the foundation.", evidence_lids: ["2.1"] },
        key_stop_ids: [],
        depends_on: ["1"],
      },
    ],
    throughlines: [
      {
        id: "thread:risk",
        name: "Risk quantification",
        summary: { text: "Tracks risk from definition to application.", evidence_lids: ["1.1", "2.1"] },
        lids: ["1.1", "2.1"],
        key_stop_ids: ["ks:def-risk"],
      },
    ],
  };
}

describe("PB7 BookStructure gate", () => {
  it("materializes a headered BookStructure sidecar", () => {
    const result = buildBookStructureSidecar(header, validCandidate(), nodes);

    BookStructureSidecarZ.parse(result.sidecar);
    expect(result.dropped).toEqual([]);
    expect(result.sidecar.header).toEqual(header);
    expect(result.sidecar.spine.map((unit) => unit.lid)).toEqual(["1", "2"]);
    expect(result.sidecar.throughlines[0].key_stop_ids).toEqual(["ks:def-risk"]);
  });

  it("drops invalid items and filters dangling references", () => {
    const candidate = validCandidate();
    candidate.key_stops = [
      ...candidate.key_stops!,
      { id: "ks:bad-lid", lid: "9.9", type: "claim", reason: { text: "Missing LID.", evidence_lids: ["9.9"] } },
      { id: "ks:bad-type", lid: "1.1", type: "not_a_type" as never, reason: { text: "Bad type.", evidence_lids: ["1.1"] } },
    ];
    candidate.spine = [
      ...candidate.spine!,
      {
        lid: "3",
        role: "setup",
        summary: { text: "Missing unit.", evidence_lids: ["3"] },
        key_stop_ids: [],
        depends_on: [],
      },
      {
        lid: "1",
        role: "not_a_role" as never,
        summary: { text: "Bad role.", evidence_lids: ["1.1"] },
        key_stop_ids: [],
        depends_on: [],
      },
      {
        lid: "2",
        role: "application",
        summary: { text: "Has dangling refs.", evidence_lids: ["2.1"] },
        key_stop_ids: ["ks:missing"],
        depends_on: ["9.9"],
      },
    ];

    const result = buildBookStructureSidecar(header, candidate, nodes);

    BookStructureSidecarZ.parse(result.sidecar);
    expect(result.sidecar.key_stops.map((stop) => stop.id)).toEqual(["ks:def-risk", "ks:formula"]);
    expect(result.sidecar.spine.at(-1)).toMatchObject({ lid: "2", key_stop_ids: [], depends_on: [] });
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "missing_lid",
      "invalid_key_stop_type",
      "missing_lid",
      "invalid_role",
      "dangling_reference",
      "dangling_reference",
    ]);
  });

  it("requires anchored text evidence", () => {
    const candidate = validCandidate();
    candidate.throughlines = [
      {
        id: "thread:bad",
        name: "Bad thread",
        summary: { text: "No evidence.", evidence_lids: [] },
        lids: ["1.1"],
        key_stop_ids: [],
      },
    ];

    const result = buildBookStructureSidecar(header, candidate, nodes);

    expect(result.sidecar.throughlines).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["empty_evidence"]);
  });
});

describe("PB7 BookStructure build helpers", () => {
  it("builds chapter/section unit inputs from public book artifacts", () => {
    const source = "Chapter one text.\nFormula text.\nChapter two text.";
    const sources = buildBookStructureUnitSources({
      lidNodes: nodes,
      source,
      graphNodes: [
        { id: "concept:risk", type: "concept", name: "Risk", occurrences: ["1.1"], source_lid: null },
        { id: "claim:later", type: "claim", name: "Later claim", occurrences: [], source_lid: "2.1" },
      ],
      graphEdges: [{ source: "concept:risk", target: "claim:later", type: "builds_on", direction: "directed", scope: "long_range", weight: 0.8 }],
      discourseIndex: {
        header,
        items: [
          { lid: "1.1", mode: "informative", local_function: "definition", relations: [] },
          { lid: "2.1", mode: "informative", local_function: "application", relations: [] },
        ],
      },
      formulaSemantics: [
        {
          formula_lid: "1.2",
          parameters: [],
          composition: { source_lid: "1.2", meaning: "Formula meaning.", terms: [], evidence_lids: ["1.2"] },
          context_links: [],
        },
      ],
      pass2Audit: {
        header,
        accepted: [
          {
            candidate_id: "cand:concept:risk->claim:later",
            source: "concept:risk",
            target: "claim:later",
            type: "builds_on",
            source_evidence_lids: ["1.1"],
            target_evidence_lids: ["2.1"],
            evidence_lids: ["1.1", "2.1"],
            support_level: "strong_inference",
            rationale: "Risk supports the later claim.",
          },
        ],
        pending: [],
        rejected: [],
        gate_dropped: [],
      },
    });

    expect(sources.map((source) => source.job_id)).toEqual(["unit:1", "unit:2"]);
    expect(sources[0]).toMatchObject({
      unit_lid: "1",
      leaf_lids: ["1.1", "1.2"],
    });
    expect(sources[0].graph_nodes.map((node) => node.id)).toEqual(["concept:risk"]);
    expect(sources[0].discourse_items.map((item) => item.lid)).toEqual(["1.1"]);
    expect(sources[0].formula_semantics.map((item) => item.formula_lid)).toEqual(["1.2"]);
    expect(sources[0].pass2_edges.map((edge) => edge.candidate_id)).toEqual(["cand:concept:risk->claim:later"]);
  });

  it("computes unit and stitch status from content hashes", () => {
    const sources = buildBookStructureUnitSources({ lidNodes: nodes, source: "A".repeat(240) });
    const unitArtifact = buildBookStructureUnitArtifact(sources[0], {
      unit_card: {
        unit_lid: "1",
        role: "foundation",
        summary: { text: "Foundation.", evidence_lids: ["1.1"] },
        candidate_key_stops: [],
        depends_on: [],
        evidence_lids: ["1.1"],
      },
    });
    const units = new Map([[sources[0].job_id, { content_hash: unitArtifact.content_hash }]]);

    let status = computeBookStructureStatus(sources, units);
    expect(status.unit_done).toEqual(["unit:1"]);
    expect(status.unit_pending).toEqual(["unit:2"]);
    expect(status.stitch_blocked).toBe(true);

    const secondArtifact = buildBookStructureUnitArtifact(sources[1], {
      unit_card: {
        unit_lid: "2",
        role: "application",
        summary: { text: "Application.", evidence_lids: ["2.1"] },
        candidate_key_stops: [],
        depends_on: ["1"],
        evidence_lids: ["2.1"],
      },
    });
    units.set(sources[1].job_id, { content_hash: secondArtifact.content_hash });
    const packet = buildBookStructureStitchPacket([unitArtifact, secondArtifact]);

    status = computeBookStructureStatus(sources, units, undefined, packet);
    expect(status).toMatchObject({ stitch_blocked: false, stitch_pending: true, stitch_done: false });

    const stitchArtifact = buildBookStructureStitchArtifact(packet, validCandidate());
    status = computeBookStructureStatus(sources, units, { content_hash: stitchArtifact.content_hash }, packet);
    expect(status).toMatchObject({ stitch_blocked: false, stitch_pending: false, stitch_done: true });
  });

  it("rejects a unit card written for the wrong unit", () => {
    const [source] = buildBookStructureUnitSources({ lidNodes: nodes, source: "A".repeat(240) });

    expect(() =>
      buildBookStructureUnitArtifact(source, {
        unit_card: {
          unit_lid: "2",
          role: "foundation",
          summary: { text: "Wrong unit.", evidence_lids: ["1.1"] },
          candidate_key_stops: [],
          depends_on: [],
          evidence_lids: ["1.1"],
        },
      }),
    ).toThrow(/does not match/);
  });

  it("selects the structural frontier instead of overlapping parent and child units", () => {
    const nested: LidNode[] = [
      { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 100 }, children: ["1.1", "1.2"] },
      { lid: "1.1", path: [1, 1], kind: "section", span: { start: 0, end: 40 }, children: ["1.1.1"] },
      { lid: "1.1.1", path: [1, 1, 1], kind: "paragraph", span: { start: 0, end: 20 }, children: [] },
      { lid: "1.2", path: [1, 2], kind: "section", span: { start: 41, end: 100 }, children: ["1.2.1"] },
      { lid: "1.2.1", path: [1, 2, 1], kind: "paragraph", span: { start: 41, end: 80 }, children: [] },
    ];

    const sources = buildBookStructureUnitSources({ lidNodes: nested, source: "A".repeat(120) });

    expect(sources.map((source) => source.job_id)).toEqual(["unit:1.1", "unit:1.2"]);
    expect(sources.map((source) => source.leaf_lids)).toEqual([["1.1.1"], ["1.2.1"]]);
  });
});
