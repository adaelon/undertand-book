// PP2 paper metadata status: independent resume view for paper_metadata.json.
//   tsx skills/build/paper-metadata-status.ts <book.md|epub> [--book-id <id>] --content-profile paper
import { existsSync, readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { computePaperMetadataCandidateStatus } from "../../packages/core/src/paper-metadata-router";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";
import { semanticArtifactPayload } from "../../packages/core/src/semantic-artifact";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2));
const argv = parsedProfile.argv;
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book) {
  console.error(`usage: tsx paper-metadata-status.ts <book.md|epub> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/paper-metadata`;
const existing = new Map<number, Pass1ArtifactMeta>();
for (const w of windows) {
  const f = `${dir}/${w.id}.json`;
  if (!existsSync(f)) continue;
  const meta = semanticArtifactPayload<Pass1ArtifactMeta>(JSON.parse(readFileSync(f, "utf8")));
  if (typeof meta?.content_hash === "string") existing.set(w.id, { content_hash: meta.content_hash });
}

const status = computePaperMetadataCandidateStatus({ windows, byLid, source, existing });
console.log(`[paper-metadata-status] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}`);
console.log(`  windows=${status.total}  eligible=${status.eligible}  skipped=${status.skipped}  done=${status.committed}  pending=${status.pending}`);
console.log(`  artifact dir: ${dir}`);
if (status.pending_ids.length) console.log(`  pending ids: ${status.pending_ids.join(",")}`);
else console.log(`  all windows done -> can close with: tsx skills/build/paper-metadata-batch.ts ${book} --content-profile paper`);
