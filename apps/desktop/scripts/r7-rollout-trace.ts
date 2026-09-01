import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

type JsonObject = Record<string, unknown>;

export const ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE = "root_executor_boundary_unverifiable";

export type ExecutorTraceOperation =
  | "executor.open"
  | "executor.input.next"
  | "executor.generation.start"
  | "executor.submit_candidate";

const EXECUTOR_TRACE_OPERATIONS = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
] as const satisfies readonly ExecutorTraceOperation[];

export interface ExecutorMcpServerTimingV2 {
  version: "executor_mcp_server_timing.v2";
  connection_call_ordinal: number;
  operation: ExecutorTraceOperation;
  server_elapsed_ms: number;
  response_bytes: number;
  response_action_kind: string | null;
  outcome: "ok" | "bounded_error";
  server_phase_elapsed_ms: ExecutorMcpServerPhaseElapsedV2 | null;
}

export type ExecutorMcpServerPhaseElapsedV2 =
  | {
      "current-state/claim": number;
      "input-render-or-reuse": number;
      "persist/response": number;
    }
  | {
      "candidate-gate": number;
      "writer/commit": number;
      "next-work-prepare": number;
    };

export interface ExecutorMcpTimingConnectionV2 {
  thread_id: string;
  samples: readonly ExecutorMcpServerTimingV2[];
}

export interface ExecutorOuterTimingV1 {
  thread_id: string;
  connection_call_ordinal: number;
  operation: ExecutorTraceOperation;
  outer_tool_call_elapsed_ms: number;
}

export interface ExecutorMcpTimingJoinSampleV2 {
  thread_id: string;
  connection_call_ordinal: number;
  operation: ExecutorTraceOperation;
  server_elapsed_ms: number;
  outer_tool_call_elapsed_ms: number;
  residual_ms: number;
  response_bytes: number;
  response_action_kind: string | null;
  outcome: "ok" | "bounded_error";
  server_phase_elapsed_ms: ExecutorMcpServerPhaseElapsedV2 | null;
}

export interface ExecutorMcpTimingOperationTotalV2 {
  call_count: number;
  server_total_ms: number;
  outer_total_ms: number;
  residual_total_ms: number;
  response_total_bytes: number;
}

export interface ExecutorMcpTimingJoinV2 {
  version: "executor_mcp_timing_join.v2";
  samples: ExecutorMcpTimingJoinSampleV2[];
  totals: Record<ExecutorTraceOperation, ExecutorMcpTimingOperationTotalV2>;
}

function serverPhaseElapsed(
  sample: ExecutorMcpServerTimingV2,
): ExecutorMcpServerPhaseElapsedV2 | null {
  const phases = sample.server_phase_elapsed_ms;
  if (phases === null) {
    if (sample.outcome === "ok"
      && (sample.operation === "executor.generation.start"
        || sample.operation === "executor.submit_candidate")) {
      timingFailure("successful long operation is missing server phases");
    }
    return null;
  }
  if (!isRecord(phases)) timingFailure("server phases are not an object");
  const expected = sample.operation === "executor.generation.start"
    ? ["current-state/claim", "input-render-or-reuse", "persist/response"]
    : sample.operation === "executor.submit_candidate"
      ? ["candidate-gate", "writer/commit", "next-work-prepare"]
      : undefined;
  if (!expected || !hasExactKeys(phases, expected)) {
    timingFailure("server phases do not match the operation");
  }
  const phaseRecord = phases as Record<string, unknown>;
  const elapsed = Object.fromEntries(expected.map((phase) => [
    phase,
    nonNegativeFinite(phaseRecord[phase] as number, `server phase ${phase}`),
  ])) as ExecutorMcpServerPhaseElapsedV2;
  const phaseTotal = Object.values(elapsed).reduce((sum, value) => sum + value, 0);
  if (Math.abs(phaseTotal - sample.server_elapsed_ms) > 0.000_001) {
    timingFailure("server phases do not cover the server interval");
  }
  return elapsed;
}

function timingFailure(message: string): never {
  throw new Error(`executor_mcp_timing_unverifiable: ${message}`);
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) timingFailure(`${label} is not non-negative`);
  return value;
}

function timingOperation(value: string, label: string): ExecutorTraceOperation {
  if (!(EXECUTOR_TRACE_OPERATIONS as readonly string[]).includes(value)) {
    timingFailure(`${label} is not an Executor operation`);
  }
  return value as ExecutorTraceOperation;
}

export function reduceExecutorMcpTiming(options: {
  connections: readonly ExecutorMcpTimingConnectionV2[];
  outer_samples: readonly ExecutorOuterTimingV1[];
}): ExecutorMcpTimingJoinV2 {
  const outerByCall = new Map<string, ExecutorOuterTimingV1>();
  for (const sample of options.outer_samples) {
    if (!sample.thread_id) timingFailure("outer sample thread_id is missing");
    if (!Number.isSafeInteger(sample.connection_call_ordinal) || sample.connection_call_ordinal < 1) {
      timingFailure("outer sample ordinal is invalid");
    }
    timingOperation(sample.operation, "outer sample operation");
    nonNegativeFinite(sample.outer_tool_call_elapsed_ms, "outer elapsed");
    const key = `${sample.thread_id}\u0000${sample.connection_call_ordinal}`;
    if (outerByCall.has(key)) timingFailure(`duplicate outer sample for ${sample.thread_id} ordinal ${sample.connection_call_ordinal}`);
    outerByCall.set(key, sample);
  }

  const totals = Object.fromEntries(EXECUTOR_TRACE_OPERATIONS.map((operation) => [operation, {
    call_count: 0,
    server_total_ms: 0,
    outer_total_ms: 0,
    residual_total_ms: 0,
    response_total_bytes: 0,
  }])) as Record<ExecutorTraceOperation, ExecutorMcpTimingOperationTotalV2>;
  const samples: ExecutorMcpTimingJoinSampleV2[] = [];
  const connectionThreads = new Set<string>();
  for (const connection of options.connections) {
    if (!connection.thread_id) timingFailure("connection thread_id is missing");
    if (connectionThreads.has(connection.thread_id)) {
      timingFailure(`duplicate connection for thread ${connection.thread_id}`);
    }
    connectionThreads.add(connection.thread_id);
    for (const [index, server] of connection.samples.entries()) {
      const expectedOrdinal = index + 1;
      if (server.version !== "executor_mcp_server_timing.v2") {
        timingFailure(`server sample ${connection.thread_id}:${expectedOrdinal} has an incompatible version`);
      }
      if (server.connection_call_ordinal !== expectedOrdinal) {
        timingFailure(`server ordinals are not contiguous for thread ${connection.thread_id}`);
      }
      const operation = timingOperation(server.operation, "server sample operation");
      const serverElapsed = nonNegativeFinite(server.server_elapsed_ms, "server elapsed");
      const phaseElapsed = serverPhaseElapsed(server);
      if (!Number.isSafeInteger(server.response_bytes) || server.response_bytes < 0) {
        timingFailure("server response_bytes is invalid");
      }
      const key = `${connection.thread_id}\u0000${expectedOrdinal}`;
      const outer = outerByCall.get(key);
      if (!outer) timingFailure(`missing outer sample for ${connection.thread_id} ordinal ${expectedOrdinal}`);
      if (outer.operation !== operation) {
        timingFailure(`operation mismatch for ${connection.thread_id} ordinal ${expectedOrdinal}`);
      }
      const residual = outer.outer_tool_call_elapsed_ms - serverElapsed;
      if (residual < 0) timingFailure(`negative residual for ${connection.thread_id} ordinal ${expectedOrdinal}`);
      outerByCall.delete(key);
      samples.push({
        thread_id: connection.thread_id,
        connection_call_ordinal: expectedOrdinal,
        operation,
        server_elapsed_ms: serverElapsed,
        outer_tool_call_elapsed_ms: outer.outer_tool_call_elapsed_ms,
        residual_ms: residual,
        response_bytes: server.response_bytes,
        response_action_kind: server.response_action_kind,
        outcome: server.outcome,
        server_phase_elapsed_ms: phaseElapsed,
      });
      const total = totals[operation];
      total.call_count += 1;
      total.server_total_ms += serverElapsed;
      total.outer_total_ms += outer.outer_tool_call_elapsed_ms;
      total.residual_total_ms += residual;
      total.response_total_bytes += server.response_bytes;
    }
  }
  if (outerByCall.size > 0) timingFailure("outer samples contain calls without a server sample");
  return { version: "executor_mcp_timing_join.v2", samples, totals };
}

export interface R7TraceThread {
  thread_id: string;
  origin_type: "root" | "spawned";
  parent_thread_id: string | null;
  task_name: string | null;
  agent_role: string | null;
  started_seq: number;
  ended_seq: number;
  status: string;
}

export interface R7ExecutorTraceCall {
  tool_call_id: string;
  thread_id: string;
  operation: ExecutorTraceOperation;
  dispatch_attempt: true;
  backend_call: boolean;
  status: string;
  started_seq: number;
  ended_seq: number;
}

export interface R7RolloutTraceAnalysis {
  root_thread_id: string;
  thread_attribution_complete: true;
  dedicated_child_threads: R7TraceThread[];
  executor_calls: R7ExecutorTraceCall[];
  executor_outer_timing_samples: ExecutorOuterTimingV1[];
  root_executor_dispatch_attempt_count: number;
  root_executor_backend_call_count: number;
  other_child_executor_dispatch_attempt_count: number;
  other_child_executor_backend_call_count: number;
  child_executor_tool_count: number;
  child_executor_tools: ExecutorTraceOperation[];
  first_child_dispatch: ExecutorTraceOperation;
  first_child_backend_call: ExecutorTraceOperation;
  semantic_hit_count: number;
  semantic_hit_shapes: {
    executor_input_or_submit: number;
    dedicated_child_inference: number;
    bounded_response_only: number;
  };
  max_live_dedicated_children: number;
  executor_slot_lifecycle_observations: Array<{
    observed_at_ms: number;
    live_slots: number;
  }>;
  executor_refill_started_at_ms: number | null;
  fourth_child_started_after_first_terminal: boolean | null;
  fourth_child_started_before_last_initial_terminal: boolean | null;
  synthetic_build_step_call_count: number;
  synthetic_build_step_started_seqs: number[];
  first_partial_completion_observed_seq: number | null;
  all_dedicated_terminal_observed_seq: number | null;
}

export interface ExecutorSyntheticSchedulingEvidenceV1 {
  version: "executor_synthetic_scheduling_evidence.v1";
  slot_capacity: number;
  lifecycle_observations: ExecutorSlotLifecycleObservationV1[];
  cause_totals: Array<{
    idle_reason: "root_refill_gap" | "tail_imbalance";
    interval_count: number;
    observed_ms: number;
    idle_slot_ms_lower_bound: number;
    idle_slot_ms_upper_bound: number;
  }>;
  dominant_avoidable_idle_reason: "root_refill_gap" | "tail_imbalance" | null;
}

export interface ExecutorSlotLifecycleObservationV1 {
  observed_at_ms: number;
  live_slots: number;
}

export function summarizeThreeSlotFirstTerminalScheduling(
  lifecycleObservations: readonly ExecutorSlotLifecycleObservationV1[],
  slotCapacity = 3,
  refillStartedAtMs?: number,
): ExecutorSyntheticSchedulingEvidenceV1 {
  if (!Number.isSafeInteger(slotCapacity) || slotCapacity < 1) {
    throw new Error("executor scheduling slot capacity is invalid");
  }
  if (lifecycleObservations.length < 3) {
    throw new Error("executor scheduling lifecycle evidence is incomplete");
  }
  const observations = lifecycleObservations.map((observation, index) => {
    if (!Number.isFinite(observation.observed_at_ms) || observation.observed_at_ms < 0
      || !Number.isSafeInteger(observation.live_slots) || observation.live_slots < 0
      || observation.live_slots > slotCapacity) {
      throw new Error("executor scheduling lifecycle observation is invalid");
    }
    if (index > 0 && observation.observed_at_ms <= lifecycleObservations[index - 1].observed_at_ms) {
      throw new Error("executor scheduling lifecycle observations are not strictly ordered");
    }
    return { ...observation };
  });
  const refillStartIndex = observations.findIndex((observation, index) => (
    index < observations.length - 1
    && observation.live_slots > 0
    && observation.live_slots < slotCapacity
  ));
  if (refillStartIndex < 0) {
    throw new Error("executor scheduling trace has no first-terminal refill observation");
  }
  const refillFullIndex = observations.findIndex((observation, index) => (
    index > refillStartIndex && observation.live_slots === slotCapacity
  ));
  const refillStartedAt = refillStartedAtMs ?? (refillFullIndex >= 0
    ? observations[refillFullIndex].observed_at_ms
    : undefined);
  if (refillStartedAt === undefined || !Number.isFinite(refillStartedAt)
    || refillStartedAt <= observations[refillStartIndex].observed_at_ms
    || refillStartedAt >= observations.at(-1)!.observed_at_ms) {
    throw new Error("executor scheduling trace has no valid refill start boundary");
  }
  if (observations.at(-1)?.live_slots !== 0) {
    throw new Error("executor scheduling trace has no terminal zero-live observation");
  }

  const totals = new Map<"root_refill_gap" | "tail_imbalance", {
    interval_count: number;
    observed_ms: number;
    idle_slot_ms_lower_bound: number;
    idle_slot_ms_upper_bound: number;
  }>([
    ["root_refill_gap", {
      interval_count: 0,
      observed_ms: 0,
      idle_slot_ms_lower_bound: 0,
      idle_slot_ms_upper_bound: 0,
    }],
    ["tail_imbalance", {
      interval_count: 0,
      observed_ms: 0,
      idle_slot_ms_lower_bound: 0,
      idle_slot_ms_upper_bound: 0,
    }],
  ]);
  const refillStart = observations[refillStartIndex];
  const refillGapMs = refillStartedAt - refillStart.observed_at_ms;
  const refillTotal = totals.get("root_refill_gap")!;
  refillTotal.interval_count = 1;
  refillTotal.observed_ms = refillGapMs;
  refillTotal.idle_slot_ms_lower_bound = (slotCapacity - refillStart.live_slots) * refillGapMs;
  refillTotal.idle_slot_ms_upper_bound = slotCapacity * refillGapMs;

  const tailStartIndex = observations.findIndex((observation) => (
    observation.observed_at_ms >= refillStartedAt
  ));
  if (tailStartIndex < 0) {
    throw new Error("executor scheduling trace has no post-refill lifecycle observation");
  }
  for (let index = tailStartIndex; index < observations.length - 1; index += 1) {
    const start = observations[index];
    if (start.live_slots === slotCapacity || start.live_slots === 0) continue;
    const observedMs = observations[index + 1].observed_at_ms - start.observed_at_ms;
    const total = totals.get("tail_imbalance")!;
    total.interval_count += 1;
    total.observed_ms += observedMs;
    total.idle_slot_ms_lower_bound += (slotCapacity - start.live_slots) * observedMs;
    total.idle_slot_ms_upper_bound += slotCapacity * observedMs;
  }
  const causeTotals = (["root_refill_gap", "tail_imbalance"] as const).map((idleReason) => ({
    idle_reason: idleReason,
    ...totals.get(idleReason)!,
  }));
  const rootRefill = causeTotals.find((total) => total.idle_reason === "root_refill_gap")!;
  const tail = causeTotals.find((total) => total.idle_reason === "tail_imbalance")!;
  const dominant = rootRefill.idle_slot_ms_lower_bound > tail.idle_slot_ms_upper_bound
    ? "root_refill_gap"
    : tail.idle_slot_ms_lower_bound > rootRefill.idle_slot_ms_upper_bound
      ? "tail_imbalance"
      : null;
  return {
    version: "executor_synthetic_scheduling_evidence.v1",
    slot_capacity: slotCapacity,
    lifecycle_observations: observations,
    cause_totals: causeTotals,
    dominant_avoidable_idle_reason: dominant,
  };
}

export interface AnalyzeR7RolloutTraceOptions {
  bundle_root: string;
  executor_server_name: string;
  executor_tool_names: readonly ExecutorTraceOperation[];
  executor_agent_role: string;
  expected_dedicated_child_count: number;
  semantic_sentinels: readonly string[];
  synthetic_build_step_marker?: string;
}

interface RawPayload {
  id: string;
  kind: string;
  text: string;
  value: JsonObject;
}

interface ToolCallRecord {
  tool_call_id: string;
  thread_id: string;
  execution: { started_seq: number; ended_seq: number; status: string };
  raw_invocation_payload_id: string;
  raw_runtime_payload_ids: string[];
  raw_result_payload_id: string | null;
  mcp_call_id: string | null;
}

interface AgentStatusObservation {
  ended_seq: number;
  observed_at_ms: number;
  completed_task_names: string[];
  running_task_names: string[];
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unverifiable(message: string): never {
  throw new Error(`${ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE}: ${message}`);
}

function requiredRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) unverifiable(`${label} is not an object`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) unverifiable(`${label} is missing`);
  return value;
}

function requiredSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    unverifiable(`${label} is not a sequence number`);
  }
  return value as number;
}

function readJsonObject(file: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    unverifiable(`${label} is unreadable: ${String(error)}`);
  }
  return requiredRecord(value, label);
}

function mapRecord(value: unknown, label: string): JsonObject {
  return requiredRecord(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    unverifiable(`${label} is not a string array`);
  }
  return [...value] as string[];
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function readExecutorMcpServerTimingJsonl(value: string, label: string): ExecutorMcpServerTimingV2[] {
  const keys = [
    "version",
    "connection_call_ordinal",
    "operation",
    "server_elapsed_ms",
    "response_bytes",
    "response_action_kind",
    "outcome",
    "server_phase_elapsed_ms",
  ] as const;
  const samples: ExecutorMcpServerTimingV2[] = [];
  for (const [index, line] of value.split(/\r?\n/u).filter(Boolean).entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      timingFailure(`${label} line ${index + 1} is not Executor timing JSON: ${String(error)}`);
    }
    if (!isRecord(raw) || !hasExactKeys(raw, keys)) {
      timingFailure(`${label} line ${index + 1} is outside the Executor timing contract`);
    }
    if (raw.version !== "executor_mcp_server_timing.v2") {
      timingFailure(`${label} line ${index + 1} has an incompatible timing version`);
    }
    if (!Number.isSafeInteger(raw.connection_call_ordinal) || (raw.connection_call_ordinal as number) < 1) {
      timingFailure(`${label} line ${index + 1} has an invalid connection ordinal`);
    }
    const operation = timingOperation(String(raw.operation), `${label} line ${index + 1} operation`);
    const serverElapsed = nonNegativeFinite(
      raw.server_elapsed_ms as number,
      `${label} line ${index + 1} server elapsed`,
    );
    if (!Number.isSafeInteger(raw.response_bytes) || (raw.response_bytes as number) < 0) {
      timingFailure(`${label} line ${index + 1} has invalid response_bytes`);
    }
    if (raw.response_action_kind !== null && typeof raw.response_action_kind !== "string") {
      timingFailure(`${label} line ${index + 1} has an invalid action kind`);
    }
    if (raw.outcome !== "ok" && raw.outcome !== "bounded_error") {
      timingFailure(`${label} line ${index + 1} has an invalid outcome`);
    }
    const sample: ExecutorMcpServerTimingV2 = {
      version: "executor_mcp_server_timing.v2",
      connection_call_ordinal: raw.connection_call_ordinal as number,
      operation,
      server_elapsed_ms: serverElapsed,
      response_bytes: raw.response_bytes as number,
      response_action_kind: raw.response_action_kind as string | null,
      outcome: raw.outcome,
      server_phase_elapsed_ms: raw.server_phase_elapsed_ms as ExecutorMcpServerPhaseElapsedV2 | null,
    };
    serverPhaseElapsed(sample);
    samples.push(sample);
  }
  if (samples.length === 0) timingFailure(`${label} contains no Executor server timing samples`);
  return samples;
}

function boundedResponseOnlyValue(payload: RawPayload): unknown | undefined {
  if (payload.kind !== "tool_result" || !hasExactKeys(payload.value, ["response"])) return undefined;
  const response = payload.value.response;
  if (!isRecord(response) || !hasExactKeys(response, ["Result"])) return undefined;
  const result = response.Result;
  if (!isRecord(result) || !hasExactKeys(result, ["cell_id", "content_items", "error_text"])) {
    return undefined;
  }
  if (typeof result.cell_id !== "string" || result.cell_id.length === 0 || result.error_text !== null) {
    return undefined;
  }
  if (!Array.isArray(result.content_items) || result.content_items.length !== 1) return undefined;
  const item = result.content_items[0];
  if (!isRecord(item) || !hasExactKeys(item, ["type", "text"])) return undefined;
  if (item.type !== "input_text" || typeof item.text !== "string") return undefined;
  try {
    return JSON.parse(item.text) as unknown;
  } catch {
    return undefined;
  }
}

function parseListAgentsResult(payload: RawPayload, label: string): Array<{
  agent_name: string;
  status: "running" | "completed";
}> {
  if (payload.kind !== "tool_result") unverifiable(`${label} is not a tool result`);
  const responseItem = requiredRecord(payload.value.response_item, `${label}.response_item`);
  if (payload.value.type !== "direct_response" || responseItem.type !== "function_call_output") {
    unverifiable(`${label} is not a direct function output`);
  }
  const outputText = requiredString(responseItem.output, `${label}.response_item.output`);
  let output: unknown;
  try {
    output = JSON.parse(outputText) as unknown;
  } catch (error) {
    unverifiable(`${label}.response_item.output is not JSON: ${String(error)}`);
  }
  const agents = requiredRecord(output, `${label}.output`).agents;
  if (!Array.isArray(agents)) unverifiable(`${label}.output.agents is not an array`);
  return agents.map((rawAgent, index) => {
    const agent = requiredRecord(rawAgent, `${label}.output.agents[${index}]`);
    const agentName = requiredString(agent.agent_name, `${label}.output.agents[${index}].agent_name`);
    if (agent.agent_status === "running") return { agent_name: agentName, status: "running" as const };
    const status = requiredRecord(agent.agent_status, `${label}.output.agents[${index}].agent_status`);
    const completed = requiredString(status.completed, `${label}.output.agents[${index}].completed`);
    let lifecycle: unknown;
    try {
      lifecycle = JSON.parse(completed) as unknown;
    } catch (error) {
      unverifiable(`${label}.output.agents[${index}].completed is not JSON: ${String(error)}`);
    }
    const bounded = requiredRecord(lifecycle, `${label}.output.agents[${index}].completed lifecycle`);
    if (!hasExactKeys(bounded, ["protocol", "status", "version"])
      || bounded.version !== "automatic_build_executor_lifecycle.v2"
      || bounded.status !== "committed"
      || bounded.protocol !== "automatic_build_executor_session.v3") {
      unverifiable(`${label}.output.agents[${index}] has an incompatible completed lifecycle`);
    }
    return { agent_name: agentName, status: "completed" as const };
  });
}

function rawPayloadReader(bundleRoot: string, state: JsonObject): (id: string) => RawPayload {
  const references = mapRecord(state.raw_payloads, "state.raw_payloads");
  const cache = new Map<string, RawPayload>();
  const resolvedBundle = path.resolve(bundleRoot);
  return (id: string): RawPayload => {
    const cached = cache.get(id);
    if (cached) return cached;
    const reference = requiredRecord(references[id], `raw payload reference ${id}`);
    if (reference.raw_payload_id !== id) unverifiable(`raw payload reference ${id} changed identity`);
    const relativePath = requiredString(reference.path, `raw payload reference ${id}.path`);
    const resolved = path.resolve(resolvedBundle, relativePath);
    const relative = path.relative(resolvedBundle, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      unverifiable(`raw payload reference ${id} escaped the trace bundle`);
    }
    const kind = requiredRecord(reference.kind, `raw payload reference ${id}.kind`);
    const text = (() => {
      try {
        return readFileSync(resolved, "utf8");
      } catch (error) {
        unverifiable(`raw payload ${id} is unreadable: ${String(error)}`);
      }
    })();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      unverifiable(`raw payload ${id} is not JSON: ${String(error)}`);
    }
    const payload = {
      id,
      kind: requiredString(kind.type, `raw payload reference ${id}.kind.type`),
      text,
      value: requiredRecord(parsed, `raw payload ${id}`),
    };
    cache.set(id, payload);
    return payload;
  };
}

function parseThreads(state: JsonObject, rootThreadId: string): R7TraceThread[] {
  const threads = mapRecord(state.threads, "state.threads");
  const parsed = Object.entries(threads).map(([key, raw]): R7TraceThread => {
    const thread = requiredRecord(raw, `thread ${key}`);
    const threadId = requiredString(thread.thread_id, `thread ${key}.thread_id`);
    if (threadId !== key) unverifiable(`thread ${key} changed identity`);
    const origin = requiredRecord(thread.origin, `thread ${key}.origin`);
    const originType = requiredString(origin.type, `thread ${key}.origin.type`);
    if (originType !== "root" && originType !== "spawned") {
      unverifiable(`thread ${key} has unknown origin`);
    }
    const execution = requiredRecord(thread.execution, `thread ${key}.execution`);
    const parentThreadId = originType === "spawned"
      ? requiredString(origin.parent_thread_id, `thread ${key}.origin.parent_thread_id`)
      : null;
    const taskName = originType === "spawned"
      ? requiredString(origin.task_name, `thread ${key}.origin.task_name`)
      : null;
    const agentRole = originType === "spawned"
      ? (typeof origin.agent_role === "string"
        ? origin.agent_role
        : unverifiable(`thread ${key}.origin.agent_role is missing`))
      : null;
    return {
      thread_id: threadId,
      origin_type: originType,
      parent_thread_id: parentThreadId,
      task_name: taskName,
      agent_role: agentRole,
      started_seq: requiredSequence(execution.started_seq, `thread ${key}.execution.started_seq`),
      ended_seq: requiredSequence(execution.ended_seq, `thread ${key}.execution.ended_seq`),
      status: requiredString(execution.status, `thread ${key}.execution.status`),
    };
  });
  const root = parsed.find((thread) => thread.thread_id === rootThreadId);
  if (!root || root.origin_type !== "root") unverifiable("root thread provenance is missing");
  for (const thread of parsed) {
    if (thread.origin_type === "spawned" && !parsed.some((candidate) => candidate.thread_id === thread.parent_thread_id)) {
      unverifiable(`spawned thread ${thread.thread_id} has no parent provenance`);
    }
  }
  return parsed;
}

function parseToolCall(value: unknown, label: string): ToolCallRecord {
  const call = requiredRecord(value, label);
  const execution = requiredRecord(call.execution, `${label}.execution`);
  const resultId = call.raw_result_payload_id;
  if (resultId !== null && resultId !== undefined && typeof resultId !== "string") {
    unverifiable(`${label}.raw_result_payload_id is invalid`);
  }
  const mcpCallId = call.mcp_call_id;
  if (mcpCallId !== null && mcpCallId !== undefined && typeof mcpCallId !== "string") {
    unverifiable(`${label}.mcp_call_id is invalid`);
  }
  return {
    tool_call_id: requiredString(call.tool_call_id, `${label}.tool_call_id`),
    thread_id: requiredString(call.thread_id, `${label}.thread_id`),
    execution: {
      started_seq: requiredSequence(execution.started_seq, `${label}.execution.started_seq`),
      ended_seq: requiredSequence(execution.ended_seq, `${label}.execution.ended_seq`),
      status: requiredString(execution.status, `${label}.execution.status`),
    },
    raw_invocation_payload_id: requiredString(
      call.raw_invocation_payload_id,
      `${label}.raw_invocation_payload_id`,
    ),
    raw_runtime_payload_ids: stringArray(call.raw_runtime_payload_ids, `${label}.raw_runtime_payload_ids`),
    raw_result_payload_id: typeof resultId === "string" ? resultId : null,
    mcp_call_id: typeof mcpCallId === "string" && mcpCallId.length > 0 ? mcpCallId : null,
  };
}

interface ToolCallWallTimeV1 {
  started_ms: number;
  ended_ms: number;
}

function readToolCallWallTimes(
  bundleRoot: string,
  rolloutId: string,
): Map<string, ToolCallWallTimeV1> {
  const tracePath = path.join(bundleRoot, "trace.jsonl");
  let lines: string[];
  try {
    lines = readFileSync(tracePath, "utf8").split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    unverifiable(`trace event log is unreadable: ${String(error)}`);
  }
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      unverifiable(`trace event ${index + 1} is not JSON: ${String(error)}`);
    }
    const event = requiredRecord(raw, `trace event ${index + 1}`);
    if (event.rollout_id !== rolloutId) unverifiable(`trace event ${index + 1} changed rollout identity`);
    const payload = requiredRecord(event.payload, `trace event ${index + 1}.payload`);
    if (payload.type !== "tool_call_started" && payload.type !== "tool_call_ended") continue;
    const callId = requiredString(payload.tool_call_id, `trace event ${index + 1}.payload.tool_call_id`);
    const wallTime = event.wall_time_unix_ms;
    if (typeof wallTime !== "number" || !Number.isFinite(wallTime) || wallTime < 0) {
      unverifiable(`trace event ${index + 1}.wall_time_unix_ms is invalid`);
    }
    const target = payload.type === "tool_call_started" ? starts : ends;
    if (target.has(callId)) unverifiable(`tool call ${callId} has duplicate ${payload.type} timing`);
    target.set(callId, wallTime);
  }
  const timings = new Map<string, ToolCallWallTimeV1>();
  for (const [callId, startedAt] of starts) {
    const endedAt = ends.get(callId);
    if (endedAt === undefined) continue;
    if (endedAt < startedAt) unverifiable(`tool call ${callId} has negative outer elapsed`);
    timings.set(callId, { started_ms: startedAt, ended_ms: endedAt });
  }
  return timings;
}

function maxConcurrent(threads: R7TraceThread[]): number {
  const events = threads.flatMap((thread) => [
    { seq: thread.started_seq, delta: 1 },
    { seq: thread.ended_seq, delta: -1 },
  ]).sort((left, right) => left.seq - right.seq || left.delta - right.delta);
  let live = 0;
  let maximum = 0;
  for (const event of events) {
    live += event.delta;
    maximum = Math.max(maximum, live);
  }
  return maximum;
}

export function analyzeR7RolloutTrace(options: AnalyzeR7RolloutTraceOptions): R7RolloutTraceAnalysis {
  const bundleRoot = path.resolve(options.bundle_root);
  const manifest = readJsonObject(path.join(bundleRoot, "manifest.json"), "trace manifest");
  const state = readJsonObject(path.join(bundleRoot, "state.json"), "reduced trace state");
  if (manifest.schema_version !== 1 || state.schema_version !== 1) {
    unverifiable("trace schema version is unsupported");
  }
  const manifestRootThreadId = requiredString(manifest.root_thread_id, "manifest.root_thread_id");
  const stateRootThreadId = requiredString(state.root_thread_id, "state.root_thread_id");
  if (manifestRootThreadId !== stateRootThreadId) unverifiable("root thread identity drifted during reduction");
  const manifestRolloutId = requiredString(manifest.rollout_id, "manifest.rollout_id");
  const stateRolloutId = requiredString(state.rollout_id, "state.rollout_id");
  if (manifestRolloutId !== stateRolloutId) unverifiable("rollout identity drifted during reduction");

  const threads = parseThreads(state, stateRootThreadId);
  const threadById = new Map(threads.map((thread) => [thread.thread_id, thread]));
  const dedicated = threads
    .filter((thread) => thread.origin_type === "spawned" && thread.agent_role === options.executor_agent_role)
    .sort((left, right) => left.started_seq - right.started_seq);
  if (dedicated.length !== options.expected_dedicated_child_count) {
    throw new Error(`expected ${options.expected_dedicated_child_count} dedicated Executor children, found ${dedicated.length}`);
  }
  if (dedicated.some((thread) => thread.status !== "completed")) {
    throw new Error("a dedicated Executor child did not complete");
  }
  const dedicatedIds = new Set(dedicated.map((thread) => thread.thread_id));

  const readRaw = rawPayloadReader(bundleRoot, state);
  const toolCallWallTimes = readToolCallWallTimes(bundleRoot, stateRolloutId);
  const executorNamespace = `mcp__${options.executor_server_name}`;
  const modelToolToOperation = new Map(options.executor_tool_names.map((tool) => [tool.replaceAll(".", "_"), tool]));
  const toolCalls = mapRecord(state.tool_calls, "state.tool_calls");
  const executorCalls: R7ExecutorTraceCall[] = [];
  const rawOwners = new Map<string, Array<{ thread_id: string; operation: ExecutorTraceOperation }>>();
  const allowedSemanticToolResponses: unknown[] = [];
  const syntheticBuildStepStartedSeqs: number[] = [];
  const agentStatusObservations: AgentStatusObservation[] = [];
  let executorRefillStartedAtMs: number | null = null;

  for (const [key, rawCall] of Object.entries(toolCalls)) {
    const call = parseToolCall(rawCall, `tool call ${key}`);
    if (call.tool_call_id !== key) unverifiable(`tool call ${key} changed identity`);
    if (!threadById.has(call.thread_id)) unverifiable(`tool call ${key} has no thread provenance`);
    const invocation = readRaw(call.raw_invocation_payload_id);
    const rawToolNamespace = invocation.value.tool_namespace;
    const toolNamespace = rawToolNamespace === null || rawToolNamespace === undefined
      ? null
      : requiredString(rawToolNamespace, `tool call ${key} namespace`);
    const toolName = requiredString(invocation.value.tool_name, `tool call ${key} name`);
    const allPayloadIds = [
      call.raw_invocation_payload_id,
      ...call.raw_runtime_payload_ids,
      ...(call.raw_result_payload_id ? [call.raw_result_payload_id] : []),
    ];

    if (options.synthetic_build_step_marker
      && call.thread_id === stateRootThreadId
      && invocation.text.includes(options.synthetic_build_step_marker)) {
      syntheticBuildStepStartedSeqs.push(call.execution.started_seq);
    }

    if (call.thread_id === stateRootThreadId
      && toolNamespace === "collaboration"
      && toolName === "spawn_agent"
      && dedicated.length >= 4) {
      const payload = requiredRecord(invocation.value.payload, `spawn_agent call ${key} payload`);
      const argumentsText = requiredString(payload.arguments, `spawn_agent call ${key} arguments`);
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(argumentsText) as unknown;
      } catch (error) {
        unverifiable(`spawn_agent call ${key} arguments are not JSON: ${String(error)}`);
      }
      const argumentsRecord = requiredRecord(argumentsValue, `spawn_agent call ${key} arguments`);
      if (argumentsRecord.task_name === dedicated[3].task_name) {
        const wallTime = toolCallWallTimes.get(call.tool_call_id);
        if (!wallTime) unverifiable(`spawn_agent call ${key} has no outer wall timing`);
        if (executorRefillStartedAtMs !== null) {
          unverifiable("fourth dedicated child has duplicate spawn timing");
        }
        executorRefillStartedAtMs = wallTime.started_ms;
      }
    }

    if (call.thread_id === stateRootThreadId
      && toolNamespace === "collaboration"
      && toolName === "list_agents") {
      if (call.execution.status !== "completed" || !call.raw_result_payload_id) {
        unverifiable(`list_agents call ${key} has no completed result`);
      }
      const observed = parseListAgentsResult(readRaw(call.raw_result_payload_id), `list_agents call ${key}`);
      const wallTime = toolCallWallTimes.get(call.tool_call_id);
      if (!wallTime) unverifiable(`list_agents call ${key} has no outer wall timing`);
      const completedTaskNames: string[] = [];
      const runningTaskNames: string[] = [];
      for (const thread of dedicated) {
        const taskName = thread.task_name as string;
        const matches = observed.filter((agent) => agent.agent_name.endsWith(`/${taskName}`));
        if (matches.length > 1) unverifiable(`list_agents call ${key} duplicated ${taskName}`);
        if (matches[0]?.status === "completed") completedTaskNames.push(taskName);
        if (matches[0]?.status === "running") runningTaskNames.push(taskName);
      }
      agentStatusObservations.push({
        ended_seq: call.execution.ended_seq,
        observed_at_ms: wallTime.ended_ms,
        completed_task_names: completedTaskNames,
        running_task_names: runningTaskNames,
      });
    }

    if (toolNamespace === null) {
      if (modelToolToOperation.has(toolName)) {
        unverifiable(`Executor-shaped tool call ${key} has no namespace`);
      }
      continue;
    }
    if (toolNamespace !== executorNamespace) continue;
    const operation = modelToolToOperation.get(toolName);
    if (!operation) throw new Error(`unexpected Executor callable ${toolNamespace}.${toolName}`);
    for (const id of allPayloadIds) {
      const owners = rawOwners.get(id) ?? [];
      owners.push({ thread_id: call.thread_id, operation });
      rawOwners.set(id, owners);
    }
    if (dedicatedIds.has(call.thread_id)
      && (operation === "executor.input.next" || operation === "executor.submit_candidate")
      && call.raw_result_payload_id) {
      const resultPayload = readRaw(call.raw_result_payload_id);
      if (resultPayload.kind === "tool_result"
        && resultPayload.value.type === "code_mode_response"
        && Object.hasOwn(resultPayload.value, "value")) {
        allowedSemanticToolResponses.push(resultPayload.value.value);
        const codeModeValue = resultPayload.value.value;
        if (isRecord(codeModeValue) && Array.isArray(codeModeValue.content)) {
          for (const item of codeModeValue.content) {
            if (!isRecord(item) || !hasExactKeys(item, ["type", "text"])) continue;
            if (item.type !== "text" || typeof item.text !== "string") continue;
            try {
              allowedSemanticToolResponses.push(JSON.parse(item.text) as unknown);
            } catch {
              // A non-JSON text item cannot be the structured Executor response projection.
            }
          }
        }
      }
    }

    let backendCall = false;
    if (call.mcp_call_id) {
      const runtimeBegins = call.raw_runtime_payload_ids
        .map((id) => readRaw(id).value)
        .filter((payload) => isRecord(payload.invocation) && !Object.hasOwn(payload, "result"));
      if (runtimeBegins.length !== 1) {
        unverifiable(`Executor call ${key} has no unique runtime begin payload`);
      }
      const runtimeInvocation = requiredRecord(runtimeBegins[0].invocation, `Executor call ${key} runtime invocation`);
      if (runtimeInvocation.server !== options.executor_server_name || runtimeInvocation.tool !== operation) {
        unverifiable(`Executor call ${key} runtime invocation does not match its dispatch`);
      }
      backendCall = true;
    }
    executorCalls.push({
      tool_call_id: call.tool_call_id,
      thread_id: call.thread_id,
      operation,
      dispatch_attempt: true,
      backend_call: backendCall,
      status: call.execution.status,
      started_seq: call.execution.started_seq,
      ended_seq: call.execution.ended_seq,
    });
  }

  executorCalls.sort((left, right) => left.started_seq - right.started_seq);
  const rootCalls = executorCalls.filter((call) => call.thread_id === stateRootThreadId);
  const otherCalls = executorCalls.filter((call) => call.thread_id !== stateRootThreadId && !dedicatedIds.has(call.thread_id));
  if (rootCalls.length > 0) throw new Error("root dispatched an Executor tool");
  if (otherCalls.length > 0) throw new Error("a non-Executor child dispatched an Executor tool");

  const expectedToolSet = [...options.executor_tool_names].sort();
  for (const thread of dedicated) {
    const calls = executorCalls.filter((call) => call.thread_id === thread.thread_id);
    if (calls.length === 0) throw new Error(`dedicated child ${thread.task_name} made no Executor dispatch`);
    if (calls.some((call) => !call.backend_call || call.status !== "completed")) {
      throw new Error(`dedicated child ${thread.task_name} has an unsuccessful Executor dispatch`);
    }
    if (calls[0].operation !== "executor.open") {
      throw new Error(`dedicated child ${thread.task_name} did not dispatch executor.open first`);
    }
    const firstBackend = calls.find((call) => call.backend_call);
    if (!firstBackend || firstBackend.operation !== "executor.open") {
      throw new Error(`dedicated child ${thread.task_name} did not reach executor.open first`);
    }
    const successfulTools = [...new Set(calls.map((call) => call.operation))].sort();
    if (JSON.stringify(successfulTools) !== JSON.stringify(expectedToolSet)) {
      throw new Error(`dedicated child ${thread.task_name} did not successfully call exact-four`);
    }
  }

  const executorOuterTimingSamples: ExecutorOuterTimingV1[] = [];
  for (const thread of dedicated) {
    const calls = executorCalls.filter((call) => call.thread_id === thread.thread_id);
    for (const [index, call] of calls.entries()) {
      const wallTime = toolCallWallTimes.get(call.tool_call_id);
      if (!wallTime) {
        unverifiable(`Executor call ${call.tool_call_id} has no outer wall timing`);
      }
      executorOuterTimingSamples.push({
        thread_id: thread.thread_id,
        connection_call_ordinal: index + 1,
        operation: call.operation,
        outer_tool_call_elapsed_ms: wallTime.ended_ms - wallTime.started_ms,
      });
    }
  }

  const inferenceCalls = mapRecord(state.inference_calls, "state.inference_calls");
  const inferenceOwners = new Map<string, string>();
  for (const [key, rawInference] of Object.entries(inferenceCalls)) {
    const inference = requiredRecord(rawInference, `inference call ${key}`);
    const threadId = requiredString(inference.thread_id, `inference call ${key}.thread_id`);
    if (!threadById.has(threadId)) unverifiable(`inference call ${key} has no thread provenance`);
    const requestId = requiredString(inference.raw_request_payload_id, `inference call ${key}.raw_request_payload_id`);
    inferenceOwners.set(requestId, threadId);
    const responseId = inference.raw_response_payload_id;
    if (responseId !== null && responseId !== undefined) {
      inferenceOwners.set(requiredString(responseId, `inference call ${key}.raw_response_payload_id`), threadId);
    }
  }

  let semanticHitCount = 0;
  let executorInputOrSubmitHits = 0;
  let dedicatedInferenceHits = 0;
  let boundedResponseOnlyHits = 0;
  const allPayloadIds = Object.keys(mapRecord(state.raw_payloads, "state.raw_payloads"));
  for (const sentinel of options.semantic_sentinels) {
    let hitsForSentinel = 0;
    for (const payloadId of allPayloadIds) {
      const payload = readRaw(payloadId);
      if (!payload.text.includes(sentinel)) continue;
      hitsForSentinel += 1;
      semanticHitCount += 1;
      const toolOwners = rawOwners.get(payloadId) ?? [];
      if (toolOwners.length > 0 && toolOwners.every((owner) => (
        dedicatedIds.has(owner.thread_id)
          && (owner.operation === "executor.input.next" || owner.operation === "executor.submit_candidate")
      ))) {
        executorInputOrSubmitHits += 1;
        continue;
      }
      const inferenceOwner = inferenceOwners.get(payloadId);
      if (inferenceOwner && dedicatedIds.has(inferenceOwner)) {
        dedicatedInferenceHits += 1;
        continue;
      }
      const responseOnlyValue = boundedResponseOnlyValue(payload);
      if (responseOnlyValue !== undefined
        && allowedSemanticToolResponses.some((value) => isDeepStrictEqual(value, responseOnlyValue))) {
        boundedResponseOnlyHits += 1;
        continue;
      }
      throw new Error(
        `semantic sentinel escaped the dedicated Executor trace shapes: ${payload.id} `
          + `kind=${payload.kind} keys=${Object.keys(payload.value).sort().join(",")}`,
      );
    }
    if (hitsForSentinel === 0) throw new Error("semantic sentinel was absent from the reduced child trace");
  }

  const dedicatedCalls = executorCalls.filter((call) => dedicatedIds.has(call.thread_id));
  const successfulTools = [...new Set(dedicatedCalls.map((call) => call.operation))].sort() as ExecutorTraceOperation[];
  const firstDispatch = dedicatedCalls[0]?.operation;
  const firstBackend = dedicatedCalls.find((call) => call.backend_call)?.operation;
  if (!firstDispatch || !firstBackend) unverifiable("dedicated child Executor sequence is absent");

  let fourthAfterFirst: boolean | null = null;
  let fourthBeforeLast: boolean | null = null;
  if (dedicated.length >= 4) {
    const initial = dedicated.slice(0, 3);
    const fourth = dedicated[3];
    const firstTerminal = Math.min(...initial.map((thread) => thread.ended_seq));
    const lastInitialTerminal = Math.max(...initial.map((thread) => thread.ended_seq));
    fourthAfterFirst = fourth.started_seq > firstTerminal;
    fourthBeforeLast = fourth.started_seq < lastInitialTerminal;
  }

  let firstPartialCompletionObservedSeq: number | null = null;
  let allDedicatedTerminalObservedSeq: number | null = null;
  const cumulativeTerminal = new Set<string>();
  const previouslyRunning = new Set<string>();
  const initialTaskNames = new Set(dedicated.slice(0, 3).map((thread) => thread.task_name as string));
  const allTaskNames = new Set(dedicated.map((thread) => thread.task_name as string));
  for (const observation of agentStatusObservations.sort((left, right) => left.ended_seq - right.ended_seq)) {
    const present = new Set([...observation.completed_task_names, ...observation.running_task_names]);
    for (const taskName of observation.completed_task_names) cumulativeTerminal.add(taskName);
    for (const taskName of previouslyRunning) {
      if (!present.has(taskName)) cumulativeTerminal.add(taskName);
    }
    for (const taskName of observation.running_task_names) previouslyRunning.add(taskName);
    if (firstPartialCompletionObservedSeq === null
      && observation.completed_task_names.some((taskName) => initialTaskNames.has(taskName))
      && observation.running_task_names.some((taskName) => initialTaskNames.has(taskName))) {
      firstPartialCompletionObservedSeq = observation.ended_seq;
    }
    if (allDedicatedTerminalObservedSeq === null
      && [...allTaskNames].every((taskName) => cumulativeTerminal.has(taskName))) {
      allDedicatedTerminalObservedSeq = observation.ended_seq;
    }
  }
  if (options.synthetic_build_step_marker && dedicated.length >= 4) {
    if (firstPartialCompletionObservedSeq === null) {
      unverifiable("root never observed a partial initial wave completion");
    }
    if (allDedicatedTerminalObservedSeq === null) {
      unverifiable("root never observed all dedicated children terminal");
    }
  }

  return {
    root_thread_id: stateRootThreadId,
    thread_attribution_complete: true,
    dedicated_child_threads: dedicated,
    executor_calls: executorCalls,
    executor_outer_timing_samples: executorOuterTimingSamples,
    root_executor_dispatch_attempt_count: rootCalls.length,
    root_executor_backend_call_count: rootCalls.filter((call) => call.backend_call).length,
    other_child_executor_dispatch_attempt_count: otherCalls.length,
    other_child_executor_backend_call_count: otherCalls.filter((call) => call.backend_call).length,
    child_executor_tool_count: successfulTools.length,
    child_executor_tools: successfulTools,
    first_child_dispatch: firstDispatch,
    first_child_backend_call: firstBackend,
    semantic_hit_count: semanticHitCount,
    semantic_hit_shapes: {
      executor_input_or_submit: executorInputOrSubmitHits,
      dedicated_child_inference: dedicatedInferenceHits,
      bounded_response_only: boundedResponseOnlyHits,
    },
    max_live_dedicated_children: maxConcurrent(dedicated),
    executor_slot_lifecycle_observations: agentStatusObservations
      .sort((left, right) => left.ended_seq - right.ended_seq)
      .map((observation) => ({
        observed_at_ms: observation.observed_at_ms,
        live_slots: observation.running_task_names.length,
      })),
    executor_refill_started_at_ms: executorRefillStartedAtMs,
    fourth_child_started_after_first_terminal: fourthAfterFirst,
    fourth_child_started_before_last_initial_terminal: fourthBeforeLast,
    synthetic_build_step_call_count: syntheticBuildStepStartedSeqs.length,
    synthetic_build_step_started_seqs: syntheticBuildStepStartedSeqs.sort((left, right) => left - right),
    first_partial_completion_observed_seq: firstPartialCompletionObservedSeq,
    all_dedicated_terminal_observed_seq: allDedicatedTerminalObservedSeq,
  };
}
