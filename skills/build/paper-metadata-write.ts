// PP2 paper metadata write: normalize one extractor output and atomically persist it.
//   tsx skills/build/paper-metadata-write.ts <book.md|epub> <windowId> <extractor-output.json> [--book-id <id>] --content-profile paper
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import {
  buildPaperMetadataArtifact,
} from "../../packages/core/src/paper-metadata";
import { analyzePaperMetadataCandidates } from "../../packages/core/src/paper-metadata-router";
import { parseExtractorCandidate } from "../../packages/core/src/extractor-contract";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2));
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book || idStr === undefined || !outputPath) {
  console.error(`usage: tsx paper-metadata-write.ts <book.md|epub> <windowId> <extractor-output.json> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const w = windowById(windows, id);
const routing = analyzePaperMetadataCandidates({ windows, byLid, source });
const packet = routing.packets[String(id)];
if (!packet) {
  const skipped = routing.skip_reasons[String(id)];
  throw new Error(`paper metadata window ${id} is not model-eligible: ${skipped?.code ?? "not_in_plan"}`);
}
const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
const output = parseExtractorCandidate("paper_metadata", JSON.parse(outputText), {
  allowed_evidence_lids: [...packet.visible_lids],
});
const artifact = buildPaperMetadataArtifact(w, byLid, source, output);

const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/paper-metadata`;
mkdirSync(dir, { recursive: true });
const finalPath = `${dir}/${id}.json`;
const tmpPath = `${finalPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
renameSync(tmpPath, finalPath);

console.log(
  `[paper-metadata-write] window ${id} -> ${finalPath} content_profile=${parsedProfile.contentProfile.id} fields=${Object.keys(artifact.metadata).length} hash=${artifact.content_hash.slice(0, 12)}`,
);
