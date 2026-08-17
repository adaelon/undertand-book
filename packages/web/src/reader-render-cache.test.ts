import { describe, expect, it, vi } from "vitest";
import {
  runReaderRenderWorkInBatches,
  ReaderSegmentHtmlCache,
} from "./reader-render-cache";

function configure(
  cache: ReaderSegmentHtmlCache,
  overrides: Partial<Parameters<ReaderSegmentHtmlCache["configure"]>[0]> = {},
) {
  cache.configure({
    bookId: "book-a",
    sourceFingerprint: "source-a",
    rendererVersion: "markdown-v1",
    maxEntries: 5,
    ...overrides,
  });
}

describe("ReaderSegmentHtmlCache", () => {
  it("reuses base HTML while excluding overlay state from its identity", () => {
    const cache = new ReaderSegmentHtmlCache();
    const renderer = vi.fn(() => "<em>body</em>");
    configure(cache);

    expect(cache.render({ lid: "1.1", text: "*body*", kind: "paragraph" }, renderer))
      .toBe("<em>body</em>");
    expect(cache.render({ lid: "1.1", text: "*body*", kind: "paragraph" }, renderer))
      .toBe("<em>body</em>");
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(cache.snapshot()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
  });

  it("invalidates only a changed LID text revision within one source scope", () => {
    const cache = new ReaderSegmentHtmlCache();
    configure(cache);
    const first = vi.fn(() => "first-v1");
    const second = vi.fn(() => "second-v1");
    cache.render({ lid: "1.1", text: "first", kind: "paragraph" }, first);
    cache.render({ lid: "1.2", text: "second", kind: "paragraph" }, second);

    expect(cache.render(
      { lid: "1.1", text: "first revised", kind: "paragraph" },
      () => "first-v2",
    )).toBe("first-v2");
    expect(cache.render(
      { lid: "1.2", text: "second", kind: "paragraph" },
      second,
    )).toBe("second-v1");
    expect(second).toHaveBeenCalledTimes(1);
    expect(cache.snapshot()).toMatchObject({ entries: 2, hits: 1, misses: 3 });
  });

  it.each([
    { label: "book", scope: { bookId: "book-b" } },
    { label: "source", scope: { sourceFingerprint: "source-b" } },
    { label: "renderer", scope: { rendererVersion: "markdown-v2" } },
  ])("clears entries when the $label identity changes", ({ scope }) => {
    const cache = new ReaderSegmentHtmlCache();
    configure(cache);
    cache.render({ lid: "1.1", text: "body", kind: "paragraph" }, () => "body");

    configure(cache, scope);
    expect(cache.snapshot().entries).toBe(0);
  });

  it("enforces the configured 5w-style LRU limit after growth and shrink", () => {
    const cache = new ReaderSegmentHtmlCache();
    configure(cache, { maxEntries: 10 });
    for (let index = 0; index < 25; index += 1) {
      cache.render(
        { lid: `lid-${index}`, text: `text-${index}`, kind: "paragraph" },
        () => `html-${index}`,
      );
      expect(cache.snapshot().entries).toBeLessThanOrEqual(10);
    }
    configure(cache, { maxEntries: 5 });
    expect(cache.snapshot()).toMatchObject({ entries: 5, maxEntries: 5, evictions: 20 });
  });
});

describe("runReaderRenderWorkInBatches", () => {
  it("preserves input order and yields between bounded batches", async () => {
    const rendered: number[] = [];
    const yieldedAt: number[] = [];

    await expect(runReaderRenderWorkInBatches(
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      (value) => rendered.push(value),
      {
        batchSize: 4,
        yieldAfterLast: true,
        yieldToMain: async () => { yieldedAt.push(rendered.length); },
      },
    )).resolves.toBe(true);

    expect(rendered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(yieldedAt).toEqual([4, 8, 9]);
  });

  it("stops before the next batch when an edge load becomes stale", async () => {
    const rendered: number[] = [];
    let current = true;

    await expect(runReaderRenderWorkInBatches(
      [1, 2, 3, 4, 5],
      (value) => rendered.push(value),
      {
        batchSize: 2,
        shouldContinue: () => current,
        yieldToMain: async () => { current = false; },
      },
    )).resolves.toBe(false);

    expect(rendered).toEqual([1, 2]);
  });
});
