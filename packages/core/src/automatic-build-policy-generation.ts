import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 } from "./executor-transport";
import { inspectAutomaticBuildTaskClaim } from "./automatic-build-lease";
import { automaticBuildLegacyStageArtifactPath } from "./automatic-build-legacy";
import {
  automaticBuildExtractorForWorkUnitKind,
  type AutomaticBuildTarget,
  type BuildTargetRefV2,
  type SemanticExtractor,
} from "./build-orchestrator";
import { verifyModelInputBudgetProof } from "./model-input-budget";
import {
  automaticBuildGenerationArtifactPath,
  buildSemanticArtifactEnvelopeV3,
  assertPolicyGenerationId,
  semanticContractEqual,
  semanticContractFromExtractionPolicy,
  inspectSemanticArtifact,
  readAutomaticBuildStagePolicyLock,
  writeAutomaticBuildGenerationArtifact,
  type ExtractionPolicyFingerprintV1,
  type SemanticContractV1,
  type SemanticArtifactEnvelopeV2,
  type SemanticArtifactEnvelopeV3,
  type SemanticArtifactProvenanceV2,
  type SemanticBuildStage,
} from "./semantic-artifact";
import {
  isWorkUnitDescriptorV4,
  validateWorkUnitDescriptorV3,
  validateWorkUnitDescriptorV4,
  type WorkUnitDescriptorV2,
  type WorkUnitDescriptorV3,
  type WorkUnitDescriptorV4,
  type WorkUnitKind,
} from "./stage-work-unit";

export interface AutomaticBuildStagePolicySetMemberInputV1 {
  kind: WorkUnitKind;
  extractor: SemanticExtractor;
  policy_generation_id: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
}

export interface AutomaticBuildStagePolicySetMemberV3 {
  kind: WorkUnitKind;
  extractor: SemanticExtractor;
  policy_generation_id: string;
  semantic_contract: SemanticContractV1;
}

export interface AutomaticBuildStagePolicySetV3 {
  version: "automatic_build_stage_policy_set.v3";
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  members: AutomaticBuildStagePolicySetMemberV3[];
  frozen_at: string;
}

export interface AutomaticBuildPolicyGenerationLockV1 {
  version: "automatic_build_policy_generation.v1";
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  policy_generation_id: string;
  semantic_contract: SemanticContractV1;
  frozen_at: string;
}

export type AutomaticBuildPolicyMigrationCurrent =
  | {
      route: "model";
      descriptor: WorkUnitDescriptorV3 | WorkUnitDescriptorV4;
      rendered_input: string;
    }
  | {
      route: "deterministic_skip";
      work_unit_id: string;
      work_unit_kind: WorkUnitKind;
      policy_fingerprint: ExtractionPolicyFingerprintV1;
      evidence_lids: string[];
      skip_code: string;
    }
  | {
      route: "blocked";
      work_unit_id: string;
      work_unit_kind: WorkUnitKind;
      policy_fingerprint: ExtractionPolicyFingerprintV1;
      evidence_lids: string[];
      block_reason: "model_input_unsplittable" | "policy_generation_conflict";
      retryable: boolean;
    };

export type AutomaticBuildPolicyMigrationDecision = "adopt_exact" | "rebuild" | "deterministic_skip";

export type AutomaticBuildPolicyMigrationReason =
  | "exact_input_and_policy"
  | "no_previous_artifact"
  | "source_or_target_changed"
  | "work_unit_kind_changed"
  | "rendered_input_changed"
  | "semantic_policy_changed"
  | "current_router_skip";

export type AutomaticBuildPolicyMigrationBlockReason =
  | "active_lease"
  | "budget_proof_invalid"
  | "model_input_unsplittable"
  | "policy_generation_conflict"
  | "previous_generation_semantic_drift"
  | "previous_input_unverifiable"
  | "previous_artifact_invalid";

interface AutomaticBuildPolicyMigrationIdentityV2 {
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  from_policy_generation_id: string;
  to_policy_generation_id: string;
  work_unit_id: string;
  work_unit_kind: WorkUnitKind;
  current_route: AutomaticBuildPolicyMigrationCurrent["route"];
  semantic_contract: SemanticContractV1;
  current_input_hash?: string;
}

export interface AutomaticBuildPolicyMigrationReceiptV2 extends AutomaticBuildPolicyMigrationIdentityV2 {
  version: "automatic_build_policy_migration_receipt.v2";
  decision: AutomaticBuildPolicyMigrationDecision;
  reason: AutomaticBuildPolicyMigrationReason;
  adopted_artifact?: {
    work_unit_id: string;
    relative_path: string;
    envelope_version: "semantic_task_artifact.v2" | "semantic_task_artifact.v3";
    artifact_hash: string;
  };
  deterministic_skip?: {
    code: string;
    evidence_lids: string[];
  };
  created_at: string;
}

export interface AutomaticBuildPolicyMigrationBlockV2 extends AutomaticBuildPolicyMigrationIdentityV2 {
  version: "automatic_build_policy_migration_block.v2";
  decision: "blocked";
  reason: AutomaticBuildPolicyMigrationBlockReason;
  retryable: boolean;
}

export type AutomaticBuildPolicyMigrationResult =
  | AutomaticBuildPolicyMigrationReceiptV2
  | AutomaticBuildPolicyMigrationBlockV2;

export interface AutomaticBuildPolicyMigrationPreviousV2 {
  descriptor: WorkUnitDescriptorV2;
  rendered_input?: string;
  artifact_path?: string;
}

interface DigestBoundSemanticArtifactEnvelopeV3<T> {
  version: "semantic_task_artifact.v3";
  target: BuildTargetRefV2;
  stage: SemanticBuildStage;
  work_unit_id: string;
  input_hash: string;
  proof_digest: string;
  policy_set_digest: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  artifact_hash: string;
  provenance: SemanticArtifactProvenanceV2;
  payload: T;
}

export interface AutomaticBuildPolicyGenerationResolutionV2 {
  version: "automatic_build_policy_generation_resolution.v2";
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  policy_generations: Array<{
    kind: WorkUnitKind;
    policy_generation_id: string;
    semantic_contract: SemanticContractV1;
  }>;
  status: "ready" | "pending" | "incomplete" | "blocked";
  adopted_units: string[];
  rebuilt_units: string[];
  deterministic_skip_units: string[];
  pending_rebuild_units: string[];
  missing_receipt_units: string[];
  stale_units: string[];
}

class BudgetProofInvalidError extends Error {}

export class AutomaticBuildPolicyGenerationConflictError extends Error {
  readonly name = "AutomaticBuildPolicyGenerationConflictError";

  constructor(readonly conflict_code: "policy_set_identity" | "policy_set_frozen" | "migration_source_lock" | "migration_receipt_frozen") {
    super(`policy_generation_conflict:${conflict_code}`);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DIGEST_BOUND_ARTIFACT_KEYS = [
  "artifact_hash",
  "input_hash",
  "payload",
  "policy_fingerprint",
  "policy_set_digest",
  "proof_digest",
  "provenance",
  "stage",
  "target",
  "version",
  "work_unit_id",
] as const;

function parseDigestBoundGenerationArtifact(
  value: unknown,
): DigestBoundSemanticArtifactEnvelopeV3<unknown> | undefined {
  if (!isRecord(value)
    || Object.keys(value).sort().join("\n") !== [...DIGEST_BOUND_ARTIFACT_KEYS].sort().join("\n")
    || value.version !== "semantic_task_artifact.v3"
    || !isRecord(value.target)
    || typeof value.target.version !== "string"
    || typeof value.target.workspace_dir !== "string"
    || typeof value.target.book_id !== "string"
    || typeof value.target.profile_id !== "string"
    || typeof value.target.input_fingerprint !== "string"
    || typeof value.stage !== "string"
    || typeof value.work_unit_id !== "string"
    || typeof value.input_hash !== "string"
    || typeof value.proof_digest !== "string"
    || typeof value.policy_set_digest !== "string"
    || !isRecord(value.policy_fingerprint)
    || !isRecord(value.provenance)
    || typeof value.artifact_hash !== "string") {
    return undefined;
  }
  return value as unknown as DigestBoundSemanticArtifactEnvelopeV3<unknown>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function assertBounded(value: string, field: string, maxBytes = 512): string {
  if (!value || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function sameTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function assertSemanticContract(
  contract: SemanticContractV1,
  field: string,
): SemanticContractV1 {
  assertBounded(contract.profile_version, `${field}.profile_version`, 128);
  assertBounded(contract.stage_policy_version, `${field}.stage_policy_version`, 128);
  assertBounded(contract.router_version, `${field}.router_version`, 128);
  assertSha256(contract.prompt_sha256, `${field}.prompt_sha256`);
  assertBounded(contract.schema_version, `${field}.schema_version`, 128);
  if (!( ["full", "balanced", "sparse"] as string[]).includes(contract.quality_profile)) {
    throw new Error(`${field}.quality_profile is unsupported`);
  }
  return contract;
}

function normalizePolicyMemberInputs(
  targetRef: BuildTargetRefV2,
  stage: SemanticBuildStage,
  members: AutomaticBuildStagePolicySetMemberInputV1[],
): AutomaticBuildStagePolicySetMemberV3[] {
  if (!members.length) throw new Error("automatic build stage policy set must contain at least one member");
  const normalized = members.map((member) => {
    assertBounded(member.kind, "policy member kind");
    const expectedExtractor = automaticBuildExtractorForWorkUnitKind(stage, member.kind);
    if (member.extractor !== expectedExtractor) {
      throw new Error(`policy member extractor does not match ${stage}/${member.kind}`);
    }
    if (member.policy_fingerprint.profile_id !== targetRef.profile_id) {
      throw new Error("policy member profile does not match target profile");
    }
    return {
      kind: member.kind,
      extractor: member.extractor,
      policy_generation_id: assertPolicyGenerationId(
        member.policy_generation_id,
        `policy member ${member.kind} policy_generation_id`,
      ),
      semantic_contract: assertSemanticContract(
        semanticContractFromExtractionPolicy(member.policy_fingerprint),
        `policy member ${member.kind} semantic_contract`,
      ),
    };
  }).sort((left, right) => left.kind.localeCompare(right.kind));
  if (new Set(normalized.map((member) => member.kind)).size !== normalized.length) {
    throw new Error("automatic build stage policy set member kinds must be unique");
  }
  const contracts = new Map<string, SemanticContractV1>();
  for (const member of normalized) {
    const existing = contracts.get(member.policy_generation_id);
    if (existing && !semanticContractEqual(existing, member.semantic_contract)) {
      throw new Error("one policy_generation_id cannot name different semantic contracts");
    }
    contracts.set(member.policy_generation_id, member.semantic_contract);
  }
  return normalized;
}

export function createAutomaticBuildStagePolicySet(input: {
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  members: AutomaticBuildStagePolicySetMemberInputV1[];
  frozen_at?: string;
}): AutomaticBuildStagePolicySetV3 {
  const frozenAt = input.frozen_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(frozenAt))) throw new Error("policy set frozen_at must be an ISO timestamp");
  return {
    version: "automatic_build_stage_policy_set.v3",
    target_ref: input.target_ref,
    stage: input.stage,
    members: normalizePolicyMemberInputs(input.target_ref, input.stage, input.members),
    frozen_at: frozenAt,
  };
}

export function validateAutomaticBuildStagePolicySet(
  policySet: AutomaticBuildStagePolicySetV3,
): AutomaticBuildStagePolicySetV3 {
  if (policySet.version !== "automatic_build_stage_policy_set.v3"
    || !Number.isFinite(Date.parse(policySet.frozen_at))) {
    throw new Error("unsupported automatic build stage policy set version");
  }
  const normalized = policySet.members.map((member) => {
    assertBounded(member.kind, "policy member kind");
    const expectedExtractor = automaticBuildExtractorForWorkUnitKind(policySet.stage, member.kind);
    if (member.extractor !== expectedExtractor) {
      throw new Error(`policy member extractor does not match ${policySet.stage}/${member.kind}`);
    }
    return {
      kind: member.kind,
      extractor: member.extractor,
      policy_generation_id: assertPolicyGenerationId(member.policy_generation_id),
      semantic_contract: assertSemanticContract(member.semantic_contract, "policy member semantic_contract"),
    };
  }).sort((left, right) => left.kind.localeCompare(right.kind));
  if (!normalized.length
    || new Set(normalized.map((member) => member.kind)).size !== normalized.length
    || stableJson(normalized) !== stableJson(policySet.members)) {
    throw new Error("automatic build stage policy members are invalid or not canonical");
  }
  const contracts = new Map<string, SemanticContractV1>();
  for (const member of normalized) {
    const existing = contracts.get(member.policy_generation_id);
    if (existing && !semanticContractEqual(existing, member.semantic_contract)) {
      throw new Error("one policy_generation_id cannot name different semantic contracts");
    }
    contracts.set(member.policy_generation_id, member.semantic_contract);
  }
  return policySet;
}

export function resolveAutomaticBuildStagePolicyMember(
  policySetInput: AutomaticBuildStagePolicySetV3,
  kind: WorkUnitKind,
  policy?: ExtractionPolicyFingerprintV1,
): AutomaticBuildStagePolicySetMemberV3 {
  const policySet = validateAutomaticBuildStagePolicySet(policySetInput);
  const member = policySet.members.find((candidate) => candidate.kind === kind);
  if (!member) {
    throw new Error(`automatic build stage policy set has no member for ${policySet.stage}/${kind}`);
  }
  if (policy && !semanticContractEqual(
    member.semantic_contract,
    semanticContractFromExtractionPolicy(policy),
  )) {
    throw new Error(`automatic build policy member contract drifted for ${policySet.stage}/${kind}`);
  }
  return member;
}

export function automaticBuildPolicyGenerationPath(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policyGenerationId: string,
): string {
  assertPolicyGenerationId(policyGenerationId);
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v4",
    "policies",
    stage,
    policyGenerationId,
    "policy.json",
  );
}

export function readAutomaticBuildPolicyGeneration(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policyGenerationId: string,
): AutomaticBuildPolicyGenerationLockV1 | undefined {
  const file = automaticBuildPolicyGenerationPath(target, stage, policyGenerationId);
  if (!existsSync(file)) return undefined;
  const generation = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildPolicyGenerationLockV1;
  if (generation.version !== "automatic_build_policy_generation.v1"
    || generation.stage !== stage
    || generation.policy_generation_id !== policyGenerationId
    || !sameTarget(generation.target_ref, target.target_ref)
    || !Number.isFinite(Date.parse(generation.frozen_at))) {
    throw new AutomaticBuildPolicyGenerationConflictError("policy_set_identity");
  }
  assertSemanticContract(generation.semantic_contract, "policy generation semantic_contract");
  return generation;
}

export function freezeAutomaticBuildStagePolicySet(
  target: AutomaticBuildTarget,
  policySetInput: AutomaticBuildStagePolicySetV3,
): AutomaticBuildStagePolicySetV3 {
  const policySet = validateAutomaticBuildStagePolicySet(policySetInput);
  if (!sameTarget(policySet.target_ref, target.target_ref)) {
    throw new Error("policy set target does not match automatic build target");
  }
  for (const member of policySet.members) {
    const file = automaticBuildPolicyGenerationPath(target, policySet.stage, member.policy_generation_id);
    const generation: AutomaticBuildPolicyGenerationLockV1 = {
      version: "automatic_build_policy_generation.v1",
      target_ref: policySet.target_ref,
      stage: policySet.stage,
      policy_generation_id: member.policy_generation_id,
      semantic_contract: member.semantic_contract,
      frozen_at: policySet.frozen_at,
    };
    const bytes = `${JSON.stringify(generation, null, 2)}\n`;
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const existing = readAutomaticBuildPolicyGeneration(
        target,
        policySet.stage,
        member.policy_generation_id,
      );
      if (!existing || !semanticContractEqual(existing.semantic_contract, member.semantic_contract)) {
        throw new AutomaticBuildPolicyGenerationConflictError("policy_set_frozen");
      }
    }
  }
  return policySet;
}

function migrationWorkUnitFileName(workUnitId: string): string {
  assertBounded(workUnitId, "migration work_unit_id");
  const encoded = encodeURIComponent(workUnitId);
  return Buffer.byteLength(encoded, "utf8") <= 220 ? `${encoded}.json` : `${sha256(workUnitId)}.json`;
}

export function automaticBuildPolicyMigrationReceiptPath(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  fromPolicyGenerationId: string,
  toPolicyGenerationId: string,
  workUnitId: string,
): string {
  assertPolicyGenerationId(fromPolicyGenerationId, "from_policy_generation_id");
  assertPolicyGenerationId(toPolicyGenerationId, "to_policy_generation_id");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v4",
    "migrations",
    stage,
    `${fromPolicyGenerationId}-to-${toPolicyGenerationId}`,
    migrationWorkUnitFileName(workUnitId),
  );
}

function currentIdentity(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  current: AutomaticBuildPolicyMigrationCurrent,
  policySet: AutomaticBuildStagePolicySetV3,
): Omit<AutomaticBuildPolicyMigrationIdentityV2, "from_policy_generation_id"> {
  if (current.route === "model") {
    let descriptor: WorkUnitDescriptorV3 | WorkUnitDescriptorV4;
    try {
      descriptor = isWorkUnitDescriptorV4(current.descriptor)
        ? validateWorkUnitDescriptorV4(
            current.descriptor,
            CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
          )
        : validateWorkUnitDescriptorV3(current.descriptor);
    } catch {
      throw new BudgetProofInvalidError("current migration descriptor has an invalid budget proof");
    }
    if (descriptor.stage !== stage || !sameTarget(descriptor.target, target.target_ref)) {
      throw new Error("current migration descriptor identity does not match target stage");
    }
    const semanticContract = semanticContractFromExtractionPolicy(descriptor.policy_fingerprint);
    const member = policySet.members.find((candidate) => candidate.kind === descriptor.kind
      && semanticContractEqual(candidate.semantic_contract, semanticContract));
    if (!member) throw new Error("current migration descriptor is outside the frozen policy set");
    try {
      if (isWorkUnitDescriptorV4(descriptor)) {
        const renderedHash = createHash("sha256")
          .update(current.rendered_input, "utf8")
          .digest("hex");
        if (renderedHash !== descriptor.input_hash) {
          throw new Error("rendered input hash mismatch");
        }
      } else {
        verifyModelInputBudgetProof(current.rendered_input, descriptor.input_budget_proof);
      }
    } catch {
      throw new BudgetProofInvalidError("current migration rendered input does not match its budget proof");
    }
    return {
      target_ref: target.target_ref,
      stage,
      to_policy_generation_id: member.policy_generation_id,
      work_unit_id: descriptor.work_unit_id,
      work_unit_kind: descriptor.kind,
      current_route: "model",
      semantic_contract: semanticContract,
      current_input_hash: descriptor.input_hash,
    };
  }
  assertBounded(current.work_unit_id, `${current.route} work_unit_id`);
  if (current.route === "deterministic_skip") {
    assertBounded(current.skip_code, "deterministic skip code", 128);
  }
  if (!current.evidence_lids.length || current.evidence_lids.some((lid) => !lid || Buffer.byteLength(lid, "utf8") > 256)) {
    throw new Error("deterministic skip evidence_lids must be non-empty bounded strings");
  }
  const semanticContract = semanticContractFromExtractionPolicy(current.policy_fingerprint);
  const member = policySet.members.find((candidate) => candidate.kind === current.work_unit_kind
    && semanticContractEqual(candidate.semantic_contract, semanticContract));
  if (!member) throw new Error("deterministic skip is outside the frozen policy set");
  return {
    target_ref: target.target_ref,
    stage,
    to_policy_generation_id: member.policy_generation_id,
    work_unit_id: current.work_unit_id,
    work_unit_kind: current.work_unit_kind,
    current_route: current.route,
    semantic_contract: semanticContract,
  };
}

function policyAdoptionCompatible(
  previous: ExtractionPolicyFingerprintV1,
  current: ExtractionPolicyFingerprintV1,
): boolean {
  return previous.profile_id === current.profile_id
    && previous.profile_version === current.profile_version
    && previous.stage_policy_version === current.stage_policy_version
    && previous.prompt_sha256 === current.prompt_sha256
    && previous.schema_version === current.schema_version
    && previous.quality_profile === current.quality_profile;
}

function safeWorkspaceRelativePath(target: AutomaticBuildTarget, file: string): string {
  const workspace = path.resolve(target.workspace_dir);
  const resolved = path.resolve(file);
  const relative = path.relative(workspace, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("previous migration artifact path escapes the target workspace");
  }
  return relative.replaceAll("\\", "/");
}

function receiptComparable(receipt: AutomaticBuildPolicyMigrationReceiptV2): unknown {
  const { created_at: _createdAt, ...identity } = receipt;
  return identity;
}

export function validateAutomaticBuildPolicyMigrationReceipt(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  receipt: AutomaticBuildPolicyMigrationReceiptV2,
): AutomaticBuildPolicyMigrationReceiptV2 {
  if (receipt.version !== "automatic_build_policy_migration_receipt.v2"
    || receipt.stage !== stage
    || !sameTarget(receipt.target_ref, target.target_ref)
    || !(["adopt_exact", "rebuild", "deterministic_skip"] as string[]).includes(receipt.decision)
    || !Number.isFinite(Date.parse(receipt.created_at))) {
    throw new Error("invalid automatic build policy migration receipt");
  }
  assertPolicyGenerationId(receipt.from_policy_generation_id, "receipt.from_policy_generation_id");
  assertPolicyGenerationId(receipt.to_policy_generation_id, "receipt.to_policy_generation_id");
  assertSemanticContract(receipt.semantic_contract, "receipt.semantic_contract");
  if (receipt.current_input_hash) assertSha256(receipt.current_input_hash, "receipt.current_input_hash");
  if (receipt.adopted_artifact) {
    assertBounded(receipt.adopted_artifact.work_unit_id, "receipt adopted work_unit_id");
    assertBounded(receipt.adopted_artifact.relative_path, "receipt adopted relative_path", 1_024);
    if (!(receipt.adopted_artifact.envelope_version === "semantic_task_artifact.v2"
      || receipt.adopted_artifact.envelope_version === "semantic_task_artifact.v3")) {
      throw new Error("receipt adopted artifact envelope version is unsupported");
    }
    assertSha256(receipt.adopted_artifact.artifact_hash, "receipt adopted artifact_hash");
  }
  if (receipt.deterministic_skip) {
    assertBounded(receipt.deterministic_skip.code, "receipt deterministic skip code", 128);
    if (!receipt.deterministic_skip.evidence_lids.length
      || receipt.deterministic_skip.evidence_lids.some((lid) => !lid || Buffer.byteLength(lid, "utf8") > 256)) {
      throw new Error("receipt deterministic skip evidence_lids are invalid");
    }
  }
  return receipt;
}

function persistMigrationReceipt(
  target: AutomaticBuildTarget,
  receipt: AutomaticBuildPolicyMigrationReceiptV2,
): AutomaticBuildPolicyMigrationReceiptV2 {
  const file = automaticBuildPolicyMigrationReceiptPath(
    target,
    receipt.stage,
    receipt.from_policy_generation_id,
    receipt.to_policy_generation_id,
    receipt.work_unit_id,
  );
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    return receipt;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = validateAutomaticBuildPolicyMigrationReceipt(
      target,
      receipt.stage,
      JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildPolicyMigrationReceiptV2,
    );
    if (stableJson(receiptComparable(existing)) !== stableJson(receiptComparable(receipt))) {
      throw new AutomaticBuildPolicyGenerationConflictError("migration_receipt_frozen");
    }
    return existing;
  }
}

function migrationBlock(
  identity: AutomaticBuildPolicyMigrationIdentityV2,
  reason: AutomaticBuildPolicyMigrationBlockReason,
  retryable: boolean,
): AutomaticBuildPolicyMigrationBlockV2 {
  return {
    version: "automatic_build_policy_migration_block.v2",
    ...identity,
    decision: "blocked",
    reason,
    retryable,
  };
}

function createMigrationReceipt(
  identity: AutomaticBuildPolicyMigrationIdentityV2,
  decision: AutomaticBuildPolicyMigrationDecision,
  reason: AutomaticBuildPolicyMigrationReason,
  now: string,
  extras: Pick<AutomaticBuildPolicyMigrationReceiptV2, "adopted_artifact" | "deterministic_skip"> = {},
): AutomaticBuildPolicyMigrationReceiptV2 {
  if (!Number.isFinite(Date.parse(now))) throw new Error("migration receipt created_at must be an ISO timestamp");
  const core = {
    version: "automatic_build_policy_migration_receipt.v2" as const,
    ...identity,
    decision,
    reason,
    ...(extras.adopted_artifact ? { adopted_artifact: extras.adopted_artifact } : {}),
    ...(extras.deterministic_skip ? { deterministic_skip: extras.deterministic_skip } : {}),
    created_at: now,
  };
  return core;
}

function digestBoundGenerationArtifactCandidates(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  workUnitId: string,
): Array<{ policy_generation_id: string; artifact_path: string }> {
  const root = path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "artifacts",
    stage,
  );
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name))
    .map((entry) => ({
      policy_generation_id: entry.name,
      artifact_path: automaticBuildGenerationArtifactPath(
        target,
        stage,
        entry.name,
        workUnitId,
      ),
    }))
    .filter((candidate) => existsSync(candidate.artifact_path))
    .sort((left, right) => left.policy_generation_id.localeCompare(right.policy_generation_id));
}

function digestBoundGenerationArtifactForReceipt(
  target: AutomaticBuildTarget,
  receipt: AutomaticBuildPolicyMigrationReceiptV2,
): {
  source: DigestBoundSemanticArtifactEnvelopeV3<unknown>;
  projected: SemanticArtifactEnvelopeV3<unknown>;
} | undefined {
  const adopted = receipt.adopted_artifact;
  if (!adopted || adopted.envelope_version !== "semantic_task_artifact.v3") return undefined;
  try {
    const currentInputHash = receipt.current_input_hash;
    if (!currentInputHash) return undefined;
    const sourceFile = path.resolve(target.workspace_dir, adopted.relative_path);
    if (safeWorkspaceRelativePath(target, sourceFile) !== adopted.relative_path.replaceAll("\\", "/")
      || !existsSync(sourceFile)) {
      return undefined;
    }
    const source = parseDigestBoundGenerationArtifact(JSON.parse(readFileSync(sourceFile, "utf8")));
    if (!source
      || !/^[a-f0-9]{64}$/u.test(receipt.from_policy_generation_id)
      || source.policy_set_digest !== receipt.from_policy_generation_id
      || !sameTarget(source.target, receipt.target_ref)
      || source.stage !== receipt.stage
      || source.work_unit_id !== adopted.work_unit_id
      || source.work_unit_id !== receipt.work_unit_id
      || source.input_hash !== currentInputHash
      || source.policy_fingerprint.profile_id !== receipt.target_ref.profile_id
      || !semanticContractEqual(
        semanticContractFromExtractionPolicy(source.policy_fingerprint),
        receipt.semantic_contract,
      )) {
      return undefined;
    }
    const projected = buildSemanticArtifactEnvelopeV3({
      target: receipt.target_ref,
      stage: receipt.stage,
      work_unit_id: receipt.work_unit_id,
      input_hash: currentInputHash,
      policy_generation_id: receipt.to_policy_generation_id,
      semantic_contract: receipt.semantic_contract,
      provenance: source.provenance,
      payload: source.payload,
    });
    return projected.artifact_hash === source.artifact_hash
      && source.artifact_hash === adopted.artifact_hash
      ? { source, projected }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One-shot R8 adoption for the known digest-bound V3 predecessor. Normal reads
 * continue to accept only explicit policy_generation_id + semantic_contract artifacts.
 */
export function recordAutomaticBuildPriorGenerationAdoption(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  policy_set: AutomaticBuildStagePolicySetV3;
  current: Extract<AutomaticBuildPolicyMigrationCurrent, { route: "model" }>;
  now?: string;
}): AutomaticBuildPolicyMigrationResult | undefined {
  const policySet = freezeAutomaticBuildStagePolicySet(input.target, input.policy_set);
  if (policySet.stage !== input.stage) throw new Error("prior-generation policy set stage mismatch");
  const current = currentIdentity(input.target, input.stage, input.current, policySet);
  const candidates = digestBoundGenerationArtifactCandidates(
    input.target,
    input.stage,
    current.work_unit_id,
  );
  if (!candidates.length) return undefined;
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("prior-generation adoption time must be an ISO timestamp");
  const exact = candidates.flatMap((candidate) => {
    let source: DigestBoundSemanticArtifactEnvelopeV3<unknown> | undefined;
    try {
      source = parseDigestBoundGenerationArtifact(
        JSON.parse(readFileSync(candidate.artifact_path, "utf8")),
      );
    } catch {
      source = undefined;
    }
    if (!source) return [];
    const receipt = createMigrationReceipt(
      { ...current, from_policy_generation_id: candidate.policy_generation_id },
      "adopt_exact",
      "exact_input_and_policy",
      now,
      {
        adopted_artifact: {
          work_unit_id: current.work_unit_id,
          relative_path: safeWorkspaceRelativePath(input.target, candidate.artifact_path),
          envelope_version: "semantic_task_artifact.v3",
          artifact_hash: source.artifact_hash,
        },
      },
    );
    return digestBoundGenerationArtifactForReceipt(input.target, receipt) ? [receipt] : [];
  });
  if (exact.length !== 1) {
    return migrationBlock(
      { ...current, from_policy_generation_id: candidates[0].policy_generation_id },
      "previous_generation_semantic_drift",
      false,
    );
  }
  const lease = inspectAutomaticBuildTaskClaim(
    input.target,
    input.stage,
    current.work_unit_id,
    { now },
  );
  if (lease.status === "already_leased") {
    const receipt = exact[0];
    return migrationBlock({
      target_ref: receipt.target_ref,
      stage: receipt.stage,
      from_policy_generation_id: receipt.from_policy_generation_id,
      to_policy_generation_id: receipt.to_policy_generation_id,
      work_unit_id: receipt.work_unit_id,
      work_unit_kind: receipt.work_unit_kind,
      current_route: receipt.current_route,
      semantic_contract: receipt.semantic_contract,
      ...(receipt.current_input_hash ? { current_input_hash: receipt.current_input_hash } : {}),
    }, "active_lease", true);
  }
  return persistMigrationReceipt(input.target, exact[0]);
}

export function recordAutomaticBuildPolicyMigration(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  from_policy_generation_id: string;
  policy_set: AutomaticBuildStagePolicySetV3;
  current: AutomaticBuildPolicyMigrationCurrent;
  previous?: AutomaticBuildPolicyMigrationPreviousV2;
  now?: string;
}): AutomaticBuildPolicyMigrationResult {
  assertPolicyGenerationId(input.from_policy_generation_id, "from_policy_generation_id");
  const policySet = freezeAutomaticBuildStagePolicySet(input.target, input.policy_set);
  if (policySet.stage !== input.stage) throw new Error("migration policy set stage mismatch");
  const previousLock = readAutomaticBuildStagePolicyLock(input.target, input.stage);
  if (previousLock && previousLock.policy_generation_id !== input.from_policy_generation_id) {
    throw new AutomaticBuildPolicyGenerationConflictError("migration_source_lock");
  }
  let identity: AutomaticBuildPolicyMigrationIdentityV2;
  try {
    identity = {
      ...currentIdentity(input.target, input.stage, input.current, policySet),
      from_policy_generation_id: input.from_policy_generation_id,
    };
  } catch (error) {
    if (input.current.route !== "model" || !(error instanceof BudgetProofInvalidError)) throw error;
    const descriptor = input.current.descriptor;
    const semanticContract = semanticContractFromExtractionPolicy(descriptor.policy_fingerprint);
    const member = policySet.members.find((candidate) => candidate.kind === descriptor.kind
      && semanticContractEqual(candidate.semantic_contract, semanticContract));
    if (!member) throw new Error("current migration descriptor is outside the frozen policy set");
    identity = {
      target_ref: input.target.target_ref,
      stage: input.stage,
      from_policy_generation_id: input.from_policy_generation_id,
      to_policy_generation_id: member.policy_generation_id,
      work_unit_id: descriptor.work_unit_id,
      work_unit_kind: descriptor.kind,
      current_route: "model",
      semantic_contract: semanticContract,
      current_input_hash: descriptor.input_hash,
    };
    return migrationBlock(identity, "budget_proof_invalid", false);
  }
  const now = input.now ?? new Date().toISOString();
  if (input.current.route === "blocked") {
    return migrationBlock(identity, input.current.block_reason, input.current.retryable);
  }
  if (input.current.route === "deterministic_skip") {
    const evidence = [...new Set(input.current.evidence_lids)].sort();
    return persistMigrationReceipt(input.target, createMigrationReceipt(
      identity,
      "deterministic_skip",
      "current_router_skip",
      now,
      {
        deterministic_skip: {
          code: input.current.skip_code,
          evidence_lids: evidence,
        },
      },
    ));
  }
  if (!input.previous) {
    return persistMigrationReceipt(input.target, createMigrationReceipt(
      identity,
      "rebuild",
      "no_previous_artifact",
      now,
    ));
  }
  const previous = input.previous;
  if (previous.descriptor.version !== "automatic_build_work_unit.v2"
    || previous.descriptor.stage !== input.stage) {
    throw new Error("migration previous descriptor must be a v2 unit from the same stage");
  }
  const lease = inspectAutomaticBuildTaskClaim(
    input.target,
    input.stage,
    previous.descriptor.work_unit_id,
    { now },
  );
  if (lease.status === "already_leased") return migrationBlock(identity, "active_lease", true);
  if (previous.rendered_input === undefined) {
    return migrationBlock(identity, "previous_input_unverifiable", false);
  }
  const artifactPath = previous.artifact_path ?? automaticBuildLegacyStageArtifactPath(
    input.target,
    input.stage,
    previous.descriptor.work_unit_id,
  );
  let artifact: SemanticArtifactEnvelopeV2<unknown>;
  try {
    const relativePath = safeWorkspaceRelativePath(input.target, artifactPath);
    const artifactBytes = readFileSync(path.join(input.target.workspace_dir, relativePath));
    artifact = JSON.parse(artifactBytes.toString("utf8")) as SemanticArtifactEnvelopeV2<unknown>;
    const inspected = inspectSemanticArtifact(artifact, {
      target: previous.descriptor.target,
      stage: input.stage,
      work_unit_id: previous.descriptor.work_unit_id,
      input_hash: previous.descriptor.input_hash,
      semantic_contract: semanticContractFromExtractionPolicy(previous.descriptor.policy_fingerprint),
    });
    if (inspected.format !== "v2" || !inspected.policy_fresh) throw new Error("previous artifact is not fresh");
  } catch {
    return migrationBlock(identity, "previous_artifact_invalid", false);
  }
  if (!sameTarget(previous.descriptor.target, input.target.target_ref)) {
    return persistMigrationReceipt(input.target, createMigrationReceipt(
      identity,
      "rebuild",
      "source_or_target_changed",
      now,
    ));
  }
  if (previous.descriptor.kind !== input.current.descriptor.kind) {
    return persistMigrationReceipt(input.target, createMigrationReceipt(
      identity,
      "rebuild",
      "work_unit_kind_changed",
      now,
    ));
  }
  if (!policyAdoptionCompatible(previous.descriptor.policy_fingerprint, input.current.descriptor.policy_fingerprint)) {
    return persistMigrationReceipt(input.target, createMigrationReceipt(
      identity,
      "rebuild",
      "semantic_policy_changed",
      now,
    ));
  }
  if (previous.rendered_input !== input.current.rendered_input) {
    return persistMigrationReceipt(input.target, createMigrationReceipt(
      identity,
      "rebuild",
      "rendered_input_changed",
      now,
    ));
  }
  const relativePath = safeWorkspaceRelativePath(input.target, artifactPath);
  return persistMigrationReceipt(input.target, createMigrationReceipt(
    identity,
    "adopt_exact",
    "exact_input_and_policy",
    now,
    {
      adopted_artifact: {
        work_unit_id: previous.descriptor.work_unit_id,
        relative_path: relativePath,
        envelope_version: "semantic_task_artifact.v2",
        artifact_hash: artifact.artifact_hash,
      },
    },
  ));
}

function readMigrationReceipt(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  fromPolicyGenerationId: string,
  toPolicyGenerationId: string,
  workUnitId: string,
): AutomaticBuildPolicyMigrationReceiptV2 | undefined {
  const file = automaticBuildPolicyMigrationReceiptPath(
    target,
    stage,
    fromPolicyGenerationId,
    toPolicyGenerationId,
    workUnitId,
  );
  if (!existsSync(file)) return undefined;
  return validateAutomaticBuildPolicyMigrationReceipt(
    target,
    stage,
    JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildPolicyMigrationReceiptV2,
  );
}

function adoptedArtifactFresh(
  target: AutomaticBuildTarget,
  receipt: AutomaticBuildPolicyMigrationReceiptV2,
): boolean {
  if (!receipt.adopted_artifact) return false;
  if (receipt.adopted_artifact.envelope_version === "semantic_task_artifact.v3") {
    return digestBoundGenerationArtifactForReceipt(target, receipt) !== undefined;
  }
  try {
    const file = path.resolve(target.workspace_dir, receipt.adopted_artifact.relative_path);
    if (safeWorkspaceRelativePath(target, file) !== receipt.adopted_artifact.relative_path.replaceAll("\\", "/")) {
      return false;
    }
    const bytes = readFileSync(file);
    const artifact = JSON.parse(bytes.toString("utf8")) as SemanticArtifactEnvelopeV2<unknown>;
    const inspected = inspectSemanticArtifact(artifact, {
      target: receipt.target_ref,
      stage: receipt.stage,
      work_unit_id: receipt.adopted_artifact.work_unit_id,
      input_hash: artifact.input_hash,
      semantic_contract: semanticContractFromExtractionPolicy(artifact.policy_fingerprint),
    });
    return inspected.format === "v2"
      && inspected.policy_fresh
      && artifact.version === receipt.adopted_artifact.envelope_version
      && artifact.work_unit_id === receipt.adopted_artifact.work_unit_id
      && artifact.artifact_hash === receipt.adopted_artifact.artifact_hash;
  } catch {
    return false;
  }
}

/**
 * Project an exact-adoption receipt into the immutable v3 generation tree.
 * The legacy envelope remains untouched; the projected envelope keeps the
 * original payload/provenance while binding the current proof and policy set.
 */
export function materializeAdoptedAutomaticBuildGenerationArtifact(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  policy_set: AutomaticBuildStagePolicySetV3;
  current: Extract<AutomaticBuildPolicyMigrationCurrent, { route: "model" }>;
  receipt: AutomaticBuildPolicyMigrationReceiptV2;
  project_payload?: (payload: unknown) => unknown;
}): SemanticArtifactEnvelopeV3<unknown> {
  const policySet = validateAutomaticBuildStagePolicySet(input.policy_set);
  const receipt = validateAutomaticBuildPolicyMigrationReceipt(input.target, input.stage, input.receipt);
  const identity = {
    ...currentIdentity(input.target, input.stage, input.current, policySet),
    from_policy_generation_id: receipt.from_policy_generation_id,
  };
  if (receipt.decision !== "adopt_exact"
    || receipt.to_policy_generation_id !== identity.to_policy_generation_id
    || stableJson(receiptComparable(receipt)) !== stableJson({
      ...identity,
      version: receipt.version,
      decision: receipt.decision,
      reason: receipt.reason,
      ...(receipt.adopted_artifact ? { adopted_artifact: receipt.adopted_artifact } : {}),
      ...(receipt.deterministic_skip ? { deterministic_skip: receipt.deterministic_skip } : {}),
    })
    || !adoptedArtifactFresh(input.target, receipt)
    || !receipt.adopted_artifact) {
    throw new AutomaticBuildPolicyGenerationConflictError("migration_receipt_frozen");
  }
  let sourcePayload: unknown;
  let sourceProvenance: SemanticArtifactProvenanceV2;
  if (receipt.adopted_artifact.envelope_version === "semantic_task_artifact.v3") {
    const predecessor = digestBoundGenerationArtifactForReceipt(input.target, receipt);
    if (!predecessor) {
      throw new AutomaticBuildPolicyGenerationConflictError("migration_source_lock");
    }
    sourcePayload = predecessor.source.payload;
    sourceProvenance = predecessor.source.provenance;
  } else {
    const legacyFile = path.resolve(
      input.target.workspace_dir,
      receipt.adopted_artifact.relative_path,
    );
    if (safeWorkspaceRelativePath(input.target, legacyFile)
      !== receipt.adopted_artifact.relative_path.replaceAll("\\", "/")) {
      throw new AutomaticBuildPolicyGenerationConflictError("migration_source_lock");
    }
    const legacy = JSON.parse(readFileSync(legacyFile, "utf8")) as SemanticArtifactEnvelopeV2<unknown>;
    const inspected = inspectSemanticArtifact(legacy, {
      target: legacy.target,
      stage: legacy.stage,
      work_unit_id: legacy.work_unit_id,
      input_hash: legacy.input_hash,
      semantic_contract: semanticContractFromExtractionPolicy(legacy.policy_fingerprint),
    });
    if (inspected.format !== "v2" || !inspected.policy_fresh) {
      throw new AutomaticBuildPolicyGenerationConflictError("migration_source_lock");
    }
    sourcePayload = inspected.payload;
    sourceProvenance = legacy.provenance;
  }
  const descriptor = input.current.descriptor;
  const payload = input.project_payload
    && receipt.adopted_artifact.envelope_version === "semantic_task_artifact.v2"
    ? input.project_payload(sourcePayload)
    : sourcePayload;
  const projected = buildSemanticArtifactEnvelopeV3({
    target: descriptor.target,
    stage: input.stage,
    work_unit_id: descriptor.work_unit_id,
    input_hash: descriptor.input_hash,
    policy_generation_id: identity.to_policy_generation_id,
    semantic_contract: identity.semantic_contract,
    provenance: sourceProvenance,
    payload,
  });
  writeAutomaticBuildGenerationArtifact(input.target, projected);
  return projected;
}

function rebuiltArtifactFresh(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policySet: AutomaticBuildStagePolicySetV3,
  current: Extract<AutomaticBuildPolicyMigrationCurrent, { route: "model" }>,
): "fresh" | "missing" | "stale" {
  const descriptor = current.descriptor;
  const identity = currentIdentity(target, stage, current, policySet);
  const file = automaticBuildGenerationArtifactPath(
    target,
    stage,
    identity.to_policy_generation_id,
    descriptor.work_unit_id,
  );
  if (!existsSync(file)) return "missing";
  try {
    const inspected = inspectSemanticArtifact(JSON.parse(readFileSync(file, "utf8")), {
      target: target.target_ref,
      stage,
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      policy_generation_id: identity.to_policy_generation_id,
      semantic_contract: identity.semantic_contract,
    });
    return inspected.format === "v3" && inspected.policy_fresh ? "fresh" : "stale";
  } catch {
    return "stale";
  }
}

export function resolveAutomaticBuildPolicyGeneration(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  from_policy_generation_id: string;
  policy_set: AutomaticBuildStagePolicySetV3;
  current_units: AutomaticBuildPolicyMigrationCurrent[];
}): AutomaticBuildPolicyGenerationResolutionV2 {
  assertPolicyGenerationId(input.from_policy_generation_id, "from_policy_generation_id");
  const policySet = freezeAutomaticBuildStagePolicySet(input.target, input.policy_set);
  if (policySet.stage !== input.stage) throw new Error("policy generation stage does not match its policy set");
  const adoptedUnits: string[] = [];
  const rebuiltUnits: string[] = [];
  const deterministicSkipUnits: string[] = [];
  const pendingRebuildUnits: string[] = [];
  const missingReceiptUnits: string[] = [];
  const staleUnits: string[] = [];
  const seen = new Set<string>();
  for (const current of input.current_units) {
    const identity = {
      ...currentIdentity(input.target, input.stage, current, policySet),
      from_policy_generation_id: input.from_policy_generation_id,
    };
    if (seen.has(identity.work_unit_id)) throw new Error("policy generation current work_unit_ids must be unique");
    seen.add(identity.work_unit_id);
    if (current.route === "blocked") {
      staleUnits.push(identity.work_unit_id);
      continue;
    }
    const receipt = readMigrationReceipt(
      input.target,
      input.stage,
      input.from_policy_generation_id,
      identity.to_policy_generation_id,
      identity.work_unit_id,
    );
    if (!receipt) {
      missingReceiptUnits.push(identity.work_unit_id);
      continue;
    }
    if (receipt.from_policy_generation_id !== identity.from_policy_generation_id
      || receipt.to_policy_generation_id !== identity.to_policy_generation_id
      || receipt.work_unit_kind !== identity.work_unit_kind
      || receipt.current_route !== identity.current_route
      || receipt.current_input_hash !== identity.current_input_hash
      || !semanticContractEqual(receipt.semantic_contract, identity.semantic_contract)) {
      staleUnits.push(identity.work_unit_id);
      continue;
    }
    if (receipt.decision === "adopt_exact") {
      if (adoptedArtifactFresh(input.target, receipt)) adoptedUnits.push(identity.work_unit_id);
      else staleUnits.push(identity.work_unit_id);
      continue;
    }
    if (receipt.decision === "deterministic_skip") {
      const expectedEvidence = current.route === "deterministic_skip"
        ? [...new Set(current.evidence_lids)].sort()
        : [];
      if (current.route === "deterministic_skip"
        && receipt.deterministic_skip?.code === current.skip_code
        && stableJson(receipt.deterministic_skip.evidence_lids) === stableJson(expectedEvidence)) {
        deterministicSkipUnits.push(identity.work_unit_id);
      }
      else staleUnits.push(identity.work_unit_id);
      continue;
    }
    if (current.route !== "model") {
      staleUnits.push(identity.work_unit_id);
      continue;
    }
    const artifact = rebuiltArtifactFresh(input.target, input.stage, policySet, current);
    if (artifact === "fresh") rebuiltUnits.push(identity.work_unit_id);
    else if (artifact === "missing") pendingRebuildUnits.push(identity.work_unit_id);
    else staleUnits.push(identity.work_unit_id);
  }
  const status = staleUnits.length
    ? "blocked" as const
    : missingReceiptUnits.length
      ? "incomplete" as const
      : pendingRebuildUnits.length
        ? "pending" as const
        : "ready" as const;
  return {
    version: "automatic_build_policy_generation_resolution.v2",
    target_ref: input.target.target_ref,
    stage: input.stage,
    policy_generations: policySet.members.map((member) => ({
      kind: member.kind,
      policy_generation_id: member.policy_generation_id,
      semantic_contract: member.semantic_contract,
    })),
    status,
    adopted_units: adoptedUnits,
    rebuilt_units: rebuiltUnits,
    deterministic_skip_units: deterministicSkipUnits,
    pending_rebuild_units: pendingRebuildUnits,
    missing_receipt_units: missingReceiptUnits,
    stale_units: staleUnits,
  };
}
