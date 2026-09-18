import { describe, expect, it } from "vitest";
import { initialRun, interruptRun, reduceRun, type RunActivity, type RunEvent } from "./agent-run-state";
const descriptor = { book_id: "book", session_id: "session", turn_id: "turn" };
const activity: RunActivity = { step_id: 1, parent_step_id: null, kind: "tool", name: "book.text", label: "读取原文", status: "running", started_ms: 5, duration_ms: null, error_code: null, result_count: null, usage_total_tokens: null };
const event = (seq: number, type: string, payload: unknown): RunEvent => ({ turn_id: "turn", seq, type, payload, elapsed_ms: seq });
describe("Resident run reducer", () => {
  it("merges live and snapshot activities without duplicate steps or stale replacement", () => {
    const started = reduceRun(initialRun(descriptor), event(2, "tool.started", activity));
    const finished = reduceRun(started, event(3, "tool.finished", { ...activity, status: "succeeded", duration_ms: 10 }));
    expect(finished.activities).toHaveLength(1);
    expect(reduceRun(finished, event(2, "tool.started", activity))).toBe(finished);
    const restored = reduceRun(initialRun(descriptor), event(3, "run.snapshot", finished));
    expect(restored).toEqual(finished);
    expect(reduceRun(finished, { ...event(4, "tool.started", activity), turn_id: "other" })).toBe(finished);
    expect(reduceRun(finished, event(4, "run.snapshot", { ...finished, descriptor: { ...descriptor, book_id: "other" } }))).toBe(finished);
  });
  it("keeps failure, cancellation and unsaved outcomes distinct with their activity tree", () => {
    for (const [type, execution, persistence] of [["run.failed", "failed", "saved"], ["run.cancelled", "cancelled", "saved"], ["run.persistence_failed", "ended", "failed"]]) {
      const initial = initialRun(descriptor);
      const stopped = reduceRun(initial, event(9, type, { ...initial, execution_state: execution, persistence_state: persistence, activities: [{ ...activity, status: "cancelled" }] }));
      expect(stopped.persistence_state).toBe(persistence);
      expect(stopped.execution_state).toBe(execution);
      expect(stopped.activities[0].status).toBe("cancelled");
    }
  });
});

it("replaces repair revisions, discards tool candidates and restores draft snapshots", () => {
  const patch = (revision: number, text: string) => ({ message_id: 1, revision, operation: "replace", view: { parts: [{ kind: "markdown", text }], sources: [] } });
  const draft = reduceRun(initialRun(descriptor), event(1, "answer.patch", patch(0, "原草稿。")));
  expect(reduceRun(initialRun(descriptor), event(1, "run.snapshot", draft))).toEqual(draft);
  const repair = reduceRun(draft, event(2, "answer.patch", patch(1, "修复。")));
  expect(repair.draft?.view?.parts).toEqual([{ kind: "markdown", text: "修复。" }]);
  expect(reduceRun(repair, event(3, "answer.patch", patch(0, "旧草稿。"))).draft).toEqual(repair.draft);
  const discarded = reduceRun(repair, event(4, "answer.patch", { message_id: 1, revision: 1, operation: "discard", view: null }));
  expect(discarded.draft?.view).toBeNull();
  const saved = reduceRun(discarded, event(5, "run.completed", { ...discarded, draft: null, execution_state: "completed", persistence_state: "saved" }));
  expect(saved.draft).toBeNull();
});

it("materializes same-revision appends without mutating the earlier snapshot", () => {
  const view = (text: string) => ({ parts: [{ kind: "markdown", text }], sources: [] });
  const original = reduceRun(initialRun(descriptor), event(1, "answer.patch", { message_id: 1, revision: 0, operation: "replace", view: view("第一句。") }));
  const appended = reduceRun(original, event(2, "answer.patch", { message_id: 1, revision: 0, operation: "append", view: view("第二句。") }));
  expect(appended.draft?.view).toEqual(view("第一句。第二句。"));
  expect(original.draft?.view).toEqual(view("第一句。"));
  expect(reduceRun(appended, event(3, "answer.patch", { message_id: 1, revision: 1, operation: "append", view: view("wrong revision") })).draft).toEqual(appended.draft);
});

it("deduplicates effects and rejects older or cross-book Reader revisions", () => {
  const effect = { effect_id: "turn:2", effect: { kind: "Note", mem_id: "note", lid: "1.1", text: "saved" } };
  let state = reduceRun(initialRun(descriptor), event(1, "effect.created", effect));
  state = reduceRun(state, event(2, "effect.created", effect));
  expect(state.effects).toEqual([effect]);
  state = reduceRun(state, event(3, "reader.changed", { book_id: "book", revision: 4 }));
  state = reduceRun(state, event(4, "reader.changed", { book_id: "book", revision: 3 }));
  state = reduceRun(state, event(5, "reader.changed", { book_id: "other", revision: 9 }));
  expect(state.reader_state).toEqual({ book_id: "book", revision: 4 });
  expect(reduceRun(initialRun(descriptor), event(5, "run.snapshot", state))).toEqual(state);
});

it("marks an unverifiable persisted run interrupted without changing its identity or sequence", () => {
  const running = { ...initialRun(descriptor), last_seq: 7 };
  const interrupted = interruptRun(running, {
    error_code: "AGENT_RUN_NOT_FOUND",
    category: "not_found",
    message: "Run does not exist",
  });
  expect(interrupted.descriptor).toEqual(descriptor);
  expect(interrupted.last_seq).toBe(7);
  expect(interrupted.execution_state).toBe("interrupted");
  expect(interrupted.persistence_state).toBe("failed");
  expect(interrupted.error?.error_code).toBe("AGENT_RUN_NOT_FOUND");
});
