<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { api, ApiError } from "./api";
import type {
  AgentChatSessionSummary,
  AgentChatTurn as StoredAgentChatTurn,
  AgentEffect,
  AgentHistoryResponse,
  BuildWorkbenchSnapshot,
  BuildStageId,
  BookLibraryEntry,
  ExecutorId,
  FormulaSemantics,
  ImageAssetManifestEntry,
  MemoryRecord,
  OuterOutcome,
  PaperReadingGuide,
  PaperReadingMode,
  PaperReadingStage,
  PdfSourceMap,
  PdfSourceMapEntry,
  ProfileManifest,
  ProfileSummary,
  ReaderLayoutAction,
  ReaderLayoutProposal,
  ReaderLayoutState,
  SourceManifestV2,
  StructureProjection,
  TraceStep,
  Viewport,
  WorkbenchAdapterMode,
} from "./api";
import { renderInlineMarkdown, renderMarkdown } from "./md";
import { rangeToMarkdown } from "./selection";
import TopBar from "./components/TopBar.vue";
import BuildWorkbenchPane from "./components/BuildWorkbenchPane.vue";
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

interface PaperEvidenceRow {
  id: string;
  lid: string;
  title: string;
  summary: string;
  evidence_lids: string[];
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
const appSurface = ref<"loading" | "reader" | "workbench">("loading");
const buildWorkbenchSnapshot = ref<BuildWorkbenchSnapshot | null>(null);
const buildWorkbenchLoading = ref(false);
const buildWorkbenchError = ref<string | null>(null);
const buildWorkbenchConfirming = ref(false);
const buildWorkbenchImporting = ref(false);
const buildWorkbenchActioning = ref(false);
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
const HIGHLIGHT_GROUP_PREFIX = "highlight-group:";
const selectedLid = ref<string | null>(null);
const currentReadingLid = ref<string | null>(null);
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
const readerLayout = ref<ReaderLayoutState | null>(null);
const pendingLayoutProposal = ref<ReaderLayoutProposal | null>(null);
const paperGuide = ref<PaperReadingGuide | null>(null);
const structureProjection = ref<StructureProjection | null>(null);
const paperProjectionLoading = ref(false);
const paperProjectionError = ref<string | null>(null);
const paperProjectionKey = ref("");
let paperProjectionSeq = 0;

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
const openingBook = ref(false);
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
const activeOutlineItem = computed(() => {
  const anchor = readingAnchorLid.value;
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
const pdfActiveLid = computed(() => selectedLid.value ?? readingAnchorLid.value);
function pdfEntryHasRegion(entry: PdfSourceMapEntry | null | undefined): boolean {
  return !!entry?.primary_region || !!entry?.regions.length;
}
function pdfLidHasRegion(lid: string): boolean {
  return pdfEntryHasRegion(pdfEntryByLid.value.get(lid));
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
const paperModeStage = computed<{ mode: PaperReadingMode; stage: PaperReadingStage }>(() => {
  switch (readerLayout.value?.active_preset) {
    case "paper_skim":
      return { mode: "skim", stage: "passive" };
    case "paper_deep_read":
      return { mode: "deep", stage: "critical" };
    case "paper_abstract":
      return { mode: "close", stage: "active" };
    default:
      return { mode: "close", stage: "active" };
  }
});
function resetPaperProjectionData() {
  paperProjectionSeq += 1;
  paperGuide.value = null;
  structureProjection.value = null;
  paperProjectionLoading.value = false;
  paperProjectionError.value = null;
  paperProjectionKey.value = "";
}
async function loadPaperProjectionData(force = false) {
  if (!isPaperProfile.value) {
    resetPaperProjectionData();
    return;
  }
  const { mode, stage } = paperModeStage.value;
  const key = `${profileSummary.value?.profile_id}:${profileSummary.value?.profile_version}:${readingAnchorLid.value ?? ""}:${mode}:${stage}`;
  if (!force && paperProjectionKey.value === key) return;
  const seq = ++paperProjectionSeq;
  paperProjectionLoading.value = true;
  paperProjectionError.value = null;
  try {
    const at = readingAnchorLid.value ?? undefined;
    const [guide, structure] = await Promise.all([
      api.paperReadingGuide(mode, stage),
      api.structure(at),
    ]);
    if (seq !== paperProjectionSeq) return;
    paperGuide.value = guide;
    structureProjection.value = structure;
    paperProjectionKey.value = key;
  } catch (e) {
    if (seq !== paperProjectionSeq) return;
    paperProjectionError.value = errorMessage(e);
  } finally {
    if (seq === paperProjectionSeq) paperProjectionLoading.value = false;
  }
}
watch(
  () => [
    profileSummary.value?.profile_id,
    profileSummary.value?.profile_version,
    readingAnchorLid.value,
    readerLayout.value?.active_preset,
  ] as const,
  () => { void loadPaperProjectionData(); },
);

function readableKind(value: string): string {
  return value.replace(/_/g, " ");
}
function evidenceLids(lids: readonly string[] | null | undefined, limit = 4): string[] {
  return [...new Set((lids ?? []).filter((lid) => !!lid.trim()))].slice(0, limit);
}
const paperWarnings = computed(() => {
  const warnings = [
    ...(paperGuide.value?.warnings ?? []),
    ...(paperGuide.value?.codebook.warnings ?? []),
    paperGuide.value?.abstract_aid.warning,
    structureProjection.value?.warning,
  ].filter((warning): warning is string => !!warning);
  return [...new Set(warnings)];
});
const paperStructureRows = computed<PaperEvidenceRow[]>(() => {
  const rows: PaperEvidenceRow[] = [];
  const structure = structureProjection.value;
  if (structure?.spine_unit) {
    rows.push({
      id: `spine:${structure.spine_unit.lid}`,
      lid: structure.spine_unit.lid,
      title: `Spine · ${readableKind(String(structure.spine_unit.role))}`,
      summary: structure.spine_unit.summary.text,
      evidence_lids: evidenceLids(structure.spine_unit.summary.evidence_lids.length ? structure.spine_unit.summary.evidence_lids : [structure.spine_unit.lid]),
    });
  }
  for (const stop of structure?.key_stops ?? []) {
    rows.push({
      id: `key:${stop.id}`,
      lid: stop.lid,
      title: stop.title ?? readableKind(String(stop.type)),
      summary: stop.reason.text,
      evidence_lids: evidenceLids(stop.reason.evidence_lids.length ? stop.reason.evidence_lids : [stop.lid]),
    });
  }
  for (const line of structure?.throughlines ?? []) {
    rows.push({
      id: `through:${line.id}`,
      lid: line.lids[0] ?? readingAnchorLid.value ?? "",
      title: line.name,
      summary: line.summary.text,
      evidence_lids: evidenceLids(line.summary.evidence_lids.length ? line.summary.evidence_lids : line.lids),
    });
  }
  if (!rows.length && paperGuide.value?.codebook.available) {
    for (const item of [...paperGuide.value.codebook.key_stops, ...paperGuide.value.codebook.throughlines]) {
      rows.push({
        id: item.id,
        lid: item.lid,
        title: item.title ?? item.id,
        summary: item.summary,
        evidence_lids: evidenceLids(item.evidence_lids.length ? item.evidence_lids : [item.lid]),
      });
    }
  }
  return rows.filter((row) => !!row.lid).slice(0, 7);
});
const paperPinnedEvidence = computed(() =>
  (readerLayout.value?.pinned_evidence ?? []).filter((pin) => pin.slot_id.startsWith("paper.")),
);
const paperMinimapPresets = computed(() =>
  (profileManifest.value?.layout_presets ?? []).map((preset) => ({
    id: preset.id,
    title: preset.title,
    description: preset.description,
    active: readerLayout.value?.active_preset === preset.id,
  })),
);
const paperQuestionCount = computed(() => paperGuide.value?.questions.length ?? 0);
const paperLayoutRev = computed(() => readerLayout.value ? layoutRevNumber(readerLayout.value.rev) : null);

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
const noteEditor = ref<{ lid: string; memId: string | null; layer: string; content: string } | null>(null);
const notePreview = computed(() => renderMarkdown(noteEditor.value?.content ?? ""));
function openNewNote(lid = selectedLid.value, content = "") {
  if (!lid) return;
  noteEditor.value = { lid, memId: null, layer: "long_term", content };
}
function openEditNote(rec: MemoryRecord) {
  noteEditor.value = { lid: rec.anchor.lid ?? "", memId: rec.mem_id, layer: rec.layer, content: rec.content };
}
function cancelNote() {
  noteEditor.value = null;
}
// 保存:新建直接 save;编辑 = 删旧 + 存新(mem_id 内容寻址 `[ADR-0026]`)。
async function saveNote() {
  const ed = noteEditor.value;
  if (!ed) return;
  const content = ed.content.trim();
  if (!content) return;
  try {
    banner.value = "";
    if (ed.memId) await api.delete(ed.memId);
    await api.save({ type: "note", anchor_lid: ed.lid, content, layer: ed.layer });
    noteEditor.value = null;
    await refreshAnnotations();
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
async function refreshAnnotations() {
  annotations.value = await api.recall({}); // 单书:取全部,客户端按 lid 过滤
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
async function loadWindow(vp: Viewport, mode: SegmentLoadMode = "replace") {
  viewport.value = vp;
  if (mode === "replace") {
    selectedLid.value = vp.top_lid;
    currentReadingLid.value = vp.top_lid;
  }
  const next = await hydrateSegments(vp.visible_lids);
  segments.value = mergeSegments(segments.value, next, mode);
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
async function syncViewport() {
  const st = await api.state();
  await applyReaderState(st);
  await loadWindow(st.viewport);
  await loadPaperProjectionData();
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
    const snapshot = await api.buildWorkbench();
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

async function refreshBuildWorkbench() {
  await loadBuildWorkbenchSnapshot();
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
    appSurface.value = "workbench";
  } catch (e) {
    buildWorkbenchError.value = errorMessage(e);
  } finally {
    buildWorkbenchImporting.value = false;
  }
}

async function applyWorkbenchAction(action: () => Promise<BuildWorkbenchSnapshot>) {
  buildWorkbenchActioning.value = true;
  buildWorkbenchError.value = null;
  try {
    const snapshot = await action();
    buildWorkbenchSnapshot.value = snapshot;
    if (snapshot.readiness.route === "reader") {
      await init();
    } else {
      appSurface.value = "workbench";
    }
  } catch (e) {
    buildWorkbenchError.value = errorMessage(e);
  } finally {
    buildWorkbenchActioning.value = false;
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

async function init() {
  try {
    appSurface.value = "loading";
    const workbench = await loadBuildWorkbenchSnapshot();
    if (!workbench && buildWorkbenchError.value) {
      appSurface.value = "workbench";
      return;
    }
    if (workbench?.readiness.route === "workbench") {
      appSurface.value = "workbench";
      return;
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
    appSurface.value = "reader";
  } catch (e) {
    appSurface.value = buildWorkbenchSnapshot.value?.readiness.route === "workbench" ? "workbench" : "reader";
    fail(e);
  }
}
onMounted(init);

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
    await loadWindow((await api.goto(lid)).viewport);
    if (pdfReaderAvailable.value && !pdfLidHasRegion(lid)) {
      await openSourcePreview({ lid, quote: focusQuote ?? null });
    }
    await loadPaperProjectionData();
    gotoInput.value = "";
  } catch (e) {
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
  if (leafOrder.value.includes(lid)) return lid;
  return leafOrder.value.find((leaf) => leaf.startsWith(`${lid}.`)) ?? lid;
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

// ── 自由选区:可跨多个 LID,高亮按 LID 拆 range;Note/Ask AI 锚到起点 LID `[ADR-0031]` ──
interface SelectedRange {
  lid: string;
  start: number;
  end: number;
}
const hlPopover = ref<{ x: number; y: number; anchorLid: string; ranges: SelectedRange[]; text: string } | null>(null);

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

function selectedRangeForElement(el: HTMLElement, range: Range, startEl: HTMLElement, endEl: HTMLElement): SelectedRange | null {
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

function selectionRanges(range: Range): SelectedRange[] {
  const startEl = lidElementOf(range.startContainer);
  const endEl = lidElementOf(range.endContainer);
  if (!startEl || !endEl) return [];
  const root = startEl.closest(".prose");
  if (!root || !root.contains(endEl)) return [];

  return Array.from(root.querySelectorAll<HTMLElement>("[data-lid]"))
    .filter((el) => range.intersectsNode(el))
    .map((el) => selectedRangeForElement(el, range, startEl, endEl))
    .filter((r): r is SelectedRange => r !== null && r.end > r.start);
}

function onSelectSeg(lid: string) {
  selectedLid.value = lid;
  currentReadingLid.value = lid;
  sourceFocus.value = null;
}

function onCurrentLid(lid: string) {
  currentReadingLid.value = lid;
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
interface AskDraft {
  lid: string;
  quote: string;
}
const chat = ref<ChatTurn[]>([]);
const chatSessions = ref<AgentChatSessionSummary[]>([]);
const activeChatSessionId = ref("");
const agentInput = ref("");
const askDraft = ref<AskDraft | null>(null);
const sending = ref(false);
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
  if (e.kind === "LayoutProposal") return "应用";
  if (e.kind === "Highlight" || e.kind === "Note") return "保留";
  return "";
}
function effectSecondaryLabel(e: AgentEffect): string {
  if (e.kind === "LayoutProposal") return "忽略";
  if (e.kind === "Highlight" || e.kind === "Note") return "撤销";
  return "";
}
function showEffectPrimary(e: AgentEffect): boolean {
  return e.kind === "Highlight" || e.kind === "Note" || e.kind === "LayoutProposal";
}
function showEffectSecondary(e: AgentEffect): boolean {
  return e.kind === "Highlight" || e.kind === "Note" || e.kind === "LayoutProposal";
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
function dismissPendingLayoutProposal() {
  pendingLayoutProposal.value = null;
}
async function requestLayoutPreset(presetId: string) {
  await applyLayoutActions([{ kind: "set_layout_preset", preset_id: presetId }]);
}

async function sendAgent() {
  const msg = agentInput.value.trim();
  if (!msg) return;
  const draft = askDraft.value;
  const questionAnchorLid = draft?.lid ?? selectedLid.value ?? viewport.value?.top_lid ?? null;
  const outbound = draft
    ? `引用原文 [LID: ${draft.lid}]:\n「${draft.quote}」\n\n我的问题:\n${msg}`
    : msg;
  const turn: ChatTurn = { user: msg, outcome: null, pending: true, questionAnchorLid, questionQuote: draft ? { ...draft } : null };
  chat.value.push(turn);
  agentInput.value = "";
  askDraft.value = null;
  sending.value = true;
  banner.value = "";
  try {
    turn.outcome = await api.agentChat(outbound, {
      display_user: msg,
      question_anchor_lid: questionAnchorLid,
      question_quote: draft ? { ...draft } : null,
    });
    const proposalEffect = turn.outcome.effects.find((effect) => effect.kind === "LayoutProposal");
    if (proposalEffect?.kind === "LayoutProposal") pendingLayoutProposal.value = proposalEffect.proposal;
    // agent 可能驱动了共享 reader 视口 / 落了 session 标注 → 同步阅读区。
    await syncViewport();
    await refreshAgentHistory();
  } catch (e) {
    turn.error = e instanceof ApiError ? `[${e.category}] ${e.errorCode}: ${e.message}` : String(e);
  } finally {
    turn.pending = false;
    sending.value = false;
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
    }
    handled.value[effKey(ti, ei)] = e.kind === "LayoutProposal" ? "已忽略" : "已撤销";
  } catch (err) {
    fail(err);
  }
}

// 提议「保留」(Highlight/Note):同内容以 long_term 再 save → 同 mem_id upsert 升级层。
async function keepEffect(ti: number, ei: number, e: AgentEffect) {
  if (e.kind === "Goto" || e.kind === "Layout") return;
  try {
    banner.value = "";
    if (e.kind === "LayoutProposal") {
      await applyPendingLayoutProposal(e.proposal);
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
  const anchor = turn.questionAnchorLid;
  const content = text.trim();
  if (!content || !anchor) return;
  const sourceQuote = turn.questionQuote?.quote.replace(/\s+/g, " ").trim();
  const noteContent = sourceQuote ? `> ${sourceQuote}\n\n${content}` : content;
  try {
    banner.value = "";
    await api.save({ type: "note", anchor_lid: anchor, content: noteContent, layer: "long_term" });
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

function closeBookPicker() {
  if (openingBook.value) return;
  bookPickerOpen.value = false;
}

function resetBookSessionUi() {
  leafOrder.value = [];
  kindByLid.value = new Map();
  imageAssetByLid.value = new Map();
  appSurface.value = "loading";
  buildWorkbenchSnapshot.value = null;
  buildWorkbenchLoading.value = false;
  buildWorkbenchError.value = null;
  buildWorkbenchConfirming.value = false;
  buildWorkbenchImporting.value = false;
  buildWorkbenchActioning.value = false;
  sourceManifest.value = null;
  pdfSourceMap.value = null;
  pdfRuntimeError.value = null;
  outlineItems.value = [];
  titleByLid.value = new Map();
  viewport.value = null;
  segments.value = [];
  annotations.value = [];
  selectedLid.value = null;
  currentReadingLid.value = null;
  formulaDialog.value = null;
  profileSummary.value = null;
  profileManifest.value = null;
  readerLayout.value = null;
  pendingLayoutProposal.value = null;
  resetPaperProjectionData();
  chapterTitle.value = "";
  gotoInput.value = "";
  outlineSearch.value = "";
  chat.value = [];
  chatSessions.value = [];
  activeChatSessionId.value = "";
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
      @new-chat="newChat"
      @open-book="openBook"
      @toggle-left-rail="leftRailOpen = !leftRailOpen"
      @toggle-debug="debugOpen = !debugOpen"
    />

    <p v-if="banner" class="banner">{{ banner }}</p>

    <div v-if="bookPickerOpen" class="book-picker-modal" @click.self="closeBookPicker">
      <section class="book-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="book-picker-title">
        <header class="book-picker-head">
          <div>
            <p class="formula-dialog-kicker">书库</p>
            <h3 id="book-picker-title">打开书</h3>
          </div>
          <button class="formula-dialog-close" title="关闭" aria-label="关闭书库" @click="closeBookPicker">×</button>
        </header>

        <div class="book-picker-body">
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
              <strong>{{ book.book_id || book.name }}</strong>
              <span>{{ book.dir }}</span>
            </button>
          </div>
        </div>

        <footer class="book-picker-actions">
          <button :disabled="openingBook" @click="closeBookPicker">取消</button>
          <button class="primary-action" :disabled="openingBook || !bookPickerDir.trim()" @click="submitOpenBook()">
            {{ openingBook ? "打开中" : "打开" }}
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
      @refresh="refreshBuildWorkbench"
      @import-input="importWorkbenchInput"
      @create-job="createBuildJob"
      @start-job="startBuildJob"
      @resume-job="resumeBuildJob"
      @resolve-decision="resolveBuildDecision"
      @resolve-permission="resolveExecutorPermission"
      @confirm-sidecar-plan="confirmSidecarPlan"
    />

    <main v-else-if="appSurface === 'loading'" class="app-loading">正在加载工作区...</main>

    <div v-else class="workspace-grid" :class="{ 'left-collapsed': !leftRailOpen }" :style="workspaceStyle">
      <LeftRail
        v-show="leftRailOpen"
        v-model:goto-input="gotoInput"
        v-model:search-query="outlineSearch"
        :outline-items="outlineItems"
        :progress-pct="progressPct"
        :anchor-lid="readingAnchorLid"
        :selected-lid="selectedLid"
        :leaf-count="leafOrder.length"
        :debug-open="debugOpen"
        :paper-enabled="isPaperProfile"
        :paper-loading="paperProjectionLoading"
        :paper-error="paperProjectionError"
        :paper-warnings="paperWarnings"
        :paper-profile-version="profileManifest?.profile_version ?? null"
        :paper-layout-rev="paperLayoutRev"
        :paper-mode="paperModeStage.mode"
        :paper-stage="paperModeStage.stage"
        :paper-guide-ready="!!paperGuide?.available"
        :paper-question-count="paperQuestionCount"
        :paper-presets="paperMinimapPresets"
        :paper-rows="paperStructureRows"
        :paper-pinned-evidence="paperPinnedEvidence"
        :paper-proposal-summary="pendingLayoutProposal?.summary ?? null"
        @goto="doGoto"
        @paper-preset="requestLayoutPreset"
        @paper-proposal-apply="applyPendingLayoutProposal()"
        @paper-proposal-dismiss="dismissPendingLayoutProposal"
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
        @goto="doGoto"
        @select="onSelectSeg"
        @focus-source="focusLocalSource"
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
      />
    </div>

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
