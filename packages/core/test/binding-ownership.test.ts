import { describe, expect, it } from "vitest";
import { resolvePdfBindingOwnership } from "../src/binding-ownership";
import type { HybridChildProjection } from "../src/hybrid-alignment-v2";

function projection(
  lid: string,
  precision: "char_exact" | "partial",
  sourceStart: number,
): HybridChildProjection {
  return {
    lid,
    source_span: { start: sourceStart, end: sourceStart + 1 },
    precision,
    regions: [{ region_id: `${lid}-region`, pageIndex: 0, bbox: [10, 20, 30, 40] }],
    exact_source_spans: [{ start: sourceStart, end: sourceStart + 1 }],
    selection_assignments: [{
      pageIndex: 0,
      char_index: 7,
      text: "x",
      rect: { pageIndex: 0, bbox: [10, 20, 30, 40] },
      source_span: { start: sourceStart, end: sourceStart + 1 },
    }],
    primary_region: { region_id: `${lid}-region`, pageIndex: 0, bbox: [10, 20, 30, 40] },
    alignment: { unit_id: `${lid}-unit`, reason: `${precision} test candidate` },
  };
}

describe("PR18 PDF binding ownership", () => {
  it("gives a shared glyph to the complete child owner and audits the rejected partial candidate", () => {
    const complete = projection("complete", "char_exact", 10);
    complete.regions[0].bbox = [12, 20, 22, 30];
    complete.primary_region = complete.regions[0];
    const partial = projection("partial", "partial", 20);
    const result = resolvePdfBindingOwnership([
      { kind: "text", source_order: 0, projection: partial },
      { kind: "text", source_order: 1, projection: complete },
    ]);

    expect(result.diagnostics).toMatchObject({
      competing_region_binding_count: 0,
      competing_selection_binding_count: 1,
      resolved_duplicate_region_binding_count: 0,
      resolved_duplicate_selection_binding_count: 0,
      unique_owner_group_count: 1,
      ambiguous_group_count: 0,
    });
    expect(result.projections.find((candidate) => candidate.lid === "complete")?.precision).toBe("char_exact");
    expect(result.projections.find((candidate) => candidate.lid === "partial")).toMatchObject({
      precision: "unmapped",
      regions: [],
      exact_source_spans: [],
      selection_assignments: [],
      alignment: { reason: "binding_rejected: complete glyph owner excludes partial candidate" },
      binding_rejections: [{
        candidate_id: "projection:partial",
        competitor_ids: ["projection:complete"],
        constraint: "complete_glyph_ownership",
        resource_keys: ["selection:0:7"],
      }],
    });
  });

  it("fails an equal-evidence ownership group closed without using source or LID order", () => {
    const result = resolvePdfBindingOwnership([
      { kind: "text", source_order: 0, projection: projection("first", "char_exact", 0) },
      { kind: "text", source_order: 1, projection: projection("second", "char_exact", 2) },
    ]);

    expect(result.diagnostics).toMatchObject({
      unique_owner_group_count: 0,
      ambiguous_group_count: 1,
      resolved_duplicate_region_binding_count: 0,
      resolved_duplicate_selection_binding_count: 0,
    });
    expect(result.projections.every((candidate) => (
      candidate.precision === "unmapped"
      && candidate.alignment.reason === "ambiguous_binding: multiple equal non-overlapping ownership solutions"
      && candidate.binding_rejections?.length === 1
      && candidate.binding_rejections[0].constraint === "multiple_equal_ownership_solutions"
    ))).toBe(true);
    expect(result.decisions[0]).toMatchObject({
      status: "ambiguous_binding",
      candidate_lids: ["first", "second"],
      accepted_lids: [],
    });
  });

  it("does not let a complete prose owner take a conflicting code-role candidate", () => {
    const completeText = projection("complete-text", "char_exact", 10);
    completeText.regions[0].bbox = [12, 20, 22, 30];
    completeText.primary_region = completeText.regions[0];
    const result = resolvePdfBindingOwnership([
      { kind: "code", source_order: 0, projection: projection("partial-code", "partial", 0) },
      { kind: "text", source_order: 1, projection: completeText },
    ]);

    expect(result.diagnostics).toMatchObject({
      unique_owner_group_count: 0,
      ambiguous_group_count: 1,
    });
    expect(result.projections.every((candidate) => (
      candidate.precision === "unmapped"
      && candidate.alignment.reason.startsWith("ambiguous_binding:")
    ))).toBe(true);
  });
});
