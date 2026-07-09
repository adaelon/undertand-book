import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SourceManifestV2, PdfCapabilityName, PdfCapability } from "./source-manifest";
import {
  sourceReconciliationTrusted,
  sha256Text,
  type BuildInputFingerprint,
  type SourceReconciliationReport,
} from "./source-reconciliation";

export type BuildStageId =
  | "source_reconciliation"
  | "hybrid_foundation"
  | "pass1"
  | "paper_metadata"
  | "paper_lexicon"
  | "profile_sidecar"
  | "pass2"
  | "book_structure"
  | "paper_reading_guide";

export interface BuildStageNode {
  id: BuildStageId;
  depends_on: BuildStageId[];
}

export const BUILD_STAGE_DAG: Record<BuildStageId, BuildStageNode> = {
  source_reconciliation: { id: "source_reconciliation", depends_on: [] },
  hybrid_foundation: { id: "hybrid_foundation", depends_on: ["source_reconciliation"] },
  pass1: { id: "pass1", depends_on: ["hybrid_foundation"] },
  paper_metadata: { id: "paper_metadata", depends_on: ["pass1"] },
  paper_lexicon: { id: "paper_lexicon", depends_on: ["pass1"] },
  profile_sidecar: { id: "profile_sidecar", depends_on: ["pass1"] },
  pass2: { id: "pass2", depends_on: ["profile_sidecar"] },
  book_structure: { id: "book_structure", depends_on: ["pass2"] },
  paper_reading_guide: { id: "paper_reading_guide", depends_on: ["book_structure"] },
};

export type BuildRoute = "reader" | "workbench";
export type BuildReadinessStatus = "trusted_book" | "missing" | "incomplete" | "needs_review" | "stale_input";
export type BuildStageStatus = "blocked" | "missing" | "done" | "needs_review" | "stale" | "incomplete";
export type BuildJobStatus = "ready" | "running" | "needs_user" | "failed" | "done" | "stale_input";
export type ExecutorId = "codex" | "opencode" | "claude" | "manual";

export interface BuildStageReadiness {
  stage: BuildStageId;
  status: BuildStageStatus;
  reason?: string;
}

export interface BuildWorkbenchReadiness {
  route: BuildRoute;
  status: BuildReadinessStatus;
  reasons: string[];
  stages: Record<BuildStageId, BuildStageReadiness>;
}

export interface BuildWorkbenchSnapshot {
  book_id: string;
  current_input_fingerprint?: BuildInputFingerprint;
  source_reconciliation_report?: SourceReconciliationReport;
  source_txt_sha256?: string;
  source_manifest?: SourceManifestV2;
  base_exists: boolean;
  pdf_source_map?: { config_hash: string };
  pdf_selection_map?: { config_hash: string };
  alignment_report?: { config_hash: string };
}

export interface ReadBuildWorkbenchSnapshotOptions {
  book_id?: string;
  current_input_fingerprint?: BuildInputFingerprint;
}

export interface ActiveExecutorRun {
  run_id: string;
  stage: BuildStageId;
  unit_id?: string;
  executor: ExecutorId;
  telemetry?: {
    pid?: number;
    command?: string;
    started_at?: string;
    last_heartbeat_at?: string;
    tokens_used?: number;
    cost_usd?: number;
  };
}

export type BuildDecisionKind =
  | "source_reconciliation_mode"
  | "hybrid_source_strategy"
  | "alignment_repair_strategy"
  | "executor_selection"
  | "sidecar_plan";

export interface BuildDecisionRequest {
  decision_id: string;
  job_id: string;
  stage: BuildStageId;
  kind: BuildDecisionKind;
  prompt: string;
  options: Array<{ id: string; label: string; description?: string }>;
  status: "pending" | "answered";
  answer?: string;
  created_at: string;
  resolved_at?: string;
}

export interface ExecutorPermissionRequest {
  request_id: string;
  run_id: string;
  executor: ExecutorId;
  category:
    | "sandbox_escalation"
    | "network"
    | "filesystem"
    | "mcp_tool"
    | "skill_script"
    | "shell_command"
    | "destructive_action"
    | "other";
  action_summary: string;
  scope_hint: "once" | "stage" | "job" | "profile";
  native?: unknown;
  status: "pending" | "granted" | "denied";
  created_at: string;
  resolved_at?: string;
}

export interface BuildJobEvent {
  event_id: string;
  job_id: string;
  created_at: string;
  type:
    | "job_created"
    | "job_reused"
    | "job_marked_stale"
    | "executor_started"
    | "decision_requested"
    | "decision_resolved"
    | "permission_requested"
    | "permission_resolved";
  stage?: BuildStageId;
  message?: string;
  payload?: unknown;
}

export interface BuildJobState {
  version: "build_job_state.v1";
  job_id: string;
  book_id: string;
  input_fingerprint: BuildInputFingerprint;
  status: BuildJobStatus;
  active_run?: ActiveExecutorRun;
  events: BuildJobEvent[];
  decision_requests: BuildDecisionRequest[];
  permission_requests: ExecutorPermissionRequest[];
  created_at: string;
  updated_at: string;
}

export interface ReuseOrCreateBuildJobResult {
  job: BuildJobState;
  reused: boolean;
  stale_jobs: BuildJobState[];
}

function readJsonIfExists<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function artifactConfigHash(file: string): { config_hash: string } | undefined {
  const value = readJsonIfExists<{ config_hash?: unknown }>(file);
  return typeof value?.config_hash === "string" ? { config_hash: value.config_hash } : undefined;
}

function emptyStage(stage: BuildStageId): BuildStageReadiness {
  return { stage, status: "blocked", reason: "upstream stage is not trusted yet" };
}

function setStage(
  stages: Record<BuildStageId, BuildStageReadiness>,
  stage: BuildStageId,
  status: BuildStageStatus,
  reason?: string,
): void {
  stages[stage] = reason ? { stage, status, reason } : { stage, status };
}

function capNeedsArtifact(capability: PdfCapability | undefined): boolean {
  return Boolean(capability && (capability.status === "available" || capability.status === "degraded") && capability.artifact_path);
}

function capabilityHashMismatch(capability: PdfCapability | undefined, artifact: { config_hash: string } | undefined): boolean {
  return Boolean(capability?.config_hash && artifact?.config_hash && capability.config_hash !== artifact.config_hash);
}

function degradedWithoutReason(capability: PdfCapability | undefined): boolean {
  return capability?.status === "degraded" && !capability.reason;
}

function fingerprintKey(fingerprint: BuildInputFingerprint): string {
  return JSON.stringify({
    paper_md_sha256: fingerprint.paper_md_sha256,
    paper_pdf_sha256: fingerprint.paper_pdf_sha256,
    config_hash: fingerprint.config_hash,
  });
}

function eventId(job: BuildJobState): string {
  return `evt_${job.events.length + 1}`;
}

function appendEvent(job: BuildJobState, event: Omit<BuildJobEvent, "event_id" | "job_id">): BuildJobState {
  const next: BuildJobState = {
    ...job,
    events: [...job.events, { ...event, event_id: eventId(job), job_id: job.job_id }],
    updated_at: event.created_at,
  };
  return next;
}

export function buildInputFingerprintsEqual(left: BuildInputFingerprint, right: BuildInputFingerprint): boolean {
  return fingerprintKey(left) === fingerprintKey(right);
}

export function buildInputFingerprintHash(fingerprint: BuildInputFingerprint): string {
  return createHash("sha256").update(fingerprintKey(fingerprint), "utf8").digest("hex");
}

export function makeBuildJobId(bookId: string, fingerprint: BuildInputFingerprint): string {
  return `job_${createHash("sha256").update(`${bookId}:${fingerprintKey(fingerprint)}`, "utf8").digest("hex").slice(0, 16)}`;
}

export function readBuildWorkbenchSnapshot(bookDir: string, options: ReadBuildWorkbenchSnapshotOptions = {}): BuildWorkbenchSnapshot {
  const base = readJsonIfExists<{ book_id?: unknown }>(path.join(bookDir, "base.json"));
  const source = existsSync(path.join(bookDir, "source.txt")) ? readFileSync(path.join(bookDir, "source.txt"), "utf8") : undefined;
  return {
    book_id: options.book_id ?? (typeof base?.book_id === "string" ? base.book_id : path.basename(bookDir)),
    current_input_fingerprint: options.current_input_fingerprint,
    source_reconciliation_report: readJsonIfExists<SourceReconciliationReport>(
      path.join(bookDir, ".build", "source-reconciliation", "report.json"),
    ),
    source_txt_sha256: source === undefined ? undefined : sha256Text(source),
    source_manifest: readJsonIfExists<SourceManifestV2>(path.join(bookDir, "source_manifest.json")),
    base_exists: existsSync(path.join(bookDir, "base.json")),
    pdf_source_map: artifactConfigHash(path.join(bookDir, "pdf_source_map.json")),
    pdf_selection_map: artifactConfigHash(path.join(bookDir, "pdf_selection_map", "manifest.json")),
    alignment_report: artifactConfigHash(path.join(bookDir, "alignment_report.json")),
  };
}

export function detectBuildReadiness(snapshot: BuildWorkbenchSnapshot): BuildWorkbenchReadiness {
  const stages = Object.fromEntries(
    (Object.keys(BUILD_STAGE_DAG) as BuildStageId[]).map((stage) => [stage, emptyStage(stage)]),
  ) as Record<BuildStageId, BuildStageReadiness>;
  const reasons: string[] = [];

  const report = snapshot.source_reconciliation_report;
  if (!report) {
    setStage(stages, "source_reconciliation", "missing", "source reconciliation report is missing");
  } else if (
    snapshot.current_input_fingerprint &&
    !buildInputFingerprintsEqual(report.input_fingerprint, snapshot.current_input_fingerprint)
  ) {
    setStage(stages, "source_reconciliation", "stale", "source reconciliation input fingerprint does not match current inputs");
  } else if (!sourceReconciliationTrusted(report)) {
    setStage(stages, "source_reconciliation", "needs_review", "source reconciliation has unresolved blocks");
  } else {
    setStage(stages, "source_reconciliation", "done");
  }

  if (stages.source_reconciliation.status === "done") {
    if (!snapshot.source_txt_sha256) {
      setStage(stages, "hybrid_foundation", "missing", "trusted source.txt is missing");
    } else if (!snapshot.base_exists) {
      setStage(stages, "hybrid_foundation", "missing", "base.json is missing");
    } else if (!snapshot.source_manifest) {
      setStage(stages, "hybrid_foundation", "missing", "source_manifest.json is missing");
    } else if (snapshot.source_manifest.canonical_source.sha256 !== snapshot.source_txt_sha256) {
      setStage(stages, "hybrid_foundation", "stale", "source_manifest canonical source hash does not match source.txt");
    } else {
      const capabilities = snapshot.source_manifest.capabilities;
      const capEntries: Array<[PdfCapabilityName, { config_hash: string } | undefined]> = [
        ["project_lid_to_pdf", snapshot.pdf_source_map],
        ["project_ranges_to_pdf", snapshot.pdf_source_map],
        ["resolve_pdf_selection", snapshot.pdf_selection_map],
      ];
      const missingArtifact = capEntries.find(([name, artifact]) => capNeedsArtifact(capabilities[name]) && !artifact);
      const staleArtifact = capEntries.find(([name, artifact]) => capabilityHashMismatch(capabilities[name], artifact));
      const implicitDegraded = (Object.keys(capabilities) as PdfCapabilityName[]).find((name) => degradedWithoutReason(capabilities[name]));
      if (missingArtifact) {
        setStage(stages, "hybrid_foundation", "incomplete", `${missingArtifact[0]} declares an artifact that is missing`);
      } else if (staleArtifact) {
        setStage(stages, "hybrid_foundation", "stale", `${staleArtifact[0]} config hash does not match its artifact`);
      } else if (implicitDegraded) {
        setStage(stages, "hybrid_foundation", "incomplete", `${implicitDegraded} is degraded without an explicit reason`);
      } else if (
        snapshot.alignment_report?.config_hash &&
        (capabilities.project_lid_to_pdf.config_hash ?? capabilities.resolve_pdf_selection.config_hash) &&
        snapshot.alignment_report.config_hash !== (capabilities.project_lid_to_pdf.config_hash ?? capabilities.resolve_pdf_selection.config_hash)
      ) {
        setStage(stages, "hybrid_foundation", "stale", "alignment_report config hash does not match source_manifest capabilities");
      } else {
        setStage(stages, "hybrid_foundation", "done");
      }
    }
  }

  const sourceStatus = stages.source_reconciliation.status;
  const foundationStatus = stages.hybrid_foundation.status;
  if (sourceStatus === "done" && foundationStatus === "done") {
    for (const stage of ["pass1", "paper_metadata", "paper_lexicon", "profile_sidecar", "pass2", "book_structure", "paper_reading_guide"] as BuildStageId[]) {
      setStage(stages, stage, "missing", "derived paper projection stage is not required for reader trust gate");
    }
    return { route: "reader", status: "trusted_book", reasons: [], stages };
  }

  if (sourceStatus === "needs_review") reasons.push(stages.source_reconciliation.reason ?? "source reconciliation needs review");
  if (sourceStatus === "stale" || foundationStatus === "stale") reasons.push("build input or artifacts are stale");
  if (sourceStatus === "missing" || foundationStatus === "missing") reasons.push("trusted source foundation is missing");
  if (foundationStatus === "incomplete") reasons.push(stages.hybrid_foundation.reason ?? "trusted source foundation is incomplete");

  const status: BuildReadinessStatus =
    sourceStatus === "needs_review" ? "needs_review" : sourceStatus === "stale" || foundationStatus === "stale" ? "stale_input" : foundationStatus === "incomplete" ? "incomplete" : "missing";
  return {
    route: "workbench",
    status,
    reasons: reasons.length ? reasons : ["trusted source foundation is not ready"],
    stages,
  };
}

export function createBuildJob(bookId: string, inputFingerprint: BuildInputFingerprint, now: string): BuildJobState {
  const job: BuildJobState = {
    version: "build_job_state.v1",
    job_id: makeBuildJobId(bookId, inputFingerprint),
    book_id: bookId,
    input_fingerprint: inputFingerprint,
    status: "ready",
    events: [],
    decision_requests: [],
    permission_requests: [],
    created_at: now,
    updated_at: now,
  };
  return appendEvent(job, { created_at: now, type: "job_created", message: "Build job created" });
}

export function markJobStaleIfInputChanged(job: BuildJobState, currentFingerprint: BuildInputFingerprint, now: string): BuildJobState {
  if (buildInputFingerprintsEqual(job.input_fingerprint, currentFingerprint) || job.status === "stale_input") return job;
  return appendEvent(
    { ...job, status: "stale_input", active_run: undefined },
    {
      created_at: now,
      type: "job_marked_stale",
      message: "Build job input fingerprint no longer matches current inputs",
      payload: { previous: job.input_fingerprint, current: currentFingerprint },
    },
  );
}

export function reuseOrCreateBuildJob(
  bookId: string,
  inputFingerprint: BuildInputFingerprint,
  existingJobs: BuildJobState[],
  now: string,
): ReuseOrCreateBuildJobResult {
  const stale_jobs = existingJobs
    .map((job) => markJobStaleIfInputChanged(job, inputFingerprint, now))
    .filter((job) => job.status === "stale_input" && !buildInputFingerprintsEqual(job.input_fingerprint, inputFingerprint));
  const reusable = existingJobs.find(
    (job) => job.book_id === bookId && buildInputFingerprintsEqual(job.input_fingerprint, inputFingerprint) && job.status !== "done" && job.status !== "stale_input",
  );
  if (reusable) {
    return {
      job: appendEvent(reusable, { created_at: now, type: "job_reused", message: "Reusing incomplete job for identical inputs" }),
      reused: true,
      stale_jobs,
    };
  }
  return {
    job: createBuildJob(bookId, inputFingerprint, now),
    reused: false,
    stale_jobs,
  };
}

export function setActiveExecutor(job: BuildJobState, run: ActiveExecutorRun, now: string): BuildJobState {
  return appendEvent(
    { ...job, status: "running", active_run: run },
    {
      created_at: now,
      type: "executor_started",
      stage: run.stage,
      message: `Executor ${run.executor} started`,
      payload: run,
    },
  );
}

export function requestBuildDecision(job: BuildJobState, request: Omit<BuildDecisionRequest, "job_id" | "status" | "created_at">, now: string): BuildJobState {
  const nextRequest: BuildDecisionRequest = { ...request, job_id: job.job_id, status: "pending", created_at: now };
  return appendEvent(
    { ...job, status: "needs_user", decision_requests: [...job.decision_requests, nextRequest] },
    {
      created_at: now,
      type: "decision_requested",
      stage: request.stage,
      message: request.prompt,
      payload: { decision_id: request.decision_id, kind: request.kind },
    },
  );
}

export function resolveBuildDecision(job: BuildJobState, decisionId: string, answer: string, now: string): BuildJobState {
  const decision = job.decision_requests.find((request) => request.decision_id === decisionId);
  if (!decision) throw new Error(`Build decision request not found: ${decisionId}`);
  const nextRequests = job.decision_requests.map((request) =>
    request.decision_id === decisionId ? { ...request, status: "answered" as const, answer, resolved_at: now } : request,
  );
  const pending = nextRequests.some((request) => request.status === "pending") || job.permission_requests.some((request) => request.status === "pending");
  return appendEvent(
    { ...job, status: pending ? "needs_user" : "ready", decision_requests: nextRequests },
    {
      created_at: now,
      type: "decision_resolved",
      stage: decision.stage,
      message: `Build decision ${decisionId} resolved`,
      payload: { decision_id: decisionId, answer },
    },
  );
}

export function requestExecutorPermission(
  job: BuildJobState,
  request: Omit<ExecutorPermissionRequest, "status" | "created_at">,
  now: string,
): BuildJobState {
  const nextRequest: ExecutorPermissionRequest = { ...request, status: "pending", created_at: now };
  const stage = job.active_run?.run_id === request.run_id ? job.active_run.stage : undefined;
  return appendEvent(
    { ...job, status: "needs_user", permission_requests: [...job.permission_requests, nextRequest] },
    {
      created_at: now,
      type: "permission_requested",
      stage,
      message: request.action_summary,
      payload: { request_id: request.request_id, category: request.category, scope_hint: request.scope_hint },
    },
  );
}

export function resolveExecutorPermission(job: BuildJobState, requestId: string, granted: boolean, now: string): BuildJobState {
  const permission = job.permission_requests.find((request) => request.request_id === requestId);
  if (!permission) throw new Error(`Executor permission request not found: ${requestId}`);
  const nextRequests = job.permission_requests.map((request) =>
    request.request_id === requestId ? { ...request, status: granted ? ("granted" as const) : ("denied" as const), resolved_at: now } : request,
  );
  const pending = nextRequests.some((request) => request.status === "pending") || job.decision_requests.some((request) => request.status === "pending");
  return appendEvent(
    { ...job, status: pending ? "needs_user" : "ready", permission_requests: nextRequests },
    {
      created_at: now,
      type: "permission_resolved",
      stage: job.active_run?.run_id === permission.run_id ? job.active_run.stage : undefined,
      message: `Executor permission ${requestId} ${granted ? "granted" : "denied"}`,
      payload: { request_id: requestId, granted },
    },
  );
}
