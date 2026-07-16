<script setup lang="ts">
import { Eye, EyeOff, MessageSquareText, Minus, Plus, Scan, ScanText, Trash2, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import {
  type MemoryRecord,
  type PaperViewportPosition,
  type PdfRegion,
  type PdfSourceMap,
  type PdfSourceMapEntry,
  type SourceManifestV2,
} from "../api";
import {
  EMPTY_PDF_ANNOTATION_PROJECTION,
  layoutNoteMarkers,
  overlayPointToPdf,
  pdfPageVisualSize,
  pdfRectToOverlay,
  type PdfNoteMarkerLayout,
  type PdfUserAnnotationProjection,
  type ProjectedHighlight,
  type ProjectedNoteMarker,
} from "../pdf-annotation-projection";
import type { PdfSelectionCapture } from "../pdf-selection-draft";
import NoteCard from "./NoteCard.vue";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const props = withDefaults(defineProps<{
  sourceManifest: SourceManifestV2 | null;
  sourceMap: PdfSourceMap | null;
  pdfUrl: string;
  activeLid: string | null;
  selectedLid: string | null;
  annotationProjection?: PdfUserAnnotationProjection;
  annotationError?: string | null;
  renderMarkdown?: (source: string) => string;
}>(), {
  annotationProjection: () => EMPTY_PDF_ANNOTATION_PROJECTION,
  annotationError: null,
  renderMarkdown: (source: string) => source,
});

const emit = defineEmits<{
  (e: "goto", lid: string): void;
  (e: "focus-source", source: { lid: string; quote: string | null }): void;
  (e: "viewport-change", position: PaperViewportPosition): void;
  (e: "viewport-interaction"): void;
  (e: "selection-capture", capture: PdfSelectionCapture): void;
  (e: "selection-cancel"): void;
  (e: "edit-note", note: MemoryRecord): void;
  (e: "delete-note", note: MemoryRecord): void;
  (e: "reselect-note", note: MemoryRecord): void;
  (e: "delete-highlight", highlight: MemoryRecord): void;
  (e: "reselect-highlight", highlight: MemoryRecord): void;
}>();

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
type PdfTextLayer = InstanceType<typeof pdfjsLib.TextLayer>;
type PdfRenderTask = ReturnType<PdfPage["render"]>;

const PDF_ZOOM_MIN = 0.75;
const PDF_ZOOM_MAX = 2.5;
const PDF_ZOOM_STEP = 0.25;
const PDF_PAGE_MAX_WIDTH_REM = 56;

interface PageRenderState {
  rendered: boolean;
  rendering: boolean;
  error: string | null;
}

interface SurfaceAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type AnnotationSurface =
  | { kind: "notes"; terminalKey: string; anchor: SurfaceAnchor }
  | { kind: "highlight"; memId: string; anchor: SurfaceAnchor };

const pageList = ref<HTMLElement | null>(null);
const pdfDoc = shallowRef<PdfDocument | null>(null);
const pdfLoading = ref(false);
const pdfError = ref<string | null>(null);
const pageEls = new Map<number, HTMLElement>();
const canvasEls = new Map<number, HTMLCanvasElement>();
const textLayerEls = new Map<number, HTMLElement>();
const textLayerTasks = new Map<number, PdfTextLayer>();
const pageRenderTasks = new Map<number, PdfRenderTask>();
const renderStates = ref<Record<number, PageRenderState>>({});
const annotationSurface = ref<AnnotationSurface | null>(null);
const noteMarkersVisible = ref(true);
const zoom = ref(1);
let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
let observer: IntersectionObserver | null = null;
let renderToken = 0;
let viewportFrame: number | null = null;
let lastViewportFingerprint = "";
let selectionRequestSequence = 0;

const activeNoteMarker = computed(() => {
  if (!noteMarkersVisible.value) return null;
  const surface = annotationSurface.value;
  if (surface?.kind !== "notes") return null;
  return props.annotationProjection.note_markers.find((marker) => marker.terminal_key === surface.terminalKey) ?? null;
});
const activeHighlight = computed(() => {
  const surface = annotationSurface.value;
  if (surface?.kind !== "highlight") return null;
  return props.annotationProjection.highlights.find((highlight) => highlight.mem_id === surface.memId) ?? null;
});
const annotationSurfaceStyle = computed(() => {
  const surface = annotationSurface.value;
  if (!surface) return {};
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(360, Math.max(280, viewportWidth - 16));
  const estimatedHeight = Math.min(420, Math.max(240, viewportHeight - 16));
  const opensLeft = surface.anchor.right + 10 + width > viewportWidth - 8;
  const opensAbove = surface.anchor.bottom + 10 + estimatedHeight > viewportHeight - 8;
  const left = opensLeft ? surface.anchor.left - width - 10 : surface.anchor.right + 10;
  const top = opensAbove ? surface.anchor.top - estimatedHeight - 10 : surface.anchor.bottom + 10;
  return {
    left: `${Math.max(8, Math.min(left, viewportWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(top, viewportHeight - estimatedHeight - 8))}px`,
    width: `${width}px`,
    maxHeight: `${estimatedHeight}px`,
  };
});

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
const activeRegion = computed(() => activeEntry.value?.primary_region ?? activeEntry.value?.regions[0] ?? null);
const activePageIndex = computed(() => activeRegion.value?.pageIndex ?? null);
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
const zoomText = computed(() => `${Math.round(zoom.value * 100)}%`);

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

function onViewportScroll() {
  scheduleViewportChange();
  emit("viewport-interaction");
}

function pageShellStyle(page: PdfSourceMap["pages"][number]): Record<string, string> {
  const visual = pdfPageVisualSize(page);
  const zoomPercent = Math.round(zoom.value * 100);
  const maxWidth = Number((PDF_PAGE_MAX_WIDTH_REM * zoom.value).toFixed(2));
  return {
    aspectRatio: `${visual.width} / ${visual.height}`,
    "--pdf-page-width": `${zoomPercent}%`,
    "--pdf-page-max-width": `${maxWidth}rem`,
  };
}

interface PdfZoomAnchor {
  pageIndex: number;
  pageRatio: number;
  probeOffset: number;
  horizontalRatio: number | null;
}

function captureZoomAnchor(): PdfZoomAnchor | null {
  const root = pageList.value;
  if (!root) return null;
  const rootRect = root.getBoundingClientRect();
  if (rootRect.height <= 0) return null;
  const probeOffset = Math.min(
    Math.max(rootRect.height * 0.28, 96),
    Math.max(rootRect.height - 24, 0),
  );
  const probeY = rootRect.top + probeOffset;
  const candidates = [...pageEls.entries()]
    .map(([pageIndex, element]) => ({ pageIndex, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height > 0)
    .sort((left, right) => {
      const leftDistance = probeY < left.rect.top
        ? left.rect.top - probeY
        : probeY > left.rect.bottom
          ? probeY - left.rect.bottom
          : 0;
      const rightDistance = probeY < right.rect.top
        ? right.rect.top - probeY
        : probeY > right.rect.bottom
          ? probeY - right.rect.bottom
          : 0;
      return leftDistance - rightDistance || left.pageIndex - right.pageIndex;
    });
  const target = candidates[0];
  if (!target) return null;
  const pageRatio = Math.max(0, Math.min(1, (probeY - target.rect.top) / target.rect.height));
  const horizontalRatio = root.scrollWidth > 0
    ? (root.scrollLeft + root.clientWidth / 2) / root.scrollWidth
    : null;
  return { pageIndex: target.pageIndex, pageRatio, probeOffset, horizontalRatio };
}

function restoreZoomAnchor(anchor: PdfZoomAnchor | null) {
  if (!anchor) return;
  const root = pageList.value;
  const target = pageEls.get(anchor.pageIndex);
  if (!root || !target) return;
  const rootRect = root.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetY = targetRect.top + targetRect.height * anchor.pageRatio;
  root.scrollTop = Math.max(0, root.scrollTop + targetY - (rootRect.top + anchor.probeOffset));
  if (anchor.horizontalRatio !== null && root.scrollWidth > root.clientWidth) {
    root.scrollLeft = Math.max(0, anchor.horizontalRatio * root.scrollWidth - root.clientWidth / 2);
  }
}

function pointToPdf(pageIndex: number, event: MouseEvent): { x: number; y: number } | null {
  const page = props.sourceMap?.pages.find((p) => p.pageIndex === pageIndex);
  const pageEl = pageEls.get(pageIndex);
  if (!page || !pageEl) return null;
  const rect = pageEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return overlayPointToPdf(page, {
    x: ((event.clientX - rect.left) / rect.width) * 100,
    y: ((event.clientY - rect.top) / rect.height) * 100,
  });
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

function highlightContains(highlight: ProjectedHighlight, pageIndex: number, point: { x: number; y: number }): boolean {
  return highlight.rects.some((rect) => rect.pageIndex === pageIndex && regionContains({
    region_id: highlight.mem_id,
    pageIndex,
    bbox: rect.bbox,
  }, point));
}

function hitUserHighlight(pageIndex: number, event: MouseEvent): ProjectedHighlight | null {
  const point = pointToPdf(pageIndex, event);
  if (!point) return null;
  return [...props.annotationProjection.highlights]
    .reverse()
    .find((highlight) => highlightContains(highlight, pageIndex, point)) ?? null;
}

function eventAnchor(event: MouseEvent): SurfaceAnchor {
  return { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY };
}

function elementAnchor(element: Element): SurfaceAnchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

function closeAnnotationSurface() {
  annotationSurface.value = null;
}

function toggleNoteMarkers() {
  noteMarkersVisible.value = !noteMarkersVisible.value;
  if (!noteMarkersVisible.value && annotationSurface.value?.kind === "notes") {
    closeAnnotationSurface();
  }
}

function openNoteSurface(marker: ProjectedNoteMarker, event: MouseEvent) {
  annotationSurface.value = {
    kind: "notes",
    terminalKey: marker.terminal_key,
    anchor: elementAnchor(event.currentTarget as Element),
  };
}

function openHighlightSurface(highlight: ProjectedHighlight, event: MouseEvent) {
  annotationSurface.value = {
    kind: "highlight",
    memId: highlight.mem_id,
    anchor: eventAnchor(event),
  };
}

function onPageClick(pageIndex: number, event: MouseEvent) {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  emit("selection-cancel");
  closeAnnotationSurface();
  const highlight = hitUserHighlight(pageIndex, event);
  if (highlight) {
    openHighlightSurface(highlight, event);
    return;
  }
  const entry = hitEntry(pageIndex, event);
  if (entry) emit("goto", entry.lid);
}

function highlightsForPage(pageIndex: number) {
  return props.annotationProjection.highlights.flatMap((highlight) =>
    highlight.rects
      .filter((rect) => rect.pageIndex === pageIndex)
      .map((rect, rectIndex) => ({ highlight, rect, rectIndex })));
}

function noteMarkersForPage(page: PdfSourceMap["pages"][number]): PdfNoteMarkerLayout[] {
  if (!noteMarkersVisible.value) return [];
  return layoutNoteMarkers(
    props.annotationProjection.note_markers.filter((marker) => marker.anchor_rect.pageIndex === page.pageIndex),
    page,
  );
}

function projectedRectStyle(page: PdfSourceMap["pages"][number], bbox: [number, number, number, number]) {
  const rect = pdfRectToOverlay(page, bbox);
  return {
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}

function markerStyle(marker: PdfNoteMarkerLayout) {
  return {
    left: `${marker.left}%`,
    top: `${marker.top}%`,
    "--marker-shift-y": `${marker.shift_y}px`,
  };
}

function emitNoteReselect(note: MemoryRecord) {
  emit("reselect-note", note);
  closeAnnotationSurface();
}

function emitHighlightReselect(highlight: MemoryRecord) {
  emit("reselect-highlight", highlight);
  closeAnnotationSurface();
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

async function resetRenderedPages() {
  const pageTasks = [...pageRenderTasks.values()];
  pageRenderTasks.clear();
  for (const task of pageTasks) task.cancel();
  await Promise.allSettled(pageTasks.map((task) => task.promise));
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
  await resetRenderedPages();
  if (token !== renderToken) return;
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
  return el.clientWidth / pdfPageVisualSize(page).width;
}

async function renderPage(pageInfo: PdfSourceMap["pages"][number], token: number) {
  if (!pdfDoc.value) return;
  const state = renderStates.value[pageInfo.pageIndex];
  if (state?.rendered || state?.rendering) return;
  const canvas = canvasEls.get(pageInfo.pageIndex);
  const textLayer = textLayerEls.get(pageInfo.pageIndex);
  if (!canvas || !textLayer) return;
  setRenderState(pageInfo.pageIndex, { rendering: true, error: null });
  let renderTask: PdfRenderTask | null = null;
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
    renderTask = page.render({ canvas, canvasContext: ctx, viewport });
    pageRenderTasks.set(pageInfo.pageIndex, renderTask);
    await renderTask.promise;
    if (token !== renderToken) return;
    await renderTextLayer(pageInfo.pageIndex, page, viewport, textLayer);
    setRenderState(pageInfo.pageIndex, { rendered: true, rendering: false, error: null });
  } catch (e) {
    if (token !== renderToken || (e instanceof Error && e.name === "RenderingCancelledException")) return;
    setRenderState(pageInfo.pageIndex, {
      rendering: false,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (renderTask && pageRenderTasks.get(pageInfo.pageIndex) === renderTask) {
      pageRenderTasks.delete(pageInfo.pageIndex);
    }
  }
}

async function setZoom(next: number) {
  const clamped = Math.max(PDF_ZOOM_MIN, Math.min(PDF_ZOOM_MAX, Number(next.toFixed(2))));
  if (clamped === zoom.value || pdfLoading.value) return;
  const anchor = captureZoomAnchor();
  closeAnnotationSurface();
  emit("selection-cancel");
  zoom.value = clamped;
  renderToken += 1;
  const token = renderToken;
  await resetRenderedPages();
  if (token !== renderToken) return;
  await nextTick();
  restoreZoomAnchor(anchor);
  observePages();
  await renderVisiblePages();
  if (token === renderToken) scheduleViewportChange();
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
  const region = activeRegion.value;
  if (!region) return;
  const pageIndex = region.pageIndex;
  const target = pageList.value?.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`);
  target?.scrollIntoView({ block: "center" });
  const page = props.sourceMap?.pages.find((p) => p.pageIndex === pageIndex);
  const root = pageList.value;
  if (page && root && target) {
    const rootRect = root.getBoundingClientRect();
    const pageRect = target.getBoundingClientRect();
    if (rootRect.height > 0 && pageRect.height > 0) {
      const overlay = pdfRectToOverlay(page, region.bbox);
      const targetY = pageRect.top + ((overlay.top + overlay.height / 2) / 100) * pageRect.height;
      const probeOffset = Math.min(
        Math.max(rootRect.height * 0.28, 96),
        Math.max(rootRect.height - 24, 0),
      );
      root.scrollTop = Math.max(0, root.scrollTop + targetY - (rootRect.top + probeOffset));
    }
  }
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
  const corners = [
    overlayPointToPdf(page, {
      x: ((left - pageRect.left) / pageRect.width) * 100,
      y: ((top - pageRect.top) / pageRect.height) * 100,
    }),
    overlayPointToPdf(page, {
      x: ((right - pageRect.left) / pageRect.width) * 100,
      y: ((top - pageRect.top) / pageRect.height) * 100,
    }),
    overlayPointToPdf(page, {
      x: ((left - pageRect.left) / pageRect.width) * 100,
      y: ((bottom - pageRect.top) / pageRect.height) * 100,
    }),
    overlayPointToPdf(page, {
      x: ((right - pageRect.left) / pageRect.width) * 100,
      y: ((bottom - pageRect.top) / pageRect.height) * 100,
    }),
  ];
  const x1 = Math.min(...corners.map((corner) => corner.x));
  const x2 = Math.max(...corners.map((corner) => corner.x));
  const y1 = Math.min(...corners.map((corner) => corner.y));
  const y2 = Math.max(...corners.map((corner) => corner.y));
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
  if (event.key !== "Escape") return;
  closeAnnotationSurface();
  emit("selection-cancel");
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

watch(
  () => props.annotationProjection,
  () => {
    if (annotationSurface.value?.kind === "notes" && !activeNoteMarker.value) closeAnnotationSurface();
    if (annotationSurface.value?.kind === "highlight" && !activeHighlight.value) closeAnnotationSurface();
  },
);

window.addEventListener("resize", scheduleViewportChange);
window.addEventListener("keydown", onSelectionKeydown);

onBeforeUnmount(() => {
  renderToken += 1;
  if (viewportFrame !== null) window.cancelAnimationFrame(viewportFrame);
  window.removeEventListener("resize", scheduleViewportChange);
  window.removeEventListener("keydown", onSelectionKeydown);
  emit("selection-cancel");
  observer?.disconnect();
  for (const task of pageRenderTasks.values()) task.cancel();
  pageRenderTasks.clear();
  for (const task of textLayerTasks.values()) task.cancel();
  textLayerTasks.clear();
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
      <div class="pdf-reader-head-actions">
        <span v-if="pdfLoading">正在加载 PDF</span>
        <span v-else-if="pdfError" class="pdf-error">{{ pdfError }}</span>
        <span v-else-if="props.annotationError" class="pdf-annotation-error" :title="props.annotationError">
          标注定位暂不可用
        </span>
        <div class="pdf-reader-tools" role="group" aria-label="PDF 工具">
          <button
            type="button"
            class="pdf-note-visibility-toggle"
            :class="{ active: noteMarkersVisible }"
            :title="noteMarkersVisible ? '隐藏笔记标记' : '显示笔记标记'"
            :aria-label="noteMarkersVisible ? '隐藏笔记标记' : '显示笔记标记'"
            :aria-pressed="noteMarkersVisible"
            @click="toggleNoteMarkers"
          >
            <Eye v-if="noteMarkersVisible" :size="15" aria-hidden="true" />
            <EyeOff v-else :size="15" aria-hidden="true" />
          </button>
          <button
            type="button"
            title="缩小"
            aria-label="缩小 PDF"
            :disabled="pdfLoading || zoom <= PDF_ZOOM_MIN"
            @click="setZoom(zoom - PDF_ZOOM_STEP)"
          >
            <Minus :size="15" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="pdf-zoom-fit"
            title="适合栏宽"
            aria-label="适合栏宽"
            :disabled="pdfLoading"
            @click="setZoom(1)"
          >
            <Scan :size="15" aria-hidden="true" />
            <span>{{ zoomText }}</span>
          </button>
          <button
            type="button"
            title="放大"
            aria-label="放大 PDF"
            :disabled="pdfLoading || zoom >= PDF_ZOOM_MAX"
            @click="setZoom(zoom + PDF_ZOOM_STEP)"
          >
            <Plus :size="15" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>

    <div
      ref="pageList"
      class="pdf-page-list"
      :class="{ 'is-zoomed': zoom > 1 }"
      @scroll.passive="onViewportScroll"
      @wheel.passive="emit('viewport-interaction')"
      @pointerdown="emit('viewport-interaction')"
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
        <div class="pdf-user-annotation-layer">
          <span
            v-for="item in highlightsForPage(page.pageIndex)"
            :key="`${item.highlight.mem_id}:${item.rectIndex}`"
            class="pdf-user-highlight"
            :data-mem-id="item.highlight.mem_id"
            :style="projectedRectStyle(page, item.rect.bbox)"
          ></span>
          <button
            v-for="marker in noteMarkersForPage(page)"
            :key="marker.terminal_key"
            class="pdf-note-marker"
            :class="[`side-${marker.side}`, `direction-${marker.direction}`]"
            :style="markerStyle(marker)"
            :aria-label="`打开 ${marker.notes.length} 条 PDF 笔记`"
            :title="`${marker.notes.length} 条笔记`"
            @click.stop="openNoteSurface(marker, $event)"
          >
            <MessageSquareText :size="14" aria-hidden="true" />
            <span v-if="marker.notes.length > 1">{{ marker.notes.length }}</span>
          </button>
        </div>
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

    <Teleport to="body">
      <section
        v-if="annotationSurface && (activeNoteMarker || activeHighlight)"
        class="pdf-annotation-surface"
        :data-surface-kind="annotationSurface.kind"
        :style="annotationSurfaceStyle"
        role="dialog"
        aria-modal="false"
        aria-label="PDF 用户标注"
        @click.stop
      >
        <header class="pdf-annotation-surface-head">
          <strong>{{ annotationSurface.kind === "notes" ? `${activeNoteMarker?.notes.length ?? 0} 条笔记` : "高亮" }}</strong>
          <button title="关闭" aria-label="关闭" @click="closeAnnotationSurface">
            <X :size="16" />
          </button>
        </header>

        <div v-if="activeNoteMarker" class="pdf-annotation-note-list">
          <div v-for="note in activeNoteMarker.notes" :key="note.mem_id" class="pdf-annotation-note-item">
            <NoteCard
              :note="note"
              :render-markdown="props.renderMarkdown"
              @focus-source="emit('focus-source', $event)"
              @edit="emit('edit-note', $event)"
              @delete="emit('delete-note', $event)"
            />
            <button
              class="pdf-annotation-reselect"
              title="重新选择位置"
              @click="emitNoteReselect(note)"
            >
              <ScanText :size="15" />
              重新选择位置
            </button>
          </div>
        </div>

        <div v-else-if="activeHighlight" class="pdf-highlight-surface">
          <p>{{ activeHighlight.record.content }}</p>
          <div class="pdf-highlight-actions">
            <button title="重新选择高亮" @click="emitHighlightReselect(activeHighlight.record)">
              <ScanText :size="15" />
              重新选择
            </button>
            <button class="danger" title="删除高亮" @click="emit('delete-highlight', activeHighlight.record)">
              <Trash2 :size="15" />
              删除
            </button>
          </div>
        </div>
      </section>
    </Teleport>
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
  flex-wrap: wrap;
  gap: 1rem;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--hairline-soft);
  background: var(--surface-soft);
}
.pdf-reader-head > div:first-child {
  flex: 1 1 10rem;
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
.pdf-reader-head .pdf-annotation-error {
  color: #8a5a14;
}
.pdf-reader-head-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.55rem;
  margin-left: auto;
}
.pdf-reader-tools {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.2rem;
}
.pdf-reader-tools button {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.22rem;
  box-sizing: border-box;
  border: 1px solid var(--hairline-soft);
  border-radius: 6px;
  background: var(--surface);
  color: var(--slate);
  padding: 0;
}
.pdf-reader-tools button:hover:not(:disabled) {
  border-color: var(--reader-coral);
  color: var(--ink);
}
.pdf-reader-tools button.active {
  border-color: rgba(182, 83, 59, 0.45);
  background: #fffaf5;
  color: var(--reader-coral);
}
.pdf-reader-tools button:disabled {
  cursor: default;
  opacity: 0.42;
}
.pdf-reader-tools .pdf-zoom-fit {
  width: 66px;
  padding: 0 0.38rem;
}
.pdf-reader-tools .pdf-zoom-fit span {
  color: inherit;
  font-size: 0.68rem;
  white-space: nowrap;
}
.pdf-page-list {
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-auto-rows: max-content;
  justify-items: center;
  gap: 1.1rem;
  align-content: start;
  padding: 1.1rem;
}
.pdf-page-list.is-zoomed {
  justify-items: start;
}
.pdf-page-shell {
  position: relative;
  width: min(var(--pdf-page-width, 100%), var(--pdf-page-max-width, 56rem));
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
.pdf-user-annotation-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  pointer-events: none;
}
.pdf-user-highlight {
  position: absolute;
  box-sizing: border-box;
  background: rgba(246, 204, 74, 0.34);
  border: 0;
  border-radius: 2px;
  pointer-events: none;
}
.pdf-note-marker {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 28px;
  height: 28px;
  padding: 0 5px;
  border: 1px solid rgba(182, 83, 59, 0.38);
  border-radius: 7px;
  background: #fffaf5;
  box-shadow: 0 2px 8px rgba(42, 36, 31, 0.18);
  color: var(--reader-coral);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  pointer-events: auto;
}
.pdf-note-marker.side-right {
  transform: translate(4px, calc(-50% + var(--marker-shift-y)));
}
.pdf-note-marker.side-left {
  transform: translate(calc(-100% - 4px), calc(-50% + var(--marker-shift-y)));
}
.pdf-note-marker:hover,
.pdf-note-marker:focus-visible {
  border-color: var(--reader-coral);
  background: #fff;
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
.pdf-annotation-surface {
  position: fixed;
  z-index: 120;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 0.7rem;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 34px rgba(27, 31, 35, 0.22);
  color: var(--ink);
}
.pdf-annotation-surface-head {
  position: sticky;
  top: -0.7rem;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  margin: -0.7rem -0.7rem 0.65rem;
  padding: 0.45rem 0.55rem 0.4rem 0.7rem;
  border-bottom: 1px solid var(--hairline-soft);
  background: #fff;
}
.pdf-annotation-surface-head strong {
  font-size: 0.82rem;
}
.pdf-annotation-surface-head button {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
}
.pdf-annotation-note-list,
.pdf-annotation-note-item {
  display: grid;
  gap: 0.45rem;
}
.pdf-annotation-note-list {
  gap: 0.75rem;
}
.pdf-annotation-note-item + .pdf-annotation-note-item {
  padding-top: 0.75rem;
  border-top: 1px solid var(--hairline-soft);
}
.pdf-annotation-note-item :deep(.note-card) {
  margin: 0;
}
.pdf-annotation-reselect,
.pdf-highlight-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  min-height: 32px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: #fff;
  color: var(--muted);
  font-size: 0.76rem;
}
.pdf-annotation-reselect {
  justify-self: end;
}
.pdf-highlight-surface p {
  margin: 0;
  color: var(--ink);
  font-size: 0.86rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.pdf-highlight-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
  margin-top: 0.75rem;
}
.pdf-highlight-actions button.danger {
  color: var(--brand-error);
}

@media (max-width: 900px) {
  .pdf-page-list {
    padding: 0.65rem;
  }
}
@media (max-width: 700px) {
  .pdf-annotation-surface {
    inset: auto 0 0 !important;
    width: 100% !important;
    max-height: min(68vh, 34rem) !important;
    padding: 0.8rem 0.8rem calc(0.8rem + env(safe-area-inset-bottom));
    border-width: 1px 0 0;
    border-radius: 8px 8px 0 0;
  }
  .pdf-annotation-surface-head {
    top: -0.8rem;
    margin: -0.8rem -0.8rem 0.7rem;
  }
}
</style>
