<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  FileCheck2,
  FileText,
  Pencil,
  RefreshCw,
  Sparkles,
  WandSparkles,
} from "@lucide/vue";
import type {
  SourceReviewBlock,
  SourceReviewDecision,
  SourceReviewDecisionKind,
  SourceReviewLlmDifferenceKind,
  SourceReviewLlmSuggestion,
} from "../api";
import {
  SOURCE_REVIEW_LLM_BATCH_NOTE_PREFIX,
  sourceReviewDecisionResolvesBlock,
  type SourceReviewLlmBatchState,
} from "../source-review-batch";
import { renderMarkdown } from "../md";
import SourceReviewPdfPage from "./SourceReviewPdfPage.vue";

const props = withDefaults(defineProps<{
  blocks: SourceReviewBlock[];
  decisions: SourceReviewDecision[];
  pdfUrl: string;
  jobId?: string;
  actioning: boolean;
  stale: boolean;
  readyForRerun: boolean;
  reviewDraft?: string | null;
  llmSuggestions?: Record<string, SourceReviewLlmSuggestion>;
  llmAnalyzingBlockId?: string | null;
  llmErrors?: Record<string, string>;
  llmBatchState?: SourceReviewLlmBatchState | null;
  decisionSetCurrent?: boolean;
  rerunning?: boolean;
}>(), {
  decisionSetCurrent: true,
  rerunning: false,
});

const emit = defineEmits<{
  (e: "resolve", payload: {
    job_id?: string;
    block_id: string;
    decision: SourceReviewDecisionKind;
    replacement_text?: string;
    note?: string;
  }): void;
  (e: "analyze", payload: { block_id: string }): void;
  (e: "analyze-all"): void;
}>();

type ReviewTab = "pdf" | "markdown" | "extracted";

const activeIndex = ref(0);
const activeTab = ref<ReviewTab>("pdf");
const reviewNotes = reactive<Record<string, string>>({});
const reviewEdits = reactive<Record<string, string>>({});
const reviewEditOpen = reactive<Record<string, boolean>>({});
let decisionWatchInitialized = false;
let previousResolvedIds = new Set<string>();

const decisionByBlock = computed(() => new Map(props.decisions.map((decision) => [decision.block_id, decision])));
const activeBlock = computed(() => props.blocks[activeIndex.value] ?? null);
const recordedDecision = computed(() => activeBlock.value ? decisionByBlock.value.get(activeBlock.value.id) ?? null : null);
const activeLlmSuggestion = computed(() => {
  const blockId = activeBlock.value?.id;
  return blockId ? props.llmSuggestions?.[blockId] ?? null : null;
});
const activeLlmError = computed(() => {
  const blockId = activeBlock.value?.id;
  return blockId ? props.llmErrors?.[blockId] ?? null : null;
});
const llmAnalyzing = computed(() => props.llmAnalyzingBlockId === activeBlock.value?.id);
const llmBatchRunning = computed(() => props.llmBatchState?.status === "running");
const llmBatchTargetCount = computed(() => props.blocks.filter((block) => {
  if (!props.decisionSetCurrent) return true;
  const decision = decisionByBlock.value.get(block.id);
  return !sourceReviewDecisionResolvesBlock(block, decision);
}).length);
const llmBatchActionLabel = computed(() => {
  const batch = props.llmBatchState;
  if (batch?.status === "running") return `处理中 ${batch.processed}/${batch.total}`;
  if (!llmBatchTargetCount.value) return "LLM 已处理全部";
  if (batch?.status === "completed" && batch.failed) return `LLM 重试剩余 (${llmBatchTargetCount.value})`;
  return `LLM 处理全部 (${llmBatchTargetCount.value})`;
});
const blockResolved = (block: SourceReviewBlock) => props.decisionSetCurrent && (
  sourceReviewDecisionResolvesBlock(block, decisionByBlock.value.get(block.id))
);
const resolvedCount = computed(() => props.blocks.filter(blockResolved).length);
const remainingCount = computed(() => Math.max(0, props.blocks.length - resolvedCount.value));
const reviewComplete = computed(() => (
  props.readyForRerun
  && props.decisionSetCurrent
  && props.blocks.length > 0
  && remainingCount.value === 0
));
const markdownSource = computed(() => activeBlock.value?.md_context ?? activeBlock.value?.md_excerpt ?? "无 Markdown 文本");
const extractedSource = computed(() => activeBlock.value?.pdf_context ?? "PDF 未提取到可比较文本");

const decisionLabels: Record<SourceReviewDecisionKind, string> = {
  accept_markdown: "保留 Markdown 原文",
  accept_pdf: "采用 PDF 文本",
  use_candidate: "采用系统候选",
  manual_edit: "采用手工修正",
  keep_blocked: "稍后处理",
};
const statusLabels: Record<string, string> = {
  needs_review: "需要复核",
  md_unmatched: "Markdown 未匹配",
  pdf_unmatched: "PDF 未匹配",
};
const llmRecommendationLabels: Record<SourceReviewLlmSuggestion["recommendation"], string> = {
  keep_markdown: "建议保留 Markdown",
  use_pdf: "建议采用 PDF 正文",
  manual_edit: "建议合并修订",
  uncertain: "无法确定",
};
const llmDifferenceLabels: Record<SourceReviewLlmDifferenceKind, string> = {
  formatting: "格式",
  wording: "措辞",
  number: "数值",
  symbol: "符号",
  missing_in_markdown: "Markdown 缺失",
  extra_in_markdown: "Markdown 多出",
  order: "顺序",
  extraction_noise: "提取噪声",
  uncertain: "不确定",
};

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function firstPendingIndex(): number {
  const index = props.blocks.findIndex((block) => !blockResolved(block));
  return index >= 0 ? index : 0;
}

function nextPendingIndex(after: number): number {
  for (let offset = 1; offset <= props.blocks.length; offset += 1) {
    const index = (after + offset) % props.blocks.length;
    const block = props.blocks[index];
    if (!blockResolved(block)) return index;
  }
  return after;
}

function goTo(index: number) {
  activeIndex.value = Math.max(0, Math.min(index, Math.max(0, props.blocks.length - 1)));
  reviewEditOpen[activeBlock.value?.id ?? ""] = false;
}

function pdfLocation(block: SourceReviewBlock): string {
  if (block.pdf_page_label) return `PDF 页 ${block.pdf_page_label}`;
  if (block.pdf_page_index !== undefined) return `PDF 第 ${block.pdf_page_index + 1} 页`;
  return "PDF 提取文本";
}

function confidenceText(block: SourceReviewBlock): string | null {
  if (block.comparison_score === undefined) return null;
  return `候选相似度 ${Math.round(block.comparison_score * 100)}%`;
}

function recordedDecisionLabel(decision: SourceReviewDecision): string {
  if (
    decision.decision === "manual_edit"
    && decision.note?.startsWith(SOURCE_REVIEW_LLM_BATCH_NOTE_PREFIX)
  ) {
    return "已采用 LLM 修订";
  }
  return decisionLabels[decision.decision];
}

function resolve(decision: SourceReviewDecisionKind, replacementText?: string) {
  const block = activeBlock.value;
  if (!block) return;
  emit("resolve", {
    job_id: props.jobId,
    block_id: block.id,
    decision,
    replacement_text: replacementText,
    note: optionalText(reviewNotes[block.id] ?? ""),
  });
}

function openManualEdit() {
  const block = activeBlock.value;
  if (!block) return;
  reviewEdits[block.id] ??= block.candidate_text ?? block.md_excerpt ?? "";
  reviewEditOpen[block.id] = true;
}

function submitManualEdit() {
  const block = activeBlock.value;
  if (!block) return;
  const replacement = optionalText(reviewEdits[block.id] ?? "");
  if (replacement) resolve("manual_edit", replacement);
}

function requestLlmAnalysis() {
  const block = activeBlock.value;
  if (!block) return;
  emit("analyze", { block_id: block.id });
}

function requestAllLlmAnalysis() {
  if (!llmBatchTargetCount.value || llmBatchRunning.value || props.llmAnalyzingBlockId) return;
  emit("analyze-all");
}

function applyLlmSuggestion() {
  const block = activeBlock.value;
  if (!block) return;
  const replacement = optionalText(reviewEdits[block.id] ?? "");
  if (replacement) resolve("manual_edit", replacement);
}

watch(
  () => props.blocks.map((block) => block.id).join("\u0000"),
  () => {
    if (activeIndex.value >= props.blocks.length) activeIndex.value = Math.max(0, props.blocks.length - 1);
  },
  { immediate: true },
);

watch(
  () => props.decisions
    .map((decision) => [decision.block_id, decision.decision, decision.replacement_text ?? "", decision.resolved_at].join("\u0001"))
    .sort()
    .join("\u0000"),
  () => {
    const nextResolvedIds = new Set(
      props.blocks
        .filter(blockResolved)
        .map((block) => block.id),
    );
    if (!decisionWatchInitialized) {
      activeIndex.value = firstPendingIndex();
      decisionWatchInitialized = true;
    } else {
      const current = activeBlock.value;
      if (current && !previousResolvedIds.has(current.id) && nextResolvedIds.has(current.id)) {
        activeIndex.value = nextPendingIndex(activeIndex.value);
      }
    }
    previousResolvedIds = nextResolvedIds;
  },
  { immediate: true },
);

watch(
  () => {
    const suggestion = activeLlmSuggestion.value;
    return suggestion ? `${suggestion.block_id}\u0000${suggestion.replacement_text}` : "";
  },
  () => {
    const block = activeBlock.value;
    const suggestion = activeLlmSuggestion.value;
    if (!block || !suggestion) return;
    reviewEdits[block.id] = suggestion.replacement_text;
    reviewEditOpen[block.id] = false;
  },
  { immediate: true },
);
</script>

<template>
  <section class="source-review-workspace" aria-labelledby="source-review-title">
    <header class="review-workspace-head">
      <div>
        <p>来源对齐复核</p>
        <h2 id="source-review-title">
          <template v-if="reviewComplete">复核完成</template>
          <template v-else-if="activeBlock">问题 {{ activeIndex + 1 }} / {{ props.blocks.length }}</template>
          <template v-else>来源证据</template>
        </h2>
        <span v-if="reviewComplete">{{ props.blocks.length }} 项决定已保存</span>
        <span v-else-if="!props.stale">已解决 {{ resolvedCount }} · 待人工 {{ remainingCount }}</span>
      </div>
      <div v-if="activeBlock && !reviewComplete" class="review-head-actions">
        <button
          type="button"
          class="review-batch-action"
          :disabled="props.stale || props.actioning || llmBatchRunning || !!props.llmAnalyzingBlockId || !llmBatchTargetCount"
          :aria-busy="llmBatchRunning"
          @click="requestAllLlmAnalysis"
        >
          <WandSparkles :size="16" aria-hidden="true" />
          {{ llmBatchActionLabel }}
        </button>
        <div class="review-pager">
          <button type="button" title="上一项" aria-label="上一项" :disabled="activeIndex === 0" @click="goTo(activeIndex - 1)">
            <ChevronLeft :size="18" aria-hidden="true" />
          </button>
          <button type="button" title="下一项" aria-label="下一项" :disabled="activeIndex === props.blocks.length - 1" @click="goTo(activeIndex + 1)">
            <ChevronRight :size="18" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>

    <section
      v-if="props.llmBatchState"
      class="review-batch-status"
      :data-status="props.llmBatchState.status"
      aria-live="polite"
    >
      <div class="review-batch-summary">
        <div>
          <strong v-if="props.llmBatchState.status === 'running'">正在批量处理</strong>
          <strong v-else-if="props.llmBatchState.status === 'cancelled'">批量处理已中止</strong>
          <strong v-else>批量处理完成</strong>
          <span v-if="props.llmBatchState.current_block_id">{{ props.llmBatchState.current_block_id }}</span>
        </div>
        <div>
          <span>已处理 {{ props.llmBatchState.processed }}/{{ props.llmBatchState.total }}</span>
          <span>已采用 {{ props.llmBatchState.applied }}</span>
          <span>待人工 {{ props.llmBatchState.failed }}</span>
        </div>
      </div>
      <progress :max="Math.max(1, props.llmBatchState.total)" :value="props.llmBatchState.processed"></progress>
      <ul v-if="props.llmBatchState.failures.length" class="review-batch-failures">
        <li v-for="failure in props.llmBatchState.failures" :key="failure.block_id">
          <strong>{{ failure.block_id }}</strong>
          <span>{{ failure.message }}</span>
        </li>
      </ul>
    </section>

    <p v-if="props.stale" class="review-workspace-empty">
      当前证据来自旧输入或旧对齐规则；重新运行来源对齐后再复核。
    </p>

    <section v-else-if="reviewComplete" class="review-complete" aria-live="polite">
      <CircleCheck :size="24" aria-hidden="true" />
      <div>
        <strong v-if="props.rerunning || props.actioning">正在自动重新运行来源对齐</strong>
        <strong v-else>来源复核决定已保存</strong>
        <span v-if="props.rerunning || props.actioning">
          系统正在应用 {{ props.blocks.length }} 项决定并重新生成可信正文。
        </span>
        <span v-else>系统会自动继续来源对齐；若启动失败，刷新后会重试。</span>
      </div>
    </section>

    <template v-else-if="activeBlock">
      <div class="review-issue-summary">
        <div class="review-question-line">
          <h3>{{ activeBlock.review_question ?? "Markdown 与 PDF 未能自动确认一致，请对照三种来源。" }}</h3>
          <span v-if="recordedDecision">{{ recordedDecisionLabel(recordedDecision) }}</span>
        </div>
        <div class="review-technical-meta">
          <span>{{ pdfLocation(activeBlock) }}</span>
          <span v-if="confidenceText(activeBlock)">{{ confidenceText(activeBlock) }}</span>
          <span>{{ activeBlock.id }} · {{ statusLabels[activeBlock.status] ?? activeBlock.status }}</span>
        </div>
        <div v-if="activeBlock.difference" class="review-difference">
          <strong>首个差异</strong>
          <del>Markdown: {{ activeBlock.difference.markdown }}</del>
          <ins>PDF: {{ activeBlock.difference.pdf }}</ins>
        </div>
      </div>

      <div class="review-mobile-tabs" role="tablist" aria-label="来源证据">
        <button type="button" role="tab" :aria-selected="activeTab === 'pdf'" @click="activeTab = 'pdf'">原版 PDF</button>
        <button type="button" role="tab" :aria-selected="activeTab === 'markdown'" @click="activeTab = 'markdown'">Markdown</button>
        <button type="button" role="tab" :aria-selected="activeTab === 'extracted'" @click="activeTab = 'extracted'">提取正文</button>
      </div>

      <div class="review-triptych">
        <SourceReviewPdfPage
          class="review-source-pane"
          :class="{ 'mobile-active': activeTab === 'pdf' }"
          :pdf-url="props.pdfUrl"
          :page-index="activeBlock.pdf_page_index"
          :page-label="activeBlock.pdf_page_label"
        />

        <article class="review-source-pane review-markdown-pane" :class="{ 'mobile-active': activeTab === 'markdown' }">
          <header>
            <div>
              <strong>Markdown</strong>
              <span>规范化正文</span>
            </div>
          </header>
          <div class="review-source-scroll">
            <div class="review-rendered-markdown md" v-html="renderMarkdown(markdownSource)"></div>
            <details class="review-raw-source">
              <summary>查看 Markdown 源码</summary>
              <pre>{{ markdownSource }}</pre>
            </details>
          </div>
        </article>

        <article class="review-source-pane review-extracted-pane" :class="{ 'mobile-active': activeTab === 'extracted' }">
          <header>
            <div>
              <strong>PDF 提取正文</strong>
              <span>{{ pdfLocation(activeBlock) }}</span>
            </div>
          </header>
          <div class="review-source-scroll">
            <div class="review-extracted-text">{{ extractedSource }}</div>
            <div v-if="activeBlock.pdf_excerpt" class="review-candidate">
              <span>采用 PDF 时将写入</span>
              <code>{{ activeBlock.pdf_excerpt }}</code>
            </div>
          </div>
        </article>
      </div>

      <footer class="review-decision-bar">
        <div class="review-actions">
          <button
            type="button"
            class="llm-analysis-action"
            :disabled="props.actioning || !!props.llmAnalyzingBlockId"
            :aria-busy="llmAnalyzing"
            @click="requestLlmAnalysis"
          >
            <Sparkles :size="16" aria-hidden="true" />
            {{ llmAnalyzing ? "分析中..." : activeLlmSuggestion ? "重新分析" : "LLM 分析" }}
          </button>
          <button type="button" :disabled="props.actioning" @click="resolve('accept_markdown')">
            <FileText :size="16" aria-hidden="true" />
            保留 Markdown
          </button>
          <button v-if="activeBlock.pdf_excerpt" type="button" :disabled="props.actioning" @click="resolve('accept_pdf')">
            <FileCheck2 :size="16" aria-hidden="true" />
            采用 PDF
          </button>
          <button
            v-if="activeBlock.candidate_text && activeBlock.candidate_text !== activeBlock.pdf_excerpt"
            type="button"
            :disabled="props.actioning"
            @click="resolve('use_candidate')"
          >
            <FileCheck2 :size="16" aria-hidden="true" />
            采用候选
          </button>
          <button type="button" :disabled="props.actioning" @click="openManualEdit">
            <Pencil :size="16" aria-hidden="true" />
            手工修正
          </button>
          <button type="button" :disabled="props.actioning" @click="resolve('keep_blocked')">
            <Clock3 :size="16" aria-hidden="true" />
            稍后处理
          </button>
        </div>

        <p v-if="activeLlmError" class="review-llm-error" role="alert">{{ activeLlmError }}</p>

        <section v-if="activeLlmSuggestion" class="review-llm-result">
          <header class="review-llm-head">
            <div>
              <span>LLM 对比结果</span>
              <strong>{{ activeLlmSuggestion.summary }}</strong>
            </div>
            <div class="review-llm-meta">
              <span>{{ llmRecommendationLabels[activeLlmSuggestion.recommendation] }}</span>
              <span>置信度 {{ Math.round(activeLlmSuggestion.confidence * 100) }}%</span>
              <button
                type="button"
                title="重新分析"
                aria-label="重新分析"
                :disabled="props.actioning || !!props.llmAnalyzingBlockId"
                @click="requestLlmAnalysis"
              >
                <RefreshCw :size="15" aria-hidden="true" />
              </button>
            </div>
          </header>

          <ol v-if="activeLlmSuggestion.differences.length" class="review-llm-differences">
            <li v-for="(difference, index) in activeLlmSuggestion.differences" :key="`${difference.kind}-${index}`">
              <div class="review-llm-difference-head">
                <span>{{ llmDifferenceLabels[difference.kind] }}</span>
                <p>{{ difference.explanation }}</p>
              </div>
              <div class="review-llm-source-pair">
                <div>
                  <span>Markdown</span>
                  <code>{{ difference.markdown || "（无）" }}</code>
                </div>
                <div>
                  <span>PDF</span>
                  <code>{{ difference.pdf || "（无）" }}</code>
                </div>
              </div>
            </li>
          </ol>
          <p v-else class="review-llm-no-difference">未识别出可确认的文本差异。</p>

          <ul v-if="activeLlmSuggestion.warnings.length" class="review-llm-warnings">
            <li v-for="warning in activeLlmSuggestion.warnings" :key="warning">{{ warning }}</li>
          </ul>

          <div class="review-llm-replacement">
            <section>
              <span>修订预览</span>
              <div class="review-llm-preview md" v-html="renderMarkdown(reviewEdits[activeBlock.id] ?? '')"></div>
            </section>
            <label>
              <span>可编辑 Markdown</span>
              <textarea v-model="reviewEdits[activeBlock.id]" rows="7" spellcheck="false"></textarea>
            </label>
          </div>

          <button
            type="button"
            class="review-llm-apply"
            :disabled="props.actioning || !reviewEdits[activeBlock.id]?.trim()"
            @click="applyLlmSuggestion"
          >
            <CircleCheck :size="16" aria-hidden="true" />
            采用 LLM 修订
          </button>
        </section>

        <div v-if="reviewEditOpen[activeBlock.id]" class="review-edit">
          <label>
            <span>可信正文</span>
            <textarea v-model="reviewEdits[activeBlock.id]" rows="5" spellcheck="false"></textarea>
          </label>
          <button
            type="button"
            class="primary-action"
            :disabled="props.actioning || !reviewEdits[activeBlock.id]?.trim()"
            @click="submitManualEdit"
          >
            确认手工修正
          </button>
        </div>

        <div class="review-secondary-controls">
          <details class="review-note">
            <summary>复核备注</summary>
            <textarea v-model="reviewNotes[activeBlock.id]" rows="2" placeholder="可留空" spellcheck="false"></textarea>
          </details>
          <details v-if="props.reviewDraft" class="review-draft">
            <summary>完整待复核草稿</summary>
            <pre>{{ props.reviewDraft }}</pre>
          </details>
        </div>
      </footer>
    </template>

    <p v-else class="review-workspace-empty">
      {{ props.readyForRerun ? "全部差异已确认，可以重新运行来源对齐。" : "没有未解决片段。" }}
    </p>
  </section>
</template>

<style scoped>
.source-review-workspace {
  min-width: 0;
  margin-bottom: 1rem;
  overflow: hidden;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: #f7f7f5;
}
.review-workspace-head {
  min-height: 62px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--hairline-soft);
  background: #fff;
  padding: 0.65rem 0.8rem;
}
.review-workspace-head > div:first-child {
  min-width: 0;
  display: grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  gap: 0.12rem 0.65rem;
}
.review-workspace-head p {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--steel);
  font-size: 0.68rem;
  text-transform: uppercase;
}
.review-workspace-head h2 {
  margin: 0;
  color: var(--ink);
  font-size: 1rem;
  letter-spacing: 0;
}
.review-workspace-head span {
  color: var(--steel);
  font-size: 0.72rem;
}
.review-pager {
  display: flex;
  gap: 0.3rem;
}
.review-head-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.45rem;
}
.review-batch-action {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid #174d45;
  border-radius: 7px;
  background: #174d45;
  color: #fff;
  padding: 0.35rem 0.65rem;
  font-size: 0.72rem;
  font-weight: 700;
}
.review-batch-action:disabled {
  opacity: 0.5;
}
.review-pager button {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
}
.review-pager button:disabled {
  opacity: 0.35;
}
.review-batch-status {
  display: grid;
  gap: 0.5rem;
  border-bottom: 1px solid #c9dcd7;
  background: #f3faf8;
  padding: 0.65rem 0.8rem;
}
.review-batch-status[data-status="completed"] {
  background: #f7faf8;
}
.review-batch-status[data-status="cancelled"] {
  border-bottom-color: #ead5b9;
  background: #fff8ed;
}
.review-batch-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.review-batch-summary > div {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.3rem 0.65rem;
}
.review-batch-summary strong {
  color: var(--ink);
  font-size: 0.78rem;
}
.review-batch-summary span {
  color: var(--steel);
  font-size: 0.7rem;
}
.review-batch-status progress {
  width: 100%;
  height: 6px;
  border: 0;
  border-radius: 3px;
  overflow: hidden;
  accent-color: #174d45;
}
.review-batch-failures {
  max-height: 150px;
  overflow: auto;
  display: grid;
  gap: 0.3rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.review-batch-failures li {
  display: grid;
  grid-template-columns: 6rem minmax(0, 1fr);
  gap: 0.5rem;
  border-left: 3px solid #b46a1f;
  background: #fff;
  padding: 0.4rem 0.55rem;
}
.review-batch-failures strong,
.review-batch-failures span {
  font-size: 0.7rem;
  line-height: 1.45;
}
.review-batch-failures strong {
  color: #71430f;
}
.review-batch-failures span {
  color: var(--slate);
  overflow-wrap: anywhere;
}
.review-issue-summary {
  display: grid;
  gap: 0.38rem;
  border-bottom: 1px solid var(--hairline-soft);
  background: #fff;
  padding: 0.7rem 0.8rem;
}
.review-question-line {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 0.8rem;
}
.review-question-line h3 {
  margin: 0;
  color: var(--ink);
  font-size: 0.88rem;
  line-height: 1.45;
  letter-spacing: 0;
}
.review-question-line > span {
  flex: 0 0 auto;
  border: 1px solid #bbd8cf;
  border-radius: 999px;
  background: #edf8f4;
  color: #14634f;
  padding: 0.18rem 0.45rem;
  font-size: 0.67rem;
}
.review-technical-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.75rem;
  color: var(--steel);
  font-size: 0.68rem;
}
.review-difference {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.55rem;
  border-left: 3px solid #b46a1f;
  background: #fff8ed;
  padding: 0.42rem 0.55rem;
  color: var(--slate);
  font-size: 0.74rem;
}
.review-difference del {
  color: #8f3b35;
}
.review-difference ins {
  color: #14634f;
  text-decoration: none;
}
.review-mobile-tabs {
  display: none;
}
.review-triptych {
  height: clamp(520px, 64vh, 760px);
  display: grid;
  grid-template-columns: minmax(300px, 0.9fr) minmax(320px, 1fr) minmax(320px, 1fr);
  gap: 1px;
  background: var(--hairline-soft);
}
.review-source-pane {
  min-width: 0;
  min-height: 0;
}
article.review-source-pane {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: #fff;
}
article.review-source-pane > header {
  min-height: 48px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--hairline-soft);
  padding: 0.45rem 0.65rem;
}
article.review-source-pane > header div {
  display: grid;
  gap: 0.08rem;
}
article.review-source-pane > header strong {
  color: var(--ink);
  font-size: 0.78rem;
}
article.review-source-pane > header span {
  color: var(--steel);
  font-size: 0.68rem;
}
.review-markdown-pane > header {
  border-top: 3px solid #16735b;
}
.review-extracted-pane > header {
  border-top: 3px solid #b7443e;
}
.review-source-scroll {
  min-height: 0;
  overflow: auto;
  padding: 0.8rem;
}
.review-rendered-markdown,
.review-extracted-text {
  color: var(--ink);
  font-family: var(--serif);
  font-size: 0.9rem;
  line-height: 1.72;
  overflow-wrap: anywhere;
}
.review-rendered-markdown :deep(> :first-child) {
  margin-top: 0;
}
.review-rendered-markdown :deep(> :last-child) {
  margin-bottom: 0;
}
.review-extracted-text {
  white-space: pre-wrap;
}
.review-raw-source {
  margin-top: 1rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.65rem;
}
.review-raw-source summary,
.review-note summary,
.review-draft summary {
  cursor: pointer;
  color: var(--slate);
  font-size: 0.72rem;
  font-weight: 650;
}
.review-raw-source pre,
.review-draft pre {
  max-height: 220px;
  overflow: auto;
  margin: 0.55rem 0 0;
  border: 1px solid var(--hairline-soft);
  border-radius: 6px;
  background: var(--surface-code);
  padding: 0.55rem;
  color: var(--ink);
  font-size: 0.74rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.review-candidate {
  display: grid;
  gap: 0.3rem;
  margin-top: 1rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.65rem;
}
.review-candidate span {
  color: var(--slate);
  font-size: 0.72rem;
  font-weight: 650;
}
.review-candidate code {
  display: block;
  border: 1px solid var(--hairline-soft);
  border-radius: 6px;
  background: var(--surface-code);
  padding: 0.55rem;
  color: var(--ink);
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.review-decision-bar {
  display: grid;
  gap: 0.55rem;
  border-top: 1px solid var(--hairline-soft);
  background: #fff;
  padding: 0.65rem 0.8rem;
}
.review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.review-actions button,
.review-edit button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
  padding: 0.35rem 0.65rem;
  font-size: 0.74rem;
}
.review-actions button:disabled,
.review-edit button:disabled {
  opacity: 0.5;
}
.review-actions .llm-analysis-action {
  border-color: #205f55;
  background: #174d45;
  color: #fff;
}
.review-llm-error {
  margin: 0;
  border-left: 3px solid #b7443e;
  background: #fff1ef;
  padding: 0.55rem 0.65rem;
  color: #7f302b;
  font-size: 0.75rem;
  line-height: 1.5;
}
.review-llm-result {
  display: grid;
  gap: 0.7rem;
  border: 1px solid #b9d6cf;
  border-radius: 7px;
  background: #f7fbfa;
  padding: 0.75rem;
}
.review-llm-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 0.8rem;
}
.review-llm-head > div:first-child {
  min-width: 0;
  display: grid;
  gap: 0.18rem;
}
.review-llm-head > div:first-child > span,
.review-llm-replacement span {
  color: var(--steel);
  font-size: 0.67rem;
  font-weight: 700;
  text-transform: uppercase;
}
.review-llm-head strong {
  color: var(--ink);
  font-size: 0.84rem;
  line-height: 1.45;
}
.review-llm-meta {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.review-llm-meta > span {
  border: 1px solid #c5d8d3;
  border-radius: 999px;
  background: #fff;
  padding: 0.2rem 0.45rem;
  color: #28584f;
  font-size: 0.66rem;
}
.review-llm-meta button {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid #c5d8d3;
  border-radius: 6px;
  background: #fff;
  color: #28584f;
}
.review-llm-differences {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid #d8e5e1;
}
.review-llm-differences > li {
  display: grid;
  gap: 0.45rem;
  border-bottom: 1px solid #d8e5e1;
  padding: 0.62rem 0;
}
.review-llm-difference-head {
  display: grid;
  grid-template-columns: 7rem minmax(0, 1fr);
  gap: 0.6rem;
  align-items: baseline;
}
.review-llm-difference-head > span {
  color: #28584f;
  font-size: 0.7rem;
  font-weight: 750;
}
.review-llm-difference-head p,
.review-llm-no-difference {
  margin: 0;
  color: var(--slate);
  font-size: 0.74rem;
  line-height: 1.5;
}
.review-llm-source-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}
.review-llm-source-pair > div {
  min-width: 0;
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  gap: 0.45rem;
  align-items: start;
}
.review-llm-source-pair span {
  color: var(--steel);
  font-size: 0.67rem;
  font-weight: 700;
}
.review-llm-source-pair code {
  color: var(--ink);
  font-size: 0.72rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.review-llm-warnings {
  margin: 0;
  border-left: 3px solid #b46a1f;
  background: #fff8ed;
  padding: 0.5rem 0.65rem 0.5rem 1.65rem;
  color: #71430f;
  font-size: 0.72rem;
  line-height: 1.5;
}
.review-llm-replacement {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1px;
  border: 1px solid #cddbd7;
  border-radius: 7px;
  overflow: hidden;
  background: #cddbd7;
}
.review-llm-replacement > section,
.review-llm-replacement > label {
  min-width: 0;
  display: grid;
  grid-template-rows: auto minmax(150px, 1fr);
  gap: 0.35rem;
  background: #fff;
  padding: 0.6rem;
}
.review-llm-preview {
  max-height: 260px;
  overflow: auto;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 0.82rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.review-llm-preview :deep(> :first-child) {
  margin-top: 0;
}
.review-llm-preview :deep(> :last-child) {
  margin-bottom: 0;
}
.review-llm-replacement textarea {
  width: 100%;
  min-height: 150px;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--hairline-soft);
  border-radius: 6px;
  background: var(--surface-code);
  color: var(--ink);
  padding: 0.55rem;
  font-family: var(--mono);
  font-size: 0.75rem;
  line-height: 1.55;
}
.review-llm-apply {
  min-height: 36px;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid #174d45;
  border-radius: 7px;
  background: #174d45;
  color: #fff;
  padding: 0.35rem 0.7rem;
  font-size: 0.74rem;
}
.review-llm-apply:disabled,
.review-llm-meta button:disabled {
  opacity: 0.5;
}
.review-edit {
  display: grid;
  gap: 0.45rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.55rem;
}
.review-edit label {
  display: grid;
  gap: 0.3rem;
}
.review-edit label span {
  color: var(--slate);
  font-size: 0.72rem;
  font-weight: 650;
}
.review-edit textarea,
.review-note textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
  padding: 0.5rem 0.6rem;
}
.review-edit .primary-action {
  justify-self: start;
  background: var(--ink);
  color: #fff;
}
.review-secondary-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
}
.review-note,
.review-draft {
  min-width: min(100%, 22rem);
}
.review-note textarea {
  margin-top: 0.45rem;
}
.review-workspace-empty {
  margin: 0;
  padding: 1rem;
  color: var(--steel);
  font-size: 0.82rem;
}
.review-complete {
  min-height: 112px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.7rem;
  background: #f3faf8;
  padding: 1.2rem;
  color: #14634f;
}
.review-complete > div {
  display: grid;
  gap: 0.2rem;
}
.review-complete strong {
  color: var(--ink);
  font-size: 0.9rem;
}
.review-complete span {
  color: var(--steel);
  font-size: 0.76rem;
  line-height: 1.45;
}

@media (max-width: 1050px) {
  .review-mobile-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.25rem;
    border-bottom: 1px solid var(--hairline-soft);
    background: #fff;
    padding: 0.45rem;
  }
  .review-mobile-tabs button {
    min-width: 0;
    min-height: 34px;
    border: 1px solid var(--hairline-soft);
    border-radius: 6px;
    background: #fff;
    color: var(--slate);
    font-size: 0.72rem;
  }
  .review-mobile-tabs button[aria-selected="true"] {
    border-color: var(--ink);
    background: var(--ink);
    color: #fff;
  }
  .review-triptych {
    height: min(68vh, 660px);
    display: block;
    background: #fff;
  }
  .review-source-pane {
    height: 100%;
    display: none !important;
  }
  .review-source-pane.mobile-active {
    display: grid !important;
  }
  .review-llm-head,
  .review-llm-source-pair,
  .review-llm-replacement {
    grid-template-columns: 1fr;
  }
  .review-llm-head {
    display: grid;
  }
  .review-llm-meta {
    flex-wrap: wrap;
  }
}

@media (max-width: 560px) {
  .review-workspace-head,
  .review-question-line {
    align-items: start;
  }
  .review-workspace-head {
    flex-wrap: wrap;
  }
  .review-head-actions {
    width: 100%;
    justify-content: space-between;
  }
  .review-batch-action {
    min-width: 0;
    flex: 1 1 auto;
  }
  .review-batch-summary {
    align-items: start;
    flex-direction: column;
  }
  .review-batch-failures li {
    grid-template-columns: 1fr;
    gap: 0.15rem;
  }
  .review-question-line {
    display: grid;
  }
  .review-triptych {
    height: 62vh;
    min-height: 430px;
  }
  .review-decision-bar {
    position: sticky;
    bottom: 0;
    z-index: 3;
  }
  .review-actions button {
    flex: 1 1 calc(50% - 0.35rem);
  }
  .review-llm-difference-head,
  .review-llm-source-pair > div {
    grid-template-columns: 1fr;
  }
}
</style>
