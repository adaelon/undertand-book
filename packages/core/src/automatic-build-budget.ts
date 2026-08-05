import { createHash } from "node:crypto";
import { validateBuildPlanV1, type BuildPlanV1 } from "./build-intent";
import type { AutomaticBuildStage, BuildTargetRefV2 } from "./build-orchestrator";
import type {
  AutomaticBuildTaskPolicyBinding,
  ExtractionPolicyFingerprintV1,
  ExtractionQualityProfile,
} from "./semantic-artifact";
import {
  isWorkUnitDescriptorV3,
  validateWorkUnitDescriptorV3,
  validateWorkUnitTaskPolicyBinding,
  workUnitPlanDigest,
  type WorkUnitDescriptor,
  type WorkUnitKind,
} from "./stage-work-unit";
import {
  planAutomaticBuildExecutorDispatches,
  type AutomaticBuildExecutorDispatchManifestV1,
  type AutomaticBuildExecutorDispatchPlanV1,
} from "./automatic-build-dispatch";
import type {
  AutomaticBuildPerformanceHistoryV1,
  AutomaticBuildPerformanceSampleV1,
} from "./automatic-build-metrics";

export interface AutomaticBuildBudgetLimitsV1 {
  version: "automatic_build_budget_limits.v1";
  max_tasks: number;
  max_total_score: number;
  max_estimated_total_tokens: number;
  max_batch_score: number;
  max_parallel_cost: number;
}

export const DEFAULT_AUTOMATIC_BUILD_BUDGET: AutomaticBuildBudgetLimitsV1 = {
  version: "automatic_build_budget_limits.v1",
  max_tasks: 2_000,
  max_total_score: 20_000_000,
  max_estimated_total_tokens: 10_000_000,
  max_batch_score: 2_000_000,
  max_parallel_cost: 2_000_000,
};

export interface AutomaticBuildHistoricalUsageV1 {
  source: "automatic_build_stage_metrics.v1";
  known_usage_coverage: number;
  exact_input_tokens: number;
  exact_output_tokens: number;
}

export interface AutomaticBuildExecutorProvenanceV1 {
  model: string;
  reasoning_effort: string;
  harness_release: string;
}

export interface AutomaticBuildWallBudgetV1 {
  version: "automatic_build_wall_budget.v1";
  max_wall_clock_minutes?: number;
  max_agent_starts?: number;
  max_duplicate_lease_ratio?: number;
  on_exceed: "needs_user" | "stop";
}

export interface AutomaticBuildCostScopeV1 {
  work_units: number;
  dispatches: number;
  agent_starts: number;
  score: number;
  estimated_input_tokens: number;
  estimated_total_tokens_upper: number;
}

export interface AutomaticBuildWallBudgetViolationV1 {
  code: "max_wall_clock_minutes" | "max_agent_starts" | "max_duplicate_lease_ratio";
  actual: number;
  limit: number;
}

interface NumericDistributionV1 {
  total: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface AutomaticBuildBudgetViolationV1 {
  code: "max_tasks" | "max_total_score" | "max_estimated_total_tokens" | "max_batch_score" | "max_parallel_cost";
  actual: number;
  limit: number;
}

export interface AutomaticBuildPreflightV1 {
  version: "automatic_build_preflight.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  descriptor_plan_digest: string;
  build_plan?: { plan_id: string; revision: number; plan_digest: string };
  plan_digest: string;
  preflight_evaluation_digest: string;
  quality_profile: ExtractionQualityProfile;
  policy_fingerprint?: ExtractionPolicyFingerprintV1;
  policy_set_digest?: string;
  policy_digest: string;
  work_units: {
    total: number;
    eligible: number;
    skipped: number;
    pending: number;
    committed: number;
  };
  cost: {
    score: NumericDistributionV1;
    estimated_input_tokens: NumericDistributionV1;
    outliers: Array<{ work_unit_id: string; score: number; estimated_input_tokens: number }>;
  };
  token_estimate: {
    method: "work_unit_descriptor_tokens.v1";
    input_tokens: number;
    output_tokens_lower: number;
    output_tokens_upper: number;
    total_lower: number;
    total_upper: number;
  };
  historical_usage?: AutomaticBuildHistoricalUsageV1;
  dispatch_plan: AutomaticBuildExecutorDispatchPlanV1;
  cost_scope: {
    lifetime: AutomaticBuildCostScopeV1;
    remaining: AutomaticBuildCostScopeV1;
    scheduled: AutomaticBuildCostScopeV1;
  };
  wall_clock: {
    predicted: {
      lifetime: { p50_ms: number; p95_ms: number; agent_starts: number };
      remaining: { p50_ms: number; p95_ms: number; agent_starts: number };
      scheduled: { p50_ms: number; p95_ms: number; agent_starts: number };
    };
    confidence: {
      level: "matched" | "low";
      sample_count: number;
      model_match: boolean;
      policy_match: boolean;
      harness_match: boolean;
      history_revision_digest: string;
    };
    adaptive_run_ttl_ms_by_kind: Partial<Record<WorkUnitKind, number>>;
    duplicate_lease_ratio: number | null;
    budget: {
      limits?: AutomaticBuildWallBudgetV1;
      status: "within_budget" | "exceeded" | "low_confidence";
      violations: AutomaticBuildWallBudgetViolationV1[];
    };
  };
  worker_plan: {
    requested_workers: number;
    available_agent_slots: number;
    max_workers: number;
    hard_worker_limit: 3;
    concurrency_release: "ap14_safe_concurrency.v1";
    max_batch_score: number;
    max_parallel_cost: number;
  };
  budget: {
    limits: AutomaticBuildBudgetLimitsV1;
    status: "within_budget" | "exceeded";
    violations: AutomaticBuildBudgetViolationV1[];
  };
}

export interface AutomaticBuildCostBatchV1 {
  units: WorkUnitDescriptor[];
  total_score: number;
  deferred_ids: string[];
}

export interface AutomaticBuildPlanActualUsageV1 {
  known_usage_coverage: number;
  exact_input_tokens: number;
  exact_output_tokens: number;
}

export interface AutomaticBuildPlanCurrentForecastV1 {
  estimated_total_tokens_upper: number;
  wall_clock_p95_minutes: number;
  preflight_evaluation_digest?: string;
}

export interface AutomaticBuildPlanBudgetViolationV1 {
  code: "max_total_tokens" | "max_wall_clock_minutes";
  actual: number;
  limit: number;
}

export interface AutomaticBuildPlanBudgetEvaluationV1 {
  version: "automatic_build_plan_budget_evaluation.v1";
  plan_id: string;
  plan_digest: string;
  status: "within_budget" | "exceeded";
  known_usage_coverage: number;
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_total_tokens: number;
  remaining_forecast_tokens_upper: number;
  projected_total_tokens_upper: number;
  projected_wall_clock_p95_minutes: number;
  violations: AutomaticBuildPlanBudgetViolationV1[];
  preflight_evaluation_digest?: string;
  receipt_digest: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function validateBudget(input: AutomaticBuildBudgetLimitsV1): AutomaticBuildBudgetLimitsV1 {
  if (input.version !== "automatic_build_budget_limits.v1") throw new Error("unsupported automatic build budget version");
  return {
    version: input.version,
    max_tasks: nonNegativeSafeInteger(input.max_tasks, "budget.max_tasks"),
    max_total_score: nonNegativeSafeInteger(input.max_total_score, "budget.max_total_score"),
    max_estimated_total_tokens: nonNegativeSafeInteger(input.max_estimated_total_tokens, "budget.max_estimated_total_tokens"),
    max_batch_score: nonNegativeSafeInteger(input.max_batch_score, "budget.max_batch_score"),
    max_parallel_cost: nonNegativeSafeInteger(input.max_parallel_cost, "budget.max_parallel_cost"),
  };
}

function percentile(sorted: number[], ratio: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function distribution(values: number[]): NumericDistributionV1 {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    total: sorted.reduce((sum, value) => sum + value, 0),
    min: sorted[0] ?? null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  };
}

function samePolicy(left: ExtractionPolicyFingerprintV1, right: ExtractionPolicyFingerprintV1): boolean {
  return stableJson(left) === stableJson(right);
}

function validateHistoricalUsage(input: AutomaticBuildHistoricalUsageV1 | undefined): AutomaticBuildHistoricalUsageV1 | undefined {
  if (!input) return undefined;
  if (input.source !== "automatic_build_stage_metrics.v1") throw new Error("unsupported historical usage source");
  if (!Number.isFinite(input.known_usage_coverage) || input.known_usage_coverage < 0 || input.known_usage_coverage > 1) {
    throw new Error("historical known_usage_coverage must be between 0 and 1");
  }
  return {
    ...input,
    exact_input_tokens: nonNegativeSafeInteger(input.exact_input_tokens, "historical_usage.exact_input_tokens"),
    exact_output_tokens: nonNegativeSafeInteger(input.exact_output_tokens, "historical_usage.exact_output_tokens"),
  };
}

export function adaptiveAutomaticBuildRunTtlMs(serviceP95Ms: number): number {
  const service = nonNegativeSafeInteger(serviceP95Ms, "service_p95_ms");
  return Math.min(60 * 60_000, Math.max(15 * 60_000, Math.ceil(service * 1.5)));
}

export function listScheduleAutomaticBuildWallClock(durations: number[], workers: number): number {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error("wall clock workers must be a positive safe integer");
  const lanes = Array.from({ length: workers }, () => 0);
  for (const [index, rawDuration] of durations.entries()) {
    const duration = nonNegativeSafeInteger(rawDuration, `wall_clock.duration.${index}`);
    let lane = 0;
    for (let candidate = 1; candidate < lanes.length; candidate += 1) {
      if (lanes[candidate] < lanes[lane]) lane = candidate;
    }
    lanes[lane] += duration;
  }
  return Math.max(...lanes);
}

function validateWallBudget(input: AutomaticBuildWallBudgetV1 | undefined): AutomaticBuildWallBudgetV1 | undefined {
  if (!input) return undefined;
  if (input.version !== "automatic_build_wall_budget.v1") throw new Error("unsupported automatic build wall budget version");
  if (!['needs_user', 'stop'].includes(input.on_exceed)) throw new Error("unsupported wall budget exceed action");
  const maxWallClockMinutes = input.max_wall_clock_minutes;
  if (maxWallClockMinutes !== undefined && (!Number.isFinite(maxWallClockMinutes) || maxWallClockMinutes < 0)) {
    throw new Error("wall_budget.max_wall_clock_minutes must be non-negative");
  }
  const maxAgentStarts = input.max_agent_starts;
  if (maxAgentStarts !== undefined) nonNegativeSafeInteger(maxAgentStarts, "wall_budget.max_agent_starts");
  const maxDuplicateLeaseRatio = input.max_duplicate_lease_ratio;
  if (maxDuplicateLeaseRatio !== undefined
    && (!Number.isFinite(maxDuplicateLeaseRatio) || maxDuplicateLeaseRatio < 0 || maxDuplicateLeaseRatio > 1)) {
    throw new Error("wall_budget.max_duplicate_lease_ratio must be between 0 and 1");
  }
  return {
    version: input.version,
    ...(maxWallClockMinutes !== undefined ? { max_wall_clock_minutes: maxWallClockMinutes } : {}),
    ...(maxAgentStarts !== undefined ? { max_agent_starts: maxAgentStarts } : {}),
    ...(maxDuplicateLeaseRatio !== undefined ? { max_duplicate_lease_ratio: maxDuplicateLeaseRatio } : {}),
    on_exceed: input.on_exceed,
  };
}

function validateExecutorProvenance(
  input: AutomaticBuildExecutorProvenanceV1 | undefined,
): AutomaticBuildExecutorProvenanceV1 | undefined {
  if (!input) return undefined;
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`executor_provenance.${field} must not be empty`);
  }
  return input;
}

function validatePerformanceHistory(
  input: AutomaticBuildPerformanceHistoryV1 | undefined,
): { history?: AutomaticBuildPerformanceHistoryV1; digest: string } {
  if (!input) return { digest: sha256(stableJson({ version: "automatic_build_performance_history.none" })) };
  if (input.version !== "automatic_build_performance_history.v1") {
    throw new Error("unsupported automatic build performance history version");
  }
  nonNegativeSafeInteger(input.lease_count, "historical_performance.lease_count");
  nonNegativeSafeInteger(input.semantic_attempt_count, "historical_performance.semantic_attempt_count");
  for (const [index, sample] of input.samples.entries()) {
    nonNegativeSafeInteger(sample.service_ms, `historical_performance.samples.${index}.service_ms`);
    for (const field of ["sample_id", "router_version", "model", "reasoning_effort", "harness_release"] as const) {
      if (!sample[field]) throw new Error(`historical_performance.samples.${index}.${field} must not be empty`);
    }
  }
  const identity = {
    version: input.version,
    samples: [...input.samples].sort((left, right) => left.sample_id.localeCompare(right.sample_id)),
    lease_count: input.lease_count,
    semantic_attempt_count: input.semantic_attempt_count,
  };
  const computed = sha256(stableJson(identity));
  return { history: { ...identity, revision_digest: computed }, digest: computed };
}

export function evaluateAutomaticBuildPlanBudget(input: {
  plan: BuildPlanV1;
  actual_usage: AutomaticBuildPlanActualUsageV1;
  current_forecast?: AutomaticBuildPlanCurrentForecastV1;
}): AutomaticBuildPlanBudgetEvaluationV1 {
  const plan = validateBuildPlanV1(input.plan);
  const usage = input.actual_usage;
  if (!Number.isFinite(usage.known_usage_coverage)
    || usage.known_usage_coverage < 0
    || usage.known_usage_coverage > 1) {
    throw new Error("plan actual usage coverage must be between 0 and 1");
  }
  const actualInput = nonNegativeSafeInteger(usage.exact_input_tokens, "plan.actual_input_tokens");
  const actualOutput = nonNegativeSafeInteger(usage.exact_output_tokens, "plan.actual_output_tokens");
  const actualTotal = actualInput + actualOutput;
  if (!Number.isSafeInteger(actualTotal)) throw new Error("plan actual token total exceeds the safe integer range");
  const currentForecastTokens = input.current_forecast
    ? nonNegativeSafeInteger(
        input.current_forecast.estimated_total_tokens_upper,
        "plan.current_forecast.estimated_total_tokens_upper",
      )
    : 0;
  const currentForecastWall = input.current_forecast?.wall_clock_p95_minutes ?? 0;
  if (!Number.isFinite(currentForecastWall) || currentForecastWall < 0) {
    throw new Error("plan current forecast wall clock must be non-negative");
  }
  const planEstimateUpper = plan.estimate.input_tokens.upper + plan.estimate.output_tokens.upper;
  if (!Number.isSafeInteger(planEstimateUpper)) throw new Error("plan estimate token total exceeds the safe integer range");
  const remainingForecast = Math.max(currentForecastTokens, Math.max(0, planEstimateUpper - actualTotal));
  const projectedTotal = actualTotal + remainingForecast;
  if (!Number.isSafeInteger(projectedTotal)) throw new Error("plan projected token total exceeds the safe integer range");
  const projectedWall = Math.max(plan.estimate.wall_clock_minutes.p95 ?? 0, currentForecastWall);
  const violations: AutomaticBuildPlanBudgetViolationV1[] = [];
  if (plan.budget.max_total_tokens !== undefined && projectedTotal > plan.budget.max_total_tokens) {
    violations.push({ code: "max_total_tokens", actual: projectedTotal, limit: plan.budget.max_total_tokens });
  }
  if (plan.budget.max_wall_clock_minutes !== undefined && projectedWall > plan.budget.max_wall_clock_minutes) {
    violations.push({
      code: "max_wall_clock_minutes",
      actual: projectedWall,
      limit: plan.budget.max_wall_clock_minutes,
    });
  }
  const identity = {
    version: "automatic_build_plan_budget_evaluation.v1" as const,
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    status: violations.length ? "exceeded" as const : "within_budget" as const,
    known_usage_coverage: usage.known_usage_coverage,
    actual_input_tokens: actualInput,
    actual_output_tokens: actualOutput,
    actual_total_tokens: actualTotal,
    remaining_forecast_tokens_upper: remainingForecast,
    projected_total_tokens_upper: projectedTotal,
    projected_wall_clock_p95_minutes: projectedWall,
    violations,
    ...(input.current_forecast?.preflight_evaluation_digest
      ? { preflight_evaluation_digest: input.current_forecast.preflight_evaluation_digest }
      : {}),
  };
  return { ...identity, receipt_digest: sha256(stableJson(identity)) };
}

function upperTokenEstimate(units: WorkUnitDescriptor[]): number {
  const inputTokens = units.reduce((sum, unit) => sum + unit.cost.estimated_input_tokens, 0);
  const outputItems = units.reduce((sum, unit) => sum + unit.cost.expected_output_items, 0);
  return inputTokens + outputItems * 192 + units.length * 128;
}

function costScope(
  units: WorkUnitDescriptor[],
  dispatches: AutomaticBuildExecutorDispatchManifestV1[],
): AutomaticBuildCostScopeV1 {
  return {
    work_units: units.length,
    dispatches: dispatches.length,
    agent_starts: dispatches.length,
    score: units.reduce((sum, unit) => sum + unit.cost.score, 0),
    estimated_input_tokens: units.reduce((sum, unit) => sum + unit.cost.estimated_input_tokens, 0),
    estimated_total_tokens_upper: upperTokenEstimate(units),
  };
}

export function buildAutomaticBuildPreflight(input: {
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_units: WorkUnitDescriptor[];
  task_bindings?: Record<string, AutomaticBuildTaskPolicyBinding>;
  pending_ids: string[];
  quality_profile: ExtractionQualityProfile;
  requested_workers: number;
  available_agent_slots?: number;
  budget: AutomaticBuildBudgetLimitsV1;
  historical_metrics?: AutomaticBuildHistoricalUsageV1;
  wall_budget?: AutomaticBuildWallBudgetV1;
  executor_provenance?: AutomaticBuildExecutorProvenanceV1;
  historical_performance?: AutomaticBuildPerformanceHistoryV1;
  build_plan?: BuildPlanV1;
}): AutomaticBuildPreflightV1 {
  const budget = validateBudget(input.budget);
  const buildPlan = input.build_plan ? validateBuildPlanV1(input.build_plan) : undefined;
  const buildPlanBinding = buildPlan ? {
    plan_id: buildPlan.plan_id,
    revision: buildPlan.revision,
    plan_digest: buildPlan.plan_digest,
  } : undefined;
  if (!Number.isSafeInteger(input.requested_workers) || input.requested_workers < 1) {
    throw new Error("requested_workers must be a positive safe integer");
  }
  const availableAgentSlots = input.available_agent_slots ?? input.requested_workers;
  if (!Number.isSafeInteger(availableAgentSlots) || availableAgentSlots < 0) {
    throw new Error("available_agent_slots must be a non-negative safe integer");
  }
  const eligible = input.work_units.filter((unit) => !unit.deterministic_skip);
  if (!eligible.length) throw new Error(`preflight requires eligible model work: ${input.stage}`);
  if (eligible.some((unit) => unit.stage !== input.stage)) throw new Error("preflight work unit stage mismatch");
  const v3Units = eligible.filter(isWorkUnitDescriptorV3);
  if (v3Units.length && v3Units.length !== eligible.length) {
    throw new Error(`preflight stage cannot mix v2 and v3 descriptor generations: ${input.stage}`);
  }
  const policySetDigests = new Set<string>();
  for (const unit of eligible) {
    if (isWorkUnitDescriptorV3(unit)) {
      validateWorkUnitDescriptorV3(unit);
      const binding = input.task_bindings?.[unit.work_unit_id];
      if (!binding) throw new Error(`preflight v3 work unit is missing its proof-bound task binding: ${unit.work_unit_id}`);
      validateWorkUnitTaskPolicyBinding(unit, binding);
      if (!("policy_set_digest" in binding)) {
        throw new Error(`preflight v3 work unit is missing its policy-set authority: ${unit.work_unit_id}`);
      }
      policySetDigests.add(binding.policy_set_digest);
    } else if (input.task_bindings?.[unit.work_unit_id]) {
      validateWorkUnitTaskPolicyBinding(unit, input.task_bindings[unit.work_unit_id]);
    }
  }
  const policy = eligible[0].policy_fingerprint;
  const policySetDigest = v3Units.length
    ? [...policySetDigests][0]
    : undefined;
  if (v3Units.length && policySetDigests.size !== 1) {
    throw new Error(`preflight v3 stage must use exactly one policy-set digest: ${input.stage}`);
  }
  if (!v3Units.length && eligible.some((unit) => !samePolicy(unit.policy_fingerprint, policy))) {
    throw new Error(`preflight stage contains mixed policy fingerprints: ${input.stage}`);
  }
  if (eligible.some((unit) => unit.policy_fingerprint.quality_profile !== input.quality_profile)) {
    throw new Error("preflight quality profile does not match work-unit policy");
  }
  const pendingSet = new Set(input.pending_ids);
  const pendingEligible = eligible.filter((unit) => pendingSet.has(unit.work_unit_id));
  const scores = eligible.map((unit) => unit.cost.score);
  const inputTokens = eligible.map((unit) => unit.cost.estimated_input_tokens);
  const scoreDistribution = distribution(scores);
  const inputDistribution = distribution(inputTokens);
  const outputItems = eligible.reduce((sum, unit) => sum + unit.cost.expected_output_items, 0);
  const outputTokensLower = outputItems * 8;
  const outputTokensUpper = outputItems * 192 + eligible.length * 128;
  const totalLower = inputDistribution.total + outputTokensLower;
  const totalUpper = inputDistribution.total + outputTokensUpper;
  const descriptorPlanDigest = workUnitPlanDigest(input.work_units);
  const policyDigest = policySetDigest ?? sha256(stableJson(policy));
  const executorProvenance = validateExecutorProvenance(input.executor_provenance);
  const historicalPerformance = validatePerformanceHistory(input.historical_performance);
  const matchingSamples = (kind: WorkUnitKind): AutomaticBuildPerformanceSampleV1[] => {
    if (!executorProvenance) return [];
    const kindPolicy = eligible.find((unit) => unit.kind === kind)?.policy_fingerprint;
    if (!kindPolicy) return [];
    return historicalPerformance.history?.samples.filter((sample) => sample.stage === input.stage
      && sample.kind === kind
      && sample.router_version === kindPolicy.router_version
      && sample.model === executorProvenance.model
      && sample.reasoning_effort === executorProvenance.reasoning_effort
      && sample.harness_release === executorProvenance.harness_release) ?? [];
  };
  const kinds = [...new Set(pendingEligible.map((unit) => unit.kind))];
  const kindPredictions = new Map<WorkUnitKind, { p50: number; p95: number; samples: AutomaticBuildPerformanceSampleV1[] }>();
  for (const kind of new Set(eligible.map((unit) => unit.kind))) {
    const samples = matchingSamples(kind);
    const services = samples.map((sample) => sample.service_ms).sort((left, right) => left - right);
    kindPredictions.set(kind, {
      p50: percentile(services, 0.5) ?? 300_000,
      p95: percentile(services, 0.95) ?? 300_000,
      samples,
    });
  }
  const predictedService = Object.fromEntries(eligible.map((unit) => [
    unit.work_unit_id,
    kindPredictions.get(unit.kind)!.p95,
  ]));
  const dispatchPlan = planAutomaticBuildExecutorDispatches({
    target_ref: input.target_ref,
    stage: input.stage,
    work_units: input.work_units,
    pending_ids: input.pending_ids,
    predicted_service_ms: predictedService,
    available_agent_slots: availableAgentSlots,
    ...(input.task_bindings ? { task_bindings: input.task_bindings } : {}),
  });
  const lifetimeDispatchPlan = planAutomaticBuildExecutorDispatches({
    target_ref: input.target_ref,
    stage: input.stage,
    work_units: input.work_units,
    pending_ids: eligible.map((unit) => unit.work_unit_id),
    predicted_service_ms: predictedService,
    ...(input.task_bindings ? { task_bindings: input.task_bindings } : {}),
  });
  const plannedWorkers = Math.min(input.requested_workers, 3);
  const scheduledDispatches = dispatchPlan.dispatches.slice(0, plannedWorkers);
  const scheduledIds = new Set(scheduledDispatches.flatMap((dispatch) => dispatch.ordered_work_unit_ids));
  const scheduledUnits = pendingEligible.filter((unit) => scheduledIds.has(unit.work_unit_id));
  const dispatchScore = (dispatch: AutomaticBuildExecutorDispatchManifestV1) => dispatch.ordered_work_unit_ids
    .reduce((sum, id) => sum + (pendingEligible.find((unit) => unit.work_unit_id === id)?.cost.score ?? 0), 0);
  const violations: AutomaticBuildBudgetViolationV1[] = [];
  const remainingScore = pendingEligible.reduce((sum, unit) => sum + unit.cost.score, 0);
  const remainingUpperTokens = upperTokenEstimate(pendingEligible);
  const maxDispatchScore = dispatchPlan.dispatches.reduce((max, dispatch) => Math.max(max, dispatchScore(dispatch)), 0);
  const parallelDispatchScore = scheduledDispatches.reduce((sum, dispatch) => sum + dispatchScore(dispatch), 0);
  const checks: Array<[AutomaticBuildBudgetViolationV1["code"], number, number]> = [
    ["max_tasks", pendingEligible.length, budget.max_tasks],
    ["max_total_score", remainingScore, budget.max_total_score],
    ["max_estimated_total_tokens", remainingUpperTokens, budget.max_estimated_total_tokens],
    ["max_batch_score", maxDispatchScore, budget.max_batch_score],
    ["max_parallel_cost", parallelDispatchScore, budget.max_parallel_cost],
  ];
  for (const [code, actual, limit] of checks) if (actual > limit) violations.push({ code, actual, limit });
  const lifetimeScope = costScope(eligible, lifetimeDispatchPlan.dispatches);
  const remainingScope = costScope(pendingEligible, dispatchPlan.dispatches);
  const scheduledScope = costScope(scheduledUnits, scheduledDispatches);
  const dispatchDuration = (dispatch: AutomaticBuildExecutorDispatchManifestV1, quantile: "p50" | "p95") => (
    kindPredictions.get(dispatch.kind)![quantile] * dispatch.ordered_work_unit_ids.length
  );
  const forecast = (dispatches: AutomaticBuildExecutorDispatchManifestV1[]) => ({
    p50_ms: listScheduleAutomaticBuildWallClock(
      dispatches.map((dispatch) => dispatchDuration(dispatch, "p50")),
      plannedWorkers,
    ),
    p95_ms: listScheduleAutomaticBuildWallClock(
      dispatches.map((dispatch) => dispatchDuration(dispatch, "p95")),
      plannedWorkers,
    ),
    agent_starts: dispatches.length,
  });
  const predicted = {
    lifetime: forecast(lifetimeDispatchPlan.dispatches),
    remaining: forecast(dispatchPlan.dispatches),
    scheduled: forecast(scheduledDispatches),
  };
  const matchedSamples = kinds.flatMap((kind) => kindPredictions.get(kind)!.samples);
  const matched = Boolean(executorProvenance) && kinds.every((kind) => kindPredictions.get(kind)!.samples.length > 0);
  const confidence = {
    level: matched ? "matched" as const : "low" as const,
    sample_count: new Set(matchedSamples.map((sample) => sample.sample_id)).size,
    model_match: matched,
    policy_match: matched,
    harness_match: matched,
    history_revision_digest: historicalPerformance.digest,
  };
  const adaptiveRunTtl = Object.fromEntries(kinds.map((kind) => [
    kind,
    kindPredictions.get(kind)!.samples.length
      ? adaptiveAutomaticBuildRunTtlMs(kindPredictions.get(kind)!.p95)
      : 1_800_000,
  ])) as Partial<Record<WorkUnitKind, number>>;
  const duplicateLeaseRatio = historicalPerformance.history?.lease_count
    ? Math.max(0, historicalPerformance.history.lease_count - historicalPerformance.history.semantic_attempt_count)
      / historicalPerformance.history.lease_count
    : null;
  const wallBudget = validateWallBudget(input.wall_budget);
  const wallViolations: AutomaticBuildWallBudgetViolationV1[] = [];
  if (wallBudget?.max_wall_clock_minutes !== undefined
    && predicted.remaining.p95_ms > wallBudget.max_wall_clock_minutes * 60_000) {
    wallViolations.push({
      code: "max_wall_clock_minutes",
      actual: predicted.remaining.p95_ms / 60_000,
      limit: wallBudget.max_wall_clock_minutes,
    });
  }
  if (wallBudget?.max_agent_starts !== undefined
    && predicted.remaining.agent_starts > wallBudget.max_agent_starts) {
    wallViolations.push({
      code: "max_agent_starts",
      actual: predicted.remaining.agent_starts,
      limit: wallBudget.max_agent_starts,
    });
  }
  if (wallBudget?.max_duplicate_lease_ratio !== undefined && duplicateLeaseRatio !== null
    && duplicateLeaseRatio > wallBudget.max_duplicate_lease_ratio) {
    wallViolations.push({
      code: "max_duplicate_lease_ratio",
      actual: duplicateLeaseRatio,
      limit: wallBudget.max_duplicate_lease_ratio,
    });
  }
  const wallStatus = wallViolations.length
    ? confidence.level === "low" ? "low_confidence" as const : "exceeded" as const
    : "within_budget" as const;
  const digestIdentity = {
    version: "automatic_build_preflight.v1",
    target_ref: input.target_ref,
    stage: input.stage,
    descriptor_plan_digest: descriptorPlanDigest,
    quality_profile: input.quality_profile,
    policy_digest: policyDigest,
    build_plan: buildPlanBinding ?? null,
    budget,
    requested_workers: input.requested_workers,
  };
  const historicalUsage = validateHistoricalUsage(input.historical_metrics);
  const workerLimit = Math.min(input.requested_workers, availableAgentSlots, 3);
  const parallelBatch = selectAutomaticBuildCostBatch(pendingEligible, {
    max_tasks: workerLimit,
    max_total_score: Math.min(budget.max_batch_score, budget.max_parallel_cost),
  });
  const evaluationIdentity = {
    version: "automatic_build_preflight_evaluation.v1",
    descriptor_plan_digest: descriptorPlanDigest,
    build_plan: buildPlanBinding ?? null,
    dispatch_plan_digest: dispatchPlan.dispatch_plan_digest,
    executor_provenance: executorProvenance ?? "unavailable",
    wall_budget: wallBudget ?? null,
    cost_scope: { lifetime: lifetimeScope, remaining: remainingScope, scheduled: scheduledScope },
    predicted,
    confidence,
    adaptive_run_ttl_ms_by_kind: adaptiveRunTtl,
    duplicate_lease_ratio: duplicateLeaseRatio,
    wall_violations: wallViolations,
  };
  return {
    version: "automatic_build_preflight.v1",
    target_ref: input.target_ref,
    stage: input.stage,
    descriptor_plan_digest: descriptorPlanDigest,
    ...(buildPlanBinding ? { build_plan: buildPlanBinding } : {}),
    plan_digest: sha256(stableJson(digestIdentity)),
    preflight_evaluation_digest: sha256(stableJson(evaluationIdentity)),
    quality_profile: input.quality_profile,
    ...(policySetDigest
      ? { policy_set_digest: policySetDigest }
      : { policy_fingerprint: policy }),
    policy_digest: policyDigest,
    work_units: {
      total: input.work_units.length,
      eligible: eligible.length,
      skipped: input.work_units.length - eligible.length,
      pending: eligible.filter((unit) => pendingSet.has(unit.work_unit_id)).length,
      committed: eligible.filter((unit) => !pendingSet.has(unit.work_unit_id)).length,
    },
    cost: {
      score: scoreDistribution,
      estimated_input_tokens: inputDistribution,
      outliers: [...eligible]
        .sort((left, right) => right.cost.score - left.cost.score || left.work_unit_id.localeCompare(right.work_unit_id))
        .slice(0, 5)
        .map((unit) => ({
          work_unit_id: unit.work_unit_id,
          score: unit.cost.score,
          estimated_input_tokens: unit.cost.estimated_input_tokens,
        })),
    },
    token_estimate: {
      method: "work_unit_descriptor_tokens.v1",
      input_tokens: inputDistribution.total,
      output_tokens_lower: outputTokensLower,
      output_tokens_upper: outputTokensUpper,
      total_lower: totalLower,
      total_upper: totalUpper,
    },
    ...(historicalUsage ? { historical_usage: historicalUsage } : {}),
    dispatch_plan: dispatchPlan,
    cost_scope: { lifetime: lifetimeScope, remaining: remainingScope, scheduled: scheduledScope },
    wall_clock: {
      predicted,
      confidence,
      adaptive_run_ttl_ms_by_kind: adaptiveRunTtl,
      duplicate_lease_ratio: duplicateLeaseRatio,
      budget: {
        ...(wallBudget ? { limits: wallBudget } : {}),
        status: wallStatus,
        violations: wallViolations,
      },
    },
    worker_plan: {
      requested_workers: input.requested_workers,
      available_agent_slots: availableAgentSlots,
      max_workers: parallelBatch.units.length,
      hard_worker_limit: 3,
      concurrency_release: "ap14_safe_concurrency.v1",
      max_batch_score: budget.max_batch_score,
      max_parallel_cost: budget.max_parallel_cost,
    },
    budget: {
      limits: budget,
      status: violations.length ? "exceeded" : "within_budget",
      violations,
    },
  };
}

export function selectAutomaticBuildCostBatch(
  units: WorkUnitDescriptor[],
  limits: { max_tasks: number; max_total_score: number },
): AutomaticBuildCostBatchV1 {
  const maxTasks = nonNegativeSafeInteger(limits.max_tasks, "batch.max_tasks");
  const maxTotalScore = nonNegativeSafeInteger(limits.max_total_score, "batch.max_total_score");
  const ordered = [...units]
    .filter((unit) => !unit.deterministic_skip)
    .sort((left, right) => left.cost.score - right.cost.score || left.work_unit_id.localeCompare(right.work_unit_id));
  const selected: WorkUnitDescriptor[] = [];
  let totalScore = 0;
  for (const unit of ordered) {
    if (selected.length >= maxTasks) break;
    if (totalScore + unit.cost.score > maxTotalScore) continue;
    selected.push(unit);
    totalScore += unit.cost.score;
  }
  const selectedIds = new Set(selected.map((unit) => unit.work_unit_id));
  return {
    units: selected,
    total_score: totalScore,
    deferred_ids: ordered.filter((unit) => !selectedIds.has(unit.work_unit_id)).map((unit) => unit.work_unit_id),
  };
}
