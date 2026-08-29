import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILD_EXECUTOR_MCP_CONTRACT_V1,
  createBuildExecutorToolAdapter,
  validateBuildExecutorRegistrationScope,
} from "../src/build-executor-tool-adapter";
import {
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2,
  createBuildExecutorChildConnectionCapability,
} from "../src/build-executor-connection-capability";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("dormant Build Executor tool adapter", () => {
  it("publishes a closed agent-only contract without path or capability arguments", () => {
    expect(BUILD_EXECUTOR_MCP_CONTRACT_V1).toMatchObject({
      version: "build_executor_mcp_contract.v1",
      server_name: "understand_book_build_executor",
      registration_scope: "agent_only",
    });
    expect(BUILD_EXECUTOR_MCP_CONTRACT_V1.tools.map((tool) => tool.name)).toEqual([
      "executor.open",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
    ]);
    for (const tool of BUILD_EXECUTOR_MCP_CONTRACT_V1.tools) {
      expect(tool.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.input_schema.properties).not.toHaveProperty("now");
    }
    const serialized = JSON.stringify(BUILD_EXECUTOR_MCP_CONTRACT_V1);
    expect(serialized).not.toMatch(/candidate_path|child_connection_capability|capability_digest|session_private_root/u);

    expect(() => validateBuildExecutorRegistrationScope({
      surface: "agent",
      server_names: [BUILD_EXECUTOR_MCP_CONTRACT_V1.server_name],
    })).not.toThrow();
    expect(() => validateBuildExecutorRegistrationScope({
      surface: "root",
      server_names: [BUILD_EXECUTOR_MCP_CONTRACT_V1.server_name],
    })).toThrow(/agent-only|root/i);
    expect(() => validateBuildExecutorRegistrationScope({
      surface: "project",
      server_names: [BUILD_EXECUTOR_MCP_CONTRACT_V1.server_name],
    })).toThrow(/agent-only|project/i);
  });

  it("requires an out-of-band child connection capability before dispatch", () => {
    const childCapability = Object.freeze({ connection: "dedicated-child" });
    const wrongCapability = Object.freeze({ connection: "root" });
    const executed: unknown[] = [];
    const adapter = createBuildExecutorToolAdapter({
      authorize_connection: (capability) => capability === childCapability,
      execute_request: (request) => {
        executed.push(request);
        return {
          version: "automatic_build_executor_session.v2",
          action: { kind: "WAIT", retry_after_ms: 1_000 },
        };
      },
    });
    const request = {
      version: "automatic_build_executor_candidate_submit.v2",
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
      version: "automatic_build_executor_session.v2",
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
          version: "automatic_build_executor_session.v2",
          action: { kind: "WAIT", retry_after_ms: 1_000 },
        };
      },
    });
    const base = {
      version: "automatic_build_executor_open_request.v2",
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

  it("binds one process-private capability to one handoff and its derived session refs", () => {
    const connection = createBuildExecutorChildConnectionCapability({
      bootstrap_digest: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
    });
    const handoff = `abhandoff1_${"1".repeat(64)}`;
    const otherHandoff = `abhandoff1_${"2".repeat(64)}`;
    const session = `absession1_${"3".repeat(64)}`;
    const inputRef = `abinput1_${"4".repeat(64)}`;
    const grantRef = `abgrant1_${"5".repeat(64)}`;
    const sinkRef = `absink1_${"6".repeat(64)}`;
    const openCall = {
      tool_name: "executor.open" as const,
      request: {
        version: "automatic_build_executor_open_request.v2",
        opaque_handoff_ref: handoff,
      },
    };

    expect(connection.authorize_connection(undefined, openCall)).toBe(false);
    expect(connection.authorize_connection(Symbol("root"), openCall)).toBe(false);
    expect(connection.authorize_connection(connection.connection_capability, openCall)).toBe(true);
    connection.observe_response(openCall, {
      version: "automatic_build_executor_session.v2",
      action: {
        kind: "DELIVER_INPUT",
        input_manifest: {
          version: "automatic_build_executor_input_manifest.v2",
          opaque_session_ref: session,
          generation_input_ref: inputRef,
          transport_profile_digest: "7".repeat(64),
          segments: [],
          total_chunk_count: 1,
        },
        next_request: {
          version: "automatic_build_executor_input_next_request.v2",
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
        version: "automatic_build_executor_input_next_request.v2",
        opaque_session_ref: session,
        generation_input_ref: inputRef,
      },
    };
    expect(connection.authorize_connection(connection.connection_capability, nextCall)).toBe(true);
    connection.observe_response(nextCall, {
      version: "automatic_build_executor_session.v2",
      action: {
        kind: "GENERATION_GRANT",
        grant: {
          version: "automatic_build_executor_generation_grant.v1",
          opaque_session_ref: session,
          generation_input_ref: inputRef,
          generation_grant_ref: grantRef,
          output_contract_digest: "8".repeat(64),
        },
      },
    });
    const startCall = {
      tool_name: "executor.generation.start" as const,
      request: {
        version: "automatic_build_executor_generation_start_request.v1",
        opaque_session_ref: session,
        generation_grant_ref: grantRef,
      },
    };
    expect(connection.authorize_connection(connection.connection_capability, startCall)).toBe(true);
    connection.observe_response(startCall, {
      version: "automatic_build_executor_session.v2",
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
        version: "automatic_build_executor_candidate_submit.v2",
        opaque_session_ref: session,
        candidate_sink_ref: sinkRef,
        candidate: { ok: true },
      },
    })).toBe(true);
    expect(connection.authorize_connection(connection.connection_capability, {
      tool_name: "executor.submit_candidate",
      request: {
        version: "automatic_build_executor_candidate_submit.v2",
        opaque_session_ref: `absession1_${"a".repeat(64)}`,
        candidate_sink_ref: sinkRef,
        candidate: { ok: true },
      },
    })).toBe(false);
    expect(JSON.stringify(connection)).not.toMatch(/connection_capability|session_private_root|\.t6-private-root/u);
  });

  it("rebinds a fresh connection from resumable executor.open responses", () => {
    const createConnection = () => createBuildExecutorChildConnectionCapability({
      bootstrap_digest: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t8-resume-private-root"),
    });
    const handoff = `abhandoff1_${"1".repeat(64)}`;
    const deliverySession = `absession1_${"2".repeat(64)}`;
    const taskSession = `absession1_${"3".repeat(64)}`;
    const inputRef = `abinput1_${"4".repeat(64)}`;
    const receipt = `abchunk1_${"5".repeat(64)}`;
    const grantRef = `abgrant1_${"6".repeat(64)}`;
    const sinkRef = `absink1_${"7".repeat(64)}`;
    const openCall = {
      tool_name: "executor.open" as const,
      request: {
        version: "automatic_build_executor_open_request.v2",
        opaque_handoff_ref: handoff,
      },
    };

    const partialDelivery = createConnection();
    expect(partialDelivery.authorize_connection(
      partialDelivery.connection_capability,
      openCall,
    )).toBe(true);
    partialDelivery.observe_response(openCall, {
      version: "automatic_build_executor_session.v2",
      action: {
        kind: "DELIVER_INPUT",
        input_manifest: {
          version: "automatic_build_executor_input_manifest.v2",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
          transport_profile_digest: "8".repeat(64),
          segments: [],
          total_chunk_count: 2,
        },
        next_request: {
          version: "automatic_build_executor_input_next_request.v2",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
          previous_chunk_receipt: receipt,
        },
      },
    });
    expect(partialDelivery.authorize_connection(partialDelivery.connection_capability, {
      tool_name: "executor.input.next",
      request: {
        version: "automatic_build_executor_input_next_request.v2",
        opaque_session_ref: deliverySession,
        generation_input_ref: inputRef,
        previous_chunk_receipt: receipt,
      },
    })).toBe(true);

    const granted = createConnection();
    expect(granted.authorize_connection(granted.connection_capability, openCall)).toBe(true);
    granted.observe_response(openCall, {
      version: "automatic_build_executor_session.v2",
      action: {
        kind: "GENERATION_GRANT",
        grant: {
          version: "automatic_build_executor_generation_grant.v1",
          opaque_session_ref: deliverySession,
          generation_input_ref: inputRef,
          generation_grant_ref: grantRef,
          output_contract_digest: "9".repeat(64),
        },
      },
    });
    expect(granted.authorize_connection(granted.connection_capability, {
      tool_name: "executor.generation.start",
      request: {
        version: "automatic_build_executor_generation_start_request.v1",
        opaque_session_ref: deliverySession,
        generation_grant_ref: grantRef,
      },
    })).toBe(true);

    const generating = createConnection();
    expect(generating.authorize_connection(generating.connection_capability, openCall)).toBe(true);
    generating.observe_response(openCall, {
      version: "automatic_build_executor_session.v2",
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
        version: "automatic_build_executor_candidate_submit.v2",
        opaque_session_ref: taskSession,
        candidate_sink_ref: sinkRef,
        candidate: { resumed: true },
      },
    })).toBe(true);
  });

  it("keeps the dormant submit alias out of root and project MCP configuration", () => {
    const rootConfig = readFileSync(path.join(REPO_ROOT, ".codex", "config.toml"), "utf8");
    const projectMcp = readFileSync(path.join(
      REPO_ROOT,
      "plugins",
      "understand-book",
      ".mcp.json",
    ), "utf8");
    const sidecarEntry = readFileSync(path.join(REPO_ROOT, "skills", "build", "sidecar-entry.ts"), "utf8");

    expect(`${rootConfig}\n${projectMcp}`).not.toContain(BUILD_EXECUTOR_MCP_CONTRACT_V1.server_name);
    for (const tool of BUILD_EXECUTOR_MCP_CONTRACT_V1.tools) {
      expect(`${rootConfig}\n${projectMcp}`).not.toContain(tool.name);
    }
    expect(sidecarEntry).toContain("\"executor.submit_candidate\"");
  });
});
