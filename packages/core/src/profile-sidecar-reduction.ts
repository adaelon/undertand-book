import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z, type ZodTypeAny } from "zod";
import type { AutomaticBuildTarget, BuildTargetRefV2 } from "./build-orchestrator";
import type { ContentProfileDefinition } from "./content-profile";
import type {
  DiscourseMode,
  LocalFunction,
  RhetoricalMove,
  TechnicalLearningDiscourseItem,
  TechnicalLearningDiscourseRelation,
} from "./discourse-index";
import type { LidNode } from "./generated/LidNode";
import {
  evaluateModelInputBudget,
  verifyModelInputBudgetProof,
  type ModelInputBudgetRequestV1,
} from "./model-input-budget";
import {
  renderProfileSidecarModelInput,
  renderProfileSidecarDiscourseFragmentModelInput,
  renderProfileSidecarDiscourseReductionModelInput,
  type ProfileSidecarDiscourseReductionRenderChildV1,
  type ProfileSidecarDiscourseReductionRenderInputV1,
} from "./model-input-renderer";
import { parseExtractorCandidate } from "./extractor-contract";
import {
  routeModelInputSlices,
  validateModelInputSliceCoverage,
  type ModelInputSliceCoverageV1,
  type ModelInputUnsplittableDraftV1,
  type RoutedModelInputSliceV1,
} from "./model-input-slice";
import {
  automaticBuildGenerationArtifactPath,
  automaticBuildExtractionPolicy,
  assertPolicyGenerationId,
  buildSemanticArtifactEnvelopeV3,
  semanticArtifactMatches,
  semanticContractEqual,
  semanticContractFromExtractionPolicy,
  extractionPolicyFromSemanticContract,
  writeAutomaticBuildGenerationArtifact,
  type ExtractionQualityProfile,
  type ExtractionPolicyFingerprintV1,
  type SemanticArtifactProvenanceV2,
  type SemanticArtifactEnvelopeV3,
} from "./semantic-artifact";
import {
  readAutomaticBuildPolicyGeneration,
  type AutomaticBuildStagePolicySetMemberInputV1,
} from "./automatic-build-policy-generation";
import type { ProfileSidecarArtifact } from "./profile-sidecar-build";
import {
  PROFILE_SIDECAR_ROUTER_VERSION,
  buildProfileSidecarSemanticArtifact,
  type ProfileSidecarSemanticPacketV2,
} from "./profile-sidecar-router";
import {
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptorV3,
  validateWorkUnitDescriptorV3,
  type WorkUnitDescriptorV3,
} from "./stage-work-unit";
import {
  DiscourseDirectionZ,
  DiscourseModeZ,
  DiscourseRelationFamilyZ,
  DiscourseRelationTypeZ,
  LocalFunctionZ,
  RhetoricalMoveZ,
} from "./zod";

export const PROFILE_SIDECAR_DISCOURSE_MAP_REDUCE_ROUTER_VERSION =
  "profile_sidecar_discourse_map_reduce.v1" as const;
export const PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION =
  "profile_sidecar_discourse_observation.v1" as const;
export const PROFILE_SIDECAR_DISCOURSE_REDUCE_SCHEMA_VERSION =
  "profile_sidecar_discourse_reduce_output.v1" as const;
export const PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN = 8 as const;
export const PROFILE_SIDECAR_DISCOURSE_FRAGMENT_EXTRACTOR =
  "profile-sidecar-discourse-fragment-extractor" as const;
export const PROFILE_SIDECAR_DISCOURSE_REDUCER =
  "profile-sidecar-discourse-reducer" as const;
export const PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_NAME =
  "profile-sidecar-discourse-fragment-extractor.md" as const;
export const PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_NAME =
  "profile-sidecar-discourse-reducer.md" as const;
export const PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_SHA256 =
  "6a55eab027ec04049bf01bcf3c6a9cd143a8f7023617230416449bac4f89f761" as const;
export const PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_SHA256 =
  "b411666b94c557eb3b9aad21f44285510fd39df0b7fb3ec53004f90208cb6703" as const;

const MAX_LID_BYTES = 256;
const MAX_CANDIDATES_PER_CLASS = 3;
const MAX_SUMMARY_FRAGMENTS = 8;
const MAX_SUMMARY_FRAGMENT_CHARS = 200;
const MAX_RELATION_CANDIDATES = 8;
const MAX_FINAL_RELATIONS = 16;
const MAX_RELATION_EVIDENCE_LIDS = 8;

export interface ProfileSidecarDiscourseCandidateV1<T> {
  value: T;
  confidence: number;
}

export interface ProfileSidecarDiscourseSignalsV1 {
  mode_candidates: Array<ProfileSidecarDiscourseCandidateV1<DiscourseMode>>;
  local_function_candidates: Array<ProfileSidecarDiscourseCandidateV1<LocalFunction>>;
  rhetorical_move_candidates: Array<ProfileSidecarDiscourseCandidateV1<RhetoricalMove>>;
  summary_fragments: string[];
  relation_candidates: TechnicalLearningDiscourseRelation[];
}

export interface ProfileSidecarDiscourseObservationV1 extends ProfileSidecarDiscourseSignalsV1 {
  version: typeof PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION;
  parent_lid: string;
  source_slice_ordinal: number;
  core_sha256: string;
}

export interface ProfileSidecarDiscourseSourceSliceRangeV1 {
  start_ordinal: number;
  end_ordinal_exclusive: number;
}

export interface ProfileSidecarDiscourseReductionV1 extends ProfileSidecarDiscourseSignalsV1 {
  version: "profile_sidecar_discourse_reduction.v1";
  parent_lid: string;
  reducer_level: number;
  source_slice_range: ProfileSidecarDiscourseSourceSliceRangeV1;
}

export interface ProfileSidecarDiscourseFinalOutputV1 {
  discourse_items: [TechnicalLearningDiscourseItem];
}

export type ProfileSidecarDiscourseReduceOutputV1 =
  | { reduction: ProfileSidecarDiscourseReductionV1 }
  | ProfileSidecarDiscourseFinalOutputV1;

export type ProfileSidecarDiscourseRouteV1 =
  | {
      role: "fragment";
      parent_lid: string;
      source_slice_range: ProfileSidecarDiscourseSourceSliceRangeV1;
    }
  | {
      role: "reduce" | "final";
      parent_lid: string;
      reducer_level: number;
      group_ordinal: number;
      source_slice_range: ProfileSidecarDiscourseSourceSliceRangeV1;
      dependency_policy_generations: Array<{
        work_unit_id: string;
        policy_generation_id: string;
      }>;
    };

export interface ProfileSidecarDiscourseShadowWorkUnitV1 {
  descriptor: WorkUnitDescriptorV3;
  rendered_input: string;
  route: ProfileSidecarDiscourseRouteV1;
}

export interface ProfileSidecarDiscourseVerifiedChildV1 {
  work_unit: ProfileSidecarDiscourseShadowWorkUnitV1;
  artifact: SemanticArtifactEnvelopeV3<unknown>;
  payload: ProfileSidecarDiscourseObservationV1 | ProfileSidecarDiscourseReductionV1;
}

export interface ProfileSidecarDiscourseShadowTaskV1 {
  version: "profile_sidecar_discourse_shadow_task.v1";
  target_ref: BuildTargetRefV2;
  source_fingerprint: string;
  policy_generation_id: string;
  fragment_count: number;
  descriptor: WorkUnitDescriptorV3;
  route: ProfileSidecarDiscourseRouteV1;
}

export interface ProfileSidecarSemanticFastPathTaskV1 {
  version: "profile_sidecar_semantic_fast_path_task.v1";
  target_ref: BuildTargetRefV2;
  source_fingerprint: string;
  policy_generation_id: string;
  descriptor: WorkUnitDescriptorV3;
  packet: ProfileSidecarSemanticPacketV2;
}

export type ProfileSidecarProductionTaskV1 =
  | ProfileSidecarDiscourseShadowTaskV1
  | ProfileSidecarSemanticFastPathTaskV1;

export interface ProfileSidecarDiscourseShadowWriteResultV1 {
  version: "profile_sidecar_discourse_shadow_write_result.v1";
  work_unit_id: string;
  role: ProfileSidecarDiscourseRouteV1["role"];
  artifact_path: string;
  artifact_hash: string;
  output_counts: Record<string, number>;
}

export interface ProfileSidecarSemanticFastPathWriteResultV1 {
  version: "profile_sidecar_semantic_fast_path_write_result.v1";
  work_unit_id: string;
  artifact_path: string;
  artifact_hash: string;
  output_counts: Record<string, number>;
}

export interface ProfileSidecarDiscourseShadowFinalCandidateResultV1 {
  version: "profile_sidecar_discourse_shadow_final_candidate.v1";
  work_unit_id: string;
  parent_lid: string;
  candidate_path: string;
  candidate_sha256: string;
  candidate: ProfileSidecarArtifact;
}

export interface ProfileSidecarProductionCandidateResultV1 {
  version: "profile_sidecar_production_candidate.v1";
  work_unit_id: string;
  candidate_path: string;
  candidate_sha256: string;
  candidate: ProfileSidecarArtifact;
}

type ProfileSidecarDiscourseBudgetV1 = Omit<
  ModelInputBudgetRequestV1,
  "rendered_input" | "router_version" | "prompt_sha256"
>;

export function profileSidecarDiscourseFragmentPolicy(
  profile: ContentProfileDefinition,
  qualityProfile: ExtractionQualityProfile = "full",
): ExtractionPolicyFingerprintV1 {
  return {
    profile_id: profile.id,
    profile_version: profile.profile_version,
    stage_policy_version: "profile_sidecar_discourse_fragment_policy.v1",
    router_version: PROFILE_SIDECAR_DISCOURSE_MAP_REDUCE_ROUTER_VERSION,
    prompt_sha256: PROFILE_SIDECAR_DISCOURSE_FRAGMENT_PROMPT_SHA256,
    schema_version: PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION,
    quality_profile: qualityProfile,
  };
}

export function profileSidecarDiscourseReducePolicy(
  profile: ContentProfileDefinition,
  qualityProfile: ExtractionQualityProfile = "full",
): ExtractionPolicyFingerprintV1 {
  return {
    profile_id: profile.id,
    profile_version: profile.profile_version,
    stage_policy_version: "profile_sidecar_discourse_reduce_policy.v1",
    router_version: PROFILE_SIDECAR_DISCOURSE_MAP_REDUCE_ROUTER_VERSION,
    prompt_sha256: PROFILE_SIDECAR_DISCOURSE_REDUCER_PROMPT_SHA256,
    schema_version: PROFILE_SIDECAR_DISCOURSE_REDUCE_SCHEMA_VERSION,
    quality_profile: qualityProfile,
  };
}

export function profileSidecarMapReducePolicyMembers(
  profile: ContentProfileDefinition,
  qualityProfile: ExtractionQualityProfile = "full",
): AutomaticBuildStagePolicySetMemberInputV1[] {
  const existing = automaticBuildExtractionPolicy("profile_sidecar", profile, qualityProfile);
  return [
    {
      kind: "profile_sidecar_discourse",
      extractor: "profile-sidecar-extractor",
      policy_generation_id: `profile-sidecar-discourse.${qualityProfile}.v2`,
      policy_fingerprint: existing,
    },
    {
      kind: "profile_sidecar_discourse_fragment",
      extractor: PROFILE_SIDECAR_DISCOURSE_FRAGMENT_EXTRACTOR,
      policy_generation_id: `profile-sidecar-discourse-fragment.${qualityProfile}.v1`,
      policy_fingerprint: profileSidecarDiscourseFragmentPolicy(profile, qualityProfile),
    },
    {
      kind: "profile_sidecar_discourse_reduce",
      extractor: PROFILE_SIDECAR_DISCOURSE_REDUCER,
      policy_generation_id: `profile-sidecar-discourse-reduce.${qualityProfile}.v1`,
      policy_fingerprint: profileSidecarDiscourseReducePolicy(profile, qualityProfile),
    },
    {
      kind: "profile_sidecar_formula",
      extractor: "profile-sidecar-extractor",
      policy_generation_id: `profile-sidecar-formula.${qualityProfile}.v2`,
      policy_fingerprint: existing,
    },
  ];
}

function shadowWorkUnitFileName(workUnitId: string): string {
  if (!workUnitId || Buffer.byteLength(workUnitId, "utf8") > 512) {
    throw new Error("profile sidecar shadow work_unit_id must be a non-empty bounded string");
  }
  const encoded = encodeURIComponent(workUnitId);
  return Buffer.byteLength(encoded, "utf8") <= 220 ? `${encoded}.json` : `${sha256(workUnitId)}.json`;
}

function sameResolvedTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(",")}`);
}

function assertSourceFingerprint(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error("profile sidecar shadow source_fingerprint must be a non-empty bounded string");
  }
  return value;
}

export function validateProfileSidecarDiscourseShadowTask(
  task: ProfileSidecarDiscourseShadowTaskV1,
  target?: AutomaticBuildTarget,
): ProfileSidecarDiscourseShadowTaskV1 {
  if (!task || typeof task !== "object") throw new Error("profile sidecar shadow task must be an object");
  assertExactKeys(task as unknown as Record<string, unknown>, [
    "version",
    "target_ref",
    "source_fingerprint",
    "policy_generation_id",
    "fragment_count",
    "descriptor",
    "route",
  ], "profile sidecar shadow task");
  if (task.version !== "profile_sidecar_discourse_shadow_task.v1") {
    throw new Error("unsupported profile sidecar shadow task version");
  }
  assertSourceFingerprint(task.source_fingerprint);
  assertPolicyGenerationId(task.policy_generation_id);
  assertPositiveSafeInteger(task.fragment_count, "fragment_count");
  const descriptor = validateWorkUnitDescriptorV3(task.descriptor);
  if (!sameTarget(descriptor.target, task.target_ref)) {
    throw new Error("profile sidecar shadow task target does not match its descriptor");
  }
  if (target && !sameResolvedTarget(task.target_ref, target.target_ref)) {
    throw new Error("profile sidecar shadow task target does not match the current build target");
  }
  const workUnit: ProfileSidecarDiscourseShadowWorkUnitV1 = {
    descriptor,
    rendered_input: "",
    route: task.route,
  };
  assertRouteMatchesDescriptor(workUnit, { verify_rendered_input: false });
  const range = assertRange(task.route.source_slice_range);
  if (range.end_ordinal_exclusive > task.fragment_count) {
    throw new Error("profile sidecar shadow task source range exceeds fragment_count");
  }
  if (task.route.role === "fragment") {
    assertPolicy({ target: task.target_ref, policy: descriptor.policy_fingerprint, role: "fragment" });
  } else {
    assertPolicy({ target: task.target_ref, policy: descriptor.policy_fingerprint, role: "reduce" });
    if (task.route.role === "final"
      && (range.start_ordinal !== 0 || range.end_ordinal_exclusive !== task.fragment_count)) {
      throw new Error("profile sidecar final shadow task must cover every source fragment");
    }
  }
  return task;
}

export function validateProfileSidecarSemanticFastPathTask(
  task: ProfileSidecarSemanticFastPathTaskV1,
  target?: AutomaticBuildTarget,
): ProfileSidecarSemanticFastPathTaskV1 {
  if (!task || typeof task !== "object") throw new Error("profile sidecar fast-path task must be an object");
  assertExactKeys(task as unknown as Record<string, unknown>, [
    "version",
    "target_ref",
    "source_fingerprint",
    "policy_generation_id",
    "descriptor",
    "packet",
  ], "profile sidecar fast-path task");
  if (task.version !== "profile_sidecar_semantic_fast_path_task.v1") {
    throw new Error("unsupported profile sidecar fast-path task version");
  }
  assertSourceFingerprint(task.source_fingerprint);
  assertPolicyGenerationId(task.policy_generation_id);
  const descriptor = validateWorkUnitDescriptorV3(task.descriptor);
  if (!sameTarget(descriptor.target, task.target_ref)
    || descriptor.stage !== "profile_sidecar"
    || descriptor.aggregation !== undefined
    || descriptor.input_basis.kind !== "source_slices"
    || (descriptor.kind !== "profile_sidecar_discourse" && descriptor.kind !== "profile_sidecar_formula")) {
    throw new Error("profile sidecar fast-path descriptor identity is invalid");
  }
  if (target && !sameResolvedTarget(task.target_ref, target.target_ref)) {
    throw new Error("profile sidecar fast-path task target does not match the current build target");
  }
  const packet = task.packet;
  if (packet.version !== "profile_sidecar_semantic_packet.v2"
    || packet.router_version !== PROFILE_SIDECAR_ROUTER_VERSION
    || packet.work_unit_id !== descriptor.work_unit_id
    || packet.unit_kind !== descriptor.kind
    || packet.rendered_input_sha256 !== descriptor.input_hash
    || new Set(packet.visible_lids).size !== packet.visible_lids.length
    || stableJson([...new Set(packet.visible_lids)].sort()) !== stableJson([...descriptor.evidence_lids].sort())) {
    throw new Error("profile sidecar fast-path packet drifted from its descriptor");
  }
  const sliceParents = descriptor.input_basis.slices.map((slice) => slice.parent_lid);
  if (stableJson([...new Set(sliceParents)].sort()) !== stableJson([...packet.visible_lids].sort())
    || descriptor.input_basis.slices.some((slice) => slice.source_fingerprint !== task.source_fingerprint)) {
    throw new Error("profile sidecar fast-path source basis drifted from its packet");
  }
  const renderedInput = renderProfileSidecarModelInput(packet);
  const proof = verifyModelInputBudgetProof(renderedInput, descriptor.input_budget_proof);
  if (proof.rendered_input_sha256 !== descriptor.input_hash
    || proof.estimated_rendered_tokens !== packet.estimated_rendered_tokens) {
    throw new Error("profile sidecar fast-path proof drifted from its packet bytes");
  }
  return task;
}

export function createProfileSidecarSemanticFastPathTask(input: {
  descriptor: WorkUnitDescriptorV3;
  packet: ProfileSidecarSemanticPacketV2;
  source_fingerprint: string;
  policy_generation_id: string;
}): ProfileSidecarSemanticFastPathTaskV1 {
  return validateProfileSidecarSemanticFastPathTask({
    version: "profile_sidecar_semantic_fast_path_task.v1",
    target_ref: input.descriptor.target,
    source_fingerprint: input.source_fingerprint,
    policy_generation_id: input.policy_generation_id,
    descriptor: input.descriptor,
    packet: input.packet,
  });
}

export function createProfileSidecarDiscourseShadowTask(input: {
  work_unit: ProfileSidecarDiscourseShadowWorkUnitV1;
  source_fingerprint: string;
  policy_generation_id: string;
  fragment_count: number;
}): ProfileSidecarDiscourseShadowTaskV1 {
  const task: ProfileSidecarDiscourseShadowTaskV1 = {
    version: "profile_sidecar_discourse_shadow_task.v1",
    target_ref: input.work_unit.descriptor.target,
    source_fingerprint: input.source_fingerprint,
    policy_generation_id: input.policy_generation_id,
    fragment_count: input.fragment_count,
    descriptor: input.work_unit.descriptor,
    route: input.work_unit.route,
  };
  const validated = validateProfileSidecarDiscourseShadowTask(task);
  if (input.work_unit.rendered_input
    && verifyModelInputBudgetProof(
      input.work_unit.rendered_input,
      validated.descriptor.input_budget_proof,
    ).rendered_input_sha256 !== validated.descriptor.input_hash) {
    throw new Error("profile sidecar shadow task rendered input drifted from its descriptor");
  }
  return validated;
}

export function profileSidecarDiscourseShadowTaskPath(
  target: AutomaticBuildTarget,
  policyGenerationId: string,
  workUnitId: string,
): string {
  assertPolicyGenerationId(policyGenerationId);
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "shadow",
    "profile_sidecar",
    policyGenerationId,
    "tasks",
    shadowWorkUnitFileName(workUnitId),
  );
}

export function profileSidecarDiscourseShadowTaskPrivateDirectory(
  target: AutomaticBuildTarget,
  policyGenerationId: string,
  workUnitId: string,
): string {
  assertPolicyGenerationId(policyGenerationId);
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "shadow",
    "profile_sidecar",
    policyGenerationId,
    "mailboxes",
    shadowWorkUnitFileName(workUnitId).replace(/\.json$/u, ""),
  );
}

export function freezeProfileSidecarDiscourseShadowTask(
  target: AutomaticBuildTarget,
  taskInput: ProfileSidecarDiscourseShadowTaskV1,
): string {
  const task = validateProfileSidecarDiscourseShadowTask(taskInput, target);
  const file = profileSidecarDiscourseShadowTaskPath(
    target,
    task.policy_generation_id,
    task.descriptor.work_unit_id,
  );
  const bytes = `${JSON.stringify(task, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    return file;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (readFileSync(file, "utf8") !== bytes) {
      throw new Error(`policy_generation_conflict: profile sidecar shadow task is already frozen: ${file}`);
    }
    return file;
  }
}

export function freezeProfileSidecarSemanticFastPathTask(
  target: AutomaticBuildTarget,
  taskInput: ProfileSidecarSemanticFastPathTaskV1,
): string {
  const task = validateProfileSidecarSemanticFastPathTask(taskInput, target);
  const file = profileSidecarDiscourseShadowTaskPath(
    target,
    task.policy_generation_id,
    task.descriptor.work_unit_id,
  );
  const bytes = `${JSON.stringify(task, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    return file;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (readFileSync(file, "utf8") !== bytes) {
      throw new Error(`policy_generation_conflict: profile sidecar fast-path task is already frozen: ${file}`);
    }
    return file;
  }
}

export function readProfileSidecarDiscourseShadowTask(
  target: AutomaticBuildTarget,
  policyGenerationId: string,
  workUnitId: string,
): ProfileSidecarDiscourseShadowTaskV1 {
  const file = profileSidecarDiscourseShadowTaskPath(target, policyGenerationId, workUnitId);
  if (!existsSync(file)) throw new Error(`profile sidecar shadow task does not exist: ${workUnitId}`);
  return validateProfileSidecarDiscourseShadowTask(
    JSON.parse(readFileSync(file, "utf8")) as ProfileSidecarDiscourseShadowTaskV1,
    target,
  );
}

export function readProfileSidecarProductionTask(
  target: AutomaticBuildTarget,
  policyGenerationId: string,
  workUnitId: string,
): ProfileSidecarProductionTaskV1 {
  const file = profileSidecarDiscourseShadowTaskPath(target, policyGenerationId, workUnitId);
  if (!existsSync(file)) throw new Error(`profile sidecar production task does not exist: ${workUnitId}`);
  const value = JSON.parse(readFileSync(file, "utf8")) as ProfileSidecarProductionTaskV1;
  return value.version === "profile_sidecar_semantic_fast_path_task.v1"
    ? validateProfileSidecarSemanticFastPathTask(value, target)
    : validateProfileSidecarDiscourseShadowTask(value, target);
}

export type ProfileSidecarDiscourseFragmentRouteResultV1 =
  | {
      status: "routed";
      units: ProfileSidecarDiscourseShadowWorkUnitV1[];
      coverage: ModelInputSliceCoverageV1;
    }
  | { status: "blocked"; recovery: ModelInputUnsplittableDraftV1 };

export type ProfileSidecarDiscourseReductionRouteResultV1 =
  | {
      status: "routed";
      reducer_level: number;
      role: "reduce" | "final";
      units: ProfileSidecarDiscourseShadowWorkUnitV1[];
    }
  | { status: "blocked"; recovery: ModelInputUnsplittableDraftV1 };

const boundedLid = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_LID_BYTES,
  `LID must be at most ${MAX_LID_BYTES} UTF-8 bytes`,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const confidence = z.number().min(0).max(1);
const candidate = <T extends ZodTypeAny>(value: T) => z.object({ value, confidence }).strict();
const relationSchema = z.object({
  target_lid: boundedLid,
  type: DiscourseRelationTypeZ,
  family: DiscourseRelationFamilyZ.optional(),
  direction: DiscourseDirectionZ,
  confidence,
  evidence_lids: z.array(boundedLid).min(1).max(MAX_RELATION_EVIDENCE_LIDS),
}).strict();
const signalShape = {
  mode_candidates: z.array(candidate(DiscourseModeZ)).max(MAX_CANDIDATES_PER_CLASS),
  local_function_candidates: z.array(candidate(LocalFunctionZ)).max(MAX_CANDIDATES_PER_CLASS),
  rhetorical_move_candidates: z.array(candidate(RhetoricalMoveZ)).max(MAX_CANDIDATES_PER_CLASS),
  summary_fragments: z.array(z.string().min(1).max(MAX_SUMMARY_FRAGMENT_CHARS)).max(MAX_SUMMARY_FRAGMENTS),
  relation_candidates: z.array(relationSchema).max(MAX_RELATION_CANDIDATES),
};
const sourceSliceRangeSchema = z.object({
  start_ordinal: z.number().int().nonnegative(),
  end_ordinal_exclusive: z.number().int().positive(),
}).strict();
const observationSchema = z.object({
  version: z.literal(PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION),
  parent_lid: boundedLid,
  source_slice_ordinal: z.number().int().nonnegative(),
  core_sha256: sha256Schema,
  ...signalShape,
}).strict();
const reductionSchema = z.object({
  version: z.literal("profile_sidecar_discourse_reduction.v1"),
  parent_lid: boundedLid,
  reducer_level: z.number().int().nonnegative(),
  source_slice_range: sourceSliceRangeSchema,
  ...signalShape,
}).strict();
const finalRelationSchema = relationSchema;
const finalDiscourseItemSchema = z.object({
  lid: boundedLid,
  mode: DiscourseModeZ,
  local_function: LocalFunctionZ.optional(),
  rhetorical_move: RhetoricalMoveZ.optional(),
  local_summary: z.string().min(1).max(MAX_SUMMARY_FRAGMENT_CHARS).optional(),
  relations: z.array(finalRelationSchema).max(MAX_FINAL_RELATIONS),
}).strict();
const reduceOutputSchema = z.union([
  z.object({ reduction: reductionSchema }).strict(),
  z.object({ discourse_items: z.tuple([finalDiscourseItemSchema]) }).strict(),
]);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return sha256(stableJson(value));
}

function assertSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function assertPositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function sameTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return stableJson(left) === stableJson(right);
}

function parseClosed<T>(schema: ZodTypeAny, input: unknown, contract: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data as T;
  const issue = parsed.error.issues[0];
  const path = issue.path.length ? `/${issue.path.join("/")}` : "/";
  throw new Error(`${contract} schema_invalid at ${path}`);
}

function assertRange(
  value: ProfileSidecarDiscourseSourceSliceRangeV1,
  field = "source_slice_range",
): ProfileSidecarDiscourseSourceSliceRangeV1 {
  if (!Number.isSafeInteger(value.start_ordinal)
    || !Number.isSafeInteger(value.end_ordinal_exclusive)
    || value.start_ordinal < 0
    || value.end_ordinal_exclusive <= value.start_ordinal) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function assertAllowedRelations(
  relations: TechnicalLearningDiscourseRelation[],
  sourceLid: string,
  allowedEvidenceLids: string[],
  field: string,
): void {
  const allowed = new Set(allowedEvidenceLids);
  if (!allowed.has(sourceLid)) throw new Error(`${field} parent_lid is outside allowed evidence`);
  for (const [index, relation] of relations.entries()) {
    if (!allowed.has(relation.target_lid)) {
      throw new Error(`${field}/${index}/target_lid is outside allowed evidence`);
    }
    if (relation.evidence_lids.some((lid) => !allowed.has(lid))) {
      throw new Error(`${field}/${index}/evidence_lids are outside allowed evidence`);
    }
    if (!relation.evidence_lids.includes(sourceLid)
      || !relation.evidence_lids.includes(relation.target_lid)) {
      throw new Error(`${field}/${index}/evidence_lids must include source and target`);
    }
  }
}

function assertPolicy(input: {
  target: BuildTargetRefV2;
  policy: ExtractionPolicyFingerprintV1;
  role: "fragment" | "reduce";
}): void {
  const expectedSchema = input.role === "fragment"
    ? PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION
    : PROFILE_SIDECAR_DISCOURSE_REDUCE_SCHEMA_VERSION;
  if (input.policy.profile_id !== input.target.profile_id) {
    throw new Error(`profile sidecar ${input.role} policy profile does not match target`);
  }
  if (input.policy.router_version !== PROFILE_SIDECAR_DISCOURSE_MAP_REDUCE_ROUTER_VERSION) {
    throw new Error(`profile sidecar ${input.role} policy router version is unsupported`);
  }
  if (input.policy.schema_version !== expectedSchema) {
    throw new Error(`profile sidecar ${input.role} policy schema version is unsupported`);
  }
  assertSha256(input.policy.prompt_sha256, `${input.role} policy prompt_sha256`);
}

export function parseProfileSidecarDiscourseFragmentObservation(
  input: unknown,
  context: {
    parent_lid: string;
    source_slice_ordinal: number;
    core_sha256: string;
    allowed_evidence_lids: string[];
  },
): ProfileSidecarDiscourseObservationV1 {
  const parsed = parseClosed<ProfileSidecarDiscourseObservationV1>(
    observationSchema,
    input,
    PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION,
  );
  if (parsed.parent_lid !== context.parent_lid) {
    throw new Error("profile sidecar fragment parent_lid does not match its descriptor");
  }
  if (parsed.source_slice_ordinal !== context.source_slice_ordinal) {
    throw new Error("profile sidecar fragment source_slice_ordinal does not match its descriptor");
  }
  if (parsed.core_sha256 !== assertSha256(context.core_sha256, "fragment context core_sha256")) {
    throw new Error("profile sidecar fragment core_sha256 does not match its source slice");
  }
  assertAllowedRelations(
    parsed.relation_candidates,
    parsed.parent_lid,
    context.allowed_evidence_lids,
    "fragment/relation_candidates",
  );
  return parsed;
}

export function parseProfileSidecarDiscourseReduceOutput(
  input: unknown,
  context: {
    role: "reduce" | "final";
    parent_lid: string;
    reducer_level: number;
    source_slice_range: ProfileSidecarDiscourseSourceSliceRangeV1;
    allowed_evidence_lids: string[];
  },
): ProfileSidecarDiscourseReduceOutputV1 {
  const parsed = parseClosed<ProfileSidecarDiscourseReduceOutputV1>(
    reduceOutputSchema,
    input,
    PROFILE_SIDECAR_DISCOURSE_REDUCE_SCHEMA_VERSION,
  );
  if (context.role === "reduce") {
    if (!("reduction" in parsed)) {
      throw new Error("profile sidecar reduce work unit must emit one bounded reduction");
    }
    const expectedRange = assertRange(context.source_slice_range);
    if (parsed.reduction.parent_lid !== context.parent_lid) {
      throw new Error("profile sidecar reduction parent_lid does not match its descriptor");
    }
    if (parsed.reduction.reducer_level !== context.reducer_level) {
      throw new Error("profile sidecar reduction level does not match its descriptor");
    }
    if (stableJson(parsed.reduction.source_slice_range) !== stableJson(expectedRange)) {
      throw new Error("profile sidecar reduction source_slice_range does not match its children");
    }
    assertAllowedRelations(
      parsed.reduction.relation_candidates,
      parsed.reduction.parent_lid,
      context.allowed_evidence_lids,
      "reduction/relation_candidates",
    );
    return parsed;
  }
  if (!("discourse_items" in parsed)) {
    throw new Error("profile sidecar final reducer must emit exactly one discourse item");
  }
  const item = parsed.discourse_items[0];
  if (item.lid !== context.parent_lid) {
    throw new Error("profile sidecar final discourse item lid does not match parent_lid");
  }
  assertAllowedRelations(item.relations, item.lid, context.allowed_evidence_lids, "discourse_items/0/relations");
  return parsed;
}

function fragmentRenderInput(input: {
  content_profile_id: string;
  source: string;
  routed: RoutedModelInputSliceV1;
}) {
  const slice = input.routed.slice;
  return {
    version: "model_input_slice_render_context.v1" as const,
    content_profile_id: input.content_profile_id,
    parent_lid: slice.parent_lid,
    ordinal: slice.ordinal,
    boundary_kind: slice.boundary_kind,
    core_span_utf16: { ...slice.core_span_utf16 },
    context_span_utf16: { ...slice.context_span_utf16 },
    context_before: input.source.slice(slice.context_span_utf16.start, slice.core_span_utf16.start),
    core: input.source.slice(slice.core_span_utf16.start, slice.core_span_utf16.end),
    context_after: input.source.slice(slice.core_span_utf16.end, slice.context_span_utf16.end),
  };
}

export function buildProfileSidecarDiscourseFragmentWorkUnits(input: {
  target: BuildTargetRefV2;
  source: string;
  source_fingerprint: string;
  parent: LidNode;
  routed_slices: RoutedModelInputSliceV1[];
  policy: ExtractionPolicyFingerprintV1;
}): { units: ProfileSidecarDiscourseShadowWorkUnitV1[]; coverage: ModelInputSliceCoverageV1 } {
  assertPolicy({ target: input.target, policy: input.policy, role: "fragment" });
  const coverage = validateModelInputSliceCoverage({
    source: input.source,
    source_fingerprint: input.source_fingerprint,
    parent: input.parent,
    slices: input.routed_slices.map((item) => item.slice),
  });
  const units = [...input.routed_slices]
    .sort((left, right) => left.slice.ordinal - right.slice.ordinal)
    .map((routed): ProfileSidecarDiscourseShadowWorkUnitV1 => {
      const renderedInput = renderProfileSidecarDiscourseFragmentModelInput(fragmentRenderInput({
        content_profile_id: input.target.profile_id,
        source: input.source,
        routed,
      }));
      if (renderedInput !== routed.rendered_input) {
        throw new Error("profile sidecar fragment bytes drifted from the dedicated renderer");
      }
      const proof = verifyModelInputBudgetProof(renderedInput, routed.proof);
      if (proof.router_version !== input.policy.router_version
        || proof.prompt_sha256 !== input.policy.prompt_sha256) {
        throw new Error("profile sidecar fragment proof does not match its policy");
      }
      const slice = routed.slice;
      const route: ProfileSidecarDiscourseRouteV1 = {
        role: "fragment",
        parent_lid: input.parent.lid,
        source_slice_range: {
          start_ordinal: slice.ordinal,
          end_ordinal_exclusive: slice.ordinal + 1,
        },
      };
      const workUnitId = `profile-sidecar-discourse-fragment-${digest({
        version: "profile_sidecar_discourse_fragment_identity.v1",
        source_fingerprint: slice.source_fingerprint,
        parent_lid: slice.parent_lid,
        ordinal: slice.ordinal,
        core_span_utf16: slice.core_span_utf16,
        context_span_utf16: slice.context_span_utf16,
        core_sha256: slice.core_sha256,
        context_sha256: slice.context_sha256,
      })}`;
      const descriptor = createWorkUnitDescriptorV3({
        target: input.target,
        stage: "profile_sidecar",
        work_unit_id: workUnitId,
        kind: "profile_sidecar_discourse_fragment",
        input_basis: { kind: "source_slices", slices: [slice] },
        input_hash: proof.rendered_input_sha256,
        input_budget_proof: proof,
        policy_fingerprint: input.policy,
        evidence_lids: [input.parent.lid],
        dependencies: [],
        cost: buildWorkUnitCostFromBudgetProof({
          rendered_input: renderedInput,
          proof,
          visible_lids: 1,
          candidate_count: 1,
          expected_output_items: 1,
        }),
        aggregation: { parent_lid: input.parent.lid, role: "fragment" },
      });
      return { descriptor, rendered_input: renderedInput, route };
    });
  return { units, coverage };
}

export function routeProfileSidecarDiscourseFragmentWorkUnits(input: {
  target: BuildTargetRefV2;
  source: string;
  source_fingerprint: string;
  parent: LidNode;
  content_profile_id: string;
  policy: ExtractionPolicyFingerprintV1;
  budget: ProfileSidecarDiscourseBudgetV1;
  context_overlap_utf16?: number;
}): ProfileSidecarDiscourseFragmentRouteResultV1 {
  assertPolicy({ target: input.target, policy: input.policy, role: "fragment" });
  if (input.content_profile_id !== input.target.profile_id) {
    throw new Error("profile sidecar fragment content profile does not match target");
  }
  const routed = routeModelInputSlices({
    source: input.source,
    source_fingerprint: input.source_fingerprint,
    parent: input.parent,
    context_overlap_utf16: input.context_overlap_utf16,
    budget: {
      ...input.budget,
      router_version: input.policy.router_version,
      prompt_sha256: input.policy.prompt_sha256,
    },
    render: (renderContext) => renderProfileSidecarDiscourseFragmentModelInput({
      content_profile_id: input.content_profile_id,
      ...renderContext,
    }),
  });
  if (routed.status === "blocked") return routed;
  const built = buildProfileSidecarDiscourseFragmentWorkUnits({
    target: input.target,
    source: input.source,
    source_fingerprint: input.source_fingerprint,
    parent: input.parent,
    routed_slices: routed.slices,
    policy: input.policy,
  });
  return { status: "routed", ...built };
}

function assertRouteMatchesDescriptor(
  workUnit: ProfileSidecarDiscourseShadowWorkUnitV1,
  options: { verify_rendered_input?: boolean } = {},
): void {
  const descriptor = validateWorkUnitDescriptorV3(workUnit.descriptor);
  if (descriptor.stage !== "profile_sidecar" || !descriptor.aggregation) {
    throw new Error("profile sidecar shadow artifact descriptor is not an aggregate work unit");
  }
  if (descriptor.aggregation.parent_lid !== workUnit.route.parent_lid
    || descriptor.aggregation.role !== workUnit.route.role) {
    throw new Error("profile sidecar shadow route does not match its descriptor aggregation");
  }
  if (workUnit.route.role === "fragment") {
    if (descriptor.kind !== "profile_sidecar_discourse_fragment"
      || descriptor.input_basis.kind !== "source_slices"
      || descriptor.input_basis.slices.length !== 1) {
      throw new Error("profile sidecar fragment shadow route has an invalid descriptor basis");
    }
    const ordinal = descriptor.input_basis.slices[0].ordinal;
    if (workUnit.route.source_slice_range.start_ordinal !== ordinal
      || workUnit.route.source_slice_range.end_ordinal_exclusive !== ordinal + 1) {
      throw new Error("profile sidecar fragment shadow range does not match its source slice");
    }
  } else {
    if (descriptor.kind !== "profile_sidecar_discourse_reduce"
      || descriptor.input_basis.kind !== "artifact_reduction"
      || !("dependency_policy_generations" in workUnit.route)) {
      throw new Error("profile sidecar reducer shadow route has an invalid descriptor basis");
    }
    const generations = workUnit.route.dependency_policy_generations.map((dependency) => ({
      work_unit_id: dependency.work_unit_id,
      policy_generation_id: assertPolicyGenerationId(dependency.policy_generation_id),
    })).sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id));
    if (new Set(generations.map((dependency) => dependency.work_unit_id)).size !== generations.length
      || stableJson(generations.map((dependency) => dependency.work_unit_id))
        !== stableJson(descriptor.input_basis.dependency_artifacts.map((dependency) => dependency.work_unit_id))) {
      throw new Error("profile sidecar reducer dependency generations do not match its descriptor");
    }
  }
  if (options.verify_rendered_input !== false) {
    verifyModelInputBudgetProof(workUnit.rendered_input, descriptor.input_budget_proof);
  }
}

export function verifyProfileSidecarDiscourseShadowArtifact(input: {
  work_unit: ProfileSidecarDiscourseShadowWorkUnitV1;
  artifact: SemanticArtifactEnvelopeV3<unknown>;
  policy_generation_id: string;
}): ProfileSidecarDiscourseVerifiedChildV1 {
  assertPolicyGenerationId(input.policy_generation_id);
  assertRouteMatchesDescriptor(input.work_unit);
  if (input.work_unit.route.role === "final") {
    throw new Error("a final profile sidecar artifact cannot become a reducer child");
  }
  const descriptor = input.work_unit.descriptor;
  if (input.artifact.version !== "semantic_task_artifact.v3"
    || input.artifact.policy_generation_id !== input.policy_generation_id
    || !semanticArtifactMatches(input.artifact, {
      target: descriptor.target,
      stage: "profile_sidecar",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      policy_generation_id: input.policy_generation_id,
      semantic_contract: semanticContractFromExtractionPolicy(descriptor.policy_fingerprint),
    })) {
    throw new Error("profile sidecar child artifact is stale or invalid");
  }
  if (input.work_unit.route.role === "fragment") {
    const slice = descriptor.input_basis.kind === "source_slices"
      ? descriptor.input_basis.slices[0]
      : undefined;
    if (!slice) throw new Error("profile sidecar fragment artifact is missing its source slice");
    const payload = parseProfileSidecarDiscourseFragmentObservation(input.artifact.payload, {
      parent_lid: input.work_unit.route.parent_lid,
      source_slice_ordinal: slice.ordinal,
      core_sha256: slice.core_sha256,
      allowed_evidence_lids: descriptor.evidence_lids,
    });
    return { ...input, payload };
  }
  const parsed = parseProfileSidecarDiscourseReduceOutput(input.artifact.payload, {
    role: "reduce",
    parent_lid: input.work_unit.route.parent_lid,
    reducer_level: input.work_unit.route.reducer_level,
    source_slice_range: input.work_unit.route.source_slice_range,
    allowed_evidence_lids: descriptor.evidence_lids,
  });
  if (!("reduction" in parsed)) throw new Error("profile sidecar child reduction payload is invalid");
  return { ...input, payload: parsed.reduction };
}

function orderedVerifiedChildren(input: {
  children: ProfileSidecarDiscourseVerifiedChildV1[];
  target: BuildTargetRefV2;
  parent_lid: string;
  fragment_count: number;
}): ProfileSidecarDiscourseVerifiedChildV1[] {
  assertPositiveSafeInteger(input.fragment_count, "fragment_count");
  if (input.fragment_count < 2) throw new Error("profile sidecar reduction requires at least two fragments");
  if (!input.children.length) throw new Error("profile sidecar reduction children must not be empty");
  const verified = input.children.map((child) => verifyProfileSidecarDiscourseShadowArtifact({
    work_unit: child.work_unit,
    artifact: child.artifact,
    policy_generation_id: child.artifact.policy_generation_id,
  }));
  const ids = verified.map((child) => child.work_unit.descriptor.work_unit_id);
  if (new Set(ids).size !== ids.length) throw new Error("profile sidecar reduction child work units must be unique");
  for (const child of verified) {
    if (!sameTarget(child.work_unit.descriptor.target, input.target)
      || child.work_unit.route.parent_lid !== input.parent_lid) {
      throw new Error("profile sidecar reduction child target or parent drifted");
    }
  }
  const roles = new Set(verified.map((child) => child.work_unit.route.role));
  if (roles.size !== 1 || roles.has("final")) {
    throw new Error("profile sidecar reduction level must contain one non-final child role");
  }
  if (roles.has("reduce")) {
    const levels = new Set(verified.map((child) => child.work_unit.route.role === "reduce"
      ? child.work_unit.route.reducer_level
      : -1));
    if (levels.size !== 1) throw new Error("profile sidecar reduction children must share one reducer level");
  }
  const ordered = verified.sort((left, right) => {
    const leftRange = left.work_unit.route.source_slice_range;
    const rightRange = right.work_unit.route.source_slice_range;
    return leftRange.start_ordinal - rightRange.start_ordinal
      || leftRange.end_ordinal_exclusive - rightRange.end_ordinal_exclusive
      || left.artifact.artifact_hash.localeCompare(right.artifact.artifact_hash)
      || left.work_unit.descriptor.work_unit_id.localeCompare(right.work_unit.descriptor.work_unit_id);
  });
  let cursor = 0;
  for (const child of ordered) {
    const range = assertRange(child.work_unit.route.source_slice_range, "child source_slice_range");
    if (range.start_ordinal !== cursor) {
      throw new Error("profile sidecar reduction children contain a source-slice gap or overlap");
    }
    cursor = range.end_ordinal_exclusive;
  }
  if (cursor !== input.fragment_count) {
    throw new Error("profile sidecar reduction children do not cover the expected fragment count");
  }
  return ordered;
}

function reducerLevel(children: ProfileSidecarDiscourseVerifiedChildV1[]): number {
  const firstRoute = children[0].work_unit.route;
  return firstRoute.role === "fragment" ? 0 : firstRoute.reducer_level + 1;
}

function reductionBlock(input: {
  parent_lid: string;
  estimated_tokens: number;
  limit_tokens: number;
}): ProfileSidecarDiscourseReductionRouteResultV1 {
  return {
    status: "blocked",
    recovery: {
      version: "automatic_build_recovery_draft.v1",
      phase: "routing",
      code: "model_input_unsplittable",
      parent_lid: input.parent_lid,
      lid_kind: "paragraph",
      reason: "renderer_fixed_overhead",
      estimated_tokens: input.estimated_tokens,
      limit_tokens: input.limit_tokens,
      retryable: false,
    },
  };
}

export function routeProfileSidecarDiscourseReductionLevel(input: {
  target: BuildTargetRefV2;
  parent_lid: string;
  fragment_count: number;
  children: ProfileSidecarDiscourseVerifiedChildV1[];
  policy: ExtractionPolicyFingerprintV1;
  budget: ProfileSidecarDiscourseBudgetV1;
}): ProfileSidecarDiscourseReductionRouteResultV1 {
  assertPolicy({ target: input.target, policy: input.policy, role: "reduce" });
  const children = orderedVerifiedChildren(input);
  const nextReducerLevel = reducerLevel(children);
  const role = children.length <= PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN ? "final" : "reduce";
  const groups: ProfileSidecarDiscourseVerifiedChildV1[][] = [];
  for (let index = 0; index < children.length; index += PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN) {
    groups.push(children.slice(index, index + PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN));
  }
  const units: ProfileSidecarDiscourseShadowWorkUnitV1[] = [];
  for (const [groupOrdinal, group] of groups.entries()) {
    const firstRange = group[0].work_unit.route.source_slice_range;
    const lastRange = group.at(-1)!.work_unit.route.source_slice_range;
    const sourceSliceRange = {
      start_ordinal: firstRange.start_ordinal,
      end_ordinal_exclusive: lastRange.end_ordinal_exclusive,
    };
    const childIdentity = group.map((child) => ({
      work_unit_id: child.work_unit.descriptor.work_unit_id,
      artifact_hash: child.artifact.artifact_hash,
      source_slice_range: child.work_unit.route.source_slice_range,
    }));
    const workUnitId = `profile-sidecar-discourse-${role}-${digest({
      version: "profile_sidecar_discourse_reducer_identity.v1",
      parent_lid: input.parent_lid,
      reducer_level: nextReducerLevel,
      group_ordinal: groupOrdinal,
      role,
      children: childIdentity,
    })}`;
    const renderChildren: ProfileSidecarDiscourseReductionRenderChildV1[] = group.map((child) => ({
      work_unit_id: child.work_unit.descriptor.work_unit_id,
      artifact_hash: child.artifact.artifact_hash,
      source_slice_range: { ...child.work_unit.route.source_slice_range },
      payload: child.payload,
    }));
    const renderInput: ProfileSidecarDiscourseReductionRenderInputV1 = {
      version: "profile_sidecar_discourse_reduction_input.v1",
      work_unit_id: workUnitId,
      parent_lid: input.parent_lid,
      reducer_level: nextReducerLevel,
      group_ordinal: groupOrdinal,
      role,
      source_slice_range: sourceSliceRange,
      children: renderChildren,
    };
    const renderedInput = renderProfileSidecarDiscourseReductionModelInput(renderInput);
    const evaluated = evaluateModelInputBudget({
      ...input.budget,
      rendered_input: renderedInput,
      router_version: input.policy.router_version,
      prompt_sha256: input.policy.prompt_sha256,
    });
    if (evaluated.status === "over_limit") {
      return reductionBlock({
        parent_lid: input.parent_lid,
        estimated_tokens: evaluated.estimated_rendered_tokens,
        limit_tokens: evaluated.effective_body_limit_tokens,
      });
    }
    const proof = evaluated.proof;
    const route: ProfileSidecarDiscourseRouteV1 = {
      role,
      parent_lid: input.parent_lid,
      reducer_level: nextReducerLevel,
      group_ordinal: groupOrdinal,
      source_slice_range: sourceSliceRange,
      dependency_policy_generations: group.map((child) => ({
        work_unit_id: child.work_unit.descriptor.work_unit_id,
        policy_generation_id: child.artifact.policy_generation_id,
      })),
    };
    const dependencies = childIdentity.map((child) => ({
      artifact: child.work_unit_id,
      sha256: child.artifact_hash,
    }));
    const descriptor = createWorkUnitDescriptorV3({
      target: input.target,
      stage: "profile_sidecar",
      work_unit_id: workUnitId,
      kind: "profile_sidecar_discourse_reduce",
      input_basis: {
        kind: "artifact_reduction",
        dependency_artifacts: childIdentity.map((child) => ({
          work_unit_id: child.work_unit_id,
          artifact_hash: child.artifact_hash,
        })),
        parent_lids: [input.parent_lid],
      },
      input_hash: proof.rendered_input_sha256,
      input_budget_proof: proof,
      policy_fingerprint: input.policy,
      evidence_lids: [input.parent_lid],
      dependencies,
      cost: buildWorkUnitCostFromBudgetProof({
        rendered_input: renderedInput,
        proof,
        visible_lids: 1,
        candidate_count: group.length,
        expected_output_items: 1,
      }),
      aggregation: { parent_lid: input.parent_lid, role },
    });
    units.push({ descriptor, rendered_input: renderedInput, route });
  }
  return { status: "routed", reducer_level: nextReducerLevel, role, units };
}

function assertShadowPolicyMember(
  target: AutomaticBuildTarget,
  task: Pick<ProfileSidecarProductionTaskV1, "policy_generation_id" | "descriptor">,
): void {
  const generation = readAutomaticBuildPolicyGeneration(
    target,
    "profile_sidecar",
    task.policy_generation_id,
  );
  if (!generation
    || !semanticContractEqual(
      generation.semantic_contract,
      semanticContractFromExtractionPolicy(task.descriptor.policy_fingerprint),
    )) {
    throw new Error("profile sidecar shadow task is outside the frozen policy set");
  }
}

function assertCurrentShadowSource(
  source: string,
  task: Pick<ProfileSidecarProductionTaskV1, "source_fingerprint">,
): void {
  if (sha256(source) !== task.source_fingerprint) {
    throw new Error("profile sidecar shadow task source fingerprint is stale");
  }
}

function renderShadowFragmentInput(
  source: string,
  task: ProfileSidecarDiscourseShadowTaskV1,
): string {
  const descriptor = task.descriptor;
  if (task.route.role !== "fragment"
    || descriptor.input_basis.kind !== "source_slices"
    || descriptor.input_basis.slices.length !== 1) {
    throw new Error("profile sidecar shadow fragment task has an invalid source basis");
  }
  const slice = descriptor.input_basis.slices[0];
  const core = slice.core_span_utf16;
  const context = slice.context_span_utf16;
  if (slice.source_fingerprint !== task.source_fingerprint
    || slice.parent_lid !== task.route.parent_lid
    || slice.ordinal !== task.route.source_slice_range.start_ordinal) {
    throw new Error("profile sidecar shadow fragment slice identity drifted");
  }
  if (!Number.isSafeInteger(core.start) || !Number.isSafeInteger(core.end)
    || !Number.isSafeInteger(context.start) || !Number.isSafeInteger(context.end)
    || core.start < 0 || core.end <= core.start || core.end > source.length
    || context.start < 0 || context.start > core.start
    || context.end < core.end || context.end > source.length) {
    throw new Error("profile sidecar shadow fragment spans are invalid");
  }
  if (sha256(source.slice(core.start, core.end)) !== slice.core_sha256
    || sha256(source.slice(context.start, context.end)) !== slice.context_sha256) {
    throw new Error("profile sidecar shadow fragment source digest drifted");
  }
  return renderProfileSidecarDiscourseFragmentModelInput({
    version: "model_input_slice_render_context.v1",
    content_profile_id: task.target_ref.profile_id,
    parent_lid: slice.parent_lid,
    ordinal: slice.ordinal,
    boundary_kind: slice.boundary_kind,
    core_span_utf16: { ...core },
    context_span_utf16: { ...context },
    context_before: source.slice(context.start, core.start),
    core: source.slice(core.start, core.end),
    context_after: source.slice(core.end, context.end),
  });
}

interface ShadowReductionDependency {
  child: ProfileSidecarDiscourseReductionRenderChildV1;
  child_role: "fragment" | "reduce";
  reducer_level?: number;
}

function readShadowReductionDependency(input: {
  target: AutomaticBuildTarget;
  task: ProfileSidecarDiscourseShadowTaskV1;
  work_unit_id: string;
  artifact_hash: string;
  policy_generation_id: string;
}): ShadowReductionDependency {
  const file = automaticBuildGenerationArtifactPath(
    input.target,
    "profile_sidecar",
    input.policy_generation_id,
    input.work_unit_id,
  );
  if (!existsSync(file)) throw new Error(`profile sidecar reducer child artifact is missing: ${input.work_unit_id}`);
  const artifact = JSON.parse(readFileSync(file, "utf8")) as SemanticArtifactEnvelopeV3<unknown>;
  if (artifact.version !== "semantic_task_artifact.v3"
    || artifact.stage !== "profile_sidecar"
    || artifact.work_unit_id !== input.work_unit_id
    || artifact.policy_generation_id !== input.policy_generation_id
    || artifact.artifact_hash !== input.artifact_hash
    || !sameResolvedTarget(artifact.target, input.task.target_ref)
    || !semanticArtifactMatches(artifact, {
      target: artifact.target,
      stage: "profile_sidecar",
      work_unit_id: artifact.work_unit_id,
      input_hash: artifact.input_hash,
      policy_generation_id: artifact.policy_generation_id,
      semantic_contract: artifact.semantic_contract,
    })) {
    throw new Error(`profile sidecar reducer child artifact is stale or invalid: ${input.work_unit_id}`);
  }
  const payload = artifact.payload;
  if (typeof payload === "object" && payload !== null
    && (payload as { version?: unknown }).version === PROFILE_SIDECAR_DISCOURSE_FRAGMENT_SCHEMA_VERSION) {
    const raw = payload as ProfileSidecarDiscourseObservationV1;
    assertPolicy({
      target: input.task.target_ref,
      policy: extractionPolicyFromSemanticContract(input.task.target_ref.profile_id, artifact.semantic_contract),
      role: "fragment",
    });
    const parsed = parseProfileSidecarDiscourseFragmentObservation(raw, {
      parent_lid: input.task.route.parent_lid,
      source_slice_ordinal: raw.source_slice_ordinal,
      core_sha256: raw.core_sha256,
      allowed_evidence_lids: [input.task.route.parent_lid],
    });
    return {
      child_role: "fragment",
      child: {
        work_unit_id: artifact.work_unit_id,
        artifact_hash: artifact.artifact_hash,
        source_slice_range: {
          start_ordinal: parsed.source_slice_ordinal,
          end_ordinal_exclusive: parsed.source_slice_ordinal + 1,
        },
        payload: parsed,
      },
    };
  }
  if (typeof payload === "object" && payload !== null && "reduction" in payload) {
    const raw = (payload as { reduction?: ProfileSidecarDiscourseReductionV1 }).reduction;
    if (!raw) throw new Error("profile sidecar reducer child reduction is missing");
    assertPolicy({
      target: input.task.target_ref,
      policy: extractionPolicyFromSemanticContract(input.task.target_ref.profile_id, artifact.semantic_contract),
      role: "reduce",
    });
    const parsed = parseProfileSidecarDiscourseReduceOutput(payload, {
      role: "reduce",
      parent_lid: input.task.route.parent_lid,
      reducer_level: raw.reducer_level,
      source_slice_range: raw.source_slice_range,
      allowed_evidence_lids: [input.task.route.parent_lid],
    });
    if (!("reduction" in parsed)) throw new Error("profile sidecar reducer child payload is not a reduction");
    return {
      child_role: "reduce",
      reducer_level: parsed.reduction.reducer_level,
      child: {
        work_unit_id: artifact.work_unit_id,
        artifact_hash: artifact.artifact_hash,
        source_slice_range: { ...parsed.reduction.source_slice_range },
        payload: parsed.reduction,
      },
    };
  }
  throw new Error("profile sidecar final artifact cannot be used as a reducer child");
}

function renderShadowReductionInput(
  target: AutomaticBuildTarget,
  task: ProfileSidecarDiscourseShadowTaskV1,
): string {
  const route = task.route;
  if (route.role === "fragment"
    || !("dependency_policy_generations" in route)
    || task.descriptor.input_basis.kind !== "artifact_reduction") {
    throw new Error("profile sidecar shadow reducer task has an invalid artifact basis");
  }
  const dependencies = task.descriptor.input_basis.dependency_artifacts.map((dependency) => {
    const policyGenerationId = route.dependency_policy_generations.find(
      (candidate) => candidate.work_unit_id === dependency.work_unit_id,
    )?.policy_generation_id;
    if (!policyGenerationId) {
      throw new Error(`profile sidecar reducer child generation is missing: ${dependency.work_unit_id}`);
    }
    return readShadowReductionDependency({
      target,
      task,
      work_unit_id: dependency.work_unit_id,
      artifact_hash: dependency.artifact_hash,
      policy_generation_id: policyGenerationId,
    });
  });
  if (!dependencies.length || dependencies.length > PROFILE_SIDECAR_DISCOURSE_REDUCE_MAX_CHILDREN) {
    throw new Error("profile sidecar shadow reducer child count is outside the bounded fan-in");
  }
  const roles = new Set(dependencies.map((dependency) => dependency.child_role));
  if (roles.size !== 1) throw new Error("profile sidecar shadow reducer children mix fragment and reduction roles");
  if (roles.has("fragment")) {
    if (route.reducer_level !== 0) {
      throw new Error("profile sidecar fragment children must feed reducer level zero");
    }
  } else {
    const levels = new Set(dependencies.map((dependency) => dependency.reducer_level));
    if (levels.size !== 1 || !levels.has(route.reducer_level - 1)) {
      throw new Error("profile sidecar reduction child level is stale");
    }
  }
  const ordered = dependencies.map((dependency) => dependency.child).sort((left, right) =>
    left.source_slice_range.start_ordinal - right.source_slice_range.start_ordinal
    || left.source_slice_range.end_ordinal_exclusive - right.source_slice_range.end_ordinal_exclusive
    || left.artifact_hash.localeCompare(right.artifact_hash)
    || left.work_unit_id.localeCompare(right.work_unit_id));
  let cursor = route.source_slice_range.start_ordinal;
  for (const child of ordered) {
    const range = assertRange(child.source_slice_range, "shadow reducer child source_slice_range");
    if (range.start_ordinal !== cursor) {
      throw new Error("profile sidecar shadow reducer children contain a source-slice gap or overlap");
    }
    cursor = range.end_ordinal_exclusive;
  }
  if (cursor !== route.source_slice_range.end_ordinal_exclusive) {
    throw new Error("profile sidecar shadow reducer children do not cover the task source range");
  }
  return renderProfileSidecarDiscourseReductionModelInput({
    version: "profile_sidecar_discourse_reduction_input.v1",
    work_unit_id: task.descriptor.work_unit_id,
    parent_lid: route.parent_lid,
    reducer_level: route.reducer_level,
    group_ordinal: route.group_ordinal,
    role: route.role,
    source_slice_range: { ...route.source_slice_range },
    children: ordered,
  });
}

export function replayProfileSidecarDiscourseShadowInput(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarDiscourseShadowTaskV1;
}): ProfileSidecarDiscourseShadowWorkUnitV1 {
  const task = validateProfileSidecarDiscourseShadowTask(input.task, input.target);
  assertShadowPolicyMember(input.target, task);
  assertCurrentShadowSource(input.source, task);
  const renderedInput = task.route.role === "fragment"
    ? renderShadowFragmentInput(input.source, task)
    : renderShadowReductionInput(input.target, task);
  const proof = verifyModelInputBudgetProof(renderedInput, task.descriptor.input_budget_proof);
  if (proof.rendered_input_sha256 !== task.descriptor.input_hash) {
    throw new Error("profile sidecar shadow input hash drifted from its descriptor");
  }
  return { descriptor: task.descriptor, rendered_input: renderedInput, route: task.route };
}

export function replayProfileSidecarSemanticFastPathInput(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarSemanticFastPathTaskV1;
}): { descriptor: WorkUnitDescriptorV3; rendered_input: string; packet: ProfileSidecarSemanticPacketV2 } {
  const task = validateProfileSidecarSemanticFastPathTask(input.task, input.target);
  assertShadowPolicyMember(input.target, task);
  assertCurrentShadowSource(input.source, task);
  if (task.descriptor.input_basis.kind !== "source_slices") {
    throw new Error("profile sidecar fast-path task is missing its source slices");
  }
  for (const slice of task.descriptor.input_basis.slices) {
    const core = slice.core_span_utf16;
    const context = slice.context_span_utf16;
    if (slice.source_fingerprint !== task.source_fingerprint
      || !task.packet.visible_lids.includes(slice.parent_lid)
      || !Number.isSafeInteger(core.start)
      || !Number.isSafeInteger(core.end)
      || !Number.isSafeInteger(context.start)
      || !Number.isSafeInteger(context.end)
      || core.start < 0
      || core.end <= core.start
      || context.start > core.start
      || context.end < core.end
      || context.end > input.source.length
      || sha256(input.source.slice(core.start, core.end)) !== slice.core_sha256
      || sha256(input.source.slice(context.start, context.end)) !== slice.context_sha256) {
      throw new Error("profile sidecar fast-path source slice is stale or invalid");
    }
  }
  const renderedInput = renderProfileSidecarModelInput(task.packet);
  const proof = verifyModelInputBudgetProof(renderedInput, task.descriptor.input_budget_proof);
  if (proof.rendered_input_sha256 !== task.descriptor.input_hash) {
    throw new Error("profile sidecar fast-path input hash drifted from its descriptor");
  }
  return { descriptor: task.descriptor, rendered_input: renderedInput, packet: task.packet };
}

export function writeProfileSidecarSemanticFastPathCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarSemanticFastPathTaskV1;
  candidate: unknown;
  provenance: SemanticArtifactProvenanceV2;
}): ProfileSidecarSemanticFastPathWriteResultV1 {
  const replayed = replayProfileSidecarSemanticFastPathInput(input);
  const output = parseExtractorCandidate("profile_sidecar", input.candidate, {
    allowed_evidence_lids: [...replayed.packet.visible_lids],
    formula_lids: [...replayed.packet.formula_lids],
  });
  const payload = {
    ...buildProfileSidecarSemanticArtifact(replayed.packet, output),
    content_hash: replayed.descriptor.input_hash,
  };
  const envelope = buildSemanticArtifactEnvelopeV3({
    target: replayed.descriptor.target,
    stage: "profile_sidecar",
    work_unit_id: replayed.descriptor.work_unit_id,
    input_hash: replayed.descriptor.input_hash,
    policy_generation_id: input.task.policy_generation_id,
    semantic_contract: semanticContractFromExtractionPolicy(replayed.descriptor.policy_fingerprint),
    provenance: input.provenance,
    payload,
  });
  const artifactPath = writeAutomaticBuildGenerationArtifact(input.target, envelope);
  return {
    version: "profile_sidecar_semantic_fast_path_write_result.v1",
    work_unit_id: replayed.descriptor.work_unit_id,
    artifact_path: artifactPath,
    artifact_hash: envelope.artifact_hash,
    output_counts: {
      discourse_items: payload.discourse_items.length,
      formula_semantics: payload.formula_semantics.length,
    },
  };
}

function parseShadowCandidate(
  task: ProfileSidecarDiscourseShadowTaskV1,
  candidate: unknown,
): ProfileSidecarDiscourseObservationV1 | ProfileSidecarDiscourseReduceOutputV1 {
  if (task.route.role === "fragment") {
    if (task.descriptor.input_basis.kind !== "source_slices") {
      throw new Error("profile sidecar fragment candidate is missing its source slice");
    }
    const slice = task.descriptor.input_basis.slices[0];
    return parseProfileSidecarDiscourseFragmentObservation(candidate, {
      parent_lid: task.route.parent_lid,
      source_slice_ordinal: slice.ordinal,
      core_sha256: slice.core_sha256,
      allowed_evidence_lids: task.descriptor.evidence_lids,
    });
  }
  return parseProfileSidecarDiscourseReduceOutput(candidate, {
    role: task.route.role,
    parent_lid: task.route.parent_lid,
    reducer_level: task.route.reducer_level,
    source_slice_range: task.route.source_slice_range,
    allowed_evidence_lids: task.descriptor.evidence_lids,
  });
}

export function writeProfileSidecarDiscourseShadowCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarDiscourseShadowTaskV1;
  candidate: unknown;
  provenance: SemanticArtifactProvenanceV2;
}): ProfileSidecarDiscourseShadowWriteResultV1 {
  const replayed = replayProfileSidecarDiscourseShadowInput({
    target: input.target,
    source: input.source,
    task: input.task,
  });
  const task = validateProfileSidecarDiscourseShadowTask(input.task, input.target);
  const payload = parseShadowCandidate(task, input.candidate);
  const envelope = buildSemanticArtifactEnvelopeV3({
    target: task.target_ref,
    stage: "profile_sidecar",
    work_unit_id: task.descriptor.work_unit_id,
    input_hash: replayed.descriptor.input_hash,
    policy_generation_id: task.policy_generation_id,
    semantic_contract: semanticContractFromExtractionPolicy(replayed.descriptor.policy_fingerprint),
    provenance: input.provenance,
    payload,
  });
  const artifactPath = writeAutomaticBuildGenerationArtifact(input.target, envelope);
  const outputCounts: Record<string, number> = task.route.role === "fragment"
    ? { observations: 1 }
    : task.route.role === "reduce"
      ? { reductions: 1 }
      : { discourse_items: 1 };
  return {
    version: "profile_sidecar_discourse_shadow_write_result.v1",
    work_unit_id: task.descriptor.work_unit_id,
    role: task.route.role,
    artifact_path: artifactPath,
    artifact_hash: envelope.artifact_hash,
    output_counts: outputCounts,
  };
}

function readProductionTaskArtifact(
  target: AutomaticBuildTarget,
  task: ProfileSidecarProductionTaskV1,
): SemanticArtifactEnvelopeV3<unknown> {
  const file = automaticBuildGenerationArtifactPath(
    target,
    "profile_sidecar",
    task.policy_generation_id,
    task.descriptor.work_unit_id,
  );
  if (!existsSync(file)) throw new Error("profile sidecar shadow artifact does not exist");
  const artifact = JSON.parse(readFileSync(file, "utf8")) as SemanticArtifactEnvelopeV3<unknown>;
  if (!semanticArtifactMatches(artifact, {
    target: task.target_ref,
    stage: "profile_sidecar",
    work_unit_id: task.descriptor.work_unit_id,
    input_hash: task.descriptor.input_hash,
    policy_generation_id: task.policy_generation_id,
    semantic_contract: semanticContractFromExtractionPolicy(task.descriptor.policy_fingerprint),
  })) {
    throw new Error("profile sidecar shadow artifact is stale or invalid");
  }
  return artifact;
}

export function buildProfileSidecarDiscourseFinalCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarDiscourseShadowTaskV1;
}): ProfileSidecarArtifact {
  const replayed = replayProfileSidecarDiscourseShadowInput(input);
  if (replayed.route.role !== "final") {
    throw new Error("only a root final reducer can contribute a public profile candidate");
  }
  const task = validateProfileSidecarDiscourseShadowTask(input.task, input.target);
  if (task.route.role !== "final") {
    throw new Error("only a root final reducer can contribute a public profile candidate");
  }
  const artifact = readProductionTaskArtifact(input.target, task);
  const parsed = parseProfileSidecarDiscourseReduceOutput(artifact.payload, {
    role: "final",
    parent_lid: task.route.parent_lid,
    reducer_level: task.route.reducer_level,
    source_slice_range: task.route.source_slice_range,
    allowed_evidence_lids: task.descriptor.evidence_lids,
  });
  if (!("discourse_items" in parsed)) {
    throw new Error("profile sidecar root reducer did not emit a public discourse item");
  }
  return {
    content_hash: task.descriptor.input_hash,
    discourse_items: parsed.discourse_items,
    formula_semantics: [],
  };
}

export function writeProfileSidecarDiscourseFinalCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarDiscourseShadowTaskV1;
}): ProfileSidecarDiscourseShadowFinalCandidateResultV1 {
  const task = validateProfileSidecarDiscourseShadowTask(input.task, input.target);
  const candidate = buildProfileSidecarDiscourseFinalCandidate(input);
  const directory = profileSidecarDiscourseShadowTaskPrivateDirectory(
    input.target,
    task.policy_generation_id,
    task.descriptor.work_unit_id,
  );
  const candidatePath = path.join(directory, "public-candidate.json");
  const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(candidatePath, bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (readFileSync(candidatePath, "utf8") !== bytes) {
      throw new Error(`policy_generation_conflict: profile sidecar final candidate is already frozen: ${candidatePath}`);
    }
  }
  return {
    version: "profile_sidecar_discourse_shadow_final_candidate.v1",
    work_unit_id: task.descriptor.work_unit_id,
    parent_lid: task.route.parent_lid,
    candidate_path: candidatePath,
    candidate_sha256: sha256(bytes),
    candidate,
  };
}

export function buildProfileSidecarProductionCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarProductionTaskV1;
}): ProfileSidecarArtifact {
  if (input.task.version === "profile_sidecar_discourse_shadow_task.v1") {
    return buildProfileSidecarDiscourseFinalCandidate({
      target: input.target,
      source: input.source,
      task: input.task,
    });
  }
  const replayed = replayProfileSidecarSemanticFastPathInput({
    target: input.target,
    source: input.source,
    task: input.task,
  });
  const task = validateProfileSidecarSemanticFastPathTask(input.task, input.target);
  const artifact = readProductionTaskArtifact(input.target, task);
  if (!artifact.payload || typeof artifact.payload !== "object" || Array.isArray(artifact.payload)) {
    throw new Error("profile sidecar fast-path public artifact payload is invalid");
  }
  const payload = artifact.payload as Record<string, unknown>;
  assertExactKeys(
    payload,
    ["content_hash", "discourse_items", "formula_semantics"],
    "profile sidecar fast-path public artifact",
  );
  if (payload.content_hash !== replayed.descriptor.input_hash
    || !Array.isArray(payload.discourse_items)
    || !Array.isArray(payload.formula_semantics)) {
    throw new Error("profile sidecar fast-path public artifact does not match its current descriptor");
  }
  return {
    content_hash: payload.content_hash,
    discourse_items: payload.discourse_items as ProfileSidecarArtifact["discourse_items"],
    formula_semantics: payload.formula_semantics as ProfileSidecarArtifact["formula_semantics"],
  };
}

export function writeProfileSidecarProductionCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: ProfileSidecarProductionTaskV1;
}): ProfileSidecarProductionCandidateResultV1 {
  const task = input.task.version === "profile_sidecar_semantic_fast_path_task.v1"
    ? validateProfileSidecarSemanticFastPathTask(input.task, input.target)
    : validateProfileSidecarDiscourseShadowTask(input.task, input.target);
  const candidate = buildProfileSidecarProductionCandidate({
    target: input.target,
    source: input.source,
    task,
  });
  const directory = profileSidecarDiscourseShadowTaskPrivateDirectory(
    input.target,
    task.policy_generation_id,
    task.descriptor.work_unit_id,
  );
  const candidatePath = path.join(directory, "public-candidate.json");
  const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(candidatePath, bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (readFileSync(candidatePath, "utf8") !== bytes) {
      throw new Error(`policy_generation_conflict: profile sidecar production candidate is already frozen: ${candidatePath}`);
    }
  }
  return {
    version: "profile_sidecar_production_candidate.v1",
    work_unit_id: task.descriptor.work_unit_id,
    candidate_path: candidatePath,
    candidate_sha256: sha256(bytes),
    candidate,
  };
}

export function assertProfileSidecarDiscourseShadowCandidatePath(input: {
  target: AutomaticBuildTarget;
  task: ProfileSidecarDiscourseShadowTaskV1;
  candidate_path: string;
}): string {
  const task = validateProfileSidecarDiscourseShadowTask(input.task, input.target);
  const directory = path.resolve(profileSidecarDiscourseShadowTaskPrivateDirectory(
    input.target,
    task.policy_generation_id,
    task.descriptor.work_unit_id,
  ));
  const candidatePath = path.resolve(input.candidate_path);
  const relative = path.relative(directory, candidatePath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("profile sidecar shadow candidate must stay inside its task-private mailbox");
  }
  return candidatePath;
}

export function assertProfileSidecarProductionCandidatePath(input: {
  target: AutomaticBuildTarget;
  task: ProfileSidecarProductionTaskV1;
  candidate_path: string;
}): string {
  const task = input.task.version === "profile_sidecar_semantic_fast_path_task.v1"
    ? validateProfileSidecarSemanticFastPathTask(input.task, input.target)
    : validateProfileSidecarDiscourseShadowTask(input.task, input.target);
  const directory = path.resolve(profileSidecarDiscourseShadowTaskPrivateDirectory(
    input.target,
    task.policy_generation_id,
    task.descriptor.work_unit_id,
  ));
  const candidatePath = path.resolve(input.candidate_path);
  const relative = path.relative(directory, candidatePath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("profile sidecar production candidate must stay inside its task-private mailbox");
  }
  return candidatePath;
}
