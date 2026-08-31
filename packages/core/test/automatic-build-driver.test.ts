import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { failAutomaticBuildTask, submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import { claimAutomaticBuildTask, startAutomaticBuildLease } from "../src/automatic-build-lease";
import {
  failAutomaticBuildExecutorSession,
  openAutomaticBuildExecutorSessionV3,
  nextAutomaticBuildExecutorInput,
  startAutomaticBuildExecutorGeneration,
  submitAutomaticBuildExecutorCandidateV3,
  type AutomaticBuildExecutorSessionResponseV1,
  type AutomaticBuildExecutorSessionResponseV3,
  type JsonValue,
} from "../src/automatic-build-executor-session";
import {
  automaticBuildTaskStoreRoot,
  readAutomaticBuildAttemptSnapshot,
} from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import {
  createAutomaticBuildFailureDiagnostic,
  createAutomaticBuildFailureDiagnosticV3,
} from "../src/extractor-contract";
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
  type IntentArtifactCandidateV3,
  type IntentArtifactTaskEnvelopeV3,
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
  "failure_diagnostic",
  "diagnostic_digest",
  "json_pointer",
  "expected",
  "plan_digest",
  "plan_id",
  "policy_generation_id",
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
  task: IntentArtifactTaskEnvelopeV3,
  label: string,
): JsonValue {
  expect(task.version).toBe("intent_artifact_task_envelope.v3");
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
  const adapted = adaptIntentArtifactPayloadV1(task.artifact.artifact_type, legacyPayload);
  const candidate: IntentArtifactCandidateV3 = {
    version: "intent_artifact_candidate.v3",
    task_id: task.task_id,
    book_id: task.book_id,
    source_fingerprint: task.source_fingerprint,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
    payload: {
      version: "artifact_instance.v3",
      blueprint_id: task.artifact.blueprint_id,
      blueprint_version: task.artifact.blueprint_version,
      records: adapted.records,
      ...(adapted.relations === undefined ? {} : { relations: adapted.relations }),
    },
  };
  return candidate as unknown as JsonValue;
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

function startV3GenerationForHandoff(opaqueHandoffRef: string, now: string) {
  const opened = openAutomaticBuildExecutorSessionV3(opaqueHandoffRef, { now });
  if (opened.action.kind !== "DELIVER_INPUT") {
    throw new Error("expected V3 input delivery before generation");
  }
  let request = opened.action.next_request;
  for (let ordinal = 0; ordinal < 256; ordinal += 1) {
    const response = nextAutomaticBuildExecutorInput(request, { now });
    if (response.action.kind === "GENERATION_GRANT") {
      return startAutomaticBuildExecutorGeneration({
        version: "automatic_build_executor_generation_start_request.v2",
        opaque_session_ref: response.action.grant.opaque_session_ref,
        generation_grant_ref: response.action.grant.generation_grant_ref,
      }, { now });
    }
    if (response.action.kind !== "INPUT_CHUNK") {
      throw new Error("expected V3 input chunk or generation grant");
    }
    request = {
      version: "automatic_build_executor_input_next_request.v3",
      opaque_session_ref: opened.action.input_manifest.opaque_session_ref,
      generation_input_ref: opened.action.input_manifest.generation_input_ref,
      previous_chunk_ordinal: response.action.chunk.ordinal,
    };
  }
  throw new Error("V3 input delivery did not reach a generation grant");
}

function startPrivateV3GenerationForHandoff(
  opaqueHandoffRef: string,
  now: string,
): {
  generation: AutomaticBuildExecutorSessionResponseV3 & {
    action: Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "GENERATE" }>;
  };
  task: IntentArtifactTaskEnvelopeV3;
} {
  const opened = openAutomaticBuildExecutorSessionV3(opaqueHandoffRef, { now });
  if (opened.action.kind !== "DELIVER_INPUT") {
    throw new Error("expected private V3 input delivery before generation");
  }
  const semanticInput: string[] = [];
  let request = opened.action.next_request;
  for (let ordinal = 0; ordinal < 256; ordinal += 1) {
    const response = nextAutomaticBuildExecutorInput(request, { now });
    if (response.action.kind === "GENERATION_GRANT") {
      const generation = startAutomaticBuildExecutorGeneration({
        version: "automatic_build_executor_generation_start_request.v2",
        opaque_session_ref: response.action.grant.opaque_session_ref,
        generation_grant_ref: response.action.grant.generation_grant_ref,
      }, { now });
      if (generation.action.kind !== "GENERATE") {
        throw new Error("expected private V3 GENERATE action");
      }
      return {
        generation: generation as typeof generation & {
          action: Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "GENERATE" }>;
        },
        task: JSON.parse(semanticInput.join("")) as IntentArtifactTaskEnvelopeV3,
      };
    }
    if (response.action.kind !== "INPUT_CHUNK") {
      throw new Error("expected private V3 input chunk or generation grant");
    }
    if (response.action.chunk.segment === "semantic_input") {
      semanticInput.push(response.action.chunk.payload_utf8);
    }
    request = {
      version: "automatic_build_executor_input_next_request.v3",
      opaque_session_ref: opened.action.input_manifest.opaque_session_ref,
      generation_input_ref: opened.action.input_manifest.generation_input_ref,
      previous_chunk_ordinal: response.action.chunk.ordinal,
    };
  }
  throw new Error("private V3 input delivery did not reach a generation grant");
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
      if (!task.lease.policy_generation_id) throw new Error("expected a proof-bound dispatch lease");
      return writePass1ProductionTaskArtifact({
        target,
        policy_generation_id: task.lease.policy_generation_id,
        work_unit_id: task.task_id,
        marker,
        generated_at: task.lease.issued_at,
      });
    },
    { now: task.lease.issued_at, completed_at: task.lease.issued_at },
  );
}

function taskTreeDigest(target: ReturnType<typeof resolveAutomaticBuildTarget>): string {
  const root = automaticBuildTaskStoreRoot(target);
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        hash.update(`D:${relative}\n`);
        visit(file);
      } else if (entry.isFile()) {
        hash.update(`F:${relative}\n`);
        hash.update(readFileSync(file));
      } else {
        throw new Error(`unexpected synthetic task-tree entry: ${relative}`);
      }
    }
  };
  if (existsSync(root)) visit(root);
  return hash.digest("hex");
}

function exhaustFirstPublicTask(
  value: ReturnType<typeof fixture>,
  failureDiagnostic: ReturnType<typeof createAutomaticBuildFailureDiagnostic>
    | ReturnType<typeof createAutomaticBuildFailureDiagnosticV3> = createAutomaticBuildFailureDiagnosticV3({
    category: "schema",
    code: "schema_invalid",
    phase: "generation",
    json_pointer: "/discourse_items/0/local_summary",
    expected: "string length <= 200",
  }),
): void {
  const plan = automaticBuildPlan(value.source, value.root, {
    requested_workers: 1,
    available_agent_slots: 1,
    build_plan: value.buildPlan,
  });
  if (!plan.preflight) throw new Error("expected retry-boundary preflight");
  const target = resolveAutomaticBuildTarget(value.source, value.root);
  const stage = plan.snapshot.stages.find((candidate) => candidate.stage === "pass1");
  const descriptor = stage?.work_units?.[0];
  const binding = descriptor ? stage?.task_bindings?.[descriptor.work_unit_id] : undefined;
  if (!descriptor || descriptor.version !== "automatic_build_work_unit.v3" || !binding) {
    throw new Error("expected a proof-bound synthetic Pass1 work unit");
  }
  for (let semanticAttempt = 1; semanticAttempt <= 3; semanticAttempt += 1) {
    const claim = claimAutomaticBuildTask(target, "pass1", descriptor.work_unit_id, {
      owner: `driver-scope-a-${semanticAttempt}`,
      now: `2026-08-10T02:00:0${semanticAttempt}.000Z`,
      descriptor,
      binding,
      policy_generation: "v3_only",
      max_semantic_attempts: 3,
    });
    if (claim.status !== "leased") throw new Error(`expected synthetic scope A task ${semanticAttempt}`);
    failAutomaticBuildTask(target, claim.lease_ref, claim.lease.token, {
      failure_diagnostic: failureDiagnostic,
      now: `2026-08-10T02:00:0${semanticAttempt}.100Z`,
    });
  }
}

async function exhaustedRetryBoundary(
  driver: AutomaticBuildDriverModule,
  value: ReturnType<typeof fixture>,
  createdAt: string,
  options: {
    failure_diagnostic?: ReturnType<typeof createAutomaticBuildFailureDiagnostic>
      | ReturnType<typeof createAutomaticBuildFailureDiagnosticV3>;
    expected_projection?: Record<string, unknown>;
  } = {},
) {
  exhaustFirstPublicTask(value, options.failure_diagnostic);
  const invocation = await createInvocation(driver, value, { created_at: createdAt });
  const exhausted = await driver.automaticBuildStep({
    version: "automatic_build_step_request.v1",
    invocation_ref: invocation.invocation_ref,
    available_agent_slots: 1,
  });
  expect(exhausted.action).toMatchObject({
    kind: "NEEDS_USER",
    reason: "retry_exhausted",
    choices: [{ choice_id: "retry_current", label: "Validate recovery and retry" }],
    projection: options.expected_projection ?? {
      category: "schema",
      code: "schema_invalid",
      phase: "generation",
      stage: "pass1",
      work_unit_count: 1,
      required_recovery: "publish_new_policy_scope",
    },
  });
  expect(JSON.stringify(exhausted)).not.toMatch(/diagnostic_digest|json_pointer|expected|synthetic schema_invalid/u);
  expectRootSafeStep(exhausted, [value.root, value.source, value.buildPlanPath, "PRIVATE_DRIVER_INPUT"]);
  const retryDecision = firstDecision(exhausted);
  expect(retryDecision.choice_id).toBe("retry_current");
  const target = resolveAutomaticBuildTarget(value.source, value.root);
  return {
    invocation,
    retryDecision,
    target,
    exhaustedTreeDigest: taskTreeDigest(target),
  };
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

  it("fails closed before task mutation when the installed executor protocol is unavailable", async () => {
    const driver = expectedDriver();
    const value = fixture("executor-installation-incompatible");
    const invocation = await createInvocation(driver, value);
    const target = resolveAutomaticBuildTarget(value.source, value.root);
    const before = taskTreeDigest(target);
    const previousSidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = path.join(value.root, "missing-understand-book-build.exe");
    try {
      const response = await driver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: invocation.invocation_ref,
        available_agent_slots: 1,
      });
      expect(response.action).toMatchObject({
        kind: "NEEDS_USER",
        reason: "installation_incompatible",
        projection: { category: "installation_incompatible" },
      });
      expect(taskTreeDigest(target)).toBe(before);
      expectRootSafeStep(response, [
        value.root,
        value.source,
        value.buildPlanPath,
        "missing-understand-book-build.exe",
        "PRIVATE_DRIVER_INPUT",
      ]);
    } finally {
      if (previousSidecar === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previousSidecar;
    }
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

  it("reissues a durable active dispatch after volatile registry loss without another semantic attempt", async () => {
    vi.useFakeTimers();
    const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    const value = fixture("durable-active-dispatch-registry-loss", {
      body: `# Guide\n\n${"bounded durable recovery input ".repeat(400)}\n`,
    });
    const registryRoot = path.join(value.root, "driver-registry");
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registryRoot;
    try {
      vi.setSystemTime(new Date("2026-08-08T05:00:00.000Z"));
      const driver = expectedDriver();
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
      const firstRef = first.action.executors[0]?.opaque_handoff_ref;
      if (!firstRef) throw new Error("expected the first executor handoff ref");
      const firstGeneration = startV3GenerationForHandoff(
        firstRef,
        "2026-08-08T05:00:01.000Z",
      );
      expect(firstGeneration.action).toMatchObject({ kind: "GENERATE", semantic_attempt: 1 });

      const target = resolveAutomaticBuildTarget(value.source, value.root);
      const beforeLoss = Object.values(readAutomaticBuildAttemptSnapshot(target).stages.pass1 ?? {});
      expect(beforeLoss).toHaveLength(1);
      expect(beforeLoss[0]).toMatchObject({ semantic_attempt: 1, failures: 0 });

      rmSync(registryRoot, { recursive: true, force: true });
      vi.setSystemTime(new Date("2026-08-08T05:00:02.000Z"));
      const freshInvocation = await createInvocation(driver, value, {
        created_at: "2026-08-08T05:00:02.000Z",
      });
      const resumed = await driver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: freshInvocation.invocation_ref,
        available_agent_slots: 1,
      });
      expect(resumed.action.kind).toBe("SPAWN_EXECUTORS");
      if (resumed.action.kind !== "SPAWN_EXECUTORS") {
        throw new Error("expected durable active dispatch reissue after registry loss");
      }
      expect(resumed.action.executors).toEqual(first.action.executors);

      const resumedGeneration = startV3GenerationForHandoff(
        resumed.action.executors[0]!.opaque_handoff_ref,
        "2026-08-08T05:00:03.000Z",
      );
      expect(resumedGeneration.action).toMatchObject({ kind: "GENERATE", semantic_attempt: 1 });
      const afterRecovery = Object.values(readAutomaticBuildAttemptSnapshot(target).stages.pass1 ?? {});
      expect(afterRecovery).toHaveLength(1);
      expect(afterRecovery[0]).toMatchObject({ semantic_attempt: 1, failures: 0 });
      expectRootSafeStep(resumed, [value.root, value.source, value.buildPlanPath]);
    } finally {
      if (previousRegistryRoot === undefined) {
        delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      } else {
        process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
      }
      vi.useRealTimers();
    }
  }, 30_000);

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
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
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
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
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
    const acceptedPlanDigest = plan.preflight.descriptor_plan_digest;
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

  it("keeps deterministic retry_current side-effect free while the policy scope is unchanged", async () => {
    const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    const value = fixture("deterministic-retry");
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = path.join(value.root, "driver-registry");
    try {
      const driver = expectedDriver();
      const { invocation, retryDecision, target, exhaustedTreeDigest } = await exhaustedRetryBoundary(
        driver,
        value,
        "2026-08-10T02:00:10.000Z",
      );
      const stillBlocked = await driver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: invocation.invocation_ref,
        available_agent_slots: 1,
        decision: retryDecision,
      });
      expect(stillBlocked.action).toMatchObject({
        kind: "NEEDS_USER",
        reason: "recovery_not_satisfied",
        projection: {
          category: "schema",
          code: "schema_invalid",
          phase: "generation",
          required_recovery: "publish_new_policy_scope",
        },
      });
      expect(taskTreeDigest(target)).toBe(exhaustedTreeDigest);
      expect(existsSync(path.join(
        value.root,
        "driver-registry",
        "decisions",
        invocation.invocation_ref,
        `${retryDecision.request_id}.json`,
      ))).toBe(false);
    } finally {
      if (previousRegistryRoot === undefined) {
        delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      } else {
        process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
      }
    }
  }, 30_000);

  it("writes one terminal-bound recovery receipt for an allowlisted transient retry_current", async () => {
    const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    const value = fixture("transient-retry");
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = path.join(value.root, "driver-registry");
    try {
      const driver = expectedDriver();
      const providerDiagnostic = createAutomaticBuildFailureDiagnosticV3({
        category: "provider",
        code: "provider_timeout",
        phase: "generation",
      });
      const { invocation, retryDecision, target } = await exhaustedRetryBoundary(
        driver,
        value,
        "2026-08-10T02:05:10.000Z",
        {
          failure_diagnostic: providerDiagnostic,
          expected_projection: {
            category: "provider",
            code: "provider_timeout",
            phase: "generation",
            stage: "pass1",
            work_unit_count: 1,
            required_recovery: "confirm_transient_retry",
          },
        },
      );
      const recovered = await driver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: invocation.invocation_ref,
        available_agent_slots: 1,
        decision: retryDecision,
      });
      expect(recovered.action.kind).toBe("SPAWN_EXECUTORS");
      expectRootSafeStep(recovered, [value.root, value.source, value.buildPlanPath]);

      const taskRoot = automaticBuildTaskStoreRoot(target);
      const recoveryFiles = readdirSync(taskRoot, { recursive: true })
        .map(String)
        .filter((entry) => entry.replaceAll("\\", "/").endsWith("/recovery.json"));
      expect(recoveryFiles).toHaveLength(1);
      const receipt = JSON.parse(readFileSync(path.join(taskRoot, recoveryFiles[0]), "utf8")) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        version: "automatic_build_retry_recovery.v1",
        decision_request_id: retryDecision.request_id,
        action: "open_same_scope_retry_window",
        diagnostic_digest: providerDiagnostic.diagnostic_digest,
      });
      const failureFiles = readdirSync(taskRoot, { recursive: true })
        .map(String)
        .filter((entry) => entry.replaceAll("\\", "/").endsWith("/failure.json"))
        .sort();
      const resultFiles = readdirSync(taskRoot, { recursive: true })
        .map(String)
        .filter((entry) => entry.replaceAll("\\", "/").endsWith("/result.json"))
        .sort();
      expect(receipt.terminal_receipt_sha256).toBe(
        createHash("sha256").update(readFileSync(path.join(taskRoot, failureFiles.at(-1)!))).digest("hex"),
      );
      expect(receipt.terminal_receipt_sha256).not.toBe(
        createHash("sha256").update(readFileSync(path.join(taskRoot, resultFiles.at(-1)!))).digest("hex"),
      );
      expect(readdirSync(taskRoot, { recursive: true }).map(String)
        .filter((entry) => entry.replaceAll("\\", "/").endsWith("/reset.json"))).toHaveLength(0);
    } finally {
      if (previousRegistryRoot === undefined) {
        delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      } else {
        process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
      }
    }
  }, 30_000);

  it("rejects terminal receipt drift without persisting a decision or recovery effect", async () => {
    const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    const value = fixture("stale-terminal-retry");
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = path.join(value.root, "driver-registry");
    try {
      const driver = expectedDriver();
      const { invocation, retryDecision, target } = await exhaustedRetryBoundary(
        driver,
        value,
        "2026-08-10T02:07:10.000Z",
      );
      const taskRoot = automaticBuildTaskStoreRoot(target);
      const failureFiles = readdirSync(taskRoot, { recursive: true })
        .map(String)
        .filter((entry) => entry.replaceAll("\\", "/").endsWith("/failure.json"))
        .sort();
      const terminalPath = path.join(taskRoot, failureFiles.at(-1)!);
      const terminal = JSON.parse(readFileSync(terminalPath, "utf8")) as Record<string, unknown>;
      writeFileSync(terminalPath, `${JSON.stringify(terminal)}\n`, "utf8");
      const driftedTreeDigest = taskTreeDigest(target);

      const rejected = await driver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: invocation.invocation_ref,
        available_agent_slots: 1,
        decision: retryDecision,
      });
      expect(rejected.action).toMatchObject({
        kind: "NEEDS_USER",
        reason: "plan_changed",
        choices: [],
      });
      expect(taskTreeDigest(target)).toBe(driftedTreeDigest);
      expect(readdirSync(taskRoot, { recursive: true }).map(String)
        .filter((entry) => entry.replaceAll("\\", "/").endsWith("/recovery.json"))).toHaveLength(0);
      expect(existsSync(path.join(
        value.root,
        "driver-registry",
        "decisions",
        invocation.invocation_ref,
        `${retryDecision.request_id}.json`,
      ))).toBe(false);
    } finally {
      if (previousRegistryRoot === undefined) {
        delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      } else {
        process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
      }
    }
  }, 30_000);

  it("replans retry_current when the complete policy scope changes", async () => {
    const previousRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    const value = fixture("policy-scope-retry");
    const registryRoot = path.join(value.root, "driver-registry");
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registryRoot;
    try {
      const driver = expectedDriver();
      const { invocation, retryDecision, target, exhaustedTreeDigest } = await exhaustedRetryBoundary(
        driver,
        value,
        "2026-08-10T02:10:10.000Z",
      );

      const originalPass1Reduction = await vi.importActual<typeof import("../src/pass1-reduction")>(
        "../src/pass1-reduction",
      );
      vi.doMock("../src/pass1-reduction", () => ({
        ...originalPass1Reduction,
        pass1ModelSlicePolicyMembers: (
          ...args: Parameters<typeof originalPass1Reduction.pass1ModelSlicePolicyMembers>
        ) => originalPass1Reduction.pass1ModelSlicePolicyMembers(...args).map((member) => (
          member.kind === "pass1_window"
            ? { ...member, policy_generation_id: "pass1-window.full.v2" }
            : member
        )),
      }));
      vi.doMock("../../../skills/build/automatic-build", async () => {
        const actual = await vi.importActual<typeof import("../../../skills/build/automatic-build")>(
          "../../../skills/build/automatic-build",
        );
        return {
          ...actual,
          // SR2 isolates attempt-scope replanning from the forward-release parity
          // gate; the synthetic explicit policy generation is intentionally unpublished.
          automaticBuildProtocolDoctor: () => ({ status: "compatible" as const }),
        };
      });
      vi.resetModules();
      const policyBDriver = await import("../../../skills/build/automatic-build-driver");
      const replanned = policyBDriver.automaticBuildStep({
        version: "automatic_build_step_request.v1",
        invocation_ref: invocation.invocation_ref,
        available_agent_slots: 1,
        decision: retryDecision,
      });

      expect({
        kind: replanned.action.kind,
        ...(replanned.action.kind === "NEEDS_USER" ? { reason: replanned.action.reason } : {}),
      }).toEqual({ kind: "SPAWN_EXECUTORS" });
      const requestRecord = JSON.parse(readFileSync(
        path.join(registryRoot, "requests", `${retryDecision.request_id}.json`),
        "utf8",
      )) as Record<string, unknown>;
      const decisionReceipt = JSON.parse(readFileSync(
        path.join(registryRoot, "decisions", invocation.invocation_ref, `${retryDecision.request_id}.json`),
        "utf8",
      )) as Record<string, unknown>;
      expect(decisionReceipt).toMatchObject({
        version: "automatic_build_decision_receipt.v1",
        invocation_ref: invocation.invocation_ref,
        request_id: retryDecision.request_id,
        choice_id: "retry_current",
      });
      expect(decisionReceipt.state).not.toEqual(requestRecord.state);
      expect(taskTreeDigest(target)).toBe(exhaustedTreeDigest);
    } finally {
      vi.doUnmock("../src/pass1-reduction");
      vi.doUnmock("../../../skills/build/automatic-build");
      vi.resetModules();
      if (previousRegistryRoot === undefined) {
        delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      } else {
        process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = previousRegistryRoot;
      }
    }
  }, 30_000);

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
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
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
    expect(sidecarEntry).toContain("\"executor.open\",");
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
      accepted_plan_digest: plan.preflight.descriptor_plan_digest,
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
      const started = startPrivateV3GenerationForHandoff(
        executor.opaque_handoff_ref,
        `2026-08-08T07:00:0${index + 2}.000Z`,
      );
      expect(JSON.stringify(started.task)).toContain("PRIVATE_S4_RAW_GOAL");
      expect(started.task).not.toHaveProperty("intent_digest");
      expect(started.task).not.toHaveProperty("plan_digest");
      expect(started.task.artifact).not.toHaveProperty("blueprint_digest");
      const submitted = submitAutomaticBuildExecutorCandidateV3({
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: started.generation.action.opaque_session_ref,
        candidate_sink_ref: started.generation.action.candidate_sink_ref,
        candidate: privateCandidateFor(started.task, String(index)),
      }, { now: `2026-08-08T07:00:1${index}.000Z` });
      expect(submitted).toEqual({
        version: "automatic_build_executor_session.v3",
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
    const failed = startPrivateV3GenerationForHandoff(
      failedRef,
      "2026-08-08T07:10:01.000Z",
    );
    const sibling = startPrivateV3GenerationForHandoff(
      siblingRef,
      "2026-08-08T07:10:02.000Z",
    );
    expect(failAutomaticBuildExecutorSession(failed.generation.action.opaque_session_ref, {
      diagnostic_code: "provider_unavailable",
      now: "2026-08-08T07:10:03.000Z",
    })).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "retryable_failure" },
    });
    expect(submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: sibling.generation.action.opaque_session_ref,
      candidate_sink_ref: sibling.generation.action.candidate_sink_ref,
      candidate: privateCandidateFor(sibling.task, "sibling"),
    }, { now: "2026-08-08T07:10:04.000Z" })).toEqual({
      version: "automatic_build_executor_session.v3",
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
    const retryFirst = startPrivateV3GenerationForHandoff(
      retryWave.action.executors[0].opaque_handoff_ref,
      "2026-08-08T07:10:05.000Z",
    );
    const retryResume = startPrivateV3GenerationForHandoff(
      retryWave.action.executors[0].opaque_handoff_ref,
      "2026-08-08T07:10:06.000Z",
    );
    expect(retryResume).toEqual(retryFirst);
    expect(submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: retryFirst.generation.action.opaque_session_ref,
      candidate_sink_ref: retryFirst.generation.action.candidate_sink_ref,
      candidate: privateCandidateFor(retryFirst.task, "retry"),
    }, { now: "2026-08-08T07:10:07.000Z" })).toEqual({
      version: "automatic_build_executor_session.v3",
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
