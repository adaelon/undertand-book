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
    ["research_question", "1.1", 0, "Abstract research question"],
    ["method", "1.2", 0, "Abstract method"],
    ["result", "1.3", 0, "Abstract result"],
    ["contribution", "1.4", 0, "Abstract contribution"],
    ["research_question", "2.4", 1, "Research question"],
    ["method", "3.4", 4, "Core method"],
    ["experiment", "4.1", 6, "Experiment"],
    ["evidence", "4.3", 7, "Evidence"],
    ["result", "4.4", 7, "Central result"],
    ["claim", "4.6", 8, "Result claim"],
    ["limitation", "5.4", 10, "Limitation"],
    ["contribution", "6.2", 11, "Contribution"],
  ].map(([kind, lid, page, label]) => ({
    landmark_id: `landmark:${kind}:${lid}`,
    kind: kind as "research_question" | "method" | "experiment" | "evidence" | "result" | "claim" | "contribution" | "limitation",
    anchor_lid: String(lid),
    page_index: Number(page),
    label: String(label),
    source_label: null,
    evidence_lids: [String(lid)],
    provenance: ["discourse" as const],
  })),
  relations: [
    {
      relation_id: "relation:abstract-rq-method", type: "frames",
      source_landmark_id: "landmark:research_question:1.1", target_landmark_id: "landmark:method:1.2",
      evidence_lids: ["1.1", "1.2"],
    },
    {
      relation_id: "relation:abstract-method-result", type: "produces",
      source_landmark_id: "landmark:method:1.2", target_landmark_id: "landmark:result:1.3",
      evidence_lids: ["1.2", "1.3"],
    },
    {
      relation_id: "relation:rq-method", type: "frames",
      source_landmark_id: "landmark:research_question:2.4", target_landmark_id: "landmark:method:3.4",
      evidence_lids: ["2.4", "3.4"],
    },
    {
      relation_id: "relation:experiment-evidence", type: "produces",
      source_landmark_id: "landmark:experiment:4.1", target_landmark_id: "landmark:evidence:4.3",
      evidence_lids: ["4.1", "4.3"],
    },
    {
      relation_id: "relation:evidence-result", type: "supports",
      source_landmark_id: "landmark:evidence:4.3", target_landmark_id: "landmark:result:4.4",
      evidence_lids: ["4.3", "4.4"],
    },
    {
      relation_id: "relation:result-claim", type: "supports",
      source_landmark_id: "landmark:result:4.4", target_landmark_id: "landmark:claim:4.6",
      evidence_lids: ["4.4", "4.6"],
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
    "landmark:research_question:1.1": "摘要中的研究问题与适用边界",
    "landmark:method:1.2": "摘要中的 BERT 方法概述",
    "landmark:result:1.3": "摘要报告的主要结果",
    "landmark:contribution:1.4": "摘要声明的核心贡献",
    "landmark:research_question:2.4": "全文研究问题与需要验证的关键假设",
    "landmark:method:3.4": "使用 BERT LongMethodName-ExtremelySpecificVariant 的多阶段核心方法",
    "landmark:experiment:4.1": "使用 BERT LongMethodName-ExtremelySpecificVariant 覆盖主要对照组与消融条件的实验设计",
    "landmark:evidence:4.3": "支持主要结论的定量证据与置信区间",
    "landmark:result:4.4": "实验观察到的主要结果及其适用范围",
    "landmark:claim:4.6": "由证据直接支持且不外推的核心主张",
    "landmark:limitation:5.4": "研究局限与当前数据无法回答的问题",
    "landmark:contribution:6.2": "论文最终确认的方法与实证贡献",
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
  const globalLandmarkIds = [
    "landmark:research_question:2.4",
    "landmark:method:3.4",
    "landmark:result:4.4",
    "landmark:contribution:6.2",
    "landmark:limitation:5.4",
  ];
  const abstractLandmarkIds = [
    "landmark:research_question:1.1",
    "landmark:method:1.2",
    "landmark:result:1.3",
    "landmark:contribution:1.4",
  ];
  const deepLandmarkIds = [
    "landmark:experiment:4.1",
    "landmark:evidence:4.3",
    "landmark:result:4.4",
    "landmark:claim:4.6",
  ];
  return {
    mode,
    focus_region_id: mode === "deep" ? "region:3" : mode === "abstract" ? "region:0" : null,
    global_landmark_ids: globalLandmarkIds,
    local_landmark_ids: mode === "abstract"
      ? abstractLandmarkIds
      : mode === "deep"
        ? deepLandmarkIds
        : [],
    relation_ids: mode === "skim"
      ? ["relation:rq-method"]
      : mode === "abstract"
        ? ["relation:abstract-rq-method", "relation:abstract-method-result"]
        : ["relation:experiment-evidence", "relation:evidence-result", "relation:result-claim"],
    slot_bindings: mode === "abstract" ? [
      { slot: "research_question", landmark_id: abstractLandmarkIds[0] },
      { slot: "method", landmark_id: abstractLandmarkIds[1] },
      { slot: "result", landmark_id: abstractLandmarkIds[2] },
      { slot: "contribution", landmark_id: abstractLandmarkIds[3] },
    ] : mode === "deep" ? [
      { slot: "experiment", landmark_id: deepLandmarkIds[0] },
      { slot: "evidence", landmark_id: deepLandmarkIds[1] },
      { slot: "result", landmark_id: deepLandmarkIds[2] },
      { slot: "claim", landmark_id: deepLandmarkIds[3] },
    ] : [],
    abstract_correspondences: mode === "abstract" ? [
      {
        slot: "method",
        abstract_landmark_id: abstractLandmarkIds[1],
        body_landmark_id: "landmark:method:3.4",
      },
      {
        slot: "result",
        abstract_landmark_id: abstractLandmarkIds[2],
        body_landmark_id: "landmark:result:4.4",
      },
      {
        slot: "contribution",
        abstract_landmark_id: abstractLandmarkIds[3],
        body_landmark_id: "landmark:contribution:6.2",
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
