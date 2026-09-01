import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeR7RolloutTrace,
  readExecutorMcpServerTimingJsonl,
  reduceExecutorMcpTiming,
  ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE,
  summarizeThreeSlotFirstTerminalScheduling,
  type ExecutorTraceOperation,
} from "../../../apps/desktop/scripts/r7-rollout-trace";
import { observeExecutorSlotInterval } from "../src/automatic-build-observation";

const executorServer = "understand_book_build_executor";
const executorRole = "understand_book_executor";
const executorTools = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
] as const satisfies readonly ExecutorTraceOperation[];

interface FixtureOptions {
  childIntervals?: Array<{ start: number; end: number }>;
  driverCallSeqs?: number[];
  listAgentObservations?: Array<{
    start: number;
    completedChildIndexes: number[];
    runningChildIndexes: number[];
  }>;
}

function traceFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-r7-trace-"));
  const payloadRoot = path.join(root, "payloads");
  mkdirSync(payloadRoot, { recursive: true });
  const rawPayloads: Record<string, unknown> = {};
  const traceEvents: unknown[] = [];
  let payloadOrdinal = 0;
  let traceSequence = 0;
  const writePayload = (kind: string, value: unknown): string => {
    payloadOrdinal += 1;
    const id = `raw_payload:${payloadOrdinal}`;
    const relative = `payloads/${payloadOrdinal}.json`;
    writeFileSync(path.join(root, relative), `${JSON.stringify(value)}\n`, "utf8");
    rawPayloads[id] = {
      raw_payload_id: id,
      kind: { type: kind },
      path: relative,
    };
    return id;
  };

  const childIntervals = options.childIntervals ?? [{ start: 10, end: 100 }];
  const threads: Record<string, unknown> = {
    root: {
      thread_id: "root",
      origin: { type: "root" },
      execution: { started_seq: 1, ended_seq: 200, status: "completed" },
    },
  };
  const toolCalls: Record<string, unknown> = {};
  const inferenceCalls: Record<string, unknown> = {};
  const sentinels: string[] = [];

  childIntervals.forEach((interval, childIndex) => {
    const threadId = `child-${childIndex + 1}`;
    const sentinel = `R7_SYNTHETIC_SENTINEL_${childIndex + 1}`;
    sentinels.push(sentinel);
    threads[threadId] = {
      thread_id: threadId,
      origin: {
        type: "spawned",
        parent_thread_id: "root",
        task_name: `r7_child_${childIndex + 1}`,
        agent_role: executorRole,
      },
      execution: {
        started_seq: interval.start,
        ended_seq: interval.end,
        status: "completed",
      },
    };

    executorTools.forEach((operation, operationIndex) => {
      const callId = `${threadId}-call-${operationIndex}`;
      const invocationId = writePayload("tool_invocation", {
        tool_namespace: `mcp__${executorServer}`,
        tool_name: operation.replaceAll(".", "_"),
        payload: {
          type: "function",
          arguments: JSON.stringify(operation === "executor.submit_candidate"
            ? { candidate: { marker: sentinel } }
            : { version: "synthetic" }),
        },
      });
      const runtimeId = writePayload("tool_runtime_event", {
        call_id: callId,
        invocation: { server: executorServer, tool: operation },
      });
      const semanticResponse = { action: { marker: sentinel }, version: "synthetic" };
      const responseValue = operation === "executor.input.next"
        ? {
          content: [{ type: "text", text: JSON.stringify(semanticResponse) }],
          isError: false,
        }
        : { status: "ok" };
      const resultId = writePayload("tool_result", {
        type: "code_mode_response",
        value: responseValue,
      });
      if (operation === "executor.input.next") {
        for (const responseText of [JSON.stringify(responseValue), JSON.stringify(semanticResponse)]) {
          writePayload("tool_result", {
            response: {
              Result: {
                cell_id: "4",
                content_items: [{ type: "input_text", text: responseText }],
                error_text: null,
              },
            },
          });
        }
      }
      const startedSeq = interval.start + 1 + operationIndex * 2;
      const startedAtMs = 1_000 + childIndex * 1_000 + operationIndex * 100;
      const outerElapsedMs = 50 + operationIndex;
      traceEvents.push({
        schema_version: 1,
        seq: ++traceSequence,
        wall_time_unix_ms: startedAtMs,
        rollout_id: "rollout-r7-fixture",
        codex_turn_id: `turn-${threadId}`,
        payload: { type: "tool_call_started", tool_call_id: callId },
      }, {
        schema_version: 1,
        seq: ++traceSequence,
        wall_time_unix_ms: startedAtMs + outerElapsedMs,
        rollout_id: "rollout-r7-fixture",
        codex_turn_id: `turn-${threadId}`,
        payload: { type: "tool_call_ended", tool_call_id: callId },
      });
      toolCalls[callId] = {
        tool_call_id: callId,
        thread_id: threadId,
        execution: { started_seq: startedSeq, ended_seq: startedSeq + 1, status: "completed" },
        raw_invocation_payload_id: invocationId,
        raw_runtime_payload_ids: [runtimeId],
        raw_result_payload_id: resultId,
        mcp_call_id: `mcp-${callId}`,
      };
    });

    const inferenceRequest = writePayload("inference_request", { input: sentinel });
    const inferenceResponse = writePayload("inference_response", { output: { status: "ok" } });
    inferenceCalls[`inference-${childIndex + 1}`] = {
      inference_call_id: `inference-${childIndex + 1}`,
      thread_id: threadId,
      execution: {
        started_seq: interval.start + 8,
        ended_seq: interval.start + 9,
        status: "completed",
      },
      raw_request_payload_id: inferenceRequest,
      raw_response_payload_id: inferenceResponse,
    };
  });

  for (const [index, startedSeq] of (options.driverCallSeqs ?? []).entries()) {
    const invocationId = writePayload("tool_invocation", {
      tool_namespace: null,
      tool_name: "exec",
      payload: { code: `node r7-synthetic-build-step.mjs phase-${index}` },
    });
    toolCalls[`driver-${index}`] = {
      tool_call_id: `driver-${index}`,
      thread_id: "root",
      execution: { started_seq: startedSeq, ended_seq: startedSeq + 1, status: "completed" },
      raw_invocation_payload_id: invocationId,
      raw_runtime_payload_ids: [],
      raw_result_payload_id: null,
      mcp_call_id: null,
    };
  }

  for (const [index, observation] of (options.listAgentObservations ?? []).entries()) {
    const invocationId = writePayload("tool_invocation", {
      tool_namespace: "collaboration",
      tool_name: "list_agents",
      payload: { type: "function", arguments: "{}" },
    });
    const completedLifecycle = JSON.stringify({
      version: "automatic_build_executor_lifecycle.v2",
      status: "committed",
      protocol: "automatic_build_executor_session.v3",
    });
    const agents = [
      { agent_name: "/root", agent_status: "running" },
      ...observation.completedChildIndexes.map((childIndex) => ({
        agent_name: `/root/r7_child_${childIndex}`,
        agent_status: { completed: completedLifecycle },
      })),
      ...observation.runningChildIndexes.map((childIndex) => ({
        agent_name: `/root/r7_child_${childIndex}`,
        agent_status: "running",
      })),
    ];
    const resultId = writePayload("tool_result", {
      type: "direct_response",
      response_item: {
        type: "function_call_output",
        call_id: `list-agents-${index}`,
        output: JSON.stringify({ agents }),
      },
    });
    toolCalls[`list-agents-${index}`] = {
      tool_call_id: `list-agents-${index}`,
      thread_id: "root",
      execution: {
        started_seq: observation.start,
        ended_seq: observation.start + 1,
        status: "completed",
      },
      raw_invocation_payload_id: invocationId,
      raw_runtime_payload_ids: [],
      raw_result_payload_id: resultId,
      mcp_call_id: null,
    };
    traceEvents.push({
      schema_version: 1,
      seq: ++traceSequence,
      wall_time_unix_ms: 5_000 + observation.start,
      rollout_id: "rollout-r7-fixture",
      codex_turn_id: "turn-root",
      payload: { type: "tool_call_started", tool_call_id: `list-agents-${index}` },
    }, {
      schema_version: 1,
      seq: ++traceSequence,
      wall_time_unix_ms: 5_005 + observation.start,
      rollout_id: "rollout-r7-fixture",
      codex_turn_id: "turn-root",
      payload: { type: "tool_call_ended", tool_call_id: `list-agents-${index}` },
    });
  }

  const state = {
    schema_version: 1,
    rollout_id: "rollout-r7-fixture",
    root_thread_id: "root",
    threads,
    tool_calls: toolCalls,
    inference_calls: inferenceCalls,
    raw_payloads: rawPayloads,
  };
  writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    rollout_id: state.rollout_id,
    root_thread_id: state.root_thread_id,
  })}\n`, "utf8");
  writeFileSync(
    path.join(root, "trace.jsonl"),
    `${traceEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(path.join(root, "state.json"), `${JSON.stringify(state)}\n`, "utf8");
  return { root, sentinels };
}

function analyze(root: string, sentinels: string[], childCount: number, driver = false) {
  return analyzeR7RolloutTrace({
    bundle_root: root,
    executor_server_name: executorServer,
    executor_tool_names: executorTools,
    executor_agent_role: executorRole,
    expected_dedicated_child_count: childCount,
    semantic_sentinels: sentinels,
    ...(driver ? { synthetic_build_step_marker: "r7-synthetic-build-step.mjs" } : {}),
  });
}

describe("R7 reduced rollout trace analyzer", () => {
  it("M1 reads only the body-free Executor timing projection from one connection JSONL", () => {
    const samples = [
      {
        version: "executor_mcp_server_timing.v2",
        connection_call_ordinal: 1,
        operation: "executor.open",
        server_elapsed_ms: 10.5,
        response_bytes: 123,
        response_action_kind: "DELIVER_INPUT",
        outcome: "ok",
        server_phase_elapsed_ms: null,
      },
      {
        version: "executor_mcp_server_timing.v2",
        connection_call_ordinal: 2,
        operation: "executor.input.next",
        server_elapsed_ms: 2,
        response_bytes: 456,
        response_action_kind: null,
        outcome: "bounded_error",
        server_phase_elapsed_ms: null,
      },
    ];
    const stderr = samples.map((sample) => JSON.stringify(sample)).join("\n");

    expect(readExecutorMcpServerTimingJsonl(stderr, "fixed connection")).toEqual(samples);
  });

  it("M1b accepts exact long-operation phases and rejects an uncovered server interval", () => {
    const sample = {
      version: "executor_mcp_server_timing.v2",
      connection_call_ordinal: 1,
      operation: "executor.generation.start",
      server_elapsed_ms: 12,
      response_bytes: 123,
      response_action_kind: "GENERATE",
      outcome: "ok",
      server_phase_elapsed_ms: {
        "current-state/claim": 3,
        "input-render-or-reuse": 7,
        "persist/response": 2,
      },
    };

    expect(readExecutorMcpServerTimingJsonl(JSON.stringify(sample), "fixed connection"))
      .toEqual([sample]);
    expect(() => readExecutorMcpServerTimingJsonl(JSON.stringify({
      ...sample,
      server_phase_elapsed_ms: {
        ...sample.server_phase_elapsed_ms,
        "persist/response": 1,
      },
    }), "fixed connection")).toThrow("do not cover the server interval");
  });

  it("M1 rejects a connection timing line that carries an extra semantic field", () => {
    const stderr = JSON.stringify({
      version: "executor_mcp_server_timing.v2",
      connection_call_ordinal: 1,
      operation: "executor.open",
      server_elapsed_ms: 1,
      response_bytes: 10,
      response_action_kind: "WAIT",
      outcome: "ok",
      server_phase_elapsed_ms: null,
      payload: "M1_PRIVATE_SEMANTIC_SENTINEL",
    });

    expect(() => readExecutorMcpServerTimingJsonl(stderr, "fixed connection"))
      .toThrow("outside the Executor timing contract");
  });

  it("M1 joins per-connection server ordinals to outer child calls without cross-thread leakage", () => {
    const sensitive = "M1_SEMANTIC_CANDIDATE_REF_PATH_SENTINEL";
    const connections = [1, 2, 3].map((child) => ({
      thread_id: `child-${child}`,
      samples: [
        {
          version: "executor_mcp_server_timing.v2" as const,
          connection_call_ordinal: 1,
          operation: "executor.open" as const,
          server_elapsed_ms: 10 + child,
          response_bytes: 100 + child,
          response_action_kind: "WAIT",
          outcome: "ok" as const,
          server_phase_elapsed_ms: null,
          private_debug: `${sensitive}:${child}`,
        },
        {
          version: "executor_mcp_server_timing.v2" as const,
          connection_call_ordinal: 2,
          operation: "executor.input.next" as const,
          server_elapsed_ms: 20 + child,
          response_bytes: 200 + child,
          response_action_kind: "INPUT_CHUNK",
          outcome: "ok" as const,
          server_phase_elapsed_ms: null,
        },
      ],
    }));
    const outer_samples = connections.flatMap((connection, index) => connection.samples.map((sample) => ({
      thread_id: connection.thread_id,
      connection_call_ordinal: sample.connection_call_ordinal,
      operation: sample.operation,
      outer_tool_call_elapsed_ms: sample.server_elapsed_ms + 30 + index,
      private_debug: sensitive,
    })));

    const reduced = reduceExecutorMcpTiming({ connections, outer_samples });

    expect(reduced.samples).toHaveLength(6);
    expect(reduced.samples.map((sample) => (
      `${sample.thread_id}:${sample.connection_call_ordinal}:${sample.operation}`
    ))).toEqual([
      "child-1:1:executor.open",
      "child-1:2:executor.input.next",
      "child-2:1:executor.open",
      "child-2:2:executor.input.next",
      "child-3:1:executor.open",
      "child-3:2:executor.input.next",
    ]);
    expect(reduced.totals["executor.open"]).toEqual({
      call_count: 3,
      server_total_ms: 36,
      outer_total_ms: 129,
      residual_total_ms: 93,
      response_total_bytes: 306,
    });
    expect(reduced.totals["executor.input.next"]).toEqual({
      call_count: 3,
      server_total_ms: 66,
      outer_total_ms: 159,
      residual_total_ms: 93,
      response_total_bytes: 606,
    });
    expect(reduced.samples.every((sample) => sample.residual_ms >= 0)).toBe(true);
    expect(JSON.stringify(reduced)).not.toContain(sensitive);
  });

  it("M1 rejects a join whose outer elapsed is shorter than its server interval", () => {
    expect(() => reduceExecutorMcpTiming({
      connections: [{
        thread_id: "child-1",
        samples: [{
          version: "executor_mcp_server_timing.v2",
          connection_call_ordinal: 1,
          operation: "executor.open",
          server_elapsed_ms: 11,
          response_bytes: 100,
          response_action_kind: "WAIT",
          outcome: "ok",
          server_phase_elapsed_ms: null,
        }],
      }],
      outer_samples: [{
        thread_id: "child-1",
        connection_call_ordinal: 1,
        operation: "executor.open",
        outer_tool_call_elapsed_ms: 10,
      }],
    })).toThrow("negative residual");
  });

  it("joins dedicated-child exact-four dispatch and backend calls without root leakage", () => {
    const fixture = traceFixture();
    const result = analyze(fixture.root, fixture.sentinels, 1);

    expect(result).toMatchObject({
      root_executor_dispatch_attempt_count: 0,
      root_executor_backend_call_count: 0,
      other_child_executor_dispatch_attempt_count: 0,
      other_child_executor_backend_call_count: 0,
      child_executor_tool_count: 4,
      first_child_dispatch: "executor.open",
      first_child_backend_call: "executor.open",
      max_live_dedicated_children: 1,
    });
    expect(result.child_executor_tools).toEqual([...executorTools].sort());
    expect(result.executor_outer_timing_samples).toEqual(executorTools.map((operation, index) => ({
      thread_id: "child-1",
      connection_call_ordinal: index + 1,
      operation,
      outer_tool_call_elapsed_ms: 50 + index,
    })));
    expect(result.semantic_hit_shapes.executor_input_or_submit).toBeGreaterThan(0);
    expect(result.semantic_hit_shapes.dedicated_child_inference).toBeGreaterThan(0);
    expect(result.semantic_hit_shapes.bounded_response_only).toBeGreaterThan(0);
  });

  it("rejects an unowned response-only envelope unless it directly matches an attributed child result", () => {
    const fixture = traceFixture();
    const statePath = path.join(fixture.root, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      raw_payloads: Record<string, { path: string }>;
    };
    const responseOnly = Object.values(state.raw_payloads).find((reference) => {
      const value = JSON.parse(readFileSync(path.join(fixture.root, reference.path), "utf8")) as {
        response?: unknown;
      };
      return value.response !== undefined;
    });
    expect(responseOnly).toBeDefined();
    writeFileSync(path.join(fixture.root, responseOnly!.path), `${JSON.stringify({
      response: {
        Result: {
          cell_id: "4",
          content_items: [{
            type: "input_text",
            text: JSON.stringify({ marker: fixture.sentinels[0], unexpected: true }),
          }],
          error_text: null,
        },
      },
    })}\n`, "utf8");

    expect(() => analyze(fixture.root, fixture.sentinels, 1))
      .toThrow("semantic sentinel escaped the dedicated Executor trace shapes");
  });

  it("fails as unverifiable when an MCP call has no runtime-begin join", () => {
    const fixture = traceFixture();
    const statePath = path.join(fixture.root, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      tool_calls: Record<string, { raw_runtime_payload_ids: string[] }>;
    };
    state.tool_calls["child-1-call-0"].raw_runtime_payload_ids = [];
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

    expect(() => analyze(fixture.root, fixture.sentinels, 1))
      .toThrow(ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE);
  });

  it("fails as unverifiable when an Executor-shaped dispatch loses its namespace", () => {
    const fixture = traceFixture();
    const statePath = path.join(fixture.root, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      tool_calls: Record<string, { raw_invocation_payload_id: string }>;
      raw_payloads: Record<string, { path: string }>;
    };
    const invocationId = state.tool_calls["child-1-call-0"].raw_invocation_payload_id;
    const invocationPath = path.join(fixture.root, state.raw_payloads[invocationId].path);
    const invocation = JSON.parse(readFileSync(invocationPath, "utf8")) as {
      tool_namespace: string | null;
    };
    invocation.tool_namespace = null;
    writeFileSync(invocationPath, `${JSON.stringify(invocation)}\n`, "utf8");

    expect(() => analyze(fixture.root, fixture.sentinels, 1))
      .toThrow(ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE);
  });

  it("rejects a root Executor dispatch even when its backend correlation is complete", () => {
    const fixture = traceFixture();
    const statePath = path.join(fixture.root, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      tool_calls: Record<string, { thread_id: string }>;
    };
    state.tool_calls["child-1-call-0"].thread_id = "root";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

    expect(() => analyze(fixture.root, fixture.sentinels, 1))
      .toThrow("root dispatched an Executor tool");
  });

  it("proves a fourth child refills after first terminal while two siblings remain live", () => {
    const fixture = traceFixture({
      childIntervals: [
        { start: 10, end: 50 },
        { start: 11, end: 100 },
        { start: 12, end: 110 },
        { start: 60, end: 150 },
      ],
      driverCallSeqs: [5, 60, 160],
      listAgentObservations: [
        { start: 55, completedChildIndexes: [1], runningChildIndexes: [2, 3] },
        { start: 65, completedChildIndexes: [1], runningChildIndexes: [2, 3, 4] },
        { start: 120, completedChildIndexes: [1, 2, 3], runningChildIndexes: [4] },
        { start: 155, completedChildIndexes: [3, 4], runningChildIndexes: [] },
      ],
    });
    const result = analyze(fixture.root, fixture.sentinels, 4, true);

    expect(result.max_live_dedicated_children).toBe(3);
    expect(result.executor_slot_lifecycle_observations).toEqual([
      { observed_at_ms: 5_060, live_slots: 2 },
      { observed_at_ms: 5_070, live_slots: 3 },
      { observed_at_ms: 5_125, live_slots: 1 },
      { observed_at_ms: 5_160, live_slots: 0 },
    ]);
    expect(summarizeThreeSlotFirstTerminalScheduling(
      result.executor_slot_lifecycle_observations,
      3,
    )).toEqual({
      version: "executor_synthetic_scheduling_evidence.v1",
      slot_capacity: 3,
      lifecycle_observations: result.executor_slot_lifecycle_observations,
      cause_totals: [
        {
          idle_reason: "root_refill_gap",
          interval_count: 1,
          observed_ms: 10,
          idle_slot_ms_lower_bound: 10,
          idle_slot_ms_upper_bound: 30,
        },
        {
          idle_reason: "tail_imbalance",
          interval_count: 1,
          observed_ms: 35,
          idle_slot_ms_lower_bound: 70,
          idle_slot_ms_upper_bound: 105,
        },
      ],
      dominant_avoidable_idle_reason: "tail_imbalance",
    });
    expect(summarizeThreeSlotFirstTerminalScheduling([
      { observed_at_ms: 5_060, live_slots: 2 },
      { observed_at_ms: 5_070, live_slots: 1 },
      { observed_at_ms: 5_160, live_slots: 0 },
    ], 3, 5_065)).toMatchObject({
      cause_totals: [
        {
          idle_reason: "root_refill_gap",
          observed_ms: 5,
          idle_slot_ms_lower_bound: 5,
          idle_slot_ms_upper_bound: 15,
        },
        {
          idle_reason: "tail_imbalance",
          observed_ms: 90,
          idle_slot_ms_lower_bound: 180,
          idle_slot_ms_upper_bound: 270,
        },
      ],
      dominant_avoidable_idle_reason: "tail_imbalance",
    });
    expect(observeExecutorSlotInterval({
      slot_capacity: 3,
      start: result.executor_slot_lifecycle_observations[0],
      end_observed_at_ms: result.executor_slot_lifecycle_observations[1].observed_at_ms,
      remaining_work: [{
        stage: "pass1",
        kind: "pass1_window",
        pending: 1,
        reserved: 0,
        running: 2,
        terminal: 1,
      }],
      stage_barrier: false,
    })).toMatchObject({
      live_slots: 2,
      idle_slots: 1,
      idle_reason: "root_refill_gap",
      observed_ms: 10,
    });
    expect(observeExecutorSlotInterval({
      slot_capacity: 3,
      start: result.executor_slot_lifecycle_observations[2],
      end_observed_at_ms: result.executor_slot_lifecycle_observations[3].observed_at_ms,
      remaining_work: [{
        stage: "pass1",
        kind: "pass1_window",
        pending: 0,
        reserved: 0,
        running: 1,
        terminal: 3,
      }],
      stage_barrier: false,
    })).toMatchObject({
      live_slots: 1,
      idle_slots: 2,
      idle_reason: "tail_imbalance",
      observed_ms: 35,
    });
    expect(result.fourth_child_started_after_first_terminal).toBe(true);
    expect(result.fourth_child_started_before_last_initial_terminal).toBe(true);
    expect(result.synthetic_build_step_call_count).toBe(3);
    expect(result.first_partial_completion_observed_seq).toBe(56);
    expect(result.all_dedicated_terminal_observed_seq).toBe(156);
    expect(result.synthetic_build_step_started_seqs[1]).toBeGreaterThan(56);
    expect(result.synthetic_build_step_started_seqs[2]).toBeGreaterThan(156);
  });

  it("fails as unverifiable when root never observes cumulative completion for all children", () => {
    const fixture = traceFixture({
      childIntervals: [
        { start: 10, end: 50 },
        { start: 11, end: 100 },
        { start: 12, end: 110 },
        { start: 60, end: 150 },
      ],
      driverCallSeqs: [5, 60, 160],
      listAgentObservations: [
        { start: 55, completedChildIndexes: [1], runningChildIndexes: [2, 3] },
      ],
    });

    expect(() => analyze(fixture.root, fixture.sentinels, 4, true))
      .toThrow(ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE);
  });
});
