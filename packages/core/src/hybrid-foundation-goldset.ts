import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildHybridFoundation, assertHybridFoundationHardGates, type HybridFoundationArtifacts } from "./hybrid-foundation";
import {
  buildHybridFoundationV2Candidate,
  type HybridFoundationV2Artifacts,
} from "./hybrid-foundation-v2";
import { auditHybridAlignmentUnits, HYBRID_ALIGNMENT_UNIT_POLICY } from "./hybrid-alignment-v2";
import { markdownToBlocks } from "./md-adapter";
import { extractPdfTextGeometry } from "./pdf-geometry";
import type { PdfProjectionPrecisionV2 } from "./pdf-source-map";
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

const PdfProjectionPrecisionV2Z = z.enum(["char_exact", "region_exact", "partial", "unmapped"]);

export const HybridFoundationAdaptationIssueIdZ = z.enum([
  "PDF-A001",
  "PDF-A002",
  "PDF-A003",
  "PDF-A004",
  "PDF-A005",
  "PDF-A006",
  "PDF-A007",
  "PDF-A008",
  "PDF-A009",
  "PDF-A010",
  "PDF-A011",
]);

export type HybridFoundationAdaptationIssueId = z.infer<typeof HybridFoundationAdaptationIssueIdZ>;

const PrecisionCountsZ = z.object({
  char_exact: z.number().int().nonnegative(),
  region_exact: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  unmapped: z.number().int().nonnegative(),
});

const SelectionCapabilityCountsZ = z.object({
  leaf_count: z.number().int().nonnegative(),
  region_leaf_count: z.number().int().nonnegative(),
  exact_span_leaf_count: z.number().int().nonnegative(),
  selection_leaf_count: z.number().int().nonnegative(),
  selection_character_count: z.number().int().nonnegative(),
});

const SelectionCapabilityMatrixZ = z.object({
  char_exact: SelectionCapabilityCountsZ,
  region_exact: SelectionCapabilityCountsZ,
  partial: SelectionCapabilityCountsZ,
  unmapped: SelectionCapabilityCountsZ,
});

const BindingCountsZ = z.object({
  duplicate_region_binding_count: z.number().int().nonnegative(),
  duplicate_selection_binding_count: z.number().int().nonnegative(),
  raw_duplicate_region_binding_count: z.number().int().nonnegative(),
  raw_duplicate_selection_binding_count: z.number().int().nonnegative(),
  conflicted_lid_count: z.number().int().nonnegative(),
});

const IssueCountsZ = z.object({
  "PDF-A001": z.number().int().nonnegative(),
  "PDF-A002": z.number().int().nonnegative(),
  "PDF-A003": z.number().int().nonnegative(),
  "PDF-A004": z.number().int().nonnegative(),
  "PDF-A005": z.number().int().nonnegative(),
  "PDF-A006": z.number().int().nonnegative(),
  "PDF-A007": z.number().int().nonnegative(),
  "PDF-A008": z.number().int().nonnegative(),
  "PDF-A009": z.number().int().nonnegative(),
  "PDF-A010": z.number().int().nonnegative(),
  "PDF-A011": z.number().int().nonnegative(),
});

export const HybridFoundationAdaptationLeafBaselineZ = z.object({
  baseline_lid: z.string().min(1),
  source_span: SpanZ,
  source_span_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  expected: z.object({
    precision: PdfProjectionPrecisionV2Z,
    projection_reason: z.string().min(1),
    section_lid: z.string().min(1),
    issue_ids: z.array(HybridFoundationAdaptationIssueIdZ),
    page_indexes: z.array(z.number().int().nonnegative()),
  }),
});

export type HybridFoundationAdaptationLeafBaseline = z.infer<typeof HybridFoundationAdaptationLeafBaselineZ>;

export const HybridFoundationAdaptationBaselineZ = z.object({
  version: z.literal("hybrid_foundation_adaptation_baseline.v1"),
  input_fingerprint: z.object({
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    pdf_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    source_alignment_evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }),
  config_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  leaf_count: z.number().int().nonnegative(),
  precision_counts: PrecisionCountsZ,
  projection_reason_counts: z.record(z.number().int().nonnegative()),
  issue_counts: IssueCountsZ,
  section_stats: z.array(z.object({
    section_lid: z.string().min(1),
    leaf_count: z.number().int().nonnegative(),
    precision_counts: PrecisionCountsZ,
    projection_reason_counts: z.record(z.number().int().nonnegative()),
  })),
  binding_counts: BindingCountsZ,
  selection_capability_matrix: SelectionCapabilityMatrixZ,
  leaves: z.array(HybridFoundationAdaptationLeafBaselineZ),
}).superRefine((baseline, context) => {
  const errors = adaptationBaselineConsistencyErrors(baseline);
  for (const error of errors) context.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

export type HybridFoundationAdaptationBaseline = z.infer<typeof HybridFoundationAdaptationBaselineZ>;

export const ExternalBenchmarkDescriptorZ = z.object({
  version: z.literal("hybrid_foundation_external_benchmark.v2"),
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
  expected_adaptation_v1: HybridFoundationAdaptationBaselineZ,
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
    structure_audit_path: z.string().min(1).optional(),
    reviewed_source_plan_path: z.string().min(1).optional(),
    reviewed_source_candidate_audit_path: z.string().min(1).optional(),
    alignment_unit_audit_path: z.string().min(1).optional(),
    child_window_audit_path: z.string().min(1).optional(),
    display_token_audit_path: z.string().min(1).optional(),
    formula_source_ast_audit_path: z.string().min(1).optional(),
    formula_region_audit_path: z.string().min(1).optional(),
    formula_glyph_audit_path: z.string().min(1).optional(),
    image_object_audit_path: z.string().min(1).optional(),
    binding_ownership_audit_path: z.string().min(1).optional(),
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

const ADAPTATION_PRECISIONS: PdfProjectionPrecisionV2[] = [
  "char_exact",
  "region_exact",
  "partial",
  "unmapped",
];

function emptyPrecisionCounts(): Record<PdfProjectionPrecisionV2, number> {
  return { char_exact: 0, region_exact: 0, partial: 0, unmapped: 0 };
}

function emptyIssueCounts(): Record<HybridFoundationAdaptationIssueId, number> {
  return Object.fromEntries(HybridFoundationAdaptationIssueIdZ.options.map((issueId) => [issueId, 0])) as Record<
    HybridFoundationAdaptationIssueId,
    number
  >;
}

function emptySelectionCapabilityMatrix(): z.infer<typeof SelectionCapabilityMatrixZ> {
  const empty = (): z.infer<typeof SelectionCapabilityCountsZ> => ({
    leaf_count: 0,
    region_leaf_count: 0,
    exact_span_leaf_count: 0,
    selection_leaf_count: 0,
    selection_character_count: 0,
  });
  return { char_exact: empty(), region_exact: empty(), partial: empty(), unmapped: empty() };
}

function countStrings(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function compareLids(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pageIndexes(entry: HybridFoundationV2Artifacts["pdf_source_map"]["entries"][number]): number[] {
  return [...new Set(entry.regions.map((region) => region.pageIndex))].sort((left, right) => left - right);
}

function sectionLidForLeaf(artifacts: HybridFoundationV2Artifacts, lid: string): string {
  const containerLids = new Set(artifacts.base.lid_nodes
    .filter((node) => node.children.length > 0)
    .map((node) => node.lid));
  const parts = lid.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join(".");
    if (containerLids.has(candidate)) return candidate;
  }
  return lid;
}

function selectionCapabilityMatrix(
  artifacts: HybridFoundationV2Artifacts,
): z.infer<typeof SelectionCapabilityMatrixZ> {
  const charsByLid = new Map<string, number>();
  for (const page of artifacts.pdf_selection_map_pages) {
    for (const char of page.chars) charsByLid.set(char.lid, (charsByLid.get(char.lid) ?? 0) + 1);
  }
  const matrix = emptySelectionCapabilityMatrix();
  for (const entry of artifacts.pdf_source_map.entries) {
    const counts = matrix[entry.precision];
    counts.leaf_count += 1;
    if (entry.regions.length) counts.region_leaf_count += 1;
    if (entry.exact_source_spans.length) counts.exact_span_leaf_count += 1;
    const charCount = charsByLid.get(entry.lid) ?? 0;
    if (charCount) counts.selection_leaf_count += 1;
    counts.selection_character_count += charCount;
  }
  return matrix;
}

function bindingCounts(artifacts: HybridFoundationV2Artifacts): z.infer<typeof BindingCountsZ> {
  const regionOwners = new Map<string, Set<string>>();
  for (const entry of artifacts.pdf_source_map.entries) {
    for (const region of entry.regions) {
      const key = `${region.pageIndex}:${region.bbox.join(",")}`;
      const owners = regionOwners.get(key) ?? new Set<string>();
      owners.add(entry.lid);
      regionOwners.set(key, owners);
    }
  }
  const selectionBindings = new Set<string>();
  let duplicateSelectionBindingCount = 0;
  for (const page of artifacts.pdf_selection_map_pages) {
    for (const char of page.chars) {
      const key = `${page.pageIndex}:${char.char_index}`;
      if (selectionBindings.has(key)) duplicateSelectionBindingCount += 1;
      selectionBindings.add(key);
    }
  }
  const diagnostics = artifacts.alignment_report.diagnostics as Record<string, unknown>;
  return {
    duplicate_region_binding_count: [...regionOwners.values()].filter((owners) => owners.size > 1).length,
    duplicate_selection_binding_count: duplicateSelectionBindingCount,
    raw_duplicate_region_binding_count: Number(diagnostics.raw_duplicate_pdf_binding_count ?? 0),
    raw_duplicate_selection_binding_count: Number(diagnostics.raw_duplicate_selection_binding_count ?? 0),
    conflicted_lid_count: Number(diagnostics.conflicted_lid_count ?? 0),
  };
}

function sectionStatsFromLeaves(
  leaves: HybridFoundationAdaptationLeafBaseline[],
): HybridFoundationAdaptationBaseline["section_stats"] {
  const sections = new Map<string, HybridFoundationAdaptationBaseline["section_stats"][number]>();
  for (const leaf of leaves) {
    const section = sections.get(leaf.expected.section_lid) ?? {
      section_lid: leaf.expected.section_lid,
      leaf_count: 0,
      precision_counts: emptyPrecisionCounts(),
      projection_reason_counts: {},
    };
    section.leaf_count += 1;
    section.precision_counts[leaf.expected.precision] += 1;
    section.projection_reason_counts[leaf.expected.projection_reason] =
      (section.projection_reason_counts[leaf.expected.projection_reason] ?? 0) + 1;
    sections.set(section.section_lid, section);
  }
  return [...sections.values()]
    .sort((left, right) => compareLids(left.section_lid, right.section_lid))
    .map((section) => ({
      ...section,
      projection_reason_counts: Object.fromEntries(Object.entries(section.projection_reason_counts)
        .sort(([left], [right]) => left.localeCompare(right))),
    }));
}

function aggregateAdaptationLeaves(leaves: HybridFoundationAdaptationLeafBaseline[]) {
  const precisionCounts = emptyPrecisionCounts();
  const issueCounts = emptyIssueCounts();
  for (const leaf of leaves) {
    precisionCounts[leaf.expected.precision] += 1;
    for (const issueId of leaf.expected.issue_ids) issueCounts[issueId] += 1;
  }
  return {
    precision_counts: precisionCounts,
    projection_reason_counts: countStrings(leaves.map((leaf) => leaf.expected.projection_reason)),
    issue_counts: issueCounts,
    section_stats: sectionStatsFromLeaves(leaves),
  };
}

function adaptationBaselineConsistencyErrors(baseline: {
  leaf_count: number;
  precision_counts: z.infer<typeof PrecisionCountsZ>;
  projection_reason_counts: Record<string, number>;
  issue_counts: z.infer<typeof IssueCountsZ>;
  section_stats: HybridFoundationAdaptationBaseline["section_stats"];
  leaves: HybridFoundationAdaptationLeafBaseline[];
}): string[] {
  const errors: string[] = [];
  const lids = new Set<string>();
  for (const leaf of baseline.leaves) {
    if (lids.has(leaf.baseline_lid)) errors.push(`duplicate adaptation baseline LID: ${leaf.baseline_lid}`);
    lids.add(leaf.baseline_lid);
    if (!sameJson(leaf.expected.page_indexes, [...new Set(leaf.expected.page_indexes)].sort((a, b) => a - b))) {
      errors.push(`adaptation baseline page indexes are not sorted and unique: ${leaf.baseline_lid}`);
    }
    const sortedIssues = [...new Set(leaf.expected.issue_ids)]
      .sort((left, right) => HybridFoundationAdaptationIssueIdZ.options.indexOf(left)
        - HybridFoundationAdaptationIssueIdZ.options.indexOf(right));
    if (!sameJson(leaf.expected.issue_ids, sortedIssues)) {
      errors.push(`adaptation baseline issue ids are not sorted and unique: ${leaf.baseline_lid}`);
    }
  }
  const aggregate = aggregateAdaptationLeaves(baseline.leaves);
  if (baseline.leaf_count !== baseline.leaves.length) errors.push("adaptation baseline leaf_count differs from leaves");
  if (!sameJson(baseline.precision_counts, aggregate.precision_counts)) {
    errors.push("adaptation baseline precision_counts differ from leaves");
  }
  if (!sameJson(baseline.projection_reason_counts, aggregate.projection_reason_counts)) {
    errors.push("adaptation baseline projection_reason_counts differ from leaves");
  }
  if (!sameJson(baseline.issue_counts, aggregate.issue_counts)) {
    errors.push("adaptation baseline issue_counts differ from leaves");
  }
  if (!sameJson(baseline.section_stats, aggregate.section_stats)) {
    errors.push("adaptation baseline section_stats differ from leaves");
  }
  return errors;
}

export interface CreateHybridFoundationAdaptationBaselineInput {
  source: string;
  artifacts: HybridFoundationV2Artifacts;
  issue_ids_by_lid?: Partial<Record<string, HybridFoundationAdaptationIssueId[]>>;
}

export function createHybridFoundationAdaptationBaseline(
  input: CreateHybridFoundationAdaptationBaselineInput,
): HybridFoundationAdaptationBaseline {
  const entriesByLid = new Map(input.artifacts.pdf_source_map.entries.map((entry) => [entry.lid, entry]));
  const leaves = input.artifacts.base.lid_nodes
    .filter((node) => node.children.length === 0)
    .map((node): HybridFoundationAdaptationLeafBaseline => {
      const entry = entriesByLid.get(node.lid);
      if (!entry) throw new Error(`adaptation baseline leaf has no source-map entry: ${node.lid}`);
      const issueIds = [...new Set(input.issue_ids_by_lid?.[node.lid] ?? [])]
        .sort((left, right) => HybridFoundationAdaptationIssueIdZ.options.indexOf(left)
          - HybridFoundationAdaptationIssueIdZ.options.indexOf(right));
      return {
        baseline_lid: node.lid,
        source_span: { ...entry.source_span },
        source_span_sha256: sha256(input.source.slice(entry.source_span.start, entry.source_span.end)),
        expected: {
          precision: entry.precision,
          projection_reason: entry.alignment.reason,
          section_lid: sectionLidForLeaf(input.artifacts, node.lid),
          issue_ids: issueIds,
          page_indexes: pageIndexes(entry),
        },
      };
    });
  if (leaves.length !== input.artifacts.pdf_source_map.entries.length) {
    throw new Error("adaptation baseline source map does not cover each leaf exactly once");
  }
  const aggregate = aggregateAdaptationLeaves(leaves);
  return HybridFoundationAdaptationBaselineZ.parse({
    version: "hybrid_foundation_adaptation_baseline.v1",
    input_fingerprint: {
      source_sha256: sha256(input.source),
      pdf_sha256: input.artifacts.alignment_report.input_fingerprint.pdf_sha256,
      ...(input.artifacts.alignment_report.input_fingerprint.source_alignment_evidence_sha256
        ? { source_alignment_evidence_sha256: input.artifacts.alignment_report.input_fingerprint.source_alignment_evidence_sha256 }
        : {}),
    },
    config_hash: input.artifacts.alignment_report.config_hash,
    leaf_count: leaves.length,
    ...aggregate,
    binding_counts: bindingCounts(input.artifacts),
    selection_capability_matrix: selectionCapabilityMatrix(input.artifacts),
    leaves,
  });
}

export const HybridFoundationAdaptationMigrationMapZ = z.record(z.object({
  status: z.enum(["stable", "content_drift", "removed"]),
  v2_lid: z.string().min(1).optional(),
}).superRefine((migration, context) => {
  if (migration.status !== "removed" && !migration.v2_lid) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${migration.status} migration requires v2_lid` });
  }
  if (migration.status === "removed" && migration.v2_lid) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "removed migration forbids v2_lid" });
  }
}));

export type HybridFoundationAdaptationMigrationMap = z.infer<typeof HybridFoundationAdaptationMigrationMapZ>;

interface AdaptationCurrentLeaf {
  lid: string;
  source_span: { start: number; end: number };
  source_span_sha256: string;
  precision: PdfProjectionPrecisionV2;
  projection_reason: string;
  section_lid: string;
  page_indexes: number[];
}

export interface AuditHybridFoundationAdaptationInput {
  source: string;
  artifacts: HybridFoundationV2Artifacts;
  baseline: HybridFoundationAdaptationBaseline;
  lid_migration_map?: HybridFoundationAdaptationMigrationMap;
}

export function auditHybridFoundationAdaptation(input: AuditHybridFoundationAdaptationInput) {
  const baseline = HybridFoundationAdaptationBaselineZ.parse(input.baseline);
  const migrationMap = HybridFoundationAdaptationMigrationMapZ.parse(input.lid_migration_map ?? {});
  const baseLeafLids = new Set(input.artifacts.base.lid_nodes
    .filter((node) => node.children.length === 0)
    .map((node) => node.lid));
  const sourceMapLids = new Set(input.artifacts.pdf_source_map.entries.map((entry) => entry.lid));
  const artifactLeafCoverageErrors = [
    ...[...baseLeafLids].filter((lid) => !sourceMapLids.has(lid)).map((lid) => `missing source-map entry:${lid}`),
    ...[...sourceMapLids].filter((lid) => !baseLeafLids.has(lid)).map((lid) => `source-map entry is not a leaf:${lid}`),
  ].sort();
  const currentLeaves: AdaptationCurrentLeaf[] = input.artifacts.pdf_source_map.entries.map((entry) => ({
    lid: entry.lid,
    source_span: { ...entry.source_span },
    source_span_sha256: sha256(input.source.slice(entry.source_span.start, entry.source_span.end)),
    precision: entry.precision,
    projection_reason: entry.alignment.reason,
    section_lid: sectionLidForLeaf(input.artifacts, entry.lid),
    page_indexes: pageIndexes(entry),
  }));
  const currentByLid = new Map(currentLeaves.map((leaf) => [leaf.lid, leaf]));
  const currentByHash = new Map<string, AdaptationCurrentLeaf[]>();
  for (const leaf of currentLeaves) {
    const candidates = currentByHash.get(leaf.source_span_sha256) ?? [];
    candidates.push(leaf);
    currentByHash.set(leaf.source_span_sha256, candidates);
  }

  const usedCurrentLids = new Set<string>();
  const failures: Array<{ baseline_lid: string; current_lid?: string; codes: string[] }> = [];
  const matches = new Map<string, AdaptationCurrentLeaf>();
  let directLidCount = 0;
  let migrationMapCount = 0;
  let sourceHashMigrationCount = 0;
  let removedByMigrationCount = 0;
  let missingBaselineCount = 0;
  let wrongPageCount = 0;
  let reasonMismatchCount = 0;
  let precisionMismatchCount = 0;
  let sectionMismatchCount = 0;

  for (const expected of baseline.leaves) {
    let actual: AdaptationCurrentLeaf | undefined;
    let matchKind: "direct" | "migration_map" | "source_hash" | "removed" | "missing" = "missing";
    const migration = migrationMap[expected.baseline_lid];
    const direct = currentByLid.get(expected.baseline_lid);
    if (direct && direct.source_span_sha256 === expected.source_span_sha256) {
      actual = direct;
      matchKind = "direct";
    } else {
      if (migration?.status === "removed") {
        matchKind = "removed";
      } else if (migration?.v2_lid) {
        actual = currentByLid.get(migration.v2_lid);
        if (actual) matchKind = "migration_map";
      }
      if (!migration && !actual && matchKind !== "removed") {
        const candidates = (currentByHash.get(expected.source_span_sha256) ?? [])
          .filter((candidate) => !usedCurrentLids.has(candidate.lid));
        if (candidates.length === 1) {
          actual = candidates[0];
          matchKind = actual.lid === expected.baseline_lid ? "direct" : "source_hash";
        }
      }
    }

    if (matchKind === "removed") {
      removedByMigrationCount += 1;
      continue;
    }
    if (!actual || usedCurrentLids.has(actual.lid)) {
      missingBaselineCount += 1;
      failures.push({ baseline_lid: expected.baseline_lid, codes: ["missing_or_ambiguous_successor"] });
      continue;
    }
    usedCurrentLids.add(actual.lid);
    matches.set(expected.baseline_lid, actual);
    if (matchKind === "direct") directLidCount += 1;
    if (matchKind === "migration_map") migrationMapCount += 1;
    if (matchKind === "source_hash") sourceHashMigrationCount += 1;

    const codes: string[] = [];
    if (matchKind === "direct" && !sameJson(actual.source_span, expected.source_span)) codes.push("source_span_changed");
    if (
      matchKind === "migration_map"
      && migration?.status === "stable"
      && actual.source_span_sha256 !== expected.source_span_sha256
    ) codes.push("stable_migration_source_hash_changed");
    if (actual.precision !== expected.expected.precision) {
      codes.push("precision_changed");
      precisionMismatchCount += 1;
    }
    if (actual.projection_reason !== expected.expected.projection_reason) {
      codes.push("projection_reason_changed");
      reasonMismatchCount += 1;
    }
    if (actual.section_lid !== expected.expected.section_lid) {
      codes.push("section_changed");
      sectionMismatchCount += 1;
    }
    if (!sameJson(actual.page_indexes, expected.expected.page_indexes)) {
      codes.push("page_indexes_changed");
      wrongPageCount += 1;
    }
    if (codes.length) failures.push({ baseline_lid: expected.baseline_lid, current_lid: actual.lid, codes });
  }

  const unexpectedCurrentLids = currentLeaves
    .filter((leaf) => !usedCurrentLids.has(leaf.lid))
    .map((leaf) => leaf.lid)
    .sort(compareLids);
  const actualProjectionReasonCounts = countStrings(currentLeaves.map((leaf) => leaf.projection_reason));
  const actualPrecisionCounts = emptyPrecisionCounts();
  for (const leaf of currentLeaves) actualPrecisionCounts[leaf.precision] += 1;
  const actualSectionStats = sectionStatsFromLeaves(currentLeaves.map((leaf) => ({
    baseline_lid: leaf.lid,
    source_span: leaf.source_span,
    source_span_sha256: leaf.source_span_sha256,
    expected: {
      precision: leaf.precision,
      projection_reason: leaf.projection_reason,
      section_lid: leaf.section_lid,
      issue_ids: [],
      page_indexes: leaf.page_indexes,
    },
  })));
  const mismatchedSectionLids = [...new Set([
    ...baseline.section_stats.map((section) => section.section_lid),
    ...actualSectionStats.map((section) => section.section_lid),
  ])].filter((sectionLid) => !sameJson(
    baseline.section_stats.find((section) => section.section_lid === sectionLid),
    actualSectionStats.find((section) => section.section_lid === sectionLid),
  )).sort(compareLids);

  const issueClosure = Object.fromEntries(HybridFoundationAdaptationIssueIdZ.options.map((issueId) => {
    const expectedLeaves = baseline.leaves.filter((leaf) => leaf.expected.issue_ids.includes(issueId));
    const actualLeaves = expectedLeaves.map((leaf) => matches.get(leaf.baseline_lid)).filter(Boolean) as AdaptationCurrentLeaf[];
    return [issueId, {
      baseline_leaf_count: expectedLeaves.length,
      matched_leaf_count: actualLeaves.length,
      precision_counts: ADAPTATION_PRECISIONS.reduce((counts, precision) => ({
        ...counts,
        [precision]: actualLeaves.filter((leaf) => leaf.precision === precision).length,
      }), {} as Record<PdfProjectionPrecisionV2, number>),
      projection_reason_counts: countStrings(actualLeaves.map((leaf) => leaf.projection_reason)),
    }];
  })) as Record<HybridFoundationAdaptationIssueId, {
    baseline_leaf_count: number;
    matched_leaf_count: number;
    precision_counts: Record<PdfProjectionPrecisionV2, number>;
    projection_reason_counts: Record<string, number>;
  }>;

  const actualBindings = bindingCounts(input.artifacts);
  const actualCapabilities = selectionCapabilityMatrix(input.artifacts);
  const inputFingerprintMatches = sameJson(baseline.input_fingerprint, {
    source_sha256: sha256(input.source),
    pdf_sha256: input.artifacts.alignment_report.input_fingerprint.pdf_sha256,
    ...(input.artifacts.alignment_report.input_fingerprint.source_alignment_evidence_sha256
      ? { source_alignment_evidence_sha256: input.artifacts.alignment_report.input_fingerprint.source_alignment_evidence_sha256 }
      : {}),
  });
  const configHashMatches = baseline.config_hash === input.artifacts.alignment_report.config_hash;
  const reasonCountsMatch = sameJson(baseline.projection_reason_counts, actualProjectionReasonCounts);
  const precisionCountsMatch = sameJson(baseline.precision_counts, actualPrecisionCounts);
  const bindingCountsMatch = sameJson(baseline.binding_counts, actualBindings);
  const selectionCapabilitiesMatch = sameJson(baseline.selection_capability_matrix, actualCapabilities);
  const alignmentUnitAudit = auditHybridAlignmentUnits(input.source);
  const alignmentUnitCoverageErrorCount = alignmentUnitAudit.coverage.missing_lids.length
    + alignmentUnitAudit.coverage.duplicate_lids.length
    + alignmentUnitAudit.coverage.unexpected_lids.length;
  const passed = inputFingerprintMatches
    && configHashMatches
    && artifactLeafCoverageErrors.length === 0
    && missingBaselineCount === 0
    && unexpectedCurrentLids.length === 0
    && failures.length === 0
    && reasonCountsMatch
    && precisionCountsMatch
    && mismatchedSectionLids.length === 0
    && bindingCountsMatch
    && selectionCapabilitiesMatch
    && alignmentUnitAudit.passed;

  return {
    version: "hybrid_foundation_adaptation_audit.v1" as const,
    benchmark_id: "external-formula-dense-transformer",
    book_id: input.artifacts.base.book_id,
    passed,
    input_closure: {
      input_fingerprint_matches: inputFingerprintMatches,
      config_hash_matches: configHashMatches,
    },
    coverage: {
      baseline_leaf_count: baseline.leaf_count,
      current_leaf_count: currentLeaves.length,
      matched_baseline_count: matches.size + removedByMigrationCount,
      direct_lid_count: directLidCount,
      migration_map_count: migrationMapCount,
      source_hash_migration_count: sourceHashMigrationCount,
      removed_by_migration_count: removedByMigrationCount,
      missing_baseline_count: missingBaselineCount,
      unexpected_current_count: unexpectedCurrentLids.length,
      artifact_leaf_coverage_error_count: artifactLeafCoverageErrors.length,
    },
    reason_closure: {
      expected: baseline.projection_reason_counts,
      actual: actualProjectionReasonCounts,
      counts_match: reasonCountsMatch,
      mismatched_leaf_count: reasonMismatchCount,
      unexpected_reasons: Object.keys(actualProjectionReasonCounts)
        .filter((reason) => baseline.projection_reason_counts[reason] === undefined)
        .sort(),
    },
    precision_closure: {
      expected: baseline.precision_counts,
      actual: actualPrecisionCounts,
      counts_match: precisionCountsMatch,
      mismatched_leaf_count: precisionMismatchCount,
    },
    section_closure: {
      expected_section_count: baseline.section_stats.length,
      actual_section_count: actualSectionStats.length,
      mismatched_leaf_count: sectionMismatchCount,
      mismatched_section_lids: mismatchedSectionLids,
    },
    issue_closure: issueClosure,
    wrong_page_count: wrongPageCount,
    binding_closure: {
      expected: baseline.binding_counts,
      actual: actualBindings,
      counts_match: bindingCountsMatch,
    },
    selection_capability_closure: {
      expected: baseline.selection_capability_matrix,
      actual: actualCapabilities,
      counts_match: selectionCapabilitiesMatch,
    },
    alignment_unit_closure: {
      policy_version: HYBRID_ALIGNMENT_UNIT_POLICY.version,
      unit_count: alignmentUnitAudit.summary.unit_count,
      child_count: alignmentUnitAudit.summary.child_count,
      oversize_singleton_count: alignmentUnitAudit.summary.oversize_singleton_count,
      oversized_multi_child_unit_count: alignmentUnitAudit.summary.oversized_multi_child_unit_count,
      boundary_violation_count: alignmentUnitAudit.summary.boundary_violation_count,
      coverage_error_count: alignmentUnitCoverageErrorCount,
      passed: alignmentUnitAudit.passed,
    },
    artifact_leaf_coverage_errors: artifactLeafCoverageErrors,
    unexpected_current_lids: unexpectedCurrentLids,
    failures: failures.sort((left, right) => compareLids(left.baseline_lid, right.baseline_lid)),
  };
}

export type HybridFoundationAdaptationAuditReport = ReturnType<typeof auditHybridFoundationAdaptation>;

export function serializeHybridFoundationAdaptationAudit(
  report: HybridFoundationAdaptationAuditReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
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
