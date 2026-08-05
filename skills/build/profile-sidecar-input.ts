// PB6 profile-sidecar input: same window text as Pass1, plus deterministic formula_lids.
//   tsx skills/build/profile-sidecar-input.ts <book.md|epub> <windowId> [--book-id <id>] [--content-profile technical_learning]
import { analyzeProfileSidecarSemanticUnits } from "../../packages/core/src/profile-sidecar-router";
import { renderProfileSidecarModelInput } from "../../packages/core/src/model-input-renderer";
import {
  readProfileSidecarProductionTask,
  replayProfileSidecarDiscourseShadowInput,
  replayProfileSidecarSemanticFastPathInput,
} from "../../packages/core/src/profile-sidecar-reduction";
import { resolveAutomaticBuildTarget } from "../../packages/core/src/build-orchestrator";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, workUnitId] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const shadowGenerationIdx = argv.indexOf("--shadow-generation");
const shadowGeneration = shadowGenerationIdx >= 0 ? argv[shadowGenerationIdx + 1] : undefined;
if (shadowGenerationIdx >= 0 && (!shadowGeneration || shadowGeneration.startsWith("--"))) {
  console.error("--shadow-generation requires a policy-set SHA-256 digest");
  process.exit(2);
}
if (!book || workUnitId === undefined) {
  console.error(`usage: tsx profile-sidecar-input.ts <book.md|epub> <workUnitId> [--book-id <id>] [--shadow-generation <policy-set-sha256>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
if (shadowGeneration) {
  const target = resolveAutomaticBuildTarget(book, process.cwd(), { ...(override ? { book_id: override } : {}) });
  const task = readProfileSidecarProductionTask(target, shadowGeneration, workUnitId);
  const replayed = task.version === "profile_sidecar_semantic_fast_path_task.v1"
    ? replayProfileSidecarSemanticFastPathInput({ target, source, task })
    : replayProfileSidecarDiscourseShadowInput({ target, source, task });
  process.stdout.write(replayed.rendered_input);
  const route = task.version === "profile_sidecar_semantic_fast_path_task.v1"
    ? `kind=${task.packet.unit_kind}`
    : `role=${task.route.role}`;
  process.stderr.write(`[profile-sidecar-input] ${workUnitId}: shadow_generation=${shadowGeneration.slice(0, 12)} ${route} content_profile=${parsedProfile.contentProfile.id}\n`);
} else {
  const routing = analyzeProfileSidecarSemanticUnits({ windows, byLid, source, content_profile: parsedProfile.contentProfile });
  const input = routing.packets[workUnitId];
  if (!input) throw new Error(`profile sidecar work unit is not model-eligible: ${workUnitId}`);

  process.stdout.write(renderProfileSidecarModelInput(input));
  process.stderr.write(`[profile-sidecar-input] ${workUnitId}: kind=${input.unit_kind} content_profile=${parsedProfile.contentProfile.id} lids=${input.visible_lids.length} formulas=${input.formula_lids.length}\n`);
}
