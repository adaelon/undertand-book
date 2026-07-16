import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { semanticGraphDigest } from "../src/hybrid-foundation-apply";
import { buildPaperSemanticGraphRecovery } from "../src/paper-semantic-graph-recovery";
import type { LongRangeCandidateIndex, Pass2BuildAuditSidecar } from "../src/pass2-build";
import {
  Pass2BuildAuditSidecarZ,
  PdfSelectionMapManifestZ,
  ReadOnlyBaseZ,
  SourceManifestV2Z,
} from "../src/zod";

const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const RECOVERY_FILES = ["base.json", "long_range_candidates.json", "pass2_audit.json"] as const;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertWorkspaceChild(target: string, label: string): void {
  const relative = path.relative(WORKSPACE_ROOT, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of the workspace: ${target}`);
  }
}

function artifactPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`artifact path escapes its book directory: ${relativePath}`);
  }
  if (!existsSync(resolved)) throw new Error(`required artifact is missing: ${resolved}`);
  return resolved;
}

function immutableArtifactPaths(root: string): string[] {
  const manifest = SourceManifestV2Z.parse(readJson(artifactPath(root, "source_manifest.json")));
  const selection = PdfSelectionMapManifestZ.parse(
    readJson(artifactPath(root, "pdf_selection_map/manifest.json")),
  );
  return [
    manifest.canonical_source.path,
    "source_manifest.json",
    ...(manifest.original_pdf ? [manifest.original_pdf.path] : []),
    "pdf_source_map.json",
    "alignment_report.json",
    ".build/source-reconciliation/report.json",
    "pdf_selection_map/manifest.json",
    ...selection.page_shards.map((shard) => `pdf_selection_map/${shard.path}`),
  ];
}

function immutableHashes(root: string): Record<string, string> {
  return Object.fromEntries(immutableArtifactPaths(root).map((relativePath) => [
    relativePath,
    sha256File(artifactPath(root, relativePath)),
  ]));
}

function assertSameImmutableArtifacts(officialDir: string, candidateDir: string): Record<string, string> {
  const official = immutableHashes(officialDir);
  const candidate = immutableHashes(candidateDir);
  if (JSON.stringify(official) !== JSON.stringify(candidate)) {
    throw new Error("candidate source/PDF/foundation artifact hashes differ from the official book");
  }
  return official;
}

function loadCandidateIndex(root: string): LongRangeCandidateIndex {
  const value = readJson(artifactPath(root, "long_range_candidates.json"));
  if (!value || typeof value !== "object" || !Array.isArray((value as { candidates?: unknown }).candidates)) {
    throw new Error("long_range_candidates.json does not contain a candidates array");
  }
  return value as LongRangeCandidateIndex;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function replaceWithRollback(
  officialDir: string,
  stageDir: string,
  backupDir: string,
  validate: () => void,
): void {
  const originalsMoved: string[] = [];
  const candidatesMoved: string[] = [];
  mkdirSync(backupDir, { recursive: true });
  try {
    for (const relativePath of RECOVERY_FILES) {
      renameSync(artifactPath(officialDir, relativePath), path.join(backupDir, relativePath));
      originalsMoved.push(relativePath);
    }
    for (const relativePath of RECOVERY_FILES) {
      renameSync(artifactPath(stageDir, relativePath), path.join(officialDir, relativePath));
      candidatesMoved.push(relativePath);
    }
    validate();
  } catch (error) {
    for (const relativePath of candidatesMoved.reverse()) {
      const applied = path.join(officialDir, relativePath);
      if (existsSync(applied)) renameSync(applied, path.join(stageDir, relativePath));
    }
    for (const relativePath of originalsMoved.reverse()) {
      const backup = path.join(backupDir, relativePath);
      if (existsSync(backup)) renameSync(backup, path.join(officialDir, relativePath));
    }
    throw error;
  }
  rmdirSync(stageDir);
}

function main(): void {
  const candidateDir = path.resolve(process.argv[2] ?? "");
  const officialDir = path.resolve(process.argv[3] ?? "");
  const mode = process.argv[4];
  if (!process.argv[2] || !process.argv[3] || !["--check", "--apply"].includes(mode)) {
    throw new Error("usage: apply-paper-semantic-graph-recovery <candidate-book-dir> <official-book-dir> --check|--apply");
  }
  assertWorkspaceChild(candidateDir, "candidate book directory");
  assertWorkspaceChild(officialDir, "official book directory");
  if (candidateDir === officialDir) throw new Error("candidate and official book directories must differ");

  const immutableBefore = assertSameImmutableArtifacts(officialDir, candidateDir);
  const official = ReadOnlyBaseZ.parse(readJson(artifactPath(officialDir, "base.json")));
  const candidate = ReadOnlyBaseZ.parse(readJson(artifactPath(candidateDir, "base.json")));
  const audit = Pass2BuildAuditSidecarZ.parse(
    readJson(artifactPath(candidateDir, "pass2_audit.json")),
  ) as Pass2BuildAuditSidecar;
  const candidateIndex = loadCandidateIndex(candidateDir);
  const recovery = buildPaperSemanticGraphRecovery(official, candidate, audit);
  const baseDigestBefore = semanticGraphDigest(official);
  const lidFoundationDigest = sha256Json(official.lid_nodes);

  let backupDir: string | null = null;
  if (mode === "--apply") {
    const id = timestamp();
    const buildDir = path.join(officialDir, ".build");
    const stageDir = path.join(buildDir, `paper-semantic-graph-recovery-stage-${id}`);
    backupDir = path.join(buildDir, `paper-semantic-graph-recovery-backup-${id}`);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(path.join(stageDir, "base.json"), `${JSON.stringify(recovery.base, null, 2)}\n`, "utf8");
    copyFileSync(
      artifactPath(candidateDir, "long_range_candidates.json"),
      path.join(stageDir, "long_range_candidates.json"),
    );
    copyFileSync(artifactPath(candidateDir, "pass2_audit.json"), path.join(stageDir, "pass2_audit.json"));

    const stagedHashes = Object.fromEntries(RECOVERY_FILES.map((relativePath) => [
      relativePath,
      sha256File(artifactPath(stageDir, relativePath)),
    ]));
    replaceWithRollback(officialDir, stageDir, backupDir, () => {
      const officialAfter = ReadOnlyBaseZ.parse(readJson(artifactPath(officialDir, "base.json")));
      const auditAfter = Pass2BuildAuditSidecarZ.parse(
        readJson(artifactPath(officialDir, "pass2_audit.json")),
      ) as Pass2BuildAuditSidecar;
      loadCandidateIndex(officialDir);
      const verified = buildPaperSemanticGraphRecovery(official, officialAfter, auditAfter);
      if (verified.semantic_graph_digest !== recovery.semantic_graph_digest) {
        throw new Error("applied semantic graph digest differs from the validated candidate");
      }
      if (sha256Json(officialAfter.lid_nodes) !== lidFoundationDigest) {
        throw new Error("official LID foundation changed during semantic graph recovery");
      }
      const appliedHashes = Object.fromEntries(RECOVERY_FILES.map((relativePath) => [
        relativePath,
        sha256File(artifactPath(officialDir, relativePath)),
      ]));
      if (JSON.stringify(appliedHashes) !== JSON.stringify(stagedHashes)) {
        throw new Error("applied recovery artifacts differ from the staged files");
      }
      if (JSON.stringify(immutableHashes(officialDir)) !== JSON.stringify(immutableBefore)) {
        throw new Error("source/PDF/foundation artifacts changed during semantic graph recovery");
      }
    });
  }

  process.stdout.write(`${JSON.stringify({
    version: "paper_semantic_graph_recovery.v1",
    mode: mode.slice(2),
    candidate_dir: candidateDir,
    official_dir: officialDir,
    backup_dir: backupDir,
    foundation_files_verified: Object.keys(immutableBefore).length,
    lid_foundation_digest: lidFoundationDigest,
    semantic_graph_digest_before: baseDigestBefore,
    semantic_graph_digest_after: recovery.semantic_graph_digest,
    graph_nodes: recovery.graph_nodes,
    graph_edges: recovery.graph_edges,
    local_edges: recovery.local_edges,
    long_range_edges: recovery.long_range_edges,
    accepted_edges: recovery.accepted_edges,
    long_range_candidates: candidateIndex.candidates.length,
  }, null, 2)}\n`);
}

main();
