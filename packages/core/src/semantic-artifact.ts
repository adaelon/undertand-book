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

export interface SemanticArtifactExpectation {
  target: BuildTargetRefV2;
  stage: SemanticBuildStage;
  work_unit_id: string;
  input_hash: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
}

export interface AutomaticBuildTaskPolicyBindingV1 {
  input_hash: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
}

export interface AutomaticBuildStagePolicyLockV1 {
  version: "automatic_build_stage_policy_lock.v1";
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  policy_digest: string;
  frozen_at: string;
}

const STAGE_POLICIES: Record<SemanticBuildStage, {
  stage_policy_version: string;
  router_version: string;
  prompt_sha256: string;
  schema_version: string;
}> = {
  pass1: {
    stage_policy_version: "pass1_policy.v1",
    router_version: routerVersionForStage("pass1"),
    prompt_sha256: "7f95eb6352042a9d37866488d71418f2a730e78eeedfdbdebe646cc912cb1330",
    schema_version: "pass1_output.v1",
  },
  paper_metadata: {
    stage_policy_version: "paper_metadata_policy.v1",
    router_version: routerVersionForStage("paper_metadata"),
    prompt_sha256: "a414cf53970cf4e9e537de09bd84b318f61fd210b07c25d48c6534c181057d85",
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_metadata,
  },
  paper_lexicon: {
    stage_policy_version: "paper_lexicon_policy.v1",
    router_version: routerVersionForStage("paper_lexicon"),
    prompt_sha256: "4ea919e3de78e7be73df41c4cf96a3a3fb832f061e126abfdee3addee21de675",
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_lexicon,
  },
  profile_sidecar: {
    stage_policy_version: "profile_sidecar_policy.v1",
    router_version: routerVersionForStage("profile_sidecar"),
    prompt_sha256: "e25b921b15519d4ee32df329c8e6d0cc23e72734457af4da8b511942732b0767",
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.profile_sidecar,
  },
  pass2: {
    stage_policy_version: "pass2_policy.v1",
    router_version: routerVersionForStage("pass2"),
    prompt_sha256: "f27c511920fd33dad8304540bebc6864fb149f933414c7905107ecf52d83b222",
    schema_version: "pass2_output.v1",
  },
  book_structure: {
    stage_policy_version: "book_structure_policy.v1",
    router_version: routerVersionForStage("book_structure"),
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

function isEnvelope(value: unknown): value is SemanticArtifactEnvelopeV2<unknown> {
  return typeof value === "object" && value !== null
    && (value as { version?: unknown }).version === "semantic_task_artifact.v2";
}

export function semanticArtifactMatches(
  value: unknown,
  expected: SemanticArtifactExpectation,
): boolean {
  if (!isEnvelope(value)) return false;
  return sameTarget(value.target, expected.target)
    && value.stage === expected.stage
    && value.work_unit_id === expected.work_unit_id
    && value.input_hash === expected.input_hash
    && extractionPolicyEqual(value.policy_fingerprint, expected.policy_fingerprint)
    && value.artifact_hash === sha256(value.payload);
}

export function inspectSemanticArtifact<T>(
  value: T | SemanticArtifactEnvelopeV2<T>,
  expected: SemanticArtifactExpectation,
): { format: "v2" | "legacy_v1"; policy_fresh: boolean; payload: T } {
  if (!isEnvelope(value)) return { format: "legacy_v1", policy_fresh: false, payload: value as T };
  return {
    format: "v2",
    policy_fresh: semanticArtifactMatches(value, expected),
    payload: value.payload as T,
  };
}

export function semanticArtifactPayload<T>(value: T | SemanticArtifactEnvelopeV2<T>): T {
  return isEnvelope(value) ? value.payload as T : value as T;
}

export function writeSemanticArtifactEnvelopeFile<T>(file: string, envelope: SemanticArtifactEnvelopeV2<T>): void {
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

export function freezeAutomaticBuildStagePolicy(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policy: ExtractionPolicyFingerprintV1,
  frozenAt = new Date().toISOString(),
): AutomaticBuildStagePolicyLockV1 {
  const file = automaticBuildStagePolicyLockPath(target, stage);
  const lock: AutomaticBuildStagePolicyLockV1 = {
    version: "automatic_build_stage_policy_lock.v1",
    target_ref: target.target_ref,
    stage,
    policy_fingerprint: policy,
    policy_digest: extractionPolicyDigest(policy),
    frozen_at: frozenAt,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return lock;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStagePolicyLockV1;
    if (existing.version !== lock.version
      || existing.stage !== stage
      || !sameTarget(existing.target_ref, target.target_ref)
      || !extractionPolicyEqual(existing.policy_fingerprint, policy)
      || existing.policy_digest !== lock.policy_digest) {
      throw new Error(`policy_mismatch: ${stage} policy is already frozen at ${file}`);
    }
    return existing;
  }
}
