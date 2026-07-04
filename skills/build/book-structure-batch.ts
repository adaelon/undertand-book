// PB7 BookStructure batch: close unit-card + stitch outputs into book_structure.json.
//   tsx skills/build/book-structure-batch.ts <book.md|epub> [--book-id <id>]
import { mkdirSync, writeFileSync } from "node:fs";
import { buildBookStructureSidecar } from "../../packages/core/src/book-structure";
import { buildProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import { BookStructureSidecarZ } from "../../packages/core/src/zod";
import { computeCurrentBookStructureStatus, loadBookStructureBuildContext, parseBookStructureArgs } from "./book-structure-common";

const { book, override } = parseBookStructureArgs(process.argv.slice(2));
if (!book) {
  console.error("usage: tsx book-structure-batch.ts <book.md|epub> [--book-id <id>]");
  process.exit(2);
}

const ctx = loadBookStructureBuildContext(book, override);
const { status, stitchArtifact } = computeCurrentBookStructureStatus(ctx);
if (status.unit_pending.length) {
  console.error(`[book-structure-batch] refusing close: ${status.unit_pending.length}/${ctx.unitSources.length} unit jobs pending`);
  console.error(`  pending unit jobs: ${status.unit_pending.join(",")}`);
  process.exit(1);
}
if (!status.stitch_done || !stitchArtifact) {
  console.error("[book-structure-batch] refusing close: stitch output missing or stale");
  console.error(`  emit with: tsx skills/build/book-structure-input.ts ${book} stitch`);
  console.error(`  write with: tsx skills/build/book-structure-write.ts ${book} stitch <subagent-output.json>`);
  process.exit(1);
}

const header = buildProfileArtifactHeader({ book_id: ctx.bookId });
const result = buildBookStructureSidecar(header, stitchArtifact.output, ctx.lidNodes);
BookStructureSidecarZ.parse(result.sidecar);
mkdirSync(ctx.baseDir, { recursive: true });
const outPath = `${ctx.baseDir}/book_structure.json`;
writeFileSync(outPath, JSON.stringify(result.sidecar, null, 2), "utf8");

console.log(`[book-structure-batch] ${book}  bookId=${ctx.bookId}`);
console.log(`  units=${ctx.unitSources.length} stitch=done`);
console.log(`  book_structure.json spine=${result.sidecar.spine.length} throughlines=${result.sidecar.throughlines.length} key_stops=${result.sidecar.key_stops.length} dropped=${result.dropped.length}`);
console.log(`  wrote: ${outPath}`);
