import { expect, it } from "vitest";
import { applyBookStructureRelationDeltas, validateBookStructureRelationDelta, type BookStructureRelationInput, type BookStructureRelationDelta } from "../src/book-structure-relations";
import type { BookStructureCandidate, BookStructureThroughline } from "../src/book-structure";

const summary = (lids: string[]) => ({ text: "Grounded relationship", evidence_lids: lids.map(lid => lid + ".1") });
const lines: BookStructureThroughline[] = ["a", "b", "c"].map(id => ({ id, name: id, summary: summary([id]), lids: [id], key_stop_ids: [] }));
const base: BookStructureCandidate = { spine: lines.map(line => ({ lid: line.id, role: "foundation", summary: line.summary, key_stop_ids: [], depends_on: [] })), throughlines: lines, key_stops: [],
  reference_scope: { unit_lids: ["a", "b", "c"], dependency_target_lids: ["a", "b", "c"], evidence_by_unit: { a: ["a.1"], b: ["b.1"], c: ["c.1"] } } };
const input: BookStructureRelationInput = { version: "book_structure_relation_input.v1", work_unit_id: "relations:0", reference_scope: base.reference_scope!,
  entries: lines.map(line => ({ id: line.id, kind: "throughline", name: line.name, summary: line.summary, unit_lids: line.lids, key_stops: [], throughline: line })) };
const empty = (): BookStructureRelationDelta => ({ new_throughlines: [], extend_throughlines: [], merge_throughlines: [], add_dependencies: [] });

it("keeps local artifact bytes and applies empty and repeated deltas without loss", () => {
  const before = JSON.stringify(base);
  const delta = empty(); delta.add_dependencies.push({ unit_lid: "a", depends_on: "c", evidence_lids: ["a.1", "c.1"] });
  validateBookStructureRelationDelta(delta, input);
  const item = { work_unit_id: "0", delta };
  expect(applyBookStructureRelationDeltas(base, [item, item])).toEqual(applyBookStructureRelationDeltas(base, [item]));
  expect(applyBookStructureRelationDeltas(base, [{ work_unit_id: "0", delta: empty() }]).candidate).toEqual(base);
  expect(JSON.stringify(base)).toBe(before);
  expect(applyBookStructureRelationDeltas(base, [item]).candidate.spine![0].depends_on).toEqual(["c"]);
});
it("preserves every member through extension and overlapping merges in fixed task order", () => {
  const first = empty(); first.merge_throughlines.push({ source_ids: ["a", "b"], name: "AB", summary: summary(["a", "b"]) });
  const second = empty(); second.merge_throughlines.push({ source_ids: ["b", "c"], name: "ABC", summary: summary(["a", "b", "c"]) });
  const accepted = [{ work_unit_id: "0", delta: first }, { work_unit_id: "1", delta: second }];
  const result = applyBookStructureRelationDeltas(base, accepted);
  expect(applyBookStructureRelationDeltas(base, [...accepted].reverse())).toEqual(result);
  expect(result.candidate.throughlines).toHaveLength(1);
  expect(result.candidate.throughlines![0].lids).toEqual(["a", "b", "c"]);
  expect(result.members).toEqual({ a: "a", b: "a", c: "a" });
  const extension = empty(); extension.extend_throughlines.push({ throughline_id: "a", lids: ["c"], key_stop_ids: [], summary: summary(["a", "c"]) });
  validateBookStructureRelationDelta(extension, input);
  expect(applyBookStructureRelationDeltas(base, [{ work_unit_id: "0", delta: extension }]).candidate.throughlines![0].lids).toEqual(["a", "c"]);
});
it("rejects unknown members, unseen evidence, missing endpoint evidence and full-table output at field locations", () => {
  const delta = empty(); delta.extend_throughlines.push({ throughline_id: "missing", lids: [], key_stop_ids: [], summary: summary(["a"]) });
  expect(() => validateBookStructureRelationDelta(delta, input)).toThrow();
  delta.extend_throughlines[0].throughline_id = "a"; delta.extend_throughlines[0].summary.evidence_lids = ["unseen"];
  expect(() => validateBookStructureRelationDelta(delta, input)).toThrow();
  const dependency = empty(); dependency.add_dependencies.push({ unit_lid: "a", depends_on: "b", evidence_lids: ["a.1", "a.1"] });
  expect(() => validateBookStructureRelationDelta(dependency, input)).toThrow();
  expect(() => validateBookStructureRelationDelta({ ...empty(), spine: [] }, input)).toThrow();
});
