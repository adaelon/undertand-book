import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PdfTextGeometry } from "../src/pdf-geometry";
import {
  acceptSourceReconciliationManualOverride,
  buildReviewedDraftFromDecisions,
  contentEquivalent,
  reconcilePaperSource,
  reviewCandidateAndReconcile,
  sourceComparisonText,
  sourceReconciliationAccepted,
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

  it("writes presentation-canonical Markdown after an exact PDF match", () => {
    const caption = "Figure 3 Swap task diagram.";
    const markdown = `<div style="text-align: center;"><div style="text-align: center;">${caption}</div> </div>\n`;
    const result = reconcilePaperSource({
      book_id: "paper-caption",
      markdown_source: markdown,
      pdf_geometry: geometryFromLines([caption]),
      input_fingerprint: fingerprint(),
    });

    expect(result.report.unresolved).toEqual([]);
    expect(result.review_draft).toBe(`${caption}\n`);
    expect(result.reconciled_source).toBe(`${caption}\n`);
  });

  it("uses canonical Markdown spans and excerpts for unresolved review decisions", () => {
    const markdown = '<div style="text-align: center;"><div style="text-align: center;">The value is 42 mg.</div> </div>\n';
    const canonical = "The value is 42 mg.\n";
    const result = reconcilePaperSource({
      book_id: "paper-caption",
      markdown_source: markdown,
      pdf_geometry: geometryFromLines(["The value is 43 mg."]),
      input_fingerprint: fingerprint(),
    });

    expect(result.review_draft).toBe(canonical);
    expect(result.report.unresolved[0]).toMatchObject({
      source_span: { start: 0, end: canonical.trimEnd().length },
      md_excerpt: canonical.trim(),
      difference: { markdown: "42", pdf: "43" },
    });
    const reviewed = buildReviewedDraftFromDecisions(result.review_draft, result.report, {
      version: "source_review_decisions.v1",
      book_id: "paper-caption",
      stage: "source_reconciliation",
      input_fingerprint: fingerprint(),
      decisions: [{ block_id: "block-1", decision: "accept_markdown" }],
    });
    expect(reviewed.reviewed_draft).toBe(canonical);
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
      md_excerpt: "The measured value is 42 mg.",
      pdf_excerpt: "The measured value is 43 mg.",
      candidate_text: "The measured value is 43 mg.",
      review_question: "Markdown 与 PDF 的内容不同，请确认可信正文应采用哪一版。",
      md_context: "The measured value is 42 mg.",
      pdf_context: "The measured value is 43 mg.",
      pdf_page_index: 0,
      pdf_line_start: 0,
      pdf_line_end: 0,
      difference: { markdown: "42", pdf: "43" },
    });
    expect(result.reconciled_source).toBeUndefined();
    expect(sourceReconciliationTrusted(result.report)).toBe(false);
  });

  it("auto-accepts inline LaTeX and PDF Unicode presentation equivalents as one paragraph", () => {
    const markdown = "The sample was spun at $ 300\\times g $ and used 0.2 U/$ \\mu $L inhibitor at $ 4^{\\circ} $C.\n";
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: markdown,
      pdf_geometry: geometryFromLines(["The sample was spun at 300×g and used 0.2 U/μL inhibitor at 4°C."]),
      input_fingerprint: fingerprint(),
    });

    expect(result.report.unresolved).toEqual([]);
    expect(result.report.summary.format_equivalent).toBe(1);
    expect(result.reconciled_source).toBe(markdown);
    expect(contentEquivalent("$ \\mu $", "μ")).toBe(true);
    expect(contentEquivalent("$ \\mu $", "σ")).toBe(false);
  });

  it("normalizes proven LaTeX presentation forms without erasing mathematical operators", () => {
    expect(contentEquivalent("$ \\underline{\\text{A kernel}} $", "A kernel")).toBe(true);
    expect(contentEquivalent("$ \\kappa_1(\\cdot) $", "κ 1(·)")).toBe(true);
    expect(contentEquivalent("$ ^{\\dagger} $", "†")).toBe(true);
    expect(contentEquivalent("$ d_k \\gtrsim N $", "dk ≳ N")).toBe(true);
    expect(contentEquivalent("$ n \\in \\mathbb{N} $", "n ∈ N")).toBe(true);
    expect(contentEquivalent("$ x^{\\otimes 2} $", "x⊗2")).toBe(true);
    expect(contentEquivalent("$ n \\in \\mathbb{N} $", "n N")).toBe(false);
    expect(contentEquivalent("$ x^{\\otimes 2} $", "x2")).toBe(false);
    expect(contentEquivalent("$ d_k \\gtrsim N $", "dk > N")).toBe(false);
    expect(contentEquivalent("key-value", "keyvalue")).toBe(true);
    expect(contentEquivalent("$ I - kk^\\top $", "I-kk⊤")).toBe(true);
    expect(contentEquivalent("$ I - kk^\\top $", "I+kk⊤")).toBe(false);
    expect(sourceComparisonText(
      "$ \\underbrace{I - \\boldsymbol{k}\\boldsymbol{k}^{\\top}}_{\\boldsymbol{B}_t} $",
    )).toBe("I-kkT Bt");
    expect(contentEquivalent(
      "$ \\frac{\\boldsymbol{x}^{\\top}\\boldsymbol{y}}{\\tau} $",
      "x⊤y/τ",
    )).toBe(true);
  });

  it("aligns blank-line display formulas with adjacent prose after presentation normalization", () => {
    const markdown = [
      "The covariance is defined below.",
      "",
      "$$ \\mathbb{E}_{\\boldsymbol{x}}[\\boldsymbol{x}\\boldsymbol{x}^{\\top}] = \\frac{1}{n}\\sum_i x_i x_i^{\\top}. $$",
      "",
      "This quantity drives the update.",
      "",
    ].join("\n");
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: markdown,
      pdf_geometry: geometryFromLines([
        "The covariance is defined below.",
        "E x [x x ⊤] = 1/n ∑i x i x i ⊤.",
        "This quantity drives the update.",
      ]),
      input_fingerprint: fingerprint(),
    });

    expect(result.report.unresolved).toEqual([]);
    expect(result.report.summary.format_equivalent).toBe(1);
    expect(result.reconciled_source).toBe(markdown);
  });

  it("accepts formula token-boundary and bracket glyph presentation without ignoring operators", () => {
    const equivalent = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The kernel is $ [x^\\top y] $.\n",
      pdf_geometry: geometryFromLines(["The kernel is ⌊x⊤ y⌋."]),
      input_fingerprint: fingerprint(),
    });
    const changedOperator = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The kernel is $ [x^\\top y] $.\n",
      pdf_geometry: geometryFromLines(["The kernel is ⌊x+y⌋."]),
      input_fingerprint: fingerprint(),
    });

    expect(equivalent.report.unresolved).toEqual([]);
    expect(equivalent.report.summary.format_equivalent).toBe(1);
    expect(changedOperator.report.unresolved).toHaveLength(1);
    expect(changedOperator.reconciled_source).toBeUndefined();
  });

  it("keeps a PDF-only equation number outside the contextualized formula unit", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: [
        "The update is defined below.",
        "",
        "$$ x = y. $$",
        "",
        "The next paragraph is exact.",
        "",
      ].join("\n"),
      pdf_geometry: geometryFromLines([
        "The update is defined below.",
        "x = y. (1)",
        "The next paragraph is exact.",
      ]),
      input_fingerprint: fingerprint(),
    });

    expect(result.report.unresolved).toEqual([]);
    expect(result.report.summary.format_equivalent).toBe(1);
  });

  it("accepts a PDF-extracted fraction with a missing visual bar but not a changed operator", () => {
    const equivalent = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The factor is $ \\frac{1}{t} $.\n",
      pdf_geometry: geometryFromLines(["The factor is 1 t."]),
      input_fingerprint: fingerprint(),
    });
    const changedOperator = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The factor is $ \\frac{1}{t} $.\n",
      pdf_geometry: geometryFromLines(["The factor is 1+t."]),
      input_fingerprint: fingerprint(),
    });

    expect(equivalent.report.unresolved).toEqual([]);
    expect(equivalent.report.summary.format_equivalent).toBe(1);
    expect(changedOperator.report.unresolved).toHaveLength(1);
  });

  it("keeps a content difference inside a contextualized display formula unresolved", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: [
        "The covariance is defined below.",
        "",
        "$$ \\mathbb{E}_{\\boldsymbol{x}}[\\boldsymbol{x}\\boldsymbol{x}^{\\top}] = \\frac{1}{n}\\sum_i x_i x_i^{\\top}. $$",
        "",
        "This quantity drives the update.",
        "",
      ].join("\n"),
      pdf_geometry: geometryFromLines([
        "The covariance is defined below.",
        "E x [x x ⊤] = 2/n ∑i x i x i ⊤.",
        "This quantity drives the update.",
      ]),
      input_fingerprint: fingerprint(),
    });

    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0]).toMatchObject({
      md_excerpt: expect.stringContaining("\\frac{1}{n}"),
      pdf_excerpt: expect.stringContaining("2/n"),
    });
    expect(result.reconciled_source).toBeUndefined();
  });

  it("provides nearby PDF context when no replacement candidate is reliable", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "A sentence that is absent from the PDF.\n",
      pdf_geometry: geometryFromLines(["Nearby extracted PDF line.", "Another PDF line."]),
      input_fingerprint: fingerprint(),
    });

    expect(result.report.unresolved[0]).toMatchObject({
      status: "md_unmatched",
      pdf_context: "Nearby extracted PDF line.\nAnother PDF line.",
      pdf_page_index: 0,
    });
    expect(result.report.unresolved[0].pdf_excerpt).toBeUndefined();
  });

  it("uses global PDF anchors for review evidence without auto-trusting an out-of-order candidate", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "Opening anchor.\n\nLitvicukova M, Talavera-Lopez C, Maatz H. Cells of the adult heart.\n",
      pdf_geometry: geometryFromLines([
        "Opening anchor.",
        "Unrelated extracted material that pushes the reference beyond the local search window.",
        "Litvinukova M, Talavera-Lopez C, Maatz H. Cells of the adult heart.",
      ]),
      input_fingerprint: fingerprint(),
      config: { lookback_chars: 0, lookahead_chars: 8 },
    });

    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0]).toMatchObject({
      id: "block-2",
      status: "needs_review",
      pdf_page_index: 0,
      difference: { markdown: "litvicukova", pdf: "litvinukova" },
    });
    expect(result.report.unresolved[0].pdf_context).toContain("Litvinukova M, Talavera-Lopez");
    expect(result.report.unresolved[0].pdf_excerpt).toContain("Litvinukova M, TalaveraLopez");
    expect(sourceReconciliationTrusted(result.report)).toBe(false);
  });

  it("resynchronizes the cursor at a unique exact forward anchor outside the local window", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: [
        "Opening anchor.",
        "",
        "A unique forward anchor appears after omitted PDF extraction material.",
        "",
        "The measured value is 42 mg.",
        "",
      ].join("\n"),
      pdf_geometry: geometryFromLines([
        "Opening anchor.",
        "filler ".repeat(80),
        "A unique forward anchor appears after omitted PDF extraction material.",
        "The measured value is 43 mg.",
      ]),
      input_fingerprint: fingerprint(),
      config: { lookback_chars: 0, lookahead_chars: 40 },
    });

    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0]).toMatchObject({
      id: "block-3",
      status: "needs_review",
      reason: expect.stringMatching(/^fuzzy match score .* below trusted exact-match gate$/),
      difference: { markdown: "42", pdf: "43" },
    });
  });

  it("resynchronizes the cursor at a forward compact-equivalent anchor outside the local window", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: [
        "Opening anchor.",
        "",
        "The unique covariance anchor in this derivation is $ \\mathbb{E}_{\\boldsymbol{x}} $.",
        "",
        "The measured value is 42 mg.",
        "",
      ].join("\n"),
      pdf_geometry: geometryFromLines([
        "Opening anchor.",
        "filler ".repeat(80),
        "The unique covariance anchor in this derivation is E x.",
        "The measured value is 43 mg.",
      ]),
      input_fingerprint: fingerprint(),
      config: { lookback_chars: 0, lookahead_chars: 40 },
    });

    expect(result.report.summary.format_equivalent).toBe(1);
    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0]).toMatchObject({
      id: "block-5",
      status: "needs_review",
      reason: expect.stringMatching(/^fuzzy match score .* below trusted exact-match gate$/),
      difference: { markdown: "42", pdf: "43" },
    });
  });

  it("does not trust a unique exact candidate behind the monotonic cursor", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "First anchor.\n\nSecond anchor.\n",
      pdf_geometry: geometryFromLines(["Second anchor.", "First anchor."]),
      input_fingerprint: fingerprint(),
      config: { lookback_chars: 0 },
    });

    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0]).toMatchObject({
      id: "block-2",
      status: "needs_review",
      reason: "candidate found outside trusted PDF text order",
    });
    expect(result.reconciled_source).toBeUndefined();
  });

  it("does not let fuzzy review evidence advance past the next exact anchor", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: [
        `alpha beta gamma delta epsilon 42 ${"alpha ".repeat(20).trim()}`,
        "",
        "epsilon delta gamma",
        "",
      ].join("\n"),
      pdf_geometry: geometryFromLines([
        "alpha beta gamma delta epsilon 43.",
        "epsilon delta gamma",
      ]),
      input_fingerprint: fingerprint(),
    });

    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0]).toMatchObject({
      id: "block-1",
      status: "needs_review",
      difference: { markdown: "42", pdf: "43" },
    });
    expect(result.report.summary.verified).toBe(1);
  });

  it("keeps nearby PDF context when a global candidate remains below the trust threshold", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "Opening anchor.\n\nalpha beta gamma delta\n",
      pdf_geometry: geometryFromLines([
        "Opening anchor.",
        "alpha unrelated nearby words",
        "filler ".repeat(40),
        "alpha beta unrelated ending",
      ]),
      input_fingerprint: fingerprint(),
      config: { lookback_chars: 0, lookahead_chars: 40 },
    });

    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0]).toMatchObject({
      status: "md_unmatched",
      pdf_page_index: 0,
    });
    expect(result.report.unresolved[0].pdf_context).toContain("alpha unrelated nearby words");
    expect(result.report.unresolved[0].pdf_context).not.toContain("alpha beta unrelated ending");
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
  it("preserves explicit manual-override acceptance provenance in the report schema", () => {
    const result = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The measured value is 42 mg.\n",
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
    });
    const report = {
      ...result.report,
      acceptance: {
        mode: "manual_override" as const,
        policy: "single_review_then_override_v1" as const,
        accepted_at: "2026-07-10T12:00:00.000Z",
        residual_unresolved_count: 1,
        decision_count: 1,
      },
    };

    expect(SourceReconciliationReportZ.parse(report)).toEqual(report);
    expect(sourceReconciliationTrusted(report)).toBe(false);
  });

  it("builds a manual reviewed draft from recorded PDF evidence decisions", () => {
    const initial = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "# Result\n\nThe measured value is 42 mg.\n",
      pdf_geometry: geometryFromLines(["Result", "The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
    });

    const reviewed = buildReviewedDraftFromDecisions(
      "# Result\n\nThe measured value is 42 mg.\n",
      initial.report,
      {
        version: "source_review_decisions.v1",
        book_id: "paper-a",
        stage: "source_reconciliation",
        input_fingerprint: fingerprint(),
        decisions: [{ block_id: "block-2", decision: "accept_pdf", note: "PDF checked" }],
      },
    );

    expect(reviewed.reviewed_draft).toBe("# Result\n\nThe measured value is 43 mg.\n");
    expect(reviewed.decisions).toEqual([
      { block_id: "block-2", decision: "accept_pdf", note: "PDF checked" },
    ]);
  });

  it("refuses incomplete or explicitly blocked review decisions", () => {
    const initial = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: "The measured value is 42 mg.\n",
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
    });
    const base = {
      version: "source_review_decisions.v1" as const,
      book_id: "paper-a",
      stage: "source_reconciliation" as const,
      input_fingerprint: fingerprint(),
    };

    expect(() => buildReviewedDraftFromDecisions("The measured value is 42 mg.\n", initial.report, {
      ...base,
      decisions: [],
    })).toThrow(/missing decision/);
    expect(() => buildReviewedDraftFromDecisions("The measured value is 42 mg.\n", initial.report, {
      ...base,
      decisions: [{ block_id: "block-1", decision: "keep_blocked" }],
    })).toThrow(/remains blocked/);
  });

  it("keeps explicit keep-Markdown residual until manual override acceptance is recorded", () => {
    const original = "The measured val-\nue is 42 mg.\n";
    const initial = reconcilePaperSource({
      book_id: "paper-a",
      markdown_source: original,
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
    });
    const base = {
      version: "source_review_decisions.v1" as const,
      book_id: "paper-a",
      stage: "source_reconciliation" as const,
      input_fingerprint: fingerprint(),
    };

    const kept = buildReviewedDraftFromDecisions(original, initial.report, {
      ...base,
      decisions: [{ block_id: "block-1", decision: "accept_markdown" }],
    });
    const keptResult = reviewCandidateAndReconcile({
      book_id: "paper-a",
      original_source: original,
      candidate_source: kept.reviewed_draft,
      pdf_geometry: geometryFromLines(["The measured value is 43 mg."]),
      input_fingerprint: fingerprint(),
      kind: "manual_review",
      decisions: kept.decisions,
    });
    expect(keptResult.accepted).toBe(false);
    expect(keptResult.reconciliation?.report.unresolved).toHaveLength(1);
    expect(sourceReconciliationTrusted(keptResult.reconciliation!.report)).toBe(false);
    expect(sourceReconciliationAccepted(keptResult.reconciliation!.report)).toBe(false);

    const overridden = acceptSourceReconciliationManualOverride(
      keptResult.reconciliation!,
      kept.reviewed_draft,
      "2026-07-10T12:00:00.000Z",
    );
    expect(sourceReconciliationTrusted(overridden.report)).toBe(false);
    expect(sourceReconciliationAccepted(overridden.report)).toBe(true);
    expect(overridden.report.unresolved).toHaveLength(1);
    expect(overridden.report.acceptance).toMatchObject({
      mode: "manual_override",
      residual_unresolved_count: 1,
      decision_count: 1,
    });
    expect(overridden.reconciled_source).toBe("The measured value is 42 mg.\n");

    const edited = buildReviewedDraftFromDecisions(original, initial.report, {
      ...base,
      decisions: [{ block_id: "block-1", decision: "manual_edit", replacement_text: "The measured value is 44 mg." }],
    });
    expect(edited.reviewed_draft).toBe("The measured value is 44 mg.\n");
  });

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
      decisions: [{ block_id: "block-1", decision: "accept_pdf", note: "PDF verified value" }],
    });

    expect(result.accepted).toBe(true);
    expect(result.reconciliation?.report.unresolved).toEqual([]);
    expect(result.reconciliation?.review_decisions.decisions).toEqual([
      { block_id: "block-1", decision: "accept_pdf", note: "PDF verified value" },
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
