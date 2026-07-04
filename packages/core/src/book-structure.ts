import { createHash } from "node:crypto";
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { GraphEdge } from "./generated/GraphEdge";
import type { GraphNode } from "./generated/GraphNode";
import type { LidNode } from "./generated/LidNode";
import type { Pass2AuditEdge, Pass2BuildAuditSidecar } from "./pass2-build";
import type { ProfileArtifactHeader } from "./profile-artifact";
import type { TechnicalLearningDiscourseIndex, TechnicalLearningDiscourseItem } from "./discourse-index";

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

export interface BookStructureUnitSource {
  job_id: string;
  unit_lid: string;
  unit_kind: LidNode["kind"];
  title_path: string[];
  leaf_lids: string[];
  excerpts: BookStructureTextExcerpt[];
  graph_nodes: GraphNode[];
  graph_edges: GraphEdge[];
  discourse_items: TechnicalLearningDiscourseItem[];
  formula_semantics: FormulaSemantics[];
  pass2_edges: Pass2AuditEdge[];
}

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
}): BookStructureUnitSource[] {
  const byLid = new Map(input.lidNodes.map((node) => [node.lid, node]));
  const units = selectStructureUnits(input.lidNodes, byLid);
  const discourseByLid = new Map((input.discourseIndex?.items ?? []).map((item) => [item.lid, item]));
  const formulaByLid = new Map((input.formulaSemantics ?? []).map((item) => [item.formula_lid, item]));

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
): BookStructureStitchPacket {
  return {
    job_id: "stitch",
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
