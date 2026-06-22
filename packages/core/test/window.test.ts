import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import type { LidNode } from "../src/generated/LidNode";
import { splitWindows, estimateTokens, type WindowBudget, type Window } from "../src/window";

const here = dirname(fileURLToPath(import.meta.url));
const sampleSrc = readFileSync(resolve(here, "fixtures/sample.md"), "utf8");

/** 窗口层分区不变式:全部叶子被窗口恰好覆盖一次(无遗漏 + 无重叠)。 */
function assertLeafPartition(nodes: LidNode[], windows: Window[]) {
  const allLeaves = nodes.filter((n) => n.children.length === 0).map((n) => n.lid);
  const seen = new Set<string>();
  for (const w of windows) {
    for (const l of w.leafLids) {
      expect(seen.has(l)).toBe(false); // 无重叠
      seen.add(l);
    }
  }
  expect(seen.size).toBe(allLeaves.length); // 全覆盖(计数)
  for (const l of allLeaves) expect(seen.has(l)).toBe(true); // 全覆盖(逐一)
}

describe("estimateTokens(确定性近似)", () => {
  it("CJK 按 1 / ASCII 按 0.25,向上取整", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1); // ceil(4*0.25)
    expect(estimateTokens("中a")).toBe(2); // ceil(1 + 0.25)
    expect(estimateTokens("")).toBe(0);
  });
});

describe("S2 窗口切分 [ADR-0009]", () => {
  const blocks = markdownToBlocks(sampleSrc);
  const nodes = segment(blocks);
  const BIG: WindowBudget = { maxInputTokens: 1_000_000, maxLeavesSoft: 10_000 };

  it("大预算下叶子被窗口划分(无遗漏无重叠)", () => {
    const windows = splitWindows(nodes, sampleSrc, BIG);
    assertLeafPartition(nodes, windows);
  });

  it("窗口 token = 其覆盖叶子的估算和", () => {
    const byLid = new Map(nodes.map((n) => [n.lid, n]));
    const windows = splitWindows(nodes, sampleSrc, BIG);
    for (const w of windows) {
      const expected = w.leafLids.reduce(
        (s, l) => s + estimateTokens(sampleSrc.slice(byLid.get(l)!.span.start, byLid.get(l)!.span.end)),
        0,
      );
      expect(w.tokens).toBe(expected);
    }
  });

  it("超大子树按叶子细分:每窗 token ≤ 硬闸 + 仍是划分", () => {
    // 单章 + 很多段,设小硬闸逼细分
    const md = "# 章一\n\n" + Array.from({ length: 20 }, (_, i) => `这是第${i}段的正文内容填充。`).join("\n\n");
    const n = segment(markdownToBlocks(md));
    const budget: WindowBudget = { maxInputTokens: 20, maxLeavesSoft: 1000 };
    const windows = splitWindows(n, md, budget);
    expect(windows.length).toBeGreaterThan(1); // 确实被细分
    for (const w of windows) {
      if (!w.overBudget) expect(w.tokens).toBeLessThanOrEqual(budget.maxInputTokens);
    }
    assertLeafPartition(n, windows);
  });

  it("过小单元贪心合并:窗口数 < 叶子数(且每窗 ≤ 硬闸)", () => {
    const md = "# 章一\n\n" + Array.from({ length: 12 }, (_, i) => `短句${i}。`).join("\n\n");
    const n = segment(markdownToBlocks(md));
    const leaves = n.filter((x) => x.children.length === 0).length;
    const budget: WindowBudget = { maxInputTokens: 6, maxLeavesSoft: 1000 };
    const windows = splitWindows(n, md, budget);
    expect(windows.length).toBeLessThan(leaves); // 小单元被合并
    for (const w of windows) expect(w.tokens).toBeLessThanOrEqual(budget.maxInputTokens);
    assertLeafPartition(n, windows);
  });

  it("软闸:单窗口叶子数 ≤ maxLeavesSoft", () => {
    const md = "# 章一\n\n" + Array.from({ length: 20 }, (_, i) => `第${i}段。`).join("\n\n");
    const n = segment(markdownToBlocks(md));
    const budget: WindowBudget = { maxInputTokens: 1_000_000, maxLeavesSoft: 3 };
    const windows = splitWindows(n, md, budget);
    for (const w of windows) {
      if (!w.overBudget) expect(w.leafLids.length).toBeLessThanOrEqual(3);
    }
    assertLeafPartition(n, windows);
  });

  it("不跨卷:无窗口同时覆盖两个顶层(卷)的叶子", () => {
    const md = "# 卷一\n\n卷一正文。\n\n# 卷二\n\n卷二正文。";
    const n = segment(markdownToBlocks(md));
    const byLid = new Map(n.map((x) => [x.lid, x]));
    const BIG2: WindowBudget = { maxInputTokens: 1_000_000, maxLeavesSoft: 10_000 };
    const windows = splitWindows(n, md, BIG2);
    for (const w of windows) {
      const tops = new Set(w.leafLids.map((l) => byLid.get(l)!.path[0]));
      expect(tops.size).toBe(1); // 每窗口只属一个顶层
    }
    assertLeafPartition(n, windows);
  });

  it("单叶超硬闸:不腰斩,自成一窗并标 overBudget", () => {
    const md = "# 章一\n\n" + "这是一个超长的段落".repeat(20); // 单段远超硬闸
    const n = segment(markdownToBlocks(md));
    const budget: WindowBudget = { maxInputTokens: 5, maxLeavesSoft: 1000 };
    const windows = splitWindows(n, md, budget);
    const over = windows.filter((w) => w.overBudget);
    expect(over.length).toBeGreaterThan(0);
    for (const w of over) expect(w.leafLids.length).toBe(1); // 单叶,未腰斩
    assertLeafPartition(n, windows);
  });
});
