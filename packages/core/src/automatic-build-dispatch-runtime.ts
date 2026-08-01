import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  claimAutomaticBuildTask,
  inspectAutomaticBuildTaskClaim,
  type AutomaticBuildClaimResult,
} from "./automatic-build-lease";
import type { AutomaticBuildTaskReceiptV1 } from "./automatic-build-mailbox";
import {
  listAutomaticBuildStoredAttempts,
} from "./automatic-build-task-store";
import type { AutomaticBuildStage, AutomaticBuildTarget, BuildTargetRefV2 } from "./build-orchestrator";
import {
  selectAutomaticBuildDispatchRefill,
  type AutomaticBuildExecutorDispatchManifestV1,
  type AutomaticBuildExecutorDispatchPlanV1,
} from "./automatic-build-dispatch";
import type { AutomaticBuildTaskPolicyBindingV1 } from "./semantic-artifact";
import type { WorkUnitDescriptorV2 } from "./stage-work-unit";

const MAX_DISPATCH_RECEIPT_BYTES = 16_384;

export interface AutomaticBuildPersistedDispatchV1 {
  version: "automatic_build_persisted_dispatch.v1";
  dispatch_run_id: string;
  manifest: AutomaticBuildExecutorDispatchManifestV1;
  owner: string;
  created_at: string;
  reserve_ttl_ms: number;
  run_ttl_ms: number;
}

export interface AutomaticBuildPersistedDispatchPlanV1 {
  version: "automatic_build_persisted_dispatch_plan.v1";
  accepted_plan_digest: string;
  dispatch_plan: AutomaticBuildExecutorDispatchPlanV1;
  created_at: string;
}

export interface AutomaticBuildDispatchTaskReceiptV1 {
  version: "automatic_build_dispatch_task_receipt.v1";
  task_ref: string;
  state: "committed" | "retryable_failure";
  work_unit_id: string;
  attempt: number;
  candidate_sha256?: string;
  artifact_sha256?: string;
  diagnostic_code?: string;
  terminal_at: string;
}

export interface AutomaticBuildDispatchProgressV1 {
  version: "automatic_build_dispatch_progress.v1";
  dispatch_id: string;
  ordinal: number;
  work_unit_id: string;
  task_receipt: AutomaticBuildDispatchTaskReceiptV1;
  observed_at: string;
}

export interface AutomaticBuildExecutorDispatchReceiptV1 {
  version: "automatic_build_executor_dispatch_receipt.v1";
  dispatch_id: string;
  dispatch_run_id: string;
  target_ref: BuildTargetRefV2;
  stage: AutomaticBuildStage;
  task_receipts: AutomaticBuildDispatchTaskReceiptV1[];
  unclaimed_work_unit_ids: string[];
  terminal_reason: "complete" | "task_failure" | "executor_interrupted";
  finished_at: string;
}

export type AutomaticBuildDispatchAdvanceResult =
  | {
      status: "leased";
      persisted: AutomaticBuildPersistedDispatchV1;
      descriptor: WorkUnitDescriptorV2;
      claim: Extract<AutomaticBuildClaimResult, { status: "leased" }>;
    }
  | {
      status: "waiting";
      persisted: AutomaticBuildPersistedDispatchV1;
      work_unit_id: string;
      retry_after_ms: number;
    }
  | {
      status: "ready_to_finish";
      persisted: AutomaticBuildPersistedDispatchV1;
      task_receipts: AutomaticBuildDispatchTaskReceiptV1[];
    }
  | {
      status: "finished";
      persisted: AutomaticBuildPersistedDispatchV1;
      receipt: AutomaticBuildExecutorDispatchReceiptV1;
    }
  | {
      status: "retry_exhausted" | "executor_instability";
      persisted: AutomaticBuildPersistedDispatchV1;
      work_unit_id: string;
    };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sameTargetRef(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function dispatchDirectory(target: AutomaticBuildTarget, stage: AutomaticBuildStage, dispatchId: string): string {
  if (!dispatchId || dispatchId.length > 256) throw new Error("dispatch_id must contain 1-256 characters");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "dispatches",
    stage,
    encodeURIComponent(dispatchId),
  );
}

export function automaticBuildDispatchRunId(createdAt: string): string {
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("dispatch run timestamp must be an ISO timestamp");
  return `run-${createdAt.replace(/[^0-9A-Za-z]/g, "")}`;
}

function dispatchRunDirectory(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  dispatchRunId: string,
): string {
  if (!dispatchRunId || dispatchRunId.length > 128) throw new Error("dispatch_run_id must contain 1-128 characters");
  return path.join(dispatchDirectory(target, stage, dispatchId), "runs", encodeURIComponent(dispatchRunId));
}

export function automaticBuildDispatchManifestPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  dispatchRunId: string,
): string {
  return path.join(dispatchRunDirectory(target, stage, dispatchId, dispatchRunId), "manifest.json");
}

function dispatchReceiptPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  dispatchRunId: string,
): string {
  return path.join(dispatchRunDirectory(target, stage, dispatchId, dispatchRunId), "receipt.json");
}

function dispatchPlanDirectory(target: AutomaticBuildTarget, stage: AutomaticBuildStage): string {
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "dispatch-plans",
    stage,
  );
}

function dispatchPlanPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchPlanDigest: string,
  createdAt: string,
): string {
  return path.join(
    dispatchPlanDirectory(target, stage),
    `${dispatchPlanDigest}-${automaticBuildDispatchRunId(createdAt)}.json`,
  );
}

function progressPath(
  target: AutomaticBuildTarget,
  persisted: AutomaticBuildPersistedDispatchV1,
  ordinal: number,
): string {
  return path.join(
    dispatchRunDirectory(
      target,
      persisted.manifest.stage,
      persisted.manifest.dispatch_id,
      persisted.dispatch_run_id,
    ),
    "progress",
    `${String(ordinal).padStart(4, "0")}.json`,
  );
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeCreateOnly(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readJson<unknown>(file);
    if (stableJson(existing) !== stableJson(value)) throw new Error(`create-only dispatch state conflicts: ${file}`);
  }
}

function validatePersistedDispatch(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  dispatchRunId: string,
  value: AutomaticBuildPersistedDispatchV1,
): AutomaticBuildPersistedDispatchV1 {
  if (value.version !== "automatic_build_persisted_dispatch.v1"
    || value.dispatch_run_id !== dispatchRunId
    || value.manifest.version !== "automatic_build_executor_dispatch.v1"
    || value.manifest.dispatch_id !== dispatchId
    || value.manifest.stage !== stage
    || !sameTargetRef(value.manifest.target_ref, target.target_ref)
    || !value.owner
    || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error(`invalid automatic build dispatch manifest: ${stage}/${dispatchId}`);
  }
  positiveInteger(value.reserve_ttl_ms, "reserve_ttl_ms");
  positiveInteger(value.run_ttl_ms, "run_ttl_ms");
  return value;
}

export function persistAutomaticBuildDispatch(
  target: AutomaticBuildTarget,
  manifest: AutomaticBuildExecutorDispatchManifestV1,
  options: {
    owner: string;
    created_at: string;
    reserve_ttl_ms: number;
    run_ttl_ms: number;
    dispatch_run_id?: string;
  },
): { persisted: AutomaticBuildPersistedDispatchV1; manifest_path: string } {
  if (!sameTargetRef(manifest.target_ref, target.target_ref)) throw new Error("dispatch manifest target mismatch");
  if (!options.owner) throw new Error("dispatch owner must not be empty");
  if (!Number.isFinite(Date.parse(options.created_at))) throw new Error("dispatch created_at must be an ISO timestamp");
  positiveInteger(options.reserve_ttl_ms, "reserve_ttl_ms");
  positiveInteger(options.run_ttl_ms, "run_ttl_ms");
  const dispatchRunId = options.dispatch_run_id ?? automaticBuildDispatchRunId(options.created_at);
  const persisted: AutomaticBuildPersistedDispatchV1 = {
    version: "automatic_build_persisted_dispatch.v1",
    dispatch_run_id: dispatchRunId,
    manifest,
    owner: options.owner,
    created_at: options.created_at,
    reserve_ttl_ms: options.reserve_ttl_ms,
    run_ttl_ms: options.run_ttl_ms,
  };
  const manifestPath = automaticBuildDispatchManifestPath(
    target,
    manifest.stage,
    manifest.dispatch_id,
    dispatchRunId,
  );
  if (existsSync(manifestPath)) {
    const existing = validatePersistedDispatch(
      target,
      manifest.stage,
      manifest.dispatch_id,
      dispatchRunId,
      readJson<AutomaticBuildPersistedDispatchV1>(manifestPath),
    );
    if (stableJson(existing.manifest) !== stableJson(manifest)) {
      throw new Error(`persisted dispatch manifest conflicts with current plan: ${manifestPath}`);
    }
    return { persisted: existing, manifest_path: manifestPath };
  }
  writeCreateOnly(manifestPath, persisted);
  return { persisted, manifest_path: manifestPath };
}

function validatePersistedDispatchPlan(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  value: AutomaticBuildPersistedDispatchPlanV1,
): AutomaticBuildPersistedDispatchPlanV1 {
  if (value.version !== "automatic_build_persisted_dispatch_plan.v1"
    || !value.accepted_plan_digest
    || value.dispatch_plan.version !== "automatic_build_executor_dispatch_plan.v1"
    || value.dispatch_plan.stage !== stage
    || !sameTargetRef(value.dispatch_plan.target_ref, target.target_ref)
    || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error(`invalid automatic build persisted dispatch plan: ${stage}`);
  }
  return value;
}

export function persistAutomaticBuildDispatchPlan(
  target: AutomaticBuildTarget,
  acceptedPlanDigest: string,
  dispatchPlan: AutomaticBuildExecutorDispatchPlanV1,
  createdAt: string,
): AutomaticBuildPersistedDispatchPlanV1 {
  if (!acceptedPlanDigest) throw new Error("accepted_plan_digest must not be empty");
  if (dispatchPlan.stage === "paper_reading_guide") {
    throw new Error("paper_reading_guide cannot create an executor dispatch plan");
  }
  const value: AutomaticBuildPersistedDispatchPlanV1 = {
    version: "automatic_build_persisted_dispatch_plan.v1",
    accepted_plan_digest: acceptedPlanDigest,
    dispatch_plan: dispatchPlan,
    created_at: createdAt,
  };
  const file = dispatchPlanPath(target, dispatchPlan.stage, dispatchPlan.dispatch_plan_digest, createdAt);
  if (existsSync(file)) {
    const existing = validatePersistedDispatchPlan(
      target,
      dispatchPlan.stage,
      readJson<AutomaticBuildPersistedDispatchPlanV1>(file),
    );
    if (stableJson(existing.dispatch_plan) !== stableJson(dispatchPlan)
      || existing.accepted_plan_digest !== acceptedPlanDigest) {
      throw new Error(`persisted dispatch plan conflicts with current accepted plan: ${file}`);
    }
    return existing;
  }
  writeCreateOnly(file, value);
  return value;
}

function dispatchPlanRuntimeState(
  target: AutomaticBuildTarget,
  record: AutomaticBuildPersistedDispatchPlanV1,
  now: string,
): { active_dispatch_ids: string[]; completed_dispatch_ids: string[] } {
  const active: string[] = [];
  const completed: string[] = [];
  const dispatchRunId = automaticBuildDispatchRunId(record.created_at);
  for (const dispatch of record.dispatch_plan.dispatches) {
    const manifestFile = automaticBuildDispatchManifestPath(
      target,
      dispatch.stage,
      dispatch.dispatch_id,
      dispatchRunId,
    );
    if (!existsSync(manifestFile)) continue;
    const receiptFile = dispatchReceiptPath(target, dispatch.stage, dispatch.dispatch_id, dispatchRunId);
    if (existsSync(receiptFile)) {
      completed.push(dispatch.dispatch_id);
      continue;
    }
    const persisted = readAutomaticBuildDispatch(target, dispatch.stage, dispatch.dispatch_id, dispatchRunId);
    const progress = refreshProgress(target, persisted, now);
    const nextWorkUnitId = dispatch.ordered_work_unit_ids[progress.length];
    if (!nextWorkUnitId) continue;
    const inspection = inspectAutomaticBuildTaskClaim(target, dispatch.stage, nextWorkUnitId, { now });
    if (inspection.status === "already_leased") active.push(dispatch.dispatch_id);
  }
  return { active_dispatch_ids: active, completed_dispatch_ids: completed };
}

function resumableDispatchPlan(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  acceptedPlanDigest: string,
  now: string,
): AutomaticBuildPersistedDispatchPlanV1 | undefined {
  const directory = dispatchPlanDirectory(target, stage);
  if (!existsSync(directory)) return undefined;
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => validatePersistedDispatchPlan(
      target,
      stage,
      readJson<AutomaticBuildPersistedDispatchPlanV1>(path.join(directory, entry.name)),
    ))
    .filter((record) => record.accepted_plan_digest === acceptedPlanDigest)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
      || right.dispatch_plan.dispatch_plan_digest.localeCompare(left.dispatch_plan.dispatch_plan_digest));
  return candidates.find((record) => {
    const state = dispatchPlanRuntimeState(target, record, now);
    return state.completed_dispatch_ids.length < record.dispatch_plan.dispatches.length;
  });
}

export function selectAutomaticBuildDispatchHandoff(
  target: AutomaticBuildTarget,
  input: {
    accepted_plan_digest: string;
    current_dispatch_plan: AutomaticBuildExecutorDispatchPlanV1;
    available_new_executor_slots: number;
    created_at: string;
  },
): {
  persisted_plan: AutomaticBuildPersistedDispatchPlanV1;
  active_dispatch_ids: string[];
  completed_dispatch_ids: string[];
  selected_manifests: AutomaticBuildExecutorDispatchManifestV1[];
} {
  if (!Number.isSafeInteger(input.available_new_executor_slots) || input.available_new_executor_slots < 0) {
    throw new Error("available_new_executor_slots must be a non-negative safe integer");
  }
  const persistedPlan = resumableDispatchPlan(
    target,
    input.current_dispatch_plan.stage,
    input.accepted_plan_digest,
    input.created_at,
  ) ?? persistAutomaticBuildDispatchPlan(
    target,
    input.accepted_plan_digest,
    input.current_dispatch_plan,
    input.created_at,
  );
  const state = dispatchPlanRuntimeState(target, persistedPlan, input.created_at);
  const totalCapacity = Math.min(3, state.active_dispatch_ids.length + input.available_new_executor_slots);
  const selectedIds = new Set(selectAutomaticBuildDispatchRefill(persistedPlan.dispatch_plan, {
    ...state,
    available_agent_slots: totalCapacity,
  }));
  return {
    persisted_plan: persistedPlan,
    ...state,
    selected_manifests: persistedPlan.dispatch_plan.dispatches.filter(
      (dispatch) => selectedIds.has(dispatch.dispatch_id),
    ),
  };
}

export function readAutomaticBuildDispatch(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  dispatchRunId?: string,
): AutomaticBuildPersistedDispatchV1 {
  const resolvedRunId = dispatchRunId ?? (() => {
    const runs = path.join(dispatchDirectory(target, stage, dispatchId), "runs");
    if (!existsSync(runs)) return undefined;
    return readdirSync(runs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const candidateRunId = decodeURIComponent(entry.name);
        const file = automaticBuildDispatchManifestPath(target, stage, dispatchId, candidateRunId);
        if (!existsSync(file)) return undefined;
        return validatePersistedDispatch(
          target,
          stage,
          dispatchId,
          candidateRunId,
          readJson<AutomaticBuildPersistedDispatchV1>(file),
        );
      })
      .filter((value): value is AutomaticBuildPersistedDispatchV1 => Boolean(value))
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
        || right.dispatch_run_id.localeCompare(left.dispatch_run_id))[0]?.dispatch_run_id;
  })();
  if (!resolvedRunId) throw new Error(`automatic build dispatch has no runtime: ${stage}/${dispatchId}`);
  const file = automaticBuildDispatchManifestPath(target, stage, dispatchId, resolvedRunId);
  if (!existsSync(file)) throw new Error(`automatic build dispatch does not exist: ${file}`);
  return validatePersistedDispatch(
    target,
    stage,
    dispatchId,
    resolvedRunId,
    readJson<AutomaticBuildPersistedDispatchV1>(file),
  );
}

function compactTaskReceipt(receipt: AutomaticBuildTaskReceiptV1): AutomaticBuildDispatchTaskReceiptV1 {
  const terminalAt = receipt.committed_at ?? receipt.failed_at;
  if (!terminalAt) throw new Error(`terminal task receipt is missing terminal time: ${receipt.task_ref}`);
  return {
    version: "automatic_build_dispatch_task_receipt.v1",
    task_ref: receipt.task_ref,
    state: receipt.state,
    work_unit_id: receipt.work_unit_id,
    attempt: receipt.attempt,
    ...(receipt.candidate_sha256 ? { candidate_sha256: receipt.candidate_sha256 } : {}),
    ...(receipt.artifact_sha256 ? { artifact_sha256: receipt.artifact_sha256 } : {}),
    ...(receipt.diagnostic_code ? { diagnostic_code: receipt.diagnostic_code } : {}),
    terminal_at: terminalAt,
  };
}

function terminalReceiptAfterDispatch(
  target: AutomaticBuildTarget,
  persisted: AutomaticBuildPersistedDispatchV1,
  workUnitId: string,
): AutomaticBuildDispatchTaskReceiptV1 | undefined {
  const attempts = listAutomaticBuildStoredAttempts(target, persisted.manifest.stage)
    .filter((attempt) => attempt.work_unit_id === workUnitId)
    .sort((left, right) => right.physical_attempt - left.physical_attempt);
  for (const attempt of attempts) {
    for (const name of ["receipt.json", "failure.json"] as const) {
      const file = path.join(attempt.attempt_dir, name);
      if (!existsSync(file)) continue;
      const receipt = readJson<AutomaticBuildTaskReceiptV1>(file);
      const terminalAt = receipt.committed_at ?? receipt.failed_at;
      if (receipt.version !== "automatic_build_task_receipt.v1"
        || receipt.stage !== persisted.manifest.stage
        || receipt.work_unit_id !== workUnitId
        || receipt.attempt !== attempt.physical_attempt
        || !sameTargetRef(receipt.target_ref, target.target_ref)
        || !terminalAt) {
        throw new Error(`invalid automatic build task receipt: ${file}`);
      }
      if (Date.parse(terminalAt) >= Date.parse(persisted.created_at)) {
        return compactTaskReceipt(receipt);
      }
    }
  }
  return undefined;
}

function readProgress(
  target: AutomaticBuildTarget,
  persisted: AutomaticBuildPersistedDispatchV1,
  ordinal: number,
): AutomaticBuildDispatchProgressV1 | undefined {
  const file = progressPath(target, persisted, ordinal);
  if (!existsSync(file)) return undefined;
  const progress = readJson<AutomaticBuildDispatchProgressV1>(file);
  const expectedId = persisted.manifest.ordered_work_unit_ids[ordinal];
  if (progress.version !== "automatic_build_dispatch_progress.v1"
    || progress.dispatch_id !== persisted.manifest.dispatch_id
    || progress.ordinal !== ordinal
    || progress.work_unit_id !== expectedId
    || progress.task_receipt.work_unit_id !== expectedId) {
    throw new Error(`invalid automatic build dispatch progress: ${file}`);
  }
  return progress;
}

function writeProgressCreateOnly(
  target: AutomaticBuildTarget,
  persisted: AutomaticBuildPersistedDispatchV1,
  value: AutomaticBuildDispatchProgressV1,
): AutomaticBuildDispatchProgressV1 {
  const file = progressPath(target, persisted, value.ordinal);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return value;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readProgress(target, persisted, value.ordinal);
    if (!existing || stableJson(existing.task_receipt) !== stableJson(value.task_receipt)) {
      throw new Error(`dispatch progress conflicts with canonical task receipt: ${file}`);
    }
    return existing;
  }
}

function refreshProgress(
  target: AutomaticBuildTarget,
  persisted: AutomaticBuildPersistedDispatchV1,
  now: string,
): AutomaticBuildDispatchProgressV1[] {
  const progress: AutomaticBuildDispatchProgressV1[] = [];
  for (let ordinal = 0; ordinal < persisted.manifest.ordered_work_unit_ids.length; ordinal += 1) {
    const existing = readProgress(target, persisted, ordinal);
    if (existing) {
      progress.push(existing);
      continue;
    }
    const workUnitId = persisted.manifest.ordered_work_unit_ids[ordinal];
    const terminal = terminalReceiptAfterDispatch(target, persisted, workUnitId);
    if (!terminal) break;
    const value: AutomaticBuildDispatchProgressV1 = {
      version: "automatic_build_dispatch_progress.v1",
      dispatch_id: persisted.manifest.dispatch_id,
      ordinal,
      work_unit_id: workUnitId,
      task_receipt: terminal,
      observed_at: now,
    };
    progress.push(writeProgressCreateOnly(target, persisted, value));
  }
  return progress;
}

function validateDescriptors(
  persisted: AutomaticBuildPersistedDispatchV1,
  descriptors: WorkUnitDescriptorV2[],
  fromOrdinal: number,
): Map<string, WorkUnitDescriptorV2> {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.work_unit_id, descriptor]));
  for (const workUnitId of persisted.manifest.ordered_work_unit_ids.slice(fromOrdinal)) {
    const descriptor = byId.get(workUnitId);
    if (!descriptor
      || descriptor.stage !== persisted.manifest.stage
      || descriptor.kind !== persisted.manifest.kind
      || stableJson(descriptor.target) !== stableJson(persisted.manifest.target_ref)
      || stableJson(descriptor.policy_fingerprint) !== stableJson(persisted.manifest.policy_fingerprint)) {
      throw new Error(`dispatch descriptor identity changed: ${persisted.manifest.stage}/${workUnitId}`);
    }
  }
  return byId;
}

export function advanceAutomaticBuildDispatch(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  input: {
    descriptors: WorkUnitDescriptorV2[];
    task_bindings: Record<string, AutomaticBuildTaskPolicyBindingV1>;
    dispatch_run_id?: string;
    now?: string;
    max_semantic_attempts?: number;
    max_lease_epochs?: number;
  },
): AutomaticBuildDispatchAdvanceResult {
  const persisted = readAutomaticBuildDispatch(target, stage, dispatchId, input.dispatch_run_id);
  const finishedPath = dispatchReceiptPath(target, stage, dispatchId, persisted.dispatch_run_id);
  if (existsSync(finishedPath)) {
    return { status: "finished", persisted, receipt: readJson<AutomaticBuildExecutorDispatchReceiptV1>(finishedPath) };
  }
  const now = input.now ?? new Date().toISOString();
  const progress = refreshProgress(target, persisted, now);
  const lastProgress = progress.at(-1);
  if (lastProgress?.task_receipt.state === "retryable_failure") {
    const failedInspection = inspectAutomaticBuildTaskClaim(
      target,
      stage,
      lastProgress.work_unit_id,
      {
        now,
        max_semantic_attempts: input.max_semantic_attempts,
        max_lease_epochs: input.max_lease_epochs,
      },
    );
    if (failedInspection.status === "retry_exhausted") {
      return {
        status: "retry_exhausted",
        persisted,
        work_unit_id: lastProgress.work_unit_id,
      };
    }
  }
  if (progress.length === persisted.manifest.ordered_work_unit_ids.length) {
    return { status: "ready_to_finish", persisted, task_receipts: progress.map((item) => item.task_receipt) };
  }
  const descriptors = validateDescriptors(persisted, input.descriptors, progress.length);
  const workUnitId = persisted.manifest.ordered_work_unit_ids[progress.length];
  const descriptor = descriptors.get(workUnitId)!;
  const binding = input.task_bindings[workUnitId];
  if (!binding) throw new Error(`dispatch task is missing policy binding: ${stage}/${workUnitId}`);
  const inspection = inspectAutomaticBuildTaskClaim(target, stage, workUnitId, {
    now,
    max_semantic_attempts: input.max_semantic_attempts,
    max_lease_epochs: input.max_lease_epochs,
  });
  if (inspection.status === "already_leased") {
    return {
      status: "waiting",
      persisted,
      work_unit_id: workUnitId,
      retry_after_ms: Math.min(persisted.reserve_ttl_ms, 30_000),
    };
  }
  if (inspection.status === "retry_exhausted" || inspection.status === "executor_instability") {
    return { status: inspection.status, persisted, work_unit_id: workUnitId };
  }
  const claim = claimAutomaticBuildTask(target, stage, workUnitId, {
    owner: persisted.owner,
    now,
    reserve_ttl_ms: persisted.reserve_ttl_ms,
    binding,
    max_semantic_attempts: input.max_semantic_attempts,
    max_lease_epochs: input.max_lease_epochs,
  });
  if (claim.status === "leased") return { status: "leased", persisted, descriptor, claim };
  if (claim.status === "already_leased") {
    return {
      status: "waiting",
      persisted,
      work_unit_id: workUnitId,
      retry_after_ms: Math.min(persisted.reserve_ttl_ms, 30_000),
    };
  }
  return { status: claim.status, persisted, work_unit_id: workUnitId };
}

function taskWasClaimed(
  target: AutomaticBuildTarget,
  persisted: AutomaticBuildPersistedDispatchV1,
  workUnitId: string,
): boolean {
  return listAutomaticBuildStoredAttempts(target, persisted.manifest.stage)
    .filter((attempt) => attempt.work_unit_id === workUnitId)
    .some((attempt) => {
      const leaseFile = path.join(attempt.attempt_dir, "lease.json");
      return existsSync(leaseFile) && readJson<{ owner?: string }>(leaseFile).owner === persisted.owner;
    });
}

export function inspectAutomaticBuildDispatch(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  now = new Date().toISOString(),
  dispatchRunId?: string,
) {
  const persisted = readAutomaticBuildDispatch(target, stage, dispatchId, dispatchRunId);
  const receiptFile = dispatchReceiptPath(target, stage, dispatchId, persisted.dispatch_run_id);
  if (existsSync(receiptFile)) {
    return {
      version: "automatic_build_dispatch_inspection.v1" as const,
      dispatch_id: dispatchId,
      state: "finished" as const,
      manifest: persisted.manifest,
      receipt: readJson<AutomaticBuildExecutorDispatchReceiptV1>(receiptFile),
    };
  }
  const progress = refreshProgress(target, persisted, now);
  const nextWorkUnitId = persisted.manifest.ordered_work_unit_ids[progress.length];
  return {
    version: "automatic_build_dispatch_inspection.v1" as const,
    dispatch_id: dispatchId,
    state: nextWorkUnitId ? "active" as const : "ready_to_finish" as const,
    manifest: persisted.manifest,
    task_receipts: progress.map((item) => item.task_receipt),
    ...(nextWorkUnitId ? { next_work_unit_id: nextWorkUnitId } : {}),
  };
}

export function finishAutomaticBuildDispatch(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  dispatchId: string,
  options: {
    terminal_reason?: AutomaticBuildExecutorDispatchReceiptV1["terminal_reason"];
    now?: string;
    dispatch_run_id?: string;
  } = {},
): AutomaticBuildExecutorDispatchReceiptV1 {
  const persisted = readAutomaticBuildDispatch(target, stage, dispatchId, options.dispatch_run_id);
  const file = dispatchReceiptPath(target, stage, dispatchId, persisted.dispatch_run_id);
  if (existsSync(file)) return readJson<AutomaticBuildExecutorDispatchReceiptV1>(file);
  const now = options.now ?? new Date().toISOString();
  const progress = refreshProgress(target, persisted, now);
  const interrupted = options.terminal_reason === "executor_interrupted";
  const incomplete = progress.length !== persisted.manifest.ordered_work_unit_ids.length;
  const hasFailure = progress.some((item) => item.task_receipt.state === "retryable_failure");
  const unclaimedWorkUnitIds = persisted.manifest.ordered_work_unit_ids.filter(
    (workUnitId) => !taskWasClaimed(target, persisted, workUnitId),
  );
  if (options.terminal_reason === "task_failure") {
    if (!hasFailure) {
      throw new Error(`dispatch task_failure requires a canonical retryable failure receipt: ${dispatchId}`);
    }
    if (incomplete) {
      const failedCurrent = progress.at(-1)?.task_receipt.state === "retryable_failure";
      if (!failedCurrent) {
        throw new Error(`dispatch task_failure requires the current failed work unit to be terminal: ${dispatchId}`);
      }
      const activeWorkUnitIds = persisted.manifest.ordered_work_unit_ids.filter((workUnitId) => (
        inspectAutomaticBuildTaskClaim(target, stage, workUnitId, { now }).status === "already_leased"
      ));
      if (activeWorkUnitIds.length) {
        throw new Error(`dispatch task_failure cannot finish with an active lease: ${activeWorkUnitIds.join(",")}`);
      }
      const expectedSuffix = persisted.manifest.ordered_work_unit_ids.slice(progress.length);
      if (expectedSuffix.length !== unclaimedWorkUnitIds.length
        || expectedSuffix.some((workUnitId, index) => unclaimedWorkUnitIds[index] !== workUnitId)) {
        throw new Error(`dispatch task_failure requires a strict unclaimed suffix: ${dispatchId}`);
      }
    }
  } else if (!interrupted && incomplete) {
    throw new Error(`dispatch has unfinished work units: ${dispatchId}`);
  }
  const terminalReason = interrupted ? "executor_interrupted" : hasFailure ? "task_failure" : "complete";
  if (options.terminal_reason && options.terminal_reason !== terminalReason) {
    throw new Error(`dispatch terminal reason must be ${terminalReason}: ${dispatchId}`);
  }
  const receipt: AutomaticBuildExecutorDispatchReceiptV1 = {
    version: "automatic_build_executor_dispatch_receipt.v1",
    dispatch_id: dispatchId,
    dispatch_run_id: persisted.dispatch_run_id,
    target_ref: target.target_ref,
    stage,
    task_receipts: progress.map((item) => item.task_receipt),
    unclaimed_work_unit_ids: unclaimedWorkUnitIds,
    terminal_reason: terminalReason,
    finished_at: now,
  };
  const bytes = Buffer.byteLength(JSON.stringify(receipt));
  if (bytes > MAX_DISPATCH_RECEIPT_BYTES) {
    throw new Error(`dispatch receipt exceeds ${MAX_DISPATCH_RECEIPT_BYTES} bytes: ${bytes}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return receipt;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readJson<AutomaticBuildExecutorDispatchReceiptV1>(file);
    if (existing.dispatch_id !== dispatchId || existing.terminal_reason !== terminalReason) {
      throw new Error(`dispatch receipt conflicts with terminal state: ${file}`);
    }
    return existing;
  }
}
