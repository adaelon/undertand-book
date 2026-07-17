<script setup lang="ts">
import { AlertTriangle, CheckCircle2, ChevronDown, Wrench } from "@lucide/vue";
import type { PdfAlignmentQuality } from "../api";

defineProps<{
  quality: PdfAlignmentQuality;
  workbenchAvailable: boolean;
}>();

const emit = defineEmits<{
  (event: "open-workbench"): void;
}>();

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
</script>

<template>
  <section class="alignment-quality-bar" :class="`is-${quality.tier}`" aria-label="PDF 对齐质量">
    <details>
      <summary>
        <AlertTriangle v-if="quality.tier === 'degraded'" :size="16" aria-hidden="true" />
        <CheckCircle2 v-else :size="16" aria-hidden="true" />
        <span>PDF 对齐：{{ quality.tier === "full" ? "完整" : "部分可用" }}</span>
        <ChevronDown class="alignment-quality-chevron" :size="15" aria-hidden="true" />
      </summary>
      <div class="alignment-quality-details">
        <dl>
          <div>
            <dt>语义单元定位</dt>
            <dd>{{ percentage(quality.unit_location_ratio) }}</dd>
          </div>
          <div>
            <dt>文本精确范围</dt>
            <dd>{{ percentage(quality.exact_text_span_ratio) }}</dd>
          </div>
          <div>
            <dt>公式精确区域</dt>
            <dd>{{ percentage(quality.exact_formula_ratio) }}</dd>
          </div>
          <div>
            <dt>标题定位</dt>
            <dd>{{ percentage(quality.heading_location_ratio) }}</dd>
          </div>
        </dl>
        <button
          v-if="workbenchAvailable"
          data-testid="alignment-diagnostics"
          title="在构建工作台中查看对齐诊断"
          @click="emit('open-workbench')"
        >
          <Wrench :size="16" aria-hidden="true" />
          <span>打开对齐诊断</span>
        </button>
      </div>
    </details>
  </section>
</template>

<style scoped>
.alignment-quality-bar {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--hairline-soft);
  background: #f5faf6;
  color: #275943;
}
.alignment-quality-bar.is-degraded {
  background: #fff9eb;
  color: #79520b;
}
details {
  width: 100%;
}
summary {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.42rem;
  padding: 0.35rem 1rem;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 650;
  list-style: none;
}
summary::-webkit-details-marker {
  display: none;
}
.alignment-quality-chevron {
  transition: transform 140ms ease;
}
details[open] .alignment-quality-chevron {
  transform: rotate(180deg);
}
.alignment-quality-details {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.25rem;
  padding: 0.65rem 1rem 0.8rem;
  border-top: 1px solid currentColor;
  border-top-color: color-mix(in srgb, currentColor 18%, transparent);
}
dl {
  width: min(46rem, 100%);
  display: grid;
  grid-template-columns: repeat(4, minmax(7rem, 1fr));
  gap: 0.75rem;
  margin: 0;
}
dl div {
  min-width: 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.55rem;
}
dt {
  color: var(--steel);
  font-size: 0.73rem;
}
dd {
  margin: 0;
  color: var(--ink);
  font-size: 0.82rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
button {
  min-height: 36px;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border-color: color-mix(in srgb, currentColor 28%, transparent);
  background: rgba(255, 255, 255, 0.76);
  color: inherit;
}
@media (max-width: 767px) {
  summary {
    justify-content: flex-start;
    min-height: 40px;
    padding-inline: 0.75rem;
  }
  .alignment-quality-details {
    align-items: stretch;
    flex-direction: column;
    gap: 0.75rem;
    padding-inline: 0.75rem;
  }
  dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  dl div {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.15rem;
  }
  button {
    width: 100%;
  }
}
</style>
