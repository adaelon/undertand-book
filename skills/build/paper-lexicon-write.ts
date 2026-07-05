// PP3 paper lexicon write: normalize one extractor output and atomically persist it.
//   tsx skills/build/paper-lexicon-write.ts <book.md|epub> <windowId> <extractor-output.json> [--book-id <id>] --content-profile paper
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import {
  buildPaperLexiconArtifact,
  type PaperLexiconExtractionOutput,
} from "../../packages/core/src/paper-lexicon";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2), "paper lexicon build");
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book || idStr === undefined || !outputPath) {
  console.error(`usage: tsx paper-lexicon-write.ts <book.md|epub> <windowId> <extractor-output.json> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const w = windowById(windows, id);
const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
const output = JSON.parse(outputText) as PaperLexiconExtractionOutput;
const artifact = buildPaperLexiconArtifact(w, byLid, source, output);

const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/paper-lexicon`;
mkdirSync(dir, { recursive: true });
const finalPath = `${dir}/${id}.json`;
const tmpPath = `${finalPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
renameSync(tmpPath, finalPath);

console.log(
  `[paper-lexicon-write] window ${id} -> ${finalPath} content_profile=${parsedProfile.contentProfile.id} entries=${artifact.entries.length} hash=${artifact.content_hash.slice(0, 12)}`,
);
