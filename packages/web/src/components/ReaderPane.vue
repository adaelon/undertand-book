<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { FormulaSemantics, MemoryRecord } from "../api";
import type { Manifest } from "../api";

type NodeKind = Manifest["tree"][number]["kind"];
export interface Segment {
  lid: string;
  text: string;
  kind: NodeKind;
  formula: FormulaSemantics | null;
}

const props = defineProps<{
  segments: Segment[];
  viewportAnchor: string | null;
  selectedLid: string | null;
  renderSeg: (seg: Segment) => string;
  renderMarkdown: (source: string) => string;
  markdownHeadingLevel: (seg: Segment) => number | null;
  isAsset: (seg: Segment) => boolean;
  isHighlighted: (lid: string) => boolean;
  highlightsOf: (lid: string) => MemoryRecord[];
  highlightCardsOf: (lid: string) => MemoryRecord[];
  visibleNotes: MemoryRecord[];
  hlExcerpt: (rec: MemoryRecord) => string;
  imageMeta: (text: string) => { alt: string; src: string } | null;
}>();

type ReaderItem =
  | { type: "flow"; segments: Segment[] }
  | { type: "single"; segment: Segment };

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
  if (quote) return "Quote source";
  return note.anchor.lid ? "Go to source" : "No source";
}
function isLongNote(note: MemoryRecord): boolean {
  return note.content.length > 360 || note.content.split("\n").length > 8;
}
const emit = defineEmits<{
  (e: "select", lid: string): void;
  (e: "prose-mouse-up"): void;
  (e: "highlight-block", lid: string): void;
  (e: "note-block", lid: string): void;
  (e: "modify-highlight", rec: MemoryRecord): void;
  (e: "delete-highlight", rec: MemoryRecord): void;
  (e: "edit-note", rec: MemoryRecord): void;
  (e: "delete-note", rec: MemoryRecord): void;
  (e: "goto", lid: string): void;
  (e: "focus-source-local", source: { lid: string; quote: string | null }): void;
  (e: "open-formula", seg: Segment): void;
  (e: "scroll-edge", direction: "up" | "down"): void;
  (e: "current-lid", lid: string): void;
}>();

const notesByLid = computed(() => {
  const map = new Map<string, MemoryRecord[]>();
  for (const note of props.visibleNotes) {
    const lid = note.anchor.lid;
    if (!lid) continue;
    const arr = map.get(lid);
    if (arr) arr.push(note);
    else map.set(lid, [note]);
  }
  return map;
});
function notesOf(lid: string): MemoryRecord[] {
  return notesByLid.value.get(lid) ?? [];
}
function isMarkdownHeading(seg: Segment): boolean {
  return props.markdownHeadingLevel(seg) !== null;
}
function isFlowSegment(seg: Segment): boolean {
  if (seg.kind === "paragraph" && isMarkdownHeading(seg)) return false;
  return seg.kind === "paragraph" || seg.kind === "formula";
}
function shouldJoinFlow(prev: Segment, next: Segment): boolean {
  return prev.kind === "formula" || next.kind === "formula";
}
const readerItems = computed<ReaderItem[]>(() => {
  const items: ReaderItem[] = [];
  let flow: Segment[] = [];
  const flush = () => {
    if (!flow.length) return;
    items.push({ type: "flow", segments: flow });
    flow = [];
  };
  for (const seg of props.segments) {
    if (isFlowSegment(seg)) {
      const last = flow[flow.length - 1];
      if (last && !shouldJoinFlow(last, seg)) {
        flush();
      }
      flow.push(seg);
    }
    else {
      flush();
      items.push({ type: "single", segment: seg });
    }
  }
  flush();
  return items;
});
function itemKey(item: ReaderItem): string {
  return item.type === "flow" ? item.segments.map((seg) => seg.lid).join("|") : item.segment.lid;
}
function markdownHeadingClass(seg: Segment): Record<string, boolean> {
  const level = props.markdownHeadingLevel(seg);
  if (level === null) return {};
  return {
    "heading-markdown": true,
    [`heading-markdown-${level}`]: true,
  };
}

const pane = ref<HTMLElement | null>(null);
const edgePx = 2;
const preloadScreens = 2;
let pendingCheck = false;
let currentReadingLid: string | null = null;

interface ScrollAnchor {
  lid: string;
  top: number;
}

function atTopEdge(el: HTMLElement): boolean {
  return el.scrollTop <= edgePx;
}

function atBottomEdge(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= edgePx;
}

function preloadPx(el: HTMLElement): number {
  return Math.max(320, el.clientHeight * preloadScreens);
}

function nearTop(el: HTMLElement): boolean {
  return el.scrollTop <= preloadPx(el);
}

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= preloadPx(el);
}

function requestBuffer(direction: "up" | "down") {
  emit("scroll-edge", direction);
}

function checkBufferNeed() {
  const el = pane.value;
  if (!el || props.segments.length === 0) return;
  if (nearBottom(el)) requestBuffer("down");
  if (nearTop(el)) requestBuffer("up");
}

function currentLidAtProbe(): string | null {
  const el = pane.value;
  if (!el) return null;
  const paneRect = el.getBoundingClientRect();
  const probeOffset = Math.min(Math.max(el.clientHeight * 0.28, 96), Math.max(el.clientHeight - 24, 0));
  const probeY = paneRect.top + probeOffset;
  const nodes = Array.from(el.querySelectorAll<HTMLElement>("[data-lid]"));
  let fallback: string | null = null;
  for (const node of nodes) {
    const lid = node.dataset.lid ?? null;
    if (!lid) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom < paneRect.top || rect.top > paneRect.bottom) continue;
    if (rect.top <= probeY && rect.bottom >= probeY) return lid;
    if (rect.top <= probeY) fallback = lid;
    else return fallback ?? lid;
  }
  return fallback;
}

function updateCurrentLid() {
  const lid = currentLidAtProbe();
  if (!lid || lid === currentReadingLid) return;
  currentReadingLid = lid;
  emit("current-lid", lid);
}

function checkScrollState() {
  pendingCheck = false;
  updateCurrentLid();
  checkBufferNeed();
}

async function scheduleScrollStateCheck() {
  if (pendingCheck) return;
  pendingCheck = true;
  await nextTick();
  checkScrollState();
}

function onScroll() {
  void scheduleScrollStateCheck();
}

function onWheel(event: WheelEvent) {
  const el = pane.value;
  if (!el) return;
  if (event.deltaY > 0 && atBottomEdge(el)) {
    event.preventDefault();
    requestBuffer("down");
  }
  else if (event.deltaY < 0 && atTopEdge(el)) {
    event.preventDefault();
    requestBuffer("up");
  }
  else {
    void scheduleScrollStateCheck();
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function onKeydown(event: KeyboardEvent) {
  const el = pane.value;
  if (!el || isEditableTarget(event.target)) return;
  const line = 72;
  const page = Math.max(line, Math.floor(el.clientHeight * 0.82));
  let delta = 0;
  if (event.key === "ArrowDown") delta = line;
  else if (event.key === "ArrowUp") delta = -line;
  else if (event.key === "PageDown") delta = page;
  else if (event.key === "PageUp") delta = -page;
  else return;
  event.preventDefault();
  if (delta > 0 && atBottomEdge(el)) {
    requestBuffer("down");
    return;
  }
  if (delta < 0 && atTopEdge(el)) {
    requestBuffer("up");
    return;
  }
  el.scrollBy({ top: delta, behavior: "smooth" });
  void scheduleScrollStateCheck();
}

function lidElement(lid: string): HTMLElement | null {
  const el = pane.value;
  if (!el) return null;
  return Array.from(el.querySelectorAll<HTMLElement>("[data-lid]")).find((node) => node.dataset.lid === lid) ?? null;
}

function captureScrollAnchor(candidateLids: string[]): ScrollAnchor | null {
  const el = pane.value;
  if (!el) return null;
  const paneRect = el.getBoundingClientRect();
  let best: { lid: string; top: number; score: number } | null = null;
  for (const lid of candidateLids) {
    const node = lidElement(lid);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    const top = rect.top - paneRect.top;
    const visible = rect.bottom >= paneRect.top && rect.top <= paneRect.bottom;
    const score = (visible ? 0 : 100_000) + Math.abs(top);
    if (!best || score < best.score) best = { lid, top, score };
  }
  return best ? { lid: best.lid, top: best.top } : null;
}

async function restoreScrollAnchor(anchor: ScrollAnchor | null) {
  if (!anchor) return;
  await nextTick();
  const el = pane.value;
  const node = lidElement(anchor.lid);
  if (!el || !node) return;
  const paneRect = el.getBoundingClientRect();
  const currentTop = node.getBoundingClientRect().top - paneRect.top;
  el.scrollTop += currentTop - anchor.top;
  void scheduleScrollStateCheck();
}

defineExpose({ captureScrollAnchor, restoreScrollAnchor });

onMounted(() => {
  void scheduleScrollStateCheck();
});
watch(
  () => {
    const first = props.segments[0]?.lid ?? "";
    const last = props.segments[props.segments.length - 1]?.lid ?? "";
    return `${props.segments.length}:${first}:${last}`;
  },
  () => {
    void scheduleScrollStateCheck();
  },
);
</script>

<template>
  <main ref="pane" class="reader-pane" tabindex="0" @scroll.passive="onScroll" @wheel="onWheel" @keydown="onKeydown">
    <article class="prose" @mouseup="emit('prose-mouse-up')">
      <div v-for="item in readerItems" :key="itemKey(item)" class="seg">
        <template v-if="item.type === 'flow'">
          <p class="flow-paragraph">
            <template v-for="seg in item.segments" :key="seg.lid">
              <button
                v-if="seg.kind === 'formula' && seg.formula"
                :data-lid="seg.lid"
                class="formula-open"
                :class="{
                  anchor: seg.lid === props.viewportAnchor,
                  selected: seg.lid === props.selectedLid,
                  hl: props.isHighlighted(seg.lid),
                }"
                title="查看公式语义剖面"
                @click.stop="emit('open-formula', seg)"
              >
                <span class="formula-open-source" v-html="props.renderSeg(seg)"></span>
              </button>
              <span
                v-else-if="seg.kind === 'formula'"
                :data-lid="seg.lid"
                class="formula-inline-source"
                :class="{
                  anchor: seg.lid === props.viewportAnchor,
                  selected: seg.lid === props.selectedLid,
                  hl: props.isHighlighted(seg.lid),
                }"
                @click="emit('select', seg.lid)"
                v-html="props.renderSeg(seg)"
              ></span>
              <span
                v-else
                :data-lid="seg.lid"
                class="flow-text"
                :class="{
                  anchor: seg.lid === props.viewportAnchor,
                  selected: seg.lid === props.selectedLid,
                  hl: props.isHighlighted(seg.lid),
                }"
                @click="emit('select', seg.lid)"
                v-html="props.renderSeg(seg)"
              ></span>
            </template>
          </p>
          <template v-for="seg in item.segments" :key="`meta-${seg.lid}`">
            <div v-if="seg.lid === props.selectedLid" class="block-actions">
              <button @click="emit('highlight-block', seg.lid)">Highlight block</button>
              <button @click="emit('note-block', seg.lid)">Note</button>
            </div>
            <div v-for="h in props.highlightCardsOf(seg.lid)" :key="h.mem_id" class="hl-card">
              <span class="hl-ex">{{ props.hlExcerpt(h) }}</span>
              <span class="hl-actions">
                <button class="note-btn" title="改范围(移除后重选)" @click="emit('modify-highlight', h)">Edit</button>
                <button class="note-btn del" title="删除高亮" @click="emit('delete-highlight', h)">Delete</button>
              </span>
            </div>
            <details
              v-for="note in notesOf(seg.lid)"
              :key="note.mem_id"
              class="note-card"
              :open="!isLongNote(note)"
            >
              <summary class="note-summary">
                <span class="note-kind">Note</span>
                <button
                  v-if="note.anchor.lid"
                  class="note-source"
                  @click.prevent.stop="emit('focus-source-local', { lid: note.anchor.lid, quote: leadingQuote(note.content) })"
                >
                  {{ noteSourceLabel(note) }}
                </button>
                <span v-else class="note-source">No source</span>
                <span v-if="isLongNote(note)" class="note-fold">Toggle</span>
                <div
                  v-if="isLongNote(note)"
                  class="note-preview note-summary-preview md"
                  v-html="props.renderMarkdown(notePreview(note))"
                ></div>
              </summary>
              <div class="note-md md" v-html="props.renderMarkdown(note.content)"></div>
              <div class="note-actions">
                <button class="note-btn" title="编辑" @click="emit('edit-note', note)">Edit</button>
                <button class="note-btn del" title="删除" @click="emit('delete-note', note)">Delete</button>
              </div>
            </details>
          </template>
        </template>

        <template v-else-if="!props.isAsset(item.segment)">
          <p
            :data-lid="item.segment.lid"
            :class="{
              anchor: item.segment.lid === props.viewportAnchor,
              selected: item.segment.lid === props.selectedLid,
              hl: props.isHighlighted(item.segment.lid),
              ['heading-' + item.segment.kind]: item.segment.kind === 'chapter' || item.segment.kind === 'section',
              ...markdownHeadingClass(item.segment),
            }"
            @click="emit('select', item.segment.lid)"
            v-html="props.renderSeg(item.segment)"
          ></p>
          <div v-if="item.segment.lid === props.selectedLid" class="block-actions">
            <button @click="emit('highlight-block', item.segment.lid)">Highlight block</button>
            <button @click="emit('note-block', item.segment.lid)">Note</button>
          </div>
        </template>

        <section
          v-else
          :data-lid="item.segment.lid"
          class="asset-block"
          :class="[`asset-${item.segment.kind}`, {
            anchor: item.segment.lid === props.viewportAnchor,
            selected: item.segment.lid === props.selectedLid,
            hl: props.isHighlighted(item.segment.lid),
          }]"
          @click="emit('select', item.segment.lid)"
        >
          <div class="asset-head">
            <span>{{ item.segment.kind }}</span>
            <button class="asset-jump" title="选中该 LID" @click.stop="emit('select', item.segment.lid)">Locate</button>
          </div>
          <pre v-if="item.segment.kind === 'code'" class="asset-source asset-code"><code v-html="props.renderSeg(item.segment)"></code></pre>
          <pre v-else-if="item.segment.kind === 'table'" class="asset-source asset-table" v-html="props.renderSeg(item.segment)"></pre>
          <figure v-else-if="item.segment.kind === 'image'" class="asset-image-figure">
            <div class="image-preview">
              <span>image</span>
              <strong>{{ props.imageMeta(item.segment.text)?.alt || 'Untitled image' }}</strong>
              <code>{{ props.imageMeta(item.segment.text)?.src || 'src unavailable' }}</code>
            </div>
            <figcaption>Source</figcaption>
            <pre class="asset-source" v-html="props.renderSeg(item.segment)"></pre>
          </figure>
          <div v-if="item.segment.lid === props.selectedLid" class="block-actions asset-actions">
            <button @click.stop="emit('highlight-block', item.segment.lid)">Highlight block</button>
            <button @click.stop="emit('note-block', item.segment.lid)">Note</button>
          </div>
        </section>

        <template v-if="item.type === 'single'">
          <div v-for="h in props.highlightCardsOf(item.segment.lid)" :key="h.mem_id" class="hl-card">
            <span class="hl-ex">{{ props.hlExcerpt(h) }}</span>
            <span class="hl-actions">
              <button class="note-btn" title="改范围(移除后重选)" @click="emit('modify-highlight', h)">Edit</button>
              <button class="note-btn del" title="删除高亮" @click="emit('delete-highlight', h)">Delete</button>
            </span>
          </div>
          <details
            v-for="note in notesOf(item.segment.lid)"
            :key="note.mem_id"
            class="note-card"
            :open="!isLongNote(note)"
          >
            <summary class="note-summary">
              <span class="note-kind">Note</span>
              <button
                v-if="note.anchor.lid"
                class="note-source"
                @click.prevent.stop="emit('focus-source-local', { lid: note.anchor.lid, quote: leadingQuote(note.content) })"
              >
                {{ noteSourceLabel(note) }}
              </button>
              <span v-else class="note-source">No source</span>
              <span v-if="isLongNote(note)" class="note-fold">Toggle</span>
              <div
                v-if="isLongNote(note)"
                class="note-preview note-summary-preview md"
                v-html="props.renderMarkdown(notePreview(note))"
              ></div>
            </summary>
            <div class="note-md md" v-html="props.renderMarkdown(note.content)"></div>
            <div class="note-actions">
              <button class="note-btn" title="编辑" @click="emit('edit-note', note)">Edit</button>
              <button class="note-btn del" title="删除" @click="emit('delete-note', note)">Delete</button>
            </div>
          </details>
        </template>
      </div>
      <p v-if="props.segments.length === 0" class="empty">No content. Confirm the server loaded a book and is listening.</p>
    </article>

  </main>
</template>
