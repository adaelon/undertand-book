import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  alignHybridFoundationV2,
  PDF_BINDING_OWNERSHIP_POLICY,
  type HybridChildProjection,
} from "../src/hybrid-alignment-v2";
import {
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import { extractPdfTextGeometry } from "../src/pdf-geometry";
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

function duplicateBindingCounts(projections: HybridChildProjection[]) {
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
  return {
    region: [...regionOwners.values()].filter((owners) => owners.size > 1).length,
    selection: [...selectionOwners.values()].filter((owners) => owners.size > 1).length,
  };
}

export async function runBindingOwnershipAuditCli(args: string[]) {
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
      config_hash: "binding-ownership-audit.v1",
    },
  }).alignment_evidence;
  const alignment = alignHybridFoundationV2(source, geometry, evidence);
  const projectionByLid = new Map(alignment.projections.map((projection) => [projection.lid, projection]));
  const resolvedDuplicates = duplicateBindingCounts(alignment.projections);
  const rejectionRecords = alignment.projections.flatMap((projection) => (
    (projection.binding_rejections ?? []).map((rejection) => ({ lid: projection.lid, ...rejection }))
  ));
  const invalidRejectionCount = rejectionRecords.filter((rejection) => (
    !rejection.candidate_id
    || !rejection.competitor_ids.length
    || !rejection.constraint
    || !rejection.resource_keys.length
  )).length;
  const unauditedRejectionProjectionCount = alignment.projections.filter((projection) => (
    projection.binding_candidate_count !== undefined
    && projection.binding_candidate_count !== (projection.binding_rejections?.length ?? 0)
  )).length;

  const legacyA009Items = descriptor.expected_adaptation_v1.leaves
    .filter((leaf) => leaf.expected.issue_ids.includes("PDF-A009"))
    .map((leaf) => {
      const migration = migrationMap[leaf.baseline_lid];
      const currentLid = migration?.v2_lid ?? leaf.baseline_lid;
      const projection = projectionByLid.get(currentLid);
      const classification = migration?.status === "removed"
        ? "reviewed_removed"
        : migration?.status === "content_drift"
          ? "reviewed_content_drift"
          : projection?.precision !== "unmapped"
            ? "unique_owner"
            : projection?.alignment.reason.startsWith("ambiguous_binding:")
                && projection.binding_rejections?.length
              ? "stable_ambiguous_binding"
              : "unclassified";
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration?.status ?? "direct",
        ...(migration?.v2_lid ? { current_lid: migration.v2_lid } : {}),
        classification,
        ...(projection ? {
          precision: projection.precision,
          reason: projection.alignment.reason,
          rejection_count: projection.binding_rejections?.length ?? 0,
          rejection_constraint_counts: counts((projection.binding_rejections ?? []).map((item) => item.constraint)),
        } : {}),
      };
    });
  const legacyClassificationCounts = counts(legacyA009Items.map((item) => item.classification));
  const diagnostics = alignment.binding_ownership.diagnostics;
  const passed = diagnostics.competing_region_binding_count === 0
    && diagnostics.competing_selection_binding_count === 15
    && diagnostics.conflict_group_count === 2
    && diagnostics.unique_owner_group_count === 2
    && diagnostics.ambiguous_group_count === 0
    && diagnostics.rejected_candidate_count === 2
    && resolvedDuplicates.region === 0
    && resolvedDuplicates.selection === 0
    && invalidRejectionCount === 0
    && unauditedRejectionProjectionCount === 0
    && legacyA009Items.length === 11
    && legacyClassificationCounts.unique_owner === 3
    && legacyClassificationCounts.stable_ambiguous_binding === 1
    && legacyClassificationCounts.reviewed_removed === 6
    && legacyClassificationCounts.reviewed_content_drift === 1
    && !legacyClassificationCounts.unclassified;
  const report = {
    version: "binding_ownership_audit.v1",
    policy_version: PDF_BINDING_OWNERSHIP_POLICY.version,
    source_sha256: sha256(source),
    pdf_sha256: sha256(pdfBytes),
    reviewed_map_sha256: sha256(reviewedMapText),
    passed,
    summary: {
      ...diagnostics,
      formal_duplicate_region_binding_count: resolvedDuplicates.region,
      formal_duplicate_selection_binding_count: resolvedDuplicates.selection,
      audited_rejection_count: rejectionRecords.length,
      invalid_rejection_count: invalidRejectionCount,
      unaudited_rejection_projection_count: unauditedRejectionProjectionCount,
      rejection_constraint_counts: counts(rejectionRecords.map((item) => item.constraint)),
      legacy_a009_count: legacyA009Items.length,
      legacy_a009_classification_counts: legacyClassificationCounts,
    },
    ownership_groups: alignment.binding_ownership.decisions,
    legacy_a009_items: legacyA009Items,
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runBindingOwnershipAuditCli(process.argv.slice(2))
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
