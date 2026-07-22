export const PDF_BINDING_OWNERSHIP_POLICY = {
  version: "pdf_binding_ownership_policy.v1",
} as const;

export type PdfBindingCandidateKind = "text" | "formula" | "image" | "table" | "code" | "unknown";

export interface PdfBindingRejection {
  candidate_id: string;
  competitor_ids: string[];
  constraint:
    | "complete_glyph_ownership"
    | "multiple_equal_ownership_solutions"
    | "multiple_equal_monotonic_exact_child_chains"
    | "multiple_equal_monotonic_formula_chains"
    | "no_non_overlapping_monotonic_formula_chain"
    | "incomplete_formula_candidate_chain";
  resource_keys: string[];
}

interface PdfBindingProjection {
  lid: string;
  source_span: { start: number; end: number };
  precision: "char_exact" | "region_exact" | "partial" | "unmapped";
  regions: Array<{ pageIndex: number; bbox: [number, number, number, number] }>;
  exact_source_spans: Array<{ start: number; end: number }>;
  selection_assignments: Array<{ pageIndex: number; char_index: number }>;
  formula_display_text?: string;
  primary_region?: unknown;
  binding_rejections?: PdfBindingRejection[];
  alignment: { unit_id: string; reason: string };
}

export interface PdfBindingCandidate<T extends PdfBindingProjection = PdfBindingProjection> {
  kind: PdfBindingCandidateKind;
  source_order: number;
  projection: T;
}

export interface PdfBindingOwnershipDecision {
  group_id: string;
  status: "unique_owner" | "ambiguous_binding";
  candidate_lids: string[];
  accepted_lids: string[];
  resource_keys: string[];
  rejections: PdfBindingRejection[];
}

export interface PdfBindingOwnershipResult<T extends PdfBindingProjection = PdfBindingProjection> {
  policy_version: typeof PDF_BINDING_OWNERSHIP_POLICY.version;
  projections: T[];
  decisions: PdfBindingOwnershipDecision[];
  diagnostics: {
    competing_region_binding_count: number;
    competing_selection_binding_count: number;
    resolved_duplicate_region_binding_count: number;
    resolved_duplicate_selection_binding_count: number;
    conflict_group_count: number;
    unique_owner_group_count: number;
    ambiguous_group_count: number;
    rejected_candidate_count: number;
  };
}

function regionKey(region: PdfBindingProjection["regions"][number]): string {
  return `region:${region.pageIndex}:${region.bbox.join(",")}`;
}

function selectionKey(assignment: PdfBindingProjection["selection_assignments"][number]): string {
  return `selection:${assignment.pageIndex}:${assignment.char_index}`;
}

function resources<T extends PdfBindingProjection>(candidate: PdfBindingCandidate<T>): string[] {
  return [
    ...candidate.projection.regions.map(regionKey),
    ...candidate.projection.selection_assignments.map(selectionKey),
  ];
}

function competingResources<T extends PdfBindingProjection>(
  candidates: PdfBindingCandidate<T>[],
): Map<string, PdfBindingCandidate<T>[]> {
  const owners = new Map<string, PdfBindingCandidate<T>[]>();
  for (const candidate of candidates) {
    for (const key of resources(candidate)) {
      const current = owners.get(key) ?? [];
      if (!current.some((item) => item.projection.lid === candidate.projection.lid)) current.push(candidate);
      owners.set(key, current);
    }
  }
  return new Map([...owners.entries()].filter(([, current]) => current.length > 1));
}

function candidateGroups<T extends PdfBindingProjection>(
  competing: Map<string, PdfBindingCandidate<T>[]>,
): PdfBindingCandidate<T>[][] {
  const adjacency = new Map<string, Set<string>>();
  const byLid = new Map<string, PdfBindingCandidate<T>>();
  for (const owners of competing.values()) {
    for (const owner of owners) {
      byLid.set(owner.projection.lid, owner);
      const neighbors = adjacency.get(owner.projection.lid) ?? new Set<string>();
      for (const other of owners) {
        if (other.projection.lid !== owner.projection.lid) neighbors.add(other.projection.lid);
      }
      adjacency.set(owner.projection.lid, neighbors);
    }
  }
  const groups: PdfBindingCandidate<T>[][] = [];
  const visited = new Set<string>();
  for (const lid of adjacency.keys()) {
    if (visited.has(lid)) continue;
    const stack = [lid];
    const group: PdfBindingCandidate<T>[] = [];
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      group.push(byLid.get(current)!);
      stack.push(...(adjacency.get(current) ?? []));
    }
    groups.push(group.sort((left, right) => left.source_order - right.source_order));
  }
  return groups;
}

function ownsCompleteGlyphs(projection: PdfBindingProjection): boolean {
  return projection.precision === "char_exact"
    || Boolean(projection.formula_display_text && projection.selection_assignments.length);
}

function unmapped<T extends PdfBindingProjection>(
  projection: T,
  reason: string,
  rejection: PdfBindingRejection,
): T {
  const {
    primary_region: _primaryRegion,
    formula_display_text: _formulaDisplayText,
    ...withoutMappedEvidence
  } = projection;
  return {
    ...withoutMappedEvidence,
    precision: "unmapped",
    regions: [],
    exact_source_spans: [],
    selection_assignments: [],
    binding_rejections: [...(projection.binding_rejections ?? []), rejection],
    alignment: { ...projection.alignment, reason },
  } as unknown as T;
}

export function resolvePdfBindingOwnership<T extends PdfBindingProjection>(
  candidates: PdfBindingCandidate<T>[],
): PdfBindingOwnershipResult<T> {
  const competing = competingResources(candidates);
  const groups = candidateGroups(competing);
  const replacements = new Map<string, T>();
  const decisions: PdfBindingOwnershipDecision[] = [];

  for (const [groupIndex, group] of groups.entries()) {
    const lids = new Set(group.map((candidate) => candidate.projection.lid));
    const groupResources = [...competing.entries()]
      .filter(([, owners]) => owners.some((owner) => lids.has(owner.projection.lid)))
      .sort(([left], [right]) => left.localeCompare(right));
    const loserEvidence = new Map<string, { competitors: Set<string>; resources: Set<string> }>();
    for (const [key, owners] of groupResources.filter(([key]) => key.startsWith("selection:"))) {
      const complete = owners.filter((owner) => ownsCompleteGlyphs(owner.projection));
      const partial = owners.filter((owner) => !ownsCompleteGlyphs(owner.projection));
      if (complete.length !== 1
        || !partial.length
        || partial.some((owner) => owner.kind !== complete[0].kind)) continue;
      for (const loser of partial) {
        const evidence = loserEvidence.get(loser.projection.lid) ?? {
          competitors: new Set<string>(),
          resources: new Set<string>(),
        };
        evidence.competitors.add(`projection:${complete[0].projection.lid}`);
        evidence.resources.add(key);
        loserEvidence.set(loser.projection.lid, evidence);
      }
    }

    const survivors = group.filter((candidate) => !loserEvidence.has(candidate.projection.lid));
    const survivingCompeting = competingResources(survivors);
    const rejections: PdfBindingRejection[] = [];
    if (survivingCompeting.size) {
      for (const candidate of group) {
        const rejection: PdfBindingRejection = {
          candidate_id: `projection:${candidate.projection.lid}`,
          competitor_ids: group
            .filter((other) => other.projection.lid !== candidate.projection.lid)
            .map((other) => `projection:${other.projection.lid}`),
          constraint: "multiple_equal_ownership_solutions",
          resource_keys: groupResources.map(([key]) => key),
        };
        rejections.push(rejection);
        replacements.set(candidate.projection.lid, unmapped(
          candidate.projection,
          "ambiguous_binding: multiple equal non-overlapping ownership solutions",
          rejection,
        ));
      }
      decisions.push({
        group_id: `binding-group-${groupIndex + 1}`,
        status: "ambiguous_binding",
        candidate_lids: group.map((candidate) => candidate.projection.lid),
        accepted_lids: [],
        resource_keys: groupResources.map(([key]) => key),
        rejections,
      });
      continue;
    }

    for (const candidate of group.filter((item) => loserEvidence.has(item.projection.lid))) {
      const evidence = loserEvidence.get(candidate.projection.lid)!;
      const rejection: PdfBindingRejection = {
        candidate_id: `projection:${candidate.projection.lid}`,
        competitor_ids: [...evidence.competitors],
        constraint: "complete_glyph_ownership",
        resource_keys: [...evidence.resources].sort((left, right) => left.localeCompare(right)),
      };
      rejections.push(rejection);
      replacements.set(candidate.projection.lid, unmapped(
        candidate.projection,
        "binding_rejected: complete glyph owner excludes partial candidate",
        rejection,
      ));
    }
    decisions.push({
      group_id: `binding-group-${groupIndex + 1}`,
      status: "unique_owner",
      candidate_lids: group.map((candidate) => candidate.projection.lid),
      accepted_lids: survivors.map((candidate) => candidate.projection.lid),
      resource_keys: groupResources.map(([key]) => key),
      rejections,
    });
  }

  const projections = candidates.map((candidate) => (
    replacements.get(candidate.projection.lid) ?? candidate.projection
  ));
  const resolvedCompeting = competingResources(candidates.map((candidate, index) => ({
    ...candidate,
    projection: projections[index],
  })));
  return {
    policy_version: PDF_BINDING_OWNERSHIP_POLICY.version,
    projections,
    decisions,
    diagnostics: {
      competing_region_binding_count: [...competing.keys()].filter((key) => key.startsWith("region:")).length,
      competing_selection_binding_count: [...competing.keys()].filter((key) => key.startsWith("selection:")).length,
      resolved_duplicate_region_binding_count: [...resolvedCompeting.keys()].filter((key) => key.startsWith("region:")).length,
      resolved_duplicate_selection_binding_count: [...resolvedCompeting.keys()].filter((key) => key.startsWith("selection:")).length,
      conflict_group_count: groups.length,
      unique_owner_group_count: decisions.filter((decision) => decision.status === "unique_owner").length,
      ambiguous_group_count: decisions.filter((decision) => decision.status === "ambiguous_binding").length,
      rejected_candidate_count: replacements.size,
    },
  };
}
