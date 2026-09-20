import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const canary = process.env.UB_OBSERVABILITY_RELEASE_CANARY
  ?? "UB_LS9_SECRET_CANARY_DO_NOT_PACKAGE";

function filesBelow(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const entry = path.join(directory, name);
      const stat = statSync(entry);
      if (stat.isDirectory()) visit(entry);
      else if (stat.isFile()) files.push(entry);
    }
  };
  visit(absoluteRoot);
  return files;
}

function assertAbsent(files, needles, label) {
  const leaks = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");
    for (const needle of needles) {
      if (text.includes(needle)) leaks.push(`${path.relative(root, file)}:${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `${label} contains observability client configuration or a secret canary`);
}

const webDist = filesBelow("packages/web/dist");
assert(webDist.some((file) => path.basename(file) === "index.html"), "build packages/web/dist before release verification");
assertAbsent(
  webDist,
  [canary, "LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT", "UB_OBSERVABILITY_SPOOL_DIR", "x-api-key"],
  "web bundle",
);

const preparedDesktopWeb = filesBelow("apps/desktop/src-tauri/resources/web-dist");
if (preparedDesktopWeb.length > 0) {
  assertAbsent(
    preparedDesktopWeb,
    [canary, "LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT", "UB_OBSERVABILITY_SPOOL_DIR", "x-api-key"],
    "desktop web resources",
  );
}

const releaseSurfaces = [
  ...filesBelow("apps/desktop/src-tauri/target/release/bundle"),
  ...filesBelow("apps/desktop/dist"),
  ...filesBelow(".codex-plugin"),
  ...filesBelow(".claude-plugin"),
  ...filesBelow("skills"),
];
assertAbsent(releaseSurfaces, [canary], "desktop or plugin release surface");

const tauriConfig = JSON.parse(
  readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
);
const resources = tauriConfig.bundle?.resources ?? [];
assert(resources.every((entry) => !/\.env(?:$|[\\/])/.test(entry)), "desktop bundle must not package .env files");

const linuxUnit = readFileSync(path.join(root, "scripts/linux/understand-book.service"), "utf8");
const linuxStart = readFileSync(path.join(root, "scripts/linux/start-reader.sh"), "utf8");
assert(linuxUnit.includes("EnvironmentFile="), "Linux host must read credentials from its private EnvironmentFile");
assert(!linuxUnit.includes("LANGSMITH_API_KEY="), "systemd unit must not embed a LangSmith key");
assert(!linuxStart.includes("LANGSMITH_API_KEY="), "Linux launch command must not embed a LangSmith key");
assert(!linuxStart.includes("--langsmith"), "Linux launch command must not pass observability credentials on the command line");

process.stdout.write(`${JSON.stringify({
  status: "passed",
  web_files_scanned: webDist.length,
  desktop_web_files_scanned: preparedDesktopWeb.length,
  release_files_scanned: releaseSurfaces.length,
  canary,
})}\n`);
