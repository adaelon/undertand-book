// @vitest-environment happy-dom
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentRun } from "./useAgentRun";
import { initialRun } from "./agent-run-state";
import { api, ApiError } from "./api";

class Source extends EventTarget {
  static instances: Source[] = [];
  onopen?: () => void;
  onerror?: () => void;
  closed = false;
  constructor(public url: string) { super(); Source.instances.push(this); }
  close() { this.closed = true; }
  emit(type: string, seq: number, payload: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ type, turn_id: "turn", seq, elapsed_ms: seq, payload }) })); }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Source.instances = []; });
it("reconnects observation without a second create and closes only on an explicit terminal state", async () => {
  vi.stubGlobal("EventSource", Source);
  vi.spyOn(api, "agentRun").mockResolvedValue({
    ...initialRun({ turn_id: "turn", book_id: "book", session_id: "session" }),
    last_seq: 0,
  });
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
  vi.spyOn(api, "agentRun").mockResolvedValue({
    ...initialRun({ turn_id: "turn", book_id: "book", session_id: "session" }),
    last_seq: 0,
  });
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

it("coalesces lifecycle recovery into one snapshot check and keeps one subscription", async () => {
  vi.stubGlobal("EventSource", Source);
  let resolveSnapshot!: (snapshot: ReturnType<typeof initialRun>) => void;
  const recovered = new Promise<ReturnType<typeof initialRun>>((resolve) => { resolveSnapshot = resolve; });
  const read = vi.spyOn(api, "agentRun").mockReturnValue(recovered);
  const complete = vi.fn();
  let run!: ReturnType<typeof useAgentRun>;
  const wrapper = mount(defineComponent({ setup() { run = useAgentRun(complete); return () => null; } }));
  const descriptor = { turn_id: "turn", book_id: "book", session_id: "session" };
  run.observe(descriptor);
  for (let index = 0; index < 10; index += 1) {
    window.dispatchEvent(new Event(index % 2 ? "online" : "pageshow"));
  }
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  expect(Source.instances).toHaveLength(1);
  resolveSnapshot({ ...initialRun(descriptor), last_seq: 4 });
  await recovered;
  await Promise.resolve();
  expect(run.snapshot.value?.last_seq).toBe(4);
  expect(Source.instances.filter((source) => !source.closed)).toHaveLength(1);
  wrapper.unmount();
});

it("does not let a stale recovery snapshot replace newer SSE state or complete twice", async () => {
  vi.stubGlobal("EventSource", Source);
  let resolveSnapshot!: (snapshot: ReturnType<typeof initialRun>) => void;
  vi.spyOn(api, "agentRun").mockReturnValue(new Promise((resolve) => { resolveSnapshot = resolve; }));
  const complete = vi.fn();
  let run!: ReturnType<typeof useAgentRun>;
  const wrapper = mount(defineComponent({ setup() { run = useAgentRun(complete); return () => null; } }));
  const descriptor = { turn_id: "turn", book_id: "book", session_id: "session" };
  run.observe(descriptor);
  const source = Source.instances[0];
  source.emit("run.snapshot", 8, { ...initialRun(descriptor), last_seq: 8 });
  resolveSnapshot({ ...initialRun(descriptor), last_seq: 3 });
  await Promise.resolve();
  await Promise.resolve();
  expect(run.snapshot.value?.last_seq).toBe(8);
  const terminal = {
    ...initialRun(descriptor),
    last_seq: 9,
    execution_state: "completed" as const,
    persistence_state: "saved" as const,
  };
  source.emit("run.completed", 9, terminal);
  source.emit("run.completed", 9, terminal);
  expect(complete).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});

it("classifies authentication and missing runs without creating or resubmitting", async () => {
  vi.stubGlobal("EventSource", Source);
  const read = vi.spyOn(api, "agentRun")
    .mockRejectedValueOnce(new ApiError(401, "AUTH_REQUIRED", "authentication", "login required"))
    .mockRejectedValueOnce(new ApiError(404, "AGENT_RUN_NOT_FOUND", "not_found", "missing"));
  const complete = vi.fn();
  let run!: ReturnType<typeof useAgentRun>;
  const wrapper = mount(defineComponent({ setup() { run = useAgentRun(complete); return () => null; } }));
  const descriptor = { turn_id: "turn", book_id: "book", session_id: "session" };
  run.observe(descriptor);
  await Promise.resolve();
  await Promise.resolve();
  expect(run.connection.value).toBe("authentication");
  expect(Source.instances[0].closed).toBe(true);
  await run.reconcile();
  expect(read).toHaveBeenCalledTimes(2);
  expect(run.snapshot.value?.execution_state).toBe("interrupted");
  expect(run.snapshot.value?.persistence_state).toBe("failed");
  expect(run.snapshot.value?.error?.error_code).toBe("AGENT_RUN_NOT_FOUND");
  expect(complete).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});
