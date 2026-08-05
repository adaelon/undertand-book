// PP3 paper lexicon input: one routed candidate-cluster batch.
//   tsx skills/build/paper-lexicon-input.ts <book.md|epub> <workUnitId> [--book-id <id>] --content-profile paper
import { analyzePaperLexiconCandidates } from "../../packages/core/src/paper-lexicon-router";
import { renderPaperLexiconModelInput } from "../../packages/core/src/model-input-renderer";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2), "paper lexicon build");
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, workUnitId] = positional;
if (!book || workUnitId === undefined) {
  console.error(`usage: tsx paper-lexicon-input.ts <book.md|epub> <workUnitId> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const routing = analyzePaperLexiconCandidates({ windows, byLid, source });
const input = routing.packets[workUnitId];
if (!input) throw new Error(`paper lexicon work unit is not model-eligible: ${workUnitId}`);

process.stdout.write(renderPaperLexiconModelInput(input));
process.stderr.write(
  `[paper-lexicon-input] ${workUnitId}: content_profile=${parsedProfile.contentProfile.id} clusters=${input.candidate_clusters.length} lids=${input.visible_lids.length}\n`,
);
