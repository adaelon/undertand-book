// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HistoricalBackfillStateView,
  ProfileGovernanceActionRequest,
  ProfileMemoryState,
} from "../api";
import ProfileMemoryPanel from "./ProfileMemoryPanel.vue";

function profileState(): ProfileMemoryState {
  return {
    current_book_id: "book-a",
    status: {
      document_revision: 9,
      projection_revision: 7,
      profile_status: "current",
      pending_sensitive_confirmation: true,
      pending_review_jobs: 2,
      review_error: null,
    },
    snapshot: {
      source_revision: 7,
      profile_status: "current",
      global_core: [],
      applicable_global: [],
      book_state_core: [],
      profile_projection: [],
      pending_context: [],
    },
    facts: [
      {
        fact_id: "fact-book",
        scope_kind: "book",
        scope_value: "book-a",
        applicability_kind: "any",
        applicability_value: null,
        payload_kind: "explanation_preference",
        payload_key: "depth",
        payload_value: "详细解释",
        source: "user_stated",
        capture: "current_interaction",
        status: "confirmed",
        sensitivity: "normal",
        evidence_ids: ["evidence-book"],
        created_at: "t0",
        updated_at: "t0",
        valid_until: null,
        supersedes: [],
      },
      {
        fact_id: "fact-global",
        scope_kind: "global",
        scope_value: null,
        applicability_kind: "any",
        applicability_value: null,
        payload_kind: "goal",
        payload_key: "reading",
        payload_value: "理解核心论证",
        source: "user_stated",
        capture: "current_interaction",
        status: "confirmed",
        sensitivity: "normal",
        evidence_ids: [],
        created_at: "t1",
        updated_at: "t1",
        valid_until: null,
        supersedes: [],
      },
      {
        fact_id: "fact-old",
        scope_kind: "book",
        scope_value: "book-a",
        applicability_kind: "any",
        applicability_value: null,
        payload_kind: "explanation_preference",
        payload_key: "depth",
        payload_value: "简短解释",
        source: "user_stated",
        capture: "current_interaction",
        status: "superseded",
        sensitivity: "normal",
        evidence_ids: [],
        created_at: "t-1",
        updated_at: "t0",
        valid_until: null,
        supersedes: [],
      },
    ],
    pending_candidates: [{
      fact_id: "fact-pending",
      scope_kind: "global",
      scope_value: null,
      applicability_kind: "any",
      applicability_value: null,
      payload_kind: "capability",
      payload_key: "statistics",
      payload_value: "熟悉统计推断",
      source: "agent_inferred",
      capture: "current_interaction",
      status: "pending",
      sensitivity: "normal",
      evidence_ids: ["evidence-pending"],
      created_at: "t2",
      updated_at: "t2",
      valid_until: null,
      supersedes: [],
    }],
    evidence: [
      {
        fact_id: "fact-book",
        evidence_id: "evidence-book",
        kind: "memory_record",
        session_id: null,
        turn_id: null,
        mem_id: "mem-1",
        book_id: null,
        lid: null,
        text: "请给我更详细的解释",
      },
      {
        fact_id: "fact-pending",
        evidence_id: "evidence-pending",
        kind: "book_location",
        session_id: null,
        turn_id: null,
        mem_id: null,
        book_id: "book-a",
        lid: "2.1",
        text: null,
      },
    ],
    collection_rules: [{
      rule_id: "rule-1",
      payload_kind: "goal",
      semantic_key: "goal:reading",
      scope_kind: "global",
      scope_value: null,
      applicability_kind: null,
      applicability_value: null,
      created_at: "t3",
    }],
  };
}

function actions(wrapper: ReturnType<typeof mount>): ProfileGovernanceActionRequest[] {
  return (wrapper.emitted("mutate") ?? []).map((args) => args[0] as ProfileGovernanceActionRequest);
}

function backfillState(): HistoricalBackfillStateView {
  return {
    sessions: [
      {
        session_id: "session-a",
        book_id: "book-a",
        title: "概念梳理",
        latest_user_turn_ordinal: 3,
        created_at: "t0",
        updated_at: "t1",
      },
      {
        session_id: "session-b",
        book_id: "book-a",
        title: "推导复盘",
        latest_user_turn_ordinal: 6,
        created_at: "t2",
        updated_at: "t3",
      },
    ],
    jobs: [
      {
        job_id: "job-running",
        session_id: "session-a",
        book_id: "book-a",
        from_turn_exclusive: 0,
        to_turn_inclusive: 3,
        processed_through: 1,
        completed_turns: 1,
        total_turns: 3,
        status: "running",
        attempts: 1,
        candidate_fact_ids: ["fact-pending"],
        last_error: null,
        created_at: "t4",
        updated_at: "t5",
      },
      {
        job_id: "job-retryable",
        session_id: "session-b",
        book_id: "book-a",
        from_turn_exclusive: 1,
        to_turn_inclusive: 5,
        processed_through: 3,
        completed_turns: 2,
        total_turns: 4,
        status: "retryable",
        attempts: 2,
        candidate_fact_ids: [],
        last_error: {
          error_code: "PROVIDER_FAILED",
          message: "模型暂不可用",
          occurred_at: "t6",
        },
        created_at: "t4",
        updated_at: "t6",
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("ProfileMemoryPanel", () => {
  it("centralizes pending review, evidence, status, and sensitive confirmation", async () => {
    const wrapper = mount(ProfileMemoryPanel, {
      attachTo: document.body,
      props: { state: profileState() },
    });

    expect(wrapper.get(".profile-status-row").text()).toContain("后台整理 2");
    expect(wrapper.get(".pending-section").text()).toContain("熟悉统计推断");
    expect(wrapper.get(".sensitive-confirmation").text()).toContain("敏感画像等待确认");

    await wrapper.get(".sensitive-confirmation button").trigger("click");
    expect(wrapper.emitted("confirm-sensitive")).toHaveLength(1);

    const pendingButtons = wrapper.findAll(".pending-actions button");
    await pendingButtons[0].trigger("click");
    await pendingButtons[1].trigger("click");
    expect(actions(wrapper).map((action) => action.kind)).toEqual(["confirm", "reject"]);
    expect(actions(wrapper)[0]).toMatchObject({ fact_id: "fact-pending" });

    await wrapper.get(".pending-fact .evidence-link").trigger("click");
    expect(wrapper.emitted("goto")?.[0]).toEqual(["2.1"]);

    await wrapper.get('button[aria-label="刷新画像"]').trigger("click");
    expect(wrapper.emitted("refresh")).toHaveLength(1);
  });

  it("emits correction, scope, collection-rule, forget, and rule-removal actions", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(ProfileMemoryPanel, {
      attachTo: document.body,
      props: { state: profileState() },
    });

    await wrapper.get('button[aria-label="纠正"]').trigger("click");
    await wrapper.get(".fact-editor textarea").setValue("先给结论，再展开细节");
    await wrapper.get(".fact-editor button").trigger("click");
    expect(actions(wrapper).at(-1)).toMatchObject({
      kind: "correct",
      fact_id: "fact-book",
      payload_value: "先给结论，再展开细节",
    });

    await wrapper.get('button[aria-label="改为全局"]').trigger("click");
    expect(actions(wrapper).at(-1)).toMatchObject({
      kind: "change_scope",
      fact_id: "fact-book",
      scope_kind: "global",
    });

    await wrapper.get('button[aria-label="不再自动收集同类信息"]').trigger("click");
    expect(actions(wrapper).at(-1)).toMatchObject({
      kind: "add_collection_rule",
      matcher: {
        semantic_key: "explanation_preference:depth",
        scope_kind: "book",
        scope_value: "book-a",
      },
    });

    await wrapper.get('button[aria-label="忘记"]').trigger("click");
    expect(actions(wrapper).at(-1)).toMatchObject({ kind: "forget", fact_id: "fact-book" });

    await wrapper.get('button[aria-label="移除规则"]').trigger("click");
    expect(actions(wrapper).at(-1)).toMatchObject({ kind: "remove_collection_rule", rule_id: "rule-1" });
  });

  it("switches between current-book and global facts and keeps errors in-panel", async () => {
    const state = profileState();
    state.status.profile_status = "stale";
    state.status.review_error = {
      error_code: "REVIEW_FAILED",
      message: "后台整理失败",
      occurred_at: "t4",
    };
    const wrapper = mount(ProfileMemoryPanel, {
      props: { state, error: "画像已更新，请重试" },
    });

    expect(wrapper.get(".profile-fact-card").text()).toContain("详细解释");
    const globalTab = wrapper.findAll(".scope-tabs button").find((button) => button.text().includes("全局"));
    expect(globalTab).toBeTruthy();
    await globalTab!.trigger("click");
    expect(wrapper.get(".profile-fact-card").text()).toContain("理解核心论证");
    expect(wrapper.findAll('[role="alert"]').map((node) => node.text())).toEqual([
      "画像已更新，请重试",
      "后台整理失败",
    ]);
    expect(wrapper.get('.profile-status[data-status="stale"]').text()).toBe("待刷新");
  });

  it("starts and governs explicit historical backfill without changing automatic memory", async () => {
    const state = profileState();
    state.pending_candidates[0].capture = "historical_backfill";
    const wrapper = mount(ProfileMemoryPanel, {
      props: { state, backfill: backfillState() },
    });

    expect(wrapper.get(".pending-fact small").text()).toContain("历史回填");
    await wrapper.get(".backfill-session-field select").setValue("session-b");
    const rangeInputs = wrapper.findAll(".backfill-range input");
    await rangeInputs[0].setValue(2);
    await rangeInputs[1].setValue(5);
    await wrapper.get(".backfill-form").trigger("submit");
    expect(wrapper.emitted("backfill-start")?.[0]).toEqual([{
      session_id: "session-b",
      from_turn_exclusive: 1,
      to_turn_inclusive: 5,
    }]);

    await wrapper.get('button[aria-label="中止历史回填"]').trigger("click");
    await wrapper.get('button[aria-label="继续历史回填"]').trigger("click");
    await wrapper.get('button[aria-label="清除回填任务与未确认候选"]').trigger("click");
    expect(wrapper.emitted("backfill-action")).toEqual([
      ["cancel", { job_id: "job-running" }],
      ["retry", { job_id: "job-retryable" }],
      ["clear", { job_id: "job-retryable" }],
    ]);
  });
});
