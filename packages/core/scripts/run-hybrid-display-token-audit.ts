import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { alignHybridFoundationV2, PDF_DISPLAY_TOKEN_POLICY } from "../src/hybrid-alignment-v2";
import {
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import { extractPdfTextGeometry } from "../src/pdf-geometry";
import { parseMarkdownSourceBlocks } from "../src/md-adapter";
import { reconcilePaperSource } from "../src/source-reconciliation";

const PUNCTUATION_SYMBOL_BASELINE_LIDS = [
  "1.18.3", "1.18.12", "1.18.13", "1.19.86.57.60", "1.19.86.57.90", "1.19.86.58.10",
  "1.19.87.191.78", "1.19.87.191.133", "1.19.87.192.2", "1.20.3.46", "1.21.3", "1.23.8",
  "1.23.47", "1.23.53", "1.23.64", "1.23.79", "1.23.88", "1.24.8.15", "1.24.10.20",
  "1.24.16.62", "2.5", "4.3", "6.19", "6.22", "6.28", "6.30", "8.2", "8.3",
] as const;

const WHITESPACE_BASELINE_LIDS = [
  "1.19.80", "1.19.86.57.21", "1.19.86.57.33", "1.19.86.58.20", "1.19.87.50",
  "1.19.87.191.8", "1.19.87.191.13", "1.19.87.191.47", "1.23.24", "1.23.37", "1.23.107",
  "1.24.7.2", "1.24.9.6", "1.24.10.52", "1.24.13.7", "1.24.13.11", "1.24.17.21",
  "6.4", "6.13", "6.14", "6.18", "6.29", "8.4",
] as const;

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

function sameSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export async function runHybridDisplayTokenAuditCli(args: string[]) {
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
  const a002Leaves = descriptor.expected_adaptation_v1.leaves
    .filter((leaf) => leaf.expected.issue_ids.includes("PDF-A002"));
  const a003Leaves = descriptor.expected_adaptation_v1.leaves
    .filter((leaf) => leaf.expected.issue_ids.includes("PDF-A003"));
  const a003Partition = [...PUNCTUATION_SYMBOL_BASELINE_LIDS, ...WHITESPACE_BASELINE_LIDS];
  if (!sameSet(a003Leaves.map((leaf) => leaf.baseline_lid), a003Partition)) {
    throw new Error("PDF-A003 baseline no longer matches the reviewed punctuation/whitespace partition");
  }

  const geometry = await extractPdfTextGeometry(pdfBytes);
  const evidence = reconcilePaperSource({
    book_id: `${descriptor.book_id}-reviewed-v2`,
    markdown_source: source,
    pdf_geometry: geometry,
    input_fingerprint: {
      paper_md_sha256: sha256(source),
      paper_pdf_sha256: sha256(pdfBytes),
      config_hash: "hybrid-display-token-audit.v1",
    },
  }).alignment_evidence;
  const alignment = alignHybridFoundationV2(source, geometry, evidence);
  const projectionByLid = new Map(alignment.projections.map((projection) => [projection.lid, projection]));
  const displaySegments = parseMarkdownSourceBlocks(source).display_segments;

  const replay = (
    leaves: typeof a002Leaves,
    kind: "markdown_role" | "punctuation_symbol" | "layout_whitespace",
  ) => leaves.map((leaf) => {
    const migration = migrationMap[leaf.baseline_lid];
    if (migration?.status === "removed") {
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration.status,
        status: "removed",
        classification: "reviewed_source_removed",
      };
    }
    const currentLid = migration?.v2_lid ?? leaf.baseline_lid;
    const projection = projectionByLid.get(currentLid);
    if (!projection) {
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration?.status ?? "direct",
        current_lid: currentLid,
        status: "missing_successor",
        classification: "unclassified",
      };
    }
    const expectedRole = leaf.baseline_lid === "1.1" ? "heading" : "list_item";
    const parserRoles = [...new Set(displaySegments
      .filter((segment) => (
        segment.source_span.start >= projection.source_span.start
        && segment.source_span.end <= projection.source_span.end
      ))
      .map((segment) => segment.role))].sort();
    const classification = kind === "markdown_role"
      ? parserRoles.includes(expectedRole) ? "accepted_parser_role_display" : "unclassified"
      : kind === "layout_whitespace"
        ? "accepted_layout_whitespace_policy"
        : projection.precision === "char_exact"
          ? "accepted_glyph_representation"
          : "material_punctuation_difference";
    return {
      baseline_lid: leaf.baseline_lid,
      migration_status: migration?.status ?? "direct",
      current_lid: currentLid,
      status: "replayed",
      classification,
      ...(kind === "markdown_role" ? { parser_roles: parserRoles } : {}),
      precision: projection.precision,
      reason: projection.alignment.reason,
      page_indexes: [...new Set(projection.regions.map((region) => region.pageIndex))]
        .sort((left, right) => left - right),
    };
  });

  const punctuationSet = new Set<string>(PUNCTUATION_SYMBOL_BASELINE_LIDS);
  const whitespaceSet = new Set<string>(WHITESPACE_BASELINE_LIDS);
  const a002Items = replay(a002Leaves, "markdown_role");
  const punctuationItems = replay(
    a003Leaves.filter((leaf) => punctuationSet.has(leaf.baseline_lid)),
    "punctuation_symbol",
  );
  const whitespaceItems = replay(
    a003Leaves.filter((leaf) => whitespaceSet.has(leaf.baseline_lid)),
    "layout_whitespace",
  );
  const summarize = (items: ReturnType<typeof replay>) => ({
    baseline_count: items.length,
    replayed_count: items.filter((item) => item.status === "replayed").length,
    removed_count: items.filter((item) => item.status === "removed").length,
    missing_successor_count: items.filter((item) => item.status === "missing_successor").length,
    classification_counts: counts(items.map((item) => item.classification)),
    precision_counts: counts(items.flatMap((item) => (
      "precision" in item && item.precision ? [item.precision] : []
    ))),
    items,
  });
  const markdownRoles = summarize(a002Items);
  const punctuationSymbols = summarize(punctuationItems);
  const layoutWhitespace = summarize(whitespaceItems);
  const allItems = [...a002Items, ...punctuationItems, ...whitespaceItems];
  const report = {
    version: "hybrid_display_token_audit.v1",
    policy_version: PDF_DISPLAY_TOKEN_POLICY.version,
    source_sha256: sha256(source),
    pdf_sha256: sha256(pdfBytes),
    passed: markdownRoles.baseline_count === 8
      && punctuationSymbols.baseline_count === 28
      && layoutWhitespace.baseline_count === 23
      && allItems.every((item) => item.status !== "missing_successor" && item.classification !== "unclassified")
      && a002Items.every((item) => item.status === "removed" || item.classification === "accepted_parser_role_display")
      && whitespaceItems.every((item) => (
        item.status === "removed" || item.classification === "accepted_layout_whitespace_policy"
      )),
    summary: {
      unit_count: alignment.units.length,
      projection_count: alignment.projections.length,
      unclassified_count: allItems.filter((item) => item.classification === "unclassified").length,
    },
    categories: {
      markdown_roles: markdownRoles,
      punctuation_symbols: punctuationSymbols,
      layout_whitespace: layoutWhitespace,
    },
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runHybridDisplayTokenAuditCli(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(`${JSON.stringify({
        version: report.version,
        policy_version: report.policy_version,
        source_sha256: report.source_sha256,
        passed: report.passed,
        ...report.summary,
        markdown_roles: report.categories.markdown_roles.classification_counts,
        punctuation_symbols: report.categories.punctuation_symbols.classification_counts,
        layout_whitespace: report.categories.layout_whitespace.classification_counts,
      }, null, 2)}\n`);
      if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
