import { describe, expect, it } from "vitest";
import type {
  PdfSourceMap,
  PdfSourceMapEntryV1,
  PdfSourceMapEntryV2,
} from "./api";
import { resolvePdfNotePlacementTarget } from "./pdf-note-placement";

const page = {
  pageIndex: 0,
  page_label: "1",
  width: 600,
  height: 800,
  rotate: 0 as const,
  view: [0, 0, 600, 800] as [number, number, number, number],
};

const pageRect = { left: 20, top: 100, width: 600, height: 800 };

function v1Entry(
  lid: string,
  status: PdfSourceMapEntryV1["status"],
  regionId: string,
  bbox: [number, number, number, number] = [100, 650, 200, 750],
): PdfSourceMapEntryV1 {
  return {
    lid,
    source_span: { start: 0, end: 10 },
    status,
    regions: [{ region_id: regionId, pageIndex: 0, bbox }],
    alignment: { confidence: 1 },
  };
}

function v2Entry(
  lid: string,
  precision: PdfSourceMapEntryV2["precision"],
  regionId: string,
  bbox: [number, number, number, number] = [100, 650, 200, 750],
): PdfSourceMapEntryV2 {
  return {
    lid,
    source_span: { start: 0, end: 10 },
    precision,
    regions: [{ region_id: regionId, pageIndex: 0, bbox }],
    exact_source_spans: precision === "char_exact" ? [{ start: 0, end: 10 }] : [],
    alignment: { unit_id: `unit-${lid}`, reason: "fixture" },
  };
}

function sourceMapV1(entries: PdfSourceMapEntryV1[]): PdfSourceMap {
  return {
    version: "pdf_source_map.v1",
    book_id: "paper-a",
    coordinate_system: {
      space: "pdf_user_space",
      origin: "bottom_left",
      unit: "pt",
      rotation_applied: false,
    },
    pages: [page],
    entries,
    excluded_regions: [],
    page_region_index: {},
    page_excluded_index: {},
    config_hash: "cfg-v1",
  };
}

function sourceMapV2(entries: PdfSourceMapEntryV2[], rotate: 0 | 90 | 180 | 270 = 0): PdfSourceMap {
  return {
    version: "pdf_source_map.v2",
    book_id: "paper-a",
    coordinate_system: {
      space: "pdf_user_space",
      origin: "bottom_left",
      unit: "pt",
      rotation_applied: false,
    },
    pages: [{ ...page, rotate }],
    entries,
    page_region_index: {},
    config_hash: "cfg-v2",
  };
}

function screenPointForDefaultRegion(rect = pageRect) {
  return {
    clientX: rect.left + rect.width * 0.25,
    clientY: rect.top + rect.height * 0.1875,
  };
}

describe("resolvePdfNotePlacementTarget", () => {
  it("accepts only word_mapped v1 entries", () => {
    const allowed = resolvePdfNotePlacementTarget(
      sourceMapV1([v1Entry("1.1", "word_mapped", "word")]),
      0,
      screenPointForDefaultRegion(),
      pageRect,
    );
    expect(allowed).toMatchObject({
      status: "resolved",
      entry: { lid: "1.1", status: "word_mapped" },
      region: { region_id: "word" },
    });

    for (const status of ["line_fallback", "block_fallback", "unmapped", "excluded"] as const) {
      expect(resolvePdfNotePlacementTarget(
        sourceMapV1([v1Entry("1.1", status, status)]),
        0,
        screenPointForDefaultRegion(),
        pageRect,
      )).toEqual({ status: "invalid", reason: "no_eligible_region" });
    }
  });

  it("accepts char_exact and region_exact v2 entries but rejects partial and unmapped", () => {
    for (const precision of ["char_exact", "region_exact"] as const) {
      expect(resolvePdfNotePlacementTarget(
        sourceMapV2([v2Entry("1.1", precision, precision)]),
        0,
        screenPointForDefaultRegion(),
        pageRect,
      )).toMatchObject({
        status: "resolved",
        entry: { lid: "1.1", precision },
        region: { region_id: precision },
      });
    }
    for (const precision of ["partial", "unmapped"] as const) {
      expect(resolvePdfNotePlacementTarget(
        sourceMapV2([v2Entry("1.1", precision, precision)]),
        0,
        screenPointForDefaultRegion(),
        pageRect,
      )).toEqual({ status: "invalid", reason: "no_eligible_region" });
    }
  });

  it("normalizes same-LID overlaps by smallest bbox and then stable region id", () => {
    const entry = v1Entry("1.1", "word_mapped", "z-large", [80, 620, 240, 780]);
    entry.regions.push(
      { region_id: "z-small", pageIndex: 0, bbox: [100, 650, 200, 750] },
      { region_id: "a-small", pageIndex: 0, bbox: [100, 650, 200, 750] },
    );

    expect(resolvePdfNotePlacementTarget(
      sourceMapV1([entry]),
      0,
      screenPointForDefaultRegion(),
      pageRect,
    )).toMatchObject({ status: "resolved", region: { region_id: "a-small" } });
  });

  it("rejects cross-LID overlap instead of choosing by area or source-map order", () => {
    const result = resolvePdfNotePlacementTarget(
      sourceMapV1([
        v1Entry("2.1", "word_mapped", "tiny", [130, 680, 170, 720]),
        v1Entry("1.1", "word_mapped", "large", [100, 650, 200, 750]),
      ]),
      0,
      { clientX: 170, clientY: 200 },
      pageRect,
    );

    expect(result).toEqual({ status: "ambiguous", lids: ["1.1", "2.1"] });
  });

  it("resolves the same PDF target after zoom, scroll, and rotation coordinate changes", () => {
    const map = sourceMapV1([v1Entry("1.1", "word_mapped", "stable")]);
    const zoomedAndScrolled = { left: -180, top: -300, width: 1200, height: 1600 };
    expect(resolvePdfNotePlacementTarget(
      map,
      0,
      screenPointForDefaultRegion(zoomedAndScrolled),
      zoomedAndScrolled,
    )).toMatchObject({ status: "resolved", region: { region_id: "stable" } });

    const rotatedEntry = v2Entry("1.1", "region_exact", "rotated", [100, 100, 200, 200]);
    const rotatedRect = { left: 40, top: 60, width: 800, height: 600 };
    expect(resolvePdfNotePlacementTarget(
      sourceMapV2([rotatedEntry], 90),
      0,
      { clientX: 190, clientY: 210 },
      rotatedRect,
    )).toMatchObject({ status: "resolved", region: { region_id: "rotated" } });
  });

  it("rejects blank points and page indices without a real page", () => {
    const map = sourceMapV1([v1Entry("1.1", "word_mapped", "word")]);
    expect(resolvePdfNotePlacementTarget(map, 0, { clientX: 590, clientY: 850 }, pageRect))
      .toEqual({ status: "invalid", reason: "no_eligible_region" });
    expect(resolvePdfNotePlacementTarget(map, 3, screenPointForDefaultRegion(), pageRect))
      .toEqual({ status: "invalid", reason: "page_unavailable" });
  });
});
