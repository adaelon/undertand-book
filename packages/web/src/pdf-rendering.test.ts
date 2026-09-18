import { describe, expect, it } from "vitest";
import {
  PDF_MAX_BACKING_PIXELS,
  PDF_MAX_RESIDENT_PAGES,
  pdfRenderIdentity,
  planPdfRenderResidency,
} from "./pdf-rendering";

describe("PDF render residency", () => {
  it("keeps only the five nearest pages and caps their combined backing pixels", () => {
    const plan = planPdfRenderResidency(
      Array.from({ length: 30 }, (_, pageIndex) => ({
        pageIndex,
        cssWidth: 1_000,
        cssHeight: 1_400,
        distance: Math.abs(pageIndex - 16),
      })),
      2,
    );

    expect(plan.pages.map((page) => page.pageIndex)).toEqual([16, 15, 17, 14, 18]);
    expect(plan.pages).toHaveLength(PDF_MAX_RESIDENT_PAGES);
    expect(plan.rasterScale).toBeLessThan(2);
    expect(plan.backingPixels).toBeLessThanOrEqual(PDF_MAX_BACKING_PIXELS);
  });

  it("ignores zero-sized candidates instead of inventing a one-pixel render", () => {
    const plan = planPdfRenderResidency([
      { pageIndex: 0, cssWidth: 0, cssHeight: 800, distance: 0 },
      { pageIndex: 1, cssWidth: 600, cssHeight: 0, distance: 1 },
    ], 2);

    expect(plan.pages).toEqual([]);
    expect(plan.backingPixels).toBe(0);
  });

  it("keys a render by source, page geometry, DPR and generation", () => {
    const base = {
      source: "paper-a:cfg-a:/paper.pdf",
      pageIndex: 3,
      cssWidth: 600,
      cssHeight: 800,
      rasterScale: 2,
      generation: 7,
    };

    expect(pdfRenderIdentity(base)).not.toBe(pdfRenderIdentity({ ...base, cssWidth: 601 }));
    expect(pdfRenderIdentity(base)).not.toBe(pdfRenderIdentity({ ...base, rasterScale: 1.5 }));
    expect(pdfRenderIdentity(base)).not.toBe(pdfRenderIdentity({ ...base, generation: 8 }));
    expect(pdfRenderIdentity(base)).not.toBe(pdfRenderIdentity({ ...base, source: "paper-b:cfg-b:/paper.pdf" }));
  });
});
