import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import { extractPdfTextGeometry } from "./pdf-geometry";
import { validateHybridFoundationV1ArtifactSet } from "./hybrid-foundation";
import {
  buildHybridFoundationV2Candidate,
  validateHybridFoundationV2ArtifactSet,
  writeHybridFoundationV2ArtifactSet,
} from "./hybrid-foundation-v2";
import {
  applyHybridFoundationArtifactSet,
  mergeHybridFoundationBase,
  sameLidIdentity,
  type HybridFoundationApplyFaultInjector,
} from "./hybrid-foundation-apply";
import { ReadOnlyBaseZ } from "./zod";
import {
  acceptSourceReconciliationManualOverride,
  buildReviewedDraftFromDecisions,
  reconcilePaperSource,
  reviewCandidateAndReconcile,
  sourceReconciliationEvidenceFingerprint,
  sourceReconciliationAccepted,
  writeSourceReconciliationArtifacts,
  type BuildInputFingerprint,
  type SourceReconciliationIssue,
  type SourceReconciliationReport,
  type SourceReconciliationReviewDecisions,
  type SourceReviewDecision,
} from "./source-reconciliation";
import { acceptSourceAlignmentEvidence } from "./source-alignment-evidence";
import { SourceAlignmentEvidenceV1Z } from "./source-alignment-evidence";
import {
  buildInputFingerprintsEqual,
  detectBuildReadiness,
  readBuildWorkbenchSnapshot,
  type BuildJobEvent,
  type BuildJobState,
  type BuildStageId,
} from "./build-workbench";
import { assertPaperProjectionWorkspaceTarget, buildPaperProjectionChainPlan } from "./paper-projection-chain";

interface WorkbenchInputManifest {
  version: "workbench_input_manifest.v1";
  book_id: string;
  inputs: {
    paper_md: { path: string };
    paper_pdf: { path: string };
  };
  fingerprint: BuildInputFingerprint;
}

export interface RunWorkbenchStageOptions {
  book_dir: string;
  job_id: string;
  stage: BuildStageId;
  now?: string;
  command_runner?: WorkbenchStageCommandRunner;
  hybrid_apply_fault_injector?: HybridFoundationApplyFaultInjector;
}

export interface WorkbenchStageCommandSpec {
  command: string;
  args: string[];
  cwd: string;
}

export type WorkbenchStageCommandRunner = (
  spec: WorkbenchStageCommandSpec,
) => Promise<{ exit_code: number; stdout: string; stderr: string }>;

const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const MAX_BUILD_JOB_EVENTS = 200;

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    if (!existsSync(file)) throw error;
    rmSync(file);
    renameSync(temp, file);
  }
}

function jobPath(bookDir: string, jobId: string): string {
  return path.join(bookDir, ".build", "jobs", `${jobId}.json`);
}

function appendEvent(
  job: BuildJobState,
  now: string,
  type: BuildJobEvent["type"],
  stage: BuildStageId,
  message: string,
  payload?: unknown,
): void {
  job.events.push({
    event_id: `evt_${job.events.length + 1}`,
    job_id: job.job_id,
    created_at: now,
    type,
    stage,
    message,
    ...(payload === undefined ? {} : { payload }),
  });
  if (job.events.length > MAX_BUILD_JOB_EVENTS) {
    job.events.splice(0, job.events.length - MAX_BUILD_JOB_EVENTS);
  }
  job.updated_at = now;
}

function resolveSourceDecisionRequest(job: BuildJobState, now: string): void {
  for (const request of job.decision_requests) {
    if (request.stage === "source_reconciliation" && request.status === "pending") {
      request.status = "answered";
      request.answer = "source_review_decisions_recorded";
      request.resolved_at = now;
    }
  }
}

function requestSourceReview(job: BuildJobState, now: string): void {
  const pending = job.decision_requests.some(
    (request) => request.stage === "source_reconciliation" && request.status === "pending",
  );
  if (!pending) {
    job.decision_requests.push({
      decision_id: `source_review_${job.job_id}`,
      job_id: job.job_id,
      stage: "source_reconciliation",
      kind: "source_reconciliation_mode",
      prompt: "来源对齐存在未解决片段，请逐项复核后重新运行。",
      options: [],
      status: "pending",
      created_at: now,
    });
  }
  job.status = "needs_user";
  job.active_run = undefined;
  appendEvent(job, now, "stage_blocked", "source_reconciliation", "Source reconciliation requires review");
}

function decisionHasReplacement(issue: SourceReconciliationIssue, decision: SourceReviewDecision): boolean {
  if (decision.decision === "keep_blocked") return false;
  if (decision.decision === "accept_markdown") return issue.md_excerpt !== undefined;
  if (decision.decision === "accept_pdf") return issue.pdf_excerpt !== undefined;
  if (decision.decision === "use_candidate") return issue.candidate_text !== undefined;
  return decision.decision === "manual_edit" && Boolean(decision.replacement_text?.trim());
}

function decisionsForCurrentReport(
  report: SourceReconciliationReport,
  existing: SourceReconciliationReviewDecisions | undefined,
): SourceReconciliationReviewDecisions {
  const sameInput = !existing?.input_fingerprint
    || JSON.stringify(existing.input_fingerprint) === JSON.stringify(report.input_fingerprint);
  const currentIds = new Set(report.unresolved.map((issue) => issue.id));
  const decisions = existing && existing.book_id === report.book_id && sameInput
    ? existing.decisions.filter((decision) => currentIds.has(decision.block_id))
    : [];
  return {
    version: "source_review_decisions.v1",
    book_id: report.book_id,
    stage: "source_reconciliation",
    input_fingerprint: report.input_fingerprint,
    decisions,
    ...(existing?.created_at ? { created_at: existing.created_at } : {}),
    ...(existing?.updated_at ? { updated_at: existing.updated_at } : {}),
  };
}

function sourceReviewReady(
  report: SourceReconciliationReport,
  artifact: SourceReconciliationReviewDecisions,
): boolean {
  if (!report.unresolved.length) return false;
  const byId = new Map(artifact.decisions.map((decision) => [decision.block_id, decision]));
  return report.unresolved.every((issue) => {
    const decision = byId.get(issue.id);
    return Boolean(decision && decisionHasReplacement(issue, decision));
  });
}

async function runSourceReconciliation(
  bookDir: string,
  manifest: WorkbenchInputManifest,
  job: BuildJobState,
  now: string,
): Promise<void> {
  const stageDir = path.join(bookDir, ".build", "source-reconciliation");
  const reportPath = path.join(stageDir, "report.json");
  const stageSourcePath = path.join(stageDir, "source.txt");
  const alignmentEvidencePath = path.join(stageDir, "alignment-evidence.json");
  const acceptedReport = existsSync(reportPath)
    ? readJson<SourceReconciliationReport>(reportPath)
    : undefined;
  const acceptedEvidenceIsCurrent = (() => {
    if (!existsSync(stageSourcePath) || !existsSync(alignmentEvidencePath)) return false;
    try {
      const expectedFingerprint = sourceReconciliationEvidenceFingerprint(
        readFileSync(stageSourcePath, "utf8"),
        manifest.fingerprint.paper_pdf_sha256,
      );
      return acceptSourceAlignmentEvidence(readJson<unknown>(alignmentEvidencePath), expectedFingerprint) !== null;
    } catch {
      return false;
    }
  })();
  if (
    acceptedReport?.acceptance?.mode === "manual_override"
    && acceptedReport.book_id === manifest.book_id
    && buildInputFingerprintsEqual(acceptedReport.input_fingerprint, manifest.fingerprint)
    && sourceReconciliationAccepted(acceptedReport)
    && acceptedEvidenceIsCurrent
  ) {
    resolveSourceDecisionRequest(job, now);
    job.status = "ready";
    job.active_run = undefined;
    appendEvent(job, now, "stage_completed", "source_reconciliation", "Source reconciliation already accepted by manual override");
    return;
  }

  const markdownPath = path.resolve(bookDir, manifest.inputs.paper_md.path);
  const pdfPath = path.resolve(bookDir, manifest.inputs.paper_pdf.path);
  const markdown = readFileSync(markdownPath, "utf8");
  const geometry = await extractPdfTextGeometry(new Uint8Array(readFileSync(pdfPath)));
  const decisionsPath = path.join(stageDir, "review-decisions.json");
  const existingDecisions = existsSync(decisionsPath)
    ? readJson<SourceReconciliationReviewDecisions>(decisionsPath)
    : undefined;
  const initial = reconcilePaperSource({
    book_id: manifest.book_id,
    markdown_source: markdown,
    pdf_geometry: geometry,
    input_fingerprint: manifest.fingerprint,
  });
  const currentDecisions = decisionsForCurrentReport(initial.report, existingDecisions);
  initial.review_decisions = currentDecisions;

  if (sourceReviewReady(initial.report, currentDecisions)) {
    const reviewed = buildReviewedDraftFromDecisions(initial.review_draft, initial.report, currentDecisions);
    const gated = reviewCandidateAndReconcile({
      book_id: manifest.book_id,
      original_source: initial.review_draft,
      candidate_source: reviewed.reviewed_draft,
      pdf_geometry: geometry,
      input_fingerprint: manifest.fingerprint,
      kind: "manual_review",
      decisions: reviewed.decisions,
      reviewed_source_spans: reviewed.reviewed_spans,
    });
    if (!gated.reconciliation) throw new Error(gated.reason ?? "reviewed source was rejected");
    const accepted = gated.accepted
      ? gated.reconciliation
      : acceptSourceReconciliationManualOverride(gated.reconciliation, reviewed.reviewed_draft, now);
    writeSourceReconciliationArtifacts(bookDir, accepted, reviewed.reviewed_draft);
  } else {
    const staleStageSource = path.join(stageDir, "source.txt");
    if (initial.report.unresolved.length && existsSync(staleStageSource)) rmSync(staleStageSource);
    if (initial.report.unresolved.length && existsSync(alignmentEvidencePath)) rmSync(alignmentEvidencePath);
    writeSourceReconciliationArtifacts(bookDir, initial);
    if (initial.report.unresolved.length) {
      requestSourceReview(job, now);
      return;
    }
  }

  resolveSourceDecisionRequest(job, now);
  job.status = "ready";
  job.active_run = undefined;
  appendEvent(job, now, "stage_completed", "source_reconciliation", "Source reconciliation completed");
}

async function runHybridFoundation(
  bookDir: string,
  manifest: WorkbenchInputManifest,
  job: BuildJobState,
  now: string,
  applyFaultInjector?: HybridFoundationApplyFaultInjector,
): Promise<void> {
  const stageSourcePath = path.join(bookDir, ".build", "source-reconciliation", "source.txt");
  if (!existsSync(stageSourcePath)) throw new Error("trusted source reconciliation output is missing");
  const pdfPath = path.resolve(bookDir, manifest.inputs.paper_pdf.path);
  const source = readFileSync(stageSourcePath, "utf8");
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  const pdfSha256 = sha256(pdfBytes);
  if (pdfSha256 !== manifest.fingerprint.paper_pdf_sha256.toLowerCase()) {
    throw new Error("current PDF hash does not match the Workbench input fingerprint");
  }
  const evidencePath = path.join(bookDir, ".build", "source-reconciliation", "alignment-evidence.json");
  if (!existsSync(evidencePath)) throw new Error("current source alignment evidence is missing");
  const evidenceBytes = readFileSync(evidencePath);
  const evidence = SourceAlignmentEvidenceV1Z.parse(JSON.parse(evidenceBytes.toString("utf8")));
  if (evidence.book_id !== manifest.book_id) throw new Error("source alignment evidence book identity differs");
  const evidenceSha256 = sha256(evidenceBytes);
  const geometry = await extractPdfTextGeometry(pdfBytes);
  const artifacts = buildHybridFoundationV2Candidate({
    book_id: manifest.book_id,
    source_txt: source,
    original_pdf_path: manifest.inputs.paper_pdf.path.replaceAll("\\", "/"),
    original_pdf_sha256: pdfSha256,
    pdf_geometry: geometry,
    source_alignment_evidence: evidence,
  });
  const basePath = path.join(bookDir, "base.json");
  const existingBase = existsSync(basePath)
    ? ReadOnlyBaseZ.parse(readJson<unknown>(basePath))
    : undefined;
  const base = existingBase && sameLidIdentity(existingBase, artifacts.base)
    ? mergeHybridFoundationBase(existingBase, artifacts.base)
    : artifacts.base;
  const candidateRoot = path.join(bookDir, ".build", "hybrid-foundation-candidates");
  mkdirSync(candidateRoot, { recursive: true });
  const candidateDir = mkdtempSync(path.join(candidateRoot, `${job.job_id}-`));
  let application: ReturnType<typeof applyHybridFoundationArtifactSet>;
  try {
    writeHybridFoundationV2ArtifactSet(candidateDir, source, { ...artifacts, base });
    const validateAnyFoundation = (root: string) => {
      const map = readJson<{ version?: string }>(path.join(root, "pdf_source_map.json"));
      if (map.version === "pdf_source_map.v1") {
        validateHybridFoundationV1ArtifactSet(root);
      } else if (map.version === "pdf_source_map.v2") {
        validateHybridFoundationV2ArtifactSet(root);
      } else {
        throw new Error(`unsupported hybrid foundation source map version: ${map.version ?? "missing"}`);
      }
    };
    const validateCurrentCandidate = (root: string) => {
      validateHybridFoundationV2ArtifactSet(root, {
        expected_pdf_sha256: pdfSha256,
        expected_source_alignment_evidence_sha256: evidenceSha256,
      });
    };
    application = applyHybridFoundationArtifactSet({
      book_dir: bookDir,
      candidate_dir: candidateDir,
      validate_artifact_set: validateAnyFoundation,
      validate_candidate_artifact_set: validateCurrentCandidate,
      fault_injector: applyFaultInjector,
    });
  } finally {
    rmSync(candidateDir, { recursive: true, force: true });
  }
  const readiness = detectBuildReadiness(
    readBuildWorkbenchSnapshot(bookDir, { current_input_fingerprint: manifest.fingerprint }),
  );
  job.status = readiness.route === "reader" ? "done" : "ready";
  job.active_run = undefined;
  appendEvent(job, now, "readiness_recomputed", "hybrid_foundation", `Reader handoff: ${readiness.route}`, readiness);
  appendEvent(
    job,
    now,
    "stage_completed",
    "hybrid_foundation",
    `Hybrid foundation passed deterministic gates (${application.status})`,
  );
}

function stageBuildDirName(stage: BuildStageId): string {
  return stage.replaceAll("_", "-");
}

export function workbenchStageCommand(bookDir: string, stage: BuildStageId): WorkbenchStageCommandSpec {
  if (stage === "pass1") {
    throw new Error("pass1 requires executor-produced window artifacts and is not a builtin deterministic stage");
  }
  if (stage === "source_reconciliation" || stage === "hybrid_foundation") {
    throw new Error(`${stage} runs in-process and has no external command`);
  }
  const plan = buildPaperProjectionChainPlan(bookDir);
  const selected = plan.stages.find((item) => item.stage === stage);
  if (!selected) throw new Error(`paper projection plan has no stage ${stage}`);
  const workspaceContainer = path.dirname(plan.book_dir);
  const runtimeWorkspaceRoot = path.basename(workspaceContainer) === ".understand-book"
    && path.basename(plan.book_dir) === plan.book_id
    ? path.dirname(workspaceContainer)
    : WORKSPACE_ROOT;
  if (selected.kind === "build_batch") assertPaperProjectionWorkspaceTarget(plan, runtimeWorkspaceRoot);
  if (selected.command === "pnpm" && selected.args[0] === "exec" && selected.args[1] === "tsx") {
    const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    if (sidecar) {
      return {
        command: sidecar,
        args: ["run-script", path.basename(selected.args[2]!), ...selected.args.slice(3)],
        cwd: runtimeWorkspaceRoot,
      };
    }
    return {
      command: process.execPath,
      args: [path.join(WORKSPACE_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), ...selected.args.slice(2)],
      cwd: WORKSPACE_ROOT,
    };
  }
  return {
    command: selected.command,
    args: selected.args,
    cwd: WORKSPACE_ROOT,
  };
}

const defaultCommandRunner: WorkbenchStageCommandRunner = (spec) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exit_code: code ?? 1, stdout, stderr }));
  });

async function runPaperProjection(
  bookDir: string,
  manifest: WorkbenchInputManifest,
  job: BuildJobState,
  stage: BuildStageId,
  now: string,
  commandRunner: WorkbenchStageCommandRunner,
): Promise<void> {
  const sourcePath = path.join(bookDir, "source.txt");
  const manifestPath = path.join(bookDir, "source_manifest.json");
  const sourceBefore = readFileSync(sourcePath);
  const manifestBefore = readFileSync(manifestPath);
  const command = workbenchStageCommand(bookDir, stage);
  const result = await commandRunner(command);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exit_code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
    throw new Error(`${stage} exited ${result.exit_code}: ${detail.slice(-2000)}`);
  }
  if (!readFileSync(sourcePath).equals(sourceBefore) || !readFileSync(manifestPath).equals(manifestBefore)) {
    writeFileSync(sourcePath, sourceBefore);
    writeFileSync(manifestPath, manifestBefore);
    throw new Error(`${stage} attempted to modify trusted source truth; changes were restored`);
  }
  const completionDir = path.join(bookDir, ".build", stageBuildDirName(stage));
  mkdirSync(completionDir, { recursive: true });
  writeJsonAtomic(path.join(completionDir, "completion.json"), {
    version: "workbench_stage_completion.v1",
    book_id: manifest.book_id,
    stage,
    completed_at: now,
    command: { command: command.command, args: command.args },
  });
  const readiness = detectBuildReadiness(
    readBuildWorkbenchSnapshot(bookDir, { current_input_fingerprint: manifest.fingerprint }),
  );
  job.status = readiness.route === "reader" ? "done" : "ready";
  job.active_run = undefined;
  appendEvent(job, now, "readiness_recomputed", stage, `Reader handoff: ${readiness.route}`, readiness);
  appendEvent(job, now, "stage_completed", stage, `${stage} completed without changing source truth`);
}

export async function runWorkbenchStage(options: RunWorkbenchStageOptions): Promise<BuildJobState> {
  const bookDir = path.resolve(options.book_dir);
  const now = options.now ?? new Date().toISOString();
  const file = jobPath(bookDir, options.job_id);
  const job = readJson<BuildJobState>(file);
  const manifest = readJson<WorkbenchInputManifest>(path.join(bookDir, ".build", "input", "manifest.json"));
  if (JSON.stringify(job.input_fingerprint) !== JSON.stringify(manifest.fingerprint)) {
    throw new Error("build job input fingerprint does not match current manifest");
  }
  appendEvent(job, now, "stage_started", options.stage, `Running deterministic stage ${options.stage}`);
  if (job.active_run?.telemetry) job.active_run.telemetry.last_heartbeat_at = String(Date.now());
  writeJsonAtomic(file, job);

  const heartbeat = setInterval(() => {
    if (!job.active_run?.telemetry) return;
    job.active_run.telemetry.last_heartbeat_at = String(Date.now());
    writeJsonAtomic(file, job);
  }, 2_000);

  try {
    if (options.stage === "source_reconciliation") {
      await runSourceReconciliation(bookDir, manifest, job, now);
    } else if (options.stage === "hybrid_foundation") {
      await runHybridFoundation(bookDir, manifest, job, now, options.hybrid_apply_fault_injector);
    } else {
      await runPaperProjection(
        bookDir,
        manifest,
        job,
        options.stage,
        now,
        options.command_runner ?? defaultCommandRunner,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedRun = job.active_run;
    job.status = "failed";
    job.active_run = undefined;
    job.failure_summary = {
      stage: options.stage,
      run_id: failedRun?.run_id,
      message,
      failed_at: now,
      stdout_path: failedRun?.telemetry?.stdout_path,
      stderr_path: failedRun?.telemetry?.stderr_path,
      recoverable: true,
    };
    appendEvent(job, now, "stage_failed", options.stage, message);
  } finally {
    clearInterval(heartbeat);
  }
  writeJsonAtomic(file, job);
  return job;
}
