import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMarkdownStructureAuditCli } from "../scripts/run-markdown-structure-audit";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";

const REAL_BOOK_REPORT_PATH = fileURLToPath(new URL(
  "fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer-structure-audit.json",
  import.meta.url,
));

describe("PR9 markdown structure audit", () => {
  it("requires explicit source and baseline paths", () => {
    expect(() => runMarkdownStructureAuditCli([])).toThrow("--source requires an explicit path");
    expect(() => runMarkdownStructureAuditCli(["--source", "source.txt"]))
      .toThrow("--baseline-base requires an explicit path");
  });

  it("writes a deterministic source-position-only structure difference report", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-markdown-audit-"));
    try {
      const source = [
        "# Title",
        "",
        "Before $x$ after.",
        "",
        "import random",
        "value = random.random()",
        "return value",
      ].join("\n");
      const sourcePath = path.join(root, "source.txt");
      const basePath = path.join(root, "base.json");
      const firstPath = path.join(root, "first.json");
      const secondPath = path.join(root, "second.json");
      writeFileSync(sourcePath, source, "utf8");
      writeFileSync(basePath, JSON.stringify({
        book_id: "structure-audit",
        lid_nodes: segment(markdownToBlocks(source)),
        graph_nodes: [],
        graph_edges: [],
      }), "utf8");

      const first = runMarkdownStructureAuditCli([
        "--source", sourcePath,
        "--baseline-base", basePath,
        "--output", firstPath,
      ]);
      const second = runMarkdownStructureAuditCli([
        "--source", sourcePath,
        "--baseline-base", basePath,
        "--output", secondPath,
      ]);

      expect(first).toEqual(second);
      expect(readFileSync(firstPath, "utf8")).toBe(readFileSync(secondPath, "utf8"));
      expect(first).toMatchObject({
        version: "markdown_structure_audit.v1",
        partition: { ok: true, coverage: 1, violations: [] },
        differences: {
          kind_changes: [],
          lid_changes: [],
          removed_baseline_leaves: [],
          added_candidate_leaves: [],
        },
      });
      expect(first.parser.review_proposals).toEqual([
        expect.objectContaining({ kind: "unfenced_code" }),
      ]);
      expect(JSON.stringify(first)).not.toContain("Before $x$ after");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes the real-book PR10 review and LID migration input without source text", () => {
    const report = JSON.parse(readFileSync(REAL_BOOK_REPORT_PATH, "utf8"));

    expect(report).toMatchObject({
      version: "markdown_structure_audit.v1",
      source_sha256: "cb108cabb5198cf07820b5eb49e6d3094fdf870ae20b130c93539b721ed653c9",
      partition: { ok: true, coverage: 1, violations: [] },
      baseline: { leaf_count: 2075 },
      candidate: {
        leaf_count: 1983,
        leaf_kind_counts: { code: 2, formula: 824, image: 19, paragraph: 1136, table: 2 },
      },
      differences: { exact_span_match_count: 1977 },
    });
    expect(report.parser.review_proposals).toHaveLength(10);
    expect(report.parser.review_proposals.filter((proposal: { kind: string }) => proposal.kind === "unfenced_code"))
      .toHaveLength(9);
    expect(report.differences.lid_changes).toHaveLength(463);
    expect(report.differences.removed_baseline_leaves).toHaveLength(98);
    expect(report.differences.added_candidate_leaves).toHaveLength(6);
    expect(JSON.stringify(report)).not.toContain('"text"');
  });
});
