import { createApp, defineComponent, h, ref } from "vue";
import type { AgentEffect, OuterOutcome } from "./api";
import { renderMarkdown } from "./md";
import RightRail from "./components/RightRail.vue";
import "./style.css";
import "./agent-source-visual.css";

if (new URLSearchParams(window.location.search).get("standalone") === "1") {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/agent/source.resolve")) {
      const request = JSON.parse(String(init?.body ?? "{}")) as { source_ref_id: string };
      const label = request.source_ref_id === "source_ref_methods"
        ? "正文 · Materials and Methods"
        : request.source_ref_id === "source_ref_cohort"
          ? "正文 · Validation cohort"
          : "正文 · Results";
      return new Response(JSON.stringify({
        source_ref_id: request.source_ref_id,
        label,
        highlighted_quote: "剪接调控显著改变了疾病相关转录本的构成。",
        context_before: "在心肌组织中，选择性剪接受到多层调控。研究团队在严格控制批次效应后比较了多个样本，并以相同分析流程验证候选事件。",
        context_after: "这些变化随后在独立队列中得到复核，同时结合功能实验评估其与疾病通路的关系。连续上下文保留了实验条件、比较对象和结论边界。",
        stale: false,
        can_open_in_reader: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/agent/source.open")) {
      const request = JSON.parse(String(init?.body ?? "{}")) as { source_ref_id: string };
      return new Response(JSON.stringify({ source_ref_id: request.source_ref_id, opened: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return nativeFetch(input, init);
  };
}

const outcome: OuterOutcome = {
  answer: "剪接调控会改变心肌细胞的转录本构成，并影响疾病相关通路。不同实验队列提供了相互补充的证据。",
  answer_view: {
    parts: [
      { kind: "markdown", text: "剪接调控会改变心肌细胞的转录本构成，并影响疾病相关通路。" },
      { kind: "sources", source_ref_ids: ["source_ref_methods"] },
      { kind: "markdown", text: "不同实验队列提供了相互补充的证据。" },
      { kind: "sources", source_ref_ids: ["source_ref_results", "source_ref_cohort"] },
    ],
    sources: [
      { source_ref_id: "source_ref_methods", label: "正文 · Materials and Methods" },
      { source_ref_id: "source_ref_results", label: "正文 · Results" },
      { source_ref_id: "source_ref_cohort", label: "正文 · Validation cohort" },
    ],
  },
  incomplete: false,
  warning: null,
  turns: 3,
  tokens_spent: 32,
  effects: [{ kind: "Goto", before_anchor: "1.1", after_anchor: "1.2" }],
  trace: [],
  profile_usage: {
    snapshot_revision: 0,
    injected_fact_ids: [],
    claimed_used_fact_ids: [],
    influences: [],
  },
  memory_updates: [],
};

const VisualHarness = defineComponent({
  setup() {
    const readerStatus = ref("保持当前阅读位置");
    const agentInput = ref("");
    const effect = outcome.effects[0] as AgentEffect;
    return () => h("main", { class: "agent-source-visual" }, [
      h("article", { class: "agent-source-reader", "data-testid": "reader-surface" }, [
        h("span", { class: "reader-kicker" }, "CURRENT READING"),
        h("h1", "Cardiac splicing as a diagnostic and therapeutic target"),
        h("p", "The reader remains stable while source evidence is inspected in the conversation panel."),
        h("strong", { "data-testid": "reader-status" }, readerStatus.value),
      ]),
      h(RightRail, {
        chat: [{
          turnId: "turn-source-visual",
          user: "这些结论在原文中的依据是什么？",
          outcome,
          pending: false,
          questionAnchorLid: null,
          questionQuote: {
            label: "正文 · Introduction",
            quote: "Alternative splicing is a regulated process in cardiac tissue.",
            status: "resolved",
          },
          questionSelection: null,
          effectLabels: ["跳转 · 正文 · Results"],
        }],
        chatSessions: [],
        activeChatSessionId: "chat-source-visual",
        agentInput: agentInput.value,
        sending: false,
        showTrace: {},
        latestTrace: [],
        selectedLid: null,
        selectedFormula: null,
        contextNotes: [],
        contextHighlights: [],
        renderMarkdown,
        effLabel: () => "跳转",
        effState: () => undefined,
        isGoto: (candidate: AgentEffect) => candidate.kind === "Goto",
        showEffectPrimary: () => false,
        showEffectSecondary: () => false,
        effectPrimaryLabel: () => "",
        effectSecondaryLabel: () => "",
        gotoBack: () => "",
        askDraft: null,
        "onUpdate:agentInput": (value: string) => { agentInput.value = value; },
        onAgentSourceOpened: () => { readerStatus.value = "已在正文中打开来源"; },
        onUndoEffect: () => { void effect; },
      }),
    ]);
  },
});

createApp(VisualHarness).mount("#app");
