import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalAutomaticBuildJson } from "./automatic-build-protocol";
import {
  BUILD_EXECUTOR_SERVER_NAME_V1,
  BUILD_EXECUTOR_TOOL_NAMES_V1,
  type BuildExecutorToolNameV1,
} from "./build-executor-tool-contract";
import type { AutomaticBuildExecutorSessionResponseV2 } from "./automatic-build-executor-session";

const OPAQUE_HANDOFF_REF = /^abhandoff1_[a-f0-9]{64}$/u;
const OPAQUE_SESSION_REF = /^absession1_[a-f0-9]{64}$/u;
const GENERATION_INPUT_REF = /^abinput1_[a-f0-9]{64}$/u;
const GENERATION_GRANT_REF = /^abgrant1_[a-f0-9]{64}$/u;
const CANDIDATE_SINK_REF = /^absink1_[a-f0-9]{64}$/u;
const CHUNK_RECEIPT = /^abchunk1_[a-f0-9]{64}$/u;

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalAutomaticBuildJson(value), "utf8").digest("hex");
}

const BOOTSTRAP_IDENTITY_V2 = Object.freeze({
  version: "automatic_build_executor_bootstrap.v2" as const,
  agent_name: "understand_book_executor" as const,
  server_name: BUILD_EXECUTOR_SERVER_NAME_V1,
  registration_scope: "agent_only" as const,
  sandbox_mode: "read-only" as const,
  session_protocol: "automatic_build_executor_session.v2" as const,
  capability_binding: "child_process_stdio_connection" as const,
  tools: BUILD_EXECUTOR_TOOL_NAMES_V1,
});

export const BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2 = Object.freeze({
  ...BOOTSTRAP_IDENTITY_V2,
  bootstrap_digest: sha256(BOOTSTRAP_IDENTITY_V2),
});

export interface BuildExecutorToolCallV1 {
  tool_name: BuildExecutorToolNameV1;
  request: unknown;
}

export interface BuildExecutorChildConnectionCapabilityV1 {
  readonly connection_capability: symbol;
  authorize_connection: (capability: unknown, call: BuildExecutorToolCallV1) => boolean;
  observe_response: (
    call: BuildExecutorToolCallV1,
    response: AutomaticBuildExecutorSessionResponseV2,
  ) => void;
}

export interface BuildExecutorAgentConfigValidationV2 {
  status: "compatible";
  bootstrap_digest: string;
  session_protocol: "automatic_build_executor_session.v2";
  sandbox_mode: "read-only";
  registration_scope: "agent_only";
  shell_tool: false;
  skills_config: "empty";
  tool_names: BuildExecutorToolNameV1[];
}

type ConnectionPhase = "open" | "input" | "grant" | "generate" | "wait" | "terminal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value) || typeof value[field] !== "string") return undefined;
  return value[field];
}

function callKey(call: BuildExecutorToolCallV1): string {
  return canonicalAutomaticBuildJson({ tool_name: call.tool_name, request: call.request });
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

export function validateBuildExecutorAgentConfigV2(
  text: string,
): BuildExecutorAgentConfigValidationV2 {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const requiredMarkers = [
    'name = "understand_book_executor"',
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    "tools.view_image = false",
    "skills.config = []",
    "shell_tool = false",
    "unified_exec = false",
    "multi_agent = false",
    "apps = false",
    "skill_mcp_dependency_install = false",
    "[mcp_servers.understand_book_build_executor]",
    'command = "powershell.exe"',
    "executor.mcp",
    "--agent-bootstrap-digest",
    BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
    "--protocol-generation",
    BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
    "required = true",
    'default_tools_approval_mode = "approve"',
    "automatic_build_executor_session.v2",
    "agent-only stdio MCP connection",
  ];
  if (requiredMarkers.some((marker) => !normalized.includes(marker))
    || occurrences(normalized, "[mcp_servers.understand_book_build_executor]") !== 1
    || (normalized.match(/^\[mcp_servers\.[^\]]+\]$/gmu) ?? []).length !== 1
    || /automatic_build_executor_session\.v1|candidate_path|executor\.session|child_connection_capability\s*=/u
      .test(normalized)) {
    throw new Error("Build Executor agent bootstrap config is incompatible");
  }
  const enabledToolsBlock = normalized.match(/enabled_tools\s*=\s*\[([\s\S]*?)\]/u)?.[1] ?? "";
  const enabledTools = [...enabledToolsBlock.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (canonicalAutomaticBuildJson(enabledTools)
    !== canonicalAutomaticBuildJson([...BUILD_EXECUTOR_TOOL_NAMES_V1])) {
    throw new Error("Build Executor agent tool inventory is incompatible");
  }
  return {
    status: "compatible",
    bootstrap_digest: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
    session_protocol: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
    sandbox_mode: "read-only",
    registration_scope: "agent_only",
    shell_tool: false,
    skills_config: "empty",
    tool_names: [...BUILD_EXECUTOR_TOOL_NAMES_V1],
  };
}

export function validateBuildExecutorRootNegativeToolInventory(configTexts: readonly string[]): {
  status: "compatible";
  server_registered: false;
  executor_tool_intersection: [];
} {
  const joined = configTexts.join("\n");
  const intersection = BUILD_EXECUTOR_TOOL_NAMES_V1.filter((toolName) => joined.includes(toolName));
  if (joined.includes(BUILD_EXECUTOR_SERVER_NAME_V1) || intersection.length) {
    throw new Error("root/project inventory contains an agent-only Build Executor tool or server");
  }
  return {
    status: "compatible",
    server_registered: false,
    executor_tool_intersection: [],
  };
}

export function createBuildExecutorChildConnectionCapability(input: {
  bootstrap_digest: string;
  protocol_generation: string;
  session_private_root: string;
}): BuildExecutorChildConnectionCapabilityV1 {
  if (input.bootstrap_digest !== BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest
    || input.protocol_generation !== BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol) {
    throw new Error("Build Executor bootstrap digest or protocol generation is incompatible");
  }
  if (typeof input.session_private_root !== "string"
    || !path.isAbsolute(input.session_private_root)
    || input.session_private_root.includes("\0")) {
    throw new Error("Build Executor session-private root is invalid");
  }

  // Symbol identity cannot be serialized into a prompt, tool argument/result, log projection, or
  // another process. Its lifetime is exactly this stdio MCP connection.
  const connectionCapability = Symbol("build-executor-child-connection");
  const sessionPrivateRoot = path.resolve(input.session_private_root);
  void sessionPrivateRoot;

  let phase: ConnectionPhase = "open";
  let handoffRef: string | undefined;
  let sessionRef: string | undefined;
  let generationInputRef: string | undefined;
  let generationGrantRef: string | undefined;
  let candidateSinkRef: string | undefined;
  let expectedPreviousChunkReceipt: string | undefined;
  let lastObservedCallKey: string | undefined;

  const authorizeConnection = (capability: unknown, call: BuildExecutorToolCallV1): boolean => {
    if (capability !== connectionCapability || !isRecord(call.request)) return false;
    const key = callKey(call);
    if (key === lastObservedCallKey) return true;

    if (call.tool_name === "executor.open") {
      const requestedHandoffRef = stringField(call.request, "opaque_handoff_ref");
      if (!requestedHandoffRef || !OPAQUE_HANDOFF_REF.test(requestedHandoffRef)
        || (phase !== "open" && phase !== "wait")) {
        return false;
      }
      if (handoffRef && requestedHandoffRef !== handoffRef) return false;
      handoffRef ??= requestedHandoffRef;
      return true;
    }

    if (call.tool_name === "executor.input.next") {
      const requestedSessionRef = stringField(call.request, "opaque_session_ref");
      const requestedInputRef = stringField(call.request, "generation_input_ref");
      const requestedReceipt = stringField(call.request, "previous_chunk_receipt");
      return phase === "input"
        && !!requestedSessionRef && OPAQUE_SESSION_REF.test(requestedSessionRef)
        && requestedSessionRef === sessionRef
        && !!requestedInputRef && GENERATION_INPUT_REF.test(requestedInputRef)
        && requestedInputRef === generationInputRef
        && requestedReceipt === expectedPreviousChunkReceipt
        && (requestedReceipt === undefined || CHUNK_RECEIPT.test(requestedReceipt));
    }

    if (call.tool_name === "executor.generation.start") {
      const requestedSessionRef = stringField(call.request, "opaque_session_ref");
      const requestedGrantRef = stringField(call.request, "generation_grant_ref");
      return phase === "grant"
        && !!requestedSessionRef && requestedSessionRef === sessionRef
        && OPAQUE_SESSION_REF.test(requestedSessionRef)
        && !!requestedGrantRef && requestedGrantRef === generationGrantRef
        && GENERATION_GRANT_REF.test(requestedGrantRef);
    }

    if (call.tool_name === "executor.submit_candidate") {
      const requestedSessionRef = stringField(call.request, "opaque_session_ref");
      const requestedSinkRef = stringField(call.request, "candidate_sink_ref");
      return phase === "generate"
        && !!requestedSessionRef && requestedSessionRef === sessionRef
        && OPAQUE_SESSION_REF.test(requestedSessionRef)
        && !!requestedSinkRef && requestedSinkRef === candidateSinkRef
        && CANDIDATE_SINK_REF.test(requestedSinkRef);
    }

    return false;
  };

  const observeResponse = (
    call: BuildExecutorToolCallV1,
    response: AutomaticBuildExecutorSessionResponseV2,
  ): void => {
    if (response.version !== "automatic_build_executor_session.v2") {
      throw new Error("Build Executor connection received an incompatible response");
    }
    const action = response.action;
    if (action.kind === "DELIVER_INPUT") {
      const manifest = action.input_manifest;
      const next = action.next_request;
      if (!OPAQUE_SESSION_REF.test(manifest.opaque_session_ref)
        || !GENERATION_INPUT_REF.test(manifest.generation_input_ref)
        || next.opaque_session_ref !== manifest.opaque_session_ref
        || next.generation_input_ref !== manifest.generation_input_ref
        || (next.previous_chunk_receipt !== undefined
          && !CHUNK_RECEIPT.test(next.previous_chunk_receipt))) {
        throw new Error("Build Executor delivery binding is invalid");
      }
      sessionRef = manifest.opaque_session_ref;
      generationInputRef = manifest.generation_input_ref;
      generationGrantRef = undefined;
      candidateSinkRef = undefined;
      expectedPreviousChunkReceipt = next.previous_chunk_receipt;
      phase = "input";
    } else if (action.kind === "INPUT_CHUNK") {
      if (action.chunk.opaque_session_ref !== sessionRef
        || action.chunk.generation_input_ref !== generationInputRef
        || !CHUNK_RECEIPT.test(action.chunk.chunk_receipt)) {
        throw new Error("Build Executor input chunk binding is invalid");
      }
      expectedPreviousChunkReceipt = action.chunk.chunk_receipt;
      phase = "input";
    } else if (action.kind === "GENERATION_GRANT") {
      const rebindFromOpen = call.tool_name === "executor.open";
      if (!OPAQUE_SESSION_REF.test(action.grant.opaque_session_ref)
        || !GENERATION_INPUT_REF.test(action.grant.generation_input_ref)
        || !GENERATION_GRANT_REF.test(action.grant.generation_grant_ref)) {
        throw new Error("Build Executor generation grant binding is invalid");
      }
      if (!rebindFromOpen && (action.grant.opaque_session_ref !== sessionRef
        || action.grant.generation_input_ref !== generationInputRef)) {
        throw new Error("Build Executor generation grant changed its delivery binding");
      }
      sessionRef = action.grant.opaque_session_ref;
      generationInputRef = action.grant.generation_input_ref;
      generationGrantRef = action.grant.generation_grant_ref;
      phase = "grant";
    } else if (action.kind === "GENERATE") {
      if (!OPAQUE_SESSION_REF.test(action.opaque_session_ref)
        || !CANDIDATE_SINK_REF.test(action.candidate_sink_ref)) {
        throw new Error("Build Executor candidate sink binding is invalid");
      }
      // generation.start consumes the delivery-session ref but returns the task-session ref that
      // owns the candidate sink. Bind the connection to that code-issued successor before submit.
      sessionRef = action.opaque_session_ref;
      candidateSinkRef = action.candidate_sink_ref;
      phase = "generate";
    } else if (action.kind === "WAIT") {
      phase = "wait";
    } else {
      phase = "terminal";
    }
    lastObservedCallKey = callKey(call);
  };

  return Object.freeze({
    connection_capability: connectionCapability,
    authorize_connection: authorizeConnection,
    observe_response: observeResponse,
  });
}
