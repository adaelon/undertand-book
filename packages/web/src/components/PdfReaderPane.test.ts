// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord, PdfSourceMap } from "../api";
import type { PdfUserAnnotationProjection } from "../pdf-annotation-projection";

const pdfMocks = vi.hoisted(() => {
  const viewport = {
    width: 600,
    height: 800,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 800],
  };
  const page = {
    getViewport: vi.fn(() => viewport),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    getTextContent: vi.fn(async () => ({
      items: [{ str: "Visible only through selection", transform: [1, 0, 0, 12, 20, 760], width: 150 }],
    })),
  };
  const pdfDocument = { getPage: vi.fn(async () => page), destroy: vi.fn(async () => undefined) };
  const task = () => ({ promise: Promise.resolve(pdfDocument), destroy: vi.fn(async () => undefined) });
  const legacyTextLayer = vi.fn(function (this: { render: () => Promise<void> }, options: { container: HTMLElement }) {
    this.render = async () => {
      const span = globalThis.document.createElement("span");
      span.textContent = "Visible only through selection";
      options.container.append(span);
    };
  });
  return {
    modernWorkerOptions: { workerSrc: "" },
    legacyWorkerOptions: { workerSrc: "" },
    modernGetDocument: vi.fn(task),
    legacyGetDocument: vi.fn(task),
    legacyTextLayer,
    transform: vi.fn((_left: number[], right: number[]) => right),
  };
});

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: pdfMocks.modernWorkerOptions,
  getDocument: pdfMocks.modernGetDocument,
  Util: { transform: pdfMocks.transform },
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "modern-worker.mjs" }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: pdfMocks.legacyWorkerOptions,
  getDocument: pdfMocks.legacyGetDocument,
  TextLayer: pdfMocks.legacyTextLayer,
  Util: { transform: pdfMocks.transform },
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs?url", () => ({ default: "legacy-worker.mjs" }));

import PdfReaderPane from "./PdfReaderPane.vue";

const sourceMap: PdfSourceMap = {
  version: "pdf_source_map.v1",
  book_id: "paper-a",
  coordinate_system: {
    space: "pdf_user_space",
    origin: "bottom_left",
    unit: "pt",
    rotation_applied: false,
  },
  pages: [
    { pageIndex: 0, page_label: "1", width: 600, height: 800, rotate: 0, view: [0, 0, 600, 800] },
    { pageIndex: 1, page_label: "2", width: 600, height: 800, rotate: 0, view: [0, 0, 600, 800] },
  ],
  entries: [],
  excluded_regions: [],
  page_region_index: {},
  page_excluded_index: {},
  config_hash: "cfg",
};

class TestIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function annotation(memId: string, type: "highlight" | "note", lid = "1.1"): MemoryRecord {
  return {
    mem_id: memId,
    type,
    layer: "long_term",
    book_id: "paper-a",
    anchor: { lid, concept: null },
    content: type === "note" ? `> quote\n\nNote ${memId}` : `Highlight ${memId}`,
    range: type === "highlight" ? { start: 0, end: 4 } : undefined,
  };
}

describe("PdfReaderPane", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pdfMocks.modernGetDocument.mockClear();
    pdfMocks.legacyGetDocument.mockClear();
    pdfMocks.legacyTextLayer.mockClear();
    document.body.replaceChildren();
  });

  it("uses the compatible worker and keeps pages and dynamic text in their layers", async () => {
    const wrapper = mount(PdfReaderPane, {
      props: {
        sourceManifest: null,
        sourceMap,
        pdfUrl: "/api/book/pdf/original",
        activeLid: null,
        selectedLid: null,
      },
    });
    await flushPromises();
    await flushPromises();

    expect(pdfMocks.legacyGetDocument).toHaveBeenCalledWith({ url: "/api/book/pdf/original" });
    expect(pdfMocks.legacyWorkerOptions.workerSrc).toBe("legacy-worker.mjs");
    expect(pdfMocks.legacyTextLayer).toHaveBeenCalledTimes(sourceMap.pages.length);
    expect(pdfMocks.legacyTextLayer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        container: expect.any(HTMLElement),
        textContentSource: expect.objectContaining({ items: expect.any(Array) }),
        viewport: expect.objectContaining({ width: 600, height: 800 }),
      }),
    );

    const textSpan = wrapper.get(".pdf-text-layer span").element;
    expect(textSpan.textContent).toBe("Visible only through selection");

    const componentSource = readFileSync("src/components/PdfReaderPane.vue", "utf8");
    expect(componentSource).toContain("grid-auto-rows: max-content");
    expect(componentSource).toContain(".pdf-text-layer :deep(:is(span, br))");
    expect(componentSource).toContain("scaleX(var(--scale-x, 1))");

    wrapper.unmount();
  });

  it("keeps source-map geometry interactive without painting automatic PDF masks", async () => {
    const mappedSource: PdfSourceMap = {
      ...sourceMap,
      entries: [{
        lid: "1.1",
        source_span: { start: 0, end: 10 },
        status: "word_mapped",
        regions: [{ region_id: "r-1", pageIndex: 0, bbox: [0, 0, 600, 800] }],
        primary_region: { region_id: "r-1", pageIndex: 0, bbox: [0, 0, 600, 800] },
        alignment: { confidence: 1 },
      }],
    };
    const wrapper = mount(PdfReaderPane, {
      props: {
        sourceManifest: null,
        sourceMap: mappedSource,
        pdfUrl: "/api/book/pdf/original",
        activeLid: "1.1",
        selectedLid: null,
      },
    });
    await flushPromises();
    await flushPromises();

    expect(wrapper.findAll(".pdf-region")).toHaveLength(0);
    const page = wrapper.findAll(".pdf-page-shell")[0];
    vi.spyOn(page.element, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, bottom: 800, left: 0, right: 600,
      width: 600, height: 800, toJSON: () => ({}),
    });
    await page.trigger("click", { clientX: 300, clientY: 400 });
    expect(wrapper.emitted("goto")?.at(-1)).toEqual(["1.1"]);

    wrapper.unmount();
  });

  it("coalesces scrolling and resolves a cross-page center to the nearest mapped LID", async () => {
    const mappedSource: PdfSourceMap = {
      ...sourceMap,
      entries: [
        {
          lid: "1.1",
          source_span: { start: 0, end: 10 },
          status: "word_mapped",
          regions: [{ region_id: "r-1", pageIndex: 0, bbox: [0, 0, 600, 160] }],
          alignment: { confidence: 1 },
        },
        {
          lid: "2.1",
          source_span: { start: 10, end: 20 },
          status: "word_mapped",
          regions: [{ region_id: "r-2", pageIndex: 1, bbox: [0, 640, 600, 800] }],
          alignment: { confidence: 1 },
        },
      ],
    };
    const wrapper = mount(PdfReaderPane, {
      props: {
        sourceManifest: null,
        sourceMap: mappedSource,
        pdfUrl: "/api/book/pdf/original",
        activeLid: null,
        selectedLid: null,
      },
    });
    await flushPromises();
    await flushPromises();

    const rect = (top: number, bottom: number): DOMRect => ({
      x: 0,
      y: top,
      top,
      bottom,
      left: 0,
      right: 600,
      width: 600,
      height: bottom - top,
      toJSON: () => ({}),
    });
    vi.spyOn(wrapper.get(".pdf-page-list").element, "getBoundingClientRect").mockReturnValue(rect(0, 800));
    const pages = wrapper.findAll(".pdf-page-shell");
    vi.spyOn(pages[0].element, "getBoundingClientRect").mockReturnValue(rect(-500, 300));
    vi.spyOn(pages[1].element, "getBoundingClientRect").mockReturnValue(rect(320, 1120));

    const before = wrapper.emitted("viewport-change")?.length ?? 0;
    await wrapper.get(".pdf-page-list").trigger("scroll");
    await wrapper.get(".pdf-page-list").trigger("scroll");
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    const changes = wrapper.emitted("viewport-change") ?? [];
    expect(changes).toHaveLength(before + 1);
    expect(changes.at(-1)?.[0]).toMatchObject({
      start_page: 0,
      end_page: 1,
      anchor_lid: "2.1",
      region_id: null,
    });
    expect((changes.at(-1)?.[0] as { center_page: number }).center_page).toBeCloseTo(1.1, 4);

    wrapper.unmount();
  });

  it("captures native selection without navigating or clearing it and cancels on Escape", async () => {
    const wrapper = mount(PdfReaderPane, {
      props: {
        sourceManifest: null,
        sourceMap,
        pdfUrl: "/api/book/pdf/original",
        activeLid: null,
        selectedLid: null,
      },
    });
    await flushPromises();
    await flushPromises();

    const page = wrapper.findAll(".pdf-page-shell")[0];
    vi.spyOn(page.element, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, bottom: 800, left: 0, right: 600,
      width: 600, height: 800, toJSON: () => ({}),
    });
    const selectedRect = {
      x: 20, y: 100, top: 100, bottom: 120, left: 20, right: 120,
      width: 100, height: 20, toJSON: () => ({}),
    } as DOMRect;
    const textNode = wrapper.get(".pdf-text-layer span").element.firstChild;
    const removeAllRanges = vi.fn();
    const selectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      anchorNode: textNode,
      focusNode: textNode,
      rangeCount: 1,
      toString: () => "raw PDF quote",
      getRangeAt: () => ({ getClientRects: () => [selectedRect] }) as unknown as Range,
      removeAllRanges,
    } as unknown as Selection);

    await wrapper.get(".pdf-page-list").trigger("mouseup");
    const captures = wrapper.emitted("selection-capture") ?? [];
    expect(captures).toHaveLength(1);
    expect(captures[0][0]).toMatchObject({
      raw_quote: "raw PDF quote",
      rects: [{ pageIndex: 0, bbox: [20, 680, 120, 700] }],
      screen_rect: { left: 20, top: 100, right: 120, bottom: 120 },
    });
    expect((captures[0][0] as { request_id: string }).request_id).toMatch(/^pdf-selection-/);
    expect(wrapper.emitted("goto")).toBeUndefined();
    expect(wrapper.emitted("select")).toBeUndefined();
    expect(wrapper.emitted("focus-source")).toBeUndefined();
    expect(removeAllRanges).not.toHaveBeenCalled();

    selectionSpy.mockReturnValue({ isCollapsed: true } as Selection);
    const cancelsBeforeClick = wrapper.emitted("selection-cancel")?.length ?? 0;
    await page.trigger("click", { clientX: 500, clientY: 500 });
    expect(wrapper.emitted("selection-cancel")).toHaveLength(cancelsBeforeClick + 1);

    const cancelsBefore = wrapper.emitted("selection-cancel")?.length ?? 0;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(wrapper.emitted("selection-cancel")).toHaveLength(cancelsBefore + 1);
    wrapper.unmount();
  });

  it("renders exact user strokes and aggregated note markers without automatic regions", async () => {
    const noteA = annotation("n-a", "note");
    const noteB = annotation("n-b", "note");
    const projection: PdfUserAnnotationProjection = {
      highlights: [{
        mem_id: "h-a",
        record: annotation("h-a", "highlight"),
        rects: [
          { pageIndex: 0, bbox: [20, 680, 120, 700] },
          { pageIndex: 1, bbox: [30, 650, 110, 670] },
        ],
      }],
      note_markers: [{
        terminal_key: "0:1.1:3:4",
        anchor_rect: { pageIndex: 0, bbox: [115, 680, 120, 700] },
        notes: [noteA, noteB],
      }],
      location_by_mem_id: { "h-a": "exact", "n-a": "exact", "n-b": "exact" },
    };
    const wrapper = mount(PdfReaderPane, {
      attachTo: document.body,
      props: {
        sourceManifest: null,
        sourceMap,
        pdfUrl: "/api/book/pdf/original",
        activeLid: null,
        selectedLid: null,
        annotationProjection: projection,
        renderMarkdown: (source: string) => `<p>${source}</p>`,
      },
    });
    await flushPromises();
    await flushPromises();

    expect(wrapper.findAll(".pdf-user-highlight")).toHaveLength(2);
    expect(wrapper.get(".pdf-user-highlight").attributes("style")).toContain("top: 12.5%");
    expect(wrapper.findAll(".pdf-note-marker")).toHaveLength(1);
    expect(wrapper.get(".pdf-note-marker").text()).toBe("2");
    expect(wrapper.findAll(".pdf-region")).toHaveLength(0);

    const list = wrapper.get(".pdf-page-list").element as HTMLElement;
    list.scrollTop = 120;
    await wrapper.get(".pdf-note-marker").trigger("click");
    await flushPromises();
    expect(document.querySelectorAll(".pdf-annotation-surface .note-card")).toHaveLength(2);
    expect(document.querySelector(".pdf-annotation-surface")?.getAttribute("data-surface-kind")).toBe("notes");
    expect(list.scrollTop).toBe(120);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(document.querySelector(".pdf-annotation-surface")).toBeNull();
    expect(list.scrollTop).toBe(120);
    await wrapper.get(".pdf-note-marker").trigger("click");
    await flushPromises();

    const surface = document.querySelector(".pdf-annotation-surface")!;
    (surface.querySelector('button[title="编辑"]') as HTMLButtonElement).click();
    (surface.querySelector('button[title="删除"]') as HTMLButtonElement).click();
    (surface.querySelector('button[title="重新选择位置"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(wrapper.emitted("edit-note")?.at(-1)).toEqual([noteA]);
    expect(wrapper.emitted("delete-note")?.at(-1)).toEqual([noteA]);
    expect(wrapper.emitted("reselect-note")?.at(-1)).toEqual([noteA]);
    expect(list.scrollTop).toBe(120);

    const componentSource = readFileSync("src/components/PdfReaderPane.vue", "utf8");
    expect(componentSource).toContain("env(safe-area-inset-bottom)");
    wrapper.unmount();
  });

  it("opens a highlight surface through page hit testing and keeps failed mutations parent-owned", async () => {
    const highlight = annotation("h-hit", "highlight");
    const projection: PdfUserAnnotationProjection = {
      highlights: [{
        mem_id: highlight.mem_id,
        record: highlight,
        rects: [{ pageIndex: 0, bbox: [20, 680, 120, 700] }],
      }],
      note_markers: [],
      location_by_mem_id: { "h-hit": "exact" },
    };
    const wrapper = mount(PdfReaderPane, {
      attachTo: document.body,
      props: {
        sourceManifest: null,
        sourceMap,
        pdfUrl: "/api/book/pdf/original",
        activeLid: null,
        selectedLid: null,
        annotationProjection: projection,
      },
    });
    await flushPromises();
    await flushPromises();

    const page = wrapper.findAll(".pdf-page-shell")[0];
    vi.spyOn(page.element, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, bottom: 800, left: 0, right: 600,
      width: 600, height: 800, toJSON: () => ({}),
    });
    await page.trigger("click", { clientX: 50, clientY: 110 });
    expect(wrapper.emitted("goto")).toBeUndefined();
    expect(document.querySelector(".pdf-annotation-surface")?.textContent).toContain("Highlight h-hit");

    const surface = document.querySelector(".pdf-annotation-surface")!;
    (surface.querySelector('button[title="删除高亮"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(document.querySelector(".pdf-annotation-surface")).not.toBeNull();
    (surface.querySelector('button[title="重新选择高亮"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(wrapper.emitted("delete-highlight")?.at(-1)).toEqual([highlight]);
    expect(wrapper.emitted("reselect-highlight")?.at(-1)).toEqual([highlight]);

    await page.trigger("click", { clientX: 500, clientY: 500 });
    expect(document.querySelector(".pdf-annotation-surface")).toBeNull();
    wrapper.unmount();
  });
});
