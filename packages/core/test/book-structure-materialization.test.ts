import { describe, expect, it } from "vitest";
import { BookStructureContributionCoverageError, materializeBookStructureContributions, replaceBookStructureContribution, type BookStructureContribution } from "../src/book-structure-materialization";

function contribution(index: number): BookStructureContribution {
  const lid = String(index);
  return { work_unit_id: `fragment:${index}`, artifact_hash: "a".repeat(64),
    unit_card_range: { start_ordinal: index, end_ordinal_exclusive: index + 1 },
    payload: {
      spine: [{ lid, role: "foundation", summary: { text: lid, evidence_lids: [lid + ".1"] }, key_stop_ids: ["stop-1"], depends_on: [] }],
      key_stops: ["stop-1", "stop-2"].map(id => ({ id, lid: lid + ".1", type: "definition", reason: { text: id, evidence_lids: [lid + ".1"] } })),
      throughlines: [{ id: "line-1", name: "Shared name", summary: { text: lid, evidence_lids: [lid + ".1"] }, lids: [lid], key_stop_ids: ["stop-1"] }],
      reference_scope: { unit_lids: [lid], dependency_target_lids: [lid], evidence_by_unit: { [lid]: [lid + ".1"] } },
    } };
}

describe("local contribution materialization", () => {
  it("reports every incomplete historical source and core unit without changing accepted inputs", () => {
    const inputs = Array.from({ length: 29 }, (_, i) => contribution(i));
    inputs[3].payload.spine = [];
    inputs[20].payload.spine!.push(structuredClone(inputs[20].payload.spine![0]));
    const before = JSON.stringify(inputs);
    let failure: unknown;
    try { materializeBookStructureContributions(inputs, inputs.map((_, i) => String(i))); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BookStructureContributionCoverageError);
    expect((failure as BookStructureContributionCoverageError).affected_work_units).toEqual([
      { work_unit_id: "fragment:20", evidence_lids: ["20"] },
      { work_unit_id: "fragment:3", evidence_lids: ["3"] },
    ]);
    expect(JSON.stringify(inputs)).toBe(before);
  });
  it("materializes 29 fragments without model calls, independently of order and duplicate delivery", () => {
    const inputs = Array.from({ length: 29 }, (_, i) => contribution(i));
    const order = inputs.map((_, i) => String(i));
    const result = materializeBookStructureContributions(inputs, order);
    expect(materializeBookStructureContributions([...inputs].reverse().concat(inputs[0]), order)).toEqual(result);
    expect(result.candidate.spine).toHaveLength(29);
    expect(result.candidate.key_stops).toHaveLength(58);
    expect(new Set(result.candidate.key_stops!.map(stop => stop.id)).size).toBe(58);
    for (const unit of result.candidate.spine!) {
      const stop = result.candidate.key_stops!.find(stop => stop.id === unit.key_stop_ids[0]);
      expect(stop?.lid).toBe(unit.lid + ".1");
    }
  });
  it("ignores context spine ownership and replaces only the selected source version", () => {
    const first = contribution(0), second = contribution(1);
    first.payload.spine!.push(structuredClone(second.payload.spine![0]));
    const original = JSON.stringify(first);
    const replacement = structuredClone(first);
    replacement.artifact_hash = "b".repeat(64);
    replacement.payload.spine![0].summary.text = "updated";
    const result = materializeBookStructureContributions(replaceBookStructureContribution([first, second], replacement), ["0", "1"]);
    expect(result.candidate.spine!.map(unit => unit.summary.text)).toEqual(["updated", "1"]);
    expect(JSON.stringify(first)).toBe(original);
    expect(() => materializeBookStructureContributions([first, replacement, second], ["0", "1"])).toThrow(/conflicting/);
  });
  it("rejects missing coverage, conflicting ownership and dangling local references", () => {
    expect(() => materializeBookStructureContributions([contribution(0)], ["0", "1"])).toThrow(/cover/);
    const duplicate = contribution(0); duplicate.work_unit_id = "different";
    expect(() => materializeBookStructureContributions([contribution(0), duplicate], ["0"])).toThrow(/ownership/);
    const bad = contribution(0); bad.payload.spine![0].key_stop_ids = ["unknown"];
    expect(() => materializeBookStructureContributions([bad], ["0"])).toThrow(/reference/);
  });
});
