import {
  BUILD_EXECUTOR_MCP_CONTRACT_V3,
  BUILD_EXECUTOR_TOOL_NAMES_V1,
  createBuildExecutorToolAdapter,
  type BuildExecutorToolNameV1,
} from "../../packages/core/src/build-executor-tool-adapter";
import {
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
  createBuildExecutorStdioConnectionCapability,
} from "../../packages/core/src/build-executor-connection-capability";
import {
  resolveAutomaticBuildExecutorRegistryRoot,
  runAutomaticBuildExecutorSessionCommand,
  type AutomaticBuildExecutorServerPhaseBoundaryV1,
  type AutomaticBuildExecutorServerTimingObserverV1,
  type AutomaticBuildExecutorSessionResponseV3,
} from "../../packages/core/src/automatic-build-executor-session";
import { canonicalAutomaticBuildJson } from "../../packages/core/src/automatic-build-protocol";
import {
  CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1,
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  measureExecutorTransportResponse,
  serializeExecutorMcpToolResult,
} from "../../packages/core/src/executor-transport";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_LINE_BYTES = 131_072;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface ExecutorMcpServerTimingV2 {
  version: "executor_mcp_server_timing.v2";
  connection_call_ordinal: number;
  operation: BuildExecutorToolNameV1;
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

interface ExecutorMcpPhasePlanV2 {
  boundaries: readonly AutomaticBuildExecutorServerPhaseBoundaryV1[];
}

function phasePlan(operation: BuildExecutorToolNameV1): ExecutorMcpPhasePlanV2 | undefined {
  if (operation === "executor.generation.start") {
    return {
      boundaries: ["current-state/claim", "input-render-or-reuse"],
    };
  }
  if (operation === "executor.submit_candidate") {
    return {
      boundaries: ["candidate-gate", "writer/commit"],
    };
  }
  return undefined;
}

interface BuildExecutorMcpSessionOptions {
  bootstrap_version: string;
  protocol_generation: string;
  session_private_root: string;
  execute_request?: (
    request: unknown,
    timing: AutomaticBuildExecutorServerTimingObserverV1,
  ) => AutomaticBuildExecutorSessionResponseV3;
  now_ms?: () => number;
  timing_sample_sink?: (sample: ExecutorMcpServerTimingV2) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

function boundedToolError(id: JsonRpcRequest["id"]) {
  return rpcResult(id, {
    content: [{
      type: "text" as const,
      text: canonicalAutomaticBuildJson({
        version: "automatic_build_executor_mcp_error.v1",
        status: "interrupted",
        category: "bootstrap",
        diagnostic_code: "protocol_incompatible",
      }),
    }],
    isError: true,
  });
}

export function createBuildExecutorMcpSession(options: BuildExecutorMcpSessionOptions): {
  handle_message: (value: unknown) => unknown | undefined;
} {
  const connection = createBuildExecutorStdioConnectionCapability({
    bootstrap_version: options.bootstrap_version,
    protocol_generation: options.protocol_generation,
    session_private_root: options.session_private_root,
  });
  const nowMs = options.now_ms ?? (() => performance.now());
  let activeTiming: AutomaticBuildExecutorServerTimingObserverV1 | undefined;
  const adapter = createBuildExecutorToolAdapter({
    authorize_connection: connection.authorize_connection,
    execute_request: (request) => {
      if (!activeTiming) throw new Error("Build Executor MCP timing boundary is unavailable");
      const response = options.execute_request
        ? options.execute_request(request, activeTiming)
        : runAutomaticBuildExecutorSessionCommand(request, { timing: activeTiming });
      if (response.version !== "automatic_build_executor_session.v3") {
        throw new Error("Build Executor MCP received a legacy session response");
      }
      return response;
    },
  });
  let connectionCallOrdinal = 0;

  const handleMessage = (value: unknown): unknown | undefined => {
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
      return rpcError(null, -32600, "Invalid Request");
    }
    const request = value as unknown as JsonRpcRequest;
    if (request.method.startsWith("notifications/")) return undefined;
    if (request.method === "initialize") {
      const requestedVersion = isRecord(request.params) && typeof request.params.protocolVersion === "string"
        ? request.params.protocolVersion
        : MCP_PROTOCOL_VERSION;
      return rpcResult(request.id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: BUILD_EXECUTOR_MCP_CONTRACT_V3.server_name,
          version: BUILD_EXECUTOR_MCP_CONTRACT_V3.version,
        },
      });
    }
    if (request.method === "ping") return rpcResult(request.id, {});
    if (request.method === "tools/list") {
      return rpcResult(request.id, {
        tools: adapter.list_tools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
          annotations: {
            readOnlyHint: tool.name === "executor.input.next",
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        })),
      });
    }
    if (request.method !== "tools/call") return rpcError(request.id, -32601, "Method not found");

    const toolName = isRecord(request.params)
      && typeof request.params.name === "string"
      && (BUILD_EXECUTOR_TOOL_NAMES_V1 as readonly string[]).includes(request.params.name)
      ? request.params.name as BuildExecutorToolNameV1
      : undefined;
    if (!toolName) return boundedToolError(request.id);

    connectionCallOrdinal += 1;
    const callOrdinal = connectionCallOrdinal;
    const startedAtMs = nowMs();
    const plan = phasePlan(toolName);
    const completedPhases = new Map<AutomaticBuildExecutorServerPhaseBoundaryV1, number>();
    let nextBoundary = 0;
    let phaseStartedAtMs = startedAtMs;
    const timing: AutomaticBuildExecutorServerTimingObserverV1 = {
      complete_phase: (phase) => {
        if (!plan || plan.boundaries[nextBoundary] !== phase) {
          throw new Error("Build Executor MCP server phase order is invalid");
        }
        const finishedPhaseAtMs = nowMs();
        completedPhases.set(phase, finishedPhaseAtMs - phaseStartedAtMs);
        phaseStartedAtMs = finishedPhaseAtMs;
        nextBoundary += 1;
      },
    };
    let rpcResponse: ReturnType<typeof rpcResult>;
    let responseActionKind: string | null = null;
    let outcome: ExecutorMcpServerTimingV2["outcome"] = "bounded_error";
    try {
      activeTiming = timing;
      if (!isRecord(request.params) || !isRecord(request.params.arguments)) {
        throw new Error("Build Executor MCP tool arguments are invalid");
      }
      const call = { tool_name: toolName, request: request.params.arguments };
      const response = adapter.call_tool(
        toolName,
        request.params.arguments,
        connection.connection_capability,
      );
      if (response.action.kind === "INPUT_BATCH") {
        if (Buffer.byteLength(serializeExecutorMcpToolResult(response), "utf8")
          > CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1.max_serialized_batch_bytes) {
          throw new Error("Build Executor MCP input batch exceeds its tested carrier tier");
        }
      } else if (measureExecutorTransportResponse(
        response,
        "",
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      ).status !== "within_limit") {
        throw new Error("Build Executor MCP tool result exceeds its transport profile");
      }
      connection.observe_response(call, response);
      responseActionKind = response.action.kind;
      outcome = "ok";
      rpcResponse = rpcResult(request.id, {
        content: [{ type: "text" as const, text: canonicalAutomaticBuildJson(response) }],
        isError: false,
      });
    } catch {
      rpcResponse = boundedToolError(request.id);
    } finally {
      activeTiming = undefined;
    }
    const serializedResponse = `${JSON.stringify(rpcResponse)}\n`;
    const finishedAtMs = nowMs();
    let serverPhaseElapsedMs: ExecutorMcpServerPhaseElapsedV2 | null = null;
    if (outcome === "ok" && plan && nextBoundary === plan.boundaries.length) {
      if (toolName === "executor.generation.start") {
        serverPhaseElapsedMs = {
          "current-state/claim": completedPhases.get("current-state/claim") ?? 0,
          "input-render-or-reuse": completedPhases.get("input-render-or-reuse") ?? 0,
          "persist/response": finishedAtMs - phaseStartedAtMs,
        };
      } else if (toolName === "executor.submit_candidate") {
        serverPhaseElapsedMs = {
          "candidate-gate": completedPhases.get("candidate-gate") ?? 0,
          "writer/commit": completedPhases.get("writer/commit") ?? 0,
          "next-work-prepare": finishedAtMs - phaseStartedAtMs,
        };
      }
    }
    options.timing_sample_sink?.({
      version: "executor_mcp_server_timing.v2",
      connection_call_ordinal: callOrdinal,
      operation: toolName,
      server_elapsed_ms: finishedAtMs - startedAtMs,
      response_bytes: Buffer.byteLength(serializedResponse, "utf8"),
      response_action_kind: responseActionKind,
      outcome,
      server_phase_elapsed_ms: serverPhaseElapsedMs,
    });
    return rpcResponse;
  };

  return Object.freeze({ handle_message: handleMessage });
}

function argumentValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length || argv.indexOf(name, index + 1) >= 0) return undefined;
  return argv[index + 1];
}

export function runBuildExecutorMcpServer(argv: string[]): void {
  const bootstrapVersion = argumentValue(argv, "--bootstrap-version");
  const protocolGeneration = argumentValue(argv, "--protocol-generation");
  if (argv.length !== 4 || !bootstrapVersion || !protocolGeneration) {
    throw new Error("Build Executor MCP bootstrap arguments are invalid");
  }
  const session = createBuildExecutorMcpSession({
    bootstrap_version: bootstrapVersion,
    protocol_generation: protocolGeneration,
    session_private_root: resolveAutomaticBuildExecutorRegistryRoot(),
    timing_sample_sink: (sample) => {
      process.stderr.write(`${JSON.stringify(sample)}\n`);
    },
  });
  process.stdin.setEncoding("utf8");
  let pending = "";
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    if (Buffer.byteLength(pending, "utf8") > MAX_MCP_LINE_BYTES) {
      process.stderr.write("Build Executor MCP request exceeded its transport limit\n");
      process.exitCode = 2;
      process.stdin.pause();
      return;
    }
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let response: unknown;
      try {
        response = session.handle_message(JSON.parse(line));
      } catch {
        response = rpcError(null, -32700, "Parse error");
      }
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}

if (process.argv[1]?.endsWith("build-executor-mcp.ts")) {
  try {
    runBuildExecutorMcpServer(process.argv.slice(2));
  } catch {
    process.stderr.write("Build Executor MCP bootstrap is incompatible\n");
    process.exitCode = 2;
  }
}

export { BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3 };
