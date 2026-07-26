import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

function success(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("build intent API contract", () => {
  it("keeps status read-only and sends private drafts only to resident endpoints", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    vi.stubGlobal("fetch", fetchMock);

    await api.buildIntentStatus();
    await api.buildIntentDraft({
      mode: "goal_directed",
      user_goal: "private goal",
      budget: { max_total_tokens: 1200, on_exceed: "needs_user" },
    });

    expect(fetchMock.mock.calls[0]).toEqual(["/api/build_intent/status", { method: "GET" }]);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/build_intent/draft");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      mode: "goal_directed",
      user_goal: "private goal",
      budget: { max_total_tokens: 1200, on_exceed: "needs_user" },
    });
  });

  it("binds confirmation to both plan id and digest", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    vi.stubGlobal("fetch", fetchMock);

    await api.buildIntentConfirm("plan-001", "a".repeat(64));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/build_intent/confirm");
    expect(JSON.parse(init.body as string)).toEqual({
      plan_id: "plan-001",
      plan_digest: "a".repeat(64),
    });
  });

  it("reads the active artifact overlay without exposing mutation methods to the reader", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    vi.stubGlobal("fetch", fetchMock);

    await api.intentArtifacts();

    expect(fetchMock).toHaveBeenCalledWith("/api/build_intent/artifacts", { method: "GET" });
    expect(api).not.toHaveProperty("intentArtifactPrepare");
    expect(api).not.toHaveProperty("intentArtifactSubmit");
    expect(api).not.toHaveProperty("intentArtifactFail");
    expect(api).not.toHaveProperty("intentUsageCost");
  });

  it("exposes only body-free Reader usage events and the redacted ablation report", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    vi.stubGlobal("fetch", fetchMock);

    await api.intentUsage();
    await api.intentUsageEvent({
      event_id: "artifact-cite-001",
      occurred_at: "2026-07-26T04:06:00.000Z",
      kind: "artifact_cited",
      artifact_id: "artifact-001",
    });

    expect(fetchMock.mock.calls[0]).toEqual(["/api/build_intent/usage", { method: "GET" }]);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/build_intent/usage.event");
    expect(JSON.parse(init.body as string)).toEqual({
      event_id: "artifact-cite-001",
      occurred_at: "2026-07-26T04:06:00.000Z",
      kind: "artifact_cited",
      artifact_id: "artifact-001",
    });
    expect(init.body).not.toContain("lid");
  });
});
