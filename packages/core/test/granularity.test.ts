import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { markdownToBlocks } from "../src/md-adapter";
import {
  buildGranularityProfile,
  countEpubAssetCandidates,
  countMarkdownAssetCandidates,
  countXhtmlAssetCandidates,
  estimateSentenceCount,
} from "../src/granularity";

describe("SA0 GranularityProfile", () => {
  it("用确定性规则估算句数", () => {
    expect(estimateSentenceCount("第一句。第二句！第三句？")).toBe(3);
    expect(estimateSentenceCount("One sentence. Version 1.2 stays together.")).toBe(2);
    expect(estimateSentenceCount("No terminal punctuation still counts")).toBe(1);
  });

  it("统计 Markdown asset 候选数量", () => {
    const md = [
      "# T",
      "",
      "![alt](img.png)",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "$$E=mc^2$$ and inline $a+b$",
    ].join("\n");
    expect(countMarkdownAssetCandidates(md)).toEqual({
      code: 1,
      table: 1,
      image: 1,
      formula: 2,
    });
  });

  it("统计 XHTML/EPUB asset 候选数量", () => {
    const html = `<html><body>
      <pre>x()</pre><table><tr><td>a</td></tr></table>
      <img src="x.png" alt="x"/><math><mi>x</mi></math>
    </body></html>`;
    expect(countXhtmlAssetCandidates(html)).toEqual({
      code: 1,
      table: 1,
      image: 1,
      formula: 1,
    });

    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`;
    const opf = `<package><manifest>
      <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
      <item id="unused" href="unused.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="c1"/></spine></package>`;
    const epub = zipSync({
      "META-INF/container.xml": strToU8(container),
      "OEBPS/content.opf": strToU8(opf),
      "OEBPS/ch1.xhtml": strToU8(html),
      "OEBPS/unused.xhtml": strToU8(`<html><body><img src="unused.png"/></body></html>`),
    });
    expect(countEpubAssetCandidates(epub)).toEqual({
      code: 1,
      table: 1,
      image: 1,
      formula: 1,
    });
  });

  it("输出段/句分布、LID 膨胀估算与推荐档位", () => {
    const md = [
      "# Intro",
      "",
      "短段一句。",
      "",
      "一。二。三。四。五。六。",
      "",
      "![alt](img.png)",
    ].join("\n");
    const profile = buildGranularityProfile(
      markdownToBlocks(md),
      countMarkdownAssetCandidates(md),
    );
    expect(profile.paragraph_count).toBe(2);
    expect(profile.sentence_count_estimate).toBe(7);
    expect(profile.sentence_stats).toMatchObject({ p50: 1, p90: 6, max: 6 });
    expect(profile.long_paragraphs.gt5_sentences).toBe(1);
    expect(profile.asset_candidates.image).toBe(1);
    expect(profile.estimates.paragraph.projected_lid_count).toBe(3);
    expect(profile.estimates.hybrid.projected_lid_count).toBe(9);
    expect(profile.estimates.sentence.projected_lid_count).toBe(10);
    expect(profile.recommendation.mode).toBe("hybrid");
  });
});
