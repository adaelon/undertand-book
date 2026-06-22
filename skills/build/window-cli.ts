// S2 窗口切分 CLI(开发期经 tsx 运行:`pnpm exec tsx skills/build/window-cli.ts <epub|md> [maxInputTokens] [maxLeavesSoft]`)。
// 串:适配器 → segment(S1)→ splitWindows(S2)→ 报告窗口数/token 分布 + 窗口层划分校验。
// 实测落点:窗口数/分布 → 回填 ADR-0009 输入安全系数 / 输出软上限 / 融合·细分阈值。
import { readFileSync } from "node:fs";
import { segment } from "../../packages/core/src/segment";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import { splitWindows, estimateTokens, DEFAULT_BUDGET } from "../../packages/core/src/window";
import type { SourceBlock } from "../../packages/core/src/segment";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx skills/build/window-cli.ts <path-to-epub-or-md> [maxInputTokens] [maxLeavesSoft]");
  process.exit(2);
}
const budget = {
  maxInputTokens: process.argv[3] ? Number(process.argv[3]) : DEFAULT_BUDGET.maxInputTokens,
  maxLeavesSoft: process.argv[4] ? Number(process.argv[4]) : DEFAULT_BUDGET.maxLeavesSoft,
};

let source: string;
let blocks: SourceBlock[];
if (/\.epub$/i.test(path)) {
  ({ source, blocks } = epubToSource(new Uint8Array(readFileSync(path))));
} else {
  source = readFileSync(path, "utf8");
  blocks = markdownToBlocks(source);
}

const nodes = segment(blocks);
const windows = splitWindows(nodes, source, budget);

// 窗口层划分校验:全部叶子被窗口恰好覆盖一次。
const allLeaves = nodes.filter((n) => n.children.length === 0).map((n) => n.lid);
const seen = new Set<string>();
let overlap = 0;
for (const w of windows) for (const l of w.leafLids) (seen.has(l) ? overlap++ : seen.add(l));
const missing = allLeaves.filter((l) => !seen.has(l)).length;
const partitionOk = overlap === 0 && missing === 0 && seen.size === allLeaves.length;

const toks = windows.map((w) => w.tokens).sort((a, b) => a - b);
const sum = toks.reduce((s, t) => s + t, 0);
const median = toks.length ? toks[Math.floor(toks.length / 2)] : 0;
const over = windows.filter((w) => w.overBudget).length;
const totalLeafTok = allLeaves.reduce(
  (s, l) => {
    const n = nodes.find((x) => x.lid === l)!;
    return s + estimateTokens(source.slice(n.span.start, n.span.end));
  },
  0,
);

console.log(`[window-cli] ${path}`);
console.log(`  budget: maxInputTokens=${budget.maxInputTokens}  maxLeavesSoft=${budget.maxLeavesSoft}`);
console.log(`  leaves=${allLeaves.length}  正文≈${totalLeafTok} tok`);
console.log(`  windows=${windows.length}  over_budget(单叶超限)=${over}`);
console.log(`  tok/win: min=${toks[0] ?? 0}  median=${median}  max=${toks[toks.length - 1] ?? 0}  avg=${windows.length ? Math.round(sum / windows.length) : 0}`);
console.log(`  利用率(avg/硬闸)=${windows.length ? ((sum / windows.length / budget.maxInputTokens) * 100).toFixed(1) : 0}%`);
console.log(`  partition.ok=${partitionOk}  (overlap=${overlap} missing=${missing})`);
process.exit(partitionOk ? 0 : 1);
