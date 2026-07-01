<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AgentEffect, FormulaSemantics, MemoryRecord, OuterOutcome, TraceStep } from "../api";

type ContextTab = "agent" | "trace" | "formula" | "notes";

interface AskDraft {
  lid: string;
  quote: string;
}
interface ChatTurn {
  user: string;
  outcome: OuterOutcome | null;
  pending: boolean;
  error?: string;
  questionAnchorLid: string | null;
  questionQuote: AskDraft | null;
}

const props = defineProps<{
  chat: ChatTurn[];
  agentInput: string;
  sending: boolean;
  showTrace: Record<string, boolean>;
  latestTrace: TraceStep[];
  selectedLid: string | null;
  selectedFormula: FormulaSemantics | null;
  contextNotes: MemoryRecord[];
  contextHighlights: MemoryRecord[];
  renderMarkdown: (source: string) => string;
  effLabel: (effect: AgentEffect) => string;
  effState: (turnIndex: number, effectIndex: number) => string | undefined;
  isGoto: (effect: AgentEffect) => boolean;
  gotoBack: (effect: AgentEffect) => string;
  askDraft: AskDraft | null;
}>();
const emit = defineEmits<{
  (e: "update:agentInput", value: string): void;
  (e: "send-agent"): void;
  (e: "new-chat"): void;
  (e: "clear-ask"): void;
  (e: "toggle-trace", turnIndex: number): void;
  (e: "undo-effect", turnIndex: number, effectIndex: number, effect: AgentEffect): void;
  (e: "keep-effect", turnIndex: number, effectIndex: number, effect: AgentEffect): void;
  (e: "save-answer-selection", turn: ChatTurn, text: string): void;
  (e: "goto", lid: string): void;
  (e: "focus-source", source: { lid: string; quote: string | null }): void;
}>();

const activeTab = ref<ContextTab>("agent");
const tabs: { id: ContextTab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "trace", label: "Trace" },
  { id: "formula", label: "Formula" },
  { id: "notes", label: "Notes" },
];
const noteCount = computed(() => props.contextNotes.length + props.contextHighlights.length);
watch(() => props.askDraft, (draft) => {
  if (draft) activeTab.value = "agent";
});

const answerSelection = ref<{ x: number; y: number; text: string; turn: ChatTurn } | null>(null);

function markdownTextFromRange(range: Range): string {
  const fragment = range.cloneContents();
  fragment.querySelectorAll<HTMLElement>(".katex").forEach((katexEl) => {
    const tex = katexEl.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (!tex) return;
    const display = !!katexEl.closest(".katex-display");
    const markdown = display ? `$$${tex}$$` : `$${tex}$`;
    katexEl.replaceWith(document.createTextNode(markdown));
  });
  return (fragment.textContent ?? "").replace(/\s+/g, " ").trim();
}
function onAnswerMouseUp(turn: ChatTurn) {
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
  const text = markdownTextFromRange(range);
  if (!text) {
    answerSelection.value = null;
    return;
  }
  const rect = range.getBoundingClientRect();
  answerSelection.value = { x: rect.left + rect.width / 2, y: rect.top, text, turn };
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
  return quoteLines.length ? compactText(quoteLines.join(" ")) : null;
}
function notePreview(note: MemoryRecord): string {
  return compactText(note.content.replace(/^>.*(\n>.*)*\n*/m, ""), 180);
}
function noteSourceLabel(note: MemoryRecord): string {
  const quote = leadingQuote(note.content);
  if (quote) return "Quote source";
  return note.anchor.lid ? "Go to source" : "No source";
}
function isLongNote(note: MemoryRecord): boolean {
  return note.content.length > 360 || note.content.split("\n").length > 8;
}
function excerpt(rec: MemoryRecord): string {
  const c = rec.content.replace(/\s+/g, " ").trim();
  return c.length > 120 ? `${c.slice(0, 120)}…` : c;
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
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <section v-show="activeTab === 'agent'" class="tab-panel agent-panel">
      <div class="agent-head">
        <div>
          <p class="rail-kicker">Reading agent</p>
          <h3>Ask this book</h3>
        </div>
        <button class="new-chat" @click="emit('new-chat')">New</button>
      </div>

      <div class="transcript">
        <div v-for="(turn, ti) in props.chat" :key="ti" class="turn">
          <div v-if="turn.questionQuote" class="turn-quote">
            <div class="turn-quote-head">
              <span>Quoted source</span>
              <code>{{ turn.questionQuote.lid }}</code>
            </div>
            <blockquote>{{ turn.questionQuote.quote }}</blockquote>
          </div>
          <p class="u-msg">{{ turn.user }}</p>
          <p v-if="turn.pending" class="pending">Agent is thinking…</p>
          <p v-else-if="turn.error" class="incomplete">{{ turn.error }}</p>

          <div v-else-if="turn.outcome" class="a-msg">
            <div v-if="turn.outcome.answer" class="ans-text md" @mouseup="onAnswerMouseUp(turn)" v-html="props.renderMarkdown(turn.outcome.answer)"></div>
            <p v-else class="ans-text">No answer.</p>
            <p v-if="turn.outcome.incomplete" class="incomplete">Incomplete: {{ turn.outcome.warning ?? "incomplete" }}</p>

            <div v-if="turn.outcome.effects.length" class="proposals">
              <p class="prop-h">Proposed changes</p>
              <div v-for="(eff, ei) in turn.outcome.effects" :key="ei" class="proposal">
                <span class="prop-label">{{ props.effLabel(eff) }}</span>
                <template v-if="props.effState(ti, ei)">
                  <span class="done">{{ props.effState(ti, ei) }}</span>
                </template>
                <template v-else>
                  <button v-if="props.isGoto(eff)" @click="emit('undo-effect', ti, ei, eff)">Back {{ props.gotoBack(eff) }}</button>
                  <template v-else>
                    <button @click="emit('keep-effect', ti, ei, eff)">Keep</button>
                    <button class="undo" @click="emit('undo-effect', ti, ei, eff)">Undo</button>
                  </template>
                </template>
              </div>
            </div>

            <div v-if="turn.outcome.trace.length" class="trace">
              <button class="trace-toggle" @click="emit('toggle-trace', ti)">
                Trace ({{ turn.outcome.trace.length }}) {{ props.showTrace[ti] ? "▲" : "▼" }}
              </button>
              <ol v-if="props.showTrace[ti]">
                <li v-for="(t, i) in turn.outcome.trace" :key="i">
                  <code>{{ t.tool }}</code>
                  <span class="t-args">{{ t.args }}</span>
                  <span class="t-res">→ {{ t.result_digest }}</span>
                </li>
              </ol>
            </div>


          </div>
        </div>
        <p v-if="props.chat.length === 0" class="empty">Ask questions, inspect traces, and keep useful notes from the right rail.</p>
      </div>

      <div class="agent-input">
        <div v-if="props.askDraft" class="ask-draft">
          <div class="ask-draft-head">
            <span>Quoted source</span>
            <code>{{ props.askDraft.lid }}</code>
            <button title="Clear quoted source" @click="emit('clear-ask')">×</button>
          </div>
          <blockquote>{{ props.askDraft.quote }}</blockquote>
        </div>
        <textarea
          :value="props.agentInput"
          rows="3"
          :placeholder="props.askDraft ? 'Ask about the quoted source…' : 'Ask from the current reading position…'"
          @input="emit('update:agentInput', ($event.target as HTMLTextAreaElement).value)"
          @keydown.ctrl.enter="emit('send-agent')"
        />
        <button :disabled="props.sending || !props.agentInput.trim()" @click="emit('send-agent')">
          {{ props.sending ? "…" : "Send" }}
        </button>
      </div>
    </section>

    <section v-show="activeTab === 'trace'" class="tab-panel context-panel">
      <div class="panel-head">
        <p class="rail-kicker">Latest tool trace</p>
        <h3>{{ props.latestTrace.length }} steps</h3>
      </div>
      <ol v-if="props.latestTrace.length" class="trace-list">
        <li v-for="(t, i) in props.latestTrace" :key="i" class="trace-card">
          <code>{{ t.tool }}</code>
          <p class="trace-args">{{ t.args }}</p>
          <p class="trace-result">{{ t.result_digest }}</p>
        </li>
      </ol>
      <p v-else class="empty panel-empty">No trace yet.</p>
    </section>

    <section v-show="activeTab === 'formula'" class="tab-panel context-panel">
      <div class="panel-head">
        <p class="rail-kicker">Formula profile</p>
        <h3>{{ props.selectedFormula?.formula_lid ?? props.selectedLid ?? "No selection" }}</h3>
      </div>
      <div v-if="props.selectedFormula" class="formula-card">
        <p class="formula-meaning">{{ props.selectedFormula.composition.meaning }}</p>
        <div v-if="props.selectedFormula.parameters.length" class="context-block">
          <h4>Parameters</h4>
          <dl>
            <template v-for="p in props.selectedFormula.parameters" :key="p.symbol">
              <dt>{{ p.symbol }}<span v-if="p.label"> · {{ p.label }}</span></dt>
              <dd>
                {{ p.meaning }}
                <span v-if="p.unit"> · unit: {{ p.unit }}</span>
                <span v-if="p.domain"> · domain: {{ p.domain }}</span>
              </dd>
            </template>
          </dl>
        </div>
        <div v-if="props.selectedFormula.context_links.length" class="context-block">
          <h4>Context links</h4>
          <ul>
            <li v-for="link in props.selectedFormula.context_links" :key="`${link.target_lid}:${link.relation}`">
              <strong>{{ link.relation }}</strong> {{ link.description }}
            </li>
          </ul>
        </div>
      </div>
      <p v-else class="empty panel-empty">Select a formula block in the reader to inspect its profile.</p>
    </section>

    <section v-show="activeTab === 'notes'" class="tab-panel context-panel">
      <div class="panel-head">
        <p class="rail-kicker">Nearby notes</p>
        <h3>{{ noteCount }} items</h3>
      </div>
      <div v-if="noteCount" class="memory-list">
        <details v-for="note in props.contextNotes" :key="note.mem_id" class="memory-card note-memory-card" :open="!isLongNote(note)">
          <summary class="memory-meta note-memory-summary">
            <span>Note</span>
            <button
              v-if="note.anchor.lid"
              class="note-source-button"
              @click.prevent.stop="emit('focus-source', { lid: note.anchor.lid, quote: leadingQuote(note.content) })"
            >
              {{ noteSourceLabel(note) }}
            </button>
            <code v-else>No source</code>
            <em v-if="isLongNote(note)">Toggle</em>
          </summary>
          <p v-if="isLongNote(note)" class="note-preview">{{ notePreview(note) }}</p>
          <div class="md" v-html="props.renderMarkdown(note.content)"></div>
        </details>
        <article v-for="hl in props.contextHighlights" :key="hl.mem_id" class="memory-card highlight-card">
          <div class="memory-meta"><span>Highlight</span><code>{{ hl.anchor.lid }}</code></div>
          <p>{{ excerpt(hl) }}</p>
        </article>
      </div>
      <p v-else class="empty panel-empty">No notes or highlights near the current viewport.</p>
    </section>
    <div
      v-if="answerSelection"
      class="answer-popover"
      :style="{ left: answerSelection.x + 'px', top: answerSelection.y - 40 + 'px' }"
    >
      <button @mousedown.prevent="saveAnswerSelection(answerSelection.turn)">Note</button>
    </div>

  </aside>
</template>

<style scoped>
.right-rail {
  min-width: 0;
  border-left: 1px solid var(--hairline);
  background: var(--canvas);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.context-tabs {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  padding: 0.75rem 0.75rem 0;
}
.tab {
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--steel);
  background: transparent;
  padding: 0.55rem 0.25rem;
  font-size: 0.82rem;
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
.panel-head {
  margin-bottom: 0.8rem;
}
.rail-kicker {
  margin: 0 0 0.15rem;
  color: var(--steel);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.agent-head h3,
.panel-head h3 {
  margin: 0;
  font-size: 1rem;
}
.new-chat {
  flex: 0 0 auto;
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
  background: var(--surface-soft);
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
  background: var(--surface-soft);
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  padding: 0.7rem 0.8rem;
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
  z-index: 70;
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
  background: var(--surface-soft);
  padding: 0.65rem 0.75rem;
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
  width: 24px;
  height: 24px;
  padding: 0;
}
.ask-draft blockquote {
  margin: 0;
  color: var(--slate);
  font-size: 0.84rem;
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
  margin: 0.45rem 0 0;
  color: var(--slate);
  font-size: 0.84rem;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
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
.note-memory-summary {
  cursor: pointer;
  list-style: none;
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
.highlight-card {
  background: #fffdf0;
}
</style>
