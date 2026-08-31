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
  fourth_child_started_after_first_terminal: boolean | null;
  fourth_child_started_before_last_initial_terminal: boolean | null;
  synthetic_build_step_call_count: number;
  synthetic_build_step_started_seqs: number[];
  first_partial_completion_observed_seq: number | null;
  all_dedicated_terminal_observed_seq: number | null;
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
  thread_id: string;
  execution: { started_seq: number; ended_seq: number; status: string };
  raw_invocation_payload_id: string;
  raw_runtime_payload_ids: string[];
  raw_result_payload_id: string | null;
  mcp_call_id: string | null;
}

interface AgentStatusObservation {
  ended_seq: number;
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
  if (manifest.rollout_id !== state.rollout_id) unverifiable("rollout identity drifted during reduction");

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
  const executorNamespace = `mcp__${options.executor_server_name}`;
  const modelToolToOperation = new Map(options.executor_tool_names.map((tool) => [tool.replaceAll(".", "_"), tool]));
  const toolCalls = mapRecord(state.tool_calls, "state.tool_calls");
  const executorCalls: R7ExecutorTraceCall[] = [];
  const rawOwners = new Map<string, Array<{ thread_id: string; operation: ExecutorTraceOperation }>>();
  const allowedSemanticToolResponses: unknown[] = [];
  const syntheticBuildStepStartedSeqs: number[] = [];
  const agentStatusObservations: AgentStatusObservation[] = [];

  for (const [key, rawCall] of Object.entries(toolCalls)) {
    const call = parseToolCall(rawCall, `tool call ${key}`);
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
      && toolName === "list_agents") {
      if (call.execution.status !== "completed" || !call.raw_result_payload_id) {
        unverifiable(`list_agents call ${key} has no completed result`);
      }
      const observed = parseListAgentsResult(readRaw(call.raw_result_payload_id), `list_agents call ${key}`);
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
    fourth_child_started_after_first_terminal: fourthAfterFirst,
    fourth_child_started_before_last_initial_terminal: fourthBeforeLast,
    synthetic_build_step_call_count: syntheticBuildStepStartedSeqs.length,
    synthetic_build_step_started_seqs: syntheticBuildStepStartedSeqs.sort((left, right) => left - right),
    first_partial_completion_observed_seq: firstPartialCompletionObservedSeq,
    all_dedicated_terminal_observed_seq: allDedicatedTerminalObservedSeq,
  };
}
