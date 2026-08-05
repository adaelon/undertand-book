// PP2 paper metadata batch: close the independent paper_metadata.json sidecar pass.
//   tsx skills/build/paper-metadata-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] --content-profile paper
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildReproducibleProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import {
  buildPaperMetadataSidecar,
  type PaperMetadataArtifact,
  type PaperMetadataFields,
} from "../../packages/core/src/paper-metadata";
import { computePaperMetadataCandidateStatus } from "../../packages/core/src/paper-metadata-router";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { PaperMetadataZ } from "../../packages/core/src/zod";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";
import { semanticArtifactPayload } from "../../packages/core/src/semantic-artifact";
import {
  buildAutomaticBuildStageBatchResult,
  publishAutomaticBuildArtifactSet,
} from "../../packages/core/src/automatic-build-publication";

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
  const artifact = semanticArtifactPayload<PaperMetadataArtifact>(JSON.parse(readFileSync(f, "utf8")));
  artifacts.set(w.id, artifact);
  if (typeof artifact?.content_hash === "string") existing.set(w.id, { content_hash: artifact.content_hash });
}

const status = computePaperMetadataCandidateStatus({ windows, byLid, source, existing });
if (status.pending && !allowPartial) {
  console.error(`[paper-metadata-batch] refusing close: ${status.pending}/${status.eligible} eligible units pending`);
  console.error(`  pending ids: ${status.pending_ids.join(",")}`);
  console.error("  resume with paper-metadata-input + paper-metadata-extractor + paper-metadata-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const candidates: PaperMetadataFields[] = [];
if (Object.keys(status.analysis.deterministic_metadata).length) {
  candidates.push(status.analysis.deterministic_metadata);
}
for (const id of status.done_ids) {
  candidates.push(artifacts.get(id)!.metadata);
}

const header = buildReproducibleProfileArtifactHeader({ book_id: bookId, content_profile: parsedProfile.contentProfile.id });
const paperMetadata = buildPaperMetadataSidecar(header, candidates, lidNodes);
PaperMetadataZ.parse(paperMetadata);

const outDir = `.understand-book/${bookId}`;
mkdirSync(outDir, { recursive: true });
const publicationReceipt = publishAutomaticBuildArtifactSet({
  workspace_dir: outDir,
  stage: "paper_metadata",
  artifacts: { "paper_metadata.json": JSON.stringify(paperMetadata, null, 2) },
});

console.error(`[paper-metadata-batch] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}${allowPartial && status.pending ? "  [--allow-partial]" : ""}`);
console.error(`  windows=${status.total} eligible=${status.eligible} skipped=${status.skipped} done=${status.committed} pending=${status.pending}`);
console.error(`  deterministic_references=${status.analysis.deterministic_metadata.references?.value.length ?? 0}`);
console.error(`  paper_metadata.json fields=${Object.keys(paperMetadata).filter((key) => key !== "header").length}`);
process.stdout.write(`${JSON.stringify(buildAutomaticBuildStageBatchResult(publicationReceipt))}\n`);
