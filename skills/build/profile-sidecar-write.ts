// PB6 profile-sidecar write: normalize one subagent output and atomically persist it.
//   tsx skills/build/profile-sidecar-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>] [--content-profile technical_learning]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { analyzeProfileSidecarSemanticUnits, buildProfileSidecarSemanticArtifact } from "../../packages/core/src/profile-sidecar-router";
import { parseExtractorCandidate } from "../../packages/core/src/extractor-contract";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, workUnitId, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book || workUnitId === undefined || !outputPath) {
  console.error(`usage: tsx profile-sidecar-write.ts <book.md|epub> <workUnitId> <subagent-output.json> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const routing = analyzeProfileSidecarSemanticUnits({ windows, byLid, source, content_profile: parsedProfile.contentProfile });
const packet = routing.packets[workUnitId];
if (!packet) throw new Error(`profile sidecar work unit is not model-eligible: ${workUnitId}`);
const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
const output = parseExtractorCandidate("profile_sidecar", JSON.parse(outputText), {
  allowed_evidence_lids: [...packet.visible_lids],
  formula_lids: [...packet.formula_lids],
});
const artifact = buildProfileSidecarSemanticArtifact(packet, output);

const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/profile-sidecar`;
mkdirSync(dir, { recursive: true });
const finalPath = `${dir}/${workUnitId}.json`;
const tmpPath = `${finalPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
renameSync(tmpPath, finalPath);
console.log(
  `[profile-sidecar-write] ${workUnitId} -> ${finalPath} content_profile=${parsedProfile.contentProfile.id} discourse=${artifact.discourse_items.length} formula=${artifact.formula_semantics.length} hash=${artifact.content_hash.slice(0, 12)}`,
);
