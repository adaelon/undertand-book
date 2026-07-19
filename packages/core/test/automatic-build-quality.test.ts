import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_BUILD_QUALITY_GOLDSET,
  evaluateAutomaticBuildQualityFloor,
  evaluateAutomaticBuildStageQuality,
} from "../src/automatic-build-quality";
import {
  auditAutomaticBuildLegacy,
  readAutomaticBuildMigrationDecision,
  selectAutomaticBuildMigrationMode,
} from "../src/automatic-build-legacy";
import { publishAutomaticBuildArtifactSet } from "../src/automatic-build-publication";
import { buildAutomaticBuildSnapshot, resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy, buildSemanticArtifactEnvelope, writeSemanticArtifactEnvelopeFile } from "../src/semantic-artifact";
import { buildWorkUnitCost, createWorkUnitDescriptor } from "../src/stage-work-unit";
import { automaticBuildStageArtifactPath } from "../src/automatic-build-quality";
import { automaticBuildNext } from "../../../skills/build/automatic-build";

const targetRef = {
  version: "build_target_ref.v2" as const,
  workspace_dir: "C:/repo/.understand-book/quality",
  book_id: "quality",
  profile_id: "technical_learning" as const,
  input_fingerprint: "quality-fingerprint",
};
const policy = automaticBuildExtractionPolicy("pass1", resolveContentProfile("technical_learning"), "full");

function pass1Descriptor(id: string) {
  return createWorkUnitDescriptor({
    target: targetRef,
    stage: "pass1",
    work_unit_id: id,
    kind: "pass1_window",
    input_hash: id.padEnd(64, "a").slice(0, 64),
    policy_fingerprint: policy,
    evidence_lids: [`${id}.1`],
    cost: buildWorkUnitCost({ estimated_input_tokens: 20, visible_lids: 1, expected_output_items: 1 }),
  });
}

function pass1Envelope(descriptor: ReturnType<typeof pass1Descriptor>, grounded: boolean) {
  return buildSemanticArtifactEnvelope({
    target: targetRef,
    stage: "pass1",
    work_unit_id: descriptor.work_unit_id,
    input_hash: descriptor.input_hash,
    policy_fingerprint: descriptor.policy_fingerprint,
    provenance: { executor: "fake", model: "codex-fake-v1", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
    payload: {
      content_hash: descriptor.input_hash,
      nodes: grounded ? [{
        id: `claim:${descriptor.work_unit_id}.1:grounded`,
        type: "claim",
        name: "Grounded claim",
        occurrences: [],
        source_lid: `${descriptor.work_unit_id}.1`,
      }] : [],
      edges: [],
    },
  });
}

describe("automatic build versioned quality and migration gates", () => {
  it("keeps integrity separate from the selected quality floor", () => {
    const descriptors = ["a", "b", "c", "d", "e"].map(pass1Descriptor);
    const passing = Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.work_unit_id,
      pass1Envelope(descriptor, descriptor.work_unit_id !== "e"),
    ]));
    const below = { ...passing, d: pass1Envelope(descriptors[3], false) };

    const passed = evaluateAutomaticBuildStageQuality({
      target_ref: targetRef,
      stage: "pass1",
      quality_profile: "full",
      work_units: descriptors,
      artifacts: passing,
    });
    const failed = evaluateAutomaticBuildStageQuality({
      target_ref: targetRef,
      stage: "pass1",
      quality_profile: "full",
      work_units: descriptors,
      artifacts: below,
    });

    expect(passed).toMatchObject({ gate_status: "passed", integrity: { status: "passed" }, quality: { status: "passed" } });
    expect(passed.quality.metrics.eligible_unit_coverage).toBe(0.8);
    expect(failed).toMatchObject({ gate_status: "quality_below_floor", integrity: { status: "passed" }, quality: { status: "below_floor" } });
    expect(failed.quality.metrics.eligible_unit_coverage).toBe(0.6);
  });

  it("rejects policy drift and legacy payloads as integrity failures before quality", () => {
    const descriptor = pass1Descriptor("a");
    const stale = pass1Envelope(descriptor, true);
    stale.policy_fingerprint = { ...stale.policy_fingerprint, schema_version: "pass1_output.v999" };
    const policyDrift = evaluateAutomaticBuildStageQuality({
      target_ref: targetRef,
      stage: "pass1",
      quality_profile: "full",
      work_units: [descriptor],
      artifacts: { a: stale },
    });
    const legacy = evaluateAutomaticBuildStageQuality({
      target_ref: targetRef,
      stage: "pass1",
      quality_profile: "full",
      work_units: [descriptor],
      artifacts: { a: stale.payload },
    });

    expect(policyDrift).toMatchObject({ gate_status: "integrity_failed", integrity: { stale_artifacts: 1 } });
    expect(legacy).toMatchObject({ gate_status: "integrity_failed", integrity: { legacy_artifacts: 1, policy_status: "legacy_policy_unknown" } });
  });

  it("blocks automatic close when complete v2 work stays below the eligible-unit floor", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-quality-close-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, [
      "# Guide",
      ...Array.from({ length: 320 }, (_, index) => `Paragraph ${index + 1} carries a source fact.`),
    ].join("\n\n"), "utf8");
    const target = resolveAutomaticBuildTarget(source, root);
    const stage = buildAutomaticBuildSnapshot(target, { quality_profile: "full" }).stages[0];
    for (const descriptor of stage.work_units ?? []) {
      if (descriptor.deterministic_skip) continue;
      const file = automaticBuildStageArtifactPath(target, "pass1", descriptor.work_unit_id);
      mkdirSync(path.dirname(file), { recursive: true });
      writeSemanticArtifactEnvelopeFile(file, buildSemanticArtifactEnvelope({
        target: target.target_ref,
        stage: "pass1",
        work_unit_id: descriptor.work_unit_id,
        input_hash: descriptor.input_hash,
        policy_fingerprint: descriptor.policy_fingerprint,
        provenance: { executor: "fake", model: "codex-fake-v1", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
        payload: { content_hash: descriptor.input_hash, nodes: [], edges: [] },
      }));
    }

    const next = automaticBuildNext(source, root, 1, { quality_profile: "full" });
    expect(next.action).toMatchObject({
      kind: "needs_user",
      reason: "quality_gate_failed",
      stage: "pass1",
      gate_status: "quality_below_floor",
    });
    expect(existsSync(path.join(target.workspace_dir, "base.json"))).toBe(false);
  });

  it("binds quality boundaries to the checked-in CC0 goldset digest", () => {
    const file = path.join(__dirname, "fixtures", "automatic-build-quality-goldset.v1.json");
    const bytes = readFileSync(file);
    const fixture = JSON.parse(bytes.toString("utf8")) as {
      version: string;
      license: string;
      cases: Array<Parameters<typeof evaluateAutomaticBuildQualityFloor>[0] & { id: string; expected: string }>;
    };
    expect(fixture.version).toBe(AUTOMATIC_BUILD_QUALITY_GOLDSET.version);
    expect(fixture.license).toBe("CC0-1.0");
    expect(createHash("sha256").update(JSON.stringify(fixture)).digest("hex")).toBe(AUTOMATIC_BUILD_QUALITY_GOLDSET.sha256);
    for (const item of fixture.cases) {
      expect(evaluateAutomaticBuildQualityFloor(item).status, item.id).toBe(item.expected);
    }
  });

  it("requires an explicit legacy mode and snapshots v1 before v2 rebuild", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-legacy-audit-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA semantic paragraph.\n", "utf8");
    const target = resolveAutomaticBuildTarget(source, root);
    const legacyPath = path.join(target.workspace_dir, ".build", "pass1", "0.json");
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacyBytes = JSON.stringify({ content_hash: "legacy-source-only", nodes: [], edges: [] });
    writeFileSync(legacyPath, legacyBytes, "utf8");

    const audit = auditAutomaticBuildLegacy(target);
    expect(audit).toMatchObject({
      legacy_artifacts: 1,
      policy_status: "legacy_policy_unknown",
      invalid_artifacts: 0,
      source_stale_artifacts: 1,
      schema_valid_artifacts: 1,
      legacy_resume_allowed: false,
    });
    expect(automaticBuildNext(source, root, 1).action).toMatchObject({
      kind: "needs_user",
      reason: "legacy_migration_required",
      stage: "pass1",
    });

    const decision = selectAutomaticBuildMigrationMode(target, "v2_rebuild", "2026-07-19T00:00:00.000Z");
    expect(decision.mode).toBe("v2_rebuild");
    expect(readAutomaticBuildMigrationDecision(target)).toEqual(decision);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
    expect(existsSync(path.join(decision.legacy_snapshot_path!, "manifest.json"))).toBe(true);
    expect(readFileSync(path.join(decision.legacy_snapshot_path!, ".build", "pass1", "0.json"), "utf8")).toBe(legacyBytes);
    expect(automaticBuildNext(source, root, 1).action).toMatchObject({ kind: "needs_user", reason: "preflight_required" });
  });

  it("keeps legacy_resume out of v2 completion", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-legacy-resume-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA semantic paragraph.\n", "utf8");
    const target = resolveAutomaticBuildTarget(source, root);
    const legacyPath = path.join(target.workspace_dir, ".build", "pass1", "0.json");
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    const descriptor = buildAutomaticBuildSnapshot(target, { quality_profile: "full" }).stages[0].work_units?.[0];
    if (!descriptor) throw new Error("expected legacy resume descriptor");
    writeFileSync(legacyPath, JSON.stringify({ content_hash: descriptor.input_hash, nodes: [], edges: [] }), "utf8");
    selectAutomaticBuildMigrationMode(target, "legacy_resume", "2026-07-19T00:00:00.000Z");

    expect(automaticBuildNext(source, root, 1).action).toMatchObject({
      kind: "needs_user",
      reason: "legacy_resume_selected",
      policy_status: "legacy_policy_unknown",
    });
  });

  it("rolls a multi-file public publication back on an injected promotion failure", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "understand-book-publication-"));
    const oldMetadata = "{\"version\":\"old\"}\n";
    writeFileSync(path.join(workspace, "paper_metadata.json"), oldMetadata, "utf8");

    expect(() => publishAutomaticBuildArtifactSet({
      workspace_dir: workspace,
      stage: "paper_metadata",
      artifacts: {
        "paper_metadata.json": "{\"version\":\"new\"}\n",
        "publication-marker.json": "{\"complete\":true}\n",
      },
      fault_injection: { fail_after_promotions: 1 },
    })).toThrow("injected publication failure");
    expect(readFileSync(path.join(workspace, "paper_metadata.json"), "utf8")).toBe(oldMetadata);
    expect(existsSync(path.join(workspace, "publication-marker.json"))).toBe(false);

    const committed = publishAutomaticBuildArtifactSet({
      workspace_dir: workspace,
      stage: "paper_metadata",
      artifacts: {
        "paper_metadata.json": "{\"version\":\"new\"}\n",
        "publication-marker.json": "{\"complete\":true}\n",
      },
    });
    expect(committed.status).toBe("committed");
    expect(readFileSync(path.join(workspace, "paper_metadata.json"), "utf8")).toContain("new");
    expect(existsSync(path.join(workspace, "publication-marker.json"))).toBe(true);

    writeFileSync(path.join(workspace, "paper_metadata.json"), "{\"version\":\"downstream-mutated\"}\n", "utf8");
    const replayed = publishAutomaticBuildArtifactSet({
      workspace_dir: workspace,
      stage: "paper_metadata",
      artifacts: {
        "paper_metadata.json": "{\"version\":\"new\"}\n",
        "publication-marker.json": "{\"complete\":true}\n",
      },
    });
    expect(replayed.transaction_id).toBe(committed.transaction_id);
    expect(readFileSync(path.join(workspace, "paper_metadata.json"), "utf8")).toContain('"new"');
  });
});
