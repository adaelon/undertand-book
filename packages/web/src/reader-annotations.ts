import type { MemoryRecord } from "./api";

type RecallAnnotations = (query: { book_id: string }) => Promise<MemoryRecord[]>;

export async function recallBookAnnotations(
  bookId: string,
  recall: RecallAnnotations,
): Promise<MemoryRecord[]> {
  const records = await recall({ book_id: bookId });
  return records.filter((record) => record.book_id === bookId);
}
