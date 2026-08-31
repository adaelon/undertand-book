import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeR7RolloutTrace,
  ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE,
  type ExecutorTraceOperation,
} from "../../../apps/desktop/scripts/r7-rollout-trace";

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
  let payloadOrdinal = 0;
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
        { start: 155, completedChildIndexes: [3, 4], runningChildIndexes: [] },
      ],
    });
    const result = analyze(fixture.root, fixture.sentinels, 4, true);

    expect(result.max_live_dedicated_children).toBe(3);
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
