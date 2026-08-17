<script setup lang="ts">
import type { MemoryRecord } from "../api";

const props = defineProps<{
  note: MemoryRecord;
  renderMarkdown: (source: string) => string;
  open?: boolean;
}>();

const emit = defineEmits<{
  (event: "focus-source", source: { lid: string; quote: string | null }): void;
  (event: "edit", note: MemoryRecord): void;
  (event: "delete", note: MemoryRecord): void;
  (event: "toggle", open: boolean): void;
}>();

function leadingQuote(content: string): string | null {
  const lines = content.split("\n");
  const quoteLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(">")) quoteLines.push(line.replace(/^>\s?/, ""));
    else if (quoteLines.length > 0 && line.trim() === "") break;
    else if (quoteLines.length > 0) break;
  }
  const quote = quoteLines.join(" ").replace(/\s+/g, " ").trim();
  return quote || null;
}

function notePreview(note: MemoryRecord): string {
  const content = note.content.replace(/^>.*(\n>.*)*\n*/m, "").trim();
  if (content.length <= 260) return content;
  return `${content.slice(0, 260).trimEnd()}...`;
}

function noteSourceLabel(note: MemoryRecord): string {
  const quote = leadingQuote(note.content);
  if (quote) return "引用来源";
  return note.anchor.lid ? "跳到来源" : "无来源";
}

function isLongNote(note: MemoryRecord): boolean {
  return note.content.length > 360 || note.content.split("\n").length > 8;
}

function focusSource() {
  const lid = props.note.anchor.lid;
  if (!lid) return;
  emit("focus-source", { lid, quote: leadingQuote(props.note.content) });
}

function onToggle(event: Event) {
  const details = event.currentTarget;
  if (details instanceof HTMLDetailsElement) emit("toggle", details.open);
}
</script>

<template>
  <details
    class="note-card"
    :open="props.open ?? !isLongNote(props.note)"
    @toggle="onToggle"
  >
    <summary class="note-summary">
      <span class="note-kind">笔记</span>
      <button
        v-if="props.note.anchor.lid"
        class="note-source"
        @click.prevent.stop="focusSource"
      >
        {{ noteSourceLabel(props.note) }}
      </button>
      <span v-else class="note-source">无来源</span>
      <span v-if="isLongNote(props.note)" class="note-fold">展开/收起</span>
      <div
        v-if="isLongNote(props.note)"
        class="note-preview note-summary-preview md"
        v-html="props.renderMarkdown(notePreview(props.note))"
      ></div>
    </summary>
    <div class="note-md md" v-html="props.renderMarkdown(props.note.content)"></div>
    <div class="note-actions">
      <button class="note-btn" title="编辑" @click="emit('edit', props.note)">编辑</button>
      <button class="note-btn del" title="删除" @click="emit('delete', props.note)">删除</button>
    </div>
  </details>
</template>
