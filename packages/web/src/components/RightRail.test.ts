// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import RightRail from "./RightRail.vue";

const baseProps = {
  chat: [],
  chatSessions: [],
  activeChatSessionId: "chat-1",
  agentInput: "",
  sending: false,
  showTrace: {},
  latestTrace: [],
  selectedLid: "1.1",
  selectedFormula: null,
  contextNotes: [],
  contextHighlights: [],
  renderMarkdown: (source: string) => source,
  effLabel: () => "effect",
  effState: () => undefined,
  isGoto: () => false,
  showEffectPrimary: () => false,
  showEffectSecondary: () => false,
  effectPrimaryLabel: () => "keep",
  effectSecondaryLabel: () => "undo",
  gotoBack: () => "1.1",
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function sourceOutcome(stale = false) {
  return {
    answer: "First claim. Next claim.",
    answer_view: {
      parts: [
        { kind: "markdown" as const, text: "First claim." },
        { kind: "sources" as const, source_ref_ids: ["source_ref_a"] },
        { kind: "markdown" as const, text: " Next claim." },
        { kind: "sources" as const, source_ref_ids: ["source_ref_a", "source_ref_b"] },
      ],
      sources: [
        { source_ref_id: "source_ref_a", label: "正文 · Methods" },
        { source_ref_id: "source_ref_b", label: "正文 · Results" },
      ],
    },
    incomplete: false,
    warning: null,
    turns: 3,
    tokens_spent: 12,
    effects: [{ kind: "Goto" as const, before_anchor: "1.1", after_anchor: "1.2" }],
    trace: [],
    profile_usage: {
      snapshot_revision: 0,
      injected_fact_ids: [],
      claimed_used_fact_ids: [],
      influences: [],
    },
    memory_updates: [],
    stale,
  };
}

describe("RightRail agent sources", () => {
  it("shows context shortage only for an actual context-budget warning", () => {
    const deliveryFailure = {
      ...sourceOutcome(),
      answer: "这次回答生成失败，请重试。",
      answer_view: undefined,
      incomplete: true,
      warning: null,
    };
    const contextBudget = {
      ...sourceOutcome(),
      answer: "Partial answer.",
      answer_view: undefined,
      incomplete: true,
      warning: "CONTEXT_BUDGET_EXCEEDED",
    };
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: {
        ...baseProps,
        askDraft: null,
        chat: [
          {
            turnId: "turn-delivery",
            user: "question one",
            outcome: deliveryFailure,
            pending: false,
            questionAnchorLid: null,
            questionQuote: null,
            questionSelection: null,
            effectLabels: [],
          },
          {
            turnId: "turn-budget",
            user: "question two",
            outcome: contextBudget,
            pending: false,
            questionAnchorLid: null,
            questionQuote: null,
            questionSelection: null,
            effectLabels: [],
          },
        ],
      },
    });

    expect(wrapper.text()).toContain("这次回答生成失败，请重试。");
    const notices = wrapper.findAll(".incomplete");
    expect(notices).toHaveLength(1);
    expect(notices[0].text()).toBe("未完成: 上下文不足");
  });

  it("renders inline single and grouped source buttons without visible LIDs", () => {
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: {
        ...baseProps,
        askDraft: null,
        chat: [{
          turnId: "turn-a",
          user: "question",
          outcome: sourceOutcome(),
          pending: false,
          questionAnchorLid: null,
          questionQuote: { label: "正文 · Introduction", quote: "quoted text", status: "resolved" },
          questionSelection: null,
          effectLabels: ["跳转 · 正文 · Results"],
        }],
      },
    });

    const buttons = wrapper.findAll(".agent-source-button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text()).toContain("正文 · Methods");
    expect(buttons[1].text()).toContain("2 个来源");
    expect(wrapper.get(".turn-quote-head").text()).toContain("正文 · Introduction");
    expect(wrapper.get(".proposal .prop-label").text()).toBe("跳转 · 正文 · Results");
    expect(wrapper.get(".agent-panel").text()).not.toContain("1.1");
    expect(wrapper.get(".agent-panel").text()).not.toContain("1.2");
  });

  it("resolves on first click and opens the reader only from the secondary action", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.endsWith("/agent/source.resolve")) {
        return new Response(JSON.stringify({
          source_ref_id: body.source_ref_id,
          label: "正文 · Methods",
          highlighted_quote: "exact evidence",
          context_before: "substantial context before",
          context_after: "substantial context after",
          stale: false,
          can_open_in_reader: true,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ source_ref_id: body.source_ref_id, opened: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: {
        ...baseProps,
        askDraft: null,
        chat: [{
          turnId: "turn-a",
          user: "question",
          outcome: sourceOutcome(),
          pending: false,
          questionAnchorLid: null,
          questionQuote: null,
          questionSelection: null,
          effectLabels: [],
        }],
      },
    });

    await wrapper.findAll(".agent-source-button")[0].trigger("click");
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/agent/source.resolve");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      turn_id: "turn-a",
      source_ref_id: "source_ref_a",
    });
    expect(document.body.querySelector(".agent-source-popup")?.textContent).toContain("exact evidence");
    expect(document.body.querySelector(".source-context-before")?.textContent).toContain("substantial context before");
    expect(wrapper.emitted("agent-source-opened")).toBeUndefined();

    const open = document.body.querySelector<HTMLButtonElement>(".source-open-reader")!;
    open.click();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/agent/source.open");
    expect(wrapper.emitted("agent-source-opened")).toHaveLength(1);
  });

  it("shows stale snapshots and disables reader navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      source_ref_id: "source_ref_a",
      label: "正文 · Methods",
      highlighted_quote: "saved preview",
      context_before: "",
      context_after: "",
      stale: true,
      can_open_in_reader: false,
    }), { status: 200 })));
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: {
        ...baseProps,
        askDraft: null,
        chat: [{
          turnId: "turn-a",
          user: "question",
          outcome: sourceOutcome(true),
          pending: false,
          questionAnchorLid: null,
          questionQuote: null,
          questionSelection: null,
          effectLabels: [],
        }],
      },
    });

    await wrapper.findAll(".agent-source-button")[0].trigger("click");
    await flushPromises();

    expect(document.body.querySelector(".source-stale")?.textContent).toContain("已失效");
    expect(document.body.querySelector<HTMLButtonElement>(".source-open-reader")?.disabled).toBe(true);
  });

  it("keeps the newest source click and ignores a superseded late resolve", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const responses = [first, second];
    vi.stubGlobal("fetch", vi.fn(() => responses.shift()!.promise));
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: {
        ...baseProps,
        askDraft: null,
        chat: [{
          turnId: "turn-a",
          user: "question",
          outcome: sourceOutcome(),
          pending: false,
          questionAnchorLid: null,
          questionQuote: null,
          questionSelection: null,
          effectLabels: [],
        }],
      },
    });

    const source = wrapper.findAll(".agent-source-button")[0];
    await source.trigger("click");
    await source.trigger("click");
    second.resolve(new Response(JSON.stringify({
      source_ref_id: "source_ref_a",
      label: "new source",
      highlighted_quote: "new evidence",
      context_before: "new before",
      context_after: "new after",
      stale: false,
      can_open_in_reader: true,
    }), { status: 200 }));
    await flushPromises();
    expect(document.body.querySelector(".agent-source-popup")?.textContent).toContain("new evidence");

    first.resolve(new Response(JSON.stringify({
      source_ref_id: "source_ref_a",
      label: "old source",
      highlighted_quote: "old evidence",
      context_before: "old before",
      context_after: "old after",
      stale: false,
      can_open_in_reader: true,
    }), { status: 200 }));
    await flushPromises();
    expect(document.body.querySelector(".agent-source-popup")?.textContent).toContain("new evidence");
    expect(document.body.querySelector(".agent-source-popup")?.textContent).not.toContain("old evidence");
  });

  it("does not restore a closed popup or emit navigation after a late open", async () => {
    const pendingOpen = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/agent/source.open")) return pendingOpen.promise;
      return new Response(JSON.stringify({
        source_ref_id: "source_ref_a",
        label: "source",
        highlighted_quote: "evidence",
        context_before: "before",
        context_after: "after",
        stale: false,
        can_open_in_reader: true,
      }), { status: 200 });
    }));
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: {
        ...baseProps,
        askDraft: null,
        chat: [{
          turnId: "turn-a",
          user: "question",
          outcome: sourceOutcome(),
          pending: false,
          questionAnchorLid: null,
          questionQuote: null,
          questionSelection: null,
          effectLabels: [],
        }],
      },
    });

    await wrapper.findAll(".agent-source-button")[0].trigger("click");
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>(".source-open-reader")!.click();
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('.source-popup-head button[aria-label="关闭来源"]')!.click();
    await flushPromises();
    pendingOpen.resolve(new Response(JSON.stringify({ source_ref_id: "source_ref_a", opened: true }), { status: 200 }));
    await flushPromises();

    expect(document.body.querySelector(".agent-source-popup")).toBeNull();
    expect(wrapper.emitted("agent-source-opened")).toBeUndefined();
  });
});

describe("RightRail AskQuote", () => {
  it("shows partial provenance while preserving the user-visible raw quote", async () => {
    const partial = {
      lid: "1.1",
      quote: "raw visible quote",
      status: "partial" as const,
      raw_quote: "raw visible quote",
      resolved_quote: "resolved quote",
      ranges: [{ lid: "1.1", range: { start: 1, end: 3 } }],
    };
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: { ...baseProps, askDraft: null },
    });
    await wrapper.setProps({ askDraft: partial });
    await flushPromises();
    expect(wrapper.get(".ask-draft").text()).toContain("部分定位");
    expect(wrapper.get(".ask-draft blockquote").text()).toBe("raw visible quote");
    expect(document.activeElement).toBe(wrapper.get("textarea").element);

    await wrapper.setProps({
      askDraft: null,
      chat: [{
        turnId: null,
        user: "question",
        outcome: null,
        pending: false,
        questionAnchorLid: "1.1",
        questionQuote: { label: "部分定位引用", quote: partial.quote, status: partial.status },
        questionSelection: partial,
        effectLabels: [],
      }],
    });
    expect(wrapper.get(".turn-quote").text()).toContain("部分定位");
    expect(wrapper.get(".turn-quote blockquote").text()).toBe("raw visible quote");
  });

  it("keeps legacy lid/quote drafts and sends only on explicit non-empty input", async () => {
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: { ...baseProps, askDraft: { lid: "1.1", quote: "legacy quote" } },
    });
    expect(wrapper.get(".ask-draft").text()).toContain("引用来源");
    expect(wrapper.get(".ask-draft").text()).not.toContain("部分定位");
    expect(wrapper.get(".agent-input > button").attributes()).toHaveProperty("disabled");
    await wrapper.get("textarea").setValue("question");
    await wrapper.setProps({ agentInput: "question" });
    await wrapper.get(".agent-input > button").trigger("click");
    expect(wrapper.emitted("send-agent")).toHaveLength(1);

    const app = readFileSync("src/App.vue", "utf8");
    expect(app).toContain("await api.agentChat(msg, {");
    expect(app).not.toContain("const outbound = draft");
    expect(app).toContain("question_quote: draft ? { ...draft } : null");
  });

  it("keeps profile updates quiet, undoable, and exposes usage only on demand", async () => {
    const profileMemory = {
      current_book_id: "book-a",
      status: {
        document_revision: 2,
        projection_revision: 2,
        profile_status: "current",
        pending_sensitive_confirmation: false,
        pending_review_jobs: 0,
        review_error: null,
      },
      snapshot: {
        source_revision: 2,
        profile_status: "current",
        global_core: [],
        applicable_global: [],
        book_state_core: [],
        profile_projection: [],
        pending_context: [],
      },
      facts: [],
      pending_candidates: [{
        fact_id: "fact-pending",
        scope_kind: "global",
        scope_value: null,
        applicability_kind: "any",
        applicability_value: null,
        payload_kind: "goal",
        payload_key: "reading",
        payload_value: "understand",
        source: "agent_inferred",
        capture: "current_interaction",
        status: "pending",
        sensitivity: "normal",
        evidence_ids: [],
        created_at: "t0",
        updated_at: "t0",
        valid_until: null,
        supersedes: [],
      }],
      evidence: [],
      collection_rules: [],
    };
    const memoryUpdate = {
      kind: "remembered" as const,
      operation_id: "op-1",
      fact_ids: ["fact-1"],
      message: null,
    };
    const wrapper = mount(RightRail, {
      attachTo: document.body,
      props: {
        ...baseProps,
        askDraft: null,
        profileMemory,
        chat: [{
          turnId: null,
          user: "remember this",
          pending: false,
          error: undefined,
          questionAnchorLid: "1.1",
          questionQuote: null,
          questionSelection: null,
          effectLabels: [],
          outcome: {
            answer: "done",
            incomplete: false,
            warning: null,
            turns: 1,
            tokens_spent: 3,
            effects: [],
            trace: [],
            profile_usage: {
              snapshot_revision: 2,
              injected_fact_ids: ["fact-1"],
              claimed_used_fact_ids: ["fact-1"],
              influences: ["explanation_depth"],
            },
            memory_updates: [memoryUpdate],
          },
        }],
      },
    });

    expect(wrapper.get(".memory-update-row").text()).toContain("画像已记住");
    expect(wrapper.get(".profile-usage").attributes()).not.toHaveProperty("open");
    expect(wrapper.get(".profile-usage summary").text()).toContain("画像依据 · 1");
    await wrapper.get('.memory-update-row button[aria-label="撤销画像更新"]').trigger("click");
    expect(wrapper.emitted("undo-profile-update")?.[0]).toEqual([0, 0, memoryUpdate]);

    const profileTab = wrapper.findAll(".tab").find((tab) => tab.text().includes("画像"));
    expect(profileTab?.text()).toContain("1");
    await profileTab!.trigger("click");
    expect(wrapper.emitted("refresh-profile")).toHaveLength(1);
    expect(wrapper.get(".profile-memory-panel").isVisible()).toBe(true);
  });

  it("renders persisted QueryAudit without placing it in the result digest", async () => {
    const audit = {
      budget_version: "referent-first-v1",
      model_calls: 2,
      request: {
        query: "command 是什么",
        intent: "definition" as const,
        targets: ["command"],
        obligations: [{ requirement: "给出定义" }],
        anchor_lid: "1.1",
      },
      plan_gate: { valid: true, missing_requirements: [], target_issues: [] },
      candidate_rounds: [{
        round: 0,
        targets: [{
          target_index: 0,
          target: "command",
          candidates: [{
            candidate_id: "entity:command",
            kind: "entity" as const,
            sources: ["graph" as const],
            labels: ["command"],
            aliases: [],
            recall_strength: "direct" as const,
            match_reasons: ["exact label"],
            occurrence_count: 1,
            excerpts: [{ lid: "1.1", text: "command source" }],
            hint_only: null,
          }],
        }],
      }],
      candidate_fits: [{
        round: 0,
        target_index: 0,
        candidate_id: "entity:command",
        fit: "direct_match",
        reason: "fixture",
      }],
      probes: [],
      bindings: [{
        target: "command",
        candidate_id: "entity:command",
        kind: "entity" as const,
        canonical_label: "command",
        source_lids: ["1.1"],
      }],
      selected_bindings: [{
        target_index: 0,
        candidate_id: "entity:command",
        round: 0,
        rank: 1,
      }],
      evidence: {
        seed_lids: ["1.1"],
        expansion_lids: [],
        expansion_rounds: 0,
        skipped_lids: [],
        chars_used: 14,
        mandatory_overflow_used: 0,
        mandatory_overflow_reasons: [],
      },
      assessments: [{
        obligation_index: 0,
        verdict: "supported" as const,
        citation_lids: ["1.1"],
        support_note: "source support",
      }],
      structural_gate: {
        bindings_complete: true,
        assessments_complete: true,
        citations_valid: true,
        all_obligations_supported: true,
      },
      outcome_status: "complete",
    };
    const wrapper = mount(RightRail, {
      props: {
        ...baseProps,
        askDraft: null,
        latestTrace: [{
          tool: "book.query",
          args: "typed request",
          result_digest: "complete response only",
          query_audit: audit,
        }],
      },
    });
    const traceTab = wrapper.findAll(".tab").find((tab) => tab.text().includes("轨迹"));
    await traceTab!.trigger("click");
    expect(wrapper.get(".trace-result").text()).toBe("complete response only");
    const panel = wrapper.get(".query-audit");
    expect(panel.text()).toContain("QueryAudit");
    await panel.get("summary").trigger("click");
    expect(panel.text()).toContain("entity:command");
    expect(panel.text()).toContain("seed: 1.1");
    expect(panel.text()).toContain("citations=true");
  });
});
