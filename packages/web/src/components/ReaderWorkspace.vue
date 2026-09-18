<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  resolveWorkspace,
  type DisplayPreference,
  type WorkspaceLogicalState,
  type WorkspaceProjection,
  type WorkspaceViewport,
} from "../workspace-layout";
import { useViewportEnvironment } from "../useViewportEnvironment";
import type { ReaderSurface } from "../reader-surface";

export type WorkspaceAuxTab = "agent" | "artifacts" | "profile" | "trace" | "formula" | "notes";

const props = withDefaults(defineProps<{
  logical: WorkspaceLogicalState;
  preference?: DisplayPreference;
  compareIntent?: boolean;
  selectionActive?: boolean;
  expanded?: boolean;
  leftCollapsed?: boolean;
  returnAvailable?: boolean;
  enabled?: boolean;
  environment?: WorkspaceViewport | null;
  readerSurface?: ReaderSurface;
  pdfSurfaceAvailable?: boolean;
  globalActionsOpen?: boolean;
}>(), {
  preference: "auto",
  compareIntent: false,
  selectionActive: false,
  expanded: false,
  leftCollapsed: false,
  returnAvailable: false,
  enabled: true,
  environment: null,
  readerSurface: "markdown",
  pdfSurfaceAvailable: false,
  globalActionsOpen: false,
});

const emit = defineEmits<{
  (event: "tab-request", tab: WorkspaceAuxTab): void;
  (event: "projection-change", projection: WorkspaceProjection): void;
  (event: "return"): void;
  (event: "reader-surface-request", surface: ReaderSurface): void;
  (event: "global-actions-request"): void;
}>();

const root = ref<HTMLElement | null>(null);
const viewport = useViewportEnvironment(root);
const foreground = ref<"reader" | "assistant">("reader");
const preference = ref<DisplayPreference>(props.preference);
const outlineOpen = ref(false);
const lastHandledFocusKey = ref<string | null>(null);

watch(() => props.preference, (next) => { preference.value = next; });

const projectionEnvironment = computed<WorkspaceViewport>(() => {
  const current = props.environment ?? viewport.environment.value;
  if (props.enabled) return current;
  return {
    ...current,
    containerWidth: Math.max(current.containerWidth, 1024),
    containerHeight: Math.max(current.containerHeight, 420),
    visualWidth: Math.max(current.visualWidth, 1024),
    visualHeight: Math.max(current.visualHeight, 420),
  };
});

const projection = computed(() => resolveWorkspace(
  props.logical,
  projectionEnvironment.value,
  {
    foreground: foreground.value,
    compareIntent: props.compareIntent || preference.value === "compare",
    inputFocused: viewport.inputFocused.value,
    composing: viewport.composing.value,
    selectionActive: props.selectionActive,
    expanded: props.expanded,
    lastHandledFocusKey: lastHandledFocusKey.value,
  },
  preference.value,
));

watch(projection, (next) => {
  foreground.value = next.foreground;
  if (next.appliedFocusKey) lastHandledFocusKey.value = next.appliedFocusKey;
  emit("projection-change", next);
}, { immediate: true });

function showReader() {
  foreground.value = "reader";
  outlineOpen.value = false;
}

function showAssistant(tab: WorkspaceAuxTab = "agent") {
  foreground.value = "assistant";
  outlineOpen.value = false;
  emit("tab-request", tab);
}

function toggleOutline() {
  outlineOpen.value = !outlineOpen.value;
}

function toggleCompare() {
  preference.value = preference.value === "compare" ? "auto" : "compare";
  outlineOpen.value = false;
}

defineExpose({ showReader, showAssistant, toggleOutline });
</script>

<template>
  <section
    ref="root"
    class="workspace-shell"
    :class="{ 'outline-open': outlineOpen }"
    :data-mode="projection.mode"
    :data-foreground="projection.foreground"
    :data-navigation="projection.navigation"
    :data-input-priority="projection.inputPriority ? 'true' : 'false'"
    :data-mobile-workspace="props.enabled ? 'true' : 'false'"
  >
    <header v-if="projection.navigation !== 'desktop'" class="workspace-mobile-top">
      <button type="button" aria-controls="reader-outline" :aria-expanded="outlineOpen" @click="toggleOutline">目录</button>
      <span v-if="projection.deferredFocus" role="status">当前编辑结束后显示请求区域</span>
      <span v-else-if="projection.unavailableFocus" role="status">请求区域尚未挂载</span>
      <button v-if="props.returnAvailable" type="button" class="workspace-return" @click="emit('return')">返回回答</button>
      <button type="button" :aria-pressed="preference === 'compare'" @click="toggleCompare">对照</button>
    </header>

    <button
      v-if="props.returnAvailable && projection.navigation === 'desktop'"
      type="button"
      class="workspace-return workspace-return-desktop"
      @click="emit('return')"
    >返回回答</button>

    <div
      v-if="props.pdfSurfaceAvailable"
      class="workspace-reader-surface-switch"
      role="group"
      aria-label="阅读表面"
    >
      <button
        type="button"
        :aria-pressed="props.readerSurface === 'markdown'"
        @click="emit('reader-surface-request', 'markdown')"
      >Markdown</button>
      <button
        type="button"
        :aria-pressed="props.readerSurface === 'pdf'"
        @click="emit('reader-surface-request', 'pdf')"
      >PDF</button>
    </div>

    <div class="workspace-grid" :class="{ 'left-collapsed': props.leftCollapsed }">
      <slot />
    </div>

    <button
      v-if="outlineOpen && projection.navigation !== 'desktop'"
      type="button"
      class="workspace-outline-backdrop"
      aria-label="关闭目录"
      @click="outlineOpen = false"
    ></button>

    <nav v-if="projection.navigation !== 'desktop'" class="workspace-mobile-nav" aria-label="阅读工作区">
      <button type="button" :class="{ active: projection.foreground === 'reader' }" @click="showReader">阅读</button>
      <button type="button" :class="{ active: projection.foreground === 'assistant' }" @click="showAssistant('agent')">问答</button>
      <button type="button" @click="showAssistant('notes')">笔记</button>
      <button type="button" @click="showAssistant('artifacts')">更多</button>
      <button
        type="button"
        :class="{ active: props.globalActionsOpen }"
        aria-haspopup="menu"
        :aria-expanded="props.globalActionsOpen"
        @click="emit('global-actions-request')"
      >菜单</button>
      <button v-if="projection.navigation === 'compact'" type="button" :aria-pressed="preference === 'compare'" @click="toggleCompare">对照</button>
      <button v-if="projection.navigation === 'compact' && props.returnAvailable" type="button" class="workspace-return" @click="emit('return')">返回回答</button>
    </nav>
  </section>
</template>
