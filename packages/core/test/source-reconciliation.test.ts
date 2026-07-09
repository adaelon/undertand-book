import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PdfTextGeometry } from "../src/pdf-geometry";
import {
  contentEquivalent,
  reconcilePaperSource,
  reviewCandidateAndReconcile,
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

describe("PH4 review candidate gate", () => {
  it("accepts LLM format repair only when content equivalence is preserved and realignment passes", () => {
    const result = reviewCandidateAndReconcile({
      book_id: "paper-a",
      original_source: "hyphen-\nated method\n",
      candidate_source: "hyphenated method\n",
      pdf_geometry: geometryFromLines(["hyphenated method"]),
      input_fingerprint: fingerprint(),
      kind: "llm_format_repair",
    });

    expect(contentEquivalent("hyphen-\nated method", "hyphenated method")).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.reconciliation?.reconciled_source).toBe("hyphenated method\n");
    expect(result.reconciliation?.report.unresolved).toEqual([]);
  });

  it("rejects LLM candidates that change content before realignment can bless them", () => {
    const result = reviewCandidateAndReconcile({
      book_id: "paper-a",
      original_source: "The measured value is 42 mg.\n",
      candidate_source: "The measured value is 43 mg.\n",
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
      kind: "llm_format_repair",
    });

    expect(contentEquivalent("The measured value is 42 mg.", "The measured value is 43 mg.")).toBe(false);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("content-equivalence");
    expect(result.reconciliation).toBeUndefined();
  });

  it("allows manual reviewed drafts only after they re-enter the same reconciliation gate", () => {
    const result = reviewCandidateAndReconcile({
      book_id: "paper-a",
      original_source: "The measured value is 42 mg.\n",
      candidate_source: "The measured value is 43 mg.\n",
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
      kind: "manual_review",
      decisions: [{ id: "block-1", action: "manual_edit", note: "PDF verified value" }],
    });

    expect(result.accepted).toBe(true);
    expect(result.reconciliation?.report.unresolved).toEqual([]);
    expect(result.reconciliation?.review_decisions.decisions).toEqual([
      { id: "block-1", action: "manual_edit", note: "PDF verified value" },
    ]);
  });

  it("writes reviewed-draft.md separately from trusted source", () => {
    const result = reviewCandidateAndReconcile({
      book_id: "paper-a",
      original_source: "The measured value is 42 mg.\n",
      candidate_source: "The measured value is 43 mg.\n",
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
      kind: "manual_review",
    });
    const dir = tempDir();
    const artifacts = writeSourceReconciliationArtifacts(dir, result.reconciliation!, "The measured value is 43 mg.\n");

    expect(artifacts.reviewed_draft_path).toBeDefined();
    expect(readFileSync(artifacts.reviewed_draft_path!, "utf8")).toBe("The measured value is 43 mg.\n");
    expect(readFileSync(artifacts.source_path!, "utf8")).toBe("The measured value is 43 mg.\n");
  });
});
