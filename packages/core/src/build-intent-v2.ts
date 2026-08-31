import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertSameArtifactBlueprintVersionV2,
  computeArtifactBlueprintDigest,
  getSystemArtifactBlueprintV1,
  validateArtifactBlueprintV1,
  type ArtifactBlueprintV1,
} from "./artifact-blueprint";
import {
  BuildContentProfileZ,
  BuildIntentStatusZ,
  BuildPlanBudgetV1Z,
  BuildPlanEstimateV1Z,
  BuildPlanStatusZ,
  BuildRecipeIdZ,
  BuildSourceScopeZ,
  canonicalBuildJson,
  isPathSafeBuildId,
  validateBuildIntentV1,
  validateBuildPlanV1,
  type BuildIntentStatus,
  type BuildIntentV1,
  type BuildPlanStatus,
  type BuildPlanV1,
} from "./build-intent";

const PATH_SAFE_BUILD_ID_Z = z.string().min(1).max(128)
  .refine(isPathSafeBuildId, "must be a path-safe ASCII id");
const NON_BLANK_STRING_Z = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const SHA256_Z = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 digest");
const ISO_DATE_TIME_Z = z.string().datetime({ offset: true });
const SAFE_REVISION_Z = z.number().int().positive().safe();
const GOAL_KIND_Z = z.enum(["learn", "analyze", "compare", "write", "reference", "other"]);
const USAGE_HORIZON_Z = z.enum(["one_off", "project", "long_term"]);
const CONFIRMATION_SOURCE_Z = z.enum(["reader_ui", "codex_conversation", "explicit_legacy_command"]);

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalBuildJson(value), "utf8").digest("hex");
}

function duplicateValues(
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

export const BuildIntentV2Z = z.object({
  version: z.literal("build_intent.v2"),
  intent_id: PATH_SAFE_BUILD_ID_Z,
  revision: SAFE_REVISION_Z,
  book_id: PATH_SAFE_BUILD_ID_Z,
  source_fingerprint: NON_BLANK_STRING_Z,
  content_profile: BuildContentProfileZ,
  user_goal: NON_BLANK_STRING_Z,
  goal_kind: GOAL_KIND_Z,
  source_scope: BuildSourceScopeZ,
  usage_horizon: USAGE_HORIZON_Z,
  privacy: z.literal("reader_private"),
  status: BuildIntentStatusZ,
  created_at: ISO_DATE_TIME_Z,
  confirmed_at: ISO_DATE_TIME_Z.optional(),
  supersedes_intent_id: PATH_SAFE_BUILD_ID_Z.optional(),
}).strict().superRefine((intent, context) => {
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

export type BuildIntentV2 = z.infer<typeof BuildIntentV2Z>;

export function validateBuildIntentV2(input: unknown): BuildIntentV2 {
  return BuildIntentV2Z.parse(input);
}

export function buildIntentIdentityV2(
  input: BuildIntentV2,
): Omit<BuildIntentV2, "created_at" | "confirmed_at" | "status"> {
  const intent = validateBuildIntentV2(input);
  const { created_at: _createdAt, confirmed_at: _confirmedAt, status: _status, ...identity } = intent;
  return identity;
}

export function computeBuildIntentDigestV2(input: BuildIntentV2): string {
  return digest(buildIntentIdentityV2(input));
}

const ARTIFACT_BLUEPRINT_Z = z.unknown().transform((value, context) => {
  try {
    return validateArtifactBlueprintV1(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid ArtifactBlueprint",
    });
    return z.NEVER;
  }
});

export const BuildPlanPrivateArtifactV2Z = z.object({
  artifact_id: PATH_SAFE_BUILD_ID_Z,
  source_scope: BuildSourceScopeZ,
  blueprint: ARTIFACT_BLUEPRINT_Z,
  blueprint_digest: SHA256_Z,
  required_public_capabilities: z.array(NON_BLANK_STRING_Z),
}).strict().superRefine((artifact, context) => {
  duplicateValues(
    artifact.required_public_capabilities,
    context,
    ["required_public_capabilities"],
    "required public capability",
  );
  const expected = computeArtifactBlueprintDigest(artifact.blueprint);
  if (artifact.blueprint_digest !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blueprint_digest"],
      message: `blueprint_digest does not match snapshot: expected ${expected}`,
    });
  }
});

export type BuildPlanPrivateArtifactV2 = z.infer<typeof BuildPlanPrivateArtifactV2Z>;

const REUSED_BUILD_ARTIFACT_Z = z.object({
  artifact: NON_BLANK_STRING_Z,
  freshness_digest: SHA256_Z,
}).strict();

const EXCLUDED_BUILD_ARTIFACT_Z = z.object({
  artifact: NON_BLANK_STRING_Z,
  reason: NON_BLANK_STRING_Z,
}).strict();

const BUILD_PLAN_V2_SHAPE_Z = z.object({
  version: z.literal("build_plan.v2"),
  plan_id: PATH_SAFE_BUILD_ID_Z,
  revision: SAFE_REVISION_Z,
  book_id: PATH_SAFE_BUILD_ID_Z,
  source_fingerprint: NON_BLANK_STRING_Z,
  content_profile: BuildContentProfileZ,
  recipe_id: BuildRecipeIdZ,
  intent_id: PATH_SAFE_BUILD_ID_Z.optional(),
  intent_digest: SHA256_Z.optional(),
  public_stage_closure: z.array(NON_BLANK_STRING_Z),
  private_artifacts: z.array(BuildPlanPrivateArtifactV2Z),
  reuse: z.array(REUSED_BUILD_ARTIFACT_Z),
  create: z.array(NON_BLANK_STRING_Z),
  excluded: z.array(EXCLUDED_BUILD_ARTIFACT_Z),
  estimate: BuildPlanEstimateV1Z,
  budget: BuildPlanBudgetV1Z,
  status: BuildPlanStatusZ,
  plan_digest: SHA256_Z,
  confirmation_source: CONFIRMATION_SOURCE_Z.optional(),
  created_at: ISO_DATE_TIME_Z,
  confirmed_at: ISO_DATE_TIME_Z.optional(),
}).strict();

export type BuildPlanV2 = z.infer<typeof BUILD_PLAN_V2_SHAPE_Z>;
export type BuildPlanDigestSourceV2 = Pick<
  BuildPlanV2,
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

export function buildPlanIdentityV2(plan: BuildPlanDigestSourceV2): BuildPlanDigestSourceV2 {
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

export function computeBuildPlanDigestV2(plan: BuildPlanDigestSourceV2): string {
  return digest(buildPlanIdentityV2(plan));
}

export const BuildPlanV2Z = BUILD_PLAN_V2_SHAPE_Z.superRefine((plan, context) => {
  duplicateValues(plan.public_stage_closure, context, ["public_stage_closure"], "public stage");
  duplicateValues(plan.private_artifacts.map((artifact) => artifact.artifact_id), context, ["private_artifacts"], "artifact_id");
  duplicateValues(plan.reuse.map((artifact) => artifact.artifact), context, ["reuse"], "reused artifact");
  duplicateValues(plan.create, context, ["create"], "created artifact");
  duplicateValues(plan.excluded.map((artifact) => artifact.artifact), context, ["excluded"], "excluded artifact");

  if (plan.recipe_id === "goal_directed") {
    if (!plan.intent_id || !plan.intent_digest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["intent_id"], message: "goal_directed recipe requires intent_id and intent_digest" });
    }
  } else if (plan.intent_id || plan.intent_digest || plan.private_artifacts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "standard_deep recipe cannot bind a private intent or artifact" });
  }

  const confirmed = plan.status === "confirmed" || plan.status === "completed";
  if (confirmed && (!plan.confirmed_at || !plan.confirmation_source)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${plan.status} plan requires confirmed_at and confirmation_source` });
  }
  if (plan.status === "draft" && (plan.confirmed_at || plan.confirmation_source)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "draft plan cannot have confirmation metadata" });
  }

  const ownership = new Map<string, string>();
  for (const [artifact, bucket] of [
    ...plan.reuse.map((item) => [item.artifact, "reuse"] as const),
    ...plan.create.map((item) => [item, "create"] as const),
    ...plan.excluded.map((item) => [item.artifact, "excluded"] as const),
  ]) {
    const prior = ownership.get(artifact);
    if (prior && prior !== bucket) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `artifact ${artifact} cannot appear in both ${prior} and ${bucket}` });
    }
    ownership.set(artifact, bucket);
  }

  const expected = computeBuildPlanDigestV2(plan);
  if (plan.plan_digest !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plan_digest"],
      message: `plan_digest does not match identity: expected ${expected}`,
    });
  }
});

export function validateBuildPlanV2(input: unknown): BuildPlanV2 {
  return BuildPlanV2Z.parse(input);
}

export function attachBuildPlanDigestV2(input: Omit<BuildPlanV2, "plan_digest">): BuildPlanV2 {
  return validateBuildPlanV2({ ...input, plan_digest: computeBuildPlanDigestV2(input) });
}

export const BuildIntentV3Z = z.object({
  version: z.literal("build_intent.v3"),
  intent_id: PATH_SAFE_BUILD_ID_Z,
  intent_revision: SAFE_REVISION_Z,
  book_id: PATH_SAFE_BUILD_ID_Z,
  source_fingerprint: NON_BLANK_STRING_Z,
  content_profile: BuildContentProfileZ,
  user_goal: NON_BLANK_STRING_Z,
  goal_kind: GOAL_KIND_Z,
  source_scope: BuildSourceScopeZ,
  usage_horizon: USAGE_HORIZON_Z,
  privacy: z.literal("reader_private"),
  status: BuildIntentStatusZ,
  created_at: ISO_DATE_TIME_Z,
  confirmed_at: ISO_DATE_TIME_Z.optional(),
  supersedes_intent_id: PATH_SAFE_BUILD_ID_Z.optional(),
}).strict().superRefine((intent, context) => {
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

export type BuildIntentV3 = z.infer<typeof BuildIntentV3Z>;

export function validateBuildIntentV3(input: unknown): BuildIntentV3 {
  return BuildIntentV3Z.parse(input);
}

export const BuildPlanPrivateArtifactV3Z = z.object({
  artifact_id: PATH_SAFE_BUILD_ID_Z,
  source_scope: BuildSourceScopeZ,
  blueprint: ARTIFACT_BLUEPRINT_Z,
  blueprint_id: PATH_SAFE_BUILD_ID_Z,
  blueprint_version: PATH_SAFE_BUILD_ID_Z,
  required_public_capabilities: z.array(NON_BLANK_STRING_Z),
}).strict().superRefine((artifact, context) => {
  duplicateValues(
    artifact.required_public_capabilities,
    context,
    ["required_public_capabilities"],
    "required public capability",
  );
  if (artifact.blueprint_id !== artifact.blueprint.blueprint_id
    || artifact.blueprint_version !== artifact.blueprint.blueprint_version) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blueprint_id"],
      message: "Blueprint id/version does not match the frozen snapshot",
    });
  }
});

export type BuildPlanPrivateArtifactV3 = z.infer<typeof BuildPlanPrivateArtifactV3Z>;

const BUILD_PLAN_V3_SHAPE_Z = z.object({
  version: z.literal("build_plan.v3"),
  plan_id: PATH_SAFE_BUILD_ID_Z,
  plan_revision: SAFE_REVISION_Z,
  book_id: PATH_SAFE_BUILD_ID_Z,
  source_fingerprint: NON_BLANK_STRING_Z,
  content_profile: BuildContentProfileZ,
  recipe_id: BuildRecipeIdZ,
  intent_id: PATH_SAFE_BUILD_ID_Z.optional(),
  intent_revision: SAFE_REVISION_Z.optional(),
  public_stage_closure: z.array(NON_BLANK_STRING_Z),
  private_artifacts: z.array(BuildPlanPrivateArtifactV3Z),
  reuse: z.array(REUSED_BUILD_ARTIFACT_Z),
  create: z.array(NON_BLANK_STRING_Z),
  excluded: z.array(EXCLUDED_BUILD_ARTIFACT_Z),
  estimate: BuildPlanEstimateV1Z,
  budget: BuildPlanBudgetV1Z,
  status: BuildPlanStatusZ,
  confirmation_source: CONFIRMATION_SOURCE_Z.optional(),
  created_at: ISO_DATE_TIME_Z,
  confirmed_at: ISO_DATE_TIME_Z.optional(),
}).strict();

export const BuildPlanV3Z = BUILD_PLAN_V3_SHAPE_Z.superRefine((plan, context) => {
  duplicateValues(plan.public_stage_closure, context, ["public_stage_closure"], "public stage");
  duplicateValues(plan.private_artifacts.map((artifact) => artifact.artifact_id), context, ["private_artifacts"], "artifact_id");
  duplicateValues(plan.reuse.map((artifact) => artifact.artifact), context, ["reuse"], "reused artifact");
  duplicateValues(plan.create, context, ["create"], "created artifact");
  duplicateValues(plan.excluded.map((artifact) => artifact.artifact), context, ["excluded"], "excluded artifact");

  if (plan.recipe_id === "goal_directed") {
    if (!plan.intent_id || !plan.intent_revision) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["intent_id"], message: "goal_directed recipe requires intent_id and intent_revision" });
    }
  } else if (plan.intent_id || plan.intent_revision || plan.private_artifacts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "standard_deep recipe cannot bind a private intent or artifact" });
  }

  const confirmed = plan.status === "confirmed" || plan.status === "completed";
  if (confirmed && (!plan.confirmed_at || !plan.confirmation_source)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${plan.status} plan requires confirmed_at and confirmation_source` });
  }
  if (plan.status === "draft" && (plan.confirmed_at || plan.confirmation_source)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "draft plan cannot have confirmation metadata" });
  }

  const ownership = new Map<string, string>();
  for (const [artifact, bucket] of [
    ...plan.reuse.map((item) => [item.artifact, "reuse"] as const),
    ...plan.create.map((item) => [item, "create"] as const),
    ...plan.excluded.map((item) => [item.artifact, "excluded"] as const),
  ]) {
    const prior = ownership.get(artifact);
    if (prior && prior !== bucket) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `artifact ${artifact} cannot appear in both ${prior} and ${bucket}` });
    }
    ownership.set(artifact, bucket);
  }
});

export type BuildPlanV3 = z.infer<typeof BuildPlanV3Z>;

export function validateBuildPlanV3(input: unknown): BuildPlanV3 {
  return BuildPlanV3Z.parse(input);
}

export function reconcileBuildIntentV3(currentInput: unknown, nextInput: unknown): BuildIntentV3 {
  const current = validateBuildIntentV3(currentInput);
  const next = validateBuildIntentV3(nextInput);
  if (current.intent_id !== next.intent_id) throw new Error("BuildIntent id cannot change within one owner stream");
  if (next.intent_revision < current.intent_revision) throw new Error("BuildIntent revision is older than the current owner revision");
  if (next.intent_revision === current.intent_revision
    && canonicalBuildJson(next) !== canonicalBuildJson(current)) {
    throw new Error("BuildIntent has different body at the same revision");
  }
  if (next.intent_revision > current.intent_revision + 1) {
    throw new Error("BuildIntent revision must be issued monotonically");
  }
  return next;
}

export function reconcileBuildPlanV3(currentInput: unknown, nextInput: unknown): BuildPlanV3 {
  const current = validateBuildPlanV3(currentInput);
  const next = validateBuildPlanV3(nextInput);
  if (current.plan_id !== next.plan_id) throw new Error("BuildPlan id cannot change within one owner stream");
  if (next.plan_revision < current.plan_revision) throw new Error("BuildPlan revision is older than the current owner revision");
  if (next.plan_revision === current.plan_revision
    && canonicalBuildJson(next) !== canonicalBuildJson(current)) {
    throw new Error("BuildPlan has different body at the same revision");
  }
  if (next.plan_revision > current.plan_revision + 1) {
    throw new Error("BuildPlan revision must be issued monotonically");
  }
  return next;
}

const INTENT_TRANSITIONS: Record<BuildIntentStatus, readonly BuildIntentStatus[]> = {
  draft: ["confirmed", "superseded", "stale_source", "deleted"],
  confirmed: ["superseded", "stale_source", "deleted"],
  superseded: ["deleted"],
  stale_source: ["superseded", "deleted"],
  deleted: [],
};

export function transitionBuildIntentV2(
  input: BuildIntentV2,
  nextStatus: BuildIntentStatus,
  options: { at?: string } = {},
): BuildIntentV2 {
  const intent = validateBuildIntentV2(input);
  if (intent.status === nextStatus) return intent;
  if (!INTENT_TRANSITIONS[intent.status].includes(nextStatus)) {
    throw new Error(`illegal BuildIntent transition: ${intent.status} -> ${nextStatus}`);
  }
  if (nextStatus === "confirmed" && !options.at) throw new Error("BuildIntent confirmation transition requires at");
  return validateBuildIntentV2({
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

export function transitionBuildPlanV2(
  input: BuildPlanV2,
  nextStatus: BuildPlanStatus,
  options: { at?: string; confirmation_source?: BuildPlanV2["confirmation_source"] } = {},
): BuildPlanV2 {
  const plan = validateBuildPlanV2(input);
  if (plan.status === nextStatus) return plan;
  if (!PLAN_TRANSITIONS[plan.status].includes(nextStatus)) {
    throw new Error(`illegal BuildPlan transition: ${plan.status} -> ${nextStatus}`);
  }
  if (nextStatus === "confirmed" && (!options.at || !options.confirmation_source)) {
    throw new Error("BuildPlan confirmation transition requires at and confirmation_source");
  }
  return validateBuildPlanV2({
    ...plan,
    status: nextStatus,
    ...(nextStatus === "confirmed"
      ? { confirmed_at: options.at, confirmation_source: options.confirmation_source }
      : {}),
  });
}

export function transitionBuildIntentV3(
  input: BuildIntentV3,
  nextStatus: BuildIntentStatus,
  options: { at?: string } = {},
): BuildIntentV3 {
  const intent = validateBuildIntentV3(input);
  if (intent.status === nextStatus) return intent;
  if (!INTENT_TRANSITIONS[intent.status].includes(nextStatus)) {
    throw new Error(`illegal BuildIntent transition: ${intent.status} -> ${nextStatus}`);
  }
  if (nextStatus === "confirmed" && !options.at) throw new Error("BuildIntent confirmation transition requires at");
  return validateBuildIntentV3({
    ...intent,
    status: nextStatus,
    ...(nextStatus === "confirmed" ? { confirmed_at: options.at } : {}),
  });
}

export function transitionBuildPlanV3(
  input: BuildPlanV3,
  nextStatus: BuildPlanStatus,
  options: { at?: string; confirmation_source?: BuildPlanV3["confirmation_source"] } = {},
): BuildPlanV3 {
  const plan = validateBuildPlanV3(input);
  if (plan.status === nextStatus) return plan;
  if (!PLAN_TRANSITIONS[plan.status].includes(nextStatus)) {
    throw new Error(`illegal BuildPlan transition: ${plan.status} -> ${nextStatus}`);
  }
  if (nextStatus === "confirmed" && (!options.at || !options.confirmation_source)) {
    throw new Error("BuildPlan confirmation transition requires at and confirmation_source");
  }
  return validateBuildPlanV3({
    ...plan,
    status: nextStatus,
    ...(nextStatus === "confirmed"
      ? { confirmed_at: options.at, confirmation_source: options.confirmation_source }
      : {}),
  });
}

export function migrateBuildIntentV2ToV3(input: unknown): BuildIntentV3 {
  const legacy = validateBuildIntentV2(input);
  computeBuildIntentDigestV2(legacy);
  const { revision, ...body } = legacy;
  return validateBuildIntentV3({
    ...body,
    version: "build_intent.v3",
    intent_revision: revision,
  });
}

export function migrateBuildPlanV2ToV3(input: {
  plan: unknown;
  intent?: unknown;
}): BuildPlanV3 {
  const legacy = validateBuildPlanV2(input.plan);
  const currentIntent = input.intent === undefined ? undefined : validateBuildIntentV2(input.intent);
  if (legacy.recipe_id === "goal_directed") {
    if (!currentIntent
      || legacy.intent_id !== currentIntent.intent_id
      || legacy.intent_digest !== computeBuildIntentDigestV2(currentIntent)) {
      throw new Error("legacy BuildPlan does not match the fully validated BuildIntent");
    }
  } else if (currentIntent) {
    throw new Error("standard_deep BuildPlan migration must not bind a BuildIntent");
  }
  const {
    revision,
    intent_digest: _intentDigest,
    plan_digest: _planDigest,
    private_artifacts: legacyArtifacts,
    ...body
  } = legacy;
  return validateBuildPlanV3({
    ...body,
    version: "build_plan.v3",
    plan_revision: revision,
    ...(currentIntent ? { intent_revision: currentIntent.revision } : {}),
    private_artifacts: legacyArtifacts.map((artifact) => {
      const blueprint = assertSameArtifactBlueprintVersionV2(artifact.blueprint, artifact.blueprint);
      return {
        artifact_id: artifact.artifact_id,
        source_scope: artifact.source_scope,
        blueprint,
        blueprint_id: blueprint.blueprint_id,
        blueprint_version: blueprint.blueprint_version,
        required_public_capabilities: artifact.required_public_capabilities,
      };
    }),
  });
}

export interface PlanningControlMigrationV2ToV3 {
  version: "planning_control_migration.v2_to_v3";
  intent: BuildIntentV3 | null;
  plan: BuildPlanV3;
}

export function migratePlanningControlV2ToV3(input: {
  intent?: unknown;
  plan: unknown;
}): PlanningControlMigrationV2ToV3 {
  const legacyIntent = input.intent === undefined ? undefined : validateBuildIntentV2(input.intent);
  return {
    version: "planning_control_migration.v2_to_v3",
    intent: legacyIntent ? migrateBuildIntentV2ToV3(legacyIntent) : null,
    plan: migrateBuildPlanV2ToV3({ plan: input.plan, ...(legacyIntent ? { intent: legacyIntent } : {}) }),
  };
}

export function adaptBuildPlanV1PrivateArtifacts(planInput: BuildPlanV1): BuildPlanPrivateArtifactV2[] {
  const plan = validateBuildPlanV1(planInput);
  return plan.private_artifacts.map((artifact) => {
    if (artifact.artifact_type === "custom") {
      throw new Error("V1 custom artifact has no deterministic system ArtifactBlueprint adapter");
    }
    const preset = getSystemArtifactBlueprintV1(artifact.artifact_type);
    return BuildPlanPrivateArtifactV2Z.parse({
      artifact_id: artifact.artifact_id,
      source_scope: artifact.source_scope,
      blueprint: preset.blueprint,
      blueprint_digest: preset.digest,
      required_public_capabilities: artifact.required_public_capabilities,
    });
  });
}

export type BuildIntentAny = BuildIntentV1 | BuildIntentV2 | BuildIntentV3;
export type BuildPlanAny = BuildPlanV1 | BuildPlanV2 | BuildPlanV3;

export function validateBuildIntentAny(input: unknown): BuildIntentAny {
  const version = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).version
    : undefined;
  if (version === "build_intent.v3") return validateBuildIntentV3(input);
  return version === "build_intent.v2" ? validateBuildIntentV2(input) : validateBuildIntentV1(input);
}

export function validateBuildPlanAny(input: unknown): BuildPlanAny {
  const version = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).version
    : undefined;
  if (version === "build_plan.v3") return validateBuildPlanV3(input);
  return version === "build_plan.v2" ? validateBuildPlanV2(input) : validateBuildPlanV1(input);
}

export function computeBuildIntentDigestAny(input: BuildIntentAny): string {
  if (input.version === "build_intent.v3") {
    throw new Error("BuildIntent V3 uses intent_id + intent_revision, not a digest");
  }
  return input.version === "build_intent.v2"
    ? computeBuildIntentDigestV2(input)
    : digest((() => {
        const { created_at: _createdAt, confirmed_at: _confirmedAt, status: _status, ...identity } = validateBuildIntentV1(input);
        return identity;
      })());
}

export interface ArtifactBlueprintPlanSummaryV1 {
  artifact_id: string;
  title: string;
  purpose: string;
  shape: ArtifactBlueprintV1["shape"];
  key_fields: string[];
  reuse_source: ArtifactBlueprintV1["origin"];
  blueprint_id: string;
  blueprint_version: string;
  blueprint_digest: string;
  limits: ArtifactBlueprintV1["limits"];
}

export interface ArtifactBlueprintPlanSummaryV2 {
  artifact_id: string;
  title: string;
  purpose: string;
  shape: ArtifactBlueprintV1["shape"];
  key_fields: string[];
  reuse_source: ArtifactBlueprintV1["origin"];
  blueprint_id: string;
  blueprint_version: string;
  limits: ArtifactBlueprintV1["limits"];
}

export function summarizeBuildPlanPrivateArtifactV2(
  artifact: BuildPlanPrivateArtifactV2,
): ArtifactBlueprintPlanSummaryV1 {
  return {
    artifact_id: artifact.artifact_id,
    title: artifact.blueprint.title,
    purpose: artifact.blueprint.purpose,
    shape: artifact.blueprint.shape,
    key_fields: Object.keys(artifact.blueprint.record_schema.properties),
    reuse_source: artifact.blueprint.origin,
    blueprint_id: artifact.blueprint.blueprint_id,
    blueprint_version: artifact.blueprint.blueprint_version,
    blueprint_digest: artifact.blueprint_digest,
    limits: artifact.blueprint.limits,
  };
}

export function summarizeBuildPlanPrivateArtifactV3(
  artifact: BuildPlanPrivateArtifactV3,
): ArtifactBlueprintPlanSummaryV2 {
  return {
    artifact_id: artifact.artifact_id,
    title: artifact.blueprint.title,
    purpose: artifact.blueprint.purpose,
    shape: artifact.blueprint.shape,
    key_fields: Object.keys(artifact.blueprint.record_schema.properties),
    reuse_source: artifact.blueprint.origin,
    blueprint_id: artifact.blueprint_id,
    blueprint_version: artifact.blueprint_version,
    limits: artifact.blueprint.limits,
  };
}
