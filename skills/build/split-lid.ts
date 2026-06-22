// S1 段切分 CLI（开发期经 tsx 运行:`pnpm exec tsx skills/build/split-lid.ts <epub|md>`）。
// 串:适配器(epub/md → 忠实块)→ segment(Model A)→ 分区不变式闸。打印报告,违例非零退出。
// 产物落 `.understand-book/`(写盘)留 S3/S7 收口,本步只验切分 + 不变式。
import { readFileSync } from "node:fs";
import { segment } from "../../packages/core/src/segment";
import { checkPartitionInvariant } from "../../packages/core/src/partition";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import type { SourceBlock } from "../../packages/core/src/segment";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx skills/build/split-lid.ts <path-to-epub-or-md>");
  process.exit(2);
}

let source: string;
let blocks: SourceBlock[];
if (/\.epub$/i.test(path)) {
  ({ source, blocks } = epubToSource(new Uint8Array(readFileSync(path))));
} else {
  source = readFileSync(path, "utf8");
  blocks = markdownToBlocks(source);
}

const nodes = segment(blocks);
const report = checkPartitionInvariant(nodes, source);
const leaves = nodes.filter((n) => n.children.length === 0).length;

console.log(`[split-lid] ${path}`);
console.log(`  blocks=${blocks.length}  nodes=${nodes.length}  leaves=${leaves}  containers=${nodes.length - leaves}`);
console.log(`  source chars=${source.length}`);
console.log(`  partition.ok=${report.ok}  coverage=${(report.coverage * 100).toFixed(4)}%`);
if (!report.ok) {
  console.log(`  violations(${report.violations.length}):`);
  for (const v of report.violations.slice(0, 12)) console.log(`    ${v.code}: ${v.detail}`);
}
process.exit(report.ok ? 0 : 1);
