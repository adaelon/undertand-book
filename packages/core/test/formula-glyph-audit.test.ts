import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFormulaGlyphAuditCli } from "../scripts/run-formula-glyph-audit";

const FIXTURE_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));
const REAL_FORMULA_GLYPH_AUDIT = path.join(
  FIXTURE_ROOT,
  "external-formula-dense-transformer-formula-glyph-audit.json",
);

describe("PR16 structural formula glyph projection", () => {
  it("requires explicit approved source, PDF, descriptor, migration, and reviewed map inputs", async () => {
    await expect(runFormulaGlyphAuditCli([])).rejects.toThrow(/--source requires an explicit path/u);
  });

  it("freezes all approved-source formula glyph outcomes without source text", () => {
    const reportText = readFileSync(REAL_FORMULA_GLYPH_AUDIT, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("5d22207e14cc4203151095bbb0142d9c4b53d3a7a1973d2f96e1383d438a000e");
    expect(report).toMatchObject({
      version: "formula_glyph_audit.v1",
      policy_version: "pdf_formula_glyph_policy.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      summary: {
        formula_count: 830,
        glyph_projected_count: 395,
        glyph_assignment_count: 2785,
        unclassified_count: 0,
        invalid_projected_evidence_count: 0,
        duplicate_formula_assignment_count: 0,
        wrong_page_count: 0,
        wrong_column_count: 0,
        legacy_formula_reason_count: 0,
        mismatch_projected_count: 0,
        classification_counts: {
          downstream_binding_conflict: 53,
          downstream_unit_locator: 278,
          explicit_glyph_mismatch: 52,
          explicit_lane_ambiguity: 51,
          glyph_projected: 395,
          unsupported_source_structure: 1,
        },
        legacy_a006_count: 318,
        legacy_missing_successor_count: 0,
        legacy_unclassified_count: 0,
        legacy_classification_counts: {
          downstream_binding_conflict: 20,
          downstream_unit_locator: 133,
          explicit_glyph_mismatch: 36,
          explicit_lane_ambiguity: 28,
          glyph_projected: 100,
          reviewed_non_formula: 1,
        },
      },
    });
    expect(report.formula_items.every((item: {
      page_matches: boolean | null;
      column_matches: boolean | null;
      projected_evidence_valid: boolean;
    }) => (
      item.page_matches !== false && item.column_matches !== false && item.projected_evidence_valid
    ))).toBe(true);
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });
});
