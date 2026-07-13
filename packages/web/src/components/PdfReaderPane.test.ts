// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfSourceMap } from "../api";

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
});
