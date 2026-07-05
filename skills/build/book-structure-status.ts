// PB7 BookStructure status: unit-card + stitch resume view.
//   tsx skills/build/book-structure-status.ts <book.md|epub> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]
import { computeCurrentBookStructureStatus, loadBookStructureBuildContext, parseBookStructureArgs } from "./book-structure-common";

const { book, override, contentProfile } = parseBookStructureArgs(process.argv.slice(2));
if (!book) {
  console.error("usage: tsx book-structure-status.ts <book.md|epub> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]");
  process.exit(2);
}

const ctx = loadBookStructureBuildContext(book, override, contentProfile);
const { status } = computeCurrentBookStructureStatus(ctx);

console.log(`[book-structure-status] ${book}  bookId=${ctx.bookId}  content_profile=${contentProfile.id}`);
console.log(`  units=${ctx.unitSources.length} done=${status.unit_done.length} pending=${status.unit_pending.length}`);
console.log(`  stitch=${status.stitch_done ? "done" : status.stitch_blocked ? "blocked" : "pending"}`);
console.log(`  artifact dir: ${ctx.buildDir}`);
if (status.unit_pending.length) console.log(`  pending unit jobs: ${status.unit_pending.join(",")}`);
else if (status.stitch_pending) console.log("  all units done -> emit stitch input with: tsx skills/build/book-structure-input.ts <book> stitch");
else if (status.stitch_done) console.log(`  stitch done -> can close with: tsx skills/build/book-structure-batch.ts ${book}`);
