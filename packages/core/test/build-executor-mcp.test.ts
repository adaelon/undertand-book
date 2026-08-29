import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2 } from "../src/build-executor-connection-capability";
import { createBuildExecutorMcpSession } from "../../../skills/build/build-executor-mcp";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("Build Executor agent-only MCP", () => {
  it("negotiates MCP and exposes exactly the four closed executor tools", () => {
    const session = createBuildExecutorMcpSession({
      bootstrap_digest: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
      execute_request: () => ({
        version: "automatic_build_executor_session.v2",
        action: { kind: "WAIT", retry_after_ms: 1_000 },
      }),
    });

    expect(session.handle_message({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
      },
    });
    const listed = session.handle_message({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((listed as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual([
      "executor.open",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/candidate_path|capability|session_private_root|"now"/u);
  });

  it("keeps capability out of model parameters and candidate bodies out of tool results", () => {
    const executed: unknown[] = [];
    const handoffRef = `abhandoff1_${"1".repeat(64)}`;
    const sessionRef = `absession1_${"2".repeat(64)}`;
    const taskSessionRef = `absession1_${"a".repeat(64)}`;
    const inputRef = `abinput1_${"3".repeat(64)}`;
    const chunkReceipt = `abchunk1_${"4".repeat(64)}`;
    const grantRef = `abgrant1_${"5".repeat(64)}`;
    const sinkRef = `absink1_${"6".repeat(64)}`;
    const session = createBuildExecutorMcpSession({
      bootstrap_digest: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
      execute_request: (request) => {
        executed.push(request);
        const version = (request as { version: string }).version;
        if (version === "automatic_build_executor_open_request.v2") {
          return {
            version: "automatic_build_executor_session.v2",
            action: {
              kind: "DELIVER_INPUT",
              input_manifest: {
                version: "automatic_build_executor_input_manifest.v2",
                opaque_session_ref: sessionRef,
                generation_input_ref: inputRef,
                transport_profile_digest: "7".repeat(64),
                segments: [],
                total_chunk_count: 1,
              },
              next_request: {
                version: "automatic_build_executor_input_next_request.v2",
                opaque_session_ref: sessionRef,
                generation_input_ref: inputRef,
              },
            },
          };
        }
        if (version === "automatic_build_executor_input_next_request.v2"
          && !(request as { previous_chunk_receipt?: string }).previous_chunk_receipt) {
          return {
            version: "automatic_build_executor_session.v2",
            action: {
              kind: "INPUT_CHUNK",
              chunk: {
                version: "automatic_build_executor_input_chunk.v2",
                opaque_session_ref: sessionRef,
                generation_input_ref: inputRef,
                segment: "semantic_input",
                ordinal: 0,
                byte_range: { start: 0, end: 2 },
                payload_utf8: "{}",
                payload_sha256: "8".repeat(64),
                final_for_segment: true,
                final_for_generation: true,
                chunk_receipt: chunkReceipt,
              },
            },
          };
        }
        if (version === "automatic_build_executor_input_next_request.v2") {
          return {
            version: "automatic_build_executor_session.v2",
            action: {
              kind: "GENERATION_GRANT",
              grant: {
                version: "automatic_build_executor_generation_grant.v1",
                opaque_session_ref: sessionRef,
                generation_input_ref: inputRef,
                generation_grant_ref: grantRef,
                output_contract_digest: "9".repeat(64),
              },
            },
          };
        }
        if (version === "automatic_build_executor_generation_start_request.v1") {
          return {
            version: "automatic_build_executor_session.v2",
            action: {
              kind: "GENERATE",
              opaque_session_ref: taskSessionRef,
              candidate_sink_ref: sinkRef,
              semantic_attempt: 1,
              output_contract: {
                version: "automatic_build_semantic_candidate_contract.v2",
                format: "strict_json",
                encoding: "utf-8",
                max_bytes: 1_024,
                stage: "book_structure",
                work_unit_id: "unit:1",
                work_unit_kind: "book_structure_unit",
                input_hash: "a".repeat(64),
              },
            },
          };
        }
        return {
          version: "automatic_build_executor_session.v2",
          action: { kind: "DONE", status: "committed" },
        };
      },
    });
    const sentinel = "T6_PRIVATE_CANDIDATE_SENTINEL";
    const call = (id: number, name: string, args: Record<string, unknown>) => session.handle_message({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    });
    const firstChunkRequest = {
      version: "automatic_build_executor_input_next_request.v2",
      opaque_session_ref: sessionRef,
      generation_input_ref: inputRef,
    };
    const responses = [
      call(3, "executor.open", {
        version: "automatic_build_executor_open_request.v2",
        opaque_handoff_ref: handoffRef,
      }),
      ...Array.from({ length: 5 }, (_, index) => (
        call(4 + index, "executor.input.next", firstChunkRequest)
      )),
      call(9, "executor.input.next", {
        version: "automatic_build_executor_input_next_request.v2",
        opaque_session_ref: sessionRef,
        generation_input_ref: inputRef,
        previous_chunk_receipt: chunkReceipt,
      }),
      call(10, "executor.generation.start", {
        version: "automatic_build_executor_generation_start_request.v1",
        opaque_session_ref: sessionRef,
        generation_grant_ref: grantRef,
      }),
      call(11, "executor.submit_candidate", {
        version: "automatic_build_executor_candidate_submit.v2",
        opaque_session_ref: taskSessionRef,
        candidate_sink_ref: sinkRef,
        candidate: { private_value: sentinel },
      }),
    ];
    expect(executed).toHaveLength(9);
    const replayKinds = responses.slice(1, 6).map((response) => {
      const text = (response as { result: { content: Array<{ text: string }> } })
        .result.content[0]?.text ?? "";
      return (JSON.parse(text) as { action: { kind: string } }).action.kind;
    });
    expect(replayKinds).toEqual(Array.from({ length: 5 }, () => "INPUT_CHUNK"));
    expect(JSON.stringify(responses.at(-1))).not.toContain(sentinel);
    expect(JSON.stringify(responses)).not.toMatch(/capability|session_private_root/u);
  });

  it("fails closed with a bounded bootstrap diagnostic", () => {
    expect(() => createBuildExecutorMcpSession({
      bootstrap_digest: "0".repeat(64),
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
    })).toThrow(/bootstrap|digest|protocol/i);
  });
});
