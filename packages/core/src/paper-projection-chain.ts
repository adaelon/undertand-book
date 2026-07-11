import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SourceManifestV2Z, SourceReconciliationReportZ } from "./zod";
import type { SourceManifestV2 } from "./source-manifest";
import {
  sha256Text,
  sourceReconciliationAccepted,
  type SourceReconciliationReport,
} from "./source-reconciliation";

export type PaperProjectionStageId =
  | "paper_metadata"
  | "paper_lexicon"
  | "profile_sidecar"
  | "pass2"
  | "book_structure"
  | "paper_reading_guide";

export type PaperProjectionStageKind = "build_batch" | "projection_verification";

export interface PaperProjectionChainStage {
  stage: PaperProjectionStageId;
  kind: PaperProjectionStageKind;
  command: string;
  args: string[];
  required_inputs: string[];
  output_paths: string[];
  uses_trusted_source: true;
  projection_only: true;
  may_update_source_truth: false;
  allow_partial_supported: boolean;
}

export interface PaperProjectionChainPlan {
  version: "paper_projection_chain_plan.v1";
  book_id: string;
  book_dir: string;
  trusted_source_path: string;
  trusted_source_sha256: string;
  paper_subtype: "research_article" | "survey";
  source_truth_locked: true;
  projection_failures_do_not_update_source: true;
  stages: PaperProjectionChainStage[];
  warnings: string[];
}

export interface BuildPaperProjectionChainPlanOptions {
  allow_partial?: boolean;
  paper_subtype?: "research_article" | "survey";
}

export interface TrustedPaperProjectionSource {
  book_id: string;
  book_dir: string;
  trusted_source_path: string;
  trusted_source_sha256: string;
  source_manifest: SourceManifestV2;
  source_reconciliation_report: SourceReconciliationReport;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function normalizeBookDir(bookDir: string): string {
  return path.resolve(bookDir);
}

function requireFile(file: string, label: string): void {
  if (!existsSync(file)) throw new Error(`${label} missing: ${file}`);
}

function batchStage(
  stage: Exclude<PaperProjectionStageId, "paper_reading_guide">,
  script: string,
  sourcePath: string,
  bookId: string,
  paperSubtype: "research_article" | "survey",
  allowPartial: boolean,
  requiredInputs: string[],
  outputPaths: string[],
  allowPartialSupported: boolean,
): PaperProjectionChainStage {
  const args = [
    "exec",
    "tsx",
    script,
    sourcePath,
    "--book-id",
    bookId,
    "--content-profile",
    "paper",
    "--paper-subtype",
    paperSubtype,
  ];
  if (allowPartial && allowPartialSupported) args.push("--allow-partial");
  return {
    stage,
    kind: "build_batch",
    command: "pnpm",
    args,
    required_inputs: requiredInputs,
    output_paths: outputPaths,
    uses_trusted_source: true,
    projection_only: true,
    may_update_source_truth: false,
    allow_partial_supported: allowPartialSupported,
  };
}

export function assertTrustedPaperProjectionSource(bookDirInput: string): TrustedPaperProjectionSource {
  const bookDir = normalizeBookDir(bookDirInput);
  const sourcePath = path.join(bookDir, "source.txt");
  const manifestPath = path.join(bookDir, "source_manifest.json");
  const reportPath = path.join(bookDir, ".build", "source-reconciliation", "report.json");
  const basePath = path.join(bookDir, "base.json");

  requireFile(sourcePath, "trusted source.txt");
  requireFile(manifestPath, "source_manifest.json");
  requireFile(basePath, "base.json");
  requireFile(reportPath, "source reconciliation report");

  const source = readFileSync(sourcePath, "utf8");
  const sourceSha256 = sha256Text(source);
  const sourceManifest = SourceManifestV2Z.parse(readJson<unknown>(manifestPath)) as SourceManifestV2;
  if (sourceManifest.canonical_source.kind !== "reconciled_markdown") {
    throw new Error("paper projection requires source_manifest.v2 canonical_source.kind=reconciled_markdown");
  }
  if (sourceManifest.canonical_source.path !== "source.txt") {
    throw new Error("paper projection requires source_manifest.v2 canonical_source.path=source.txt");
  }
  if (sourceManifest.canonical_source.citation_anchor !== "lid") {
    throw new Error("paper projection requires LID citation anchors");
  }
  if (sourceManifest.canonical_source.sha256 !== sourceSha256) {
    throw new Error("source_manifest canonical source hash does not match source.txt");
  }

  const report = SourceReconciliationReportZ.parse(readJson<unknown>(reportPath)) as SourceReconciliationReport;
  if (report.book_id !== sourceManifest.book_id) {
    throw new Error(`source reconciliation report book_id ${report.book_id} does not match source_manifest book_id ${sourceManifest.book_id}`);
  }
  if (!sourceReconciliationAccepted(report)) {
    throw new Error("source reconciliation report still has unresolved blocks");
  }

  return {
    book_id: sourceManifest.book_id,
    book_dir: bookDir,
    trusted_source_path: sourcePath,
    trusted_source_sha256: sourceSha256,
    source_manifest: sourceManifest,
    source_reconciliation_report: report,
  };
}

export function buildPaperProjectionChainPlan(
  bookDir: string,
  options: BuildPaperProjectionChainPlanOptions = {},
): PaperProjectionChainPlan {
  const trusted = assertTrustedPaperProjectionSource(bookDir);
  const paperSubtype = options.paper_subtype ?? "research_article";
  const allowPartial = options.allow_partial ?? false;
  const sourcePath = trusted.trusted_source_path;
  const bookRoot = trusted.book_dir;
  const buildRoot = path.join(bookRoot, ".build");
  const commonRequired = [sourcePath, path.join(bookRoot, "base.json"), path.join(bookRoot, "source_manifest.json")];

  const stages: PaperProjectionChainStage[] = [
    batchStage(
      "paper_metadata",
      "skills/build/paper-metadata-batch.ts",
      sourcePath,
      trusted.book_id,
      paperSubtype,
      allowPartial,
      commonRequired,
      [path.join(bookRoot, "paper_metadata.json")],
      true,
    ),
    batchStage(
      "paper_lexicon",
      "skills/build/paper-lexicon-batch.ts",
      sourcePath,
      trusted.book_id,
      paperSubtype,
      allowPartial,
      commonRequired,
      [path.join(bookRoot, "paper_lexicon.json")],
      true,
    ),
    batchStage(
      "profile_sidecar",
      "skills/build/profile-sidecar-batch.ts",
      sourcePath,
      trusted.book_id,
      paperSubtype,
      allowPartial,
      commonRequired,
      [path.join(bookRoot, "discourse_index.json"), path.join(bookRoot, "formula_semantics.json")],
      true,
    ),
    batchStage(
      "pass2",
      "skills/build/pass2-batch.ts",
      sourcePath,
      trusted.book_id,
      paperSubtype,
      allowPartial,
      [...commonRequired, path.join(bookRoot, "discourse_index.json"), path.join(bookRoot, "formula_semantics.json")],
      [path.join(bookRoot, "long_range_candidates.json"), path.join(bookRoot, "base.json"), path.join(bookRoot, "pass2_audit.json")],
      true,
    ),
    batchStage(
      "book_structure",
      "skills/build/book-structure-batch.ts",
      sourcePath,
      trusted.book_id,
      paperSubtype,
      allowPartial,
      [
        ...commonRequired,
        path.join(bookRoot, "discourse_index.json"),
        path.join(bookRoot, "formula_semantics.json"),
        path.join(bookRoot, "pass2_audit.json"),
        path.join(buildRoot, "book-structure"),
      ],
      [path.join(bookRoot, "book_structure.json")],
      false,
    ),
    {
      stage: "paper_reading_guide",
      kind: "projection_verification",
      command: "pnpm",
      args: ["exec", "tsx", "skills/build/verify-paper-reading-guide.ts", bookRoot],
      required_inputs: [
        sourcePath,
        path.join(bookRoot, "base.json"),
        path.join(bookRoot, "paper_metadata.json"),
        path.join(bookRoot, "paper_lexicon.json"),
        path.join(bookRoot, "book_structure.json"),
      ],
      output_paths: [],
      uses_trusted_source: true,
      projection_only: true,
      may_update_source_truth: false,
      allow_partial_supported: false,
    },
  ];

  return {
    version: "paper_projection_chain_plan.v1",
    book_id: trusted.book_id,
    book_dir: trusted.book_dir,
    trusted_source_path: sourcePath,
    trusted_source_sha256: trusted.trusted_source_sha256,
    paper_subtype: paperSubtype,
    source_truth_locked: true,
    projection_failures_do_not_update_source: true,
    stages,
    warnings: [
      "Paper projection stages consume source.txt and may update sidecars/base long_range edges, but they must not rewrite source.txt or source_manifest canonical source truth.",
      "BookStructure and PaperReadingGuide are projections; failures route back to Build Workbench and do not invalidate the trusted source foundation.",
    ],
  };
}

export function assertPaperProjectionWorkspaceTarget(plan: Pick<PaperProjectionChainPlan, "book_id" | "book_dir">, workspaceRoot = process.cwd()): void {
  const expected = path.resolve(workspaceRoot, ".understand-book", plan.book_id);
  if (path.resolve(plan.book_dir) !== expected) {
    throw new Error(
      `paper projection batch scripts write to .understand-book/${plan.book_id}; run --run only for that workspace book dir (got ${plan.book_dir})`,
    );
  }
}
