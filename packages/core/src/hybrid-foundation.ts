import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markdownToBlocks } from "./md-adapter";
import { segment, type SourceBlock } from "./segment";
import { buildSourceManifestV2, type SourceManifestV2 } from "./source-manifest";
import {
  pdfUserSpaceCoordinateSystem,
  type PdfRegion,
  type PdfSelectionMapManifest,
  type PdfSelectionMapPageShard,
  type PdfSourceMap,
  type PdfSourceMapEntry,
} from "./pdf-source-map";
import type { PdfGeometryChar, PdfGeometryLine, PdfGeometryPage, PdfTextGeometry } from "./pdf-geometry";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import {
  AlignmentReportZ,
  PdfSelectionMapManifestZ,
  PdfSelectionMapPageShardZ,
  PdfSourceMapZ,
  ReadOnlyBaseZ,
  SourceManifestV2Z,
} from "./zod";

export interface AlignmentReport {
  version: "alignment_report.v1";
  book_id: string;
  config: {
    algorithm: "monotonic_forward_fuzzy_v1" | "monotonic_windowed_blocks_v2" | "monotonic_windowed_characters_v3" | "banded_windowed_characters_v4";
    lookback_words: number;
    lookahead_words: number;
    merge_gap_utf16: number;
    coordinate_system: "pdf_user_space";
    normalization: string[];
  };
  config_hash: string;
  hard_gates: Record<string, boolean | number>;
  diagnostics: Record<string, unknown>;
  normalization_provenance: Array<{ trace_id: string; summary: string }>;
}

export interface HybridFoundationInput {
  book_id: string;
  source_txt: string;
  original_pdf_path: string;
  original_pdf_sha256: string;
  original_pdf_fingerprint?: string;
  pdf_geometry: PdfTextGeometry;
}

export interface HybridFoundationArtifacts {
  base: ReadOnlyBase;
  source_manifest: SourceManifestV2;
  pdf_source_map: PdfSourceMap;
  pdf_selection_map_manifest: PdfSelectionMapManifest;
  pdf_selection_map_pages: PdfSelectionMapPageShard[];
  alignment_report: AlignmentReport;
}

export interface WriteHybridFoundationArtifactsResult {
  base_path: string;
  source_path: string;
  source_manifest_path: string;
  pdf_source_map_path: string;
  pdf_selection_map_manifest_path: string;
  pdf_selection_map_page_paths: string[];
  alignment_report_path: string;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function jsonSha256(value: unknown): string {
  return sha256(JSON.stringify(value, null, 2));
}

function keyOfSpan(span: { start: number; end: number }): string {
  return `${span.start}:${span.end}`;
}

const ALIGNMENT_ALGORITHM = "banded_windowed_characters_v4" as const;
const ALIGNMENT_LOOKAHEAD_WORDS = 240;
const PARAGRAPH_ANCHOR_TOKENS = 16;
const MAX_MATCH_LINES = 32;
const MAX_LCS_CELLS = 8_000_000;
const MIN_EXTENSION_TOKEN_MATCH_RATIO = 0.55;
const RECOVERY_MIN_ANCHOR_TOKENS = 6;
const RECOVERY_MAX_PAGE_DISTANCE = 1;
const MINIMUM_TEXT_MAPPING_RATIO = 0.6;
const MINIMUM_HEADING_MAPPING_RATIO = 0.8;

function alignmentTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/([\p{L}\p{N}])[\p{Pd}\u00ad]\s+(?=[\p{L}\p{N}])/gu, "$1")
    .replace(/[\p{Pd}\u00ad]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function lineRegion(pageIndex: number, line: PdfGeometryLine, regionId: string): PdfRegion {
  return {
    region_id: regionId,
    pageIndex,
    bbox: line.bbox,
  };
}

type OrderedPageLine = PdfGeometryLine & { pageIndex: number; contentIndex: number };

function horizontalLineBands(lines: OrderedPageLine[], page: PdfGeometryPage): OrderedPageLine[][] {
  if (!lines.length) return [];
  const heights = lines
    .map((line) => line.bbox[3] - line.bbox[1])
    .filter((height) => height > 0)
    .sort((left, right) => left - right);
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const gapThreshold = Math.max(12, medianHeight * 1.8, page.height * 0.015);
  const spatial = [...lines].sort((left, right) =>
    right.bbox[3] - left.bbox[3]
      || left.bbox[0] - right.bbox[0]
      || left.contentIndex - right.contentIndex,
  );
  const bands: OrderedPageLine[][] = [];
  let bandBottom = Number.POSITIVE_INFINITY;
  for (const line of spatial) {
    const current = bands.at(-1);
    if (!current || bandBottom - line.bbox[3] > gapThreshold) {
      bands.push([line]);
      bandBottom = line.bbox[1];
      continue;
    }
    current.push(line);
    bandBottom = Math.min(bandBottom, line.bbox[1]);
  }
  return bands;
}

function bandLinesInReadingOrder(
  lines: OrderedPageLine[],
  page: PdfGeometryPage,
  maxNormalLineHeight: number,
): OrderedPageLine[] {
  const midpoint = (page.view[0] + page.view[2]) / 2;
  const pageWidth = page.view[2] - page.view[0];
  const spansColumns = (line: PdfGeometryLine): boolean => {
    const width = line.bbox[2] - line.bbox[0];
    return line.bbox[0] < midpoint
      && line.bbox[2] > midpoint
      && width >= pageWidth * 0.45;
  };
  const spanningByHeight = lines
    .filter(spansColumns)
    .sort((left, right) => right.bbox[3] - left.bbox[3]);
  const clusters: typeof spanningByHeight[] = [];
  for (const line of spanningByHeight) {
    const cluster = clusters.at(-1);
    const previous = cluster?.at(-1);
    const previousCenter = previous ? (previous.bbox[1] + previous.bbox[3]) / 2 : null;
    const center = (line.bbox[1] + line.bbox[3]) / 2;
    if (!cluster || previousCenter === null || previousCenter - center > maxNormalLineHeight) {
      clusters.push([line]);
    } else {
      cluster.push(line);
    }
  }
  const primarySpanningCluster = clusters
    .filter((cluster) => cluster.length >= 3)
    .sort((left, right) => right.length - left.length || right[0].bbox[3] - left[0].bbox[3])[0];
  const spanningBand = primarySpanningCluster
    ? (() => {
        const leftEdges = primarySpanningCluster.map((line) => line.bbox[0]).sort((left, right) => left - right);
        return {
        top: Math.max(...primarySpanningCluster.map((line) => line.bbox[3])),
        bottom: Math.min(...primarySpanningCluster.map((line) => line.bbox[1])),
          left: leftEdges[Math.floor(leftEdges.length / 2)],
        };
      })()
    : null;

  return [...lines].sort((left, right) => {
      const group = (line: PdfGeometryLine): number => {
        const alignsWithBandLeft = spanningBand
          ? Math.abs(line.bbox[0] - spanningBand.left) <= Math.max(12, pageWidth * 0.04)
          : false;
        const inPrimaryBand = spanningBand
          ? spansColumns(line) || alignsWithBandLeft
          : spansColumns(line);
        if (inPrimaryBand) return 0;
        return (line.bbox[0] + line.bbox[2]) / 2 < midpoint ? 1 : 2;
      };
      return group(left) - group(right)
        || right.bbox[3] - left.bbox[3]
        || left.bbox[0] - right.bbox[0]
        || left.contentIndex - right.contentIndex;
    });
}

function pageLinesInReadingOrder(page: PdfGeometryPage): Array<PdfGeometryLine & { pageIndex: number }> {
  const maxNormalLineHeight = Math.max(30, page.height * 0.08);
  const lines = page.lines
    .filter((line) => line.bbox[0] >= 0
      && line.bbox[1] >= 0
      && line.bbox[2] <= page.width
      && line.bbox[3] <= page.height
      && line.bbox[3] - line.bbox[1] <= maxNormalLineHeight)
    .map((line, contentIndex) => ({ ...line, pageIndex: page.pageIndex, contentIndex }));
  return horizontalLineBands(lines, page)
    .flatMap((band) => bandLinesInReadingOrder(band, page, maxNormalLineHeight))
    .map(({ contentIndex: _contentIndex, ...line }) => line);
}

interface PdfLineMatch {
  startIndex: number;
  endIndex: number;
  quality: "exact" | "line_start" | "contains";
  recovered: boolean;
}

type RankedPdfLineMatch = PdfLineMatch & { matchedTokens: number; extraTokens: number };

function tokenSequenceIndex(haystack: string[], needle: string[]): number {
  if (!needle.length || needle.length > haystack.length) return -1;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return start;
  }
  return -1;
}

function sequenceMatchCount(left: string[], right: string[]): number {
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[right.length];
}

function bestLineMatchAt(
  lines: Array<PdfGeometryLine & { pageIndex: number }>,
  block: SourceBlock,
  blockTokens: string[],
  anchorTokens: string[],
  start: number,
): RankedPdfLineMatch | null {
  let best: RankedPdfLineMatch | null = null;
  let previousMatchedTokens = 0;
  let previousAlignedTokenCount = 0;
  for (let end = start; end < Math.min(lines.length, start + MAX_MATCH_LINES); end++) {
    if (lines[end].pageIndex !== lines[start].pageIndex) break;
    const combinedTokens = alignmentTokens(lines
      .slice(start, end + 1)
      .map((line) => line.text)
      .join(" "));
    if (combinedTokens.length < anchorTokens.length) continue;
    const tokenIndex = tokenSequenceIndex(combinedTokens, anchorTokens);
    if (tokenIndex < 0) continue;
    let anchorStartIndex = start;
    let tokensBeforeLine = 0;
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
      const lineTokenCount = alignmentTokens(lines[lineIndex].text).length;
      if (tokenIndex < tokensBeforeLine + lineTokenCount) {
        anchorStartIndex = lineIndex;
        break;
      }
      tokensBeforeLine += lineTokenCount;
    }
    const alignedTokens = combinedTokens.slice(tokenIndex);
    const matchedTokens = sequenceMatchCount(blockTokens, alignedTokens);
    const extraTokens = Math.max(0, alignedTokens.length - blockTokens.length);
    if (best && alignedTokens.length > previousAlignedTokenCount) {
      const addedTokens = alignedTokens.length - previousAlignedTokenCount;
      const addedMatches = matchedTokens - previousMatchedTokens;
      if (addedMatches / addedTokens < MIN_EXTENSION_TOKEN_MATCH_RATIO) break;
    }
    const quality = tokenIndex === 0
      && alignedTokens.length === blockTokens.length
      && matchedTokens === blockTokens.length
      ? "exact"
      : tokenIndex === 0
        ? "line_start"
        : "contains";
    if (block.kind !== "heading" && blockTokens.length < 4 && quality !== "exact") continue;
    if (!best
      || matchedTokens > best.matchedTokens
      || (matchedTokens === best.matchedTokens && extraTokens < best.extraTokens)) {
      best = {
        startIndex: anchorStartIndex,
        endIndex: end,
        quality,
        recovered: false,
        matchedTokens,
        extraTokens,
      };
    }
    previousMatchedTokens = matchedTokens;
    previousAlignedTokenCount = alignedTokens.length;
    if (matchedTokens === blockTokens.length && alignedTokens.length >= blockTokens.length) break;
    const overrun = Math.max(8, Math.ceil(blockTokens.length * 0.25));
    if (alignedTokens.length > blockTokens.length + overrun) break;
  }
  return best;
}

function recoveryAnchorLineOccurrences(
  lines: Array<PdfGeometryLine & { pageIndex: number }>,
  anchorTokens: string[],
  startAt: number,
  lastPage: number,
): number[] {
  const tokenStream: Array<{ token: string; lineIndex: number }> = [];
  let previousLine: (PdfGeometryLine & { pageIndex: number }) | null = null;
  for (let lineIndex = startAt; lineIndex < lines.length; lineIndex++) {
    if (lines[lineIndex].pageIndex > lastPage) break;
    const lineTokens = alignmentTokens(lines[lineIndex].text);
    const normalizedPrevious = previousLine?.text.normalize("NFKC") ?? "";
    const normalizedCurrent = lines[lineIndex].text.normalize("NFKC");
    const joinsPreviousToken = previousLine?.pageIndex === lines[lineIndex].pageIndex
      && /[\p{L}\p{N}][\p{Pd}\u00ad]\s*$/u.test(normalizedPrevious)
      && /^\s*[\p{L}\p{N}]/u.test(normalizedCurrent);
    if (joinsPreviousToken && tokenStream.length > 0 && lineTokens.length > 0) {
      tokenStream[tokenStream.length - 1].token += lineTokens.shift();
    }
    for (const token of lineTokens) {
      tokenStream.push({ token, lineIndex });
    }
    previousLine = lines[lineIndex];
  }
  const occurrences: number[] = [];
  for (let start = 0; start <= tokenStream.length - anchorTokens.length; start++) {
    if (anchorTokens.every((token, offset) => tokenStream[start + offset].token === token)) {
      occurrences.push(tokenStream[start].lineIndex);
    }
  }
  return occurrences;
}

function findLinesForBlock(
  lines: Array<PdfGeometryLine & { pageIndex: number }>,
  block: SourceBlock,
  startAt: number,
): PdfLineMatch | null {
  if (block.assetKind) return null;
  const blockTokens = alignmentTokens(block.text);
  if (!blockTokens.length) return null;
  const anchorTokens = block.kind === "heading"
    ? blockTokens
    : blockTokens.slice(0, PARAGRAPH_ANCHOR_TOKENS);
  const candidates: Array<PdfLineMatch & { distanceWords: number }> = [];
  let distanceWords = 0;

  for (let start = startAt; start < lines.length; start++) {
    const localCandidate = distanceWords <= ALIGNMENT_LOOKAHEAD_WORDS;
    const best = bestLineMatchAt(lines, block, blockTokens, anchorTokens, start);
    if (best && (localCandidate || (block.kind === "heading" && best.quality === "exact"))) {
      candidates.push({
        startIndex: best.startIndex,
        endIndex: best.endIndex,
        quality: best.quality,
        recovered: false,
        distanceWords,
      });
    }
    distanceWords += alignmentTokens(lines[start].text).length;
    if (!localCandidate && block.kind !== "heading") break;
  }

  const qualityRank = { exact: 3, line_start: 2, contains: 1 } as const;
  candidates.sort((left, right) =>
    qualityRank[right.quality] - qualityRank[left.quality]
      || left.distanceWords - right.distanceWords
      || left.startIndex - right.startIndex,
  );
  if (candidates[0]) return candidates[0];
  if (block.kind === "heading" || anchorTokens.length < RECOVERY_MIN_ANCHOR_TOKENS) return null;
  const startPage = lines[startAt]?.pageIndex;
  if (startPage === undefined) return null;
  const occurrences = recoveryAnchorLineOccurrences(
    lines,
    anchorTokens,
    startAt,
    startPage + RECOVERY_MAX_PAGE_DISTANCE,
  );
  if (occurrences.length !== 1) return null;
  const recovered = bestLineMatchAt(lines, block, blockTokens, anchorTokens, occurrences[0]);
  if (!recovered) return null;
  return { ...recovered, recovered: true };
}

interface SourceAlignmentUnit {
  key: string;
  span: { start: number; end: number };
}

interface PdfAlignmentUnit {
  key: string;
  char: PdfGeometryChar;
}

interface SelectionCharAssignment {
  lid: string;
  source_span: { start: number; end: number };
}

function normalizedCharacterKeys(char: string): string[] {
  const normalized = char.normalize("NFKC").toLowerCase();
  const keys: string[] = [];
  for (const value of normalized) {
    if (/^[\p{Pd}\u00ad]$/u.test(value)) continue;
    keys.push(/^\s$/u.test(value) ? " " : value);
  }
  return keys;
}

function sourceAlignmentUnits(source: string, span: { start: number; end: number }): SourceAlignmentUnit[] {
  const units: SourceAlignmentUnit[] = [];
  let offset = span.start;
  for (const char of source.slice(span.start, span.end)) {
    const charSpan = { start: offset, end: offset + char.length };
    for (const key of normalizedCharacterKeys(char)) units.push({ key, span: charSpan });
    offset += char.length;
  }
  return units;
}

function pdfAlignmentUnits(chars: PdfGeometryChar[]): PdfAlignmentUnit[] {
  return chars.flatMap((char) => normalizedCharacterKeys(char.text).map((key) => ({ key, char })));
}

function greedyAlignmentPairs(left: SourceAlignmentUnit[], right: PdfAlignmentUnit[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  const lookahead = 64;
  const nextKey = <T extends { key: string }>(units: T[], key: string, start: number): number => {
    const end = Math.min(units.length, start + lookahead + 1);
    for (let index = start + 1; index < end; index += 1) {
      if (units[index].key === key) return index;
    }
    return -1;
  };
  while (i < left.length && j < right.length) {
    if (left[i].key === right[j].key) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
      continue;
    }
    const nextLeft = nextKey(left, right[j].key, i);
    const nextRight = nextKey(right, left[i].key, j);
    if (nextLeft >= 0 && (nextRight < 0 || nextLeft - i <= nextRight - j)) i = nextLeft;
    else if (nextRight >= 0) j = nextRight;
    else {
      i += 1;
      j += 1;
    }
  }
  return pairs;
}

function alignmentPairs(left: SourceAlignmentUnit[], right: PdfAlignmentUnit[]): Array<[number, number]> {
  if (!left.length || !right.length) return [];
  if (left.length * right.length > MAX_LCS_CELLS) return greedyAlignmentPairs(left, right);
  const width = right.length;
  const directions = new Uint8Array(left.length * width);
  let previous = new Uint32Array(width + 1);
  let current = new Uint32Array(width + 1);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= width; j += 1) {
      const directionIndex = (i - 1) * width + j - 1;
      if (left[i - 1].key === right[j - 1].key) {
        current[j] = previous[j - 1] + 1;
        directions[directionIndex] = 1;
      } else if (previous[j] >= current[j - 1]) {
        current[j] = previous[j];
        directions[directionIndex] = 2;
      } else {
        current[j] = current[j - 1];
        directions[directionIndex] = 3;
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }

  const pairs: Array<[number, number]> = [];
  let i = left.length;
  let j = right.length;
  while (i > 0 && j > 0) {
    const direction = directions[(i - 1) * width + j - 1];
    if (direction === 1) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (direction === 2) i -= 1;
    else j -= 1;
  }
  return pairs.reverse();
}

function selectionKey(char: PdfGeometryChar): string {
  return `${char.pageIndex}:${char.charIndex}`;
}

function charsForLines(geometry: PdfTextGeometry, lines: Array<PdfGeometryLine & { pageIndex: number }>): PdfGeometryChar[] {
  const pages = new Map(geometry.pages.map((page) => [page.pageIndex, page]));
  return lines.flatMap((line) => (pages.get(line.pageIndex)?.chars ?? [])
    .filter((char) => char.charIndex >= line.char_start && char.charIndex < line.char_end)
    .sort((left, right) => left.charIndex - right.charIndex));
}

function alignSelectionChars(
  source: string,
  block: SourceBlock,
  lid: string,
  lines: Array<PdfGeometryLine & { pageIndex: number }>,
  geometry: PdfTextGeometry,
): Map<string, SelectionCharAssignment> {
  const chars = charsForLines(geometry, lines);
  const sourceUnits = sourceAlignmentUnits(source, block.span);
  const pdfUnits = pdfAlignmentUnits(chars);
  const spansByChar = new Map<string, { start: number; end: number }>();
  for (const [sourceIndex, pdfIndex] of alignmentPairs(sourceUnits, pdfUnits)) {
    const key = selectionKey(pdfUnits[pdfIndex].char);
    const sourceSpan = sourceUnits[sourceIndex].span;
    const existing = spansByChar.get(key);
    spansByChar.set(key, existing
      ? { start: Math.min(existing.start, sourceSpan.start), end: Math.max(existing.end, sourceSpan.end) }
      : { ...sourceSpan });
  }

  const direct = chars.map((char) => spansByChar.get(selectionKey(char)) ?? null);
  const nextDirect: Array<{ start: number; end: number } | null> = new Array(chars.length).fill(null);
  let next: { start: number; end: number } | null = null;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (direct[index]) next = direct[index];
    nextDirect[index] = next;
  }

  const assignments = new Map<string, SelectionCharAssignment>();
  let previous: { start: number; end: number } | null = null;
  for (let index = 0; index < chars.length; index += 1) {
    const span = direct[index];
    if (span) previous = span;
    const insertion = previous && nextDirect[index] ? previous.end : undefined;
    if (!span && insertion === undefined) continue;
    assignments.set(selectionKey(chars[index]), {
      lid,
      source_span: span ?? { start: insertion!, end: insertion! },
    });
  }
  return assignments;
}

export function buildHybridFoundation(input: HybridFoundationInput): HybridFoundationArtifacts {
  const blocks = markdownToBlocks(input.source_txt);
  const lidNodes = segment(blocks);
  const leafLids = new Set(lidNodes.filter((node) => node.children.length === 0).map((node) => node.lid));
  const lidBySpan = new Map(lidNodes.filter((node) => node.children.length === 0).map((node) => [keyOfSpan(node.span), node.lid]));
  const configHash = sha256(`hybrid_foundation_v2:${ALIGNMENT_ALGORITHM}`);
  const allLines = input.pdf_geometry.pages.flatMap(pageLinesInReadingOrder);
  const entries: PdfSourceMapEntry[] = [];
  const pageRegionIndex: Record<string, string[]> = {};
  const selectionAssignments = new Map<string, SelectionCharAssignment>();
  let lineCursor = 0;

  for (const block of blocks) {
    const lid = lidBySpan.get(keyOfSpan(block.span));
    if (!lid) continue;
    const match = findLinesForBlock(allLines, block, lineCursor);
    if (!match) {
      entries.push({
        lid,
        source_span: block.span,
        status: "unmapped",
        regions: [],
        alignment: { confidence: 0, reason: "source block was not found in PDF text geometry" },
      });
      continue;
    }
    const matchedLines = allLines.slice(match.startIndex, match.endIndex + 1);
    const regionBase = `r${entries.length + 1}`;
    const regions = matchedLines.map((line, offset) => lineRegion(
      line.pageIndex,
      line,
      matchedLines.length === 1 ? regionBase : `${regionBase}-${offset + 1}`,
    ));
    for (const region of regions) {
      pageRegionIndex[String(region.pageIndex)] = [...(pageRegionIndex[String(region.pageIndex)] ?? []), region.region_id];
    }
    entries.push({
      lid,
      source_span: block.span,
      status: regions.length === 1 ? "line_fallback" : "block_fallback",
      regions,
      primary_region: regions[0],
      alignment: {
        confidence: match.recovered
          ? 0.68
          : match.quality === "exact"
            ? 0.9
            : match.quality === "line_start"
              ? 0.82
              : 0.7,
        reason: `${match.recovered ? "recovered " : ""}${match.quality} token anchor matched ${regions.length} PDF line${regions.length === 1 ? "" : "s"}`,
      },
    });
    for (const [key, assignment] of alignSelectionChars(input.source_txt, block, lid, matchedLines, input.pdf_geometry)) {
      selectionAssignments.set(key, assignment);
    }
    lineCursor = match.endIndex;
  }

  const pdfSourceMap: PdfSourceMap = {
    version: "pdf_source_map.v1",
    book_id: input.book_id,
    coordinate_system: pdfUserSpaceCoordinateSystem(),
    pages: input.pdf_geometry.pages.map((page) => ({
      pageIndex: page.pageIndex,
      ...(page.page_label ? { page_label: page.page_label } : {}),
      width: page.width,
      height: page.height,
      rotate: page.rotate,
      view: page.view,
    })),
    entries,
    excluded_regions: [],
    page_region_index: pageRegionIndex,
    page_excluded_index: {},
    config_hash: configHash,
  };

  const pageShards: PdfSelectionMapPageShard[] = input.pdf_geometry.pages.map((page) => ({
    version: "pdf_selection_map_page.v1",
    book_id: input.book_id,
    pageIndex: page.pageIndex,
    ...(page.page_label ? { page_label: page.page_label } : {}),
    chars: page.chars.map((char) => {
      const assignment = selectionAssignments.get(selectionKey(char));
      return {
        char_index: char.charIndex,
        text: char.text,
        rect: { pageIndex: char.pageIndex, bbox: char.bbox },
        source_span: assignment?.source_span ?? { start: 0, end: 0 },
        ...(assignment ? { lid: assignment.lid } : {}),
      };
    }),
  }));
  const selectionManifest: PdfSelectionMapManifest = {
    version: "pdf_selection_map.v1",
    book_id: input.book_id,
    coordinate_system: pdfUserSpaceCoordinateSystem(),
    config_hash: configHash,
    page_shards: pageShards.map((page) => ({
      pageIndex: page.pageIndex,
      ...(page.page_label ? { page_label: page.page_label } : {}),
      path: `pages/${page.pageIndex}.json`,
      sha256: jsonSha256(page),
    })),
  };

  const mapped = entries.filter((entry) => entry.status !== "unmapped").length;
  const alignableLids = new Set(blocks
    .filter((block) => !block.assetKind && alignmentTokens(block.text).length > 0)
    .map((block) => lidBySpan.get(keyOfSpan(block.span)))
    .filter((lid): lid is string => Boolean(lid)));
  const headingLids = new Set(blocks
    .filter((block) => block.kind === "heading" && alignmentTokens(block.text).length > 0)
    .map((block) => lidBySpan.get(keyOfSpan(block.span)))
    .filter((lid): lid is string => Boolean(lid)));
  const mappedAlignable = entries.filter((entry) => alignableLids.has(entry.lid) && entry.status !== "unmapped").length;
  const mappedHeadings = entries.filter((entry) => headingLids.has(entry.lid) && entry.status !== "unmapped").length;
  const textMappingRatio = alignableLids.size ? mappedAlignable / alignableLids.size : 1;
  const headingMappingRatio = headingLids.size ? mappedHeadings / headingLids.size : 1;
  const allEntriesReferenceLeaves = entries.every((entry) => leafLids.has(entry.lid));
  const allRegionsInBounds = entries.every((entry) =>
    entry.regions.every((region) => {
      const page = pdfSourceMap.pages.find((p) => p.pageIndex === region.pageIndex);
      return Boolean(page) && region.bbox[0] >= 0 && region.bbox[1] >= 0 && region.bbox[2] <= page!.width && region.bbox[3] <= page!.height;
    }),
  );
  const pageHashesMatch = selectionManifest.page_shards.every((shard) => jsonSha256(pageShards.find((page) => page.pageIndex === shard.pageIndex)) === shard.sha256);
  const alignmentReport: AlignmentReport = {
    version: "alignment_report.v1",
    book_id: input.book_id,
    config: {
      algorithm: ALIGNMENT_ALGORITHM,
      lookback_words: 24,
      lookahead_words: ALIGNMENT_LOOKAHEAD_WORDS,
      merge_gap_utf16: 2,
      coordinate_system: "pdf_user_space",
      normalization: ["unicode_nfkc", "case_fold", "hyphen_join", "punctuation_to_space", "whitespace_collapse"],
    },
    config_hash: configHash,
    hard_gates: {
      all_entries_reference_leaf_lids: allEntriesReferenceLeaves,
      all_mapped_regions_in_page_bounds: allRegionsInBounds,
      selection_page_hashes_match: pageHashesMatch,
      leaf_count: leafLids.size,
      mapped_leaf_count: mapped,
      minimum_text_mapping_ratio: textMappingRatio >= MINIMUM_TEXT_MAPPING_RATIO,
      minimum_heading_mapping_ratio: headingMappingRatio >= MINIMUM_HEADING_MAPPING_RATIO,
    },
    diagnostics: {
      mapped_leaf_ratio: leafLids.size ? mapped / leafLids.size : 0,
      alignable_text_count: alignableLids.size,
      mapped_text_count: mappedAlignable,
      mapped_text_ratio: textMappingRatio,
      heading_count: headingLids.size,
      mapped_heading_count: mappedHeadings,
      mapped_heading_ratio: headingMappingRatio,
      line_fallback_count: entries.filter((entry) => entry.status === "line_fallback").length,
      unmapped_count: entries.filter((entry) => entry.status === "unmapped").length,
    },
    normalization_provenance: [],
  };

  const degradedReason = entries.some((entry) => entry.status !== "word_mapped") ? "PDF map uses fallback or unmapped entries" : undefined;
  const sourceManifest = buildSourceManifestV2({
    book_id: input.book_id,
    source_sha256: sha256(input.source_txt),
    original_pdf_path: input.original_pdf_path,
    original_pdf_sha256: input.original_pdf_sha256,
    original_pdf_fingerprint: input.original_pdf_fingerprint,
    pdf_source_map_path: "pdf_source_map.json",
    pdf_selection_map_manifest_path: "pdf_selection_map/manifest.json",
    alignment_report_path: "alignment_report.json",
    config_hash: configHash,
    capability_overrides: degradedReason
      ? {
          project_lid_to_pdf: {
            status: "degraded",
            reason: degradedReason,
            artifact_path: "pdf_source_map.json",
            report_path: "alignment_report.json",
            config_hash: configHash,
          },
          project_ranges_to_pdf: {
            status: "degraded",
            reason: degradedReason,
            artifact_path: "pdf_source_map.json",
            report_path: "alignment_report.json",
            config_hash: configHash,
          },
        }
      : undefined,
  });

  return {
    base: { book_id: input.book_id, lid_nodes: lidNodes, graph_nodes: [], graph_edges: [] },
    source_manifest: sourceManifest,
    pdf_source_map: pdfSourceMap,
    pdf_selection_map_manifest: selectionManifest,
    pdf_selection_map_pages: pageShards,
    alignment_report: alignmentReport,
  };
}

export function assertHybridFoundationHardGates(artifacts: HybridFoundationArtifacts): void {
  const leafLids = new Set(artifacts.base.lid_nodes.filter((node) => node.children.length === 0).map((node) => node.lid));
  for (const entry of artifacts.pdf_source_map.entries) {
    if (!leafLids.has(entry.lid)) throw new Error(`pdf_source_map entry references non-leaf or missing LID: ${entry.lid}`);
    for (const region of entry.regions) {
      const page = artifacts.pdf_source_map.pages.find((p) => p.pageIndex === region.pageIndex);
      if (!page) throw new Error(`pdf_source_map region references missing page: ${region.pageIndex}`);
      if (region.bbox[0] < 0 || region.bbox[1] < 0 || region.bbox[2] > page.width || region.bbox[3] > page.height) {
        throw new Error(`pdf_source_map region is outside page bounds: ${region.region_id}`);
      }
    }
  }
  for (const shard of artifacts.pdf_selection_map_manifest.page_shards) {
    const page = artifacts.pdf_selection_map_pages.find((p) => p.pageIndex === shard.pageIndex);
    if (!page) throw new Error(`pdf_selection_map shard references missing page: ${shard.pageIndex}`);
    if (jsonSha256(page) !== shard.sha256) throw new Error(`pdf_selection_map shard hash mismatch: ${shard.path}`);
  }
  if (artifacts.alignment_report.hard_gates.minimum_text_mapping_ratio === false) {
    throw new Error("hybrid foundation text mapping coverage is below the reader-ready minimum");
  }
  if (artifacts.alignment_report.hard_gates.minimum_heading_mapping_ratio === false) {
    throw new Error("hybrid foundation heading mapping coverage is below the reader-ready minimum");
  }
}

export function readHybridFoundationV1ArtifactSet(root: string): HybridFoundationArtifacts {
  const selectionDir = path.join(root, "pdf_selection_map");
  const selectionManifest = PdfSelectionMapManifestZ.parse(JSON.parse(
    readFileSync(path.join(selectionDir, "manifest.json"), "utf8"),
  ));
  const selectionRoot = path.resolve(selectionDir);
  const pages = selectionManifest.page_shards.map((shard) => {
    const pagePath = path.resolve(selectionDir, shard.path);
    const relative = path.relative(selectionRoot, pagePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`pdf_selection_map shard path escapes its artifact directory: ${shard.path}`);
    }
    return PdfSelectionMapPageShardZ.parse(JSON.parse(readFileSync(pagePath, "utf8")));
  });
  return {
    base: ReadOnlyBaseZ.parse(JSON.parse(readFileSync(path.join(root, "base.json"), "utf8"))),
    source_manifest: SourceManifestV2Z.parse(JSON.parse(readFileSync(path.join(root, "source_manifest.json"), "utf8"))),
    pdf_source_map: PdfSourceMapZ.parse(JSON.parse(readFileSync(path.join(root, "pdf_source_map.json"), "utf8"))),
    pdf_selection_map_manifest: selectionManifest,
    pdf_selection_map_pages: pages,
    alignment_report: AlignmentReportZ.parse(JSON.parse(readFileSync(path.join(root, "alignment_report.json"), "utf8"))),
  };
}

export function validateHybridFoundationV1ArtifactSet(root: string): HybridFoundationArtifacts {
  const artifacts = readHybridFoundationV1ArtifactSet(root);
  assertHybridFoundationHardGates(artifacts);
  const bookIds = new Set([
    artifacts.base.book_id,
    artifacts.source_manifest.book_id,
    artifacts.pdf_source_map.book_id,
    artifacts.pdf_selection_map_manifest.book_id,
    artifacts.alignment_report.book_id,
    ...artifacts.pdf_selection_map_pages.map((page) => page.book_id),
  ]);
  if (bookIds.size !== 1) throw new Error("hybrid foundation artifact book identity differs");
  const configHashes = new Set([
    artifacts.pdf_source_map.config_hash,
    artifacts.pdf_selection_map_manifest.config_hash,
    artifacts.alignment_report.config_hash,
  ]);
  if (configHashes.size !== 1) throw new Error("hybrid foundation artifact config hashes differ");
  const source = readFileSync(path.join(root, artifacts.source_manifest.canonical_source.path));
  if (sha256(source) !== artifacts.source_manifest.canonical_source.sha256) {
    throw new Error("hybrid foundation canonical source hash differs from source_manifest");
  }
  return artifacts;
}

export function writeHybridFoundationArtifacts(outputDir: string, sourceTxt: string, artifacts: HybridFoundationArtifacts): WriteHybridFoundationArtifactsResult {
  assertHybridFoundationHardGates(artifacts);
  mkdirSync(outputDir, { recursive: true });
  const selectionDir = path.join(outputDir, "pdf_selection_map");
  const selectionPagesDir = path.join(selectionDir, "pages");
  mkdirSync(selectionPagesDir, { recursive: true });
  const basePath = path.join(outputDir, "base.json");
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceManifestPath = path.join(outputDir, "source_manifest.json");
  const pdfSourceMapPath = path.join(outputDir, "pdf_source_map.json");
  const selectionManifestPath = path.join(selectionDir, "manifest.json");
  const alignmentReportPath = path.join(outputDir, "alignment_report.json");
  writeFileSync(basePath, JSON.stringify(artifacts.base, null, 2), "utf8");
  writeFileSync(sourcePath, sourceTxt, "utf8");
  writeFileSync(sourceManifestPath, JSON.stringify(artifacts.source_manifest, null, 2), "utf8");
  writeFileSync(pdfSourceMapPath, JSON.stringify(artifacts.pdf_source_map, null, 2), "utf8");
  writeFileSync(selectionManifestPath, JSON.stringify(artifacts.pdf_selection_map_manifest, null, 2), "utf8");
  const pagePaths = artifacts.pdf_selection_map_pages.map((page) => {
    const pagePath = path.join(selectionPagesDir, `${page.pageIndex}.json`);
    writeFileSync(pagePath, JSON.stringify(page, null, 2), "utf8");
    return pagePath;
  });
  writeFileSync(alignmentReportPath, JSON.stringify(artifacts.alignment_report, null, 2), "utf8");
  return {
    base_path: basePath,
    source_path: sourcePath,
    source_manifest_path: sourceManifestPath,
    pdf_source_map_path: pdfSourceMapPath,
    pdf_selection_map_manifest_path: selectionManifestPath,
    pdf_selection_map_page_paths: pagePaths,
    alignment_report_path: alignmentReportPath,
  };
}
