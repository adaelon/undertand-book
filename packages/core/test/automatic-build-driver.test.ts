import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  automaticBuildDispatchFinish,
  automaticBuildDispatchNext,
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { compileBuildMode } from "../src/build-capability";
import type {
  AutomaticBuildBudgetLimitsV1,
  AutomaticBuildExecutorProvenanceV1,
  AutomaticBuildWallBudgetV1,
} from "../src/automatic-build-budget";
import { recordAutomaticBuildInputObservation } from "../src/automatic-build-metrics";
import { submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import { startAutomaticBuildLease } from "../src/automatic-build-lease";
import {
  failAutomaticBuildExecutorSession,
  openAutomaticBuildExecutorSession,
  submitAutomaticBuildExecutorCandidate,
  type AutomaticBuildExecutorSessionResponseV1,
} from "../src/automatic-build-executor-session";
import { readAutomaticBuildAttemptSnapshot } from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import {
  transitionBuildIntent,
  transitionBuildPlan,
  validateBuildIntentV1,
  type BuildIntentV1,
} from "../src/build-intent";
import { MODEL_INPUT_RENDER_CONTRACT_VERSION } from "../src/model-input-renderer";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import type { BuildPlanV1 } from "../src/build-intent";
import {
  adaptIntentArtifactPayloadV1,
  type IntentArtifactTaskEnvelopeV2,
} from "../src/intent-artifact";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";
import {
  createSyntheticRoutabilityFixture,
  writePass1ProductionTaskArtifact,
  writeSyntheticPass1ProductionGeneration,
} from "./helpers/model-input-routability-fixture";

declare global {
  interface ImportMeta {
    glob<T = unknown>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

type MaybePromise<T> = T | Promise<T>;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const DRIVER_CLI = path.join(REPO_ROOT, "skills", "build", "automatic-build-driver.ts");
const EXECUTOR_SESSION_CLI = path.join(
  REPO_ROOT,
  "packages",
  "core",
  "src",
  "automatic-build-executor-session.ts",
);

type AutomaticBuildStepActionV1 =
  | {
      kind: "SPAWN_EXECUTORS";
      executors: Array<{ opaque_handoff_ref: string }>;
    }
  | {
      kind: "WAIT";
      reason: "active_executors" | "active_lease" | "backoff";
      retry_after_ms: number;
    }
  | {
      kind: "NEEDS_USER";
      request_id: string;
      reason: string;
      message: string;
      choices: Array<{ choice_id: string; label: string; consequence: string }>;
      projection?: unknown;
    }
  | {
      kind: "DONE";
      summary: unknown;
    };

interface AutomaticBuildStepResponseV1 {
  version: "automatic_build_step.v1";
  action: AutomaticBuildStepActionV1;
}

interface AutomaticBuildStepRequestV1 {
  version: "automatic_build_step_request.v1";
  invocation_ref: string;
  available_agent_slots: 0 | 1 | 2 | 3;
  decision?: { request_id: string; choice_id: string };
}

interface AutomaticBuildInvocationCreateV1 {
  version: "automatic_build_invocation_create.v1";
  target_input: string;
  root_dir: string;
  build_plan_path: string;
  quality_profile: "full";
  max_parallel: 1 | 2 | 3;
  created_at: string;
  budget?: AutomaticBuildBudgetLimitsV1;
  wall_budget?: AutomaticBuildWallBudgetV1;
  executor_provenance?: AutomaticBuildExecutorProvenanceV1;
}

interface AutomaticBuildDriverModule {
  createAutomaticBuildInvocation(input: AutomaticBuildInvocationCreateV1): MaybePromise<{
    version: "automatic_build_invocation_ref.v1";
    invocation_ref: string;
  }>;
  automaticBuildStep(input: AutomaticBuildStepRequestV1): MaybePromise<AutomaticBuildStepResponseV1>;
}

interface AutomaticBuildExecutorSessionModule {
  issueAutomaticBuildOpaqueHandoff(input: {
    target: ReturnType<typeof resolveAutomaticBuildTarget>;
    kind: "public_dispatch" | "private_artifact";
    owner_identity: unknown;
    executor_handoff: {
      version: string;
      path: string;
      sha256: string;
      byte_length: number;
    };
    issued_at: string;
  }): MaybePromise<{ opaque_handoff_ref: string }>;
  openAutomaticBuildExecutorSession(
    opaqueHandoffRef: string,
    options?: { now?: string },
  ): MaybePromise<unknown>;
}

// S0 intentionally precedes both production modules. Eager globs keep every behavioral test
// independently runnable and turn the absent interfaces into explicit red evidence instead of a
// transform-time "module not found" that hides the remaining contract cases.
const DRIVER_MODULES = import.meta.glob<AutomaticBuildDriverModule>(
  "../../../skills/build/automatic-build-driver.ts",
  { eager: true },
);
const EXECUTOR_SESSION_MODULES = import.meta.glob<AutomaticBuildExecutorSessionModule>(
  "../src/automatic-build-executor-session.ts",
  { eager: true },
);

const ROOT_ACTION_KINDS = ["SPAWN_EXECUTORS", "WAIT", "NEEDS_USER", "DONE"] as const;
const FORBIDDEN_ROOT_FIELDS = new Set([
  "command",
  "cwd",
  "path",
  "sha256",
  "byte_length",
  "semantic_prompt",
  "extractor_prompt",
  "envelope",
  "candidate",
  "task_input",
  "receipt_body",
  "receipt",
  "receipts",
  "plan_digest",
  "plan_id",
  "policy_set_digest",
  "proof_digest",
  "private_root",
  "task_path",
  "task_id",
  "artifact_id",
  "artifact_type",
  "intent_id",
  "intent_digest",
  "blueprint_digest",
]);

function expectedDriver(): AutomaticBuildDriverModule {
  const module = Object.values(DRIVER_MODULES)[0];
  if (!module) {
    throw new Error("S0_RED_BUILD_STEP_UNAVAILABLE: skills/build/automatic-build-driver.ts does not exist");
  }
  if (typeof module.createAutomaticBuildInvocation !== "function"
    || typeof module.automaticBuildStep !== "function") {
    throw new Error("S0_RED_BUILD_STEP_UNAVAILABLE: invocation creation or automaticBuildStep is not exported");
  }
  return module;
}

function expectedExecutorSession(): AutomaticBuildExecutorSessionModule {
  const module = Object.values(EXECUTOR_SESSION_MODULES)[0];
  if (!module) {
    throw new Error(
      "S0_RED_EXECUTOR_OPEN_UNAVAILABLE: packages/core/src/automatic-build-executor-session.ts does not exist",
    );
  }
  if (typeof module.issueAutomaticBuildOpaqueHandoff !== "function"
    || typeof module.openAutomaticBuildExecutorSession !== "function") {
    throw new Error("S0_RED_EXECUTOR_OPEN_UNAVAILABLE: opaque handoff issue/open is not exported");
  }
  return module;
}

function fixture(label: string, options: { budget?: BuildPlanV1["budget"]; body?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-driver-${label}-`));
  const source = path.join(root, "guide.md");
  writeFileSync(
    source,
    options.body ?? "# Guide\n\nPRIVATE_DRIVER_INPUT must never cross the root response boundary.\n",
    "utf8",
  );
  const buildPlan = confirmedStandardBuildPlan(source, root, {
    ...(options.budget ? { budget: options.budget } : {}),
  });
  const buildPlanPath = path.join(root, "confirmed-build-plan.json");
  writeFileSync(buildPlanPath, `${JSON.stringify(buildPlan, null, 2)}\n`, "utf8");
  return { root, source, buildPlan, buildPlanPath };
}

function privateGoalFixture(label: string) {
  const value = fixture(label, {
    body: "# Guide\n\nPRIVATE_S4_GOAL_SOURCE is available to dedicated executors only.\n",
  });
  const target = resolveAutomaticBuildTarget(value.source, value.root);
  const contentProfile = {
    id: "technical_learning" as const,
    version: "technical_learning_v0" as const,
  };
  const createdAt = "2026-08-08T07:00:00.000Z";
  const draftIntent = validateBuildIntentV1({
    version: "build_intent.v1",
    intent_id: `intent-${label}`,
    revision: 1,
    book_id: target.book_id,
    source_fingerprint: target.target_ref.input_fingerprint,
    content_profile: contentProfile,
    user_goal: "PRIVATE_S4_RAW_GOAL compare the sequence and concepts.",
    goal_kind: "compare",
    source_scope: { whole_book: true, lids: [], sections: [] },
    desired_artifacts: ["timeline", "concept_map"],
    usage_horizon: "project",
    privacy: "reader_private",
    status: "draft",
    created_at: createdAt,
  });
  const intent = transitionBuildIntent(draftIntent, "confirmed", { at: createdAt });
  const draftPlan = compileBuildMode({
    mode: "goal_directed",
    book_id: target.book_id,
    source_fingerprint: target.target_ref.input_fingerprint,
    content_profile: contentProfile,
    plan_id: `plan-${label}`,
    revision: 1,
    created_at: createdAt,
    budget: { on_exceed: "needs_user" },
    public_freshness: [],
    intent,
  }).plan!;
  const buildPlan = transitionBuildPlan(draftPlan, "confirmed", {
    at: createdAt,
    confirmation_source: "codex_conversation",
  });
  const privateRoot = path.join(value.root, "reader-private");
  const bookRoot = path.join(privateRoot, target.book_id);
  const intentPath = path.join(bookRoot, "intents", intent.intent_id, "intent.json");
  const buildPlanPath = path.join(bookRoot, "plans", `${buildPlan.plan_id}.json`);
  mkdirSync(path.dirname(intentPath), { recursive: true });
  mkdirSync(path.dirname(buildPlanPath), { recursive: true });
  writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
  writeFileSync(buildPlanPath, `${JSON.stringify(buildPlan, null, 2)}\n`, "utf8");
  return {
    ...value,
    target,
    privateRoot,
    intent: intent as BuildIntentV1,
    buildPlan,
    buildPlanPath,
  };
}

function privateCandidateFor(
  root: string,
  action: Extract<AutomaticBuildExecutorSessionResponseV1["action"], { kind: "GENERATE" }>,
  label: string,
): string {
  const task = action.semantic_input as IntentArtifactTaskEnvelopeV2;
  expect(task.version).toBe("intent_artifact_task_envelope.v2");
  expect(task.user_goal).toContain("PRIVATE_S4_RAW_GOAL");
  const evidenceLid = task.allowed_evidence_lids[0];
  if (!evidenceLid) throw new Error("expected a private artifact evidence LID");
  let legacyPayload: unknown;
  if (task.artifact.artifact_type === "timeline") {
    legacyPayload = {
      items: [{ id: `event-${label}`, label: `Private event ${label}`, evidence_lids: [evidenceLid] }],
    };
  } else if (task.artifact.artifact_type === "concept_map") {
    legacyPayload = {
      nodes: [{ id: `concept-${label}`, label: `Private concept ${label}`, evidence_lids: [evidenceLid] }],
      links: [],
    };
  } else {
    throw new Error(`unexpected private artifact type: ${task.artifact.artifact_type}`);
  }
  const candidatePath = path.join(root, `private-candidate-${label}.json`);
  writeFileSync(candidatePath, `${JSON.stringify({
    version: "intent_artifact_candidate.v2",
    task_id: task.task_id,
    book_id: task.book_id,
    source_fingerprint: task.source_fingerprint,
    intent_id: task.intent_id,
    intent_digest: task.intent_digest,
    plan_id: task.plan_id,
    plan_digest: task.plan_digest,
    artifact_id: task.artifact.artifact_id,
    blueprint_digest: task.artifact.blueprint_digest,
    payload: adaptIntentArtifactPayloadV1(task.artifact.artifact_type, legacyPayload),
  })}\n`, "utf8");
  return candidatePath;
}

async function createInvocation(
  driver: AutomaticBuildDriverModule,
  value: ReturnType<typeof fixture>,
  options: {
    budget?: AutomaticBuildBudgetLimitsV1;
    wall_budget?: AutomaticBuildWallBudgetV1;
    executor_provenance?: AutomaticBuildExecutorProvenanceV1;
    created_at?: string;
  } = {},
) {
  return driver.createAutomaticBuildInvocation({
    version: "automatic_build_invocation_create.v1",
    target_input: value.source,
    root_dir: value.root,
    build_plan_path: value.buildPlanPath,
    quality_profile: "full",
    max_parallel: 1,
    created_at: options.created_at ?? "2026-08-08T05:00:00.000Z",
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.wall_budget ? { wall_budget: options.wall_budget } : {}),
    ...(options.executor_provenance ? { executor_provenance: options.executor_provenance } : {}),
  });
}

function collectForbiddenFields(value: unknown, at = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenFields(item, `${at}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${at}.${key}`;
    if (FORBIDDEN_ROOT_FIELDS.has(key)) found.push(childPath);
    collectForbiddenFields(child, childPath, found);
  }
  return found;
}

function collectStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, found));
    return found;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, found));
  }
  return found;
}

function expectRootSafeStep(response: AutomaticBuildStepResponseV1, secrets: string[] = []): void {
  expect(response.version).toBe("automatic_build_step.v1");
  expect(Object.keys(response).sort()).toEqual(["action", "version"]);
  expect(ROOT_ACTION_KINDS).toContain(response.action.kind);
  expect(collectForbiddenFields(response)).toEqual([]);
  const strings = collectStrings(response);
  for (const secret of secrets.filter(Boolean)) {
    expect(strings.some((value) => value.includes(secret))).toBe(false);
  }
  if (response.action.kind === "SPAWN_EXECUTORS") {
    expect(Object.keys(response.action).sort()).toEqual(["executors", "kind"]);
    expect(response.action.executors.length).toBeGreaterThan(0);
    for (const executor of response.action.executors) {
      expect(Object.keys(executor)).toEqual(["opaque_handoff_ref"]);
      expect(executor.opaque_handoff_ref).toMatch(/^[\x21-\x7e]{1,1024}$/u);
    }
  }
}

function firstDecision(response: AutomaticBuildStepResponseV1) {
  if (response.action.kind !== "NEEDS_USER") throw new Error("expected a user decision boundary");
  const choice = response.action.choices[0];
  if (!choice) throw new Error("expected an allowlisted choice for an authorization boundary");
  return { request_id: response.action.request_id, choice_id: choice.choice_id };
}

function writeMatchedPerformanceHistory(
  value: ReturnType<typeof fixture>,
  executor: AutomaticBuildExecutorProvenanceV1,
): void {
  const target = resolveAutomaticBuildTarget(value.source, value.root);
  const policy = automaticBuildExtractionPolicy(
    "pass1",
    resolveContentProfile("technical_learning"),
    "full",
  );
  const summaryPath = path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "metrics",
    "pass1.json",
  );
  mkdirSync(path.dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify({
    version: "automatic_build_stage_metrics_summary.v1",
    usage: { known_usage_coverage: 0, input_tokens: 0, output_tokens: 0 },
    performance_history: {
      version: "automatic_build_performance_history.v1",
      samples: [{
        sample_id: "driver-evaluation-drift",
        stage: "pass1",
        kind: "pass1_window",
        router_version: policy.router_version,
        ...executor,
        service_ms: 600_000,
      }],
      lease_count: 1,
      semantic_attempt_count: 1,
    },
  }, null, 2)}\n`, "utf8");
}

function commitDispatchTask(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  task: Extract<ReturnType<typeof automaticBuildDispatchNext>["action"], { kind: "task" }>["task"],
): void {
  if (task.descriptor.version === "automatic_build_work_unit.v3") {
    recordAutomaticBuildInputObservation(target, task.lease_ref, task.lease.token, {
      started_at: task.lease.issued_at,
      finished_at: task.lease.issued_at,
      input_bytes: 0,
      input_sha256: task.descriptor.input_hash,
      proof_digest: task.descriptor.input_budget_proof.proof_digest,
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    });
  }
  const marker = `driver-receipt-${task.task_id}`;
  writeFileSync(task.candidate_path, JSON.stringify({
    content_hash: task.descriptor.input_hash,
    nodes: [],
    edges: [],
    marker,
  }), "utf8");
  submitAutomaticBuildCandidate(
    target,
    task.lease_ref,
    task.lease.token,
    task.candidate_path,
    () => {
      if (!task.lease.policy_set_digest) throw new Error("expected a proof-bound dispatch lease");
      return writePass1ProductionTaskArtifact({
        target,
        policy_set_digest: task.lease.policy_set_digest,
        work_unit_id: task.task_id,
        marker,
        generated_at: task.lease.issued_at,
      });
    },
    { now: task.lease.issued_at, completed_at: task.lease.issued_at },
  );
}

describe("S0 deterministic automatic-build driver protocol", () => {
  it("returns only the four root actions and never exposes internal or semantic fields", async () => {
    const driver = expectedDriver();
    const value = fixture("root-surface");
    const invocation = await createInvocation(driver, value);
    const response = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });

    expect(response.action.kind).toBe("SPAWN_EXECUTORS");
    expectRootSafeStep(response, [value.root, value.source, value.buildPlanPath, "PRIVATE_DRIVER_INPUT"]);
    const replayed = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    expect(replayed).toEqual(response);
  });

  it("lets a fresh invocation reuse an expired dispatch opaque handoff", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T05:00:00.000Z"));
      const driver = expectedDriver();
      const value = fixture("fresh-invocation-handoff-reuse");
      const firstInvocation = await createInvocation(driver, value, {
        created_at: "2026-08-08T05:00:00.000Z",
      });
      const first = await driver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: firstInvocation.invocation_ref,
        available_agent_slots: 1,
      });
      if (first.action.kind !== "SPAWN_EXECUTORS") {
        throw new Error("expected the first invocation to publish an executor handoff");
      }

      vi.setSystemTime(new Date("2026-08-09T05:00:00.000Z"));
      const freshInvocation = await createInvocation(driver, value, {
        created_at: "2026-08-09T05:00:00.000Z",
      });
      expect(freshInvocation.invocation_ref).not.toBe(firstInvocation.invocation_ref);

      const resumed = await driver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: freshInvocation.invocation_ref,
        available_agent_slots: 1,
      });
      expect(resumed.action.kind).toBe("SPAWN_EXECUTORS");
      if (resumed.action.kind !== "SPAWN_EXECUTORS") {
        throw new Error("expected the fresh invocation to reuse the expired dispatch handoff");
      }
      expect(resumed.action.executors).toEqual(first.action.executors);
      expectRootSafeStep(resumed, [value.root, value.source, value.buildPlanPath]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes an expired running dispatch without republishing its manifest", () => {
    const value = fixture("expired-public-dispatch");
    const plan = automaticBuildPlan(value.source, value.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: value.buildPlan,
    });
    if (!plan.preflight) throw new Error("expected expired-dispatch preflight");
    const first = automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T05:01:00.000Z",
      lease_ttl_ms: 1_000,
      run_ttl_ms: 1_000,
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: value.buildPlan,
    });
    if (!("dispatches" in first.action) || !first.action.dispatches?.length) {
      throw new Error("expected initial persisted dispatch");
    }
    const firstEnvelope = first.action.dispatches[0];
    const target = resolveAutomaticBuildTarget(value.source, value.root);
    const claimed = automaticBuildDispatchNext(
      value.source,
      value.root,
      firstEnvelope.manifest.stage,
      firstEnvelope.manifest.dispatch_id,
      { dispatch_run_id: firstEnvelope.dispatch_run_id, now: "2026-08-08T05:01:01.000Z" },
    );
    if (claimed.action.kind !== "task") throw new Error("expected initial dispatch task");
    startAutomaticBuildLease(target, claimed.action.task.lease_ref, claimed.action.task.lease.token, {
      now: "2026-08-08T05:01:01.100Z",
      run_ttl_ms: 1_000,
    });
    const originalManifest = readFileSync(firstEnvelope.manifest_path, "utf8");

    const resumed = automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T05:01:03.000Z",
      lease_ttl_ms: 1_000,
      run_ttl_ms: 2_000,
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: value.buildPlan,
    });
    if (!("dispatches" in resumed.action) || !resumed.action.dispatches?.length) {
      throw new Error("expected resumed persisted dispatch");
    }
    const resumedEnvelope = resumed.action.dispatches[0];
    expect(resumedEnvelope.manifest.dispatch_id).toBe(firstEnvelope.manifest.dispatch_id);
    expect(resumedEnvelope.dispatch_run_id).toBe(firstEnvelope.dispatch_run_id);
    expect(resumedEnvelope.manifest_path).toBe(firstEnvelope.manifest_path);
    expect(readFileSync(firstEnvelope.manifest_path, "utf8")).toBe(originalManifest);

    const reclaimed = automaticBuildDispatchNext(
      value.source,
      value.root,
      resumedEnvelope.manifest.stage,
      resumedEnvelope.manifest.dispatch_id,
      { dispatch_run_id: resumedEnvelope.dispatch_run_id, now: "2026-08-08T05:01:03.100Z" },
    );
    if (reclaimed.action.kind !== "task") throw new Error("expected reclaimed dispatch task");
    expect(reclaimed.action.task.task_id).toBe(claimed.action.task.task_id);
    expect(reclaimed.action.task.execution_identity.lease_epoch).toBe(2);
  }, 30_000);

  it("rejects expired dispatch re-entry when the persisted owner identity conflicts", () => {
    const value = fixture("expired-public-dispatch-owner-conflict");
    const plan = automaticBuildPlan(value.source, value.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: value.buildPlan,
    });
    if (!plan.preflight) throw new Error("expected owner-conflict preflight");
    const acceptedPlanDigest = plan.preflight.plan_digest;
    const first = automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T05:11:00.000Z",
      lease_ttl_ms: 1_000,
      run_ttl_ms: 1_000,
      accepted_plan_digest: acceptedPlanDigest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: value.buildPlan,
    });
    if (!("dispatches" in first.action) || !first.action.dispatches?.length) {
      throw new Error("expected initial owner-conflict dispatch");
    }
    const firstEnvelope = first.action.dispatches[0];
    const target = resolveAutomaticBuildTarget(value.source, value.root);
    const claimed = automaticBuildDispatchNext(
      value.source,
      value.root,
      firstEnvelope.manifest.stage,
      firstEnvelope.manifest.dispatch_id,
      { dispatch_run_id: firstEnvelope.dispatch_run_id, now: "2026-08-08T05:11:01.000Z" },
    );
    if (claimed.action.kind !== "task") throw new Error("expected owner-conflict dispatch task");
    startAutomaticBuildLease(target, claimed.action.task.lease_ref, claimed.action.task.lease.token, {
      now: "2026-08-08T05:11:01.100Z",
      run_ttl_ms: 1_000,
    });
    const persisted = JSON.parse(readFileSync(firstEnvelope.manifest_path, "utf8")) as {
      owner: string;
      [key: string]: unknown;
    };
    writeFileSync(firstEnvelope.manifest_path, `${JSON.stringify({
      ...persisted,
      owner: `${persisted.owner}:foreign`,
    }, null, 2)}\n`, "utf8");

    expect(() => automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T05:11:03.000Z",
      lease_ttl_ms: 1_000,
      run_ttl_ms: 2_000,
      accepted_plan_digest: acceptedPlanDigest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: value.buildPlan,
    })).toThrow("persisted dispatch identity conflicts with selected plan");
  }, 30_000);

  it("rejects a stale decision after BuildPlan drift without caller-supplied digests", async () => {
    const driver = expectedDriver();
    const value = fixture("plan-drift", {
      budget: { max_total_tokens: 1, on_exceed: "needs_user" },
    });
    const invocation = await createInvocation(driver, value);
    const first = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    const decision = firstDecision(first);

    const revised = confirmedStandardBuildPlan(value.source, value.root, {
      now: "2026-08-08T05:01:00.000Z",
    });
    writeFileSync(value.buildPlanPath, `${JSON.stringify(revised, null, 2)}\n`, "utf8");
    const request = {
      version: "automatic_build_step_request.v1" as const,
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1 as const,
      decision,
    };
    expect(Object.keys(request).sort()).toEqual([
      "available_agent_slots",
      "decision",
      "invocation_ref",
      "version",
    ]);
    expect(collectForbiddenFields(request)).toEqual([]);

    const changed = await driver.automaticBuildStep(request);
    expect(changed.action).toMatchObject({ kind: "NEEDS_USER", reason: "plan_changed" });
    if (changed.action.kind !== "NEEDS_USER" || first.action.kind !== "NEEDS_USER") {
      throw new Error("expected two user decision projections");
    }
    expect(changed.action.request_id).not.toBe(first.action.request_id);
    expectRootSafeStep(changed, [value.root, value.buildPlanPath]);
  });

  it("binds a fresh budget decision to the current deterministic receipt", async () => {
    const driver = expectedDriver();
    const value = fixture("budget-decision", {
      budget: { max_total_tokens: 1, on_exceed: "needs_user" },
    });
    const invocation = await createInvocation(driver, value);
    const first = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    expect(first.action).toMatchObject({ kind: "NEEDS_USER", reason: "budget_exceeded" });

    const continued = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
      decision: firstDecision(first),
    });
    expect(continued.action.kind).toBe("SPAWN_EXECUTORS");
    expectRootSafeStep(continued, [value.root, value.buildPlanPath]);
    const replayed = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    expect(replayed).toEqual(continued);
  });

  it("reissues a bounded user projection when wall-clock evaluation drifts", async () => {
    const driver = expectedDriver();
    const value = fixture("evaluation-drift", {
      body: [
        "# Guide",
        ...Array.from({ length: 80 }, (_, index) => (
          `Paragraph ${index + 1} provides deterministic evidence for evaluation drift.`
        )),
      ].join("\n\n"),
    });
    const executor: AutomaticBuildExecutorProvenanceV1 = {
      model: "codex-driver-test",
      reasoning_effort: "high",
      harness_release: "codex-2026.08",
    };
    const wallBudget: AutomaticBuildWallBudgetV1 = {
      version: "automatic_build_wall_budget.v1",
      max_agent_starts: 0,
      on_exceed: "needs_user",
    };
    const invocation = await createInvocation(driver, value, {
      wall_budget: wallBudget,
      executor_provenance: executor,
    });
    const first = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    const decision = firstDecision(first);
    writeMatchedPerformanceHistory(value, executor);

    const changed = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
      decision,
    });
    expect(changed.action.kind).toBe("NEEDS_USER");
    if (changed.action.kind !== "NEEDS_USER" || first.action.kind !== "NEEDS_USER") {
      throw new Error("expected two wall-budget user projections");
    }
    expect(changed.action.request_id).not.toBe(first.action.request_id);
    expect(["low_confidence_wall_budget", "wall_budget_exceeded"]).toContain(changed.action.reason);
    expect(["preflight_required", "evaluation_required", "evaluation_changed"]).not.toContain(
      changed.action.reason,
    );
    expectRootSafeStep(changed, [value.root, value.buildPlanPath]);
  });

  it("closes and replans internally instead of returning a close command", async () => {
    const driver = expectedDriver();
    const generated = createSyntheticRoutabilityFixture(200);
    writeSyntheticPass1ProductionGeneration(generated, { grounded: true });
    const buildPlan = confirmedStandardBuildPlan(generated.source_file, generated.root);
    const buildPlanPath = path.join(generated.root, "confirmed-build-plan.json");
    writeFileSync(buildPlanPath, `${JSON.stringify(buildPlan, null, 2)}\n`, "utf8");
    const current = automaticBuildPlan(generated.source_file, generated.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    expect(current.next_action).toEqual({ kind: "close_stage", stage: "pass1" });

    const invocation = await driver.createAutomaticBuildInvocation({
      version: "automatic_build_invocation_create.v1",
      target_input: generated.source_file,
      root_dir: generated.root,
      build_plan_path: buildPlanPath,
      quality_profile: "full",
      max_parallel: 1,
      created_at: "2026-08-08T05:10:00.000Z",
    });
    const response = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });

    expectRootSafeStep(response, [generated.root, buildPlanPath]);
    const replanned = automaticBuildPlan(generated.source_file, generated.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    expect(replanned.snapshot.stages.find((stage) => stage.stage === "pass1")?.closed).toBe(true);
    expect(replanned.next_action).not.toEqual({ kind: "close_stage", stage: "pass1" });
  }, 30_000);

  it("advances from a terminal dispatch receipt on disk without a receipt body from root", async () => {
    const driver = expectedDriver();
    const value = fixture("disk-receipt");
    const plan = automaticBuildPlan(value.source, value.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: value.buildPlan,
    });
    if (!plan.preflight) throw new Error("expected dispatch preflight");
    const dispatched = automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T05:20:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: value.buildPlan,
    });
    if (!("dispatches" in dispatched.action) || !dispatched.action.dispatches) {
      throw new Error("expected a persisted public dispatch");
    }
    const envelope = dispatched.action.dispatches[0];
    const target = resolveAutomaticBuildTarget(value.source, value.root);
    let advanced = automaticBuildDispatchNext(
      value.source,
      value.root,
      envelope.manifest.stage,
      envelope.manifest.dispatch_id,
      { dispatch_run_id: envelope.dispatch_run_id, now: "2026-08-08T05:20:01.000Z" },
    );
    while (advanced.action.kind === "task") {
      commitDispatchTask(target, advanced.action.task);
      advanced = automaticBuildDispatchNext(
        value.source,
        value.root,
        envelope.manifest.stage,
        envelope.manifest.dispatch_id,
        { dispatch_run_id: envelope.dispatch_run_id, now: "2026-08-08T05:20:02.000Z" },
      );
    }
    expect(advanced.action.kind).toBe("finish");
    automaticBuildDispatchFinish(
      value.source,
      value.root,
      envelope.manifest.stage,
      envelope.manifest.dispatch_id,
      { dispatch_run_id: envelope.dispatch_run_id, now: "2026-08-08T05:20:03.000Z" },
    );

    const invocation = await createInvocation(driver, value, { created_at: "2026-08-08T05:20:04.000Z" });
    const request = {
      version: "automatic_build_step_request.v1" as const,
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1 as const,
    };
    expect(Object.keys(request).sort()).toEqual([
      "available_agent_slots",
      "invocation_ref",
      "version",
    ]);
    const response = await driver.automaticBuildStep(request);

    expect(response.action.kind).toBe("SPAWN_EXECUTORS");
    expectRootSafeStep(response, [value.root, value.buildPlanPath, "driver-receipt-"]);
  }, 30_000);

  it("runs driver commands and accepts a PowerShell-style UTF-8 BOM on executor stdin", () => {
    const value = fixture("stdin-command");
    const env = {
      ...process.env,
      UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT: path.join(value.root, "driver-registry"),
    };
    const run = (input: unknown) => spawnSync(process.execPath, [TSX_CLI, DRIVER_CLI], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      input: `${JSON.stringify(input)}\n`,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const created = run({
      version: "automatic_build_invocation_create.v1",
      target_input: value.source,
      root_dir: value.root,
      build_plan_path: value.buildPlanPath,
      quality_profile: "full",
      max_parallel: 1,
      created_at: "2026-08-08T05:25:00.000Z",
    });
    expect(created.status, created.stderr).toBe(0);
    expect(created.stderr).toBe("");
    const invocation = JSON.parse(created.stdout) as { invocation_ref: string };

    const stepped = run({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    expect(stepped.status, stepped.stderr).toBe(0);
    expect(stepped.stderr).toBe("");
    const response = JSON.parse(stepped.stdout) as AutomaticBuildStepResponseV1;
    expect(response.action.kind).toBe("SPAWN_EXECUTORS");
    expectRootSafeStep(response, [value.root, value.source, value.buildPlanPath]);
    if (response.action.kind !== "SPAWN_EXECUTORS") throw new Error("expected an executor ref");
    const executorOpenRequest = Buffer.from(`${JSON.stringify({
      version: "automatic_build_executor_open_request.v1",
      opaque_handoff_ref: response.action.executors[0].opaque_handoff_ref,
      now: "2026-08-08T05:25:01.000Z",
    })}\n`, "utf8");
    const opened = spawnSync(process.execPath, [TSX_CLI, EXECUTOR_SESSION_CLI], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      input: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), executorOpenRequest]),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(opened.status, opened.stderr).toBe(0);
    expect(opened.stderr).toBe("");
    const openedResponse = JSON.parse(opened.stdout) as AutomaticBuildExecutorSessionResponseV1;
    expect(openedResponse.version).toBe("automatic_build_executor_session.v1");
    expect(openedResponse.action.kind).toBe("GENERATE");
    if (openedResponse.action.kind !== "GENERATE") throw new Error("expected GENERATE executor action");
    expect(openedResponse.action.opaque_session_ref).toMatch(/^absession1_[a-f0-9]{64}$/u);
    expect(openedResponse.action.semantic_input).toContain("PRIVATE_DRIVER_INPUT");
    expect(openedResponse.action.output_contract).toMatchObject({
      version: "automatic_build_semantic_candidate_contract.v1",
      stage: "pass1",
      work_unit_id: "0",
    });
    const sidecarEntry = readFileSync(path.join(REPO_ROOT, "skills", "build", "sidecar-entry.ts"), "utf8");
    expect(sidecarEntry).toContain("command === \"build.step\"");
    expect(sidecarEntry).toContain("command === \"executor.open\"");
  }, 30_000);

  it("makes executor.open reject digest drift and escaping refs before any task claim", async () => {
    const executorSession = expectedExecutorSession();
    const value = fixture("executor-open");
    const plan = automaticBuildPlan(value.source, value.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: value.buildPlan,
    });
    if (!plan.preflight) throw new Error("expected executor-open preflight");
    const dispatched = automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T05:30:00.000Z",
      accepted_plan_digest: plan.preflight.plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: value.buildPlan,
    });
    if (!("dispatches" in dispatched.action) || !dispatched.action.dispatches) {
      throw new Error("expected executor handoff publication");
    }
    const envelope = dispatched.action.dispatches[0];
    const target = resolveAutomaticBuildTarget(value.source, value.root);
    const issued = await executorSession.issueAutomaticBuildOpaqueHandoff({
      target,
      kind: "public_dispatch",
      owner_identity: {
        version: "automatic_build_dispatch_owner_identity.v1",
        stage: envelope.manifest.stage,
        dispatch_id: envelope.manifest.dispatch_id,
        dispatch_run_id: envelope.dispatch_run_id,
      },
      executor_handoff: envelope.executor_handoff,
      issued_at: "2026-08-08T05:30:01.000Z",
    });
    expect(readAutomaticBuildAttemptSnapshot(target).stages).toEqual({});
    writeFileSync(envelope.executor_handoff.path, "{}\n", "utf8");

    await expect(Promise.resolve().then(() => executorSession.openAutomaticBuildExecutorSession(
      issued.opaque_handoff_ref,
      { now: "2026-08-08T05:30:02.000Z" },
    ))).rejects.toThrow(/handoff|digest|invalid/i);
    await expect(Promise.resolve().then(() => executorSession.openAutomaticBuildExecutorSession(
      "../escape",
      { now: "2026-08-08T05:30:03.000Z" },
    ))).rejects.toThrow();
    expect(readAutomaticBuildAttemptSnapshot(target).stages).toEqual({});
  });
});

describe("S4 private artifact driver and executor session", () => {
  it("drives public completion through private preparation and accepts every artifact without root leakage", async () => {
    const driver = expectedDriver();
    const value = privateGoalFixture("private-complete");
    const invocation = await createInvocation(driver, value, {
      created_at: "2026-08-08T07:00:01.000Z",
    });

    const spawned = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 2,
    });
    if (spawned.action.kind !== "SPAWN_EXECUTORS") {
      throw new Error("S4_RED_PRIVATE_ARTIFACT_DRIVER_UNAVAILABLE: expected private executor refs after public done");
    }
    expect(spawned.action.executors).toHaveLength(2);
    expect(new Set(spawned.action.executors.map((executor) => executor.opaque_handoff_ref)).size).toBe(2);
    expectRootSafeStep(spawned, [
      value.privateRoot,
      value.buildPlanPath,
      value.intent.intent_id,
      value.buildPlan.plan_id,
      "PRIVATE_S4_RAW_GOAL",
      "PRIVATE_S4_GOAL_SOURCE",
    ]);

    for (const [index, executor] of spawned.action.executors.entries()) {
      const opened = openAutomaticBuildExecutorSession(executor.opaque_handoff_ref, {
        now: `2026-08-08T07:00:0${index + 2}.000Z`,
      });
      if (opened.action.kind !== "GENERATE") {
        throw new Error("S4_RED_PRIVATE_EXECUTOR_SESSION_UNAVAILABLE: expected private GENERATE action");
      }
      expect(JSON.stringify(opened.action.semantic_input)).toContain("PRIVATE_S4_RAW_GOAL");
      const submitted = submitAutomaticBuildExecutorCandidate(
        opened.action.opaque_session_ref,
        privateCandidateFor(value.root, opened.action, String(index)),
        { now: `2026-08-08T07:00:1${index}.000Z` },
      );
      expect(submitted).toEqual({
        version: "automatic_build_executor_session.v1",
        action: { kind: "DONE", status: "committed" },
      });
    }

    const done = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 2,
    });
    expect(done.action.kind).toBe("DONE");
    expectRootSafeStep(done, [
      value.privateRoot,
      value.buildPlanPath,
      value.intent.intent_id,
      value.buildPlan.plan_id,
      "PRIVATE_S4_RAW_GOAL",
    ]);
  });

  it("lets an untouched sibling commit before retrying one failed artifact and resumes the retry in place", async () => {
    const driver = expectedDriver();
    const value = privateGoalFixture("private-retry");
    const invocation = await createInvocation(driver, value, {
      created_at: "2026-08-08T07:10:00.000Z",
    });
    const firstWave = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 2,
    });
    if (firstWave.action.kind !== "SPAWN_EXECUTORS") {
      throw new Error("S4_RED_PRIVATE_ARTIFACT_DRIVER_UNAVAILABLE: expected a two-artifact wave");
    }
    expect(firstWave.action.executors).toHaveLength(2);
    const failedRef = firstWave.action.executors[0].opaque_handoff_ref;
    const siblingRef = firstWave.action.executors[1].opaque_handoff_ref;
    const failedOpen = openAutomaticBuildExecutorSession(failedRef, {
      now: "2026-08-08T07:10:01.000Z",
    });
    const siblingOpen = openAutomaticBuildExecutorSession(siblingRef, {
      now: "2026-08-08T07:10:02.000Z",
    });
    if (failedOpen.action.kind !== "GENERATE" || siblingOpen.action.kind !== "GENERATE") {
      throw new Error("S4_RED_PRIVATE_EXECUTOR_SESSION_UNAVAILABLE: expected both private tasks to generate");
    }
    expect(failAutomaticBuildExecutorSession(failedOpen.action.opaque_session_ref, {
      diagnostic_code: "provider_unavailable",
      now: "2026-08-08T07:10:03.000Z",
    })).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "DONE", status: "retryable_failure" },
    });
    expect(submitAutomaticBuildExecutorCandidate(
      siblingOpen.action.opaque_session_ref,
      privateCandidateFor(value.root, siblingOpen.action, "sibling"),
      { now: "2026-08-08T07:10:04.000Z" },
    )).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "DONE", status: "committed" },
    });

    const retryWave = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    if (retryWave.action.kind !== "SPAWN_EXECUTORS") {
      throw new Error("S4_RED_PRIVATE_RETRY_UNAVAILABLE: expected one retry ref");
    }
    expect(retryWave.action.executors).toHaveLength(1);
    expect(retryWave.action.executors[0].opaque_handoff_ref).not.toBe(failedRef);
    expect(retryWave.action.executors[0].opaque_handoff_ref).not.toBe(siblingRef);
    const retryFirst = openAutomaticBuildExecutorSession(retryWave.action.executors[0].opaque_handoff_ref, {
      now: "2026-08-08T07:10:05.000Z",
    });
    const retryResume = openAutomaticBuildExecutorSession(retryWave.action.executors[0].opaque_handoff_ref, {
      now: "2026-08-08T07:10:06.000Z",
    });
    expect(retryResume).toEqual(retryFirst);
    if (retryFirst.action.kind !== "GENERATE") {
      throw new Error("S4_RED_PRIVATE_RETRY_UNAVAILABLE: expected retry GENERATE action");
    }
    expect(submitAutomaticBuildExecutorCandidate(
      retryFirst.action.opaque_session_ref,
      privateCandidateFor(value.root, retryFirst.action, "retry"),
      { now: "2026-08-08T07:10:07.000Z" },
    )).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "DONE", status: "committed" },
    });
    const done = await driver.automaticBuildStep({
      version: "automatic_build_step_request.v1",
      invocation_ref: invocation.invocation_ref,
      available_agent_slots: 1,
    });
    expect(done.action.kind).toBe("DONE");
    expectRootSafeStep(done, [value.privateRoot, "PRIVATE_S4_RAW_GOAL"]);
  });
});
