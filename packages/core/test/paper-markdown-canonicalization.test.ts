import { describe, expect, it } from "vitest";
import { canonicalizePaperMarkdown } from "../src/paper-markdown-canonicalization";

describe("paper Markdown canonicalization", () => {
  it("unwraps nested presentation-only divs around a figure caption", () => {
    const caption = "Figure 3 Swap task diagram. The vocabulary size is $ C_{5}^{2} = 10 $.";
    const source = [
      "Before.",
      "",
      `<div style="text-align: center;"><div style="text-align: center;">${caption}</div> </div>`,
      "",
      "After.",
    ].join("\n");

    const result = canonicalizePaperMarkdown(source);

    expect(result.markdown).toBe(["Before.", "", caption, "", "After."].join("\n"));
    expect(result.repairs).toEqual([expect.objectContaining({
      kind: "presentation_html_unwrap",
      replacement: caption,
    })]);
  });

  it("unwraps one centered text div while preserving surrounding newlines", () => {
    const source = '<div align="center">Figure 1. Caption.</div>\r\nNext.\r\n';

    expect(canonicalizePaperMarkdown(source).markdown).toBe("Figure 1. Caption.\r\nNext.\r\n");
  });

  it("does not rewrite centered image wrappers", () => {
    const source = '<div style="text-align: center;"><img src="figure.png" alt="Figure" width="42%" /></div>';

    expect(canonicalizePaperMarkdown(source)).toEqual({ markdown: source, repairs: [] });
  });

  it("does not rewrite structural or unknown HTML", () => {
    const sources = [
      '<div style="color: red;">Important.</div>',
      '<div style="text-align: center;"><span>Caption.</span></div>',
      '<table><tr><td>Value</td></tr></table>',
      '<div style="text-align: center;">First.</div><div style="text-align: center;">Second.</div>',
    ];

    for (const source of sources) {
      expect(canonicalizePaperMarkdown(source)).toEqual({ markdown: source, repairs: [] });
    }
  });
});
