import { existsSync, readFileSync } from "node:fs";
import type { ReadOnlyBase } from "../../packages/core/src/generated/ReadOnlyBase";
import type { FormulaSemantics } from "../../packages/core/src/generated/FormulaSemantics";
import type { TechnicalLearningDiscourseIndex } from "../../packages/core/src/discourse-index";
import type {
  BookStructureStitchArtifact,
  BookStructureStitchPacket,
  BookStructureUnitArtifact,
  BookStructureUnitSource,
} from "../../packages/core/src/book-structure";
import {
  bookStructureUnitHash,
  buildBookStructureStitchPacket,
  buildBookStructureUnitSources,
  computeBookStructureStatus,
  type BookStructureStatus,
} from "../../packages/core/src/book-structure";
import type { Pass2BuildAuditSidecar } from "../../packages/core/src/pass2-build";
import { deriveBookId } from "../../packages/core/src/book-id";
import { TECHNICAL_LEARNING_PROFILE, type ContentProfileDefinition } from "../../packages/core/src/content-profile";
import { parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, type LoadedBook } from "./load-book";
import { semanticArtifactPayload } from "../../packages/core/src/semantic-artifact";

export interface BookStructureBuildContext extends LoadedBook {
  bookId: string;
  baseDir: string;
  buildDir: string;
  unitDir: string;
  base: ReadOnlyBase;
  discourseIndex: TechnicalLearningDiscourseIndex;
  formulaSemantics: FormulaSemantics[];
  pass2Audit?: Pass2BuildAuditSidecar;
  unitSources: BookStructureUnitSource[];
  contentProfile: ContentProfileDefinition;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} missing: ${path}`);
}

export function parseBookStructureArgs(argv: string[]): {
  book: string;
  override?: string;
  positional: string[];
  contentProfile: ContentProfileDefinition;
} {
  const parsedProfile = parseContentProfileArgsOrExit(argv, { allowPaperExecution: true });
  const stripped = parsedProfile.argv;
  const positional = stripped.filter((a) => !a.startsWith("--"));
  const book = positional[0];
  const bookIdIdx = stripped.indexOf("--book-id");
  const override = bookIdIdx >= 0 ? stripped[bookIdIdx + 1] : undefined;
  return { book, override, positional, contentProfile: parsedProfile.contentProfile };
}

export function loadBookStructureBuildContext(
  book: string,
  override?: string,
  contentProfile?: ContentProfileDefinition,
): BookStructureBuildContext {
  const loaded = loadBookWindows(book);
  const bookId = deriveBookId(book, override);
  const baseDir = `.understand-book/${bookId}`;
  const buildDir = `${baseDir}/.build/book-structure`;
  const unitDir = `${buildDir}/units`;
  const basePath = `${baseDir}/base.json`;
  const discoursePath = `${baseDir}/discourse_index.json`;
  const formulaPath = `${baseDir}/formula_semantics.json`;
  const pass2Path = `${baseDir}/pass2_audit.json`;
  requireFile(basePath, "base.json");
  requireFile(discoursePath, "discourse_index.json (run profile-sidecar-batch first)");
  requireFile(formulaPath, "formula_semantics.json (run profile-sidecar-batch first)");

  const base = readJson<ReadOnlyBase>(basePath);
  const discourseIndex = readJson<TechnicalLearningDiscourseIndex>(discoursePath);
  const formulaSidecar = readJson<{ items?: FormulaSemantics[] } | FormulaSemantics[]>(formulaPath);
  const formulaSemantics = Array.isArray(formulaSidecar) ? formulaSidecar : formulaSidecar.items ?? [];
  const pass2Audit = existsSync(pass2Path) ? readJson<Pass2BuildAuditSidecar>(pass2Path) : undefined;
  const resolvedContentProfile = contentProfile ?? TECHNICAL_LEARNING_PROFILE;
  const unitSources = buildBookStructureUnitSources({
    lidNodes: loaded.lidNodes,
    source: loaded.source,
    graphNodes: base.graph_nodes,
    graphEdges: base.graph_edges,
    discourseIndex,
    formulaSemantics,
    ...(pass2Audit ? { pass2Audit } : {}),
    contentProfile: resolvedContentProfile,
  });

  return {
    ...loaded,
    bookId,
    baseDir,
    buildDir,
    unitDir,
    base,
    discourseIndex,
    formulaSemantics,
    ...(pass2Audit ? { pass2Audit } : {}),
    unitSources,
    contentProfile: resolvedContentProfile,
  };
}

export function unitArtifactPath(ctx: Pick<BookStructureBuildContext, "unitDir">, unitLid: string): string {
  return `${ctx.unitDir}/${unitLid}.json`;
}

export function stitchArtifactPath(ctx: Pick<BookStructureBuildContext, "buildDir">): string {
  return `${ctx.buildDir}/stitch.json`;
}

export function findUnitSource(ctx: BookStructureBuildContext, jobId: string): BookStructureUnitSource {
  const source = ctx.unitSources.find((item) => item.job_id === jobId || item.unit_lid === jobId);
  if (!source) {
    const ids = ctx.unitSources.map((item) => item.job_id);
    throw new Error(`unknown BookStructure unit job "${jobId}". valid jobs: ${ids.join(", ")}`);
  }
  return source;
}

export function readUnitArtifacts(ctx: BookStructureBuildContext): Map<string, BookStructureUnitArtifact> {
  const artifacts = new Map<string, BookStructureUnitArtifact>();
  for (const source of ctx.unitSources) {
    const path = unitArtifactPath(ctx, source.unit_lid);
    if (!existsSync(path)) continue;
    artifacts.set(source.job_id, semanticArtifactPayload<BookStructureUnitArtifact>(readJson(path)));
  }
  return artifacts;
}

export function readStitchArtifact(ctx: BookStructureBuildContext): BookStructureStitchArtifact | undefined {
  const path = stitchArtifactPath(ctx);
  return existsSync(path) ? semanticArtifactPayload<BookStructureStitchArtifact>(readJson(path)) : undefined;
}

export function buildFreshStitchPacket(ctx: BookStructureBuildContext): BookStructureStitchPacket | undefined {
  const artifacts = readUnitArtifacts(ctx);
  const unitArtifacts: BookStructureUnitArtifact[] = [];
  for (const source of ctx.unitSources) {
    const artifact = artifacts.get(source.job_id);
    if (!artifact || artifact.content_hash !== bookStructureUnitHash(source)) return undefined;
    unitArtifacts.push(artifact);
  }
  return buildBookStructureStitchPacket(unitArtifacts, ctx.pass2Audit, ctx.contentProfile);
}

export function computeCurrentBookStructureStatus(ctx: BookStructureBuildContext): {
  status: BookStructureStatus;
  stitchPacket?: BookStructureStitchPacket;
  stitchArtifact?: BookStructureStitchArtifact;
} {
  const unitArtifacts = readUnitArtifacts(ctx);
  const unitMeta = new Map([...unitArtifacts.entries()].map(([id, artifact]) => [id, { content_hash: artifact.content_hash }]));
  const stitchPacket = buildFreshStitchPacket(ctx);
  const stitchArtifact = readStitchArtifact(ctx);
  const status = computeBookStructureStatus(
    ctx.unitSources,
    unitMeta,
    stitchArtifact ? { content_hash: stitchArtifact.content_hash } : undefined,
    stitchPacket,
  );
  return { status, stitchPacket, stitchArtifact };
}
