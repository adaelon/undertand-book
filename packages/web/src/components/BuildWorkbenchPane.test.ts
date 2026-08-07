// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { BuildJobState, BuildStageId, BuildWorkbenchSnapshot } from "../api";
import BuildWorkbenchPane from "./BuildWorkbenchPane.vue";

const stages = [
  "source_reconciliation",
  "hybrid_foundation",
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
] as const satisfies readonly BuildStageId[];

function snapshot(): BuildWorkbenchSnapshot {
  return {
    version: "build_workbench_snapshot.v1",
    book_id: "paper-a",
    readiness: {
      route: "workbench",
      status: "needs_review",
      reasons: ["source reconciliation needs review"],
      stages: Object.fromEntries(stages.map((stage) => [stage, {
        stage,
        status: stage === "source_reconciliation" ? "needs_review" : "blocked",
        ...(stage === "source_reconciliation" ? { reason: "source reconciliation has unresolved blocks" } : {}),
      }])) as BuildWorkbenchSnapshot["readiness"]["stages"],
    },
    input: { manifest: null, fingerprint: null, ready: false },
    jobs: [{
      version: "build_job_state.v1",
      job_id: "job-a",
      book_id: "paper-a",
      input_fingerprint: { paper_md_sha256: "md", paper_pdf_sha256: "pdf", config_hash: "cfg" },
      status: "needs_user",
      events: [],
      decision_requests: [],
      permission_requests: [],
      created_at: "1",
      updated_at: "1",
    }],
    source_review: {
      report: {},
      unresolved: [{
        id: "block-71",
        status: "needs_review",
        reason: "technical fuzzy reason",
        review_question: "Markdown 与 PDF 的数值不同，请确认可信正文。",
        md_excerpt: "The value is 42 mg.",
        md_context: "Markdown context: The value is 42 mg.",
        pdf_excerpt: "The value is 43 mg.",
        candidate_text: "The value is 43 mg.",
        pdf_context: "PDF context: The value is 43 mg.",
        pdf_page_index: 2,
        pdf_page_label: "1503",
        comparison_score: 0.91,
        difference: { markdown: "42", pdf: "43" },
      }],
      review_draft_markdown: null,
      decisions: null,
      ready_for_rerun: false,
    },
    operations: {
      warnings: [],
      permission_audit: [],
      retention: { max_jobs: 20, max_events_per_job: 200, max_permission_audit_entries: 200 },
    },
    sidecar_plan: { plan: null, form_draft: null, build_spec: null },
  };
}

describe("BuildWorkbenchPane source review", () => {
  it("allows reader entry when artifacts are trusted despite an interrupted job", async () => {
    const trusted = snapshot();
    trusted.readiness.route = "reader";
    trusted.readiness.status = "trusted_book";
    trusted.jobs[0]!.status = "interrupted";

    const wrapper = mount(BuildWorkbenchPane, {
      props: {
        snapshot: trusted,
        loading: false,
        error: null,
        confirming: false,
        importing: false,
        actioning: false,
        pdfUrl: "/book/pdf/original",
      },
    });
    const enterButton = wrapper.findAll("button").find((button) => button.text() === "进入阅读");

    expect(enterButton?.attributes("disabled")).toBeUndefined();
    await enterButton?.trigger("click");
    expect(wrapper.emitted("enter-reader")).toHaveLength(1);
  });

  it("renders paired evidence and emits an explicit manual replacement", async () => {
    const wrapper = mount(BuildWorkbenchPane, {
      props: {
        snapshot: snapshot(),
        loading: false,
        error: null,
        confirming: false,
        importing: false,
        actioning: false,
        pdfUrl: "/book/pdf/original",
      },
      global: {
        stubs: {
          SourceReviewPdfPage: {
            props: ["pdfUrl", "pageIndex", "pageLabel"],
            template: '<div class="pdf-page-stub">original PDF page {{ pageLabel }}</div>',
          },
        },
      },
    });

    expect(wrapper.get(".pdf-page-stub").text()).toContain("original PDF page 1503");
    expect(wrapper.text()).toContain("Markdown 与 PDF 的数值不同，请确认可信正文。");
    expect(wrapper.text()).toContain("Markdown context: The value is 42 mg.");
    expect(wrapper.text()).toContain("PDF context: The value is 43 mg.");
    expect(wrapper.text()).toContain("PDF 页 1503");
    expect(wrapper.text()).toContain("Markdown: 42");
    expect(wrapper.text()).toContain("PDF: 43");
    expect(wrapper.text()).not.toContain("technical fuzzy reason");

    const batchButton = wrapper.findAll("button").find((button) => button.text().includes("LLM 处理全部"));
    await batchButton?.trigger("click");
    expect(wrapper.emitted("apply-all-source-review-with-llm")).toHaveLength(1);

    const editButton = wrapper.findAll("button").find((button) => button.text().includes("手工修正"));
    await editButton?.trigger("click");
    await wrapper.get(".review-edit textarea").setValue("The value is 44 mg.");
    const confirmButton = wrapper.findAll("button").find((button) => button.text() === "确认手工修正");
    await confirmButton?.trigger("click");

    expect(wrapper.emitted("resolve-source-review")?.at(-1)?.[0]).toEqual({
      job_id: "job-a",
      block_id: "block-71",
      decision: "manual_edit",
      replacement_text: "The value is 44 mg.",
      note: undefined,
    });
  });

  it("shows automatic source reconciliation instead of the old resolved issue", () => {
    const ready = snapshot();
    ready.source_review.ready_for_rerun = true;
    ready.source_review.decisions = {
      version: "source_review_decisions.v1",
      decisions: [{
        block_id: "block-71",
        decision: "accept_markdown",
        resolved_at: "2026-07-10T00:00:00Z",
      }],
    };
    ready.readiness.reasons = ["source reconciliation has unresolved blocks"];
    ready.jobs[0]!.status = "running";
    ready.jobs[0]!.active_run = {
      run_id: "run-auto-source",
      stage: "source_reconciliation",
      executor: "manual",
    };
    const wrapper = mount(BuildWorkbenchPane, {
      props: {
        snapshot: ready,
        loading: false,
        error: null,
        confirming: false,
        importing: false,
        actioning: false,
        pdfUrl: "/book/pdf/original",
      },
      global: {
        stubs: {
          SourceReviewPdfPage: true,
        },
      },
    });

    expect(wrapper.text()).toContain("复核完成");
    expect(wrapper.text()).toContain("正在自动重新运行来源对齐");
    expect(wrapper.text()).not.toContain("问题 1 / 1");
    expect(wrapper.text()).toContain("来源复核已完成，正在重新运行来源对齐。");
    expect(wrapper.text()).not.toContain("来源对齐仍有未解决片段。");
  });

  it("hides residual review blocks after an audited manual source override", () => {
    const overridden = snapshot();
    overridden.source_review.ready_for_rerun = false;
    overridden.source_review.report = {
      acceptance: {
        mode: "manual_override",
        policy: "single_review_then_override_v1",
        accepted_at: "2026-07-10T00:00:02Z",
        residual_unresolved_count: 1,
        decision_count: 1,
      },
    };
    overridden.source_review.decisions = {
      version: "source_review_decisions.v1",
      decisions: [{
        block_id: "block-71",
        decision: "manual_edit",
        replacement_text: "The user-reviewed value is 44 mg.",
        resolved_at: "2026-07-10T00:00:01Z",
      }],
    };
    overridden.readiness.stages.source_reconciliation = {
      stage: "source_reconciliation",
      status: "done",
    };
    overridden.jobs[0]!.status = "ready";

    const wrapper = mount(BuildWorkbenchPane, {
      props: {
        snapshot: overridden,
        loading: false,
        error: null,
        confirming: false,
        importing: false,
        actioning: false,
        pdfUrl: "/book/pdf/original",
      },
      global: { stubs: { SourceReviewPdfPage: true } },
    });

    expect(wrapper.text()).toContain("已采用人工终裁正文");
    expect(wrapper.text()).toContain("一次来源验证仍有 1 个残余差异");
    expect(wrapper.text()).not.toContain("问题 1 / 1");
    expect(wrapper.text()).not.toContain("LLM 处理全部");
  });

  it("ignores stale job gates and selects the next missing foundation stage", () => {
    const ready = snapshot();
    ready.input.ready = true;
    ready.readiness.status = "missing";
    ready.readiness.stages.source_reconciliation = {
      stage: "source_reconciliation",
      status: "done",
    };
    ready.readiness.stages.hybrid_foundation = {
      stage: "hybrid_foundation",
      status: "missing",
      reason: "trusted source.txt is missing",
    };
    const currentJob = ready.jobs[0]!;
    currentJob.status = "ready";
    currentJob.updated_at = "2";
    const staleJob: BuildJobState = {
      ...currentJob,
      job_id: "job-stale",
      status: "stale_input",
      decision_requests: [{
        decision_id: "decision-stale",
        job_id: "job-stale",
        stage: "source_reconciliation",
        kind: "review_acceptance",
        prompt: "旧任务决定不应显示",
        options: [],
        status: "pending",
        created_at: "1",
      }],
      permission_requests: [{
        request_id: "permission-stale",
        run_id: "run-stale",
        executor: "codex",
        category: "filesystem",
        action_summary: "旧任务权限不应显示",
        scope_hint: "stage",
        status: "pending",
        created_at: "1",
      }],
      updated_at: "1",
    };
    ready.jobs = [staleJob, currentJob];

    const wrapper = mount(BuildWorkbenchPane, {
      props: {
        snapshot: ready,
        loading: false,
        error: null,
        confirming: false,
        importing: false,
        actioning: false,
        pdfUrl: "/book/pdf/original",
      },
      global: { stubs: { SourceReviewPdfPage: true } },
    });

    const startButton = wrapper.findAll("button").find((button) => button.text() === "启动所选阶段");
    expect(startButton?.attributes("disabled")).toBeUndefined();
    expect((wrapper.get(".run-control-grid select").element as HTMLSelectElement).value)
      .toBe("hybrid_foundation");
    expect(wrapper.text()).not.toContain("旧任务决定不应显示");
    expect(wrapper.text()).not.toContain("旧任务权限不应显示");
    expect(wrapper.text()).not.toContain("当前任务正在等待下方的构建决策或执行权限处理。");
  });

  it("offers an explicit reader transition after the trust gate passes", async () => {
    const trusted = snapshot();
    trusted.input.ready = true;
    trusted.readiness.route = "reader";
    trusted.readiness.status = "trusted_book";
    trusted.readiness.reasons = [];
    trusted.readiness.stages.source_reconciliation = {
      stage: "source_reconciliation",
      status: "done",
    };
    trusted.readiness.stages.hybrid_foundation = {
      stage: "hybrid_foundation",
      status: "done",
    };
    trusted.jobs[0]!.status = "done";

    const wrapper = mount(BuildWorkbenchPane, {
      props: {
        snapshot: trusted,
        loading: false,
        error: null,
        confirming: false,
        importing: false,
        actioning: false,
        pdfUrl: "/book/pdf/original",
      },
      global: { stubs: { SourceReviewPdfPage: true } },
    });

    const enterReader = wrapper.findAll("button").find((button) => button.text() === "进入阅读");
    expect(enterReader).toBeDefined();
    await enterReader?.trigger("click");
    expect(wrapper.emitted("enter-reader")).toHaveLength(1);
  });

  it("keeps manifest-backed inputs visible without asking for the same files again", async () => {
    const imported = snapshot();
    imported.input = {
      manifest: {
        version: "workbench_input_manifest.v1",
        book_id: "paper-a",
        profile_id: "paper",
        display_title: "Paper A",
        created_at: "1",
        updated_at: "2",
        inputs: {
          paper_md: {
            path: "paper.md",
            sha256: "md",
            size_bytes: 123,
            source: "uploaded_text",
            original_path: null,
          },
          paper_pdf: {
            path: "paper.pdf",
            sha256: "pdf",
            size_bytes: 456,
            source: "uploaded_base64",
            original_path: null,
          },
        },
        config_hash: "cfg",
        fingerprint: { paper_md_sha256: "md", paper_pdf_sha256: "pdf", config_hash: "cfg" },
        trusted: false,
      },
      fingerprint: { paper_md_sha256: "md", paper_pdf_sha256: "pdf", config_hash: "cfg" },
      ready: true,
    };

    const wrapper = mount(BuildWorkbenchPane, {
      props: {
        snapshot: imported,
        loading: false,
        error: null,
        confirming: false,
        importing: false,
        actioning: false,
        pdfUrl: "/book/pdf/original",
      },
      global: { stubs: { SourceReviewPdfPage: true } },
    });

    expect(wrapper.text()).toContain("Paper A · 123B MD · 456B PDF");
    expect(wrapper.text()).toContain("无需重新选择");
    expect(wrapper.findAll(".file-drop-field")).toHaveLength(0);

    const replaceButton = wrapper.findAll("button").find((button) => button.text() === "更换输入");
    expect(replaceButton).toBeDefined();
    await replaceButton?.trigger("click");
    expect(wrapper.findAll(".file-drop-field")).toHaveLength(2);
    expect(wrapper.text()).not.toContain("书籍 ID");

    const cancelButton = wrapper.findAll("button").find((button) => button.text() === "取消更换");
    await cancelButton?.trigger("click");
    expect(wrapper.findAll(".file-drop-field")).toHaveLength(0);
  });
});
