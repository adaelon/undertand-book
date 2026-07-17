import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parse } from "node-html-parser";
import path from "node:path";
import { markdownToBlocks } from "./md-adapter";
import type { PdfTextGeometry } from "./pdf-geometry";

export type SourceBlockReconcileStatus =
  | "verified"
  | "auto_repaired"
  | "format_equivalent"
  | "reviewed"
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
  source_span?: { start: number; end: number };
  md_excerpt?: string;
  pdf_excerpt?: string;
  candidate_text?: string;
  review_question?: string;
  md_context?: string;
  pdf_context?: string;
  pdf_page_index?: number;
  pdf_page_label?: string;
  pdf_line_start?: number;
  pdf_line_end?: number;
  comparison_score?: number;
  difference?: { markdown: string; pdf: string };
}

export interface SourceReconciliationReport {
  version: "source_reconciliation_report.v1";
  book_id: string;
  input_fingerprint: BuildInputFingerprint;
  summary: Record<SourceBlockReconcileStatus, number>;
  unresolved: SourceReconciliationIssue[];
  acceptance?: SourceReconciliationAcceptance;
}

export interface SourceReconciliationAcceptance {
  mode: "manual_override";
  policy: "single_review_then_override_v1";
  accepted_at: string;
  residual_unresolved_count: number;
  decision_count: number;
}

export interface SourceReconciliationConfig {
  algorithm: "monotonic_forward_fuzzy_v1";
  lookback_chars: number;
  lookahead_chars: number;
  fuzzy_threshold: number;
  normalization: string[];
}

export interface SourceReconciliationReviewDecisions {
  version: "source_review_decisions.v1";
  book_id: string;
  stage: "source_reconciliation";
  input_fingerprint?: BuildInputFingerprint;
  decisions: SourceReviewDecision[];
  created_at?: string;
  updated_at?: string;
}

export interface SourceReviewDecision {
  block_id: string;
  decision: "accept_markdown" | "accept_pdf" | "use_candidate" | "manual_edit" | "keep_blocked";
  replacement_text?: string;
  note?: string;
  resolved_at?: string;
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
  normalization: [
    "unicode_nfkc_compare",
    "crlf_to_lf",
    "soft_hyphen_remove",
    "hyphen_line_unwrap",
    "latex_unicode_equivalence",
    "html_markdown_presentation_strip",
    "whitespace_collapse",
  ],
};

export function emptyReconciliationSummary(): Record<SourceBlockReconcileStatus, number> {
  return {
    verified: 0,
    auto_repaired: 0,
    format_equivalent: 0,
    reviewed: 0,
    llm_format_repaired: 0,
    needs_review: 0,
    pdf_unmatched: 0,
    md_unmatched: 0,
  };
}

export function sourceReconciliationTrusted(report: SourceReconciliationReport): boolean {
  return report.unresolved.length === 0;
}

export function sourceReconciliationAccepted(report: SourceReconciliationReport): boolean {
  if (sourceReconciliationTrusted(report)) return true;
  const acceptance = report.acceptance;
  return Boolean(
    acceptance
    && acceptance.mode === "manual_override"
    && acceptance.policy === "single_review_then_override_v1"
    && typeof acceptance.accepted_at === "string"
    && acceptance.accepted_at.trim().length > 0
    && Number.isInteger(acceptance.residual_unresolved_count)
    && acceptance.residual_unresolved_count === report.unresolved.length
    && Number.isInteger(acceptance.decision_count)
    && acceptance.decision_count > 0,
  );
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

const LATEX_SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  eta: "η",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  Sigma: "Σ",
  tau: "τ",
  phi: "φ",
  chi: "χ",
  omega: "ω",
  Omega: "Ω",
  partial: "∂",
  nabla: "∇",
  top: "T",
  times: "×",
  cdot: "·",
  circ: "°",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  sim: "≈",
  pm: "±",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  sqrt: "√",
};

const LATEX_PRESENTATION_COMMANDS = new Set([
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "scriptscriptstyle",
  "left",
  "right",
  "limits",
  "nolimits",
  "quad",
  "qquad",
]);

function latexToDisplayText(text: string): string {
  let value = text.replace(/\$\s*\^\{ID\}\s*\$/giu, " ");
  for (let pass = 0; pass < 6; pass += 1) {
    value = value
      .replace(/\\(?:text|textrm|textit|textbf|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|operatorname|boldsymbol|bm|pmb)\s*\{([^{}]*)\}/gu, "$1")
      .replace(/\\(?:frac|dfrac|tfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu, "$1/$2");
  }
  return value
    .replace(/\\begin\{[^{}]+\}|\\end\{[^{}]+\}/gu, " ")
    .replace(/\\[,:;!]/gu, " ")
    .replace(/\\\s+/gu, " ")
    .replace(/\\([A-Za-z]+)(?![A-Za-z])/gu, (_match, command: string) => {
      if (LATEX_PRESENTATION_COMMANDS.has(command)) return " ";
      return LATEX_SYMBOLS[command] ?? command;
    })
    .replace(/\$+/gu, " ")
    .replace(/[{}_^]/gu, "")
    .replace(/~/gu, " ");
}

function stripMarkup(text: string): string {
  let value = text;
  if (/<[a-z][\s\S]*>/iu.test(value)) value = parse(value).structuredText;
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/[*_`]+/gu, "");
}

function comparisonText(text: string): string {
  return stripMarkup(latexToDisplayText(safeRepairText(text)))
    .normalize("NFKC")
    .replace(/[⊤ᵀ]/gu, "T")
    .replace(/µ/gu, "μ")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, "")
    .replace(/[‘’]/gu, "'")
    .replace(/[′]/gu, "'")
    .replace(/[″]/gu, "\"")
    .replace(/[“”]/gu, "\"")
    .replace(/∆/gu, "Δ")
    .replace(/[~∼]/gu, "≈")
    .replace(/[■◼▪●]/gu, " ")
    .replace(/(?<=[\p{L}])(?=[\p{N}])|(?<=[\p{N}])(?=[\p{L}])/gu, " ")
    .replace(/\s*([×·≤≥≠≈=+\-/*°%μ])\s*/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

export function sourceComparisonText(text: string): string {
  return comparisonText(text);
}

function comparisonBaseline(text: string): string {
  return safeRepairText(text)
    .normalize("NFKC")
    .replace(/µ/gu, "μ")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/∆/gu, "Δ")
    .replace(/[‘’′]/gu, "'")
    .replace(/[“”″]/gu, "\"")
    .replace(/(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, "")
    .replace(/[~∼]/gu, "≈")
    .replace(/[■◼▪●]/gu, " ")
    .replace(/(?<=[\p{L}])(?=[\p{N}])|(?<=[\p{N}])(?=[\p{L}])/gu, " ")
    .replace(/\s*([×·≤≥≠≈=+\-/*°%μ])\s*/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function comparisonTokens(text: string): string[] {
  return comparisonText(text).toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+|[×·≤≥≠≈=+\-/*°%]/gu) ?? [];
}

function tokenSet(text: string): Set<string> {
  return new Set(comparisonTokens(text));
}

function contentSignature(text: string): string {
  return comparisonTokens(text).join(" ");
}

function firstTokenDifference(markdown: string, pdf: string): { markdown: string; pdf: string } | undefined {
  const markdownTokens = comparisonTokens(markdown);
  const pdfTokens = comparisonTokens(pdf);
  const length = Math.max(markdownTokens.length, pdfTokens.length);
  for (let index = 0; index < length; index += 1) {
    if (markdownTokens[index] !== pdfTokens[index]) {
      return {
        markdown: markdownTokens[index] ?? "(缺失)",
        pdf: pdfTokens[index] ?? "(缺失)",
      };
    }
  }
  return undefined;
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
  const windowSize = Math.max(needle.length, 80);
  let best: { offset: number; score: number } | null = null;
  for (let offset = from; offset <= to; offset += Math.max(16, Math.floor(windowSize / 4))) {
    const candidate = haystack.slice(offset, offset + windowSize);
    const score = jaccard(needleTokens, tokenSet(candidate));
    if (!best || score > best.score) best = { offset, score };
  }
  return best;
}

function fuzzyCandidateAt(haystack: string, needle: string, offset: number): { offset: number; score: number } | null {
  const needleTokens = tokenSet(needle);
  if (!needleTokens.size || offset < 0 || offset > haystack.length) return null;
  const windowSize = Math.max(needle.length, 80);
  return { offset, score: jaccard(needleTokens, tokenSet(haystack.slice(offset, offset + windowSize))) };
}

function fuzzyCandidateFromPrefix(
  haystack: string,
  needle: string,
  from: number,
  to: number,
): { offset: number; score: number } | null {
  for (const size of [80, 48, 24, 12]) {
    if (needle.length < size) continue;
    const offset = haystack.indexOf(needle.slice(0, size), from);
    if (offset >= 0 && offset <= to) return fuzzyCandidateAt(haystack, needle, offset);
  }
  return null;
}

type FuzzyCandidate = { offset: number; score: number };

function bestCandidate(candidates: Array<FuzzyCandidate | null>, cursor: number): FuzzyCandidate | null {
  return candidates
    .filter((candidate): candidate is FuzzyCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score || Math.abs(left.offset - cursor) - Math.abs(right.offset - cursor))[0]
    ?? null;
}

function hasTokenBoundary(haystack: string, offset: number, needle: string): boolean {
  const before = offset > 0 ? haystack[offset - 1] : "";
  const after = offset + needle.length < haystack.length ? haystack[offset + needle.length] : "";
  const startsWithToken = /^[\p{L}\p{N}]/u.test(needle);
  const endsWithToken = /[\p{L}\p{N}]$/u.test(needle);
  return !(startsWithToken && /[\p{L}\p{N}]/u.test(before))
    && !(endsWithToken && /[\p{L}\p{N}]/u.test(after));
}

function nearestExactCandidate(haystack: string, needle: string, cursor: number): FuzzyCandidate | null {
  let best: FuzzyCandidate | null = null;
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    if (hasTokenBoundary(haystack, offset, needle)
      && (!best || Math.abs(offset - cursor) < Math.abs(best.offset - cursor))) {
      best = { offset, score: 1 };
    }
    offset = haystack.indexOf(needle, offset + Math.max(1, needle.length));
  }
  return best;
}

function fuzzyCandidateFromAnchors(haystack: string, needle: string, cursor: number): FuzzyCandidate | null {
  const anchors = [...new Set(comparisonTokens(needle).filter((token) => token.length >= 4))]
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
  let best: FuzzyCandidate | null = null;
  for (const anchor of anchors) {
    const needleOffset = needle.indexOf(anchor);
    if (needleOffset < 0) continue;
    let occurrence = haystack.indexOf(anchor);
    let occurrenceCount = 0;
    while (occurrence >= 0 && occurrenceCount < 32) {
      const candidate = fuzzyCandidateAt(haystack, needle, Math.max(0, occurrence - needleOffset));
      best = bestCandidate([best, candidate], cursor);
      occurrence = haystack.indexOf(anchor, occurrence + anchor.length);
      occurrenceCount += 1;
    }
  }
  return best;
}

function globalEvidenceCandidate(haystack: string, needle: string, cursor: number): FuzzyCandidate | null {
  return bestCandidate([
    nearestExactCandidate(haystack, needle, cursor),
    fuzzyCandidateFromAnchors(haystack, needle, cursor),
    needle.length >= 24 ? bestFuzzyOffset(haystack, needle, 0, haystack.length) : null,
  ], cursor);
}

function uniqueExactOffset(haystack: string, needle: string): number | null {
  const first = haystack.indexOf(needle);
  if (first < 0) return null;
  return haystack.indexOf(needle, first + 1) < 0 ? first : null;
}

function tokenEquivalentAt(haystack: string, needle: string, offset: number): { end: number } | null {
  const expected = comparisonTokens(needle);
  if (!expected.length) return null;
  const sample = haystack.slice(offset, Math.min(haystack.length, offset + Math.max(needle.length + 256, 512)));
  const matches = [...sample.toLocaleLowerCase("en-US").matchAll(/[\p{L}\p{N}]+|[×·≤≥≠≈=+\-/*°%]/gu)];
  if (matches.length < expected.length) return null;
  for (let index = 0; index < expected.length; index += 1) {
    if (matches[index][0] !== expected[index]) return null;
  }
  const last = matches[expected.length - 1];
  return { end: offset + (last.index ?? 0) + last[0].length };
}

function compactEquivalentAt(haystack: string, needle: string, offset: number): { end: number } | null {
  const expected = comparisonText(needle).toLocaleLowerCase("en-US").replace(/\s+/gu, "");
  if (!expected) return null;
  let actual = "";
  let end = offset;
  while (end < haystack.length && actual.length < expected.length) {
    const character = haystack[end];
    if (!/\s/u.test(character)) actual += character.toLocaleLowerCase("en-US");
    end += 1;
  }
  return actual === expected ? { end } : null;
}

type MarkdownBlock = ReturnType<typeof markdownToBlocks>[number];

interface ReconciliationUnit {
  id: string;
  text: string;
  span: { start: number; end: number };
  contains_formula: boolean;
  last_block: MarkdownBlock;
}

interface IndexedPdfLine {
  page_index: number;
  page_label?: string;
  line_index: number;
  text: string;
  start: number;
  end: number;
}

interface PdfTextIndex {
  text: string;
  lines: IndexedPdfLine[];
}

function hardReconciliationBoundary(block: MarkdownBlock): boolean {
  return block.kind === "heading" || block.assetKind === "code" || block.assetKind === "table" || block.assetKind === "image";
}

function reconciliationUnits(source: string): ReconciliationUnit[] {
  const blocks = markdownToBlocks(source).filter((block) => block.text.trim().length > 0);
  const units: ReconciliationUnit[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const current = units.at(-1);
    const gap = current ? source.slice(current.span.end, block.span.start) : "";
    const touchesStandaloneFormula = Boolean(
      current
      && (current.last_block.assetKind === "formula" || block.assetKind === "formula"),
    );
    const mergeFormulaContext = Boolean(
      current
      && !hardReconciliationBoundary(current.last_block)
      && !hardReconciliationBoundary(block)
      && (
        touchesStandaloneFormula
        || (!/\n\s*\n/u.test(gap) && (current.contains_formula || block.assetKind === "formula"))
      ),
    );
    if (current && mergeFormulaContext) {
      current.span.end = block.span.end;
      current.text = source.slice(current.span.start, current.span.end);
      current.contains_formula ||= block.assetKind === "formula";
      current.last_block = block;
      continue;
    }
    units.push({
      id: `block-${index + 1}`,
      text: block.text,
      span: { ...block.span },
      contains_formula: block.assetKind === "formula",
      last_block: block,
    });
  }
  return units;
}

function buildPdfTextIndex(geometry: PdfTextGeometry): PdfTextIndex {
  const lines: IndexedPdfLine[] = [];
  let text = "";
  for (const page of geometry.pages) {
    for (const line of page.lines) {
      const normalized = comparisonText(line.text);
      if (!normalized) continue;
      const previous = lines.at(-1);
      const unwrapHyphen = Boolean(previous && /[\p{L}\p{N}]-$/u.test(text) && /^[\p{L}\p{N}]/u.test(normalized));
      if (unwrapHyphen) {
        text = text.slice(0, -1);
        previous!.end = Math.max(previous!.start, previous!.end - 1);
      } else if (text) {
        text += " ";
      }
      const start = text.length;
      text += normalized;
      lines.push({
        page_index: page.pageIndex,
        ...(page.page_label ? { page_label: page.page_label } : {}),
        line_index: line.lineIndex,
        text: line.text,
        start,
        end: text.length,
      });
    }
  }
  return { text, lines };
}

function nearestPdfLineIndex(lines: IndexedPdfLine[], offset: number): number {
  if (!lines.length) return -1;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (offset >= line.start && offset <= line.end) return index;
    const distance = Math.min(Math.abs(offset - line.start), Math.abs(offset - line.end));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function pdfEvidenceAt(index: PdfTextIndex, offset: number, length: number) {
  if (!index.lines.length) return undefined;
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, index.text.length - 1)));
  const endOffset = Math.min(index.text.length, safeOffset + Math.max(1, length));
  const firstIndex = nearestPdfLineIndex(index.lines, safeOffset);
  const lastIndex = nearestPdfLineIndex(index.lines, Math.max(safeOffset, endOffset - 1));
  const contextStart = Math.max(0, firstIndex - 1);
  const contextEnd = Math.min(index.lines.length - 1, Math.max(firstIndex, lastIndex) + 1);
  const contextLines = index.lines.slice(contextStart, contextEnd + 1);
  const first = index.lines[firstIndex];
  const last = index.lines[Math.max(firstIndex, lastIndex)];
  return {
    excerpt: index.text.slice(safeOffset, endOffset).trim(),
    context: contextLines.map((line) => line.text).join("\n").trim(),
    page_index: first.page_index,
    ...(first.page_label ? { page_label: first.page_label } : {}),
    line_start: first.line_index,
    line_end: last.line_index,
  };
}

function markdownContext(source: string, span: { start: number; end: number }): string {
  const before = source.lastIndexOf("\n\n", Math.max(0, span.start - 1));
  const after = source.indexOf("\n\n", span.end);
  const start = before >= 0 ? before + 2 : Math.max(0, span.start - 240);
  const end = after >= 0 ? after : Math.min(source.length, span.end + 240);
  return source.slice(start, end).trim();
}

function resolvedStatus(rawText: string, repairedText: string): SourceBlockReconcileStatus {
  if (basicSearchable(rawText) !== basicSearchable(repairedText)) return "auto_repaired";
  return comparisonBaseline(repairedText) === comparisonText(repairedText) ? "verified" : "format_equivalent";
}

export function reconcilePaperSource(input: ReconcilePaperSourceInput): ReconcilePaperSourceResult {
  const config: SourceReconciliationConfig = { ...DEFAULT_CONFIG, ...input.config };
  const summary = emptyReconciliationSummary();
  const unresolved: SourceReconciliationIssue[] = [];
  const pdfIndex = buildPdfTextIndex(input.pdf_geometry);
  const pdfSearch = pdfIndex.text.toLocaleLowerCase("en-US");
  const units = reconciliationUnits(input.markdown_source);
  let cursor = 0;

  for (const unit of units) {
    const repaired = safeRepairText(unit.text);
    const displayNeedle = comparisonText(repaired);
    const needle = displayNeedle.toLocaleLowerCase("en-US");
    const id = unit.id;
    if (!needle) continue;

    const from = Math.max(0, cursor - config.lookback_chars);
    const fuzzyTo = Math.min(pdfSearch.length, cursor + config.lookahead_chars);
    const foundExactOffset = pdfSearch.indexOf(needle, cursor);
    const exactOffset = foundExactOffset >= 0 && foundExactOffset <= fuzzyTo ? foundExactOffset : -1;
    if (exactOffset >= 0) {
      const status = resolvedStatus(unit.text, repaired);
      summary[status]++;
      cursor = exactOffset + needle.length;
      continue;
    }
    const uniqueOffset = (needle.length >= 12 || unit.last_block.kind === "heading")
      ? uniqueExactOffset(pdfSearch, needle)
      : null;
    if (uniqueOffset !== null && uniqueOffset >= cursor) {
      summary[resolvedStatus(unit.text, repaired)]++;
      cursor = uniqueOffset + needle.length;
      continue;
    }

    const scanned = bestFuzzyOffset(pdfSearch, needle, from, fuzzyTo);
    let candidateCursor = cursor;
    while (candidateCursor < pdfSearch.length && /\s/u.test(pdfSearch[candidateCursor])) candidateCursor++;
    const atCursor = fuzzyCandidateAt(pdfSearch, needle, candidateCursor);
    const atPrefix = fuzzyCandidateFromPrefix(pdfSearch, needle, from, fuzzyTo);
    const globalPrefix = needle.length >= 24
      ? fuzzyCandidateFromPrefix(pdfSearch, needle, 0, pdfSearch.length)
      : null;
    const fuzzy = bestCandidate([atPrefix, globalPrefix, atCursor, scanned], cursor);
    const compactEquivalent = fuzzy ? compactEquivalentAt(pdfIndex.text, displayNeedle, fuzzy.offset) : null;
    const tokenEquivalent = compactEquivalent ?? (fuzzy ? tokenEquivalentAt(pdfIndex.text, displayNeedle, fuzzy.offset) : null);
    if (tokenEquivalent && fuzzy!.offset >= cursor) {
      summary.format_equivalent++;
      cursor = Math.max(cursor, tokenEquivalent.end);
      continue;
    }
    const globalEvidence = fuzzy && fuzzy.score >= config.fuzzy_threshold
      ? null
      : globalEvidenceCandidate(pdfSearch, needle, cursor);
    const evidenceCandidate = globalEvidence && globalEvidence.score >= config.fuzzy_threshold
      ? globalEvidence
      : fuzzy;
    const evidenceOffset = evidenceCandidate?.offset ?? candidateCursor;
    const evidence = pdfEvidenceAt(pdfIndex, evidenceOffset, displayNeedle.length);
    const outsideTrustedOrder = Boolean(
      evidenceCandidate
      && (evidenceCandidate.offset < from || evidenceCandidate.offset > fuzzyTo),
    );
    const evidenceFields = {
      md_context: markdownContext(input.markdown_source, unit.span),
      ...(evidence?.context ? { pdf_context: evidence.context } : {}),
      ...(evidence ? { pdf_page_index: evidence.page_index } : {}),
      ...(evidence?.page_label ? { pdf_page_label: evidence.page_label } : {}),
      ...(evidence ? { pdf_line_start: evidence.line_start, pdf_line_end: evidence.line_end } : {}),
      ...(evidenceCandidate ? { comparison_score: Number(evidenceCandidate.score.toFixed(3)) } : {}),
    };
    if (evidenceCandidate && evidenceCandidate.score >= config.fuzzy_threshold) {
      const pdfExcerpt = evidence?.excerpt;
      const difference = pdfExcerpt ? firstTokenDifference(unit.text, pdfExcerpt) : undefined;
      summary.needs_review++;
      unresolved.push({
        id,
        status: "needs_review",
        reason: outsideTrustedOrder
          ? "candidate found outside trusted PDF text order"
          : `fuzzy match score ${evidenceCandidate.score.toFixed(2)} below trusted exact-match gate`,
        source_span: unit.span,
        md_excerpt: unit.text,
        review_question: outsideTrustedOrder && !difference
          ? "PDF 中找到了相同文字，但位置不符合当前正文顺序，请确认是否为同一处内容。"
          : "Markdown 与 PDF 的内容不同，请确认可信正文应采用哪一版。",
        ...evidenceFields,
        ...(difference ? { difference } : {}),
        ...(pdfExcerpt ? { pdf_excerpt: pdfExcerpt, candidate_text: pdfExcerpt } : {}),
      });
    } else {
      const hasCandidate = Boolean(evidenceCandidate && evidenceCandidate.score >= 0.15 && evidence?.excerpt);
      const pdfExcerpt = hasCandidate ? evidence?.excerpt : undefined;
      const difference = pdfExcerpt ? firstTokenDifference(unit.text, pdfExcerpt) : undefined;
      summary.md_unmatched++;
      unresolved.push({
        id,
        status: "md_unmatched",
        reason: "markdown block was not found in PDF text order",
        source_span: unit.span,
        md_excerpt: unit.text,
        review_question: hasCandidate
          ? "系统只找到低置信度的 PDF 候选，请对照上下文确认可信正文。"
          : "系统未能在 PDF 提取文本中可靠定位这段 Markdown，请对照当前 PDF 上下文确认。",
        ...evidenceFields,
        ...(difference ? { difference } : {}),
        ...(pdfExcerpt ? { pdf_excerpt: pdfExcerpt, candidate_text: pdfExcerpt } : {}),
      });
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
      version: "source_review_decisions.v1",
      book_id: input.book_id,
      stage: "source_reconciliation",
      input_fingerprint: input.input_fingerprint,
      decisions: [],
    },
  };
}

export function buildReviewedDraftFromDecisions(
  markdownSource: string,
  report: SourceReconciliationReport,
  artifact: SourceReconciliationReviewDecisions,
): { reviewed_draft: string; decisions: SourceReviewDecision[] } {
  if (artifact.book_id !== report.book_id) {
    throw new Error(`review decisions book_id ${artifact.book_id} does not match report ${report.book_id}`);
  }
  const unresolvedIds = new Set(report.unresolved.map((issue) => issue.id));
  const decisionsByBlock = new Map(artifact.decisions.map((decision) => [decision.block_id, decision]));
  for (const decision of artifact.decisions) {
    if (!unresolvedIds.has(decision.block_id)) {
      throw new Error(`review decision references unknown block: ${decision.block_id}`);
    }
  }

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const issue of report.unresolved) {
    const decision = decisionsByBlock.get(issue.id);
    if (!decision) throw new Error(`missing decision for unresolved block: ${issue.id}`);
    if (decision.decision === "keep_blocked") throw new Error(`source review block remains blocked: ${issue.id}`);
    if (!issue.source_span) throw new Error(`source review block lacks source_span: ${issue.id}`);

    let replacement: string | undefined;
    if (decision.decision === "accept_markdown") replacement = issue.md_excerpt;
    if (decision.decision === "accept_pdf") replacement = issue.pdf_excerpt;
    if (decision.decision === "use_candidate") replacement = issue.candidate_text;
    if (decision.decision === "manual_edit") replacement = decision.replacement_text;
    if (replacement === undefined) {
      throw new Error(`${decision.decision} has no evidence text for block: ${issue.id}`);
    }
    if (decision.decision === "manual_edit" && !replacement.trim()) {
      throw new Error(`manual_edit requires replacement_text for block: ${issue.id}`);
    }
    replacements.push({ ...issue.source_span, text: replacement });
  }

  let reviewedDraft = markdownSource;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    reviewedDraft = `${reviewedDraft.slice(0, replacement.start)}${replacement.text}${reviewedDraft.slice(replacement.end)}`;
  }
  return { reviewed_draft: reviewedDraft, decisions: artifact.decisions };
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
    version: "source_review_decisions.v1",
    book_id: input.book_id,
    stage: "source_reconciliation",
    input_fingerprint: input.input_fingerprint,
    decisions: input.decisions ?? [],
  };
  const accepted = sourceReconciliationTrusted(reconciliation.report);
  return {
    accepted,
    ...(accepted ? {} : { reason: "review candidate still has unresolved reconciliation blocks" }),
    reconciliation,
  };
}

export function acceptSourceReconciliationManualOverride(
  result: ReconcilePaperSourceResult,
  reviewedDraft: string,
  acceptedAt: string,
): ReconcilePaperSourceResult {
  if (sourceReconciliationTrusted(result.report)) {
    throw new Error("manual override requires residual unresolved reconciliation blocks");
  }
  if (!acceptedAt.trim()) throw new Error("manual override requires accepted_at");
  const decisionCount = result.review_decisions.decisions.length;
  if (!decisionCount) throw new Error("manual override requires persisted review decisions");
  return {
    ...result,
    report: {
      ...result.report,
      acceptance: {
        mode: "manual_override",
        policy: "single_review_then_override_v1",
        accepted_at: acceptedAt,
        residual_unresolved_count: result.report.unresolved.length,
        decision_count: decisionCount,
      },
    },
    reconciled_source: safeRepairText(reviewedDraft),
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
