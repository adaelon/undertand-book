import { createHash } from "node:crypto";
import type { BuildTargetRefV2 } from "./build-orchestrator";
import { TECHNICAL_LEARNING_PROFILE, type ContentProfileDefinition } from "./content-profile";
import type { LidNode } from "./generated/LidNode";
import {
  MODEL_INPUT_ESTIMATOR_VERSION,
  validateModelInputBudgetProof,
  verifyModelInputBudgetProof,
  type ModelInputBudgetProofV1,
} from "./model-input-budget";
import { MODEL_INPUT_RENDER_CONTRACT_VERSION } from "./model-input-renderer";
import type { ModelInputSliceV1 } from "./model-input-slice";
import { pass1ContentHash } from "./build-resume";
import { buildProfiledPass1Input } from "./pass1-profile-input";
import type {
  AutomaticBuildTaskPolicyBinding,
  AutomaticBuildTaskPolicyBindingV1,
  AutomaticBuildTaskPolicyBindingV2,
  ExtractionPolicyFingerprintV1,
} from "./semantic-artifact";
import { estimateTokens, type Window } from "./window";

export type WorkUnitStage =
  | "pass1"
  | "paper_metadata"
  | "paper_lexicon"
  | "profile_sidecar"
  | "pass2"
  | "book_structure";

export type WorkUnitKind =
  | "pass1_window"
  | "pass1_source_slice"
  | "pass1_lid_stitch"
  | "metadata_region"
  | "lexicon_candidate_batch"
  | "profile_sidecar_window_v1"
  | "profile_sidecar_discourse"
  | "profile_sidecar_discourse_fragment"
  | "profile_sidecar_discourse_reduce"
  | "profile_sidecar_formula"
  | "discourse_paragraph_group"
  | "formula_context_group"
  | "pass2_candidate_batch"
  | "structure_unit"
  | "structure_stitch";

export interface WorkUnitCostV1 {
  estimated_input_tokens: number;
  visible_lids: number;
  formula_lids: number;
  table_fragments: number;
  candidate_count: number;
  expected_output_items: number;
  score: number;
}

export interface WorkUnitDescriptorV2 {
  version: "automatic_build_work_unit.v2";
  target: BuildTargetRefV2;
  stage: WorkUnitStage;
  work_unit_id: string;
  kind: WorkUnitKind;
  dependencies: Array<{ artifact: string; sha256: string }>;
  input_hash: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  evidence_lids: string[];
  cost: WorkUnitCostV1;
  deterministic_skip?: { code: string; evidence: string[] };
  legacy_artifact_ref?: string;
}

export type ModelInputBasisV1 =
  | { kind: "source_slices"; slices: ModelInputSliceV1[] }
  | {
      kind: "artifact_reduction";
      dependency_artifacts: Array<{ work_unit_id: string; artifact_hash: string }>;
      parent_lids: string[];
    };

export interface WorkUnitDescriptorV3 {
  version: "automatic_build_work_unit.v3";
  target: BuildTargetRefV2;
  stage: WorkUnitStage;
  work_unit_id: string;
  kind: WorkUnitKind;
  input_basis: ModelInputBasisV1;
  input_hash: string;
  input_budget_proof: ModelInputBudgetProofV1;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  evidence_lids: string[];
  dependencies: Array<{ artifact: string; sha256: string }>;
  cost: WorkUnitCostV1;
  aggregation?: { parent_lid: string; role: "fragment" | "reduce" | "final" };
  deterministic_skip?: never;
  legacy_artifact_ref?: never;
}

export type WorkUnitDescriptor = WorkUnitDescriptorV2 | WorkUnitDescriptorV3;

export interface StageWorkUnitRouterRegistration {
  stage: WorkUnitStage;
  router_version: string;
  kind: WorkUnitKind;
  compatibility_mode: boolean;
}

export const STAGE_WORK_UNIT_ROUTERS: Record<WorkUnitStage, StageWorkUnitRouterRegistration> = {
  pass1: { stage: "pass1", router_version: "pass1_window.v1", kind: "pass1_window", compatibility_mode: true },
  paper_metadata: { stage: "paper_metadata", router_version: "paper_metadata_candidate.v2", kind: "metadata_region", compatibility_mode: false },
  paper_lexicon: { stage: "paper_lexicon", router_version: "paper_lexicon_cluster.v3", kind: "lexicon_candidate_batch", compatibility_mode: false },
  profile_sidecar: { stage: "profile_sidecar", router_version: "profile_sidecar_semantic_units.v2", kind: "profile_sidecar_discourse", compatibility_mode: false },
  pass2: { stage: "pass2", router_version: "pass2_candidate_window.v1", kind: "pass2_candidate_batch", compatibility_mode: true },
  book_structure: { stage: "book_structure", router_version: "book_structure_unit.v1", kind: "structure_unit", compatibility_mode: true },
};

function nonNegativeInteger(value: number | undefined, field: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return resolved;
}

function sha256Identity(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function boundedIdentity(value: string, field: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function samePolicy(
  left: ExtractionPolicyFingerprintV1,
  right: ExtractionPolicyFingerprintV1,
): boolean {
  return stableJson(left) === stableJson(right);
}

function normalizedDependencies(
  dependencies: Array<{ artifact: string; sha256: string }>,
): Array<{ artifact: string; sha256: string }> {
  const normalized = dependencies.map((dependency) => ({
    artifact: boundedIdentity(dependency.artifact, "dependency.artifact"),
    sha256: sha256Identity(dependency.sha256, "dependency.sha256"),
  })).sort((left, right) => left.artifact.localeCompare(right.artifact)
    || left.sha256.localeCompare(right.sha256));
  if (new Set(normalized.map((dependency) => dependency.artifact)).size !== normalized.length) {
    throw new Error("work unit dependencies must have unique artifact identities");
  }
  return normalized;
}

function normalizedEvidenceLids(evidenceLids: string[]): string[] {
  const normalized = [...new Set(evidenceLids.map((lid) => boundedIdentity(lid, "evidence_lid")))];
  if (!normalized.length) throw new Error("model work unit evidence_lids must not be empty");
  return normalized;
}

function normalizeInputBasis(inputBasis: ModelInputBasisV1): ModelInputBasisV1 {
  if (inputBasis.kind === "source_slices") {
    if (!inputBasis.slices.length) throw new Error("source_slices input basis must not be empty");
    const slices = inputBasis.slices.map((slice) => ({
      ...slice,
      core_span_utf16: { ...slice.core_span_utf16 },
      context_span_utf16: { ...slice.context_span_utf16 },
    })).sort((left, right) => left.parent_lid.localeCompare(right.parent_lid)
      || left.ordinal - right.ordinal);
    const previousOrdinalByParent = new Map<string, number>();
    for (const slice of slices) {
      if (slice.version !== "model_input_slice.v1") throw new Error("unsupported model input slice version");
      if (!Number.isSafeInteger(slice.ordinal) || slice.ordinal < 0) {
        throw new Error("model input slice ordinal must be a non-negative safe integer");
      }
      const previousOrdinal = previousOrdinalByParent.get(slice.parent_lid);
      if (previousOrdinal !== undefined && slice.ordinal !== previousOrdinal + 1) {
        throw new Error("model input slices must have contiguous ordinals per parent LID");
      }
      previousOrdinalByParent.set(slice.parent_lid, slice.ordinal);
      boundedIdentity(slice.source_fingerprint, "slice.source_fingerprint");
      boundedIdentity(slice.parent_lid, "slice.parent_lid");
      sha256Identity(slice.core_sha256, "slice.core_sha256");
      sha256Identity(slice.context_sha256, "slice.context_sha256");
      if (!Number.isSafeInteger(slice.core_span_utf16.start)
        || !Number.isSafeInteger(slice.core_span_utf16.end)
        || !Number.isSafeInteger(slice.context_span_utf16.start)
        || !Number.isSafeInteger(slice.context_span_utf16.end)
        || slice.core_span_utf16.start < 0
        || slice.core_span_utf16.end <= slice.core_span_utf16.start
        || slice.context_span_utf16.start > slice.core_span_utf16.start
        || slice.context_span_utf16.end < slice.core_span_utf16.end) {
        throw new Error("model input slice spans are invalid");
      }
    }
    return { kind: "source_slices", slices };
  }
  if (inputBasis.kind !== "artifact_reduction") throw new Error("unsupported model input basis");
  if (!inputBasis.dependency_artifacts.length) {
    throw new Error("artifact_reduction input basis must contain dependency artifacts");
  }
  const dependencyArtifacts = inputBasis.dependency_artifacts.map((dependency) => ({
    work_unit_id: boundedIdentity(dependency.work_unit_id, "dependency_artifact.work_unit_id"),
    artifact_hash: sha256Identity(dependency.artifact_hash, "dependency_artifact.artifact_hash"),
  })).sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id)
    || left.artifact_hash.localeCompare(right.artifact_hash));
  if (new Set(dependencyArtifacts.map((dependency) => dependency.work_unit_id)).size !== dependencyArtifacts.length) {
    throw new Error("artifact_reduction dependencies must have unique work_unit_id values");
  }
  const parentLids = normalizedEvidenceLids(inputBasis.parent_lids);
  return { kind: "artifact_reduction", dependency_artifacts: dependencyArtifacts, parent_lids: parentLids };
}

export function buildWorkUnitCost(input: {
  estimated_input_tokens?: number;
  visible_lids?: number;
  formula_lids?: number;
  table_fragments?: number;
  candidate_count?: number;
  expected_output_items?: number;
}): WorkUnitCostV1 {
  const estimatedInputTokens = nonNegativeInteger(input.estimated_input_tokens, "estimated_input_tokens");
  const visibleLids = nonNegativeInteger(input.visible_lids, "visible_lids");
  const formulaLids = nonNegativeInteger(input.formula_lids, "formula_lids");
  const tableFragments = nonNegativeInteger(input.table_fragments, "table_fragments");
  const candidateCount = nonNegativeInteger(input.candidate_count, "candidate_count");
  const expectedOutputItems = nonNegativeInteger(input.expected_output_items, "expected_output_items");
  return {
    estimated_input_tokens: estimatedInputTokens,
    visible_lids: visibleLids,
    formula_lids: formulaLids,
    table_fragments: tableFragments,
    candidate_count: candidateCount,
    expected_output_items: expectedOutputItems,
    score: estimatedInputTokens
      + 40 * expectedOutputItems
      + 80 * formulaLids
      + 60 * tableFragments
      + 30 * candidateCount,
  };
}

export function buildWorkUnitCostFromBudgetProof(input: {
  rendered_input: string;
  proof: ModelInputBudgetProofV1;
  visible_lids?: number;
  formula_lids?: number;
  table_fragments?: number;
  candidate_count?: number;
  expected_output_items?: number;
}): WorkUnitCostV1 {
  if ("estimated_input_tokens" in input) {
    throw new Error("estimated_input_tokens must be derived from the verified budget proof");
  }
  const proof = verifyModelInputBudgetProof(input.rendered_input, input.proof);
  return buildWorkUnitCost({
    estimated_input_tokens: proof.estimated_rendered_tokens,
    visible_lids: input.visible_lids,
    formula_lids: input.formula_lids,
    table_fragments: input.table_fragments,
    candidate_count: input.candidate_count,
    expected_output_items: input.expected_output_items,
  });
}

export function createWorkUnitDescriptor(
  input: Omit<WorkUnitDescriptorV2, "version" | "dependencies"> & {
    dependencies?: WorkUnitDescriptorV2["dependencies"];
  },
): WorkUnitDescriptorV2 {
  if (!input.work_unit_id) throw new Error("work_unit_id must not be empty");
  if (!input.input_hash) throw new Error("input_hash must not be empty");
  if (input.target.profile_id !== input.policy_fingerprint.profile_id) {
    throw new Error("work unit target profile does not match policy profile");
  }
  const router = STAGE_WORK_UNIT_ROUTERS[input.stage];
  if (!router) throw new Error(`unregistered work-unit router: ${input.stage}`);
  if (input.policy_fingerprint.router_version !== router.router_version) {
    throw new Error(`work unit policy router mismatch: ${input.policy_fingerprint.router_version} != ${router.router_version}`);
  }
  const deterministicSkip = input.deterministic_skip
    ?? (input.stage === "pass2"
      && input.kind === "pass2_candidate_batch"
      && input.cost.candidate_count === 0
      ? { code: "no_long_range_candidates", evidence: input.evidence_lids }
      : undefined);
  return {
    version: "automatic_build_work_unit.v2",
    target: input.target,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    kind: input.kind,
    dependencies: [...(input.dependencies ?? [])].sort((left, right) => left.artifact.localeCompare(right.artifact)),
    input_hash: input.input_hash,
    policy_fingerprint: input.policy_fingerprint,
    evidence_lids: [...new Set(input.evidence_lids)],
    cost: input.cost,
    ...(deterministicSkip ? { deterministic_skip: {
      code: deterministicSkip.code,
      evidence: [...deterministicSkip.evidence],
    } } : {}),
    ...(input.legacy_artifact_ref ? { legacy_artifact_ref: input.legacy_artifact_ref } : {}),
  };
}

export function isWorkUnitDescriptorV3(
  descriptor: WorkUnitDescriptor,
): descriptor is WorkUnitDescriptorV3 {
  return descriptor.version === "automatic_build_work_unit.v3";
}

export function validateWorkUnitDescriptorV3(
  descriptor: WorkUnitDescriptorV3,
): WorkUnitDescriptorV3 {
  if (descriptor.version !== "automatic_build_work_unit.v3") {
    throw new Error("unsupported v3 work-unit descriptor version");
  }
  boundedIdentity(descriptor.work_unit_id, "work_unit_id");
  sha256Identity(descriptor.input_hash, "input_hash");
  if (descriptor.target.profile_id !== descriptor.policy_fingerprint.profile_id) {
    throw new Error("work unit target profile does not match policy profile");
  }
  const proof = validateModelInputBudgetProof(descriptor.input_budget_proof);
  if (descriptor.input_hash !== proof.rendered_input_sha256) {
    throw new Error("v3 work unit input_hash does not match its budget proof");
  }
  if (proof.router_version !== descriptor.policy_fingerprint.router_version) {
    throw new Error("v3 work unit proof router does not match its policy");
  }
  if (proof.prompt_sha256 !== descriptor.policy_fingerprint.prompt_sha256) {
    throw new Error("v3 work unit proof prompt does not match its policy");
  }
  if (proof.estimator_version !== MODEL_INPUT_ESTIMATOR_VERSION) {
    throw new Error("v3 work unit budget estimator is not supported by this release");
  }
  if (proof.render_contract_version !== MODEL_INPUT_RENDER_CONTRACT_VERSION) {
    throw new Error("v3 work unit render contract is not supported by this release");
  }
  if (descriptor.cost.estimated_input_tokens !== proof.estimated_rendered_tokens) {
    throw new Error("v3 work unit cost is not derived from its budget proof");
  }
  const expectedCost = buildWorkUnitCost({
    estimated_input_tokens: descriptor.cost.estimated_input_tokens,
    visible_lids: descriptor.cost.visible_lids,
    formula_lids: descriptor.cost.formula_lids,
    table_fragments: descriptor.cost.table_fragments,
    candidate_count: descriptor.cost.candidate_count,
    expected_output_items: descriptor.cost.expected_output_items,
  });
  if (stableJson(expectedCost) !== stableJson(descriptor.cost)) {
    throw new Error("v3 work unit cost score is inconsistent with its dimensions");
  }
  const evidenceLids = normalizedEvidenceLids(descriptor.evidence_lids);
  const dependencies = normalizedDependencies(descriptor.dependencies);
  const inputBasis = normalizeInputBasis(descriptor.input_basis);
  const basisParentLids = inputBasis.kind === "source_slices"
    ? inputBasis.slices.map((slice) => slice.parent_lid)
    : inputBasis.parent_lids;
  if (basisParentLids.some((lid) => !evidenceLids.includes(lid))) {
    throw new Error("v3 work unit input basis contains a parent outside evidence_lids");
  }
  if (inputBasis.kind === "artifact_reduction") {
    for (const dependency of inputBasis.dependency_artifacts) {
      if (!dependencies.some((candidate) => candidate.artifact === dependency.work_unit_id
        && candidate.sha256 === dependency.artifact_hash)) {
        throw new Error("artifact_reduction dependency is not bound by descriptor dependencies");
      }
    }
  }
  if (descriptor.aggregation) {
    boundedIdentity(descriptor.aggregation.parent_lid, "aggregation.parent_lid");
    if (!evidenceLids.includes(descriptor.aggregation.parent_lid)) {
      throw new Error("aggregation parent_lid must be present in evidence_lids");
    }
    if (descriptor.aggregation.role === "fragment" && inputBasis.kind !== "source_slices") {
      throw new Error("fragment aggregation requires a source_slices input basis");
    }
    if (descriptor.aggregation.role === "reduce" && inputBasis.kind !== "artifact_reduction") {
      throw new Error("reduce aggregation requires an artifact_reduction input basis");
    }
  }
  return descriptor;
}

export function createWorkUnitDescriptorV3(
  input: Omit<WorkUnitDescriptorV3, "version" | "dependencies"> & {
    dependencies?: WorkUnitDescriptorV3["dependencies"];
  },
): WorkUnitDescriptorV3 {
  const descriptor: WorkUnitDescriptorV3 = {
    version: "automatic_build_work_unit.v3",
    target: input.target,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    kind: input.kind,
    input_basis: normalizeInputBasis(input.input_basis),
    input_hash: input.input_hash,
    input_budget_proof: input.input_budget_proof,
    policy_fingerprint: input.policy_fingerprint,
    evidence_lids: normalizedEvidenceLids(input.evidence_lids),
    dependencies: normalizedDependencies(input.dependencies ?? []),
    cost: input.cost,
    ...(input.aggregation ? { aggregation: { ...input.aggregation } } : {}),
  };
  return validateWorkUnitDescriptorV3(descriptor);
}

export function taskPolicyBindingForWorkUnit(
  descriptor: WorkUnitDescriptorV2,
): AutomaticBuildTaskPolicyBindingV1;
export function taskPolicyBindingForWorkUnit(
  descriptor: WorkUnitDescriptorV3,
  policySetDigest: string,
): AutomaticBuildTaskPolicyBindingV2;
export function taskPolicyBindingForWorkUnit(
  descriptor: WorkUnitDescriptor,
  policySetDigest?: string,
): AutomaticBuildTaskPolicyBinding {
  if (!isWorkUnitDescriptorV3(descriptor)) {
    return {
      input_hash: descriptor.input_hash,
      policy_fingerprint: descriptor.policy_fingerprint,
    };
  }
  validateWorkUnitDescriptorV3(descriptor);
  return {
    input_hash: descriptor.input_hash,
    proof_digest: descriptor.input_budget_proof.proof_digest,
    policy_set_digest: sha256Identity(policySetDigest ?? "", "policy_set_digest"),
    policy_fingerprint: descriptor.policy_fingerprint,
  };
}

export function validateWorkUnitTaskPolicyBinding(
  descriptor: WorkUnitDescriptor,
  binding: AutomaticBuildTaskPolicyBinding,
): AutomaticBuildTaskPolicyBinding {
  if (isWorkUnitDescriptorV3(descriptor)) {
    validateWorkUnitDescriptorV3(descriptor);
    if (!("proof_digest" in binding) || !("policy_set_digest" in binding)) {
      throw new Error("v3 work unit requires an automatic build task policy binding v2");
    }
    sha256Identity(binding.proof_digest, "binding.proof_digest");
    sha256Identity(binding.policy_set_digest, "binding.policy_set_digest");
    if (binding.input_hash !== descriptor.input_hash
      || binding.proof_digest !== descriptor.input_budget_proof.proof_digest
      || !samePolicy(binding.policy_fingerprint, descriptor.policy_fingerprint)) {
      throw new Error("v3 work unit policy binding drifted from its descriptor");
    }
    return binding;
  }
  if ("proof_digest" in binding || "policy_set_digest" in binding) {
    throw new Error("v2 work unit cannot use a v3 task policy binding");
  }
  if (binding.input_hash !== descriptor.input_hash
    || !samePolicy(binding.policy_fingerprint, descriptor.policy_fingerprint)) {
    throw new Error("v2 work unit policy binding drifted from its descriptor");
  }
  return binding;
}

export function routerVersionForStage(stage: WorkUnitStage): string {
  return STAGE_WORK_UNIT_ROUTERS[stage].router_version;
}

export function routePass1WindowWorkUnits(input: {
  target: BuildTargetRefV2;
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  content_profile?: ContentProfileDefinition;
  on_profiled_input?: (
    window: Window,
    packet: ReturnType<typeof buildProfiledPass1Input>,
  ) => void;
}): WorkUnitDescriptorV2[] {
  const contentProfile = input.content_profile ?? TECHNICAL_LEARNING_PROFILE;
  return input.windows.map((window) => {
    const packet = buildProfiledPass1Input(window, input.byLid, input.source, contentProfile);
    input.on_profiled_input?.(window, packet);
    const formulaLids = window.leafLids.filter((lid) => input.byLid.get(lid)?.kind === "formula").length;
    const tableFragments = window.leafLids.filter((lid) => input.byLid.get(lid)?.kind === "table").length;
    return createWorkUnitDescriptor({
      target: input.target,
      stage: "pass1",
      work_unit_id: String(window.id),
      kind: "pass1_window",
      input_hash: pass1ContentHash(packet),
      policy_fingerprint: input.policy_fingerprint,
      evidence_lids: window.leafLids,
      cost: buildWorkUnitCost({
        estimated_input_tokens: estimateTokens(packet.text),
        visible_lids: window.leafLids.length,
        formula_lids: formulaLids,
        table_fragments: tableFragments,
        expected_output_items: window.leafLids.length,
      }),
      legacy_artifact_ref: `.build/pass1/${window.id}.json`,
    });
  });
}

export function accountWorkUnits(
  units: WorkUnitDescriptor[],
  committedIds: ReadonlySet<string>,
): { total: number; pending: number; committed: number; skipped: number } {
  let pending = 0;
  let committed = 0;
  let skipped = 0;
  for (const unit of units) {
    if (unit.deterministic_skip) skipped += 1;
    else if (committedIds.has(unit.work_unit_id)) committed += 1;
    else pending += 1;
  }
  return { total: units.length, pending, committed, skipped };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function workUnitPlanDigest(units: WorkUnitDescriptor[]): string {
  const ordered = [...units].sort((left, right) => left.stage.localeCompare(right.stage)
    || left.work_unit_id.localeCompare(right.work_unit_id));
  return createHash("sha256").update(stableJson(ordered)).digest("hex");
}
