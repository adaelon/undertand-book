<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
  type ComponentPublicInstance,
} from "vue";
import type { FormulaSemantics, ImageAssetManifestEntry, MemoryRecord } from "../api";
import type { Manifest } from "../api";
import type { ReaderSegment } from "../reader-segment";
import {
  readerTargetIsBeyondAdjacentWindow,
  type ReaderBufferRange,
} from "../reader-buffer";
import {
  createReaderHeightLedger,
  readerLeafIndexAtOffset,
  readerRenderItemKey,
  readerSpacerTotals,
  recordReaderItemHeight,
  resetReaderHeightLedger,
} from "../reader-height-ledger";
import NoteCard from "./NoteCard.vue";
import StableReaderSegment from "./StableReaderSegment.vue";
import { resolveMarkdownNotePlacementTarget } from "../markdown-note-placement";
import {
  readerPerformanceEnabled,
  recordReaderDom,
  recordReaderFirstSegment,
  recordReaderProbe,
  recordReaderScrollCheck,
  recordReaderScrollEvent,
} from "../reader-performance";

const readerPerformanceCompiled = import.meta.env.DEV || import.meta.env.VITE_READER_PERF === "1";

type NodeKind = Manifest["tree"][number]["kind"];
export type Segment = ReaderSegment;

const props = defineProps<{
  segments: Segment[];
  viewportAnchor: string | null;
  selectedLid: string | null;
  notePlacementActive?: boolean;
  renderSeg: (seg: Segment) => string;
  renderMarkdown: (source: string) => string;
  markdownHeadingLevel: (seg: Segment) => number | null;
  isAsset: (seg: Segment) => boolean;
  isHighlighted: (lid: string) => boolean;
  highlightsOf: (lid: string) => MemoryRecord[];
  highlightCardsOf: (lid: string) => MemoryRecord[];
  visibleNotes: MemoryRecord[];
  hlExcerpt: (rec: MemoryRecord) => string;
  imageMeta: (text: string) => { alt: string; src: string } | null;
  imageAsset: (lid: string) => ImageAssetManifestEntry | null;
  boundedBufferEnabled?: boolean;
  sourceFingerprint?: string;
  leafOrder?: string[];
  bufferRange?: ReaderBufferRange | null;
  bufferViewportWidth?: number | null;
  rendererVersion?: string;
  renderRevisions?: ReadonlyMap<string, string>;
  estimatedLeafHeightPx?: number;
  fastScrollLoadingLid?: string | null;
}>();

type ReaderItem =
  | { type: "flow"; segments: Segment[] }
  | { type: "single"; segment: Segment };

function imageRenderSrc(asset: ImageAssetManifestEntry | null | undefined): string | null {
  if (!asset) return null;
  return asset.url_path ?? (asset.status === "external" ? asset.original_src : null);
}
const emit = defineEmits<{
  (e: "select", lid: string): void;
  (e: "prose-mouse-up"): void;
  (e: "highlight-block", lid: string): void;
  (e: "note-block", lid: string): void;
  (e: "modify-highlight", rec: MemoryRecord): void;
  (e: "delete-highlight", rec: MemoryRecord): void;
  (e: "edit-note", rec: MemoryRecord): void;
  (e: "delete-note", rec: MemoryRecord): void;
  (e: "goto", lid: string): void;
  (e: "focus-source-local", source: { lid: string; quote: string | null }): void;
  (e: "open-formula", seg: Segment): void;
  (e: "scroll-edge", direction: "up" | "down"): void;
  (e: "current-lid", lid: string): void;
  (e: "viewport-interaction", direction?: "up" | "down"): void;
  (e: "fast-scroll-into-spacer", lid: string, direction: "up" | "down", leafIndex: number): void;
  (e: "fast-scroll-returned-to-mounted", lid: string): void;
  (e: "note-placement-pointer", event: PointerEvent): void;
  (e: "note-placement-target", target: { lid: string }): void;
  (e: "note-placement-invalid"): void;
  (e: "interaction-pin", pin: "selection" | "note", active: boolean): void;
}>();

const notesByLid = computed(() => {
  const map = new Map<string, MemoryRecord[]>();
  for (const note of props.visibleNotes) {
    const lid = note.anchor.lid;
    if (!lid) continue;
    const arr = map.get(lid);
    if (arr) arr.push(note);
    else map.set(lid, [note]);
  }
  return map;
});
const segmentStage = ref<{
  direction: "up" | "down";
  segments: Segment[];
  stagedCount: number;
} | null>(null);
const bufferRangeOverride = shallowRef<ReaderBufferRange | null>(null);
const renderedSegments = computed(() => segmentStage.value?.segments ?? props.segments);
const effectiveBufferRange = computed(() => bufferRangeOverride.value ?? props.bufferRange ?? null);

function beginSegmentStage(
  base: readonly Segment[],
  direction: "up" | "down",
): boolean {
  if (segmentStage.value) return false;
  segmentStage.value = { direction, segments: [...base], stagedCount: 0 };
  return true;
}

function stageSegment(segment: Segment): boolean {
  const stage = segmentStage.value;
  if (!stage || stage.segments.some((current) => current.lid === segment.lid)) return false;
  if (stage.direction === "down") stage.segments.push(segment);
  else stage.segments.unshift(segment);
  stage.stagedCount += 1;
  return true;
}

function finishSegmentStage(bufferRange: ReaderBufferRange | null): void {
  bufferRangeOverride.value = bufferRange;
  segmentStage.value = null;
}

function cancelSegmentStage(): void {
  segmentStage.value = null;
}

function notesOf(lid: string): MemoryRecord[] {
  return notesByLid.value.get(lid) ?? [];
}
function isMarkdownHeading(seg: Segment): boolean {
  return props.markdownHeadingLevel(seg) !== null;
}
function isFlowSegment(seg: Segment): boolean {
  if (seg.kind === "paragraph" && isMarkdownHeading(seg)) return false;
  return seg.kind === "paragraph" || seg.kind === "formula";
}
function shouldJoinFlow(prev: Segment, next: Segment): boolean {
  return prev.kind === "formula" || next.kind === "formula";
}
const readerItems = computed<ReaderItem[]>(() => {
  const items: ReaderItem[] = [];
  let flow: Segment[] = [];
  const flush = () => {
    if (!flow.length) return;
    items.push({ type: "flow", segments: flow });
    flow = [];
  };
  for (const seg of renderedSegments.value) {
    if (isFlowSegment(seg)) {
      const last = flow[flow.length - 1];
      if (last && !shouldJoinFlow(last, seg)) {
        flush();
      }
      flow.push(seg);
    }
    else {
      flush();
      items.push({ type: "single", segment: seg });
    }
  }
  flush();
  return items;
});
function itemKey(item: ReaderItem): string {
  return readerRenderItemKey(itemLids(item));
}
function itemLids(item: ReaderItem): string[] {
  return item.type === "flow" ? item.segments.map((seg) => seg.lid) : [item.segment.lid];
}
function renderRevision(lid: string): string {
  return props.renderRevisions?.get(lid) ?? "";
}
function markdownHeadingClass(seg: Segment): Record<string, boolean> {
  const level = props.markdownHeadingLevel(seg);
  if (level === null) return {};
  return {
    "heading-markdown": true,
    [`heading-markdown-${level}`]: true,
  };
}

const pane = ref<HTMLElement | null>(null);
const prose = ref<HTMLElement | null>(null);
const topEdgeSentinel = ref<HTMLElement | null>(null);
const bottomEdgeSentinel = ref<HTMLElement | null>(null);
const placementCandidateLid = ref<string | null>(null);
const noteOpenByMemId = reactive(new Map<string, boolean>());
const validPlacementLids = computed(() => new Set(renderedSegments.value.map((segment) => segment.lid)));
const edgePx = 2;
const preloadScreens = 2;
const mountedLidElements = new Map<string, HTMLElement>();
const visibleLids = new Set<string>();
const pendingEdgeDirections = new Set<"up" | "down">();
let orderedMountedLids: string[] = [];
let lidOrder = new Map<string, number>();
let lidVisibilityObserver: IntersectionObserver | null = null;
let edgeObserver: IntersectionObserver | null = null;
let heightObserver: ResizeObserver | null = null;
let edgeObservationEnabled = false;
let pendingScrollStateFrame: number | null = null;
let pendingViewportCoverageFrame: number | null = null;
let pendingHeightMeasurementFrame: number | null = null;
let notePinReleaseTimer: number | null = null;
let currentReadingLid: string | null = null;
let currentLayoutToken = "unmounted";
let selectionPinActive = false;
let notePinActive = false;
let navigationScrollAnchor: ScrollAnchor | null = null;
let scrollAnchorRestoreEpoch = 0;
let lastFastScrollRequestKey: string | null = null;
let fastScrollInteractionSinceRequest = false;

interface MountedRenderItem {
  element: HTMLElement;
  lids: string[];
}

const mountedRenderItems = new Map<string, MountedRenderItem>();
const heightLedger = shallowRef(createReaderHeightLedger({
  sourceFingerprint: props.sourceFingerprint ?? "reader-source-unresolved",
  leafOrder: props.leafOrder ?? [],
  layoutToken: currentLayoutToken,
  rendererVersion: props.rendererVersion ?? "reader-markdown-v1",
  estimatedLeafHeightPx: props.estimatedLeafHeightPx ?? 48,
}));

const bufferSpacers = computed(() => {
  const range = effectiveBufferRange.value;
  if (!props.boundedBufferEnabled || !range) {
    return { topSpacerPx: 0, bottomSpacerPx: 0 };
  }
  const ledger = heightLedger.value;
  if (
    range[0] < 0
    || range[1] < range[0]
    || range[1] > ledger.leafOrder.length
  ) {
    return { topSpacerPx: 0, bottomSpacerPx: 0 };
  }
  return readerSpacerTotals(ledger, range);
});
const topSpacerStyle = computed(() => ({ height: `${bufferSpacers.value.topSpacerPx}px` }));
const bottomSpacerStyle = computed(() => ({ height: `${bufferSpacers.value.bottomSpacerPx}px` }));

function rememberNoteOpen(memId: string, open: boolean) {
  noteOpenByMemId.set(memId, open);
}

function layoutToken(): string {
  const root = prose.value ?? pane.value;
  if (!root) return "unmounted";
  const style = getComputedStyle(root);
  const width = root.getBoundingClientRect().width || root.clientWidth || pane.value?.clientWidth || 0;
  return [
    Math.round(width * 100) / 100,
    style.fontSize,
    style.lineHeight,
    style.letterSpacing,
  ].join(":");
}

function resetHeightLedgerIdentity(nextLayoutToken = currentLayoutToken): boolean {
  currentLayoutToken = nextLayoutToken;
  const previous = heightLedger.value;
  const next = resetReaderHeightLedger(previous, {
    sourceFingerprint: props.sourceFingerprint ?? "reader-source-unresolved",
    leafOrder: props.leafOrder ?? [],
    layoutToken: currentLayoutToken,
    rendererVersion: props.rendererVersion ?? "reader-markdown-v1",
    estimatedLeafHeightPx: props.estimatedLeafHeightPx ?? 48,
  });
  if (next === previous) return false;
  heightLedger.value = next;
  return true;
}

function itemComesBeforeCurrent(itemLidsValue: readonly string[]): boolean {
  const current = currentReadingLid;
  if (!current) return false;
  const leafOrderValue = heightLedger.value.leafOrder;
  const currentIndex = leafOrderValue.indexOf(current);
  const itemEndIndex = leafOrderValue.indexOf(itemLidsValue[itemLidsValue.length - 1]);
  return currentIndex >= 0 && itemEndIndex >= 0 && itemEndIndex < currentIndex;
}

function recordRenderItemHeight(item: MountedRenderItem, blockHeightPx: number) {
  if (!props.boundedBufferEnabled) return;
  const receipt = recordReaderItemHeight(heightLedger.value, {
    key: readerRenderItemKey(item.lids),
    lids: item.lids,
    blockHeightPx,
  });
  if (!receipt.changed) return;
  heightLedger.value = receipt.ledger;
  if (
    receipt.previousHeightPx !== null
    && receipt.deltaPx !== 0
    && itemComesBeforeCurrent(item.lids)
    && !props.fastScrollLoadingLid
  ) {
    const el = pane.value;
    if (el) el.scrollTop += receipt.deltaPx;
  }
  scheduleScrollStateCheck();
}

function measureMountedRenderItems() {
  pendingHeightMeasurementFrame = null;
  if (!props.boundedBufferEnabled) return;
  for (const item of mountedRenderItems.values()) {
    recordRenderItemHeight(item, item.element.getBoundingClientRect().height);
  }
}

function scheduleHeightMeasurement() {
  if (!props.boundedBufferEnabled || pendingHeightMeasurementFrame !== null) return;
  pendingHeightMeasurementFrame = requestAnimationFrame(measureMountedRenderItems);
}

function registerRenderItem(
  item: ReaderItem,
  value: Element | ComponentPublicInstance | null,
) {
  const key = itemKey(item);
  const next = value instanceof HTMLElement ? value : null;
  const previous = mountedRenderItems.get(key);
  if (previous?.element === next) return;
  if (previous) {
    heightObserver?.unobserve(previous.element);
    mountedRenderItems.delete(key);
  }
  if (!next) return;
  const mounted = { element: next, lids: itemLids(item) };
  mountedRenderItems.set(key, mounted);
  heightObserver?.observe(next);
  if (!heightObserver) scheduleHeightMeasurement();
}

function rootElement(
  value: Element | ComponentPublicInstance | null,
): HTMLElement | null {
  if (value instanceof HTMLElement) return value;
  const componentRoot = (value as ComponentPublicInstance | null)?.$el;
  return componentRoot instanceof HTMLElement ? componentRoot : null;
}

function recordPerformanceDomState() {
  if (!readerPerformanceCompiled || !readerPerformanceEnabled()) return;
  const dataLidNodes = mountedLidElements.size;
  recordReaderDom(renderedSegments.value.length, dataLidNodes);
  recordReaderFirstSegment(renderedSegments.value.length, dataLidNodes);
}

function refreshLidOrder() {
  orderedMountedLids = renderedSegments.value.map((segment) => segment.lid);
  lidOrder = new Map(orderedMountedLids.map((lid, index) => [lid, index]));
}

function registerLidElement(
  lid: string,
  value: Element | ComponentPublicInstance | null,
) {
  const next = rootElement(value);
  const previous = mountedLidElements.get(lid);
  if (previous === next) return;
  if (previous) {
    lidVisibilityObserver?.unobserve(previous);
    mountedLidElements.delete(lid);
    visibleLids.delete(lid);
  }
  if (next) {
    mountedLidElements.set(lid, next);
    lidVisibilityObserver?.observe(next);
  }
}

interface ScrollAnchor {
  lid: string;
  top: number;
}

function atTopEdge(el: HTMLElement): boolean {
  return el.scrollTop <= edgePx;
}

function atBottomEdge(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= edgePx;
}

function preloadPx(el: HTMLElement): number {
  return Math.max(320, el.clientHeight * preloadScreens);
}

function nearTop(el: HTMLElement): boolean {
  return el.scrollTop <= preloadPx(el);
}

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= preloadPx(el);
}

function nearMountedTop(el: HTMLElement): boolean {
  if (!props.boundedBufferEnabled) return nearTop(el);
  return el.scrollTop <= bufferSpacers.value.topSpacerPx + preloadPx(el);
}

function nearMountedBottom(el: HTMLElement): boolean {
  if (!props.boundedBufferEnabled) return nearBottom(el);
  const mountedBottomPx = Math.max(
    0,
    el.scrollHeight - bufferSpacers.value.bottomSpacerPx,
  );
  return el.scrollTop + el.clientHeight >= mountedBottomPx - preloadPx(el);
}

function viewportCoverageIntrusion(direction: "up" | "down"): number {
  if (!props.boundedBufferEnabled) return 0;
  const el = pane.value;
  const range = effectiveBufferRange.value;
  const topSentinel = topEdgeSentinel.value;
  const bottomSentinel = bottomEdgeSentinel.value;
  if (!el || !range || !topSentinel || !bottomSentinel) return 0;
  const paneRect = el.getBoundingClientRect();
  if (direction === "up") {
    return range[0] > 0
      ? Math.max(0, topSentinel.getBoundingClientRect().bottom - paneRect.top)
      : 0;
  }
  return range[1] < (props.leafOrder?.length ?? 0)
    ? Math.max(0, paneRect.bottom - bottomSentinel.getBoundingClientRect().top)
    : 0;
}

function viewportHasCoverageGap(direction: "up" | "down"): boolean {
  return viewportCoverageIntrusion(direction) > 1;
}

function clampAdjacentViewportGap(el: HTMLElement): boolean {
  if (!props.boundedBufferEnabled) return false;
  const topIntrusion = viewportCoverageIntrusion("up");
  if (topIntrusion > 0) {
    el.scrollTop += topIntrusion;
    return true;
  }
  const bottomIntrusion = viewportCoverageIntrusion("down");
  if (bottomIntrusion > 0) {
    el.scrollTop = Math.max(0, el.scrollTop - bottomIntrusion);
    return true;
  }
  return false;
}

function viewportContainsMountedLid(el: HTMLElement): boolean {
  const paneRect = el.getBoundingClientRect();
  for (const node of mountedLidElements.values()) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > paneRect.top && rect.top < paneRect.bottom) return true;
  }
  return false;
}

function requestFastScrollIntoSpacer(): boolean {
  const el = pane.value;
  const range = effectiveBufferRange.value;
  const leafCount = props.leafOrder?.length ?? 0;
  const viewportWidth = props.bufferViewportWidth ?? 0;
  const topSentinel = topEdgeSentinel.value;
  const bottomSentinel = bottomEdgeSentinel.value;
  if (
    !props.boundedBufferEnabled
    || !el
    || !range
    || !topSentinel
    || !bottomSentinel
    || leafCount === 0
    || viewportWidth <= 0
  ) return false;

  const paneRect = el.getBoundingClientRect();
  const topIntrusion = range[0] > 0
    ? topSentinel.getBoundingClientRect().bottom - paneRect.top
    : 0;
  const bottomIntrusion = range[1] < leafCount
    ? paneRect.bottom - bottomSentinel.getBoundingClientRect().top
    : 0;
  const maximumPreloadIntrusionPx = Math.max(edgePx, el.clientHeight * 0.25);
  if (
    topIntrusion > maximumPreloadIntrusionPx
    && bottomIntrusion > maximumPreloadIntrusionPx
  ) return false;
  let direction: "up" | "down" | null = null;
  if (
    topIntrusion > maximumPreloadIntrusionPx
    || bottomIntrusion > maximumPreloadIntrusionPx
  ) {
    direction = topIntrusion >= bottomIntrusion ? "up" : "down";
  }
  if (!direction) return false;
  const topSpacer = topSentinel.previousElementSibling;
  if (!(topSpacer instanceof HTMLElement)) return true;
  const virtualOffsetPx = Math.max(
    0,
    paneRect.top - topSpacer.getBoundingClientRect().top,
  );
  const targetLeafIndex = readerLeafIndexAtOffset(heightLedger.value, virtualOffsetPx);
  if (targetLeafIndex === null) return true;
  if (!readerTargetIsBeyondAdjacentWindow(
    range,
    targetLeafIndex,
    viewportWidth,
    leafCount,
  )) return false;
  const targetLid = heightLedger.value.leafOrder[targetLeafIndex] ?? null;
  if (!targetLid) return true;

  const requestKey = `${direction}:${targetLid}`;
  if (requestKey === lastFastScrollRequestKey) {
    fastScrollInteractionSinceRequest = false;
    return true;
  }
  lastFastScrollRequestKey = requestKey;
  fastScrollInteractionSinceRequest = false;
  scrollAnchorRestoreEpoch += 1;
  navigationScrollAnchor = null;
  emit("fast-scroll-into-spacer", targetLid, direction, targetLeafIndex);
  return true;
}

function requestBuffer(direction: "up" | "down") {
  emit("scroll-edge", direction);
}

function checkBufferNeed() {
  const el = pane.value;
  if (!el || renderedSegments.value.length === 0) {
    pendingEdgeDirections.clear();
    return;
  }
  if (props.boundedBufferEnabled || !edgeObservationEnabled) {
    if (nearMountedBottom(el)) pendingEdgeDirections.add("down");
    if (nearMountedTop(el)) pendingEdgeDirections.add("up");
  }
  else {
    if (atBottomEdge(el)) pendingEdgeDirections.add("down");
    if (atTopEdge(el)) pendingEdgeDirections.add("up");
  }
  const directions = [...pendingEdgeDirections];
  pendingEdgeDirections.clear();
  for (const direction of directions) requestBuffer(direction);
}

function probeCandidateLids(): string[] {
  if (visibleLids.size > 0) {
    return [...visibleLids]
      .filter((lid) => mountedLidElements.has(lid))
      .sort((left, right) => (lidOrder.get(left) ?? 0) - (lidOrder.get(right) ?? 0));
  }
  if (!lidVisibilityObserver) {
    return orderedMountedLids.filter((lid) => mountedLidElements.has(lid));
  }
  if (currentReadingLid && mountedLidElements.has(currentReadingLid)) {
    return [currentReadingLid];
  }
  const first = orderedMountedLids.find((lid) => mountedLidElements.has(lid));
  return first ? [first] : [];
}

function currentLidAtProbe(): string | null {
  const performanceEnabled = readerPerformanceCompiled && readerPerformanceEnabled();
  const startedAt = performanceEnabled ? performance.now() : 0;
  let candidateCount = 0;
  try {
    const el = pane.value;
    if (!el) return null;
    const paneRect = el.getBoundingClientRect();
    const probeOffset = Math.min(Math.max(el.clientHeight * 0.28, 96), Math.max(el.clientHeight - 24, 0));
    const probeY = paneRect.top + probeOffset;
    const candidates = probeCandidateLids();
    candidateCount = candidates.length;
    let fallback: string | null = null;
    for (const lid of candidates) {
      const node = mountedLidElements.get(lid);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < paneRect.top || rect.top > paneRect.bottom) continue;
      if (rect.top <= probeY && rect.bottom >= probeY) return lid;
      if (rect.top <= probeY) fallback = lid;
      else {
        return fallback ?? lid;
      }
    }
    return fallback ?? currentReadingLid;
  } finally {
    if (performanceEnabled) {
      recordReaderProbe(performance.now() - startedAt, candidateCount);
      recordReaderDom(renderedSegments.value.length, mountedLidElements.size);
    }
  }
}

function updateCurrentLid() {
  const lid = currentLidAtProbe();
  if (!lid || lid === currentReadingLid) return;
  currentReadingLid = lid;
  emit("current-lid", lid);
}

function checkScrollState() {
  if (readerPerformanceCompiled && readerPerformanceEnabled()) recordReaderScrollCheck();
  if (requestFastScrollIntoSpacer()) return;
  const el = pane.value;
  if (
    el
    && fastScrollInteractionSinceRequest
    && !viewportContainsMountedLid(el)
  ) clampAdjacentViewportGap(el);
  updateCurrentLid();
  if (
    lastFastScrollRequestKey !== null
    && fastScrollInteractionSinceRequest
    && currentReadingLid
  ) {
    emit("fast-scroll-returned-to-mounted", currentReadingLid);
  }
  lastFastScrollRequestKey = null;
  fastScrollInteractionSinceRequest = false;
  checkBufferNeed();
}

function scheduleScrollStateCheck() {
  if (pendingScrollStateFrame !== null) return;
  pendingScrollStateFrame = requestAnimationFrame(() => {
    pendingScrollStateFrame = null;
    checkScrollState();
  });
}

function onScroll() {
  if (readerPerformanceCompiled && readerPerformanceEnabled()) recordReaderScrollEvent();
  scheduleScrollStateCheck();
}

function onWheel(event: WheelEvent) {
  if (event.deltaY !== 0) {
    fastScrollInteractionSinceRequest = true;
    scrollAnchorRestoreEpoch += 1;
    navigationScrollAnchor = null;
    emit("viewport-interaction", event.deltaY > 0 ? "down" : "up");
  }
  scheduleScrollStateCheck();
}

function setInteractionPin(pin: "selection" | "note", active: boolean) {
  if (pin === "selection") {
    if (selectionPinActive === active) return;
    selectionPinActive = active;
  }
  else {
    if (notePinActive === active) return;
    notePinActive = active;
  }
  emit("interaction-pin", pin, active);
}

function onSelectionChange() {
  const root = prose.value;
  const selection = window.getSelection();
  const active = Boolean(
    root
    && selection
    && !selection.isCollapsed
    && selection.anchorNode
    && selection.focusNode
    && root.contains(selection.anchorNode)
    && root.contains(selection.focusNode),
  );
  setInteractionPin("selection", active);
}

function onPointerDown(event: PointerEvent) {
  fastScrollInteractionSinceRequest = true;
  scrollAnchorRestoreEpoch += 1;
  navigationScrollAnchor = null;
  emit("viewport-interaction");
  const target = event.target;
  if (target instanceof Element && target.closest(".note-card")) {
    setInteractionPin("note", true);
  }
}

function releaseNotePinAfterPointerHandlers() {
  if (!notePinActive) return;
  if (notePinReleaseTimer !== null) window.clearTimeout(notePinReleaseTimer);
  notePinReleaseTimer = window.setTimeout(() => {
    notePinReleaseTimer = null;
    setInteractionPin("note", false);
  }, 0);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function onKeydown(event: KeyboardEvent) {
  const el = pane.value;
  if (!el || isEditableTarget(event.target)) return;
  const line = 72;
  const page = Math.max(line, Math.floor(el.clientHeight * 0.82));
  let delta = 0;
  if (event.key === "ArrowDown") delta = line;
  else if (event.key === "ArrowUp") delta = -line;
  else if (event.key === "PageDown") delta = page;
  else if (event.key === "PageUp") delta = -page;
  else return;
  fastScrollInteractionSinceRequest = true;
  scrollAnchorRestoreEpoch += 1;
  navigationScrollAnchor = null;
  emit("viewport-interaction", delta > 0 ? "down" : "up");
  if (delta > 0 && atBottomEdge(el)) {
    scheduleScrollStateCheck();
    return;
  }
  if (delta < 0 && atTopEdge(el)) {
    scheduleScrollStateCheck();
    return;
  }
  event.preventDefault();
  el.scrollBy({ top: delta, behavior: "smooth" });
  scheduleScrollStateCheck();
}

function markdownPlacementTarget(event: PointerEvent): { lid: string } | null {
  const root = pane.value;
  return root
    ? resolveMarkdownNotePlacementTarget(event, root, validPlacementLids.value)
    : null;
}

function onPointerMove(event: PointerEvent) {
  if (!props.notePlacementActive) return;
  placementCandidateLid.value = markdownPlacementTarget(event)?.lid ?? null;
}

function onPointerLeave() {
  placementCandidateLid.value = null;
}

function onPointerUp(event: PointerEvent) {
  if (props.notePlacementActive) {
    emit("note-placement-pointer", event);
    const target = markdownPlacementTarget(event);
    placementCandidateLid.value = target?.lid ?? null;
    if (target) emit("note-placement-target", target);
    else emit("note-placement-invalid");
  }
  releaseNotePinAfterPointerHandlers();
}

function lidElement(lid: string): HTMLElement | null {
  return mountedLidElements.get(lid) ?? null;
}

function captureScrollAnchor(candidateLids: string[]): ScrollAnchor | null {
  const el = pane.value;
  if (!el) return null;
  const paneRect = el.getBoundingClientRect();
  let best: { lid: string; top: number; score: number } | null = null;
  for (const lid of candidateLids) {
    const node = lidElement(lid);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    const top = rect.top - paneRect.top;
    const visible = rect.bottom >= paneRect.top && rect.top <= paneRect.bottom;
    const score = (visible ? 0 : 100_000) + Math.abs(top);
    if (!best || score < best.score) best = { lid, top, score };
  }
  return best ? { lid: best.lid, top: best.top } : null;
}

async function restoreScrollAnchor(anchor: ScrollAnchor | null, persist = true) {
  if (!anchor) return;
  const restoreEpoch = ++scrollAnchorRestoreEpoch;
  await nextTick();
  for (let pass = 0; pass < 2; pass += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (restoreEpoch !== scrollAnchorRestoreEpoch) return;
    const el = pane.value;
    const node = lidElement(anchor.lid);
    if (!el || !node) return;
    const paneRect = el.getBoundingClientRect();
    const currentTop = node.getBoundingClientRect().top - paneRect.top;
    el.scrollTop += currentTop - anchor.top;
  }
  if (persist) navigationScrollAnchor = anchor;
  scheduleScrollStateCheck();
}

async function scrollLidIntoView(lid: string): Promise<boolean> {
  await nextTick();
  const el = pane.value;
  const node = lidElement(lid);
  if (!el || !node) return false;
  const paneRect = el.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  el.scrollTop += nodeRect.top - paneRect.top;
  navigationScrollAnchor = { lid, top: 0 };
  if (currentReadingLid === lid) return true;
  currentReadingLid = lid;
  emit("current-lid", lid);
  return true;
}

function recheckViewportCoverage() {
  if (pendingViewportCoverageFrame !== null) return;
  pendingViewportCoverageFrame = requestAnimationFrame(() => {
    pendingViewportCoverageFrame = null;
    updateCurrentLid();
    checkBufferNeed();
  });
}

defineExpose({
  beginSegmentStage,
  stageSegment,
  finishSegmentStage,
  cancelSegmentStage,
  captureScrollAnchor,
  restoreScrollAnchor,
  scrollLidIntoView,
  recheckViewportCoverage,
  viewportHasCoverageGap,
});

function setupIntersectionObservers() {
  const root = pane.value;
  if (!root || typeof IntersectionObserver === "undefined") return;
  lidVisibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const lid = (entry.target as HTMLElement).dataset.lid;
      if (!lid) continue;
      if (entry.isIntersecting) visibleLids.add(lid);
      else visibleLids.delete(lid);
    }
    scheduleScrollStateCheck();
  }, { root, threshold: 0 });
  for (const element of mountedLidElements.values()) lidVisibilityObserver.observe(element);

  edgeObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target === topEdgeSentinel.value) pendingEdgeDirections.add("up");
      if (entry.target === bottomEdgeSentinel.value) pendingEdgeDirections.add("down");
    }
    scheduleScrollStateCheck();
  }, {
    root,
    rootMargin: `${preloadPx(root)}px 0px`,
    threshold: 0,
  });
  rearmEdgeSentinels();
  edgeObservationEnabled = true;
}

function setupHeightObserver() {
  if (!props.boundedBufferEnabled || typeof ResizeObserver === "undefined") {
    scheduleHeightMeasurement();
    return;
  }
  heightObserver = new ResizeObserver((entries) => {
    let layoutChanged = false;
    let layoutAnchor: ScrollAnchor | null = null;
    for (const entry of entries) {
      if (entry.target === prose.value) {
        layoutAnchor ??= captureScrollAnchor(probeCandidateLids());
        layoutChanged = resetHeightLedgerIdentity(layoutToken()) || layoutChanged;
        continue;
      }
      const mounted = [...mountedRenderItems.values()]
        .find((item) => item.element === entry.target);
      if (!mounted) continue;
      const borderSize = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize;
      recordRenderItemHeight(
        mounted,
        borderSize?.blockSize ?? entry.contentRect.height,
      );
    }
    if (layoutChanged) {
      scheduleHeightMeasurement();
      void restoreScrollAnchor(layoutAnchor, false);
    }
    if (navigationScrollAnchor) {
      void restoreScrollAnchor(navigationScrollAnchor);
    }
  });
  if (prose.value) heightObserver.observe(prose.value);
  for (const item of mountedRenderItems.values()) heightObserver.observe(item.element);
  scheduleHeightMeasurement();
}

function rearmEdgeSentinels() {
  if (!edgeObserver) return;
  if (topEdgeSentinel.value) edgeObserver.observe(topEdgeSentinel.value);
  if (bottomEdgeSentinel.value) edgeObserver.observe(bottomEdgeSentinel.value);
}

onMounted(async () => {
  refreshLidOrder();
  await nextTick();
  resetHeightLedgerIdentity(layoutToken());
  setupIntersectionObservers();
  setupHeightObserver();
  document.addEventListener("selectionchange", onSelectionChange);
  if (readerPerformanceCompiled) recordPerformanceDomState();
  scheduleScrollStateCheck();
});
onBeforeUnmount(() => {
  if (pendingScrollStateFrame !== null) cancelAnimationFrame(pendingScrollStateFrame);
  if (pendingViewportCoverageFrame !== null) cancelAnimationFrame(pendingViewportCoverageFrame);
  if (pendingHeightMeasurementFrame !== null) cancelAnimationFrame(pendingHeightMeasurementFrame);
  if (notePinReleaseTimer !== null) window.clearTimeout(notePinReleaseTimer);
  pendingScrollStateFrame = null;
  pendingViewportCoverageFrame = null;
  pendingHeightMeasurementFrame = null;
  notePinReleaseTimer = null;
  lidVisibilityObserver?.disconnect();
  edgeObserver?.disconnect();
  heightObserver?.disconnect();
  document.removeEventListener("selectionchange", onSelectionChange);
  if (selectionPinActive) setInteractionPin("selection", false);
  if (notePinActive) setInteractionPin("note", false);
  lidVisibilityObserver = null;
  edgeObserver = null;
  heightObserver = null;
  edgeObservationEnabled = false;
  mountedLidElements.clear();
  mountedRenderItems.clear();
  visibleLids.clear();
  pendingEdgeDirections.clear();
});
watch(() => props.notePlacementActive, (active) => {
  if (!active) placementCandidateLid.value = null;
});
watch(() => props.bufferRange, () => {
  if (!segmentStage.value) bufferRangeOverride.value = null;
});
watch(() => props.segments, () => {
  segmentStage.value = null;
  bufferRangeOverride.value = null;
});

watch(
  () => [
    props.sourceFingerprint ?? "reader-source-unresolved",
    props.rendererVersion ?? "reader-markdown-v1",
    props.estimatedLeafHeightPx ?? 48,
    ...(props.leafOrder ?? []),
  ],
  () => {
    const changed = resetHeightLedgerIdentity();
    if (changed) {
      noteOpenByMemId.clear();
      scheduleHeightMeasurement();
    }
  },
  { flush: "sync" },
);

watch(
  () => {
    const current = renderedSegments.value;
    const first = current[0]?.lid ?? "";
    const last = current[current.length - 1]?.lid ?? "";
    return `${current.length}:${first}:${last}`;
  },
  async () => {
    refreshLidOrder();
    await nextTick();
    if (edgeObserver) {
      if (topEdgeSentinel.value) edgeObserver.unobserve(topEdgeSentinel.value);
      if (bottomEdgeSentinel.value) edgeObserver.unobserve(bottomEdgeSentinel.value);
      rearmEdgeSentinels();
    }
    if (readerPerformanceCompiled) recordPerformanceDomState();
    scheduleScrollStateCheck();
  },
);
</script>

<template>
  <main
    ref="pane"
    class="reader-pane"
    tabindex="0"
    @scroll.passive="onScroll"
    @wheel.passive="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @pointerup="onPointerUp"
    @pointercancel="releaseNotePinAfterPointerHandlers"
    @keydown="onKeydown"
  >
    <div
      v-if="props.fastScrollLoadingLid"
      class="reader-fast-scroll-loading"
      :data-target-lid="props.fastScrollLoadingLid"
      role="status"
      aria-live="polite"
    >
      <span>正在加载目标位置…</span>
    </div>
    <article ref="prose" class="prose" @mouseup="emit('prose-mouse-up')">
      <div
        v-if="props.boundedBufferEnabled"
        class="reader-spacer reader-spacer-top"
        :style="topSpacerStyle"
        :data-spacer-px="bufferSpacers.topSpacerPx"
        aria-hidden="true"
      ></div>
      <div ref="topEdgeSentinel" class="reader-edge-sentinel reader-edge-sentinel-top" aria-hidden="true"></div>
      <div
        v-for="item in readerItems"
        :key="itemKey(item)"
        :ref="(element) => registerRenderItem(item, element)"
        class="seg"
        :data-reader-item-key="itemKey(item)"
      >
        <template v-if="item.type === 'flow'">
          <p class="flow-paragraph">
            <template v-for="seg in item.segments" :key="seg.lid">
              <button
                v-if="seg.kind === 'formula' && seg.formula"
                :ref="(element) => registerLidElement(seg.lid, element)"
                :data-lid="seg.lid"
                class="formula-open"
                :class="{
                  anchor: seg.lid === props.viewportAnchor,
                  selected: seg.lid === props.selectedLid,
                  hl: props.isHighlighted(seg.lid),
                  'note-placement-candidate': seg.lid === placementCandidateLid,
                }"
                title="查看公式语义剖面"
                @click.stop="emit('open-formula', seg)"
              >
                <StableReaderSegment
                  as="span"
                  class="formula-open-source"
                  :segment="seg"
                  :source-fingerprint="props.sourceFingerprint ?? ''"
                  :renderer-version="props.rendererVersion ?? 'reader-markdown-v1'"
                  :render-revision="renderRevision(seg.lid)"
                  :render-seg="props.renderSeg"
                />
              </button>
              <StableReaderSegment
                v-else-if="seg.kind === 'formula'"
                as="span"
                :ref="(element) => registerLidElement(seg.lid, element)"
                :data-lid="seg.lid"
                class="formula-inline-source"
                :class="{
                  anchor: seg.lid === props.viewportAnchor,
                  selected: seg.lid === props.selectedLid,
                  hl: props.isHighlighted(seg.lid),
                  'note-placement-candidate': seg.lid === placementCandidateLid,
                }"
                @click="emit('select', seg.lid)"
                :segment="seg"
                :source-fingerprint="props.sourceFingerprint ?? ''"
                :renderer-version="props.rendererVersion ?? 'reader-markdown-v1'"
                :render-revision="renderRevision(seg.lid)"
                :render-seg="props.renderSeg"
              />
              <StableReaderSegment
                v-else
                as="span"
                :ref="(element) => registerLidElement(seg.lid, element)"
                :data-lid="seg.lid"
                class="flow-text"
                :class="{
                  anchor: seg.lid === props.viewportAnchor,
                  selected: seg.lid === props.selectedLid,
                  hl: props.isHighlighted(seg.lid),
                  'note-placement-candidate': seg.lid === placementCandidateLid,
                }"
                @click="emit('select', seg.lid)"
                :segment="seg"
                :source-fingerprint="props.sourceFingerprint ?? ''"
                :renderer-version="props.rendererVersion ?? 'reader-markdown-v1'"
                :render-revision="renderRevision(seg.lid)"
                :render-seg="props.renderSeg"
              />
            </template>
          </p>
          <template v-for="seg in item.segments" :key="`meta-${seg.lid}`">
            <div v-if="seg.lid === props.selectedLid" class="block-actions">
              <button @click="emit('highlight-block', seg.lid)">高亮整段</button>
              <button @click="emit('note-block', seg.lid)">记笔记</button>
            </div>
            <div v-for="h in props.highlightCardsOf(seg.lid)" :key="h.mem_id" class="hl-card">
              <span class="hl-ex">{{ props.hlExcerpt(h) }}</span>
              <span class="hl-actions">
                <button class="note-btn" title="改范围(移除后重选)" @click="emit('modify-highlight', h)">编辑</button>
                <button class="note-btn del" title="删除高亮" @click="emit('delete-highlight', h)">删除</button>
              </span>
            </div>
            <NoteCard
              v-for="note in notesOf(seg.lid)"
              :key="note.mem_id"
              :note="note"
              :render-markdown="props.renderMarkdown"
              :open="noteOpenByMemId.get(note.mem_id)"
              @toggle="rememberNoteOpen(note.mem_id, $event)"
              @focus-source="emit('focus-source-local', $event)"
              @edit="emit('edit-note', $event)"
              @delete="emit('delete-note', $event)"
            />
          </template>
        </template>

        <template v-else-if="!props.isAsset(item.segment)">
          <StableReaderSegment
            as="p"
            :ref="(element) => registerLidElement(item.segment.lid, element)"
            :data-lid="item.segment.lid"
            :class="{
              anchor: item.segment.lid === props.viewportAnchor,
              selected: item.segment.lid === props.selectedLid,
              hl: props.isHighlighted(item.segment.lid),
              'note-placement-candidate': item.segment.lid === placementCandidateLid,
              ['heading-' + item.segment.kind]: item.segment.kind === 'chapter' || item.segment.kind === 'section',
              ...markdownHeadingClass(item.segment),
            }"
            @click="emit('select', item.segment.lid)"
            :segment="item.segment"
            :source-fingerprint="props.sourceFingerprint ?? ''"
            :renderer-version="props.rendererVersion ?? 'reader-markdown-v1'"
            :render-revision="renderRevision(item.segment.lid)"
            :render-seg="props.renderSeg"
          />
          <div v-if="item.segment.lid === props.selectedLid" class="block-actions">
            <button @click="emit('highlight-block', item.segment.lid)">高亮整段</button>
            <button @click="emit('note-block', item.segment.lid)">记笔记</button>
          </div>
        </template>

        <section
          v-else
          :ref="(element) => registerLidElement(item.segment.lid, element)"
          :data-lid="item.segment.lid"
          class="asset-block"
          :class="[`asset-${item.segment.kind}`, {
            anchor: item.segment.lid === props.viewportAnchor,
            selected: item.segment.lid === props.selectedLid,
            hl: props.isHighlighted(item.segment.lid),
            'note-placement-candidate': item.segment.lid === placementCandidateLid,
          }]"
          @click="emit('select', item.segment.lid)"
        >
          <div class="asset-head">
            <span>{{ item.segment.kind }}</span>
            <button class="asset-jump" title="选中该 LID" @click.stop="emit('select', item.segment.lid)">定位</button>
          </div>
          <pre v-if="item.segment.kind === 'code'" class="asset-source asset-code"><StableReaderSegment
              as="code"
              :segment="item.segment"
              :source-fingerprint="props.sourceFingerprint ?? ''"
              :renderer-version="props.rendererVersion ?? 'reader-markdown-v1'"
              :render-revision="renderRevision(item.segment.lid)"
              :render-seg="props.renderSeg"
            /></pre>
          <StableReaderSegment
            v-else-if="item.segment.kind === 'table'"
            as="pre"
            class="asset-source asset-table"
            :segment="item.segment"
            :source-fingerprint="props.sourceFingerprint ?? ''"
            :renderer-version="props.rendererVersion ?? 'reader-markdown-v1'"
            :render-revision="renderRevision(item.segment.lid)"
            :render-seg="props.renderSeg"
          />
          <figure v-else-if="item.segment.kind === 'image'" class="asset-image-figure">
            <img
              v-if="imageRenderSrc(props.imageAsset(item.segment.lid))"
              class="image-rendered"
              :src="imageRenderSrc(props.imageAsset(item.segment.lid)) || ''"
              :alt="props.imageAsset(item.segment.lid)?.alt || props.imageMeta(item.segment.text)?.alt || '图片'"
              loading="lazy"
              decoding="async"
            />
            <div v-else class="image-preview">
              <span>图片</span>
              <strong>{{ props.imageMeta(item.segment.text)?.alt || '未命名图片' }}</strong>
              <code>{{ props.imageMeta(item.segment.text)?.src || '来源不可用' }}</code>
            </div>
            <p v-if="props.imageAsset(item.segment.lid)?.warning" class="image-warning">
              {{ props.imageAsset(item.segment.lid)?.warning }}
            </p>
            <figcaption>原文</figcaption>
            <StableReaderSegment
              as="pre"
              class="asset-source"
              :segment="item.segment"
              :source-fingerprint="props.sourceFingerprint ?? ''"
              :renderer-version="props.rendererVersion ?? 'reader-markdown-v1'"
              :render-revision="renderRevision(item.segment.lid)"
              :render-seg="props.renderSeg"
            />
          </figure>
          <div v-if="item.segment.lid === props.selectedLid" class="block-actions asset-actions">
            <button @click.stop="emit('highlight-block', item.segment.lid)">高亮整段</button>
            <button @click.stop="emit('note-block', item.segment.lid)">记笔记</button>
          </div>
        </section>

        <template v-if="item.type === 'single'">
          <div v-for="h in props.highlightCardsOf(item.segment.lid)" :key="h.mem_id" class="hl-card">
            <span class="hl-ex">{{ props.hlExcerpt(h) }}</span>
            <span class="hl-actions">
              <button class="note-btn" title="改范围(移除后重选)" @click="emit('modify-highlight', h)">编辑</button>
              <button class="note-btn del" title="删除高亮" @click="emit('delete-highlight', h)">删除</button>
            </span>
          </div>
          <NoteCard
            v-for="note in notesOf(item.segment.lid)"
            :key="note.mem_id"
            :note="note"
            :render-markdown="props.renderMarkdown"
            :open="noteOpenByMemId.get(note.mem_id)"
            @toggle="rememberNoteOpen(note.mem_id, $event)"
            @focus-source="emit('focus-source-local', $event)"
            @edit="emit('edit-note', $event)"
            @delete="emit('delete-note', $event)"
          />
        </template>
      </div>
      <p v-if="renderedSegments.length === 0" class="empty">暂无正文。请确认服务端已加载书并正在监听。</p>
      <div ref="bottomEdgeSentinel" class="reader-edge-sentinel reader-edge-sentinel-bottom" aria-hidden="true"></div>
      <div
        v-if="props.boundedBufferEnabled"
        class="reader-spacer reader-spacer-bottom"
        :style="bottomSpacerStyle"
        :data-spacer-px="bufferSpacers.bottomSpacerPx"
        aria-hidden="true"
      ></div>
    </article>

  </main>
</template>
