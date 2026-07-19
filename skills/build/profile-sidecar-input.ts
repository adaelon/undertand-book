// PB6 profile-sidecar input: same window text as Pass1, plus deterministic formula_lids.
//   tsx skills/build/profile-sidecar-input.ts <book.md|epub> <windowId> [--book-id <id>] [--content-profile technical_learning]
import { analyzeProfileSidecarSemanticUnits } from "../../packages/core/src/profile-sidecar-router";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, workUnitId] = positional;
if (!book || workUnitId === undefined) {
  console.error(`usage: tsx profile-sidecar-input.ts <book.md|epub> <workUnitId> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const routing = analyzeProfileSidecarSemanticUnits({ windows, byLid, source, content_profile: parsedProfile.contentProfile });
const input = routing.packets[workUnitId];
if (!input) throw new Error(`profile sidecar work unit is not model-eligible: ${workUnitId}`);

console.log("PROFILE_SIDECAR_SEMANTIC_UNIT");
console.log(`work_unit_id: ${input.work_unit_id}`);
console.log(`unit_kind: ${input.unit_kind}`);
console.log(`visible_lids: ${JSON.stringify(input.visible_lids)}`);
console.log(`formula_lids: ${JSON.stringify(input.formula_lids)}`);
console.log("");
console.log("TEXT");
console.log(input.text);
process.stderr.write(`[profile-sidecar-input] ${workUnitId}: kind=${input.unit_kind} content_profile=${parsedProfile.contentProfile.id} lids=${input.visible_lids.length} formulas=${input.formula_lids.length}\n`);
