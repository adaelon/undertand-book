import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PdfTextGeometry } from "../src/pdf-geometry";
import {
  reconcilePaperSource,
  sourceReconciliationTrusted,
  writeSourceReconciliationArtifacts,
} from "../src/source-reconciliation";
import { SourceReconciliationReportZ } from "../src/zod";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-reconcile-"));
}

function geometryFromLines(lines: string[]): PdfTextGeometry {
  return {
    pages: [
      {
        pageIndex: 0,
        width: 300,
        height: 200,
        rotate: 0,
        view: [0, 0, 300, 200],
        chars: [],
        words: [],
        lines: lines.map((text, lineIndex) => ({
          pageIndex: 0,
          lineIndex,
          text,
          char_start: 0,
          char_end: text.length,
          bbox: [72, 120 - lineIndex * 14, 180, 132 - lineIndex * 14],
        })),
      },
    ],
  };
}

function fingerprint() {
  return {
    paper_md_sha256: "sha-md",
    paper_pdf_sha256: "sha-pdf",
    config_hash: "cfg",
  };
}

describe("PH3 source reconciliation engine", () => {
  it("trusts exact matches and safe hyphen line unwrap repairs", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "# Title\n\nhyphen-\nated method\n",
      pdf_geometry: geometryFromLines(["Title", "hyphenated method"]),
      input_fingerprint: fingerprint(),
    });

    expect(SourceReconciliationReportZ.parse(result.report)).toEqual(result.report);
    expect(result.report.summary.verified).toBe(1);
    expect(result.report.summary.auto_repaired).toBe(1);
    expect(result.report.unresolved).toEqual([]);
    expect(result.reconciled_source).toContain("hyphenated method");
    expect(sourceReconciliationTrusted(result.report)).toBe(true);
  });

  it("keeps content-bearing fuzzy matches in needs_review", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The measured value is 42 mg.\n",
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
    });

    expect(SourceReconciliationReportZ.parse(result.report)).toEqual(result.report);
    expect(result.report.summary.needs_review).toBe(1);
    expect(result.report.unresolved[0]).toMatchObject({
      id: "block-1",
      status: "needs_review",
    });
    expect(result.reconciled_source).toBeUndefined();
    expect(sourceReconciliationTrusted(result.report)).toBe(false);
  });

  it("writes trusted source only when reconciliation has no unresolved blocks", () => {
    const trusted = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "Trusted text.\n",
      pdf_geometry: geometryFromLines(["Trusted text."]),
      input_fingerprint: fingerprint(),
    });
    const trustedDir = tempDir();
    const trustedArtifacts = writeSourceReconciliationArtifacts(trustedDir, trusted);

    expect(existsSync(trustedArtifacts.report_path)).toBe(true);
    expect(existsSync(trustedArtifacts.review_draft_path)).toBe(true);
    expect(existsSync(trustedArtifacts.review_decisions_path)).toBe(true);
    expect(trustedArtifacts.source_path).toBeDefined();
    expect(readFileSync(trustedArtifacts.source_path!, "utf8")).toBe("Trusted text.\n");

    const blocked = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The measured value is 42 mg.\n",
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
    });
    const blockedDir = tempDir();
    const blockedArtifacts = writeSourceReconciliationArtifacts(blockedDir, blocked);

    expect(existsSync(blockedArtifacts.report_path)).toBe(true);
    expect(existsSync(blockedArtifacts.review_draft_path)).toBe(true);
    expect(existsSync(blockedArtifacts.review_decisions_path)).toBe(true);
    expect(blockedArtifacts.source_path).toBeUndefined();
    expect(existsSync(path.join(blockedDir, ".build", "source-reconciliation", "source.txt"))).toBe(false);
  });
});
