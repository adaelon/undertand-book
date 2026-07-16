// @vitest-environment happy-dom
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { PdfSelectionTranslationState } from "../pdf-selection-translation";
import PdfSelectionTranslationSurface from "./PdfSelectionTranslationSurface.vue";

const draft = {
  request_id: "selection-1",
  status: "resolved" as const,
  raw_quote: "raw",
  resolved_quote: "resolved",
  ranges: [{ lid: "1.1", range: { start: 0, end: 1 } }],
};

const anchorRect = { left: 120, top: 700, right: 240, bottom: 730 };

function state(
  phase: PdfSelectionTranslationState["phase"],
  overrides: Partial<PdfSelectionTranslationState> = {},
): PdfSelectionTranslationState {
  return {
    phase,
    draft: phase === "idle" ? null : draft,
    translation_markdown: null,
    error: null,
    ...overrides,
  };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

afterEach(() => setViewport(1024, 768));

describe("PdfSelectionTranslationSurface", () => {
  it("renders selectable Markdown/KaTeX output and emits the Markdown source for copy", async () => {
    setViewport(1440, 900);
    const wrapper = mount(PdfSelectionTranslationSurface, {
      props: {
        state: state("ready", { translation_markdown: "译文 $x^2$" }),
        anchorRect,
        renderMarkdown: (source) => `<p>${source}<span class="katex">formula</span></p>`,
        showSettings: false,
      },
    });
    await nextTick();

    expect(wrapper.find(".pdf-translation-markdown").classes()).toContain("pdf-translation-markdown");
    expect(wrapper.find(".katex").exists()).toBe(true);
    await wrapper.get('[aria-label="复制译文 Markdown"]').trigger("click");
    expect(wrapper.emitted("copy")).toEqual([["译文 $x^2$"]]);
  });

  it("keeps the copy and close icons at a clearly visible fixed size", async () => {
    const wrapper = mount(PdfSelectionTranslationSurface, {
      props: {
        state: state("ready", { translation_markdown: "译文" }),
        anchorRect,
        renderMarkdown: (source) => source,
        showSettings: false,
      },
    });
    await nextTick();

    for (const label of ["关闭翻译", "复制译文 Markdown"]) {
      const button = wrapper.get(`[aria-label="${label}"]`);
      expect(button.classes()).toContain("pdf-translation-primary-icon");
      expect(button.get("svg").attributes("width")).toBe("22");
      expect(button.get("svg").attributes("height")).toBe("22");
      expect(button.get("svg").attributes("stroke-width")).toBe("2.2");
    }
  });

  it("keeps close available in loading and exposes retry/settings for provider errors", async () => {
    const loading = mount(PdfSelectionTranslationSurface, {
      props: {
        state: state("loading"),
        anchorRect,
        renderMarkdown: (source) => source,
        showSettings: false,
      },
    });
    expect(loading.text()).toContain("翻译中");
    await loading.get('[aria-label="关闭翻译"]').trigger("click");
    expect(loading.emitted("close")).toHaveLength(1);

    const error = mount(PdfSelectionTranslationSurface, {
      props: {
        state: state("error", {
          error: {
            message: "Reader Provider is not configured",
            error_code: "TRANSLATION_PROVIDER_UNCONFIGURED",
            category: "provider",
          },
        }),
        anchorRect,
        renderMarkdown: (source) => source,
        showSettings: true,
      },
    });
    await error.get('[aria-label="重试翻译"]').trigger("click");
    await error.get('[aria-label="打开 Reader Provider 设置"]').trigger("click");
    expect(error.emitted("retry")).toHaveLength(1);
    expect(error.emitted("settings")).toHaveLength(1);
  });

  it("flips above a low desktop anchor and clamps horizontally", async () => {
    setViewport(800, 760);
    const wrapper = mount(PdfSelectionTranslationSurface, {
      props: {
        state: state("ready", { translation_markdown: "译文" }),
        anchorRect: { left: -40, top: 700, right: 20, bottom: 730 },
        renderMarkdown: (source) => source,
        showSettings: false,
      },
    });
    await nextTick();
    await nextTick();

    const style = wrapper.get(".pdf-translation-surface").attributes("style");
    expect(style).toContain("left: 12px");
    expect(style).toContain("top: 430px");
  });

  it("switches to a viewport-bound bottom sheet on narrow screens", async () => {
    setViewport(390, 844);
    const wrapper = mount(PdfSelectionTranslationSurface, {
      props: {
        state: state("ready", { translation_markdown: "移动译文" }),
        anchorRect,
        renderMarkdown: (source) => source,
        showSettings: false,
      },
    });
    await nextTick();
    await nextTick();

    expect(wrapper.get(".pdf-translation-surface").classes()).toContain("is-mobile");
    expect(wrapper.get(".pdf-translation-surface").attributes("style") ?? "").not.toContain("top:");
  });
});
