<script setup lang="ts">
import type { AgentEffect, OuterOutcome } from "../api";

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
</script>

<template>
  <aside class="right-rail">
    <div class="context-tabs">
      <button class="tab active">Agent</button>
      <button class="tab" disabled>Trace</button>
      <button class="tab" disabled>Formula</button>
      <button class="tab" disabled>Notes</button>
    </div>

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
.agent-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem 1rem 0.7rem;
}
.rail-kicker {
  margin: 0 0 0.15rem;
  color: var(--steel);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.agent-head h3 {
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
.a-msg {
  background: var(--surface-soft);
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  padding: 0.7rem 0.8rem;
}
.pending,
.empty {
  color: var(--steel);
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
.trace ol {
  margin: 0.35rem 0 0;
  padding-left: 1.2rem;
  color: var(--steel);
  font-size: 0.78rem;
}
.trace .t-args,
.trace .t-res {
  color: var(--stone);
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
</style>
