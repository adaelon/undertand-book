// PB6 profile-sidecar status: independent sidecar resume view.
//   tsx skills/build/profile-sidecar-status.ts <book.md|epub> [--book-id <id>] [--content-profile technical_learning]
import { existsSync, readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { computeProfileSidecarStatus } from "../../packages/core/src/profile-sidecar-build";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book) {
  console.error(`usage: tsx profile-sidecar-status.ts <book.md|epub> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/profile-sidecar`;
const existing = new Map<number, Pass1ArtifactMeta>();
for (const w of windows) {
  const f = `${dir}/${w.id}.json`;
  if (!existsSync(f)) continue;
  const meta = JSON.parse(readFileSync(f, "utf8")) as Pass1ArtifactMeta;
  if (typeof meta?.content_hash === "string") existing.set(w.id, { content_hash: meta.content_hash });
}
const { done, pending } = computeProfileSidecarStatus(windows, byLid, source, existing, parsedProfile.contentProfile);

console.log(`[profile-sidecar-status] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}`);
console.log(`  windows=${windows.length}  done=${done.length}  pending=${pending.length}`);
console.log(`  artifact dir: ${dir}`);
if (pending.length) console.log(`  pending ids: ${pending.join(",")}`);
else console.log(`  all windows done -> can close with: tsx skills/build/profile-sidecar-batch.ts ${book}`);
