import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("paper minimap migration boundary", () => {
  it("keeps one minimap surface and removes the legacy BookStructure map path", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const leftRail = readFileSync("src/components/LeftRail.vue", "utf8");
    const styles = readFileSync("src/style.css", "utf8");

    for (const legacy of [
      "paperStructureRows",
      "paperMinimapPresets",
      "paperPinnedEvidence",
      "paperGuide",
      "paperRows",
      "paperPresets",
    ]) {
      expect(`${app}\n${leftRail}`).not.toContain(legacy);
    }
    expect(leftRail.match(/<PaperMinimap\b/g)).toHaveLength(1);
    expect(styles).not.toContain(".paper-minimap {");
    expect(styles).not.toContain(".paper-map-list");
  });

  it("routes layout presets and minimap modes through separate command surfaces", () => {
    const api = readFileSync("src/api.ts", "utf8");
    const app = readFileSync("src/App.vue", "utf8");
    const modeHandler = app.slice(
      app.indexOf("async function setPaperMinimapMode"),
      app.indexOf("async function setPaperMinimapLayer"),
    );

    expect(api).toContain('layoutApply: (body:');
    expect(api).toContain('"/reader/layout.apply"');
    expect(api).toContain('paperMinimapApply: (body:');
    expect(api).toContain('"/reader/paper_minimap.apply"');
    expect(modeHandler).toContain('kind: "set_mode_lens"');
    expect(modeHandler).toContain("applyPaperMinimapCommands");
    expect(modeHandler).not.toContain("layoutApply");
  });

  it("keeps outline goto in the PDF reader when a LID has no mapped region", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const gotoHandler = app.slice(
      app.indexOf("async function doGoto"),
      app.indexOf("async function focusSource"),
    );

    expect(gotoHandler).toContain("hasMappedPdfNavigationTarget");
    expect(gotoHandler).toContain("已保留当前 PDF 页面");
    expect(gotoHandler).not.toContain("openSourcePreview");
  });
});
