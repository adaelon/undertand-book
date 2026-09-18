<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import type { PresentationRef } from "../generated/PresentationRef";
import type { PresentationView } from "../generated/PresentationView";
import type { PresentationState } from "../generated/PresentationState";
import type { PresentationFollowUp } from "../generated/PresentationFollowUp";
import { presentationDocument } from "../presentation-document";
import { resolvePresentationEditingMessage } from "../presentation-host";

const props = defineProps<{ sessionId: string; turnId: string; reference: PresentationRef; busy?: boolean }>();
const emit = defineEmits<{
  (e: "source", id: string, anchor: HTMLElement): void;
  (e: "follow-up", message: string, receipt: PresentationFollowUp): void;
}>();
const frame = ref<HTMLIFrameElement>();
const root = ref<HTMLElement>();
const expandButton = ref<HTMLButtonElement>();
const view = ref<PresentationView>();
const documentText = ref("");
const error = ref("");
const expanded = ref(false);
const ready = ref(false);
const question = ref("");
const saving = ref(false);
const saveNotice = ref("");
const frameLoadCount = ref(0);
const frameEditing = ref(false);
const hostWidth = ref(0);
const hostHeight = ref(0);
let saveQueue: Promise<unknown> = Promise.resolve();
let requestId = 0;
let pendingSnapshot: { id: number; resolve: (state: PresentationState) => void; reject: (error: Error) => void } | undefined;
let generation = 0;
let observedRevision = 0;
let themeObserver: MutationObserver | undefined;
let hostObserver: ResizeObserver | undefined;
const readableText = computed(() => view.value?.readable_view.parts.map(part => part.kind === "markdown" ? part.text : "").join("") ?? "");
const compactHost = computed(() => hostHeight.value > 0 && hostHeight.value < 520);
const frameStyle = computed(() => {
  if (expanded.value || hostHeight.value <= 0) return {};
  const reserved = hostWidth.value > 0 && hostWidth.value < 420 ? 178 : 152;
  return { height: `${Math.max(180, Math.min(420, hostHeight.value - reserved))}px` };
});

watch([() => props.sessionId, () => props.turnId, () => props.reference.presentation_id, () => props.reference.revision], async () => {
  setFrameEditing(false);
  const current = ++generation;
  pendingSnapshot?.reject(new Error("内容已切换，请重新追问。")); pendingSnapshot = undefined;
  saveNotice.value = ""; question.value = "";
  view.value = undefined; documentText.value = ""; error.value = ""; ready.value = false; observedRevision = 0;
  try {
    const result = await api.presentationRead(props.sessionId, props.turnId, props.reference);
    if (current !== generation) return;
    const doc = presentationDocument(result);
    view.value = result; documentText.value = doc;
    if (result.restored_state_revision) saveNotice.value = "已恢复上次保存的现场";
  } catch { if (current === generation) error.value = "内容暂时无法读取，请重新打开此回答。"; }
}, { immediate: true });

function theme() {
  if (!root.value) return;
  const style = getComputedStyle(root.value);
  const values = Object.fromEntries(["--canvas", "--ink", "--surface", "--line", "--accent"].map(name => [name, style.getPropertyValue(name).trim()]));
  frame.value?.contentWindow?.postMessage({ channel: "agent-presentation", kind: "theme", values, generation }, "*");
}
function setFrameEditing(editing: boolean) {
  if (frameEditing.value === editing) return;
  frameEditing.value = editing;
  root.value?.dispatchEvent(new CustomEvent("workspace-iframe-editing", {
    bubbles: true,
    detail: { editing },
  }));
}
function hostIsVisible(): boolean {
  if (!root.value || root.value.hidden || root.value.closest("[hidden], [aria-hidden='true']")) return false;
  return getComputedStyle(root.value).display !== "none";
}
function onFrameLoad() {
  frameLoadCount.value += 1;
  setFrameEditing(false);
  theme();
}
async function receive(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.data?.channel !== "agent-presentation" || error.value) return;
  const message = event.data;
  if (message.kind === "editing-focus") {
    const editing = resolvePresentationEditingMessage(message, {
      generation,
      frameFocused: document.activeElement === frame.value,
      visible: hostIsVisible(),
    });
    if (editing !== null) setFrameEditing(editing);
    return;
  }
  if (message.kind === "restore-partial") {
    saveNotice.value = "已恢复控件；此版本未提供自定义参数和步骤的恢复方法。";
    return;
  }
  if (message.kind === "state") {
    if (message.request_id !== undefined) {
      if (pendingSnapshot && pendingSnapshot.id === message.request_id) { pendingSnapshot.resolve(message.state); pendingSnapshot = undefined; }
    } else { void saveState(message.state).catch(() => {}); }
    return;
  }
  if (message.kind === "error") {
    error.value = "此内容运行出错，请稍后重试。";
    pendingSnapshot?.reject(new Error(error.value)); pendingSnapshot = undefined;
    return;
  }
  if (message.kind === "source" && view.value?.sources.some(source => source.source_ref_id === message.source_ref_id) && root.value && ready.value) {
    emit("source", message.source_ref_id, root.value); return;
  }
  if (message.kind !== "observe" || !Number.isInteger(message.revision) || message.revision <= observedRevision
      || typeof message.text !== "string" || !Array.isArray(message.source_ref_ids)) return;
  const current = generation;
  observedRevision = message.revision;
  ready.value = false;
  try {
    const result = await api.presentationObserve(props.sessionId, props.turnId, props.reference, message.text, message.source_ref_ids);
    if (current !== generation || observedRevision !== message.revision || error.value) return;
    if (!result.accepted) throw new Error("rejected");
    ready.value = true;
    frame.value?.contentWindow?.postMessage({ channel: "agent-presentation", kind: "accepted", revision: message.revision }, "*");
    theme();
  } catch { if (current === generation && observedRevision === message.revision) error.value = "此内容的文字或来源无法显示，请重新生成。"; }
}
function saveState(state: PresentationState) {
  const current = generation;
  const session = props.sessionId, turn = props.turnId, reference = { ...props.reference };
  const operation = saveQueue.catch(() => {}).then(async () => {
    if (current !== generation) throw new Error("内容已切换，请重新追问。");
    return api.presentationSaveState(session, turn, reference, state);
  });
  saveQueue = operation;
  return operation.then(receipt => {
    if (current === generation) saveNotice.value = "现场已保存";
    return receipt;
  }, failure => {
    if (current === generation) saveNotice.value = `现场保存失败：${failure instanceof Error ? failure.message : String(failure)}`;
    throw failure;
  });
}
async function followUp() {
  if (!ready.value || error.value || saving.value || props.busy) return;
  saving.value = true;
  const current = generation;
  const message = question.value.trim() || "解释现在的结果";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await new Promise<PresentationState>((resolve, reject) => {
      const id = ++requestId;
      pendingSnapshot = { id, resolve, reject };
      timer = setTimeout(() => { pendingSnapshot = undefined; reject(new Error("未收到页面现场，请重试。")); }, 10000);
      frame.value?.contentWindow?.postMessage({ channel: "agent-presentation", kind: "snapshot", request_id: id }, "*");
    });
    clearTimeout(timer);
    const receipt = await saveState(snapshot);
    if (current !== generation || error.value || props.busy) return;
    emit("follow-up", message, receipt);
    question.value = "";
  } catch (failure) {
    if (current === generation) saveNotice.value = `追问未发送：${failure instanceof Error ? failure.message : String(failure)}`;
  } finally { clearTimeout(timer); saving.value = false; }
}
function measureHost() {
  const host = root.value?.parentElement ?? root.value;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  hostWidth.value = host.clientWidth || rect.width;
  hostHeight.value = host.clientHeight || rect.height;
}
function toggleExpanded() {
  expanded.value = !expanded.value;
  if (!expanded.value) void nextTick(() => expandButton.value?.focus({ preventScroll: true }));
}
function keydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !expanded.value) return;
  expanded.value = false;
  void nextTick(() => expandButton.value?.focus({ preventScroll: true }));
}
onMounted(() => {
  window.addEventListener("message", receive);
  window.addEventListener("keydown", keydown);
  themeObserver = new MutationObserver(theme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
  if (typeof ResizeObserver !== "undefined") {
    hostObserver = new ResizeObserver(measureHost);
    hostObserver.observe(root.value?.parentElement ?? root.value!);
  }
  measureHost();
});
onBeforeUnmount(() => {
  setFrameEditing(false);
  pendingSnapshot?.reject(new Error("内容已关闭。")); pendingSnapshot = undefined;
  generation++; themeObserver?.disconnect(); hostObserver?.disconnect();
  window.removeEventListener("message", receive); window.removeEventListener("keydown", keydown);
});
</script>

<template>
  <section
    ref="root"
    class="agent-presentation"
    :class="{ expanded, 'compact-host': compactHost }"
    :aria-label="view?.title || '富回答'"
    :aria-modal="expanded || undefined"
    :role="expanded ? 'dialog' : undefined"
    :data-frame-editing="frameEditing"
    :data-content-generation="generation"
  >
    <header>
      <strong>{{ view?.title || '正在读取内容…' }}</strong>
      <small v-if="view">版本 {{ view.reference.revision }}</small>
      <button v-if="view" ref="expandButton" type="button" @click="toggleExpanded" :aria-expanded="expanded">{{ expanded ? '收起' : '展开' }}</button>
    </header>
    <p v-if="error" class="presentation-error" role="alert">{{ error }}</p>
    <template v-else>
      <p v-if="!ready" role="status">正在准备内容…</p>
      <iframe
        v-if="documentText"
        ref="frame"
        :srcdoc="documentText"
        :title="view?.title"
        :style="frameStyle"
        :data-load-count="frameLoadCount"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        @load="onFrameLoad"
      />
      <form v-if="view" class="presentation-follow-up" @submit.prevent="followUp">
        <input v-model="question" aria-label="针对当前现场追问" placeholder="解释当前结果，或描述要修改的内容…" :disabled="saving || busy" />
        <button type="submit" :disabled="!ready || saving || busy">{{ saving ? '正在保存现场…' : question.trim() ? '发送追问' : '解释现在的结果' }}</button>
        <small v-if="saveNotice" role="status">{{ saveNotice }}</small>
      </form>
    </template>
    <details v-if="view" class="presentation-readable">
      <summary>文字说明与来源</summary>
      <p class="readable-text">{{ readableText }}</p>
      <p v-for="assumption in view.assumptions" :key="assumption">{{ assumption }}</p>
      <button v-for="source in view.sources" :key="source.source_ref_id" type="button" @click="emit('source', source.source_ref_id, $event.currentTarget as HTMLElement)">{{ source.label }}</button>
    </details>
  </section>
</template>

<style scoped>
.agent-presentation { container-type: inline-size; border: 1px solid var(--line, #e6dfd8); border-radius: 12px; background: var(--canvas, #faf9f5); color: var(--ink, #252523); overflow: hidden; margin: 12px 0; min-width: 0; }
header { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 12px 16px; }
header strong { overflow-wrap: anywhere; }
button { min-height: 44px; font: inherit; color: var(--accent, #a9583e); border: 1px solid var(--line, #e6dfd8); border-radius: 8px; background: var(--surface, #efe9de); padding: 5px 10px; cursor: pointer; }
iframe { display: block; width: 100%; height: 420px; min-height: 180px; border: 0; background: var(--canvas, #faf9f5); }
.presentation-follow-up { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px max(12px, env(safe-area-inset-bottom)); }
.presentation-follow-up input { flex: 1; min-width: 120px; color: inherit; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.presentation-follow-up small { flex-basis: 100%; }
button:disabled { opacity: .55; cursor: default; }
.expanded { position: fixed; inset: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); z-index: 90; margin: 0; display: flex; flex-direction: column; max-height: calc(100dvh - max(40px, env(safe-area-inset-top) + env(safe-area-inset-bottom))); box-shadow: 0 16px 80px #0005; }
.expanded iframe { flex: 1 1 auto; height: auto !important; min-height: 0; }
.expanded .presentation-readable { max-height: 30vh; overflow: auto; }
.presentation-readable { flex: 0 1 auto; max-height: min(240px, 32dvh); overflow: auto; padding: 12px 16px; border-top: 1px solid var(--line, #e6dfd8); }
.presentation-readable button { margin: 4px; }
.readable-text { white-space: pre-wrap; }
.presentation-error, [role=status] { padding: 0 16px; }
.compact-host header { padding-block: 8px; }
.compact-host .presentation-follow-up { padding-block: 8px; }
@container (max-width: 420px) {
  header strong { flex: 1 1 100%; }
  .presentation-follow-up input,
  .presentation-follow-up button { flex: 1 1 100%; width: 100%; }
  .presentation-readable { padding-inline: 12px; }
}
@media (max-width: 600px) {
  .expanded { inset: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); max-height: calc(100dvh - max(16px, env(safe-area-inset-top) + env(safe-area-inset-bottom))); }
}
</style>
