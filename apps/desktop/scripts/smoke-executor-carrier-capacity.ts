import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildCarrierCapacityEvidence,
  createCarrierReadResponse,
  EXECUTOR_CARRIER_SHAPES,
  EXECUTOR_CARRIER_TIERS,
  parseCarrierPayloadText,
  type ExecutorCarrierCaseResultV1,
  type ExecutorCarrierMode,
  type ExecutorCarrierShape,
} from "./executor-carrier-capacity";

type JsonObject = Record<string, unknown>;
type CodexInvocation = { command: string; argsPrefix: string[] };
type ProcessResult = { code: number; stdout: string; stderr: string };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptPath = fileURLToPath(import.meta.url);
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const pluginName = "executor-carrier-capacity";
const serverName = "executor_carrier_capacity";
const directReadTool = "carrier.read";
const ackTool = "carrier.ack";
const rootFinalMarker = "M2_EXECUTOR_CARRIER_CAPACITY_SCENARIO_COMPLETE";

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function argumentValue(name: string, required = false): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    assert(!required, `${name} is required`);
    return undefined;
  }
  assert(index + 1 < process.argv.length, `${name} requires a value`);
  assert.equal(process.argv.indexOf(name, index + 1), -1, `${name} may appear only once`);
  return process.argv[index + 1];
}

function runSync(
  command: string,
  args: string[],
  label: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeout = 120_000,
): ProcessResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function runCodex(
  codex: CodexInvocation,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(codex.command, [...codex.argsPrefix, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("carrier capacity Codex scenario exceeded 15 minutes"));
    }, 900_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      assert(stdout.length <= 32 * 1024 * 1024, "carrier scenario stdout exceeded its bound");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      assert(stderr.length <= 8 * 1024 * 1024, "carrier scenario stderr exceeded its bound");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function resolveCodexInvocation(explicit: string | undefined): CodexInvocation {
  if (explicit) {
    const resolved = path.resolve(explicit);
    assert(existsSync(resolved), `Codex command is missing: ${resolved}`);
    return resolved.toLowerCase().endsWith(".js")
      ? { command: process.execPath, argsPrefix: [resolved] }
      : { command: resolved, argsPrefix: [] };
  }
  return { command: "codex", argsPrefix: [] };
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function appendLedger(root: string, name: "responses" | "acks", value: JsonObject): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(path.join(root, `${name}.jsonl`), `${JSON.stringify(value)}\n`, "utf8");
}

function serverEnvironment(): { mode: ExecutorCarrierMode; shape: ExecutorCarrierShape; ledgerRoot: string } {
  const mode = process.env.UB_CARRIER_MODE;
  const shape = process.env.UB_CARRIER_SHAPE;
  const ledgerRoot = process.env.UB_CARRIER_LEDGER_ROOT;
  assert(mode === "direct_result" || mode === "program_output", "carrier mode is invalid");
  assert(shape === "ascii" || shape === "cjk", "carrier shape is invalid");
  assert(ledgerRoot, "carrier ledger root is missing");
  return { mode, shape, ledgerRoot: path.resolve(ledgerRoot) };
}

function runCarrierServer(): void {
  const environment = serverEnvironment();
  const served = new Map<number, ReturnType<typeof createCarrierReadResponse>["payload"]>();
  const acknowledged = new Set<number>();
  const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: value });
  const error = (id: unknown, message: string) => result(id, {
    content: [{ type: "text", text: JSON.stringify({ version: "executor_carrier_error.v1", message }) }],
    isError: true,
  });
  process.stdin.setEncoding("utf8");
  let pending = "";
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let request: JsonObject;
      try {
        const parsed = JSON.parse(line) as unknown;
        assert(isRecord(parsed));
        request = parsed;
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        continue;
      }
      if (request.method === "initialize") {
        process.stdout.write(`${JSON.stringify(result(request.id, {
          protocolVersion: isRecord(request.params) && typeof request.params.protocolVersion === "string"
            ? request.params.protocolVersion
            : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: "executor_carrier_capacity_mcp.v1" },
        }))}\n`);
        continue;
      }
      if (typeof request.method === "string" && request.method.startsWith("notifications/")) continue;
      if (request.method === "ping") {
        process.stdout.write(`${JSON.stringify(result(request.id, {}))}\n`);
        continue;
      }
      if (request.method === "tools/list") {
        process.stdout.write(`${JSON.stringify(result(request.id, { tools: [
          {
            name: directReadTool,
            description: "Return one bounded synthetic carrier payload for deterministic capacity testing.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tier_bytes", "shape"],
              properties: {
                tier_bytes: { type: "integer", enum: [...EXECUTOR_CARRIER_TIERS] },
                shape: { type: "string", enum: [...EXECUTOR_CARRIER_SHAPES] },
              },
            },
          },
          {
            name: ackTool,
            description: "Acknowledge exact synthetic payload length, closure, and tail delivery.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tier_bytes", "shape", "content_utf8_bytes", "tail_sentinel", "structure_closed"],
              properties: {
                tier_bytes: { type: "integer", enum: [...EXECUTOR_CARRIER_TIERS] },
                shape: { type: "string", enum: [...EXECUTOR_CARRIER_SHAPES] },
                content_utf8_bytes: { type: "integer", minimum: 1 },
                tail_sentinel: { type: "string" },
                structure_closed: { type: "boolean" },
              },
            },
          },
        ] }))}\n`);
        continue;
      }
      if (request.method !== "tools/call" || !isRecord(request.params)
        || typeof request.params.name !== "string" || !isRecord(request.params.arguments)) {
        process.stdout.write(`${JSON.stringify(error(request.id, "unsupported request"))}\n`);
        continue;
      }
      const args = request.params.arguments;
      if (request.params.name === directReadTool) {
        const tier = args.tier_bytes;
        const shape = args.shape;
        if (!Number.isSafeInteger(tier) || !EXECUTOR_CARRIER_TIERS.includes(tier as number)
          || shape !== environment.shape) {
          process.stdout.write(`${JSON.stringify(error(request.id, "carrier case does not match the scenario"))}\n`);
          continue;
        }
        const tierIndex = EXECUTOR_CARRIER_TIERS.indexOf(tier as number);
        if (tierIndex > 0 && !acknowledged.has(EXECUTOR_CARRIER_TIERS[tierIndex - 1])) {
          process.stdout.write(`${JSON.stringify(error(request.id, "previous carrier tier is not acknowledged"))}\n`);
          continue;
        }
        const built = createCarrierReadResponse(
          request.id as string | number | null,
          tier as number,
          environment.shape,
        );
        served.set(tier as number, built.payload);
        appendLedger(environment.ledgerRoot, "responses", {
          version: "executor_carrier_response_observation.v1",
          mode: environment.mode,
          shape,
          tier_bytes: tier,
          serialized_result_bytes: Buffer.byteLength(built.serialized_line, "utf8"),
          content_utf8_bytes: built.payload.content_utf8_bytes,
        });
        process.stdout.write(built.serialized_line);
        continue;
      }
      if (request.params.name === ackTool) {
        const tier = args.tier_bytes;
        const payload = Number.isSafeInteger(tier) ? served.get(tier as number) : undefined;
        const valid = !!payload
          && args.shape === payload.shape
          && args.content_utf8_bytes === payload.content_utf8_bytes
          && args.tail_sentinel === payload.tail_sentinel
          && args.structure_closed === true;
        if (!valid) {
          process.stdout.write(`${JSON.stringify(error(request.id, "carrier acknowledgement does not match"))}\n`);
          continue;
        }
        acknowledged.add(tier as number);
        appendLedger(environment.ledgerRoot, "acks", {
          version: "executor_carrier_ack_observation.v1",
          mode: environment.mode,
          shape: payload.shape,
          tier_bytes: tier,
          content_utf8_bytes: payload.content_utf8_bytes,
          tail_complete: true,
          structure_closed: true,
        });
        process.stdout.write(`${JSON.stringify(result(request.id, {
          content: [{ type: "text", text: JSON.stringify({ version: "executor_carrier_ack.v1", status: "accepted" }) }],
          isError: false,
        }))}\n`);
        continue;
      }
      process.stdout.write(`${JSON.stringify(error(request.id, "unknown tool"))}\n`);
    }
  });
}

function readJsonLines(file: string): JsonObject[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => {
    const value = JSON.parse(line) as unknown;
    assert(isRecord(value));
    return value;
  });
}

function readJsonObject(file: string): JsonObject {
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  assert(isRecord(value));
  return value;
}

function rawPayloadReader(bundleRoot: string, state: JsonObject): (id: string) => JsonObject {
  assert(isRecord(state.raw_payloads));
  const refs = state.raw_payloads;
  return (id: string) => {
    const ref = refs[id];
    assert(isRecord(ref) && typeof ref.path === "string");
    const resolved = path.resolve(bundleRoot, ref.path);
    const relative = path.relative(bundleRoot, resolved);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    return readJsonObject(resolved);
  };
}

function extractDirectTracePayloads(bundleRoot: string): Map<number, string> {
  const state = readJsonObject(path.join(bundleRoot, "state.json"));
  assert(typeof state.root_thread_id === "string");
  assert(isRecord(state.tool_calls));
  const readRaw = rawPayloadReader(bundleRoot, state);
  const values = new Map<number, string>();
  for (const rawCall of Object.values(state.tool_calls)) {
    if (!isRecord(rawCall) || rawCall.execution === undefined
      || typeof rawCall.thread_id !== "string" || typeof rawCall.raw_invocation_payload_id !== "string") continue;
    const invocation = readRaw(rawCall.raw_invocation_payload_id);
    if (invocation.tool_namespace !== `mcp__${serverName}` || invocation.tool_name !== "carrier_read") continue;
    assert.notEqual(rawCall.thread_id, state.root_thread_id, "root called the carrier payload tool");
    assert(typeof rawCall.raw_result_payload_id === "string", "carrier read has no raw result");
    const result = readRaw(rawCall.raw_result_payload_id);
    assert.equal(result.type, "code_mode_response");
    assert(isRecord(result.value) && Array.isArray(result.value.content));
    const textItem = result.value.content.find((item) => isRecord(item) && item.type === "text");
    assert(isRecord(textItem) && typeof textItem.text === "string");
    const payload = parseCarrierPayloadText(textItem.text);
    values.set(payload.serialized_result_bytes, textItem.text);
  }
  return values;
}

function extractProgramOutput(bundleRoot: string): Map<number, JsonObject> {
  const state = readJsonObject(path.join(bundleRoot, "state.json"));
  assert(typeof state.root_thread_id === "string");
  assert(isRecord(state.tool_calls));
  const readRaw = rawPayloadReader(bundleRoot, state);
  const cases = new Map<number, JsonObject>();
  for (const rawCall of Object.values(state.tool_calls)) {
    if (!isRecord(rawCall) || typeof rawCall.thread_id !== "string"
      || typeof rawCall.raw_invocation_payload_id !== "string" || typeof rawCall.raw_result_payload_id !== "string") continue;
    const invocation = readRaw(rawCall.raw_invocation_payload_id);
    if (invocation.tool_namespace !== "functions" || invocation.tool_name !== "exec") continue;
    assert.notEqual(rawCall.thread_id, state.root_thread_id, "root called functions.exec for carrier payloads");
    const result = readRaw(rawCall.raw_result_payload_id);
    if (!isRecord(result.response) || !isRecord(result.response.Result)
      || !Array.isArray(result.response.Result.content_items)) continue;
    const item = result.response.Result.content_items.find((candidate) => (
      isRecord(candidate) && candidate.type === "input_text" && typeof candidate.text === "string"
    ));
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const output = JSON.parse(item.text) as unknown;
    if (!isRecord(output) || output.version !== "executor_carrier_program_output.v1" || !Array.isArray(output.cases)) continue;
    for (const value of output.cases) {
      if (isRecord(value) && Number.isSafeInteger(value.tier_bytes)) cases.set(value.tier_bytes as number, value);
    }
  }
  if (cases.size === 0 && isRecord(state.conversation_items)) {
    for (const item of Object.values(state.conversation_items)) {
      if (!isRecord(item) || item.thread_id === state.root_thread_id
        || item.kind !== "custom_tool_call_output" || !isRecord(item.body)
        || !Array.isArray(item.body.parts)) continue;
      for (const part of item.body.parts) {
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
        let output: unknown;
        try {
          output = JSON.parse(part.text) as unknown;
        } catch {
          continue;
        }
        if (!isRecord(output) || output.version !== "executor_carrier_program_output.v1"
          || !Array.isArray(output.cases)) continue;
        for (const value of output.cases) {
          if (isRecord(value) && Number.isSafeInteger(value.tier_bytes)) {
            cases.set(value.tier_bytes as number, value);
          }
        }
      }
    }
  }
  return cases;
}

function oneTraceBundle(traceRoot: string): string {
  const entries = readdirSync(traceRoot, { withFileTypes: true });
  assert.equal(entries.length, 1, "carrier scenario must produce one trace bundle");
  assert(entries[0].isDirectory());
  return path.join(traceRoot, entries[0].name);
}

function scenarioPrompt(mode: ExecutorCarrierMode, shape: ExecutorCarrierShape): string {
  const childTask = `m2_${mode}_${shape}`;
  const directMessage = [
    "Use only the synthetic Executor carrier MCP tools; do not read files or run shell/program tools.",
    `For shape=${shape}, test tiers ${EXECUTOR_CARRIER_TIERS.join(",")} in ascending order.`,
    `For each tier call mcp__${serverName}__carrier_read with tier_bytes and shape.`,
    "Parse its only text item as JSON. If parsing or delivery fails, stop immediately.",
    `Then call mcp__${serverName}__carrier_ack with tier_bytes, shape, content_utf8_bytes, tail_sentinel, and structure_closed=true from that parsed object.`,
    "Do not quote payload text. After all reachable tiers, return exactly M2_DIRECT_CHILD_COMPLETE.",
  ].join(" ");
  const programSource = [
    `const tiers = ${JSON.stringify(EXECUTOR_CARRIER_TIERS)};`,
    "const cases = [];",
    "for (const tier_bytes of tiers) {",
    `  const result = await tools.mcp__${serverName}__carrier_read({ tier_bytes, shape: ${JSON.stringify(shape)} });`,
    "  const item = result.content.find((value) => value.type === 'text');",
    "  if (!item || typeof item.text !== 'string') throw new Error('carrier result text missing');",
    "  const payload = JSON.parse(item.text);",
    "  let content_utf8_bytes = 0;",
    "  for (const character of item.text) {",
    "    const point = character.codePointAt(0);",
    "    content_utf8_bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;",
    "  }",
    `  const expectedTail = \`M2_${shape.toUpperCase()}_\${tier_bytes}_TAIL\`;`,
    "  if (payload.version !== 'executor_carrier_payload.v1' || payload.serialized_result_bytes !== tier_bytes || payload.content_utf8_bytes !== content_utf8_bytes || payload.tail_sentinel !== expectedTail) throw new Error('carrier payload incomplete');",
    `  await tools.mcp__${serverName}__carrier_ack({ tier_bytes, shape: ${JSON.stringify(shape)}, content_utf8_bytes, tail_sentinel: payload.tail_sentinel, structure_closed: true });`,
    "  cases.push({ tier_bytes, content_utf8_bytes, tail_complete: true, structure_closed: true });",
    "}",
    "text(JSON.stringify({ version: 'executor_carrier_program_output.v1', cases }));",
  ].join("\n");
  const programMessage = [
    "Use functions.exec exactly once and do not call the carrier MCP tools directly from the model.",
    "Execute the following JavaScript source exactly, then return exactly M2_PROGRAM_CHILD_COMPLETE:",
    "```javascript",
    programSource,
    "```",
  ].join("\n");
  return [
    "This is an isolated synthetic carrier test. Do not read files, run shell commands, or activate skills from root.",
    `Call spawn_agent exactly once with task_name=${childTask}, fork_turns=none, agent_type=default, and this message:`,
    mode === "direct_result" ? directMessage : programMessage,
    "Wait until the child becomes terminal. Do not quote its content or tool results.",
    `Return exactly ${rootFinalMarker} and nothing else.`,
  ].join("\n");
}

function writeMarketplace(root: string): void {
  const pluginRoot = path.join(root, "plugin");
  mkdirSync(path.join(root, ".agents", "plugins"), { recursive: true });
  mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({
    name: pluginName,
    interface: { displayName: "Executor Carrier Capacity" },
    plugins: [{
      name: pluginName,
      source: { source: "local", path: "./plugin" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    }],
  }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: pluginName,
    version: "0.0.1",
    description: "Test-only bounded synthetic MCP carrier capacity probe.",
    author: { name: "Understand Book tests" },
    license: "MIT",
    mcpServers: "./.mcp.json",
  }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(pluginRoot, ".mcp.json"), `${JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: "stdio",
        command: process.execPath,
        args: [tsxCli, scriptPath, "--server"],
        cwd: ".",
        required: true,
        enabled_tools: [directReadTool, ackTool],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 10,
        tool_timeout_sec: 120,
        env_vars: ["UB_CARRIER_MODE", "UB_CARRIER_SHAPE", "UB_CARRIER_LEDGER_ROOT", "USERPROFILE"],
      },
    },
  }, null, 2)}\n`, "utf8");
}

async function runScenario(input: {
  codex: CodexInvocation;
  hostRelease: string;
  baseEnvironment: NodeJS.ProcessEnv;
  stagingRoot: string;
  mode: ExecutorCarrierMode;
  shape: ExecutorCarrierShape;
}): Promise<ExecutorCarrierCaseResultV1[]> {
  const scenarioRoot = path.join(input.stagingRoot, `${input.mode}-${input.shape}`);
  const traceRoot = path.join(scenarioRoot, "trace");
  const ledgerRoot = path.join(scenarioRoot, "ledger");
  mkdirSync(traceRoot, { recursive: true });
  mkdirSync(ledgerRoot, { recursive: true });
  const environment = {
    ...input.baseEnvironment,
    CODEX_ROLLOUT_TRACE_ROOT: traceRoot,
    UB_CARRIER_MODE: input.mode,
    UB_CARRIER_SHAPE: input.shape,
    UB_CARRIER_LEDGER_ROOT: ledgerRoot,
  };
  const execution = await runCodex(input.codex, [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--cd",
    scenarioRoot,
    scenarioPrompt(input.mode, input.shape),
  ], environment, scenarioRoot);
  assert.equal(execution.code, 0, `${input.mode}/${input.shape} Codex scenario failed:\n${execution.stderr}`);
  const rootMessages = execution.stdout.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const event = JSON.parse(line) as unknown;
    if (!isRecord(event) || !isRecord(event.item) || event.item.type !== "agent_message"
      || typeof event.item.text !== "string") return [];
    return [event.item.text];
  });
  assert.equal(rootMessages.at(-1)?.trim(), rootFinalMarker);
  const bundleRoot = oneTraceBundle(traceRoot);
  runSync(
    input.codex.command,
    [...input.codex.argsPrefix, "debug", "trace-reduce", bundleRoot],
    `${input.mode}/${input.shape} trace reduce`,
    environment,
    scenarioRoot,
  );
  return analyzeScenarioRoot(scenarioRoot, input.mode, input.shape);
}

export function analyzeScenarioRoot(
  scenarioRootValue: string,
  mode: ExecutorCarrierMode,
  shape: ExecutorCarrierShape,
): ExecutorCarrierCaseResultV1[] {
  const scenarioRoot = path.resolve(scenarioRootValue);
  const traceRoot = path.join(scenarioRoot, "trace");
  const ledgerRoot = path.join(scenarioRoot, "ledger");
  const responses = readJsonLines(path.join(ledgerRoot, "responses.jsonl"));
  const acknowledgements = readJsonLines(path.join(ledgerRoot, "acks.jsonl"));
  const bundleRoot = oneTraceBundle(traceRoot);
  const directTrace = mode === "direct_result" ? extractDirectTracePayloads(bundleRoot) : new Map<number, string>();
  const programOutput = mode === "program_output" ? extractProgramOutput(bundleRoot) : new Map<number, JsonObject>();
  const cases: ExecutorCarrierCaseResultV1[] = [];
  for (const tier of EXECUTOR_CARRIER_TIERS) {
    const response = responses.find((value) => value.tier_bytes === tier && value.shape === shape);
    const ack = acknowledgements.find((value) => value.tier_bytes === tier && value.shape === shape);
    const rawText = directTrace.get(tier);
    const programCase = programOutput.get(tier);
    const rawTailComplete = mode === "direct_result"
      ? (() => {
          if (!rawText) return false;
          try {
            return parseCarrierPayloadText(rawText).tail_sentinel === `M2_${shape.toUpperCase()}_${tier}_TAIL`;
          } catch {
            return false;
          }
        })()
      : programCase?.tail_complete === true;
    const structureClosed = mode === "direct_result"
      ? (() => {
          if (!rawText) return false;
          try {
            parseCarrierPayloadText(rawText);
            return true;
          } catch {
            return false;
          }
        })()
      : programCase?.structure_closed === true;
    const exactResultBytes = response?.serialized_result_bytes === tier ? tier : null;
    const modelAckComplete = ack?.tail_complete === true && ack.structure_closed === true;
    const passed = exactResultBytes === tier && rawTailComplete && structureClosed && modelAckComplete;
    cases.push({
      mode,
      shape,
      tier_bytes: tier,
      status: passed ? "passed" : "failed",
      exact_result_bytes: exactResultBytes,
      raw_tail_complete: rawTailComplete,
      structure_closed: structureClosed,
      model_ack_complete: modelAckComplete,
      failure_kind: passed
        ? null
        : !response
          ? "host_rejected"
          : !rawTailComplete || !structureClosed
            ? "trace_incomplete"
            : "model_ack_missing",
    });
    if (!passed) break;
  }
  return cases;
}

function emitEvidence(
  hostRelease: string,
  cases: readonly ExecutorCarrierCaseResultV1[],
  evidenceOut: string | undefined,
): void {
  const evidence = buildCarrierCapacityEvidence(hostRelease, cases);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assert(!/M2_(?:ASCII|CJK)_\d+_(?:HEAD|TAIL)|"body"|"pad"|hash|digest/u.test(serialized));
  if (evidenceOut) {
    mkdirSync(path.dirname(evidenceOut), { recursive: true });
    writeFileSync(evidenceOut, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

async function main(): Promise<void> {
  const codex = resolveCodexInvocation(argumentValue("--codex-command"));
  const evidenceOutValue = argumentValue("--evidence-out");
  const evidenceOut = evidenceOutValue
    ? path.resolve(repoRoot, evidenceOutValue)
    : undefined;
  const existingScenarios = argumentValue("--analyze-existing");
  if (existingScenarios) {
    const hostRelease = runSync(
      codex.command,
      [...codex.argsPrefix, "--version"],
      "Codex version preflight",
      process.env,
      repoRoot,
    ).stdout.trim();
    const cases: ExecutorCarrierCaseResultV1[] = [];
    for (const mode of ["direct_result", "program_output"] as const) {
      for (const shape of EXECUTOR_CARRIER_SHAPES) {
        cases.push(...analyzeScenarioRoot(
          path.join(path.resolve(existingScenarios), `${mode}-${shape}`),
          mode,
          shape,
        ));
      }
    }
    emitEvidence(hostRelease, cases, evidenceOut);
    return;
  }
  const codexHome = path.resolve(argumentValue("--codex-home", true) as string);
  assert(existsSync(path.join(codexHome, "auth.json")), "isolated CODEX_HOME is missing auth.json");
  assert.deepEqual(readdirSync(codexHome).sort(), ["auth.json"], "isolated CODEX_HOME must start with auth.json only");
  const container = mkdtempSync(path.join(tmpdir(), "understand-book-m2-carrier-"));
  const marketplaceRoot = path.join(container, "marketplace");
  const stagingRoot = path.join(container, "scenarios");
  mkdirSync(stagingRoot, { recursive: true });
  writeMarketplace(marketplaceRoot);
  const baseEnvironment = { ...process.env, CODEX_HOME: codexHome, NO_COLOR: "1" };
  const hostRelease = runSync(
    codex.command,
    [...codex.argsPrefix, "--version"],
    "Codex version preflight",
    baseEnvironment,
    stagingRoot,
  ).stdout.trim();
  assert.match(hostRelease, /^codex-cli 0\.149\./u);
  runSync(
    codex.command,
    [...codex.argsPrefix, "plugin", "marketplace", "add", marketplaceRoot, "--json"],
    "carrier marketplace install",
    baseEnvironment,
    stagingRoot,
  );
  runSync(
    codex.command,
    [...codex.argsPrefix, "plugin", "add", `${pluginName}@${pluginName}`, "--json"],
    "carrier plugin install",
    baseEnvironment,
    stagingRoot,
  );
  const inventory = JSON.parse(runSync(
    codex.command,
    [...codex.argsPrefix, "mcp", "get", serverName, "--json"],
    "carrier MCP inventory",
    baseEnvironment,
    stagingRoot,
  ).stdout) as { enabled?: boolean; enabled_tools?: string[] };
  assert.equal(inventory.enabled, true);
  assert.deepEqual(inventory.enabled_tools, [directReadTool, ackTool]);
  const cases: ExecutorCarrierCaseResultV1[] = [];
  for (const mode of ["direct_result", "program_output"] as const) {
    for (const shape of EXECUTOR_CARRIER_SHAPES) {
      cases.push(...await runScenario({
        codex,
        hostRelease,
        baseEnvironment,
        stagingRoot,
        mode,
        shape,
      }));
    }
  }
  emitEvidence(hostRelease, cases, evidenceOut);
}

if (process.argv.includes("--server")) {
  runCarrierServer();
} else if (path.resolve(process.argv[1] ?? "") === path.resolve(scriptPath)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
