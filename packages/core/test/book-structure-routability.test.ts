import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BOOK_STRUCTURE_ROUTER_VERSION_V2,
  createBookStructureExecutionContractsV2,
  routeBookStructureReductionLevelV2,
  routeBookStructureStitchReductionLevelV2,
  routeBookStructureStitchWorkUnitsV2,
  routeBookStructureUnitWorkUnitsV2,
  type BookStructureFragmentObservationV1,
  type BookStructureStitchReductionChildV1,
  type BookStructureStitchPacket,
  type BookStructureUnitSource,
} from "../src/book-structure";
import {
  createBookStructureGenerationTask,
  writeBookStructureGenerationCandidate,
} from "../src/book-structure-generation";
import type { AutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 } from "../src/executor-transport";
import { automaticBuildFailureDiagnosticFromWriterError } from "../src/extractor-contract";
import type { LidNode } from "../src/generated/LidNode";
import { validateModelExecutionBudgetProof } from "../src/model-input-budget";
import { renderBookStructureModelInput } from "../src/model-input-renderer";

const TARGET_BYTES = 317_247;
const profile = resolveContentProfile("technical_learning");
const target = {
  version: "build_target_ref.v2" as const,
  workspace_dir: "C:/repo/.understand-book/book-structure-routing",
  book_id: "book-structure-routing",
  profile_id: profile.id,
  input_fingerprint: "b".repeat(64),
};
const prompts = {
  whole: "BOOK_STRUCTURE_WHOLE_V2\nReturn one strict JSON unit card.\n",
  fragment: "BOOK_STRUCTURE_FRAGMENT_V1\nReturn one grounded local observation.\n",
  reduce: "BOOK_STRUCTURE_REDUCE_V1\nReduce proof-bound child observations.\n",
  stitch: "BOOK_STRUCTURE_STITCH_V2\nReturn the public BookStructure candidate.\n",
  stitch_fragment: "BOOK_STRUCTURE_STITCH_FRAGMENT_V1\nReturn one local stitch observation.\n",
  stitch_reduce: "BOOK_STRUCTURE_STITCH_REDUCE_V1\nReduce proof-bound stitch observations.\n",
};
const contracts = createBookStructureExecutionContractsV2({
  profile,
  quality_profile: "full",
  prompts,
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeSource(leafCount: number): { source: BookStructureUnitSource; lid_nodes: LidNode[] } {
  const leafLids = Array.from({ length: leafCount }, (_, index) => `1.${index + 1}`);
  const lidNodes: LidNode[] = [];
  let offset = 0;
  for (const lid of leafLids) {
    lidNodes.push({
      lid,
      path: lid.split(".").map(Number),
      kind: "paragraph",
      span: { start: offset, end: offset + 1 },
      children: [],
    });
    offset += 2;
  }
  return {
    lid_nodes: lidNodes,
    source: {
      job_id: "unit:1",
      unit_lid: "1",
      unit_kind: "chapter",
      title_path: [],
      leaf_lids: leafLids,
      excerpts: leafLids.map((lid) => ({ lid, text: "" })),
      graph_nodes: [],
      graph_edges: [],
      discourse_items: [],
      formula_semantics: [],
      pass2_edges: [],
    },
  };
}

function makeExactRenderedSizeFixture(): { source: BookStructureUnitSource; lid_nodes: LidNode[] } {
  const fixture = makeSource(320);
  const emptyBytes = Buffer.byteLength(renderBookStructureModelInput(fixture.source), "utf8");
  let remaining = TARGET_BYTES - emptyBytes;
  if (remaining < 0) throw new Error("BookStructure fixture metadata already exceeds target bytes");
  for (const excerpt of fixture.source.excerpts) {
    const length = Math.min(1_000, remaining);
    excerpt.text = "x".repeat(length);
    remaining -= length;
  }
  if (remaining !== 0) throw new Error(`unable to construct ${TARGET_BYTES}-byte fixture`);
  expect(Buffer.byteLength(renderBookStructureModelInput(fixture.source), "utf8")).toBe(TARGET_BYTES);
  return fixture;
}

function route(source: BookStructureUnitSource, lidNodes: LidNode[]) {
  return routeBookStructureUnitWorkUnitsV2({
    target,
    source,
    lid_nodes: lidNodes,
    source_fingerprint: target.input_fingerprint,
    contracts,
    transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  });
}

function makeStitchPacket(cardCount: number, textBytes = 1_000): BookStructureStitchPacket {
  return {
    job_id: "stitch",
    unit_cards: Array.from({ length: cardCount }, (_, ordinal) => {
      const unitLid = String(ordinal + 1);
      const evidenceLid = `${unitLid}.1`;
      return {
        unit_lid: unitLid,
        role: ordinal === 0 ? "setup" : "foundation",
        summary: { text: `unit-${unitLid}-${"x".repeat(textBytes)}`, evidence_lids: [evidenceLid] },
        candidate_key_stops: [],
        depends_on: ordinal === 0 ? [] : [String(ordinal)],
        evidence_lids: [evidenceLid],
      };
    }),
    long_range_edges: [],
  };
}

describe("T4 BookStructure transport-proof routability", () => {
  it("keeps the small whole-unit renderer byte-identical while binding a V4 execution proof", () => {
    const fixture = makeSource(2);
    fixture.source.excerpts[0].text = "A compact definition.";
    fixture.source.excerpts[1].text = "A compact consequence.";
    const renderedBefore = renderBookStructureModelInput(fixture.source);

    const result = route(fixture.source, fixture.lid_nodes);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("small BookStructure unit must be routable");
    expect(result.mode).toBe("whole");
    expect(result.work_units).toHaveLength(1);
    expect(result.work_units[0]).toMatchObject({
      route: { role: "whole", parent_unit_lid: "1" },
      descriptor: {
        version: "automatic_build_work_unit.v4",
        kind: "structure_unit",
        input_hash: sha256(renderedBefore),
        policy_fingerprint: { router_version: BOOK_STRUCTURE_ROUTER_VERSION_V2 },
      },
    });
    expect(result.work_units[0].rendered_input).toBe(renderedBefore);
    expect(renderBookStructureModelInput(fixture.source)).toBe(renderedBefore);
    expect(() => validateModelExecutionBudgetProof(
      result.work_units[0].descriptor.execution_budget_proof,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    )).not.toThrow();
  });

  it("fragments the deterministic 317247-byte legacy unit into proof-valid exact-cover leaves", () => {
    const fixture = makeExactRenderedSizeFixture();

    const result = route(fixture.source, fixture.lid_nodes);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("large BookStructure unit must be routable");
    expect(result.mode).toBe("fragmented");
    expect(result.work_units.length).toBeGreaterThan(1);
    expect(result.coverage).toMatchObject({
      version: "book_structure_leaf_coverage.v1",
      parent_unit_lid: "1",
      expected_leaf_count: fixture.source.leaf_lids.length,
      covered_leaf_count: fixture.source.leaf_lids.length,
      gap_count: 0,
      core_overlap_count: 0,
    });
    expect(result.coverage.core_ranges[0].start_ordinal).toBe(0);
    expect(result.coverage.core_ranges.at(-1)?.end_ordinal_exclusive)
      .toBe(fixture.source.leaf_lids.length);
    for (let index = 1; index < result.coverage.core_ranges.length; index += 1) {
      expect(result.coverage.core_ranges[index].start_ordinal)
        .toBe(result.coverage.core_ranges[index - 1].end_ordinal_exclusive);
    }
    for (const workUnit of result.work_units) {
      expect(workUnit.descriptor.version).toBe("automatic_build_work_unit.v4");
      expect(workUnit.descriptor.kind).toBe("structure_fragment");
      expect(() => validateModelExecutionBudgetProof(
        workUnit.descriptor.execution_budget_proof,
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      )).not.toThrow();
      expect(workUnit.descriptor.cost.estimated_input_tokens)
        .toBeLessThanOrEqual(workUnit.descriptor.execution_budget_proof.effective_body_limit_tokens);
    }
  });

  it("classifies proof-bound fragment candidate validation before the artifact writer", () => {
    const fixture = makeExactRenderedSizeFixture();
    const result = route(fixture.source, fixture.lid_nodes);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("large BookStructure unit must be routable");
    const routed = result.work_units[0];
    expect(routed.route.role).toMatch(/fragment/u);
    if (routed.route.role === "whole") throw new Error("expected a routed fragment");

    const automaticTarget: AutomaticBuildTarget = {
      kind: "source_file",
      profile_id: profile.id,
      book_id: target.book_id,
      root_dir: target.workspace_dir,
      workspace_dir: target.workspace_dir,
      source_path: `${target.workspace_dir}/source.md`,
      target_ref: target,
    };
    const task = createBookStructureGenerationTask({
      target_ref: target,
      policy_generation_id: "book-structure-fragment.full.v1",
      descriptor: routed.descriptor,
      generation_input: routed.input,
      parent_unit_lid: routed.route.parent_unit_lid,
      parent_content_hash: "c".repeat(64),
      source_range: routed.route.source_leaf_range,
      allowed_evidence_lids: routed.descriptor.evidence_lids,
      output_role: "unit_observation",
    });
    const classify = (candidate: unknown) => {
      try {
        writeBookStructureGenerationCandidate({
          target: automaticTarget,
          task,
          candidate,
          provenance: {
            executor: "book-structure-writer-regression",
            attempt: 1,
            generated_at: "2026-08-28T16:00:00.000Z",
          },
        });
      } catch (error) {
        return automaticBuildFailureDiagnosticFromWriterError(error, { writer_started: true });
      }
      throw new Error("invalid BookStructure candidate unexpectedly committed");
    };

    expect(classify({ version: "book_structure_fragment_observation.v1" })).toMatchObject({
      version: "automatic_build_failure_diagnostic.v3",
      category: "schema",
      code: "schema_invalid",
      phase: "artifact_writer",
    });
    expect(classify({
      version: "book_structure_fragment_observation.v1",
      parent_unit_lid: routed.route.parent_unit_lid,
      summary_fragments: [{ text: "bounded", evidence_lids: ["outside-bound-input"] }],
      candidate_key_stops: [],
      role_hints: ["foundation"],
      dependency_hints: [],
      evidence_lids: ["outside-bound-input"],
    })).toMatchObject({
      version: "automatic_build_failure_diagnostic.v3",
      category: "evidence",
      code: "evidence_out_of_scope",
      phase: "artifact_writer",
    });
  });

  it("builds deterministic proof-bound reducer groups from fresh child hashes", () => {
    const children = Array.from({ length: 24 }, (_, ordinal) => {
      const payload: BookStructureFragmentObservationV1 = {
        version: "book_structure_fragment_observation.v1",
        parent_unit_lid: "1",
        summary_fragments: [{
          text: `fragment-${ordinal}-${"x".repeat(600)}`,
          evidence_lids: [`1.${ordinal + 1}`],
        }],
        candidate_key_stops: [],
        role_hints: ["foundation"],
        dependency_hints: [],
        evidence_lids: [`1.${ordinal + 1}`],
      };
      return {
        work_unit_id: `unit:1:fragment:${String(ordinal).padStart(4, "0")}`,
        artifact_hash: sha256(JSON.stringify(payload)),
        source_leaf_range: { start_ordinal: ordinal, end_ordinal_exclusive: ordinal + 1 },
        payload,
      };
    });

    const first = routeBookStructureReductionLevelV2({
      target,
      parent_unit_lid: "1",
      source_leaf_count: children.length,
      children,
      contracts,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    });
    const repeated = routeBookStructureReductionLevelV2({
      target,
      parent_unit_lid: "1",
      source_leaf_count: children.length,
      children,
      contracts,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    });

    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("BookStructure reducer level must be routable");
    expect(first.role).toBe("reduce");
    expect(first.work_units.length).toBeGreaterThan(1);
    expect(first).toEqual(repeated);
    const boundChildren = new Set(first.work_units.flatMap((unit) => (
      unit.descriptor.dependencies.map((dependency) => `${dependency.artifact}:${dependency.sha256}`)
    )));
    expect(boundChildren).toEqual(new Set(children.map((child) => (
      `${child.work_unit_id}:${child.artifact_hash}`
    ))));
    for (const workUnit of first.work_units) {
      expect(workUnit.descriptor.version).toBe("automatic_build_work_unit.v4");
      expect(workUnit.descriptor.kind).toBe("structure_reduce");
      expect(workUnit.descriptor.aggregation?.role).toBe("reduce");
      expect(() => validateModelExecutionBudgetProof(
        workUnit.descriptor.execution_budget_proof,
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      )).not.toThrow();
    }
  });

  it("returns an atomic budget block instead of truncating one indivisible semantic record", () => {
    const fixture = makeSource(1);
    fixture.source.excerpts[0].text = "bounded core";
    fixture.source.graph_nodes = [{
      id: "concept:atomic",
      type: "concept",
      name: "x".repeat(400_000),
      occurrences: ["1.1"],
      source_lid: null,
    }];

    const result = route(fixture.source, fixture.lid_nodes);

    expect(result).toMatchObject({
      status: "blocked",
      recovery: {
        code: "budget/atomic_input_item_too_large",
        stage: "book_structure",
        parent_unit_lid: "1",
        item_kind: "graph_node",
        item_key: "concept:atomic",
      },
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(256));
  });

  it("fragments an oversized stitch packet into proof-valid contiguous unit-card ranges", () => {
    const packet = makeStitchPacket(48, 1_500);

    const result = routeBookStructureStitchWorkUnitsV2({
      target,
      packet,
      source_fingerprint: target.input_fingerprint,
      contracts,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("oversized stitch must be routable");
    expect(result.mode).toBe("fragmented");
    expect(result.work_units.length).toBeGreaterThan(1);
    expect(result.coverage).toMatchObject({
      expected_unit_card_count: packet.unit_cards.length,
      covered_unit_card_count: packet.unit_cards.length,
      gap_count: 0,
      overlap_count: 0,
    });
    for (let index = 0; index < result.work_units.length; index += 1) {
      const workUnit = result.work_units[index];
      if (workUnit.route.role !== "fragment") {
        throw new Error("fragmented stitch route emitted a whole work unit");
      }
      expect(workUnit.descriptor.kind).toBe("structure_stitch_fragment");
      expect(workUnit.descriptor.aggregation).toEqual({ parent_lid: "stitch", role: "fragment" });
      expect(() => validateModelExecutionBudgetProof(
        workUnit.descriptor.execution_budget_proof,
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      )).not.toThrow();
      if (index > 0) {
        const previous = result.work_units[index - 1];
        if (previous.route.role !== "fragment") {
          throw new Error("fragmented stitch route emitted a whole work unit");
        }
        expect(workUnit.route.unit_card_range.start_ordinal)
          .toBe(previous.route.unit_card_range.end_ordinal_exclusive);
      }
    }
  });

  it("builds deterministic proof-bound stitch reducer groups and a final root", () => {
    const children: BookStructureStitchReductionChildV1[] = Array.from(
      { length: 20 },
      (_, ordinal) => {
        const unitLid = String(ordinal + 1);
        const payload = {
          spine: [{
            lid: unitLid,
            role: "foundation" as const,
            summary: { text: `summary-${ordinal}-${"x".repeat(400)}`, evidence_lids: [`${unitLid}.1`] },
            key_stop_ids: [],
            depends_on: [],
          }],
          throughlines: [],
          key_stops: [],
        };
        return {
          work_unit_id: `stitch:fragment:${String(ordinal).padStart(4, "0")}`,
          artifact_hash: sha256(JSON.stringify(payload)),
          unit_card_range: { start_ordinal: ordinal, end_ordinal_exclusive: ordinal + 1 },
          payload,
        };
      },
    );

    const level = routeBookStructureStitchReductionLevelV2({
      target,
      unit_card_count: children.length,
      children,
      contracts,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    });
    expect(level.status).toBe("ready");
    if (level.status !== "ready") throw new Error("stitch reducer level must be routable");
    expect(level.role).toBe("reduce");
    expect(level.work_units.length).toBeGreaterThan(1);

    const nextChildren: BookStructureStitchReductionChildV1[] = level.work_units.map((unit) => ({
      work_unit_id: unit.descriptor.work_unit_id,
      artifact_hash: sha256(JSON.stringify({ spine: [], throughlines: [], key_stops: [] })),
      unit_card_range: unit.route.unit_card_range,
      payload: { spine: [], throughlines: [], key_stops: [] },
    }));
    const final = routeBookStructureStitchReductionLevelV2({
      target,
      unit_card_count: children.length,
      children: nextChildren,
      contracts,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      reducer_level: 2,
    });
    expect(final.status).toBe("ready");
    if (final.status !== "ready") throw new Error("stitch reducer root must be routable");
    expect(final.role).toBe("final");
    expect(final.work_units).toHaveLength(1);
    expect(final.work_units[0].descriptor.kind).toBe("structure_stitch_reduce");
    expect(final.work_units[0].descriptor.aggregation?.role).toBe("final");
  });

  it("blocks one oversized atomic stitch card without truncation", () => {
    const packet = makeStitchPacket(1, 400_000);
    const result = routeBookStructureStitchWorkUnitsV2({
      target,
      packet,
      source_fingerprint: target.input_fingerprint,
      contracts,
      transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    });

    expect(result).toMatchObject({
      status: "blocked",
      recovery: {
        code: "budget/atomic_input_item_too_large",
        parent_unit_lid: "stitch",
        item_kind: "unit_card",
        item_key: "1",
      },
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(256));
  });
});
