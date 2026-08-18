// PP3 paper lexicon input: one routed candidate-cluster batch.
//   tsx skills/build/paper-lexicon-input.ts <book.md|epub> <workUnitId> [--book-id <id>] --content-profile paper
import { deriveBookId } from "../../packages/core/src/book-id";
import { readPaperLexiconCommittedArtifacts } from "../../packages/core/src/paper-lexicon-artifact-store";
import { analyzePaperLexiconCandidates } from "../../packages/core/src/paper-lexicon-router";
import { renderPaperLexiconModelInput } from "../../packages/core/src/model-input-renderer";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2), "paper lexicon build");
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, workUnitId] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book || workUnitId === undefined) {
  console.error(`usage: tsx paper-lexicon-input.ts <book.md|epub> <workUnitId> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, override);
const existingArtifacts = readPaperLexiconCommittedArtifacts(`.understand-book/${bookId}/.build/paper-lexicon`);
const routing = analyzePaperLexiconCandidates({ windows, byLid, source, existing_artifacts: existingArtifacts });
const input = routing.packets[workUnitId];
if (!input) throw new Error(`paper lexicon work unit is not model-eligible: ${workUnitId}`);

process.stdout.write(renderPaperLexiconModelInput(input));
process.stderr.write(
  `[paper-lexicon-input] ${workUnitId}: content_profile=${parsedProfile.contentProfile.id} role=${input.route.role} clusters=${input.candidate_clusters.length} lids=${input.visible_lids.length}\n`,
);
