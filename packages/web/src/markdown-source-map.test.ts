// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderInlineMarkdown } from "./md";
import {
  createMarkdownDomSourceMap,
  markMarkdownDomSourceRanges,
  sourceTextForRanges,
} from "./markdown-source-map";

function rendered(source: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = renderInlineMarkdown(source);
  return root;
}

function selectText(node: Node, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

describe("Markdown DOM/source mapping", () => {
  it("maps a selection after emphasis to canonical source offsets", () => {
    const source = "**bold** tail";
    const root = rendered(source);
    const tail = root.childNodes[1];
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selectText(tail, 1, 5));

    expect(ranges).toEqual([{ start: 9, end: 13 }]);
    expect(sourceTextForRanges(source, ranges)).toBe("tail");
  });

  it("splits one visible selection around Markdown-only syntax", () => {
    const source = "**bold** tail";
    const root = rendered(source);
    const strongText = root.querySelector("strong")!.firstChild!;
    const tail = root.childNodes[1];
    const selection = document.createRange();
    selection.setStart(strongText, 0);
    selection.setEnd(tail, 5);
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selection);

    expect(ranges).toEqual([
      { start: 2, end: 6 },
      { start: 8, end: 13 },
    ]);
    expect(sourceTextForRanges(source, ranges)).toBe("bold tail");
  });

  it("keeps visible link, escape, and code text while omitting their syntax", () => {
    const source = "[link](https://example.test) \\*literal\\* `code`";
    const root = rendered(source);
    const selection = document.createRange();
    selection.selectNodeContents(root);
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selection);

    expect(sourceTextForRanges(source, ranges)).toBe(root.textContent);
    expect(sourceTextForRanges(source, ranges)).toBe("link *literal* code");
  });

  it("uses UTF-16 offsets for astral characters", () => {
    const source = "**😀x** tail";
    const root = rendered(source);
    const strongText = root.querySelector("strong")!.firstChild!;
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selectText(strongText, 2, 3));

    expect(ranges).toEqual([{ start: 4, end: 5 }]);
    expect(sourceTextForRanges(source, ranges)).toBe("x");
  });

  it("maps repeated visible text to its selected source occurrence", () => {
    const source = "**same** same";
    const root = rendered(source);
    const tail = root.childNodes[1];
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selectText(tail, 1, 5));

    expect(ranges).toEqual([{ start: 9, end: 13 }]);
  });

  it("maps decoded Markdown entities back to their complete source spelling", () => {
    const source = "A &copy; mark";
    const root = rendered(source);
    const text = root.firstChild!;
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selectText(text, 2, 3));

    expect(sourceTextForRanges(source, ranges)).toBe("&copy;");
  });

  it("counts a Markdown hard line break once", () => {
    const source = "first\nsecond";
    const root = rendered(source);
    const secondLine = root.lastChild!;
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selectText(secondLine, 1, 7));

    expect(map.semanticText).toBe(source);
    expect(sourceTextForRanges(source, ranges)).toBe("second");
  });

  it("treats KaTeX output as one semantic Markdown atom", () => {
    const source = "before $ x^2 $ after";
    const root = rendered(source);
    const katex = root.querySelector(".katex")!;
    const selection = document.createRange();
    selection.selectNode(katex);
    const map = createMarkdownDomSourceMap(source, root);

    const ranges = map.sourceRangesForRange(selection);

    expect(sourceTextForRanges(source, ranges)).toBe("$x^2$");
  });

  it("marks source ranges after one complete Markdown render", () => {
    const source = "**bold** tail";
    const root = rendered(source);

    markMarkdownDomSourceRanges(source, root, [
      { start: 2, end: 6, className: "hl-mark" },
      { start: 9, end: 13, className: "hl-mark source-focus-mark" },
    ]);

    expect(root.innerHTML).toBe(
      '<strong><mark class="hl-mark">bold</mark></strong> <mark class="hl-mark source-focus-mark">tail</mark>',
    );
    expect(root.textContent).toBe("bold tail");
  });

  it("wraps a selected KaTeX atom without splitting its generated DOM", () => {
    const source = "before $x^2$ after";
    const root = rendered(source);
    const katex = root.querySelector(".katex")!;

    markMarkdownDomSourceRanges(source, root, [
      { start: 7, end: 12, className: "hl-mark" },
    ]);

    expect(katex.parentElement?.tagName).toBe("MARK");
    expect(katex.parentElement?.className).toBe("hl-mark");
    expect(root.querySelectorAll(".katex")).toHaveLength(1);
  });
});
