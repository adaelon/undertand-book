import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutomaticBuildTarget, BuildTargetRefV2 } from "./build-orchestrator";
import {
  BOOK_STRUCTURE_FRAGMENT_SCHEMA_VERSION_V1,
  type AnchoredText,
  type BookStructureCandidate,
  type BookStructureFragmentInputV1,
  type BookStructureFragmentObservationV1,
  type BookStructureLeafRangeV1,
  type BookStructureReductionInputV1,
  type BookStructureSpineRole,
  type BookStructureStitchArtifact,
  type BookStructureStitchFragmentInputV1,
  type BookStructureStitchPacket,
  type BookStructureStitchReductionInputV1,
  type BookStructureUnitArtifact,
  type BookStructureUnitExtractionOutput,
  type BookStructureUnitSource,
} from "./book-structure";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V1 } from "./executor-transport";
import { ExtractorContractError } from "./extractor-contract";
import {
  automaticBuildGenerationArtifactPath,
  buildSemanticArtifactEnvelopeV3,
  inspectSemanticArtifact,
  writeAutomaticBuildGenerationArtifact,
  type SemanticArtifactEnvelopeV3,
  type SemanticArtifactProvenanceV2,
} from "./semantic-artifact";
import {
  renderBookStructureFragmentModelInput,
  renderBookStructureModelInput,
  renderBookStructureReductionModelInput,
  renderBookStructureStitchFragmentModelInput,
  renderBookStructureStitchReductionModelInput,
} from "./model-input-renderer";
import {
  validateWorkUnitDescriptorV4,
  type WorkUnitDescriptorV4,
} from "./stage-work-unit";

export type BookStructureGenerationInputV1 =
  | BookStructureUnitSource
  | BookStructureFragmentInputV1
  | BookStructureReductionInputV1
  | BookStructureStitchPacket
  | BookStructureStitchFragmentInputV1
  | BookStructureStitchReductionInputV1;

export type BookStructureGenerationOutputRoleV1 =
  | "unit_artifact"
  | "unit_observation"
  | "stitch_artifact"
  | "stitch_candidate";

export interface BookStructureGenerationTaskV1 {
  version: "book_structure_generation_task.v1";
  target_ref: BuildTargetRefV2;
  policy_set_digest: string;
  descriptor: WorkUnitDescriptorV4;
  input: BookStructureGenerationInputV1;
  parent_unit_lid: string;
  parent_content_hash: string;
  source_range: BookStructureLeafRangeV1;
  allowed_evidence_lids: string[];
  output_role: BookStructureGenerationOutputRoleV1;
  task_digest: string;
}

export type BookStructureGenerationPayloadV1 =
  | BookStructureUnitArtifact
  | BookStructureFragmentObservationV1
  | BookStructureStitchArtifact
  | BookStructureCandidate;

const SHA256 = /^[a-f0-9]{64}$/u;
const SPINE_ROLES = new Set<BookStructureSpineRole>([
  "setup",
  "foundation",
  "method",
  "application",
  "case",
  "synthesis",
]);
const KEY_STOP_TYPES = new Set([
  "definition",
  "formula",
  "claim",
  "example",
  "turning_point",
  "warning",
  "summary",
]);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
    .join(",") + "}";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function assertBoundedString(value: unknown, field: string, maxBytes = 512): string {
  if (typeof value !== "string" || !value
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(field + " must be a non-empty bounded string");
  }
  return value;
}

function normalizeRange(
  value: BookStructureLeafRangeV1,
  field: string,
): BookStructureLeafRangeV1 {
  if (!Number.isSafeInteger(value.start_ordinal) || value.start_ordinal < 0
    || !Number.isSafeInteger(value.end_ordinal_exclusive)
    || value.end_ordinal_exclusive <= value.start_ordinal) {
    throw new Error(field + " must be a non-empty ordinal range");
  }
  return {
    start_ordinal: value.start_ordinal,
    end_ordinal_exclusive: value.end_ordinal_exclusive,
  };
}

export function renderBookStructureGenerationTaskInput(
  task: Pick<BookStructureGenerationTaskV1, "descriptor" | "input">,
): string {
  switch (task.descriptor.kind) {
    case "structure_unit":
      return renderBookStructureModelInput(task.input as BookStructureUnitSource);
    case "structure_fragment":
      return renderBookStructureFragmentModelInput(task.input as BookStructureFragmentInputV1);
    case "structure_reduce":
      return renderBookStructureReductionModelInput(task.input as BookStructureReductionInputV1);
    case "structure_stitch":
      return renderBookStructureModelInput(task.input as BookStructureStitchPacket);
    case "structure_stitch_fragment":
      return renderBookStructureStitchFragmentModelInput(
        task.input as BookStructureStitchFragmentInputV1,
      );
    case "structure_stitch_reduce":
      return renderBookStructureStitchReductionModelInput(
        task.input as BookStructureStitchReductionInputV1,
      );
    default:
      throw new Error("unsupported BookStructure generation work-unit kind");
  }
}

export function createBookStructureGenerationTask(input: {
  target_ref: BuildTargetRefV2;
  policy_set_digest: string;
  descriptor: WorkUnitDescriptorV4;
  generation_input: BookStructureGenerationInputV1;
  parent_unit_lid: string;
  parent_content_hash: string;
  source_range: BookStructureLeafRangeV1;
  allowed_evidence_lids: string[];
  output_role: BookStructureGenerationOutputRoleV1;
}): BookStructureGenerationTaskV1 {
  if (!SHA256.test(input.policy_set_digest)) {
    throw new Error("BookStructure task policy_set_digest must be a SHA-256 digest");
  }
  if (!SHA256.test(input.parent_content_hash)) {
    throw new Error("BookStructure task parent_content_hash must be a SHA-256 digest");
  }
  const descriptor = validateWorkUnitDescriptorV4(
    input.descriptor,
    CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
  );
  if (!sameTarget(descriptor.target, input.target_ref)
    || descriptor.stage !== "book_structure") {
    throw new Error("BookStructure generation task descriptor target or stage changed");
  }
  const parentUnitLid = assertBoundedString(input.parent_unit_lid, "parent_unit_lid");
  const allowedEvidenceLids = [...new Set(input.allowed_evidence_lids.map((lid) => (
    assertBoundedString(lid, "allowed_evidence_lid", 256)
  )))].sort();
  if (!allowedEvidenceLids.length || !allowedEvidenceLids.includes(parentUnitLid)) {
    throw new Error("BookStructure generation task must bind its parent evidence identity");
  }
  const unsigned = {
    version: "book_structure_generation_task.v1" as const,
    target_ref: input.target_ref,
    policy_set_digest: input.policy_set_digest,
    descriptor,
    input: input.generation_input,
    parent_unit_lid: parentUnitLid,
    parent_content_hash: input.parent_content_hash,
    source_range: normalizeRange(input.source_range, "source_range"),
    allowed_evidence_lids: allowedEvidenceLids,
    output_role: input.output_role,
  };
  const rendered = renderBookStructureGenerationTaskInput(unsigned);
  if (sha256(rendered) !== descriptor.input_hash) {
    throw new Error("BookStructure generation task input does not match its descriptor proof");
  }
  return { ...unsigned, task_digest: sha256(stableJson(unsigned)) };
}

function generationTaskFileName(workUnitId: string): string {
  assertBoundedString(workUnitId, "work_unit_id");
  const encoded = encodeURIComponent(workUnitId);
  return Buffer.byteLength(encoded, "utf8") <= 220
    ? encoded + ".json"
    : sha256(workUnitId) + ".json";
}

export function bookStructureGenerationTaskPath(
  target: AutomaticBuildTarget,
  policySetDigest: string,
  workUnitId: string,
): string {
  if (!SHA256.test(policySetDigest)) {
    throw new Error("BookStructure task policy_set_digest must be a SHA-256 digest");
  }
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v4",
    "tasks",
    "book_structure",
    policySetDigest,
    generationTaskFileName(workUnitId),
  );
}

function validateBookStructureGenerationTask(
  target: AutomaticBuildTarget,
  value: BookStructureGenerationTaskV1,
): BookStructureGenerationTaskV1 {
  const canonical = createBookStructureGenerationTask({
    target_ref: value.target_ref,
    policy_set_digest: value.policy_set_digest,
    descriptor: value.descriptor,
    generation_input: value.input,
    parent_unit_lid: value.parent_unit_lid,
    parent_content_hash: value.parent_content_hash,
    source_range: value.source_range,
    allowed_evidence_lids: value.allowed_evidence_lids,
    output_role: value.output_role,
  });
  if (!sameTarget(canonical.target_ref, target.target_ref)
    || canonical.task_digest !== value.task_digest
    || stableJson(canonical) !== stableJson(value)) {
    throw new Error("BookStructure generation task identity is invalid");
  }
  return canonical;
}

export function freezeBookStructureGenerationTask(
  target: AutomaticBuildTarget,
  taskValue: BookStructureGenerationTaskV1,
): string {
  const task = validateBookStructureGenerationTask(target, taskValue);
  const file = bookStructureGenerationTaskPath(
    target,
    task.policy_set_digest,
    task.descriptor.work_unit_id,
  );
  const bytes = JSON.stringify(task, null, 2) + "\n";
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code !== "EEXIST" || readFileSync(file, "utf8") !== bytes) throw error;
  }
  return file;
}

export function readBookStructureGenerationTask(
  target: AutomaticBuildTarget,
  policySetDigest: string,
  workUnitId: string,
): BookStructureGenerationTaskV1 | undefined {
  const file = bookStructureGenerationTaskPath(target, policySetDigest, workUnitId);
  if (!existsSync(file)) return undefined;
  return validateBookStructureGenerationTask(
    target,
    JSON.parse(readFileSync(file, "utf8")) as BookStructureGenerationTaskV1,
  );
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failCandidateValidation("schema_invalid", field, "object", value);
  }
  return value as Record<string, unknown>;
}

function candidateJsonPointer(field: string): string {
  if (!field || field === "/" || field.startsWith("BookStructure ")) return "/";
  const parts = field.replace(/\[(\d+)\]/gu, ".$1").split(".").filter(Boolean);
  return `/${parts.map((part) => part.replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`;
}

function boundedCandidateActual(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "string") {
    return { type: "string", utf8_bytes: Buffer.byteLength(value, "utf8") };
  }
  if (typeof value === "object") {
    return { type: "object", key_count: Object.keys(value).length };
  }
  return { type: typeof value };
}

function failCandidateValidation(
  code: "schema_invalid" | "evidence_out_of_scope",
  field: string,
  expected: string,
  actual: unknown,
): never {
  throw new ExtractorContractError({
    version: "automatic_build_extractor_diagnostic.v1",
    code,
    json_pointer: candidateJsonPointer(field),
    expected,
    actual: boundedCandidateActual(actual),
  });
}

function candidateBoundedString(value: unknown, field: string, maxBytes = 512): string {
  if (typeof value !== "string" || !value
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    failCandidateValidation(
      "schema_invalid",
      field,
      `non-empty UTF-8 string no larger than ${maxBytes} bytes`,
      value,
    );
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
  field = "/",
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    failCandidateValidation(
      "schema_invalid",
      field,
      "exact proof-bound BookStructure candidate fields",
      value,
    );
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    failCandidateValidation("schema_invalid", field, "array", value);
  }
  return value.map((item, index) => candidateBoundedString(item, `${field}[${index}]`, 256));
}

function assertEvidence(
  lids: string[],
  allowed: ReadonlySet<string>,
  field: string,
): string[] {
  const normalized = [...new Set(lids)];
  if (normalized.some((lid) => !allowed.has(lid))) {
    failCandidateValidation(
      "evidence_out_of_scope",
      field,
      "LIDs from the proof-bound BookStructure input",
      lids,
    );
  }
  return normalized;
}

function anchoredText(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
): AnchoredText {
  const record = recordValue(value, field);
  exactKeys(record, ["text", "evidence_lids"], [], field);
  return {
    text: candidateBoundedString(record.text, field + ".text", 65_536),
    evidence_lids: assertEvidence(
      stringArray(record.evidence_lids, field + ".evidence_lids"),
      allowed,
      field + ".evidence_lids",
    ),
  };
}

function keyStop(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
) {
  const record = recordValue(value, field);
  exactKeys(record, ["id", "lid", "type", "reason"], ["title"], field);
  const lid = candidateBoundedString(record.lid, field + ".lid", 256);
  if (!allowed.has(lid)) {
    failCandidateValidation(
      "evidence_out_of_scope",
      field + ".lid",
      "LID from the proof-bound BookStructure input",
      lid,
    );
  }
  const type = candidateBoundedString(record.type, field + ".type", 64);
  if (!KEY_STOP_TYPES.has(type)) {
    failCandidateValidation(
      "schema_invalid",
      field + ".type",
      "definition | formula | claim | example | turning_point | warning | summary",
      type,
    );
  }
  return {
    id: candidateBoundedString(record.id, field + ".id", 256),
    lid,
    type: type as "definition" | "formula" | "claim" | "example" | "turning_point" | "warning" | "summary",
    ...(record.title === undefined
      ? {}
      : { title: candidateBoundedString(record.title, field + ".title", 1_024) }),
    reason: anchoredText(record.reason, allowed, field + ".reason"),
  };
}

function validateUnitOutput(
  value: unknown,
  task: BookStructureGenerationTaskV1,
): BookStructureUnitExtractionOutput {
  const allowed = new Set(task.allowed_evidence_lids);
  const root = recordValue(value, "BookStructure unit output");
  exactKeys(root, ["unit_card"], [], "/");
  const card = recordValue(root.unit_card, "unit_card");
  exactKeys(card, [
    "unit_lid",
    "role",
    "summary",
    "candidate_key_stops",
    "depends_on",
    "evidence_lids",
  ], [], "unit_card");
  const unitLid = candidateBoundedString(card.unit_lid, "unit_card.unit_lid", 256);
  if (unitLid !== task.parent_unit_lid) {
    failCandidateValidation(
      "schema_invalid",
      "unit_card.unit_lid",
      "parent_unit_lid bound by the generation task",
      unitLid,
    );
  }
  const role = candidateBoundedString(card.role, "unit_card.role", 64);
  if (!SPINE_ROLES.has(role as BookStructureSpineRole)) {
    failCandidateValidation(
      "schema_invalid",
      "unit_card.role",
      "setup | foundation | method | application | case | synthesis",
      role,
    );
  }
  if (!Array.isArray(card.candidate_key_stops)) {
    failCandidateValidation(
      "schema_invalid",
      "unit_card.candidate_key_stops",
      "array",
      card.candidate_key_stops,
    );
  }
  return {
    unit_card: {
      unit_lid: unitLid,
      role: role as BookStructureSpineRole,
      summary: anchoredText(card.summary, allowed, "unit_card.summary"),
      candidate_key_stops: card.candidate_key_stops.map((stop, index) => (
        keyStop(stop, allowed, "unit_card.candidate_key_stops[" + index + "]")
      )),
      depends_on: assertEvidence(
        stringArray(card.depends_on, "unit_card.depends_on"),
        allowed,
        "unit_card.depends_on",
      ),
      evidence_lids: assertEvidence(
        stringArray(card.evidence_lids, "unit_card.evidence_lids"),
        allowed,
        "unit_card.evidence_lids",
      ),
    },
  };
}

function validateObservation(
  value: unknown,
  task: BookStructureGenerationTaskV1,
): BookStructureFragmentObservationV1 {
  const allowed = new Set(task.allowed_evidence_lids);
  const record = recordValue(value, "BookStructure fragment observation");
  exactKeys(record, [
    "version",
    "parent_unit_lid",
    "summary_fragments",
    "candidate_key_stops",
    "role_hints",
    "dependency_hints",
    "evidence_lids",
  ], [], "/");
  if (record.version !== BOOK_STRUCTURE_FRAGMENT_SCHEMA_VERSION_V1
    || record.parent_unit_lid !== task.parent_unit_lid) {
    failCandidateValidation(
      "schema_invalid",
      "/",
      "fragment schema version and parent_unit_lid bound by the generation task",
      record,
    );
  }
  if (!Array.isArray(record.summary_fragments)
    || !Array.isArray(record.candidate_key_stops)
    || !Array.isArray(record.role_hints)) {
    failCandidateValidation(
      "schema_invalid",
      "/",
      "summary_fragments, candidate_key_stops, and role_hints arrays",
      record,
    );
  }
  const roleHints = record.role_hints.map((role) => {
    const value = candidateBoundedString(role, "role_hint", 64) as BookStructureSpineRole;
    if (!SPINE_ROLES.has(value)) {
      failCandidateValidation(
        "schema_invalid",
        "role_hint",
        "setup | foundation | method | application | case | synthesis",
        value,
      );
    }
    return value;
  });
  return {
    version: BOOK_STRUCTURE_FRAGMENT_SCHEMA_VERSION_V1,
    parent_unit_lid: task.parent_unit_lid,
    summary_fragments: record.summary_fragments.map((item, index) => (
      anchoredText(item, allowed, "summary_fragments[" + index + "]")
    )),
    candidate_key_stops: record.candidate_key_stops.map((item, index) => (
      keyStop(item, allowed, "candidate_key_stops[" + index + "]")
    )),
    role_hints: [...new Set(roleHints)],
    dependency_hints: assertEvidence(
      stringArray(record.dependency_hints, "dependency_hints"),
      allowed,
      "dependency_hints",
    ),
    evidence_lids: assertEvidence(
      stringArray(record.evidence_lids, "evidence_lids"),
      allowed,
      "evidence_lids",
    ),
  };
}

function validateCandidate(
  value: unknown,
  task: BookStructureGenerationTaskV1,
): BookStructureCandidate {
  const allowed = new Set(task.allowed_evidence_lids);
  const record = recordValue(value, "BookStructure stitch candidate");
  exactKeys(record, [], ["spine", "throughlines", "key_stops"], "/");
  const spineInput = record.spine ?? [];
  const throughlineInput = record.throughlines ?? [];
  const keyStopInput = record.key_stops ?? [];
  if (!Array.isArray(spineInput)
    || !Array.isArray(throughlineInput)
    || !Array.isArray(keyStopInput)) {
    failCandidateValidation(
      "schema_invalid",
      "/",
      "spine, throughlines, and key_stops arrays",
      record,
    );
  }
  const spine = spineInput.map((item, index) => {
    const unit = recordValue(item, "spine[" + index + "]");
    exactKeys(unit, ["lid", "role", "summary", "key_stop_ids", "depends_on"], [], `spine[${index}]`);
    const lid = candidateBoundedString(unit.lid, `spine[${index}].lid`, 256);
    if (!allowed.has(lid)) {
      failCandidateValidation(
        "evidence_out_of_scope",
        `spine[${index}].lid`,
        "LID from the proof-bound BookStructure input",
        lid,
      );
    }
    const role = candidateBoundedString(
      unit.role,
      `spine[${index}].role`,
      64,
    ) as BookStructureSpineRole;
    if (!SPINE_ROLES.has(role)) {
      failCandidateValidation(
        "schema_invalid",
        `spine[${index}].role`,
        "setup | foundation | method | application | case | synthesis",
        role,
      );
    }
    return {
      lid,
      role,
      summary: anchoredText(unit.summary, allowed, "spine.summary"),
      key_stop_ids: stringArray(unit.key_stop_ids, "spine.key_stop_ids"),
      depends_on: assertEvidence(
        stringArray(unit.depends_on, "spine.depends_on"),
        allowed,
        "spine.depends_on",
      ),
    };
  });
  const throughlines = throughlineInput.map((item, index) => {
    const throughline = recordValue(item, "throughlines[" + index + "]");
    exactKeys(
      throughline,
      ["id", "name", "summary", "lids", "key_stop_ids"],
      [],
      `throughlines[${index}]`,
    );
    return {
      id: candidateBoundedString(throughline.id, `throughlines[${index}].id`, 256),
      name: candidateBoundedString(throughline.name, `throughlines[${index}].name`, 1_024),
      summary: anchoredText(throughline.summary, allowed, "throughline.summary"),
      lids: assertEvidence(
        stringArray(throughline.lids, "throughline.lids"),
        allowed,
        "throughline.lids",
      ),
      key_stop_ids: stringArray(throughline.key_stop_ids, "throughline.key_stop_ids"),
    };
  });
  const keyStops = keyStopInput.map((item, index) => (
    keyStop(item, allowed, "key_stops[" + index + "]")
  ));
  const keyStopIds = new Set(keyStops.map((stop) => stop.id));
  if (keyStopIds.size !== keyStops.length
    || [...spine, ...throughlines].some((item) => (
      item.key_stop_ids.some((id) => !keyStopIds.has(id))
    ))) {
    failCandidateValidation(
      "schema_invalid",
      "/",
      "unique key-stop ids referenced only by the candidate key-stop set",
      value,
    );
  }
  return { spine, throughlines, key_stops: keyStops };
}

function payloadForCandidate(
  task: BookStructureGenerationTaskV1,
  candidate: unknown,
): BookStructureGenerationPayloadV1 {
  if (task.output_role === "unit_observation") {
    return validateObservation(candidate, task);
  }
  if (task.output_role === "unit_artifact") {
    return {
      content_hash: task.parent_content_hash,
      output: validateUnitOutput(candidate, task),
    };
  }
  const stitchCandidate = validateCandidate(candidate, task);
  if (task.output_role === "stitch_candidate") return stitchCandidate;
  return {
    content_hash: task.parent_content_hash,
    output: stitchCandidate,
  };
}

function validateStoredPayload(
  task: BookStructureGenerationTaskV1,
  payload: unknown,
): BookStructureGenerationPayloadV1 {
  if (task.output_role === "unit_observation") {
    return validateObservation(payload, task);
  }
  if (task.output_role === "unit_artifact") {
    const artifact = recordValue(payload, "BookStructure unit artifact");
    exactKeys(artifact, ["content_hash", "output"]);
    if (artifact.content_hash !== task.parent_content_hash) {
      throw new Error("BookStructure unit artifact content hash changed");
    }
    return {
      content_hash: task.parent_content_hash,
      output: validateUnitOutput(artifact.output, task),
    };
  }
  if (task.output_role === "stitch_candidate") {
    return validateCandidate(payload, task);
  }
  const artifact = recordValue(payload, "BookStructure stitch artifact");
  exactKeys(artifact, ["content_hash", "output"]);
  if (artifact.content_hash !== task.parent_content_hash) {
    throw new Error("BookStructure stitch artifact content hash changed");
  }
  return {
    content_hash: task.parent_content_hash,
    output: validateCandidate(artifact.output, task),
  };
}

export function writeBookStructureGenerationCandidate(input: {
  target: AutomaticBuildTarget;
  task: BookStructureGenerationTaskV1;
  candidate: unknown;
  provenance: SemanticArtifactProvenanceV2;
}): SemanticArtifactEnvelopeV3<BookStructureGenerationPayloadV1> {
  const task = validateBookStructureGenerationTask(input.target, input.task);
  const payload = payloadForCandidate(task, input.candidate);
  const envelope = buildSemanticArtifactEnvelopeV3({
    target: task.target_ref,
    stage: "book_structure",
    work_unit_id: task.descriptor.work_unit_id,
    input_hash: task.descriptor.input_hash,
    proof_digest: task.descriptor.execution_budget_proof.proof_digest,
    policy_set_digest: task.policy_set_digest,
    policy_fingerprint: task.descriptor.policy_fingerprint,
    provenance: input.provenance,
    payload,
  });
  writeAutomaticBuildGenerationArtifact(input.target, envelope);
  return envelope;
}

export function readBookStructureGenerationArtifact(
  target: AutomaticBuildTarget,
  taskValue: BookStructureGenerationTaskV1,
): SemanticArtifactEnvelopeV3<BookStructureGenerationPayloadV1> | undefined {
  const task = validateBookStructureGenerationTask(target, taskValue);
  const file = automaticBuildGenerationArtifactPath(
    target,
    "book_structure",
    task.policy_set_digest,
    task.descriptor.work_unit_id,
  );
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const inspected = inspectSemanticArtifact<BookStructureGenerationPayloadV1>(
    value as BookStructureGenerationPayloadV1,
    {
    target: task.target_ref,
    stage: "book_structure",
    work_unit_id: task.descriptor.work_unit_id,
    input_hash: task.descriptor.input_hash,
    proof_digest: task.descriptor.execution_budget_proof.proof_digest,
    policy_set_digest: task.policy_set_digest,
    policy_fingerprint: task.descriptor.policy_fingerprint,
    },
  );
  if (inspected.format !== "v3" || !inspected.policy_fresh) {
    throw new Error("BookStructure generation artifact identity is stale");
  }
  const payload = validateStoredPayload(task, inspected.payload);
  return { ...(value as SemanticArtifactEnvelopeV3<BookStructureGenerationPayloadV1>), payload };
}
