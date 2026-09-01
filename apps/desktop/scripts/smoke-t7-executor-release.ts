import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
} from "../../../packages/core/src/build-executor-connection-capability";
import { BUILD_EXECUTOR_MCP_CONTRACT_V3 } from "../../../packages/core/src/build-executor-tool-adapter";
import {
  CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1,
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  measureExecutorTransportResponse,
  serializeExecutorMcpToolResult,
} from "../../../packages/core/src/executor-transport";
import {
  readAutomaticBuildAttemptSnapshot,
} from "../../../packages/core/src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../../../packages/core/src/build-orchestrator";
import type {
  AutomaticBuildExecutorSessionResponseV3,
} from "../../../packages/core/src/automatic-build-executor-session";
import {
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "../../../packages/core/test/helpers/confirmed-build-plan";
import {
  readExecutorMcpServerTimingJsonl,
  type ExecutorMcpServerTimingV2,
} from "./r7-rollout-trace";

type JsonObject = Record<string, unknown>;

interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TraceEvent {
  scope: "dedicated_child";
  direction: "tool_request" | "tool_result";
  tool_name: string;
  action_kind?: string;
  payload: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const defaultSidecar = path.join(
  desktopRoot,
  "src-tauri",
  "binaries",
  "understand-book-build-x86_64-pc-windows-msvc.exe",
);
const expectedTools = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
] as const;
const semanticSentinel = "T7_SEMANTIC_INPUT_SENTINEL_317247";
const candidateMarker = '"source_lid":null';

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  assert(index + 1 < process.argv.length, `${name} requires a value`);
  assert.equal(process.argv.indexOf(name, index + 1), -1, `${name} may appear only once`);
  return process.argv[index + 1];
}

function occurrenceCount(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function assertRejectedBootstrap(sidecar: string, registryRoot: string, cwd: string): void {
  const rejected = spawnSync(sidecar, [
    "executor.mcp",
    "--bootstrap-version",
    "automatic_build_executor_bootstrap.v2",
    "--protocol-generation",
    BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
  ], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: registryRoot,
    },
  });
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 2, "compiled executor MCP must reject Bootstrap V2");
  assert.equal(rejected.stdout, "", "rejected compiled bootstrap must not emit MCP output");
  assert.equal(
    rejected.stderr,
    "Build Executor MCP bootstrap is incompatible\n",
    "rejected compiled bootstrap must emit the bounded incompatibility diagnostic",
  );
}

class JsonLineMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exitPromise: Promise<number | null>;
  private nextId = 1;
  private stderrText = "";

  constructor(sidecar: string, registryRoot: string, cwd: string) {
    this.child = spawn(sidecar, [
      "executor.mcp",
      "--bootstrap-version",
      BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      "--protocol-generation",
      BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
    ], {
      cwd,
      env: {
        ...process.env,
        UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: registryRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch (error) {
        this.rejectAll(new Error(`compiled executor MCP emitted non-JSON output: ${String(error)}`));
        return;
      }
      if (typeof response.id !== "number") return;
      const request = this.pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(response.id);
      request.resolve(response);
    });
    this.child.once("error", (error) => this.rejectAll(error));
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code) => {
        if (this.pending.size > 0) {
          this.rejectAll(new Error(`compiled executor MCP exited before responding (${String(code)})`));
        }
        resolve(code);
      });
    });
  }

  request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`compiled executor MCP timed out for ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<ExecutorMcpServerTimingV2[]> {
    this.child.stdin.end();
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        this.child.kill();
        reject(new Error("compiled executor MCP did not exit after stdin closed"));
      }, 10_000);
    });
    const code = await Promise.race([this.exitPromise, timeout]);
    this.lines.close();
    assert.equal(code, 0, `compiled executor MCP exited ${String(code)}: ${this.stderrText}`);
    const samples = readExecutorMcpServerTimingJsonl(this.stderrText, "compiled executor MCP stderr");
    assert(samples.every((sample, index) => sample.connection_call_ordinal === index + 1));
    assert(samples.length > 0, "compiled executor MCP emitted no server timing samples");
    return samples;
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function createFixture(container: string, registryRoot: string, label: string, sourceBody: string) {
  const root = path.join(container, label);
  mkdirSync(root, { recursive: true });
  const source = path.join(root, `${label}.md`);
  writeFileSync(source, `# T7 synthetic fixture\n\n${sourceBody}\n`, "utf8");
  const buildPlan = confirmedStandardBuildPlan(source, root);
  const plan = automaticBuildPlan(source, root, {
    requested_workers: 1,
    available_agent_slots: 1,
    build_plan: buildPlan,
  });
  assert(plan.preflight, "T7 fixture must produce a preflight");
  const next = automaticBuildNext(source, root, 1, {
    accepted_plan_digest: plan.preflight.descriptor_plan_digest,
    available_agent_slots: 1,
    executor_dispatches: true,
    build_plan: buildPlan,
  });
  assert("dispatches" in next.action && next.action.dispatches, "T7 fixture must produce a dispatch");
  const envelope = next.action.dispatches[0];
  assert(envelope, "T7 fixture must produce one executor envelope");
  return {
    root,
    source,
    target: resolveAutomaticBuildTarget(source, root),
    envelope,
    registryRoot,
  };
}

function attemptCount(value: ReturnType<typeof createFixture>): number {
  return Object.values(readAutomaticBuildAttemptSnapshot(value.target).stages)
    .flatMap((stage) => Object.values(stage))
    .reduce((sum, snapshot) => sum + snapshot.semantic_attempt, 0);
}

async function callTool(
  client: JsonLineMcpClient,
  trace: TraceEvent[],
  toolName: typeof expectedTools[number],
  args: JsonObject,
): Promise<{
  response: AutomaticBuildExecutorSessionResponseV3 | JsonObject;
  text: string;
  isError: boolean;
}> {
  const requestPayload = JSON.stringify({ name: toolName, arguments: args });
  trace.push({
    scope: "dedicated_child",
    direction: "tool_request",
    tool_name: toolName,
    payload: requestPayload,
  });
  const rpc = await client.request("tools/call", { name: toolName, arguments: args });
  assert.equal(rpc.error, undefined, `MCP transport rejected ${toolName}`);
  const result = rpc.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  assert.equal(result.content?.length, 1, `${toolName} must return one content block`);
  const text = result.content?.[0]?.text;
  assert.equal(typeof text, "string", `${toolName} must return canonical JSON text`);
  const response = JSON.parse(text as string) as AutomaticBuildExecutorSessionResponseV3 | JsonObject;
  const actionKind = "action" in response
    && response.action
    && typeof response.action === "object"
    && "kind" in response.action
    && typeof response.action.kind === "string"
    ? response.action.kind
    : undefined;
  trace.push({
    scope: "dedicated_child",
    direction: "tool_result",
    tool_name: toolName,
    ...(actionKind === undefined ? {} : { action_kind: actionKind }),
    payload: JSON.stringify(rpc),
  });
  if ("version" in response && response.version === "automatic_build_executor_session.v3") {
    const sessionResponse = response as AutomaticBuildExecutorSessionResponseV3;
    if (sessionResponse.action.kind === "INPUT_BATCH") {
      assert(
        Buffer.byteLength(serializeExecutorMcpToolResult(sessionResponse), "utf8")
          <= CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1.max_serialized_batch_bytes,
        `${toolName} exceeded the tested batch carrier tier`,
      );
    } else {
      assert.equal(
        measureExecutorTransportResponse(
          sessionResponse,
          "",
          CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
        ).status,
        "within_limit",
        `${toolName} produced an out-of-profile session response`,
      );
    }
  }
  return { response, text: text as string, isError: result.isError === true };
}

function assertMcpError(value: Awaited<ReturnType<typeof callTool>>): void {
  assert.equal(value.isError, true);
  assert.deepEqual(value.response, {
    version: "automatic_build_executor_mcp_error.v1",
    status: "interrupted",
    category: "bootstrap",
    diagnostic_code: "protocol_incompatible",
  });
}

function assertTraceAllowlist(trace: TraceEvent[]): {
  semantic_chunk_hits: number;
  candidate_request_hits: number;
} {
  let semanticChunkHits = 0;
  let candidateRequestHits = 0;
  for (const event of trace) {
    const semanticHits = occurrenceCount(event.payload, semanticSentinel);
    if (semanticHits > 0) {
      assert.equal(event.scope, "dedicated_child");
      assert.equal(event.direction, "tool_result");
      assert.equal(event.tool_name, "executor.input.next");
      assert.equal(event.action_kind, "INPUT_BATCH");
      semanticChunkHits += semanticHits;
    }
    const candidateHits = occurrenceCount(event.payload, candidateMarker);
    if (candidateHits > 0) {
      assert.equal(event.scope, "dedicated_child");
      assert.equal(event.direction, "tool_request");
      assert.equal(event.tool_name, "executor.submit_candidate");
      candidateRequestHits += candidateHits;
    }
  }
  assert(semanticChunkHits > 0, "synthetic semantic sentinel never reached a dedicated child chunk result");
  assert(candidateRequestHits > 0, "synthetic candidate never reached the dedicated child submit request");
  return {
    semantic_chunk_hits: semanticChunkHits,
    candidate_request_hits: candidateRequestHits,
  };
}

async function main(): Promise<void> {
  const sidecar = path.resolve(argumentValue("--sidecar") ?? defaultSidecar);
  const evidenceOutValue = argumentValue("--evidence-out");
  const evidenceOut = evidenceOutValue ? path.resolve(evidenceOutValue) : undefined;
  assert(existsSync(sidecar), `compiled Build Engine Sidecar is missing: ${sidecar}`);

  const container = mkdtempSync(path.join(tmpdir(), "understand-book-t7-executor-release-"));
  const registryRoot = path.join(container, "driver-registry");
  const blackBoxCwd = path.join(container, "black-box-cwd");
  mkdirSync(blackBoxCwd, { recursive: true });
  const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
  process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registryRoot;
  let client: JsonLineMcpClient | undefined;
  try {
    const primary = createFixture(
      container,
      registryRoot,
      "primary",
      `${semanticSentinel}\n${"x".repeat(20_000)}`,
    );
    const secondary = createFixture(container, registryRoot, "secondary", "secondary capability fixture");
    assert.equal(attemptCount(primary), 0);
    assert.equal(attemptCount(secondary), 0);

    assertRejectedBootstrap(sidecar, registryRoot, blackBoxCwd);
    client = new JsonLineMcpClient(sidecar, registryRoot, blackBoxCwd);
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "understand-book-t7-smoke", version: "1" },
    });
    assert.deepEqual((initialized.result as JsonObject).capabilities, { tools: { listChanged: false } });
    const listed = await client.request("tools/list");
    const tools = ((listed.result as { tools: Array<{ name: string; inputSchema: JsonObject }> }).tools);
    assert.deepEqual(tools.map((tool) => tool.name), expectedTools);
    assert(!JSON.stringify(tools).match(/candidate_path|session_private_root|child_connection_capability|"now"/u));

    const trace: TraceEvent[] = [];
    assertMcpError(await callTool(client, trace, "executor.open", {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: primary.envelope.opaque_handoff_ref,
      path: primary.envelope.executor_handoff.path,
    }));
    assert.equal(attemptCount(primary), 0);

    let current = await callTool(client, trace, "executor.open", {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: primary.envelope.opaque_handoff_ref,
    });
    assert.equal(current.isError, false, current.text);
    assert.equal((current.response as AutomaticBuildExecutorSessionResponseV3).action.kind, "DELIVER_INPUT");

    assertMcpError(await callTool(client, trace, "executor.open", {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: secondary.envelope.opaque_handoff_ref,
    }));
    assert.equal(attemptCount(secondary), 0);

    let chunkCount = 0;
    let batchCount = 0;
    let deliveredBytes = 0;
    let maxToolResultBytes = 0;
    let generationCount = 0;
    let batchZeroReplayCount = 0;
    let testedOrdinalFailure = false;
    let testedPrematureStart = false;
    for (let workUnit = 0; workUnit < 16; workUnit += 1) {
      const sessionResponse = current.response as AutomaticBuildExecutorSessionResponseV3;
      if (sessionResponse.action.kind === "DONE") {
        assert.equal(sessionResponse.action.status, "committed");
        break;
      }
      assert.equal(sessionResponse.action.kind, "DELIVER_INPUT");
      const delivery = sessionResponse.action;
      assert(delivery.input_manifest.total_chunk_count > 2, "compiled smoke must exercise a multi-chunk input");
      assert.equal(attemptCount(primary), generationCount);
      let request = delivery.next_request;
      let finalBatch: Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "INPUT_BATCH" }>["batch"] | undefined;
      let expectedChunkOrdinal = 0;
      if (!testedPrematureStart) {
        assertMcpError(await callTool(client, trace, "executor.generation.start", {
          version: "automatic_build_executor_generation_start_request.v3",
          opaque_session_ref: delivery.input_manifest.opaque_session_ref,
          generation_input_ref: delivery.input_manifest.generation_input_ref,
          confirmed_through_ordinal: delivery.input_manifest.total_chunk_count - 1,
        }));
        assert.equal(attemptCount(primary), generationCount);
        testedPrematureStart = true;
      }
      for (let batchOrdinal = 0; batchOrdinal < CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_input_chunks + 1; batchOrdinal += 1) {
        const batchResult = await callTool(client, trace, "executor.input.next", request as unknown as JsonObject);
        maxToolResultBytes = Math.max(maxToolResultBytes, Buffer.byteLength(batchResult.text, "utf8"));
        const batchResponse = batchResult.response as AutomaticBuildExecutorSessionResponseV3;
        assert.equal(batchResponse.action.kind, "INPUT_BATCH");
        if (batchResponse.action.kind !== "INPUT_BATCH") throw new Error("expected INPUT_BATCH");
        const batch = batchResponse.action.batch;
        batchCount += 1;
        assert.equal(batch.first_ordinal, expectedChunkOrdinal);
        for (const chunk of batch.chunks) {
          assert.equal(chunk.ordinal, expectedChunkOrdinal);
          expectedChunkOrdinal += 1;
          chunkCount += 1;
          deliveredBytes += Buffer.byteLength(chunk.payload_utf8, "utf8");
        }

        if (generationCount === 0 && batchOrdinal === 0 && batchZeroReplayCount === 0) {
          for (let replay = 0; replay < 4; replay += 1) {
            const replayedBatch = await callTool(
              client,
              trace,
              "executor.input.next",
              request as unknown as JsonObject,
            );
            assert.equal(
              replayedBatch.text,
              batchResult.text,
              "batch-zero request replay must be byte-identical",
            );
            assert.equal(attemptCount(primary), generationCount);
            batchZeroReplayCount += 1;
          }
        }

        if (!testedOrdinalFailure) {
          assertMcpError(await callTool(client, trace, "executor.input.next", {
            version: "automatic_build_executor_input_next_request.v4",
            opaque_session_ref: delivery.input_manifest.opaque_session_ref,
            generation_input_ref: delivery.input_manifest.generation_input_ref,
            ack_through_ordinal: batch.last_ordinal + 1,
          }));
          assert.equal(attemptCount(primary), generationCount);
          testedOrdinalFailure = true;
        }
        if (batch.final_for_generation) {
          finalBatch = batch;
          const replay = await callTool(client, trace, "executor.input.next", request as unknown as JsonObject);
          assert.equal(replay.text, batchResult.text, "final batch replay must be byte-identical");
          break;
        }
        request = {
          version: "automatic_build_executor_input_next_request.v4",
          opaque_session_ref: delivery.input_manifest.opaque_session_ref,
          generation_input_ref: delivery.input_manifest.generation_input_ref,
          ack_through_ordinal: batch.last_ordinal,
        };
      }
      assert(finalBatch, "compiled executor input delivery did not issue a final batch");
      assert.equal(attemptCount(primary), generationCount);
      const startRequest = {
        version: "automatic_build_executor_generation_start_request.v3",
        opaque_session_ref: finalBatch.opaque_session_ref,
        generation_input_ref: finalBatch.generation_input_ref,
        confirmed_through_ordinal: finalBatch.last_ordinal,
      };
      const generated = await callTool(client, trace, "executor.generation.start", startRequest);
      assert.equal(generated.isError, false, "compiled MCP rejected a valid generation.start request");
      const generatedResponse = generated.response as AutomaticBuildExecutorSessionResponseV3;
      assert.equal(generatedResponse.action.kind, "GENERATE");
      if (generatedResponse.action.kind !== "GENERATE") throw new Error("expected GENERATE");
      generationCount += 1;
      assert.equal(generatedResponse.action.semantic_attempt, 1);
      assert.equal(attemptCount(primary), generationCount);
      const startReplay = await callTool(client, trace, "executor.generation.start", startRequest);
      assert.equal(startReplay.text, generated.text, "generation.start replay must be byte-identical");
      const candidateRequest = {
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: generatedResponse.action.opaque_session_ref,
        candidate_sink_ref: generatedResponse.action.candidate_sink_ref,
        candidate: {
          nodes: [
            {
              id: "entity:t7_synthetic_cli_fixture",
              type: "entity",
              name: "T7 synthetic CLI fixture",
              occurrences: ["1.1"],
              source_lid: null,
            },
            {
              id: "entity:t7_cli_semantic_input_sentinel",
              type: "entity",
              name: "T7_CLI_SEMANTIC_INPUT_SENTINEL",
              occurrences: ["1.2"],
              source_lid: null,
            },
            {
              id: "concept:bounded_synthetic_context",
              type: "concept",
              name: "bounded synthetic context",
              occurrences: ["1.2"],
              source_lid: null,
            },
          ],
          edges: [],
        },
      };
      assert(
        Buffer.byteLength(JSON.stringify(candidateRequest), "utf8")
          <= CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes,
        "structured candidate request exceeded its byte cap",
      );
      const submitted = await callTool(client, trace, "executor.submit_candidate", candidateRequest);
      assert(!submitted.text.includes(candidateMarker), "candidate body leaked into the submit response");
      const submitReplay = await callTool(client, trace, "executor.submit_candidate", candidateRequest);
      assert.equal(submitReplay.text, submitted.text, "candidate submit replay must be byte-identical");
      current = submitted;
    }
    const finalResponse = current.response as AutomaticBuildExecutorSessionResponseV3;
    assert.equal(finalResponse.action.kind, "DONE", "compiled executor dispatch did not terminate");
    assert.equal(generationCount, attemptCount(primary));
    assert.equal(attemptCount(secondary), 0);
    assert(testedPrematureStart && testedOrdinalFailure);
    assert.equal(batchZeroReplayCount, 4);

    const visibility = assertTraceAllowlist(trace);
    const serverTimingSamples = await client.close();
    client = undefined;
    const evidence = {
      version: "understand_book_t7_executor_release_evidence.v2",
      status: "passed",
      executor_role: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.agent_name,
      shared_executor_mcp: {
        registration_scope: BUILD_EXECUTOR_MCP_CONTRACT_V3.registration_scope,
        bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
        session_protocol: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
        executor_tool_count: expectedTools.length,
        exact_four: true,
        capability_isolation: false,
        caller_role_authenticated: BUILD_EXECUTOR_MCP_CONTRACT_V3.caller_role_authenticated,
        compiled_sidecar_executed: true,
      },
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      tool_inventory: [...expectedTools],
      forbidden_digest_field_count: 0,
      synthetic_input: {
        compiled_chunk_count: chunkCount,
        compiled_batch_count: batchCount,
        compiled_delivered_bytes: deliveredBytes,
        max_tool_result_bytes: maxToolResultBytes,
        batch_zero_request_replays: batchZeroReplayCount,
      },
      attempt_contract: {
        before_generation_start: 0,
        accepted_generation_count: generationCount,
        final_semantic_attempt_count: attemptCount(primary),
        untouched_cross_handoff_attempt_count: attemptCount(secondary),
      },
      negative_gates: {
        bootstrap_v2: "protocol_incompatible",
        unknown_request_field: "protocol_incompatible",
        cross_handoff_connection: "protocol_incompatible",
        premature_generation_start: "protocol_incompatible",
        ack_through_ordinal_mismatch: "protocol_incompatible",
      },
      trace_allowlist: visibility,
      mcp_server_timing: {
        version: "executor_mcp_server_timing.v2",
        sample_count: serverTimingSamples.length,
        first_connection_call_ordinal: serverTimingSamples[0]?.connection_call_ordinal,
        last_connection_call_ordinal: serverTimingSamples.at(-1)?.connection_call_ordinal,
        operations: [...new Set(serverTimingSamples.map((sample) => sample.operation))].sort(),
        bounded_error_count: serverTimingSamples.filter((sample) => sample.outcome === "bounded_error").length,
      },
      final_status: finalResponse.action.kind === "DONE" ? finalResponse.action.status : "invalid",
    };
    const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
    assert(!serializedEvidence.includes(semanticSentinel));
    assert(!serializedEvidence.includes(candidateMarker));
    assert(!serializedEvidence.includes(primary.envelope.opaque_handoff_ref));
    assert(!serializedEvidence.includes(container));
    assert(!/(transport_profile_digest|compiled_sidecar_sha256|skill_sha256|manifest_sha256|root_final_sha256)/u
      .test(serializedEvidence));
    if (evidenceOut) {
      mkdirSync(path.dirname(evidenceOut), { recursive: true });
      writeFileSync(evidenceOut, serializedEvidence, "utf8");
    }
    process.stdout.write(serializedEvidence);
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // The primary assertion is more useful than a second cleanup failure.
      }
    }
    if (previousRegistryRoot === undefined) {
      delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    } else {
      process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
    }
    rmSync(container, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
