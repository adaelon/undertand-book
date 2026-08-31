import { createHash } from "node:crypto";
import type { AutomaticBuildStage, BuildTargetRefV2 } from "./build-orchestrator";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 } from "./executor-transport";
import {
  isAutomaticBuildTaskPolicyBindingV2,
  type AutomaticBuildTaskPolicyBinding,
  type AutomaticBuildTaskPolicyBindingV2,
  type ExtractionPolicyFingerprintV1,
} from "./semantic-artifact";
import {
  isProofBoundWorkUnitDescriptor,
  isWorkUnitDescriptorV3,
  isWorkUnitDescriptorV4,
  validateWorkUnitDescriptorV3,
  validateWorkUnitDescriptorV4,
  validateWorkUnitTaskPolicyBinding,
  workUnitPlanDigest,
  type WorkUnitDescriptor,
  type WorkUnitKind,
} from "./stage-work-unit";

const DEFAULT_PREDICTED_SERVICE_MS = 300_000;
const MAX_DISPATCH_SERVICE_MS = 2_400_000;
const OTHER_KIND_MAX_INPUT_TOKENS = 10_000_000;
const BOOK_STRUCTURE_MAX_INPUT_TOKENS = 6_000;

export interface AutomaticBuildDispatchLimitsV1 {
  max_units: number;
  max_input_tokens: number;
  max_predicted_service_ms: number;
}

export const AUTOMATIC_BUILD_DISPATCH_LIMITS: Record<WorkUnitKind, AutomaticBuildDispatchLimitsV1> = {
  pass1_window: { max_units: 4, max_input_tokens: 50_000, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  pass1_source_slice: { max_units: 4, max_input_tokens: 50_000, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  pass1_lid_stitch: { max_units: 4, max_input_tokens: 50_000, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  profile_sidecar_formula: { max_units: 8, max_input_tokens: 4_000, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  profile_sidecar_discourse: { max_units: 4, max_input_tokens: 6_000, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  profile_sidecar_discourse_fragment: { max_units: 4, max_input_tokens: 6_000, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  profile_sidecar_discourse_reduce: { max_units: 4, max_input_tokens: 6_000, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  profile_sidecar_window_v1: { max_units: 1, max_input_tokens: OTHER_KIND_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  metadata_region: { max_units: 1, max_input_tokens: OTHER_KIND_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  lexicon_candidate_batch: { max_units: 1, max_input_tokens: OTHER_KIND_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  discourse_paragraph_group: { max_units: 1, max_input_tokens: OTHER_KIND_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  formula_context_group: { max_units: 1, max_input_tokens: OTHER_KIND_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  pass2_candidate_batch: { max_units: 1, max_input_tokens: OTHER_KIND_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  structure_unit: { max_units: 1, max_input_tokens: BOOK_STRUCTURE_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  structure_fragment: { max_units: 1, max_input_tokens: BOOK_STRUCTURE_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  structure_reduce: { max_units: 1, max_input_tokens: BOOK_STRUCTURE_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  structure_stitch_fragment: { max_units: 1, max_input_tokens: BOOK_STRUCTURE_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  structure_stitch_reduce: { max_units: 1, max_input_tokens: BOOK_STRUCTURE_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
  structure_stitch: { max_units: 1, max_input_tokens: BOOK_STRUCTURE_MAX_INPUT_TOKENS, max_predicted_service_ms: MAX_DISPATCH_SERVICE_MS },
};

export interface AutomaticBuildExecutorDispatchManifestV1 {
  version: "automatic_build_executor_dispatch.v1";
  dispatch_id: string;
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  kind: WorkUnitKind;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  ordered_work_unit_ids: string[];
  task_bindings?: Record<string, AutomaticBuildTaskPolicyBindingV2>;
  limits: AutomaticBuildDispatchLimitsV1;
  accounting: {
    estimated_input_tokens: number;
    predicted_service_ms: number;
  };
}

export interface AutomaticBuildExecutorDispatchPlanV1 {
  version: "automatic_build_executor_dispatch_plan.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  descriptor_plan_digest: string;
  dispatch_plan_digest: string;
  dispatches: AutomaticBuildExecutorDispatchManifestV1[];
  available_agent_slots: number;
  selected_dispatch_ids: string[];
  accounting: {
    pending_units: number;
    dispatched_units: number;
    dispatches: number;
    estimated_input_tokens: number;
    predicted_service_ms: number;
    by_kind: Partial<Record<WorkUnitKind, { units: number; dispatches: number }>>;
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function predictedService(
  unit: WorkUnitDescriptor,
  predictions: Readonly<Record<string, number>> | undefined,
): number {
  return nonNegativeInteger(
    predictions?.[unit.work_unit_id] ?? DEFAULT_PREDICTED_SERVICE_MS,
    `predicted_service_ms.${unit.work_unit_id}`,
  );
}

function dispatchFor(
  targetRef: BuildTargetRefV2,
  stage: AutomaticBuildStage,
  kind: WorkUnitKind,
  policy: ExtractionPolicyFingerprintV1,
  units: WorkUnitDescriptor[],
  limits: AutomaticBuildDispatchLimitsV1,
  predictions: Readonly<Record<string, number>> | undefined,
  taskBindings: Readonly<Record<string, AutomaticBuildTaskPolicyBinding>> | undefined,
): AutomaticBuildExecutorDispatchManifestV1 {
  const estimatedInputTokens = units.reduce((sum, unit) => sum + unit.cost.estimated_input_tokens, 0);
  const predictedServiceMs = units.reduce((sum, unit) => sum + predictedService(unit, predictions), 0);
  const identity = {
    version: "automatic_build_executor_dispatch.v1" as const,
    target_ref: targetRef,
    stage,
    kind,
    policy_fingerprint: policy,
    ordered_work_unit_ids: units.map((unit) => unit.work_unit_id),
    ...(isProofBoundWorkUnitDescriptor(units[0]) ? {
      task_bindings: Object.fromEntries(units.map((unit) => {
        const binding = taskBindings?.[unit.work_unit_id];
        if (!binding || !isAutomaticBuildTaskPolicyBindingV2(binding)) {
          throw new Error(`budget-evidence dispatch is missing a task binding: ${unit.work_unit_id}`);
        }
        return [unit.work_unit_id, binding];
      })),
    } : {}),
    limits,
  };
  return {
    ...identity,
    dispatch_id: `dispatch-${sha256(identity)}`,
    accounting: {
      estimated_input_tokens: estimatedInputTokens,
      predicted_service_ms: predictedServiceMs,
    },
  };
}

export function planAutomaticBuildExecutorDispatches(input: {
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_units: WorkUnitDescriptor[];
  pending_ids: string[];
  task_bindings?: Readonly<Record<string, AutomaticBuildTaskPolicyBinding>>;
  predicted_service_ms?: Readonly<Record<string, number>>;
  available_agent_slots?: number;
}): AutomaticBuildExecutorDispatchPlanV1 {
  const availableAgentSlots = nonNegativeInteger(input.available_agent_slots ?? 0, "available_agent_slots");
  const descriptorIds = new Set<string>();
  for (const unit of input.work_units) {
    if (descriptorIds.has(unit.work_unit_id)) throw new Error(`duplicate work unit id: ${unit.work_unit_id}`);
    descriptorIds.add(unit.work_unit_id);
    if (unit.stage !== input.stage) throw new Error(`dispatch work unit stage mismatch: ${unit.work_unit_id}`);
    if (!sameIdentity(unit.target, input.target_ref)) throw new Error(`dispatch work unit target mismatch: ${unit.work_unit_id}`);
    if (isWorkUnitDescriptorV3(unit)) {
      validateWorkUnitDescriptorV3(unit);
    } else if (isWorkUnitDescriptorV4(unit)) {
      validateWorkUnitDescriptorV4(unit, CODEX_EXECUTOR_TRANSPORT_PROFILE_V2);
    }
    if (isProofBoundWorkUnitDescriptor(unit)) {
      const binding = input.task_bindings?.[unit.work_unit_id];
      if (!binding) {
        throw new Error(`proof-bound dispatch work unit is missing its task binding: ${unit.work_unit_id}`);
      }
      validateWorkUnitTaskPolicyBinding(unit, binding);
    } else if (input.task_bindings?.[unit.work_unit_id]) {
      validateWorkUnitTaskPolicyBinding(unit, input.task_bindings[unit.work_unit_id]);
    }
  }
  const pendingSet = new Set<string>();
  for (const id of input.pending_ids) {
    if (pendingSet.has(id)) throw new Error(`duplicate pending work unit id: ${id}`);
    if (!descriptorIds.has(id)) throw new Error(`pending work unit is missing from descriptor plan: ${id}`);
    pendingSet.add(id);
  }
  const pending = input.work_units.filter((unit) => pendingSet.has(unit.work_unit_id) && !unit.deterministic_skip);
  const groups: Array<{
    key: string;
    kind: WorkUnitKind;
    policy: ExtractionPolicyFingerprintV1;
    units: WorkUnitDescriptor[];
  }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const unit of pending) {
    const binding = input.task_bindings?.[unit.work_unit_id];
    const aggregationRole = isProofBoundWorkUnitDescriptor(unit)
      ? unit.aggregation?.role ?? "none"
      : "v2";
    const policyIdentity = binding && isAutomaticBuildTaskPolicyBindingV2(binding)
      ? [binding.stage, binding.policy_generation_id, binding.semantic_contract]
      : ["v1", unit.policy_fingerprint];
    const key = stableJson([unit.version, unit.kind, aggregationRole, policyIdentity]);
    let group = byKey.get(key);
    if (!group) {
      group = { key, kind: unit.kind, policy: unit.policy_fingerprint, units: [] };
      groups.push(group);
      byKey.set(key, group);
    }
    group.units.push(unit);
  }
  const dispatches: AutomaticBuildExecutorDispatchManifestV1[] = [];
  for (const group of groups) {
    const limits = AUTOMATIC_BUILD_DISPATCH_LIMITS[group.kind];
    let current: WorkUnitDescriptor[] = [];
    let currentTokens = 0;
    let currentService = 0;
    const flush = () => {
      if (!current.length) return;
      dispatches.push(dispatchFor(
        input.target_ref,
        input.stage,
        group.kind,
        group.policy,
        current,
        limits,
        input.predicted_service_ms,
        input.task_bindings,
      ));
      current = [];
      currentTokens = 0;
      currentService = 0;
    };
    for (const unit of group.units) {
      const tokens = unit.cost.estimated_input_tokens;
      const service = predictedService(unit, input.predicted_service_ms);
      if (tokens > limits.max_input_tokens || service > limits.max_predicted_service_ms) {
        throw new Error(`work unit exceeds ${group.kind} dispatch limits: ${unit.work_unit_id}`);
      }
      if (current.length && (current.length + 1 > limits.max_units
        || currentTokens + tokens > limits.max_input_tokens
        || currentService + service > limits.max_predicted_service_ms)) {
        flush();
      }
      current.push(unit);
      currentTokens += tokens;
      currentService += service;
    }
    flush();
  }
  const byKind: AutomaticBuildExecutorDispatchPlanV1["accounting"]["by_kind"] = {};
  for (const unit of pending) {
    const value = byKind[unit.kind] ?? { units: 0, dispatches: 0 };
    value.units += 1;
    byKind[unit.kind] = value;
  }
  for (const dispatch of dispatches) byKind[dispatch.kind]!.dispatches += 1;
  const descriptorPlanDigest = workUnitPlanDigest(input.work_units);
  const planIdentity = {
    version: "automatic_build_executor_dispatch_plan.v1" as const,
    target_ref: input.target_ref,
    stage: input.stage,
    descriptor_plan_digest: descriptorPlanDigest,
    pending_work_unit_ids: pending.map((unit) => unit.work_unit_id),
    dispatches,
  };
  return {
    version: planIdentity.version,
    target_ref: input.target_ref,
    stage: input.stage,
    descriptor_plan_digest: descriptorPlanDigest,
    dispatch_plan_digest: sha256(planIdentity),
    dispatches,
    available_agent_slots: availableAgentSlots,
    selected_dispatch_ids: dispatches.slice(0, availableAgentSlots).map((dispatch) => dispatch.dispatch_id),
    accounting: {
      pending_units: pending.length,
      dispatched_units: dispatches.reduce((sum, dispatch) => sum + dispatch.ordered_work_unit_ids.length, 0),
      dispatches: dispatches.length,
      estimated_input_tokens: dispatches.reduce((sum, dispatch) => sum + dispatch.accounting.estimated_input_tokens, 0),
      predicted_service_ms: dispatches.reduce((sum, dispatch) => sum + dispatch.accounting.predicted_service_ms, 0),
      by_kind: byKind,
    },
  };
}

export function selectAutomaticBuildDispatchRefill(
  plan: AutomaticBuildExecutorDispatchPlanV1,
  state: {
    active_dispatch_ids: string[];
    completed_dispatch_ids: string[];
    available_agent_slots: number;
  },
): string[] {
  const availableAgentSlots = nonNegativeInteger(state.available_agent_slots, "available_agent_slots");
  const knownIds = new Set(plan.dispatches.map((dispatch) => dispatch.dispatch_id));
  const active = new Set(state.active_dispatch_ids);
  const completed = new Set(state.completed_dispatch_ids);
  for (const id of [...active, ...completed]) {
    if (!knownIds.has(id)) throw new Error(`dispatch refill state contains an unknown dispatch id: ${id}`);
  }
  for (const id of active) {
    if (completed.has(id)) throw new Error(`dispatch cannot be both active and completed: ${id}`);
  }
  const vacancies = Math.max(0, availableAgentSlots - active.size);
  return plan.dispatches
    .filter((dispatch) => !active.has(dispatch.dispatch_id) && !completed.has(dispatch.dispatch_id))
    .slice(0, vacancies)
    .map((dispatch) => dispatch.dispatch_id);
}
