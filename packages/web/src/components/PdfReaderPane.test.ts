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
  const getViewport = vi.fn(({ scale = 1 }: { scale?: number } = {}) => ({
    ...viewport,
    width: viewport.width * scale,
    height: viewport.height * scale,
    scale,
  }));
  const page = {
    getViewport,
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    getTextContent: vi.fn(async () => ({
      items: [{ str: "Visible only through selection", transform: [1, 0, 0, 12, 20, 760], width: 150 }],
    })),
  };
  const pdfDocument = { getPage: vi.fn(async () => page), destroy: vi.fn(async () => undefined) };
  const task = () => ({ promise: Promise.resolve(pdfDocument), destroy: vi.fn(async () => undefined) });
  const textLayerRender = vi.fn();
  const textLayerCancel = vi.fn();
  const textLayerBuilder = vi.fn(function (
    this: { div: HTMLElement; render: (options: unknown) => Promise<void>; cancel: () => void },
    options: { onAppend: (div: HTMLElement) => void },
  ) {
    this.div = globalThis.document.createElement("div");
    this.div.className = "textLayer";
    this.render = async (renderOptions) => {
      textLayerRender(renderOptions);
      const span = globalThis.document.createElement("span");
      span.textContent = "Visible only through selection";
      this.div.append(span);
      const end = globalThis.document.createElement("div");
      end.className = "endOfContent";
      this.div.append(end);
      options.onAppend(this.div);
    };
    this.cancel = textLayerCancel;
  });
  return {
    modernWorkerOptions: { workerSrc: "" },
    legacyWorkerOptions: { workerSrc: "" },
    modernGetDocument: vi.fn(task),
    legacyGetDocument: vi.fn(task),
    textLayerBuilder,
    textLayerRender,
    textLayerCancel,
    getViewport,
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
  Util: { transform: pdfMocks.transform },
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs?url", () => ({ default: "legacy-worker.mjs" }));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({ TextLayerBuilder: pdfMocks.textLayerBuilder }));

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
    pdfMocks.textLayerBuilder.mockClear();
    pdfMocks.textLayerRender.mockClear();
    pdfMocks.textLayerCancel.mockClear();
    pdfMocks.getViewport.mockClear();
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
    expect(pdfMocks.textLayerBuilder).toHaveBeenCalledTimes(sourceMap.pages.length);
    expect(pdfMocks.textLayerBuilder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        pdfPage: expect.any(Object),
        onAppend: expect.any(Function),
      }),
    );
    expect(pdfMocks.textLayerRender).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ viewport: expect.objectContaining({ width: 600, height: 800 }) }),
    );

    const textSpan = wrapper.get(".pdf-text-layer span").element;
    expect(textSpan.textContent).toBe("Visible only through selection");

    const componentSource = readFileSync("src/components/PdfReaderPane.vue", "utf8");
    expect(componentSource).toContain("grid-auto-rows: max-content");
    expect(componentSource).toContain(".pdf-text-layer :deep(.textLayer)");
    expect(componentSource).toContain(".pdf-text-layer :deep(.textLayer .endOfContent)");
    expect(componentSource).toContain("scaleX(var(--scale-x))");

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

  it("scrolls same-page outline targets to their exact mapped regions", async () => {
    const mappedSource: PdfSourceMap = {
      ...sourceMap,
      entries: [
        {
          lid: "1.1",
          source_span: { start: 0, end: 10 },
          status: "word_mapped",
          regions: [{ region_id: "r-high", pageIndex: 0, bbox: [100, 700, 200, 720] }],
          primary_region: { region_id: "r-high", pageIndex: 0, bbox: [100, 700, 200, 720] },
          alignment: { confidence: 1 },
        },
        {
          lid: "1.2",
          source_span: { start: 10, end: 20 },
          status: "word_mapped",
          regions: [{ region_id: "r-low", pageIndex: 0, bbox: [100, 80, 200, 100] }],
          primary_region: { region_id: "r-low", pageIndex: 0, bbox: [100, 80, 200, 100] },
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

    const list = wrapper.get(".pdf-page-list").element as HTMLElement;
    const page = wrapper.findAll(".pdf-page-shell")[0].element as HTMLElement;
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, bottom: 400, left: 0, right: 600,
      width: 600, height: 400, toJSON: () => ({}),
    });
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, bottom: 800, left: 0, right: 600,
      width: 600, height: 800, toJSON: () => ({}),
    });
    vi.spyOn(page, "scrollIntoView").mockImplementation(() => undefined);

    list.scrollTop = 0;
    await wrapper.setProps({ activeLid: "1.1" });
    await flushPromises();
    const highTargetScroll = list.scrollTop;

    list.scrollTop = 0;
    await wrapper.setProps({ activeLid: "1.2" });
    await flushPromises();
    const lowTargetScroll = list.scrollTop;

    expect(lowTargetScroll).toBeGreaterThan(highTargetScroll + 400);
    await wrapper.get(".pdf-page-list").trigger("wheel", { deltaY: 40 });
    expect(wrapper.emitted("viewport-interaction")).toHaveLength(1);
    wrapper.unmount();
  });

  it("zooms every PDF layer from the reader toolbar and rerenders at the new scale", async () => {
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

    expect(wrapper.get('[aria-label="\u7f29\u5c0f PDF"]')).toBeTruthy();
    expect(wrapper.get('[aria-label="\u9002\u5408\u680f\u5bbd"]')).toBeTruthy();
    const zoomOut = wrapper.get('[aria-label="\u7f29\u5c0f PDF"]');
    const zoomFit = wrapper.get('[aria-label="\u9002\u5408\u680f\u5bbd"]');
    const zoomIn = wrapper.get('[aria-label="\u653e\u5927 PDF"]');
    const pageShells = wrapper.findAll(".pdf-page-shell");
    const pageWidthSpies = pageShells.map((shell) => (
      vi.spyOn(shell.element, "clientWidth", "get").mockReturnValue(750)
    ));
    const renderCount = pdfMocks.textLayerBuilder.mock.calls.length;

    await zoomIn.trigger("click");
    await flushPromises();

    expect(wrapper.get('[aria-label="\u9002\u5408\u680f\u5bbd"]').text()).toContain("125%");
    expect(wrapper.get(".pdf-page-list").classes()).toContain("is-zoomed");
    expect(pageShells[0].attributes("style")).toContain("125%");
    expect(pdfMocks.getViewport).toHaveBeenCalledWith({ scale: 1.25 });
    expect(pdfMocks.textLayerCancel).toHaveBeenCalledTimes(renderCount);
    expect(pdfMocks.textLayerBuilder.mock.calls.length).toBeGreaterThan(renderCount);

    for (const width of pageWidthSpies) width.mockReturnValue(600);
    pdfMocks.getViewport.mockClear();
    await zoomFit.trigger("click");
    await flushPromises();
    expect(zoomFit.text()).toContain("100%");
    expect(wrapper.get(".pdf-page-list").classes()).not.toContain("is-zoomed");
    expect(pdfMocks.getViewport).toHaveBeenCalledWith({ scale: 1 });

    for (const width of pageWidthSpies) width.mockReturnValue(450);
    pdfMocks.getViewport.mockClear();
    await zoomOut.trigger("click");
    await flushPromises();
    expect(zoomFit.text()).toContain("75%");
    expect(zoomOut.attributes()).toHaveProperty("disabled");
    expect(pdfMocks.getViewport).toHaveBeenCalledWith({ scale: 0.75 });

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

    const noteVisibilityToggle = wrapper.get(".pdf-note-visibility-toggle");
    expect(noteVisibilityToggle.attributes("aria-pressed")).toBe("true");
    expect(noteVisibilityToggle.attributes("title")).toBe("隐藏笔记标记");
    await noteVisibilityToggle.trigger("click");
    expect(wrapper.findAll(".pdf-note-marker")).toHaveLength(0);
    expect(wrapper.findAll(".pdf-user-highlight")).toHaveLength(2);
    expect(noteVisibilityToggle.attributes("aria-pressed")).toBe("false");
    expect(noteVisibilityToggle.attributes("title")).toBe("显示笔记标记");
    await noteVisibilityToggle.trigger("click");
    expect(wrapper.findAll(".pdf-note-marker")).toHaveLength(1);

    const list = wrapper.get(".pdf-page-list").element as HTMLElement;
    list.scrollTop = 120;
    await wrapper.get(".pdf-note-marker").trigger("click");
    await flushPromises();
    expect(document.querySelectorAll(".pdf-annotation-surface .note-card")).toHaveLength(2);
    expect(document.querySelector(".pdf-annotation-surface")?.getAttribute("data-surface-kind")).toBe("notes");
    expect(list.scrollTop).toBe(120);

    await noteVisibilityToggle.trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".pdf-note-marker")).toHaveLength(0);
    expect(document.querySelector(".pdf-annotation-surface")).toBeNull();
    await noteVisibilityToggle.trigger("click");
    expect(wrapper.findAll(".pdf-note-marker")).toHaveLength(1);
    await wrapper.get(".pdf-note-marker").trigger("click");
    await flushPromises();

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

  it("omits the visible count for a single Note marker", async () => {
    const note = annotation("n-single", "note");
    const projection: PdfUserAnnotationProjection = {
      highlights: [],
      note_markers: [{
        terminal_key: "0:1.1:3:4",
        anchor_rect: { pageIndex: 0, bbox: [115, 680, 120, 700] },
        notes: [note],
      }],
      location_by_mem_id: { "n-single": "exact" },
    };
    const wrapper = mount(PdfReaderPane, {
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

    const marker = wrapper.get('[aria-label="打开 1 条 PDF 笔记"]');
    expect(marker.text()).toBe("");
    expect(marker.find("span").exists()).toBe(false);
    expect(marker.attributes("title")).toBe("1 条笔记");
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
