import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertHybridFoundationHardGates,
  validateHybridFoundationV1ArtifactSet,
  type HybridFoundationArtifacts,
} from "../src/hybrid-foundation";
import {
  applyHybridFoundationArtifactSet,
  mergeHybridFoundationBase,
  semanticGraphDigest,
} from "../src/hybrid-foundation-apply";
import type { ReadOnlyBase } from "../src/generated/ReadOnlyBase";
import {
  AlignmentReportZ,
  PdfSelectionMapManifestZ,
  PdfSelectionMapPageShardZ,
  PdfSourceMapZ,
  ReadOnlyBaseZ,
  SourceManifestV2Z,
} from "../src/zod";

interface TempRebuildSummary {
  version: "temp_hybrid_foundation_rebuild.v1";
  book_dir: string;
  output_dir: string;
  official_core_files_unchanged: boolean;
  source_hash_verified: boolean;
  pdf_hash_verified: boolean;
  lid_identity_equal: boolean;
  gates_passed: boolean;
}

const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const FILE_ARTIFACTS = [
  "base.json",
  "source.txt",
  "source_manifest.json",
  "pdf_source_map.json",
  "alignment_report.json",
] as const;
const DIRECTORY_ARTIFACTS = ["pdf_selection_map"] as const;

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function assertInsideWorkspace(target: string, label: string): void {
  const relative = path.relative(WORKSPACE_ROOT, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of the workspace: ${target}`);
  }
}

function loadArtifacts(root: string): HybridFoundationArtifacts {
  const selectionManifest = PdfSelectionMapManifestZ.parse(readJson(path.join(root, "pdf_selection_map", "manifest.json")));
  return {
    base: ReadOnlyBaseZ.parse(readJson(path.join(root, "base.json"))),
    source_manifest: SourceManifestV2Z.parse(readJson(path.join(root, "source_manifest.json"))),
    pdf_source_map: PdfSourceMapZ.parse(readJson(path.join(root, "pdf_source_map.json"))),
    pdf_selection_map_manifest: selectionManifest,
    pdf_selection_map_pages: selectionManifest.page_shards.map((shard) =>
      PdfSelectionMapPageShardZ.parse(readJson(path.join(root, "pdf_selection_map", shard.path))),
    ),
    alignment_report: AlignmentReportZ.parse(readJson(path.join(root, "alignment_report.json"))),
  };
}

function artifactHashes(root: string, artifacts: HybridFoundationArtifacts): Record<string, string> {
  const paths = [
    ...FILE_ARTIFACTS,
    "pdf_selection_map/manifest.json",
    ...artifacts.pdf_selection_map_manifest.page_shards.map((shard) => `pdf_selection_map/${shard.path}`),
  ];
  return Object.fromEntries(paths.map((relativePath) => [
    relativePath,
    sha256(readFileSync(path.join(root, relativePath))),
  ]));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function stageCandidate(candidateDir: string, stageDir: string, mergedBase: ReadOnlyBase): void {
  mkdirSync(stageDir, { recursive: true });
  for (const relativePath of FILE_ARTIFACTS) {
    if (relativePath === "base.json") {
      writeFileSync(path.join(stageDir, relativePath), `${JSON.stringify(mergedBase, null, 2)}\n`, "utf8");
    } else {
      copyFileSync(path.join(candidateDir, relativePath), path.join(stageDir, relativePath));
    }
  }
  for (const relativePath of DIRECTORY_ARTIFACTS) {
    cpSync(path.join(candidateDir, relativePath), path.join(stageDir, relativePath), { recursive: true });
  }
}

async function main(): Promise<void> {
  const candidateDir = path.resolve(process.argv[2] ?? "");
  const bookDir = path.resolve(process.argv[3] ?? "");
  assertInsideWorkspace(candidateDir, "candidate directory");
  assertInsideWorkspace(bookDir, "book directory");
  if (!path.basename(candidateDir).startsWith(".tmp-hybrid-foundation-v2-")) {
    throw new Error(`candidate directory name is not trusted: ${candidateDir}`);
  }

  const summary = readJson<TempRebuildSummary>(path.join(candidateDir, "temp-rebuild-summary.json"));
  if (summary.version !== "temp_hybrid_foundation_rebuild.v1"
    || path.resolve(summary.book_dir) !== bookDir
    || path.resolve(summary.output_dir) !== candidateDir
    || !summary.official_core_files_unchanged
    || !summary.source_hash_verified
    || !summary.pdf_hash_verified
    || !summary.lid_identity_equal
    || !summary.gates_passed) {
    throw new Error("candidate summary does not authorize an official writeback");
  }

  const candidate = loadArtifacts(candidateDir);
  const officialBefore = loadArtifacts(bookDir);
  assertHybridFoundationHardGates(candidate);
  const mergedBase = mergeHybridFoundationBase(officialBefore.base, candidate.base);
  const expected = { ...candidate, base: mergedBase };
  assertHybridFoundationHardGates(expected);
  if (sha256(readFileSync(path.join(bookDir, candidate.source_manifest.canonical_source.path)))
    !== candidate.source_manifest.canonical_source.sha256) {
    throw new Error("official canonical source changed after the candidate rebuild");
  }
  if (sha256(readFileSync(path.join(bookDir, candidate.source_manifest.original_pdf.path)))
    !== candidate.source_manifest.original_pdf.sha256) {
    throw new Error("official PDF changed after the candidate rebuild");
  }

  const buildDir = path.join(bookDir, ".build");
  const id = timestamp();
  const stageDir = path.join(buildDir, `hybrid-foundation-candidate-${id}`);
  stageCandidate(candidateDir, stageDir, mergedBase);
  const stagedHashes = artifactHashes(stageDir, expected);
  const graphDigestBefore = semanticGraphDigest(officialBefore.base);
  let application: ReturnType<typeof applyHybridFoundationArtifactSet>;
  try {
    application = applyHybridFoundationArtifactSet({
      book_dir: bookDir,
      candidate_dir: stageDir,
      validate_artifact_set: (root) => { validateHybridFoundationV1ArtifactSet(root); },
      transaction_id: `manual-${id}`,
    });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
  const officialAfter = loadArtifacts(bookDir);
  const officialHashes = artifactHashes(bookDir, officialAfter);
  if (JSON.stringify(stagedHashes) !== JSON.stringify(officialHashes)) {
    throw new Error("official artifact hashes differ from staged artifacts");
  }
  if (semanticGraphDigest(officialAfter.base) !== graphDigestBefore) {
    throw new Error("semantic graph digest changed during hybrid foundation writeback");
  }

  const keyLids = ["2.47.23.1", "2.47.24.1"];
  const byLid = new Map(officialAfter.pdf_source_map.entries.map((entry) => [entry.lid, entry]));
  process.stdout.write(`${JSON.stringify({
    version: "hybrid_foundation_apply.v1",
    book_dir: bookDir,
    candidate_dir: candidateDir,
    transaction_id: application.transaction_id,
    backup_dir: application.backup_dir,
    applied_artifacts: [...FILE_ARTIFACTS, ...DIRECTORY_ARTIFACTS],
    hashes_match_staged: true,
    semantic_graph_preserved: true,
    semantic_graph_digest_before: graphDigestBefore,
    semantic_graph_digest_after: semanticGraphDigest(officialAfter.base),
    diagnostics: officialAfter.alignment_report.diagnostics,
    hard_gates: officialAfter.alignment_report.hard_gates,
    key_lids: keyLids.map((lid) => ({
      lid,
      status: byLid.get(lid)?.status,
      page: byLid.get(lid)?.primary_region?.pageIndex,
    })),
  }, null, 2)}\n`);
}

await main();
