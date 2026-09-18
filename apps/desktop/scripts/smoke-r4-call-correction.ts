import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirmedStandardBuildPlan } from "../../../packages/core/test/helpers/confirmed-build-plan";
import { resolveAutomaticBuildTarget } from "../../../packages/core/src/build-orchestrator";
import { readAutomaticBuildAttemptSnapshot } from "../../../packages/core/src/automatic-build-task-store";
import { findExecutorChildRollout, readOwnedExecutorOpenDiagnostic } from "../../../packages/core/src/build-executor-call-diagnostics";

// Real model children + installed MCP + compiled Driver. The harness controls only fault injection,
// scheduling observations and assertions. Semantic input/candidates never enter its projections.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
function run(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: unknown): string {
  const r = spawnSync(exe, args, { cwd, env, windowsHide: true, encoding: "utf8", timeout: 120_000,
    input: input === undefined ? undefined : JSON.stringify(input), maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function durable(state: any) {
  const target = resolveAutomaticBuildTarget(state.source, state.root);
  const units = Object.values(readAutomaticBuildAttemptSnapshot(target).stages)
    .flatMap(stage => Object.values(stage));
  const receipts = files(state.root).filter(f => path.basename(f) === "result.json")
    .map(f => json(f)).filter(r => r.outcome === "success");
  return { semantic_attempts: units.reduce((n, u) => n + u.semantic_attempt, 0), durable_commits: receipts.length };
}
function verifyFeedback(state: any) {
  const rootId = state.diagnostics.live.parent_id;
  const rollout = files(path.join(state.home, "sessions")).find(f => f.endsWith(`-${rootId}.jsonl`));
  assert(rollout);
  const controls = readFileSync(rollout, "utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line))
    .filter(row => row.type === "response_item" && row.payload?.type === "function_call"
      && ["send_message", "spawn_agent", "followup_task"].includes(row.payload.name))
    .map(row => ({ name: row.payload.name, args: JSON.parse(row.payload.arguments) }));
  assert.equal(controls.filter(c => c.name === "spawn_agent").length, 4);
  assert.equal(controls.filter(c => c.name === "followup_task").length, 0);
  const liveSpawn = controls.find(c => c.name === "spawn_agent" && c.args.task_name === "live");
  assert(liveSpawn);
  const feedback = controls.filter(c => c.name === "send_message")
    .find(c => ["live", "/root/live", state.diagnostics.live.child_id].includes(c.args.target));
  assert(feedback, "Root did not send feedback to the original live child");
  // This host encrypts persisted collaboration message bodies. Verify the observable target and
  // subsequent exact open independently, without claiming access to the encrypted message text.
  return { root_sent_message_to_live_child: true, feedback_body_storage: "encrypted_by_host",
    corrected_open_verified_separately: true, root_spawn_count: 4, terminal_followup_count: 0 };
}
async function control(stateFile: string, operation: string, args: string[]) {
  const s = json(stateFile);
  for (const lane of ["live", "terminal"]) {
    const observation = path.join(path.dirname(stateFile), `diagnostic-${lane}.json`);
    if (existsSync(observation)) s.diagnostics[lane] = json(observation);
  }
  const env = { ...process.env, CODEX_HOME: s.home, UNDERSTAND_BOOK_BUILD_EXE: s.sidecar,
    UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: s.registry };
  const step = (extra = {}) => JSON.parse(run(s.sidecar, ["build.step"], s.root, env, {
    version: "automatic_build_step_request.v1", invocation_ref: s.invocation_ref,
    available_agent_slots: 1, ...extra }));
  let result: any;
  if (operation === "launches") {
    const started = JSON.parse(readFileSync(path.join(path.dirname(stateFile), "root-events.jsonl"), "utf8").split(/\r?\n/u)[0]);
    assert.equal(started.type, "thread.started");
    result = { ...s.launches, root_id: started.thread_id };
  }
  else if (operation === "diagnose") {
    const [parent, child, lane] = args;
    assert(["live", "terminal"].includes(lane));
    const issued = s.launches[lane].opaque_handoff_ref;
    result = JSON.parse(run(s.sidecar, ["build.diagnose-child", parent, child, issued], s.root, env));
    if (result.status === "observed") {
      const file = await findExecutorChildRollout(path.join(s.home, "sessions"), child);
      assert(file);
      const sourceDiagnostic = await readOwnedExecutorOpenDiagnostic(file, parent, child, issued);
      assert.deepEqual(JSON.stringify(result), JSON.stringify(sourceDiagnostic), "compiled/source diagnostics differ");
      assert.equal(result.failed_call.attempted_handoff_ref, issued.slice(0, -2));
      assert.equal(result.failed_call.reported_diagnostic.diagnostic_code, "invalid_arguments");
      assert.equal(result.connection_state, "unbound");
      assert(!existsSync(path.join(s.registry, "executor-opens", `${issued}.json`)), "failed open created a durable session");
      save(path.join(path.dirname(stateFile), `diagnostic-${lane}.json`), result);
    }
  } else if (operation === "recover") {
    assert(s.diagnostics.terminal?.open_call_correction, "diagnose terminal child first");
    const response = step({ open_call_correction: s.diagnostics.terminal.open_call_correction });
    assert.equal(response.action.kind, "SPAWN_EXECUTORS");
    const next = response.action.executors.find((e: any) => e.dispatch_slot_ref === s.launches.terminal.dispatch_slot_ref);
    assert(next); assert.notEqual(next.opaque_handoff_ref, s.launches.terminal.opaque_handoff_ref);
    const replay = step({ open_call_correction: s.diagnostics.terminal.open_call_correction });
    assert(replay.action.executors.some((e: any) => e.opaque_handoff_ref === next.opaque_handoff_ref));
    s.replacement = next; s.recovery_durable = durable(s); save(stateFile, s); result = next;
  } else if (operation === "finish") {
    assert(s.diagnostics.live && s.diagnostics.terminal && s.replacement);
    const counts = durable(s); assert.deepEqual(counts, { semantic_attempts: 3, durable_commits: 3 });
    // Re-read through the production Driver; do not launch its next work units in this bounded canary.
    const after = step(); assert.notEqual(after.action.kind, "NEEDS_USER");
    s.final = { ...counts, next_action: after.action.kind }; save(stateFile, s); result = s.final;
  } else throw new Error("unsupported control operation");
  process.stdout.write(JSON.stringify(result) + "\n");
}

async function main() {
  const codex = path.resolve(process.argv[3]);
  const evidenceOut = path.resolve(process.argv[4]);
  const root = mkdtempSync(path.join(path.resolve(repo, ".."), "understand-book-r4-"));
  const home = path.join(root, "codex-home"), workspace = path.join(root, "workspace"), registry = path.join(root, "registry");
  for (const dir of [home, workspace, registry]) mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json"), path.join(home, "auth.json"));
  const sidecar = path.join(root, "understand-book-build.exe");
  copyFileSync(path.join(repo, "apps/desktop/src-tauri/binaries/understand-book-build-x86_64-pc-windows-msvc.exe"), sidecar);
  const env = { ...process.env, CODEX_HOME: home, UNDERSTAND_BOOK_BUILD_EXE: sidecar,
    UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: registry, NO_COLOR: "1" };
  const version = run(codex, ["--version"], workspace, env).trim();
  run(codex, ["plugin", "marketplace", "add", repo, "--json"], workspace, env);
  const installed = JSON.parse(run(codex, ["plugin", "add", "understand-book@understand-book", "--json"], workspace, env));
  const plugin = installed.installedPath;
  const sourcePlugin = path.join(repo, "plugins/understand-book");
  const relativeFiles = files(sourcePlugin).map(f => path.relative(sourcePlugin, f)).sort();
  assert.deepEqual(files(plugin).map(f => path.relative(plugin, f)).sort(), relativeFiles);
  for (const file of relativeFiles) assert.deepEqual(readFileSync(path.join(plugin, file)), readFileSync(path.join(sourcePlugin, file)));
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(plugin, "scripts/register-executor-agent.ps1"), "-Scope", "personal"], workspace, env);
  // Only this isolated role gets a fault-injection pause. Its four-tool execution/correction contract stays canonical.
  const agent = path.join(home, "agents/understand-book-executor.toml");
  const fault = `\n## R4 isolated fault-injection fixture\nThe caller may supply a deliberately truncated 73-character handoff. Call executor.open with exactly that supplied value once; do not repair it yourself. If the caller includes LIVE_FAULT, after the invalid_arguments open error announce that you are waiting for Root correction, then use clock.sleep for 60000 ms. Stay live awaiting Root feedback (up to three sleeps), and execute the canonical Root-guided correction on this same connection when it arrives. This test-only wait overrides the immediate lifecycle final; it does not allow another work unit. If TERMINAL_FAULT is supplied, return the ordinary exact lifecycle error immediately.\n`;
  const original = readFileSync(agent, "utf8");
  const end = original.lastIndexOf('"""'); assert(end > 0);
  writeFileSync(agent, original.slice(0, end) + fault + original.slice(end));
  const source = path.join(workspace, "recovery.md");
  writeFileSync(source, `# Recovery\n\n${Array.from({ length: 900 }, (_, i) =>
    `Paragraph ${i + 1} explains that a journal records a transaction before applying its changes. Recovery replays completed records once.`).join("\n\n")}`);
  const plan = path.join(workspace, "plan.json"); save(plan, confirmedStandardBuildPlan(source, workspace));
  const driver = (request: unknown) => JSON.parse(run(sidecar, ["build.step"], workspace, env, request));
  const invocation = driver({ version: "automatic_build_invocation_create.v1", target_input: source,
    root_dir: workspace, build_plan_path: plan, quality_profile: "full", max_parallel: 3, created_at: new Date().toISOString() });
  const first = driver({ version: "automatic_build_step_request.v1", invocation_ref: invocation.invocation_ref, available_agent_slots: 3 });
  assert.equal(first.action.kind, "SPAWN_EXECUTORS"); assert.equal(first.action.executors.length, 3);
  const [live, terminal, sibling] = first.action.executors;
  const stateFile = path.join(root, "control.json");
  save(stateFile, { root: workspace, home, source, registry, sidecar, invocation_ref: invocation.invocation_ref,
    launches: { live: { ...live, fault_ref: live.opaque_handoff_ref.slice(0, -2) },
      terminal: { ...terminal, fault_ref: terminal.opaque_handoff_ref.slice(0, -2) }, sibling }, diagnostics: {} });
  const helper = path.join(workspace, "control.cmd");
  writeFileSync(helper, `@echo off\r\n"${process.execPath}" "${path.join(repo, "node_modules/tsx/dist/cli.mjs")}" "${script}" control "${stateFile}" %*\r\n`);
  const prompt = `You are the Root in an authorized isolated R4 host acceptance test. Follow the installed build skill's Diagnose and Four-action loop rules. This is a bounded three-work-unit test, already confirmed by its fixture; do not ask the user to register, plan, or approve anything. Do not use executor tools or read semantic input/candidates/rollout files. You may read the installed build SKILL.md.\nUse functions exec shell to run .\\control.cmd launches in this cwd; this is the test's bounded compiled Driver helper. It returns live, terminal, sibling launches. Spawn exactly three dedicated understand_book_executor children, fork_turns=none. For live use ONLY fault_ref and the marker LIVE_FAULT; for terminal use ONLY fault_ref and TERMINAL_FAULT. These two intentional malformed first opens are the test injection. For sibling use its correct opaque_handoff_ref and normal payload. Keep the correct issued refs in Root for correction. Never send a slot ref to a child.\nAfter spawning, run .\\control.cmd diagnose <your actual root UUID> <child UUID> live (or terminal). If evidence_missing, wait briefly then retry; do not dump logs. The compiled reader checks ownership. It returns only failed open controls. Compare the issued and attempted refs, explicitly identify the two missing final characters in the feedback. When live has an unbound error send_message to that same still-live child with the original issued ref and original diagnostic; do not spawn a replacement for live. For terminal wait until its final, preserve the completed ref and release only that slot. Then run .\\control.cmd recover to submit its observed correction to the real Driver, returning a replacement for the same slot; spawn ONE fresh dedicated child with this new ref and bounded diagnostic feedback. Never followup a terminal child. Keep sibling running and consume all four lifecycle finals.\nFinally run .\\control.cmd finish, which checks exactly three durable commits and three semantic attempts and re-reads compiled Driver state. If it passes return exactly R4_HOST_CORRECTION_PASSED. Do not launch remaining work from its next_action. If anything fails report only bounded control facts. Use the actual root task UUID from your environment context or thread metadata for diagnose. Test state is isolated, all requested helper commands and subagent operations are authorized.\nInstalled skill: ${path.join(plugin, "skills/build/SKILL.md")}`;
  save(path.join(repo, "tmp/r4-current-run.json"), { root, home, workspace, stateFile, sidecar, plugin, evidenceOut });
  console.log(`R4 isolated host started: ${root}`);
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(codex, ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--cd", workspace, "-"],
      { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("R4 host exceeded 15 minutes")); }, 900_000);
    child.stdout.on("data", b => { stdout += b; writeFileSync(path.join(root, "root-events.jsonl"), stdout); });
    child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timer); writeFileSync(path.join(root, "host-stderr.txt"), stderr);
      code === 0 ? resolve() : reject(new Error(`R4 host exit ${code}; private evidence at ${root}`)); });
    child.stdin.end(`${prompt}\nUse task_name live, terminal, sibling for the initial three children, and replacement for the fourth. The launches helper also returns your root_id; use it for diagnose without searching host state.`);
  });
  const state = json(stateFile); assert(state.final, `R4 host did not finish; private evidence at ${root}`);
  const counts = durable(state); assert.deepEqual(counts, { semantic_attempts: 3, durable_commits: 3 });
  const sessions = files(path.join(home, "sessions")).filter(f => f.endsWith(".jsonl"));
  const calls: any[] = [];
  for (const f of sessions) for (const line of readFileSync(f, "utf8").split(/\r?\n/u)) {
    if (!line) continue;
    const row = JSON.parse(line); const p = row.payload;
    if (row.type === "event_msg" && p?.type === "item_completed" && p.item?.type === "McpToolCall"
      && p.item.server === "understand_book_build_executor") calls.push({ child: p.thread_id, item: p.item });
  }
  const rootId = state.diagnostics.live.parent_id;
  assert(calls.every(c => c.child !== rootId), "Root called Executor MCP");
  const childCalls = (id: string) => calls.filter(c => c.child === id);
  const liveCalls = childCalls(state.diagnostics.live.child_id);
  const terminalCalls = childCalls(state.diagnostics.terminal.child_id);
  assert.deepEqual(liveCalls.filter(c => c.item.tool === "executor.open").map(c => c.item.arguments.opaque_handoff_ref),
    [live.opaque_handoff_ref.slice(0, -2), live.opaque_handoff_ref]);
  assert.equal(terminalCalls.length, 1);
  assert.equal(new Set(calls.map(c => c.child)).size, 4);
  const commits = calls.filter(c => c.item.tool === "executor.submit_candidate");
  assert.equal(commits.length, 3, "expected one submit per successful child");
  const replacementCall = calls.find(c => c.item.tool === "executor.open" && c.item.arguments.opaque_handoff_ref === state.replacement.opaque_handoff_ref);
  assert(replacementCall && replacementCall.child !== state.diagnostics.terminal.child_id);
  const handoff = json(path.join(registry, "opaque-handoffs", `${state.replacement.opaque_handoff_ref}.json`));
  const evidence = { version: "understand_book_r4_host_correction.v1", status: "passed", host: version,
    plugin_version: installed.version, installed_file_count: relativeFiles.length, installed_bytes_match: true,
    execution: "real model Root and four dedicated children; compiled Driver and installed MCP launcher",
    fault_injection: "two initial truncated refs; isolated role permits live child to wait for Root feedback",
    live: { child_id: state.diagnostics.live.child_id, issued_ref: live.opaque_handoff_ref,
      attempted_ref: state.diagnostics.live.failed_call.attempted_handoff_ref,
      original_diagnostic: state.diagnostics.live.failed_call.reported_diagnostic,
      same_child_corrected: true, open_count: 2 },
    terminal: { child_id: state.diagnostics.terminal.child_id, replacement_child_id: replacementCall.child,
      observation: state.diagnostics.terminal.open_call_correction, replacement_ref: state.replacement.opaque_handoff_ref,
      recovery_identity: handoff.recovery_identity, stable_slot: true, repeated_observation_idempotent: true },
    state_during_terminal_recovery: state.recovery_durable,
    feedback: verifyFeedback(state),
    ...counts, successful_submit_calls: commits.length, root_executor_calls: 0, user_operations_required: 0,
    next_driver_action: state.final.next_action, elapsed_ms: performance.now() - started };
  save(evidenceOut, evidence); console.log("R4 real host correction passed: three attempts, three commits, four children");
}
const task = mode === "control" ? control(process.argv[3], process.argv[4], process.argv.slice(5))
  : mode === "run" ? main() : mode === "verify-feedback" ? Promise.resolve().then(() => {
    const state = json(process.argv[3]), evidence = json(process.argv[4]);
    evidence.feedback = verifyFeedback(state);
    evidence.state_during_terminal_recovery = state.recovery_durable;
    save(process.argv[4], evidence); console.log("R4 recorded Root feedback verified");
  }) : Promise.reject(new Error("usage: smoke-r4-call-correction.ts run <codex.exe> <evidence.json>"));
task.catch(error => { console.error(error); process.exitCode = 1; });
