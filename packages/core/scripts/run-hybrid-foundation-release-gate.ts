import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runBindingOwnershipAuditCli } from "./run-binding-ownership-audit";
import { runFormulaGlyphAuditCli } from "./run-formula-glyph-audit";
import { runFormulaRegionAuditCli } from "./run-formula-region-audit";
import { runFormulaSourceAstAuditCli } from "./run-formula-source-ast-audit";
import { runHybridAlignmentUnitAuditCli } from "./run-hybrid-alignment-unit-audit";
import { runHybridChildWindowAuditCli } from "./run-hybrid-child-window-audit";
import { runHybridDisplayTokenAuditCli } from "./run-hybrid-display-token-audit";
import { runImageObjectAuditCli } from "./run-image-object-audit";
import {
  applyHybridFoundationArtifactSet,
  hybridFoundationArtifactSetDigest,
  migrateHybridFoundationVersionBase,
  sameLidIdentity,
} from "../src/hybrid-foundation-apply";
import {
  auditHybridFoundationAdaptation,
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import {
  buildHybridFoundationV2Candidate,
  validateHybridFoundationV2ArtifactSet,
  writeHybridFoundationV2ArtifactSet,
} from "../src/hybrid-foundation-v2";
import { extractPdfTextGeometry } from "../src/pdf-geometry";
import { reconcilePaperSource } from "../src/source-reconciliation";
import { ReadOnlyBaseZ } from "../src/zod";

interface ReviewedSourceReport {
  version: "reviewed_source_candidate_report.v1";
  old_book_id: string;
  new_book_id: string;
  input_fingerprint: { source_sha256: string; base_sha256: string };
  output_fingerprint: { source_sha256: string; base_sha256: string; migration_sha256: string };
  source_review_gate: "approved";
  formal_release_gate: "pending_pr20_rebuild";
  migration: {
    stable: number;
    content_drift: number;
    removed: number;
    unexpected_candidate_count: number;
    duplicate_candidate_count: number;
  };
}

const FIXTURE_ROOT = fileURLToPath(new URL(
  "../test/fixtures/hybrid-foundation-goldset/v1/",
  import.meta.url,
));
const DEFAULT_DESCRIPTOR_PATH = path.join(FIXTURE_ROOT, "external-formula-dense-transformer.json");
const RELEASE_CONFIG_VERSION = "hybrid-foundation-reviewed-release.v1";
const RELEASE_PROJECTION_REASONS = new Set([
  "alignment unit has ambiguous forward candidates",
  "alignment unit has no exact monotonic candidate",
  "ambiguous_binding: multiple equal exact child chains",
  "ambiguous_binding: multiple equal formula region chains",
  "asset_region_exact: unique PDF object chain inside proven source-order anchors",
  "asset_region_exact: unique remaining PDF object chain between proven neighboring asset bindings",
  "asset_region_exact: unique same-page PDF object above an adjacent proven caption anchor",
  "binding_rejected: complete glyph owner excludes partial candidate",
  "binding_rejected: formula group has incomplete candidate set",
  "child has no deterministic projection inside its local PDF window",
  "child has no exclusive local PDF window",
  "child-local projection contains unmatched material PDF",
  "complete formula glyph projection in unique formula region",
  "complete monotonic character projection inside located unit",
  "complete simple formula display projection with source-markup gaps",
  "complete structural formula glyph projection",
  "formula glyph geometry conflicts with source AST",
  "formula glyph projection has no complete structural match",
  "formula region conflicts with adjacent page-column lanes",
  "formula signature crosses page-column lanes",
  "formula source AST structure is not glyph-projectable",
  "partial monotonic character projection inside located unit",
]);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`${name} requires an explicit path`);
  return path.resolve(value);
}

function assertHash(file: string, expected: string, label: string): void {
  const actual = sha256(readFileSync(file));
  if (actual !== expected) throw new Error(`${label} hash differs: ${actual} != ${expected}`);
}

function countReasons(entries: Array<{ alignment: { reason: string } }>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.alignment.reason, (counts.get(entry.alignment.reason) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

async function verifyFrozenAudits(input: {
  source_path: string;
  pdf_path: string;
  descriptor_path: string;
  migration_map_path: string;
  reviewed_map_path: string;
}) {
  const common = [
    "--source", input.source_path,
    "--pdf", input.pdf_path,
    "--descriptor", input.descriptor_path,
    "--migration-map", input.migration_map_path,
  ];
  const reviewed = [...common, "--reviewed-map", input.reviewed_map_path];
  const specs: Array<{
    name: string;
    fixture: string;
    exact_fixture: boolean;
    run: () => unknown | Promise<unknown>;
  }> = [
    {
      name: "alignment_unit",
      fixture: "external-formula-dense-transformer-alignment-unit-audit.json",
      exact_fixture: false,
      run: () => runHybridAlignmentUnitAuditCli(["--source", input.source_path]),
    },
    {
      name: "child_window",
      fixture: "external-formula-dense-transformer-child-window-audit.json",
      exact_fixture: false,
      run: () => runHybridChildWindowAuditCli(common),
    },
    {
      name: "display_token",
      fixture: "external-formula-dense-transformer-display-token-audit.json",
      exact_fixture: false,
      run: () => runHybridDisplayTokenAuditCli(common),
    },
    {
      name: "formula_source_ast",
      fixture: "external-formula-dense-transformer-formula-source-ast-audit.json",
      exact_fixture: false,
      run: () => runFormulaSourceAstAuditCli([
        "--source", input.source_path,
        "--descriptor", input.descriptor_path,
        "--migration-map", input.migration_map_path,
      ]),
    },
    {
      name: "formula_region",
      fixture: "external-formula-dense-transformer-formula-region-audit.json",
      exact_fixture: true,
      run: () => runFormulaRegionAuditCli(reviewed),
    },
    {
      name: "formula_glyph",
      fixture: "external-formula-dense-transformer-formula-glyph-audit.json",
      exact_fixture: true,
      run: () => runFormulaGlyphAuditCli(reviewed),
    },
    {
      name: "image_object",
      fixture: "external-formula-dense-transformer-image-object-audit.json",
      exact_fixture: false,
      run: () => runImageObjectAuditCli(reviewed),
    },
    {
      name: "binding_ownership",
      fixture: "external-formula-dense-transformer-binding-ownership-audit.json",
      exact_fixture: true,
      run: () => runBindingOwnershipAuditCli(reviewed),
    },
  ];
  const reports: Record<string, unknown> = {};
  const reportHashes: Record<string, string> = {};
  for (const spec of specs) {
    const fixturePath = path.join(FIXTURE_ROOT, spec.fixture);
    const expected = readJson(fixturePath);
    const actual = await spec.run();
    if (!(actual as { passed?: boolean }).passed) throw new Error(`${spec.name} audit failed`);
    if (spec.exact_fixture && !isDeepStrictEqual(actual, expected)) {
      throw new Error(`${spec.name} audit differs from its frozen reviewed fixture`);
    }
    reports[spec.name] = actual;
    reportHashes[spec.name] = sha256(JSON.stringify(actual));
  }
  return { reports, report_hashes: reportHashes };
}

function validatePublishedSupport(
  root: string,
  expected: { pdf: string; migration: string; review: string },
): void {
  assertHash(path.join(root, "paper.pdf"), expected.pdf, "published PDF");
  assertHash(path.join(root, "lid_migration_map.json"), expected.migration, "published migration map");
  assertHash(path.join(root, "source_review_report.json"), expected.review, "published source review report");
}

function publishVersion(input: {
  old_book_dir: string;
  publish_dir: string;
  candidate_dir: string;
  migration_map_path: string;
  review_report_path: string;
  book_id: string;
  pdf_sha256: string;
  evidence_sha256: string;
}) {
  if (path.dirname(input.publish_dir) !== path.dirname(input.old_book_dir)) {
    throw new Error("published book version must be a sibling of the old book directory");
  }
  if (path.basename(input.publish_dir) !== input.book_id) {
    throw new Error("published directory name must equal the reviewed book id");
  }
  const supportHashes = {
    pdf: input.pdf_sha256,
    migration: sha256(readFileSync(input.migration_map_path)),
    review: sha256(readFileSync(input.review_report_path)),
  };
  const candidateDigest = hybridFoundationArtifactSetDigest(input.candidate_dir);
  if (existsSync(input.publish_dir)) {
    validateHybridFoundationV2ArtifactSet(input.publish_dir, {
      expected_pdf_sha256: input.pdf_sha256,
      expected_source_alignment_evidence_sha256: input.evidence_sha256,
    });
    validatePublishedSupport(input.publish_dir, supportHashes);
    if (hybridFoundationArtifactSetDigest(input.publish_dir) !== candidateDigest) {
      throw new Error("existing published version differs from the approved candidate");
    }
    return { status: "already_current" as const, transaction_id: null };
  }

  mkdirSync(path.dirname(input.publish_dir), { recursive: true });
  const stageDir = path.join(
    path.dirname(input.publish_dir),
    `.${input.book_id}.publish-${candidateDigest.slice(0, 12)}`,
  );
  if (existsSync(stageDir)) throw new Error(`book version publish staging directory already exists: ${stageDir}`);
  mkdirSync(stageDir);
  try {
    copyFileSync(path.join(input.old_book_dir, "paper.pdf"), path.join(stageDir, "paper.pdf"));
    copyFileSync(input.migration_map_path, path.join(stageDir, "lid_migration_map.json"));
    copyFileSync(input.review_report_path, path.join(stageDir, "source_review_report.json"));
    const validate = (root: string) => {
      validateHybridFoundationV2ArtifactSet(root, {
        expected_pdf_sha256: input.pdf_sha256,
        expected_source_alignment_evidence_sha256: input.evidence_sha256,
      });
    };
    const applied = applyHybridFoundationArtifactSet({
      book_dir: stageDir,
      candidate_dir: input.candidate_dir,
      validate_artifact_set: validate,
      transaction_id: `release-${candidateDigest.slice(0, 16)}`,
    });
    validate(stageDir);
    validatePublishedSupport(stageDir, supportHashes);
    if (hybridFoundationArtifactSetDigest(stageDir) !== candidateDigest) {
      throw new Error("staged published version differs from the approved candidate");
    }
    renameSync(stageDir, input.publish_dir);
    return { status: "published" as const, transaction_id: applied.transaction_id };
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const oldBookDir = requiredArgument("--old-book");
  const reviewedCandidateDir = requiredArgument("--reviewed-candidate");
  const workDir = requiredArgument("--work-dir");
  const descriptorPath = path.resolve(argument("--descriptor") ?? DEFAULT_DESCRIPTOR_PATH);
  const publishDir = argument("--publish-dir") ? path.resolve(argument("--publish-dir")!) : undefined;
  const apply = process.argv.includes("--apply");
  const keep = process.argv.includes("--keep");
  if (apply && !publishDir) throw new Error("--apply requires --publish-dir");

  const descriptor = ExternalBenchmarkDescriptorZ.parse(readJson(descriptorPath));
  const reviewReportPath = path.join(reviewedCandidateDir, "source_review_report.json");
  const sourcePath = path.join(reviewedCandidateDir, "source.txt");
  const approvedBasePath = path.join(reviewedCandidateDir, "base.json");
  const migrationMapPath = path.join(reviewedCandidateDir, "lid_migration_map.json");
  const reviewReport = readJson(reviewReportPath) as ReviewedSourceReport;
  if (reviewReport.version !== "reviewed_source_candidate_report.v1"
    || reviewReport.source_review_gate !== "approved"
    || reviewReport.formal_release_gate !== "pending_pr20_rebuild"
    || reviewReport.old_book_id !== descriptor.book_id) {
    throw new Error("reviewed source report does not authorize PR20 release");
  }
  const oldSourcePath = path.join(oldBookDir, "source.txt");
  const oldBasePath = path.join(oldBookDir, "base.json");
  const pdfPath = path.join(oldBookDir, "paper.pdf");
  const reviewedMapPath = path.join(oldBookDir, "pdf_source_map.json");
  assertHash(oldSourcePath, reviewReport.input_fingerprint.source_sha256, "old source");
  assertHash(oldBasePath, reviewReport.input_fingerprint.base_sha256, "old base");
  assertHash(sourcePath, reviewReport.output_fingerprint.source_sha256, "approved source");
  assertHash(approvedBasePath, reviewReport.output_fingerprint.base_sha256, "approved base");
  assertHash(migrationMapPath, reviewReport.output_fingerprint.migration_sha256, "migration map");
  assertHash(pdfPath, descriptor.input_sha256.pdf, "approved PDF");
  if (reviewReport.migration.unexpected_candidate_count
    || reviewReport.migration.duplicate_candidate_count) {
    throw new Error("reviewed source migration identity is not one-to-one");
  }
  const oldBase = ReadOnlyBaseZ.parse(readJson(oldBasePath));
  const approvedBase = ReadOnlyBaseZ.parse(readJson(approvedBasePath));
  const migrationMap = HybridFoundationAdaptationMigrationMapZ.parse(readJson(migrationMapPath));
  if (oldBase.book_id !== reviewReport.old_book_id || approvedBase.book_id !== reviewReport.new_book_id) {
    throw new Error("reviewed source/base book identities differ from the approval report");
  }

  const frozenAudits = await verifyFrozenAudits({
    source_path: sourcePath,
    pdf_path: pdfPath,
    descriptor_path: descriptorPath,
    migration_map_path: migrationMapPath,
    reviewed_map_path: reviewedMapPath,
  });
  const source = readFileSync(sourcePath, "utf8");
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  const geometry = await extractPdfTextGeometry(pdfBytes);
  mkdirSync(workDir, { recursive: true });
  const releaseRoot = mkdtempSync(path.join(workDir, "pr20-release-"));
  const candidateDirs = [path.join(releaseRoot, "candidate-a"), path.join(releaseRoot, "candidate-b")];
  try {
    const built = candidateDirs.map((candidateDir) => {
      const evidence = reconcilePaperSource({
        book_id: reviewReport.new_book_id,
        markdown_source: source,
        pdf_geometry: geometry,
        input_fingerprint: {
          paper_md_sha256: reviewReport.output_fingerprint.source_sha256,
          paper_pdf_sha256: descriptor.input_sha256.pdf,
          config_hash: RELEASE_CONFIG_VERSION,
        },
      }).alignment_evidence;
      const artifacts = buildHybridFoundationV2Candidate({
        book_id: reviewReport.new_book_id,
        source_txt: source,
        original_pdf_path: "paper.pdf",
        original_pdf_sha256: descriptor.input_sha256.pdf,
        pdf_geometry: geometry,
        source_alignment_evidence: evidence,
      });
      if (!sameLidIdentity(approvedBase, artifacts.base)) {
        throw new Error("rebuilt candidate LID identity differs from the approved PR10 base");
      }
      const migrated = migrateHybridFoundationVersionBase(oldBase, artifacts.base, migrationMap);
      mkdirSync(candidateDir);
      writeHybridFoundationV2ArtifactSet(candidateDir, source, { ...artifacts, base: migrated.base });
      const validated = validateHybridFoundationV2ArtifactSet(candidateDir, {
        expected_pdf_sha256: descriptor.input_sha256.pdf,
        expected_source_alignment_evidence_sha256:
          artifacts.alignment_report.input_fingerprint.source_alignment_evidence_sha256,
      });
      return { artifacts: validated, migration: migrated.summary };
    });
    const digests = candidateDirs.map(hybridFoundationArtifactSetDigest);
    if (digests[0] !== digests[1]) throw new Error("reviewed candidates are not byte-deterministic");
    if (!isDeepStrictEqual(built[0].migration, built[1].migration)) {
      throw new Error("semantic graph migration differs between reviewed candidates");
    }
    const candidate = built[0].artifacts;
    const integrityPassed = Object.values(candidate.alignment_report.integrity).every(Boolean);
    if (!integrityPassed) throw new Error("reviewed candidate integrity gate failed");
    const reasonCounts = countReasons(candidate.pdf_source_map.entries);
    const unexpectedReasons = Object.keys(reasonCounts).filter((reason) => !RELEASE_PROJECTION_REASONS.has(reason));
    if (unexpectedReasons.length) {
      throw new Error(`reviewed candidate has unknown projection reasons: ${unexpectedReasons.join(", ")}`);
    }
    const adaptation = auditHybridFoundationAdaptation({
      source,
      artifacts: candidate,
      baseline: descriptor.expected_adaptation_v1,
      lid_migration_map: migrationMap,
    });
    const coveragePassed = adaptation.coverage.matched_baseline_count === adaptation.coverage.baseline_leaf_count
      && adaptation.coverage.current_leaf_count === candidate.pdf_source_map.entries.length
      && adaptation.coverage.missing_baseline_count === 0
      && adaptation.coverage.unexpected_current_count === 0
      && adaptation.coverage.artifact_leaf_coverage_error_count === 0;
    if (!coveragePassed) throw new Error("PR8 adaptation coverage did not close on the reviewed candidate");

    const evidenceSha256 = candidate.alignment_report.input_fingerprint.source_alignment_evidence_sha256;
    if (!evidenceSha256) throw new Error("reviewed candidate did not bind source alignment evidence");
    const publication = apply && publishDir
      ? publishVersion({
        old_book_dir: oldBookDir,
        publish_dir: publishDir,
        candidate_dir: candidateDirs[0],
        migration_map_path: migrationMapPath,
        review_report_path: reviewReportPath,
        book_id: reviewReport.new_book_id,
        pdf_sha256: descriptor.input_sha256.pdf,
        evidence_sha256: evidenceSha256,
      })
      : null;
    const binding = frozenAudits.reports.binding_ownership as {
      summary: { formal_duplicate_region_binding_count: number; formal_duplicate_selection_binding_count: number };
    };
    const formula = frozenAudits.reports.formula_glyph as {
      summary: { mismatch_projected_count: number; wrong_page_count: number; wrong_column_count: number };
    };
    const image = frozenAudits.reports.image_object as {
      summary: { wrong_page_count: number; wrong_column_count: number };
    };
    const report = {
      version: "hybrid_foundation_reviewed_release_gate.v1",
      policy_version: RELEASE_CONFIG_VERSION,
      old_book_id: reviewReport.old_book_id,
      new_book_id: reviewReport.new_book_id,
      inputs: {
        old_source_sha256: reviewReport.input_fingerprint.source_sha256,
        approved_source_sha256: reviewReport.output_fingerprint.source_sha256,
        pdf_sha256: descriptor.input_sha256.pdf,
        migration_sha256: reviewReport.output_fingerprint.migration_sha256,
      },
      repeatability: {
        first_digest: digests[0],
        second_digest: digests[1],
        equal: true,
      },
      adaptation_coverage: adaptation.coverage,
      unexpected_projection_reason_count: unexpectedReasons.length,
      projection_reason_counts: reasonCounts,
      integrity: candidate.alignment_report.integrity,
      quality: candidate.alignment_report.quality,
      semantic_graph_migration: built[0].migration,
      audit_report_hashes: frozenAudits.report_hashes,
      wrong_page_column_count: formula.summary.wrong_page_count
        + formula.summary.wrong_column_count
        + image.summary.wrong_page_count
        + image.summary.wrong_column_count,
      formal_duplicate_region_binding_count: binding.summary.formal_duplicate_region_binding_count,
      formal_duplicate_selection_binding_count: binding.summary.formal_duplicate_selection_binding_count,
      material_mismatch_upgraded_count: formula.summary.mismatch_projected_count,
      publication,
      candidate_dirs: keep ? candidateDirs : null,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (!keep) rmSync(releaseRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
