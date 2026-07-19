import { createHash } from "node:crypto";
import type { BuildTargetRefV2 } from "./build-orchestrator";
import { TECHNICAL_LEARNING_PROFILE, type ContentProfileDefinition } from "./content-profile";
import type { LidNode } from "./generated/LidNode";
import { pass1ContentHash } from "./build-resume";
import { buildProfiledPass1Input } from "./pass1-profile-input";
import type { ExtractionPolicyFingerprintV1 } from "./semantic-artifact";
import { estimateTokens, type Window } from "./window";

export type WorkUnitStage =
  | "pass1"
  | "paper_metadata"
  | "paper_lexicon"
  | "profile_sidecar"
  | "pass2"
  | "book_structure";

export type WorkUnitKind =
  | "pass1_window"
  | "metadata_region"
  | "lexicon_candidate_batch"
  | "profile_sidecar_window_v1"
  | "profile_sidecar_discourse"
  | "profile_sidecar_formula"
  | "discourse_paragraph_group"
  | "formula_context_group"
  | "pass2_candidate_batch"
  | "structure_unit"
  | "structure_stitch";

export interface WorkUnitCostV1 {
  estimated_input_tokens: number;
  visible_lids: number;
  formula_lids: number;
  table_fragments: number;
  candidate_count: number;
  expected_output_items: number;
  score: number;
}

export interface WorkUnitDescriptorV2 {
  version: "automatic_build_work_unit.v2";
  target: BuildTargetRefV2;
  stage: WorkUnitStage;
  work_unit_id: string;
  kind: WorkUnitKind;
  dependencies: Array<{ artifact: string; sha256: string }>;
  input_hash: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  evidence_lids: string[];
  cost: WorkUnitCostV1;
  deterministic_skip?: { code: string; evidence: string[] };
  legacy_artifact_ref?: string;
}

export interface StageWorkUnitRouterRegistration {
  stage: WorkUnitStage;
  router_version: string;
  kind: WorkUnitKind;
  compatibility_mode: boolean;
}

export const STAGE_WORK_UNIT_ROUTERS: Record<WorkUnitStage, StageWorkUnitRouterRegistration> = {
  pass1: { stage: "pass1", router_version: "pass1_window.v1", kind: "pass1_window", compatibility_mode: true },
  paper_metadata: { stage: "paper_metadata", router_version: "paper_metadata_candidate.v2", kind: "metadata_region", compatibility_mode: false },
  paper_lexicon: { stage: "paper_lexicon", router_version: "paper_lexicon_cluster.v2", kind: "lexicon_candidate_batch", compatibility_mode: false },
  profile_sidecar: { stage: "profile_sidecar", router_version: "profile_sidecar_semantic_units.v2", kind: "profile_sidecar_discourse", compatibility_mode: false },
  pass2: { stage: "pass2", router_version: "pass2_candidate_window.v1", kind: "pass2_candidate_batch", compatibility_mode: true },
  book_structure: { stage: "book_structure", router_version: "book_structure_unit.v1", kind: "structure_unit", compatibility_mode: true },
};

function nonNegativeInteger(value: number | undefined, field: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return resolved;
}

export function buildWorkUnitCost(input: {
  estimated_input_tokens?: number;
  visible_lids?: number;
  formula_lids?: number;
  table_fragments?: number;
  candidate_count?: number;
  expected_output_items?: number;
}): WorkUnitCostV1 {
  const estimatedInputTokens = nonNegativeInteger(input.estimated_input_tokens, "estimated_input_tokens");
  const visibleLids = nonNegativeInteger(input.visible_lids, "visible_lids");
  const formulaLids = nonNegativeInteger(input.formula_lids, "formula_lids");
  const tableFragments = nonNegativeInteger(input.table_fragments, "table_fragments");
  const candidateCount = nonNegativeInteger(input.candidate_count, "candidate_count");
  const expectedOutputItems = nonNegativeInteger(input.expected_output_items, "expected_output_items");
  return {
    estimated_input_tokens: estimatedInputTokens,
    visible_lids: visibleLids,
    formula_lids: formulaLids,
    table_fragments: tableFragments,
    candidate_count: candidateCount,
    expected_output_items: expectedOutputItems,
    score: estimatedInputTokens
      + 40 * expectedOutputItems
      + 80 * formulaLids
      + 60 * tableFragments
      + 30 * candidateCount,
  };
}

export function createWorkUnitDescriptor(
  input: Omit<WorkUnitDescriptorV2, "version" | "dependencies"> & {
    dependencies?: WorkUnitDescriptorV2["dependencies"];
  },
): WorkUnitDescriptorV2 {
  if (!input.work_unit_id) throw new Error("work_unit_id must not be empty");
  if (!input.input_hash) throw new Error("input_hash must not be empty");
  if (input.target.profile_id !== input.policy_fingerprint.profile_id) {
    throw new Error("work unit target profile does not match policy profile");
  }
  const router = STAGE_WORK_UNIT_ROUTERS[input.stage];
  if (!router) throw new Error(`unregistered work-unit router: ${input.stage}`);
  if (input.policy_fingerprint.router_version !== router.router_version) {
    throw new Error(`work unit policy router mismatch: ${input.policy_fingerprint.router_version} != ${router.router_version}`);
  }
  const deterministicSkip = input.deterministic_skip
    ?? (input.stage === "pass2"
      && input.kind === "pass2_candidate_batch"
      && input.cost.candidate_count === 0
      ? { code: "no_long_range_candidates", evidence: input.evidence_lids }
      : undefined);
  return {
    version: "automatic_build_work_unit.v2",
    target: input.target,
    stage: input.stage,
    work_unit_id: input.work_unit_id,
    kind: input.kind,
    dependencies: [...(input.dependencies ?? [])].sort((left, right) => left.artifact.localeCompare(right.artifact)),
    input_hash: input.input_hash,
    policy_fingerprint: input.policy_fingerprint,
    evidence_lids: [...new Set(input.evidence_lids)],
    cost: input.cost,
    ...(deterministicSkip ? { deterministic_skip: {
      code: deterministicSkip.code,
      evidence: [...deterministicSkip.evidence],
    } } : {}),
    ...(input.legacy_artifact_ref ? { legacy_artifact_ref: input.legacy_artifact_ref } : {}),
  };
}

export function routerVersionForStage(stage: WorkUnitStage): string {
  return STAGE_WORK_UNIT_ROUTERS[stage].router_version;
}

export function routePass1WindowWorkUnits(input: {
  target: BuildTargetRefV2;
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  content_profile?: ContentProfileDefinition;
}): WorkUnitDescriptorV2[] {
  const contentProfile = input.content_profile ?? TECHNICAL_LEARNING_PROFILE;
  return input.windows.map((window) => {
    const packet = buildProfiledPass1Input(window, input.byLid, input.source, contentProfile);
    const formulaLids = window.leafLids.filter((lid) => input.byLid.get(lid)?.kind === "formula").length;
    const tableFragments = window.leafLids.filter((lid) => input.byLid.get(lid)?.kind === "table").length;
    return createWorkUnitDescriptor({
      target: input.target,
      stage: "pass1",
      work_unit_id: String(window.id),
      kind: "pass1_window",
      input_hash: pass1ContentHash(packet),
      policy_fingerprint: input.policy_fingerprint,
      evidence_lids: window.leafLids,
      cost: buildWorkUnitCost({
        estimated_input_tokens: estimateTokens(packet.text),
        visible_lids: window.leafLids.length,
        formula_lids: formulaLids,
        table_fragments: tableFragments,
        expected_output_items: window.leafLids.length,
      }),
      legacy_artifact_ref: `.build/pass1/${window.id}.json`,
    });
  });
}

export function accountWorkUnits(
  units: WorkUnitDescriptorV2[],
  committedIds: ReadonlySet<string>,
): { total: number; pending: number; committed: number; skipped: number } {
  let pending = 0;
  let committed = 0;
  let skipped = 0;
  for (const unit of units) {
    if (unit.deterministic_skip) skipped += 1;
    else if (committedIds.has(unit.work_unit_id)) committed += 1;
    else pending += 1;
  }
  return { total: units.length, pending, committed, skipped };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function workUnitPlanDigest(units: WorkUnitDescriptorV2[]): string {
  const ordered = [...units].sort((left, right) => left.stage.localeCompare(right.stage)
    || left.work_unit_id.localeCompare(right.work_unit_id));
  return createHash("sha256").update(stableJson(ordered)).digest("hex");
}
