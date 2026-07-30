<script setup lang="ts">
import { Check, RefreshCw, X, XCircle } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type {
  BuildIntentMode,
  BuildIntentSelection,
  BuildPlanV1,
  BuildPlanV2,
  IntentArtifactType,
} from "../api";

const props = defineProps<{
  selection: BuildIntentSelection | null;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "draft", payload: { mode: BuildIntentMode; user_goal?: string; edit_plan_id?: string }): void;
  (e: "confirm", payload: { plan_id: string; plan_digest: string }): void;
  (e: "reject", payload: { plan_id: string }): void;
}>();

const mode = ref<BuildIntentMode>(props.selection?.mode ?? "read_now");
const goal = ref(props.selection?.intent?.user_goal ?? "");

watch(
  () => props.selection?.plan?.plan_digest ?? `${props.selection?.mode ?? "none"}:none`,
  () => {
    if (!props.selection) return;
    mode.value = props.selection.mode;
    goal.value = props.selection.intent?.user_goal ?? "";
  },
);

const modeOptions: Array<{ id: BuildIntentMode; label: string }> = [
  { id: "read_now", label: "先阅读" },
  { id: "standard_deep", label: "标准深读" },
  { id: "goal_directed", label: "围绕目标" },
];

const artifactLabels: Record<IntentArtifactType, string> = {
  timeline: "时间线",
  concept_map: "概念图",
  comparison_table: "比较表",
  argument_map: "论证图",
};

const buildItemLabels: Record<string, string> = {
  "public.foundation": "当前阅读基础",
  "public.pass1": "段落理解",
  "public.profile_sidecar": "阅读视角",
  "public.pass2": "跨章节关联",
  "public.book_structure": "全书结构",
  "public.paper_metadata": "论文信息",
  "public.paper_lexicon": "术语索引",
  "public.paper_reading_guide": "论文阅读路径",
  "private.timeline": "时间线",
  "private.concept_map": "概念图",
  "private.comparison_table": "比较表",
  "private.argument_map": "论证图",
};

const plan = computed(() => props.selection?.plan ?? null);
const selectionDirty = computed(() => {
  if (!props.selection) return false;
  if (props.selection.mode !== mode.value) return true;
  if (mode.value === "goal_directed") {
    return goal.value.trim() !== (props.selection.intent?.user_goal ?? "").trim();
  }
  return false;
});
const currentPlan = computed(() => selectionDirty.value ? null : plan.value);
const canDraft = computed(() => mode.value !== "goal_directed" || goal.value.trim().length > 0);
const canConfirm = computed(() => Boolean(
  currentPlan.value
  && currentPlan.value.status === "draft"
  && !props.busy,
));

const scopeText = computed(() => {
  const scope = props.selection?.intent?.source_scope
    ?? currentPlan.value?.private_artifacts[0]?.source_scope;
  if (!scope || scope.whole_book) return "全书";
  const parts: string[] = [];
  if (scope.lids.length) parts.push(`${scope.lids.length} 个位置`);
  if (scope.sections.length) parts.push(`${scope.sections.length} 个章节`);
  return parts.join("，") || "当前范围";
});

function friendlyBuildItem(value: string): string {
  if (value.startsWith("private.artifact-")) return "目标产物";
  return buildItemLabels[value] ?? "其他阅读产物";
}

function artifactLabel(value: IntentArtifactType): string {
  return artifactLabels[value];
}

type PlanArtifact = BuildPlanV1["private_artifacts"][number] | BuildPlanV2["private_artifacts"][number];

function isBlueprintArtifact(artifact: PlanArtifact): artifact is BuildPlanV2["private_artifacts"][number] {
  return "blueprint" in artifact;
}

function artifactTitle(artifact: PlanArtifact): string {
  return isBlueprintArtifact(artifact) ? artifact.blueprint.title : artifactLabel(artifact.artifact_type);
}

function artifactPurpose(artifact: PlanArtifact): string {
  return isBlueprintArtifact(artifact) ? artifact.blueprint.purpose : "按已确认目标生成的证据型阅读产物。";
}

function artifactShape(artifact: PlanArtifact): string {
  if (!isBlueprintArtifact(artifact)) return "内置结构";
  const labels: Record<BuildPlanV2["private_artifacts"][number]["blueprint"]["shape"], string> = {
    collection: "集合",
    table: "表格",
    graph: "关系图",
    sequence: "序列",
    document: "文档",
  };
  return labels[artifact.blueprint.shape];
}

function artifactFields(artifact: PlanArtifact): string {
  if (!isBlueprintArtifact(artifact)) return "由内置合同定义";
  return Object.keys(artifact.blueprint.record_schema.properties).join("、") || "无正文栏位";
}

function artifactOrigin(artifact: PlanArtifact): string {
  if (!isBlueprintArtifact(artifact)) return "系统预设（V1 适配）";
  return {
    system: "系统预设",
    user_private: "私有复用",
    one_off: "本次设计",
  }[artifact.blueprint.origin];
}

function artifactCost(artifact: PlanArtifact): string {
  if (!isBlueprintArtifact(artifact)) return "计入方案总预算";
  const { max_records, max_relations, max_text_chars } = artifact.blueprint.limits;
  const relationText = max_relations ? `，最多 ${numberText(max_relations)} 条关系` : "";
  return `最多 ${numberText(max_records)} 条记录${relationText}，正文 ${numberText(max_text_chars)} 字符`;
}

function numberText(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function tokenText(estimate: BuildPlanV1["estimate"] | BuildPlanV2["estimate"]): string {
  const lower = estimate.input_tokens.lower + estimate.output_tokens.lower;
  const upper = estimate.input_tokens.upper + estimate.output_tokens.upper;
  return lower === upper ? numberText(lower) : `${numberText(lower)}–${numberText(upper)}`;
}

function wallText(estimate: BuildPlanV1["estimate"] | BuildPlanV2["estimate"]): string {
  const { p50, p95, confidence } = estimate.wall_clock_minutes;
  if (confidence === "none" || p50 === undefined) return "暂无可靠历史";
  if (p95 === undefined || p95 === p50) return `约 ${numberText(p50)} 分钟`;
  return `约 ${numberText(p50)}–${numberText(p95)} 分钟`;
}

function draft() {
  if (!canDraft.value || props.busy) return;
  const payload: { mode: BuildIntentMode; user_goal?: string; edit_plan_id?: string } = {
    mode: mode.value,
  };
  if (mode.value === "goal_directed") {
    payload.user_goal = goal.value.trim();
    if (props.selection?.mode === "goal_directed" && props.selection.plan?.plan_id) {
      payload.edit_plan_id = props.selection.plan.plan_id;
    }
  }
  emit("draft", payload);
}

function confirm() {
  if (!canConfirm.value || !currentPlan.value) return;
  emit("confirm", {
    plan_id: currentPlan.value.plan_id,
    plan_digest: currentPlan.value.plan_digest,
  });
}

function reject() {
  if (!plan.value || props.busy) return;
  emit("reject", { plan_id: plan.value.plan_id });
}
</script>

<template>
  <aside class="build-intent-pane" role="complementary" aria-label="构建方案">
    <header class="pane-head">
      <div>
        <p>阅读准备</p>
        <h2>构建方案</h2>
      </div>
      <button data-action="close" class="icon-button" title="关闭构建方案" aria-label="关闭构建方案" @click="emit('close')">
        <X :size="18" aria-hidden="true" />
      </button>
    </header>

    <div class="pane-scroll">
      <div class="mode-control" role="group" aria-label="阅读方式">
        <button
          v-for="option in modeOptions"
          :key="option.id"
          :data-mode="option.id"
          :class="{ active: mode === option.id }"
          :aria-pressed="mode === option.id"
          :disabled="props.busy"
          @click="mode = option.id"
        >{{ option.label }}</button>
      </div>

      <label v-if="mode === 'goal_directed'" class="goal-field">
        <span>阅读目标</span>
        <textarea v-model="goal" rows="4" :disabled="props.busy" placeholder="例如：比较两种方法，并整理可引用的差异" />
      </label>

      <p v-if="props.error" class="pane-error">{{ props.error }}</p>
      <p v-if="selectionDirty" class="pane-notice">设置已变更，确认前需更新方案。</p>

      <button
        data-action="draft"
        class="draft-button"
        :disabled="props.busy || !canDraft"
        @click="draft"
      >
        <RefreshCw :size="16" aria-hidden="true" />
        <span v-if="props.busy">处理中</span>
        <span v-else-if="mode === 'read_now'">采用先阅读</span>
        <span v-else-if="selectionDirty">更新方案</span>
        <span v-else>预览方案</span>
      </button>

      <section v-if="props.selection?.mode === 'read_now' && !selectionDirty" class="plan-section read-now-state">
        <strong>可以直接开始阅读</strong>
        <span>当前不创建额外产物。</span>
      </section>

      <template v-if="currentPlan">
        <section class="plan-section estimate-section">
          <div class="section-heading">
            <h3>预计投入</h3>
            <span :data-status="currentPlan.status">{{ currentPlan.status === "confirmed" ? "已确认" : "待确认" }}</span>
          </div>
          <dl class="estimate-grid">
            <div>
              <dt>Token</dt>
              <dd>{{ tokenText(currentPlan.estimate) }}</dd>
            </div>
            <div>
              <dt>时间</dt>
              <dd>{{ wallText(currentPlan.estimate) }}</dd>
            </div>
            <div>
              <dt>范围</dt>
              <dd>{{ scopeText }}</dd>
            </div>
            <div>
              <dt>估计完整度</dt>
              <dd>{{ Math.round(Math.min(currentPlan.estimate.input_tokens.coverage, currentPlan.estimate.output_tokens.coverage) * 100) }}%</dd>
            </div>
          </dl>
          <p v-if="currentPlan.estimate.unknown_stages.length" class="unknown-estimate">
            {{ currentPlan.estimate.unknown_stages.length }} 项暂无历史样本
          </p>
        </section>

        <section v-if="currentPlan.private_artifacts.length" class="plan-section">
          <h3>目标产物</h3>
          <ul class="plan-list artifact-list">
            <li
              v-for="artifact in currentPlan.private_artifacts"
              :key="artifact.artifact_id"
              class="artifact-row"
              :title="artifact.artifact_id"
            >
              <div class="artifact-heading">
                <strong>{{ artifactTitle(artifact) }}</strong>
                <span>{{ artifact.source_scope.whole_book ? "全书" : scopeText }}</span>
              </div>
              <p>{{ artifactPurpose(artifact) }}</p>
              <dl class="artifact-contract">
                <div><dt>形态</dt><dd>{{ artifactShape(artifact) }}</dd></div>
                <div><dt>关键字段</dt><dd>{{ artifactFields(artifact) }}</dd></div>
                <div><dt>来源</dt><dd>{{ artifactOrigin(artifact) }}</dd></div>
                <div><dt>成本上限</dt><dd>{{ artifactCost(artifact) }}</dd></div>
              </dl>
            </li>
          </ul>
        </section>

        <section class="plan-section change-section">
          <div>
            <h3>沿用</h3>
            <ul class="plan-list compact">
              <li v-for="item in currentPlan.reuse" :key="item.artifact">{{ friendlyBuildItem(item.artifact) }}</li>
              <li v-if="!currentPlan.reuse.length">无</li>
            </ul>
          </div>
          <div>
            <h3>新建</h3>
            <ul class="plan-list compact">
              <li v-for="item in currentPlan.create" :key="item">{{ friendlyBuildItem(item) }}</li>
              <li v-if="!currentPlan.create.length">无</li>
            </ul>
          </div>
          <div>
            <h3>不包含</h3>
            <ul class="plan-list compact">
              <li v-for="item in currentPlan.excluded" :key="item.artifact">{{ friendlyBuildItem(item.artifact) }}</li>
              <li v-if="!currentPlan.excluded.length">无</li>
            </ul>
          </div>
        </section>
      </template>
    </div>

    <footer v-if="plan" class="pane-actions">
      <button
        v-if="plan.status === 'draft'"
        data-action="reject"
        class="secondary-action"
        :disabled="props.busy"
        @click="reject"
      >
        <XCircle :size="16" aria-hidden="true" />
        <span>放弃方案</span>
      </button>
      <button
        v-if="plan.status === 'draft'"
        data-action="confirm"
        class="confirm-button"
        :disabled="!canConfirm"
        @click="confirm"
      >
        <Check :size="16" aria-hidden="true" />
        <span>{{ props.busy ? "确认中" : "确认并准备" }}</span>
      </button>
      <p v-else class="confirmed-state"><Check :size="16" aria-hidden="true" />方案已确认</p>
    </footer>
  </aside>
</template>

<style scoped>
.build-intent-pane {
  position: fixed;
  z-index: 35;
  top: 64px;
  right: 12px;
  bottom: 12px;
  width: min(26rem, calc(100vw - 24px));
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: rgba(255, 253, 248, 0.98);
  box-shadow: 0 18px 50px rgba(20, 20, 19, 0.15);
}
.pane-head,
.section-heading,
.pane-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.pane-head {
  flex: 0 0 auto;
  padding: 0.8rem 0.9rem;
  border-bottom: 1px solid var(--hairline-soft);
}
.pane-head p {
  margin: 0 0 0.12rem;
  color: var(--steel);
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
}
.pane-head h2,
.plan-section h3 {
  margin: 0;
  color: var(--ink);
}
.pane-head h2 {
  font-size: 1rem;
}
.icon-button {
  width: 36px;
  min-width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  padding: 0;
}
.pane-scroll {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.9rem;
}
.mode-control {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 6px;
}
.mode-control button {
  min-width: 0;
  min-height: 38px;
  border: 0;
  border-radius: 0;
  padding: 0.35rem 0.3rem;
  background: var(--reader-card);
  color: var(--steel);
  font-size: 0.78rem;
  white-space: normal;
}
.mode-control button + button {
  border-left: 1px solid var(--hairline);
}
.mode-control button.active {
  background: var(--ink);
  color: #fff;
}
.goal-field {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.85rem;
  color: var(--slate);
  font-size: 0.78rem;
  font-weight: 650;
}
.goal-field textarea {
  width: 100%;
  min-width: 0;
  resize: vertical;
  border-radius: 6px;
  line-height: 1.5;
}
.draft-button,
.confirm-button,
.secondary-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
}
.draft-button {
  width: 100%;
  margin-top: 0.8rem;
  border-radius: 6px;
}
.pane-error,
.pane-notice,
.unknown-estimate {
  margin: 0.7rem 0 0;
  font-size: 0.78rem;
  line-height: 1.45;
}
.pane-error {
  color: var(--brand-error);
}
.pane-notice,
.unknown-estimate {
  color: var(--steel);
}
.plan-section {
  min-width: 0;
  margin-top: 0.95rem;
  padding-top: 0.95rem;
  border-top: 1px solid var(--hairline-soft);
}
.plan-section h3 {
  font-size: 0.83rem;
}
.read-now-state {
  display: grid;
  gap: 0.2rem;
}
.read-now-state strong {
  font-size: 0.9rem;
}
.read-now-state span {
  color: var(--steel);
  font-size: 0.78rem;
}
.section-heading > span {
  flex: 0 0 auto;
  color: var(--steel);
  font-size: 0.72rem;
}
.section-heading > span[data-status="confirmed"] {
  color: #287760;
}
.estimate-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  margin: 0.7rem 0 0;
}
.estimate-grid div {
  min-width: 0;
}
.estimate-grid dt {
  color: var(--steel);
  font-size: 0.7rem;
}
.estimate-grid dd {
  margin: 0.14rem 0 0;
  color: var(--ink);
  font-size: 0.82rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.plan-list {
  list-style: none;
  display: grid;
  gap: 0.4rem;
  margin: 0.65rem 0 0;
  padding: 0;
}
.artifact-row {
  min-width: 0;
  padding: 0.48rem 0.55rem;
  border-left: 3px solid var(--reader-teal);
  background: var(--surface-soft);
  overflow-wrap: anywhere;
}
.artifact-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
}
.artifact-heading strong,
.artifact-heading span {
  min-width: 0;
  font-size: 0.78rem;
}
.artifact-heading span {
  color: var(--steel);
  text-align: right;
}
.artifact-row > p {
  margin: 0.35rem 0 0;
  color: var(--slate);
  font-size: 0.74rem;
  line-height: 1.4;
}
.artifact-contract {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.38rem 0.6rem;
  margin: 0.5rem 0 0;
}
.artifact-contract dt {
  color: var(--steel);
  font-size: 0.66rem;
}
.artifact-contract dd {
  margin: 0.12rem 0 0;
  color: var(--ink);
  font-size: 0.71rem;
  overflow-wrap: anywhere;
}
.change-section {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.7rem;
}
.change-section > div {
  min-width: 0;
}
.plan-list.compact {
  gap: 0.28rem;
}
.plan-list.compact li {
  color: var(--slate);
  font-size: 0.75rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.pane-actions {
  flex: 0 0 auto;
  padding: 0.75rem 0.9rem;
  border-top: 1px solid var(--hairline-soft);
  background: var(--reader-card);
}
.pane-actions button {
  min-width: 0;
  flex: 1 1 0;
  border-radius: 6px;
}
.confirm-button {
  border-color: var(--brand-green);
  background: var(--brand-green);
  color: var(--ink);
}
.confirmed-state {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  margin: 0;
  color: #287760;
  font-size: 0.82rem;
  font-weight: 650;
}

@media (max-width: 767px) {
  .build-intent-pane {
    top: auto;
    right: 8px;
    bottom: 8px;
    left: 8px;
    width: auto;
    max-height: min(68vh, 42rem);
  }
  .pane-scroll {
    padding: 0.75rem;
  }
  .change-section {
    grid-template-columns: 1fr;
  }
}
</style>
