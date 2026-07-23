import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFormulaRegionAuditCli } from "../scripts/run-formula-region-audit";

const FIXTURE_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));
const REAL_FORMULA_REGION_AUDIT = path.join(
  FIXTURE_ROOT,
  "external-formula-dense-transformer-formula-region-audit.json",
);

describe("PR15 formula page-column region localization", () => {
  it("requires explicit approved source, PDF, descriptor, migration, and reviewed map inputs", async () => {
    await expect(runFormulaRegionAuditCli([])).rejects.toThrow(/--source requires an explicit path/u);
  });

  it("freezes final migrated A007 page-column outcomes without source text", () => {
    const reportText = readFileSync(REAL_FORMULA_REGION_AUDIT, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("6745cfd046580b395b7590361bc78d8bdc5409e93303a4afa56f545c6a8d5a22");
    expect(report).toMatchObject({
      version: "formula_region_audit.v1",
      policy_version: "pdf_formula_region_policy.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      summary: {
        baseline_count: 106,
        reviewed_region_count: 79,
        anchor_lack_count: 27,
        missing_successor_count: 0,
        missing_reviewed_lane_count: 0,
        reviewed_region_with_geometry_count: 59,
        anchor_resolved_count: 21,
        unclassified_count: 0,
        wrong_page_count: 0,
        wrong_column_count: 0,
        legacy_anchor_lack_reason_count: 0,
        geometry_region_selection_assignment_count: 0,
        cross_lane_region_count: 0,
        classification_counts: {
          downstream_binding_conflict: 7,
          downstream_formula_glyph: 5,
          downstream_unit_locator: 12,
          existing_display_projection: 34,
          explicit_structural_ambiguity: 13,
          glyph_projected: 34,
          reviewed_non_formula: 1,
        },
      },
    });
    expect(report.items.every((item: { page_matches: boolean | null; column_matches: boolean | null }) => (
      item.page_matches !== false && item.column_matches !== false
    ))).toBe(true);
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });
});
