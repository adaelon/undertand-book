import { createHash } from "node:crypto";
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { GraphNode } from "./generated/GraphNode";
import type { LidNode } from "./generated/LidNode";
import type { TechnicalLearningDiscourseIndex, TechnicalLearningDiscourseItem } from "./discourse-index";
import { buildLidToWindowIndex, buildLongRangeCandidates, EDGE_TYPE_CONTRACTS, type LongRangeCandidate, type LongRangeCandidateIndex, type Pass2LlmOutput, type Pass2WorkPacket } from "./pass2-build";
import type { Window } from "./window";

export interface Pass2Artifact {
  content_hash: string;
  output: Pass2LlmOutput;
}

export interface Pass2Status {
  done: number[];
  pending: number[];
  skipped: number[];
}

function graphNodeLids(node: GraphNode): string[] {
  if (node.type === "claim") return node.source_lid ? [node.source_lid] : [];
  return node.occurrences;
}

function textOfLid(lid: string, byLid: Map<string, LidNode>, source: string): string {
  const node = byLid.get(lid);
  if (!node) return "";
  return source.slice(node.span.start, node.span.end);
}

function titlePathOf(lid: string): string[] {
  const parts = lid.split(".");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("."));
  return out;
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

export function pass2PacketHash(packet: Pass2WorkPacket): string {
  return createHash("sha256").update(stableJson(packet)).digest("hex");
}

export function buildPass2Candidates(input: {
  graphNodes: GraphNode[];
  windows: Pick<Window, "leafLids">[];
  discourseIndex?: TechnicalLearningDiscourseIndex;
  formulaSemantics?: FormulaSemantics[];
}): LongRangeCandidateIndex {
  const lidToWindowIndex = buildLidToWindowIndex(input.windows);
  return {
    candidates: buildLongRangeCandidates({
      graphNodes: input.graphNodes,
      lidToWindowIndex,
      discourseIndex: input.discourseIndex,
      formulaSemantics: input.formulaSemantics,
    }),
  };
}

export function buildPass2WorkPacket(input: {
  window: Window;
  byLid: Map<string, LidNode>;
  source: string;
  graphNodes: GraphNode[];
  candidates: LongRangeCandidate[];
  discourseIndex?: TechnicalLearningDiscourseIndex;
  formulaSemantics?: FormulaSemantics[];
}): Pass2WorkPacket {
  const leafSet = new Set(input.window.leafLids);
  const sourceNodes = input.graphNodes
    .filter((node) => graphNodeLids(node).some((lid) => leafSet.has(lid)))
    .map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      lids: graphNodeLids(node).filter((lid) => leafSet.has(lid)).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const sourceDiscourse = (input.discourseIndex?.items ?? [])
    .filter((item: TechnicalLearningDiscourseItem) => leafSet.has(item.lid))
    .sort((a, b) => a.lid.localeCompare(b.lid));
  const sourceFormulaSemantics = (input.formulaSemantics ?? [])
    .filter((item) => leafSet.has(item.formula_lid))
    .sort((a, b) => a.formula_lid.localeCompare(b.formula_lid));
  const candidateTargets = input.candidates
    .filter((candidate) => candidate.source_lids.some((lid) => leafSet.has(lid)))
    .sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));

  return {
    packet_id: `pass2-window:${input.window.id}`,
    source_window: {
      index: input.window.id,
      leaf_lids: [...input.window.leafLids],
      title_path: titlePathOf(input.window.leafLids[0] ?? ""),
      text: input.window.leafLids.map((lid) => ({ lid, text: textOfLid(lid, input.byLid, input.source) })),
    },
    source_nodes: sourceNodes,
    source_discourse: sourceDiscourse,
    source_formula_semantics: sourceFormulaSemantics,
    candidate_targets: candidateTargets,
    edge_type_contracts: EDGE_TYPE_CONTRACTS,
  };
}

export function buildPass2Artifact(packet: Pass2WorkPacket, output: Pass2LlmOutput): Pass2Artifact {
  return {
    content_hash: pass2PacketHash(packet),
    output,
  };
}

export function computePass2Status(
  packets: Map<number, Pass2WorkPacket>,
  existing: Map<number, Pick<Pass2Artifact, "content_hash">>,
): Pass2Status {
  const done: number[] = [];
  const pending: number[] = [];
  const skipped: number[] = [];
  for (const [id, packet] of [...packets.entries()].sort((a, b) => a[0] - b[0])) {
    if (packet.candidate_targets.length === 0) {
      skipped.push(id);
      continue;
    }
    const expected = pass2PacketHash(packet);
    const got = existing.get(id);
    if (got && got.content_hash === expected) done.push(id);
    else pending.push(id);
  }
  return { done, pending, skipped };
}
