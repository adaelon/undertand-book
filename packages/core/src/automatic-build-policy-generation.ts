import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  extractionPolicyDigest,
  extractionPolicyEqual,
  inspectSemanticArtifact,
  readAutomaticBuildStagePolicyLock,
  writeAutomaticBuildGenerationArtifact,
  type ExtractionPolicyFingerprintV1,
  type SemanticArtifactEnvelopeV2,
  type SemanticArtifactEnvelopeV3,
  type SemanticBuildStage,
} from "./semantic-artifact";
import {
  validateWorkUnitDescriptorV3,
  type WorkUnitDescriptorV2,
  type WorkUnitDescriptorV3,
  type WorkUnitKind,
} from "./stage-work-unit";

export interface AutomaticBuildStagePolicySetMemberV2 {
  kind: WorkUnitKind;
  extractor: SemanticExtractor;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
}

export interface AutomaticBuildStagePolicySetV2 {
  version: "automatic_build_stage_policy_set.v2";
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  members: AutomaticBuildStagePolicySetMemberV2[];
  policy_set_digest: string;
  frozen_at: string;
}

export type AutomaticBuildPolicyMigrationCurrent =
  | {
      route: "model";
      descriptor: WorkUnitDescriptorV3;
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
  | "previous_input_unverifiable"
  | "previous_artifact_invalid";

interface AutomaticBuildPolicyMigrationIdentityV1 {
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  from_policy_digest: string;
  to_policy_set_digest: string;
  work_unit_id: string;
  work_unit_kind: WorkUnitKind;
  current_route_digest: string;
  current_policy_digest: string;
  current_input_hash?: string;
  current_proof_digest?: string;
}

export interface AutomaticBuildPolicyMigrationReceiptV1 extends AutomaticBuildPolicyMigrationIdentityV1 {
  version: "automatic_build_policy_migration_receipt.v1";
  decision: AutomaticBuildPolicyMigrationDecision;
  reason: AutomaticBuildPolicyMigrationReason;
  adopted_artifact?: {
    work_unit_id: string;
    relative_path: string;
    envelope_version: "semantic_task_artifact.v2";
    artifact_hash: string;
    file_sha256: string;
  };
  deterministic_skip?: {
    code: string;
    evidence_count: number;
    evidence_digest: string;
  };
  created_at: string;
  receipt_digest: string;
}

export interface AutomaticBuildPolicyMigrationBlockV1 extends AutomaticBuildPolicyMigrationIdentityV1 {
  version: "automatic_build_policy_migration_block.v1";
  decision: "blocked";
  reason: AutomaticBuildPolicyMigrationBlockReason;
  retryable: boolean;
}

export type AutomaticBuildPolicyMigrationResult =
  | AutomaticBuildPolicyMigrationReceiptV1
  | AutomaticBuildPolicyMigrationBlockV1;

export interface AutomaticBuildPolicyMigrationPreviousV2 {
  descriptor: WorkUnitDescriptorV2;
  rendered_input?: string;
  artifact_path?: string;
}

export interface AutomaticBuildPolicyGenerationResolutionV1 {
  version: "automatic_build_policy_generation_resolution.v1";
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  policy_set_digest: string;
  status: "ready" | "pending" | "incomplete" | "blocked";
  adopted_units: string[];
  rebuilt_units: string[];
  deterministic_skip_units: string[];
  pending_rebuild_units: string[];
  missing_receipt_units: string[];
  stale_units: string[];
  resolution_digest: string;
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(stableJson(value));
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

function policySetIdentity(input: {
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  members: AutomaticBuildStagePolicySetMemberV2[];
}) {
  return {
    version: "automatic_build_stage_policy_set.v2" as const,
    target_ref: input.target_ref,
    stage: input.stage,
    members: input.members,
  };
}

function normalizePolicyMembers(
  targetRef: BuildTargetRefV2,
  stage: SemanticBuildStage,
  members: AutomaticBuildStagePolicySetMemberV2[],
): AutomaticBuildStagePolicySetMemberV2[] {
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
    extractionPolicyDigest(member.policy_fingerprint);
    return {
      kind: member.kind,
      extractor: member.extractor,
      policy_fingerprint: { ...member.policy_fingerprint },
    };
  }).sort((left, right) => left.kind.localeCompare(right.kind)
    || left.extractor.localeCompare(right.extractor)
    || extractionPolicyDigest(left.policy_fingerprint).localeCompare(extractionPolicyDigest(right.policy_fingerprint)));
  if (new Set(normalized.map((member) => member.kind)).size !== normalized.length) {
    throw new Error("automatic build stage policy set member kinds must be unique");
  }
  return normalized;
}

export function createAutomaticBuildStagePolicySet(input: {
  target_ref: BuildTargetRefV2;
  stage: SemanticBuildStage;
  members: AutomaticBuildStagePolicySetMemberV2[];
  frozen_at?: string;
}): AutomaticBuildStagePolicySetV2 {
  const frozenAt = input.frozen_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(frozenAt))) throw new Error("policy set frozen_at must be an ISO timestamp");
  const members = normalizePolicyMembers(input.target_ref, input.stage, input.members);
  const identity = policySetIdentity({ target_ref: input.target_ref, stage: input.stage, members });
  return {
    ...identity,
    policy_set_digest: digest(identity),
    frozen_at: frozenAt,
  };
}

export function validateAutomaticBuildStagePolicySet(
  policySet: AutomaticBuildStagePolicySetV2,
): AutomaticBuildStagePolicySetV2 {
  if (policySet.version !== "automatic_build_stage_policy_set.v2") {
    throw new Error("unsupported automatic build stage policy set version");
  }
  const canonical = createAutomaticBuildStagePolicySet({
    target_ref: policySet.target_ref,
    stage: policySet.stage,
    members: policySet.members,
    frozen_at: policySet.frozen_at,
  });
  if (canonical.policy_set_digest !== policySet.policy_set_digest
    || stableJson(canonical.members) !== stableJson(policySet.members)) {
    throw new Error("automatic build stage policy set digest or member ordering is invalid");
  }
  return policySet;
}

export function automaticBuildStagePolicySetPath(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policySetDigest: string,
): string {
  assertSha256(policySetDigest, "policy_set_digest");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "policies",
    stage,
    policySetDigest,
    "policy.json",
  );
}

export function readAutomaticBuildStagePolicySet(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policySetDigest: string,
): AutomaticBuildStagePolicySetV2 | undefined {
  const file = automaticBuildStagePolicySetPath(target, stage, policySetDigest);
  if (!existsSync(file)) return undefined;
  const policySet = validateAutomaticBuildStagePolicySet(
    JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStagePolicySetV2,
  );
  if (policySet.stage !== stage
    || policySet.policy_set_digest !== policySetDigest
    || !sameTarget(policySet.target_ref, target.target_ref)) {
    throw new AutomaticBuildPolicyGenerationConflictError("policy_set_identity");
  }
  return policySet;
}

export function freezeAutomaticBuildStagePolicySet(
  target: AutomaticBuildTarget,
  policySetInput: AutomaticBuildStagePolicySetV2,
): AutomaticBuildStagePolicySetV2 {
  const policySet = validateAutomaticBuildStagePolicySet(policySetInput);
  if (!sameTarget(policySet.target_ref, target.target_ref)) {
    throw new Error("policy set target does not match automatic build target");
  }
  const file = automaticBuildStagePolicySetPath(target, policySet.stage, policySet.policy_set_digest);
  const bytes = `${JSON.stringify(policySet, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    return policySet;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readAutomaticBuildStagePolicySet(target, policySet.stage, policySet.policy_set_digest);
    if (!existing
      || stableJson(policySetIdentity(existing)) !== stableJson(policySetIdentity(policySet))) {
      throw new AutomaticBuildPolicyGenerationConflictError("policy_set_frozen");
    }
    return existing;
  }
}

function migrationWorkUnitFileName(workUnitId: string): string {
  assertBounded(workUnitId, "migration work_unit_id");
  const encoded = encodeURIComponent(workUnitId);
  return Buffer.byteLength(encoded, "utf8") <= 220 ? `${encoded}.json` : `${sha256(workUnitId)}.json`;
}

export function automaticBuildPolicyMigrationReceiptPath(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  fromPolicyDigest: string,
  toPolicySetDigest: string,
  workUnitId: string,
): string {
  assertSha256(fromPolicyDigest, "from_policy_digest");
  assertSha256(toPolicySetDigest, "to_policy_set_digest");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "migrations",
    stage,
    `${fromPolicyDigest}-to-${toPolicySetDigest}`,
    migrationWorkUnitFileName(workUnitId),
  );
}

function currentIdentity(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  current: AutomaticBuildPolicyMigrationCurrent,
  policySet: AutomaticBuildStagePolicySetV2,
): AutomaticBuildPolicyMigrationIdentityV1 {
  if (current.route === "model") {
    let descriptor: WorkUnitDescriptorV3;
    try {
      descriptor = validateWorkUnitDescriptorV3(current.descriptor);
    } catch {
      throw new BudgetProofInvalidError("current migration descriptor has an invalid budget proof");
    }
    if (descriptor.stage !== stage || !sameTarget(descriptor.target, target.target_ref)) {
      throw new Error("current migration descriptor identity does not match target stage");
    }
    const member = policySet.members.find((candidate) => candidate.kind === descriptor.kind
      && extractionPolicyEqual(candidate.policy_fingerprint, descriptor.policy_fingerprint));
    if (!member) throw new Error("current migration descriptor is outside the frozen policy set");
    try {
      verifyModelInputBudgetProof(current.rendered_input, descriptor.input_budget_proof);
    } catch {
      throw new BudgetProofInvalidError("current migration rendered input does not match its budget proof");
    }
    return {
      target_ref: target.target_ref,
      stage,
      from_policy_digest: "",
      to_policy_set_digest: policySet.policy_set_digest,
      work_unit_id: descriptor.work_unit_id,
      work_unit_kind: descriptor.kind,
      current_route_digest: digest(descriptor),
      current_policy_digest: extractionPolicyDigest(descriptor.policy_fingerprint),
      current_input_hash: descriptor.input_hash,
      current_proof_digest: descriptor.input_budget_proof.proof_digest,
    };
  }
  assertBounded(current.work_unit_id, `${current.route} work_unit_id`);
  if (current.route === "deterministic_skip") {
    assertBounded(current.skip_code, "deterministic skip code", 128);
  }
  if (!current.evidence_lids.length || current.evidence_lids.some((lid) => !lid || Buffer.byteLength(lid, "utf8") > 256)) {
    throw new Error("deterministic skip evidence_lids must be non-empty bounded strings");
  }
  const member = policySet.members.find((candidate) => candidate.kind === current.work_unit_kind
    && extractionPolicyEqual(candidate.policy_fingerprint, current.policy_fingerprint));
  if (!member) throw new Error("deterministic skip is outside the frozen policy set");
  const normalized = {
    route: current.route,
    work_unit_id: current.work_unit_id,
    work_unit_kind: current.work_unit_kind,
    policy_fingerprint: current.policy_fingerprint,
    evidence_lids: [...new Set(current.evidence_lids)].sort(),
    ...(current.route === "deterministic_skip"
      ? { skip_code: current.skip_code }
      : { block_reason: current.block_reason, retryable: current.retryable }),
  };
  return {
    target_ref: target.target_ref,
    stage,
    from_policy_digest: "",
    to_policy_set_digest: policySet.policy_set_digest,
    work_unit_id: current.work_unit_id,
    work_unit_kind: current.work_unit_kind,
    current_route_digest: digest(normalized),
    current_policy_digest: extractionPolicyDigest(current.policy_fingerprint),
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

function receiptComparable(receipt: AutomaticBuildPolicyMigrationReceiptV1): unknown {
  const { created_at: _createdAt, receipt_digest: _receiptDigest, ...identity } = receipt;
  return identity;
}

function validateMigrationReceipt(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  receipt: AutomaticBuildPolicyMigrationReceiptV1,
): AutomaticBuildPolicyMigrationReceiptV1 {
  if (receipt.version !== "automatic_build_policy_migration_receipt.v1"
    || receipt.stage !== stage
    || !sameTarget(receipt.target_ref, target.target_ref)
    || !(["adopt_exact", "rebuild", "deterministic_skip"] as string[]).includes(receipt.decision)
    || !Number.isFinite(Date.parse(receipt.created_at))) {
    throw new Error("invalid automatic build policy migration receipt");
  }
  assertSha256(receipt.from_policy_digest, "receipt.from_policy_digest");
  assertSha256(receipt.to_policy_set_digest, "receipt.to_policy_set_digest");
  assertSha256(receipt.current_route_digest, "receipt.current_route_digest");
  assertSha256(receipt.current_policy_digest, "receipt.current_policy_digest");
  if (receipt.current_input_hash) assertSha256(receipt.current_input_hash, "receipt.current_input_hash");
  if (receipt.current_proof_digest) assertSha256(receipt.current_proof_digest, "receipt.current_proof_digest");
  const { receipt_digest: _receiptDigest, ...core } = receipt;
  if (receipt.receipt_digest !== digest(core)) throw new Error("invalid policy migration receipt digest");
  return receipt;
}

function persistMigrationReceipt(
  target: AutomaticBuildTarget,
  receipt: AutomaticBuildPolicyMigrationReceiptV1,
): AutomaticBuildPolicyMigrationReceiptV1 {
  const file = automaticBuildPolicyMigrationReceiptPath(
    target,
    receipt.stage,
    receipt.from_policy_digest,
    receipt.to_policy_set_digest,
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
    const existing = validateMigrationReceipt(
      target,
      receipt.stage,
      JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildPolicyMigrationReceiptV1,
    );
    if (stableJson(receiptComparable(existing)) !== stableJson(receiptComparable(receipt))) {
      throw new AutomaticBuildPolicyGenerationConflictError("migration_receipt_frozen");
    }
    return existing;
  }
}

function migrationBlock(
  identity: AutomaticBuildPolicyMigrationIdentityV1,
  reason: AutomaticBuildPolicyMigrationBlockReason,
  retryable: boolean,
): AutomaticBuildPolicyMigrationBlockV1 {
  return {
    version: "automatic_build_policy_migration_block.v1",
    ...identity,
    decision: "blocked",
    reason,
    retryable,
  };
}

function createMigrationReceipt(
  identity: AutomaticBuildPolicyMigrationIdentityV1,
  decision: AutomaticBuildPolicyMigrationDecision,
  reason: AutomaticBuildPolicyMigrationReason,
  now: string,
  extras: Pick<AutomaticBuildPolicyMigrationReceiptV1, "adopted_artifact" | "deterministic_skip"> = {},
): AutomaticBuildPolicyMigrationReceiptV1 {
  if (!Number.isFinite(Date.parse(now))) throw new Error("migration receipt created_at must be an ISO timestamp");
  const core = {
    version: "automatic_build_policy_migration_receipt.v1" as const,
    ...identity,
    decision,
    reason,
    ...(extras.adopted_artifact ? { adopted_artifact: extras.adopted_artifact } : {}),
    ...(extras.deterministic_skip ? { deterministic_skip: extras.deterministic_skip } : {}),
    created_at: now,
  };
  return { ...core, receipt_digest: digest(core) };
}

export function recordAutomaticBuildPolicyMigration(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  from_policy_digest: string;
  policy_set: AutomaticBuildStagePolicySetV2;
  current: AutomaticBuildPolicyMigrationCurrent;
  previous?: AutomaticBuildPolicyMigrationPreviousV2;
  now?: string;
}): AutomaticBuildPolicyMigrationResult {
  assertSha256(input.from_policy_digest, "from_policy_digest");
  const policySet = freezeAutomaticBuildStagePolicySet(input.target, input.policy_set);
  if (policySet.stage !== input.stage) throw new Error("migration policy set stage mismatch");
  if (policySet.policy_set_digest === input.from_policy_digest) {
    throw new Error("policy generation migration requires distinct source and destination digests");
  }
  const previousPolicySet = readAutomaticBuildStagePolicySet(
    input.target,
    input.stage,
    input.from_policy_digest,
  );
  const previousLock = readAutomaticBuildStagePolicyLock(input.target, input.stage);
  if (!previousPolicySet && previousLock && previousLock.policy_digest !== input.from_policy_digest) {
    throw new AutomaticBuildPolicyGenerationConflictError("migration_source_lock");
  }
  let identity: AutomaticBuildPolicyMigrationIdentityV1;
  try {
    identity = {
      ...currentIdentity(input.target, input.stage, input.current, policySet),
      from_policy_digest: input.from_policy_digest,
    };
  } catch (error) {
    if (input.current.route !== "model" || !(error instanceof BudgetProofInvalidError)) throw error;
    const descriptor = input.current.descriptor;
    identity = {
      target_ref: input.target.target_ref,
      stage: input.stage,
      from_policy_digest: input.from_policy_digest,
      to_policy_set_digest: policySet.policy_set_digest,
      work_unit_id: descriptor.work_unit_id,
      work_unit_kind: descriptor.kind,
      current_route_digest: digest(descriptor),
      current_policy_digest: extractionPolicyDigest(descriptor.policy_fingerprint),
      current_input_hash: descriptor.input_hash,
      current_proof_digest: descriptor.input_budget_proof.proof_digest,
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
          evidence_count: evidence.length,
          evidence_digest: digest(evidence),
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
  let artifactBytes: Buffer;
  let artifact: SemanticArtifactEnvelopeV2<unknown>;
  try {
    const relativePath = safeWorkspaceRelativePath(input.target, artifactPath);
    artifactBytes = readFileSync(path.join(input.target.workspace_dir, relativePath));
    artifact = JSON.parse(artifactBytes.toString("utf8")) as SemanticArtifactEnvelopeV2<unknown>;
    const inspected = inspectSemanticArtifact(artifact, {
      target: previous.descriptor.target,
      stage: input.stage,
      work_unit_id: previous.descriptor.work_unit_id,
      input_hash: previous.descriptor.input_hash,
      policy_fingerprint: previous.descriptor.policy_fingerprint,
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
        file_sha256: sha256(artifactBytes),
      },
    },
  ));
}

function readMigrationReceipt(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  fromPolicyDigest: string,
  toPolicySetDigest: string,
  workUnitId: string,
): AutomaticBuildPolicyMigrationReceiptV1 | undefined {
  const file = automaticBuildPolicyMigrationReceiptPath(
    target,
    stage,
    fromPolicyDigest,
    toPolicySetDigest,
    workUnitId,
  );
  if (!existsSync(file)) return undefined;
  return validateMigrationReceipt(
    target,
    stage,
    JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildPolicyMigrationReceiptV1,
  );
}

function adoptedArtifactFresh(
  target: AutomaticBuildTarget,
  receipt: AutomaticBuildPolicyMigrationReceiptV1,
): boolean {
  if (!receipt.adopted_artifact) return false;
  try {
    const file = path.resolve(target.workspace_dir, receipt.adopted_artifact.relative_path);
    if (safeWorkspaceRelativePath(target, file) !== receipt.adopted_artifact.relative_path.replaceAll("\\", "/")) {
      return false;
    }
    const bytes = readFileSync(file);
    if (sha256(bytes) !== receipt.adopted_artifact.file_sha256) return false;
    const artifact = JSON.parse(bytes.toString("utf8")) as SemanticArtifactEnvelopeV2<unknown>;
    return artifact.version === receipt.adopted_artifact.envelope_version
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
  policy_set: AutomaticBuildStagePolicySetV2;
  current: Extract<AutomaticBuildPolicyMigrationCurrent, { route: "model" }>;
  receipt: AutomaticBuildPolicyMigrationReceiptV1;
  project_payload?: (payload: unknown) => unknown;
}): SemanticArtifactEnvelopeV3<unknown> {
  const policySet = validateAutomaticBuildStagePolicySet(input.policy_set);
  const receipt = validateMigrationReceipt(input.target, input.stage, input.receipt);
  const identity = {
    ...currentIdentity(input.target, input.stage, input.current, policySet),
    from_policy_digest: receipt.from_policy_digest,
  };
  if (receipt.decision !== "adopt_exact"
    || receipt.to_policy_set_digest !== policySet.policy_set_digest
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
    policy_fingerprint: legacy.policy_fingerprint,
  });
  if (inspected.format !== "v2" || !inspected.policy_fresh) {
    throw new AutomaticBuildPolicyGenerationConflictError("migration_source_lock");
  }
  const descriptor = input.current.descriptor;
  const payload = input.project_payload
    ? input.project_payload(inspected.payload)
    : inspected.payload;
  const projected = buildSemanticArtifactEnvelopeV3({
    target: descriptor.target,
    stage: input.stage,
    work_unit_id: descriptor.work_unit_id,
    input_hash: descriptor.input_hash,
    proof_digest: descriptor.input_budget_proof.proof_digest,
    policy_set_digest: policySet.policy_set_digest,
    policy_fingerprint: descriptor.policy_fingerprint,
    provenance: legacy.provenance,
    payload,
  });
  writeAutomaticBuildGenerationArtifact(input.target, projected);
  return projected;
}

function rebuiltArtifactFresh(
  target: AutomaticBuildTarget,
  stage: SemanticBuildStage,
  policySet: AutomaticBuildStagePolicySetV2,
  current: Extract<AutomaticBuildPolicyMigrationCurrent, { route: "model" }>,
): "fresh" | "missing" | "stale" {
  const descriptor = current.descriptor;
  const file = automaticBuildGenerationArtifactPath(
    target,
    stage,
    policySet.policy_set_digest,
    descriptor.work_unit_id,
  );
  if (!existsSync(file)) return "missing";
  try {
    const inspected = inspectSemanticArtifact(JSON.parse(readFileSync(file, "utf8")), {
      target: target.target_ref,
      stage,
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      proof_digest: descriptor.input_budget_proof.proof_digest,
      policy_set_digest: policySet.policy_set_digest,
      policy_fingerprint: descriptor.policy_fingerprint,
    });
    return inspected.format === "v3" && inspected.policy_fresh ? "fresh" : "stale";
  } catch {
    return "stale";
  }
}

export function resolveAutomaticBuildPolicyGeneration(input: {
  target: AutomaticBuildTarget;
  stage: SemanticBuildStage;
  from_policy_digest: string;
  policy_set_digest: string;
  current_units: AutomaticBuildPolicyMigrationCurrent[];
}): AutomaticBuildPolicyGenerationResolutionV1 {
  assertSha256(input.from_policy_digest, "from_policy_digest");
  const policySet = readAutomaticBuildStagePolicySet(input.target, input.stage, input.policy_set_digest);
  if (!policySet) throw new Error("policy generation cannot resolve a missing policy set");
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
      from_policy_digest: input.from_policy_digest,
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
      input.from_policy_digest,
      policySet.policy_set_digest,
      identity.work_unit_id,
    );
    if (!receipt) {
      missingReceiptUnits.push(identity.work_unit_id);
      continue;
    }
    if (receipt.current_route_digest !== identity.current_route_digest
      || receipt.current_policy_digest !== identity.current_policy_digest
      || receipt.current_input_hash !== identity.current_input_hash
      || receipt.current_proof_digest !== identity.current_proof_digest) {
      staleUnits.push(identity.work_unit_id);
      continue;
    }
    if (receipt.decision === "adopt_exact") {
      if (adoptedArtifactFresh(input.target, receipt)) adoptedUnits.push(identity.work_unit_id);
      else staleUnits.push(identity.work_unit_id);
      continue;
    }
    if (receipt.decision === "deterministic_skip") {
      if (current.route === "deterministic_skip") deterministicSkipUnits.push(identity.work_unit_id);
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
  const core = {
    version: "automatic_build_policy_generation_resolution.v1" as const,
    target_ref: input.target.target_ref,
    stage: input.stage,
    policy_set_digest: policySet.policy_set_digest,
    status,
    adopted_units: adoptedUnits,
    rebuilt_units: rebuiltUnits,
    deterministic_skip_units: deterministicSkipUnits,
    pending_rebuild_units: pendingRebuildUnits,
    missing_receipt_units: missingReceiptUnits,
    stale_units: staleUnits,
  };
  return { ...core, resolution_digest: digest(core) };
}
