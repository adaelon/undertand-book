import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { api, agentRunEventsUrl } from "./api";
import { initialRun, reduceRun, type RunDescriptor, type RunEvent, type RunSnapshot } from "./agent-run-state";

const events = ["reader.changed", "effect.created","answer.patch","run.snapshot", "run.started", "model.started", "model.finished", "tool.started", "tool.finished", "run.cancelling", "run.finalizing", "run.completed", "run.failed", "run.cancelled", "run.persistence_failed"];
export function useAgentRun(onTerminal: (snapshot: RunSnapshot) => void) {
  const snapshot = shallowRef<RunSnapshot | null>(null);
  const connection = ref("closed");
  let source: EventSource | null = null;
  let queued: RunSnapshot | null = null;
  let frame: number | null = null;
  function flushDraft() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const next = queued; queued = null;
    if (next) install(next);
  }
  const active = computed(() => snapshot.value?.persistence_state === "pending");
  function close() { if (frame !== null) cancelAnimationFrame(frame); frame = null; queued = null; source?.close(); source = null; connection.value = "closed"; }
  function install(next: RunSnapshot) {
    const previous = snapshot.value;
    snapshot.value = next;
    if (next.persistence_state !== "pending" && previous?.persistence_state === "pending") { close(); onTerminal(next); }
  }
  function observe(descriptor: RunDescriptor) {
    if (snapshot.value?.descriptor.turn_id === descriptor.turn_id && source) return;
    close();
    snapshot.value = initialRun(descriptor);
    connection.value = "connecting";
    const current = new EventSource(agentRunEventsUrl(descriptor.turn_id));
    source = current;
    current.onopen = () => { if (source === current) connection.value = "connected"; };
    current.onerror = () => { if (source === current) connection.value = "reconnecting"; };
    for (const name of events) current.addEventListener(name, (message) => {
      if (source !== current || !snapshot.value) return;
      const event = JSON.parse((message as MessageEvent).data) as RunEvent;
      if (event.type === "answer.patch") {
        queued = reduceRun(queued ?? snapshot.value, event);
        if (frame === null) frame = requestAnimationFrame(flushDraft);
      } else {
        flushDraft();
        install(reduceRun(snapshot.value!, event));
      }
    });
  }
  async function cancel() {
    const current = snapshot.value;
    if (!current || !active.value) return;
    const next = await api.agentRunCancel(current.descriptor.turn_id);
    flushDraft();
    if (snapshot.value?.descriptor.turn_id === next.descriptor.turn_id && next.last_seq >= snapshot.value.last_seq) install(next);
  }
  function forget() { close(); snapshot.value = null; }
  onBeforeUnmount(close);
  return { snapshot, connection, active, observe, cancel, close, forget };
}
