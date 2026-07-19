import { createHash } from "node:crypto";
import type { AutomaticBuildStage, BuildTargetRefV2 } from "./build-orchestrator";
import type { ExtractionPolicyFingerprintV1, ExtractionQualityProfile } from "./semantic-artifact";
import { workUnitPlanDigest, type WorkUnitDescriptorV2 } from "./stage-work-unit";

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
  plan_digest: string;
  quality_profile: ExtractionQualityProfile;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
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
  units: WorkUnitDescriptorV2[];
  total_score: number;
  deferred_ids: string[];
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

export function buildAutomaticBuildPreflight(input: {
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_units: WorkUnitDescriptorV2[];
  pending_ids: string[];
  quality_profile: ExtractionQualityProfile;
  requested_workers: number;
  available_agent_slots?: number;
  budget: AutomaticBuildBudgetLimitsV1;
  historical_metrics?: AutomaticBuildHistoricalUsageV1;
}): AutomaticBuildPreflightV1 {
  const budget = validateBudget(input.budget);
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
  const policy = eligible[0].policy_fingerprint;
  if (eligible.some((unit) => !samePolicy(unit.policy_fingerprint, policy))) {
    throw new Error(`preflight stage contains mixed policy fingerprints: ${input.stage}`);
  }
  if (policy.quality_profile !== input.quality_profile) throw new Error("preflight quality profile does not match work-unit policy");
  const pendingSet = new Set(input.pending_ids);
  const scores = eligible.map((unit) => unit.cost.score);
  const inputTokens = eligible.map((unit) => unit.cost.estimated_input_tokens);
  const scoreDistribution = distribution(scores);
  const inputDistribution = distribution(inputTokens);
  const outputItems = eligible.reduce((sum, unit) => sum + unit.cost.expected_output_items, 0);
  const outputTokensLower = outputItems * 8;
  const outputTokensUpper = outputItems * 192 + eligible.length * 128;
  const totalLower = inputDistribution.total + outputTokensLower;
  const totalUpper = inputDistribution.total + outputTokensUpper;
  const violations: AutomaticBuildBudgetViolationV1[] = [];
  const checks: Array<[AutomaticBuildBudgetViolationV1["code"], number, number]> = [
    ["max_tasks", eligible.length, budget.max_tasks],
    ["max_total_score", scoreDistribution.total, budget.max_total_score],
    ["max_estimated_total_tokens", totalUpper, budget.max_estimated_total_tokens],
    ["max_batch_score", scoreDistribution.max ?? 0, budget.max_batch_score],
    ["max_parallel_cost", scoreDistribution.max ?? 0, budget.max_parallel_cost],
  ];
  for (const [code, actual, limit] of checks) if (actual > limit) violations.push({ code, actual, limit });
  const descriptorPlanDigest = workUnitPlanDigest(input.work_units);
  const policyDigest = sha256(stableJson(policy));
  const digestIdentity = {
    version: "automatic_build_preflight.v1",
    target_ref: input.target_ref,
    stage: input.stage,
    descriptor_plan_digest: descriptorPlanDigest,
    quality_profile: input.quality_profile,
    policy_digest: policyDigest,
    budget,
    requested_workers: input.requested_workers,
  };
  const historicalUsage = validateHistoricalUsage(input.historical_metrics);
  const workerLimit = Math.min(input.requested_workers, availableAgentSlots, 3);
  const pendingEligible = eligible.filter((unit) => pendingSet.has(unit.work_unit_id));
  const parallelBatch = selectAutomaticBuildCostBatch(pendingEligible, {
    max_tasks: workerLimit,
    max_total_score: Math.min(budget.max_batch_score, budget.max_parallel_cost),
  });
  return {
    version: "automatic_build_preflight.v1",
    target_ref: input.target_ref,
    stage: input.stage,
    descriptor_plan_digest: descriptorPlanDigest,
    plan_digest: sha256(stableJson(digestIdentity)),
    quality_profile: input.quality_profile,
    policy_fingerprint: policy,
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
  units: WorkUnitDescriptorV2[],
  limits: { max_tasks: number; max_total_score: number },
): AutomaticBuildCostBatchV1 {
  const maxTasks = nonNegativeSafeInteger(limits.max_tasks, "batch.max_tasks");
  const maxTotalScore = nonNegativeSafeInteger(limits.max_total_score, "batch.max_total_score");
  const ordered = [...units]
    .filter((unit) => !unit.deterministic_skip)
    .sort((left, right) => left.cost.score - right.cost.score || left.work_unit_id.localeCompare(right.work_unit_id));
  const selected: WorkUnitDescriptorV2[] = [];
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
