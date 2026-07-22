import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { alignHybridFoundationV2, type HybridChildProjection } from "../src/hybrid-alignment-v2";
import {
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import { extractPdfTextGeometry } from "../src/pdf-geometry";
import { reconcilePaperSource } from "../src/source-reconciliation";

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

function position(assignment: HybridChildProjection["selection_assignments"][number]): [number, number] {
  return [assignment.pageIndex, assignment.char_index];
}

function comparePosition(left: [number, number], right: [number, number]): number {
  return left[0] - right[0] || left[1] - right[1];
}

function wrongWindowAssignmentCount(
  units: ReturnType<typeof alignHybridFoundationV2>["units"],
  projections: HybridChildProjection[],
): number {
  const byLid = new Map(projections.map((projection) => [projection.lid, projection]));
  let wrong = 0;
  for (const unit of units) {
    let previousEnd: [number, number] | undefined;
    for (const child of unit.child_lids.filter((candidate) => candidate.kind === "text" || candidate.kind === "code")) {
      const assignments = byLid.get(child.lid)?.selection_assignments ?? [];
      if (!assignments.length) continue;
      const ordered = assignments.map(position).sort(comparePosition);
      if (previousEnd && comparePosition(ordered[0], previousEnd) <= 0) wrong += 1;
      previousEnd = ordered.at(-1);
    }
  }
  return wrong;
}

export async function runHybridChildWindowAuditCli(args: string[]) {
  const sourcePath = requiredPath(args, "--source");
  const pdfPath = requiredPath(args, "--pdf");
  const descriptorPath = requiredPath(args, "--descriptor");
  const migrationMapPath = requiredPath(args, "--migration-map");
  const outputPath = optionalPath(args, "--output");
  const source = readFileSync(sourcePath, "utf8");
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  const descriptor = ExternalBenchmarkDescriptorZ.parse(JSON.parse(readFileSync(descriptorPath, "utf8")));
  const migrationMap = HybridFoundationAdaptationMigrationMapZ.parse(
    JSON.parse(readFileSync(migrationMapPath, "utf8")),
  );
  if (sha256(pdfBytes) !== descriptor.input_sha256.pdf) throw new Error("PDF hash does not match adaptation baseline");
  const geometry = await extractPdfTextGeometry(pdfBytes);
  const evidence = reconcilePaperSource({
    book_id: `${descriptor.book_id}-reviewed-v2`,
    markdown_source: source,
    pdf_geometry: geometry,
    input_fingerprint: {
      paper_md_sha256: sha256(source),
      paper_pdf_sha256: sha256(pdfBytes),
      config_hash: "hybrid-child-window-audit.v1",
    },
  }).alignment_evidence;
  const alignment = alignHybridFoundationV2(source, geometry, evidence);
  const projectionByLid = new Map(alignment.projections.map((projection) => [projection.lid, projection]));
  const issueReport = (issueId: "PDF-A004" | "PDF-A005") => {
    const expected = descriptor.expected_adaptation_v1.leaves
      .filter((leaf) => leaf.expected.issue_ids.includes(issueId));
    const items = expected.map((leaf) => {
      const migration = migrationMap[leaf.baseline_lid];
      const currentLid = migration?.v2_lid ?? leaf.baseline_lid;
      const projection = migration?.status === "removed" ? undefined : projectionByLid.get(currentLid);
      const pageIndexes = projection
        ? [...new Set(projection.regions.map((region) => region.pageIndex))].sort((left, right) => left - right)
        : [];
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration?.status ?? "direct",
        ...(migration?.status === "removed" ? {} : { current_lid: currentLid }),
        status: migration?.status === "removed" ? "removed" : projection ? "replayed" : "missing_successor",
        ...(projection ? {
          precision: projection.precision,
          reason: projection.alignment.reason,
          page_indexes: pageIndexes,
          assignment_count: projection.selection_assignments.length,
          exact_source_span_count: projection.exact_source_spans.length,
        } : {}),
      };
    });
    const replayed = items.filter((item) => item.status === "replayed");
    return {
      baseline_count: expected.length,
      replayed_count: replayed.length,
      removed_count: items.filter((item) => item.status === "removed").length,
      missing_successor_count: items.filter((item) => item.status === "missing_successor").length,
      precision_counts: counts(replayed.map((item) => item.precision!)),
      reason_counts: counts(replayed.map((item) => item.reason!)),
      items,
    };
  };
  const a004 = issueReport("PDF-A004");
  const a005 = issueReport("PDF-A005");
  const wrongWindowCount = wrongWindowAssignmentCount(alignment.units, alignment.projections);
  const legacyCursorReasonCount = [...a004.items, ...a005.items]
    .filter((item) => item.reason === "child has no deterministic projection inside the located unit").length;
  const report = {
    version: "hybrid_child_window_audit.v1",
    source_sha256: sha256(source),
    pdf_sha256: sha256(pdfBytes),
    passed: a004.baseline_count === 54
      && a005.baseline_count === 129
      && a004.missing_successor_count === 0
      && a005.missing_successor_count === 0
      && wrongWindowCount === 0
      && legacyCursorReasonCount === 0,
    summary: {
      unit_count: alignment.units.length,
      projection_count: alignment.projections.length,
      wrong_window_assignment_count: wrongWindowCount,
      legacy_shared_cursor_reason_count: legacyCursorReasonCount,
    },
    issues: { "PDF-A004": a004, "PDF-A005": a005 },
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runHybridChildWindowAuditCli(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(`${JSON.stringify({
        version: report.version,
        source_sha256: report.source_sha256,
        passed: report.passed,
        ...report.summary,
        a004: {
          baseline: report.issues["PDF-A004"].baseline_count,
          replayed: report.issues["PDF-A004"].replayed_count,
          removed: report.issues["PDF-A004"].removed_count,
          missing: report.issues["PDF-A004"].missing_successor_count,
        },
        a005: {
          baseline: report.issues["PDF-A005"].baseline_count,
          replayed: report.issues["PDF-A005"].replayed_count,
          removed: report.issues["PDF-A005"].removed_count,
          missing: report.issues["PDF-A005"].missing_successor_count,
        },
      }, null, 2)}\n`);
      if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
