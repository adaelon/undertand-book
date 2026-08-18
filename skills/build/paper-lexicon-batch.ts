// PP3 paper lexicon batch: close the independent paper_lexicon.json sidecar pass.
//   tsx skills/build/paper-lexicon-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] --content-profile paper
import { mkdirSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildReproducibleProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import {
  buildPaperLexiconSidecar,
  type PaperLexiconEntry,
} from "../../packages/core/src/paper-lexicon";
import { readPaperLexiconCommittedArtifacts } from "../../packages/core/src/paper-lexicon-artifact-store";
import { computePaperLexiconCandidateStatus } from "../../packages/core/src/paper-lexicon-router";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { PaperLexiconZ } from "../../packages/core/src/zod";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";
import {
  buildAutomaticBuildStageBatchResult,
  publishAutomaticBuildArtifactSet,
} from "../../packages/core/src/automatic-build-publication";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2), "paper lexicon build");
const argv = parsedProfile.argv;
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const allowPartial = argv.includes("--allow-partial");
if (!book) {
  console.error(`usage: tsx paper-lexicon-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, lidNodes, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, override);
const buildDir = `.understand-book/${bookId}/.build/paper-lexicon`;
const committedArtifacts = readPaperLexiconCommittedArtifacts(buildDir);
const existing = new Map<string, Pass1ArtifactMeta>([...committedArtifacts].map(([workUnitId, committed]) => [
  workUnitId,
  { content_hash: committed.artifact.content_hash },
]));
const status = computePaperLexiconCandidateStatus({
  windows,
  byLid,
  source,
  existing,
  existing_artifacts: committedArtifacts,
});
if (status.pending && !allowPartial) {
  console.error(`[paper-lexicon-batch] refusing close: ${status.pending}/${status.eligible} candidate batches pending`);
  console.error(`  pending ids: ${status.pending_ids.join(",")}`);
  console.error("  resume with paper-lexicon-input + paper-lexicon-extractor + paper-lexicon-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const entries: PaperLexiconEntry[] = [];
const finalIds = [...new Set(Object.values(status.analysis.cluster_routes)
  .flatMap((route) => route.final_work_unit_id ? [route.final_work_unit_id] : []))];
for (const id of finalIds) {
  if (!status.done_ids.includes(id)) continue;
  entries.push(...committedArtifacts.get(id)!.artifact.entries);
}

const header = buildReproducibleProfileArtifactHeader({ book_id: bookId, content_profile: parsedProfile.contentProfile.id });
const paperLexicon = buildPaperLexiconSidecar(header, entries, lidNodes);
PaperLexiconZ.parse(paperLexicon);

const outDir = `.understand-book/${bookId}`;
mkdirSync(outDir, { recursive: true });
const publicationReceipt = publishAutomaticBuildArtifactSet({
  workspace_dir: outDir,
  stage: "paper_lexicon",
  artifacts: { "paper_lexicon.json": JSON.stringify(paperLexicon, null, 2) },
});

console.error(`[paper-lexicon-batch] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}${allowPartial && status.pending ? "  [--allow-partial]" : ""}`);
console.error(`  clusters=${status.analysis.clusters.length} batches=${status.eligible} skipped_windows=${status.skipped} done=${status.committed} pending=${status.pending}`);
console.error(`  paper_lexicon.json entries=${paperLexicon.entries.length}`);
process.stdout.write(`${JSON.stringify(buildAutomaticBuildStageBatchResult(publicationReceipt))}\n`);
