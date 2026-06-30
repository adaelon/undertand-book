<script setup lang="ts">
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
  renderSeg: (seg: { lid: string; text: string }) => string;
  renderMarkdown: (source: string) => string;
  isAsset: (seg: Segment) => boolean;
  isHighlighted: (lid: string) => boolean;
  highlightsOf: (lid: string) => MemoryRecord[];
  notesOf: (lid: string) => MemoryRecord[];
  hlExcerpt: (rec: MemoryRecord) => string;
  imageMeta: (text: string) => { alt: string; src: string } | null;
}>();
const emit = defineEmits<{
  (e: "select", lid: string): void;
  (e: "prose-mouse-up"): void;
  (e: "modify-highlight", rec: MemoryRecord): void;
  (e: "delete-highlight", rec: MemoryRecord): void;
  (e: "edit-note", rec: MemoryRecord): void;
  (e: "delete-note", rec: MemoryRecord): void;
}>();
</script>

<template>
  <main class="reader-pane">
    <article class="prose" @mouseup="emit('prose-mouse-up')">
      <div v-for="seg in props.segments" :key="seg.lid" class="seg">
        <p
          v-if="!props.isAsset(seg)"
          :data-lid="seg.lid"
          :class="{
            anchor: seg.lid === props.viewportAnchor,
            selected: seg.lid === props.selectedLid,
            hl: props.isHighlighted(seg.lid),
          }"
          @click="emit('select', seg.lid)"
          v-html="props.renderSeg(seg)"
        ></p>
        <section
          v-else
          :data-lid="seg.lid"
          class="asset-block"
          :class="[`asset-${seg.kind}`, {
            anchor: seg.lid === props.viewportAnchor,
            selected: seg.lid === props.selectedLid,
            hl: props.isHighlighted(seg.lid),
          }]"
          @click="emit('select', seg.lid)"
        >
          <div class="asset-head">
            <span>{{ seg.kind }}</span>
            <button class="asset-jump" title="选中该 LID" @click.stop="emit('select', seg.lid)">Locate</button>
          </div>
          <pre v-if="seg.kind === 'code'" class="asset-source asset-code"><code v-html="props.renderSeg(seg)"></code></pre>
          <pre v-else-if="seg.kind === 'table'" class="asset-source asset-table" v-html="props.renderSeg(seg)"></pre>
          <figure v-else-if="seg.kind === 'image'" class="asset-image-figure">
            <div class="image-preview">
              <span>image</span>
              <strong>{{ props.imageMeta(seg.text)?.alt || 'Untitled image' }}</strong>
              <code>{{ props.imageMeta(seg.text)?.src || 'src unavailable' }}</code>
            </div>
            <figcaption>Source</figcaption>
            <pre class="asset-source" v-html="props.renderSeg(seg)"></pre>
          </figure>
          <div v-else-if="seg.kind === 'formula'" class="asset-formula-body">
            <pre class="asset-source formula-source" v-html="props.renderSeg(seg)"></pre>
            <div v-if="seg.formula" class="formula-profile">
              <p class="formula-meaning">{{ seg.formula.composition.meaning }}</p>
              <div v-if="seg.formula.parameters.length" class="formula-section">
                <h4>Parameters</h4>
                <dl>
                  <template v-for="p in seg.formula.parameters" :key="p.symbol">
                    <dt>{{ p.symbol }}<span v-if="p.label"> · {{ p.label }}</span></dt>
                    <dd>
                      {{ p.meaning }}
                      <span v-if="p.unit"> · unit: {{ p.unit }}</span>
                      <span v-if="p.domain"> · domain: {{ p.domain }}</span>
                    </dd>
                  </template>
                </dl>
              </div>
              <div v-if="seg.formula.context_links.length" class="formula-section">
                <h4>Context links</h4>
                <ul>
                  <li v-for="link in seg.formula.context_links" :key="`${link.target_lid}:${link.relation}`">
                    <strong>{{ link.relation }}</strong> {{ link.description }}
                  </li>
                </ul>
              </div>
            </div>
            <p v-else class="formula-empty">No formula profile found.</p>
          </div>
        </section>

        <div v-for="h in props.highlightsOf(seg.lid)" :key="h.mem_id" class="hl-card">
          <span class="hl-ex">{{ props.hlExcerpt(h) }}</span>
          <span class="hl-actions">
            <button class="note-btn" title="改范围(移除后重选)" @click="emit('modify-highlight', h)">Edit</button>
            <button class="note-btn del" title="删除高亮" @click="emit('delete-highlight', h)">Delete</button>
          </span>
        </div>
        <div v-for="note in props.notesOf(seg.lid)" :key="note.mem_id" class="note-card">
          <div class="note-md md" v-html="props.renderMarkdown(note.content)"></div>
          <div class="note-actions">
            <button class="note-btn" title="编辑" @click="emit('edit-note', note)">Edit</button>
            <button class="note-btn del" title="删除" @click="emit('delete-note', note)">Delete</button>
          </div>
        </div>
      </div>
      <p v-if="props.segments.length === 0" class="empty">No content. Confirm the server loaded a book and is listening.</p>
    </article>
  </main>
</template>
