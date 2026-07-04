// PB7 BookStructure input: emit one unit-card packet or the full-book stitch packet.
//   tsx skills/build/book-structure-input.ts <book.md|epub> <unit:<lid>|stitch> [--book-id <id>]
import { computeCurrentBookStructureStatus, findUnitSource, loadBookStructureBuildContext, parseBookStructureArgs } from "./book-structure-common";

const parsed = parseBookStructureArgs(process.argv.slice(2));
const [book, jobId] = parsed.positional;
if (!book || !jobId) {
  console.error("usage: tsx book-structure-input.ts <book.md|epub> <unit:<lid>|stitch> [--book-id <id>]");
  process.exit(2);
}

const ctx = loadBookStructureBuildContext(book, parsed.override);
if (jobId === "stitch") {
  const { status, stitchPacket } = computeCurrentBookStructureStatus(ctx);
  if (!stitchPacket || status.stitch_blocked) {
    console.error(`[book-structure-input] stitch blocked: ${status.unit_pending.length} unit jobs pending`);
    if (status.unit_pending.length) console.error(`  pending unit jobs: ${status.unit_pending.join(",")}`);
    process.exit(1);
  }
  console.log(JSON.stringify(stitchPacket, null, 2));
  process.stderr.write(`[book-structure-input] stitch: unit_cards=${stitchPacket.unit_cards.length} long_range_edges=${stitchPacket.long_range_edges.length}\n`);
} else {
  const source = findUnitSource(ctx, jobId);
  console.log(JSON.stringify(source, null, 2));
  process.stderr.write(
    `[book-structure-input] ${source.job_id}: leaves=${source.leaf_lids.length} discourse=${source.discourse_items.length} formula=${source.formula_semantics.length} pass2=${source.pass2_edges.length}\n`,
  );
}
