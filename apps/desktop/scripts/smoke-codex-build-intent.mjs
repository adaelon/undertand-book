import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const sidecar = process.env.UNDERSTAND_BOOK_BUILD_EXE
  ?? path.join(desktopRoot, "src-tauri", "binaries", "understand-book-build-x86_64-pc-windows-msvc.exe");
const desktop = process.env.UNDERSTAND_BOOK_DESKTOP_EXE
  ?? path.join(repoRoot, "target", "debug", "UnderstandBook.exe");
const fixture = JSON.parse(readFileSync(
  path.join(repoRoot, "packages", "core", "test", "fixtures", "build-intent.v1.golden.json"),
  "utf8",
));
const selection = {
  version: "build_intent_selection.v1",
  mode: "goal_directed",
  intent: fixture.intent,
  intent_digest: fixture.intent_digest,
  plan: fixture.plan,
  estimate_input: null,
  decision_request: {
    version: "build_decision_request.v2",
    decision_id: `decision-${fixture.plan.plan_digest.slice(0, 16)}`,
    scope: {
      kind: "build_plan",
      plan_id: fixture.plan.plan_id,
      plan_digest: fixture.plan.plan_digest,
    },
    kind: "build_intent_plan",
    options: [
      { id: "confirm", label: "Confirm plan" },
      { id: "reject", label: "Keep reading" },
    ],
    status: "pending",
  },
};
const projectionRequest = JSON.stringify({ operation: "project_codex", selection });

function run(program, args, input, env = process.env) {
  const result = runObserved(program, args, input, env);
  assert.equal(result.termination, "exited", `${program} did not exit normally: ${JSON.stringify(result)}`);
  assert.equal(result.exit_code, 0, result.stderr || `${program} failed`);
  return result.stdout;
}

function runObserved(program, args, input, env = process.env, timeout) {
  const result = spawnSync(program, args, {
    cwd: repoRoot,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    ...(timeout ? { timeout } : {}),
  });
  const termination = result.error?.code === "ETIMEDOUT"
    ? "timed_out"
    : result.signal
      ? "signaled"
      : result.status === null
        ? "spawn_failed"
        : "exited";
  return {
    exit_code: result.status,
    signal: result.signal ?? null,
    termination,
    error_code: result.error?.code ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function treeSnapshot(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  const visit = (current, relative) => {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const childRelative = relative ? path.join(relative, name) : name;
      const stats = statSync(absolute);
      if (stats.isDirectory()) visit(absolute, childRelative);
      else entries.push({
        path: childRelative.replaceAll("\\", "/"),
        size: stats.size,
        sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      });
    }
  };
  visit(root, "");
  return entries;
}

function oneOffBlueprint(index, shape) {
  const blueprintId = `one-off.cb5.artifact-${index}`;
  return {
    source: "one_off",
    blueprint_id: blueprintId,
    blueprint_version: "1.0.0",
    blueprint: {
      version: "artifact_blueprint.v1",
      blueprint_id: blueprintId,
      blueprint_version: "1.0.0",
      origin: "one_off",
      title: `CB5 artifact ${index}`,
      purpose: `Exercise deterministic Codex-owned planning for artifact ${index}.`,
      shape,
      record_schema: {
        type: "object",
        properties: { label: { type: "string", min_length: 1, max_length: 240 } },
        required: ["label"],
        additional_properties: false,
        max_properties: 1,
      },
      routing: {
        use_when: [`The reading task needs CB5 artifact ${index}.`],
        avoid_when: ["The user requests source-only evidence."],
        covered_topics: ["CB5 planning"],
        scope_label: "whole book",
      },
      search_fields: [{ path: "/label", weight: 10, analyzer: "text" }],
      summary_fields: ["/label"],
      evidence_policy: { required_per_record: true, anchor: "lid" },
      limits: { max_records: 64, max_relations: 0, max_text_chars: 16_000 },
    },
  };
}

const nodeProjection = run(
  process.execPath,
  [
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "skills", "build", "intent-plan.ts"),
  ],
  projectionRequest,
);
const sidecarProjection = run(sidecar, ["intent.plan"], projectionRequest);
assert.equal(sidecarProjection, nodeProjection, "Node and packaged Codex projections must match");
assert(!sidecarProjection.includes(fixture.intent.user_goal), "projection leaked the raw goal");
assert(!sidecarProjection.includes("user_goal"), "projection leaked the raw goal key");

const temporary = mkdtempSync(path.join(tmpdir(), "understand-book-codex-controller-"));
const localAppData = path.join(temporary, "local-app-data");
const privateRoot = path.join(temporary, "private-intents");
const libraryRoot = path.join(repoRoot, ".understand-book");
const workspaceDir = path.join(libraryRoot, "quantification-essence");
mkdirSync(path.join(localAppData, "UnderstandBook"), { recursive: true });
mkdirSync(privateRoot, { recursive: true });
writeFileSync(
  path.join(localAppData, "UnderstandBook", "settings.json"),
  `${JSON.stringify({
    schema: "understand_book.desktop_settings.v1",
    library_root: libraryRoot,
  }, null, 2)}\n`,
  "utf8",
);
const controllerRequest = JSON.stringify({
  version: "codex_build_intent_command.v1",
  operation: "status",
  target: { workspace_dir: workspaceDir },
  input: {},
});
const controllerOutput = run(desktop, ["--codex-build-intent"], controllerRequest, {
  ...process.env,
  LOCALAPPDATA: localAppData,
  UNDERSTAND_BOOK_PRIVATE_DIR: privateRoot,
});
const controller = JSON.parse(controllerOutput);
assert.equal(controller.version, "codex_build_intent_response.v1");
assert.equal(controller.projection, null);
assert.equal(controller.inspection.book_id, "quantification-essence");
assert.deepEqual(controller.inspection.intents, []);
assert.deepEqual(controller.inspection.plans, []);

const v2ContextRequest = JSON.stringify({
  version: "codex_build_intent_command.v2",
  operation: "planning.context",
  target: { workspace_dir: workspaceDir },
  input: {},
});
const controllerEnv = {
  ...process.env,
  LOCALAPPDATA: localAppData,
  UNDERSTAND_BOOK_PRIVATE_DIR: privateRoot,
};
const v2ContextRun = runObserved(desktop, ["--codex-build-intent"], v2ContextRequest, controllerEnv);
assert.deepEqual(
  { exit_code: v2ContextRun.exit_code, signal: v2ContextRun.signal, termination: v2ContextRun.termination },
  { exit_code: 0, signal: null, termination: "exited" },
  v2ContextRun.stderr,
);
assert.equal(v2ContextRun.stderr, "");
assert.equal(v2ContextRun.stdout.trim().split(/\r?\n/u).length, 1);
const v2Context = JSON.parse(v2ContextRun.stdout);
assert.equal(v2Context.version, "codex_build_intent_result.v2");
assert.equal(v2Context.status, "ok");
assert.equal(v2Context.response.version, "build_planning_context.v1");
assert(v2Context.response.scope_catalog.available_lids.length <= 128);

const powershellContext = runObserved(
  "powershell.exe",
  ["-NoProfile", "-Command", "[Console]::In.ReadToEnd() | & $env:UB_DESKTOP --codex-build-intent"],
  v2ContextRequest,
  { ...controllerEnv, UB_DESKTOP: desktop },
);
assert.equal(powershellContext.exit_code, 0, powershellContext.stderr);
assert.equal(JSON.parse(powershellContext.stdout).status, "ok");

const privateGoal = "CB4_PRIVATE_GOAL_SENTINEL";
const invalidCandidate = runObserved(
  desktop,
  ["--codex-build-intent"],
  JSON.stringify({
    version: "codex_build_intent_command.v2",
    operation: "draft.candidate",
    target: { workspace_dir: workspaceDir },
    input: {
      user_goal: privateGoal,
      planning_context_digest: v2Context.response.context_digest,
      candidate: { version: "invalid-candidate", secret: "CB4_CANDIDATE_SENTINEL" },
    },
  }),
  controllerEnv,
);
assert.equal(invalidCandidate.exit_code, 2);
assert.equal(invalidCandidate.stderr, "");
assert.equal(invalidCandidate.stdout.trim().split(/\r?\n/u).length, 1);
const invalidResult = JSON.parse(invalidCandidate.stdout);
assert.equal(invalidResult.status, "error");
assert.equal(invalidResult.error.phase, "candidate");
assert.equal(invalidResult.error.retryable, false);
assert(!invalidCandidate.stdout.includes(privateGoal));
assert(!invalidCandidate.stdout.includes("CB4_CANDIDATE_SENTINEL"));

const registrySelection = (blueprintId) => {
  const summary = v2Context.response.blueprint_registry.find((entry) => entry.blueprint_id === blueprintId);
  assert(summary, `planning context is missing ${blueprintId}`);
  return {
    source: summary.source,
    blueprint_id: summary.blueprint_id,
    blueprint_version: summary.blueprint_version,
  };
};
const publicBuildRoot = path.join(workspaceDir, ".build", "automatic-build");
const publicBuildBeforeDraft = treeSnapshot(publicBuildRoot);
const sixArtifactGoal = "Build two reusable and four one-off study artifacts for the CB5 plan smoke.";
const sixArtifactIds = [
  "system.concept_map",
  "system.comparison_table",
  "one-off.cb5.artifact-1",
  "one-off.cb5.artifact-2",
  "one-off.cb5.artifact-3",
  "one-off.cb5.artifact-4",
];
const validCandidateRun = runObserved(
  desktop,
  ["--codex-build-intent"],
  JSON.stringify({
    version: "codex_build_intent_command.v2",
    operation: "draft.candidate",
    target: { workspace_dir: workspaceDir },
    input: {
      user_goal: sixArtifactGoal,
      planning_context_digest: v2Context.response.context_digest,
      candidate: {
        version: "build_intent_planner_candidate.v2",
        goal_kind: "learn",
        source_scope: { whole_book: true, lids: [], sections: [] },
        artifacts: [
          registrySelection("system.concept_map"),
          registrySelection("system.comparison_table"),
          oneOffBlueprint(1, "collection"),
          oneOffBlueprint(2, "table"),
          oneOffBlueprint(3, "sequence"),
          oneOffBlueprint(4, "document"),
        ],
        usage_horizon: "project",
      },
    },
  }),
  controllerEnv,
);
assert.equal(validCandidateRun.exit_code, 0, validCandidateRun.stderr);
assert.equal(validCandidateRun.stderr, "");
assert.equal(validCandidateRun.stdout.trim().split(/\r?\n/u).length, 1);
const validCandidateResult = JSON.parse(validCandidateRun.stdout);
assert.equal(validCandidateResult.version, "codex_build_intent_result.v2");
assert.equal(validCandidateResult.status, "ok");
assert.equal(validCandidateResult.response.version, "codex_build_intent_response.v1");
assert.equal(validCandidateResult.response.projection.version, "codex_build_intent_plan.v2");
assert.equal(validCandidateResult.response.projection.plan.private_artifacts.length, 0);
assert.deepEqual(
  validCandidateResult.response.projection.plan.artifact_summaries.map((artifact) => artifact.blueprint_id),
  sixArtifactIds,
);
assert(!validCandidateRun.stdout.includes(sixArtifactGoal));
assert(!validCandidateRun.stdout.includes("record_schema"));
assert(!validCandidateRun.stdout.includes("search_fields"));
assert.deepEqual(treeSnapshot(publicBuildRoot), publicBuildBeforeDraft, "unconfirmed draft mutated public build state");
const privatePaths = treeSnapshot(privateRoot).map((entry) => entry.path);
assert(!privatePaths.some((entry) => /(^|\/)(tasks?|attempts?|leases?)(\/|$)/u.test(entry)));

const sidecarFailure = runObserved(
  desktop,
  ["--codex-build-intent"],
  v2ContextRequest,
  { ...controllerEnv, UNDERSTAND_BOOK_BUILD_SIDECAR: path.join(temporary, "missing-sidecar.exe") },
);
assert.equal(sidecarFailure.exit_code, 2);
assert.equal(sidecarFailure.stderr, "");
const sidecarFailureResult = JSON.parse(sidecarFailure.stdout);
assert.equal(sidecarFailureResult.status, "error");
assert.equal(sidecarFailureResult.error.phase, "context");
assert(!sidecarFailure.stdout.includes(workspaceDir));

const forcedAbort = runObserved(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  "",
  process.env,
  50,
);
assert.equal(forcedAbort.exit_code, null);
assert.equal(forcedAbort.termination, "timed_out");
assert(forcedAbort.signal || forcedAbort.error_code === "ETIMEDOUT");

console.log("Codex build-intent v1/v2 result, six-artifact unconfirmed plan, PowerShell, sidecar failure, and termination smoke passed");
