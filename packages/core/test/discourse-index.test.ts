import { describe, expect, it } from "vitest";
import { TechnicalLearningDiscourseIndexZ } from "../src/zod";
import { buildTechnicalLearningDiscourseIndex } from "../src/discourse-index";
import type { TechnicalLearningDiscourseItem } from "../src/discourse-index";
import type { LidNode } from "../src/generated/LidNode";

const nodes: LidNode[] = [
  { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 40 }, children: ["1.1", "1.2", "1.3"] },
  { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 0, end: 10 }, children: [] },
  { lid: "1.2", path: [1, 2], kind: "paragraph", span: { start: 11, end: 20 }, children: [] },
  { lid: "1.3", path: [1, 3], kind: "paragraph", span: { start: 21, end: 40 }, children: [] },
];

const header = {
  book_id: "book-a",
  book_version: "v1",
  profile_id: "technical_learning" as const,
  profile_version: "technical_learning_v0",
  core_schema_version: "core_v0",
  generated_at: "2026-06-26T00:00:00.000Z",
};

function validItem(): TechnicalLearningDiscourseItem {
  return {
    lid: "1.1",
    mode: "informative",
    local_function: "definition",
    rhetorical_move: "main_point",
    local_summary: "Defines the main concept.",
    relations: [
      {
        target_lid: "1.2",
        type: "elaborates",
        family: "expansion",
        direction: "forward",
        confidence: 0.8,
        evidence_lids: ["1.1", "1.2"],
      },
    ],
  };
}

describe("PB2 TechnicalLearningDiscourseIndex gate", () => {
  it("materializes a headered discourse sidecar", () => {
    const result = buildTechnicalLearningDiscourseIndex(header, [validItem()], nodes);

    TechnicalLearningDiscourseIndexZ.parse(result.sidecar);
    expect(result.dropped).toEqual([]);
    expect(result.sidecar.header).toEqual(header);
    expect(result.sidecar.items[0].relations[0].target_lid).toBe("1.2");
  });

  it("drops invalid relations without judging label semantics", () => {
    const item = validItem();
    item.relations = [
      ...item.relations,
      { ...item.relations[0], target_lid: "9.9" },
      { ...item.relations[0], evidence_lids: [] },
      { ...item.relations[0], confidence: 1.5 },
      { ...item.relations[0], type: "not_a_relation" as never },
    ];

    const result = buildTechnicalLearningDiscourseIndex(header, [item], nodes);

    expect(result.sidecar.items[0].relations).toHaveLength(1);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "missing_target",
      "empty_evidence",
      "invalid_confidence",
      "invalid_relation_type",
    ]);
  });

  it("drops invalid items", () => {
    const missingLid = { ...validItem(), lid: "9.9" };
    const invalidMode = { ...validItem(), mode: "narrative" as never };

    const result = buildTechnicalLearningDiscourseIndex(header, [missingLid, invalidMode], nodes);

    expect(result.sidecar.items).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["missing_lid", "invalid_mode"]);
  });
});

describe("PB2b gate 收紧", () => {
  it("drops low-confidence relations below the threshold", () => {
    const item = validItem();
    item.relations = [{ ...item.relations[0], confidence: 0.3 }];

    const result = buildTechnicalLearningDiscourseIndex(header, [item], nodes);

    expect(result.sidecar.items[0].relations).toHaveLength(0);
    expect(result.dropped.map((d) => d.reason)).toEqual(["low_confidence"]);
  });

  it("requires evidence_lids to contain both the source and target LID", () => {
    const item = validItem();
    item.relations = [
      { ...item.relations[0], evidence_lids: ["1.2"] }, // missing source 1.1
      { ...item.relations[0], evidence_lids: ["1.1"] }, // missing target 1.2
    ];

    const result = buildTechnicalLearningDiscourseIndex(header, [item], nodes);

    expect(result.sidecar.items[0].relations).toHaveLength(0);
    expect(result.dropped.map((d) => d.reason)).toEqual(["evidence_missing_source", "evidence_missing_target"]);
  });

  it("drops the whole item when local_summary exceeds the length cap", () => {
    const item = { ...validItem(), local_summary: "x".repeat(201) };

    const result = buildTechnicalLearningDiscourseIndex(header, [item], nodes);

    expect(result.sidecar.items).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["summary_too_long"]);
  });

  it("keeps a relation whose evidence covers source and target", () => {
    const result = buildTechnicalLearningDiscourseIndex(header, [validItem()], nodes);

    expect(result.dropped).toEqual([]);
    expect(result.sidecar.items[0].relations).toHaveLength(1);
  });
});
