import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FormulaSemantics } from "../../core/src/generated/FormulaSemantics";
import type { ManifestNode } from "./generated/ManifestNode";
import {
  ReaderHydrationStaleError,
  ReaderHydrator,
  batchedHydrationV1Enabled,
  type ReaderHydrationApi,
} from "./reader-hydration";

interface Fixture {
  leaves: ManifestNode[];
  source: string;
  textByLid: Map<string, string>;
  formulaByLid: Map<string, FormulaSemantics>;
}

function formula(lid: string): FormulaSemantics {
  return {
    formula_lid: lid,
    parameters: [],
    composition: {
      source_lid: lid,
      meaning: `formula ${lid}`,
      terms: [],
      evidence_lids: [lid],
    },
    context_links: [],
  };
}

function fixture(count: number, formulaIndexes = new Set<number>()): Fixture {
  const leaves: ManifestNode[] = [];
  const textByLid = new Map<string, string>();
  const formulaByLid = new Map<string, FormulaSemantics>();
  let source = "";
  for (let index = 0; index < count; index += 1) {
    const lid = `1.${index + 1}`;
    const isFormula = formulaIndexes.has(index);
    const text = isFormula ? `$f_${index + 1}$` : index % 3 === 0 ? `leaf ${index + 1} 😀` : `叶 ${index + 1}`;
    const start = source.length;
    source += text;
    const end = source.length;
    leaves.push({
      lid,
      display_title: text,
      children: [],
      span: { start, end },
      kind: isFormula ? "formula" : "paragraph",
    });
    textByLid.set(lid, text);
    if (isFormula) formulaByLid.set(lid, formula(lid));
    if (index + 1 < count) source += index % 2 === 0 ? "\r\n" : "\n";
  }
  return { leaves, source, textByLid, formulaByLid };
}

function fixtureApi(input: Fixture): ReaderHydrationApi {
  const indexByLid = new Map(input.leaves.map((leaf, index) => [leaf.lid, index]));
  return {
    textRange: vi.fn(async (startLid, endLid) => {
      const start = input.leaves[indexByLid.get(startLid) ?? -1];
      const end = input.leaves[indexByLid.get(endLid) ?? -1];
      if (!start || !end) throw new Error("unknown text range");
      return {
        lid: startLid,
        end_lid: endLid,
        text: input.source.slice(start.span.start, end.span.end),
      };
    }),
    formulaRange: vi.fn(async (startLid, endLid) => {
      const startIndex = indexByLid.get(startLid) ?? -1;
      const endIndex = indexByLid.get(endLid) ?? -1;
      if (startIndex < 0 || endIndex < startIndex) throw new Error("unknown formula range");
      return {
        start_lid: startLid,
        end_lid: endLid,
        items: input.leaves
          .slice(startIndex, endIndex + 1)
          .flatMap((leaf) => {
            const item = input.formulaByLid.get(leaf.lid);
            return item ? [item] : [];
          }),
      };
    }),
  };
}

function setSource(
  hydrator: ReaderHydrator,
  input: Fixture,
  identity = "book-a:source-a",
  windowSize = 20,
) {
  hydrator.setSource({ identity, leaves: input.leaves, windowSize });
}

describe("batched hydration feature gate", () => {
  it("defaults on and keeps an explicit query/environment rollback", () => {
    expect(batchedHydrationV1Enabled("", undefined)).toBe(true);
    expect(batchedHydrationV1Enabled("?batched_hydration_v1=1", "0")).toBe(true);
    expect(batchedHydrationV1Enabled("?batched_hydration_v1=0", "1")).toBe(false);
    expect(batchedHydrationV1Enabled("", "false")).toBe(false);
  });

  it("wires App range hydration behind the explicit rollback gate and invalidates replacements/book switches", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const singularStart = app.indexOf("async function hydrateSegmentsSingular");
    const hydrateStart = app.indexOf("async function hydrateSegments(");
    const mergeStart = app.indexOf("function mergeSegments", hydrateStart);
    const singular = app.slice(singularStart, hydrateStart);
    const batched = app.slice(hydrateStart, mergeStart);
    const replacement = app.slice(
      app.indexOf("function beginReaderReplacement"),
      app.indexOf("function invalidateReaderReadWork"),
    );
    const reset = app.slice(
      app.indexOf("function resetBookSessionUi"),
      app.indexOf("async function submitOpenBook"),
    );

    expect(app).toContain("VITE_BATCHED_HYDRATION_V1");
    expect(app).toContain("api.text(startLid, endLid, signal)");
    expect(app).toContain("api.formulaSemanticsRange(startLid, endLid, signal)");
    expect(app).toContain("readerHydrator.setSource({");
    expect(singular).toContain("api.text(lid)");
    expect(singular).toContain("formulaFor(t.lid, kind)");
    expect(batched).toContain("if (!batchedReaderHydrationV1) return hydrateSegmentsSingular(lids)");
    expect(batched).toContain("readerHydrator.hydrate(lids, viewport.value?.width)");
    expect(replacement.indexOf("readerHydrator.invalidatePending()"))
      .toBeLessThan(replacement.indexOf("edgeLoadGate.beginReplacement()"));
    expect(reset).toContain("readerHydrator.clearSource()");
    expect(app.slice(app.indexOf("async function submitOpenBook")))
      .toContain("invalidateReaderReadWork()");
  });
});

describe("ReaderHydrator", () => {
  it("hydrates a cold 20-leaf window with one text range and at most one formula range", async () => {
    const input = fixture(24, new Set([2, 7, 13, 19]));
    const api = fixtureApi(input);
    const hydrator = new ReaderHydrator(api);
    setSource(hydrator, input);

    const result = await hydrator.hydrate(input.leaves.slice(0, 20).map((leaf) => leaf.lid));

    expect(api.textRange).toHaveBeenCalledTimes(1);
    expect(api.textRange).toHaveBeenCalledWith("1.1", "1.20", expect.any(AbortSignal));
    expect(api.formulaRange).toHaveBeenCalledTimes(1);
    expect(result).toEqual(input.leaves.slice(0, 20).map((leaf) => ({
      lid: leaf.lid,
      text: input.textByLid.get(leaf.lid),
      formula: input.formulaByLid.get(leaf.lid) ?? null,
    })));
  });

  it("requests only the two canonical gaps around settled cache hits", async () => {
    const input = fixture(20, new Set([1, 6, 11]));
    const api = fixtureApi(input);
    const hydrator = new ReaderHydrator(api);
    setSource(hydrator, input);
    await hydrator.hydrate(input.leaves.slice(5, 10).map((leaf) => leaf.lid));
    vi.mocked(api.textRange).mockClear();

    await hydrator.hydrate(input.leaves.slice(0, 15).map((leaf) => leaf.lid));

    expect(vi.mocked(api.textRange).mock.calls.map(([start, end]) => [start, end])).toEqual([
      ["1.1", "1.5"],
      ["1.11", "1.15"],
    ]);
  });

  it("keeps canonical output when disjoint same-epoch gaps complete out of order", async () => {
    const input = fixture(6);
    const api = fixtureApi(input);
    const hydrator = new ReaderHydrator(api);
    setSource(hydrator, input, "book-a:source-a", 6);
    await hydrator.hydrate(["1.3", "1.4"]);
    const pending = new Map<string, (reply: { lid: string; end_lid: string; text: string }) => void>();
    vi.mocked(api.textRange).mockImplementation((start, end) => (
      new Promise((resolve) => pending.set(`${start}:${end}`, resolve))
    ));

    const request = hydrator.hydrate(input.leaves.map((leaf) => leaf.lid));
    await vi.waitFor(() => expect(api.textRange).toHaveBeenCalledTimes(3));
    pending.get("1.5:1.6")?.({
      lid: "1.5",
      end_lid: "1.6",
      text: input.source.slice(input.leaves[4]!.span.start, input.leaves[5]!.span.end),
    });
    pending.get("1.1:1.2")?.({
      lid: "1.1",
      end_lid: "1.2",
      text: input.source.slice(input.leaves[0]!.span.start, input.leaves[1]!.span.end),
    });

    await expect(request).resolves.toEqual(input.leaves.map((leaf) => ({
      lid: leaf.lid,
      text: input.textByLid.get(leaf.lid),
      formula: null,
    })));
  });

  it("cleans in-flight ownership after a synchronous transport failure so retry is possible", async () => {
    const input = fixture(1);
    const api = fixtureApi(input);
    vi.mocked(api.textRange).mockImplementationOnce(() => {
      throw new Error("synchronous transport failure");
    });
    const hydrator = new ReaderHydrator(api);
    setSource(hydrator, input, "book-a:source-a", 1);

    await expect(hydrator.hydrate(["1.1"])).rejects.toThrow("synchronous transport failure");
    expect(hydrator.debugSnapshot().textInFlightLids).toEqual([]);
    await expect(hydrator.hydrate(["1.1"])).resolves.toEqual([{
      lid: "1.1",
      text: input.textByLid.get("1.1"),
      formula: null,
    }]);
    expect(api.textRange).toHaveBeenCalledTimes(2);
  });

  it("deduplicates the same in-flight range instead of issuing overlapping per-LID work", async () => {
    const input = fixture(4, new Set([1, 3]));
    let resolveText!: (reply: { lid: string; end_lid: string; text: string }) => void;
    let resolveFormula!: (reply: { start_lid: string; end_lid: string; items: FormulaSemantics[] }) => void;
    const textRange = vi.fn((_start: string, _end: string, _signal: AbortSignal) => (
      new Promise<{ lid: string; end_lid: string; text: string }>((resolve) => {
        resolveText = resolve;
      })
    ));
    const api: ReaderHydrationApi = {
      textRange,
      formulaRange: vi.fn((_start: string, _end: string, _signal: AbortSignal) => (
        new Promise<{ start_lid: string; end_lid: string; items: FormulaSemantics[] }>((resolve) => {
          resolveFormula = resolve;
        })
      )),
    };
    const hydrator = new ReaderHydrator(api);
    setSource(hydrator, input, "book-a:source-a", 4);
    const lids = input.leaves.map((leaf) => leaf.lid);

    const first = hydrator.hydrate(lids);
    const second = hydrator.hydrate(lids);
    await vi.waitFor(() => {
      expect(textRange).toHaveBeenCalledTimes(1);
      expect(api.formulaRange).toHaveBeenCalledTimes(1);
    });
    resolveText({ lid: "1.1", end_lid: "1.4", text: input.source });
    resolveFormula({
      start_lid: "1.2",
      end_lid: "1.4",
      items: [input.formulaByLid.get("1.2")!, input.formulaByLid.get("1.4")!],
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.arrayContaining([expect.objectContaining({ lid: "1.1" })]),
      expect.arrayContaining([expect.objectContaining({ lid: "1.1" })]),
    ]);
  });

  it("keeps absent formula semantics negative within one source and reevaluates after source replacement", async () => {
    const input = fixture(1, new Set([0]));
    const api = fixtureApi({ ...input, formulaByLid: new Map() });
    const hydrator = new ReaderHydrator(api);
    setSource(hydrator, input, "book-a:source-a", 1);

    await expect(hydrator.hydrate(["1.1"])).resolves.toEqual([
      { lid: "1.1", text: input.textByLid.get("1.1"), formula: null },
    ]);
    await hydrator.hydrate(["1.1"]);
    expect(api.formulaRange).toHaveBeenCalledTimes(1);

    setSource(hydrator, input, "book-b:source-b", 1);
    await hydrator.hydrate(["1.1"]);
    expect(api.formulaRange).toHaveBeenCalledTimes(2);
  });

  it("aborts an old epoch and refuses a late response that would overwrite the current cache", async () => {
    const input = fixture(1, new Set([0]));
    const requests: Array<{
      signal: AbortSignal;
      resolve: (reply: { lid: string; end_lid: string; text: string }) => void;
    }> = [];
    const textRange = vi.fn((_start: string, _end: string, signal: AbortSignal) => (
      new Promise<{ lid: string; end_lid: string; text: string }>((resolve) => {
        requests.push({ signal, resolve });
      })
    ));
    const formulaRequests: Array<{
      signal: AbortSignal;
      resolve: (reply: { start_lid: string; end_lid: string; items: FormulaSemantics[] }) => void;
    }> = [];
    const formulaRange = vi.fn((_start: string, _end: string, signal: AbortSignal) => (
      new Promise<{ start_lid: string; end_lid: string; items: FormulaSemantics[] }>((resolve) => {
        formulaRequests.push({ signal, resolve });
      })
    ));
    const hydrator = new ReaderHydrator({ textRange, formulaRange });
    const staleFixture: Fixture = {
      ...input,
      leaves: [{ ...input.leaves[0]!, span: { start: 0, end: 3 } }],
    };
    setSource(hydrator, staleFixture, "book-a:source-a", 1);

    const stale = hydrator.hydrate(["1.1"]);
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
      expect(formulaRequests).toHaveLength(1);
    });
    hydrator.invalidatePending();
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(formulaRequests[0]?.signal.aborted).toBe(true);
    const current = hydrator.hydrate(["1.1"]);
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
      expect(formulaRequests).toHaveLength(2);
    });
    requests[1]?.resolve({ lid: "1.1", end_lid: "1.1", text: "NEW" });
    formulaRequests[1]?.resolve({
      start_lid: "1.1",
      end_lid: "1.1",
      items: [input.formulaByLid.get("1.1")!],
    });
    await expect(current).resolves.toEqual([{
      lid: "1.1",
      text: "NEW",
      formula: input.formulaByLid.get("1.1"),
    }]);

    requests[0]?.resolve({ lid: "1.1", end_lid: "1.1", text: "OLD" });
    formulaRequests[0]?.resolve({ start_lid: "1.1", end_lid: "1.1", items: [] });
    await expect(stale).rejects.toBeInstanceOf(ReaderHydrationStaleError);
    await expect(hydrator.hydrate(["1.1"])).resolves.toEqual([
      { lid: "1.1", text: "NEW", formula: input.formulaByLid.get("1.1") },
    ]);
    expect(textRange).toHaveBeenCalledTimes(2);
    expect(formulaRange).toHaveBeenCalledTimes(2);
  });

  it("bounds both settled content caches to five viewport windows", async () => {
    const input = fixture(12, new Set(Array.from({ length: 12 }, (_, index) => index)));
    const api = fixtureApi(input);
    const hydrator = new ReaderHydrator(api);
    setSource(hydrator, input, "book-a:source-a", 2);

    for (const leaf of input.leaves) await hydrator.hydrate([leaf.lid]);

    const snapshot = hydrator.debugSnapshot();
    expect(snapshot.capacity).toBe(10);
    expect(snapshot.textSettledLids).toHaveLength(10);
    expect(snapshot.formulaSettledLids).toHaveLength(10);
    expect(snapshot.textSettledLids).toEqual(input.leaves.slice(2).map((leaf) => leaf.lid));
    expect(snapshot.formulaSettledLids).toEqual(input.leaves.slice(2).map((leaf) => leaf.lid));
    expect(snapshot.textInFlightLids).toEqual([]);
    expect(snapshot.formulaInFlightLids).toEqual([]);
  });
});
