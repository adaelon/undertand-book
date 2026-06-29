// S3.5 小规模 Pass1 实测:消费多窗口抽取结果 → merge+闸 → 锚定率 → 固化小基座。
//   tsx pass1-batch.ts <book> <outputs.json> <windowIdxList逗号分隔>
// outputs.json = Pass1Output[](各窗口抽取);windowIdxList = 已抽窗口索引(算局部锚定率分母)。
// 全书 64 窗口实测仍留后;本步验证 merge/闸/合并 + 产 S4 可用真实基座。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { segment, type SourceBlock } from "../../packages/core/src/segment";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import { splitWindows } from "../../packages/core/src/window";
import { mergeAndGate, type Pass1Output } from "../../packages/core/src/merge";
import { projectCatalog } from "../../packages/core/src/catalog";
import { FormulaSemanticsSidecarZ, Pass2BuildAuditSidecarZ, ReadOnlyBaseZ, TechnicalLearningDiscourseIndexZ } from "../../packages/core/src/zod";
import { buildProfileArtifactHeader, buildProfileMetadata } from "../../packages/core/src/profile-artifact";
import { buildFormulaSemanticsSidecar, type FormulaSemanticsBuildCandidate } from "../../packages/core/src/formula-semantics";
import { buildTechnicalLearningDiscourseIndex, type TechnicalLearningDiscourseItem } from "../../packages/core/src/discourse-index";
import { buildLidToWindowIndex, buildLongRangeCandidates, gatePass2BuildOutput, type Pass2LlmOutput } from "../../packages/core/src/pass2-build";
import { deriveBookId } from "../../packages/core/src/book-id";

const [book, outputsPath, idxList, formulaCandidatesPath, discourseCandidatesPath, pass2OutputPath] = process.argv.slice(2);
if (!book || !outputsPath || !idxList) {
  console.error("usage: tsx pass1-batch.ts <book> <outputs.json> <idx,idx,...> [formula-candidates.json] [discourse-candidates.json] [pass2-output.json]");
  process.exit(2);
}

let source: string;
let blocks: SourceBlock[];
if (/\.epub$/i.test(book)) ({ source, blocks } = epubToSource(new Uint8Array(readFileSync(book))));
else { source = readFileSync(book, "utf8"); blocks = markdownToBlocks(source); }

const lidNodes = segment(blocks);
const windows = splitWindows(lidNodes, source);
const outputs: Pass1Output[] = JSON.parse(readFileSync(outputsPath, "utf8"));

const { nodes, edges, report } = mergeAndGate(outputs, lidNodes);
const catalog = projectCatalog(nodes);

// 局部锚定率:分母 = 已抽窗口的叶子并集
const idxs = idxList.split(",").map(Number);
const sampledLeaves = new Set(idxs.flatMap((i) => windows[i].leafLids));
const anchored = new Set<string>();
for (const n of nodes) {
  if (n.type === "claim") { if (n.source_lid) anchored.add(n.source_lid); }
  else for (const l of n.occurrences) anchored.add(l);
}
const sampledAnchored = [...sampledLeaves].filter((l) => anchored.has(l)).length;
const sampledRate = sampledLeaves.size ? sampledAnchored / sampledLeaves.size : 0;

// 固化小基座 + zod 校验
const bookId = deriveBookId(book); // PB5-1 去硬编码:从书路径文件名 slug 派生 [ADR-0042]
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

console.log(`[pass1-batch] ${book}`);
console.log(`  窗口=${windows.length}  已抽=${idxs.length}(#${idxs.join(",#")})  全书叶子=${lidNodes.filter((n) => n.children.length === 0).length}`);
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
