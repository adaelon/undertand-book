import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { xhtmlToBlocks, epubToSource } from "../src/epub-adapter";
import { segment } from "../src/segment";
import { checkPartitionInvariant } from "../src/partition";

describe("epub xhtml 块抽取(忠实块映射)", () => {
  const html = `<?xml version="1.0"?><html><body>
    <h1>第2章 命令模式</h1>
    <p class="zw">命令模式是我最喜爱的模式之一。</p>
    <blockquote class="引用"><p>Reify 出自拉丁文 res。</p></blockquote>
    <h2>2.1 配置输入</h2>
    <pre>void code() {}</pre>
  </body></html>`;
  const blocks = xhtmlToBlocks(html);

  it("heading 带 level;blockquote 作一个 leaf,内嵌 p 不重复算", () => {
    expect(blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
      ["heading", 1, "第2章 命令模式"],
      ["leaf", undefined, "命令模式是我最喜爱的模式之一。"],
      ["leaf", undefined, "Reify 出自拉丁文 res。"],
      ["heading", 2, "2.1 配置输入"],
      ["leaf", undefined, "void code() {}"],
    ]);
  });
});

describe("epubToSource 全链路(合成 epub)", () => {
  function makeEpub(): Uint8Array {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`;
    const opf = `<package><manifest>
      <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="c1"/></spine></package>`;
    const ch1 = `<html><body><h1>第1章 引言</h1><p>第一段。</p><p>第二段。</p></body></html>`;
    return zipSync({
      "META-INF/container.xml": strToU8(container),
      "OEBPS/content.opf": strToU8(opf),
      "OEBPS/Text/ch1.xhtml": strToU8(ch1),
    });
  }

  const { source, blocks } = epubToSource(makeEpub());
  const nodes = segment(blocks);

  it("spine→blocks→segment→分区不变式,覆盖率 100%", () => {
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "leaf", "leaf"]);
    const report = checkPartitionInvariant(nodes, source);
    expect(report.violations).toEqual([]);
    expect(report.coverage).toBe(1);
    // Model A:章容器 "1" + 标题叶 1.1 + 段 1.2/1.3
    expect(nodes.find((n) => n.lid === "1")?.kind).toBe("chapter");
    expect(nodes.filter((n) => n.children.length === 0)).toHaveLength(3);
  });
});
