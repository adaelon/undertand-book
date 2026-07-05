// PP3 paper lexicon input: same window text as Pass1 plus requested term types.
//   tsx skills/build/paper-lexicon-input.ts <book.md|epub> <windowId> [--book-id <id>] --content-profile paper
import { buildPaperLexiconWindowInput } from "../../packages/core/src/paper-lexicon";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2), "paper lexicon build");
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr] = positional;
if (!book || idStr === undefined) {
  console.error(`usage: tsx paper-lexicon-input.ts <book.md|epub> <windowId> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const w = windowById(windows, id);
const input = buildPaperLexiconWindowInput(w, byLid, source);

console.log("PAPER_LEXICON_WINDOW");
console.log(`window_id: ${input.window_id}`);
console.log(`visible_lids: ${JSON.stringify(input.visible_lids)}`);
console.log(`requested_term_types: ${JSON.stringify(input.requested_term_types)}`);
console.log("");
console.log("TEXT");
console.log(input.text);
process.stderr.write(
  `[paper-lexicon-input] window ${id}: content_profile=${parsedProfile.contentProfile.id} lids=${input.visible_lids.length}\n`,
);
