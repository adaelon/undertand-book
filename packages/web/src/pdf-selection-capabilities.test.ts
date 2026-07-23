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
    expect(pdfSelectionCapabilities("partial", "material_or_ambiguous")).toEqual({
      canHighlight: false,
      canNote: false,
      canAsk: true,
      canTranslate: true,
      nativeCopyOnly: false,
      statusLabel: "存在缺字或歧义",
    });
    expect(pdfSelectionCapabilities("partial", "insufficient_visible_evidence")).toMatchObject({
      canHighlight: false,
      canNote: false,
      statusLabel: "选区证据不足",
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
