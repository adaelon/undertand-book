import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compileBuildMode,
  compileBuildModeV3,
  type BuildMode,
  type Pass2PlanChoice,
  type BuildPlanEstimateInputV1,
  type BuildPlanEstimateInputV2,
  type BuildPlanEstimateInputV3,
} from "./build-capability";
import type {
  ArtifactBlueprintResolutionV1,
  ArtifactBlueprintResolutionV2,
} from "./artifact-blueprint-registry";
import {
  BuildDecisionRequestV2Z,
  BuildDecisionRequestV3Z,
  canonicalBuildJson,
  computeBuildIntentDigest,
  transitionBuildIntent,
  transitionBuildPlan,
  validateBuildContentProfile,
  validateBuildIntentV1,
  validateBuildPlanV1,
  type BuildContentProfile,
  type BuildDecisionRequestV2,
  type BuildDecisionRequestV3,
  type BuildIntentV1,
  type BuildPlanBudgetV1,
  type BuildPlanV1,
} from "./build-intent";
import {
  computeBuildIntentDigestAny,
  computeBuildIntentDigestV2,
  summarizeBuildPlanPrivateArtifactV3,
  summarizeBuildPlanPrivateArtifactV2,
  transitionBuildIntentV2,
  transitionBuildIntentV3,
  transitionBuildPlanV2,
  transitionBuildPlanV3,
  validateBuildIntentAny,
  validateBuildIntentV2,
  validateBuildIntentV3,
  validateBuildPlanAny,
  validateBuildPlanV2,
  validateBuildPlanV3,
  type ArtifactBlueprintPlanSummaryV1,
  type ArtifactBlueprintPlanSummaryV2,
  type BuildIntentAny,
  type BuildIntentV2,
  type BuildIntentV3,
  type BuildPlanAny,
  type BuildPlanV2,
  type BuildPlanV3,
} from "./build-intent-v2";
import type { AutomaticBuildStageFreshnessInspectionV1 } from "./build-orchestrator";

const PlannerArtifactCandidateV2Z = z.object({
  source: z.enum(["system", "user_private", "one_off"]),
  blueprint_id: z.string(),
  blueprint_version: z.string(),
  blueprint: z.unknown().optional(),
}).strict().superRefine((artifact, context) => {
  if (artifact.source === "one_off" && artifact.blueprint === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blueprint"], message: "one_off selection requires a Blueprint draft" });
  }
  if (artifact.source !== "one_off" && artifact.blueprint !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blueprint"], message: "registry selection cannot replace the stored Blueprint snapshot" });
  }
});

export const BuildIntentPlannerCandidateV2Z = z.object({
  version: z.literal("build_intent_planner_candidate.v2"),
  goal_kind: z.enum(["learn", "analyze", "compare", "write", "reference", "other"]),
  source_scope: z.object({
    whole_book: z.boolean(),
    lids: z.array(z.string()),
    sections: z.array(z.string()),
  }).strict(),
  artifacts: z.array(PlannerArtifactCandidateV2Z).max(16),
  usage_horizon: z.enum(["one_off", "project", "long_term"]),
}).strict();

export type BuildIntentPlannerCandidateV2 = z.infer<typeof BuildIntentPlannerCandidateV2Z>;

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
  resolved_blueprints?: ArtifactBlueprintResolutionV2[];
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

export interface BuildIntentSelectionV2 {
  version: "build_intent_selection.v2";
  mode: BuildMode;
  intent: BuildIntentV2 | null;
  intent_digest: string | null;
  plan: BuildPlanV2 | null;
  estimate_input: BuildPlanEstimateInputV2 | null;
  decision_request: BuildDecisionRequestV2 | null;
}

export interface BuildIntentSelectionV3 {
  version: "build_intent_selection.v3";
  mode: BuildMode;
  intent: BuildIntentV3 | null;
  plan: BuildPlanV3 | null;
  estimate_input: BuildPlanEstimateInputV3 | null;
  decision_request: BuildDecisionRequestV3 | null;
}

export type BuildIntentSelection = BuildIntentSelectionV1 | BuildIntentSelectionV2 | BuildIntentSelectionV3;

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

export interface CodexBuildIntentPlanV1 {
  version: "codex_build_intent_plan.v1";
  mode: BuildMode;
  intent: null | {
    intent_id: string;
    revision: number;
    status: BuildIntentV1["status"];
    intent_digest: string;
    goal_kind: BuildIntentV1["goal_kind"];
    source_scope: BuildIntentV1["source_scope"];
    desired_artifacts: BuildIntentV1["desired_artifacts"];
    usage_horizon: BuildIntentV1["usage_horizon"];
  };
  plan: BuildPlanV1 | null;
  decision_request: BuildDecisionRequestV2 | null;
}

export interface CodexBuildIntentPlanV2 {
  version: "codex_build_intent_plan.v2";
  mode: BuildMode;
  intent: null | {
    intent_id: string;
    revision: number;
    status: BuildIntentV2["status"];
    intent_digest: string;
    goal_kind: BuildIntentV2["goal_kind"];
    source_scope: BuildIntentV2["source_scope"];
    usage_horizon: BuildIntentV2["usage_horizon"];
  };
  plan: null | Omit<BuildPlanV2, "private_artifacts"> & {
    private_artifacts: never[];
    artifact_summaries: ArtifactBlueprintPlanSummaryV1[];
  };
  decision_request: BuildDecisionRequestV2 | null;
}

export interface RedactedBuildIntentSelectionV2 {
  version: "build_intent_status.v2";
  mode: BuildMode;
  intent: null | {
    intent_id: string;
    intent_revision: number;
    status: BuildIntentV3["status"];
  };
  plan: null | {
    plan_id: string;
    plan_revision: number;
    status: BuildPlanV3["status"];
    recipe_id: BuildPlanV3["recipe_id"];
  };
  decision_request: BuildDecisionRequestV3 | null;
}

export interface CodexBuildIntentPlanV3 {
  version: "codex_build_intent_plan.v3";
  mode: BuildMode;
  intent: null | {
    intent_id: string;
    intent_revision: number;
    status: BuildIntentV3["status"];
    goal_kind: BuildIntentV3["goal_kind"];
    source_scope: BuildIntentV3["source_scope"];
    usage_horizon: BuildIntentV3["usage_horizon"];
  };
  plan: null | Omit<BuildPlanV3, "private_artifacts"> & {
    private_artifacts: never[];
    artifact_summaries: ArtifactBlueprintPlanSummaryV2[];
  };
  decision_request: BuildDecisionRequestV3 | null;
}

export interface ReplannedBuildIntentSelectionV2 {
  version: "replanned_build_intent_selection.v3";
  previous: BuildIntentSelection;
  current: BuildIntentSelectionV3;
}

export type LegacyBuildInvocation =
  | "explicit_full_build"
  | "book_open"
  | "book_import"
  | "book_resume";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalBuildJson(value), "utf8").digest("hex");
}

function legacyStableIds(input: DraftBuildIntentSelectionInput, candidate?: BuildIntentPlannerCandidateV2) {
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

function decisionForLegacy(plan: BuildPlanV1 | BuildPlanV2): BuildDecisionRequestV2 {
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

function decisionForV3(plan: BuildPlanV3): BuildDecisionRequestV3 {
  return BuildDecisionRequestV3Z.parse({
    version: "build_decision_request.v3",
    decision_id: `decision-${plan.plan_id}-r${plan.plan_revision}`,
    scope: {
      kind: "build_plan",
      plan_id: plan.plan_id,
      plan_revision: plan.plan_revision,
    },
    kind: "build_intent_plan",
    options: [
      { id: "confirm", label: "Confirm plan" },
      { id: "reject", label: "Keep reading" },
    ],
    status: "pending",
  });
}

export function validateBuildIntentPlannerCandidate(input: unknown): BuildIntentPlannerCandidateV2 {
  const candidate = BuildIntentPlannerCandidateV2Z.parse(input);
  const identities = candidate.artifacts.map((artifact) => `${artifact.blueprint_id}\u0000${artifact.blueprint_version}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("planner candidate contains a duplicate ArtifactBlueprint identity and version");
  }
  return candidate;
}

function validateResolvedBlueprints(
  candidate: BuildIntentPlannerCandidateV2,
  resolutions: readonly ArtifactBlueprintResolutionV2[],
): ArtifactBlueprintResolutionV2[] {
  if (resolutions.length !== candidate.artifacts.length) {
    throw new Error("ArtifactBlueprint resolution count does not match the planner candidate");
  }
  return resolutions.map((resolution, index) => {
    const selected = candidate.artifacts[index];
    if (resolution.source !== selected.source
      || resolution.blueprint_id !== selected.blueprint_id
      || resolution.blueprint_version !== selected.blueprint_version
      || resolution.blueprint.blueprint_id !== resolution.blueprint_id
      || resolution.blueprint.blueprint_version !== resolution.blueprint_version) {
      throw new Error("ArtifactBlueprint resolution identity does not match the planner candidate");
    }
    if (selected.source === "one_off"
      && canonicalBuildJson(selected.blueprint) !== canonicalBuildJson(resolution.blueprint)) {
      throw new Error("one-off ArtifactBlueprint resolution drifted from the planner draft");
    }
    return resolution;
  });
}

export function draftBuildIntentSelection(input: DraftBuildIntentSelectionInput): BuildIntentSelectionV3 {
  const profile = validateBuildContentProfile(input.target.content_profile);
  if (!input.target.book_id.trim() || !input.target.source_fingerprint.trim()) {
    throw new Error("build intent target identity must not be blank");
  }
  if (input.mode === "read_now") {
    compileBuildModeV3({
      mode: "read_now",
      book_id: input.target.book_id,
      source_fingerprint: input.target.source_fingerprint,
      content_profile: profile,
      plan_id: input.plan_id ?? "read-now",
      plan_revision: input.plan_revision ?? 1,
      created_at: input.now,
      budget: input.budget ?? { on_exceed: "needs_user" },
      public_freshness: input.target.public_freshness,
    });
    return {
      version: "build_intent_selection.v3",
      mode: "read_now",
      intent: null,
      plan: null,
      estimate_input: null,
      decision_request: null,
    };
  }

  const candidate = input.mode === "goal_directed"
    ? validateBuildIntentPlannerCandidate(input.candidate)
    : undefined;
  if (!input.plan_id || !input.plan_revision) {
    throw new Error("BuildPlan id and revision must be issued by the owning store");
  }
  if (input.mode === "goal_directed" && (!input.intent_id || !input.intent_revision)) {
    throw new Error("BuildIntent id and revision must be issued by the owning store");
  }
  let intent: BuildIntentV3 | undefined;
  if (input.mode === "goal_directed") {
    const goal = input.user_goal?.trim();
    if (!goal) throw new Error("goal_directed mode requires a non-blank user goal");
    intent = validateBuildIntentV3({
      version: "build_intent.v3",
      intent_id: input.intent_id,
      intent_revision: input.intent_revision,
      book_id: input.target.book_id,
      source_fingerprint: input.target.source_fingerprint,
      content_profile: profile,
      user_goal: goal,
      goal_kind: candidate!.goal_kind,
      source_scope: candidate!.source_scope,
      usage_horizon: candidate!.usage_horizon,
      privacy: "reader_private",
      status: "draft",
      created_at: input.now,
      ...(input.supersedes_intent_id ? { supersedes_intent_id: input.supersedes_intent_id } : {}),
    });
  }
  const resolvedBlueprints = candidate
    ? validateResolvedBlueprints(candidate, input.resolved_blueprints ?? [])
    : [];
  const compilation = compileBuildModeV3({
    mode: input.mode,
    book_id: input.target.book_id,
    source_fingerprint: input.target.source_fingerprint,
    content_profile: profile,
    plan_id: input.plan_id,
    plan_revision: input.plan_revision,
    created_at: input.now,
    budget: input.budget ?? { on_exceed: "needs_user" },
    public_freshness: input.target.public_freshness,
    ...(intent ? { intent } : {}),
    ...(candidate ? { selected_blueprints: resolvedBlueprints } : {}),
  });
  const plan = validateBuildPlanV3(compilation.plan);
  return {
    version: "build_intent_selection.v3",
    mode: input.mode,
    intent: intent ?? null,
    plan,
    estimate_input: compilation.estimate_input ?? null,
    decision_request: decisionForV3(plan),
  };
}

export function confirmBuildIntentSelection(
  input: BuildIntentSelectionV3,
  confirmation: {
    plan_id: string;
    plan_revision: number;
    at: string;
    confirmation_source: BuildPlanV3["confirmation_source"];
  },
): BuildIntentSelectionV3 {
  if (!input.plan) throw new Error("read_now has no BuildPlan to confirm");
  const plan = validateBuildPlanV3(input.plan);
  if (confirmation.plan_id !== plan.plan_id || confirmation.plan_revision !== plan.plan_revision) {
    throw new Error("confirmation plan id or revision does not match the current draft");
  }
  if (!confirmation.confirmation_source) throw new Error("confirmation source is required");
  const intent = input.intent
    ? transitionBuildIntentV3(input.intent, "confirmed", { at: confirmation.at })
    : null;
  const confirmedPlan = transitionBuildPlanV3(plan, "confirmed", {
    at: confirmation.at,
    confirmation_source: confirmation.confirmation_source,
  });
  return {
    ...input,
    intent,
    plan: confirmedPlan,
    decision_request: input.decision_request
      ? BuildDecisionRequestV3Z.parse({ ...input.decision_request, status: "answered" })
      : null,
  };
}

function transitionIntent(
  input: BuildIntentAny,
  status: "superseded" | "stale_source",
): BuildIntentAny {
  if (input.version === "build_intent.v3") return transitionBuildIntentV3(input, status);
  return input.version === "build_intent.v2"
    ? transitionBuildIntentV2(input, status)
    : transitionBuildIntent(input, status);
}

function transitionPlan(
  input: BuildPlanAny,
  status: "superseded" | "stale_source",
): BuildPlanAny {
  if (input.version === "build_plan.v3") return transitionBuildPlanV3(input, status);
  return input.version === "build_plan.v2"
    ? transitionBuildPlanV2(input, status)
    : transitionBuildPlan(input, status);
}

export function rejectBuildIntentSelection(input: BuildIntentSelection): BuildIntentSelection {
  return {
    ...input,
    intent: input.intent ? transitionIntent(input.intent, "superseded") : null,
    plan: input.plan ? transitionPlan(input.plan, "superseded") : null,
    decision_request: input.decision_request
      ? input.decision_request.version === "build_decision_request.v3"
        ? BuildDecisionRequestV3Z.parse({ ...input.decision_request, status: "answered" })
        : BuildDecisionRequestV2Z.parse({ ...input.decision_request, status: "answered" })
      : null,
  } as BuildIntentSelection;
}

function transitionSelectionLifecycle(
  input: BuildIntentSelection,
  status: "superseded" | "stale_source",
): BuildIntentSelection {
  if (!input.plan) throw new Error("read_now has no BuildPlan lifecycle to transition");
  return {
    ...input,
    intent: input.intent ? transitionIntent(input.intent, status) : null,
    plan: transitionPlan(input.plan, status),
    decision_request: input.decision_request
      ? input.decision_request.version === "build_decision_request.v3"
        ? BuildDecisionRequestV3Z.parse({ ...input.decision_request, status: "answered" })
        : BuildDecisionRequestV2Z.parse({ ...input.decision_request, status: "answered" })
      : null,
  } as BuildIntentSelection;
}

export function supersedeBuildIntentSelection(input: BuildIntentSelection): BuildIntentSelection {
  return transitionSelectionLifecycle(input, "superseded");
}

export function markBuildIntentSelectionStale(input: BuildIntentSelection): BuildIntentSelection {
  return transitionSelectionLifecycle(input, "stale_source");
}

export function replanBuildIntentSelection(
  previousInput: BuildIntentSelection,
  nextInput: DraftBuildIntentSelectionInput,
): ReplannedBuildIntentSelectionV2 {
  if (!previousInput.plan) throw new Error("replan requires a prior BuildPlan");
  const previousPlan = validateBuildPlanAny(previousInput.plan);
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
    intent_revision: nextInput.intent_revision ?? (
      previousInput.intent?.version === "build_intent.v3"
        ? previousInput.intent.intent_revision + 1
        : (previousInput.intent?.revision ?? 0) + 1
    ),
    plan_revision: nextInput.plan_revision ?? (
      previousPlan.version === "build_plan.v3"
        ? previousPlan.plan_revision + 1
        : previousPlan.revision + 1
    ),
    ...(nextInput.mode === "goal_directed" && previousInput.intent
      ? { supersedes_intent_id: previousInput.intent.intent_id }
      : {}),
  });
  return { version: "replanned_build_intent_selection.v3", previous, current };
}

export function mapLegacyBuildInvocation(input: {
  invocation: LegacyBuildInvocation;
  target: BuildIntentTargetV1;
  now: string;
  budget?: BuildPlanBudgetV1;
  pass2?: Pass2PlanChoice;
}): BuildIntentSelectionV1 | null {
  if (input.invocation !== "explicit_full_build") return null;
  const draftInput: DraftBuildIntentSelectionInput = {
    mode: "standard_deep",
    target: input.target,
    now: input.now,
    ...(input.budget ? { budget: input.budget } : {}),
  };
  const ids = legacyStableIds(draftInput);
  const compilation = compileBuildMode({
    mode: "standard_deep",
    book_id: input.target.book_id,
    source_fingerprint: input.target.source_fingerprint,
    content_profile: input.target.content_profile,
    plan_id: ids.plan_id,
    revision: 1,
    created_at: input.now,
    budget: input.budget ?? { on_exceed: "needs_user" },
    ...(input.pass2 ? { pass2: input.pass2 } : {}),
    public_freshness: input.target.public_freshness,
  });
  const plan = validateBuildPlanV1(compilation.plan);
  const draft: BuildIntentSelectionV1 = {
    version: "build_intent_selection.v1",
    mode: "standard_deep",
    intent: null,
    intent_digest: null,
    plan,
    estimate_input: compilation.estimate_input ?? null,
    decision_request: decisionForLegacy(plan),
  };
  return {
    ...draft,
    plan: transitionBuildPlan(plan, "confirmed", {
      at: input.now,
      confirmation_source: "explicit_legacy_command",
    }),
    decision_request: draft.decision_request
      ? BuildDecisionRequestV2Z.parse({ ...draft.decision_request, status: "answered" })
      : null,
  };
}

export function redactBuildIntentSelection(
  input: BuildIntentSelection,
): RedactedBuildIntentSelectionV1 | RedactedBuildIntentSelectionV2 {
  const intent = input.intent ? validateBuildIntentAny(input.intent) : null;
  const plan = input.plan ? validateBuildPlanAny(input.plan) : null;
  if (input.version === "build_intent_selection.v3") {
    const v3Intent = intent?.version === "build_intent.v3" ? intent : null;
    const v3Plan = plan?.version === "build_plan.v3" ? plan : null;
    return {
      version: "build_intent_status.v2",
      mode: input.mode,
      intent: v3Intent ? {
        intent_id: v3Intent.intent_id,
        intent_revision: v3Intent.intent_revision,
        status: v3Intent.status,
      } : null,
      plan: v3Plan ? {
        plan_id: v3Plan.plan_id,
        plan_revision: v3Plan.plan_revision,
        status: v3Plan.status,
        recipe_id: v3Plan.recipe_id,
      } : null,
      decision_request: input.decision_request,
    };
  }
  const legacyIntent = intent?.version === "build_intent.v3" ? null : intent;
  const legacyPlan = plan?.version === "build_plan.v3" ? null : plan;
  return {
    version: "build_intent_status.v1",
    mode: input.mode,
    intent: legacyIntent ? {
      intent_id: legacyIntent.intent_id,
      revision: legacyIntent.revision,
      status: legacyIntent.status,
      intent_digest: computeBuildIntentDigestAny(legacyIntent),
    } : null,
    plan: legacyPlan ? {
      plan_id: legacyPlan.plan_id,
      revision: legacyPlan.revision,
      status: legacyPlan.status,
      recipe_id: legacyPlan.recipe_id,
      plan_digest: legacyPlan.plan_digest,
    } : null,
    decision_request: input.decision_request,
  };
}

export function projectCodexBuildIntentSelection(
  input: BuildIntentSelection,
): CodexBuildIntentPlanV1 | CodexBuildIntentPlanV2 | CodexBuildIntentPlanV3 {
  const intent = input.intent ? validateBuildIntentAny(input.intent) : null;
  const plan = input.plan ? validateBuildPlanAny(input.plan) : null;
  if (plan?.version === "build_plan.v3" || intent?.version === "build_intent.v3") {
    const v3Intent = intent?.version === "build_intent.v3" ? intent : null;
    const v3Plan = plan?.version === "build_plan.v3" ? plan : null;
    const projectedPlan = v3Plan
      ? {
          ...v3Plan,
          private_artifacts: [] as never[],
          artifact_summaries: v3Plan.private_artifacts.map(summarizeBuildPlanPrivateArtifactV3),
        }
      : null;
    return {
      version: "codex_build_intent_plan.v3",
      mode: input.mode,
      intent: v3Intent ? {
        intent_id: v3Intent.intent_id,
        intent_revision: v3Intent.intent_revision,
        status: v3Intent.status,
        goal_kind: v3Intent.goal_kind,
        source_scope: v3Intent.source_scope,
        usage_horizon: v3Intent.usage_horizon,
      } : null,
      plan: projectedPlan,
      decision_request: input.version === "build_intent_selection.v3" ? input.decision_request : null,
    };
  }
  if (plan?.version === "build_plan.v2" || intent?.version === "build_intent.v2") {
    const v2Intent = intent?.version === "build_intent.v2" ? intent : null;
    const v2Plan = plan?.version === "build_plan.v2" ? plan : null;
    const projectedPlan = v2Plan
      ? {
          ...v2Plan,
          private_artifacts: [] as never[],
          artifact_summaries: v2Plan.private_artifacts.map(summarizeBuildPlanPrivateArtifactV2),
        }
      : null;
    return {
      version: "codex_build_intent_plan.v2",
      mode: input.mode,
      intent: v2Intent ? {
        intent_id: v2Intent.intent_id,
        revision: v2Intent.revision,
        status: v2Intent.status,
        intent_digest: computeBuildIntentDigestV2(v2Intent),
        goal_kind: v2Intent.goal_kind,
        source_scope: v2Intent.source_scope,
        usage_horizon: v2Intent.usage_horizon,
      } : null,
      plan: projectedPlan,
      decision_request: input.version === "build_intent_selection.v2"
        ? input.decision_request
        : null,
    };
  }
  const v1Intent = intent?.version === "build_intent.v1" ? intent : null;
  const v1Plan = plan?.version === "build_plan.v1" ? plan : null;
  return {
    version: "codex_build_intent_plan.v1",
    mode: input.mode,
    intent: v1Intent ? {
      intent_id: v1Intent.intent_id,
      revision: v1Intent.revision,
      status: v1Intent.status,
      intent_digest: computeBuildIntentDigest(v1Intent),
      goal_kind: v1Intent.goal_kind,
      source_scope: v1Intent.source_scope,
      desired_artifacts: v1Intent.desired_artifacts,
      usage_horizon: v1Intent.usage_horizon,
    } : null,
    plan: v1Plan,
    decision_request: input.version === "build_intent_selection.v1"
      ? input.decision_request
      : null,
  };
}
