import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirmedStandardBuildPlan } from "../../../packages/core/test/helpers/confirmed-build-plan";
import { resolveAutomaticBuildTarget } from "../../../packages/core/src/build-orchestrator";
import { readAutomaticBuildAttemptSnapshot } from "../../../packages/core/src/automatic-build-task-store";
import type { AutomaticBuildStepResponseV1 } from "../../../skills/build/automatic-build-driver";
import type { AutomaticBuildExecutorSessionResponseV3 } from "../../../packages/core/src/automatic-build-executor-session";
import { executorMcpInvocation, JsonLineMcpClient } from "./smoke-t7-executor-release";

// A bounded compiled-process recovery canary. The model/host lifecycle is a separate release gate.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sidecar = path.resolve(process.argv[2] ?? path.join(repoRoot,
  "apps/desktop/src-tauri/binaries/understand-book-build-x86_64-pc-windows-msvc.exe"));
const evidenceOut = path.resolve(process.argv[3] ?? path.join(repoRoot,
  "docs/performance/understand-book-v1-recovery.json"));
const installedPluginRoot = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
const root = mkdtempSync(path.join(tmpdir(), "understand-book-v1-recovery-"));
const registry = path.join(root, "registry");
const source = path.join(root, "recovery.md");
writeFileSync(source, `# Recovery\n\n${Array.from({ length: 900 }, (_, i) =>
  `Paragraph ${i + 1} describes stable synthetic evidence for recovery.`).join("\n\n")}`);
const planPath = path.join(root, "plan.json");
writeFileSync(planPath, JSON.stringify(confirmedStandardBuildPlan(source, root)));
const target = resolveAutomaticBuildTarget(source, root);
const stepTimes: number[] = [];
const run = (request: unknown) => {
  const started = performance.now();
  const result = spawnSync(sidecar, ["build.step"], { cwd: root, windowsHide: true,
    env: { ...process.env, UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: registry },
    input: JSON.stringify(request), encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  stepTimes.push(performance.now() - started);
  return JSON.parse(result.stdout);
};
const invocation = run({ version: "automatic_build_invocation_create.v1", target_input: source,
  root_dir: root, build_plan_path: planPath, quality_profile: "full", max_parallel: 3,
  created_at: new Date().toISOString() });
const step = (extra = {}): AutomaticBuildStepResponseV1 => run({ version: "automatic_build_step_request.v1",
  invocation_ref: invocation.invocation_ref, available_agent_slots: 3, ...extra });
const launches = (response: AutomaticBuildStepResponseV1) => {
  assert.equal(response.action.kind, "SPAWN_EXECUTORS");
  if (response.action.kind !== "SPAWN_EXECUTORS") throw new Error("expected launch");
  return response.action.executors;
};
const attemptCount = () => Object.values(readAutomaticBuildAttemptSnapshot(target).stages)
  .flatMap(stage => Object.values(stage)).reduce((sum, unit) => sum + unit.semantic_attempt, 0);
const committedBytes = () => {
  const files = new Map<string, Buffer>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === "result.json" && JSON.parse(readFileSync(file, "utf8")).outcome === "success") {
        files.set(file, readFileSync(file));
      }
    }
  };
  walk(root);
  return files;
};
const clients: JsonLineMcpClient[] = [];
const newClient = () => {
  const client = new JsonLineMcpClient(executorMcpInvocation(sidecar, root, installedPluginRoot), registry, sidecar);
  clients.push(client);
  return client;
};
const raw = async (client: JsonLineMcpClient, name: string, args: unknown) => {
  const response = await client.request("tools/call", { name, arguments: args });
  assert(!response.error);
  return response.result as { isError?: boolean; content: Array<{ text: string }> };
};
const call = async (client: JsonLineMcpClient, name: string, args: unknown) => {
  const response = await raw(client, name, args);
  assert(!response.isError, response.content[0].text);
  return JSON.parse(response.content[0].text) as AutomaticBuildExecutorSessionResponseV3;
};
const prepare = async (client: JsonLineMcpClient, ref: string) => {
  const opened = await call(client, "executor.open", { version: "automatic_build_executor_open_request.v3", opaque_handoff_ref: ref });
  assert(opened.action.kind === "DELIVER_INPUT");
  const batch = await call(client, "executor.input.next", opened.action.next_request);
  assert(batch.action.kind === "INPUT_BATCH" && batch.action.batch.final_for_generation);
  const started = await call(client, "executor.generation.start", { version: "automatic_build_executor_generation_start_request.v3",
    opaque_session_ref: batch.action.batch.opaque_session_ref, generation_input_ref: batch.action.batch.generation_input_ref,
    confirmed_through_ordinal: batch.action.batch.last_ordinal });
  assert(started.action.kind === "GENERATE");
  assert.equal(started.action.semantic_attempt, 1);
  return started.action;
};
type Generation = Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "GENERATE" }>;
const commit = async (client: JsonLineMcpClient, generation: Generation) => {
  const result = await call(client, "executor.submit_candidate", { version: "automatic_build_executor_candidate_submit.v3",
    opaque_session_ref: generation.opaque_session_ref, candidate_sink_ref: generation.candidate_sink_ref,
    candidate: { nodes: [], edges: [] } });
  assert(result.action.kind === "DONE" && result.action.status === "committed");
};

async function main(): Promise<void> {
const startedAt = performance.now();
try {
  const initial = launches(step());
  assert.equal(initial.length, 3);
  const [a, b, c] = initial;
  const refs = new Set([a.opaque_handoff_ref]);
  const replacement = (response: AutomaticBuildStepResponseV1) => {
    const next = launches(response).find(item => item.dispatch_slot_ref === a.dispatch_slot_ref);
    assert(next && !refs.has(next.opaque_handoff_ref));
    refs.add(next.opaque_handoff_ref);
    return next;
  };
  const cb = newClient(), cc = newClient();
  const gb = await prepare(cb, b.opaque_handoff_ref), gc = await prepare(cc, c.opaque_handoff_ref);
  assert.equal(attemptCount(), 2);
  const zeroCall = { bootstrap_failure: { opaque_handoff_ref: a.opaque_handoff_ref } };
  const firstRecovery = step(zeroCall);
  const a2 = replacement(firstRecovery);
  assert.deepEqual(step(zeroCall), firstRecovery);
  assert.equal(attemptCount(), 2);
  await commit(cb, gb);
  await commit(cc, gc);
  const accepted = committedBytes();
  assert.equal(accepted.size, 2);
  const refused = await raw(cb, "executor.open", { version: "automatic_build_executor_open_request.v3", opaque_handoff_ref: a2.opaque_handoff_ref });
  assert.equal(refused.isError, true);
  const diagnostic = JSON.parse(refused.content[0].text);
  assert.equal(diagnostic.diagnostic_code, "connection_terminal");
  assert.equal(diagnostic.phase, "open");
  const report = { executor_open_failure: { opaque_handoff_ref: a2.opaque_handoff_ref,
    diagnostic_code: diagnostic.diagnostic_code, phase: diagnostic.phase } };
  const secondRecovery = step(report);
  const a3 = replacement(secondRecovery);
  assert.deepEqual(step(report), secondRecovery);
  const paused = step({ bootstrap_failure: { opaque_handoff_ref: a3.opaque_handoff_ref } });
  assert(paused.action.kind === "NEEDS_USER" && paused.action.reason === "executor_bootstrap_failed");
  assert.deepEqual(step(), paused);
  assert.equal(attemptCount(), 2);
  const resumed = replacement(step({ decision: { request_id: paused.action.request_id, choice_id: "retry_bootstrap" } }));
  const ca = newClient();
  await commit(ca, await prepare(ca, resumed.opaque_handoff_ref));
  assert.equal(attemptCount(), 3);
  assert.equal(committedBytes().size, 3);
  for (const [file, bytes] of accepted) assert.deepEqual(readFileSync(file), bytes);
  for (const client of clients) await client.close();
  const evidence = { version: "understand_book_v1_compiled_recovery.v1", status: "passed",
    execution: "compiled stdio and compiled Driver; synthetic candidates", installed_launcher_executed: !!installedPluginRoot,
    slot_capacity: 3, zero_call_failed_slot: 1, siblings_completed_during_recovery: 2,
    precise_connection_rejection: "connection_terminal", distinct_recovery_refs: refs.size,
    stable_dispatch_slot: true, duplicate_observations_idempotent: true, paused_after_failures: 3,
    explicit_retry_choice: "retry_bootstrap", semantic_attempts: 3, durable_commits: 3,
    prior_success_receipts_unchanged: 2, elapsed_ms: performance.now() - startedAt,
    driver_call_elapsed_ms: stepTimes, connections: clients.map(client => client.timingJoin) };
  writeFileSync(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log("V1 compiled recovery passed: three commits, stable slot, bounded recovery, no semantic retry");
} catch (error) {
  await Promise.allSettled(clients.map(client => client.close()));
  console.error(`V1 recovery fixture retained: ${root}`);
  throw error;
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
