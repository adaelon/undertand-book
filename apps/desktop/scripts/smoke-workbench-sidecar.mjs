import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const buildPlanFixture = path.join(desktopRoot, "scripts", "write-confirmed-build-plan-fixture.ts");
const sidecar = path.join(
  desktopRoot,
  "src-tauri",
  "binaries",
  `understand-book-build-x86_64-pc-windows-msvc${process.platform === "win32" ? ".exe" : ""}`,
);
const legacyClaimProtocolArgs = ["--protocol", "automatic_build_protocol.v2"];

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

const smokeRoot = mkdtempSync(path.join(tmpdir(), "understand-book-sidecar-smoke-"));
const workspace = path.join(smokeRoot, ".understand-book", "paper-sidecar-smoke");
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
const confirmedBuildPlanPaths = new Map();

function confirmedBuildPlanArgs(target, rootDir) {
  const key = `${path.resolve(target)}\n${path.resolve(rootDir)}`;
  let output = confirmedBuildPlanPaths.get(key);
  if (!output) {
    output = path.join(smokeRoot, ".confirmed-build-plans", `${sha256(key).slice(0, 16)}.json`);
    const result = spawnSync(process.execPath, [tsx, buildPlanFixture, target, rootDir, output], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`confirmed build plan fixture failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    confirmedBuildPlanPaths.set(key, output);
  }
  return ["--build-plan", output];
}

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

function spawnGenerated(command, replacements = {}) {
  const args = command.slice(1).map((value) => replacements[value] ?? value);
  const result = spawnSync(command[0], args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`generated sidecar command failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function spawnCaptured(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function spawnSidecarJson(args, label) {
  const result = spawnSync(sidecar, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return { result, value: JSON.parse(result.stdout) };
}

function spawnAcceptedNext(target, args, label) {
  const rootIndex = args.indexOf("--root");
  const rootDir = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
  const plannedArgs = args.includes("--build-plan")
    ? args
    : [...args, ...confirmedBuildPlanArgs(target, rootDir)];
  const { value: plan } = spawnSidecarJson(["plan", target, ...plannedArgs], `${label} plan`);
  const nextArgs = plan.preflight
    ? ["next", target, ...plannedArgs, "--accepted-plan", plan.preflight.plan_digest]
    : ["next", target, ...plannedArgs];
  return spawnSidecarJson(nextArgs, label);
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
  const automaticTarget = path.join(workspace, "source.txt");
  const automaticArgs = [
    "--root", smokeRoot,
    "--max-parallel", "1",
    ...legacyClaimProtocolArgs,
    ...confirmedBuildPlanArgs(automaticTarget, smokeRoot),
  ];
  const taskStoreRoot = path.join(workspace, ".build", "automatic-build", "v2", "tasks");
  const { value: preflightPlan } = spawnSidecarJson(
    ["plan", automaticTarget, ...automaticArgs],
    "automatic build preflight smoke",
  );
  if (
    preflightPlan.version !== "automatic_build_plan.v1"
    || preflightPlan.preflight?.version !== "automatic_build_preflight.v1"
    || preflightPlan.preflight?.budget?.status !== "within_budget"
    || preflightPlan.preflight?.worker_plan?.max_workers !== 1
    || existsSync(taskStoreRoot)
  ) {
    throw new Error(`automatic build plan was not read-only or budgeted: ${JSON.stringify(preflightPlan)}`);
  }
  const { value: unacceptedPlan } = spawnSidecarJson(
    ["next", automaticTarget, ...automaticArgs],
    "automatic build unaccepted preflight smoke",
  );
  if (unacceptedPlan.action?.reason !== "preflight_required" || existsSync(taskStoreRoot)) {
    throw new Error(`unaccepted preflight created task state: ${JSON.stringify(unacceptedPlan)}`);
  }
  const acceptedPlanDigest = preflightPlan.preflight.plan_digest;
  const competingResults = await Promise.all(["sidecar-a", "sidecar-b", "sidecar-c"].map((owner) => spawnCaptured(sidecar, [
    "next",
    automaticTarget,
    ...automaticArgs,
    "--owner", owner,
    "--lease-ttl-ms", "30000",
    "--accepted-plan", acceptedPlanDigest,
  ])));
  if (competingResults.some((result) => result.status !== 0)) {
    throw new Error(`automatic build competing next smoke failed: ${JSON.stringify(competingResults)}`);
  }
  const competingPlans = competingResults.map((result) => JSON.parse(result.stdout));
  const extractedPlans = competingPlans.filter((plan) => plan.action?.kind === "extract");
  const waitingPlans = competingPlans.filter((plan) => plan.action?.kind === "waiting");
  if (extractedPlans.length !== 1 || waitingPlans.length !== 2) {
    const claimSummary = competingPlans.map((plan) => ({
      kind: plan.action?.kind,
      reason: plan.action?.reason,
      tasks: plan.action?.tasks?.map((task) => ({
        task_id: task.task_id,
        owner: task.lease?.owner,
        attempt: task.lease?.attempt,
        lease_ref: task.lease_ref,
      })),
    }));
    throw new Error(`automatic build claim was not exclusive: ${JSON.stringify(claimSummary)}`);
  }
  const next = extractedPlans[0];
  const task = next.action?.tasks?.[0];
  const canonicalWorkspace = path.resolve(workspace);
  if (
    next.version !== "automatic_build_next.v1"
    || next.snapshot?.target?.kind !== "paper_workspace"
    || next.snapshot.target.target_ref?.version !== "build_target_ref.v2"
    || path.resolve(next.snapshot.target.target_ref.workspace_dir) !== canonicalWorkspace
    || next.action?.kind !== "extract"
    || task?.input_command?.[1] !== "input"
    || path.resolve(task.input_command[2]) !== canonicalWorkspace
    || task?.submit_command?.[1] !== "submit"
    || path.resolve(task.submit_command[2]) !== canonicalWorkspace
    || task?.descriptor?.version !== "automatic_build_work_unit.v3"
    || task.descriptor.work_unit_id !== task.task_id
    || task.descriptor.kind !== "pass1_window"
    || task.descriptor.input_hash !== task.lease.input_hash
    || task.descriptor.input_budget_proof?.proof_digest !== task.lease.proof_digest
    || task.lease.policy_set_digest !== next.action.task_bindings?.[task.task_id]?.policy_set_digest
    || JSON.stringify(task.descriptor.policy_fingerprint) !== JSON.stringify(task.lease.policy_fingerprint)
    || task.descriptor.target?.input_fingerprint !== next.snapshot.target.target_ref.input_fingerprint
    || !(task.descriptor.cost?.score > 0)
    || Object.hasOwn(task, "write_command")
    || Object.hasOwn(task, "record_success_command")
  ) {
    throw new Error(`automatic build next did not preserve canonical target identity: ${JSON.stringify(next)}`);
  }
  const inputResult = spawnGenerated(task.input_command);
  if (!inputResult.stdout.includes("PAPER_PASS1_RULES") || !/\[\d+(?:\.\d+)*\]/.test(inputResult.stdout)) {
    throw new Error(`generated input command returned an invalid packet: ${inputResult.stdout}`);
  }
  const visibleLid = inputResult.stdout.match(/\[(\d+(?:\.\d+)*)\]/)?.[1];
  if (!visibleLid) throw new Error(`generated input command did not expose a visible LID: ${inputResult.stdout}`);
  spawnGenerated(task.fail_command, {
    "{diagnostic_code}": "executor_failed",
    "{diagnostic}": "ap5-sidecar-smoke",
  });
  const retryResult = spawnSync(sidecar, [
    "next",
    automaticTarget,
    ...automaticArgs,
    "--accepted-plan", acceptedPlanDigest,
  ], { encoding: "utf8", timeout: 30_000 });
  if (retryResult.error) throw retryResult.error;
  if (retryResult.status !== 0) {
    throw new Error(`automatic build retry smoke failed (${retryResult.status}):\n${retryResult.stdout}\n${retryResult.stderr}`);
  }
  const retry = JSON.parse(retryResult.stdout);
  const retryTask = retry.action?.tasks?.[0];
  if (retryTask?.task_id !== task.task_id || retryTask?.attempt_number !== 2) {
    throw new Error(`automatic build retry did not advance the durable attempt: ${retryResult.stdout}`);
  }
  spawnGenerated(retryTask.input_command);
  const candidateSource = path.join(smokeRoot, "pass1-candidate.json");
  const candidateOnlyMarker = "AP5_CANDIDATE_ONLY_MARKER";
  writeFileSync(candidateSource, JSON.stringify({
    nodes: [{
      id: "concept:ap5-candidate-only-marker",
      type: "concept",
      name: candidateOnlyMarker,
      occurrences: [visibleLid],
      source_lid: null,
    }],
    edges: [],
  }), "utf8");
  writeFileSync(retryTask.candidate_path, readFileSync(candidateSource));
  const submitResult = spawnGenerated(retryTask.submit_command);
  const receipt = JSON.parse(submitResult.stdout);
  const replayReceipt = JSON.parse(spawnGenerated(retryTask.submit_command).stdout);
  const inspectedReceipt = JSON.parse(spawnGenerated(retryTask.inspect_command).stdout);
  if (
    receipt.state !== "committed"
    || receipt.task_ref !== replayReceipt.task_ref
    || receipt.artifact_sha256 !== replayReceipt.artifact_sha256
    || JSON.stringify(inspectedReceipt) !== JSON.stringify(receipt)
    || Buffer.byteLength(JSON.stringify(receipt)) > 4_096
    || Object.hasOwn(receipt, "payload")
    || JSON.stringify(receipt).includes(candidateOnlyMarker)
    || receipt.metrics?.usage?.source !== "unavailable"
    || Object.hasOwn(receipt.metrics.usage, "input_tokens")
    || Object.hasOwn(receipt.metrics.usage, "output_tokens")
  ) {
    throw new Error(`automatic build mailbox receipt was not bounded and idempotent: ${submitResult.stdout}`);
  }
  const metricsResult = spawnSync(sidecar, [
    "metrics", workspace, "pass1", "--root", smokeRoot,
  ], { encoding: "utf8", timeout: 30_000 });
  if (metricsResult.error) throw metricsResult.error;
  if (metricsResult.status !== 0) {
    throw new Error(`automatic build metrics smoke failed (${metricsResult.status}):\n${metricsResult.stdout}\n${metricsResult.stderr}`);
  }
  const metricsSummary = JSON.parse(metricsResult.stdout);
  if (
    metricsSummary.attempt_count !== 2
    || metricsSummary.status_counts?.retryable_failure !== 1
    || metricsSummary.status_counts?.committed !== 1
    || metricsSummary.usage?.unavailable_attempts !== 2
    || metricsSummary.usage?.known_usage_coverage !== 0
    || !metricsSummary.digest
  ) {
    throw new Error(`automatic build metrics summary was not reproducible: ${metricsResult.stdout}`);
  }
  const taskAttempts = path.join(
    workspace,
    ".build",
    "automatic-build",
    "v2",
    "tasks",
    "pass1",
    encodeURIComponent(task.task_id),
    "attempts",
  );
  const firstAttempt = JSON.parse(readFileSync(path.join(taskAttempts, "0001", "result.json"), "utf8"));
  const secondAttempt = JSON.parse(readFileSync(path.join(taskAttempts, "0002", "result.json"), "utf8"));
  const semanticArtifactPath = typeof receipt.artifact_path === "string"
    ? path.resolve(receipt.artifact_path)
    : "";
  const semanticArtifactRelative = semanticArtifactPath
    ? path.relative(canonicalWorkspace, semanticArtifactPath)
    : "";
  if (
    firstAttempt.outcome !== "failure"
    || secondAttempt.outcome !== "success"
    || !existsSync(path.join(taskAttempts, "0002", "candidate.json"))
    || !existsSync(path.join(taskAttempts, "0002", "receipt.json"))
    || !semanticArtifactPath
    || semanticArtifactRelative.startsWith("..")
    || path.isAbsolute(semanticArtifactRelative)
    || !existsSync(semanticArtifactPath)
    || existsSync(path.join(workspace, ".build", "automatic-build", "attempts.json"))
    || existsSync(path.join(smokeRoot, ".understand-book", "source"))
  ) {
    throw new Error("automatic build attempt events were not isolated in the canonical paper workspace");
  }
  const semanticArtifact = JSON.parse(readFileSync(semanticArtifactPath, "utf8"));
  const policySet = JSON.parse(readFileSync(path.join(
    workspace,
    ".build",
    "automatic-build",
    "v3",
    "policies",
    "pass1",
    retryTask.lease.policy_set_digest,
    "policy.json",
  ), "utf8"));
  const policySetMember = policySet.members?.find((member) => member.kind === retryTask.descriptor.kind);
  if (
    semanticArtifact.version !== "semantic_task_artifact.v3"
    || semanticArtifact.stage !== "pass1"
    || semanticArtifact.work_unit_id !== task.task_id
    || semanticArtifact.input_hash !== retryTask.descriptor.input_hash
    || semanticArtifact.proof_digest !== retryTask.lease.proof_digest
    || semanticArtifact.policy_set_digest !== retryTask.lease.policy_set_digest
    || semanticArtifact.policy_fingerprint?.quality_profile !== "full"
    || semanticArtifact.provenance?.attempt !== 2
    || semanticArtifact.provenance?.executor !== retryTask.lease.owner
    || sha256(readFileSync(semanticArtifactPath)) !== receipt.artifact_sha256
    || policySet.version !== "automatic_build_stage_policy_set.v2"
    || policySet.policy_set_digest !== retryTask.lease.policy_set_digest
    || !isDeepStrictEqual(policySetMember?.policy_fingerprint, retryTask.lease.policy_fingerprint)
  ) {
    throw new Error(`automatic build semantic artifact was not policy-bound: ${JSON.stringify(semanticArtifact)}`);
  }
  const invalidMetadataPath = path.join(smokeRoot, "paper-metadata-task-22-invalid.json");
  const validMetadataPath = path.join(smokeRoot, "paper-metadata-task-22-valid.json");
  const metadataMarker = "AP8_FULL_CANDIDATE_MARKER";
  writeFileSync(invalidMetadataPath, JSON.stringify({
    paper_metadata: {
      title: { value: metadataMarker, source: "paper_text", evidence_lids: [visibleLid] },
      references: { value: ["Smith 2020"], source: "paper_text", evidence_lids: [visibleLid] },
    },
  }), "utf8");
  const metadataArgs = [
    "run-script", "paper-metadata-write.ts", path.join(workspace, "source.txt"), "0",
    invalidMetadataPath, "--book-id", "paper-sidecar-smoke", "--content-profile", "paper",
    "--paper-subtype", "research_article",
  ];
  const invalidMetadata = spawnSync(sidecar, metadataArgs, { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
  if (
    invalidMetadata.status === 0
    || !invalidMetadata.stderr.includes('"code":"schema_invalid"')
    || !invalidMetadata.stderr.includes('"json_pointer":"/paper_metadata/references/value/0"')
    || invalidMetadata.stderr.includes(metadataMarker)
  ) {
    throw new Error(`compiled metadata writer did not return a bounded AP8 diagnostic: ${invalidMetadata.stderr}`);
  }
  writeFileSync(validMetadataPath, JSON.stringify({
    paper_metadata: {
      references: {
        value: [{ raw: "Smith 2020", identifiers: { doi: "10.1/example" } }],
        source: "paper_text",
        evidence_lids: [visibleLid],
      },
    },
  }), "utf8");
  metadataArgs[4] = validMetadataPath;
  const validMetadata = spawnSync(sidecar, metadataArgs, { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
  if (validMetadata.status !== 0) {
    throw new Error(`compiled metadata writer rejected the corrected AP8 fixture: ${validMetadata.stderr}`);
  }
  const metadataRouterFixture = path.join(smokeRoot, "metadata-router.md");
  writeFileSync(metadataRouterFixture, "# Routed Paper\n\nAda Example\n\n# Discussion\n\nOrdinary body text.\n", "utf8");
  const eligibleMetadataInput = spawnSync(sidecar, [
    "run-script", "paper-metadata-input.ts", metadataRouterFixture, "0",
    "--book-id", "metadata-router", "--content-profile", "paper", "--paper-subtype", "research_article",
  ], { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
  if (
    eligibleMetadataInput.status !== 0
    || !eligibleMetadataInput.stdout.includes("PAPER_METADATA_CANDIDATE")
    || !eligibleMetadataInput.stdout.includes('signal_types: ["front_matter"]')
  ) {
    throw new Error(`compiled AP10 metadata router rejected an eligible unit: ${eligibleMetadataInput.stdout}\n${eligibleMetadataInput.stderr}`);
  }
  const skippedMetadataInput = spawnSync(sidecar, [
    "run-script", "paper-metadata-input.ts", metadataRouterFixture, "1",
    "--book-id", "metadata-router", "--content-profile", "paper", "--paper-subtype", "research_article",
  ], { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
  if (skippedMetadataInput.status === 0 || !skippedMetadataInput.stderr.includes("not model-eligible: no_metadata_signal")) {
    throw new Error(`compiled AP10 metadata router exposed a skipped unit: ${skippedMetadataInput.stdout}\n${skippedMetadataInput.stderr}`);
  }
  const lexiconRouterFixture = path.join(smokeRoot, "lexicon-router.md");
  writeFileSync(lexiconRouterFixture, "# Lexicon\n\nSoftmax Attention appears.\n\n# Discussion\n\nSoftmax Attention recurs.\n\n# Empty\n\nOrdinary body text.\n", "utf8");
  const lexiconBatchId = "lexicon-batch-05ca60e0288eb41a";
  const eligibleLexiconInput = spawnSync(sidecar, [
    "run-script", "paper-lexicon-input.ts", lexiconRouterFixture, lexiconBatchId,
    "--book-id", "lexicon-router", "--content-profile", "paper", "--paper-subtype", "research_article",
  ], { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
  if (
    eligibleLexiconInput.status !== 0
    || !eligibleLexiconInput.stdout.includes("PAPER_LEXICON_CANDIDATE_BATCH")
    || !eligibleLexiconInput.stdout.includes('"normalized_key":"softmax attention"')
  ) {
    throw new Error(`compiled AP11 lexicon router rejected an eligible batch: ${eligibleLexiconInput.stdout}\n${eligibleLexiconInput.stderr}`);
  }
  const skippedLexiconInput = spawnSync(sidecar, [
    "run-script", "paper-lexicon-input.ts", lexiconRouterFixture, "lexicon-skip-window-2",
    "--book-id", "lexicon-router", "--content-profile", "paper", "--paper-subtype", "research_article",
  ], { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
  if (skippedLexiconInput.status === 0 || !skippedLexiconInput.stderr.includes("not model-eligible")) {
    throw new Error(`compiled AP11 lexicon router exposed a skipped window: ${skippedLexiconInput.stdout}\n${skippedLexiconInput.stderr}`);
  }
  const semanticUnitFixture = path.join(repoRoot, "packages", "core", "test", "fixtures", "profile-sidecar-semantic-units.md");
  for (const [workUnitId, expectedKind] of [
    ["discourse-2-2-ac069329d625", "profile_sidecar_discourse"],
    ["formula-2-7-0faf54c756", "profile_sidecar_formula"],
  ]) {
    const semanticInput = spawnSync(sidecar, [
      "run-script", "profile-sidecar-input.ts", semanticUnitFixture, workUnitId,
      "--book-id", "semantic-unit-router", "--content-profile", "technical_learning",
    ], { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
    if (
      semanticInput.status !== 0
      || !semanticInput.stdout.includes("PROFILE_SIDECAR_SEMANTIC_UNIT")
      || !semanticInput.stdout.includes(`unit_kind: ${expectedKind}`)
    ) {
      throw new Error(`compiled AP12 semantic-unit router rejected ${workUnitId}: ${semanticInput.stdout}\n${semanticInput.stderr}`);
    }
  }
  const skippedSemanticInput = spawnSync(sidecar, [
    "run-script", "profile-sidecar-input.ts", semanticUnitFixture, "formula-skip-2-3",
    "--book-id", "semantic-unit-router", "--content-profile", "technical_learning",
  ], { cwd: smokeRoot, encoding: "utf8", timeout: 30_000 });
  if (skippedSemanticInput.status === 0 || !skippedSemanticInput.stderr.includes("not model-eligible")) {
    throw new Error(`compiled AP12 semantic-unit router exposed a skipped formula: ${skippedSemanticInput.stdout}\n${skippedSemanticInput.stderr}`);
  }
  semanticArtifact.policy_fingerprint = { ...semanticArtifact.policy_fingerprint, schema_version: "pass1_output.v999" };
  writeFileSync(semanticArtifactPath, JSON.stringify(semanticArtifact, null, 2), "utf8");
  const { result: staleResult, value: stalePlan } = spawnSidecarJson(
    ["plan", automaticTarget, ...automaticArgs],
    "automatic build policy drift smoke",
  );
  if (
    stalePlan.next_action?.kind !== "needs_user"
    || stalePlan.next_action?.reason !== "automatic_build_routing_blocked"
    || stalePlan.next_action?.recovery?.code !== "policy_generation_conflict"
    || stalePlan.next_action.recovery.stage !== "pass1"
    || stalePlan.next_action.recovery.retryable !== false
    || JSON.stringify(stalePlan.next_action.recovery.recovery_actions) !== JSON.stringify(["migrate_policy"])
  ) {
    throw new Error(`policy drift did not fail closed with structured recovery: ${staleResult.stdout}`);
  }
  const concurrencySource = path.join(smokeRoot, "sidecar-concurrency.md");
  writeFileSync(concurrencySource, [
    "# Sidecar concurrency",
    ...Array.from({ length: 320 }, (_, index) => `Paragraph ${index + 1} carries deterministic evidence for safe worker release.`),
  ].join("\n\n"), "utf8");
  const concurrencyArgs = [
    "--root", smokeRoot,
    "--max-parallel", "3",
    "--available-agent-slots", "3",
    "--max-parallel-cost", "2000000",
    ...legacyClaimProtocolArgs,
    ...confirmedBuildPlanArgs(concurrencySource, smokeRoot),
  ];
  const { value: concurrencyPlan } = spawnSidecarJson(
    ["plan", concurrencySource, ...concurrencyArgs],
    "automatic build AP14 concurrency plan smoke",
  );
  if (
    concurrencyPlan.preflight?.worker_plan?.max_workers !== 3
    || concurrencyPlan.preflight?.worker_plan?.hard_worker_limit !== 3
    || concurrencyPlan.preflight?.worker_plan?.concurrency_release !== "ap14_safe_concurrency.v1"
  ) {
    throw new Error(`compiled AP14 plan did not release exactly three safe workers: ${JSON.stringify(concurrencyPlan)}`);
  }
  const { value: concurrencyNext } = spawnSidecarJson([
    "next", concurrencySource, ...concurrencyArgs,
    "--accepted-plan", concurrencyPlan.preflight.plan_digest,
  ], "automatic build AP14 concurrency claim smoke");
  const concurrencyTasks = concurrencyNext.action?.tasks ?? [];
  if (
    concurrencyNext.action?.kind !== "extract"
    || concurrencyTasks.length !== 3
    || new Set(concurrencyTasks.map((task) => task.task_id)).size !== 3
    || concurrencyNext.action?.receipt_aggregation?.expected_receipts !== 3
    || concurrencyNext.action?.receipt_aggregation?.max_total_bytes !== 12_288
    || concurrencyNext.action?.receipt_aggregation?.candidate_payload_forbidden !== true
  ) {
    throw new Error(`compiled AP14 claim was not a bounded three-task batch: ${JSON.stringify(concurrencyNext)}`);
  }
  const { value: noSlotNext } = spawnSidecarJson([
    "next", concurrencySource,
    "--root", smokeRoot,
    "--max-parallel", "3",
    "--available-agent-slots", "0",
    "--max-parallel-cost", "2000000",
    ...legacyClaimProtocolArgs,
    ...confirmedBuildPlanArgs(concurrencySource, smokeRoot),
    "--accepted-plan", concurrencyPlan.preflight.plan_digest,
  ], "automatic build AP14 no-slot smoke");
  if (noSlotNext.action?.reason !== "executor_unavailable") {
    throw new Error(`compiled AP14 zero-slot gate claimed more work: ${JSON.stringify(noSlotNext)}`);
  }
  const submitEmptyTasks = (tasks) => {
    for (const task of tasks) {
      spawnGenerated(task.input_command);
      writeFileSync(task.candidate_path, JSON.stringify({ nodes: [], edges: [] }), "utf8");
      const receipt = JSON.parse(spawnGenerated(task.submit_command).stdout);
      if (receipt.state !== "committed" || Object.hasOwn(receipt, "payload")) {
        throw new Error(`compiled fake executor returned an invalid bounded receipt: ${JSON.stringify(receipt)}`);
      }
    }
  };
  submitEmptyTasks(concurrencyTasks);
  let qualityGatePlan;
  for (let round = 0; round < 10; round += 1) {
    const { value: plan } = spawnSidecarJson(
      ["plan", concurrencySource, ...concurrencyArgs],
      "automatic build AP15 quality plan smoke",
    );
    if (!plan.preflight) {
      qualityGatePlan = spawnSidecarJson(
        ["next", concurrencySource, ...concurrencyArgs],
        "automatic build AP15 quality gate smoke",
      ).value;
      break;
    }
    const { value: nextBatch } = spawnSidecarJson([
      "next", concurrencySource, ...concurrencyArgs,
      "--accepted-plan", plan.preflight.plan_digest,
    ], "automatic build AP15 empty batch smoke");
    submitEmptyTasks(nextBatch.action?.tasks ?? []);
  }
  const concurrencyWorkspace = concurrencyPlan.snapshot.target.workspace_dir;
  if (
    qualityGatePlan?.action?.reason !== "quality_gate_failed"
    || qualityGatePlan?.action?.gate_status !== "quality_below_floor"
    || qualityGatePlan?.quality_report?.integrity?.status !== "passed"
    || existsSync(path.join(concurrencyWorkspace, "base.json"))
  ) {
    throw new Error(`compiled AP15 quality gate published an empty semantic base: ${JSON.stringify(qualityGatePlan)}`);
  }

  const legacySource = path.join(smokeRoot, "sidecar-legacy.md");
  writeFileSync(legacySource, "# Legacy\n\nA source-fresh legacy paragraph.\n", "utf8");
  const legacyArgs = [
    "--root", smokeRoot,
    "--max-parallel", "1",
    "--available-agent-slots", "1",
    ...confirmedBuildPlanArgs(legacySource, smokeRoot),
  ];
  const { value: legacyPlan } = spawnSidecarJson(
    ["plan", legacySource, ...legacyArgs],
    "automatic build AP15 legacy plan smoke",
  );
  const legacyDescriptor = legacyPlan.preflight?.cost && legacyPlan.next_action?.work_units?.[0];
  if (!legacyDescriptor) throw new Error(`compiled AP15 legacy plan has no descriptor: ${JSON.stringify(legacyPlan)}`);
  const legacyWorkspace = legacyPlan.snapshot.target.workspace_dir;
  const legacyArtifactPath = path.join(legacyWorkspace, ".build", "pass1", `${legacyDescriptor.work_unit_id}.json`);
  mkdirSync(path.dirname(legacyArtifactPath), { recursive: true });
  writeFileSync(legacyArtifactPath, JSON.stringify({
    content_hash: legacyDescriptor.input_hash,
    nodes: [],
    edges: [],
  }), "utf8");
  const legacyArtifactBytes = readFileSync(legacyArtifactPath, "utf8");
  const { value: legacyAudit } = spawnSidecarJson(
    ["audit-legacy", legacySource, "pass1", "--root", smokeRoot],
    "automatic build AP15 legacy audit smoke",
  );
  const { value: fullLegacyAudit } = spawnSidecarJson(
    ["audit-legacy", legacySource, "--root", smokeRoot],
    "automatic build AP15 all-stage legacy audit smoke",
  );
  const { value: migrationRequired } = spawnSidecarJson(
    ["next", legacySource, ...legacyArgs],
    "automatic build AP15 migration-required smoke",
  );
  if (
    legacyAudit.legacy_artifacts !== 1
    || fullLegacyAudit.legacy_artifacts !== 1
    || legacyAudit.source_fresh_artifacts !== 1
    || legacyAudit.schema_valid_artifacts !== 1
    || legacyAudit.policy_status !== "legacy_policy_unknown"
    || migrationRequired.action?.reason !== "automatic_build_routing_blocked"
    || migrationRequired.action?.recovery?.code !== "policy_generation_migration_required"
    || migrationRequired.action.recovery.retryable !== false
    || JSON.stringify(migrationRequired.action.recovery.recovery_actions) !== JSON.stringify(["migrate_policy"])
    || readFileSync(legacyArtifactPath, "utf8") !== legacyArtifactBytes
  ) {
    throw new Error(`compiled AP15 legacy audit was not fail-closed: ${JSON.stringify({ legacyAudit, migrationRequired })}`);
  }
  const { value: migrationDecision } = spawnSidecarJson(
    ["migration-mode", legacySource, "v2_rebuild", "--root", smokeRoot, "--now", "2026-07-19T00:00:00.000Z"],
    "automatic build AP15 v2 rebuild decision smoke",
  );
  const { value: rebuildNext } = spawnSidecarJson(
    ["next", legacySource, ...legacyArgs],
    "automatic build AP15 v2 rebuild resume smoke",
  );
  const snapshottedLegacyArtifact = path.join(
    migrationDecision.legacy_snapshot_path,
    ".build",
    "pass1",
    `${legacyDescriptor.work_unit_id}.json`,
  );
  if (
    migrationDecision.mode !== "v2_rebuild"
    || !existsSync(path.join(migrationDecision.legacy_snapshot_path, "manifest.json"))
    || readFileSync(snapshottedLegacyArtifact, "utf8") !== legacyArtifactBytes
    || readFileSync(legacyArtifactPath, "utf8") !== legacyArtifactBytes
    || rebuildNext.action?.reason !== "automatic_build_routing_blocked"
    || rebuildNext.action?.recovery?.code !== "policy_generation_migration_required"
    || rebuildNext.action.recovery.retryable !== false
    || JSON.stringify(rebuildNext.action.recovery.recovery_actions) !== JSON.stringify(["migrate_policy"])
  ) {
    throw new Error(`compiled AP15 v2 rebuild did not preserve legacy before policy migration: ${JSON.stringify({ migrationDecision, rebuildNext })}`);
  }
  console.log("workbench sidecar source + hybrid v2 + automatic target/attempt store smoke passed");
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
