import type {
  MemoryRecord,
  PdfRangesProjectResponse,
  PdfSourceMap,
  TextRange,
} from "./api";
import { pdfNotePlacementEntryIsEligible } from "./pdf-note-placement";

export type PdfAnnotationLocation = "exact" | "partial" | "unmapped" | "not_applicable";
export type PdfBBox = [number, number, number, number];
export type PdfPageMeta = PdfSourceMap["pages"][number];

export interface PdfProjectedRect {
  pageIndex: number;
  bbox: PdfBBox;
}

export interface ProjectedHighlight {
  mem_id: string;
  source_session_id?: string;
  record: MemoryRecord;
  rects: PdfProjectedRect[];
}

export interface ProjectedNoteMarker {
  terminal_key: string;
  anchor_rect: PdfProjectedRect;
  notes: MemoryRecord[];
}

export interface PdfUserAnnotationProjection {
  highlights: ProjectedHighlight[];
  note_markers: ProjectedNoteMarker[];
  location_by_mem_id: Record<string, PdfAnnotationLocation>;
}

export interface PdfProjectionTarget {
  record: MemoryRecord;
  kind: "highlight" | "note";
  range_index: number;
  range_count: number;
  lid: string;
  range: TextRange;
}

export interface PdfProjectionBatch {
  records: MemoryRecord[];
  requests: Array<{ lid: string; range: TextRange }>;
  targets: PdfProjectionTarget[];
  body_placement_context: PdfBodyPlacementProjectionContext;
}

export interface PdfBodyPlacementProjectionContext {
  source_fingerprint: string | null;
  source_map: PdfSourceMap | null;
}

export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfNoteMarkerLayout extends ProjectedNoteMarker {
  left: number;
  top: number;
  side: "left" | "right";
  direction: "up" | "down";
  collision_index: number;
  shift_y: number;
}

export const EMPTY_PDF_ANNOTATION_PROJECTION: PdfUserAnnotationProjection = {
  highlights: [],
  note_markers: [],
  location_by_mem_id: {},
};

const EMPTY_PDF_BODY_PLACEMENT_CONTEXT: PdfBodyPlacementProjectionContext = {
  source_fingerprint: null,
  source_map: null,
};

export function buildPdfProjectionBatch(
  records: MemoryRecord[],
  bodyPlacementContext: PdfBodyPlacementProjectionContext = EMPTY_PDF_BODY_PLACEMENT_CONTEXT,
): PdfProjectionBatch {
  const targets: PdfProjectionTarget[] = [];
  for (const record of records) {
    const lid = record.anchor.lid?.trim();
    if (record.type === "highlight" && lid && record.range) {
      targets.push({
        record,
        kind: "highlight",
        range_index: 0,
        range_count: 1,
        lid,
        range: record.range,
      });
      continue;
    }
    if (record.type !== "note" || !record.selection_context?.ranges.length) continue;
    const ranges = record.selection_context.ranges;
    ranges.forEach((selected, rangeIndex) => {
      targets.push({
        record,
        kind: "note",
        range_index: rangeIndex,
        range_count: ranges.length,
        lid: selected.lid,
        range: selected.range,
      });
    });
  }
  return {
    records,
    targets,
    requests: targets.map((target) => ({ lid: target.lid, range: target.range })),
    body_placement_context: bodyPlacementContext,
  };
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function normalizedBBox(bbox: PdfBBox): PdfBBox {
  return [
    Math.min(bbox[0], bbox[2]),
    Math.min(bbox[1], bbox[3]),
    Math.max(bbox[0], bbox[2]),
    Math.max(bbox[1], bbox[3]),
  ];
}

function sameVisualLine(left: PdfBBox, right: PdfBBox): boolean {
  const leftHeight = Math.max(0.001, left[3] - left[1]);
  const rightHeight = Math.max(0.001, right[3] - right[1]);
  const overlap = Math.min(left[3], right[3]) - Math.max(left[1], right[1]);
  if (overlap >= Math.min(leftHeight, rightHeight) * 0.5) return true;
  const centerDistance = Math.abs((left[1] + left[3]) / 2 - (right[1] + right[3]) / 2);
  return centerDistance <= Math.min(leftHeight, rightHeight) * 0.35;
}

export function mergePdfGlyphRects(rects: PdfProjectedRect[]): PdfProjectedRect[] {
  const byPage = new Map<number, PdfBBox[]>();
  for (const rect of rects) {
    const list = byPage.get(rect.pageIndex);
    const bbox = normalizedBBox(rect.bbox);
    if (list) list.push(bbox);
    else byPage.set(rect.pageIndex, [bbox]);
  }

  const merged: PdfProjectedRect[] = [];
  for (const pageIndex of [...byPage.keys()].sort((left, right) => left - right)) {
    const source = byPage.get(pageIndex)!
      .sort((left, right) => right[3] - left[3] || left[0] - right[0]);
    const lines: PdfBBox[][] = [];
    for (const bbox of source) {
      const line = lines.find((candidate) => candidate.some((existing) => sameVisualLine(existing, bbox)));
      if (line) line.push(bbox);
      else lines.push([bbox]);
    }
    for (const line of lines) {
      const ordered = line.sort((left, right) => left[0] - right[0]);
      let active = ordered[0];
      for (const bbox of ordered.slice(1)) {
        const height = Math.min(active[3] - active[1], bbox[3] - bbox[1]);
        const mergeGap = Math.max(1, height * 0.35);
        if (sameVisualLine(active, bbox) && bbox[0] - active[2] <= mergeGap) {
          active = [
            Math.min(active[0], bbox[0]),
            Math.min(active[1], bbox[1]),
            Math.max(active[2], bbox[2]),
            Math.max(active[3], bbox[3]),
          ];
        } else {
          merged.push({ pageIndex, bbox: active });
          active = bbox;
        }
      }
      merged.push({ pageIndex, bbox: active });
    }
  }
  return merged;
}

function locationOf(statuses: PdfAnnotationLocation[]): PdfAnnotationLocation {
  if (!statuses.length) return "not_applicable";
  if (statuses.every((status) => status === "exact")) return "exact";
  if (statuses.every((status) => status === "unmapped")) return "unmapped";
  return "partial";
}

function projectPdfBodyPlacement(
  record: MemoryRecord,
  context: PdfBodyPlacementProjectionContext,
): ProjectedNoteMarker | null {
  const placement = record.note_placement;
  const sourceMap = context.source_map;
  if (
    record.type !== "note"
    || record.selection_context
    || placement?.kind !== "pdf_region"
    || !context.source_fingerprint
    || !sourceMap
    || placement.source_fingerprint !== context.source_fingerprint
    || placement.source_map_version !== sourceMap.version
    || placement.source_map_config_hash !== sourceMap.config_hash
    || record.anchor.lid !== placement.lid
    || !sourceMap.pages.some((page) => page.pageIndex === placement.page_index)
  ) return null;

  const targets = sourceMap.entries.flatMap((entry) => {
    if (entry.lid !== placement.lid || !pdfNotePlacementEntryIsEligible(entry)) return [];
    return entry.regions
      .filter((region) =>
        region.pageIndex === placement.page_index
        && region.region_id === placement.region_id)
      .map((region) => ({ entry, region }));
  });
  if (targets.length !== 1) return null;
  const { region } = targets[0];
  return {
    terminal_key: [
      "pdf-region",
      sourceMap.version,
      sourceMap.config_hash,
      region.pageIndex,
      placement.lid,
      region.region_id,
    ].join(":"),
    anchor_rect: { pageIndex: region.pageIndex, bbox: region.bbox },
    notes: [record],
  };
}

export function projectPdfAnnotations(
  batch: PdfProjectionBatch,
  response: PdfRangesProjectResponse,
  bodyPlacementContext: PdfBodyPlacementProjectionContext = batch.body_placement_context,
): PdfUserAnnotationProjection {
  const resultByRecord = new Map<string, Array<{
    target: PdfProjectionTarget;
    projection: PdfRangesProjectResponse["projections"][number] | null;
    status: PdfAnnotationLocation;
  }>>();

  batch.targets.forEach((target, index) => {
    const candidate = response.projections[index];
    const projection = candidate
      && candidate.lid === target.lid
      && sameRange(candidate.range, target.range)
      ? candidate
      : null;
    const status: PdfAnnotationLocation = projection?.status ?? "unmapped";
    const list = resultByRecord.get(target.record.mem_id);
    const result = { target, projection, status };
    if (list) list.push(result);
    else resultByRecord.set(target.record.mem_id, [result]);
  });

  const locationByMemId: Record<string, PdfAnnotationLocation> = {};
  const highlights: ProjectedHighlight[] = [];
  const markersByTerminal = new Map<string, ProjectedNoteMarker>();

  for (const record of batch.records) {
    if (record.type === "note" && record.note_placement?.kind === "pdf_region") {
      const marker = projectPdfBodyPlacement(record, bodyPlacementContext);
      if (marker) {
        const existing = markersByTerminal.get(marker.terminal_key);
        if (existing) existing.notes.push(record);
        else markersByTerminal.set(marker.terminal_key, marker);
        locationByMemId[record.mem_id] = "exact";
      } else {
        locationByMemId[record.mem_id] = "unmapped";
      }
      continue;
    }
    const results = resultByRecord.get(record.mem_id) ?? [];
    const statuses = results.map((result) => result.status);
    let location = locationOf(statuses);
    if (record.type === "highlight") {
      const exact = results[0]?.projection;
      if (location === "exact" && (!exact || exact.status !== "exact" || !exact.rects.length)) {
        location = "unmapped";
      }
      if (location === "exact" && exact) {
        highlights.push({
          mem_id: record.mem_id,
          ...(record.source_session_id ? { source_session_id: record.source_session_id } : {}),
          record,
          rects: mergePdfGlyphRects(exact.rects.map((rect) => ({
            pageIndex: rect.pageIndex,
            bbox: rect.bbox,
          }))),
        });
      }
    } else if (record.type === "note" && location === "exact") {
      const finalResult = results.find((result) => result.target.range_index === result.target.range_count - 1);
      const terminal = finalResult?.projection?.terminal_rect;
      if (!terminal) {
        location = "unmapped";
      } else {
        const target = finalResult.target;
        const terminalKey = `${terminal.pageIndex}:${target.lid}:${target.range.start}:${target.range.end}`;
        const existing = markersByTerminal.get(terminalKey);
        if (existing) existing.notes.push(record);
        else {
          markersByTerminal.set(terminalKey, {
            terminal_key: terminalKey,
            anchor_rect: { pageIndex: terminal.pageIndex, bbox: terminal.bbox },
            notes: [record],
          });
        }
      }
    }
    locationByMemId[record.mem_id] = location;
  }

  return {
    highlights,
    note_markers: [...markersByTerminal.values()].sort((left, right) =>
      left.anchor_rect.pageIndex - right.anchor_rect.pageIndex
      || left.terminal_key.localeCompare(right.terminal_key)),
    location_by_mem_id: locationByMemId,
  };
}

function pageView(page: PdfPageMeta) {
  const [x1, y1, x2, y2] = page.view;
  return {
    xMin: Math.min(x1, x2),
    yMin: Math.min(y1, y2),
    xMax: Math.max(x1, x2),
    yMax: Math.max(y1, y2),
  };
}

export function pdfPageVisualSize(page: PdfPageMeta): { width: number; height: number } {
  const view = pageView(page);
  const width = view.xMax - view.xMin;
  const height = view.yMax - view.yMin;
  return page.rotate === 90 || page.rotate === 270
    ? { width: height, height: width }
    : { width, height };
}

function pdfPointToOverlayUnits(page: PdfPageMeta, point: { x: number; y: number }) {
  const view = pageView(page);
  switch (page.rotate) {
    case 90:
      return { x: point.y - view.yMin, y: point.x - view.xMin };
    case 180:
      return { x: view.xMax - point.x, y: point.y - view.yMin };
    case 270:
      return { x: view.yMax - point.y, y: view.xMax - point.x };
    default:
      return { x: point.x - view.xMin, y: view.yMax - point.y };
  }
}

export function pdfRectToOverlay(page: PdfPageMeta, bbox: PdfBBox): OverlayRect {
  const normalized = normalizedBBox(bbox);
  const corners = [
    pdfPointToOverlayUnits(page, { x: normalized[0], y: normalized[1] }),
    pdfPointToOverlayUnits(page, { x: normalized[0], y: normalized[3] }),
    pdfPointToOverlayUnits(page, { x: normalized[2], y: normalized[1] }),
    pdfPointToOverlayUnits(page, { x: normalized[2], y: normalized[3] }),
  ];
  const visual = pdfPageVisualSize(page);
  const left = Math.min(...corners.map((corner) => corner.x));
  const right = Math.max(...corners.map((corner) => corner.x));
  const top = Math.min(...corners.map((corner) => corner.y));
  const bottom = Math.max(...corners.map((corner) => corner.y));
  return {
    left: (left / visual.width) * 100,
    top: (top / visual.height) * 100,
    width: ((right - left) / visual.width) * 100,
    height: ((bottom - top) / visual.height) * 100,
  };
}

export function overlayPointToPdf(page: PdfPageMeta, point: { x: number; y: number }) {
  const visual = pdfPageVisualSize(page);
  const displayX = (point.x / 100) * visual.width;
  const displayY = (point.y / 100) * visual.height;
  const view = pageView(page);
  switch (page.rotate) {
    case 90:
      return { x: view.xMin + displayY, y: view.yMin + displayX };
    case 180:
      return { x: view.xMax - displayX, y: view.yMin + displayY };
    case 270:
      return { x: view.xMax - displayY, y: view.yMax - displayX };
    default:
      return { x: view.xMin + displayX, y: view.yMax - displayY };
  }
}

export function layoutNoteMarkers(
  markers: ProjectedNoteMarker[],
  page: PdfPageMeta,
): PdfNoteMarkerLayout[] {
  const layouts: PdfNoteMarkerLayout[] = [];
  for (const marker of [...markers].sort((left, right) => left.terminal_key.localeCompare(right.terminal_key))) {
    const rect = pdfRectToOverlay(page, marker.anchor_rect.bbox);
    const right = rect.left + rect.width;
    const centerY = rect.top + rect.height / 2;
    const side = right > 92 ? "left" : "right";
    const direction = centerY > 88 ? "up" : "down";
    const collisionIndex = layouts.filter((existing) =>
      Math.abs(existing.left - (side === "left" ? rect.left : right)) <= 5
      && Math.abs(existing.top - centerY) <= 5).length;
    layouts.push({
      ...marker,
      left: side === "left" ? rect.left : right,
      top: centerY,
      side,
      direction,
      collision_index: collisionIndex,
      shift_y: (direction === "up" ? -1 : 1) * collisionIndex * 34,
    });
  }
  return layouts;
}
