<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FolderOpen, Highlighter, Languages, MessageSquareText, RotateCcw, Save, Sparkles, X } from "@lucide/vue";
import { api, ApiError } from "./api";
import type {
  AgentChatSessionSummary,
  AgentChatTurn as StoredAgentChatTurn,
  AskQuote,
  AgentEffect,
  AgentHistoryResponse,
  BuildWorkbenchSnapshot,
  BuildStageId,
  BookLibraryEntry,
  ExecutorId,
  FormulaSemantics,
  ImageAssetManifestEntry,
  HistoricalBackfillJobRequest,
  HistoricalBackfillStartRequest,
  HistoricalBackfillStateView,
  MemoryRecord,
  OuterOutcome,
  PaperMinimapApplyOutcome,
  PaperMinimapCommand,
  PaperMinimapEffect,
  PaperMinimapLocalization,
  PaperMinimapStateResponse,
  PaperViewportPosition,
  PdfSourceMap,
  PdfSourceMapEntry,
  ProfileManifest,
  ProfileGovernanceActionRequest,
  ProfileMemoryState,
  ProfileMemoryUpdate,
  ProfileSummary,
  ReaderLayoutAction,
  ReaderLayoutProposal,
  ReaderLayoutState,
  SelectionContext,
  SourceManifestV2,
  SourceReviewDecisionKind,
  SourceReviewLlmSuggestion,
  TraceStep,
  Viewport,
  WorkbenchAdapterMode,
} from "./api";
import {
  type PdfSelectionCapture,
  type PdfSelectionDraft,
  usePdfSelectionDraft,
} from "./pdf-selection-draft";
import {
  type PdfSelectionTranslationInvalidation,
  usePdfSelectionTranslation,
} from "./pdf-selection-translation";
import PdfSelectionTranslationSurface from "./components/PdfSelectionTranslationSurface.vue";
import {
  buildPdfProjectionBatch,
  EMPTY_PDF_ANNOTATION_PROJECTION,
  projectPdfAnnotations,
  type PdfUserAnnotationProjection,
} from "./pdf-annotation-projection";
import { renderInlineMarkdown, renderMarkdown } from "./md";
import { desktopLibraryNeedsSelection } from "./desktop-library";
import {
  desktopProviderDraft,
  desktopProviderStatusLabel,
  type DesktopProviderMode,
  type DesktopProviderStatus,
} from "./desktop-provider";
import { rangeToMarkdown } from "./selection";
import {
  hasMappedPdfNavigationTarget,
  normalizePaperViewportForMinimap,
} from "./paper-minimap-navigation";
import {
  hasSuccessfulReaderNavigation,
  resolveReaderNavigationTarget,
  resolveReaderStateNavigationTarget,
} from "./reader-navigation";
import { recallBookAnnotations } from "./reader-annotations";
import { selectionContextForAgentNote } from "./agent-note-selection";
import {
  getSourceReviewAutoRerunRequest,
  runSourceReviewLlmBatch,
  runSourceReviewPageGroupDecision,
  sourceReviewBatchTargets,
  type SourceReviewLlmBatchState,
} from "./source-review-batch";
import { buildUndoProfileAction } from "./profile-memory";
import {
  chooseAppSurface,
  workbenchAvailable,
  type AppSurface,
} from "./surface-selection";
import TopBar from "./components/TopBar.vue";
import BuildWorkbenchPane from "./components/BuildWorkbenchPane.vue";
import FileDropField from "./components/FileDropField.vue";
import LeftRail from "./components/LeftRail.vue";
import PdfReaderPane from "./components/PdfReaderPane.vue";
import ReaderPane from "./components/ReaderPane.vue";
import RightRail from "./components/RightRail.vue";

type NodeKind = import("./api").Manifest["tree"][number]["kind"];
type ManifestNode = import("./api").Manifest["tree"][number];
interface ScrollAnchor {
  lid: string;
  top: number;
}

export interface OutlineItem {
  lid: string;
  kind: NodeKind;
  depth: number;
  title: string;
}
// ── 阅读区会话态 ──
const leafOrder = ref<string[]>([]); // 全书叶 LID 序(读位感分母 + 进度)
const kindByLid = ref<Map<string, NodeKind>>(new Map());
const imageAssetByLid = ref<Map<string, ImageAssetManifestEntry>>(new Map());
const appSurface = ref<AppSurface>("loading");
const diagnosticWorkbenchBookId = ref<string | null>(null);
const buildWorkbenchSnapshot = ref<BuildWorkbenchSnapshot | null>(null);
const buildWorkbenchLoading = ref(false);
const buildWorkbenchError = ref<string | null>(null);
const buildWorkbenchConfirming = ref(false);
const buildWorkbenchImporting = ref(false);
const buildWorkbenchActioning = ref(false);
const sourceReviewLlmSuggestions = ref<Record<string, SourceReviewLlmSuggestion>>({});
const sourceReviewLlmAnalyzingBlockId = ref<string | null>(null);
const sourceReviewLlmErrors = ref<Record<string, string>>({});
const sourceReviewLlmBatch = ref<SourceReviewLlmBatchState | null>(null);
let buildWorkbenchActionOwner = 0;
let sourceReviewLlmBatchRunToken = 0;
let sourceReviewLlmRequestToken = 0;

function beginWorkbenchAction(): number {
  const owner = ++buildWorkbenchActionOwner;
  buildWorkbenchActioning.value = true;
  return owner;
}

function endWorkbenchAction(owner: number) {
  if (owner === buildWorkbenchActionOwner) buildWorkbenchActioning.value = false;
}

const sourceReviewEvidenceKey = computed(() => JSON.stringify(
  (buildWorkbenchSnapshot.value?.source_review.unresolved ?? []).map((block) => [
    block.id,
    block.status,
    block.md_excerpt ?? "",
    block.pdf_excerpt ?? "",
    block.candidate_text ?? "",
  ]),
));
watch(sourceReviewEvidenceKey, (next, previous) => {
  if (next === previous) return;
  sourceReviewLlmBatchRunToken += 1;
  sourceReviewLlmRequestToken += 1;
  sourceReviewLlmSuggestions.value = {};
  sourceReviewLlmAnalyzingBlockId.value = null;
  sourceReviewLlmErrors.value = {};
  sourceReviewLlmBatch.value = null;
});
const sourceManifest = ref<SourceManifestV2 | null>(null);
const pdfSourceMap = ref<PdfSourceMap | null>(null);
const pdfRuntimeError = ref<string | null>(null);
const outlineItems = ref<OutlineItem[]>([]);
const titleByLid = ref<Map<string, string>>(new Map());
const viewport = ref<Viewport | null>(null);
const edgeLoading = ref(false);
const readerPaneRef = ref<{
  captureScrollAnchor: (candidateLids: string[]) => ScrollAnchor | null;
  restoreScrollAnchor: (anchor: ScrollAnchor | null) => Promise<void>;
  scrollLidIntoView: (lid: string) => Promise<boolean>;
} | null>(null);
interface Segment {
  lid: string;
  text: string;
  kind: NodeKind;
  formula: FormulaSemantics | null;
  imageAsset: ImageAssetManifestEntry | null;
}
const segments = ref<Segment[]>([]); // 视口内连续正文(LID 隐形)
const annotations = ref<MemoryRecord[]>([]); // 当前书全部标注(客户端按 lid 过滤)
const pdfAnnotationProjection = ref<PdfUserAnnotationProjection>(EMPTY_PDF_ANNOTATION_PROJECTION);
const pdfAnnotationProjectionError = ref<string | null>(null);
let pdfAnnotationProjectionSeq = 0;
const HIGHLIGHT_GROUP_PREFIX = "highlight-group:";
const selectedLid = ref<string | null>(null);
const currentReadingLid = ref<string | null>(null);
const outlineNavigationLid = ref<string | null>(null);
const formulaDialog = ref<Segment | null>(null);
const chapterTitle = ref<string>("");
interface SourceFocus {
  lid: string;
  quote: string | null;
}
interface SourcePreview {
  focus: SourceFocus;
  segments: Segment[];
  loading: boolean;
  error: string | null;
}
const sourceFocus = ref<SourceFocus | null>(null);
const sourcePreview = ref<SourcePreview | null>(null);
const sourcePreviewBodyRef = ref<HTMLElement | null>(null);
const profileSummary = ref<ProfileSummary | null>(null);
const profileManifest = ref<ProfileManifest | null>(null);
const profileMemory = ref<ProfileMemoryState | null>(null);
const profileMemoryLoading = ref(false);
const profileMemoryBusy = ref(false);
const profileMemoryError = ref<string | null>(null);
const profileMemoryNotice = ref<string | null>(null);
const profileUpdateStates = ref<Record<string, string>>({});
let profileMemoryRequestSeq = 0;
const profileBackfill = ref<HistoricalBackfillStateView | null>(null);
const profileBackfillLoading = ref(false);
const profileBackfillBusy = ref(false);
const profileBackfillError = ref<string | null>(null);
const profileBackfillNotice = ref<string | null>(null);
let profileBackfillRequestSeq = 0;
let profileBackfillPollTimer: number | null = null;
const readerLayout = ref<ReaderLayoutState | null>(null);
const pendingLayoutProposal = ref<ReaderLayoutProposal | null>(null);
const paperMinimapSnapshot = ref<PaperMinimapStateResponse | null>(null);
const paperMinimapLocalization = ref<PaperMinimapLocalization | null>(null);
const lastPaperMinimapEffect = ref<PaperMinimapEffect | null>(null);
const paperMinimapActionBusy = ref(false);
const paperProjectionLoading = ref(false);
const paperProjectionError = ref<string | null>(null);
const paperProjectionKey = ref("");
let paperProjectionSeq = 0;
let paperPositionSyncTimer: number | null = null;
let paperPositionSyncRunning = false;
let paperPositionSyncCompletion: Promise<void> | null = null;
let completePaperPositionSync: (() => void) | null = null;
let pendingPaperViewport: PaperViewportPosition | null = null;
let pendingPaperSelection: string | null | undefined;

// goto 输入 + 错误条
const gotoInput = ref("");
const outlineSearch = ref("");
const banner = ref<string>("");
const bookPickerOpen = ref(false);
const bookPickerLoading = ref(false);
const bookPickerError = ref<string | null>(null);
const bookPickerRoot = ref("");
const bookPickerBooks = ref<BookLibraryEntry[]>([]);
const bookPickerDir = ref("");
const bookPickerMode = ref<"open" | "create">("open");
const newBookTitle = ref("");
const newBookId = ref("");
const newBookMarkdown = ref<File | null>(null);
const newBookPdf = ref<File | null>(null);
const openingBook = ref(false);
const desktopNeedsBook = ref(false);
const desktopHost = ref(false);
const desktopSettingsOpen = ref(false);
const desktopLibraryRoot = ref("");
const desktopLibraryAvailable = ref(true);
const desktopLibraryChanging = ref(false);
const desktopLibraryError = ref("");
const desktopProviderStatus = ref<DesktopProviderStatus | null>(null);
const desktopProviderMode = ref<DesktopProviderMode>("native");
const desktopProviderBaseUrl = ref("");
const desktopProviderModel = ref("");
const desktopProviderApiKey = ref("");
const desktopProviderLoading = ref(false);
const desktopProviderSaving = ref(false);
const desktopProviderError = ref("");
const codexPluginLoading = ref(false);
const codexPluginError = ref("");
type CodexPluginState =
  | "installed_by_setup"
  | "installed_externally"
  | "pending_configuration"
  | "codex_not_found"
  | "not_installed"
  | "error";
type CodexPluginStatus = {
  state: CodexPluginState;
  codex_path: string | null;
  marketplace_name: string;
  plugin_name: string;
  message: string;
};
const codexPluginStatus = ref<CodexPluginStatus | null>(null);
const debugOpen = ref(false);
const leftRailOpen = ref(true);
const leftRailWidth = ref(240);
const rightRailWidth = ref(384);
const workspaceStyle = computed(() => ({
  "--left-rail-width": leftRailOpen.value ? `${leftRailWidth.value}px` : "0px",
  "--left-resizer-width": leftRailOpen.value ? "6px" : "0px",
  "--right-rail-width": `${rightRailWidth.value}px`,
}));

function clampLayoutWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function startResize(which: "left" | "right", event: MouseEvent) {
  if (window.innerWidth < 1024) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = which === "left" ? leftRailWidth.value : rightRailWidth.value;
  const onMove = (move: MouseEvent) => {
    const delta = move.clientX - startX;
    if (which === "left") leftRailWidth.value = clampLayoutWidth(startWidth + delta, 180, 420);
    else rightRailWidth.value = clampLayoutWidth(startWidth - delta, 280, 560);
  };
  const onUp = () => {
    document.body.classList.remove("is-resizing-layout");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  document.body.classList.add("is-resizing-layout");
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp, { once: true });
}

function fail(e: unknown) {
  if (e instanceof ApiError) banner.value = `[${e.category}] ${e.errorCode}: ${e.message}`;
  else banner.value = String(e);
}

// 读位感:anchor 在叶序中的位置 → 进度%;章节 = anchor 顶层段(LID 首段)。
const readingAnchorLid = computed(() => currentReadingLid.value ?? viewport.value?.top_lid ?? null);
const outlineAnchorLid = computed(() => outlineNavigationLid.value ?? readingAnchorLid.value);
const activeOutlineItem = computed(() => {
  const anchor = outlineAnchorLid.value;
  if (!anchor) return null;
  return outlineItems.value
    .filter((item) => anchor === item.lid || anchor.startsWith(`${item.lid}.`))
    .sort((a, b) => b.lid.length - a.lid.length)[0] ?? null;
});
const activeChapterTitle = computed(() => activeOutlineItem.value?.title ?? chapterTitle.value);
const progressPct = computed(() => {
  const a = readingAnchorLid.value;
  if (!a || leafOrder.value.length === 0) return 0;
  const idx = leafOrder.value.indexOf(a);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / leafOrder.value.length) * 100);
});
function pdfCapabilityUsable(status: string | undefined): boolean {
  return status === "available" || status === "degraded";
}
const pdfReaderAvailable = computed(() =>
  sourceManifest.value?.capabilities.view_pdf.status === "available"
  && !!sourceManifest.value.original_pdf
  && !!pdfSourceMap.value
  && pdfCapabilityUsable(sourceManifest.value.capabilities.project_lid_to_pdf.status),
);
const pdfEntryByLid = computed(() => new Map((pdfSourceMap.value?.entries ?? []).map((entry) => [entry.lid, entry])));
const pdfMappedLids = computed(() => new Set(
  (pdfSourceMap.value?.entries ?? []).filter(pdfEntryHasRegion).map((entry) => entry.lid),
));
const pdfActiveLid = computed(() => selectedLid.value ?? readingAnchorLid.value);
function pdfEntryHasRegion(entry: PdfSourceMapEntry | null | undefined): boolean {
  return !!entry?.primary_region || !!entry?.regions.length;
}
const selectedSegment = computed(() => segments.value.find((seg) => seg.lid === selectedLid.value) ?? null);
const selectedFormula = computed(() => selectedSegment.value?.formula ?? null);
const segmentByLid = computed(() => new Map(segments.value.map((seg) => [seg.lid, seg])));
function lidOrderIndex(lid: string | null | undefined): number {
  if (!lid) return Number.MAX_SAFE_INTEGER;
  const idx = leafOrder.value.indexOf(lid);
  if (idx >= 0) return idx;
  const childIdx = leafOrder.value.findIndex((leaf) => leaf.startsWith(`${lid}.`));
  return childIdx >= 0 ? childIdx : Number.MAX_SAFE_INTEGER;
}
function sortMemoryByBookOrder(a: MemoryRecord, b: MemoryRecord): number {
  return lidOrderIndex(a.anchor.lid) - lidOrderIndex(b.anchor.lid)
    || (a.anchor.lid ?? "").localeCompare(b.anchor.lid ?? "")
    || a.mem_id.localeCompare(b.mem_id);
}
const allNotes = computed(() => annotations.value.filter((r) => r.type === "note").sort(sortMemoryByBookOrder));
const allHighlights = computed(() =>
  annotations.value
    .filter((r) => r.type === "highlight" && isHighlightCardRepresentative(r))
    .sort(sortMemoryByBookOrder),
);
const visibleNotes = computed(() => {
  const visible = segments.value.map((seg) => seg.lid);
  const order = new Map(visible.map((lid, idx) => [lid, idx]));
  return annotations.value
    .filter((r) => r.type === "note" && !!r.anchor.lid && order.has(r.anchor.lid))
    .sort((a, b) => (order.get(a.anchor.lid ?? "") ?? 0) - (order.get(b.anchor.lid ?? "") ?? 0));
});
function layoutRevNumber(value: number | bigint): number {
  return Number(value);
}
const isPaperProfile = computed(() => profileSummary.value?.profile_id === "paper");
function resetPaperProjectionData() {
  paperProjectionSeq += 1;
  if (paperPositionSyncTimer !== null) window.clearTimeout(paperPositionSyncTimer);
  paperPositionSyncTimer = null;
  pendingPaperViewport = null;
  pendingPaperSelection = undefined;
  paperMinimapSnapshot.value = null;
  paperMinimapLocalization.value = null;
  lastPaperMinimapEffect.value = null;
  paperMinimapActionBusy.value = false;
  paperProjectionLoading.value = false;
  paperProjectionError.value = null;
  paperProjectionKey.value = "";
}

function minimapRegionForPosition(position: PaperViewportPosition): string | null {
  const regions = paperMinimapSnapshot.value?.base.regions ?? [];
  const centerPage = Math.floor(position.center_page);
  const pageMatches = regions.filter((region) =>
    centerPage >= region.page_span.start_page && centerPage <= region.page_span.end_page);
  if (pageMatches.length <= 1 || !position.anchor_lid) return pageMatches[0]?.region_id ?? null;
  const anchorOrder = lidOrderIndex(position.anchor_lid);
  return pageMatches.find((region) => {
    const start = lidOrderIndex(region.lid_span.start_lid);
    const end = lidOrderIndex(region.lid_span.end_lid);
    return anchorOrder >= start && anchorOrder <= end;
  })?.region_id ?? pageMatches[0]?.region_id ?? null;
}

function paperMinimapStateFromOutcome(outcome: PaperMinimapApplyOutcome) {
  if (outcome.kind === "effect") return outcome.effect.after;
  if (outcome.kind === "noop") return outcome.state;
  return null;
}

function schedulePaperPositionSync() {
  if (paperPositionSyncTimer !== null) window.clearTimeout(paperPositionSyncTimer);
  paperPositionSyncTimer = window.setTimeout(() => {
    paperPositionSyncTimer = null;
    void flushPaperPositionSync();
  }, 180);
}

async function flushPaperPositionSync() {
  if (paperPositionSyncRunning) {
    await paperPositionSyncCompletion;
    return;
  }
  const snapshot = paperMinimapSnapshot.value;
  const viewportPosition = pendingPaperViewport;
  const selected = pendingPaperSelection;
  if (!snapshot || (!viewportPosition && selected === undefined)) return;
  pendingPaperViewport = null;
  pendingPaperSelection = undefined;
  const commands: PaperMinimapCommand[] = [];
  if (viewportPosition) {
    commands.push({ scope: "session", action: { kind: "update_viewport", position: viewportPosition } });
  }
  if (selected !== undefined) {
    commands.push({ scope: "session", action: { kind: "set_selected_lid", selected_lid: selected } });
  }
  paperPositionSyncRunning = true;
  paperPositionSyncCompletion = new Promise((resolve) => {
    completePaperPositionSync = resolve;
  });
  try {
    const outcome = await api.paperMinimapApply({
      base_state_rev: Number(snapshot.state.rev),
      actor: "user",
      reason: "sync deterministic PDF viewport and selection",
      commands,
    });
    const state = paperMinimapStateFromOutcome(outcome);
    if (state && paperMinimapSnapshot.value?.base.fingerprint === state.base_map_rev) {
      paperMinimapSnapshot.value = { ...paperMinimapSnapshot.value, state };
      if (lastPaperMinimapEffect.value
        && Number(lastPaperMinimapEffect.value.after_state_rev) !== Number(state.rev)) {
        lastPaperMinimapEffect.value = null;
      }
      if (state.viewport_position.anchor_lid) currentReadingLid.value = state.viewport_position.anchor_lid;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      paperMinimapSnapshot.value = await api.paperMinimapState();
      pendingPaperViewport ??= viewportPosition;
      if (pendingPaperSelection === undefined) pendingPaperSelection = selected;
      schedulePaperPositionSync();
    } else {
      fail(error);
    }
  } finally {
    paperPositionSyncRunning = false;
    completePaperPositionSync?.();
    completePaperPositionSync = null;
    paperPositionSyncCompletion = null;
    if (pendingPaperViewport || pendingPaperSelection !== undefined) schedulePaperPositionSync();
  }
}

function onPdfViewportChange(position: PaperViewportPosition) {
  if (!paperMinimapSnapshot.value) return;
  const bounded = normalizePaperViewportForMinimap(
    position,
    paperMinimapSnapshot.value.base.regions.map((region) => region.page_span),
  );
  if (!bounded) return;
  const normalized = { ...bounded, region_id: minimapRegionForPosition(bounded) };
  pendingPaperViewport = normalized;
  paperMinimapSnapshot.value = {
    ...paperMinimapSnapshot.value,
    state: { ...paperMinimapSnapshot.value.state, viewport_position: normalized },
  };
  schedulePaperPositionSync();
}

function queuePaperSelection(selected: string | null) {
  if (!isPaperProfile.value || !pdfReaderAvailable.value || !paperMinimapSnapshot.value) return;
  pendingPaperSelection = selected;
  paperMinimapSnapshot.value = {
    ...paperMinimapSnapshot.value,
    state: { ...paperMinimapSnapshot.value.state, selected_lid: selected },
  };
  schedulePaperPositionSync();
}

async function applyPaperMinimapCommands(commands: PaperMinimapCommand[], reason: string) {
  if (paperMinimapActionBusy.value) return;
  if (paperPositionSyncTimer !== null) {
    window.clearTimeout(paperPositionSyncTimer);
    paperPositionSyncTimer = null;
    await flushPaperPositionSync();
  } else if (paperPositionSyncRunning) {
    await flushPaperPositionSync();
  }
  const snapshot = paperMinimapSnapshot.value;
  if (!snapshot) return;
  paperMinimapActionBusy.value = true;
  try {
    const outcome = await api.paperMinimapApply({
      base_state_rev: Number(snapshot.state.rev),
      actor: "user",
      reason,
      commands,
    });
    const state = paperMinimapStateFromOutcome(outcome);
    if (outcome.kind === "effect") lastPaperMinimapEffect.value = outcome.effect;
    if (state) paperMinimapSnapshot.value = { ...snapshot, state };
    paperMinimapSnapshot.value = await api.paperMinimapState();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      paperMinimapSnapshot.value = await api.paperMinimapState();
      lastPaperMinimapEffect.value = null;
    } else {
      fail(error);
    }
  } finally {
    paperMinimapActionBusy.value = false;
  }
}

async function setPaperMinimapMode(mode: import("./api").ReaderPaperMinimapState["mode"]) {
  if (mode === paperMinimapSnapshot.value?.state.mode) return;
  const modeLabel = { skim: "速览", abstract: "摘要", deep: "深读" }[mode];
  await applyPaperMinimapCommands(
    [{ scope: "session", action: { kind: "set_mode_lens", mode } }],
    `切换为${modeLabel}模式`,
  );
}

async function setPaperMinimapLayer(layer: string, visible: boolean) {
  const layerLabel = {
    regions: "章节区域",
    landmarks: "重点位置",
    arguments: "论证关系",
    user: "我的标记",
  }[layer] ?? layer;
  await applyPaperMinimapCommands(
    [{ scope: "session", action: { kind: "set_layer_visibility", layer, visible } }],
    `${visible ? "显示" : "隐藏"}${layerLabel}图层`,
  );
}

async function togglePaperMinimapPin(landmarkId: string, pinned: boolean) {
  await applyPaperMinimapCommands(
    [{
      scope: "session",
      action: pinned
        ? { kind: "unpin_landmark", landmark_id: landmarkId }
        : { kind: "pin_landmark", landmark_id: landmarkId },
    }],
    pinned ? "取消固定地标" : "固定地标",
  );
}

async function undoLastPaperMinimapEffect() {
  const effect = lastPaperMinimapEffect.value;
  const snapshot = paperMinimapSnapshot.value;
  if (!effect || !snapshot || paperMinimapActionBusy.value) return;
  paperMinimapActionBusy.value = true;
  try {
    const outcome = await api.paperMinimapApply({
      base_state_rev: Number(snapshot.state.rev),
      undo_effect_id: effect.effect_id,
    });
    const state = paperMinimapStateFromOutcome(outcome);
    if (state) paperMinimapSnapshot.value = { ...snapshot, state };
    lastPaperMinimapEffect.value = null;
    paperMinimapSnapshot.value = await api.paperMinimapState();
  } catch (error) {
    fail(error);
  } finally {
    paperMinimapActionBusy.value = false;
  }
}
async function loadPaperProjectionData(force = false) {
  if (!isPaperProfile.value) {
    resetPaperProjectionData();
    return;
  }
  const key = `${profileSummary.value?.profile_id}:${profileSummary.value?.profile_version}:${readingAnchorLid.value ?? ""}`;
  if (!force && paperProjectionKey.value === key) return;
  const seq = ++paperProjectionSeq;
  paperProjectionLoading.value = true;
  paperProjectionError.value = null;
  try {
    const minimap = await api.paperMinimapState();
    if (seq !== paperProjectionSeq) return;
    paperMinimapSnapshot.value = minimap;
    if (paperMinimapLocalization.value?.base_map_rev !== minimap.base.fingerprint) {
      const localization = await api.paperMinimapLocalize();
      if (seq !== paperProjectionSeq) return;
      if (localization.base_map_rev === minimap.base.fingerprint) {
        paperMinimapLocalization.value = localization;
      }
    }
    paperProjectionKey.value = key;
  } catch (e) {
    if (seq !== paperProjectionSeq) return;
    paperProjectionError.value = errorMessage(e);
  } finally {
    if (seq === paperProjectionSeq) paperProjectionLoading.value = false;
  }
}

async function togglePaperMinimap() {
  const snapshot = paperMinimapSnapshot.value;
  if (!snapshot) return;
  const presentation = snapshot.state.presentation === "expanded" ? "collapsed" : "expanded";
  try {
    await api.paperMinimapApply({
      base_state_rev: Number(snapshot.state.rev),
      actor: "user",
      reason: presentation === "expanded" ? "user expanded paper minimap" : "user collapsed paper minimap",
      commands: [{
        scope: "session",
        action: { kind: "set_presentation", presentation },
      }],
    });
    paperMinimapSnapshot.value = await api.paperMinimapState();
  } catch (error) {
    fail(error);
  }
}
watch(
  () => [
    profileSummary.value?.profile_id,
    profileSummary.value?.profile_version,
    readingAnchorLid.value,
  ] as const,
  () => { void loadPaperProjectionData(); },
);

// ── 标注:高亮(整段 / 段内 range)+ 笔记 ──
// 整段高亮(range 缺省)→ <p> 背景;段内 range 高亮 → <mark>(见 renderSeg)`[ADR-0031]`。
function isHighlighted(lid: string): boolean {
  return annotations.value.some((r) => r.anchor.lid === lid && r.type === "highlight" && !r.range);
}
function highlightsOf(lid: string): MemoryRecord[] {
  return annotations.value.filter((r) => r.anchor.lid === lid && r.type === "highlight");
}

function newHighlightGroupId(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${HIGHLIGHT_GROUP_PREFIX}${id}`;
}

function highlightGroupId(rec: MemoryRecord): string | null {
  const id = rec.source_session_id?.trim();
  return id?.startsWith(HIGHLIGHT_GROUP_PREFIX) ? id : null;
}

function highlightGroupMembers(rec: MemoryRecord): MemoryRecord[] {
  const groupId = highlightGroupId(rec);
  if (!groupId) return [rec];
  return annotations.value
    .filter((r) => r.type === "highlight" && highlightGroupId(r) === groupId)
    .sort(sortMemoryByBookOrder);
}

function highlightGroupRepresentative(rec: MemoryRecord): MemoryRecord {
  const members = highlightGroupMembers(rec);
  const visibleOrder = new Map(segments.value.map((seg, idx) => [seg.lid, idx]));
  const visibleMembers = members
    .filter((m) => visibleOrder.has(m.anchor.lid ?? ""))
    .sort((a, b) => (visibleOrder.get(a.anchor.lid ?? "") ?? Number.MAX_SAFE_INTEGER) - (visibleOrder.get(b.anchor.lid ?? "") ?? Number.MAX_SAFE_INTEGER));
  return visibleMembers[0] ?? members[0] ?? rec;
}

function isHighlightCardRepresentative(rec: MemoryRecord): boolean {
  return highlightGroupRepresentative(rec).mem_id === rec.mem_id;
}

function highlightCardsOf(lid: string): MemoryRecord[] {
  return highlightsOf(lid).filter(isHighlightCardRepresentative);
}

function renderInlineText(s: string): string {
  return renderInlineMarkdown(s);
}
function inlineMathSource(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) return "";
  const dollar = /^\$(.*)\$$/.exec(trimmed);
  if (dollar) return `$${dollar[1]}$`;
  const paren = /^\\\((.*)\\\)$/.exec(trimmed);
  if (paren) return `$${paren[1]}$`;
  return `$${trimmed.replace(/\$/g, "\\$")}$`;
}
function renderFormulaSymbol(symbol: string): string {
  return renderInlineMarkdown(inlineMathSource(symbol));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRawAssetSegment(seg: { kind?: NodeKind }): boolean {
  return seg.kind === "code" || seg.kind === "table" || seg.kind === "image";
}

function renderSegmentText(seg: { kind?: NodeKind }, text: string): string {
  return isRawAssetSegment(seg) ? escapeHtml(text) : renderInlineText(text);
}

interface MarkdownHeadingDisplay {
  level: number;
  text: string;
  offset: number;
}

function markdownHeadingDisplay(text: string): MarkdownHeadingDisplay | null {
  const match = /^(\s{0,3})(#{1,6})([ \t]+)([^\r\n]*?)([ \t]+#+)?[ \t]*(?:\r?\n)?$/.exec(text);
  if (!match || !match[4].trim()) return null;
  return {
    level: match[2].length,
    text: match[4].trimEnd(),
    offset: match[1].length + match[2].length + match[3].length,
  };
}

function markdownHeadingLevel(seg: { text: string; kind?: NodeKind }): number | null {
  if (seg.kind !== "chapter" && seg.kind !== "section" && seg.kind !== "paragraph") return null;
  return markdownHeadingDisplay(seg.text)?.level ?? null;
}

function stripMarkdownHeadingLine(line: string): string {
  return markdownHeadingDisplay(line)?.text ?? line;
}

function displayText(seg: { text: string; kind?: NodeKind }): { text: string; offset: number } {
  const heading = markdownHeadingLevel(seg) ? markdownHeadingDisplay(seg.text) : null;
  if (heading) return { text: heading.text, offset: heading.offset };
  return { text: seg.text, offset: 0 };
}

function clampRange(n: number, max: number): number {
  return Math.max(0, Math.min(max, n));
}

function leadingQuote(content: string): string | null {
  const quoteLines: string[] = [];
  for (const line of content.split("\\n")) {
    if (line.startsWith(">")) quoteLines.push(line.replace(/^>\\s?/, ""));
    else if (quoteLines.length > 0 && line.trim() === "") break;
    else if (quoteLines.length > 0) break;
  }
  const quote = quoteLines.join(" ").replace(/\\s+/g, " ").trim();
  return quote || null;
}

interface FocusCharRef {
  lid: string;
  offset: number;
}
interface FocusStream {
  text: string;
  refs: Array<FocusCharRef | null>;
}

const markdownEscapedPunctuation = /[\\`*_[\]{}()#+\-.!|>%]/;

function escapedMarkdownLiteral(text: string, index: number): { ch: string; offset: number } | null {
  if (text[index] !== "\\" || index + 1 >= text.length) return null;
  const next = text[index + 1];
  return markdownEscapedPunctuation.test(next) ? { ch: next, offset: index + 1 } : null;
}

function normalizeSourceMatchText(text: string): string {
  let out = "";
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const escaped = escapedMarkdownLiteral(text, i);
    const ch = escaped?.ch ?? text[i];
    if (escaped) i = escaped.offset;
    if (/\s/.test(ch)) {
      if (!inSpace) {
        out += " ";
        inSpace = true;
      }
      continue;
    }
    out += ch;
    inSpace = false;
  }
  return out.trim();
}

function appendNormalizedText(stream: FocusStream, lid: string, text: string) {
  let inSpace = stream.text.endsWith(" ");
  for (let i = 0; i < text.length; i++) {
    const escaped = escapedMarkdownLiteral(text, i);
    const ch = escaped?.ch ?? text[i];
    const offset = escaped?.offset ?? i;
    if (escaped) i = escaped.offset;
    if (/\s/.test(ch)) {
      if (!inSpace) {
        stream.text += " ";
        stream.refs.push({ lid, offset });
        inSpace = true;
      }
      continue;
    }
    stream.text += ch;
    stream.refs.push({ lid, offset });
    inSpace = false;
  }
}

function joinsInlineFlow(prev: Segment, next: Segment): boolean {
  return prev.kind === "formula" || next.kind === "formula";
}

function sourceFocusStreamIn(sourceSegments: Segment[], focus: SourceFocus): FocusStream | null {
  const start = sourceSegments.findIndex((seg) => seg.lid === focus.lid);
  if (start < 0) return null;
  const stream: FocusStream = { text: "", refs: [] };
  let prev: Segment | null = null;
  for (const seg of sourceSegments.slice(start)) {
    if (prev && !joinsInlineFlow(prev, seg) && stream.text && !stream.text.endsWith(" ")) {
      stream.text += " ";
      stream.refs.push(null);
    }
    appendNormalizedText(stream, seg.lid, displayText(seg).text);
    prev = seg;
  }
  return stream;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function sourceFocusRangesIn(sourceSegments: Segment[], focus: SourceFocus | null): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (!focus) return out;
  if (!focus.quote) {
    const seg = sourceSegments.find((s) => s.lid === focus.lid);
    if (seg) out.set(focus.lid, [0, displayText(seg).text.length]);
    return out;
  }
  const quote = normalizeSourceMatchText(focus.quote);
  if (!quote) return out;
  const stream = sourceFocusStreamIn(sourceSegments, focus);
  if (!stream) return out;

  let start = stream.text.indexOf(quote);
  let len = quote.length;
  if (start < 0) {
    let bestStart = -1;
    let bestLen = 0;
    for (let i = 0; i < stream.text.length; i++) {
      const n = commonPrefixLen(stream.text.slice(i), quote);
      if (n > bestLen) {
        bestLen = n;
        bestStart = i;
      }
    }
    const minUseful = Math.min(8, quote.length, stream.text.length);
    if (bestLen < minUseful) {
      const seg = sourceSegments.find((s) => s.lid === focus.lid);
      if (seg) out.set(focus.lid, [0, displayText(seg).text.length]);
      return out;
    }
    start = bestStart;
    len = bestLen;
  }

  for (let i = start; i < start + len && i < stream.refs.length; i++) {
    const ref = stream.refs[i];
    if (!ref) continue;
    const current = out.get(ref.lid);
    if (current) {
      current[0] = Math.min(current[0], ref.offset);
      current[1] = Math.max(current[1], ref.offset + 1);
    } else {
      out.set(ref.lid, [ref.offset, ref.offset + 1]);
    }
  }
  return out;
}

function sourceFocusRange(text: string, focus: SourceFocus | null, lid: string): [number, number] | null {
  if (!focus || focus.lid !== lid) return null;
  if (!focus.quote) return [0, text.length];
  const exact = text.indexOf(focus.quote);
  if (exact >= 0) return [exact, exact + focus.quote.length];
  const normalizedQuote = focus.quote.replace(/\s+/g, " ").trim();
  const compact = text.replace(/\s+/g, " ");
  const approx = compact.indexOf(normalizedQuote);
  if (approx < 0) return [0, text.length];
  return [0, text.length];
}

// 段正文渲染:把段内 range 高亮包成 <mark>(合并重叠区间),其余文本转义防 XSS `[ADR-0031]`。
// chapter/section 的 Markdown 标题符号只在显示层剥掉,不改 book.text 原文与 LID 锚点。
function renderSegWithFocus(seg: Segment, focus: SourceFocus | null, sourceSegments: Segment[], includeStoredHighlights: boolean): string {
  const display = isRawAssetSegment(seg) ? { text: seg.text, offset: 0 } : displayText(seg);
  const hls = includeStoredHighlights ? highlightsOf(seg.lid).filter((h) => h.range) : [];
  const focusRange = sourceFocusRangesIn(sourceSegments, focus).get(seg.lid) ?? sourceFocusRange(display.text, focus, seg.lid);
  if (hls.length === 0 && !focusRange) return renderSegmentText(seg, display.text);
  const ranges = hls
    .map((h) => {
      const start = clampRange(h.range!.start - display.offset, display.text.length);
      const end = clampRange(h.range!.end - display.offset, display.text.length);
      return [start, end] as [number, number];
    })
    .filter(([start, end]) => end > start);
  if (focusRange) ranges.push(focusRange);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const t = display.text;
  let html = "";
  let cur = 0;
  for (const [s, e] of merged) {
    const cls = focusRange && s === focusRange[0] && e === focusRange[1] ? "hl-mark source-focus-mark" : "hl-mark";
    html += renderSegmentText(seg, t.slice(cur, s)) + `<mark class="${cls}">${renderSegmentText(seg, t.slice(s, e))}</mark>`;
    cur = e;
  }
  return html + renderSegmentText(seg, t.slice(cur));
}
function renderSeg(seg: Segment): string {
  return renderSegWithFocus(seg, sourceFocus.value, segments.value, true);
}
function renderSourcePreviewSeg(seg: Segment): string {
  return renderSegWithFocus(seg, sourcePreview.value?.focus ?? null, sourcePreview.value?.segments ?? [], false);
}
function isSourcePreviewFlowSegment(seg: Segment): boolean {
  if (seg.kind === "paragraph" && markdownHeadingLevel(seg) !== null) return false;
  return seg.kind === "paragraph" || seg.kind === "formula";
}
function sourcePreviewFlowHtml(flow: Segment[]): string {
  const body = flow
    .map((seg) => `<span class="source-preview-inline-${seg.kind === "formula" ? "formula" : "text"}">${renderSourcePreviewSeg(seg)}</span>`)
    .join("");
  return `<p class="source-preview-paragraph">${body}</p>`;
}
function sourcePreviewSingleHtml(seg: Segment): string {
  const level = markdownHeadingLevel(seg);
  if (level) return `<h${level} class="source-preview-heading">${renderSourcePreviewSeg(seg)}</h${level}>`;
  if (seg.kind === "code") return `<pre class="source-preview-asset source-preview-code"><code>${renderSourcePreviewSeg(seg)}</code></pre>`;
  if (seg.kind === "table") return `<pre class="source-preview-asset source-preview-table">${renderSourcePreviewSeg(seg)}</pre>`;
  if (seg.kind === "image") {
    const meta = imageMeta(seg.text);
    const asset = seg.imageAsset;
    const src = imageRenderSrc(asset);
    const image = src
      ? `<img class="source-preview-rendered-image" src="${escapeHtml(src)}" alt="${escapeHtml(asset?.alt || meta?.alt || "图片")}" loading="lazy" decoding="async">`
      : "";
    const warning = asset?.warning ? `<em>${escapeHtml(asset.warning)}</em>` : "";
    return `<figure class="source-preview-asset source-preview-image">${image}<strong>${escapeHtml(meta?.alt || asset?.alt || "图片")}</strong><code>${escapeHtml(meta?.src || asset?.original_src || "来源不可用")}</code>${warning}<pre>${renderSourcePreviewSeg(seg)}</pre></figure>`;
  }
  return `<p class="source-preview-paragraph">${renderSourcePreviewSeg(seg)}</p>`;
}
const sourcePreviewHtml = computed(() => {
  const preview = sourcePreview.value;
  if (!preview || preview.loading || preview.error) return "";
  const parts: string[] = [];
  let flow: Segment[] = [];
  const flush = () => {
    if (!flow.length) return;
    parts.push(sourcePreviewFlowHtml(flow));
    flow = [];
  };
  for (const seg of preview.segments) {
    if (isSourcePreviewFlowSegment(seg)) {
      const last = flow[flow.length - 1];
      if (last && !joinsInlineFlow(last, seg)) flush();
      flow.push(seg);
    } else {
      flush();
      parts.push(sourcePreviewSingleHtml(seg));
    }
  }
  flush();
  return parts.join("\n");
});
function hlExcerpt(rec: MemoryRecord): string {
  const members = highlightGroupMembers(rec);
  const c = members.map((m) => m.content).join(" ").replace(/\s+/g, " ").trim();
  if (!rec.range && members.length === 1) return "(整段)";
  return c.length > 40 ? c.slice(0, 40) + "…" : c;
}

// 高亮删除 / 修改(=移除后重新框选;高亮无可编辑正文,改 = 改范围 `[ADR-0031]`)。
async function deleteHighlight(rec: MemoryRecord) {
  try {
    banner.value = "";
    await Promise.all(highlightGroupMembers(rec).map((h) => api.delete(h.mem_id)));
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
async function modifyHighlight(rec: MemoryRecord) {
  await deleteHighlight(rec);
  if (!banner.value) banner.value = "已移除该高亮——重新框选文字再点「🖍 高亮选区」即可改范围。";
}

// ── 笔记编辑器(内联模态 + 实时 MD/LaTeX 预览)替换 window.prompt ──
const noteEditor = ref<{
  lid: string;
  memId: string | null;
  layer: string;
  content: string;
  selectionContext: SelectionContext | null;
} | null>(null);
const notePreview = computed(() => renderMarkdown(noteEditor.value?.content ?? ""));
function openNewNote(lid = selectedLid.value, content = "", selectionContext: SelectionContext | null = null) {
  if (!lid) return;
  noteEditor.value = { lid, memId: null, layer: "long_term", content, selectionContext };
}
function openEditNote(rec: MemoryRecord) {
  noteEditor.value = {
    lid: rec.anchor.lid ?? "",
    memId: rec.mem_id,
    layer: rec.layer,
    content: rec.content,
    selectionContext: null,
  };
}
function cancelNote() {
  if (noteEditor.value?.selectionContext && pdfSelectionState.value.phase === "saving") {
    cancelPdfSelectionDraft();
  }
  noteEditor.value = null;
}
// 保存:新建走 save;编辑走原子 replace,默认继承旧锚与 selection context。
async function saveNote() {
  const ed = noteEditor.value;
  if (!ed) return;
  const content = ed.content.trim();
  if (!content) return;
  try {
    banner.value = "";
    if (ed.memId) {
      await api.replace({
        mem_id: ed.memId,
        content,
        selection_context: ed.selectionContext ?? undefined,
      });
    } else {
      await api.save({
        type: "note",
        anchor_lid: ed.lid,
        content,
        layer: ed.layer,
        selection_context: ed.selectionContext ?? undefined,
      });
    }
    noteEditor.value = null;
    await refreshAnnotations();
    if (ed.selectionContext && pdfSelectionState.value.phase === "saving") {
      completePdfSelectionAction();
    }
  } catch (e) {
    fail(e);
  }
}
async function deleteNote(rec: MemoryRecord) {
  if (!window.confirm("删除这条笔记?")) return;
  try {
    banner.value = "";
    await api.delete(rec.mem_id);
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}

function kindOf(lid: string): NodeKind {
  return kindByLid.value.get(lid) ?? "paragraph";
}
function lidDepth(lid: string): number {
  return lid.split(".").length - 1;
}
function fallbackTitle(lid: string): string {
  return titleByLid.value.get(lid) ?? lid;
}
function firstTitleLine(text: string, lid: string): string {
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  return (line ? stripMarkdownHeadingLine(line) : lid).slice(0, 80);
}
function buildOutline(tree: ManifestNode[]): OutlineItem[] {
  return tree
    .filter((n) => n.children.length > 0 || n.kind === "chapter" || n.kind === "section")
    .map((n) => ({
      lid: n.lid,
      kind: n.kind,
      depth: Math.min(lidDepth(n.lid), 4),
      title: fallbackTitle(n.lid),
    }));
}
async function loadOutlineTitles(tree: ManifestNode[]) {
  const outline = buildOutline(tree);
  outlineItems.value = outline;
  await Promise.all(
    outline.map(async (item) => {
      try {
        const t = await api.text(item.lid);
        titleByLid.value.set(item.lid, firstTitleLine(t.text, item.lid));
      } catch {
        titleByLid.value.set(item.lid, item.lid);
      }
    }),
  );
  outlineItems.value = buildOutline(tree);
}
function isAsset(seg: Segment): boolean {
  return seg.kind === "code" || seg.kind === "table" || seg.kind === "image" || seg.kind === "formula";
}
function imageMeta(text: string): { alt: string; src: string } | null {
  const m = text.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  return m ? { alt: m[1], src: m[2] } : null;
}
function imageAssetFor(lid: string): ImageAssetManifestEntry | null {
  return imageAssetByLid.value.get(lid) ?? null;
}
function imageRenderSrc(asset: ImageAssetManifestEntry | null | undefined): string | null {
  if (!asset) return null;
  return asset.url_path ?? (asset.status === "external" ? asset.original_src : null);
}
async function formulaFor(lid: string, kind: NodeKind): Promise<FormulaSemantics | null> {
  if (kind !== "formula") return null;
  try {
    return await api.formulaSemantics(lid);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

function resetPdfAnnotationProjection() {
  pdfAnnotationProjectionSeq += 1;
  pdfAnnotationProjection.value = EMPTY_PDF_ANNOTATION_PROJECTION;
  pdfAnnotationProjectionError.value = null;
}

async function refreshPdfAnnotationProjection(records: MemoryRecord[]) {
  const seq = ++pdfAnnotationProjectionSeq;
  pdfAnnotationProjectionError.value = null;
  if (
    !pdfReaderAvailable.value
    || !pdfCapabilityUsable(sourceManifest.value?.capabilities.project_ranges_to_pdf.status)
  ) {
    pdfAnnotationProjection.value = EMPTY_PDF_ANNOTATION_PROJECTION;
    return;
  }
  const batch = buildPdfProjectionBatch(records);
  if (!batch.requests.length) {
    pdfAnnotationProjection.value = projectPdfAnnotations(batch, { projections: [] });
    return;
  }
  try {
    const response = await api.pdfRangesProject(batch.requests);
    if (seq !== pdfAnnotationProjectionSeq) return;
    pdfAnnotationProjection.value = projectPdfAnnotations(batch, response);
  } catch (error) {
    if (seq !== pdfAnnotationProjectionSeq) return;
    pdfAnnotationProjection.value = projectPdfAnnotations(batch, { projections: [] });
    pdfAnnotationProjectionError.value = errorMessage(error);
  }
}

async function refreshAnnotations() {
  const bookId = buildWorkbenchSnapshot.value?.book_id;
  if (!bookId) {
    annotations.value = [];
    resetPdfAnnotationProjection();
    return;
  }
  const records = await recallBookAnnotations(bookId, api.recall);
  if (buildWorkbenchSnapshot.value?.book_id !== bookId) return;
  annotations.value = records;
  await refreshPdfAnnotationProjection(records);
}

type SegmentLoadMode = "replace" | "append" | "prepend";

async function hydrateSegments(lids: string[]): Promise<Segment[]> {
  const texts = await Promise.all(lids.map((lid) => api.text(lid)));
  return Promise.all(
    texts.map(async (t) => {
      const kind = kindOf(t.lid);
      return {
        lid: t.lid,
        text: t.text,
        kind,
        formula: await formulaFor(t.lid, kind),
        imageAsset: kind === "image" ? imageAssetFor(t.lid) : null,
      };
    }),
  );
}

function mergeSegments(current: Segment[], incoming: Segment[], mode: SegmentLoadMode): Segment[] {
  if (mode === "replace") return incoming;
  const seen = new Set(current.map((seg) => seg.lid));
  const unique = incoming.filter((seg) => !seen.has(seg.lid));
  return mode === "append" ? [...current, ...unique] : [...unique, ...current];
}

// 视口加载:逐 visible_lid 取真原文。replace 用于 goto/sync;append/prepend 用于正文连续滚动缓冲。
async function loadWindow(
  vp: Viewport,
  mode: SegmentLoadMode = "replace",
  navigationTargetLid = vp.top_lid,
) {
  viewport.value = vp;
  if (mode === "replace") {
    selectedLid.value = navigationTargetLid;
    currentReadingLid.value = navigationTargetLid;
  }
  const next = await hydrateSegments(vp.visible_lids);
  segments.value = mergeSegments(segments.value, next, mode);
  if (mode === "replace") {
    await readerPaneRef.value?.scrollLidIntoView(navigationTargetLid);
  }
  await refreshAnnotations();
  await loadChapter(vp.top_lid);
}

// 阅读区与服务端 reader 同步(agent 可能改了视口 → 重新拉 state 渲染)。
async function ensureProfileManifest(summary: ProfileSummary) {
  const current = profileManifest.value;
  if (current?.profile_id === summary.profile_id && current.profile_version === summary.profile_version) return;
  profileManifest.value = await api.profileManifest(summary.profile_id);
}
async function applyReaderState(st: Awaited<ReturnType<typeof api.state>>) {
  profileSummary.value = st.profile;
  readerLayout.value = st.layout;
  await ensureProfileManifest(st.profile);
}

function profileOperationId(kind: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `profile-ui-${kind}-${random}`;
}

async function refreshProfileMemory(preserveFeedback = false) {
  const requestSeq = ++profileMemoryRequestSeq;
  profileMemoryLoading.value = true;
  if (!preserveFeedback) {
    profileMemoryError.value = null;
    profileMemoryNotice.value = null;
  }
  try {
    const state = await api.profileMemory();
    if (requestSeq !== profileMemoryRequestSeq) return;
    profileMemory.value = state;
  } catch (error) {
    if (requestSeq !== profileMemoryRequestSeq) return;
    profileMemoryError.value = errorMessage(error);
  } finally {
    if (requestSeq === profileMemoryRequestSeq) profileMemoryLoading.value = false;
  }
}

async function refreshProfileBackfill(preserveFeedback = false) {
  const requestSeq = ++profileBackfillRequestSeq;
  profileBackfillLoading.value = true;
  if (!preserveFeedback) {
    profileBackfillError.value = null;
    profileBackfillNotice.value = null;
  }
  try {
    const state = await api.profileBackfill();
    if (requestSeq !== profileBackfillRequestSeq) return;
    profileBackfill.value = state;
  } catch (error) {
    if (requestSeq !== profileBackfillRequestSeq) return;
    profileBackfillError.value = errorMessage(error);
  } finally {
    if (requestSeq === profileBackfillRequestSeq) profileBackfillLoading.value = false;
  }
}

async function refreshProfileSurface(preserveFeedback = false) {
  await Promise.all([
    refreshProfileMemory(preserveFeedback),
    refreshProfileBackfill(preserveFeedback),
  ]);
}

function scheduleProfileBackfillPoll() {
  if (profileBackfillPollTimer !== null) window.clearTimeout(profileBackfillPollTimer);
  profileBackfillPollTimer = null;
  const active = profileBackfill.value?.jobs.some((job) =>
    job.status === "queued" || job.status === "running") ?? false;
  if (!active) return;
  profileBackfillPollTimer = window.setTimeout(async () => {
    profileBackfillPollTimer = null;
    await Promise.all([
      refreshProfileBackfill(true),
      refreshProfileMemory(true),
    ]);
    scheduleProfileBackfillPoll();
  }, 750);
}

watch(
  () => profileBackfill.value?.jobs
    .map((job) => `${job.job_id}:${job.status}:${job.processed_through}`)
    .join("|") ?? "",
  scheduleProfileBackfillPoll,
);

async function startProfileBackfill(request: HistoricalBackfillStartRequest) {
  if (profileBackfillBusy.value) return;
  profileBackfillBusy.value = true;
  profileBackfillError.value = null;
  profileBackfillNotice.value = null;
  try {
    profileBackfill.value = await api.profileBackfillStart(request);
    profileBackfillNotice.value = "历史回填已开始";
    await refreshProfileMemory(true);
  } catch (error) {
    profileBackfillError.value = errorMessage(error);
  } finally {
    profileBackfillBusy.value = false;
  }
}

async function mutateProfileBackfill(
  action: "cancel" | "retry" | "clear",
  request: HistoricalBackfillJobRequest,
) {
  if (profileBackfillBusy.value) return;
  profileBackfillBusy.value = true;
  profileBackfillError.value = null;
  profileBackfillNotice.value = null;
  try {
    profileBackfill.value = action === "cancel"
      ? await api.profileBackfillCancel(request)
      : action === "retry"
        ? await api.profileBackfillRetry(request)
        : await api.profileBackfillClear(request);
    profileBackfillNotice.value = {
      cancel: "历史回填已中止",
      retry: "历史回填已继续",
      clear: "历史回填记录已清除",
    }[action];
    await refreshProfileMemory(true);
  } catch (error) {
    profileBackfillError.value = errorMessage(error);
  } finally {
    profileBackfillBusy.value = false;
  }
}

function profileMutationLabel(action: ProfileGovernanceActionRequest): string {
  return {
    remember: "画像已记住",
    correct: "画像已纠正",
    forget: "画像已忘记",
    confirm: "画像已确认",
    reject: "候选已忽略",
    change_scope: "画像范围已更新",
    add_collection_rule: "自动收集规则已添加",
    remove_collection_rule: "自动收集规则已移除",
  }[action.kind];
}

async function mutateProfile(action: ProfileGovernanceActionRequest) {
  if (profileMemoryBusy.value) return null;
  if (!profileMemory.value) await refreshProfileMemory();
  const state = profileMemory.value;
  if (!state) return null;
  profileMemoryBusy.value = true;
  profileMemoryError.value = null;
  profileMemoryNotice.value = null;
  try {
    const response = await api.profileMemoryApply({
      expected_document_revision: state.status.document_revision,
      action,
    });
    profileMemoryNotice.value = response.kind === "applied"
      ? profileMutationLabel(action)
      : "敏感画像等待确认";
    await refreshProfileMemory(true);
    return response;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await refreshProfileMemory(true);
      profileMemoryError.value = error.errorCode === "MEMORY_DOCUMENT_REVISION_CONFLICT"
        ? "画像已在后台更新，已载入最新版本，请重试刚才的操作。"
        : error.message;
    } else {
      profileMemoryError.value = errorMessage(error);
    }
    return null;
  } finally {
    profileMemoryBusy.value = false;
  }
}

async function undoProfileUpdate(
  turnIndex: number,
  updateIndex: number,
  update: ProfileMemoryUpdate,
) {
  const key = `${turnIndex}:${updateIndex}`;
  if (!profileMemory.value) await refreshProfileMemory();
  const action = buildUndoProfileAction(
    profileMemory.value,
    update,
    profileOperationId("undo"),
  );
  if (!action) {
    profileUpdateStates.value = { ...profileUpdateStates.value, [key]: "无法撤销" };
    return;
  }
  const response = await mutateProfile(action);
  if (!response) return;
  const status = response.kind === "applied" ? "已撤销" : "等待确认";
  profileUpdateStates.value = { ...profileUpdateStates.value, [key]: status };
  profileMemoryNotice.value = response.kind === "applied" ? "画像更新已撤销" : "敏感画像等待确认";
}

async function syncViewport(forcePaperProjection = false, preferReaderSelection = false) {
  const st = await api.state();
  await applyReaderState(st);
  const navigationTargetLid = preferReaderSelection
    ? resolveReaderStateNavigationTarget(st.viewport.top_lid, st.selection, leafOrder.value)
    : st.viewport.top_lid;
  await loadWindow(st.viewport, "replace", navigationTargetLid);
  await loadPaperProjectionData(forcePaperProjection);
}

// 章节标题:取 anchor 顶层段(LID 首段)原文首行作标签(读位感「第N章…」)。
async function loadChapter(anchorLid: string) {
  const top = anchorLid.split(".")[0];
  try {
    const t = await api.text(top);
    chapterTitle.value = t.text.split("\n")[0].slice(0, 40);
  } catch {
    chapterTitle.value = top;
  }
}

async function loadPdfRuntimeArtifacts() {
  sourceManifest.value = null;
  pdfSourceMap.value = null;
  pdfRuntimeError.value = null;
  try {
    const manifest = await api.sourceManifest();
    sourceManifest.value = manifest;
    if (
      manifest.capabilities.view_pdf.status === "available"
      && pdfCapabilityUsable(manifest.capabilities.project_lid_to_pdf.status)
    ) {
      pdfSourceMap.value = await api.pdfSourceMap();
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return;
    pdfRuntimeError.value = errorMessage(e);
  }
}

async function loadBuildWorkbenchSnapshot(): Promise<BuildWorkbenchSnapshot | null> {
  buildWorkbenchLoading.value = true;
  buildWorkbenchError.value = null;
  try {
    let snapshot = await api.buildWorkbench();
    buildWorkbenchSnapshot.value = snapshot;
    snapshot = await maybeAutoRerunSourceReview(snapshot);
    buildWorkbenchSnapshot.value = snapshot;
    return snapshot;
  } catch (e) {
    buildWorkbenchError.value = errorMessage(e);
    buildWorkbenchSnapshot.value = null;
    return null;
  } finally {
    buildWorkbenchLoading.value = false;
  }
}

async function maybeAutoRerunSourceReview(
  snapshot: BuildWorkbenchSnapshot,
  actionOwner?: number,
): Promise<BuildWorkbenchSnapshot> {
  const request = getSourceReviewAutoRerunRequest(snapshot);
  if (!request) return snapshot;

  const ownsAction = actionOwner === undefined;
  const owner = actionOwner ?? beginWorkbenchAction();
  buildWorkbenchSnapshot.value = snapshot;
  try {
    return await api.workbenchJobStart(request);
  } catch (e) {
    buildWorkbenchError.value = `复核决定已保存，但自动重新运行来源对齐失败：${errorMessage(e)}`;
    return snapshot;
  } finally {
    if (ownsAction) endWorkbenchAction(owner);
  }
}

async function refreshBuildWorkbench() {
  const snapshot = await loadBuildWorkbenchSnapshot();
  if (!snapshot) return;
  await showSurfaceForWorkbenchSnapshot(snapshot);
}

async function showSurfaceForWorkbenchSnapshot(snapshot: BuildWorkbenchSnapshot) {
  const surface = chooseAppSurface(snapshot);
  if (surface === "reader" && diagnosticWorkbenchBookId.value !== snapshot.book_id) {
    await init();
    return;
  }
  appSurface.value = "workbench";
}

async function confirmSidecarPlan(fields: Record<string, unknown>) {
  buildWorkbenchConfirming.value = true;
  buildWorkbenchError.value = null;
  try {
    buildWorkbenchSnapshot.value = await api.sidecarPlanConfirm(fields);
  } catch (e) {
    buildWorkbenchError.value = errorMessage(e);
  } finally {
    buildWorkbenchConfirming.value = false;
  }
}

async function importWorkbenchInput(payload: {
  target_dir?: string;
  book_id?: string;
  display_title?: string;
  paper_md_path?: string;
  paper_pdf_path?: string;
  paper_md_text?: string;
  paper_pdf_base64?: string;
}) {
  buildWorkbenchImporting.value = true;
  buildWorkbenchError.value = null;
  try {
    buildWorkbenchSnapshot.value = await api.workbenchInputImport(payload);
    diagnosticWorkbenchBookId.value = null;
    appSurface.value = "workbench";
  } catch (e) {
    buildWorkbenchError.value = errorMessage(e);
  } finally {
    buildWorkbenchImporting.value = false;
  }
}

async function applyWorkbenchAction(action: () => Promise<BuildWorkbenchSnapshot>) {
  const actionOwner = beginWorkbenchAction();
  buildWorkbenchError.value = null;
  try {
    let snapshot = await action();
    buildWorkbenchSnapshot.value = snapshot;
    snapshot = await maybeAutoRerunSourceReview(snapshot, actionOwner);
    buildWorkbenchSnapshot.value = snapshot;
    await showSurfaceForWorkbenchSnapshot(snapshot);
  } catch (e) {
    buildWorkbenchError.value = errorMessage(e);
  } finally {
    endWorkbenchAction(actionOwner);
  }
}

async function createBuildJob() {
  await applyWorkbenchAction(() => api.workbenchJobCreate());
}

async function startBuildJob(payload: {
  job_id?: string;
  stage: BuildStageId;
  executor: ExecutorId;
  run_id?: string;
  adapter_mode?: WorkbenchAdapterMode;
}) {
  await applyWorkbenchAction(() => api.workbenchJobStart(payload));
}

async function resumeBuildJob(jobId: string) {
  await applyWorkbenchAction(() => api.workbenchJobResume(jobId));
}

async function resolveBuildDecision(payload: { job_id: string; decision_id: string; answer: string }) {
  await applyWorkbenchAction(() => api.workbenchDecisionResolve(payload));
}

async function resolveExecutorPermission(payload: { job_id: string; request_id: string; granted: boolean }) {
  await applyWorkbenchAction(() => api.workbenchPermissionResolve(payload));
}

async function resolveSourceReview(payload: {
  job_id?: string;
  block_id: string;
  decision: SourceReviewDecisionKind;
  replacement_text?: string;
  note?: string;
}) {
  await applyWorkbenchAction(() => api.workbenchSourceReviewResolve(payload));
}

async function resolveSourceReviewGroup(payload: {
  job_id?: string;
  group_id: string;
  note?: string;
}) {
  const snapshot = buildWorkbenchSnapshot.value;
  if (!snapshot || buildWorkbenchActioning.value) return;
  const actionOwner = beginWorkbenchAction();
  const bookId = snapshot.book_id;
  const stillCurrent = () => buildWorkbenchSnapshot.value?.book_id === bookId;
  buildWorkbenchError.value = null;

  try {
    let nextSnapshot = await runSourceReviewPageGroupDecision({
      snapshot,
      groupId: payload.group_id,
      jobId: payload.job_id,
      note: payload.note,
      resolve: (decision) => api.workbenchSourceReviewResolve(decision),
      onSnapshot: (persistedSnapshot) => {
        if (stillCurrent()) buildWorkbenchSnapshot.value = persistedSnapshot;
      },
    });
    if (!stillCurrent()) return;
    buildWorkbenchSnapshot.value = nextSnapshot;
    nextSnapshot = await maybeAutoRerunSourceReview(nextSnapshot, actionOwner);
    if (stillCurrent()) {
      buildWorkbenchSnapshot.value = nextSnapshot;
      await showSurfaceForWorkbenchSnapshot(nextSnapshot);
    }
  } catch (e) {
    if (stillCurrent()) buildWorkbenchError.value = errorMessage(e);
  } finally {
    endWorkbenchAction(actionOwner);
  }
}

async function analyzeSourceReview(payload: { block_id: string }) {
  if (sourceReviewLlmBatch.value?.status === "running" || buildWorkbenchActioning.value) return;
  const blockId = payload.block_id;
  const requestToken = ++sourceReviewLlmRequestToken;
  const bookId = buildWorkbenchSnapshot.value?.book_id;
  const evidenceKey = sourceReviewEvidenceKey.value;
  const stillCurrent = () => (
    requestToken === sourceReviewLlmRequestToken
    && buildWorkbenchSnapshot.value?.book_id === bookId
    && sourceReviewEvidenceKey.value === evidenceKey
  );
  sourceReviewLlmAnalyzingBlockId.value = blockId;
  const nextErrors = { ...sourceReviewLlmErrors.value };
  const nextSuggestions = { ...sourceReviewLlmSuggestions.value };
  delete nextErrors[blockId];
  delete nextSuggestions[blockId];
  sourceReviewLlmErrors.value = nextErrors;
  sourceReviewLlmSuggestions.value = nextSuggestions;
  try {
    const suggestion = await api.workbenchSourceReviewAnalyze(blockId);
    if (stillCurrent()) {
      sourceReviewLlmSuggestions.value = {
        ...sourceReviewLlmSuggestions.value,
        [blockId]: suggestion,
      };
    }
  } catch (e) {
    if (stillCurrent()) {
      sourceReviewLlmErrors.value = {
        ...sourceReviewLlmErrors.value,
        [blockId]: errorMessage(e),
      };
    }
  } finally {
    if (stillCurrent() && sourceReviewLlmAnalyzingBlockId.value === blockId) {
      sourceReviewLlmAnalyzingBlockId.value = null;
    }
  }
}

async function applyAllSourceReviewWithLlm() {
  const snapshot = buildWorkbenchSnapshot.value;
  if (
    !snapshot
    || buildWorkbenchActioning.value
    || sourceReviewLlmAnalyzingBlockId.value
    || sourceReviewLlmBatch.value?.status === "running"
  ) return;
  const targets = sourceReviewBatchTargets(snapshot);
  if (!targets.length) return;

  const runToken = ++sourceReviewLlmBatchRunToken;
  sourceReviewLlmRequestToken += 1;
  sourceReviewLlmAnalyzingBlockId.value = null;
  const actionOwner = beginWorkbenchAction();
  const bookId = snapshot.book_id;
  const targetIds = new Set(targets.map((block) => block.id));
  const nextErrors = { ...sourceReviewLlmErrors.value };
  const nextSuggestions = { ...sourceReviewLlmSuggestions.value };
  for (const blockId of targetIds) {
    delete nextErrors[blockId];
    delete nextSuggestions[blockId];
  }
  sourceReviewLlmErrors.value = nextErrors;
  sourceReviewLlmSuggestions.value = nextSuggestions;
  buildWorkbenchError.value = null;

  const latestJobId = [...snapshot.jobs]
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
    .at(-1)?.job_id;
  const stillCurrent = () => (
    runToken === sourceReviewLlmBatchRunToken
    && buildWorkbenchSnapshot.value?.book_id === bookId
  );

  try {
    const result = await runSourceReviewLlmBatch({
      snapshot,
      jobId: latestJobId,
      analyze: (blockId) => api.workbenchSourceReviewAnalyze(blockId),
      resolve: (payload) => api.workbenchSourceReviewResolve(payload),
      formatError: errorMessage,
      isCancelled: () => !stillCurrent(),
      onState: (state) => {
        if (!stillCurrent()) return;
        sourceReviewLlmBatch.value = state;
        sourceReviewLlmAnalyzingBlockId.value = state.status === "running"
          ? state.current_block_id
          : null;
      },
      onSuggestion: (suggestion) => {
        if (!stillCurrent()) return;
        sourceReviewLlmSuggestions.value = {
          ...sourceReviewLlmSuggestions.value,
          [suggestion.block_id]: suggestion,
        };
      },
      onFailure: (failure) => {
        if (!stillCurrent()) return;
        sourceReviewLlmErrors.value = {
          ...sourceReviewLlmErrors.value,
          [failure.block_id]: failure.message,
        };
      },
      onSnapshot: (nextSnapshot) => {
        if (stillCurrent()) buildWorkbenchSnapshot.value = nextSnapshot;
      },
    });
    if (stillCurrent()) {
      let nextSnapshot = result.snapshot;
      buildWorkbenchSnapshot.value = nextSnapshot;
      sourceReviewLlmBatch.value = result.state;
      nextSnapshot = await maybeAutoRerunSourceReview(nextSnapshot, actionOwner);
      if (stillCurrent()) buildWorkbenchSnapshot.value = nextSnapshot;
    }
  } catch (e) {
    if (stillCurrent()) buildWorkbenchError.value = errorMessage(e);
  } finally {
    if (stillCurrent()) sourceReviewLlmAnalyzingBlockId.value = null;
    endWorkbenchAction(actionOwner);
  }
}

async function draftSidecarPlan(payload: { request: string }) {
  await applyWorkbenchAction(() => api.sidecarPlanDraft(payload));
}

async function enterReader() {
  const snapshot = buildWorkbenchSnapshot.value;
  if (!snapshot || snapshot.readiness.route !== "reader") return;
  diagnosticWorkbenchBookId.value = null;
  await init();
}

async function openBuildWorkbench() {
  const snapshot = await loadBuildWorkbenchSnapshot();
  if (!snapshot || !workbenchAvailable(snapshot)) return;
  diagnosticWorkbenchBookId.value = snapshot.book_id;
  appSurface.value = "workbench";
}

async function init() {
  try {
    appSurface.value = "loading";
    const desktop = await api.desktopStatus().catch((error) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
    desktopHost.value = Boolean(desktop?.desktop_host);
    desktopLibraryRoot.value = desktop?.library_root ?? "";
    desktopLibraryAvailable.value = desktop?.library_root_available ?? true;
    desktopNeedsBook.value = Boolean(desktop && !desktop.active_book);
    if (desktopLibraryNeedsSelection(desktop)) {
      desktopSettingsOpen.value = true;
      bookPickerOpen.value = false;
      await refreshDesktopProviderStatus();
      return;
    }
    if (desktop && !desktop.active_book) {
      bookPickerOpen.value = true;
      await loadBookLibrary();
      return;
    }
    desktopNeedsBook.value = false;
    const workbench = await loadBuildWorkbenchSnapshot();
    if (!workbench && buildWorkbenchError.value) {
      appSurface.value = "workbench";
      return;
    }
    if (workbench) {
      const surface = chooseAppSurface(workbench);
      if (surface === "workbench") {
        appSurface.value = "workbench";
        return;
      }
    }
    const m = await api.manifest();
    const assets = await api.assetManifest();
    await loadPdfRuntimeArtifacts();
    kindByLid.value = new Map(m.tree.map((n) => [n.lid, n.kind]));
    imageAssetByLid.value = new Map(assets.images.map((img) => [img.lid, img]));
    leafOrder.value = m.tree.filter((n) => n.children.length === 0).map((n) => n.lid);
    await loadOutlineTitles(m.tree);
    const st = await api.state();
    await applyReaderState(st);
    await loadWindow(st.viewport);
    await loadPaperProjectionData();
    await refreshAgentHistory();
    await refreshProfileSurface();
    appSurface.value = "reader";
  } catch (e) {
    appSurface.value = buildWorkbenchSnapshot.value?.readiness.route === "workbench" ? "workbench" : "reader";
    fail(e);
  }
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) {
    throw new Error("桌面命令仅在 Understand Book 应用中可用");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function refreshCodexPluginStatus() {
  codexPluginLoading.value = true;
  codexPluginError.value = "";
  try {
    codexPluginStatus.value = await invokeDesktop<CodexPluginStatus>("codex_plugin_status");
  } catch (error) {
    codexPluginError.value = error instanceof Error ? error.message : String(error);
  } finally {
    codexPluginLoading.value = false;
  }
}

async function openDesktopSettings() {
  desktopSettingsOpen.value = true;
  await Promise.all([refreshCodexPluginStatus(), refreshDesktopProviderStatus()]);
}

function closeDesktopSettings() {
  if (desktopLibraryChanging.value || desktopProviderSaving.value || !desktopLibraryAvailable.value) return;
  desktopSettingsOpen.value = false;
}

async function refreshDesktopProviderStatus() {
  desktopProviderLoading.value = true;
  desktopProviderError.value = "";
  try {
    const status = await invokeDesktop<DesktopProviderStatus>("desktop_provider_status");
    desktopProviderStatus.value = status;
    const draft = desktopProviderDraft(status);
    desktopProviderMode.value = draft.mode;
    desktopProviderBaseUrl.value = draft.baseUrl;
    desktopProviderModel.value = draft.model;
    desktopProviderApiKey.value = draft.apiKey;
  } catch (error) {
    desktopProviderError.value = error instanceof Error ? error.message : String(error);
  } finally {
    desktopProviderLoading.value = false;
  }
}

async function saveDesktopProviderSettings() {
  desktopProviderSaving.value = true;
  desktopProviderError.value = "";
  try {
    const status = await invokeDesktop<DesktopProviderStatus>("save_desktop_provider_settings", {
      input: {
        mode: desktopProviderMode.value,
        api_key: desktopProviderApiKey.value,
        base_url: desktopProviderBaseUrl.value,
        model: desktopProviderModel.value,
      },
    });
    desktopProviderStatus.value = status;
    desktopProviderApiKey.value = "";
  } catch (error) {
    desktopProviderError.value = error instanceof Error ? error.message : String(error);
  } finally {
    desktopProviderSaving.value = false;
  }
}

async function chooseDesktopLibraryDirectory() {
  desktopLibraryChanging.value = true;
  desktopLibraryError.value = "";
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Understand Book 书库位置",
    });
    if (!selected || Array.isArray(selected)) return;
    const result = await invokeDesktop<{ library_root: string }>("set_desktop_library_directory", {
      selectedDir: selected,
    });
    desktopLibraryRoot.value = result.library_root;
    desktopLibraryAvailable.value = true;
    await loadBookLibrary();
    desktopSettingsOpen.value = false;
    if (desktopNeedsBook.value) {
      bookPickerOpen.value = true;
    } else {
      await init();
    }
  } catch (error) {
    desktopLibraryError.value = error instanceof Error ? error.message : String(error);
  } finally {
    desktopLibraryChanging.value = false;
  }
}

async function installCodexPlugin() {
  codexPluginLoading.value = true;
  codexPluginError.value = "";
  try {
    codexPluginStatus.value = await invokeDesktop<CodexPluginStatus>("install_codex_plugin");
  } catch (error) {
    codexPluginError.value = error instanceof Error ? error.message : String(error);
  } finally {
    codexPluginLoading.value = false;
  }
}

function codexPluginStateLabel(state: CodexPluginState): string {
  return {
    installed_by_setup: "已由安装程序安装",
    installed_externally: "已在 Codex 中安装",
    pending_configuration: "等待发布配置",
    codex_not_found: "未找到 Codex",
    not_installed: "尚未安装",
    error: "需要处理",
  }[state];
}
onMounted(init);
onBeforeUnmount(() => {
  if (paperPositionSyncTimer !== null) window.clearTimeout(paperPositionSyncTimer);
  if (profileBackfillPollTimer !== null) window.clearTimeout(profileBackfillPollTimer);
  pdfSelectionTranslation.invalidate("unmount");
});

// ── 四动作 ──
async function onScrollEdge(direction: "up" | "down") {
  if (edgeLoading.value || !viewport.value) return;
  const loaded = segments.value;
  if (!loaded.length || !leafOrder.value.length) return;
  const firstIdx = leafOrder.value.indexOf(loaded[0].lid);
  const lastIdx = leafOrder.value.indexOf(loaded[loaded.length - 1].lid);
  if (firstIdx < 0 || lastIdx < 0) return;
  const count = Math.max(1, viewport.value.width);
  const nextLids = direction === "down"
    ? leafOrder.value.slice(lastIdx + 1, Math.min(lastIdx + 1 + count, leafOrder.value.length))
    : leafOrder.value.slice(Math.max(0, firstIdx - count), firstIdx);
  if (!nextLids.length) return;
  const anchor = direction === "up"
    ? readerPaneRef.value?.captureScrollAnchor(loaded.map((seg) => seg.lid)) ?? null
    : null;
  edgeLoading.value = true;
  try {
    banner.value = "";
    sourceFocus.value = null;
    const next = await hydrateSegments(nextLids);
    segments.value = mergeSegments(segments.value, next, direction === "down" ? "append" : "prepend");
    if (direction === "up") await readerPaneRef.value?.restoreScrollAnchor(anchor);
  } catch (e) {
    fail(e);
  } finally {
    edgeLoading.value = false;
  }
}
async function doGoto(lid: string, focusQuote?: string | null) {
  if (!lid) return;
  try {
    banner.value = "";
    sourceFocus.value = focusQuote === undefined ? null : { lid, quote: focusQuote };
    const gotoEffect = await api.goto(lid);
    outlineNavigationLid.value = lid;
    const navigationTargetLid = resolveReaderNavigationTarget(lid, leafOrder.value)
      ?? gotoEffect.viewport.top_lid;
    await loadWindow(gotoEffect.viewport, "replace", navigationTargetLid);
    queuePaperSelection(lid);
    if (pdfReaderAvailable.value && !hasMappedPdfNavigationTarget(
      lid,
      navigationTargetLid,
      pdfMappedLids.value,
    )) {
      banner.value = `PDF 暂无 ${navigationTargetLid} 的可靠定位，已保留当前 PDF 页面。`;
    }
    await loadPaperProjectionData();
    gotoInput.value = "";
  } catch (e) {
    if (outlineNavigationLid.value === lid) outlineNavigationLid.value = null;
    fail(e);
  }
}
async function focusSource(source: { lid: string; quote: string | null }) {
  await openSourcePreview(source);
}
function focusLocalSource(source: { lid: string; quote: string | null }) {
  void openSourcePreview(source);
}
function sourcePreviewCenterLid(lid: string): string {
  return resolveReaderNavigationTarget(lid, leafOrder.value) ?? lid;
}
function sourcePreviewLids(centerLid: string): string[] {
  const idx = leafOrder.value.indexOf(centerLid);
  if (idx < 0) return [centerLid];
  const before = 3;
  const after = 3;
  return leafOrder.value.slice(Math.max(0, idx - before), Math.min(leafOrder.value.length, idx + after + 1));
}
function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return `[${e.category}] ${e.errorCode}: ${e.message}`;
  return String(e);
}
async function centerSourcePreview() {
  await nextTick();
  const body = sourcePreviewBodyRef.value;
  const target =
    body?.querySelector<HTMLElement>(".source-focus-mark") ??
    body?.querySelector<HTMLElement>(".source-preview-text");
  target?.scrollIntoView({ block: "center" });
}
async function openSourcePreview(source: SourceFocus) {
  const centerLid = sourcePreviewCenterLid(source.lid);
  const focus: SourceFocus = { lid: centerLid, quote: source.quote };
  sourcePreview.value = { focus, segments: [], loading: true, error: null };
  try {
    banner.value = "";
    const previewSegments = await hydrateSegments(sourcePreviewLids(centerLid));
    sourcePreview.value = { focus, segments: previewSegments, loading: false, error: null };
    await centerSourcePreview();
  } catch (e) {
    sourcePreview.value = { focus, segments: [], loading: false, error: errorMessage(e) };
  }
}
function closeSourcePreview() {
  sourcePreview.value = null;
}
async function openSourceInReader() {
  const focus = sourcePreview.value?.focus;
  if (!focus) return;
  closeSourcePreview();
  await doGoto(focus.lid, focus.quote);
}
// block actions:整段/asset 高亮和笔记;段内自由高亮走下面的选区 toolbar。
async function highlightBlock(lid: string) {
  try {
    banner.value = "";
    selectedLid.value = lid;
    await api.highlight(lid);
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
function noteBlock(lid: string) {
  selectedLid.value = lid;
  openNewNote(lid);
}

const pdfSelectionSession = usePdfSelectionDraft((capture) =>
  api.pdfSelectionResolve({ rects: capture.rects, raw_quote: capture.raw_quote }),
);
const pdfSelectionTranslation = usePdfSelectionTranslation((request) =>
  api.pdfSelectionTranslate(request),
);
const pdfSelectionState = pdfSelectionSession.state;
const pdfSelectionTranslationState = pdfSelectionTranslation.state;
const showPdfTranslationSettings = computed(() =>
  desktopHost.value
  && pdfSelectionTranslationState.value.error?.error_code === "TRANSLATION_PROVIDER_UNCONFIGURED",
);
const pdfReselectTarget = ref<{
  kind: "note" | "highlight";
  record: MemoryRecord;
} | null>(null);
const pdfSelectionToolbarStyle = computed(() => {
  const rect = pdfSelectionState.value.capture?.screen_rect;
  if (!rect) return {};
  const center = (rect.left + rect.right) / 2;
  return {
    left: `clamp(178px, ${center}px, calc(100vw - 178px))`,
    top: `${Math.max(8, rect.top - 48)}px`,
  };
});

function onPdfSelectionCapture(capture: PdfSelectionCapture) {
  pdfSelectionTranslation.invalidate("selection");
  void pdfSelectionSession.capture(capture);
}

function cancelPdfSelectionDraftFor(reason: PdfSelectionTranslationInvalidation) {
  pdfSelectionTranslation.invalidate(reason);
  pdfSelectionSession.cancel();
  pdfReselectTarget.value = null;
}

function cancelPdfSelectionDraft() {
  cancelPdfSelectionDraftFor("close");
}

function onPdfViewportInteraction() {
  pdfSelectionTranslation.invalidate("viewport");
  clearOutlineNavigation();
}

function translatePdfSelection() {
  const draft = pdfSelectionState.value.draft;
  if (!draft || pdfSelectionTranslationState.value.phase === "loading") return;
  void pdfSelectionTranslation.start(draft);
}

function closePdfSelectionTranslation() {
  pdfSelectionTranslation.invalidate("close");
}

function retryPdfSelectionTranslation() {
  void pdfSelectionTranslation.retry();
}

async function copyPdfSelectionTranslation(markdown: string) {
  try {
    await navigator.clipboard.writeText(markdown);
    banner.value = "译文已复制";
  } catch (error) {
    fail(error);
  }
}

function selectionContextOf(draft: PdfSelectionDraft): SelectionContext {
  return {
    status: draft.status,
    raw_quote: draft.raw_quote,
    resolved_quote: draft.resolved_quote,
    ranges: draft.ranges,
  };
}

function completePdfSelectionAction() {
  pdfSelectionTranslation.invalidate("existing-action");
  pdfSelectionSession.complete();
  pdfReselectTarget.value = null;
  window.getSelection()?.removeAllRanges();
}

function reselectPdfNote(note: MemoryRecord) {
  pdfSelectionTranslation.invalidate("existing-action");
  pdfSelectionSession.cancel();
  pdfReselectTarget.value = { kind: "note", record: note };
  banner.value = "重新框选 PDF 文字后选择“笔记”；保存成功前原位置保持不变。";
}

function reselectPdfHighlight(highlight: MemoryRecord) {
  pdfSelectionTranslation.invalidate("existing-action");
  pdfSelectionSession.cancel();
  pdfReselectTarget.value = { kind: "highlight", record: highlight };
  banner.value = "重新框选 PDF 文字后选择“高亮”；新范围保存成功前原高亮保持不变。";
}

// ── 自由选区:可跨多个 LID,高亮按 LID 拆 range;Note/Ask AI 锚到起点 LID `[ADR-0031]` ──
interface MarkdownSelectedRange {
  lid: string;
  start: number;
  end: number;
}
const hlPopover = ref<{ x: number; y: number; anchorLid: string; ranges: MarkdownSelectedRange[]; text: string } | null>(null);

function lidElementOf(node: Node | null): HTMLElement | null {
  const el = node && node.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  return el ? el.closest("[data-lid]") : null;
}

function domTextOffset(el: HTMLElement, container: Node, offset: number): number {
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(container, offset);
  return pre.toString().length;
}

function selectedRangeForElement(el: HTMLElement, range: Range, startEl: HTMLElement, endEl: HTMLElement): MarkdownSelectedRange | null {
  const lid = el.getAttribute("data-lid") ?? "";
  const seg = lid ? segmentByLid.value.get(lid) : null;
  if (!lid || !seg) return null;

  if (seg.kind === "formula") {
    return seg.text.length > 0 ? { lid, start: 0, end: seg.text.length } : null;
  }

  const display = displayText(seg);
  let start = 0;
  let end = display.text.length;
  if (el === startEl) start = clampRange(domTextOffset(el, range.startContainer, range.startOffset), display.text.length);
  if (el === endEl) end = clampRange(domTextOffset(el, range.endContainer, range.endOffset), display.text.length);
  if (end <= start) return null;
  return {
    lid,
    start: clampRange(display.offset + start, seg.text.length),
    end: clampRange(display.offset + end, seg.text.length),
  };
}

function selectionRanges(range: Range): MarkdownSelectedRange[] {
  const startEl = lidElementOf(range.startContainer);
  const endEl = lidElementOf(range.endContainer);
  if (!startEl || !endEl) return [];
  const root = startEl.closest(".prose");
  if (!root || !root.contains(endEl)) return [];

  return Array.from(root.querySelectorAll<HTMLElement>("[data-lid]"))
    .filter((el) => range.intersectsNode(el))
    .map((el) => selectedRangeForElement(el, range, startEl, endEl))
    .filter((r): r is MarkdownSelectedRange => r !== null && r.end > r.start);
}

function onSelectSeg(lid: string) {
  selectedLid.value = lid;
  currentReadingLid.value = lid;
  sourceFocus.value = null;
  queuePaperSelection(lid);
}

function onCurrentLid(lid: string) {
  currentReadingLid.value = lid;
}

function clearOutlineNavigation() {
  outlineNavigationLid.value = null;
}

function openFormulaDialog(seg: Segment) {
  if (!seg.formula) return;
  selectedLid.value = seg.lid;
  currentReadingLid.value = seg.lid;
  sourceFocus.value = null;
  formulaDialog.value = seg;
}

function closeFormulaDialog() {
  formulaDialog.value = null;
}


function onProseMouseUp() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    sourceFocus.value = null;
    hlPopover.value = null;
    return;
  }
  const range = sel.getRangeAt(0);
  const ranges = selectionRanges(range);
  if (ranges.length === 0) {
    hlPopover.value = null;
    return;
  }
  const quote = rangeToMarkdown(range);
  if (!quote.trim()) {
    hlPopover.value = null;
    return;
  }
  const rect = range.getBoundingClientRect();
  hlPopover.value = {
    x: rect.left + rect.width / 2,
    y: rect.top,
    anchorLid: ranges[0].lid,
    ranges,
    text: quote,
  };
}
async function confirmHighlight() {
  const p = hlPopover.value;
  if (!p) return;
  try {
    banner.value = "";
    const groupId = p.ranges.length > 1 ? newHighlightGroupId() : undefined;
    await Promise.all(p.ranges.map((r) => api.highlight(r.lid, { start: r.start, end: r.end }, groupId)));
    selectedLid.value = p.anchorLid;
    hlPopover.value = null;
    window.getSelection()?.removeAllRanges();
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
function noteSelection() {
  const p = hlPopover.value;
  if (!p) return;
  const quote = p.text.replace(/\s+/g, " ").trim();
  selectedLid.value = p.anchorLid;
  hlPopover.value = null;
  window.getSelection()?.removeAllRanges();
  openNewNote(p.anchorLid, quote ? `> ${quote}` : "");
}
function askSelection() {
  const p = hlPopover.value;
  if (!p) return;
  const quote = p.text.replace(/\s+/g, " ").trim();
  if (!quote) return;
  askDraft.value = { lid: p.anchorLid, quote };
  selectedLid.value = p.anchorLid;
  agentInput.value = "";
  hlPopover.value = null;
  window.getSelection()?.removeAllRanges();
}
function clearAskDraft() {
  askDraft.value = null;
}

// ── agent 对话区(外层 E agent 主入口)`[ADR-0030]` ──
interface ChatTurn {
  user: string;
  outcome: OuterOutcome | null;
  pending: boolean;
  error?: string;
  questionAnchorLid: string | null;
  questionQuote: AskDraft | null;
}
type AskDraft = AskQuote;
const chat = ref<ChatTurn[]>([]);
const chatSessions = ref<AgentChatSessionSummary[]>([]);
const activeChatSessionId = ref("");
const agentInput = ref("");
const askDraft = ref<AskDraft | null>(null);
const sending = ref(false);

async function highlightPdfSelection() {
  const ready = pdfSelectionState.value.draft;
  if (!ready || ready.status !== "resolved") return;
  const draft = pdfSelectionSession.beginAction();
  if (!draft) return;
  try {
    banner.value = "";
    const groupId = draft.ranges.length > 1 ? newHighlightGroupId() : undefined;
    const created = await Promise.all(draft.ranges.map((selected) =>
      api.highlight(selected.lid, selected.range, groupId),
    ));
    const reselect = pdfReselectTarget.value?.kind === "highlight" ? pdfReselectTarget.value.record : null;
    if (reselect) {
      try {
        await Promise.all(highlightGroupMembers(reselect).map((record) => api.delete(record.mem_id)));
      } catch (error) {
        await Promise.allSettled(created.map((effect) => api.delete(effect.highlight_id)));
        throw error;
      }
    }
    selectedLid.value = draft.ranges[0]?.lid ?? selectedLid.value;
    completePdfSelectionAction();
    await refreshAnnotations();
  } catch (error) {
    pdfSelectionSession.actionFailed(error);
    fail(error);
  }
}

function notePdfSelection() {
  const draft = pdfSelectionSession.beginAction();
  const first = draft?.ranges[0];
  if (!draft || !first) return;
  const quote = draft.raw_quote.replace(/\s+/g, " ").trim();
  selectedLid.value = first.lid;
  const reselect = pdfReselectTarget.value?.kind === "note" ? pdfReselectTarget.value.record : null;
  if (reselect) {
    noteEditor.value = {
      lid: first.lid,
      memId: reselect.mem_id,
      layer: reselect.layer,
      content: reselect.content,
      selectionContext: selectionContextOf(draft),
    };
  } else {
    openNewNote(first.lid, quote ? `> ${quote}` : "", selectionContextOf(draft));
  }
}

function askPdfSelection() {
  const draft = pdfSelectionSession.beginAction();
  const first = draft?.ranges[0];
  if (!draft || !first) return;
  const quote = draft.raw_quote.replace(/\s+/g, " ").trim();
  askDraft.value = {
    lid: first.lid,
    quote,
    ranges: draft.ranges,
    status: draft.status,
    raw_quote: draft.raw_quote,
    resolved_quote: draft.resolved_quote,
  };
  selectedLid.value = first.lid;
  agentInput.value = "";
  completePdfSelectionAction();
}
const showTrace = ref<Record<string, boolean>>({});
const latestTrace = computed<TraceStep[]>(() => {
  for (let i = chat.value.length - 1; i >= 0; i -= 1) {
    const trace = chat.value[i].outcome?.trace;
    if (trace?.length) return trace;
  }
  return [];
});
// 提议处置态:key=`${turnIdx}:${effIdx}` → "已保留" | "已撤销"。
const handled = ref<Record<string, string>>({});
function effKey(ti: number, ei: number) {
  return `${ti}:${ei}`;
}
function effState(ti: number, ei: number): string | undefined {
  return handled.value[effKey(ti, ei)];
}
function toggleTrace(ti: number) {
  showTrace.value[ti] = !showTrace.value[ti];
}

function chatTurnFromHistory(turn: StoredAgentChatTurn): ChatTurn {
  return {
    user: turn.user,
    outcome: turn.outcome,
    pending: false,
    questionAnchorLid: turn.question_anchor_lid,
    questionQuote: turn.question_quote ? { ...turn.question_quote } : null,
  };
}

function applyAgentHistory(history: AgentHistoryResponse) {
  activeChatSessionId.value = history.active_session_id;
  chatSessions.value = history.sessions;
  chat.value = history.current.turns.map(chatTurnFromHistory);
  handled.value = {};
  showTrace.value = {};
}

async function refreshAgentHistory() {
  applyAgentHistory(await api.agentHistory());
}

// AgentEffect 判别(在 TS 里 narrow,避开模板里的联合类型收窄)。
function isGoto(e: AgentEffect): boolean {
  return e.kind === "Goto";
}
function effLabel(e: AgentEffect): string {
  if (e.kind === "PaperMinimap") return `论文地图 · ${e.effect.reason}`;
  if (e.kind === "PaperMinimapProposal") return `论文地图建议 · ${e.proposal.summary}`;
  if (e.kind === "Goto") return `📖 翻到 ${e.after_anchor}`;
  if (e.kind === "Highlight") return `🖍 高亮 ${e.lid}`;
  if (e.kind === "Note") return `📝 笔记 ${e.lid}`;
  if (e.kind === "Layout") return `布局版本 ${e.effect.before.rev} -> ${e.effect.after.rev}`;
  return `布局调整提议 · ${e.proposal.actions.length} 项操作`;
}
function gotoBack(e: AgentEffect): string {
  return e.kind === "Goto" ? e.before_anchor : "";
}
function effectPrimaryLabel(e: AgentEffect): string {
  if (e.kind === "LayoutProposal" || e.kind === "PaperMinimapProposal") return "应用";
  if (e.kind === "Highlight" || e.kind === "Note") return "保留";
  return "";
}
function effectSecondaryLabel(e: AgentEffect): string {
  if (e.kind === "LayoutProposal" || e.kind === "PaperMinimapProposal") return "忽略";
  if (e.kind === "PaperMinimap") return "撤销";
  if (e.kind === "Highlight" || e.kind === "Note") return "撤销";
  return "";
}
function showEffectPrimary(e: AgentEffect): boolean {
  return e.kind === "Highlight" || e.kind === "Note" || e.kind === "LayoutProposal"
    || e.kind === "PaperMinimapProposal";
}
function showEffectSecondary(e: AgentEffect): boolean {
  return e.kind === "Highlight" || e.kind === "Note" || e.kind === "LayoutProposal"
    || e.kind === "PaperMinimap" || e.kind === "PaperMinimapProposal";
}
async function applyLayoutActions(actions: ReaderLayoutAction[]) {
  const outcome = await api.layoutApply({ actions });
  if (outcome.kind === "proposal") {
    pendingLayoutProposal.value = outcome.proposal;
  } else {
    pendingLayoutProposal.value = null;
  }
  const st = await api.state();
  await applyReaderState(st);
}
async function applyPendingLayoutProposal(proposal = pendingLayoutProposal.value) {
  if (!proposal) return;
  const outcome = await api.layoutApply({
    proposal_id: proposal.proposal_id,
    base_layout_rev: layoutRevNumber(proposal.base_layout_rev),
  });
  pendingLayoutProposal.value = outcome.kind === "proposal" ? outcome.proposal : null;
  const st = await api.state();
  await applyReaderState(st);
}
async function submitAgentMessage(msg: string, displayUser: string, draft: AskDraft | null) {
  if (sending.value) return;
  const questionAnchorLid = draft?.lid ?? selectedLid.value ?? viewport.value?.top_lid ?? null;
  const turn: ChatTurn = {
    user: displayUser,
    outcome: null,
    pending: true,
    questionAnchorLid,
    questionQuote: draft ? { ...draft } : null,
  };
  chat.value.push(turn);
  sending.value = true;
  banner.value = "";
  try {
    turn.outcome = await api.agentChat(msg, {
      display_user: displayUser,
      question_anchor_lid: questionAnchorLid,
      question_quote: draft ? { ...draft } : null,
    });
    const proposalEffect = turn.outcome.effects.find((effect) => effect.kind === "LayoutProposal");
    if (proposalEffect?.kind === "LayoutProposal") pendingLayoutProposal.value = proposalEffect.proposal;
    const minimapEffect = [...turn.outcome.effects]
      .reverse()
      .find((effect) => effect.kind === "PaperMinimap");
    if (minimapEffect?.kind === "PaperMinimap") lastPaperMinimapEffect.value = minimapEffect.effect;
    // agent 可能驱动了共享 reader 视口 / 落了 session 标注 → 同步阅读区。
    await syncViewport(true, hasSuccessfulReaderNavigation(turn.outcome.trace));
    await refreshAgentHistory();
    await refreshProfileSurface(true);
  } catch (e) {
    turn.error = e instanceof ApiError ? `[${e.category}] ${e.errorCode}: ${e.message}` : String(e);
    await refreshProfileSurface(true);
  } finally {
    turn.pending = false;
    sending.value = false;
  }
}

async function sendAgent() {
  const msg = agentInput.value.trim();
  if (!msg) return;
  const draft = askDraft.value;
  agentInput.value = "";
  askDraft.value = null;
  await submitAgentMessage(msg, msg, draft);
}

async function confirmSensitiveProfile() {
  if (sending.value || profileMemoryBusy.value) return;
  profileMemoryNotice.value = "正在确认敏感画像";
  await submitAgentMessage("confirm save", "确认保存敏感画像", null);
  if (!profileMemory.value?.status.pending_sensitive_confirmation) {
    profileMemoryNotice.value = "敏感画像已处理";
  }
}

// 提议「撤销」:Goto→ 返回回合前 anchor;Highlight/Note→ memory.delete(mem_id)。
async function undoEffect(ti: number, ei: number, e: AgentEffect) {
  try {
    banner.value = "";
    if (e.kind === "Goto") {
      await api.goto(e.before_anchor);
      await syncViewport();
    } else if (e.kind === "Highlight" || e.kind === "Note") {
      await api.delete(e.mem_id);
      await refreshAnnotations();
    } else if (e.kind === "LayoutProposal") {
      if (pendingLayoutProposal.value?.proposal_id === e.proposal.proposal_id) pendingLayoutProposal.value = null;
    } else if (e.kind === "PaperMinimap") {
      const snapshot = paperMinimapSnapshot.value ?? await api.paperMinimapState();
      await api.paperMinimapApply({
        base_state_rev: Number(snapshot.state.rev),
        undo_effect_id: e.effect.effect_id,
      });
      if (lastPaperMinimapEffect.value?.effect_id === e.effect.effect_id) lastPaperMinimapEffect.value = null;
      paperMinimapSnapshot.value = await api.paperMinimapState();
    } else if (e.kind === "PaperMinimapProposal") {
      await api.paperMinimapApply({
        base_state_rev: Number(e.proposal.base_state_rev),
        base_map_rev: e.proposal.base_map_rev,
        dismiss_proposal_id: e.proposal.proposal_id,
      });
    }
    handled.value[effKey(ti, ei)] = e.kind === "LayoutProposal" || e.kind === "PaperMinimapProposal"
      ? "已忽略"
      : "已撤销";
  } catch (err) {
    fail(err);
  }
}

// 提议「保留」(Highlight/Note):同内容以 long_term 再 save → 同 mem_id upsert 升级层。
async function keepEffect(ti: number, ei: number, e: AgentEffect) {
  if (e.kind === "PaperMinimap") return;
  if (e.kind === "Goto" || e.kind === "Layout") return;
  try {
    banner.value = "";
    if (e.kind === "LayoutProposal") {
      await applyPendingLayoutProposal(e.proposal);
      handled.value[effKey(ti, ei)] = "已应用";
      return;
    }
    if (e.kind === "PaperMinimapProposal") {
      const outcome = await api.paperMinimapApply({
        proposal_id: e.proposal.proposal_id,
        base_map_rev: e.proposal.base_map_rev,
        base_state_rev: Number(e.proposal.base_state_rev),
      });
      if (outcome.kind === "effect") lastPaperMinimapEffect.value = outcome.effect;
      paperMinimapSnapshot.value = await api.paperMinimapState();
      handled.value[effKey(ti, ei)] = "已应用";
      return;
    }
    let content = e.kind === "Note" ? e.text : "";
    if (e.kind === "Highlight") {
      const recs = await api.recall({ layer: "session" });
      content = recs.find((r) => r.mem_id === e.mem_id)?.content ?? "";
    }
    await api.save({
      type: e.kind === "Highlight" ? "highlight" : "note",
      anchor_lid: e.lid,
      content,
      layer: "long_term",
    });
    await refreshAnnotations();
    handled.value[effKey(ti, ei)] = "已保留";
  } catch (err) {
    fail(err);
  }
}

async function saveAgentSelection(turn: ChatTurn, text: string) {
  const selectionContext = selectionContextForAgentNote(turn.questionQuote);
  const anchor = selectionContext?.ranges[0]?.lid ?? turn.questionAnchorLid;
  const content = text.trim();
  if (!content || !anchor) return;
  const sourceQuote = turn.questionQuote?.quote.replace(/\s+/g, " ").trim();
  const noteContent = sourceQuote ? `> ${sourceQuote}\n\n${content}` : content;
  try {
    banner.value = "";
    await api.save({
      type: "note",
      anchor_lid: anchor,
      content: noteContent,
      layer: "long_term",
      selection_context: selectionContext,
    });
    if (viewport.value?.visible_lids.includes(anchor)) {
      await refreshAnnotations();
    } else {
      await loadWindow((await api.goto(anchor)).viewport);
    }
  } catch (e) {
    fail(e);
  }
}

async function newChat() {
  try {
    const response = await api.agentNew();
    applyAgentHistory(response.history);
    askDraft.value = null;
    agentInput.value = "";
    await refreshProfileSurface(true);
  } catch (e) {
    fail(e);
  }
}
async function selectChat(sessionId: string) {
  if (!sessionId || sessionId === activeChatSessionId.value) return;
  try {
    applyAgentHistory(await api.agentHistorySelect(sessionId));
    askDraft.value = null;
    agentInput.value = "";
    await refreshProfileSurface(true);
  } catch (e) {
    fail(e);
  }
}
async function deleteChat(sessionId: string) {
  if (!sessionId) return;
  if (!window.confirm("删除这个对话历史?")) return;
  try {
    applyAgentHistory(await api.agentHistoryDelete(sessionId));
    askDraft.value = null;
    agentInput.value = "";
    await refreshProfileSurface(true);
  } catch (e) {
    fail(e);
  }
}
async function loadBookLibrary() {
  bookPickerLoading.value = true;
  bookPickerError.value = null;
  try {
    const library = await api.bookLibrary();
    bookPickerRoot.value = library.root;
    bookPickerBooks.value = library.books;
    if (!bookPickerDir.value.trim() && library.books.length > 0) {
      bookPickerDir.value = library.books[0].dir;
    }
  } catch (e) {
    bookPickerError.value = e instanceof Error ? e.message : String(e);
  } finally {
    bookPickerLoading.value = false;
  }
}

async function openBook() {
  bookPickerOpen.value = true;
  if (bookPickerBooks.value.length === 0) {
    await loadBookLibrary();
  }
}

function switchBookPickerMode(mode: "open" | "create") {
  bookPickerMode.value = mode;
  bookPickerError.value = null;
}

function slugifyBookId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function selectNewBookMarkdown(file: File | null) {
  newBookMarkdown.value = file;
  if (!file) return;
  const inferredTitle = file.name.replace(/\.md$/i, "");
  if (!newBookTitle.value.trim()) newBookTitle.value = inferredTitle;
  if (!newBookId.value.trim()) newBookId.value = slugifyBookId(inferredTitle);
}

function readLocalFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取 Markdown 文件失败"));
    reader.readAsText(file);
  });
}

function readLocalFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      resolve(raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取 PDF 文件失败"));
    reader.readAsDataURL(file);
  });
}

async function submitCreateBook() {
  const bookId = newBookId.value.trim();
  const markdown = newBookMarkdown.value;
  const pdf = newBookPdf.value;
  if (!bookId) {
    bookPickerError.value = "请输入由小写字母、数字和连字符组成的书 ID。";
    return;
  }
  if (!markdown || !pdf) {
    bookPickerError.value = "请选择 Markdown 和 PDF 文件。";
    return;
  }
  try {
    openingBook.value = true;
    banner.value = "";
    bookPickerError.value = null;
    const snapshot = await api.createBook({
      book_id: bookId,
      display_title: newBookTitle.value.trim() || markdown.name.replace(/\.md$/i, ""),
      paper_md_text: await readLocalFileAsText(markdown),
      paper_pdf_base64: await readLocalFileAsBase64(pdf),
    });
    resetBookSessionUi();
    buildWorkbenchSnapshot.value = snapshot;
    appSurface.value = "workbench";
    bookPickerOpen.value = false;
    bookPickerMode.value = "open";
    newBookTitle.value = "";
    newBookId.value = "";
    newBookMarkdown.value = null;
    newBookPdf.value = null;
  } catch (e) {
    bookPickerError.value = e instanceof Error ? e.message : String(e);
    fail(e);
  } finally {
    openingBook.value = false;
  }
}

function closeBookPicker() {
  if (openingBook.value || desktopNeedsBook.value) return;
  bookPickerOpen.value = false;
}

function resetBookSessionUi() {
  buildWorkbenchActionOwner += 1;
  sourceReviewLlmBatchRunToken += 1;
  sourceReviewLlmRequestToken += 1;
  leafOrder.value = [];
  kindByLid.value = new Map();
  imageAssetByLid.value = new Map();
  appSurface.value = "loading";
  diagnosticWorkbenchBookId.value = null;
  buildWorkbenchSnapshot.value = null;
  buildWorkbenchLoading.value = false;
  buildWorkbenchError.value = null;
  buildWorkbenchConfirming.value = false;
  buildWorkbenchImporting.value = false;
  buildWorkbenchActioning.value = false;
  sourceReviewLlmSuggestions.value = {};
  sourceReviewLlmAnalyzingBlockId.value = null;
  sourceReviewLlmErrors.value = {};
  sourceReviewLlmBatch.value = null;
  sourceManifest.value = null;
  pdfSourceMap.value = null;
  pdfRuntimeError.value = null;
  outlineItems.value = [];
  titleByLid.value = new Map();
  viewport.value = null;
  segments.value = [];
  annotations.value = [];
  resetPdfAnnotationProjection();
  cancelPdfSelectionDraftFor("book-switch");
  noteEditor.value = null;
  selectedLid.value = null;
  currentReadingLid.value = null;
  outlineNavigationLid.value = null;
  formulaDialog.value = null;
  profileSummary.value = null;
  profileManifest.value = null;
  profileMemoryRequestSeq += 1;
  profileMemory.value = null;
  profileMemoryLoading.value = false;
  profileMemoryBusy.value = false;
  profileMemoryError.value = null;
  profileMemoryNotice.value = null;
  profileBackfillRequestSeq += 1;
  if (profileBackfillPollTimer !== null) window.clearTimeout(profileBackfillPollTimer);
  profileBackfillPollTimer = null;
  profileBackfill.value = null;
  profileBackfillLoading.value = false;
  profileBackfillBusy.value = false;
  profileBackfillError.value = null;
  profileBackfillNotice.value = null;
  profileUpdateStates.value = {};
  readerLayout.value = null;
  pendingLayoutProposal.value = null;
  resetPaperProjectionData();
  chapterTitle.value = "";
  gotoInput.value = "";
  outlineSearch.value = "";
  chat.value = [];
  chatSessions.value = [];
  activeChatSessionId.value = "";
  askDraft.value = null;
  agentInput.value = "";
  handled.value = {};
  showTrace.value = {};
}

async function submitOpenBook(dir = bookPickerDir.value) {
  const target = dir.trim();
  if (!target) {
    bookPickerError.value = "Choose a book directory or enter one manually.";
    return;
  }
  try {
    openingBook.value = true;
    banner.value = "";
    bookPickerError.value = null;
    await api.openBook(target);
    desktopNeedsBook.value = false;
    resetBookSessionUi();
    await init();
    bookPickerOpen.value = false;
  } catch (e) {
    bookPickerError.value = e instanceof Error ? e.message : String(e);
    fail(e);
  } finally {
    openingBook.value = false;
  }
}
</script>

<template>
  <div class="app">
    <TopBar
      :chapter-title="appSurface === 'workbench' ? '构建工作台' : activeChapterTitle"
      :progress-pct="appSurface === 'reader' ? progressPct : 0"
      :anchor-lid="readingAnchorLid"
      :debug-open="debugOpen"
      :left-rail-open="leftRailOpen"
      :workbench-available="appSurface === 'reader' && workbenchAvailable(buildWorkbenchSnapshot)"
      :desktop-host="desktopHost"
      @new-chat="newChat"
      @open-workbench="openBuildWorkbench"
      @open-book="openBook"
      @open-settings="openDesktopSettings"
      @toggle-left-rail="leftRailOpen = !leftRailOpen"
      @toggle-debug="debugOpen = !debugOpen"
    />

    <p v-if="banner" class="banner">{{ banner }}</p>

    <div v-if="desktopSettingsOpen" class="desktop-settings-modal" @click.self="closeDesktopSettings">
      <section class="desktop-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-settings-title">
        <header class="desktop-settings-head">
          <div>
            <p class="formula-dialog-kicker">桌面应用</p>
            <h3 id="desktop-settings-title">设置</h3>
          </div>
          <button
            class="formula-dialog-close"
            title="关闭"
            aria-label="关闭设置"
            :disabled="desktopLibraryChanging || desktopProviderSaving || !desktopLibraryAvailable"
            @click="closeDesktopSettings"
          >×</button>
        </header>
        <div class="desktop-settings-body">
          <div class="desktop-settings-section">
            <div class="desktop-settings-row">
              <div>
                <strong>书库位置</strong>
                <p>{{ desktopLibraryAvailable ? "用于扫描和新建书" : "当前目录不可用，请重新选择" }}</p>
              </div>
              <button
                class="desktop-library-button"
                :disabled="desktopLibraryChanging"
                @click="chooseDesktopLibraryDirectory"
              >
                <FolderOpen :size="17" aria-hidden="true" />
                <span>{{ desktopLibraryChanging ? "处理中" : "选择目录" }}</span>
              </button>
            </div>
            <p v-if="desktopLibraryRoot" class="desktop-settings-path">{{ desktopLibraryRoot }}</p>
            <p v-if="desktopLibraryError" class="book-picker-error">{{ desktopLibraryError }}</p>
          </div>
          <div class="desktop-settings-section">
            <div class="desktop-settings-row desktop-provider-heading">
              <div>
                <strong>Reader Provider</strong>
                <p>{{ desktopProviderLoading ? "正在读取..." : desktopProviderStatusLabel(desktopProviderStatus) }}</p>
              </div>
              <div class="desktop-provider-mode" role="group" aria-label="Provider 模式">
                <button
                  type="button"
                  :class="{ active: desktopProviderMode === 'native' }"
                  :aria-pressed="desktopProviderMode === 'native'"
                  :disabled="desktopProviderSaving"
                  @click="desktopProviderMode = 'native'"
                >Native</button>
                <button
                  type="button"
                  :class="{ active: desktopProviderMode === 'react' }"
                  :aria-pressed="desktopProviderMode === 'react'"
                  :disabled="desktopProviderSaving"
                  @click="desktopProviderMode = 'react'"
                >ReAct</button>
              </div>
            </div>
            <div class="desktop-provider-grid">
              <label>
                <span>Base URL</span>
                <input v-model="desktopProviderBaseUrl" type="url" :disabled="desktopProviderSaving" placeholder="https://provider.example/v1" />
              </label>
              <label>
                <span>Model</span>
                <input v-model="desktopProviderModel" :disabled="desktopProviderSaving" placeholder="model-name" />
              </label>
              <label class="desktop-provider-key">
                <span>API Key</span>
                <input
                  v-model="desktopProviderApiKey"
                  type="password"
                  autocomplete="new-password"
                  :disabled="desktopProviderSaving"
                  :placeholder="desktopProviderStatus?.api_key_configured ? '留空保留已保存密钥' : '输入 API Key'"
                />
              </label>
            </div>
            <div class="desktop-provider-actions">
              <p>API Key 明文保存在当前 Windows 用户设置中。</p>
              <button
                class="primary-action desktop-provider-save"
                :disabled="desktopProviderSaving || !desktopProviderBaseUrl.trim() || !desktopProviderModel.trim()"
                @click="saveDesktopProviderSettings"
              >
                <Save :size="16" aria-hidden="true" />
                <span>{{ desktopProviderSaving ? "应用中" : "保存并应用" }}</span>
              </button>
            </div>
            <p v-if="desktopProviderError" class="book-picker-error">{{ desktopProviderError }}</p>
          </div>
          <div class="desktop-settings-section">
            <div class="desktop-settings-row">
              <div>
                <strong>Codex 预构建插件</strong>
                <p v-if="codexPluginStatus">{{ codexPluginStateLabel(codexPluginStatus.state) }}</p>
                <p v-else>{{ codexPluginLoading ? "正在检测..." : "尚未检测" }}</p>
              </div>
              <button
                v-if="codexPluginStatus && !['installed_by_setup', 'installed_externally'].includes(codexPluginStatus.state)"
                class="primary-action"
                :disabled="codexPluginLoading"
                @click="installCodexPlugin"
              >
                {{ codexPluginLoading ? "处理中..." : "安装或重试" }}
              </button>
              <button v-else :disabled="codexPluginLoading" @click="refreshCodexPluginStatus">刷新</button>
            </div>
            <p v-if="codexPluginStatus" class="desktop-settings-message">{{ codexPluginStatus.message }}</p>
            <p v-if="codexPluginStatus?.codex_path" class="desktop-settings-path">{{ codexPluginStatus.codex_path }}</p>
            <p v-if="codexPluginError" class="book-picker-error">{{ codexPluginError }}</p>
          </div>
        </div>
      </section>
    </div>

    <div v-if="bookPickerOpen" class="book-picker-modal" @click.self="closeBookPicker">
      <section class="book-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="book-picker-title">
        <header class="book-picker-head">
          <div>
            <p class="formula-dialog-kicker">书库</p>
            <h3 id="book-picker-title">书库</h3>
          </div>
          <button class="formula-dialog-close" title="关闭" aria-label="关闭书库" @click="closeBookPicker">×</button>
        </header>

        <div class="book-picker-tabs" role="tablist" aria-label="书库操作">
          <button
            role="tab"
            :aria-selected="bookPickerMode === 'open'"
            :class="{ active: bookPickerMode === 'open' }"
            @click="switchBookPickerMode('open')"
          >
            打开
          </button>
          <button
            role="tab"
            :aria-selected="bookPickerMode === 'create'"
            :class="{ active: bookPickerMode === 'create' }"
            @click="switchBookPickerMode('create')"
          >
            新建论文书
          </button>
        </div>

        <div v-if="bookPickerMode === 'open'" class="book-picker-body">
          <div class="book-picker-input-row">
            <label>
              <span>目录</span>
              <input
                v-model="bookPickerDir"
                :disabled="openingBook"
                placeholder=".understand-book/book-id"
                @keydown.enter.prevent="submitOpenBook()"
              />
            </label>
            <button :disabled="bookPickerLoading || openingBook" @click="loadBookLibrary">
              {{ bookPickerLoading ? "加载中" : "刷新" }}
            </button>
          </div>

          <p v-if="bookPickerRoot" class="book-picker-root">{{ bookPickerRoot }}</p>
          <p v-if="bookPickerError" class="book-picker-error">{{ bookPickerError }}</p>
          <p v-if="bookPickerLoading" class="book-picker-state">正在扫描 .understand-book...</p>
          <p v-else-if="bookPickerBooks.length === 0" class="book-picker-state">没有找到已构建的书。</p>

          <div v-else class="book-picker-list">
            <button
              v-for="book in bookPickerBooks"
              :key="book.dir"
              class="book-picker-card"
              :class="{ active: bookPickerDir === book.dir }"
              :disabled="openingBook"
              @click="bookPickerDir = book.dir"
              @dblclick="submitOpenBook(book.dir)"
            >
              <span class="book-picker-card-title">
                <strong>{{ book.book_id || book.name }}</strong>
                <small v-if="book.route === 'workbench'">构建中</small>
              </span>
              <span>{{ book.dir }}</span>
            </button>
          </div>
        </div>

        <div v-else class="book-picker-body">
          <div class="book-create-grid">
            <label>
              <span>标题</span>
              <input v-model="newBookTitle" :disabled="openingBook" placeholder="论文标题" />
            </label>
            <label>
              <span>书 ID</span>
              <input
                v-model="newBookId"
                :disabled="openingBook"
                placeholder="paper-title"
                autocomplete="off"
                @keydown.enter.prevent="submitCreateBook"
              />
            </label>
            <FileDropField
              :model-value="newBookMarkdown"
              label="Markdown"
              accept=".md,text/markdown,text/plain"
              accept-label=".md"
              kind="markdown"
              :disabled="openingBook"
              @update:model-value="selectNewBookMarkdown"
            />
            <FileDropField
              v-model="newBookPdf"
              label="PDF"
              accept=".pdf,application/pdf"
              accept-label=".pdf"
              kind="pdf"
              :disabled="openingBook"
            />
          </div>
          <p v-if="bookPickerRoot" class="book-picker-root">{{ bookPickerRoot }}</p>
          <p v-if="bookPickerError" class="book-picker-error">{{ bookPickerError }}</p>
        </div>

        <footer class="book-picker-actions">
          <button :disabled="openingBook" @click="closeBookPicker">取消</button>
          <button
            v-if="bookPickerMode === 'open'"
            class="primary-action"
            :disabled="openingBook || !bookPickerDir.trim()"
            @click="submitOpenBook()"
          >
            {{ openingBook ? "打开中" : "打开" }}
          </button>
          <button
            v-else
            class="primary-action"
            :disabled="openingBook || !newBookId.trim() || !newBookMarkdown || !newBookPdf"
            @click="submitCreateBook"
          >
            {{ openingBook ? "创建中" : "创建并构建" }}
          </button>
        </footer>
      </section>
    </div>

    <BuildWorkbenchPane
      v-if="appSurface === 'workbench'"
      :snapshot="buildWorkbenchSnapshot"
      :loading="buildWorkbenchLoading"
      :error="buildWorkbenchError"
      :confirming="buildWorkbenchConfirming"
      :importing="buildWorkbenchImporting"
      :actioning="buildWorkbenchActioning"
      :pdf-url="api.pdfOriginalUrl()"
      :source-review-llm-suggestions="sourceReviewLlmSuggestions"
      :source-review-llm-analyzing-block-id="sourceReviewLlmAnalyzingBlockId"
      :source-review-llm-errors="sourceReviewLlmErrors"
      :source-review-llm-batch="sourceReviewLlmBatch"
      @refresh="refreshBuildWorkbench"
      @import-input="importWorkbenchInput"
      @create-job="createBuildJob"
      @start-job="startBuildJob"
      @resume-job="resumeBuildJob"
      @resolve-decision="resolveBuildDecision"
      @resolve-permission="resolveExecutorPermission"
      @resolve-source-review="resolveSourceReview"
      @resolve-source-review-group="resolveSourceReviewGroup"
      @analyze-source-review="analyzeSourceReview"
      @apply-all-source-review-with-llm="applyAllSourceReviewWithLlm"
      @draft-sidecar-plan="draftSidecarPlan"
      @confirm-sidecar-plan="confirmSidecarPlan"
      @enter-reader="enterReader"
    />

    <main v-else-if="appSurface === 'loading'" class="app-loading">正在加载工作区...</main>

    <div v-else class="workspace-grid" :class="{ 'left-collapsed': !leftRailOpen }" :style="workspaceStyle">
      <LeftRail
        v-show="leftRailOpen"
        v-model:goto-input="gotoInput"
        v-model:search-query="outlineSearch"
        :outline-items="outlineItems"
        :progress-pct="progressPct"
        :anchor-lid="outlineAnchorLid"
        :selected-lid="selectedLid"
        :leaf-count="leafOrder.length"
        :debug-open="debugOpen"
        :paper-enabled="isPaperProfile"
        :paper-loading="paperProjectionLoading"
        :paper-error="paperProjectionError"
        :paper-minimap-base="paperMinimapSnapshot?.base ?? null"
        :paper-minimap-state="paperMinimapSnapshot?.state ?? null"
        :paper-minimap-lens="paperMinimapSnapshot?.lens ?? null"
        :paper-minimap-localization="paperMinimapLocalization"
        :paper-minimap-effect-reason="lastPaperMinimapEffect?.reason ?? null"
        :paper-minimap-undo-available="!!lastPaperMinimapEffect"
        :paper-minimap-action-busy="paperMinimapActionBusy"
        @goto="doGoto"
        @paper-minimap-toggle="togglePaperMinimap"
        @paper-minimap-mode="setPaperMinimapMode"
        @paper-minimap-layer="setPaperMinimapLayer"
        @paper-minimap-pin="togglePaperMinimapPin"
        @paper-minimap-undo="undoLastPaperMinimapEffect"
      />

      <div
        class="resize-handle resize-handle-left"
        role="separator"
        aria-orientation="vertical"
        title="调整目录栏宽度"
        @mousedown="startResize('left', $event)"
      ></div>

      <PdfReaderPane
        v-if="pdfReaderAvailable"
        :source-manifest="sourceManifest"
        :source-map="pdfSourceMap"
        :pdf-url="api.pdfOriginalUrl()"
        :active-lid="pdfActiveLid"
        :selected-lid="selectedLid"
        :annotation-projection="pdfAnnotationProjection"
        :annotation-error="pdfAnnotationProjectionError"
        :render-markdown="renderMarkdown"
        @goto="doGoto"
        @viewport-change="onPdfViewportChange"
        @focus-source="focusLocalSource"
        @selection-capture="onPdfSelectionCapture"
        @selection-cancel="cancelPdfSelectionDraft"
        @viewport-interaction="onPdfViewportInteraction"
        @edit-note="openEditNote"
        @delete-note="deleteNote"
        @reselect-note="reselectPdfNote"
        @delete-highlight="deleteHighlight"
        @reselect-highlight="reselectPdfHighlight"
      />

      <ReaderPane
        v-else
        ref="readerPaneRef"
        :segments="segments"
        :viewport-anchor="readingAnchorLid"
        :selected-lid="selectedLid"
        :render-seg="renderSeg"
        :render-markdown="renderMarkdown"
        :markdown-heading-level="markdownHeadingLevel"
        :is-asset="isAsset"
        :is-highlighted="isHighlighted"
        :highlights-of="highlightsOf"
        :highlight-cards-of="highlightCardsOf"
        :visible-notes="visibleNotes"
        :hl-excerpt="hlExcerpt"
        :image-meta="imageMeta"
        :image-asset="imageAssetFor"
        @select="onSelectSeg"
        @prose-mouse-up="onProseMouseUp"
        @current-lid="onCurrentLid"
        @viewport-interaction="clearOutlineNavigation"
        @scroll-edge="onScrollEdge"
        @highlight-block="highlightBlock"
        @note-block="noteBlock"
        @goto="doGoto"
        @focus-source-local="focusLocalSource"
        @open-formula="openFormulaDialog"
        @modify-highlight="modifyHighlight"
        @delete-highlight="deleteHighlight"
        @edit-note="openEditNote"
        @delete-note="deleteNote"
      />

      <div
        class="resize-handle resize-handle-right"
        role="separator"
        aria-orientation="vertical"
        title="调整上下文栏宽度"
        @mousedown="startResize('right', $event)"
      ></div>

      <RightRail
        v-model:agent-input="agentInput"
        :chat="chat"
        :chat-sessions="chatSessions"
        :active-chat-session-id="activeChatSessionId"
        :sending="sending"
        :show-trace="showTrace"
        :latest-trace="latestTrace"
        :selected-lid="selectedLid"
        :selected-formula="selectedFormula"
        :context-notes="allNotes"
        :context-highlights="allHighlights"
        :annotation-location="pdfAnnotationProjection.location_by_mem_id"
        :render-markdown="renderMarkdown"
        :eff-label="effLabel"
        :eff-state="effState"
        :is-goto="isGoto"
        :show-effect-primary="showEffectPrimary"
        :show-effect-secondary="showEffectSecondary"
        :effect-primary-label="effectPrimaryLabel"
        :effect-secondary-label="effectSecondaryLabel"
        :goto-back="gotoBack"
        :ask-draft="askDraft"
        :profile-memory="profileMemory"
        :profile-memory-loading="profileMemoryLoading"
        :profile-memory-busy="profileMemoryBusy || sending"
        :profile-memory-error="profileMemoryError"
        :profile-memory-notice="profileMemoryNotice"
        :profile-backfill="profileBackfill"
        :profile-backfill-loading="profileBackfillLoading"
        :profile-backfill-busy="profileBackfillBusy || sending"
        :profile-backfill-error="profileBackfillError"
        :profile-backfill-notice="profileBackfillNotice"
        :profile-update-states="profileUpdateStates"
        @send-agent="sendAgent"
        @new-chat="newChat"
        @select-chat="selectChat"
        @delete-chat="deleteChat"
        @clear-ask="clearAskDraft"
        @goto="doGoto"
        @focus-source="focusSource"
        @toggle-trace="toggleTrace"
        @undo-effect="undoEffect"
        @keep-effect="keepEffect"
        @save-answer-selection="saveAgentSelection"
        @refresh-profile="refreshProfileSurface()"
        @mutate-profile="mutateProfile"
        @confirm-sensitive-profile="confirmSensitiveProfile"
        @start-profile-backfill="startProfileBackfill"
        @mutate-profile-backfill="mutateProfileBackfill"
        @undo-profile-update="undoProfileUpdate"
      />
    </div>

    <div
      v-if="pdfSelectionState.capture && (pdfSelectionState.phase === 'error' || pdfSelectionState.draft)"
      class="hl-popover pdf-selection-toolbar"
      :style="pdfSelectionToolbarStyle"
      role="toolbar"
      aria-label="PDF 选区操作"
    >
      <template v-if="pdfSelectionState.phase === 'error'">
        <span class="pdf-selection-status error">{{ pdfSelectionState.error }}</span>
        <button title="重试定位" aria-label="重试定位" @mousedown.prevent="pdfSelectionSession.retry">
          <RotateCcw :size="16" />
        </button>
      </template>
      <template v-else-if="pdfSelectionState.draft">
        <span v-if="pdfSelectionState.draft.status === 'partial'" class="pdf-selection-status">部分定位</span>
        <button
          title="高亮"
          :disabled="pdfSelectionState.phase === 'saving' || pdfSelectionTranslationState.phase === 'loading' || pdfSelectionState.draft.status !== 'resolved'"
          @mousedown.prevent="highlightPdfSelection"
        >
          <Highlighter :size="16" />
          <span>高亮</span>
        </button>
        <button
          title="笔记"
          :disabled="pdfSelectionState.phase === 'saving' || pdfSelectionTranslationState.phase === 'loading'"
          @mousedown.prevent="notePdfSelection"
        >
          <MessageSquareText :size="16" />
          <span>笔记</span>
        </button>
        <button
          title="问 AI"
          :disabled="pdfSelectionState.phase === 'saving' || pdfSelectionTranslationState.phase === 'loading'"
          @mousedown.prevent="askPdfSelection"
        >
          <Sparkles :size="16" />
          <span>问 AI</span>
        </button>
        <button
          title="翻译"
          :disabled="pdfSelectionState.phase === 'saving' || pdfSelectionTranslationState.phase === 'loading'"
          @mousedown.prevent="translatePdfSelection"
        >
          <Languages :size="16" />
          <span>翻译</span>
        </button>
        <span v-if="pdfSelectionState.error" class="pdf-selection-status error">{{ pdfSelectionState.error }}</span>
      </template>
      <button title="关闭" aria-label="关闭 PDF 选区操作" @mousedown.prevent="cancelPdfSelectionDraft">
        <X :size="16" />
      </button>
    </div>

    <PdfSelectionTranslationSurface
      v-if="pdfSelectionTranslationState.phase !== 'idle' && pdfSelectionState.draft"
      :state="pdfSelectionTranslationState"
      :anchor-rect="pdfSelectionState.draft.screen_rect"
      :render-markdown="renderMarkdown"
      :show-settings="showPdfTranslationSettings"
      @close="closePdfSelectionTranslation"
      @retry="retryPdfSelectionTranslation"
      @settings="openDesktopSettings"
      @copy="copyPdfSelectionTranslation"
    />

    <div
      v-if="hlPopover"
      class="hl-popover"
      :style="{ left: hlPopover.x + 'px', top: hlPopover.y - 40 + 'px' }"
    >
      <button @mousedown.prevent="confirmHighlight">高亮</button>
      <button @mousedown.prevent="noteSelection">笔记</button>
      <button @mousedown.prevent="askSelection">问 AI</button>
    </div>

    <div v-if="formulaDialog" class="formula-modal" @click.self="closeFormulaDialog">
      <section
        class="formula-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`formula-dialog-title-${formulaDialog.lid}`"
      >
        <header class="formula-dialog-head">
          <div>
            <p class="formula-dialog-kicker">公式剖面</p>
            <h3 :id="`formula-dialog-title-${formulaDialog.lid}`">{{ formulaDialog.lid }}</h3>
          </div>
          <button class="formula-dialog-close" title="关闭" aria-label="关闭公式剖面" @click="closeFormulaDialog">×</button>
        </header>
        <div class="formula-dialog-body">
          <pre class="formula-dialog-source" v-html="renderSeg(formulaDialog)"></pre>
          <div v-if="formulaDialog.formula" class="formula-dialog-profile">
            <p class="formula-dialog-meaning">{{ formulaDialog.formula.composition.meaning }}</p>
            <div v-if="formulaDialog.formula.parameters.length" class="formula-dialog-section">
              <h4>参数</h4>
              <dl>
                <template v-for="p in formulaDialog.formula.parameters" :key="p.symbol">
                  <dt>
                    <span class="formula-param-symbol" v-html="renderFormulaSymbol(p.symbol)"></span>
                    <span v-if="p.label" class="formula-param-label"> · {{ p.label }}</span>
                  </dt>
                  <dd>
                    {{ p.meaning }}
                    <span v-if="p.unit"> · 单位: {{ p.unit }}</span>
                    <span v-if="p.domain"> · 取值域: {{ p.domain }}</span>
                  </dd>
                </template>
              </dl>
            </div>
            <div v-if="formulaDialog.formula.context_links.length" class="formula-dialog-section">
              <h4>上下文关系</h4>
              <ul>
                <li v-for="link in formulaDialog.formula.context_links" :key="`${link.target_lid}:${link.relation}`">
                  <strong>{{ link.relation }}</strong> {{ link.description }}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div v-if="sourcePreview" class="source-preview-modal" @click.self="closeSourcePreview">
      <section
        class="source-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-preview-title"
      >
        <header class="source-preview-head">
          <div>
            <p class="formula-dialog-kicker">来源预览</p>
            <h3 id="source-preview-title">引用来源</h3>
          </div>
          <div class="source-preview-actions">
            <button title="在主阅读区打开" @click="openSourceInReader">在阅读区打开</button>
            <button class="formula-dialog-close" title="关闭" aria-label="关闭来源预览" @click="closeSourcePreview">×</button>
          </div>
        </header>
        <div ref="sourcePreviewBodyRef" class="source-preview-body">
          <p v-if="sourcePreview.loading" class="source-preview-state">正在加载来源...</p>
          <p v-else-if="sourcePreview.error" class="source-preview-state error">{{ sourcePreview.error }}</p>
          <div v-else class="source-preview-text md" v-html="sourcePreviewHtml"></div>
        </div>
      </section>
    </div>

    <div v-if="noteEditor" class="note-modal" @click.self="cancelNote">
      <div class="note-dialog">
        <div class="nd-head">
          <span>{{ noteEditor.memId ? "编辑笔记" : "新建笔记" }} · {{ noteEditor.lid }}</span>
          <button class="nd-close" title="关闭" @click="cancelNote">×</button>
        </div>
        <div class="nd-body">
          <textarea
            v-model="noteEditor.content"
            class="nd-input"
            placeholder="支持 Markdown 和 LaTeX: **加粗**, - 列表, $E=mc^2$ ..."
            @keydown.ctrl.enter="saveNote"
          ></textarea>
          <div class="nd-preview md" v-html="notePreview"></div>
        </div>
        <div class="nd-foot">
          <span class="nd-hint">Ctrl+Enter 保存 · Markdown/LaTeX 预览</span>
          <span class="nd-actions">
            <button @click="cancelNote">取消</button>
            <button class="primary" :disabled="!noteEditor.content.trim()" @click="saveNote">保存</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.desktop-settings-modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(10, 10, 10, 0.3);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.desktop-settings-dialog {
  width: min(32rem, 94vw);
  max-height: min(90vh, 48rem);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.98);
}
.desktop-settings-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--line);
}
.desktop-settings-head h3 {
  margin: 0;
  font-size: 1rem;
}
.desktop-settings-body {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
}
.desktop-settings-section + .desktop-settings-section {
  margin-top: 1rem;
  border-top: 1px solid var(--line);
  padding-top: 1rem;
}
.desktop-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.desktop-settings-row strong {
  font-size: 0.9rem;
}
.desktop-settings-row p,
.desktop-settings-message,
.desktop-settings-path {
  margin: 0.25rem 0 0;
  color: var(--slate);
  font-size: 0.82rem;
  line-height: 1.45;
}
.desktop-settings-row button {
  min-height: 36px;
  flex: 0 0 auto;
}
.desktop-library-button {
  display: inline-flex;
  align-items: center;
  gap: 0.42rem;
}
.desktop-provider-heading {
  align-items: flex-start;
}
.desktop-provider-mode {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid var(--hairline);
  border-radius: 6px;
  overflow: hidden;
}
.desktop-provider-mode button {
  min-height: 32px;
  border: 0;
  border-radius: 0;
  background: #fff;
  padding: 0.35rem 0.65rem;
  color: var(--slate);
}
.desktop-provider-mode button + button {
  border-left: 1px solid var(--hairline);
}
.desktop-provider-mode button.active {
  background: var(--ink);
  color: #fff;
}
.desktop-provider-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(9rem, 0.58fr);
  gap: 0.7rem;
  margin-top: 0.8rem;
}
.desktop-provider-grid label {
  min-width: 0;
  display: grid;
  gap: 0.3rem;
  color: var(--steel);
  font-size: 0.75rem;
  font-weight: 650;
}
.desktop-provider-grid input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.desktop-provider-key {
  grid-column: 1 / -1;
}
.desktop-provider-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  margin-top: 0.75rem;
}
.desktop-provider-actions p {
  margin: 0;
  color: var(--steel);
  font-size: 0.72rem;
  line-height: 1.4;
}
.desktop-provider-save {
  min-height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.desktop-settings-message {
  margin-top: 0.85rem;
}
.desktop-settings-path {
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 0.75rem;
}
.app-loading {
  min-height: 0;
  flex: 1 1 auto;
  display: grid;
  place-items: center;
  background: var(--reader-canvas);
  color: var(--steel);
  font-size: 0.9rem;
}
.agent {
  /* 固定宽侧栏:flex 0 0 不随内容增长。修 S10g 回归——面板 class 从 .qa 改 .agent 时丢了 width,
     默认 flex:0 1 auto 让右栏被长答案/trace 内容撑满全屏、挤垮分屏与按钮。 */
  flex: 0 0 24rem;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  min-width: 0;
  padding: 1rem;
  overflow-y: auto;
}
.agent-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.new-chat {
  font-size: 0.85em;
}
.transcript {
  flex: 1;
  overflow-y: auto;
  /* 长答案/无空格长串(trace digest、JSON args)在固定宽侧栏内换行,不横向撑破。 */
  overflow-wrap: anywhere;
  word-break: break-word;
}
.turn {
  margin-bottom: 1.2em;
}
.u-msg {
  font-weight: 600;
}
.a-msg {
  background: #f7f7f9;
  border-radius: 6px;
  padding: 0.6em 0.8em;
}
/* `.md` 渲染排版移到全局 style.css —— scoped 样式够不到 v-html 注入的子节点。 */
.pending {
  color: #888;
}
.incomplete {
  color: #b35;
}
.proposals {
  margin-top: 0.6em;
  border-top: 1px dashed #ccc;
  padding-top: 0.4em;
}
.prop-h {
  font-size: 0.8em;
  color: #666;
}
.proposal {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: 0.25em 0;
  font-size: 0.9em;
}
.prop-label {
  flex: 1;
}
.proposal button.undo {
  color: #b35;
}
.done {
  color: #393;
  font-size: 0.85em;
}
.trace {
  margin-top: 0.5em;
}
.trace-toggle {
  min-height: auto;
  font-size: 0.8em;
  background: none;
  border: none;
  color: #57a;
  cursor: pointer;
  padding: 0;
}
.trace ol {
  font-size: 0.8em;
  color: #555;
  margin: 0.3em 0 0;
  padding-left: 1.4em;
}
.trace .t-args {
  color: #777;
}
.trace .t-res {
  color: #999;
}
.agent-input {
  display: flex;
  flex-direction: column;
  gap: 0.4em;
  border-top: 1px solid #ddd;
  padding-top: 0.5em;
}
.agent-input textarea {
  width: 100%;
  box-sizing: border-box;
}

/* 段内选区浮动工具条 */
.hl-popover {
  position: fixed;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 999px;
  background: var(--ink);
  box-shadow: none;
}
.hl-popover button {
  background: transparent;
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 0.28rem 0.65rem;
  font-size: 0.82rem;
  min-height: 36px;
  cursor: pointer;
}
.hl-popover button:hover {
  background: rgba(255, 255, 255, 0.12);
}
.hl-popover button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}
.pdf-selection-toolbar {
  min-width: min(336px, calc(100vw - 16px));
  max-width: min(520px, calc(100vw - 16px));
  min-height: 44px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}
.pdf-selection-toolbar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  border-radius: 6px;
}
.pdf-selection-status {
  padding: 0 0.45rem;
  color: rgba(255, 255, 255, 0.82);
  font-size: 0.76rem;
  white-space: nowrap;
}
.pdf-selection-status.error {
  max-width: 220px;
  overflow: hidden;
  color: #ffd4ce;
  text-overflow: ellipsis;
}

/* 公式 sidecar 查看弹窗 */
.formula-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgba(10, 10, 10, 0.28);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.formula-dialog {
  width: min(52rem, 94vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: none;
}
.formula-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--line);
}
.formula-dialog-kicker {
  margin: 0 0 0.15rem;
  color: var(--steel);
  font-size: 0.72rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0;
}
.formula-dialog-head h3 {
  margin: 0;
  font-family: var(--mono);
  font-size: 1rem;
}
.formula-dialog-close {
  width: 44px;
  height: 44px;
  min-height: 44px;
  flex: 0 0 auto;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--canvas);
  color: var(--muted);
  padding: 0;
  font-size: 1rem;
}
.book-picker-modal {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgba(10, 10, 10, 0.28);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.book-picker-dialog {
  width: min(42rem, 94vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: none;
}
.book-picker-head,
.book-picker-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--line);
}
.book-picker-head h3 {
  margin: 0;
  font-size: 1rem;
}
.book-picker-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  margin: 0.8rem 1rem 0;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--canvas);
  padding: 2px;
}
.book-picker-tabs button {
  min-height: 38px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
}
.book-picker-tabs button.active {
  background: #fff;
  color: var(--ink);
  box-shadow: 0 0 0 1px var(--hairline-soft);
}
.book-picker-body {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
}
.book-picker-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: end;
}
.book-picker-input-row label {
  display: grid;
  gap: 0.32rem;
  color: var(--steel);
  font-size: 0.78rem;
  font-weight: 650;
}
.book-picker-input-row input {
  width: 100%;
  min-height: 42px;
  box-sizing: border-box;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  padding: 0.55rem 0.7rem;
  font-family: var(--mono);
  font-size: 0.84rem;
}
.book-create-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.85rem;
}
.book-create-grid label {
  display: grid;
  gap: 0.32rem;
  min-width: 0;
  color: var(--steel);
  font-size: 0.78rem;
  font-weight: 650;
}
.book-create-grid input {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  box-sizing: border-box;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  padding: 0.55rem 0.7rem;
  font-size: 0.84rem;
}
.book-picker-input-row button,
.book-picker-actions button {
  min-height: 42px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--canvas);
  color: var(--ink);
  padding: 0 0.9rem;
}
.book-picker-root {
  margin: 0.75rem 0 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.book-picker-error,
.book-picker-state {
  margin: 0.85rem 0 0;
  color: var(--muted);
  font-size: 0.86rem;
}
.book-picker-error {
  color: #9f2d2d;
}
.book-picker-list {
  display: grid;
  gap: 0.55rem;
  margin-top: 0.9rem;
}
.book-picker-card {
  display: grid;
  gap: 0.22rem;
  width: 100%;
  min-height: 58px;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  padding: 0.65rem 0.75rem;
  text-align: left;
}
.book-picker-card:hover,
.book-picker-card.active {
  border-color: var(--accent);
  background: #fff;
}
.book-picker-card strong {
  font-size: 0.92rem;
}
.book-picker-card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--ink) !important;
  font-family: inherit !important;
  font-size: inherit !important;
}
.book-picker-card-title small {
  flex: 0 0 auto;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: #fff;
  color: var(--steel);
  padding: 0.12rem 0.42rem;
  font-size: 0.68rem;
  font-weight: 650;
}
.book-picker-card span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.74rem;
  overflow-wrap: anywhere;
}
.book-picker-actions {
  border-top: 1px solid var(--line);
  border-bottom: none;
}
.book-picker-actions .primary-action {
  background: var(--ink);
  color: #fff;
}
@media (max-width: 640px) {
  .book-create-grid {
    grid-template-columns: 1fr;
  }
  .desktop-provider-grid {
    grid-template-columns: 1fr;
  }
  .desktop-provider-key {
    grid-column: auto;
  }
  .desktop-provider-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .desktop-provider-save {
    justify-content: center;
  }
}
.formula-dialog-body {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
}
.formula-dialog-source {
  margin: 0 0 1rem;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--surface-soft);
  padding: 0.85rem;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 0.9rem;
  line-height: 1.55;
}
.formula-dialog-profile {
  display: grid;
  gap: 0.9rem;
}
.formula-dialog-meaning {
  margin: 0;
  color: var(--ink);
  font-weight: 650;
  line-height: 1.55;
}
.formula-dialog-section {
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.8rem;
}
.formula-dialog-section h4 {
  margin: 0 0 0.45rem;
  font-size: 0.9rem;
}
.formula-dialog-section dl {
  margin: 0;
}
.formula-dialog-section dt {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.1rem;
  font-weight: 650;
}
.formula-param-symbol {
  min-width: 0;
}
.formula-param-label {
  color: var(--ink);
}
.formula-dialog-section dd {
  margin: 0 0 0.55rem 1rem;
  color: var(--slate);
  line-height: 1.5;
}
.formula-dialog-section ul {
  margin: 0;
  padding-left: 1.2rem;
  color: var(--slate);
  line-height: 1.5;
}

/* Source 临时阅读区 */
.source-preview-modal {
  position: fixed;
  inset: 0;
  z-index: 65;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgba(10, 10, 10, 0.32);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.source-preview-dialog {
  width: min(58rem, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: none;
}
.source-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--line);
}
.source-preview-head h3 {
  margin: 0;
  font-size: 1rem;
}
.source-preview-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.source-preview-actions button:not(.formula-dialog-close) {
  min-height: 44px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--canvas);
  color: var(--ink);
  font-size: 0.84rem;
}
.source-preview-body {
  min-height: 0;
  overflow-y: auto;
  scroll-padding: 30vh 0;
  padding: 1.2rem;
}
.source-preview-state {
  margin: 0;
  padding: 1rem;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--surface-soft);
  color: var(--slate);
}
.source-preview-state.error {
  color: #8f1f1f;
}
.source-preview-text {
  max-width: 46rem;
  margin: 0 auto;
  line-height: 1.75;
  color: var(--ink);
}
.source-preview-text > *:first-child {
  margin-top: 0;
}
.source-preview-text > *:last-child {
  margin-bottom: 0;
}
.source-preview-paragraph {
  margin: 0 0 1rem;
}
.source-preview-heading {
  margin: 1.2rem 0 0.65rem;
  color: var(--ink);
  line-height: 1.3;
}
.source-preview-inline-formula {
  display: inline;
}
.source-preview-asset {
  margin: 1rem 0;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--surface-soft);
  padding: 0.85rem;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.source-preview-code {
  background:
    linear-gradient(90deg, rgba(204, 120, 92, 0.08), rgba(204, 120, 92, 0) 3.5rem),
    var(--surface-code);
  color: var(--code-ink);
  border-color: var(--code-border);
  font-family: var(--mono);
  font-size: 0.88rem;
  line-height: 1.55;
  white-space: pre;
  overflow-wrap: normal;
  tab-size: 2;
}
.source-preview-code code {
  background: transparent;
  color: inherit;
  padding: 0;
}
.source-preview-image {
  display: grid;
  gap: 0.45rem;
  white-space: normal;
}
.source-preview-rendered-image {
  display: block;
  max-width: 100%;
  max-height: 62vh;
  object-fit: contain;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--surface-soft);
}
.source-preview-image code,
.source-preview-image pre {
  margin: 0;
  overflow-wrap: anywhere;
}

/* 笔记编辑器模态 */
.note-modal {
  position: fixed;
  inset: 0;
  background: rgba(10, 10, 10, 0.28);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  z-index: 60;
}
.note-dialog {
  width: min(46rem, 92vw);
  max-height: 86vh;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.nd-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
}
.nd-close {
  width: 44px;
  height: 44px;
  min-height: 44px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--canvas);
  font-size: 1rem;
  cursor: pointer;
  color: var(--muted);
  padding: 0;
}
.nd-body {
  display: flex;
  gap: 0;
  flex: 1;
  min-height: 16rem;
}
.nd-input {
  flex: 1;
  border: none;
  border-right: 1px solid var(--line);
  border-radius: 0;
  padding: 1rem;
  font: inherit;
  resize: none;
  outline: none;
}
.nd-preview {
  flex: 1;
  padding: 1rem;
  overflow-y: auto;
  background: var(--canvas-parchment);
}
.nd-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 1rem;
  border-top: 1px solid var(--line);
}
.nd-hint {
  color: var(--muted);
  font-size: 0.8rem;
}
.nd-actions {
  display: flex;
  gap: 0.5rem;
}
.nd-actions .primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
</style>
