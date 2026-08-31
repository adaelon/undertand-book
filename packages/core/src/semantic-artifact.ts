import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AutomaticBuildStage,
  AutomaticBuildTarget,
  BuildTargetRefV2,
} from "./build-orchestrator";
import type { ContentProfileDefinition } from "./content-profile";
import { EXTRACTOR_CONTRACT_SCHEMA_VERSIONS } from "./extractor-contract";
import { PROFILE_SIDECAR_POLICY_V2 } from "./automatic-build-protocol";
import { routerVersionForStage } from "./stage-work-unit";

export type SemanticBuildStage = Exclude<AutomaticBuildStage, "paper_reading_guide">;
export type ExtractionQualityProfile = "full" | "balanced" | "sparse";

export interface ExtractionPolicyFingerprintV1 {
  profile_id: string;
  profile_version: string;
  stage_policy_version: string;
  router_version: string;
  prompt_sha256: string;
  schema_version: string;
  quality_profile: ExtractionQualityProfile;
}

export interface SemanticContractV1 {
  profile_version: string;
  stage_policy_version: string;
  router_version: string;
  prompt_sha256: string;
  schema_version: string;
  quality_profile: ExtractionQualityProfile;
}

export interface SemanticArtifactProvenanceV2 {
  executor: string;
  model?: string;
  attempt: number;
  generated_at: string;
}

export interface SemanticArtifactEnvelopeV2<T> {
  version: "semantic_task_artifact.v2";
  target: BuildTargetRefV2;
  stage: SemanticBuildStage;
  work_unit_id: string;
  input_hash: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  artifact_hash: string;
  provenance: SemanticArtifactProvenanceV2;
  payload: T;
}

export interface SemanticArtifactEnvelopeV3<T> {
  version: "semantic_task_artifact.v3";
  target: BuildTargetRefV2;
  stage: SemanticBuildStage;
  work_unit_id: string;
  input_hash: string;
  policy_generation_id: string;
  semantic_contract: SemanticContractV1;
  artifact_hash: string;
  provenance: SemanticArtifactProvenanceV2;
  payload: T;
}

export type SemanticArtifactEnvelope<T> = SemanticArtifactEnvelopeV2<T> | SemanticArtifactEnvelopeV3<T>;

export interface SemanticArtifactExpectation {
  target: BuildTargetRefV2;
  stage: SemanticBuildStage;
  work_unit_id: string;
  input_hash: string;
  policy_generation_id?: string;
  semantic_contract: SemanticContractV1;
}

export interface AutomaticBuildTaskPolicyBindingV1 {
  input_hash: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
}

export interface AutomaticBuildTaskPolicyBindingV2 {
  input_hash: string;
  stage: SemanticBuildStage;
  policy_generation_id: string;
  semantic_contract: SemanticContractV1;
}

export type AutomaticBuildTaskPolicyBinding =
  | AutomaticBuildTaskPolicyBindingV1
  | AutomaticBuildTaskPolicyBindingV2;

export function isAutomaticBuildTaskPolicyBindingV2(
  binding: AutomaticBuildTaskPolicyBinding,
): binding is AutomaticBuildTaskPolicyBindingV2 {
  return "policy_generation_id" in binding;
}

export interface AutomaticBuildStagePolicyLockV2 {
  version: "automatic_build_stage_policy_lock.v2";
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  policy_generation_id: string;
  semantic_contract: SemanticContractV1;
  frozen_at: string;
}

const STAGE_POLICIES: Record<SemanticBuildStage, {
  stage_policy_version: string;
  prompt_sha256: string;
  schema_version: string;
}> = {
  pass1: {
    stage_policy_version: "pass1_policy.v1",
    prompt_sha256: "7f95eb6352042a9d37866488d71418f2a730e78eeedfdbdebe646cc912cb1330",
    schema_version: "pass1_output.v1",
  },
  paper_metadata: {
    stage_policy_version: "paper_metadata_policy.v1",
    prompt_sha256: "a414cf53970cf4e9e537de09bd84b318f61fd210b07c25d48c6534c181057d85",
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_metadata,
  },
  paper_lexicon: {
    stage_policy_version: "paper_lexicon_policy.v2",
    prompt_sha256: "b79dd841bb69f11b74e54d96552081fecef369504ad6313a1b7dab329e1e3bc8",
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_lexicon,
  },
  profile_sidecar: {
    stage_policy_version: PROFILE_SIDECAR_POLICY_V2.stage_policy_version,
    prompt_sha256: PROFILE_SIDECAR_POLICY_V2.prompt_sha256,
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.profile_sidecar,
  },
  pass2: {
    stage_policy_version: "pass2_policy.v1",
    prompt_sha256: "f27c511920fd33dad8304540bebc6864fb149f933414c7905107ecf52d83b222",
    schema_version: "pass2_output.v1",
  },
  book_structure: {
    stage_policy_version: "book_structure_policy.v1",
    prompt_sha256: "706bab293891b3b97aed23d4b09120cb7179f9248ac3a0263005047cf76dda46",
    schema_version: "book_structure_output.v1",
  },
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sameTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

export function extractionPolicyEqual(
  left: ExtractionPolicyFingerprintV1,
  right: ExtractionPolicyFingerprintV1,
): boolean {
  return left.profile_id === right.profile_id
    && left.profile_version === right.profile_version
    && left.stage_policy_version === right.stage_policy_version
    && left.router_version === right.router_version
    && left.prompt_sha256 === right.prompt_sha256
    && left.schema_version === right.schema_version
    && left.quality_profile === right.quality_profile;
}

export function semanticContractFromExtractionPolicy(
  policy: ExtractionPolicyFingerprintV1,
): SemanticContractV1 {
  return {
    profile_version: policy.profile_version,
    stage_policy_version: policy.stage_policy_version,
    router_version: policy.router_version,
    prompt_sha256: policy.prompt_sha256,
    schema_version: policy.schema_version,
    quality_profile: policy.quality_profile,
  };
}

export function extractionPolicyFromSemanticContract(
  profileId: string,
  contract: SemanticContractV1,
): ExtractionPolicyFingerprintV1 {
  return { profile_id: profileId, ...contract };
}

export function semanticContractEqual(
  left: SemanticContractV1,
  right: SemanticContractV1,
): boolean {
  return left.profile_version === right.profile_version
    && left.stage_policy_version === right.stage_policy_version
    && left.router_version === right.router_version
    && left.prompt_sha256 === right.prompt_sha256
    && left.schema_version === right.schema_version
    && left.quality_profile === right.quality_profile;
}

export function assertPolicyGenerationId(value: string, field = "policy_generation_id"): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${field} must be a bounded lowercase policy-owner identifier`);
  }
  return value;
}

export function extractionPolicyDigest(policy: ExtractionPolicyFingerprintV1): string {
  return sha256(policy);
}

export function automaticBuildExtractionPolicy(
  stage: SemanticBuildStage,
  profile: ContentProfileDefinition,
  qualityProfile: ExtractionQualityProfile = "full",
): ExtractionPolicyFingerprintV1 {
  const stagePolicy = STAGE_POLICIES[stage];
  return {
    profile_id: profile.id,
    profile_version: profile.profile_version,
    ...stagePolicy,
    router_version: routerVersionForStage(stage),
    quality_profile: qualityProfile,
  };
}

function assertProvenance(provenance: SemanticArtifactProvenanceV2): void {
  if (!provenance.executor.trim()) throw new Error("semantic artifact executor must not be empty");
  if (provenance.model && !/^(?:gpt-|o[1-9]|codex)/i.test(provenance.model)) {
    throw new Error(`semantic artifact model is not allowed by the Codex harness stage policy: ${provenance.model}`);
  }
  if (!Number.isInteger(provenance.attempt) || provenance.attempt < 1) {
    throw new Error("semantic artifact attempt must be a positive integer");
  }
  if (!Number.isFinite(Date.parse(provenance.generated_at))) {
    throw new Error("semantic artifact generated_at must be an ISO timestamp");
  }
}

export function buildSemanticArtifactEnvelope<T>(input: {
  target: BuildTargetRefV2;
  stage: SemanticBuildStage;
  work_unit_id: string;
  input_hash: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  provenance: SemanticArtifactProvenanceV2;
  payload: T;
}): SemanticArtifactEnvelopeV2<T> {
  if (!input.work_unit_id) throw new Error("semantic artifact work_unit_id must not be empty");
  if (!input.input_hash) throw new Error("semantic artifact input_hash must not be empty");
  assertProvenance(input.provenance);
  const payload = input.payload as { content_hash?: unknown };
  if (typeof payload === "object" && payload !== null
    && payload.content_hash !== undefined && payload.content_hash !== input.input_hash) {
    throw new Error("semantic artifact payload content_hash does not match input_hash");
  }
  return {
    version: "semantic_task_artifact.v2",
    target: input.target,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    input_hash: input.input_hash,
    policy_fingerprint: input.policy_fingerprint,
    artifact_hash: sha256(input.payload),
    provenance: input.provenance,
    payload: input.payload,
  };
}

export function buildSemanticArtifactEnvelopeV3<T>(input: {
  target: BuildTargetRefV2;
  stage: SemanticBuildStage;
  work_unit_id: string;
  input_hash: string;
  policy_generation_id: string;
  semantic_contract: SemanticContractV1;
  provenance: SemanticArtifactProvenanceV2;
  payload: T;
}): SemanticArtifactEnvelopeV3<T> {
  assertPolicyGenerationId(input.policy_generation_id, "semantic artifact policy_generation_id");
  if (!input.work_unit_id) throw new Error("semantic artifact work_unit_id must not be empty");
  if (!input.input_hash) throw new Error("semantic artifact input_hash must not be empty");
  assertProvenance(input.provenance);
  return {
    version: "semantic_task_artifact.v3",
    target: input.target,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    input_hash: input.input_hash,
    policy_generation_id: input.policy_generation_id,
    semantic_contract: input.semantic_contract,
    artifact_hash: sha256(input.payload),
    provenance: input.provenance,
    payload: input.payload,
  };
}

function isEnvelope(value: unknown): value is SemanticArtifactEnvelope<unknown> {
  return typeof value === "object" && value !== null
    && ["semantic_task_artifact.v2", "semantic_task_artifact.v3"]
      .includes(String((value as { version?: unknown }).version));
}

export function semanticArtifactMatches(
  value: unknown,
  expected: SemanticArtifactExpectation,
): boolean {
  if (!isEnvelope(value)) return false;
  const commonMatches = sameTarget(value.target, expected.target)
    && value.stage === expected.stage
    && value.work_unit_id === expected.work_unit_id
    && value.input_hash === expected.input_hash
    && value.artifact_hash === sha256(value.payload);
  if (!commonMatches) return false;
  const expectsV3 = expected.policy_generation_id !== undefined;
  if (!expectsV3) {
    return value.version === "semantic_task_artifact.v2"
      && semanticContractEqual(
        semanticContractFromExtractionPolicy(value.policy_fingerprint),
        expected.semantic_contract,
      );
  }
  return value.version === "semantic_task_artifact.v3"
    && expected.policy_generation_id !== undefined
    && value.policy_generation_id === expected.policy_generation_id
    && semanticContractEqual(value.semantic_contract, expected.semantic_contract);
}

export function inspectSemanticArtifact<T>(
  value: T | SemanticArtifactEnvelope<T>,
  expected: SemanticArtifactExpectation,
): { format: "v3" | "v2" | "legacy_v1"; policy_fresh: boolean; payload: T } {
  if (!isEnvelope(value)) return { format: "legacy_v1", policy_fresh: false, payload: value as T };
  return {
    format: value.version === "semantic_task_artifact.v3" ? "v3" : "v2",
    policy_fresh: semanticArtifactMatches(value, expected),
    payload: value.payload as T,
  };
}

export function semanticArtifactPayload<T>(value: T | SemanticArtifactEnvelope<T>): T {
  return isEnvelope(value) ? value.payload as T : value as T;
}

export function writeSemanticArtifactEnvelopeFile<T>(file: string, envelope: SemanticArtifactEnvelope<T>): void {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    if (!existsSync(file)) throw error;
    rmSync(file);
    renameSync(temp, file);
  }
}

export function automaticBuildStagePolicyLockPath(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
): string {
  return path.join(target.workspace_dir, ".build", "automatic-build", "v2", "policies", `${stage}.json`);
}

export function automaticBuildStagePolicyGenerationLockPath(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policyGenerationId: string,
): string {
  assertPolicyGenerationId(policyGenerationId, "stage policy_generation_id");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "policies",
    stage,
    `${policyGenerationId}.json`,
  );
}

export function readAutomaticBuildStagePolicyLock(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
): AutomaticBuildStagePolicyLockV2 | undefined {
  const file = automaticBuildStagePolicyLockPath(target, stage);
  if (!existsSync(file)) return undefined;
  const lock = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStagePolicyLockV2;
  if (lock.version !== "automatic_build_stage_policy_lock.v2"
    || lock.stage !== stage
    || !sameTarget(lock.target_ref, target.target_ref)
    || !assertPolicyGenerationId(lock.policy_generation_id)
    || !Number.isFinite(Date.parse(lock.frozen_at))) {
    throw new Error(`invalid automatic build stage policy lock: ${file}`);
  }
  return lock;
}

export function freezeAutomaticBuildStagePolicy(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policyGenerationId: string,
  policy: ExtractionPolicyFingerprintV1,
  frozenAt = new Date().toISOString(),
): AutomaticBuildStagePolicyLockV2 {
  const file = automaticBuildStagePolicyLockPath(target, stage);
  const lock: AutomaticBuildStagePolicyLockV2 = {
    version: "automatic_build_stage_policy_lock.v2",
    target_ref: target.target_ref,
    stage,
    policy_generation_id: assertPolicyGenerationId(policyGenerationId),
    semantic_contract: semanticContractFromExtractionPolicy(policy),
    frozen_at: frozenAt,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return lock;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readAutomaticBuildStagePolicyLock(target, stage);
    if (!existing
      || existing.version !== lock.version
      || existing.policy_generation_id !== lock.policy_generation_id
      || !semanticContractEqual(existing.semantic_contract, lock.semantic_contract)) {
      throw new Error(`policy_mismatch: ${stage} policy is already frozen at ${file}`);
    }
    return existing;
  }
}

export function freezeAutomaticBuildStagePolicyGeneration(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policyGenerationId: string,
  policy: ExtractionPolicyFingerprintV1,
  frozenAt = new Date().toISOString(),
): AutomaticBuildStagePolicyLockV2 {
  const generationId = assertPolicyGenerationId(policyGenerationId);
  const file = automaticBuildStagePolicyGenerationLockPath(target, stage, generationId);
  const lock: AutomaticBuildStagePolicyLockV2 = {
    version: "automatic_build_stage_policy_lock.v2",
    target_ref: target.target_ref,
    stage,
    policy_generation_id: generationId,
    semantic_contract: semanticContractFromExtractionPolicy(policy),
    frozen_at: frozenAt,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return lock;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStagePolicyLockV2;
    if (existing.version !== lock.version
      || existing.stage !== stage
      || !sameTarget(existing.target_ref, target.target_ref)
      || existing.policy_generation_id !== generationId
      || !semanticContractEqual(existing.semantic_contract, lock.semantic_contract)
      || !Number.isFinite(Date.parse(existing.frozen_at))) {
      throw new Error(`policy_generation_conflict: ${stage} policy generation is frozen at ${file}`);
    }
    return existing;
  }
}

function generationWorkUnitFileName(workUnitId: string): string {
  if (!workUnitId || Buffer.byteLength(workUnitId, "utf8") > 512) {
    throw new Error("generation work_unit_id must be a non-empty bounded string");
  }
  const encoded = encodeURIComponent(workUnitId);
  if (Buffer.byteLength(encoded, "utf8") > 220) return `${sha256(workUnitId)}.json`;
  return `${encoded}.json`;
}

export function automaticBuildGenerationArtifactPath(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policyGenerationId: string,
  workUnitId: string,
): string {
  assertPolicyGenerationId(policyGenerationId, "generation policy_generation_id");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "artifacts",
    stage,
    policyGenerationId,
    generationWorkUnitFileName(workUnitId),
  );
}

export function writeAutomaticBuildGenerationArtifact<T>(
  target: AutomaticBuildTarget,
  envelope: SemanticArtifactEnvelopeV3<T>,
): string {
  if (!sameTarget(envelope.target, target.target_ref)) {
    throw new Error("generation artifact target does not match the automatic build target");
  }
  if (envelope.version !== "semantic_task_artifact.v3"
    || !semanticArtifactMatches(envelope, {
      target: envelope.target,
      stage: envelope.stage,
      work_unit_id: envelope.work_unit_id,
      input_hash: envelope.input_hash,
      policy_generation_id: envelope.policy_generation_id,
      semantic_contract: envelope.semantic_contract,
    })) {
    throw new Error("generation artifact envelope is invalid");
  }
  const file = automaticBuildGenerationArtifactPath(
    target,
    envelope.stage,
    envelope.policy_generation_id,
    envelope.work_unit_id,
  );
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    return file;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (readFileSync(file, "utf8") !== bytes) {
      throw new Error(`policy_generation_conflict: generation artifact is already frozen: ${file}`);
    }
    return file;
  }
}
