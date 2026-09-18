import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  createExecutorOuterTimingRecorder,
  reduceExecutorMcpTiming,
  type ExecutorMcpTimingJoinV2,
  type ExecutorTraceOperation,
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

interface ExecutorMcpInvocation {
  command: string;
  args: string[];
  cwd: string;
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

function pathIsOutside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export function executorMcpInvocation(
  sidecar: string,
  blackBoxCwd: string,
  installedPluginRoot?: string,
): ExecutorMcpInvocation {
  if (!installedPluginRoot) {
    return {
      command: sidecar,
      args: [
        "executor.mcp",
        "--bootstrap-version",
        BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
        "--protocol-generation",
        BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      ],
      cwd: blackBoxCwd,
    };
  }
  assert(pathIsOutside(repoRoot, installedPluginRoot), "installed plugin root must be outside source cwd");
  const launcher = path.join(installedPluginRoot, "scripts", "start-build-executor-mcp.cmd");
  assert(existsSync(launcher), `installed Executor MCP launcher is missing: ${launcher}`);
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", launcher],
    cwd: installedPluginRoot,
  };
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

export class JsonLineMcpClient {
  private static nextConnection = 1;
  private readonly connectionId = `compiled-connection-${JsonLineMcpClient.nextConnection++}`;
  private readonly outerTiming = createExecutorOuterTimingRecorder(this.connectionId);
  timingJoin: ExecutorMcpTimingJoinV2 | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exitPromise: Promise<number | null>;
  private nextId = 1;
  private stderrText = "";

  constructor(invocation: ExecutorMcpInvocation, registryRoot: string, sidecar: string) {
    this.child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        UNDERSTAND_BOOK_BUILD_EXE: sidecar,
        UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: registryRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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
    const operation = method === "tools/call" ? (params as { name?: string } | undefined)?.name : undefined;
    const finishTiming = operation && (BUILD_EXECUTOR_MCP_CONTRACT_V3.tools as readonly { name: string }[]).some((tool) => tool.name === operation)
      ? this.outerTiming.begin(operation as ExecutorTraceOperation)
      : undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`compiled executor MCP timed out for ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: (response) => { finishTiming?.(); resolve(response); }, reject, timer });
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
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        this.child.kill();
        reject(new Error("compiled executor MCP did not exit after stdin closed"));
      }, 10_000);
    });
    const code = await Promise.race([this.exitPromise, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    this.lines.close();
    assert.equal(code, 0, `compiled executor MCP exited ${String(code)}: ${this.stderrText}`);
    const samples = readExecutorMcpServerTimingJsonl(this.stderrText, "compiled executor MCP stderr");
    assert(samples.every((sample, index) => sample.connection_call_ordinal === index + 1));
    assert(samples.length > 0, "compiled executor MCP emitted no server timing samples");
    this.timingJoin = reduceExecutorMcpTiming({
      connections: [{ thread_id: this.connectionId, samples }],
      outer_samples: this.outerTiming.samples,
    });
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

async function withJsonLineMcpClient<T>(
  invocation: ExecutorMcpInvocation,
  registryRoot: string,
  sidecar: string,
  action: (client: JsonLineMcpClient) => Promise<T>,
): Promise<T> {
  const client = new JsonLineMcpClient(invocation, registryRoot, sidecar);
  let actionCompleted = false;
  try {
    const result = await action(client);
    actionCompleted = true;
    return result;
  } finally {
    try {
      await client.close();
    } catch (error) {
      if (actionCompleted) throw error;
    }
  }
}

function createFixture(
  container: string,
  registryRoot: string,
  label: string,
  sourceBody: string,
  options: { run_ttl_ms?: number } = {},
) {
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
    ...(options.run_ttl_ms === undefined ? {} : { run_ttl_ms: options.run_ttl_ms }),
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
    buildPlan,
    acceptedPlanDigest: plan.preflight.descriptor_plan_digest,
    runTtlMs: options.run_ttl_ms,
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

async function startCurrentGeneration(
  client: JsonLineMcpClient,
  trace: TraceEvent[],
  opaqueHandoffRef: string,
): Promise<Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "GENERATE" }>> {
  const opened = await callTool(client, trace, "executor.open", {
    version: "automatic_build_executor_open_request.v3",
    opaque_handoff_ref: opaqueHandoffRef,
  });
  assert.equal(opened.isError, false, opened.text);
  const openResponse = opened.response as AutomaticBuildExecutorSessionResponseV3;
  assert.equal(openResponse.action.kind, "DELIVER_INPUT");
  if (openResponse.action.kind !== "DELIVER_INPUT") throw new Error("expected DELIVER_INPUT");
  let request = openResponse.action.next_request;
  let finalBatch: Extract<AutomaticBuildExecutorSessionResponseV3["action"], {
    kind: "INPUT_BATCH";
  }>["batch"] | undefined;
  for (let batchOrdinal = 0; batchOrdinal < CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_input_chunks + 1; batchOrdinal += 1) {
    const delivered = await callTool(client, trace, "executor.input.next", request as unknown as JsonObject);
    assert.equal(delivered.isError, false, delivered.text);
    const response = delivered.response as AutomaticBuildExecutorSessionResponseV3;
    assert.equal(response.action.kind, "INPUT_BATCH");
    if (response.action.kind !== "INPUT_BATCH") throw new Error("expected INPUT_BATCH");
    finalBatch = response.action.batch;
    if (finalBatch.final_for_generation) break;
    request = {
      version: "automatic_build_executor_input_next_request.v4",
      opaque_session_ref: finalBatch.opaque_session_ref,
      generation_input_ref: finalBatch.generation_input_ref,
      ack_through_ordinal: finalBatch.last_ordinal,
    };
  }
  assert(finalBatch?.final_for_generation, "executor input did not reach its final batch");
  const generated = await callTool(client, trace, "executor.generation.start", {
    version: "automatic_build_executor_generation_start_request.v3",
    opaque_session_ref: finalBatch.opaque_session_ref,
    generation_input_ref: finalBatch.generation_input_ref,
    confirmed_through_ordinal: finalBatch.last_ordinal,
  });
  assert.equal(generated.isError, false, generated.text);
  const response = generated.response as AutomaticBuildExecutorSessionResponseV3;
  assert.equal(response.action.kind, "GENERATE");
  if (response.action.kind !== "GENERATE") throw new Error("expected GENERATE");
  return response.action;
}

function taskSessionFacts(
  registryRoot: string,
  opaqueSessionRef: string,
): {
  work_unit_id: string;
  lease_ref: string;
  semantic_attempt: number;
  lease_epoch: number;
} {
  return JSON.parse(readFileSync(path.join(
    registryRoot,
    "executor-task-sessions",
    `${opaqueSessionRef}.json`,
  ), "utf8")) as {
    work_unit_id: string;
    lease_ref: string;
    semantic_attempt: number;
    lease_epoch: number;
  };
}

function committedAttemptBytes(leaseRef: string): {
  receipt_path: string;
  receipt_bytes: Buffer;
  artifact_path: string;
  artifact_bytes: Buffer;
} {
  const receiptPath = path.join(path.dirname(leaseRef), "receipt.json");
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as { artifact_path: string };
  return {
    receipt_path: receiptPath,
    receipt_bytes: receiptBytes,
    artifact_path: receipt.artifact_path,
    artifact_bytes: readFileSync(receipt.artifact_path),
  };
}

async function waitForRunLeaseExpiry(leaseRef: string): Promise<void> {
  const start = JSON.parse(readFileSync(path.join(path.dirname(leaseRef), "start.json"), "utf8")) as {
    run_expires_at: string;
  };
  const expiresAt = Date.parse(start.run_expires_at);
  assert(Number.isFinite(expiresAt), "synthetic run lease expiry is invalid");
  const remaining = expiresAt - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 25));
  }
  assert(Date.now() >= expiresAt, "synthetic run lease did not expire");
}

function assertMcpError(
  value: Awaited<ReturnType<typeof callTool>>,
  phase: "open" | "input_delivery" | "generation_start" | "candidate_submit",
  diagnostic: "protocol_incompatible" | "handoff_ref_mismatch" | "connection_terminal" | "invalid_arguments" = "protocol_incompatible",
  field?: "arguments" | "opaque_handoff_ref",
): void {
  assert.equal(value.isError, true);
  assert.deepEqual(value.response, {
    version: "automatic_build_executor_mcp_error.v2",
    status: "interrupted",
    category: diagnostic === "protocol_incompatible" ? "bootstrap" : "session",
    diagnostic_code: diagnostic,
    phase,
    ...(field ? { field } : {}),
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

function nextPublicRecoveryEnvelope(value: ReturnType<typeof createFixture>) {
  const next = automaticBuildNext(value.source, value.root, 1, {
    accepted_plan_digest: value.acceptedPlanDigest,
    available_agent_slots: 1,
    executor_dispatches: true,
    build_plan: value.buildPlan,
    ...(value.runTtlMs === undefined ? {} : { run_ttl_ms: value.runTtlMs }),
  });
  assert("dispatches" in next.action && next.action.dispatches, "RG8 recovery must produce a dispatch");
  const envelope = next.action.dispatches.find((candidate) => (
    candidate.manifest.dispatch_id === value.envelope.manifest.dispatch_id
  ));
  assert(envelope, "RG8 recovery dispatch is missing the current public envelope");
  return envelope;
}

async function runRg8RecoveryCanary(input: {
  container: string;
  registryRoot: string;
  invocation: ExecutorMcpInvocation;
  sidecar: string;
}): Promise<{
  committed_reused_units: number;
  recovered_units: number;
  stale_epoch: number;
  recovered_epoch: number;
  semantic_attempt: number;
  recovery_ref_replays: number;
  trace_event_count: number;
  sensitive_values: string[];
}> {
  const sentinel = "RG8_RECOVERY_SEMANTIC_SENTINEL_711931";
  const fixture = createFixture(
    input.container,
    input.registryRoot,
    "rg8-recovery",
    `${sentinel}\n${Array.from({ length: 160 }, (_, index) => (
      `Paragraph ${index + 1} contains stable evidence for the RG8 installed recovery canary.`
    )).join("\n\n")}`,
    { run_ttl_ms: 10_000 },
  );
  const workUnitIds = fixture.envelope.manifest.ordered_work_unit_ids;
  assert.equal(workUnitIds.length, 3, "RG8 recovery fixture must produce exactly A/B/C");
  const [unitA, unitB, unitC] = workUnitIds;
  assert(unitA && unitB && unitC);
  const trace: TraceEvent[] = [];
  const frozen: ReturnType<typeof committedAttemptBytes>[] = [];
  let currentEnvelope = fixture.envelope;

  for (const expectedUnit of [unitA, unitB]) {
    const taskSession = await withJsonLineMcpClient(
      input.invocation,
      input.registryRoot,
      input.sidecar,
      async (client) => {
        const generated = await startCurrentGeneration(
          client,
          trace,
          currentEnvelope.opaque_handoff_ref,
        );
        const session = taskSessionFacts(input.registryRoot, generated.opaque_session_ref);
        assert.equal(session.work_unit_id, expectedUnit);
        const submitted = await callTool(client, trace, "executor.submit_candidate", {
          version: "automatic_build_executor_candidate_submit.v3",
          opaque_session_ref: generated.opaque_session_ref,
          candidate_sink_ref: generated.candidate_sink_ref,
          candidate: { nodes: [], edges: [] },
        });
        assert.equal(submitted.isError, false, submitted.text);
        return session;
      },
    );
    frozen.push(committedAttemptBytes(taskSession.lease_ref));
    currentEnvelope = nextPublicRecoveryEnvelope(fixture);
  }
  const attemptsAfterAB = readAutomaticBuildAttemptSnapshot(fixture.target).stages.pass1;
  const frozenAttemptA = JSON.parse(JSON.stringify(attemptsAfterAB?.[unitA]));
  const frozenAttemptB = JSON.parse(JSON.stringify(attemptsAfterAB?.[unitB]));

  const stale = await withJsonLineMcpClient(
    input.invocation,
    input.registryRoot,
    input.sidecar,
    async (client) => {
      const generated = await startCurrentGeneration(
        client,
        trace,
        currentEnvelope.opaque_handoff_ref,
      );
      const taskSession = taskSessionFacts(input.registryRoot, generated.opaque_session_ref);
      assert.deepEqual({
        work_unit_id: taskSession.work_unit_id,
        semantic_attempt: taskSession.semantic_attempt,
        lease_epoch: taskSession.lease_epoch,
      }, {
        work_unit_id: unitC,
        semantic_attempt: 1,
        lease_epoch: 1,
      });
      return { generated, taskSession };
    },
  );
  const staleGenerated = stale.generated;
  const staleTaskSession = stale.taskSession;
  await waitForRunLeaseExpiry(staleTaskSession.lease_ref);

  const recoveredEnvelope = nextPublicRecoveryEnvelope(fixture);
  const replayedRecoveryEnvelope = nextPublicRecoveryEnvelope(fixture);
  assert.notEqual(recoveredEnvelope.opaque_handoff_ref, currentEnvelope.opaque_handoff_ref);
  assert.equal(recoveredEnvelope.opaque_handoff_ref, replayedRecoveryEnvelope.opaque_handoff_ref);
  assert.equal(recoveredEnvelope.dispatch_slot_ref, currentEnvelope.dispatch_slot_ref);

  const recovered = await withJsonLineMcpClient(
    input.invocation,
    input.registryRoot,
    input.sidecar,
    async (client) => {
      const generated = await startCurrentGeneration(
        client,
        trace,
        recoveredEnvelope.opaque_handoff_ref,
      );
      const taskSession = taskSessionFacts(input.registryRoot, generated.opaque_session_ref);
      assert.deepEqual({
        work_unit_id: taskSession.work_unit_id,
        semantic_attempt: taskSession.semantic_attempt,
        lease_epoch: taskSession.lease_epoch,
      }, {
        work_unit_id: unitC,
        semantic_attempt: 1,
        lease_epoch: 2,
      });
      assert.notEqual(generated.opaque_session_ref, staleGenerated.opaque_session_ref);
      assert.notEqual(generated.candidate_sink_ref, staleGenerated.candidate_sink_ref);
      const submitted = await callTool(client, trace, "executor.submit_candidate", {
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: generated.opaque_session_ref,
        candidate_sink_ref: generated.candidate_sink_ref,
        candidate: { nodes: [], edges: [] },
      });
      assert.equal(submitted.isError, false, submitted.text);
      return { generated, taskSession };
    },
  );
  const recoveredGenerated = recovered.generated;
  const recoveredTaskSession = recovered.taskSession;

  for (const bytes of frozen) {
    assert.deepEqual(readFileSync(bytes.receipt_path), bytes.receipt_bytes);
    assert.deepEqual(readFileSync(bytes.artifact_path), bytes.artifact_bytes);
  }
  const attempts = readAutomaticBuildAttemptSnapshot(fixture.target).stages.pass1;
  assert.deepEqual(attempts?.[unitA], frozenAttemptA);
  assert.deepEqual(attempts?.[unitB], frozenAttemptB);
  assert.equal(attempts?.[unitA]?.semantic_attempt, 1);
  assert.equal(attempts?.[unitA]?.lease_epoch, 1);
  assert.equal(attempts?.[unitA]?.submit_revision, 1);
  assert.equal(attempts?.[unitB]?.semantic_attempt, 1);
  assert.equal(attempts?.[unitB]?.lease_epoch, 1);
  assert.equal(attempts?.[unitB]?.submit_revision, 1);
  assert.equal(attempts?.[unitC]?.semantic_attempt, 1);
  assert.equal(attempts?.[unitC]?.lease_epoch, 2);
  assert.equal(attempts?.[unitC]?.submit_revision, 1);

  return {
    committed_reused_units: 2,
    recovered_units: 1,
    stale_epoch: staleTaskSession.lease_epoch,
    recovered_epoch: recoveredTaskSession.lease_epoch,
    semantic_attempt: recoveredTaskSession.semantic_attempt,
    recovery_ref_replays: 2,
    trace_event_count: trace.length,
    sensitive_values: [
      sentinel,
      fixture.root,
      fixture.source,
      currentEnvelope.opaque_handoff_ref,
      recoveredEnvelope.opaque_handoff_ref,
      staleGenerated.opaque_session_ref,
      staleGenerated.candidate_sink_ref,
      recoveredGenerated.opaque_session_ref,
      recoveredGenerated.candidate_sink_ref,
    ],
  };
}

async function runRg8OversizeCanary(input: {
  container: string;
  registryRoot: string;
  invocation: ExecutorMcpInvocation;
  sidecar: string;
}): Promise<{
  diagnostic_code: string;
  phase: string;
  semantic_attempt: number;
  lease_epoch: number;
  failure_count: number;
  writer_started: boolean;
  candidate_file_count: number;
  sensitive_values: string[];
}> {
  const sentinel = "RG8_OVERSIZE_PRIVATE_SENTINEL_284613";
  const fixture = createFixture(
    input.container,
    input.registryRoot,
    "rg8-oversize",
    `${sentinel}\n${"bounded oversize context ".repeat(300)}`,
  );
  const trace: TraceEvent[] = [];
  const canary = await withJsonLineMcpClient(
    input.invocation,
    input.registryRoot,
    input.sidecar,
    async (client) => {
      const generated = await startCurrentGeneration(
        client,
        trace,
        fixture.envelope.opaque_handoff_ref,
      );
      const taskSession = taskSessionFacts(input.registryRoot, generated.opaque_session_ref);
      const oversizeCandidate = {
        private_marker: sentinel,
        value: "界".repeat(generated.output_contract.transport.candidate_value_max_estimated_tokens + 1),
      };
      const submitted = await callTool(client, trace, "executor.submit_candidate", {
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: generated.opaque_session_ref,
        candidate_sink_ref: generated.candidate_sink_ref,
        candidate: oversizeCandidate,
      });
      assert.equal(submitted.isError, false, submitted.text);
      assert.deepEqual(submitted.response, {
        version: "automatic_build_executor_session.v3",
        action: { kind: "DONE", status: "retryable_failure" },
      });
      return { generated, taskSession, oversizeCandidate };
    },
  );
  const { generated, taskSession, oversizeCandidate } = canary;

  const attemptDir = path.dirname(taskSession.lease_ref);
  assert.equal(existsSync(path.join(attemptDir, "candidate.json")), false);
  assert.equal(existsSync(path.join(attemptDir, "submission.json")), false);
  assert.equal(existsSync(path.join(attemptDir, "receipt.json")), false);
  const failure = JSON.parse(readFileSync(path.join(attemptDir, "failure.json"), "utf8")) as {
    failure_diagnostic: { version: string; category: string; code: string; phase: string };
    metrics: { writer_started: boolean };
  };
  assert.equal(failure.failure_diagnostic.version, "automatic_build_failure_diagnostic.v3");
  assert.equal(failure.failure_diagnostic.category, "transport");
  assert.equal(failure.failure_diagnostic.code, "candidate_request_too_large");
  assert.equal(failure.failure_diagnostic.phase, "generation");
  assert.equal(failure.metrics.writer_started, false);
  const attempt = readAutomaticBuildAttemptSnapshot(fixture.target).stages.pass1?.[
    fixture.envelope.manifest.ordered_work_unit_ids[0]
  ];
  assert.equal(attempt?.semantic_attempt, 1);
  assert.equal(attempt?.lease_epoch, 1);
  assert.equal(attempt?.failures, 1);
  assert.equal(attempt?.submit_revision, 0);

  return {
    diagnostic_code: failure.failure_diagnostic.code,
    phase: failure.failure_diagnostic.phase,
    semantic_attempt: attempt?.semantic_attempt ?? 0,
    lease_epoch: attempt?.lease_epoch ?? 0,
    failure_count: attempt?.failures ?? 0,
    writer_started: failure.metrics.writer_started,
    candidate_file_count: Number(existsSync(path.join(attemptDir, "candidate.json"))),
    sensitive_values: [
      sentinel,
      fixture.root,
      fixture.source,
      fixture.envelope.opaque_handoff_ref,
      generated.opaque_session_ref,
      generated.candidate_sink_ref,
      JSON.stringify(oversizeCandidate),
    ],
  };
}

async function main(): Promise<void> {
  const sidecar = path.resolve(argumentValue("--sidecar") ?? defaultSidecar);
  const installedPluginRootValue = argumentValue("--installed-plugin-root");
  const installedPluginRoot = installedPluginRootValue
    ? path.resolve(installedPluginRootValue)
    : undefined;
  const evidenceOutValue = argumentValue("--evidence-out");
  const evidenceOut = evidenceOutValue ? path.resolve(evidenceOutValue) : undefined;
  assert(existsSync(sidecar), `compiled Build Engine Sidecar is missing: ${sidecar}`);

  const container = mkdtempSync(path.join(tmpdir(), "understand-book-t7-executor-release-"));
  const registryRoot = path.join(container, "driver-registry");
  const blackBoxCwd = path.join(container, "black-box-cwd");
  mkdirSync(blackBoxCwd, { recursive: true });
  const mcpInvocation = executorMcpInvocation(sidecar, blackBoxCwd, installedPluginRoot);
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
    const absentChild = spawnSync(sidecar, ["build.diagnose-child",
      "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002",
      primary.envelope.opaque_handoff_ref], { cwd: blackBoxCwd, windowsHide: true, encoding: "utf8",
      env: { ...process.env, CODEX_HOME: blackBoxCwd }, timeout: 30_000 });
    assert.ifError(absentChild.error);
    assert.equal(absentChild.status, 0, absentChild.stderr);
    assert.equal(absentChild.stderr, "");
    assert.equal(JSON.parse(absentChild.stdout).status, "evidence_missing");
    client = new JsonLineMcpClient(mcpInvocation, registryRoot, sidecar);
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
      version: "automatic_build_executor_open_request.v99",
      opaque_handoff_ref: primary.envelope.opaque_handoff_ref,
    }), "open");
    assert.equal(attemptCount(primary), 0);
    assertMcpError(await callTool(client, trace, "executor.open", {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: primary.envelope.opaque_handoff_ref,
      path: primary.envelope.executor_handoff.path,
    }), "open", "invalid_arguments", "arguments");
    assert.equal(attemptCount(primary), 0);

    assertMcpError(await callTool(client, trace, "executor.open", {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: primary.envelope.opaque_handoff_ref.slice(0, -2),
    }), "open", "invalid_arguments", "opaque_handoff_ref");
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
    }), "open", "handoff_ref_mismatch");
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
        }), "generation_start");
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
          }), "input_delivery");
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
    assertMcpError(await callTool(client, trace, "executor.open", {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: secondary.envelope.opaque_handoff_ref,
    }), "open", "connection_terminal");
    assert.equal(generationCount, attemptCount(primary));
    assert.equal(attemptCount(secondary), 0);
    assert(testedPrematureStart && testedOrdinalFailure);
    assert.equal(batchZeroReplayCount, 4);

    const visibility = assertTraceAllowlist(trace);
    const serverTimingSamples = await client.close();
    const outerServerTiming = client.timingJoin;
    client = undefined;
    const rg8Recovery = await runRg8RecoveryCanary({
      container,
      registryRoot,
      invocation: mcpInvocation,
      sidecar,
    });
    const rg8Oversize = await runRg8OversizeCanary({
      container,
      registryRoot,
      invocation: mcpInvocation,
      sidecar,
    });
    const evidence = {
      version: "understand_book_t7_executor_release_evidence.v3",
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
        installed_launcher_executed: installedPluginRoot !== undefined,
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
        unknown_open_version: "protocol_incompatible",
        unknown_request_field: "invalid_arguments",
        truncated_handoff_ref: "invalid_arguments",
        unbound_connection_correction: "same_connection_opened",
        cross_handoff_connection: "handoff_ref_mismatch",
        terminal_connection: "connection_terminal",
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
      mcp_outer_server_timing: outerServerTiming,
      rg8_recovery_canary: {
        committed_reused_units: rg8Recovery.committed_reused_units,
        recovered_units: rg8Recovery.recovered_units,
        stale_epoch: rg8Recovery.stale_epoch,
        recovered_epoch: rg8Recovery.recovered_epoch,
        semantic_attempt: rg8Recovery.semantic_attempt,
        recovery_ref_replays: rg8Recovery.recovery_ref_replays,
        trace_event_count: rg8Recovery.trace_event_count,
      },
      rg8_oversize_canary: {
        diagnostic_code: rg8Oversize.diagnostic_code,
        phase: rg8Oversize.phase,
        semantic_attempt: rg8Oversize.semantic_attempt,
        lease_epoch: rg8Oversize.lease_epoch,
        failure_count: rg8Oversize.failure_count,
        writer_started: rg8Oversize.writer_started,
        candidate_file_count: rg8Oversize.candidate_file_count,
      },
      final_status: finalResponse.action.kind === "DONE" ? finalResponse.action.status : "invalid",
    };
    const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
    assert(!serializedEvidence.includes(semanticSentinel));
    assert(!serializedEvidence.includes(candidateMarker));
    assert(!serializedEvidence.includes(primary.envelope.opaque_handoff_ref));
    assert(!serializedEvidence.includes(container));
    for (const sensitive of [...rg8Recovery.sensitive_values, ...rg8Oversize.sensitive_values]) {
      assert(!serializedEvidence.includes(sensitive), "RG8 evidence serialized a path, ref, sentinel, or candidate");
    }
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
    rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
