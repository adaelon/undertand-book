// S3 Pass1 小样真实抽取 smoke(开发期 tsx)。验 pass1 prompt + 回填红线 + 确定性闸 链路,
// 不跑全书(全书锚定率实测留下一刀)。
//   list:   tsx pass1-smoke.ts <book>                      列窗口概览,挑一个正文窗口
//   emit:   tsx pass1-smoke.ts <book> <idx> emit           输出该窗口的 Pass1 抽取输入(喂 LLM)
//   verify: tsx pass1-smoke.ts <book> <idx> verify <json>  读抽取结果 → merge+闸 → 报告 + 红线校验
import { readFileSync } from "node:fs";
import { segment, type SourceBlock } from "../../packages/core/src/segment";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import { splitWindows } from "../../packages/core/src/window";
import { buildPass1Input } from "../../packages/core/src/pass1-input";
import { mergeAndGate, type Pass1Output } from "../../packages/core/src/merge";
import { projectCatalog } from "../../packages/core/src/catalog";

const [book, idxArg, mode, jsonPath] = process.argv.slice(2);
if (!book) {
  console.error("usage: tsx pass1-smoke.ts <book> [<idx> emit|verify <json>]");
  process.exit(2);
}

let source: string;
let blocks: SourceBlock[];
if (/\.epub$/i.test(book)) ({ source, blocks } = epubToSource(new Uint8Array(readFileSync(book))));
else { source = readFileSync(book, "utf8"); blocks = markdownToBlocks(source); }

const nodes = segment(blocks);
const byLid = new Map(nodes.map((n) => [n.lid, n]));
const windows = splitWindows(nodes, source);

if (!idxArg) {
  console.log(`windows=${windows.length}`);
  windows.forEach((w, i) => {
    const first = byLid.get(w.leafLids[0])!;
    const preview = source.slice(first.span.start, Math.min(first.span.end, first.span.start + 50)).replace(/\s+/g, " ");
    console.log(`#${i}\tlids=${w.leafLids.length}\ttok=${w.tokens}\t${w.leafLids[0]}..${w.leafLids[w.leafLids.length - 1]}\t${preview}`);
  });
  process.exit(0);
}

const idx = Number(idxArg);
const w = windows[idx];
const input = buildPass1Input(w, byLid, source);

if (mode === "emit") {
  console.log(input.text);
  process.exit(0);
}

if (mode === "verify") {
  const out: Pass1Output = JSON.parse(readFileSync(jsonPath, "utf8"));
  // 红线校验:抽取的每个 LID 必须在本窗口标注集内(回填红线 [ADR-0004])
  const winLids = new Set(input.lids);
  const cited = new Set<string>();
  for (const n of out.nodes) {
    for (const l of n.occurrences) cited.add(l);
    if (n.source_lid) cited.add(n.source_lid);
  }
  const outOfWindow = [...cited].filter((l) => !winLids.has(l));
  const { nodes: gnodes, edges, report } = mergeAndGate([out], nodes);
  const catalog = projectCatalog(gnodes);
  console.log(`[pass1-smoke verify] window #${idx}  lids=${input.lids.length}`);
  console.log(`  抽取: nodes=${out.nodes.length} edges=${out.edges.length}`);
  console.log(`  回填红线: 窗口外 LID=${outOfWindow.length} ${outOfWindow.length ? "→ " + outOfWindow.join(",") : "(全部回填合法 ✓)"}`);
  console.log(`  闸后: nodes=${report.nodesOut} edges=${report.edgesOut}  目录条目=${catalog.length}`);
  console.log(`  丢弃: 节点=${report.droppedNodes.length} 边=${report.droppedEdges.length} 剔除occ=${report.prunedOccurrences.length}`);
  console.log(`  窗口内锚定率(全书分母)=${(report.anchorRate * 100).toFixed(4)}%`);
  if (report.droppedNodes.length) console.log(`  droppedNodes: ${JSON.stringify(report.droppedNodes)}`);
  if (report.droppedEdges.length) console.log(`  droppedEdges: ${JSON.stringify(report.droppedEdges)}`);
  process.exit(0);
}

console.error("unknown mode:", mode);
process.exit(2);
