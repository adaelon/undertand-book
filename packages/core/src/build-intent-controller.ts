import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compileBuildMode,
  type BuildMode,
  type BuildPlanEstimateInputV1,
} from "./build-capability";
import {
  BuildDecisionRequestV2Z,
  canonicalBuildJson,
  computeBuildIntentDigest,
  transitionBuildIntent,
  transitionBuildPlan,
  validateBuildContentProfile,
  validateBuildIntentV1,
  validateBuildPlanV1,
  type BuildContentProfile,
  type BuildDecisionRequestV2,
  type BuildIntentV1,
  type BuildPlanBudgetV1,
  type BuildPlanV1,
} from "./build-intent";
import type { AutomaticBuildStageFreshnessInspectionV1 } from "./build-orchestrator";

const PlannerCandidateZ = z.object({
  version: z.literal("build_intent_planner_candidate.v1"),
  goal_kind: z.enum(["learn", "analyze", "compare", "write", "reference", "other"]),
  source_scope: z.object({
    whole_book: z.boolean(),
    lids: z.array(z.string()),
    sections: z.array(z.string()),
  }).strict(),
  desired_artifacts: z.array(z.enum([
    "timeline",
    "concept_map",
    "comparison_table",
    "argument_map",
  ])).min(1),
  usage_horizon: z.enum(["one_off", "project", "long_term"]),
}).strict();

export type BuildIntentPlannerCandidateV1 = z.infer<typeof PlannerCandidateZ>;

export interface BuildIntentTargetV1 {
  book_id: string;
  source_fingerprint: string;
  content_profile: BuildContentProfile;
  public_freshness: AutomaticBuildStageFreshnessInspectionV1[];
}

export interface DraftBuildIntentSelectionInput {
  mode: BuildMode;
  target: BuildIntentTargetV1;
  now: string;
  user_goal?: string;
  candidate?: unknown;
  budget?: BuildPlanBudgetV1;
  intent_id?: string;
  intent_revision?: number;
  plan_id?: string;
  plan_revision?: number;
  supersedes_intent_id?: string;
}

export interface BuildIntentSelectionV1 {
  version: "build_intent_selection.v1";
  mode: BuildMode;
  intent: BuildIntentV1 | null;
  intent_digest: string | null;
  plan: BuildPlanV1 | null;
  estimate_input: BuildPlanEstimateInputV1 | null;
  decision_request: BuildDecisionRequestV2 | null;
}

export interface RedactedBuildIntentSelectionV1 {
  version: "build_intent_status.v1";
  mode: BuildMode;
  intent: null | {
    intent_id: string;
    revision: number;
    status: BuildIntentV1["status"];
    intent_digest: string;
  };
  plan: null | {
    plan_id: string;
    revision: number;
    status: BuildPlanV1["status"];
    recipe_id: BuildPlanV1["recipe_id"];
    plan_digest: string;
  };
  decision_request: BuildDecisionRequestV2 | null;
}

export interface ReplannedBuildIntentSelectionV1 {
  version: "replanned_build_intent_selection.v1";
  previous: BuildIntentSelectionV1;
  current: BuildIntentSelectionV1;
}

export type LegacyBuildInvocation =
  | "explicit_full_build"
  | "book_open"
  | "book_import"
  | "book_resume";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalBuildJson(value), "utf8").digest("hex");
}

function stableIds(input: DraftBuildIntentSelectionInput, candidate?: BuildIntentPlannerCandidateV1) {
  const suffix = digest({
    mode: input.mode,
    target: input.target,
    user_goal: input.user_goal,
    candidate,
    intent_revision: input.intent_revision ?? 1,
    plan_revision: input.plan_revision ?? 1,
  }).slice(0, 16);
  return {
    intent_id: input.intent_id ?? `intent-${suffix}`,
    plan_id: input.plan_id ?? `plan-${suffix}`,
  };
}

function decisionFor(plan: BuildPlanV1): BuildDecisionRequestV2 {
  return BuildDecisionRequestV2Z.parse({
    version: "build_decision_request.v2",
    decision_id: `decision-${plan.plan_digest.slice(0, 16)}`,
    scope: { kind: "build_plan", plan_id: plan.plan_id, plan_digest: plan.plan_digest },
    kind: "build_intent_plan",
    options: [
      { id: "confirm", label: "Confirm plan" },
      { id: "reject", label: "Keep reading" },
    ],
    status: "pending",
  });
}

export function validateBuildIntentPlannerCandidate(input: unknown): BuildIntentPlannerCandidateV1 {
  const candidate = PlannerCandidateZ.parse(input);
  if (new Set(candidate.desired_artifacts).size !== candidate.desired_artifacts.length) {
    throw new Error("planner candidate contains a duplicate artifact capability");
  }
  return candidate;
}

export function draftBuildIntentSelection(input: DraftBuildIntentSelectionInput): BuildIntentSelectionV1 {
  const profile = validateBuildContentProfile(input.target.content_profile);
  if (!input.target.book_id.trim() || !input.target.source_fingerprint.trim()) {
    throw new Error("build intent target identity must not be blank");
  }
  if (input.mode === "read_now") {
    compileBuildMode({
      mode: "read_now",
      book_id: input.target.book_id,
      source_fingerprint: input.target.source_fingerprint,
      content_profile: profile,
      plan_id: input.plan_id ?? "read-now",
      revision: input.plan_revision ?? 1,
      created_at: input.now,
      budget: input.budget ?? { on_exceed: "needs_user" },
      public_freshness: input.target.public_freshness,
    });
    return {
      version: "build_intent_selection.v1",
      mode: "read_now",
      intent: null,
      intent_digest: null,
      plan: null,
      estimate_input: null,
      decision_request: null,
    };
  }

  const candidate = input.mode === "goal_directed"
    ? validateBuildIntentPlannerCandidate(input.candidate)
    : undefined;
  const ids = stableIds(input, candidate);
  let intent: BuildIntentV1 | undefined;
  if (input.mode === "goal_directed") {
    const goal = input.user_goal?.trim();
    if (!goal) throw new Error("goal_directed mode requires a non-blank user goal");
    intent = validateBuildIntentV1({
      version: "build_intent.v1",
      intent_id: ids.intent_id,
      revision: input.intent_revision ?? 1,
      book_id: input.target.book_id,
      source_fingerprint: input.target.source_fingerprint,
      content_profile: profile,
      user_goal: goal,
      goal_kind: candidate!.goal_kind,
      source_scope: candidate!.source_scope,
      desired_artifacts: candidate!.desired_artifacts,
      usage_horizon: candidate!.usage_horizon,
      privacy: "reader_private",
      status: "draft",
      created_at: input.now,
      ...(input.supersedes_intent_id ? { supersedes_intent_id: input.supersedes_intent_id } : {}),
    });
  }
  const compilation = compileBuildMode({
    mode: input.mode,
    book_id: input.target.book_id,
    source_fingerprint: input.target.source_fingerprint,
    content_profile: profile,
    plan_id: ids.plan_id,
    revision: input.plan_revision ?? 1,
    created_at: input.now,
    budget: input.budget ?? { on_exceed: "needs_user" },
    public_freshness: input.target.public_freshness,
    ...(intent ? { intent } : {}),
  });
  const plan = validateBuildPlanV1(compilation.plan);
  return {
    version: "build_intent_selection.v1",
    mode: input.mode,
    intent: intent ?? null,
    intent_digest: intent ? computeBuildIntentDigest(intent) : null,
    plan,
    estimate_input: compilation.estimate_input ?? null,
    decision_request: decisionFor(plan),
  };
}

export function confirmBuildIntentSelection(
  input: BuildIntentSelectionV1,
  confirmation: {
    plan_id: string;
    plan_digest: string;
    at: string;
    confirmation_source: BuildPlanV1["confirmation_source"];
  },
): BuildIntentSelectionV1 {
  if (!input.plan) throw new Error("read_now has no BuildPlan to confirm");
  const plan = validateBuildPlanV1(input.plan);
  if (confirmation.plan_id !== plan.plan_id || confirmation.plan_digest !== plan.plan_digest) {
    throw new Error("confirmation plan id or digest does not match the current draft");
  }
  if (!confirmation.confirmation_source) throw new Error("confirmation source is required");
  const intent = input.intent
    ? transitionBuildIntent(input.intent, "confirmed", { at: confirmation.at })
    : null;
  const confirmedPlan = transitionBuildPlan(plan, "confirmed", {
    at: confirmation.at,
    confirmation_source: confirmation.confirmation_source,
  });
  return {
    ...input,
    intent,
    plan: confirmedPlan,
    decision_request: input.decision_request
      ? BuildDecisionRequestV2Z.parse({ ...input.decision_request, status: "answered" })
      : null,
  };
}

export function rejectBuildIntentSelection(input: BuildIntentSelectionV1): BuildIntentSelectionV1 {
  return {
    ...input,
    intent: input.intent ? transitionBuildIntent(input.intent, "superseded") : null,
    plan: input.plan ? transitionBuildPlan(input.plan, "superseded") : null,
    decision_request: input.decision_request
      ? BuildDecisionRequestV2Z.parse({ ...input.decision_request, status: "answered" })
      : null,
  };
}

function transitionSelectionLifecycle(
  input: BuildIntentSelectionV1,
  status: "superseded" | "stale_source",
): BuildIntentSelectionV1 {
  if (!input.plan) throw new Error("read_now has no BuildPlan lifecycle to transition");
  return {
    ...input,
    intent: input.intent ? transitionBuildIntent(input.intent, status) : null,
    plan: transitionBuildPlan(input.plan, status),
    decision_request: input.decision_request
      ? BuildDecisionRequestV2Z.parse({ ...input.decision_request, status: "answered" })
      : null,
  };
}

export function supersedeBuildIntentSelection(input: BuildIntentSelectionV1): BuildIntentSelectionV1 {
  return transitionSelectionLifecycle(input, "superseded");
}

export function markBuildIntentSelectionStale(input: BuildIntentSelectionV1): BuildIntentSelectionV1 {
  return transitionSelectionLifecycle(input, "stale_source");
}

export function replanBuildIntentSelection(
  previousInput: BuildIntentSelectionV1,
  nextInput: DraftBuildIntentSelectionInput,
): ReplannedBuildIntentSelectionV1 {
  if (!previousInput.plan) throw new Error("replan requires a prior BuildPlan");
  const previousPlan = validateBuildPlanV1(previousInput.plan);
  if (!(["confirmed", "completed"] as string[]).includes(previousPlan.status)) {
    throw new Error("replan requires a confirmed or completed prior BuildPlan");
  }
  if (previousPlan.book_id !== nextInput.target.book_id) {
    throw new Error("replan cannot move a selection between books");
  }
  const sourceChanged = previousPlan.source_fingerprint !== nextInput.target.source_fingerprint;
  const previous = sourceChanged
    ? markBuildIntentSelectionStale(previousInput)
    : supersedeBuildIntentSelection(previousInput);
  const current = draftBuildIntentSelection({
    ...nextInput,
    intent_revision: nextInput.intent_revision ?? ((previousInput.intent?.revision ?? 0) + 1),
    plan_revision: nextInput.plan_revision ?? (previousPlan.revision + 1),
    ...(nextInput.mode === "goal_directed" && previousInput.intent
      ? { supersedes_intent_id: previousInput.intent.intent_id }
      : {}),
  });
  return { version: "replanned_build_intent_selection.v1", previous, current };
}

export function mapLegacyBuildInvocation(input: {
  invocation: LegacyBuildInvocation;
  target: BuildIntentTargetV1;
  now: string;
  budget?: BuildPlanBudgetV1;
}): BuildIntentSelectionV1 | null {
  if (input.invocation !== "explicit_full_build") return null;
  const draft = draftBuildIntentSelection({
    mode: "standard_deep",
    target: input.target,
    now: input.now,
    ...(input.budget ? { budget: input.budget } : {}),
  });
  return confirmBuildIntentSelection(draft, {
    plan_id: draft.plan!.plan_id,
    plan_digest: draft.plan!.plan_digest,
    at: input.now,
    confirmation_source: "explicit_legacy_command",
  });
}

export function redactBuildIntentSelection(input: BuildIntentSelectionV1): RedactedBuildIntentSelectionV1 {
  const intent = input.intent ? validateBuildIntentV1(input.intent) : null;
  const plan = input.plan ? validateBuildPlanV1(input.plan) : null;
  return {
    version: "build_intent_status.v1",
    mode: input.mode,
    intent: intent ? {
      intent_id: intent.intent_id,
      revision: intent.revision,
      status: intent.status,
      intent_digest: computeBuildIntentDigest(intent),
    } : null,
    plan: plan ? {
      plan_id: plan.plan_id,
      revision: plan.revision,
      status: plan.status,
      recipe_id: plan.recipe_id,
      plan_digest: plan.plan_digest,
    } : null,
    decision_request: input.decision_request,
  };
}
