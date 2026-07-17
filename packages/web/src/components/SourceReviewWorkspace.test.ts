// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { SourceReviewBlock, SourceReviewDecision, SourceReviewLlmSuggestion } from "../api";
import SourceReviewWorkspace from "./SourceReviewWorkspace.vue";

const blocks: SourceReviewBlock[] = [
  {
    id: "block-1",
    status: "needs_review",
    reason: "fuzzy",
    review_question: "第一项应该采用哪一版？",
    md_excerpt: "The value is 42 mg.",
    md_context: "# Markdown title\n\nThe value is **42 mg**.",
    pdf_context: "PDF extracted text says the value is 43 mg.",
    pdf_excerpt: "The value is 43 mg.",
    candidate_text: "The value is 43 mg.",
    pdf_page_index: 2,
    pdf_page_label: "1503",
    comparison_score: 0.91,
    difference: { markdown: "42", pdf: "43" },
  },
  {
    id: "block-2",
    status: "md_unmatched",
    reason: "not found",
    review_question: "第二项是否属于同一段？",
    md_context: "Second Markdown evidence.",
    pdf_context: "Second extracted evidence.",
    pdf_page_index: 3,
    pdf_page_label: "1504",
    comparison_score: 0.4,
  },
];

function mountWorkspace(decisions: SourceReviewDecision[] = []) {
  return mount(SourceReviewWorkspace, {
    props: {
      blocks,
      decisions,
      pdfUrl: "/book/pdf/original",
      jobId: "job-a",
      actioning: false,
      stale: false,
      readyForRerun: false,
      reviewDraft: null,
    },
    global: {
      stubs: {
        SourceReviewPdfPage: {
          props: ["pdfUrl", "pageIndex", "pageLabel"],
          template: '<div class="pdf-page-stub">PDF {{ pageLabel }} / {{ pageIndex }}</div>',
        },
      },
    },
  });
}

describe("SourceReviewWorkspace", () => {
  it("shows one synchronized issue at a time and supports explicit navigation", async () => {
    const wrapper = mountWorkspace();

    expect(wrapper.text()).toContain("问题 1 / 2");
    expect(wrapper.text()).toContain("第一项应该采用哪一版？");
    expect(wrapper.text()).not.toContain("第二项是否属于同一段？");
    expect(wrapper.text()).toContain("PDF 1503 / 2");
    expect(wrapper.text()).toContain("Markdown title");
    expect(wrapper.text()).toContain("PDF extracted text says the value is 43 mg.");
    expect(wrapper.text()).toContain("采用 PDF 时将写入");

    await wrapper.get('button[aria-label="下一项"]').trigger("click");
    expect(wrapper.text()).toContain("问题 2 / 2");
    expect(wrapper.text()).toContain("第二项是否属于同一段？");
    expect(wrapper.text()).not.toContain("第一项应该采用哪一版？");

    const extractedTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === "提取正文");
    await extractedTab?.trigger("click");
    expect(extractedTab?.attributes("aria-selected")).toBe("true");
    expect(wrapper.get(".review-extracted-pane").classes()).toContain("mobile-active");
  });

  it("advances only after the active decision is persisted", async () => {
    const wrapper = mountWorkspace();
    const keepMarkdown = wrapper.findAll("button").find((button) => button.text().includes("保留 Markdown"));
    await keepMarkdown?.trigger("click");

    expect(wrapper.text()).toContain("问题 1 / 2");
    expect(wrapper.emitted("resolve")?.[0]?.[0]).toEqual({
      job_id: "job-a",
      block_id: "block-1",
      decision: "accept_markdown",
      replacement_text: undefined,
      note: undefined,
    });

    await wrapper.setProps({
      decisions: [{
        block_id: "block-1",
        decision: "accept_markdown",
        resolved_at: "2026-07-10T00:00:00Z",
      }],
    });

    expect(wrapper.text()).toContain("问题 2 / 2");
    expect(wrapper.text()).toContain("已解决 1 · 待人工 1");
  });

  it("keeps keep_blocked decisions in the pending human-review count", () => {
    const wrapper = mountWorkspace([{
      block_id: "block-1",
      decision: "keep_blocked",
      resolved_at: "2026-07-10T00:00:00Z",
    }]);

    expect(wrapper.text()).toContain("问题 1 / 2");
    expect(wrapper.text()).toContain("已解决 0 · 待人工 2");
  });

  it("shows a compact rerun state instead of the old issue after every decision is usable", async () => {
    const wrapper = mountWorkspace([
      {
        block_id: "block-1",
        decision: "accept_markdown",
        resolved_at: "2026-07-10T00:00:00Z",
      },
      {
        block_id: "block-2",
        decision: "manual_edit",
        replacement_text: "Second reconciled paragraph.",
        resolved_at: "2026-07-10T00:00:01Z",
      },
    ]);
    await wrapper.setProps({ readyForRerun: true, rerunning: true });

    expect(wrapper.text()).toContain("复核完成");
    expect(wrapper.text()).toContain("2 项决定已保存");
    expect(wrapper.text()).toContain("正在自动重新运行来源对齐");
    expect(wrapper.text()).not.toContain("问题 1 / 2");
    expect(wrapper.text()).not.toContain("第一项应该采用哪一版？");
    expect(wrapper.find('[aria-label="下一项"]').exists()).toBe(false);
  });

  it("does not count decisions from a stale fingerprint as resolved", async () => {
    const wrapper = mountWorkspace([
      {
        block_id: "block-1",
        decision: "accept_markdown",
        resolved_at: "2026-07-10T00:00:00Z",
      },
      {
        block_id: "block-2",
        decision: "manual_edit",
        replacement_text: "Second reconciled paragraph.",
        resolved_at: "2026-07-10T00:00:01Z",
      },
    ]);
    await wrapper.setProps({ decisionSetCurrent: false });

    expect(wrapper.text()).toContain("已解决 0 · 待人工 2");
    expect(wrapper.text()).toContain("LLM 处理全部 (2)");
  });

  it("shows structured LLM differences and applies the editable replacement through manual_edit", async () => {
    const wrapper = mountWorkspace();
    const analyze = wrapper.findAll("button").find((button) => button.text().includes("LLM 分析"));
    await analyze?.trigger("click");

    expect(wrapper.emitted("analyze")?.[0]?.[0]).toEqual({ block_id: "block-1" });

    const suggestion: SourceReviewLlmSuggestion = {
      version: "source_review_llm_suggestion.v1",
      block_id: "block-1",
      basis: "markdown_and_pdf_extracted_text",
      summary: "数值存在冲突，应采用 PDF 的 43 mg。",
      differences: [{
        kind: "number",
        markdown: "42 mg",
        pdf: "43 mg",
        explanation: "剂量数值不同。",
      }],
      recommendation: "use_pdf",
      replacement_text: "The value is **43 mg**.",
      confidence: 0.93,
      warnings: ["请核对原始 PDF。"],
    };
    await wrapper.setProps({ llmSuggestions: { "block-1": suggestion } });

    expect(wrapper.text()).toContain("数值存在冲突");
    expect(wrapper.findAll(".review-llm-source-pair code").map((node) => node.text())).toEqual(["42 mg", "43 mg"]);
    expect(wrapper.text()).toContain("建议采用 PDF 正文");
    expect(wrapper.text()).toContain("置信度 93%");
    expect((wrapper.get(".review-llm-replacement textarea").element as HTMLTextAreaElement).value)
      .toBe("The value is **43 mg**.");

    await wrapper.get(".review-llm-replacement textarea").setValue("The value is **43.0 mg**.");
    const apply = wrapper.findAll("button").find((button) => button.text() === "采用 LLM 修订");
    await apply?.trigger("click");

    expect(wrapper.emitted("resolve")?.at(-1)?.[0]).toEqual({
      job_id: "job-a",
      block_id: "block-1",
      decision: "manual_edit",
      replacement_text: "The value is **43.0 mg**.",
      note: undefined,
    });
  });

  it("starts one-click batch review and exposes partial success with failures left pending", async () => {
    const wrapper = mountWorkspace();
    const batchButton = wrapper.findAll("button").find((button) => button.text().includes("LLM 处理全部"));
    await batchButton?.trigger("click");

    expect(wrapper.emitted("analyze-all")).toHaveLength(1);

    await wrapper.setProps({
      actioning: true,
      llmBatchState: {
        status: "running",
        total: 2,
        processed: 1,
        applied: 1,
        failed: 0,
        current_block_id: "block-2",
        failures: [],
      },
    });
    expect(wrapper.text()).toContain("正在批量处理");
    expect(wrapper.text()).toContain("已处理 1/2");
    expect(wrapper.text()).toContain("已采用 1");
    expect(wrapper.findAll("button").find((button) => button.text().includes("处理中 1/2"))?.attributes("disabled"))
      .toBeDefined();

    await wrapper.setProps({
      actioning: false,
      decisions: [{
        block_id: "block-1",
        decision: "manual_edit",
        replacement_text: "The value is 43 mg.",
        note: "批量 LLM 自动采用；置信度 93%",
        resolved_at: "2026-07-10T00:00:00Z",
      }],
      llmBatchState: {
        status: "completed",
        total: 2,
        processed: 2,
        applied: 1,
        failed: 1,
        current_block_id: null,
        failures: [{
          block_id: "block-2",
          kind: "low_confidence",
          message: "LLM 置信度 62%，低于自动采用阈值 80%",
          confidence: 0.62,
        }],
      },
    });

    expect(wrapper.text()).toContain("批量处理完成");
    expect(wrapper.text()).toContain("待人工 1");
    expect(wrapper.text()).toContain("block-2");
    expect(wrapper.text()).toContain("低于自动采用阈值");
    expect(wrapper.text()).toContain("LLM 重试剩余 (1)");
    expect(wrapper.text()).toContain("问题 2 / 2");

    const previous = wrapper.get('button[aria-label="上一项"]');
    await previous.trigger("click");
    expect(wrapper.text()).toContain("已采用 LLM 修订");
  });

  it("blocks batch LLM when source reconciliation is overloaded", async () => {
    const wrapper = mountWorkspace();
    await wrapper.setProps({
      reviewLoad: {
        overloaded: true,
        unresolved_count: 390,
        total_units: 667,
        unresolved_ratio: 390 / 667,
        unmatched_ratio: 233 / 667,
        reason: "absolute_count",
      },
    });

    expect(wrapper.text()).toContain("390 项差异已超过逐项复核门限");
    expect(wrapper.text()).toContain("批量 LLM 已暂停");
    const batchButton = wrapper.findAll("button").find((button) => button.text().includes("批量 LLM 已暂停"));
    expect(batchButton?.attributes("disabled")).toBeDefined();
    await batchButton?.trigger("click");
    expect(wrapper.emitted("analyze-all")).toBeUndefined();
  });

  it("does not start a batch while an individual LLM analysis is running", async () => {
    const wrapper = mountWorkspace();
    await wrapper.setProps({ llmAnalyzingBlockId: "block-1" });
    const batchButton = wrapper.findAll("button").find((button) => button.text().includes("LLM 处理全部"));

    expect(batchButton?.attributes("disabled")).toBeDefined();
    await batchButton?.trigger("click");
    expect(wrapper.emitted("analyze-all")).toBeUndefined();
  });
});
