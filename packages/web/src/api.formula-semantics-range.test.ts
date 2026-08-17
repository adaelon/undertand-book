import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("formula semantics range API", () => {
  it("binds both response identities to one range request", async () => {
    const payload = { start_lid: "1.2", end_lid: "1.5", items: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.formulaSemanticsRange("1.2", "1.5")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/book/formula_semantics_range?start=1.2&end=1.5",
      { method: "GET" },
    );
  });

  it("forwards one AbortSignal through both PHR7 range transports", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const payload = path.includes("formula_semantics_range")
        ? { start_lid: "1.2", end_lid: "1.5", items: [] }
        : { lid: "1.2", text: "range text" };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.text("1.2", "1.5", controller.signal);
    await api.formulaSemanticsRange("1.2", "1.5", controller.signal);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/book/text?lid=1.2&end=1.5",
      { method: "GET", signal: controller.signal },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/book/formula_semantics_range?start=1.2&end=1.5",
      { method: "GET", signal: controller.signal },
    );
  });
});
