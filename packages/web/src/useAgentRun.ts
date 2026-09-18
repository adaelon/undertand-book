import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { api, agentRunEventsUrl, ApiError } from "./api";
import { initialRun, interruptRun, reduceRun, type RunDescriptor, type RunEvent, type RunSnapshot } from "./agent-run-state";

const events = ["reader.changed", "effect.created","answer.patch","run.snapshot", "run.started", "model.started", "model.finished", "tool.started", "tool.finished", "run.cancelling", "run.finalizing", "run.completed", "run.failed", "run.cancelled", "run.persistence_failed"];
export function useAgentRun(onTerminal: (snapshot: RunSnapshot) => void) {
  const snapshot = shallowRef<RunSnapshot | null>(null);
  const connection = ref("closed");
  let source: EventSource | null = null;
  let queued: RunSnapshot | null = null;
  let frame: number | null = null;
  let observationGeneration = 0;
  let terminalNotified = false;
  let reconcileTask: Promise<void> | null = null;
  let reconcileTimer: number | null = null;

  function sameDescriptor(left: RunDescriptor | null | undefined, right: RunDescriptor): boolean {
    return !!left
      && left.book_id === right.book_id
      && left.session_id === right.session_id
      && left.turn_id === right.turn_id;
  }
  function flushDraft() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const next = queued; queued = null;
    if (next) install(next);
  }
  const active = computed(() => snapshot.value?.persistence_state === "pending");
  function closeTransport() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    queued = null;
    source?.close();
    source = null;
  }
  function close() {
    observationGeneration += 1;
    if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
    reconcileTimer = null;
    reconcileTask = null;
    closeTransport();
    connection.value = "closed";
  }
  function install(next: RunSnapshot) {
    const previous = snapshot.value;
    snapshot.value = next;
    if (next.persistence_state !== "pending") {
      closeTransport();
      connection.value = next.error?.error_code === "AGENT_RUN_NOT_FOUND" ? "interrupted" : "closed";
      if (!terminalNotified && previous?.persistence_state === "pending") {
        terminalNotified = true;
        onTerminal(next);
      }
    }
  }

  function openSource(descriptor: RunDescriptor, generation: number) {
    if (source || generation !== observationGeneration || !active.value) return;
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

  async function reconcile(): Promise<void> {
    if (reconcileTask) return reconcileTask;
    const current = snapshot.value;
    if (!current || current.persistence_state !== "pending") return;
    const descriptor = current.descriptor;
    const generation = observationGeneration;
    connection.value = connection.value === "connected" ? "connected" : "checking";
    reconcileTask = (async () => {
      try {
        const recovered = await api.agentRun(descriptor.turn_id);
        if (generation !== observationGeneration || !sameDescriptor(snapshot.value?.descriptor, descriptor)) return;
        flushDraft();
        const installed = snapshot.value;
        if (!installed || recovered.last_seq < installed.last_seq) return;
        if (installed.persistence_state !== "pending" && recovered.persistence_state === "pending") return;
        install(recovered);
        if (recovered.persistence_state === "pending") openSource(descriptor, generation);
      } catch (error) {
        if (generation !== observationGeneration || !sameDescriptor(snapshot.value?.descriptor, descriptor)) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          closeTransport();
          connection.value = "authentication";
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          const running = snapshot.value;
          if (running?.persistence_state === "pending") {
            install(interruptRun(running, {
              error_code: error.errorCode,
              category: error.category,
              message: error.message,
            }));
          }
          return;
        }
        connection.value = navigator.onLine === false ? "offline" : "reconnecting";
      } finally {
        if (generation === observationGeneration) reconcileTask = null;
      }
    })();
    return reconcileTask;
  }

  function scheduleReconcile() {
    if (!snapshot.value || snapshot.value.persistence_state !== "pending" || reconcileTask || reconcileTimer !== null) return;
    reconcileTimer = window.setTimeout(() => {
      reconcileTimer = null;
      void reconcile();
    }, 0);
  }

  function observe(descriptor: RunDescriptor) {
    if (sameDescriptor(snapshot.value?.descriptor, descriptor) && snapshot.value?.persistence_state === "pending") {
      openSource(descriptor, observationGeneration);
      scheduleReconcile();
      return;
    }
    close();
    observationGeneration += 1;
    terminalNotified = false;
    snapshot.value = initialRun(descriptor);
    connection.value = "checking";
    const generation = observationGeneration;
    void reconcile();
    openSource(descriptor, generation);
  }
  async function cancel() {
    const current = snapshot.value;
    if (!current || !active.value) return;
    const next = await api.agentRunCancel(current.descriptor.turn_id);
    flushDraft();
    if (snapshot.value?.descriptor.turn_id === next.descriptor.turn_id && next.last_seq >= snapshot.value.last_seq) install(next);
  }
  function forget() { close(); snapshot.value = null; terminalNotified = false; }
  const recoverVisible = () => {
    if (document.visibilityState === "hidden") return;
    scheduleReconcile();
  };
  onMounted(() => {
    document.addEventListener("visibilitychange", recoverVisible);
    window.addEventListener("pageshow", recoverVisible);
    window.addEventListener("online", recoverVisible);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", recoverVisible);
    window.removeEventListener("pageshow", recoverVisible);
    window.removeEventListener("online", recoverVisible);
    close();
  });
  return { snapshot, connection, active, observe, reconcile, cancel, close, forget };
}
