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

  it("freezes migrated A007 page-column outcomes without source text", () => {
    const reportText = readFileSync(REAL_FORMULA_REGION_AUDIT, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("df0edd211f49da6b0df54bdd8fbb57f75024685f0e0977548c519708600c4bbd");
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
        reviewed_region_with_geometry_count: 58,
        anchor_resolved_count: 22,
        unclassified_count: 0,
        wrong_page_count: 0,
        wrong_column_count: 0,
        legacy_anchor_lack_reason_count: 0,
        geometry_region_selection_assignment_count: 0,
        cross_lane_region_count: 0,
        classification_counts: {
          downstream_formula_glyph: 6,
          downstream_unit_locator: 12,
          existing_display_projection: 9,
          explicit_structural_ambiguity: 21,
          reviewed_non_formula: 1,
          unique_region: 57,
        },
      },
    });
    expect(report.items.every((item: { page_matches: boolean | null; column_matches: boolean | null }) => (
      item.page_matches !== false && item.column_matches !== false
    ))).toBe(true);
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });
});
