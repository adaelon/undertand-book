import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  alignHybridFoundationV2,
  PDF_ASSET_REGION_POLICY,
  type HybridChildProjection,
} from "../src/hybrid-alignment-v2";
import {
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import { extractPdfTextGeometry, type PdfGeometryPage } from "../src/pdf-geometry";
import { reconcilePaperSource } from "../src/source-reconciliation";
import { PdfSourceMapV2Z } from "../src/zod";

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

function pageIndexes(regions: Array<{ pageIndex: number }>): number[] {
  return [...new Set(regions.map((region) => region.pageIndex))].sort((left, right) => left - right);
}

function regionColumn(
  page: Pick<PdfGeometryPage, "view">,
  bbox: [number, number, number, number],
): 0 | 1 | 2 {
  const midpoint = (page.view[0] + page.view[2]) / 2;
  const pageWidth = page.view[2] - page.view[0];
  const width = bbox[2] - bbox[0];
  const crossesMidpoint = bbox[0] < midpoint && bbox[2] > midpoint;
  if (width >= pageWidth * 0.45 || (crossesMidpoint && width >= pageWidth * 0.35)) return 0;
  return (bbox[0] + bbox[2]) / 2 < midpoint ? 1 : 2;
}

function regionColumns(
  regions: Array<{ pageIndex: number; bbox: [number, number, number, number] }>,
  pages: PdfGeometryPage[],
): number[] {
  return [...new Set(regions.flatMap((region) => {
    const page = pages.find((candidate) => candidate.pageIndex === region.pageIndex);
    return page ? [regionColumn(page, region.bbox)] : [];
  }))].sort((left, right) => left - right);
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBbox(
  left: [number, number, number, number],
  right: [number, number, number, number],
): boolean {
  return left.every((value, index) => Math.abs(value - right[index]) <= 1e-6);
}

function classification(projection: HybridChildProjection): "asset_region_exact" | "asset_unmapped" | "unclassified" {
  if (projection.precision === "region_exact"
    && projection.alignment.reason.startsWith("asset_region_exact:")) return "asset_region_exact";
  if (projection.precision === "unmapped"
    && projection.alignment.reason.startsWith("asset_unmapped:")) return "asset_unmapped";
  return "unclassified";
}

export async function runImageObjectAuditCli(args: string[]) {
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
  const evidence = reconcilePaperSource({
    book_id: `${descriptor.book_id}-reviewed-v2`,
    markdown_source: source,
    pdf_geometry: geometry,
    input_fingerprint: {
      paper_md_sha256: sha256(source),
      paper_pdf_sha256: sha256(pdfBytes),
      config_hash: "image-object-audit.v1",
    },
  }).alignment_evidence;
  const alignment = alignHybridFoundationV2(source, geometry, evidence);
  const projectionByLid = new Map(alignment.projections.map((projection) => [projection.lid, projection]));
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
  const objects = geometry.pages.flatMap((page) => page.objects ?? []);
  const regionOwners = new Map<string, string[]>();

  const imageItems = [...childByLid.values()].filter((child) => child.kind === "image").map((child) => {
    const projection = projectionByLid.get(child.lid)!;
    const itemClassification = classification(projection);
    const baselineLids = baselineLidsByCurrent.get(child.lid) ?? [child.lid];
    const reviewed = baselineLids.map((lid) => reviewedByLid.get(lid)).find((entry) => entry?.regions.length);
    const currentPages = pageIndexes(projection.regions);
    const currentColumns = regionColumns(projection.regions, geometry.pages);
    const expectedPages = reviewed ? pageIndexes(reviewed.regions) : [];
    const expectedColumns = reviewed ? regionColumns(reviewed.regions, geometry.pages) : [];
    const matchedObjectIds = projection.regions.flatMap((region) => objects
      .filter((object) => object.pageIndex === region.pageIndex && sameBbox(object.bbox, region.bbox))
      .map((object) => `${object.pageIndex}:${object.objectIndex}`));
    for (const objectId of matchedObjectIds) {
      regionOwners.set(objectId, [...(regionOwners.get(objectId) ?? []), child.lid]);
    }
    const regionsInBounds = projection.regions.every((region) => {
      const page = geometry.pages.find((candidate) => candidate.pageIndex === region.pageIndex);
      return Boolean(page)
        && region.bbox[0] >= page!.view[0]
        && region.bbox[1] >= page!.view[1]
        && region.bbox[2] <= page!.view[2]
        && region.bbox[3] <= page!.view[3];
    });
    const evidenceValid = itemClassification === "asset_region_exact"
      ? projection.regions.length === 1
        && projection.exact_source_spans.length === 0
        && projection.selection_assignments.length === 0
        && matchedObjectIds.length === 1
        && regionsInBounds
      : itemClassification === "asset_unmapped"
        && projection.regions.length === 0
        && projection.exact_source_spans.length === 0
        && projection.selection_assignments.length === 0;
    const comparable = Boolean(reviewed?.regions.length) && itemClassification === "asset_region_exact";
    return {
      lid: child.lid,
      baseline_lids: baselineLids,
      source_span: { ...child.source_span },
      classification: itemClassification,
      precision: projection.precision,
      reason: projection.alignment.reason,
      region_count: projection.regions.length,
      selection_assignment_count: projection.selection_assignments.length,
      exact_source_span_count: projection.exact_source_spans.length,
      matched_object_ids: matchedObjectIds,
      regions_in_bounds: regionsInBounds,
      evidence_valid: evidenceValid,
      current_page_indexes: currentPages,
      current_columns: currentColumns,
      expected_page_indexes: expectedPages,
      expected_columns: expectedColumns,
      page_matches: comparable ? sameNumbers(expectedPages, currentPages) : null,
      column_matches: comparable ? sameNumbers(expectedColumns, currentColumns) : null,
    };
  });
  const imageByLid = new Map(imageItems.map((item) => [item.lid, item]));
  const legacyA010Items = descriptor.expected_adaptation_v1.leaves
    .filter((leaf) => leaf.expected.issue_ids.includes("PDF-A010"))
    .flatMap((leaf) => {
      const migration = migrationMap[leaf.baseline_lid];
      const currentLid = migration?.v2_lid ?? leaf.baseline_lid;
      const item = imageByLid.get(currentLid);
      if (!item) return [];
      return [{
        baseline_lid: leaf.baseline_lid,
        migration_status: migration?.status ?? "direct",
        current_lid: currentLid,
        classification: item.classification,
        precision: item.precision,
        reason: item.reason,
      }];
    });

  const duplicateObjectOwnershipCount = [...regionOwners.values()].filter((owners) => (
    new Set(owners).size > 1
  )).length;
  const unclassifiedCount = imageItems.filter((item) => item.classification === "unclassified").length;
  const invalidEvidenceCount = imageItems.filter((item) => !item.evidence_valid).length;
  const wrongPageCount = imageItems.filter((item) => item.page_matches === false).length;
  const wrongColumnCount = imageItems.filter((item) => item.column_matches === false).length;
  const legacyProjectionReasonCount = imageItems.filter((item) => (
    item.reason === "alignment unit has no searchable tokens"
  )).length;
  const selectionAssignmentCount = imageItems.reduce((sum, item) => sum + item.selection_assignment_count, 0);
  const exactSourceSpanCount = imageItems.reduce((sum, item) => sum + item.exact_source_span_count, 0);
  const imageOnlyUnitCount = alignment.locations.filter((location) => (
    location.unit.child_lids.every((child) => child.kind === "image")
  )).length;
  const report = {
    version: "image_object_audit.v1",
    policy_version: PDF_ASSET_REGION_POLICY.version,
    source_sha256: sha256(source),
    pdf_sha256: sha256(pdfBytes),
    reviewed_map_sha256: sha256(reviewedMapText),
    passed: imageItems.length === 19
      && legacyA010Items.length === 19
      && imageOnlyUnitCount === 19
      && unclassifiedCount === 0
      && invalidEvidenceCount === 0
      && duplicateObjectOwnershipCount === 0
      && selectionAssignmentCount === 0
      && exactSourceSpanCount === 0
      && wrongPageCount === 0
      && wrongColumnCount === 0
      && legacyProjectionReasonCount === 0,
    summary: {
      image_count: imageItems.length,
      image_only_unit_count: imageOnlyUnitCount,
      asset_region_exact_count: imageItems.filter((item) => item.classification === "asset_region_exact").length,
      asset_unmapped_count: imageItems.filter((item) => item.classification === "asset_unmapped").length,
      unclassified_count: unclassifiedCount,
      invalid_evidence_count: invalidEvidenceCount,
      duplicate_object_ownership_count: duplicateObjectOwnershipCount,
      selection_assignment_count: selectionAssignmentCount,
      exact_source_span_count: exactSourceSpanCount,
      wrong_page_count: wrongPageCount,
      wrong_column_count: wrongColumnCount,
      legacy_projection_reason_count: legacyProjectionReasonCount,
      legacy_a010_image_count: legacyA010Items.length,
      classification_counts: counts(imageItems.map((item) => item.classification)),
      precision_counts: counts(imageItems.map((item) => item.precision)),
      reason_counts: counts(imageItems.map((item) => item.reason)),
    },
    image_items: imageItems,
    legacy_a010_image_items: legacyA010Items,
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runImageObjectAuditCli(process.argv.slice(2))
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
