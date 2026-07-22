import {
  parseMarkdownSourceBlocks,
  type MarkdownAlignmentContext,
  type MarkdownDisplayRole,
  type MarkdownDisplaySegment,
} from "./md-adapter";
import {
  buildFormulaGlyphPlan,
  findFormulaGlyphMatches,
  formulaGlyphKeys,
  PDF_FORMULA_GLYPH_POLICY,
} from "./formula-glyph-projection";
import { parseFormulaSourceAst } from "./formula-source-ast";
import { PDF_ASSET_REGION_POLICY, projectImageObjectRegions } from "./image-object-projection";
import type { PdfGeometryChar, PdfGeometryPage, PdfTextGeometry } from "./pdf-geometry";
import type { PdfRegion } from "./pdf-source-map";
import { segment } from "./segment";
import { sourceComparisonText } from "./source-reconciliation";
import type { SourceAlignmentEvidenceV1 } from "./source-alignment-evidence";

export type HybridAlignmentChildKind = "text" | "formula" | "image" | "table" | "code";
export type PdfProjectionPrecision = "char_exact" | "region_exact" | "partial" | "unmapped";

export const HYBRID_ALIGNMENT_UNIT_POLICY = {
  version: "hybrid_alignment_unit_policy.v1",
  max_children: 24,
  max_source_utf16: 1_200,
  max_searchable_tokens: 240,
} as const;

export const PDF_DISPLAY_TOKEN_POLICY = {
  version: "pdf_display_token_policy.v1",
} as const;

export const PDF_FORMULA_REGION_POLICY = {
  version: "pdf_formula_region_policy.v1",
} as const;

export { PDF_FORMULA_GLYPH_POLICY };
export { PDF_ASSET_REGION_POLICY };

export interface HybridAlignmentUnit {
  unit_id: string;
  policy_version: typeof HYBRID_ALIGNMENT_UNIT_POLICY.version;
  source_span: { start: number; end: number };
  diagnostic: "within_guard" | "oversize_singleton";
  metrics: {
    child_count: number;
    source_utf16_length: number;
    searchable_token_count: number;
  };
  child_lids: Array<{
    lid: string;
    source_span: { start: number; end: number };
    kind: HybridAlignmentChildKind;
  }>;
}

export interface HybridAlignmentUnitAuditAnalysis {
  units: HybridAlignmentUnit[];
  passed: boolean;
  summary: {
    unit_count: number;
    child_count: number;
    within_guard_count: number;
    oversize_singleton_count: number;
    oversized_multi_child_unit_count: number;
    boundary_violation_count: number;
    max_child_count: number;
    max_source_utf16_length: number;
    max_searchable_token_count: number;
  };
  coverage: {
    expected_leaf_count: number;
    mapped_child_count: number;
    missing_lids: string[];
    duplicate_lids: string[];
    unexpected_lids: string[];
  };
}

export interface PdfAlignmentLine {
  alignment_line_id: string;
  pageIndex: number;
  lineIndex: number;
  segmentIndex: number;
  column: 0 | 1 | 2;
  text: string;
  bbox: [number, number, number, number];
  chars: PdfGeometryChar[];
}

export interface LocatedHybridAlignmentUnit {
  unit: HybridAlignmentUnit;
  status: "located" | "unmapped";
  reason: string;
  lines: PdfAlignmentLine[];
  token_span?: { start: number; end: number };
}

export interface HybridChildProjection {
  lid: string;
  source_span: { start: number; end: number };
  precision: PdfProjectionPrecision;
  regions: PdfRegion[];
  exact_source_spans: Array<{ start: number; end: number }>;
  selection_assignments: Array<{
    pageIndex: number;
    char_index: number;
    text: string;
    rect: { pageIndex: number; bbox: [number, number, number, number] };
    source_span: { start: number; end: number };
  }>;
  formula_display_text?: string;
  primary_region?: PdfRegion;
  alignment: { unit_id: string; reason: string };
}

interface OrderedToken {
  token: string;
  line: PdfAlignmentLine;
}

interface PdfCharKey {
  key: string;
  char: PdfGeometryChar;
  line: PdfAlignmentLine;
}

interface ProjectedKeyRange {
  start: number;
  end: number;
  chars: PdfCharKey[];
  source_spans: Array<{ start: number; end: number }>;
  has_unmatched_material_pdf?: boolean;
}

function spanKey(span: { start: number; end: number }): string {
  return `${span.start}:${span.end}`;
}

function alignmentTokens(text: string): string[] {
  return sourceComparisonText(text)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/([\p{L}\p{N}])[\p{Pd}\u00ad]\s+(?=[\p{L}\p{N}])/gu, "$1")
    .replace(/[\p{Pd}\u00ad]/gu, "")
    .match(/[\p{L}\p{N}]+|[×·≤≥≠≈≳≲≫≪∈⊂⊆⊃⊇⊗∑∏√∂∇=+\-/*°%]/gu) ?? [];
}

function childKind(assetKind: string | undefined): HybridAlignmentChildKind {
  if (assetKind === "formula") return "formula";
  if (assetKind === "image") return "image";
  if (assetKind === "table") return "table";
  if (assetKind === "code") return "code";
  return "text";
}

function contextKey(context: MarkdownAlignmentContext): string {
  return `${context.kind}:${spanKey(context.source_span)}`;
}

export function formHybridAlignmentUnits(source: string): HybridAlignmentUnit[] {
  const parsed = parseMarkdownSourceBlocks(source);
  const blocks = parsed.blocks.filter((block) => block.text.trim().length > 0);
  const nodes = segment(blocks);
  const lidBySpan = new Map(nodes
    .filter((node) => node.children.length === 0)
    .map((node) => [spanKey(node.span), node.lid]));
  const contexts = [...parsed.alignment_contexts]
    .sort((left, right) => (left.source_span.end - left.source_span.start) - (right.source_span.end - right.source_span.start));
  const blockContext = (block: typeof blocks[number]) => contexts.find((context) => (
    context.source_span.start <= block.span.start && context.source_span.end >= block.span.end
  ));
  const groupMetrics = (group: typeof blocks) => ({
    child_count: group.length,
    source_utf16_length: group.at(-1)!.span.end - group[0].span.start,
    searchable_token_count: alignmentTokens(group.map((block) => block.text).join(" ")).length,
  });
  const withinGuard = (group: typeof blocks) => {
    const metrics = groupMetrics(group);
    return metrics.child_count <= HYBRID_ALIGNMENT_UNIT_POLICY.max_children
      && metrics.source_utf16_length <= HYBRID_ALIGNMENT_UNIT_POLICY.max_source_utf16
      && metrics.searchable_token_count <= HYBRID_ALIGNMENT_UNIT_POLICY.max_searchable_tokens;
  };
  const grouped: Array<typeof blocks> = [];
  let current: typeof blocks = [];
  let currentContextKey: string | undefined;
  const flush = () => {
    if (current.length) grouped.push(current);
    current = [];
    currentContextKey = undefined;
  };
  for (const block of blocks) {
    const context = blockContext(block);
    const key = context ? contextKey(context) : undefined;
    if (!key) {
      flush();
      grouped.push([block]);
      continue;
    }
    if (currentContextKey !== key) flush();
    currentContextKey = key;
    if (current.length && !withinGuard([...current, block])) flush();
    currentContextKey = key;
    current.push(block);
    if (!withinGuard(current)) flush();
  }
  flush();
  return grouped.map((group, index) => {
    const metrics = groupMetrics(group);
    return {
      unit_id: `unit-${index + 1}`,
      policy_version: HYBRID_ALIGNMENT_UNIT_POLICY.version,
      source_span: { start: group[0].span.start, end: group.at(-1)!.span.end },
      diagnostic: !withinGuard(group) && group.length === 1 ? "oversize_singleton" : "within_guard",
      metrics,
      child_lids: group.map((block) => ({
        lid: lidBySpan.get(spanKey(block.span))!,
        source_span: { ...block.span },
        kind: childKind(block.assetKind),
      })),
    };
  });
}

export function auditHybridAlignmentUnits(source: string): HybridAlignmentUnitAuditAnalysis {
  const parsed = parseMarkdownSourceBlocks(source);
  const expectedLeaves = segment(parsed.blocks).filter((node) => node.children.length === 0);
  const units = formHybridAlignmentUnits(source);
  const children = units.flatMap((unit) => unit.child_lids);
  const childLidCounts = new Map<string, number>();
  for (const child of children) childLidCounts.set(child.lid, (childLidCounts.get(child.lid) ?? 0) + 1);
  const expectedLids = new Set(expectedLeaves.map((leaf) => leaf.lid));
  const actualLids = new Set(children.map((child) => child.lid));
  const boundaryViolations = units.filter((unit) => {
    if (unit.child_lids.length <= 1) return false;
    return !parsed.alignment_contexts.some((context) => unit.child_lids.every((child) => (
      context.source_span.start <= child.source_span.start && context.source_span.end >= child.source_span.end
    )));
  });
  const oversizedMultiChildUnits = units.filter((unit) => unit.child_lids.length > 1 && (
    unit.metrics.child_count > HYBRID_ALIGNMENT_UNIT_POLICY.max_children
    || unit.metrics.source_utf16_length > HYBRID_ALIGNMENT_UNIT_POLICY.max_source_utf16
    || unit.metrics.searchable_token_count > HYBRID_ALIGNMENT_UNIT_POLICY.max_searchable_tokens
  ));
  const coverage = {
    expected_leaf_count: expectedLeaves.length,
    mapped_child_count: children.length,
    missing_lids: [...expectedLids].filter((lid) => !actualLids.has(lid)).sort(),
    duplicate_lids: [...childLidCounts.entries()].filter(([, count]) => count > 1).map(([lid]) => lid).sort(),
    unexpected_lids: [...actualLids].filter((lid) => !expectedLids.has(lid)).sort(),
  };
  return {
    units,
    passed: boundaryViolations.length === 0
      && oversizedMultiChildUnits.length === 0
      && coverage.missing_lids.length === 0
      && coverage.duplicate_lids.length === 0
      && coverage.unexpected_lids.length === 0,
    summary: {
      unit_count: units.length,
      child_count: children.length,
      within_guard_count: units.filter((unit) => unit.diagnostic === "within_guard").length,
      oversize_singleton_count: units.filter((unit) => unit.diagnostic === "oversize_singleton").length,
      oversized_multi_child_unit_count: oversizedMultiChildUnits.length,
      boundary_violation_count: boundaryViolations.length,
      max_child_count: Math.max(0, ...units.map((unit) => unit.metrics.child_count)),
      max_source_utf16_length: Math.max(0, ...units
        .filter((unit) => unit.child_lids.length > 1)
        .map((unit) => unit.metrics.source_utf16_length)),
      max_searchable_token_count: Math.max(0, ...units
        .filter((unit) => unit.child_lids.length > 1)
        .map((unit) => unit.metrics.searchable_token_count)),
    },
    coverage,
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function bboxForChars(chars: PdfGeometryChar[]): [number, number, number, number] {
  return [
    Math.min(...chars.map((char) => char.bbox[0])),
    Math.min(...chars.map((char) => char.bbox[1])),
    Math.max(...chars.map((char) => char.bbox[2])),
    Math.max(...chars.map((char) => char.bbox[3])),
  ];
}

function trimCharGroup(chars: PdfGeometryChar[]): PdfGeometryChar[] {
  let start = 0;
  let end = chars.length;
  while (start < end && /^\s+$/u.test(chars[start].text)) start += 1;
  while (end > start && /^\s+$/u.test(chars[end - 1].text)) end -= 1;
  return chars.slice(start, end);
}

function splitGeometryLine(page: PdfGeometryPage, lineIndex: number): PdfAlignmentLine[] {
  const line = page.lines[lineIndex];
  const chars = page.chars
    .filter((char) => char.charIndex >= line.char_start && char.charIndex < line.char_end)
    .sort((left, right) => left.charIndex - right.charIndex);
  if (!chars.length) {
    return [{
      alignment_line_id: `${page.pageIndex}:${line.lineIndex}:0`,
      pageIndex: page.pageIndex,
      lineIndex: line.lineIndex,
      segmentIndex: 0,
      column: 0,
      text: line.text,
      bbox: line.bbox,
      chars: [],
    }];
  }
  const normalWidths = chars
    .filter((char) => !/^\s+$/u.test(char.text))
    .map((char) => char.bbox[2] - char.bbox[0])
    .filter((width) => width > 0);
  const splitThreshold = Math.max(median(normalWidths) * 4, page.width * 0.03, 16);
  const groups: PdfGeometryChar[][] = [[]];
  for (const char of chars) {
    const current = groups.at(-1)!;
    const previous = current.at(-1);
    const gap = previous ? char.bbox[0] - previous.bbox[2] : 0;
    const wideWhitespace = /^\s+$/u.test(char.text) && char.bbox[2] - char.bbox[0] > splitThreshold;
    if ((wideWhitespace || gap > splitThreshold) && current.length) {
      if (!wideWhitespace) groups.push([char]);
      else groups.push([]);
    } else if (!wideWhitespace) {
      current.push(char);
    }
  }
  const pageMidpoint = (page.view[0] + page.view[2]) / 2;
  const pageWidth = page.view[2] - page.view[0];
  return groups
    .map(trimCharGroup)
    .filter((group) => group.length > 0)
    .map((group, segmentIndex) => {
      const bbox = bboxForChars(group);
      const width = bbox[2] - bbox[0];
      const crossesMidpoint = bbox[0] < pageMidpoint && bbox[2] > pageMidpoint;
      const column: 0 | 1 | 2 = width >= pageWidth * 0.45 || (crossesMidpoint && width >= pageWidth * 0.35)
        ? 0
        : (bbox[0] + bbox[2]) / 2 < pageMidpoint ? 1 : 2;
      return {
        alignment_line_id: `${page.pageIndex}:${line.lineIndex}:${segmentIndex}`,
        pageIndex: page.pageIndex,
        lineIndex: line.lineIndex,
        segmentIndex,
        column,
        text: group.map((char) => char.text).join(""),
        bbox,
        chars: group,
      };
    });
}

function pageAlignmentLines(page: PdfGeometryPage): PdfAlignmentLine[] {
  const maxLineHeight = Math.max(30, page.height * 0.08);
  const segments = page.lines
    .flatMap((_line, index) => splitGeometryLine(page, index))
    .filter((line) => line.bbox[0] >= 0
      && line.bbox[1] >= 0
      && line.bbox[2] <= page.width
      && line.bbox[3] <= page.height
      && line.bbox[3] - line.bbox[1] <= maxLineHeight);
  const visualOrder = (left: PdfAlignmentLine, right: PdfAlignmentLine) => (
    right.bbox[3] - left.bbox[3]
    || left.bbox[0] - right.bbox[0]
    || left.lineIndex - right.lineIndex
  );
  const left = segments.filter((line) => line.column === 1);
  const right = segments.filter((line) => line.column === 2);
  const hasStableTwoColumnLayout = left.length >= 2 && right.length >= 2;
  if (!hasStableTwoColumnLayout) return [...segments].sort(visualOrder);

  const spanning = segments.filter((line) => line.column === 0).sort(visualOrder);
  const narrow = segments.filter((line) => line.column !== 0);
  const companionsByBoundary = new Map<string, PdfAlignmentLine[]>();
  const companionIds = new Set<string>();
  for (const line of narrow) {
    const lineHeight = line.bbox[3] - line.bbox[1];
    const candidates = spanning
      .filter((boundary) => {
        const boundaryHeight = boundary.bbox[3] - boundary.bbox[1];
        const rowHeight = Math.max(lineHeight, boundaryHeight);
        const lineY = (line.bbox[1] + line.bbox[3]) / 2;
        const boundaryY = (boundary.bbox[1] + boundary.bbox[3]) / 2;
        const sameVisualRow = Math.abs(lineY - boundaryY) <= rowHeight * 1.25;
        const continuesToRight = line.bbox[0] >= boundary.bbox[2] - rowHeight;
        return sameVisualRow && continuesToRight;
      })
      .sort((leftBoundary, rightBoundary) => {
        const gap = (boundary: PdfAlignmentLine) => Math.min(
          Math.abs(line.bbox[0] - boundary.bbox[2]),
          Math.abs(boundary.bbox[0] - line.bbox[2]),
        );
        return gap(leftBoundary) - gap(rightBoundary) || visualOrder(leftBoundary, rightBoundary);
      });
    const boundary = candidates[0];
    if (!boundary) continue;
    const companions = companionsByBoundary.get(boundary.alignment_line_id) ?? [];
    companions.push(line);
    companionsByBoundary.set(boundary.alignment_line_id, companions);
    companionIds.add(line.alignment_line_id);
  }
  const zonedNarrow = narrow.filter((line) => !companionIds.has(line.alignment_line_id));
  const ordered: PdfAlignmentLine[] = [];
  let upperBoundary = Number.POSITIVE_INFINITY;
  for (const boundary of spanning) {
    const boundaryY = (boundary.bbox[1] + boundary.bbox[3]) / 2;
    const zone = zonedNarrow.filter((line) => {
      const lineY = (line.bbox[1] + line.bbox[3]) / 2;
      return lineY < upperBoundary && lineY > boundaryY;
    });
    ordered.push(
      ...zone.filter((line) => line.column === 1).sort(visualOrder),
      ...zone.filter((line) => line.column === 2).sort(visualOrder),
      ...[boundary, ...(companionsByBoundary.get(boundary.alignment_line_id) ?? [])]
        .sort((leftLine, rightLine) => leftLine.bbox[0] - rightLine.bbox[0] || visualOrder(leftLine, rightLine)),
    );
    upperBoundary = boundaryY;
  }
  const tail = zonedNarrow.filter((line) => (line.bbox[1] + line.bbox[3]) / 2 < upperBoundary);
  ordered.push(
    ...tail.filter((line) => line.column === 1).sort(visualOrder),
    ...tail.filter((line) => line.column === 2).sort(visualOrder),
  );
  return ordered;
}

export function pdfAlignmentLines(geometry: PdfTextGeometry): PdfAlignmentLine[] {
  return [...geometry.pages]
    .sort((left, right) => left.pageIndex - right.pageIndex)
    .flatMap(pageAlignmentLines);
}

function unitSearchText(
  unit: HybridAlignmentUnit,
  blockTextBySpan: Map<string, string>,
): string {
  return unit.child_lids.map((child) => blockTextBySpan.get(spanKey(child.source_span)) ?? "").join(" ");
}

function displayTextByBlockSpan(
  blocks: ReturnType<typeof parseMarkdownSourceBlocks>["blocks"],
  displaySegments: MarkdownDisplaySegment[],
): Map<string, string> {
  return new Map(blocks.map((block) => {
    const visible = displaySegments
      .filter((segment) => (
        segment.source_span.start >= block.span.start && segment.source_span.end <= block.span.end
      ))
      .map((segment) => segment.display_text)
      .join("");
    return [spanKey(block.span), visible || block.text];
  }));
}

function tokenOccurrences(haystack: OrderedToken[], needle: string[], startAt: number): Array<{ start: number; end: number }> {
  const occurrences: Array<{ start: number; end: number }> = [];
  for (let start = startAt; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset].token === token)) {
      occurrences.push({ start, end: start + needle.length });
    }
  }
  return occurrences;
}

function anchorCandidates(
  tokens: OrderedToken[],
  childTokenGroups: string[][],
  startAt: number,
): Array<{ start: number; end: number }> {
  const searchable = childTokenGroups.filter((group) => group.length > 0);
  if (!searchable.length) return [];
  const firstGroup = searchable[0];
  const lastGroup = searchable.at(-1)!;
  const firstAnchor = firstGroup.slice(0, Math.min(12, firstGroup.length));
  const lastAnchor = lastGroup.slice(Math.max(0, lastGroup.length - 12));
  const firstOccurrences = tokenOccurrences(tokens, firstAnchor, startAt);
  if (searchable.length === 1 && firstAnchor.length === firstGroup.length && lastAnchor.length === lastGroup.length) {
    return firstOccurrences;
  }
  const lastOccurrences = tokenOccurrences(tokens, lastAnchor, startAt);
  const candidates: Array<{ start: number; end: number }> = [];
  for (const first of firstOccurrences) {
    const following = lastOccurrences.filter((last) => (
      last.start >= first.start
      && last.end >= first.end
      && last.end - first.start <= 2_000
    ));
    if (following.length === 1) candidates.push({ start: first.start, end: following[0].end });
  }
  return candidates;
}

function evidenceSeed(
  evidence: SourceAlignmentEvidenceV1 | undefined,
  unit: HybridAlignmentUnit,
  lines: PdfAlignmentLine[],
): { line_ids: Set<string>; status: "verified" | "format_equivalent" | "reviewed_hint" } | null {
  const item = evidence?.units.find((candidate) => spanKey(candidate.source_span) === spanKey(unit.source_span));
  if (!item || item.status === "unmapped" || !item.pdf_line_spans.length) return null;
  return {
    status: item.status,
    line_ids: new Set(lines
    .filter((line) => item.pdf_line_spans.some((span) => (
      line.pageIndex === span.pageIndex
      && line.lineIndex >= span.start_line_index
      && line.lineIndex <= span.end_line_index
    )))
    .map((line) => line.alignment_line_id)),
  };
}

export function locateHybridAlignmentUnits(
  source: string,
  units: HybridAlignmentUnit[],
  geometry: PdfTextGeometry,
  evidence?: SourceAlignmentEvidenceV1,
): LocatedHybridAlignmentUnit[] {
  const parsed = parseMarkdownSourceBlocks(source);
  const blockTextBySpan = displayTextByBlockSpan(parsed.blocks, parsed.display_segments);
  const lines = pdfAlignmentLines(geometry);
  const tokens: OrderedToken[] = lines.flatMap((line) => alignmentTokens(line.text).map((token) => ({ token, line })));
  const locations: LocatedHybridAlignmentUnit[] = [];
  let tokenCursor = 0;
  for (const unit of units) {
    const unitTokens = alignmentTokens(unitSearchText(unit, blockTextBySpan));
    if (!unitTokens.length) {
      locations.push({ unit, status: "unmapped", reason: "alignment unit has no searchable tokens", lines: [] });
      continue;
    }
    const seed = evidenceSeed(evidence, unit, lines);
    const exactOccurrences = tokenOccurrences(tokens, unitTokens, tokenCursor);
    const childTokenGroups = unit.child_lids
      .filter((child) => child.kind === "text" || child.kind === "code")
      .map((child) => alignmentTokens(blockTextBySpan.get(spanKey(child.source_span)) ?? ""));
    let rawOccurrences = exactOccurrences.length
      ? exactOccurrences
      : anchorCandidates(tokens, childTokenGroups, tokenCursor);
    if (!rawOccurrences.length && seed?.line_ids.size) {
      const seededIndexes = tokens
        .map((token, index) => ({ token, index }))
        .filter((item) => item.index >= tokenCursor && seed.line_ids.has(item.token.line.alignment_line_id));
      if (seededIndexes.length) {
        const start = seededIndexes[0].index;
        const end = seededIndexes.at(-1)!.index + 1;
        const seededTokens = tokens.slice(start, end).map((item) => item.token);
        const similarity = alignmentPairs(
          unitTokens.map((key) => ({ key })),
          seededTokens.map((key) => ({ key })),
        ).length / unitTokens.length;
        const threshold = seed.status === "reviewed_hint" ? 0.7 : 0.5;
        if (similarity >= threshold) rawOccurrences = [{ start, end }];
      }
    }
    const occurrences = rawOccurrences
      .filter((occurrence) => {
        if (!seed?.line_ids.size) return true;
        const occurrenceLines = tokens.slice(occurrence.start, occurrence.end).map((token) => token.line.alignment_line_id);
        return occurrenceLines.some((lineId) => seed.line_ids.has(lineId));
      });
    if (occurrences.length !== 1) {
      locations.push({
        unit,
        status: "unmapped",
        reason: occurrences.length ? "alignment unit has ambiguous forward candidates" : "alignment unit has no exact monotonic candidate",
        lines: [],
      });
      continue;
    }
    const occurrence = occurrences[0];
    const matchedLines = [...new Map(tokens
      .slice(occurrence.start, occurrence.end)
      .map((token) => [token.line.alignment_line_id, token.line])).values()];
    locations.push({
      unit,
      status: "located",
      reason: seed?.line_ids.size
        ? "unique deterministic match inside fingerprint-bound evidence"
        : exactOccurrences.length
          ? "unique exact monotonic unit match"
          : "unique monotonic first/last text-anchor match",
      lines: matchedLines,
      token_span: occurrence,
    });
    tokenCursor = occurrence.end;
  }
  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index];
    if (location.status !== "located" || !location.token_span) continue;
    const next = locations.slice(index + 1).find((candidate) => candidate.status === "located" && candidate.token_span);
    const end = next?.token_span?.start ?? location.token_span.end;
    const matchedLines = [...new Map(tokens
      .slice(location.token_span.start, Math.max(location.token_span.end, end))
      .map((token) => [token.line.alignment_line_id, token.line])).values()];
    location.lines = matchedLines;
  }
  return locations;
}

function normalizedCharacterKeys(
  value: string,
  role: MarkdownDisplayRole | "formula" = "prose",
): string[] {
  const keys: string[] = [];
  for (const rawChar of value) {
    if (role === "code") {
      keys.push(rawChar);
      continue;
    }
    if (/^[\u002d\u00ad\u2010\u2011]$/u.test(rawChar)) {
      keys.push("-");
      continue;
    }
    if (role !== "formula" && /^[\u0027\u2018\u2019]$/u.test(rawChar)) {
      keys.push("'");
      continue;
    }
    if (role !== "formula" && /^[\u0022\u201c\u201d]$/u.test(rawChar)) {
      keys.push("\"");
      continue;
    }
    for (const char of rawChar.normalize("NFKC").toLocaleLowerCase("en-US")) {
      keys.push(/^\s$/u.test(char) ? " " : char);
    }
  }
  return keys;
}

function displayCharacterKeys(
  source: string,
  child: HybridAlignmentUnit["child_lids"][number],
  displaySegments: MarkdownDisplaySegment[],
) {
  const units: Array<{ key: string; source_span: { start: number; end: number } }> = [];
  const segments = displaySegments.filter((segment) => (
    segment.source_span.start >= child.source_span.start && segment.source_span.end <= child.source_span.end
  ));
  for (const segment of segments) {
    const raw = source.slice(segment.source_span.start, segment.source_span.end);
    const relativeStart = raw === segment.display_text
      ? 0
      : raw.indexOf(segment.display_text) >= 0 && raw.indexOf(segment.display_text, raw.indexOf(segment.display_text) + 1) < 0
        ? raw.indexOf(segment.display_text)
        : -1;
    if (relativeStart < 0) continue;
    let offset = segment.source_span.start + relativeStart;
    for (const char of segment.display_text) {
      const sourceSpan = { start: offset, end: offset + char.length };
      for (const key of normalizedCharacterKeys(char, segment.role)) units.push({ key, source_span: sourceSpan });
      offset += char.length;
    }
  }
  const firstVisible = units.findIndex((unit) => unit.key !== " ");
  if (firstVisible < 0) return [];
  let lastVisible = units.length - 1;
  while (lastVisible > firstVisible && units[lastVisible].key === " ") lastVisible -= 1;
  return units.slice(firstVisible, lastVisible + 1);
}

function alignmentPairs<T extends { key: string }, U extends { key: string }>(
  left: T[],
  right: U[],
): Array<[number, number]> {
  if (!left.length || !right.length) return [];
  if (left.length * right.length > 8_000_000) {
    const pairs: Array<[number, number]> = [];
    let rightCursor = 0;
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const rightIndex = right.findIndex((item, index) => index >= rightCursor && item.key === left[leftIndex].key);
      if (rightIndex < 0) continue;
      pairs.push([leftIndex, rightIndex]);
      rightCursor = rightIndex + 1;
    }
    return pairs;
  }
  const width = right.length;
  const directions = new Uint8Array(left.length * width);
  let previous = new Uint32Array(width + 1);
  let current = new Uint32Array(width + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= width; rightIndex += 1) {
      const directionIndex = (leftIndex - 1) * width + rightIndex - 1;
      if (left[leftIndex - 1].key === right[rightIndex - 1].key) {
        current[rightIndex] = previous[rightIndex - 1] + 1;
        directions[directionIndex] = 1;
      } else if (previous[rightIndex] >= current[rightIndex - 1]) {
        current[rightIndex] = previous[rightIndex];
        directions[directionIndex] = 2;
      } else {
        current[rightIndex] = current[rightIndex - 1];
        directions[directionIndex] = 3;
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  const pairs: Array<[number, number]> = [];
  let leftIndex = left.length;
  let rightIndex = right.length;
  while (leftIndex > 0 && rightIndex > 0) {
    const direction = directions[(leftIndex - 1) * width + rightIndex - 1];
    if (direction === 1) {
      pairs.push([leftIndex - 1, rightIndex - 1]);
      leftIndex -= 1;
      rightIndex -= 1;
    } else if (direction === 2) leftIndex -= 1;
    else rightIndex -= 1;
  }
  return pairs.reverse();
}

function mergeSourceSpans(spans: Array<{ start: number; end: number }>) {
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of [...spans].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const current = merged.at(-1);
    if (current && span.start <= current.end) current.end = Math.max(current.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function pdfCharKeys(lines: PdfAlignmentLine[], role: MarkdownDisplayRole | "formula" = "prose"): PdfCharKey[] {
  return lines.flatMap((line) => line.chars.flatMap((char) => (
    normalizedCharacterKeys(char.text, role).map((key) => ({ key, char, line }))
  )));
}

function isDiscretionaryLineEndHyphen(keys: PdfCharKey[], index: number): boolean {
  const current = keys[index];
  if (!current || !/^[\u002d\u00ad\u2010\u2011]$/u.test(current.char.text)) return false;
  const previous = [...keys.slice(0, index)].reverse()
    .find((item) => item.key !== " " && item.line.alignment_line_id === current.line.alignment_line_id);
  const following = keys.slice(index + 1).find((item) => item.key !== " ");
  if (!previous || !following || following.line.alignment_line_id === current.line.alignment_line_id) return false;
  if (keys.slice(index + 1).some((item) => (
    item.key !== " " && item.line.alignment_line_id === current.line.alignment_line_id
  ))) return false;
  return current.line.pageIndex === following.line.pageIndex
    && current.line.column === following.line.column
    && following.line.lineIndex > current.line.lineIndex
    && /^[\p{L}\p{N}]$/u.test(previous.key)
    && /^[\p{L}\p{N}]$/u.test(following.key);
}

function hasUnmatchedMaterialPdfKeys(keys: PdfCharKey[], pairs: Array<[number, number]>): boolean {
  if (!pairs.length) return false;
  const matched = new Set(pairs.map(([, pdfIndex]) => pdfIndex));
  const start = pairs[0][1];
  const end = pairs.at(-1)![1];
  for (let index = start; index <= end; index += 1) {
    if (matched.has(index) || keys[index].key === " " || isDiscretionaryLineEndHyphen(keys, index)) continue;
    return true;
  }
  return false;
}

function sourceSpansWithLineBreakWhitespace(
  sourceKeys: ReturnType<typeof displayCharacterKeys>,
  pdfKeys: PdfCharKey[],
  pairs: Array<[number, number]>,
): Array<{ start: number; end: number }> {
  const spans = pairs.map(([sourceIndex]) => ({ ...sourceKeys[sourceIndex].source_span }));
  for (let pairIndex = 0; pairIndex + 1 < pairs.length; pairIndex += 1) {
    const [leftSourceIndex, leftPdfIndex] = pairs[pairIndex];
    const [rightSourceIndex, rightPdfIndex] = pairs[pairIndex + 1];
    if (rightSourceIndex <= leftSourceIndex + 1 || rightPdfIndex !== leftPdfIndex + 1) continue;
    const skippedSource = sourceKeys.slice(leftSourceIndex + 1, rightSourceIndex);
    if (!skippedSource.length || skippedSource.some((item) => item.key !== " ")) continue;
    const left = pdfKeys[leftPdfIndex];
    const right = pdfKeys[rightPdfIndex];
    const leftLineStart = left.line.chars[0]?.bbox[0];
    const rightLineStart = right.line.chars[0]?.bbox[0];
    const lineHeight = Math.max(
      left.char.bbox[3] - left.char.bbox[1],
      right.char.bbox[3] - right.char.bbox[1],
    );
    const sameColumn = left.line.column === right.line.column || (
      leftLineStart !== undefined
      && rightLineStart !== undefined
      && Math.abs(leftLineStart - rightLineStart) <= Math.max(2, lineHeight * 2)
    );
    if (
      left.key === " "
      || right.key === " "
      || left.line.alignment_line_id === right.line.alignment_line_id
      || left.line.pageIndex !== right.line.pageIndex
      || !sameColumn
      || right.line.lineIndex !== left.line.lineIndex + 1
    ) continue;
    spans[pairIndex].end = skippedSource.at(-1)!.source_span.end;
  }
  return spans;
}

function keyOccurrences(haystack: PdfCharKey[], needle: string[], startAt: number, endAt = haystack.length): number[] {
  const occurrences: number[] = [];
  for (let start = startAt; start <= endAt - needle.length; start += 1) {
    if (needle.every((key, offset) => haystack[start + offset].key === key)) occurrences.push(start);
  }
  return occurrences;
}

interface ExactChildAnchorCandidate {
  child_index: number;
  start: number;
  end: number;
  source_keys: ReturnType<typeof displayCharacterKeys>;
}

interface FormulaRegionCandidate extends ProjectedKeyRange {
  child_index: number;
  lane: { pageIndex: number; column: PdfAlignmentLine["column"] };
  existing_display_eligible: boolean;
  glyph_source_spans?: Array<{ start: number; end: number }>;
  glyph_requires_geometry?: boolean;
  region_reason?: string;
}

interface FormulaRegionChainEntry {
  child_index: number;
  candidates: FormulaRegionCandidate[];
}

function uniqueMonotonicExactChildChain(
  candidates: ExactChildAnchorCandidate[],
): { status: "none" | "unique" | "ambiguous"; chain: ExactChildAnchorCandidate[] } {
  if (!candidates.length) return { status: "none", chain: [] };
  const ordered = [...candidates].sort((left, right) => (
    left.child_index - right.child_index || left.start - right.start || left.end - right.end
  ));
  const bestLengths = new Array<number>(ordered.length).fill(1);
  const pathCounts = new Array<number>(ordered.length).fill(1);
  const previousIndexes = new Array<number>(ordered.length).fill(-1);
  for (let currentIndex = 0; currentIndex < ordered.length; currentIndex += 1) {
    let bestPreviousLength = 0;
    let bestPreviousCount = 0;
    let uniquePreviousIndex = -1;
    for (let previousIndex = 0; previousIndex < currentIndex; previousIndex += 1) {
      const previous = ordered[previousIndex];
      const current = ordered[currentIndex];
      if (previous.child_index >= current.child_index || previous.end > current.start) continue;
      if (bestLengths[previousIndex] > bestPreviousLength) {
        bestPreviousLength = bestLengths[previousIndex];
        bestPreviousCount = pathCounts[previousIndex];
        uniquePreviousIndex = pathCounts[previousIndex] === 1 ? previousIndex : -1;
      } else if (bestLengths[previousIndex] === bestPreviousLength) {
        bestPreviousCount = Math.min(2, bestPreviousCount + pathCounts[previousIndex]);
        uniquePreviousIndex = -1;
      }
    }
    if (bestPreviousLength) {
      bestLengths[currentIndex] = bestPreviousLength + 1;
      pathCounts[currentIndex] = Math.min(2, bestPreviousCount);
      previousIndexes[currentIndex] = uniquePreviousIndex;
    }
  }
  const bestLength = Math.max(...bestLengths);
  const bestEndpoints = ordered
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => bestLengths[index] === bestLength);
  const pathCount = bestEndpoints.reduce((sum, { index }) => Math.min(2, sum + pathCounts[index]), 0);
  if (pathCount !== 1) return { status: "ambiguous", chain: [] };
  const chain: ExactChildAnchorCandidate[] = [];
  let cursor = bestEndpoints[0].index;
  while (cursor >= 0) {
    chain.push(ordered[cursor]);
    cursor = previousIndexes[cursor];
  }
  return { status: "unique", chain: chain.reverse() };
}

function uniqueMonotonicFormulaRegionChain(
  entries: FormulaRegionChainEntry[],
): { status: "none" | "unique" | "ambiguous"; chain: FormulaRegionCandidate[] } {
  const ordered = [...entries].sort((left, right) => left.child_index - right.child_index);
  if (!ordered.length || ordered.some((entry) => !entry.candidates.length)) {
    return { status: "none", chain: [] };
  }
  const pathCounts: number[][] = [];
  const previousIndexes: number[][] = [];
  for (let entryIndex = 0; entryIndex < ordered.length; entryIndex += 1) {
    const current = ordered[entryIndex].candidates;
    pathCounts.push(new Array<number>(current.length).fill(entryIndex === 0 ? 1 : 0));
    previousIndexes.push(new Array<number>(current.length).fill(-1));
    if (entryIndex === 0) continue;
    const previous = ordered[entryIndex - 1].candidates;
    for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
      let count = 0;
      let uniquePreviousIndex = -1;
      for (let previousIndex = 0; previousIndex < previous.length; previousIndex += 1) {
        if (previous[previousIndex].end > current[currentIndex].start) continue;
        const previousCount = pathCounts[entryIndex - 1][previousIndex];
        if (!previousCount) continue;
        count = Math.min(2, count + previousCount);
        uniquePreviousIndex = count === 1 && previousCount === 1 ? previousIndex : -1;
      }
      pathCounts[entryIndex][currentIndex] = count;
      previousIndexes[entryIndex][currentIndex] = uniquePreviousIndex;
    }
  }
  const finalCounts = pathCounts.at(-1)!;
  const total = finalCounts.reduce((sum, count) => Math.min(2, sum + count), 0);
  if (!total) return { status: "none", chain: [] };
  if (total !== 1) return { status: "ambiguous", chain: [] };
  const chain: FormulaRegionCandidate[] = [];
  let candidateIndex = finalCounts.findIndex((count) => count === 1);
  for (let entryIndex = ordered.length - 1; entryIndex >= 0; entryIndex -= 1) {
    chain.push(ordered[entryIndex].candidates[candidateIndex]);
    candidateIndex = previousIndexes[entryIndex][candidateIndex];
  }
  return { status: "unique", chain: chain.reverse() };
}

function formulaCharacterKeys(keys: PdfCharKey[]): PdfCharKey[] {
  const chars = new Map<string, PdfCharKey>();
  for (const item of keys) chars.set(`${item.char.pageIndex}:${item.char.charIndex}`, item);
  return [...chars.values()].flatMap((item) => (
    formulaGlyphKeys(item.char.text).map((key) => ({ ...item, key }))
  )).filter((item) => item.key !== " ");
}

function legacyFormulaCharacterKeys(keys: PdfCharKey[]): PdfCharKey[] {
  return formulaCharacterKeys(keys).filter((item) => !/^[_{}^$]$/u.test(item.key));
}

function formulaPageColumnLane(
  chars: PdfCharKey[],
): { pageIndex: number; column: PdfAlignmentLine["column"] } | null {
  const first = chars[0]?.line;
  if (!first || chars.some((item) => (
    item.line.pageIndex !== first.pageIndex || item.line.column !== first.column
  ))) return null;
  return { pageIndex: first.pageIndex, column: first.column };
}

function samePageColumnLane(
  left: { pageIndex: number; column: PdfAlignmentLine["column"] },
  right: { pageIndex: number; column: PdfAlignmentLine["column"] },
): boolean {
  return left.pageIndex === right.pageIndex && left.column === right.column;
}

function formulaSourceCharacterKeys(
  source: string,
  span: { start: number; end: number },
): Array<{ key: string; source_span: { start: number; end: number } }> | null {
  const formula = parseFormulaSourceAst(source, span);
  if (!formula.projectable) return null;
  const units: Array<{ key: string; source_span: { start: number; end: number } }> = [];
  for (const token of formula.visible_tokens) {
    for (const key of formulaGlyphKeys(token.value)) {
      if (key !== " " && !/^[_{}^$]$/u.test(key)) units.push({ key, source_span: token.source_span });
    }
  }
  return units.length ? units : null;
}

function formulaDisplayText(allKeys: PdfCharKey[], formulaKeys: PdfCharKey[]): string {
  const first = formulaKeys[0];
  const last = formulaKeys.at(-1);
  if (!first || !last) return "";
  const firstIndex = allKeys.findIndex((item) => (
    item.char.pageIndex === first.char.pageIndex && item.char.charIndex === first.char.charIndex
  ));
  const lastIndex = allKeys.findIndex((item) => (
    item.char.pageIndex === last.char.pageIndex && item.char.charIndex === last.char.charIndex
  ));
  if (firstIndex < 0 || lastIndex < firstIndex) return "";
  const matched = new Set(formulaKeys.map((item) => `${item.char.pageIndex}:${item.char.charIndex}`));
  const display = allKeys.slice(firstIndex, lastIndex + 1);
  if (display.some((item) => item.key !== " " && !matched.has(`${item.char.pageIndex}:${item.char.charIndex}`))) {
    return "";
  }
  return display.map((item) => item.char.text).join("");
}

function projectionText(
  child: HybridAlignmentUnit["child_lids"][number],
  blockTextBySpan: Map<string, string>,
): string {
  const text = blockTextBySpan.get(spanKey(child.source_span)) ?? "";
  return child.kind === "formula" ? sourceComparisonText(text) : text.trim();
}

function regionsForKeyRange(range: ProjectedKeyRange, prefix: string): PdfRegion[] {
  const grouped = new Map<string, PdfGeometryChar[]>();
  for (const item of range.chars) {
    const chars = grouped.get(item.line.alignment_line_id) ?? [];
    if (!chars.some((char) => char.charIndex === item.char.charIndex)) chars.push(item.char);
    grouped.set(item.line.alignment_line_id, chars);
  }
  return [...grouped.entries()].map(([lineId, chars], index) => ({
    region_id: `${prefix}-${index + 1}`,
    pageIndex: Number(lineId.split(":")[0]),
    bbox: bboxForChars(chars),
  }));
}

function textProjection(
  unit: HybridAlignmentUnit,
  child: HybridAlignmentUnit["child_lids"][number],
  range: ProjectedKeyRange,
  precision: "char_exact" | "partial",
): HybridChildProjection {
  const regions = regionsForKeyRange(range, `${unit.unit_id}-${child.lid}`);
  const assignments = new Map<string, HybridChildProjection["selection_assignments"][number]>();
  for (let index = 0; index < Math.min(range.source_spans.length, range.chars.length); index += 1) {
    const pdf = range.chars[index];
    const key = `${pdf.char.pageIndex}:${pdf.char.charIndex}`;
    const current = assignments.get(key);
    assignments.set(key, {
      pageIndex: pdf.char.pageIndex,
      char_index: pdf.char.charIndex,
      text: pdf.char.text,
      rect: { pageIndex: pdf.char.pageIndex, bbox: pdf.char.bbox },
      source_span: current
        ? {
            start: Math.min(current.source_span.start, range.source_spans[index].start),
            end: Math.max(current.source_span.end, range.source_spans[index].end),
          }
        : range.source_spans[index],
    });
  }
  return {
    lid: child.lid,
    source_span: { ...child.source_span },
    precision,
    regions,
    exact_source_spans: mergeSourceSpans(range.source_spans),
    selection_assignments: [...assignments.values()],
    ...(regions[0] ? { primary_region: regions[0] } : {}),
    alignment: {
      unit_id: unit.unit_id,
      reason: precision === "char_exact"
        ? "complete monotonic character projection inside located unit"
        : "partial monotonic character projection inside located unit",
    },
  };
}

export function projectHybridAlignmentChildren(
  source: string,
  location: LocatedHybridAlignmentUnit,
): HybridChildProjection[] {
  const unit = location.unit;
  const unmapped = (child: HybridAlignmentUnit["child_lids"][number], reason: string): HybridChildProjection => ({
    lid: child.lid,
    source_span: { ...child.source_span },
    precision: "unmapped",
    regions: [],
    exact_source_spans: [],
    selection_assignments: [],
    alignment: { unit_id: unit.unit_id, reason },
  });
  if (location.status !== "located") {
    return unit.child_lids.map((child) => unmapped(child, location.reason));
  }
  const parsed = parseMarkdownSourceBlocks(source);
  const blockTextBySpan = displayTextByBlockSpan(parsed.blocks, parsed.display_segments);
  const hasCodeDisplay = parsed.display_segments.some((segment) => (
    segment.role === "code"
    && segment.source_span.start >= unit.source_span.start
    && segment.source_span.end <= unit.source_span.end
  ));
  const keys = pdfCharKeys(location.lines, hasCodeDisplay ? "code" : "prose");
  const ranges = new Map<string, ProjectedKeyRange>();
  const rejections = new Map<string, string>();
  const textChildren = unit.child_lids.flatMap((child, childIndex) => {
    if (child.kind === "formula" || child.kind === "image" || child.kind === "table") return [];
    const sourceKeys = displayCharacterKeys(source, child, parsed.display_segments);
    return sourceKeys.length ? [{ child, childIndex, sourceKeys }] : [];
  });
  const exactCandidates = textChildren.flatMap(({ childIndex, sourceKeys }) => (
    keyOccurrences(keys, sourceKeys.map((item) => item.key), 0)
      .map((start): ExactChildAnchorCandidate => ({
        child_index: childIndex,
        start,
        end: start + sourceKeys.length,
        source_keys: sourceKeys,
      }))
  ));
  const exactChain = uniqueMonotonicExactChildChain(exactCandidates);
  if (exactChain.status === "ambiguous") {
    for (const { child } of textChildren) {
      rejections.set(child.lid, "child exact anchors do not form a unique monotonic chain");
    }
  } else {
    for (const anchor of exactChain.chain) {
      const child = unit.child_lids[anchor.child_index];
      ranges.set(child.lid, {
        start: anchor.start,
        end: anchor.end,
        chars: keys.slice(anchor.start, anchor.end),
        source_spans: anchor.source_keys.map((item) => item.source_span),
        has_unmatched_material_pdf: false,
      });
    }
  }

  if (exactChain.status !== "ambiguous") {
    const unresolvedGroups = new Map<string, typeof textChildren>();
    for (const item of textChildren.filter(({ child }) => !ranges.has(child.lid))) {
      const previousAnchor = [...textChildren]
        .reverse()
        .find((candidate) => candidate.childIndex < item.childIndex && ranges.has(candidate.child.lid));
      const nextAnchor = textChildren
        .find((candidate) => candidate.childIndex > item.childIndex && ranges.has(candidate.child.lid));
      const key = `${previousAnchor?.childIndex ?? -1}:${nextAnchor?.childIndex ?? unit.child_lids.length}`;
      unresolvedGroups.set(key, [...(unresolvedGroups.get(key) ?? []), item]);
    }
    for (const group of unresolvedGroups.values()) {
      if (group.length !== 1) {
        for (const { child } of group) rejections.set(child.lid, "child has no exclusive local PDF window");
        continue;
      }
      const item = group[0];
      const previousAnchor = [...textChildren]
        .reverse()
        .find((candidate) => candidate.childIndex < item.childIndex && ranges.has(candidate.child.lid));
      const nextAnchor = textChildren
        .find((candidate) => candidate.childIndex > item.childIndex && ranges.has(candidate.child.lid));
      const windowStart = previousAnchor ? ranges.get(previousAnchor.child.lid)!.end : 0;
      const windowEnd = nextAnchor ? ranges.get(nextAnchor.child.lid)!.start : keys.length;
      const localKeys = keys.slice(windowStart, windowEnd);
      const pairs = alignmentPairs(item.sourceKeys, localKeys);
      const matchedSourceIndexes = new Set(pairs.map(([sourceIndex]) => sourceIndex));
      const coverage = matchedSourceIndexes.size / item.sourceKeys.length;
      if (coverage < 0.5 || !pairs.length) {
        rejections.set(item.child.lid, "child has no deterministic projection inside its local PDF window");
        continue;
      }
      const start = windowStart + pairs[0][1];
      const end = windowStart + pairs.at(-1)![1] + 1;
      ranges.set(item.child.lid, {
        start,
        end,
        chars: pairs.map(([, pdfIndex]) => localKeys[pdfIndex]),
        source_spans: sourceSpansWithLineBreakWhitespace(item.sourceKeys, localKeys, pairs),
        has_unmatched_material_pdf: hasUnmatchedMaterialPdfKeys(localKeys, pairs),
      });
    }
  }

  const projections = new Map<string, HybridChildProjection>();
  for (const child of unit.child_lids) {
    const range = ranges.get(child.lid);
    if (range) {
      const exactLength = mergeSourceSpans(range.source_spans).reduce((sum, span) => sum + span.end - span.start, 0);
      const sourceKeys = textChildren.find((candidate) => candidate.child.lid === child.lid)?.sourceKeys ?? [];
      const fullLength = mergeSourceSpans(sourceKeys.map((item) => item.source_span))
        .reduce((sum, span) => sum + span.end - span.start, 0);
      const projection = textProjection(
        unit,
        child,
        range,
        exactLength === fullLength && !range.has_unmatched_material_pdf ? "char_exact" : "partial",
      );
      if (range.has_unmatched_material_pdf) {
        projection.alignment.reason = "child-local projection contains unmatched material PDF";
      }
      projections.set(child.lid, projection);
    }
  }
  const formulaRanges = new Map<string, FormulaRegionCandidate>();
  const formulaGroups = new Map<string, Array<{
    child: HybridAlignmentUnit["child_lids"][number];
    childIndex: number;
    candidates: FormulaRegionCandidate[];
    rejection?: string;
  }>>();
  for (let childIndex = 0; childIndex < unit.child_lids.length; childIndex += 1) {
    const child = unit.child_lids[childIndex];
    if (child.kind !== "formula") continue;
    const previousIndex = [...unit.child_lids.keys()].reverse()
      .find((index) => index < childIndex && ranges.has(unit.child_lids[index].lid));
    const nextIndex = [...unit.child_lids.keys()]
      .find((index) => index > childIndex && ranges.has(unit.child_lids[index].lid));
    const previousRange = previousIndex === undefined ? undefined : ranges.get(unit.child_lids[previousIndex].lid);
    const nextRange = nextIndex === undefined ? undefined : ranges.get(unit.child_lids[nextIndex].lid);
    const previousLine = previousRange?.chars.at(-1)?.line;
    const nextLine = nextRange?.chars[0]?.line;
    const previousLane = previousLine
      ? { pageIndex: previousLine.pageIndex, column: previousLine.column }
      : undefined;
    const nextLane = nextLine ? { pageIndex: nextLine.pageIndex, column: nextLine.column } : undefined;
    const boundaryConflict = Boolean(
      previousLane && nextLane && !samePageColumnLane(previousLane, nextLane),
    );
    const expectedLane = boundaryConflict ? undefined : previousLane ?? nextLane;
    const windowStart = previousRange?.end ?? 0;
    const windowEnd = nextRange?.start ?? keys.length;
    const glyphPlan = buildFormulaGlyphPlan(source, child.source_span);
    const windowKeys = glyphPlan.status === "supported"
      ? formulaCharacterKeys(keys.slice(windowStart, windowEnd))
      : legacyFormulaCharacterKeys(keys.slice(windowStart, windowEnd));
    const glyphMatches = findFormulaGlyphMatches(glyphPlan, windowKeys.map((item) => ({
      key: item.key,
      pageIndex: item.char.pageIndex,
      charIndex: item.char.charIndex,
      bbox: item.char.bbox,
    })));
    const sourceSignature = formulaSourceCharacterKeys(source, child.source_span)?.map((item) => item.key);
    const legacyNeedle = formulaGlyphKeys(projectionText(child, blockTextBySpan))
      .filter((key) => key !== " " && !/^[_{}^$]$/u.test(key));
    const needle = sourceSignature ?? legacyNeedle;
    const occurrences = needle.length ? keyOccurrences(windowKeys, needle, 0) : [];
    const legacyOccurrences = legacyNeedle.length ? keyOccurrences(windowKeys, legacyNeedle, 0) : [];
    const legacyChars = legacyOccurrences.length === 1
      ? windowKeys.slice(legacyOccurrences[0], legacyOccurrences[0] + legacyNeedle.length)
      : [];
    const unsupportedObjectRegion = glyphPlan.status !== "supported"
      && !occurrences.length
      && unit.child_lids.length === 1
      && windowKeys.length > 0
      && Boolean(formulaPageColumnLane(windowKeys));
    const rawMatches: Array<{
      start: number;
      end: number;
      glyph_source_spans?: Array<{ start: number; end: number }>;
      region_reason?: string;
    }> = glyphPlan.status === "supported"
      ? glyphMatches.matches.map((match) => ({
          start: match.start,
          end: match.end,
          glyph_source_spans: match.source_spans,
        }))
      : unsupportedObjectRegion
        ? [{
            start: 0,
            end: windowKeys.length,
            region_reason: "unique formula object region for unsupported source AST",
          }]
        : occurrences.map((start) => ({ start, end: start + needle.length }));
    const rawCandidates = rawMatches.map((match) => {
      const chars = windowKeys.slice(match.start, match.end);
      const first = chars[0];
      const last = chars.at(-1);
      const absoluteStart = first ? keys.findIndex((item) => (
        item.char.pageIndex === first.char.pageIndex && item.char.charIndex === first.char.charIndex
      )) : -1;
      const absoluteLast = last ? keys.findIndex((item) => (
        item.char.pageIndex === last.char.pageIndex && item.char.charIndex === last.char.charIndex
      )) : -1;
      const absoluteEnd = absoluteLast >= 0 ? absoluteLast + 1 : -1;
      return {
        chars,
        absoluteStart,
        absoluteEnd,
        lane: formulaPageColumnLane(chars),
        ...(match.glyph_source_spans ? { glyph_source_spans: match.glyph_source_spans } : {}),
        ...(match.region_reason ? { region_reason: match.region_reason } : {}),
      };
    });
    const candidates = boundaryConflict ? [] : rawCandidates.flatMap((candidate) => (
      candidate.lane
      && candidate.absoluteStart >= 0
      && candidate.absoluteEnd > candidate.absoluteStart
      && (!expectedLane || samePageColumnLane(candidate.lane, expectedLane))
        ? [{
            child_index: childIndex,
            start: candidate.absoluteStart,
            end: candidate.absoluteEnd,
            chars: candidate.chars,
            source_spans: [],
            lane: candidate.lane,
            existing_display_eligible: legacyChars.length === candidate.chars.length
              && legacyChars.every((item, index) => item === candidate.chars[index]),
            ...(candidate.glyph_source_spans ? {
              glyph_source_spans: candidate.glyph_source_spans,
              glyph_requires_geometry: glyphPlan.requires_geometry,
            } : {}),
            ...(candidate.region_reason ? { region_reason: candidate.region_reason } : {}),
          }]
        : []
    ));
    const rejection = boundaryConflict
      ? "formula region conflicts with adjacent page-column lanes"
      : glyphPlan.status === "supported" && !glyphMatches.matches.length
        ? glyphMatches.key_candidate_count && glyphMatches.geometry_rejection_count
          ? "formula glyph geometry conflicts with source AST"
          : "formula glyph projection has no complete structural match"
        : glyphPlan.status !== "supported" && !occurrences.length && !unsupportedObjectRegion
          ? "formula source AST structure is not glyph-projectable"
        : rawCandidates.some((candidate) => !candidate.lane)
          ? "formula signature crosses page-column lanes"
          : !candidates.length
            ? "formula region conflicts with adjacent page-column lanes"
            : undefined;
    const groupKey = `${previousIndex ?? -1}:${nextIndex ?? unit.child_lids.length}`;
    formulaGroups.set(groupKey, [
      ...(formulaGroups.get(groupKey) ?? []),
      { child, childIndex, candidates, ...(rejection ? { rejection } : {}) },
    ]);
  }
  for (const group of formulaGroups.values()) {
    const incomplete = group.find((entry) => !entry.candidates.length);
    if (incomplete) {
      for (const entry of group) {
        rejections.set(
          entry.child.lid,
          entry.rejection ?? "formula region candidates do not form a unique monotonic chain",
        );
      }
      continue;
    }
    const chain = uniqueMonotonicFormulaRegionChain(group.map((entry) => ({
      child_index: entry.childIndex,
      candidates: entry.candidates,
    })));
    if (chain.status !== "unique") {
      for (const entry of group) {
        rejections.set(entry.child.lid, "formula region candidates do not form a unique monotonic chain");
      }
      continue;
    }
    for (const candidate of chain.chain) {
      formulaRanges.set(unit.child_lids[candidate.child_index].lid, candidate);
    }
  }
  for (let index = 0; index < unit.child_lids.length; index += 1) {
    const child = unit.child_lids[index];
    if (child.kind !== "formula") continue;
    const range = formulaRanges.get(child.lid);
    if (!range) {
      projections.set(child.lid, unmapped(
        child,
        rejections.get(child.lid) ?? "formula region candidates do not form a unique monotonic chain",
      ));
      continue;
    }
    const previous = [...unit.child_lids.slice(0, index)].reverse().find((candidate) => ranges.has(candidate.lid));
    const next = unit.child_lids.slice(index + 1).find((candidate) => ranges.has(candidate.lid));
    const previousRange = previous ? ranges.get(previous.lid) : undefined;
    const nextRange = next ? ranges.get(next.lid) : undefined;
    const regions = regionsForKeyRange(range, `${unit.unit_id}-${child.lid}`);
    const previousLine = previousRange?.chars.at(-1)?.line;
    const nextLine = nextRange?.chars[0]?.line;
    const formulaLine = range.chars[0]?.line;
    const boundedSamePageColumn = Boolean(
      previousLine
      && nextLine
      && formulaLine
      && previousLine.pageIndex === formulaLine.pageIndex
      && nextLine.pageIndex === formulaLine.pageIndex
      && previousLine.column === formulaLine.column
      && nextLine.column === formulaLine.column,
    );
    const formulaSourceKeys = formulaSourceCharacterKeys(source, child.source_span);
    const hasExactDisplaySource = Boolean(
      formulaSourceKeys
      && formulaSourceKeys.length === range.chars.length
      && formulaSourceKeys.every((item, sourceIndex) => item.key === range.chars[sourceIndex].key),
    );
    const displayText = formulaDisplayText(keys, range.chars);
    if (range.glyph_source_spans?.length === range.chars.length) {
      const projection = textProjection(unit, child, {
        ...range,
        source_spans: range.glyph_source_spans,
      }, "partial");
      projection.formula_display_text = displayText || [...new Map(range.chars.map((item) => (
        [`${item.char.pageIndex}:${item.char.charIndex}`, item.char.text]
      ))).values()].join("");
      projection.alignment.reason = range.glyph_requires_geometry
        ? "complete structural formula glyph projection"
        : range.existing_display_eligible && boundedSamePageColumn
          ? "complete simple formula display projection with source-markup gaps"
          : "complete formula glyph projection in unique formula region";
      projections.set(child.lid, projection);
      continue;
    }
    if (range.existing_display_eligible && boundedSamePageColumn && hasExactDisplaySource && displayText) {
      const projection = textProjection(unit, child, {
        ...range,
        source_spans: formulaSourceKeys!.map((item) => item.source_span),
      }, "partial");
      projection.formula_display_text = displayText;
      projection.alignment.reason = "complete simple formula display projection with source-markup gaps";
      projections.set(child.lid, projection);
      continue;
    }
    projections.set(child.lid, {
      lid: child.lid,
      source_span: { ...child.source_span },
      precision: "region_exact",
      regions,
      exact_source_spans: [],
      selection_assignments: [],
      ...(regions[0] ? { primary_region: regions[0] } : {}),
      alignment: {
        unit_id: unit.unit_id,
        reason: range.region_reason ?? (boundedSamePageColumn
          ? "unique formula region bounded by exact same-page same-column text anchors"
          : "unique formula region in one page-column lane"),
      },
    });
  }
  return unit.child_lids.map((child) => projections.get(child.lid)
    ?? unmapped(child, rejections.get(child.lid) ?? "child has no deterministic projection inside its local PDF window"));
}

export function alignHybridFoundationV2(
  source: string,
  geometry: PdfTextGeometry,
  evidence?: SourceAlignmentEvidenceV1,
): {
  units: HybridAlignmentUnit[];
  locations: LocatedHybridAlignmentUnit[];
  projections: HybridChildProjection[];
} {
  const units = formHybridAlignmentUnits(source);
  const locations = locateHybridAlignmentUnits(source, units, geometry, evidence);
  const projections = locations.flatMap((location) => projectHybridAlignmentChildren(source, location));
  return {
    units,
    locations,
    projections: projectImageObjectRegions(units, projections, geometry),
  };
}
