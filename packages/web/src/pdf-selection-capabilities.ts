import type { PdfSelectionDiagnostic } from "./api";

export type PdfSelectionCapabilityStatus = "resolved" | "partial" | "unresolved";

export interface PdfSelectionCapabilities {
  canHighlight: boolean;
  canNote: boolean;
  canAsk: boolean;
  canTranslate: boolean;
  nativeCopyOnly: boolean;
  statusLabel: string | null;
}

export function pdfSelectionCapabilities(
  status: PdfSelectionCapabilityStatus,
  diagnostic?: PdfSelectionDiagnostic,
): PdfSelectionCapabilities {
  if (status === "resolved") {
    return {
      canHighlight: true,
      canNote: true,
      canAsk: true,
      canTranslate: true,
      nativeCopyOnly: false,
      statusLabel: null,
    };
  }
  if (status === "partial") {
    return {
      canHighlight: false,
      canNote: false,
      canAsk: true,
      canTranslate: true,
      nativeCopyOnly: false,
      statusLabel: diagnostic === "material_or_ambiguous"
        ? "存在缺字或歧义"
        : diagnostic === "insufficient_visible_evidence"
          ? "选区证据不足"
          : "部分定位，仅精确子区间可用于问 AI",
    };
  }
  return {
    canHighlight: false,
    canNote: false,
    canAsk: false,
    canTranslate: false,
    nativeCopyOnly: true,
    statusLabel: "未建立语义定位",
  };
}
