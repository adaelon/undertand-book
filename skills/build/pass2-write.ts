// PB3/PB6 Pass2 write: normalize one pass2-longrange-linker output and atomically persist it.
//   tsx skills/build/pass2-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { buildPass2Artifact } from "../../packages/core/src/pass2-orchestrate";
import type { Pass2LlmOutput } from "../../packages/core/src/pass2-build";
import { windowById } from "./load-book";
import { loadPass2BuildContext, parseBookArgs } from "./pass2-common";

const parsed = parseBookArgs(process.argv.slice(2));
const [book, idStr, outputPath] = parsed.positional;
if (!book || idStr === undefined || !outputPath) {
  console.error("usage: tsx pass2-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>]");
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}
const ctx = loadPass2BuildContext(book, parsed.override);
windowById(ctx.windows, id);
const packet = ctx.packets.get(id)!;
const outputText = readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
const output = JSON.parse(outputText) as Pass2LlmOutput;
const artifact = buildPass2Artifact(packet, output);
const dir = `${ctx.baseDir}/.build/pass2`;
mkdirSync(dir, { recursive: true });
const finalPath = `${dir}/${id}.json`;
const tmpPath = `${finalPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
renameSync(tmpPath, finalPath);
console.log(`[pass2-write] window ${id} -> ${finalPath} accepted=${output.accepted_edges.length} pending=${output.pending_edges.length} rejected=${output.rejected_candidates.length} hash=${artifact.content_hash.slice(0, 12)}`);
