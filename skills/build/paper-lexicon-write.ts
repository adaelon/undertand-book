// PP3 paper lexicon write: gate one candidate-cluster batch and atomically persist it.
//   tsx skills/build/paper-lexicon-write.ts <book.md|epub> <workUnitId> <extractor-output.json> [--book-id <id>] --content-profile paper
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { analyzePaperLexiconCandidates, buildPaperLexiconCandidateArtifact } from "../../packages/core/src/paper-lexicon-router";
import { parseExtractorCandidate } from "../../packages/core/src/extractor-contract";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2), "paper lexicon build");
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, workUnitId, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book || workUnitId === undefined || !outputPath) {
  console.error(`usage: tsx paper-lexicon-write.ts <book.md|epub> <workUnitId> <extractor-output.json> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, lidNodes, byLid, windows } = loadBookWindows(book);
const routing = analyzePaperLexiconCandidates({ windows, byLid, source });
const packet = routing.packets[workUnitId];
if (!packet) throw new Error(`paper lexicon work unit is not model-eligible: ${workUnitId}`);
const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
const output = parseExtractorCandidate("paper_lexicon", JSON.parse(outputText), {
  allowed_evidence_lids: [...packet.visible_lids],
});
const artifact = buildPaperLexiconCandidateArtifact(packet, lidNodes, output);

const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/paper-lexicon`;
mkdirSync(dir, { recursive: true });
const finalPath = `${dir}/${workUnitId}.json`;
const tmpPath = `${finalPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
renameSync(tmpPath, finalPath);

console.log(
  `[paper-lexicon-write] ${workUnitId} -> ${finalPath} content_profile=${parsedProfile.contentProfile.id} entries=${artifact.entries.length} hash=${artifact.content_hash.slice(0, 12)}`,
);
