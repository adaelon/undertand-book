import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const sidecar = path.join(desktopRoot, "src-tauri", "binaries", "understand-book-build-x86_64-pc-windows-msvc.exe");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const automaticBuild = path.join(repoRoot, "skills", "build", "automatic-build.ts");
const executorPromptCli = path.join(repoRoot, "skills", "build", "executor-prompt-cli.ts");
const root = mkdtempSync(path.join(tmpdir(), "understand-book-bp8-parity-"));
const backupContainer = mkdtempSync(path.join(tmpdir(), "understand-book-bp8-parity-backup-"));
const backupRoot = path.join(backupContainer, "snapshot");
const thinPluginRoot = path.join(backupContainer, "thin-plugin");
const source = path.join(root, "parity.md");
const extractorPromptNames = [
  "pass1-local-extractor.md",
  "paper-metadata-extractor.md",
  "paper-lexicon-extractor.md",
  "profile-sidecar-extractor.md",
  "pass1-source-fragment-extractor.md",
  "pass1-lid-stitcher.md",
  "profile-sidecar-discourse-fragment-extractor.md",
  "profile-sidecar-discourse-reducer.md",
  "pass2-longrange-linker.md",
  "book-structure-extractor.md",
];
const nodeEnvironment = {
  ...process.env,
  UNDERSTAND_BOOK_PLUGIN_ROOT: thinPluginRoot,
  UNDERSTAND_BOOK_SIDECAR_SELF: sidecar,
};
const nodeSourceThinEnvironment = {
  ...process.env,
  UNDERSTAND_BOOK_PLUGIN_ROOT: thinPluginRoot,
};
delete nodeSourceThinEnvironment.UNDERSTAND_BOOK_SIDECAR_SELF;

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function run(command, args, label, env = process.env) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  const value = JSON.parse(result.stdout);
  const canonical = `${stableJson(value)}\n`;
  if (result.stdout !== canonical) {
    throw new Error(`${label} did not emit canonical JSON:\nACTUAL=${result.stdout}\nCANONICAL=${canonical}`);
  }
  return { value, stdout: result.stdout };
}

function runNode(operation, args, label) {
  return run(process.execPath, [tsx, automaticBuild, operation, ...args], label, nodeEnvironment);
}

function runSidecar(operation, args, label) {
  return run(sidecar, [operation, ...args], label);
}

function assertBytesEqual(left, right, label) {
  if (left.stdout !== right.stdout) {
    throw new Error(`${label} diverged:\nNODE=${left.stdout}\nSIDECAR=${right.stdout}`);
  }
}

function runText(command, args, label) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  if (result.stderr !== "") throw new Error(`${label} emitted stderr:\n${result.stderr}`);
  return result.stdout;
}

function redactSecrets(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => text.split(secret).join("<lease-token>"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item, secrets)]));
  }
  return value;
}

function assertEquivalentWithSecrets(left, right, secrets, label) {
  const leftBytes = `${stableJson(redactSecrets(left.value, secrets))}\n`;
  const rightBytes = `${stableJson(redactSecrets(right.value, secrets))}\n`;
  if (leftBytes !== rightBytes) {
    throw new Error(`${label} diverged after lease-token redaction:\nNODE=${leftBytes}\nSIDECAR=${rightBytes}`);
  }
}

function restoreSnapshot() {
  rmSync(root, { recursive: true, force: true });
  cpSync(backupRoot, root, { recursive: true });
}

try {
  cpSync(path.join(repoRoot, "plugins", "understand-book"), thinPluginRoot, { recursive: true });
  if (existsSync(path.join(thinPluginRoot, "agents"))) {
    throw new Error(`release plugin fixture must remain thin: ${thinPluginRoot}`);
  }
  for (const promptName of extractorPromptNames) {
    for (const mode of ["task", "dispatch"]) {
      const promptArgs = [promptName, "--executor-protocol", mode];
      const nodePrompt = runText(
        process.execPath,
        [tsx, executorPromptCli, ...promptArgs],
        `Node ${mode} prompt ${promptName}`,
      );
      const sidecarPrompt = runText(sidecar, ["prompt", ...promptArgs], `sidecar ${mode} prompt ${promptName}`);
      if (nodePrompt !== sidecarPrompt) {
        throw new Error(`Node/sidecar ${mode} prompt bytes diverged: ${promptName}`);
      }
      if (mode === "dispatch") {
        for (const marker of [
          "automatic_build_executor_session.v1",
          "automatic_build_executor.v1",
          "executor.open",
          "action.kind=GENERATE",
          "action.kind=WAIT",
          "action.kind=DONE",
          "executor.session",
        ]) {
          if (!nodePrompt.includes(marker)) {
            throw new Error(`complete executor prompt is missing marker ${marker}: ${promptName}`);
          }
        }
        if (nodePrompt.includes("automatic_build_dispatch_executor.v1")) {
          throw new Error(`complete executor prompt retains obsolete dispatch marker: ${promptName}`);
        }
      }
    }
  }

  writeFileSync(source, "# Parity\n\nA deterministic semantic paragraph.\n", "utf8");
  const implicitLegacyDir = path.join(
    root,
    ".understand-book",
    "parity",
    ".build",
    "automatic-build",
    "v2",
    "legacy-plans",
  );
  if (existsSync(implicitLegacyDir)) {
    throw new Error(`opening the target implicitly created a legacy plan: ${implicitLegacyDir}`);
  }
  const legacyArgs = [source, "--root", root, "--now", "2026-07-25T06:59:00.000Z"];
  const nodeLegacy = runNode("legacy-plan", legacyArgs, "Node explicit legacy plan");
  const sidecarLegacy = runSidecar("legacy-plan", legacyArgs, "sidecar explicit legacy plan");
  assertBytesEqual(nodeLegacy, sidecarLegacy, "explicit_legacy_build_plan.v1");
  const buildPlan = sidecarLegacy.value.build_plan_path;
  const persistedLegacy = JSON.parse(readFileSync(buildPlan, "utf8"));
  if (sidecarLegacy.value.invocation !== "explicit_full_build"
    || persistedLegacy.recipe_id !== "standard_deep"
    || persistedLegacy.status !== "confirmed"
    || persistedLegacy.confirmation_source !== "explicit_legacy_command") {
    throw new Error(`explicit legacy command did not persist the required standard confirmation: ${sidecarLegacy.stdout}`);
  }
  const common = [
    source,
    "--root", root,
    "--plugin-root", thinPluginRoot,
    "--max-parallel", "3",
    "--available-agent-slots", "2",
    "--build-plan", buildPlan,
  ];

  const nodePlan = runNode("plan", common, "Node plan");
  const sidecarPlan = runSidecar("plan", common, "sidecar plan");
  assertBytesEqual(nodePlan, sidecarPlan, "automatic_build_plan.v1");
  if (nodePlan.value.protocol !== "automatic_build_protocol.v2_dispatch"
    || nodePlan.value.release?.production_default !== nodePlan.value.protocol) {
    throw new Error(`Node/sidecar parity did not expose the dispatch production default: ${nodePlan.stdout}`);
  }

  const nodeDoctor = runNode("protocol-doctor", common, "Node protocol doctor");
  const sidecarDoctor = runSidecar("protocol-doctor", common, "sidecar protocol doctor");
  assertBytesEqual(nodeDoctor, sidecarDoctor, "automatic_build_protocol_doctor.v2");
  if (nodeDoctor.value.status !== "compatible" || nodeDoctor.value.target_state?.dry_run_mutates_state !== false) {
    throw new Error(`protocol doctor did not report read-only compatibility: ${nodeDoctor.stdout}`);
  }
  if (sidecarDoctor.value.checks?.prompt_provider?.source !== "packaged_sidecar"
    || sidecarDoctor.value.checks.prompt_provider.checked_extractors?.length !== extractorPromptNames.length
    || sidecarDoctor.value.checks?.handoff_preparation?.status !== "compatible"
    || sidecarDoctor.value.checks?.plugin_shape?.thin_plugin !== true
    || sidecarDoctor.value.checks?.plugin_shape?.agents_required !== false) {
    throw new Error(`packaged thin-plugin doctor did not exercise prompt/handoff preparation: ${sidecarDoctor.stdout}`);
  }
  const thinNodeDoctor = run(
    process.execPath,
    [tsx, automaticBuild, "protocol-doctor", ...common],
    "Node thin-plugin protocol doctor",
    nodeSourceThinEnvironment,
  );
  if (thinNodeDoctor.value.status !== "incompatible"
    || thinNodeDoctor.value.checks?.prompt_provider?.source !== "node_source"
    || thinNodeDoctor.value.checks?.prompt_provider?.diagnostic_code !== "prompt_provider_unavailable"
    || thinNodeDoctor.value.checks?.plugin_shape?.status !== "incompatible"
    || thinNodeDoctor.value.checks?.plugin_shape?.thin_plugin !== true
    || thinNodeDoctor.value.target_state?.dry_run_mutates_state !== false) {
    throw new Error(`Node thin-plugin doctor did not fail closed: ${thinNodeDoctor.stdout}`);
  }

  const nodeNext = runNode("next", common, "Node unaccepted next");
  const sidecarNext = runSidecar("next", common, "sidecar unaccepted next");
  assertBytesEqual(nodeNext, sidecarNext, "automatic_build_next.v1 preflight");
  if (nodeNext.value.action?.reason !== "preflight_required") {
    throw new Error(`parity next bypassed preflight: ${nodeNext.stdout}`);
  }
  const taskRoot = path.join(root, ".understand-book", "parity", ".build", "automatic-build", "v2", "tasks");
  if (existsSync(taskRoot)) throw new Error(`read-only parity created task state: ${taskRoot}`);

  const acceptedArgs = [
    ...common,
    "--accepted-plan", sidecarPlan.value.preflight.plan_digest,
    "--now", "2026-07-25T07:00:00.000Z",
  ];
  const nodeDispatch = runNode("next", acceptedArgs, "Node dispatch handoff");
  const sidecarDispatch = runSidecar("next", acceptedArgs, "sidecar dispatch handoff");
  assertBytesEqual(nodeDispatch, sidecarDispatch, "automatic_build_next.v1 dispatch");
  if (nodeDispatch.value.action?.kind !== "dispatch" || nodeDispatch.value.action.dispatches?.length !== 1) {
    throw new Error(`default next did not expose one executor dispatch: ${nodeDispatch.stdout}`);
  }
  if (existsSync(taskRoot)) throw new Error(`dispatch handoff claimed task state: ${taskRoot}`);
  const envelope = nodeDispatch.value.action.dispatches[0];
  const executorHandoff = envelope.executor_handoff;
  if (executorHandoff?.version !== "automatic_build_dispatch_executor_handoff_ref.v1") {
    throw new Error(`dispatch action is missing the short executor handoff: ${nodeDispatch.stdout}`);
  }
  const handoffBytes = readFileSync(executorHandoff.path);
  if (handoffBytes.byteLength !== executorHandoff.byte_length
    || createHash("sha256").update(handoffBytes).digest("hex") !== executorHandoff.sha256) {
    throw new Error(`dispatch executor handoff ref does not match its bytes: ${executorHandoff.path}`);
  }
  const handoff = JSON.parse(handoffBytes.toString("utf8"));
  if (handoff.version !== "automatic_build_dispatch_executor_handoff.v1"
    || handoff.envelope?.dispatch_run_id !== envelope.dispatch_run_id
    || !handoff.prompt?.includes("automatic_build_executor_session.v1")
    || handoff.prompt?.includes("automatic_build_dispatch_executor.v1")
    || !handoff.prompt?.includes("automatic_build_executor.v1")) {
    throw new Error(`dispatch executor handoff content is incomplete: ${executorHandoff.path}`);
  }
  const dispatchArgs = [
    source,
    nodeDispatch.value.action.stage,
    envelope.manifest.dispatch_id,
    "--dispatch-run", envelope.dispatch_run_id,
    "--root", root,
  ];
  const nodeInspection = runNode("dispatch.inspect", dispatchArgs, "Node dispatch inspect");
  const sidecarInspection = runSidecar("dispatch.inspect", dispatchArgs, "sidecar dispatch inspect");
  assertBytesEqual(nodeInspection, sidecarInspection, "automatic_build_dispatch_inspection.v1");
  if (nodeInspection.value.state !== "active" || existsSync(taskRoot)) {
    throw new Error(`dispatch inspect was not read-only: ${nodeInspection.stdout}`);
  }

  cpSync(root, backupRoot, { recursive: true });
  const interruptArgs = [
    ...dispatchArgs,
    "--terminal-reason", "executor_interrupted",
    "--interruption-code", "harness_cancelled",
    "--interruption-reporter", "root_supervisor",
    "--interruption-command-role", "dispatch_next",
    "--now", "2026-07-25T07:00:00.500Z",
  ];
  const nodeInterrupt = runNode("dispatch.finish", interruptArgs, "Node pre-claim interruption");
  restoreSnapshot();
  const sidecarInterrupt = runSidecar("dispatch.finish", interruptArgs, "sidecar pre-claim interruption");
  assertBytesEqual(nodeInterrupt, sidecarInterrupt, "automatic_build_executor_interruption.v1");
  if (sidecarInterrupt.value.terminal_reason !== "executor_interrupted"
    || sidecarInterrupt.value.interruption?.phase !== "before_first_claim"
    || sidecarInterrupt.value.interruption?.last_completed_ordinal !== -1
    || sidecarInterrupt.value.task_receipts?.length !== 0
    || Buffer.byteLength(sidecarInterrupt.stdout) > 16_384
    || /stderr|stack|candidate_payload/u.test(sidecarInterrupt.stdout)) {
    throw new Error(`pre-claim interruption receipt is invalid: ${sidecarInterrupt.stdout}`);
  }

  restoreSnapshot();
  const claimArgs = [...dispatchArgs, "--now", "2026-07-25T07:00:01.000Z"];
  const nodeClaim = runNode("dispatch.next", claimArgs, "Node dispatch claim");
  if (nodeClaim.value.action?.kind !== "task") throw new Error(`Node dispatch did not claim a task: ${nodeClaim.stdout}`);
  const nodeTask = nodeClaim.value.action.task;
  const failureArgs = (task) => [
    source,
    nodeDispatch.value.action.stage,
    task.task_id,
    "--diagnostic-code", "bp8_parity_failure",
    "--message", "deterministic parity failure",
    "--lease-ref", task.lease_ref,
    "--lease-token", task.lease.token,
    "--root", root,
    "--now", "2026-07-25T07:00:02.000Z",
  ];
  const nodeFailure = runNode("fail", failureArgs(nodeTask), "Node task failure receipt");
  const finishArgs = [
    ...dispatchArgs,
    "--terminal-reason", "task_failure",
    "--now", "2026-07-25T07:00:03.000Z",
  ];
  const nodeReceipt = runNode("dispatch.finish", finishArgs, "Node dispatch receipt");

  restoreSnapshot();
  const sidecarClaim = runSidecar("dispatch.next", claimArgs, "sidecar dispatch claim");
  if (sidecarClaim.value.action?.kind !== "task") {
    throw new Error(`sidecar dispatch did not claim a task: ${sidecarClaim.stdout}`);
  }
  const sidecarTask = sidecarClaim.value.action.task;
  const sidecarFailure = runSidecar("fail", failureArgs(sidecarTask), "sidecar task failure receipt");
  const sidecarReceipt = runSidecar("dispatch.finish", finishArgs, "sidecar dispatch receipt");
  const leaseTokens = [nodeTask.lease.token, sidecarTask.lease.token];
  assertEquivalentWithSecrets(nodeClaim, sidecarClaim, leaseTokens, "dispatch task lease");
  assertEquivalentWithSecrets(nodeFailure, sidecarFailure, leaseTokens, "task receipt");
  assertEquivalentWithSecrets(nodeReceipt, sidecarReceipt, leaseTokens, "dispatch receipt");
  if (sidecarReceipt.value.terminal_reason !== "task_failure"
    || JSON.stringify(sidecarReceipt.value).includes("candidate_payload")) {
    throw new Error(`dispatch receipt is invalid: ${sidecarReceipt.stdout}`);
  }

  const rollbackPlan = runSidecar("plan", common, "sidecar rollback plan");
  const rollback = runSidecar("next", [
    ...common,
    "--protocol", "automatic_build_protocol.v2",
    "--accepted-plan", rollbackPlan.value.preflight.plan_digest,
    "--now", "2026-07-25T07:01:00.000Z",
  ], "sidecar explicit v2 rollback");
  if (rollback.value.protocol !== "automatic_build_protocol.v2" || rollback.value.action?.kind !== "extract") {
    throw new Error(`packaged sidecar did not retain explicit v2 task resume: ${rollback.stdout}`);
  }

  console.log("automatic build IP8 explicit-legacy mapping, canonical Node/Bun parity, protocol doctor, dispatch lease/receipt, and v2 rollback smoke passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(backupContainer, { recursive: true, force: true });
}
