// PB3/PB6 Pass2 batch: close candidate classification and write long_range edges + audit.
//   tsx skills/build/pass2-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import { buildLidToWindowIndex, gatePass2BuildOutput, type Pass2LlmOutput } from "../../packages/core/src/pass2-build";
import { computePass2Status, type Pass2Artifact } from "../../packages/core/src/pass2-orchestrate";
import { Pass2BuildAuditSidecarZ, ReadOnlyBaseZ } from "../../packages/core/src/zod";
import { loadPass2BuildContext, parseBookArgs } from "./pass2-common";

const { book, override, allowPartial } = parseBookArgs(process.argv.slice(2));
if (!book) {
  console.error("usage: tsx pass2-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial]");
  process.exit(2);
}

const ctx = loadPass2BuildContext(book, override);
const buildDir = `${ctx.baseDir}/.build/pass2`;
const existing = new Map<number, Pick<Pass2Artifact, "content_hash">>();
const artifacts = new Map<number, Pass2Artifact>();
for (const id of ctx.packets.keys()) {
  const f = `${buildDir}/${id}.json`;
  if (!existsSync(f)) continue;
  const artifact = JSON.parse(readFileSync(f, "utf8")) as Pass2Artifact;
  artifacts.set(id, artifact);
  if (typeof artifact?.content_hash === "string") existing.set(id, { content_hash: artifact.content_hash });
}
const status = computePass2Status(ctx.packets, existing);
if (status.pending.length && !allowPartial) {
  console.error(`[pass2-batch] refusing close: ${status.pending.length}/${ctx.windows.length} candidate windows pending`);
  console.error(`  pending ids: ${status.pending.join(",")}`);
  console.error("  resume with pass2-input + pass2-longrange-linker + pass2-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const output: Pass2LlmOutput = { accepted_edges: [], pending_edges: [], rejected_candidates: [] };
for (const id of status.done) {
  const artifact = artifacts.get(id)!;
  output.accepted_edges.push(...artifact.output.accepted_edges);
  output.pending_edges.push(...artifact.output.pending_edges);
  output.rejected_candidates.push(...artifact.output.rejected_candidates);
}
const header = buildProfileArtifactHeader({ book_id: ctx.bookId });
const lidToWindowIndex = buildLidToWindowIndex(ctx.windows);
const gated = gatePass2BuildOutput(output, header, ctx.base.graph_nodes, ctx.lidNodes, lidToWindowIndex);
Pass2BuildAuditSidecarZ.parse(gated.audit);

const localEdges = ctx.base.graph_edges.filter((edge) => edge.scope !== "long_range");
const base = { ...ctx.base, graph_edges: [...localEdges, ...gated.edges] };
ReadOnlyBaseZ.parse(base);
mkdirSync(ctx.baseDir, { recursive: true });
writeFileSync(`${ctx.baseDir}/long_range_candidates.json`, JSON.stringify(ctx.candidateIndex, null, 2), "utf8");
writeFileSync(`${ctx.baseDir}/base.json`, JSON.stringify(base, null, 2), "utf8");
writeFileSync(`${ctx.baseDir}/pass2_audit.json`, JSON.stringify(gated.audit, null, 2), "utf8");

console.log(`[pass2-batch] ${book}  bookId=${ctx.bookId}${allowPartial && status.pending.length ? "  [--allow-partial]" : ""}`);
console.log(`  windows=${ctx.windows.length} candidates=${ctx.candidateIndex.candidates.length} done=${status.done.length} pending=${status.pending.length} skipped=${status.skipped.length}`);
console.log(`  classifier output: accepted=${output.accepted_edges.length} pending=${output.pending_edges.length} rejected=${output.rejected_candidates.length}`);
console.log(`  gate: long_range_edges=${gated.edges.length} accepted=${gated.audit.accepted.length} pending=${gated.audit.pending.length} rejected=${gated.audit.rejected.length} gate_dropped=${gated.audit.gate_dropped.length}`);
console.log(`  wrote: ${ctx.baseDir}/long_range_candidates.json`);
console.log(`  wrote: ${ctx.baseDir}/base.json`);
console.log(`  wrote: ${ctx.baseDir}/pass2_audit.json`);
