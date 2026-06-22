import { describe, it, expect } from "vitest";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows, type WindowBudget } from "../src/window";
import { buildPass1Inputs } from "../src/pass1-input";

const md = "# 章一\n\n第一段内容。\n\n第二段内容。\n\n# 章二\n\n第三段内容。";
const nodes = segment(markdownToBlocks(md));
const byLid = new Map(nodes.map((n) => [n.lid, n]));
const BIG: WindowBudget = { maxInputTokens: 1_000_000, maxLeavesSoft: 10_000 };

describe("S3 Pass1 输入组装 [ADR-0010]", () => {
  const windows = splitWindows(nodes, md, BIG);
  const inputs = buildPass1Inputs(windows, nodes, md);

  it("输入数 = 窗口数,windowId/lids 与窗口一致", () => {
    expect(inputs.length).toBe(windows.length);
    for (let i = 0; i < inputs.length; i++) {
      expect(inputs[i].windowId).toBe(windows[i].id);
      expect(inputs[i].lids).toEqual(windows[i].leafLids);
    }
  });

  it("每个叶子段前缀 [LID] + 真原文(回填红线物理前提)", () => {
    for (const inp of inputs) {
      for (const lid of inp.lids) {
        const n = byLid.get(lid)!;
        const orig = md.slice(n.span.start, n.span.end);
        expect(inp.text).toContain(`[${lid}] ${orig}`);
      }
    }
  });

  it("全部叶子被覆盖且无遗漏(= 窗口划分)", () => {
    const allLeaves = nodes.filter((n) => n.children.length === 0).map((n) => n.lid);
    const covered = inputs.flatMap((i) => i.lids);
    expect(new Set(covered).size).toBe(allLeaves.length);
    for (const l of allLeaves) expect(covered).toContain(l);
  });

  it("标注顺序 = 文档序(块间空行分隔)", () => {
    // 取含多段的窗口,验前缀按 leafLids 顺序出现
    const multi = inputs.find((i) => i.lids.length >= 2)!;
    const positions = multi.lids.map((lid) => multi.text.indexOf(`[${lid}]`));
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
  });
});
