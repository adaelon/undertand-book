import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";
import { resolveContentProfile } from "../src/content-profile";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import {
  STAGE_WORK_UNIT_ROUTERS,
  accountWorkUnits,
  buildWorkUnitCost,
  createWorkUnitDescriptor,
  routePass1WindowWorkUnits,
  workUnitPlanDigest,
} from "../src/stage-work-unit";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-work-unit-"));
  const sourcePath = path.join(root, "guide.md");
  const source = "# Guide\n\nFirst paragraph.\n\nSecond paragraph with $x$.\n";
  writeFileSync(sourcePath, source, "utf8");
  const nodes = segment(markdownToBlocks(source));
  return {
    root,
    source,
    nodes,
    byLid: new Map(nodes.map((node) => [node.lid, node])),
    windows: splitWindows(nodes, source, { maxInputTokens: 20, maxLeavesSoft: 1 }),
    target: resolveAutomaticBuildTarget(sourcePath, root),
  };
}

describe("stage work-unit router framework", () => {
  it("registers an explicit versioned router for every current semantic stage", () => {
    expect(Object.keys(STAGE_WORK_UNIT_ROUTERS).sort()).toEqual([
      "book_structure",
      "paper_lexicon",
      "paper_metadata",
      "pass1",
      "pass2",
      "profile_sidecar",
    ]);
    expect(new Set(Object.values(STAGE_WORK_UNIT_ROUTERS).map((router) => router.router_version)).size).toBe(6);
    expect(STAGE_WORK_UNIT_ROUTERS.pass1).toMatchObject({ kind: "pass1_window", compatibility_mode: true });
  });

  it("maps Pass1 v2 descriptors one-to-one to legacy numeric window artifacts", () => {
    const { source, nodes, byLid, windows, target } = fixture();
    const policy = automaticBuildExtractionPolicy("pass1", resolveContentProfile("technical_learning"), "full");
    const descriptors = routePass1WindowWorkUnits({ target: target.target_ref, windows, byLid, source, policy_fingerprint: policy });

    expect(descriptors.map((unit) => unit.work_unit_id)).toEqual(windows.map((window) => String(window.id)));
    expect(descriptors.map((unit) => unit.kind)).toEqual(windows.map(() => "pass1_window"));
    expect(descriptors[0]).toMatchObject({
      version: "automatic_build_work_unit.v2",
      target: target.target_ref,
      stage: "pass1",
      evidence_lids: windows[0].leafLids,
      policy_fingerprint: policy,
      legacy_artifact_ref: `.build/pass1/${windows[0].id}.json`,
    });
    expect(descriptors[0].cost.score).toBeGreaterThanOrEqual(descriptors[0].cost.estimated_input_tokens);
    expect(descriptors[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("keeps stable ids while source or policy mutations change only bound identity", () => {
    const { source, byLid, windows, target } = fixture();
    const profile = resolveContentProfile("technical_learning");
    const full = automaticBuildExtractionPolicy("pass1", profile, "full");
    const balanced = automaticBuildExtractionPolicy("pass1", profile, "balanced");
    const original = routePass1WindowWorkUnits({ target: target.target_ref, windows, byLid, source, policy_fingerprint: full });
    const policyChanged = routePass1WindowWorkUnits({ target: target.target_ref, windows, byLid, source, policy_fingerprint: balanced });
    const sourceChanged = routePass1WindowWorkUnits({
      target: target.target_ref,
      windows,
      byLid,
      source: source.replace("First", "Other"),
      policy_fingerprint: full,
    });

    expect(policyChanged[0].work_unit_id).toBe(original[0].work_unit_id);
    expect(policyChanged[0].input_hash).toBe(original[0].input_hash);
    expect(policyChanged[0].policy_fingerprint).not.toEqual(original[0].policy_fingerprint);
    expect(sourceChanged.map((unit) => unit.work_unit_id)).toEqual(original.map((unit) => unit.work_unit_id));
    expect(sourceChanged.map((unit) => unit.input_hash)).not.toEqual(original.map((unit) => unit.input_hash));
  });

  it("accounts deterministic skips without creating fake model artifacts", () => {
    const { target } = fixture();
    const policy = automaticBuildExtractionPolicy("paper_lexicon", resolveContentProfile("paper"), "full");
    const paperTarget = { ...target.target_ref, profile_id: "paper" as const };
    const eligible = createWorkUnitDescriptor({
      target: paperTarget,
      stage: "paper_lexicon",
      work_unit_id: "candidate:0",
      kind: "lexicon_candidate_batch",
      input_hash: "a".repeat(64),
      policy_fingerprint: policy,
      evidence_lids: ["1.1"],
      cost: buildWorkUnitCost({ estimated_input_tokens: 20, visible_lids: 1, candidate_count: 1, expected_output_items: 1 }),
    });
    const skipped = createWorkUnitDescriptor({
      ...eligible,
      work_unit_id: "candidate:1",
      input_hash: "b".repeat(64),
      deterministic_skip: { code: "no_term_signal", evidence: ["1.2"] },
    });
    const units = [eligible, skipped];

    expect(accountWorkUnits(units, new Set())).toEqual({ total: 2, pending: 1, committed: 0, skipped: 1 });
    expect(accountWorkUnits(units, new Set([eligible.work_unit_id]))).toEqual({ total: 2, pending: 0, committed: 1, skipped: 1 });
    expect(workUnitPlanDigest(units)).toBe(workUnitPlanDigest([...units].reverse()));
  });

  it("marks empty Pass2 candidate windows as deterministic skips", () => {
    const { target } = fixture();
    const policy = automaticBuildExtractionPolicy("pass2", resolveContentProfile("technical_learning"), "full");
    const descriptor = createWorkUnitDescriptor({
      target: target.target_ref,
      stage: "pass2",
      work_unit_id: "0",
      kind: "pass2_candidate_batch",
      input_hash: "c".repeat(64),
      policy_fingerprint: policy,
      evidence_lids: ["1.1", "1.2"],
      cost: buildWorkUnitCost({
        estimated_input_tokens: 20,
        visible_lids: 2,
        candidate_count: 0,
        expected_output_items: 0,
      }),
    });

    expect(descriptor.deterministic_skip).toEqual({
      code: "no_long_range_candidates",
      evidence: ["1.1", "1.2"],
    });
    expect(accountWorkUnits([descriptor], new Set())).toEqual({
      total: 1,
      pending: 0,
      committed: 0,
      skipped: 1,
    });
  });
});
