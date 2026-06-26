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
import { FormulaSemanticsSidecarZ, ReadOnlyBaseZ } from "../../packages/core/src/zod";
import { buildProfileArtifactHeader, buildProfileMetadata } from "../../packages/core/src/profile-artifact";
import { buildFormulaSemanticsSidecar, type FormulaSemanticsBuildCandidate } from "../../packages/core/src/formula-semantics";

const [book, outputsPath, idxList, formulaCandidatesPath] = process.argv.slice(2);
if (!book || !outputsPath || !idxList) {
  console.error("usage: tsx pass1-batch.ts <book> <outputs.json> <idx,idx,...> [formula-candidates.json]");
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
const bookId = "game-programming-patterns";
const base = { book_id: bookId, lid_nodes: lidNodes, graph_nodes: nodes, graph_edges: edges };
const parsedBase = ReadOnlyBaseZ.parse(base); // 产出前自检(字段失配抛错)
const profileHeader = buildProfileArtifactHeader({ book_id: parsedBase.book_id });
const profileMetadata = buildProfileMetadata(profileHeader);
const formulaSidecar = formulaCandidatesPath
  ? buildFormulaSemanticsSidecar(
      profileHeader,
      JSON.parse(readFileSync(formulaCandidatesPath, "utf8")) as FormulaSemanticsBuildCandidate[],
      lidNodes,
    )
  : null;
if (formulaSidecar) FormulaSemanticsSidecarZ.parse(formulaSidecar.sidecar);
const dir = `.understand-book/${bookId}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/base.json`, JSON.stringify(base, null, 2), "utf8");
writeFileSync(`${dir}/source.txt`, source, "utf8"); // 原文旁路:book.text 取真原文用,按 LID.span(UTF-16)切 `[ADR-0024]`
writeFileSync(`${dir}/profile_metadata.json`, JSON.stringify(profileMetadata, null, 2), "utf8");
if (formulaSidecar) {
  writeFileSync(`${dir}/formula_semantics.json`, JSON.stringify(formulaSidecar.sidecar, null, 2), "utf8");
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
