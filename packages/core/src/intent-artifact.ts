import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalBuildJson,
  computeBuildIntentDigest,
  validateBuildIntentV1,
  validateBuildPlanV1,
  type BuildContentProfile,
  type BuildIntentV1,
  type BuildPlanV1,
  type BuildSourceScope,
} from "./build-intent";
import {
  sidecarPlanOptionFor,
  type SidecarOutputContract,
  type SidecarTargetView,
} from "./sidecar-plan";

const PRIVATE_ARTIFACT_TYPES = ["timeline", "concept_map", "comparison_table", "argument_map"] as const;
const LID = /^\d+(?:\.\d+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PrivateArtifactTypeZ = z.enum(PRIVATE_ARTIFACT_TYPES);
const NonBlankStringZ = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const EvidenceLidsZ = z.array(NonBlankStringZ).min(1);

export type PrivateIntentArtifactType = typeof PRIVATE_ARTIFACT_TYPES[number];

export interface IntentArtifactTaskEnvelopeV1 {
  version: "intent_artifact_task_envelope.v1";
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
  artifact: {
    artifact_id: string;
    artifact_type: PrivateIntentArtifactType;
    source_scope: BuildSourceScope;
    required_public_capabilities: string[];
    evidence_policy: "lid_required";
  };
  output_contract: Omit<SidecarOutputContract, "sidecar_id">;
  validation_rules: string[];
  allowed_evidence_lids: string[];
}

export interface IntentArtifactCandidateV1 {
  version: "intent_artifact_candidate.v1";
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
}

export interface AcceptedIntentArtifactV1 extends Omit<IntentArtifactCandidateV1, "version"> {
  version: "intent_artifact_accepted.v1";
  payload_digest: string;
  accepted_at: string;
}

export interface IntentArtifactTaskReceiptV1 {
  version: "intent_artifact_task_receipt.v1";
  state: "committed";
  task_id: string;
  artifact_id: string;
  artifact_type: PrivateIntentArtifactType;
  intent_digest: string;
  plan_digest: string;
  payload_digest: string;
  record_count: number;
  evidence_reference_count: number;
  accepted_at: string;
}

export interface IntentArtifactTaskHandoffV1 {
  version: "intent_artifact_task_handoff.v1";
  task_id: string;
  artifact_id: string;
  artifact_type: PrivateIntentArtifactType;
  task_path: string;
}

export interface CompileIntentArtifactTasksInput {
  intent: BuildIntentV1;
  plan: BuildPlanV1;
  available_lids: readonly string[];
  resolved_scope_lids: readonly string[];
}

export interface AcceptIntentArtifactCandidateInput {
  task: IntentArtifactTaskEnvelopeV1;
  candidate: unknown;
  current_intent: BuildIntentV1;
  current_plan: BuildPlanV1;
  current_source_fingerprint: string;
  available_lids: readonly string[];
  resolved_scope_lids: readonly string[];
  accepted_at: string;
}

const CandidateZ = z.object({
  version: z.literal("intent_artifact_candidate.v1"),
  task_id: NonBlankStringZ,
  book_id: NonBlankStringZ,
  source_fingerprint: NonBlankStringZ,
  intent_id: NonBlankStringZ,
  intent_digest: z.string().regex(SHA256, "intent_digest must be a lowercase SHA-256 digest"),
  plan_id: NonBlankStringZ,
  plan_digest: z.string().regex(SHA256, "plan_digest must be a lowercase SHA-256 digest"),
  artifact_id: NonBlankStringZ,
  artifact_type: PrivateArtifactTypeZ,
  payload: z.unknown(),
}).strict();

const TimelinePayloadZ = z.object({
  items: z.array(z.object({
    id: NonBlankStringZ,
    label: NonBlankStringZ,
    order_hint: NonBlankStringZ.optional(),
    evidence_lids: EvidenceLidsZ,
  }).strict()),
}).strict();

const ConceptMapPayloadZ = z.object({
  nodes: z.array(z.object({
    id: NonBlankStringZ,
    label: NonBlankStringZ,
    evidence_lids: EvidenceLidsZ,
  }).strict()),
  links: z.array(z.object({
    source: NonBlankStringZ,
    target: NonBlankStringZ,
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
    id: NonBlankStringZ,
    claim: NonBlankStringZ,
    role: z.enum(["problem", "method", "evidence", "result", "limitation", "future_work"]),
    evidence_lids: EvidenceLidsZ,
  }).strict()),
  relations: z.array(z.object({
    source: NonBlankStringZ,
    target: NonBlankStringZ,
    relation: NonBlankStringZ,
    evidence_lids: EvidenceLidsZ,
  }).strict()),
}).strict();

type ParsedPayload =
  | z.infer<typeof TimelinePayloadZ>
  | z.infer<typeof ConceptMapPayloadZ>
  | z.infer<typeof ComparisonTablePayloadZ>
  | z.infer<typeof ArgumentMapPayloadZ>;

interface PayloadMetrics {
  record_count: number;
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

function validateConfirmedSelection(intentInput: BuildIntentV1, planInput: BuildPlanV1): {
  intent: BuildIntentV1;
  plan: BuildPlanV1;
  intentDigest: string;
} {
  const intent = validateBuildIntentV1(intentInput);
  const plan = validateBuildPlanV1(planInput);
  if (intent.status !== "confirmed") throw new Error("intent artifact tasks require a confirmed BuildIntent");
  if (plan.status !== "confirmed") throw new Error("intent artifact tasks require a confirmed BuildPlan");
  if (plan.recipe_id !== "goal_directed") throw new Error("intent artifact tasks require a goal_directed BuildPlan");
  if (intent.privacy !== "reader_private") throw new Error("intent artifact tasks require reader_private intent privacy");
  if (plan.book_id !== intent.book_id) throw new Error("BuildPlan book_id does not match BuildIntent book_id");
  if (plan.source_fingerprint !== intent.source_fingerprint) {
    throw new Error("BuildPlan source_fingerprint does not match BuildIntent source_fingerprint");
  }
  assertSameJson(plan.content_profile, intent.content_profile, "BuildPlan content_profile does not match BuildIntent content_profile");
  const intentDigest = computeBuildIntentDigest(intent);
  if (plan.intent_id !== intent.intent_id) throw new Error("BuildPlan intent_id does not match BuildIntent intent_id");
  if (plan.intent_digest !== intentDigest) throw new Error("BuildPlan intent_digest does not match the current BuildIntent");
  return { intent, plan, intentDigest };
}

function validateScope(
  intent: BuildIntentV1,
  plan: BuildPlanV1,
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
  for (const artifact of plan.private_artifacts) {
    assertSameJson(artifact.source_scope, intent.source_scope, `artifact ${artifact.artifact_id} source scope differs from its intent`);
  }
  return { available, resolved };
}

function taskId(planDigest: string, artifactId: string): string {
  return `intent_artifact_${digest({ plan_digest: planDigest, artifact_id: artifactId }).slice(0, 24)}`;
}

export function compileIntentArtifactTasks(input: CompileIntentArtifactTasksInput): IntentArtifactTaskEnvelopeV1[] {
  const { intent, plan, intentDigest } = validateConfirmedSelection(input.intent, input.plan);
  const { resolved } = validateScope(intent, plan, input.available_lids, input.resolved_scope_lids);
  return plan.private_artifacts.map((artifact) => {
    const artifactType = PrivateArtifactTypeZ.parse(artifact.artifact_type);
    const option = sidecarPlanOptionFor(artifactType as SidecarTargetView);
    return {
      version: "intent_artifact_task_envelope.v1",
      task_id: taskId(plan.plan_digest, artifact.artifact_id),
      privacy: "reader_private",
      book_id: plan.book_id,
      source_fingerprint: plan.source_fingerprint,
      content_profile: structuredClone(plan.content_profile),
      intent_id: intent.intent_id,
      intent_digest: intentDigest,
      plan_id: plan.plan_id,
      plan_digest: plan.plan_digest,
      user_goal: intent.user_goal,
      artifact: {
        artifact_id: artifact.artifact_id,
        artifact_type: artifactType,
        source_scope: structuredClone(artifact.source_scope),
        required_public_capabilities: [...artifact.required_public_capabilities],
        evidence_policy: artifact.evidence_policy,
      },
      output_contract: structuredClone(option.output_contract),
      validation_rules: [...option.validation_rules],
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

function assertGraphReferences(
  records: readonly { source: string; target: string }[],
  ids: ReadonlySet<string>,
  label: string,
): void {
  for (const record of records) {
    if (!ids.has(record.source) || !ids.has(record.target)) {
      throw new Error(`${label} must reference existing ${label === "concept links" ? "nodes" : "claims"}`);
    }
  }
}

function evidenceArrays(type: PrivateIntentArtifactType, payload: ParsedPayload): string[][] {
  switch (type) {
    case "timeline":
      return (payload as z.infer<typeof TimelinePayloadZ>).items.map((item) => item.evidence_lids);
    case "concept_map": {
      const graph = payload as z.infer<typeof ConceptMapPayloadZ>;
      return [...graph.nodes, ...graph.links].map((item) => item.evidence_lids);
    }
    case "comparison_table":
      return (payload as z.infer<typeof ComparisonTablePayloadZ>).rows.map((row) => row.evidence_lids);
    case "argument_map": {
      const graph = payload as z.infer<typeof ArgumentMapPayloadZ>;
      return [...graph.claims, ...graph.relations].map((item) => item.evidence_lids);
    }
  }
}

function validatePayload(type: PrivateIntentArtifactType, input: unknown): { payload: ParsedPayload; metrics: PayloadMetrics } {
  let payload: ParsedPayload;
  let recordCount: number;
  switch (type) {
    case "timeline": {
      const parsed = TimelinePayloadZ.parse(input);
      assertUniqueIds(parsed.items.map((item) => item.id), "timeline items");
      payload = parsed;
      recordCount = parsed.items.length;
      break;
    }
    case "concept_map": {
      const parsed = ConceptMapPayloadZ.parse(input);
      assertUniqueIds(parsed.nodes.map((node) => node.id), "concept nodes");
      assertGraphReferences(parsed.links, new Set(parsed.nodes.map((node) => node.id)), "concept links");
      payload = parsed;
      recordCount = parsed.nodes.length + parsed.links.length;
      break;
    }
    case "comparison_table": {
      const parsed = ComparisonTablePayloadZ.parse(input);
      payload = parsed;
      recordCount = parsed.rows.length;
      break;
    }
    case "argument_map": {
      const parsed = ArgumentMapPayloadZ.parse(input);
      assertUniqueIds(parsed.claims.map((claim) => claim.id), "argument claims");
      assertGraphReferences(parsed.relations, new Set(parsed.claims.map((claim) => claim.id)), "argument relations");
      payload = parsed;
      recordCount = parsed.claims.length + parsed.relations.length;
      break;
    }
  }
  canonicalBuildJson(payload);
  const arrays = evidenceArrays(type, payload);
  for (const lids of arrays) assertUniqueIds(lids, "record evidence LIDs");
  return {
    payload,
    metrics: {
      record_count: recordCount,
      evidence_reference_count: arrays.reduce((total, lids) => total + lids.length, 0),
    },
  };
}

function assertCandidateIdentity(candidate: IntentArtifactCandidateV1, task: IntentArtifactTaskEnvelopeV1): void {
  const expected: Array<[keyof IntentArtifactCandidateV1, unknown]> = [
    ["task_id", task.task_id],
    ["book_id", task.book_id],
    ["source_fingerprint", task.source_fingerprint],
    ["intent_id", task.intent_id],
    ["intent_digest", task.intent_digest],
    ["plan_id", task.plan_id],
    ["plan_digest", task.plan_digest],
    ["artifact_id", task.artifact.artifact_id],
    ["artifact_type", task.artifact.artifact_type],
  ];
  for (const [field, value] of expected) {
    if (candidate[field] !== value) throw new Error(`candidate ${field} does not match its current task`);
  }
}

export function acceptIntentArtifactCandidate(input: AcceptIntentArtifactCandidateInput): {
  accepted: AcceptedIntentArtifactV1;
  receipt: IntentArtifactTaskReceiptV1;
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
    throw new Error("task envelope does not match the current confirmed intent, plan, and source scope");
  }
  const candidate = CandidateZ.parse(input.candidate) as IntentArtifactCandidateV1;
  assertCandidateIdentity(candidate, expectedTask);
  assertIsoDateTime(input.accepted_at, "accepted_at");
  const { payload, metrics } = validatePayload(candidate.artifact_type, candidate.payload);
  const available = new Set(normalizeLids(input.available_lids, "available_lids"));
  const allowed = new Set(expectedTask.allowed_evidence_lids);
  for (const lids of evidenceArrays(candidate.artifact_type, payload)) {
    for (const lid of lids) {
      if (!available.has(lid)) throw new Error(`evidence must reference a current book LID: ${lid}`);
      if (!allowed.has(lid)) throw new Error(`evidence LID is outside the confirmed source scope: ${lid}`);
    }
  }
  const payloadDigest = digest(payload);
  const accepted: AcceptedIntentArtifactV1 = {
    ...candidate,
    version: "intent_artifact_accepted.v1",
    payload,
    payload_digest: payloadDigest,
    accepted_at: input.accepted_at,
  };
  const receipt: IntentArtifactTaskReceiptV1 = {
    version: "intent_artifact_task_receipt.v1",
    state: "committed",
    task_id: expectedTask.task_id,
    artifact_id: expectedTask.artifact.artifact_id,
    artifact_type: expectedTask.artifact.artifact_type,
    intent_digest: expectedTask.intent_digest,
    plan_digest: expectedTask.plan_digest,
    payload_digest: payloadDigest,
    ...metrics,
    accepted_at: input.accepted_at,
  };
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 4_096) {
    throw new Error("intent artifact receipt exceeds 4096 bytes");
  }
  return { accepted, receipt };
}

export function projectIntentArtifactTaskHandoff(
  task: IntentArtifactTaskEnvelopeV1,
  taskPath: string,
): IntentArtifactTaskHandoffV1 {
  if (!taskPath.trim()) throw new Error("intent artifact task handoff requires an opaque task path");
  return {
    version: "intent_artifact_task_handoff.v1",
    task_id: task.task_id,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    task_path: taskPath,
  };
}
