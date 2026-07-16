<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Copy, LoaderCircle, RotateCcw, Settings, X } from "@lucide/vue";
import type { PdfSelectionTranslationState } from "../pdf-selection-translation";

const props = defineProps<{
  state: PdfSelectionTranslationState;
  anchorRect: { left: number; top: number; right: number; bottom: number };
  renderMarkdown: (source: string) => string;
  showSettings: boolean;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "retry"): void;
  (event: "settings"): void;
  (event: "copy", markdown: string): void;
}>();

const surface = ref<HTMLElement | null>(null);
const surfaceStyle = ref<Record<string, string>>({});
const mobile = ref(false);
let observer: ResizeObserver | null = null;

const renderedTranslation = computed(() =>
  props.state.translation_markdown
    ? props.renderMarkdown(props.state.translation_markdown)
    : "",
);

async function positionSurface() {
  await nextTick();
  mobile.value = window.innerWidth <= 640;
  if (mobile.value) {
    surfaceStyle.value = {};
    return;
  }
  const element = surface.value;
  const width = element?.offsetWidth || Math.min(420, window.innerWidth - 24);
  const height = element?.offsetHeight || 260;
  const gap = 10;
  const edge = 12;
  const center = (props.anchorRect.left + props.anchorRect.right) / 2;
  const left = Math.min(
    Math.max(edge, center - width / 2),
    Math.max(edge, window.innerWidth - width - edge),
  );
  const below = props.anchorRect.bottom + gap;
  const top = below + height <= window.innerHeight - edge
    ? below
    : Math.max(edge, props.anchorRect.top - gap - height);
  surfaceStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
  };
}

function copyTranslation() {
  if (props.state.translation_markdown) emit("copy", props.state.translation_markdown);
}

watch(
  () => [
    props.state.phase,
    props.state.translation_markdown,
    props.state.error?.message,
    props.anchorRect.left,
    props.anchorRect.top,
    props.anchorRect.right,
    props.anchorRect.bottom,
  ],
  () => { void positionSurface(); },
);

onMounted(() => {
  window.addEventListener("resize", positionSurface);
  if (typeof ResizeObserver !== "undefined" && surface.value) {
    observer = new ResizeObserver(() => { void positionSurface(); });
    observer.observe(surface.value);
  }
  void positionSurface();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", positionSurface);
  observer?.disconnect();
});
</script>

<template>
  <section
    ref="surface"
    class="pdf-translation-surface"
    :class="{ 'is-mobile': mobile }"
    :style="surfaceStyle"
    role="dialog"
    aria-label="PDF 选区翻译"
    aria-live="polite"
  >
    <header class="pdf-translation-head">
      <strong>选区翻译</strong>
      <button
        class="pdf-translation-primary-icon"
        type="button"
        title="关闭翻译"
        aria-label="关闭翻译"
        @click="emit('close')"
      >
        <X :size="22" :stroke-width="2.2" aria-hidden="true" />
      </button>
    </header>

    <div v-if="state.phase === 'loading'" class="pdf-translation-state is-loading">
      <LoaderCircle class="pdf-translation-spinner" :size="20" aria-hidden="true" />
      <span>翻译中...</span>
    </div>

    <div v-else-if="state.phase === 'error'" class="pdf-translation-state is-error">
      <strong>翻译失败</strong>
      <p>{{ state.error?.message }}</p>
      <div class="pdf-translation-actions">
        <button type="button" title="重试翻译" aria-label="重试翻译" @click="emit('retry')">
          <RotateCcw :size="17" aria-hidden="true" />
        </button>
        <button
          v-if="showSettings"
          type="button"
          title="打开 Reader Provider 设置"
          aria-label="打开 Reader Provider 设置"
          @click="emit('settings')"
        >
          <Settings :size="17" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-else-if="state.phase === 'ready'" class="pdf-translation-ready">
      <div class="pdf-translation-markdown" v-html="renderedTranslation"></div>
      <footer class="pdf-translation-actions">
        <button
          class="pdf-translation-primary-icon"
          type="button"
          title="复制译文 Markdown"
          aria-label="复制译文 Markdown"
          @click="copyTranslation"
        >
          <Copy :size="22" :stroke-width="2.2" aria-hidden="true" />
        </button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.pdf-translation-surface {
  position: fixed;
  z-index: 86;
  width: min(420px, calc(100vw - 24px));
  max-height: min(520px, calc(100vh - 24px));
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 16px 42px rgba(29, 34, 39, 0.18);
  color: var(--ink);
}
.pdf-translation-head {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.45rem 0.55rem 0.45rem 0.8rem;
  border-bottom: 1px solid var(--hairline);
  background: #f7f8f6;
}
.pdf-translation-head strong {
  font-size: 0.86rem;
}
.pdf-translation-head button,
.pdf-translation-actions button {
  display: inline-flex;
  width: 34px;
  height: 34px;
  min-width: 34px;
  min-height: 34px;
  flex: 0 0 34px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
}
.pdf-translation-head button svg,
.pdf-translation-actions button svg {
  display: block;
  flex: 0 0 auto;
}
.pdf-translation-head .pdf-translation-primary-icon,
.pdf-translation-actions .pdf-translation-primary-icon {
  width: 40px;
  height: 40px;
  min-width: 40px;
  min-height: 40px;
  flex-basis: 40px;
  border-color: var(--hairline);
  background: #fff;
  color: #252b30;
}
.pdf-translation-head button:hover,
.pdf-translation-actions button:hover {
  border-color: var(--hairline);
  background: #edf1ec;
}
.pdf-translation-state {
  display: flex;
  min-height: 118px;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
  padding: 1rem;
  font-size: 0.86rem;
}
.pdf-translation-state.is-error {
  align-items: flex-start;
  flex-direction: column;
  gap: 0.45rem;
}
.pdf-translation-state.is-error p {
  margin: 0;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.pdf-translation-spinner {
  animation: pdf-translation-spin 0.9s linear infinite;
  color: var(--reader-coral);
}
.pdf-translation-ready {
  min-height: 92px;
  overflow-y: auto;
  max-height: min(470px, calc(100vh - 78px));
}
.pdf-translation-markdown {
  padding: 0.9rem 1rem 0.55rem;
  user-select: text;
  font-size: 0.9rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.pdf-translation-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.25rem;
  margin-left: auto;
  padding: 0.4rem 0.55rem 0.55rem;
}
.pdf-translation-state .pdf-translation-actions {
  margin-left: 0;
  padding: 0.2rem 0 0;
}
.pdf-translation-surface.is-mobile {
  top: auto !important;
  right: 0;
  bottom: 0;
  left: 0 !important;
  width: 100%;
  max-height: min(62vh, 560px);
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  border-radius: 8px 8px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
}
.pdf-translation-surface.is-mobile .pdf-translation-ready {
  max-height: calc(62vh - 44px);
}
@keyframes pdf-translation-spin {
  to { transform: rotate(360deg); }
}
@media (max-width: 640px) {
  .pdf-translation-surface {
    top: auto !important;
    right: 0;
    bottom: 0;
    left: 0 !important;
    width: 100%;
    max-height: min(62vh, 560px);
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 8px 8px 0 0;
  }
}
</style>
