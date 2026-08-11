import { z } from "zod";
import type { AutomaticBuildStage, BuildTargetRefV2 } from "./build-orchestrator";
import {
  isAutomaticBuildTransientProviderFailure,
  validateAutomaticBuildFailureDiagnostic,
  type AutomaticBuildFailureDiagnosticV2,
} from "./extractor-contract";
import { BuildTargetRefV2Z } from "./zod";

const AUTOMATIC_BUILD_STAGES = [
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
] as const satisfies readonly AutomaticBuildStage[];

const Sha256Z = z.string().regex(/^[a-f0-9]{64}$/u);
const BoundedIdZ = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= 512,
  "must not exceed 512 UTF-8 bytes",
);

export const AUTOMATIC_BUILD_RETRY_BOUNDARY_RECOVERIES = [
  "publish_new_policy",
  "authorize_transient_retry",
  "operator_fix",
] as const;

export type AutomaticBuildRetryBoundaryRequiredRecovery =
  typeof AUTOMATIC_BUILD_RETRY_BOUNDARY_RECOVERIES[number];

export interface AutomaticBuildRetryBoundaryV1 {
  version: "automatic_build_retry_boundary.v1";
  attempt_scope_digest: string;
  exhausted_semantic_attempt: number;
  terminal_receipt_sha256: string;
  diagnostic_digest: string;
  required_recovery: AutomaticBuildRetryBoundaryRequiredRecovery;
}

const AutomaticBuildRetryBoundaryV1Z = z.object({
  version: z.literal("automatic_build_retry_boundary.v1"),
  attempt_scope_digest: Sha256Z,
  exhausted_semantic_attempt: z.number().int().positive().safe(),
  terminal_receipt_sha256: Sha256Z,
  diagnostic_digest: Sha256Z,
  required_recovery: z.enum(AUTOMATIC_BUILD_RETRY_BOUNDARY_RECOVERIES),
}).strict();

export interface AutomaticBuildRetryRecoveryReceiptV1 {
  version: "automatic_build_retry_recovery.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  attempt_scope_digest: string;
  exhausted_semantic_attempt: number;
  terminal_receipt_sha256: string;
  diagnostic_digest: string;
  decision_request_id: string;
  action: "open_same_scope_retry_window";
  created_at: string;
}

const AutomaticBuildRetryRecoveryReceiptV1Z = z.object({
  version: z.literal("automatic_build_retry_recovery.v1"),
  target_ref: BuildTargetRefV2Z,
  stage: z.enum(AUTOMATIC_BUILD_STAGES),
  work_unit_id: BoundedIdZ,
  attempt_scope_digest: Sha256Z,
  exhausted_semantic_attempt: z.number().int().positive().safe(),
  terminal_receipt_sha256: Sha256Z,
  diagnostic_digest: Sha256Z,
  decision_request_id: BoundedIdZ,
  action: z.literal("open_same_scope_retry_window"),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export function automaticBuildRetryBoundaryRequiredRecovery(
  diagnostic: AutomaticBuildFailureDiagnosticV2,
): AutomaticBuildRetryBoundaryRequiredRecovery {
  const value = validateAutomaticBuildFailureDiagnostic(diagnostic);
  if (isAutomaticBuildTransientProviderFailure(value)) return "authorize_transient_retry";
  if (value.category === "schema" || value.category === "evidence") return "publish_new_policy";
  return "operator_fix";
}

export function createAutomaticBuildRetryBoundary(input: {
  attempt_scope_digest: string;
  exhausted_semantic_attempt: number;
  terminal_receipt_sha256: string;
  failure_diagnostic: AutomaticBuildFailureDiagnosticV2;
}): AutomaticBuildRetryBoundaryV1 {
  const diagnostic = validateAutomaticBuildFailureDiagnostic(input.failure_diagnostic);
  return AutomaticBuildRetryBoundaryV1Z.parse({
    version: "automatic_build_retry_boundary.v1",
    attempt_scope_digest: input.attempt_scope_digest,
    exhausted_semantic_attempt: input.exhausted_semantic_attempt,
    terminal_receipt_sha256: input.terminal_receipt_sha256,
    diagnostic_digest: diagnostic.diagnostic_digest,
    required_recovery: automaticBuildRetryBoundaryRequiredRecovery(diagnostic),
  });
}

export function validateAutomaticBuildRetryBoundary(input: unknown): AutomaticBuildRetryBoundaryV1 {
  return AutomaticBuildRetryBoundaryV1Z.parse(input);
}

export function createAutomaticBuildRetryRecoveryReceipt(input: {
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  boundary: AutomaticBuildRetryBoundaryV1;
  decision_request_id: string;
  created_at: string;
}): AutomaticBuildRetryRecoveryReceiptV1 {
  const boundary = validateAutomaticBuildRetryBoundary(input.boundary);
  if (boundary.required_recovery !== "authorize_transient_retry") {
    throw new Error("automatic build terminal diagnostic does not allow same-scope retry recovery");
  }
  return AutomaticBuildRetryRecoveryReceiptV1Z.parse({
    version: "automatic_build_retry_recovery.v1",
    target_ref: input.target_ref,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    attempt_scope_digest: boundary.attempt_scope_digest,
    exhausted_semantic_attempt: boundary.exhausted_semantic_attempt,
    terminal_receipt_sha256: boundary.terminal_receipt_sha256,
    diagnostic_digest: boundary.diagnostic_digest,
    decision_request_id: input.decision_request_id,
    action: "open_same_scope_retry_window",
    created_at: input.created_at,
  });
}

export function validateAutomaticBuildRetryRecoveryReceipt(
  input: unknown,
): AutomaticBuildRetryRecoveryReceiptV1 {
  return AutomaticBuildRetryRecoveryReceiptV1Z.parse(input);
}
