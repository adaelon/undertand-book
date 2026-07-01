<script setup lang="ts">
defineProps<{
  chapterTitle: string;
  progressPct: number;
  anchorLid: string | null;
  debugOpen: boolean;
}>();
const emit = defineEmits<{
  (e: "scroll", delta: number): void;
  (e: "new-chat"): void;
  (e: "open-book"): void;
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
      <button class="icon-pill" title="上翻" @click="emit('scroll', -3)">↑</button>
      <button class="icon-pill" title="下翻" @click="emit('scroll', 3)">↓</button>
      <button class="ghost-pill" @click="emit('new-chat')">New chat</button>
      <button class="ghost-pill" @click="emit('open-book')">Open book</button>
      <button class="ghost-pill" :class="{ active: debugOpen }" @click="emit('toggle-debug')">Debug</button>
    </div>
  </header>
</template>
