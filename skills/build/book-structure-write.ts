// PB7 BookStructure write: atomically persist one unit-card output or stitch output.
//   tsx skills/build/book-structure-write.ts <book.md|epub> <unit:<lid>|stitch> <subagent-output.json> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  buildBookStructureStitchArtifact,
  buildBookStructureUnitArtifact,
  type BookStructureCandidate,
  type BookStructureUnitExtractionOutput,
} from "../../packages/core/src/book-structure";
import {
  computeCurrentBookStructureStatus,
  findUnitSource,
  loadBookStructureBuildContext,
  parseBookStructureArgs,
  stitchArtifactPath,
  unitArtifactPath,
} from "./book-structure-common";

const parsed = parseBookStructureArgs(process.argv.slice(2));
const [book, jobId, outputPath] = parsed.positional;
if (!book || !jobId || !outputPath) {
  console.error("usage: tsx book-structure-write.ts <book.md|epub> <unit:<lid>|stitch> <subagent-output.json> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]");
  process.exit(2);
}

const ctx = loadBookStructureBuildContext(book, parsed.override, parsed.contentProfile);
const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");

if (jobId === "stitch") {
  const { status, stitchPacket } = computeCurrentBookStructureStatus(ctx);
  if (!stitchPacket || status.stitch_blocked) {
    console.error(`[book-structure-write] refusing stitch write: ${status.unit_pending.length} unit jobs pending`);
    if (status.unit_pending.length) console.error(`  pending unit jobs: ${status.unit_pending.join(",")}`);
    process.exit(1);
  }
  const output = JSON.parse(outputText) as BookStructureCandidate;
  const artifact = buildBookStructureStitchArtifact(stitchPacket, output);
  mkdirSync(ctx.buildDir, { recursive: true });
  const finalPath = stitchArtifactPath(ctx);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
  renameSync(tmpPath, finalPath);
  console.log(`[book-structure-write] stitch -> ${finalPath} content_profile=${parsed.contentProfile.id} spine=${output.spine?.length ?? 0} throughlines=${output.throughlines?.length ?? 0} key_stops=${output.key_stops?.length ?? 0} hash=${artifact.content_hash.slice(0, 12)}`);
} else {
  const source = findUnitSource(ctx, jobId);
  const output = JSON.parse(outputText) as BookStructureUnitExtractionOutput;
  const artifact = buildBookStructureUnitArtifact(source, output);
  mkdirSync(ctx.unitDir, { recursive: true });
  const finalPath = unitArtifactPath(ctx, source.unit_lid);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
  renameSync(tmpPath, finalPath);
  console.log(`[book-structure-write] ${source.job_id} -> ${finalPath} content_profile=${parsed.contentProfile.id} key_stop_candidates=${output.unit_card.candidate_key_stops.length} hash=${artifact.content_hash.slice(0, 12)}`);
}
