<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { OutlineItem } from "../App.vue";

interface PaperMapPreset {
  id: string;
  title: string;
  description: string;
  active: boolean;
}

interface PaperMapRow {
  id: string;
  lid: string;
  title: string;
  summary: string;
  evidence_lids: string[];
}

interface PaperPinnedEvidence {
  lid: string;
  reason?: string | null;
}

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
  paperWarnings?: string[];
  paperProfileVersion?: string | null;
  paperLayoutRev?: number | null;
  paperMode?: string;
  paperStage?: string;
  paperGuideReady?: boolean;
  paperQuestionCount?: number;
  paperPresets?: PaperMapPreset[];
  paperRows?: PaperMapRow[];
  paperPinnedEvidence?: PaperPinnedEvidence[];
  paperProposalSummary?: string | null;
}>();
const emit = defineEmits<{
  (e: "update:gotoInput", value: string): void;
  (e: "update:searchQuery", value: string): void;
  (e: "goto", lid: string): void;
  (e: "paper-preset", presetId: string): void;
  (e: "paper-proposal-apply"): void;
  (e: "paper-proposal-dismiss"): void;
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
const paperRows = computed(() => props.paperRows ?? []);
const activePaperRowId = computed(() => {
  const anchor = props.anchorLid;
  if (!anchor) return null;
  return paperRows.value.find((row) => {
    return anchor === row.lid || anchor.startsWith(`${row.lid}.`) || row.lid.startsWith(`${anchor}.`);
  })?.id ?? null;
});
const currentPaperRow = computed(() => {
  return paperRows.value.find((row) => row.id === activePaperRowId.value) ?? paperRows.value[0] ?? null;
});
const paperStatus = computed(() => {
  const parts = [props.paperMode, props.paperStage].filter((part): part is string => !!part);
  return parts.length ? parts.join(" / ") : "paper";
});
const paperPins = computed(() => (props.paperPinnedEvidence ?? []).slice(0, 4));
const paperModeLabels: Record<string, string> = {
  paper: "论文",
  skim: "速览",
  close: "精读",
  deep: "深读",
};
const paperStageLabels: Record<string, string> = {
  passive: "浏览",
  active: "主动阅读",
  critical: "批判阅读",
};
const presetLabels: Record<string, string> = {
  "paper skim": "速览",
  "paper close": "精读",
  "paper deep": "深读",
  "paper abstract": "摘要",
  "paper deep read": "深读",
  skim: "速览",
  close: "精读",
  deep: "深读",
  abstract: "摘要",
};
const presetDescriptionLabels: Record<string, string> = {
  "Skim the paper structure and key stops.": "快速扫论文结构和关键停靠点。",
  "Read closely from the current position.": "从当前位置精读。",
  "Deep read with critical questions and evidence.": "结合批判性问题和证据做深读。",
  "Focus on abstract and contribution.": "聚焦摘要和贡献。",
};
const nodeKindLabels: Record<string, string> = {
  chapter: "章",
  section: "节",
  paragraph: "段落",
  formula: "公式",
  image: "图片",
  table: "表格",
  code: "代码",
};

function presetTitle(title: string): string {
  const normalized = title.trim().toLowerCase();
  return presetLabels[normalized] ?? title.replace(/^paper\s+/i, "").replace(/\s+read$/i, "");
}

function presetDescription(description: string): string {
  return presetDescriptionLabels[description] ?? description;
}

function paperPartLabel(value: string): string {
  return paperModeLabels[value] ?? paperStageLabels[value] ?? value;
}

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

onMounted(() => {
  void scrollActiveOutlineIntoView();
});
watch(activeOutlineLid, () => {
  void scrollActiveOutlineIntoView();
});
</script>

<template>
  <aside class="left-rail">
    <section v-if="props.paperEnabled" class="rail-section paper-minimap" aria-label="论文小地图">
      <header class="paper-minimap-head">
        <div>
          <div class="rail-heading">论文地图</div>
          <p>{{ paperStatus.split(" / ").map(paperPartLabel).join(" / ") }}</p>
        </div>
        <span v-if="props.paperLayoutRev !== null && props.paperLayoutRev !== undefined" class="paper-rev">
          版本 {{ props.paperLayoutRev }}
        </span>
      </header>

      <div v-if="props.paperPresets?.length" class="paper-preset-row" aria-label="论文阅读模式">
        <button
          v-for="preset in props.paperPresets"
          :key="preset.id"
          :class="{ active: preset.active }"
          :title="presetDescription(preset.description)"
          @click="emit('paper-preset', preset.id)"
        >
          {{ presetTitle(preset.title) }}
        </button>
      </div>

      <div class="paper-map-stats">
        <span v-if="props.paperProfileVersion">{{ props.paperProfileVersion }}</span>
        <span>{{ props.paperQuestionCount ?? 0 }} 个问题</span>
        <span v-if="props.paperGuideReady">阅读指南就绪</span>
      </div>

      <p v-if="props.paperLoading" class="rail-muted">正在加载论文地图...</p>
      <p v-else-if="props.paperError" class="rail-muted">{{ props.paperError }}</p>
      <template v-else>
        <p v-if="props.paperWarnings?.length" class="paper-map-warning">{{ props.paperWarnings[0] }}</p>

        <article v-if="currentPaperRow" class="paper-current-stop">
          <button @click="gotoOutline(currentPaperRow.lid)">{{ currentPaperRow.title }}</button>
          <p>{{ currentPaperRow.summary }}</p>
        </article>

        <nav v-if="paperRows.length" class="paper-map-list" aria-label="论文结构">
          <button
            v-for="row in paperRows"
            :key="row.id"
            :class="{ active: row.id === activePaperRowId }"
            :title="row.summary"
            @click="gotoOutline(row.lid)"
          >
            <span>{{ row.title }}</span>
            <small>{{ row.lid }}</small>
          </button>
        </nav>
        <p v-else class="rail-muted">暂无结构地图。</p>

        <div v-if="paperPins.length" class="paper-pin-list">
          <div class="rail-heading">固定证据</div>
          <button v-for="pin in paperPins" :key="pin.lid" @click="gotoOutline(pin.lid)">
            <span>{{ pin.lid }}</span>
            <small>{{ pin.reason ?? "证据" }}</small>
          </button>
        </div>
      </template>

      <div v-if="props.paperProposalSummary" class="paper-layout-proposal">
        <p>{{ props.paperProposalSummary }}</p>
        <div>
          <button @click="emit('paper-proposal-apply')">应用</button>
          <button class="ghost" @click="emit('paper-proposal-dismiss')">忽略</button>
        </div>
      </div>
    </section>

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

