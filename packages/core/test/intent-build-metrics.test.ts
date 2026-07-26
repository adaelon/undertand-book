import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendIntentBuildUsageEvent,
  deleteIntentBuildUsageForIntent,
  readIntentBuildUsageEvents,
  replayIntentBuildUsageEvents,
  replayIntentBuildUsageLedger,
  validateIntentBuildUsageEventV1,
  type IntentBuildUsageEventV1,
} from "../src/intent-build-metrics";

const GOLDEN = JSON.parse(readFileSync(
  new URL("./fixtures/intent-build-ablation.v1.golden.json", import.meta.url),
  "utf8",
)) as unknown;

const PLAN_STANDARD = {
  plan_id: "plan-standard",
  revision: 1,
  plan_digest: "a".repeat(64),
  confirmation_source: "explicit_legacy_command" as const,
};
const PLAN_GOAL = {
  plan_id: "plan-goal",
  revision: 2,
  plan_digest: "b".repeat(64),
  confirmation_source: "reader_ui" as const,
  intent_id: "intent-goal",
};
const TIMELINE = { artifact_id: "artifact-timeline", artifact_type: "timeline" as const };
const COMPARISON = { artifact_id: "artifact-comparison", artifact_type: "comparison_table" as const };

type EventInput = IntentBuildUsageEventV1 extends infer Event
  ? Event extends IntentBuildUsageEventV1
    ? Omit<Event, "version" | "book_id">
    : never
  : never;

function event(value: EventInput): IntentBuildUsageEventV1 {
  return validateIntentBuildUsageEventV1({
    version: "intent_build_usage_event.v1",
    book_id: "metrics-book",
    ...value,
  });
}

function fixtureEvents(): IntentBuildUsageEventV1[] {
  return [
    event({ event_id: "read-select", mode: "read_now", occurred_at: "2026-07-20T00:00:00.000Z", kind: "plan_selected", plan: null, estimate: null }),
    event({ event_id: "read-ready", mode: "read_now", occurred_at: "2026-07-20T00:00:01.000Z", kind: "reader_ready", plan: null }),
    event({
      event_id: "read-cost",
      mode: "read_now",
      occurred_at: "2026-07-20T00:00:03.000Z",
      kind: "cost_observed",
      plan: null,
      attempt_id: "read-attempt-1",
      outcome: "committed",
      wall_clock_ms: 2_000,
      usage: { source: "native", input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
    }),
    event({
      event_id: "standard-select",
      mode: "standard_deep",
      occurred_at: "2026-07-20T01:00:00.000Z",
      kind: "plan_selected",
      plan: PLAN_STANDARD,
      estimate: { token_lower: 100, token_upper: 200, token_coverage: 0.8, wall_clock_confidence: "low", unknown_item_count: 1 },
    }),
    event({ event_id: "standard-ready", mode: "standard_deep", occurred_at: "2026-07-20T01:00:00.500Z", kind: "reader_ready", plan: PLAN_STANDARD }),
    event({
      event_id: "standard-failed",
      mode: "standard_deep",
      occurred_at: "2026-07-20T01:01:00.000Z",
      kind: "cost_observed",
      plan: PLAN_STANDARD,
      attempt_id: "standard-attempt-1",
      outcome: "retryable_failure",
      wall_clock_ms: 4_000,
      usage: { source: "native", input_tokens: 30, output_tokens: 10 },
    }),
    event({
      event_id: "standard-committed",
      mode: "standard_deep",
      occurred_at: "2026-07-20T01:02:00.000Z",
      kind: "cost_observed",
      plan: PLAN_STANDARD,
      attempt_id: "standard-attempt-2",
      outcome: "committed",
      wall_clock_ms: 6_000,
      usage: { source: "executor_reported", input_tokens: 50, cached_input_tokens: 5, output_tokens: 20 },
    }),
    event({
      event_id: "goal-select",
      mode: "goal_directed",
      occurred_at: "2026-07-21T00:00:00.000Z",
      kind: "plan_selected",
      plan: PLAN_GOAL,
      estimate: { token_lower: 40, token_upper: 80, token_coverage: 1, wall_clock_p50_minutes: 2, wall_clock_p95_minutes: 4, wall_clock_confidence: "medium", unknown_item_count: 0 },
    }),
    event({ event_id: "goal-ready", mode: "goal_directed", occurred_at: "2026-07-21T00:00:00.200Z", kind: "reader_ready", plan: PLAN_GOAL }),
    event({
      event_id: "goal-timeline-failed",
      mode: "goal_directed",
      occurred_at: "2026-07-21T00:01:00.000Z",
      kind: "cost_observed",
      plan: PLAN_GOAL,
      artifact: TIMELINE,
      attempt_id: "timeline-attempt-1",
      outcome: "retryable_failure",
      wall_clock_ms: 1_000,
      usage: { source: "unavailable", estimate_method: "token_estimate.v1", estimated_input_tokens: 12, estimated_output_tokens: 4 },
    }),
    event({
      event_id: "goal-timeline-committed",
      mode: "goal_directed",
      occurred_at: "2026-07-21T00:02:00.000Z",
      kind: "cost_observed",
      plan: PLAN_GOAL,
      artifact: TIMELINE,
      attempt_id: "timeline-attempt-2",
      outcome: "committed",
      wall_clock_ms: 3_000,
      usage: { source: "native", input_tokens: 20, output_tokens: 8 },
    }),
    event({ event_id: "timeline-accepted", mode: "goal_directed", occurred_at: "2026-07-21T00:03:00.000Z", kind: "artifact_accepted", plan: PLAN_GOAL, artifact: TIMELINE, record_count: 2 }),
    event({ event_id: "comparison-accepted", mode: "goal_directed", occurred_at: "2026-07-22T00:00:00.000Z", kind: "artifact_accepted", plan: PLAN_GOAL, artifact: COMPARISON, record_count: 3 }),
    event({ event_id: "timeline-open", mode: "goal_directed", occurred_at: "2026-07-23T00:00:00.000Z", kind: "artifact_opened", plan: PLAN_GOAL, artifact: TIMELINE }),
    event({ event_id: "timeline-cite", mode: "goal_directed", occurred_at: "2026-07-24T00:00:00.000Z", kind: "artifact_cited", plan: PLAN_GOAL, artifact: TIMELINE, citation_count: 2 }),
  ];
}

describe("IP9 intent build usage ledger and ablation", () => {
  it("replays all attempt costs and separates seven-day open from citation consumption", () => {
    const report = replayIntentBuildUsageEvents(fixtureEvents(), {
      book_id: "metrics-book",
      as_of: "2026-07-26T00:00:00.000Z",
      window_days: 7,
    });
    expect(report.event_count).toBe(15);
    expect(report.modes.map((mode) => mode.mode)).toEqual(["read_now", "standard_deep", "goal_directed"]);
    expect(report.modes[0]).toMatchObject({ timing: { first_readable_ms: 1_000 }, actual: { input_tokens: 10, output_tokens: 5 } });
    expect(report.modes[1]).toMatchObject({
      selection_count: 1,
      estimate: { token_lower: 100, token_upper: 200, unknown_item_count: 1 },
      actual: {
        attempt_count: 2,
        outcome_counts: { committed: 1, retryable_failure: 1, needs_user: 0, cancelled: 0 },
        input_tokens: 80,
        output_tokens: 30,
        wall_clock_ms: 10_000,
      },
    });
    expect(report.modes[2]).toMatchObject({
      timing: { first_readable_ms: 200, first_goal_artifact_ms: 180_000 },
      actual: { attempt_count: 2, known_usage_attempts: 1, unavailable_usage_attempts: 1 },
      consumption_7d: {
        accepted_artifacts: 2,
        opened_artifacts: 1,
        cited_artifacts: 1,
        open_rate: 0.5,
        citation_rate: 0.5,
        open_events: 1,
        citation_events: 2,
      },
      artifact_costs: [{
        artifact_type: "timeline",
        attempt_count: 2,
        committed_attempts: 1,
        failed_or_cancelled_attempts: 1,
        input_tokens: 20,
        output_tokens: 8,
        wall_clock_ms: 4_000,
      }],
    });
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(report).toEqual(GOLDEN);
  });

  it("is deterministic, idempotent for exact duplicates, and rejects conflicting event ids", () => {
    const events = fixtureEvents();
    const options = { book_id: "metrics-book", as_of: "2026-07-26T00:00:00.000Z", window_days: 7 };
    const expected = replayIntentBuildUsageEvents(events, options);
    expect(replayIntentBuildUsageEvents([...events.slice().reverse(), events[0]], options)).toEqual(expected);
    expect(() => replayIntentBuildUsageEvents([
      events[0],
      { ...events[0], occurred_at: "2026-07-20T00:00:02.000Z" },
    ], options)).toThrow(/event_id conflicts/i);
  });

  it("rejects private text, artifact bodies, LIDs, quotes, and profile fields", () => {
    const base = fixtureEvents()[0];
    for (const privateField of ["user_goal", "payload", "evidence_lids", "quote", "profile"] as const) {
      expect(() => validateIntentBuildUsageEventV1({
        ...base,
        [privateField]: `PRIVATE_${privateField.toUpperCase()}_SENTINEL`,
      })).toThrow();
    }
    const report = replayIntentBuildUsageEvents(fixtureEvents(), {
      book_id: "metrics-book",
      as_of: "2026-07-26T00:00:00.000Z",
    });
    expect(report.privacy).toEqual({
      raw_goal: false,
      artifact_body: false,
      lid_or_quote: false,
      user_profile: false,
    });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|"user_goal"|"payload"|"evidence_lids"|"quote"|"profile"/u);
  });

  it("persists create-only event files and fails closed on conflicts or malformed ledger entries", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "intent-usage-ledger-"));
    try {
      const selected = fixtureEvents()[7];
      expect(appendIntentBuildUsageEvent(root, selected)).toMatchObject({
        event_id: selected.event_id,
        disposition: "created",
      });
      expect(appendIntentBuildUsageEvent(root, selected)).toMatchObject({ disposition: "existing" });
      expect(() => appendIntentBuildUsageEvent(root, {
        ...selected,
        occurred_at: "2026-07-21T00:00:01.000Z",
      })).toThrow(/conflicts/i);
      expect(readIntentBuildUsageEvents(root, "metrics-book")).toEqual([selected]);
      expect(replayIntentBuildUsageLedger(root, {
        book_id: "metrics-book",
        as_of: "2026-07-26T00:00:00.000Z",
      })).toMatchObject({ event_count: 1, modes: [{ mode: "read_now" }, { mode: "standard_deep" }, { mode: "goal_directed", selection_count: 1 }] });

      writeFileSync(
        path.join(root, "metrics-book", "usage", "events", "unexpected.txt"),
        "PRIVATE_RAW_GOAL_SENTINEL",
        "utf8",
      );
      expect(() => readIntentBuildUsageEvents(root, "metrics-book")).toThrow(/unexpected entry/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard-deletes only events bound to the selected private intent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "intent-usage-delete-"));
    try {
      const events = fixtureEvents();
      for (const item of [events[0], events[3], ...events.slice(7)]) {
        appendIntentBuildUsageEvent(root, item);
      }
      expect(deleteIntentBuildUsageForIntent(root, "metrics-book", "intent-goal")).toMatchObject({
        intent_id: "intent-goal",
        deleted_event_count: 8,
      });
      const remaining = readIntentBuildUsageEvents(root, "metrics-book");
      expect(remaining.map((item) => item.event_id)).toEqual(["read-select", "standard-select"]);
      expect(JSON.stringify(remaining)).not.toContain("intent-goal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
