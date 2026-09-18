import { createApp, defineComponent, h, ref } from "vue";
import RightRail from "./components/RightRail.vue";
import { renderMarkdown } from "./md";
import "./style.css";
import { api } from "./api";

const fixture = await fetch("/api/fixture").then(response => response.json());
createApp(defineComponent({ setup() {
  const opened = ref(false);
  const followUp = ref("");
  return () => h("main", { style: "max-width:760px;margin:24px auto;padding:8px" }, [
    h("p", { "data-testid": "reader-status" }, opened.value ? "已在正文中打开来源" : "保持当前阅读位置"),
    h("p", { "data-testid": "follow-up-status" }, followUp.value),
    h(RightRail, {
      chat: [{ turnId: fixture.turn_id, user: "解释证据召回率", outcome: fixture.outcome, pending: false,
        questionAnchorLid: null, questionQuote: null, questionSelection: null, effectLabels: [] }],
      chatSessions: [], activeChatSessionId: fixture.session_id, agentInput: "", sending: false,
      showTrace: {}, latestTrace: [], selectedLid: null, selectedFormula: null, contextNotes: [], contextHighlights: [],
      renderMarkdown, effLabel: () => "", effState: () => undefined, isGoto: () => false,
      showEffectPrimary: () => false, showEffectSecondary: () => false, effectPrimaryLabel: () => "", effectSecondaryLabel: () => "", gotoBack: () => "", askDraft: null,
      onAgentSourceOpened: () => { opened.value = true; },
      onPresentationFollowUp: async (message: string, receipt: import("./generated/PresentationFollowUp").PresentationFollowUp) => {
        await api.agentChat(message, { presentation_follow_up: receipt });
        followUp.value = "追问已完成";
      },
    }),
  ]);
} })).mount("#app");
