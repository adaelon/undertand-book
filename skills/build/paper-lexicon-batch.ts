// PP3 paper lexicon batch: close the independent paper_lexicon.json sidecar pass.
//   tsx skills/build/paper-lexicon-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] --content-profile paper
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildReproducibleProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import {
  buildPaperLexiconSidecar,
  type PaperLexiconArtifact,
  type PaperLexiconEntry,
} from "../../packages/core/src/paper-lexicon";
import { computePaperLexiconCandidateStatus } from "../../packages/core/src/paper-lexicon-router";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { PaperLexiconZ } from "../../packages/core/src/zod";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";
import { semanticArtifactPayload } from "../../packages/core/src/semantic-artifact";
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
const initial = computePaperLexiconCandidateStatus({ windows, byLid, source, existing: new Map() });
const existing = new Map<string, Pass1ArtifactMeta>();
const artifacts = new Map<string, PaperLexiconArtifact>();
for (const workUnitId of Object.keys(initial.analysis.packets)) {
  const f = `${buildDir}/${workUnitId}.json`;
  if (!existsSync(f)) continue;
  const artifact = semanticArtifactPayload<PaperLexiconArtifact>(JSON.parse(readFileSync(f, "utf8")));
  artifacts.set(workUnitId, artifact);
  if (typeof artifact?.content_hash === "string") existing.set(workUnitId, { content_hash: artifact.content_hash });
}

const status = computePaperLexiconCandidateStatus({ windows, byLid, source, existing });
if (status.pending && !allowPartial) {
  console.error(`[paper-lexicon-batch] refusing close: ${status.pending}/${status.eligible} candidate batches pending`);
  console.error(`  pending ids: ${status.pending_ids.join(",")}`);
  console.error("  resume with paper-lexicon-input + paper-lexicon-extractor + paper-lexicon-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const entries: PaperLexiconEntry[] = [];
for (const id of status.done_ids) entries.push(...artifacts.get(id)!.entries);

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
