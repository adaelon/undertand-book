// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
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
        user: "question",
        outcome: null,
        pending: false,
        questionAnchorLid: "1.1",
        questionQuote: partial,
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
          user: "remember this",
          pending: false,
          error: undefined,
          questionAnchorLid: "1.1",
          questionQuote: null,
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
});
