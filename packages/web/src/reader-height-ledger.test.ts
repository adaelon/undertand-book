import { describe, expect, it } from "vitest";
import {
  createReaderHeightLedger,
  projectReaderSpacerDelta,
  readerRangeHeight,
  readerRenderItemKey,
  readerSpacerTotals,
  recordReaderItemHeight,
  resetReaderHeightLedger,
} from "./reader-height-ledger";
import {
  planBufferTransition,
  replaceReaderBuffer,
} from "./reader-buffer";

function lids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `lid-${index}`);
}

function ledger(leafOrder = lids(10)) {
  return createReaderHeightLedger({
    sourceFingerprint: "source-a",
    leafOrder,
    layoutToken: "720px:16px:1.74",
    rendererVersion: "markdown-v1",
    estimatedLeafHeightPx: 40,
  });
}

describe("reader height ledger", () => {
  it("sums fixed measured items with deterministic estimates for unknown leaves", () => {
    const leafOrder = lids(10);
    let state = ledger(leafOrder);
    for (let index = 2; index < 6; index += 1) {
      const itemLids = [leafOrder[index]];
      state = recordReaderItemHeight(state, {
        key: readerRenderItemKey(itemLids),
        lids: itemLids,
        blockHeightPx: 50,
      }).ledger;
    }

    expect(readerRangeHeight(state, [0, 2])).toBe(80);
    expect(readerRangeHeight(state, [2, 6])).toBe(200);
    expect(readerSpacerTotals(state, [2, 6])).toEqual({
      topSpacerPx: 80,
      bottomSpacerPx: 160,
    });
  });

  it.each([
    { cause: "Note expansion", nextHeight: 118 },
    { cause: "delayed image decode", nextHeight: 184 },
    { cause: "KaTeX layout", nextHeight: 92 },
  ])("replaces the measured render-item height after $cause", ({ nextHeight }) => {
    const itemLids = ["lid-2", "lid-3"];
    const key = readerRenderItemKey(itemLids);
    const initial = recordReaderItemHeight(ledger(), {
      key,
      lids: itemLids,
      blockHeightPx: 80,
    });
    const changed = recordReaderItemHeight(initial.ledger, {
      key,
      lids: itemLids,
      blockHeightPx: nextHeight,
    });

    expect(changed.previousHeightPx).toBe(80);
    expect(changed.deltaPx).toBe(nextHeight - 80);
    expect(readerRangeHeight(changed.ledger, [2, 4])).toBe(nextHeight);
  });

  it("invalidates measurements on source, layout, renderer, or leaf-order change", () => {
    const itemLids = ["lid-2"];
    const measured = recordReaderItemHeight(ledger(), {
      key: readerRenderItemKey(itemLids),
      lids: itemLids,
      blockHeightPx: 96,
    }).ledger;
    expect(readerRangeHeight(measured, [2, 3])).toBe(96);

    const variants = [
      { sourceFingerprint: "source-b" },
      { layoutToken: "640px:16px:1.74" },
      { rendererVersion: "markdown-v2" },
      { leafOrder: [...lids(9), "replacement-lid"] },
    ];
    for (const variant of variants) {
      const reset = resetReaderHeightLedger(measured, {
        sourceFingerprint: variant.sourceFingerprint ?? measured.sourceFingerprint,
        leafOrder: variant.leafOrder ?? measured.leafOrder,
        layoutToken: variant.layoutToken ?? measured.layoutToken,
        rendererVersion: variant.rendererVersion ?? measured.rendererVersion,
        estimatedLeafHeightPx: measured.estimatedLeafHeightPx,
      });
      expect(reset).not.toBe(measured);
      expect(readerRangeHeight(reset, [2, 3])).toBe(40);
    }

    expect(resetReaderHeightLedger(measured, {
      sourceFingerprint: measured.sourceFingerprint,
      leafOrder: measured.leafOrder,
      layoutToken: measured.layoutToken,
      rendererVersion: measured.rendererVersion,
      estimatedLeafHeightPx: measured.estimatedLeafHeightPx,
    })).toBe(measured);
  });

  it("projects down and up reducer transitions into mechanical spacer deltas", () => {
    const leafOrder = lids(20);
    let heights = createReaderHeightLedger({
      sourceFingerprint: "source-a",
      leafOrder,
      layoutToken: "720px:16px:1.74",
      rendererVersion: "markdown-v1",
      estimatedLeafHeightPx: 10,
    });
    for (let index = 0; index < leafOrder.length; index += 1) {
      const itemLids = [leafOrder[index]];
      heights = recordReaderItemHeight(heights, {
        key: readerRenderItemKey(itemLids),
        lids: itemLids,
        blockHeightPx: index + 1,
      }).ledger;
    }
    const buffer = replaceReaderBuffer(null, {
      sourceFingerprint: "source-a",
      leafOrder,
      mountedLids: leafOrder.slice(4, 10),
      viewportWidth: 2,
    });
    const down = planBufferTransition(buffer, { leafOrder, direction: "down" }).transition!;

    expect(down.evictRange).toEqual([4, 6]);
    expect(projectReaderSpacerDelta(heights, down)).toEqual({
      topSpacerDeltaPx: 11,
      bottomSpacerDeltaPx: -23,
    });
    expect(readerSpacerTotals(heights, down.settledRange)).toEqual({
      topSpacerPx: 21,
      bottomSpacerPx: 132,
    });

    const settled = replaceReaderBuffer(buffer, {
      sourceFingerprint: "source-a",
      leafOrder,
      mountedLids: leafOrder.slice(...down.settledRange),
      viewportWidth: 2,
    });
    const up = planBufferTransition(settled, { leafOrder, direction: "up" }).transition!;
    expect(projectReaderSpacerDelta(heights, up)).toEqual({
      topSpacerDeltaPx: -11,
      bottomSpacerDeltaPx: 23,
    });
  });

  it("fails closed for non-contiguous render-item identities", () => {
    expect(() => recordReaderItemHeight(ledger(), {
      key: readerRenderItemKey(["lid-1", "lid-3"]),
      lids: ["lid-1", "lid-3"],
      blockHeightPx: 80,
    })).toThrow(/contiguous/i);
  });
});
