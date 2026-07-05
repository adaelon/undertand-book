// PB6 profile-sidecar write: normalize one subagent output and atomically persist it.
//   tsx skills/build/profile-sidecar-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>] [--content-profile technical_learning]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildProfileSidecarArtifact, type ProfileSidecarExtractionOutput } from "../../packages/core/src/profile-sidecar-build";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book || idStr === undefined || !outputPath) {
  console.error(`usage: tsx profile-sidecar-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const w = windowById(windows, id);
const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
const output = JSON.parse(outputText) as ProfileSidecarExtractionOutput;
const artifact = buildProfileSidecarArtifact(w, byLid, source, output, parsedProfile.contentProfile);

const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/profile-sidecar`;
mkdirSync(dir, { recursive: true });
const finalPath = `${dir}/${id}.json`;
const tmpPath = `${finalPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
renameSync(tmpPath, finalPath);
console.log(
  `[profile-sidecar-write] window ${id} -> ${finalPath} content_profile=${parsedProfile.contentProfile.id} discourse=${artifact.discourse_items.length} formula=${artifact.formula_semantics.length} hash=${artifact.content_hash.slice(0, 12)}`,
);
