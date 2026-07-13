import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MemoryRecord, PdfRangesProjectResponse, PdfSourceMap } from "./api";
import {
  buildPdfProjectionBatch,
  layoutNoteMarkers,
  overlayPointToPdf,
  pdfRectToOverlay,
  projectPdfAnnotations,
} from "./pdf-annotation-projection";

function record(
  memId: string,
  type: "highlight" | "note",
  lid: string,
  range?: { start: number; end: number },
): MemoryRecord {
  return {
    mem_id: memId,
    type,
    layer: "long_term",
    book_id: "paper-a",
    anchor: { lid, concept: null },
    content: `${type}-${memId}`,
    range,
  };
}

const page: PdfSourceMap["pages"][number] = {
  pageIndex: 0,
  width: 100,
  height: 200,
  rotate: 0,
  view: [0, 0, 100, 200],
};

describe("PDF annotation projection", () => {
  it("batches record ranges, accepts exact results only, and aggregates identical note terminals", () => {
    const exactHighlight = record("h-exact", "highlight", "1.1", { start: 0, end: 4 });
    exactHighlight.source_session_id = "highlight-group:a";
    const partialHighlight = record("h-partial", "highlight", "1.2", { start: 2, end: 5 });
    const noteA = record("n-a", "note", "1.1");
    noteA.selection_context = {
      status: "resolved",
      raw_quote: "raw a",
      resolved_quote: "resolved a",
      ranges: [
        { lid: "1.1", range: { start: 4, end: 6 } },
        { lid: "1.2", range: { start: 8, end: 9 } },
      ],
    };
    const noteB = record("n-b", "note", "1.2");
    noteB.selection_context = {
      status: "resolved",
      raw_quote: "raw b",
      resolved_quote: "resolved b",
      ranges: [{ lid: "1.2", range: { start: 8, end: 9 } }],
    };
    const partialNote = record("n-partial", "note", "1.3");
    partialNote.selection_context = {
      status: "partial",
      raw_quote: "raw partial",
      resolved_quote: "resolved partial",
      ranges: [{ lid: "1.3", range: { start: 0, end: 2 } }],
    };
    const ordinaryNote = record("n-ordinary", "note", "1.4");
    const batch = buildPdfProjectionBatch([
      exactHighlight,
      partialHighlight,
      noteA,
      noteB,
      partialNote,
      ordinaryNote,
    ]);

    expect(batch.requests).toEqual([
      { lid: "1.1", range: { start: 0, end: 4 } },
      { lid: "1.2", range: { start: 2, end: 5 } },
      { lid: "1.1", range: { start: 4, end: 6 } },
      { lid: "1.2", range: { start: 8, end: 9 } },
      { lid: "1.2", range: { start: 8, end: 9 } },
      { lid: "1.3", range: { start: 0, end: 2 } },
    ]);

    const response: PdfRangesProjectResponse = {
      projections: [
        {
          lid: "1.1",
          range: { start: 0, end: 4 },
          status: "exact",
          rects: [
            { pageIndex: 0, bbox: [10, 100, 12, 110], source_span: { start: 0, end: 1 } },
            { pageIndex: 0, bbox: [12.4, 100, 14.4, 110], source_span: { start: 1, end: 2 } },
            { pageIndex: 0, bbox: [60, 100, 62, 110], source_span: { start: 2, end: 3 } },
            { pageIndex: 0, bbox: [10, 80, 12, 90], source_span: { start: 3, end: 4 } },
          ],
          covered_range: { start: 0, end: 4 },
          terminal_rect: { pageIndex: 0, bbox: [10, 80, 12, 90], source_span: { start: 3, end: 4 } },
        },
        {
          lid: "1.2",
          range: { start: 2, end: 5 },
          status: "partial",
          rects: [{ pageIndex: 0, bbox: [20, 60, 22, 70], source_span: { start: 2, end: 3 } }],
          covered_range: { start: 2, end: 3 },
        },
        {
          lid: "1.1",
          range: { start: 4, end: 6 },
          status: "exact",
          rects: [{ pageIndex: 0, bbox: [20, 40, 24, 50], source_span: { start: 4, end: 6 } }],
          covered_range: { start: 4, end: 6 },
          terminal_rect: { pageIndex: 0, bbox: [22, 40, 24, 50], source_span: { start: 5, end: 6 } },
        },
        ...["n-a", "n-b"].map(() => ({
          lid: "1.2",
          range: { start: 8, end: 9 },
          status: "exact" as const,
          rects: [{ pageIndex: 0, bbox: [90, 20, 94, 30] as [number, number, number, number], source_span: { start: 8, end: 9 } }],
          covered_range: { start: 8, end: 9 },
          terminal_rect: {
            pageIndex: 0,
            bbox: [90, 20, 94, 30] as [number, number, number, number],
            source_span: { start: 8, end: 9 },
          },
        })),
        {
          lid: "1.3",
          range: { start: 0, end: 2 },
          status: "unmapped",
          rects: [],
        },
      ],
    };

    const projection = projectPdfAnnotations(batch, response);
    expect(projection.highlights).toHaveLength(1);
    expect(projection.highlights[0]).toMatchObject({
      mem_id: "h-exact",
      source_session_id: "highlight-group:a",
    });
    expect(projection.highlights[0].rects).toEqual([
      { pageIndex: 0, bbox: [10, 100, 14.4, 110] },
      { pageIndex: 0, bbox: [60, 100, 62, 110] },
      { pageIndex: 0, bbox: [10, 80, 12, 90] },
    ]);
    expect(projection.note_markers).toHaveLength(1);
    expect(projection.note_markers[0].notes.map((note) => note.mem_id)).toEqual(["n-a", "n-b"]);
    expect(projection.location_by_mem_id).toEqual({
      "h-exact": "exact",
      "h-partial": "partial",
      "n-a": "exact",
      "n-b": "exact",
      "n-partial": "unmapped",
      "n-ordinary": "not_applicable",
    });
  });

  it("rejects a response whose range no longer matches its batch owner", () => {
    const highlight = record("h-stale", "highlight", "1.1", { start: 0, end: 2 });
    const batch = buildPdfProjectionBatch([highlight]);
    const projection = projectPdfAnnotations(batch, {
      projections: [{
        lid: "other",
        range: { start: 0, end: 2 },
        status: "exact",
        rects: [{ pageIndex: 0, bbox: [1, 1, 2, 2], source_span: { start: 0, end: 1 } }],
      }],
    });
    expect(projection.highlights).toEqual([]);
    expect(projection.location_by_mem_id["h-stale"]).toBe("unmapped");
  });

  it("round-trips PDF geometry through 0/90/180/270 degree visual coordinates", () => {
    const expected = {
      0: { left: 10, top: 80, width: 20, height: 10 },
      90: { left: 10, top: 10, width: 10, height: 20 },
      180: { left: 70, top: 10, width: 20, height: 10 },
      270: { left: 80, top: 70, width: 10, height: 20 },
    } as const;

    for (const rotate of [0, 90, 180, 270] as const) {
      const rotated = { ...page, rotate };
      expect(pdfRectToOverlay(rotated, [10, 20, 30, 40])).toEqual(expected[rotate]);
      const overlay = pdfRectToOverlay(rotated, [10, 20, 30, 40]);
      const point = overlayPointToPdf(rotated, {
        x: overlay.left + overlay.width / 2,
        y: overlay.top + overlay.height / 2,
      });
      expect(point.x).toBeCloseTo(20, 8);
      expect(point.y).toBeCloseTo(30, 8);
    }
  });

  it("lays nearby markers deterministically and flips at right and bottom boundaries", () => {
    const noteA = record("n-a", "note", "1.1");
    const noteB = record("n-b", "note", "1.2");
    const markers = [
      {
        terminal_key: "0:1.1:0:1",
        anchor_rect: { pageIndex: 0, bbox: [95, 2, 99, 6] as [number, number, number, number] },
        notes: [noteA],
      },
      {
        terminal_key: "0:1.2:0:1",
        anchor_rect: { pageIndex: 0, bbox: [94, 3, 98, 7] as [number, number, number, number] },
        notes: [noteB],
      },
    ];
    const layout = layoutNoteMarkers(markers, { ...page, width: 100, height: 100, view: [0, 0, 100, 100] });
    expect(layout.map((item) => item.terminal_key)).toEqual(["0:1.1:0:1", "0:1.2:0:1"]);
    expect(layout[0]).toMatchObject({ side: "left", direction: "up", collision_index: 0 });
    expect(layout[1]).toMatchObject({ side: "left", direction: "up", collision_index: 1 });
    expect(layout[1].shift_y).toBeLessThan(0);
  });

  it("keeps projection batching and authoritative mutation refresh in App wiring", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const paneStart = app.indexOf("<PdfReaderPane");
    const paneBinding = app.slice(paneStart, app.indexOf("/>", paneStart) + 2);
    expect(app).toContain("const response = await api.pdfRangesProject(batch.requests)");
    expect(app).toContain("pdfAnnotationProjection.value = projectPdfAnnotations(batch, response)");
    expect(app).toContain("await api.replace({");
    expect(app).toContain("await Promise.allSettled(created.map((effect) => api.delete(effect.highlight_id)))");
    expect(app).toContain("await refreshAnnotations()");
    expect(paneBinding).toContain(':annotation-projection="pdfAnnotationProjection"');
    expect(paneBinding).toContain('@reselect-note="reselectPdfNote"');
    expect(paneBinding).toContain('@reselect-highlight="reselectPdfHighlight"');
  });
});
