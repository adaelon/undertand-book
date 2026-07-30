// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { BuildIntentSelection, BuildIntentSelectionV1, BuildIntentSelectionV2 } from "../api";
import BuildIntentPane from "./BuildIntentPane.vue";

const digest = "a".repeat(64);

function selection(): BuildIntentSelectionV1 {
  return {
    version: "build_intent_selection.v1",
    mode: "goal_directed",
    intent: {
      version: "build_intent.v1",
      intent_id: "intent-001",
      revision: 1,
      book_id: "book-a",
      source_fingerprint: "source-a",
      content_profile: { id: "technical_learning", version: "technical_learning_v0" },
      user_goal: "比较两种方法",
      goal_kind: "compare",
      source_scope: { whole_book: false, lids: ["1.1"], sections: [] },
      desired_artifacts: ["comparison_table"],
      usage_horizon: "project",
      privacy: "reader_private",
      status: "draft",
      created_at: "2026-07-25T00:00:00.000Z",
    },
    intent_digest: "b".repeat(64),
    plan: {
      version: "build_plan.v1",
      plan_id: "plan-001",
      revision: 1,
      book_id: "book-a",
      source_fingerprint: "source-a",
      content_profile: { id: "technical_learning", version: "technical_learning_v0" },
      recipe_id: "goal_directed",
      intent_id: "intent-001",
      intent_digest: "b".repeat(64),
      public_stage_closure: ["pass1", "pass2"],
      private_artifacts: [{
        artifact_id: `artifact-${"long-name-".repeat(20)}`,
        artifact_type: "comparison_table",
        source_scope: { whole_book: false, lids: ["1.1"], sections: [] },
        required_public_capabilities: ["foundation.lid"],
        evidence_policy: "lid_required",
      }],
      reuse: [{ artifact: "public.foundation", freshness_digest: "c".repeat(64) }],
      create: ["public.pass1", "public.pass2", "private.comparison_table"],
      excluded: [{ artifact: "private.argument_map", reason: "not required by selected capabilities" }],
      estimate: {
        input_tokens: { lower: 1000, upper: 2400, coverage: 0.5 },
        output_tokens: { lower: 400, upper: 900, coverage: 0.5 },
        wall_clock_minutes: { confidence: "none" },
        unknown_stages: ["pass1", "private.comparison_table"],
        historical_match: { stage: false, policy: false, model: false, harness: false, sample_count: 0 },
      },
      budget: { on_exceed: "needs_user" },
      status: "draft",
      plan_digest: digest,
      created_at: "2026-07-25T00:00:00.000Z",
    },
    estimate_input: null,
    decision_request: {
      version: "build_decision_request.v2",
      decision_id: "decision-001",
      scope: { kind: "build_plan", plan_id: "plan-001", plan_digest: digest },
      kind: "build_intent_plan",
      options: [{ id: "confirm", label: "Confirm plan" }],
      status: "pending",
    },
  };
}

function blueprintSelection(): BuildIntentSelectionV2 {
  const current = selection();
  return {
    ...current,
    version: "build_intent_selection.v2",
    intent: {
      ...current.intent!,
      version: "build_intent.v2",
      goal_kind: "compare",
      source_scope: { whole_book: false, lids: ["1.1"], sections: [] },
      usage_horizon: "project",
    },
    plan: {
      ...current.plan!,
      version: "build_plan.v2",
      private_artifacts: [{
        artifact_id: "artifact-blueprint",
        source_scope: { whole_book: false, lids: ["1.1"], sections: [] },
        blueprint_digest: "d".repeat(64),
        required_public_capabilities: ["foundation.lid"],
        blueprint: {
          version: "artifact_blueprint.v1",
          blueprint_id: "system.comparison_table",
          blueprint_version: "1.0.0",
          origin: "system",
          title: "证据比较矩阵",
          purpose: "按共同维度比较实现策略。",
          shape: "table",
          record_schema: {
            type: "object",
            properties: { subject: {}, dimensions: {} },
            required: ["subject", "dimensions"],
            additional_properties: false,
            max_properties: 2,
          },
          routing: { use_when: ["比较"], avoid_when: [], covered_topics: ["实现"], scope_label: "当前范围" },
          search_fields: [{ path: "/subject", weight: 10, analyzer: "text" }],
          summary_fields: ["/subject"],
          evidence_policy: { required_per_record: true, anchor: "lid" },
          limits: { max_records: 120, max_relations: 0, max_text_chars: 24_000 },
        },
      }],
    },
  };
}

function mountPane(current: BuildIntentSelection | null = null) {
  return mount(BuildIntentPane, {
    props: { selection: current, busy: false, error: null },
  });
}

describe("BuildIntentPane", () => {
  it("starts in read-now mode without drafting, confirming, or requiring a model", async () => {
    const wrapper = mountPane();

    expect(wrapper.attributes("role")).toBe("complementary");
    expect(wrapper.text()).toContain("先阅读");
    expect(wrapper.text()).toContain("标准深读");
    expect(wrapper.text()).toContain("围绕目标");
    expect(wrapper.emitted()).toEqual({});

    await wrapper.get('[data-mode="read_now"]').trigger("click");
    await wrapper.get('[data-action="draft"]').trigger("click");
    expect(wrapper.emitted("draft")?.[0]?.[0]).toEqual({ mode: "read_now" });
    expect(wrapper.find('[data-action="confirm"]').exists()).toBe(false);
  });

  it("uses a two-step goal draft and binds confirmation to the exact current digest", async () => {
    const wrapper = mountPane(selection());

    expect(wrapper.text()).toContain("比较表");
    expect(wrapper.text()).toContain("段落理解");
    expect(wrapper.text()).toContain("2 项暂无历史样本");
    expect(wrapper.text()).not.toContain("pass1");

    await wrapper.get('[data-action="confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]?.[0]).toEqual({
      plan_id: "plan-001",
      plan_digest: digest,
    });

    await wrapper.get("textarea").setValue("改为梳理论证链");
    expect(wrapper.get('[data-action="confirm"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[data-action="draft"]').trigger("click");
    expect(wrapper.emitted("draft")?.at(-1)?.[0]).toEqual({
      mode: "goal_directed",
      user_goal: "改为梳理论证链",
      edit_plan_id: "plan-001",
    });
  });

  it("keeps long artifact identity in a bounded wrapping surface and can reject or close", async () => {
    const wrapper = mountPane(selection());
    const artifact = wrapper.get(".artifact-row");
    expect(artifact.attributes("title")).toContain("artifact-long-name");
    expect(wrapper.find(".pane-scroll").exists()).toBe(true);

    await wrapper.get('[data-action="reject"]').trigger("click");
    await wrapper.get('[data-action="close"]').trigger("click");
    expect(wrapper.emitted("reject")?.[0]?.[0]).toEqual({ plan_id: "plan-001" });
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("summarizes a V2 Blueprint without exposing raw schema JSON", () => {
    const wrapper = mountPane(blueprintSelection());
    expect(wrapper.text()).toContain("证据比较矩阵");
    expect(wrapper.text()).toContain("按共同维度比较实现策略");
    expect(wrapper.text()).toContain("表格");
    expect(wrapper.text()).toContain("subject、dimensions");
    expect(wrapper.text()).toContain("系统预设");
    expect(wrapper.text()).toContain("最多 120 条记录");
    expect(wrapper.text()).toContain("24,000 字符");
    expect(wrapper.text()).not.toContain("additional_properties");
  });
});
