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
import {
  automaticBuildTaskAttemptDirectory,
  automaticBuildTaskStoreRoot,
  readAutomaticBuildAttemptRecord,
} from "./automatic-build-task-store";
import {
  freezeAutomaticBuildStagePolicy,
  type AutomaticBuildTaskPolicyBindingV1,
  type ExtractionPolicyFingerprintV1,
} from "./semantic-artifact";

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
  policy_fingerprint?: ExtractionPolicyFingerprintV1;
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
  binding?: AutomaticBuildTaskPolicyBindingV1;
}

export type AutomaticBuildClaimResult =
  | { status: "leased"; lease_ref: string; lease: AutomaticBuildTaskLeaseV1 }
  | { status: "already_leased"; lease_ref: string; lease: AutomaticBuildTaskLeaseV1 };

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

function assertLeasePath(target: AutomaticBuildTarget, leaseRef: string): string {
  const root = path.resolve(automaticBuildTaskStoreRoot(target));
  const resolved = path.resolve(leaseRef);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(resolved) !== "lease.json") {
    throw new Error(`lease_ref escapes automatic build task store: ${leaseRef}`);
  }
  return resolved;
}

function effectiveExpiry(leaseRef: string, lease: AutomaticBuildTaskLeaseV1): string {
  const heartbeatPath = path.join(path.dirname(leaseRef), "heartbeat.json");
  if (!existsSync(heartbeatPath)) return lease.expires_at;
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

function activeLeaseAt(
  target: AutomaticBuildTarget,
  leaseRef: string,
  now: string,
): AutomaticBuildTaskLeaseV1 | undefined {
  const lease = readJson<AutomaticBuildTaskLeaseV1>(leaseRef);
  if (lease.version !== "automatic_build_task_lease.v1") throw new Error(`invalid automatic build lease: ${leaseRef}`);
  if (!sameTargetRef(lease.target_ref, target.target_ref) || terminalEventExists(leaseRef)) return undefined;
  return timeMs(now, "now") < timeMs(effectiveExpiry(leaseRef, lease), "expires_at") ? lease : undefined;
}

export function assertActiveAutomaticBuildLease(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  now = new Date().toISOString(),
): AutomaticBuildTaskLeaseV1 {
  const lease = readAutomaticBuildLease(target, leaseRef, token);
  const resolved = assertLeasePath(target, leaseRef);
  if (terminalEventExists(resolved)) throw new Error(`automatic build lease is already terminal: ${resolved}`);
  if (timeMs(now, "now") >= timeMs(effectiveExpiry(resolved, lease), "expires_at")) {
    throw new Error(`automatic build lease expired: ${resolved}`);
  }
  return lease;
}

export function readAutomaticBuildLease(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
): AutomaticBuildTaskLeaseV1 {
  const resolved = assertLeasePath(target, leaseRef);
  if (!existsSync(resolved)) throw new Error(`automatic build lease does not exist: ${resolved}`);
  const lease = readJson<AutomaticBuildTaskLeaseV1>(resolved);
  if (lease.version !== "automatic_build_task_lease.v1" || !sameTargetRef(lease.target_ref, target.target_ref)) {
    throw new Error(`automatic build lease target mismatch: ${resolved}`);
  }
  if (lease.token !== token) throw new Error(`automatic build lease token mismatch: ${resolved}`);
  return lease;
}

export function heartbeatAutomaticBuildLease(
  target: AutomaticBuildTarget,
  leaseRef: string,
  token: string,
  options: { now?: string; ttl_ms?: number } = {},
): AutomaticBuildTaskHeartbeatV1 {
  const times = leaseTimes(options.now, options.ttl_ms);
  const resolved = assertLeasePath(target, leaseRef);
  const lease = assertActiveAutomaticBuildLease(target, resolved, token, times.now);
  const heartbeat: AutomaticBuildTaskHeartbeatV1 = {
    version: "automatic_build_task_heartbeat.v1",
    lease_token: lease.token,
    owner: lease.owner,
    updated_at: times.now,
    expires_at: times.expires_at,
  };
  writeHeartbeatAtomic(path.join(path.dirname(resolved), "heartbeat.json"), heartbeat);
  return heartbeat;
}

export function claimAutomaticBuildTask(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  options: AutomaticBuildLeaseOptions,
): AutomaticBuildClaimResult {
  if (!options.owner) throw new Error("lease owner must not be empty");
  const times = leaseTimes(options.now, options.ttl_ms);
  if (options.binding) {
    if (stage === "paper_reading_guide") throw new Error("paper_reading_guide does not accept semantic task bindings");
    freezeAutomaticBuildStagePolicy(target, stage, options.binding.policy_fingerprint, times.now);
  }
  for (let retry = 0; retry < 8; retry += 1) {
    const directories = attemptDirectories(target, stage, workUnitId);
    for (const entry of directories) {
      if (!entry.lease_ref) continue;
      const active = activeLeaseAt(target, entry.lease_ref, times.now);
      if (active) return { status: "already_leased", lease_ref: entry.lease_ref, lease: active };
    }
    const persisted = readAutomaticBuildAttemptRecord(target, stage, workUnitId);
    const maxDirectoryAttempt = directories.at(-1)?.attempt ?? 0;
    const attempt = Math.max(maxDirectoryAttempt, persisted?.last_attempt ?? 0) + 1;
    const attemptDir = automaticBuildTaskAttemptDirectory(target, stage, workUnitId, attempt);
    mkdirSync(attemptDir, { recursive: true });
    const leaseRef = path.join(attemptDir, "lease.json");
    const lease: AutomaticBuildTaskLeaseV1 = {
      version: "automatic_build_task_lease.v1",
      target_ref: target.target_ref,
      stage,
      work_unit_id: workUnitId,
      attempt,
      owner: options.owner,
      token: randomUUID(),
      issued_at: times.now,
      expires_at: times.expires_at,
      ...(options.binding ? {
        input_hash: options.binding.input_hash,
        policy_fingerprint: options.binding.policy_fingerprint,
      } : {}),
    };
    try {
      writeFileSync(leaseRef, `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return { status: "leased", lease_ref: leaseRef, lease };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
    }
  }
  throw new Error(`automatic build claim contention did not settle: ${stage}/${workUnitId}`);
}
