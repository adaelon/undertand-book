// PP2 paper metadata batch: close the independent paper_metadata.json sidecar pass.
//   tsx skills/build/paper-metadata-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] --content-profile paper
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import {
  buildPaperMetadataSidecar,
  computePaperMetadataStatus,
  type PaperMetadataArtifact,
  type PaperMetadataFields,
} from "../../packages/core/src/paper-metadata";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { PaperMetadataZ } from "../../packages/core/src/zod";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2));
const argv = parsedProfile.argv;
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const allowPartial = argv.includes("--allow-partial");
if (!book) {
  console.error(`usage: tsx paper-metadata-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, lidNodes, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, override);
const buildDir = `.understand-book/${bookId}/.build/paper-metadata`;
const existing = new Map<number, Pass1ArtifactMeta>();
const artifacts = new Map<number, PaperMetadataArtifact>();
for (const w of windows) {
  const f = `${buildDir}/${w.id}.json`;
  if (!existsSync(f)) continue;
  const artifact = JSON.parse(readFileSync(f, "utf8")) as PaperMetadataArtifact;
  artifacts.set(w.id, artifact);
  if (typeof artifact?.content_hash === "string") existing.set(w.id, { content_hash: artifact.content_hash });
}

const { done, pending } = computePaperMetadataStatus(windows, byLid, source, existing);
if (pending.length && !allowPartial) {
  console.error(`[paper-metadata-batch] refusing close: ${pending.length}/${windows.length} windows pending`);
  console.error(`  pending ids: ${pending.join(",")}`);
  console.error("  resume with paper-metadata-input + paper-metadata-extractor + paper-metadata-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const candidates: PaperMetadataFields[] = [];
for (const id of done) {
  candidates.push(artifacts.get(id)!.metadata);
}

const header = buildProfileArtifactHeader({ book_id: bookId, content_profile: parsedProfile.contentProfile.id });
const paperMetadata = buildPaperMetadataSidecar(header, candidates, lidNodes);
PaperMetadataZ.parse(paperMetadata);

const outDir = `.understand-book/${bookId}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/paper_metadata.json`, JSON.stringify(paperMetadata, null, 2), "utf8");

console.log(`[paper-metadata-batch] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}${allowPartial && pending.length ? "  [--allow-partial]" : ""}`);
console.log(`  windows=${windows.length} done=${done.length} pending=${pending.length}`);
console.log(`  paper_metadata.json fields=${Object.keys(paperMetadata).filter((key) => key !== "header").length}`);
