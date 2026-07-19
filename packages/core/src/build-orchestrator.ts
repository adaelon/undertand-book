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
import { computeBuildStatus, type Pass1Artifact, type Pass1ArtifactMeta } from "./build-resume";
import { pass1ContentHash } from "./build-resume";
import { buildPass1Input } from "./pass1-input";
import { buildProfiledPass1Input } from "./pass1-profile-input";
import { mergeAndGate } from "./merge";
import { computePaperMetadataRoutingStatus, routePaperMetadataWorkUnits } from "./paper-metadata-router";
import { computePaperLexiconRoutingStatus, routePaperLexiconWorkUnits } from "./paper-lexicon-router";
import { computeProfileSidecarRoutingStatus, routeProfileSidecarWorkUnits } from "./profile-sidecar-router";
import { buildPass2Candidates, buildPass2WorkPacket, computePass2Status, pass2PacketHash } from "./pass2-orchestrate";
import type { Pass2WorkPacket } from "./pass2-build";
import { buildInputFingerprintHash } from "./build-workbench";
import type { BuildInputFingerprint } from "./source-reconciliation";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { TechnicalLearningDiscourseIndex } from "./discourse-index";
import {
  bookStructureStitchHash,
  bookStructureUnitHash,
  buildBookStructureStitchPacket,
  buildBookStructureUnitSources,
  computeBookStructureStatus,
  type BookStructureStitchArtifact,
  type BookStructureUnitArtifact,
} from "./book-structure";
import {
  automaticBuildExtractionPolicy,
  inspectSemanticArtifact,
  type AutomaticBuildTaskPolicyBindingV1,
  type ExtractionQualityProfile,
  type SemanticArtifactExpectation,
  type SemanticBuildStage,
} from "./semantic-artifact";
import {
  buildWorkUnitCost,
  createWorkUnitDescriptor,
  routePass1WindowWorkUnits,
  type WorkUnitDescriptorV2,
  type WorkUnitKind,
  type WorkUnitStage,
} from "./stage-work-unit";
import { estimateTokens } from "./window";

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
  target_ref: BuildTargetRefV2;
}

export interface BuildTargetRefV2 {
  version: "build_target_ref.v2";
  workspace_dir: string;
  book_id: string;
  profile_id: ContentProfileId;
  input_fingerprint: string;
}

export interface AutomaticBuildStageState {
  stage: AutomaticBuildStage;
  pending_tasks: string[];
  closed: boolean;
  task_bindings?: Record<string, AutomaticBuildTaskPolicyBindingV1>;
  work_units?: WorkUnitDescriptorV2[];
  pending_work_units?: WorkUnitDescriptorV2[];
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
      task_bindings?: Record<string, AutomaticBuildTaskPolicyBindingV1>;
      work_units?: WorkUnitDescriptorV2[];
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
  fingerprint?: BuildInputFingerprint;
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

function semanticExpectation(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  workUnitId: string,
  binding: AutomaticBuildTaskPolicyBindingV1,
): SemanticArtifactExpectation {
  return {
    target: target.target_ref,
    stage,
    work_unit_id: workUnitId,
    input_hash: binding.input_hash,
    policy_fingerprint: binding.policy_fingerprint,
  };
}

function freshSemanticPayload<T>(
  file: string,
  expected: SemanticArtifactExpectation,
): T | undefined {
  const inspected = inspectSemanticArtifact<T>(readJson(file), expected);
  return inspected.policy_fresh ? inspected.payload : undefined;
}

function artifactMetaByNumericTask(
  dir: string,
  taskIds: number[],
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  bindings: Record<string, AutomaticBuildTaskPolicyBindingV1>,
): Map<number, Pass1ArtifactMeta> {
  const result = new Map<number, Pass1ArtifactMeta>();
  for (const id of taskIds) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const binding = bindings[String(id)];
    if (!binding) continue;
    const artifact = freshSemanticPayload<Pass1ArtifactMeta>(file, semanticExpectation(target, stage, String(id), binding));
    if (artifact && typeof artifact.content_hash === "string") result.set(id, { content_hash: artifact.content_hash });
  }
  return result;
}

function artifactMetaByWorkUnit(
  dir: string,
  taskIds: string[],
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  bindings: Record<string, AutomaticBuildTaskPolicyBindingV1>,
): Map<string, Pass1ArtifactMeta> {
  const result = new Map<string, Pass1ArtifactMeta>();
  for (const id of taskIds) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const binding = bindings[id];
    if (!binding) continue;
    const artifact = freshSemanticPayload<Pass1ArtifactMeta>(file, semanticExpectation(target, stage, id, binding));
    if (artifact && typeof artifact.content_hash === "string") result.set(id, { content_hash: artifact.content_hash });
  }
  return result;
}

function pass1ArtifactsByNumericTask(
  dir: string,
  taskIds: number[],
  target: AutomaticBuildTarget,
  bindings: Record<string, AutomaticBuildTaskPolicyBindingV1>,
): Map<number, Pass1Artifact> {
  const result = new Map<number, Pass1Artifact>();
  for (const id of taskIds) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const binding = bindings[String(id)];
    if (!binding) continue;
    const artifact = freshSemanticPayload<Pass1Artifact>(file, semanticExpectation(target, "pass1", String(id), binding));
    if (
      artifact
      && typeof artifact.content_hash === "string"
      && Array.isArray(artifact.nodes)
      && Array.isArray(artifact.edges)
    ) {
      result.set(id, artifact);
    }
  }
  return result;
}

function pass1GraphMatchesClosedBase(
  basePath: string,
  doneTaskIds: number[],
  artifacts: Map<number, Pass1Artifact>,
  lidNodes: LoadedAutomaticBook["lidNodes"],
): boolean {
  if (!existsSync(basePath) || doneTaskIds.some((id) => !artifacts.has(id))) return false;
  try {
    const base = readJson<ReadOnlyBase>(basePath);
    const expected = mergeAndGate(
      doneTaskIds.map((id) => {
        const artifact = artifacts.get(id)!;
        return { nodes: artifact.nodes, edges: artifact.edges };
      }),
      lidNodes,
    );
    const closedLocalEdges = base.graph_edges.filter((edge) => edge.scope !== "long_range");
    return JSON.stringify(base.graph_nodes) === JSON.stringify(expected.nodes)
      && JSON.stringify(closedLocalEdges) === JSON.stringify(expected.edges);
  } catch {
    return false;
  }
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
  workUnits?: WorkUnitDescriptorV2[],
): AutomaticBuildStageState {
  const pending = pendingTasks.map(String);
  const pendingSet = new Set(pending);
  const pendingWorkUnits = workUnits?.filter((unit) => pendingSet.has(unit.work_unit_id) && !unit.deterministic_skip) ?? [];
  const pendingBindings = pendingWorkUnits.length
    ? Object.fromEntries(pendingWorkUnits.map((unit) => [unit.work_unit_id, {
        input_hash: unit.input_hash,
        policy_fingerprint: unit.policy_fingerprint,
      }]))
    : {};
  return {
    stage,
    pending_tasks: pending,
    closed,
    ...(Object.keys(pendingBindings).length ? { task_bindings: pendingBindings } : {}),
    ...(workUnits ? { work_units: workUnits, pending_work_units: pendingWorkUnits } : {}),
  };
}

function taskBindings(
  stage: SemanticBuildStage,
  profile: ReturnType<typeof resolveContentProfile>,
  qualityProfile: ExtractionQualityProfile,
  inputs: Array<{ task_id: string | number; input_hash: string }>,
): Record<string, AutomaticBuildTaskPolicyBindingV1> {
  const policy = automaticBuildExtractionPolicy(stage, profile, qualityProfile);
  return Object.fromEntries(inputs.map((input) => [String(input.task_id), {
    input_hash: input.input_hash,
    policy_fingerprint: policy,
  }]));
}

function descriptorFromBinding(input: {
  target: AutomaticBuildTarget;
  stage: WorkUnitStage;
  task_id: string;
  kind: WorkUnitKind;
  binding: AutomaticBuildTaskPolicyBindingV1;
  evidence_lids: string[];
  estimated_input_tokens: number;
  formula_lids?: number;
  table_fragments?: number;
  candidate_count?: number;
  expected_output_items?: number;
  legacy_artifact_ref?: string;
}): WorkUnitDescriptorV2 {
  return createWorkUnitDescriptor({
    target: input.target.target_ref,
    stage: input.stage,
    work_unit_id: input.task_id,
    kind: input.kind,
    input_hash: input.binding.input_hash,
    policy_fingerprint: input.binding.policy_fingerprint,
    evidence_lids: input.evidence_lids,
    cost: buildWorkUnitCost({
      estimated_input_tokens: input.estimated_input_tokens,
      visible_lids: input.evidence_lids.length,
      formula_lids: input.formula_lids,
      table_fragments: input.table_fragments,
      candidate_count: input.candidate_count,
      expected_output_items: input.expected_output_items,
    }),
    ...(input.legacy_artifact_ref ? { legacy_artifact_ref: input.legacy_artifact_ref } : {}),
  });
}

function bindingsFromDescriptors(units: WorkUnitDescriptorV2[]): Record<string, AutomaticBuildTaskPolicyBindingV1> {
  return Object.fromEntries(units.map((unit) => [unit.work_unit_id, {
    input_hash: unit.input_hash,
    policy_fingerprint: unit.policy_fingerprint,
  }]));
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
    if (!inputManifest.fingerprint) {
      throw new Error(`paper workspace input manifest 缺少 fingerprint: ${inputManifestPath}`);
    }
    const trusted = assertTrustedPaperProjectionSource(workspaceDir);
    if (inputManifest.book_id !== trusted.book_id) {
      throw new Error(`paper workspace book identity 不一致: manifest=${inputManifest.book_id ?? "missing"}, trusted=${trusted.book_id}`);
    }
    const targetRef: BuildTargetRefV2 = {
      version: "build_target_ref.v2",
      workspace_dir: trusted.book_dir,
      book_id: trusted.book_id,
      profile_id: "paper",
      input_fingerprint: buildInputFingerprintHash(inputManifest.fingerprint),
    };
    return {
      kind: "paper_workspace",
      profile_id: "paper",
      book_id: trusted.book_id,
      root_dir: path.dirname(libraryDir),
      workspace_dir: trusted.book_dir,
      source_path: trusted.trusted_source_path,
      target_ref: targetRef,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`paper workspace 缺少可信混合阅读基座: ${message}`);
  }
}

function containingBuildWorkspaceSource(sourcePath: string): string | undefined {
  if (path.basename(sourcePath).toLowerCase() !== "source.txt") return undefined;
  const workspaceDir = path.dirname(sourcePath);
  return path.basename(path.dirname(workspaceDir)) === ".understand-book" ? workspaceDir : undefined;
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

  const containingWorkspace = containingBuildWorkspaceSource(targetPath);
  if (containingWorkspace) return paperTargetFromWorkspace(containingWorkspace);

  const matches = paperWorkspaceCandidates(targetPath, path.resolve(rootDir));
  if (matches.length > 1) {
    throw new Error(`paper 输入匹配到多个 Workbench workspace，请显式指定 book id 或 workspace 路径: ${matches.join(", ")}`);
  }
  if (matches.length === 1) return paperTargetFromWorkspace(matches[0]);
  if (path.extname(targetPath).toLowerCase() === ".pdf") {
    throw new Error("paper PDF 未匹配到可信 Workbench workspace，请先在预构建工作台完成来源对齐与混合阅读基座");
  }

  const bookId = deriveBookId(targetPath);
  const workspaceDir = path.join(path.resolve(rootDir), ".understand-book", bookId);
  return {
    kind: "source_file",
    profile_id: "technical_learning",
    book_id: bookId,
    root_dir: path.resolve(rootDir),
    workspace_dir: workspaceDir,
    source_path: targetPath,
    target_ref: {
      version: "build_target_ref.v2",
      workspace_dir: workspaceDir,
      book_id: bookId,
      profile_id: "technical_learning",
      input_fingerprint: sha256File(targetPath),
    },
  };
}

export function buildAutomaticBuildSnapshot(
  target: AutomaticBuildTarget,
  options: { quality_profile?: ExtractionQualityProfile } = {},
): AutomaticBuildSnapshot {
  const loaded = loadAutomaticBook(target.source_path);
  const stages: AutomaticBuildStageState[] = [];
  const profile = resolveContentProfile(target.profile_id);
  const qualityProfile = options.quality_profile ?? "full";
  const buildRoot = path.join(target.workspace_dir, ".build");
  const pass1Policy = automaticBuildExtractionPolicy("pass1", profile, qualityProfile);
  const pass1WorkUnits = routePass1WindowWorkUnits({
    target: target.target_ref,
    windows: loaded.windows,
    byLid: loaded.byLid,
    source: loaded.source,
    policy_fingerprint: pass1Policy,
    content_profile: profile,
  });
  const pass1Bindings = bindingsFromDescriptors(pass1WorkUnits);

  const pass1Artifacts = pass1ArtifactsByNumericTask(
    path.join(buildRoot, "pass1"),
    loaded.windows.map((window) => window.id),
    target,
    pass1Bindings,
  );
  const pass1 = computeBuildStatus(loaded.windows, loaded.byLid, loaded.source, pass1Artifacts, profile);
  const pass1Closed = profileArtifactMatches(path.join(target.workspace_dir, "profile_metadata.json"), target)
    && existsSync(path.join(target.workspace_dir, "long_range_candidates.json"))
    && pass1.pending.length === 0
    && pass1GraphMatchesClosedBase(
      path.join(target.workspace_dir, "base.json"),
      pass1.done,
      pass1Artifacts,
      loaded.lidNodes,
    );
  stages.push(stageState("pass1", pass1.pending, pass1Closed, pass1WorkUnits));
  if (pass1.pending.length || !pass1Closed) return { target, stages };

  if (target.profile_id === "paper") {
    const metadataPlan = routePaperMetadataWorkUnits({
      target: target.target_ref,
      windows: loaded.windows,
      byLid: loaded.byLid,
      source: loaded.source,
      policy_fingerprint: automaticBuildExtractionPolicy("paper_metadata", profile, qualityProfile),
    });
    const metadataWorkUnits = metadataPlan.work_units;
    const metadataBindings = bindingsFromDescriptors(metadataWorkUnits);
    const eligibleMetadataIds = metadataWorkUnits
      .filter((unit) => !unit.deterministic_skip)
      .map((unit) => Number(unit.work_unit_id));
    const metadataMeta = artifactMetaByNumericTask(
      path.join(buildRoot, "paper-metadata"),
      eligibleMetadataIds,
      target,
      "paper_metadata",
      metadataBindings,
    );
    const metadata = computePaperMetadataRoutingStatus(metadataPlan, metadataMeta);
    const metadataClosed = profileArtifactMatches(path.join(target.workspace_dir, "paper_metadata.json"), target);
    stages.push(stageState("paper_metadata", metadata.pending_ids, metadataClosed, metadataWorkUnits));
    if (metadata.pending || !metadataClosed) return { target, stages };

    const lexiconPlan = routePaperLexiconWorkUnits({
      target: target.target_ref,
      windows: loaded.windows,
      byLid: loaded.byLid,
      source: loaded.source,
      policy_fingerprint: automaticBuildExtractionPolicy("paper_lexicon", profile, qualityProfile),
    });
    const lexiconWorkUnits = lexiconPlan.work_units;
    const lexiconBindings = bindingsFromDescriptors(lexiconWorkUnits);
    const eligibleLexiconIds = lexiconWorkUnits
      .filter((unit) => !unit.deterministic_skip)
      .map((unit) => unit.work_unit_id);
    const lexiconMeta = artifactMetaByWorkUnit(
      path.join(buildRoot, "paper-lexicon"),
      eligibleLexiconIds,
      target,
      "paper_lexicon",
      lexiconBindings,
    );
    const lexicon = computePaperLexiconRoutingStatus(lexiconPlan, lexiconMeta);
    const lexiconClosed = profileArtifactMatches(path.join(target.workspace_dir, "paper_lexicon.json"), target);
    stages.push(stageState("paper_lexicon", lexicon.pending_ids, lexiconClosed, lexiconWorkUnits));
    if (lexicon.pending || !lexiconClosed) return { target, stages };
  }

  const sidecarPlan = routeProfileSidecarWorkUnits({
    target: target.target_ref,
    windows: loaded.windows,
    byLid: loaded.byLid,
    source: loaded.source,
    content_profile: profile,
    policy_fingerprint: automaticBuildExtractionPolicy("profile_sidecar", profile, qualityProfile),
  });
  const sidecarWorkUnits = sidecarPlan.work_units;
  const sidecarBindings = bindingsFromDescriptors(sidecarWorkUnits);
  const eligibleSidecarIds = sidecarWorkUnits
    .filter((unit) => !unit.deterministic_skip)
    .map((unit) => unit.work_unit_id);
  const sidecarMeta = artifactMetaByWorkUnit(
    path.join(buildRoot, "profile-sidecar"),
    eligibleSidecarIds,
    target,
    "profile_sidecar",
    sidecarBindings,
  );
  const sidecar = computeProfileSidecarRoutingStatus(sidecarPlan, sidecarMeta);
  const sidecarClosed = profileArtifactMatches(path.join(target.workspace_dir, "discourse_index.json"), target)
    && profileArtifactMatches(path.join(target.workspace_dir, "formula_semantics.json"), target);
  stages.push(stageState("profile_sidecar", sidecar.pending_ids, sidecarClosed, sidecarWorkUnits));
  if (sidecar.pending || !sidecarClosed) return { target, stages };

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
  const pass2Bindings = taskBindings("pass2", profile, qualityProfile, [...packets.entries()].map(([id, packet]) => ({
    task_id: id,
    input_hash: pass2PacketHash(packet),
  })));
  const pass2WorkUnits = [...packets.entries()].map(([id, packet]) => descriptorFromBinding({
    target,
    stage: "pass2",
    task_id: String(id),
    kind: "pass2_candidate_batch",
    binding: pass2Bindings[String(id)],
    evidence_lids: packet.source_window.leaf_lids,
    estimated_input_tokens: estimateTokens(JSON.stringify(packet)),
    formula_lids: packet.source_formula_semantics.length,
    candidate_count: packet.candidate_targets.length,
    expected_output_items: packet.candidate_targets.length,
    legacy_artifact_ref: `.build/pass2/${id}.json`,
  }));
  const pass2Meta = artifactMetaByNumericTask(
    path.join(buildRoot, "pass2"),
    loaded.windows.map((window) => window.id),
    target,
    "pass2",
    pass2Bindings,
  );
  const pass2 = computePass2Status(packets, pass2Meta);
  const pass2Closed = profileArtifactMatches(path.join(target.workspace_dir, "pass2_audit.json"), target);
  stages.push(stageState("pass2", pass2.pending, pass2Closed, pass2WorkUnits));
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
  const structurePolicy = automaticBuildExtractionPolicy("book_structure", profile, qualityProfile);
  const structureBindings: Record<string, AutomaticBuildTaskPolicyBindingV1> = Object.fromEntries(unitSources.map((unit) => [unit.job_id, {
    input_hash: bookStructureUnitHash(unit),
    policy_fingerprint: structurePolicy,
  }]));
  const structureWorkUnits = unitSources.map((unit) => descriptorFromBinding({
    target,
    stage: "book_structure",
    task_id: unit.job_id,
    kind: "structure_unit",
    binding: structureBindings[unit.job_id],
    evidence_lids: unit.leaf_lids,
    estimated_input_tokens: estimateTokens(JSON.stringify(unit)),
    formula_lids: unit.formula_semantics.length,
    candidate_count: unit.pass2_edges.length,
    expected_output_items: 1,
    legacy_artifact_ref: `.build/book-structure/units/${unit.unit_lid}.json`,
  }));
  for (const unit of unitSources) {
    const file = path.join(buildRoot, "book-structure", "units", `${unit.unit_lid}.json`);
    if (!existsSync(file)) {
      allUnitsFresh = false;
      continue;
    }
    const artifact = freshSemanticPayload<BookStructureUnitArtifact>(file, semanticExpectation(
      target,
      "book_structure",
      unit.job_id,
      structureBindings[unit.job_id],
    ));
    if (!artifact) {
      allUnitsFresh = false;
      continue;
    }
    unitMeta.set(unit.job_id, { content_hash: artifact.content_hash });
    if (artifact.content_hash === bookStructureUnitHash(unit)) unitArtifacts.push(artifact);
    else allUnitsFresh = false;
  }
  const stitchPacket = allUnitsFresh && unitArtifacts.length === unitSources.length
    ? buildBookStructureStitchPacket(unitArtifacts, pass2Audit, profile)
    : undefined;
  if (stitchPacket) structureBindings.stitch = {
    input_hash: bookStructureStitchHash(stitchPacket),
    policy_fingerprint: structurePolicy,
  };
  if (stitchPacket) structureWorkUnits.push(descriptorFromBinding({
    target,
    stage: "book_structure",
    task_id: "stitch",
    kind: "structure_stitch",
    binding: structureBindings.stitch,
    evidence_lids: [...new Set(stitchPacket.unit_cards.flatMap((unit) => unit.evidence_lids))],
    estimated_input_tokens: estimateTokens(JSON.stringify(stitchPacket)),
    candidate_count: stitchPacket.unit_cards.length,
    expected_output_items: stitchPacket.unit_cards.length,
    legacy_artifact_ref: ".build/book-structure/stitch.json",
  }));
  const stitchFile = path.join(buildRoot, "book-structure", "stitch.json");
  const stitchArtifact = existsSync(stitchFile) && structureBindings.stitch
    ? freshSemanticPayload<BookStructureStitchArtifact>(stitchFile, semanticExpectation(
        target,
        "book_structure",
        "stitch",
        structureBindings.stitch,
      ))
    : undefined;
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
  stages.push(stageState("book_structure", structureTasks, structureClosed, structureWorkUnits));
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
      const selectedWorkUnits = stage.pending_work_units?.slice(0, maxParallel) ?? [];
      const selectedTaskIds = selectedWorkUnits.length
        ? selectedWorkUnits.map((unit) => unit.work_unit_id)
        : stage.pending_tasks.slice(0, maxParallel);
      return {
        kind: "extract",
        stage: stage.stage,
        extractor,
        task_ids: selectedTaskIds,
        max_attempts: 3,
        ...(selectedWorkUnits.length ? { work_units: selectedWorkUnits } : {}),
        ...(stage.task_bindings ? {
          task_bindings: Object.fromEntries(selectedTaskIds.map((taskId) => [
            taskId,
            stage.task_bindings![taskId],
          ])),
        } : {}),
      };
    }
    return { kind: "close_stage", stage: stage.stage };
  }
  return { kind: "done", book_id: snapshot.target.book_id, workspace_dir: snapshot.target.workspace_dir };
}
