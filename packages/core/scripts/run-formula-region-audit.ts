import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  alignHybridFoundationV2,
  PDF_FORMULA_REGION_POLICY,
  pdfAlignmentLines,
  type PdfAlignmentLine,
} from "../src/hybrid-alignment-v2";
import {
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import { extractPdfTextGeometry } from "../src/pdf-geometry";
import { reconcilePaperSource } from "../src/source-reconciliation";
import { PdfSourceMapV2Z } from "../src/zod";

const REGION_ONLY_REASON = "unique formula region bounded by exact same-page same-column text anchors";
const ANCHOR_LACK_REASON = "formula text is located but lacks same-page same-column anchors";
const STRUCTURAL_AMBIGUITY_REASONS = new Set([
  "formula region candidates do not form a unique monotonic chain",
  "formula signature crosses page-column lanes",
  "formula region conflicts with adjacent page-column lanes",
]);

function requiredPath(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} requires an explicit path`);
  return path.resolve(value);
}

function optionalPath(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error(`${name} requires a path`);
  return value ? path.resolve(value) : undefined;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function counts(values: string[]): Record<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return Object.fromEntries([...result.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function overlapArea(
  left: [number, number, number, number],
  right: [number, number, number, number],
): number {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  return width * height;
}

function regionLanes(
  regions: Array<{ pageIndex: number; bbox: [number, number, number, number] }>,
  lines: PdfAlignmentLine[],
): number[] {
  const lanes = regions.flatMap((region) => {
    const matches = lines
      .filter((line) => line.pageIndex === region.pageIndex)
      .map((line) => ({ line, overlap: overlapArea(region.bbox, line.bbox) }))
      .filter((candidate) => candidate.overlap > 0)
      .sort((left, right) => (
        right.overlap - left.overlap
        || left.line.bbox[2] - left.line.bbox[0] - (right.line.bbox[2] - right.line.bbox[0])
        || left.line.alignment_line_id.localeCompare(right.line.alignment_line_id)
      ));
    return matches[0] ? [matches[0].line.column] : [];
  });
  return [...new Set(lanes)].sort((left, right) => left - right);
}

export async function runFormulaRegionAuditCli(args: string[]) {
  const sourcePath = requiredPath(args, "--source");
  const pdfPath = requiredPath(args, "--pdf");
  const descriptorPath = requiredPath(args, "--descriptor");
  const migrationMapPath = requiredPath(args, "--migration-map");
  const reviewedMapPath = requiredPath(args, "--reviewed-map");
  const outputPath = optionalPath(args, "--output");
  const source = readFileSync(sourcePath, "utf8");
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  const descriptor = ExternalBenchmarkDescriptorZ.parse(JSON.parse(readFileSync(descriptorPath, "utf8")));
  const migrationMap = HybridFoundationAdaptationMigrationMapZ.parse(
    JSON.parse(readFileSync(migrationMapPath, "utf8")),
  );
  const reviewedMapText = readFileSync(reviewedMapPath, "utf8");
  const reviewedMap = PdfSourceMapV2Z.parse(JSON.parse(reviewedMapText));
  if (sha256(pdfBytes) !== descriptor.input_sha256.pdf) {
    throw new Error("PDF hash does not match adaptation baseline");
  }
  if (reviewedMap.book_id !== descriptor.book_id) {
    throw new Error("reviewed source map book_id does not match adaptation baseline");
  }

  const geometry = await extractPdfTextGeometry(pdfBytes);
  const lines = pdfAlignmentLines(geometry);
  const evidence = reconcilePaperSource({
    book_id: `${descriptor.book_id}-reviewed-v2`,
    markdown_source: source,
    pdf_geometry: geometry,
    input_fingerprint: {
      paper_md_sha256: sha256(source),
      paper_pdf_sha256: sha256(pdfBytes),
      config_hash: "formula-region-audit.v1",
    },
  }).alignment_evidence;
  const alignment = alignHybridFoundationV2(source, geometry, evidence);
  const projectionByLid = new Map(alignment.projections.map((projection) => [projection.lid, projection]));
  const kindByLid = new Map(alignment.units.flatMap((unit) => (
    unit.child_lids.map((child) => [child.lid, child.kind] as const)
  )));
  const reviewedByLid = new Map(reviewedMap.entries.map((entry) => [entry.lid, entry]));
  const baseline = descriptor.expected_adaptation_v1.leaves
    .filter((leaf) => leaf.expected.issue_ids.includes("PDF-A007"));
  const items = baseline.map((leaf) => {
    const migration = migrationMap[leaf.baseline_lid];
    const currentLid = migration?.v2_lid ?? leaf.baseline_lid;
    const projection = projectionByLid.get(currentLid);
    const kind = kindByLid.get(currentLid);
    const reviewed = reviewedByLid.get(leaf.baseline_lid);
    const expectedPages = [...leaf.expected.page_indexes];
    const expectedLanes = reviewed ? regionLanes(reviewed.regions, lines) : [];
    const currentPages = projection
      ? [...new Set(projection.regions.map((region) => region.pageIndex))].sort((left, right) => left - right)
      : [];
    const currentLanes = projection ? regionLanes(projection.regions, lines) : [];
    const category = leaf.expected.projection_reason === REGION_ONLY_REASON ? "reviewed_region" : "anchor_lack";
    const classification = migration?.status === "content_drift" && kind !== "formula"
      ? "reviewed_non_formula"
      : !projection
        ? "missing_successor"
        : projection.precision === "unmapped" && STRUCTURAL_AMBIGUITY_REASONS.has(projection.alignment.reason)
          ? "explicit_structural_ambiguity"
          : projection.precision === "unmapped" && [
              "alignment unit has no exact monotonic candidate",
              "alignment unit has ambiguous forward candidates",
            ].includes(projection.alignment.reason)
            ? "downstream_unit_locator"
            : projection.precision === "unmapped"
                && projection.alignment.reason === "formula has no unique bounded PDF gap"
              ? "downstream_formula_glyph"
              : projection.precision === "partial"
                  && projection.alignment.reason === "complete simple formula display projection with source-markup gaps"
                  && projection.regions.length
                  && currentLanes.length === 1
                ? "existing_display_projection"
          : projection.precision === "region_exact" && projection.regions.length && currentLanes.length === 1
            ? "unique_region"
            : "unclassified";
    const hasComparableFormulaRegion = classification === "unique_region"
      || classification === "existing_display_projection";
    return {
      baseline_lid: leaf.baseline_lid,
      migration_status: migration?.status ?? "direct",
      current_lid: currentLid,
      category,
      classification,
      expected_page_indexes: expectedPages,
      expected_columns: expectedLanes,
      ...(projection ? {
        precision: projection.precision,
        reason: projection.alignment.reason,
        current_page_indexes: currentPages,
        current_columns: currentLanes,
        region_count: projection.regions.length,
        selection_assignment_count: projection.selection_assignments.length,
      } : {}),
      page_matches: hasComparableFormulaRegion ? sameNumbers(expectedPages, currentPages) : null,
      column_matches: hasComparableFormulaRegion ? sameNumbers(expectedLanes, currentLanes) : null,
    };
  });
  const regionItems = items.filter((item) => item.category === "reviewed_region");
  const anchorItems = items.filter((item) => item.category === "anchor_lack");
  const missingSuccessorCount = items.filter((item) => item.classification === "missing_successor").length;
  const wrongPageCount = items.filter((item) => item.page_matches === false).length;
  const wrongColumnCount = items.filter((item) => item.column_matches === false).length;
  const legacyAnchorReasonCount = items.filter((item) => (
    "reason" in item && item.reason === ANCHOR_LACK_REASON
  )).length;
  const geometryRegionSelectionAssignmentCount = items.reduce((sum, item) => (
    sum + (
      item.classification === "unique_region" && typeof item.selection_assignment_count === "number"
        ? item.selection_assignment_count
        : 0
    )
  ), 0);
  const missingReviewedLaneCount = items.filter((item) => !item.expected_columns.length).length;
  const crossLaneRegionCount = items.filter((item) => (
    Array.isArray(item.current_columns) && item.current_columns.length > 1
  )).length;
  const unclassifiedCount = items.filter((item) => ![
    "unique_region",
    "existing_display_projection",
    "explicit_structural_ambiguity",
    "downstream_unit_locator",
    "downstream_formula_glyph",
    "reviewed_non_formula",
  ].includes(item.classification)).length;
  const reviewedRegionWithGeometryCount = regionItems.filter((item) => [
    "unique_region", "existing_display_projection",
  ].includes(item.classification)).length;
  const anchorResolvedCount = anchorItems.filter((item) => [
    "unique_region", "existing_display_projection", "explicit_structural_ambiguity", "reviewed_non_formula",
  ].includes(item.classification)).length;
  const report = {
    version: "formula_region_audit.v1",
    policy_version: PDF_FORMULA_REGION_POLICY.version,
    source_sha256: sha256(source),
    pdf_sha256: sha256(pdfBytes),
    reviewed_map_sha256: sha256(reviewedMapText),
    passed: baseline.length === 106
      && regionItems.length === 79
      && anchorItems.length === 27
      && missingSuccessorCount === 0
      && missingReviewedLaneCount === 0
      && unclassifiedCount === 0
      && wrongPageCount === 0
      && wrongColumnCount === 0
      && legacyAnchorReasonCount === 0
      && geometryRegionSelectionAssignmentCount === 0
      && crossLaneRegionCount === 0,
    summary: {
      baseline_count: baseline.length,
      reviewed_region_count: regionItems.length,
      anchor_lack_count: anchorItems.length,
      missing_successor_count: missingSuccessorCount,
      missing_reviewed_lane_count: missingReviewedLaneCount,
      reviewed_region_with_geometry_count: reviewedRegionWithGeometryCount,
      anchor_resolved_count: anchorResolvedCount,
      unclassified_count: unclassifiedCount,
      wrong_page_count: wrongPageCount,
      wrong_column_count: wrongColumnCount,
      legacy_anchor_lack_reason_count: legacyAnchorReasonCount,
      geometry_region_selection_assignment_count: geometryRegionSelectionAssignmentCount,
      cross_lane_region_count: crossLaneRegionCount,
      classification_counts: counts(items.map((item) => item.classification)),
      precision_counts: counts(items.flatMap((item) => typeof item.precision === "string" ? [item.precision] : [])),
      reason_counts: counts(items.flatMap((item) => typeof item.reason === "string" ? [item.reason] : [])),
    },
    items,
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFormulaRegionAuditCli(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(`${JSON.stringify({
        version: report.version,
        policy_version: report.policy_version,
        source_sha256: report.source_sha256,
        passed: report.passed,
        ...report.summary,
      }, null, 2)}\n`);
      if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
