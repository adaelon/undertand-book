import { describe, expect, it } from "vitest";
import type { MemoryRecord, NoteBodyPlacement, PdfSourceMap } from "./api";
import {
  buildPdfProjectionBatch,
  projectPdfAnnotations,
  type PdfBodyPlacementProjectionContext,
} from "./pdf-annotation-projection";

const sourceMap: PdfSourceMap = {
  version: "pdf_source_map.v1",
  book_id: "paper-a",
  coordinate_system: {
    space: "pdf_user_space",
    origin: "bottom_left",
    unit: "pt",
    rotation_applied: false,
  },
  pages: [{ pageIndex: 0, page_label: "1", width: 600, height: 800, rotate: 0, view: [0, 0, 600, 800] }],
  entries: [{
    lid: "1.1",
    source_span: { start: 0, end: 10 },
    status: "word_mapped",
    regions: [{ region_id: "word-1", pageIndex: 0, bbox: [100, 650, 200, 750] }],
    alignment: { confidence: 1 },
  }],
  excluded_regions: [],
  page_region_index: {},
  page_excluded_index: {},
  config_hash: "cfg-v1",
};

function placement(overrides: Partial<Extract<NoteBodyPlacement, { kind: "pdf_region" }>> = {}) {
  return {
    kind: "pdf_region" as const,
    source_fingerprint: "source-a",
    lid: "1.1",
    source_map_version: "pdf_source_map.v1" as const,
    source_map_config_hash: "cfg-v1",
    page_index: 0,
    region_id: "word-1",
    ...overrides,
  };
}

function note(memId: string, notePlacement = placement()): MemoryRecord {
  return {
    mem_id: memId,
    type: "note",
    layer: "long_term",
    book_id: "paper-a",
    anchor: { lid: notePlacement.lid, concept: null },
    content: `note-${memId}`,
    note_placement: notePlacement,
  };
}

function context(overrides: Partial<PdfBodyPlacementProjectionContext> = {}): PdfBodyPlacementProjectionContext {
  return {
    source_fingerprint: "source-a",
    source_map: sourceMap,
    ...overrides,
  };
}

function project(records: MemoryRecord[], projectionContext = context()) {
  return projectPdfAnnotations(buildPdfProjectionBatch(records), { projections: [] }, projectionContext);
}

describe("PDF body-placement projection", () => {
  it("creates an object marker from the current verified region and aggregates identical targets", () => {
    const result = project([note("n-a"), note("n-b")]);

    expect(result.note_markers).toEqual([{
      terminal_key: "pdf-region:pdf_source_map.v1:cfg-v1:0:1.1:word-1",
      anchor_rect: { pageIndex: 0, bbox: [100, 650, 200, 750] },
      notes: [expect.objectContaining({ mem_id: "n-a" }), expect.objectContaining({ mem_id: "n-b" })],
    }]);
    expect(result.location_by_mem_id).toEqual({ "n-a": "exact", "n-b": "exact" });
  });

  it.each([
    ["source", note("source", placement({ source_fingerprint: "source-old" })), context()],
    ["map version", note("version", placement({ source_map_version: "pdf_source_map.v2" })), context()],
    ["map config", note("config", placement({ source_map_config_hash: "cfg-old" })), context()],
    ["page", note("page", placement({ page_index: 2 })), context()],
    ["region", note("region", placement({ region_id: "missing" })), context()],
    ["LID", { ...note("lid"), anchor: { lid: "2.1", concept: null } }, context()],
    ["missing source context", note("no-source"), context({ source_fingerprint: null })],
    ["missing map context", note("no-map"), context({ source_map: null })],
  ])("keeps a %s-stale placement side-list-only", (_label, record, projectionContext) => {
    const result = project([record as MemoryRecord], projectionContext);
    expect(result.note_markers).toEqual([]);
    expect(result.location_by_mem_id[(record as MemoryRecord).mem_id]).toBe("unmapped");
  });

  it("rejects a current region whose precision is no longer placement-eligible", () => {
    const degradedMap: PdfSourceMap = {
      ...sourceMap,
      entries: [{ ...sourceMap.entries[0], status: "line_fallback" }],
    };
    const result = project([note("precision")], context({ source_map: degradedMap }));
    expect(result.note_markers).toEqual([]);
    expect(result.location_by_mem_id.precision).toBe("unmapped");
  });
});
