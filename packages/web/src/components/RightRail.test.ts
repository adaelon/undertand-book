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
