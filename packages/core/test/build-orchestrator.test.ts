import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  nextAutomaticBuildAction,
  buildAutomaticBuildSnapshot,
  resolveAutomaticBuildTarget,
  type AutomaticBuildTarget,
  type AutomaticBuildSnapshot,
} from "../src/build-orchestrator";
import { buildSourceManifestV2 } from "../src/source-manifest";
import { emptyReconciliationSummary, sha256Text } from "../src/source-reconciliation";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";
import { buildPass1Artifact } from "../src/build-resume";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy, buildSemanticArtifactEnvelope } from "../src/semantic-artifact";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-orchestrator-"));
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function pass1Envelope(target: AutomaticBuildTarget, taskId: number, payload: { content_hash: string; nodes: unknown[]; edges: unknown[] }) {
  return buildSemanticArtifactEnvelope({
    target: target.target_ref,
    stage: "pass1",
    work_unit_id: String(taskId),
    input_hash: payload.content_hash,
    policy_fingerprint: automaticBuildExtractionPolicy("pass1", resolveContentProfile(target.profile_id), "full"),
    provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
    payload,
  });
}

function writeTrustedPaperWorkspace(root: string, bookId = "paper-a"): string {
  const dir = path.join(root, ".understand-book", bookId);
  const source = "# Abstract\n\nThis paper studies Softmax Attention retrieval.\n\n# Discussion\n\nThe Softmax Attention comparison continues here.\n";
  const draftSource = "# Abstract\n\nThis paper studies Softmax Attention retrieval with OCR noise.\n\n# Discussion\n\nThe Softmax Attention comparison continues here.\n";
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.txt"), source, "utf8");
  writeFileSync(path.join(dir, "paper.md"), draftSource, "utf8");
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
    input_fingerprint: { paper_md_sha256: sha256Text(draftSource), paper_pdf_sha256: "sha-pdf", config_hash: "cfg-a" },
    summary: { ...emptyReconciliationSummary(), verified: 1 },
    unresolved: [],
  });
  writeJson(path.join(dir, ".build", "input", "manifest.json"), {
    version: "workbench_input_manifest.v1",
    book_id: bookId,
    profile_id: "paper",
    fingerprint: { paper_md_sha256: sha256Text(draftSource), paper_pdf_sha256: "sha-pdf", config_hash: "cfg-a" },
    inputs: { paper_md: { path: "paper.md", original_path: null, sha256: sha256Text(draftSource) }, paper_pdf: { path: "paper.pdf", original_path: null, sha256: "sha-pdf" } },
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
      target_ref: {
        version: "build_target_ref.v2",
        workspace_dir: path.resolve(workspace),
        book_id: "paper-a",
        profile_id: "paper",
        input_fingerprint: expect.any(String),
      },
    });
  });

  it("resolves a reconciled source.txt back to its trusted paper workspace", () => {
    const root = tempDir();
    const workspace = writeTrustedPaperWorkspace(root);

    expect(resolveAutomaticBuildTarget(path.join(workspace, "source.txt"), root)).toMatchObject({
      kind: "paper_workspace",
      book_id: "paper-a",
      profile_id: "paper",
      workspace_dir: path.resolve(workspace),
      source_path: path.join(path.resolve(workspace), "source.txt"),
    });
  });

  it("fails closed for an untrusted source.txt inside a build workspace", () => {
    const root = tempDir();
    const source = path.join(root, ".understand-book", "orphan", "source.txt");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "# Orphan\n", "utf8");

    expect(() => resolveAutomaticBuildTarget(source, root)).toThrow("Workbench input manifest");
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
      target: { kind: "paper_workspace", profile_id: "paper", book_id: "paper-a", root_dir: "C:/repo", workspace_dir: "C:/repo/.understand-book/paper-a", source_path: "C:/repo/.understand-book/paper-a/source.txt", target_ref: { version: "build_target_ref.v2", workspace_dir: "C:/repo/.understand-book/paper-a", book_id: "paper-a", profile_id: "paper", input_fingerprint: "paper-fingerprint" } },
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
      target: { kind: "source_file", profile_id: "technical_learning", book_id: "guide", root_dir: "C:/repo", workspace_dir: "C:/repo/.understand-book/guide", source_path: "C:/repo/guide.md", target_ref: { version: "build_target_ref.v2", workspace_dir: "C:/repo/.understand-book/guide", book_id: "guide", profile_id: "technical_learning", input_fingerprint: "source-fingerprint" } },
      stages: [{ stage: "pass1", pending_tasks: [], closed: false }],
    };

    expect(nextAutomaticBuildAction(snapshot)).toEqual({ kind: "close_stage", stage: "pass1" });
  });

  it("reopens Pass1 when fresh artifacts disagree with the closed base graph", () => {
    const root = tempDir();
    const workspace = writeTrustedPaperWorkspace(root);
    const sourcePath = path.join(workspace, "source.txt");
    const source = readFileSync(sourcePath, "utf8");
    const lidNodes = segment(markdownToBlocks(source));
    const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
    const windows = splitWindows(lidNodes, source);
    const profile = resolveContentProfile("paper");
    const target = resolveAutomaticBuildTarget(workspace, root);
    const anchorLid = lidNodes.find((node) => node.children.length === 0)!.lid;
    for (const window of windows) {
      writeJson(
        path.join(workspace, ".build", "pass1", `${window.id}.json`),
        pass1Envelope(target, window.id, buildPass1Artifact(window, byLid, source, {
          nodes: window.id === windows[0].id ? [{
            id: "concept:retrieval",
            type: "concept",
            name: "retrieval",
            occurrences: [anchorLid],
            source_lid: null,
          }] : [],
          edges: [],
        }, profile)),
      );
    }
    writeJson(path.join(workspace, "base.json"), {
      book_id: "paper-a",
      lid_nodes: lidNodes,
      graph_nodes: [],
      graph_edges: [],
    });
    writeJson(path.join(workspace, "profile_metadata.json"), {
      header: { book_id: "paper-a", profile_id: "paper" },
    });
    writeJson(path.join(workspace, "long_range_candidates.json"), { candidates: [] });

    const snapshot = buildAutomaticBuildSnapshot(target);

    expect(snapshot.stages).toMatchObject([{
      stage: "pass1",
      pending_tasks: [],
      pending_work_units: [],
      closed: false,
    }]);
    expect(snapshot.stages[0].work_units?.[0]).toMatchObject({
      version: "automatic_build_work_unit.v2",
      work_unit_id: "0",
      kind: "pass1_window",
    });
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
    const target = resolveAutomaticBuildTarget(workspace, root);
    for (const window of windows) {
      writeJson(
        path.join(workspace, ".build", "pass1", `${window.id}.json`),
        pass1Envelope(target, window.id, buildPass1Artifact(window, byLid, source, { nodes: [], edges: [] }, profile)),
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
    const metadataSnapshot = buildAutomaticBuildSnapshot(target);
    const metadataStage = metadataSnapshot.stages.find((stage) => stage.stage === "paper_metadata")!;
    expect(metadataStage.work_units).toHaveLength(2);
    expect(metadataStage.work_units?.[1]).toMatchObject({
      work_unit_id: "1",
      deterministic_skip: { code: "no_metadata_signal" },
      policy_fingerprint: { router_version: "paper_metadata_candidate.v2" },
    });
    expect(metadataStage.pending_work_units?.map((unit) => unit.work_unit_id)).toEqual(["0"]);
    expect(nextAutomaticBuildAction(metadataSnapshot)).toMatchObject({
      kind: "extract",
      stage: "paper_metadata",
      extractor: "paper-metadata-extractor",
      task_ids: ["0"],
      work_units: [{ work_unit_id: "0" }],
    });

    const metadataUnit = metadataStage.pending_work_units![0];
    writeJson(path.join(workspace, ".build", "paper-metadata", `${metadataUnit.work_unit_id}.json`), buildSemanticArtifactEnvelope({
      target: target.target_ref,
      stage: "paper_metadata",
      work_unit_id: metadataUnit.work_unit_id,
      input_hash: metadataUnit.input_hash,
      policy_fingerprint: metadataUnit.policy_fingerprint,
      provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
      payload: { content_hash: metadataUnit.input_hash, metadata: {} },
    }));
    writeJson(path.join(workspace, "paper_metadata.json"), { header: { book_id: target.book_id, profile_id: "paper" } });

    const lexiconSnapshot = buildAutomaticBuildSnapshot(target);
    const lexiconStage = lexiconSnapshot.stages.find((stage) => stage.stage === "paper_lexicon")!;
    expect(lexiconStage.pending_work_units?.length).toBeGreaterThan(0);
    expect(lexiconStage.pending_work_units?.every((unit) => unit.work_unit_id.startsWith("lexicon-batch-"))).toBe(true);
    expect(lexiconStage.work_units?.filter((unit) => unit.deterministic_skip)
      .every((unit) => !lexiconStage.pending_tasks.includes(unit.work_unit_id))).toBe(true);
    expect(nextAutomaticBuildAction(lexiconSnapshot)).toMatchObject({
      kind: "extract",
      stage: "paper_lexicon",
      task_ids: lexiconStage.pending_tasks,
    });

    for (const unit of lexiconStage.pending_work_units ?? []) {
      writeJson(path.join(workspace, ".build", "paper-lexicon", `${unit.work_unit_id}.json`), buildSemanticArtifactEnvelope({
        target: target.target_ref,
        stage: "paper_lexicon",
        work_unit_id: unit.work_unit_id,
        input_hash: unit.input_hash,
        policy_fingerprint: unit.policy_fingerprint,
        provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
        payload: { content_hash: unit.input_hash, entries: [] },
      }));
    }
    writeJson(path.join(workspace, "paper_lexicon.json"), { header: { book_id: target.book_id, profile_id: "paper" }, entries: [] });

    const sidecarSnapshot = buildAutomaticBuildSnapshot(target);
    const sidecarStage = sidecarSnapshot.stages.find((stage) => stage.stage === "profile_sidecar")!;
    expect(sidecarStage.pending_work_units?.length).toBeGreaterThan(0);
    expect(sidecarStage.pending_work_units?.every((unit) => unit.kind === "profile_sidecar_discourse")).toBe(true);
    expect(sidecarStage.work_units?.some((unit) => unit.kind === "profile_sidecar_formula" && unit.deterministic_skip?.code === "no_formula_in_window")).toBe(true);
    expect(sidecarStage.work_units?.filter((unit) => unit.deterministic_skip)
      .every((unit) => !sidecarStage.pending_tasks.includes(unit.work_unit_id))).toBe(true);
    expect(nextAutomaticBuildAction(sidecarSnapshot)).toMatchObject({
      kind: "extract",
      stage: "profile_sidecar",
      task_ids: sidecarStage.pending_tasks,
    });
  });
});
