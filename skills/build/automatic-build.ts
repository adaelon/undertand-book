import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildAutomaticBuildSnapshot,
  inspectAutomaticBuildStageFreshness,
  nextAutomaticBuildAction,
  nextPlannedAutomaticBuildAction,
  resolveAutomaticBuildTarget,
  type AutomaticBuildStage,
  type AutomaticBuildTarget,
  type AutomaticBuildTargetResolutionOptions,
} from "../../packages/core/src/build-orchestrator";
import type { BuildPlanV1 } from "../../packages/core/src/build-intent";
import type { Pass2PlanChoice } from "../../packages/core/src/build-capability";
import { mapLegacyBuildInvocation } from "../../packages/core/src/build-intent-controller";
import {
  readAutomaticBuildAttemptSnapshot,
  listAutomaticBuildStoredAttempts,
  recordAutomaticBuildAttemptEvent,
  type AutomaticBuildAttemptRecord,
  type AutomaticBuildExecutionIdentityV1,
} from "../../packages/core/src/automatic-build-task-store";
import {
  assertActiveAutomaticBuildLease,
  claimAutomaticBuildTask,
  heartbeatAutomaticBuildLease,
  inspectAutomaticBuildTaskClaim,
  readAutomaticBuildLease,
  startAutomaticBuildLease,
  type AutomaticBuildTaskLease,
} from "../../packages/core/src/automatic-build-lease";
import {
  failAutomaticBuildTask,
  inspectAutomaticBuildTask,
  stageAutomaticBuildCandidate,
  submitAutomaticBuildCandidate,
  type AutomaticBuildWriterResult,
} from "../../packages/core/src/automatic-build-mailbox";
import {
  automaticBuildStageMetricsSummaryPath,
  automaticBuildUsageReceiptPath,
  buildAutomaticBuildStageMetricsSummary,
  recordAutomaticBuildInputObservation,
  type AutomaticBuildStageMetricsSummaryV1,
  writeAutomaticBuildStageMetricsSummary,
} from "../../packages/core/src/automatic-build-metrics";
import type { ExtractionQualityProfile } from "../../packages/core/src/semantic-artifact";
import {
  buildAutomaticBuildPreflight,
  DEFAULT_AUTOMATIC_BUILD_BUDGET,
  evaluateAutomaticBuildPlanBudget,
  selectAutomaticBuildCostBatch,
  type AutomaticBuildBudgetLimitsV1,
  type AutomaticBuildExecutorProvenanceV1,
  type AutomaticBuildHistoricalUsageV1,
  type AutomaticBuildPlanActualUsageV1,
  type AutomaticBuildPlanBudgetEvaluationV1,
  type AutomaticBuildPreflightV1,
  type AutomaticBuildWallBudgetV1,
} from "../../packages/core/src/automatic-build-budget";
import {
  auditAutomaticBuildLegacy,
  readAutomaticBuildMigrationDecision,
  selectAutomaticBuildMigrationMode,
  type AutomaticBuildMigrationMode,
} from "../../packages/core/src/automatic-build-legacy";
import {
  automaticBuildStageQualityReportPath,
  collectAutomaticBuildStageQuality,
  writeAutomaticBuildStageQualityReport,
} from "../../packages/core/src/automatic-build-quality";
import {
  canonicalAutomaticBuildJson,
  AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
  AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  AUTOMATIC_BUILD_PROTOCOL_V2,
  AUTOMATIC_BUILD_RELEASE_V2,
  resolveAutomaticBuildClaimProtocol,
  type AutomaticBuildClaimProtocol,
} from "../../packages/core/src/automatic-build-protocol";
import {
  advanceAutomaticBuildDispatch,
  automaticBuildDispatchRunId,
  finishAutomaticBuildDispatch,
  inspectAutomaticBuildDispatch,
  persistAutomaticBuildDispatch,
  readAutomaticBuildDispatch,
  selectAutomaticBuildDispatchHandoff,
  type AutomaticBuildExecutorDispatchReceiptV1,
} from "../../packages/core/src/automatic-build-dispatch-runtime";

const PLUGIN_ROOT = process.env.UNDERSTAND_BOOK_PLUGIN_ROOT
  ? path.resolve(process.env.UNDERSTAND_BOOK_PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_CLI = path.join(PLUGIN_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAX_ATTEMPTS = 3;
const MAX_LEASE_EPOCHS = 3;
const DEFAULT_RESERVE_TTL_MS = 600_000;
const DEFAULT_RUN_TTL_MS = 1_800_000;
const AUTOMATIC_BUILD_STAGES: AutomaticBuildStage[] = [
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
];

export interface AutomaticBuildNextOptions extends AutomaticBuildTargetResolutionOptions {
  owner?: string;
  now?: string;
  lease_ttl_ms?: number;
  run_ttl_ms?: number;
  quality_profile?: ExtractionQualityProfile;
  budget?: AutomaticBuildBudgetLimitsV1;
  wall_budget?: AutomaticBuildWallBudgetV1;
  executor_provenance?: AutomaticBuildExecutorProvenanceV1;
  available_agent_slots?: number;
  accepted_plan_digest?: string;
  accepted_evaluation_digest?: string;
  protocol?: AutomaticBuildClaimProtocol;
  executor_dispatches?: boolean;
  build_plan?: BuildPlanV1;
}

export interface AutomaticBuildPlanOptions extends AutomaticBuildTargetResolutionOptions {
  quality_profile?: ExtractionQualityProfile;
  budget?: AutomaticBuildBudgetLimitsV1;
  wall_budget?: AutomaticBuildWallBudgetV1;
  executor_provenance?: AutomaticBuildExecutorProvenanceV1;
  requested_workers?: number;
  available_agent_slots?: number;
  build_plan?: BuildPlanV1;
}

interface StageCommands {
  input?: string;
  write?: string;
  close: string | null;
  prompt?: string;
}

const STAGE_COMMANDS: Record<AutomaticBuildStage, StageCommands> = {
  pass1: { input: "emit-input.ts", write: "pass1-write.ts", close: "pass1-batch.ts", prompt: "pass1-local-extractor.md" },
  paper_metadata: { input: "paper-metadata-input.ts", write: "paper-metadata-write.ts", close: "paper-metadata-batch.ts", prompt: "paper-metadata-extractor.md" },
  paper_lexicon: { input: "paper-lexicon-input.ts", write: "paper-lexicon-write.ts", close: "paper-lexicon-batch.ts", prompt: "paper-lexicon-extractor.md" },
  profile_sidecar: { input: "profile-sidecar-input.ts", write: "profile-sidecar-write.ts", close: "profile-sidecar-batch.ts", prompt: "profile-sidecar-extractor.md" },
  pass2: { input: "pass2-input.ts", write: "pass2-write.ts", close: "pass2-batch.ts", prompt: "pass2-longrange-linker.md" },
  book_structure: { input: "book-structure-input.ts", write: "book-structure-write.ts", close: "book-structure-batch.ts", prompt: "book-structure-extractor.md" },
  paper_reading_guide: { close: null },
};

function scriptCommand(script: string, args: string[]): string[] {
  const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
  if (sidecar) {
    return script === "automatic-build.ts"
      ? [sidecar, ...args]
      : [sidecar, "run-script", script, ...args];
  }
  return [process.execPath, TSX_CLI, path.join(PLUGIN_ROOT, "skills", "build", script), ...args];
}

function stageScriptArgs(target: AutomaticBuildTarget): string[] {
  const result = [target.source_path, "--book-id", target.book_id, "--content-profile", target.profile_id];
  if (target.profile_id === "paper") result.push("--paper-subtype", "research_article");
  return result;
}

function targetCommandInput(target: AutomaticBuildTarget): string {
  return target.kind === "paper_workspace" ? target.target_ref.workspace_dir : target.source_path;
}

function targetResolutionCommandArgs(target: AutomaticBuildTarget): string[] {
  return ["--root", target.root_dir, "--book-id", target.book_id];
}

export interface CapturedBuildProcessOutput {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function captureBuildProcessOutput(
  command: string,
  args: string[],
  cwd: string,
): CapturedBuildProcessOutput {
  const captureDir = mkdtempSync(path.join(tmpdir(), "understand-book-stage-capture-"));
  const stdoutPath = path.join(captureDir, "stdout");
  const stderrPath = path.join(captureDir, "stderr");
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;

  try {
    stdoutFd = openSync(stdoutPath, "w");
    stderrFd = openSync(stderrPath, "w");
    const result = spawnSync(command, args, {
      cwd,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
    closeSync(stdoutFd);
    stdoutFd = undefined;
    closeSync(stderrFd);
    stderrFd = undefined;
    return {
      ...(result.error ? { error: result.error } : {}),
      status: result.status,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    };
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    rmSync(captureDir, { recursive: true, force: true });
  }
}

function forwardStageScript(
  target: AutomaticBuildTarget,
  script: string,
  args: string[],
  capture = false,
): { stdout: string; stderr: string } {
  const [command, ...commandArgs] = scriptCommand(script, args);
  const result = capture
    ? captureBuildProcessOutput(command, commandArgs, target.root_dir)
    : spawnSync(command, commandArgs, { cwd: target.root_dir, stdio: "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`stage script ${script} failed (${result.status ?? 1}): ${result.stderr ?? ""}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function stageArtifactPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
): string {
  const buildRoot = path.join(target.workspace_dir, ".build");
  switch (stage) {
    case "pass1": return path.join(buildRoot, "pass1", `${taskId}.json`);
    case "paper_metadata": return path.join(buildRoot, "paper-metadata", `${taskId}.json`);
    case "paper_lexicon": return path.join(buildRoot, "paper-lexicon", `${taskId}.json`);
    case "profile_sidecar": return path.join(buildRoot, "profile-sidecar", `${taskId}.json`);
    case "pass2": return path.join(buildRoot, "pass2", `${taskId}.json`);
    case "book_structure": return taskId === "stitch"
      ? path.join(buildRoot, "book-structure", "stitch.json")
      : path.join(buildRoot, "book-structure", "units", `${taskId.replace(/^unit:/, "")}.json`);
    case "paper_reading_guide": throw new Error("paper_reading_guide has no semantic writer");
  }
}

export function runAutomaticBuildStageWriter(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  candidatePath: string,
): AutomaticBuildWriterResult {
  const script = STAGE_COMMANDS[stage].write;
  if (!script) throw new Error(`stage ${stage} does not support write`);
  forwardStageScript(
    target,
    script,
    [target.source_path, taskId, candidatePath, ...stageScriptArgs(target).slice(1)],
    true,
  );
  return { artifact_path: stageArtifactPath(target, stage, taskId) };
}

export function recordAutomaticBuildAttempt(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  outcome: "failure" | "success" | "reset",
  error?: string,
  options: {
    attempt?: number;
    event_id?: string;
    created_at?: string;
    lease_ref?: string;
    lease_token?: string;
    now?: string;
  } = {},
): AutomaticBuildAttemptRecord {
  const current = readAutomaticBuildAttemptSnapshot(target).stages[stage]?.[taskId];
  const attempt = options.attempt
    ?? (outcome === "reset" ? current?.last_attempt ?? 1 : current?.next_attempt ?? 1);
  if (Boolean(options.lease_ref) !== Boolean(options.lease_token)) {
    throw new Error("lease_ref and lease_token must be provided together");
  }
  if (options.lease_ref && options.lease_token) {
    const terminalExists = existsSync(path.join(path.dirname(options.lease_ref), "result.json"));
    const lease = terminalExists
      ? readAutomaticBuildLease(target, options.lease_ref, options.lease_token)
      : assertActiveAutomaticBuildLease(target, options.lease_ref, options.lease_token, options.now);
    if (lease.stage !== stage || lease.work_unit_id !== taskId || lease.attempt !== attempt) {
      throw new Error(`attempt event does not match lease identity: ${stage}/${taskId}/${attempt}`);
    }
  }
  return recordAutomaticBuildAttemptEvent(target, {
    stage,
    work_unit_id: taskId,
    attempt,
    event_id: options.event_id ?? `${stage}:${taskId}:${attempt}:${outcome}`,
    outcome,
    ...(error ? { diagnostic: error } : {}),
    ...(options.created_at ? { created_at: options.created_at } : {}),
  });
}

function historicalUsageForStage(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): AutomaticBuildHistoricalUsageV1 | undefined {
  const file = automaticBuildStageMetricsSummaryPath(target, stage);
  if (!existsSync(file)) return undefined;
  const metrics = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStageMetricsSummaryV1;
  if (metrics.version !== "automatic_build_stage_metrics_summary.v1") return undefined;
  return {
    source: "automatic_build_stage_metrics.v1",
    known_usage_coverage: metrics.usage.known_usage_coverage,
    exact_input_tokens: metrics.usage.input_tokens,
    exact_output_tokens: metrics.usage.output_tokens,
  };
}

function historicalPerformanceForStage(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): AutomaticBuildStageMetricsSummaryV1["performance_history"] | undefined {
  const file = automaticBuildStageMetricsSummaryPath(target, stage);
  if (!existsSync(file)) return undefined;
  const metrics = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStageMetricsSummaryV1;
  if (metrics.version !== "automatic_build_stage_metrics_summary.v1") return undefined;
  return metrics.performance_history;
}

function actualUsageForBuildPlan(
  target: AutomaticBuildTarget,
  plan: BuildPlanV1,
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>,
  now: string,
): AutomaticBuildPlanActualUsageV1 {
  let attempts = 0;
  let knownAttempts = 0;
  let exactInputTokens = 0;
  let exactOutputTokens = 0;
  for (const stage of plan.public_stage_closure as AutomaticBuildStage[]) {
    const stageState = snapshot.stages.find((item) => item.stage === stage);
    const summary = buildAutomaticBuildStageMetricsSummary(target, stage, {
      now,
      work_units: stageState?.work_units ?? [],
    });
    const stageAttempts = summary.usage.fully_known_attempts
      + summary.usage.partially_known_attempts
      + summary.usage.unavailable_attempts;
    attempts += stageAttempts;
    knownAttempts += summary.usage.fully_known_attempts + summary.usage.partially_known_attempts;
    exactInputTokens += summary.usage.input_tokens;
    exactOutputTokens += summary.usage.output_tokens;
  }
  return {
    known_usage_coverage: attempts ? knownAttempts / attempts : 0,
    exact_input_tokens: exactInputTokens,
    exact_output_tokens: exactOutputTokens,
  };
}

function buildPlanBudgetEvaluation(
  target: AutomaticBuildTarget,
  plan: BuildPlanV1,
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>,
  now: string,
  preflight?: AutomaticBuildPreflightV1,
): AutomaticBuildPlanBudgetEvaluationV1 {
  return evaluateAutomaticBuildPlanBudget({
    plan,
    actual_usage: actualUsageForBuildPlan(target, plan, snapshot, now),
    ...(preflight ? {
      current_forecast: {
        estimated_total_tokens_upper: preflight.cost_scope.remaining.estimated_total_tokens_upper,
        wall_clock_p95_minutes: preflight.wall_clock.predicted.remaining.p95_ms / 60_000,
        preflight_evaluation_digest: preflight.preflight_evaluation_digest,
      },
    } : {}),
  });
}

function preflightForAction(
  target: AutomaticBuildTarget,
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>,
  action: ReturnType<typeof nextAutomaticBuildAction> | ReturnType<typeof nextPlannedAutomaticBuildAction>,
  requestedWorkers: number,
  availableAgentSlots: number,
  qualityProfile: ExtractionQualityProfile,
  budget: AutomaticBuildBudgetLimitsV1,
  wallBudget?: AutomaticBuildWallBudgetV1,
  executorProvenance?: AutomaticBuildExecutorProvenanceV1,
  buildPlan?: BuildPlanV1,
): AutomaticBuildPreflightV1 | undefined {
  if (action.kind !== "extract") return undefined;
  const stage = snapshot.stages.find((item) => item.stage === action.stage);
  if (!stage?.work_units) throw new Error(`automatic preflight requires descriptor plan: ${action.stage}`);
  const historicalMetrics = historicalUsageForStage(target, action.stage);
  const historicalPerformance = historicalPerformanceForStage(target, action.stage);
  return buildAutomaticBuildPreflight({
    target_ref: target.target_ref,
    stage: action.stage,
    work_units: stage.work_units,
    pending_ids: stage.pending_tasks,
    quality_profile: qualityProfile,
    requested_workers: requestedWorkers,
    available_agent_slots: availableAgentSlots,
    budget,
    ...(historicalMetrics ? { historical_metrics: historicalMetrics } : {}),
    ...(historicalPerformance ? { historical_performance: historicalPerformance } : {}),
    ...(wallBudget ? { wall_budget: wallBudget } : {}),
    ...(executorProvenance ? { executor_provenance: executorProvenance } : {}),
    ...(buildPlan ? { build_plan: buildPlan } : {}),
  });
}

function persistAutomaticBuildPlanAcceptance(
  target: AutomaticBuildTarget,
  preflight: AutomaticBuildPreflightV1,
  acceptedAt: string,
): string {
  const dir = path.join(target.workspace_dir, ".build", "automatic-build", "v2", "preflight", preflight.stage);
  const file = path.join(dir, `${preflight.plan_digest}.json`);
  const value = {
    version: "automatic_build_plan_acceptance.v1",
    target_ref: target.target_ref,
    stage: preflight.stage,
    plan_digest: preflight.plan_digest,
    descriptor_plan_digest: preflight.descriptor_plan_digest,
    policy_digest: preflight.policy_digest,
    quality_profile: preflight.quality_profile,
    ...(preflight.build_plan ? { build_plan: preflight.build_plan } : {}),
    budget: preflight.budget.limits,
    accepted_at: acceptedAt,
  };
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(file, "utf8")) as typeof value;
    if (existing.plan_digest !== value.plan_digest
      || existing.policy_digest !== value.policy_digest
      || existing.quality_profile !== value.quality_profile
      || JSON.stringify(existing.build_plan ?? null) !== JSON.stringify(value.build_plan ?? null)) {
      throw new Error(`automatic build plan acceptance conflicts with current preflight: ${file}`);
    }
  }
  return file;
}

function persistAutomaticBuildEvaluationAcceptance(
  target: AutomaticBuildTarget,
  preflight: AutomaticBuildPreflightV1,
  acceptedAt: string,
): string {
  const dir = path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "preflight",
    preflight.stage,
    "evaluations",
  );
  const file = path.join(dir, `${preflight.preflight_evaluation_digest}.json`);
  const value = {
    version: "automatic_build_evaluation_acceptance.v1",
    target_ref: target.target_ref,
    stage: preflight.stage,
    plan_digest: preflight.plan_digest,
    preflight_evaluation_digest: preflight.preflight_evaluation_digest,
    accepted_at: acceptedAt,
  };
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(file, "utf8")) as typeof value;
    if (existing.plan_digest !== value.plan_digest
      || existing.preflight_evaluation_digest !== value.preflight_evaluation_digest) {
      throw new Error(`automatic build evaluation acceptance conflicts with current preflight: ${file}`);
    }
  }
  return file;
}

export function automaticBuildPlan(
  targetInput: string,
  rootDir: string,
  options: AutomaticBuildPlanOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const qualityProfile = options.quality_profile ?? "full";
  const requestedWorkers = options.requested_workers ?? 1;
  const availableAgentSlots = options.available_agent_slots ?? requestedWorkers;
  const budget = options.budget ?? DEFAULT_AUTOMATIC_BUILD_BUDGET;
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfile });
  const nextAction = options.build_plan
    ? nextPlannedAutomaticBuildAction(snapshot, options.build_plan, Number.MAX_SAFE_INTEGER, {
        quality_profile: qualityProfile,
      })
    : nextAutomaticBuildAction(snapshot, Number.MAX_SAFE_INTEGER);
  const preflight = preflightForAction(
    target,
    snapshot,
    nextAction,
    requestedWorkers,
    availableAgentSlots,
    qualityProfile,
    budget,
    options.wall_budget,
    options.executor_provenance,
    options.build_plan,
  );
  return {
    version: "automatic_build_plan.v1",
    protocol: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
    release: AUTOMATIC_BUILD_RELEASE_V2,
    snapshot,
    next_action: nextAction,
    preflight: preflight ?? null,
  };
}

export function prepareExplicitLegacyBuildPlan(
  targetInput: string,
  rootDir: string,
  options: {
    now?: string;
    budget?: BuildPlanV1["budget"];
    book_id?: string;
    pass2?: Pass2PlanChoice;
  } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const now = options.now ?? new Date().toISOString();
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: "full" });
  const selection = mapLegacyBuildInvocation({
    invocation: "explicit_full_build",
    target: {
      book_id: target.book_id,
      source_fingerprint: target.target_ref.input_fingerprint,
      content_profile: target.profile_id === "paper"
        ? { id: "paper", version: "paper_v0" }
        : { id: "technical_learning", version: "technical_learning_v0" },
      public_freshness: inspectAutomaticBuildStageFreshness(snapshot, { quality_profile: "full" }),
    },
    now,
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.pass2 ? { pass2: options.pass2 } : {}),
  });
  if (!selection?.plan) throw new Error("explicit legacy full build did not compile a BuildPlan");
  const invocationId = createHash("sha256")
    .update(canonicalAutomaticBuildJson({ target: target.target_ref, now, pass2: options.pass2 ?? "enabled" }), "utf8")
    .digest("hex")
    .slice(0, 16);
  const directory = path.join(target.workspace_dir, ".build", "automatic-build", "v2", "legacy-plans");
  const buildPlanPath = path.join(directory, `${invocationId}.json`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(buildPlanPath, `${canonicalAutomaticBuildJson(selection.plan)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(buildPlanPath, "utf8")) as BuildPlanV1;
    if (canonicalAutomaticBuildJson(existing) !== canonicalAutomaticBuildJson(selection.plan)) {
      throw new Error(`explicit legacy BuildPlan conflicts with its invocation record: ${buildPlanPath}`);
    }
  }
  return {
    version: "explicit_legacy_build_plan.v1" as const,
    invocation: "explicit_full_build" as const,
    target_ref: target.target_ref,
    build_plan_path: buildPlanPath,
    plan: selection.plan,
  };
}

function expandAction(
  target: AutomaticBuildTarget,
  maxParallel: number,
  leaseOptions: { owner: string; now: string; reserve_ttl_ms: number; run_ttl_ms?: number },
  availableAgentSlots: number,
  qualityProfile: ExtractionQualityProfile,
  budget: AutomaticBuildBudgetLimitsV1,
  wallBudget?: AutomaticBuildWallBudgetV1,
  executorProvenance?: AutomaticBuildExecutorProvenanceV1,
  acceptedPlanDigest?: string,
  acceptedEvaluationDigest?: string,
  executorDispatches = false,
  buildPlan?: BuildPlanV1,
) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfile });
  const action = nextPlannedAutomaticBuildAction(snapshot, buildPlan, Number.MAX_SAFE_INTEGER, {
    quality_profile: qualityProfile,
  });
  if (action.kind === "needs_user") return { snapshot, action };
  if (!buildPlan) throw new Error("planned automatic action is missing its BuildPlan");
  const settledPlanBudget = action.kind === "extract"
    ? undefined
    : buildPlanBudgetEvaluation(target, buildPlan, snapshot, leaseOptions.now);
  if (settledPlanBudget?.status === "exceeded") {
    return {
      snapshot,
      plan_budget: settledPlanBudget,
      action: {
        kind: "needs_user" as const,
        reason: "plan_budget_exceeded" as const,
        plan_id: buildPlan.plan_id,
        plan_digest: buildPlan.plan_digest,
        violations: settledPlanBudget.violations,
        receipt_digest: settledPlanBudget.receipt_digest,
        message: "actual usage plus remaining forecast exceeds the confirmed BuildPlan budget",
      },
    };
  }
  if (action.kind === "extract") {
    const targetInput = targetCommandInput(target);
    const legacyAudit = auditAutomaticBuildLegacy(target, action.stage);
    if (legacyAudit.legacy_artifacts || legacyAudit.invalid_artifacts) {
      const migration = readAutomaticBuildMigrationDecision(target);
      if (!migration) {
        return {
          snapshot,
          legacy_audit: legacyAudit,
          action: {
            kind: "needs_user",
            reason: "legacy_migration_required",
            stage: action.stage,
            policy_status: legacyAudit.policy_status,
            message: "legacy artifacts require an explicit legacy_resume or v2_rebuild decision before v2 claim",
            audit_command: scriptCommand("automatic-build.ts", [
              "audit-legacy", targetInput, action.stage, ...targetResolutionCommandArgs(target),
            ]),
            migration_commands: (["legacy_resume", "v2_rebuild"] as const).map((mode) => scriptCommand(
              "automatic-build.ts",
              ["migration-mode", targetInput, mode, ...targetResolutionCommandArgs(target)],
            )),
          },
        };
      }
      if (migration.mode === "legacy_resume") {
        return {
          snapshot,
          legacy_audit: legacyAudit,
          migration,
          action: {
            kind: "needs_user",
            reason: "legacy_resume_selected",
            stage: action.stage,
            policy_status: "legacy_policy_unknown",
            message: "continue this stage only through the frozen production v1 contract; it cannot become v2 complete",
          },
        };
      }
    }
    const attempts = readAutomaticBuildAttemptSnapshot(target).stages[action.stage] ?? {};
    const exhausted = action.task_ids
      .map((taskId) => ({ task_id: taskId, ...attempts[taskId] }))
      .filter((item) => (item.failures ?? 0) >= MAX_ATTEMPTS);
    if (exhausted.length) {
      return {
        snapshot,
        action: {
          kind: "needs_user",
          reason: "retry_exhausted",
          stage: action.stage,
          tasks: exhausted,
          message: `semantic extraction failed ${MAX_ATTEMPTS} times; inspect diagnostics before resetting`,
          reset_commands: exhausted.map((item) => scriptCommand("automatic-build.ts", [
            "record-attempt", targetInput, action.stage, item.task_id, "reset",
            ...targetResolutionCommandArgs(target),
            "--attempt", String(item.last_attempt),
            "--event-id", `${action.stage}:${item.task_id}:${item.last_attempt}:reset`,
          ])),
        },
      };
    }
    const executionBlockers = action.task_ids
      .map((taskId) => ({
        task_id: taskId,
        inspection: inspectAutomaticBuildTaskClaim(target, action.stage, taskId, {
          now: leaseOptions.now,
          max_semantic_attempts: MAX_ATTEMPTS,
          max_lease_epochs: MAX_LEASE_EPOCHS,
        }),
      }))
      .filter((item) => item.inspection.status === "retry_exhausted"
        || item.inspection.status === "executor_instability");
    if (executionBlockers.length) {
      const reason = executionBlockers.some((item) => item.inspection.status === "retry_exhausted")
        ? "retry_exhausted"
        : "executor_instability";
      return {
        snapshot,
        action: {
          kind: "needs_user",
          reason,
          stage: action.stage,
          tasks: executionBlockers.map(({ task_id, inspection }) => ({ task_id, ...inspection })),
          message: reason === "retry_exhausted"
            ? `semantic extraction failed ${MAX_ATTEMPTS} times; inspect diagnostics before resetting`
            : `task lease recovery exceeded ${MAX_LEASE_EPOCHS} epochs; inspect executor stability before resetting`,
        },
      };
    }
    const preflight = preflightForAction(
      target,
      snapshot,
      action,
      maxParallel,
      availableAgentSlots,
      qualityProfile,
      budget,
      wallBudget,
      executorProvenance,
      buildPlan,
    )!;
    const planBudget = buildPlanBudgetEvaluation(target, buildPlan, snapshot, leaseOptions.now, preflight);
    if (planBudget.status === "exceeded") {
      return {
        snapshot,
        preflight,
        plan_budget: planBudget,
        action: {
          kind: "needs_user" as const,
          reason: "plan_budget_exceeded" as const,
          stage: action.stage,
          plan_id: buildPlan.plan_id,
          plan_digest: buildPlan.plan_digest,
          violations: planBudget.violations,
          receipt_digest: planBudget.receipt_digest,
          message: "actual usage plus remaining forecast exceeds the confirmed BuildPlan budget",
        },
      };
    }
    if (preflight.budget.status === "exceeded") {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: "budget_exceeded",
          stage: action.stage,
          plan_digest: preflight.plan_digest,
          violations: preflight.budget.violations,
          message: "automatic build preflight exceeds the configured model-work budget",
        },
      };
    }
    if (preflight.wall_clock.budget.status !== "within_budget") {
      const lowConfidence = preflight.wall_clock.budget.status === "low_confidence";
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: lowConfidence ? "low_confidence_wall_budget" : "wall_budget_exceeded",
          stage: action.stage,
          plan_digest: preflight.plan_digest,
          preflight_evaluation_digest: preflight.preflight_evaluation_digest,
          violations: preflight.wall_clock.budget.violations,
          confidence: preflight.wall_clock.confidence,
          message: lowConfidence
            ? "wall-clock or agent-start budget is exceeded without fully matched performance history"
            : "automatic build preflight exceeds the configured wall-clock budget",
        },
      };
    }
    if (preflight.worker_plan.available_agent_slots === 0) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: "executor_unavailable",
          stage: action.stage,
          plan_digest: preflight.plan_digest,
          message: "no dedicated Codex executor slot is currently available",
        },
      };
    }
    if (!acceptedPlanDigest) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: "preflight_required",
          stage: action.stage,
          plan_digest: preflight.plan_digest,
          message: "inspect and accept the stable preflight plan before the first claim",
        },
      };
    }
    if (acceptedPlanDigest !== preflight.plan_digest) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: "plan_changed",
          stage: action.stage,
          accepted_plan_digest: acceptedPlanDigest,
          plan_digest: preflight.plan_digest,
          message: "the accepted preflight digest does not match the current descriptor plan",
        },
      };
    }
    if (wallBudget && !acceptedEvaluationDigest) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: "evaluation_required",
          stage: action.stage,
          plan_digest: preflight.plan_digest,
          preflight_evaluation_digest: preflight.preflight_evaluation_digest,
          message: "inspect and accept the current wall-clock evaluation before the first claim",
        },
      };
    }
    if (wallBudget && acceptedEvaluationDigest !== preflight.preflight_evaluation_digest) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: "evaluation_changed",
          stage: action.stage,
          plan_digest: preflight.plan_digest,
          accepted_evaluation_digest: acceptedEvaluationDigest,
          preflight_evaluation_digest: preflight.preflight_evaluation_digest,
          message: "the accepted wall-clock evaluation does not match current history or remaining work",
        },
      };
    }
    const spec = STAGE_COMMANDS[action.stage];
    if (!spec.input || !spec.write || !spec.prompt) throw new Error(`stage ${action.stage} is not a semantic extraction stage`);
    const allPendingUnits = action.work_units ?? [];
    const scheduled = selectAutomaticBuildCostBatch(allPendingUnits, {
      max_tasks: allPendingUnits.length,
      max_total_score: Math.min(
        preflight.worker_plan.max_batch_score,
        preflight.worker_plan.max_parallel_cost,
      ),
    });
    if (!scheduled.units.length) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user",
          reason: "budget_exceeded",
          stage: action.stage,
          plan_digest: preflight.plan_digest,
          violations: [{
            code: "max_batch_score",
            actual: Math.min(...(action.work_units ?? []).map((unit) => unit.cost.score)),
            limit: preflight.worker_plan.max_batch_score,
          }],
          message: "no pending work unit fits the configured batch cost",
        },
      };
    }
    const acceptancePath = persistAutomaticBuildPlanAcceptance(target, preflight, leaseOptions.now);
    const evaluationAcceptancePath = wallBudget
      ? persistAutomaticBuildEvaluationAcceptance(target, preflight, leaseOptions.now)
      : undefined;
    if (executorDispatches) {
      const handoff = selectAutomaticBuildDispatchHandoff(target, {
        accepted_plan_digest: preflight.plan_digest,
        current_dispatch_plan: preflight.dispatch_plan,
        available_new_executor_slots: preflight.worker_plan.max_workers,
        created_at: leaseOptions.now,
      });
      const selectedDispatches = handoff.selected_manifests;
      const dispatchRunId = automaticBuildDispatchRunId(handoff.persisted_plan.created_at);
      if (!selectedDispatches.length) {
        if (handoff.active_dispatch_ids.length) {
          return {
            snapshot,
            preflight,
            action: {
              kind: "waiting" as const,
              reason: "active_dispatches",
              stage: action.stage,
              active_dispatch_ids: handoff.active_dispatch_ids,
              retry_after_ms: Math.min(leaseOptions.reserve_ttl_ms, 30_000),
            },
          };
        }
        return {
          snapshot,
          preflight,
          action: {
            kind: "needs_user",
            reason: "executor_unavailable",
            stage: action.stage,
            plan_digest: preflight.plan_digest,
            message: "no executor dispatch can be assigned to the currently available dedicated slots",
          },
        };
      }
      const descriptorById = new Map(allPendingUnits.map((descriptor) => [descriptor.work_unit_id, descriptor]));
      const dispatches = selectedDispatches.map((manifest) => {
        const runTtlMs = leaseOptions.run_ttl_ms
          ?? preflight.wall_clock.adaptive_run_ttl_ms_by_kind[manifest.kind]
          ?? DEFAULT_RUN_TTL_MS;
        const persisted = persistAutomaticBuildDispatch(target, manifest, {
          owner: `automatic-build-dispatch:${manifest.dispatch_id}:${dispatchRunId}`,
          created_at: leaseOptions.now,
          reserve_ttl_ms: leaseOptions.reserve_ttl_ms,
          run_ttl_ms: runTtlMs,
          dispatch_run_id: dispatchRunId,
        });
        return {
          version: "automatic_build_dispatch_executor.v1" as const,
          manifest,
          dispatch_run_id: dispatchRunId,
          manifest_path: persisted.manifest_path,
          cwd: target.root_dir,
          next_command: scriptCommand("automatic-build.ts", [
            "dispatch.next", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, ...targetResolutionCommandArgs(target),
          ]),
          inspect_command: scriptCommand("automatic-build.ts", [
            "dispatch.inspect", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, ...targetResolutionCommandArgs(target),
          ]),
          finish_command: scriptCommand("automatic-build.ts", [
            "dispatch.finish", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, ...targetResolutionCommandArgs(target),
          ]),
          interrupt_command: scriptCommand("automatic-build.ts", [
            "dispatch.finish", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, "--terminal-reason", "executor_interrupted",
            ...targetResolutionCommandArgs(target),
          ]),
          accounting: {
            work_units: manifest.ordered_work_unit_ids.length,
            total_score: manifest.ordered_work_unit_ids.reduce(
              (sum, workUnitId) => sum + (descriptorById.get(workUnitId)?.cost.score ?? 0),
              0,
            ),
          },
        };
      });
      const dispatchedIds = new Set(selectedDispatches.flatMap((dispatch) => dispatch.ordered_work_unit_ids));
      return {
        snapshot,
        preflight,
        plan_budget: planBudget,
        action: {
          kind: "dispatch" as const,
          stage: action.stage,
          plan_acceptance_path: acceptancePath,
          ...(evaluationAcceptancePath ? { evaluation_acceptance_path: evaluationAcceptancePath } : {}),
          cwd: target.root_dir,
          extractor_prompt: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
            ? undefined
            : path.join(PLUGIN_ROOT, "agents", spec.prompt),
          extractor_prompt_command: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
            ? [process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "prompt", spec.prompt]
            : undefined,
          dispatches,
          dispatch_plan_digest: handoff.persisted_plan.dispatch_plan.dispatch_plan_digest,
          active_dispatch_ids: handoff.active_dispatch_ids,
          completed_dispatch_ids: handoff.completed_dispatch_ids,
          scheduled_batch: {
            total_score: dispatches.reduce((sum, dispatch) => sum + dispatch.accounting.total_score, 0),
            deferred_ids: allPendingUnits
              .filter((unit) => !dispatchedIds.has(unit.work_unit_id))
              .map((unit) => unit.work_unit_id),
          },
          receipt_aggregation: {
            version: "automatic_build_dispatch_receipt_aggregation.v1" as const,
            expected_receipts: dispatches.length,
            max_receipt_bytes: 16_384,
            max_total_bytes: dispatches.length * 16_384,
            candidate_payload_forbidden: true,
          },
        },
      };
    }
    const claims: Array<{
      task_id: string;
      descriptor: (typeof allPendingUnits)[number];
      status: "leased";
      lease_ref: string;
      lease: AutomaticBuildTaskLease;
      execution_identity: AutomaticBuildExecutionIdentityV1;
    }> = [];
    let claimedScore = 0;
    for (const descriptor of scheduled.units) {
      const taskId = descriptor.work_unit_id;
      const binding = action.task_bindings?.[taskId];
      if (!binding) throw new Error(`automatic semantic task is missing policy binding: ${action.stage}/${taskId}`);
      const claim = claimAutomaticBuildTask(target, action.stage, taskId, {
        owner: leaseOptions.owner,
        now: leaseOptions.now,
        reserve_ttl_ms: leaseOptions.reserve_ttl_ms,
        binding,
      });
      if (claim.status === "leased") {
        claims.push({ task_id: taskId, descriptor, ...claim });
        claimedScore += descriptor.cost.score;
      }
      if (claims.length >= preflight.worker_plan.max_workers) break;
    }
    if (claims.length === 0) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "waiting",
          reason: "active_leases",
          stage: action.stage,
          retry_after_ms: Math.min(leaseOptions.reserve_ttl_ms, 30_000),
        },
      };
    }
    return {
      snapshot,
      preflight,
      plan_budget: planBudget,
      action: {
        ...action,
        task_ids: claims.map((claim) => claim.task_id),
        work_units: claims.map((claim) => claim.descriptor),
        plan_acceptance_path: acceptancePath,
        ...(evaluationAcceptancePath ? { evaluation_acceptance_path: evaluationAcceptancePath } : {}),
        scheduled_batch: {
          total_score: claimedScore,
          deferred_ids: allPendingUnits
            .filter((unit) => !claims.some((claim) => claim.task_id === unit.work_unit_id))
            .map((unit) => unit.work_unit_id),
        },
        receipt_aggregation: {
          version: "automatic_build_receipt_aggregation.v1",
          expected_receipts: claims.length,
          max_receipt_bytes: 4_096,
          max_total_bytes: claims.length * 4_096,
          candidate_payload_forbidden: true,
        },
        cwd: target.root_dir,
        extractor_prompt: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
          ? undefined
          : path.join(PLUGIN_ROOT, "agents", spec.prompt),
        extractor_prompt_command: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
          ? [process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "prompt", spec.prompt]
          : undefined,
        tasks: claims.map((claim) => {
          const taskId = claim.task_id;
          const attemptNumber = claim.execution_identity.semantic_attempt;
          const runTtlMs = leaseOptions.run_ttl_ms
            ?? preflight.wall_clock.adaptive_run_ttl_ms_by_kind[claim.descriptor.kind]
            ?? DEFAULT_RUN_TTL_MS;
          const leaseArgs = ["--lease-ref", claim.lease_ref, "--lease-token", claim.lease.token];
          const candidatePath = path.join(path.dirname(claim.lease_ref), "candidate.json");
          return {
            task_id: taskId,
            attempt_number: attemptNumber,
            execution_identity: claim.execution_identity,
            lease_ref: claim.lease_ref,
            lease: claim.lease,
            descriptor: claim.descriptor,
            candidate_path: candidatePath,
            usage_path: automaticBuildUsageReceiptPath(claim.lease_ref),
            input_command: scriptCommand("automatic-build.ts", [
              "input", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), "--run-ttl-ms", String(runTtlMs), ...leaseArgs,
            ]),
            candidate_command: scriptCommand("automatic-build.ts", [
              "candidate", targetInput, action.stage, taskId, "{candidate_source}",
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            submit_command: scriptCommand("automatic-build.ts", [
              "submit", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            fail_command: scriptCommand("automatic-build.ts", [
              "fail", targetInput, action.stage, taskId,
              "--diagnostic-code", "{diagnostic_code}", "--message", "{diagnostic}",
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            inspect_command: scriptCommand("automatic-build.ts", [
              "inspect", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            heartbeat_command: scriptCommand("automatic-build.ts", [
              "heartbeat", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
          };
        }),
      },
    };
  }
  if (action.kind === "close_stage") {
    if (action.stage !== "paper_reading_guide") {
      const stageState = snapshot.stages.find((stage) => stage.stage === action.stage);
      if (!stageState) throw new Error(`quality gate stage is missing from snapshot: ${action.stage}`);
      const qualityReport = collectAutomaticBuildStageQuality(target, stageState, qualityProfile);
      if (qualityReport.gate_status !== "passed") {
        return {
          snapshot,
          plan_budget: settledPlanBudget,
          quality_report: qualityReport,
          action: {
            kind: "needs_user",
            reason: "quality_gate_failed",
            stage: action.stage,
            gate_status: qualityReport.gate_status,
            quality_report: qualityReport,
            message: "stage integrity or the selected versioned quality floor did not pass; public artifacts were not published",
          },
        };
      }
      return {
        snapshot,
        plan_budget: settledPlanBudget,
        quality_report: qualityReport,
        action: {
          ...action,
          quality_report_path: automaticBuildStageQualityReportPath(target, action.stage),
          cwd: target.root_dir,
          command: scriptCommand("automatic-build.ts", [
            "close", targetCommandInput(target), action.stage,
            ...targetResolutionCommandArgs(target),
            "--quality-profile", qualityProfile,
          ]),
        },
      };
    }
    return {
      snapshot,
      plan_budget: settledPlanBudget,
      action: {
        ...action,
        cwd: target.root_dir,
        command: scriptCommand("automatic-build.ts", [
          "close", targetCommandInput(target), action.stage, ...targetResolutionCommandArgs(target),
        ]),
        ...(action.stage === "paper_reading_guide"
          ? { verification_path: path.join(target.workspace_dir, ".build", "paper-reading-guide", "verification.json") }
          : {}),
      },
    };
  }
  return { snapshot, plan_budget: settledPlanBudget, action };
}

function valueArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printAutomaticBuildJson(value: unknown): void {
  process.stdout.write(canonicalAutomaticBuildJson(value));
}

export function automaticBuildNext(
  targetInput: string,
  rootDir: string,
  maxParallel = 5,
  options: AutomaticBuildNextOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const protocol = resolveAutomaticBuildClaimProtocol(options.protocol, options.executor_dispatches === true);
  const leaseOptions = {
    owner: options.owner ?? `automatic-build:${process.pid}:${randomUUID()}`,
    now: options.now ?? new Date().toISOString(),
    reserve_ttl_ms: options.lease_ttl_ms ?? DEFAULT_RESERVE_TTL_MS,
    ...(options.run_ttl_ms !== undefined ? { run_ttl_ms: options.run_ttl_ms } : {}),
  };
  return {
    version: "automatic_build_next.v1",
    protocol,
    release: AUTOMATIC_BUILD_RELEASE_V2,
    ...expandAction(
      target,
      maxParallel,
      leaseOptions,
      options.available_agent_slots ?? maxParallel,
      options.quality_profile ?? "full",
      options.budget ?? DEFAULT_AUTOMATIC_BUILD_BUDGET,
      options.wall_budget,
      options.executor_provenance,
      options.accepted_plan_digest,
      options.accepted_evaluation_digest,
      protocol === AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      options.build_plan,
    ),
  };
}

export function automaticBuildProtocolDoctor(
  targetInput: string,
  rootDir: string,
  options: AutomaticBuildPlanOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const plan = automaticBuildPlan(targetInput, rootDir, options);
  const attempts = AUTOMATIC_BUILD_STAGES.flatMap((stage) => listAutomaticBuildStoredAttempts(target, stage));
  const currentExecutionIdentities = attempts.filter(
    (attempt) => attempt.execution_identity?.identity_source === "native",
  ).length;
  const legacyInferredExecutionIdentities = attempts.filter(
    (attempt) => attempt.execution_identity?.identity_source === "legacy_inferred",
  ).length;
  const legacyAudit = auditAutomaticBuildLegacy(target);
  const stages = plan.snapshot.stages.map((stage) => {
    const totalWorkUnits = stage.work_units?.length ?? stage.pending_tasks.length;
    return {
      stage: stage.stage,
      closed: stage.closed,
      total_work_units: totalWorkUnits,
      fresh_work_units: Math.max(0, totalWorkUnits - stage.pending_tasks.length),
      pending_work_units: stage.pending_tasks.length,
      fresh_v2_artifacts: legacyAudit.artifacts.filter((artifact) => artifact.stage === stage.stage
        && artifact.format === "v2"
        && artifact.source_freshness === "fresh").length,
    };
  });
  return {
    version: "automatic_build_protocol_doctor.v1" as const,
    status: "compatible" as const,
    production_default: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
    release: AUTOMATIC_BUILD_RELEASE_V2,
    protocol_capabilities: [
      {
        protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
        readable: true,
        new_claims: true,
        resume: "dispatch_and_v2_task_state" as const,
      },
      {
        protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
        readable: true,
        new_claims: false,
        resume: "explicit_task_executor_rollback" as const,
      },
      {
        protocol: AUTOMATIC_BUILD_RELEASE_V2.readable_protocols[2],
        readable: true,
        new_claims: false,
        resume: "explicit_legacy_migration_only" as const,
      },
    ],
    target_ref: target.target_ref,
    target_state: {
      stages,
      fresh_work_units: stages.reduce((sum, stage) => sum + stage.fresh_work_units, 0),
      pending_work_units: stages.reduce((sum, stage) => sum + stage.pending_work_units, 0),
      fresh_v2_artifacts: stages.reduce((sum, stage) => sum + stage.fresh_v2_artifacts, 0),
      pending_dispatches: plan.preflight?.dispatch_plan.dispatches.length ?? 0,
      persisted_task_attempts: attempts.length,
      current_execution_identities: currentExecutionIdentities,
      legacy_inferred_execution_identities: legacyInferredExecutionIdentities,
      artifact_policy_status: legacyAudit.policy_status,
      legacy_artifacts: legacyAudit.legacy_artifacts,
      v2_artifacts: legacyAudit.v2_artifacts,
      invalid_artifacts: legacyAudit.invalid_artifacts,
      dry_run_mutates_state: false as const,
    },
  };
}

export function automaticBuildDispatchNext(
  targetInput: string,
  rootDir: string,
  stage: AutomaticBuildStage,
  dispatchId: string,
  options: { now?: string; dispatch_run_id?: string; book_id?: string } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const persisted = readAutomaticBuildDispatch(target, stage, dispatchId, options.dispatch_run_id);
  const snapshot = buildAutomaticBuildSnapshot(target, {
    quality_profile: persisted.manifest.policy_fingerprint.quality_profile,
  });
  const stageState = snapshot.stages.find((candidate) => candidate.stage === stage);
  if (!stageState?.work_units) throw new Error(`dispatch stage descriptor plan is unavailable: ${stage}/${dispatchId}`);
  const advanced = advanceAutomaticBuildDispatch(target, stage, dispatchId, {
    descriptors: stageState.work_units,
    task_bindings: stageState.task_bindings ?? {},
    dispatch_run_id: persisted.dispatch_run_id,
    ...(options.now ? { now: options.now } : {}),
    max_semantic_attempts: MAX_ATTEMPTS,
    max_lease_epochs: MAX_LEASE_EPOCHS,
  });
  const base = {
    version: "automatic_build_dispatch_next.v1" as const,
    protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
    dispatch_id: dispatchId,
    stage,
  };
  if (advanced.status === "finished") {
    return { ...base, action: { kind: "finished" as const, receipt: advanced.receipt } };
  }
  if (advanced.status === "ready_to_finish") {
    return {
      ...base,
      action: {
        kind: "finish" as const,
        task_receipts: advanced.task_receipts,
        finish_command: scriptCommand("automatic-build.ts", [
          "dispatch.finish", targetCommandInput(target), stage, dispatchId, ...targetResolutionCommandArgs(target),
          "--dispatch-run", persisted.dispatch_run_id,
        ]),
      },
    };
  }
  if (advanced.status === "waiting") {
    return {
      ...base,
      action: {
        kind: "waiting" as const,
        work_unit_id: advanced.work_unit_id,
        retry_after_ms: advanced.retry_after_ms,
      },
    };
  }
  if (advanced.status === "retry_exhausted" || advanced.status === "executor_instability") {
    return {
      ...base,
      action: {
        kind: "needs_user" as const,
        reason: advanced.status,
        work_unit_id: advanced.work_unit_id,
      },
    };
  }
  if (advanced.status !== "leased") throw new Error(`unhandled dispatch state: ${advanced.status}`);
  const claim = advanced.claim;
  const taskId = advanced.descriptor.work_unit_id;
  const leaseArgs = ["--lease-ref", claim.lease_ref, "--lease-token", claim.lease.token];
  const candidatePath = path.join(path.dirname(claim.lease_ref), "candidate.json");
  return {
    ...base,
    action: {
      kind: "task" as const,
      task: {
        task_id: taskId,
        attempt_number: claim.execution_identity.semantic_attempt,
        execution_identity: claim.execution_identity,
        lease_ref: claim.lease_ref,
        lease: claim.lease,
        descriptor: advanced.descriptor,
        candidate_path: candidatePath,
        usage_path: automaticBuildUsageReceiptPath(claim.lease_ref),
        input_command: scriptCommand("automatic-build.ts", [
          "input", targetCommandInput(target), stage, taskId,
          ...targetResolutionCommandArgs(target), "--run-ttl-ms", String(advanced.persisted.run_ttl_ms), ...leaseArgs,
        ]),
        candidate_command: scriptCommand("automatic-build.ts", [
          "candidate", targetCommandInput(target), stage, taskId, "{candidate_source}",
          ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        submit_command: scriptCommand("automatic-build.ts", [
          "submit", targetCommandInput(target), stage, taskId, ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        fail_command: scriptCommand("automatic-build.ts", [
          "fail", targetCommandInput(target), stage, taskId,
          "--diagnostic-code", "{diagnostic_code}", "--message", "{diagnostic}",
          ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        inspect_command: scriptCommand("automatic-build.ts", [
          "inspect", targetCommandInput(target), stage, taskId, ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        heartbeat_command: scriptCommand("automatic-build.ts", [
          "heartbeat", targetCommandInput(target), stage, taskId, ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
      },
    },
  };
}

export function automaticBuildDispatchInspect(
  targetInput: string,
  rootDir: string,
  stage: AutomaticBuildStage,
  dispatchId: string,
  options: { now?: string; dispatch_run_id?: string; book_id?: string } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  return inspectAutomaticBuildDispatch(target, stage, dispatchId, options.now, options.dispatch_run_id);
}

export function automaticBuildDispatchFinish(
  targetInput: string,
  rootDir: string,
  stage: AutomaticBuildStage,
  dispatchId: string,
  options: {
    terminal_reason?: AutomaticBuildExecutorDispatchReceiptV1["terminal_reason"];
    now?: string;
    dispatch_run_id?: string;
    book_id?: string;
  } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  return finishAutomaticBuildDispatch(target, stage, dispatchId, options);
}

function nonNegativeIntegerArg(argv: string[], name: string, fallback: number): number {
  const raw = valueArg(argv, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function budgetFromArgs(argv: string[]): AutomaticBuildBudgetLimitsV1 {
  return {
    version: "automatic_build_budget_limits.v1",
    max_tasks: nonNegativeIntegerArg(argv, "--max-tasks", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_tasks),
    max_total_score: nonNegativeIntegerArg(argv, "--max-total-score", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_total_score),
    max_estimated_total_tokens: nonNegativeIntegerArg(argv, "--max-estimated-total-tokens", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_estimated_total_tokens),
    max_batch_score: nonNegativeIntegerArg(argv, "--max-batch-score", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_batch_score),
    max_parallel_cost: nonNegativeIntegerArg(argv, "--max-parallel-cost", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_parallel_cost),
  };
}

function wallBudgetFromArgs(argv: string[]): AutomaticBuildWallBudgetV1 | undefined {
  const maxWall = valueArg(argv, "--max-wall-clock-minutes");
  const maxStarts = valueArg(argv, "--max-agent-starts");
  const maxDuplicate = valueArg(argv, "--max-duplicate-lease-ratio");
  const onExceed = valueArg(argv, "--wall-budget-on-exceed");
  if (maxWall === undefined && maxStarts === undefined && maxDuplicate === undefined && onExceed === undefined) {
    return undefined;
  }
  const numeric = (raw: string | undefined, field: string): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
    return value;
  };
  if (onExceed !== undefined && !["needs_user", "stop"].includes(onExceed)) {
    throw new Error("--wall-budget-on-exceed must be needs_user|stop");
  }
  return {
    version: "automatic_build_wall_budget.v1",
    ...(maxWall !== undefined ? { max_wall_clock_minutes: numeric(maxWall, "--max-wall-clock-minutes")! } : {}),
    ...(maxStarts !== undefined ? { max_agent_starts: nonNegativeIntegerArg(argv, "--max-agent-starts", 0) } : {}),
    ...(maxDuplicate !== undefined
      ? { max_duplicate_lease_ratio: numeric(maxDuplicate, "--max-duplicate-lease-ratio")! }
      : {}),
    on_exceed: (onExceed ?? "needs_user") as AutomaticBuildWallBudgetV1["on_exceed"],
  };
}

function executorProvenanceFromArgs(argv: string[]): AutomaticBuildExecutorProvenanceV1 | undefined {
  const values = {
    model: valueArg(argv, "--executor-model"),
    reasoning_effort: valueArg(argv, "--executor-reasoning-effort"),
    harness_release: valueArg(argv, "--executor-harness-release"),
  };
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== 3) throw new Error("executor provenance requires model, reasoning effort, and harness release together");
  return values as AutomaticBuildExecutorProvenanceV1;
}

function qualityProfileFromArgs(argv: string[]): ExtractionQualityProfile {
  const qualityProfile = valueArg(argv, "--quality-profile") ?? "full";
  if (!["full", "balanced", "sparse"].includes(qualityProfile)) {
    throw new Error(`--quality-profile must be full|balanced|sparse, received ${qualityProfile}`);
  }
  return qualityProfile as ExtractionQualityProfile;
}

function claimProtocolFromArgs(argv: string[]): AutomaticBuildClaimProtocol | undefined {
  const requested = valueArg(argv, "--protocol");
  const dispatchAlias = argv.includes("--executor-dispatches");
  if (requested === undefined && !dispatchAlias) return undefined;
  return resolveAutomaticBuildClaimProtocol(requested, dispatchAlias);
}

function buildPlanFromArgs(argv: string[]): BuildPlanV1 | undefined {
  const requested = valueArg(argv, "--build-plan");
  if (!requested) return undefined;
  const file = path.resolve(requested);
  return JSON.parse(readFileSync(file, "utf8")) as BuildPlanV1;
}

function pass2ChoiceFromArgs(argv: string[]): Pass2PlanChoice {
  const choice = valueArg(argv, "--pass2") ?? "enabled";
  if (choice !== "enabled" && choice !== "disabled") {
    throw new Error(`--pass2 must be enabled or disabled, got: ${choice}`);
  }
  return choice;
}

function resolveAutomaticBuildTargetFromArgs(
  targetInput: string,
  rootDir: string,
  argv: string[],
): AutomaticBuildTarget {
  return resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: valueArg(argv, "--book-id") });
}

const argv = process.argv.slice(2);
if (argv[0] === "legacy-plan") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts legacy-plan <target> [--root <dir>] [--now <ISO timestamp>] [--pass2 enabled|disabled] [budget flags]");
    process.exit(2);
  }
  printAutomaticBuildJson(prepareExplicitLegacyBuildPlan(
    targetInput,
    path.resolve(valueArg(argv, "--root") ?? process.cwd()),
    {
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--book-id") ? { book_id: valueArg(argv, "--book-id") } : {}),
      pass2: pass2ChoiceFromArgs(argv),
      budget: {
        ...(valueArg(argv, "--max-estimated-total-tokens")
          ? { max_total_tokens: Number(valueArg(argv, "--max-estimated-total-tokens")) }
          : {}),
        ...(valueArg(argv, "--max-wall-clock-minutes")
          ? { max_wall_clock_minutes: Number(valueArg(argv, "--max-wall-clock-minutes")) }
          : {}),
        on_exceed: "needs_user",
      },
    },
  ));
} else if (argv[0] === "protocol-doctor") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts protocol-doctor <target> [--root <dir>] [--max-parallel <n>] [--build-plan <confirmed-plan.json>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const requestedWorkers = Number(valueArg(argv, "--max-parallel") ?? "3");
  printAutomaticBuildJson(automaticBuildProtocolDoctor(targetInput, rootDir, {
    budget: budgetFromArgs(argv),
    wall_budget: wallBudgetFromArgs(argv),
    executor_provenance: executorProvenanceFromArgs(argv),
    requested_workers: requestedWorkers,
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", requestedWorkers),
    quality_profile: qualityProfileFromArgs(argv),
    build_plan: buildPlanFromArgs(argv),
    book_id: valueArg(argv, "--book-id"),
  }));
} else if (argv[0] === "plan") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts plan <target> [--root <dir>] [--max-parallel <n>] [--build-plan <confirmed-plan.json>] [budget flags]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const requestedWorkers = Number(valueArg(argv, "--max-parallel") ?? "3");
  printAutomaticBuildJson(automaticBuildPlan(targetInput, rootDir, {
    budget: budgetFromArgs(argv),
    wall_budget: wallBudgetFromArgs(argv),
    executor_provenance: executorProvenanceFromArgs(argv),
    requested_workers: requestedWorkers,
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", requestedWorkers),
    quality_profile: qualityProfileFromArgs(argv),
    build_plan: buildPlanFromArgs(argv),
    book_id: valueArg(argv, "--book-id"),
  }));
} else if (argv[0] === "next") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts next <target> [--root <dir>] [--max-parallel <n>] --build-plan <confirmed-plan.json>");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const maxParallel = Number(valueArg(argv, "--max-parallel") ?? "3");
  const leaseTtlMs = Number(valueArg(argv, "--lease-ttl-ms") ?? String(DEFAULT_RESERVE_TTL_MS));
  const runTtlMs = valueArg(argv, "--run-ttl-ms");
  const qualityProfile = qualityProfileFromArgs(argv);
  printAutomaticBuildJson(automaticBuildNext(targetInput, rootDir, maxParallel, {
    owner: valueArg(argv, "--owner"),
    now: valueArg(argv, "--now"),
    lease_ttl_ms: leaseTtlMs,
    ...(runTtlMs !== undefined ? { run_ttl_ms: Number(runTtlMs) } : {}),
    quality_profile: qualityProfile,
    budget: budgetFromArgs(argv),
    wall_budget: wallBudgetFromArgs(argv),
    executor_provenance: executorProvenanceFromArgs(argv),
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", maxParallel),
    accepted_plan_digest: valueArg(argv, "--accepted-plan"),
    accepted_evaluation_digest: valueArg(argv, "--accepted-evaluation"),
    protocol: claimProtocolFromArgs(argv),
    build_plan: buildPlanFromArgs(argv),
    book_id: valueArg(argv, "--book-id"),
  }));
} else if (["dispatch.next", "dispatch.inspect", "dispatch.finish"].includes(argv[0] ?? "")) {
  const operation = argv[0];
  const [targetInput, stageValue, dispatchId] = argv.slice(1, 4);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage) || !dispatchId) {
    console.error(`usage: tsx skills/build/automatic-build.ts ${operation} <target> <stage> <dispatch-id> [--root <dir>]`);
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const stage = stageValue as AutomaticBuildStage;
  if (operation === "dispatch.next") {
    printAutomaticBuildJson(automaticBuildDispatchNext(targetInput, rootDir, stage, dispatchId, {
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--dispatch-run") ? { dispatch_run_id: valueArg(argv, "--dispatch-run") } : {}),
      book_id: valueArg(argv, "--book-id"),
    }));
  } else if (operation === "dispatch.inspect") {
    printAutomaticBuildJson(automaticBuildDispatchInspect(targetInput, rootDir, stage, dispatchId, {
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--dispatch-run") ? { dispatch_run_id: valueArg(argv, "--dispatch-run") } : {}),
      book_id: valueArg(argv, "--book-id"),
    }));
  } else {
    const terminalReason = valueArg(argv, "--terminal-reason");
    if (terminalReason && !["complete", "task_failure", "executor_interrupted"].includes(terminalReason)) {
      throw new Error("--terminal-reason must be complete|task_failure|executor_interrupted");
    }
    printAutomaticBuildJson(automaticBuildDispatchFinish(targetInput, rootDir, stage, dispatchId, {
      ...(terminalReason
        ? { terminal_reason: terminalReason as AutomaticBuildExecutorDispatchReceiptV1["terminal_reason"] }
        : {}),
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--dispatch-run") ? { dispatch_run_id: valueArg(argv, "--dispatch-run") } : {}),
      book_id: valueArg(argv, "--book-id"),
    }));
  }
} else if (argv[0] === "audit-legacy") {
  const targetInput = argv[1];
  const stageValue = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
  if (!targetInput || (stageValue && !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage))) {
    console.error("usage: tsx skills/build/automatic-build.ts audit-legacy <target> [stage] [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  printAutomaticBuildJson(auditAutomaticBuildLegacy(target, stageValue as AutomaticBuildStage | undefined));
} else if (argv[0] === "migration-mode") {
  const [targetInput, modeValue] = argv.slice(1, 3);
  if (!targetInput || !["legacy_resume", "v2_rebuild"].includes(modeValue ?? "")) {
    console.error("usage: tsx skills/build/automatic-build.ts migration-mode <target> <legacy_resume|v2_rebuild> [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  printAutomaticBuildJson(selectAutomaticBuildMigrationMode(
    target,
    modeValue as AutomaticBuildMigrationMode,
    valueArg(argv, "--now"),
  ));
} else if (argv[0] === "quality") {
  const [targetInput, stageValue] = argv.slice(1, 3);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)
    || stageValue === "paper_reading_guide") {
    console.error("usage: tsx skills/build/automatic-build.ts quality <target> <semantic-stage> [--root <dir>] [--quality-profile <profile>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
  const stageState = snapshot.stages.find((stage) => stage.stage === stageValue);
  if (!stageState) throw new Error(`quality stage is not reachable in the current snapshot: ${stageValue}`);
  printAutomaticBuildJson(collectAutomaticBuildStageQuality(target, stageState, qualityProfileFromArgs(argv)));
} else if (argv[0] === "metrics") {
  const [targetInput, stageValue] = argv.slice(1, 3);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)) {
    console.error("usage: tsx skills/build/automatic-build.ts metrics <target> <stage> [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const metricsSnapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
  const metricsStage = metricsSnapshot.stages.find((stage) => stage.stage === stageValue);
  printAutomaticBuildJson(writeAutomaticBuildStageMetricsSummary(
    target,
    stageValue as AutomaticBuildStage,
    { work_units: metricsStage?.work_units ?? [] },
  ));
} else if (argv[0] === "record-attempt") {
  const [targetInput, stageValue, taskId, outcomeValue] = argv.slice(1, 5);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage) || !taskId
    || !["failure", "success", "reset"].includes(outcomeValue)) {
    console.error("usage: tsx skills/build/automatic-build.ts record-attempt <target> <stage> <task> <failure|success|reset> [--root <dir>] [--message <text>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const attemptValue = valueArg(argv, "--attempt");
  const attempt = attemptValue === undefined ? undefined : Number(attemptValue);
  if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
    console.error(`--attempt must be a positive integer, received ${attemptValue}`);
    process.exit(2);
  }
  const record = recordAutomaticBuildAttempt(
    target,
    stageValue as AutomaticBuildStage,
    taskId,
    outcomeValue as "failure" | "success" | "reset",
    valueArg(argv, "--message"),
    {
      ...(attempt === undefined ? {} : { attempt }),
      ...(valueArg(argv, "--event-id") ? { event_id: valueArg(argv, "--event-id") } : {}),
      ...(valueArg(argv, "--lease-ref") ? { lease_ref: valueArg(argv, "--lease-ref") } : {}),
      ...(valueArg(argv, "--lease-token") ? { lease_token: valueArg(argv, "--lease-token") } : {}),
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
    },
  );
  printAutomaticBuildJson({ version: "automatic_build_attempt_record.v1", stage: stageValue, task_id: taskId, record });
} else if (argv[0] === "heartbeat") {
  const [targetInput, stageValue, taskId] = argv.slice(1, 4);
  const leaseRef = valueArg(argv, "--lease-ref");
  const leaseToken = valueArg(argv, "--lease-token");
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)
    || !taskId || !leaseRef || !leaseToken) {
    console.error("usage: tsx skills/build/automatic-build.ts heartbeat <target> <stage> <task> --lease-ref <path> --lease-token <token> [--root <dir>] [--ttl-ms <n>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const heartbeat = heartbeatAutomaticBuildLease(target, leaseRef, leaseToken, {
    ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
    ...(valueArg(argv, "--ttl-ms") ? { ttl_ms: Number(valueArg(argv, "--ttl-ms")) } : {}),
  });
  printAutomaticBuildJson({ version: "automatic_build_heartbeat_receipt.v1", stage: stageValue, task_id: taskId, heartbeat });
} else if (["candidate", "submit", "legacy-submit", "fail", "inspect"].includes(argv[0] ?? "")) {
  const operation = argv[0];
  const [targetInput, stageValue, taskId] = argv.slice(1, 4);
  const sourceCandidate = operation === "candidate" || operation === "legacy-submit" ? argv[4] : undefined;
  const leaseRef = valueArg(argv, "--lease-ref");
  const leaseToken = valueArg(argv, "--lease-token");
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)
    || !taskId || !leaseRef || !leaseToken
    || ((operation === "candidate" || operation === "legacy-submit") && !sourceCandidate)) {
    console.error(`usage: tsx skills/build/automatic-build.ts ${operation} <target> <stage> <task>${sourceCandidate === undefined ? "" : " <candidate-source>"} --lease-ref <path> --lease-token <token> [--root <dir>]`);
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const stage = stageValue as AutomaticBuildStage;
  const now = valueArg(argv, "--now");
  if (operation === "candidate") {
    printAutomaticBuildJson(stageAutomaticBuildCandidate(target, leaseRef, leaseToken, sourceCandidate!, {
      ...(now ? { now } : {}),
    }));
  } else if (operation === "submit" || operation === "legacy-submit") {
    const candidate = operation === "legacy-submit"
      ? stageAutomaticBuildCandidate(target, leaseRef, leaseToken, sourceCandidate!, { ...(now ? { now } : {}) })
      : { candidate_path: path.join(path.dirname(leaseRef), "candidate.json") };
    printAutomaticBuildJson(submitAutomaticBuildCandidate(
      target,
      leaseRef,
      leaseToken,
      candidate.candidate_path,
      (candidatePath) => runAutomaticBuildStageWriter(target, stage, taskId, candidatePath),
      { ...(now ? { now } : {}) },
    ));
  } else if (operation === "fail") {
    const diagnosticCode = valueArg(argv, "--diagnostic-code");
    if (!diagnosticCode) throw new Error("fail requires --diagnostic-code");
    printAutomaticBuildJson(failAutomaticBuildTask(target, leaseRef, leaseToken, {
      diagnostic_code: diagnosticCode,
      ...(valueArg(argv, "--message") ? { message: valueArg(argv, "--message") } : {}),
      ...(now ? { now } : {}),
    }));
  } else {
    printAutomaticBuildJson(inspectAutomaticBuildTask(target, leaseRef, leaseToken));
  }
} else if (argv[0] === "input" || argv[0] === "write" || argv[0] === "close") {
  const operation = argv[0];
  const targetInput = argv[1];
  const stageValue = argv[2] as AutomaticBuildStage | undefined;
  const taskId = operation === "close" ? undefined : argv[3];
  const outputJson = operation === "write" ? argv[4] : undefined;
  if (!targetInput || !stageValue || !AUTOMATIC_BUILD_STAGES.includes(stageValue)
    || (operation !== "close" && !taskId) || (operation === "write" && !outputJson)) {
    console.error(`usage: tsx skills/build/automatic-build.ts ${operation} <target> <stage>${operation === "close" ? "" : " <task>"}${operation === "write" ? " <output_json>" : ""} [--root <dir>]`);
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const leaseRef = valueArg(argv, "--lease-ref");
  const leaseToken = valueArg(argv, "--lease-token");
  if (Boolean(leaseRef) !== Boolean(leaseToken)) throw new Error("lease_ref and lease_token must be provided together");
  if (leaseRef && leaseToken && operation !== "close") {
    const leaseState = operation === "input"
      ? startAutomaticBuildLease(target, leaseRef, leaseToken, {
          ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
          run_ttl_ms: Number(valueArg(argv, "--run-ttl-ms") ?? String(DEFAULT_RUN_TTL_MS)),
        })
      : assertActiveAutomaticBuildLease(target, leaseRef, leaseToken, valueArg(argv, "--now"));
    if (leaseState.stage !== stageValue || leaseState.work_unit_id !== taskId) {
      throw new Error(`stage command does not match lease identity: ${stageValue}/${taskId}`);
    }
  }
  if (operation === "close" && stageValue === "paper_reading_guide") {
    forwardStageScript(target, "verify-paper-reading-guide.ts", [target.workspace_dir]);
  } else {
    const spec = STAGE_COMMANDS[stageValue];
    const script = operation === "close" ? spec.close : operation === "input" ? spec.input : spec.write;
    if (!script) throw new Error(`stage ${stageValue} does not support ${operation}`);
    if (operation === "close") {
      const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
      const stageState = snapshot.stages.find((stage) => stage.stage === stageValue);
      if (!stageState) throw new Error(`quality stage is not reachable in the current snapshot: ${stageValue}`);
      const report = collectAutomaticBuildStageQuality(target, stageState, qualityProfileFromArgs(argv));
      writeAutomaticBuildStageQualityReport(target, report);
      if (report.gate_status !== "passed") {
        throw new Error(`quality_gate_failed:${JSON.stringify({
          stage: stageValue,
          gate_status: report.gate_status,
          digest: report.digest,
          violations: [...report.integrity.violations, ...report.quality.violations],
        })}`);
      }
    }
    const args = operation === "close"
      ? stageScriptArgs(target)
      : operation === "input"
        ? [target.source_path, taskId!, ...stageScriptArgs(target).slice(1)]
        : [target.source_path, taskId!, outputJson!, ...stageScriptArgs(target).slice(1)];
    if (operation === "close" && stageValue === "pass1" && target.kind === "paper_workspace") {
      args.push("--preserve-foundation", target.workspace_dir);
    }
    if (operation === "input" && leaseRef && leaseToken) {
      const startedAt = valueArg(argv, "--now") ?? new Date().toISOString();
      const result = forwardStageScript(target, script, args, true);
      const finishedAt = valueArg(argv, "--now") ?? new Date().toISOString();
      recordAutomaticBuildInputObservation(target, leaseRef, leaseToken, {
        started_at: startedAt,
        finished_at: finishedAt,
        input_bytes: Buffer.byteLength(result.stdout),
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    } else {
      forwardStageScript(target, script, args);
    }
  }
  if (operation === "close") {
    const metricsSnapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
    const metricsStage = metricsSnapshot.stages.find((stage) => stage.stage === stageValue);
    writeAutomaticBuildStageMetricsSummary(target, stageValue, { work_units: metricsStage?.work_units ?? [] });
  }
}
