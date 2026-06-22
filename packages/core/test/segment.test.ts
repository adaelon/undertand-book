import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { checkPartitionInvariant } from "../src/partition";
import { LidNodeZ } from "../src/zod";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "fixtures/sample.md"), "utf8");

describe("S1 段级 LID 切分(Model A)", () => {
  const blocks = markdownToBlocks(src);
  const nodes = segment(blocks);
  const byLid = new Map(nodes.map((n) => [n.lid, n]));

  it("分区不变式通过 + 切段覆盖率 100%", () => {
    const report = checkPartitionInvariant(nodes, src);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.coverage).toBe(1);
  });

  it("Model A 结构:容器 + 标题首叶", () => {
    // 章容器 "1" 有 5 子(标题段 + 2 正文段 + 2 节容器)
    expect(byLid.get("1")?.kind).toBe("chapter");
    expect(byLid.get("1")?.children).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5"]);
    // 标题 = 容器首叶,kind paragraph(LidNode 不存 text,文本走 span 回切原文)
    expect(byLid.get("1.1")?.kind).toBe("paragraph");
    // 节容器
    expect(byLid.get("1.4")?.kind).toBe("section");
    expect(byLid.get("1.4")?.children).toEqual(["1.4.1", "1.4.2"]);
    expect(byLid.get("1.5")?.children).toEqual(["1.5.1", "1.5.2"]);
  });

  it("叶子标题段 span 回切原文含标题文字", () => {
    const titleLeaf = byLid.get("1.1")!;
    expect(src.slice(titleLeaf.span.start, titleLeaf.span.end)).toBe("# 第1章 引言");
    const para = byLid.get("1.2")!;
    expect(src.slice(para.span.start, para.span.end)).toBe("这是引言的第一段。");
  });

  it("叶子数 = 7,容器数 = 3,总节点 = 10", () => {
    const leaves = nodes.filter((n) => n.children.length === 0);
    expect(leaves).toHaveLength(7);
    expect(nodes.length - leaves.length).toBe(3);
    expect(nodes).toHaveLength(10);
  });

  it("每个节点符合 LidNode schema(zod 镜像 Rust 权威)", () => {
    for (const n of nodes) LidNodeZ.parse(n);
  });
});
