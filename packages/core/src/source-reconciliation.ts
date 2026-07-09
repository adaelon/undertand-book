import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markdownToBlocks } from "./md-adapter";
import type { PdfTextGeometry } from "./pdf-geometry";

export type SourceBlockReconcileStatus =
  | "verified"
  | "auto_repaired"
  | "llm_format_repaired"
  | "needs_review"
  | "pdf_unmatched"
  | "md_unmatched";

export interface BuildInputFingerprint {
  paper_md_sha256: string;
  paper_pdf_sha256: string;
  config_hash: string;
}

export interface SourceReconciliationIssue {
  id: string;
  status: SourceBlockReconcileStatus;
  reason: string;
}

export interface SourceReconciliationReport {
  version: "source_reconciliation_report.v1";
  book_id: string;
  input_fingerprint: BuildInputFingerprint;
  summary: Record<SourceBlockReconcileStatus, number>;
  unresolved: SourceReconciliationIssue[];
}

export interface SourceReconciliationConfig {
  algorithm: "monotonic_forward_fuzzy_v1";
  lookback_chars: number;
  lookahead_chars: number;
  fuzzy_threshold: number;
  normalization: string[];
}

export interface SourceReconciliationReviewDecisions {
  version: "source_reconciliation_review_decisions.v1";
  book_id: string;
  decisions: Array<{ id: string; action: "accept_markdown" | "accept_pdf" | "manual_edit"; note?: string }>;
}

export type ReviewCandidateKind = "llm_format_repair" | "manual_review";

export interface ReconcilePaperSourceInput {
  book_id: string;
  markdown_source: string;
  pdf_geometry: PdfTextGeometry;
  input_fingerprint: BuildInputFingerprint;
  config?: Partial<SourceReconciliationConfig>;
}

export interface ReconcilePaperSourceResult {
  report: SourceReconciliationReport;
  reconciled_source?: string;
  review_draft: string;
  review_decisions: SourceReconciliationReviewDecisions;
}

export interface ReviewCandidateInput {
  book_id: string;
  original_source: string;
  candidate_source: string;
  pdf_geometry: PdfTextGeometry;
  input_fingerprint: BuildInputFingerprint;
  kind: ReviewCandidateKind;
  decisions?: SourceReconciliationReviewDecisions["decisions"];
  config?: Partial<SourceReconciliationConfig>;
}

export interface ReviewCandidateResult {
  accepted: boolean;
  reason?: string;
  reconciliation?: ReconcilePaperSourceResult;
}

export interface WriteSourceReconciliationArtifactsResult {
  report_path: string;
  review_draft_path: string;
  review_decisions_path: string;
  reviewed_draft_path?: string;
  source_path?: string;
}

const DEFAULT_CONFIG: SourceReconciliationConfig = {
  algorithm: "monotonic_forward_fuzzy_v1",
  lookback_chars: 160,
  lookahead_chars: 4000,
  fuzzy_threshold: 0.7,
  normalization: ["unicode_nfc", "crlf_to_lf", "soft_hyphen_remove", "hyphen_line_unwrap", "whitespace_collapse"],
};

export function emptyReconciliationSummary(): Record<SourceBlockReconcileStatus, number> {
  return {
    verified: 0,
    auto_repaired: 0,
    llm_format_repaired: 0,
    needs_review: 0,
    pdf_unmatched: 0,
    md_unmatched: 0,
  };
}

export function sourceReconciliationTrusted(report: SourceReconciliationReport): boolean {
  return report.unresolved.length === 0;
}

export function sourceTextFromPdfGeometry(geometry: PdfTextGeometry): string {
  return geometry.pages
    .flatMap((page) => page.lines.map((line) => line.text))
    .join("\n");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeRepairText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2");
}

function basicSearchable(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();
}

function searchable(text: string): string {
  return safeRepairText(text).replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(searchable(text).toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
}

function contentSignature(text: string): string {
  return safeRepairText(text)
    .toLowerCase()
    .match(/[a-z0-9]+/gu)
    ?.join(" ") ?? "";
}

export function contentEquivalent(left: string, right: string): boolean {
  return contentSignature(left) === contentSignature(right);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function bestFuzzyOffset(haystack: string, needle: string, from: number, to: number): { offset: number; score: number } | null {
  const needleTokens = tokenSet(needle);
  if (!needleTokens.size) return null;
  const windowSize = Math.max(needle.length * 2, 80);
  let best: { offset: number; score: number } | null = null;
  for (let offset = from; offset <= to; offset += Math.max(16, Math.floor(windowSize / 4))) {
    const candidate = haystack.slice(offset, offset + windowSize);
    const score = jaccard(needleTokens, tokenSet(candidate));
    if (!best || score > best.score) best = { offset, score };
  }
  return best;
}

function resolvedStatus(rawText: string, repairedText: string): SourceBlockReconcileStatus {
  return basicSearchable(rawText) === searchable(repairedText) ? "verified" : "auto_repaired";
}

export function reconcilePaperSource(input: ReconcilePaperSourceInput): ReconcilePaperSourceResult {
  const config: SourceReconciliationConfig = { ...DEFAULT_CONFIG, ...input.config };
  const summary = emptyReconciliationSummary();
  const unresolved: SourceReconciliationIssue[] = [];
  const pdfText = searchable(sourceTextFromPdfGeometry(input.pdf_geometry));
  const blocks = markdownToBlocks(input.markdown_source).filter((block) => block.text.trim().length > 0);
  let cursor = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const repaired = safeRepairText(block.text);
    const needle = searchable(repaired);
    const id = `block-${i + 1}`;
    if (!needle) continue;

    const from = Math.max(0, cursor - config.lookback_chars);
    const exactOffset = pdfText.indexOf(needle, from);
    if (exactOffset >= 0) {
      const status = resolvedStatus(block.text, repaired);
      summary[status]++;
      cursor = exactOffset + needle.length;
      continue;
    }

    const fuzzyTo = Math.min(pdfText.length, cursor + config.lookahead_chars);
    const fuzzy = bestFuzzyOffset(pdfText, needle, from, fuzzyTo);
    if (fuzzy && fuzzy.score >= config.fuzzy_threshold) {
      summary.needs_review++;
      unresolved.push({
        id,
        status: "needs_review",
        reason: `fuzzy match score ${fuzzy.score.toFixed(2)} below trusted exact-match gate`,
      });
      cursor = Math.max(cursor, fuzzy.offset + needle.length);
    } else {
      summary.md_unmatched++;
      unresolved.push({ id, status: "md_unmatched", reason: "markdown block was not found in PDF text order" });
    }
  }

  const repairedSource = safeRepairText(input.markdown_source);
  const report: SourceReconciliationReport = {
    version: "source_reconciliation_report.v1",
    book_id: input.book_id,
    input_fingerprint: input.input_fingerprint,
    summary,
    unresolved,
  };
  return {
    report,
    ...(sourceReconciliationTrusted(report) ? { reconciled_source: repairedSource } : {}),
    review_draft: repairedSource,
    review_decisions: {
      version: "source_reconciliation_review_decisions.v1",
      book_id: input.book_id,
      decisions: [],
    },
  };
}

export function reviewCandidateAndReconcile(input: ReviewCandidateInput): ReviewCandidateResult {
  if (input.kind === "llm_format_repair" && !contentEquivalent(input.original_source, input.candidate_source)) {
    return {
      accepted: false,
      reason: "LLM format repair candidate changed content-equivalence signature",
    };
  }
  const reconciliation = reconcilePaperSource({
    book_id: input.book_id,
    markdown_source: input.candidate_source,
    pdf_geometry: input.pdf_geometry,
    input_fingerprint: input.input_fingerprint,
    config: input.config,
  });
  reconciliation.review_decisions = {
    version: "source_reconciliation_review_decisions.v1",
    book_id: input.book_id,
    decisions: input.decisions ?? [],
  };
  return {
    accepted: sourceReconciliationTrusted(reconciliation.report),
    ...(sourceReconciliationTrusted(reconciliation.report) ? {} : { reason: "review candidate still has unresolved reconciliation blocks" }),
    reconciliation,
  };
}

export function writeSourceReconciliationArtifacts(
  outputDir: string,
  result: ReconcilePaperSourceResult,
  reviewedDraft?: string,
): WriteSourceReconciliationArtifactsResult {
  const stageDir = path.join(outputDir, ".build", "source-reconciliation");
  mkdirSync(stageDir, { recursive: true });
  const reportPath = path.join(stageDir, "report.json");
  const reviewDraftPath = path.join(stageDir, "review-draft.md");
  const reviewDecisionsPath = path.join(stageDir, "review-decisions.json");
  const reviewedDraftPath = path.join(stageDir, "reviewed-draft.md");
  writeFileSync(reportPath, JSON.stringify(result.report, null, 2), "utf8");
  writeFileSync(reviewDraftPath, result.review_draft, "utf8");
  writeFileSync(reviewDecisionsPath, JSON.stringify(result.review_decisions, null, 2), "utf8");
  if (reviewedDraft !== undefined) writeFileSync(reviewedDraftPath, reviewedDraft, "utf8");
  const sourcePath = path.join(stageDir, "source.txt");
  if (result.reconciled_source !== undefined) {
    writeFileSync(sourcePath, result.reconciled_source, "utf8");
  } else if (existsSync(sourcePath)) {
    throw new Error(`Refusing to leave stale trusted source at ${sourcePath}`);
  }
  return {
    report_path: reportPath,
    review_draft_path: reviewDraftPath,
    review_decisions_path: reviewDecisionsPath,
    ...(reviewedDraft !== undefined ? { reviewed_draft_path: reviewedDraftPath } : {}),
    ...(result.reconciled_source !== undefined ? { source_path: sourcePath } : {}),
  };
}
