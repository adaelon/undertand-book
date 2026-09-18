import type { BookStructureCandidate, BookStructureStitchReductionChildV1 } from "./book-structure";

/** The caller supplies only artifacts accepted under the current frozen task identities. */
export type BookStructureContribution = BookStructureStitchReductionChildV1;

export interface BookStructureMaterialization {
  candidate: BookStructureCandidate;
  identities: Array<{ work_unit_id: string; local_id: string; public_id: string; kind: "stop" | "line" }>;
}

export class BookStructureContributionCoverageError extends Error {
  readonly name = "BookStructureContributionCoverageError";
  constructor(readonly affected_work_units: Array<{ work_unit_id: string; evidence_lids: string[] }>) {
    super(`missing or duplicate core spine: ${affected_work_units.map(item => `${item.work_unit_id} (${item.evidence_lids.join(", ")})`).join("; ")}`);
  }
}

/** Replaces one current source; historical versions never enter the materialization set. */
export function replaceBookStructureContribution(
  current: BookStructureContribution[], incoming: BookStructureContribution,
): BookStructureContribution[] {
  return [...current.filter(item => item.work_unit_id !== incoming.work_unit_id), incoming];
}

export function materializeBookStructureContributions(
  contributions: BookStructureContribution[], unitOrder: string[],
): BookStructureMaterialization {
  const sources = new Map<string, BookStructureContribution>();
  for (const item of contributions) {
    const previous = sources.get(item.work_unit_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
      throw new Error(`conflicting current contribution: ${item.work_unit_id}`);
    }
    sources.set(item.work_unit_id, item);
  }
  const ordered = [...sources.values()].sort((a, b) => a.work_unit_id < b.work_unit_id ? -1 : 1);
  // Old stitch contracts accepted selective spines. Admission to append needs exact
  // core coverage, but must leave those accepted artifacts and receipts untouched.
  const incomplete = ordered.flatMap(source => {
    const range = source.unit_card_range;
    const evidence_lids = unitOrder.slice(range.start_ordinal, range.end_ordinal_exclusive)
      .filter(lid => (source.payload.spine ?? []).filter(unit => unit.lid === lid).length !== 1);
    return evidence_lids.length ? [{ work_unit_id: source.work_unit_id, evidence_lids }] : [];
  });
  if (incomplete.length) throw new BookStructureContributionCoverageError(incomplete);
  const identities: BookStructureMaterialization["identities"] = [];
  const candidate: Required<BookStructureCandidate> = {
    spine: [], throughlines: [], key_stops: [], context_units: [],
    reference_scope: { unit_lids: [...unitOrder], dependency_target_lids: [...unitOrder], evidence_by_unit: {} },
  };
  const owners = new Set<string>();
  for (const [sourceIndex, source] of ordered.entries()) {
    const range = source.unit_card_range;
    if (!Number.isSafeInteger(range.start_ordinal) || !Number.isSafeInteger(range.end_ordinal_exclusive)
      || range.start_ordinal < 0 || range.end_ordinal_exclusive > unitOrder.length
      || range.start_ordinal >= range.end_ordinal_exclusive) throw new Error("invalid contribution core range");
    const core = unitOrder.slice(range.start_ordinal, range.end_ordinal_exclusive);
    const payload = source.payload;
    const ids = new Map<string, string>();
    const stops = [...(payload.key_stops ?? [])].sort((a, b) => a.id < b.id ? -1 : 1);
    for (const [index, stop] of stops.entries()) {
      if (ids.has(stop.id)) throw new Error("duplicate local key-stop identity");
      const id = `stop-${sourceIndex}-${index}`;
      ids.set(stop.id, id);
      identities.push({ work_unit_id: source.work_unit_id, local_id: stop.id, public_id: id, kind: "stop" });
      candidate.key_stops.push({ ...structuredClone(stop), id });
    }
    const refs = (values: string[]) => values.map(id => {
      const mapped = ids.get(id);
      if (!mapped) throw new Error(`unknown local key-stop reference: ${id}`);
      return mapped;
    });
    for (const lid of core) {
      if (owners.has(lid)) throw new Error(`conflicting core ownership: ${lid}`);
      const units = (payload.spine ?? []).filter(unit => unit.lid === lid);
      if (units.length !== 1) throw new Error(`missing or duplicate core spine: ${lid}`);
      owners.add(lid);
      candidate.spine.push({ ...structuredClone(units[0]), key_stop_ids: refs(units[0].key_stop_ids) });
    }
    const lines = [...(payload.throughlines ?? [])].sort((a, b) => a.id < b.id ? -1 : 1);
    if (new Set(lines.map(line => line.id)).size !== lines.length) throw new Error("duplicate local throughline identity");
    for (const [index, line] of lines.entries()) {
      const id = `line-${sourceIndex}-${index}`;
      identities.push({ work_unit_id: source.work_unit_id, local_id: line.id, public_id: id, kind: "line" });
      candidate.throughlines.push({ ...structuredClone(line), id, key_stop_ids: refs(line.key_stop_ids) });
    }
    for (const [unit, lids] of Object.entries(payload.reference_scope?.evidence_by_unit ?? {})) {
      candidate.reference_scope.evidence_by_unit[unit] = [...new Set([
        ...(candidate.reference_scope.evidence_by_unit[unit] ?? []), ...lids,
      ])].sort();
    }
  }
  if (owners.size !== unitOrder.length || new Set(unitOrder).size !== unitOrder.length) {
    throw new Error("contributions do not cover the expected units exactly");
  }
  candidate.spine.sort((a, b) => unitOrder.indexOf(a.lid) - unitOrder.indexOf(b.lid));
  for (const unit of candidate.spine) {
    if (unit.depends_on.some(lid => lid === unit.lid || !owners.has(lid))) throw new Error("invalid materialized dependency");
  }
  return { candidate, identities };
}
