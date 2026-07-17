import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildHybridFoundation, assertHybridFoundationHardGates, type HybridFoundationArtifacts } from "./hybrid-foundation";
import {
  buildHybridFoundationV2Candidate,
  type HybridFoundationV2Artifacts,
} from "./hybrid-foundation-v2";
import { markdownToBlocks } from "./md-adapter";
import { extractPdfTextGeometry } from "./pdf-geometry";
import { reconcilePaperSource } from "./source-reconciliation";

const SpanZ = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).refine((span) => span.end >= span.start, "span end must not precede start");

const BboxZ = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const GoldAnnotationZ = z.object({
  annotation_id: z.string().min(1),
  source_span: SpanZ,
  source_text: z.string(),
  pdf_text: z.string(),
  expected_page_index: z.number().int().nonnegative(),
  expected_line_start_index: z.number().int().nonnegative(),
  expected_line_end_index: z.number().int().nonnegative(),
  expected_bbox: BboxZ,
  expected_precision: z.enum(["char_exact", "region_exact", "partial", "unmapped"]),
});

export type GoldAnnotation = z.infer<typeof GoldAnnotationZ>;

export const GoldsetFixtureExpectedZ = z.object({
  version: z.literal("hybrid_foundation_expected.v1"),
  fixture_id: z.string().min(1),
  input_sha256: z.object({ source: z.string().length(64), pdf: z.string().length(64) }),
  annotations: z.array(GoldAnnotationZ).min(1),
  expected_v1: z.object({
    hard_gate_error: z.string().nullable(),
    leaf_count: z.number().int().nonnegative(),
    mapped_leaf_count: z.number().int().nonnegative(),
    mapped_text_ratio: z.number().min(0).max(1),
    mapped_heading_ratio: z.number().min(0).max(1),
    unmapped_asset_count: z.number().int().nonnegative(),
    annotated_wrong_page_count: z.number().int().nonnegative(),
    duplicate_pdf_binding_count: z.number().int().nonnegative(),
  }),
});

export type GoldsetFixtureExpected = z.infer<typeof GoldsetFixtureExpectedZ>;

export const ExternalBenchmarkDescriptorZ = z.object({
  version: z.literal("hybrid_foundation_external_benchmark.v1"),
  benchmark_id: z.string().min(1),
  book_id: z.string().min(1),
  input_sha256: z.object({ source: z.string().length(64), pdf: z.string().length(64) }),
  annotations: z.array(GoldAnnotationZ).min(1),
  expected_v1: z.object({
    hard_gate_error: z.string().nullable(),
    leaf_count: z.number().int().nonnegative(),
    mapped_leaf_count: z.number().int().nonnegative(),
    alignable_text_count: z.number().int().nonnegative(),
    mapped_text_count: z.number().int().nonnegative(),
    mapped_text_ratio: z.number().min(0).max(1),
    heading_count: z.number().int().nonnegative(),
    mapped_heading_count: z.number().int().nonnegative(),
    mapped_heading_ratio: z.number().min(0).max(1),
  }),
});

export type ExternalBenchmarkDescriptor = z.infer<typeof ExternalBenchmarkDescriptorZ>;

export const GoldsetManifestZ = z.object({
  version: z.literal("hybrid_foundation_goldset.v1"),
  policy_version: z.literal("hybrid_quality_policy.v1"),
  fixtures: z.array(z.object({
    fixture_id: z.string().min(1),
    directory: z.string().min(1),
    source_path: z.string().min(1),
    pdf_path: z.string().min(1),
    expected_path: z.string().min(1),
    license: z.object({ spdx: z.literal("CC0-1.0"), copyright: z.string().min(1) }),
  })).min(1),
  external_benchmarks: z.array(z.object({
    benchmark_id: z.string().min(1),
    descriptor_path: z.string().min(1),
    requires_explicit_book_path: z.literal(true),
  })),
});

export type GoldsetManifest = z.infer<typeof GoldsetManifestZ>;

export interface HybridFoundationGoldsetReport {
  version: "hybrid_foundation_goldset_report.v1";
  benchmark_id: string;
  mode: "licensed_fixture" | "external";
  input_sha256: { source: string; pdf: string };
  v1: {
    hard_gate_error: string | null;
    integrity_gate_matrix: Record<string, boolean | number>;
    leaf_count: number;
    mapped_leaf_count: number;
    alignable_text_count: number;
    mapped_text_count: number;
    mapped_text_ratio: number;
    heading_count: number;
    mapped_heading_count: number;
    mapped_heading_ratio: number;
    unmapped_asset_count: number;
    annotated_wrong_page_count: number;
    annotated_missing_count: number;
    duplicate_pdf_binding_count: number;
    quality: {
      policy_version: "hybrid_quality_policy.v1";
      unit_location_ratio: number;
      exact_text_span_ratio: number;
      exact_formula_ratio: number;
      heading_location_ratio: number;
    };
    source_span_coverage_ratio: number;
    source_span_coverage_delta: number;
    artifact_hashes: Record<string, string>;
    artifact_hash_differences: string[];
    repeatable: boolean;
    annotations: Array<{
      annotation_id: string;
      mapped: boolean;
      status: string;
      actual_page_index?: number;
      actual_line_indexes: number[];
    }>;
  };
  v2: {
    integrity_gate_matrix: ReturnType<typeof buildHybridFoundationV2Candidate>["alignment_report"]["integrity"];
    quality: ReturnType<typeof buildHybridFoundationV2Candidate>["alignment_report"]["quality"];
    source_span_coverage_ratio: number;
    source_span_coverage_delta: number;
    artifact_hashes: Record<string, string>;
    artifact_hash_differences: string[];
    repeatable: boolean;
  };
}

interface BenchmarkInput {
  benchmark_id: string;
  mode: HybridFoundationGoldsetReport["mode"];
  book_id: string;
  source: string;
  pdf_bytes: Uint8Array;
  original_pdf_path: string;
  annotations: GoldAnnotation[];
  derive_source_alignment_evidence?: boolean;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function spanKey(span: { start: number; end: number }): string {
  return `${span.start}:${span.end}`;
}

function mappedStatus(status: string): boolean {
  return status !== "unmapped" && status !== "excluded";
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 1;
}

function artifactHashes(artifacts: HybridFoundationArtifacts): Record<string, string> {
  return {
    "base.json": sha256(JSON.stringify(artifacts.base)),
    "source_manifest.json": sha256(JSON.stringify(artifacts.source_manifest)),
    "pdf_source_map.json": sha256(JSON.stringify(artifacts.pdf_source_map)),
    "pdf_selection_map/manifest.json": sha256(JSON.stringify(artifacts.pdf_selection_map_manifest)),
    "pdf_selection_map/pages": sha256(JSON.stringify(artifacts.pdf_selection_map_pages)),
    "alignment_report.json": sha256(JSON.stringify(artifacts.alignment_report)),
  };
}

function artifactHashesV2(artifacts: HybridFoundationV2Artifacts): Record<string, string> {
  return {
    "base.json": sha256(JSON.stringify(artifacts.base)),
    "source_manifest.json": sha256(JSON.stringify(artifacts.source_manifest)),
    "pdf_source_map.json": sha256(JSON.stringify(artifacts.pdf_source_map)),
    "pdf_selection_map/manifest.json": sha256(JSON.stringify(artifacts.pdf_selection_map_manifest)),
    "pdf_selection_map/pages": sha256(JSON.stringify(artifacts.pdf_selection_map_pages)),
    "alignment_report.json": sha256(JSON.stringify(artifacts.alignment_report)),
  };
}

function hardGateError(artifacts: HybridFoundationArtifacts): string | null {
  try {
    assertHybridFoundationHardGates(artifacts);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function duplicatePdfBindingCount(artifacts: HybridFoundationArtifacts): number {
  const lidsByRegion = new Map<string, Set<string>>();
  for (const entry of artifacts.pdf_source_map.entries) {
    for (const region of entry.regions) {
      const key = `${region.pageIndex}:${region.bbox.join(",")}`;
      const lids = lidsByRegion.get(key) ?? new Set<string>();
      lids.add(entry.lid);
      lidsByRegion.set(key, lids);
    }
  }
  return [...lidsByRegion.values()].filter((lids) => lids.size > 1).length;
}

function sourceBlockUnits(source: string) {
  const blocks = markdownToBlocks(source).filter((block) => block.text.trim().length > 0);
  const units: Array<typeof blocks> = [];
  for (const block of blocks) {
    const current = units.at(-1);
    const previous = current?.at(-1);
    const gap = previous ? source.slice(previous.span.end, block.span.start) : "";
    const previousHard = previous?.kind === "heading" || Boolean(previous?.assetKind && previous.assetKind !== "formula");
    const blockHard = block.kind === "heading" || Boolean(block.assetKind && block.assetKind !== "formula");
    const joinsFormulaContext = Boolean(
      current
      && previous
      && !previousHard
      && !blockHard
      && !/\n\s*\n/u.test(gap)
      && (previous.assetKind === "formula" || block.assetKind === "formula" || current.some((item) => item.assetKind === "formula")),
    );
    if (joinsFormulaContext) current!.push(block);
    else units.push([block]);
  }
  return { blocks, units };
}

function coveredSourceLength(
  spans: Array<{ start: number; end: number }>,
  coverage: Uint8Array,
): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const span of spans) {
    total += span.end - span.start;
    for (let index = span.start; index < span.end; index += 1) covered += coverage[index] ? 1 : 0;
  }
  return { covered, total };
}

function lineIndexesForEntry(
  artifacts: HybridFoundationArtifacts,
  geometry: Awaited<ReturnType<typeof extractPdfTextGeometry>>,
  span: { start: number; end: number },
): number[] {
  const entry = artifacts.pdf_source_map.entries.find((candidate) => spanKey(candidate.source_span) === spanKey(span));
  if (!entry) return [];
  return [...new Set(entry.regions.flatMap((region) => {
    const page = geometry.pages.find((candidate) => candidate.pageIndex === region.pageIndex);
    return page?.lines
      .filter((line) => line.bbox.every((value, index) => value === region.bbox[index]))
      .map((line) => line.lineIndex) ?? [];
  }))].sort((left, right) => left - right);
}

function validateGoldAnnotations(
  source: string,
  geometry: Awaited<ReturnType<typeof extractPdfTextGeometry>>,
  annotations: GoldAnnotation[],
): void {
  const seen = new Set<string>();
  for (const annotation of annotations) {
    if (seen.has(annotation.annotation_id)) throw new Error(`duplicate gold annotation id: ${annotation.annotation_id}`);
    seen.add(annotation.annotation_id);
    if (source.slice(annotation.source_span.start, annotation.source_span.end) !== annotation.source_text) {
      throw new Error(`gold annotation source span is stale: ${annotation.annotation_id}`);
    }
    const page = geometry.pages.find((candidate) => candidate.pageIndex === annotation.expected_page_index);
    if (!page) throw new Error(`gold annotation references a missing page: ${annotation.annotation_id}`);
    if (
      annotation.expected_bbox[0] < 0
      || annotation.expected_bbox[1] < 0
      || annotation.expected_bbox[2] > page.width
      || annotation.expected_bbox[3] > page.height
      || annotation.expected_bbox[2] <= annotation.expected_bbox[0]
      || annotation.expected_bbox[3] <= annotation.expected_bbox[1]
    ) {
      throw new Error(`gold annotation bbox is invalid: ${annotation.annotation_id}`);
    }
    const lines = page.lines.filter((line) => (
      line.lineIndex >= annotation.expected_line_start_index
      && line.lineIndex <= annotation.expected_line_end_index
    ));
    if (!lines.length || !lines.map((line) => line.text).join(" ").includes(annotation.pdf_text)) {
      throw new Error(`gold annotation PDF line evidence is stale: ${annotation.annotation_id}`);
    }
  }
}

async function runBenchmark(input: BenchmarkInput): Promise<HybridFoundationGoldsetReport> {
  const geometry = await extractPdfTextGeometry(input.pdf_bytes);
  validateGoldAnnotations(input.source, geometry, input.annotations);
  const build = () => buildHybridFoundation({
    book_id: input.book_id,
    source_txt: input.source,
    original_pdf_path: input.original_pdf_path,
    original_pdf_sha256: sha256(input.pdf_bytes),
    pdf_geometry: geometry,
  });
  const first = build();
  const second = build();
  const firstHashes = artifactHashes(first);
  const secondHashes = artifactHashes(second);
  const hashDifferences = Object.keys(firstHashes).filter((key) => firstHashes[key] !== secondHashes[key]);
  const benchmarkEvidence = input.derive_source_alignment_evidence
    ? reconcilePaperSource({
        book_id: input.book_id,
        markdown_source: input.source,
        pdf_geometry: geometry,
        input_fingerprint: {
          paper_md_sha256: sha256(input.source),
          paper_pdf_sha256: sha256(input.pdf_bytes),
          config_hash: "hybrid-foundation-goldset.v1",
        },
      }).alignment_evidence
    : undefined;
  const buildV2 = () => buildHybridFoundationV2Candidate({
    book_id: input.book_id,
    source_txt: input.source,
    original_pdf_path: input.original_pdf_path,
    original_pdf_sha256: sha256(input.pdf_bytes),
    pdf_geometry: geometry,
    source_alignment_evidence: benchmarkEvidence,
  });
  const firstV2 = buildV2();
  const secondV2 = buildV2();
  const firstV2Hashes = artifactHashesV2(firstV2);
  const secondV2Hashes = artifactHashesV2(secondV2);
  const v2HashDifferences = Object.keys(firstV2Hashes).filter((key) => firstV2Hashes[key] !== secondV2Hashes[key]);
  const { blocks, units } = sourceBlockUnits(input.source);
  const entriesBySpan = new Map(first.pdf_source_map.entries.map((entry) => [spanKey(entry.source_span), entry]));
  const bodyTextBlocks = blocks.filter((block) => block.kind !== "heading" && !block.assetKind);
  const formulaBlocks = blocks.filter((block) => block.assetKind === "formula");
  const headingBlocks = blocks.filter((block) => block.kind === "heading");
  const selectionCoverage = new Uint8Array(input.source.length);
  for (const page of first.pdf_selection_map_pages) {
    for (const char of page.chars) {
      if (!char.lid || char.source_span.end <= char.source_span.start) continue;
      selectionCoverage.fill(1, char.source_span.start, char.source_span.end);
    }
  }
  const exactText = coveredSourceLength(bodyTextBlocks.map((block) => block.span), selectionCoverage);
  const v1ExactTextSpanRatio = ratio(exactText.covered, exactText.total);
  const locatedUnits = units.filter((unit) => unit
    .filter((block) => !block.assetKind)
    .every((block) => mappedStatus(entriesBySpan.get(spanKey(block.span))?.status ?? "unmapped"))).length;
  const mappedFormulas = formulaBlocks.filter((block) => mappedStatus(entriesBySpan.get(spanKey(block.span))?.status ?? "unmapped")).length;
  const mappedHeadings = headingBlocks.filter((block) => mappedStatus(entriesBySpan.get(spanKey(block.span))?.status ?? "unmapped")).length;
  const annotations = input.annotations.map((annotation) => {
    const entry = entriesBySpan.get(spanKey(annotation.source_span));
    return {
      annotation_id: annotation.annotation_id,
      mapped: Boolean(entry && mappedStatus(entry.status)),
      status: entry?.status ?? "missing_entry",
      ...(entry?.primary_region ? { actual_page_index: entry.primary_region.pageIndex } : {}),
      actual_line_indexes: lineIndexesForEntry(first, geometry, annotation.source_span),
    };
  });
  const diagnostics = first.alignment_report.diagnostics as Record<string, number>;
  const alignableTextCount = diagnostics.alignable_text_count ?? 0;
  const mappedTextCount = diagnostics.mapped_text_count ?? 0;
  const headingCount = diagnostics.heading_count ?? 0;
  const report: HybridFoundationGoldsetReport = {
    version: "hybrid_foundation_goldset_report.v1",
    benchmark_id: input.benchmark_id,
    mode: input.mode,
    input_sha256: { source: sha256(input.source), pdf: sha256(input.pdf_bytes) },
    v1: {
      hard_gate_error: hardGateError(first),
      integrity_gate_matrix: first.alignment_report.hard_gates,
      leaf_count: Number(first.alignment_report.hard_gates.leaf_count ?? 0),
      mapped_leaf_count: Number(first.alignment_report.hard_gates.mapped_leaf_count ?? 0),
      alignable_text_count: alignableTextCount,
      mapped_text_count: mappedTextCount,
      mapped_text_ratio: ratio(mappedTextCount, alignableTextCount),
      heading_count: headingCount,
      mapped_heading_count: diagnostics.mapped_heading_count ?? 0,
      mapped_heading_ratio: ratio(diagnostics.mapped_heading_count ?? 0, headingCount),
      unmapped_asset_count: formulaBlocks.filter((block) => !mappedStatus(entriesBySpan.get(spanKey(block.span))?.status ?? "unmapped")).length,
      annotated_wrong_page_count: annotations.filter((annotation, index) => (
        annotation.actual_page_index !== undefined
        && annotation.actual_page_index !== input.annotations[index].expected_page_index
      )).length,
      annotated_missing_count: annotations.filter((annotation) => !annotation.mapped).length,
      duplicate_pdf_binding_count: duplicatePdfBindingCount(first),
      quality: {
        policy_version: "hybrid_quality_policy.v1",
        unit_location_ratio: ratio(locatedUnits, units.length),
        exact_text_span_ratio: v1ExactTextSpanRatio,
        exact_formula_ratio: ratio(mappedFormulas, formulaBlocks.length),
        heading_location_ratio: ratio(mappedHeadings, headingBlocks.length),
      },
      source_span_coverage_ratio: v1ExactTextSpanRatio,
      source_span_coverage_delta: 0,
      artifact_hashes: firstHashes,
      artifact_hash_differences: hashDifferences,
      repeatable: hashDifferences.length === 0,
      annotations,
    },
    v2: {
      integrity_gate_matrix: firstV2.alignment_report.integrity,
      quality: firstV2.alignment_report.quality,
      source_span_coverage_ratio: firstV2.alignment_report.quality.exact_text_span_ratio,
      source_span_coverage_delta: firstV2.alignment_report.quality.exact_text_span_ratio - v1ExactTextSpanRatio,
      artifact_hashes: firstV2Hashes,
      artifact_hash_differences: v2HashDifferences,
      repeatable: v2HashDifferences.length === 0,
    },
  };
  return report;
}

export function loadGoldsetManifest(goldsetRoot: string): GoldsetManifest {
  return GoldsetManifestZ.parse(readJson(path.join(goldsetRoot, "manifest.json")));
}

export async function runLicensedGoldsetFixture(
  goldsetRoot: string,
  fixtureId: string,
): Promise<{ expected: GoldsetFixtureExpected; report: HybridFoundationGoldsetReport }> {
  const manifest = loadGoldsetManifest(goldsetRoot);
  const fixture = manifest.fixtures.find((candidate) => candidate.fixture_id === fixtureId);
  if (!fixture) throw new Error(`unknown hybrid foundation goldset fixture: ${fixtureId}`);
  const fixtureDir = path.resolve(goldsetRoot, fixture.directory);
  const source = readFileSync(path.join(fixtureDir, fixture.source_path), "utf8");
  const pdfBytes = new Uint8Array(readFileSync(path.join(fixtureDir, fixture.pdf_path)));
  const expected = GoldsetFixtureExpectedZ.parse(readJson(path.join(fixtureDir, fixture.expected_path)));
  if (expected.fixture_id !== fixture.fixture_id) throw new Error(`fixture id mismatch for ${fixtureId}`);
  if (sha256(source) !== expected.input_sha256.source) throw new Error(`source hash mismatch for ${fixtureId}`);
  if (sha256(pdfBytes) !== expected.input_sha256.pdf) throw new Error(`PDF hash mismatch for ${fixtureId}`);
  const report = await runBenchmark({
    benchmark_id: fixture.fixture_id,
    mode: "licensed_fixture",
    book_id: fixture.fixture_id,
    source,
    pdf_bytes: pdfBytes,
    original_pdf_path: fixture.pdf_path,
    annotations: expected.annotations,
  });
  return { expected, report };
}

const WorkbenchInputManifestZ = z.object({
  book_id: z.string().min(1),
  inputs: z.object({ paper_pdf: z.object({ path: z.string().min(1) }) }),
});

export async function runExternalGoldsetBenchmark(
  goldsetRoot: string,
  benchmarkId: string,
  bookDir: string,
): Promise<{ expected: ExternalBenchmarkDescriptor; report: HybridFoundationGoldsetReport }> {
  const manifest = loadGoldsetManifest(goldsetRoot);
  const benchmark = manifest.external_benchmarks.find((candidate) => candidate.benchmark_id === benchmarkId);
  if (!benchmark) throw new Error(`unknown external hybrid foundation benchmark: ${benchmarkId}`);
  const expected = ExternalBenchmarkDescriptorZ.parse(readJson(path.resolve(goldsetRoot, benchmark.descriptor_path)));
  const inputManifest = WorkbenchInputManifestZ.parse(readJson(path.join(bookDir, ".build", "input", "manifest.json")));
  if (inputManifest.book_id !== expected.book_id) throw new Error(`external benchmark book_id mismatch: ${inputManifest.book_id}`);
  const sourcePath = path.join(bookDir, ".build", "source-reconciliation", "source.txt");
  const pdfPath = path.resolve(bookDir, inputManifest.inputs.paper_pdf.path);
  const source = readFileSync(sourcePath, "utf8");
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  if (sha256(source) !== expected.input_sha256.source) throw new Error("external benchmark source hash mismatch");
  if (sha256(pdfBytes) !== expected.input_sha256.pdf) throw new Error("external benchmark PDF hash mismatch");
  const report = await runBenchmark({
    benchmark_id: expected.benchmark_id,
    mode: "external",
    book_id: expected.book_id,
    source,
    pdf_bytes: pdfBytes,
    original_pdf_path: inputManifest.inputs.paper_pdf.path,
    annotations: expected.annotations,
    derive_source_alignment_evidence: true,
  });
  return { expected, report };
}
