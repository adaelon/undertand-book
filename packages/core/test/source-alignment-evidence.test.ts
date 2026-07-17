import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PdfTextGeometry } from "../src/pdf-geometry";
import {
  acceptSourceAlignmentEvidence,
  SourceAlignmentEvidenceV1Z,
} from "../src/source-alignment-evidence";
import {
  acceptSourceReconciliationManualOverride,
  buildReviewedDraftFromDecisions,
  reconcilePaperSource,
  reviewCandidateAndReconcile,
  writeSourceReconciliationArtifacts,
} from "../src/source-reconciliation";

function geometryFromLines(lines: string[]): PdfTextGeometry {
  return {
    pages: [{
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
        bbox: [72, 120 - lineIndex * 14, 240, 132 - lineIndex * 14],
      })),
    }],
  };
}

function fingerprint() {
  return {
    paper_md_sha256: "1".repeat(64),
    paper_pdf_sha256: "2".repeat(64),
    config_hash: "workbench-config",
  };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-evidence-"));
}

describe("HF2-1 source alignment evidence", () => {
  it("binds evidence spans to the final repaired source and writes it with trusted source", () => {
    const result = reconcilePaperSource({
      book_id: "paper-evidence",
      markdown_source: "# Title\r\n\r\nhyphen-\r\nated method\r\n",
      pdf_geometry: geometryFromLines(["Title", "hyphenated method"]),
      input_fingerprint: fingerprint(),
    });

    const source = result.reconciled_source!;
    const evidence = SourceAlignmentEvidenceV1Z.parse(result.alignment_evidence);
    expect(evidence.input_fingerprint).toMatchObject({
      source_sha256: createHash("sha256").update(source).digest("hex"),
      pdf_sha256: fingerprint().paper_pdf_sha256,
      evidence_policy_version: "source_alignment_evidence_policy.v1",
    });
    expect(evidence.units.map((unit) => ({
      text: source.slice(unit.source_span.start, unit.source_span.end),
      status: unit.status,
      pdf_line_spans: unit.pdf_line_spans,
    }))).toEqual([
      {
        text: "# Title",
        status: "verified",
        pdf_line_spans: [{ pageIndex: 0, start_line_index: 0, end_line_index: 0 }],
      },
      {
        text: "hyphenated method",
        status: "verified",
        pdf_line_spans: [{ pageIndex: 0, start_line_index: 1, end_line_index: 1 }],
      },
    ]);

    const written = writeSourceReconciliationArtifacts(tempDir(), result);
    expect(written.alignment_evidence_path).toBeDefined();
    expect(existsSync(written.alignment_evidence_path!)).toBe(true);
    expect(SourceAlignmentEvidenceV1Z.parse(JSON.parse(
      readFileSync(written.alignment_evidence_path!, "utf8"),
    ))).toEqual(evidence);
  });

  it("rejects the entire evidence artifact when any input fingerprint is stale", () => {
    const result = reconcilePaperSource({
      book_id: "paper-evidence",
      markdown_source: "Trusted text.\n",
      pdf_geometry: geometryFromLines(["Trusted text."]),
      input_fingerprint: fingerprint(),
    });
    const current = result.alignment_evidence.input_fingerprint;

    expect(acceptSourceAlignmentEvidence(result.alignment_evidence, current)).toEqual(result.alignment_evidence);
    for (const stale of [
      { ...current, source_sha256: "3".repeat(64) },
      { ...current, pdf_sha256: "4".repeat(64) },
      { ...current, reconciliation_config_hash: "5".repeat(64) },
    ]) {
      expect(acceptSourceAlignmentEvidence(result.alignment_evidence, stale)).toBeNull();
    }
  });

  it("marks length-changing manual decisions as reviewed hints using final source spans", () => {
    const original = "Value 42.\n\nStable text.\n";
    const geometry = geometryFromLines(["Value 4300.", "Stable text."]);
    const initial = reconcilePaperSource({
      book_id: "paper-evidence",
      markdown_source: original,
      pdf_geometry: geometry,
      input_fingerprint: fingerprint(),
    });
    const reviewed = buildReviewedDraftFromDecisions(initial.review_draft, initial.report, {
      version: "source_review_decisions.v1",
      book_id: "paper-evidence",
      stage: "source_reconciliation",
      input_fingerprint: fingerprint(),
      decisions: [{
        block_id: "block-1",
        decision: "manual_edit",
        replacement_text: "Value 4300.",
      }],
    });
    const gated = reviewCandidateAndReconcile({
      book_id: "paper-evidence",
      original_source: original,
      candidate_source: reviewed.reviewed_draft,
      pdf_geometry: geometry,
      input_fingerprint: fingerprint(),
      kind: "manual_review",
      decisions: reviewed.decisions,
      reviewed_source_spans: reviewed.reviewed_spans,
    });

    expect(gated.accepted).toBe(true);
    const finalSource = gated.reconciliation!.reconciled_source!;
    expect(gated.reconciliation!.alignment_evidence.units.map((unit) => ({
      text: finalSource.slice(unit.source_span.start, unit.source_span.end),
      status: unit.status,
    }))).toEqual([
      { text: "Value 4300.", status: "reviewed_hint" },
      { text: "Stable text.", status: "verified" },
    ]);
  });

  it("keeps residual manual-override units as reviewed hints", () => {
    const source = "The measured value is 42 mg.\n";
    const geometry = geometryFromLines(["The measured value is 43 mg."]);
    const initial = reconcilePaperSource({
      book_id: "paper-evidence",
      markdown_source: source,
      pdf_geometry: geometry,
      input_fingerprint: fingerprint(),
    });
    const reviewed = buildReviewedDraftFromDecisions(initial.review_draft, initial.report, {
      version: "source_review_decisions.v1",
      book_id: "paper-evidence",
      stage: "source_reconciliation",
      input_fingerprint: fingerprint(),
      decisions: [{ block_id: "block-1", decision: "accept_markdown" }],
    });
    const gated = reviewCandidateAndReconcile({
      book_id: "paper-evidence",
      original_source: source,
      candidate_source: reviewed.reviewed_draft,
      pdf_geometry: geometry,
      input_fingerprint: fingerprint(),
      kind: "manual_review",
      decisions: reviewed.decisions,
      reviewed_source_spans: reviewed.reviewed_spans,
    });
    const accepted = acceptSourceReconciliationManualOverride(
      gated.reconciliation!,
      reviewed.reviewed_draft,
      "2026-07-17T12:00:00.000Z",
    );

    expect(accepted.alignment_evidence.units).toMatchObject([{ status: "reviewed_hint" }]);
    expect(accepted.alignment_evidence.units[0].pdf_line_spans).toEqual([
      { pageIndex: 0, start_line_index: 0, end_line_index: 0 },
    ]);
  });
});
