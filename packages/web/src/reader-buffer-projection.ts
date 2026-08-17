export interface ReaderSegmentIdentity {
  lid: string;
}

export interface ReaderScrollProjectionInput {
  leafOrder: readonly string[];
  currentTopLid: string;
  insertRange: readonly [number, number];
  viewportWidth: number;
}

export interface ReaderScrollProjection {
  delta: number;
  expectedViewportLids: string[];
}

export function readerScrollProjection(
  input: ReaderScrollProjectionInput,
): ReaderScrollProjection {
  if (!Number.isInteger(input.viewportWidth) || input.viewportWidth <= 0) {
    throw new Error("reader viewport width must be a positive integer");
  }
  const currentTopIndex = input.leafOrder.indexOf(input.currentTopLid);
  if (currentTopIndex < 0) throw new Error("reader viewport top LID is outside leafOrder");
  const [insertStart, insertEnd] = input.insertRange;
  if (
    !Number.isInteger(insertStart)
    || !Number.isInteger(insertEnd)
    || insertStart < 0
    || insertEnd <= insertStart
    || insertEnd > input.leafOrder.length
  ) {
    throw new Error("reader insert range must be a non-empty leafOrder range");
  }
  const maximumTop = Math.max(0, input.leafOrder.length - input.viewportWidth);
  const targetTopIndex = Math.min(insertStart, maximumTop);
  const expectedViewportLids = input.leafOrder.slice(
    targetTopIndex,
    targetTopIndex + input.viewportWidth,
  );
  const inserted = input.leafOrder.slice(insertStart, insertEnd);
  const firstInsertedIndex = expectedViewportLids.indexOf(inserted[0]);
  if (
    firstInsertedIndex < 0
    || inserted.some((lid, index) => expectedViewportLids[firstInsertedIndex + index] !== lid)
  ) {
    throw new Error("reader viewport cannot cover the planned insert range");
  }
  return {
    delta: targetTopIndex - currentTopIndex,
    expectedViewportLids,
  };
}

export function boundedBufferV1Enabled(
  search: string,
  environmentValue: string | undefined,
): boolean {
  const query = new URLSearchParams(search).get("bounded_buffer_v1");
  if (query === "1" || query === "true") return true;
  if (query === "0" || query === "false") return false;
  return environmentValue !== "0" && environmentValue !== "false";
}

export function projectSegmentsToMountedLids<T extends ReaderSegmentIdentity>(
  current: readonly T[],
  incoming: readonly T[],
  mountedLids: readonly string[],
): T[] {
  const byLid = new Map<string, T>();
  for (const segment of current) {
    if (byLid.has(segment.lid)) {
      throw new Error(`current reader segments contain duplicate LID: ${segment.lid}`);
    }
    byLid.set(segment.lid, segment);
  }
  for (const segment of incoming) byLid.set(segment.lid, segment);

  return mountedLids.map((lid) => {
    const segment = byLid.get(lid);
    if (!segment) throw new Error(`missing hydrated segment for mounted LID: ${lid}`);
    return segment;
  });
}
