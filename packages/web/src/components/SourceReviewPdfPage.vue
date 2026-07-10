<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { ExternalLink, Minus, Plus, Scan } from "@lucide/vue";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const props = defineProps<{
  pdfUrl: string;
  pageIndex?: number;
  pageLabel?: string;
}>();

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

const viewportEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const pdfDoc = shallowRef<PdfDocument | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const zoom = ref(1);
let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
let renderTask: ReturnType<PdfPage["render"]> | null = null;
let resizeObserver: ResizeObserver | null = null;
let fetchController: AbortController | null = null;
let renderRevision = 0;

const physicalPageNumber = computed(() => props.pageIndex === undefined ? null : props.pageIndex + 1);
const pageDescription = computed(() => {
  if (props.pageLabel && physicalPageNumber.value) return `PDF 页 ${props.pageLabel} · 文件第 ${physicalPageNumber.value} 页`;
  if (props.pageLabel) return `PDF 页 ${props.pageLabel}`;
  if (physicalPageNumber.value) return `文件第 ${physicalPageNumber.value} 页`;
  return "未定位 PDF 页";
});
const openUrl = computed(() => physicalPageNumber.value
  ? `${props.pdfUrl}#page=${physicalPageNumber.value}`
  : props.pdfUrl);
const zoomText = computed(() => `${Math.round(zoom.value * 100)}%`);

function setZoom(next: number) {
  zoom.value = Math.max(0.75, Math.min(2.5, Number(next.toFixed(2))));
}

function isCancelledRender(errorValue: unknown): boolean {
  return errorValue instanceof Error && errorValue.name === "RenderingCancelledException";
}

async function renderCurrentPage() {
  const document = pdfDoc.value;
  const canvas = canvasEl.value;
  const viewport = viewportEl.value;
  if (!document || !canvas || !viewport || props.pageIndex === undefined) return;
  const requestedPage = props.pageIndex + 1;
  if (requestedPage < 1 || requestedPage > document.numPages) {
    error.value = `PDF 中不存在文件第 ${requestedPage} 页。`;
    return;
  }

  const revision = ++renderRevision;
  renderTask?.cancel();
  loading.value = true;
  error.value = null;
  try {
    const page = await document.getPage(requestedPage);
    if (revision !== renderRevision) return;
    const natural = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(280, viewport.clientWidth - 24);
    const scale = (availableWidth / natural.width) * zoom.value;
    const pageViewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(pageViewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(pageViewport.height * dpr));
    canvas.style.width = `${pageViewport.width}px`;
    canvas.style.height = `${pageViewport.height}px`;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context unavailable");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderTask = page.render({ canvas, canvasContext: context, viewport: pageViewport });
    await renderTask.promise;
    if (revision === renderRevision) viewport.scrollTo({ top: 0, left: 0 });
  } catch (errorValue) {
    if (revision === renderRevision && !isCancelledRender(errorValue)) {
      error.value = errorValue instanceof Error ? errorValue.message : String(errorValue);
    }
  } finally {
    if (revision === renderRevision) loading.value = false;
  }
}

async function loadPdfDocument() {
  renderRevision += 1;
  renderTask?.cancel();
  renderTask = null;
  fetchController?.abort();
  fetchController = null;
  if (loadingTask) void loadingTask.destroy();
  if (pdfDoc.value) void (pdfDoc.value as unknown as { destroy?: () => Promise<void> }).destroy?.();
  pdfDoc.value = null;
  error.value = null;
  if (!props.pdfUrl) return;
  loading.value = true;
  try {
    fetchController = new AbortController();
    const response = await fetch(props.pdfUrl, { signal: fetchController.signal });
    if (!response.ok) throw new Error(`PDF 请求失败 (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    loadingTask = pdfjsLib.getDocument({ data: bytes });
    pdfDoc.value = await loadingTask.promise;
    await nextTick();
    await renderCurrentPage();
  } catch (errorValue) {
    error.value = errorValue instanceof Error ? errorValue.message : String(errorValue);
  } finally {
    loading.value = false;
  }
}

watch(() => props.pdfUrl, () => void loadPdfDocument(), { immediate: true });
watch(() => [props.pageIndex, zoom.value] as const, () => void renderCurrentPage());

onMounted(() => {
  if (typeof ResizeObserver === "undefined" || !viewportEl.value) return;
  resizeObserver = new ResizeObserver(() => void renderCurrentPage());
  resizeObserver.observe(viewportEl.value);
});

onBeforeUnmount(() => {
  renderRevision += 1;
  resizeObserver?.disconnect();
  fetchController?.abort();
  renderTask?.cancel();
  if (loadingTask) void loadingTask.destroy();
  if (pdfDoc.value) void (pdfDoc.value as unknown as { destroy?: () => Promise<void> }).destroy?.();
});
</script>

<template>
  <article class="pdf-review-pane">
    <header class="pdf-review-head">
      <div>
        <strong>原版 PDF</strong>
        <span>{{ pageDescription }}</span>
      </div>
      <div class="pdf-review-tools">
        <button type="button" title="缩小" aria-label="缩小 PDF" :disabled="zoom <= 0.75" @click="setZoom(zoom - 0.25)">
          <Minus :size="15" aria-hidden="true" />
        </button>
        <button type="button" title="适合栏宽" aria-label="适合栏宽" @click="setZoom(1)">
          <Scan :size="15" aria-hidden="true" />
          <span>{{ zoomText }}</span>
        </button>
        <button type="button" title="放大" aria-label="放大 PDF" :disabled="zoom >= 2.5" @click="setZoom(zoom + 0.25)">
          <Plus :size="15" aria-hidden="true" />
        </button>
        <a :href="openUrl" target="_blank" rel="noreferrer" title="在新窗口打开原版 PDF" aria-label="在新窗口打开原版 PDF">
          <ExternalLink :size="15" aria-hidden="true" />
        </a>
      </div>
    </header>
    <div ref="viewportEl" class="pdf-review-viewport">
      <div v-if="props.pageIndex === undefined" class="pdf-review-state">当前问题没有可定位的 PDF 页。</div>
      <div v-else-if="error" class="pdf-review-state error">{{ error }}</div>
      <div v-else class="pdf-review-sheet" :class="{ loading }">
        <canvas ref="canvasEl"></canvas>
        <span v-if="loading">正在载入 PDF 页面</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.pdf-review-pane {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--hairline-soft);
  background: #e9e8e5;
}
.pdf-review-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  border-bottom: 1px solid var(--hairline-soft);
  background: #fff;
  padding: 0.45rem 0.6rem;
}
.pdf-review-head > div:first-child {
  min-width: 0;
  display: grid;
  gap: 0.08rem;
}
.pdf-review-head strong {
  color: var(--ink);
  font-size: 0.78rem;
}
.pdf-review-head span {
  overflow: hidden;
  color: var(--steel);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-review-tools {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.2rem;
}
.pdf-review-tools button,
.pdf-review-tools a {
  min-width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.22rem;
  box-sizing: border-box;
  border: 1px solid var(--hairline-soft);
  border-radius: 6px;
  background: #fff;
  color: var(--slate);
  padding: 0 0.38rem;
  text-decoration: none;
}
.pdf-review-tools button:disabled {
  opacity: 0.42;
}
.pdf-review-tools button span {
  color: inherit;
  font-size: 0.65rem;
}
.pdf-review-viewport {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  display: grid;
  align-items: start;
  justify-items: center;
  padding: 0.75rem;
}
.pdf-review-sheet {
  position: relative;
  width: max-content;
  min-width: 1px;
  min-height: 1px;
  box-shadow: 0 2px 12px rgba(27, 29, 31, 0.13);
  background: #fff;
}
.pdf-review-sheet canvas {
  display: block;
  background: #fff;
}
.pdf-review-sheet > span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.78);
  color: var(--steel);
  font-size: 0.74rem;
}
.pdf-review-state {
  align-self: center;
  max-width: 22rem;
  color: var(--steel);
  font-size: 0.8rem;
  line-height: 1.5;
  text-align: center;
}
.pdf-review-state.error {
  color: var(--brand-error);
}
</style>
