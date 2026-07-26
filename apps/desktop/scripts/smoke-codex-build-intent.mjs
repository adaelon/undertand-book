import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const result = spawnSync(program, args, {
    cwd: repoRoot,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${program} failed`);
  return result.stdout;
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

console.log("Codex build-intent projection and Desktop stdin controller smoke passed");
