import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildAutomaticBuildSnapshot,
  nextAutomaticBuildAction,
  resolveAutomaticBuildTarget,
  type AutomaticBuildStage,
  type AutomaticBuildTarget,
} from "../../packages/core/src/build-orchestrator";
import {
  readAutomaticBuildAttemptSnapshot,
  recordAutomaticBuildAttemptEvent,
  type AutomaticBuildAttemptRecord,
} from "../../packages/core/src/automatic-build-task-store";
import {
  assertActiveAutomaticBuildLease,
  claimAutomaticBuildTask,
  heartbeatAutomaticBuildLease,
  readAutomaticBuildLease,
  type AutomaticBuildTaskLeaseV1,
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
  recordAutomaticBuildInputObservation,
  type AutomaticBuildStageMetricsSummaryV1,
  writeAutomaticBuildStageMetricsSummary,
} from "../../packages/core/src/automatic-build-metrics";
import type { ExtractionQualityProfile } from "../../packages/core/src/semantic-artifact";
import {
  buildAutomaticBuildPreflight,
  DEFAULT_AUTOMATIC_BUILD_BUDGET,
  selectAutomaticBuildCostBatch,
  type AutomaticBuildBudgetLimitsV1,
  type AutomaticBuildHistoricalUsageV1,
  type AutomaticBuildPreflightV1,
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
  AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  AUTOMATIC_BUILD_RELEASE_V1,
} from "../../packages/core/src/automatic-build-protocol";

const PLUGIN_ROOT = process.env.UNDERSTAND_BOOK_PLUGIN_ROOT
  ? path.resolve(process.env.UNDERSTAND_BOOK_PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_CLI = path.join(PLUGIN_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_TTL_MS = 300_000;
const AUTOMATIC_BUILD_STAGES: AutomaticBuildStage[] = [
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
];

export interface AutomaticBuildNextOptions {
  owner?: string;
  now?: string;
  lease_ttl_ms?: number;
  quality_profile?: ExtractionQualityProfile;
  budget?: AutomaticBuildBudgetLimitsV1;
  available_agent_slots?: number;
  accepted_plan_digest?: string;
}

export interface AutomaticBuildPlanOptions {
  quality_profile?: ExtractionQualityProfile;
  budget?: AutomaticBuildBudgetLimitsV1;
  requested_workers?: number;
  available_agent_slots?: number;
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

function forwardStageScript(
  target: AutomaticBuildTarget,
  script: string,
  args: string[],
  capture = false,
): { stdout: string; stderr: string } {
  const [command, ...commandArgs] = scriptCommand(script, args);
  const result = spawnSync(command, commandArgs, capture
    ? { cwd: target.root_dir, encoding: "utf8" }
    : { cwd: target.root_dir, stdio: "inherit", encoding: "utf8" });
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

function preflightForAction(
  target: AutomaticBuildTarget,
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>,
  action: ReturnType<typeof nextAutomaticBuildAction>,
  requestedWorkers: number,
  availableAgentSlots: number,
  qualityProfile: ExtractionQualityProfile,
  budget: AutomaticBuildBudgetLimitsV1,
): AutomaticBuildPreflightV1 | undefined {
  if (action.kind !== "extract") return undefined;
  const stage = snapshot.stages.find((item) => item.stage === action.stage);
  if (!stage?.work_units) throw new Error(`automatic preflight requires descriptor plan: ${action.stage}`);
  const historicalMetrics = historicalUsageForStage(target, action.stage);
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
      || existing.quality_profile !== value.quality_profile) {
      throw new Error(`automatic build plan acceptance conflicts with current preflight: ${file}`);
    }
  }
  return file;
}

export function automaticBuildPlan(
  targetInput: string,
  rootDir: string,
  options: AutomaticBuildPlanOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const qualityProfile = options.quality_profile ?? "full";
  const requestedWorkers = options.requested_workers ?? 1;
  const availableAgentSlots = options.available_agent_slots ?? requestedWorkers;
  const budget = options.budget ?? DEFAULT_AUTOMATIC_BUILD_BUDGET;
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfile });
  const nextAction = nextAutomaticBuildAction(snapshot, Number.MAX_SAFE_INTEGER);
  const preflight = preflightForAction(
    target,
    snapshot,
    nextAction,
    requestedWorkers,
    availableAgentSlots,
    qualityProfile,
    budget,
  );
  return {
    version: "automatic_build_plan.v1",
    protocol: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
    release: AUTOMATIC_BUILD_RELEASE_V1,
    snapshot,
    next_action: nextAction,
    preflight: preflight ?? null,
  };
}

function expandAction(
  target: AutomaticBuildTarget,
  maxParallel: number,
  leaseOptions: { owner: string; now: string; ttl_ms: number },
  availableAgentSlots: number,
  qualityProfile: ExtractionQualityProfile,
  budget: AutomaticBuildBudgetLimitsV1,
  acceptedPlanDigest?: string,
) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfile });
  const action = nextAutomaticBuildAction(snapshot, Number.MAX_SAFE_INTEGER);
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
            audit_command: scriptCommand("automatic-build.ts", ["audit-legacy", targetInput, action.stage, "--root", target.root_dir]),
            migration_commands: (["legacy_resume", "v2_rebuild"] as const).map((mode) => scriptCommand(
              "automatic-build.ts",
              ["migration-mode", targetInput, mode, "--root", target.root_dir],
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
            "--root", target.root_dir,
            "--attempt", String(item.last_attempt),
            "--event-id", `${action.stage}:${item.task_id}:${item.last_attempt}:reset`,
          ])),
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
    )!;
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
    const claims: Array<{
      task_id: string;
      descriptor: (typeof allPendingUnits)[number];
      status: "leased";
      lease_ref: string;
      lease: AutomaticBuildTaskLeaseV1;
    }> = [];
    let claimedScore = 0;
    for (const descriptor of scheduled.units) {
      const taskId = descriptor.work_unit_id;
      const binding = action.task_bindings?.[taskId];
      if (!binding) throw new Error(`automatic semantic task is missing policy binding: ${action.stage}/${taskId}`);
      const claim = claimAutomaticBuildTask(target, action.stage, taskId, { ...leaseOptions, binding });
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
          retry_after_ms: Math.min(leaseOptions.ttl_ms, 30_000),
        },
      };
    }
    return {
      snapshot,
      preflight,
      action: {
        ...action,
        task_ids: claims.map((claim) => claim.task_id),
        work_units: claims.map((claim) => claim.descriptor),
        plan_acceptance_path: acceptancePath,
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
          const attemptNumber = claim.lease.attempt;
          const leaseArgs = ["--lease-ref", claim.lease_ref, "--lease-token", claim.lease.token];
          const candidatePath = path.join(path.dirname(claim.lease_ref), "candidate.json");
          return {
            task_id: taskId,
            attempt_number: attemptNumber,
            lease_ref: claim.lease_ref,
            lease: claim.lease,
            descriptor: claim.descriptor,
            candidate_path: candidatePath,
            usage_path: automaticBuildUsageReceiptPath(claim.lease_ref),
            input_command: scriptCommand("automatic-build.ts", [
              "input", targetInput, action.stage, taskId, "--root", target.root_dir, ...leaseArgs,
            ]),
            submit_command: scriptCommand("automatic-build.ts", [
              "submit", targetInput, action.stage, taskId,
              "--root", target.root_dir, ...leaseArgs,
            ]),
            fail_command: scriptCommand("automatic-build.ts", [
              "fail", targetInput, action.stage, taskId,
              "--diagnostic-code", "{diagnostic_code}", "--message", "{diagnostic}",
              "--root", target.root_dir, ...leaseArgs,
            ]),
            inspect_command: scriptCommand("automatic-build.ts", [
              "inspect", targetInput, action.stage, taskId,
              "--root", target.root_dir, ...leaseArgs,
            ]),
            heartbeat_command: scriptCommand("automatic-build.ts", [
              "heartbeat", targetInput, action.stage, taskId,
              "--root", target.root_dir, ...leaseArgs,
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
        quality_report: qualityReport,
        action: {
          ...action,
          quality_report_path: automaticBuildStageQualityReportPath(target, action.stage),
          cwd: target.root_dir,
          command: scriptCommand("automatic-build.ts", [
            "close", targetCommandInput(target), action.stage,
            "--root", target.root_dir,
            "--quality-profile", qualityProfile,
          ]),
        },
      };
    }
    return {
      snapshot,
      action: {
        ...action,
        cwd: target.root_dir,
        command: scriptCommand("automatic-build.ts", [
          "close", targetCommandInput(target), action.stage, "--root", target.root_dir,
        ]),
        ...(action.stage === "paper_reading_guide"
          ? { verification_path: path.join(target.workspace_dir, ".build", "paper-reading-guide", "verification.json") }
          : {}),
      },
    };
  }
  return { snapshot, action };
}

function valueArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function automaticBuildNext(
  targetInput: string,
  rootDir: string,
  maxParallel = 5,
  options: AutomaticBuildNextOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const leaseOptions = {
    owner: options.owner ?? `automatic-build:${process.pid}:${randomUUID()}`,
    now: options.now ?? new Date().toISOString(),
    ttl_ms: options.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS,
  };
  return {
    version: "automatic_build_next.v1",
    protocol: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
    release: AUTOMATIC_BUILD_RELEASE_V1,
    ...expandAction(
      target,
      maxParallel,
      leaseOptions,
      options.available_agent_slots ?? maxParallel,
      options.quality_profile ?? "full",
      options.budget ?? DEFAULT_AUTOMATIC_BUILD_BUDGET,
      options.accepted_plan_digest,
    ),
  };
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

function qualityProfileFromArgs(argv: string[]): ExtractionQualityProfile {
  const qualityProfile = valueArg(argv, "--quality-profile") ?? "full";
  if (!["full", "balanced", "sparse"].includes(qualityProfile)) {
    throw new Error(`--quality-profile must be full|balanced|sparse, received ${qualityProfile}`);
  }
  return qualityProfile as ExtractionQualityProfile;
}

const argv = process.argv.slice(2);
if (argv[0] === "plan") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts plan <target> [--root <dir>] [--max-parallel <n>] [budget flags]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const requestedWorkers = Number(valueArg(argv, "--max-parallel") ?? "3");
  console.log(JSON.stringify(automaticBuildPlan(targetInput, rootDir, {
    budget: budgetFromArgs(argv),
    requested_workers: requestedWorkers,
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", requestedWorkers),
    quality_profile: qualityProfileFromArgs(argv),
  }), null, 2));
} else if (argv[0] === "next") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts next <target> [--root <dir>] [--max-parallel <n>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const maxParallel = Number(valueArg(argv, "--max-parallel") ?? "3");
  const leaseTtlMs = Number(valueArg(argv, "--lease-ttl-ms") ?? String(DEFAULT_LEASE_TTL_MS));
  const qualityProfile = qualityProfileFromArgs(argv);
  console.log(JSON.stringify(automaticBuildNext(targetInput, rootDir, maxParallel, {
    owner: valueArg(argv, "--owner"),
    now: valueArg(argv, "--now"),
    lease_ttl_ms: leaseTtlMs,
    quality_profile: qualityProfile,
    budget: budgetFromArgs(argv),
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", maxParallel),
    accepted_plan_digest: valueArg(argv, "--accepted-plan"),
  }), null, 2));
} else if (argv[0] === "audit-legacy") {
  const targetInput = argv[1];
  const stageValue = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
  if (!targetInput || (stageValue && !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage))) {
    console.error("usage: tsx skills/build/automatic-build.ts audit-legacy <target> [stage] [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  console.log(JSON.stringify(auditAutomaticBuildLegacy(target, stageValue as AutomaticBuildStage | undefined), null, 2));
} else if (argv[0] === "migration-mode") {
  const [targetInput, modeValue] = argv.slice(1, 3);
  if (!targetInput || !["legacy_resume", "v2_rebuild"].includes(modeValue ?? "")) {
    console.error("usage: tsx skills/build/automatic-build.ts migration-mode <target> <legacy_resume|v2_rebuild> [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  console.log(JSON.stringify(selectAutomaticBuildMigrationMode(
    target,
    modeValue as AutomaticBuildMigrationMode,
    valueArg(argv, "--now"),
  ), null, 2));
} else if (argv[0] === "quality") {
  const [targetInput, stageValue] = argv.slice(1, 3);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)
    || stageValue === "paper_reading_guide") {
    console.error("usage: tsx skills/build/automatic-build.ts quality <target> <semantic-stage> [--root <dir>] [--quality-profile <profile>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
  const stageState = snapshot.stages.find((stage) => stage.stage === stageValue);
  if (!stageState) throw new Error(`quality stage is not reachable in the current snapshot: ${stageValue}`);
  console.log(JSON.stringify(collectAutomaticBuildStageQuality(target, stageState, qualityProfileFromArgs(argv)), null, 2));
} else if (argv[0] === "metrics") {
  const [targetInput, stageValue] = argv.slice(1, 3);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)) {
    console.error("usage: tsx skills/build/automatic-build.ts metrics <target> <stage> [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  console.log(JSON.stringify(writeAutomaticBuildStageMetricsSummary(
    target,
    stageValue as AutomaticBuildStage,
  ), null, 2));
} else if (argv[0] === "record-attempt") {
  const [targetInput, stageValue, taskId, outcomeValue] = argv.slice(1, 5);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage) || !taskId
    || !["failure", "success", "reset"].includes(outcomeValue)) {
    console.error("usage: tsx skills/build/automatic-build.ts record-attempt <target> <stage> <task> <failure|success|reset> [--root <dir>] [--message <text>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
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
  console.log(JSON.stringify({ version: "automatic_build_attempt_record.v1", stage: stageValue, task_id: taskId, record }, null, 2));
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
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const heartbeat = heartbeatAutomaticBuildLease(target, leaseRef, leaseToken, {
    ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
    ...(valueArg(argv, "--ttl-ms") ? { ttl_ms: Number(valueArg(argv, "--ttl-ms")) } : {}),
  });
  console.log(JSON.stringify({ version: "automatic_build_heartbeat_receipt.v1", stage: stageValue, task_id: taskId, heartbeat }, null, 2));
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
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const stage = stageValue as AutomaticBuildStage;
  const now = valueArg(argv, "--now");
  if (operation === "candidate") {
    console.log(JSON.stringify(stageAutomaticBuildCandidate(target, leaseRef, leaseToken, sourceCandidate!, {
      ...(now ? { now } : {}),
    }), null, 2));
  } else if (operation === "submit" || operation === "legacy-submit") {
    const candidate = operation === "legacy-submit"
      ? stageAutomaticBuildCandidate(target, leaseRef, leaseToken, sourceCandidate!, { ...(now ? { now } : {}) })
      : { candidate_path: path.join(path.dirname(leaseRef), "candidate.json") };
    console.log(JSON.stringify(submitAutomaticBuildCandidate(
      target,
      leaseRef,
      leaseToken,
      candidate.candidate_path,
      (candidatePath) => runAutomaticBuildStageWriter(target, stage, taskId, candidatePath),
      { ...(now ? { now } : {}) },
    ), null, 2));
  } else if (operation === "fail") {
    const diagnosticCode = valueArg(argv, "--diagnostic-code");
    if (!diagnosticCode) throw new Error("fail requires --diagnostic-code");
    console.log(JSON.stringify(failAutomaticBuildTask(target, leaseRef, leaseToken, {
      diagnostic_code: diagnosticCode,
      ...(valueArg(argv, "--message") ? { message: valueArg(argv, "--message") } : {}),
      ...(now ? { now } : {}),
    }), null, 2));
  } else {
    console.log(JSON.stringify(inspectAutomaticBuildTask(target, leaseRef, leaseToken), null, 2));
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
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const leaseRef = valueArg(argv, "--lease-ref");
  const leaseToken = valueArg(argv, "--lease-token");
  if (Boolean(leaseRef) !== Boolean(leaseToken)) throw new Error("lease_ref and lease_token must be provided together");
  if (leaseRef && leaseToken && operation !== "close") {
    const lease = assertActiveAutomaticBuildLease(target, leaseRef, leaseToken, valueArg(argv, "--now"));
    if (lease.stage !== stageValue || lease.work_unit_id !== taskId) {
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
  if (operation === "close") writeAutomaticBuildStageMetricsSummary(target, stageValue);
}
