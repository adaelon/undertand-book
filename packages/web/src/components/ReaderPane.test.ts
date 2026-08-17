// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function readerProps(segments: Segment[]) {
  return {
    segments,
    viewportAnchor: null,
    selectedLid: null,
    renderSeg: (value: Segment) => value.text,
    renderMarkdown: (source: string) => source,
    markdownHeadingLevel: () => null,
    isAsset: (value: Segment) => value.kind === "code" || value.kind === "table" || value.kind === "image",
    isHighlighted: () => false,
    highlightsOf: () => [],
    highlightCardsOf: () => [],
    visibleNotes: [],
    hlExcerpt: () => "",
    imageMeta: () => null,
    imageAsset: () => null,
  };
}

function domRect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 600,
    width: 600,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function installAnimationFrameHarness() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));
  return {
    flush(timestamp = 16) {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(timestamp);
    },
  };
}

interface MockObserverRecord {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit;
  targets: Set<Element>;
  observeCalls: Element[];
  unobserveCalls: Element[];
  trigger: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
}

interface MockResizeObserverRecord {
  targets: Set<Element>;
  trigger: (entries: Array<{ target: Element; blockSize: number }>) => void;
}

function installResizeObserverHarness(): MockResizeObserverRecord[] {
  const records: MockResizeObserverRecord[] = [];
  class MockResizeObserver {
    private readonly record: MockResizeObserverRecord;

    constructor(callback: ResizeObserverCallback) {
      const targets = new Set<Element>();
      this.record = {
        targets,
        trigger: (entries) => callback(entries.map(({ target, blockSize }) => ({
          target,
          contentRect: domRect(0, blockSize),
          borderBoxSize: [{ blockSize, inlineSize: 600 }],
          contentBoxSize: [{ blockSize, inlineSize: 600 }],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry)), this as unknown as ResizeObserver),
      };
      records.push(this.record);
    }

    observe(target: Element) {
      this.record.targets.add(target);
    }

    unobserve(target: Element) {
      this.record.targets.delete(target);
    }

    disconnect() {
      this.record.targets.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  return records;
}

function installIntersectionObserverHarness(): MockObserverRecord[] {
  const records: MockObserverRecord[] = [];
  class MockIntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: readonly number[];
    private readonly record: MockObserverRecord;

    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.root = options.root ?? null;
      this.rootMargin = options.rootMargin ?? "0px";
      this.thresholds = Array.isArray(options.threshold)
        ? options.threshold
        : [options.threshold ?? 0];
      const targets = new Set<Element>();
      const observeCalls: Element[] = [];
      const unobserveCalls: Element[] = [];
      this.record = {
        callback,
        options,
        targets,
        observeCalls,
        unobserveCalls,
        trigger: (entries) => callback(entries.map(({ target, isIntersecting }) => ({
          time: 0,
          target,
          rootBounds: null,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: isIntersecting ? target.getBoundingClientRect() : domRect(0, 0),
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        } as IntersectionObserverEntry)), this as unknown as IntersectionObserver),
      };
      records.push(this.record);
    }

    observe(target: Element) {
      this.record.targets.add(target);
      this.record.observeCalls.push(target);
    }

    unobserve(target: Element) {
      this.record.targets.delete(target);
      this.record.unobserveCalls.push(target);
    }

    disconnect() {
      this.record.targets.clear();
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  return records;
}

async function settleObserverSetup() {
  await nextTick();
  await nextTick();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReaderPane Note rendering", () => {
  it("keeps passive anchor and selected states visually neutral", () => {
    const styles = readFileSync("src/style.css", "utf8");

    expect(styles).not.toContain(".prose p.anchor");
    expect(styles).not.toContain(".prose p.selected");
    expect(styles).not.toContain(".flow-text.anchor");
    expect(styles).not.toContain(".flow-text.selected");
    expect(styles).toContain(".prose p.hl");
    expect(styles).toContain(".flow-text.hl");
  });

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
    const currentLidEmits = wrapper.emitted("current-lid")?.length ?? 0;
    await exposed.scrollLidIntoView!("1.2");
    expect(wrapper.emitted("current-lid")).toHaveLength(currentLidEmits);

    const appSource = readFileSync("src/App.vue", "utf8");
    expect(appSource).toContain("await readerPaneRef.value?.scrollLidIntoView(navigationTargetLid)");
    await wrapper.get(".reader-pane").trigger("wheel", { deltaY: 40 });
    expect(wrapper.emitted("viewport-interaction")).toHaveLength(1);
    wrapper.unmount();
  });

  it("emits placement input only from Pointer Events while placement is active", async () => {
    const wrapper = mount(ReaderPane, {
      props: {
        segments: [segment("1.1", "paragraph")],
        viewportAnchor: null,
        selectedLid: null,
        notePlacementActive: false,
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

    await wrapper.get('[data-lid="1.1"]').trigger("pointerup");
    expect(wrapper.emitted("note-placement-pointer")).toBeUndefined();

    await wrapper.setProps({ notePlacementActive: true });
    await wrapper.get('[data-lid="1.1"]').trigger("pointerup");
    expect(wrapper.emitted("note-placement-pointer")).toHaveLength(1);
    expect(wrapper.emitted("note-placement-target")?.at(-1)).toEqual([{ lid: "1.1" }]);
    wrapper.unmount();
  });

  it("previews and submits a real target at 390px while rejecting toolbar controls", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    const wrapper = mount(ReaderPane, {
      props: {
        segments: [segment("1.1", "paragraph")],
        viewportAnchor: null,
        selectedLid: "1.1",
        notePlacementActive: true,
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
    const body = wrapper.get('[data-lid="1.1"]');

    await body.trigger("pointermove", { pointerType: "touch" });
    expect(body.classes()).toContain("note-placement-candidate");
    await body.trigger("pointerup", { pointerType: "touch" });
    expect(wrapper.emitted("note-placement-target")?.at(-1)).toEqual([{ lid: "1.1" }]);

    const action = wrapper.get(".block-actions button");
    await action.trigger("pointermove", { pointerType: "touch" });
    expect(body.classes()).not.toContain("note-placement-candidate");
    await action.trigger("pointerup", { pointerType: "touch" });
    expect(wrapper.emitted("note-placement-invalid")).toHaveLength(1);
    wrapper.unmount();
  });
});

describe("ReaderPane PHR5 stable segment rendering", () => {
  it("stages incoming segments locally and renders only each new LID", async () => {
    const base = [segment("1.1", "section"), segment("1.2", "section")];
    const incoming = [segment("1.3", "section"), segment("1.4", "section")];
    const renderSeg = vi.fn((value: Segment) => `<span>${value.text}</span>`);
    const wrapper = mount(ReaderPane, {
      props: {
        ...readerProps(base),
        renderSeg,
      },
    });
    const exposed = wrapper.vm as unknown as {
      beginSegmentStage: (segments: Segment[], direction: "up" | "down") => boolean;
      stageSegment: (segment: Segment) => boolean;
      finishSegmentStage: (bufferRange: readonly [number, number] | null) => void;
    };
    renderSeg.mockClear();

    expect(exposed.beginSegmentStage(base, "down")).toBe(true);
    expect(exposed.stageSegment(incoming[0])).toBe(true);
    await nextTick();
    expect(wrapper.findAll("[data-lid]").map((node) => node.attributes("data-lid")))
      .toEqual(["1.1", "1.2", "1.3"]);
    expect(renderSeg).toHaveBeenCalledTimes(1);
    expect(renderSeg).toHaveBeenLastCalledWith(incoming[0]);

    expect(exposed.stageSegment(incoming[1])).toBe(true);
    await nextTick();
    expect(renderSeg).toHaveBeenCalledTimes(2);
    expect(renderSeg).toHaveBeenLastCalledWith(incoming[1]);

    base.splice(base.length, 0, ...incoming);
    exposed.finishSegmentStage([0, 4]);
    await nextTick();
    expect(wrapper.findAll("[data-lid]").map((node) => node.attributes("data-lid")))
      .toEqual(["1.1", "1.2", "1.3", "1.4"]);
    expect(renderSeg).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("does not re-run Markdown rendering for anchor, selection, or Note-only updates", async () => {
    const segments = [
      segment("1.1", "paragraph"),
      segment("1.2", "formula"),
      segment("1.3", "section"),
    ];
    const renderSeg = vi.fn((value: Segment) => `<span>${value.text}</span>`);
    const wrapper = mount(ReaderPane, {
      props: {
        ...readerProps(segments),
        renderSeg,
      },
    });

    expect(renderSeg).toHaveBeenCalledTimes(segments.length);
    renderSeg.mockClear();

    await wrapper.setProps({ viewportAnchor: "1.2" });
    await wrapper.setProps({ selectedLid: "1.3" });
    await wrapper.setProps({ visibleNotes: [note("note-1.1", "1.1", "Note-only update")] });

    expect(wrapper.get('[data-lid="1.2"]').classes()).toContain("anchor");
    expect(wrapper.get('[data-lid="1.3"]').classes()).toContain("selected");
    expect(wrapper.findAll(".note-card")).toHaveLength(1);
    expect(renderSeg).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("re-renders only the segment whose explicit HTML revision changes", async () => {
    const segments = [segment("1.1", "paragraph"), segment("1.2", "section")];
    const renderSeg = vi.fn((value: Segment) => `<span>${value.text}</span>`);
    const wrapper = mount(ReaderPane, {
      props: {
        ...readerProps(segments),
        renderSeg,
        renderRevisions: new Map(),
      },
    });
    renderSeg.mockClear();

    await wrapper.setProps({ renderRevisions: new Map([["1.1", "highlight:h-1:0:4"]]) });

    expect(renderSeg).toHaveBeenCalledTimes(1);
    expect(renderSeg).toHaveBeenCalledWith(segments[0]);
    wrapper.unmount();
  });

  it("preserves code asset HTML without component-template whitespace", () => {
    const wrapper = mount(ReaderPane, {
      props: readerProps([segment("1.1", "code")]),
    });

    expect(wrapper.get("pre.asset-code").element.innerHTML).toBe("<code>text-1.1</code>");
    wrapper.unmount();
  });
});

describe("ReaderPane PHR2 scroll hot path", () => {
  it("coalesces repeated scroll events into one frame and probes only visible registered LIDs", async () => {
    const frames = installAnimationFrameHarness();
    const observers = installIntersectionObserverHarness();
    const segments = Array.from({ length: 1_000 }, (_, index) => segment(String(index + 1), "section"));
    const wrapper = mount(ReaderPane, { props: readerProps(segments) });
    await settleObserverSetup();

    const pane = wrapper.get(".reader-pane").element as HTMLElement;
    Object.defineProperties(pane, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 40_000, configurable: true },
    });
    const paneRect = vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(domRect(0, 400));
    const first = wrapper.get('[data-lid="1"]').element as HTMLElement;
    const leaf500 = wrapper.get('[data-lid="500"]').element as HTMLElement;
    const leaf501 = wrapper.get('[data-lid="501"]').element as HTMLElement;
    const firstRect = vi.spyOn(first, "getBoundingClientRect").mockReturnValue(domRect(-2_000, -1_960));
    vi.spyOn(leaf500, "getBoundingClientRect").mockReturnValue(domRect(80, 130));
    vi.spyOn(leaf501, "getBoundingClientRect").mockReturnValue(domRect(130, 180));

    const visibility = observers.find((observer) => observer.options.rootMargin === undefined);
    expect(visibility?.targets.size).toBe(1_000);
    visibility!.trigger([
      { target: leaf500, isIntersecting: true },
      { target: leaf501, isIntersecting: true },
    ]);
    frames.flush();
    expect(wrapper.emitted("current-lid")?.at(-1)).toEqual(["500"]);
    expect(firstRect).not.toHaveBeenCalled();

    paneRect.mockClear();
    const queryAll = vi.spyOn(pane, "querySelectorAll");
    for (let index = 0; index < 8; index += 1) {
      pane.dispatchEvent(new Event("scroll"));
    }
    expect(paneRect).not.toHaveBeenCalled();
    frames.flush(32);
    expect(paneRect).toHaveBeenCalledTimes(1);
    expect(queryAll).not.toHaveBeenCalled();
    expect(wrapper.emitted("current-lid")).toHaveLength(1);

    vi.mocked(leaf500.getBoundingClientRect).mockReturnValue(domRect(0, 80));
    vi.mocked(leaf501.getBoundingClientRect).mockReturnValue(domRect(80, 150));
    pane.dispatchEvent(new Event("scroll"));
    frames.flush(48);
    expect(wrapper.emitted("current-lid")?.at(-1)).toEqual(["501"]);
    expect(wrapper.emitted("current-lid")).toHaveLength(2);
    expect(queryAll).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps the 28% probe deterministic across boundaries, Note gaps, formulas, and images", async () => {
    const frames = installAnimationFrameHarness();
    const observers = installIntersectionObserverHarness();
    const segments = [
      segment("1.1", "paragraph"),
      segment("1.2", "formula"),
      segment("1.3", "image"),
      segment("1.4", "section"),
    ];
    const wrapper = mount(ReaderPane, {
      props: {
        ...readerProps(segments),
        visibleNotes: [note("note-gap", "1.1", "A note between registered LIDs")],
      },
    });
    await settleObserverSetup();

    const pane = wrapper.get(".reader-pane").element as HTMLElement;
    Object.defineProperty(pane, "clientHeight", { value: 400, configurable: true });
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(domRect(0, 400));
    const nodes = segments.map((value) => wrapper.get(`[data-lid="${value.lid}"]`).element as HTMLElement);
    const positions = new Map<string, [number, number]>([
      ["1.1", [0, 120]],
      ["1.2", [120, 160]],
      ["1.3", [180, 300]],
      ["1.4", [320, 380]],
    ]);
    for (const node of nodes) {
      vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
        const [top, bottom] = positions.get(node.dataset.lid!)!;
        return domRect(top, bottom);
      });
    }
    const visibility = observers.find((observer) => observer.options.rootMargin === undefined)!;
    visibility.trigger(nodes.map((target) => ({ target, isIntersecting: true })));
    frames.flush();
    expect(wrapper.emitted("current-lid")?.at(-1)).toEqual(["1.1"]);

    positions.set("1.1", [0, 60]);
    positions.set("1.2", [160, 200]);
    pane.dispatchEvent(new Event("scroll"));
    frames.flush(32);
    expect(wrapper.emitted("current-lid")).toHaveLength(1);

    positions.set("1.1", [-80, -20]);
    positions.set("1.2", [80, 150]);
    pane.dispatchEvent(new Event("scroll"));
    frames.flush(48);
    expect(wrapper.emitted("current-lid")?.at(-1)).toEqual(["1.2"]);

    positions.set("1.2", [-40, 30]);
    positions.set("1.3", [60, 250]);
    pane.dispatchEvent(new Event("scroll"));
    frames.flush(64);
    expect(wrapper.emitted("current-lid")?.at(-1)).toEqual(["1.3"]);
    wrapper.unmount();
  });

  it("settles each edge sentinel once per frame without blocking native edge input", async () => {
    const frames = installAnimationFrameHarness();
    const observers = installIntersectionObserverHarness();
    const wrapper = mount(ReaderPane, { props: readerProps([segment("1.1", "section")]) });
    await settleObserverSetup();

    const pane = wrapper.get(".reader-pane").element as HTMLElement;
    Object.defineProperties(pane, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    });
    pane.scrollTop = 600;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(domRect(0, 400));
    const body = wrapper.get('[data-lid="1.1"]').element as HTMLElement;
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(domRect(0, 80));
    const edgeObserver = observers.find((observer) => observer.options.rootMargin !== undefined)!;
    const top = wrapper.get(".reader-edge-sentinel-top").element;
    const bottom = wrapper.get(".reader-edge-sentinel-bottom").element;
    edgeObserver.trigger([
      { target: top, isIntersecting: true },
      { target: top, isIntersecting: true },
      { target: bottom, isIntersecting: true },
      { target: bottom, isIntersecting: true },
    ]);
    frames.flush();
    expect(wrapper.emitted("scroll-edge")).toEqual([["up"], ["down"]]);

    await wrapper.setProps({ segments: [segment("1.1", "section"), segment("1.2", "section")] });
    await settleObserverSetup();
    expect(edgeObserver.unobserveCalls).toEqual(expect.arrayContaining([top, bottom]));
    expect(edgeObserver.observeCalls.filter((target) => target === top)).toHaveLength(2);
    expect(edgeObserver.observeCalls.filter((target) => target === bottom)).toHaveLength(2);

    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    pane.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    const keydown = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "PageDown" });
    pane.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(false);
    frames.flush(32);
    expect(wrapper.emitted("scroll-edge")?.at(-1)).toEqual(["down"]);
    expect(wrapper.emitted("scroll-edge")).toHaveLength(3);
    wrapper.unmount();
  });

  it("falls back to the mounted registry when IntersectionObserver is unavailable", async () => {
    const frames = installAnimationFrameHarness();
    vi.stubGlobal("IntersectionObserver", undefined);
    const segments = [segment("1.1", "section"), segment("1.2", "section"), segment("1.3", "section")];
    const wrapper = mount(ReaderPane, { props: readerProps(segments) });
    await settleObserverSetup();

    const pane = wrapper.get(".reader-pane").element as HTMLElement;
    Object.defineProperties(pane, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_200, configurable: true },
    });
    pane.scrollTop = 400;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(domRect(0, 400));
    const nodes = segments.map((value) => wrapper.get(`[data-lid="${value.lid}"]`).element as HTMLElement);
    vi.spyOn(nodes[0], "getBoundingClientRect").mockReturnValue(domRect(-120, -40));
    vi.spyOn(nodes[1], "getBoundingClientRect").mockReturnValue(domRect(80, 180));
    vi.spyOn(nodes[2], "getBoundingClientRect").mockReturnValue(domRect(220, 320));
    const queryAll = vi.spyOn(pane, "querySelectorAll");

    pane.dispatchEvent(new Event("scroll"));
    frames.flush();
    expect(wrapper.emitted("current-lid")?.at(-1)).toEqual(["1.2"]);
    expect(queryAll).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("ReaderPane PHR4 height and anchor lifecycle", () => {
  it("projects measured evictions into top and bottom spacers", async () => {
    installAnimationFrameHarness();
    installIntersectionObserverHarness();
    const resizeObservers = installResizeObserverHarness();
    const leafOrder = Array.from({ length: 10 }, (_, index) => `lid-${index}`);
    const mounted = leafOrder.slice(2, 6).map((lid) => segment(lid, "section"));
    const wrapper = mount(ReaderPane, {
      props: {
        ...readerProps(mounted),
        boundedBufferEnabled: true,
        sourceFingerprint: "source-a",
        leafOrder,
        bufferRange: [2, 6] as const,
        rendererVersion: "markdown-v1",
        estimatedLeafHeightPx: 40,
      },
    });
    await settleObserverSetup();

    expect(wrapper.get(".reader-spacer-top").attributes("style")).toContain("80px");
    expect(wrapper.get(".reader-spacer-bottom").attributes("style")).toContain("160px");
    const resize = resizeObservers[0];
    const items = wrapper.findAll(".seg").map((item) => item.element);
    expect(items).toHaveLength(4);
    expect(items.every((item) => resize.targets.has(item))).toBe(true);
    resize.trigger(items.map((target, index) => ({
      target,
      blockSize: 50 + index * 10,
    })));
    await nextTick();

    await wrapper.setProps({
      segments: leafOrder.slice(6, 10).map((lid) => segment(lid, "section")),
      bufferRange: [6, 10] as const,
    });
    await settleObserverSetup();
    expect(wrapper.get(".reader-spacer-top").attributes("style")).toContain("340px");
    expect(wrapper.get(".reader-spacer-bottom").attributes("style")).toContain("0px");
    wrapper.unmount();
  });

  it("absorbs a variable-height receipt and preserves Note open state across remount", async () => {
    installAnimationFrameHarness();
    installIntersectionObserverHarness();
    const resizeObservers = installResizeObserverHarness();
    const longNote = note("note-variable", "lid-1", "x".repeat(420));
    const leafOrder = ["lid-0", "lid-1", "lid-2"];
    const wrapper = mount(ReaderPane, {
      props: {
        ...readerProps([segment("lid-1", "section")]),
        visibleNotes: [longNote],
        boundedBufferEnabled: true,
        sourceFingerprint: "source-a",
        leafOrder,
        bufferRange: [1, 2] as const,
        rendererVersion: "markdown-v1",
        estimatedLeafHeightPx: 40,
      },
    });
    await settleObserverSetup();

    const card = wrapper.get(".note-card");
    expect(card.attributes()).not.toHaveProperty("open");
    (card.element as HTMLDetailsElement).open = true;
    await card.trigger("toggle");
    expect(wrapper.get(".note-card").attributes()).toHaveProperty("open");

    const resize = resizeObservers[0];
    const item = wrapper.get(".seg").element;
    resize.trigger([{ target: item, blockSize: 60 }]);
    resize.trigger([{ target: item, blockSize: 180 }]);
    await nextTick();

    await wrapper.setProps({
      segments: [segment("lid-2", "section")],
      bufferRange: [2, 3] as const,
    });
    await wrapper.setProps({
      segments: [segment("lid-1", "section")],
      bufferRange: [1, 2] as const,
    });
    await settleObserverSetup();
    expect(wrapper.get(".note-card").attributes()).toHaveProperty("open");
    wrapper.unmount();
  });

  it("stabilizes a preserved anchor across two animation frames", async () => {
    const frames = installAnimationFrameHarness();
    installIntersectionObserverHarness();
    installResizeObserverHarness();
    const wrapper = mount(ReaderPane, {
      props: readerProps([
        segment("1.1", "section"),
        segment("1.2", "section"),
      ]),
    });
    await settleObserverSetup();
    frames.flush();

    const pane = wrapper.get(".reader-pane").element as HTMLElement;
    const anchorNode = wrapper.get('[data-lid="1.2"]').element as HTMLElement;
    pane.scrollTop = 200;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(domRect(100, 500));
    const anchorRect = vi.spyOn(anchorNode, "getBoundingClientRect")
      .mockReturnValueOnce(domRect(260, 300))
      .mockReturnValueOnce(domRect(310, 350))
      .mockReturnValue(domRect(260, 300));
    const exposed = wrapper.vm as unknown as {
      captureScrollAnchor: (lids: string[]) => { lid: string; top: number } | null;
      restoreScrollAnchor: (anchor: { lid: string; top: number } | null) => Promise<void>;
    };
    const anchor = exposed.captureScrollAnchor(["1.2"]);
    expect(anchor).toEqual({ lid: "1.2", top: 160 });
    const restoring = exposed.restoreScrollAnchor(anchor);
    await nextTick();
    expect(pane.scrollTop).toBe(200);
    frames.flush(32);
    await Promise.resolve();
    frames.flush(48);
    await restoring;
    expect(pane.scrollTop).toBe(250);
    expect(anchorRect).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it("publishes native selection and Note pointer pins for deferred trim", async () => {
    installAnimationFrameHarness();
    installIntersectionObserverHarness();
    installResizeObserverHarness();
    const visibleNote = note("note-pin", "1.1", "Pinned Note");
    const wrapper = mount(ReaderPane, {
      props: {
        ...readerProps([segment("1.1", "section")]),
        visibleNotes: [visibleNote],
      },
    });
    await settleObserverSetup();

    const textNode = wrapper.get('[data-lid="1.1"]').element.firstChild!;
    let collapsed = false;
    vi.spyOn(window, "getSelection").mockImplementation(() => ({
      isCollapsed: collapsed,
      anchorNode: textNode,
      focusNode: textNode,
    } as unknown as Selection));
    document.dispatchEvent(new Event("selectionchange"));
    expect(wrapper.emitted("interaction-pin")?.at(-1)).toEqual(["selection", true]);
    collapsed = true;
    document.dispatchEvent(new Event("selectionchange"));
    expect(wrapper.emitted("interaction-pin")?.at(-1)).toEqual(["selection", false]);

    const card = wrapper.get(".note-card");
    await card.trigger("pointerdown");
    expect(wrapper.emitted("interaction-pin")?.at(-1)).toEqual(["note", true]);
    await card.trigger("pointerup");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(wrapper.emitted("interaction-pin")?.at(-1)).toEqual(["note", false]);
    wrapper.unmount();
  });
});
