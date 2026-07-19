// PB6 profile-sidecar status: independent sidecar resume view.
//   tsx skills/build/profile-sidecar-status.ts <book.md|epub> [--book-id <id>] [--content-profile technical_learning]
import { existsSync, readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { computeProfileSidecarCandidateStatus } from "../../packages/core/src/profile-sidecar-router";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";
import { semanticArtifactPayload } from "../../packages/core/src/semantic-artifact";

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
const initial = computeProfileSidecarCandidateStatus({ windows, byLid, source, content_profile: parsedProfile.contentProfile, existing: new Map() });
const existing = new Map<string, Pass1ArtifactMeta>();
for (const workUnitId of Object.keys(initial.analysis.packets)) {
  const f = `${dir}/${workUnitId}.json`;
  if (!existsSync(f)) continue;
  const meta = semanticArtifactPayload<Pass1ArtifactMeta>(JSON.parse(readFileSync(f, "utf8")));
  if (typeof meta?.content_hash === "string") existing.set(workUnitId, { content_hash: meta.content_hash });
}
const status = computeProfileSidecarCandidateStatus({ windows, byLid, source, content_profile: parsedProfile.contentProfile, existing });

console.log(`[profile-sidecar-status] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}`);
console.log(`  discourse_lids=${status.analysis.accounting.discourse_eligible_lids} groups=${status.analysis.accounting.discourse_groups} formula_total=${status.analysis.accounting.formula_total} formula_eligible=${status.analysis.accounting.formula_eligible} skipped=${status.skipped} done=${status.committed} pending=${status.pending}`);
console.log(`  artifact dir: ${dir}`);
if (status.pending_ids.length) console.log(`  pending ids: ${status.pending_ids.join(",")}`);
else console.log(`  all windows done -> can close with: tsx skills/build/profile-sidecar-batch.ts ${book}`);
