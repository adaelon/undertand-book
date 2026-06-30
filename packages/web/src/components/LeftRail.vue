<script setup lang="ts">
defineProps<{
  progressPct: number;
  anchorLid: string | null;
  selectedLid: string | null;
  leafCount: number;
  debugOpen: boolean;
  gotoInput: string;
}>();
const emit = defineEmits<{
  (e: "update:gotoInput", value: string): void;
  (e: "goto", lid: string): void;
}>();
</script>

<template>
  <aside class="left-rail">
    <div class="rail-section">
      <label class="rail-label">Search</label>
      <div class="search-pill">Search current workspace</div>
    </div>

    <div class="rail-section">
      <div class="rail-heading">Outline</div>
      <div class="outline-placeholder">
        <span class="dot active"></span>
        <span>{{ anchorLid ? "Current chapter" : "Loading" }}</span>
      </div>
      <p class="rail-muted">Full manifest outline lands in S11b.</p>
    </div>

    <div class="rail-section rail-position">
      <div class="rail-heading">Position</div>
      <div class="position-row"><span>Progress</span><strong>{{ progressPct }}%</strong></div>
      <div class="position-row"><span>Leaves</span><strong>{{ leafCount }}</strong></div>
      <div class="progress-track"><span :style="{ width: progressPct + '%' }"></span></div>
    </div>

    <details v-if="debugOpen" class="debug-panel" open>
      <summary>Debug coordinates</summary>
      <p>anchor: <code>{{ anchorLid || "-" }}</code></p>
      <p>selected: <code>{{ selectedLid || "-" }}</code></p>
      <div class="debug-goto">
        <input
          :value="gotoInput"
          placeholder="goto lid"
          @input="emit('update:gotoInput', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('goto', gotoInput)"
        />
        <button @click="emit('goto', gotoInput)">Go</button>
      </div>
    </details>
  </aside>
</template>
