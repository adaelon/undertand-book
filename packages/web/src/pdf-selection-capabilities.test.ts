import { describe, expect, it } from "vitest";
import { pdfSelectionCapabilities } from "./pdf-selection-capabilities";

describe("pdfSelectionCapabilities", () => {
  it("keeps all semantic actions for character-exact selections", () => {
    expect(pdfSelectionCapabilities("resolved")).toEqual({
      canHighlight: true,
      canNote: true,
      canAsk: true,
      canTranslate: true,
      nativeCopyOnly: false,
      statusLabel: null,
    });
  });

  it("uses the same warning-free action matrix for recovered resolved selections", () => {
    expect(pdfSelectionCapabilities("resolved")).toMatchObject({
      canHighlight: true,
      canNote: true,
      canAsk: true,
      canTranslate: true,
      nativeCopyOnly: false,
      statusLabel: null,
    });
  });

  it("limits partial selections to exact-subrange Ask and raw-text translation", () => {
    expect(pdfSelectionCapabilities("partial")).toEqual({
      canHighlight: false,
      canNote: false,
      canAsk: true,
      canTranslate: true,
      nativeCopyOnly: false,
      statusLabel: "部分定位，仅精确子区间可用于问 AI",
    });
  });

  it("keeps unresolved selections native-copy only", () => {
    expect(pdfSelectionCapabilities("unresolved")).toEqual({
      canHighlight: false,
      canNote: false,
      canAsk: false,
      canTranslate: false,
      nativeCopyOnly: true,
      statusLabel: "未建立语义定位",
    });
  });
});
