import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { deriveBookId } from "./book-id";
import { assertTrustedPaperProjectionSource } from "./paper-projection-chain";
import { resolveContentProfile, type ContentProfileId } from "./content-profile";
import { markdownToBlocks } from "./md-adapter";
import { epubToSource } from "./epub-adapter";
import { segment } from "./segment";
import { splitWindows } from "./window";
import { computeBuildStatus, type Pass1ArtifactMeta } from "./build-resume";
import { computePaperMetadataStatus } from "./paper-metadata";
import { computePaperLexiconStatus } from "./paper-lexicon";
import { computeProfileSidecarStatus } from "./profile-sidecar-build";
import { buildPass2Candidates, buildPass2WorkPacket, computePass2Status } from "./pass2-orchestrate";
import type { Pass2WorkPacket } from "./pass2-build";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { TechnicalLearningDiscourseIndex } from "./discourse-index";
import {
  bookStructureUnitHash,
  buildBookStructureStitchPacket,
  buildBookStructureUnitSources,
  computeBookStructureStatus,
  type BookStructureStitchArtifact,
  type BookStructureUnitArtifact,
} from "./book-structure";

export type AutomaticBuildStage =
  | "pass1"
  | "paper_metadata"
  | "paper_lexicon"
  | "profile_sidecar"
  | "pass2"
  | "book_structure"
  | "paper_reading_guide";

export type SemanticExtractor =
  | "pass1-local-extractor"
  | "paper-metadata-extractor"
  | "paper-lexicon-extractor"
  | "profile-sidecar-extractor"
  | "pass2-longrange-linker"
  | "book-structure-extractor";

export interface AutomaticBuildTarget {
  kind: "paper_workspace" | "source_file";
  profile_id: ContentProfileId;
  book_id: string;
  root_dir: string;
  workspace_dir: string;
  source_path: string;
}

export interface AutomaticBuildStageState {
  stage: AutomaticBuildStage;
  pending_tasks: string[];
  closed: boolean;
}

export interface AutomaticBuildSnapshot {
  target: AutomaticBuildTarget;
  stages: AutomaticBuildStageState[];
}

interface LoadedAutomaticBook {
  source: string;
  lidNodes: ReturnType<typeof segment>;
  byLid: Map<string, ReturnType<typeof segment>[number]>;
  windows: ReturnType<typeof splitWindows>;
}

export type AutomaticBuildAction =
  | {
      kind: "extract";
      stage: AutomaticBuildStage;
      extractor: SemanticExtractor;
      task_ids: string[];
      max_attempts: 3;
    }
  | { kind: "close_stage"; stage: AutomaticBuildStage }
  | { kind: "done"; book_id: string; workspace_dir: string };

const EXTRACTORS: Partial<Record<AutomaticBuildStage, SemanticExtractor>> = {
  pass1: "pass1-local-extractor",
  paper_metadata: "paper-metadata-extractor",
  paper_lexicon: "paper-lexicon-extractor",
  profile_sidecar: "profile-sidecar-extractor",
  pass2: "pass2-longrange-linker",
  book_structure: "book-structure-extractor",
};

interface WorkbenchInputManifestLike {
  book_id?: string;
  profile_id?: string;
  inputs?: {
    paper_md?: { original_path?: string | null; path?: string; sha256?: string };
    paper_pdf?: { original_path?: string | null; path?: string; sha256?: string };
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function loadAutomaticBook(sourcePath: string): LoadedAutomaticBook {
  const loaded = /\.epub$/i.test(sourcePath)
    ? epubToSource(new Uint8Array(readFileSync(sourcePath)))
    : { source: readFileSync(sourcePath, "utf8"), blocks: markdownToBlocks(readFileSync(sourcePath, "utf8")) };
  const lidNodes = segment(loaded.blocks);
  return {
    source: loaded.source,
    lidNodes,
    byLid: new Map(lidNodes.map((node) => [node.lid, node])),
    windows: splitWindows(lidNodes, loaded.source),
  };
}

function artifactMetaByNumericTask(dir: string, taskIds: number[]): Map<number, Pass1ArtifactMeta> {
  const result = new Map<number, Pass1ArtifactMeta>();
  for (const id of taskIds) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const artifact = readJson<Pass1ArtifactMeta>(file);
    if (typeof artifact.content_hash === "string") result.set(id, { content_hash: artifact.content_hash });
  }
  return result;
}

function profileArtifactMatches(file: string, target: AutomaticBuildTarget): boolean {
  if (!existsSync(file)) return false;
  const value = readJson<{ header?: { book_id?: string; profile_id?: string } }>(file);
  return value.header?.book_id === target.book_id && value.header.profile_id === target.profile_id;
}

function paperGuideVerificationFresh(workspaceDir: string): boolean {
  const verificationPath = path.join(workspaceDir, ".build", "paper-reading-guide", "verification.json");
  if (!existsSync(verificationPath)) return false;
  const verification = readJson<{ version?: string; available?: boolean; inputs?: Record<string, string> }>(verificationPath);
  if (verification.version !== "paper_reading_guide_verification.v1" || verification.available !== true) return false;
  const required = ["source.txt", "base.json", "paper_metadata.json", "paper_lexicon.json", "book_structure.json"];
  return required.every((relative) => {
    const file = path.join(workspaceDir, relative);
    return existsSync(file) && verification.inputs?.[relative] === sha256File(file);
  });
}

function stageState(
  stage: AutomaticBuildStage,
  pendingTasks: Array<string | number>,
  closed: boolean,
): AutomaticBuildStageState {
  return { stage, pending_tasks: pendingTasks.map(String), closed };
}

function paperTargetFromWorkspace(workspaceInput: string): AutomaticBuildTarget {
  const workspaceDir = path.resolve(workspaceInput);
  const libraryDir = path.dirname(workspaceDir);
  if (path.basename(libraryDir) !== ".understand-book") {
    throw new Error(`paper workspace 必须位于 .understand-book/<book_id>: ${workspaceDir}`);
  }
  const inputManifestPath = path.join(workspaceDir, ".build", "input", "manifest.json");
  if (!existsSync(inputManifestPath)) {
    throw new Error(`paper workspace 缺少 Workbench input manifest: ${inputManifestPath}`);
  }
  const inputManifest = readJson<WorkbenchInputManifestLike>(inputManifestPath);
  if (inputManifest.profile_id !== "paper") {
    throw new Error(`workspace ${workspaceDir} 不是 paper profile`);
  }
  try {
    const trusted = assertTrustedPaperProjectionSource(workspaceDir);
    return {
      kind: "paper_workspace",
      profile_id: "paper",
      book_id: trusted.book_id,
      root_dir: path.dirname(libraryDir),
      workspace_dir: trusted.book_dir,
      source_path: trusted.trusted_source_path,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`paper workspace 缺少可信混合阅读基座: ${message}`);
  }
}

function paperWorkspaceCandidates(sourceFile: string, rootDir: string): string[] {
  const libraryDir = path.join(rootDir, ".understand-book");
  if (!existsSync(libraryDir)) return [];
  const sourcePath = path.resolve(sourceFile);
  const sourceHash = sha256File(sourcePath);
  const sourceExt = path.extname(sourcePath).toLowerCase();
  const inputKey = sourceExt === ".pdf" ? "paper_pdf" : "paper_md";
  const matches: string[] = [];
  for (const entry of readdirSync(libraryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(libraryDir, entry.name);
    const manifestPath = path.join(workspaceDir, ".build", "input", "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson<WorkbenchInputManifestLike>(manifestPath);
    if (manifest.profile_id !== "paper") continue;
    const input = manifest.inputs?.[inputKey];
    const originalPath = input?.original_path ? path.resolve(input.original_path) : null;
    if (originalPath === sourcePath || input?.sha256 === sourceHash) matches.push(workspaceDir);
  }
  return matches;
}

export function resolveAutomaticBuildTarget(targetInput: string, rootDir = process.cwd()): AutomaticBuildTarget {
  const explicitWorkspace = path.join(path.resolve(rootDir), ".understand-book", targetInput);
  const targetPath = existsSync(explicitWorkspace) ? explicitWorkspace : path.resolve(rootDir, targetInput);
  if (existsSync(targetPath) && statSync(targetPath).isDirectory()) return paperTargetFromWorkspace(targetPath);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new Error(`build target 不存在: ${targetPath}`);
  }

  const matches = paperWorkspaceCandidates(targetPath, path.resolve(rootDir));
  if (matches.length > 1) {
    throw new Error(`paper 输入匹配到多个 Workbench workspace，请显式指定 book id 或 workspace 路径: ${matches.join(", ")}`);
  }
  if (matches.length === 1) return paperTargetFromWorkspace(matches[0]);
  if (path.extname(targetPath).toLowerCase() === ".pdf") {
    throw new Error("paper PDF 未匹配到可信 Workbench workspace，请先在预构建工作台完成来源对齐与混合阅读基座");
  }

  const bookId = deriveBookId(targetPath);
  return {
    kind: "source_file",
    profile_id: "technical_learning",
    book_id: bookId,
    root_dir: path.resolve(rootDir),
    workspace_dir: path.join(path.resolve(rootDir), ".understand-book", bookId),
    source_path: targetPath,
  };
}

export function buildAutomaticBuildSnapshot(target: AutomaticBuildTarget): AutomaticBuildSnapshot {
  const loaded = loadAutomaticBook(target.source_path);
  const stages: AutomaticBuildStageState[] = [];
  const profile = resolveContentProfile(target.profile_id);
  const buildRoot = path.join(target.workspace_dir, ".build");

  const pass1Meta = artifactMetaByNumericTask(
    path.join(buildRoot, "pass1"),
    loaded.windows.map((window) => window.id),
  );
  const pass1 = computeBuildStatus(loaded.windows, loaded.byLid, loaded.source, pass1Meta, profile);
  const pass1Closed = profileArtifactMatches(path.join(target.workspace_dir, "profile_metadata.json"), target)
    && existsSync(path.join(target.workspace_dir, "long_range_candidates.json"));
  stages.push(stageState("pass1", pass1.pending, pass1Closed));
  if (pass1.pending.length || !pass1Closed) return { target, stages };

  if (target.profile_id === "paper") {
    const metadataMeta = artifactMetaByNumericTask(
      path.join(buildRoot, "paper-metadata"),
      loaded.windows.map((window) => window.id),
    );
    const metadata = computePaperMetadataStatus(loaded.windows, loaded.byLid, loaded.source, metadataMeta);
    const metadataClosed = profileArtifactMatches(path.join(target.workspace_dir, "paper_metadata.json"), target);
    stages.push(stageState("paper_metadata", metadata.pending, metadataClosed));
    if (metadata.pending.length || !metadataClosed) return { target, stages };

    const lexiconMeta = artifactMetaByNumericTask(
      path.join(buildRoot, "paper-lexicon"),
      loaded.windows.map((window) => window.id),
    );
    const lexicon = computePaperLexiconStatus(loaded.windows, loaded.byLid, loaded.source, lexiconMeta);
    const lexiconClosed = profileArtifactMatches(path.join(target.workspace_dir, "paper_lexicon.json"), target);
    stages.push(stageState("paper_lexicon", lexicon.pending, lexiconClosed));
    if (lexicon.pending.length || !lexiconClosed) return { target, stages };
  }

  const sidecarMeta = artifactMetaByNumericTask(
    path.join(buildRoot, "profile-sidecar"),
    loaded.windows.map((window) => window.id),
  );
  const sidecar = computeProfileSidecarStatus(loaded.windows, loaded.byLid, loaded.source, sidecarMeta, profile);
  const sidecarClosed = profileArtifactMatches(path.join(target.workspace_dir, "discourse_index.json"), target)
    && profileArtifactMatches(path.join(target.workspace_dir, "formula_semantics.json"), target);
  stages.push(stageState("profile_sidecar", sidecar.pending, sidecarClosed));
  if (sidecar.pending.length || !sidecarClosed) return { target, stages };

  const base = readJson<ReadOnlyBase>(path.join(target.workspace_dir, "base.json"));
  const discourseIndex = readJson<TechnicalLearningDiscourseIndex>(path.join(target.workspace_dir, "discourse_index.json"));
  const formulaValue = readJson<{ items?: FormulaSemantics[] } | FormulaSemantics[]>(path.join(target.workspace_dir, "formula_semantics.json"));
  const formulaSemantics = Array.isArray(formulaValue) ? formulaValue : formulaValue.items ?? [];
  const candidateIndex = buildPass2Candidates({
    graphNodes: base.graph_nodes,
    windows: loaded.windows,
    discourseIndex,
    formulaSemantics,
  });
  const packets = new Map<number, Pass2WorkPacket>();
  for (const window of loaded.windows) {
    packets.set(window.id, buildPass2WorkPacket({
      window,
      byLid: loaded.byLid,
      source: loaded.source,
      graphNodes: base.graph_nodes,
      candidates: candidateIndex.candidates,
      discourseIndex,
      formulaSemantics,
    }));
  }
  const pass2Meta = artifactMetaByNumericTask(path.join(buildRoot, "pass2"), loaded.windows.map((window) => window.id));
  const pass2 = computePass2Status(packets, pass2Meta);
  const pass2Closed = profileArtifactMatches(path.join(target.workspace_dir, "pass2_audit.json"), target);
  stages.push(stageState("pass2", pass2.pending, pass2Closed));
  if (pass2.pending.length || !pass2Closed) return { target, stages };

  const pass2Audit = readJson<Parameters<typeof buildBookStructureUnitSources>[0]["pass2Audit"]>(
    path.join(target.workspace_dir, "pass2_audit.json"),
  );
  const unitSources = buildBookStructureUnitSources({
    lidNodes: loaded.lidNodes,
    source: loaded.source,
    graphNodes: base.graph_nodes,
    graphEdges: base.graph_edges,
    discourseIndex,
    formulaSemantics,
    pass2Audit,
    contentProfile: profile,
  });
  const unitMeta = new Map<string, { content_hash: string }>();
  const unitArtifacts: BookStructureUnitArtifact[] = [];
  let allUnitsFresh = true;
  for (const unit of unitSources) {
    const file = path.join(buildRoot, "book-structure", "units", `${unit.unit_lid}.json`);
    if (!existsSync(file)) {
      allUnitsFresh = false;
      continue;
    }
    const artifact = readJson<BookStructureUnitArtifact>(file);
    unitMeta.set(unit.job_id, { content_hash: artifact.content_hash });
    if (artifact.content_hash === bookStructureUnitHash(unit)) unitArtifacts.push(artifact);
    else allUnitsFresh = false;
  }
  const stitchPacket = allUnitsFresh && unitArtifacts.length === unitSources.length
    ? buildBookStructureStitchPacket(unitArtifacts, pass2Audit, profile)
    : undefined;
  const stitchFile = path.join(buildRoot, "book-structure", "stitch.json");
  const stitchArtifact = existsSync(stitchFile) ? readJson<BookStructureStitchArtifact>(stitchFile) : undefined;
  const structure = computeBookStructureStatus(
    unitSources,
    unitMeta,
    stitchArtifact ? { content_hash: stitchArtifact.content_hash } : undefined,
    stitchPacket,
  );
  const structureTasks = structure.unit_pending.length
    ? structure.unit_pending
    : structure.stitch_pending
      ? ["stitch"]
      : [];
  const structureClosed = structure.stitch_done
    && profileArtifactMatches(path.join(target.workspace_dir, "book_structure.json"), target);
  stages.push(stageState("book_structure", structureTasks, structureClosed));
  if (structureTasks.length || !structureClosed) return { target, stages };

  if (target.profile_id === "paper") {
    stages.push(stageState("paper_reading_guide", [], paperGuideVerificationFresh(target.workspace_dir)));
  }
  return { target, stages };
}

export function nextAutomaticBuildAction(snapshot: AutomaticBuildSnapshot, maxParallel = 5): AutomaticBuildAction {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  for (const stage of snapshot.stages) {
    if (stage.closed) continue;
    if (stage.pending_tasks.length) {
      const extractor = EXTRACTORS[stage.stage];
      if (!extractor) throw new Error(`stage ${stage.stage} has pending semantic tasks but no extractor`);
      return {
        kind: "extract",
        stage: stage.stage,
        extractor,
        task_ids: stage.pending_tasks.slice(0, maxParallel),
        max_attempts: 3,
      };
    }
    return { kind: "close_stage", stage: stage.stage };
  }
  return { kind: "done", book_id: snapshot.target.book_id, workspace_dir: snapshot.target.workspace_dir };
}
