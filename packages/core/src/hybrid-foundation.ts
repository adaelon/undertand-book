import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
import type { PdfGeometryChar, PdfGeometryLine, PdfTextGeometry } from "./pdf-geometry";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";

export interface AlignmentReport {
  version: "alignment_report.v1";
  book_id: string;
  config: {
    algorithm: "monotonic_forward_fuzzy_v1";
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

function searchable(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().toLowerCase();
}

function lineRegion(pageIndex: number, line: PdfGeometryLine, regionId: string): PdfRegion {
  return {
    region_id: regionId,
    pageIndex,
    bbox: line.bbox,
  };
}

function findLineForBlock(lines: Array<PdfGeometryLine & { pageIndex: number }>, block: SourceBlock, startAt: number): number {
  const needle = searchable(block.text);
  if (!needle) return -1;
  for (let i = startAt; i < lines.length; i++) {
    if (searchable(lines[i].text).includes(needle)) return i;
  }
  return -1;
}

function rectIntersects(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function charEntryForRegions(char: PdfGeometryChar, entries: PdfSourceMapEntry[]): PdfSourceMapEntry | undefined {
  return entries.find((entry) => entry.regions.some((region) => region.pageIndex === char.pageIndex && rectIntersects(region.bbox, char.bbox)));
}

export function buildHybridFoundation(input: HybridFoundationInput): HybridFoundationArtifacts {
  const blocks = markdownToBlocks(input.source_txt);
  const lidNodes = segment(blocks);
  const leafLids = new Set(lidNodes.filter((node) => node.children.length === 0).map((node) => node.lid));
  const lidBySpan = new Map(lidNodes.filter((node) => node.children.length === 0).map((node) => [keyOfSpan(node.span), node.lid]));
  const configHash = sha256("hybrid_foundation_v1:monotonic_forward_fuzzy_v1");
  const allLines = input.pdf_geometry.pages.flatMap((page) => page.lines.map((line) => ({ ...line, pageIndex: page.pageIndex })));
  const entries: PdfSourceMapEntry[] = [];
  const pageRegionIndex: Record<string, string[]> = {};
  let lineCursor = 0;

  for (const block of blocks) {
    const lid = lidBySpan.get(keyOfSpan(block.span));
    if (!lid) continue;
    const lineIndex = findLineForBlock(allLines, block, lineCursor);
    if (lineIndex < 0) {
      entries.push({
        lid,
        source_span: block.span,
        status: "unmapped",
        regions: [],
        alignment: { confidence: 0, reason: "source block was not found in PDF text geometry" },
      });
      continue;
    }
    const line = allLines[lineIndex];
    const region = lineRegion(line.pageIndex, line, `r${entries.length + 1}`);
    pageRegionIndex[String(line.pageIndex)] = [...(pageRegionIndex[String(line.pageIndex)] ?? []), region.region_id];
    entries.push({
      lid,
      source_span: block.span,
      status: "line_fallback",
      regions: [region],
      primary_region: region,
      alignment: { confidence: 0.8, reason: "line text matched source block" },
    });
    lineCursor = lineIndex + 1;
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
      const entry = charEntryForRegions(char, entries);
      return {
        char_index: char.charIndex,
        text: char.text,
        rect: { pageIndex: char.pageIndex, bbox: char.bbox },
        source_span: entry?.source_span ?? { start: 0, end: 0 },
        ...(entry ? { lid: entry.lid } : {}),
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
      algorithm: "monotonic_forward_fuzzy_v1",
      lookback_words: 24,
      lookahead_words: 240,
      merge_gap_utf16: 2,
      coordinate_system: "pdf_user_space",
      normalization: ["unicode_nfc", "whitespace_collapse"],
    },
    config_hash: configHash,
    hard_gates: {
      all_entries_reference_leaf_lids: allEntriesReferenceLeaves,
      all_mapped_regions_in_page_bounds: allRegionsInBounds,
      selection_page_hashes_match: pageHashesMatch,
      leaf_count: leafLids.size,
      mapped_leaf_count: mapped,
    },
    diagnostics: {
      mapped_leaf_ratio: leafLids.size ? mapped / leafLids.size : 0,
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
