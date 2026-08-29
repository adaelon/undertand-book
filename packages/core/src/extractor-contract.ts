import { createHash } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import { canonicalAutomaticBuildJson } from "./automatic-build-protocol";
import { METADATA_SOURCES, type PaperMetadataExtractionOutput } from "./paper-metadata";
import { PAPER_TERM_TYPES, type PaperLexiconExtractionOutput } from "./paper-lexicon";
import type { ProfileSidecarExtractionOutput } from "./profile-sidecar-build";

export type ContractedExtractorStage = "paper_metadata" | "paper_lexicon" | "profile_sidecar";

export const EXTRACTOR_CONTRACT_SCHEMA_VERSIONS = {
  paper_metadata: "paper_metadata_output.v2",
  paper_lexicon: "paper_lexicon_output.v2",
  profile_sidecar: "profile_sidecar_output.v2",
} as const;

export interface ExtractorContractContext {
  allowed_evidence_lids: string[];
  formula_lids?: string[];
}

export interface ExtractorFieldContractV1 {
  field: string;
  required: boolean;
  nullable: boolean;
  enum_values?: readonly string[];
  min_length?: number;
  max_length?: number;
  min_value?: number;
  max_value?: number;
  profile_hints?: Readonly<Record<string, readonly string[]>>;
}

export const AUTOMATIC_BUILD_FAILURE_CATEGORIES = [
  "schema",
  "evidence",
  "provider",
  "executor",
  "budget",
  "internal",
] as const;

export type AutomaticBuildFailureCategory = typeof AUTOMATIC_BUILD_FAILURE_CATEGORIES[number];

export const AUTOMATIC_BUILD_FAILURE_PHASES = [
  "input_delivery",
  "generation",
  "candidate_sink",
  "artifact_writer",
] as const;

export type AutomaticBuildFailurePhase = typeof AUTOMATIC_BUILD_FAILURE_PHASES[number];

export type AutomaticBuildRequiredRecovery =
  | "publish_new_policy_scope"
  | "change_evidence_or_policy_scope"
  | "replan_budget"
  | "confirm_transient_retry"
  | "recover_executor"
  | "forward_fix"
  | "inspect_legacy_failure";

export interface AutomaticBuildFailureDiagnosticLegacyV2 {
  version: "automatic_build_failure_diagnostic.v2";
  category: AutomaticBuildFailureCategory;
  code: string;
  json_pointer?: string;
  expected?: string;
  diagnostic_digest: string;
}

export interface AutomaticBuildFailureDiagnosticV3 {
  version: "automatic_build_failure_diagnostic.v3";
  category: AutomaticBuildFailureCategory;
  code: string;
  phase: AutomaticBuildFailurePhase;
  json_pointer?: string;
  expected?: string;
  reported_code_digest?: string;
  diagnostic_digest: string;
}

/**
 * Compatibility name retained for callers compiled against the original V2-only
 * surface. Readers accept both the immutable V2 record and the phase-aware V3
 * successor; new source-specific writers explicitly create V3.
 */
export type AutomaticBuildFailureDiagnosticV2 =
  | AutomaticBuildFailureDiagnosticLegacyV2
  | AutomaticBuildFailureDiagnosticV3;

export type AutomaticBuildFailureDiagnostic = AutomaticBuildFailureDiagnosticV2;

export interface AutomaticBuildFailureDiagnosticInputV2 {
  category: AutomaticBuildFailureCategory;
  code: string;
  json_pointer?: string;
  expected?: string;
}

export interface AutomaticBuildFailureDiagnosticInputV3
  extends AutomaticBuildFailureDiagnosticInputV2 {
  phase: AutomaticBuildFailurePhase;
  reported_code_digest?: string;
}

export interface AutomaticBuildFailurePhaseFacts {
  writer_started?: boolean;
  output_bytes?: number;
}

const AUTOMATIC_BUILD_FAILURE_CODES: Record<AutomaticBuildFailureCategory, ReadonlySet<string>> = {
  schema: new Set([
    "schema_invalid",
    "semantic_invalid",
    "semantic_output_invalid",
  ]),
  evidence: new Set([
    "evidence_required",
    "evidence_out_of_scope",
    "defined_at_not_occurrence",
    "relation_evidence_incomplete",
    "formula_lid_not_eligible",
    "composition_source_mismatch",
  ]),
  provider: new Set([
    "provider_unavailable",
    "provider_timeout",
    "provider_rate_limited",
    "provider_overloaded",
    "provider_failed",
  ]),
  executor: new Set([
    "executor_failed",
    "executor_instability",
    "executor_lost",
    "command_start_failed",
    "command_nonzero_exit",
    "harness_cancelled",
    "private_exception",
    "legacy_handoff_missing",
    "semantic_input_transport_truncated",
    "semantic_input_delivery_interrupted",
    "candidate_sink_unavailable",
  ]),
  budget: new Set([
    "budget_proof_invalid",
    "budget_exceeded",
    "input_transport_budget_exceeded",
    "low_confidence_wall_budget",
    "wall_budget_exceeded",
  ]),
  internal: new Set([
    "writer_failed",
    "legacy_unclassified",
    "multiple_failure_causes",
    "internal_error",
  ]),
};

const TRANSIENT_PROVIDER_FAILURE_CODES = new Set([
  "provider_unavailable",
  "provider_timeout",
  "provider_rate_limited",
  "provider_overloaded",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FAILURE_CODE_BYTES = 128;
const MAX_FAILURE_POINTER_BYTES = 512;
const MAX_FAILURE_EXPECTED_BYTES = 512;
const EXTRACTOR_ERROR_PREFIX = "ExtractorContractError: ";
const MAX_EXTRACTOR_ERROR_TRANSPORT_BYTES = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedFailureString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function summarizeFailureString(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let summary = value;
  while (summary && Buffer.byteLength(`${summary}...`, "utf8") > maxBytes) {
    summary = summary.slice(0, -1);
  }
  return `${summary}...`;
}

function failureCategoryForCode(code: string): AutomaticBuildFailureCategory | undefined {
  return AUTOMATIC_BUILD_FAILURE_CATEGORIES.find((category) => (
    AUTOMATIC_BUILD_FAILURE_CODES[category].has(code)
  ));
}

export function createAutomaticBuildFailureDiagnostic(
  input: AutomaticBuildFailureDiagnosticInputV2,
): AutomaticBuildFailureDiagnosticLegacyV2 {
  if (!AUTOMATIC_BUILD_FAILURE_CATEGORIES.includes(input.category)) {
    throw new Error("automatic build failure category is invalid");
  }
  const code = boundedFailureString(input.code, "automatic build failure code", MAX_FAILURE_CODE_BYTES);
  if (!AUTOMATIC_BUILD_FAILURE_CODES[input.category].has(code)) {
    throw new Error(`automatic build failure code is not allowlisted for ${input.category}`);
  }
  const jsonPointer = input.json_pointer === undefined
    ? undefined
    : boundedFailureString(input.json_pointer, "automatic build failure json_pointer", MAX_FAILURE_POINTER_BYTES);
  if (jsonPointer !== undefined && !jsonPointer.startsWith("/")) {
    throw new Error("automatic build failure json_pointer must be an absolute JSON pointer");
  }
  const expected = input.expected === undefined
    ? undefined
    : boundedFailureString(input.expected, "automatic build failure expected", MAX_FAILURE_EXPECTED_BYTES);
  const identity = {
    version: "automatic_build_failure_diagnostic.v2" as const,
    category: input.category,
    code,
    ...(jsonPointer === undefined ? {} : { json_pointer: jsonPointer }),
    ...(expected === undefined ? {} : { expected }),
  };
  return {
    ...identity,
    diagnostic_digest: createHash("sha256")
      .update(canonicalAutomaticBuildJson(identity))
      .digest("hex"),
  };
}

function validateFailurePhase(
  category: AutomaticBuildFailureCategory,
  code: string,
  phase: AutomaticBuildFailurePhase,
): void {
  if (code === "writer_failed" && phase !== "artifact_writer") {
    throw new Error("writer_failed requires the artifact_writer failure phase");
  }
  if (code === "candidate_sink_unavailable" && phase !== "candidate_sink") {
    throw new Error("candidate_sink_unavailable requires the candidate_sink failure phase");
  }
  if ((code === "semantic_input_transport_truncated"
    || code === "semantic_input_delivery_interrupted"
    || code === "input_transport_budget_exceeded")
    && phase !== "input_delivery") {
    throw new Error(`${code} requires the input_delivery failure phase`);
  }
  if ((category === "schema" || category === "evidence")
    && phase !== "generation" && phase !== "artifact_writer") {
    throw new Error(`${category} failures require generation or artifact_writer phase`);
  }
  if (category === "provider" && phase !== "generation") {
    throw new Error("provider failures require the generation failure phase");
  }
  if (category === "budget" && phase !== "input_delivery") {
    throw new Error("budget failure diagnostics require the input_delivery failure phase");
  }
  if (category === "executor" && phase === "artifact_writer") {
    throw new Error("executor failures cannot claim the artifact_writer failure phase");
  }
  if (category === "internal" && code === "legacy_unclassified") {
    throw new Error("legacy_unclassified remains a V2 read-only diagnostic");
  }
}

function validateFailurePhaseFacts(
  diagnostic: AutomaticBuildFailureDiagnosticV3,
  facts: AutomaticBuildFailurePhaseFacts | undefined,
): void {
  if (!facts) return;
  if (facts.writer_started !== undefined && typeof facts.writer_started !== "boolean") {
    throw new Error("automatic build writer_started phase fact is invalid");
  }
  if (facts.output_bytes !== undefined
    && (!Number.isSafeInteger(facts.output_bytes) || facts.output_bytes < 0)) {
    throw new Error("automatic build output_bytes phase fact is invalid");
  }
  if (diagnostic.phase === "artifact_writer" && facts.writer_started !== true) {
    throw new Error("artifact_writer diagnostic requires a persisted writer-start phase fact");
  }
  if (diagnostic.phase !== "artifact_writer" && facts.writer_started === true) {
    throw new Error(`${diagnostic.phase} diagnostic conflicts with the writer-start phase fact`);
  }
}

export function createAutomaticBuildFailureDiagnosticV3(
  input: AutomaticBuildFailureDiagnosticInputV3,
): AutomaticBuildFailureDiagnosticV3 {
  if (!AUTOMATIC_BUILD_FAILURE_CATEGORIES.includes(input.category)) {
    throw new Error("automatic build failure category is invalid");
  }
  if (!AUTOMATIC_BUILD_FAILURE_PHASES.includes(input.phase)) {
    throw new Error("automatic build failure phase is invalid");
  }
  const code = boundedFailureString(input.code, "automatic build failure code", MAX_FAILURE_CODE_BYTES);
  if (!AUTOMATIC_BUILD_FAILURE_CODES[input.category].has(code)) {
    throw new Error(`automatic build failure code is not allowlisted for ${input.category}`);
  }
  validateFailurePhase(input.category, code, input.phase);
  const jsonPointer = input.json_pointer === undefined
    ? undefined
    : boundedFailureString(input.json_pointer, "automatic build failure json_pointer", MAX_FAILURE_POINTER_BYTES);
  if (jsonPointer !== undefined && !jsonPointer.startsWith("/")) {
    throw new Error("automatic build failure json_pointer must be an absolute JSON pointer");
  }
  const expected = input.expected === undefined
    ? undefined
    : boundedFailureString(input.expected, "automatic build failure expected", MAX_FAILURE_EXPECTED_BYTES);
  const reportedCodeDigest = input.reported_code_digest;
  if (reportedCodeDigest !== undefined
    && (!SHA256.test(reportedCodeDigest) || input.category !== "executor" || code !== "executor_failed")) {
    throw new Error("reported_code_digest is only valid for executor/executor_failed");
  }
  const identity = {
    version: "automatic_build_failure_diagnostic.v3" as const,
    category: input.category,
    code,
    phase: input.phase,
    ...(jsonPointer === undefined ? {} : { json_pointer: jsonPointer }),
    ...(expected === undefined ? {} : { expected }),
    ...(reportedCodeDigest === undefined ? {} : { reported_code_digest: reportedCodeDigest }),
  };
  return {
    ...identity,
    diagnostic_digest: createHash("sha256")
      .update(canonicalAutomaticBuildJson(identity))
      .digest("hex"),
  };
}

function validateAutomaticBuildFailureDiagnosticV2(
  value: Record<string, unknown>,
): AutomaticBuildFailureDiagnosticLegacyV2 {
  const allowed = new Set([
    "version",
    "category",
    "code",
    "json_pointer",
    "expected",
    "diagnostic_digest",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || value.version !== "automatic_build_failure_diagnostic.v2"
    || typeof value.category !== "string"
    || !AUTOMATIC_BUILD_FAILURE_CATEGORIES.includes(value.category as AutomaticBuildFailureCategory)
    || typeof value.code !== "string"
    || typeof value.diagnostic_digest !== "string"
    || !SHA256.test(value.diagnostic_digest)) {
    throw new Error("automatic build failure diagnostic identity is invalid");
  }
  const canonical = createAutomaticBuildFailureDiagnostic({
    category: value.category as AutomaticBuildFailureCategory,
    code: value.code,
    ...(value.json_pointer === undefined ? {} : { json_pointer: value.json_pointer as string }),
    ...(value.expected === undefined ? {} : { expected: value.expected as string }),
  });
  if (canonical.diagnostic_digest !== value.diagnostic_digest) {
    throw new Error("automatic build failure diagnostic digest mismatch");
  }
  return canonical;
}

function validateAutomaticBuildFailureDiagnosticV3(
  value: Record<string, unknown>,
  facts?: AutomaticBuildFailurePhaseFacts,
): AutomaticBuildFailureDiagnosticV3 {
  const allowed = new Set([
    "version",
    "category",
    "code",
    "phase",
    "json_pointer",
    "expected",
    "reported_code_digest",
    "diagnostic_digest",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || value.version !== "automatic_build_failure_diagnostic.v3"
    || typeof value.category !== "string"
    || !AUTOMATIC_BUILD_FAILURE_CATEGORIES.includes(value.category as AutomaticBuildFailureCategory)
    || typeof value.code !== "string"
    || typeof value.phase !== "string"
    || !AUTOMATIC_BUILD_FAILURE_PHASES.includes(value.phase as AutomaticBuildFailurePhase)
    || typeof value.diagnostic_digest !== "string"
    || !SHA256.test(value.diagnostic_digest)) {
    throw new Error("automatic build failure diagnostic V3 identity is invalid");
  }
  const canonical = createAutomaticBuildFailureDiagnosticV3({
    category: value.category as AutomaticBuildFailureCategory,
    code: value.code,
    phase: value.phase as AutomaticBuildFailurePhase,
    ...(value.json_pointer === undefined ? {} : { json_pointer: value.json_pointer as string }),
    ...(value.expected === undefined ? {} : { expected: value.expected as string }),
    ...(value.reported_code_digest === undefined
      ? {}
      : { reported_code_digest: value.reported_code_digest as string }),
  });
  if (canonical.diagnostic_digest !== value.diagnostic_digest) {
    throw new Error("automatic build failure diagnostic digest mismatch");
  }
  validateFailurePhaseFacts(canonical, facts);
  return canonical;
}

export function validateAutomaticBuildFailureDiagnostic(
  value: unknown,
  facts?: AutomaticBuildFailurePhaseFacts,
): AutomaticBuildFailureDiagnosticV2 {
  if (!isRecord(value)) throw new Error("automatic build failure diagnostic must be an object");
  if (value.version === "automatic_build_failure_diagnostic.v2") {
    return validateAutomaticBuildFailureDiagnosticV2(value);
  }
  if (value.version === "automatic_build_failure_diagnostic.v3") {
    return validateAutomaticBuildFailureDiagnosticV3(value, facts);
  }
  throw new Error("automatic build failure diagnostic version is unsupported");
}

export function isAutomaticBuildFailureDiagnosticV3(
  diagnostic: AutomaticBuildFailureDiagnosticV2,
): diagnostic is AutomaticBuildFailureDiagnosticV3 {
  return diagnostic.version === "automatic_build_failure_diagnostic.v3";
}

export function automaticBuildFailureDiagnosticFromCode(
  code: unknown,
): AutomaticBuildFailureDiagnosticV2 {
  if (typeof code === "string") {
    const category = failureCategoryForCode(code);
    if (category) return createAutomaticBuildFailureDiagnostic({ category, code });
  }
  return createAutomaticBuildFailureDiagnostic({ category: "internal", code: "writer_failed" });
}

export function automaticBuildFailureDiagnosticFromExecutorReport(
  reportedCode: unknown,
  phase: Exclude<AutomaticBuildFailurePhase, "artifact_writer"> = "generation",
): AutomaticBuildFailureDiagnosticV3 {
  if (typeof reportedCode === "string") {
    const category = failureCategoryForCode(reportedCode);
    if (category && category !== "internal") {
      try {
        return createAutomaticBuildFailureDiagnosticV3({
          category,
          code: reportedCode,
          phase,
        });
      } catch {
        // A known code reported from an impossible source/phase remains an
        // executor report. It must never borrow another source's semantics.
      }
    }
  }
  return createAutomaticBuildFailureDiagnosticV3({
    category: "executor",
    code: "executor_failed",
    phase,
    ...(typeof reportedCode === "string"
      ? { reported_code_digest: createHash("sha256").update(reportedCode).digest("hex") }
      : {}),
  });
}

export function automaticBuildFailureDiagnosticFromCandidateSinkError(
  _error: unknown,
): AutomaticBuildFailureDiagnosticV3 {
  return createAutomaticBuildFailureDiagnosticV3({
    category: "executor",
    code: "candidate_sink_unavailable",
    phase: "candidate_sink",
  });
}

export function legacyAutomaticBuildFailureDiagnostic(): AutomaticBuildFailureDiagnosticV2 {
  return createAutomaticBuildFailureDiagnostic({ category: "internal", code: "legacy_unclassified" });
}

export function requiredRecoveryForAutomaticBuildFailure(
  diagnostic: AutomaticBuildFailureDiagnosticV2,
): AutomaticBuildRequiredRecovery {
  const value = validateAutomaticBuildFailureDiagnostic(diagnostic);
  switch (value.category) {
    case "schema": return "publish_new_policy_scope";
    case "evidence": return "change_evidence_or_policy_scope";
    case "budget": return "replan_budget";
    case "executor": return "recover_executor";
    case "provider": return TRANSIENT_PROVIDER_FAILURE_CODES.has(value.code)
      ? "confirm_transient_retry"
      : "forward_fix";
    case "internal": return value.code === "legacy_unclassified"
      ? "inspect_legacy_failure"
      : "forward_fix";
  }
}

export function isAutomaticBuildTransientProviderFailure(
  diagnostic: AutomaticBuildFailureDiagnosticV2,
): boolean {
  const value = validateAutomaticBuildFailureDiagnostic(diagnostic);
  return value.category === "provider" && TRANSIENT_PROVIDER_FAILURE_CODES.has(value.code);
}

export interface ExtractorContractDiagnosticV1 {
  version: "automatic_build_extractor_diagnostic.v1";
  code: string;
  json_pointer: string;
  expected: string;
  actual: unknown;
  evidence_violation?: {
    kind: "required" | "out_of_scope" | "cross_field";
    offending_lids?: string[];
    allowed_lids?: string[];
    detail?: string;
  };
}

export class ExtractorContractError extends Error {
  readonly diagnostic: ExtractorContractDiagnosticV1;
  readonly failure_diagnostic: AutomaticBuildFailureDiagnosticV2;

  constructor(diagnostic: ExtractorContractDiagnosticV1) {
    super(JSON.stringify(diagnostic));
    this.name = "ExtractorContractError";
    this.diagnostic = diagnostic;
    this.failure_diagnostic = automaticBuildFailureDiagnosticFromExtractorDiagnostic(diagnostic);
  }
}

function automaticBuildFailureDiagnosticFromExtractorDiagnostic(
  diagnostic: ExtractorContractDiagnosticV1,
): AutomaticBuildFailureDiagnosticV2 {
  const category = failureCategoryForCode(diagnostic.code);
  if (category !== "schema" && category !== "evidence") {
    return createAutomaticBuildFailureDiagnostic({ category: "internal", code: "writer_failed" });
  }
  return createAutomaticBuildFailureDiagnostic({
    category,
    code: diagnostic.code,
    json_pointer: summarizeFailureString(diagnostic.json_pointer, MAX_FAILURE_POINTER_BYTES),
    expected: summarizeFailureString(diagnostic.expected, MAX_FAILURE_EXPECTED_BYTES),
  });
}

export function automaticBuildFailureDiagnosticFromError(
  error: unknown,
): AutomaticBuildFailureDiagnosticV2 {
  if (error instanceof ExtractorContractError) return error.failure_diagnostic;
  if (isRecord(error) && "failure_diagnostic" in error) {
    try {
      return validateAutomaticBuildFailureDiagnostic(error.failure_diagnostic);
    } catch {
      // Unknown or forged error objects remain an internal writer failure.
    }
  }
  return createAutomaticBuildFailureDiagnostic({ category: "internal", code: "writer_failed" });
}

function automaticBuildFailureDiagnosticV3FromExtractorDiagnostic(
  diagnostic: ExtractorContractDiagnosticV1,
): AutomaticBuildFailureDiagnosticV3 | undefined {
  const category = failureCategoryForCode(diagnostic.code);
  if (category !== "schema" && category !== "evidence") return undefined;
  return createAutomaticBuildFailureDiagnosticV3({
    category,
    code: diagnostic.code,
    phase: "artifact_writer",
    json_pointer: summarizeFailureString(diagnostic.json_pointer, MAX_FAILURE_POINTER_BYTES),
    expected: summarizeFailureString(diagnostic.expected, MAX_FAILURE_EXPECTED_BYTES),
  });
}

export function automaticBuildFailureDiagnosticFromWriterError(
  error: unknown,
  facts: { writer_started: boolean },
): AutomaticBuildFailureDiagnosticV3 {
  if (facts.writer_started !== true) {
    throw new Error("writer failure mapping requires a persisted writer-start fact");
  }
  if (error instanceof ExtractorContractError) {
    const extractor = automaticBuildFailureDiagnosticV3FromExtractorDiagnostic(error.diagnostic);
    if (extractor) return extractor;
  }
  if (isRecord(error) && "failure_diagnostic" in error) {
    try {
      const existing = validateAutomaticBuildFailureDiagnostic(error.failure_diagnostic);
      if (existing.version === "automatic_build_failure_diagnostic.v3"
        && existing.phase === "artifact_writer") {
        validateFailurePhaseFacts(existing, facts);
        return existing;
      }
      if (existing.category === "schema" || existing.category === "evidence") {
        return createAutomaticBuildFailureDiagnosticV3({
          category: existing.category,
          code: existing.code,
          phase: "artifact_writer",
          ...(existing.json_pointer === undefined ? {} : { json_pointer: existing.json_pointer }),
          ...(existing.expected === undefined ? {} : { expected: existing.expected }),
        });
      }
    } catch {
      // Forged or source-incompatible diagnostics cannot choose the writer's
      // durable classification.
    }
  }
  return createAutomaticBuildFailureDiagnosticV3({
    category: "internal",
    code: "writer_failed",
    phase: "artifact_writer",
  });
}

export function parseExtractorContractErrorFromStderr(stderr: unknown): ExtractorContractError | undefined {
  if (typeof stderr !== "string") return undefined;
  const line = stderr.split(/\r?\n/u).find((candidate) => candidate.startsWith(EXTRACTOR_ERROR_PREFIX));
  if (!line) return undefined;
  const payload = line.slice(EXTRACTOR_ERROR_PREFIX.length);
  if (!payload || Buffer.byteLength(payload, "utf8") > MAX_EXTRACTOR_ERROR_TRANSPORT_BYTES) return undefined;
  try {
    const value = JSON.parse(payload) as unknown;
    if (!isRecord(value)
      || value.version !== "automatic_build_extractor_diagnostic.v1"
      || typeof value.code !== "string"
      || typeof value.json_pointer !== "string"
      || typeof value.expected !== "string") return undefined;
    const category = failureCategoryForCode(value.code);
    if (category !== "schema" && category !== "evidence") return undefined;
    return new ExtractorContractError(value as unknown as ExtractorContractDiagnosticV1);
  } catch {
    return undefined;
  }
}

const nonEmptyString = z.string().min(1);
const lidArray = z.array(nonEmptyString).min(1);
const metadataSource = z.enum(METADATA_SOURCES);
const metadataField = <T extends ZodTypeAny>(value: T) => z.object({
  value,
  source: metadataSource,
  evidence_lids: lidArray.optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

const author = z.object({ name: nonEmptyString, raw: z.string().optional() }).strict();
const reference = z.object({ raw: nonEmptyString, identifiers: z.record(z.string()).optional() }).strict();
const metadataFieldsSchema = z.object({
  title: metadataField(nonEmptyString).optional(),
  authors: metadataField(z.array(author)).optional(),
  affiliations: metadataField(z.array(nonEmptyString)).optional(),
  venue: metadataField(nonEmptyString).optional(),
  year: metadataField(z.number().int()).optional(),
  identifiers: z.object({
    doi: metadataField(nonEmptyString).optional(),
    arxiv: metadataField(nonEmptyString).optional(),
    url: metadataField(nonEmptyString).optional(),
  }).strict().optional(),
  keywords: metadataField(z.array(nonEmptyString)).optional(),
  field_labels: metadataField(z.array(nonEmptyString)).optional(),
  references: metadataField(z.array(reference)).optional(),
  datasets: metadataField(z.array(nonEmptyString)).optional(),
  code_links: metadataField(z.array(nonEmptyString)).optional(),
  funding: metadataField(z.array(nonEmptyString)).optional(),
}).strict();

const lexiconEntry = z.object({
  term: nonEmptyString,
  term_type: z.enum(PAPER_TERM_TYPES),
  occurrences_lids: lidArray,
  defined_at_lid: nonEmptyString.optional(),
  aliases: z.array(nonEmptyString).optional(),
  acronym_expansion: nonEmptyString.optional(),
  chinese_gloss: nonEmptyString.optional(),
}).strict();
const lexiconOutput = z.union([
  z.object({ entries: z.array(lexiconEntry) }).strict(),
  z.object({ paper_lexicon: z.object({ entries: z.array(lexiconEntry) }).strict() }).strict(),
]);

const discourseModes = ["informative", "argumentative", "procedural", "descriptive", "meta"] as const;
const localFunctions = [
  "definition", "description", "classification", "explanation", "cause", "effect", "example", "counterexample",
  "comparison", "contrast", "procedure_step", "application", "warning", "limitation", "question", "answer",
  "summary", "research_question", "hypothesis", "related_work", "method_description", "experiment_setup",
  "evidence_report", "result_interpretation", "future_work", "transition",
] as const;
const rhetoricalMoves = [
  "chapter_setup", "problem_framing", "prerequisite", "main_point", "concept_elaboration", "worked_example",
  "case_analysis", "argument_support", "objection", "resolution", "recap", "abstract_summary",
  "related_work_positioning", "method_setup", "experiment_report", "result_claim", "limitation_acknowledgement",
  "future_work_projection", "bridge_to_next",
] as const;
const relationTypes = [
  "elaborates", "exemplifies", "explains", "causes", "results_in", "contrasts", "concedes", "supports",
  "rebuts", "summarizes", "restates", "prepares", "continues", "answers", "depends_on",
] as const;

export const PROFILE_SIDECAR_FIELD_CONTRACTS_V1 = [
  {
    field: "mode",
    required: true,
    nullable: false,
    enum_values: discourseModes,
  },
  {
    field: "local_function",
    required: false,
    nullable: false,
    enum_values: localFunctions,
    profile_hints: {
      paper: [
        "research_question",
        "hypothesis",
        "related_work",
        "method_description",
        "experiment_setup",
        "evidence_report",
        "result_interpretation",
        "limitation",
        "future_work",
      ],
    },
  },
  {
    field: "rhetorical_move",
    required: false,
    nullable: false,
    enum_values: rhetoricalMoves,
    profile_hints: {
      paper: [
        "problem_framing",
        "related_work_positioning",
        "method_setup",
        "experiment_report",
        "result_claim",
        "limitation_acknowledgement",
        "future_work_projection",
      ],
    },
  },
  {
    field: "local_summary",
    required: false,
    nullable: false,
    min_length: 1,
    max_length: 200,
  },
  {
    field: "relation.type",
    required: true,
    nullable: false,
    enum_values: relationTypes,
  },
  {
    field: "relation.family",
    required: false,
    nullable: false,
    enum_values: ["temporal", "contingency", "comparison", "expansion"],
  },
  {
    field: "relation.direction",
    required: true,
    nullable: false,
    enum_values: ["backward", "forward", "lateral"],
  },
  {
    field: "relation.confidence",
    required: true,
    nullable: false,
    min_value: 0,
    max_value: 1,
  },
] as const satisfies readonly ExtractorFieldContractV1[];

function validateExtractorFieldContract(contract: ExtractorFieldContractV1): void {
  if (!contract.field || contract.field.includes("\0")) {
    throw new Error("extractor field contract field is invalid");
  }
  if (contract.enum_values !== undefined) {
    if (!contract.enum_values.length
      || contract.enum_values.some((value) => !value || value.includes("\0"))
      || new Set(contract.enum_values).size !== contract.enum_values.length) {
      throw new Error(`extractor field contract enum is invalid: ${contract.field}`);
    }
  }
  const stringBounds = contract.min_length !== undefined || contract.max_length !== undefined;
  const numberBounds = contract.min_value !== undefined || contract.max_value !== undefined;
  if (stringBounds && (numberBounds || contract.enum_values !== undefined)) {
    throw new Error(`extractor field contract mixes incompatible constraints: ${contract.field}`);
  }
  if (contract.min_length !== undefined
    && (!Number.isSafeInteger(contract.min_length) || contract.min_length < 0)) {
    throw new Error(`extractor field contract min_length is invalid: ${contract.field}`);
  }
  if (contract.max_length !== undefined
    && (!Number.isSafeInteger(contract.max_length) || contract.max_length < 0)) {
    throw new Error(`extractor field contract max_length is invalid: ${contract.field}`);
  }
  if (contract.min_length !== undefined && contract.max_length !== undefined
    && contract.min_length > contract.max_length) {
    throw new Error(`extractor field contract length bounds are invalid: ${contract.field}`);
  }
  if (contract.min_value !== undefined && !Number.isFinite(contract.min_value)) {
    throw new Error(`extractor field contract min_value is invalid: ${contract.field}`);
  }
  if (contract.max_value !== undefined && !Number.isFinite(contract.max_value)) {
    throw new Error(`extractor field contract max_value is invalid: ${contract.field}`);
  }
  if (contract.min_value !== undefined && contract.max_value !== undefined
    && contract.min_value > contract.max_value) {
    throw new Error(`extractor field contract numeric bounds are invalid: ${contract.field}`);
  }
  if (contract.profile_hints !== undefined) {
    if (contract.enum_values === undefined) {
      throw new Error(`extractor field contract hints require an enum: ${contract.field}`);
    }
    const members = new Set(contract.enum_values);
    for (const [profile, hints] of Object.entries(contract.profile_hints)) {
      if (!profile || !hints.length || hints.some((hint) => !members.has(hint))) {
        throw new Error(`extractor field contract profile hints are invalid: ${contract.field}/${profile}`);
      }
    }
  }
}

function extractorFieldSchema(contract: ExtractorFieldContractV1): ZodTypeAny {
  validateExtractorFieldContract(contract);
  let schema: ZodTypeAny;
  if (contract.enum_values !== undefined) {
    schema = z.enum([
      contract.enum_values[0]!,
      ...contract.enum_values.slice(1),
    ] as [string, ...string[]]);
  } else if (contract.min_value !== undefined || contract.max_value !== undefined) {
    let numberSchema = z.number();
    if (contract.min_value !== undefined) numberSchema = numberSchema.min(contract.min_value);
    if (contract.max_value !== undefined) numberSchema = numberSchema.max(contract.max_value);
    schema = numberSchema;
  } else {
    let stringSchema = z.string();
    if (contract.min_length !== undefined) stringSchema = stringSchema.min(contract.min_length);
    if (contract.max_length !== undefined) stringSchema = stringSchema.max(contract.max_length);
    schema = stringSchema;
  }
  if (contract.nullable) schema = schema.nullable();
  if (!contract.required) schema = schema.optional();
  return schema;
}

const profileSidecarFieldContracts: ReadonlyMap<string, ExtractorFieldContractV1> = new Map(
  PROFILE_SIDECAR_FIELD_CONTRACTS_V1.map((contract) => [contract.field, contract]),
);

function profileSidecarFieldSchema(field: string): ZodTypeAny {
  const contract = profileSidecarFieldContracts.get(field);
  if (!contract) throw new Error(`profile sidecar field contract is missing: ${field}`);
  return extractorFieldSchema(contract);
}

const relation = z.object({
  target_lid: nonEmptyString,
  type: profileSidecarFieldSchema("relation.type"),
  family: profileSidecarFieldSchema("relation.family"),
  direction: profileSidecarFieldSchema("relation.direction"),
  confidence: profileSidecarFieldSchema("relation.confidence"),
  evidence_lids: lidArray,
}).strict();
const discourseItem = z.object({
  lid: nonEmptyString,
  mode: profileSidecarFieldSchema("mode"),
  local_function: profileSidecarFieldSchema("local_function"),
  rhetorical_move: profileSidecarFieldSchema("rhetorical_move"),
  local_summary: profileSidecarFieldSchema("local_summary"),
  relations: z.array(relation),
}).strict();
const formulaParameter = z.object({
  symbol: nonEmptyString,
  label: z.string().nullable(),
  meaning: nonEmptyString,
  unit: z.string().nullable(),
  domain: z.string().nullable(),
  evidence_lids: lidArray,
}).strict();
const formulaComposition = z.object({
  source_lid: nonEmptyString,
  meaning: nonEmptyString,
  terms: z.array(nonEmptyString),
  evidence_lids: z.array(nonEmptyString),
}).strict();
const formulaContextLink = z.object({
  target_lid: nonEmptyString,
  relation: nonEmptyString,
  description: nonEmptyString,
  evidence_lids: lidArray,
}).strict();
const formulaCandidate = z.object({
  formula_lid: nonEmptyString,
  context_lids: z.array(nonEmptyString).optional(),
  parameters: z.array(formulaParameter).optional(),
  composition: formulaComposition.optional(),
  context_links: z.array(formulaContextLink).optional(),
}).strict();
const profileSidecarOutput = z.object({
  discourse_items: z.array(discourseItem).optional(),
  formula_semantics: z.array(formulaCandidate).optional(),
}).strict();

interface ExtractorContractDefinition {
  schema_version: string;
  schema: ZodTypeAny;
  example: unknown;
  field_contracts?: readonly ExtractorFieldContractV1[];
  constraints: string[];
  invariants: string[];
}

const CONTRACTS: Record<ContractedExtractorStage, ExtractorContractDefinition> = {
  paper_metadata: {
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_metadata,
    schema: metadataFieldsSchema,
    example: {
      paper_metadata: {
        title: { value: "Paper title", source: "front_matter", evidence_lids: ["1.1"], confidence: 0.98 },
        authors: { value: [{ name: "Author Name", raw: "Author Name" }], source: "front_matter", evidence_lids: ["1.1"] },
        affiliations: { value: ["Example University"], source: "front_matter", evidence_lids: ["1.1"] },
        venue: { value: "Example Conference", source: "paper_text", evidence_lids: ["1.1"] },
        year: { value: 2026, source: "paper_text", evidence_lids: ["1.1"] },
        identifiers: {
          doi: { value: "10.x/example", source: "paper_text", evidence_lids: ["1.1"] },
          arxiv: { value: "2607.00001", source: "paper_text", evidence_lids: ["1.1"] },
          url: { value: "https://example.test", source: "paper_text", evidence_lids: ["1.1"] },
        },
        keywords: { value: ["retrieval"], source: "paper_text", evidence_lids: ["1.2"] },
        field_labels: { value: ["information retrieval"], source: "paper_text", evidence_lids: ["1.2"] },
        references: { value: [{ raw: "Smith 2020", identifiers: { doi: "10.x/ref" } }], source: "paper_text", evidence_lids: ["1.3"] },
        datasets: { value: ["Dataset A"], source: "paper_text", evidence_lids: ["1.2"] },
        code_links: { value: ["https://example.test/code"], source: "paper_text", evidence_lids: ["1.2"] },
        funding: { value: ["Grant A"], source: "paper_text", evidence_lids: ["1.2"] },
      },
    },
    constraints: [
      "Every business field is a strict MetadataField {value,source,evidence_lids?,confidence?}.",
      "references.value is Array<{raw:string,identifiers?:Record<string,string>}>, never string[].",
      `source is one of: ${METADATA_SOURCES.join(" | ")}.`,
    ],
    invariants: [
      "front_matter and paper_text fields require non-empty evidence_lids.",
      "Every evidence LID must be in the input visible_lids set.",
    ],
  },
  paper_lexicon: {
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_lexicon,
    schema: lexiconOutput,
    example: {
      entries: [{
        term: "Retrieval-Augmented Generation",
        term_type: "method_name",
        occurrences_lids: ["1.4", "2.1"],
        defined_at_lid: "1.4",
        aliases: ["RAG"],
        acronym_expansion: "Retrieval-Augmented Generation",
        chinese_gloss: "检索增强生成",
      }],
    },
    constraints: [
      `term_type is one of: ${PAPER_TERM_TYPES.join(" | ")}.`,
      "occurrences_lids is a non-empty string array; all optional strings are non-empty when present.",
    ],
    invariants: [
      "defined_at_lid, when present, must also occur in the same entry's occurrences_lids.",
      "Every occurrence and definition LID must be in the input visible_lids set.",
    ],
  },
  profile_sidecar: {
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.profile_sidecar,
    schema: profileSidecarOutput,
    field_contracts: PROFILE_SIDECAR_FIELD_CONTRACTS_V1,
    example: {
      discourse_items: [{
        lid: "3.2.1",
        mode: "informative",
        local_function: "definition",
        rhetorical_move: "main_point",
        local_summary: "Defines the local concept.",
        relations: [{
          target_lid: "3.2.2",
          type: "explains",
          family: "expansion",
          direction: "forward",
          confidence: 0.9,
          evidence_lids: ["3.2.1", "3.2.2"],
        }],
      }],
      formula_semantics: [{
        formula_lid: "3.2.4",
        context_lids: ["3.2.3"],
        parameters: [{ symbol: "E", label: "能量", meaning: "能量项", unit: null, domain: null, evidence_lids: ["3.2.4"] }],
        composition: { source_lid: "3.2.4", meaning: "表达能量关系。", terms: ["E"], evidence_lids: ["3.2.4"] },
        context_links: [{ target_lid: "3.2.3", relation: "explained_by", description: "上下文解释公式。", evidence_lids: ["3.2.4", "3.2.3"] }],
      }],
    },
    constraints: [],
    invariants: [
      "A profile_sidecar_discourse unit emits only discourse_items; a profile_sidecar_formula unit emits only formula_semantics.",
      "All discourse and relation evidence LIDs must be visible; relation evidence includes source lid and target_lid.",
      "formula_lid must be in formula_lids; context_lids must be visible; formula evidence stays inside formula_lid + context_lids.",
      "composition.source_lid must equal formula_lid.",
    ],
  },
};

function pointer(path: Array<string | number>): string {
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function valueAt(input: unknown, path: Array<string | number>): unknown {
  let value = input;
  for (const part of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}

function boundedActual(value: unknown): unknown {
  if (typeof value === "string") return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  return { type: "object", keys: Object.keys(value as object).slice(0, 12) };
}

function fail(input: Omit<ExtractorContractDiagnosticV1, "version">): never {
  throw new ExtractorContractError({ version: "automatic_build_extractor_diagnostic.v1", ...input });
}

function parseSchema(schema: ZodTypeAny, input: unknown): unknown {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  let issue = parsed.error.issues[0];
  if (issue.code === "invalid_union") {
    issue = issue.unionErrors.flatMap((error) => error.issues).sort((left, right) => right.path.length - left.path.length)[0] ?? issue;
  }
  const expected = issue.code === "invalid_type"
    ? issue.expected
    : issue.code === "invalid_enum_value"
      ? issue.options.join(" | ")
      : issue.message;
  fail({
    code: "schema_invalid",
    json_pointer: pointer(issue.path),
    expected,
    actual: boundedActual(valueAt(input, issue.path)),
  });
}

function assertAllowedLids(lids: string[], pathValue: string, allowed: Set<string>): void {
  const offending = [...new Set(lids.filter((lid) => !allowed.has(lid)))];
  if (offending.length) {
    fail({
      code: "evidence_out_of_scope",
      json_pointer: pathValue,
      expected: "subset of input visible_lids",
      actual: { type: "array", length: lids.length },
      evidence_violation: {
        kind: "out_of_scope",
        offending_lids: offending,
        allowed_lids: [...allowed],
      },
    });
  }
}

function metadataFields(output: PaperMetadataExtractionOutput): Record<string, unknown> {
  return ((output as { paper_metadata?: Record<string, unknown> }).paper_metadata ?? output) as Record<string, unknown>;
}

function validateMetadata(output: PaperMetadataExtractionOutput, context: ExtractorContractContext): void {
  const allowed = new Set(context.allowed_evidence_lids);
  const fields = metadataFields(output);
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const [name, value] of Object.entries(fields)) {
    if (name === "identifiers") {
      for (const [identifier, field] of Object.entries(value as Record<string, unknown>)) {
        entries.push([`/paper_metadata/identifiers/${identifier}`, field as Record<string, unknown>]);
      }
    } else entries.push([`/paper_metadata/${name}`, value as Record<string, unknown>]);
  }
  for (const [fieldPath, field] of entries) {
    const evidence = field.evidence_lids as string[] | undefined;
    if ((field.source === "front_matter" || field.source === "paper_text") && !evidence) {
      fail({
        code: "evidence_required",
        json_pointer: `${fieldPath}/evidence_lids`,
        expected: `non-empty evidence_lids for source ${field.source}`,
        actual: undefined,
        evidence_violation: { kind: "required", detail: "text-derived metadata must cite visible source LIDs" },
      });
    }
    if (evidence) assertAllowedLids(evidence, `${fieldPath}/evidence_lids`, allowed);
  }
}

function lexiconEntries(output: PaperLexiconExtractionOutput): Array<Record<string, unknown>> {
  return ((output.entries ?? output.paper_lexicon?.entries) ?? []) as unknown as Array<Record<string, unknown>>;
}

function validateLexicon(output: PaperLexiconExtractionOutput, context: ExtractorContractContext): void {
  const allowed = new Set(context.allowed_evidence_lids);
  for (const [index, entry] of lexiconEntries(output).entries()) {
    const occurrences = entry.occurrences_lids as string[];
    assertAllowedLids(occurrences, `/entries/${index}/occurrences_lids`, allowed);
    const definedAt = entry.defined_at_lid as string | undefined;
    if (definedAt && !occurrences.includes(definedAt)) {
      fail({
        code: "defined_at_not_occurrence",
        json_pointer: `/entries/${index}/defined_at_lid`,
        expected: `one of /entries/${index}/occurrences_lids`,
        actual: boundedActual(definedAt),
        evidence_violation: {
          kind: "cross_field",
          offending_lids: [definedAt],
          allowed_lids: occurrences,
        },
      });
    }
  }
}

function validateProfile(output: ProfileSidecarExtractionOutput, context: ExtractorContractContext): void {
  const visible = new Set(context.allowed_evidence_lids);
  const formulaLids = new Set(context.formula_lids ?? []);
  for (const [itemIndex, item] of (output.discourse_items ?? []).entries()) {
    assertAllowedLids([item.lid], `/discourse_items/${itemIndex}/lid`, visible);
    for (const [relationIndex, itemRelation] of item.relations.entries()) {
      assertAllowedLids([itemRelation.target_lid], `/discourse_items/${itemIndex}/relations/${relationIndex}/target_lid`, visible);
      const evidencePath = `/discourse_items/${itemIndex}/relations/${relationIndex}/evidence_lids`;
      assertAllowedLids(itemRelation.evidence_lids, evidencePath, visible);
      const required = [item.lid, itemRelation.target_lid].filter((lid) => !itemRelation.evidence_lids.includes(lid));
      if (required.length) {
        fail({
          code: "relation_evidence_incomplete",
          json_pointer: evidencePath,
          expected: "evidence_lids containing source lid and target_lid",
          actual: { type: "array", length: itemRelation.evidence_lids.length },
          evidence_violation: { kind: "required", offending_lids: required, allowed_lids: [...visible] },
        });
      }
    }
  }
  for (const [formulaIndex, formula] of (output.formula_semantics ?? []).entries()) {
    if (!formulaLids.has(formula.formula_lid)) {
      fail({
        code: "formula_lid_not_eligible",
        json_pointer: `/formula_semantics/${formulaIndex}/formula_lid`,
        expected: "one of input formula_lids",
        actual: boundedActual(formula.formula_lid),
        evidence_violation: { kind: "out_of_scope", offending_lids: [formula.formula_lid], allowed_lids: [...formulaLids] },
      });
    }
    const contextLids = formula.context_lids ?? [];
    assertAllowedLids(contextLids, `/formula_semantics/${formulaIndex}/context_lids`, visible);
    const formulaEvidence = new Set([formula.formula_lid, ...contextLids]);
    if (formula.composition?.source_lid !== undefined && formula.composition.source_lid !== formula.formula_lid) {
      fail({
        code: "composition_source_mismatch",
        json_pointer: `/formula_semantics/${formulaIndex}/composition/source_lid`,
        expected: formula.formula_lid,
        actual: boundedActual(formula.composition.source_lid),
        evidence_violation: { kind: "cross_field", offending_lids: [formula.composition.source_lid], allowed_lids: [formula.formula_lid] },
      });
    }
    const evidenceArrays: Array<[string, string[]]> = [
      ...((formula.parameters ?? []).map((item, index) => [`/formula_semantics/${formulaIndex}/parameters/${index}/evidence_lids`, item.evidence_lids] as [string, string[]])),
      ...(formula.composition ? [[`/formula_semantics/${formulaIndex}/composition/evidence_lids`, formula.composition.evidence_lids] as [string, string[]]] : []),
      ...((formula.context_links ?? []).flatMap((item, index) => [
        [`/formula_semantics/${formulaIndex}/context_links/${index}/target_lid`, [item.target_lid]] as [string, string[]],
        [`/formula_semantics/${formulaIndex}/context_links/${index}/evidence_lids`, item.evidence_lids] as [string, string[]],
      ])),
    ];
    for (const [evidencePath, lids] of evidenceArrays) assertAllowedLids(lids, evidencePath, formulaEvidence);
  }
}

export function parseExtractorCandidate(
  stage: "paper_metadata",
  input: unknown,
  context: ExtractorContractContext,
): PaperMetadataExtractionOutput;
export function parseExtractorCandidate(
  stage: "paper_lexicon",
  input: unknown,
  context: ExtractorContractContext,
): PaperLexiconExtractionOutput;
export function parseExtractorCandidate(
  stage: "profile_sidecar",
  input: unknown,
  context: ExtractorContractContext,
): ProfileSidecarExtractionOutput;
export function parseExtractorCandidate(
  stage: ContractedExtractorStage,
  input: unknown,
  context: ExtractorContractContext,
): PaperMetadataExtractionOutput | PaperLexiconExtractionOutput | ProfileSidecarExtractionOutput {
  const schema = stage === "paper_metadata" && typeof input === "object" && input !== null && "paper_metadata" in input
    ? z.object({ paper_metadata: metadataFieldsSchema }).strict()
    : CONTRACTS[stage].schema;
  const parsed = parseSchema(schema, input) as PaperMetadataExtractionOutput | PaperLexiconExtractionOutput | ProfileSidecarExtractionOutput;
  if (stage === "paper_metadata") validateMetadata(parsed as PaperMetadataExtractionOutput, context);
  else if (stage === "paper_lexicon") validateLexicon(parsed as PaperLexiconExtractionOutput, context);
  else validateProfile(parsed as ProfileSidecarExtractionOutput, context);
  return parsed;
}

export function renderExtractorContractMarkdown(stage: ContractedExtractorStage): string {
  const contract = CONTRACTS[stage];
  const fieldContracts = contract.field_contracts ?? [];
  const fieldConstraints = fieldContracts.flatMap((fieldContract) => {
    validateExtractorFieldContract(fieldContract);
    return [
      `- ${fieldContract.field}.required=${fieldContract.required}`,
      `- ${fieldContract.field}.nullable=${fieldContract.nullable}`,
      ...(fieldContract.enum_values === undefined
        ? []
        : [`- ${fieldContract.field}.enum_values=${fieldContract.enum_values.join(" | ")}`]),
      ...(fieldContract.min_length === undefined
        ? []
        : [`- ${fieldContract.field}.min_length=${fieldContract.min_length}`]),
      ...(fieldContract.max_length === undefined
        ? []
        : [`- ${fieldContract.field}.max_length=${fieldContract.max_length}`]),
      ...(fieldContract.min_value === undefined
        ? []
        : [`- ${fieldContract.field}.min_value=${fieldContract.min_value}`]),
      ...(fieldContract.max_value === undefined
        ? []
        : [`- ${fieldContract.field}.max_value=${fieldContract.max_value}`]),
    ];
  });
  const profileHints = fieldContracts.flatMap((fieldContract) => (
    Object.entries(fieldContract.profile_hints ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([profile, hints]) => (
          `- ${fieldContract.field}.profile_hints.${profile}=${hints.join(" | ")}`
        ))
  ));
  return [
    "<!-- BEGIN GENERATED EXTRACTOR CONTRACT -->",
    `## Machine Contract: ${contract.schema_version}`,
    "",
    "The writer validates this exact shape before semantic gating:",
    "",
    "```json",
    JSON.stringify(contract.example, null, 2),
    "```",
    "",
    "Field constraints:",
    ...fieldConstraints,
    ...profileHints,
    ...contract.constraints.map((item) => `- ${item}`),
    "",
    "Cross-field invariants:",
    ...contract.invariants.map((item) => `- ${item}`),
    "<!-- END GENERATED EXTRACTOR CONTRACT -->",
  ].join("\n");
}
