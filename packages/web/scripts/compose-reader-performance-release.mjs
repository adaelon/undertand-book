import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateReaderReleaseReport,
  READER_RELEASE_REPORT_VERSION,
} from "./reader-performance-release-gate.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readReport(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

const chromiumPath = argument("chromium");
const webview2Path = argument("webview2");
const outputPath = argument("output");
if (!chromiumPath || !webview2Path || !outputPath) {
  throw new Error("usage: --chromium <json> --webview2 <json> --output <json>");
}

const runtimes = [readReport(chromiumPath), readReport(webview2Path)];
const names = runtimes.map((runtime) => runtime.runtime);
if (names[0] !== "chromium" || names[1] !== "webview2") {
  throw new Error(`runtime report order/identity mismatch: ${JSON.stringify(names)}`);
}
if (new Set(runtimes.map((runtime) => runtime.revision)).size !== 1) {
  throw new Error("runtime reports were not recorded from the same revision");
}
for (const runtime of runtimes) {
  if (
    runtime.flags?.bounded_buffer_v1 !== "1"
    || runtime.flags?.batched_hydration_v1 !== "1"
  ) {
    throw new Error(`${runtime.runtime} final report did not explicitly enable both release flags`);
  }
}

const report = {
  schema_version: READER_RELEASE_REPORT_VERSION,
  generated_at: new Date().toISOString(),
  revision: runtimes[0].revision,
  working_tree_dirty: runtimes.some((runtime) => runtime.working_tree_dirty),
  runtimes,
};
report.release = evaluateReaderReleaseReport(report);
writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${resolve(outputPath)}\n`);
if (!report.release.passed) process.exitCode = 1;
