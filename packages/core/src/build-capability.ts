import { createHash } from "node:crypto";
import {
  computeArtifactBlueprintDigest,
  validateArtifactBlueprintV1,
} from "./artifact-blueprint";
import type { ArtifactBlueprintResolutionV1 } from "./artifact-blueprint-registry";
import {
  attachBuildPlanDigest,
  canonicalBuildJson,
  computeBuildIntentDigest,
  validateBuildContentProfile,
  validateBuildIntentV1,
  validatePathSafeBuildId,
  type BuildContentProfile,
  type BuildIntentV1,
  type BuildPlanBudgetV1,
  type BuildPlanEstimateV1,
  type BuildPlanV1,
  type BuildSourceScope,
  type IntentArtifactType,
} from "./build-intent";
import {
  attachBuildPlanDigestV2,
  computeBuildIntentDigestV2,
  validateBuildIntentV2,
  type BuildIntentV2,
  type BuildPlanV2,
} from "./build-intent-v2";
import type { AutomaticBuildStageFreshnessInspectionV1, AutomaticBuildStage } from "./build-orchestrator";
import { BUILD_STAGE_DAG, type BuildStageId } from "./build-workbench";
import { sidecarPlanOptionFor, type SidecarPlanOption } from "./sidecar-plan";

export type BuildMode = "read_now" | "standard_deep" | "goal_directed";
export type PrivateBuildArtifactType = Exclude<IntentArtifactType, "custom">;
export type PrivateBuildCapabilityId = `private.${PrivateBuildArtifactType}`;
export type BuildCapabilityId = "public.standard_deep" | PrivateBuildCapabilityId;

export interface BuildCapabilityDefinition {
  id: BuildCapabilityId;
  visibility: "public" | "reader_private";
  supported_profiles: readonly BuildContentProfile["id"][];
  profile_entry_stages?: Partial<Record<BuildContentProfile["id"], readonly AutomaticBuildStage[]>>;
  artifact_type?: PrivateBuildArtifactType;
  required_public_capabilities: readonly string[];
  evidence_policy?: "lid_required";
  output_contract?: SidecarPlanOption["output_contract"];
  validation_rules: readonly string[];
}

export type BuildCapabilityRegistry = Record<BuildCapabilityId, BuildCapabilityDefinition>;

const PRIVATE_ARTIFACT_TYPES = [
  "timeline",
  "concept_map",
  "comparison_table",
  "argument_map",
] as const satisfies readonly PrivateBuildArtifactType[];
const BUILD_CAPABILITY_IDS = [
  "public.standard_deep",
  "private.timeline",
  "private.concept_map",
  "private.comparison_table",
  "private.argument_map",
] as const satisfies readonly BuildCapabilityId[];
const AUTOMATIC_STAGE_ORDER = (Object.keys(BUILD_STAGE_DAG) as BuildStageId[]).filter(
  (stage): stage is AutomaticBuildStage => stage !== "source_reconciliation" && stage !== "hybrid_foundation",
);
const EXPECTED_STANDARD_CLOSURES: Record<BuildContentProfile["id"], readonly AutomaticBuildStage[]> = {
  technical_learning: ["pass1", "profile_sidecar", "pass2", "book_structure"],
  paper: [
    "pass1",
    "paper_metadata",
    "paper_lexicon",
    "profile_sidecar",
    "pass2",
    "book_structure",
    "paper_reading_guide",
  ],
};

function privateDefinition(artifactType: PrivateBuildArtifactType): BuildCapabilityDefinition {
  const sidecar = sidecarPlanOptionFor(artifactType);
  return {
    id: `private.${artifactType}`,
    visibility: "reader_private",
    supported_profiles: ["technical_learning", "paper"],
    artifact_type: artifactType,
    required_public_capabilities: ["foundation.lid"],
    evidence_policy: "lid_required",
    output_contract: sidecar.output_contract,
    validation_rules: sidecar.validation_rules,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const BUILD_CAPABILITY_REGISTRY: BuildCapabilityRegistry = deepFreeze({
  "public.standard_deep": {
    id: "public.standard_deep",
    visibility: "public",
    supported_profiles: ["technical_learning", "paper"],
    profile_entry_stages: {
      technical_learning: ["book_structure"],
      paper: ["paper_metadata", "paper_lexicon", "paper_reading_guide"],
    },
    required_public_capabilities: ["foundation.lid"],
    validation_rules: ["current_build_stage_dag", "goal_agnostic_public_policy"],
  },
  "private.timeline": privateDefinition("timeline"),
  "private.concept_map": privateDefinition("concept_map"),
  "private.comparison_table": privateDefinition("comparison_table"),
  "private.argument_map": privateDefinition("argument_map"),
});

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalBuildJson(left) === canonicalBuildJson(right);
}

function registryRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("build capability registry must be an object");
  }
  return input as Record<string, unknown>;
}

function closureFromRegistry(
  contentProfile: BuildContentProfile,
  registry: BuildCapabilityRegistry,
): AutomaticBuildStage[] {
  const definition = registry["public.standard_deep"];
  const entries = definition.profile_entry_stages?.[contentProfile.id];
  if (!entries?.length) throw new Error(`standard_deep is missing ${contentProfile.id} entry stages`);
  const allowed = new Set(EXPECTED_STANDARD_CLOSURES[contentProfile.id]);
  const selected = new Set<AutomaticBuildStage>();
  const visit = (stage: AutomaticBuildStage): void => {
    if (!allowed.has(stage)) {
      throw new Error(`stage ${stage} is not supported by ${contentProfile.id}.standard_deep`);
    }
    if (selected.has(stage)) return;
    for (const dependency of BUILD_STAGE_DAG[stage].depends_on) {
      if (AUTOMATIC_STAGE_ORDER.includes(dependency as AutomaticBuildStage)) {
        visit(dependency as AutomaticBuildStage);
      }
    }
    selected.add(stage);
  };
  entries.forEach(visit);
  return AUTOMATIC_STAGE_ORDER.filter((stage) => selected.has(stage));
}

export function standardDeepStageClosure(
  contentProfileInput: BuildContentProfile,
  registry: BuildCapabilityRegistry = BUILD_CAPABILITY_REGISTRY,
): AutomaticBuildStage[] {
  const contentProfile = validateBuildContentProfile(contentProfileInput);
  return closureFromRegistry(contentProfile, registry);
}

export function validateBuildCapabilityRegistry(input: unknown): BuildCapabilityRegistry {
  const record = registryRecord(input);
  const expectedIds = BUILD_CAPABILITY_IDS;
  if (!sameJson(Object.keys(record), expectedIds)) {
    throw new Error(`build capability registry must contain only: ${expectedIds.join(", ")}`);
  }
  for (const id of expectedIds) {
    const definition = registryRecord(record[id]);
    if (definition.id !== id) throw new Error(`build capability ${id} has a mismatched id`);
    const supported = definition.supported_profiles;
    if (!Array.isArray(supported) || !sameJson(supported, ["technical_learning", "paper"])) {
      throw new Error(`build capability ${id} must support both content profiles`);
    }
  }
  const registry = input as BuildCapabilityRegistry;
  for (const profileId of ["technical_learning", "paper"] as const) {
    const actual = closureFromRegistry(validateBuildContentProfile({
      id: profileId,
      version: profileId === "paper" ? "paper_v0" : "technical_learning_v0",
    }), registry);
    if (!sameJson(actual, EXPECTED_STANDARD_CLOSURES[profileId])) {
      throw new Error(`${profileId}.standard_deep does not match the current build DAG`);
    }
  }
  for (const artifactType of PRIVATE_ARTIFACT_TYPES) {
    const id: PrivateBuildCapabilityId = `private.${artifactType}`;
    const definition = registry[id];
    const sidecar = sidecarPlanOptionFor(artifactType);
    if (
      definition.visibility !== "reader_private"
      || definition.artifact_type !== artifactType
      || !sameJson(definition.required_public_capabilities, ["foundation.lid"])
      || definition.evidence_policy !== "lid_required"
      || !sameJson(definition.output_contract, sidecar.output_contract)
      || !sameJson(definition.validation_rules, sidecar.validation_rules)
    ) {
      throw new Error(`build capability ${id} must reuse its lid-required SidecarPlan contract`);
    }
  }
  return registry;
}

export interface BuildPlanEstimateInputV1 {
  version: "build_plan_estimate_input.v1";
  source_fingerprint: string;
  content_profile: BuildContentProfile;
  public_stages_to_create: AutomaticBuildStage[];
  private_capabilities_to_create: PrivateBuildCapabilityId[];
  reused_artifacts: string[];
  source_scope?: BuildSourceScope;
}

export interface CompileBuildModeInput {
  mode: BuildMode;
  book_id: string;
  source_fingerprint: string;
  content_profile: BuildContentProfile;
  plan_id: string;
  revision: number;
  created_at: string;
  budget: BuildPlanBudgetV1;
  public_freshness: AutomaticBuildStageFreshnessInspectionV1[];
  estimate?: BuildPlanEstimateV1;
  intent?: unknown;
  requested_capability_ids?: string[];
}

export interface BuildModeCompilationV1 {
  version: "build_mode_compilation.v1";
  mode: BuildMode;
  plan?: BuildPlanV1;
  estimate_input?: BuildPlanEstimateInputV1;
}

export interface BuildPlanEstimateInputV2 {
  version: "build_plan_estimate_input.v2";
  source_fingerprint: string;
  content_profile: BuildContentProfile;
  public_stages_to_create: AutomaticBuildStage[];
  private_blueprints_to_create: Array<{
    artifact_id: string;
    blueprint_digest: string;
    shape: string;
    max_records: number;
    max_relations: number;
    max_text_chars: number;
  }>;
  reused_artifacts: string[];
  source_scope?: BuildSourceScope;
}

export interface CompileBuildModeV2Input {
  mode: BuildMode;
  book_id: string;
  source_fingerprint: string;
  content_profile: BuildContentProfile;
  plan_id: string;
  revision: number;
  created_at: string;
  budget: BuildPlanBudgetV1;
  public_freshness: AutomaticBuildStageFreshnessInspectionV1[];
  estimate?: BuildPlanEstimateV1;
  intent?: unknown;
  selected_blueprints?: ArtifactBlueprintResolutionV1[];
}

export interface BuildModeCompilationV2 {
  version: "build_mode_compilation.v2";
  mode: BuildMode;
  plan?: BuildPlanV2;
  estimate_input?: BuildPlanEstimateInputV2;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalBuildJson(value), "utf8").digest("hex");
}

function unknownEstimate(input: BuildPlanEstimateInputV1): BuildPlanEstimateV1 {
  const unknownStages = [
    ...input.public_stages_to_create,
    ...input.private_capabilities_to_create,
  ];
  return {
    input_tokens: { lower: 0, upper: 0, coverage: 0 },
    output_tokens: { lower: 0, upper: 0, coverage: 0 },
    wall_clock_minutes: { confidence: "none" },
    unknown_stages: unknownStages,
    historical_match: { stage: false, policy: false, model: false, harness: false, sample_count: 0 },
  };
}

function validateFreshness(
  inspections: AutomaticBuildStageFreshnessInspectionV1[],
): Map<string, AutomaticBuildStageFreshnessInspectionV1> {
  const byArtifact = new Map<string, AutomaticBuildStageFreshnessInspectionV1>();
  for (const inspection of inspections) {
    if (inspection.version !== "automatic_build_stage_freshness.v1") {
      throw new Error("unsupported public freshness inspection version");
    }
    if (!AUTOMATIC_STAGE_ORDER.includes(inspection.stage)) {
      throw new Error(`unknown public freshness stage: ${String(inspection.stage)}`);
    }
    if (inspection.artifact !== `public.${inspection.stage}`) {
      throw new Error("public freshness artifact does not match its stage");
    }
    if (byArtifact.has(inspection.artifact)) throw new Error(`duplicate public freshness: ${inspection.artifact}`);
    if (inspection.fresh && !/^[a-f0-9]{64}$/u.test(inspection.freshness_digest ?? "")) {
      throw new Error(`fresh public artifact ${inspection.artifact} requires a freshness digest`);
    }
    byArtifact.set(inspection.artifact, inspection);
  }
  return byArtifact;
}

function validateRequestedCapabilities(
  requestedIds: string[],
  contentProfile: BuildContentProfile,
  registry: BuildCapabilityRegistry,
): PrivateBuildCapabilityId[] {
  const result: PrivateBuildCapabilityId[] = [];
  const seen = new Set<string>();
  for (const id of requestedIds) {
    if (!(id in registry)) throw new Error(`unknown build capability: ${id}`);
    if (id === "public.standard_deep") throw new Error("goal_directed cannot select public.standard_deep");
    if (seen.has(id)) throw new Error(`duplicate build capability: ${id}`);
    seen.add(id);
    const capability = registry[id as PrivateBuildCapabilityId];
    if (!capability.supported_profiles.includes(contentProfile.id)) {
      throw new Error(`build capability ${id} does not support profile ${contentProfile.id}`);
    }
    result.push(id as PrivateBuildCapabilityId);
  }
  return result;
}

function sameProfile(left: BuildContentProfile, right: BuildContentProfile): boolean {
  return left.id === right.id && left.version === right.version;
}

export function compileBuildMode(
  input: CompileBuildModeInput,
  registryInput: BuildCapabilityRegistry = BUILD_CAPABILITY_REGISTRY,
): BuildModeCompilationV1 {
  const registry = validateBuildCapabilityRegistry(registryInput);
  const contentProfile = validateBuildContentProfile(input.content_profile);
  validatePathSafeBuildId(input.book_id, "book_id");
  if (typeof input.source_fingerprint !== "string" || !input.source_fingerprint.trim()) {
    throw new Error("source_fingerprint must be a non-empty string");
  }
  if (!(["read_now", "standard_deep", "goal_directed"] as string[]).includes(input.mode)) {
    throw new Error(`unsupported build mode: ${String(input.mode)}`);
  }
  if (input.mode === "read_now") {
    if (input.intent !== undefined || input.requested_capability_ids?.length) {
      throw new Error("read_now cannot carry an intent or build capability selection");
    }
    return { version: "build_mode_compilation.v1", mode: "read_now" };
  }

  const freshness = validateFreshness(input.public_freshness);
  let intent: BuildIntentV1 | undefined;
  let privateCapabilityIds: PrivateBuildCapabilityId[] = [];
  let publicStages: AutomaticBuildStage[] = [];
  if (input.mode === "standard_deep") {
    if (input.intent !== undefined || input.requested_capability_ids?.length) {
      throw new Error("standard_deep cannot carry a private intent or capability selection");
    }
    publicStages = standardDeepStageClosure(contentProfile, registry);
  } else {
    intent = validateBuildIntentV1(input.intent);
    if (
      intent.book_id !== input.book_id
      || intent.source_fingerprint !== input.source_fingerprint
      || !sameProfile(intent.content_profile, contentProfile)
    ) {
      throw new Error("BuildIntent identity does not match the BuildPlan target");
    }
    if (intent.desired_artifacts.includes("custom")) {
      throw new Error("custom capability requires a user-edited schema and separate confirmation");
    }
    const derivedIds = intent.desired_artifacts.map((artifact) => `private.${artifact}`);
    const requestedIds = input.requested_capability_ids ?? derivedIds;
    privateCapabilityIds = validateRequestedCapabilities(requestedIds, contentProfile, registry);
    if (!sameJson(privateCapabilityIds, derivedIds)) {
      throw new Error("requested capabilities must exactly match BuildIntent desired_artifacts");
    }
  }

  const reusedPublic = publicStages.flatMap((stage) => {
    const artifact = `public.${stage}`;
    const inspection = freshness.get(artifact);
    return inspection?.fresh && inspection.freshness_digest
      ? [{ artifact, freshness_digest: inspection.freshness_digest }]
      : [];
  });
  const publicCreate = publicStages
    .map((stage) => `public.${stage}`)
    .filter((artifact) => !freshness.get(artifact)?.fresh);
  const foundationReuse = input.mode === "goal_directed"
    ? [{
        artifact: "public.foundation",
        freshness_digest: sha256({
          version: "foundation_lid_freshness.v1",
          source_fingerprint: input.source_fingerprint,
          content_profile: contentProfile,
        }),
      }]
    : [];
  const privateCreate = [...privateCapabilityIds];
  const reuse = [...foundationReuse, ...reusedPublic];
  const create = [...publicCreate, ...privateCreate];
  const excluded = (Object.keys(registry) as BuildCapabilityId[])
    .filter((id) => {
      if (input.mode === "standard_deep") return id !== "public.standard_deep";
      return id === "public.standard_deep" || !privateCapabilityIds.includes(id as PrivateBuildCapabilityId);
    })
    .map((artifact) => ({
      artifact,
      reason: input.mode === "standard_deep"
        ? "not selected by standard_deep"
        : "not required by selected capabilities",
    }));
  const estimateInput: BuildPlanEstimateInputV1 = {
    version: "build_plan_estimate_input.v1",
    source_fingerprint: input.source_fingerprint,
    content_profile: contentProfile,
    public_stages_to_create: publicStages.filter((stage) => publicCreate.includes(`public.${stage}`)),
    private_capabilities_to_create: privateCapabilityIds,
    reused_artifacts: reuse.map((artifact) => artifact.artifact),
    ...(intent ? { source_scope: intent.source_scope } : {}),
  };
  const intentDigest = intent ? computeBuildIntentDigest(intent) : undefined;
  const privateArtifacts = intent && intentDigest
    ? privateCapabilityIds.map((id) => {
        const capability = registry[id];
        const artifactType = capability.artifact_type!;
        return {
          artifact_id: `artifact-${artifactType}-${sha256({ intent_digest: intentDigest, capability: id }).slice(0, 12)}`,
          artifact_type: artifactType,
          source_scope: intent.source_scope,
          required_public_capabilities: [...capability.required_public_capabilities],
          evidence_policy: "lid_required" as const,
        };
      })
    : [];
  const plan = attachBuildPlanDigest({
    version: "build_plan.v1",
    plan_id: input.plan_id,
    revision: input.revision,
    book_id: input.book_id,
    source_fingerprint: input.source_fingerprint,
    content_profile: contentProfile,
    recipe_id: input.mode,
    ...(intent && intentDigest ? { intent_id: intent.intent_id, intent_digest: intentDigest } : {}),
    public_stage_closure: publicStages,
    private_artifacts: privateArtifacts,
    reuse,
    create,
    excluded,
    estimate: input.estimate ?? unknownEstimate(estimateInput),
    budget: input.budget,
    status: "draft",
    created_at: input.created_at,
  });
  return {
    version: "build_mode_compilation.v1",
    mode: input.mode,
    plan,
    estimate_input: estimateInput,
  };
}

function validateSelectedBlueprints(
  inputs: readonly ArtifactBlueprintResolutionV1[],
): ArtifactBlueprintResolutionV1[] {
  const selected: ArtifactBlueprintResolutionV1[] = [];
  const identities = new Set<string>();
  for (const input of inputs) {
    if (input.version !== "artifact_blueprint_resolution.v1") {
      throw new Error("unsupported ArtifactBlueprint resolution version");
    }
    const blueprint = validateArtifactBlueprintV1(input.blueprint);
    const digest = computeArtifactBlueprintDigest(blueprint);
    if (input.digest !== digest) throw new Error("ArtifactBlueprint resolution digest mismatch");
    if (input.source !== blueprint.origin) {
      throw new Error("ArtifactBlueprint resolution source does not match snapshot origin");
    }
    const identity = `${blueprint.blueprint_id}\u0000${blueprint.blueprint_version}`;
    if (identities.has(identity)) throw new Error("duplicate selected ArtifactBlueprint identity and version");
    identities.add(identity);
    selected.push({
      version: "artifact_blueprint_resolution.v1",
      source: input.source,
      blueprint,
      digest,
    });
  }
  return selected;
}

function unknownEstimateV2(input: BuildPlanEstimateInputV2): BuildPlanEstimateV1 {
  return {
    input_tokens: { lower: 0, upper: 0, coverage: 0 },
    output_tokens: { lower: 0, upper: 0, coverage: 0 },
    wall_clock_minutes: { confidence: "none" },
    unknown_stages: [
      ...input.public_stages_to_create,
      ...input.private_blueprints_to_create.map((artifact) => `private.${artifact.artifact_id}`),
    ],
    historical_match: { stage: false, policy: false, model: false, harness: false, sample_count: 0 },
  };
}

export function compileBuildModeV2(input: CompileBuildModeV2Input): BuildModeCompilationV2 {
  validateBuildCapabilityRegistry(BUILD_CAPABILITY_REGISTRY);
  const contentProfile = validateBuildContentProfile(input.content_profile);
  validatePathSafeBuildId(input.book_id, "book_id");
  validatePathSafeBuildId(input.plan_id, "plan_id");
  if (typeof input.source_fingerprint !== "string" || !input.source_fingerprint.trim()) {
    throw new Error("source_fingerprint must be a non-empty string");
  }
  if (!( ["read_now", "standard_deep", "goal_directed"] as string[]).includes(input.mode)) {
    throw new Error(`unsupported build mode: ${String(input.mode)}`);
  }
  if (input.mode === "read_now") {
    if (input.intent !== undefined || input.selected_blueprints?.length) {
      throw new Error("read_now cannot carry an intent or ArtifactBlueprint selection");
    }
    return { version: "build_mode_compilation.v2", mode: "read_now" };
  }

  const freshness = validateFreshness(input.public_freshness);
  let intent: BuildIntentV2 | undefined;
  let selectedBlueprints: ArtifactBlueprintResolutionV1[] = [];
  let publicStages: AutomaticBuildStage[] = [];
  if (input.mode === "standard_deep") {
    if (input.intent !== undefined || input.selected_blueprints?.length) {
      throw new Error("standard_deep cannot carry a private intent or ArtifactBlueprint selection");
    }
    publicStages = standardDeepStageClosure(contentProfile);
  } else {
    intent = validateBuildIntentV2(input.intent);
    if (intent.book_id !== input.book_id
      || intent.source_fingerprint !== input.source_fingerprint
      || !sameProfile(intent.content_profile, contentProfile)) {
      throw new Error("BuildIntent identity does not match the BuildPlan target");
    }
    selectedBlueprints = validateSelectedBlueprints(input.selected_blueprints ?? []);
  }

  const reusedPublic = publicStages.flatMap((stage) => {
    const artifact = `public.${stage}`;
    const inspection = freshness.get(artifact);
    return inspection?.fresh && inspection.freshness_digest
      ? [{ artifact, freshness_digest: inspection.freshness_digest }]
      : [];
  });
  const publicCreate = publicStages
    .map((stage) => `public.${stage}`)
    .filter((artifact) => !freshness.get(artifact)?.fresh);
  const intentDigest = intent ? computeBuildIntentDigestV2(intent) : undefined;
  const privateArtifacts = intent && intentDigest
    ? selectedBlueprints.map((resolution, index) => ({
        artifact_id: `artifact-${sha256({
          intent_digest: intentDigest,
          blueprint_digest: resolution.digest,
          index,
        }).slice(0, 20)}`,
        source_scope: intent!.source_scope,
        blueprint: resolution.blueprint,
        blueprint_digest: resolution.digest,
        required_public_capabilities: ["foundation.lid"],
      }))
    : [];
  const foundationReuse = input.mode === "goal_directed" && privateArtifacts.length
    ? [{
        artifact: "public.foundation",
        freshness_digest: sha256({
          version: "foundation_lid_freshness.v1",
          source_fingerprint: input.source_fingerprint,
          content_profile: contentProfile,
        }),
      }]
    : [];
  const reuse = [...foundationReuse, ...reusedPublic];
  const privateCreate = privateArtifacts.map((artifact) => `private.${artifact.artifact_id}`);
  const create = [...publicCreate, ...privateCreate];
  const excluded = input.mode === "standard_deep"
    ? PRIVATE_ARTIFACT_TYPES.map((artifact) => ({
        artifact: `private.${artifact}`,
        reason: "not selected by standard_deep",
      }))
    : [{ artifact: "public.standard_deep", reason: "not required by selected blueprints" }];
  const estimateInput: BuildPlanEstimateInputV2 = {
    version: "build_plan_estimate_input.v2",
    source_fingerprint: input.source_fingerprint,
    content_profile: contentProfile,
    public_stages_to_create: publicStages.filter((stage) => publicCreate.includes(`public.${stage}`)),
    private_blueprints_to_create: privateArtifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      blueprint_digest: artifact.blueprint_digest,
      shape: artifact.blueprint.shape,
      max_records: artifact.blueprint.limits.max_records,
      max_relations: artifact.blueprint.limits.max_relations,
      max_text_chars: artifact.blueprint.limits.max_text_chars,
    })),
    reused_artifacts: reuse.map((artifact) => artifact.artifact),
    ...(intent ? { source_scope: intent.source_scope } : {}),
  };
  const plan = attachBuildPlanDigestV2({
    version: "build_plan.v2",
    plan_id: input.plan_id,
    revision: input.revision,
    book_id: input.book_id,
    source_fingerprint: input.source_fingerprint,
    content_profile: contentProfile,
    recipe_id: input.mode,
    ...(intent && intentDigest ? { intent_id: intent.intent_id, intent_digest: intentDigest } : {}),
    public_stage_closure: publicStages,
    private_artifacts: privateArtifacts,
    reuse,
    create,
    excluded,
    estimate: input.estimate ?? unknownEstimateV2(estimateInput),
    budget: input.budget,
    status: "draft",
    created_at: input.created_at,
  });
  return {
    version: "build_mode_compilation.v2",
    mode: input.mode,
    plan,
    estimate_input: estimateInput,
  };
}
