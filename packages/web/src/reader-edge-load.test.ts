import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { alignReaderViewportForEdge, ReaderEdgeLoadGate } from "./reader-edge-load";

describe("alignReaderViewportForEdge", () => {
  const expected = ["lid-20", "lid-21"];
  const project = (currentTopLid: string) => ({
    delta: 20 - Number(currentTopLid.slice(4)),
    expectedViewportLids: expected,
  });

  it("accepts the first exact authoritative viewport", async () => {
    const scroll = vi.fn(async () => ({
      ok: true,
      viewport: { top_lid: "lid-20", visible_lids: expected },
    }));

    await expect(alignReaderViewportForEdge({
      currentTopLid: "lid-0",
      project,
      scroll,
    })).resolves.toMatchObject({ corrections: 0 });
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll).toHaveBeenCalledWith(20);
  });

  it("corrects once from the first authoritative top when cached state drifted", async () => {
    const scroll = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        viewport: { top_lid: "lid-40", visible_lids: ["lid-40", "lid-41"] },
      })
      .mockResolvedValueOnce({
        ok: true,
        viewport: { top_lid: "lid-20", visible_lids: expected },
      });

    await expect(alignReaderViewportForEdge({
      currentTopLid: "lid-0",
      project,
      scroll,
    })).resolves.toMatchObject({ corrections: 1 });
    expect(scroll.mock.calls).toEqual([[20], [-20]]);
  });

  it("fails closed when the authoritative correction is still inexact", async () => {
    const scroll = vi.fn(async () => ({
      ok: true,
      viewport: { top_lid: "lid-40", visible_lids: ["lid-40", "lid-41"] },
    }));

    await expect(alignReaderViewportForEdge({
      currentTopLid: "lid-0",
      project,
      scroll,
    })).rejects.toThrow(/after correction/i);
    expect(scroll.mock.calls).toEqual([[20], [-20]]);
  });
});

describe("ReaderEdgeLoadGate", () => {
  it("allows at most one in-flight request per edge direction", () => {
    const gate = new ReaderEdgeLoadGate();
    const up = gate.begin("up");
    const down = gate.begin("down");

    expect(up).not.toBeNull();
    expect(down).not.toBeNull();
    expect(gate.begin("up")).toBeNull();
    expect(gate.begin("down")).toBeNull();

    gate.finish(up!);
    expect(gate.begin("up")).not.toBeNull();
    expect(gate.isCurrent(down!)).toBe(true);
  });

  it("rejects stale epoch receipts without letting them clear newer work", () => {
    const gate = new ReaderEdgeLoadGate();
    const stale = gate.begin("down")!;
    const nextEpoch = gate.invalidate();
    const current = gate.begin("down")!;

    expect(current.epoch).toBe(nextEpoch);
    expect(gate.isCurrent(stale)).toBe(false);
    expect(gate.isCurrent(current)).toBe(true);
    const staleCommit = vi.fn();
    expect(gate.commit(stale, staleCommit)).toBe(false);
    expect(staleCommit).not.toHaveBeenCalled();
    const currentCommit = vi.fn();
    expect(gate.commit(current, currentCommit)).toBe(true);
    expect(currentCommit).toHaveBeenCalledOnce();
    gate.finish(stale);
    expect(gate.isCurrent(current)).toBe(true);
  });

  it("suspends edge work across overlapping replacement windows", () => {
    const gate = new ReaderEdgeLoadGate();
    const first = gate.beginReplacement();
    const second = gate.beginReplacement();

    expect(gate.begin("up")).toBeNull();
    expect(gate.isReplacementCurrent(first)).toBe(false);
    expect(gate.isReplacementCurrent(second)).toBe(true);
    expect(gate.finishReplacement(second)).toBe(true);
    expect(gate.isReplacementCurrent(second)).toBe(false);
    expect(gate.begin("down")).not.toBeNull();
    expect(gate.finishReplacement(first)).toBe(false);
  });

  it("guards App edge commits and invalidates them on replacement windows", () => {
    const source = readFileSync("src/App.vue", "utf8");
    const loadWindow = source.slice(
      source.indexOf("async function loadWindow"),
      source.indexOf("// 阅读区与服务端 reader 同步"),
    );
    const beginReplacement = source.slice(
      source.indexOf("function beginReaderReplacement"),
      source.indexOf("function invalidateReaderReadWork"),
    );
    const edge = source.slice(
      source.indexOf("async function onScrollEdge"),
      source.indexOf("async function doGoto"),
    );

    expect(loadWindow).toContain("beginReaderReplacement()");
    expect(beginReplacement).toContain("readerHydrator.invalidatePending()");
    expect(beginReplacement).toContain("edgeLoadGate.beginReplacement()");
    expect(loadWindow).toContain("edgeLoadGate.isReplacementCurrent(replacementEpoch)");
    expect(loadWindow).toContain("edgeLoadGate.finishReplacement(replacementEpoch)");
    expect(edge).toContain("const token = edgeLoadGate.begin(direction)");
    expect(edge.indexOf("edgeLoadGate.commit(token"))
      .toBeLessThan(edge.indexOf("const merged = mergeSegments"));
    expect(edge.indexOf("const merged = mergeSegments"))
      .toBeLessThan(edge.indexOf("segments.value.splice("));
    expect(edge.indexOf("segments.value.splice("))
      .toBeLessThan(edge.indexOf("finishSegmentStage(committedRange)"));
  });
});
