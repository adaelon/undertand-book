import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { checkPartitionInvariant } from "../src/partition";

describe("SA2 markdown asset block recognition", () => {
  const src = [
    "# Assets",
    "",
    "Before assets.",
    "",
    "```ts",
    "const x = 1;",
    "",
    "console.log(x);",
    "```",
    "",
    "| A | B |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "![diagram](img.png)",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "$a+b$",
    "",
    "After assets.",
  ].join("\n");

  it("marks code/table/image/formula leaves while preserving source marker text", () => {
    const blocks = markdownToBlocks(src);
    const assets = blocks.filter((b) => b.assetKind);
    expect(assets.map((b) => b.assetKind)).toEqual(["code", "table", "image", "formula", "formula"]);
    expect(assets[0].text).toBe("```ts\nconst x = 1;\n\nconsole.log(x);\n```");
    expect(assets[1].text).toBe("| A | B |\n| - | - |\n| 1 | 2 |");
    expect(assets[2].text).toBe("![diagram](img.png)");
    expect(assets[3].text).toBe("$$\nE = mc^2\n$$");
    expect(assets[4].text).toBe("$a+b$");
  });

  it("passes assetKind through segment while preserving the partition invariant", () => {
    const blocks = markdownToBlocks(src);
    const nodes = segment(blocks);
    const report = checkPartitionInvariant(nodes, src);
    expect(report.ok).toBe(true);
    expect(report.coverage).toBe(1);
    const assetNodes = blocks
      .filter((block) => block.assetKind)
      .map((b) => nodes.find((n) => n.children.length === 0 && n.span.start === b.span.start && n.span.end === b.span.end)?.kind);
    expect(assetNodes).toEqual(["code", "table", "image", "formula", "formula"]);
  });

  it("splits inline formulas inside paragraphs into formula leaves", () => {
    const inline = "Before $a+b$ after and $$c=d$$ done.";
    const blocks = markdownToBlocks(inline);
    expect(blocks.map((b) => ({ text: b.text, assetKind: b.assetKind ?? "paragraph" }))).toEqual([
      { text: "Before ", assetKind: "paragraph" },
      { text: "$a+b$", assetKind: "formula" },
      { text: " after and ", assetKind: "paragraph" },
      { text: "$$c=d$$", assetKind: "formula" },
      { text: " done.", assetKind: "paragraph" },
    ]);

    const nodes = segment(blocks);
    const report = checkPartitionInvariant(nodes, inline);
    expect(report.ok).toBe(true);
    expect(nodes.filter((n) => n.kind === "formula")).toHaveLength(2);
  });

  it("recognizes single-dollar display math blocks as formula leaves", () => {
    const display = ["Before.", "", "$", "I(X;Y) \\le H(Y)", "$", "", "After."].join("\n");
    const blocks = markdownToBlocks(display);
    expect(blocks.map((b) => ({ text: b.text, assetKind: b.assetKind ?? "paragraph" }))).toEqual([
      { text: "Before.", assetKind: "paragraph" },
      { text: "$\nI(X;Y) \\le H(Y)\n$", assetKind: "formula" },
      { text: "After.", assetKind: "paragraph" },
    ]);

    const nodes = segment(blocks);
    const report = checkPartitionInvariant(nodes, display);
    expect(report.ok).toBe(true);
    expect(nodes.filter((n) => n.kind === "formula")).toHaveLength(1);
  });

  it("keeps unmatched dollar markers as paragraph text", () => {
    const src = "Price ends with $ and unmatched $$ marker.";
    const blocks = markdownToBlocks(src);
    expect(blocks).toEqual([{ kind: "leaf", text: src, span: { start: 0, end: src.length } }]);
  });
});
