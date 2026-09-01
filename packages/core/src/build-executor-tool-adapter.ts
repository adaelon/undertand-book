import {
  runAutomaticBuildExecutorSessionCommand,
  type AutomaticBuildExecutorSessionResponseV3,
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

const DEDICATED_EXECUTOR_ONLY =
  "Only the dedicated `understand_book_executor` Executor may call this tool.";
const SHARED_EXECUTOR_LAUNCHER_ARGS = Object.freeze([
  "/d",
  "/s",
  "/c",
  "scripts\\start-build-executor-mcp.cmd",
] as const);
const SHARED_EXECUTOR_ENV_VARS = Object.freeze([
  "UNDERSTAND_BOOK_BUILD_EXE",
  "UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT",
  "USERPROFILE",
] as const);

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
const ORDINAL_SCHEMA = Object.freeze({
  type: "integer",
  minimum: 0,
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

const BUILD_EXECUTOR_TOOL_CONTRACTS_V3 = Object.freeze([
    {
      name: "executor.open" as const,
      description: `${DEDICATED_EXECUTOR_ONLY} Open or resume one bounded executor delivery session.`,
      input_schema: closedSchema(
        "automatic_build_executor_open_request.v3",
        ["opaque_handoff_ref"],
        { opaque_handoff_ref: HANDOFF_REF_SCHEMA },
      ),
    },
    {
      name: "executor.input.next" as const,
      description: `${DEDICATED_EXECUTOR_ONLY} Read the next ordered semantic input chunk.`,
      input_schema: closedSchema(
        "automatic_build_executor_input_next_request.v4",
        ["opaque_session_ref", "generation_input_ref"],
        {
          opaque_session_ref: SESSION_REF_SCHEMA,
          generation_input_ref: INPUT_REF_SCHEMA,
          ack_through_ordinal: ORDINAL_SCHEMA,
        },
      ),
    },
    {
      name: "executor.generation.start" as const,
      description: `${DEDICATED_EXECUTOR_ONLY} Accept one generation grant and create or replay its semantic attempt.`,
      input_schema: closedSchema(
        "automatic_build_executor_generation_start_request.v3",
        ["opaque_session_ref", "generation_input_ref", "confirmed_through_ordinal"],
        {
          opaque_session_ref: SESSION_REF_SCHEMA,
          generation_input_ref: INPUT_REF_SCHEMA,
          confirmed_through_ordinal: ORDINAL_SCHEMA,
        },
      ),
    },
    {
      name: "executor.submit_candidate" as const,
      description: `${DEDICATED_EXECUTOR_ONLY} Submit one structured JSON candidate to its code-owned private sink.`,
      input_schema: closedSchema(
        "automatic_build_executor_candidate_submit.v3",
        ["opaque_session_ref", "candidate_sink_ref", "candidate"],
        {
          opaque_session_ref: SESSION_REF_SCHEMA,
          candidate_sink_ref: SINK_REF_SCHEMA,
          candidate: JSON_VALUE_SCHEMA,
        },
      ),
    },
  ] satisfies BuildExecutorToolContractV1[]);

export const BUILD_EXECUTOR_MCP_CONTRACT_V3 = Object.freeze({
  version: "build_executor_mcp_contract.v3" as const,
  server_name: BUILD_EXECUTOR_SERVER_NAME_V1,
  registration_scope: "root_shared" as const,
  session_protocol: "automatic_build_executor_session.v3" as const,
  capability_binding: "stdio_connection" as const,
  caller_role_authenticated: false as const,
  child_connection_ownership: "thread_owned_stdio_connection" as const,
  parent_child_connection_shared: false as const,
  tools: BUILD_EXECUTOR_TOOL_CONTRACTS_V3,
});

export interface BuildExecutorSharedMcpConfigValidationV3 {
  status: "compatible";
  server_name: typeof BUILD_EXECUTOR_SERVER_NAME_V1;
  registration_scope: "root_shared";
  required: false;
  default_tools_approval_mode: "approve";
  tool_names: BuildExecutorToolNameV1[];
}

export interface BuildExecutorRegistrationPlacementValidationV3 {
  status: "compatible";
  registration_scope: "root_shared";
  plugin_parent_server_registered: true;
  child_effective_config_inherits_registration: true;
  agent_local_server_registered: false;
  user_config_server_registered: false;
  project_config_server_registered: false;
  child_connection_ownership: "thread_owned_stdio_connection";
  parent_child_connection_shared: false;
  caller_role_authenticated: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Build Executor shared MCP config is not valid JSON");
    }
  }
  if (!isRecord(parsed)) throw new Error("Build Executor shared MCP config must be an object");
  return parsed;
}

function exactArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

export function validateBuildExecutorSharedMcpConfigV3(
  pluginMcpJson: unknown,
): BuildExecutorSharedMcpConfigValidationV3 {
  const config = parseJsonObject(pluginMcpJson);
  const servers = config.mcpServers;
  if (!isRecord(servers) || !Object.hasOwn(servers, BUILD_EXECUTOR_SERVER_NAME_V1)) {
    throw new Error("Build Executor shared MCP server is missing from the plugin parent surface");
  }
  const server = servers[BUILD_EXECUTOR_SERVER_NAME_V1];
  if (!isRecord(server)) throw new Error("Build Executor shared MCP server config is invalid");
  if (server.type !== "stdio") throw new Error("Build Executor shared MCP type must be stdio");
  if (server.command !== "cmd.exe"
    || !exactArray(server.args, SHARED_EXECUTOR_LAUNCHER_ARGS)
    || server.cwd !== ".") {
    throw new Error("Build Executor shared MCP launcher must be plugin-root relative");
  }
  if (server.required !== false) throw new Error("Build Executor shared MCP required must be false");
  if (!exactArray(server.enabled_tools, BUILD_EXECUTOR_TOOL_NAMES_V1)) {
    throw new Error("Build Executor shared MCP enabled_tools must be the exact four-tool inventory");
  }
  if (server.default_tools_approval_mode !== "approve") {
    throw new Error("Build Executor shared MCP approval mode must be approve");
  }
  if (server.startup_timeout_sec !== 10 || server.tool_timeout_sec !== 120) {
    throw new Error("Build Executor shared MCP timeout surface is incompatible");
  }
  if (!exactArray(server.env_vars, SHARED_EXECUTOR_ENV_VARS)) {
    throw new Error("Build Executor shared MCP environment surface is incompatible");
  }
  return {
    status: "compatible",
    server_name: BUILD_EXECUTOR_SERVER_NAME_V1,
    registration_scope: "root_shared",
    required: false,
    default_tools_approval_mode: "approve",
    tool_names: [...BUILD_EXECUTOR_TOOL_NAMES_V1],
  };
}

function containsExecutorMcpRegistration(toml: string): boolean {
  return /^\[mcp_servers\.understand_book_build_executor\]\s*$/mu.test(
    toml.replace(/\r\n?/gu, "\n"),
  );
}

export function validateBuildExecutorRegistrationPlacementV3(input: {
  plugin_mcp_json: unknown;
  agent_toml: string;
  user_config_toml?: string;
  project_config_toml?: string;
}): BuildExecutorRegistrationPlacementValidationV3 {
  validateBuildExecutorSharedMcpConfigV3(input.plugin_mcp_json);
  if (containsExecutorMcpRegistration(input.agent_toml)) {
    throw new Error("Build Executor role placement must not contain a duplicate MCP transport");
  }
  if (containsExecutorMcpRegistration(input.user_config_toml ?? "")) {
    throw new Error("Build Executor user config contains a duplicate plugin transport");
  }
  if (containsExecutorMcpRegistration(input.project_config_toml ?? "")) {
    throw new Error("Build Executor project config contains a duplicate plugin transport");
  }
  return {
    status: "compatible",
    registration_scope: "root_shared",
    plugin_parent_server_registered: true,
    child_effective_config_inherits_registration: true,
    agent_local_server_registered: false,
    user_config_server_registered: false,
    project_config_server_registered: false,
    child_connection_ownership: "thread_owned_stdio_connection",
    parent_child_connection_shared: false,
    caller_role_authenticated: false,
  };
}

export function validateBuildExecutorRegistrationScope(input: {
  surface: "agent" | "root" | "project";
  server_names: readonly string[];
}): void {
  const registered = input.server_names.includes(BUILD_EXECUTOR_SERVER_NAME_V1);
  if (input.surface === "agent") {
    if (!registered) throw new Error("agent-only Build Executor server registration is missing");
    return;
  }
  if (registered) {
    throw new Error(`agent-only Build Executor server must not be registered on ${input.surface}`);
  }
}

const REQUEST_VERSION_BY_TOOL = Object.freeze({
  "executor.open": "automatic_build_executor_open_request.v3",
  "executor.input.next": "automatic_build_executor_input_next_request.v4",
  "executor.generation.start": "automatic_build_executor_generation_start_request.v3",
  "executor.submit_candidate": "automatic_build_executor_candidate_submit.v3",
} satisfies Record<BuildExecutorToolNameV1, string>);

type BuildExecutorResponse = AutomaticBuildExecutorSessionResponseV3;

const REQUEST_KEYS_BY_TOOL = Object.freeze({
  "executor.open": {
    required: ["version", "opaque_handoff_ref"],
    optional: [],
  },
  "executor.input.next": {
    required: ["version", "opaque_session_ref", "generation_input_ref"],
    optional: ["ack_through_ordinal"],
  },
  "executor.generation.start": {
    required: [
      "version",
      "opaque_session_ref",
      "generation_input_ref",
      "confirmed_through_ordinal",
    ],
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
    list_tools: () => BUILD_EXECUTOR_MCP_CONTRACT_V3.tools,
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
      if (response.version !== "automatic_build_executor_session.v3") {
        throw new Error("Build Executor MCP accepts only V3 session responses");
      }
      return response;
    },
  });
}
