// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type {
  PaperMinimapBase,
  PaperMinimapLensProjection,
  PaperMinimapLocalization,
  ReaderPaperMinimapState,
} from "../api";
import PaperMinimap from "./PaperMinimap.vue";

const base: PaperMinimapBase = {
  version: "paper_minimap.v1",
  book_id: "paper-a",
  book_version: "v1",
  fingerprint: "fp-a",
  status: "available",
  regions: [
    {
      region_id: "region:introduction",
      title: "Introduction",
      kind: "introduction",
      lid_span: { start_lid: "1.1", end_lid: "1.4" },
      page_span: { start_page: 0, end_page: 1 },
      classification_source: "heading",
      confidence: 1,
    },
    {
      region_id: "region:method",
      title: "Materials and Methods",
      kind: "method",
      lid_span: { start_lid: "2.1", end_lid: "2.8" },
      page_span: { start_page: 2, end_page: 4 },
      classification_source: "heading",
      confidence: 1,
    },
  ],
  landmarks: [{
    landmark_id: "landmark:method:2.2",
    kind: "method",
    anchor_lid: "2.2",
    page_index: 3,
    label: "Controlled experiment",
    source_label: null,
    evidence_lids: ["2.2"],
    provenance: ["discourse"],
  }],
  relations: [],
  layer_status: {},
  warnings: [],
};

const richBase: PaperMinimapBase = {
  ...base,
  landmarks: [
    ...base.landmarks,
    {
      ...base.landmarks[0], landmark_id: "landmark:rq", kind: "research_question", anchor_lid: "1.1",
      page_index: 0, label: "Research question",
    },
    {
      ...base.landmarks[0], landmark_id: "landmark:evidence", kind: "evidence", anchor_lid: "2.3",
      page_index: 3, label: "Evidence",
    },
    {
      ...base.landmarks[0], landmark_id: "landmark:result", kind: "result", anchor_lid: "2.5",
      page_index: 4, label: "Result",
    },
    {
      ...base.landmarks[0], landmark_id: "landmark:claim", kind: "claim", anchor_lid: "2.7",
      page_index: 4, label: "Claim",
    },
    {
      ...base.landmarks[0], landmark_id: "landmark:extra", kind: "other", anchor_lid: "2.8",
      page_index: 4, label: "Overflow landmark",
    },
  ],
  relations: [
    {
      relation_id: "relation:method-evidence", type: "produces",
      source_landmark_id: "landmark:method:2.2", target_landmark_id: "landmark:evidence", evidence_lids: ["2.3"],
    },
    {
      relation_id: "relation:evidence-result", type: "supports",
      source_landmark_id: "landmark:evidence", target_landmark_id: "landmark:result", evidence_lids: ["2.3"],
    },
    {
      relation_id: "relation:result-claim", type: "supports",
      source_landmark_id: "landmark:result", target_landmark_id: "landmark:claim", evidence_lids: ["2.5"],
    },
  ],
  layer_status: {
    regions: { status: "available", reason: null },
    landmarks: { status: "available", reason: null },
    arguments: { status: "available", reason: null },
  },
};

const skimLens: PaperMinimapLensProjection = {
  mode: "skim",
  focus_region_id: null,
  global_landmark_ids: richBase.landmarks.map((landmark) => landmark.landmark_id),
  local_landmark_ids: [],
  relation_ids: richBase.relations.map((relation) => relation.relation_id),
  slot_bindings: [],
  abstract_correspondences: [],
  warnings: [],
};

const deepLens: PaperMinimapLensProjection = {
  ...skimLens,
  mode: "deep",
  focus_region_id: "region:method",
  local_landmark_ids: ["landmark:method:2.2", "landmark:evidence", "landmark:result", "landmark:claim"],
  slot_bindings: [
    { slot: "method", landmark_id: "landmark:method:2.2" },
    { slot: "evidence", landmark_id: "landmark:evidence" },
    { slot: "result", landmark_id: "landmark:result" },
    { slot: "claim", landmark_id: "landmark:claim" },
  ],
};

function state(presentation: "collapsed" | "expanded"): ReaderPaperMinimapState {
  return {
    rev: 0n,
    base_map_rev: "fp-a",
    presentation,
    mode: "skim",
    viewport_position: {
      start_page: 1,
      end_page: 1,
      center_page: 1,
      progress_ratio: 0.25,
      anchor_lid: "1.3",
      region_id: "region:introduction",
    },
    selected_lid: null,
    map_focus: null,
    session_overlay: {
      emphasized_landmark_ids: [],
      hidden_landmark_ids: [],
      pinned_landmark_ids: [],
      focused_region_id: null,
      focused_landmark_id: null,
      visible_layers: ["regions", "landmarks"],
      local_projection: null,
    },
    saved_user_overlay: {
      book_id: "paper-a",
      book_version: "v1",
      overlay_rev: 0n,
      emphasized_kinds: [],
      hidden_landmark_ids: [],
      pinned_landmark_ids: [],
      custom_landmarks: [],
      landmark_overrides: [],
      saved_mode_preferences: [],
    },
  };
}

function stateWithArguments(mode: ReaderPaperMinimapState["mode"]): ReaderPaperMinimapState {
  const current = state("expanded");
  return {
    ...current,
    mode,
    session_overlay: {
      ...current.session_overlay,
      visible_layers: [...current.session_overlay.visible_layers, "arguments"],
    },
  };
}

describe("PaperMinimap", () => {
  it("renders localized Chinese region and landmark descriptions while preserving proper nouns", () => {
    const localization: PaperMinimapLocalization = {
      book_id: "paper-a",
      book_version: "v1",
      base_map_rev: "fp-a",
      locale: "zh-CN",
      source: "llm",
      region_labels: {
        "region:introduction": "引言",
        "region:method": "材料与方法",
      },
      landmark_labels: Object.fromEntries(richBase.landmarks.map((landmark) => [
        landmark.landmark_id,
        landmark.landmark_id === "landmark:method:2.2"
          ? "使用 BERT 进行受控实验"
          : `中文${landmark.kind}`,
      ])),
      warning: null,
    };
    const wrapper = mount(PaperMinimap, {
      props: { base: richBase, state: state("expanded"), lens: deepLens, localization },
    });

    expect(wrapper.text()).toContain("材料与方法");
    expect(wrapper.text()).toContain("使用 BERT 进行受控实验");
    expect(wrapper.text()).not.toContain("Materials and Methods");
    expect(wrapper.text()).not.toContain("Controlled experiment");
    expect(wrapper.text()).not.toContain("2.2");
  });

  it("keeps the collapsed map to coordinates, viewport, and landmark dots", async () => {
    const wrapper = mount(PaperMinimap, { props: { base, state: state("collapsed") } });
    expect(wrapper.findAll(".paper-map-region")).toHaveLength(2);
    expect(wrapper.findAll(".paper-map-landmark")).toHaveLength(1);
    expect(wrapper.get(".paper-map-viewport").attributes("style")).toContain("25%");
    expect(wrapper.find(".paper-map-region-list").exists()).toBe(false);

    await wrapper.get(".paper-map-toggle").trigger("click");
    expect(wrapper.emitted("toggle")).toHaveLength(1);
  });

  it("reveals region labels only in the user-expanded state and emits true LIDs", async () => {
    const wrapper = mount(PaperMinimap, { props: { base, state: state("expanded") } });
    const rows = wrapper.findAll(".paper-map-region-list button");
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain("方法");
    expect(wrapper.text()).not.toContain("Materials and Methods");
    await rows[1].trigger("click");
    expect(wrapper.emitted("goto")?.[0]).toEqual(["2.1"]);
  });

  it("navigates the coordinate track only when a drag ends and supports keyboard endpoints", async () => {
    const wrapper = mount(PaperMinimap, { props: { base, state: state("expanded") } });
    const track = wrapper.get(".paper-map-track");
    vi.spyOn(track.element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      bottom: 100,
      left: 0,
      right: 22,
      width: 22,
      height: 100,
      toJSON: () => ({}),
    });

    await track.trigger("pointerdown", { pointerId: 7, clientY: 20 });
    await track.trigger("pointermove", { pointerId: 7, clientY: 90 });
    expect(wrapper.emitted("goto")).toBeUndefined();
    await track.trigger("pointerup", { pointerId: 7, clientY: 90 });
    expect(wrapper.emitted("goto")?.[0]).toEqual(["2.8"]);

    await track.trigger("keydown", { key: "Home" });
    expect(wrapper.emitted("goto")?.[1]).toEqual(["1.1"]);
  });

  it("renders distinct bounded skim and deep lenses and emits authoritative controls", async () => {
    const wrapper = mount(PaperMinimap, {
      props: {
        base: richBase,
        state: stateWithArguments("skim"),
        lens: skimLens,
        effectReason: "已切换到速览模式",
        undoAvailable: true,
      },
    });
    expect(wrapper.find("[data-testid='skim-route']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='abstract-structure']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='deep-region']").exists()).toBe(false);
    expect(wrapper.findAll("[data-testid='global-chain'] .paper-map-chain-row")).toHaveLength(5);
    expect(wrapper.find("[data-testid='local-chain']").exists()).toBe(false);
    expect(wrapper.findAll(".paper-map-relations > div")).toHaveLength(3);
    await wrapper.get(".paper-map-pin").trigger("click");
    expect(wrapper.emitted("pin-toggle")?.[0]).toEqual(["landmark:method:2.2", false]);

    await wrapper.setProps({ state: stateWithArguments("deep"), lens: deepLens });
    expect(wrapper.attributes("data-mode")).toBe("deep");
    expect(wrapper.find("[data-testid='skim-route']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='deep-region']").exists()).toBe(true);
    expect(wrapper.text()).toContain("方法 · 深读");
    expect(wrapper.findAll("[data-testid='local-chain'] > button")).toHaveLength(4);

    await wrapper.setProps({
      state: stateWithArguments("abstract"),
      lens: {
        ...deepLens,
        mode: "abstract",
        focus_region_id: "region:introduction",
        local_landmark_ids: ["landmark:rq"],
        slot_bindings: [{ slot: "research_question", landmark_id: "landmark:rq" }],
        abstract_correspondences: [{
          slot: "method",
          abstract_landmark_id: "landmark:rq",
          body_landmark_id: "landmark:method:2.2",
        }],
      },
    });
    expect(wrapper.find("[data-testid='abstract-structure']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='deep-region']").exists()).toBe(false);
    expect(wrapper.findAll("[data-testid='local-chain'] > button")).toHaveLength(1);
    expect(wrapper.findAll("[data-testid='abstract-correspondences'] > button")).toHaveLength(1);

    await wrapper.findAll(".paper-map-modes button")[1].trigger("click");
    expect(wrapper.emitted("mode-change")?.[0]).toEqual(["abstract"]);
    await wrapper.findAll(".paper-map-layers input")[0].setValue(false);
    expect(wrapper.emitted("layer-toggle")?.[0]).toEqual(["regions", false]);
    await wrapper.get(".paper-map-effect button").trigger("click");
    expect(wrapper.emitted("undo")).toHaveLength(1);
  });

  it("renders complete long labels without exposing internal LIDs", () => {
    const longLabel = "使用 BERT LongMethodName-ExtremelySpecificVariant 完成多阶段受控实验并保留全部限定条件";
    const wrapper = mount(PaperMinimap, {
      props: {
        base: richBase,
        state: stateWithArguments("skim"),
        lens: skimLens,
        localization: {
          book_id: "paper-a",
          book_version: "v1",
          base_map_rev: "fp-a",
          locale: "zh-CN",
          source: "llm",
          region_labels: {},
          landmark_labels: { "landmark:method:2.2": longLabel },
          warning: null,
        },
      },
    });

    expect(wrapper.text()).toContain(longLabel);
    expect(wrapper.text()).not.toContain("2.2");
  });

  it("shows explicit empty states for unknown or unavailable argument layers", () => {
    const unavailableBase: PaperMinimapBase = {
      ...richBase,
      layer_status: {
        ...richBase.layer_status,
        arguments: { status: "unavailable", reason: "no evidence-backed relations" },
      },
    };
    const wrapper = mount(PaperMinimap, {
      props: {
        base: unavailableBase,
        state: stateWithArguments("deep"),
        lens: { ...deepLens, local_landmark_ids: [], slot_bindings: [], relation_ids: [] },
      },
    });
    expect(wrapper.text()).toContain("当前章节没有可显示的论证结构");
    expect(wrapper.text()).toContain("论证关系不可用");
    expect(wrapper.findAll(".paper-map-layers input")[2].attributes()).toHaveProperty("disabled");
  });

  it("disables expansion when topology is unavailable", () => {
    const wrapper = mount(PaperMinimap, {
      props: { base: { ...base, status: "unavailable", regions: [], landmarks: [] }, state: state("collapsed") },
    });
    expect(wrapper.get(".paper-map-toggle").attributes()).toHaveProperty("disabled");
    expect(wrapper.text()).toContain("不可用");
  });
});
