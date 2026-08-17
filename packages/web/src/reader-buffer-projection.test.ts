import { describe, expect, it } from "vitest";
import {
  boundedBufferV1Enabled,
  projectSegmentsToMountedLids,
  readerScrollProjection,
} from "./reader-buffer-projection";

describe("bounded reader segment projection", () => {
  it("enables bounded_buffer_v1 by default with explicit release rollback", () => {
    expect(boundedBufferV1Enabled("", undefined)).toBe(true);
    expect(boundedBufferV1Enabled("?bounded_buffer_v1=1", "0")).toBe(true);
    expect(boundedBufferV1Enabled("?bounded_buffer_v1=0", "1")).toBe(false);
    expect(boundedBufferV1Enabled("", "0")).toBe(false);
  });

  it("projects merged hydrated segments into exact reducer order", () => {
    const current = [1, 2, 3, 4].map((index) => ({ lid: `lid-${index}`, value: index }));
    const incoming = [5, 6].map((index) => ({ lid: `lid-${index}`, value: index }));

    expect(projectSegmentsToMountedLids(current, incoming, [
      "lid-3", "lid-4", "lid-5", "lid-6",
    ])).toEqual([
      { lid: "lid-3", value: 3 },
      { lid: "lid-4", value: 4 },
      { lid: "lid-5", value: 5 },
      { lid: "lid-6", value: 6 },
    ]);
  });

  it("fails closed when reducer identity has no hydrated segment", () => {
    expect(() => projectSegmentsToMountedLids(
      [{ lid: "lid-1" }],
      [{ lid: "lid-2" }],
      ["lid-1", "lid-3"],
    )).toThrow(/missing hydrated segment/i);
  });

  it.each([
    {
      label: "forward window",
      currentTopLid: "lid-0",
      insertRange: [20, 40] as const,
      expectedDelta: 20,
      expectedTop: "lid-20",
    },
    {
      label: "reverse across a three-window buffer",
      currentTopLid: "lid-60",
      insertRange: [0, 20] as const,
      expectedDelta: -60,
      expectedTop: "lid-0",
    },
    {
      label: "partial book-end insert",
      currentTopLid: "lid-2600",
      insertRange: [2620, 2623] as const,
      expectedDelta: 3,
      expectedTop: "lid-2603",
    },
    {
      label: "partial book-start insert",
      currentTopLid: "lid-10",
      insertRange: [0, 10] as const,
      expectedDelta: -10,
      expectedTop: "lid-0",
    },
  ])("projects authoritative reader.scroll for $label", ({
    currentTopLid,
    insertRange,
    expectedDelta,
    expectedTop,
  }) => {
    const leafOrder = Array.from({ length: 2_623 }, (_, index) => `lid-${index}`);
    const projection = readerScrollProjection({
      leafOrder,
      currentTopLid,
      insertRange,
      viewportWidth: 20,
    });
    expect(projection.delta).toBe(expectedDelta);
    expect(projection.expectedViewportLids[0]).toBe(expectedTop);
    expect(projection.expectedViewportLids).toContain(leafOrder[insertRange[0]]);
    expect(projection.expectedViewportLids).toContain(leafOrder[insertRange[1] - 1]);
  });
});
