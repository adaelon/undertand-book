import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AutomaticBuildExecutorStaleGenerationSessionError } from "../src/automatic-build-executor-session";
import { AutomaticBuildLeaseExpiredError } from "../src/automatic-build-lease";
import { AutomaticBuildCandidateSinkUnavailableError } from "../src/automatic-build-mailbox";
import { BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3 } from "../src/build-executor-connection-capability";
import {
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  createCandidateTransportContract,
} from "../src/executor-transport";
import { createBuildExecutorMcpSession } from "../../../skills/build/build-executor-mcp";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEDICATED_EXECUTOR_ONLY =
  "Only the dedicated `understand_book_executor` Executor may call this tool.";
const TEST_CANDIDATE_TRANSPORT = createCandidateTransportContract(
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  1_024,
);

describe("Build Executor root-shared MCP boundary", () => {
  it("RG5 maps operation failures to one allowlisted V2 error without private detail", () => {
    const privateSentinel = "RG5_PRIVATE_MESSAGE_CANDIDATE_C:\\private\\candidate.json";
    const refSentinel = `absession1_${"f".repeat(64)}`;
    const taskRef = `absession1_${"e".repeat(64)}`;
    const inputRef = `abinput1_${"2".repeat(64)}`;
    const sinkRef = `absink1_${"4".repeat(64)}`;
    const cases = [
      {
        operation: "executor.open",
        request: {
          version: "automatic_build_executor_open_request.v3",
          opaque_handoff_ref: `abhandoff1_${"1".repeat(64)}`,
        },
        error: new Error(privateSentinel),
        expected: {
          status: "interrupted",
          category: "internal",
          diagnostic_code: "executor_internal",
          phase: "open",
        },
      },
      {
        operation: "executor.input.next",
        request: {
          version: "automatic_build_executor_input_next_request.v4",
          opaque_session_ref: refSentinel,
          generation_input_ref: inputRef,
        },
        error: new Error(privateSentinel),
        expected: {
          status: "interrupted",
          category: "internal",
          diagnostic_code: "executor_internal",
          phase: "input_delivery",
        },
      },
      {
        operation: "executor.generation.start",
        request: {
          version: "automatic_build_executor_generation_start_request.v3",
          opaque_session_ref: refSentinel,
          generation_input_ref: inputRef,
          confirmed_through_ordinal: 0,
        },
        error: new AutomaticBuildExecutorStaleGenerationSessionError(),
        expected: {
          status: "interrupted",
          category: "session",
          diagnostic_code: "stale_generation_session",
          phase: "generation_start",
        },
      },
      {
        operation: "executor.submit_candidate",
        request: {
          version: "automatic_build_executor_candidate_submit.v3",
          opaque_session_ref: taskRef,
          candidate_sink_ref: sinkRef,
          candidate: { private_value: privateSentinel },
        },
        error: new AutomaticBuildCandidateSinkUnavailableError(new Error(privateSentinel)),
        expected: {
          status: "interrupted",
          category: "candidate_sink",
          diagnostic_code: "candidate_sink_unavailable",
          phase: "candidate_submit",
        },
      },
      {
        operation: "executor.submit_candidate",
        request: {
          version: "automatic_build_executor_candidate_submit.v3",
          opaque_session_ref: taskRef,
          candidate_sink_ref: sinkRef,
          candidate: { private_value: privateSentinel },
        },
        error: new AutomaticBuildLeaseExpiredError(),
        expected: {
          status: "interrupted",
          category: "session",
          diagnostic_code: "lease_expired",
          phase: "candidate_submit",
        },
      },
      {
        operation: "executor.submit_candidate",
        request: {
          version: "automatic_build_executor_candidate_submit.v3",
          opaque_session_ref: taskRef,
          candidate_sink_ref: sinkRef,
          candidate: { private_value: privateSentinel },
        },
        error: Object.assign(new Error(privateSentinel), {
          failure_diagnostic: { code: "writer_failed" },
        }),
        expected: {
          status: "retryable_failure",
          category: "writer",
          diagnostic_code: "writer_failed",
          phase: "candidate_submit",
        },
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const samples: unknown[] = [];
      const session = createBuildExecutorMcpSession({
        bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
        protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
        session_private_root: path.join(REPO_ROOT, `.rg5-error-${index}`),
        execute_request: (request, timing) => {
          const version = (request as { version: string }).version;
          if (version === testCase.request.version) throw testCase.error;
          if (version === "automatic_build_executor_open_request.v3") {
            return {
              version: "automatic_build_executor_session.v3",
              action: {
                kind: "DELIVER_INPUT",
                input_manifest: {
                  version: "automatic_build_executor_input_manifest.v3",
                  opaque_session_ref: refSentinel,
                  generation_input_ref: inputRef,
                  transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
                  segments: [],
                  total_chunk_count: 1,
                },
                next_request: {
                  version: "automatic_build_executor_input_next_request.v4",
                  opaque_session_ref: refSentinel,
                  generation_input_ref: inputRef,
                },
              },
            };
          }
          if (version === "automatic_build_executor_input_next_request.v4") {
            return {
              version: "automatic_build_executor_session.v3",
              action: {
                kind: "INPUT_BATCH",
                batch: {
                  version: "automatic_build_executor_input_batch.v1",
                  opaque_session_ref: refSentinel,
                  generation_input_ref: inputRef,
                  first_ordinal: 0,
                  last_ordinal: 0,
                  final_for_generation: true,
                  chunks: [{
                    version: "automatic_build_executor_input_chunk.v3",
                    opaque_session_ref: refSentinel,
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
            };
          }
          timing.complete_phase("current-state/claim");
          timing.complete_phase("input-render-or-reuse");
          return {
            version: "automatic_build_executor_session.v3",
            action: {
              kind: "GENERATE",
              opaque_session_ref: taskRef,
              candidate_sink_ref: sinkRef,
              semantic_attempt: 1,
              output_contract: {
                version: "automatic_build_semantic_candidate_contract.v3",
                format: "strict_json",
                encoding: "utf-8",
                max_bytes: 1_024,
                transport: TEST_CANDIDATE_TRANSPORT,
                stage: "book_structure",
                work_unit_id: "unit:rg5",
                work_unit_kind: "book_structure_unit",
                input_hash: "a".repeat(64),
              },
            },
          };
        },
        timing_sample_sink: (sample) => samples.push(sample),
      });
      const call = (id: number, name: string, args: Record<string, unknown>) => session.handle_message({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      let callId = index * 10 + 1;
      if (testCase.operation !== "executor.open") {
        call(callId++, "executor.open", {
          version: "automatic_build_executor_open_request.v3",
          opaque_handoff_ref: `abhandoff1_${"1".repeat(64)}`,
        });
      }
      if (testCase.operation === "executor.generation.start"
        || testCase.operation === "executor.submit_candidate") {
        call(callId++, "executor.input.next", {
          version: "automatic_build_executor_input_next_request.v4",
          opaque_session_ref: refSentinel,
          generation_input_ref: inputRef,
        });
      }
      if (testCase.operation === "executor.submit_candidate") {
        call(callId++, "executor.generation.start", {
          version: "automatic_build_executor_generation_start_request.v3",
          opaque_session_ref: refSentinel,
          generation_input_ref: inputRef,
          confirmed_through_ordinal: 0,
        });
      }
      const rpc = call(
        callId,
        testCase.operation,
        testCase.request,
      ) as { result: { content: Array<{ text: string }>; isError: boolean } };
      expect(rpc.result.isError).toBe(true);
      expect(JSON.parse(rpc.result.content[0]?.text ?? "null")).toEqual({
        version: "automatic_build_executor_mcp_error.v2",
        ...testCase.expected,
      });
      expect(samples.at(-1)).toMatchObject({
        operation: testCase.operation,
        outcome: "bounded_error",
        response_action_kind: null,
      });
      expect(JSON.stringify({ rpc, samples })).not.toMatch(
        /RG5_PRIVATE_MESSAGE_CANDIDATE|candidate\.json|absession1_|abinput1_|absink1_|[A-Z]:\\/u,
      );
    }
  });

  it.each(["connection_terminal", "handoff_ref_mismatch"] as const)(
    "L2 reports %s precisely without opening the second ref", (diagnostic) => {
      let backendCalls = 0;
      const session = createBuildExecutorMcpSession({
        bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
        protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
        session_private_root: path.join(REPO_ROOT, ".l2-connection-error"),
        execute_request: () => {
          backendCalls++;
          return { version: "automatic_build_executor_session.v3", action: diagnostic === "connection_terminal"
            ? { kind: "DONE", status: "committed" } : { kind: "WAIT", retry_after_ms: 1 } };
        },
      });
      const call = (id: number, ref: string) => session.handle_message({ jsonrpc: "2.0", id,
        method: "tools/call", params: { name: "executor.open", arguments: {
          version: "automatic_build_executor_open_request.v3", opaque_handoff_ref: ref,
        } } }) as { result: { isError: boolean; content: { text: string }[] } };
      expect(call(1, `abhandoff1_${"1".repeat(64)}`).result.isError).toBe(false);
      const rejected = call(2, `abhandoff1_${"2".repeat(64)}`);
      expect(rejected.result.isError).toBe(true);
      expect(JSON.parse(rejected.result.content[0]!.text)).toEqual({
        version: "automatic_build_executor_mcp_error.v2", status: "interrupted", category: "session",
        diagnostic_code: diagnostic, phase: "open",
      });
      expect(backendCalls).toBe(1);
    });

  it("RG5 keeps a pre-session contract failure as protocol_incompatible with its operation phase", () => {
    let backendCalls = 0;
    const session = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".rg5-contract-error"),
      execute_request: () => {
        backendCalls += 1;
        throw new Error("RG5_BACKEND_MUST_NOT_RUN");
      },
    });
    const rpc = session.handle_message({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "executor.open",
        arguments: {
          version: "automatic_build_executor_open_request.v2",
          opaque_handoff_ref: `abhandoff1_${"1".repeat(64)}`,
        },
      },
    }) as { result: { content: Array<{ text: string }>; isError: boolean } };

    expect(backendCalls).toBe(0);
    expect(rpc.result.isError).toBe(true);
    expect(JSON.parse(rpc.result.content[0]?.text ?? "null")).toEqual({
      version: "automatic_build_executor_mcp_error.v2",
      status: "interrupted",
      category: "bootstrap",
      diagnostic_code: "protocol_incompatible",
      phase: "open",
    });
  });

  it("RG5 never relabels a post-session response failure as bootstrap", () => {
    const session = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".rg5-post-session-error"),
      execute_request: () => ({
        version: "automatic_build_executor_session.v3",
        action: { kind: "RG5_PRIVATE_INVALID_ACTION_SENTINEL" },
      }) as never,
    });
    const rpc = session.handle_message({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "executor.open",
        arguments: {
          version: "automatic_build_executor_open_request.v3",
          opaque_handoff_ref: `abhandoff1_${"1".repeat(64)}`,
        },
      },
    }) as { result: { content: Array<{ text: string }>; isError: boolean } };

    expect(rpc.result.isError).toBe(true);
    expect(JSON.parse(rpc.result.content[0]?.text ?? "null")).toEqual({
      version: "automatic_build_executor_mcp_error.v2",
      status: "interrupted",
      category: "internal",
      diagnostic_code: "executor_internal",
      phase: "open",
    });
    expect(JSON.stringify(rpc)).not.toContain("RG5_PRIVATE_INVALID_ACTION_SENTINEL");
  });

  it("M1 records one bounded server timing sample per valid tool call", () => {
    const samples: unknown[] = [];
    const ticks = [100, 125, 200, 231];
    let callCount = 0;
    const session = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".m1-timing-private-root"),
      now_ms: () => ticks.shift() ?? 0,
      timing_sample_sink: (sample) => samples.push(sample),
      execute_request: () => {
        callCount += 1;
        if (callCount === 2) throw new Error("M1_PRIVATE_ERROR_SENTINEL");
        return {
          version: "automatic_build_executor_session.v3",
          action: { kind: "WAIT", retry_after_ms: 1_000 },
        };
      },
    });
    const invoke = (id: number) => session.handle_message({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "executor.open",
        arguments: {
          version: "automatic_build_executor_open_request.v3",
          opaque_handoff_ref: `abhandoff1_${String(id).repeat(64)}`,
        },
      },
    });

    const ok = invoke(1);
    const boundedError = invoke(2);

    expect(samples).toEqual([
      {
        version: "executor_mcp_server_timing.v2",
        connection_call_ordinal: 1,
        operation: "executor.open",
        server_elapsed_ms: 25,
        response_bytes: Buffer.byteLength(`${JSON.stringify(ok)}\n`, "utf8"),
        response_action_kind: "WAIT",
        outcome: "ok",
        server_phase_elapsed_ms: null,
      },
      {
        version: "executor_mcp_server_timing.v2",
        connection_call_ordinal: 2,
        operation: "executor.open",
        server_elapsed_ms: 31,
        response_bytes: Buffer.byteLength(`${JSON.stringify(boundedError)}\n`, "utf8"),
        response_action_kind: null,
        outcome: "bounded_error",
        server_phase_elapsed_ms: null,
      },
    ]);
    expect(JSON.stringify(samples)).not.toMatch(
      /M1_PRIVATE_ERROR_SENTINEL|abhandoff1_|session_private_root|candidate|payload|[A-Z]:\\/u,
    );
  });

  it("records a returned retryable failure as a bounded timing outcome", () => {
    const samples: unknown[] = [];
    const ticks = [100, 125];
    const session = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".rg8-retryable-timing-private-root"),
      now_ms: () => ticks.shift() ?? 0,
      timing_sample_sink: (sample) => samples.push(sample),
      execute_request: () => ({
        version: "automatic_build_executor_session.v3",
        action: { kind: "DONE", status: "retryable_failure" },
      }),
    });

    const rpc = session.handle_message({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "executor.open",
        arguments: {
          version: "automatic_build_executor_open_request.v3",
          opaque_handoff_ref: `abhandoff1_${"1".repeat(64)}`,
        },
      },
    }) as { result: { isError: boolean } };

    expect(rpc.result.isError).toBe(false);
    expect(samples).toEqual([{
      version: "executor_mcp_server_timing.v2",
      connection_call_ordinal: 1,
      operation: "executor.open",
      server_elapsed_ms: 25,
      response_bytes: expect.any(Number),
      response_action_kind: "DONE",
      outcome: "bounded_error",
      server_phase_elapsed_ms: null,
    }]);
  });

  it("M1 keeps call ordinals local to each stdio connection", () => {
    const firstOrdinals = Array.from({ length: 3 }, (_, index) => {
      const samples: Array<{ connection_call_ordinal: number }> = [];
      const session = createBuildExecutorMcpSession({
        bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
        protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
        session_private_root: path.join(REPO_ROOT, `.m1-connection-${index + 1}`),
        now_ms: () => 0,
        timing_sample_sink: (sample) => samples.push(sample),
        execute_request: () => ({
          version: "automatic_build_executor_session.v3",
          action: { kind: "WAIT", retry_after_ms: 1_000 },
        }),
      });
      session.handle_message({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: {
          name: "executor.open",
          arguments: {
            version: "automatic_build_executor_open_request.v3",
            opaque_handoff_ref: `abhandoff1_${String(index + 1).repeat(64)}`,
          },
        },
      });
      return samples[0]?.connection_call_ordinal;
    });

    expect(firstOrdinals).toEqual([1, 1, 1]);
  });

  it("negotiates MCP and exposes exactly the four closed executor tools", () => {
    const session = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
      execute_request: () => ({
        version: "automatic_build_executor_session.v3",
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

  it("R1/R2 exposes the dedicated-Executor-only warning on every tools/list description", () => {
    const session = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".r1-description-private-root"),
      execute_request: () => ({
        version: "automatic_build_executor_session.v3",
        action: { kind: "WAIT", retry_after_ms: 1_000 },
      }),
    });
    const listed = session.handle_message({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const missing = listed.result.tools
      .filter((tool) => !tool.description.startsWith(DEDICATED_EXECUTOR_ONLY))
      .map((tool) => tool.name);
    // R1_RED action: R2 publishes the same dedicated-role warning through the live MCP surface.
    expect(missing).toEqual([]);
  });

  it("keeps capability out of model parameters and candidate bodies out of tool results", () => {
    const executed: unknown[] = [];
    const timingSamples: Array<{
      operation: string;
      server_elapsed_ms: number;
      server_phase_elapsed_ms: Record<string, number> | null;
    }> = [];
    let tick = 0;
    const handoffRef = `abhandoff1_${"1".repeat(64)}`;
    const sessionRef = `absession1_${"2".repeat(64)}`;
    const taskSessionRef = `absession1_${"a".repeat(64)}`;
    const inputRef = `abinput1_${"3".repeat(64)}`;
    const sinkRef = `absink1_${"6".repeat(64)}`;
    const session = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
      now_ms: () => tick++,
      timing_sample_sink: (sample) => timingSamples.push(sample),
      execute_request: (request, timing) => {
        executed.push(request);
        const version = (request as { version: string }).version;
        if (version === "automatic_build_executor_open_request.v3") {
          return {
            version: "automatic_build_executor_session.v3",
            action: {
              kind: "DELIVER_INPUT",
              input_manifest: {
                version: "automatic_build_executor_input_manifest.v3",
                opaque_session_ref: sessionRef,
                generation_input_ref: inputRef,
                transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
                segments: [],
                total_chunk_count: 1,
              },
              next_request: {
                version: "automatic_build_executor_input_next_request.v4",
                opaque_session_ref: sessionRef,
                generation_input_ref: inputRef,
              },
            },
          };
        }
        if (version === "automatic_build_executor_input_next_request.v4") {
          return {
            version: "automatic_build_executor_session.v3",
            action: {
              kind: "INPUT_BATCH",
              batch: {
                version: "automatic_build_executor_input_batch.v1",
                opaque_session_ref: sessionRef,
                generation_input_ref: inputRef,
                first_ordinal: 0,
                last_ordinal: 0,
                final_for_generation: true,
                chunks: [{
                version: "automatic_build_executor_input_chunk.v3",
                opaque_session_ref: sessionRef,
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
          };
        }
        if (version === "automatic_build_executor_generation_start_request.v3") {
          timing.complete_phase("current-state/claim");
          timing.complete_phase("input-render-or-reuse");
          return {
            version: "automatic_build_executor_session.v3",
            action: {
              kind: "GENERATE",
              opaque_session_ref: taskSessionRef,
              candidate_sink_ref: sinkRef,
              semantic_attempt: 1,
              output_contract: {
                version: "automatic_build_semantic_candidate_contract.v3",
                format: "strict_json",
                encoding: "utf-8",
                max_bytes: 1_024,
                transport: TEST_CANDIDATE_TRANSPORT,
                stage: "book_structure",
                work_unit_id: "unit:1",
                work_unit_kind: "book_structure_unit",
                input_hash: "a".repeat(64),
              },
            },
          };
        }
        timing.complete_phase("candidate-gate");
        timing.complete_phase("writer/commit");
        return {
          version: "automatic_build_executor_session.v3",
          action: { kind: "DONE", status: "committed" },
        };
      },
    });
    const sentinel = "T6_PRIVATE_CANDIDATE_SENTINEL";
    const call = (id: number, name: string, args: Record<string, unknown>) => session.handle_message({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    });
    const firstChunkRequest = {
      version: "automatic_build_executor_input_next_request.v4",
      opaque_session_ref: sessionRef,
      generation_input_ref: inputRef,
    };
    const responses = [
      call(3, "executor.open", {
        version: "automatic_build_executor_open_request.v3",
        opaque_handoff_ref: handoffRef,
      }),
      ...Array.from({ length: 5 }, (_, index) => (
        call(4 + index, "executor.input.next", firstChunkRequest)
      )),
      call(10, "executor.generation.start", {
        version: "automatic_build_executor_generation_start_request.v3",
        opaque_session_ref: sessionRef,
        generation_input_ref: inputRef,
        confirmed_through_ordinal: 0,
      }),
      call(11, "executor.submit_candidate", {
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: taskSessionRef,
        candidate_sink_ref: sinkRef,
        candidate: { private_value: sentinel },
      }),
    ];
    expect(executed).toHaveLength(8);
    const replayKinds = responses.slice(1, 6).map((response) => {
      const text = (response as { result: { content: Array<{ text: string }> } })
        .result.content[0]?.text ?? "";
      return (JSON.parse(text) as { action: { kind: string } }).action.kind;
    });
    expect(replayKinds).toEqual(Array.from({ length: 5 }, () => "INPUT_BATCH"));
    const longSamples = timingSamples.filter((sample) => sample.server_phase_elapsed_ms !== null);
    expect(longSamples.map((sample) => sample.operation)).toEqual([
      "executor.generation.start",
      "executor.submit_candidate",
    ]);
    for (const sample of longSamples) {
      expect(Object.values(sample.server_phase_elapsed_ms ?? {}).reduce((sum, value) => sum + value, 0))
        .toBe(sample.server_elapsed_ms);
    }
    expect(longSamples.map((sample) => sample.server_phase_elapsed_ms)).toEqual([
      {
        "current-state/claim": 1,
        "input-render-or-reuse": 1,
        "persist/response": 1,
      },
      {
        "candidate-gate": 1,
        "writer/commit": 1,
        "next-work-prepare": 1,
      },
    ]);
    expect(JSON.stringify(responses.at(-1))).not.toContain(sentinel);
    expect(JSON.stringify(responses)).not.toMatch(/capability|session_private_root/u);
    expect(JSON.stringify(timingSamples)).not.toMatch(
      /T6_PRIVATE_CANDIDATE_SENTINEL|abhandoff1_|absession1_|abinput1_|abgrant1_|absink1_|[A-Z]:\\/u,
    );
  });

  it("fails closed with a bounded bootstrap diagnostic", () => {
    expect(() => createBuildExecutorMcpSession({
      bootstrap_version: "automatic_build_executor_bootstrap.v2",
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.join(REPO_ROOT, ".t6-private-root"),
    })).toThrow(/bootstrap|version|protocol/i);
  });
});
