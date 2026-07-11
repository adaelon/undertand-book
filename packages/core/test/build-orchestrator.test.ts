import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  nextAutomaticBuildAction,
  buildAutomaticBuildSnapshot,
  resolveAutomaticBuildTarget,
  type AutomaticBuildSnapshot,
} from "../src/build-orchestrator";
import { buildSourceManifestV2 } from "../src/source-manifest";
import { emptyReconciliationSummary, sha256Text } from "../src/source-reconciliation";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";
import { buildPass1Artifact } from "../src/build-resume";
import { resolveContentProfile } from "../src/content-profile";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-orchestrator-"));
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function writeTrustedPaperWorkspace(root: string, bookId = "paper-a"): string {
  const dir = path.join(root, ".understand-book", bookId);
  const source = "# Abstract\n\nThis paper studies retrieval.\n";
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.txt"), source, "utf8");
  writeFileSync(path.join(dir, "paper.md"), source, "utf8");
  writeFileSync(path.join(dir, "paper.pdf"), "pdf", "utf8");
  writeJson(path.join(dir, "base.json"), { book_id: bookId, lid_nodes: [], graph_nodes: [], graph_edges: [] });
  writeJson(path.join(dir, "source_manifest.json"), buildSourceManifestV2({
    book_id: bookId,
    source_sha256: sha256Text(source),
    original_pdf_path: "paper.pdf",
    original_pdf_sha256: "sha-pdf",
    pdf_source_map_path: "pdf_source_map.json",
    pdf_selection_map_manifest_path: "pdf_selection_map/manifest.json",
    alignment_report_path: "alignment_report.json",
    config_hash: "cfg-a",
  }));
  writeJson(path.join(dir, ".build", "source-reconciliation", "report.json"), {
    version: "source_reconciliation_report.v1",
    book_id: bookId,
    input_fingerprint: { paper_md_sha256: sha256Text(source), paper_pdf_sha256: "sha-pdf", config_hash: "cfg-a" },
    summary: { ...emptyReconciliationSummary(), verified: 1 },
    unresolved: [],
  });
  writeJson(path.join(dir, ".build", "input", "manifest.json"), {
    version: "workbench_input_manifest.v1",
    book_id: bookId,
    profile_id: "paper",
    inputs: { paper_md: { path: "paper.md", original_path: null, sha256: sha256Text(source) }, paper_pdf: { path: "paper.pdf", original_path: null, sha256: "sha-pdf" } },
  });
  return dir;
}

describe("automatic build orchestrator", () => {
  it("resolves an explicit trusted paper workspace and starts after the foundation", () => {
    const root = tempDir();
    const workspace = writeTrustedPaperWorkspace(root);

    expect(resolveAutomaticBuildTarget(workspace, root)).toMatchObject({
      kind: "paper_workspace",
      book_id: "paper-a",
      profile_id: "paper",
      root_dir: path.resolve(root),
      workspace_dir: path.resolve(workspace),
      source_path: path.join(path.resolve(workspace), "source.txt"),
    });
  });

  it("rejects a paper workspace whose trusted foundation is incomplete", () => {
    const root = tempDir();
    const workspace = path.join(root, ".understand-book", "paper-b");
    mkdirSync(workspace, { recursive: true });
    writeJson(path.join(workspace, ".build", "input", "manifest.json"), { profile_id: "paper", book_id: "paper-b" });

    expect(() => resolveAutomaticBuildTarget(workspace, root)).toThrow("可信混合阅读基座");
  });

  it("finds a trusted paper workspace by a unique input sha256", () => {
    const root = tempDir();
    const workspace = writeTrustedPaperWorkspace(root);
    const sourceCopy = path.join(root, "incoming-paper.md");
    writeFileSync(sourceCopy, readFileSync(path.join(workspace, "paper.md")));

    expect(resolveAutomaticBuildTarget(sourceCopy, root)).toMatchObject({
      kind: "paper_workspace",
      book_id: "paper-a",
      workspace_dir: path.resolve(workspace),
    });
  });

  it("selects only the first unfinished stage and batches pending semantic tasks", () => {
    const snapshot: AutomaticBuildSnapshot = {
      target: { kind: "paper_workspace", profile_id: "paper", book_id: "paper-a", root_dir: "C:/repo", workspace_dir: "C:/repo/.understand-book/paper-a", source_path: "C:/repo/.understand-book/paper-a/source.txt" },
      stages: [
        { stage: "pass1", pending_tasks: [], closed: true },
        { stage: "paper_metadata", pending_tasks: ["2", "4", "8", "9", "10", "11"], closed: false },
        { stage: "paper_lexicon", pending_tasks: ["1"], closed: false },
      ],
    };

    expect(nextAutomaticBuildAction(snapshot, 5)).toEqual({
      kind: "extract",
      stage: "paper_metadata",
      extractor: "paper-metadata-extractor",
      task_ids: ["2", "4", "8", "9", "10"],
      max_attempts: 3,
    });
  });

  it("closes a stage only after every semantic task passes", () => {
    const snapshot: AutomaticBuildSnapshot = {
      target: { kind: "source_file", profile_id: "technical_learning", book_id: "guide", root_dir: "C:/repo", workspace_dir: "C:/repo/.understand-book/guide", source_path: "C:/repo/guide.md" },
      stages: [{ stage: "pass1", pending_tasks: [], closed: false }],
    };

    expect(nextAutomaticBuildAction(snapshot)).toEqual({ kind: "close_stage", stage: "pass1" });
  });

  it("paper Pass1 close preserves the trusted foundation manifest and PDF maps", () => {
    const root = tempDir();
    const workspace = writeTrustedPaperWorkspace(root);
    const sourcePath = path.join(workspace, "source.txt");
    const source = readFileSync(sourcePath, "utf8");
    const lidNodes = segment(markdownToBlocks(source));
    const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
    const windows = splitWindows(lidNodes, source);
    const profile = resolveContentProfile("paper");
    for (const window of windows) {
      writeJson(
        path.join(workspace, ".build", "pass1", `${window.id}.json`),
        buildPass1Artifact(window, byLid, source, { nodes: [], edges: [] }, profile),
      );
    }
    writeFileSync(path.join(workspace, "pdf_source_map.json"), "map-sentinel", "utf8");
    const manifestBefore = readFileSync(path.join(workspace, "source_manifest.json"), "utf8");
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repoRoot, "skills", "build", "pass1-batch.ts"),
        sourcePath,
        "--book-id", "paper-a",
        "--content-profile", "paper",
        "--paper-subtype", "research_article",
        "--preserve-foundation", workspace,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(workspace, "source_manifest.json"), "utf8")).toBe(manifestBefore);
    expect(readFileSync(path.join(workspace, "pdf_source_map.json"), "utf8")).toBe("map-sentinel");
    expect(JSON.parse(manifestBefore).canonical_source.kind).toBe("reconciled_markdown");
    const target = resolveAutomaticBuildTarget(workspace, root);
    expect(nextAutomaticBuildAction(buildAutomaticBuildSnapshot(target))).toMatchObject({
      kind: "extract",
      stage: "paper_metadata",
      extractor: "paper-metadata-extractor",
    });
  });
});
