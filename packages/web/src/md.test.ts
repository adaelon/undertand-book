import { describe, expect, it } from "vitest";
import { renderInlineMarkdown } from "./md";

describe("renderInlineMarkdown", () => {
  it("renders spaced inline superscript math from paper author lines", () => {
    const html = renderInlineMarkdown("Michael Gotthardt $ ^{1,2,3} $");

    expect(html).toContain('<sup class="inline-citation-sup">1,2,3</sup>');
    expect(html).not.toContain("$ ^{1,2,3} $");
  });

  it("still renders ordinary spaced inline math with KaTeX", () => {
    const html = renderInlineMarkdown("Use $ x^2 $ here.");

    expect(html).toContain("katex");
    expect(html).not.toContain("$ x^2 $");
  });

  it("leaves ordinary spaced dollar text alone", () => {
    const html = renderInlineMarkdown("The fee is $ 10 $ today.");

    expect(html).toContain("$ 10 $");
    expect(html).not.toContain("katex");
  });
});
