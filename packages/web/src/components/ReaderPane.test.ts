// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
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

  it("scrolls an explicit outline navigation target to the pane top", async () => {
    const wrapper = mount(ReaderPane, {
      props: {
        segments: [
          segment("1.1", "paragraph"),
          segment("1.2", "paragraph"),
          segment("1.3", "paragraph"),
        ],
        viewportAnchor: "1.1",
        selectedLid: "1.1",
        renderSeg: (value) => value.text,
        renderMarkdown: (source) => source,
        markdownHeadingLevel: () => null,
        isAsset: () => false,
        isHighlighted: () => false,
        highlightsOf: () => [],
        highlightCardsOf: () => [],
        visibleNotes: [],
        hlExcerpt: () => "",
        imageMeta: () => null,
        imageAsset: () => null,
      },
    });
    const pane = wrapper.get(".reader-pane").element as HTMLElement;
    const target = wrapper.get('[data-lid="1.2"]').element as HTMLElement;
    pane.scrollTop = 180;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 100, top: 100, bottom: 500, left: 0, right: 600,
      width: 600, height: 400, toJSON: () => ({}),
    });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 340, top: 340, bottom: 380, left: 0, right: 600,
      width: 600, height: 40, toJSON: () => ({}),
    });

    const exposed = wrapper.vm as unknown as {
      scrollLidIntoView?: (lid: string) => Promise<boolean>;
    };
    expect(exposed.scrollLidIntoView).toBeTypeOf("function");
    await exposed.scrollLidIntoView!("1.2");
    expect(pane.scrollTop).toBe(420);

    const appSource = readFileSync("src/App.vue", "utf8");
    expect(appSource).toContain("await readerPaneRef.value?.scrollLidIntoView(navigationTargetLid)");
    await wrapper.get(".reader-pane").trigger("wheel", { deltaY: 40 });
    expect(wrapper.emitted("viewport-interaction")).toHaveLength(1);
    wrapper.unmount();
  });
});
