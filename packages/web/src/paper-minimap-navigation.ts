import type { PaperViewportPosition } from "./api";

export interface PaperMinimapPageSpan {
  start_page: number;
  end_page: number;
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

export function normalizePaperViewportForMinimap(
  position: PaperViewportPosition,
  pageSpans: PaperMinimapPageSpan[],
): PaperViewportPosition | null {
  if (!pageSpans.length || !Number.isFinite(position.center_page)) return null;
  const firstPage = Math.min(...pageSpans.map((span) => span.start_page));
  const lastPage = Math.max(...pageSpans.map((span) => span.end_page));
  if (!Number.isFinite(firstPage) || !Number.isFinite(lastPage) || firstPage > lastPage) return null;

  const startPage = clamp(Math.min(position.start_page, position.end_page), firstPage, lastPage);
  const endPage = clamp(Math.max(position.start_page, position.end_page), startPage, lastPage);
  const centerPage = clamp(position.center_page, startPage, endPage + 0.999999);
  const pageCount = Math.max(1, lastPage - firstPage + 1);

  return {
    ...position,
    start_page: startPage,
    end_page: endPage,
    center_page: centerPage,
    progress_ratio: clamp((centerPage - firstPage) / pageCount, 0, 1),
  };
}

export function shouldOpenPdfSourcePreview(
  requestedLid: string,
  resolvedLid: string,
  mappedLids: ReadonlySet<string>,
): boolean {
  return !mappedLids.has(requestedLid) && !mappedLids.has(resolvedLid);
}
