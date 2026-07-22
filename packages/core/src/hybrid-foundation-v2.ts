import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markdownToBlocks } from "./md-adapter";
import {
  alignHybridFoundationV2,
  PDF_DISPLAY_TOKEN_POLICY,
  type HybridChildProjection,
} from "./hybrid-alignment-v2";
import type { PdfTextGeometry } from "./pdf-geometry";
import {
  pdfUserSpaceCoordinateSystem,
  type PdfSelectionMapManifestV2,
  type PdfSelectionMapPageShardV2,
  type PdfSourceMapEntryV2,
  type PdfSourceMapV2,
} from "./pdf-source-map";
import { segment } from "./segment";
import {
  acceptSourceAlignmentEvidence,
  type SourceAlignmentEvidenceV1,
} from "./source-alignment-evidence";
import { sourceReconciliationEvidenceFingerprint } from "./source-reconciliation";
import { buildSourceManifestV2, type SourceManifestV2 } from "./source-manifest";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import {
  AlignmentReportV2Z,
  PdfSelectionMapManifestV2Z,
  PdfSelectionMapPageShardV2Z,
  PdfSourceMapV2Z,
  ReadOnlyBaseZ,
  SourceManifestV2Z,
} from "./zod";

export const HYBRID_QUALITY_POLICY_V1 = {
  policy_version: "hybrid_quality_policy.v1" as const,
  full_thresholds: {
    unit_location_ratio: 0.95,
    exact_text_span_ratio: 0.9,
    exact_formula_ratio: 0.8,
    heading_location_ratio: 0.95,
  },
};

export interface HybridFoundationV2Input {
  book_id: string;
  source_txt: string;
  original_pdf_path: string;
  original_pdf_sha256: string;
  original_pdf_fingerprint?: string;
  pdf_geometry: PdfTextGeometry;
  source_alignment_evidence?: SourceAlignmentEvidenceV1;
}

export interface HybridFoundationV2Artifacts {
  base: ReadOnlyBase;
  source_manifest: SourceManifestV2;
  pdf_source_map: PdfSourceMapV2;
  pdf_selection_map_manifest: PdfSelectionMapManifestV2;
  pdf_selection_map_pages: PdfSelectionMapPageShardV2[];
  alignment_report: ReturnType<typeof AlignmentReportV2Z.parse>;
}

export interface ValidateHybridFoundationV2ArtifactSetOptions {
  expected_pdf_sha256?: string;
  expected_source_alignment_evidence_sha256?: string;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function jsonSha256(value: unknown): string {
  return sha256(JSON.stringify(value, null, 2));
}

function spanKey(span: { start: number; end: number }): string {
  return `${span.start}:${span.end}`;
}

function contentSpan(source: string, block: ReturnType<typeof markdownToBlocks>[number]) {
  const text = block.text.trim();
  const raw = source.slice(block.span.start, block.span.end);
  const offset = raw.indexOf(text);
  return offset >= 0
    ? { start: block.span.start + offset, end: block.span.start + offset + text.length }
    : { ...block.span };
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 1;
}

function duplicateRegionCount(entries: PdfSourceMapEntryV2[]): number {
  const lidsByRegion = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const region of entry.regions) {
      const key = `${region.pageIndex}:${region.bbox.join(",")}`;
      const lids = lidsByRegion.get(key) ?? new Set<string>();
      lids.add(entry.lid);
      lidsByRegion.set(key, lids);
    }
  }
  return [...lidsByRegion.values()].filter((lids) => lids.size > 1).length;
}

export interface HybridProjectionConflictResolution {
  projections: HybridChildProjection[];
  raw_duplicate_region_binding_count: number;
  raw_duplicate_selection_binding_count: number;
  conflicted_lid_count: number;
}

export function resolveHybridProjectionConflicts(
  projections: HybridChildProjection[],
): HybridProjectionConflictResolution {
  const regionOwners = new Map<string, Set<string>>();
  const selectionOwners = new Map<string, Set<string>>();
  for (const projection of projections) {
    for (const region of projection.regions) {
      const key = `${region.pageIndex}:${region.bbox.join(",")}`;
      const owners = regionOwners.get(key) ?? new Set<string>();
      owners.add(projection.lid);
      regionOwners.set(key, owners);
    }
    for (const assignment of projection.selection_assignments) {
      const key = `${assignment.pageIndex}:${assignment.char_index}`;
      const owners = selectionOwners.get(key) ?? new Set<string>();
      owners.add(projection.lid);
      selectionOwners.set(key, owners);
    }
  }
  const duplicateRegions = [...regionOwners.values()].filter((owners) => owners.size > 1);
  const duplicateSelections = [...selectionOwners.values()].filter((owners) => owners.size > 1);
  const conflictedLids = new Set([
    ...duplicateRegions.flatMap((owners) => [...owners]),
    ...duplicateSelections.flatMap((owners) => [...owners]),
  ]);
  return {
    projections: projections.map((projection) => {
      if (!conflictedLids.has(projection.lid)) return projection;
      const {
        primary_region: _primaryRegion,
        formula_display_text: _formulaDisplayText,
        ...withoutDegradedEvidence
      } = projection;
      return {
        ...withoutDegradedEvidence,
        precision: "unmapped",
        regions: [],
        exact_source_spans: [],
        selection_assignments: [],
        alignment: {
          unit_id: projection.alignment.unit_id,
          reason: "projection discarded because its PDF binding conflicts with another LID",
        },
      };
    }),
    raw_duplicate_region_binding_count: duplicateRegions.length,
    raw_duplicate_selection_binding_count: duplicateSelections.length,
    conflicted_lid_count: conflictedLids.size,
  };
}

function qualityTier(metrics: Omit<ReturnType<typeof AlignmentReportV2Z.parse>["quality"], "policy_version" | "tier">) {
  const thresholds = HYBRID_QUALITY_POLICY_V1.full_thresholds;
  return metrics.unit_location_ratio >= thresholds.unit_location_ratio
    && metrics.exact_text_span_ratio >= thresholds.exact_text_span_ratio
    && metrics.exact_formula_ratio >= thresholds.exact_formula_ratio
    && metrics.heading_location_ratio >= thresholds.heading_location_ratio
    ? "full" as const
    : "degraded" as const;
}

export function buildHybridFoundationV2Candidate(input: HybridFoundationV2Input): HybridFoundationV2Artifacts {
  const blocks = markdownToBlocks(input.source_txt);
  const lidNodes = segment(blocks);
  const leafNodes = lidNodes.filter((node) => node.children.length === 0);
  const leafLids = new Set(leafNodes.map((node) => node.lid));
  const lidBySpan = new Map(leafNodes.map((node) => [spanKey(node.span), node.lid]));
  const expectedEvidenceFingerprint = sourceReconciliationEvidenceFingerprint(
    input.source_txt,
    input.original_pdf_sha256,
  );
  const currentEvidence = input.source_alignment_evidence
    ? acceptSourceAlignmentEvidence(input.source_alignment_evidence, expectedEvidenceFingerprint)
    : undefined;
  const rawAlignment = alignHybridFoundationV2(
    input.source_txt,
    input.pdf_geometry,
    currentEvidence ?? undefined,
  );
  const conflictResolution = resolveHybridProjectionConflicts(rawAlignment.projections);
  const alignment = { ...rawAlignment, projections: conflictResolution.projections };
  const projectionByLid = new Map(alignment.projections.map((projection) => [projection.lid, projection]));
  const entries: PdfSourceMapEntryV2[] = leafNodes.map((node) => {
    const projection = projectionByLid.get(node.lid);
    if (!projection) {
      return {
        lid: node.lid,
        source_span: { ...node.span },
        precision: "unmapped",
        regions: [],
        exact_source_spans: [],
        alignment: { unit_id: "missing-unit", reason: "leaf LID was not represented by an alignment unit" },
      };
    }
    return {
      lid: projection.lid,
      source_span: { ...projection.source_span },
      precision: projection.precision,
      regions: projection.regions,
      exact_source_spans: projection.exact_source_spans,
      ...(projection.formula_display_text ? { formula_display_text: projection.formula_display_text } : {}),
      ...(projection.primary_region ? { primary_region: projection.primary_region } : {}),
      alignment: projection.alignment,
    };
  });
  const config = {
    algorithm: "semantic_unit_projection_v2" as const,
    coordinate_system: "pdf_user_space" as const,
    quality_policy_version: "hybrid_quality_policy.v1" as const,
    display_token_policy_version: PDF_DISPLAY_TOKEN_POLICY.version,
  };
  const configHash = sha256(JSON.stringify(config));
  const pageRegionIndex: Record<string, string[]> = {};
  for (const entry of entries) {
    for (const region of entry.regions) {
      pageRegionIndex[String(region.pageIndex)] = [
        ...(pageRegionIndex[String(region.pageIndex)] ?? []),
        region.region_id,
      ];
    }
  }
  const pdfSourceMap: PdfSourceMapV2 = {
    version: "pdf_source_map.v2",
    display_token_policy_version: PDF_DISPLAY_TOKEN_POLICY.version,
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
    page_region_index: pageRegionIndex,
    config_hash: configHash,
  };

  const assignmentByPdfChar = new Map<string, HybridChildProjection["selection_assignments"][number] & { lid: string }>();
  const duplicateSelectionBindings = new Set<string>();
  for (const projection of alignment.projections.filter((item) => item.selection_assignments.length > 0)) {
    for (const assignment of projection.selection_assignments) {
      const key = `${assignment.pageIndex}:${assignment.char_index}`;
      const existing = assignmentByPdfChar.get(key);
      if (existing && (existing.lid !== projection.lid || spanKey(existing.source_span) !== spanKey(assignment.source_span))) {
        duplicateSelectionBindings.add(key);
        continue;
      }
      assignmentByPdfChar.set(key, { ...assignment, lid: projection.lid });
    }
  }
  const selectionPages: PdfSelectionMapPageShardV2[] = input.pdf_geometry.pages.map((page) => ({
    version: "pdf_selection_map_page.v2",
    book_id: input.book_id,
    pageIndex: page.pageIndex,
    ...(page.page_label ? { page_label: page.page_label } : {}),
    chars: [...assignmentByPdfChar.values()]
      .filter((assignment) => assignment.pageIndex === page.pageIndex)
      .sort((left, right) => left.char_index - right.char_index)
      .map(({ pageIndex: _pageIndex, ...assignment }) => assignment),
  }));
  const selectionManifest: PdfSelectionMapManifestV2 = {
    version: "pdf_selection_map.v2",
    book_id: input.book_id,
    coordinate_system: pdfUserSpaceCoordinateSystem(),
    config_hash: configHash,
    page_shards: selectionPages.map((page) => ({
      pageIndex: page.pageIndex,
      ...(page.page_label ? { page_label: page.page_label } : {}),
      path: `pages/${page.pageIndex}.json`,
      sha256: jsonSha256(page),
    })),
  };

  const textBlocks = blocks.filter((block) => block.kind !== "heading" && !block.assetKind);
  const formulaBlocks = blocks.filter((block) => block.assetKind === "formula");
  const headingBlocks = blocks.filter((block) => block.kind === "heading");
  const exactTextLength = textBlocks.reduce((sum, block) => {
    const lid = lidBySpan.get(spanKey(block.span));
    const projection = lid ? projectionByLid.get(lid) : undefined;
    return sum + (projection
      ? projection.exact_source_spans.reduce((length, span) => length + span.end - span.start, 0)
      : 0);
  }, 0);
  const textLength = textBlocks.reduce((sum, block) => {
    const span = contentSpan(input.source_txt, block);
    return sum + span.end - span.start;
  }, 0);
  const exactFormulaCount = formulaBlocks.filter((block) => {
    const lid = lidBySpan.get(spanKey(block.span));
    const projection = lid ? projectionByLid.get(lid) : undefined;
    return projection?.precision === "region_exact" || Boolean(projection?.formula_display_text);
  }).length;
  const locatedHeadingCount = headingBlocks.filter((block) => {
    const lid = lidBySpan.get(spanKey(block.span));
    return lid ? projectionByLid.get(lid)?.precision !== "unmapped" : false;
  }).length;
  const metrics = {
    unit_location_ratio: ratio(alignment.locations.filter((location) => location.status === "located").length, alignment.units.length),
    exact_text_span_ratio: ratio(exactTextLength, textLength),
    exact_formula_ratio: ratio(exactFormulaCount, formulaBlocks.length),
    heading_location_ratio: ratio(locatedHeadingCount, headingBlocks.length),
  };
  const tier = qualityTier(metrics);
  const allRegionsInBounds = entries.every((entry) => entry.regions.every((region) => {
    const page = pdfSourceMap.pages.find((candidate) => candidate.pageIndex === region.pageIndex);
    return Boolean(page)
      && region.bbox[0] >= 0
      && region.bbox[1] >= 0
      && region.bbox[2] <= page!.width
      && region.bbox[3] <= page!.height;
  }));
  const locatedTokenSpans = alignment.locations
    .filter((location) => location.status === "located" && location.token_span)
    .map((location) => location.token_span!);
  const locatedUnitsMonotonic = locatedTokenSpans.every((span, index) => index === 0 || span.start >= locatedTokenSpans[index - 1].end);
  const selectionShardsMatch = selectionManifest.page_shards.every((shard) => (
    jsonSha256(selectionPages.find((page) => page.pageIndex === shard.pageIndex)) === shard.sha256
  ));
  const duplicateRegionBindings = duplicateRegionCount(entries);
  const evidenceHash = input.source_alignment_evidence ? jsonSha256(input.source_alignment_evidence) : undefined;
  const alignmentReport = AlignmentReportV2Z.parse({
    version: "alignment_report.v2",
    book_id: input.book_id,
    input_fingerprint: {
      source_sha256: sha256(input.source_txt),
      pdf_sha256: input.original_pdf_sha256.toLowerCase(),
      ...(evidenceHash ? { source_alignment_evidence_sha256: evidenceHash } : {}),
    },
    config,
    config_hash: configHash,
    integrity: {
      input_fingerprint_matches: input.source_alignment_evidence ? Boolean(currentEvidence) : true,
      artifact_hashes_match: true,
      all_leaf_lids_unique_and_present: leafLids.size === leafNodes.length
        && entries.length === leafNodes.length
        && entries.every((entry) => leafLids.has(entry.lid)),
      all_regions_in_page_bounds: allRegionsInBounds,
      located_units_monotonic: locatedUnitsMonotonic,
      no_duplicate_pdf_bindings: duplicateRegionBindings === 0 && duplicateSelectionBindings.size === 0,
      selection_shards_match_manifest: selectionShardsMatch,
    },
    quality: {
      policy_version: HYBRID_QUALITY_POLICY_V1.policy_version,
      tier,
      ...metrics,
    },
    diagnostics: {
      leaf_count: leafNodes.length,
      located_unit_count: alignment.locations.filter((location) => location.status === "located").length,
      unmapped_leaf_count: entries.filter((entry) => entry.precision === "unmapped").length,
      duplicate_pdf_binding_count: duplicateRegionBindings,
      duplicate_selection_binding_count: duplicateSelectionBindings.size,
      raw_duplicate_pdf_binding_count: conflictResolution.raw_duplicate_region_binding_count,
      raw_duplicate_selection_binding_count: conflictResolution.raw_duplicate_selection_binding_count,
      conflicted_lid_count: conflictResolution.conflicted_lid_count,
      location_reason_counts: Object.fromEntries([...new Set(alignment.locations.map((location) => location.reason))].map((reason) => [
        reason,
        alignment.locations.filter((location) => location.reason === reason).length,
      ])),
      projection_reason_counts: Object.fromEntries([...new Set(alignment.projections.map((projection) => projection.alignment.reason))].map((reason) => [
        reason,
        alignment.projections.filter((projection) => projection.alignment.reason === reason).length,
      ])),
      precision_counts: Object.fromEntries(["char_exact", "region_exact", "partial", "unmapped"].map((precision) => [
        precision,
        entries.filter((entry) => entry.precision === precision).length,
      ])),
    },
  });
  const degradedReason = tier === "degraded" ? "PDF alignment quality is degraded; per-entry precision gates apply" : undefined;
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
    capability_overrides: degradedReason ? {
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
    } : undefined,
    alignment_quality: { ...alignmentReport.quality, report_path: "alignment_report.json" },
  });

  return {
    base: { book_id: input.book_id, lid_nodes: lidNodes, graph_nodes: [], graph_edges: [] },
    source_manifest: sourceManifest,
    pdf_source_map: pdfSourceMap,
    pdf_selection_map_manifest: selectionManifest,
    pdf_selection_map_pages: selectionPages,
    alignment_report: alignmentReport,
  };
}

export function assertHybridFoundationV2Integrity(artifacts: HybridFoundationV2Artifacts): void {
  ReadOnlyBaseZ.parse(artifacts.base);
  SourceManifestV2Z.parse(artifacts.source_manifest);
  PdfSourceMapV2Z.parse(artifacts.pdf_source_map);
  PdfSelectionMapManifestV2Z.parse(artifacts.pdf_selection_map_manifest);
  artifacts.pdf_selection_map_pages.forEach((page) => PdfSelectionMapPageShardV2Z.parse(page));
  const report = AlignmentReportV2Z.parse(artifacts.alignment_report);
  if (artifacts.pdf_source_map.display_token_policy_version
    !== report.config.display_token_policy_version) {
    throw new Error("hybrid foundation v2 display token policy versions differ");
  }
  const failed = Object.entries(report.integrity).filter(([, passed]) => !passed).map(([gate]) => gate);
  if (failed.length) throw new Error(`hybrid foundation v2 integrity failed: ${failed.join(", ")}`);
}

function safeSelectionShardPath(selectionDir: string, shardPath: string): string {
  const root = path.resolve(selectionDir);
  const target = path.resolve(root, shardPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`pdf_selection_map shard path escapes its artifact directory: ${shardPath}`);
  }
  return target;
}

export function writeHybridFoundationV2ArtifactSet(
  outputDir: string,
  sourceTxt: string,
  artifacts: HybridFoundationV2Artifacts,
): void {
  assertHybridFoundationV2Integrity(artifacts);
  mkdirSync(outputDir, { recursive: true });
  const selectionDir = path.join(outputDir, "pdf_selection_map");
  mkdirSync(selectionDir, { recursive: true });
  writeFileSync(path.join(outputDir, "base.json"), JSON.stringify(artifacts.base, null, 2), "utf8");
  writeFileSync(path.join(outputDir, "source.txt"), sourceTxt, "utf8");
  writeFileSync(path.join(outputDir, "source_manifest.json"), JSON.stringify(artifacts.source_manifest, null, 2), "utf8");
  writeFileSync(path.join(outputDir, "pdf_source_map.json"), JSON.stringify(artifacts.pdf_source_map, null, 2), "utf8");
  writeFileSync(path.join(outputDir, "alignment_report.json"), JSON.stringify(artifacts.alignment_report, null, 2), "utf8");
  writeFileSync(
    path.join(selectionDir, "manifest.json"),
    JSON.stringify(artifacts.pdf_selection_map_manifest, null, 2),
    "utf8",
  );
  for (const shard of artifacts.pdf_selection_map_manifest.page_shards) {
    const page = artifacts.pdf_selection_map_pages.find((candidate) => candidate.pageIndex === shard.pageIndex);
    if (!page) throw new Error(`pdf_selection_map shard has no page payload: ${shard.pageIndex}`);
    const target = safeSelectionShardPath(selectionDir, shard.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(page, null, 2), "utf8");
  }
}

export function readHybridFoundationV2ArtifactSet(root: string): HybridFoundationV2Artifacts {
  const selectionDir = path.join(root, "pdf_selection_map");
  const selectionManifest = PdfSelectionMapManifestV2Z.parse(JSON.parse(
    readFileSync(path.join(selectionDir, "manifest.json"), "utf8"),
  ));
  return {
    base: ReadOnlyBaseZ.parse(JSON.parse(readFileSync(path.join(root, "base.json"), "utf8"))),
    source_manifest: SourceManifestV2Z.parse(JSON.parse(readFileSync(path.join(root, "source_manifest.json"), "utf8"))),
    pdf_source_map: PdfSourceMapV2Z.parse(JSON.parse(readFileSync(path.join(root, "pdf_source_map.json"), "utf8"))),
    pdf_selection_map_manifest: selectionManifest,
    pdf_selection_map_pages: selectionManifest.page_shards.map((shard) => (
      PdfSelectionMapPageShardV2Z.parse(JSON.parse(
        readFileSync(safeSelectionShardPath(selectionDir, shard.path), "utf8"),
      ))
    )),
    alignment_report: AlignmentReportV2Z.parse(JSON.parse(readFileSync(path.join(root, "alignment_report.json"), "utf8"))),
  };
}

export function validateHybridFoundationV2ArtifactSet(
  root: string,
  options: ValidateHybridFoundationV2ArtifactSetOptions = {},
): HybridFoundationV2Artifacts {
  const artifacts = readHybridFoundationV2ArtifactSet(root);
  assertHybridFoundationV2Integrity(artifacts);
  const source = readFileSync(path.join(root, artifacts.source_manifest.canonical_source.path));
  const sourceHash = sha256(source);
  if (sourceHash !== artifacts.source_manifest.canonical_source.sha256
    || sourceHash !== artifacts.alignment_report.input_fingerprint.source_sha256) {
    throw new Error("hybrid foundation v2 canonical source hash differs");
  }
  const originalPdf = artifacts.source_manifest.original_pdf;
  if (!originalPdf || originalPdf.sha256 !== artifacts.alignment_report.input_fingerprint.pdf_sha256) {
    throw new Error("hybrid foundation v2 PDF fingerprint differs between manifest and report");
  }
  if (options.expected_pdf_sha256
    && originalPdf.sha256 !== options.expected_pdf_sha256.toLowerCase()) {
    throw new Error("hybrid foundation v2 PDF fingerprint differs from the current input");
  }
  if (options.expected_source_alignment_evidence_sha256
    && artifacts.alignment_report.input_fingerprint.source_alignment_evidence_sha256
      !== options.expected_source_alignment_evidence_sha256) {
    throw new Error("hybrid foundation v2 source alignment evidence hash differs from the current evidence");
  }

  const bookIds = new Set([
    artifacts.base.book_id,
    artifacts.source_manifest.book_id,
    artifacts.pdf_source_map.book_id,
    artifacts.pdf_selection_map_manifest.book_id,
    artifacts.alignment_report.book_id,
    ...artifacts.pdf_selection_map_pages.map((page) => page.book_id),
  ]);
  if (bookIds.size !== 1) throw new Error("hybrid foundation v2 artifact book identity differs");
  const configHashes = new Set([
    artifacts.pdf_source_map.config_hash,
    artifacts.pdf_selection_map_manifest.config_hash,
    artifacts.alignment_report.config_hash,
  ]);
  for (const capability of Object.values(artifacts.source_manifest.capabilities)) {
    if (capability.config_hash) configHashes.add(capability.config_hash);
  }
  if (configHashes.size !== 1) throw new Error("hybrid foundation v2 artifact config hashes differ");
  if (JSON.stringify(artifacts.source_manifest.alignment_quality) !== JSON.stringify({
    ...artifacts.alignment_report.quality,
    report_path: "alignment_report.json",
  })) {
    throw new Error("hybrid foundation v2 manifest quality differs from the alignment report");
  }

  const leafLids = new Set(artifacts.base.lid_nodes
    .filter((node) => node.children.length === 0)
    .map((node) => node.lid));
  const entriesByLid = new Map(artifacts.pdf_source_map.entries.map((entry) => [entry.lid, entry]));
  if (entriesByLid.size !== leafLids.size
    || [...leafLids].some((lid) => !entriesByLid.has(lid))) {
    throw new Error("hybrid foundation v2 source map does not cover each leaf LID exactly once");
  }
  const regionOwners = new Map<string, string>();
  const expectedPageRegionIndex: Record<string, string[]> = {};
  for (const entry of artifacts.pdf_source_map.entries) {
    if (entry.source_span.end > source.length) throw new Error(`v2 entry source span exceeds source.txt: ${entry.lid}`);
    for (const exactSpan of entry.exact_source_spans) {
      if (exactSpan.start < entry.source_span.start || exactSpan.end > entry.source_span.end) {
        throw new Error(`v2 exact source span escapes its LID span: ${entry.lid}`);
      }
    }
    for (const region of entry.regions) {
      const page = artifacts.pdf_source_map.pages.find((candidate) => candidate.pageIndex === region.pageIndex);
      if (!page
        || region.bbox[0] < 0
        || region.bbox[1] < 0
        || region.bbox[2] > page.width
        || region.bbox[3] > page.height) {
        throw new Error(`v2 region is outside page bounds: ${region.region_id}`);
      }
      const binding = `${region.pageIndex}:${region.bbox.join(",")}`;
      const owner = regionOwners.get(binding);
      if (owner && owner !== entry.lid) throw new Error(`duplicate v2 PDF region binding: ${binding}`);
      regionOwners.set(binding, entry.lid);
      (expectedPageRegionIndex[String(region.pageIndex)] ??= []).push(region.region_id);
    }
  }
  for (const regionIds of Object.values(expectedPageRegionIndex)) regionIds.sort((left, right) => left.localeCompare(right));
  const actualPageRegionIndex = Object.fromEntries(Object.entries(artifacts.pdf_source_map.page_region_index)
    .map(([pageIndex, regionIds]) => [pageIndex, [...regionIds].sort((left, right) => left.localeCompare(right))]));
  if (JSON.stringify(actualPageRegionIndex) !== JSON.stringify(expectedPageRegionIndex)) {
    throw new Error("hybrid foundation v2 page region index differs from source-map entries");
  }

  const charOwners = new Set<string>();
  for (const [index, shard] of artifacts.pdf_selection_map_manifest.page_shards.entries()) {
    const page = artifacts.pdf_selection_map_pages[index];
    if (page.pageIndex !== shard.pageIndex || jsonSha256(page) !== shard.sha256) {
      throw new Error(`pdf_selection_map v2 shard hash mismatch: ${shard.path}`);
    }
    for (const char of page.chars) {
      const entry = entriesByLid.get(char.lid);
      if (!entry || (entry.precision !== "char_exact" && entry.precision !== "partial")) {
        throw new Error(
          `selection shard character is not owned by an exact-capable LID: ${char.lid} (${entry?.precision ?? "missing"})`,
        );
      }
      if (!entry.exact_source_spans.some((span) => char.source_span.start >= span.start && char.source_span.end <= span.end)) {
        throw new Error(`selection shard character escapes exact source spans: ${char.lid}`);
      }
      const binding = `${page.pageIndex}:${char.char_index}`;
      if (charOwners.has(binding)) throw new Error(`duplicate v2 selection character binding: ${binding}`);
      charOwners.add(binding);
    }
  }
  return artifacts;
}
