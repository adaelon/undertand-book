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
});
