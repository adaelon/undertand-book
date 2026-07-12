<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { OutlineItem } from "../App.vue";
import type {
  PaperMinimapBase,
  PaperMinimapLensProjection,
  PaperMinimapLocalization,
  ReaderPaperMinimapState,
} from "../api";
import PaperMinimap from "./PaperMinimap.vue";

const props = defineProps<{
  outlineItems: OutlineItem[];
  progressPct: number;
  anchorLid: string | null;
  selectedLid: string | null;
  leafCount: number;
  debugOpen: boolean;
  gotoInput: string;
  searchQuery: string;
  paperEnabled?: boolean;
  paperLoading?: boolean;
  paperError?: string | null;
  paperMinimapBase?: PaperMinimapBase | null;
  paperMinimapState?: ReaderPaperMinimapState | null;
  paperMinimapLens?: PaperMinimapLensProjection | null;
  paperMinimapLocalization?: PaperMinimapLocalization | null;
  paperMinimapEffectReason?: string | null;
  paperMinimapUndoAvailable?: boolean;
  paperMinimapActionBusy?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:gotoInput", value: string): void;
  (e: "update:searchQuery", value: string): void;
  (e: "goto", lid: string): void;
  (e: "paper-minimap-toggle"): void;
  (e: "paper-minimap-mode", mode: ReaderPaperMinimapState["mode"]): void;
  (e: "paper-minimap-layer", layer: string, visible: boolean): void;
  (e: "paper-minimap-pin", landmarkId: string, pinned: boolean): void;
  (e: "paper-minimap-undo"): void;
}>();

const outlineList = ref<HTMLElement | null>(null);
const normalizedQuery = computed(() => props.searchQuery.trim().toLowerCase());
const filteredOutline = computed(() => {
  const q = normalizedQuery.value;
  if (!q) return props.outlineItems;
  return props.outlineItems.filter((item) => {
    return item.title.toLowerCase().includes(q) || item.lid.toLowerCase().includes(q);
  });
});
const activeOutlineLid = computed(() => {
  const anchor = props.anchorLid;
  if (!anchor) return null;
  return props.outlineItems
    .filter((item) => anchor === item.lid || anchor.startsWith(`${item.lid}.`))
    .sort((a, b) => b.lid.length - a.lid.length)[0]?.lid ?? null;
});
const nodeKindLabels: Record<string, string> = {
  chapter: "章",
  section: "节",
  paragraph: "段落",
  formula: "公式",
  image: "图片",
  table: "表格",
  code: "代码",
};

function outlineKindLabel(kind: string): string {
  return nodeKindLabels[kind] ?? kind;
}

async function scrollActiveOutlineIntoView() {
  await nextTick();
  const active = outlineList.value?.querySelector<HTMLElement>(".outline-item.active");
  active?.scrollIntoView({ block: "nearest" });
}

function gotoOutline(lid: string) {
  emit("goto", lid);
}

function forwardPaperLayer(layer: string, visible: boolean) {
  emit("paper-minimap-layer", layer, visible);
}

function forwardPaperPin(landmarkId: string, pinned: boolean) {
  emit("paper-minimap-pin", landmarkId, pinned);
}

onMounted(() => {
  void scrollActiveOutlineIntoView();
});
watch(activeOutlineLid, () => {
  void scrollActiveOutlineIntoView();
});
</script>

<template>
  <aside class="left-rail">
    <PaperMinimap
      v-if="props.paperEnabled"
      :base="props.paperMinimapBase ?? null"
      :state="props.paperMinimapState ?? null"
      :lens="props.paperMinimapLens ?? null"
      :localization="props.paperMinimapLocalization ?? null"
      :loading="props.paperLoading"
      :error="props.paperError"
      :effect-reason="props.paperMinimapEffectReason"
      :undo-available="props.paperMinimapUndoAvailable"
      :action-busy="props.paperMinimapActionBusy"
      @toggle="emit('paper-minimap-toggle')"
      @goto="gotoOutline"
      @mode-change="emit('paper-minimap-mode', $event)"
      @layer-toggle="forwardPaperLayer"
      @pin-toggle="forwardPaperPin"
      @undo="emit('paper-minimap-undo')"
    />

    <div class="rail-section">
      <label class="rail-label" for="outline-search">搜索</label>
      <input
        id="outline-search"
        class="search-pill outline-search"
        :value="props.searchQuery"
        placeholder="搜索目录"
        @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="rail-section outline-section">
      <div class="rail-heading">目录</div>
      <nav ref="outlineList" class="outline-list" aria-label="书籍目录">
        <button
          v-for="item in filteredOutline"
          :key="item.lid"
          class="outline-item"
          :class="{ active: item.lid === activeOutlineLid }"
          :style="{ paddingLeft: `${0.45 + item.depth * 0.75}rem` }"
          :title="item.title"
          @click="gotoOutline(item.lid)"
        >
          <span class="outline-kind">{{ outlineKindLabel(item.kind) }}</span>
          <span class="outline-title">{{ item.title }}</span>
        </button>
      </nav>
      <p v-if="filteredOutline.length === 0" class="rail-muted">没有匹配的目录项。</p>
    </div>

    <div class="rail-section rail-position">
      <div class="rail-heading">位置</div>
      <div class="position-row"><span>进度</span><strong>{{ props.progressPct }}%</strong></div>
      <div class="position-row"><span>叶子数</span><strong>{{ props.leafCount }}</strong></div>
      <div class="progress-track"><span :style="{ width: props.progressPct + '%' }"></span></div>
    </div>

    <details v-if="props.debugOpen" class="debug-panel" open>
      <summary>调试坐标</summary>
      <p>锚点: <code>{{ props.anchorLid || "-" }}</code></p>
      <p>选中: <code>{{ props.selectedLid || "-" }}</code></p>
      <div class="debug-goto">
        <input
          :value="props.gotoInput"
          placeholder="输入 LID"
          @input="emit('update:gotoInput', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('goto', props.gotoInput)"
        />
        <button @click="emit('goto', props.gotoInput)">跳转</button>
      </div>
    </details>
  </aside>
</template>

