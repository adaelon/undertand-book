import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AskQuote, MemoryRecord, PdfRangesProjectResponse } from "./api";
import { selectionContextForAgentNote } from "./agent-note-selection";
import { buildPdfProjectionBatch, projectPdfAnnotations } from "./pdf-annotation-projection";

const questionQuote: AskQuote = {
  lid: "1.1",
  quote: "source quote",
  status: "resolved",
  raw_quote: "source quote",
  resolved_quote: "source quote",
  ranges: [
    { lid: "1.1", range: { start: 2, end: 8 } },
    { lid: "1.2", range: { start: 0, end: 4 } },
  ],
};

describe("Agent answer selection Note provenance", () => {
  it("inherits question ranges and produces an exact PDF Note marker", () => {
    const selectionContext = selectionContextForAgentNote(questionQuote);
    expect(selectionContext).toEqual({
      status: "resolved",
      raw_quote: "source quote",
      resolved_quote: "source quote",
      ranges: questionQuote.ranges,
    });

    const note: MemoryRecord = {
      mem_id: "agent-note",
      type: "note",
      layer: "long_term",
      book_id: "book-a",
      anchor: { lid: "1.1", concept: null },
      content: "agent answer excerpt",
      selection_context: selectionContext,
    };
    const batch = buildPdfProjectionBatch([note]);
    expect(batch.requests).toEqual(questionQuote.ranges);

    const response: PdfRangesProjectResponse = {
      projections: batch.requests.map((request, index) => ({
        ...request,
        status: "exact",
        rects: [{
          pageIndex: index,
          bbox: [10, 20, 14, 30],
          source_span: { start: index * 10, end: index * 10 + 1 },
        }],
        covered_range: request.range,
        terminal_rect: {
          pageIndex: index,
          bbox: [12, 20, 14, 30],
          source_span: { start: index * 10, end: index * 10 + 1 },
        },
      })),
    };
    const projection = projectPdfAnnotations(batch, response);
    expect(projection.note_markers).toHaveLength(1);
    expect(projection.note_markers[0]).toMatchObject({
      terminal_key: "1:1.2:0:4",
      notes: [{ mem_id: "agent-note" }],
    });
  });

  it("does not invent ranges for legacy Agent turns and is wired into App saving", () => {
    expect(selectionContextForAgentNote({ lid: "1.1", quote: "legacy" })).toBeUndefined();

    const app = readFileSync("src/App.vue", "utf8");
    expect(app).toContain("selectionContextForAgentNote(turn.questionSelection)");
    expect(app).toContain("selection_context: selectionContext");
  });
});
