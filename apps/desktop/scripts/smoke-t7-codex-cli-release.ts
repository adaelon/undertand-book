import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
import {
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
  validateBuildExecutorRoleConfigV3,
} from "../../../packages/core/src/build-executor-connection-capability";
import {
  BUILD_EXECUTOR_MCP_CONTRACT_V3,
  validateBuildExecutorSharedMcpConfigV3,
} from "../../../packages/core/src/build-executor-tool-adapter";
import { confirmedStandardBuildPlan } from "../../../packages/core/test/helpers/confirmed-build-plan";
import {
  analyzeR7RolloutTrace,
  readExecutorMcpServerTimingJsonl,
  reduceExecutorMcpTiming,
  ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE,
  type ExecutorMcpTimingJoinV1,
  type ExecutorTraceOperation,
  type R7RolloutTraceAnalysis,
} from "./r7-rollout-trace";

type JsonObject = Record<string, unknown>;
type AutomaticBuildTarget = ReturnType<typeof resolveAutomaticBuildTarget>;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CodexInvocation {
  command: string;
  argsPrefix: string[];
}

interface SyntheticFixture {
  target: AutomaticBuildTarget;
  opaqueHandoffRef: string;
  sentinel: string;
}

interface CodexScenarioOptions {
  name: string;
  codex: CodexInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  traceRoot: string;
  prompt: string;
  finalMarker: string;
  fixtures: readonly SyntheticFixture[];
  expectedDedicatedChildCount: number;
  timingRoot: string;
  syntheticBuildStepMarker?: string;
}

interface CodexScenarioResult {
  analysis: R7RolloutTraceAnalysis;
  executor_mcp_timing: ExecutorMcpTimingJoinV1 | null;
  executor_mcp_connection_count: number;
  durable: {
    semantic_attempts: number;
    committed_tasks: number;
  };
  root_event_count: number;
  root_final_marker_matched: true;
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
const pluginName = "understand-book";
const executorServerName = "understand_book_build_executor";
const executorAgentRole = "understand_book_executor";
const executorToolNames = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
] as const satisfies readonly ExecutorTraceOperation[];
const singleRootFinalMarker = "R7_SINGLE_CHILD_TERMINAL_DURABLE_REREAD_COMPLETE";
const parallelRootFinalMarker = "R7_THREE_SLOT_FIRST_TERMINAL_REFILL_COMPLETE";
const syntheticBuildStepMarker = "r7-synthetic-dispatch-next.mjs";

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

function hasArgument(name: string): boolean {
  const first = process.argv.indexOf(name);
  if (first < 0) return false;
  assert.equal(process.argv.indexOf(name, first + 1), -1, `${name} may appear only once`);
  return true;
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
      reject(new Error("isolated Codex CLI R7 smoke exceeded 15 minutes"));
    }, 900_000);
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
    assert(existsSync(resolved), `Codex command is missing: ${resolved}`);
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

function pathIsOutside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function createFixture(
  container: string,
  registryRoot: string,
  label: string,
  sentinel: string,
  contextRepeats: number,
): SyntheticFixture {
  const root = path.join(container, `synthetic-book-${label}`);
  mkdirSync(root, { recursive: true });
  const source = path.join(root, `${label}.md`);
  writeFileSync(
    source,
    `# R7 synthetic ${label} ${sentinel}\n\n${"bounded synthetic context ".repeat(contextRepeats)}\n`,
    "utf8",
  );
  const buildPlan = confirmedStandardBuildPlan(source, root);
  const plan = automaticBuildPlan(source, root, {
    requested_workers: 1,
    available_agent_slots: 1,
    build_plan: buildPlan,
  });
  assert(plan.preflight, `R7 fixture ${label} must produce a preflight`);
  const opaqueHandoffRef = (() => {
    const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registryRoot;
    try {
      const next = automaticBuildNext(source, root, 1, {
        accepted_plan_digest: plan.preflight.descriptor_plan_digest,
        available_agent_slots: 1,
        executor_dispatches: true,
        build_plan: buildPlan,
      });
      assert("dispatches" in next.action && next.action.dispatches, `R7 fixture ${label} must dispatch`);
      const envelope = next.action.dispatches[0];
      assert(envelope, `R7 fixture ${label} must produce one executor envelope`);
      return envelope.opaque_handoff_ref;
    } finally {
      if (previousRegistryRoot === undefined) {
        delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      } else {
        process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
      }
    }
  })();
  return {
    target: resolveAutomaticBuildTarget(source, root),
    opaqueHandoffRef,
    sentinel,
  };
}

function attemptSummary(target: AutomaticBuildTarget): {
  semantic_attempts: number;
  committed_tasks: number;
} {
  const snapshot = readAutomaticBuildAttemptSnapshot(target);
  const snapshots = Object.values(snapshot.stages).flatMap((stage) => Object.values(stage));
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
    semantic_attempts: snapshots.reduce((sum, current) => sum + current.semantic_attempt, 0),
    committed_tasks: committedTasks,
  };
}

function attemptDiagnosticSummary(target: AutomaticBuildTarget) {
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

function installThinPlugin(
  codex: CodexInvocation,
  env: NodeJS.ProcessEnv,
  cwd: string,
  marketplaceRoot: string,
): { installedPluginRoot: string; marketplaceName: string; version: string } {
  const marketplace = JSON.parse(runSync(
    codex.command,
    [...codex.argsPrefix, "plugin", "marketplace", "add", marketplaceRoot, "--json"],
    "isolated marketplace installation",
    env,
    cwd,
  ).stdout) as { marketplaceName?: string; installedRoot?: string; alreadyAdded?: boolean };
  assert.equal(marketplace.marketplaceName, pluginName);
  assert.equal(path.resolve(marketplace.installedRoot ?? ""), marketplaceRoot);
  assert.equal(marketplace.alreadyAdded, false);

  const installed = JSON.parse(runSync(
    codex.command,
    [...codex.argsPrefix, "plugin", "add", `${pluginName}@${marketplace.marketplaceName}`, "--json"],
    "isolated thin-plugin installation",
    env,
    cwd,
  ).stdout) as {
    name?: string;
    marketplaceName?: string;
    version?: string;
    installedPath?: string;
  };
  assert.equal(installed.name, pluginName);
  assert.equal(installed.marketplaceName, marketplace.marketplaceName);
  assert.match(installed.version ?? "", /^0\.1\.0\+codex\./u);
  const installedPluginRoot = path.resolve(installed.installedPath ?? "");
  assert(pathIsOutside(repoRoot, installedPluginRoot), "installed plugin root must be outside source cwd");
  assert(existsSync(path.join(installedPluginRoot, ".codex-plugin", "plugin.json")));
  return {
    installedPluginRoot,
    marketplaceName: marketplace.marketplaceName,
    version: installed.version as string,
  };
}

function compiledExecutorToolInventory(
  sidecar: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string[] {
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const compiledSmoke = path.join(scriptDir, "smoke-t7-executor-release.ts");
  const result = runSync(
    process.execPath,
    [tsxCli, compiledSmoke, "--sidecar", sidecar],
    "compiled Executor tools/list gate",
    env,
    cwd,
    180_000,
  );
  const evidence = JSON.parse(result.stdout) as { status?: string; tool_inventory?: string[] };
  assert.equal(evidence.status, "passed");
  assert.deepEqual(evidence.tool_inventory, executorToolNames);
  return [...(evidence.tool_inventory ?? [])];
}

function writeParallelBuildStepDriver(
  stagingWorkspace: string,
  fixtures: readonly SyntheticFixture[],
): void {
  assert.equal(fixtures.length, 4);
  const actionFor = (selected: readonly SyntheticFixture[]) => ({
    version: "r7_synthetic_build_step_result.v1",
    action: {
      kind: "SPAWN_EXECUTORS",
      dispatches: selected.map((fixture, index) => ({
        task_name: `r7_parallel_executor_${fixtures.indexOf(fixture) + 1}`,
        ordinal: fixtures.indexOf(fixture) + 1,
        opaque_handoff_ref: fixture.opaqueHandoffRef,
        expected_provider: executorAgentRole,
        local_index: index,
      })),
    },
  });
  const actions = {
    initial: actionFor(fixtures.slice(0, 3)),
    refill: actionFor(fixtures.slice(3)),
    done: {
      version: "r7_synthetic_build_step_result.v1",
      action: { kind: "DONE" },
    },
  };
  const source = [
    `const actions = ${JSON.stringify(actions, null, 2)};`,
    "if (process.argv.length !== 3) { process.stderr.write('R7 synthetic dispatch requires exactly one phase\\n'); process.exit(2); }",
    "const phase = process.argv[2];",
    "const selected = actions[phase];",
    "if (!selected) { process.stderr.write('unknown R7 synthetic build.step phase\\n'); process.exit(2); }",
    "process.stdout.write(`${JSON.stringify(selected)}\\n`);",
    "",
  ].join("\n");
  writeFileSync(path.join(stagingWorkspace, syntheticBuildStepMarker), source, "utf8");
}

function writeTimingCaptureBuildWrapper(options: {
  stagingWorkspace: string;
  name: string;
  sidecar: string;
  timingRoot: string;
}): string {
  const wrapper = path.join(options.stagingWorkspace, `m1-build-executor-timing-${options.name}.cmd`);
  writeFileSync(wrapper, [
    "@echo off",
    "setlocal",
    "for /f \"delims=\" %%I in ('powershell.exe -NoProfile -NonInteractive -Command \"[guid]::NewGuid().ToString()\"') do set \"M1_CONNECTION_ID=%%I\"",
    "if not defined M1_CONNECTION_ID exit /b 2",
    `\"${options.sidecar}\" %* 2>\"${options.timingRoot}\\%M1_CONNECTION_ID%.jsonl\"`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n"), "utf8");
  return wrapper;
}

function readServerTimingConnections(timingRoot: string) {
  const connections = readdirSync(timingRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const value = readFileSync(path.join(timingRoot, entry.name), "utf8");
      if (value.trim().length === 0) return [];
      return [readExecutorMcpServerTimingJsonl(value, `M1 connection ${entry.name}`)];
    });
  assert(connections.length > 0, "fixed Codex fixture captured no non-empty Executor timing connection");
  for (const samples of connections) {
    assert(samples.every((sample, index) => sample.connection_call_ordinal === index + 1));
  }
  return connections;
}

function installParallelBuildStepExecPolicy(
  codexHome: string,
  codex: CodexInvocation,
  env: NodeJS.ProcessEnv,
  cwd: string,
): void {
  const rulesRoot = path.join(codexHome, "rules");
  const rulePath = path.join(rulesRoot, "r7-synthetic-dispatch.rules");
  mkdirSync(rulesRoot, { recursive: true });
  writeFileSync(rulePath, [
    "prefix_rule(",
    `    pattern = ["node", ${JSON.stringify(syntheticBuildStepMarker)}, ["initial", "refill", "done"]],`,
    "    decision = \"allow\",",
    "    justification = \"Run only the bounded read-only R7 synthetic dispatch helper\",",
    "    match = [",
    `        "node ${syntheticBuildStepMarker} initial",`,
    `        "node ${syntheticBuildStepMarker} refill",`,
    `        "node ${syntheticBuildStepMarker} done",`,
    "    ],",
    "    not_match = [",
    `        "node ${syntheticBuildStepMarker} unknown",`,
    "        \"node another-script.mjs initial\",",
    "    ],",
    ")",
    "",
  ].join("\n"), "utf8");

  for (const phase of ["initial", "refill", "done"]) {
    const check = JSON.parse(runSync(
      codex.command,
      [
        ...codex.argsPrefix,
        "execpolicy",
        "check",
        "--pretty",
        "--rules",
        rulePath,
        "--",
        "node",
        syntheticBuildStepMarker,
        phase,
      ],
      `R7 synthetic dispatch exec-policy ${phase}`,
      env,
      cwd,
    ).stdout) as { decision?: string };
    assert.equal(check.decision, "allow", `R7 synthetic dispatch phase ${phase} is not policy-allowed`);
  }
}

function rootMessagesFrom(stdoutEvents: readonly JsonObject[]): string[] {
  return stdoutEvents.flatMap((event) => {
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ? event.item as JsonObject
      : undefined;
    return item?.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
  });
}

function oneTraceBundle(traceRoot: string): string {
  const entries = readdirSync(traceRoot, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    throw new Error(`${ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE}: expected one root trace bundle`);
  }
  const bundleRoot = path.join(traceRoot, entries[0].name);
  if (!existsSync(path.join(bundleRoot, "manifest.json")) || !existsSync(path.join(bundleRoot, "trace.jsonl"))) {
    throw new Error(`${ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE}: trace bundle is incomplete`);
  }
  return bundleRoot;
}

async function runCodexScenario(options: CodexScenarioOptions): Promise<CodexScenarioResult> {
  mkdirSync(options.traceRoot, { recursive: true });
  mkdirSync(options.timingRoot, { recursive: true });
  assert.deepEqual(readdirSync(options.traceRoot), [], `${options.name} trace root must start empty`);
  assert.deepEqual(readdirSync(options.timingRoot), [], `${options.name} timing root must start empty`);
  for (const fixture of options.fixtures) {
    assert.deepEqual(attemptSummary(fixture.target), { semantic_attempts: 0, committed_tasks: 0 });
  }

  const scenarioEnvironment = {
    ...options.env,
    CODEX_ROLLOUT_TRACE_ROOT: options.traceRoot,
  };
  const execResult = await runCodexExec(options.codex, [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--cd",
    options.cwd,
    options.prompt,
  ], scenarioEnvironment, options.cwd);
  assert.equal(execResult.code, 0, `${options.name} Codex task failed:\n${execResult.stderr}`);

  const stdoutEvents = jsonLines(execResult.stdout, `${options.name} codex exec JSONL`);
  assert(stdoutEvents.some((event) => event.type === "thread.started"));
  assert(stdoutEvents.some((event) => event.type === "turn.completed"));
  const rootMessages = rootMessagesFrom(stdoutEvents);
  assert.equal(rootMessages.at(-1)?.trim(), options.finalMarker);
  for (const sensitive of [
    ...options.fixtures.map((fixture) => fixture.sentinel),
    ...options.fixtures.map((fixture) => fixture.opaqueHandoffRef),
  ]) {
    assert(!execResult.stderr.includes(sensitive), `${options.name} stderr exposed a sensitive synthetic value`);
    assert(!rootMessages.some((message) => message.includes(sensitive)), `${options.name} root final exposed a value`);
  }
  assert(!rootMessages.some((message) => message.includes("candidate")));

  const summaries = options.fixtures.map((fixture) => attemptSummary(fixture.target));
  for (const [index, summary] of summaries.entries()) {
    assert.equal(
      summary.semantic_attempts,
      1,
      `real Codex executor child never accepted generation.start: ${JSON.stringify(
        attemptDiagnosticSummary(options.fixtures[index].target),
      )}`,
    );
    assert.equal(
      summary.committed_tasks,
      1,
      `real Codex executor child did not durably commit fixture ${index + 1}: ${JSON.stringify(
        attemptDiagnosticSummary(options.fixtures[index].target),
      )}`,
    );
  }

  const bundleRoot = oneTraceBundle(options.traceRoot);
  try {
    runSync(
      options.codex.command,
      [...options.codex.argsPrefix, "debug", "trace-reduce", bundleRoot],
      `${options.name} trace reducer`,
      scenarioEnvironment,
      options.cwd,
      120_000,
    );
  } catch (error) {
    throw new Error(`${ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE}: trace-reduce failed`, { cause: error });
  }
  if (!existsSync(path.join(bundleRoot, "state.json"))) {
    throw new Error(`${ROOT_EXECUTOR_BOUNDARY_UNVERIFIABLE}: reduced state is missing`);
  }
  const analysis = analyzeR7RolloutTrace({
    bundle_root: bundleRoot,
    executor_server_name: executorServerName,
    executor_tool_names: executorToolNames,
    executor_agent_role: executorAgentRole,
    expected_dedicated_child_count: options.expectedDedicatedChildCount,
    semantic_sentinels: options.fixtures.map((fixture) => fixture.sentinel),
    ...(options.syntheticBuildStepMarker
      ? { synthetic_build_step_marker: options.syntheticBuildStepMarker }
      : {}),
  });
  const serverTimingConnections = readServerTimingConnections(options.timingRoot);
  assert.equal(
    serverTimingConnections.length,
    options.expectedDedicatedChildCount,
    `${options.name} did not capture one timing connection per dedicated child`,
  );
  const executorMcpTiming = options.expectedDedicatedChildCount === 1
    ? reduceExecutorMcpTiming({
      connections: [{
        thread_id: analysis.dedicated_child_threads[0].thread_id,
        samples: serverTimingConnections[0],
      }],
      outer_samples: analysis.executor_outer_timing_samples,
    })
    : null;

  return {
    analysis,
    executor_mcp_timing: executorMcpTiming,
    executor_mcp_connection_count: serverTimingConnections.length,
    durable: {
      semantic_attempts: summaries.reduce((sum, summary) => sum + summary.semantic_attempts, 0),
      committed_tasks: summaries.reduce((sum, summary) => sum + summary.committed_tasks, 0),
    },
    root_event_count: stdoutEvents.length,
    root_final_marker_matched: true,
  };
}

function assertCommonTraceBoundary(result: CodexScenarioResult): void {
  assert.equal(result.analysis.thread_attribution_complete, true);
  assert.equal(result.analysis.root_executor_dispatch_attempt_count, 0);
  assert.equal(result.analysis.root_executor_backend_call_count, 0);
  assert.equal(result.analysis.other_child_executor_dispatch_attempt_count, 0);
  assert.equal(result.analysis.other_child_executor_backend_call_count, 0);
  assert.equal(result.analysis.child_executor_tool_count, 4);
  assert.deepEqual(result.analysis.child_executor_tools, [...executorToolNames].sort());
  assert.equal(result.analysis.first_child_dispatch, "executor.open");
  assert.equal(result.analysis.first_child_backend_call, "executor.open");
  assert(result.analysis.semantic_hit_shapes.executor_input_or_submit > 0);
  assert(result.analysis.semantic_hit_shapes.dedicated_child_inference > 0);
  assert(result.analysis.semantic_hit_shapes.bounded_response_only > 0);
}

async function main(): Promise<void> {
  const codexHome = path.resolve(argumentValue("--codex-home", true) as string);
  const marketplaceRoot = path.resolve(argumentValue("--marketplace-root") ?? repoRoot);
  const sidecar = path.resolve(argumentValue("--sidecar") ?? defaultSidecar);
  const evidenceOutValue = argumentValue("--evidence-out");
  const evidenceOut = evidenceOutValue ? path.resolve(evidenceOutValue) : undefined;
  const m1EvidenceOutValue = argumentValue("--m1-evidence-out");
  const m1EvidenceOut = m1EvidenceOutValue ? path.resolve(m1EvidenceOutValue) : undefined;
  const m1Only = hasArgument("--m1-only");
  const codex = resolveCodexInvocation(argumentValue("--codex-command"));

  assert(pathIsOutside(repoRoot, codexHome), "isolated CODEX_HOME must be outside the source repository");
  assert(existsSync(path.join(codexHome, "auth.json")), "isolated CODEX_HOME is missing auth.json");
  assert.deepEqual(
    readdirSync(codexHome).sort(),
    ["auth.json"],
    "isolated CODEX_HOME must start with auth.json only",
  );
  assert(existsSync(sidecar), `compiled Build Engine Sidecar is missing: ${sidecar}`);
  assert(existsSync(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json")));

  const container = mkdtempSync(path.join(tmpdir(), "understand-book-r7-codex-cli-"));
  const stagingWorkspace = path.join(container, "staging-workspace");
  const registryRoot = path.join(container, "driver-registry");
  mkdirSync(stagingWorkspace, { recursive: true });
  const singleTimingRoot = path.join(container, "timing-single");
  const parallelTimingRoot = path.join(container, "timing-parallel");
  const singleTimingCaptureBuildWrapper = writeTimingCaptureBuildWrapper({
    stagingWorkspace,
    name: "single",
    sidecar,
    timingRoot: singleTimingRoot,
  });
  const parallelTimingCaptureBuildWrapper = writeTimingCaptureBuildWrapper({
    stagingWorkspace,
    name: "parallel",
    sidecar,
    timingRoot: parallelTimingRoot,
  });
  const isolatedEnvironment = {
    ...process.env,
    CODEX_HOME: codexHome,
    UNDERSTAND_BOOK_BUILD_EXE: sidecar,
    UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: registryRoot,
    NO_COLOR: "1",
  };
  let completed = false;

  try {
    const preflightVersion = runSync(
      codex.command,
      [...codex.argsPrefix, "--version"],
      "Codex CLI version preflight",
      isolatedEnvironment,
      stagingWorkspace,
    ).stdout.trim();
    assert.match(preflightVersion, /^codex-cli 0\.149\./u, "R7 must execute the Codex 0.149 version family");

    const installation = installThinPlugin(
      codex,
      isolatedEnvironment,
      stagingWorkspace,
      marketplaceRoot,
    );
    const installedManifestPath = path.join(installation.installedPluginRoot, ".codex-plugin", "plugin.json");
    const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8")) as {
      name: string;
      version: string;
    };
    assert.deepEqual(installedManifest, {
      ...installedManifest,
      name: pluginName,
      version: installation.version,
    });

    const registrationScript = path.join(
      installation.installedPluginRoot,
      "scripts",
      "register-executor-agent.ps1",
    );
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
      source_state: string;
      target_version: string;
      backup: string | null;
      new_task_required: boolean;
    };
    assert.deepEqual(registrationReceipt, {
      source_state: "absent",
      target_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      backup: null,
      new_task_required: true,
    });
    const registeredAgentPath = path.join(codexHome, "agents", "understand-book-executor.toml");
    const installedAgentTemplatePath = path.join(
      installation.installedPluginRoot,
      "assets",
      "codex-agents",
      "understand-book-executor.toml",
    );
    assert.deepEqual(readFileSync(registeredAgentPath), readFileSync(installedAgentTemplatePath));
    const roleValidation = validateBuildExecutorRoleConfigV3(readFileSync(registeredAgentPath, "utf8"));
    assert.equal(roleValidation.mcp_servers_in_role, 0);
    assert.deepEqual(roleValidation.projected_role_reductions, ["shell_tool=false", "apps=false"]);

    const pluginList = JSON.parse(runSync(
      codex.command,
      [...codex.argsPrefix, "plugin", "list", "--json"],
      "isolated plugin inventory",
      isolatedEnvironment,
      stagingWorkspace,
    ).stdout) as { installed?: Array<{ name?: string; version?: string; enabled?: boolean }> };
    const installedPlugin = pluginList.installed?.find((plugin) => plugin.name === pluginName);
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
    assert(rootMcpInventory.some((server) => server.name === executorServerName));

    const rootMcpGet = JSON.parse(runSync(
      codex.command,
      [...codex.argsPrefix, "mcp", "get", executorServerName, "--json"],
      "isolated root MCP detail",
      isolatedEnvironment,
      stagingWorkspace,
    ).stdout) as {
      name?: string;
      enabled?: boolean;
      enabled_tools?: string[];
      startup_timeout_sec?: number;
      tool_timeout_sec?: number;
    };
    assert.equal(rootMcpGet.name, executorServerName);
    assert.equal(rootMcpGet.enabled, true);
    assert.deepEqual(rootMcpGet.enabled_tools, executorToolNames);
    assert.equal(rootMcpGet.startup_timeout_sec, 10);
    assert.equal(rootMcpGet.tool_timeout_sec, 120);

    const installedSharedMcp = validateBuildExecutorSharedMcpConfigV3(
      readFileSync(path.join(installation.installedPluginRoot, ".mcp.json"), "utf8"),
    );
    assert.deepEqual(installedSharedMcp.tool_names, executorToolNames);
    assert.equal(installedSharedMcp.required, false);
    assert.equal(installedSharedMcp.default_tools_approval_mode, "approve");
    assert.equal(BUILD_EXECUTOR_MCP_CONTRACT_V3.caller_role_authenticated, false);
    const compiledToolInventory = compiledExecutorToolInventory(
      sidecar,
      isolatedEnvironment,
      stagingWorkspace,
    );
    assert.deepEqual(compiledToolInventory, executorToolNames);

    const singleFixture = createFixture(
      container,
      registryRoot,
      "single",
      "R7_SINGLE_SYNTHETIC_SEMANTIC_SENTINEL",
      900,
    );
    const parallelFixtures = [
      createFixture(container, registryRoot, "parallel-1", "R7_PARALLEL_SYNTHETIC_SENTINEL_1", 250),
      createFixture(container, registryRoot, "parallel-2", "R7_PARALLEL_SYNTHETIC_SENTINEL_2", 1_800),
      createFixture(container, registryRoot, "parallel-3", "R7_PARALLEL_SYNTHETIC_SENTINEL_3", 1_800),
      createFixture(container, registryRoot, "parallel-4", "R7_PARALLEL_SYNTHETIC_SENTINEL_4", 900),
    ];
    writeParallelBuildStepDriver(stagingWorkspace, parallelFixtures);

    const singlePrompt = [
      "This is isolated R7 scenario B using synthetic data only.",
      "Do not read files, run shell commands, activate skills, call MCP tools from root, or inspect child content.",
      "Call spawn_agent exactly once. Use task_name=r7_single_executor, fork_turns=none, and ",
      "agent_type=understand_book_executor; do not substitute the agent type into task_name.",
      `The spawn message must tell that child to execute exactly this opaque handoff ref and no paths: `
        + `${singleFixture.opaqueHandoffRef}`,
      "Wait until that owned child becomes terminal. Do not quote or summarize its tool calls or semantic content.",
      `Then return exactly ${singleRootFinalMarker} and nothing else.`,
    ].join("\n");
    const single = await runCodexScenario({
      name: "R7 scenario B",
      codex,
      env: {
        ...isolatedEnvironment,
        UNDERSTAND_BOOK_BUILD_EXE: singleTimingCaptureBuildWrapper,
      },
      cwd: stagingWorkspace,
      traceRoot: path.join(container, "trace-single"),
      prompt: singlePrompt,
      finalMarker: singleRootFinalMarker,
      fixtures: [singleFixture],
      expectedDedicatedChildCount: 1,
      timingRoot: singleTimingRoot,
    });
    assertCommonTraceBoundary(single);
    assert(single.executor_mcp_timing, "single fixed fixture did not produce a server/outer timing join");
    assert.equal(single.analysis.max_live_dedicated_children, 1);
    assert.deepEqual(single.durable, { semantic_attempts: 1, committed_tasks: 1 });

    const overallTiming = Object.values(single.executor_mcp_timing.totals).reduce((total, operation) => ({
      call_count: total.call_count + operation.call_count,
      server_total_ms: total.server_total_ms + operation.server_total_ms,
      outer_total_ms: total.outer_total_ms + operation.outer_total_ms,
      residual_total_ms: total.residual_total_ms + operation.residual_total_ms,
      response_total_bytes: total.response_total_bytes + operation.response_total_bytes,
    }), {
      call_count: 0,
      server_total_ms: 0,
      outer_total_ms: 0,
      residual_total_ms: 0,
      response_total_bytes: 0,
    });
    const dominantComponent = overallTiming.server_total_ms > overallTiming.residual_total_ms
      ? "server"
      : overallTiming.residual_total_ms > overallTiming.server_total_ms
        ? "residual"
        : "equal";
    const m1Evidence = {
      version: "executor_mcp_fixed_timing_evidence.v1",
      status: "passed",
      codex_cli: preflightVersion,
      fixture: "isolated_single_synthetic_work_unit",
      connection_count: single.executor_mcp_connection_count,
      sample_count: single.executor_mcp_timing.samples.length,
      totals: single.executor_mcp_timing.totals,
      overall: overallTiming,
      observed_dominant_component: dominantComponent,
      next_branch: dominantComponent === "server"
        ? "M1b"
        : dominantComponent === "residual"
          ? "A1"
          : "M1b_and_A1_independent",
      durable: single.durable,
      thread_attribution_complete: single.analysis.thread_attribution_complete,
      semantic_trace_projection: single.analysis.semantic_hit_shapes,
    };
    const serializedM1Evidence = `${JSON.stringify(m1Evidence, null, 2)}\n`;
    for (const sensitive of [
      singleFixture.sentinel,
      singleFixture.opaqueHandoffRef,
      container,
      registryRoot,
      stagingWorkspace,
      codexHome,
      installation.installedPluginRoot,
      marketplaceRoot,
      repoRoot,
      sidecar,
    ]) {
      assert(!serializedM1Evidence.includes(sensitive), "M1 evidence serialized a private path, ref, or sentinel");
    }
    if (m1EvidenceOut) {
      mkdirSync(path.dirname(m1EvidenceOut), { recursive: true });
      writeFileSync(m1EvidenceOut, serializedM1Evidence, "utf8");
    }
    if (m1Only) {
      process.stdout.write(serializedM1Evidence);
      completed = true;
      return;
    }

    installParallelBuildStepExecPolicy(codexHome, codex, isolatedEnvironment, stagingWorkspace);
    const parallelPrompt = [
      "This is isolated R7 scenario C using four synthetic refs and no real book state.",
      "The root must never call, probe, enumerate, or diagnose any Executor MCP tool.",
      `Call the exact command node ${syntheticBuildStepMarker} initial once and parse only its JSON stdout.`,
      "For its three dispatches, call spawn_agent three times without waiting between spawns.",
      "For every spawn use the dispatch task_name, fork_turns=none, agent_type=understand_book_executor,",
      "and tell the child to execute exactly its opaque_handoff_ref and no path or adjacent state.",
      "Treat every wait_agent return only as a wake-up, never as terminal proof. After each wait_agent return,",
      "call list_agents and inspect the three initial task names; if none has status completed, wait again.",
      "Proceed as soon as list_agents reports at least one completed initial child; do not wait for the whole wave.",
      `Immediately call node ${syntheticBuildStepMarker} refill exactly once, then spawn its one returned child `
        + "with the same role and fork contract.",
      "For the final gate, maintain a cumulative terminal set while repeating wait_agent then list_agents.",
      "A completed status is terminal; a task previously reported running that disappears from a later complete",
      "list_agents live inventory is also terminal. Continue until all four owned task names are terminal.",
      "Do not quote or summarize their tools, content, or finals.",
      `Call node ${syntheticBuildStepMarker} done exactly once; require action.kind=DONE.`,
      `Then return exactly ${parallelRootFinalMarker} and nothing else.`,
    ].join("\n");
    const parallel = await runCodexScenario({
      name: "R7 scenario C",
      codex,
      env: {
        ...isolatedEnvironment,
        UNDERSTAND_BOOK_BUILD_EXE: parallelTimingCaptureBuildWrapper,
      },
      cwd: stagingWorkspace,
      traceRoot: path.join(container, "trace-parallel"),
      prompt: parallelPrompt,
      finalMarker: parallelRootFinalMarker,
      fixtures: parallelFixtures,
      expectedDedicatedChildCount: 4,
      timingRoot: parallelTimingRoot,
      syntheticBuildStepMarker,
    });
    assertCommonTraceBoundary(parallel);
    assert.deepEqual(parallel.durable, { semantic_attempts: 4, committed_tasks: 4 });
    assert.equal(parallel.analysis.max_live_dedicated_children, 3);
    assert.equal(parallel.analysis.fourth_child_started_after_first_terminal, true);
    assert.equal(parallel.analysis.fourth_child_started_before_last_initial_terminal, true);
    assert.equal(parallel.analysis.synthetic_build_step_call_count, 3);
    const initialThreads = parallel.analysis.dedicated_child_threads.slice(0, 3);
    const fourthThread = parallel.analysis.dedicated_child_threads[3];
    const [initialStep, refillStep, doneStep] = parallel.analysis.synthetic_build_step_started_seqs;
    assert(initialStep < initialThreads[0].started_seq);
    assert(parallel.analysis.first_partial_completion_observed_seq !== null);
    assert(parallel.analysis.first_partial_completion_observed_seq < refillStep);
    assert(refillStep < fourthThread.started_seq);
    assert(parallel.analysis.all_dedicated_terminal_observed_seq !== null);
    assert(parallel.analysis.all_dedicated_terminal_observed_seq < doneStep);

    const codexVersion = runSync(
      codex.command,
      [...codex.argsPrefix, "--version"],
      "Codex CLI version evidence",
      isolatedEnvironment,
      stagingWorkspace,
    ).stdout.trim();
    assert.match(codexVersion, /^codex-cli 0\.149\./u);

    const evidence = {
      version: "understand_book_root_shared_executor_evidence.v1",
      status: "passed",
      codex_cli: codexVersion,
      plugin: {
        name: installedManifest.name,
        version: installedManifest.version,
        installed_from_isolated_local_marketplace: true,
        enabled: true,
      },
      registration: {
        source_state: registrationReceipt.source_state,
        target_version: registrationReceipt.target_version,
        backup: registrationReceipt.backup,
        new_task_required: registrationReceipt.new_task_required,
        role_compatible: roleValidation.status === "compatible",
        role_local_mcp_server_count: roleValidation.mcp_servers_in_role,
        projected_role_reductions: roleValidation.projected_role_reductions,
      },
      root_inventory: {
        executor_server_present: true,
        cli_get_enabled_tools: rootMcpGet.enabled_tools,
        cli_get_startup_timeout_sec: rootMcpGet.startup_timeout_sec,
        cli_get_tool_timeout_sec: rootMcpGet.tool_timeout_sec,
        installed_static_required: installedSharedMcp.required,
        installed_static_default_tools_approval_mode: installedSharedMcp.default_tools_approval_mode,
        compiled_server_tools_list: compiledToolInventory,
        root_executor_tool_count: 4,
      },
      child_inventory: {
        inherited_parent_registration: true,
        role_local_mcp_server_count: 0,
        successful_backend_tools: single.analysis.child_executor_tools,
        child_executor_tool_count: single.analysis.child_executor_tool_count,
      },
      single_ref_durable_commit: {
        durable: single.durable,
        thread_attribution_complete: single.analysis.thread_attribution_complete,
        root_executor_dispatch_attempt_count: single.analysis.root_executor_dispatch_attempt_count,
        root_executor_backend_call_count: single.analysis.root_executor_backend_call_count,
        other_child_executor_dispatch_attempt_count: single.analysis.other_child_executor_dispatch_attempt_count,
        other_child_executor_backend_call_count: single.analysis.other_child_executor_backend_call_count,
        first_child_dispatch: single.analysis.first_child_dispatch,
        first_child_backend_call: single.analysis.first_child_backend_call,
        semantic_hit_shapes: single.analysis.semantic_hit_shapes,
        root_event_count: single.root_event_count,
        root_final_marker_matched: single.root_final_marker_matched,
      },
      m1_fixed_fixture_timing: {
        version: single.executor_mcp_timing.version,
        connection_count: single.executor_mcp_connection_count,
        sample_count: single.executor_mcp_timing.samples.length,
        totals: single.executor_mcp_timing.totals,
      },
      three_slot_first_terminal: {
        durable: parallel.durable,
        executor_mcp_connection_count: parallel.executor_mcp_connection_count,
        dedicated_child_count: parallel.analysis.dedicated_child_threads.length,
        max_live_dedicated_children: parallel.analysis.max_live_dedicated_children,
        fourth_child_started_after_first_terminal: parallel.analysis.fourth_child_started_after_first_terminal,
        fourth_child_started_before_last_initial_terminal:
          parallel.analysis.fourth_child_started_before_last_initial_terminal,
        first_partial_completion_observed_before_refill: true,
        all_dedicated_terminal_observed_before_done: true,
        synthetic_build_step_call_count: parallel.analysis.synthetic_build_step_call_count,
        root_executor_dispatch_attempt_count: parallel.analysis.root_executor_dispatch_attempt_count,
        root_executor_backend_call_count: parallel.analysis.root_executor_backend_call_count,
        other_child_executor_dispatch_attempt_count: parallel.analysis.other_child_executor_dispatch_attempt_count,
        other_child_executor_backend_call_count: parallel.analysis.other_child_executor_backend_call_count,
        first_child_dispatch: parallel.analysis.first_child_dispatch,
        first_child_backend_call: parallel.analysis.first_child_backend_call,
        semantic_hit_shapes: parallel.analysis.semantic_hit_shapes,
        root_event_count: parallel.root_event_count,
        root_final_marker_matched: parallel.root_final_marker_matched,
      },
      session_protocol: "automatic_build_executor_session.v3",
      capability_isolation: false,
      caller_role_authenticated: false,
      forbidden_digest_field_count: 0,
      budget_proof_is_freshness_identity: false,
    };
    const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
    for (const sensitive of [
      ...[singleFixture, ...parallelFixtures].map((fixture) => fixture.sentinel),
      ...[singleFixture, ...parallelFixtures].map((fixture) => fixture.opaqueHandoffRef),
      container,
      registryRoot,
      stagingWorkspace,
      codexHome,
      installation.installedPluginRoot,
      marketplaceRoot,
      repoRoot,
      sidecar,
    ]) {
      assert(!serializedEvidence.includes(sensitive), "R7 evidence serialized a private path, ref, or sentinel");
    }
    assert(!/(manifest_sha256|skill_sha256|compiled_sidecar_sha256|root_final_sha256|registration.*digest)/u
      .test(serializedEvidence));
    if (evidenceOut) {
      mkdirSync(path.dirname(evidenceOut), { recursive: true });
      writeFileSync(evidenceOut, serializedEvidence, "utf8");
    }
    process.stdout.write(serializedEvidence);
    completed = true;
  } finally {
    if (completed) {
      rmSync(container, { recursive: true, force: true });
    } else {
      process.stderr.write(`R7 synthetic fixture retained for diagnosis: ${container}\n`);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
