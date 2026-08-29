import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AutomaticBuildStage, AutomaticBuildTarget, BuildTargetRefV2 } from "./build-orchestrator";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V1 } from "./executor-transport";
import type { AutomaticBuildFailureDiagnosticV2 } from "./extractor-contract";
import {
  automaticBuildTaskAttemptDirectory,
  automaticBuildTaskStoreRoot,
  createAutomaticBuildAttemptScope,
  nextAutomaticBuildExecutionIdentity,
  readAutomaticBuildAttemptRecord,
  readAutomaticBuildExecutionIdentity,
  recordAutomaticBuildExecutionIdentity,
  validateAutomaticBuildAttemptScope,
  type AutomaticBuildAttemptScopeV1,
  type AutomaticBuildExecutionIdentity,
} from "./automatic-build-task-store";
import {
  freezeAutomaticBuildStagePolicy,
  freezeAutomaticBuildStagePolicyGeneration,
  isAutomaticBuildTaskPolicyBindingV2,
  type AutomaticBuildTaskPolicyBinding,
  type ExtractionPolicyFingerprintV1,
} from "./semantic-artifact";
import {
  isProofBoundWorkUnitDescriptor,
  isWorkUnitDescriptorV3,
  validateWorkUnitDescriptorV3,
  validateWorkUnitDescriptorV4,
  validateWorkUnitTaskPolicyBinding,
  type WorkUnitDescriptor,
} from "./stage-work-unit";

const DEFAULT_RESERVE_TTL_MS = 600_000;
const DEFAULT_RUN_TTL_MS = 1_800_000;
const CLAIM_PUBLICATION_WAIT_MS = 250;
const CLAIM_PUBLICATION_POLL_MS = 5;
const claimPublicationWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface AutomaticBuildTaskLeaseV1 {
  version: "automatic_build_task_lease.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  attempt: number;
  owner: string;
  token: string;
  issued_at: string;
  expires_at: string;
  input_hash?: string;
  proof_digest?: string;
  policy_set_digest?: string;
  policy_fingerprint?: ExtractionPolicyFingerprintV1;
  attempt_scope_digest?: string;
}

export interface AutomaticBuildTaskLeaseV2 {
  version: "automatic_build_task_lease.v2";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  attempt: number;
  phase: "reserved";
  owner: string;
  token: string;
  reserved_at: string;
  reserve_expires_at: string;
  issued_at: string;
  expires_at: string;
  input_hash?: string;
  proof_digest?: string;
  policy_set_digest?: string;
  policy_fingerprint?: ExtractionPolicyFingerprintV1;
  attempt_scope_digest?: string;
}

export type AutomaticBuildTaskLease = AutomaticBuildTaskLeaseV1 | AutomaticBuildTaskLeaseV2;

export interface AutomaticBuildTaskStartV1 {
  version: "automatic_build_task_start.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  phase: "running";
  owner: string;
  lease_token: string;
  execution_identity: AutomaticBuildExecutionIdentity;
  started_at: string;
  run_expires_at: string;
}

export interface AutomaticBuildTaskHeartbeatV1 {
  version: "automatic_build_task_heartbeat.v1";
  lease_token: string;
  owner: string;
  updated_at: string;
  expires_at: string;
}

export interface AutomaticBuildLeaseOptions {
  owner: string;
  now?: string;
  ttl_ms?: number;
  reserve_ttl_ms?: number;
  binding?: AutomaticBuildTaskPolicyBinding;
  descriptor?: WorkUnitDescriptor;
  policy_generation?: "v2_compatible" | "v3_only";
  max_semantic_attempts?: number;
  max_lease_epochs?: number;
}

export interface AutomaticBuildClaimInspectionOptions {
  now?: string;
  binding?: AutomaticBuildTaskPolicyBinding;
  descriptor?: WorkUnitDescriptor;
  attempt_scope?: AutomaticBuildAttemptScopeV1;
  policy_generation?: "v2_compatible" | "v3_only";
  max_semantic_attempts?: number;
  max_lease_epochs?: number;
}

export type AutomaticBuildClaimResult =
  | {
      status: "leased";
      lease_ref: string;
      lease: AutomaticBuildTaskLease;
      execution_identity: AutomaticBuildExecutionIdentity;
    }
  | {
      status: "already_leased";
      lease_ref: string;
      lease: AutomaticBuildTaskLease;
      execution_identity: AutomaticBuildExecutionIdentity;
    }
  | {
      status: "retry_exhausted";
      semantic_attempt: number;
      attempt_scope_digest?: string;
      failure_diagnostic?: AutomaticBuildFailureDiagnosticV2;
    }
  | {
      status: "executor_instability";
      semantic_attempt: number;
      lease_epoch: number;
      attempt_scope_digest?: string;
    }
  | {
      status: "policy_generation_conflict" | "policy_generation_migration_required";
      lease_ref: string;
      lease: AutomaticBuildTaskLease;
      requested_attempt_scope_digest: string;
      active_attempt_scope_digest?: string;
    }
  | {
      status: "policy_generation_migration_required";
      requested_attempt_scope_digest: string;
      reason: "legacy_attempt_scope_ambiguous";
    };

export type AutomaticBuildClaimInspection =
  | { status: "ready"; execution_identity: AutomaticBuildExecutionIdentity }
  | Exclude<AutomaticBuildClaimResult, { status: "leased" }>;

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function timeMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function leaseTimes(now: string | undefined, ttlMs: number | undefined): { now: string; expires_at: string } {
  const effectiveNow = now ?? new Date().toISOString();
  const nowMs = timeMs(effectiveNow, "now");
  const effectiveTtl = ttlMs ?? 300_000;
  if (!Number.isInteger(effectiveTtl) || effectiveTtl < 1) throw new Error("ttl_ms must be a positive integer");
  return { now: effectiveNow, expires_at: new Date(nowMs + effectiveTtl).toISOString() };
}

function sameTargetRef(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

export function automaticBuildTaskPolicyBindingFromLease(
  lease: AutomaticBuildTaskLease,
): AutomaticBuildTaskPolicyBinding | undefined {
  const hasInputHash = lease.input_hash !== undefined;
  const hasPolicy = lease.policy_fingerprint !== undefined;
  const hasProof = lease.proof_digest !== undefined;
  const hasPolicySet = lease.policy_set_digest !== undefined;
  if (!hasInputHash && !hasPolicy && !hasProof && !hasPolicySet) return undefined;
  if (!hasInputHash || !hasPolicy || hasProof !== hasPolicySet) {
    throw new Error("automatic build lease contains a partial task policy binding");
  }
  return hasProof
    ? {
        input_hash: lease.input_hash!,
        proof_digest: lease.proof_digest!,
        policy_set_digest: lease.policy_set_digest!,
        policy_fingerprint: lease.policy_fingerprint!,
      }
    : {
        input_hash: lease.input_hash!,
        policy_fingerprint: lease.policy_fingerprint!,
      };
}

export function automaticBuildAttemptScopeFromLease(
  lease: AutomaticBuildTaskLease,
): AutomaticBuildAttemptScopeV1 | undefined {
  const binding = automaticBuildTaskPolicyBindingFromLease(lease);
  if (!binding || !isAutomaticBuildTaskPolicyBindingV2(binding)) {
    if (lease.attempt_scope_digest !== undefined) {
      throw new Error("automatic build lease attempt scope requires a complete v3 task binding");
    }
    return undefined;
  }
  const scope = createAutomaticBuildAttemptScope({
    target_ref: lease.target_ref,
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    task_binding: binding,
  });
  if (lease.attempt_scope_digest !== undefined
    && lease.attempt_scope_digest !== scope.attempt_scope_digest) {
    throw new Error("automatic build lease attempt scope digest mismatch");
  }
  return scope;
}

function resolveRequestedAttemptScope(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  options: AutomaticBuildClaimInspectionOptions,
  requireDescriptorBinding: boolean,
): AutomaticBuildAttemptScopeV1 | undefined {
  if (Boolean(options.binding) !== Boolean(options.descriptor)) {
    const legacyV2Claim = requireDescriptorBinding
      && options.binding
      && !isAutomaticBuildTaskPolicyBindingV2(options.binding);
    const scopedInspection = !requireDescriptorBinding
      && options.binding
      && isAutomaticBuildTaskPolicyBindingV2(options.binding);
    if (!legacyV2Claim && !scopedInspection) {
      throw new Error("v3 automatic build claims require both descriptor and task policy binding");
    }
  }
  if (options.descriptor && options.binding) {
    if (options.descriptor.stage !== stage || options.descriptor.work_unit_id !== workUnitId
      || !sameTargetRef(options.descriptor.target, target.target_ref)) {
      throw new Error("automatic build claim descriptor identity mismatch");
    }
    if (isProofBoundWorkUnitDescriptor(options.descriptor)) {
      if (isWorkUnitDescriptorV3(options.descriptor)) {
        validateWorkUnitDescriptorV3(options.descriptor);
      } else {
        validateWorkUnitDescriptorV4(options.descriptor, CODEX_EXECUTOR_TRANSPORT_PROFILE_V1);
      }
    }
    validateWorkUnitTaskPolicyBinding(options.descriptor, options.binding);
  }
  const descriptorScope = options.descriptor
    && options.binding
    && isProofBoundWorkUnitDescriptor(options.descriptor)
    && isAutomaticBuildTaskPolicyBindingV2(options.binding)
    ? createAutomaticBuildAttemptScope({
        target_ref: target.target_ref,
        stage,
        work_unit_id: workUnitId,
        task_binding: options.binding,
      })
    : undefined;
  const bindingScope = !options.descriptor
    && options.binding
    && isAutomaticBuildTaskPolicyBindingV2(options.binding)
    ? createAutomaticBuildAttemptScope({
        target_ref: target.target_ref,
        stage,
        work_unit_id: workUnitId,
        task_binding: options.binding,
      })
    : undefined;
  const suppliedScope = options.attempt_scope
    ? validateAutomaticBuildAttemptScope(options.attempt_scope, {
        target_ref: target.target_ref,
        stage,
        work_unit_id: workUnitId,
      })
    : undefined;
  const derivedScope = descriptorScope ?? bindingScope;
  if (derivedScope && suppliedScope
    && derivedScope.attempt_scope_digest !== suppliedScope.attempt_scope_digest) {
    throw new Error("automatic build claim attempt scope does not match descriptor binding");
  }
  const scope = derivedScope ?? suppliedScope;
  if (options.policy_generation === "v3_only"
    && (!scope
      || (requireDescriptorBinding
        && (!options.descriptor || !options.binding
          || !isProofBoundWorkUnitDescriptor(options.descriptor)
          || !isAutomaticBuildTaskPolicyBindingV2(options.binding))))) {
    throw new Error("policy_generation_migration_required: v3 release forbids unscoped claims");
  }
  return scope;
}

function assertLeasePath(target: AutomaticBuildTarget, leaseRef: string): string {
  const root = path.resolve(automaticBuildTaskStoreRoot(target));
  const resolved = path.resolve(leaseRef);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(resolved) !== "lease.json") {
    throw new Error(`lease_ref escapes automatic build task store: ${leaseRef}`);
  }
  return resolved;
}

function startPath(leaseRef: string): string {
  return path.join(path.dirname(leaseRef), "start.json");
}

function readAutomaticBuildStart(
  target: AutomaticBuildTarget,
  leaseRef: string,
  lease: AutomaticBuildTaskLease,
): AutomaticBuildTaskStartV1 | undefined {
  const file = startPath(leaseRef);
  if (!existsSync(file)) return undefined;
  const start = readJson<AutomaticBuildTaskStartV1>(file);
  const identity = readAutomaticBuildExecutionIdentity(
    target,
    lease.stage,
    lease.work_unit_id,
    lease.attempt,
  );
  if (start.version !== "automatic_build_task_start.v1"
    || !sameTargetRef(start.target_ref, lease.target_ref)
    || start.stage !== lease.stage
    || start.work_unit_id !== lease.work_unit_id
    || start.physical_attempt !== lease.attempt
    || start.owner !== lease.owner
    || start.lease_token !== lease.token
    || !identity
    || start.execution_identity.version !== identity.version
    || start.execution_identity.semantic_attempt !== identity.semantic_attempt
    || start.execution_identity.lease_epoch !== identity.lease_epoch
    || (start.execution_identity.version === "automatic_build_execution_identity.v2"
      && identity.version === "automatic_build_execution_identity.v2"
      && start.execution_identity.attempt_scope_digest !== identity.attempt_scope_digest)) {
    throw new Error(`invalid automatic build start: ${file}`);
  }
  return start;
}

function effectiveExpiry(target: AutomaticBuildTarget, leaseRef: string, lease: AutomaticBuildTaskLease): string {
  const start = readAutomaticBuildStart(target, leaseRef, lease);
  const phaseExpiry = start
    ? start.run_expires_at
    : lease.version === "automatic_build_task_lease.v2"
      ? lease.reserve_expires_at
      : lease.expires_at;
  const heartbeatPath = path.join(path.dirname(leaseRef), "heartbeat.json");
  if (!existsSync(heartbeatPath)) return phaseExpiry;
  if (!start && lease.version === "automatic_build_task_lease.v2") {
    throw new Error(`automatic build heartbeat requires a running lease: ${heartbeatPath}`);
  }
  const heartbeat = readJson<AutomaticBuildTaskHeartbeatV1>(heartbeatPath);
  if (heartbeat.version !== "automatic_build_task_heartbeat.v1"
    || heartbeat.lease_token !== lease.token
    || heartbeat.owner !== lease.owner) {
    throw new Error(`invalid automatic build heartbeat: ${heartbeatPath}`);
  }
  return heartbeat.expires_at;
}

function terminalEventExists(leaseRef: string): boolean {
  return existsSync(path.join(path.dirname(leaseRef), "result.json"));
}

function writeHeartbeatAtomic(file: string, heartbeat: AutomaticBuildTaskHeartbeatV1): void {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    if (!existsSync(file)) throw error;
    rmSync(file);
    renameSync(temp, file);
  }
}

function appendHeartbeatObservation(leaseRef: string, heartbeat: AutomaticBuildTaskHeartbeatV1): void {
  const directory = path.join(path.dirname(leaseRef), "heartbeats");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${heartbeat.updated_at.replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  writeFileSync(file, `${JSON.stringify(heartbeat, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function taskAttemptsDirectory(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
): string {
  return path.dirname(automaticBuildTaskAttemptDirectory(target, stage, workUnitId, 1));
}

function attemptDirectories(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
): Array<{ attempt: number; lease_ref?: string }> {
  const attemptsDir = taskAttemptsDirectory(target, stage, workUnitId);
  if (!existsSync(attemptsDir)) return [];
  return readdirSync(attemptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => {
      const leaseRef = path.join(attemptsDir, entry.name, "lease.json");
      return { attempt: Number(entry.name), ...(existsSync(leaseRef) ? { lease_ref: leaseRef } : {}) };
    })
    .sort((left, right) => left.attempt - right.attempt);
}

function waitForClaimPublication(leaseRef: string): boolean {
  const deadline = Date.now() + CLAIM_PUBLICATION_WAIT_MS;
  while (!existsSync(leaseRef) && Date.now() < deadline) {
    Atomics.wait(claimPublicationWaiter, 0, 0, CLAIM_PUBLICATION_POLL_MS);
  }
  return existsSync(leaseRef);
}

function activeLeaseAt(
  target: AutomaticBuildTarget,
  leaseRef: string,
  now: string,
): AutomaticBuildTaskLease | undefined {
  const lease = readJson<AutomaticBuildTaskLease>(leaseRef);
  if (!(["automatic_build_task_lease.v1", "automatic_build_task_lease.v2"] as string[]).includes(lease.version)) {
    throw new Error(`invalid automatic build lease: ${leaseRef}`);
  }
  if (!sameTargetRef(lease.target_ref, target.target_ref) || terminalEventExists(leaseRef)) return undefined;
  automaticBuildTaskPolicyBindingFromLease(lease);
  automaticBuildAttemptScopeFromLease(lease);
  return timeMs(now, "now") < timeMs(effectiveExpiry(target, leaseRef, lease), "expires_at") ? lease : undefined;
}

export function inspectAutomaticBuildTaskClaim(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  options: AutomaticBuildClaimInspectionOptions = {},
): AutomaticBuildClaimInspection {
  const now = options.now ?? new Date().toISOString();
  timeMs(now, "now");
  const requestedScope = resolveRequestedAttemptScope(target, stage, workUnitId, options, false);
  for (const entry of attemptDirectories(target, stage, workUnitId)) {
    if (!entry.lease_ref) continue;
    const active = activeLeaseAt(target, entry.lease_ref, now);
    if (!active) continue;
    const executionIdentity = readAutomaticBuildExecutionIdentity(target, stage, workUnitId, active.attempt);
    if (!executionIdentity) throw new Error(`active lease is missing execution identity: ${entry.lease_ref}`);
    if (requestedScope) {
      const activeScope = automaticBuildAttemptScopeFromLease(active);
      if (!activeScope || activeScope.attempt_scope_digest !== requestedScope.attempt_scope_digest) {
        return {
          status: activeScope ? "policy_generation_conflict" : "policy_generation_migration_required",
          lease_ref: entry.lease_ref,
          lease: active,
          requested_attempt_scope_digest: requestedScope.attempt_scope_digest,
          ...(activeScope ? { active_attempt_scope_digest: activeScope.attempt_scope_digest } : {}),
        };
      }
      if (executionIdentity.version !== "automatic_build_execution_identity.v2"
        || executionIdentity.attempt_scope_digest !== requestedScope.attempt_scope_digest) {
        throw new Error(`active lease execution identity scope mismatch: ${entry.lease_ref}`);
      }
    }
    return {
      status: "already_leased",
      lease_ref: entry.lease_ref,
      lease: active,
      execution_identity: executionIdentity,
    };
  }
  return nextAutomaticBuildExecutionIdentity(target, stage, workUnitId, {
    max_semantic_attempts: options.max_semantic_attempts ?? 3,
    max_lease_epochs: options.max_lease_epochs ?? 3,
    ...(requestedScope ? { attempt_scope: requestedScope } : {}),
  });
}

export function assertActiveAutomaticBuildLease(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  now = new Date().toISOString(),
): AutomaticBuildTaskLease {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  const resolved = assertLeasePath(target, leaseRef);
  if (terminalEventExists(resolved)) throw new Error(`automatic build lease is already terminal: ${resolved}`);
  if (timeMs(now, "now") >= timeMs(effectiveExpiry(target, resolved, lease), "expires_at")) {
    throw new Error(`automatic build lease expired: ${resolved}`);
  }
  return lease;
}

export function readAutomaticBuildLease(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
): AutomaticBuildTaskLease {
  const resolved = assertLeasePath(target, leaseRef);
  if (!existsSync(resolved)) throw new Error(`automatic build lease does not exist: ${resolved}`);
  const lease = readJson<AutomaticBuildTaskLease>(resolved);
  if (!(["automatic_build_task_lease.v1", "automatic_build_task_lease.v2"] as string[]).includes(lease.version)
    || !sameTargetRef(lease.target_ref, target.target_ref)) {
    throw new Error(`automatic build lease target mismatch: ${resolved}`);
  }
  if (lease.token !== token) throw new Error(`automatic build lease token mismatch: ${resolved}`);
  automaticBuildTaskPolicyBindingFromLease(lease);
  automaticBuildAttemptScopeFromLease(lease);
  return lease;
}

export function startAutomaticBuildLease(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  options: { now?: string; run_ttl_ms?: number } = {},
): AutomaticBuildTaskStartV1 {
  const resolved = assertLeasePath(target, leaseRef);
  const lease = readAutomaticBuildLease(target, resolved, token);
  const existing = readAutomaticBuildStart(target, resolved, lease);
  if (existing) return existing;
  const times = leaseTimes(options.now, options.run_ttl_ms ?? DEFAULT_RUN_TTL_MS);
  assertActiveAutomaticBuildLease(target, resolved, token, times.now);
  const executionIdentity = readAutomaticBuildExecutionIdentity(
    target,
    lease.stage,
    lease.work_unit_id,
    lease.attempt,
  );
  if (!executionIdentity) throw new Error(`automatic build start is missing execution identity: ${resolved}`);
  const start: AutomaticBuildTaskStartV1 = {
    version: "automatic_build_task_start.v1",
    target_ref: lease.target_ref,
    stage: lease.stage,
    work_unit_id: lease.work_unit_id,
    physical_attempt: lease.attempt,
    phase: "running",
    owner: lease.owner,
    lease_token: lease.token,
    execution_identity: executionIdentity,
    started_at: times.now,
    run_expires_at: times.expires_at,
  };
  const file = startPath(resolved);
  try {
    writeFileSync(file, `${JSON.stringify(start, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return start;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const raced = readAutomaticBuildStart(target, resolved, lease);
    if (!raced) throw error;
    return raced;
  }
}

export function heartbeatAutomaticBuildLease(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  options: { now?: string; ttl_ms?: number } = {},
): AutomaticBuildTaskHeartbeatV1 {
  const times = leaseTimes(options.now, options.ttl_ms ?? DEFAULT_RUN_TTL_MS);
  const resolved = assertLeasePath(target, leaseRef);
  const lease = readAutomaticBuildLease(target, resolved, token);
  if (!readAutomaticBuildStart(target, resolved, lease)) {
    throw new Error(`automatic build heartbeat requires a running lease: ${resolved}`);
  }
  assertActiveAutomaticBuildLease(target, resolved, token, times.now);
  const heartbeat: AutomaticBuildTaskHeartbeatV1 = {
    version: "automatic_build_task_heartbeat.v1",
    lease_token: lease.token,
    owner: lease.owner,
    updated_at: times.now,
    expires_at: times.expires_at,
  };
  writeHeartbeatAtomic(path.join(path.dirname(resolved), "heartbeat.json"), heartbeat);
  appendHeartbeatObservation(resolved, heartbeat);
  return heartbeat;
}

export function claimAutomaticBuildTask(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  options: AutomaticBuildLeaseOptions,
): AutomaticBuildClaimResult {
  if (!options.owner) throw new Error("lease owner must not be empty");
  const times = leaseTimes(options.now, options.reserve_ttl_ms ?? options.ttl_ms ?? DEFAULT_RESERVE_TTL_MS);
  const attemptScope = resolveRequestedAttemptScope(target, stage, workUnitId, options, true);
  if (options.binding) {
    if (stage === "paper_reading_guide") throw new Error("paper_reading_guide does not accept semantic task bindings");
    if (!isAutomaticBuildTaskPolicyBindingV2(options.binding)) {
      if (stage === "paper_lexicon") {
        freezeAutomaticBuildStagePolicyGeneration(target, stage, options.binding.policy_fingerprint, times.now);
      } else {
        freezeAutomaticBuildStagePolicy(target, stage, options.binding.policy_fingerprint, times.now);
      }
    }
  }
  for (let retry = 0; retry < 8; retry += 1) {
    let directories = attemptDirectories(target, stage, workUnitId);
    const unpublished = directories.at(-1);
    if (unpublished && !unpublished.lease_ref) {
      waitForClaimPublication(path.join(
        automaticBuildTaskAttemptDirectory(target, stage, workUnitId, unpublished.attempt),
        "lease.json",
      ));
      directories = attemptDirectories(target, stage, workUnitId);
    }
    const persisted = readAutomaticBuildAttemptRecord(target, stage, workUnitId);
    const maxDirectoryAttempt = directories.at(-1)?.attempt ?? 0;
    const attempt = Math.max(maxDirectoryAttempt, persisted?.last_attempt ?? 0) + 1;
    const attemptDir = automaticBuildTaskAttemptDirectory(target, stage, workUnitId, attempt);
    mkdirSync(path.dirname(attemptDir), { recursive: true });
    const leaseRef = path.join(attemptDir, "lease.json");
    const inspection = inspectAutomaticBuildTaskClaim(target, stage, workUnitId, options);
    if (inspection.status !== "ready") return inspection;
    const lease: AutomaticBuildTaskLeaseV2 = {
      version: "automatic_build_task_lease.v2",
      target_ref: target.target_ref,
      stage,
      work_unit_id: workUnitId,
      attempt,
      phase: "reserved",
      owner: options.owner,
      token: randomUUID(),
      reserved_at: times.now,
      reserve_expires_at: times.expires_at,
      issued_at: times.now,
      expires_at: times.expires_at,
      ...(options.binding ? {
        input_hash: options.binding.input_hash,
        ...(isAutomaticBuildTaskPolicyBindingV2(options.binding) ? {
          proof_digest: options.binding.proof_digest,
          policy_set_digest: options.binding.policy_set_digest,
        } : {}),
        policy_fingerprint: options.binding.policy_fingerprint,
      } : {}),
      ...(attemptScope ? { attempt_scope_digest: attemptScope.attempt_scope_digest } : {}),
    };
    try {
      mkdirSync(attemptDir);
      const executionIdentity = recordAutomaticBuildExecutionIdentity(
        target,
        stage,
        workUnitId,
        attempt,
        inspection.execution_identity,
        times.now,
      );
      if (attemptScope && (executionIdentity.version !== "automatic_build_execution_identity.v2"
        || executionIdentity.attempt_scope_digest !== attemptScope.attempt_scope_digest)) {
        throw new Error("automatic build scoped claim produced an inconsistent execution identity");
      }
      writeFileSync(leaseRef, `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return { status: "leased", lease_ref: leaseRef, lease, execution_identity: executionIdentity };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
    }
  }
  throw new Error(`automatic build claim contention did not settle: ${stage}/${workUnitId}`);
}
