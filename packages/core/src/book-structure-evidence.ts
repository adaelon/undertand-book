import type { BookStructureGenerationInputV1 } from "./book-structure-generation";
import type { BookStructureCandidate, BookStructureUnitCard } from "./book-structure";

/** Derived from delivered content, never from the book-wide LID index. */
export interface BookStructureReferenceScope {
  unit_lids: string[];
  evidence_by_unit: Record<string, string[]>;
  dependency_target_lids: string[];
}

export function bookStructureReferenceScope(input: BookStructureGenerationInputV1): BookStructureReferenceScope {
  const byUnit: Record<string, string[]> = {};
  const dependencyUnits = new Set<string>();
  const add = (unit: string, lids: string[]) => {
    byUnit[unit] = [...new Set([...(byUnit[unit] ?? []), ...lids])].sort();
  };
  const addCard = (card: BookStructureUnitCard) => {
    dependencyUnits.add(card.unit_lid);
    add(card.unit_lid, [
      ...card.summary.evidence_lids,
      ...card.candidate_key_stops.flatMap(stop => [stop.lid, ...stop.reason.evidence_lids]),
    ]);
  };
  const addCandidate = (candidate: BookStructureCandidate) => {
    for (const unit of [...(candidate.spine ?? []), ...(candidate.context_units ?? [])]) {
      dependencyUnits.add(unit.lid);
      add(unit.lid, unit.summary.evidence_lids);
    }
    const cited = new Set([
      ...(candidate.throughlines ?? []).flatMap(line => line.summary.evidence_lids),
      ...(candidate.key_stops ?? []).flatMap(stop => [stop.lid, ...stop.reason.evidence_lids]),
    ]);
    // The writer carries the exact per-unit source map through reductions.
    for (const [unit, lids] of Object.entries(candidate.reference_scope?.evidence_by_unit ?? {})) add(unit, lids.filter(lid => cited.has(lid)));
  };
  let global = false;
  if ("leaf_lids" in input || "core_leaf_lids" in input) {
    const unit = "unit_lid" in input ? input.unit_lid : input.parent_unit_lid;
    add(unit, input.excerpts.filter(excerpt => excerpt.text.trim()).map(excerpt => excerpt.lid));
  } else if ("unit_cards" in input) {
    global = true;
    for (const card of [...input.unit_cards, ...(input.context_unit_cards ?? [])]) addCard(card);
    for (const excerpt of input.evidence_excerpts ?? []) {
      if (excerpt.text.trim()) add(excerpt.unit_lid, [excerpt.lid]);
    }
  } else if ("parent_unit_lid" in input) {
    add(input.parent_unit_lid, input.children.flatMap(child => [
      ...child.payload.summary_fragments.flatMap(summary => summary.evidence_lids),
      ...child.payload.candidate_key_stops.flatMap(stop => [stop.lid, ...stop.reason.evidence_lids]),
    ]));
  } else {
    global = true;
    for (const child of input.children) addCandidate(child.payload);
  }
  const units = Object.keys(byUnit).sort();
  return { unit_lids: units, evidence_by_unit: byUnit,
    dependency_target_lids: global ? units.filter(unit => dependencyUnits.has(unit) && byUnit[unit].length > 0) : [] };
}

export function bookStructureScopeLids(scope: BookStructureReferenceScope): string[] {
  return [...new Set([...scope.unit_lids, ...Object.values(scope.evidence_by_unit).flat()])].sort();
}
