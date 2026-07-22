import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditHybridFoundationAdaptation,
  createHybridFoundationAdaptationBaseline,
  ExternalBenchmarkDescriptorZ,
  serializeHybridFoundationAdaptationAudit,
} from "../src/hybrid-foundation-goldset";
import type { HybridFoundationV2Artifacts } from "../src/hybrid-foundation-v2";
import { runHybridFoundationAdaptationAuditCli } from "../scripts/run-hybrid-foundation-adaptation-audit";

const GOLDSET_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));

function fakeArtifacts(): HybridFoundationV2Artifacts {
  return {
    base: {
      book_id: "audit-book",
      lid_nodes: [
        { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 5 }, children: ["1.1"] },
        { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 0, end: 5 }, children: [] },
        { lid: "2", path: [2], kind: "chapter", span: { start: 5, end: 9 }, children: ["2.1"] },
        { lid: "2.1", path: [2, 1], kind: "formula", span: { start: 5, end: 9 }, children: [] },
      ],
      graph_nodes: [],
      graph_edges: [],
    },
    source_manifest: {} as HybridFoundationV2Artifacts["source_manifest"],
    pdf_source_map: {
      version: "pdf_source_map.v2",
      book_id: "audit-book",
      coordinate_system: {
        space: "pdf_user_space",
        origin: "bottom_left",
        unit: "pt",
        rotation_applied: false,
      },
      pages: [{ pageIndex: 0, width: 100, height: 100, rotate: 0, view: [0, 0, 100, 100] }],
      entries: [
        {
          lid: "1.1",
          source_span: { start: 0, end: 5 },
          precision: "char_exact",
          regions: [{ region_id: "r1", pageIndex: 0, bbox: [0, 0, 10, 10] }],
          exact_source_spans: [{ start: 0, end: 5 }],
          primary_region: { region_id: "r1", pageIndex: 0, bbox: [0, 0, 10, 10] },
          alignment: { unit_id: "unit-1", reason: "complete monotonic character projection inside located unit" },
        },
        {
          lid: "2.1",
          source_span: { start: 5, end: 9 },
          precision: "unmapped",
          regions: [],
          exact_source_spans: [],
          alignment: { unit_id: "unit-2", reason: "formula has no unique bounded PDF gap" },
        },
      ],
      page_region_index: { "0": ["r1"] },
      config_hash: "a".repeat(64),
    },
    pdf_selection_map_manifest: {} as HybridFoundationV2Artifacts["pdf_selection_map_manifest"],
    pdf_selection_map_pages: [{
      version: "pdf_selection_map_page.v2",
      book_id: "audit-book",
      pageIndex: 0,
      chars: [{
        char_index: 0,
        text: "a",
        rect: { pageIndex: 0, bbox: [0, 0, 1, 1] },
        source_span: { start: 0, end: 1 },
        lid: "1.1",
      }],
    }],
    alignment_report: {
      version: "alignment_report.v2",
      book_id: "audit-book",
      input_fingerprint: {
        source_sha256: "b".repeat(64),
        pdf_sha256: "c".repeat(64),
      },
      config: {
        algorithm: "semantic_unit_projection_v2",
        coordinate_system: "pdf_user_space",
        quality_policy_version: "hybrid_quality_policy.v1",
      },
      config_hash: "a".repeat(64),
      integrity: {
        input_fingerprint_matches: true,
        artifact_hashes_match: true,
        all_leaf_lids_unique_and_present: true,
        all_regions_in_page_bounds: true,
        located_units_monotonic: true,
        no_duplicate_pdf_bindings: true,
        selection_shards_match_manifest: true,
      },
      quality: {
        policy_version: "hybrid_quality_policy.v1",
        tier: "degraded",
        unit_location_ratio: 0.5,
        exact_text_span_ratio: 0.5,
        exact_formula_ratio: 0,
        heading_location_ratio: 1,
      },
      diagnostics: {
        raw_duplicate_pdf_binding_count: 0,
        raw_duplicate_selection_binding_count: 0,
        conflicted_lid_count: 0,
      },
    },
  };
}

function cloneArtifacts(artifacts: HybridFoundationV2Artifacts): HybridFoundationV2Artifacts {
  return structuredClone(artifacts);
}

describe("PR8 full-book adaptation audit", () => {
  it("freezes all 2,075 external leaves without copyrighted source text", () => {
    const descriptor = ExternalBenchmarkDescriptorZ.parse(JSON.parse(readFileSync(
      path.join(GOLDSET_ROOT, "external-formula-dense-transformer.json"),
      "utf8",
    )));

    expect(descriptor.expected_adaptation_v1.leaf_count).toBe(2075);
    expect(Object.keys(descriptor.expected_adaptation_v1.projection_reason_counts)).toHaveLength(12);
    expect(descriptor.expected_adaptation_v1.section_stats).toHaveLength(43);
    expect(Object.keys(descriptor.expected_adaptation_v1.issue_counts)).toEqual(
      Array.from({ length: 11 }, (_, index) => `PDF-A${String(index + 1).padStart(3, "0")}`),
    );
    expect(descriptor.expected_adaptation_v1.leaves).toHaveLength(2075);
    expect(JSON.stringify(descriptor.expected_adaptation_v1.leaves)).not.toContain("source_text");
  });

  it("detects deletion, duplication, reason drift, and page drift while allowing unique hash migration", () => {
    const source = "alphaBETA";
    const artifacts = fakeArtifacts();
    const baseline = createHybridFoundationAdaptationBaseline({
      source,
      artifacts,
      issue_ids_by_lid: { "1.1": ["PDF-A002"], "2.1": ["PDF-A006"] },
    });

    const first = auditHybridFoundationAdaptation({ source, artifacts, baseline });
    expect(first.passed).toBe(true);
    expect(first.coverage).toMatchObject({ baseline_leaf_count: 2, current_leaf_count: 2, direct_lid_count: 2 });
    expect(serializeHybridFoundationAdaptationAudit(first)).toBe(
      serializeHybridFoundationAdaptationAudit(auditHybridFoundationAdaptation({ source, artifacts, baseline })),
    );

    const reasonDrift = cloneArtifacts(artifacts);
    reasonDrift.pdf_source_map.entries[0].alignment.reason = "changed reason";
    expect(auditHybridFoundationAdaptation({ source, artifacts: reasonDrift, baseline })).toMatchObject({
      passed: false,
      reason_closure: { mismatched_leaf_count: 1 },
    });

    const deletion = cloneArtifacts(artifacts);
    deletion.base.lid_nodes = deletion.base.lid_nodes.filter((node) => node.lid !== "2.1");
    deletion.pdf_source_map.entries = deletion.pdf_source_map.entries.filter((entry) => entry.lid !== "2.1");
    expect(auditHybridFoundationAdaptation({ source, artifacts: deletion, baseline })).toMatchObject({
      passed: false,
      coverage: { missing_baseline_count: 1 },
    });

    const duplicate = cloneArtifacts(artifacts);
    duplicate.base.lid_nodes.push({
      ...structuredClone(duplicate.base.lid_nodes.find((node) => node.lid === "2.1")!),
      lid: "2.2",
      path: [2, 2],
    });
    duplicate.pdf_source_map.entries.push({
      ...structuredClone(duplicate.pdf_source_map.entries.find((entry) => entry.lid === "2.1")!),
      lid: "2.2",
    });
    expect(auditHybridFoundationAdaptation({ source, artifacts: duplicate, baseline })).toMatchObject({
      passed: false,
      coverage: { unexpected_current_count: 1 },
    });

    const pageDrift = cloneArtifacts(artifacts);
    pageDrift.pdf_source_map.entries[0].regions[0].pageIndex = 1;
    expect(auditHybridFoundationAdaptation({ source, artifacts: pageDrift, baseline })).toMatchObject({
      passed: false,
      wrong_page_count: 1,
    });

    const migrated = cloneArtifacts(artifacts);
    migrated.base.lid_nodes.find((node) => node.lid === "1")!.children = ["1.9"];
    const migratedNode = migrated.base.lid_nodes.find((node) => node.lid === "1.1")!;
    migratedNode.lid = "1.9";
    migratedNode.path = [1, 9];
    migrated.pdf_source_map.entries[0].lid = "1.9";
    migrated.pdf_selection_map_pages[0].chars[0].lid = "1.9";
    expect(auditHybridFoundationAdaptation({ source, artifacts: migrated, baseline })).toMatchObject({
      passed: true,
      coverage: { direct_lid_count: 1, source_hash_migration_count: 1 },
    });
    expect(auditHybridFoundationAdaptation({
      source,
      artifacts: migrated,
      baseline,
      lid_migration_map: { "1.1": { status: "stable", v2_lid: "1.99" } },
    })).toMatchObject({
      passed: false,
      coverage: { missing_baseline_count: 1, source_hash_migration_count: 0 },
    });
  });

  it("requires an explicit artifact directory at the audit CLI boundary", async () => {
    await expect(runHybridFoundationAdaptationAuditCli([]))
      .rejects.toThrow("--artifact-dir requires an explicit directory");
  });
});
