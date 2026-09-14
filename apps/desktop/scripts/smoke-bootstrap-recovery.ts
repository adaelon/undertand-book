import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { confirmedStandardBuildPlan } from "../../../packages/core/test/helpers/confirmed-build-plan";
import type { AutomaticBuildStepResponseV1 } from "../../../skills/build/automatic-build-driver";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sidecar = path.resolve(process.argv[2] ?? path.join(repoRoot,
  "apps/desktop/src-tauri/binaries/understand-book-build-x86_64-pc-windows-msvc.exe"));
const temporaryRoot = path.resolve(tmpdir());
const root = mkdtempSync(path.join(temporaryRoot, "understand-book-bootstrap-canary-"));
const env = { ...process.env, UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: path.join(root, "registry") };

function run(command: string, input?: unknown): string {
  const result = spawnSync(sidecar, [command], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

try {
  const template = run("executor.agent-template");
  const code = template.match(/```javascript\r?\n([\s\S]*?)\r?\n```/u)?.[1];
  assert(code, "compiled agent template must include the exact tool resolver");
  const operations = ["executor.open", "executor.input.next", "executor.generation.start", "executor.submit_candidate"];
  const names = operations.map(name => `mcp__understand_book_build_executor__${name.replaceAll(".", "_")}`);
  const resolve = runInNewContext(`${code}\nexecutorTool`, {
    ALL_TOOLS: names.map(name => ({ name })),
    tools: Object.fromEntries(names.map(name => [name, () => name])),
  });
  operations.forEach((operation, index) => assert.equal(resolve(operation)(), names[index]));

  const source = path.join(root, "bootstrap.md");
  writeFileSync(source, "# Bootstrap\n\nA synthetic startup recovery fixture.\n");
  const planPath = path.join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify(confirmedStandardBuildPlan(source, root)));
  const invocation = JSON.parse(run("build.step", {
    version: "automatic_build_invocation_create.v1", target_input: source, root_dir: root,
    build_plan_path: planPath, quality_profile: "full", max_parallel: 1,
    created_at: new Date().toISOString(),
  }));
  const request = { version: "automatic_build_step_request.v1", invocation_ref: invocation.invocation_ref,
    available_agent_slots: 1 };
  const step = (extra = {}): AutomaticBuildStepResponseV1 => JSON.parse(run("build.step", { ...request, ...extra }));
  let response = step();
  const refs = new Set<string>();
  let slot: string | undefined;
  for (let index = 0; index < 3; index++) {
    assert.equal(response.action.kind, "SPAWN_EXECUTORS");
    if (response.action.kind !== "SPAWN_EXECUTORS") throw new Error("expected launch");
    const launch = response.action.executors[0]!;
    if (slot) assert.equal(launch.dispatch_slot_ref, slot);
    slot = launch.dispatch_slot_ref;
    assert(!refs.has(launch.opaque_handoff_ref));
    refs.add(launch.opaque_handoff_ref);
    const report = { bootstrap_failure: { opaque_handoff_ref: launch.opaque_handoff_ref } };
    response = step(report);
    assert.deepEqual(step(report), response, "a new process must replay a duplicate report");
    assert.deepEqual(step(), response, "a new process must retain bootstrap recovery state");
  }
  assert.equal(response.action.kind, "NEEDS_USER");
  if (response.action.kind !== "NEEDS_USER") throw new Error("expected bounded failure");
  assert.equal(response.action.reason, "executor_bootstrap_failed");
  response = step({ decision: { request_id: response.action.request_id, choice_id: "retry_bootstrap" } });
  if (response.action.kind !== "SPAWN_EXECUTORS") throw new Error("expected authorized retry");
  const ref = response.action.executors[0]!.opaque_handoff_ref;
  assert(!refs.has(ref));
  const record = JSON.parse(readFileSync(path.join(root, "registry", "opaque-handoffs", `${ref}.json`), "utf8"));
  assert.equal(record.recovery_identity.bootstrap_epoch, 3);
  assert.equal(record.recovery_identity.semantic_attempt, 1);
  assert.equal(record.recovery_identity.lease_epoch, 1);
  const opened = JSON.parse(run("executor.open", {
    version: "automatic_build_executor_open_request.v3", opaque_handoff_ref: ref,
  }));
  assert.equal(opened.action.kind, "DELIVER_INPUT");
  assert.deepEqual(step({ bootstrap_failure: { opaque_handoff_ref: ref } }), response,
    "an already-opened handoff must not be invalidated by a bootstrap observation");
  console.log("compiled bootstrap recovery ok: exact tools, fresh refs, stable slot, durable replay, bounded retry, unchanged semantic identity");
} finally {
  assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
  rmSync(root, { recursive: true, force: true });
}
