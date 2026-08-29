import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createAutomaticBuildRetryBoundary,
  createAutomaticBuildRetryRecoveryReceipt,
  validateAutomaticBuildRetryBoundary,
  validateAutomaticBuildRetryRecoveryReceipt,
  type AutomaticBuildRetryBoundaryV1,
  type AutomaticBuildRetryRecoveryReceiptV1,
} from "./automatic-build-attempt-recovery";
import { canonicalAutomaticBuildJson } from "./automatic-build-protocol";
import type {
  AutomaticBuildStage,
  AutomaticBuildTarget,
  BuildTargetRefV2,
} from "./build-orchestrator";
import {
  isAutomaticBuildFailureDiagnosticV3,
  legacyAutomaticBuildFailureDiagnostic,
  validateAutomaticBuildFailureDiagnostic,
  type AutomaticBuildFailureDiagnosticV2,
} from "./extractor-contract";
import type { AutomaticBuildTaskPolicyBindingV2 } from "./semantic-artifact";

export type AutomaticBuildAttemptOutcome = "failure" | "success" | "reset";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface AutomaticBuildAttemptScopeV1 {
  version: "automatic_build_attempt_scope.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  task_binding: AutomaticBuildTaskPolicyBindingV2;
  attempt_scope_digest: string;
}

export type AutomaticBuildAttemptScopeInputV1 = Omit<
  AutomaticBuildAttemptScopeV1,
  "version" | "attempt_scope_digest"
>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

export function createAutomaticBuildAttemptScope(
  input: AutomaticBuildAttemptScopeInputV1,
): AutomaticBuildAttemptScopeV1 {
  if (!input.work_unit_id) throw new Error("attempt scope work_unit_id must not be empty");
  assertSha256(input.task_binding.input_hash, "attempt scope input_hash");
  assertSha256(input.task_binding.proof_digest, "attempt scope proof_digest");
  assertSha256(input.task_binding.policy_set_digest, "attempt scope policy_set_digest");
  const identity = {
    target_ref: input.target_ref,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    task_binding: input.task_binding,
  };
  return {
    version: "automatic_build_attempt_scope.v1",
    ...identity,
    attempt_scope_digest: sha256(canonicalAutomaticBuildJson(identity)),
  };
}

export function validateAutomaticBuildAttemptScope(
  scope: AutomaticBuildAttemptScopeV1,
  expected?: Pick<AutomaticBuildAttemptScopeInputV1, "target_ref" | "stage" | "work_unit_id">,
): AutomaticBuildAttemptScopeV1 {
  if (scope.version !== "automatic_build_attempt_scope.v1") {
    throw new Error("invalid automatic build attempt scope version");
  }
  const canonical = createAutomaticBuildAttemptScope(scope);
  if (canonical.attempt_scope_digest !== scope.attempt_scope_digest) {
    throw new Error("automatic build attempt scope digest mismatch");
  }
  if (expected && (!sameTargetRef(scope.target_ref, expected.target_ref)
    || scope.stage !== expected.stage
    || scope.work_unit_id !== expected.work_unit_id)) {
    throw new Error("automatic build attempt scope identity mismatch");
  }
  return canonical;
}

export interface AutomaticBuildAttemptEventInput {
  stage: AutomaticBuildStage;
  work_unit_id: string;
  attempt: number;
  event_id: string;
  outcome: AutomaticBuildAttemptOutcome;
  failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
  /** @deprecated V2 compatibility input. New events persist only legacy_unclassified. */
  diagnostic?: string;
  created_at?: string;
}

export interface AutomaticBuildAttemptEventV2
  extends Omit<AutomaticBuildAttemptEventInput, "failure_diagnostic"> {
  version: "automatic_build_attempt_event.v2";
  target_ref: BuildTargetRefV2;
  attempt_scope_digest?: string;
  created_at: string;
}

export interface AutomaticBuildAttemptEventV3
  extends Omit<AutomaticBuildAttemptEventInput, "diagnostic"> {
  version: "automatic_build_attempt_event.v3";
  target_ref: BuildTargetRefV2;
  attempt_scope_digest?: string;
  created_at: string;
}

export type AutomaticBuildAttemptEvent = AutomaticBuildAttemptEventV2 | AutomaticBuildAttemptEventV3;

export interface AutomaticBuildAttemptRecord {
  failures: number;
  last_error?: string;
  last_failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
  updated_at: string;
  last_attempt: number;
  next_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  submit_revision: number;
  identity_source: "native" | "legacy_inferred";
  attempt_scope_digest?: string;
}

export interface AutomaticBuildAttemptSnapshot {
  version: "automatic_build_task_store.v2";
  stages: Partial<Record<AutomaticBuildStage, Record<string, AutomaticBuildAttemptRecord>>>;
}

interface LegacyAttemptRecord {
  failures: number;
  last_error?: string;
  updated_at: string;
}

interface LegacyAttemptLedger {
  version: "automatic_build_attempts.v1";
  stages: Partial<Record<AutomaticBuildStage, Record<string, LegacyAttemptRecord>>>;
}

export interface AutomaticBuildExecutionIdentityV1 {
  version: "automatic_build_execution_identity.v1";
  work_unit_id: string;
  semantic_attempt: number;
  lease_epoch: number;
  submit_revision: number;
  identity_source: "native" | "legacy_inferred";
}

export interface AutomaticBuildExecutionIdentityV2 {
  version: "automatic_build_execution_identity.v2";
  work_unit_id: string;
  semantic_attempt: number;
  lease_epoch: number;
  submit_revision: number;
  attempt_scope_digest: string;
  identity_source: "native" | "legacy_inferred";
}

export type AutomaticBuildExecutionIdentity =
  | AutomaticBuildExecutionIdentityV1
  | AutomaticBuildExecutionIdentityV2;

export interface AutomaticBuildStoredAttemptV1 {
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  attempt_dir: string;
  execution_identity?: AutomaticBuildExecutionIdentity;
}

interface PersistedAutomaticBuildExecutionIdentityV1 {
  version: "automatic_build_execution_identity.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  created_at: string;
}

interface PersistedAutomaticBuildExecutionIdentityV2 {
  version: "automatic_build_execution_identity.v2";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  attempt_scope_digest: string;
  created_at: string;
}

type PersistedAutomaticBuildExecutionIdentity =
  | PersistedAutomaticBuildExecutionIdentityV1
  | PersistedAutomaticBuildExecutionIdentityV2;

interface AutomaticBuildSubmitRevisionEventV1 {
  version: "automatic_build_submit_revision.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  submit_revision: number;
  attempt_scope_digest?: string;
  candidate_sha256: string;
  created_at: string;
}

interface AttemptState {
  attempt: number;
  execution?: PersistedAutomaticBuildExecutionIdentity;
  result?: AutomaticBuildAttemptEvent;
  reset?: AutomaticBuildAttemptEvent;
  recovery?: AutomaticBuildRetryRecoveryReceiptV1;
  terminal_receipt_sha256?: string;
  submit_revision: number;
  observed_at?: string;
  attempt_scope_digest?: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function automaticBuildTaskStoreRoot(target: AutomaticBuildTarget): string {
  return path.join(target.workspace_dir, ".build", "automatic-build", "v2", "tasks");
}

function legacyLedgerPath(target: AutomaticBuildTarget): string {
  return path.join(target.workspace_dir, ".build", "automatic-build", "attempts.json");
}

export function automaticBuildTaskAttemptDirectory(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  attempt: number,
): string {
  return path.join(
    automaticBuildTaskStoreRoot(target),
    stage,
    encodeURIComponent(workUnitId),
    "attempts",
    String(attempt).padStart(4, "0"),
  );
}

export function listAutomaticBuildStoredAttempts(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): AutomaticBuildStoredAttemptV1[] {
  const stageRoot = path.join(automaticBuildTaskStoreRoot(target), stage);
  if (!existsSync(stageRoot)) return [];
  const attempts: AutomaticBuildStoredAttemptV1[] = [];
  for (const taskEntry of readdirSync(stageRoot, { withFileTypes: true })) {
    if (!taskEntry.isDirectory()) continue;
    const workUnitId = decodeURIComponent(taskEntry.name);
    const attemptsRoot = path.join(stageRoot, taskEntry.name, "attempts");
    if (!existsSync(attemptsRoot)) continue;
    for (const attemptEntry of readdirSync(attemptsRoot, { withFileTypes: true })) {
      if (!attemptEntry.isDirectory() || !/^\d+$/.test(attemptEntry.name)) continue;
      const attemptDir = path.join(attemptsRoot, attemptEntry.name);
      const hasStoredState = readdirSync(attemptDir, { withFileTypes: true })
        .some((entry) => entry.isFile() && entry.name.endsWith(".json")
          || entry.isDirectory() && entry.name === "submit-revisions");
      if (!hasStoredState) continue;
      const physicalAttempt = Number(attemptEntry.name);
      const executionIdentity = readAutomaticBuildExecutionIdentity(
        target,
        stage,
        workUnitId,
        physicalAttempt,
      );
      attempts.push({
        stage,
        work_unit_id: workUnitId,
        physical_attempt: physicalAttempt,
        attempt_dir: attemptDir,
        ...(executionIdentity ? { execution_identity: executionIdentity } : {}),
      });
    }
  }
  return attempts.sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id)
    || left.physical_attempt - right.physical_attempt);
}

function failureDiagnosticFromEvent(
  event: AutomaticBuildAttemptEvent,
): AutomaticBuildFailureDiagnosticV2 | undefined {
  if (event.outcome !== "failure") return undefined;
  if (event.version === "automatic_build_attempt_event.v3") {
    return event.failure_diagnostic
      ? validateAutomaticBuildFailureDiagnostic(event.failure_diagnostic)
      : legacyAutomaticBuildFailureDiagnostic();
  }
  return legacyAutomaticBuildFailureDiagnostic();
}

function readAutomaticBuildAttemptEvent(file: string): AutomaticBuildAttemptEvent {
  const event = readJson<AutomaticBuildAttemptEvent>(file);
  if (event.version !== "automatic_build_attempt_event.v2"
    && event.version !== "automatic_build_attempt_event.v3") {
    throw new Error(`invalid automatic build attempt event: ${file}`);
  }
  if (event.version === "automatic_build_attempt_event.v3") {
    if (event.outcome === "failure") {
      if (!event.failure_diagnostic) throw new Error(`failure attempt event is missing its diagnostic: ${file}`);
      validateAutomaticBuildFailureDiagnostic(event.failure_diagnostic);
    } else if (event.failure_diagnostic !== undefined) {
      throw new Error(`non-failure attempt event contains a failure diagnostic: ${file}`);
    }
  }
  return event;
}

function eventEquivalent(left: AutomaticBuildAttemptEvent, right: AutomaticBuildAttemptEvent): boolean {
  const leftFailure = failureDiagnosticFromEvent(left);
  const rightFailure = failureDiagnosticFromEvent(right);
  return left.version === right.version
    && left.event_id === right.event_id
    && left.stage === right.stage
    && left.work_unit_id === right.work_unit_id
    && left.attempt === right.attempt
    && left.outcome === right.outcome
    && leftFailure?.diagnostic_digest === rightFailure?.diagnostic_digest
    && left.attempt_scope_digest === right.attempt_scope_digest
    && left.target_ref.version === right.target_ref.version
    && path.resolve(left.target_ref.workspace_dir) === path.resolve(right.target_ref.workspace_dir)
    && left.target_ref.book_id === right.target_ref.book_id
    && left.target_ref.profile_id === right.target_ref.profile_id
    && left.target_ref.input_fingerprint === right.target_ref.input_fingerprint;
}

function sameTargetRef(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function readScopedTerminalFailureReceipt(input: {
  file: string;
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  attempt: number;
  attempt_scope_digest?: string;
}): { failure_diagnostic: AutomaticBuildFailureDiagnosticV2; sha256: string } | undefined {
  if (!existsSync(input.file)) return undefined;
  const receipt = readJson<Record<string, unknown>>(input.file);
  if (receipt.version !== "automatic_build_task_receipt.v2"
    || receipt.state !== "retryable_failure"
    || typeof receipt.stage !== "string"
    || receipt.stage !== input.stage
    || receipt.work_unit_id !== input.work_unit_id
    || receipt.attempt !== input.attempt
    || receipt.attempt_scope_digest !== input.attempt_scope_digest
    || typeof receipt.target_ref !== "object"
    || receipt.target_ref === null
    || !sameTargetRef(receipt.target_ref as unknown as BuildTargetRefV2, input.target_ref)
    || receipt.failure_diagnostic === undefined) {
    throw new Error(`invalid automatic build terminal failure receipt: ${input.file}`);
  }
  const metrics = receipt.metrics;
  const phaseFacts = metrics && typeof metrics === "object" && metrics !== null
    ? {
        writer_started: (metrics as Record<string, unknown>).writer_started === true,
        output_bytes: (metrics as Record<string, unknown>).output_bytes,
      }
    : undefined;
  return {
    failure_diagnostic: validateAutomaticBuildFailureDiagnostic(
      receipt.failure_diagnostic,
      phaseFacts === undefined
        ? undefined
        : {
            writer_started: phaseFacts.writer_started,
            ...(typeof phaseFacts.output_bytes === "number"
              ? { output_bytes: phaseFacts.output_bytes }
              : {}),
          },
    ),
    sha256: sha256(readFileSync(input.file)),
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

interface PersistedAutomaticBuildLeaseScopeProjection {
  target_ref?: BuildTargetRefV2;
  stage?: AutomaticBuildStage;
  work_unit_id?: string;
  attempt?: number;
  issued_at?: string;
  input_hash?: string;
  proof_digest?: string;
  policy_set_digest?: string;
  policy_fingerprint?: AutomaticBuildTaskPolicyBindingV2["policy_fingerprint"];
  attempt_scope_digest?: string;
}

function attemptScopeFromLease(
  lease: PersistedAutomaticBuildLeaseScopeProjection | undefined,
  expected: Pick<AutomaticBuildAttemptScopeInputV1, "target_ref" | "stage" | "work_unit_id">,
): AutomaticBuildAttemptScopeV1 | undefined {
  if (!lease) return undefined;
  const hasProof = lease.proof_digest !== undefined;
  const hasPolicySet = lease.policy_set_digest !== undefined;
  const declaresScope = lease.attempt_scope_digest !== undefined;
  if (!hasProof && !hasPolicySet && !declaresScope) return undefined;
  if (!lease.target_ref || lease.stage !== expected.stage || lease.work_unit_id !== expected.work_unit_id
    || !sameTargetRef(lease.target_ref, expected.target_ref)
    || typeof lease.input_hash !== "string"
    || typeof lease.proof_digest !== "string"
    || typeof lease.policy_set_digest !== "string"
    || !lease.policy_fingerprint) {
    throw new Error("automatic build lease contains an incomplete attempt scope binding");
  }
  const scope = createAutomaticBuildAttemptScope({
    target_ref: lease.target_ref,
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    task_binding: {
      input_hash: lease.input_hash,
      proof_digest: lease.proof_digest,
      policy_set_digest: lease.policy_set_digest,
      policy_fingerprint: lease.policy_fingerprint,
    },
  });
  if (lease.attempt_scope_digest !== undefined && lease.attempt_scope_digest !== scope.attempt_scope_digest) {
    throw new Error("automatic build lease attempt scope digest mismatch");
  }
  return scope;
}

function attemptStates(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  options: { allow_pending_terminal_failure_receipt?: boolean } = {},
): AttemptState[] {
  const attemptsDir = path.join(automaticBuildTaskStoreRoot(target), stage, encodeURIComponent(workUnitId), "attempts");
  if (!existsSync(attemptsDir)) return [];
  const states = readdirSync(attemptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => {
      const attempt = Number(entry.name);
      const dir = path.join(attemptsDir, entry.name);
      const leasePath = path.join(dir, "lease.json");
      const executionPath = path.join(dir, "execution.json");
      const resultPath = path.join(dir, "result.json");
      const resetPath = path.join(dir, "reset.json");
      const recoveryPath = path.join(dir, "recovery.json");
      const failureReceiptPath = path.join(dir, "failure.json");
      const revisionsDir = path.join(dir, "submit-revisions");
      const lease = existsSync(leasePath)
        ? readJson<PersistedAutomaticBuildLeaseScopeProjection>(leasePath)
        : undefined;
      const execution = existsSync(executionPath)
        ? readJson<PersistedAutomaticBuildExecutionIdentity>(executionPath)
        : undefined;
      const observedAt = execution?.created_at ?? lease?.issued_at;
      if (execution && (!(["automatic_build_execution_identity.v1", "automatic_build_execution_identity.v2"] as string[])
          .includes(execution.version)
        || !sameTargetRef(execution.target_ref, target.target_ref)
        || execution.stage !== stage
        || execution.work_unit_id !== workUnitId
        || execution.physical_attempt !== attempt)) {
        throw new Error(`invalid automatic build execution identity: ${executionPath}`);
      }
      if (execution?.version === "automatic_build_execution_identity.v2") {
        assertSha256(execution.attempt_scope_digest, "execution attempt_scope_digest");
      }
      const inferredScope = attemptScopeFromLease(lease, {
        target_ref: target.target_ref,
        stage,
        work_unit_id: workUnitId,
      });
      const attemptScopeDigest = execution?.version === "automatic_build_execution_identity.v2"
        ? execution.attempt_scope_digest
        : inferredScope?.attempt_scope_digest;
      if (execution?.version === "automatic_build_execution_identity.v2"
        && inferredScope
        && execution.attempt_scope_digest !== inferredScope.attempt_scope_digest) {
        throw new Error(`automatic build execution and lease scope mismatch: ${executionPath}`);
      }
      const result = existsSync(resultPath) ? readAutomaticBuildAttemptEvent(resultPath) : undefined;
      const reset = existsSync(resetPath) ? readAutomaticBuildAttemptEvent(resetPath) : undefined;
      const terminalFailureReceipt = readScopedTerminalFailureReceipt({
        file: failureReceiptPath,
        target_ref: target.target_ref,
        stage,
        work_unit_id: workUnitId,
        attempt,
        attempt_scope_digest: attemptScopeDigest,
      });
      const recovery = existsSync(recoveryPath)
        ? validateAutomaticBuildRetryRecoveryReceipt(readJson<unknown>(recoveryPath))
        : undefined;
      for (const event of [result, reset]) {
        if (!event) continue;
        if (!sameTargetRef(event.target_ref, target.target_ref)
          || event.stage !== stage
          || event.work_unit_id !== workUnitId
          || event.attempt !== attempt) {
          throw new Error(`invalid automatic build attempt event: ${event.outcome === "reset" ? resetPath : resultPath}`);
        }
        if (event.attempt_scope_digest !== undefined) {
          assertSha256(event.attempt_scope_digest, "attempt event attempt_scope_digest");
          if (!attemptScopeDigest || event.attempt_scope_digest !== attemptScopeDigest) {
            throw new Error(`automatic build attempt event scope mismatch: ${event.outcome === "reset" ? resetPath : resultPath}`);
          }
        }
      }
      if (recovery && (!sameTargetRef(recovery.target_ref, target.target_ref)
        || recovery.stage !== stage
        || recovery.work_unit_id !== workUnitId
        || recovery.attempt_scope_digest !== attemptScopeDigest)) {
        throw new Error(`automatic build retry recovery identity mismatch: ${recoveryPath}`);
      }
      if (terminalFailureReceipt) {
        const eventDiagnostic = result ? failureDiagnosticFromEvent(result) : undefined;
        if (!result && !options.allow_pending_terminal_failure_receipt) {
          throw new Error(`automatic build terminal failure receipt is missing its event: ${failureReceiptPath}`);
        }
        if (result && (!eventDiagnostic
          || eventDiagnostic.diagnostic_digest !== terminalFailureReceipt.failure_diagnostic.diagnostic_digest)) {
          throw new Error(`automatic build terminal event and failure receipt disagree: ${failureReceiptPath}`);
        }
      }
      return {
        attempt,
        ...(execution ? { execution } : {}),
        ...(result ? { result } : {}),
        ...(reset ? { reset } : {}),
        ...(recovery ? { recovery } : {}),
        ...(terminalFailureReceipt && result
          ? { terminal_receipt_sha256: terminalFailureReceipt.sha256 }
          : {}),
        submit_revision: existsSync(revisionsDir)
          ? readdirSync(revisionsDir, { withFileTypes: true })
              .filter((revision) => revision.isFile() && /^\d+\.json$/.test(revision.name))
              .reduce((max, revision) => Math.max(max, Number.parseInt(revision.name, 10)), 0)
          : 0,
        ...(observedAt ? { observed_at: observedAt } : {}),
        ...(attemptScopeDigest ? { attempt_scope_digest: attemptScopeDigest } : {}),
        meaningful: Boolean(lease || execution || existsSync(resultPath) || existsSync(resetPath)
          || existsSync(failureReceiptPath)
          || existsSync(recoveryPath) || existsSync(revisionsDir)),
      };
    })
    .filter((state) => state.meaningful)
    .sort((left, right) => left.attempt - right.attempt);
  const identities = inferredIdentities(states);
  states.forEach((state, index) => {
    if (state.recovery) assertRetryRecoveryMatchesState(state, identities[index]);
  });
  return states;
}

function inferredIdentities(states: AttemptState[]): AutomaticBuildExecutionIdentity[] {
  const identities: AutomaticBuildExecutionIdentity[] = [];
  const cursors = new Map<string, {
    semantic_attempt: number;
    lease_epoch: number;
    previous?: AttemptState;
  }>();
  for (const state of states) {
    const group = state.attempt_scope_digest ?? "legacy_unscoped";
    const cursor = cursors.get(group) ?? { semantic_attempt: 1, lease_epoch: 0 };
    let semanticAttempt = cursor.semantic_attempt;
    let leaseEpoch = cursor.lease_epoch;
    const execution = state.execution;
    const nativeExecution = execution
      && (execution.version === "automatic_build_execution_identity.v2" || !state.attempt_scope_digest);
    if (nativeExecution) {
      semanticAttempt = positiveInteger(execution.semantic_attempt, "semantic_attempt");
      leaseEpoch = positiveInteger(execution.lease_epoch, "lease_epoch");
    } else {
      if (cursor.previous?.result?.outcome === "failure") {
        semanticAttempt += 1;
        leaseEpoch = 1;
      } else {
        leaseEpoch += 1;
      }
    }
    const workUnitId = state.execution?.work_unit_id
      ?? state.result?.work_unit_id
      ?? cursor.previous?.result?.work_unit_id
      ?? "";
    if (state.attempt_scope_digest) {
      identities.push({
        version: "automatic_build_execution_identity.v2",
        work_unit_id: workUnitId,
        semantic_attempt: semanticAttempt,
        lease_epoch: leaseEpoch,
        submit_revision: state.submit_revision,
        attempt_scope_digest: state.attempt_scope_digest,
        identity_source: state.execution?.version === "automatic_build_execution_identity.v2"
          ? "native"
          : "legacy_inferred",
      });
    } else {
      identities.push({
        version: "automatic_build_execution_identity.v1",
        work_unit_id: workUnitId,
        semantic_attempt: semanticAttempt,
        lease_epoch: leaseEpoch,
        submit_revision: state.submit_revision,
        identity_source: state.execution ? "native" : "legacy_inferred",
      });
    }
    cursors.set(group, { semantic_attempt: semanticAttempt, lease_epoch: leaseEpoch, previous: state });
  }
  return identities;
}

function retryBoundaryForState(
  state: AttemptState,
  identity: AutomaticBuildExecutionIdentity,
): AutomaticBuildRetryBoundaryV1 | undefined {
  if (state.result?.outcome !== "failure"
    || !state.attempt_scope_digest
    || identity.version !== "automatic_build_execution_identity.v2"
    || identity.attempt_scope_digest !== state.attempt_scope_digest
    || !state.terminal_receipt_sha256) return undefined;
  const failureDiagnostic = failureDiagnosticFromEvent(state.result);
  if (!failureDiagnostic) return undefined;
  return createAutomaticBuildRetryBoundary({
    attempt_scope_digest: state.attempt_scope_digest,
    exhausted_semantic_attempt: identity.semantic_attempt,
    terminal_receipt_sha256: state.terminal_receipt_sha256,
    failure_diagnostic: failureDiagnostic,
  });
}

function assertRetryRecoveryMatchesState(
  state: AttemptState,
  identity: AutomaticBuildExecutionIdentity,
): AutomaticBuildRetryBoundaryV1 {
  const recovery = state.recovery;
  const boundary = retryBoundaryForState(state, identity);
  if (!recovery || !boundary) {
    throw new Error("automatic build retry recovery is missing its scoped terminal failure");
  }
  if (boundary.required_recovery !== "authorize_transient_retry") {
    throw new Error("automatic build retry recovery targets a non-transient terminal failure");
  }
  if (recovery.attempt_scope_digest !== boundary.attempt_scope_digest
    || recovery.exhausted_semantic_attempt !== boundary.exhausted_semantic_attempt
    || recovery.terminal_receipt_sha256 !== boundary.terminal_receipt_sha256
    || recovery.diagnostic_digest !== boundary.diagnostic_digest) {
    throw new Error("automatic build retry recovery terminal boundary mismatch");
  }
  return boundary;
}

export function readAutomaticBuildExecutionIdentity(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  attempt?: number,
): AutomaticBuildExecutionIdentity | undefined {
  const states = attemptStates(target, stage, workUnitId);
  return executionIdentityFromStates(states, workUnitId, attempt);
}

function executionIdentityFromStates(
  states: AttemptState[],
  workUnitId: string,
  attempt?: number,
): AutomaticBuildExecutionIdentity | undefined {
  const index = attempt === undefined ? states.length - 1 : states.findIndex((state) => state.attempt === attempt);
  if (index < 0) return undefined;
  const identity = inferredIdentities(states)[index];
  return identity.work_unit_id ? identity : { ...identity, work_unit_id: workUnitId };
}

export interface AutomaticBuildRetryRecoveryRequestV1 extends AutomaticBuildRetryBoundaryV1 {
  stage: AutomaticBuildStage;
  work_unit_id: string;
  decision_request_id: string;
  created_at: string;
  max_semantic_attempts?: number;
}

function currentScopedRetryTerminal(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  attemptScopeDigest: string,
  maxSemanticAttempts: number,
): { state: AttemptState; boundary: AutomaticBuildRetryBoundaryV1 } | undefined {
  assertSha256(attemptScopeDigest, "retry boundary attempt_scope_digest");
  positiveInteger(maxSemanticAttempts, "max_semantic_attempts");
  const states = attemptStates(target, stage, workUnitId);
  const identities = inferredIdentities(states);
  const currentIndex = states.length - 1;
  if (currentIndex < 0) return undefined;
  const state = states[currentIndex];
  const identity = identities[currentIndex];
  if (!state || !identity
    || state.attempt_scope_digest !== attemptScopeDigest
    || identity.semantic_attempt < maxSemanticAttempts) return undefined;
  const boundary = retryBoundaryForState(state, identity);
  return boundary ? { state, boundary } : undefined;
}

export function readAutomaticBuildRetryBoundary(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  attemptScopeDigest: string,
  options: { max_semantic_attempts?: number } = {},
): AutomaticBuildRetryBoundaryV1 | undefined {
  const current = currentScopedRetryTerminal(
    target,
    stage,
    workUnitId,
    attemptScopeDigest,
    options.max_semantic_attempts ?? 3,
  );
  return current && !current.state.recovery ? current.boundary : undefined;
}

function retryRecoveryPreparation(
  target: AutomaticBuildTarget,
  input: AutomaticBuildRetryRecoveryRequestV1,
): { file: string; receipt: AutomaticBuildRetryRecoveryReceiptV1 } {
  const suppliedBoundary = validateAutomaticBuildRetryBoundary({
    version: input.version,
    attempt_scope_digest: input.attempt_scope_digest,
    exhausted_semantic_attempt: input.exhausted_semantic_attempt,
    terminal_receipt_sha256: input.terminal_receipt_sha256,
    diagnostic_digest: input.diagnostic_digest,
    required_recovery: input.required_recovery,
  });
  const current = currentScopedRetryTerminal(
    target,
    input.stage,
    input.work_unit_id,
    input.attempt_scope_digest,
    input.max_semantic_attempts ?? 3,
  );
  if (!current) throw new Error("automatic build terminal boundary is not retry-exhausted");
  const boundary = current.boundary;
  if (suppliedBoundary.attempt_scope_digest !== boundary.attempt_scope_digest
    || suppliedBoundary.exhausted_semantic_attempt !== boundary.exhausted_semantic_attempt
    || suppliedBoundary.terminal_receipt_sha256 !== boundary.terminal_receipt_sha256
    || suppliedBoundary.diagnostic_digest !== boundary.diagnostic_digest
    || input.required_recovery !== boundary.required_recovery) {
    throw new Error("automatic build terminal boundary changed before retry recovery");
  }
  const receipt = createAutomaticBuildRetryRecoveryReceipt({
    target_ref: target.target_ref,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    boundary,
    decision_request_id: input.decision_request_id,
    created_at: input.created_at,
  });
  const file = path.join(
    automaticBuildTaskAttemptDirectory(target, input.stage, input.work_unit_id, current.state.attempt),
    "recovery.json",
  );
  if (existsSync(file)) {
    const existing = validateAutomaticBuildRetryRecoveryReceipt(readJson<unknown>(file));
    if (canonicalAutomaticBuildJson(existing) === canonicalAutomaticBuildJson(receipt)) {
      return { file, receipt: existing };
    }
    throw new Error("conflicting automatic build retry recovery receipt");
  }
  return { file, receipt };
}

export function prepareAutomaticBuildRetryRecovery(
  target: AutomaticBuildTarget,
  input: AutomaticBuildRetryRecoveryRequestV1,
): AutomaticBuildRetryRecoveryReceiptV1 {
  return retryRecoveryPreparation(target, input).receipt;
}

export function recordAutomaticBuildRetryRecovery(
  target: AutomaticBuildTarget,
  input: AutomaticBuildRetryRecoveryRequestV1,
): AutomaticBuildRetryRecoveryReceiptV1 {
  const prepared = retryRecoveryPreparation(target, input);
  mkdirSync(path.dirname(prepared.file), { recursive: true });
  try {
    writeFileSync(prepared.file, `${JSON.stringify(prepared.receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return prepared.receipt;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = validateAutomaticBuildRetryRecoveryReceipt(readJson<unknown>(prepared.file));
    if (canonicalAutomaticBuildJson(existing) === canonicalAutomaticBuildJson(prepared.receipt)) return existing;
    throw new Error("conflicting automatic build retry recovery receipt");
  }
}

export function nextAutomaticBuildExecutionIdentity(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  limits: {
    max_semantic_attempts: number;
    max_lease_epochs: number;
    attempt_scope?: AutomaticBuildAttemptScopeV1;
  },
):
  | { status: "ready"; execution_identity: AutomaticBuildExecutionIdentity }
  | {
      status: "retry_exhausted";
      semantic_attempt: number;
      attempt_scope_digest?: string;
      failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
      retry_boundary?: AutomaticBuildRetryBoundaryV1;
    }
  | {
      status: "executor_instability";
      semantic_attempt: number;
      lease_epoch: number;
      attempt_scope_digest?: string;
    }
  | {
      status: "policy_generation_migration_required";
      requested_attempt_scope_digest: string;
      reason: "legacy_attempt_scope_ambiguous";
    } {
  positiveInteger(limits.max_semantic_attempts, "max_semantic_attempts");
  positiveInteger(limits.max_lease_epochs, "max_lease_epochs");
  const attemptScope = limits.attempt_scope
    ? validateAutomaticBuildAttemptScope(limits.attempt_scope, {
        target_ref: target.target_ref,
        stage,
        work_unit_id: workUnitId,
      })
    : undefined;
  const allStates = attemptStates(target, stage, workUnitId);
  const legacyRecord = readLegacyLedger(target)?.stages[stage]?.[workUnitId];
  if (attemptScope && (legacyRecord || allStates.some((state) => !state.attempt_scope_digest))) {
    return {
      status: "policy_generation_migration_required",
      requested_attempt_scope_digest: attemptScope.attempt_scope_digest,
      reason: "legacy_attempt_scope_ambiguous",
    };
  }
  const states = attemptScope
    ? allStates.filter((state) => state.attempt_scope_digest === attemptScope.attempt_scope_digest)
    : allStates;
  const newIdentity = (
    semanticAttempt: number,
    leaseEpoch: number,
  ): AutomaticBuildExecutionIdentity => attemptScope
    ? {
        version: "automatic_build_execution_identity.v2",
        work_unit_id: workUnitId,
        semantic_attempt: semanticAttempt,
        lease_epoch: leaseEpoch,
        submit_revision: 0,
        attempt_scope_digest: attemptScope.attempt_scope_digest,
        identity_source: "native",
      }
    : {
        version: "automatic_build_execution_identity.v1",
        work_unit_id: workUnitId,
        semantic_attempt: semanticAttempt,
        lease_epoch: leaseEpoch,
        submit_revision: 0,
        identity_source: "native",
      };
  if (states.length === 0) {
    return {
      status: "ready",
      execution_identity: newIdentity(1, 1),
    };
  }
  const lastState = states.at(-1)!;
  const identities = inferredIdentities(states);
  const lastIdentity = identities.at(-1)!;
  if (lastState.result?.outcome === "failure") {
    if (!lastState.reset && !lastState.recovery
      && lastIdentity.semantic_attempt >= limits.max_semantic_attempts) {
      const failureDiagnostic = failureDiagnosticFromEvent(lastState.result);
      const retryBoundary = retryBoundaryForState(lastState, lastIdentity);
      return {
        status: "retry_exhausted",
        semantic_attempt: lastIdentity.semantic_attempt,
        ...(attemptScope ? { attempt_scope_digest: attemptScope.attempt_scope_digest } : {}),
        ...(failureDiagnostic ? { failure_diagnostic: failureDiagnostic } : {}),
        ...(retryBoundary ? { retry_boundary: retryBoundary } : {}),
      };
    }
    return {
      status: "ready",
      execution_identity: newIdentity(lastIdentity.semantic_attempt + 1, 1),
    };
  }
  let recoveryWindowStartEpoch = 0;
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const identity = identities[index];
    if (identity.semantic_attempt !== lastIdentity.semantic_attempt) break;
    if (states[index].reset) {
      recoveryWindowStartEpoch = identity.lease_epoch;
      break;
    }
  }
  if (lastIdentity.lease_epoch - recoveryWindowStartEpoch >= limits.max_lease_epochs) {
    return {
      status: "executor_instability",
      semantic_attempt: lastIdentity.semantic_attempt,
      lease_epoch: lastIdentity.lease_epoch,
      ...(attemptScope ? { attempt_scope_digest: attemptScope.attempt_scope_digest } : {}),
    };
  }
  return {
    status: "ready",
    execution_identity: newIdentity(lastIdentity.semantic_attempt, lastIdentity.lease_epoch + 1),
  };
}

function writeCreateOnlyEvent(file: string, event: AutomaticBuildAttemptEvent): AutomaticBuildAttemptEvent {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return event;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readAutomaticBuildAttemptEvent(file);
    if (eventEquivalent(existing, event)) return existing;
    if (file.endsWith(`${path.sep}result.json`)) {
      throw new Error(`conflicting terminal attempt event: ${file}`);
    }
    throw new Error(`conflicting reset attempt event: ${file}`);
  }
}

export function recordAutomaticBuildExecutionIdentity(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  physicalAttempt: number,
  identity: AutomaticBuildExecutionIdentity,
  createdAt: string,
): AutomaticBuildExecutionIdentity {
  positiveInteger(physicalAttempt, "physical_attempt");
  positiveInteger(identity.semantic_attempt, "semantic_attempt");
  positiveInteger(identity.lease_epoch, "lease_epoch");
  if (identity.work_unit_id !== workUnitId || identity.submit_revision !== 0) {
    throw new Error("new lease execution identity must match the work unit with submit_revision=0");
  }
  if (identity.version === "automatic_build_execution_identity.v2") {
    assertSha256(identity.attempt_scope_digest, "execution attempt_scope_digest");
  }
  const common = {
    target_ref: target.target_ref,
    stage,
    work_unit_id: workUnitId,
    physical_attempt: physicalAttempt,
    semantic_attempt: identity.semantic_attempt,
    lease_epoch: identity.lease_epoch,
    created_at: createdAt,
  };
  const event: PersistedAutomaticBuildExecutionIdentity = identity.version === "automatic_build_execution_identity.v2"
    ? {
        version: "automatic_build_execution_identity.v2",
        ...common,
        attempt_scope_digest: identity.attempt_scope_digest,
      }
    : {
        version: "automatic_build_execution_identity.v1",
        ...common,
      };
  const file = path.join(automaticBuildTaskAttemptDirectory(target, stage, workUnitId, physicalAttempt), "execution.json");
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readJson<PersistedAutomaticBuildExecutionIdentity>(file);
    if (existing.version !== event.version
      || !sameTargetRef(existing.target_ref, event.target_ref)
      || existing.stage !== event.stage
      || existing.work_unit_id !== event.work_unit_id
      || existing.physical_attempt !== event.physical_attempt
      || existing.semantic_attempt !== event.semantic_attempt
      || existing.lease_epoch !== event.lease_epoch
      || (existing.version === "automatic_build_execution_identity.v2"
        && event.version === "automatic_build_execution_identity.v2"
        && existing.attempt_scope_digest !== event.attempt_scope_digest)) {
      throw new Error(`conflicting automatic build execution identity: ${file}`);
    }
  }
  return { ...identity, identity_source: "native" };
}

export function recordAutomaticBuildSubmitRevision(
  target: AutomaticBuildTarget,
  input: {
    stage: AutomaticBuildStage;
    work_unit_id: string;
    physical_attempt: number;
    candidate_sha256: string;
    created_at?: string;
  },
): AutomaticBuildExecutionIdentity {
  const identity = readAutomaticBuildExecutionIdentity(
    target,
    input.stage,
    input.work_unit_id,
    input.physical_attempt,
  );
  if (!identity) throw new Error("submit revision requires an existing execution identity");
  const revisionsDir = path.join(
    automaticBuildTaskAttemptDirectory(target, input.stage, input.work_unit_id, input.physical_attempt),
    "submit-revisions",
  );
  mkdirSync(revisionsDir, { recursive: true });
  for (let retry = 0; retry < 16; retry += 1) {
    const revision = readAutomaticBuildExecutionIdentity(
      target,
      input.stage,
      input.work_unit_id,
      input.physical_attempt,
    )!.submit_revision + 1;
    const event: AutomaticBuildSubmitRevisionEventV1 = {
      version: "automatic_build_submit_revision.v1",
      target_ref: target.target_ref,
      stage: input.stage,
      work_unit_id: input.work_unit_id,
      physical_attempt: input.physical_attempt,
      semantic_attempt: identity.semantic_attempt,
      lease_epoch: identity.lease_epoch,
      submit_revision: revision,
      ...(identity.version === "automatic_build_execution_identity.v2"
        ? { attempt_scope_digest: identity.attempt_scope_digest }
        : {}),
      candidate_sha256: input.candidate_sha256,
      created_at: input.created_at ?? new Date().toISOString(),
    };
    const file = path.join(revisionsDir, `${String(revision).padStart(4, "0")}.json`);
    try {
      writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return { ...identity, submit_revision: revision };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
    }
  }
  throw new Error(`automatic build submit revision contention did not settle: ${input.stage}/${input.work_unit_id}`);
}

function readLegacyLedger(target: AutomaticBuildTarget): LegacyAttemptLedger | undefined {
  const file = legacyLedgerPath(target);
  if (!existsSync(file)) return undefined;
  const parsed = readJson<LegacyAttemptLedger>(file);
  if (parsed.version !== "automatic_build_attempts.v1" || !parsed.stages) {
    throw new Error(`invalid automatic build attempt ledger: ${file}`);
  }
  return parsed;
}

function readStoredEvents(target: AutomaticBuildTarget): AutomaticBuildAttemptEvent[] {
  const root = automaticBuildTaskStoreRoot(target);
  if (!existsSync(root)) return [];
  const events: AutomaticBuildAttemptEvent[] = [];
  for (const stageEntry of readdirSync(root, { withFileTypes: true })) {
    if (!stageEntry.isDirectory()) continue;
    const stageDir = path.join(root, stageEntry.name);
    for (const taskEntry of readdirSync(stageDir, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue;
      const attemptsDir = path.join(stageDir, taskEntry.name, "attempts");
      if (!existsSync(attemptsDir)) continue;
      for (const attemptEntry of readdirSync(attemptsDir, { withFileTypes: true })) {
        if (!attemptEntry.isDirectory()) continue;
        for (const eventName of ["result.json", "reset.json"] as const) {
          const file = path.join(attemptsDir, attemptEntry.name, eventName);
          if (!existsSync(file)) continue;
          events.push(readAutomaticBuildAttemptEvent(file));
        }
      }
    }
  }
  return events.sort((left, right) => left.attempt - right.attempt
    || (left.outcome === "reset" ? 1 : 0) - (right.outcome === "reset" ? 1 : 0)
    || left.event_id.localeCompare(right.event_id));
}

function readTaskEvents(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
): AutomaticBuildAttemptEvent[] {
  const attemptsDir = path.join(automaticBuildTaskStoreRoot(target), stage, encodeURIComponent(workUnitId), "attempts");
  if (!existsSync(attemptsDir)) return [];
  const events: AutomaticBuildAttemptEvent[] = [];
  for (const attemptEntry of readdirSync(attemptsDir, { withFileTypes: true })) {
    if (!attemptEntry.isDirectory()) continue;
    for (const eventName of ["result.json", "reset.json"] as const) {
      const file = path.join(attemptsDir, attemptEntry.name, eventName);
      if (!existsSync(file)) continue;
      events.push(readAutomaticBuildAttemptEvent(file));
    }
  }
  return events.sort((left, right) => left.attempt - right.attempt
    || (left.outcome === "reset" ? 1 : 0) - (right.outcome === "reset" ? 1 : 0)
    || left.event_id.localeCompare(right.event_id));
}

function applyAttemptEvent(
  target: AutomaticBuildTarget,
  record: AutomaticBuildAttemptRecord,
  event: AutomaticBuildAttemptEvent,
): void {
  record.last_attempt = Math.max(record.last_attempt, event.attempt);
  record.next_attempt = record.last_attempt + 1;
  record.updated_at = event.created_at;
  if (!sameTargetRef(event.target_ref, target.target_ref)) return;
  if (event.outcome === "failure") {
    const failureDiagnostic = failureDiagnosticFromEvent(event) ?? legacyAutomaticBuildFailureDiagnostic();
    record.failures += 1;
    record.last_error = failureDiagnostic.code;
    record.last_failure_diagnostic = failureDiagnostic;
  } else {
    record.failures = 0;
    delete record.last_error;
    delete record.last_failure_diagnostic;
  }
}

export function readAutomaticBuildAttemptRecord(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
): AutomaticBuildAttemptRecord | undefined {
  const legacy = readLegacyLedger(target)?.stages[stage]?.[workUnitId];
  const events = readTaskEvents(target, stage, workUnitId);
  const executionIdentity = readAutomaticBuildExecutionIdentity(target, stage, workUnitId);
  if (!legacy && events.length === 0 && !executionIdentity) return undefined;
  const record: AutomaticBuildAttemptRecord = legacy
    ? {
        failures: legacy.failures,
        ...(legacy.failures > 0 ? {
          last_error: "legacy_unclassified",
          last_failure_diagnostic: legacyAutomaticBuildFailureDiagnostic(),
        } : {}),
        updated_at: legacy.updated_at,
        last_attempt: legacy.failures,
        next_attempt: legacy.failures + 1,
        semantic_attempt: Math.max(1, legacy.failures),
        lease_epoch: 1,
        submit_revision: 0,
        identity_source: "legacy_inferred",
      }
    : {
        failures: 0,
        updated_at: events[0]?.created_at
          ?? attemptStates(target, stage, workUnitId).at(-1)?.observed_at
          ?? new Date(0).toISOString(),
        last_attempt: 0,
        next_attempt: 1,
        semantic_attempt: executionIdentity?.semantic_attempt ?? 1,
        lease_epoch: executionIdentity?.lease_epoch ?? 1,
        submit_revision: executionIdentity?.submit_revision ?? 0,
        identity_source: executionIdentity?.identity_source ?? "legacy_inferred",
        ...(executionIdentity?.version === "automatic_build_execution_identity.v2"
          ? { attempt_scope_digest: executionIdentity.attempt_scope_digest }
          : {}),
      };
  for (const event of events) applyAttemptEvent(target, record, event);
  if (executionIdentity) {
    record.semantic_attempt = executionIdentity.semantic_attempt;
    record.lease_epoch = executionIdentity.lease_epoch;
    record.submit_revision = executionIdentity.submit_revision;
    record.identity_source = executionIdentity.identity_source;
    if (executionIdentity.version === "automatic_build_execution_identity.v2") {
      record.attempt_scope_digest = executionIdentity.attempt_scope_digest;
    } else {
      delete record.attempt_scope_digest;
    }
    record.last_attempt = Math.max(record.last_attempt, attemptStates(target, stage, workUnitId).at(-1)?.attempt ?? 0);
    record.next_attempt = record.last_attempt + 1;
  }
  return record;
}

function stageRecords(
  snapshot: AutomaticBuildAttemptSnapshot,
  stage: AutomaticBuildStage,
): Record<string, AutomaticBuildAttemptRecord> {
  const existing = snapshot.stages[stage];
  if (existing) return existing;
  const created: Record<string, AutomaticBuildAttemptRecord> = {};
  snapshot.stages[stage] = created;
  return created;
}

export function readAutomaticBuildAttemptSnapshot(target: AutomaticBuildTarget): AutomaticBuildAttemptSnapshot {
  const snapshot: AutomaticBuildAttemptSnapshot = { version: "automatic_build_task_store.v2", stages: {} };
  const legacy = readLegacyLedger(target);
  for (const [stage, records] of Object.entries(legacy?.stages ?? {}) as Array<[AutomaticBuildStage, Record<string, LegacyAttemptRecord>]>) {
    const output = stageRecords(snapshot, stage);
    for (const [workUnitId, record] of Object.entries(records)) {
      output[workUnitId] = {
        failures: record.failures,
        ...(record.failures > 0 ? {
          last_error: "legacy_unclassified",
          last_failure_diagnostic: legacyAutomaticBuildFailureDiagnostic(),
        } : {}),
        updated_at: record.updated_at,
        last_attempt: record.failures,
        next_attempt: record.failures + 1,
        semantic_attempt: Math.max(1, record.failures),
        lease_epoch: 1,
        submit_revision: 0,
        identity_source: "legacy_inferred",
      };
    }
  }

  for (const event of readStoredEvents(target)) {
    const output = stageRecords(snapshot, event.stage);
    const previous = output[event.work_unit_id];
    const record: AutomaticBuildAttemptRecord = previous ?? {
      failures: 0,
      updated_at: event.created_at,
      last_attempt: 0,
      next_attempt: 1,
      semantic_attempt: 1,
      lease_epoch: 1,
      submit_revision: 0,
      identity_source: "legacy_inferred",
    };
    applyAttemptEvent(target, record, event);
    output[event.work_unit_id] = record;
  }
  const root = automaticBuildTaskStoreRoot(target);
  if (existsSync(root)) {
    for (const stageEntry of readdirSync(root, { withFileTypes: true })) {
      if (!stageEntry.isDirectory()) continue;
      const stage = stageEntry.name as AutomaticBuildStage;
      const stageDir = path.join(root, stageEntry.name);
      for (const taskEntry of readdirSync(stageDir, { withFileTypes: true })) {
        if (!taskEntry.isDirectory()) continue;
        const workUnitId = decodeURIComponent(taskEntry.name);
        const record = readAutomaticBuildAttemptRecord(target, stage, workUnitId);
        if (record) stageRecords(snapshot, stage)[workUnitId] = record;
      }
    }
  }
  return snapshot;
}

function validateTerminalFailurePhaseFacts(
  target: AutomaticBuildTarget,
  input: Pick<AutomaticBuildAttemptEventInput, "stage" | "work_unit_id" | "attempt">,
  diagnostic: AutomaticBuildFailureDiagnosticV2,
): void {
  if (!isAutomaticBuildFailureDiagnosticV3(diagnostic)) return;
  if (diagnostic.phase === "input_delivery" || diagnostic.phase === "candidate_sink") {
    throw new Error(`${diagnostic.phase} is a non-semantic terminal failure phase`);
  }
  const attemptDir = automaticBuildTaskAttemptDirectory(
    target,
    input.stage,
    input.work_unit_id,
    input.attempt,
  );
  const submissionFile = path.join(attemptDir, "submission.json");
  if (diagnostic.phase === "generation") {
    if (existsSync(submissionFile)) {
      throw new Error("generation failure conflicts with a persisted writer-start fact");
    }
    validateAutomaticBuildFailureDiagnostic(diagnostic, {
      writer_started: false,
      output_bytes: 0,
    });
    return;
  }
  const metricsFile = path.join(attemptDir, "metrics.json");
  if (!existsSync(submissionFile) || !existsSync(metricsFile)) {
    throw new Error("artifact_writer failure requires persisted writer-start phase facts");
  }
  const metrics = readJson<Record<string, unknown>>(metricsFile);
  validateAutomaticBuildFailureDiagnostic(diagnostic, {
    writer_started: metrics.writer_started === true,
    ...(typeof metrics.output_bytes === "number" ? { output_bytes: metrics.output_bytes } : {}),
  });
  if (metrics.failure_phase !== diagnostic.phase) {
    throw new Error("artifact_writer failure metrics disagree with the diagnostic phase");
  }
}

export function recordAutomaticBuildAttemptEvent(
  target: AutomaticBuildTarget,
  input: AutomaticBuildAttemptEventInput,
): AutomaticBuildAttemptRecord {
  if (!input.work_unit_id) throw new Error("work_unit_id must not be empty");
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new Error("attempt must be a positive integer");
  if (!input.event_id || input.event_id.length > 256) throw new Error("event_id must contain 1-256 characters");
  const executionIdentity = executionIdentityFromStates(
    attemptStates(target, input.stage, input.work_unit_id, {
      allow_pending_terminal_failure_receipt: input.outcome === "failure",
    }),
    input.work_unit_id,
    input.attempt,
  );
  if (input.outcome === "reset"
    && executionIdentity?.version === "automatic_build_execution_identity.v2") {
    throw new Error("scoped automatic build tasks require a guarded recovery receipt");
  }
  if (input.outcome !== "failure"
    && (input.failure_diagnostic !== undefined || input.diagnostic !== undefined)) {
    throw new Error("only failure attempt events may contain diagnostics");
  }
  const failureDiagnostic = input.outcome === "failure"
    ? input.failure_diagnostic
      ? validateAutomaticBuildFailureDiagnostic(input.failure_diagnostic)
      : legacyAutomaticBuildFailureDiagnostic()
    : undefined;
  if (failureDiagnostic) {
    validateTerminalFailurePhaseFacts(target, input, failureDiagnostic);
  }
  const event: AutomaticBuildAttemptEventV3 = {
    version: "automatic_build_attempt_event.v3",
    target_ref: target.target_ref,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    attempt: input.attempt,
    event_id: input.event_id,
    outcome: input.outcome,
    ...(failureDiagnostic ? { failure_diagnostic: failureDiagnostic } : {}),
    ...(executionIdentity?.version === "automatic_build_execution_identity.v2"
      ? { attempt_scope_digest: executionIdentity.attempt_scope_digest }
      : {}),
    created_at: input.created_at ?? new Date().toISOString(),
  };
  const dir = automaticBuildTaskAttemptDirectory(target, input.stage, input.work_unit_id, input.attempt);
  const file = path.join(dir, input.outcome === "reset" ? "reset.json" : "result.json");
  writeCreateOnlyEvent(file, event);
  const record = readAutomaticBuildAttemptRecord(target, input.stage, input.work_unit_id);
  if (!record) throw new Error(`attempt event was not visible after write: ${file}`);
  return record;
}
