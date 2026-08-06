// PB6 profile-sidecar batch: close the independent sidecar pass only.
//   tsx skills/build/profile-sidecar-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] [--content-profile technical_learning]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { deriveBookId } from "../../packages/core/src/book-id";
import {
  buildAutomaticBuildSnapshot,
  resolveAutomaticBuildTarget,
} from "../../packages/core/src/build-orchestrator";
import { buildReproducibleProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import { buildTechnicalLearningDiscourseIndex, type TechnicalLearningDiscourseItem } from "../../packages/core/src/discourse-index";
import { buildFormulaSemanticsSidecar, type FormulaSemanticsBuildCandidate } from "../../packages/core/src/formula-semantics";
import { FormulaSemanticsSidecarZ, TechnicalLearningDiscourseIndexZ } from "../../packages/core/src/zod";
import type { ProfileSidecarArtifact } from "../../packages/core/src/profile-sidecar-build";
import { computeProfileSidecarCandidateStatus } from "../../packages/core/src/profile-sidecar-router";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";
import {
  semanticArtifactPayload,
  type ExtractionQualityProfile,
} from "../../packages/core/src/semantic-artifact";
import {
  buildAutomaticBuildStageBatchResult,
  publishAutomaticBuildArtifactSet,
} from "../../packages/core/src/automatic-build-publication";
import {
  assertProfileSidecarProductionCandidatePath,
  readProfileSidecarProductionTask,
  readProfileSidecarDiscourseShadowTask,
  writeProfileSidecarProductionCandidate,
  writeProfileSidecarDiscourseFinalCandidate,
} from "../../packages/core/src/profile-sidecar-reduction";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const allowPartial = argv.includes("--allow-partial");
const shadowGenerationIdx = argv.indexOf("--shadow-generation");
const shadowGeneration = shadowGenerationIdx >= 0 ? argv[shadowGenerationIdx + 1] : undefined;
const shadowFinalIdx = argv.indexOf("--shadow-final");
const shadowFinal = shadowFinalIdx >= 0 ? argv[shadowFinalIdx + 1] : undefined;
const productionGenerationIdx = argv.indexOf("--production-generation");
const productionGeneration = productionGenerationIdx >= 0 ? argv[productionGenerationIdx + 1] : undefined;
const qualityProfileIdx = argv.indexOf("--quality-profile");
const productionQualityProfile = qualityProfileIdx >= 0 ? argv[qualityProfileIdx + 1] : "full";
if ((shadowGenerationIdx >= 0 && (!shadowGeneration || shadowGeneration.startsWith("--")))
  || (shadowFinalIdx >= 0 && (!shadowFinal || shadowFinal.startsWith("--")))
  || (productionGenerationIdx >= 0 && (!productionGeneration || productionGeneration.startsWith("--")))
  || (qualityProfileIdx >= 0 && (!productionQualityProfile || productionQualityProfile.startsWith("--")))) {
  console.error("--shadow-generation, --shadow-final, --production-generation, and --quality-profile each require a value");
  process.exit(2);
}
if (!( ["full", "balanced", "sparse"] as string[]).includes(productionQualityProfile)) {
  throw new Error(`unsupported --quality-profile ${productionQualityProfile}`);
}
if (Boolean(shadowGeneration) !== Boolean(shadowFinal)) {
  console.error("--shadow-generation and --shadow-final must be provided together");
  process.exit(2);
}
if (productionGeneration && (shadowGeneration || shadowFinal)) {
  throw new Error("--production-generation cannot be combined with --shadow-generation/--shadow-final");
}
if (!book) {
  console.error(`usage: tsx profile-sidecar-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] [--shadow-generation <policy-set-sha256> --shadow-final <workUnitId>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, lidNodes, byLid, windows } = loadBookWindows(book);
if (shadowGeneration && shadowFinal) {
  if (allowPartial) throw new Error("--allow-partial is not valid for a shadow final candidate");
  const target = resolveAutomaticBuildTarget(book, process.cwd(), { ...(override ? { book_id: override } : {}) });
  const task = readProfileSidecarDiscourseShadowTask(target, shadowGeneration, shadowFinal);
  const result = writeProfileSidecarDiscourseFinalCandidate({ target, source, task });
  console.log(JSON.stringify({
    version: result.version,
    work_unit_id: result.work_unit_id,
    parent_lid: result.parent_lid,
    candidate_path: result.candidate_path,
    candidate_sha256: result.candidate_sha256,
  }));
} else {
  const bookId = deriveBookId(book, override);
  const buildDir = `.understand-book/${bookId}/.build/profile-sidecar`;
  const initial = computeProfileSidecarCandidateStatus({
    windows,
    byLid,
    source,
    content_profile: parsedProfile.contentProfile,
    existing: new Map(),
    allow_over_limit_packets: Boolean(productionGeneration),
  });
  const discourseItems: TechnicalLearningDiscourseItem[] = [];
  const formulaCandidates: FormulaSemanticsBuildCandidate[] = [];
  let committed: number;
  let pending: number;
  let eligible: number;
  let skipped: number;
  if (productionGeneration) {
    if (allowPartial) throw new Error("--allow-partial is not valid for a production v3 generation");
    const target = resolveAutomaticBuildTarget(book, process.cwd(), { ...(override ? { book_id: override } : {}) });
    const outDir = path.resolve(`.understand-book/${bookId}`);
    if (path.resolve(target.workspace_dir) !== outDir) {
      throw new Error("production profile-sidecar target does not match its resolved output workspace");
    }
    const snapshot = buildAutomaticBuildSnapshot(target, {
      quality_profile: productionQualityProfile as ExtractionQualityProfile,
    });
    const stage = snapshot.stages.find((candidate) => candidate.stage === "profile_sidecar");
    if (!stage?.policy_set || stage.policy_set.policy_set_digest !== productionGeneration) {
      throw new Error("production profile-sidecar generation does not match the current policy set");
    }
    if (stage.pending_tasks.length) {
      throw new Error("production profile-sidecar generation still has pending work units");
    }
    const contributors = stage.quality_routing?.public_contributors ?? [];
    if (!contributors.length) {
      throw new Error("production profile-sidecar generation has no public contributors");
    }
    const seen = new Set<string>();
    for (const contributor of contributors) {
      if (seen.has(contributor.work_unit_id)) {
        throw new Error(`duplicate production profile-sidecar contributor: ${contributor.work_unit_id}`);
      }
      seen.add(contributor.work_unit_id);
      const task = readProfileSidecarProductionTask(
        target,
        productionGeneration,
        contributor.work_unit_id,
      );
      const result = writeProfileSidecarProductionCandidate({ target, source, task });
      const candidatePath = assertProfileSidecarProductionCandidatePath({
        target,
        task,
        candidate_path: result.candidate_path,
      });
      const artifact = JSON.parse(readFileSync(candidatePath, "utf8")) as ProfileSidecarArtifact;
      if (typeof artifact.content_hash !== "string"
        || !Array.isArray(artifact.discourse_items)
        || !Array.isArray(artifact.formula_semantics)) {
        throw new Error(`production profile-sidecar public candidate is invalid: ${contributor.work_unit_id}`);
      }
      discourseItems.push(...artifact.discourse_items);
      formulaCandidates.push(...artifact.formula_semantics);
    }
    committed = contributors.length;
    pending = 0;
    eligible = contributors.length;
    skipped = initial.skipped;
  } else {
    const existing = new Map<string, Pass1ArtifactMeta>();
    const artifacts = new Map<string, ProfileSidecarArtifact>();
    for (const workUnitId of Object.keys(initial.analysis.packets)) {
      const f = `${buildDir}/${workUnitId}.json`;
      if (!existsSync(f)) continue;
      const artifact = semanticArtifactPayload<ProfileSidecarArtifact>(JSON.parse(readFileSync(f, "utf8")));
      artifacts.set(workUnitId, artifact);
      if (typeof artifact?.content_hash === "string") existing.set(workUnitId, { content_hash: artifact.content_hash });
    }

    const status = computeProfileSidecarCandidateStatus({ windows, byLid, source, content_profile: parsedProfile.contentProfile, existing });
    if (status.pending && !allowPartial) {
      console.error(`[profile-sidecar-batch] refusing close: ${status.pending}/${status.eligible} semantic units pending`);
      console.error(`  pending ids: ${status.pending_ids.join(",")}`);
      console.error("  resume with profile-sidecar-input + extractor + profile-sidecar-write; use --allow-partial only for smoke/emergency");
      process.exit(1);
    }
    for (const id of status.done_ids) {
      const artifact = artifacts.get(id)!;
      discourseItems.push(...(artifact.discourse_items ?? []));
      formulaCandidates.push(...(artifact.formula_semantics ?? []));
    }
    committed = status.committed;
    pending = status.pending;
    eligible = status.eligible;
    skipped = status.skipped;
  }

  const header = buildReproducibleProfileArtifactHeader({ book_id: bookId, content_profile: parsedProfile.contentProfile.id });
  const discourse = buildTechnicalLearningDiscourseIndex(header, discourseItems, lidNodes);
  const formula = buildFormulaSemanticsSidecar(header, formulaCandidates, lidNodes);
  TechnicalLearningDiscourseIndexZ.parse(discourse.sidecar);
  FormulaSemanticsSidecarZ.parse(formula.sidecar);

  const outDir = `.understand-book/${bookId}`;
  mkdirSync(outDir, { recursive: true });
  const publicationReceipt = publishAutomaticBuildArtifactSet({
    workspace_dir: outDir,
    stage: "profile_sidecar",
    artifacts: {
      "discourse_index.json": JSON.stringify(discourse.sidecar, null, 2),
      "formula_semantics.json": JSON.stringify(formula.sidecar, null, 2),
    },
  });

  console.error(`[profile-sidecar-batch] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}${allowPartial && pending ? "  [--allow-partial]" : ""}`);
  console.error(`  discourse_lids=${initial.analysis.accounting.discourse_eligible_lids} groups=${initial.analysis.accounting.discourse_groups} formula_total=${initial.analysis.accounting.formula_total} formula_eligible=${initial.analysis.accounting.formula_eligible} skipped=${skipped} done=${committed}/${eligible} pending=${pending}`);
  console.error(`  discourse_index.json items=${discourse.sidecar.items.length} dropped=${discourse.dropped.length}`);
  console.error(`  formula_semantics.json items=${formula.sidecar.items.length} pending=${formula.pending.length}`);
  process.stdout.write(`${JSON.stringify(buildAutomaticBuildStageBatchResult(publicationReceipt))}\n`);
}
