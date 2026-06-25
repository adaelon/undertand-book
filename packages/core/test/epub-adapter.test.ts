import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { xhtmlToBlocks, epubToSource } from "../src/epub-adapter";
import { segment } from "../src/segment";
import { checkPartitionInvariant } from "../src/partition";

describe("SA3 epub xhtml asset block recognition", () => {
  const html = `<?xml version="1.0"?><html><body>
    <h1>Command Pattern</h1>
    <p class="body">Commands are reified calls.</p>
    <blockquote><p>Nested blockquote paragraph.</p></blockquote>
    <h2>Examples</h2>
    <pre>function demo() {
  return 1;
}</pre>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <img alt="diagram" src="images/diagram.png" />
    <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>
  </body></html>`;

  const blocks = xhtmlToBlocks(html);

  it("keeps headings and ordinary leaves while marking pre/table/img/math assets", () => {
    expect(blocks.map((b) => [b.kind, b.level, b.assetKind, b.text])).toEqual([
      ["heading", 1, undefined, "Command Pattern"],
      ["leaf", undefined, undefined, "Commands are reified calls."],
      ["leaf", undefined, undefined, "Nested blockquote paragraph."],
      ["heading", 2, undefined, "Examples"],
      ["leaf", undefined, "code", "function demo() {\n  return 1;\n}"],
      ["leaf", undefined, "table", "| A | B |\n| 1 | 2 |"],
      ["leaf", undefined, "image", "![diagram](images/diagram.png)"],
      [
        "leaf",
        undefined,
        "formula",
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>',
      ],
    ]);
  });
});

describe("SA3 epubToSource full chain with assets", () => {
  function makeEpub(): Uint8Array {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`;
    const opf = `<package><manifest>
      <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="c1"/></spine></package>`;
    const ch1 = `<html><body>
      <h1>Intro</h1>
      <p>First paragraph.</p>
      <pre>line 1
  line 2</pre>
      <table><tr><td>x</td><td>y</td></tr></table>
      <img alt="cover" src="cover.png" />
      <math><mi>a</mi><mo>+</mo><mi>b</mi></math>
    </body></html>`;
    return zipSync({
      "META-INF/container.xml": strToU8(container),
      "OEBPS/content.opf": strToU8(opf),
      "OEBPS/Text/ch1.xhtml": strToU8(ch1),
    });
  }

  const { source, blocks } = epubToSource(makeEpub());
  const nodes = segment(blocks);

  it("passes assetKind through segment", () => {
    expect(blocks.map((b) => b.assetKind).filter(Boolean)).toEqual(["code", "table", "image", "formula"]);
    expect(source).toContain("line 1\n  line 2");
    expect(source).toContain("| x | y |");
    expect(source).toContain("![cover](cover.png)");
    expect(source).toContain("<math><mi>a</mi><mo>+</mo><mi>b</mi></math>");

    const assetNodes = blocks
      .filter((block) => block.assetKind)
      .map((b) => nodes.find((n) => n.children.length === 0 && n.span.start === b.span.start && n.span.end === b.span.end)?.kind);
    expect(assetNodes).toEqual(["code", "table", "image", "formula"]);
  });

  it("preserves the partition invariant", () => {
    const report = checkPartitionInvariant(nodes, source);
    expect(report.violations).toEqual([]);
    expect(report.coverage).toBe(1);
    expect(nodes.find((n) => n.lid === "1")?.kind).toBe("chapter");
    expect(nodes.filter((n) => n.children.length === 0)).toHaveLength(6);
  });
});
