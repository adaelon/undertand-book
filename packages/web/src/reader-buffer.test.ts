import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  abortBufferTransition,
  assertReaderBufferInvariants,
  commitBufferTransition,
  planBufferTransition,
  readerTargetIsBeyondAdjacentWindow,
  replaceReaderBuffer,
  setReaderBufferPin,
  type ReaderBufferDirection,
  type ReaderBufferState,
  type ReaderBufferTransition,
} from "./reader-buffer";

function lids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `lid-${index}`);
}

function replace(
  leafOrder: string[],
  viewportWidth: number,
  startLeafIndex = 0,
  mountedCount = Math.min(viewportWidth, leafOrder.length - startLeafIndex),
  previous: ReaderBufferState | null = null,
): ReaderBufferState {
  return replaceReaderBuffer(previous, {
    sourceFingerprint: "source-a",
    leafOrder,
    mountedLids: leafOrder.slice(startLeafIndex, startLeafIndex + mountedCount),
    viewportWidth,
  });
}

function commitNext(
  state: ReaderBufferState,
  leafOrder: string[],
  direction: ReaderBufferDirection,
): ReaderBufferState {
  const planned = planBufferTransition(state, { leafOrder, direction });
  if (!planned.transition) return planned.state;
  const committed = commitBufferTransition(planned.state, planned.transition, { leafOrder });
  expect(committed.committed).toBe(true);
  return committed.state;
}

function expectSliceInvariant(state: ReaderBufferState, leafOrder: string[]) {
  expect(() => assertReaderBufferInvariants(state, leafOrder)).not.toThrow();
  expect(state.mountedLids).toEqual(
    leafOrder.slice(state.startLeafIndex, state.endLeafIndex),
  );
  expect(new Set(state.mountedLids).size).toBe(state.mountedLids.length);
  if (state.phase === "settled") {
    expect(state.mountedLids.length).toBeLessThanOrEqual(3 * state.viewportWidth);
  }
  else {
    expect(state.mountedLids.length).toBeLessThanOrEqual(4 * state.viewportWidth);
  }
}

describe("reader bounded buffer reducer", () => {
  it("reserves the immediately adjacent windows for edge prefetch", () => {
    const mountedRange = [100, 120] as const;
    for (const targetLeafIndex of [80, 99, 100, 119, 120, 139]) {
      expect(
        readerTargetIsBeyondAdjacentWindow(mountedRange, targetLeafIndex, 20, 200),
        `target ${targetLeafIndex}`,
      ).toBe(false);
    }
    expect(readerTargetIsBeyondAdjacentWindow(mountedRange, 79, 20, 200)).toBe(true);
    expect(readerTargetIsBeyondAdjacentWindow(mountedRange, 140, 20, 200)).toBe(true);
  });

  it.each([
    { leafCount: 0, width: 20 },
    { leafCount: 1, width: 20 },
    { leafCount: 20, width: 20 },
    { leafCount: 2623, width: 20 },
  ])("keeps a contiguous settled slice for $leafCount leaves", ({ leafCount, width }) => {
    const leafOrder = lids(leafCount);
    const state = replace(leafOrder, width);

    expect(state.phase).toBe("settled");
    expectSliceInvariant(state, leafOrder);
  });

  it("plans exact down and up insert/keep/evict ranges at the 3w budget", () => {
    const leafOrder = lids(20);
    const full = replace(leafOrder, 2, 4, 6);

    const down = planBufferTransition(full, { leafOrder, direction: "down" });
    expect(down.blocked).toBeNull();
    expect(down.transition).toMatchObject({
      direction: "down",
      insertRange: [10, 12],
      keepRange: [6, 10],
      evictRange: [4, 6],
      preserveAnchorLid: "lid-6",
      epoch: full.epoch,
    });
    expect(down.transition?.transientRange).toEqual([4, 12]);
    expect(down.transition?.settledRange).toEqual([6, 12]);
    expect(down.transition && down.transition.transientRange[1] - down.transition.transientRange[0])
      .toBe(4 * full.viewportWidth);

    const downCommit = commitBufferTransition(down.state, down.transition!, { leafOrder });
    expect(downCommit.committed).toBe(true);
    expect([downCommit.state.startLeafIndex, downCommit.state.endLeafIndex]).toEqual([6, 12]);
    expectSliceInvariant(downCommit.state, leafOrder);

    const up = planBufferTransition(downCommit.state, { leafOrder, direction: "up" });
    expect(up.transition).toMatchObject({
      direction: "up",
      insertRange: [4, 6],
      keepRange: [6, 10],
      evictRange: [10, 12],
      preserveAnchorLid: "lid-6",
    });
    const upCommit = commitBufferTransition(up.state, up.transition!, { leafOrder });
    expect([upCommit.state.startLeafIndex, upCommit.state.endLeafIndex]).toEqual([4, 10]);
    expectSliceInvariant(upCommit.state, leafOrder);
  });

  it("clamps incoming ranges at both book edges", () => {
    const leafOrder = lids(5);
    const atStart = replace(leafOrder, 2, 0, 2);
    const up = planBufferTransition(atStart, { leafOrder, direction: "up" });
    expect(up.transition).toBeNull();
    expect(up.blocked).toBe("book_edge");

    const nearEnd = replace(leafOrder, 2, 1, 2);
    const down = planBufferTransition(nearEnd, { leafOrder, direction: "down" });
    expect(down.transition?.insertRange).toEqual([3, 5]);
    const committed = commitBufferTransition(down.state, down.transition!, { leafOrder });
    expect(committed.state.mountedLids).toEqual(leafOrder.slice(1));
    expect(planBufferTransition(committed.state, { leafOrder, direction: "down" }).blocked)
      .toBe("book_edge");
  });

  it("allows only one global incoming transition and makes abort retryable", () => {
    const leafOrder = lids(100);
    const initial = replace(leafOrder, 5, 20, 15);
    const first = planBufferTransition(initial, { leafOrder, direction: "down" });
    expect(first.state.phase).toBe("loading");

    const competing = planBufferTransition(first.state, { leafOrder, direction: "up" });
    expect(competing.transition).toBeNull();
    expect(competing.blocked).toBe("transition_in_flight");

    const aborted = abortBufferTransition(competing.state, first.transition!);
    expect(aborted.aborted).toBe(true);
    expect(aborted.state.phase).toBe("settled");
    expect(planBufferTransition(aborted.state, { leafOrder, direction: "up" }).transition)
      .not.toBeNull();
  });

  it("rejects duplicate and stale epoch receipts without changing newer state", () => {
    const leafOrder = lids(100);
    const initial = replace(leafOrder, 5, 0, 5);
    const planned = planBufferTransition(initial, { leafOrder, direction: "down" });
    const first = commitBufferTransition(planned.state, planned.transition!, { leafOrder });
    expect(first.committed).toBe(true);

    const duplicate = commitBufferTransition(first.state, planned.transition!, { leafOrder });
    expect(duplicate.committed).toBe(false);
    expect(duplicate.state).toBe(first.state);

    const pending = planBufferTransition(first.state, { leafOrder, direction: "down" });
    const replaced = replace(leafOrder, 5, 40, 5, pending.state);
    expect(replaced.epoch).toBeGreaterThan(pending.transition!.epoch);
    const stale = commitBufferTransition(replaced, pending.transition!, { leafOrder });
    expect(stale.committed).toBe(false);
    expect(stale.state).toBe(replaced);
    expect([stale.state.startLeafIndex, stale.state.endLeafIndex]).toEqual([40, 45]);
  });

  it("resets source, width, pins, and transition identity on book replacement", () => {
    const oldLeafOrder = lids(100);
    let oldState = replace(oldLeafOrder, 5, 20, 15);
    oldState = setReaderBufferPin(oldState, {
      leafOrder: oldLeafOrder,
      pin: "selection",
      active: true,
    }).state;
    const oldPlan = planBufferTransition(oldState, {
      leafOrder: oldLeafOrder,
      direction: "down",
    });
    const newLeafOrder = Array.from({ length: 80 }, (_, index) => `new-lid-${index}`);
    const replacement = replaceReaderBuffer(oldPlan.state, {
      sourceFingerprint: "source-b",
      leafOrder: newLeafOrder,
      mountedLids: newLeafOrder.slice(10, 20),
      viewportWidth: 10,
    });

    expect(replacement.sourceFingerprint).toBe("source-b");
    expect(replacement.viewportWidth).toBe(10);
    expect(replacement.epoch).toBe(oldPlan.state.epoch + 1);
    expect(replacement.phase).toBe("settled");
    expect(replacement.pins).toEqual([]);
    expect(replacement.activeTransition).toBeNull();
    expect(replacement.pendingTrim).toBeNull();
    expect(commitBufferTransition(replacement, oldPlan.transition!, {
      leafOrder: newLeafOrder,
    }).committed).toBe(false);
    expectSliceInvariant(replacement, newLeafOrder);
  });

  it.each(["selection", "note"] as const)(
    "defers %s eviction as trim_pending and settles after the last pin releases",
    (pin) => {
      const leafOrder = lids(100);
      let state = replace(leafOrder, 5, 20, 15);
      state = setReaderBufferPin(state, { leafOrder, pin, active: true }).state;
      const planned = planBufferTransition(state, { leafOrder, direction: "down" });
      const committed = commitBufferTransition(planned.state, planned.transition!, { leafOrder });

      expect(committed.committed).toBe(true);
      expect(committed.state.phase).toBe("trim_pending");
      expect(committed.state.mountedLids).toHaveLength(20);
      expect(committed.state.pendingTrim?.evictRange).toEqual([20, 25]);
      expect(planBufferTransition(committed.state, { leafOrder, direction: "down" }).blocked)
        .toBe("trim_pending");
      expectSliceInvariant(committed.state, leafOrder);

      const released = setReaderBufferPin(committed.state, {
        leafOrder,
        pin,
        active: false,
      });
      expect(released.trimmed).toBe(true);
      expect(released.state.phase).toBe("settled");
      expect([released.state.startLeafIndex, released.state.endLeafIndex]).toEqual([25, 40]);
      expectSliceInvariant(released.state, leafOrder);
    },
  );

  it("waits for both selection and note pins before paying trim debt", () => {
    const leafOrder = lids(100);
    let state = replace(leafOrder, 5, 20, 15);
    state = setReaderBufferPin(state, { leafOrder, pin: "selection", active: true }).state;
    state = setReaderBufferPin(state, { leafOrder, pin: "note", active: true }).state;
    const planned = planBufferTransition(state, { leafOrder, direction: "down" });
    state = commitBufferTransition(planned.state, planned.transition!, { leafOrder }).state;

    const selectionReleased = setReaderBufferPin(state, {
      leafOrder,
      pin: "selection",
      active: false,
    });
    expect(selectionReleased.trimmed).toBe(false);
    expect(selectionReleased.state.phase).toBe("trim_pending");
    expect(selectionReleased.state.pins).toEqual(["note"]);

    const noteReleased = setReaderBufferPin(selectionReleased.state, {
      leafOrder,
      pin: "note",
      active: false,
    });
    expect(noteReleased.trimmed).toBe(true);
    expect(noteReleased.state.phase).toBe("settled");
    expectSliceInvariant(noteReleased.state, leafOrder);
  });

  it("keeps all invariants across 200 downward then 200 upward commits", () => {
    const leafOrder = lids(2623);
    let state = replace(leafOrder, 5, 500, 15);
    for (let index = 0; index < 200; index += 1) {
      state = commitNext(state, leafOrder, "down");
      expectSliceInvariant(state, leafOrder);
    }
    for (let index = 0; index < 200; index += 1) {
      state = commitNext(state, leafOrder, "up");
      expectSliceInvariant(state, leafOrder);
    }
    expect([state.startLeafIndex, state.endLeafIndex]).toEqual([500, 515]);
  });

  it("holds under a fixed-seed mixed transition sequence", () => {
    const leafOrder = lids(2623);
    let state = replace(leafOrder, 20, 1000, 60);
    let seed = 0x5eedc0de;
    let stale: ReaderBufferTransition | null = null;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let step = 0; step < 1000; step += 1) {
      const action = Math.floor(random() * 10);
      if (action === 0 || action === 1) {
        const pin = action === 0 ? "selection" : "note";
        state = setReaderBufferPin(state, {
          leafOrder,
          pin,
          active: !state.pins.includes(pin),
        }).state;
      }
      else if (action === 2) {
        const start = Math.floor(random() * (leafOrder.length - 20));
        state = replace(leafOrder, 20, start, 20, state);
      }
      else if (action === 3 && stale) {
        const receipt = commitBufferTransition(state, stale, { leafOrder });
        expect(receipt.committed).toBe(false);
        state = receipt.state;
      }
      else {
        const direction: ReaderBufferDirection = random() < 0.5 ? "up" : "down";
        const planned = planBufferTransition(state, { leafOrder, direction });
        state = planned.state;
        if (planned.transition) {
          stale = planned.transition;
          if (random() < 0.2) state = abortBufferTransition(state, planned.transition).state;
          else state = commitBufferTransition(state, planned.transition, { leafOrder }).state;
        }
      }
      expectSliceInvariant(state, leafOrder);
    }
  });

  it("fails closed when a replacement is not a contiguous leaf-order slice", () => {
    const leafOrder = lids(10);
    expect(() => replaceReaderBuffer(null, {
      sourceFingerprint: "source-a",
      leafOrder,
      mountedLids: ["lid-1", "lid-3"],
      viewportWidth: 2,
    })).toThrow(/contiguous/i);
  });

  it("wires bounded_buffer_v1 to authoritative scroll, segment projection, and pin trim", () => {
    const source = readFileSync("src/App.vue", "utf8");
    const loadWindow = source.slice(
      source.indexOf("async function loadWindow"),
      source.indexOf("// 阅读区与服务端 reader 同步"),
    );
    const edge = source.slice(
      source.indexOf("async function onScrollEdge"),
      source.indexOf("async function doGoto"),
    );

    expect(source).toContain("const readerBufferState = shallowRef<ReaderBufferState | null>(null)");
    expect(loadWindow).toContain("replaceReaderBuffer(");
    expect(edge).toContain("planBufferTransition(");
    expect(edge).toContain("commitBufferTransition(");
    expect(edge).toContain("abortBufferTransition(");
    expect(edge).toContain("await readerCommandQueue.run(");
    expect(edge).toContain("alignReaderViewportForEdge({");
    expect(edge).toContain("const effect = await api.scroll(delta)");
    expect(edge).toContain("viewport.value = effect.viewport");
    expect(edge).toContain("const merged = mergeSegments(");
    expect(edge).toContain("projectSegmentsToMountedLids(");
    expect(edge).toContain("segments.value.splice(0, segments.value.length, ...committedSegments)");
    expect(edge).toContain("finishSegmentStage(committedRange)");
    expect(source).toContain("setReaderBufferPin(");
    expect(source).toContain('@interaction-pin="onReaderInteractionPin"');
  });
});
