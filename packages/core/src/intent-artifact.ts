import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertSameArtifactBlueprintVersionV2,
  computeArtifactBlueprintDigest,
  getSystemArtifactBlueprintV1,
  validateArtifactBlueprintV1,
  validateRestrictedSchemaValueV1,
  type ArtifactBlueprintV1,
  type LegacyIntentArtifactTypeV1,
} from "./artifact-blueprint";
import {
  canonicalBuildJson,
  type BuildContentProfile,
  type BuildSourceScope,
} from "./build-intent";
import {
  validateBuildIntentV3,
  validateBuildPlanV3,
  type BuildIntentV3,
  type BuildPlanPrivateArtifactV2,
  type BuildPlanPrivateArtifactV3,
  type BuildPlanV3,
} from "./build-intent-v2";

const PRIVATE_ARTIFACT_TYPES = ["timeline", "concept_map", "comparison_table", "argument_map"] as const;
const LID = /^\d+(?:\.\d+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ENTITY_ID_MAX_CHARS = 256;
const PrivateArtifactTypeZ = z.enum(PRIVATE_ARTIFACT_TYPES);
const NonBlankStringZ = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const EntityIdZ = z.string().min(1).max(ENTITY_ID_MAX_CHARS)
  .refine((value) => value.trim().length > 0, "must not be blank");
const EvidenceLidsZ = z.array(NonBlankStringZ).min(1);

export type PrivateIntentArtifactType = typeof PRIVATE_ARTIFACT_TYPES[number];
export type IntentArtifactCompatibilityType = PrivateIntentArtifactType | "custom";

export interface ArtifactInstanceRecordV2 {
  record_id: string;
  data: Record<string, unknown>;
  evidence_lids: string[];
}

export interface ArtifactInstanceRelationV2 {
  relation_id: string;
  source: string;
  target: string;
  data: Record<string, unknown>;
  evidence_lids: string[];
}

export interface ArtifactInstanceV2 {
  version: "artifact_instance.v2";
  blueprint_digest: string;
  records: ArtifactInstanceRecordV2[];
  relations?: ArtifactInstanceRelationV2[];
}

export interface ArtifactInstanceV3 {
  version: "artifact_instance.v3";
  blueprint_id: string;
  blueprint_version: string;
  records: ArtifactInstanceRecordV2[];
  relations?: ArtifactInstanceRelationV2[];
}

export interface IntentArtifactTaskArtifactV2 extends BuildPlanPrivateArtifactV2 {
  /** A bounded compatibility label only; validation is always Blueprint-driven. */
  artifact_type: IntentArtifactCompatibilityType;
}

export interface IntentArtifactTaskEnvelopeV2 {
  version: "intent_artifact_task_envelope.v2";
  task_id: string;
  privacy: "reader_private";
  book_id: string;
  source_fingerprint: string;
  content_profile: BuildContentProfile;
  intent_id: string;
  intent_digest: string;
  plan_id: string;
  plan_digest: string;
  user_goal: string;
  artifact: IntentArtifactTaskArtifactV2;
  output_contract: {
    version: "artifact_instance_output_contract.v2";
    payload_version: "artifact_instance.v2";
    blueprint_digest: string;
  };
  validation_rules: string[];
  allowed_evidence_lids: string[];
}

export interface IntentArtifactTaskArtifactV3 extends BuildPlanPrivateArtifactV3 {
  /** A bounded compatibility label only; validation is always Blueprint-driven. */
  artifact_type: IntentArtifactCompatibilityType;
}

export interface IntentArtifactTaskEnvelopeV3 {
  version: "intent_artifact_task_envelope.v3";
  task_id: string;
  privacy: "reader_private";
  book_id: string;
  source_fingerprint: string;
  content_profile: BuildContentProfile;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  user_goal: string;
  artifact: IntentArtifactTaskArtifactV3;
  output_contract: {
    version: "artifact_instance_output_contract.v3";
    payload_version: "artifact_instance.v3";
    blueprint_id: string;
    blueprint_version: string;
  };
  validation_rules: string[];
  allowed_evidence_lids: string[];
}

export interface IntentArtifactCandidateV2 {
  version: "intent_artifact_candidate.v2";
  task_id: string;
  book_id: string;
  source_fingerprint: string;
  intent_id: string;
  intent_digest: string;
  plan_id: string;
  plan_digest: string;
  artifact_id: string;
  blueprint_digest: string;
  payload: ArtifactInstanceV2;
}

export interface AcceptedIntentArtifactV2 extends Omit<IntentArtifactCandidateV2, "version"> {
  version: "intent_artifact_accepted.v2";
  payload_digest: string;
  accepted_at: string;
}

export interface IntentArtifactCandidateV3 {
  version: "intent_artifact_candidate.v3";
  task_id: string;
  book_id: string;
  source_fingerprint: string;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  artifact_id: string;
  blueprint_id: string;
  blueprint_version: string;
  payload: ArtifactInstanceV3;
}

export interface AcceptedIntentArtifactV3 extends Omit<IntentArtifactCandidateV3, "version"> {
  version: "intent_artifact_accepted.v3";
  payload_digest: string;
  accepted_at: string;
}

export interface AcceptedIntentArtifactV1 {
  version: "intent_artifact_accepted.v1";
  task_id: string;
  book_id: string;
  source_fingerprint: string;
  intent_id: string;
  intent_digest: string;
  plan_id: string;
  plan_digest: string;
  artifact_id: string;
  artifact_type: PrivateIntentArtifactType;
  payload: unknown;
  payload_digest: string;
  accepted_at: string;
}

export interface ProjectedAcceptedIntentArtifactV1AsV2 extends AcceptedIntentArtifactV2 {
  legacy_payload_digest: string;
}

export interface IntentArtifactTaskReceiptV1 {
  version: "intent_artifact_task_receipt.v1";
  state: "committed";
  task_id: string;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  intent_digest: string;
  plan_digest: string;
  blueprint_digest: string;
  payload_digest: string;
  record_count: number;
  relation_count: number;
  evidence_reference_count: number;
  accepted_at: string;
}

export interface IntentArtifactTaskReceiptV2 {
  version: "intent_artifact_task_receipt.v2";
  state: "committed";
  task_id: string;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  blueprint_id: string;
  blueprint_version: string;
  payload_digest: string;
  record_count: number;
  relation_count: number;
  evidence_reference_count: number;
  accepted_at: string;
}

export interface IntentArtifactTaskHandoffV1 {
  version: "intent_artifact_task_handoff.v1";
  task_id: string;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  task_path: string;
}

export interface IntentArtifactTaskHandoffV2 {
  version: "intent_artifact_task_handoff.v2";
  task_id: string;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
  artifact_id: string;
  artifact_type: IntentArtifactCompatibilityType;
  blueprint_id: string;
  blueprint_version: string;
  task_path: string;
}

export interface CompileIntentArtifactTasksInput {
  intent: BuildIntentV3;
  plan: BuildPlanV3;
  available_lids: readonly string[];
  resolved_scope_lids: readonly string[];
}

export interface AcceptIntentArtifactCandidateInput {
  task: IntentArtifactTaskEnvelopeV3;
  candidate: unknown;
  current_intent: BuildIntentV3;
  current_plan: BuildPlanV3;
  current_source_fingerprint: string;
  available_lids: readonly string[];
  resolved_scope_lids: readonly string[];
  accepted_at: string;
}

const ArtifactInstanceRecordV2Z = z.object({
  record_id: EntityIdZ,
  data: z.record(z.unknown()),
  evidence_lids: EvidenceLidsZ,
}).strict();

const ArtifactInstanceRelationV2Z = z.object({
  relation_id: EntityIdZ,
  source: EntityIdZ,
  target: EntityIdZ,
  data: z.record(z.unknown()),
  evidence_lids: EvidenceLidsZ,
}).strict();

const ArtifactInstanceV2Z = z.object({
  version: z.literal("artifact_instance.v2"),
  blueprint_digest: z.string().regex(SHA256, "blueprint_digest must be a lowercase SHA-256 digest"),
  records: z.array(ArtifactInstanceRecordV2Z),
  relations: z.array(ArtifactInstanceRelationV2Z).optional(),
}).strict();

const ArtifactInstanceV3Z = z.object({
  version: z.literal("artifact_instance.v3"),
  blueprint_id: NonBlankStringZ,
  blueprint_version: NonBlankStringZ,
  records: z.array(ArtifactInstanceRecordV2Z),
  relations: z.array(ArtifactInstanceRelationV2Z).optional(),
}).strict();

const CandidateV3Z = z.object({
  version: z.literal("intent_artifact_candidate.v3"),
  task_id: NonBlankStringZ,
  book_id: NonBlankStringZ,
  source_fingerprint: NonBlankStringZ,
  intent_id: NonBlankStringZ,
  intent_revision: z.number().int().positive().safe(),
  plan_id: NonBlankStringZ,
  plan_revision: z.number().int().positive().safe(),
  artifact_id: NonBlankStringZ,
  blueprint_id: NonBlankStringZ,
  blueprint_version: NonBlankStringZ,
  payload: ArtifactInstanceV3Z,
}).strict();

const TimelinePayloadZ = z.object({
  items: z.array(z.object({
    id: EntityIdZ,
    label: NonBlankStringZ,
    order_hint: NonBlankStringZ.optional(),
    evidence_lids: EvidenceLidsZ,
  }).strict()),
}).strict();

const ConceptMapPayloadZ = z.object({
  nodes: z.array(z.object({
    id: EntityIdZ,
    label: NonBlankStringZ,
    evidence_lids: EvidenceLidsZ,
  }).strict()),
  links: z.array(z.object({
    source: EntityIdZ,
    target: EntityIdZ,
    relation: NonBlankStringZ,
    evidence_lids: EvidenceLidsZ,
  }).strict()),
}).strict();

const ComparisonTablePayloadZ = z.object({
  rows: z.array(z.object({
    subject: NonBlankStringZ,
    dimensions: z.record(z.unknown()),
    evidence_lids: EvidenceLidsZ,
  }).strict()),
}).strict();

const ArgumentMapPayloadZ = z.object({
  claims: z.array(z.object({
    id: EntityIdZ,
    claim: NonBlankStringZ,
    role: z.enum(["problem", "method", "evidence", "result", "limitation", "future_work"]),
    evidence_lids: EvidenceLidsZ,
  }).strict()),
  relations: z.array(z.object({
    source: EntityIdZ,
    target: EntityIdZ,
    relation: NonBlankStringZ,
    evidence_lids: EvidenceLidsZ,
  }).strict()),
}).strict();

type ParsedLegacyPayload =
  | z.infer<typeof TimelinePayloadZ>
  | z.infer<typeof ConceptMapPayloadZ>
  | z.infer<typeof ComparisonTablePayloadZ>
  | z.infer<typeof ArgumentMapPayloadZ>;

interface PayloadMetrics {
  record_count: number;
  relation_count: number;
  evidence_reference_count: number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalBuildJson(value), "utf8").digest("hex");
}

function assertIsoDateTime(value: string, field: string): void {
  if (!z.string().datetime({ offset: true }).safeParse(value).success) {
    throw new Error(`${field} must be an ISO date-time with an offset`);
  }
}

function normalizeLids(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!LID.test(value)) throw new Error(`${field} contains invalid LID: ${value}`);
    if (seen.has(value)) throw new Error(`${field} contains duplicate LID: ${value}`);
    seen.add(value);
  }
  return [...seen].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function assertSameJson(left: unknown, right: unknown, message: string): void {
  if (canonicalBuildJson(left) !== canonicalBuildJson(right)) throw new Error(message);
}

function compatibilityType(blueprint: ArtifactBlueprintV1): IntentArtifactCompatibilityType {
  const match = PRIVATE_ARTIFACT_TYPES.find((type) => blueprint.blueprint_id === `system.${type}`);
  return match ?? "custom";
}

function validateConfirmedSelection(intentInput: BuildIntentV3, planInput: BuildPlanV3): {
  intent: BuildIntentV3;
  plan: BuildPlanV3;
  privateArtifacts: BuildPlanPrivateArtifactV3[];
} {
  const intent = validateBuildIntentV3(intentInput);
  const plan = validateBuildPlanV3(planInput);
  if (intent.status !== "confirmed") throw new Error("intent artifact tasks require a confirmed BuildIntent");
  if (plan.status !== "confirmed") throw new Error("intent artifact tasks require a confirmed BuildPlan");
  if (plan.recipe_id !== "goal_directed") throw new Error("intent artifact tasks require a goal_directed BuildPlan");
  if (intent.privacy !== "reader_private") throw new Error("intent artifact tasks require reader_private intent privacy");
  if (plan.book_id !== intent.book_id) throw new Error("BuildPlan book_id does not match BuildIntent book_id");
  if (plan.source_fingerprint !== intent.source_fingerprint) {
    throw new Error("BuildPlan source_fingerprint does not match BuildIntent source_fingerprint");
  }
  assertSameJson(plan.content_profile, intent.content_profile, "BuildPlan content_profile does not match BuildIntent content_profile");
  if (plan.intent_id !== intent.intent_id) throw new Error("BuildPlan intent_id does not match BuildIntent intent_id");
  if (plan.intent_revision !== intent.intent_revision) {
    throw new Error("BuildPlan intent_revision does not match the current BuildIntent");
  }
  return { intent, plan, privateArtifacts: plan.private_artifacts };
}

function validateScope(
  intent: BuildIntentV3,
  privateArtifacts: readonly BuildPlanPrivateArtifactV3[],
  availableInput: readonly string[],
  resolvedInput: readonly string[],
): { available: string[]; resolved: string[] } {
  const available = normalizeLids(availableInput, "available_lids");
  const resolved = normalizeLids(resolvedInput, "resolved_scope_lids");
  const availableSet = new Set(available);
  for (const lid of resolved) {
    if (!availableSet.has(lid)) throw new Error(`resolved source scope LID is not a current book LID: ${lid}`);
  }
  if (intent.source_scope.whole_book) {
    assertSameJson(resolved, available, "whole-book source scope must resolve to every current book LID");
  } else {
    const resolvedSet = new Set(resolved);
    for (const lid of intent.source_scope.lids) {
      if (!availableSet.has(lid)) throw new Error(`intent source scope contains a non-current book LID: ${lid}`);
      if (!resolvedSet.has(lid)) throw new Error(`resolved source scope omits intent LID: ${lid}`);
    }
  }
  for (const artifact of privateArtifacts) {
    assertSameJson(artifact.source_scope, intent.source_scope, `artifact ${artifact.artifact_id} source scope differs from its intent`);
  }
  return { available, resolved };
}

function taskId(planRevision: number, artifactId: string): string {
  return `intent_artifact_r${planRevision}_${artifactId}`;
}

const V3_VALIDATION_RULES = [
  "candidate_identity_matches_current_task",
  "blueprint_snapshot_and_version_match_confirmed_plan",
  "record_and_relation_data_match_restricted_schema",
  "record_and_relation_ids_are_unique_and_relation_endpoints_exist",
  "every_record_and_relation_has_current_in_scope_lid_evidence",
  "record_relation_and_text_limits_are_enforced",
] as const;

export function compileIntentArtifactTasks(input: CompileIntentArtifactTasksInput): IntentArtifactTaskEnvelopeV3[] {
  const { intent, plan, privateArtifacts } = validateConfirmedSelection(input.intent, input.plan);
  const { resolved } = validateScope(intent, privateArtifacts, input.available_lids, input.resolved_scope_lids);
  return privateArtifacts.map((artifact) => {
    const blueprint = assertSameArtifactBlueprintVersionV2(artifact.blueprint, artifact.blueprint);
    return {
      version: "intent_artifact_task_envelope.v3",
      task_id: taskId(plan.plan_revision, artifact.artifact_id),
      privacy: "reader_private",
      book_id: plan.book_id,
      source_fingerprint: plan.source_fingerprint,
      content_profile: structuredClone(plan.content_profile),
      intent_id: intent.intent_id,
      intent_revision: intent.intent_revision,
      plan_id: plan.plan_id,
      plan_revision: plan.plan_revision,
      user_goal: intent.user_goal,
      artifact: {
        artifact_id: artifact.artifact_id,
        artifact_type: compatibilityType(blueprint),
        source_scope: structuredClone(artifact.source_scope),
        blueprint: structuredClone(blueprint),
        blueprint_id: artifact.blueprint_id,
        blueprint_version: artifact.blueprint_version,
        required_public_capabilities: [...artifact.required_public_capabilities],
      },
      output_contract: {
        version: "artifact_instance_output_contract.v3",
        payload_version: "artifact_instance.v3",
        blueprint_id: artifact.blueprint_id,
        blueprint_version: artifact.blueprint_version,
      },
      validation_rules: [...V3_VALIDATION_RULES],
      allowed_evidence_lids: [...resolved],
    };
  });
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${label} must have unique ids: ${id}`);
    seen.add(id);
  }
}

function countTextCharacters(value: unknown): number {
  if (typeof value === "string") return [...value].length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countTextCharacters(item), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((total, item) => total + countTextCharacters(item), 0);
  }
  return 0;
}

function validateEvidence(
  evidenceArrays: readonly string[][],
  availableInput?: readonly string[],
  allowedInput?: readonly string[],
): void {
  const available = availableInput ? new Set(normalizeLids(availableInput, "available_lids")) : undefined;
  const allowed = allowedInput ? new Set(normalizeLids(allowedInput, "allowed_evidence_lids")) : undefined;
  for (const lids of evidenceArrays) {
    const normalized = normalizeLids(lids, "record evidence LIDs");
    if (!normalized.length) throw new Error("every record and relation requires at least one evidence LID");
    for (const lid of normalized) {
      if (available && !available.has(lid)) throw new Error(`evidence must reference a current book LID: ${lid}`);
      if (allowed && !allowed.has(lid)) throw new Error(`evidence LID is outside the confirmed source scope: ${lid}`);
    }
  }
}

function validateArtifactInstance(
  blueprintInput: unknown,
  input: ArtifactInstanceV2,
  evidence?: { available_lids: readonly string[]; allowed_evidence_lids: readonly string[] },
): { payload: ArtifactInstanceV2; metrics: PayloadMetrics };
function validateArtifactInstance(
  blueprintInput: unknown,
  input: ArtifactInstanceV3,
  evidence?: { available_lids: readonly string[]; allowed_evidence_lids: readonly string[] },
): { payload: ArtifactInstanceV3; metrics: PayloadMetrics };
function validateArtifactInstance(
  blueprintInput: unknown,
  input: unknown,
  evidence?: { available_lids: readonly string[]; allowed_evidence_lids: readonly string[] },
): { payload: ArtifactInstanceV2 | ArtifactInstanceV3; metrics: PayloadMetrics } {
  const blueprint = validateArtifactBlueprintV1(blueprintInput);
  const version = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).version
    : undefined;
  const parsed = version === "artifact_instance.v2"
    ? ArtifactInstanceV2Z.parse(input)
    : ArtifactInstanceV3Z.parse(input);
  if (parsed.version === "artifact_instance.v2") {
    const expectedBlueprintDigest = computeArtifactBlueprintDigest(blueprint);
    if (parsed.blueprint_digest !== expectedBlueprintDigest) {
      throw new Error("ArtifactInstance blueprint_digest does not match the confirmed Blueprint snapshot");
    }
  } else if (parsed.blueprint_id !== blueprint.blueprint_id
    || parsed.blueprint_version !== blueprint.blueprint_version) {
    throw new Error("ArtifactInstance Blueprint id/version does not match the confirmed snapshot");
  }
  if (parsed.records.length > blueprint.limits.max_records) {
    throw new Error(`ArtifactInstance exceeds Blueprint max_records: ${blueprint.limits.max_records}`);
  }
  const relations = parsed.relations ?? [];
  if (relations.length > blueprint.limits.max_relations) {
    throw new Error(`ArtifactInstance exceeds Blueprint max_relations: ${blueprint.limits.max_relations}`);
  }
  if (!blueprint.relation_schema && relations.length) {
    throw new Error("ArtifactInstance relations require a Blueprint relation_schema");
  }
  assertUniqueIds(parsed.records.map((record) => record.record_id), "ArtifactInstance record_id");
  assertUniqueIds(relations.map((relation) => relation.relation_id), "ArtifactInstance relation_id");
  const recordIds = new Set(parsed.records.map((record) => record.record_id));
  for (const relation of relations) {
    if (!recordIds.has(relation.source) || !recordIds.has(relation.target)) {
      throw new Error("ArtifactInstance relation endpoints must reference an existing record");
    }
  }
  const records = parsed.records.map((record) => ({
    ...record,
    data: validateRestrictedSchemaValueV1(blueprint.record_schema, record.data) as Record<string, unknown>,
  }));
  const validatedRelations = relations.map((relation) => ({
    ...relation,
    data: validateRestrictedSchemaValueV1(blueprint.relation_schema!, relation.data) as Record<string, unknown>,
  }));
  const textCharacters = [...records, ...validatedRelations]
    .reduce((total, item) => total + countTextCharacters(item.data), 0);
  if (textCharacters > blueprint.limits.max_text_chars) {
    throw new Error(`ArtifactInstance exceeds Blueprint max_text_chars: ${blueprint.limits.max_text_chars}`);
  }
  const evidenceArrays = [...records, ...validatedRelations].map((item) => item.evidence_lids);
  validateEvidence(evidenceArrays, evidence?.available_lids, evidence?.allowed_evidence_lids);
  const payload: ArtifactInstanceV2 | ArtifactInstanceV3 = parsed.version === "artifact_instance.v2"
    ? {
        version: "artifact_instance.v2",
        blueprint_digest: parsed.blueprint_digest,
        records,
        ...(parsed.relations === undefined ? {} : { relations: validatedRelations }),
      }
    : {
        version: "artifact_instance.v3",
        blueprint_id: blueprint.blueprint_id,
        blueprint_version: blueprint.blueprint_version,
        records,
        ...(parsed.relations === undefined ? {} : { relations: validatedRelations }),
      };
  canonicalBuildJson(payload);
  return {
    payload,
    metrics: {
      record_count: records.length,
      relation_count: validatedRelations.length,
      evidence_reference_count: evidenceArrays.reduce((total, lids) => total + lids.length, 0),
    },
  };
}

function parseCandidate(input: unknown): IntentArtifactCandidateV3 {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || (input as Record<string, unknown>).version !== "intent_artifact_candidate.v3") {
    throw new Error("new intent artifact generation requires intent_artifact_candidate.v3");
  }
  return CandidateV3Z.parse(input) as IntentArtifactCandidateV3;
}

function assertCandidateIdentity(candidate: IntentArtifactCandidateV3, task: IntentArtifactTaskEnvelopeV3): void {
  const expected: Array<[keyof IntentArtifactCandidateV3, unknown]> = [
    ["task_id", task.task_id],
    ["book_id", task.book_id],
    ["source_fingerprint", task.source_fingerprint],
    ["intent_id", task.intent_id],
    ["intent_revision", task.intent_revision],
    ["plan_id", task.plan_id],
    ["plan_revision", task.plan_revision],
    ["artifact_id", task.artifact.artifact_id],
    ["blueprint_id", task.artifact.blueprint_id],
    ["blueprint_version", task.artifact.blueprint_version],
  ];
  for (const [field, value] of expected) {
    if (candidate[field] !== value) throw new Error(`candidate ${field} does not match its current task`);
  }
  if (candidate.payload.blueprint_id !== task.artifact.blueprint_id
    || candidate.payload.blueprint_version !== task.artifact.blueprint_version) {
    throw new Error("candidate payload Blueprint id/version does not match its current task");
  }
}

export function acceptIntentArtifactCandidate(input: AcceptIntentArtifactCandidateInput): {
  accepted: AcceptedIntentArtifactV3;
  receipt: IntentArtifactTaskReceiptV2;
} {
  if (input.current_source_fingerprint !== input.current_intent.source_fingerprint) {
    throw new Error("current source_fingerprint does not match the confirmed intent");
  }
  const expectedTasks = compileIntentArtifactTasks({
    intent: input.current_intent,
    plan: input.current_plan,
    available_lids: input.available_lids,
    resolved_scope_lids: input.resolved_scope_lids,
  });
  const expectedTask = expectedTasks.find((task) => task.task_id === input.task.task_id);
  if (!expectedTask || canonicalBuildJson(expectedTask) !== canonicalBuildJson(input.task)) {
    throw new Error("task envelope does not match the current confirmed intent, plan, Blueprint, and source scope");
  }
  const candidate = parseCandidate(input.candidate);
  assertCandidateIdentity(candidate, expectedTask);
  assertIsoDateTime(input.accepted_at, "accepted_at");
  const { payload, metrics } = validateArtifactInstance(expectedTask.artifact.blueprint, candidate.payload, {
    available_lids: input.available_lids,
    allowed_evidence_lids: expectedTask.allowed_evidence_lids,
  });
  const payloadDigest = digest(payload);
  const accepted: AcceptedIntentArtifactV3 = {
    ...candidate,
    version: "intent_artifact_accepted.v3",
    payload,
    payload_digest: payloadDigest,
    accepted_at: input.accepted_at,
  };
  const receipt: IntentArtifactTaskReceiptV2 = {
    version: "intent_artifact_task_receipt.v2",
    state: "committed",
    task_id: expectedTask.task_id,
    artifact_id: expectedTask.artifact.artifact_id,
    artifact_type: expectedTask.artifact.artifact_type,
    intent_id: expectedTask.intent_id,
    intent_revision: expectedTask.intent_revision,
    plan_id: expectedTask.plan_id,
    plan_revision: expectedTask.plan_revision,
    blueprint_id: expectedTask.artifact.blueprint_id,
    blueprint_version: expectedTask.artifact.blueprint_version,
    payload_digest: payloadDigest,
    ...metrics,
    accepted_at: input.accepted_at,
  };
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 4_096) {
    throw new Error("intent artifact receipt exceeds 4096 bytes");
  }
  return { accepted, receipt };
}

function parseLegacyPayload(type: PrivateIntentArtifactType, input: unknown): ParsedLegacyPayload {
  switch (type) {
    case "timeline": return TimelinePayloadZ.parse(input);
    case "concept_map": return ConceptMapPayloadZ.parse(input);
    case "comparison_table": return ComparisonTablePayloadZ.parse(input);
    case "argument_map": return ArgumentMapPayloadZ.parse(input);
  }
}

function uniqueRelationId(base: string, seen: Set<string>): string {
  let candidate = base.slice(0, ENTITY_ID_MAX_CHARS);
  let suffix = 1;
  while (seen.has(candidate)) {
    suffix += 1;
    const marker = `#${suffix}`;
    candidate = `${base.slice(0, ENTITY_ID_MAX_CHARS - marker.length)}${marker}`;
  }
  seen.add(candidate);
  return candidate;
}

export function adaptIntentArtifactPayloadV1(
  artifactTypeInput: LegacyIntentArtifactTypeV1,
  input: unknown,
): ArtifactInstanceV2 {
  const artifactType = PrivateArtifactTypeZ.parse(artifactTypeInput);
  const payload = parseLegacyPayload(artifactType, input);
  const preset = getSystemArtifactBlueprintV1(artifactType);
  let records: ArtifactInstanceRecordV2[];
  let relations: ArtifactInstanceRelationV2[] = [];
  const relationIds = new Set<string>();
  switch (artifactType) {
    case "timeline": {
      const typed = payload as z.infer<typeof TimelinePayloadZ>;
      records = typed.items.map(({ id, label, order_hint, evidence_lids }) => ({
        record_id: id,
        data: { label, ...(order_hint === undefined ? {} : { order_hint }) },
        evidence_lids,
      }));
      break;
    }
    case "concept_map": {
      const typed = payload as z.infer<typeof ConceptMapPayloadZ>;
      records = typed.nodes.map(({ id, label, evidence_lids }) => ({ record_id: id, data: { label }, evidence_lids }));
      relations = typed.links.map(({ source, target, relation, evidence_lids }) => ({
        relation_id: uniqueRelationId(`${source}:${relation}:${target}`, relationIds),
        source,
        target,
        data: { relation },
        evidence_lids,
      }));
      break;
    }
    case "comparison_table": {
      const typed = payload as z.infer<typeof ComparisonTablePayloadZ>;
      records = typed.rows.map(({ subject, dimensions, evidence_lids }, index) => ({
        record_id: `row-${index + 1}`,
        data: {
          subject,
          dimensions: Object.keys(dimensions).sort().map((name) => ({
            name,
            value_json: canonicalBuildJson(dimensions[name]),
          })),
        },
        evidence_lids,
      }));
      break;
    }
    case "argument_map": {
      const typed = payload as z.infer<typeof ArgumentMapPayloadZ>;
      records = typed.claims.map(({ id, claim, role, evidence_lids }) => ({
        record_id: id,
        data: { claim, role },
        evidence_lids,
      }));
      relations = typed.relations.map(({ source, target, relation, evidence_lids }) => ({
        relation_id: uniqueRelationId(`${source}:${relation}:${target}`, relationIds),
        source,
        target,
        data: { relation },
        evidence_lids,
      }));
      break;
    }
  }
  return validateArtifactInstance(preset.blueprint, {
    version: "artifact_instance.v2",
    blueprint_digest: preset.digest,
    records,
    ...(relations.length || preset.blueprint.relation_schema ? { relations } : {}),
  }).payload;
}

export function projectAcceptedIntentArtifactV1AsV2(
  input: AcceptedIntentArtifactV1,
): ProjectedAcceptedIntentArtifactV1AsV2 {
  if (input.version !== "intent_artifact_accepted.v1") throw new Error("unsupported legacy accepted artifact version");
  for (const [field, value] of [
    ["task_id", input.task_id],
    ["book_id", input.book_id],
    ["source_fingerprint", input.source_fingerprint],
    ["intent_id", input.intent_id],
    ["plan_id", input.plan_id],
    ["artifact_id", input.artifact_id],
  ] as const) {
    if (!value.trim()) throw new Error(`legacy accepted artifact ${field} must not be blank`);
  }
  if (!SHA256.test(input.intent_digest) || !SHA256.test(input.plan_digest) || !SHA256.test(input.payload_digest)) {
    throw new Error("legacy accepted artifact contains an invalid digest");
  }
  assertIsoDateTime(input.accepted_at, "accepted_at");
  const artifactType = PrivateArtifactTypeZ.parse(input.artifact_type);
  if (digest(input.payload) !== input.payload_digest) {
    throw new Error("legacy accepted artifact payload_digest does not match payload");
  }
  const payload = adaptIntentArtifactPayloadV1(artifactType, input.payload);
  const blueprintDigest = getSystemArtifactBlueprintV1(artifactType).digest;
  return {
    version: "intent_artifact_accepted.v2",
    task_id: input.task_id,
    book_id: input.book_id,
    source_fingerprint: input.source_fingerprint,
    intent_id: input.intent_id,
    intent_digest: input.intent_digest,
    plan_id: input.plan_id,
    plan_digest: input.plan_digest,
    artifact_id: input.artifact_id,
    blueprint_digest: blueprintDigest,
    payload,
    payload_digest: digest(payload),
    accepted_at: input.accepted_at,
    legacy_payload_digest: input.payload_digest,
  };
}

export function projectIntentArtifactTaskHandoff(
  task: IntentArtifactTaskEnvelopeV3,
  taskPath: string,
): IntentArtifactTaskHandoffV2 {
  if (!taskPath.trim()) throw new Error("intent artifact task handoff requires an opaque task path");
  return {
    version: "intent_artifact_task_handoff.v2",
    task_id: task.task_id,
    intent_id: task.intent_id,
    intent_revision: task.intent_revision,
    plan_id: task.plan_id,
    plan_revision: task.plan_revision,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    blueprint_id: task.artifact.blueprint_id,
    blueprint_version: task.artifact.blueprint_version,
    task_path: taskPath,
  };
}
