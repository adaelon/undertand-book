<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowRight, Map as MapIcon, Maximize2, Minimize2, Pin, PinOff, Undo2 } from "@lucide/vue";
import type {
  PaperMinimapBase,
  PaperMinimapLensProjection,
  PaperMinimapLocalization,
  ReaderPaperMinimapState,
} from "../api";

type PaperMinimapMode = ReaderPaperMinimapState["mode"];
type PaperRegion = PaperMinimapBase["regions"][number];
type PaperLandmark = PaperMinimapBase["landmarks"][number];

const props = defineProps<{
  base: PaperMinimapBase | null;
  state: ReaderPaperMinimapState | null;
  lens?: PaperMinimapLensProjection | null;
  localization?: PaperMinimapLocalization | null;
  loading?: boolean;
  error?: string | null;
  effectReason?: string | null;
  undoAvailable?: boolean;
  actionBusy?: boolean;
}>();

const emit = defineEmits<{
  (event: "toggle"): void;
  (event: "goto", lid: string): void;
  (event: "mode-change", mode: PaperMinimapMode): void;
  (event: "layer-toggle", layer: string, visible: boolean): void;
  (event: "pin-toggle", landmarkId: string, pinned: boolean): void;
  (event: "undo"): void;
}>();

const expanded = computed(() => props.state?.presentation === "expanded");
const dragRatio = ref<number | null>(null);
let dragPointerId: number | null = null;
const regions = computed(() => props.base?.regions ?? []);
const landmarks = computed(() => props.base?.landmarks ?? []);
const landmarkById = computed(() => new Map(landmarks.value.map((landmark) => [landmark.landmark_id, landmark])));
const relationById = computed(() => new Map((props.base?.relations ?? []).map((relation) => [relation.relation_id, relation])));
const globalLandmarks = computed(() => (props.lens?.global_landmark_ids ?? [])
  .map((id) => landmarkById.value.get(id))
  .filter((landmark): landmark is NonNullable<typeof landmark> => !!landmark)
  .slice(0, 5));
const localBindings = computed(() => (props.lens?.slot_bindings ?? [])
  .map((binding) => ({ ...binding, landmark: landmarkById.value.get(binding.landmark_id) }))
  .filter((binding): binding is typeof binding & { landmark: NonNullable<typeof binding.landmark> } => !!binding.landmark)
  .slice(0, 4));
const lensRelations = computed(() => (props.lens?.relation_ids ?? [])
  .map((id) => relationById.value.get(id))
  .filter((relation): relation is NonNullable<typeof relation> => !!relation)
  .slice(0, 3));
const abstractCorrespondences = computed(() => (props.lens?.abstract_correspondences ?? [])
  .map((item) => ({
    ...item,
    abstractLandmark: landmarkById.value.get(item.abstract_landmark_id),
    bodyLandmark: landmarkById.value.get(item.body_landmark_id),
  }))
  .filter((item): item is typeof item & {
    abstractLandmark: NonNullable<typeof item.abstractLandmark>;
    bodyLandmark: NonNullable<typeof item.bodyLandmark>;
  } => !!item.abstractLandmark && !!item.bodyLandmark)
  .slice(0, 3));
const visibleLayers = computed(() => new Set(props.state?.session_overlay.visible_layers ?? []));
const activeLocalization = computed(() => (
  props.localization?.base_map_rev === props.base?.fingerprint ? props.localization : null
));
const pinnedLandmarks = computed(() => new Set([
  ...(props.state?.session_overlay.pinned_landmark_ids ?? []),
  ...(props.state?.saved_user_overlay.pinned_landmark_ids ?? []),
]));
const modeOptions: Array<{ id: PaperMinimapMode; label: string }> = [
  { id: "skim", label: "速览" },
  { id: "abstract", label: "摘要" },
  { id: "deep", label: "深读" },
];
const layerOptions = [
  { id: "regions", label: "章节区域" },
  { id: "landmarks", label: "重点位置" },
  { id: "arguments", label: "论证关系" },
  { id: "user", label: "我的标记" },
];
const pageBounds = computed(() => {
  const starts = regions.value.map((region) => region.page_span.start_page);
  const ends = regions.value.map((region) => region.page_span.end_page);
  const start = starts.length ? Math.min(...starts) : 0;
  const end = ends.length ? Math.max(...ends) : start;
  return { start, end, span: Math.max(1, end - start + 1) };
});

function topForPage(page: number): number {
  return ((page - pageBounds.value.start) / pageBounds.value.span) * 100;
}

function regionStyle(start: number, end: number) {
  return {
    top: `${topForPage(start)}%`,
    height: `${Math.max(3, ((end - start + 1) / pageBounds.value.span) * 100)}%`,
  };
}

const viewportTop = computed(() => {
  const ratio = dragRatio.value ?? props.state?.viewport_position.progress_ratio ?? 0;
  return `${Math.max(0, Math.min(1, ratio)) * 100}%`;
});

function ratioFromPointer(event: PointerEvent): number {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
}

function lidForRatio(ratio: number): string | null {
  const targetPage = pageBounds.value.start + ratio * pageBounds.value.span;
  const candidates = [
    ...regions.value.flatMap((region) => [
      { lid: region.lid_span.start_lid, page: region.page_span.start_page },
      { lid: region.lid_span.end_lid, page: region.page_span.end_page + 0.999999 },
    ]),
    ...landmarks.value.map((landmark) => ({ lid: landmark.anchor_lid, page: landmark.page_index + 0.5 })),
  ];
  return candidates
    .sort((left, right) => Math.abs(left.page - targetPage) - Math.abs(right.page - targetPage)
      || left.lid.localeCompare(right.lid))[0]?.lid ?? null;
}

function navigateToRatio(ratio: number) {
  const lid = lidForRatio(ratio);
  if (lid) emit("goto", lid);
}

function onTrackPointerDown(event: PointerEvent) {
  dragPointerId = event.pointerId;
  dragRatio.value = ratioFromPointer(event);
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function onTrackPointerMove(event: PointerEvent) {
  if (dragPointerId !== event.pointerId) return;
  dragRatio.value = ratioFromPointer(event);
}

function onTrackPointerUp(event: PointerEvent) {
  if (dragPointerId !== event.pointerId) return;
  const ratio = ratioFromPointer(event);
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  dragPointerId = null;
  dragRatio.value = null;
  navigateToRatio(ratio);
}

function onTrackKeydown(event: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = props.state?.viewport_position.progress_ratio ?? 0;
  const ratio = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? 1
      : Math.max(0, Math.min(1, current + (event.key === 'ArrowDown' ? 0.05 : -0.05)));
  navigateToRatio(ratio);
}

const statusText = computed(() => {
  if (props.loading) return "正在加载";
  if (props.error) return props.error;
  if (!props.base || props.base.status === "unavailable") return "不可用";
  return expanded.value ? "论文全局地图" : "论文地图";
});

function layerUnavailable(layer: string): boolean {
  return props.base?.layer_status[layer]?.status === "unavailable";
}

function layerReason(layer: string): string | undefined {
  return props.base?.layer_status[layer]?.reason ?? undefined;
}

function regionDisplayLabel(region: PaperRegion): string {
  const localized = activeLocalization.value?.region_labels[region.region_id]?.trim();
  if (localized) return localized;
  return {
    abstract: "摘要",
    introduction: "引言",
    related_work: "相关工作",
    method: "方法",
    results: "结果",
    discussion: "讨论",
    conclusion: "结论",
    references: "参考文献",
    unknown: "其他区域",
  }[region.kind] ?? "论文区域";
}

function landmarkDisplayLabel(landmark: PaperLandmark): string {
  const localized = activeLocalization.value?.landmark_labels[landmark.landmark_id]?.trim();
  if (localized) return localized;
  return {
    research_question: "研究问题",
    hypothesis: "研究假设",
    related_work: "相关工作",
    method: "关键方法",
    experiment: "实验设计",
    evidence: "关键证据",
    result: "主要结果",
    claim: "核心主张",
    contribution: "主要贡献",
    limitation: "研究局限",
    future_work: "后续工作",
    other: "重要位置",
  }[landmark.kind] ?? "重要位置";
}

function relationLandmarkLabel(landmarkId: string): string {
  const landmark = landmarkById.value.get(landmarkId);
  return landmark ? landmarkDisplayLabel(landmark) : landmarkId;
}

function slotLabel(slot: string): string {
  const labels: Record<string, string> = {
    background: "背景",
    research_gap: "研究空白",
    research_question: "研究问题",
    hypothesis: "假设",
    input: "输入",
    object: "对象",
    method_step: "方法步骤",
    method: "方法",
    output: "输出",
    assumption: "前提",
    experiment: "实验",
    evidence: "证据",
    result: "结果",
    claim: "主张",
    contribution: "贡献",
    interpretation: "解释",
    limitation: "局限",
    future_work: "后续工作",
  };
  return labels[slot] ?? slot.replaceAll("_", " ");
}

function relationLabel(relation: string): string {
  return {
    frames: "界定",
    addresses: "回应",
    tests: "检验",
    produces: "产生",
    supports: "支持",
    challenges: "质疑",
    limits: "限制",
    motivates: "推动",
    builds_on: "承接",
    contrasts: "对照",
  }[relation] ?? relation;
}
</script>

<template>
  <section class="paper-map-shell" :class="{ expanded }" :data-mode="props.state?.mode" aria-label="论文地图">
    <header class="paper-map-toolbar">
      <div class="paper-map-title">
        <MapIcon :size="15" aria-hidden="true" />
        <span>{{ statusText }}</span>
      </div>
      <button
        class="paper-map-toggle"
        type="button"
        :title="expanded ? '收起论文地图' : '展开论文地图'"
        :aria-label="expanded ? '收起论文地图' : '展开论文地图'"
        :aria-expanded="expanded"
        :disabled="!props.base || props.base.status === 'unavailable'"
        @click="emit('toggle')"
      >
        <Minimize2 v-if="expanded" :size="15" aria-hidden="true" />
        <Maximize2 v-else :size="15" aria-hidden="true" />
      </button>
    </header>

    <div v-if="props.base && props.base.status !== 'unavailable'" class="paper-map-body">
      <div
        class="paper-map-track"
        role="slider"
        tabindex="0"
        aria-label="论文全局位置"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round((dragRatio ?? props.state?.viewport_position.progress_ratio ?? 0) * 100)"
        @pointerdown="onTrackPointerDown"
        @pointermove="onTrackPointerMove"
        @pointerup="onTrackPointerUp"
        @pointercancel="dragPointerId = null; dragRatio = null"
        @keydown="onTrackKeydown"
      >
        <span
          v-for="region in visibleLayers.has('regions') ? regions : []"
          :key="region.region_id"
          class="paper-map-region"
          :class="`kind-${region.kind}`"
          :style="regionStyle(region.page_span.start_page, region.page_span.end_page)"
          :title="regionDisplayLabel(region)"
        ></span>
        <span
          v-for="landmark in visibleLayers.has('landmarks') ? landmarks : []"
          :key="landmark.landmark_id"
          class="paper-map-landmark"
          :style="{ top: `${topForPage(landmark.page_index)}%` }"
          :title="landmarkDisplayLabel(landmark)"
        ></span>
        <span class="paper-map-viewport" :style="{ top: viewportTop }" aria-label="当前阅读位置"></span>
      </div>

      <div v-if="expanded" class="paper-map-region-list">
        <button
          v-for="region in regions"
          :key="region.region_id"
          type="button"
          :class="{ active: props.state?.viewport_position.region_id === region.region_id }"
          @click="emit('goto', region.lid_span.start_lid)"
        >
          <span class="paper-map-region-swatch" :class="`kind-${region.kind}`"></span>
          <span class="paper-map-region-copy">
            <strong>{{ regionDisplayLabel(region) }}</strong>
            <small>{{ region.page_span.start_page + 1 }}-{{ region.page_span.end_page + 1 }}</small>
          </span>
        </button>
      </div>

      <div v-if="expanded" class="paper-map-expanded-controls">
        <div class="paper-map-modes" role="group" aria-label="论文地图模式">
          <button
            v-for="option in modeOptions"
            :key="option.id"
            type="button"
            :class="{ active: props.state?.mode === option.id }"
            :aria-pressed="props.state?.mode === option.id"
            :disabled="props.actionBusy"
            @click="emit('mode-change', option.id)"
          >
            {{ option.label }}
          </button>
        </div>

        <div class="paper-map-layers" aria-label="地图图层">
          <label
            v-for="layer in layerOptions"
            :key="layer.id"
            :title="layerReason(layer.id)"
          >
            <input
              type="checkbox"
              :checked="visibleLayers.has(layer.id)"
              :disabled="props.actionBusy || layerUnavailable(layer.id)"
              @change="emit('layer-toggle', layer.id, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ layer.label }}</span>
          </label>
        </div>

        <div v-if="visibleLayers.has('landmarks')" class="paper-map-lens">
          <div v-if="globalLandmarks.length" class="paper-map-chain" data-testid="global-chain">
            <div
              v-for="landmark in globalLandmarks"
              :key="landmark.landmark_id"
              class="paper-map-chain-row"
            >
              <button type="button" class="paper-map-landmark-link" @click="emit('goto', landmark.anchor_lid)">
                <span>{{ landmarkDisplayLabel(landmark) }}</span>
                <small>{{ landmark.anchor_lid }}</small>
              </button>
              <button
                class="paper-map-pin"
                type="button"
                :title="pinnedLandmarks.has(landmark.landmark_id) ? '取消固定' : '固定地标'"
                :aria-label="pinnedLandmarks.has(landmark.landmark_id) ? '取消固定' : '固定地标'"
                @click.stop="emit('pin-toggle', landmark.landmark_id, pinnedLandmarks.has(landmark.landmark_id))"
              >
                <PinOff v-if="pinnedLandmarks.has(landmark.landmark_id)" :size="13" aria-hidden="true" />
                <Pin v-else :size="13" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div v-if="localBindings.length" class="paper-map-local-chain" data-testid="local-chain">
            <button
              v-for="binding in localBindings"
              :key="`${binding.slot}:${binding.landmark_id}`"
              type="button"
              @click="emit('goto', binding.landmark.anchor_lid)"
            >
              <small>{{ slotLabel(binding.slot) }}</small>
              <strong>{{ landmarkDisplayLabel(binding.landmark) }}</strong>
            </button>
          </div>
          <p v-else-if="props.state?.mode !== 'skim'" class="paper-map-empty">当前章节没有可显示的论证关系</p>

          <div
            v-if="props.state?.mode === 'abstract' && abstractCorrespondences.length"
            class="paper-map-correspondences"
            data-testid="abstract-correspondences"
          >
            <button
              v-for="item in abstractCorrespondences"
              :key="`${item.abstract_landmark_id}:${item.body_landmark_id}`"
              type="button"
              @click="emit('goto', item.bodyLandmark.anchor_lid)"
            >
              <span>{{ landmarkDisplayLabel(item.abstractLandmark) }}</span>
              <ArrowRight :size="12" aria-hidden="true" />
              <span>{{ landmarkDisplayLabel(item.bodyLandmark) }}</span>
            </button>
          </div>
        </div>

        <div v-if="visibleLayers.has('arguments') && lensRelations.length" class="paper-map-relations">
          <div v-for="relation in lensRelations" :key="relation.relation_id">
            <span>{{ relationLandmarkLabel(relation.source_landmark_id) }}</span>
            <span class="paper-map-relation-kind">
              {{ relationLabel(relation.type) }}
              <ArrowRight :size="12" aria-hidden="true" />
            </span>
            <span>{{ relationLandmarkLabel(relation.target_landmark_id) }}</span>
          </div>
        </div>
        <p
          v-else-if="visibleLayers.has('arguments') && props.base?.layer_status.arguments?.status !== 'available'"
          class="paper-map-empty"
          :title="layerReason('arguments')"
        >
          论证关系不可用
        </p>

        <div v-if="props.effectReason" class="paper-map-effect">
          <span>{{ props.effectReason }}</span>
          <button
            v-if="props.undoAvailable"
            type="button"
            title="撤销上一次地图调整"
            aria-label="撤销上一次地图调整"
            :disabled="props.actionBusy"
            @click="emit('undo')"
          >
            <Undo2 :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.paper-map-shell {
  --map-accent: #bd5b44;
  width: 100%;
  min-width: 0;
  border-top: 1px solid var(--hairline-soft);
  border-bottom: 1px solid var(--hairline-soft);
  background: rgba(255, 255, 255, 0.48);
}
.paper-map-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 38px;
  padding: 0.35rem 0.2rem;
}
.paper-map-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.4rem;
  color: var(--ink);
  font-size: 0.78rem;
  font-weight: 700;
}
.paper-map-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.paper-map-toggle {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--canvas);
  color: var(--steel);
  padding: 0;
}
.paper-map-toggle:disabled {
  opacity: 0.45;
}
.paper-map-body {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 0.65rem;
  min-height: 152px;
  padding: 0.35rem 0.25rem 0.7rem;
}
.paper-map-shell.expanded .paper-map-body {
  grid-template-columns: 22px minmax(0, 1fr);
}
.paper-map-shell:not(.expanded) .paper-map-body {
  grid-template-columns: 22px;
  min-height: 118px;
}
.paper-map-track {
  position: relative;
  width: 22px;
  height: 100%;
  min-height: 108px;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 4px;
  background: #f4f2ed;
  cursor: ns-resize;
  touch-action: none;
}
.paper-map-track:focus-visible {
  outline: 2px solid var(--map-accent);
  outline-offset: 2px;
}
.paper-map-region {
  position: absolute;
  left: 3px;
  right: 3px;
  border-radius: 2px;
  background: #aeb7b4;
}
.kind-abstract,
.kind-introduction { background: #6e8f83; }
.kind-related_work { background: #a4926f; }
.kind-method { background: #5c7f9c; }
.kind-results { background: #bd7a4d; }
.kind-discussion,
.kind-conclusion { background: #9d675c; }
.kind-references { background: #8b8b86; }
.paper-map-landmark {
  position: absolute;
  right: 1px;
  width: 5px;
  height: 5px;
  z-index: 2;
  transform: translateY(-50%);
  border: 1px solid #fff;
  border-radius: 50%;
  background: #292d2c;
}
.paper-map-viewport {
  position: absolute;
  left: -1px;
  right: -1px;
  height: 4px;
  z-index: 3;
  transform: translateY(-50%);
  border-top: 2px solid var(--map-accent);
  border-bottom: 1px solid rgba(255, 255, 255, 0.9);
}
.paper-map-region-list {
  display: grid;
  align-content: start;
  gap: 0.15rem;
  min-width: 0;
  max-height: 18rem;
  overflow-y: auto;
}
.paper-map-expanded-controls {
  grid-column: 1 / -1;
  display: grid;
  gap: 0.65rem;
  min-width: 0;
}
.paper-map-modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 5px;
}
.paper-map-modes button {
  min-width: 0;
  min-height: 30px;
  border: 0;
  border-right: 1px solid var(--hairline-soft);
  background: transparent;
  color: var(--muted);
  font-size: 0.7rem;
}
.paper-map-modes button:last-child { border-right: 0; }
.paper-map-modes button.active {
  background: var(--reader-coral-soft);
  color: var(--ink);
  font-weight: 700;
}
.paper-map-layers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.25rem 0.5rem;
}
.paper-map-layers label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
  color: var(--steel);
  font-size: 0.68rem;
}
.paper-map-lens,
.paper-map-chain,
.paper-map-local-chain,
.paper-map-correspondences,
.paper-map-relations {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
}
.paper-map-chain-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 24px;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  min-height: 30px;
  border-bottom: 1px solid var(--hairline-soft);
}
.paper-map-landmark-link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--steel);
  padding: 0.2rem 0;
  text-align: left;
}
.paper-map-landmark-link > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.paper-map-landmark-link > small { color: var(--stone); font-family: var(--mono); }
.paper-map-pin {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 0;
}
.paper-map-local-chain {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.paper-map-local-chain button {
  display: grid;
  gap: 0.12rem;
  min-width: 0;
  min-height: 58px;
  border: 1px solid var(--hairline-soft);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.48);
  color: var(--steel);
  padding: 0.35rem;
  text-align: left;
}
.paper-map-local-chain small { color: var(--stone); font-size: 0.6rem; text-transform: uppercase; }
.paper-map-local-chain strong {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: 0.68rem;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.paper-map-correspondences button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  min-height: 28px;
  border: 0;
  border-bottom: 1px solid var(--hairline-soft);
  background: transparent;
  color: var(--steel);
  padding: 0.2rem 0;
  font-size: 0.64rem;
  text-align: left;
}
.paper-map-correspondences span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paper-map-relations > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 0.25rem;
  color: var(--steel);
  font-size: 0.62rem;
}
.paper-map-relations > div > span:not(.paper-map-relation-kind) {
  overflow-wrap: anywhere;
  line-height: 1.35;
  white-space: normal;
}
.paper-map-relation-kind { display: flex; align-items: center; gap: 0.15rem; color: var(--stone); }
.paper-map-empty { margin: 0; color: var(--muted); font-size: 0.68rem; }
.paper-map-effect {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  align-items: center;
  gap: 0.35rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.45rem;
  color: var(--muted);
  font-size: 0.66rem;
}
.paper-map-effect span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.paper-map-effect button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--hairline);
  border-radius: 5px;
  background: var(--canvas);
  color: var(--steel);
  padding: 0;
}
.paper-map-region-list button {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  min-height: 34px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  padding: 0.25rem 0.35rem;
  color: var(--steel);
  text-align: left;
}
.paper-map-region-list button:hover,
.paper-map-region-list button.active {
  background: var(--reader-coral-soft);
  color: var(--ink);
}
.paper-map-region-swatch {
  width: 5px;
  height: 24px;
  border-radius: 2px;
  background: #aeb7b4;
}
.paper-map-region-copy {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.4rem;
}
.paper-map-region-copy strong {
  overflow: hidden;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.paper-map-region-copy small {
  flex: 0 0 auto;
  color: var(--stone);
  font-family: var(--mono);
  font-size: 0.65rem;
}
@media (max-width: 767px) {
  .paper-map-shell {
    position: fixed;
    top: 7.25rem;
    left: 0.75rem;
    z-index: 30;
    width: 52px;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(31, 38, 36, 0.14);
    background: rgba(255, 255, 255, 0.94);
  }
  .paper-map-shell.expanded {
    width: min(320px, calc(100vw - 1.5rem));
    max-height: calc(100vh - 8rem);
    overflow-y: auto;
  }
  .paper-map-title span {
    display: none;
  }
  .paper-map-shell.expanded .paper-map-title span {
    display: inline;
  }
  .paper-map-toolbar {
    padding: 0.3rem 0.4rem;
  }
  .paper-map-shell:not(.expanded) .paper-map-title {
    display: none;
  }
  .paper-map-shell:not(.expanded) .paper-map-toolbar {
    justify-content: center;
  }
  .paper-map-shell:not(.expanded) .paper-map-body {
    display: none;
  }
}
</style>
