import { z } from "zod";
import type { AnchoredText, BookStructureCandidate, BookStructureThroughline } from "./book-structure";
import type { BookStructureReferenceScope } from "./book-structure-evidence";
import { ExtractorContractError } from "./extractor-contract";

const id = z.string().min(1).refine(value => Buffer.byteLength(value) <= 256);
const ids = z.array(id);
const anchored = z.object({ text: z.string().min(1).max(600), evidence_lids: ids.min(1) }).strict();
const line = z.object({ id, name: z.string().min(1).refine(value => Buffer.byteLength(value) <= 1024), summary: anchored, lids: ids.min(1), key_stop_ids: ids }).strict();
export const BookStructureRelationDeltaZ = z.object({
  new_throughlines: z.array(line),
  extend_throughlines: z.array(z.object({ throughline_id: id, summary: anchored, lids: ids, key_stop_ids: ids }).strict()),
  merge_throughlines: z.array(z.object({ source_ids: ids.min(2), name: z.string().min(1).max(1024), summary: anchored }).strict()),
  add_dependencies: z.array(z.object({ unit_lid: id, depends_on: id, evidence_lids: ids.min(2) }).strict()),
}).strict();
export type BookStructureRelationDelta = z.infer<typeof BookStructureRelationDeltaZ>;
export interface BookStructureRelationInput {
  version: "book_structure_relation_input.v1";
  work_unit_id: string;
  entries: BookStructureRelationEntry[];
  reference_scope: BookStructureReferenceScope;
}
export interface BookStructureRelationEntry {
  id: string;
  kind: "unit" | "throughline";
  name: string;
  summary: AnchoredText;
  unit_lids: string[];
  key_stops: NonNullable<BookStructureCandidate["key_stops"]>;
  throughline?: BookStructureThroughline;
}
export interface AcceptedBookStructureRelationDelta {
  work_unit_id: string;
  delta: BookStructureRelationDelta;
}

function fail(pointer: string, expected: string): never {
  throw new ExtractorContractError({ version: "automatic_build_extractor_diagnostic.v1",
    code: "evidence_out_of_scope", json_pointer: pointer, expected, actual: { type: "invalid_reference" } });
}

export function validateBookStructureRelationDelta(value: unknown, input: BookStructureRelationInput): BookStructureRelationDelta {
  const parsed = BookStructureRelationDeltaZ.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ExtractorContractError({ version: "automatic_build_extractor_diagnostic.v1", code: "schema_invalid",
      json_pointer: "/" + issue.path.join("/"), expected: issue.message, actual: { type: "invalid_value" } });
  }
  const delta = parsed.data;
  const scope = input.reference_scope;
  const evidence = new Set(Object.values(scope.evidence_by_unit).flat());
  const units = new Set(input.entries.flatMap(entry => entry.unit_lids));
  const stops = new Set(input.entries.flatMap(entry => entry.key_stops.map(stop => stop.id)));
  const lines = new Map(input.entries.flatMap(entry => entry.throughline ? [[entry.throughline.id, entry.throughline] as const] : []));
  const checkSummary = (summary: AnchoredText, members: string[], pointer: string) => {
    if (summary.evidence_lids.some(lid => !evidence.has(lid))) fail(pointer + "/evidence_lids", "evidence actually delivered in this task");
    for (const member of members) {
      if (!units.has(member) && !evidence.has(member)) fail(pointer, "delivered unit or paragraph member");
      if (!(scope.evidence_by_unit[member] ?? [member]).some(lid => summary.evidence_lids.includes(lid))) {
        fail(pointer + "/evidence_lids", "evidence covering every declared member");
      }
    }
  };
  const checkStops = (values: string[], pointer: string) => {
    if (values.some(value => !stops.has(value))) fail(pointer, "key stops delivered in this task");
  };
  const newIds = new Set<string>();
  delta.new_throughlines.forEach((item, i) => {
    const pointer = `/new_throughlines/${i}`;
    if (newIds.has(item.id)) fail(pointer + "/id", "unique local throughline id");
    newIds.add(item.id);
    checkSummary(item.summary, item.lids, pointer + "/summary");
    checkStops(item.key_stop_ids, pointer + "/key_stop_ids");
  });
  delta.extend_throughlines.forEach((item, i) => {
    const pointer = `/extend_throughlines/${i}`;
    const existing = lines.get(item.throughline_id);
    if (!existing) fail(pointer + "/throughline_id", "throughline delivered in this task");
    checkSummary(item.summary, [...existing.lids, ...item.lids], pointer + "/summary");
    checkStops(item.key_stop_ids, pointer + "/key_stop_ids");
  });
  delta.merge_throughlines.forEach((item, i) => {
    const pointer = `/merge_throughlines/${i}`;
    if (new Set(item.source_ids).size < 2 || item.source_ids.some(id => !lines.has(id))) fail(pointer + "/source_ids", "at least two distinct delivered throughlines");
    checkSummary(item.summary, item.source_ids.flatMap(id => lines.get(id)!.lids), pointer + "/summary");
  });
  delta.add_dependencies.forEach((item, i) => {
    const pointer = `/add_dependencies/${i}`;
    if (item.unit_lid === item.depends_on || !units.has(item.unit_lid) || !units.has(item.depends_on)) fail(pointer, "two different delivered units");
    checkSummary({ text: "dependency", evidence_lids: item.evidence_lids }, [item.unit_lid, item.depends_on], pointer);
  });
  const projected = applyBookStructureRelationDeltas({
    spine: [...units].map(lid => ({ lid, role: "foundation", summary: { text: "delivered unit", evidence_lids: scope.evidence_by_unit[lid] }, key_stop_ids: [], depends_on: [] })),
    throughlines: [...lines.values()], key_stops: [],
  }, [{ work_unit_id: input.work_unit_id, delta }]).candidate;
  for (const line of projected.throughlines ?? []) checkSummary(line.summary, line.lids, "/merge_throughlines");
  return delta;
}

const union = (values: string[]) => [...new Set(values)].sort();

/** Rebuild in frozen task order. The input contributions and delta artifacts remain untouched. */
export function applyBookStructureRelationDeltas(base: BookStructureCandidate, accepted: AcceptedBookStructureRelationDelta[]): {
  candidate: BookStructureCandidate; members: Record<string, string>;
} {
  const candidate = structuredClone(base);
  const lines = new Map((candidate.throughlines ?? []).map(line => [line.id, line]));
  const members: Record<string, string> = Object.fromEntries([...lines.keys()].map(id => [id, id]));
  const tasks = new Map<string, BookStructureRelationDelta>();
  for (const item of accepted) {
    if (tasks.has(item.work_unit_id) && JSON.stringify(tasks.get(item.work_unit_id)) !== JSON.stringify(item.delta)) throw new Error("conflicting relation delta replay");
    tasks.set(item.work_unit_id, item.delta);
  }
  const resolve = (id: string) => {
    const result = lines.get(members[id] ?? id);
    if (!result) throw new Error(`unknown throughline member: ${id}`);
    return result;
  };
  for (const [taskIndex, [, delta]] of [...tasks].sort(([a], [b]) => a < b ? -1 : 1).entries()) {
    for (const [index, item] of delta.new_throughlines.entries()) {
      const id = `relation-${taskIndex}-${index}`;
      if (lines.has(id)) throw new Error("relation identity collides with a local contribution");
      lines.set(id, { ...structuredClone(item), id }); members[id] = id;
    }
    for (const item of delta.extend_throughlines) {
      const target = resolve(item.throughline_id);
      target.lids = union([...target.lids, ...item.lids]);
      target.key_stop_ids = union([...target.key_stop_ids, ...item.key_stop_ids]);
      target.summary = structuredClone(item.summary);
    }
    for (const item of delta.merge_throughlines) {
      const selected = [...new Map(item.source_ids.map(id => { const line = resolve(id); return [line.id, line]; })).values()];
      const id = selected.map(line => line.id).sort()[0];
      const selectedIds = new Set(selected.map(line => line.id));
      const merged = { id, name: item.name, summary: structuredClone(item.summary),
        lids: union(selected.flatMap(line => line.lids)), key_stop_ids: union(selected.flatMap(line => line.key_stop_ids)) };
      for (const [member, target] of Object.entries(members)) if (selectedIds.has(target)) members[member] = id;
      for (const old of selectedIds) lines.delete(old);
      lines.set(id, merged);
    }
    for (const dependency of delta.add_dependencies) {
      const unit = candidate.spine?.find(unit => unit.lid === dependency.unit_lid);
      if (!unit || !candidate.spine?.some(unit => unit.lid === dependency.depends_on)) throw new Error("unknown dependency unit");
      unit.depends_on = union([...unit.depends_on, dependency.depends_on]);
    }
  }
  candidate.throughlines = [...lines.values()].sort((a, b) => a.id < b.id ? -1 : 1);
  return { candidate, members };
}
