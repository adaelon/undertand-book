import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { deriveBookId } from "./book-id";
import {
  canonicalBuildJson,
  computeBuildPlanDigest,
  validateBuildPlanV1,
  type BuildPlanDigestSource,
  type BuildPlanV1,
} from "./build-intent";
import { standardDeepStageClosure } from "./build-capability";
import { BUILD_STAGE_DAG, type BuildStageId } from "./build-workbench";
import { assertTrustedPaperProjectionSource } from "./paper-projection-chain";
import { resolveContentProfile, type ContentProfileId } from "./content-profile";
import { markdownToBlocks } from "./md-adapter";
import { epubToSource } from "./epub-adapter";
import { segment } from "./segment";
import { splitWindows } from "./window";
import { computeBuildStatus, type Pass1Artifact, type Pass1ArtifactMeta } from "./build-resume";
import { pass1ContentHash } from "./build-resume";
import { buildPass1Input } from "./pass1-input";
import { buildProfiledPass1Input } from "./pass1-profile-input";
import { mergeAndGate } from "./merge";
import { computePaperMetadataRoutingStatus, routePaperMetadataWorkUnits } from "./paper-metadata-router";
import { computePaperLexiconRoutingStatus, routePaperLexiconWorkUnits } from "./paper-lexicon-router";
import {
  PROFILE_SIDECAR_ROUTER_VERSION,
  analyzeProfileSidecarSemanticUnits,
  type ProfileSidecarSemanticPacketV2,
} from "./profile-sidecar-router";
import { buildPass2Candidates, buildPass2WorkPacket, computePass2Status, pass2PacketHash } from "./pass2-orchestrate";
import type { Pass2WorkPacket } from "./pass2-build";
import { buildInputFingerprintHash } from "./build-workbench";
import type { BuildInputFingerprint } from "./source-reconciliation";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { TechnicalLearningDiscourseIndex } from "./discourse-index";
import {
  bookStructureStitchHash,
  bookStructureUnitHash,
  buildBookStructureStitchPacket,
  buildBookStructureUnitSources,
  computeBookStructureStatus,
  type BookStructureStitchArtifact,
  type BookStructureUnitArtifact,
} from "./book-structure";
import {
  automaticBuildExtractionPolicy,
  automaticBuildGenerationArtifactPath,
  extractionPolicyDigest,
  inspectSemanticArtifact,
  readAutomaticBuildStagePolicyLock,
  semanticArtifactMatches,
  type AutomaticBuildTaskPolicyBinding,
  type AutomaticBuildTaskPolicyBindingV1,
  type ExtractionQualityProfile,
  type SemanticArtifactEnvelopeV3,
  type SemanticArtifactExpectation,
  type SemanticBuildStage,
} from "./semantic-artifact";
import {
  buildWorkUnitCost,
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptor,
  createWorkUnitDescriptorV3,
  routePass1WindowWorkUnits,
  taskPolicyBindingForWorkUnit,
  type WorkUnitDescriptor,
  type WorkUnitDescriptorV2,
  type WorkUnitDescriptorV3,
  type WorkUnitKind,
  type WorkUnitStage,
} from "./stage-work-unit";
import { estimateTokens } from "./window";
import {
  renderPass1ModelInput,
  renderProfileSidecarModelInput,
  inspectRenderedModelInput,
  type ModelInputRenderRequest,
} from "./model-input-renderer";
import { evaluateModelInputBudget } from "./model-input-budget";
import {
  blockedAutomaticBuildRoute,
  createAutomaticBuildRecoveryEnvelope,
  readyAutomaticBuildRoute,
  type AutomaticBuildRecoveryEnvelopeV1,
  type AutomaticBuildRouteResult,
} from "./automatic-build-recovery";
import {
  automaticBuildTaskPolicyBindingFromLease,
  inspectAutomaticBuildTaskClaim,
} from "./automatic-build-lease";
import { listAutomaticBuildStoredAttempts } from "./automatic-build-task-store";
import { automaticBuildLegacyStageArtifactPath } from "./automatic-build-legacy";
import {
  AutomaticBuildPolicyGenerationConflictError,
  createAutomaticBuildStagePolicySet,
  materializeAdoptedAutomaticBuildGenerationArtifact,
  recordAutomaticBuildPolicyMigration,
  type AutomaticBuildPolicyMigrationCurrent,
  type AutomaticBuildPolicyMigrationPreviousV2,
  type AutomaticBuildStagePolicySetV2,
} from "./automatic-build-policy-generation";
import {
  createPass1ShadowTask,
  freezePass1ShadowTask,
  pass1LidStitchPolicy,
  pass1ModelSlicePolicyMembers,
  projectPass1AdoptedWholeArtifact,
  pass1SourceFragmentPolicy,
  routePass1ShadowWorkUnits,
  routePass1StitchLevel,
  verifyPass1ShadowArtifact,
  type Pass1ShadowTaskV1,
  type Pass1ShadowVerifiedChildV1,
  type Pass1ShadowWorkUnitV1,
} from "./pass1-reduction";
import {
  createProfileSidecarDiscourseShadowTask,
  createProfileSidecarSemanticFastPathTask,
  freezeProfileSidecarDiscourseShadowTask,
  freezeProfileSidecarSemanticFastPathTask,
  profileSidecarDiscourseFragmentPolicy,
  profileSidecarDiscourseReducePolicy,
  profileSidecarMapReducePolicyMembers,
  routeProfileSidecarDiscourseFragmentWorkUnits,
  routeProfileSidecarDiscourseReductionLevel,
  verifyProfileSidecarDiscourseShadowArtifact,
  type ProfileSidecarDiscourseShadowTaskV1,
  type ProfileSidecarDiscourseShadowWorkUnitV1,
  type ProfileSidecarDiscourseVerifiedChildV1,
  type ProfileSidecarSemanticFastPathTaskV1,
} from "./profile-sidecar-reduction";
import type {
  AutomaticBuildStageQualityReportV2,
  AutomaticBuildStageQualityRoutingEvidenceV2,
} from "./automatic-build-quality";
import {
  AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1,
  AUTOMATIC_BUILD_ROUTING_RELEASE,
} from "./automatic-build-protocol";

export type AutomaticBuildStage =
  | "pass1"
  | "paper_metadata"
  | "paper_lexicon"
  | "profile_sidecar"
  | "pass2"
  | "book_structure"
  | "paper_reading_guide";

export type SemanticExtractor =
  | "pass1-local-extractor"
  | "pass1-source-fragment-extractor"
  | "pass1-lid-stitcher"
  | "paper-metadata-extractor"
  | "paper-lexicon-extractor"
  | "profile-sidecar-discourse-fragment-extractor"
  | "profile-sidecar-discourse-reducer"
  | "profile-sidecar-extractor"
  | "pass2-longrange-linker"
  | "book-structure-extractor";

export interface AutomaticBuildTarget {
  kind: "paper_workspace" | "source_file";
  profile_id: ContentProfileId;
  book_id: string;
  root_dir: string;
  workspace_dir: string;
  source_path: string;
  target_ref: BuildTargetRefV2;
}

export interface AutomaticBuildTargetResolutionOptions {
  book_id?: string;
}

export interface BuildTargetRefV2 {
  version: "build_target_ref.v2";
  workspace_dir: string;
  book_id: string;
  profile_id: ContentProfileId;
  input_fingerprint: string;
}

export type AutomaticBuildGenerationTaskV1 =
  | { kind: "pass1"; task: Pass1ShadowTaskV1 }
  | { kind: "profile_sidecar_discourse"; task: ProfileSidecarDiscourseShadowTaskV1 }
  | { kind: "profile_sidecar_fast_path"; task: ProfileSidecarSemanticFastPathTaskV1 };

export interface AutomaticBuildStageState {
  stage: AutomaticBuildStage;
  pending_tasks: string[];
  closed: boolean;
  task_bindings?: Record<string, AutomaticBuildTaskPolicyBinding>;
  work_units?: WorkUnitDescriptor[];
  pending_work_units?: WorkUnitDescriptor[];
  policy_set?: AutomaticBuildStagePolicySetV2;
  quality_routing?: AutomaticBuildStageQualityRoutingEvidenceV2;
  generation_tasks?: Record<string, AutomaticBuildGenerationTaskV1>;
}

export interface AutomaticBuildSnapshot {
  target: AutomaticBuildTarget;
  stages: AutomaticBuildStageState[];
}

export interface AutomaticBuildStageFreshnessInspectionV1 {
  version: "automatic_build_stage_freshness.v1";
  artifact: `public.${AutomaticBuildStage}`;
  stage: AutomaticBuildStage;
  fresh: boolean;
  freshness_digest?: string;
}

export function inspectAutomaticBuildStageFreshness(
  snapshot: AutomaticBuildSnapshot,
  options: { quality_profile?: ExtractionQualityProfile } = {},
): AutomaticBuildStageFreshnessInspectionV1[] {
  const profile = resolveContentProfile(snapshot.target.profile_id);
  const qualityProfile = options.quality_profile ?? "full";
  return snapshot.stages.map((state) => {
    const policyDigest = state.policy_set?.policy_set_digest ?? (state.stage === "paper_reading_guide"
      ? createHash("sha256").update("paper_reading_guide_verification.v1", "utf8").digest("hex")
      : extractionPolicyDigest(automaticBuildExtractionPolicy(state.stage, profile, qualityProfile)));
    const freshnessDigest = state.closed
      ? createHash("sha256").update(canonicalBuildJson({
          version: state.policy_set
            ? "automatic_build_stage_freshness_identity.v2"
            : "automatic_build_stage_freshness_identity.v1",
          target: snapshot.target.target_ref,
          stage: state.stage,
          policy_digest: policyDigest,
        }), "utf8").digest("hex")
      : undefined;
    return {
      version: "automatic_build_stage_freshness.v1",
      artifact: `public.${state.stage}`,
      stage: state.stage,
      fresh: state.closed,
      ...(freshnessDigest ? { freshness_digest: freshnessDigest } : {}),
    };
  });
}

interface LoadedAutomaticBook {
  source: string;
  lidNodes: ReturnType<typeof segment>;
  byLid: Map<string, ReturnType<typeof segment>[number]>;
  windows: ReturnType<typeof splitWindows>;
}

class AutomaticBuildSnapshotRecoverySignal extends Error {
  readonly name = "AutomaticBuildSnapshotRecoverySignal";

  constructor(readonly recovery: AutomaticBuildRecoveryEnvelopeV1) {
    super(`automatic build snapshot blocked: ${recovery.code}`);
  }
}

function assertNoActiveLegacyGenerationLease(
  target: AutomaticBuildTarget,
  stage: "pass1" | "profile_sidecar",
): void {
  const workUnitIds = [...new Set(
    listAutomaticBuildStoredAttempts(target, stage).map((attempt) => attempt.work_unit_id),
  )].sort();
  const affectedWorkUnits: Array<{ work_unit_id: string; evidence_lids: string[] }> = [];
  for (const workUnitId of workUnitIds) {
    const inspection = inspectAutomaticBuildTaskClaim(target, stage, workUnitId);
    if (inspection.status !== "already_leased") continue;
    const binding = automaticBuildTaskPolicyBindingFromLease(inspection.lease);
    if (binding && "proof_digest" in binding) continue;
    affectedWorkUnits.push({ work_unit_id: workUnitId, evidence_lids: [] });
  }
  if (!affectedWorkUnits.length) return;
  throw new AutomaticBuildSnapshotRecoverySignal(createAutomaticBuildRecoveryEnvelope({
    phase: "migration",
    code: "policy_generation_migration_required",
    stage,
    target_ref: target.target_ref,
    affected_work_units: affectedWorkUnits,
    retryable: true,
    recovery_actions: ["retry_plan"],
  }));
}

const AUTOMATIC_BUILD_SHADOW_STAGE_INPUT_LIMIT_TOKENS = 5_000;
const AUTOMATIC_BUILD_V3_MODEL_BUDGET = AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1;

function canonicalSourceFingerprint(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function currentV3QualityReportPassed(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policySetDigest: string,
  qualityProfile: ExtractionQualityProfile,
): boolean {
  const file = path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "quality",
    `${stage}.json`,
  );
  if (!existsSync(file)) return false;
  try {
    const report = readJson<AutomaticBuildStageQualityReportV2>(file);
    const { digest, ...core } = report;
    const reportDigest = createHash("sha256").update(JSON.stringify(core), "utf8").digest("hex");
    const exactKeys = (value: object, expected: string[]): boolean => (
      Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
    );
    const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
    return report.version === "automatic_build_stage_quality_report.v2"
      && exactKeys(report, [
        "version",
        "target_ref",
        "stage",
        "quality_profile",
        "goldset",
        "accounting",
        "routing",
        "coverage",
        "reduction",
        "integrity",
        "quality",
        "gate_status",
        "digest",
      ])
      && canonicalBuildJson(report.target_ref) === canonicalBuildJson(target.target_ref)
      && report.stage === stage
      && report.quality_profile === qualityProfile
      && report.gate_status === "passed"
      && report.routing.policy_set_digest === policySetDigest
      && count(report.routing.eligible_model_units)
      && report.routing.proven_model_units === report.routing.eligible_model_units
      && report.routing.invalid_or_missing_proofs === 0
      && report.coverage.covered_core_utf16 === report.coverage.expected_core_utf16
      && report.coverage.gap_utf16 === 0
      && report.coverage.core_overlap_utf16 === 0
      && report.reduction.missing_or_duplicate_parent_lids === 0
      && report.integrity.status === "passed"
      && report.integrity.missing_artifacts === 0
      && report.integrity.stale_artifacts === 0
      && report.integrity.legacy_artifacts === 0
      && report.integrity.policy_generations === 1
      && report.integrity.policy_status === "v3_policy_set_bound"
      && report.integrity.violations.length === 0
      && report.quality.status === "passed"
      && report.quality.violations.length === 0
      && /^[a-f0-9]{64}$/u.test(digest)
      && digest === reportDigest;
  } catch {
    return false;
  }
}

type AutomaticBuildProductionMigrationDecision =
  | "unmanaged"
  | "adopt_exact"
  | "rebuild"
  | "deterministic_skip";

function productionMigrationRecoveryCode(
  reason: string,
): AutomaticBuildRecoveryEnvelopeV1["code"] {
  if (reason === "budget_proof_invalid") return "budget_proof_invalid";
  if (reason === "model_input_unsplittable") return "model_input_unsplittable";
  if (reason === "policy_generation_conflict") return "policy_generation_conflict";
  return "policy_generation_migration_required";
}

function productionMigrationRecoveryActions(
  reason: string,
): AutomaticBuildRecoveryEnvelopeV1["recovery_actions"] {
  if (reason === "model_input_unsplittable") return ["upgrade_executor"];
  if (reason === "budget_proof_invalid" || reason === "active_lease") return ["retry_plan"];
  return ["migrate_policy"];
}

function applyAutomaticBuildProductionMigration(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  from_policy_digest: string;
  policy_set: AutomaticBuildStagePolicySetV2;
  current: AutomaticBuildPolicyMigrationCurrent;
  previous?: AutomaticBuildPolicyMigrationPreviousV2;
  project_adopted_payload?: (payload: unknown) => unknown;
}): AutomaticBuildProductionMigrationDecision {
  const current = input.current;
  const descriptor = current.route === "model" ? current.descriptor : undefined;
  const policy = current.route === "model"
    ? current.descriptor.policy_fingerprint
    : current.policy_fingerprint;
  const affected = {
    work_unit_id: current.route === "model" ? current.descriptor.work_unit_id : current.work_unit_id,
    evidence_lids: current.route === "model" ? current.descriptor.evidence_lids : current.evidence_lids,
    ...(descriptor ? {
      estimated_tokens: descriptor.input_budget_proof.estimated_rendered_tokens,
      limit_tokens: descriptor.input_budget_proof.effective_body_limit_tokens,
    } : {}),
  };
  let migration: ReturnType<typeof recordAutomaticBuildPolicyMigration>;
  try {
    migration = recordAutomaticBuildPolicyMigration({
      target: input.target,
      stage: input.stage,
      from_policy_digest: input.from_policy_digest,
      policy_set: input.policy_set,
      current,
      ...(input.previous ? { previous: input.previous } : {}),
      now: AUTOMATIC_BUILD_ROUTING_RELEASE.activated_at,
    });
  } catch (error) {
    if (!(error instanceof AutomaticBuildPolicyGenerationConflictError)) throw error;
    throw new AutomaticBuildSnapshotRecoverySignal(createAutomaticBuildRecoveryEnvelope({
      phase: "migration",
      code: "policy_generation_conflict",
      stage: input.stage,
      target_ref: input.target.target_ref,
      router_version: policy.router_version,
      policy_digest: input.policy_set.policy_set_digest,
      affected_work_units: [affected],
      retryable: false,
      recovery_actions: ["migrate_policy"],
    }));
  }
  if (migration.decision === "blocked") {
    throw new AutomaticBuildSnapshotRecoverySignal(createAutomaticBuildRecoveryEnvelope({
      phase: "migration",
      code: productionMigrationRecoveryCode(migration.reason),
      stage: input.stage,
      target_ref: input.target.target_ref,
      router_version: policy.router_version,
      policy_digest: input.policy_set.policy_set_digest,
      affected_work_units: [affected],
      retryable: migration.retryable,
      recovery_actions: productionMigrationRecoveryActions(migration.reason),
    }));
  }
  if (migration.decision === "adopt_exact") {
    if (current.route !== "model") {
      throw new Error("only a model work unit can adopt an exact semantic artifact");
    }
    materializeAdoptedAutomaticBuildGenerationArtifact({
      target: input.target,
      stage: input.stage,
      policy_set: input.policy_set,
      current,
      receipt: migration,
      ...(input.project_adopted_payload
        ? { project_payload: input.project_adopted_payload }
        : {}),
    });
  }
  return migration.decision;
}

function pass1RoutingRecovery(input: {
  target: AutomaticBuildTarget;
  work_unit_id: string;
  evidence_lids: string[];
  policy_set_digest: string;
  router_version: string;
  estimated_tokens: number;
  limit_tokens: number;
}): AutomaticBuildRecoveryEnvelopeV1 {
  return createAutomaticBuildRecoveryEnvelope({
    phase: "routing",
    code: "model_input_unsplittable",
    stage: "pass1",
    target_ref: input.target.target_ref,
    router_version: input.router_version,
    policy_digest: input.policy_set_digest,
    affected_work_units: [{
      work_unit_id: input.work_unit_id,
      evidence_lids: input.evidence_lids,
      estimated_tokens: input.estimated_tokens,
      limit_tokens: input.limit_tokens,
    }],
    retryable: false,
    recovery_actions: ["upgrade_executor"],
  });
}

function assertAutomaticBuildShadowInputRoutable(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  work_unit_id: string;
  evidence_lids: string[];
  policy_fingerprint: ReturnType<typeof automaticBuildExtractionPolicy>;
  render_request: ModelInputRenderRequest;
  limit_tokens?: number;
  on_over_limit?: "policy_generation_migration_required" | "model_input_unsplittable";
}): void {
  const limitTokens = input.limit_tokens ?? AUTOMATIC_BUILD_SHADOW_STAGE_INPUT_LIMIT_TOKENS;
  const rendered = inspectRenderedModelInput(input.render_request);
  if (rendered.estimated_tokens <= limitTokens) return;
  const code = input.on_over_limit ?? "model_input_unsplittable";
  throw new AutomaticBuildSnapshotRecoverySignal(createAutomaticBuildRecoveryEnvelope({
    phase: "routing",
    code,
    stage: input.stage,
    target_ref: input.target.target_ref,
    router_version: input.policy_fingerprint.router_version,
    policy_digest: extractionPolicyDigest(input.policy_fingerprint),
    affected_work_units: [{
      work_unit_id: input.work_unit_id,
      evidence_lids: input.evidence_lids,
      estimated_tokens: rendered.estimated_tokens,
      limit_tokens: limitTokens,
    }],
    retryable: false,
    recovery_actions: code === "policy_generation_migration_required"
      ? ["migrate_policy"]
      : ["upgrade_executor"],
  }));
}

export type AutomaticBuildAction =
  | {
      kind: "extract";
      stage: AutomaticBuildStage;
      extractor: SemanticExtractor;
      task_ids: string[];
      max_attempts: 3;
      task_bindings?: Record<string, AutomaticBuildTaskPolicyBinding>;
      work_units?: WorkUnitDescriptor[];
    }
  | { kind: "close_stage"; stage: AutomaticBuildStage }
  | { kind: "done"; book_id: string; workspace_dir: string };

export type AutomaticBuildPlanGateReason =
  | "build_plan_required"
  | "build_plan_invalid"
  | "build_plan_unconfirmed"
  | "build_plan_digest_drift"
  | "build_plan_book_drift"
  | "build_plan_source_drift"
  | "build_plan_profile_drift"
  | "build_plan_policy_drift"
  | "build_plan_closure_drift"
  | "build_plan_freshness_drift";

export interface AutomaticBuildPlanGateAction {
  kind: "needs_user";
  reason: AutomaticBuildPlanGateReason;
  message: string;
  plan_id?: string;
  plan_digest?: string;
  stage?: AutomaticBuildStage;
}

const EXTRACTORS: Partial<Record<AutomaticBuildStage, SemanticExtractor>> = {
  pass1: "pass1-local-extractor",
  paper_metadata: "paper-metadata-extractor",
  paper_lexicon: "paper-lexicon-extractor",
  profile_sidecar: "profile-sidecar-extractor",
  pass2: "pass2-longrange-linker",
  book_structure: "book-structure-extractor",
};

export function automaticBuildExtractorForStage(stage: SemanticBuildStage): SemanticExtractor {
  const extractor = EXTRACTORS[stage];
  if (!extractor) throw new Error(`semantic stage has no automatic build extractor: ${stage}`);
  return extractor;
}

export function automaticBuildExtractorForWorkUnitKind(
  stage: SemanticBuildStage,
  kind: WorkUnitKind,
): SemanticExtractor {
  if (kind === "pass1_source_slice") {
    if (stage !== "pass1") throw new Error(`${kind} does not belong to stage ${stage}`);
    return "pass1-source-fragment-extractor";
  }
  if (kind === "pass1_lid_stitch") {
    if (stage !== "pass1") throw new Error(`${kind} does not belong to stage ${stage}`);
    return "pass1-lid-stitcher";
  }
  if (kind === "profile_sidecar_discourse_fragment") {
    if (stage !== "profile_sidecar") throw new Error(`${kind} does not belong to stage ${stage}`);
    return "profile-sidecar-discourse-fragment-extractor";
  }
  if (kind === "profile_sidecar_discourse_reduce") {
    if (stage !== "profile_sidecar") throw new Error(`${kind} does not belong to stage ${stage}`);
    return "profile-sidecar-discourse-reducer";
  }
  return automaticBuildExtractorForStage(stage);
}

interface WorkbenchInputManifestLike {
  book_id?: string;
  profile_id?: string;
  fingerprint?: BuildInputFingerprint;
  inputs?: {
    paper_md?: { original_path?: string | null; path?: string; sha256?: string };
    paper_pdf?: { original_path?: string | null; path?: string; sha256?: string };
  };
}

interface WorkspaceProfileMetadataLike {
  header?: {
    book_id?: string;
    profile_id?: string;
  };
}

interface TechnicalLearningSourceManifestLike {
  book_id?: string;
  canonical_source?: {
    kind?: string;
    path?: string;
    truth_file?: string;
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function loadAutomaticBook(sourcePath: string): LoadedAutomaticBook {
  const loaded = /\.epub$/i.test(sourcePath)
    ? epubToSource(new Uint8Array(readFileSync(sourcePath)))
    : { source: readFileSync(sourcePath, "utf8"), blocks: markdownToBlocks(readFileSync(sourcePath, "utf8")) };
  const lidNodes = segment(loaded.blocks);
  return {
    source: loaded.source,
    lidNodes,
    byLid: new Map(lidNodes.map((node) => [node.lid, node])),
    windows: splitWindows(lidNodes, loaded.source),
  };
}

function semanticExpectation(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  workUnitId: string,
  binding: AutomaticBuildTaskPolicyBinding,
): SemanticArtifactExpectation {
  return {
    target: target.target_ref,
    stage,
    work_unit_id: workUnitId,
    input_hash: binding.input_hash,
    ...("proof_digest" in binding ? {
      proof_digest: binding.proof_digest,
      policy_set_digest: binding.policy_set_digest,
    } : {}),
    policy_fingerprint: binding.policy_fingerprint,
  };
}

function freshSemanticPayload<T>(
  file: string,
  expected: SemanticArtifactExpectation,
): T | undefined {
  const inspected = inspectSemanticArtifact<T>(readJson(file), expected);
  return inspected.policy_fresh ? inspected.payload : undefined;
}

function artifactMetaByNumericTask(
  dir: string,
  taskIds: number[],
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  bindings: Record<string, AutomaticBuildTaskPolicyBinding>,
): Map<number, Pass1ArtifactMeta> {
  const result = new Map<number, Pass1ArtifactMeta>();
  for (const id of taskIds) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const binding = bindings[String(id)];
    if (!binding) continue;
    const artifact = freshSemanticPayload<Pass1ArtifactMeta>(file, semanticExpectation(target, stage, String(id), binding));
    if (artifact && typeof artifact.content_hash === "string") result.set(id, { content_hash: artifact.content_hash });
  }
  return result;
}

function artifactMetaByWorkUnit(
  dir: string,
  taskIds: string[],
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  bindings: Record<string, AutomaticBuildTaskPolicyBinding>,
): Map<string, Pass1ArtifactMeta> {
  const result = new Map<string, Pass1ArtifactMeta>();
  for (const id of taskIds) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const binding = bindings[id];
    if (!binding) continue;
    const artifact = freshSemanticPayload<Pass1ArtifactMeta>(file, semanticExpectation(target, stage, id, binding));
    if (artifact && typeof artifact.content_hash === "string") result.set(id, { content_hash: artifact.content_hash });
  }
  return result;
}

function pass1ArtifactsByNumericTask(
  dir: string,
  taskIds: number[],
  target: AutomaticBuildTarget,
  bindings: Record<string, AutomaticBuildTaskPolicyBinding>,
): Map<number, Pass1Artifact> {
  const result = new Map<number, Pass1Artifact>();
  for (const id of taskIds) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    const binding = bindings[String(id)];
    if (!binding) continue;
    const artifact = freshSemanticPayload<Pass1Artifact>(file, semanticExpectation(target, "pass1", String(id), binding));
    if (
      artifact
      && typeof artifact.content_hash === "string"
      && Array.isArray(artifact.nodes)
      && Array.isArray(artifact.edges)
    ) {
      result.set(id, artifact);
    }
  }
  return result;
}

function pass1GraphMatchesClosedBase(
  basePath: string,
  doneTaskIds: number[],
  artifacts: Map<number, Pass1Artifact>,
  lidNodes: LoadedAutomaticBook["lidNodes"],
): boolean {
  if (!existsSync(basePath) || doneTaskIds.some((id) => !artifacts.has(id))) return false;
  try {
    const base = readJson<ReadOnlyBase>(basePath);
    const expected = mergeAndGate(
      doneTaskIds.map((id) => {
        const artifact = artifacts.get(id)!;
        return { nodes: artifact.nodes, edges: artifact.edges };
      }),
      lidNodes,
    );
    const closedLocalEdges = base.graph_edges.filter((edge) => edge.scope !== "long_range");
    return JSON.stringify(base.graph_nodes) === JSON.stringify(expected.nodes)
      && JSON.stringify(closedLocalEdges) === JSON.stringify(expected.edges);
  } catch {
    return false;
  }
}

function profileArtifactMatches(file: string, target: AutomaticBuildTarget): boolean {
  if (!existsSync(file)) return false;
  const value = readJson<{ header?: { book_id?: string; profile_id?: string } }>(file);
  return value.header?.book_id === target.book_id && value.header.profile_id === target.profile_id;
}

function paperGuideVerificationFresh(workspaceDir: string): boolean {
  const verificationPath = path.join(workspaceDir, ".build", "paper-reading-guide", "verification.json");
  if (!existsSync(verificationPath)) return false;
  const verification = readJson<{ version?: string; available?: boolean; inputs?: Record<string, string> }>(verificationPath);
  if (verification.version !== "paper_reading_guide_verification.v1" || verification.available !== true) return false;
  const required = ["source.txt", "base.json", "paper_metadata.json", "paper_lexicon.json", "book_structure.json"];
  return required.every((relative) => {
    const file = path.join(workspaceDir, relative);
    return existsSync(file) && verification.inputs?.[relative] === sha256File(file);
  });
}

function stageState(
  stage: AutomaticBuildStage,
  pendingTasks: Array<string | number>,
  closed: boolean,
  workUnits?: WorkUnitDescriptorV2[],
): AutomaticBuildStageState {
  const pending = pendingTasks.map(String);
  const pendingSet = new Set(pending);
  const pendingWorkUnits = workUnits?.filter((unit) => pendingSet.has(unit.work_unit_id) && !unit.deterministic_skip) ?? [];
  const pendingBindings = pendingWorkUnits.length
    ? Object.fromEntries(pendingWorkUnits.map((unit) => [unit.work_unit_id, {
        input_hash: unit.input_hash,
        policy_fingerprint: unit.policy_fingerprint,
      }]))
    : {};
  return {
    stage,
    pending_tasks: pending,
    closed,
    ...(Object.keys(pendingBindings).length ? { task_bindings: pendingBindings } : {}),
    ...(workUnits ? { work_units: workUnits, pending_work_units: pendingWorkUnits } : {}),
  };
}

function stageStateV3(input: {
  stage: SemanticBuildStage;
  closed: boolean;
  work_units: WorkUnitDescriptorV3[];
  pending_ids: string[];
  policy_set: AutomaticBuildStagePolicySetV2;
  quality_routing: AutomaticBuildStageQualityRoutingEvidenceV2;
  generation_tasks: Record<string, AutomaticBuildGenerationTaskV1>;
}): AutomaticBuildStageState {
  const pendingSet = new Set(input.pending_ids);
  const pendingWorkUnits = input.work_units.filter((unit) => pendingSet.has(unit.work_unit_id));
  return {
    stage: input.stage,
    pending_tasks: input.pending_ids,
    closed: input.closed,
    task_bindings: Object.fromEntries(input.work_units.map((unit) => [
      unit.work_unit_id,
      taskPolicyBindingForWorkUnit(unit, input.policy_set.policy_set_digest),
    ])),
    work_units: input.work_units,
    pending_work_units: pendingWorkUnits,
    policy_set: input.policy_set,
    quality_routing: input.quality_routing,
    generation_tasks: input.generation_tasks,
  };
}

function pass1GenerationConflictRecovery(input: {
  target: AutomaticBuildTarget;
  descriptor: WorkUnitDescriptorV3;
  policy_set_digest: string;
}): AutomaticBuildRecoveryEnvelopeV1 {
  return createAutomaticBuildRecoveryEnvelope({
    phase: "migration",
    code: "policy_generation_conflict",
    stage: "pass1",
    target_ref: input.target.target_ref,
    router_version: input.descriptor.policy_fingerprint.router_version,
    policy_digest: input.policy_set_digest,
    affected_work_units: [{
      work_unit_id: input.descriptor.work_unit_id,
      evidence_lids: input.descriptor.evidence_lids,
      estimated_tokens: input.descriptor.input_budget_proof.estimated_rendered_tokens,
      limit_tokens: input.descriptor.input_budget_proof.effective_body_limit_tokens,
    }],
    retryable: false,
    recovery_actions: ["migrate_policy"],
  });
}

function readPass1GenerationArtifact(
  target: AutomaticBuildTarget,
  workUnit: Pass1ShadowWorkUnitV1,
  policySetDigest: string,
): SemanticArtifactEnvelopeV3<unknown> | undefined {
  const file = automaticBuildGenerationArtifactPath(
    target,
    "pass1",
    policySetDigest,
    workUnit.descriptor.work_unit_id,
  );
  if (!existsSync(file)) return undefined;
  try {
    const artifact = readJson<SemanticArtifactEnvelopeV3<unknown>>(file);
    if (!semanticArtifactMatches(artifact, {
      target: workUnit.descriptor.target,
      stage: "pass1",
      work_unit_id: workUnit.descriptor.work_unit_id,
      input_hash: workUnit.descriptor.input_hash,
      proof_digest: workUnit.descriptor.input_budget_proof.proof_digest,
      policy_set_digest: policySetDigest,
      policy_fingerprint: workUnit.descriptor.policy_fingerprint,
    })) {
      throw new Error("pass1 generation artifact identity is stale");
    }
    return artifact;
  } catch {
    throw new AutomaticBuildSnapshotRecoverySignal(pass1GenerationConflictRecovery({
      target,
      descriptor: workUnit.descriptor,
      policy_set_digest: policySetDigest,
    }));
  }
}

function routePass1ProductionStage(input: {
  target: AutomaticBuildTarget;
  loaded: LoadedAutomaticBook;
  profile: ReturnType<typeof resolveContentProfile>;
  quality_profile: ExtractionQualityProfile;
}): AutomaticBuildStageState {
  assertNoActiveLegacyGenerationLease(input.target, "pass1");
  const sourceFingerprint = canonicalSourceFingerprint(input.loaded.source);
  const wholePolicy = automaticBuildExtractionPolicy("pass1", input.profile, input.quality_profile);
  const fragmentPolicy = pass1SourceFragmentPolicy(input.profile, input.quality_profile);
  const stitchPolicy = pass1LidStitchPolicy(input.profile, input.quality_profile);
  const policySet = createAutomaticBuildStagePolicySet({
    target_ref: input.target.target_ref,
    stage: "pass1",
    members: pass1ModelSlicePolicyMembers(input.profile, input.quality_profile),
    frozen_at: AUTOMATIC_BUILD_ROUTING_RELEASE.activated_at,
  });
  const previousPolicyLock = readAutomaticBuildStagePolicyLock(input.target, "pass1");
  const previousPolicy = previousPolicyLock?.policy_fingerprint ?? wholePolicy;
  const fromPolicyDigest = previousPolicyLock?.policy_digest
    ?? extractionPolicyDigest(previousPolicy);
  const previousDescriptors = new Map(routePass1WindowWorkUnits({
    target: input.target.target_ref,
    windows: input.loaded.windows,
    byLid: input.loaded.byLid,
    source: input.loaded.source,
    policy_fingerprint: previousPolicy,
    content_profile: input.profile,
  }).map((descriptor) => [descriptor.work_unit_id, descriptor]));
  const previousRenderedInputs = new Map(input.loaded.windows.map((window) => [
    String(window.id),
    renderPass1ModelInput(buildProfiledPass1Input(
      window,
      input.loaded.byLid,
      input.loaded.source,
      input.profile,
    )),
  ]));
  const workUnits: WorkUnitDescriptorV3[] = [];
  const pendingIds: string[] = [];
  const generationTasks: Record<string, AutomaticBuildGenerationTaskV1> = {};
  const coverages: AutomaticBuildStageQualityRoutingEvidenceV2["coverage"] = [];
  const publicContributors: AutomaticBuildStageQualityRoutingEvidenceV2["public_contributors"] = [];
  const reductionParents: AutomaticBuildStageQualityRoutingEvidenceV2["reduction_parents"] = [];
  const seenWorkUnits = new Set<string>();
  const addWorkUnit = (
    workUnit: Pass1ShadowWorkUnitV1,
    sourceUnitCount: number,
  ): void => {
    const id = workUnit.descriptor.work_unit_id;
    if (seenWorkUnits.has(id)) throw new Error(`duplicate Pass1 v3 work-unit identity: ${id}`);
    seenWorkUnits.add(id);
    workUnits.push(workUnit.descriptor);
    const generationTask = createPass1ShadowTask({
      work_unit: workUnit,
      source_fingerprint: sourceFingerprint,
      policy_set_digest: policySet.policy_set_digest,
      source_unit_count: sourceUnitCount,
    });
    generationTasks[id] = {
      kind: "pass1",
      task: generationTask,
    };
    const previousDescriptor = previousDescriptors.get(id);
    const previousArtifactPath = automaticBuildLegacyStageArtifactPath(input.target, "pass1", id);
    const migration = applyAutomaticBuildProductionMigration({
      target: input.target,
      stage: "pass1",
      from_policy_digest: fromPolicyDigest,
      policy_set: policySet,
      current: { route: "model", descriptor: workUnit.descriptor, rendered_input: workUnit.rendered_input },
      ...(previousDescriptor && previousRenderedInputs.has(id) && existsSync(previousArtifactPath) ? {
        previous: {
          descriptor: previousDescriptor,
          rendered_input: previousRenderedInputs.get(id)!,
          artifact_path: previousArtifactPath,
        },
      } : {}),
      ...(workUnit.route.role === "whole" ? {
        project_adopted_payload: (payload: unknown) => projectPass1AdoptedWholeArtifact({
          target: input.target,
          task: generationTask,
          payload,
        }),
      } : {}),
    });
    if (migration === "adopt_exact") freezePass1ShadowTask(input.target, generationTask);
  };

  for (const window of input.loaded.windows) {
    const initial = routePass1ShadowWorkUnits({
      target: input.target.target_ref,
      window,
      by_lid: input.loaded.byLid,
      source: input.loaded.source,
      source_fingerprint: sourceFingerprint,
      content_profile: input.profile,
      whole_policy: wholePolicy,
      fragment_policy: fragmentPolicy,
      whole_budget: AUTOMATIC_BUILD_V3_MODEL_BUDGET,
      fragment_budget: AUTOMATIC_BUILD_V3_MODEL_BUDGET,
    });
    if (initial.status === "blocked") {
      throw new AutomaticBuildSnapshotRecoverySignal(pass1RoutingRecovery({
        target: input.target,
        work_unit_id: `pass1-window-${window.id}`,
        evidence_lids: [initial.recovery.parent_lid],
        policy_set_digest: policySet.policy_set_digest,
        router_version: fragmentPolicy.router_version,
        estimated_tokens: initial.recovery.estimated_tokens,
        limit_tokens: initial.recovery.limit_tokens,
      }));
    }
    coverages.push(...initial.coverages);
    const sourceUnitCount = initial.units.length;
    const fragmentIdsByParent = new Map<string, string[]>();
    let children: Pass1ShadowVerifiedChildV1[] = [];
    let initialReady = true;
    for (const workUnit of initial.units) {
      addWorkUnit(workUnit, sourceUnitCount);
      if (workUnit.route.role === "fragment") {
        const current = fragmentIdsByParent.get(workUnit.route.parent_lid) ?? [];
        current.push(workUnit.descriptor.work_unit_id);
        fragmentIdsByParent.set(workUnit.route.parent_lid, current);
      }
      const artifact = readPass1GenerationArtifact(input.target, workUnit, policySet.policy_set_digest);
      if (!artifact) {
        pendingIds.push(workUnit.descriptor.work_unit_id);
        initialReady = false;
        continue;
      }
      children.push(verifyPass1ShadowArtifact({
        work_unit: workUnit,
        artifact,
        policy_set_digest: policySet.policy_set_digest,
      }));
    }
    if (initial.mode === "whole") {
      const wholeUnit = initial.units[0];
      if (initial.units.length !== 1 || !wholeUnit || wholeUnit.route.role !== "whole") {
        throw new Error("Pass1 whole route must contain exactly one whole-window work unit");
      }
      if (initialReady) {
        publicContributors.push({
          contributor_id: `pass1-window:${window.id}`,
          work_unit_id: wholeUnit.descriptor.work_unit_id,
          parent_lids: [...window.leafLids],
        });
      }
      continue;
    }
    if (!initialReady) continue;

    for (;;) {
      const reduction = routePass1StitchLevel({
        target: input.target.target_ref,
        window_id: window.id,
        source_unit_count: sourceUnitCount,
        children,
        policy_set_digest: policySet.policy_set_digest,
        policy: stitchPolicy,
        budget: AUTOMATIC_BUILD_V3_MODEL_BUDGET,
      });
      if (reduction.status === "blocked") {
        throw new AutomaticBuildSnapshotRecoverySignal(pass1RoutingRecovery({
          target: input.target,
          work_unit_id: `pass1-window-${window.id}-stitch`,
          evidence_lids: [reduction.recovery.parent_lid],
          policy_set_digest: policySet.policy_set_digest,
          router_version: stitchPolicy.router_version,
          estimated_tokens: reduction.recovery.estimated_tokens,
          limit_tokens: reduction.recovery.limit_tokens,
        }));
      }
      const nextChildren: Pass1ShadowVerifiedChildV1[] = [];
      let levelReady = true;
      for (const workUnit of reduction.units) {
        addWorkUnit(workUnit, sourceUnitCount);
        const artifact = readPass1GenerationArtifact(input.target, workUnit, policySet.policy_set_digest);
        if (!artifact) {
          pendingIds.push(workUnit.descriptor.work_unit_id);
          levelReady = false;
          continue;
        }
        if (workUnit.route.role !== "final") {
          nextChildren.push(verifyPass1ShadowArtifact({
            work_unit: workUnit,
            artifact,
            policy_set_digest: policySet.policy_set_digest,
          }));
        }
      }
      if (reduction.role === "final") {
        const finalUnit = reduction.units[0];
        if (reduction.units.length !== 1 || !finalUnit) {
          throw new Error("Pass1 final reduction level must contain exactly one root");
        }
        publicContributors.push({
          contributor_id: `pass1-window:${window.id}`,
          work_unit_id: finalUnit.descriptor.work_unit_id,
          parent_lids: [...window.leafLids],
        });
        for (const coverage of initial.coverages) {
          reductionParents.push({
            parent_lid: coverage.parent_lid,
            fragment_work_unit_ids: fragmentIdsByParent.get(coverage.parent_lid) ?? [],
            final_work_unit_ids: [finalUnit.descriptor.work_unit_id],
          });
        }
        break;
      }
      if (!levelReady) break;
      children = nextChildren;
    }
  }

  const qualityRouting: AutomaticBuildStageQualityRoutingEvidenceV2 = {
    policy_set: policySet,
    coverage: coverages,
    public_contributors: publicContributors,
    reduction_parents: reductionParents,
  };
  const closed = pendingIds.length === 0
    && currentV3QualityReportPassed(
      input.target,
      "pass1",
      policySet.policy_set_digest,
      input.quality_profile,
    )
    && profileArtifactMatches(path.join(input.target.workspace_dir, "profile_metadata.json"), input.target)
    && existsSync(path.join(input.target.workspace_dir, "base.json"));
  return stageStateV3({
    stage: "pass1",
    closed,
    work_units: workUnits,
    pending_ids: pendingIds,
    policy_set: policySet,
    quality_routing: qualityRouting,
    generation_tasks: generationTasks,
  });
}

function profileSidecarRoutingRecovery(input: {
  target: AutomaticBuildTarget;
  work_unit_id: string;
  evidence_lids: string[];
  policy_set_digest: string;
  router_version: string;
  estimated_tokens: number;
  limit_tokens: number;
}): AutomaticBuildRecoveryEnvelopeV1 {
  return createAutomaticBuildRecoveryEnvelope({
    phase: "routing",
    code: "model_input_unsplittable",
    stage: "profile_sidecar",
    target_ref: input.target.target_ref,
    router_version: input.router_version,
    policy_digest: input.policy_set_digest,
    affected_work_units: [{
      work_unit_id: input.work_unit_id,
      evidence_lids: input.evidence_lids,
      estimated_tokens: input.estimated_tokens,
      limit_tokens: input.limit_tokens,
    }],
    retryable: false,
    recovery_actions: ["upgrade_executor"],
  });
}

function profileSidecarFastPathWorkUnit(input: {
  target: AutomaticBuildTarget;
  loaded: LoadedAutomaticBook;
  packet: ProfileSidecarSemanticPacketV2;
  source_fingerprint: string;
  policy: ReturnType<typeof automaticBuildExtractionPolicy>;
  policy_set_digest: string;
}): {
  descriptor: WorkUnitDescriptorV3;
  task: ProfileSidecarSemanticFastPathTaskV1;
  rendered_input: string;
} | undefined {
  const renderedInput = renderProfileSidecarModelInput(input.packet);
  const evaluated = evaluateModelInputBudget({
    ...AUTOMATIC_BUILD_V3_MODEL_BUDGET,
    rendered_input: renderedInput,
    router_version: input.policy.router_version,
    prompt_sha256: input.policy.prompt_sha256,
  });
  if (evaluated.status === "over_limit") return undefined;
  const slices = input.packet.visible_lids.map((lid) => {
    const node = input.loaded.byLid.get(lid);
    if (!node) throw new Error(`profile sidecar fast-path LID does not exist: ${lid}`);
    const sourceText = input.loaded.source.slice(node.span.start, node.span.end);
    const sourceDigest = createHash("sha256").update(sourceText, "utf8").digest("hex");
    return {
      version: "model_input_slice.v1" as const,
      source_fingerprint: input.source_fingerprint,
      parent_lid: lid,
      ordinal: 0,
      core_span_utf16: { ...node.span },
      context_span_utf16: { ...node.span },
      boundary_kind: "whole_lid" as const,
      core_sha256: sourceDigest,
      context_sha256: sourceDigest,
    };
  });
  const descriptor = createWorkUnitDescriptorV3({
    target: input.target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: input.packet.work_unit_id,
    kind: input.packet.unit_kind,
    input_basis: { kind: "source_slices", slices },
    input_hash: evaluated.proof.rendered_input_sha256,
    input_budget_proof: evaluated.proof,
    policy_fingerprint: input.policy,
    evidence_lids: input.packet.visible_lids,
    cost: buildWorkUnitCostFromBudgetProof({
      rendered_input: renderedInput,
      proof: evaluated.proof,
      visible_lids: input.packet.visible_lids.length,
      formula_lids: input.packet.formula_lids.length,
      candidate_count: input.packet.unit_kind === "profile_sidecar_formula"
        ? 1
        : input.packet.visible_lids.length,
      expected_output_items: input.packet.unit_kind === "profile_sidecar_formula"
        ? 1
        : input.packet.visible_lids.length,
    }),
  });
  return {
    descriptor,
    rendered_input: renderedInput,
    task: createProfileSidecarSemanticFastPathTask({
      descriptor,
      packet: input.packet,
      source_fingerprint: input.source_fingerprint,
      policy_set_digest: input.policy_set_digest,
    }),
  };
}

function readProfileSidecarGenerationArtifact(
  target: AutomaticBuildTarget,
  descriptor: WorkUnitDescriptorV3,
  policySetDigest: string,
): SemanticArtifactEnvelopeV3<unknown> | undefined {
  const file = automaticBuildGenerationArtifactPath(
    target,
    "profile_sidecar",
    policySetDigest,
    descriptor.work_unit_id,
  );
  if (!existsSync(file)) return undefined;
  try {
    const artifact = readJson<SemanticArtifactEnvelopeV3<unknown>>(file);
    if (!semanticArtifactMatches(artifact, {
      target: descriptor.target,
      stage: "profile_sidecar",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      proof_digest: descriptor.input_budget_proof.proof_digest,
      policy_set_digest: policySetDigest,
      policy_fingerprint: descriptor.policy_fingerprint,
    })) {
      throw new Error("profile sidecar generation artifact identity is stale");
    }
    return artifact;
  } catch {
    throw new AutomaticBuildSnapshotRecoverySignal(createAutomaticBuildRecoveryEnvelope({
      phase: "migration",
      code: "policy_generation_conflict",
      stage: "profile_sidecar",
      target_ref: target.target_ref,
      router_version: descriptor.policy_fingerprint.router_version,
      policy_digest: policySetDigest,
      affected_work_units: [{
        work_unit_id: descriptor.work_unit_id,
        evidence_lids: descriptor.evidence_lids,
        estimated_tokens: descriptor.input_budget_proof.estimated_rendered_tokens,
        limit_tokens: descriptor.input_budget_proof.effective_body_limit_tokens,
      }],
      retryable: false,
      recovery_actions: ["migrate_policy"],
    }));
  }
}

function routeProfileSidecarProductionStage(input: {
  target: AutomaticBuildTarget;
  loaded: LoadedAutomaticBook;
  profile: ReturnType<typeof resolveContentProfile>;
  quality_profile: ExtractionQualityProfile;
}): AutomaticBuildStageState {
  assertNoActiveLegacyGenerationLease(input.target, "profile_sidecar");
  const sourceFingerprint = canonicalSourceFingerprint(input.loaded.source);
  const fastPolicy = automaticBuildExtractionPolicy("profile_sidecar", input.profile, input.quality_profile);
  const fragmentPolicy = profileSidecarDiscourseFragmentPolicy(input.profile, input.quality_profile);
  const reducePolicy = profileSidecarDiscourseReducePolicy(input.profile, input.quality_profile);
  const policySet = createAutomaticBuildStagePolicySet({
    target_ref: input.target.target_ref,
    stage: "profile_sidecar",
    members: profileSidecarMapReducePolicyMembers(input.profile, input.quality_profile),
    frozen_at: AUTOMATIC_BUILD_ROUTING_RELEASE.activated_at,
  });
  const analysis = analyzeProfileSidecarSemanticUnits({
    windows: input.loaded.windows,
    byLid: input.loaded.byLid,
    source: input.loaded.source,
    content_profile: input.profile,
    max_discourse_input_tokens: AUTOMATIC_BUILD_V3_MODEL_BUDGET.stage_body_limit_tokens,
    allow_over_limit_packets: true,
  });
  const previousPolicyLock = readAutomaticBuildStagePolicyLock(input.target, "profile_sidecar");
  const previousPolicy = previousPolicyLock?.policy_fingerprint ?? fastPolicy;
  const fromPolicyDigest = previousPolicyLock?.policy_digest
    ?? extractionPolicyDigest(previousPolicy);
  const previousDescriptors = new Map<string, WorkUnitDescriptorV2>([
    ...Object.values(analysis.packets).map((packet) => createWorkUnitDescriptor({
      target: input.target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: packet.work_unit_id,
      kind: packet.unit_kind,
      input_hash: packet.input_hash,
      policy_fingerprint: previousPolicy,
      evidence_lids: packet.visible_lids,
      cost: buildWorkUnitCost({
        estimated_input_tokens: packet.estimated_input_tokens,
        visible_lids: packet.visible_lids.length,
        formula_lids: packet.formula_lids.length,
        candidate_count: packet.unit_kind === "profile_sidecar_formula"
          ? 1
          : packet.visible_lids.length,
        expected_output_items: packet.unit_kind === "profile_sidecar_formula"
          ? 1
          : packet.visible_lids.length,
      }),
      legacy_artifact_ref: `.build/profile-sidecar/${packet.work_unit_id}.json`,
    })),
    ...Object.entries(analysis.skips).map(([workUnitId, skip]) => createWorkUnitDescriptor({
      target: input.target.target_ref,
      stage: "profile_sidecar",
      work_unit_id: workUnitId,
      kind: skip.kind === "formula" ? "profile_sidecar_formula" : "profile_sidecar_discourse",
      input_hash: skip.input_hash,
      policy_fingerprint: previousPolicy,
      evidence_lids: skip.evidence,
      cost: buildWorkUnitCost({ visible_lids: skip.evidence.length }),
      deterministic_skip: { code: skip.code, evidence: skip.evidence },
    })),
  ].map((descriptor) => [descriptor.work_unit_id, descriptor] as const));
  const previousRenderedInputs = new Map(Object.values(analysis.packets).map((packet) => [
    packet.work_unit_id,
    renderProfileSidecarModelInput(packet),
  ]));
  const workUnits: WorkUnitDescriptorV3[] = [];
  const pendingIds: string[] = [];
  const generationTasks: Record<string, AutomaticBuildGenerationTaskV1> = {};
  const coverages: AutomaticBuildStageQualityRoutingEvidenceV2["coverage"] = [];
  const publicContributors: AutomaticBuildStageQualityRoutingEvidenceV2["public_contributors"] = [];
  const reductionParents: AutomaticBuildStageQualityRoutingEvidenceV2["reduction_parents"] = [];
  const seenWorkUnits = new Set<string>();
  const addWorkUnit = (
    descriptor: WorkUnitDescriptorV3,
    generationTask: AutomaticBuildGenerationTaskV1,
    renderedInput: string,
  ): void => {
    if (seenWorkUnits.has(descriptor.work_unit_id)) {
      throw new Error(`duplicate profile sidecar v3 work-unit identity: ${descriptor.work_unit_id}`);
    }
    seenWorkUnits.add(descriptor.work_unit_id);
    workUnits.push(descriptor);
    generationTasks[descriptor.work_unit_id] = generationTask;
    const previousDescriptor = previousDescriptors.get(descriptor.work_unit_id);
    const previousArtifactPath = automaticBuildLegacyStageArtifactPath(
      input.target,
      "profile_sidecar",
      descriptor.work_unit_id,
    );
    const migration = applyAutomaticBuildProductionMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: fromPolicyDigest,
      policy_set: policySet,
      current: { route: "model", descriptor, rendered_input: renderedInput },
      ...(previousDescriptor && previousRenderedInputs.has(descriptor.work_unit_id)
        && existsSync(previousArtifactPath) ? {
          previous: {
            descriptor: previousDescriptor,
            rendered_input: previousRenderedInputs.get(descriptor.work_unit_id)!,
            artifact_path: previousArtifactPath,
          },
        } : {}),
    });
    if (migration === "adopt_exact") {
      if (generationTask.kind === "profile_sidecar_fast_path") {
        freezeProfileSidecarSemanticFastPathTask(input.target, generationTask.task);
      } else if (generationTask.kind === "profile_sidecar_discourse") {
        freezeProfileSidecarDiscourseShadowTask(input.target, generationTask.task);
      } else {
        throw new Error("profile sidecar migration adopted an invalid generation task kind");
      }
    }
  };

  for (const [workUnitId, skip] of Object.entries(analysis.skips)) {
    applyAutomaticBuildProductionMigration({
      target: input.target,
      stage: "profile_sidecar",
      from_policy_digest: fromPolicyDigest,
      policy_set: policySet,
      current: {
        route: "deterministic_skip",
        work_unit_id: workUnitId,
        work_unit_kind: skip.kind === "formula"
          ? "profile_sidecar_formula"
          : "profile_sidecar_discourse",
        policy_fingerprint: fastPolicy,
        evidence_lids: skip.evidence,
        skip_code: skip.code,
      },
    });
  }

  for (const packet of Object.values(analysis.packets)) {
    const fastPath = profileSidecarFastPathWorkUnit({
      target: input.target,
      loaded: input.loaded,
      packet,
      source_fingerprint: sourceFingerprint,
      policy: fastPolicy,
      policy_set_digest: policySet.policy_set_digest,
    });
    if (fastPath) {
      addWorkUnit(
        fastPath.descriptor,
        { kind: "profile_sidecar_fast_path", task: fastPath.task },
        fastPath.rendered_input,
      );
      const artifact = readProfileSidecarGenerationArtifact(
        input.target,
        fastPath.descriptor,
        policySet.policy_set_digest,
      );
      if (!artifact) pendingIds.push(fastPath.descriptor.work_unit_id);
      publicContributors.push({
        contributor_id: `profile-sidecar:${packet.work_unit_id}`,
        work_unit_id: fastPath.descriptor.work_unit_id,
        parent_lids: [...packet.visible_lids],
      });
      continue;
    }

    if (packet.unit_kind !== "profile_sidecar_discourse" || packet.visible_lids.length !== 1) {
      throw new AutomaticBuildSnapshotRecoverySignal(profileSidecarRoutingRecovery({
        target: input.target,
        work_unit_id: packet.work_unit_id,
        evidence_lids: packet.visible_lids,
        policy_set_digest: policySet.policy_set_digest,
        router_version: PROFILE_SIDECAR_ROUTER_VERSION,
        estimated_tokens: packet.estimated_rendered_tokens,
        limit_tokens: AUTOMATIC_BUILD_V3_MODEL_BUDGET.stage_body_limit_tokens,
      }));
    }
    const parentLid = packet.visible_lids[0];
    const parent = input.loaded.byLid.get(parentLid);
    if (!parent || parent.kind !== "paragraph") {
      throw new AutomaticBuildSnapshotRecoverySignal(profileSidecarRoutingRecovery({
        target: input.target,
        work_unit_id: packet.work_unit_id,
        evidence_lids: packet.visible_lids,
        policy_set_digest: policySet.policy_set_digest,
        router_version: PROFILE_SIDECAR_ROUTER_VERSION,
        estimated_tokens: packet.estimated_rendered_tokens,
        limit_tokens: AUTOMATIC_BUILD_V3_MODEL_BUDGET.stage_body_limit_tokens,
      }));
    }
    const fragments = routeProfileSidecarDiscourseFragmentWorkUnits({
      target: input.target.target_ref,
      source: input.loaded.source,
      source_fingerprint: sourceFingerprint,
      parent,
      content_profile_id: input.profile.id,
      policy: fragmentPolicy,
      budget: AUTOMATIC_BUILD_V3_MODEL_BUDGET,
    });
    if (fragments.status === "blocked") {
      throw new AutomaticBuildSnapshotRecoverySignal(profileSidecarRoutingRecovery({
        target: input.target,
        work_unit_id: packet.work_unit_id,
        evidence_lids: packet.visible_lids,
        policy_set_digest: policySet.policy_set_digest,
        router_version: fragmentPolicy.router_version,
        estimated_tokens: fragments.recovery.estimated_tokens,
        limit_tokens: fragments.recovery.limit_tokens,
      }));
    }
    coverages.push(fragments.coverage);
    const fragmentCount = fragments.units.length;
    const fragmentIds = fragments.units.map((unit) => unit.descriptor.work_unit_id);
    let children: ProfileSidecarDiscourseVerifiedChildV1[] = [];
    let fragmentsReady = true;
    for (const workUnit of fragments.units) {
      const task = createProfileSidecarDiscourseShadowTask({
        work_unit: workUnit,
        source_fingerprint: sourceFingerprint,
        policy_set_digest: policySet.policy_set_digest,
        fragment_count: fragmentCount,
      });
      addWorkUnit(
        workUnit.descriptor,
        { kind: "profile_sidecar_discourse", task },
        workUnit.rendered_input,
      );
      const artifact = readProfileSidecarGenerationArtifact(
        input.target,
        workUnit.descriptor,
        policySet.policy_set_digest,
      );
      if (!artifact) {
        pendingIds.push(workUnit.descriptor.work_unit_id);
        fragmentsReady = false;
        continue;
      }
      children.push(verifyProfileSidecarDiscourseShadowArtifact({
        work_unit: workUnit,
        artifact,
        policy_set_digest: policySet.policy_set_digest,
      }));
    }
    if (!fragmentsReady) continue;

    for (;;) {
      const reduction = routeProfileSidecarDiscourseReductionLevel({
        target: input.target.target_ref,
        parent_lid: parentLid,
        fragment_count: fragmentCount,
        children,
        policy_set_digest: policySet.policy_set_digest,
        policy: reducePolicy,
        budget: AUTOMATIC_BUILD_V3_MODEL_BUDGET,
      });
      if (reduction.status === "blocked") {
        throw new AutomaticBuildSnapshotRecoverySignal(profileSidecarRoutingRecovery({
          target: input.target,
          work_unit_id: `${packet.work_unit_id}:reduce`,
          evidence_lids: packet.visible_lids,
          policy_set_digest: policySet.policy_set_digest,
          router_version: reducePolicy.router_version,
          estimated_tokens: reduction.recovery.estimated_tokens,
          limit_tokens: reduction.recovery.limit_tokens,
        }));
      }
      const nextChildren: ProfileSidecarDiscourseVerifiedChildV1[] = [];
      let levelReady = true;
      for (const workUnit of reduction.units) {
        const task = createProfileSidecarDiscourseShadowTask({
          work_unit: workUnit,
          source_fingerprint: sourceFingerprint,
          policy_set_digest: policySet.policy_set_digest,
          fragment_count: fragmentCount,
        });
        addWorkUnit(
          workUnit.descriptor,
          { kind: "profile_sidecar_discourse", task },
          workUnit.rendered_input,
        );
        const artifact = readProfileSidecarGenerationArtifact(
          input.target,
          workUnit.descriptor,
          policySet.policy_set_digest,
        );
        if (!artifact) {
          pendingIds.push(workUnit.descriptor.work_unit_id);
          levelReady = false;
          continue;
        }
        if (workUnit.route.role !== "final") {
          nextChildren.push(verifyProfileSidecarDiscourseShadowArtifact({
            work_unit: workUnit,
            artifact,
            policy_set_digest: policySet.policy_set_digest,
          }));
        }
      }
      if (reduction.role === "final") {
        const finalUnit = reduction.units[0];
        if (reduction.units.length !== 1 || !finalUnit) {
          throw new Error("profile sidecar final reduction level must contain exactly one root");
        }
        publicContributors.push({
          contributor_id: `profile-sidecar-parent:${parentLid}`,
          work_unit_id: finalUnit.descriptor.work_unit_id,
          parent_lids: [parentLid],
        });
        reductionParents.push({
          parent_lid: parentLid,
          fragment_work_unit_ids: fragmentIds,
          final_work_unit_ids: [finalUnit.descriptor.work_unit_id],
        });
        break;
      }
      if (!levelReady) break;
      children = nextChildren;
    }
  }

  const qualityRouting: AutomaticBuildStageQualityRoutingEvidenceV2 = {
    policy_set: policySet,
    coverage: coverages,
    public_contributors: publicContributors,
    reduction_parents: reductionParents,
  };
  const closed = pendingIds.length === 0
    && currentV3QualityReportPassed(
      input.target,
      "profile_sidecar",
      policySet.policy_set_digest,
      input.quality_profile,
    )
    && profileArtifactMatches(path.join(input.target.workspace_dir, "discourse_index.json"), input.target)
    && profileArtifactMatches(path.join(input.target.workspace_dir, "formula_semantics.json"), input.target);
  return stageStateV3({
    stage: "profile_sidecar",
    closed,
    work_units: workUnits,
    pending_ids: pendingIds,
    policy_set: policySet,
    quality_routing: qualityRouting,
    generation_tasks: generationTasks,
  });
}

function taskBindings(
  stage: SemanticBuildStage,
  profile: ReturnType<typeof resolveContentProfile>,
  qualityProfile: ExtractionQualityProfile,
  inputs: Array<{ task_id: string | number; input_hash: string }>,
): Record<string, AutomaticBuildTaskPolicyBindingV1> {
  const policy = automaticBuildExtractionPolicy(stage, profile, qualityProfile);
  return Object.fromEntries(inputs.map((input) => [String(input.task_id), {
    input_hash: input.input_hash,
    policy_fingerprint: policy,
  }]));
}

function descriptorFromBinding(input: {
  target: AutomaticBuildTarget;
  stage: WorkUnitStage;
  task_id: string;
  kind: WorkUnitKind;
  binding: AutomaticBuildTaskPolicyBindingV1;
  evidence_lids: string[];
  estimated_input_tokens: number;
  formula_lids?: number;
  table_fragments?: number;
  candidate_count?: number;
  expected_output_items?: number;
  legacy_artifact_ref?: string;
}): WorkUnitDescriptorV2 {
  return createWorkUnitDescriptor({
    target: input.target.target_ref,
    stage: input.stage,
    work_unit_id: input.task_id,
    kind: input.kind,
    input_hash: input.binding.input_hash,
    policy_fingerprint: input.binding.policy_fingerprint,
    evidence_lids: input.evidence_lids,
    cost: buildWorkUnitCost({
      estimated_input_tokens: input.estimated_input_tokens,
      visible_lids: input.evidence_lids.length,
      formula_lids: input.formula_lids,
      table_fragments: input.table_fragments,
      candidate_count: input.candidate_count,
      expected_output_items: input.expected_output_items,
    }),
    ...(input.legacy_artifact_ref ? { legacy_artifact_ref: input.legacy_artifact_ref } : {}),
  });
}

function bindingsFromDescriptors(units: WorkUnitDescriptorV2[]): Record<string, AutomaticBuildTaskPolicyBindingV1> {
  return Object.fromEntries(units.map((unit) => [unit.work_unit_id, {
    input_hash: unit.input_hash,
    policy_fingerprint: unit.policy_fingerprint,
  }]));
}

function paperTargetFromWorkspace(workspaceInput: string): AutomaticBuildTarget {
  const workspaceDir = path.resolve(workspaceInput);
  const libraryDir = path.dirname(workspaceDir);
  if (path.basename(libraryDir) !== ".understand-book") {
    throw new Error(`paper workspace 必须位于 .understand-book/<book_id>: ${workspaceDir}`);
  }
  const inputManifestPath = path.join(workspaceDir, ".build", "input", "manifest.json");
  if (!existsSync(inputManifestPath)) {
    throw new Error(`paper workspace 缺少 Workbench input manifest: ${inputManifestPath}`);
  }
  const inputManifest = readJson<WorkbenchInputManifestLike>(inputManifestPath);
  if (inputManifest.profile_id !== "paper") {
    throw new Error(`workspace ${workspaceDir} 不是 paper profile`);
  }
  try {
    if (!inputManifest.fingerprint) {
      throw new Error(`paper workspace input manifest 缺少 fingerprint: ${inputManifestPath}`);
    }
    const trusted = assertTrustedPaperProjectionSource(workspaceDir);
    if (inputManifest.book_id !== trusted.book_id) {
      throw new Error(`paper workspace book identity 不一致: manifest=${inputManifest.book_id ?? "missing"}, trusted=${trusted.book_id}`);
    }
    const targetRef: BuildTargetRefV2 = {
      version: "build_target_ref.v2",
      workspace_dir: trusted.book_dir,
      book_id: trusted.book_id,
      profile_id: "paper",
      input_fingerprint: buildInputFingerprintHash(inputManifest.fingerprint),
    };
    return {
      kind: "paper_workspace",
      profile_id: "paper",
      book_id: trusted.book_id,
      root_dir: path.dirname(libraryDir),
      workspace_dir: trusted.book_dir,
      source_path: trusted.trusted_source_path,
      target_ref: targetRef,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`paper workspace 缺少可信混合阅读基座: ${message}`);
  }
}

function workspaceLocation(workspaceInput: string): {
  workspaceDir: string;
  libraryDir: string;
  rootDir: string;
  bookId: string;
} {
  const workspaceDir = path.resolve(workspaceInput);
  const libraryDir = path.dirname(workspaceDir);
  if (path.basename(libraryDir) !== ".understand-book") {
    throw new Error(`book workspace 必须位于 .understand-book/<book_id>: ${workspaceDir}`);
  }
  return {
    workspaceDir,
    libraryDir,
    rootDir: path.dirname(libraryDir),
    bookId: path.basename(workspaceDir),
  };
}

function technicalLearningTargetFromWorkspace(workspaceInput: string): AutomaticBuildTarget {
  const { workspaceDir, rootDir, bookId } = workspaceLocation(workspaceInput);
  const profilePath = path.join(workspaceDir, "profile_metadata.json");
  const sourceManifestPath = path.join(workspaceDir, "source_manifest.json");
  const sourceTxtPath = path.join(workspaceDir, "source.txt");
  const basePath = path.join(workspaceDir, "base.json");
  for (const required of [profilePath, sourceManifestPath, sourceTxtPath, basePath]) {
    if (!existsSync(required) || !statSync(required).isFile()) {
      throw new Error(`technical_learning workspace 缺少立即可读基础文件: ${required}`);
    }
  }

  const profile = readJson<WorkspaceProfileMetadataLike>(profilePath);
  if (profile.header?.book_id !== bookId || profile.header.profile_id !== "technical_learning") {
    throw new Error(`technical_learning workspace profile identity 不一致: ${profilePath}`);
  }
  const sourceManifest = readJson<TechnicalLearningSourceManifestLike>(sourceManifestPath);
  if (
    sourceManifest.book_id !== bookId
    || !sourceManifest.canonical_source
    || !(sourceManifest.canonical_source.kind === "markdown" || sourceManifest.canonical_source.kind === "epub")
    || sourceManifest.canonical_source.truth_file !== "source.txt"
  ) {
    throw new Error(`technical_learning workspace source manifest 不合法: ${sourceManifestPath}`);
  }

  const declaredSource = sourceManifest.canonical_source.path
    ? path.resolve(workspaceDir, sourceManifest.canonical_source.path)
    : null;
  const sourcePath = declaredSource && existsSync(declaredSource) && statSync(declaredSource).isFile()
    ? declaredSource
    : sourceTxtPath;
  if (sourcePath !== sourceTxtPath) {
    const declaredCanonicalSource = loadAutomaticBook(sourcePath).source;
    const trustedCanonicalSource = readFileSync(sourceTxtPath, "utf8");
    if (declaredCanonicalSource !== trustedCanonicalSource) {
      throw new Error(`technical_learning workspace canonical source 已漂移: ${sourcePath}`);
    }
  }

  return {
    kind: "source_file",
    profile_id: "technical_learning",
    book_id: bookId,
    root_dir: rootDir,
    workspace_dir: workspaceDir,
    source_path: sourcePath,
    target_ref: {
      version: "build_target_ref.v2",
      workspace_dir: workspaceDir,
      book_id: bookId,
      profile_id: "technical_learning",
      input_fingerprint: sha256File(sourcePath),
    },
  };
}

function targetFromWorkspace(workspaceInput: string): AutomaticBuildTarget {
  const workspaceDir = path.resolve(workspaceInput);
  const workbenchManifestPath = path.join(workspaceDir, ".build", "input", "manifest.json");
  if (existsSync(workbenchManifestPath)) return paperTargetFromWorkspace(workspaceDir);

  const profilePath = path.join(workspaceDir, "profile_metadata.json");
  if (existsSync(profilePath)) {
    const profile = readJson<WorkspaceProfileMetadataLike>(profilePath);
    if (profile.header?.profile_id === "technical_learning") {
      return technicalLearningTargetFromWorkspace(workspaceDir);
    }
    if (profile.header?.profile_id === "paper") return paperTargetFromWorkspace(workspaceDir);
  }
  throw new Error(`book workspace 缺少可验证的 content profile: ${workspaceDir}`);
}

function hasAutomaticBuildWorkspaceIdentity(workspaceDir: string): boolean {
  return existsSync(path.join(workspaceDir, ".build", "input", "manifest.json"))
    || existsSync(path.join(workspaceDir, "profile_metadata.json"));
}

function containingBuildWorkspaceSource(sourcePath: string): string | undefined {
  if (path.basename(sourcePath).toLowerCase() !== "source.txt") return undefined;
  const workspaceDir = path.dirname(sourcePath);
  return path.basename(path.dirname(workspaceDir)) === ".understand-book" ? workspaceDir : undefined;
}

function paperWorkspaceCandidates(sourceFile: string, rootDir: string): string[] {
  const libraryDir = path.join(rootDir, ".understand-book");
  if (!existsSync(libraryDir)) return [];
  const sourcePath = path.resolve(sourceFile);
  const sourceHash = sha256File(sourcePath);
  const sourceExt = path.extname(sourcePath).toLowerCase();
  const inputKey = sourceExt === ".pdf" ? "paper_pdf" : "paper_md";
  const matches: string[] = [];
  for (const entry of readdirSync(libraryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(libraryDir, entry.name);
    const manifestPath = path.join(workspaceDir, ".build", "input", "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson<WorkbenchInputManifestLike>(manifestPath);
    if (manifest.profile_id !== "paper") continue;
    const input = manifest.inputs?.[inputKey];
    const originalPath = input?.original_path ? path.resolve(input.original_path) : null;
    if (originalPath === sourcePath || input?.sha256 === sourceHash) matches.push(workspaceDir);
  }
  return matches;
}

export function resolveAutomaticBuildTarget(
  targetInput: string,
  rootDir = process.cwd(),
  options: AutomaticBuildTargetResolutionOptions = {},
): AutomaticBuildTarget {
  const resolvedRoot = path.resolve(rootDir);
  const stableBookId = options.book_id === undefined
    ? undefined
    : deriveBookId(targetInput, options.book_id);
  const stableWorkspace = stableBookId
    ? path.join(resolvedRoot, ".understand-book", stableBookId)
    : undefined;
  if (
    stableWorkspace
    && existsSync(stableWorkspace)
    && statSync(stableWorkspace).isDirectory()
    && hasAutomaticBuildWorkspaceIdentity(stableWorkspace)
  ) {
    return targetFromWorkspace(stableWorkspace);
  }

  const explicitWorkspace = path.join(resolvedRoot, ".understand-book", targetInput);
  const targetPath = existsSync(explicitWorkspace) ? explicitWorkspace : path.resolve(rootDir, targetInput);
  if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
    const target = targetFromWorkspace(targetPath);
    if (stableBookId && target.book_id !== stableBookId) {
      throw new Error(`build target book_id ${target.book_id} does not match explicit book_id ${stableBookId}`);
    }
    return target;
  }
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new Error(`build target 不存在: ${targetPath}`);
  }

  const containingWorkspace = containingBuildWorkspaceSource(targetPath);
  if (containingWorkspace) {
    const target = targetFromWorkspace(containingWorkspace);
    if (stableBookId && target.book_id !== stableBookId) {
      throw new Error(`build target book_id ${target.book_id} does not match explicit book_id ${stableBookId}`);
    }
    return target;
  }

  const matches = stableBookId ? [] : paperWorkspaceCandidates(targetPath, resolvedRoot);
  if (matches.length > 1) {
    throw new Error(`paper 输入匹配到多个 Workbench workspace，请显式指定 book id 或 workspace 路径: ${matches.join(", ")}`);
  }
  if (matches.length === 1) return paperTargetFromWorkspace(matches[0]);
  if (path.extname(targetPath).toLowerCase() === ".pdf") {
    throw new Error("paper PDF 未匹配到可信 Workbench workspace，请先在预构建工作台完成来源对齐与混合阅读基座");
  }

  const bookId = stableBookId ?? deriveBookId(targetPath);
  const workspaceDir = path.join(resolvedRoot, ".understand-book", bookId);
  return {
    kind: "source_file",
    profile_id: "technical_learning",
    book_id: bookId,
    root_dir: resolvedRoot,
    workspace_dir: workspaceDir,
    source_path: targetPath,
    target_ref: {
      version: "build_target_ref.v2",
      workspace_dir: workspaceDir,
      book_id: bookId,
      profile_id: "technical_learning",
      input_fingerprint: sha256File(targetPath),
    },
  };
}

function buildAutomaticBuildSnapshotInternal(
  target: AutomaticBuildTarget,
  options: { quality_profile?: ExtractionQualityProfile } = {},
  auditPendingPass1 = false,
): AutomaticBuildSnapshot {
  const loaded = loadAutomaticBook(target.source_path);
  const stages: AutomaticBuildStageState[] = [];
  const profile = resolveContentProfile(target.profile_id);
  const qualityProfile = options.quality_profile ?? "full";
  const buildRoot = path.join(target.workspace_dir, ".build");
  void auditPendingPass1;
  const pass1State = routePass1ProductionStage({
    target,
    loaded,
    profile,
    quality_profile: qualityProfile,
  });
  stages.push(pass1State);
  if (pass1State.pending_tasks.length || !pass1State.closed) return { target, stages };

  if (target.profile_id === "paper") {
    const metadataPlan = routePaperMetadataWorkUnits({
      target: target.target_ref,
      windows: loaded.windows,
      byLid: loaded.byLid,
      source: loaded.source,
      policy_fingerprint: automaticBuildExtractionPolicy("paper_metadata", profile, qualityProfile),
    });
    const metadataWorkUnits = metadataPlan.work_units;
    const metadataBindings = bindingsFromDescriptors(metadataWorkUnits);
    const eligibleMetadataIds = metadataWorkUnits
      .filter((unit) => !unit.deterministic_skip)
      .map((unit) => Number(unit.work_unit_id));
    const metadataMeta = artifactMetaByNumericTask(
      path.join(buildRoot, "paper-metadata"),
      eligibleMetadataIds,
      target,
      "paper_metadata",
      metadataBindings,
    );
    const metadata = computePaperMetadataRoutingStatus(metadataPlan, metadataMeta);
    const metadataClosed = profileArtifactMatches(path.join(target.workspace_dir, "paper_metadata.json"), target);
    stages.push(stageState("paper_metadata", metadata.pending_ids, metadataClosed, metadataWorkUnits));
    if (metadata.pending || !metadataClosed) return { target, stages };

    const lexiconPlan = routePaperLexiconWorkUnits({
      target: target.target_ref,
      windows: loaded.windows,
      byLid: loaded.byLid,
      source: loaded.source,
      policy_fingerprint: automaticBuildExtractionPolicy("paper_lexicon", profile, qualityProfile),
    });
    const lexiconWorkUnits = lexiconPlan.work_units;
    const lexiconBindings = bindingsFromDescriptors(lexiconWorkUnits);
    const eligibleLexiconIds = lexiconWorkUnits
      .filter((unit) => !unit.deterministic_skip)
      .map((unit) => unit.work_unit_id);
    const lexiconMeta = artifactMetaByWorkUnit(
      path.join(buildRoot, "paper-lexicon"),
      eligibleLexiconIds,
      target,
      "paper_lexicon",
      lexiconBindings,
    );
    const lexicon = computePaperLexiconRoutingStatus(lexiconPlan, lexiconMeta);
    const lexiconClosed = profileArtifactMatches(path.join(target.workspace_dir, "paper_lexicon.json"), target);
    stages.push(stageState("paper_lexicon", lexicon.pending_ids, lexiconClosed, lexiconWorkUnits));
    if (lexicon.pending || !lexiconClosed) return { target, stages };
  }

  const sidecarState = routeProfileSidecarProductionStage({
    target,
    loaded,
    profile,
    quality_profile: qualityProfile,
  });
  stages.push(sidecarState);
  if (sidecarState.pending_tasks.length || !sidecarState.closed) return { target, stages };

  const base = readJson<ReadOnlyBase>(path.join(target.workspace_dir, "base.json"));
  const discourseIndex = readJson<TechnicalLearningDiscourseIndex>(path.join(target.workspace_dir, "discourse_index.json"));
  const formulaValue = readJson<{ items?: FormulaSemantics[] } | FormulaSemantics[]>(path.join(target.workspace_dir, "formula_semantics.json"));
  const formulaSemantics = Array.isArray(formulaValue) ? formulaValue : formulaValue.items ?? [];
  const candidateIndex = buildPass2Candidates({
    graphNodes: base.graph_nodes,
    windows: loaded.windows,
    discourseIndex,
    formulaSemantics,
  });
  const packets = new Map<number, Pass2WorkPacket>();
  for (const window of loaded.windows) {
    packets.set(window.id, buildPass2WorkPacket({
      window,
      byLid: loaded.byLid,
      source: loaded.source,
      graphNodes: base.graph_nodes,
      candidates: candidateIndex.candidates,
      discourseIndex,
      formulaSemantics,
    }));
  }
  const pass2Bindings = taskBindings("pass2", profile, qualityProfile, [...packets.entries()].map(([id, packet]) => ({
    task_id: id,
    input_hash: pass2PacketHash(packet),
  })));
  const pass2WorkUnits = [...packets.entries()].map(([id, packet]) => descriptorFromBinding({
    target,
    stage: "pass2",
    task_id: String(id),
    kind: "pass2_candidate_batch",
    binding: pass2Bindings[String(id)],
    evidence_lids: packet.source_window.leaf_lids,
    estimated_input_tokens: estimateTokens(JSON.stringify(packet)),
    formula_lids: packet.source_formula_semantics.length,
    candidate_count: packet.candidate_targets.length,
    expected_output_items: packet.candidate_targets.length,
    legacy_artifact_ref: `.build/pass2/${id}.json`,
  }));
  const pass2Meta = artifactMetaByNumericTask(
    path.join(buildRoot, "pass2"),
    loaded.windows.map((window) => window.id),
    target,
    "pass2",
    pass2Bindings,
  );
  const pass2 = computePass2Status(packets, pass2Meta);
  const pass2Closed = profileArtifactMatches(path.join(target.workspace_dir, "pass2_audit.json"), target);
  stages.push(stageState("pass2", pass2.pending, pass2Closed, pass2WorkUnits));
  const pass2Audit = pass2Closed
    ? readJson<NonNullable<Parameters<typeof buildBookStructureUnitSources>[0]["pass2Audit"]>>(
        path.join(target.workspace_dir, "pass2_audit.json"),
      )
    : undefined;
  const unitSources = buildBookStructureUnitSources({
    lidNodes: loaded.lidNodes,
    source: loaded.source,
    graphNodes: base.graph_nodes,
    graphEdges: base.graph_edges,
    discourseIndex,
    formulaSemantics,
    pass2Audit,
    contentProfile: profile,
  });
  const unitMeta = new Map<string, { content_hash: string }>();
  const unitArtifacts: BookStructureUnitArtifact[] = [];
  let allUnitsFresh = true;
  const structurePolicy = automaticBuildExtractionPolicy("book_structure", profile, qualityProfile);
  const structureBindings: Record<string, AutomaticBuildTaskPolicyBindingV1> = Object.fromEntries(unitSources.map((unit) => [unit.job_id, {
    input_hash: bookStructureUnitHash(unit),
    policy_fingerprint: structurePolicy,
  }]));
  const structureWorkUnits = unitSources.map((unit) => descriptorFromBinding({
    target,
    stage: "book_structure",
    task_id: unit.job_id,
    kind: "structure_unit",
    binding: structureBindings[unit.job_id],
    evidence_lids: unit.leaf_lids,
    estimated_input_tokens: estimateTokens(JSON.stringify(unit)),
    formula_lids: unit.formula_semantics.length,
    candidate_count: unit.pass2_edges.length,
    expected_output_items: 1,
    legacy_artifact_ref: `.build/book-structure/units/${unit.unit_lid}.json`,
  }));
  for (const unit of unitSources) {
    const file = path.join(buildRoot, "book-structure", "units", `${unit.unit_lid}.json`);
    if (!existsSync(file)) {
      allUnitsFresh = false;
      continue;
    }
    const artifact = freshSemanticPayload<BookStructureUnitArtifact>(file, semanticExpectation(
      target,
      "book_structure",
      unit.job_id,
      structureBindings[unit.job_id],
    ));
    if (!artifact) {
      allUnitsFresh = false;
      continue;
    }
    unitMeta.set(unit.job_id, { content_hash: artifact.content_hash });
    if (artifact.content_hash === bookStructureUnitHash(unit)) unitArtifacts.push(artifact);
    else allUnitsFresh = false;
  }
  const stitchPacket = allUnitsFresh && unitArtifacts.length === unitSources.length
    ? buildBookStructureStitchPacket(unitArtifacts, pass2Audit, profile)
    : undefined;
  if (stitchPacket) structureBindings.stitch = {
    input_hash: bookStructureStitchHash(stitchPacket),
    policy_fingerprint: structurePolicy,
  };
  if (stitchPacket) structureWorkUnits.push(descriptorFromBinding({
    target,
    stage: "book_structure",
    task_id: "stitch",
    kind: "structure_stitch",
    binding: structureBindings.stitch,
    evidence_lids: [...new Set(stitchPacket.unit_cards.flatMap((unit) => unit.evidence_lids))],
    estimated_input_tokens: estimateTokens(JSON.stringify(stitchPacket)),
    candidate_count: stitchPacket.unit_cards.length,
    expected_output_items: stitchPacket.unit_cards.length,
    legacy_artifact_ref: ".build/book-structure/stitch.json",
  }));
  const stitchFile = path.join(buildRoot, "book-structure", "stitch.json");
  const stitchArtifact = existsSync(stitchFile) && structureBindings.stitch
    ? freshSemanticPayload<BookStructureStitchArtifact>(stitchFile, semanticExpectation(
        target,
        "book_structure",
        "stitch",
        structureBindings.stitch,
      ))
    : undefined;
  const structure = computeBookStructureStatus(
    unitSources,
    unitMeta,
    stitchArtifact ? { content_hash: stitchArtifact.content_hash } : undefined,
    stitchPacket,
  );
  const structureTasks = structure.unit_pending.length
    ? structure.unit_pending
    : structure.stitch_pending
      ? ["stitch"]
      : [];
  const structureClosed = structure.stitch_done
    && profileArtifactMatches(path.join(target.workspace_dir, "book_structure.json"), target);
  stages.push(stageState("book_structure", structureTasks, structureClosed, structureWorkUnits));
  if (structureTasks.length || !structureClosed) return { target, stages };

  if (target.profile_id === "paper") {
    stages.push(stageState("paper_reading_guide", [], paperGuideVerificationFresh(target.workspace_dir)));
  }
  return { target, stages };
}

export function buildAutomaticBuildSnapshot(
  target: AutomaticBuildTarget,
  options: { quality_profile?: ExtractionQualityProfile } = {},
): AutomaticBuildSnapshot {
  return buildAutomaticBuildSnapshotInternal(target, options);
}

export function routeAutomaticBuildSnapshot(
  target: AutomaticBuildTarget,
  options: { quality_profile?: ExtractionQualityProfile } = {},
): AutomaticBuildRouteResult<AutomaticBuildSnapshot> {
  try {
    return readyAutomaticBuildRoute(buildAutomaticBuildSnapshotInternal(target, options, true));
  } catch (error) {
    if (!(error instanceof AutomaticBuildSnapshotRecoverySignal)) throw error;
    return blockedAutomaticBuildRoute(error.recovery);
  }
}

function planGateAction(
  reason: AutomaticBuildPlanGateReason,
  message: string,
  plan?: Partial<BuildPlanV1>,
  stage?: AutomaticBuildStage,
): AutomaticBuildPlanGateAction {
  return {
    kind: "needs_user",
    reason,
    message,
    ...(typeof plan?.plan_id === "string" ? { plan_id: plan.plan_id } : {}),
    ...(typeof plan?.plan_digest === "string" ? { plan_digest: plan.plan_digest } : {}),
    ...(stage ? { stage } : {}),
  };
}

function validatedExecutionPlan(input: unknown): BuildPlanV1 | AutomaticBuildPlanGateAction {
  if (input === undefined || input === null) {
    return planGateAction("build_plan_required", "confirm a BuildPlan before advancing automatic model work");
  }
  try {
    return validateBuildPlanV1(input);
  } catch {
    const record = input && typeof input === "object" ? input as Partial<BuildPlanV1> : undefined;
    if (record && typeof record.plan_digest === "string") {
      try {
        const expected = computeBuildPlanDigest(record as BuildPlanDigestSource);
        if (expected !== record.plan_digest) {
          return planGateAction(
            "build_plan_digest_drift",
            "the BuildPlan digest does not match its current identity",
            record,
          );
        }
      } catch {
        // The structural validation error below is the actionable boundary.
      }
    }
    return planGateAction("build_plan_invalid", "the BuildPlan contract is invalid", record);
  }
}

function validateExecutionClosure(plan: BuildPlanV1): AutomaticBuildStage[] | AutomaticBuildPlanGateAction {
  const expectedStandard = standardDeepStageClosure(plan.content_profile);
  const selected = plan.public_stage_closure;
  if (plan.recipe_id === "standard_deep") {
    const expectedSelected = standardDeepStageClosure(plan.content_profile, {
      pass2: selected.includes("pass2") ? "enabled" : "disabled",
    });
    if (canonicalBuildJson(selected) !== canonicalBuildJson(expectedSelected)) {
      return planGateAction(
        "build_plan_closure_drift",
        "standard_deep must use an exact current profile stage closure with its confirmed Pass2 choice",
        plan,
      );
    }
  } else {
    const selectedSet = new Set(selected);
    const ordered = expectedStandard.filter((stage) => selectedSet.has(stage));
    const knownAndOrdered = canonicalBuildJson(selected) === canonicalBuildJson(ordered);
    const dependenciesClosed = selected.every((stage) => BUILD_STAGE_DAG[stage as BuildStageId]
      && BUILD_STAGE_DAG[stage as BuildStageId].depends_on.every((dependency) => (
        !expectedStandard.includes(dependency as AutomaticBuildStage) || selectedSet.has(dependency as AutomaticBuildStage)
      )));
    if (!knownAndOrdered || !dependenciesClosed) {
      return planGateAction(
        "build_plan_closure_drift",
        "goal_directed public stages must be a stable dependency-closed subset of the current profile DAG",
        plan,
      );
    }
  }

  const closureArtifacts = new Set(selected.map((stage) => `public.${stage}`));
  const classified = [
    ...plan.reuse.map((item) => item.artifact),
    ...plan.create,
  ];
  const unexpectedPublic = classified.find((artifact) => (
    artifact.startsWith("public.")
    && artifact !== "public.foundation"
    && !closureArtifacts.has(artifact)
  ));
  const missingClassification = [...closureArtifacts].find((artifact) => !classified.includes(artifact));
  if (unexpectedPublic || missingClassification) {
    return planGateAction(
      "build_plan_closure_drift",
      "BuildPlan public reuse/create buckets must exactly classify the declared stage closure",
      plan,
    );
  }
  return selected as AutomaticBuildStage[];
}

export function nextPlannedAutomaticBuildAction(
  snapshot: AutomaticBuildSnapshot,
  planInput: unknown,
  maxParallel = 5,
  options: { quality_profile?: ExtractionQualityProfile } = {},
): AutomaticBuildAction | AutomaticBuildPlanGateAction {
  const validated = validatedExecutionPlan(planInput);
  if ("kind" in validated) return validated;
  const plan = validated;
  if (plan.status !== "confirmed") {
    return planGateAction("build_plan_unconfirmed", "automatic build requires a confirmed BuildPlan", plan);
  }
  if (plan.book_id !== snapshot.target.book_id) {
    return planGateAction("build_plan_book_drift", "BuildPlan book_id does not match the current target", plan);
  }
  if (plan.source_fingerprint !== snapshot.target.target_ref.input_fingerprint) {
    return planGateAction("build_plan_source_drift", "BuildPlan source fingerprint is stale", plan);
  }
  const profile = resolveContentProfile(snapshot.target.profile_id);
  if (plan.content_profile.id !== profile.id || plan.content_profile.version !== profile.profile_version) {
    return planGateAction("build_plan_profile_drift", "BuildPlan content profile is stale", plan);
  }
  const qualityProfile = options.quality_profile ?? "full";
  if (plan.public_stage_closure.length && qualityProfile !== "full") {
    return planGateAction(
      "build_plan_policy_drift",
      "confirmed public BuildPlans execute the full quality policy",
      plan,
    );
  }
  const closure = validateExecutionClosure(plan);
  if (!Array.isArray(closure)) return closure;

  const freshness = new Map(inspectAutomaticBuildStageFreshness(snapshot, { quality_profile: qualityProfile })
    .map((inspection) => [inspection.artifact, inspection]));
  for (const reused of plan.reuse) {
    if (!reused.artifact.startsWith("public.") || reused.artifact === "public.foundation") continue;
    const inspection = freshness.get(reused.artifact as `public.${AutomaticBuildStage}`);
    if (!inspection?.fresh || inspection.freshness_digest !== reused.freshness_digest) {
      return planGateAction(
        "build_plan_freshness_drift",
        `declared reusable artifact is no longer fresh: ${reused.artifact}`,
        plan,
        inspection?.stage,
      );
    }
  }
  const allowed = new Set(closure);
  return nextAutomaticBuildAction({
    ...snapshot,
    stages: snapshot.stages.filter((stage) => allowed.has(stage.stage)),
  }, maxParallel);
}

export function nextAutomaticBuildAction(snapshot: AutomaticBuildSnapshot, maxParallel = 5): AutomaticBuildAction {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  for (const stage of snapshot.stages) {
    if (stage.closed) continue;
    if (stage.pending_tasks.length) {
      const firstWorkUnit = stage.pending_work_units?.[0];
      const extractor = stage.stage === "paper_reading_guide"
        ? undefined
        : firstWorkUnit
          ? automaticBuildExtractorForWorkUnitKind(stage.stage, firstWorkUnit.kind)
          : automaticBuildExtractorForStage(stage.stage);
      if (!extractor) throw new Error(`stage ${stage.stage} has pending semantic tasks but no extractor`);
      const selectedPolicyDigest = firstWorkUnit
        ? extractionPolicyDigest(firstWorkUnit.policy_fingerprint)
        : undefined;
      const selectedWorkUnits = (stage.pending_work_units ?? [])
        .filter((unit) => !firstWorkUnit || (
          unit.kind === firstWorkUnit.kind
          && extractionPolicyDigest(unit.policy_fingerprint) === selectedPolicyDigest
        ))
        .slice(0, maxParallel);
      const selectedTaskIds = selectedWorkUnits.length
        ? selectedWorkUnits.map((unit) => unit.work_unit_id)
        : stage.pending_tasks.slice(0, maxParallel);
      return {
        kind: "extract",
        stage: stage.stage,
        extractor,
        task_ids: selectedTaskIds,
        max_attempts: 3,
        ...(selectedWorkUnits.length ? { work_units: selectedWorkUnits } : {}),
        ...(stage.task_bindings ? {
          task_bindings: Object.fromEntries(selectedTaskIds.map((taskId) => [
            taskId,
            stage.task_bindings![taskId],
          ])),
        } : {}),
      };
    }
    return { kind: "close_stage", stage: stage.stage };
  }
  return { kind: "done", book_id: snapshot.target.book_id, workspace_dir: snapshot.target.workspace_dir };
}
