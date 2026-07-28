import type {
  PdfRegion,
  PdfSourceMap,
  PdfSourceMapEntry,
} from "./api";
import { overlayPointToPdf } from "./pdf-annotation-projection";

export interface PdfNotePlacementScreenPoint {
  clientX: number;
  clientY: number;
}

export interface PdfNotePlacementPageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PdfNotePlacementTargetResolution =
  | {
      status: "resolved";
      entry: PdfSourceMapEntry;
      region: PdfRegion;
    }
  | {
      status: "ambiguous";
      lids: string[];
    }
  | {
      status: "invalid";
      reason: "page_unavailable" | "point_outside_page" | "no_eligible_region";
    };

export function pdfNotePlacementEntryIsEligible(entry: PdfSourceMapEntry): boolean {
  if ("status" in entry) return entry.status === "word_mapped";
  return entry.precision === "char_exact" || entry.precision === "region_exact";
}

function normalizedBBox(region: PdfRegion): [number, number, number, number] {
  return [
    Math.min(region.bbox[0], region.bbox[2]),
    Math.min(region.bbox[1], region.bbox[3]),
    Math.max(region.bbox[0], region.bbox[2]),
    Math.max(region.bbox[1], region.bbox[3]),
  ];
}

function contains(region: PdfRegion, point: { x: number; y: number }): boolean {
  const [x1, y1, x2, y2] = normalizedBBox(region);
  return point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2;
}

function regionArea(region: PdfRegion): number {
  const [x1, y1, x2, y2] = normalizedBBox(region);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

export function resolvePdfNotePlacementTarget(
  sourceMap: PdfSourceMap,
  pageIndex: number,
  screenPoint: PdfNotePlacementScreenPoint,
  pageRect: PdfNotePlacementPageRect,
): PdfNotePlacementTargetResolution {
  const page = sourceMap.pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (!page || pageRect.width <= 0 || pageRect.height <= 0) {
    return { status: "invalid", reason: "page_unavailable" };
  }

  const overlayPoint = {
    x: ((screenPoint.clientX - pageRect.left) / pageRect.width) * 100,
    y: ((screenPoint.clientY - pageRect.top) / pageRect.height) * 100,
  };
  if (overlayPoint.x < 0 || overlayPoint.x > 100 || overlayPoint.y < 0 || overlayPoint.y > 100) {
    return { status: "invalid", reason: "point_outside_page" };
  }
  const pdfPoint = overlayPointToPdf(page, overlayPoint);
  const hits = sourceMap.entries.flatMap((entry) => {
    if (!pdfNotePlacementEntryIsEligible(entry)) return [];
    return entry.regions
      .filter((region) => region.pageIndex === pageIndex && contains(region, pdfPoint))
      .map((region) => ({ entry, region }));
  });
  if (!hits.length) return { status: "invalid", reason: "no_eligible_region" };

  const lids = [...new Set(hits.map(({ entry }) => entry.lid))].sort((left, right) => left.localeCompare(right));
  if (lids.length > 1) return { status: "ambiguous", lids };

  const selected = [...hits].sort((left, right) =>
    regionArea(left.region) - regionArea(right.region)
    || left.region.region_id.localeCompare(right.region.region_id))[0];
  return { status: "resolved", entry: selected.entry, region: selected.region };
}
