<script setup lang="ts">
defineProps<{
  chapterTitle: string;
  progressPct: number;
  anchorLid: string | null;
  debugOpen: boolean;
  leftRailOpen: boolean;
}>();
const emit = defineEmits<{
  (e: "new-chat"): void;
  (e: "open-book"): void;
  (e: "toggle-left-rail"): void;
  (e: "toggle-debug"): void;
}>();
</script>

<template>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">understand-book</span>
      <span class="breadcrumb">{{ chapterTitle || "Reading workspace" }}</span>
    </div>
    <div class="topbar-actions">
      <span class="progress">{{ progressPct }}%</span>
      <button class="ghost-pill" :class="{ active: leftRailOpen }" @click="emit('toggle-left-rail')">Outline</button>
      <button class="ghost-pill" @click="emit('new-chat')">New chat</button>
      <button class="ghost-pill" @click="emit('open-book')">Open book</button>
      <button class="ghost-pill" :class="{ active: debugOpen }" @click="emit('toggle-debug')">Debug</button>
    </div>
  </header>
</template>
