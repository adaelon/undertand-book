<script setup lang="ts">
import { Settings } from "@lucide/vue";

defineProps<{
  chapterTitle: string;
  progressPct: number;
  anchorLid: string | null;
  debugOpen: boolean;
  leftRailOpen: boolean;
  workbenchAvailable: boolean;
  desktopHost: boolean;
}>();
const emit = defineEmits<{
  (e: "new-chat"): void;
  (e: "open-book"): void;
  (e: "toggle-left-rail"): void;
  (e: "toggle-debug"): void;
  (e: "open-workbench"): void;
  (e: "open-settings"): void;
}>();
</script>

<template>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">understand-book</span>
      <span class="breadcrumb">{{ chapterTitle || "阅读工作区" }}</span>
    </div>
    <div class="topbar-actions">
      <span class="progress">{{ progressPct }}%</span>
      <button class="ghost-pill" :class="{ active: leftRailOpen }" @click="emit('toggle-left-rail')">目录</button>
      <button class="ghost-pill" @click="emit('new-chat')">新对话</button>
      <button v-if="workbenchAvailable" class="ghost-pill" @click="emit('open-workbench')">构建工作台</button>
      <button class="ghost-pill" @click="emit('open-book')">打开书</button>
      <button
        v-if="desktopHost"
        class="topbar-icon-button"
        title="桌面设置"
        aria-label="打开桌面设置"
        @click="emit('open-settings')"
      >
        <Settings :size="17" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <button class="ghost-pill" :class="{ active: debugOpen }" @click="emit('toggle-debug')">调试</button>
    </div>
  </header>
</template>
