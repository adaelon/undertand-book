import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILD_EXECUTOR_MCP_CONTRACT_V3,
  createBuildExecutorToolAdapter,
  validateBuildExecutorRegistrationPlacementV3,
  validateBuildExecutorSharedMcpConfigV3,
} from "../src/build-executor-tool-adapter";
import {
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
  createBuildExecutorStdioConnectionCapability,
} from "../src/build-executor-connection-capability";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEDICATED_EXECUTOR_ONLY =
  "Only the dedicated `understand_book_executor` Executor may call this tool.";

function validSharedMcpConfig() {
  return {
    mcpServers: {
      book: { type: "stdio", command: "cmd.exe" },
      understand_book_build_executor: {
        type: "stdio",
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "scripts\\start-build-executor-mcp.cmd"],
        cwd: ".",
        required: false,
        enabled_tools: [...BUILD_EXECUTOR_MCP_CONTRACT_V3.tools.map((tool) => tool.name)],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 10,
        tool_timeout_sec: 120,
        env_vars: [
          "UNDERSTAND_BOOK_BUILD_EXE",
          "UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT",
          "USERPROFILE",
        ],
      },
    },
  };
}

describe("dormant Build Executor tool adapter", () => {
  it("R1/R2 publishes direct V3 bootstrap and MCP identities without a digest", () => {
    expect(BUILD_EXECUTOR_MCP_CONTRACT_V3.tools.map((tool) => tool.name)).toEqual([
      "executor.open",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
    ]);
    for (const tool of BUILD_EXECUTOR_MCP_CONTRACT_V3.tools) {
      expect(tool.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.input_schema.properties).not.toHaveProperty("now");
    }
    expect(BUILD_EXECUTOR_MCP_CONTRACT_V3).toMatchObject({
      version: "build_executor_mcp_contract.v3",
      registration_scope: "root_shared",
      session_protocol: "automatic_build_executor_session.v3",
      capability_binding: "stdio_connection",
      caller_role_authenticated: false,
      child_connection_ownership: "thread_owned_stdio_connection",
      parent_child_connection_shared: false,
    });
    expect(BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3).toEqual({
      version: "automatic_build_executor_bootstrap.v3",
      agent_name: "understand_book_executor",
      server_name: "understand_book_build_executor",
      registration_scope: "root_shared",
      role_projection: "bounded_agent_role_overrides",
      projected_role_reductions: ["shell_tool=false", "apps=false"],
      unprojected_agent_fields_are_child_contract: false,
      session_protocol: "automatic_build_executor_session.v3",
      capability_binding: "stdio_connection",
      caller_role_authenticated: false,
      tools: [
        "executor.open",
        "executor.input.next",
        "executor.generation.start",
        "executor.submit_candidate",
      ],
    });
    expect(JSON.stringify({
      bootstrap: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
      mcp: BUILD_EXECUTOR_MCP_CONTRACT_V3,
    })).not.toMatch(/digest|candidate_path|child_connection_capability|session_private_root/u);
  });

  it("R2 validates shared transport and registration placement as separate direct contracts", () => {
    expect(validateBuildExecutorSharedMcpConfigV3(JSON.stringify(validSharedMcpConfig()))).toEqual({
      status: "compatible",
      server_name: "understand_book_build_executor",
      registration_scope: "root_shared",
      required: false,
      default_tools_approval_mode: "approve",
      tool_names: BUILD_EXECUTOR_MCP_CONTRACT_V3.tools.map((tool) => tool.name),
    });
    expect(validateBuildExecutorRegistrationPlacementV3({
      plugin_mcp_json: validSharedMcpConfig(),
      agent_toml: 'name = "understand_book_executor"\n[features]\nshell_tool = false\napps = false\n',
      user_config_toml: "",
      project_config_toml: "",
    })).toEqual({
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
    });

    expect(() => validateBuildExecutorSharedMcpConfigV3({
      ...validSharedMcpConfig(),
      mcpServers: {
        ...validSharedMcpConfig().mcpServers,
        understand_book_build_executor: {
          ...validSharedMcpConfig().mcpServers.understand_book_build_executor,
          required: true,
        },
      },
    })).toThrow(/required/i);
    for (const field of ["agent_toml", "user_config_toml", "project_config_toml"] as const) {
      expect(() => validateBuildExecutorRegistrationPlacementV3({
        plugin_mcp_json: validSharedMcpConfig(),
        agent_toml: "",
        user_config_toml: "",
        project_config_toml: "",
        [field]: "[mcp_servers.understand_book_build_executor]\ncommand = \"cmd.exe\"\n",
      })).toThrow(/duplicate|placement|role/i);
    }
  });

  it("R1/R2 marks every listed tool as callable only by the dedicated Executor role", () => {
    const missing = BUILD_EXECUTOR_MCP_CONTRACT_V3.tools
      .filter((tool) => !tool.description.startsWith(DEDICATED_EXECUTOR_ONLY))
      .map((tool) => tool.name);
    // R1_RED action: R2 appends the dedicated-role warning to all four public descriptions.
    expect(missing).toEqual([]);
  });

  it("requires an out-of-band connection token before dispatch without treating it as role identity", () => {
    const childCapability = Object.freeze({ connection: "dedicated-child" });
    const wrongCapability = Object.freeze({ connection: "root" });
    const executed: unknown[] = [];
    const adapter = createBuildExecutorToolAdapter({
      authorize_connection: (capability) => capability === childCapability,
      execute_request: (request) => {
        executed.push(request);
        return {
          version: "automatic_build_executor_session.v3",
          action: { kind: "WAIT", retry_after_ms: 1_000 },
        };
      },
    });
    const request = {
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: `absession1_${"1".repeat(64)}`,
      candidate_sink_ref: `absink1_${"2".repeat(64)}`,
      candidate: { private_probe: "must-not-enter-a-tool-result" },
    };

    expect(() => adapter.call_tool("executor.submit_candidate", request)).toThrow(/child connection capability/i);
    expect(() => adapter.call_tool(
      "executor.submit_candidate",
      request,
      wrongCapability,
    )).toThrow(/child connection capability/i);
    expect(executed).toEqual([]);
    expect(adapter.call_tool("executor.submit_candidate", request, childCapability)).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "WAIT", retry_after_ms: 1_000 },
    });
    expect(executed).toEqual([request]);
  });

  it("rejects unclosed request fields before authorization or execution", () => {
    const authorized: unknown[] = [];
    const executed: unknown[] = [];
    const childCapability = Object.freeze({ connection: "dedicated-child" });
    const adapter = createBuildExecutorToolAdapter({
      authorize_connection: (capability) => {
        authorized.push(capability);
        return capability === childCapability;
      },
      execute_request: (request) => {
        executed.push(request);
        return {
          version: "automatic_build_executor_session.v3",
          action: { kind: "WAIT", retry_after_ms: 1_000 },
        };
      },
    });
    const base = {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: `abhandoff1_${"1".repeat(64)}`,
    };

    for (const extra of [
      { now: "2099-01-01T00:00:00.000Z" },
      { candidate_path: "C:\\private\\candidate.json" },
      { child_connection_capability: "model-controlled" },
    ]) {
      expect(() => adapter.call_tool(
        "executor.open",
        { ...base, ...extra },
        childCapability,
      )).toThrow(/unsupported|closed|field/i);
    }
    expect(authorized).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("R2 binds one thread-owned stdio capability to one handoff and direct ordinal state", () => {
    expect(() => createBuildExecutorStdioConnectionCapability({
      bootstrap_version: "automatic_build_executor_bootstrap.v2",
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
    })).toThrow(/stdio bootstrap version|protocol generation/i);
    const connection = createBuildExecutorStdioConnectionCapability({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
    });
    const handoff = `abhandoff1_${"1".repeat(64)}`;
    const otherHandoff = `abhandoff1_${"2".repeat(64)}`;
    const session = `absession1_${"3".repeat(64)}`;
    const inputRef = `abinput1_${"4".repeat(64)}`;
    const sinkRef = `absink1_${"6".repeat(64)}`;
    const openCall = {
      tool_name: "executor.open" as const,
      request: {
        version: "automatic_build_executor_open_request.v3",
        opaque_handoff_ref: handoff,
      },
    };

    expect(connection.authorize_connection(undefined, openCall)).toBe(false);
    expect(connection.authorize_connection(Symbol("root"), openCall)).toBe(false);
    expect(connection.authorize_connection(connection.connection_capability, openCall)).toBe(true);
    connection.observe_response(openCall, {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "DELIVER_INPUT",
        input_manifest: {
          version: "automatic_build_executor_input_manifest.v3",
          opaque_session_ref: session,
          generation_input_ref: inputRef,
          segments: [],
          total_chunk_count: 1,
        },
        next_request: {
          version: "automatic_build_executor_input_next_request.v4",
          opaque_session_ref: session,
          generation_input_ref: inputRef,
        },
      },
    });

    expect(connection.authorize_connection(connection.connection_capability, {
      ...openCall,
      request: { ...openCall.request, opaque_handoff_ref: otherHandoff },
    })).toBe(false);
    const nextCall = {
      tool_name: "executor.input.next" as const,
      request: {
        version: "automatic_build_executor_input_next_request.v4",
        opaque_session_ref: session,
        generation_input_ref: inputRef,
      },
    };
    expect(connection.authorize_connection(connection.connection_capability, nextCall)).toBe(true);
    expect(connection.authorize_connection(connection.connection_capability, {
      ...nextCall,
      request: { ...nextCall.request, previous_chunk_receipt: `abchunk1_${"7".repeat(64)}` },
    })).toBe(false);
    const firstBatchResponse = {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "INPUT_BATCH",
        batch: {
          version: "automatic_build_executor_input_batch.v1",
          opaque_session_ref: session,
          generation_input_ref: inputRef,
          first_ordinal: 0,
          last_ordinal: 0,
          final_for_generation: true,
          chunks: [{
          version: "automatic_build_executor_input_chunk.v3",
          opaque_session_ref: session,
          generation_input_ref: inputRef,
          segment: "semantic_input",
          ordinal: 0,
          byte_range: { start: 0, end: 2 },
          payload_utf8: "{}",
          final_for_segment: true,
          final_for_generation: true,
          }],
        },
      },
    } as const;
    connection.observe_response(nextCall, firstBatchResponse);
    expect(connection.authorize_connection(connection.connection_capability, nextCall)).toBe(true);
    connection.observe_response(nextCall, firstBatchResponse);
    expect(connection.authorize_connection(connection.connection_capability, {
      ...nextCall,
      request: { ...nextCall.request, ack_through_ordinal: 1 },
    })).toBe(false);
    const startCall = {
      tool_name: "executor.generation.start" as const,
      request: {
        version: "automatic_build_executor_generation_start_request.v3",
        opaque_session_ref: session,
        generation_input_ref: inputRef,
        confirmed_through_ordinal: 0,
      },
    };
    expect(connection.authorize_connection(connection.connection_capability, startCall)).toBe(true);
    connection.observe_response(startCall, {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "GENERATE",
        opaque_session_ref: session,
        candidate_sink_ref: sinkRef,
        semantic_attempt: 1,
        output_contract: {
          version: "automatic_build_semantic_candidate_contract.v2",
          format: "strict_json",
          encoding: "utf-8",
          max_bytes: 1024,
          stage: "book_structure",
          work_unit_id: "unit:1",
          work_unit_kind: "book_structure_unit",
          input_hash: "9".repeat(64),
        },
      },
    });
    expect(connection.authorize_connection(connection.connection_capability, {
      tool_name: "executor.submit_candidate",
      request: {
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: session,
        candidate_sink_ref: sinkRef,
        candidate: { ok: true },
      },
    })).toBe(true);
    expect(connection.authorize_connection(connection.connection_capability, {
      tool_name: "executor.submit_candidate",
      request: {
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: `absession1_${"a".repeat(64)}`,
        candidate_sink_ref: sinkRef,
        candidate: { ok: true },
      },
    })).toBe(false);
    expect(JSON.stringify(connection)).not.toMatch(/connection_capability|session_private_root|\.t6-private-root/u);
  });

  it("R2 rebinds a fresh stdio connection from resumable executor.open responses", () => {
    const createConnection = () => createBuildExecutorStdioConnectionCapability({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t8-resume-private-root"),
    });
    const handoff = `abhandoff1_${"1".repeat(64)}`;
    const deliverySession = `absession1_${"2".repeat(64)}`;
    const taskSession = `absession1_${"3".repeat(64)}`;
    const inputRef = `abinput1_${"4".repeat(64)}`;
    const sinkRef = `absink1_${"7".repeat(64)}`;
    const openCall = {
      tool_name: "executor.open" as const,
      request: {
        version: "automatic_build_executor_open_request.v3",
        opaque_handoff_ref: handoff,
      },
    };

    const partialDelivery = createConnection();
    expect(partialDelivery.authorize_connection(
      partialDelivery.connection_capability,
      openCall,
    )).toBe(true);
    partialDelivery.observe_response(openCall, {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "DELIVER_INPUT",
        input_manifest: {
          version: "automatic_build_executor_input_manifest.v3",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
          segments: [],
          total_chunk_count: 2,
        },
        next_request: {
          version: "automatic_build_executor_input_next_request.v4",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
          ack_through_ordinal: 0,
        },
      },
    });
    expect(partialDelivery.authorize_connection(partialDelivery.connection_capability, {
      tool_name: "executor.input.next",
      request: {
        version: "automatic_build_executor_input_next_request.v4",
        opaque_session_ref: deliverySession,
        generation_input_ref: inputRef,
        ack_through_ordinal: 0,
      },
    })).toBe(true);

    const granted = createConnection();
    expect(granted.authorize_connection(granted.connection_capability, openCall)).toBe(true);
    granted.observe_response(openCall, {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "DELIVER_INPUT",
        input_manifest: {
          version: "automatic_build_executor_input_manifest.v3",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
          segments: [],
          total_chunk_count: 1,
        },
        next_request: {
          version: "automatic_build_executor_input_next_request.v4",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
        },
      },
    });
    const finalBatchCall = {
      tool_name: "executor.input.next" as const,
      request: {
        version: "automatic_build_executor_input_next_request.v4",
        opaque_session_ref: deliverySession,
        generation_input_ref: inputRef,
      },
    };
    expect(granted.authorize_connection(granted.connection_capability, finalBatchCall)).toBe(true);
    granted.observe_response(finalBatchCall, {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "INPUT_BATCH",
        batch: {
          version: "automatic_build_executor_input_batch.v1",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
          first_ordinal: 0,
          last_ordinal: 0,
          final_for_generation: true,
          chunks: [{
            version: "automatic_build_executor_input_chunk.v3",
            opaque_session_ref: deliverySession,
            generation_input_ref: inputRef,
            segment: "semantic_input",
            ordinal: 0,
            byte_range: { start: 0, end: 2 },
            payload_utf8: "{}",
            final_for_segment: true,
            final_for_generation: true,
          }],
        },
      },
    });
    expect(granted.authorize_connection(granted.connection_capability, {
      tool_name: "executor.generation.start",
      request: {
        version: "automatic_build_executor_generation_start_request.v3",
        opaque_session_ref: deliverySession,
        generation_input_ref: inputRef,
        confirmed_through_ordinal: 0,
      },
    })).toBe(true);

    const generating = createConnection();
    expect(generating.authorize_connection(generating.connection_capability, openCall)).toBe(true);
    generating.observe_response(openCall, {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "GENERATE",
        opaque_session_ref: taskSession,
        candidate_sink_ref: sinkRef,
        semantic_attempt: 1,
        output_contract: {
          version: "automatic_build_semantic_candidate_contract.v2",
          format: "strict_json",
          encoding: "utf-8",
          max_bytes: 1024,
          stage: "book_structure",
          work_unit_id: "unit:resume",
          work_unit_kind: "book_structure_unit",
          input_hash: "a".repeat(64),
        },
      },
    });
    expect(generating.authorize_connection(generating.connection_capability, {
      tool_name: "executor.submit_candidate",
      request: {
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: taskSession,
        candidate_sink_ref: sinkRef,
        candidate: { resumed: true },
      },
    })).toBe(true);
  });

  it("R1 keeps transport out of project config while both plugin configs expose exact-four tools", () => {
    const rootConfigPath = path.join(REPO_ROOT, ".codex", "config.toml");
    const rootConfig = existsSync(rootConfigPath) ? readFileSync(rootConfigPath, "utf8") : "";
    const rootPluginMcp = readFileSync(path.join(REPO_ROOT, ".mcp.json"), "utf8");
    const releasePluginMcp = readFileSync(
      path.join(REPO_ROOT, "plugins", "understand-book", ".mcp.json"),
      "utf8",
    );
    const sidecarEntry = readFileSync(path.join(REPO_ROOT, "skills", "build", "sidecar-entry.ts"), "utf8");

    expect(rootConfig).not.toContain(BUILD_EXECUTOR_MCP_CONTRACT_V3.server_name);
    const missing: string[] = [];
    for (const [label, pluginMcp] of [
      ["root", rootPluginMcp],
      ["release", releasePluginMcp],
    ] as const) {
      if (!pluginMcp.includes(BUILD_EXECUTOR_MCP_CONTRACT_V3.server_name)) {
        missing.push(`${label}.server`);
      }
      for (const tool of BUILD_EXECUTOR_MCP_CONTRACT_V3.tools) {
        if (!pluginMcp.includes(tool.name)) missing.push(`${label}.${tool.name}`);
      }
    }
    // R1_RED action: R3 moves the shared transport into the two plugin-owned MCP configs.
    expect(missing).toEqual([]);
    expect(releasePluginMcp).toBe(rootPluginMcp);
    for (const pluginMcp of [rootPluginMcp, releasePluginMcp]) {
      expect(validateBuildExecutorSharedMcpConfigV3(pluginMcp)).toEqual({
        status: "compatible",
        server_name: "understand_book_build_executor",
        registration_scope: "root_shared",
        required: false,
        default_tools_approval_mode: "approve",
        tool_names: BUILD_EXECUTOR_MCP_CONTRACT_V3.tools.map((tool) => tool.name),
      });
    }
    for (const tool of BUILD_EXECUTOR_MCP_CONTRACT_V3.tools) {
      expect(rootConfig).not.toContain(tool.name);
    }
    expect(sidecarEntry).toContain("\"executor.submit_candidate\"");
  });
});
