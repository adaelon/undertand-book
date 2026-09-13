// @vitest-environment happy-dom
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentRun } from "./useAgentRun";
import { initialRun } from "./agent-run-state";

class Source extends EventTarget {
  static instances: Source[] = [];
  onopen?: () => void;
  onerror?: () => void;
  closed = false;
  constructor(public url: string) { super(); Source.instances.push(this); }
  close() { this.closed = true; }
  emit(type: string, seq: number, payload: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ type, turn_id: "turn", seq, elapsed_ms: seq, payload }) })); }
}
afterEach(() => { vi.unstubAllGlobals(); Source.instances = []; });
it("reconnects observation without a second create and closes only on an explicit terminal state", async () => {
  vi.stubGlobal("EventSource", Source);
  const complete = vi.fn();
  let run!: ReturnType<typeof useAgentRun>;
  const wrapper = mount(defineComponent({ setup() { run = useAgentRun(complete); return () => null; } }));
  const descriptor = { turn_id: "turn", book_id: "book", session_id: "session" };
  run.observe(descriptor);
  const source = Source.instances[0];
  source.onopen?.();
  source.emit("run.snapshot", 3, { ...initialRun(descriptor), last_seq: 3 });
  source.onerror?.();
  expect(run.active.value).toBe(true);
  expect(run.connection.value).toBe("reconnecting");
  run.observe(descriptor);
  expect(Source.instances).toHaveLength(1);
  source.emit("run.cancelling", 4, null);
  expect(run.snapshot.value?.execution_state).toBe("cancelling");
  source.emit("run.cancelled", 5, { ...initialRun(descriptor), last_seq: 5, execution_state: "cancelled", persistence_state: "saved" });
  expect(run.active.value).toBe(false);
  expect(source.closed).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
  source.emit("run.cancelled", 5, initialRun(descriptor));
  expect(complete).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});

it("coalesces draft patches per frame and flushes them before lifecycle events", () => {
  vi.stubGlobal("EventSource", Source);
  let callback: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((next) => { callback = next; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const complete = vi.fn(); let run!: ReturnType<typeof useAgentRun>;
  const wrapper = mount(defineComponent({ setup() { run = useAgentRun(complete); return () => null; } }));
  const descriptor = { turn_id: "turn", book_id: "book", session_id: "session" };
  run.observe(descriptor); const source = Source.instances[0];
  const patch = (text: string) => ({ message_id: 1, revision: 0, operation: "replace", view: { parts: [{ kind: "markdown", text }], sources: [] } });
  source.emit("answer.patch", 1, patch("第一句。"));
  source.emit("answer.patch", 2, patch("第一句。第二句。"));
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  expect(run.snapshot.value?.draft).toBeUndefined();
  callback!(0);
  expect(run.snapshot.value?.last_seq).toBe(2);
  source.emit("answer.patch", 3, patch("新草稿。"));
  source.emit("run.finalizing", 4, null);
  expect(run.snapshot.value?.last_seq).toBe(4);
  source.emit("run.persistence_failed", 5, { ...initialRun(descriptor), draft: null, execution_state: "ended", persistence_state: "failed" });
  expect(run.snapshot.value?.draft).toBeNull();
  expect(complete).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});
