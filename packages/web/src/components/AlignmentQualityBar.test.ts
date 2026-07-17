// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { PdfAlignmentQuality } from "../api";
import AlignmentQualityBar from "./AlignmentQualityBar.vue";

const degraded: PdfAlignmentQuality = {
  policy_version: "hybrid_quality_policy.v1",
  tier: "degraded",
  unit_location_ratio: 0.8465608466,
  exact_text_span_ratio: 0.6627206241,
  exact_formula_ratio: 0.3168202765,
  heading_location_ratio: 0.976744186,
  report_path: "alignment_report.json",
};

describe("AlignmentQualityBar", () => {
  it("shows degraded quality metrics and opens Workbench diagnostics", async () => {
    const wrapper = mount(AlignmentQualityBar, {
      props: { quality: degraded, workbenchAvailable: true },
    });

    expect(wrapper.get("summary").text()).toContain("PDF 对齐：部分可用");
    expect(wrapper.text()).toContain("84.7%");
    expect(wrapper.text()).toContain("66.3%");
    expect(wrapper.text()).toContain("31.7%");
    expect(wrapper.text()).toContain("97.7%");

    await wrapper.get('[data-testid="alignment-diagnostics"]').trigger("click");
    expect(wrapper.emitted("open-workbench")).toHaveLength(1);
  });

  it("shows full quality without a dead diagnostics command", () => {
    const wrapper = mount(AlignmentQualityBar, {
      props: {
        quality: { ...degraded, tier: "full" },
        workbenchAvailable: false,
      },
    });

    expect(wrapper.get("summary").text()).toContain("PDF 对齐：完整");
    expect(wrapper.find('[data-testid="alignment-diagnostics"]').exists()).toBe(false);
  });
});
