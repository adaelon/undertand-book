import { describe, expect, it } from "vitest";
import {
  hasMappedPdfNavigationTarget,
  normalizePaperViewportForMinimap,
} from "./paper-minimap-navigation";

describe("paper minimap navigation", () => {
  it("bounds a PDF viewport to the trusted minimap coordinate span", () => {
    const normalized = normalizePaperViewportForMinimap(
      {
        start_page: 0,
        end_page: 3,
        center_page: 2.5,
        progress_ratio: 0.25,
        anchor_lid: "1.1",
        region_id: null,
      },
      [
        { start_page: 2, end_page: 4 },
        { start_page: 5, end_page: 7 },
      ],
    );

    expect(normalized).toMatchObject({
      start_page: 2,
      end_page: 3,
      center_page: 2.5,
    });
    expect(normalized?.progress_ratio).toBeCloseTo(1 / 12, 6);
  });

  it("accepts either a requested LID or its resolved leaf as a mapped PDF target", () => {
    const mapped = new Set(["2.1"]);

    expect(hasMappedPdfNavigationTarget("2", "2.1", mapped)).toBe(true);
    expect(hasMappedPdfNavigationTarget("2.1", "2.1", mapped)).toBe(true);
    expect(hasMappedPdfNavigationTarget("appendix", "appendix.1", mapped)).toBe(false);
  });
});
