// PB6 profile-sidecar input: same window text as Pass1, plus deterministic formula_lids.
//   tsx skills/build/profile-sidecar-input.ts <book.md|epub> <windowId> [--book-id <id>]
import { buildProfileSidecarWindowInput } from "../../packages/core/src/profile-sidecar-build";
import { loadBookWindows, windowById } from "./load-book";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr] = positional;
if (!book || idStr === undefined) {
  console.error("usage: tsx profile-sidecar-input.ts <book.md|epub> <windowId> [--book-id <id>]");
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const w = windowById(windows, id);
const input = buildProfileSidecarWindowInput(w, byLid, source);

console.log("PROFILE_SIDECAR_WINDOW");
console.log(`window_id: ${input.window_id}`);
console.log(`visible_lids: ${JSON.stringify(input.visible_lids)}`);
console.log(`formula_lids: ${JSON.stringify(input.formula_lids)}`);
console.log("");
console.log("TEXT");
console.log(input.text);
process.stderr.write(`[profile-sidecar-input] window ${id}: lids=${input.visible_lids.length} formulas=${input.formula_lids.length}\n`);
