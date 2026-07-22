import { createHash } from "node:crypto";
import { z } from "zod";
import type { LidNode } from "./generated/LidNode";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import type { HybridFoundationAdaptationMigrationMap } from "./hybrid-foundation-goldset";
import { HybridFoundationAdaptationMigrationMapZ } from "./hybrid-foundation-goldset";
import {
  parseMarkdownSourceBlocks,
  type MarkdownSourceReviewProposal,
} from "./md-adapter";
import { checkPartitionInvariant } from "./partition";
import { segment, type Span } from "./segment";
import { ReadOnlyBaseZ } from "./zod";

const Sha256Z = z.string().regex(/^[a-f0-9]{64}$/u);
const SpanZ = z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((span) => span.end > span.start, "span must be non-empty");

const EvidenceZ = z.object({
  id: z.string().min(1),
  kind: z.enum(["original_markdown", "official_arxiv_source", "manual_confirmation"]),
  revision: z.string().min(1).optional(),
  sha256: Sha256Z,
});

const DecisionZ = z.object({
  id: z.string().min(1),
  category: z.enum(["material_mismatch", "malformed_inline_math", "unfenced_code"]),
  baseline_lid: z.string().min(1).optional(),
  source_span: SpanZ.optional(),
  status: z.enum(["reviewed_repaired", "intentional_source_difference"]),
  evidence_id: z.string().min(1),
  repair_id: z.string().min(1).optional(),
}).superRefine((decision, context) => {
  if (decision.category === "material_mismatch" && !decision.baseline_lid) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "material decision requires baseline_lid" });
  }
  if (decision.category !== "material_mismatch" && !decision.source_span) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "structure decision requires source_span" });
  }
  if (decision.status === "reviewed_repaired" && !decision.repair_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "reviewed_repaired decision requires repair_id" });
  }
  if (decision.status === "intentional_source_difference" && decision.repair_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "intentional_source_difference forbids repair_id" });
  }
});

const RepairZ = z.object({
  id: z.string().min(1),
  kind: z.enum(["official_latex_emphasis", "official_latex_listing"]),
  source_span: SpanZ,
  source_span_sha256: Sha256Z,
  evidence_id: z.string().min(1),
  evidence_content_sha256: Sha256Z,
});

export const ReviewedSourceRepairPlanZ = z.object({
  version: z.literal("reviewed_source_repair_plan.v1"),
  old_book_id: z.string().min(1),
  new_book_id: z.string().min(1),
  input_fingerprint: z.object({ source_sha256: Sha256Z, base_sha256: Sha256Z }),
  evidence: z.array(EvidenceZ).min(1),
  decisions: z.array(DecisionZ).min(1),
  repairs: z.array(RepairZ).min(1),
}).superRefine((plan, context) => {
  for (const [label, values] of [
    ["evidence", plan.evidence.map((item) => item.id)],
    ["decision", plan.decisions.map((item) => item.id)],
    ["repair", plan.repairs.map((item) => item.id)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${label} id` });
    }
  }
  if (plan.old_book_id === plan.new_book_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate requires an independent new_book_id" });
  }
});

export type ReviewedSourceRepairPlan = z.infer<typeof ReviewedSourceRepairPlanZ>;

export interface BuildReviewedSourceCandidateInput {
  source: string;
  old_base_json: string;
  required_material_lids: string[];
  required_review_proposals: MarkdownSourceReviewProposal[];
  plan: ReviewedSourceRepairPlan;
  evidence: Record<string, string>;
}

interface RenderedRepair {
  id: string;
  old_span: Span;
  new_span: Span;
  replacement: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function spanKey(kind: string, span: Span): string {
  return `${kind}:${span.start}:${span.end}`;
}

function rangesOverlap(left: Span, right: Span): boolean {
  return left.start < right.end && right.start < left.end;
}

function contains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function extractBalancedCommands(source: string, command: string): string[] {
  const marker = `\\${command}{`;
  const results: string[] = [];
  let searchFrom = 0;
  while (true) {
    const markerStart = source.indexOf(marker, searchFrom);
    if (markerStart < 0) break;
    const contentStart = markerStart + marker.length;
    let depth = 1;
    let cursor = contentStart;
    for (; cursor < source.length && depth > 0; cursor += 1) {
      if (source[cursor] === "{" && source[cursor - 1] !== "\\") depth += 1;
      if (source[cursor] === "}" && source[cursor - 1] !== "\\") depth -= 1;
    }
    if (depth !== 0) throw new Error(`unbalanced \\${command} evidence command`);
    results.push(source.slice(contentStart, cursor - 1));
    searchFrom = cursor;
  }
  return results;
}

interface LatexListing {
  body: string;
  language: string;
  caption?: string;
}

function extractListings(source: string): LatexListing[] {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const expression = /\\begin\{lstlisting\}(?:\[([^\]]*)\])?\s*\n([\s\S]*?)\n\\end\{lstlisting\}/gu;
  return [...normalized.matchAll(expression)].map((match) => {
    const options = match[1] ?? "";
    const language = /(?:^|,)\s*language\s*=\s*([^,]+?)(?=\s*,|$)/iu.exec(options)?.[1].trim() ?? "text";
    const caption = /(?:^|,)\s*caption\s*=\s*([^,]+?)(?=\s*,|$)/iu.exec(options)?.[1].trim();
    return { body: match[2], language, ...(caption ? { caption } : {}) };
  });
}

function selectUniqueByHash<T>(values: T[], content: (value: T) => string, expected: string, label: string): T {
  const matches = values.filter((value) => sha256(content(value)) === expected);
  if (matches.length !== 1) throw new Error(`${label} evidence content hash matched ${matches.length} items`);
  return matches[0];
}

function renderRepair(
  repair: ReviewedSourceRepairPlan["repairs"][number],
  evidence: string,
): string {
  if (repair.kind === "official_latex_emphasis") {
    const body = selectUniqueByHash(
      extractBalancedCommands(evidence, "emph"),
      (value) => value,
      repair.evidence_content_sha256,
      repair.id,
    );
    return `*${body}*`;
  }
  const listing = selectUniqueByHash(
    extractListings(evidence),
    (value) => value.body,
    repair.evidence_content_sha256,
    repair.id,
  );
  const language = listing.language.toLocaleLowerCase("en-US");
  return `\`\`\`${language}\n${listing.body}\n\`\`\`${listing.caption ? `\n\n${listing.caption}` : ""}\n`;
}

function validateRequirements(
  plan: ReviewedSourceRepairPlan,
  materialLids: string[],
  proposals: MarkdownSourceReviewProposal[],
): void {
  const expectedMaterials = new Set(materialLids);
  const actualMaterials = new Set(plan.decisions
    .filter((decision) => decision.category === "material_mismatch")
    .map((decision) => decision.baseline_lid!));
  for (const lid of expectedMaterials) {
    if (!actualMaterials.has(lid)) throw new Error(`missing required decision for material:${lid}`);
  }
  for (const lid of actualMaterials) {
    if (!expectedMaterials.has(lid)) throw new Error(`unexpected material decision:${lid}`);
  }

  const expectedProposals = new Set(proposals.map((proposal) => spanKey(proposal.kind, proposal.source_span)));
  const actualProposals = new Set(plan.decisions
    .filter((decision) => decision.category !== "material_mismatch")
    .map((decision) => spanKey(decision.category, decision.source_span!)));
  for (const proposal of expectedProposals) {
    if (!actualProposals.has(proposal)) throw new Error(`missing required decision for ${proposal}`);
  }
  for (const proposal of actualProposals) {
    if (!expectedProposals.has(proposal)) throw new Error(`unexpected structure decision:${proposal}`);
  }
  if (actualMaterials.size !== plan.decisions.filter((item) => item.category === "material_mismatch").length
    || actualProposals.size !== plan.decisions.filter((item) => item.category !== "material_mismatch").length) {
    throw new Error("duplicate requirement decision");
  }
}

function validateReviewCoverage(plan: ReviewedSourceRepairPlan, oldBase: ReadOnlyBase): void {
  const repairs = new Map(plan.repairs.map((repair) => [repair.id, repair]));
  const oldLeaves = new Map(oldBase.lid_nodes.filter((node) => node.children.length === 0).map((node) => [node.lid, node]));
  const usedRepairs = new Set<string>();
  for (const decision of plan.decisions) {
    if (decision.status !== "reviewed_repaired") continue;
    const repair = repairs.get(decision.repair_id!);
    if (!repair) throw new Error(`unknown repair:${decision.repair_id}`);
    usedRepairs.add(repair.id);
    if (decision.category === "material_mismatch") {
      const leaf = oldLeaves.get(decision.baseline_lid!);
      if (!leaf) throw new Error(`material decision references non-leaf:${decision.baseline_lid}`);
      if (!rangesOverlap(repair.source_span, leaf.span)) {
        throw new Error(`repair does not cover reviewed material:${decision.baseline_lid}`);
      }
    } else if (!rangesOverlap(repair.source_span, decision.source_span!)) {
      throw new Error(`repair does not cover reviewed proposal:${decision.id}`);
    }
  }
  for (const repair of plan.repairs) {
    if (!usedRepairs.has(repair.id)) throw new Error(`unused repair:${repair.id}`);
  }
}

function applyRepairs(
  source: string,
  plan: ReviewedSourceRepairPlan,
  evidenceById: Record<string, string>,
): { source: string; repairs: RenderedRepair[] } {
  const sorted = [...plan.repairs].sort((left, right) => left.source_span.start - right.source_span.start);
  for (let index = 0; index < sorted.length; index += 1) {
    const repair = sorted[index];
    if (repair.source_span.end > source.length) throw new Error(`repair outside source:${repair.id}`);
    if (index > 0 && sorted[index - 1].source_span.end > repair.source_span.start) {
      throw new Error(`overlapping repairs:${sorted[index - 1].id}:${repair.id}`);
    }
    const oldSlice = source.slice(repair.source_span.start, repair.source_span.end);
    if (sha256(oldSlice) !== repair.source_span_sha256) throw new Error(`repair source hash mismatch:${repair.id}`);
  }

  let output = "";
  let oldCursor = 0;
  const rendered: RenderedRepair[] = [];
  for (const repair of sorted) {
    output += source.slice(oldCursor, repair.source_span.start);
    const replacement = renderRepair(repair, evidenceById[repair.evidence_id]);
    const newStart = output.length;
    output += replacement;
    rendered.push({ id: repair.id, old_span: repair.source_span, new_span: { start: newStart, end: output.length }, replacement });
    oldCursor = repair.source_span.end;
  }
  output += source.slice(oldCursor);
  return { source: output, repairs: rendered };
}

interface CoordinateSegment {
  old_span: Span;
  new_span: Span;
  changed: boolean;
}

function coordinateSegments(sourceLength: number, candidateLength: number, repairs: RenderedRepair[]): CoordinateSegment[] {
  const segments: CoordinateSegment[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const repair of repairs) {
    const unchangedLength = repair.old_span.start - oldCursor;
    if (unchangedLength > 0) {
      segments.push({
        old_span: { start: oldCursor, end: repair.old_span.start },
        new_span: { start: newCursor, end: newCursor + unchangedLength },
        changed: false,
      });
    }
    segments.push({ old_span: repair.old_span, new_span: repair.new_span, changed: true });
    oldCursor = repair.old_span.end;
    newCursor = repair.new_span.end;
  }
  if (oldCursor < sourceLength) {
    segments.push({
      old_span: { start: oldCursor, end: sourceLength },
      new_span: { start: newCursor, end: candidateLength },
      changed: false,
    });
  }
  return segments;
}

function predecessorSpan(candidate: Span, segments: CoordinateSegment[]): { span: Span; exact: boolean } | undefined {
  const touched = segments.filter((segment) => rangesOverlap(segment.new_span, candidate));
  if (!touched.length) return undefined;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let exact = touched.length === 1 && !touched[0].changed && contains(touched[0].new_span, candidate);
  for (const segment of touched) {
    if (segment.changed) {
      start = Math.min(start, segment.old_span.start);
      end = Math.max(end, segment.old_span.end);
      exact = false;
      continue;
    }
    const overlapStart = Math.max(candidate.start, segment.new_span.start);
    const overlapEnd = Math.min(candidate.end, segment.new_span.end);
    start = Math.min(start, segment.old_span.start + overlapStart - segment.new_span.start);
    end = Math.max(end, segment.old_span.start + overlapEnd - segment.new_span.start);
  }
  return { span: { start, end }, exact };
}

function leafOrder(left: LidNode, right: LidNode): number {
  return left.span.start - right.span.start || left.span.end - right.span.end || left.lid.localeCompare(right.lid);
}

function migrationMap(
  oldSource: string,
  candidateSource: string,
  oldBase: ReadOnlyBase,
  candidateBase: ReadOnlyBase,
  repairs: RenderedRepair[],
): { map: HybridFoundationAdaptationMigrationMap; stable: number; drift: number; removed: number } {
  const oldLeaves = oldBase.lid_nodes.filter((node) => node.children.length === 0).sort(leafOrder);
  const candidateLeaves = candidateBase.lid_nodes.filter((node) => node.children.length === 0).sort(leafOrder);
  if (candidateLeaves.length > oldLeaves.length) {
    throw new Error("candidate has more leaves than deterministic old-to-new migration can represent");
  }
  const segments = coordinateSegments(oldSource.length, candidateSource.length, repairs);
  const usedOld = new Set<string>();
  const usedCandidate = new Set<string>();
  const assignments = new Map<string, { status: "stable" | "content_drift"; v2_lid: string }>();

  for (const candidate of candidateLeaves) {
    const predecessor = predecessorSpan(candidate.span, segments);
    if (!predecessor?.exact) continue;
    const old = oldLeaves.find((leaf) => !usedOld.has(leaf.lid)
      && leaf.span.start === predecessor.span.start
      && leaf.span.end === predecessor.span.end
      && oldSource.slice(leaf.span.start, leaf.span.end) === candidateSource.slice(candidate.span.start, candidate.span.end));
    if (!old) continue;
    assignments.set(old.lid, { status: "stable", v2_lid: candidate.lid });
    usedOld.add(old.lid);
    usedCandidate.add(candidate.lid);
  }

  for (const candidate of candidateLeaves) {
    if (usedCandidate.has(candidate.lid)) continue;
    const predecessor = predecessorSpan(candidate.span, segments);
    if (!predecessor) throw new Error(`candidate leaf has no predecessor interval:${candidate.lid}`);
    const choices = oldLeaves
      .filter((leaf) => !usedOld.has(leaf.lid) && rangesOverlap(leaf.span, predecessor.span))
      .map((leaf) => ({
        leaf,
        overlap: Math.min(leaf.span.end, predecessor.span.end) - Math.max(leaf.span.start, predecessor.span.start),
      }))
      .sort((left, right) => right.overlap - left.overlap || leafOrder(left.leaf, right.leaf));
    const old = choices[0]?.leaf;
    if (!old) throw new Error(`candidate leaf has no predecessor interval:${candidate.lid}`);
    assignments.set(old.lid, { status: "content_drift", v2_lid: candidate.lid });
    usedOld.add(old.lid);
    usedCandidate.add(candidate.lid);
  }

  const map: HybridFoundationAdaptationMigrationMap = {};
  let stable = 0;
  let drift = 0;
  let removed = 0;
  for (const old of oldLeaves) {
    const assignment = assignments.get(old.lid);
    if (assignment) {
      map[old.lid] = assignment;
      if (assignment.status === "stable") stable += 1;
      else drift += 1;
    } else {
      map[old.lid] = { status: "removed" };
      removed += 1;
    }
  }
  HybridFoundationAdaptationMigrationMapZ.parse(map);
  return { map, stable, drift, removed };
}

function countDecisions(plan: ReviewedSourceRepairPlan): Record<string, number> {
  const result = { material_mismatch: 0, malformed_inline_math: 0, unfenced_code: 0 };
  for (const decision of plan.decisions) result[decision.category] += 1;
  return result;
}

function countLeafKinds(base: ReadOnlyBase): Record<string, number> {
  const counts = new Map<string, number>();
  for (const node of base.lid_nodes.filter((candidate) => candidate.children.length === 0)) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildReviewedSourceCandidate(input: BuildReviewedSourceCandidateInput) {
  const plan = ReviewedSourceRepairPlanZ.parse(input.plan);
  const oldBase = ReadOnlyBaseZ.parse(JSON.parse(input.old_base_json));
  if (oldBase.book_id !== plan.old_book_id) throw new Error("old book_id mismatch");
  if (sha256(input.source) !== plan.input_fingerprint.source_sha256) throw new Error("source hash mismatch");
  if (sha256(input.old_base_json) !== plan.input_fingerprint.base_sha256) throw new Error("base hash mismatch");
  validateRequirements(plan, input.required_material_lids, input.required_review_proposals);
  validateReviewCoverage(plan, oldBase);

  const declaredEvidence = new Map(plan.evidence.map((item) => [item.id, item]));
  for (const item of plan.evidence) {
    const value = input.evidence[item.id];
    if (value === undefined) throw new Error(`missing evidence:${item.id}`);
    if (sha256(value) !== item.sha256) throw new Error(`evidence hash mismatch:${item.id}`);
  }
  for (const decision of plan.decisions) {
    if (!declaredEvidence.has(decision.evidence_id)) throw new Error(`undeclared evidence:${decision.evidence_id}`);
  }
  for (const repair of plan.repairs) {
    if (!declaredEvidence.has(repair.evidence_id)) throw new Error(`undeclared evidence:${repair.evidence_id}`);
  }

  const applied = applyRepairs(input.source, plan, input.evidence);
  const parsed = parseMarkdownSourceBlocks(applied.source);
  if (parsed.review_proposals.length) {
    throw new Error(`candidate source still has ${parsed.review_proposals.length} parser review proposals`);
  }
  const nodes = segment(parsed.blocks);
  const partition = checkPartitionInvariant(nodes, applied.source);
  if (!partition.ok || partition.coverage !== 1) throw new Error("candidate source partition failed");
  const base = ReadOnlyBaseZ.parse({
    book_id: plan.new_book_id,
    lid_nodes: nodes,
    graph_nodes: [],
    graph_edges: [],
  });
  const migration = migrationMap(input.source, applied.source, oldBase, base, applied.repairs);
  const mappedCandidateLids = Object.values(migration.map).flatMap((entry) => entry.v2_lid ? [entry.v2_lid] : []);
  const duplicateCandidateCount = mappedCandidateLids.length - new Set(mappedCandidateLids).size;
  const candidateLeafLids = new Set(base.lid_nodes.filter((node) => node.children.length === 0).map((node) => node.lid));
  const unexpectedCandidateCount = [...candidateLeafLids].filter((lid) => !mappedCandidateLids.includes(lid)).length;
  if (duplicateCandidateCount || unexpectedCandidateCount) throw new Error("migration does not own candidate leaves exactly once");

  return {
    source: applied.source,
    base,
    lid_migration_map: migration.map,
    report: {
      version: "reviewed_source_candidate_report.v1" as const,
      old_book_id: plan.old_book_id,
      new_book_id: plan.new_book_id,
      input_fingerprint: plan.input_fingerprint,
      plan_sha256: sha256(artifactJson(plan)),
      output_fingerprint: {
        source_sha256: sha256(applied.source),
        base_sha256: sha256(artifactJson(base)),
        migration_sha256: sha256(artifactJson(migration.map)),
      },
      source_review_gate: "approved" as const,
      candidate_scope: "structural_source_base" as const,
      formal_release_gate: "pending_pr20_rebuild" as const,
      decision_counts: countDecisions(plan),
      repair_count: plan.repairs.length,
      parser_review_proposal_count: parsed.review_proposals.length,
      partition,
      candidate: {
        node_count: base.lid_nodes.length,
        leaf_count: candidateLeafLids.size,
        leaf_kind_counts: countLeafKinds(base),
        top_level_containers: base.lid_nodes
          .filter((node) => node.path.length === 1 && node.children.length > 0)
          .map((node) => node.lid),
      },
      migration: {
        stable: migration.stable,
        content_drift: migration.drift,
        removed: migration.removed,
        unexpected_candidate_count: unexpectedCandidateCount,
        duplicate_candidate_count: duplicateCandidateCount,
      },
    },
  };
}
