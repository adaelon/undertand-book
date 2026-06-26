import type { LidNode } from "./generated/LidNode";
import type { ProfileArtifactHeader } from "./profile-artifact";

export type DiscourseMode = "informative" | "argumentative" | "procedural" | "descriptive" | "meta";
export type LocalFunction =
  | "definition"
  | "description"
  | "classification"
  | "explanation"
  | "cause"
  | "effect"
  | "example"
  | "counterexample"
  | "comparison"
  | "contrast"
  | "procedure_step"
  | "application"
  | "warning"
  | "limitation"
  | "question"
  | "answer"
  | "summary"
  | "transition";
export type RhetoricalMove =
  | "chapter_setup"
  | "problem_framing"
  | "prerequisite"
  | "main_point"
  | "concept_elaboration"
  | "worked_example"
  | "case_analysis"
  | "argument_support"
  | "objection"
  | "resolution"
  | "recap"
  | "bridge_to_next";
export type DiscourseRelationType =
  | "elaborates"
  | "exemplifies"
  | "explains"
  | "causes"
  | "results_in"
  | "contrasts"
  | "concedes"
  | "supports"
  | "rebuts"
  | "summarizes"
  | "restates"
  | "prepares"
  | "continues"
  | "answers"
  | "depends_on";
export type DiscourseRelationFamily = "temporal" | "contingency" | "comparison" | "expansion";
export type DiscourseDirection = "backward" | "forward" | "lateral";

export interface TechnicalLearningDiscourseRelation {
  target_lid: string;
  type: DiscourseRelationType;
  family?: DiscourseRelationFamily;
  direction: DiscourseDirection;
  confidence: number;
  evidence_lids: string[];
}

export interface TechnicalLearningDiscourseItem {
  lid: string;
  mode: DiscourseMode;
  local_function?: LocalFunction;
  rhetorical_move?: RhetoricalMove;
  local_summary?: string;
  relations: TechnicalLearningDiscourseRelation[];
}

export interface TechnicalLearningDiscourseIndex {
  header: ProfileArtifactHeader;
  items: TechnicalLearningDiscourseItem[];
}

export type DroppedDiscourseCandidateReason =
  | "missing_lid"
  | "invalid_mode"
  | "invalid_local_function"
  | "invalid_rhetorical_move"
  | "missing_target"
  | "dangling_evidence"
  | "empty_evidence"
  | "invalid_relation_type"
  | "invalid_family"
  | "invalid_direction"
  | "invalid_confidence";

export interface DroppedDiscourseCandidate {
  lid: string;
  relation_index?: number;
  reason: DroppedDiscourseCandidateReason;
  detail: string;
}

export interface DiscourseIndexBuildResult {
  sidecar: TechnicalLearningDiscourseIndex;
  dropped: DroppedDiscourseCandidate[];
}

const DISCOURSE_MODES = new Set<DiscourseMode>(["informative", "argumentative", "procedural", "descriptive", "meta"]);
const LOCAL_FUNCTIONS = new Set<LocalFunction>([
  "definition",
  "description",
  "classification",
  "explanation",
  "cause",
  "effect",
  "example",
  "counterexample",
  "comparison",
  "contrast",
  "procedure_step",
  "application",
  "warning",
  "limitation",
  "question",
  "answer",
  "summary",
  "transition",
]);
const RHETORICAL_MOVES = new Set<RhetoricalMove>([
  "chapter_setup",
  "problem_framing",
  "prerequisite",
  "main_point",
  "concept_elaboration",
  "worked_example",
  "case_analysis",
  "argument_support",
  "objection",
  "resolution",
  "recap",
  "bridge_to_next",
]);
const RELATION_TYPES = new Set<DiscourseRelationType>([
  "elaborates",
  "exemplifies",
  "explains",
  "causes",
  "results_in",
  "contrasts",
  "concedes",
  "supports",
  "rebuts",
  "summarizes",
  "restates",
  "prepares",
  "continues",
  "answers",
  "depends_on",
]);
const RELATION_FAMILIES = new Set<DiscourseRelationFamily>(["temporal", "contingency", "comparison", "expansion"]);
const DIRECTIONS = new Set<DiscourseDirection>(["backward", "forward", "lateral"]);

function lidSet(nodes: LidNode[]): Set<string> {
  return new Set(nodes.map((n) => n.lid));
}

function drop(lid: string, reason: DroppedDiscourseCandidateReason, detail: string, relation_index?: number): DroppedDiscourseCandidate {
  return relation_index === undefined ? { lid, reason, detail } : { lid, relation_index, reason, detail };
}

function validItemShape(item: TechnicalLearningDiscourseItem, lids: Set<string>, dropped: DroppedDiscourseCandidate[]): boolean {
  if (!lids.has(item.lid)) {
    dropped.push(drop(item.lid, "missing_lid", item.lid));
    return false;
  }
  if (!DISCOURSE_MODES.has(item.mode)) {
    dropped.push(drop(item.lid, "invalid_mode", item.mode));
    return false;
  }
  if (item.local_function !== undefined && !LOCAL_FUNCTIONS.has(item.local_function)) {
    dropped.push(drop(item.lid, "invalid_local_function", item.local_function));
    return false;
  }
  if (item.rhetorical_move !== undefined && !RHETORICAL_MOVES.has(item.rhetorical_move)) {
    dropped.push(drop(item.lid, "invalid_rhetorical_move", item.rhetorical_move));
    return false;
  }
  return true;
}

function relationError(relation: TechnicalLearningDiscourseRelation, lids: Set<string>): DroppedDiscourseCandidateReason | null {
  if (!RELATION_TYPES.has(relation.type)) return "invalid_relation_type";
  if (relation.family !== undefined && !RELATION_FAMILIES.has(relation.family)) return "invalid_family";
  if (!DIRECTIONS.has(relation.direction)) return "invalid_direction";
  if (!Number.isFinite(relation.confidence) || relation.confidence < 0 || relation.confidence > 1) return "invalid_confidence";
  if (!lids.has(relation.target_lid)) return "missing_target";
  if (relation.evidence_lids.length === 0) return "empty_evidence";
  if (relation.evidence_lids.some((lid) => !lids.has(lid))) return "dangling_evidence";
  return null;
}

export function buildTechnicalLearningDiscourseIndex(
  header: ProfileArtifactHeader,
  candidates: TechnicalLearningDiscourseItem[],
  nodes: LidNode[],
): DiscourseIndexBuildResult {
  const lids = lidSet(nodes);
  const items: TechnicalLearningDiscourseItem[] = [];
  const dropped: DroppedDiscourseCandidate[] = [];

  for (const candidate of candidates) {
    if (!validItemShape(candidate, lids, dropped)) continue;
    const relations: TechnicalLearningDiscourseRelation[] = [];
    for (const [index, relation] of candidate.relations.entries()) {
      const reason = relationError(relation, lids);
      if (reason) {
        dropped.push(drop(candidate.lid, reason, JSON.stringify(relation), index));
      } else {
        relations.push(relation);
      }
    }
    items.push({ ...candidate, relations });
  }

  return { sidecar: { header, items }, dropped };
}
