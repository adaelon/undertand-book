import { expect, it } from "vitest";
import { BOOK_STRUCTURE_EXECUTION_PROMPTS_V2, createBookStructureExecutionContractsV2, type BookStructureCandidate } from "../src/book-structure";
import { bookStructureRelationContracts, bookStructureSelectedPairs, routeBookStructureRelationSelections, routeBookStructureRelationDelta, validateBookStructureRelationSelection } from "../src/book-structure-relation-routing";
import { resolveContentProfile } from "../src/content-profile";
import { renderBookStructureGenerationTaskInput, createBookStructureGenerationTask } from "../src/book-structure-generation";
import { applyBookStructureRelationDeltas, validateBookStructureRelationDelta } from "../src/book-structure-relations";

const target = { version: "build_target_ref.v2" as const, workspace_dir: "C:/repo/relation-routing", book_id: "relations", profile_id: "technical_learning" as const, input_fingerprint: "a".repeat(64) };
const contracts = bookStructureRelationContracts(createBookStructureExecutionContractsV2({ profile: resolveContentProfile("technical_learning"), prompts: BOOK_STRUCTURE_EXECUTION_PROMPTS_V2 }).stitch_fragment);
const dependencies = [{ artifact: "fragment:0", sha256: "b".repeat(64) }];
function candidate(count: number): BookStructureCandidate {
  const units = Array.from({ length: count }, (_, i) => String(i));
  return { spine: units.map(lid => ({ lid, role: "foundation", summary: { text: (lid === "0" ? "Ownership transfers" : lid === String(count - 1) ? "Resources released on scope exit" : "Unrelated intermediate subject") + " supported by chapter evidence".repeat(12), evidence_lids: [lid + ".1"] }, key_stop_ids: [], depends_on: [] })), throughlines: [], key_stops: [],
    reference_scope: { unit_lids: units, dependency_target_lids: units, evidence_by_unit: Object.fromEntries(units.map(lid => [lid, [lid + ".1"]])) } };
}

it("covers every within/across-batch pair under budget, including differently named distant entries", () => {
  const base = candidate(64);
  const routed = routeBookStructureRelationSelections({ target, candidate: base, contract: contracts.select, dependencies });
  expect(routed.length).toBeGreaterThan(1);
  const pairs = new Set<string>();
  for (const work of routed) {
    expect(work.descriptor.cost.estimated_input_tokens).toBeLessThanOrEqual(6000);
    const ids = work.input.entries.map(entry => entry.id);
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) pairs.add([ids[a], ids[b]].sort().join("|"));
    const task = createBookStructureGenerationTask({ target_ref: target, policy_generation_id: "relations.v1", descriptor: work.descriptor,
      generation_input: work.input, parent_unit_lid: "stitch", parent_content_hash: "c".repeat(64), source_range: { start_ordinal: 0, end_ordinal_exclusive: 64 },
      allowed_evidence_lids: work.descriptor.evidence_lids, output_role: "relation_selection" });
    expect(renderBookStructureGenerationTaskInput(task)).toBe(work.rendered_input);
  }
  expect(pairs.size).toBe(64 * 63 / 2);
  expect(pairs.has("unit:0|unit:63")).toBe(true);
  const selectedWork = routed.find(work => work.input.entries.some(entry => entry.id === "unit:0") && work.input.entries.some(entry => entry.id === "unit:63"))!;
  if (selectedWork.input.version !== "book_structure_relation_selection_input.v1") throw Error("selection expected");
  const selection = validateBookStructureRelationSelection({ groups: [{ member_ids: ["unit:0", "unit:63"] }] }, selectedWork.input);
  expect(bookStructureSelectedPairs([selection, selection])).toEqual([["unit:0", "unit:63"]]);
  const relation = routeBookStructureRelationDelta({ target, candidate: base, member_ids: ["unit:0", "unit:63"], members: {}, ordinal: 0, contract: contracts.delta, dependencies });
  expect(relation.input.entries.map(entry => entry.id)).toEqual(["unit:0", "unit:63"]);
  expect(relation.rendered_input).not.toContain('"spine"');
});

it("does not merge equal names and finishes a fixed empty selection without relation work", () => {
  const base = candidate(2);
  const routed = routeBookStructureRelationSelections({ target, candidate: base, contract: contracts.select, dependencies });
  expect(routed).toHaveLength(1);
  if (routed[0].input.version !== "book_structure_relation_selection_input.v1") throw Error("selection expected");
  const selection = validateBookStructureRelationSelection({ groups: [] }, routed[0].input);
  expect(bookStructureSelectedPairs([selection])).toEqual([]);
  expect(() => validateBookStructureRelationSelection({ groups: [{ member_ids: ["unit:0", "not-delivered"] }] }, routed[0].input as any)).toThrow();
});

it("delivers current merged members to an overlapping follow-up and reports oversized atomic inputs", () => {
  const base = candidate(3);
  base.throughlines = ["a", "b", "c"].map((id, i) => ({ id, name: "Same name", summary: base.spine![i].summary, lids: [String(i)], key_stop_ids: [] }));
  const first = { new_throughlines: [], extend_throughlines: [], add_dependencies: [],
    merge_throughlines: [{ source_ids: ["a", "b"], name: "First relationship", summary: { text: "Connects two chapters", evidence_lids: ["0.1", "1.1"] } }] };
  const current = applyBookStructureRelationDeltas(base, [{ work_unit_id: "0", delta: first }]);
  const work = routeBookStructureRelationDelta({ target, candidate: current.candidate, member_ids: ["throughline:b", "throughline:c"],
    members: current.members, ordinal: 1, contract: contracts.delta, dependencies });
  expect(work.input.entries.map(entry => entry.id)).toEqual(["throughline:a", "throughline:c"]);
  expect(work.input.entries[0].unit_lids).toEqual(["0", "1"]);
  if (work.input.version !== "book_structure_relation_input.v1") throw Error("relation input expected");
  const second = { ...first, merge_throughlines: [{ source_ids: ["a", "c"], name: "All three", summary: { text: "Connects three chapters", evidence_lids: ["0.1", "1.1", "2.1"] } }] };
  expect(() => validateBookStructureRelationDelta(second, work.input as any)).not.toThrow();
  base.spine![0].summary.text = "大型不可拆条目".repeat(20_000);
  expect(() => routeBookStructureRelationSelections({ target, candidate: base, contract: contracts.select, dependencies })).toThrow(/exceeds budget/);
});
