<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { BookOpen, ExternalLink, Undo2, X } from "@lucide/vue";
import { api } from "../api";
import type {
  AgentAnswerPart,
  AgentEffect,
  AgentQuestionQuoteView,
  AskQuote,
  FormulaSemantics,
  HistoricalBackfillJobRequest,
  HistoricalBackfillStartRequest,
  HistoricalBackfillStateView,
  IntentArtifactOverlayV1,
  MemoryRecord,
  OuterOutcome,
  ProfileGovernanceActionRequest,
  ProfileMemoryState,
  ProfileMemoryUpdate,
  ProfileUsageTrace,
  SourcePopupView,
  TraceStep,
} from "../api";
import type { PdfAnnotationLocation } from "../pdf-annotation-projection";
import { rangeToMarkdown } from "../selection";
import ProfileMemoryPanel from "./ProfileMemoryPanel.vue";
import QueryAuditPanel from "./QueryAuditPanel.vue";
import IntentArtifactPanel from "./IntentArtifactPanel.vue";

type ContextTab = "agent" | "artifacts" | "profile" | "trace" | "formula" | "notes";

type AskDraft = AskQuote;
type DisplayQuestionQuote = AskDraft | AgentQuestionQuoteView;
interface ChatTurn {
  turnId: string | null;
  user: string;
  outcome: OuterOutcome | null;
  pending: boolean;
  error?: string;
  questionAnchorLid: string | null;
  questionQuote: AgentQuestionQuoteView | null;
  questionSelection: AskDraft | null;
  effectLabels: string[];
}
interface ChatSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
  turns: ChatSessionTurnSummary[];
}
interface ChatSessionTurnSummary {
  user: string;
  question_source_label: string | null;
  question_quote: AgentQuestionQuoteView | null;
}

const props = defineProps<{
  chat: ChatTurn[];
  chatSessions: ChatSessionSummary[];
  activeChatSessionId: string;
  agentInput: string;
  sending: boolean;
  unquotedNotePlacementAvailable?: boolean;
  notePlacementSurface?: "markdown" | "pdf";
  noteSourceFingerprint?: string | null;
  showTrace: Record<string, boolean>;
  latestTrace: TraceStep[];
  selectedLid: string | null;
  selectedFormula: FormulaSemantics | null;
  contextNotes: MemoryRecord[];
  contextHighlights: MemoryRecord[];
  annotationLocation?: Record<string, PdfAnnotationLocation>;
  renderMarkdown: (source: string) => string;
  effLabel: (effect: AgentEffect) => string;
  effState: (turnIndex: number, effectIndex: number) => string | undefined;
  isGoto: (effect: AgentEffect) => boolean;
  showEffectPrimary: (effect: AgentEffect) => boolean;
  showEffectSecondary: (effect: AgentEffect) => boolean;
  effectPrimaryLabel: (effect: AgentEffect) => string;
  effectSecondaryLabel: (effect: AgentEffect) => string;
  gotoBack: (effect: AgentEffect) => string;
  askDraft: AskDraft | null;
  profileMemory?: ProfileMemoryState | null;
  profileMemoryLoading?: boolean;
  profileMemoryBusy?: boolean;
  profileMemoryError?: string | null;
  profileMemoryNotice?: string | null;
  profileBackfill?: HistoricalBackfillStateView | null;
  profileBackfillLoading?: boolean;
  profileBackfillBusy?: boolean;
  profileBackfillError?: string | null;
  profileBackfillNotice?: string | null;
  profileUpdateStates?: Record<string, string>;
  intentArtifacts?: IntentArtifactOverlayV1 | null;
  intentArtifactsLoading?: boolean;
  intentArtifactsError?: string | null;
}>();
const emit = defineEmits<{
  (e: "update:agentInput", value: string): void;
  (e: "send-agent"): void;
  (e: "new-chat"): void;
  (e: "select-chat", sessionId: string): void;
  (e: "delete-chat", sessionId: string): void;
  (e: "clear-ask"): void;
  (e: "toggle-trace", turnIndex: number): void;
  (e: "undo-effect", turnIndex: number, effectIndex: number, effect: AgentEffect): void;
  (e: "keep-effect", turnIndex: number, effectIndex: number, effect: AgentEffect): void;
  (e: "save-answer-selection", turn: ChatTurn, text: string): void;
  (e: "place-note", note: MemoryRecord): void;
  (e: "goto", lid: string): void;
  (e: "focus-source", source: { lid: string; quote: string | null }): void;
  (e: "refresh-profile"): void;
  (e: "mutate-profile", action: ProfileGovernanceActionRequest): void;
  (e: "confirm-sensitive-profile"): void;
  (e: "start-profile-backfill", request: HistoricalBackfillStartRequest): void;
  (e: "mutate-profile-backfill", action: "cancel" | "retry" | "clear", request: HistoricalBackfillJobRequest): void;
  (e: "undo-profile-update", turnIndex: number, updateIndex: number, update: ProfileMemoryUpdate): void;
  (e: "agent-source-opened"): void;
  (e: "refresh-artifacts"): void;
  (e: "open-artifacts"): void;
  (e: "artifact-cited", artifactId: string): void;
}>();

const activeTab = ref<ContextTab>("agent");
const historyOpen = ref(false);
const notesExpanded = ref(false);
const transcriptRef = ref<HTMLElement | null>(null);
const agentInputRef = ref<HTMLTextAreaElement | null>(null);
const tabs: { id: ContextTab; label: string }[] = [
  { id: "agent", label: "问答" },
  { id: "artifacts", label: "成果" },
  { id: "profile", label: "画像" },
  { id: "trace", label: "轨迹" },
  { id: "formula", label: "公式" },
  { id: "notes", label: "笔记" },
];
const noteCount = computed(() => props.contextNotes.length + props.contextHighlights.length);
const profileAttentionCount = computed(() => (
  (props.profileMemory?.pending_candidates.length ?? 0)
  + (props.profileMemory?.status.pending_sensitive_confirmation ? 1 : 0)
));
const artifactAcceptedCount = computed(() => (
  props.intentArtifacts?.artifacts.filter((artifact) => artifact.state === "accepted").length ?? 0
));
watch(() => props.askDraft, async (draft) => {
  if (!draft) return;
  activeTab.value = "agent";
  await nextTick();
  agentInputRef.value?.focus();
});

async function scrollTranscriptToBottom() {
  await nextTick();
  const el = transcriptRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}
watch(
  () => {
    const last = props.chat[props.chat.length - 1];
    return [
      props.chat.length,
      last?.pending ? 1 : 0,
      last?.outcome?.answer?.length ?? 0,
      props.askDraft ? 1 : 0,
    ].join(":");
  },
  () => { void scrollTranscriptToBottom(); },
  { flush: "post" },
);

const answerSelection = ref<{ x: number; y: number; text: string; turn: ChatTurn } | null>(null);

interface AgentSourcePopupState {
  turnId: string;
  sourceRefIds: string[];
  activeSourceRefId: string;
  sources: SourcePopupView[];
  loading: boolean;
  opening: boolean;
  error: string | null;
  left: number;
  top: number;
}

const agentSourcePopup = ref<AgentSourcePopupState | null>(null);
const agentSourcePopupRef = ref<HTMLElement | null>(null);
let sourceRequestSequence = 0;
let agentSourceAnchor: HTMLElement | null = null;
const SOURCE_POPUP_MARGIN = 12;
const SOURCE_POPUP_GAP = 8;
const SOURCE_POPUP_WIDTH = 420;
const SOURCE_POPUP_INITIAL_HEIGHT = 240;
const SOURCE_POPUP_BOTTOM_SHEET_MAX_WIDTH = 700;
const activeAgentSource = computed(() => {
  const popup = agentSourcePopup.value;
  return popup?.sources.find((source) => source.source_ref_id === popup.activeSourceRefId) ?? null;
});
const agentSourcePopupStyle = computed(() => {
  const popup = agentSourcePopup.value;
  return popup ? { left: `${popup.left}px`, top: `${popup.top}px` } : {};
});

function answerParts(outcome: OuterOutcome): AgentAnswerPart[] {
  return outcome.answer_view?.parts?.length
    ? outcome.answer_view.parts
    : outcome.answer
      ? [{ kind: "markdown", text: outcome.answer }]
      : [];
}

function incompleteNotice(outcome: OuterOutcome): string | null {
  if (!outcome.incomplete || !outcome.warning) return null;
  switch (outcome.warning) {
    case "CONTEXT_BUDGET_EXCEEDED":
      return "上下文不足";
    case "COMPACTION_FAILED":
      return "上下文整理失败，请重试";
    case "ACTIVE_CONTEXT_EXHAUSTED":
      return "当前内容超过模型可处理范围";
    case "TURN_LIMIT_EXCEEDED":
      return "本轮工具调用次数已达上限";
    default:
      return outcome.warning;
  }
}

function sourceButtonLabel(outcome: OuterOutcome, sourceRefIds: string[]): string {
  if (sourceRefIds.length !== 1) return `${sourceRefIds.length} 个来源`;
  return outcome.answer_view?.sources.find((source) => source.source_ref_id === sourceRefIds[0])?.label
    ?? "查看来源";
}

function markdownPartClass(parts: AgentAnswerPart[], index: number): Record<string, boolean> {
  return {
    "before-source": parts[index + 1]?.kind === "sources",
    "after-source": parts[index - 1]?.kind === "sources",
  };
}

function closeAgentSourcePopup() {
  sourceRequestSequence += 1;
  agentSourcePopup.value = null;
  agentSourceAnchor = null;
}

function clampToRange(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function positionAgentSourcePopup() {
  const popup = agentSourcePopup.value;
  const popupElement = agentSourcePopupRef.value;
  const anchor = agentSourceAnchor;
  if (!popup || !popupElement || !anchor || window.innerWidth <= SOURCE_POPUP_BOTTOM_SHEET_MAX_WIDTH) return;

  const anchorRect = anchor.getBoundingClientRect();
  const popupRect = popupElement.getBoundingClientRect();
  const popupWidth = popupRect.width || Math.min(SOURCE_POPUP_WIDTH, window.innerWidth - (SOURCE_POPUP_MARGIN * 2));
  const popupHeight = popupRect.height || SOURCE_POPUP_INITIAL_HEIGHT;
  const leftCandidate = anchorRect.left - SOURCE_POPUP_GAP - popupWidth;
  const rightCandidate = anchorRect.right + SOURCE_POPUP_GAP;
  const leftFits = leftCandidate >= SOURCE_POPUP_MARGIN;
  const rightFits = rightCandidate + popupWidth <= window.innerWidth - SOURCE_POPUP_MARGIN;

  let left: number;
  if (leftFits) {
    left = leftCandidate;
  } else if (rightFits) {
    left = rightCandidate;
  } else {
    const spaceOnLeft = anchorRect.left - SOURCE_POPUP_GAP - SOURCE_POPUP_MARGIN;
    const spaceOnRight = window.innerWidth - SOURCE_POPUP_MARGIN - anchorRect.right - SOURCE_POPUP_GAP;
    left = spaceOnLeft >= spaceOnRight ? leftCandidate : rightCandidate;
  }

  popup.left = clampToRange(
    left,
    SOURCE_POPUP_MARGIN,
    window.innerWidth - SOURCE_POPUP_MARGIN - popupWidth,
  );
  popup.top = clampToRange(
    anchorRect.top,
    SOURCE_POPUP_MARGIN,
    window.innerHeight - SOURCE_POPUP_MARGIN - popupHeight,
  );
}

async function refreshAgentSourcePopupPosition() {
  await nextTick();
  positionAgentSourcePopup();
}

function onAgentSourceViewportResize() {
  void refreshAgentSourcePopupPosition();
}

window.addEventListener("resize", onAgentSourceViewportResize);
onBeforeUnmount(() => window.removeEventListener("resize", onAgentSourceViewportResize));

async function openAgentSources(turn: ChatTurn, sourceRefIds: string[], event: MouseEvent) {
  if (!turn.turnId || sourceRefIds.length === 0) return;
  agentSourceAnchor = event.currentTarget as HTMLElement | null;
  const requestSequence = ++sourceRequestSequence;
  agentSourcePopup.value = {
    turnId: turn.turnId,
    sourceRefIds: [...sourceRefIds],
    activeSourceRefId: sourceRefIds[0],
    sources: [],
    loading: true,
    opening: false,
    error: null,
    left: SOURCE_POPUP_MARGIN,
    top: SOURCE_POPUP_MARGIN,
  };
  await refreshAgentSourcePopupPosition();
  try {
    const sources = await Promise.all(
      sourceRefIds.map((sourceRefId) => api.agentSourceResolve(turn.turnId!, sourceRefId)),
    );
    if (requestSequence !== sourceRequestSequence || !agentSourcePopup.value) return;
    agentSourcePopup.value.sources = sources;
    agentSourcePopup.value.loading = false;
    await refreshAgentSourcePopupPosition();
  } catch (error) {
    if (requestSequence !== sourceRequestSequence || !agentSourcePopup.value) return;
    agentSourcePopup.value.loading = false;
    agentSourcePopup.value.error = error instanceof Error ? error.message : String(error);
    await refreshAgentSourcePopupPosition();
  }
}

function selectAgentSource(sourceRefId: string) {
  if (agentSourcePopup.value?.sources.some((source) => source.source_ref_id === sourceRefId)) {
    agentSourcePopup.value.activeSourceRefId = sourceRefId;
    void refreshAgentSourcePopupPosition();
  }
}

async function openActiveAgentSourceInReader() {
  const popup = agentSourcePopup.value;
  const source = activeAgentSource.value;
  if (!popup || !source || source.stale || !source.can_open_in_reader || popup.opening) return;
  const requestSequence = sourceRequestSequence;
  popup.opening = true;
  popup.error = null;
  try {
    await api.agentSourceOpen(popup.turnId, source.source_ref_id);
    if (requestSequence !== sourceRequestSequence) return;
    closeAgentSourcePopup();
    emit("agent-source-opened");
  } catch (error) {
    if (requestSequence !== sourceRequestSequence || !agentSourcePopup.value) return;
    agentSourcePopup.value.opening = false;
    agentSourcePopup.value.error = error instanceof Error ? error.message : String(error);
  }
}

watch(() => props.activeChatSessionId, closeAgentSourcePopup);

function onAnswerMouseUp(turn: ChatTurn) {
  if (!turn.questionSelection && !props.unquotedNotePlacementAvailable) {
    answerSelection.value = null;
    return;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    answerSelection.value = null;
    return;
  }
  const range = sel.getRangeAt(0);
  const start = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : (range.startContainer as HTMLElement);
  const end = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : (range.endContainer as HTMLElement);
  const startAnswer = start?.closest?.(".ans-text");
  if (!startAnswer || startAnswer !== end?.closest?.(".ans-text")) {
    answerSelection.value = null;
    return;
  }
  const text = rangeToMarkdown(range);
  if (!text) {
    answerSelection.value = null;
    return;
  }
  const rect = range.getBoundingClientRect();
  const x = Math.min(Math.max(rect.left + rect.width / 2, 54), window.innerWidth - 54);
  const y = Math.max(46, rect.top);
  answerSelection.value = { x, y, text, turn };
}
function saveAnswerSelection(turn: ChatTurn) {
  const selected = answerSelection.value;
  if (!selected) return;
  emit("save-answer-selection", turn, selected.text);
  answerSelection.value = null;
  window.getSelection()?.removeAllRanges();
}
function compactText(value: string, max = 96): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
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
function askQuoteLabel(quote: DisplayQuestionQuote): string {
  if ("label" in quote) return quote.label;
  return quote.status === "partial" ? "部分定位引用" : "引用来源";
}
function annotationLocationLabel(record: MemoryRecord): string | null {
  const status = props.annotationLocation?.[record.mem_id];
  if (status === "exact") return "PDF 已定位";
  if (status === "partial") return "PDF 部分定位";
  if (status === "unmapped") return "PDF 未定位";
  return null;
}
function notePreviewMarkdown(note: MemoryRecord): string {
  const body = note.content.replace(/^>.*(\n>.*)*\n*/m, "").trim();
  return body || note.content.trim();
}
function noteSourceLid(note: MemoryRecord): string | null {
  if (note.selection_context) return note.anchor.lid ?? null;
  if (note.note_placement?.kind !== "lid_block"
    || note.note_placement.source_fingerprint !== props.noteSourceFingerprint
    || note.anchor.lid !== note.note_placement.lid) {
    return null;
  }
  return note.note_placement.lid;
}
function canFocusNoteSource(note: MemoryRecord): boolean {
  return noteSourceLid(note) !== null;
}
function noteSourceLabel(note: MemoryRecord): string {
  if (note.selection_context) return "引用来源";
  if (!note.note_placement) return "无法定位";
  if (note.note_placement.kind === "pdf_region") {
    return props.annotationLocation?.[note.mem_id] === "exact" ? "PDF 正文" : "无法定位";
  }
  if (note.note_placement.source_fingerprint !== props.noteSourceFingerprint) return "来源已变更";
  return note.anchor.lid === note.note_placement.lid ? "跳到来源" : "无法定位";
}
function notePlacementActionLabel(note: MemoryRecord): string | null {
  if (!props.unquotedNotePlacementAvailable || note.selection_context) return null;
  if (!note.note_placement) return "放置到正文";
  const surface = props.notePlacementSurface ?? "markdown";
  if ((surface === "markdown" && note.note_placement.kind !== "lid_block")
    || (surface === "pdf" && note.note_placement.kind !== "pdf_region")) return null;
  if (note.note_placement.source_fingerprint !== props.noteSourceFingerprint) return "重新放置";
  if (note.note_placement.kind === "pdf_region") {
    return props.annotationLocation?.[note.mem_id] === "exact" ? "移动" : "重新放置";
  }
  return "移动";
}
function isLongNote(note: MemoryRecord): boolean {
  return note.content.length > 360 || note.content.split("\n").length > 8;
}
function excerpt(rec: MemoryRecord): string {
  const c = rec.content.replace(/\s+/g, " ").trim();
  return c.length > 120 ? `${c.slice(0, 120)}…` : c;
}
function turnSourceLabel(turn: ChatSessionTurnSummary): string | null {
  return turn.question_source_label ?? turn.question_quote?.label ?? null;
}
function openHistorySession(sessionId: string) {
  if (!sessionId || sessionId === props.activeChatSessionId) return;
  emit("select-chat", sessionId);
  historyOpen.value = false;
}
function openHistorySessionFromCard(sessionId: string, event: MouseEvent | KeyboardEvent) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest("button,a,input,textarea,select")) return;
  if (event instanceof KeyboardEvent) event.preventDefault();
  openHistorySession(sessionId);
}
function deleteHistorySession(sessionId: string) {
  if (!sessionId) return;
  emit("delete-chat", sessionId);
}

function selectTab(tab: ContextTab) {
  activeTab.value = tab;
  if (tab === "profile") emit("refresh-profile");
  if (tab === "artifacts") emit("open-artifacts");
}

function memoryUpdateLabel(update: ProfileMemoryUpdate): string {
  return {
    remembered: "画像已记住",
    corrected: "画像已纠正",
    forgotten: "画像已忘记",
    needs_clarification: "画像需要澄清",
    needs_sensitive_confirmation: "敏感画像等待确认",
    sensitive_confirmation_cancelled: "敏感画像保存已取消",
    rejected: "画像更新未保存",
  }[update.kind];
}

function memoryUpdateKey(turnIndex: number, updateIndex: number): string {
  return `${turnIndex}:${updateIndex}`;
}

function canUndoMemoryUpdate(update: ProfileMemoryUpdate): boolean {
  return update.kind === "remembered" || update.kind === "corrected";
}

function hasProfileUsage(usage: ProfileUsageTrace): boolean {
  return usage.injected_fact_ids.length > 0
    || usage.claimed_used_fact_ids.length > 0
    || usage.influences.length > 0;
}

function influenceLabel(influence: ProfileUsageTrace["influences"][number]): string {
  return {
    retrieval_plan: "检索计划",
    explanation_depth: "讲解深度",
    terminology: "术语选择",
    example_choice: "示例选择",
    navigation: "阅读导航",
  }[influence];
}
</script>

<template>
  <aside class="right-rail">
    <div class="context-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: activeTab === tab.id }"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
        <span v-if="tab.id === 'profile' && profileAttentionCount" class="tab-badge">
          {{ profileAttentionCount }}
        </span>
        <span v-if="tab.id === 'artifacts' && artifactAcceptedCount" class="tab-badge">
          {{ artifactAcceptedCount }}
        </span>
      </button>
    </div>

    <section v-show="activeTab === 'agent'" class="tab-panel agent-panel">
      <div class="agent-head">
        <div>
          <p class="rail-kicker">阅读助手</p>
          <h3>问这本书</h3>
        </div>
        <div class="chat-actions">
          <button class="history-button" title="打开对话历史" @click="historyOpen = true">
            历史
            <span>{{ props.chatSessions.length }}</span>
          </button>
          <button class="new-chat" title="新对话" @click="emit('new-chat')">新建</button>
        </div>
      </div>

      <div ref="transcriptRef" class="transcript">
        <div v-for="(turn, ti) in props.chat" :key="ti" class="turn">
          <div v-if="turn.questionQuote" class="turn-quote">
            <div class="turn-quote-head">
              <span>{{ askQuoteLabel(turn.questionQuote) }}</span>
            </div>
            <blockquote>{{ turn.questionQuote.quote }}</blockquote>
          </div>
          <p class="u-msg">{{ turn.user }}</p>
          <p v-if="turn.pending" class="pending">正在思考...</p>
          <p v-else-if="turn.error" class="incomplete">{{ turn.error }}</p>

          <div v-else-if="turn.outcome" class="a-msg">
            <div v-if="answerParts(turn.outcome).length" class="ans-text md" @mouseup="onAnswerMouseUp(turn)">
              <template v-for="(part, pi) in answerParts(turn.outcome)" :key="pi">
                <div
                  v-if="part.kind === 'markdown'"
                  class="answer-markdown"
                  :class="markdownPartClass(answerParts(turn.outcome), pi)"
                  v-html="props.renderMarkdown(part.text)"
                ></div>
                <button
                  v-else
                  type="button"
                  class="agent-source-button"
                  :disabled="!turn.turnId"
                  @click.stop="openAgentSources(turn, part.source_ref_ids, $event)"
                >
                  <BookOpen :size="14" aria-hidden="true" />
                  <span>{{ sourceButtonLabel(turn.outcome, part.source_ref_ids) }}</span>
                </button>
              </template>
            </div>
            <p v-else class="ans-text">暂无回答。</p>
            <p v-if="incompleteNotice(turn.outcome)" class="incomplete">
              未完成: {{ incompleteNotice(turn.outcome) }}
            </p>

            <div v-if="turn.outcome.effects.length" class="proposals">
              <p class="prop-h">建议变更</p>
              <div v-for="(eff, ei) in turn.outcome.effects" :key="ei" class="proposal">
                <span class="prop-label">{{ turn.effectLabels?.[ei] ?? props.effLabel(eff) }}</span>
                <template v-if="props.effState(ti, ei)">
                  <span class="done">{{ props.effState(ti, ei) }}</span>
                </template>
                <template v-else>
                  <button v-if="props.isGoto(eff)" @click="emit('undo-effect', ti, ei, eff)">返回原位置</button>
                  <template v-else>
                    <button v-if="props.showEffectPrimary(eff)" @click="emit('keep-effect', ti, ei, eff)">
                      {{ props.effectPrimaryLabel(eff) }}
                    </button>
                    <button v-if="props.showEffectSecondary(eff)" class="undo" @click="emit('undo-effect', ti, ei, eff)">
                      {{ props.effectSecondaryLabel(eff) }}
                    </button>
                  </template>
                </template>
              </div>
            </div>

            <div v-if="turn.outcome.memory_updates.length" class="memory-update-list">
              <div
                v-for="(update, ui) in turn.outcome.memory_updates"
                :key="`${update.operation_id ?? update.kind}:${ui}`"
                class="memory-update-row"
              >
                <span>{{ memoryUpdateLabel(update) }}</span>
                <small v-if="update.message">{{ update.message }}</small>
                <em v-if="props.profileUpdateStates?.[memoryUpdateKey(ti, ui)]">
                  {{ props.profileUpdateStates[memoryUpdateKey(ti, ui)] }}
                </em>
                <button
                  v-else-if="canUndoMemoryUpdate(update)"
                  type="button"
                  title="撤销画像更新"
                  aria-label="撤销画像更新"
                  :disabled="props.profileMemoryBusy"
                  @click="emit('undo-profile-update', ti, ui, update)"
                >
                  <Undo2 :size="15" aria-hidden="true" />
                </button>
              </div>
            </div>

            <details v-if="hasProfileUsage(turn.outcome.profile_usage)" class="profile-usage">
              <summary>画像依据 · {{ turn.outcome.profile_usage.injected_fact_ids.length }}</summary>
              <p>快照版本 {{ turn.outcome.profile_usage.snapshot_revision }}</p>
              <p v-if="turn.outcome.profile_usage.influences.length">
                {{ turn.outcome.profile_usage.influences.map(influenceLabel).join(" · ") }}
              </p>
              <code v-if="turn.outcome.profile_usage.claimed_used_fact_ids.length">
                {{ turn.outcome.profile_usage.claimed_used_fact_ids.join(", ") }}
              </code>
            </details>

            <div v-if="turn.outcome.trace.length" class="trace">
              <button class="trace-toggle" @click="emit('toggle-trace', ti)">
                轨迹 ({{ turn.outcome.trace.length }}) {{ props.showTrace[ti] ? "▲" : "▼" }}
              </button>
              <ol v-if="props.showTrace[ti]">
                <li v-for="(t, i) in turn.outcome.trace" :key="i">
                  <code>{{ t.tool }}</code>
                  <span class="t-args">{{ t.args }}</span>
                  <span class="t-res">→ {{ t.result_digest }}</span>
                  <QueryAuditPanel v-if="t.query_audit" :audit="t.query_audit" />
                </li>
              </ol>
            </div>


          </div>
        </div>
        <p v-if="props.chat.length === 0" class="empty">可以在这里提问、查看工具轨迹，并把有用内容保存成笔记。</p>
      </div>

      <div class="agent-input">
        <div v-if="props.askDraft" class="ask-draft">
          <div class="ask-draft-head">
            <span>{{ askQuoteLabel(props.askDraft) }}</span>
            <button title="清除引用来源" aria-label="清除引用来源" @click="emit('clear-ask')">
              <X :size="14" aria-hidden="true" />
            </button>
          </div>
          <blockquote>{{ props.askDraft.quote }}</blockquote>
        </div>
        <textarea
          ref="agentInputRef"
          :value="props.agentInput"
          rows="3"
          :placeholder="props.askDraft ? '围绕引用来源提问...' : '从当前阅读位置提问...'"
          @input="emit('update:agentInput', ($event.target as HTMLTextAreaElement).value)"
          @keydown.ctrl.enter="emit('send-agent')"
        />
        <button :disabled="props.sending || !props.agentInput.trim()" @click="emit('send-agent')">
          {{ props.sending ? "..." : "发送" }}
        </button>
      </div>
    </section>

    <section v-show="activeTab === 'artifacts'" class="tab-panel artifact-panel">
      <IntentArtifactPanel
        :overlay="props.intentArtifacts"
        :loading="props.intentArtifactsLoading"
        :error="props.intentArtifactsError"
        @refresh="emit('refresh-artifacts')"
        @goto="emit('goto', $event)"
        @cite="emit('artifact-cited', $event)"
      />
    </section>

    <section v-show="activeTab === 'profile'" class="tab-panel profile-panel">
      <ProfileMemoryPanel
        :state="props.profileMemory"
        :loading="props.profileMemoryLoading"
        :busy="props.profileMemoryBusy"
        :error="props.profileMemoryError"
        :notice="props.profileMemoryNotice"
        :backfill="props.profileBackfill"
        :backfill-loading="props.profileBackfillLoading"
        :backfill-busy="props.profileBackfillBusy"
        :backfill-error="props.profileBackfillError"
        :backfill-notice="props.profileBackfillNotice"
        @refresh="emit('refresh-profile')"
        @mutate="emit('mutate-profile', $event)"
        @confirm-sensitive="emit('confirm-sensitive-profile')"
        @backfill-start="emit('start-profile-backfill', $event)"
        @backfill-action="(action, request) => emit('mutate-profile-backfill', action, request)"
        @goto="emit('goto', $event)"
      />
    </section>

    <section v-show="activeTab === 'trace'" class="tab-panel context-panel">
      <div class="panel-head">
        <p class="rail-kicker">最近工具轨迹</p>
        <h3>{{ props.latestTrace.length }} 步</h3>
      </div>
      <ol v-if="props.latestTrace.length" class="trace-list">
        <li v-for="(t, i) in props.latestTrace" :key="i" class="trace-card">
          <code>{{ t.tool }}</code>
          <p class="trace-args">{{ t.args }}</p>
          <p class="trace-result">{{ t.result_digest }}</p>
          <QueryAuditPanel v-if="t.query_audit" :audit="t.query_audit" />
        </li>
      </ol>
      <p v-else class="empty panel-empty">暂无工具轨迹。</p>
    </section>

    <section v-show="activeTab === 'formula'" class="tab-panel context-panel">
      <div class="panel-head">
        <p class="rail-kicker">公式剖面</p>
        <h3>{{ props.selectedFormula?.formula_lid ?? props.selectedLid ?? "未选择" }}</h3>
      </div>
      <div v-if="props.selectedFormula" class="formula-card">
        <p class="formula-meaning">{{ props.selectedFormula.composition.meaning }}</p>
        <div v-if="props.selectedFormula.parameters.length" class="context-block">
          <h4>参数</h4>
          <dl>
            <template v-for="p in props.selectedFormula.parameters" :key="p.symbol">
              <dt>{{ p.symbol }}<span v-if="p.label"> · {{ p.label }}</span></dt>
              <dd>
                {{ p.meaning }}
                <span v-if="p.unit"> · 单位: {{ p.unit }}</span>
                <span v-if="p.domain"> · 取值域: {{ p.domain }}</span>
              </dd>
            </template>
          </dl>
        </div>
        <div v-if="props.selectedFormula.context_links.length" class="context-block">
          <h4>上下文关系</h4>
          <ul>
            <li v-for="link in props.selectedFormula.context_links" :key="`${link.target_lid}:${link.relation}`">
              <strong>{{ link.relation }}</strong> {{ link.description }}
            </li>
          </ul>
        </div>
      </div>
      <p v-else class="empty panel-empty">在阅读区选择公式后查看预构建剖面。</p>
    </section>

    <section v-show="activeTab === 'notes'" class="tab-panel context-panel">
      <div class="panel-head">
        <p class="rail-kicker">全部笔记</p>
        <h3>{{ noteCount }} 条</h3>
        <div v-if="noteCount" class="note-fold-controls">
          <button @click="notesExpanded = true">展开</button>
          <button @click="notesExpanded = false">收起</button>
        </div>
      </div>
      <div v-if="noteCount" class="memory-list">
        <details
          v-for="note in props.contextNotes"
          :key="note.mem_id"
          class="memory-card note-memory-card"
          :data-mem-id="note.mem_id"
          :open="notesExpanded"
        >
          <summary class="memory-meta note-memory-summary">
            <span class="memory-kind-with-location">
              笔记
              <small v-if="annotationLocationLabel(note)" :data-location="props.annotationLocation?.[note.mem_id]">
                {{ annotationLocationLabel(note) }}
              </small>
            </span>
            <button
              v-if="canFocusNoteSource(note)"
              class="note-source-button"
              @click.prevent.stop="emit('focus-source', { lid: noteSourceLid(note)!, quote: leadingQuote(note.content) })"
            >
              {{ noteSourceLabel(note) }}
            </button>
            <code v-else>{{ noteSourceLabel(note) }}</code>
            <em>展开/收起</em>
            <div class="note-preview md" v-html="props.renderMarkdown(notePreviewMarkdown(note))"></div>
          </summary>
          <div class="md" v-html="props.renderMarkdown(note.content)"></div>
          <button
            v-if="notePlacementActionLabel(note)"
            type="button"
            class="note-placement-action"
            data-note-placement-action
            :data-mem-id="note.mem_id"
            @click="emit('place-note', note)"
          >
            {{ notePlacementActionLabel(note) }}
          </button>
        </details>
        <article v-for="hl in props.contextHighlights" :key="hl.mem_id" class="memory-card highlight-card">
          <div class="memory-meta">
            <span class="memory-kind-with-location">
              高亮
              <small v-if="annotationLocationLabel(hl)" :data-location="props.annotationLocation?.[hl.mem_id]">
                {{ annotationLocationLabel(hl) }}
              </small>
            </span>
            <code>{{ hl.anchor.lid }}</code>
          </div>
          <p>{{ excerpt(hl) }}</p>
        </article>
      </div>
      <p v-else class="empty panel-empty">暂无笔记或高亮。</p>
    </section>
    <Teleport to="body">
      <div
        v-if="answerSelection"
        class="answer-popover"
        :style="{ left: answerSelection.x + 'px', top: answerSelection.y - 40 + 'px' }"
      >
        <button @mousedown.prevent="saveAnswerSelection(answerSelection.turn)">记笔记</button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="historyOpen" class="history-backdrop" @click.self="historyOpen = false">
        <section class="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
          <header class="history-dialog-head">
            <div>
              <p class="rail-kicker">助手历史</p>
              <h3 id="history-title">对话历史</h3>
            </div>
            <button class="history-close" title="关闭历史" aria-label="关闭历史" @click="historyOpen = false">×</button>
          </header>
          <div class="history-list">
            <article
              v-for="session in props.chatSessions"
              :key="session.id"
              class="history-card"
              :class="{ active: session.id === props.activeChatSessionId }"
              :role="session.id === props.activeChatSessionId ? undefined : 'button'"
              :tabindex="session.id === props.activeChatSessionId ? -1 : 0"
              @click="openHistorySessionFromCard(session.id, $event)"
              @keydown.enter="openHistorySessionFromCard(session.id, $event)"
              @keydown.space="openHistorySessionFromCard(session.id, $event)"
            >
              <div class="history-card-head">
                <div>
                  <h4>{{ compactText(session.title, 72) }}</h4>
                  <p>{{ session.turn_count }} 个问题</p>
                </div>
                <span v-if="session.id === props.activeChatSessionId" class="active-badge">当前</span>
              </div>

              <ol v-if="session.turns.length" class="history-turns">
                <li v-for="(turn, i) in session.turns" :key="`${session.id}:${i}`">
                  <p class="history-question">{{ compactText(turn.user, 180) }}</p>
                  <div class="history-anchor-row">
                    <span>来源</span>
                    <span class="history-source-label">{{ turnSourceLabel(turn) ?? "无" }}</span>
                  </div>
                </li>
              </ol>
              <p v-else class="empty history-empty">暂无问题。</p>

              <div class="history-card-actions">
                <button
                  class="history-open"
                  :disabled="session.id === props.activeChatSessionId"
                  @click.stop="openHistorySession(session.id)"
                >
                  打开对话
                </button>
                <button class="history-delete" @click.stop="deleteHistorySession(session.id)">删除</button>
              </div>
            </article>
            <p v-if="props.chatSessions.length === 0" class="empty history-empty">暂无保存的对话历史。</p>
          </div>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="agentSourcePopup"
        class="agent-source-popup-layer"
        @mousedown.self="closeAgentSourcePopup"
      >
        <section
          ref="agentSourcePopupRef"
          class="agent-source-popup"
          :style="agentSourcePopupStyle"
          role="dialog"
          aria-label="回答来源"
        >
          <header class="source-popup-head">
            <div>
              <span class="source-popup-kicker">回答来源</span>
              <strong>{{ activeAgentSource?.label ?? "正在载入来源" }}</strong>
            </div>
            <button type="button" title="关闭来源" aria-label="关闭来源" @click="closeAgentSourcePopup">
              <X :size="16" aria-hidden="true" />
            </button>
          </header>

          <div v-if="agentSourcePopup.sources.length > 1" class="source-tabs" role="tablist" aria-label="来源列表">
            <button
              v-for="source in agentSourcePopup.sources"
              :key="source.source_ref_id"
              type="button"
              role="tab"
              :aria-selected="source.source_ref_id === agentSourcePopup.activeSourceRefId"
              :class="{ active: source.source_ref_id === agentSourcePopup.activeSourceRefId }"
              @click="selectAgentSource(source.source_ref_id)"
            >
              {{ source.label }}
            </button>
          </div>

          <div class="source-popup-body">
            <p v-if="agentSourcePopup.loading" class="source-loading">正在载入...</p>
            <p v-else-if="agentSourcePopup.error" class="source-error">{{ agentSourcePopup.error }}</p>
            <template v-else-if="activeAgentSource">
              <p v-if="activeAgentSource.stale" class="source-stale">该来源已失效，以下为回答生成时保存的内容。</p>
              <blockquote class="source-context">
                <span class="source-context-before">{{ activeAgentSource.context_before }}</span><mark class="source-highlight">{{ activeAgentSource.highlighted_quote }}</mark><span class="source-context-after">{{ activeAgentSource.context_after }}</span>
              </blockquote>
            </template>
          </div>

          <footer class="source-popup-actions">
            <button
              type="button"
              class="source-open-reader"
              :disabled="!activeAgentSource || activeAgentSource.stale || !activeAgentSource.can_open_in_reader || agentSourcePopup.opening"
              @click="openActiveAgentSourceInReader"
            >
              <ExternalLink :size="15" aria-hidden="true" />
              <span>{{ agentSourcePopup.opening ? "正在打开..." : "在正文中查看" }}</span>
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

  </aside>
</template>

<style scoped>
.right-rail {
  min-width: 0;
  border-left: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: saturate(160%) blur(18px);
  -webkit-backdrop-filter: saturate(160%) blur(18px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.context-tabs {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 0;
  padding: 0.75rem 0.75rem 0;
}
.tab {
  position: relative;
  min-height: 40px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--steel);
  background: transparent;
  padding: 0.55rem 0.25rem;
  font-size: 0.82rem;
  transition: color 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.tab-badge {
  position: absolute;
  top: 2px;
  right: 4px;
  min-width: 17px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--reader-amber);
  color: var(--ink);
  padding: 0 4px;
  font-size: 0.62rem;
  font-variant-numeric: tabular-nums;
}
.tab.active {
  color: var(--ink);
  border-bottom-color: var(--ink);
}
.tab-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.agent-panel {
  display: flex;
  flex-direction: column;
}
.context-panel {
  overflow-y: auto;
  padding: 1rem;
}
.agent-head,
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
}
.agent-head {
  padding: 1rem 1rem 0.7rem;
}
.profile-panel {
  overflow: hidden;
}
.artifact-panel {
  min-width: 0;
  overflow: hidden;
}
.chat-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 0.4rem;
}
.chat-actions button,
.history-card-actions button,
.history-goto {
  white-space: nowrap;
}
.history-button,
.new-chat,
.history-open {
  min-height: 40px;
  border: 1px solid var(--ink);
  border-radius: 999px;
  background: var(--ink);
  color: #fff;
  padding: 0.5rem 0.95rem;
  font-size: 0.82rem;
  font-weight: 600;
}
.history-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border-color: var(--hairline);
  background: var(--canvas);
  color: var(--ink);
}
.history-button span {
  min-width: 1.35rem;
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  color: var(--ink);
  background: var(--brand-green);
  font-size: 0.72rem;
  text-align: center;
}
.panel-head {
  margin-bottom: 0.8rem;
}
.note-fold-controls {
  flex: 0 0 auto;
  display: flex;
  gap: 0.35rem;
}
.note-fold-controls button {
  min-height: 32px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--canvas);
  color: var(--ink);
  font-size: 0.75rem;
}
.rail-kicker {
  margin: 0 0 0.15rem;
  color: var(--steel);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0;
}
.agent-head h3,
.panel-head h3 {
  margin: 0;
  font-size: 1rem;
}
.new-chat {
  flex: 0 0 auto;
}
.history-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 1.5rem;
  background: rgba(10, 10, 10, 0.28);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  pointer-events: auto;
}
.history-dialog {
  width: min(760px, calc(100vw - 2rem));
  max-height: min(78vh, 780px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: none;
  pointer-events: auto;
}
.history-dialog-head {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.1rem;
  border-bottom: 1px solid var(--hairline-soft);
}
.history-dialog-head h3 {
  margin: 0;
  font-size: 1.05rem;
}
.history-close {
  width: 44px;
  height: 44px;
  min-height: 44px;
  flex: 0 0 auto;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--canvas);
  color: var(--ink);
  padding: 0;
  font-size: 1.05rem;
  line-height: 1;
}
.history-list {
  min-height: 0;
  display: grid;
  gap: 0.75rem;
  overflow-y: auto;
  padding: 0.85rem;
  background: var(--canvas-parchment);
}
.history-card {
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: var(--canvas);
  padding: 0.9rem;
  cursor: pointer;
}
.history-card.active {
  border-color: var(--brand-green);
  box-shadow: inset 0 0 0 1px rgba(0, 212, 164, 0.18);
  cursor: default;
}
.history-card:not(.active):hover {
  border-color: var(--ink);
}
.history-card:focus-visible {
  outline: 2px solid var(--brand-green);
  outline-offset: 2px;
}
.history-card-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.65rem;
}
.history-card-head h4 {
  margin: 0 0 0.15rem;
  color: var(--ink);
  font-size: 0.95rem;
  font-weight: 650;
}
.history-card-head p {
  margin: 0;
  color: var(--steel);
  font-size: 0.78rem;
}
.active-badge {
  align-self: flex-start;
  border-radius: 999px;
  background: var(--brand-green);
  color: var(--ink);
  padding: 0.18rem 0.55rem;
  font-size: 0.72rem;
  font-weight: 650;
}
.history-turns {
  display: grid;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.history-turns li {
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.55rem;
}
.history-question {
  margin: 0 0 0.4rem;
  color: var(--charcoal);
  font-size: 0.88rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.history-anchor-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--steel);
  font-size: 0.76rem;
}
.history-source-label {
  color: var(--charcoal);
  font-weight: 600;
}
.history-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
  margin-top: 0.8rem;
}
.history-card-actions button:disabled {
  border-color: var(--hairline);
  background: var(--hairline);
  color: var(--muted);
}
.history-delete {
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--canvas);
  color: var(--brand-error);
  padding: 0.48rem 0.8rem;
  font-size: 0.82rem;
  font-weight: 600;
}
.history-empty {
  margin: 0;
}
.transcript {
  flex: 1;
  overflow-y: auto;
  overflow-wrap: anywhere;
  word-break: break-word;
  padding: 0 1rem 1rem;
}
.turn {
  margin-bottom: 1rem;
}
.turn-quote {
  margin: 0 0 0.45rem;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--canvas);
  padding: 0.55rem 0.65rem;
}
.turn-quote-head {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  color: var(--steel);
  font-size: 0.72rem;
  font-weight: 650;
  text-transform: uppercase;
}
.turn-quote-head code {
  margin-left: auto;
  font-family: var(--mono);
  text-transform: none;
}
.turn-quote blockquote {
  margin: 0;
  color: var(--slate);
  font-size: 0.84rem;
  max-height: 8rem;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
.u-msg {
  margin: 0 0 0.35rem;
  font-weight: 600;
}
.a-msg,
.trace-card,
.formula-card,
.memory-card {
  background: var(--canvas);
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  padding: 0.7rem 0.8rem;
}
.ans-text {
  line-height: 1.58;
}
.answer-markdown {
  display: contents;
}
.answer-markdown.before-source :deep(p:last-child),
.answer-markdown.after-source :deep(p:first-child) {
  display: inline;
}
.agent-source-button {
  min-height: 26px;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  margin: 0 0.2rem 0.15rem;
  border: 1px solid rgba(33, 112, 214, 0.32);
  border-radius: 6px;
  background: rgba(33, 112, 214, 0.08);
  color: #1764c0;
  padding: 0.18rem 0.42rem;
  vertical-align: baseline;
  font-size: 0.74rem;
  font-weight: 650;
  line-height: 1.25;
}
.agent-source-button:hover:not(:disabled) {
  border-color: #1764c0;
  background: rgba(33, 112, 214, 0.14);
}
.agent-source-button span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.pending,
.empty {
  color: var(--steel);
}
.panel-empty {
  margin-top: 1rem;
}
.incomplete {
  color: var(--brand-error);
}
.proposals {
  margin-top: 0.7rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.55rem;
}
.prop-h {
  margin: 0 0 0.35rem;
  color: var(--steel);
  font-size: 0.78rem;
}
.proposal {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.3rem 0;
  font-size: 0.86rem;
}
.prop-label {
  flex: 1;
}
.proposal button.undo {
  color: var(--brand-error);
}
.done {
  color: var(--brand-green-deep);
  font-size: 0.82rem;
}
.trace {
  margin-top: 0.6rem;
}
.trace-toggle {
  min-height: auto;
  border: 0;
  background: transparent;
  color: var(--ink);
  padding: 0;
  font-size: 0.82rem;
}
.trace ol,
.trace-list {
  margin: 0.35rem 0 0;
  padding-left: 1.2rem;
  color: var(--steel);
  font-size: 0.78rem;
}
.trace-list {
  display: grid;
  gap: 0.6rem;
  padding-left: 0;
  list-style: none;
}
.trace .t-args,
.trace .t-res,
.trace-args,
.trace-result {
  color: var(--stone);
}
.trace-card code,
.memory-meta code {
  font-family: var(--mono);
}
.trace-args,
.trace-result,
.memory-card p {
  overflow-wrap: anywhere;
}
.answer-popover {
  position: fixed;
  transform: translateX(-50%);
  z-index: 1100;
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 999px;
  background: var(--ink);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
}
.answer-popover button {
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #fff;
  padding: 0.28rem 0.65rem;
  font-size: 0.82rem;
}
.ask-draft {
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--canvas);
  padding: 0.65rem 0.75rem;
}
.memory-update-list {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.65rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.55rem;
}
.memory-update-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.12rem 0.45rem;
  border-left: 2px solid var(--brand-tag);
  padding: 0.22rem 0 0.22rem 0.5rem;
  color: var(--charcoal);
  font-size: 0.78rem;
}
.memory-update-row small {
  grid-column: 1 / -1;
  color: var(--steel);
  overflow-wrap: anywhere;
}
.memory-update-row em {
  color: var(--brand-green-deep);
  font-size: 0.72rem;
  font-style: normal;
}
.memory-update-row button {
  width: 30px;
  height: 30px;
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  padding: 0;
}
.profile-usage {
  margin-top: 0.55rem;
  color: var(--steel);
  font-size: 0.72rem;
}
.profile-usage summary {
  color: var(--ink);
  cursor: pointer;
  font-weight: 600;
}
.profile-usage p {
  margin: 0.3rem 0 0;
}
.profile-usage code {
  display: block;
  margin-top: 0.3rem;
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 0.68rem;
}
.ask-draft-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.45rem;
  color: var(--steel);
  font-size: 0.74rem;
  font-weight: 650;
  text-transform: uppercase;
}
.ask-draft-head code {
  margin-left: auto;
  font-family: var(--mono);
  text-transform: none;
}
.ask-draft-head button {
  margin-left: auto;
  width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
}
.agent-source-popup-layer {
  position: fixed;
  inset: 0;
  z-index: 1250;
}
.agent-source-popup {
  position: fixed;
  width: min(420px, calc(100vw - 24px));
  max-height: min(620px, calc(100vh - 24px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--canvas);
  box-shadow: 0 16px 44px rgba(20, 28, 38, 0.22);
}
.source-popup-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  border-bottom: 1px solid var(--hairline-soft);
  padding: 0.78rem 0.85rem;
}
.source-popup-head > div {
  min-width: 0;
  display: grid;
  gap: 0.16rem;
}
.source-popup-kicker {
  color: var(--steel);
  font-size: 0.7rem;
  font-weight: 650;
}
.source-popup-head strong {
  overflow-wrap: anywhere;
  color: var(--ink);
  font-size: 0.9rem;
}
.source-popup-head > button {
  width: 30px;
  height: 30px;
  min-height: 30px;
  flex: 0 0 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  padding: 0;
}
.source-tabs {
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--hairline-soft);
  padding: 0.55rem 0.85rem;
}
.source-tabs button {
  flex: 0 0 auto;
  min-height: 32px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--steel);
  padding: 0.32rem 0.58rem;
  font-size: 0.74rem;
}
.source-tabs button.active {
  border-color: #1764c0;
  background: rgba(33, 112, 214, 0.08);
  color: #1764c0;
}
.source-popup-body {
  min-height: 8rem;
  overflow-y: auto;
  padding: 0.9rem;
}
.source-loading,
.source-error,
.source-stale {
  margin: 0;
  font-size: 0.8rem;
}
.source-loading {
  color: var(--steel);
}
.source-error {
  color: var(--brand-error);
}
.source-stale {
  margin-bottom: 0.65rem;
  border-left: 3px solid var(--reader-amber);
  background: rgba(255, 193, 7, 0.1);
  color: var(--charcoal);
  padding: 0.48rem 0.58rem;
}
.source-context {
  margin: 0;
  color: var(--charcoal);
  font-size: 0.88rem;
  line-height: 1.72;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.source-highlight {
  border-radius: 3px;
  background: rgba(255, 210, 71, 0.48);
  color: inherit;
  padding: 0.06rem 0.08rem;
}
.source-popup-actions {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--hairline-soft);
  padding: 0.7rem 0.85rem;
}
.source-open-reader {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 0.38rem;
  border-color: #1764c0;
  border-radius: 6px;
  background: #1764c0;
  color: #fff;
  padding: 0.48rem 0.72rem;
  font-weight: 650;
}
.source-open-reader:disabled {
  border-color: var(--hairline);
  background: var(--hairline);
  color: var(--muted);
}

@media (max-width: 700px) {
  .agent-source-popup {
    inset: auto 0 0 !important;
    width: 100%;
    max-height: 78dvh;
    border-radius: 8px 8px 0 0;
  }
}
.ask-draft blockquote {
  margin: 0;
  color: var(--slate);
  font-size: 0.84rem;
  max-height: 6rem;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
.agent-input {
  border-top: 1px solid var(--hairline);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.agent-input textarea {
  width: 100%;
  resize: vertical;
}
.formula-meaning {
  margin: 0 0 0.75rem;
  font-weight: 600;
}
.context-block {
  margin-top: 0.75rem;
}
.context-block h4 {
  margin: 0 0 0.35rem;
  font-size: 0.86rem;
}
.context-block dl {
  margin: 0;
}
.context-block dt {
  font-weight: 600;
}
.context-block dd {
  margin: 0 0 0.45rem 1rem;
  color: var(--slate);
}
.context-block ul {
  margin: 0;
  padding-left: 1.2rem;
}
.memory-list {
  display: grid;
  gap: 0.65rem;
}
.memory-meta {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
  color: var(--steel);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.note-memory-card[open] .note-preview {
  display: none;
}
.note-preview {
  grid-column: 1 / -1;
  margin: 0.45rem 0 0;
  color: var(--slate);
  font-size: 0.84rem;
  line-height: 1.45;
  max-height: 7.5rem;
  overflow: auto;
  text-transform: none;
}
.note-preview :deep(h1),
.note-preview :deep(h2),
.note-preview :deep(h3),
.note-preview :deep(h4),
.note-preview :deep(h5),
.note-preview :deep(h6) {
  margin: 0.35em 0 0.25em;
  font-size: 0.9rem;
  line-height: 1.25;
}
.note-preview :deep(table) {
  min-width: 100%;
  font-size: 0.78rem;
}
.note-preview :deep(th),
.note-preview :deep(td) {
  padding: 0.25em 0.35em;
}
.note-preview :deep(ul),
.note-preview :deep(ol) {
  padding-left: 1.25em;
}
.note-preview :deep(.katex-display) {
  margin: 0.35em 0;
}
.note-source-button {
  min-width: 0;
  flex: 1;
  border: 0;
  border-radius: 6px;
  padding: 0;
  color: var(--stone);
  background: transparent;
  font-family: var(--mono);
  font-size: 0.75rem;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
}
.note-source-button:hover {
  color: var(--ink);
}
.note-placement-action {
  width: 100%;
  min-height: 44px;
  margin-top: 0.65rem;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
}
.note-memory-summary {
  cursor: pointer;
  list-style: none;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.35rem 0.5rem;
}
.note-memory-summary::-webkit-details-marker {
  display: none;
}
.note-memory-summary code {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
}
.note-memory-summary em {
  color: var(--stone);
  font-style: normal;
  text-transform: uppercase;
}
.memory-kind-with-location {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}
.memory-kind-with-location small {
  padding: 0.08rem 0.28rem;
  border: 1px solid var(--hairline-soft);
  border-radius: 5px;
  color: var(--stone);
  font-size: 0.64rem;
  font-weight: 500;
  line-height: 1.2;
  text-transform: none;
  white-space: nowrap;
}
.memory-kind-with-location small[data-location="partial"],
.memory-kind-with-location small[data-location="unmapped"] {
  border-color: rgba(194, 132, 38, 0.28);
  color: #8a5a14;
  background: rgba(252, 239, 198, 0.42);
}
.highlight-card {
  background: #fffdf0;
}
</style>
