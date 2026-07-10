// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pdfMocks = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render,
  }));
  const document = { numPages: 8, getPage, destroy: vi.fn(async () => undefined) };
  const getDocument = vi.fn(() => ({ promise: Promise.resolve(document), destroy: vi.fn(async () => undefined) }));
  return { render, getPage, getDocument };
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfMocks.getDocument,
}));

import SourceReviewPdfPage from "./SourceReviewPdfPage.vue";

describe("SourceReviewPdfPage", () => {
  beforeEach(() => {
    pdfMocks.render.mockClear();
    pdfMocks.getPage.mockClear();
    pdfMocks.getDocument.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  it("renders the requested physical PDF page and rerenders when navigation changes", async () => {
    const wrapper = mount(SourceReviewPdfPage, {
      props: {
        pdfUrl: "/book/pdf/original",
        pageIndex: 2,
        pageLabel: "1503",
      },
    });
    await flushPromises();

    expect(fetch).toHaveBeenCalledWith("/book/pdf/original", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(pdfMocks.getDocument).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
    expect(pdfMocks.getPage).toHaveBeenCalledWith(3);
    expect(wrapper.text()).toContain("PDF 页 1503 · 文件第 3 页");
    expect(wrapper.get("canvas").attributes("width")).not.toBe("0");

    await wrapper.setProps({ pageIndex: 4, pageLabel: "1505" });
    await flushPromises();
    expect(pdfMocks.getPage).toHaveBeenLastCalledWith(5);

    await wrapper.get('button[aria-label="放大 PDF"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("125%");
    expect(pdfMocks.render.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
