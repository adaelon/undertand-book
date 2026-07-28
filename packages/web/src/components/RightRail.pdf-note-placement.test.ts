// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import RightRail from "./RightRail.vue";

const baseProps = {
  chat: [],
  chatSessions: [],
  activeChatSessionId: "chat-1",
  agentInput: "",
  sending: false,
  unquotedNotePlacementAvailable: true,
  notePlacementSurface: "pdf" as const,
  noteSourceFingerprint: "a".repeat(64),
  askDraft: null,
  showTrace: {},
  latestTrace: [],
  selectedLid: "1.1",
  selectedFormula: null,
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

function note(memId: string, overrides: Record<string, unknown> = {}) {
  return {
    mem_id: memId,
    type: "note",
    layer: "long_term",
    book_id: "paper-a",
    anchor: { lid: "1.1", concept: null },
    content: `${memId} body`,
    ...overrides,
  };
}

const pdfPlacement = {
  kind: "pdf_region" as const,
  source_fingerprint: "a".repeat(64),
  lid: "1.1",
  source_map_version: "pdf_source_map.v1" as const,
  source_map_config_hash: "cfg-v1",
  page_index: 0,
  region_id: "word-1",
};

describe("RightRail PDF Note placement actions", () => {
  it("offers same-format move/re-place and legacy placement but excludes Markdown and selection Notes", async () => {
    const current = note("pdf-current", { note_placement: pdfPlacement });
    const stale = note("pdf-stale", { note_placement: { ...pdfPlacement, source_map_config_hash: "cfg-old" } });
    const legacy = note("legacy");
    const markdown = note("markdown", {
      note_placement: { kind: "lid_block", source_fingerprint: "a".repeat(64), lid: "1.1" },
    });
    const selected = note("selected", {
      selection_context: { status: "resolved", raw_quote: "x", resolved_quote: "x", ranges: [] },
    });
    const wrapper = mount(RightRail, {
      props: {
        ...baseProps,
        contextNotes: [current, stale, legacy, markdown, selected],
        annotationLocation: { "pdf-current": "exact", "pdf-stale": "unmapped" },
      },
    });

    await wrapper.findAll("button.tab").find((button) => button.text().includes("笔记"))!.trigger("click");
    const actions = wrapper.findAll("[data-note-placement-action]");
    expect(actions.map((button) => button.attributes("data-mem-id")))
      .toEqual(["pdf-current", "pdf-stale", "legacy"]);
    expect(actions.map((button) => button.text())).toEqual(["移动", "重新放置", "放置到正文"]);
    await actions[0].trigger("click");
    expect(wrapper.emitted("place-note")?.[0]).toEqual([current]);
    expect(wrapper.find('[data-mem-id="pdf-current"] code').text()).toBe("PDF 正文");
    expect(wrapper.find('[data-mem-id="pdf-stale"] code').text()).toBe("无法定位");
  });
});
