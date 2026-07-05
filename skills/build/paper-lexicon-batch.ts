// PP3 paper lexicon batch: close the independent paper_lexicon.json sidecar pass.
//   tsx skills/build/paper-lexicon-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] --content-profile paper
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import {
  buildPaperLexiconSidecar,
  computePaperLexiconStatus,
  type PaperLexiconArtifact,
  type PaperLexiconEntry,
} from "../../packages/core/src/paper-lexicon";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { PaperLexiconZ } from "../../packages/core/src/zod";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

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
const existing = new Map<number, Pass1ArtifactMeta>();
const artifacts = new Map<number, PaperLexiconArtifact>();
for (const w of windows) {
  const f = `${buildDir}/${w.id}.json`;
  if (!existsSync(f)) continue;
  const artifact = JSON.parse(readFileSync(f, "utf8")) as PaperLexiconArtifact;
  artifacts.set(w.id, artifact);
  if (typeof artifact?.content_hash === "string") existing.set(w.id, { content_hash: artifact.content_hash });
}

const { done, pending } = computePaperLexiconStatus(windows, byLid, source, existing);
if (pending.length && !allowPartial) {
  console.error(`[paper-lexicon-batch] refusing close: ${pending.length}/${windows.length} windows pending`);
  console.error(`  pending ids: ${pending.join(",")}`);
  console.error("  resume with paper-lexicon-input + paper-lexicon-extractor + paper-lexicon-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const entries: PaperLexiconEntry[] = [];
for (const id of done) entries.push(...artifacts.get(id)!.entries);

const header = buildProfileArtifactHeader({ book_id: bookId, content_profile: parsedProfile.contentProfile.id });
const paperLexicon = buildPaperLexiconSidecar(header, entries, lidNodes);
PaperLexiconZ.parse(paperLexicon);

const outDir = `.understand-book/${bookId}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/paper_lexicon.json`, JSON.stringify(paperLexicon, null, 2), "utf8");

console.log(`[paper-lexicon-batch] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}${allowPartial && pending.length ? "  [--allow-partial]" : ""}`);
console.log(`  windows=${windows.length} done=${done.length} pending=${pending.length}`);
console.log(`  paper_lexicon.json entries=${paperLexicon.entries.length}`);
