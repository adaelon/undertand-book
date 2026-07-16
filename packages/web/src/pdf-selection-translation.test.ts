import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import type { SelectionTranslationResponse } from "./api";
import {
  type PdfSelectionTranslationDraft,
  type PdfSelectionTranslationInvalidation,
  usePdfSelectionTranslation,
} from "./pdf-selection-translation";

function draft(requestId: string): PdfSelectionTranslationDraft {
  return {
    request_id: requestId,
    status: "resolved",
    raw_quote: `raw-${requestId}`,
    resolved_quote: `resolved-${requestId}`,
    ranges: [{ lid: "1.1", range: { start: 1, end: 3 } }],
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

const response = (translation: string): SelectionTranslationResponse => ({
  translation_markdown: translation,
  target_locale: "zh-CN",
});

describe("PDF selection translation controller", () => {
  it("sends selection context without request_id and retains the draft on success", async () => {
    const translate = vi.fn().mockResolvedValue(response("译文"));
    const controller = usePdfSelectionTranslation(translate);

    await controller.start(draft("one"));

    expect(translate).toHaveBeenCalledWith({
      status: "resolved",
      raw_quote: "raw-one",
      resolved_quote: "resolved-one",
      ranges: [{ lid: "1.1", range: { start: 1, end: 3 } }],
    });
    expect(controller.state.value.phase).toBe("ready");
    expect(controller.state.value.draft?.request_id).toBe("one");
    expect(controller.state.value.translation_markdown).toBe("译文");
  });

  it("drops stale success and failure responses after a newer selection", async () => {
    const first = deferred<SelectionTranslationResponse>();
    const second = deferred<SelectionTranslationResponse>();
    const translate = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = usePdfSelectionTranslation(translate);

    const pendingFirst = controller.start(draft("first"));
    const pendingSecond = controller.start(draft("second"));
    second.resolve(response("第二段"));
    await pendingSecond;
    first.reject(new Error("late failure"));
    await pendingFirst;

    expect(controller.state.value.phase).toBe("ready");
    expect(controller.state.value.draft?.request_id).toBe("second");
    expect(controller.state.value.translation_markdown).toBe("第二段");
  });

  it("retains typed errors and retries the same current draft", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, "TRANSLATION_PROVIDER_UNCONFIGURED", "provider", "missing"))
      .mockResolvedValueOnce(response("重试成功"));
    const controller = usePdfSelectionTranslation(translate);

    await controller.start(draft("retry"));
    expect(controller.state.value).toMatchObject({
      phase: "error",
      error: {
        message: "missing",
        error_code: "TRANSLATION_PROVIDER_UNCONFIGURED",
        category: "provider",
      },
    });

    await controller.retry();
    expect(translate).toHaveBeenCalledTimes(2);
    expect(controller.state.value.phase).toBe("ready");
    expect(controller.state.value.draft?.request_id).toBe("retry");
  });

  it.each<PdfSelectionTranslationInvalidation>([
    "close",
    "selection",
    "existing-action",
    "book-switch",
    "viewport",
    "unmount",
  ])("invalidates pending work on %s and ignores its late response", async (reason) => {
    const pending = deferred<SelectionTranslationResponse>();
    const controller = usePdfSelectionTranslation(() => pending.promise);

    const running = controller.start(draft(reason));
    controller.invalidate(reason);
    pending.resolve(response(`late-${reason}`));
    await running;

    expect(controller.state.value).toEqual({
      phase: "idle",
      draft: null,
      translation_markdown: null,
      error: null,
    });
  });

  it("does not cache a repeated selection", async () => {
    const translate = vi
      .fn()
      .mockResolvedValueOnce(response("第一次"))
      .mockResolvedValueOnce(response("第二次"));
    const controller = usePdfSelectionTranslation(translate);
    const selected = draft("same");

    await controller.start(selected);
    await controller.start(selected);

    expect(translate).toHaveBeenCalledTimes(2);
    expect(controller.state.value.translation_markdown).toBe("第二次");
  });

  it("wires selection, action, book, viewport, scroll, and unmount invalidation", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const pane = readFileSync("src/components/PdfReaderPane.vue", "utf8");

    expect(app).toContain('pdfSelectionTranslation.invalidate("selection")');
    expect(app).toContain('pdfSelectionTranslation.invalidate("existing-action")');
    expect(app).toContain('cancelPdfSelectionDraftFor("book-switch")');
    expect(app).toContain('pdfSelectionTranslation.invalidate("viewport")');
    expect(app).toContain('pdfSelectionTranslation.invalidate("unmount")');
    expect(pane).toContain('@scroll.passive="onViewportScroll"');
    expect(pane).toContain('emit("viewport-interaction")');
  });
});
