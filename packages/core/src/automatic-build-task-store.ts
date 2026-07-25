import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AutomaticBuildStage,
  AutomaticBuildTarget,
  BuildTargetRefV2,
} from "./build-orchestrator";

export type AutomaticBuildAttemptOutcome = "failure" | "success" | "reset";

export interface AutomaticBuildAttemptEventInput {
  stage: AutomaticBuildStage;
  work_unit_id: string;
  attempt: number;
  event_id: string;
  outcome: AutomaticBuildAttemptOutcome;
  diagnostic?: string;
  created_at?: string;
}

export interface AutomaticBuildAttemptEventV2 extends AutomaticBuildAttemptEventInput {
  version: "automatic_build_attempt_event.v2";
  target_ref: BuildTargetRefV2;
  created_at: string;
}

export interface AutomaticBuildAttemptRecord {
  failures: number;
  last_error?: string;
  updated_at: string;
  last_attempt: number;
  next_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  submit_revision: number;
  identity_source: "native" | "legacy_inferred";
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

export interface AutomaticBuildStoredAttemptV1 {
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  attempt_dir: string;
  execution_identity?: AutomaticBuildExecutionIdentityV1;
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

interface AutomaticBuildSubmitRevisionEventV1 {
  version: "automatic_build_submit_revision.v1";
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  work_unit_id: string;
  physical_attempt: number;
  semantic_attempt: number;
  lease_epoch: number;
  submit_revision: number;
  candidate_sha256: string;
  created_at: string;
}

interface AttemptState {
  attempt: number;
  execution?: PersistedAutomaticBuildExecutionIdentityV1;
  result?: AutomaticBuildAttemptEventV2;
  reset?: AutomaticBuildAttemptEventV2;
  submit_revision: number;
  observed_at?: string;
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

function eventEquivalent(left: AutomaticBuildAttemptEventV2, right: AutomaticBuildAttemptEventV2): boolean {
  return left.version === right.version
    && left.event_id === right.event_id
    && left.stage === right.stage
    && left.work_unit_id === right.work_unit_id
    && left.attempt === right.attempt
    && left.outcome === right.outcome
    && left.diagnostic === right.diagnostic
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

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function attemptStates(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
): AttemptState[] {
  const attemptsDir = path.join(automaticBuildTaskStoreRoot(target), stage, encodeURIComponent(workUnitId), "attempts");
  if (!existsSync(attemptsDir)) return [];
  return readdirSync(attemptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => {
      const attempt = Number(entry.name);
      const dir = path.join(attemptsDir, entry.name);
      const leasePath = path.join(dir, "lease.json");
      const executionPath = path.join(dir, "execution.json");
      const resultPath = path.join(dir, "result.json");
      const resetPath = path.join(dir, "reset.json");
      const revisionsDir = path.join(dir, "submit-revisions");
      const lease = existsSync(leasePath) ? readJson<{ issued_at?: string }>(leasePath) : undefined;
      const execution = existsSync(executionPath)
        ? readJson<PersistedAutomaticBuildExecutionIdentityV1>(executionPath)
        : undefined;
      const observedAt = execution?.created_at ?? lease?.issued_at;
      if (execution && (execution.version !== "automatic_build_execution_identity.v1"
        || !sameTargetRef(execution.target_ref, target.target_ref)
        || execution.stage !== stage
        || execution.work_unit_id !== workUnitId
        || execution.physical_attempt !== attempt)) {
        throw new Error(`invalid automatic build execution identity: ${executionPath}`);
      }
      return {
        attempt,
        ...(execution ? { execution } : {}),
        ...(existsSync(resultPath) ? { result: readJson<AutomaticBuildAttemptEventV2>(resultPath) } : {}),
        ...(existsSync(resetPath) ? { reset: readJson<AutomaticBuildAttemptEventV2>(resetPath) } : {}),
        submit_revision: existsSync(revisionsDir)
          ? readdirSync(revisionsDir, { withFileTypes: true })
              .filter((revision) => revision.isFile() && /^\d+\.json$/.test(revision.name))
              .reduce((max, revision) => Math.max(max, Number.parseInt(revision.name, 10)), 0)
          : 0,
        ...(observedAt ? { observed_at: observedAt } : {}),
        meaningful: Boolean(lease || execution || existsSync(resultPath) || existsSync(resetPath) || existsSync(revisionsDir)),
      };
    })
    .filter((state) => state.meaningful)
    .sort((left, right) => left.attempt - right.attempt);
}

function inferredIdentities(states: AttemptState[]): AutomaticBuildExecutionIdentityV1[] {
  const identities: AutomaticBuildExecutionIdentityV1[] = [];
  let semanticAttempt = 1;
  let leaseEpoch = 0;
  let previous: AttemptState | undefined;
  for (const state of states) {
    if (state.execution) {
      semanticAttempt = positiveInteger(state.execution.semantic_attempt, "semantic_attempt");
      leaseEpoch = positiveInteger(state.execution.lease_epoch, "lease_epoch");
      identities.push({
        version: "automatic_build_execution_identity.v1",
        work_unit_id: state.execution.work_unit_id,
        semantic_attempt: semanticAttempt,
        lease_epoch: leaseEpoch,
        submit_revision: state.submit_revision,
        identity_source: "native",
      });
    } else {
      if (previous?.result?.outcome === "failure") {
        semanticAttempt += 1;
        leaseEpoch = 1;
      } else {
        leaseEpoch += 1;
      }
      identities.push({
        version: "automatic_build_execution_identity.v1",
        work_unit_id: previous?.result?.work_unit_id ?? state.result?.work_unit_id ?? "",
        semantic_attempt: semanticAttempt,
        lease_epoch: leaseEpoch,
        submit_revision: state.submit_revision,
        identity_source: "legacy_inferred",
      });
    }
    previous = state;
  }
  return identities;
}

export function readAutomaticBuildExecutionIdentity(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  attempt?: number,
): AutomaticBuildExecutionIdentityV1 | undefined {
  const states = attemptStates(target, stage, workUnitId);
  const index = attempt === undefined ? states.length - 1 : states.findIndex((state) => state.attempt === attempt);
  if (index < 0) return undefined;
  const identity = inferredIdentities(states)[index];
  return identity.work_unit_id ? identity : { ...identity, work_unit_id: workUnitId };
}

export function nextAutomaticBuildExecutionIdentity(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
  limits: { max_semantic_attempts: number; max_lease_epochs: number },
):
  | { status: "ready"; execution_identity: AutomaticBuildExecutionIdentityV1 }
  | { status: "retry_exhausted"; semantic_attempt: number }
  | { status: "executor_instability"; semantic_attempt: number; lease_epoch: number } {
  positiveInteger(limits.max_semantic_attempts, "max_semantic_attempts");
  positiveInteger(limits.max_lease_epochs, "max_lease_epochs");
  const states = attemptStates(target, stage, workUnitId);
  if (states.length === 0) {
    return {
      status: "ready",
      execution_identity: {
        version: "automatic_build_execution_identity.v1",
        work_unit_id: workUnitId,
        semantic_attempt: 1,
        lease_epoch: 1,
        submit_revision: 0,
        identity_source: "native",
      },
    };
  }
  const lastState = states.at(-1)!;
  const lastIdentity = inferredIdentities(states).at(-1)!;
  if (lastState.result?.outcome === "failure") {
    if (!lastState.reset && lastIdentity.semantic_attempt >= limits.max_semantic_attempts) {
      return { status: "retry_exhausted", semantic_attempt: lastIdentity.semantic_attempt };
    }
    return {
      status: "ready",
      execution_identity: {
        version: "automatic_build_execution_identity.v1",
        work_unit_id: workUnitId,
        semantic_attempt: lastIdentity.semantic_attempt + 1,
        lease_epoch: 1,
        submit_revision: 0,
        identity_source: "native",
      },
    };
  }
  if (lastIdentity.lease_epoch >= limits.max_lease_epochs) {
    return {
      status: "executor_instability",
      semantic_attempt: lastIdentity.semantic_attempt,
      lease_epoch: lastIdentity.lease_epoch,
    };
  }
  return {
    status: "ready",
    execution_identity: {
      version: "automatic_build_execution_identity.v1",
      work_unit_id: workUnitId,
      semantic_attempt: lastIdentity.semantic_attempt,
      lease_epoch: lastIdentity.lease_epoch + 1,
      submit_revision: 0,
      identity_source: "native",
    },
  };
}

function writeCreateOnlyEvent(file: string, event: AutomaticBuildAttemptEventV2): AutomaticBuildAttemptEventV2 {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return event;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readJson<AutomaticBuildAttemptEventV2>(file);
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
  identity: AutomaticBuildExecutionIdentityV1,
  createdAt: string,
): AutomaticBuildExecutionIdentityV1 {
  positiveInteger(physicalAttempt, "physical_attempt");
  positiveInteger(identity.semantic_attempt, "semantic_attempt");
  positiveInteger(identity.lease_epoch, "lease_epoch");
  if (identity.work_unit_id !== workUnitId || identity.submit_revision !== 0) {
    throw new Error("new lease execution identity must match the work unit with submit_revision=0");
  }
  const event: PersistedAutomaticBuildExecutionIdentityV1 = {
    version: "automatic_build_execution_identity.v1",
    target_ref: target.target_ref,
    stage,
    work_unit_id: workUnitId,
    physical_attempt: physicalAttempt,
    semantic_attempt: identity.semantic_attempt,
    lease_epoch: identity.lease_epoch,
    created_at: createdAt,
  };
  const file = path.join(automaticBuildTaskAttemptDirectory(target, stage, workUnitId, physicalAttempt), "execution.json");
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readJson<PersistedAutomaticBuildExecutionIdentityV1>(file);
    if (existing.version !== event.version
      || !sameTargetRef(existing.target_ref, event.target_ref)
      || existing.stage !== event.stage
      || existing.work_unit_id !== event.work_unit_id
      || existing.physical_attempt !== event.physical_attempt
      || existing.semantic_attempt !== event.semantic_attempt
      || existing.lease_epoch !== event.lease_epoch) {
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
): AutomaticBuildExecutionIdentityV1 {
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

function readV2Events(target: AutomaticBuildTarget): AutomaticBuildAttemptEventV2[] {
  const root = automaticBuildTaskStoreRoot(target);
  if (!existsSync(root)) return [];
  const events: AutomaticBuildAttemptEventV2[] = [];
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
          const event = readJson<AutomaticBuildAttemptEventV2>(file);
          if (event.version !== "automatic_build_attempt_event.v2") {
            throw new Error(`invalid automatic build attempt event: ${file}`);
          }
          events.push(event);
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
): AutomaticBuildAttemptEventV2[] {
  const attemptsDir = path.join(automaticBuildTaskStoreRoot(target), stage, encodeURIComponent(workUnitId), "attempts");
  if (!existsSync(attemptsDir)) return [];
  const events: AutomaticBuildAttemptEventV2[] = [];
  for (const attemptEntry of readdirSync(attemptsDir, { withFileTypes: true })) {
    if (!attemptEntry.isDirectory()) continue;
    for (const eventName of ["result.json", "reset.json"] as const) {
      const file = path.join(attemptsDir, attemptEntry.name, eventName);
      if (!existsSync(file)) continue;
      const event = readJson<AutomaticBuildAttemptEventV2>(file);
      if (event.version !== "automatic_build_attempt_event.v2") {
        throw new Error(`invalid automatic build attempt event: ${file}`);
      }
      events.push(event);
    }
  }
  return events.sort((left, right) => left.attempt - right.attempt
    || (left.outcome === "reset" ? 1 : 0) - (right.outcome === "reset" ? 1 : 0)
    || left.event_id.localeCompare(right.event_id));
}

function applyAttemptEvent(
  target: AutomaticBuildTarget,
  record: AutomaticBuildAttemptRecord,
  event: AutomaticBuildAttemptEventV2,
): void {
  record.last_attempt = Math.max(record.last_attempt, event.attempt);
  record.next_attempt = record.last_attempt + 1;
  record.updated_at = event.created_at;
  if (!sameTargetRef(event.target_ref, target.target_ref)) return;
  if (event.outcome === "failure") {
    record.failures += 1;
    record.last_error = event.diagnostic;
  } else {
    record.failures = 0;
    delete record.last_error;
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
        ...(legacy.last_error ? { last_error: legacy.last_error } : {}),
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
      };
  for (const event of events) applyAttemptEvent(target, record, event);
  if (executionIdentity) {
    record.semantic_attempt = executionIdentity.semantic_attempt;
    record.lease_epoch = executionIdentity.lease_epoch;
    record.submit_revision = executionIdentity.submit_revision;
    record.identity_source = executionIdentity.identity_source;
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
        ...(record.last_error ? { last_error: record.last_error } : {}),
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

  for (const event of readV2Events(target)) {
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

export function recordAutomaticBuildAttemptEvent(
  target: AutomaticBuildTarget,
  input: AutomaticBuildAttemptEventInput,
): AutomaticBuildAttemptRecord {
  if (!input.work_unit_id) throw new Error("work_unit_id must not be empty");
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new Error("attempt must be a positive integer");
  if (!input.event_id || input.event_id.length > 256) throw new Error("event_id must contain 1-256 characters");
  const event: AutomaticBuildAttemptEventV2 = {
    version: "automatic_build_attempt_event.v2",
    target_ref: target.target_ref,
    ...input,
    created_at: input.created_at ?? new Date().toISOString(),
  };
  const dir = automaticBuildTaskAttemptDirectory(target, input.stage, input.work_unit_id, input.attempt);
  const file = path.join(dir, input.outcome === "reset" ? "reset.json" : "result.json");
  writeCreateOnlyEvent(file, event);
  const record = readAutomaticBuildAttemptRecord(target, input.stage, input.work_unit_id);
  if (!record) throw new Error(`attempt event was not visible after write: ${file}`);
  return record;
}
