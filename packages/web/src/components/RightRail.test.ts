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
});
