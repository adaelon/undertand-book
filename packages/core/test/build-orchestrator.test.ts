import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
import { buildSourceManifest, buildSourceManifestV2 } from "../src/source-manifest";
import { emptyReconciliationSummary, sha256Text } from "../src/source-reconciliation";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";
import { buildPass1Artifact } from "../src/build-resume";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy, buildSemanticArtifactEnvelope } from "../src/semantic-artifact";
import {
  buildPaperLexiconCandidateArtifact,
  routePaperLexiconWorkUnits,
} from "../src/paper-lexicon-router";
import { freezeAutomaticBuildStagePolicySet } from "../src/automatic-build-policy-generation";
import {
  collectAutomaticBuildStageQuality,
  writeAutomaticBuildStageQualityReport,
} from "../src/automatic-build-quality";
import { freezePass1ShadowTask } from "../src/pass1-reduction";
import {
  freezeProfileSidecarSemanticFastPathTask,
  writeProfileSidecarSemanticFastPathCandidate,
} from "../src/profile-sidecar-reduction";
import { writePass1ProductionTaskArtifact } from "./helpers/model-input-routability-fixture";

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

function closeV3Pass1(target: AutomaticBuildTarget): void {
  let stage: ReturnType<typeof buildAutomaticBuildSnapshot>["stages"][number] | undefined;
  for (let round = 0; round < 8; round += 1) {
    stage = buildAutomaticBuildSnapshot(target).stages.find((candidate) => candidate.stage === "pass1");
    if (!stage?.policy_set) throw new Error("expected a production Pass1 policy set");
    if (!stage.pending_work_units?.length) break;
    freezeAutomaticBuildStagePolicySet(target, stage.policy_set);
    for (const unit of stage.pending_work_units) {
      const generation = stage.generation_tasks?.[unit.work_unit_id];
      if (generation?.kind !== "pass1") {
        throw new Error(`missing production Pass1 task: ${unit.work_unit_id}`);
      }
      freezePass1ShadowTask(target, generation.task);
      writePass1ProductionTaskArtifact({
        target,
        policy_set_digest: stage.policy_set.policy_set_digest,
        work_unit_id: unit.work_unit_id,
        marker: "Orchestrator v3 close fixture",
        generated_at: `2026-08-04T02:0${round}:00.000Z`,
      });
    }
  }
  stage = buildAutomaticBuildSnapshot(target).stages.find((candidate) => candidate.stage === "pass1");
  if (!stage?.policy_set || stage.pending_tasks.length) {
    throw new Error("production Pass1 fixture did not reach its close boundary");
  }
  const report = collectAutomaticBuildStageQuality(target, stage, "full");
  expect(report.gate_status).toBe("passed");
  writeAutomaticBuildStageQualityReport(target, report);
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const args = [
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "skills", "build", "pass1-batch.ts"),
    target.source_path,
    "--book-id", target.book_id,
    "--content-profile", target.profile_id,
    "--production-generation", stage.policy_set.policy_set_digest,
  ];
  if (target.profile_id === "paper") {
    args.push(
      "--paper-subtype", "research_article",
      "--preserve-foundation", target.workspace_dir,
    );
  }
  const result = spawnSync(process.execPath, args, { cwd: target.root_dir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function closeV3ProfileSidecar(target: AutomaticBuildTarget): void {
  let stage: ReturnType<typeof buildAutomaticBuildSnapshot>["stages"][number] | undefined;
  for (let round = 0; round < 8; round += 1) {
    stage = buildAutomaticBuildSnapshot(target).stages.find((candidate) => candidate.stage === "profile_sidecar");
    if (!stage?.policy_set) throw new Error("expected a production profile-sidecar policy set");
    if (!stage.pending_work_units?.length) break;
    freezeAutomaticBuildStagePolicySet(target, stage.policy_set);
    for (const unit of stage.pending_work_units) {
      const generation = stage.generation_tasks?.[unit.work_unit_id];
      if (generation?.kind !== "profile_sidecar_fast_path") {
        throw new Error(`expected a profile-sidecar fast-path task: ${unit.work_unit_id}`);
      }
      freezeProfileSidecarSemanticFastPathTask(target, generation.task);
      const lid = generation.task.packet.visible_lids[0];
      if (!lid) throw new Error("profile-sidecar fixture task has no evidence LID");
      writeProfileSidecarSemanticFastPathCandidate({
        target,
        source: readFileSync(target.source_path, "utf8"),
        task: generation.task,
        candidate: {
          discourse_items: [{ lid, mode: "informative", relations: [] }],
        },
        provenance: {
          executor: "orchestrator-v3-profile-fixture",
          attempt: 1,
          generated_at: `2026-08-04T02:1${round}:00.000Z`,
        },
      });
    }
  }
  stage = buildAutomaticBuildSnapshot(target).stages.find((candidate) => candidate.stage === "profile_sidecar");
  if (!stage?.policy_set || stage.pending_tasks.length) {
    throw new Error("production profile-sidecar fixture did not reach its close boundary");
  }
  const report = collectAutomaticBuildStageQuality(target, stage, "full");
  expect(report.gate_status).toBe("passed");
  writeAutomaticBuildStageQualityReport(target, report);
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "skills", "build", "profile-sidecar-batch.ts"),
    target.source_path,
    "--book-id", target.book_id,
    "--content-profile", target.profile_id,
    "--production-generation", stage.policy_set.policy_set_digest,
  ], { cwd: target.root_dir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function writeTrustedPaperWorkspace(root: string, bookId = "paper-a", sourceOverride?: string): string {
  const dir = path.join(root, ".understand-book", bookId);
  const source = sourceOverride
    ?? "# Abstract\n\nThis paper studies Softmax Attention retrieval.\n\n# Discussion\n\nThe Softmax Attention comparison continues here.\n";
  const draftSource = sourceOverride
    ?? "# Abstract\n\nThis paper studies Softmax Attention retrieval with OCR noise.\n\n# Discussion\n\nThe Softmax Attention comparison continues here.\n";
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

function writeTechnicalLearningWorkspace(root: string, bookId = "guide"): {
  workspace: string;
  sourceFile: string;
  source: string;
} {
  const workspace = path.join(root, ".understand-book", bookId);
  const sourceFile = path.join(root, `${bookId}.md`);
  const source = "# Guide\n\nA deterministic technical learning source.\n";
  mkdirSync(workspace, { recursive: true });
  writeFileSync(sourceFile, source, "utf8");
  writeFileSync(path.join(workspace, "source.txt"), source, "utf8");
  writeJson(path.join(workspace, "base.json"), { book_id: bookId, lid_nodes: [], graph_nodes: [], graph_edges: [] });
  writeJson(path.join(workspace, "source_manifest.json"), buildSourceManifest({
    book_id: bookId,
    source_path: sourceFile,
  }));
  writeJson(path.join(workspace, "profile_metadata.json"), {
    header: {
      book_id: bookId,
      book_version: "v1",
      profile_id: "technical_learning",
      profile_version: "technical_learning_v0",
      core_schema_version: "core_v0",
      generated_at: "1970-01-01T00:00:00.000Z",
    },
  });
  return { workspace, sourceFile, source };
}

describe("automatic build orchestrator", () => {
  it("uses an explicit book id before falling back to the source filename slug", () => {
    const root = tempDir();
    const source = path.join(root, "renamed-import.md");
    writeFileSync(source, "# Renamed import\n\nA deterministic source.\n", "utf8");
    mkdirSync(path.join(root, ".understand-book", "stable-guide", ".build"), { recursive: true });

    expect(resolveAutomaticBuildTarget(source, root, { book_id: "stable-guide" })).toMatchObject({
      book_id: "stable-guide",
      workspace_dir: path.join(path.resolve(root), ".understand-book", "stable-guide"),
      source_path: path.resolve(source),
    });
    expect(resolveAutomaticBuildTarget(source, root)).toMatchObject({
      book_id: "renamed-import",
      workspace_dir: path.join(path.resolve(root), ".understand-book", "renamed-import"),
    });
  });

  it("resolves an existing technical-learning workspace and its source.txt without a Workbench manifest", () => {
    const root = tempDir();
    const { workspace, sourceFile, source } = writeTechnicalLearningWorkspace(root);

    const expected = {
      kind: "source_file",
      book_id: "guide",
      profile_id: "technical_learning",
      root_dir: path.resolve(root),
      workspace_dir: path.resolve(workspace),
      source_path: path.resolve(sourceFile),
      target_ref: {
        version: "build_target_ref.v2",
        workspace_dir: path.resolve(workspace),
        book_id: "guide",
        profile_id: "technical_learning",
        input_fingerprint: sha256Text(source),
      },
    };
    expect(resolveAutomaticBuildTarget(workspace, root)).toEqual(expected);
    expect(resolveAutomaticBuildTarget("guide", root)).toEqual(expected);
    expect(resolveAutomaticBuildTarget(path.join(workspace, "source.txt"), root)).toEqual(expected);
  });

  it("falls back to the workspace truth file when the imported technical source is unavailable", () => {
    const root = tempDir();
    const { workspace, sourceFile, source } = writeTechnicalLearningWorkspace(root, "portable-guide");
    unlinkSync(sourceFile);

    expect(resolveAutomaticBuildTarget(workspace, root)).toMatchObject({
      kind: "source_file",
      book_id: "portable-guide",
      profile_id: "technical_learning",
      workspace_dir: path.resolve(workspace),
      source_path: path.join(path.resolve(workspace), "source.txt"),
      target_ref: { input_fingerprint: sha256Text(source) },
    });
  });

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

    expect(() => resolveAutomaticBuildTarget(source, root)).toThrow("缺少可验证的 content profile");
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

  it("exposes BookStructure without Pass2 and invalidates it when a Pass2 audit arrives later", () => {
    const root = tempDir();
    const { workspace, sourceFile, source } = writeTechnicalLearningWorkspace(root, "optional-pass2");
    const target = resolveAutomaticBuildTarget(workspace, root);
    writeJson(path.join(workspace, "long_range_candidates.json"), { candidates: [] });
    closeV3Pass1(target);
    closeV3ProfileSidecar(target);
    const header = { book_id: target.book_id, profile_id: target.profile_id };

    const snapshot = buildAutomaticBuildSnapshot(target);
    expect(existsSync(path.join(workspace, "pass2_audit.json"))).toBe(false);
    expect(snapshot.stages.find((stage) => stage.stage === "pass2")).toMatchObject({ closed: false });
    const bookStructure = snapshot.stages.find((stage) => stage.stage === "book_structure");
    expect(bookStructure?.pending_work_units?.length).toBeGreaterThan(0);
    expect(bookStructure?.pending_work_units?.every((unit) => unit.cost.candidate_count === 0)).toBe(true);
    expect(target.source_path).toBe(path.resolve(sourceFile));

    const unitWork = bookStructure?.pending_work_units ?? [];
    for (const unit of unitWork) {
      const unitLid = unit.work_unit_id.slice("unit:".length);
      writeJson(
        path.join(workspace, ".build", "book-structure", "units", `${unitLid}.json`),
        buildSemanticArtifactEnvelope({
          target: target.target_ref,
          stage: "book_structure",
          work_unit_id: unit.work_unit_id,
          input_hash: unit.input_hash,
          policy_fingerprint: unit.policy_fingerprint,
          provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-07-31T00:00:00.000Z" },
          payload: {
            content_hash: unit.input_hash,
            output: {
              unit_card: {
                unit_lid: unitLid,
                role: "setup",
                summary: { text: "Structure before Pass2.", evidence_lids: [unit.evidence_lids[0]] },
                candidate_key_stops: [],
                depends_on: [],
                evidence_lids: unit.evidence_lids,
              },
            },
          },
        }),
      );
    }

    const stitchSnapshot = buildAutomaticBuildSnapshot(target);
    const stitch = stitchSnapshot.stages
      .find((stage) => stage.stage === "book_structure")
      ?.pending_work_units?.find((unit) => unit.work_unit_id === "stitch");
    expect(stitch).toBeDefined();
    writeJson(
      path.join(workspace, ".build", "book-structure", "stitch.json"),
      buildSemanticArtifactEnvelope({
        target: target.target_ref,
        stage: "book_structure",
        work_unit_id: "stitch",
        input_hash: stitch!.input_hash,
        policy_fingerprint: stitch!.policy_fingerprint,
        provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-07-31T00:00:00.000Z" },
        payload: {
          content_hash: stitch!.input_hash,
          output: { spine: [], throughlines: [], key_stops: [] },
        },
      }),
    );
    writeJson(path.join(workspace, "book_structure.json"), {
      header,
      spine: [],
      throughlines: [],
      key_stops: [],
    });
    expect(buildAutomaticBuildSnapshot(target).stages.find((stage) => stage.stage === "book_structure")).toMatchObject({
      closed: true,
      pending_tasks: [],
    });

    const evidenceLid = unitWork[0].evidence_lids[0];
    writeJson(path.join(workspace, "pass2_audit.json"), {
      header,
      accepted: [{
        candidate_id: "late-pass2-edge",
        source: "concept:source",
        target: "concept:target",
        type: "builds_on",
        source_evidence_lids: [evidenceLid],
        target_evidence_lids: [evidenceLid],
        evidence_lids: [evidenceLid],
        support_level: "explicit",
        rationale: "A late accepted Pass2 edge changes the BookStructure input.",
      }],
      pending: [],
      rejected: [],
      gate_dropped: [],
    });

    const enrichedSnapshot = buildAutomaticBuildSnapshot(target);
    expect(enrichedSnapshot.stages.find((stage) => stage.stage === "pass2")).toMatchObject({ closed: true });
    const staleStructure = enrichedSnapshot.stages.find((stage) => stage.stage === "book_structure");
    expect(staleStructure?.closed).toBe(false);
    expect(staleStructure?.pending_work_units?.some((unit) => (
      unit.work_unit_id.startsWith("unit:") && unit.cost.candidate_count === 1
    ))).toBe(true);
  }, 30_000);

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
      version: "automatic_build_work_unit.v3",
      work_unit_id: "0",
      kind: "pass1_window",
    });
    expect(nextAutomaticBuildAction(snapshot)).toEqual({ kind: "close_stage", stage: "pass1" });
  });

  it("paper Pass1 close preserves the trusted foundation manifest and PDF maps", () => {
    const root = tempDir();
    const workspace = writeTrustedPaperWorkspace(root);
    const sourcePath = path.join(workspace, "source.txt");
    const target = resolveAutomaticBuildTarget(workspace, root);
    writeFileSync(path.join(workspace, "pdf_source_map.json"), "map-sentinel", "utf8");
    const manifestBefore = readFileSync(path.join(workspace, "source_manifest.json"), "utf8");
    closeV3Pass1(target);
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
    expect(sidecarStage.work_units?.every((unit) => unit.version === "automatic_build_work_unit.v3"))
      .toBe(true);
    expect(sidecarStage.pending_work_units?.some((unit) => unit.kind === "profile_sidecar_formula"))
      .toBe(false);
    expect(nextAutomaticBuildAction(sidecarSnapshot)).toMatchObject({
      kind: "extract",
      stage: "profile_sidecar",
      task_ids: sidecarStage.pending_tasks,
    });
  });

  it("routes fresh paper lexicon fragments into an artifact-bound reducer without mutating build state", () => {
    const root = tempDir();
    const repeated = "bounded retrieval context ".repeat(300);
    const source = [
      "# Abstract",
      "This paper defines a retrieval architecture.",
      "# Evidence A",
      `We define Adaptive Retrieval Architecture (ARA) as a retrieval model. ${repeated}`,
      "# Evidence B",
      `Adaptive Retrieval Architecture (ARA) preserves evidence. ${repeated}`,
      "# Evidence C",
      `Adaptive Retrieval Architecture (ARA) improves recall. ${repeated}`,
      "# Evidence D",
      `Adaptive Retrieval Architecture (ARA) improves precision. ${repeated}`,
    ].join("\n\n");
    const workspace = writeTrustedPaperWorkspace(root, "paper-lexicon-reduce", source);
    const target = resolveAutomaticBuildTarget(workspace, root);
    closeV3Pass1(target);

    const metadataSnapshot = buildAutomaticBuildSnapshot(target);
    const metadataStage = metadataSnapshot.stages.find((stage) => stage.stage === "paper_metadata")!;
    for (const unit of metadataStage.pending_work_units ?? []) {
      writeJson(path.join(workspace, ".build", "paper-metadata", `${unit.work_unit_id}.json`), buildSemanticArtifactEnvelope({
        target: target.target_ref,
        stage: "paper_metadata",
        work_unit_id: unit.work_unit_id,
        input_hash: unit.input_hash,
        policy_fingerprint: unit.policy_fingerprint,
        provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-08-18T00:00:00.000Z" },
        payload: { content_hash: unit.input_hash, metadata: {} },
      }));
    }
    writeJson(path.join(workspace, "paper_metadata.json"), {
      header: { book_id: target.book_id, profile_id: "paper" },
    });

    const lidNodes = segment(markdownToBlocks(source));
    const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
    const windows = splitWindows(lidNodes, source);
    const policy = automaticBuildExtractionPolicy("paper_lexicon", resolveContentProfile("paper"), "full");
    const initialPlan = routePaperLexiconWorkUnits({
      target: target.target_ref,
      windows,
      byLid,
      source,
      policy_fingerprint: policy,
    });
    const fragments = Object.values(initialPlan.packets).filter((packet) =>
      packet.route.role === "fragment"
      && packet.route.cluster_keys[0] === "adaptive retrieval architecture");
    expect(fragments.length).toBeGreaterThan(1);

    const lexiconSnapshot = buildAutomaticBuildSnapshot(target);
    const lexiconStage = lexiconSnapshot.stages.find((stage) => stage.stage === "paper_lexicon")!;
    const fragmentArtifactHashes = new Map<string, string>();
    for (const unit of lexiconStage.pending_work_units ?? []) {
      const packet = initialPlan.packets[unit.work_unit_id];
      if (!packet) throw new Error(`missing paper lexicon packet: ${unit.work_unit_id}`);
      const artifact = buildPaperLexiconCandidateArtifact(packet, lidNodes, { entries: [] });
      const envelope = buildSemanticArtifactEnvelope({
        target: target.target_ref,
        stage: "paper_lexicon",
        work_unit_id: unit.work_unit_id,
        input_hash: unit.input_hash,
        policy_fingerprint: unit.policy_fingerprint,
        provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-08-18T00:01:00.000Z" },
        payload: artifact,
      });
      writeJson(path.join(workspace, ".build", "paper-lexicon", `${unit.work_unit_id}.json`), envelope);
      if (packet.route.role === "fragment") {
        fragmentArtifactHashes.set(unit.work_unit_id, envelope.artifact_hash);
      }
    }

    const reducedSnapshot = buildAutomaticBuildSnapshot(target);
    const reducedStage = reducedSnapshot.stages.find((stage) => stage.stage === "paper_lexicon")!;
    const fragmentIds = new Set(fragments.map((fragment) => fragment.work_unit_id));
    const reducer = reducedStage.pending_work_units?.find((unit) =>
      unit.work_unit_id.startsWith("lexicon-reduce-")
      && unit.dependencies.length === fragmentIds.size
      && unit.dependencies.every((dependency) => fragmentIds.has(dependency.artifact)));
    expect(reducer?.dependencies).toEqual(fragments.map((fragment) => ({
      artifact: fragment.work_unit_id,
      sha256: fragmentArtifactHashes.get(fragment.work_unit_id),
    })).sort((left, right) => left.artifact.localeCompare(right.artifact)));
    expect(existsSync(path.join(workspace, ".build", "paper-lexicon", `${reducer!.work_unit_id}.json`))).toBe(false);
  }, 60_000);
});
