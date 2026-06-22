// 查看已生成基座(开发工具)。LID 树从书 segment(确定性)取 + 文本预览;图谱从 base.json 取。
//   tsx show-base.ts <book> <base.json> tree <lidPrefix>   缩进打印某子树的 LID 结构 + 文本预览
//   tsx show-base.ts <book> <base.json> graph              打印知识图谱(节点按类型 + 边)
//   tsx show-base.ts <book> <base.json> concept <name>     某概念/实体的 occurrences + 关联边
import { readFileSync } from "node:fs";
import { segment, type SourceBlock } from "../../packages/core/src/segment";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import type { LidNode } from "../../packages/core/src/generated/LidNode";
import type { GraphNode } from "../../packages/core/src/generated/GraphNode";
import type { GraphEdge } from "../../packages/core/src/generated/GraphEdge";

const [book, basePath, mode, arg] = process.argv.slice(2);
if (!book || !basePath || !mode) {
  console.error("usage: tsx show-base.ts <book> <base.json> tree <prefix> | graph | concept <name>");
  process.exit(2);
}

let source: string;
let blocks: SourceBlock[];
if (/\.epub$/i.test(book)) ({ source, blocks } = epubToSource(new Uint8Array(readFileSync(book))));
else { source = readFileSync(book, "utf8"); blocks = markdownToBlocks(source); }
const nodes: LidNode[] = segment(blocks);
const base: { graph_nodes: GraphNode[]; graph_edges: GraphEdge[] } = JSON.parse(readFileSync(basePath, "utf8"));
const nameOf = new Map(base.graph_nodes.map((n) => [n.id, n.name]));
const preview = (n: LidNode, len = 46) => source.slice(n.span.start, Math.min(n.span.end, n.span.start + len)).replace(/\s+/g, " ");

if (mode === "tree") {
  const prefix = arg ?? "";
  const sub = nodes.filter((n) => n.lid === prefix || n.lid.startsWith(prefix + "."));
  for (const n of sub) {
    const indent = "  ".repeat(Math.max(0, n.path.length - 1));
    const tag = n.children.length ? `[${n.kind}]` : `·`;
    console.log(`${indent}${n.lid} ${tag} ${preview(n)}`);
  }
  console.log(`\n(${sub.length} 节点,前缀 "${prefix}")`);
} else if (mode === "graph") {
  const byType = (t: string) => base.graph_nodes.filter((n) => n.type === t);
  for (const t of ["entity", "concept", "claim"]) {
    const ns = byType(t);
    console.log(`\n### ${t}(${ns.length})`);
    for (const n of ns) {
      const anchor = n.type === "claim" ? n.source_lid : n.occurrences.join(",");
      console.log(`  ${n.name}  @${anchor}`);
    }
  }
  console.log(`\n### edges(${base.graph_edges.length})`);
  for (const e of base.graph_edges) {
    const a = e.direction === "directed" ? "→" : "↔";
    console.log(`  ${nameOf.get(e.source) ?? e.source} ${a}[${e.type} ${e.weight}] ${nameOf.get(e.target) ?? e.target}`);
  }
} else if (mode === "concept") {
  const n = base.graph_nodes.find((x) => x.name === arg || x.id === arg);
  if (!n) { console.log(`未找到: ${arg}`); process.exit(1); }
  console.log(`${n.name} (${n.id})`);
  console.log(`  occurrences: ${n.type === "claim" ? n.source_lid : n.occurrences.join(", ")}`);
  for (const e of base.graph_edges.filter((x) => x.source === n.id || x.target === n.id)) {
    const a = e.direction === "directed" ? "→" : "↔";
    console.log(`  ${nameOf.get(e.source)} ${a}[${e.type}] ${nameOf.get(e.target)}`);
  }
}
