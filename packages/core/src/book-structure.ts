import { createHash } from "node:crypto";
import type { BuildTargetRefV2 } from "./build-orchestrator";
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { GraphEdge } from "./generated/GraphEdge";
import type { GraphNode } from "./generated/GraphNode";
import type { LidNode } from "./generated/LidNode";
import type { Pass2AuditEdge, Pass2BuildAuditSidecar } from "./pass2-build";
import type { ProfileArtifactHeader } from "./profile-artifact";
import type { TechnicalLearningDiscourseIndex, TechnicalLearningDiscourseItem } from "./discourse-index";
import { PAPER_PROFILE_ID, TECHNICAL_LEARNING_PROFILE, type ContentProfileDefinition } from "./content-profile";
import {
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  packExecutorTransportPayload,
  type ExecutorTransportChunkFrameV2,
  type ExecutorTransportPackResultV2,
  type ExecutorTransportProfileV2,
} from "./executor-transport";
import {
  evaluateModelExecutionBudget,
  type ModelExecutionBudgetEvidenceV3,
} from "./model-input-budget";
import {
  renderBookStructureFragmentModelInput,
  renderBookStructureModelInput,
  renderBookStructureReductionModelInput,
  renderBookStructureStitchFragmentModelInput,
  renderBookStructureStitchReductionModelInput,
} from "./model-input-renderer";
import type {
  ExtractionPolicyFingerprintV1,
  ExtractionQualityProfile,
} from "./semantic-artifact";
import {
  buildWorkUnitCostFromExecutionProof,
  createWorkUnitDescriptorV4,
  type WorkUnitDescriptorV4,
} from "./stage-work-unit";
import { estimateTokens } from "./window";

export type BookStructureSpineRole = "setup" | "foundation" | "method" | "application" | "case" | "synthesis";
export type BookStructureKeyStopType =
  | "definition"
  | "formula"
  | "claim"
  | "example"
  | "turning_point"
  | "warning"
  | "summary";

export interface AnchoredText {
  text: string;
  evidence_lids: string[];
}

export interface BookStructureKeyStop {
  id: string;
  lid: string;
  type: BookStructureKeyStopType;
  title?: string;
  reason: AnchoredText;
}

export interface BookStructureSpineUnit {
  lid: string;
  role: BookStructureSpineRole;
  summary: AnchoredText;
  key_stop_ids: string[];
  depends_on: string[];
}

export interface BookStructureThroughline {
  id: string;
  name: string;
  summary: AnchoredText;
  lids: string[];
  key_stop_ids: string[];
}

export interface BookStructureSidecar {
  header: ProfileArtifactHeader;
  spine: BookStructureSpineUnit[];
  throughlines: BookStructureThroughline[];
  key_stops: BookStructureKeyStop[];
}

export interface BookStructureCandidate {
  spine?: BookStructureSpineUnit[];
  throughlines?: BookStructureThroughline[];
  key_stops?: BookStructureKeyStop[];
}

export interface BookStructureTextExcerpt {
  lid: string;
  text: string;
}

export interface BookStructureProfileRules {
  rule_pack: "PAPER_BOOK_STRUCTURE_RULES";
  content_profile: "paper";
  paper_subtype: string;
  book_structure_rules: string[];
  unit_mapping: string[];
  spine_strategy: string;
  throughline_strategy: string;
  key_stop_strategy: string;
  metadata_policy: string;
}

export interface BookStructureUnitSource {
  job_id: string;
  unit_lid: string;
  unit_kind: LidNode["kind"];
  title_path: string[];
  profile_rules?: BookStructureProfileRules;
  leaf_lids: string[];
  excerpts: BookStructureTextExcerpt[];
  graph_nodes: GraphNode[];
  graph_edges: GraphEdge[];
  discourse_items: TechnicalLearningDiscourseItem[];
  formula_semantics: FormulaSemantics[];
  pass2_edges: Pass2AuditEdge[];
}

export const BOOK_STRUCTURE_ROUTER_VERSION_V2 = "book_structure_unit.v2" as const;
export const BOOK_STRUCTURE_FRAGMENT_SCHEMA_VERSION_V1 =
  "book_structure_fragment_observation.v1" as const;
export const BOOK_STRUCTURE_REDUCE_SCHEMA_VERSION_V1 =
  "book_structure_reduce_output.v1" as const;
export const BOOK_STRUCTURE_STITCH_FRAGMENT_SCHEMA_VERSION_V1 =
  "book_structure_stitch_fragment_observation.v1" as const;
export const BOOK_STRUCTURE_STITCH_REDUCE_SCHEMA_VERSION_V1 =
  "book_structure_stitch_reduce_output.v1" as const;

export const BOOK_STRUCTURE_EXECUTION_BUDGET_V2 = Object.freeze({
  stage_body_limit_tokens: 6_000,
  executor_context_floor_tokens: 8_192,
  output_reserve_tokens: 1_024,
  safety_margin_tokens: 256,
  max_candidate_tokens: 1_024,
});

const BOOK_STRUCTURE_V2_EXTRACTOR_PROMPT = [
  "---",
  "name: book-structure-v2-extractor",
  "description: Produce one grounded BookStructure unit card or final stitch candidate.",
  "---",
  "",
  "# BookStructure V2 extractor",
  "",
  "Consume exactly the supplied JSON. If job_id is unit:<lid>, emit only {\"unit_card\":...}.",
  "If job_id is stitch, emit only {\"spine\":[],\"throughlines\":[],\"key_stops\":[]}.",
  "Use only input LIDs and the closed role/key-stop enums. Do not emit markdown or explanation.",
].join("\n") + "\n";

const BOOK_STRUCTURE_FRAGMENT_EXTRACTOR_PROMPT = [
  "---",
  "name: book-structure-fragment-extractor",
  "description: Produce one local grounded observation for a bounded BookStructure fragment.",
  "---",
  "",
  "# BookStructure fragment extractor",
  "",
  "Emit one strict book_structure_fragment_observation.v1 JSON object.",
  "parent_unit_lid must match the input. Use only supplied evidence LIDs.",
  "Return local summary_fragments, candidate_key_stops, role_hints, dependency_hints, and evidence_lids.",
  "A fragment is not a final unit card. Do not emit markdown or explanation.",
].join("\n") + "\n";

const BOOK_STRUCTURE_REDUCER_PROMPT = [
  "---",
  "name: book-structure-reducer",
  "description: Reduce proof-bound BookStructure fragment observations.",
  "---",
  "",
  "# BookStructure unit reducer",
  "",
  "Consume only the supplied proof-bound child observations.",
  "When role is reduce, emit one book_structure_fragment_observation.v1 JSON object.",
  "When role is final, emit only {\"unit_card\":...} for parent_unit_lid.",
  "Deduplicate stable key stops and dependencies; use only child evidence LIDs. No markdown.",
].join("\n") + "\n";

const BOOK_STRUCTURE_STITCH_FRAGMENT_EXTRACTOR_PROMPT = [
  "---",
  "name: book-structure-stitch-fragment-extractor",
  "description: Produce one bounded partial BookStructure stitch candidate.",
  "---",
  "",
  "# BookStructure stitch fragment extractor",
  "",
  "Emit only a partial {\"spine\":[],\"throughlines\":[],\"key_stops\":[]} JSON candidate.",
  "Use only supplied unit cards and long-range edge evidence.",
  "Preserve unit order and stable key-stop identities. Do not emit markdown or explanation.",
].join("\n") + "\n";

const BOOK_STRUCTURE_STITCH_REDUCER_PROMPT = [
  "---",
  "name: book-structure-stitch-reducer",
  "description: Semantically reduce proof-bound partial BookStructure stitch candidates.",
  "---",
  "",
  "# BookStructure stitch reducer",
  "",
  "Emit only {\"spine\":[],\"throughlines\":[],\"key_stops\":[]} as strict JSON.",
  "Merge only supplied child candidates, preserve reading order, and deduplicate stable identities.",
  "Use only child evidence LIDs. Do not emit markdown or explanation.",
].join("\n") + "\n";

export const BOOK_STRUCTURE_EXECUTION_PROMPTS_V2: BookStructureExecutionPromptsV2 =
  Object.freeze({
    whole: BOOK_STRUCTURE_V2_EXTRACTOR_PROMPT,
    fragment: BOOK_STRUCTURE_FRAGMENT_EXTRACTOR_PROMPT,
    reduce: BOOK_STRUCTURE_REDUCER_PROMPT,
    stitch: BOOK_STRUCTURE_V2_EXTRACTOR_PROMPT,
    stitch_fragment: BOOK_STRUCTURE_STITCH_FRAGMENT_EXTRACTOR_PROMPT,
    stitch_reduce: BOOK_STRUCTURE_STITCH_REDUCER_PROMPT,
  });

export type BookStructureExecutionContractKindV2 =
  | "whole"
  | "fragment"
  | "reduce"
  | "stitch"
  | "stitch_fragment"
  | "stitch_reduce";

export interface BookStructureExecutionContractV2 {
  kind: BookStructureExecutionContractKindV2;
  semantic_prompt: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
}

export type BookStructureExecutionContractsV2 = Record<
  BookStructureExecutionContractKindV2,
  BookStructureExecutionContractV2
>;

export interface BookStructureExecutionPromptsV2 {
  whole: string;
  fragment: string;
  reduce: string;
  stitch: string;
  stitch_fragment: string;
  stitch_reduce: string;
}

export interface BookStructureLeafRangeV1 {
  start_ordinal: number;
  end_ordinal_exclusive: number;
}

export type BookStructureFragmentShardKindV1 =
  | "leaf_core"
  | "graph_node"
  | "graph_edge"
  | "discourse_item"
  | "formula_semantics"
  | "pass2_edge";

export interface BookStructureFragmentInputV1 {
  version: "book_structure_fragment_input.v1";
  work_unit_id: string;
  parent_job_id: string;
  parent_unit_lid: string;
  unit_kind: LidNode["kind"];
  title_path: string[];
  profile_rules?: BookStructureProfileRules;
  shard_kind: BookStructureFragmentShardKindV1;
  fragment_ordinal: number;
  source_leaf_range: BookStructureLeafRangeV1;
  core_leaf_range?: BookStructureLeafRangeV1;
  core_leaf_lids: string[];
  excerpts: BookStructureTextExcerpt[];
  graph_nodes: GraphNode[];
  graph_edges: GraphEdge[];
  discourse_items: TechnicalLearningDiscourseItem[];
  formula_semantics: FormulaSemantics[];
  pass2_edges: Pass2AuditEdge[];
}

export interface BookStructureFragmentObservationV1 {
  version: typeof BOOK_STRUCTURE_FRAGMENT_SCHEMA_VERSION_V1;
  parent_unit_lid: string;
  summary_fragments: AnchoredText[];
  candidate_key_stops: BookStructureKeyStop[];
  role_hints: BookStructureSpineRole[];
  dependency_hints: string[];
  evidence_lids: string[];
}

export interface BookStructureReductionChildV1 {
  work_unit_id: string;
  artifact_hash: string;
  source_leaf_range: BookStructureLeafRangeV1;
  payload: BookStructureFragmentObservationV1;
}

export interface BookStructureReductionInputV1 {
  version: "book_structure_reduction_input.v1";
  work_unit_id: string;
  parent_unit_lid: string;
  reducer_level: number;
  group_ordinal: number;
  role: "reduce" | "final";
  source_leaf_range: BookStructureLeafRangeV1;
  children: BookStructureReductionChildV1[];
}

export interface BookStructureStitchFragmentInputV1 {
  version: "book_structure_stitch_fragment_input.v1";
  work_unit_id: string;
  fragment_ordinal: number;
  unit_card_range: BookStructureLeafRangeV1;
  profile_rules?: BookStructureProfileRules;
  unit_cards: BookStructureUnitCard[];
  long_range_edges: Pass2AuditEdge[];
}

export interface BookStructureStitchReductionInputV1 {
  version: "book_structure_stitch_reduction_input.v1";
  work_unit_id: string;
  reducer_level: number;
  group_ordinal: number;
  role: "reduce" | "final";
  unit_card_range: BookStructureLeafRangeV1;
  children: BookStructureStitchReductionChildV1[];
}

export interface BookStructureStitchReductionChildV1 {
  work_unit_id: string;
  artifact_hash: string;
  unit_card_range: BookStructureLeafRangeV1;
  payload: BookStructureCandidate;
}

export interface BookStructureLeafCoverageManifestV1 {
  version: "book_structure_leaf_coverage.v1";
  parent_unit_lid: string;
  expected_leaf_count: number;
  covered_leaf_count: number;
  gap_count: number;
  core_overlap_count: number;
  core_ranges: Array<BookStructureLeafRangeV1 & {
    work_unit_id: string;
    leaf_lids: string[];
  }>;
  coverage_digest: string;
}

export interface BookStructureStitchCoverageManifestV1 {
  version: "book_structure_stitch_coverage.v1";
  expected_unit_card_count: number;
  covered_unit_card_count: number;
  gap_count: number;
  overlap_count: number;
  ranges: Array<BookStructureLeafRangeV1 & {
    work_unit_id: string;
    unit_lids: string[];
  }>;
  coverage_digest: string;
}

export type BookStructureUnitRouteV2 =
  | { role: "whole"; parent_unit_lid: string }
  | {
      role: "fragment" | "fragment_shard";
      parent_unit_lid: string;
      shard_kind: BookStructureFragmentShardKindV1;
      fragment_ordinal: number;
      source_leaf_range: BookStructureLeafRangeV1;
      core_leaf_range?: BookStructureLeafRangeV1;
    };

export interface BookStructureRoutedWorkUnitV2 {
  descriptor: WorkUnitDescriptorV4;
  rendered_input: string;
  route: BookStructureUnitRouteV2;
  input: BookStructureUnitSource | BookStructureFragmentInputV1 | BookStructureReductionInputV1;
}

export interface BookStructureRoutingRecoveryV1 {
  code:
    | "budget/atomic_input_item_too_large"
    | "budget/reducer_fan_in_unsplittable"
    | "evidence/dangling_input_item";
  stage: "book_structure";
  parent_unit_lid: string;
  item_kind?: Exclude<BookStructureFragmentShardKindV1, "leaf_core">
    | "leaf_excerpt"
    | "reducer_child"
    | "unit_card"
    | "stitch_reducer_child";
  item_key?: string;
  estimated_tokens?: number;
  limit_tokens?: number;
}

export type BookStructureUnitRouteResultV2 =
  | {
      status: "ready";
      mode: "whole" | "fragmented";
      work_units: BookStructureRoutedWorkUnitV2[];
      coverage: BookStructureLeafCoverageManifestV1;
    }
  | { status: "blocked"; recovery: BookStructureRoutingRecoveryV1 };

export interface BookStructureReductionRoutedWorkUnitV2 {
  descriptor: WorkUnitDescriptorV4;
  rendered_input: string;
  route: {
    role: "reduce" | "final";
    parent_unit_lid: string;
    reducer_level: number;
    group_ordinal: number;
    source_leaf_range: BookStructureLeafRangeV1;
  };
  input: BookStructureReductionInputV1;
}

export type BookStructureReductionRouteResultV2 =
  | {
      status: "ready";
      role: "reduce" | "final";
      work_units: BookStructureReductionRoutedWorkUnitV2[];
    }
  | { status: "blocked"; recovery: BookStructureRoutingRecoveryV1 };

export type BookStructureStitchRouteV2 =
  | { role: "whole" }
  | {
      role: "fragment";
      fragment_ordinal: number;
      unit_card_range: BookStructureLeafRangeV1;
    };

export interface BookStructureStitchRoutedWorkUnitV2 {
  descriptor: WorkUnitDescriptorV4;
  rendered_input: string;
  route: BookStructureStitchRouteV2;
  input: BookStructureStitchPacket | BookStructureStitchFragmentInputV1;
}

export type BookStructureStitchRouteResultV2 =
  | {
      status: "ready";
      mode: "whole" | "fragmented";
      work_units: BookStructureStitchRoutedWorkUnitV2[];
      coverage: BookStructureStitchCoverageManifestV1;
    }
  | { status: "blocked"; recovery: BookStructureRoutingRecoveryV1 };

export interface BookStructureStitchReductionRoutedWorkUnitV2 {
  descriptor: WorkUnitDescriptorV4;
  rendered_input: string;
  route: {
    role: "reduce" | "final";
    reducer_level: number;
    group_ordinal: number;
    unit_card_range: BookStructureLeafRangeV1;
  };
  input: BookStructureStitchReductionInputV1;
}

export type BookStructureStitchReductionRouteResultV2 =
  | {
      status: "ready";
      role: "reduce" | "final";
      work_units: BookStructureStitchReductionRoutedWorkUnitV2[];
    }
  | { status: "blocked"; recovery: BookStructureRoutingRecoveryV1 };

export interface BookStructureUnitCard {
  unit_lid: string;
  role: BookStructureSpineRole;
  summary: AnchoredText;
  candidate_key_stops: BookStructureKeyStop[];
  depends_on: string[];
  evidence_lids: string[];
}

export interface BookStructureUnitExtractionOutput {
  unit_card: BookStructureUnitCard;
}

export interface BookStructureUnitArtifact {
  content_hash: string;
  output: BookStructureUnitExtractionOutput;
}

export interface BookStructureStitchPacket {
  job_id: "stitch";
  profile_rules?: BookStructureProfileRules;
  unit_cards: BookStructureUnitCard[];
  long_range_edges: Pass2AuditEdge[];
}

export interface BookStructureStitchArtifact {
  content_hash: string;
  output: BookStructureCandidate;
}

export interface BookStructureStatus {
  unit_done: string[];
  unit_pending: string[];
  stitch_done: boolean;
  stitch_pending: boolean;
  stitch_blocked: boolean;
}

export type BookStructureDropKind = "spine_unit" | "throughline" | "key_stop" | "reference";
export type BookStructureDropReason =
  | "missing_lid"
  | "invalid_role"
  | "invalid_key_stop_type"
  | "empty_id"
  | "duplicate_id"
  | "empty_name"
  | "empty_text"
  | "summary_too_long"
  | "empty_evidence"
  | "dangling_evidence"
  | "dangling_reference";

export interface DroppedBookStructureCandidate {
  kind: BookStructureDropKind;
  id: string;
  reason: BookStructureDropReason;
  detail: string;
}

export interface BookStructureBuildResult {
  sidecar: BookStructureSidecar;
  dropped: DroppedBookStructureCandidate[];
}

export const MAX_BOOK_STRUCTURE_TEXT_LEN = 600;
export const MAX_BOOK_STRUCTURE_EXCERPT_LEN = 1200;

const SPINE_ROLES = new Set<BookStructureSpineRole>(["setup", "foundation", "method", "application", "case", "synthesis"]);
const KEY_STOP_TYPES = new Set<BookStructureKeyStopType>([
  "definition",
  "formula",
  "claim",
  "example",
  "turning_point",
  "warning",
  "summary",
]);

function lidSet(nodes: LidNode[]): Set<string> {
  return new Set(nodes.map((n) => n.lid));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bookStructurePolicy(input: {
  profile: ContentProfileDefinition;
  quality_profile: ExtractionQualityProfile;
  kind: BookStructureExecutionContractKindV2;
  prompt: string;
}): ExtractionPolicyFingerprintV1 {
  const detail = {
    whole: {
      stage_policy_version: "book_structure_policy.v1",
      schema_version: "book_structure_output.v1",
    },
    fragment: {
      stage_policy_version: "book_structure_fragment_policy.v1",
      schema_version: BOOK_STRUCTURE_FRAGMENT_SCHEMA_VERSION_V1,
    },
    reduce: {
      stage_policy_version: "book_structure_reduce_policy.v1",
      schema_version: BOOK_STRUCTURE_REDUCE_SCHEMA_VERSION_V1,
    },
    stitch: {
      stage_policy_version: "book_structure_policy.v1",
      schema_version: "book_structure_output.v1",
    },
    stitch_fragment: {
      stage_policy_version: "book_structure_stitch_fragment_policy.v1",
      schema_version: BOOK_STRUCTURE_STITCH_FRAGMENT_SCHEMA_VERSION_V1,
    },
    stitch_reduce: {
      stage_policy_version: "book_structure_stitch_reduce_policy.v1",
      schema_version: BOOK_STRUCTURE_STITCH_REDUCE_SCHEMA_VERSION_V1,
    },
  }[input.kind];
  return {
    profile_id: input.profile.id,
    profile_version: input.profile.profile_version,
    stage_policy_version: detail.stage_policy_version,
    router_version: BOOK_STRUCTURE_ROUTER_VERSION_V2,
    prompt_sha256: sha256Text(input.prompt),
    schema_version: detail.schema_version,
    quality_profile: input.quality_profile,
  };
}

export function createBookStructureExecutionContractsV2(input: {
  profile: ContentProfileDefinition;
  quality_profile?: ExtractionQualityProfile;
  prompts: BookStructureExecutionPromptsV2;
}): BookStructureExecutionContractsV2 {
  const qualityProfile = input.quality_profile ?? "full";
  const kinds: BookStructureExecutionContractKindV2[] = [
    "whole",
    "fragment",
    "reduce",
    "stitch",
    "stitch_fragment",
    "stitch_reduce",
  ];
  return Object.fromEntries(kinds.map((kind) => {
    const semanticPrompt = input.prompts[kind];
    if (!semanticPrompt || Buffer.byteLength(semanticPrompt, "utf8") > 65_536) {
      throw new Error(`BookStructure ${kind} prompt must be a non-empty bounded string`);
    }
    return [kind, {
      kind,
      semantic_prompt: semanticPrompt,
      policy_fingerprint: bookStructurePolicy({
        profile: input.profile,
        quality_profile: qualityProfile,
        kind,
        prompt: semanticPrompt,
      }),
    }];
  })) as unknown as BookStructureExecutionContractsV2;
}

function bookStructureTransportEnvelope(
  segment: "semantic_prompt" | "semantic_input",
): (frame: ExecutorTransportChunkFrameV2) => unknown {
  return (frame) => {
    const ordinal = Math.min(63, frame.ordinal + (segment === "semantic_input" ? 16 : 0));
    const identity = {
      opaque_session_ref: `absession1_${"1".repeat(64)}`,
      generation_input_ref: `abinput1_${"2".repeat(64)}`,
      segment,
      ordinal,
      byte_range: frame.byte_range,
      final_for_segment: frame.final,
      final_for_generation: segment === "semantic_input" && frame.final,
    };
    return {
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "INPUT_CHUNK",
        chunk: {
          version: "automatic_build_executor_input_chunk.v3",
          ...identity,
          payload_utf8: frame.payload_utf8,
        },
      },
    };
  };
}

function packBookStructureExecutionSegment(
  payload: string,
  segment: "semantic_prompt" | "semantic_input",
  transportProfile: ExecutorTransportProfileV2,
): ExecutorTransportPackResultV2 {
  return packExecutorTransportPayload({
    profile: transportProfile,
    payload_utf8: payload,
    envelope_for_chunk: bookStructureTransportEnvelope(segment),
  });
}

function evaluateBookStructureExecution(input: {
  contract: BookStructureExecutionContractV2;
  rendered_input: string;
  transport_profile: ExecutorTransportProfileV2;
  budget: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
}) {
  const estimatedPromptTokens = estimateTokens(input.contract.semantic_prompt);
  const estimatedRenderedTokens = estimateTokens(input.rendered_input);
  const quickContextLimit = Math.max(
    0,
    input.budget.executor_context_floor_tokens
      - estimatedPromptTokens
      - input.budget.output_reserve_tokens
      - input.budget.safety_margin_tokens,
  );
  if (estimatedRenderedTokens > input.budget.stage_body_limit_tokens
    || estimatedRenderedTokens > quickContextLimit) {
    const reasons: Array<"stage_limit" | "context_limit"> = [];
    if (estimatedRenderedTokens > input.budget.stage_body_limit_tokens) reasons.push("stage_limit");
    if (estimatedRenderedTokens > quickContextLimit) reasons.push("context_limit");
    return {
      version: "model_execution_budget_evaluation.v3" as const,
      status: "blocked" as const,
      estimator_version: "weighted_codepoint_estimator.v1",
      render_contract_version: "model_input_render.v1",
      router_version: input.contract.policy_fingerprint.router_version,
      prompt_sha256: input.contract.policy_fingerprint.prompt_sha256,
      rendered_input_sha256: sha256Text(input.rendered_input),
      estimated_prompt_tokens: estimatedPromptTokens,
      estimated_rendered_tokens: estimatedRenderedTokens,
      input_chunk_count: 0,
      input_delivery_overhead_tokens: 0,
      output_reserve_tokens: input.budget.output_reserve_tokens,
      max_candidate_tokens: input.budget.max_candidate_tokens,
      effective_body_limit_tokens: Math.min(
        input.budget.stage_body_limit_tokens,
        quickContextLimit,
      ),
      reasons,
    };
  }
  return evaluateModelExecutionBudget({
    semantic_prompt: input.contract.semantic_prompt,
    rendered_input: input.rendered_input,
    router_version: input.contract.policy_fingerprint.router_version,
    ...input.budget,
    transport_profile: input.transport_profile,
    input_transport_packs: [
      packBookStructureExecutionSegment(
        input.contract.semantic_prompt,
        "semantic_prompt",
        input.transport_profile,
      ),
      packBookStructureExecutionSegment(
        input.rendered_input,
        "semantic_input",
        input.transport_profile,
      ),
    ],
  });
}

function proofBoundBookStructureDescriptor(input: {
  target: BuildTargetRefV2;
  work_unit_id: string;
  kind: WorkUnitDescriptorV4["kind"];
  rendered_input: string;
  proof: ModelExecutionBudgetEvidenceV3;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  input_basis: WorkUnitDescriptorV4["input_basis"];
  evidence_lids: string[];
  dependencies?: WorkUnitDescriptorV4["dependencies"];
  aggregation?: WorkUnitDescriptorV4["aggregation"];
  formula_lids?: number;
  candidate_count?: number;
  expected_output_items?: number;
  transport_profile: ExecutorTransportProfileV2;
}): WorkUnitDescriptorV4 {
  return createWorkUnitDescriptorV4({
    target: input.target,
    stage: "book_structure",
    work_unit_id: input.work_unit_id,
    kind: input.kind,
    input_basis: input.input_basis,
    input_hash: input.proof.rendered_input_sha256,
    execution_budget_proof: input.proof,
    policy_fingerprint: input.policy_fingerprint,
    evidence_lids: input.evidence_lids,
    dependencies: input.dependencies ?? [],
    cost: buildWorkUnitCostFromExecutionProof({
      rendered_input: input.rendered_input,
      proof: input.proof,
      transport_profile: input.transport_profile,
      visible_lids: new Set(input.evidence_lids).size,
      formula_lids: input.formula_lids,
      candidate_count: input.candidate_count,
      expected_output_items: input.expected_output_items ?? 1,
    }),
    ...(input.aggregation ? { aggregation: input.aggregation } : {}),
  }, input.transport_profile);
}

function nodeLeaves(node: LidNode, byLid: Map<string, LidNode>): string[] {
  if (node.children.length === 0) return [node.lid];
  const leaves: string[] = [];
  for (const childId of node.children) {
    const child = byLid.get(childId);
    if (child) leaves.push(...nodeLeaves(child, byLid));
  }
  return leaves;
}

function isStructuralNode(node: LidNode): boolean {
  return node.kind === "chapter" || node.kind === "section";
}

function structuralChildren(node: LidNode, byLid: Map<string, LidNode>): LidNode[] {
  return node.children.map((childId) => byLid.get(childId)).filter((child): child is LidNode => child !== undefined && isStructuralNode(child));
}

function selectStructureUnits(nodes: LidNode[], byLid: Map<string, LidNode>): LidNode[] {
  const structural = nodes.filter(isStructuralNode);
  const structuralLids = new Set(structural.map((node) => node.lid));
  const roots = structural.filter((node) => !titlePathOf(node.lid).some((ancestor) => structuralLids.has(ancestor)));
  if (roots.length === 1) {
    const children = structuralChildren(roots[0], byLid);
    if (children.length > 0) return children;
  }
  if (roots.length > 0) return roots;
  const nonLeaf = nodes.filter((node) => node.children.length > 0);
  return nonLeaf.length > 0 ? nonLeaf : nodes.slice(0, 1);
}

function titlePathOf(lid: string): string[] {
  const parts = lid.split(".");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("."));
  return out;
}

function graphNodeLids(node: GraphNode): string[] {
  if (node.type === "claim") return node.source_lid ? [node.source_lid] : [];
  return node.occurrences;
}

function edgeTouchesNode(edge: GraphEdge, nodeIds: Set<string>): boolean {
  return nodeIds.has(edge.source) || nodeIds.has(edge.target);
}

function pass2EdgesFor(leafSet: Set<string>, audit?: Pass2BuildAuditSidecar): Pass2AuditEdge[] {
  return [...(audit?.accepted ?? []), ...(audit?.pending ?? [])]
    .filter((edge) => edge.evidence_lids.some((lid) => leafSet.has(lid)))
    .sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
}

interface BookStructureAuxiliaryItemV1 {
  kind: Exclude<BookStructureFragmentShardKindV1, "leaf_core">;
  key: string;
  evidence_lids: string[];
  primary_leaf_ordinal: number;
  value: GraphNode | GraphEdge | TechnicalLearningDiscourseItem | FormulaSemantics | Pass2AuditEdge;
}

function bookStructureAuxiliaryItems(
  source: BookStructureUnitSource,
): { status: "ready"; items: BookStructureAuxiliaryItemV1[] } | {
  status: "blocked";
  recovery: BookStructureRoutingRecoveryV1;
} {
  const ordinalByLid = new Map(source.leaf_lids.map((lid, ordinal) => [lid, ordinal]));
  const graphEvidence = new Map<string, string[]>();
  const items: BookStructureAuxiliaryItemV1[] = [];
  const add = (
    kind: BookStructureAuxiliaryItemV1["kind"],
    key: string,
    evidenceLids: string[],
    value: BookStructureAuxiliaryItemV1["value"],
  ): BookStructureRoutingRecoveryV1 | undefined => {
    const localEvidence = [...new Set(evidenceLids.filter((lid) => ordinalByLid.has(lid)))]
      .sort((left, right) => ordinalByLid.get(left)! - ordinalByLid.get(right)!);
    if (!localEvidence.length) {
      return {
        code: "evidence/dangling_input_item",
        stage: "book_structure",
        parent_unit_lid: source.unit_lid,
        item_kind: kind,
        item_key: key,
      };
    }
    items.push({
      kind,
      key,
      evidence_lids: localEvidence,
      primary_leaf_ordinal: ordinalByLid.get(localEvidence[0])!,
      value,
    });
    return undefined;
  };

  for (const node of source.graph_nodes) {
    const evidence = graphNodeLids(node);
    graphEvidence.set(node.id, evidence.filter((lid) => ordinalByLid.has(lid)));
    const recovery = add("graph_node", node.id, evidence, node);
    if (recovery) return { status: "blocked", recovery };
  }
  for (const edge of source.graph_edges) {
    const evidence = [
      ...(graphEvidence.get(edge.source) ?? []),
      ...(graphEvidence.get(edge.target) ?? []),
    ];
    const recovery = add(
      "graph_edge",
      `edge:${sha256Json(edge)}`,
      evidence,
      edge,
    );
    if (recovery) return { status: "blocked", recovery };
  }
  for (const item of source.discourse_items) {
    const recovery = add("discourse_item", item.lid, [item.lid], item);
    if (recovery) return { status: "blocked", recovery };
  }
  for (const item of source.formula_semantics) {
    const evidence = [
      item.formula_lid,
      ...(item.composition?.evidence_lids ?? []),
    ];
    const recovery = add("formula_semantics", item.formula_lid, evidence, item);
    if (recovery) return { status: "blocked", recovery };
  }
  for (const edge of source.pass2_edges) {
    const recovery = add("pass2_edge", edge.candidate_id, edge.evidence_lids, edge);
    if (recovery) return { status: "blocked", recovery };
  }
  items.sort((left, right) => left.primary_leaf_ordinal - right.primary_leaf_ordinal
    || left.kind.localeCompare(right.kind)
    || left.key.localeCompare(right.key));
  const identities = new Set<string>();
  for (const item of items) {
    const identity = `${item.kind}:${item.key}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate BookStructure auxiliary item identity: ${identity}`);
    }
    identities.add(identity);
  }
  return { status: "ready", items };
}

function bookStructureFragmentInput(input: {
  source: BookStructureUnitSource;
  work_unit_id: string;
  fragment_ordinal: number;
  shard_kind: BookStructureFragmentShardKindV1;
  source_range: BookStructureLeafRangeV1;
  core_range?: BookStructureLeafRangeV1;
  auxiliary_items: BookStructureAuxiliaryItemV1[];
}): BookStructureFragmentInputV1 {
  const range = input.core_range;
  const coreLeafLids = range
    ? input.source.leaf_lids.slice(range.start_ordinal, range.end_ordinal_exclusive)
    : [];
  const coreSet = new Set(coreLeafLids);
  const graphNodes: GraphNode[] = [];
  const graphEdges: GraphEdge[] = [];
  const discourseItems: TechnicalLearningDiscourseItem[] = [];
  const formulaSemantics: FormulaSemantics[] = [];
  const pass2Edges: Pass2AuditEdge[] = [];
  for (const item of input.auxiliary_items) {
    switch (item.kind) {
      case "graph_node": graphNodes.push(item.value as GraphNode); break;
      case "graph_edge": graphEdges.push(item.value as GraphEdge); break;
      case "discourse_item": discourseItems.push(item.value as TechnicalLearningDiscourseItem); break;
      case "formula_semantics": formulaSemantics.push(item.value as FormulaSemantics); break;
      case "pass2_edge": pass2Edges.push(item.value as Pass2AuditEdge); break;
    }
  }
  return {
    version: "book_structure_fragment_input.v1",
    work_unit_id: input.work_unit_id,
    parent_job_id: input.source.job_id,
    parent_unit_lid: input.source.unit_lid,
    unit_kind: input.source.unit_kind,
    title_path: [...input.source.title_path],
    ...(input.source.profile_rules ? { profile_rules: input.source.profile_rules } : {}),
    shard_kind: input.shard_kind,
    fragment_ordinal: input.fragment_ordinal,
    source_leaf_range: { ...input.source_range },
    ...(range ? { core_leaf_range: { ...range } } : {}),
    core_leaf_lids: coreLeafLids,
    excerpts: range
      ? input.source.excerpts.filter((excerpt) => coreSet.has(excerpt.lid))
      : [],
    graph_nodes: graphNodes,
    graph_edges: graphEdges,
    discourse_items: discourseItems,
    formula_semantics: formulaSemantics,
    pass2_edges: pass2Edges,
  };
}

function fragmentWorkUnitId(
  parentUnitLid: string,
  fragmentOrdinal: number,
  shardKind: BookStructureFragmentShardKindV1,
): string {
  const ordinal = String(fragmentOrdinal).padStart(4, "0");
  return shardKind === "leaf_core"
    ? `unit:${parentUnitLid}:fragment:${ordinal}`
    : `unit:${parentUnitLid}:shard:${shardKind}:${ordinal}`;
}

function createBookStructureFragmentWorkUnit(input: {
  target: BuildTargetRefV2;
  source: BookStructureUnitSource;
  source_fingerprint: string;
  packet: BookStructureFragmentInputV1;
  contract: BookStructureExecutionContractV2;
  transport_profile: ExecutorTransportProfileV2;
  budget: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
  evidence_lids: string[];
}): { status: "ready"; work_unit: BookStructureRoutedWorkUnitV2 } | {
  status: "blocked";
  evaluation: Exclude<ReturnType<typeof evaluateBookStructureExecution>, { status: "within_limit" }>;
} {
  const renderedInput = renderBookStructureFragmentModelInput(input.packet);
  const evaluated = evaluateBookStructureExecution({
    contract: input.contract,
    rendered_input: renderedInput,
    transport_profile: input.transport_profile,
    budget: input.budget,
  });
  if (evaluated.status !== "within_limit") return { status: "blocked", evaluation: evaluated };
  const coreRange = input.packet.core_leaf_range;
  const evidenceLids = [...new Set([input.source.unit_lid, ...input.evidence_lids])];
  const descriptor = proofBoundBookStructureDescriptor({
    target: input.target,
    work_unit_id: input.packet.work_unit_id,
    kind: "structure_fragment",
    rendered_input: renderedInput,
    proof: evaluated.proof,
    policy_fingerprint: input.contract.policy_fingerprint,
    input_basis: {
      kind: "semantic_projection",
      projection_kind: "book_structure",
      source_fingerprint: input.source_fingerprint,
      projection_sha256: sha256Json(input.packet),
      parent_lids: evidenceLids,
      core_range: { ...input.packet.source_leaf_range },
    },
    evidence_lids: evidenceLids,
    aggregation: { parent_lid: input.source.unit_lid, role: "fragment" },
    formula_lids: input.packet.formula_semantics.length,
    candidate_count: input.packet.pass2_edges.length,
    expected_output_items: 1,
    transport_profile: input.transport_profile,
  });
  return {
    status: "ready",
    work_unit: {
      descriptor,
      rendered_input: renderedInput,
      route: {
        role: coreRange ? "fragment" : "fragment_shard",
        parent_unit_lid: input.source.unit_lid,
        shard_kind: input.packet.shard_kind,
        fragment_ordinal: input.packet.fragment_ordinal,
        source_leaf_range: { ...input.packet.source_leaf_range },
        ...(coreRange ? { core_leaf_range: { ...coreRange } } : {}),
      },
      input: input.packet,
    },
  };
}

function budgetRecoveryForFragment(input: {
  source: BookStructureUnitSource;
  item_kind: BookStructureRoutingRecoveryV1["item_kind"];
  item_key: string;
  evaluation: Exclude<ReturnType<typeof evaluateBookStructureExecution>, { status: "within_limit" }>;
}): BookStructureRoutingRecoveryV1 {
  return {
    code: "budget/atomic_input_item_too_large",
    stage: "book_structure",
    parent_unit_lid: input.source.unit_lid,
    item_kind: input.item_kind,
    item_key: input.item_key,
    estimated_tokens: input.evaluation.estimated_rendered_tokens,
    limit_tokens: input.evaluation.effective_body_limit_tokens,
  };
}

function coverageManifest(
  source: BookStructureUnitSource,
  workUnits: BookStructureRoutedWorkUnitV2[],
): BookStructureLeafCoverageManifestV1 {
  const coreRanges = workUnits.flatMap((unit) => {
    if (unit.route.role !== "fragment" || !unit.route.core_leaf_range) return [];
    const range = unit.route.core_leaf_range;
    return [{
      ...range,
      work_unit_id: unit.descriptor.work_unit_id,
      leaf_lids: source.leaf_lids.slice(range.start_ordinal, range.end_ordinal_exclusive),
    }];
  }).sort((left, right) => left.start_ordinal - right.start_ordinal);
  let cursor = 0;
  let covered = 0;
  let gaps = 0;
  let overlaps = 0;
  for (const range of coreRanges) {
    if (range.start_ordinal > cursor) gaps += range.start_ordinal - cursor;
    if (range.start_ordinal < cursor) overlaps += cursor - range.start_ordinal;
    covered += range.end_ordinal_exclusive - range.start_ordinal;
    cursor = Math.max(cursor, range.end_ordinal_exclusive);
  }
  if (cursor < source.leaf_lids.length) gaps += source.leaf_lids.length - cursor;
  const unsigned = {
    version: "book_structure_leaf_coverage.v1" as const,
    parent_unit_lid: source.unit_lid,
    expected_leaf_count: source.leaf_lids.length,
    covered_leaf_count: covered,
    gap_count: gaps,
    core_overlap_count: overlaps,
    core_ranges: coreRanges,
  };
  return { ...unsigned, coverage_digest: sha256Json(unsigned) };
}

export function routeBookStructureUnitWorkUnitsV2(input: {
  target: BuildTargetRefV2;
  source: BookStructureUnitSource;
  lid_nodes: LidNode[];
  source_fingerprint: string;
  contracts: BookStructureExecutionContractsV2;
  transport_profile?: ExecutorTransportProfileV2;
  budget?: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
}): BookStructureUnitRouteResultV2 {
  const transportProfile = input.transport_profile ?? CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  const budget = input.budget ?? BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
  const source = input.source;
  if (!source.leaf_lids.length || new Set(source.leaf_lids).size !== source.leaf_lids.length) {
    throw new Error("BookStructure unit leaf_lids must be a non-empty unique sequence");
  }
  const knownLids = new Set(input.lid_nodes.map((node) => node.lid));
  if (source.leaf_lids.some((lid) => !knownLids.has(lid))) {
    const missing = source.leaf_lids.find((lid) => !knownLids.has(lid))!;
    return {
      status: "blocked",
      recovery: {
        code: "evidence/dangling_input_item",
        stage: "book_structure",
        parent_unit_lid: source.unit_lid,
        item_kind: "leaf_excerpt",
        item_key: missing,
      },
    };
  }
  const auxiliary = bookStructureAuxiliaryItems(source);
  if (auxiliary.status === "blocked") return auxiliary;

  const wholeRendered = renderBookStructureModelInput(source);
  const wholeEvaluation = evaluateBookStructureExecution({
    contract: input.contracts.whole,
    rendered_input: wholeRendered,
    transport_profile: transportProfile,
    budget,
  });
  if (wholeEvaluation.status === "within_limit") {
    const evidenceLids = [source.unit_lid, ...source.leaf_lids];
    const descriptor = proofBoundBookStructureDescriptor({
      target: input.target,
      work_unit_id: source.job_id,
      kind: "structure_unit",
      rendered_input: wholeRendered,
      proof: wholeEvaluation.proof,
      policy_fingerprint: input.contracts.whole.policy_fingerprint,
      input_basis: {
        kind: "semantic_projection",
        projection_kind: "book_structure",
        source_fingerprint: input.source_fingerprint,
        projection_sha256: bookStructureUnitHash(source),
        parent_lids: evidenceLids,
        core_range: { start_ordinal: 0, end_ordinal_exclusive: source.leaf_lids.length },
      },
      evidence_lids: evidenceLids,
      formula_lids: source.formula_semantics.length,
      candidate_count: source.pass2_edges.length,
      expected_output_items: 1,
      transport_profile: transportProfile,
    });
    const workUnit: BookStructureRoutedWorkUnitV2 = {
      descriptor,
      rendered_input: wholeRendered,
      route: { role: "whole", parent_unit_lid: source.unit_lid },
      input: source,
    };
    const range = {
      start_ordinal: 0,
      end_ordinal_exclusive: source.leaf_lids.length,
      work_unit_id: source.job_id,
      leaf_lids: [...source.leaf_lids],
    };
    const unsigned = {
      version: "book_structure_leaf_coverage.v1" as const,
      parent_unit_lid: source.unit_lid,
      expected_leaf_count: source.leaf_lids.length,
      covered_leaf_count: source.leaf_lids.length,
      gap_count: 0,
      core_overlap_count: 0,
      core_ranges: [range],
    };
    return {
      status: "ready",
      mode: "whole",
      work_units: [workUnit],
      coverage: { ...unsigned, coverage_digest: sha256Json(unsigned) },
    };
  }

  const workUnits: BookStructureRoutedWorkUnitV2[] = [];
  let fragmentOrdinal = 0;
  let start = 0;
  while (start < source.leaf_lids.length) {
    let low = start + 1;
    let high = source.leaf_lids.length;
    let best: { end: number; work_unit: BookStructureRoutedWorkUnitV2 } | undefined;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const range = { start_ordinal: start, end_ordinal_exclusive: end };
      const items = auxiliary.items.filter((item) => (
        item.primary_leaf_ordinal >= start && item.primary_leaf_ordinal < end
      ));
      const workUnitId = fragmentWorkUnitId(source.unit_lid, fragmentOrdinal, "leaf_core");
      const packet = bookStructureFragmentInput({
        source,
        work_unit_id: workUnitId,
        fragment_ordinal: fragmentOrdinal,
        shard_kind: "leaf_core",
        source_range: range,
        core_range: range,
        auxiliary_items: items,
      });
      const value = createBookStructureFragmentWorkUnit({
        target: input.target,
        source,
        source_fingerprint: input.source_fingerprint,
        packet,
        contract: input.contracts.fragment,
        transport_profile: transportProfile,
        budget,
        evidence_lids: source.leaf_lids.slice(start, end),
      });
      if (value.status === "ready") {
        best = { end, work_unit: value.work_unit };
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (best) {
      workUnits.push(best.work_unit);
      fragmentOrdinal += 1;
      start = best.end;
      continue;
    }

    const leafLid = source.leaf_lids[start];
    const coreRange = { start_ordinal: start, end_ordinal_exclusive: start + 1 };
    const coreId = fragmentWorkUnitId(source.unit_lid, fragmentOrdinal, "leaf_core");
    const corePacket = bookStructureFragmentInput({
      source,
      work_unit_id: coreId,
      fragment_ordinal: fragmentOrdinal,
      shard_kind: "leaf_core",
      source_range: coreRange,
      core_range: coreRange,
      auxiliary_items: [],
    });
    const core = createBookStructureFragmentWorkUnit({
      target: input.target,
      source,
      source_fingerprint: input.source_fingerprint,
      packet: corePacket,
      contract: input.contracts.fragment,
      transport_profile: transportProfile,
      budget,
      evidence_lids: [leafLid],
    });
    if (core.status === "blocked") {
      return {
        status: "blocked",
        recovery: budgetRecoveryForFragment({
          source,
          item_kind: "leaf_excerpt",
          item_key: leafLid,
          evaluation: core.evaluation,
        }),
      };
    }
    workUnits.push(core.work_unit);
    fragmentOrdinal += 1;

    const leafItems = auxiliary.items.filter((item) => item.primary_leaf_ordinal === start);
    for (const kind of [
      "graph_node",
      "graph_edge",
      "discourse_item",
      "formula_semantics",
      "pass2_edge",
    ] as const) {
      const items = leafItems.filter((item) => item.kind === kind);
      let itemStart = 0;
      while (itemStart < items.length) {
        let itemEnd = items.length;
        let selected: { end: number; work_unit: BookStructureRoutedWorkUnitV2 } | undefined;
        while (itemEnd > itemStart) {
          const group = items.slice(itemStart, itemEnd);
          const workUnitId = fragmentWorkUnitId(source.unit_lid, fragmentOrdinal, kind);
          const packet = bookStructureFragmentInput({
            source,
            work_unit_id: workUnitId,
            fragment_ordinal: fragmentOrdinal,
            shard_kind: kind,
            source_range: { start_ordinal: start, end_ordinal_exclusive: start + 1 },
            auxiliary_items: group,
          });
          const value = createBookStructureFragmentWorkUnit({
            target: input.target,
            source,
            source_fingerprint: input.source_fingerprint,
            packet,
            contract: input.contracts.fragment,
            transport_profile: transportProfile,
            budget,
            evidence_lids: group.flatMap((item) => item.evidence_lids),
          });
          if (value.status === "ready") {
            selected = { end: itemEnd, work_unit: value.work_unit };
            break;
          }
          itemEnd -= 1;
        }
        if (!selected) {
          const item = items[itemStart];
          const workUnitId = fragmentWorkUnitId(source.unit_lid, fragmentOrdinal, kind);
          const packet = bookStructureFragmentInput({
            source,
            work_unit_id: workUnitId,
            fragment_ordinal: fragmentOrdinal,
            shard_kind: kind,
            source_range: { start_ordinal: start, end_ordinal_exclusive: start + 1 },
            auxiliary_items: [item],
          });
          const failed = createBookStructureFragmentWorkUnit({
            target: input.target,
            source,
            source_fingerprint: input.source_fingerprint,
            packet,
            contract: input.contracts.fragment,
            transport_profile: transportProfile,
            budget,
            evidence_lids: item.evidence_lids,
          });
          if (failed.status !== "blocked") throw new Error("atomic BookStructure shard fit changed");
          return {
            status: "blocked",
            recovery: budgetRecoveryForFragment({
              source,
              item_kind: kind,
              item_key: item.key,
              evaluation: failed.evaluation,
            }),
          };
        }
        workUnits.push(selected.work_unit);
        fragmentOrdinal += 1;
        itemStart = selected.end;
      }
    }
    start += 1;
  }

  const coverage = coverageManifest(source, workUnits);
  if (coverage.gap_count !== 0
    || coverage.core_overlap_count !== 0
    || coverage.covered_leaf_count !== coverage.expected_leaf_count) {
    throw new Error("BookStructure fragment router did not produce an exact leaf cover");
  }
  return { status: "ready", mode: "fragmented", work_units: workUnits, coverage };
}

export const BOOK_STRUCTURE_REDUCE_MAX_CHILDREN = 8 as const;

function createBookStructureReductionWorkUnit(input: {
  target: BuildTargetRefV2;
  parent_unit_lid: string;
  source_leaf_count: number;
  children: BookStructureReductionChildV1[];
  reducer_level: number;
  group_ordinal: number;
  role: "reduce" | "final";
  contracts: BookStructureExecutionContractsV2;
  transport_profile: ExecutorTransportProfileV2;
  budget: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
}): { status: "ready"; work_unit: BookStructureReductionRoutedWorkUnitV2 } | {
  status: "blocked";
  evaluation: Exclude<ReturnType<typeof evaluateBookStructureExecution>, { status: "within_limit" }>;
} {
  const sourceLeafRange = {
    start_ordinal: Math.min(...input.children.map((child) => child.source_leaf_range.start_ordinal)),
    end_ordinal_exclusive: Math.max(...input.children.map((child) => child.source_leaf_range.end_ordinal_exclusive)),
  };
  const workUnitId = `unit:${input.parent_unit_lid}:reduce:${String(input.reducer_level).padStart(3, "0")}:${
    String(input.group_ordinal).padStart(4, "0")
  }`;
  const packet: BookStructureReductionInputV1 = {
    version: "book_structure_reduction_input.v1",
    work_unit_id: workUnitId,
    parent_unit_lid: input.parent_unit_lid,
    reducer_level: input.reducer_level,
    group_ordinal: input.group_ordinal,
    role: input.role,
    source_leaf_range: sourceLeafRange,
    children: input.children.map((child) => ({
      work_unit_id: child.work_unit_id,
      artifact_hash: child.artifact_hash,
      source_leaf_range: { ...child.source_leaf_range },
      payload: child.payload,
    })),
  };
  const renderedInput = renderBookStructureReductionModelInput(packet);
  const evaluated = evaluateBookStructureExecution({
    contract: input.contracts.reduce,
    rendered_input: renderedInput,
    transport_profile: input.transport_profile,
    budget: input.budget,
  });
  if (evaluated.status !== "within_limit") return { status: "blocked", evaluation: evaluated };
  const dependencies = input.children.map((child) => ({
    artifact: child.work_unit_id,
    sha256: child.artifact_hash,
  }));
  const evidenceLids = [...new Set([
    input.parent_unit_lid,
    ...input.children.flatMap((child) => child.payload.evidence_lids),
  ])];
  const descriptor = proofBoundBookStructureDescriptor({
    target: input.target,
    work_unit_id: workUnitId,
    kind: "structure_reduce",
    rendered_input: renderedInput,
    proof: evaluated.proof,
    policy_fingerprint: input.contracts.reduce.policy_fingerprint,
    input_basis: {
      kind: "artifact_reduction",
      dependency_artifacts: dependencies.map((dependency) => ({
        work_unit_id: dependency.artifact,
        artifact_hash: dependency.sha256,
      })),
      parent_lids: evidenceLids,
    },
    evidence_lids: evidenceLids,
    dependencies,
    aggregation: { parent_lid: input.parent_unit_lid, role: input.role },
    candidate_count: input.children.reduce(
      (total, child) => total + child.payload.candidate_key_stops.length,
      0,
    ),
    expected_output_items: 1,
    transport_profile: input.transport_profile,
  });
  return {
    status: "ready",
    work_unit: {
      descriptor,
      rendered_input: renderedInput,
      route: {
        role: input.role,
        parent_unit_lid: input.parent_unit_lid,
        reducer_level: input.reducer_level,
        group_ordinal: input.group_ordinal,
        source_leaf_range: sourceLeafRange,
      },
      input: packet,
    },
  };
}

export function routeBookStructureReductionLevelV2(input: {
  target: BuildTargetRefV2;
  parent_unit_lid: string;
  source_leaf_count: number;
  children: BookStructureReductionChildV1[];
  contracts: BookStructureExecutionContractsV2;
  transport_profile?: ExecutorTransportProfileV2;
  budget?: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
  reducer_level?: number;
}): BookStructureReductionRouteResultV2 {
  if (!Number.isSafeInteger(input.source_leaf_count) || input.source_leaf_count < 1) {
    throw new Error("BookStructure reducer source_leaf_count must be positive");
  }
  if (!input.children.length) throw new Error("BookStructure reducer requires child artifacts");
  const transportProfile = input.transport_profile ?? CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  const budget = input.budget ?? BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
  const reducerLevel = input.reducer_level ?? 1;
  const children = input.children.map((child) => ({
    ...child,
    source_leaf_range: { ...child.source_leaf_range },
  })).sort((left, right) => left.source_leaf_range.start_ordinal - right.source_leaf_range.start_ordinal
    || left.source_leaf_range.end_ordinal_exclusive - right.source_leaf_range.end_ordinal_exclusive
    || left.work_unit_id.localeCompare(right.work_unit_id));
  const identities = new Set<string>();
  for (const child of children) {
    if (!child.work_unit_id || !/^[a-f0-9]{64}$/u.test(child.artifact_hash)) {
      throw new Error("BookStructure reducer child identity is invalid");
    }
    if (identities.has(child.work_unit_id)) throw new Error("BookStructure reducer child is duplicated");
    identities.add(child.work_unit_id);
    if (child.source_leaf_range.start_ordinal < 0
      || child.source_leaf_range.end_ordinal_exclusive <= child.source_leaf_range.start_ordinal
      || child.source_leaf_range.end_ordinal_exclusive > input.source_leaf_count) {
      throw new Error("BookStructure reducer child leaf range is invalid");
    }
  }

  if (children.length <= BOOK_STRUCTURE_REDUCE_MAX_CHILDREN) {
    const final = createBookStructureReductionWorkUnit({
      target: input.target,
      parent_unit_lid: input.parent_unit_lid,
      source_leaf_count: input.source_leaf_count,
      children,
      reducer_level: reducerLevel,
      group_ordinal: 0,
      role: "final",
      contracts: input.contracts,
      transport_profile: transportProfile,
      budget,
    });
    if (final.status === "ready") {
      return { status: "ready", role: "final", work_units: [final.work_unit] };
    }
  }

  const workUnits: BookStructureReductionRoutedWorkUnitV2[] = [];
  let start = 0;
  while (start < children.length) {
    let end = Math.min(children.length, start + BOOK_STRUCTURE_REDUCE_MAX_CHILDREN);
    let selected: ReturnType<typeof createBookStructureReductionWorkUnit> | undefined;
    while (end > start) {
      const candidate = createBookStructureReductionWorkUnit({
        target: input.target,
        parent_unit_lid: input.parent_unit_lid,
        source_leaf_count: input.source_leaf_count,
        children: children.slice(start, end),
        reducer_level: reducerLevel,
        group_ordinal: workUnits.length,
        role: "reduce",
        contracts: input.contracts,
        transport_profile: transportProfile,
        budget,
      });
      if (candidate.status === "ready") {
        selected = candidate;
        break;
      }
      end -= 1;
    }
    if (!selected || selected.status !== "ready") {
      const child = children[start];
      const failed = createBookStructureReductionWorkUnit({
        target: input.target,
        parent_unit_lid: input.parent_unit_lid,
        source_leaf_count: input.source_leaf_count,
        children: [child],
        reducer_level: reducerLevel,
        group_ordinal: workUnits.length,
        role: "reduce",
        contracts: input.contracts,
        transport_profile: transportProfile,
        budget,
      });
      if (failed.status !== "blocked") throw new Error("BookStructure reducer atomic fit changed");
      return {
        status: "blocked",
        recovery: {
          code: "budget/atomic_input_item_too_large",
          stage: "book_structure",
          parent_unit_lid: input.parent_unit_lid,
          item_kind: "reducer_child",
          item_key: child.work_unit_id,
          estimated_tokens: failed.evaluation.estimated_rendered_tokens,
          limit_tokens: failed.evaluation.effective_body_limit_tokens,
        },
      };
    }
    workUnits.push(selected.work_unit);
    start = end;
  }
  if (workUnits.length >= children.length) {
    return {
      status: "blocked",
      recovery: {
        code: "budget/reducer_fan_in_unsplittable",
        stage: "book_structure",
        parent_unit_lid: input.parent_unit_lid,
        item_kind: "reducer_child",
        estimated_tokens: Math.max(...workUnits.map((unit) => unit.descriptor.cost.estimated_input_tokens)),
        limit_tokens: Math.min(...workUnits.map(
          (unit) => unit.descriptor.execution_budget_proof.effective_body_limit_tokens,
        )),
      },
    };
  }
  return { status: "ready", role: "reduce", work_units: workUnits };
}

function bookStructureUnitCardEvidenceLids(card: BookStructureUnitCard): string[] {
  return [
    card.unit_lid,
    ...card.evidence_lids,
    ...card.summary.evidence_lids,
    ...card.depends_on,
    ...card.candidate_key_stops.flatMap((stop) => [
      stop.lid,
      ...stop.reason.evidence_lids,
    ]),
  ];
}

function bookStructureCandidateEvidenceLids(candidate: BookStructureCandidate): string[] {
  return [
    ...(candidate.spine ?? []).flatMap((unit) => [
      unit.lid,
      ...unit.depends_on,
      ...unit.summary.evidence_lids,
    ]),
    ...(candidate.throughlines ?? []).flatMap((throughline) => [
      ...throughline.lids,
      ...throughline.summary.evidence_lids,
    ]),
    ...(candidate.key_stops ?? []).flatMap((stop) => [
      stop.lid,
      ...stop.reason.evidence_lids,
    ]),
  ];
}

function bookStructureStitchFragmentPacket(input: {
  packet: BookStructureStitchPacket;
  work_unit_id: string;
  fragment_ordinal: number;
  unit_card_range: BookStructureLeafRangeV1;
}): BookStructureStitchFragmentInputV1 {
  const unitCards = input.packet.unit_cards.slice(
    input.unit_card_range.start_ordinal,
    input.unit_card_range.end_ordinal_exclusive,
  );
  const visibleLids = new Set(unitCards.flatMap(bookStructureUnitCardEvidenceLids));
  return {
    version: "book_structure_stitch_fragment_input.v1",
    work_unit_id: input.work_unit_id,
    fragment_ordinal: input.fragment_ordinal,
    unit_card_range: { ...input.unit_card_range },
    ...(input.packet.profile_rules ? { profile_rules: input.packet.profile_rules } : {}),
    unit_cards: unitCards,
    long_range_edges: input.packet.long_range_edges.filter((edge) => (
      edge.evidence_lids.some((lid) => visibleLids.has(lid))
    )),
  };
}

function createBookStructureStitchFragmentWorkUnit(input: {
  target: BuildTargetRefV2;
  source_fingerprint: string;
  packet: BookStructureStitchFragmentInputV1;
  contract: BookStructureExecutionContractV2;
  transport_profile: ExecutorTransportProfileV2;
  budget: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
}): { status: "ready"; work_unit: BookStructureStitchRoutedWorkUnitV2 } | {
  status: "blocked";
  evaluation: Exclude<ReturnType<typeof evaluateBookStructureExecution>, { status: "within_limit" }>;
} {
  const renderedInput = renderBookStructureStitchFragmentModelInput(input.packet);
  const evaluated = evaluateBookStructureExecution({
    contract: input.contract,
    rendered_input: renderedInput,
    transport_profile: input.transport_profile,
    budget: input.budget,
  });
  if (evaluated.status !== "within_limit") return { status: "blocked", evaluation: evaluated };
  const evidenceLids = [...new Set([
    "stitch",
    ...input.packet.unit_cards.flatMap(bookStructureUnitCardEvidenceLids),
    ...input.packet.long_range_edges.flatMap((edge) => edge.evidence_lids),
  ])];
  const descriptor = proofBoundBookStructureDescriptor({
    target: input.target,
    work_unit_id: input.packet.work_unit_id,
    kind: "structure_stitch_fragment",
    rendered_input: renderedInput,
    proof: evaluated.proof,
    policy_fingerprint: input.contract.policy_fingerprint,
    input_basis: {
      kind: "semantic_projection",
      projection_kind: "book_structure",
      source_fingerprint: input.source_fingerprint,
      projection_sha256: sha256Json(input.packet),
      parent_lids: evidenceLids,
      core_range: { ...input.packet.unit_card_range },
    },
    evidence_lids: evidenceLids,
    aggregation: { parent_lid: "stitch", role: "fragment" },
    candidate_count: input.packet.unit_cards.length,
    expected_output_items: input.packet.unit_cards.length,
    transport_profile: input.transport_profile,
  });
  return {
    status: "ready",
    work_unit: {
      descriptor,
      rendered_input: renderedInput,
      route: {
        role: "fragment",
        fragment_ordinal: input.packet.fragment_ordinal,
        unit_card_range: { ...input.packet.unit_card_range },
      },
      input: input.packet,
    },
  };
}

function bookStructureStitchCoverage(
  packet: BookStructureStitchPacket,
  workUnits: BookStructureStitchRoutedWorkUnitV2[],
): BookStructureStitchCoverageManifestV1 {
  const ranges = workUnits.map((workUnit) => {
    const range = workUnit.route.role === "whole"
      ? { start_ordinal: 0, end_ordinal_exclusive: packet.unit_cards.length }
      : workUnit.route.unit_card_range;
    return {
      ...range,
      work_unit_id: workUnit.descriptor.work_unit_id,
      unit_lids: packet.unit_cards
        .slice(range.start_ordinal, range.end_ordinal_exclusive)
        .map((card) => card.unit_lid),
    };
  }).sort((left, right) => left.start_ordinal - right.start_ordinal);
  let cursor = 0;
  let covered = 0;
  let gaps = 0;
  let overlaps = 0;
  for (const range of ranges) {
    if (range.start_ordinal > cursor) gaps += range.start_ordinal - cursor;
    if (range.start_ordinal < cursor) overlaps += cursor - range.start_ordinal;
    covered += range.end_ordinal_exclusive - range.start_ordinal;
    cursor = Math.max(cursor, range.end_ordinal_exclusive);
  }
  if (cursor < packet.unit_cards.length) gaps += packet.unit_cards.length - cursor;
  const unsigned = {
    version: "book_structure_stitch_coverage.v1" as const,
    expected_unit_card_count: packet.unit_cards.length,
    covered_unit_card_count: covered,
    gap_count: gaps,
    overlap_count: overlaps,
    ranges,
  };
  return { ...unsigned, coverage_digest: sha256Json(unsigned) };
}

export function routeBookStructureStitchWorkUnitsV2(input: {
  target: BuildTargetRefV2;
  packet: BookStructureStitchPacket;
  source_fingerprint: string;
  contracts: BookStructureExecutionContractsV2;
  transport_profile?: ExecutorTransportProfileV2;
  budget?: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
}): BookStructureStitchRouteResultV2 {
  if (!input.packet.unit_cards.length) {
    throw new Error("BookStructure stitch requires at least one unit card");
  }
  const unitLids = input.packet.unit_cards.map((card) => card.unit_lid);
  if (new Set(unitLids).size !== unitLids.length) {
    throw new Error("BookStructure stitch unit cards must have unique unit_lid values");
  }
  const transportProfile = input.transport_profile ?? CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  const budget = input.budget ?? BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
  const wholeRendered = renderBookStructureModelInput(input.packet);
  const wholeEvaluation = evaluateBookStructureExecution({
    contract: input.contracts.stitch,
    rendered_input: wholeRendered,
    transport_profile: transportProfile,
    budget,
  });
  if (wholeEvaluation.status === "within_limit") {
    const evidenceLids = [...new Set([
      "stitch",
      ...input.packet.unit_cards.flatMap(bookStructureUnitCardEvidenceLids),
      ...input.packet.long_range_edges.flatMap((edge) => edge.evidence_lids),
    ])];
    const descriptor = proofBoundBookStructureDescriptor({
      target: input.target,
      work_unit_id: "stitch",
      kind: "structure_stitch",
      rendered_input: wholeRendered,
      proof: wholeEvaluation.proof,
      policy_fingerprint: input.contracts.stitch.policy_fingerprint,
      input_basis: {
        kind: "semantic_projection",
        projection_kind: "book_structure",
        source_fingerprint: input.source_fingerprint,
        projection_sha256: bookStructureStitchHash(input.packet),
        parent_lids: evidenceLids,
        core_range: { start_ordinal: 0, end_ordinal_exclusive: input.packet.unit_cards.length },
      },
      evidence_lids: evidenceLids,
      candidate_count: input.packet.unit_cards.length,
      expected_output_items: input.packet.unit_cards.length,
      transport_profile: transportProfile,
    });
    const workUnit: BookStructureStitchRoutedWorkUnitV2 = {
      descriptor,
      rendered_input: wholeRendered,
      route: { role: "whole" },
      input: input.packet,
    };
    return {
      status: "ready",
      mode: "whole",
      work_units: [workUnit],
      coverage: bookStructureStitchCoverage(input.packet, [workUnit]),
    };
  }

  const workUnits: BookStructureStitchRoutedWorkUnitV2[] = [];
  let start = 0;
  while (start < input.packet.unit_cards.length) {
    let low = start + 1;
    let high = input.packet.unit_cards.length;
    let selected: { end: number; work_unit: BookStructureStitchRoutedWorkUnitV2 } | undefined;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const fragmentOrdinal = workUnits.length;
      const packet = bookStructureStitchFragmentPacket({
        packet: input.packet,
        work_unit_id: "stitch:fragment:" + String(fragmentOrdinal).padStart(4, "0"),
        fragment_ordinal: fragmentOrdinal,
        unit_card_range: { start_ordinal: start, end_ordinal_exclusive: end },
      });
      const candidate = createBookStructureStitchFragmentWorkUnit({
        target: input.target,
        source_fingerprint: input.source_fingerprint,
        packet,
        contract: input.contracts.stitch_fragment,
        transport_profile: transportProfile,
        budget,
      });
      if (candidate.status === "ready") {
        selected = { end, work_unit: candidate.work_unit };
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (!selected) {
      const card = input.packet.unit_cards[start];
      const fragmentOrdinal = workUnits.length;
      const packet = bookStructureStitchFragmentPacket({
        packet: input.packet,
        work_unit_id: "stitch:fragment:" + String(fragmentOrdinal).padStart(4, "0"),
        fragment_ordinal: fragmentOrdinal,
        unit_card_range: { start_ordinal: start, end_ordinal_exclusive: start + 1 },
      });
      const failed = createBookStructureStitchFragmentWorkUnit({
        target: input.target,
        source_fingerprint: input.source_fingerprint,
        packet,
        contract: input.contracts.stitch_fragment,
        transport_profile: transportProfile,
        budget,
      });
      if (failed.status !== "blocked") throw new Error("atomic BookStructure stitch fit changed");
      return {
        status: "blocked",
        recovery: {
          code: "budget/atomic_input_item_too_large",
          stage: "book_structure",
          parent_unit_lid: "stitch",
          item_kind: "unit_card",
          item_key: card.unit_lid,
          estimated_tokens: failed.evaluation.estimated_rendered_tokens,
          limit_tokens: failed.evaluation.effective_body_limit_tokens,
        },
      };
    }
    workUnits.push(selected.work_unit);
    start = selected.end;
  }
  const coverage = bookStructureStitchCoverage(input.packet, workUnits);
  if (coverage.gap_count !== 0
    || coverage.overlap_count !== 0
    || coverage.covered_unit_card_count !== coverage.expected_unit_card_count) {
    throw new Error("BookStructure stitch fragment router did not produce an exact unit-card cover");
  }
  return { status: "ready", mode: "fragmented", work_units: workUnits, coverage };
}

export const BOOK_STRUCTURE_STITCH_REDUCE_MAX_CHILDREN = 8 as const;

function createBookStructureStitchReductionWorkUnit(input: {
  target: BuildTargetRefV2;
  unit_card_count: number;
  children: BookStructureStitchReductionChildV1[];
  reducer_level: number;
  group_ordinal: number;
  role: "reduce" | "final";
  contracts: BookStructureExecutionContractsV2;
  transport_profile: ExecutorTransportProfileV2;
  budget: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
}): { status: "ready"; work_unit: BookStructureStitchReductionRoutedWorkUnitV2 } | {
  status: "blocked";
  evaluation: Exclude<ReturnType<typeof evaluateBookStructureExecution>, { status: "within_limit" }>;
} {
  const unitCardRange = {
    start_ordinal: Math.min(...input.children.map((child) => child.unit_card_range.start_ordinal)),
    end_ordinal_exclusive: Math.max(...input.children.map(
      (child) => child.unit_card_range.end_ordinal_exclusive,
    )),
  };
  const workUnitId = "stitch:reduce:"
    + String(input.reducer_level).padStart(3, "0")
    + ":"
    + String(input.group_ordinal).padStart(4, "0");
  const packet: BookStructureStitchReductionInputV1 = {
    version: "book_structure_stitch_reduction_input.v1",
    work_unit_id: workUnitId,
    reducer_level: input.reducer_level,
    group_ordinal: input.group_ordinal,
    role: input.role,
    unit_card_range: unitCardRange,
    children: input.children.map((child) => ({
      work_unit_id: child.work_unit_id,
      artifact_hash: child.artifact_hash,
      unit_card_range: { ...child.unit_card_range },
      payload: child.payload,
    })),
  };
  const renderedInput = renderBookStructureStitchReductionModelInput(packet);
  const evaluated = evaluateBookStructureExecution({
    contract: input.contracts.stitch_reduce,
    rendered_input: renderedInput,
    transport_profile: input.transport_profile,
    budget: input.budget,
  });
  if (evaluated.status !== "within_limit") return { status: "blocked", evaluation: evaluated };
  const dependencies = input.children.map((child) => ({
    artifact: child.work_unit_id,
    sha256: child.artifact_hash,
  }));
  const evidenceLids = [...new Set([
    "stitch",
    ...input.children.flatMap((child) => bookStructureCandidateEvidenceLids(child.payload)),
  ])];
  const descriptor = proofBoundBookStructureDescriptor({
    target: input.target,
    work_unit_id: workUnitId,
    kind: "structure_stitch_reduce",
    rendered_input: renderedInput,
    proof: evaluated.proof,
    policy_fingerprint: input.contracts.stitch_reduce.policy_fingerprint,
    input_basis: {
      kind: "artifact_reduction",
      dependency_artifacts: dependencies.map((dependency) => ({
        work_unit_id: dependency.artifact,
        artifact_hash: dependency.sha256,
      })),
      parent_lids: evidenceLids,
    },
    evidence_lids: evidenceLids,
    dependencies,
    aggregation: { parent_lid: "stitch", role: input.role },
    candidate_count: input.children.length,
    expected_output_items: input.unit_card_count,
    transport_profile: input.transport_profile,
  });
  return {
    status: "ready",
    work_unit: {
      descriptor,
      rendered_input: renderedInput,
      route: {
        role: input.role,
        reducer_level: input.reducer_level,
        group_ordinal: input.group_ordinal,
        unit_card_range: unitCardRange,
      },
      input: packet,
    },
  };
}

export function routeBookStructureStitchReductionLevelV2(input: {
  target: BuildTargetRefV2;
  unit_card_count: number;
  children: BookStructureStitchReductionChildV1[];
  contracts: BookStructureExecutionContractsV2;
  transport_profile?: ExecutorTransportProfileV2;
  budget?: typeof BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
  reducer_level?: number;
}): BookStructureStitchReductionRouteResultV2 {
  if (!Number.isSafeInteger(input.unit_card_count) || input.unit_card_count < 1) {
    throw new Error("BookStructure stitch reducer unit_card_count must be positive");
  }
  if (!input.children.length) throw new Error("BookStructure stitch reducer requires child artifacts");
  const transportProfile = input.transport_profile ?? CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  const budget = input.budget ?? BOOK_STRUCTURE_EXECUTION_BUDGET_V2;
  const reducerLevel = input.reducer_level ?? 1;
  const children = input.children.map((child) => ({
    ...child,
    unit_card_range: { ...child.unit_card_range },
  })).sort((left, right) => left.unit_card_range.start_ordinal - right.unit_card_range.start_ordinal
    || left.unit_card_range.end_ordinal_exclusive - right.unit_card_range.end_ordinal_exclusive
    || left.work_unit_id.localeCompare(right.work_unit_id));
  const identities = new Set<string>();
  let cursor = 0;
  for (const child of children) {
    if (!child.work_unit_id || !/^[a-f0-9]{64}$/u.test(child.artifact_hash)) {
      throw new Error("BookStructure stitch reducer child identity is invalid");
    }
    if (identities.has(child.work_unit_id)) {
      throw new Error("BookStructure stitch reducer child is duplicated");
    }
    identities.add(child.work_unit_id);
    if (child.unit_card_range.start_ordinal !== cursor
      || child.unit_card_range.end_ordinal_exclusive <= child.unit_card_range.start_ordinal
      || child.unit_card_range.end_ordinal_exclusive > input.unit_card_count) {
      throw new Error("BookStructure stitch reducer children must exactly cover unit cards");
    }
    cursor = child.unit_card_range.end_ordinal_exclusive;
  }
  if (cursor !== input.unit_card_count) {
    throw new Error("BookStructure stitch reducer children must exactly cover unit cards");
  }

  if (children.length <= BOOK_STRUCTURE_STITCH_REDUCE_MAX_CHILDREN) {
    const final = createBookStructureStitchReductionWorkUnit({
      target: input.target,
      unit_card_count: input.unit_card_count,
      children,
      reducer_level: reducerLevel,
      group_ordinal: 0,
      role: "final",
      contracts: input.contracts,
      transport_profile: transportProfile,
      budget,
    });
    if (final.status === "ready") {
      return { status: "ready", role: "final", work_units: [final.work_unit] };
    }
  }

  const workUnits: BookStructureStitchReductionRoutedWorkUnitV2[] = [];
  let start = 0;
  while (start < children.length) {
    let end = Math.min(children.length, start + BOOK_STRUCTURE_STITCH_REDUCE_MAX_CHILDREN);
    let selected: ReturnType<typeof createBookStructureStitchReductionWorkUnit> | undefined;
    while (end > start) {
      const candidate = createBookStructureStitchReductionWorkUnit({
        target: input.target,
        unit_card_count: input.unit_card_count,
        children: children.slice(start, end),
        reducer_level: reducerLevel,
        group_ordinal: workUnits.length,
        role: "reduce",
        contracts: input.contracts,
        transport_profile: transportProfile,
        budget,
      });
      if (candidate.status === "ready") {
        selected = candidate;
        break;
      }
      end -= 1;
    }
    if (!selected || selected.status !== "ready") {
      const child = children[start];
      const failed = createBookStructureStitchReductionWorkUnit({
        target: input.target,
        unit_card_count: input.unit_card_count,
        children: [child],
        reducer_level: reducerLevel,
        group_ordinal: workUnits.length,
        role: "reduce",
        contracts: input.contracts,
        transport_profile: transportProfile,
        budget,
      });
      if (failed.status !== "blocked") throw new Error("atomic BookStructure stitch reducer fit changed");
      return {
        status: "blocked",
        recovery: {
          code: "budget/atomic_input_item_too_large",
          stage: "book_structure",
          parent_unit_lid: "stitch",
          item_kind: "stitch_reducer_child",
          item_key: child.work_unit_id,
          estimated_tokens: failed.evaluation.estimated_rendered_tokens,
          limit_tokens: failed.evaluation.effective_body_limit_tokens,
        },
      };
    }
    workUnits.push(selected.work_unit);
    start = end;
  }
  if (workUnits.length >= children.length) {
    return {
      status: "blocked",
      recovery: {
        code: "budget/reducer_fan_in_unsplittable",
        stage: "book_structure",
        parent_unit_lid: "stitch",
        item_kind: "stitch_reducer_child",
        estimated_tokens: Math.max(...workUnits.map(
          (workUnit) => workUnit.descriptor.cost.estimated_input_tokens,
        )),
        limit_tokens: Math.min(...workUnits.map(
          (workUnit) => workUnit.descriptor.execution_budget_proof.effective_body_limit_tokens,
        )),
      },
    };
  }
  return { status: "ready", role: "reduce", work_units: workUnits };
}

function bookStructureProfileRules(profile: ContentProfileDefinition): BookStructureProfileRules | undefined {
  if (profile.id !== PAPER_PROFILE_ID) return undefined;
  return {
    rule_pack: "PAPER_BOOK_STRUCTURE_RULES",
    content_profile: PAPER_PROFILE_ID,
    paper_subtype: profile.paper.paper_subtype,
    book_structure_rules: profile.paper.effective_rules.book_structure_rules,
    unit_mapping: [
      "abstract",
      "introduction",
      "related_work",
      "method",
      "experiment",
      "result",
      "discussion",
      "limitation",
      "conclusion",
    ],
    spine_strategy: "map paper sections into the shared setup/foundation/method/application/case/synthesis roles without adding paper-only roles",
    throughline_strategy: "track research question, method-to-result chain, evidence-to-claim support, limitations, and future-work implications",
    key_stop_strategy: "prefer contribution, research question, method, experiment design, central result, limitation, and conclusion stops with true LID evidence",
    metadata_policy: "do not emit title/authors/venue/year/references; metadata stays in paper_metadata.json",
  };
}

export function bookStructureUnitHash(source: BookStructureUnitSource): string {
  return sha256Json(source);
}

export function bookStructureStitchHash(packet: BookStructureStitchPacket): string {
  return sha256Json(packet);
}

export function buildBookStructureUnitSources(input: {
  lidNodes: LidNode[];
  source: string;
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
  discourseIndex?: TechnicalLearningDiscourseIndex;
  formulaSemantics?: FormulaSemantics[];
  pass2Audit?: Pass2BuildAuditSidecar;
  contentProfile?: ContentProfileDefinition;
}): BookStructureUnitSource[] {
  const byLid = new Map(input.lidNodes.map((node) => [node.lid, node]));
  const units = selectStructureUnits(input.lidNodes, byLid);
  const discourseByLid = new Map((input.discourseIndex?.items ?? []).map((item) => [item.lid, item]));
  const formulaByLid = new Map((input.formulaSemantics ?? []).map((item) => [item.formula_lid, item]));
  const profileRules = bookStructureProfileRules(input.contentProfile ?? TECHNICAL_LEARNING_PROFILE);

  return units.map((unit) => {
    const leafLids = nodeLeaves(unit, byLid);
    const leafSet = new Set(leafLids);
    const graphNodes = (input.graphNodes ?? [])
      .filter((node) => graphNodeLids(node).some((lid) => leafSet.has(lid)))
      .sort((a, b) => a.id.localeCompare(b.id));
    const graphNodeIds = new Set(graphNodes.map((node) => node.id));
    return {
      job_id: `unit:${unit.lid}`,
      unit_lid: unit.lid,
      unit_kind: unit.kind,
      title_path: titlePathOf(unit.lid),
      ...(profileRules ? { profile_rules: profileRules } : {}),
      leaf_lids: leafLids,
      excerpts: leafLids.map((lid) => {
        const node = byLid.get(lid);
        const text = node ? input.source.slice(node.span.start, node.span.end).trim() : "";
        return { lid, text: text.slice(0, MAX_BOOK_STRUCTURE_EXCERPT_LEN) };
      }),
      graph_nodes: graphNodes,
      graph_edges: (input.graphEdges ?? [])
        .filter((edge) => edgeTouchesNode(edge, graphNodeIds))
        .sort((a, b) => `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`)),
      discourse_items: leafLids
        .map((lid) => discourseByLid.get(lid))
        .filter((item): item is TechnicalLearningDiscourseItem => item !== undefined),
      formula_semantics: leafLids
        .map((lid) => formulaByLid.get(lid))
        .filter((item): item is FormulaSemantics => item !== undefined),
      pass2_edges: pass2EdgesFor(leafSet, input.pass2Audit),
    };
  });
}

export function buildBookStructureUnitArtifact(
  source: BookStructureUnitSource,
  output: BookStructureUnitExtractionOutput,
): BookStructureUnitArtifact {
  if (output.unit_card.unit_lid !== source.unit_lid) {
    throw new Error(`unit_card.unit_lid ${output.unit_card.unit_lid} does not match ${source.unit_lid}`);
  }
  return {
    content_hash: bookStructureUnitHash(source),
    output,
  };
}

export function buildBookStructureStitchPacket(
  unitArtifacts: BookStructureUnitArtifact[],
  pass2Audit?: Pass2BuildAuditSidecar,
  contentProfile: ContentProfileDefinition = TECHNICAL_LEARNING_PROFILE,
): BookStructureStitchPacket {
  const profileRules = bookStructureProfileRules(contentProfile);
  return {
    job_id: "stitch",
    ...(profileRules ? { profile_rules: profileRules } : {}),
    unit_cards: unitArtifacts.map((artifact) => artifact.output.unit_card),
    long_range_edges: [...(pass2Audit?.accepted ?? []), ...(pass2Audit?.pending ?? [])].sort((a, b) =>
      a.candidate_id.localeCompare(b.candidate_id),
    ),
  };
}

export function buildBookStructureStitchArtifact(
  packet: BookStructureStitchPacket,
  output: BookStructureCandidate,
): BookStructureStitchArtifact {
  return {
    content_hash: bookStructureStitchHash(packet),
    output,
  };
}

export function computeBookStructureStatus(
  unitSources: BookStructureUnitSource[],
  existingUnits: Map<string, Pick<BookStructureUnitArtifact, "content_hash">>,
  existingStitch?: Pick<BookStructureStitchArtifact, "content_hash">,
  stitchPacket?: BookStructureStitchPacket,
): BookStructureStatus {
  const unitDone: string[] = [];
  const unitPending: string[] = [];
  for (const source of unitSources) {
    const got = existingUnits.get(source.job_id);
    if (got?.content_hash === bookStructureUnitHash(source)) unitDone.push(source.job_id);
    else unitPending.push(source.job_id);
  }

  const stitchBlocked = unitPending.length > 0 || !stitchPacket;
  const stitchDone = !stitchBlocked && existingStitch?.content_hash === bookStructureStitchHash(stitchPacket);
  return {
    unit_done: unitDone,
    unit_pending: unitPending,
    stitch_done: Boolean(stitchDone),
    stitch_pending: !stitchBlocked && !stitchDone,
    stitch_blocked: stitchBlocked,
  };
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function drop(
  dropped: DroppedBookStructureCandidate[],
  kind: BookStructureDropKind,
  id: string,
  reason: BookStructureDropReason,
  detail: string,
) {
  dropped.push({ kind, id, reason, detail });
}

function anchoredTextError(text: AnchoredText, lids: Set<string>): BookStructureDropReason | null {
  if (!nonEmpty(text.text)) return "empty_text";
  if (text.text.length > MAX_BOOK_STRUCTURE_TEXT_LEN) return "summary_too_long";
  if (text.evidence_lids.length === 0) return "empty_evidence";
  if (text.evidence_lids.some((lid) => !lids.has(lid))) return "dangling_evidence";
  return null;
}

function filterExistingLids(
  values: string[],
  lids: Set<string>,
  dropped: DroppedBookStructureCandidate[],
  ownerKind: BookStructureDropKind,
  ownerId: string,
): string[] {
  const out: string[] = [];
  for (const lid of values) {
    if (lids.has(lid)) out.push(lid);
    else drop(dropped, "reference", ownerId, "dangling_reference", `${ownerKind} references missing LID ${lid}`);
  }
  return out;
}

function filterKeyStopIds(
  values: string[],
  acceptedIds: Set<string>,
  dropped: DroppedBookStructureCandidate[],
  ownerKind: BookStructureDropKind,
  ownerId: string,
): string[] {
  const out: string[] = [];
  for (const id of values) {
    if (acceptedIds.has(id)) out.push(id);
    else drop(dropped, "reference", ownerId, "dangling_reference", `${ownerKind} references missing key_stop ${id}`);
  }
  return out;
}

export function buildBookStructureSidecar(
  header: ProfileArtifactHeader,
  candidate: BookStructureCandidate,
  nodes: LidNode[],
): BookStructureBuildResult {
  const lids = lidSet(nodes);
  const dropped: DroppedBookStructureCandidate[] = [];
  const keyStops: BookStructureKeyStop[] = [];
  const keyStopIds = new Set<string>();

  for (const keyStop of candidate.key_stops ?? []) {
    if (!nonEmpty(keyStop.id)) {
      drop(dropped, "key_stop", keyStop.id, "empty_id", "key_stop id is required");
      continue;
    }
    if (keyStopIds.has(keyStop.id)) {
      drop(dropped, "key_stop", keyStop.id, "duplicate_id", keyStop.id);
      continue;
    }
    if (!lids.has(keyStop.lid)) {
      drop(dropped, "key_stop", keyStop.id, "missing_lid", keyStop.lid);
      continue;
    }
    if (!KEY_STOP_TYPES.has(keyStop.type)) {
      drop(dropped, "key_stop", keyStop.id, "invalid_key_stop_type", keyStop.type);
      continue;
    }
    const reasonError = anchoredTextError(keyStop.reason, lids);
    if (reasonError) {
      drop(dropped, "key_stop", keyStop.id, reasonError, JSON.stringify(keyStop.reason));
      continue;
    }
    keyStopIds.add(keyStop.id);
    keyStops.push(keyStop);
  }

  const spine: BookStructureSpineUnit[] = [];
  for (const unit of candidate.spine ?? []) {
    if (!lids.has(unit.lid)) {
      drop(dropped, "spine_unit", unit.lid, "missing_lid", unit.lid);
      continue;
    }
    if (!SPINE_ROLES.has(unit.role)) {
      drop(dropped, "spine_unit", unit.lid, "invalid_role", unit.role);
      continue;
    }
    const summaryError = anchoredTextError(unit.summary, lids);
    if (summaryError) {
      drop(dropped, "spine_unit", unit.lid, summaryError, JSON.stringify(unit.summary));
      continue;
    }
    spine.push({
      ...unit,
      depends_on: filterExistingLids(unit.depends_on, lids, dropped, "spine_unit", unit.lid),
      key_stop_ids: filterKeyStopIds(unit.key_stop_ids, keyStopIds, dropped, "spine_unit", unit.lid),
    });
  }

  const throughlines: BookStructureThroughline[] = [];
  const threadIds = new Set<string>();
  for (const thread of candidate.throughlines ?? []) {
    if (!nonEmpty(thread.id)) {
      drop(dropped, "throughline", thread.id, "empty_id", "throughline id is required");
      continue;
    }
    if (threadIds.has(thread.id)) {
      drop(dropped, "throughline", thread.id, "duplicate_id", thread.id);
      continue;
    }
    if (!nonEmpty(thread.name)) {
      drop(dropped, "throughline", thread.id, "empty_name", "throughline name is required");
      continue;
    }
    const summaryError = anchoredTextError(thread.summary, lids);
    if (summaryError) {
      drop(dropped, "throughline", thread.id, summaryError, JSON.stringify(thread.summary));
      continue;
    }
    const threadLids = filterExistingLids(thread.lids, lids, dropped, "throughline", thread.id);
    if (threadLids.length === 0) {
      drop(dropped, "throughline", thread.id, "missing_lid", "throughline must reference at least one existing LID");
      continue;
    }
    threadIds.add(thread.id);
    throughlines.push({
      ...thread,
      lids: threadLids,
      key_stop_ids: filterKeyStopIds(thread.key_stop_ids, keyStopIds, dropped, "throughline", thread.id),
    });
  }

  return {
    sidecar: {
      header,
      spine,
      throughlines,
      key_stops: keyStops,
    },
    dropped,
  };
}
