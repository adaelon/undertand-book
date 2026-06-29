// PB5-3c 跨会话续建收口 [ADR-0042]:消费 `.build/pass1/*.json` 累积(content-hash 校验)→
// merge+闸 → 锚定率 → 固化只读基座。pending(缺窗 / hash 失配)默认**拒绝收口**(缺窗=缺节点=
// 图不完整),`--allow-partial` 显式兜底。本脚本零 LLM,是续建 loop 的末步(全 done 后收口)。
//   tsx pass1-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial]
//     [--formula-candidates <p>] [--discourse-candidates <p>] [--pass2-output <p>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { mergeAndGate, type Pass1Output } from "../../packages/core/src/merge";
import { projectCatalog } from "../../packages/core/src/catalog";
import { FormulaSemanticsSidecarZ, Pass2BuildAuditSidecarZ, ReadOnlyBaseZ, TechnicalLearningDiscourseIndexZ } from "../../packages/core/src/zod";
import { buildProfileArtifactHeader, buildProfileMetadata } from "../../packages/core/src/profile-artifact";
import { buildFormulaSemanticsSidecar, type FormulaSemanticsBuildCandidate } from "../../packages/core/src/formula-semantics";
import { buildTechnicalLearningDiscourseIndex, type TechnicalLearningDiscourseItem } from "../../packages/core/src/discourse-index";
import { buildLidToWindowIndex, buildLongRangeCandidates, gatePass2BuildOutput, type Pass2LlmOutput } from "../../packages/core/src/pass2-build";
import { deriveBookId } from "../../packages/core/src/book-id";
import { computeBuildStatus, type Pass1Artifact } from "../../packages/core/src/build-resume";
import { loadBookWindows, windowById } from "./load-book";

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--book-id", "--formula-candidates", "--discourse-candidates", "--pass2-output"]);
const opts: Record<string, string | undefined> = {};
let allowPartial = false;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--allow-partial") allowPartial = true;
  else if (VALUE_FLAGS.has(a)) opts[a] = argv[++i];
  else if (a.startsWith("--")) { console.error(`未知选项 ${a}`); process.exit(2); }
  else positional.push(a);
}
const book = positional[0];
if (!book) {
  console.error("usage: tsx pass1-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] [--formula-candidates <p>] [--discourse-candidates <p>] [--pass2-output <p>]");
  process.exit(2);
}
const formulaCandidatesPath = opts["--formula-candidates"];
const discourseCandidatesPath = opts["--discourse-candidates"];
const pass2OutputPath = opts["--pass2-output"];

const { source, lidNodes, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, opts["--book-id"]);

// 消费 `.build/pass1/<id>.json`:逐窗读已落产物(缺文件=不入 map)
const pass1Dir = `.understand-book/${bookId}/.build/pass1`;
const artifacts = new Map<number, Pass1Artifact>();
for (const w of windows) {
  const f = `${pass1Dir}/${w.id}.json`;
  if (existsSync(f)) artifacts.set(w.id, JSON.parse(readFileSync(f, "utf8")) as Pass1Artifact);
}
// 续建判定:存在性 + content-hash 校验(陈旧/缺失=pending)
const { done, pending } = computeBuildStatus(windows, byLid, source, artifacts);
if (pending.length && !allowPartial) {
  console.error(`[pass1-batch] 拒绝收口:${pending.length}/${windows.length} 窗 pending(缺窗=缺节点=图不完整)`);
  console.error(`  pending ids: ${pending.join(",")}`);
  console.error(`  续建: build-status 看待抽窗 → 逐窗 emit-input+抽取+pass1-write;全 done 后重跑。强行收口加 --allow-partial`);
  process.exit(1);
}

// 只把 done 窗口的抽取产物喂 merge(--allow-partial 下 pending 窗口跳过,基座局部)
const outputs: Pass1Output[] = done.map((id) => {
  const a = artifacts.get(id)!;
  return { nodes: a.nodes, edges: a.edges };
});

const { nodes, edges, report } = mergeAndGate(outputs, lidNodes);
const catalog = projectCatalog(nodes);

// 局部锚定率:分母 = done 窗口叶子并集
const idxs = done;
const sampledLeaves = new Set(idxs.flatMap((id) => windowById(windows, id).leafLids));
const anchored = new Set<string>();
for (const n of nodes) {
  if (n.type === "claim") { if (n.source_lid) anchored.add(n.source_lid); }
  else for (const l of n.occurrences) anchored.add(l);
}
const sampledAnchored = [...sampledLeaves].filter((l) => anchored.has(l)).length;
const sampledRate = sampledLeaves.size ? sampledAnchored / sampledLeaves.size : 0;

// 固化小基座 + zod 校验(bookId 已在头部派生)
const profileHeader = buildProfileArtifactHeader({ book_id: bookId });
const profileMetadata = buildProfileMetadata(profileHeader);
const formulaSidecar = formulaCandidatesPath
  ? buildFormulaSemanticsSidecar(
      profileHeader,
      JSON.parse(readFileSync(formulaCandidatesPath, "utf8")) as FormulaSemanticsBuildCandidate[],
      lidNodes,
    )
  : null;
if (formulaSidecar) FormulaSemanticsSidecarZ.parse(formulaSidecar.sidecar);
const discourseSidecar = discourseCandidatesPath
  ? buildTechnicalLearningDiscourseIndex(
      profileHeader,
      JSON.parse(readFileSync(discourseCandidatesPath, "utf8")) as TechnicalLearningDiscourseItem[],
      lidNodes,
    )
  : null;
if (discourseSidecar) TechnicalLearningDiscourseIndexZ.parse(discourseSidecar.sidecar);

// PB3-5: Pass2 长程边 —— 确定性候选(build-only)+ 可选 subagent 输出过 gate 写回
const lidToWindowIndex = buildLidToWindowIndex(windows);
const candidateIndex = {
  candidates: buildLongRangeCandidates({
    graphNodes: nodes,
    lidToWindowIndex,
    discourseIndex: discourseSidecar?.sidecar,
    formulaSemantics: formulaSidecar?.sidecar.items,
  }),
};
const pass2Gated = pass2OutputPath
  ? gatePass2BuildOutput(
      JSON.parse(readFileSync(pass2OutputPath, "utf8")) as Pass2LlmOutput,
      profileHeader,
      nodes,
      lidNodes,
      lidToWindowIndex,
    )
  : null;
if (pass2Gated) Pass2BuildAuditSidecarZ.parse(pass2Gated.audit); // 产出前自检
const longRangeEdges = pass2Gated?.edges ?? [];

// long_range 边合并进 base 后统一固化(local + long_range)
const base = { book_id: bookId, lid_nodes: lidNodes, graph_nodes: nodes, graph_edges: [...edges, ...longRangeEdges] };
ReadOnlyBaseZ.parse(base); // 产出前自检(字段失配抛错)
const dir = `.understand-book/${bookId}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/base.json`, JSON.stringify(base, null, 2), "utf8");
writeFileSync(`${dir}/source.txt`, source, "utf8"); // 原文旁路:book.text 取真原文用,按 LID.span(UTF-16)切 `[ADR-0024]`
writeFileSync(`${dir}/profile_metadata.json`, JSON.stringify(profileMetadata, null, 2), "utf8");
// build-only:不被 Book::load 读,供 Pass2 prompt 输入 + 覆盖/审计调试 `[PB3 grill §2]`
writeFileSync(`${dir}/long_range_candidates.json`, JSON.stringify(candidateIndex, null, 2), "utf8");
if (formulaSidecar) {
  writeFileSync(`${dir}/formula_semantics.json`, JSON.stringify(formulaSidecar.sidecar, null, 2), "utf8");
}
if (discourseSidecar) {
  writeFileSync(`${dir}/discourse_index.json`, JSON.stringify(discourseSidecar.sidecar, null, 2), "utf8");
}
if (pass2Gated) {
  writeFileSync(`${dir}/pass2_audit.json`, JSON.stringify(pass2Gated.audit, null, 2), "utf8");
}

console.log(`[pass1-batch] ${book}  bookId=${bookId}${allowPartial && pending.length ? "  [--allow-partial]" : ""}`);
console.log(`  窗口=${windows.length}  done=${done.length}  pending=${pending.length}  全书叶子=${lidNodes.filter((n) => n.children.length === 0).length}`);
console.log(`  抽取输入: nodes=${outputs.reduce((s, o) => s + o.nodes.length, 0)} edges=${outputs.reduce((s, o) => s + o.edges.length, 0)}`);
console.log(`  merge 合并: 节点合并=${report.nodesMerged} 边去重=${report.edgesDeduped}`);
console.log(`  闸后: nodes=${report.nodesOut} edges=${report.edgesOut} 目录=${catalog.length}`);
console.log(`  丢弃: 节点=${report.droppedNodes.length} 边=${report.droppedEdges.length} 剔除occ=${report.prunedOccurrences.length}`);
console.log(`  锚定率(全书分母)=${(report.anchorRate * 100).toFixed(4)}%`);
console.log(`  锚定率(已抽窗口分母,${sampledAnchored}/${sampledLeaves.size})=${(sampledRate * 100).toFixed(2)}%`);
console.log(`  基座固化: ${dir}/base.json  (zod 校验通过)`);
console.log(`  profile metadata: ${dir}/profile_metadata.json`);
if (formulaSidecar) {
  console.log(
    `  formula semantics: ${dir}/formula_semantics.json items=${formulaSidecar.sidecar.items.length} pending=${formulaSidecar.pending.length}`,
  );
}
if (discourseSidecar) {
  console.log(
    `  discourse index: ${dir}/discourse_index.json items=${discourseSidecar.sidecar.items.length} dropped=${discourseSidecar.dropped.length}`,
  );
}
console.log(`  long_range candidates: ${dir}/long_range_candidates.json candidates=${candidateIndex.candidates.length}`);
if (pass2Gated) {
  console.log(
    `  pass2 audit: ${dir}/pass2_audit.json long_range_edges=${pass2Gated.edges.length} accepted=${pass2Gated.audit.accepted.length} pending=${pass2Gated.audit.pending.length} rejected=${pass2Gated.audit.rejected.length} gate_dropped=${pass2Gated.audit.gate_dropped.length}`,
  );
}
