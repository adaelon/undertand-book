// PB3 build-only Pass2 artifacts (docs: docs/PB3-pass2-prompt-grill.md).
// These shapes/helpers feed deterministic long-range candidate generation and the
// PB3 work-packet/gate pipeline. None of this is loaded by Book::load or consumed
// at read time; long_range_candidates.json is a build/audit artifact only.
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { GraphEdge } from "./generated/GraphEdge";
import type { GraphNode } from "./generated/GraphNode";
import type { LidNode } from "./generated/LidNode";
import type { LocalFunction, RhetoricalMove, TechnicalLearningDiscourseIndex, TechnicalLearningDiscourseItem } from "./discourse-index";
import type { ProfileArtifactHeader } from "./profile-artifact";
import { TECHNICAL_LEARNING_LONG_RANGE_EDGE_TYPES, type TechnicalLearningLongRangeEdgeType } from "./pass2";
import type { Window } from "./window";

// PB3 grill §2: minimal candidate shape used as Pass2 prompt input + coverage/audit debugging.
export interface LongRangeCandidate {
  candidate_id: string;
  source_node_id: string;
  target_node_id: string;
  source_lids: string[];
  target_lids: string[];
  seed_reasons: string[];
  relation_hints: TechnicalLearningLongRangeEdgeType[];
  seed_score: number;
}

export interface LongRangeCandidateIndex {
  candidates: LongRangeCandidate[];
}

/** Map every leaf LID to the index of the window that contains it (PB3 grill §12). */
export function buildLidToWindowIndex(windows: Pick<Window, "leafLids">[]): Map<string, number> {
  const map = new Map<string, number>();
  windows.forEach((w, index) => {
    for (const lid of w.leafLids) map.set(lid, index);
  });
  return map;
}

// PB3 grill §12 hard definition: a Pass2 long-range edge requires source and target
// evidence to cross windows. True iff at least one source LID and one target LID
// resolve to different window indexes. LIDs absent from the map are ignored (they
// contribute no cross-window signal); if neither side resolves, it is not cross-window.
export function isCrossWindow(
  sourceLids: string[],
  targetLids: string[],
  lidToWindowIndex: Map<string, number>,
): boolean {
  const resolve = (lids: string[]): number[] =>
    lids.map((lid) => lidToWindowIndex.get(lid)).filter((i): i is number => i !== undefined);
  const sourceWindows = resolve(sourceLids);
  const targetWindows = resolve(targetLids);
  return sourceWindows.some((s) => targetWindows.some((t) => s !== t));
}

// PB3-2 deterministic candidate generation (PB3 grill §11 signals 4 + 1 + 2 + 3).
// signal 4 (a graph node recurring across distant windows) is the join backbone;
// signals 1/2 (discourse local_function / rhetorical_move complementarity) set
// relation_hints; signal 3 (FormulaSemantics definition/use) bridges the graph nodes
// at the formula LID and its cross-window context_links.
// Comprehensiveness is deterministic here (high recall); precision is the LLM's job
// plus the PB3 gate. Forbidden by grill §11: claim similarity, graph expansion,
// title matching, same_problem.
export interface LongRangeCandidateInput {
  graphNodes: GraphNode[];
  lidToWindowIndex: Map<string, number>;
  discourseIndex?: TechnicalLearningDiscourseIndex;
  // PB3-2b signal 3: a formula defined at formula_lid and referenced via context_links
  // in a distant window bridges the graph nodes at those LIDs.
  formulaSemantics?: FormulaSemantics[];
}

const SIGNAL1_SOURCE_FUNCTIONS = new Set<LocalFunction>(["definition", "explanation"]);
const SIGNAL1_TARGET_FUNCTIONS = new Set<LocalFunction>(["application", "example", "procedure_step"]);
const SIGNAL2_SOURCE_MOVES = new Set<RhetoricalMove>(["prerequisite", "main_point"]);
const SIGNAL2_TARGET_MOVES = new Set<RhetoricalMove>(["concept_elaboration", "worked_example"]);

function occLidsOf(node: GraphNode): string[] {
  if (node.type === "claim") return node.source_lid ? [node.source_lid] : [];
  return node.occurrences;
}

function uniqSort(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqHints(hints: TechnicalLearningLongRangeEdgeType[]): TechnicalLearningLongRangeEdgeType[] {
  return [...new Set(hints)];
}

interface HintResult {
  hints: TechnicalLearningLongRangeEdgeType[];
  reasons: string[];
  signals: number;
}

function hintsFor(
  sourceLids: string[],
  targetLids: string[],
  funcOf: Map<string, LocalFunction | undefined>,
  moveOf: Map<string, RhetoricalMove | undefined>,
  bridgeNodeId: string,
): HintResult {
  const reasons = [`shared_node_bridge:${bridgeNodeId}`];
  const hints: TechnicalLearningLongRangeEdgeType[] = [];
  let signals = 0;

  const srcFuncs = sourceLids.map((l) => funcOf.get(l));
  const tgtFuncs = targetLids.map((l) => funcOf.get(l));
  if (
    srcFuncs.some((f) => f !== undefined && SIGNAL1_SOURCE_FUNCTIONS.has(f)) &&
    tgtFuncs.some((f) => f !== undefined && SIGNAL1_TARGET_FUNCTIONS.has(f))
  ) {
    hints.push("exemplifies", "applies");
    reasons.push("signal1_definition_to_use");
    signals++;
  }

  const srcMoves = sourceLids.map((l) => moveOf.get(l));
  const tgtMoves = targetLids.map((l) => moveOf.get(l));
  if (
    srcMoves.some((m) => m !== undefined && SIGNAL2_SOURCE_MOVES.has(m)) &&
    tgtMoves.some((m) => m !== undefined && SIGNAL2_TARGET_MOVES.has(m))
  ) {
    hints.push("builds_on", "prerequisite");
    reasons.push("signal2_prerequisite_to_elaboration");
    signals++;
  }

  return { hints: uniqHints(hints), reasons, signals };
}

export function buildLongRangeCandidates(input: LongRangeCandidateInput): LongRangeCandidate[] {
  const { graphNodes, lidToWindowIndex, discourseIndex, formulaSemantics } = input;

  const funcOf = new Map<string, LocalFunction | undefined>();
  const moveOf = new Map<string, RhetoricalMove | undefined>();
  for (const item of discourseIndex?.items ?? []) {
    funcOf.set(item.lid, item.local_function);
    moveOf.set(item.lid, item.rhetorical_move);
  }

  // node id -> (window index -> the node's LIDs in that window)
  const nodeWindows = new Map<string, Map<number, string[]>>();
  // window index -> node ids that occur in it (co-location lookup)
  const windowNodes = new Map<number, Set<string>>();
  // LID -> node ids occurring at that LID (formula-bridge endpoint resolution)
  const lidToNodes = new Map<string, string[]>();
  for (const node of graphNodes) {
    for (const lid of occLidsOf(node)) {
      const nodesAtLid = lidToNodes.get(lid);
      if (nodesAtLid) nodesAtLid.push(node.id);
      else lidToNodes.set(lid, [node.id]);
      const w = lidToWindowIndex.get(lid);
      if (w === undefined) continue;
      let byWin = nodeWindows.get(node.id);
      if (!byWin) {
        byWin = new Map();
        nodeWindows.set(node.id, byWin);
      }
      const arr = byWin.get(w);
      if (arr) arr.push(lid);
      else byWin.set(w, [lid]);
      let present = windowNodes.get(w);
      if (!present) {
        present = new Set();
        windowNodes.set(w, present);
      }
      present.add(node.id);
    }
  }

  const merged = new Map<string, LongRangeCandidate>();
  // seed_score = min(1, 0.4 + 0.3 * signals); base 0.4 = primary seed matched
  // (signal 4 bridge or signal 3 formula link), +0.3 per refining discourse signal.
  // Placeholder weights, to be recalibrated against real recall (grill §11).
  const emit = (
    srcId: string,
    tgtId: string,
    srcLids: string[],
    tgtLids: string[],
    hints: TechnicalLearningLongRangeEdgeType[],
    reasons: string[],
    signals: number,
  ): void => {
    if (srcId === tgtId) return;
    if (!isCrossWindow(srcLids, tgtLids, lidToWindowIndex)) return;
    const seedScore = Math.min(1, 0.4 + 0.3 * signals);
    const key = `${srcId} ${tgtId}`;
    const existing = merged.get(key);
    if (existing) {
      existing.source_lids = uniqSort([...existing.source_lids, ...srcLids]);
      existing.target_lids = uniqSort([...existing.target_lids, ...tgtLids]);
      existing.seed_reasons = uniqSort([...existing.seed_reasons, ...reasons]);
      existing.relation_hints = uniqHints([...existing.relation_hints, ...hints]);
      existing.seed_score = Math.max(existing.seed_score, seedScore);
    } else {
      merged.set(key, {
        candidate_id: `cand:${srcId}->${tgtId}`,
        source_node_id: srcId,
        target_node_id: tgtId,
        source_lids: uniqSort(srcLids),
        target_lids: uniqSort(tgtLids),
        seed_reasons: reasons,
        relation_hints: hints,
        seed_score: seedScore,
      });
    }
  };

  // signals 4 + 1 + 2: recurring-node bridge with discourse-function relation hints.
  for (const node of graphNodes) {
    const byWin = nodeWindows.get(node.id);
    if (!byWin || byWin.size < 2) continue; // signal 4: must recur across >=2 windows
    const winsAsc = [...byWin.keys()].sort((a, b) => a - b);
    const sourceWin = winsAsc[0]; // earliest appearance anchors the source side
    const sourceLids = byWin.get(sourceWin)!;
    for (const laterWin of winsAsc.slice(1)) {
      for (const bId of [...(windowNodes.get(laterWin) ?? [])].sort()) {
        if (bId === node.id) continue;
        const targetLids = nodeWindows.get(bId)!.get(laterWin)!;
        const { hints, reasons, signals } = hintsFor(sourceLids, targetLids, funcOf, moveOf, node.id);
        emit(node.id, bId, sourceLids, targetLids, hints, reasons, signals);
      }
    }
  }

  // signal 3: formula definition/use bridge across windows.
  for (const formula of formulaSemantics ?? []) {
    const formulaWin = lidToWindowIndex.get(formula.formula_lid);
    if (formulaWin === undefined) continue;
    const sourceNodes = lidToNodes.get(formula.formula_lid) ?? [];
    for (const link of formula.context_links) {
      const targetWin = lidToWindowIndex.get(link.target_lid);
      if (targetWin === undefined || targetWin === formulaWin) continue; // must cross windows
      const targetNodes = lidToNodes.get(link.target_lid) ?? [];
      for (const srcId of sourceNodes) {
        for (const tgtId of targetNodes) {
          emit(
            srcId,
            tgtId,
            [formula.formula_lid],
            [link.target_lid],
            ["applies", "builds_on"],
            [`signal3_formula_bridge:${formula.formula_lid}`],
            1,
          );
        }
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
}

// ---------------------------------------------------------------------------
// PB3-3 PB3 gate (grill §7 split evidence / §8 support level / §9 hard gate).
// Consumes the Pass2 LLM output (accepted/pending/rejected). Only accepted edges
// that pass the deterministic hard gate are lowered into GraphEdge(scope=long_range);
// split evidence, support_level, rationale stay in pass2_audit.json. pending +
// rejected + gate-dropped go to audit only and never into base.json.
// ---------------------------------------------------------------------------

export type SupportLevel = "explicit" | "strong_inference" | "weak_inference";

// PB3 grill §7: accepted edge carries side-split evidence; only Core fields are lowered.
export interface TechnicalLearningAcceptedEdge {
  candidate_id: string;
  source: string;
  target: string;
  type: TechnicalLearningLongRangeEdgeType;
  direction: "directed" | "undirected";
  scope: "long_range";
  weight: number;
  source_evidence_lids: string[];
  target_evidence_lids: string[];
  evidence_lids: string[];
  support_level: SupportLevel;
  rationale: string;
  failure_risk?: string;
}

// PB3 grill §3: rejected candidates kept as compact records (LLM classification).
export type RejectedReason =
  | "topical_overlap_only"
  | "missing_source_evidence"
  | "missing_target_evidence"
  | "relation_contract_not_met"
  | "direction_unclear"
  | "weak_retrieval_value"
  | "duplicate_or_local_relation";

export interface RejectedCandidate {
  candidate_id: string;
  reason: RejectedReason;
}

export interface Pass2LlmOutput {
  accepted_edges: TechnicalLearningAcceptedEdge[];
  pending_edges: TechnicalLearningAcceptedEdge[];
  rejected_candidates: RejectedCandidate[];
}

// Deterministic gate drop reasons for accepted_edges that fail the hard gate (§9).
export type Pass2GateDropReason =
  | "invalid_type"
  | "invalid_scope"
  | "missing_source"
  | "missing_target"
  | "empty_source_evidence"
  | "empty_target_evidence"
  | "evidence_not_covering"
  | "dangling_evidence"
  | "weak_inference"
  | "below_weight_threshold"
  | "not_cross_window";

export interface Pass2GateDrop {
  candidate_id: string;
  reason: Pass2GateDropReason;
}

export interface Pass2AuditEdge {
  candidate_id: string;
  source: string;
  target: string;
  type: TechnicalLearningLongRangeEdgeType;
  source_evidence_lids: string[];
  target_evidence_lids: string[];
  evidence_lids: string[];
  support_level: SupportLevel;
  rationale: string;
  failure_risk?: string;
}

export interface Pass2BuildAuditSidecar {
  header: ProfileArtifactHeader;
  accepted: Pass2AuditEdge[];
  pending: Pass2AuditEdge[];
  rejected: RejectedCandidate[];
  gate_dropped: Pass2GateDrop[];
}

export interface Pass2BuildResult {
  edges: GraphEdge[];
  audit: Pass2BuildAuditSidecar;
}

// ---------------------------------------------------------------------------
// PB3-4 work packet + edge type contracts (grill §5 / §6 / §10).
// The contracts are the per-edge-type rubric the Pass2 prompt must apply; the
// work packet is the per-source-window unit the LLM classifies. Both are build-only.
// ---------------------------------------------------------------------------

export interface EdgeTypeContract {
  type: TechnicalLearningLongRangeEdgeType;
  direction: "directed" | "undirected";
  when: string;
  when_not: string;
  evidence: string;
  roles: string;
}

// grill §5 (per-type when/when-not/evidence/roles) + §6 (direction policy).
// directed roles read "source <type> target". analogous_to is undirected; contrasts
// defaults to directed and may be undirected only for pure symmetric comparison.
export const EDGE_TYPE_CONTRACTS: Record<TechnicalLearningLongRangeEdgeType, EdgeTypeContract> = {
  builds_on: {
    type: "builds_on",
    direction: "directed",
    when: "source extends or depends on target's mechanism, adding new capability on top of it.",
    when_not: "mere topical overlap, or source only restates/summarizes target (use restates/summarizes).",
    evidence: "source text shows it reuses or extends the target concept introduced elsewhere.",
    roles: "source is the later/dependent idea; target is the foundation it builds on.",
  },
  prerequisite: {
    type: "prerequisite",
    direction: "directed",
    when: "target cannot be understood without first understanding source (pedagogical ordering).",
    when_not: "source merely extends target's mechanism (that is builds_on, not prerequisite).",
    evidence: "target text relies on a concept whose definition/derivation lives at source.",
    roles: "source is the prerequisite; target is what needs it first.",
  },
  applies: {
    type: "applies",
    direction: "directed",
    when: "source puts target's concept/formula to use in a concrete setting.",
    when_not: "source only names target without using it (topical overlap), or just defines it.",
    evidence: "source text performs/uses the target idea on a concrete case.",
    roles: "source is the application; target is the concept/formula being applied.",
  },
  exemplifies: {
    type: "exemplifies",
    direction: "directed",
    when: "source is a concrete example/instance of target's general concept.",
    when_not: "source uses the concept operationally without being an illustrative example (use applies).",
    evidence: "source text is presented as an example of the target concept.",
    roles: "source is the example; target is the general concept.",
  },
  refines: {
    type: "refines",
    direction: "directed",
    when: "source narrows, corrects, or makes more precise the target's claim/definition.",
    when_not: "source replaces/denies target (contradicts) or merely repeats it (restates).",
    evidence: "source text revises or tightens the target statement.",
    roles: "source is the refinement; target is the coarser prior statement.",
  },
  supports: {
    type: "supports",
    direction: "directed",
    when: "source provides evidence/argument that strengthens target's claim.",
    when_not: "source builds new capability on target (builds_on) rather than evidencing it.",
    evidence: "source text argues for or backs the target claim.",
    roles: "source is the supporting evidence; target is the claim supported.",
  },
  rebuts: {
    type: "rebuts",
    direction: "directed",
    when: "source argues against target's claim, weakening or refuting it.",
    when_not: "source merely differs in scope/setting without opposing it (contrasts).",
    evidence: "source text presents a counter-argument to the target claim.",
    roles: "source is the rebuttal; target is the claim being rebutted.",
  },
  contradicts: {
    type: "contradicts",
    direction: "directed",
    when: "source states something that cannot both be true with target.",
    when_not: "source argues against target with reasoning (rebuts), or merely differs (contrasts).",
    evidence: "both statements are explicit and logically incompatible.",
    roles: "source is the conflicting statement; target is the contradicted one.",
  },
  summarizes: {
    type: "summarizes",
    direction: "directed",
    when: "source condenses target's content into a shorter recap.",
    when_not: "source adds new capability (builds_on) or new precision (refines).",
    evidence: "source text recaps the target material.",
    roles: "source is the summary; target is the summarized material.",
  },
  analogous_to: {
    type: "analogous_to",
    direction: "undirected",
    when: "two ideas share a structural parallel without one depending on the other.",
    when_not: "one idea depends on or extends the other (builds_on/prerequisite).",
    evidence: "both texts show the same structure applied to different subjects.",
    roles: "symmetric: neither endpoint is primary.",
  },
  contrasts: {
    type: "contrasts",
    direction: "directed",
    when: "source is compared against target to highlight differences (not a logical conflict).",
    when_not: "source denies target (contradicts) or argues against it (rebuts).",
    evidence: "source text explicitly compares/differentiates itself from target.",
    roles: "default directed (source contrasted against target); undirected only for pure symmetric comparison.",
  },
};

export interface CandidateNodeSnapshot {
  id: string;
  type: string;
  name: string;
  lids: string[];
}

// grill §10: the per-source-window unit the Pass2 LLM classifies. Chapter is used
// only for grouping/coverage/audit, not as the minimal classification unit.
export interface Pass2WorkPacket {
  packet_id: string;
  source_window: {
    index: number;
    leaf_lids: string[];
    title_path: string[];
    text: Array<{ lid: string; text: string }>;
  };
  source_nodes: CandidateNodeSnapshot[];
  source_discourse: TechnicalLearningDiscourseItem[];
  source_formula_semantics: FormulaSemantics[];
  candidate_targets: LongRangeCandidate[];
  edge_type_contracts: Record<string, EdgeTypeContract>;
}

export interface Pass2GateOptions {
  /** Minimum weight for an accepted edge to be lowered (grill §9, placeholder default). */
  minWeight?: number;
}

export const MIN_LONG_RANGE_WEIGHT = 0.5;

const LONG_RANGE_EDGE_TYPE_SET: ReadonlySet<string> = new Set(TECHNICAL_LEARNING_LONG_RANGE_EDGE_TYPES);

function auditEdgeOf(edge: TechnicalLearningAcceptedEdge): Pass2AuditEdge {
  return {
    candidate_id: edge.candidate_id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    source_evidence_lids: [...edge.source_evidence_lids],
    target_evidence_lids: [...edge.target_evidence_lids],
    evidence_lids: [...edge.evidence_lids],
    support_level: edge.support_level,
    rationale: edge.rationale,
    ...(edge.failure_risk !== undefined ? { failure_risk: edge.failure_risk } : {}),
  };
}

// Hard gate for a single accepted edge (grill §9). Returns the drop reason, or null if it passes.
function acceptedEdgeDropReason(
  edge: TechnicalLearningAcceptedEdge,
  nodeIds: Set<string>,
  lidSet: Set<string>,
  lidToWindowIndex: Map<string, number>,
  minWeight: number,
): Pass2GateDropReason | null {
  if (!LONG_RANGE_EDGE_TYPE_SET.has(edge.type)) return "invalid_type";
  if (edge.scope !== "long_range") return "invalid_scope";
  if (!nodeIds.has(edge.source)) return "missing_source";
  if (!nodeIds.has(edge.target)) return "missing_target";
  if (edge.source_evidence_lids.length === 0) return "empty_source_evidence";
  if (edge.target_evidence_lids.length === 0) return "empty_target_evidence";
  const evidenceSet = new Set(edge.evidence_lids);
  const covers = [...edge.source_evidence_lids, ...edge.target_evidence_lids].every((l) => evidenceSet.has(l));
  if (!covers) return "evidence_not_covering";
  if (edge.evidence_lids.some((l) => !lidSet.has(l))) return "dangling_evidence";
  if (edge.support_level === "weak_inference") return "weak_inference";
  if (!(edge.weight >= minWeight)) return "below_weight_threshold";
  if (!isCrossWindow(edge.source_evidence_lids, edge.target_evidence_lids, lidToWindowIndex)) return "not_cross_window";
  return null;
}

export function gatePass2BuildOutput(
  output: Pass2LlmOutput,
  header: ProfileArtifactHeader,
  graphNodes: GraphNode[],
  lidNodes: LidNode[],
  lidToWindowIndex: Map<string, number>,
  options: Pass2GateOptions = {},
): Pass2BuildResult {
  const minWeight = options.minWeight ?? MIN_LONG_RANGE_WEIGHT;
  const nodeIds = new Set(graphNodes.map((n) => n.id));
  const lidSet = new Set(lidNodes.map((n) => n.lid));

  const edges: GraphEdge[] = [];
  const accepted: Pass2AuditEdge[] = [];
  const gateDropped: Pass2GateDrop[] = [];

  for (const edge of output.accepted_edges) {
    const reason = acceptedEdgeDropReason(edge, nodeIds, lidSet, lidToWindowIndex, minWeight);
    if (reason) {
      gateDropped.push({ candidate_id: edge.candidate_id, reason });
      continue;
    }
    edges.push({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      direction: edge.direction,
      scope: "long_range",
      weight: edge.weight,
    });
    accepted.push(auditEdgeOf(edge));
  }

  // pending_edges are recorded for audit but never lowered into base.json (grill §3/§8).
  const pending = output.pending_edges.map(auditEdgeOf);

  return {
    edges,
    audit: {
      header,
      accepted,
      pending,
      rejected: output.rejected_candidates.map((r) => ({ ...r })),
      gate_dropped: gateDropped,
    },
  };
}
