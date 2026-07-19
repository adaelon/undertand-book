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
  if (!legacy && events.length === 0) return undefined;
  const record: AutomaticBuildAttemptRecord = legacy
    ? {
        failures: legacy.failures,
        ...(legacy.last_error ? { last_error: legacy.last_error } : {}),
        updated_at: legacy.updated_at,
        last_attempt: legacy.failures,
        next_attempt: legacy.failures + 1,
      }
    : {
        failures: 0,
        updated_at: events[0].created_at,
        last_attempt: 0,
        next_attempt: 1,
      };
  for (const event of events) applyAttemptEvent(target, record, event);
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
    };
    applyAttemptEvent(target, record, event);
    output[event.work_unit_id] = record;
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
