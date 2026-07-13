<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import {
  type PaperViewportPosition,
  type PdfRegion,
  type PdfSourceMap,
  type PdfSourceMapEntry,
  type SourceManifestV2,
} from "../api";
import type { PdfSelectionCapture } from "../pdf-selection-draft";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const props = defineProps<{
  sourceManifest: SourceManifestV2 | null;
  sourceMap: PdfSourceMap | null;
  pdfUrl: string;
  activeLid: string | null;
  selectedLid: string | null;
}>();

const emit = defineEmits<{
  (e: "goto", lid: string): void;
  (e: "focus-source", source: { lid: string; quote: string | null }): void;
  (e: "viewport-change", position: PaperViewportPosition): void;
  (e: "selection-capture", capture: PdfSelectionCapture): void;
  (e: "selection-cancel"): void;
}>();

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
type PdfTextLayer = InstanceType<typeof pdfjsLib.TextLayer>;

interface PageRenderState {
  rendered: boolean;
  rendering: boolean;
  error: string | null;
}

const pageList = ref<HTMLElement | null>(null);
const pdfDoc = shallowRef<PdfDocument | null>(null);
const pdfLoading = ref(false);
const pdfError = ref<string | null>(null);
const pageEls = new Map<number, HTMLElement>();
const canvasEls = new Map<number, HTMLCanvasElement>();
const textLayerEls = new Map<number, HTMLElement>();
const textLayerTasks = new Map<number, PdfTextLayer>();
const renderStates = ref<Record<number, PageRenderState>>({});
let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
let observer: IntersectionObserver | null = null;
let renderToken = 0;
let viewportFrame: number | null = null;
let lastViewportFingerprint = "";
let selectionRequestSequence = 0;

const pageCount = computed(() => props.sourceMap?.pages.length ?? 0);
const entriesByPage = computed(() => {
  const map = new Map<number, Array<{ entry: PdfSourceMapEntry; region: PdfRegion }>>();
  for (const entry of props.sourceMap?.entries ?? []) {
    for (const region of entry.regions) {
      const list = map.get(region.pageIndex);
      if (list) list.push({ entry, region });
      else map.set(region.pageIndex, [{ entry, region }]);
    }
  }
  return map;
});
const entryByLid = computed(() => new Map((props.sourceMap?.entries ?? []).map((entry) => [entry.lid, entry])));
const activeEntry = computed(() => {
  const lid = props.activeLid ?? props.selectedLid;
  return lid ? entryByLid.value.get(lid) ?? null : null;
});
const activePageIndex = computed(() => activeEntry.value?.primary_region?.pageIndex ?? activeEntry.value?.regions[0]?.pageIndex ?? 0);
const mapCapability = computed(() => props.sourceManifest?.capabilities.project_lid_to_pdf.status ?? "unavailable");
const capabilityStatusLabels: Record<string, string> = {
  available: "映射可用",
  degraded: "映射降级可用",
  missing: "缺少映射",
  unavailable: "映射不可用",
  external: "外部资源",
  unsupported: "暂不支持",
};
const mapCapabilityLabel = computed(() => capabilityStatusLabels[mapCapability.value] ?? mapCapability.value);

function pageRegions(pageIndex: number): Array<{ entry: PdfSourceMapEntry; region: PdfRegion }> {
  return entriesByPage.value.get(pageIndex) ?? [];
}

function nearestMappedLid(centerPage: number): string | null {
  let nearest: { lid: string; distance: number; order: number } | null = null;
  for (const [order, entry] of (props.sourceMap?.entries ?? []).entries()) {
    for (const region of entry.regions) {
      const page = props.sourceMap?.pages.find((item) => item.pageIndex === region.pageIndex);
      if (!page) continue;
      const verticalCenter = (region.bbox[1] + region.bbox[3]) / 2;
      const visualRatio = Math.max(0, Math.min(0.999999, (page.height - verticalCenter) / page.height));
      const distance = Math.abs(region.pageIndex + visualRatio - centerPage);
      if (!nearest || distance < nearest.distance || (distance === nearest.distance && order < nearest.order)) {
        nearest = { lid: entry.lid, distance, order };
      }
    }
  }
  return nearest?.lid ?? null;
}

function measureViewport(): PaperViewportPosition | null {
  const root = pageList.value;
  const pages = props.sourceMap?.pages ?? [];
  if (!root || !pages.length) return null;
  const rootRect = root.getBoundingClientRect();
  if (rootRect.height <= 0) return null;
  const visible = pages.filter((page) => {
    const rect = pageEls.get(page.pageIndex)?.getBoundingClientRect();
    return !!rect && rect.bottom > rootRect.top && rect.top < rootRect.bottom;
  });
  if (!visible.length) return null;
  const rootCenter = rootRect.top + rootRect.height / 2;
  const centerPage = visible
    .map((page) => {
      const rect = pageEls.get(page.pageIndex)!.getBoundingClientRect();
      const distance = rootCenter < rect.top
        ? rect.top - rootCenter
        : rootCenter > rect.bottom
          ? rootCenter - rect.bottom
          : 0;
      return { page, rect, distance };
    })
    .sort((left, right) => left.distance - right.distance || left.page.pageIndex - right.page.pageIndex)[0];
  const localRatio = Math.max(
    0,
    Math.min(0.999999, (rootCenter - centerPage.rect.top) / Math.max(1, centerPage.rect.height)),
  );
  const center = centerPage.page.pageIndex + localRatio;
  const firstPage = Math.min(...pages.map((page) => page.pageIndex));
  const lastPage = Math.max(...pages.map((page) => page.pageIndex));
  return {
    start_page: Math.min(...visible.map((page) => page.pageIndex)),
    end_page: Math.max(...visible.map((page) => page.pageIndex)),
    center_page: center,
    progress_ratio: Math.max(0, Math.min(1, (center - firstPage) / Math.max(1, lastPage - firstPage + 1))),
    anchor_lid: nearestMappedLid(center),
    region_id: null,
  };
}

function emitViewportChange() {
  viewportFrame = null;
  const position = measureViewport();
  if (!position) return;
  const fingerprint = [
    position.start_page,
    position.end_page,
    position.center_page.toFixed(4),
    position.anchor_lid ?? "",
  ].join(":");
  if (fingerprint === lastViewportFingerprint) return;
  lastViewportFingerprint = fingerprint;
  emit("viewport-change", position);
}

function scheduleViewportChange() {
  if (viewportFrame !== null) return;
  viewportFrame = window.requestAnimationFrame(emitViewportChange);
}

function pageShellStyle(page: PdfSourceMap["pages"][number]): Record<string, string> {
  return {
    aspectRatio: `${page.width} / ${page.height}`,
  };
}

function pointToPdf(pageIndex: number, event: MouseEvent): { x: number; y: number } | null {
  const page = props.sourceMap?.pages.find((p) => p.pageIndex === pageIndex);
  const pageEl = pageEls.get(pageIndex);
  if (!page || !pageEl) return null;
  const rect = pageEl.getBoundingClientRect();
  const scale = rect.width / page.width;
  return {
    x: (event.clientX - rect.left) / scale,
    y: page.height - (event.clientY - rect.top) / scale,
  };
}

function regionContains(region: PdfRegion, point: { x: number; y: number }): boolean {
  const [x1, y1, x2, y2] = region.bbox;
  return point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2;
}

function hitEntry(pageIndex: number, event: MouseEvent): PdfSourceMapEntry | null {
  const point = pointToPdf(pageIndex, event);
  if (!point) return null;
  const hit = [...pageRegions(pageIndex)].reverse().find(({ region }) => regionContains(region, point));
  return hit?.entry ?? null;
}

function onPageClick(pageIndex: number, event: MouseEvent) {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  emit("selection-cancel");
  const entry = hitEntry(pageIndex, event);
  if (entry) emit("goto", entry.lid);
}

function setPageRef(pageIndex: number, el: unknown) {
  if (el instanceof HTMLElement) pageEls.set(pageIndex, el);
  else pageEls.delete(pageIndex);
}

function setCanvasRef(pageIndex: number, el: unknown) {
  if (el instanceof HTMLCanvasElement) canvasEls.set(pageIndex, el);
  else canvasEls.delete(pageIndex);
}

function setTextLayerRef(pageIndex: number, el: unknown) {
  if (el instanceof HTMLElement) textLayerEls.set(pageIndex, el);
  else textLayerEls.delete(pageIndex);
}

function setRenderState(pageIndex: number, patch: Partial<PageRenderState>) {
  const previous = renderStates.value[pageIndex] ?? {
    rendered: false,
    rendering: false,
    error: null,
  };
  renderStates.value = {
    ...renderStates.value,
    [pageIndex]: {
      ...previous,
      ...patch,
    },
  };
}

function resetRenderedPages() {
  renderStates.value = {};
  for (const task of textLayerTasks.values()) task.cancel();
  textLayerTasks.clear();
  for (const canvas of canvasEls.values()) {
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }
  for (const layer of textLayerEls.values()) layer.replaceChildren();
}

async function loadPdfDocument() {
  renderToken += 1;
  const token = renderToken;
  pdfDoc.value = null;
  pdfError.value = null;
  pdfLoading.value = true;
  resetRenderedPages();
  if (loadingTask) {
    void loadingTask.destroy();
    loadingTask = null;
  }
  try {
    loadingTask = pdfjsLib.getDocument({ url: props.pdfUrl });
    const doc = await loadingTask.promise;
    if (token !== renderToken) {
      await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
      return;
    }
    pdfDoc.value = doc;
    await nextTick();
    observePages();
    await renderVisiblePages();
    scheduleViewportChange();
  } catch (e) {
    if (token === renderToken) pdfError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === renderToken) pdfLoading.value = false;
  }
}

function pageScale(pageIndex: number): number {
  const page = props.sourceMap?.pages.find((p) => p.pageIndex === pageIndex);
  const el = pageEls.get(pageIndex);
  if (!page || !el) return 1;
  return el.clientWidth / page.width;
}

async function renderPage(pageInfo: PdfSourceMap["pages"][number], token: number) {
  if (!pdfDoc.value) return;
  const state = renderStates.value[pageInfo.pageIndex];
  if (state?.rendered || state?.rendering) return;
  const canvas = canvasEls.get(pageInfo.pageIndex);
  const textLayer = textLayerEls.get(pageInfo.pageIndex);
  if (!canvas || !textLayer) return;
  setRenderState(pageInfo.pageIndex, { rendering: true, error: null });
  try {
    const page: PdfPage = await pdfDoc.value.getPage(pageInfo.pageIndex + 1);
    if (token !== renderToken) return;
    const scale = pageScale(pageInfo.pageIndex);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    if (token !== renderToken) return;
    await renderTextLayer(pageInfo.pageIndex, page, viewport, textLayer);
    setRenderState(pageInfo.pageIndex, { rendered: true, rendering: false, error: null });
  } catch (e) {
    setRenderState(pageInfo.pageIndex, {
      rendering: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function renderTextLayer(
  pageIndex: number,
  page: PdfPage,
  viewport: ReturnType<PdfPage["getViewport"]>,
  layer: HTMLElement,
) {
  const content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  layer.replaceChildren();
  layer.style.setProperty("--scale-factor", String(viewport.scale));
  layer.style.setProperty("--user-unit", "1");
  layer.style.setProperty("--total-scale-factor", "calc(var(--scale-factor) * var(--user-unit))");
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: content,
    container: layer,
    viewport,
  });
  layer.style.width = `${viewport.width}px`;
  layer.style.height = `${viewport.height}px`;
  textLayerTasks.set(pageIndex, textLayer);
  try {
    await textLayer.render();
  } finally {
    if (textLayerTasks.get(pageIndex) === textLayer) textLayerTasks.delete(pageIndex);
  }
}

function observePages() {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageIndex = Number((entry.target as HTMLElement).dataset.pageIndex);
        const page = props.sourceMap?.pages.find((p) => p.pageIndex === pageIndex);
        if (page) void renderPage(page, renderToken);
      }
    },
    { root: pageList.value, rootMargin: "700px 0px" },
  );
  for (const el of pageEls.values()) observer.observe(el);
}

async function renderVisiblePages() {
  const pages = props.sourceMap?.pages ?? [];
  const visible = pages.filter((page) => {
    const el = pageEls.get(page.pageIndex);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const root = pageList.value?.getBoundingClientRect();
    if (!root) return false;
    return rect.bottom >= root.top - 700 && rect.top <= root.bottom + 700;
  });
  for (const page of visible.length ? visible : pages.slice(0, 2)) {
    await renderPage(page, renderToken);
  }
}

async function scrollActiveIntoView() {
  await nextTick();
  const pageIndex = activePageIndex.value;
  const target = pageList.value?.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`);
  target?.scrollIntoView({ block: "center" });
  const page = props.sourceMap?.pages.find((p) => p.pageIndex === pageIndex);
  if (page) await renderPage(page, renderToken);
}

function rectToPdfRegion(rect: DOMRect, pageIndex: number): PdfRegion | null {
  const page = props.sourceMap?.pages.find((p) => p.pageIndex === pageIndex);
  const pageEl = pageEls.get(pageIndex);
  if (!page || !pageEl) return null;
  const pageRect = pageEl.getBoundingClientRect();
  const left = Math.max(rect.left, pageRect.left);
  const right = Math.min(rect.right, pageRect.right);
  const top = Math.max(rect.top, pageRect.top);
  const bottom = Math.min(rect.bottom, pageRect.bottom);
  if (right <= left || bottom <= top) return null;
  const scale = pageRect.width / page.width;
  const x1 = (left - pageRect.left) / scale;
  const x2 = (right - pageRect.left) / scale;
  const y1 = page.height - (bottom - pageRect.top) / scale;
  const y2 = page.height - (top - pageRect.top) / scale;
  return { region_id: `selection:${pageIndex}:${x1}:${y1}`, pageIndex, bbox: [x1, y1, x2, y2] };
}

function rectsOverlap(left: DOMRect, right: DOMRect): boolean {
  return left.right > right.left && left.left < right.right && left.bottom > right.top && left.top < right.bottom;
}

function capturePdfSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const rawQuote = selection.toString();
  if (!rawQuote.trim()) return;
  const rects: PdfSelectionCapture["rects"] = [];
  const clientRects: DOMRect[] = [];
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    for (const rect of selection.getRangeAt(i).getClientRects()) {
      clientRects.push(rect);
      for (const [pageIndex, pageEl] of pageEls) {
        const selectionTouchesPage =
          (anchorNode ? pageEl.contains(anchorNode) : false)
          || (focusNode ? pageEl.contains(focusNode) : false)
          || rectsOverlap(rect, pageEl.getBoundingClientRect());
        if (!selectionTouchesPage) continue;
        const region = rectToPdfRegion(rect, pageIndex);
        if (region) rects.push({ pageIndex, bbox: region.bbox });
      }
    }
  }
  if (!rects.length || !clientRects.length) return;
  const screenRect = clientRects.reduce(
    (box, rect) => ({
      left: Math.min(box.left, rect.left),
      top: Math.min(box.top, rect.top),
      right: Math.max(box.right, rect.right),
      bottom: Math.max(box.bottom, rect.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
  selectionRequestSequence += 1;
  emit("selection-capture", {
    request_id: `pdf-selection-${Date.now()}-${selectionRequestSequence}`,
    raw_quote: rawQuote,
    rects,
    screen_rect: screenRect,
  });
}

function onSelectionKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("selection-cancel");
}

watch(
  () => [props.pdfUrl, props.sourceMap?.config_hash] as const,
  () => {
    emit("selection-cancel");
    if (props.pdfUrl && props.sourceMap) void loadPdfDocument();
  },
  { immediate: true },
);

watch(
  () => [props.activeLid, props.selectedLid, props.sourceMap?.config_hash] as const,
  () => {
    void scrollActiveIntoView();
  },
);

watch(pageCount, async () => {
  await nextTick();
  observePages();
  scheduleViewportChange();
});

window.addEventListener("resize", scheduleViewportChange);
window.addEventListener("keydown", onSelectionKeydown);

onBeforeUnmount(() => {
  renderToken += 1;
  if (viewportFrame !== null) window.cancelAnimationFrame(viewportFrame);
  window.removeEventListener("resize", scheduleViewportChange);
  window.removeEventListener("keydown", onSelectionKeydown);
  emit("selection-cancel");
  observer?.disconnect();
  if (loadingTask) void loadingTask.destroy();
  if (pdfDoc.value) void (pdfDoc.value as unknown as { destroy?: () => Promise<void> }).destroy?.();
});
</script>

<template>
  <main class="pdf-reader-pane">
    <header class="pdf-reader-head">
      <div>
        <strong>{{ props.sourceManifest?.book_id ?? props.sourceMap?.book_id ?? "PDF" }}</strong>
        <span>{{ pageCount }} 页 · {{ mapCapabilityLabel }}</span>
      </div>
      <span v-if="pdfLoading">正在加载 PDF</span>
      <span v-else-if="pdfError" class="pdf-error">{{ pdfError }}</span>
    </header>

    <div
      ref="pageList"
      class="pdf-page-list"
      @scroll.passive="scheduleViewportChange"
      @mouseup="capturePdfSelection"
    >
      <section
        v-for="page in props.sourceMap?.pages ?? []"
        :key="page.pageIndex"
        :ref="(el) => setPageRef(page.pageIndex, el)"
        class="pdf-page-shell"
        :class="{ active: page.pageIndex === activePageIndex }"
        :data-page-index="page.pageIndex"
        :style="pageShellStyle(page)"
        @click="onPageClick(page.pageIndex, $event)"
      >
        <canvas :ref="(el) => setCanvasRef(page.pageIndex, el)" class="pdf-page-canvas"></canvas>
        <div :ref="(el) => setTextLayerRef(page.pageIndex, el)" class="pdf-text-layer"></div>
        <div class="pdf-page-label">{{ page.page_label ?? page.pageIndex + 1 }}</div>
        <p v-if="renderStates[page.pageIndex]?.error" class="pdf-page-error">
          {{ renderStates[page.pageIndex]?.error }}
        </p>
      </section>
      <p v-if="!props.sourceMap?.pages.length" class="pdf-empty">暂无 PDF 映射。</p>
    </div>

    <footer v-if="props.activeLid && !activeEntry" class="pdf-map-foot">
      <button @click="props.activeLid && emit('focus-source', { lid: props.activeLid, quote: null })">打开来源正文</button>
    </footer>
  </main>
</template>

<style scoped>
.pdf-reader-pane {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--reader-canvas);
  border-left: 1px solid var(--hairline-soft);
  border-right: 1px solid var(--hairline-soft);
}
.pdf-reader-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--hairline-soft);
  background: var(--surface-soft);
}
.pdf-reader-head div {
  min-width: 0;
  display: grid;
  gap: 0.08rem;
}
.pdf-reader-head strong {
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 0.9rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-reader-head span {
  color: var(--muted);
  font-size: 0.76rem;
}
.pdf-reader-head .pdf-error {
  color: var(--brand-error);
}
.pdf-page-list {
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-auto-rows: max-content;
  justify-items: center;
  gap: 1.1rem;
  align-content: start;
  padding: 1.1rem;
}
.pdf-page-shell {
  position: relative;
  width: min(100%, 56rem);
  overflow: hidden;
  border: 1px solid var(--hairline);
  background: #fff;
  content-visibility: auto;
  contain-intrinsic-size: 720px 940px;
}
.pdf-page-shell.active {
  border-color: var(--reader-coral);
}
.pdf-page-canvas,
.pdf-text-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.pdf-page-canvas {
  z-index: 0;
}
.pdf-text-layer {
  z-index: 1;
  overflow: hidden;
  text-align: initial;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  transform-origin: 0 0;
  user-select: text;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.pdf-text-layer :deep(:is(span, br)) {
  position: absolute;
  color: transparent;
  transform-origin: left top;
  white-space: pre;
  cursor: text;
  user-select: text;
}
.pdf-text-layer :deep(span:not(.markedContent)) {
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv));
}
.pdf-text-layer :deep(.markedContent) {
  display: contents;
}
.pdf-page-label {
  position: absolute;
  top: 0.45rem;
  left: 0.5rem;
  z-index: 4;
  min-width: 1.6rem;
  padding: 0.12rem 0.32rem;
  border: 1px solid var(--hairline-soft);
  background: rgba(255, 255, 255, 0.86);
  color: var(--muted);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}
.pdf-map-foot {
  padding: 0.7rem 0.8rem;
  border-top: 1px solid var(--hairline-soft);
}
.pdf-map-foot button {
  width: 100%;
  min-height: 38px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
}
.pdf-empty,
.pdf-page-error {
  margin: 0;
  color: var(--muted);
  font-size: 0.86rem;
}
.pdf-page-error {
  position: absolute;
  inset: auto 1rem 1rem;
  z-index: 5;
  color: var(--brand-error);
}

@media (max-width: 900px) {
  .pdf-page-list {
    padding: 0.65rem;
  }
  .pdf-page-shell {
    width: 100%;
  }
}
</style>
