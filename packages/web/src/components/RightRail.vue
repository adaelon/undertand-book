<script setup lang="ts">
import { computed, ref } from "vue";
import type { AgentEffect, FormulaSemantics, MemoryRecord, OuterOutcome, TraceStep } from "../api";

type ContextTab = "agent" | "trace" | "formula" | "notes";

interface ChatTurn {
  user: string;
  outcome: OuterOutcome | null;
  pending: boolean;
  error?: string;
  distilled?: boolean;
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
}>();
const emit = defineEmits<{
  (e: "update:agentInput", value: string): void;
  (e: "send-agent"): void;
  (e: "new-chat"): void;
  (e: "toggle-trace", turnIndex: number): void;
  (e: "undo-effect", turnIndex: number, effectIndex: number, effect: AgentEffect): void;
  (e: "keep-effect", turnIndex: number, effectIndex: number, effect: AgentEffect): void;
  (e: "distill", turn: ChatTurn): void;
}>();

const activeTab = ref<ContextTab>("agent");
const tabs: { id: ContextTab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "trace", label: "Trace" },
  { id: "formula", label: "Formula" },
  { id: "notes", label: "Notes" },
];
const noteCount = computed(() => props.contextNotes.length + props.contextHighlights.length);

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
          <p class="u-msg">{{ turn.user }}</p>
          <p v-if="turn.pending" class="pending">Agent is thinking…</p>
          <p v-else-if="turn.error" class="incomplete">{{ turn.error }}</p>

          <div v-else-if="turn.outcome" class="a-msg">
            <div v-if="turn.outcome.answer" class="ans-text md" v-html="props.renderMarkdown(turn.outcome.answer)"></div>
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

            <div class="distill" v-if="turn.outcome.answer">
              <button v-if="!turn.distilled" @click="emit('distill', turn)">Save as note</button>
              <span v-else class="done">Saved as note</span>
            </div>
          </div>
        </div>
        <p v-if="props.chat.length === 0" class="empty">Ask questions, inspect traces, and keep useful notes from the right rail.</p>
      </div>

      <div class="agent-input">
        <textarea
          :value="props.agentInput"
          rows="3"
          placeholder="Ask from the current reading position…"
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
        <article v-for="note in props.contextNotes" :key="note.mem_id" class="memory-card">
          <div class="memory-meta"><span>Note</span><code>{{ note.anchor.lid }}</code></div>
          <div class="md" v-html="props.renderMarkdown(note.content)"></div>
        </article>
        <article v-for="hl in props.contextHighlights" :key="hl.mem_id" class="memory-card highlight-card">
          <div class="memory-meta"><span>Highlight</span><code>{{ hl.anchor.lid }}</code></div>
          <p>{{ excerpt(hl) }}</p>
        </article>
      </div>
      <p v-else class="empty panel-empty">No notes or highlights near the current viewport.</p>
    </section>
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
.distill {
  margin-top: 0.6rem;
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
.highlight-card {
  background: #fffdf0;
}
</style>
