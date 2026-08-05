import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AutomaticBuildStage,
  AutomaticBuildStageState,
  AutomaticBuildTarget,
  BuildTargetRefV2,
} from "./build-orchestrator";
import {
  automaticBuildGenerationArtifactPath,
  extractionPolicyEqual,
  inspectSemanticArtifact,
  type ExtractionQualityProfile,
  type SemanticArtifactEnvelopeV3,
  type SemanticBuildStage,
} from "./semantic-artifact";
import {
  validateWorkUnitDescriptorV3,
  type WorkUnitDescriptor,
  type WorkUnitDescriptorV3,
} from "./stage-work-unit";
import {
  validateAutomaticBuildStagePolicySet,
  type AutomaticBuildStagePolicySetV2,
} from "./automatic-build-policy-generation";
import type { ModelInputSliceCoverageV1 } from "./model-input-slice";

export const AUTOMATIC_BUILD_QUALITY_GOLDSET = {
  version: "automatic_build_quality_goldset.v1" as const,
  license: "CC0-1.0" as const,
  sha256: "e3bb13945081cac40f593d3082c46df0a10835e295a677de49b6efa2b34eed12",
};

type QualityStage = Exclude<AutomaticBuildStage, "paper_reading_guide">;

interface QualityFloorV1 {
  min_eligible_unit_coverage: number;
  max_low_information_rate: number;
}

const QUALITY_FLOORS: Record<ExtractionQualityProfile, Record<QualityStage, QualityFloorV1>> = {
  full: {
    pass1: { min_eligible_unit_coverage: 0.8, max_low_information_rate: 0.1 },
    paper_metadata: { min_eligible_unit_coverage: 0.5, max_low_information_rate: 0.1 },
    paper_lexicon: { min_eligible_unit_coverage: 0.5, max_low_information_rate: 0.1 },
    profile_sidecar: { min_eligible_unit_coverage: 0.75, max_low_information_rate: 0.1 },
    pass2: { min_eligible_unit_coverage: 1, max_low_information_rate: 0.05 },
    book_structure: { min_eligible_unit_coverage: 1, max_low_information_rate: 0.05 },
  },
  balanced: {
    pass1: { min_eligible_unit_coverage: 0.6, max_low_information_rate: 0.2 },
    paper_metadata: { min_eligible_unit_coverage: 0.5, max_low_information_rate: 0.2 },
    paper_lexicon: { min_eligible_unit_coverage: 0.4, max_low_information_rate: 0.2 },
    profile_sidecar: { min_eligible_unit_coverage: 0.6, max_low_information_rate: 0.2 },
    pass2: { min_eligible_unit_coverage: 0.9, max_low_information_rate: 0.1 },
    book_structure: { min_eligible_unit_coverage: 0.9, max_low_information_rate: 0.1 },
  },
  sparse: {
    pass1: { min_eligible_unit_coverage: 0.4, max_low_information_rate: 0.35 },
    paper_metadata: { min_eligible_unit_coverage: 0.25, max_low_information_rate: 0.35 },
    paper_lexicon: { min_eligible_unit_coverage: 0.25, max_low_information_rate: 0.35 },
    profile_sidecar: { min_eligible_unit_coverage: 0.4, max_low_information_rate: 0.35 },
    pass2: { min_eligible_unit_coverage: 0.75, max_low_information_rate: 0.2 },
    book_structure: { min_eligible_unit_coverage: 0.75, max_low_information_rate: 0.2 },
  },
};

export interface AutomaticBuildQualityFloorInput {
  stage: QualityStage;
  quality_profile: ExtractionQualityProfile;
  eligible_units: number;
  grounded_units: number;
  low_information_items: number;
  total_items: number;
}

export interface AutomaticBuildQualityFloorDecisionV1 {
  status: "passed" | "below_floor";
  floor: QualityFloorV1;
  metrics: {
    eligible_unit_coverage: number;
    empty_unit_rate: number;
    low_information_rate: number;
  };
  violations: Array<"eligible_unit_coverage" | "low_information_rate">;
}

export interface AutomaticBuildStageQualityReportV1 {
  version: "automatic_build_stage_quality_report.v1";
  target_ref: BuildTargetRefV2;
  stage: QualityStage;
  quality_profile: ExtractionQualityProfile;
  goldset: typeof AUTOMATIC_BUILD_QUALITY_GOLDSET;
  accounting: {
    total_units: number;
    eligible_units: number;
    skipped_units: number;
    committed_units: number;
  };
  integrity: {
    status: "passed" | "failed";
    missing_artifacts: number;
    stale_artifacts: number;
    legacy_artifacts: number;
    policy_generations: number;
    artifact_set_digest: string;
    policy_status: "v2_policy_bound" | "legacy_policy_unknown" | "mixed_policy";
    violations: string[];
  };
  quality: AutomaticBuildQualityFloorDecisionV1 & {
    grounded_units: number;
    emitted_items: number;
    low_information_items: number;
  };
  gate_status: "passed" | "integrity_failed" | "quality_below_floor";
  digest: string;
}

export interface AutomaticBuildStageQualityPublicContributorV2 {
  contributor_id: string;
  work_unit_id: string;
  parent_lids: string[];
}

export interface AutomaticBuildStageQualityReductionParentV2 {
  parent_lid: string;
  fragment_work_unit_ids: string[];
  final_work_unit_ids: string[];
}

export interface AutomaticBuildStageQualityRoutingEvidenceV2 {
  policy_set: AutomaticBuildStagePolicySetV2;
  coverage: ModelInputSliceCoverageV1[];
  public_contributors: AutomaticBuildStageQualityPublicContributorV2[];
  reduction_parents: AutomaticBuildStageQualityReductionParentV2[];
}

export interface AutomaticBuildStageQualityReportV2 {
  version: "automatic_build_stage_quality_report.v2";
  target_ref: BuildTargetRefV2;
  stage: QualityStage;
  quality_profile: ExtractionQualityProfile;
  goldset: typeof AUTOMATIC_BUILD_QUALITY_GOLDSET;
  accounting: {
    total_units: number;
    eligible_units: number;
    skipped_units: number;
    committed_units: number;
  };
  routing: {
    policy_set_digest: string;
    eligible_model_units: number;
    proven_model_units: number;
    invalid_or_missing_proofs: number;
  };
  coverage: {
    parent_lids: number;
    expected_core_utf16: number;
    covered_core_utf16: number;
    gap_utf16: number;
    core_overlap_utf16: number;
    coverage_digest: string;
  };
  reduction: {
    fragment_units: number;
    final_units: number;
    missing_or_duplicate_parent_lids: number;
  };
  integrity: {
    status: "passed" | "failed";
    missing_artifacts: number;
    stale_artifacts: number;
    legacy_artifacts: number;
    policy_generations: number;
    artifact_set_digest: string;
    policy_status: "v3_policy_set_bound" | "legacy_policy_unknown" | "mixed_policy";
    violations: string[];
  };
  quality: AutomaticBuildQualityFloorDecisionV1 & {
    grounded_units: number;
    emitted_items: number;
    low_information_items: number;
  };
  gate_status: "passed" | "integrity_failed" | "quality_below_floor";
  digest: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ratio(numerator: number, denominator: number, emptyValue = 1): number {
  return denominator ? numerator / denominator : emptyValue;
}

function assertCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

export function evaluateAutomaticBuildQualityFloor(
  input: AutomaticBuildQualityFloorInput,
): AutomaticBuildQualityFloorDecisionV1 {
  const eligible = assertCount(input.eligible_units, "eligible_units");
  const grounded = assertCount(input.grounded_units, "grounded_units");
  const lowInformation = assertCount(input.low_information_items, "low_information_items");
  const totalItems = assertCount(input.total_items, "total_items");
  if (grounded > eligible) throw new Error("grounded_units must not exceed eligible_units");
  if (lowInformation > totalItems) throw new Error("low_information_items must not exceed total_items");
  const floor = QUALITY_FLOORS[input.quality_profile][input.stage];
  const metrics = {
    eligible_unit_coverage: ratio(grounded, eligible),
    empty_unit_rate: ratio(eligible - grounded, eligible, 0),
    low_information_rate: ratio(lowInformation, totalItems, 0),
  };
  const violations: AutomaticBuildQualityFloorDecisionV1["violations"] = [];
  if (metrics.eligible_unit_coverage < floor.min_eligible_unit_coverage) violations.push("eligible_unit_coverage");
  if (metrics.low_information_rate > floor.max_low_information_rate) violations.push("low_information_rate");
  return { status: violations.length ? "below_floor" : "passed", floor, metrics, violations };
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function lowInformationItems(value: unknown): number {
  const pattern = /(?:以相邻原文为准|结合上下文理解|provides context|as described above|refer to the surrounding text)/i;
  return strings(value).filter((item) => pattern.test(item)).length;
}

function artifactItems(stage: QualityStage, descriptor: WorkUnitDescriptor, payload: unknown): {
  grounded: boolean;
  emitted_items: number;
  low_information_items: number;
} {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  let items: unknown[] = [];
  if (stage === "pass1") items = Array.isArray(value.nodes) ? value.nodes : [];
  else if (stage === "paper_metadata") {
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {};
    items = Object.values(metadata);
  } else if (stage === "paper_lexicon") items = Array.isArray(value.entries) ? value.entries : [];
  else if (stage === "profile_sidecar") {
    items = descriptor.kind === "profile_sidecar_formula"
      ? Array.isArray(value.formula_semantics) ? value.formula_semantics : []
      : Array.isArray(value.discourse_items) ? value.discourse_items : [];
  } else if (stage === "pass2") {
    const output = value.output && typeof value.output === "object" ? value.output as Record<string, unknown> : {};
    items = ["accepted_edges", "pending_edges", "rejected_candidates"]
      .flatMap((key) => Array.isArray(output[key]) ? output[key] as unknown[] : []);
  } else {
    const output = value.output && typeof value.output === "object" ? value.output as Record<string, unknown> : {};
    items = Object.keys(output).length ? [output] : [];
  }
  const emitted = items.length;
  const expected = descriptor.cost.expected_output_items;
  return {
    grounded: stage === "pass2" ? emitted >= expected : emitted > 0,
    emitted_items: emitted,
    low_information_items: lowInformationItems(items),
  };
}

export function automaticBuildStageArtifactPath(
  target: AutomaticBuildTarget,
  stage: QualityStage,
  workUnitId: string,
): string {
  const buildRoot = path.join(target.workspace_dir, ".build");
  switch (stage) {
    case "pass1": return path.join(buildRoot, "pass1", `${workUnitId}.json`);
    case "paper_metadata": return path.join(buildRoot, "paper-metadata", `${workUnitId}.json`);
    case "paper_lexicon": return path.join(buildRoot, "paper-lexicon", `${workUnitId}.json`);
    case "profile_sidecar": return path.join(buildRoot, "profile-sidecar", `${workUnitId}.json`);
    case "pass2": return path.join(buildRoot, "pass2", `${workUnitId}.json`);
    case "book_structure": return workUnitId === "stitch"
      ? path.join(buildRoot, "book-structure", "stitch.json")
      : path.join(buildRoot, "book-structure", "units", `${workUnitId.replace(/^unit:/, "")}.json`);
  }
}

export function evaluateAutomaticBuildStageQuality(input: {
  target_ref: BuildTargetRefV2;
  stage: QualityStage;
  quality_profile: ExtractionQualityProfile;
  work_units: WorkUnitDescriptor[];
  artifacts: Record<string, unknown>;
}): AutomaticBuildStageQualityReportV1 {
  const eligible = input.work_units.filter((unit) => !unit.deterministic_skip);
  let missing = 0;
  let stale = 0;
  let legacy = 0;
  let committed = 0;
  let grounded = 0;
  let emittedItems = 0;
  let lowInformation = 0;
  const policies = new Set<string>();
  const artifactIdentities: Array<{ work_unit_id: string; sha256: string }> = [];
  for (const descriptor of eligible) {
    const artifact = input.artifacts[descriptor.work_unit_id];
    if (artifact === undefined) {
      missing += 1;
      continue;
    }
    const semanticHash = artifact && typeof artifact === "object"
      && (artifact as { version?: unknown }).version === "semantic_task_artifact.v2"
      && typeof (artifact as { artifact_hash?: unknown }).artifact_hash === "string"
      ? (artifact as { artifact_hash: string }).artifact_hash
      : sha256(artifact);
    artifactIdentities.push({ work_unit_id: descriptor.work_unit_id, sha256: semanticHash });
    const inspected = inspectSemanticArtifact(artifact, {
      target: input.target_ref,
      stage: input.stage as SemanticBuildStage,
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      policy_fingerprint: descriptor.policy_fingerprint,
    });
    if (inspected.format === "legacy_v1") {
      legacy += 1;
      continue;
    }
    if (!inspected.policy_fresh || descriptor.policy_fingerprint.quality_profile !== input.quality_profile) {
      stale += 1;
      continue;
    }
    committed += 1;
    policies.add(sha256(descriptor.policy_fingerprint));
    const stats = artifactItems(input.stage, descriptor, inspected.payload);
    if (stats.grounded) grounded += 1;
    emittedItems += stats.emitted_items;
    lowInformation += stats.low_information_items;
  }
  const integrityViolations: string[] = [];
  if (missing) integrityViolations.push("missing_artifacts");
  if (stale) integrityViolations.push("stale_artifacts");
  if (legacy) integrityViolations.push("legacy_policy_unknown");
  if (policies.size > 1) integrityViolations.push("mixed_policy_generation");
  if (committed !== eligible.length) integrityViolations.push("incomplete_eligible_units");
  const policyStatus = legacy && committed
    ? "mixed_policy" as const
    : legacy
      ? "legacy_policy_unknown" as const
      : "v2_policy_bound" as const;
  const quality = evaluateAutomaticBuildQualityFloor({
    stage: input.stage,
    quality_profile: input.quality_profile,
    eligible_units: eligible.length,
    grounded_units: grounded,
    low_information_items: lowInformation,
    total_items: emittedItems,
  });
  const core = {
    version: "automatic_build_stage_quality_report.v1" as const,
    target_ref: input.target_ref,
    stage: input.stage,
    quality_profile: input.quality_profile,
    goldset: AUTOMATIC_BUILD_QUALITY_GOLDSET,
    accounting: {
      total_units: input.work_units.length,
      eligible_units: eligible.length,
      skipped_units: input.work_units.length - eligible.length,
      committed_units: committed,
    },
    integrity: {
      status: integrityViolations.length ? "failed" as const : "passed" as const,
      missing_artifacts: missing,
      stale_artifacts: stale,
      legacy_artifacts: legacy,
      policy_generations: policies.size,
      artifact_set_digest: sha256(artifactIdentities.sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id))),
      policy_status: policyStatus,
      violations: integrityViolations,
    },
    quality: { ...quality, grounded_units: grounded, emitted_items: emittedItems, low_information_items: lowInformation },
    gate_status: integrityViolations.length
      ? "integrity_failed" as const
      : quality.status === "passed"
        ? "passed" as const
        : "quality_below_floor" as const,
  };
  return { ...core, digest: sha256(core) };
}

function sameTargetRef(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function artifactEnvelopeHash(value: unknown): string {
  if (value && typeof value === "object"
    && typeof (value as { artifact_hash?: unknown }).artifact_hash === "string") {
    return (value as { artifact_hash: string }).artifact_hash;
  }
  return sha256(value);
}

function pushViolation(violations: string[], violation: string): void {
  if (!violations.includes(violation)) violations.push(violation);
}

function validCoverageCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Evaluate the BR8 execution-integrity gate without letting fragment or
 * reducer cardinality change the public semantic quality denominator.
 */
export function evaluateAutomaticBuildStageQualityV2(input: {
  target_ref: BuildTargetRefV2;
  stage: QualityStage;
  quality_profile: ExtractionQualityProfile;
  work_units: WorkUnitDescriptorV3[];
  artifacts: Record<string, SemanticArtifactEnvelopeV3<unknown> | unknown>;
  routing: AutomaticBuildStageQualityRoutingEvidenceV2;
}): AutomaticBuildStageQualityReportV2 {
  const integrityViolations: string[] = [];
  const eligibleModelUnits = input.work_units.length;
  const policySetDigest = input.routing.policy_set.policy_set_digest;
  let policySetValid = true;
  try {
    const policySet = validateAutomaticBuildStagePolicySet(input.routing.policy_set);
    if (!sameTargetRef(policySet.target_ref, input.target_ref)
      || policySet.stage !== input.stage) {
      throw new Error("quality policy set identity does not match target or stage");
    }
  } catch {
    policySetValid = false;
    pushViolation(integrityViolations, "policy_set_identity_invalid");
  }

  const descriptorsById = new Map<string, WorkUnitDescriptorV3>();
  let provenModelUnits = 0;
  let invalidOrMissingProofs = 0;
  let invalidProof = false;
  let invalidPolicyMember = false;
  for (const descriptor of input.work_units) {
    if (descriptorsById.has(descriptor.work_unit_id)) {
      invalidOrMissingProofs += 1;
      invalidProof = true;
      continue;
    }
    descriptorsById.set(descriptor.work_unit_id, descriptor);
    try {
      validateWorkUnitDescriptorV3(descriptor);
      if (!sameTargetRef(descriptor.target, input.target_ref)
        || descriptor.stage !== input.stage) {
        throw new Error("quality descriptor identity does not match target or stage");
      }
    } catch {
      invalidOrMissingProofs += 1;
      invalidProof = true;
      continue;
    }
    const member = policySetValid
      ? input.routing.policy_set.members.find((candidate) => candidate.kind === descriptor.kind)
      : undefined;
    if (!member
      || !extractionPolicyEqual(member.policy_fingerprint, descriptor.policy_fingerprint)
      || descriptor.policy_fingerprint.quality_profile !== input.quality_profile) {
      invalidOrMissingProofs += 1;
      invalidPolicyMember = true;
      continue;
    }
    provenModelUnits += 1;
  }
  if (invalidProof) pushViolation(integrityViolations, "budget_proof_invalid");
  if (invalidPolicyMember) pushViolation(integrityViolations, "policy_set_member_invalid");

  let missing = 0;
  let stale = 0;
  let legacy = 0;
  const freshArtifacts = new Map<string, { payload: unknown; artifact_hash: string }>();
  const policyGenerations = new Set<string>();
  const artifactIdentities: Array<{ work_unit_id: string; sha256: string }> = [];
  for (const descriptor of input.work_units) {
    const artifact = input.artifacts[descriptor.work_unit_id];
    if (artifact === undefined) {
      missing += 1;
      continue;
    }
    artifactIdentities.push({
      work_unit_id: descriptor.work_unit_id,
      sha256: artifactEnvelopeHash(artifact),
    });
    if (artifact && typeof artifact === "object"
      && (artifact as { version?: unknown }).version === "semantic_task_artifact.v3"
      && typeof (artifact as { policy_set_digest?: unknown }).policy_set_digest === "string") {
      policyGenerations.add((artifact as { policy_set_digest: string }).policy_set_digest);
    }
    try {
      const inspected = inspectSemanticArtifact(artifact, {
        target: input.target_ref,
        stage: input.stage as SemanticBuildStage,
        work_unit_id: descriptor.work_unit_id,
        input_hash: descriptor.input_hash,
        proof_digest: descriptor.input_budget_proof.proof_digest,
        policy_set_digest: policySetDigest,
        policy_fingerprint: descriptor.policy_fingerprint,
      });
      if (inspected.format === "legacy_v1") {
        legacy += 1;
        continue;
      }
      if (inspected.format !== "v3" || !inspected.policy_fresh) {
        stale += 1;
        continue;
      }
      freshArtifacts.set(descriptor.work_unit_id, {
        payload: inspected.payload,
        artifact_hash: artifactEnvelopeHash(artifact),
      });
    } catch {
      stale += 1;
    }
  }
  if (missing) pushViolation(integrityViolations, "missing_artifacts");
  if (stale) pushViolation(integrityViolations, "stale_artifacts");
  if (legacy) pushViolation(integrityViolations, "legacy_policy_unknown");
  if (freshArtifacts.size !== eligibleModelUnits) {
    pushViolation(integrityViolations, "incomplete_eligible_units");
  }

  const reductionParentIds = new Set(input.routing.reduction_parents.map((parent) => parent.parent_lid));
  const coverageByParent = new Map<string, ModelInputSliceCoverageV1>();
  let coverageInvalid = false;
  for (const coverage of input.routing.coverage) {
    if (coverageByParent.has(coverage.parent_lid)) coverageInvalid = true;
    coverageByParent.set(coverage.parent_lid, coverage);
    const spanLength = coverage.parent_span_utf16.end - coverage.parent_span_utf16.start;
    const sourceSlices = input.work_units.flatMap((descriptor) => (
      descriptor.input_basis.kind === "source_slices"
        ? descriptor.input_basis.slices.filter((slice) => slice.parent_lid === coverage.parent_lid)
        : []
    )).sort((left, right) => left.ordinal - right.ordinal);
    let cursor = coverage.parent_span_utf16.start;
    let actualCovered = 0;
    let actualGap = 0;
    let actualOverlap = 0;
    for (const slice of sourceSlices) {
      if (slice.core_span_utf16.start > cursor) actualGap += slice.core_span_utf16.start - cursor;
      if (slice.core_span_utf16.start < cursor) actualOverlap += cursor - slice.core_span_utf16.start;
      cursor = Math.max(cursor, slice.core_span_utf16.end);
      actualCovered += slice.core_span_utf16.end - slice.core_span_utf16.start;
    }
    if (cursor < coverage.parent_span_utf16.end) actualGap += coverage.parent_span_utf16.end - cursor;
    if (coverage.version !== "model_input_slice_coverage.v1"
      || !coverage.parent_lid
      || !validCoverageCount(coverage.slice_count)
      || !validCoverageCount(coverage.expected_core_utf16)
      || !validCoverageCount(coverage.covered_core_utf16)
      || !validCoverageCount(coverage.gap_utf16)
      || !validCoverageCount(coverage.core_overlap_utf16)
      || !/^[a-f0-9]{64}$/.test(coverage.coverage_digest)
      || spanLength <= 0
      || coverage.expected_core_utf16 !== spanLength
      || coverage.slice_count !== sourceSlices.length
      || sourceSlices.length === 0
      || sourceSlices[0].core_span_utf16.start !== coverage.parent_span_utf16.start
      || sourceSlices.at(-1)!.core_span_utf16.end !== coverage.parent_span_utf16.end
      || coverage.covered_core_utf16 !== actualCovered
      || coverage.gap_utf16 !== actualGap
      || coverage.core_overlap_utf16 !== actualOverlap
      || coverage.covered_core_utf16 !== coverage.expected_core_utf16
      || coverage.gap_utf16 !== 0
      || coverage.core_overlap_utf16 !== 0) {
      coverageInvalid = true;
    }
  }
  for (const parentLid of reductionParentIds) {
    if (!coverageByParent.has(parentLid)) coverageInvalid = true;
  }
  if (coverageInvalid) pushViolation(integrityViolations, "source_slice_coverage_invalid");
  const orderedCoverage = [...coverageByParent.values()]
    .sort((left, right) => left.parent_lid.localeCompare(right.parent_lid));
  const coverageSummary = {
    parent_lids: coverageByParent.size,
    expected_core_utf16: orderedCoverage.reduce((sum, item) => sum + item.expected_core_utf16, 0),
    covered_core_utf16: orderedCoverage.reduce((sum, item) => sum + item.covered_core_utf16, 0),
    gap_utf16: orderedCoverage.reduce((sum, item) => sum + item.gap_utf16, 0),
    core_overlap_utf16: orderedCoverage.reduce((sum, item) => sum + item.core_overlap_utf16, 0),
    coverage_digest: sha256(orderedCoverage),
  };

  const contributorsByParent = new Map<string, AutomaticBuildStageQualityPublicContributorV2[]>();
  let contributorCardinalityInvalid = false;
  const contributorIds = new Set<string>();
  const contributorWorkUnits = new Set<string>();
  for (const contributor of input.routing.public_contributors) {
    if (!contributor.contributor_id || contributorIds.has(contributor.contributor_id)
      || contributorWorkUnits.has(contributor.work_unit_id)
      || !contributor.parent_lids.length
      || new Set(contributor.parent_lids).size !== contributor.parent_lids.length) {
      contributorCardinalityInvalid = true;
    }
    contributorIds.add(contributor.contributor_id);
    contributorWorkUnits.add(contributor.work_unit_id);
    for (const parentLid of contributor.parent_lids) {
      const current = contributorsByParent.get(parentLid) ?? [];
      current.push(contributor);
      contributorsByParent.set(parentLid, current);
    }
  }

  const fragmentIds = new Set<string>();
  const finalIds = new Set<string>();
  const seenReductionParents = new Set<string>();
  let missingOrDuplicateParents = 0;
  let reductionClosureStale = false;
  const dependencyClosureFresh = (finalId: string, expectedFragments: Set<string>): boolean => {
    const pending = [finalId];
    const visited = new Set<string>();
    let fresh = true;
    while (pending.length) {
      const currentId = pending.pop()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const descriptor = descriptorsById.get(currentId);
      const artifact = freshArtifacts.get(currentId);
      if (!descriptor || !artifact) {
        fresh = false;
        continue;
      }
      for (const dependency of descriptor.dependencies) {
        const childArtifact = freshArtifacts.get(dependency.artifact);
        if (!childArtifact || childArtifact.artifact_hash !== dependency.sha256) fresh = false;
        pending.push(dependency.artifact);
      }
    }
    return fresh && [...expectedFragments].every((fragmentId) => visited.has(fragmentId));
  };
  for (const parent of input.routing.reduction_parents) {
    let parentCardinalityInvalid = false;
    if (!parent.parent_lid || seenReductionParents.has(parent.parent_lid)) {
      parentCardinalityInvalid = true;
    }
    seenReductionParents.add(parent.parent_lid);
    const parentFragments = new Set(parent.fragment_work_unit_ids);
    const parentFinals = new Set(parent.final_work_unit_ids);
    parent.fragment_work_unit_ids.forEach((id) => fragmentIds.add(id));
    parent.final_work_unit_ids.forEach((id) => finalIds.add(id));
    const contributors = contributorsByParent.get(parent.parent_lid) ?? [];
    if (!parent.fragment_work_unit_ids.length
      || parentFragments.size !== parent.fragment_work_unit_ids.length
      || parent.final_work_unit_ids.length !== 1
      || parentFinals.size !== parent.final_work_unit_ids.length
      || contributors.length !== 1
      || contributors[0]?.work_unit_id !== parent.final_work_unit_ids[0]) {
      parentCardinalityInvalid = true;
    }
    if (parentCardinalityInvalid) {
      contributorCardinalityInvalid = true;
      missingOrDuplicateParents += 1;
    }
    for (const fragmentId of parentFragments) {
      const descriptor = descriptorsById.get(fragmentId);
      if (!descriptor
        || descriptor.aggregation?.role !== "fragment"
        || descriptor.aggregation.parent_lid !== parent.parent_lid
        || !freshArtifacts.has(fragmentId)) {
        reductionClosureStale = true;
      }
    }
    const finalId = parent.final_work_unit_ids[0];
    if (!finalId) {
      reductionClosureStale = true;
      continue;
    }
    const finalDescriptor = descriptorsById.get(finalId);
    const finalRouteMatchesParent = input.stage === "pass1"
      ? finalDescriptor?.kind === "pass1_lid_stitch"
        && finalDescriptor.evidence_lids.includes(parent.parent_lid)
        && (finalDescriptor.aggregation === undefined
          || finalDescriptor.aggregation.role === "final")
      : finalDescriptor?.aggregation?.role === "final"
        && finalDescriptor.aggregation.parent_lid === parent.parent_lid;
    if (!finalDescriptor
      || finalDescriptor.input_basis.kind !== "artifact_reduction"
      || !finalRouteMatchesParent
      || !dependencyClosureFresh(finalId, parentFragments)) {
      reductionClosureStale = true;
    }
  }
  if (contributorCardinalityInvalid) {
    pushViolation(integrityViolations, "public_contributor_cardinality_invalid");
  }
  if (reductionClosureStale) {
    pushViolation(integrityViolations, "reduction_dependency_closure_stale");
  }

  const reachableWorkUnits = new Set<string>();
  const pendingContributorClosure = input.routing.public_contributors
    .map((contributor) => contributor.work_unit_id);
  let eligibleClosureInvalid = false;
  for (const contributor of input.routing.public_contributors) {
    const descriptor = descriptorsById.get(contributor.work_unit_id);
    if (!descriptor
      || !freshArtifacts.has(contributor.work_unit_id)
      || (descriptor.aggregation !== undefined && descriptor.aggregation.role !== "final")
      || contributor.parent_lids.some((parentLid) => !descriptor.evidence_lids.includes(parentLid))) {
      eligibleClosureInvalid = true;
    }
  }
  while (pendingContributorClosure.length) {
    const workUnitId = pendingContributorClosure.pop()!;
    if (reachableWorkUnits.has(workUnitId)) continue;
    reachableWorkUnits.add(workUnitId);
    const descriptor = descriptorsById.get(workUnitId);
    const artifact = freshArtifacts.get(workUnitId);
    if (!descriptor || !artifact) {
      eligibleClosureInvalid = true;
      continue;
    }
    for (const dependency of descriptor.dependencies) {
      const childArtifact = freshArtifacts.get(dependency.artifact);
      if (!descriptorsById.has(dependency.artifact)
        || !childArtifact
        || childArtifact.artifact_hash !== dependency.sha256) {
        eligibleClosureInvalid = true;
      }
      pendingContributorClosure.push(dependency.artifact);
    }
  }
  if (reachableWorkUnits.size !== eligibleModelUnits) eligibleClosureInvalid = true;
  if (eligibleClosureInvalid) {
    pushViolation(integrityViolations, "incomplete_eligible_closure");
  }

  let grounded = 0;
  let emittedItems = 0;
  let lowInformation = 0;
  let committedContributors = 0;
  for (const contributor of input.routing.public_contributors) {
    const descriptor = descriptorsById.get(contributor.work_unit_id);
    const artifact = freshArtifacts.get(contributor.work_unit_id);
    if (!descriptor || !artifact) continue;
    committedContributors += 1;
    const stats = artifactItems(input.stage, descriptor, artifact.payload);
    if (stats.grounded) grounded += 1;
    emittedItems += stats.emitted_items;
    lowInformation += stats.low_information_items;
  }
  const eligiblePublicContributors = input.routing.public_contributors.length;
  const quality = evaluateAutomaticBuildQualityFloor({
    stage: input.stage,
    quality_profile: input.quality_profile,
    eligible_units: eligiblePublicContributors,
    grounded_units: grounded,
    low_information_items: lowInformation,
    total_items: emittedItems,
  });
  const policyStatus = legacy && freshArtifacts.size
    ? "mixed_policy" as const
    : legacy
      ? "legacy_policy_unknown" as const
      : "v3_policy_set_bound" as const;
  const core = {
    version: "automatic_build_stage_quality_report.v2" as const,
    target_ref: input.target_ref,
    stage: input.stage,
    quality_profile: input.quality_profile,
    goldset: AUTOMATIC_BUILD_QUALITY_GOLDSET,
    accounting: {
      total_units: input.work_units.length,
      eligible_units: eligiblePublicContributors,
      skipped_units: 0,
      committed_units: committedContributors,
    },
    routing: {
      policy_set_digest: policySetDigest,
      eligible_model_units: eligibleModelUnits,
      proven_model_units: provenModelUnits,
      invalid_or_missing_proofs: invalidOrMissingProofs,
    },
    coverage: coverageSummary,
    reduction: {
      fragment_units: fragmentIds.size,
      final_units: finalIds.size,
      missing_or_duplicate_parent_lids: missingOrDuplicateParents,
    },
    integrity: {
      status: integrityViolations.length ? "failed" as const : "passed" as const,
      missing_artifacts: missing,
      stale_artifacts: stale,
      legacy_artifacts: legacy,
      policy_generations: policyGenerations.size,
      artifact_set_digest: sha256(
        artifactIdentities.sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id)),
      ),
      policy_status: policyStatus,
      violations: integrityViolations,
    },
    quality: {
      ...quality,
      grounded_units: grounded,
      emitted_items: emittedItems,
      low_information_items: lowInformation,
    },
    gate_status: integrityViolations.length
      ? "integrity_failed" as const
      : quality.status === "passed"
        ? "passed" as const
        : "quality_below_floor" as const,
  };
  return { ...core, digest: sha256(core) };
}

export function collectAutomaticBuildStageQuality(
  target: AutomaticBuildTarget,
  stageState: AutomaticBuildStageState,
  qualityProfile: ExtractionQualityProfile,
): AutomaticBuildStageQualityReportV1 | AutomaticBuildStageQualityReportV2 {
  if (stageState.stage === "paper_reading_guide") throw new Error("paper_reading_guide has no semantic quality report");
  if (stageState.policy_set || stageState.quality_routing) {
    if (!stageState.policy_set || !stageState.quality_routing) {
      throw new Error(`v3 quality routing is incomplete for stage ${stageState.stage}`);
    }
    const workUnits = stageState.work_units ?? [];
    if (workUnits.some((descriptor) => descriptor.version !== "automatic_build_work_unit.v3")) {
      throw new Error(`v3 quality routing contains a non-v3 descriptor for stage ${stageState.stage}`);
    }
    const artifacts: Record<string, unknown> = {};
    for (const descriptor of workUnits) {
      const file = automaticBuildGenerationArtifactPath(
        target,
        stageState.stage,
        stageState.policy_set.policy_set_digest,
        descriptor.work_unit_id,
      );
      if (existsSync(file)) artifacts[descriptor.work_unit_id] = JSON.parse(readFileSync(file, "utf8"));
    }
    return evaluateAutomaticBuildStageQualityV2({
      target_ref: target.target_ref,
      stage: stageState.stage,
      quality_profile: qualityProfile,
      work_units: workUnits as WorkUnitDescriptorV3[],
      artifacts,
      routing: stageState.quality_routing,
    });
  }
  const artifacts: Record<string, unknown> = {};
  for (const descriptor of stageState.work_units ?? []) {
    if (descriptor.deterministic_skip) continue;
    const file = automaticBuildStageArtifactPath(target, stageState.stage, descriptor.work_unit_id);
    if (existsSync(file)) artifacts[descriptor.work_unit_id] = JSON.parse(readFileSync(file, "utf8"));
  }
  return evaluateAutomaticBuildStageQuality({
    target_ref: target.target_ref,
    stage: stageState.stage,
    quality_profile: qualityProfile,
    work_units: stageState.work_units ?? [],
    artifacts,
  });
}

export function automaticBuildStageQualityReportPath(target: AutomaticBuildTarget, stage: QualityStage): string {
  return path.join(target.workspace_dir, ".build", "automatic-build", "v2", "quality", `${stage}.json`);
}

export function writeAutomaticBuildStageQualityReport(
  target: AutomaticBuildTarget,
  report: AutomaticBuildStageQualityReportV1 | AutomaticBuildStageQualityReportV2,
): string {
  const file = automaticBuildStageQualityReportPath(target, report.stage);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    if (!existsSync(file)) throw error;
    rmSync(file);
    renameSync(temp, file);
  }
  return file;
}
