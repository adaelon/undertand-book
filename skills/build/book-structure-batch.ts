// PB7 BookStructure batch: close unit-card + stitch outputs into book_structure.json.
//   tsx skills/build/book-structure-batch.ts <book.md|epub> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  buildBookStructureSidecar,
  type BookStructureStitchArtifact,
} from "../../packages/core/src/book-structure";
import {
  buildAutomaticBuildSnapshot,
  resolveAutomaticBuildTarget,
} from "../../packages/core/src/build-orchestrator";
import {
  readBookStructureGenerationArtifact,
  readBookStructureGenerationTask,
} from "../../packages/core/src/book-structure-generation";
import { buildReproducibleProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import type { ExtractionQualityProfile } from "../../packages/core/src/semantic-artifact";
import { BookStructureSidecarZ } from "../../packages/core/src/zod";
import { computeCurrentBookStructureStatus, loadBookStructureBuildContext, parseBookStructureArgs } from "./book-structure-common";
import {
  buildAutomaticBuildStageBatchResult,
  publishAutomaticBuildArtifactSet,
} from "../../packages/core/src/automatic-build-publication";
import { canonicalAutomaticBuildJson } from "../../packages/core/src/automatic-build-protocol";

const argv = process.argv.slice(2);
const productionPolicyContractsIndex = argv.indexOf("--production-policy-contracts");
const productionPolicyContractsJson = productionPolicyContractsIndex >= 0
  ? argv[productionPolicyContractsIndex + 1]
  : undefined;
const qualityProfileIndex = argv.indexOf("--quality-profile");
const productionQualityProfile = qualityProfileIndex >= 0
  ? argv[qualityProfileIndex + 1]
  : "full";
if ((productionPolicyContractsIndex >= 0
    && (!productionPolicyContractsJson || productionPolicyContractsJson.startsWith("--")))
  || (qualityProfileIndex >= 0
    && (!productionQualityProfile || productionQualityProfile.startsWith("--")))) {
  console.error("--production-policy-contracts and --quality-profile each require a value");
  process.exit(2);
}
if (!( ["full", "balanced", "sparse"] as string[]).includes(productionQualityProfile)) {
  throw new Error(`unsupported --quality-profile ${productionQualityProfile}`);
}

const { book, override, contentProfile } = parseBookStructureArgs(argv);
if (!book) {
  console.error("usage: tsx book-structure-batch.ts <book.md|epub> [--book-id <id>] [--production-policy-contracts <json>] [--quality-profile full|balanced|sparse] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]");
  process.exit(2);
}

const ctx = loadBookStructureBuildContext(book, override, contentProfile);
let stitchArtifact: BookStructureStitchArtifact;
if (productionPolicyContractsJson) {
  const target = resolveAutomaticBuildTarget(book, process.cwd(), {
    ...(override ? { book_id: override } : {}),
  });
  if (path.resolve(target.workspace_dir) !== path.resolve(ctx.baseDir)) {
    throw new Error("production BookStructure target does not match its resolved output workspace");
  }
  const snapshot = buildAutomaticBuildSnapshot(target, {
    quality_profile: productionQualityProfile as ExtractionQualityProfile,
  });
  const stage = snapshot.stages.find((candidate) => candidate.stage === "book_structure");
  const expectedPolicyContracts = JSON.parse(productionPolicyContractsJson) as unknown;
  const currentPolicyContracts = stage?.policy_set?.members.map((member) => ({
    kind: member.kind,
    policy_generation_id: member.policy_generation_id,
    semantic_contract: member.semantic_contract,
  }));
  if (!stage?.policy_set
    || canonicalAutomaticBuildJson(currentPolicyContracts)
      !== canonicalAutomaticBuildJson(expectedPolicyContracts)) {
    throw new Error("production BookStructure generation does not match the current policy set");
  }
  if (stage.pending_tasks.length) {
    throw new Error("production BookStructure generation still has pending work units");
  }
  const contributors = stage.quality_routing?.public_contributors ?? [];
  const contributorIds = new Set(contributors.map((contributor) => contributor.contributor_id));
  for (const source of ctx.unitSources) {
    if (!contributorIds.has(`book-structure-unit:${source.unit_lid}`)) {
      throw new Error(`production BookStructure generation is missing unit contributor: ${source.unit_lid}`);
    }
  }
  const stitchContributors = contributors.filter(
    (contributor) => contributor.contributor_id === "book-structure:stitch",
  );
  if (stitchContributors.length !== 1) {
    throw new Error("production BookStructure generation must have exactly one stitch contributor");
  }
  const stitchWorkUnitId = stitchContributors[0].work_unit_id;
  const generation = stage.generation_tasks?.[stitchWorkUnitId];
  if (generation?.kind !== "book_structure") {
    throw new Error("production BookStructure stitch contributor has no frozen task");
  }
  const task = readBookStructureGenerationTask(
    target,
    generation.task.policy_generation_id,
    stitchWorkUnitId,
  );
  if (!task || task.output_role !== "stitch_artifact") {
    throw new Error("production BookStructure stitch task is missing or not final");
  }
  const artifact = readBookStructureGenerationArtifact(target, task);
  if (!artifact
    || !artifact.payload
    || typeof artifact.payload !== "object"
    || !("content_hash" in artifact.payload)
    || !("output" in artifact.payload)) {
    throw new Error("production BookStructure stitch artifact is missing or invalid");
  }
  stitchArtifact = artifact.payload as BookStructureStitchArtifact;
} else {
  const current = computeCurrentBookStructureStatus(ctx);
  if (current.status.unit_pending.length) {
    console.error(`[book-structure-batch] refusing close: ${current.status.unit_pending.length}/${ctx.unitSources.length} unit jobs pending`);
    console.error(`  pending unit jobs: ${current.status.unit_pending.join(",")}`);
    process.exit(1);
  }
  if (!current.status.stitch_done || !current.stitchArtifact) {
    console.error("[book-structure-batch] refusing close: stitch output missing or stale");
    console.error(`  emit with: tsx skills/build/book-structure-input.ts ${book} stitch`);
    console.error(`  write with: tsx skills/build/book-structure-write.ts ${book} stitch <subagent-output.json>`);
    process.exit(1);
  }
  stitchArtifact = current.stitchArtifact;
}

const header = buildReproducibleProfileArtifactHeader({ book_id: ctx.bookId, content_profile: contentProfile.id });
const result = buildBookStructureSidecar(header, stitchArtifact.output, ctx.lidNodes);
BookStructureSidecarZ.parse(result.sidecar);
mkdirSync(ctx.baseDir, { recursive: true });
const outPath = `${ctx.baseDir}/book_structure.json`;
const publicationReceipt = publishAutomaticBuildArtifactSet({
  workspace_dir: ctx.baseDir,
  stage: "book_structure",
  artifacts: { "book_structure.json": JSON.stringify(result.sidecar, null, 2) },
});

console.error(`[book-structure-batch] ${book}  bookId=${ctx.bookId}  content_profile=${contentProfile.id}`);
console.error(`  units=${ctx.unitSources.length} stitch=done`);
console.error(`  book_structure.json spine=${result.sidecar.spine.length} throughlines=${result.sidecar.throughlines.length} key_stops=${result.sidecar.key_stops.length} dropped=${result.dropped.length}`);
console.error(`  wrote: ${outPath}`);
process.stdout.write(`${JSON.stringify(buildAutomaticBuildStageBatchResult(publicationReceipt))}\n`);
