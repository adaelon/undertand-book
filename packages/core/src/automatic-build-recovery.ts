import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalBuildJson } from "./build-intent";
import type { AutomaticBuildStage, BuildTargetRefV2 } from "./build-orchestrator";

export const AUTOMATIC_BUILD_RECOVERY_PHASES = [
  "routing",
  "preflight",
  "migration",
  "close",
  "post_close",
] as const;

export const AUTOMATIC_BUILD_RECOVERY_CODES = [
  "model_input_unsplittable",
  "budget_proof_invalid",
  "executor_context_too_small",
  "policy_generation_migration_required",
  "policy_generation_conflict",
  "source_slice_coverage_invalid",
  "build_plan_budget_changed",
  "publication_receipt_invalid",
  "stage_close_postcondition_failed",
] as const;

export const AUTOMATIC_BUILD_RECOVERY_ACTIONS = [
  "retry_plan",
  "migrate_policy",
  "reconfirm_build_plan",
  "upgrade_executor",
  "inspect_publication",
] as const;

export const AUTOMATIC_BUILD_RECOVERY_LIMITS = {
  max_affected_work_units: 16,
  max_evidence_lids_per_work_unit: 16,
  max_recovery_actions: AUTOMATIC_BUILD_RECOVERY_ACTIONS.length,
  max_string_bytes: 256,
  max_input_fingerprint_bytes: 512,
} as const;

const AUTOMATIC_BUILD_STAGES = [
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
] as const satisfies readonly AutomaticBuildStage[];

const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedUtf8String(maxBytes: number) {
  return z.string()
    .min(1)
    .refine((value) => value.trim().length > 0, "must not be blank")
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, `must not exceed ${maxBytes} UTF-8 bytes`);
}

const Sha256Z = z.string().regex(SHA256);
const NonNegativeSafeIntegerZ = z.number().int().nonnegative().safe();
const PositiveSafeIntegerZ = z.number().int().positive().safe();
const BoundedStringZ = boundedUtf8String(AUTOMATIC_BUILD_RECOVERY_LIMITS.max_string_bytes);
const InputFingerprintZ = boundedUtf8String(AUTOMATIC_BUILD_RECOVERY_LIMITS.max_input_fingerprint_bytes);

const OmittedValuesZ = z.object({
  count: PositiveSafeIntegerZ,
  digest: Sha256Z,
}).strict();

const AffectedWorkUnitZ = z.object({
  work_unit_id: BoundedStringZ,
  evidence_lids: z.array(BoundedStringZ)
    .max(AUTOMATIC_BUILD_RECOVERY_LIMITS.max_evidence_lids_per_work_unit),
  omitted_evidence_lids: OmittedValuesZ.optional(),
  estimated_tokens: NonNegativeSafeIntegerZ.optional(),
  limit_tokens: NonNegativeSafeIntegerZ.optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidence_lids).size !== value.evidence_lids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence_lids"],
      message: "evidence_lids must not contain duplicates",
    });
  }
});

const AutomaticBuildRecoveryEnvelopeV1Z = z.object({
  version: z.literal("automatic_build_recovery.v1"),
  phase: z.enum(AUTOMATIC_BUILD_RECOVERY_PHASES),
  code: z.enum(AUTOMATIC_BUILD_RECOVERY_CODES),
  stage: z.enum(AUTOMATIC_BUILD_STAGES).optional(),
  target: z.object({
    book_id: BoundedStringZ,
    profile_id: z.enum(["technical_learning", "paper"]),
    input_fingerprint: InputFingerprintZ,
  }).strict(),
  router_version: BoundedStringZ.optional(),
  policy_digest: Sha256Z.optional(),
  affected_work_units: z.array(AffectedWorkUnitZ)
    .max(AUTOMATIC_BUILD_RECOVERY_LIMITS.max_affected_work_units),
  omitted_affected_work_units: OmittedValuesZ.optional(),
  retryable: z.boolean(),
  recovery_actions: z.array(z.enum(AUTOMATIC_BUILD_RECOVERY_ACTIONS))
    .min(1)
    .max(AUTOMATIC_BUILD_RECOVERY_LIMITS.max_recovery_actions),
}).strict().superRefine((value, context) => {
  const unitIds = value.affected_work_units.map((unit) => unit.work_unit_id);
  if (new Set(unitIds).size !== unitIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["affected_work_units"],
      message: "affected_work_units must not contain duplicate work_unit_id values",
    });
  }
  if (new Set(value.recovery_actions).size !== value.recovery_actions.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recovery_actions"],
      message: "recovery_actions must not contain duplicates",
    });
  }
});

export type AutomaticBuildRecoveryPhase = typeof AUTOMATIC_BUILD_RECOVERY_PHASES[number];
export type AutomaticBuildRecoveryCode = typeof AUTOMATIC_BUILD_RECOVERY_CODES[number];
export type AutomaticBuildRecoveryAction = typeof AUTOMATIC_BUILD_RECOVERY_ACTIONS[number];
export type AutomaticBuildRecoveryOmittedValuesV1 = z.infer<typeof OmittedValuesZ>;
export type AutomaticBuildRecoveryAffectedWorkUnitV1 = z.infer<typeof AffectedWorkUnitZ>;
export type AutomaticBuildRecoveryEnvelopeV1 = z.infer<typeof AutomaticBuildRecoveryEnvelopeV1Z>;

export interface AutomaticBuildRecoveryAffectedWorkUnitInputV1 {
  work_unit_id: string;
  evidence_lids: string[];
  estimated_tokens?: number;
  limit_tokens?: number;
}

export interface AutomaticBuildRecoveryEnvelopeInputV1 {
  phase: AutomaticBuildRecoveryPhase;
  code: AutomaticBuildRecoveryCode;
  stage?: AutomaticBuildStage;
  target_ref: BuildTargetRefV2;
  router_version?: string;
  policy_digest?: string;
  affected_work_units: AutomaticBuildRecoveryAffectedWorkUnitInputV1[];
  retryable: boolean;
  recovery_actions: AutomaticBuildRecoveryAction[];
}

export type AutomaticBuildRouteResult<T> =
  | { status: "ready"; value: T }
  | { status: "blocked"; recovery: AutomaticBuildRecoveryEnvelopeV1 };

function omissionSummary<T>(values: T[]): AutomaticBuildRecoveryOmittedValuesV1 | undefined {
  if (!values.length) return undefined;
  return {
    count: values.length,
    digest: sha256(canonicalBuildJson(values)),
  };
}

function normalizeAffectedWorkUnit(
  input: AutomaticBuildRecoveryAffectedWorkUnitInputV1,
): AutomaticBuildRecoveryAffectedWorkUnitV1 {
  const includedLids = input.evidence_lids.slice(
    0,
    AUTOMATIC_BUILD_RECOVERY_LIMITS.max_evidence_lids_per_work_unit,
  );
  const omittedLids = input.evidence_lids.slice(
    AUTOMATIC_BUILD_RECOVERY_LIMITS.max_evidence_lids_per_work_unit,
  );
  return AffectedWorkUnitZ.parse({
    work_unit_id: input.work_unit_id,
    evidence_lids: includedLids,
    ...(omittedLids.length ? { omitted_evidence_lids: omissionSummary(omittedLids) } : {}),
    ...(input.estimated_tokens !== undefined ? { estimated_tokens: input.estimated_tokens } : {}),
    ...(input.limit_tokens !== undefined ? { limit_tokens: input.limit_tokens } : {}),
  });
}

export function createAutomaticBuildRecoveryEnvelope(
  input: AutomaticBuildRecoveryEnvelopeInputV1,
): AutomaticBuildRecoveryEnvelopeV1 {
  const normalizedUnits = input.affected_work_units.map(normalizeAffectedWorkUnit);
  const includedUnits = normalizedUnits.slice(0, AUTOMATIC_BUILD_RECOVERY_LIMITS.max_affected_work_units);
  const omittedUnits = normalizedUnits.slice(AUTOMATIC_BUILD_RECOVERY_LIMITS.max_affected_work_units);
  return AutomaticBuildRecoveryEnvelopeV1Z.parse({
    version: "automatic_build_recovery.v1",
    phase: input.phase,
    code: input.code,
    ...(input.stage ? { stage: input.stage } : {}),
    target: {
      book_id: input.target_ref.book_id,
      profile_id: input.target_ref.profile_id,
      input_fingerprint: input.target_ref.input_fingerprint,
    },
    ...(input.router_version ? { router_version: input.router_version } : {}),
    ...(input.policy_digest ? { policy_digest: input.policy_digest } : {}),
    affected_work_units: includedUnits,
    ...(omittedUnits.length ? { omitted_affected_work_units: omissionSummary(omittedUnits) } : {}),
    retryable: input.retryable,
    recovery_actions: input.recovery_actions,
  });
}

export function parseAutomaticBuildRecoveryEnvelope(input: unknown): AutomaticBuildRecoveryEnvelopeV1 {
  return AutomaticBuildRecoveryEnvelopeV1Z.parse(input);
}

export function canonicalAutomaticBuildRecoveryJson(input: unknown): string {
  return `${canonicalBuildJson(parseAutomaticBuildRecoveryEnvelope(input))}\n`;
}

export function readyAutomaticBuildRoute<T>(value: T): AutomaticBuildRouteResult<T> {
  return { status: "ready", value };
}

export function blockedAutomaticBuildRoute<T = never>(
  recovery: AutomaticBuildRecoveryEnvelopeV1,
): AutomaticBuildRouteResult<T> {
  return { status: "blocked", recovery: parseAutomaticBuildRecoveryEnvelope(recovery) };
}
