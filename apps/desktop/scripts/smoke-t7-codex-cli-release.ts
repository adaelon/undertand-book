import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listAutomaticBuildStoredAttempts,
  readAutomaticBuildAttemptSnapshot,
} from "../../../packages/core/src/automatic-build-task-store";
import {
  resolveAutomaticBuildTarget,
  type AutomaticBuildStage,
} from "../../../packages/core/src/build-orchestrator";
import {
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "../../../packages/core/test/helpers/confirmed-build-plan";

type JsonObject = Record<string, unknown>;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CodexInvocation {
  command: string;
  argsPrefix: string[];
}

interface TraceRecordShape {
  source: "codex_exec_stdout" | "persisted_jsonl";
  top_type: string | null;
  item_type: string | null;
  payload_type: string | null;
  contains_input_next: boolean;
  contains_submit_candidate: boolean;
}

type ExecutorTraceOperation = "input_next" | "submit_candidate";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const defaultSidecar = path.join(
  desktopRoot,
  "src-tauri",
  "binaries",
  "understand-book-build-x86_64-pc-windows-msvc.exe",
);
const semanticSentinel = "T7_CLI_SEMANTIC_INPUT_SENTINEL";
const rootFinalMarker = "T7_ROOT_CHILD_TERMINAL_DURABLE_REREAD_REQUIRED";
const executorServerName = "understand_book_build_executor";
const executorToolNames = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
] as const;

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
  timeout = 60_000,
): ProcessResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runCodexExec(
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
      reject(new Error("isolated Codex CLI semantic smoke exceeded 10 minutes"));
    }, 600_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      assert(stdout.length <= 16 * 1024 * 1024, "Codex CLI JSONL exceeded the bounded capture size");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      assert(stderr.length <= 4 * 1024 * 1024, "Codex CLI stderr exceeded the bounded capture size");
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

function resolveCodexInvocation(explicitCommand: string | undefined): CodexInvocation {
  if (explicitCommand) {
    const resolved = path.resolve(explicitCommand);
    return resolved.toLowerCase().endsWith(".js")
      ? { command: process.execPath, argsPrefix: [resolved] }
      : { command: resolved, argsPrefix: [] };
  }
  if (process.platform !== "win32") return { command: "codex", argsPrefix: [] };
  const discovered = spawnSync("where.exe", ["codex"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.ifError(discovered.error);
  assert.equal(discovered.status, 0, `where.exe codex failed: ${discovered.stderr}`);
  const commandShim = discovered.stdout.split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.toLowerCase().endsWith(".cmd") && existsSync(candidate));
  assert(commandShim, "Codex CLI Windows command shim was not found on PATH");
  const codexJs = path.join(
    path.dirname(commandShim),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  assert(existsSync(codexJs), `Codex CLI JavaScript entry was not found: ${codexJs}`);
  return { command: process.execPath, argsPrefix: [codexJs] };
}

function createFixture(container: string, registryRoot: string) {
  const root = path.join(container, "synthetic-book");
  mkdirSync(root, { recursive: true });
  const source = path.join(root, "synthetic.md");
  writeFileSync(
    source,
    `# T7 synthetic CLI fixture\n\n${semanticSentinel}\n${"bounded synthetic context ".repeat(900)}\n`,
    "utf8",
  );
  const buildPlan = confirmedStandardBuildPlan(source, root);
  const plan = automaticBuildPlan(source, root, {
    requested_workers: 1,
    available_agent_slots: 1,
    build_plan: buildPlan,
  });
  assert(plan.preflight, "T7 CLI fixture must produce a preflight");
  const next = (() => {
    const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registryRoot;
    try {
      return automaticBuildNext(source, root, 1, {
        accepted_plan_digest: plan.preflight.plan_digest,
        available_agent_slots: 1,
        executor_dispatches: true,
        build_plan: buildPlan,
      });
    } finally {
      if (previousRegistryRoot === undefined) {
        delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      } else {
        process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
      }
    }
  })();
  assert("dispatches" in next.action && next.action.dispatches, "T7 CLI fixture must produce a dispatch");
  const envelope = next.action.dispatches[0];
  assert(envelope, "T7 CLI fixture must produce one executor envelope");
  return {
    target: resolveAutomaticBuildTarget(source, root),
    opaqueHandoffRef: envelope.opaque_handoff_ref,
  };
}

function attemptSummary(target: ReturnType<typeof resolveAutomaticBuildTarget>): {
  semantic_attempts: number;
  committed_tasks: number;
} {
  const snapshot = readAutomaticBuildAttemptSnapshot(target);
  const snapshots = Object.values(snapshot.stages)
    .flatMap((stage) => Object.values(stage));
  const committedTasks = (Object.keys(snapshot.stages) as AutomaticBuildStage[])
    .flatMap((stage) => listAutomaticBuildStoredAttempts(target, stage))
    .filter((attempt) => {
      const resultPath = path.join(attempt.attempt_dir, "result.json");
      if (!existsSync(resultPath)) return false;
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
        version?: string;
        outcome?: string;
      };
      return result.version === "automatic_build_attempt_event.v3" && result.outcome === "success";
    }).length;
  return {
    semantic_attempts: snapshots.reduce((sum, snapshot) => sum + snapshot.semantic_attempt, 0),
    committed_tasks: committedTasks,
  };
}

function attemptDiagnosticSummary(target: ReturnType<typeof resolveAutomaticBuildTarget>) {
  const snapshot = readAutomaticBuildAttemptSnapshot(target);
  return Object.entries(snapshot.stages).flatMap(([stage, units]) => (
    Object.entries(units).map(([workUnitId, unit]) => ({
      stage,
      work_unit_id: workUnitId,
      semantic_attempt: unit.semantic_attempt,
      lease_epoch: unit.lease_epoch,
      failures: unit.failures,
      submit_revision: unit.submit_revision,
      ...(unit.last_failure_diagnostic
        ? { last_failure_diagnostic: unit.last_failure_diagnostic }
        : {}),
    }))
  ));
}

function jsonLines(value: string, label: string): JsonObject[] {
  return value.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      assert(parsed && typeof parsed === "object" && !Array.isArray(parsed));
      return parsed as JsonObject;
    } catch (error) {
      throw new Error(`${label} line ${index + 1} was not JSON: ${String(error)}`);
    }
  });
}

function recursiveFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...recursiveFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

function traceCallId(record: JsonObject): string | undefined {
  const item = record.item && typeof record.item === "object" && !Array.isArray(record.item)
    ? record.item as JsonObject
    : undefined;
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as JsonObject
    : undefined;
  for (const value of [payload?.call_id, item?.call_id, record.call_id]) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function executorTraceOperation(record: JsonObject): ExecutorTraceOperation | undefined {
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as JsonObject
    : undefined;
  const invocation = payload?.invocation
    && typeof payload.invocation === "object"
    && !Array.isArray(payload.invocation)
    ? payload.invocation as JsonObject
    : undefined;
  if (invocation?.tool === "executor.input.next") return "input_next";
  if (invocation?.tool === "executor.submit_candidate") return "submit_candidate";
  const serialized = JSON.stringify(record);
  if (serialized.includes("executor.input.next") || serialized.includes("executor_input_next")) {
    return "input_next";
  }
  if (serialized.includes("executor.submit_candidate") || serialized.includes("executor_submit_candidate")) {
    return "submit_candidate";
  }
  return undefined;
}

function recordShape(
  source: TraceRecordShape["source"],
  record: JsonObject,
  operation = executorTraceOperation(record),
): TraceRecordShape {
  const item = record.item && typeof record.item === "object" && !Array.isArray(record.item)
    ? record.item as JsonObject
    : undefined;
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as JsonObject
    : undefined;
  return {
    source,
    top_type: typeof record.type === "string" ? record.type : null,
    item_type: typeof item?.type === "string" ? item.type : null,
    payload_type: typeof payload?.type === "string" ? payload.type : null,
    contains_input_next: operation === "input_next",
    contains_submit_candidate: operation === "submit_candidate",
  };
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main(): Promise<void> {
  const codexHome = path.resolve(argumentValue("--codex-home", true) as string);
  const installedPluginRoot = path.resolve(argumentValue("--installed-plugin-root", true) as string);
  const sidecar = path.resolve(argumentValue("--sidecar") ?? defaultSidecar);
  const evidenceOutValue = argumentValue("--evidence-out");
  const evidenceOut = evidenceOutValue ? path.resolve(evidenceOutValue) : undefined;
  const codex = resolveCodexInvocation(argumentValue("--codex-command"));
  assert(existsSync(path.join(codexHome, "auth.json")), "isolated CODEX_HOME is missing auth.json");
  assert(existsSync(sidecar), `compiled Build Engine Sidecar is missing: ${sidecar}`);
  const installedManifestPath = path.join(installedPluginRoot, ".codex-plugin", "plugin.json");
  assert(existsSync(installedManifestPath), "installed plugin manifest is missing");
  const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8")) as {
    name: string;
    version: string;
  };
  assert.equal(installedManifest.name, "understand-book");

  const container = mkdtempSync(path.join(tmpdir(), "understand-book-t7-codex-cli-"));
  const stagingWorkspace = path.join(container, "staging-workspace");
  const registryRoot = path.join(container, "driver-registry");
  mkdirSync(stagingWorkspace, { recursive: true });
  const isolatedEnvironment = {
    ...process.env,
    CODEX_HOME: codexHome,
    UNDERSTAND_BOOK_BUILD_EXE: sidecar,
    UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: registryRoot,
    NO_COLOR: "1",
  };
  try {
    const registrationScript = path.join(installedPluginRoot, "scripts", "register-executor-agent.ps1");
    const registration = runSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        registrationScript,
        "-Scope",
        "personal",
      ],
      "installed custom-agent registration",
      isolatedEnvironment,
      stagingWorkspace,
    );
    const registrationReceipt = JSON.parse(registration.stdout.trim()) as {
      digest: string;
      scope: string;
      target: string;
      activation: string;
    };
    assert.equal(registrationReceipt.scope, "personal");
    assert.equal(
      path.resolve(registrationReceipt.target),
      path.join(codexHome, "agents", "understand-book-executor.toml"),
    );
    assert.equal(registrationReceipt.activation, "new_task_required");
    assert.match(registrationReceipt.digest, /^[a-f0-9]{64}$/u);

    const pluginList = JSON.parse(runSync(
      codex.command,
      [...codex.argsPrefix, "plugin", "list", "--json"],
      "isolated plugin inventory",
      isolatedEnvironment,
      stagingWorkspace,
    ).stdout) as { installed?: Array<{ name?: string; version?: string; enabled?: boolean }> };
    const installedPlugin = pluginList.installed?.find((plugin) => plugin.name === "understand-book");
    assert(installedPlugin, "isolated Codex CLI did not report the installed understand-book plugin");
    assert.equal(installedPlugin.version, installedManifest.version);
    assert.equal(installedPlugin.enabled, true);

    const rootMcpInventory = JSON.parse(runSync(
      codex.command,
      [...codex.argsPrefix, "mcp", "list", "--json"],
      "isolated root MCP inventory",
      isolatedEnvironment,
      stagingWorkspace,
    ).stdout) as Array<{ name?: string }>;
    const rootInventoryText = JSON.stringify(rootMcpInventory);
    assert(!rootInventoryText.includes(executorServerName));
    for (const toolName of executorToolNames) assert(!rootInventoryText.includes(toolName));

    const fixture = createFixture(container, registryRoot);
    assert.deepEqual(attemptSummary(fixture.target), { semantic_attempts: 0, committed_tasks: 0 });
    const traceStartedAt = Date.now();
    const prompt = [
      "This is an isolated T7 release smoke using synthetic data only.",
      "Do not read files, run shell commands, activate skills, call MCP tools from root, or inspect child content.",
      "Call spawn_agent exactly once. Use task_name=t7_cli_executor, fork_turns=none, and "
        + "agent_type=understand_book_executor; do not substitute the agent type into task_name.",
      `The spawn message must tell that child to execute exactly this opaque handoff ref and no paths: `
        + `${fixture.opaqueHandoffRef}`,
      "Wait until that owned child becomes terminal. Do not quote or summarize its tool calls or semantic content.",
      `Then return exactly ${rootFinalMarker} and nothing else.`,
    ].join("\n");
    const execResult = await runCodexExec(codex, [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--cd",
      stagingWorkspace,
      prompt,
    ], isolatedEnvironment, stagingWorkspace);
    assert.equal(execResult.code, 0, `isolated Codex CLI semantic smoke failed:\n${execResult.stderr}`);
    assert(!execResult.stderr.includes(semanticSentinel));
    const stdoutEvents = jsonLines(execResult.stdout, "codex exec JSONL");
    assert(stdoutEvents.some((event) => event.type === "thread.started"));
    assert(stdoutEvents.some((event) => event.type === "turn.completed"));
    const rootMessages = stdoutEvents.flatMap((event) => {
      const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? event.item as JsonObject
        : undefined;
      return item?.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
    });
    assert.equal(rootMessages.at(-1)?.trim(), rootFinalMarker);

    const durable = attemptSummary(fixture.target);
    assert(durable.semantic_attempts > 0, "real Codex executor child never accepted generation.start");
    assert(
      durable.committed_tasks > 0,
      `real Codex executor child did not durably commit a synthetic task: `
        + `${JSON.stringify(attemptDiagnosticSummary(fixture.target))}`,
    );

    const persistedJsonl = recursiveFiles(codexHome).filter((file) => (
      file.toLowerCase().endsWith(".jsonl") && statSync(file).mtimeMs >= traceStartedAt - 2_000
    ));
    const persistedRecords = persistedJsonl.flatMap((file) => (
      readFileSync(file, "utf8").split(/\r?\n/u).filter((line) => line.trim().length > 0).flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? [{ file, record: parsed as JsonObject }]
            : [];
        } catch {
          return [];
        }
      })
    ));
    const traceRecords = [
      ...stdoutEvents.map((record) => ({ source: "codex_exec_stdout" as const, record })),
      ...persistedRecords.map(({ record }) => ({ source: "persisted_jsonl" as const, record })),
    ];
    const operationByCallId = new Map<string, ExecutorTraceOperation>();
    for (const { record } of traceRecords) {
      const callId = traceCallId(record);
      const operation = executorTraceOperation(record);
      if (!callId || !operation) continue;
      const existing = operationByCallId.get(callId);
      assert(!existing || existing === operation, `trace call ${callId} changed executor operation`);
      operationByCallId.set(callId, operation);
    }
    const shapeFor = (source: TraceRecordShape["source"], record: JsonObject) => recordShape(
      source,
      record,
      executorTraceOperation(record) ?? operationByCallId.get(traceCallId(record) ?? ""),
    );
    const semanticHitShapes = traceRecords.flatMap(({ source, record }) => (
      JSON.stringify(record).includes(semanticSentinel) ? [shapeFor(source, record)] : []
    ));
    const submitRequestShapes = traceRecords.flatMap(({ source, record }) => {
      const serialized = JSON.stringify(record);
      const operation = executorTraceOperation(record) ?? operationByCallId.get(traceCallId(record) ?? "");
      return operation === "submit_candidate" && serialized.includes("candidate")
        ? [recordShape(source, record, operation)]
        : [];
    });
    assert(semanticHitShapes.length > 0, "real Codex trace did not retain the synthetic child input marker");
    assert(submitRequestShapes.length > 0, "real Codex trace did not retain a child submit_candidate request");
    assert(semanticHitShapes.some((shape) => shape.contains_input_next));
    assert(semanticHitShapes.every((shape) => shape.contains_input_next || shape.contains_submit_candidate));
    assert(submitRequestShapes.every((shape) => shape.contains_submit_candidate));
    assert(!rootMessages.some((message) => message.includes(semanticSentinel) || message.includes("candidate")));

    const evidence = {
      version: "understand_book_t7_codex_cli_release_evidence.v1",
      status: "passed",
      codex_cli: runSync(
        codex.command,
        [...codex.argsPrefix, "--version"],
        "Codex CLI version",
        isolatedEnvironment,
        stagingWorkspace,
      ).stdout.trim(),
      plugin: {
        name: installedManifest.name,
        version: installedManifest.version,
        manifest_sha256: createHash("sha256").update(readFileSync(installedManifestPath)).digest("hex"),
      },
      registration: {
        scope: registrationReceipt.scope,
        activation: registrationReceipt.activation,
        digest: registrationReceipt.digest,
      },
      root_inventory: {
        server_names: rootMcpInventory.map((server) => server.name).filter(Boolean).sort(),
        executor_server_present: false,
        executor_tool_intersection: [],
      },
      semantic_smoke: {
        durable,
        root_final_sha256: canonicalSha256(rootMessages.at(-1)),
        root_event_count: stdoutEvents.length,
        persisted_jsonl_files: persistedJsonl.length,
      },
      trace_allowlist: {
        semantic_marker_records: semanticHitShapes,
        candidate_submit_records: submitRequestShapes,
        root_final_sensitive_hits: 0,
        stderr_sensitive_hits: 0,
      },
    };
    const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
    assert(!serializedEvidence.includes(semanticSentinel));
    assert(!serializedEvidence.includes(fixture.opaqueHandoffRef));
    assert(!serializedEvidence.includes(container));
    assert(!serializedEvidence.includes(codexHome));
    if (evidenceOut) {
      mkdirSync(path.dirname(evidenceOut), { recursive: true });
      writeFileSync(evidenceOut, serializedEvidence, "utf8");
    }
    process.stdout.write(serializedEvidence);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
