// PB3/PB6 Pass2 status: candidate-driven resume view.
//   tsx skills/build/pass2-status.ts <book.md|epub> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]
import { existsSync, readFileSync } from "node:fs";
import { computePass2Status, type Pass2Artifact } from "../../packages/core/src/pass2-orchestrate";
import { loadPass2BuildContext, parseBookArgs } from "./pass2-common";
import { semanticArtifactPayload } from "../../packages/core/src/semantic-artifact";

const { book, override, contentProfile } = parseBookArgs(process.argv.slice(2));
if (!book) {
  console.error("usage: tsx pass2-status.ts <book.md|epub> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]");
  process.exit(2);
}

const ctx = loadPass2BuildContext(book, override);
const dir = `${ctx.baseDir}/.build/pass2`;
const existing = new Map<number, Pick<Pass2Artifact, "content_hash">>();
for (const id of ctx.packets.keys()) {
  const f = `${dir}/${id}.json`;
  if (!existsSync(f)) continue;
  const artifact = semanticArtifactPayload<Pass2Artifact>(JSON.parse(readFileSync(f, "utf8")));
  if (typeof artifact?.content_hash === "string") existing.set(id, { content_hash: artifact.content_hash });
}
const status = computePass2Status(ctx.packets, existing);
console.log(`[pass2-status] ${book}  bookId=${ctx.bookId}  content_profile=${contentProfile.id}`);
console.log(`  windows=${ctx.windows.length} candidates=${ctx.candidateIndex.candidates.length} done=${status.done.length} pending=${status.pending.length} skipped=${status.skipped.length}`);
console.log(`  artifact dir: ${dir}`);
if (status.pending.length) console.log(`  pending ids: ${status.pending.join(",")}`);
else console.log(`  all candidate windows done -> can close with: tsx skills/build/pass2-batch.ts ${book}`);
