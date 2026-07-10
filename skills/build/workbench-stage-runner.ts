import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runWorkbenchStage } from "../../packages/core/src/workbench-stage-runner";
import type { BuildStageId } from "../../packages/core/src/build-workbench";

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!key?.startsWith("--") || !value) {
    console.error("usage: workbench-stage-runner --book-dir <dir> --job-id <id> --stage <stage>");
    process.exit(2);
  }
  values.set(key, value);
}

const bookDir = values.get("--book-dir");
const jobId = values.get("--job-id");
const stage = values.get("--stage") as BuildStageId | undefined;
const runnerToken = values.get("--runner-token");
if (!bookDir || !jobId || !stage || !runnerToken) {
  console.error("usage: workbench-stage-runner --book-dir <dir> --job-id <id> --stage <stage>");
  process.exit(2);
}

const jobFile = path.join(path.resolve(bookDir), ".build", "jobs", `${jobId}.json`);
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  if (existsSync(jobFile)) {
    const job = JSON.parse(readFileSync(jobFile, "utf8")) as { active_run?: { runner_token?: string } };
    if (job.active_run?.runner_token === runnerToken) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const current = JSON.parse(readFileSync(jobFile, "utf8")) as { active_run?: { runner_token?: string } };
if (current.active_run?.runner_token !== runnerToken) {
  console.error(`runner handshake timed out for token ${runnerToken}`);
  process.exit(1);
}

const result = await runWorkbenchStage({ book_dir: bookDir, job_id: jobId, stage });
console.log(`[workbench-stage-runner] job=${jobId} stage=${stage} status=${result.status}`);
if (result.status === "failed") process.exit(1);
