// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../api";
import ReaderPane, { type Segment } from "./ReaderPane.vue";

function segment(lid: string, kind: Segment["kind"]): Segment {
  return { lid, kind, text: `text-${lid}`, formula: null, imageAsset: null };
}

function note(memId: string, lid: string, content: string): MemoryRecord {
  return {
    mem_id: memId,
    type: "note",
    layer: "long_term",
    book_id: "book-a",
    anchor: { lid },
    content,
  };
}

describe("ReaderPane Note rendering", () => {
  it("keeps flow and single notes behaviorally identical", async () => {
    const short = note("note-short", "1.1", "> quoted source\n\nShort **body**");
    const long = note("note-long", "2.1", `> long source\n\n${"x".repeat(400)}`);
    const renderMarkdown = vi.fn((source: string) => `<p data-markdown>${source}</p>`);
    const wrapper = mount(ReaderPane, {
      props: {
        segments: [segment("1.1", "paragraph"), segment("2.1", "section")],
        viewportAnchor: null,
        selectedLid: null,
        renderSeg: (value) => value.text,
        renderMarkdown,
        markdownHeadingLevel: () => null,
        isAsset: () => false,
        isHighlighted: () => false,
        highlightsOf: () => [],
        highlightCardsOf: () => [],
        visibleNotes: [short, long],
        hlExcerpt: () => "",
        imageMeta: () => null,
        imageAsset: () => null,
      },
    });

    const cards = wrapper.findAll(".note-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].attributes()).toHaveProperty("open");
    expect(cards[1].attributes()).not.toHaveProperty("open");
    expect(cards[0].get(".note-source").text()).toBe("引用来源");
    expect(cards[1].get(".note-source").text()).toBe("引用来源");
    expect(cards[0].find(".note-preview").exists()).toBe(false);
    expect(cards[1].get(".note-preview").text()).toContain("x".repeat(40));
    expect(cards[1].get(".note-preview").text()).not.toContain("long source");
    expect(cards[0].get(".note-md").html()).toContain("Short **body**");

    await cards[0].get(".note-source").trigger("click");
    await cards[0].get('button[title="编辑"]').trigger("click");
    await cards[0].get('button[title="删除"]').trigger("click");
    expect(wrapper.emitted("focus-source-local")?.at(-1)).toEqual([
      { lid: "1.1", quote: "quoted source" },
    ]);
    expect(wrapper.emitted("edit-note")?.at(-1)).toEqual([short]);
    expect(wrapper.emitted("delete-note")?.at(-1)).toEqual([short]);
    expect(renderMarkdown).toHaveBeenCalledWith(short.content);
    expect(renderMarkdown).toHaveBeenCalledWith(long.content);

    wrapper.unmount();
  });
});
