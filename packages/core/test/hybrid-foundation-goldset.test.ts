import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExternalBenchmarkDescriptorZ,
  loadGoldsetManifest,
  runLicensedGoldsetFixture,
} from "../src/hybrid-foundation-goldset";
import { runHybridFoundationGoldsetCli } from "../scripts/run-hybrid-foundation-goldset";

const GOLDSET_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));

describe("HF2-0 hybrid foundation goldset", () => {
  it("registers two CC0 fixtures and an explicit-path-only external benchmark", () => {
    const manifest = loadGoldsetManifest(GOLDSET_ROOT);

    expect(manifest.fixtures.map((fixture) => fixture.fixture_id)).toEqual([
      "licensed-inline-formula",
      "licensed-two-column-formula",
    ]);
    expect(manifest.fixtures.every((fixture) => fixture.license.spdx === "CC0-1.0")).toBe(true);
    expect(manifest.external_benchmarks).toEqual([expect.objectContaining({
      benchmark_id: "external-formula-dense-transformer",
      structure_audit_path: "external-formula-dense-transformer-structure-audit.json",
      reviewed_source_plan_path: "external-formula-dense-transformer-reviewed-source-plan.json",
      reviewed_source_candidate_audit_path: "external-formula-dense-transformer-reviewed-source-candidate-audit.json",
      alignment_unit_audit_path: "external-formula-dense-transformer-alignment-unit-audit.json",
      child_window_audit_path: "external-formula-dense-transformer-child-window-audit.json",
      display_token_audit_path: "external-formula-dense-transformer-display-token-audit.json",
      formula_source_ast_audit_path: "external-formula-dense-transformer-formula-source-ast-audit.json",
      requires_explicit_book_path: true,
    })]);
    for (const metadataPath of [
      manifest.external_benchmarks[0].structure_audit_path,
      manifest.external_benchmarks[0].reviewed_source_plan_path,
      manifest.external_benchmarks[0].reviewed_source_candidate_audit_path,
      manifest.external_benchmarks[0].alignment_unit_audit_path,
      manifest.external_benchmarks[0].child_window_audit_path,
      manifest.external_benchmarks[0].display_token_audit_path,
      manifest.external_benchmarks[0].formula_source_ast_audit_path,
    ]) {
      expect(metadataPath && readFileSync(path.join(GOLDSET_ROOT, metadataPath), "utf8").length).toBeGreaterThan(0);
    }
    const descriptor = ExternalBenchmarkDescriptorZ.parse(JSON.parse(readFileSync(
      path.join(GOLDSET_ROOT, manifest.external_benchmarks[0].descriptor_path),
      "utf8",
    )));
    expect(descriptor.expected_v1).toMatchObject({
      leaf_count: 2077,
      mapped_leaf_count: 559,
      alignable_text_count: 1100,
      mapped_text_count: 559,
    });
  });

  it("requires an explicit local book path for the external benchmark", async () => {
    await expect(runHybridFoundationGoldsetCli(["--external"]))
      .rejects.toThrow("--external requires an explicit book directory");
  });

  it.each([
    "licensed-inline-formula",
    "licensed-two-column-formula",
  ])("freezes the deterministic v1 failure for %s", async (fixtureId) => {
    const { expected, report } = await runLicensedGoldsetFixture(GOLDSET_ROOT, fixtureId);

    expect(report.input_sha256).toEqual(expected.input_sha256);
    expect(report.v1).toMatchObject({
      hard_gate_error: expected.expected_v1.hard_gate_error,
      leaf_count: expected.expected_v1.leaf_count,
      mapped_leaf_count: expected.expected_v1.mapped_leaf_count,
      mapped_text_ratio: expected.expected_v1.mapped_text_ratio,
      mapped_heading_ratio: expected.expected_v1.mapped_heading_ratio,
      unmapped_asset_count: expected.expected_v1.unmapped_asset_count,
      annotated_wrong_page_count: expected.expected_v1.annotated_wrong_page_count,
      duplicate_pdf_binding_count: expected.expected_v1.duplicate_pdf_binding_count,
      source_span_coverage_delta: 0,
      repeatable: true,
      artifact_hash_differences: [],
    });
    expect(report.v1.annotations).toHaveLength(expected.annotations.length);
    expect(report.v1.quality).toEqual({
      policy_version: "hybrid_quality_policy.v1",
      unit_location_ratio: expect.any(Number),
      exact_text_span_ratio: expect.any(Number),
      exact_formula_ratio: 0,
      heading_location_ratio: expected.expected_v1.mapped_heading_ratio,
    });
    expect(report.v1.source_span_coverage_ratio).toBe(report.v1.quality.exact_text_span_ratio);
    expect(report.v2).toMatchObject({
      integrity_gate_matrix: {
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
        tier: "full",
        unit_location_ratio: 1,
        exact_text_span_ratio: 1,
        exact_formula_ratio: 1,
        heading_location_ratio: 1,
      },
      source_span_coverage_ratio: 1,
      artifact_hash_differences: [],
      repeatable: true,
    });
    expect(report.v2.source_span_coverage_delta).toBe(
      report.v2.source_span_coverage_ratio - report.v1.source_span_coverage_ratio,
    );
    expect(report.v2.source_span_coverage_delta).toBeGreaterThanOrEqual(0);
  });
});
