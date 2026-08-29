import {
  runAutomaticBuildExecutorSessionCommand,
  type AutomaticBuildExecutorSessionResponseV2,
} from "./automatic-build-executor-session";
import {
  BUILD_EXECUTOR_SERVER_NAME_V1,
  BUILD_EXECUTOR_TOOL_NAMES_V1,
  type BuildExecutorToolNameV1,
} from "./build-executor-tool-contract";

export { BUILD_EXECUTOR_TOOL_NAMES_V1 } from "./build-executor-tool-contract";
export type { BuildExecutorToolNameV1 } from "./build-executor-tool-contract";

interface ClosedObjectSchemaV1 {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, unknown>;
}

export interface BuildExecutorToolContractV1 {
  name: BuildExecutorToolNameV1;
  description: string;
  input_schema: ClosedObjectSchemaV1;
}

const HANDOFF_REF_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^abhandoff1_[a-f0-9]{64}$",
  maxLength: 75,
});
const SESSION_REF_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^absession1_[a-f0-9]{64}$",
  maxLength: 75,
});
const INPUT_REF_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^abinput1_[a-f0-9]{64}$",
  maxLength: 73,
});
const CHUNK_RECEIPT_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^abchunk1_[a-f0-9]{64}$",
  maxLength: 73,
});
const GRANT_REF_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^abgrant1_[a-f0-9]{64}$",
  maxLength: 73,
});
const SINK_REF_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^absink1_[a-f0-9]{64}$",
  maxLength: 72,
});
const JSON_VALUE_SCHEMA = Object.freeze({
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: true },
  ],
});

function closedSchema(
  version: string,
  required: string[],
  properties: Record<string, unknown>,
): ClosedObjectSchemaV1 {
  return {
    type: "object",
    additionalProperties: false,
    required: ["version", ...required],
    properties: {
      version: { const: version },
      ...properties,
    },
  };
}

export const BUILD_EXECUTOR_MCP_CONTRACT_V1 = Object.freeze({
  version: "build_executor_mcp_contract.v1" as const,
  server_name: BUILD_EXECUTOR_SERVER_NAME_V1,
  registration_scope: "agent_only" as const,
  tools: Object.freeze([
    {
      name: "executor.open" as const,
      description: "Open or resume one bounded V2 executor delivery session.",
      input_schema: closedSchema(
        "automatic_build_executor_open_request.v2",
        ["opaque_handoff_ref"],
        { opaque_handoff_ref: HANDOFF_REF_SCHEMA },
      ),
    },
    {
      name: "executor.input.next" as const,
      description: "Read the next receipt-bound semantic input chunk.",
      input_schema: closedSchema(
        "automatic_build_executor_input_next_request.v2",
        ["opaque_session_ref", "generation_input_ref"],
        {
          opaque_session_ref: SESSION_REF_SCHEMA,
          generation_input_ref: INPUT_REF_SCHEMA,
          previous_chunk_receipt: CHUNK_RECEIPT_SCHEMA,
        },
      ),
    },
    {
      name: "executor.generation.start" as const,
      description: "Accept one generation grant and create or replay its semantic attempt.",
      input_schema: closedSchema(
        "automatic_build_executor_generation_start_request.v1",
        ["opaque_session_ref", "generation_grant_ref"],
        {
          opaque_session_ref: SESSION_REF_SCHEMA,
          generation_grant_ref: GRANT_REF_SCHEMA,
        },
      ),
    },
    {
      name: "executor.submit_candidate" as const,
      description: "Submit one structured JSON candidate to its code-owned private sink.",
      input_schema: closedSchema(
        "automatic_build_executor_candidate_submit.v2",
        ["opaque_session_ref", "candidate_sink_ref", "candidate"],
        {
          opaque_session_ref: SESSION_REF_SCHEMA,
          candidate_sink_ref: SINK_REF_SCHEMA,
          candidate: JSON_VALUE_SCHEMA,
        },
      ),
    },
  ] satisfies BuildExecutorToolContractV1[]),
});

export function validateBuildExecutorRegistrationScope(input: {
  surface: "agent" | "root" | "project";
  server_names: readonly string[];
}): void {
  const registered = input.server_names.includes(BUILD_EXECUTOR_MCP_CONTRACT_V1.server_name);
  if (input.surface === "agent") {
    if (!registered) throw new Error("agent-only Build Executor server registration is missing");
    return;
  }
  if (registered) {
    throw new Error(`agent-only Build Executor server must not be registered on ${input.surface}`);
  }
}

const REQUEST_VERSION_BY_TOOL = Object.freeze({
  "executor.open": "automatic_build_executor_open_request.v2",
  "executor.input.next": "automatic_build_executor_input_next_request.v2",
  "executor.generation.start": "automatic_build_executor_generation_start_request.v1",
  "executor.submit_candidate": "automatic_build_executor_candidate_submit.v2",
} satisfies Record<BuildExecutorToolNameV1, string>);

type BuildExecutorResponse = AutomaticBuildExecutorSessionResponseV2;

const REQUEST_KEYS_BY_TOOL = Object.freeze({
  "executor.open": {
    required: ["version", "opaque_handoff_ref"],
    optional: [],
  },
  "executor.input.next": {
    required: ["version", "opaque_session_ref", "generation_input_ref"],
    optional: ["previous_chunk_receipt"],
  },
  "executor.generation.start": {
    required: ["version", "opaque_session_ref", "generation_grant_ref"],
    optional: [],
  },
  "executor.submit_candidate": {
    required: ["version", "opaque_session_ref", "candidate_sink_ref", "candidate"],
    optional: [],
  },
} satisfies Record<BuildExecutorToolNameV1, { required: string[]; optional: string[] }>);

function validateClosedToolRequest(toolName: BuildExecutorToolNameV1, request: unknown): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Build Executor tool request must be a closed object");
  }
  const record = request as Record<string, unknown>;
  const shape = REQUEST_KEYS_BY_TOOL[toolName];
  const allowed = new Set([...shape.required, ...shape.optional]);
  if (shape.required.some((key) => !(key in record))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Build Executor tool request contains unsupported or missing fields");
  }
  if (record.version !== REQUEST_VERSION_BY_TOOL[toolName]) {
    throw new Error("Build Executor tool request version does not match the selected tool");
  }
}

export function createBuildExecutorToolAdapter(input: {
  authorize_connection: (
    capability: unknown,
    call: { tool_name: BuildExecutorToolNameV1; request: unknown },
  ) => boolean;
  execute_request?: (request: unknown) => BuildExecutorResponse;
}): {
  list_tools: () => readonly BuildExecutorToolContractV1[];
  call_tool: (
    toolName: BuildExecutorToolNameV1,
    request: unknown,
    connectionCapability?: unknown,
  ) => BuildExecutorResponse;
} {
  if (typeof input.authorize_connection !== "function") {
    throw new Error("Build Executor adapter requires a child connection authorizer");
  }
  const executeRequest = input.execute_request ?? runAutomaticBuildExecutorSessionCommand;
  return Object.freeze({
    list_tools: () => BUILD_EXECUTOR_MCP_CONTRACT_V1.tools,
    call_tool: (
      toolName: BuildExecutorToolNameV1,
      request: unknown,
      connectionCapability?: unknown,
    ): BuildExecutorResponse => {
      if (!(BUILD_EXECUTOR_TOOL_NAMES_V1 as readonly string[]).includes(toolName)) {
        throw new Error("Build Executor tool is unsupported");
      }
      validateClosedToolRequest(toolName, request);
      if (!input.authorize_connection(connectionCapability, { tool_name: toolName, request })) {
        throw new Error("Build Executor child connection capability is missing or invalid");
      }
      const response = executeRequest(request);
      if (response.version !== "automatic_build_executor_session.v2") {
        throw new Error("Build Executor MCP accepts only V2 session responses");
      }
      return response;
    },
  });
}
