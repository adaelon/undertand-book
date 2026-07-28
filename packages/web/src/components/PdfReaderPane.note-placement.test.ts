// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord, PdfSourceMap } from "../api";
import type { PdfUserAnnotationProjection } from "../pdf-annotation-projection";

const pdfMocks = vi.hoisted(() => {
  const page = {
    getViewport: vi.fn(({ scale = 1 }: { scale?: number } = {}) => ({
      width: 600 * scale,
      height: 800 * scale,
      scale,
      transform: [1, 0, 0, -1, 0, 800],
    })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
  };
  const document = { getPage: vi.fn(async () => page), destroy: vi.fn(async () => undefined) };
  const textLayerBuilder = vi.fn(function (
    this: { render: () => Promise<void>; cancel: () => void },
    options: { onAppend: (div: HTMLElement) => void },
  ) {
    this.render = async () => options.onAppend(globalThis.document.createElement("div"));
    this.cancel = vi.fn();
  });
  return {
    workerOptions: { workerSrc: "" },
    getDocument: vi.fn(() => ({ promise: Promise.resolve(document), destroy: vi.fn(async () => undefined) })),
    textLayerBuilder,
  };
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: pdfMocks.workerOptions,
  getDocument: pdfMocks.getDocument,
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
  pages: [{ pageIndex: 0, page_label: "1", width: 600, height: 800, rotate: 0, view: [0, 0, 600, 800] }],
  entries: [{
    lid: "1.1",
    source_span: { start: 0, end: 10 },
    status: "word_mapped",
    regions: [{ region_id: "r-1", pageIndex: 0, bbox: [100, 650, 200, 750] }],
    alignment: { confidence: 1 },
  }],
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

function pageRect(left = 0, top = 0, width = 600, height = 800): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    toJSON: () => ({}),
  };
}

describe("PdfReaderPane Note placement", () => {
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
    document.body.replaceChildren();
  });

  it("previews and emits only an actual eligible PDF placement region", async () => {
    const wrapper = mount(PdfReaderPane, {
      props: {
        sourceManifest: null,
        sourceMap,
        pdfUrl: "/api/book/pdf/original",
        activeLid: null,
        selectedLid: null,
        notePlacementActive: true,
      },
    });
    await flushPromises();
    await flushPromises();

    const page = wrapper.get(".pdf-page-shell");
    vi.spyOn(page.element, "getBoundingClientRect").mockReturnValue(pageRect(20, 100));
    await page.trigger("pointermove", { clientX: 170, clientY: 250, pointerType: "mouse" });

    const candidate = wrapper.get(".pdf-note-placement-candidate");
    expect(candidate.attributes("data-lid")).toBe("1.1");
    expect(candidate.attributes("data-region-id")).toBe("r-1");
    expect(candidate.attributes("style")).toContain("left: 16.666666666666664%");

    await page.trigger("pointerup", { clientX: 170, clientY: 250, pointerType: "mouse" });
    expect(wrapper.emitted("note-placement-target")?.at(-1)?.[0]).toMatchObject({
      entry: { lid: "1.1", status: "word_mapped" },
      region: { region_id: "r-1", pageIndex: 0 },
    });
    await page.trigger("click", { clientX: 170, clientY: 250 });
    expect(wrapper.emitted("goto")).toBeUndefined();

    await wrapper.setProps({ notePlacementActive: false });
    expect(wrapper.find(".pdf-note-placement-candidate").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps placement active on invalid or ambiguous points and destroys transient feedback", async () => {
    const ambiguousMap: PdfSourceMap = {
      ...sourceMap,
      entries: [
        ...sourceMap.entries,
        {
          lid: "2.1",
          source_span: { start: 10, end: 20 },
          status: "word_mapped",
          regions: [{ region_id: "r-2", pageIndex: 0, bbox: [120, 680, 180, 720] }],
          alignment: { confidence: 1 },
        },
      ],
    };
    const wrapper = mount(PdfReaderPane, {
      props: {
        sourceManifest: null,
        sourceMap: ambiguousMap,
        pdfUrl: "/api/book/pdf/original",
        activeLid: null,
        selectedLid: null,
        notePlacementActive: true,
      },
    });
    await flushPromises();
    await flushPromises();

    const page = wrapper.get(".pdf-page-shell");
    vi.spyOn(page.element, "getBoundingClientRect").mockReturnValue(pageRect());
    await page.trigger("pointerup", { clientX: 150, clientY: 100, pointerType: "touch" });
    expect(wrapper.emitted("note-placement-target")).toBeUndefined();
    expect(wrapper.get(".pdf-note-placement-feedback").text()).toContain("多个正文目标");

    await page.trigger("pointermove", { clientX: 150, clientY: 150, pointerType: "mouse" });
    expect(wrapper.get(".pdf-note-placement-candidate").attributes("data-region-id")).toBe("r-1");
    await wrapper.get(".pdf-page-list").trigger("scroll");
    expect(wrapper.find(".pdf-note-placement-candidate").exists()).toBe(false);

    await page.trigger("pointermove", { clientX: 150, clientY: 150, pointerType: "mouse" });
    expect(wrapper.find(".pdf-note-placement-candidate").exists()).toBe(true);
    await page.trigger("pointerleave");
    expect(wrapper.find(".pdf-note-placement-candidate").exists()).toBe(false);

    await page.trigger("pointerup", { clientX: 500, clientY: 500, pointerType: "pen" });
    expect(wrapper.get(".pdf-note-placement-feedback").text()).toContain("未命中可放置");
    await wrapper.setProps({ notePlacementActive: false });
    expect(wrapper.find(".pdf-note-placement-feedback").exists()).toBe(false);
    wrapper.unmount();
  });

  it("routes body-placement markers to move and selection markers to reselect", async () => {
    const bodyNote: MemoryRecord = {
      mem_id: "body-note",
      type: "note",
      layer: "long_term",
      book_id: "paper-a",
      anchor: { lid: "1.1", concept: null },
      content: "body note",
      note_placement: {
        kind: "pdf_region",
        source_fingerprint: "a".repeat(64),
        lid: "1.1",
        source_map_version: "pdf_source_map.v1",
        source_map_config_hash: "cfg",
        page_index: 0,
        region_id: "r-1",
      },
    };
    const selectionNote: MemoryRecord = {
      mem_id: "selection-note",
      type: "note",
      layer: "long_term",
      book_id: "paper-a",
      anchor: { lid: "1.1", concept: null },
      content: "> source\n\nselection note",
      selection_context: {
        status: "resolved",
        raw_quote: "source",
        resolved_quote: "source",
        ranges: [{ lid: "1.1", range: { start: 0, end: 6 } }],
      },
    };
    const projection: PdfUserAnnotationProjection = {
      highlights: [],
      note_markers: [{
        terminal_key: "mixed-marker",
        anchor_rect: { pageIndex: 0, bbox: [100, 650, 200, 750] },
        notes: [bodyNote, selectionNote],
      }],
      location_by_mem_id: { "body-note": "exact", "selection-note": "exact" },
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

    await wrapper.get(".pdf-note-marker").trigger("click");
    await flushPromises();
    let actions = [...document.querySelectorAll<HTMLButtonElement>(".pdf-annotation-reselect")];
    expect(actions.map((action) => action.textContent?.trim())).toEqual(["移动", "重新选择位置"]);
    actions[0].click();
    await flushPromises();
    expect(wrapper.emitted("reselect-note")?.at(-1)).toEqual([bodyNote]);

    await wrapper.get(".pdf-note-marker").trigger("click");
    await flushPromises();
    actions = [...document.querySelectorAll<HTMLButtonElement>(".pdf-annotation-reselect")];
    actions[1].click();
    await flushPromises();
    expect(wrapper.emitted("reselect-note")?.at(-1)).toEqual([selectionNote]);
    wrapper.unmount();
  });
});
