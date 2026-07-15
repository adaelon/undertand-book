import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "./api";
import { recallBookAnnotations } from "./reader-annotations";

function annotation(memId: string, bookId: string, type: "note" | "highlight"): MemoryRecord {
  return {
    mem_id: memId,
    type,
    layer: "long_term",
    book_id: bookId,
    anchor: { lid: "1.1", concept: null },
    content: memId,
  };
}

describe("reader annotation scope", () => {
  it("requests and retains annotations for the current book only", async () => {
    const recall = vi.fn(async () => [
      annotation("note-a", "book-a", "note"),
      annotation("note-b", "book-b", "note"),
      annotation("highlight-a", "book-a", "highlight"),
    ]);

    const records = await recallBookAnnotations("book-a", recall);

    expect(recall).toHaveBeenCalledWith({ book_id: "book-a" });
    expect(records.map((record) => record.mem_id)).toEqual(["note-a", "highlight-a"]);
  });
});
