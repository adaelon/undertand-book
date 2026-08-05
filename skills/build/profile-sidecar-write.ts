// PB6 profile-sidecar write: normalize one subagent output and atomically persist it.
//   tsx skills/build/profile-sidecar-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>] [--content-profile technical_learning]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { resolveAutomaticBuildTarget } from "../../packages/core/src/build-orchestrator";
import { analyzeProfileSidecarSemanticUnits, buildProfileSidecarSemanticArtifact } from "../../packages/core/src/profile-sidecar-router";
import {
  assertProfileSidecarProductionCandidatePath,
  readProfileSidecarProductionTask,
  writeProfileSidecarDiscourseShadowCandidate,
  writeProfileSidecarSemanticFastPathCandidate,
} from "../../packages/core/src/profile-sidecar-reduction";
import { parseExtractorCandidate } from "../../packages/core/src/extractor-contract";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, workUnitId, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const shadowGenerationIdx = argv.indexOf("--shadow-generation");
const shadowGeneration = shadowGenerationIdx >= 0 ? argv[shadowGenerationIdx + 1] : undefined;
if (shadowGenerationIdx >= 0 && (!shadowGeneration || shadowGeneration.startsWith("--"))) {
  console.error("--shadow-generation requires a policy-set SHA-256 digest");
  process.exit(2);
}
if (!book || workUnitId === undefined || !outputPath) {
  console.error(`usage: tsx profile-sidecar-write.ts <book.md|epub> <workUnitId> <subagent-output.json> [--book-id <id>] [--shadow-generation <policy-set-sha256>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
if (shadowGeneration) {
  const target = resolveAutomaticBuildTarget(book, process.cwd(), { ...(override ? { book_id: override } : {}) });
  const task = readProfileSidecarProductionTask(target, shadowGeneration, workUnitId);
  const candidatePath = assertProfileSidecarProductionCandidatePath({
    target,
    task,
    candidate_path: outputPath,
  });
  const outputText = readFileSync(candidatePath, "utf8").replace(/^\uFEFF/, "");
  const attemptIdx = argv.indexOf("--attempt");
  const attempt = Number(attemptIdx >= 0 ? argv[attemptIdx + 1] : "1");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("--attempt must be a positive safe integer");
  const generatedAtIdx = argv.indexOf("--generated-at");
  const generatedAt = generatedAtIdx >= 0 ? argv[generatedAtIdx + 1] : new Date().toISOString();
  if (!generatedAt || generatedAt.startsWith("--") || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("--generated-at must be an ISO timestamp");
  }
  const executorIdx = argv.indexOf("--executor");
  const executor = executorIdx >= 0 ? argv[executorIdx + 1] : "codex-shadow-executor";
  if (!executor || executor.startsWith("--")) throw new Error("--executor requires a value");
  const modelIdx = argv.indexOf("--model");
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;
  if (modelIdx >= 0 && (!model || model.startsWith("--"))) throw new Error("--model requires a value");
  const provenance = {
    executor,
    ...(model ? { model } : {}),
    attempt,
    generated_at: generatedAt,
  };
  const result = task.version === "profile_sidecar_semantic_fast_path_task.v1"
    ? writeProfileSidecarSemanticFastPathCandidate({
        target,
        source,
        task,
        candidate: JSON.parse(outputText),
        provenance,
      })
    : writeProfileSidecarDiscourseShadowCandidate({
        target,
        source,
        task,
        candidate: JSON.parse(outputText),
        provenance,
      });
  console.log(JSON.stringify(result));
} else {
  const routing = analyzeProfileSidecarSemanticUnits({ windows, byLid, source, content_profile: parsedProfile.contentProfile });
  const packet = routing.packets[workUnitId];
  if (!packet) throw new Error(`profile sidecar work unit is not model-eligible: ${workUnitId}`);
  const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
  const output = parseExtractorCandidate("profile_sidecar", JSON.parse(outputText), {
    allowed_evidence_lids: [...packet.visible_lids],
    formula_lids: [...packet.formula_lids],
  });
  const artifact = buildProfileSidecarSemanticArtifact(packet, output);

  const bookId = deriveBookId(book, override);
  const dir = `.understand-book/${bookId}/.build/profile-sidecar`;
  mkdirSync(dir, { recursive: true });
  const finalPath = `${dir}/${workUnitId}.json`;
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
  renameSync(tmpPath, finalPath);
  console.log(
    `[profile-sidecar-write] ${workUnitId} -> ${finalPath} content_profile=${parsedProfile.contentProfile.id} discourse=${artifact.discourse_items.length} formula=${artifact.formula_semantics.length} hash=${artifact.content_hash.slice(0, 12)}`,
  );
}
