import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import {
  BOOK_STRUCTURE_EXECUTION_PROMPTS_V2, buildBookStructureUnitSources, createBookStructureExecutionContractsV2,
  routeBookStructureUnitWorkUnitsV2, routeBookStructureStitchWorkUnitsV2, routeBookStructureStitchReductionLevelV2,
  type BookStructureUnitSource, type BookStructureStitchPacket,
} from "../src/book-structure";
import { createBookStructureGenerationTask, readBookStructureGenerationArtifact, writeBookStructureGenerationCandidate } from "../src/book-structure-generation";
import { renderBookStructureModelInput } from "../src/model-input-renderer";
import { resolveContentProfile } from "../src/content-profile";
import type { AutomaticBuildTarget } from "../src/build-orchestrator";
import type { LidNode } from "../src/generated/LidNode";

const profile = resolveContentProfile("technical_learning");
const contracts = createBookStructureExecutionContractsV2({ profile, quality_profile: "full", prompts: BOOK_STRUCTURE_EXECUTION_PROMPTS_V2 });
const nodes: LidNode[] = [
  { lid: "4", path: [4], kind: "chapter", span: { start: 0, end: 10 }, children: ["4.2"] },
  { lid: "4.2", path: [4, 2], kind: "paragraph", span: { start: 0, end: 10 }, children: [] },
  { lid: "56", path: [56], kind: "chapter", span: { start: 10, end: 20 }, children: ["56.2"] },
  { lid: "56.2", path: [56, 2], kind: "paragraph", span: { start: 10, end: 20 }, children: [] },
];
function target(): AutomaticBuildTarget {
  const root = mkdtempSync(path.join(tmpdir(), "ub-evidence-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return {
    kind: "source_file", profile_id: profile.id, book_id: "evidence", root_dir: root,
    workspace_dir: root, source_path: path.join(root, "source.md"),
    target_ref: { version: "build_target_ref.v2", workspace_dir: root, book_id: "evidence",
      profile_id: profile.id, input_fingerprint: "b".repeat(64) },
  };
}
function source(): BookStructureUnitSource {
  return { job_id: "unit:4", unit_lid: "4", unit_kind: "chapter", title_path: [], leaf_lids: ["4.2"],
    excerpts: [{ lid: "4.2", text: "This chapter introduces Rust." }],
    graph_nodes: [], graph_edges: [], discourse_items: [], formula_semantics: [], pass2_edges: [] };
}
function packet(): BookStructureStitchPacket {
  return { job_id: "stitch", long_range_edges: [], unit_cards: ["4", "56"].map(unit => ({
    unit_lid: unit, role: "foundation", summary: { text: `Chapter ${unit}.`, evidence_lids: [`${unit}.2`] },
    candidate_key_stops: [], depends_on: [], evidence_lids: [`${unit}.2`],
  })) };
}
function stitchWriter() {
  const t = target(), input = packet();
  const route = routeBookStructureStitchWorkUnitsV2({ target: t.target_ref, packet: input,
    source_fingerprint: t.target_ref.input_fingerprint, contracts });
  if (route.status !== "ready") throw new Error("fixture must route");
  const task = createBookStructureGenerationTask({ target_ref: t.target_ref, policy_generation_id: "evidence.v1",
    descriptor: route.work_units[0].descriptor, generation_input: input, parent_unit_lid: "stitch",
    parent_content_hash: "c".repeat(64), source_range: { start_ordinal: 0, end_ordinal_exclusive: 2 },
    allowed_evidence_lids: route.work_units[0].descriptor.evidence_lids, output_role: "stitch_candidate" });
  return (candidate: unknown) => {
    const result = writeBookStructureGenerationCandidate({ target: t, task, candidate,
      provenance: { executor: "evidence-test", attempt: 1, generated_at: "2026-09-12T00:00:00Z" } });
    expect(readBookStructureGenerationArtifact(t, task)?.payload).toEqual(result.payload);
    return result;
  };
}
it("does not import a foreign claim through a shared Rust node", () => {
  const units = buildBookStructureUnitSources({ lidNodes: nodes, source: "01234567890123456789",
    graphNodes: [
      { id: "entity:rust", type: "entity", name: "Rust", occurrences: ["4.2", "56.2"], source_lid: null },
      { id: "claim:56.2:cargo", type: "claim", name: "Cargo builds projects", occurrences: [], source_lid: "56.2" },
    ], graphEdges: [{ source: "claim:56.2:cargo", target: "entity:rust", type: "defines", direction: "directed", scope: "local", weight: 1 }] });
  const chapter = units.find(x => x.unit_lid === "4")!;
  expect(chapter.graph_edges).toEqual([]);
  expect(chapter.graph_nodes[0].occurrences).toEqual(["4.2"]);
  expect(units.find(x => x.unit_lid === "56")!.graph_edges).toHaveLength(1);
});
it("exposes citation and unit identities separately in the delivered packet", () => {
  const rendered = JSON.parse(renderBookStructureModelInput(source()));
  expect(rendered.reference_scope).toEqual({ evidence_by_unit: { "4": ["4.2"] }, unit_lids: ["4"], dependency_target_lids: [] });
});
it("keeps evidence excerpts and endpoint mappings with graph edge shards", () => {
  const s = source(), t = target();
  s.graph_nodes = Array.from({ length: 180 }, (_, i) => ({ id: `concept:${i}`, type: "concept" as const,
    name: "A local concept ".repeat(10), occurrences: ["4.2"], source_lid: null }));
  s.graph_edges = s.graph_nodes.slice(1).map(n => ({ source: s.graph_nodes[0].id, target: n.id,
    type: "related_to", direction: "directed", scope: "local", weight: 1 }));
  const result = routeBookStructureUnitWorkUnitsV2({ target: t.target_ref, source: s, lid_nodes: nodes,
    source_fingerprint: t.target_ref.input_fingerprint, contracts });
  if (result.status !== "ready") throw new Error("fixture must route");
  const shards = result.work_units.filter(u => u.route.role === "fragment_shard" && u.input && "graph_edges" in u.input && u.input.graph_edges.length);
  expect(shards.length).toBeGreaterThan(0);
  for (const shard of shards) {
    const input = JSON.parse(shard.rendered_input);
    expect(input.excerpts).toContainEqual(s.excerpts[0]);
    expect(input.reference_scope.evidence_by_unit["4"]).toEqual(["4.2"]);
    const ids = new Set(input.graph_nodes.map((n: { id: string }) => n.id));
    for (const edge of input.graph_edges) expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
  }
});
it("accepts a cross-chapter throughline with both sources", () => {
  expect(() => stitchWriter()({ spine: [], key_stops: [], throughlines: [{ id: "rust", name: "Rust",
    lids: ["4", "56"], summary: { text: "Develops the introduction into tooling.", evidence_lids: ["4.2", "56.2"] }, key_stop_ids: [] }] })).not.toThrow();
});
it("rejects a throughline claiming two chapters with evidence from only one", () => {
  expect(() => stitchWriter()({ spine: [], key_stops: [], throughlines: [{ id: "rust", name: "Rust",
    lids: ["4", "56"], summary: { text: "Unsupported link.", evidence_lids: ["4.2"] }, key_stop_ids: [] }] })).toThrow();
});
it("rejects foreign evidence in a chapter summary and paragraph IDs as dependency targets", () => {
  const write = stitchWriter();
  const spine = { lid: "4", role: "foundation", summary: { text: "Local chapter.", evidence_lids: ["4.2"] }, key_stop_ids: [], depends_on: [] as string[] };
  expect(() => write({ spine: [{ ...spine, summary: { text: "Foreign material.", evidence_lids: ["56.2"] } }], throughlines: [], key_stops: [] })).toThrow();
  expect(() => write({ spine: [{ ...spine, depends_on: ["56.2"] }], throughlines: [], key_stops: [] })).toThrow();
  expect(() => write({ spine: [{ ...spine, depends_on: ["56"] }], throughlines: [], key_stops: [] })).not.toThrow();
});
it("rejects a substantive summary with an empty evidence list", () => {
  expect(() => stitchWriter()({ spine: [{ lid: "4", role: "foundation",
    summary: { text: "An unsupported claim.", evidence_lids: [] }, key_stop_ids: [], depends_on: [] }],
    throughlines: [], key_stops: [] })).toThrow();
});

function crossEdge() {
  return { candidate_id: "cross-4-56", source: "claim:4.3", target: "claim:56.3", type: "builds_on" as const,
    source_evidence_lids: ["4.3"], target_evidence_lids: ["56.3"], evidence_lids: ["4.3", "56.3"],
    support_level: "strong_inference" as const, rationale: "A development between the two chapters." };
}
it("blocks missing relationship material before dispatch instead of allowing bare LIDs", () => {
  const input = packet(), t = target(); input.long_range_edges = [crossEdge()];
  const result = routeBookStructureStitchWorkUnitsV2({ target: t.target_ref, packet: input,
    source_fingerprint: t.target_ref.input_fingerprint, contracts });
  expect(result).toMatchObject({ status: "blocked", recovery: { code: "evidence/dangling_input_item", item_key: "cross-4-56" } });
});
it("keeps a crossing relationship's counterpart card and excerpts in each affected stitch shard", () => {
  const input = packet(), t = target();
  input.unit_cards = Array.from({ length: 80 }, (_, i) => ({ ...input.unit_cards[0], unit_lid: String(i + 1),
    summary: { text: "x".repeat(500), evidence_lids: [`${i + 1}.2`] }, evidence_lids: [`${i + 1}.2`] }));
  input.long_range_edges = [crossEdge()];
  input.evidence_excerpts = [{ unit_lid: "4", lid: "4.3", text: "First end." }, { unit_lid: "56", lid: "56.3", text: "Second end." }];
  const result = routeBookStructureStitchWorkUnitsV2({ target: t.target_ref, packet: input,
    source_fingerprint: t.target_ref.input_fingerprint, contracts });
  if (result.status !== "ready") throw new Error("paired evidence must route");
  expect(result.mode).toBe("fragmented");
  const packets = result.work_units.map(unit => JSON.parse(unit.rendered_input));
  const crossing = packets.filter(p => p.long_range_edges.length > 0);
  expect(crossing.length).toBeGreaterThan(0);
  for (const p of crossing) {
    expect(p.evidence_excerpts).toEqual(input.evidence_excerpts);
    const ids = [...p.unit_cards, ...(p.context_unit_cards ?? [])].map(card => card.unit_lid);
    expect(ids).toEqual(expect.arrayContaining(["4", "56"]));
  }
});
it("carries dependency counterpart content through persisted stitch reductions", () => {
  const written = stitchWriter()({ spine: [{ lid: "4", role: "foundation", summary: { text: "Chapter four.", evidence_lids: ["4.2"] },
    depends_on: ["56"], key_stop_ids: [] }], throughlines: [], key_stops: [] });
  const payload = written.payload as import("../src/book-structure").BookStructureCandidate;
  expect(payload.context_units?.[0]).toMatchObject({ lid: "56", summary: { evidence_lids: ["56.2"] } });
  const t = target();
  const result = routeBookStructureStitchReductionLevelV2({ target: t.target_ref,
    children: [{ work_unit_id: "stitch:fragment:0000", artifact_hash: "c".repeat(64),
      unit_card_range: { start_ordinal: 0, end_ordinal_exclusive: 2 }, payload }],
    unit_card_count: 2, reducer_level: 0, contracts });
  if (result.status !== "ready") throw new Error("reduction must route");
  const delivered = JSON.parse(result.work_units[0].rendered_input);
  expect(delivered.reference_scope.evidence_by_unit).toEqual({ "4": ["4.2"], "56": ["56.2"] });
});
