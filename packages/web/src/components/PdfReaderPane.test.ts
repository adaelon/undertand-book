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
});
