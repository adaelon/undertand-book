import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHybridAlignmentUnitAuditCli } from "../scripts/run-hybrid-alignment-unit-audit";
import {
  formHybridAlignmentUnits,
  HYBRID_ALIGNMENT_UNIT_POLICY,
} from "../src/hybrid-alignment-v2";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";

const REAL_AUDIT_PATH = fileURLToPath(new URL(
  "fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer-alignment-unit-audit.json",
  import.meta.url,
));

describe("PR11 bounded hybrid alignment units", () => {
  it("requires an explicit source path for the no-text audit", () => {
    expect(() => runHybridAlignmentUnitAuditCli([])).toThrow("--source requires an explicit path");
  });

  it("groups only inline text/formula siblings and cuts every structural boundary", () => {
    const source = [
      "# Boundary",
      "",
      "Paragraph before $x$ after.",
      "",
      "- item one $y$",
      "- item two",
      "",
      "```python",
      "# code remains code",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "![diagram](asset.png)",
      "",
      "Caption text.",
      "",
      "$$ z $$",
      "",
    ].join("\n");
    const units = formHybridAlignmentUnits(source);

    expect(units.map((unit) => unit.child_lids.map((child) => child.kind))).toEqual([
      ["text"],
      ["text", "formula", "text"],
      ["text", "formula"],
      ["text"],
      ["code"],
      ["table"],
      ["image"],
      ["text"],
      ["formula"],
    ]);
    expect(units.every((unit) => unit.policy_version === HYBRID_ALIGNMENT_UNIT_POLICY.version)).toBe(true);
    expect(units.every((unit) => unit.diagnostic === "within_guard")).toBe(true);
  });

  it("greedily caps multi-child units without losing or duplicating leaves", () => {
    const source = `${Array.from({ length: 32 }, (_, index) => `part${index} $x_${index}$`).join(" ")} tail.\n`;
    const units = formHybridAlignmentUnits(source);
    const expectedLeaves = segment(markdownToBlocks(source)).filter((node) => node.children.length === 0);
    const actualLids = units.flatMap((unit) => unit.child_lids.map((child) => child.lid));

    expect(units.length).toBeGreaterThan(1);
    expect(actualLids).toEqual(expectedLeaves.map((leaf) => leaf.lid));
    expect(new Set(actualLids).size).toBe(actualLids.length);
    for (const unit of units) {
      expect(unit.diagnostic).toBe("within_guard");
      expect(unit.metrics.child_count).toBeLessThanOrEqual(HYBRID_ALIGNMENT_UNIT_POLICY.max_children);
      expect(unit.metrics.source_utf16_length).toBeLessThanOrEqual(HYBRID_ALIGNMENT_UNIT_POLICY.max_source_utf16);
      expect(unit.metrics.searchable_token_count).toBeLessThanOrEqual(HYBRID_ALIGNMENT_UNIT_POLICY.max_searchable_tokens);
    }
  });

  it("cuts the same paragraph at UTF-16 and searchable-token guards", () => {
    const utf16Source = `${"a".repeat(700)} $x$ ${"b".repeat(700)}\n`;
    const tokenSource = `${Array.from({ length: 110 }, (_, index) => `left${index}`).join(" ")} $x$ ${Array.from({ length: 110 }, (_, index) => `right${index}`).join(" ")}\n`;

    const utf16Units = formHybridAlignmentUnits(utf16Source);
    const tokenUnits = formHybridAlignmentUnits(tokenSource);
    expect(utf16Units.length).toBeGreaterThan(1);
    expect(tokenUnits.length).toBeGreaterThan(1);
    expect(utf16Units.every((unit) => unit.metrics.source_utf16_length <= HYBRID_ALIGNMENT_UNIT_POLICY.max_source_utf16)).toBe(true);
    expect(tokenUnits.every((unit) => unit.metrics.searchable_token_count <= HYBRID_ALIGNMENT_UNIT_POLICY.max_searchable_tokens)).toBe(true);
  });

  it("keeps an individually oversized child isolated and diagnosed", () => {
    const source = `${"oversized ".repeat(160)}terminal.\n`;
    const units = formHybridAlignmentUnits(source);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      diagnostic: "oversize_singleton",
      metrics: { child_count: 1 },
    });
    expect(units[0].metrics.source_utf16_length).toBeGreaterThan(HYBRID_ALIGNMENT_UNIT_POLICY.max_source_utf16);
  });

  it("freezes the real approved candidate unit audit without source text", () => {
    const reportText = readFileSync(REAL_AUDIT_PATH, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("d33cdd00e4f3e9edac46f6efa9fe424269e40cf21112da4ec647b58c7b5cbc5a");
    expect(report).toMatchObject({
      version: "hybrid_alignment_unit_audit.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      policy: {
        version: "hybrid_alignment_unit_policy.v1",
        max_children: 24,
        max_source_utf16: 1200,
        max_searchable_tokens: 240,
      },
      summary: {
        unit_count: 625,
        child_count: 1945,
        within_guard_count: 621,
        oversize_singleton_count: 4,
        oversized_multi_child_unit_count: 0,
        boundary_violation_count: 0,
        max_child_count: 24,
        max_source_utf16_length: 1090,
        max_searchable_token_count: 184,
      },
      coverage: {
        expected_leaf_count: 1945,
        mapped_child_count: 1945,
        missing_lids: [],
        duplicate_lids: [],
        unexpected_lids: [],
      },
    });
    expect(report.units).toHaveLength(625);
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });
});
