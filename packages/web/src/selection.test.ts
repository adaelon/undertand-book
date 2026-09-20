// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { rangeToMarkdown } from "./selection";

describe("rangeToMarkdown reader decorations", () => {
  it("keeps selected source text while excluding reader controls inside a cross-block range", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>first</p><div data-reader-selection-ignore>编辑 删除</div><p>second</p>';
    const range = document.createRange();
    range.setStart(root.firstElementChild!.firstChild!, 0);
    range.setEnd(root.lastElementChild!.firstChild!, 6);
    expect(rangeToMarkdown(range)).toBe("first\n\nsecond");
  });
});
