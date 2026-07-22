import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  alignHybridFoundationV2,
  PDF_FORMULA_GLYPH_POLICY,
  pdfAlignmentLines,
  type HybridChildProjection,
  type PdfAlignmentLine,
} from "../src/hybrid-alignment-v2";
import {
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import { extractPdfTextGeometry } from "../src/pdf-geometry";
import { reconcilePaperSource } from "../src/source-reconciliation";
import { PdfSourceMapV2Z } from "../src/zod";

const PROJECTED_REASONS = new Set([
  "complete structural formula glyph projection",
  "complete simple formula display projection with source-markup gaps",
  "complete formula glyph projection in unique formula region",
]);
const UNIT_LOCATOR_REASONS = new Set([
  "alignment unit has no exact monotonic candidate",
  "alignment unit has ambiguous forward candidates",
]);
const BINDING_REASONS = new Set([
  "formula region candidates do not form a unique monotonic chain",
]);
const LANE_REASONS = new Set([
  "formula region conflicts with adjacent page-column lanes",
  "formula signature crosses page-column lanes",
]);
const GLYPH_MISMATCH_REASONS = new Set([
  "formula glyph projection has no complete structural match",
  "formula glyph geometry conflicts with source AST",
]);
const UNSUPPORTED_REASONS = new Set([
  "formula source AST structure is not glyph-projectable",
  "unique formula object region for unsupported source AST",
]);
const LEGACY_FORMULA_REASONS = new Set([
  "formula has no unique bounded PDF gap",
  "formula projection is ambiguous inside the located unit",
  "formula text is located but lacks same-page same-column anchors",
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

function pageIndexes(regions: Array<{ pageIndex: number }>): number[] {
  return [...new Set(regions.map((region) => region.pageIndex))].sort((left, right) => left - right);
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function classification(projection: HybridChildProjection): string {
  if (PROJECTED_REASONS.has(projection.alignment.reason)
    && projection.selection_assignments.length > 0
    && projection.formula_display_text) return "glyph_projected";
  if (UNIT_LOCATOR_REASONS.has(projection.alignment.reason)) return "downstream_unit_locator";
  if (BINDING_REASONS.has(projection.alignment.reason)) return "downstream_binding_conflict";
  if (LANE_REASONS.has(projection.alignment.reason)) return "explicit_lane_ambiguity";
  if (GLYPH_MISMATCH_REASONS.has(projection.alignment.reason)) return "explicit_glyph_mismatch";
  if (UNSUPPORTED_REASONS.has(projection.alignment.reason)) return "unsupported_source_structure";
  return "unclassified";
}

function spanContained(
  span: { start: number; end: number },
  containers: Array<{ start: number; end: number }>,
): boolean {
  return containers.some((container) => span.start >= container.start && span.end <= container.end);
}

export async function runFormulaGlyphAuditCli(args: string[]) {
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
      config_hash: "formula-glyph-audit.v1",
    },
  }).alignment_evidence;
  const alignment = alignHybridFoundationV2(source, geometry, evidence);
  const projectionByLid = new Map(alignment.projections.map((projection) => [projection.lid, projection]));
  const kindByLid = new Map(alignment.units.flatMap((unit) => (
    unit.child_lids.map((child) => [child.lid, child.kind] as const)
  )));
  const childByLid = new Map(alignment.units.flatMap((unit) => (
    unit.child_lids.map((child) => [child.lid, child] as const)
  )));
  const baselineLidsByCurrent = new Map<string, string[]>();
  for (const [baselineLid, migration] of Object.entries(migrationMap)) {
    if (!migration.v2_lid) continue;
    baselineLidsByCurrent.set(migration.v2_lid, [
      ...(baselineLidsByCurrent.get(migration.v2_lid) ?? []),
      baselineLid,
    ]);
  }
  const reviewedByLid = new Map(reviewedMap.entries.map((entry) => [entry.lid, entry]));
  const assignmentOwners = new Map<string, string[]>();

  const formulaItems = [...childByLid.values()].filter((child) => child.kind === "formula").map((child) => {
    const projection = projectionByLid.get(child.lid)!;
    const itemClassification = classification(projection);
    const baselineLids = baselineLidsByCurrent.get(child.lid) ?? [child.lid];
    const reviewed = baselineLids.map((lid) => reviewedByLid.get(lid)).find(Boolean);
    const currentPages = pageIndexes(projection.regions);
    const currentColumns = regionLanes(projection.regions, lines);
    const expectedPages = reviewed ? pageIndexes(reviewed.regions) : [];
    const expectedColumns = reviewed ? regionLanes(reviewed.regions, lines) : [];
    const comparable = itemClassification === "glyph_projected" && Boolean(reviewed?.regions.length);
    const assignmentSpansValid = projection.selection_assignments.every((assignment) => (
      assignment.source_span.start >= child.source_span.start
      && assignment.source_span.end <= child.source_span.end
      && assignment.source_span.end > assignment.source_span.start
      && spanContained(assignment.source_span, projection.exact_source_spans)
    ));
    const assignmentIds = projection.selection_assignments.map((assignment) => (
      `${assignment.pageIndex}:${assignment.char_index}`
    ));
    for (const assignmentId of assignmentIds) {
      assignmentOwners.set(assignmentId, [...(assignmentOwners.get(assignmentId) ?? []), child.lid]);
    }
    const assignmentIdsUnique = new Set(assignmentIds).size === assignmentIds.length;
    const projectedEvidenceValid = itemClassification !== "glyph_projected" || (
      projection.precision === "partial"
      && projection.regions.length > 0
      && projection.exact_source_spans.length > 0
      && projection.selection_assignments.length > 0
      && Boolean(projection.formula_display_text)
      && assignmentSpansValid
      && assignmentIdsUnique
      && currentPages.length === 1
      && currentColumns.length === 1
    );
    return {
      lid: child.lid,
      baseline_lids: baselineLids,
      source_span: { ...child.source_span },
      classification: itemClassification,
      precision: projection.precision,
      reason: projection.alignment.reason,
      region_count: projection.regions.length,
      assignment_count: projection.selection_assignments.length,
      exact_source_span_count: projection.exact_source_spans.length,
      current_page_indexes: currentPages,
      current_columns: currentColumns,
      expected_page_indexes: expectedPages,
      expected_columns: expectedColumns,
      assignment_spans_valid: assignmentSpansValid,
      assignment_ids_unique: assignmentIdsUnique,
      projected_evidence_valid: projectedEvidenceValid,
      page_matches: comparable ? sameNumbers(expectedPages, currentPages) : null,
      column_matches: comparable ? sameNumbers(expectedColumns, currentColumns) : null,
    };
  });
  const formulaByLid = new Map(formulaItems.map((item) => [item.lid, item]));
  const legacyLeaves = descriptor.expected_adaptation_v1.leaves.filter((leaf) => (
    leaf.expected.issue_ids.includes("PDF-A006")
  ));
  const legacyItems = legacyLeaves.map((leaf) => {
    const migration = migrationMap[leaf.baseline_lid];
    if (migration?.status === "removed") {
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration.status,
        classification: "reviewed_source_removed",
      };
    }
    const currentLid = migration?.v2_lid ?? leaf.baseline_lid;
    const kind = kindByLid.get(currentLid);
    const item = formulaByLid.get(currentLid);
    return {
      baseline_lid: leaf.baseline_lid,
      migration_status: migration?.status ?? "direct",
      current_lid: currentLid,
      classification: item?.classification ?? (kind ? "reviewed_non_formula" : "missing_successor"),
      ...(item ? {
        precision: item.precision,
        reason: item.reason,
        assignment_count: item.assignment_count,
      } : {}),
    };
  });

  const duplicateFormulaAssignmentCount = [...assignmentOwners.values()].filter((owners) => (
    new Set(owners).size > 1
  )).length;
  const unclassifiedCount = formulaItems.filter((item) => item.classification === "unclassified").length;
  const invalidProjectedEvidenceCount = formulaItems.filter((item) => !item.projected_evidence_valid).length;
  const wrongPageCount = formulaItems.filter((item) => item.page_matches === false).length;
  const wrongColumnCount = formulaItems.filter((item) => item.column_matches === false).length;
  const legacyReasonCount = formulaItems.filter((item) => LEGACY_FORMULA_REASONS.has(item.reason)).length;
  const mismatchProjectedCount = formulaItems.filter((item) => (
    GLYPH_MISMATCH_REASONS.has(item.reason) && item.assignment_count > 0
  )).length;
  const legacyMissingSuccessorCount = legacyItems.filter((item) => item.classification === "missing_successor").length;
  const legacyUnclassifiedCount = legacyItems.filter((item) => item.classification === "unclassified").length;
  const report = {
    version: "formula_glyph_audit.v1",
    policy_version: PDF_FORMULA_GLYPH_POLICY.version,
    source_sha256: sha256(source),
    pdf_sha256: sha256(pdfBytes),
    reviewed_map_sha256: sha256(reviewedMapText),
    passed: formulaItems.length === 830
      && legacyItems.length === 318
      && unclassifiedCount === 0
      && invalidProjectedEvidenceCount === 0
      && duplicateFormulaAssignmentCount === 0
      && wrongPageCount === 0
      && wrongColumnCount === 0
      && legacyReasonCount === 0
      && mismatchProjectedCount === 0
      && legacyMissingSuccessorCount === 0
      && legacyUnclassifiedCount === 0,
    summary: {
      formula_count: formulaItems.length,
      glyph_projected_count: formulaItems.filter((item) => item.classification === "glyph_projected").length,
      glyph_assignment_count: formulaItems.reduce((sum, item) => sum + item.assignment_count, 0),
      unclassified_count: unclassifiedCount,
      invalid_projected_evidence_count: invalidProjectedEvidenceCount,
      duplicate_formula_assignment_count: duplicateFormulaAssignmentCount,
      wrong_page_count: wrongPageCount,
      wrong_column_count: wrongColumnCount,
      legacy_formula_reason_count: legacyReasonCount,
      mismatch_projected_count: mismatchProjectedCount,
      classification_counts: counts(formulaItems.map((item) => item.classification)),
      precision_counts: counts(formulaItems.map((item) => item.precision)),
      reason_counts: counts(formulaItems.map((item) => item.reason)),
      legacy_a006_count: legacyItems.length,
      legacy_missing_successor_count: legacyMissingSuccessorCount,
      legacy_unclassified_count: legacyUnclassifiedCount,
      legacy_classification_counts: counts(legacyItems.map((item) => item.classification)),
    },
    formula_items: formulaItems,
    legacy_a006_items: legacyItems,
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFormulaGlyphAuditCli(process.argv.slice(2))
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
