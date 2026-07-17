import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecar = path.join(
  desktopRoot,
  "src-tauri",
  "binaries",
  `understand-book-build-x86_64-pc-windows-msvc${process.platform === "win32" ? ".exe" : ""}`,
);

function simplePdf(text) {
  const stream = `BT /F1 12 Tf 72 100 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(value);
  value += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    value += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  value += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

const workspace = mkdtempSync(path.join(tmpdir(), "understand-book-sidecar-smoke-"));
const jobId = "job_sidecar_smoke";
const markdown = '<div style="text-align: center;"><div style="text-align: center;">Hello PDF</div> </div>\n';
const pdf = simplePdf("Hello PDF");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const fingerprint = {
  paper_md_sha256: sha256(markdown),
  paper_pdf_sha256: sha256(pdf),
  config_hash: "sidecar-smoke-v1",
};
const canonicalSource = "Hello PDF\n";

function runnerToken(stage, runId) {
  return `${jobId}:${runId}:${stage}`;
}

function armStage(stage, runId) {
  const jobPath = path.join(workspace, ".build", "jobs", `${jobId}.json`);
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.status = "running";
  job.active_run = {
    run_id: runId,
    stage,
    executor: "manual",
    runner_kind: "builtin_stage",
    runner_token: runnerToken(stage, runId),
    telemetry: { started_at: "1", last_heartbeat_at: "1" },
  };
  writeFileSync(jobPath, JSON.stringify(job, null, 2));
}

function spawnStage(stage, runId) {
  const result = spawnSync(sidecar, [
    "workbench-stage",
    "--book-dir", workspace,
    "--job-id", jobId,
    "--stage", stage,
    "--runner-token", runnerToken(stage, runId),
  ], { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const failedJob = JSON.parse(readFileSync(path.join(workspace, ".build", "jobs", `${jobId}.json`), "utf8"));
    throw new Error(
      `workbench sidecar ${stage} smoke failed (${result.status}):\n${result.stdout}\n${result.stderr}\n${JSON.stringify(failedJob.failure_summary)}`,
    );
  }
}

try {
  mkdirSync(path.join(workspace, ".build", "input"), { recursive: true });
  mkdirSync(path.join(workspace, ".build", "jobs"), { recursive: true });
  writeFileSync(path.join(workspace, "paper.md"), markdown, "utf8");
  writeFileSync(path.join(workspace, "paper.pdf"), pdf);
  writeFileSync(path.join(workspace, ".build", "input", "manifest.json"), JSON.stringify({
    version: "workbench_input_manifest.v1",
    book_id: "paper-sidecar-smoke",
    profile_id: "paper",
    display_title: "Sidecar smoke",
    inputs: {
      paper_md: { path: "paper.md", sha256: fingerprint.paper_md_sha256 },
      paper_pdf: { path: "paper.pdf", sha256: fingerprint.paper_pdf_sha256 },
    },
    config_hash: fingerprint.config_hash,
    fingerprint,
    trusted: false,
  }, null, 2));
  writeFileSync(path.join(workspace, ".build", "jobs", `${jobId}.json`), JSON.stringify({
    version: "build_job_state.v1",
    job_id: jobId,
    book_id: "paper-sidecar-smoke",
    input_fingerprint: fingerprint,
    status: "running",
    active_run: {
      run_id: "run-sidecar-source",
      stage: "source_reconciliation",
      executor: "manual",
      runner_kind: "builtin_stage",
      runner_token: runnerToken("source_reconciliation", "run-sidecar-source"),
      telemetry: { started_at: "1", last_heartbeat_at: "1" },
    },
    events: [],
    decision_requests: [],
    permission_requests: [],
    created_at: "1",
    updated_at: "1",
  }, null, 2));

  spawnStage("source_reconciliation", "run-sidecar-source");
  const sourceJob = JSON.parse(readFileSync(path.join(workspace, ".build", "jobs", `${jobId}.json`), "utf8"));
  const report = JSON.parse(readFileSync(path.join(workspace, ".build", "source-reconciliation", "report.json"), "utf8"));
  const source = readFileSync(path.join(workspace, ".build", "source-reconciliation", "source.txt"), "utf8");
  if (
    sourceJob.status !== "ready"
    || report.book_id !== "paper-sidecar-smoke"
    || report.canonicalization?.presentation_html_unwrap !== 1
    || source !== canonicalSource
  ) {
    throw new Error(`workbench sidecar source smoke produced invalid artifacts: ${JSON.stringify({
      status: sourceJob.status,
      book_id: report.book_id,
      canonicalization: report.canonicalization,
      source,
    })}`);
  }

  armStage("hybrid_foundation", "run-sidecar-hybrid");
  spawnStage("hybrid_foundation", "run-sidecar-hybrid");
  const finalJob = JSON.parse(readFileSync(path.join(workspace, ".build", "jobs", `${jobId}.json`), "utf8"));
  const sourceMap = JSON.parse(readFileSync(path.join(workspace, "pdf_source_map.json"), "utf8"));
  const selectionMap = JSON.parse(readFileSync(path.join(workspace, "pdf_selection_map", "manifest.json"), "utf8"));
  const alignmentReport = JSON.parse(readFileSync(path.join(workspace, "alignment_report.json"), "utf8"));
  if (
    finalJob.status !== "done"
    || sourceMap.version !== "pdf_source_map.v2"
    || selectionMap.version !== "pdf_selection_map.v2"
    || alignmentReport.version !== "alignment_report.v2"
    || !Object.values(alignmentReport.integrity).every(Boolean)
  ) {
    throw new Error(`workbench sidecar hybrid smoke produced invalid artifacts: ${JSON.stringify({
      status: finalJob.status,
      source_map: sourceMap.version,
      selection_map: selectionMap.version,
      alignment_report: alignmentReport.version,
      integrity: alignmentReport.integrity,
    })}`);
  }
  console.log("workbench sidecar source + hybrid v2 smoke passed");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
