import { createApp, defineComponent, h, ref } from "vue";
import type {
  PaperMinimapBase,
  PaperMinimapLensProjection,
  PaperMinimapLocalization,
  ReaderPaperMinimapState,
} from "./api";
import PaperMinimap from "./components/PaperMinimap.vue";
import "./style.css";

const base: PaperMinimapBase = {
  version: "paper_minimap.v1",
  book_id: "visual-paper",
  book_version: "v1",
  fingerprint: "visual-fp",
  status: "available",
  regions: [
    ["Abstract", "abstract", 0, 0, "1.1", "1.3"],
    ["Introduction", "introduction", 1, 2, "2.1", "2.8"],
    ["Materials and Methods", "method", 3, 5, "3.1", "3.9"],
    ["Results", "results", 6, 8, "4.1", "4.7"],
    ["Discussion", "discussion", 9, 10, "5.1", "5.6"],
    ["Conclusion", "conclusion", 11, 11, "6.1", "6.3"],
  ].map(([title, kind, start, end, startLid, endLid], index) => ({
    region_id: `region:${index}`,
    title: String(title),
    kind: kind as "abstract" | "introduction" | "method" | "results" | "discussion" | "conclusion",
    lid_span: { start_lid: String(startLid), end_lid: String(endLid) },
    page_span: { start_page: Number(start), end_page: Number(end) },
    classification_source: "heading" as const,
    confidence: 1,
  })),
  landmarks: [
    ["research_question", "2.4", 1, "Research question"],
    ["method", "3.4", 4, "Core method"],
    ["result", "4.4", 7, "Central result"],
    ["limitation", "5.4", 10, "Limitation"],
  ].map(([kind, lid, page, label]) => ({
    landmark_id: `landmark:${kind}:${lid}`,
    kind: kind as "research_question" | "method" | "result" | "limitation",
    anchor_lid: String(lid),
    page_index: Number(page),
    label: String(label),
    source_label: null,
    evidence_lids: [String(lid)],
    provenance: ["discourse" as const],
  })),
  relations: [
    {
      relation_id: "relation:rq-method", type: "frames",
      source_landmark_id: "landmark:research_question:2.4", target_landmark_id: "landmark:method:3.4",
      evidence_lids: ["2.4", "3.4"],
    },
    {
      relation_id: "relation:method-result", type: "produces",
      source_landmark_id: "landmark:method:3.4", target_landmark_id: "landmark:result:4.4",
      evidence_lids: ["3.4", "4.4"],
    },
    {
      relation_id: "relation:result-limitation", type: "limits",
      source_landmark_id: "landmark:result:4.4", target_landmark_id: "landmark:limitation:5.4",
      evidence_lids: ["4.4", "5.4"],
    },
  ],
  layer_status: {
    regions: { status: "available", reason: null },
    landmarks: { status: "available", reason: null },
    arguments: { status: "available", reason: null },
  },
  warnings: [],
};

const localization: PaperMinimapLocalization = {
  book_id: "visual-paper",
  book_version: "v1",
  base_map_rev: "visual-fp",
  locale: "zh-CN",
  source: "cache",
  region_labels: Object.fromEntries([
    "摘要", "引言", "材料与方法", "结果", "讨论", "结论",
  ].map((label, index) => [`region:${index}`, label])),
  landmark_labels: {
    "landmark:research_question:2.4": "研究问题",
    "landmark:method:3.4": "使用 BERT 的核心方法",
    "landmark:result:4.4": "主要结果",
    "landmark:limitation:5.4": "研究局限",
  },
  warning: null,
};

function makeState(
  presentation: "collapsed" | "expanded",
  mode: ReaderPaperMinimapState["mode"],
): ReaderPaperMinimapState {
  return {
    rev: presentation === "collapsed" ? 0n : 1n,
    base_map_rev: "visual-fp",
    presentation,
    mode,
    viewport_position: {
      start_page: 6,
      end_page: 6,
      center_page: 6,
      progress_ratio: 0.55,
      anchor_lid: "4.2",
      region_id: "region:3",
    },
    selected_lid: null,
    map_focus: null,
    session_overlay: {
      emphasized_landmark_ids: [], hidden_landmark_ids: [], pinned_landmark_ids: [],
      focused_region_id: null, focused_landmark_id: null,
      visible_layers: ["regions", "landmarks", "arguments"], local_projection: null,
    },
    saved_user_overlay: {
      book_id: "visual-paper", book_version: "v1", overlay_rev: 0n,
      emphasized_kinds: [], hidden_landmark_ids: [], pinned_landmark_ids: [],
      custom_landmarks: [], landmark_overrides: [], saved_mode_preferences: [],
    },
  };
}

function makeLens(mode: ReaderPaperMinimapState["mode"]): PaperMinimapLensProjection {
  const landmarkIds = base.landmarks.map((landmark) => landmark.landmark_id);
  return {
    mode,
    focus_region_id: mode === "deep" ? "region:3" : mode === "abstract" ? "region:0" : null,
    global_landmark_ids: landmarkIds,
    local_landmark_ids: mode === "skim" ? [] : landmarkIds,
    relation_ids: base.relations.map((relation) => relation.relation_id),
    slot_bindings: mode === "skim" ? [] : [
      { slot: "research_question", landmark_id: landmarkIds[0] },
      { slot: "method", landmark_id: landmarkIds[1] },
      { slot: "result", landmark_id: landmarkIds[2] },
      { slot: "limitation", landmark_id: landmarkIds[3] },
    ],
    abstract_correspondences: mode === "abstract" ? [
      {
        slot: "method",
        abstract_landmark_id: landmarkIds[0],
        body_landmark_id: landmarkIds[1],
      },
      {
        slot: "result",
        abstract_landmark_id: landmarkIds[2],
        body_landmark_id: landmarkIds[3],
      },
    ] : [],
    warnings: [],
  };
}

const VisualApp = defineComponent({
  setup() {
    const presentation = ref<"collapsed" | "expanded">("collapsed");
    const mode = ref<ReaderPaperMinimapState["mode"]>("skim");
    const effectReason = ref<string | null>(null);
    return () => h("main", { class: "visual-shell" }, [
      h("aside", { class: "visual-rail" }, [
        h(PaperMinimap, {
          base,
          localization,
          state: makeState(presentation.value, mode.value),
          lens: makeLens(mode.value),
          effectReason: effectReason.value,
          undoAvailable: effectReason.value !== null,
          onToggle: () => { presentation.value = presentation.value === "collapsed" ? "expanded" : "collapsed"; },
          onModeChange: (nextMode: ReaderPaperMinimapState["mode"]) => {
            mode.value = nextMode;
            effectReason.value = `已切换到${{ skim: "速览", abstract: "摘要", deep: "深读" }[nextMode]}模式`;
          },
          onUndo: () => {
            mode.value = "skim";
            effectReason.value = null;
          },
        }),
      ]),
      h("section", { class: "visual-pdf", "data-testid": "pdf-surface" }, [
        h("div", { class: "visual-page" }, [
          h("h1", "A Deterministic Paper Map"),
          h("p", "The PDF surface keeps the same dimensions while the auxiliary map changes presentation."),
          ...Array.from({ length: 12 }, (_, index) => h("p", `Evidence paragraph ${index + 1}.`)),
        ]),
      ]),
    ]);
  },
});

createApp(VisualApp).mount("#app");
