import { createHash } from "node:crypto";
import { z } from "zod";
import type { BuildDecisionKind, BuildStageId } from "./build-workbench";

const BUILD_INTENT_STATUSES = ["draft", "confirmed", "superseded", "stale_source", "deleted"] as const;
const BUILD_PLAN_STATUSES = ["draft", "confirmed", "superseded", "stale_source", "completed"] as const;
const BUILD_RECIPE_IDS = ["standard_deep", "goal_directed"] as const;
const INTENT_ARTIFACT_TYPES = ["timeline", "concept_map", "comparison_table", "argument_map", "custom"] as const;
const BUILD_GOAL_KINDS = ["learn", "analyze", "compare", "write", "reference", "other"] as const;
const BUILD_USAGE_HORIZONS = ["one_off", "project", "long_term"] as const;
const BUILD_STAGE_IDS = [
  "source_reconciliation",
  "hybrid_foundation",
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
] as const satisfies readonly BuildStageId[];
const EXISTING_BUILD_DECISION_KINDS = [
  "source_reconciliation_mode",
  "hybrid_source_strategy",
  "alignment_repair_strategy",
  "executor_selection",
  "sidecar_plan",
] as const satisfies readonly BuildDecisionKind[];

const PATH_SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const LID = /^\d+(?:\.\d+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function stableJson(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => {
      if (item === undefined) throw new Error(`${path}[${index}] contains undefined`);
      return stableJson(item, `${path}[${index}]`);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], `${path}.${key}`)}`)
      .join(",")}}`;
  }
  throw new Error(`${path} contains a non-JSON value`);
}

export function canonicalBuildJson(value: unknown): string {
  return stableJson(value, "$build");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isPathSafeBuildId(value: string): boolean {
  if (value.length < 1 || value.length > 128 || !PATH_SAFE_ID.test(value)) return false;
  return !WINDOWS_RESERVED_NAME.test(value.split(".", 1)[0]);
}

export function validatePathSafeBuildId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !isPathSafeBuildId(value)) {
    throw new Error(`${field} must be a path-safe ASCII id`);
  }
  return value;
}

const PathSafeBuildIdZ = z.string().min(1).max(128)
  .refine(isPathSafeBuildId, "must be a path-safe ASCII id");
const NonBlankStringZ = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const Sha256Z = z.string().regex(SHA256, "must be a lowercase SHA-256 digest");
const IsoDateTimeZ = z.string().datetime({ offset: true });
const SafeRevisionZ = z.number().int().positive().safe();
const NonNegativeSafeIntegerZ = z.number().int().nonnegative().safe();
const NonNegativeFiniteZ = z.number().finite().nonnegative();
const CoverageZ = z.number().finite().min(0).max(1);
const LidZ = z.string().regex(LID, "LID must be a numeric materialized path");

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: Array<string | number>,
  label: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message: `duplicate ${label}: ${value}` });
    }
    seen.add(value);
  });
}

const BuildSourceScopeShapeZ = z.object({
  whole_book: z.boolean(),
  lids: z.array(LidZ),
  sections: z.array(NonBlankStringZ),
}).strict();

export const BuildSourceScopeZ = BuildSourceScopeShapeZ.superRefine((scope, context) => {
  addDuplicateIssues(scope.lids, context, ["lids"], "LID");
  addDuplicateIssues(scope.sections, context, ["sections"], "section");
  if (scope.whole_book && (scope.lids.length || scope.sections.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "whole-book source scope cannot also select LIDs or sections" });
  }
  if (!scope.whole_book && !scope.lids.length && !scope.sections.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "source scope requires at least one LID or section" });
  }
});

export type BuildSourceScope = z.infer<typeof BuildSourceScopeZ>;

export function validateBuildSourceScope(input: unknown): BuildSourceScope {
  return BuildSourceScopeZ.parse(input);
}

export const BuildContentProfileZ = z.discriminatedUnion("id", [
  z.object({ id: z.literal("technical_learning"), version: z.literal("technical_learning_v0") }).strict(),
  z.object({ id: z.literal("paper"), version: z.literal("paper_v0") }).strict(),
]);

export type BuildContentProfile = z.infer<typeof BuildContentProfileZ>;

export function validateBuildContentProfile(input: unknown): BuildContentProfile {
  return BuildContentProfileZ.parse(input);
}

export const BuildRecipeIdZ = z.enum(BUILD_RECIPE_IDS);
export type BuildRecipeId = z.infer<typeof BuildRecipeIdZ>;

export function validateBuildRecipeId(input: unknown): BuildRecipeId {
  return BuildRecipeIdZ.parse(input);
}

export const IntentArtifactTypeZ = z.enum(INTENT_ARTIFACT_TYPES);
export type IntentArtifactType = z.infer<typeof IntentArtifactTypeZ>;
export const BuildIntentStatusZ = z.enum(BUILD_INTENT_STATUSES);
export type BuildIntentStatus = z.infer<typeof BuildIntentStatusZ>;
export const BuildPlanStatusZ = z.enum(BUILD_PLAN_STATUSES);
export type BuildPlanStatus = z.infer<typeof BuildPlanStatusZ>;

export const BuildIntentV1Z = z.object({
  version: z.literal("build_intent.v1"),
  intent_id: PathSafeBuildIdZ,
  revision: SafeRevisionZ,
  book_id: PathSafeBuildIdZ,
  source_fingerprint: NonBlankStringZ,
  content_profile: BuildContentProfileZ,
  user_goal: NonBlankStringZ,
  goal_kind: z.enum(BUILD_GOAL_KINDS),
  source_scope: BuildSourceScopeZ,
  desired_artifacts: z.array(IntentArtifactTypeZ).min(1),
  usage_horizon: z.enum(BUILD_USAGE_HORIZONS),
  privacy: z.literal("reader_private"),
  status: BuildIntentStatusZ,
  created_at: IsoDateTimeZ,
  confirmed_at: IsoDateTimeZ.optional(),
  supersedes_intent_id: PathSafeBuildIdZ.optional(),
}).strict().superRefine((intent, context) => {
  addDuplicateIssues(intent.desired_artifacts, context, ["desired_artifacts"], "desired artifact");
  if (intent.intent_id === intent.supersedes_intent_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["supersedes_intent_id"], message: "intent cannot supersede itself" });
  }
  if (intent.status === "confirmed" && !intent.confirmed_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmed_at"], message: "confirmed intent requires confirmed_at" });
  }
  if (intent.status === "draft" && intent.confirmed_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmed_at"], message: "draft intent cannot have confirmed_at" });
  }
});

export type BuildIntentV1 = z.infer<typeof BuildIntentV1Z>;

export function validateBuildIntentV1(input: unknown): BuildIntentV1 {
  return BuildIntentV1Z.parse(input);
}

export function buildIntentIdentity(intent: BuildIntentV1): Omit<BuildIntentV1, "created_at" | "confirmed_at" | "status"> {
  const parsed = validateBuildIntentV1(intent);
  const { created_at: _createdAt, confirmed_at: _confirmedAt, status: _status, ...identity } = parsed;
  return identity;
}

export function computeBuildIntentDigest(intent: BuildIntentV1): string {
  return sha256(canonicalBuildJson(buildIntentIdentity(intent)));
}

const TokenEstimateRangeZ = z.object({
  lower: NonNegativeSafeIntegerZ,
  upper: NonNegativeSafeIntegerZ,
  coverage: CoverageZ,
}).strict().superRefine((range, context) => {
  if (range.lower > range.upper) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["upper"], message: "upper must be greater than or equal to lower" });
  }
});

export const BuildPlanEstimateV1Z = z.object({
  input_tokens: TokenEstimateRangeZ,
  output_tokens: TokenEstimateRangeZ,
  wall_clock_minutes: z.object({
    p50: NonNegativeFiniteZ.optional(),
    p95: NonNegativeFiniteZ.optional(),
    confidence: z.enum(["none", "low", "medium", "high"]),
  }).strict().superRefine((wall, context) => {
    if (wall.p50 !== undefined && wall.p95 !== undefined && wall.p50 > wall.p95) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["p95"], message: "p95 must be greater than or equal to p50" });
    }
  }),
  unknown_stages: z.array(NonBlankStringZ),
  historical_match: z.object({
    stage: z.boolean(),
    policy: z.boolean(),
    model: z.boolean(),
    harness: z.boolean(),
    sample_count: NonNegativeSafeIntegerZ,
  }).strict(),
}).strict().superRefine((estimate, context) => {
  addDuplicateIssues(estimate.unknown_stages, context, ["unknown_stages"], "unknown stage");
});

export type BuildPlanEstimateV1 = z.infer<typeof BuildPlanEstimateV1Z>;

export const BuildPlanBudgetV1Z = z.object({
  max_total_tokens: NonNegativeSafeIntegerZ.optional(),
  max_wall_clock_minutes: NonNegativeFiniteZ.optional(),
  on_exceed: z.literal("needs_user"),
}).strict();

export type BuildPlanBudgetV1 = z.infer<typeof BuildPlanBudgetV1Z>;

const PrivateIntentArtifactZ = z.object({
  artifact_id: PathSafeBuildIdZ,
  artifact_type: IntentArtifactTypeZ,
  source_scope: BuildSourceScopeZ,
  required_public_capabilities: z.array(NonBlankStringZ),
  evidence_policy: z.literal("lid_required"),
}).strict().superRefine((artifact, context) => {
  addDuplicateIssues(
    artifact.required_public_capabilities,
    context,
    ["required_public_capabilities"],
    "required public capability",
  );
});

const ReusedBuildArtifactZ = z.object({
  artifact: NonBlankStringZ,
  freshness_digest: Sha256Z,
}).strict();

const ExcludedBuildArtifactZ = z.object({
  artifact: NonBlankStringZ,
  reason: NonBlankStringZ,
}).strict();

const BuildPlanShapeZ = z.object({
  version: z.literal("build_plan.v1"),
  plan_id: PathSafeBuildIdZ,
  revision: SafeRevisionZ,
  book_id: PathSafeBuildIdZ,
  source_fingerprint: NonBlankStringZ,
  content_profile: BuildContentProfileZ,
  recipe_id: BuildRecipeIdZ,
  intent_id: PathSafeBuildIdZ.optional(),
  intent_digest: Sha256Z.optional(),
  public_stage_closure: z.array(NonBlankStringZ),
  private_artifacts: z.array(PrivateIntentArtifactZ),
  reuse: z.array(ReusedBuildArtifactZ),
  create: z.array(NonBlankStringZ),
  excluded: z.array(ExcludedBuildArtifactZ),
  estimate: BuildPlanEstimateV1Z,
  budget: BuildPlanBudgetV1Z,
  status: BuildPlanStatusZ,
  plan_digest: Sha256Z,
  confirmation_source: z.enum(["reader_ui", "codex_conversation", "explicit_legacy_command"]).optional(),
  created_at: IsoDateTimeZ,
  confirmed_at: IsoDateTimeZ.optional(),
}).strict();

export const BuildPlanV1Z = BuildPlanShapeZ.superRefine((plan, context) => {
  addDuplicateIssues(plan.public_stage_closure, context, ["public_stage_closure"], "public stage");
  addDuplicateIssues(plan.private_artifacts.map((artifact) => artifact.artifact_id), context, ["private_artifacts"], "artifact_id");
  addDuplicateIssues(plan.reuse.map((artifact) => artifact.artifact), context, ["reuse"], "reused artifact");
  addDuplicateIssues(plan.create, context, ["create"], "created artifact");
  addDuplicateIssues(plan.excluded.map((artifact) => artifact.artifact), context, ["excluded"], "excluded artifact");

  if (plan.recipe_id === "goal_directed") {
    if (!plan.intent_id || !plan.intent_digest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["intent_id"], message: "goal_directed recipe requires intent_id and intent_digest" });
    }
    if (!plan.private_artifacts.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["private_artifacts"], message: "goal_directed recipe requires a private artifact" });
    }
  } else if (plan.intent_id || plan.intent_digest || plan.private_artifacts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "standard_deep recipe cannot bind a private intent or artifact" });
  }

  const confirmedState = plan.status === "confirmed" || plan.status === "completed";
  if (confirmedState && (!plan.confirmed_at || !plan.confirmation_source)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${plan.status} plan requires confirmed_at and confirmation_source` });
  }
  if (plan.status === "draft" && (plan.confirmed_at || plan.confirmation_source)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "draft plan cannot have confirmation metadata" });
  }

  const buckets = [
    ...plan.reuse.map((artifact) => [artifact.artifact, "reuse"] as const),
    ...plan.create.map((artifact) => [artifact, "create"] as const),
    ...plan.excluded.map((artifact) => [artifact.artifact, "excluded"] as const),
  ];
  const ownership = new Map<string, string>();
  for (const [artifact, bucket] of buckets) {
    const prior = ownership.get(artifact);
    if (prior && prior !== bucket) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `artifact ${artifact} cannot appear in both ${prior} and ${bucket}` });
    }
    ownership.set(artifact, bucket);
  }

  const expectedDigest = computeBuildPlanDigest(plan);
  if (plan.plan_digest !== expectedDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["plan_digest"], message: `plan_digest does not match identity: expected ${expectedDigest}` });
  }
});

export type BuildPlanV1 = z.infer<typeof BuildPlanV1Z>;
export type BuildPlanDigestSource = Pick<
  BuildPlanV1,
  | "source_fingerprint"
  | "content_profile"
  | "recipe_id"
  | "intent_digest"
  | "public_stage_closure"
  | "private_artifacts"
  | "reuse"
  | "create"
  | "excluded"
  | "budget"
>;

export function buildPlanIdentity(plan: BuildPlanDigestSource): BuildPlanDigestSource {
  return {
    source_fingerprint: plan.source_fingerprint,
    content_profile: plan.content_profile,
    recipe_id: plan.recipe_id,
    ...(plan.intent_digest ? { intent_digest: plan.intent_digest } : {}),
    public_stage_closure: plan.public_stage_closure,
    private_artifacts: plan.private_artifacts,
    reuse: plan.reuse,
    create: plan.create,
    excluded: plan.excluded,
    budget: plan.budget,
  };
}

export function computeBuildPlanDigest(plan: BuildPlanDigestSource): string {
  return sha256(canonicalBuildJson(buildPlanIdentity(plan)));
}

export function attachBuildPlanDigest(input: Omit<BuildPlanV1, "plan_digest">): BuildPlanV1 {
  return validateBuildPlanV1({ ...input, plan_digest: computeBuildPlanDigest(input) });
}

export function validateBuildPlanV1(input: unknown): BuildPlanV1 {
  return BuildPlanV1Z.parse(input);
}

const INTENT_TRANSITIONS: Record<BuildIntentStatus, readonly BuildIntentStatus[]> = {
  draft: ["confirmed", "superseded", "stale_source", "deleted"],
  confirmed: ["superseded", "stale_source", "deleted"],
  superseded: ["deleted"],
  stale_source: ["superseded", "deleted"],
  deleted: [],
};

export function transitionBuildIntent(
  input: BuildIntentV1,
  nextStatus: BuildIntentStatus,
  options: { at?: string } = {},
): BuildIntentV1 {
  const intent = validateBuildIntentV1(input);
  if (intent.status === nextStatus) return intent;
  if (!INTENT_TRANSITIONS[intent.status].includes(nextStatus)) {
    throw new Error(`illegal BuildIntent transition: ${intent.status} -> ${nextStatus}`);
  }
  if (nextStatus === "confirmed" && !options.at) throw new Error("BuildIntent confirmation transition requires at");
  return validateBuildIntentV1({
    ...intent,
    status: nextStatus,
    ...(nextStatus === "confirmed" ? { confirmed_at: options.at } : {}),
  });
}

const PLAN_TRANSITIONS: Record<BuildPlanStatus, readonly BuildPlanStatus[]> = {
  draft: ["confirmed", "superseded", "stale_source"],
  confirmed: ["completed", "superseded", "stale_source"],
  completed: ["superseded", "stale_source"],
  stale_source: ["superseded"],
  superseded: [],
};

export function transitionBuildPlan(
  input: BuildPlanV1,
  nextStatus: BuildPlanStatus,
  options: { at?: string; confirmation_source?: BuildPlanV1["confirmation_source"] } = {},
): BuildPlanV1 {
  const plan = validateBuildPlanV1(input);
  if (plan.status === nextStatus) return plan;
  if (!PLAN_TRANSITIONS[plan.status].includes(nextStatus)) {
    throw new Error(`illegal BuildPlan transition: ${plan.status} -> ${nextStatus}`);
  }
  if (nextStatus === "confirmed" && (!options.at || !options.confirmation_source)) {
    throw new Error("BuildPlan confirmation transition requires at and confirmation_source");
  }
  return validateBuildPlanV1({
    ...plan,
    status: nextStatus,
    ...(nextStatus === "confirmed"
      ? { confirmed_at: options.at, confirmation_source: options.confirmation_source }
      : {}),
  });
}

export const BuildDecisionScopeV2Z = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stage"), stage: z.enum(BUILD_STAGE_IDS) }).strict(),
  z.object({ kind: z.literal("build_plan"), plan_id: PathSafeBuildIdZ, plan_digest: Sha256Z }).strict(),
]);

export type BuildDecisionScopeV2 = z.infer<typeof BuildDecisionScopeV2Z>;

export const BuildDecisionRequestV2Z = z.object({
  version: z.literal("build_decision_request.v2"),
  decision_id: PathSafeBuildIdZ,
  job_id: PathSafeBuildIdZ.optional(),
  scope: BuildDecisionScopeV2Z,
  kind: z.union([z.literal("build_intent_plan"), z.enum(EXISTING_BUILD_DECISION_KINDS)]),
  options: z.array(z.object({
    id: NonBlankStringZ,
    label: NonBlankStringZ,
    description: NonBlankStringZ.optional(),
  }).strict()).min(1),
  status: z.enum(["pending", "answered"]),
}).strict().superRefine((request, context) => {
  addDuplicateIssues(request.options.map((option) => option.id), context, ["options"], "decision option id");
  if (request.kind === "build_intent_plan" && request.scope.kind !== "build_plan") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "build_intent_plan requires build_plan scope" });
  }
  if (request.kind !== "build_intent_plan" && request.scope.kind !== "stage") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "existing build decision kinds require stage scope" });
  }
});

export type BuildDecisionRequestV2 = z.infer<typeof BuildDecisionRequestV2Z>;
