<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ArrowLeftRight,
  Check,
  CircleOff,
  History,
  MapPin,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from "@lucide/vue";
import type {
  HistoricalBackfillJobRequest,
  HistoricalBackfillStartRequest,
  HistoricalBackfillStateView,
  ProfileGovernanceActionRequest,
  ProfileMemoryState,
} from "../api";
import {
  evidenceForFact,
  factSemanticKey,
  factsForScope,
  isActiveProfileFact,
  type ProfileEvidence,
  type ProfileFact,
  type ProfileScopeTab,
} from "../profile-memory";

type HistoricalBackfillJobView = HistoricalBackfillStateView["jobs"][number];

const props = withDefaults(defineProps<{
  state?: ProfileMemoryState | null;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  notice?: string | null;
  backfill?: HistoricalBackfillStateView | null;
  backfillLoading?: boolean;
  backfillBusy?: boolean;
  backfillError?: string | null;
  backfillNotice?: string | null;
}>(), {
  state: null,
  loading: false,
  busy: false,
  error: null,
  notice: null,
  backfill: null,
  backfillLoading: false,
  backfillBusy: false,
  backfillError: null,
  backfillNotice: null,
});

const emit = defineEmits<{
  (event: "refresh"): void;
  (event: "mutate", action: ProfileGovernanceActionRequest): void;
  (event: "confirm-sensitive"): void;
  (event: "goto", lid: string): void;
  (event: "backfill-start", request: HistoricalBackfillStartRequest): void;
  (event: "backfill-action", action: "cancel" | "retry" | "clear", request: HistoricalBackfillJobRequest): void;
}>();

const activeScope = ref<ProfileScopeTab>("book");
const editingFactId = ref<string | null>(null);
const editValue = ref("");
const selectedBackfillSessionId = ref("");
const backfillStartTurn = ref(1);
const backfillEndTurn = ref(1);

const activeFacts = computed(() => factsForScope(props.state, activeScope.value));
const historicalFacts = computed(() => factsForScope(props.state, activeScope.value, true)
  .filter((fact) => !isActiveProfileFact(fact)));
const pendingCandidates = computed(() => [...(props.state?.pending_candidates ?? [])]
  .sort((left, right) => left.payload_key.localeCompare(right.payload_key)
    || left.fact_id.localeCompare(right.fact_id)));
const collectionRules = computed(() => [...(props.state?.collection_rules ?? [])]
  .sort((left, right) => left.rule_id.localeCompare(right.rule_id)));
const scopeCounts = computed(() => ({
  book: factsForScope(props.state, "book").length,
  global: factsForScope(props.state, "global").length,
}));
const selectedBackfillSession = computed(() => props.backfill?.sessions
  .find((session) => session.session_id === selectedBackfillSessionId.value) ?? null);
const backfillJobs = computed(() => [...(props.backfill?.jobs ?? [])]
  .sort((left, right) => right.updated_at.localeCompare(left.updated_at)
    || right.job_id.localeCompare(left.job_id)));
const activeBackfillJobs = computed(() => backfillJobs.value
  .filter((job) => job.status === "queued" || job.status === "running").length);

watch(() => props.state?.current_book_id, () => {
  activeScope.value = "book";
  editingFactId.value = null;
});

watch(
  () => props.backfill?.sessions
    .map((session) => `${session.session_id}:${session.latest_user_turn_ordinal}`)
    .join("|") ?? "",
  () => {
    const sessions = props.backfill?.sessions ?? [];
    const previous = selectedBackfillSessionId.value;
    const selected = sessions.find((session) => session.session_id === previous) ?? sessions[0];
    selectedBackfillSessionId.value = selected?.session_id ?? "";
    if (!selected) {
      backfillStartTurn.value = 1;
      backfillEndTurn.value = 1;
      return;
    }
    if (previous !== selected.session_id) {
      backfillStartTurn.value = 1;
      backfillEndTurn.value = selected.latest_user_turn_ordinal;
      return;
    }
    backfillStartTurn.value = Math.min(
      Math.max(1, backfillStartTurn.value),
      selected.latest_user_turn_ordinal,
    );
    backfillEndTurn.value = Math.min(
      Math.max(backfillStartTurn.value, backfillEndTurn.value),
      selected.latest_user_turn_ordinal,
    );
  },
  { immediate: true },
);

function operationId(kind: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `profile-ui-${kind}-${random}`;
}

function payloadLabel(kind: string): string {
  return {
    background: "背景",
    capability: "能力",
    goal: "目标",
    explanation_preference: "讲解偏好",
    constraint: "约束",
    extension: "扩展",
  }[kind] ?? kind;
}

function sourceLabel(source: string): string {
  return {
    user_stated: "用户确认",
    agent_inferred: "系统推断",
    deterministic_behavior: "阅读活动",
  }[source] ?? source;
}

function statusLabel(status: string): string {
  return {
    confirmed: "已确认",
    provisional: "暂定",
    pending: "待确认",
    superseded: "已替代",
    expired: "已失效",
  }[status] ?? status;
}

function evidenceLabel(evidence: ProfileEvidence): string {
  if (evidence.kind === "turn") return `对话 ${evidence.turn_id ?? ""}`.trim();
  if (evidence.kind === "book_location") return `原文 ${evidence.lid ?? ""}`.trim();
  if (evidence.kind === "memory_record") return "用户原话";
  return "来源";
}

function factEvidence(fact: ProfileFact): ProfileEvidence[] {
  return evidenceForFact(props.state, fact.fact_id);
}

function startEdit(fact: ProfileFact) {
  editingFactId.value = fact.fact_id;
  editValue.value = fact.payload_value;
}

function cancelEdit() {
  editingFactId.value = null;
  editValue.value = "";
}

function saveEdit(fact: ProfileFact) {
  const value = editValue.value.trim();
  if (!value || value === fact.payload_value) {
    cancelEdit();
    return;
  }
  emit("mutate", {
    kind: "correct",
    operation_id: operationId("correct"),
    evidence_text: `User corrected profile fact ${fact.fact_id}`,
    fact_id: fact.fact_id,
    payload_value: value,
    valid_until: fact.valid_until,
  });
  cancelEdit();
}

function confirmCandidate(fact: ProfileFact) {
  emit("mutate", {
    kind: "confirm",
    operation_id: operationId("confirm"),
    fact_id: fact.fact_id,
  });
}

function rejectCandidate(fact: ProfileFact) {
  emit("mutate", {
    kind: "reject",
    operation_id: operationId("reject"),
    fact_id: fact.fact_id,
  });
}

function changeScope(fact: ProfileFact) {
  emit("mutate", {
    kind: "change_scope",
    operation_id: operationId("scope"),
    fact_id: fact.fact_id,
    scope_kind: fact.scope_kind === "global" ? "book" : "global",
  });
}

function stopCollecting(fact: ProfileFact) {
  emit("mutate", {
    kind: "add_collection_rule",
    operation_id: operationId("rule-add"),
    matcher: {
      payload_kind: fact.payload_kind,
      semantic_key: factSemanticKey(fact),
      scope_kind: fact.scope_kind,
      scope_value: fact.scope_value,
      applicability_kind: fact.applicability_kind,
      applicability_value: fact.applicability_value,
    },
  });
}

function removeRule(ruleId: string) {
  emit("mutate", {
    kind: "remove_collection_rule",
    operation_id: operationId("rule-remove"),
    rule_id: ruleId,
  });
}

function forgetFact(fact: ProfileFact) {
  if (!window.confirm("从画像中彻底忘记这条信息？相关纠正记录和证据也会删除。")) return;
  emit("mutate", {
    kind: "forget",
    operation_id: operationId("forget"),
    fact_id: fact.fact_id,
  });
}

function scopeLabel(scope: ProfileScopeTab): string {
  return scope === "book" ? "本书" : "全局";
}

function ruleScopeLabel(scopeKind: string | null, scopeValue: string | null): string {
  if (!scopeKind) return "所有范围";
  if (scopeKind === "global") return "全局";
  return scopeValue === props.state?.current_book_id ? "本书" : (scopeValue ?? "书籍");
}

function chooseBackfillSession(sessionId: string) {
  selectedBackfillSessionId.value = sessionId;
  const session = props.backfill?.sessions.find((item) => item.session_id === sessionId);
  backfillStartTurn.value = 1;
  backfillEndTurn.value = session?.latest_user_turn_ordinal ?? 1;
}

function startBackfill() {
  const session = selectedBackfillSession.value;
  if (!session) return;
  const start = Math.min(Math.max(1, backfillStartTurn.value), session.latest_user_turn_ordinal);
  const end = Math.min(Math.max(start, backfillEndTurn.value), session.latest_user_turn_ordinal);
  backfillStartTurn.value = start;
  backfillEndTurn.value = end;
  emit("backfill-start", {
    session_id: session.session_id,
    from_turn_exclusive: start - 1,
    to_turn_inclusive: end,
  });
}

function backfillStatusLabel(status: string): string {
  return {
    queued: "等待中",
    running: "处理中",
    retryable: "可重试",
    cancelled: "已中止",
    completed: "已完成",
  }[status] ?? status;
}

function backfillSessionTitle(job: HistoricalBackfillJobView): string {
  return props.backfill?.sessions.find((session) => session.session_id === job.session_id)?.title
    ?? job.session_id;
}

function mutateBackfill(action: "cancel" | "retry" | "clear", jobId: string) {
  emit("backfill-action", action, { job_id: jobId });
}
</script>

<template>
  <section class="profile-memory-panel" aria-label="读者画像">
    <header class="profile-panel-head">
      <div>
        <p class="profile-kicker">Reader profile</p>
        <h3>画像</h3>
      </div>
      <button
        class="profile-icon-button"
        type="button"
        title="刷新画像"
        aria-label="刷新画像"
        :disabled="props.loading || props.busy"
        @click="emit('refresh')"
      >
        <RefreshCw :size="16" :class="{ spinning: props.loading }" aria-hidden="true" />
      </button>
    </header>

    <div v-if="props.state" class="profile-status-row">
      <span class="profile-status" :data-status="props.state.status.profile_status">
        {{ props.state.status.profile_status === "current" ? "已同步" : "待刷新" }}
      </span>
      <span>版本 {{ props.state.status.document_revision }}</span>
      <span v-if="props.state.status.pending_review_jobs">
        后台整理 {{ props.state.status.pending_review_jobs }}
      </span>
    </div>

    <p v-if="props.error" class="profile-message error" role="alert">{{ props.error }}</p>
    <p v-else-if="props.notice" class="profile-message notice" role="status">{{ props.notice }}</p>
    <p
      v-if="props.state?.status.review_error"
      class="profile-message error"
      role="alert"
    >
      {{ props.state.status.review_error.message }}
    </p>

    <div v-if="props.state?.status.pending_sensitive_confirmation" class="sensitive-confirmation">
      <ShieldAlert :size="18" aria-hidden="true" />
      <strong>敏感画像等待确认</strong>
      <button type="button" :disabled="props.busy" @click="emit('confirm-sensitive')">
        <Check :size="15" aria-hidden="true" />
        确认本地保存
      </button>
    </div>

    <details class="profile-backfill">
      <summary>
        <span><History :size="15" aria-hidden="true" />历史会话回填</span>
        <small v-if="activeBackfillJobs">进行中 {{ activeBackfillJobs }}</small>
        <small v-else-if="backfillJobs.length">任务 {{ backfillJobs.length }}</small>
      </summary>

      <p v-if="props.backfillError" class="profile-message error" role="alert">
        {{ props.backfillError }}
      </p>
      <p v-else-if="props.backfillNotice" class="profile-message notice" role="status">
        {{ props.backfillNotice }}
      </p>

      <div v-if="props.backfillLoading && !props.backfill" class="profile-empty">正在读取历史会话...</div>
      <div v-else-if="!props.backfill?.sessions.length" class="profile-empty">暂无可回填的历史会话。</div>
      <form v-else class="backfill-form" @submit.prevent="startBackfill">
        <label class="backfill-session-field">
          <span>会话</span>
          <select
            :value="selectedBackfillSessionId"
            :disabled="props.backfillBusy"
            @change="chooseBackfillSession(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="session in props.backfill.sessions"
              :key="session.session_id"
              :value="session.session_id"
            >
              {{ session.title }} · {{ session.latest_user_turn_ordinal }} 回合
            </option>
          </select>
        </label>
        <div class="backfill-range">
          <label>
            <span>起始回合</span>
            <input
              v-model.number="backfillStartTurn"
              type="number"
              min="1"
              :max="selectedBackfillSession?.latest_user_turn_ordinal ?? 1"
              :disabled="props.backfillBusy"
            />
          </label>
          <label>
            <span>结束回合</span>
            <input
              v-model.number="backfillEndTurn"
              type="number"
              :min="backfillStartTurn"
              :max="selectedBackfillSession?.latest_user_turn_ordinal ?? 1"
              :disabled="props.backfillBusy"
            />
          </label>
        </div>
        <button
          type="submit"
          class="backfill-start-button"
          :disabled="props.backfillBusy || !selectedBackfillSession"
        >
          <RefreshCw v-if="props.backfillBusy" :size="15" class="spinning" aria-hidden="true" />
          <Play v-else :size="15" aria-hidden="true" />
          构建画像
        </button>
      </form>

      <ol v-if="backfillJobs.length" class="backfill-job-list">
        <li v-for="job in backfillJobs" :key="job.job_id" class="backfill-job">
          <div class="backfill-job-head">
            <div>
              <strong>{{ backfillSessionTitle(job) }}</strong>
              <span>回合 {{ job.from_turn_exclusive + 1 }}-{{ job.to_turn_inclusive }}</span>
            </div>
            <span class="backfill-status" :data-status="job.status">
              {{ backfillStatusLabel(job.status) }}
            </span>
          </div>
          <div class="backfill-progress-row">
            <progress :value="job.completed_turns" :max="Math.max(1, job.total_turns)"></progress>
            <span>{{ job.completed_turns }}/{{ job.total_turns }}</span>
          </div>
          <p v-if="job.candidate_fact_ids.length" class="backfill-candidates">
            待确认 {{ job.candidate_fact_ids.length }} 条
          </p>
          <p v-if="job.last_error" class="backfill-job-error" role="alert">
            {{ job.last_error.message }}
          </p>
          <div class="backfill-job-actions">
            <button
              v-if="job.status === 'queued' || job.status === 'running'"
              type="button"
              class="profile-icon-button"
              title="中止历史回填"
              aria-label="中止历史回填"
              :disabled="props.backfillBusy"
              @click="mutateBackfill('cancel', job.job_id)"
            ><Square :size="14" aria-hidden="true" /></button>
            <button
              v-if="job.status === 'retryable' || job.status === 'cancelled'"
              type="button"
              class="profile-icon-button"
              title="继续历史回填"
              aria-label="继续历史回填"
              :disabled="props.backfillBusy"
              @click="mutateBackfill('retry', job.job_id)"
            ><RotateCcw :size="15" aria-hidden="true" /></button>
            <button
              v-if="job.status !== 'queued' && job.status !== 'running'"
              type="button"
              class="profile-icon-button danger"
              title="清除回填任务与未确认候选"
              aria-label="清除回填任务与未确认候选"
              :disabled="props.backfillBusy"
              @click="mutateBackfill('clear', job.job_id)"
            ><Trash2 :size="15" aria-hidden="true" /></button>
          </div>
        </li>
      </ol>
    </details>

    <section v-if="pendingCandidates.length" class="pending-section">
      <div class="profile-section-head">
        <h4>待确认</h4>
        <span>{{ pendingCandidates.length }}</span>
      </div>
      <article v-for="fact in pendingCandidates" :key="fact.fact_id" class="pending-fact">
        <div class="fact-heading">
          <div>
            <small>
              <span v-if="fact.capture === 'historical_backfill'">历史回填 · </span>
              {{ payloadLabel(fact.payload_kind) }} · {{ fact.payload_key }}
            </small>
            <strong>{{ fact.payload_value }}</strong>
          </div>
          <span v-if="fact.scope_kind === 'global'" class="scope-chip">全局</span>
        </div>
        <details v-if="factEvidence(fact).length" class="fact-evidence">
          <summary>来源 {{ factEvidence(fact).length }}</summary>
          <ul>
            <li v-for="evidence in factEvidence(fact)" :key="evidence.evidence_id">
              <button
                v-if="evidence.kind === 'book_location' && evidence.lid"
                type="button"
                class="evidence-link"
                @click="emit('goto', evidence.lid)"
              >
                <MapPin :size="14" aria-hidden="true" />
                {{ evidenceLabel(evidence) }}
              </button>
              <span v-else>{{ evidenceLabel(evidence) }}</span>
              <blockquote v-if="evidence.text">{{ evidence.text }}</blockquote>
            </li>
          </ul>
        </details>
        <div class="pending-actions">
          <button type="button" :disabled="props.busy" @click="confirmCandidate(fact)">
            <Check :size="15" aria-hidden="true" />
            确认
          </button>
          <button type="button" class="secondary" :disabled="props.busy" @click="rejectCandidate(fact)">
            <X :size="15" aria-hidden="true" />
            忽略
          </button>
        </div>
      </article>
    </section>

    <div class="scope-tabs" role="tablist" aria-label="画像范围">
      <button
        v-for="scope in (['book', 'global'] as ProfileScopeTab[])"
        :key="scope"
        type="button"
        role="tab"
        :aria-selected="activeScope === scope"
        :class="{ active: activeScope === scope }"
        @click="activeScope = scope"
      >
        {{ scopeLabel(scope) }}
        <span>{{ scopeCounts[scope] }}</span>
      </button>
    </div>

    <div v-if="props.loading && !props.state" class="profile-empty">正在读取画像...</div>
    <div v-else-if="!activeFacts.length" class="profile-empty">
      {{ activeScope === "book" ? "本书暂无画像条目。" : "暂无全局画像条目。" }}
    </div>
    <div v-else class="fact-list">
      <article v-for="fact in activeFacts" :key="fact.fact_id" class="profile-fact-card">
        <div class="fact-heading">
          <div>
            <small>{{ payloadLabel(fact.payload_kind) }} · {{ fact.payload_key }}</small>
            <strong v-if="editingFactId !== fact.fact_id">{{ fact.payload_value }}</strong>
          </div>
          <span class="fact-status" :data-status="fact.status">{{ statusLabel(fact.status) }}</span>
        </div>

        <div v-if="editingFactId === fact.fact_id" class="fact-editor">
          <textarea v-model="editValue" rows="3" aria-label="画像内容" @keydown.ctrl.enter="saveEdit(fact)" />
          <div>
            <button type="button" :disabled="props.busy || !editValue.trim()" @click="saveEdit(fact)">
              <Save :size="15" aria-hidden="true" />
              保存
            </button>
            <button type="button" class="secondary" @click="cancelEdit">
              <X :size="15" aria-hidden="true" />
              取消
            </button>
          </div>
        </div>

        <div class="fact-meta">
          <span>{{ sourceLabel(fact.source) }}</span>
          <span v-if="fact.sensitivity === 'sensitive'" class="sensitive-chip">敏感</span>
          <span v-if="fact.applicability_kind !== 'any'">
            {{ fact.applicability_value ?? fact.applicability_kind }}
          </span>
        </div>

        <details v-if="factEvidence(fact).length" class="fact-evidence">
          <summary>来源 {{ factEvidence(fact).length }}</summary>
          <ul>
            <li v-for="evidence in factEvidence(fact)" :key="evidence.evidence_id">
              <button
                v-if="evidence.kind === 'book_location' && evidence.lid"
                type="button"
                class="evidence-link"
                @click="emit('goto', evidence.lid)"
              >
                <MapPin :size="14" aria-hidden="true" />
                {{ evidenceLabel(evidence) }}
              </button>
              <span v-else>{{ evidenceLabel(evidence) }}</span>
              <blockquote v-if="evidence.text">{{ evidence.text }}</blockquote>
            </li>
          </ul>
        </details>

        <div class="fact-actions">
          <button
            type="button"
            class="profile-icon-button"
            title="纠正"
            aria-label="纠正"
            :disabled="props.busy"
            @click="startEdit(fact)"
          ><Pencil :size="15" aria-hidden="true" /></button>
          <button
            type="button"
            class="profile-icon-button"
            :title="fact.scope_kind === 'global' ? '改为仅本书' : '改为全局'"
            :aria-label="fact.scope_kind === 'global' ? '改为仅本书' : '改为全局'"
            :disabled="props.busy"
            @click="changeScope(fact)"
          ><ArrowLeftRight :size="15" aria-hidden="true" /></button>
          <button
            type="button"
            class="profile-icon-button"
            title="不再自动收集同类信息"
            aria-label="不再自动收集同类信息"
            :disabled="props.busy"
            @click="stopCollecting(fact)"
          ><CircleOff :size="15" aria-hidden="true" /></button>
          <button
            type="button"
            class="profile-icon-button danger"
            title="忘记"
            aria-label="忘记"
            :disabled="props.busy"
            @click="forgetFact(fact)"
          ><Trash2 :size="15" aria-hidden="true" /></button>
        </div>
      </article>
    </div>

    <details v-if="historicalFacts.length" class="profile-history">
      <summary>历史记录 {{ historicalFacts.length }}</summary>
      <ul>
        <li v-for="fact in historicalFacts" :key="fact.fact_id">
          <span>{{ statusLabel(fact.status) }}</span>
          <strong>{{ fact.payload_key }}</strong>
          <p>{{ fact.payload_value }}</p>
        </li>
      </ul>
    </details>

    <details v-if="collectionRules.length" class="collection-rules">
      <summary>自动收集规则 {{ collectionRules.length }}</summary>
      <ul>
        <li v-for="rule in collectionRules" :key="rule.rule_id">
          <div>
            <strong>{{ rule.semantic_key ?? payloadLabel(rule.payload_kind) }}</strong>
            <span>{{ ruleScopeLabel(rule.scope_kind, rule.scope_value) }}</span>
          </div>
          <button
            type="button"
            class="profile-icon-button"
            title="移除规则"
            aria-label="移除规则"
            :disabled="props.busy"
            @click="removeRule(rule.rule_id)"
          ><X :size="15" aria-hidden="true" /></button>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.profile-memory-panel {
  height: 100%;
  overflow-y: auto;
  padding: 1rem;
  color: var(--ink);
}
.profile-panel-head,
.profile-section-head,
.fact-heading,
.profile-status-row,
.fact-meta,
.fact-actions,
.pending-actions,
.collection-rules li {
  display: flex;
  align-items: center;
}
.profile-panel-head,
.profile-section-head,
.fact-heading,
.collection-rules li {
  justify-content: space-between;
}
.profile-panel-head {
  gap: 0.75rem;
  margin-bottom: 0.65rem;
}
.profile-kicker {
  margin: 0 0 0.12rem;
  color: var(--steel);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}
.profile-panel-head h3,
.profile-section-head h4 {
  margin: 0;
}
.profile-panel-head h3 {
  font-size: 1rem;
}
.profile-icon-button {
  width: 34px;
  height: 34px;
  min-height: 34px;
  flex: 0 0 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  padding: 0;
}
.profile-icon-button.danger {
  color: var(--brand-error);
}
.spinning {
  animation: profile-spin 800ms linear infinite;
}
@keyframes profile-spin {
  to { transform: rotate(360deg); }
}
.profile-status-row {
  flex-wrap: wrap;
  gap: 0.35rem 0.65rem;
  margin-bottom: 0.8rem;
  color: var(--steel);
  font-size: 0.74rem;
  font-variant-numeric: tabular-nums;
}
.profile-status::before {
  content: "";
  width: 7px;
  height: 7px;
  display: inline-block;
  margin-right: 0.3rem;
  border-radius: 50%;
  background: var(--brand-tag);
}
.profile-status[data-status="stale"]::before {
  background: var(--reader-amber);
}
.profile-message {
  margin: 0 0 0.75rem;
  border-left: 3px solid var(--brand-tag);
  background: rgba(93, 184, 166, 0.09);
  padding: 0.55rem 0.65rem;
  font-size: 0.8rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.profile-message.error {
  border-left-color: var(--brand-error);
  background: rgba(198, 69, 69, 0.07);
  color: #9f2f2f;
}
.profile-backfill {
  margin-bottom: 1rem;
  border-block: 1px solid var(--hairline);
  padding: 0.7rem 0;
}
.profile-backfill > summary {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  color: var(--charcoal);
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 650;
  list-style-position: outside;
}
.profile-backfill > summary > span {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.profile-backfill > summary small {
  color: var(--steel);
  font-size: 0.68rem;
  font-weight: 500;
  white-space: nowrap;
}
.profile-backfill .profile-message {
  margin-top: 0.5rem;
}
.backfill-form {
  display: grid;
  gap: 0.55rem;
  margin-top: 0.65rem;
}
.backfill-form label {
  min-width: 0;
  display: grid;
  gap: 0.25rem;
}
.backfill-form label > span {
  color: var(--steel);
  font-size: 0.68rem;
  font-weight: 600;
}
.backfill-form select,
.backfill-form input {
  width: 100%;
  min-width: 0;
  height: 36px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--canvas);
  color: var(--ink);
  padding: 0.35rem 0.5rem;
  font: inherit;
  font-size: 0.76rem;
}
.backfill-range {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}
.backfill-start-button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border-color: var(--ink);
  border-radius: 6px;
  background: var(--ink);
  color: #fff;
  font-size: 0.76rem;
}
.backfill-job-list {
  margin: 0.7rem 0 0;
  padding: 0;
  list-style: none;
}
.backfill-job {
  position: relative;
  border-top: 1px solid var(--hairline-soft);
  padding: 0.65rem 74px 0.15rem 0;
}
.backfill-job-head {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}
.backfill-job-head > div {
  min-width: 0;
  display: grid;
  gap: 0.12rem;
}
.backfill-job-head strong {
  overflow: hidden;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.backfill-job-head div > span,
.backfill-candidates {
  color: var(--steel);
  font-size: 0.67rem;
}
.backfill-status {
  flex: 0 0 auto;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 0.1rem 0.35rem;
  color: var(--steel);
  font-size: 0.64rem;
  white-space: nowrap;
}
.backfill-status[data-status="running"],
.backfill-status[data-status="queued"] {
  border-color: rgba(93, 184, 166, 0.5);
  color: #286f63;
}
.backfill-status[data-status="retryable"] {
  border-color: rgba(198, 69, 69, 0.35);
  color: var(--brand-error);
}
.backfill-progress-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 38px;
  align-items: center;
  gap: 0.45rem;
  margin-top: 0.45rem;
  color: var(--steel);
  font-size: 0.66rem;
  font-variant-numeric: tabular-nums;
}
.backfill-progress-row progress {
  width: 100%;
  height: 6px;
  accent-color: var(--brand-tag);
}
.backfill-progress-row span {
  text-align: right;
}
.backfill-candidates,
.backfill-job-error {
  margin: 0.35rem 0 0;
}
.backfill-job-error {
  color: var(--brand-error);
  font-size: 0.68rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.backfill-job-actions {
  position: absolute;
  top: 0.55rem;
  right: 0;
  display: flex;
  gap: 0.3rem;
}
.backfill-job-actions .profile-icon-button {
  width: 30px;
  height: 30px;
  min-height: 30px;
  flex-basis: 30px;
}
.sensitive-confirmation {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.45rem 0.55rem;
  margin-bottom: 0.85rem;
  border: 1px solid rgba(212, 160, 23, 0.35);
  border-radius: 8px;
  background: rgba(255, 246, 215, 0.7);
  padding: 0.7rem;
}
.sensitive-confirmation strong {
  min-width: 0;
  font-size: 0.83rem;
}
.sensitive-confirmation button {
  grid-column: 1 / -1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
  border-radius: 6px;
}
.pending-section {
  margin-bottom: 1rem;
}
.profile-section-head {
  margin-bottom: 0.5rem;
}
.profile-section-head h4 {
  font-size: 0.84rem;
}
.profile-section-head > span,
.scope-tabs span {
  min-width: 1.35rem;
  border-radius: 999px;
  background: var(--surface);
  padding: 0.08rem 0.4rem;
  font-size: 0.7rem;
  text-align: center;
}
.pending-fact,
.profile-fact-card {
  min-width: 0;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--canvas);
  padding: 0.75rem;
}
.pending-fact + .pending-fact,
.profile-fact-card + .profile-fact-card {
  margin-top: 0.55rem;
}
.pending-fact {
  border-left: 3px solid var(--reader-amber);
}
.fact-heading {
  align-items: flex-start;
  gap: 0.65rem;
}
.fact-heading > div {
  min-width: 0;
}
.fact-heading small {
  display: block;
  margin-bottom: 0.18rem;
  color: var(--steel);
  font-size: 0.7rem;
  overflow-wrap: anywhere;
}
.fact-heading strong {
  display: block;
  color: var(--charcoal);
  font-size: 0.91rem;
  font-weight: 620;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.scope-chip,
.fact-status,
.sensitive-chip {
  flex: 0 0 auto;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 0.12rem 0.42rem;
  color: var(--steel);
  font-size: 0.65rem;
  white-space: nowrap;
}
.fact-status[data-status="provisional"] {
  border-color: rgba(212, 160, 23, 0.4);
  color: #805d0a;
}
.sensitive-chip {
  border-color: rgba(198, 69, 69, 0.24);
  color: var(--brand-error);
}
.pending-actions,
.fact-actions {
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.65rem;
}
.pending-actions button,
.fact-editor button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  min-height: 34px;
  border-radius: 6px;
  padding: 0.35rem 0.65rem;
  font-size: 0.76rem;
}
.pending-actions button:not(.secondary),
.fact-editor button:not(.secondary) {
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
}
.secondary {
  background: transparent;
}
.scope-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.25rem;
  margin-bottom: 0.7rem;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--surface-soft);
  padding: 0.2rem;
}
.scope-tabs button {
  min-width: 0;
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--steel);
  padding: 0.35rem 0.5rem;
  font-size: 0.78rem;
}
.scope-tabs button.active {
  background: var(--canvas);
  color: var(--ink);
  box-shadow: 0 1px 2px rgba(20, 20, 19, 0.08);
}
.fact-list {
  display: grid;
}
.profile-empty {
  padding: 1.25rem 0.4rem;
  color: var(--steel);
  font-size: 0.82rem;
  text-align: center;
}
.fact-meta {
  flex-wrap: wrap;
  gap: 0.35rem 0.6rem;
  margin-top: 0.5rem;
  color: var(--steel);
  font-size: 0.68rem;
}
.fact-actions {
  justify-content: flex-end;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.55rem;
}
.fact-editor {
  margin-top: 0.55rem;
}
.fact-editor textarea {
  width: 100%;
  resize: vertical;
  font-size: 0.84rem;
}
.fact-editor > div {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
  margin-top: 0.4rem;
}
.fact-evidence {
  margin-top: 0.55rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.45rem;
}
.fact-evidence summary,
.profile-history summary,
.collection-rules summary {
  color: var(--steel);
  cursor: pointer;
  font-size: 0.72rem;
  font-weight: 600;
}
.fact-evidence ul,
.profile-history ul,
.collection-rules ul {
  margin: 0.45rem 0 0;
  padding: 0;
  list-style: none;
}
.fact-evidence li {
  color: var(--steel);
  font-size: 0.74rem;
  overflow-wrap: anywhere;
}
.fact-evidence li + li {
  margin-top: 0.45rem;
}
.fact-evidence blockquote {
  margin: 0.25rem 0 0;
  border-left: 2px solid var(--hairline);
  padding-left: 0.5rem;
  color: var(--slate);
  white-space: pre-wrap;
}
.evidence-link {
  min-height: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  padding: 0;
  font-size: inherit;
}
.profile-history,
.collection-rules {
  margin-top: 0.8rem;
  border-top: 1px solid var(--hairline);
  padding-top: 0.65rem;
}
.profile-history li {
  padding: 0.45rem 0;
  color: var(--steel);
  font-size: 0.72rem;
}
.profile-history li + li,
.collection-rules li + li {
  border-top: 1px solid var(--hairline-soft);
}
.profile-history strong {
  margin-left: 0.4rem;
  color: var(--charcoal);
}
.profile-history p {
  margin: 0.18rem 0 0;
  color: var(--slate);
  overflow-wrap: anywhere;
}
.collection-rules li {
  gap: 0.6rem;
  padding: 0.5rem 0;
}
.collection-rules li > div {
  min-width: 0;
  display: grid;
  gap: 0.12rem;
}
.collection-rules strong {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.collection-rules span {
  color: var(--steel);
  font-size: 0.68rem;
}
@media (max-width: 420px) {
  .profile-memory-panel {
    padding: 0.85rem 0.75rem 1.25rem;
  }
  .fact-actions {
    justify-content: flex-start;
  }
  .profile-icon-button {
    width: 38px;
    height: 38px;
    min-height: 38px;
    flex-basis: 38px;
  }
  .backfill-job {
    padding-right: 88px;
  }
  .backfill-job-actions .profile-icon-button {
    width: 38px;
    height: 38px;
    min-height: 38px;
    flex-basis: 38px;
  }
}
</style>
