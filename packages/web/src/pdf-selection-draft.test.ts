import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PdfSelectionResolveResponse } from "./api";
import {
  type PdfSelectionCapture,
  usePdfSelectionDraft,
} from "./pdf-selection-draft";

function capture(requestId: string): PdfSelectionCapture {
  return {
    request_id: requestId,
    raw_quote: `raw-${requestId}`,
    rects: [{ pageIndex: 0, bbox: [1, 2, 3, 4] }],
    screen_rect: { left: 10, top: 20, right: 30, bottom: 40 },
  };
}

function response(status: "resolved" | "partial" | "unresolved", lid = "1.1"): PdfSelectionResolveResponse {
  return {
    status,
    ranges: status === "unresolved" ? [] : [{
      lid,
      range: { start: 1, end: 3 },
      source_span: { start: 11, end: 13 },
      quote_markdown: `quote-${lid}`,
    }],
    quote_markdown: status === "unresolved" ? "" : `quote-${lid}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("usePdfSelectionDraft", () => {
  it("builds resolved and partial drafts but keeps unresolved native-only", async () => {
    const resolve = vi.fn(async (value: PdfSelectionCapture) =>
      response(value.request_id === "partial" ? "partial" : value.request_id === "none" ? "unresolved" : "resolved"),
    );
    const controller = usePdfSelectionDraft(resolve);

    await controller.capture(capture("resolved"));
    expect(controller.state.value.phase).toBe("ready");
    expect(controller.state.value.draft).toMatchObject({
      status: "resolved",
      raw_quote: "raw-resolved",
      ranges: [{ lid: "1.1", range: { start: 1, end: 3 } }],
    });

    await controller.capture(capture("partial"));
    expect(controller.state.value.draft?.status).toBe("partial");

    await controller.capture(capture("none"));
    expect(controller.state.value).toEqual({ phase: "idle", capture: null, draft: null, error: null });
  });

  it("preserves recovered resolution diagnostics without changing resolved status", async () => {
    const controller = usePdfSelectionDraft(async () => ({
      ...response("resolved"),
      resolution_basis: "recovered",
      recovery_policy_version: "pdf_selection_recovery.v1",
      recovered_differences: ["layout_whitespace", "hyphen_representation"],
    }));

    await controller.capture(capture("recovered"));
    expect(controller.state.value.draft).toMatchObject({
      status: "resolved",
      resolution_basis: "recovered",
    });
  });

  it("drops late responses and preserves the newest request", async () => {
    const first = deferred<PdfSelectionResolveResponse>();
    const second = deferred<PdfSelectionResolveResponse>();
    const controller = usePdfSelectionDraft((value) => value.request_id === "a" ? first.promise : second.promise);

    const pendingA = controller.capture(capture("a"));
    const pendingB = controller.capture(capture("b"));
    second.resolve(response("resolved", "2.1"));
    await pendingB;
    first.resolve(response("resolved", "1.1"));
    await pendingA;

    expect(controller.state.value.draft?.request_id).toBe("b");
    expect(controller.state.value.draft?.ranges[0].lid).toBe("2.1");
  });

  it("supports retry, action failure retention, completion, and cancellation", async () => {
    let attempts = 0;
    const controller = usePdfSelectionDraft(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return response("resolved");
    });

    await controller.capture(capture("retry"));
    expect(controller.state.value).toMatchObject({ phase: "error", error: "offline" });
    await controller.retry();
    expect(controller.state.value.phase).toBe("ready");
    expect(controller.beginAction()?.request_id).toBe("retry");
    expect(controller.state.value.phase).toBe("saving");
    controller.actionFailed(new Error("write failed"));
    expect(controller.state.value).toMatchObject({ phase: "ready", error: "write failed" });
    expect(controller.state.value.draft?.request_id).toBe("retry");
    controller.complete();
    expect(controller.state.value.phase).toBe("idle");

    await controller.capture(capture("cancel"));
    controller.cancel();
    expect(controller.state.value.phase).toBe("idle");
  });

  it("keeps PDF selection actions explicit and partial Highlight disabled in App wiring", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const pane = readFileSync("src/components/PdfReaderPane.vue", "utf8");
    const paneStart = app.indexOf("<PdfReaderPane");
    const paneBinding = app.slice(paneStart, app.indexOf("/>", paneStart) + 2);
    expect(pane).not.toContain("api.pdfSelectionResolve");
    expect(pane).not.toContain("removeAllRanges");
    expect(paneBinding).toContain('@selection-capture="onPdfSelectionCapture"');
    expect(paneBinding).not.toContain('@select="onSelectSeg"');
    expect(app).toContain("raw_quote: capture.raw_quote");
    expect(app).toContain("getPdfSelectionCapabilities(ready.status).canNote");
    expect(app).toContain('v-if="pdfSelectionCapabilities.canHighlight"');
    expect(app).toContain('v-if="pdfSelectionCapabilities.canAsk"');
    expect(app).toContain("pdfSelectionSession.actionFailed(error)");
    expect(app).toContain("await api.replace({");
  });
});
