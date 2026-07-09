<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { PdfRegion, PdfSourceMap, PdfSourceMapEntry, SourceManifestV2 } from "../api";

const props = defineProps<{
  sourceManifest: SourceManifestV2 | null;
  sourceMap: PdfSourceMap | null;
  pdfUrl: string;
  activeLid: string | null;
  selectedLid: string | null;
}>();

const emit = defineEmits<{
  (e: "goto", lid: string): void;
  (e: "focus-source", source: { lid: string; quote: string | null }): void;
  (e: "select", lid: string): void;
}>();

const pageList = ref<HTMLElement | null>(null);

const pageCount = computed(() => props.sourceMap?.pages.length ?? 0);
const entriesByPage = computed(() => {
  const map = new Map<number, Array<{ entry: PdfSourceMapEntry; region: PdfRegion }>>();
  for (const entry of props.sourceMap?.entries ?? []) {
    for (const region of entry.regions) {
      const list = map.get(region.pageIndex);
      if (list) list.push({ entry, region });
      else map.set(region.pageIndex, [{ entry, region }]);
    }
  }
  return map;
});
const entryByLid = computed(() => new Map((props.sourceMap?.entries ?? []).map((entry) => [entry.lid, entry])));
const activeEntry = computed(() => {
  const lid = props.activeLid ?? props.selectedLid;
  return lid ? entryByLid.value.get(lid) ?? null : null;
});
const activePageIndex = computed(() => activeEntry.value?.primary_region?.pageIndex ?? activeEntry.value?.regions[0]?.pageIndex ?? 0);
const pdfFrameSrc = computed(() => `${props.pdfUrl}#page=${activePageIndex.value + 1}`);
const mapCapability = computed(() => props.sourceManifest?.capabilities.project_lid_to_pdf.status ?? "unavailable");

function pageRegions(pageIndex: number): Array<{ entry: PdfSourceMapEntry; region: PdfRegion }> {
  return entriesByPage.value.get(pageIndex) ?? [];
}

function pageShellStyle(page: PdfSourceMap["pages"][number]): Record<string, string> {
  return {
    aspectRatio: `${page.width} / ${page.height}`,
  };
}

function regionStyle(page: PdfSourceMap["pages"][number], region: PdfRegion): Record<string, string> {
  const [x1, y1, x2, y2] = region.bbox;
  return {
    left: `${(x1 / page.width) * 100}%`,
    top: `${((page.height - y2) / page.height) * 100}%`,
    width: `${((x2 - x1) / page.width) * 100}%`,
    height: `${((y2 - y1) / page.height) * 100}%`,
  };
}

function regionClass(entry: PdfSourceMapEntry): Record<string, boolean> {
  return {
    active: entry.lid === props.activeLid,
    selected: entry.lid === props.selectedLid,
    fallback: entry.status !== "word_mapped",
  };
}

async function scrollActiveIntoView() {
  await nextTick();
  const pageIndex = activePageIndex.value;
  const target = pageList.value?.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`);
  target?.scrollIntoView({ block: "center" });
}

watch(
  () => [props.activeLid, props.selectedLid, props.sourceMap?.config_hash] as const,
  () => {
    void scrollActiveIntoView();
  },
);
</script>

<template>
  <main class="pdf-reader-pane">
    <section class="pdf-native-pane" aria-label="Original PDF">
      <iframe class="pdf-frame" :src="pdfFrameSrc" title="Original PDF"></iframe>
    </section>

    <aside class="pdf-map-pane" aria-label="PDF map">
      <header class="pdf-map-head">
        <strong>{{ props.sourceManifest?.book_id ?? props.sourceMap?.book_id ?? "PDF" }}</strong>
        <span>{{ pageCount }} pages · {{ mapCapability }}</span>
      </header>
      <div ref="pageList" class="pdf-page-list">
        <section
          v-for="page in props.sourceMap?.pages ?? []"
          :key="page.pageIndex"
          class="pdf-page-shell"
          :class="{ active: page.pageIndex === activePageIndex }"
          :data-page-index="page.pageIndex"
          :style="pageShellStyle(page)"
        >
          <div class="pdf-page-label">{{ page.page_label ?? page.pageIndex + 1 }}</div>
          <button
            v-for="{ entry, region } in pageRegions(page.pageIndex)"
            :key="`${entry.lid}:${region.region_id}`"
            class="pdf-region"
            :class="regionClass(entry)"
            :style="regionStyle(page, region)"
            :title="entry.lid"
            @click.stop="emit('goto', entry.lid)"
            @mouseenter="emit('select', entry.lid)"
          ></button>
        </section>
        <p v-if="!props.sourceMap?.pages.length" class="pdf-empty">PDF map unavailable.</p>
      </div>
      <footer v-if="props.activeLid && !activeEntry" class="pdf-map-foot">
        <button @click="props.activeLid && emit('focus-source', { lid: props.activeLid, quote: null })">Open source</button>
      </footer>
    </aside>
  </main>
</template>

<style scoped>
.pdf-reader-pane {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(13rem, 18rem);
  background: var(--reader-canvas);
  border-left: 1px solid var(--hairline-soft);
  border-right: 1px solid var(--hairline-soft);
}
.pdf-native-pane {
  min-width: 0;
  min-height: 0;
  background: #d8d4cc;
}
.pdf-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.pdf-map-pane {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-left: 1px solid var(--hairline-soft);
  background: var(--surface-soft);
}
.pdf-map-head {
  display: grid;
  gap: 0.12rem;
  padding: 0.7rem 0.8rem;
  border-bottom: 1px solid var(--hairline-soft);
}
.pdf-map-head strong {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
  font-size: 0.9rem;
}
.pdf-map-head span {
  color: var(--muted);
  font-size: 0.76rem;
}
.pdf-page-list {
  min-height: 0;
  overflow-y: auto;
  display: grid;
  gap: 0.8rem;
  align-content: start;
  padding: 0.85rem;
}
.pdf-page-shell {
  position: relative;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--hairline);
  background:
    linear-gradient(0deg, rgba(20, 20, 19, 0.03), rgba(20, 20, 19, 0.03)),
    #fff;
  content-visibility: auto;
  contain-intrinsic-size: 260px 360px;
}
.pdf-page-shell.active {
  border-color: var(--reader-coral);
}
.pdf-page-label {
  position: absolute;
  top: 0.35rem;
  left: 0.4rem;
  z-index: 2;
  min-width: 1.6rem;
  padding: 0.12rem 0.32rem;
  border: 1px solid var(--hairline-soft);
  background: rgba(255, 255, 255, 0.86);
  color: var(--muted);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}
.pdf-region {
  position: absolute;
  z-index: 1;
  min-width: 4px;
  min-height: 4px;
  border: 1px solid rgba(93, 184, 166, 0.62);
  background: rgba(93, 184, 166, 0.16);
  padding: 0;
  cursor: pointer;
}
.pdf-region.fallback {
  border-color: rgba(204, 120, 92, 0.62);
  background: rgba(204, 120, 92, 0.15);
}
.pdf-region.active,
.pdf-region.selected {
  border-color: var(--reader-amber);
  background: rgba(212, 160, 23, 0.28);
}
.pdf-map-foot {
  padding: 0.7rem 0.8rem;
  border-top: 1px solid var(--hairline-soft);
}
.pdf-map-foot button {
  width: 100%;
  min-height: 38px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
}
.pdf-empty {
  margin: 0;
  color: var(--muted);
  font-size: 0.86rem;
}

@media (max-width: 900px) {
  .pdf-reader-pane {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(12rem, 35vh);
  }
  .pdf-map-pane {
    border-left: 0;
    border-top: 1px solid var(--hairline-soft);
  }
  .pdf-page-list {
    grid-auto-flow: column;
    grid-auto-columns: 9rem;
    overflow-x: auto;
    overflow-y: hidden;
  }
}
</style>
