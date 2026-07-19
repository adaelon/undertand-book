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
  inspectSemanticArtifact,
  type ExtractionQualityProfile,
  type SemanticBuildStage,
} from "./semantic-artifact";
import type { WorkUnitDescriptorV2 } from "./stage-work-unit";

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

function artifactItems(stage: QualityStage, descriptor: WorkUnitDescriptorV2, payload: unknown): {
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
  work_units: WorkUnitDescriptorV2[];
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

export function collectAutomaticBuildStageQuality(
  target: AutomaticBuildTarget,
  stageState: AutomaticBuildStageState,
  qualityProfile: ExtractionQualityProfile,
): AutomaticBuildStageQualityReportV1 {
  if (stageState.stage === "paper_reading_guide") throw new Error("paper_reading_guide has no semantic quality report");
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
  report: AutomaticBuildStageQualityReportV1,
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
