import { createHash } from "node:crypto";
import type { BookStructureStitchPacket, BookStructureUnitSource } from "./book-structure";
import type { PaperMetadataCandidatePacket } from "./paper-metadata-router";
import type { PaperLexiconCandidatePacketV2 } from "./paper-lexicon-router";
import type { Pass1Input } from "./pass1-input";
import type { Pass2WorkPacket } from "./pass2-build";
import type { ProfileSidecarSemanticPacketV2 } from "./profile-sidecar-router";
import type { ModelInputSliceRenderContextV1 } from "./model-input-slice";
import { estimateTokens } from "./window";

export const MODEL_INPUT_RENDER_CONTRACT_VERSION = "model_input_render.v1" as const;

export interface ProfileSidecarDiscourseFragmentRenderInputV1 extends ModelInputSliceRenderContextV1 {
  content_profile_id: string;
}

export interface Pass1SourceFragmentRenderInputV1 extends ModelInputSliceRenderContextV1 {
  content_profile_id: string;
  core_sha256: string;
}

export interface Pass1LidStitchRenderChildV1 {
  work_unit_id: string;
  artifact_hash: string;
  source_unit_range: {
    start_ordinal: number;
    end_ordinal_exclusive: number;
  };
  payload: unknown;
}

export interface Pass1LidStitchRenderInputV1 {
  version: "pass1_lid_stitch_input.v1";
  work_unit_id: string;
  window_id: number;
  reducer_level: number;
  group_ordinal: number;
  role: "stitch" | "final";
  source_unit_range: {
    start_ordinal: number;
    end_ordinal_exclusive: number;
  };
  children: Pass1LidStitchRenderChildV1[];
}

export interface ProfileSidecarDiscourseReductionRenderChildV1 {
  work_unit_id: string;
  artifact_hash: string;
  source_slice_range: {
    start_ordinal: number;
    end_ordinal_exclusive: number;
  };
  payload: unknown;
}

export interface ProfileSidecarDiscourseReductionRenderInputV1 {
  version: "profile_sidecar_discourse_reduction_input.v1";
  work_unit_id: string;
  parent_lid: string;
  reducer_level: number;
  group_ordinal: number;
  role: "reduce" | "final";
  source_slice_range: {
    start_ordinal: number;
    end_ordinal_exclusive: number;
  };
  children: ProfileSidecarDiscourseReductionRenderChildV1[];
}

export type ModelInputRenderRequest =
  | { kind: "pass1_window"; input: Pick<Pass1Input, "text"> }
  | { kind: "pass1_source_slice"; input: Pass1SourceFragmentRenderInputV1 }
  | { kind: "pass1_lid_stitch"; input: Pass1LidStitchRenderInputV1 }
  | {
      kind: "profile_sidecar_discourse" | "profile_sidecar_formula";
      input: Pick<
        ProfileSidecarSemanticPacketV2,
        "work_unit_id" | "unit_kind" | "visible_lids" | "formula_lids" | "text"
      >;
    }
  | { kind: "profile_sidecar_discourse_fragment"; input: ProfileSidecarDiscourseFragmentRenderInputV1 }
  | { kind: "profile_sidecar_discourse_reduce"; input: ProfileSidecarDiscourseReductionRenderInputV1 }
  | {
      kind: "metadata_region";
      input: Pick<
        PaperMetadataCandidatePacket,
        "window_id" | "visible_lids" | "signal_types" | "requested_fields" | "text"
      >;
    }
  | {
      kind: "lexicon_candidate_batch";
      input: Pick<
        PaperLexiconCandidatePacketV2,
        "work_unit_id" | "visible_lids" | "requested_term_types" | "candidate_clusters" | "text"
      >;
    }
  | { kind: "pass2_candidate_batch"; input: Pass2WorkPacket }
  | { kind: "structure_unit"; input: BookStructureUnitSource }
  | { kind: "structure_stitch"; input: BookStructureStitchPacket };

export interface RenderedModelInputV1 {
  version: "rendered_model_input.v1";
  render_contract_version: typeof MODEL_INPUT_RENDER_CONTRACT_VERSION;
  kind: ModelInputRenderRequest["kind"];
  text: string;
  byte_length: number;
  sha256: string;
  estimated_tokens: number;
}

function lineDocument(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function renderPass1ModelInput(input: Pick<Pass1Input, "text">): string {
  return input.text;
}

export function renderPass1SourceFragmentModelInput(
  input: Pass1SourceFragmentRenderInputV1,
): string {
  return lineDocument([
    "PASS1_SOURCE_FRAGMENT",
    `content_profile_id: ${input.content_profile_id}`,
    `parent_lid: ${input.parent_lid}`,
    `source_slice_ordinal: ${input.ordinal}`,
    `core_sha256: ${input.core_sha256}`,
    `boundary_kind: ${input.boundary_kind}`,
    `core_span_utf16: ${JSON.stringify(input.core_span_utf16)}`,
    `context_span_utf16: ${JSON.stringify(input.context_span_utf16)}`,
    "",
    "CONTEXT_BEFORE",
    input.context_before,
    "",
    "CORE",
    input.core,
    "",
    "CONTEXT_AFTER",
    input.context_after,
  ]);
}

export function renderPass1LidStitchModelInput(input: Pass1LidStitchRenderInputV1): string {
  return `${stableJson(input)}\n`;
}

export function renderProfileSidecarModelInput(
  input: Pick<
    ProfileSidecarSemanticPacketV2,
    "work_unit_id" | "unit_kind" | "visible_lids" | "formula_lids" | "text"
  >,
): string {
  return lineDocument([
    "PROFILE_SIDECAR_SEMANTIC_UNIT",
    `work_unit_id: ${input.work_unit_id}`,
    `unit_kind: ${input.unit_kind}`,
    `visible_lids: ${JSON.stringify(input.visible_lids)}`,
    `formula_lids: ${JSON.stringify(input.formula_lids)}`,
    "",
    "TEXT",
    input.text,
  ]);
}

export function renderProfileSidecarDiscourseFragmentModelInput(
  input: ProfileSidecarDiscourseFragmentRenderInputV1,
): string {
  return lineDocument([
    "PROFILE_SIDECAR_DISCOURSE_FRAGMENT",
    `content_profile_id: ${input.content_profile_id}`,
    `parent_lid: ${input.parent_lid}`,
    `source_slice_ordinal: ${input.ordinal}`,
    `boundary_kind: ${input.boundary_kind}`,
    `core_span_utf16: ${JSON.stringify(input.core_span_utf16)}`,
    `context_span_utf16: ${JSON.stringify(input.context_span_utf16)}`,
    "",
    "CONTEXT_BEFORE",
    input.context_before,
    "",
    "CORE",
    input.core,
    "",
    "CONTEXT_AFTER",
    input.context_after,
  ]);
}

export function renderProfileSidecarDiscourseReductionModelInput(
  input: ProfileSidecarDiscourseReductionRenderInputV1,
): string {
  return `${stableJson(input)}\n`;
}

export function renderPaperMetadataModelInput(
  input: Pick<
    PaperMetadataCandidatePacket,
    "window_id" | "visible_lids" | "signal_types" | "requested_fields" | "text"
  >,
): string {
  return lineDocument([
    "PAPER_METADATA_CANDIDATE",
    `window_id: ${input.window_id}`,
    `visible_lids: ${JSON.stringify(input.visible_lids)}`,
    `signal_types: ${JSON.stringify(input.signal_types)}`,
    `requested_fields: ${JSON.stringify(input.requested_fields)}`,
    "",
    "TEXT",
    input.text,
  ]);
}

export function renderPaperLexiconModelInput(
  input: Pick<
    PaperLexiconCandidatePacketV2,
    "work_unit_id" | "visible_lids" | "requested_term_types" | "candidate_clusters" | "text"
  >,
): string {
  return lineDocument([
    "PAPER_LEXICON_CANDIDATE_BATCH",
    `work_unit_id: ${input.work_unit_id}`,
    `visible_lids: ${JSON.stringify(input.visible_lids)}`,
    `requested_term_types: ${JSON.stringify(input.requested_term_types)}`,
    `candidate_clusters: ${JSON.stringify(input.candidate_clusters)}`,
    "",
    "TEXT",
    input.text,
  ]);
}

export function renderPass2ModelInput(input: Pass2WorkPacket): string {
  return prettyJson(input);
}

export function renderBookStructureModelInput(
  input: BookStructureUnitSource | BookStructureStitchPacket,
): string {
  return prettyJson(input);
}

export function renderModelInput(request: ModelInputRenderRequest): string {
  switch (request.kind) {
    case "pass1_window":
      return renderPass1ModelInput(request.input);
    case "pass1_source_slice":
      return renderPass1SourceFragmentModelInput(request.input);
    case "pass1_lid_stitch":
      return renderPass1LidStitchModelInput(request.input);
    case "profile_sidecar_discourse":
    case "profile_sidecar_formula":
      return renderProfileSidecarModelInput(request.input);
    case "profile_sidecar_discourse_fragment":
      return renderProfileSidecarDiscourseFragmentModelInput(request.input);
    case "profile_sidecar_discourse_reduce":
      return renderProfileSidecarDiscourseReductionModelInput(request.input);
    case "metadata_region":
      return renderPaperMetadataModelInput(request.input);
    case "lexicon_candidate_batch":
      return renderPaperLexiconModelInput(request.input);
    case "pass2_candidate_batch":
      return renderPass2ModelInput(request.input);
    case "structure_unit":
    case "structure_stitch":
      return renderBookStructureModelInput(request.input);
  }
}

export function inspectRenderedModelInput(request: ModelInputRenderRequest): RenderedModelInputV1 {
  const text = renderModelInput(request);
  return {
    version: "rendered_model_input.v1",
    render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    kind: request.kind,
    text,
    byte_length: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    estimated_tokens: estimateTokens(text),
  };
}
