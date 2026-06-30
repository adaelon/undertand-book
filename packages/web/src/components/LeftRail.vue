<script setup lang="ts">
import { computed } from "vue";
import type { OutlineItem } from "../App.vue";

const props = defineProps<{
  outlineItems: OutlineItem[];
  progressPct: number;
  anchorLid: string | null;
  selectedLid: string | null;
  leafCount: number;
  debugOpen: boolean;
  gotoInput: string;
  searchQuery: string;
}>();
const emit = defineEmits<{
  (e: "update:gotoInput", value: string): void;
  (e: "update:searchQuery", value: string): void;
  (e: "goto", lid: string): void;
}>();

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

function gotoOutline(lid: string) {
  emit("goto", lid);
}
</script>

<template>
  <aside class="left-rail">
    <div class="rail-section">
      <label class="rail-label" for="outline-search">Search</label>
      <input
        id="outline-search"
        class="search-pill outline-search"
        :value="props.searchQuery"
        placeholder="Search outline"
        @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="rail-section outline-section">
      <div class="rail-heading">Outline</div>
      <nav class="outline-list" aria-label="Book outline">
        <button
          v-for="item in filteredOutline"
          :key="item.lid"
          class="outline-item"
          :class="{ active: item.lid === activeOutlineLid }"
          :style="{ paddingLeft: `${0.45 + item.depth * 0.75}rem` }"
          :title="item.title"
          @click="gotoOutline(item.lid)"
        >
          <span class="outline-kind">{{ item.kind }}</span>
          <span class="outline-title">{{ item.title }}</span>
        </button>
      </nav>
      <p v-if="filteredOutline.length === 0" class="rail-muted">No outline matches.</p>
    </div>

    <div class="rail-section rail-position">
      <div class="rail-heading">Position</div>
      <div class="position-row"><span>Progress</span><strong>{{ props.progressPct }}%</strong></div>
      <div class="position-row"><span>Leaves</span><strong>{{ props.leafCount }}</strong></div>
      <div class="progress-track"><span :style="{ width: props.progressPct + '%' }"></span></div>
    </div>

    <details v-if="props.debugOpen" class="debug-panel" open>
      <summary>Debug coordinates</summary>
      <p>anchor: <code>{{ props.anchorLid || "-" }}</code></p>
      <p>selected: <code>{{ props.selectedLid || "-" }}</code></p>
      <div class="debug-goto">
        <input
          :value="props.gotoInput"
          placeholder="goto lid"
          @input="emit('update:gotoInput', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('goto', props.gotoInput)"
        />
        <button @click="emit('goto', props.gotoInput)">Go</button>
      </div>
    </details>
  </aside>
</template>

