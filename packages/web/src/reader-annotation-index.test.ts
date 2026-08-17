import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "./api";
import {
  buildReaderAnnotationIndex,
  readerHighlightGroupMembers,
} from "./reader-annotation-index";

function record(
  memId: string,
  lid: string,
  type: "note" | "highlight",
  groupId?: string,
): MemoryRecord {
  return {
    mem_id: memId,
    type,
    layer: "long_term",
    book_id: "book-a",
    anchor: { lid },
    content: memId,
    ...(groupId ? { source_session_id: `highlight-group:${groupId}` } : {}),
  };
}

const groupIdOf = (value: MemoryRecord) => value.source_session_id ?? null;

describe("reader annotation index", () => {
  it("builds all LID projections in one annotation pass", () => {
    const isInlineNote = vi.fn(() => true);
    const annotations = Array.from({ length: 1_000 }, (_, index) => (
      index % 2 === 0
        ? record(`highlight-${index}`, `lid-${index % 60}`, "highlight")
        : record(`note-${index}`, `lid-${index % 60}`, "note")
    ));

    const index = buildReaderAnnotationIndex({
      annotations,
      mountedLids: Array.from({ length: 60 }, (_, index) => `lid-${index}`),
      isInlineNote,
      highlightGroupId: groupIdOf,
    });

    expect(index.diagnostics).toEqual({
      recordsVisited: 1_000,
      mountedLidsVisited: 60,
      groupMembersVisited: 0,
    });
    expect(isInlineNote).toHaveBeenCalledTimes(500);
    expect(index.highlightsByLid.get("lid-0")).toHaveLength(17);
    expect(index.notesByLid.get("lid-1")).toHaveLength(17);
    expect(index.annotationsByLid.size).toBe(60);
  });

  it("moves only the necessary group representative when the mounted range changes", () => {
    const annotations = [
      record("h-1", "1.1", "highlight", "g-1"),
      record("h-2", "1.2", "highlight", "g-1"),
      record("h-3", "1.3", "highlight", "g-1"),
    ];
    const build = (mountedLids: string[]) => buildReaderAnnotationIndex({
      annotations,
      mountedLids,
      isInlineNote: () => true,
      highlightGroupId: groupIdOf,
    });

    const first = build(["1.1", "1.2"]);
    expect(first.highlightCardsByLid.get("1.1")?.map((value) => value.mem_id)).toEqual(["h-1"]);
    expect(first.highlightCardsByLid.get("1.2")).toBeUndefined();
    expect(readerHighlightGroupMembers(first, annotations[1])).toEqual(annotations);

    const shifted = build(["1.2", "1.3"]);
    expect(shifted.highlightCardsByLid.get("1.2")?.map((value) => value.mem_id)).toEqual(["h-2"]);
    expect(shifted.highlightCardsByLid.get("1.1")).toBeUndefined();
  });

  it("keeps Note eligibility separate from Highlight indexing", () => {
    const inline = record("note-inline", "1.1", "note");
    const listOnly = record("note-list", "1.1", "note");
    const highlight = record("highlight", "1.1", "highlight");
    const index = buildReaderAnnotationIndex({
      annotations: [inline, listOnly, highlight],
      mountedLids: ["1.1"],
      isInlineNote: (value) => value.mem_id === inline.mem_id,
      highlightGroupId: groupIdOf,
    });

    expect(index.annotationsByLid.get("1.1")).toEqual([inline, listOnly, highlight]);
    expect(index.notesByLid.get("1.1")).toEqual([inline]);
    expect(index.highlightsByLid.get("1.1")).toEqual([highlight]);
  });

  it("revises body HTML only for LIDs with ranged Highlights", () => {
    const first = { ...record("h-1", "1.1", "highlight"), range: { start: 1, end: 4 } };
    const second = { ...record("h-2", "1.1", "highlight"), range: { start: 5, end: 8 } };
    const wholeBlock = record("h-block", "1.2", "highlight");
    const index = buildReaderAnnotationIndex({
      annotations: [second, wholeBlock, first],
      mountedLids: ["1.1", "1.2"],
      isInlineNote: () => true,
      highlightGroupId: groupIdOf,
    });

    expect(index.renderRevisions.get("1.1")).toBe("h-1:1:4|h-2:5:8");
    expect(index.renderRevisions.has("1.2")).toBe(false);
  });
});
