import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const sidecar = path.join(desktopRoot, "src-tauri", "binaries", "understand-book-build-x86_64-pc-windows-msvc.exe");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const automaticBuild = path.join(repoRoot, "skills", "build", "automatic-build.ts");
const root = mkdtempSync(path.join(tmpdir(), "understand-book-v2-parity-"));
const source = path.join(root, "parity.md");

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function assertEqual(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} diverged:\nNODE=${JSON.stringify(left)}\nSIDECAR=${JSON.stringify(right)}`);
  }
}

try {
  writeFileSync(source, "# Parity\n\nA deterministic semantic paragraph.\n", "utf8");
  const common = [source, "--root", root, "--max-parallel", "3", "--available-agent-slots", "2"];
  const nodePlan = run(process.execPath, [tsx, automaticBuild, "plan", ...common], "Node plan");
  const sidecarPlan = run(sidecar, ["plan", ...common], "sidecar plan");
  assertEqual(nodePlan, sidecarPlan, "automatic_build_plan.v1");
  if (nodePlan.protocol !== "automatic_build_protocol.v2" || nodePlan.release?.production_default !== nodePlan.protocol) {
    throw new Error(`Node/sidecar parity did not expose the v2 production default: ${JSON.stringify(nodePlan)}`);
  }

  const nodeNext = run(process.execPath, [tsx, automaticBuild, "next", ...common], "Node unaccepted next");
  const sidecarNext = run(sidecar, ["next", ...common], "sidecar unaccepted next");
  assertEqual(nodeNext, sidecarNext, "automatic_build_next.v1");
  if (nodeNext.action?.reason !== "preflight_required") {
    throw new Error(`parity next bypassed preflight: ${JSON.stringify(nodeNext)}`);
  }
  const taskRoot = path.join(root, ".understand-book", "parity", ".build", "automatic-build", "v2", "tasks");
  if (existsSync(taskRoot)) throw new Error(`read-only parity created task state: ${taskRoot}`);
  console.log("automatic build Node/Bun v2 plan + next parity passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
