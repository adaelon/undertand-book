import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z, type ZodTypeAny } from "zod";
import type {
  AutomaticBuildTarget,
  BuildTargetRefV2,
} from "./build-orchestrator";
import type { ContentProfileDefinition } from "./content-profile";
import { resolveContentProfile } from "./content-profile";
import type { GraphEdge } from "./generated/GraphEdge";
import type { GraphNode } from "./generated/GraphNode";
import type { LidNode } from "./generated/LidNode";
import {
  evaluateModelInputBudget,
  verifyModelInputBudgetProof,
  type ModelInputBudgetProofV1,
  type ModelInputBudgetRequestV1,
  type ModelInputOverLimitV1,
} from "./model-input-budget";
import {
  renderPass1LidStitchModelInput,
  renderPass1ModelInput,
  renderPass1SourceFragmentModelInput,
  type Pass1LidStitchRenderChildV1,
  type Pass1LidStitchRenderInputV1,
  type Pass1LidStitchRenderNodeV1,
} from "./model-input-renderer";
import {
  routeModelInputSlices,
  validateModelInputSliceCoverage,
  type ModelInputSliceCoverageV1,
  type ModelInputSliceV1,
  type ModelInputUnsplittableDraftV1,
  type RoutedModelInputSliceV1,
} from "./model-input-slice";
import { mergeAndGate, type Pass1Output } from "./merge";
import { buildProfiledPass1Input } from "./pass1-profile-input";
import {
  automaticBuildGenerationArtifactPath,
  automaticBuildExtractionPolicy,
  buildSemanticArtifactEnvelopeV3,
  semanticArtifactMatches,
  writeAutomaticBuildGenerationArtifact,
  type ExtractionPolicyFingerprintV1,
  type ExtractionQualityProfile,
  type SemanticArtifactEnvelopeV3,
  type SemanticArtifactProvenanceV2,
} from "./semantic-artifact";
import {
  readAutomaticBuildStagePolicySet,
  type AutomaticBuildStagePolicySetMemberV2,
} from "./automatic-build-policy-generation";
import type { Pass1Artifact } from "./build-resume";
import {
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptorV3,
  validateWorkUnitDescriptorV3,
  type WorkUnitDescriptorV3,
} from "./stage-work-unit";
import { estimateTokens, type Window } from "./window";

export const PASS1_MODEL_SLICE_ROUTER_VERSION = "pass1_model_slice.v1" as const;
export const PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION = "pass1_source_fragment_output.v1" as const;
export const PASS1_LID_STITCH_SCHEMA_VERSION = "pass1_lid_stitch_output.v1" as const;
export const PASS1_SHADOW_GRAPH_ARTIFACT_VERSION = "pass1_shadow_graph_artifact.v1" as const;
export const PASS1_STITCH_MAX_CHILDREN = 8 as const;
export const PASS1_STITCH_BOUNDARY_PROJECTION_VERSION = "pass1_stitch_boundary_projection.v1" as const;
export const PASS1_SOURCE_FRAGMENT_EXTRACTOR = "pass1-source-fragment-extractor" as const;
export const PASS1_LID_STITCHER = "pass1-lid-stitcher" as const;
export const PASS1_SOURCE_FRAGMENT_PROMPT_NAME = "pass1-source-fragment-extractor.md" as const;
export const PASS1_LID_STITCH_PROMPT_NAME = "pass1-lid-stitcher.md" as const;
export const PASS1_SOURCE_FRAGMENT_PROMPT_SHA256 =
  "87889ca048baf6d31303650dfb953d58eb30d1a260d2ff448c6c3f41281d88eb" as const;
export const PASS1_LID_STITCH_PROMPT_SHA256 =
  "2c3d8e9e7c6813231d67de9fa768a98336d9ec670e5d8aee1a6cc2da9d5fbc1b" as const;

const MAX_ID_BYTES = 512;
const MAX_NAME_CHARS = 1_024;
const MAX_NODES = 128;
const MAX_EDGES = 256;
const MAX_EVIDENCE_LIDS = 128;

type Pass1BudgetV1 = Omit<
  ModelInputBudgetRequestV1,
  "rendered_input" | "router_version" | "prompt_sha256"
>;

export interface Pass1SourceUnitRangeV1 {
  start_ordinal: number;
  end_ordinal_exclusive: number;
}

export type Pass1ShadowRouteV1 =
  | {
      role: "whole" | "group";
      window_id: number;
      source_unit_range: Pass1SourceUnitRangeV1;
      evidence_lids: string[];
    }
  | {
      role: "fragment";
      window_id: number;
      parent_lid: string;
      source_slice_ordinal: number;
      source_unit_range: Pass1SourceUnitRangeV1;
      evidence_lids: [string];
    }
  | {
      role: "stitch" | "final";
      window_id: number;
      reducer_level: number;
      group_ordinal: number;
      source_unit_range: Pass1SourceUnitRangeV1;
      evidence_lids: string[];
    };

export interface Pass1ShadowWorkUnitV1 {
  descriptor: WorkUnitDescriptorV3;
  rendered_input: string;
  route: Pass1ShadowRouteV1;
}

export interface Pass1ShadowGraphArtifactV1 extends Pass1Output {
  version: typeof PASS1_SHADOW_GRAPH_ARTIFACT_VERSION;
  window_id: number;
  role: Pass1ShadowRouteV1["role"];
  source_unit_range: Pass1SourceUnitRangeV1;
  evidence_lids: string[];
  reducer_level?: number;
}

export interface Pass1SourceFragmentCandidateV1 extends Pass1Output {
  version: typeof PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION;
  parent_lid: string;
  source_slice_ordinal: number;
  core_sha256: string;
}

export interface Pass1LidStitchCandidateV1 {
  version: typeof PASS1_LID_STITCH_SCHEMA_VERSION;
  edges: GraphEdge[];
}

export interface Pass1ShadowVerifiedChildV1 {
  work_unit: Pass1ShadowWorkUnitV1;
  artifact: SemanticArtifactEnvelopeV3<unknown>;
  payload: Pass1ShadowGraphArtifactV1;
}

export interface Pass1ShadowTaskV1 {
  version: "pass1_shadow_task.v1";
  target_ref: BuildTargetRefV2;
  source_fingerprint: string;
  policy_set_digest: string;
  source_unit_count: number;
  descriptor: WorkUnitDescriptorV3;
  route: Pass1ShadowRouteV1;
}

export interface Pass1ShadowWriteResultV1 {
  version: "pass1_shadow_write_result.v1";
  work_unit_id: string;
  role: Pass1ShadowRouteV1["role"];
  artifact_path: string;
  artifact_hash: string;
  output_counts: { nodes: number; edges: number };
}

export interface Pass1ShadowFinalCandidateResultV1 {
  version: "pass1_shadow_final_candidate.v1";
  work_unit_id: string;
  window_id: number;
  candidate_path: string;
  candidate_sha256: string;
  candidate: Pass1Artifact;
}

export type Pass1ShadowRouteResultV1 =
  | {
      status: "routed";
      mode: "whole" | "split";
      units: Pass1ShadowWorkUnitV1[];
      coverages: ModelInputSliceCoverageV1[];
    }
  | { status: "blocked"; recovery: ModelInputUnsplittableDraftV1 };

export type Pass1StitchRouteResultV1 =
  | {
      status: "routed";
      reducer_level: number;
      role: "stitch" | "final";
      units: Pass1ShadowWorkUnitV1[];
    }
  | { status: "blocked"; recovery: ModelInputUnsplittableDraftV1 };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return sha256(stableJson(value));
}

function assertSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function assertBounded(value: string, field: string, maxBytes = MAX_ID_BYTES): string {
  if (!value || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function assertRange(value: Pass1SourceUnitRangeV1, field = "source_unit_range"): Pass1SourceUnitRangeV1 {
  assertNonNegativeInteger(value.start_ordinal, `${field}.start_ordinal`);
  assertPositiveInteger(value.end_ordinal_exclusive, `${field}.end_ordinal_exclusive`);
  if (value.end_ordinal_exclusive <= value.start_ordinal) throw new Error(`${field} must be non-empty`);
  return value;
}

function sameTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return stableJson(left) === stableJson(right);
}

function sameResolvedTarget(left: BuildTargetRefV2, right: BuildTargetRefV2): boolean {
  return left.version === right.version
    && path.resolve(left.workspace_dir) === path.resolve(right.workspace_dir)
    && left.book_id === right.book_id
    && left.profile_id === right.profile_id
    && left.input_fingerprint === right.input_fingerprint;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(",")}`);
}

function parseClosed<T>(schema: ZodTypeAny, input: unknown, contract: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data as T;
  const issue = parsed.error.issues[0];
  const pointer = issue.path.length ? `/${issue.path.join("/")}` : "/";
  throw new Error(`${contract} schema_invalid at ${pointer}`);
}

function uniqueEvidenceLids(lids: string[]): string[] {
  const result = [...new Set(lids.map((lid) => assertBounded(lid, "evidence_lid", 256)))];
  if (!result.length || result.length > MAX_EVIDENCE_LIDS) {
    throw new Error("pass1 evidence_lids must be a non-empty bounded list");
  }
  return result;
}

export function pass1SourceFragmentPolicy(
  profile: ContentProfileDefinition,
  qualityProfile: ExtractionQualityProfile = "full",
): ExtractionPolicyFingerprintV1 {
  return {
    profile_id: profile.id,
    profile_version: profile.profile_version,
    stage_policy_version: "pass1_source_fragment_policy.v1",
    router_version: PASS1_MODEL_SLICE_ROUTER_VERSION,
    prompt_sha256: PASS1_SOURCE_FRAGMENT_PROMPT_SHA256,
    schema_version: PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
    quality_profile: qualityProfile,
  };
}

export function pass1LidStitchPolicy(
  profile: ContentProfileDefinition,
  qualityProfile: ExtractionQualityProfile = "full",
): ExtractionPolicyFingerprintV1 {
  return {
    profile_id: profile.id,
    profile_version: profile.profile_version,
    stage_policy_version: "pass1_lid_stitch_policy.v1",
    router_version: PASS1_MODEL_SLICE_ROUTER_VERSION,
    prompt_sha256: PASS1_LID_STITCH_PROMPT_SHA256,
    schema_version: PASS1_LID_STITCH_SCHEMA_VERSION,
    quality_profile: qualityProfile,
  };
}

export function pass1ModelSlicePolicyMembers(
  profile: ContentProfileDefinition,
  qualityProfile: ExtractionQualityProfile = "full",
): AutomaticBuildStagePolicySetMemberV2[] {
  return [
    {
      kind: "pass1_window",
      extractor: "pass1-local-extractor",
      policy_fingerprint: automaticBuildExtractionPolicy("pass1", profile, qualityProfile),
    },
    {
      kind: "pass1_source_slice",
      extractor: PASS1_SOURCE_FRAGMENT_EXTRACTOR,
      policy_fingerprint: pass1SourceFragmentPolicy(profile, qualityProfile),
    },
    {
      kind: "pass1_lid_stitch",
      extractor: PASS1_LID_STITCHER,
      policy_fingerprint: pass1LidStitchPolicy(profile, qualityProfile),
    },
  ];
}

function assertPolicy(input: {
  target: BuildTargetRefV2;
  policy: ExtractionPolicyFingerprintV1;
  role: "whole" | "fragment" | "stitch";
}): void {
  if (input.policy.profile_id !== input.target.profile_id) {
    throw new Error(`pass1 ${input.role} policy profile does not match target`);
  }
  assertSha256(input.policy.prompt_sha256, `${input.role} policy prompt_sha256`);
  if (input.role === "fragment") {
    if (input.policy.router_version !== PASS1_MODEL_SLICE_ROUTER_VERSION
      || input.policy.prompt_sha256 !== PASS1_SOURCE_FRAGMENT_PROMPT_SHA256
      || input.policy.schema_version !== PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION) {
      throw new Error("pass1 fragment policy is unsupported");
    }
  } else if (input.role === "stitch") {
    if (input.policy.router_version !== PASS1_MODEL_SLICE_ROUTER_VERSION
      || input.policy.prompt_sha256 !== PASS1_LID_STITCH_PROMPT_SHA256
      || input.policy.schema_version !== PASS1_LID_STITCH_SCHEMA_VERSION) {
      throw new Error("pass1 stitch policy is unsupported");
    }
  }
}

function windowForLids(window: Window, lids: string[], byLid: Map<string, LidNode>, source: string): Window {
  if (!lids.length) throw new Error("pass1 routed group must contain at least one LID");
  const spans = lids.map((lid) => {
    const node = byLid.get(lid);
    if (!node || node.children.length) throw new Error(`pass1 routed group requires a leaf LID: ${lid}`);
    return { ...node.span };
  }).sort((left, right) => left.start - right.start);
  return {
    id: window.id,
    leafLids: [...lids],
    tokens: estimateTokens(lids.map((lid) => {
      const node = byLid.get(lid)!;
      return source.slice(node.span.start, node.span.end);
    }).join("\n\n")),
    spans,
    overBudget: false,
  };
}

function wholeSlices(input: {
  lids: string[];
  by_lid: Map<string, LidNode>;
  source: string;
  source_fingerprint: string;
}): ModelInputSliceV1[] {
  return input.lids.map((lid) => {
    const node = input.by_lid.get(lid);
    if (!node || node.children.length) throw new Error(`pass1 whole slice requires a leaf LID: ${lid}`);
    const text = input.source.slice(node.span.start, node.span.end);
    return {
      version: "model_input_slice.v1",
      source_fingerprint: input.source_fingerprint,
      parent_lid: lid,
      ordinal: 0,
      core_span_utf16: { ...node.span },
      context_span_utf16: { ...node.span },
      boundary_kind: "whole_lid",
      core_sha256: sha256(text),
      context_sha256: sha256(text),
    };
  });
}

function groupWorkUnit(input: {
  target: BuildTargetRefV2;
  source: string;
  source_fingerprint: string;
  window: Window;
  lids: string[];
  by_lid: Map<string, LidNode>;
  content_profile: ContentProfileDefinition;
  policy: ExtractionPolicyFingerprintV1;
  budget: Pass1BudgetV1;
  source_unit_ordinal: number;
  whole_window: boolean;
}): Pass1ShadowWorkUnitV1 | { blocked: ModelInputUnsplittableDraftV1 } {
  assertPolicy({ target: input.target, policy: input.policy, role: "whole" });
  const routedWindow = windowForLids(input.window, input.lids, input.by_lid, input.source);
  const packet = buildProfiledPass1Input(routedWindow, input.by_lid, input.source, input.content_profile);
  const renderedInput = renderPass1ModelInput(packet);
  const evaluated = evaluateModelInputBudget({
    ...input.budget,
    rendered_input: renderedInput,
    router_version: input.policy.router_version,
    prompt_sha256: input.policy.prompt_sha256,
  });
  if (evaluated.status === "over_limit") {
    const first = input.by_lid.get(input.lids[0])!;
    return {
      blocked: {
        version: "automatic_build_recovery_draft.v1",
        phase: "routing",
        code: "model_input_unsplittable",
        parent_lid: first.lid,
        lid_kind: first.kind,
        reason: "renderer_fixed_overhead",
        estimated_tokens: evaluated.estimated_rendered_tokens,
        limit_tokens: evaluated.effective_body_limit_tokens,
        retryable: false,
      },
    };
  }
  const proof = evaluated.proof;
  const workUnitId = input.whole_window
    ? String(input.window.id)
    : `pass1-window-${input.window.id}-group-${digest({
        version: "pass1_group_identity.v1",
        source_fingerprint: input.source_fingerprint,
        lids: input.lids,
        input_hash: proof.rendered_input_sha256,
      })}`;
  const route: Pass1ShadowRouteV1 = {
    role: input.whole_window ? "whole" : "group",
    window_id: input.window.id,
    source_unit_range: {
      start_ordinal: input.source_unit_ordinal,
      end_ordinal_exclusive: input.source_unit_ordinal + 1,
    },
    evidence_lids: [...input.lids],
  };
  const descriptor = createWorkUnitDescriptorV3({
    target: input.target,
    stage: "pass1",
    work_unit_id: workUnitId,
    kind: "pass1_window",
    input_basis: {
      kind: "source_slices",
      slices: wholeSlices({
        lids: input.lids,
        by_lid: input.by_lid,
        source: input.source,
        source_fingerprint: input.source_fingerprint,
      }),
    },
    input_hash: proof.rendered_input_sha256,
    input_budget_proof: proof,
    policy_fingerprint: input.policy,
    evidence_lids: input.lids,
    dependencies: [],
    cost: buildWorkUnitCostFromBudgetProof({
      rendered_input: renderedInput,
      proof,
      visible_lids: input.lids.length,
      formula_lids: input.lids.filter((lid) => input.by_lid.get(lid)?.kind === "formula").length,
      table_fragments: input.lids.filter((lid) => input.by_lid.get(lid)?.kind === "table").length,
      expected_output_items: input.lids.length,
    }),
  });
  return { descriptor, rendered_input: renderedInput, route };
}

function fragmentRenderInput(input: {
  content_profile_id: string;
  source: string;
  routed: RoutedModelInputSliceV1;
}) {
  const slice = input.routed.slice;
  return {
    version: "model_input_slice_render_context.v1" as const,
    content_profile_id: input.content_profile_id,
    parent_lid: slice.parent_lid,
    ordinal: slice.ordinal,
    core_sha256: slice.core_sha256,
    boundary_kind: slice.boundary_kind,
    core_span_utf16: { ...slice.core_span_utf16 },
    context_span_utf16: { ...slice.context_span_utf16 },
    context_before: input.source.slice(slice.context_span_utf16.start, slice.core_span_utf16.start),
    core: input.source.slice(slice.core_span_utf16.start, slice.core_span_utf16.end),
    context_after: input.source.slice(slice.core_span_utf16.end, slice.context_span_utf16.end),
  };
}

function buildFragmentWorkUnits(input: {
  target: BuildTargetRefV2;
  source: string;
  source_fingerprint: string;
  window_id: number;
  parent: LidNode;
  routed_slices: RoutedModelInputSliceV1[];
  content_profile: ContentProfileDefinition;
  policy: ExtractionPolicyFingerprintV1;
  start_source_unit_ordinal: number;
}): { units: Pass1ShadowWorkUnitV1[]; coverage: ModelInputSliceCoverageV1 } {
  assertPolicy({ target: input.target, policy: input.policy, role: "fragment" });
  const coverage = validateModelInputSliceCoverage({
    source: input.source,
    source_fingerprint: input.source_fingerprint,
    parent: input.parent,
    slices: input.routed_slices.map((item) => item.slice),
  });
  const units = [...input.routed_slices]
    .sort((left, right) => left.slice.ordinal - right.slice.ordinal)
    .map((routed, index): Pass1ShadowWorkUnitV1 => {
      const renderedInput = renderPass1SourceFragmentModelInput(fragmentRenderInput({
        content_profile_id: input.content_profile.id,
        source: input.source,
        routed,
      }));
      if (renderedInput !== routed.rendered_input) {
        throw new Error("pass1 fragment bytes drifted from the dedicated renderer");
      }
      const proof = verifyModelInputBudgetProof(renderedInput, routed.proof);
      if (proof.router_version !== input.policy.router_version
        || proof.prompt_sha256 !== input.policy.prompt_sha256) {
        throw new Error("pass1 fragment proof does not match its policy");
      }
      const slice = routed.slice;
      const workUnitId = `pass1-window-${input.window_id}-fragment-${digest({
        version: "pass1_source_fragment_identity.v1",
        source_fingerprint: slice.source_fingerprint,
        parent_lid: slice.parent_lid,
        ordinal: slice.ordinal,
        core_span_utf16: slice.core_span_utf16,
        context_span_utf16: slice.context_span_utf16,
        core_sha256: slice.core_sha256,
        context_sha256: slice.context_sha256,
      })}`;
      const sourceUnitOrdinal = input.start_source_unit_ordinal + index;
      const route: Pass1ShadowRouteV1 = {
        role: "fragment",
        window_id: input.window_id,
        parent_lid: input.parent.lid,
        source_slice_ordinal: slice.ordinal,
        source_unit_range: {
          start_ordinal: sourceUnitOrdinal,
          end_ordinal_exclusive: sourceUnitOrdinal + 1,
        },
        evidence_lids: [input.parent.lid],
      };
      const descriptor = createWorkUnitDescriptorV3({
        target: input.target,
        stage: "pass1",
        work_unit_id: workUnitId,
        kind: "pass1_source_slice",
        input_basis: { kind: "source_slices", slices: [slice] },
        input_hash: proof.rendered_input_sha256,
        input_budget_proof: proof,
        policy_fingerprint: input.policy,
        evidence_lids: [input.parent.lid],
        dependencies: [],
        cost: buildWorkUnitCostFromBudgetProof({
          rendered_input: renderedInput,
          proof,
          visible_lids: 1,
          expected_output_items: 1,
        }),
        aggregation: { parent_lid: input.parent.lid, role: "fragment" },
      });
      return { descriptor, rendered_input: renderedInput, route };
    });
  return { units, coverage };
}

export function routePass1ShadowWorkUnits(input: {
  target: BuildTargetRefV2;
  window: Window;
  by_lid: Map<string, LidNode>;
  source: string;
  source_fingerprint: string;
  content_profile: ContentProfileDefinition;
  whole_policy: ExtractionPolicyFingerprintV1;
  fragment_policy: ExtractionPolicyFingerprintV1;
  whole_budget: Pass1BudgetV1;
  fragment_budget: Pass1BudgetV1;
  context_overlap_utf16?: number;
}): Pass1ShadowRouteResultV1 {
  if (sha256(input.source) !== input.source_fingerprint) {
    throw new Error("pass1 shadow source fingerprint does not match source bytes");
  }
  const whole = groupWorkUnit({
    target: input.target,
    source: input.source,
    source_fingerprint: input.source_fingerprint,
    window: input.window,
    lids: input.window.leafLids,
    by_lid: input.by_lid,
    content_profile: input.content_profile,
    policy: input.whole_policy,
    budget: input.whole_budget,
    source_unit_ordinal: 0,
    whole_window: true,
  });
  if (!("blocked" in whole)) {
    return { status: "routed", mode: "whole", units: [whole], coverages: [] };
  }

  const units: Pass1ShadowWorkUnitV1[] = [];
  const coverages: ModelInputSliceCoverageV1[] = [];
  let pendingLids: string[] = [];
  const flushGroup = () => {
    if (!pendingLids.length) return;
    const built = groupWorkUnit({
      target: input.target,
      source: input.source,
      source_fingerprint: input.source_fingerprint,
      window: input.window,
      lids: pendingLids,
      by_lid: input.by_lid,
      content_profile: input.content_profile,
      policy: input.whole_policy,
      budget: input.whole_budget,
      source_unit_ordinal: units.length,
      whole_window: false,
    });
    if ("blocked" in built) throw new Error("pass1 grouped whole LIDs drifted from a prior budget check");
    units.push(built);
    pendingLids = [];
  };

  for (const lid of input.window.leafLids) {
    const candidateLids = [...pendingLids, lid];
    const candidate = groupWorkUnit({
      target: input.target,
      source: input.source,
      source_fingerprint: input.source_fingerprint,
      window: input.window,
      lids: candidateLids,
      by_lid: input.by_lid,
      content_profile: input.content_profile,
      policy: input.whole_policy,
      budget: input.whole_budget,
      source_unit_ordinal: units.length,
      whole_window: false,
    });
    if (!("blocked" in candidate)) {
      pendingLids = candidateLids;
      continue;
    }
    flushGroup();
    const single = groupWorkUnit({
      target: input.target,
      source: input.source,
      source_fingerprint: input.source_fingerprint,
      window: input.window,
      lids: [lid],
      by_lid: input.by_lid,
      content_profile: input.content_profile,
      policy: input.whole_policy,
      budget: input.whole_budget,
      source_unit_ordinal: units.length,
      whole_window: false,
    });
    if (!("blocked" in single)) {
      pendingLids = [lid];
      continue;
    }
    const parent = input.by_lid.get(lid);
    if (!parent) throw new Error(`pass1 leaf LID does not exist: ${lid}`);
    const sliced = routeModelInputSlices({
      source: input.source,
      source_fingerprint: input.source_fingerprint,
      parent,
      context_overlap_utf16: input.context_overlap_utf16,
      budget: {
        ...input.fragment_budget,
        router_version: input.fragment_policy.router_version,
        prompt_sha256: input.fragment_policy.prompt_sha256,
      },
      render: (renderContext) => renderPass1SourceFragmentModelInput({
        content_profile_id: input.content_profile.id,
        core_sha256: sha256(renderContext.core),
        ...renderContext,
      }),
    });
    if (sliced.status === "blocked") return sliced;
    const built = buildFragmentWorkUnits({
      target: input.target,
      source: input.source,
      source_fingerprint: input.source_fingerprint,
      window_id: input.window.id,
      parent,
      routed_slices: sliced.slices,
      content_profile: input.content_profile,
      policy: input.fragment_policy,
      start_source_unit_ordinal: units.length,
    });
    units.push(...built.units);
    coverages.push(built.coverage);
  }
  flushGroup();
  if (!units.length) throw new Error("pass1 split route produced no work units");
  return { status: "routed", mode: "split", units, coverages };
}

const boundedString = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES,
  `string must be at most ${MAX_ID_BYTES} UTF-8 bytes`,
);
const boundedLid = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= 256,
  "LID must be at most 256 UTF-8 bytes",
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const graphNodeSchema = z.object({
  id: boundedString,
  type: z.enum(["entity", "concept", "claim"]),
  name: z.string().min(1).max(MAX_NAME_CHARS),
  occurrences: z.array(boundedLid).max(MAX_EVIDENCE_LIDS),
  source_lid: boundedLid.nullable(),
}).strict();
const graphEdgeSchema = z.object({
  source: boundedString,
  target: boundedString,
  type: boundedString,
  direction: z.enum(["directed", "undirected"]),
  scope: z.literal("local"),
  weight: z.number().min(0).max(1),
}).strict();
const pass1OutputSchema = z.object({
  nodes: z.array(graphNodeSchema).max(MAX_NODES),
  edges: z.array(graphEdgeSchema).max(MAX_EDGES),
}).strict();
const pass1ArtifactSchema = pass1OutputSchema.extend({
  content_hash: sha256Schema,
}).strict();
const fragmentCandidateSchema = z.object({
  version: z.literal(PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION),
  parent_lid: boundedLid,
  source_slice_ordinal: z.number().int().nonnegative(),
  core_sha256: sha256Schema,
  nodes: z.array(graphNodeSchema).max(MAX_NODES),
  edges: z.array(graphEdgeSchema).max(MAX_EDGES),
}).strict();
const stitchCandidateSchema = z.object({
  version: z.literal(PASS1_LID_STITCH_SCHEMA_VERSION),
  edges: z.array(graphEdgeSchema).max(MAX_EDGES),
}).strict();

function assertOutputEvidence(output: Pass1Output, evidenceLids: string[], field: string): Pass1Output {
  const allowed = new Set(uniqueEvidenceLids(evidenceLids));
  const nodeIds = new Set(output.nodes.map((node) => node.id));
  if (nodeIds.size !== output.nodes.length) throw new Error(`${field} node ids must be unique`);
  for (const [index, node] of output.nodes.entries()) {
    if (node.type === "claim") {
      if (!node.source_lid || !allowed.has(node.source_lid) || node.occurrences.length) {
        throw new Error(`${field}/nodes/${index} claim evidence is outside the routed LIDs`);
      }
    } else if (node.source_lid !== null
      || !node.occurrences.length
      || node.occurrences.some((lid) => !allowed.has(lid))) {
      throw new Error(`${field}/nodes/${index} occurrence evidence is outside the routed LIDs`);
    }
  }
  for (const [index, edge] of output.edges.entries()) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`${field}/edges/${index} references a node outside the candidate`);
    }
  }
  return output;
}

function syntheticLidNodes(lids: string[]): LidNode[] {
  return uniqueEvidenceLids(lids).map((lid, index) => ({
    lid,
    path: [index + 1],
    kind: "paragraph",
    span: { start: index, end: index + 1 },
    children: [],
  }));
}

function gateOutput(output: Pass1Output, evidenceLids: string[]): Pass1Output {
  const gated = mergeAndGate([output], syntheticLidNodes(evidenceLids));
  return { nodes: gated.nodes, edges: gated.edges };
}

export function projectPass1AdoptedWholeArtifact(input: {
  target: AutomaticBuildTarget;
  task: Pass1ShadowTaskV1;
  payload: unknown;
}): Pass1ShadowGraphArtifactV1 {
  const task = validatePass1ShadowTask(input.task, input.target);
  if (task.route.role !== "whole"
    || task.route.source_unit_range.start_ordinal !== 0
    || task.route.source_unit_range.end_ordinal_exclusive !== task.source_unit_count) {
    throw new Error("only a whole-window task can project an adopted Pass1 artifact");
  }
  const legacy = parseClosed<Pass1Artifact>(
    pass1ArtifactSchema,
    input.payload,
    "pass1_artifact.v1",
  );
  if (legacy.content_hash !== task.descriptor.input_hash) {
    throw new Error("adopted Pass1 artifact content hash does not match its current descriptor");
  }
  const output = gateOutput(
    assertOutputEvidence(legacy, task.route.evidence_lids, "adopted pass1 whole-window artifact"),
    task.route.evidence_lids,
  );
  return {
    version: PASS1_SHADOW_GRAPH_ARTIFACT_VERSION,
    window_id: task.route.window_id,
    role: "whole",
    source_unit_range: { ...task.route.source_unit_range },
    evidence_lids: [...task.route.evidence_lids],
    nodes: output.nodes,
    edges: output.edges,
  };
}

export function parsePass1SourceFragmentCandidate(
  input: unknown,
  context: { parent_lid: string; source_slice_ordinal: number; core_sha256: string },
): Pass1SourceFragmentCandidateV1 {
  const parsed = parseClosed<Pass1SourceFragmentCandidateV1>(
    fragmentCandidateSchema,
    input,
    PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
  );
  if (parsed.parent_lid !== context.parent_lid
    || parsed.source_slice_ordinal !== context.source_slice_ordinal
    || parsed.core_sha256 !== assertSha256(context.core_sha256, "fragment core_sha256")) {
    throw new Error("pass1 fragment identity does not match its descriptor");
  }
  assertOutputEvidence(parsed, [context.parent_lid], "pass1 fragment");
  return parsed;
}

export function parsePass1LidStitchCandidate(
  input: unknown,
  allowedNodeIds: string[],
): Pass1LidStitchCandidateV1 {
  const parsed = parseClosed<Pass1LidStitchCandidateV1>(
    stitchCandidateSchema,
    input,
    PASS1_LID_STITCH_SCHEMA_VERSION,
  );
  const allowed = new Set(allowedNodeIds);
  for (const [index, edge] of parsed.edges.entries()) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) {
      throw new Error(`pass1 stitch edge ${index} references a node outside verified children`);
    }
  }
  return parsed;
}

function graphArtifactSchema() {
  return z.object({
    version: z.literal(PASS1_SHADOW_GRAPH_ARTIFACT_VERSION),
    window_id: z.number().int().nonnegative(),
    role: z.enum(["whole", "group", "fragment", "stitch", "final"]),
    source_unit_range: z.object({
      start_ordinal: z.number().int().nonnegative(),
      end_ordinal_exclusive: z.number().int().positive(),
    }).strict(),
    evidence_lids: z.array(boundedLid).min(1).max(MAX_EVIDENCE_LIDS),
    reducer_level: z.number().int().nonnegative().optional(),
    nodes: z.array(graphNodeSchema).max(MAX_NODES * PASS1_STITCH_MAX_CHILDREN),
    edges: z.array(graphEdgeSchema).max(MAX_EDGES * PASS1_STITCH_MAX_CHILDREN),
  }).strict();
}

function parseGraphArtifact(input: unknown): Pass1ShadowGraphArtifactV1 {
  const parsed = parseClosed<Pass1ShadowGraphArtifactV1>(
    graphArtifactSchema(),
    input,
    PASS1_SHADOW_GRAPH_ARTIFACT_VERSION,
  );
  assertRange(parsed.source_unit_range);
  assertOutputEvidence(parsed, parsed.evidence_lids, "pass1 shadow graph artifact");
  if ((parsed.role === "stitch" || parsed.role === "final") !== (parsed.reducer_level !== undefined)) {
    throw new Error("pass1 stitch/final graph artifact must bind reducer_level");
  }
  return parsed;
}

function shadowFileName(workUnitId: string): string {
  assertBounded(workUnitId, "pass1 shadow work_unit_id");
  const encoded = encodeURIComponent(workUnitId);
  return Buffer.byteLength(encoded, "utf8") <= 220 ? `${encoded}.json` : `${sha256(workUnitId)}.json`;
}

export function pass1ShadowTaskPath(
  target: AutomaticBuildTarget,
  policySetDigest: string,
  workUnitId: string,
): string {
  assertSha256(policySetDigest, "policy_set_digest");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "shadow",
    "pass1",
    policySetDigest,
    "tasks",
    shadowFileName(workUnitId),
  );
}

export function pass1ShadowTaskPrivateDirectory(
  target: AutomaticBuildTarget,
  policySetDigest: string,
  workUnitId: string,
): string {
  assertSha256(policySetDigest, "policy_set_digest");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v3",
    "shadow",
    "pass1",
    policySetDigest,
    "mailboxes",
    shadowFileName(workUnitId).replace(/\.json$/u, ""),
  );
}

function assertRouteMatchesDescriptor(
  workUnit: Pass1ShadowWorkUnitV1,
  options: { verify_rendered_input?: boolean } = {},
): void {
  const descriptor = validateWorkUnitDescriptorV3(workUnit.descriptor);
  if (descriptor.stage !== "pass1") throw new Error("pass1 shadow descriptor has the wrong stage");
  const range = assertRange(workUnit.route.source_unit_range);
  if (workUnit.route.role === "whole" || workUnit.route.role === "group") {
    if (descriptor.kind !== "pass1_window" || descriptor.input_basis.kind !== "source_slices") {
      throw new Error("pass1 whole/group route has an invalid descriptor basis");
    }
  } else if (workUnit.route.role === "fragment") {
    if (descriptor.kind !== "pass1_source_slice"
      || descriptor.input_basis.kind !== "source_slices"
      || descriptor.input_basis.slices.length !== 1) {
      throw new Error("pass1 fragment route has an invalid descriptor basis");
    }
    const slice = descriptor.input_basis.slices[0];
    if (slice.parent_lid !== workUnit.route.parent_lid
      || slice.ordinal !== workUnit.route.source_slice_ordinal
      || descriptor.aggregation?.parent_lid !== workUnit.route.parent_lid
      || descriptor.aggregation.role !== "fragment") {
      throw new Error("pass1 fragment route does not match its source slice");
    }
  } else if (descriptor.kind !== "pass1_lid_stitch"
    || descriptor.input_basis.kind !== "artifact_reduction") {
    throw new Error("pass1 stitch/final route has an invalid descriptor basis");
  }
  if (range.end_ordinal_exclusive - range.start_ordinal < 1) {
    throw new Error("pass1 shadow route source range is empty");
  }
  if (stableJson(uniqueEvidenceLids(workUnit.route.evidence_lids))
    !== stableJson(uniqueEvidenceLids(descriptor.evidence_lids))) {
    throw new Error("pass1 shadow route evidence does not match its descriptor");
  }
  if (options.verify_rendered_input !== false) {
    verifyModelInputBudgetProof(workUnit.rendered_input, descriptor.input_budget_proof);
  }
}

export function validatePass1ShadowTask(
  task: Pass1ShadowTaskV1,
  target?: AutomaticBuildTarget,
): Pass1ShadowTaskV1 {
  if (!task || typeof task !== "object") throw new Error("pass1 shadow task must be an object");
  assertExactKeys(task as unknown as Record<string, unknown>, [
    "version",
    "target_ref",
    "source_fingerprint",
    "policy_set_digest",
    "source_unit_count",
    "descriptor",
    "route",
  ], "pass1 shadow task");
  if (task.version !== "pass1_shadow_task.v1") throw new Error("unsupported pass1 shadow task version");
  assertSha256(task.source_fingerprint, "source_fingerprint");
  assertSha256(task.policy_set_digest, "policy_set_digest");
  assertPositiveInteger(task.source_unit_count, "source_unit_count");
  const descriptor = validateWorkUnitDescriptorV3(task.descriptor);
  if (!sameTarget(descriptor.target, task.target_ref)) {
    throw new Error("pass1 shadow task target does not match its descriptor");
  }
  if (target && !sameResolvedTarget(task.target_ref, target.target_ref)) {
    throw new Error("pass1 shadow task target does not match the current build target");
  }
  const workUnit: Pass1ShadowWorkUnitV1 = { descriptor, rendered_input: "", route: task.route };
  assertRouteMatchesDescriptor(workUnit, { verify_rendered_input: false });
  const range = assertRange(task.route.source_unit_range);
  if (range.end_ordinal_exclusive > task.source_unit_count) {
    throw new Error("pass1 shadow task source range exceeds source_unit_count");
  }
  if (task.route.role === "final"
    && (range.start_ordinal !== 0 || range.end_ordinal_exclusive !== task.source_unit_count)) {
    throw new Error("pass1 final shadow task must cover every source unit");
  }
  return task;
}

export function createPass1ShadowTask(input: {
  work_unit: Pass1ShadowWorkUnitV1;
  source_fingerprint: string;
  policy_set_digest: string;
  source_unit_count: number;
}): Pass1ShadowTaskV1 {
  const task = validatePass1ShadowTask({
    version: "pass1_shadow_task.v1",
    target_ref: input.work_unit.descriptor.target,
    source_fingerprint: input.source_fingerprint,
    policy_set_digest: input.policy_set_digest,
    source_unit_count: input.source_unit_count,
    descriptor: input.work_unit.descriptor,
    route: input.work_unit.route,
  });
  if (input.work_unit.rendered_input
    && verifyModelInputBudgetProof(
      input.work_unit.rendered_input,
      task.descriptor.input_budget_proof,
    ).rendered_input_sha256 !== task.descriptor.input_hash) {
    throw new Error("pass1 shadow task rendered input drifted from its descriptor");
  }
  return task;
}

export function freezePass1ShadowTask(target: AutomaticBuildTarget, input: Pass1ShadowTaskV1): string {
  const task = validatePass1ShadowTask(input, target);
  const file = pass1ShadowTaskPath(target, task.policy_set_digest, task.descriptor.work_unit_id);
  const bytes = `${JSON.stringify(task, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    return file;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (readFileSync(file, "utf8") !== bytes) {
      throw new Error(`policy_generation_conflict: pass1 shadow task is already frozen: ${file}`);
    }
    return file;
  }
}

export function readPass1ShadowTask(
  target: AutomaticBuildTarget,
  policySetDigest: string,
  workUnitId: string,
): Pass1ShadowTaskV1 {
  const file = pass1ShadowTaskPath(target, policySetDigest, workUnitId);
  if (!existsSync(file)) throw new Error(`pass1 shadow task does not exist: ${workUnitId}`);
  return validatePass1ShadowTask(
    JSON.parse(readFileSync(file, "utf8")) as Pass1ShadowTaskV1,
    target,
  );
}

function assertPolicyMember(target: AutomaticBuildTarget, task: Pass1ShadowTaskV1): void {
  const policySet = readAutomaticBuildStagePolicySet(target, "pass1", task.policy_set_digest);
  if (!policySet) throw new Error("pass1 shadow policy set is not frozen");
  const member = policySet.members.find((candidate) => candidate.kind === task.descriptor.kind);
  if (!member
    || stableJson(member.policy_fingerprint) !== stableJson(task.descriptor.policy_fingerprint)) {
    throw new Error("pass1 shadow task is outside the frozen policy set");
  }
}

function verifyCurrentSourceSlice(source: string, slice: ModelInputSliceV1, sourceFingerprint: string): void {
  if (slice.source_fingerprint !== sourceFingerprint) throw new Error("pass1 source slice fingerprint is stale");
  const core = slice.core_span_utf16;
  const context = slice.context_span_utf16;
  if (!Number.isSafeInteger(core.start) || !Number.isSafeInteger(core.end)
    || !Number.isSafeInteger(context.start) || !Number.isSafeInteger(context.end)
    || core.start < 0 || core.end <= core.start || core.end > source.length
    || context.start < 0 || context.start > core.start
    || context.end < core.end || context.end > source.length) {
    throw new Error("pass1 source slice spans are invalid");
  }
  if (sha256(source.slice(core.start, core.end)) !== slice.core_sha256
    || sha256(source.slice(context.start, context.end)) !== slice.context_sha256) {
    throw new Error("pass1 source slice digest is stale");
  }
}

function renderWholeTaskInput(source: string, task: Pass1ShadowTaskV1): string {
  if ((task.route.role !== "whole" && task.route.role !== "group")
    || task.descriptor.input_basis.kind !== "source_slices") {
    throw new Error("pass1 whole/group task has an invalid source basis");
  }
  const sliceByLid = new Map(task.descriptor.input_basis.slices.map((slice) => [slice.parent_lid, slice]));
  const byLid = new Map<string, LidNode>();
  for (const [index, lid] of task.route.evidence_lids.entries()) {
    const slice = sliceByLid.get(lid);
    if (!slice || slice.ordinal !== 0 || slice.boundary_kind !== "whole_lid") {
      throw new Error("pass1 whole/group task source slices do not match routed evidence");
    }
    verifyCurrentSourceSlice(source, slice, task.source_fingerprint);
    if (stableJson(slice.core_span_utf16) !== stableJson(slice.context_span_utf16)) {
      throw new Error("pass1 whole/group task must not use context overlap");
    }
    byLid.set(lid, {
      lid,
      path: [index + 1],
      kind: "paragraph",
      span: { ...slice.core_span_utf16 },
      children: [],
    });
  }
  if (sliceByLid.size !== byLid.size) throw new Error("pass1 whole/group task contains extra source slices");
  const syntheticWindow: Window = {
    id: task.route.window_id,
    leafLids: [...task.route.evidence_lids],
    tokens: 0,
    spans: [...byLid.values()].map((node) => ({ ...node.span })),
    overBudget: false,
  };
  return renderPass1ModelInput(buildProfiledPass1Input(
    syntheticWindow,
    byLid,
    source,
    resolveContentProfile(task.target_ref.profile_id),
  ));
}

function renderFragmentTaskInput(source: string, task: Pass1ShadowTaskV1): string {
  if (task.route.role !== "fragment"
    || task.descriptor.input_basis.kind !== "source_slices"
    || task.descriptor.input_basis.slices.length !== 1) {
    throw new Error("pass1 fragment task has an invalid source basis");
  }
  const slice = task.descriptor.input_basis.slices[0];
  verifyCurrentSourceSlice(source, slice, task.source_fingerprint);
  if (slice.parent_lid !== task.route.parent_lid || slice.ordinal !== task.route.source_slice_ordinal) {
    throw new Error("pass1 fragment task source slice identity drifted");
  }
  return renderPass1SourceFragmentModelInput({
    version: "model_input_slice_render_context.v1",
    content_profile_id: task.target_ref.profile_id,
    parent_lid: slice.parent_lid,
    ordinal: slice.ordinal,
    core_sha256: slice.core_sha256,
    boundary_kind: slice.boundary_kind,
    core_span_utf16: { ...slice.core_span_utf16 },
    context_span_utf16: { ...slice.context_span_utf16 },
    context_before: source.slice(slice.context_span_utf16.start, slice.core_span_utf16.start),
    core: source.slice(slice.core_span_utf16.start, slice.core_span_utf16.end),
    context_after: source.slice(slice.core_span_utf16.end, slice.context_span_utf16.end),
  });
}

interface Pass1ShadowDependencyV1 {
  task: Pass1ShadowTaskV1;
  artifact: SemanticArtifactEnvelopeV3<unknown>;
  payload: Pass1ShadowGraphArtifactV1;
}

function readStitchDependencies(
  target: AutomaticBuildTarget,
  task: Pass1ShadowTaskV1,
): Pass1ShadowDependencyV1[] {
  if ((task.route.role !== "stitch" && task.route.role !== "final")
    || task.descriptor.input_basis.kind !== "artifact_reduction") {
    throw new Error("pass1 stitch/final task has an invalid artifact basis");
  }
  const dependencies = task.descriptor.input_basis.dependency_artifacts.map((dependency) => {
    const childTask = readPass1ShadowTask(target, task.policy_set_digest, dependency.work_unit_id);
    const file = automaticBuildGenerationArtifactPath(
      target,
      "pass1",
      task.policy_set_digest,
      dependency.work_unit_id,
    );
    if (!existsSync(file)) throw new Error(`pass1 stitch child artifact is missing: ${dependency.work_unit_id}`);
    const artifact = JSON.parse(readFileSync(file, "utf8")) as SemanticArtifactEnvelopeV3<unknown>;
    if (artifact.artifact_hash !== dependency.artifact_hash
      || !semanticArtifactMatches(artifact, {
        target: childTask.target_ref,
        stage: "pass1",
        work_unit_id: childTask.descriptor.work_unit_id,
        input_hash: childTask.descriptor.input_hash,
        proof_digest: childTask.descriptor.input_budget_proof.proof_digest,
        policy_set_digest: task.policy_set_digest,
        policy_fingerprint: childTask.descriptor.policy_fingerprint,
      })) {
      throw new Error(`pass1 stitch child artifact is stale or invalid: ${dependency.work_unit_id}`);
    }
    const payload = parseGraphArtifact(artifact.payload);
    if (payload.role === "final"
      || payload.window_id !== task.route.window_id
      || stableJson(payload.source_unit_range) !== stableJson(childTask.route.source_unit_range)
      || stableJson(payload.evidence_lids) !== stableJson(childTask.route.evidence_lids)) {
      throw new Error(`pass1 stitch child route is stale or invalid: ${dependency.work_unit_id}`);
    }
    return { task: childTask, artifact, payload };
  }).sort((left, right) =>
    left.payload.source_unit_range.start_ordinal - right.payload.source_unit_range.start_ordinal
    || left.payload.source_unit_range.end_ordinal_exclusive - right.payload.source_unit_range.end_ordinal_exclusive
    || left.artifact.artifact_hash.localeCompare(right.artifact.artifact_hash));
  if (!dependencies.length || dependencies.length > PASS1_STITCH_MAX_CHILDREN) {
    throw new Error("pass1 stitch child count is outside the bounded fan-in");
  }
  let cursor = task.route.source_unit_range.start_ordinal;
  for (const dependency of dependencies) {
    if (dependency.payload.source_unit_range.start_ordinal !== cursor) {
      throw new Error("pass1 stitch children contain a source-unit gap or overlap");
    }
    cursor = dependency.payload.source_unit_range.end_ordinal_exclusive;
  }
  if (cursor !== task.route.source_unit_range.end_ordinal_exclusive) {
    throw new Error("pass1 stitch children do not cover the task source range");
  }
  const childStitchLevels = dependencies
    .filter((dependency) => dependency.payload.role === "stitch")
    .map((dependency) => dependency.payload.reducer_level);
  if (childStitchLevels.length) {
    if (childStitchLevels.length !== dependencies.length
      || new Set(childStitchLevels).size !== 1
      || childStitchLevels[0] !== task.route.reducer_level - 1) {
      throw new Error("pass1 stitch child reducer level is stale");
    }
  } else if (task.route.reducer_level !== 0) {
    throw new Error("pass1 initial graph children must feed stitch level zero");
  }
  return dependencies;
}

interface Pass1StitchProjectionSourceV1 {
  work_unit_id: string;
  artifact_hash: string;
  source_unit_range: Pass1SourceUnitRangeV1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type Pass1StitchProjectedRenderV1 =
  | {
      status: "within_limit";
      input: Pass1LidStitchRenderInputV1;
      rendered_input: string;
      proof: ModelInputBudgetProofV1;
    }
  | {
      status: "over_limit";
      evaluation: ModelInputOverLimitV1;
      reason: ModelInputUnsplittableDraftV1["reason"];
    };

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundaryProjectionNodes(source: Pass1StitchProjectionSourceV1): Pass1LidStitchRenderNodeV1[] {
  const degree = new Map<string, number>();
  for (const edge of source.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const typeRank: Record<GraphNode["type"], number> = { claim: 0, concept: 1, entity: 2 };
  return source.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    name: node.name,
  })).sort((left, right) =>
    (degree.get(left.id) ?? 0) - (degree.get(right.id) ?? 0)
    || typeRank[left.type] - typeRank[right.type]
    || compareStableText(left.id, right.id)
    || compareStableText(left.name, right.name));
}

function pass1BudgetFromProof(proof: ModelInputBudgetProofV1): Pass1BudgetV1 {
  return {
    stage_body_limit_tokens: proof.stage_body_limit_tokens,
    executor_context_floor_tokens: proof.executor_context_floor_tokens,
    prompt_reserve_tokens: proof.prompt_reserve_tokens,
    protocol_reserve_tokens: proof.protocol_reserve_tokens,
    output_reserve_tokens: proof.output_reserve_tokens,
    safety_margin_tokens: proof.safety_margin_tokens,
  };
}

function buildBoundedStitchProjection(input: {
  work_unit_id: string;
  window_id: number;
  reducer_level: number;
  group_ordinal: number;
  role: "stitch" | "final";
  source_unit_range: Pass1SourceUnitRangeV1;
  children: Pass1StitchProjectionSourceV1[];
  policy: ExtractionPolicyFingerprintV1;
  budget: Pass1BudgetV1;
}): Pass1StitchProjectedRenderV1 {
  const rankedNodes = input.children.map(boundaryProjectionNodes);
  const selectedNodes: Pass1LidStitchRenderNodeV1[][] = input.children.map(() => []);
  const render = () => {
    const renderInput: Pass1LidStitchRenderInputV1 = {
      version: "pass1_lid_stitch_input.v1",
      work_unit_id: input.work_unit_id,
      window_id: input.window_id,
      reducer_level: input.reducer_level,
      group_ordinal: input.group_ordinal,
      role: input.role,
      source_unit_range: { ...input.source_unit_range },
      children: input.children.map((child, index): Pass1LidStitchRenderChildV1 => ({
        work_unit_id: child.work_unit_id,
        artifact_hash: child.artifact_hash,
        source_unit_range: { ...child.source_unit_range },
        payload: {
          nodes: [...selectedNodes[index]],
          edges: [],
        },
      })),
    };
    const renderedInput = renderPass1LidStitchModelInput(renderInput);
    const evaluation = evaluateModelInputBudget({
      ...input.budget,
      rendered_input: renderedInput,
      router_version: input.policy.router_version,
      prompt_sha256: input.policy.prompt_sha256,
    });
    return { input: renderInput, rendered_input: renderedInput, evaluation };
  };

  let current = render();
  if (current.evaluation.status === "over_limit") {
    return {
      status: "over_limit",
      evaluation: current.evaluation,
      reason: "renderer_fixed_overhead",
    };
  }

  const cursors = rankedNodes.map(() => 0);
  for (const [index, nodes] of rankedNodes.entries()) {
    if (!nodes.length) continue;
    selectedNodes[index].push(nodes[0]);
    const attempted = render();
    if (attempted.evaluation.status === "over_limit") {
      selectedNodes[index].pop();
      return {
        status: "over_limit",
        evaluation: attempted.evaluation,
        reason: "no_safe_boundary",
      };
    }
    cursors[index] = 1;
    current = attempted;
  }

  let hasCandidates = true;
  while (hasCandidates) {
    hasCandidates = false;
    for (const [index, nodes] of rankedNodes.entries()) {
      const cursor = cursors[index];
      if (cursor >= nodes.length) continue;
      hasCandidates = true;
      selectedNodes[index].push(nodes[cursor]);
      cursors[index] += 1;
      const attempted = render();
      if (attempted.evaluation.status === "over_limit") {
        selectedNodes[index].pop();
        continue;
      }
      current = attempted;
    }
  }

  if (current.evaluation.status !== "within_limit") {
    throw new Error("pass1 stitch boundary projection lost its within-limit proof");
  }
  return {
    status: "within_limit",
    input: current.input,
    rendered_input: current.rendered_input,
    proof: current.evaluation.proof,
  };
}

function stitchTaskProjection(
  target: AutomaticBuildTarget,
  task: Pass1ShadowTaskV1,
): Pass1StitchProjectedRenderV1 & { dependencies?: Pass1ShadowDependencyV1[] } {
  if (task.route.role !== "stitch" && task.route.role !== "final") {
    throw new Error("pass1 stitch renderer requires a stitch/final task");
  }
  const dependencies = readStitchDependencies(target, task);
  const projected = buildBoundedStitchProjection({
    work_unit_id: task.descriptor.work_unit_id,
    window_id: task.route.window_id,
    reducer_level: task.route.reducer_level,
    group_ordinal: task.route.group_ordinal,
    role: task.route.role,
    source_unit_range: task.route.source_unit_range,
    children: dependencies.map((dependency) => ({
      work_unit_id: dependency.task.descriptor.work_unit_id,
      artifact_hash: dependency.artifact.artifact_hash,
      source_unit_range: dependency.payload.source_unit_range,
      nodes: dependency.payload.nodes,
      edges: dependency.payload.edges,
    })),
    policy: task.descriptor.policy_fingerprint,
    budget: pass1BudgetFromProof(task.descriptor.input_budget_proof),
  });
  return { ...projected, dependencies };
}

function renderStitchTaskInput(target: AutomaticBuildTarget, task: Pass1ShadowTaskV1): string {
  const projected = stitchTaskProjection(target, task);
  if (projected.status === "over_limit") {
    throw new Error("pass1 frozen stitch boundary projection exceeds its budget proof");
  }
  return projected.rendered_input;
}

export function replayPass1ShadowInput(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: Pass1ShadowTaskV1;
}): Pass1ShadowWorkUnitV1 {
  const task = validatePass1ShadowTask(input.task, input.target);
  assertPolicyMember(input.target, task);
  if (sha256(input.source) !== task.source_fingerprint) {
    throw new Error("pass1 shadow task source fingerprint is stale");
  }
  const renderedInput = task.route.role === "whole" || task.route.role === "group"
    ? renderWholeTaskInput(input.source, task)
    : task.route.role === "fragment"
      ? renderFragmentTaskInput(input.source, task)
      : renderStitchTaskInput(input.target, task);
  const proof = verifyModelInputBudgetProof(renderedInput, task.descriptor.input_budget_proof);
  if (proof.rendered_input_sha256 !== task.descriptor.input_hash) {
    throw new Error("pass1 shadow input hash drifted from its descriptor");
  }
  return { descriptor: task.descriptor, rendered_input: renderedInput, route: task.route };
}

function assertStitchEdgesCrossAdjacentProjections(
  candidate: Pass1LidStitchCandidateV1,
  renderInput: Pass1LidStitchRenderInputV1,
): void {
  const memberships = new Map<string, number[]>();
  for (const [childIndex, child] of renderInput.children.entries()) {
    for (const node of child.payload.nodes) {
      const indexes = memberships.get(node.id) ?? [];
      indexes.push(childIndex);
      memberships.set(node.id, indexes);
    }
  }
  for (const [edgeIndex, edge] of candidate.edges.entries()) {
    const sourceChildren = memberships.get(edge.source) ?? [];
    const targetChildren = memberships.get(edge.target) ?? [];
    const crossesAdjacentChildren = sourceChildren.some((sourceIndex) =>
      targetChildren.some((targetIndex) => Math.abs(sourceIndex - targetIndex) === 1));
    if (!crossesAdjacentChildren) {
      throw new Error(`pass1 stitch edge ${edgeIndex} is outside adjacent child boundary projections`);
    }
  }
}

function artifactPayloadForCandidate(input: {
  target: AutomaticBuildTarget;
  task: Pass1ShadowTaskV1;
  candidate: unknown;
}): Pass1ShadowGraphArtifactV1 {
  const route = input.task.route;
  let output: Pass1Output;
  if (route.role === "whole" || route.role === "group") {
    output = parseClosed<Pass1Output>(pass1OutputSchema, input.candidate, "pass1_output.v1");
    assertOutputEvidence(output, route.evidence_lids, "pass1 whole/group");
    output = gateOutput(output, route.evidence_lids);
  } else if (route.role === "fragment") {
    if (input.task.descriptor.input_basis.kind !== "source_slices") {
      throw new Error("pass1 fragment candidate is missing its source slice");
    }
    const slice = input.task.descriptor.input_basis.slices[0];
    const parsed = parsePass1SourceFragmentCandidate(input.candidate, {
      parent_lid: route.parent_lid,
      source_slice_ordinal: route.source_slice_ordinal,
      core_sha256: slice.core_sha256,
    });
    output = gateOutput({ nodes: parsed.nodes, edges: parsed.edges }, route.evidence_lids);
  } else {
    const projected = stitchTaskProjection(input.target, input.task);
    if (projected.status === "over_limit" || !projected.dependencies) {
      throw new Error("pass1 stitch boundary projection is not replayable");
    }
    const dependencies = projected.dependencies;
    const nodeIds = projected.input.children.flatMap((child) => child.payload.nodes.map((node) => node.id));
    const candidate = parsePass1LidStitchCandidate(input.candidate, nodeIds);
    assertStitchEdgesCrossAdjacentProjections(candidate, projected.input);
    const merged = mergeAndGate([
      ...dependencies.map((dependency) => ({
        nodes: dependency.payload.nodes,
        edges: dependency.payload.edges,
      })),
      { nodes: [], edges: candidate.edges },
    ], syntheticLidNodes(route.evidence_lids));
    output = { nodes: merged.nodes, edges: merged.edges };
  }
  return {
    version: PASS1_SHADOW_GRAPH_ARTIFACT_VERSION,
    window_id: route.window_id,
    role: route.role,
    source_unit_range: { ...route.source_unit_range },
    evidence_lids: [...route.evidence_lids],
    ...((route.role === "stitch" || route.role === "final")
      ? { reducer_level: route.reducer_level }
      : {}),
    nodes: output.nodes,
    edges: output.edges,
  };
}

export function writePass1ShadowCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: Pass1ShadowTaskV1;
  candidate: unknown;
  provenance: SemanticArtifactProvenanceV2;
}): Pass1ShadowWriteResultV1 {
  const replayed = replayPass1ShadowInput({ target: input.target, source: input.source, task: input.task });
  const task = validatePass1ShadowTask(input.task, input.target);
  const payload = artifactPayloadForCandidate({ target: input.target, task, candidate: input.candidate });
  const envelope = buildSemanticArtifactEnvelopeV3({
    target: task.target_ref,
    stage: "pass1",
    work_unit_id: task.descriptor.work_unit_id,
    input_hash: replayed.descriptor.input_hash,
    proof_digest: replayed.descriptor.input_budget_proof.proof_digest,
    policy_set_digest: task.policy_set_digest,
    policy_fingerprint: replayed.descriptor.policy_fingerprint,
    provenance: input.provenance,
    payload,
  });
  const artifactPath = writeAutomaticBuildGenerationArtifact(input.target, envelope);
  return {
    version: "pass1_shadow_write_result.v1",
    work_unit_id: task.descriptor.work_unit_id,
    role: task.route.role,
    artifact_path: artifactPath,
    artifact_hash: envelope.artifact_hash,
    output_counts: { nodes: payload.nodes.length, edges: payload.edges.length },
  };
}

export function verifyPass1ShadowArtifact(input: {
  work_unit: Pass1ShadowWorkUnitV1;
  artifact: SemanticArtifactEnvelopeV3<unknown>;
  policy_set_digest: string;
}): Pass1ShadowVerifiedChildV1 {
  assertSha256(input.policy_set_digest, "policy_set_digest");
  assertRouteMatchesDescriptor(input.work_unit);
  if (input.work_unit.route.role === "final") throw new Error("a final pass1 artifact cannot become a stitch child");
  const descriptor = input.work_unit.descriptor;
  if (input.artifact.version !== "semantic_task_artifact.v3"
    || input.artifact.policy_set_digest !== input.policy_set_digest
    || !semanticArtifactMatches(input.artifact, {
      target: descriptor.target,
      stage: "pass1",
      work_unit_id: descriptor.work_unit_id,
      input_hash: descriptor.input_hash,
      proof_digest: descriptor.input_budget_proof.proof_digest,
      policy_set_digest: input.policy_set_digest,
      policy_fingerprint: descriptor.policy_fingerprint,
    })) {
    throw new Error("pass1 child artifact is stale or invalid");
  }
  const payload = parseGraphArtifact(input.artifact.payload);
  if (payload.window_id !== input.work_unit.route.window_id
    || payload.role !== input.work_unit.route.role
    || stableJson(payload.source_unit_range) !== stableJson(input.work_unit.route.source_unit_range)
    || stableJson(payload.evidence_lids) !== stableJson(input.work_unit.route.evidence_lids)) {
    throw new Error("pass1 child artifact route is stale or invalid");
  }
  return { ...input, payload };
}

function orderedChildren(input: {
  children: Pass1ShadowVerifiedChildV1[];
  target: BuildTargetRefV2;
  window_id: number;
  source_unit_count: number;
  policy_set_digest: string;
}): Pass1ShadowVerifiedChildV1[] {
  assertPositiveInteger(input.source_unit_count, "source_unit_count");
  if (!input.children.length) throw new Error("pass1 stitch children must not be empty");
  const verified = input.children.map((child) => verifyPass1ShadowArtifact({
    work_unit: child.work_unit,
    artifact: child.artifact,
    policy_set_digest: input.policy_set_digest,
  }));
  const ids = verified.map((child) => child.work_unit.descriptor.work_unit_id);
  if (new Set(ids).size !== ids.length) throw new Error("pass1 stitch child work units must be unique");
  for (const child of verified) {
    if (!sameTarget(child.work_unit.descriptor.target, input.target)
      || child.work_unit.route.window_id !== input.window_id) {
      throw new Error("pass1 stitch child target or window drifted");
    }
  }
  const stitched = verified.filter((child) => child.work_unit.route.role === "stitch");
  if (stitched.length && stitched.length !== verified.length) {
    throw new Error("pass1 stitch level mixes initial and stitched child roles");
  }
  if (stitched.length) {
    const levels = new Set(stitched.map((child) =>
      child.work_unit.route.role === "stitch" ? child.work_unit.route.reducer_level : -1));
    if (levels.size !== 1) throw new Error("pass1 stitch children must share one reducer level");
  }
  const ordered = verified.sort((left, right) =>
    left.payload.source_unit_range.start_ordinal - right.payload.source_unit_range.start_ordinal
    || left.payload.source_unit_range.end_ordinal_exclusive - right.payload.source_unit_range.end_ordinal_exclusive
    || left.artifact.artifact_hash.localeCompare(right.artifact.artifact_hash));
  let cursor = 0;
  for (const child of ordered) {
    if (child.payload.source_unit_range.start_ordinal !== cursor) {
      throw new Error("pass1 stitch children contain a source-unit gap or overlap");
    }
    cursor = child.payload.source_unit_range.end_ordinal_exclusive;
  }
  if (cursor !== input.source_unit_count) {
    throw new Error("pass1 stitch children do not cover the expected source unit count");
  }
  return ordered;
}

function nextReducerLevel(children: Pass1ShadowVerifiedChildV1[]): number {
  const route = children[0].work_unit.route;
  return route.role === "stitch" ? route.reducer_level + 1 : 0;
}

function stitchBlock(input: {
  evidence_lid: string;
  estimated_tokens: number;
  limit_tokens: number;
  reason: ModelInputUnsplittableDraftV1["reason"];
}): Pass1StitchRouteResultV1 {
  return {
    status: "blocked",
    recovery: {
      version: "automatic_build_recovery_draft.v1",
      phase: "routing",
      code: "model_input_unsplittable",
      parent_lid: input.evidence_lid,
      lid_kind: "paragraph",
      reason: input.reason,
      estimated_tokens: input.estimated_tokens,
      limit_tokens: input.limit_tokens,
      retryable: false,
    },
  };
}

function projectedStitchGroup(input: {
  window_id: number;
  reducer_level: number;
  group_ordinal: number;
  role: "stitch" | "final";
  group: Pass1ShadowVerifiedChildV1[];
  policy: ExtractionPolicyFingerprintV1;
  budget: Pass1BudgetV1;
}) {
  const first = input.group[0].payload.source_unit_range;
  const last = input.group.at(-1)!.payload.source_unit_range;
  const sourceUnitRange = {
    start_ordinal: first.start_ordinal,
    end_ordinal_exclusive: last.end_ordinal_exclusive,
  };
  const childIdentity = input.group.map((child) => ({
    work_unit_id: child.work_unit.descriptor.work_unit_id,
    artifact_hash: child.artifact.artifact_hash,
    source_unit_range: child.payload.source_unit_range,
  }));
  const workUnitId = `pass1-window-${input.window_id}-${input.role}-${digest({
    version: "pass1_lid_stitch_identity.v3",
    boundary_projection_version: PASS1_STITCH_BOUNDARY_PROJECTION_VERSION,
    window_id: input.window_id,
    reducer_level: input.reducer_level,
    group_ordinal: input.group_ordinal,
    role: input.role,
    children: childIdentity,
  })}`;
  const projection = buildBoundedStitchProjection({
    work_unit_id: workUnitId,
    window_id: input.window_id,
    reducer_level: input.reducer_level,
    group_ordinal: input.group_ordinal,
    role: input.role,
    source_unit_range: sourceUnitRange,
    children: input.group.map((child) => ({
      work_unit_id: child.work_unit.descriptor.work_unit_id,
      artifact_hash: child.artifact.artifact_hash,
      source_unit_range: child.payload.source_unit_range,
      nodes: child.payload.nodes,
      edges: child.payload.edges,
    })),
    policy: input.policy,
    budget: input.budget,
  });
  return { sourceUnitRange, childIdentity, workUnitId, projection };
}

export function routePass1StitchLevel(input: {
  target: BuildTargetRefV2;
  window_id: number;
  source_unit_count: number;
  children: Pass1ShadowVerifiedChildV1[];
  policy_set_digest: string;
  policy: ExtractionPolicyFingerprintV1;
  budget: Pass1BudgetV1;
}): Pass1StitchRouteResultV1 {
  assertPolicy({ target: input.target, policy: input.policy, role: "stitch" });
  assertSha256(input.policy_set_digest, "policy_set_digest");
  const children = orderedChildren(input);
  const reducerLevel = nextReducerLevel(children);
  const groups: Pass1ShadowVerifiedChildV1[][] = [];
  let childCursor = 0;
  while (childCursor < children.length) {
    const remaining = children.length - childCursor;
    const maxCandidateSize = Math.min(PASS1_STITCH_MAX_CHILDREN, remaining);
    let selectedSize = 0;
    let firstRejected: Extract<Pass1StitchProjectedRenderV1, { status: "over_limit" }> | undefined;
    for (let candidateSize = 1; candidateSize <= maxCandidateSize; candidateSize += 1) {
      const candidate = projectedStitchGroup({
        window_id: input.window_id,
        reducer_level: reducerLevel,
        group_ordinal: groups.length,
        role: "stitch",
        group: children.slice(childCursor, childCursor + candidateSize),
        policy: input.policy,
        budget: input.budget,
      });
      if (candidate.projection.status === "over_limit") {
        firstRejected = candidate.projection;
        break;
      }
      selectedSize = candidateSize;
    }
    if (selectedSize === 0 || (selectedSize === 1 && remaining > 1)) {
      const rejected = firstRejected;
      if (!rejected) throw new Error("pass1 stitch boundary projection did not make reduction progress");
      return stitchBlock({
        evidence_lid: children[childCursor].payload.evidence_lids[0],
        estimated_tokens: rejected.evaluation.estimated_rendered_tokens,
        limit_tokens: rejected.evaluation.effective_body_limit_tokens,
        reason: rejected.reason,
      });
    }
    if (remaining - selectedSize === 1) {
      if (selectedSize <= 2) {
        const rejected = firstRejected;
        if (!rejected) throw new Error("pass1 stitch byte packing would strand a singleton child");
        return stitchBlock({
          evidence_lid: children[childCursor].payload.evidence_lids[0],
          estimated_tokens: rejected.evaluation.estimated_rendered_tokens,
          limit_tokens: rejected.evaluation.effective_body_limit_tokens,
          reason: rejected.reason,
        });
      }
      selectedSize -= 1;
    }
    groups.push(children.slice(childCursor, childCursor + selectedSize));
    childCursor += selectedSize;
  }
  const role = groups.length === 1 ? "final" : "stitch";
  const units: Pass1ShadowWorkUnitV1[] = [];
  for (const [groupOrdinal, group] of groups.entries()) {
    const projected = projectedStitchGroup({
      window_id: input.window_id,
      reducer_level: reducerLevel,
      group_ordinal: groupOrdinal,
      role,
      group,
      policy: input.policy,
      budget: input.budget,
    });
    const evidenceLids = uniqueEvidenceLids(group.flatMap((child) => child.payload.evidence_lids));
    if (projected.projection.status === "over_limit") {
      return stitchBlock({
        evidence_lid: evidenceLids[0],
        estimated_tokens: projected.projection.evaluation.estimated_rendered_tokens,
        limit_tokens: projected.projection.evaluation.effective_body_limit_tokens,
        reason: projected.projection.reason,
      });
    }
    const { childIdentity, sourceUnitRange, workUnitId } = projected;
    const renderedInput = projected.projection.rendered_input;
    const proof = projected.projection.proof;
    const route: Pass1ShadowRouteV1 = {
      role,
      window_id: input.window_id,
      reducer_level: reducerLevel,
      group_ordinal: groupOrdinal,
      source_unit_range: sourceUnitRange,
      evidence_lids: evidenceLids,
    };
    const dependencies = childIdentity.map((child) => ({
      artifact: child.work_unit_id,
      sha256: child.artifact_hash,
    }));
    const descriptor = createWorkUnitDescriptorV3({
      target: input.target,
      stage: "pass1",
      work_unit_id: workUnitId,
      kind: "pass1_lid_stitch",
      input_basis: {
        kind: "artifact_reduction",
        dependency_artifacts: childIdentity.map((child) => ({
          work_unit_id: child.work_unit_id,
          artifact_hash: child.artifact_hash,
        })),
        parent_lids: evidenceLids,
      },
      input_hash: proof.rendered_input_sha256,
      input_budget_proof: proof,
      policy_fingerprint: input.policy,
      evidence_lids: evidenceLids,
      dependencies,
      cost: buildWorkUnitCostFromBudgetProof({
        rendered_input: renderedInput,
        proof,
        visible_lids: evidenceLids.length,
        candidate_count: group.length,
        expected_output_items: 1,
      }),
    });
    units.push({ descriptor, rendered_input: renderedInput, route });
  }
  return { status: "routed", reducer_level: reducerLevel, role, units };
}

function readTaskArtifact(
  target: AutomaticBuildTarget,
  task: Pass1ShadowTaskV1,
): SemanticArtifactEnvelopeV3<unknown> {
  const file = automaticBuildGenerationArtifactPath(
    target,
    "pass1",
    task.policy_set_digest,
    task.descriptor.work_unit_id,
  );
  if (!existsSync(file)) throw new Error("pass1 shadow artifact does not exist");
  const artifact = JSON.parse(readFileSync(file, "utf8")) as SemanticArtifactEnvelopeV3<unknown>;
  if (!semanticArtifactMatches(artifact, {
    target: task.target_ref,
    stage: "pass1",
    work_unit_id: task.descriptor.work_unit_id,
    input_hash: task.descriptor.input_hash,
    proof_digest: task.descriptor.input_budget_proof.proof_digest,
    policy_set_digest: task.policy_set_digest,
    policy_fingerprint: task.descriptor.policy_fingerprint,
  })) {
    throw new Error("pass1 shadow artifact is stale or invalid");
  }
  return artifact;
}

export function buildPass1ShadowFinalCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: Pass1ShadowTaskV1;
}): Pass1Artifact {
  const replayed = replayPass1ShadowInput(input);
  if (replayed.route.role !== "whole" && replayed.route.role !== "final") {
    throw new Error("only a whole window or root final stitch can contribute a pass1 public candidate");
  }
  const task = validatePass1ShadowTask(input.task, input.target);
  if (task.route.role !== "whole" && task.route.role !== "final") {
    throw new Error("only a whole window or root final stitch can contribute a pass1 public candidate");
  }
  const artifact = readTaskArtifact(input.target, task);
  const payload = parseGraphArtifact(artifact.payload);
  if (payload.role !== task.route.role
    || payload.window_id !== task.route.window_id
    || stableJson(payload.source_unit_range) !== stableJson(task.route.source_unit_range)
    || stableJson(payload.evidence_lids) !== stableJson(task.route.evidence_lids)
    || payload.source_unit_range.start_ordinal !== 0
    || payload.source_unit_range.end_ordinal_exclusive !== task.source_unit_count) {
    throw new Error("pass1 public contributor route does not match its frozen task");
  }
  if (task.route.role === "final") {
    if (payload.reducer_level !== task.route.reducer_level) {
      throw new Error("pass1 root stitch artifact route does not match its frozen final task");
    }
  } else if (payload.reducer_level !== undefined) {
    throw new Error("pass1 whole-window public contributor must not bind a reducer level");
  }
  return {
    content_hash: task.descriptor.input_hash,
    nodes: payload.nodes,
    edges: payload.edges,
  };
}

export function writePass1ShadowFinalCandidate(input: {
  target: AutomaticBuildTarget;
  source: string;
  task: Pass1ShadowTaskV1;
}): Pass1ShadowFinalCandidateResultV1 {
  const task = validatePass1ShadowTask(input.task, input.target);
  const candidate = buildPass1ShadowFinalCandidate(input);
  const directory = pass1ShadowTaskPrivateDirectory(
    input.target,
    task.policy_set_digest,
    task.descriptor.work_unit_id,
  );
  const candidatePath = path.join(directory, "public-candidate.json");
  const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(candidatePath, bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    if (readFileSync(candidatePath, "utf8") !== bytes) {
      throw new Error(`policy_generation_conflict: pass1 final candidate is already frozen: ${candidatePath}`);
    }
  }
  return {
    version: "pass1_shadow_final_candidate.v1",
    work_unit_id: task.descriptor.work_unit_id,
    window_id: task.route.window_id,
    candidate_path: candidatePath,
    candidate_sha256: sha256(bytes),
    candidate,
  };
}

export function assertPass1ShadowCandidatePath(input: {
  target: AutomaticBuildTarget;
  task: Pass1ShadowTaskV1;
  candidate_path: string;
}): string {
  const task = validatePass1ShadowTask(input.task, input.target);
  const directory = path.resolve(pass1ShadowTaskPrivateDirectory(
    input.target,
    task.policy_set_digest,
    task.descriptor.work_unit_id,
  ));
  const candidatePath = path.resolve(input.candidate_path);
  const relative = path.relative(directory, candidatePath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("pass1 shadow candidate must stay inside its task-private mailbox");
  }
  return candidatePath;
}
