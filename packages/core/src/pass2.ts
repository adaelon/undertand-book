// P1 technical_learning Pass2 long-range linker gate.
// LLM/subagent may propose profile-aware candidates, but only this deterministic
// gate can lower them into GraphEdge(scope=long_range) plus an audit sidecar.
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { GraphEdge } from "./generated/GraphEdge";
import type { GraphNode } from "./generated/GraphNode";
import type { LidNode } from "./generated/LidNode";
import type { CatalogEntry } from "./catalog";
import type { ProfileArtifactHeader } from "./profile-artifact";
export type { ProfileArtifactHeader };

export const TECHNICAL_LEARNING_PASS2_PROFILE_ID = "technical_learning";
export const TECHNICAL_LEARNING_PASS2_PROFILE_VERSION = "pass2_longrange_v1";


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

export interface TechnicalLearningDiscourseRelation {
  target_lid: string;
  type: DiscourseRelationType;
  family?: DiscourseRelationFamily;
  direction: "backward" | "forward" | "lateral";
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
export interface TechnicalLearningPass2Input {
  header: ProfileArtifactHeader;
  catalog: CatalogEntry[];
  graph_nodes: GraphNode[];
  discourse_index?: TechnicalLearningDiscourseIndex;
  formula_semantics?: FormulaSemantics[];
  windows_or_chapters: Array<{
    lid: string;
    title?: string;
    summary?: string;
    key_lids: string[];
  }>;
}

export type TechnicalLearningLongRangeEdgeType =
  | "builds_on"
  | "contradicts"
  | "exemplifies"
  | "prerequisite"
  | "refines"
  | "applies"
  | "analogous_to"
  | "contrasts";

const LONG_RANGE_EDGE_TYPES: ReadonlySet<string> = new Set<TechnicalLearningLongRangeEdgeType>([
  "builds_on",
  "contradicts",
  "exemplifies",
  "prerequisite",
  "refines",
  "applies",
  "analogous_to",
  "contrasts",
]);

export interface TechnicalLearningLongRangeEdgeCandidate {
  source: string;
  target: string;
  type: TechnicalLearningLongRangeEdgeType;
  direction: "directed" | "undirected";
  scope: "long_range";
  weight: number;
  evidence_lids: string[];
  rationale: string;
}

export interface TechnicalLearningPass2Output {
  header: ProfileArtifactHeader;
  edges: TechnicalLearningLongRangeEdgeCandidate[];
}

export interface Pass2AuditEntry {
  source: string;
  target: string;
  type: TechnicalLearningLongRangeEdgeType;
  evidence_lids: string[];
  rationale: string;
}

export interface Pass2AuditSidecar {
  header: ProfileArtifactHeader;
  edges: Pass2AuditEntry[];
}

export interface DroppedPass2Candidate {
  source: string;
  target: string;
  type: string;
  reason: "missing_source" | "missing_target" | "missing_both" | "dangling_evidence" | "empty_evidence" | "invalid_scope" | "invalid_type";
  evidence_lids: string[];
}

export interface Pass2LongRangeResult {
  edges: GraphEdge[];
  audit: Pass2AuditSidecar;
  dropped: DroppedPass2Candidate[];
}

export function gateTechnicalLearningPass2LongRange(
  output: TechnicalLearningPass2Output,
  graphNodes: GraphNode[],
  lidNodes: LidNode[],
): Pass2LongRangeResult {
  const nodeIds = new Set(graphNodes.map((n) => n.id));
  const lidSet = new Set(lidNodes.map((n) => n.lid));
  const edges: GraphEdge[] = [];
  const audit: Pass2AuditEntry[] = [];
  const dropped: DroppedPass2Candidate[] = [];

  for (const c of output.edges) {
    if (c.scope !== "long_range") {
      dropped.push({ source: c.source, target: c.target, type: c.type, reason: "invalid_scope", evidence_lids: c.evidence_lids });
      continue;
    }
    if (!LONG_RANGE_EDGE_TYPES.has(c.type)) {
      dropped.push({ source: c.source, target: c.target, type: c.type, reason: "invalid_type", evidence_lids: c.evidence_lids });
      continue;
    }

    const missSource = !nodeIds.has(c.source);
    const missTarget = !nodeIds.has(c.target);
    if (missSource || missTarget) {
      dropped.push({
        source: c.source,
        target: c.target,
        type: c.type,
        reason: missSource && missTarget ? "missing_both" : missSource ? "missing_source" : "missing_target",
        evidence_lids: c.evidence_lids,
      });
      continue;
    }
    if (c.evidence_lids.length === 0) {
      dropped.push({ source: c.source, target: c.target, type: c.type, reason: "empty_evidence", evidence_lids: [] });
      continue;
    }
    const dangling = c.evidence_lids.filter((l) => !lidSet.has(l));
    if (dangling.length > 0) {
      dropped.push({
        source: c.source,
        target: c.target,
        type: c.type,
        reason: "dangling_evidence",
        evidence_lids: dangling,
      });
      continue;
    }

    edges.push({
      source: c.source,
      target: c.target,
      type: c.type,
      direction: c.direction,
      scope: "long_range",
      weight: c.weight,
    });
    audit.push({
      source: c.source,
      target: c.target,
      type: c.type,
      evidence_lids: [...c.evidence_lids],
      rationale: c.rationale,
    });
  }

  return { edges, audit: { header: output.header, edges: audit }, dropped };
}
