// PB6 profile-sidecar status: independent sidecar resume view.
//   tsx skills/build/profile-sidecar-status.ts <book.md|epub> [--book-id <id>]
import { existsSync, readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { computeProfileSidecarStatus } from "../../packages/core/src/profile-sidecar-build";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { loadBookWindows } from "./load-book";

const argv = process.argv.slice(2);
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book) {
  console.error("usage: tsx profile-sidecar-status.ts <book.md|epub> [--book-id <id>]");
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
const { done, pending } = computeProfileSidecarStatus(windows, byLid, source, existing);

console.log(`[profile-sidecar-status] ${book}  bookId=${bookId}`);
console.log(`  windows=${windows.length}  done=${done.length}  pending=${pending.length}`);
console.log(`  artifact dir: ${dir}`);
if (pending.length) console.log(`  pending ids: ${pending.join(",")}`);
else console.log(`  all windows done -> can close with: tsx skills/build/profile-sidecar-batch.ts ${book}`);
