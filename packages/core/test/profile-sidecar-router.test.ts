import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { markdownToBlocks } from "../src/md-adapter";
import {
  buildProfileSidecarSemanticArtifact,
  computeProfileSidecarRoutingStatus,
  routeProfileSidecarWorkUnits,
} from "../src/profile-sidecar-router";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";

function fixture(sourceOverride?: string) {
  const sourcePath = path.join(__dirname, "fixtures", "profile-sidecar-semantic-units.md");
  const source = sourceOverride ?? readFileSync(sourcePath, "utf8");
  const lidNodes = segment(markdownToBlocks(source));
  const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
  const windows = splitWindows(lidNodes, source);
  const resolved = resolveAutomaticBuildTarget(sourcePath, path.resolve(__dirname, "..", "..", ".."));
  const target = resolved.target_ref;
  const profile = resolveContentProfile("technical_learning");
  const policy = automaticBuildExtractionPolicy("profile_sidecar", profile, "full");
  return { source, lidNodes, byLid, windows, target, profile, policy };
}

describe("profile sidecar semantic-unit routers", () => {
  it("accounts eligible paragraph groups without assigning discourse to formula/code fragments", () => {
    const input = fixture();
    const plan = routeProfileSidecarWorkUnits({
      ...input,
      content_profile: input.profile,
      policy_fingerprint: input.policy,
    });
    const discourse = Object.values(plan.packets).filter((packet) => packet.unit_kind === "profile_sidecar_discourse");
    const visible = discourse.flatMap((packet) => packet.visible_lids);

    expect(discourse.length).toBeGreaterThan(0);
    expect(new Set(visible).size).toBe(visible.length);
    expect(visible.every((lid) => input.byLid.get(lid)?.kind === "paragraph")).toBe(true);
    expect(discourse.every((packet) => packet.formula_lids.length === 0)).toBe(true);
    expect(plan.accounting.discourse_eligible_lids).toBe(visible.length);
    expect(plan.accounting.discourse_skipped_lids).toBeGreaterThan(0);
  });

  it("skips bare variables, footnote markers, decorations, and ungrounded formulas with stable reasons", () => {
    const input = fixture();
    const plan = routeProfileSidecarWorkUnits({
      ...input,
      content_profile: input.profile,
      policy_fingerprint: input.policy,
    });
    const reasons = plan.work_units.flatMap((unit) => unit.deterministic_skip?.code ? [unit.deterministic_skip.code] : []);

    expect(reasons).toEqual(expect.arrayContaining([
      "formula_bare_variable",
      "formula_footnote_or_page_marker",
      "formula_text_decoration",
      "formula_without_explanatory_context",
      "no_formula_in_window",
    ]));
    expect(plan.accounting.formula_total).toBeGreaterThan(plan.accounting.formula_eligible);
    expect(plan.accounting.formula_skipped).toBe(plan.accounting.formula_total - plan.accounting.formula_eligible);
  });

  it("gives each grounded formula its own formula+explanation evidence packet", () => {
    const input = fixture();
    const plan = routeProfileSidecarWorkUnits({
      ...input,
      content_profile: input.profile,
      policy_fingerprint: input.policy,
    });
    const formulaPackets = Object.values(plan.packets).filter((packet) => packet.unit_kind === "profile_sidecar_formula");

    expect(formulaPackets).toHaveLength(3);
    expect(formulaPackets.every((packet) => packet.formula_lids.length === 1)).toBe(true);
    expect(formulaPackets.every((packet) => packet.visible_lids.includes(packet.formula_lids[0]))).toBe(true);
    expect(formulaPackets.every((packet) => packet.visible_lids.some((lid) => input.byLid.get(lid)?.kind === "paragraph"))).toBe(true);
    expect(formulaPackets.some((packet) => packet.text.includes("preceding equations share"))).toBe(true);
    expect(formulaPackets.every((packet) => packet.work_unit_id.startsWith("formula-"))).toBe(true);
  });

  it("binds stable semantic ids and freshness to only affected packet context", () => {
    const input = fixture();
    const original = routeProfileSidecarWorkUnits({
      ...input,
      content_profile: input.profile,
      policy_fingerprint: input.policy,
    });
    const repeated = routeProfileSidecarWorkUnits({
      ...input,
      content_profile: input.profile,
      policy_fingerprint: input.policy,
    });
    expect(repeated.plan_digest).toBe(original.plan_digest);

    const changedSource = input.source.replace("ordinary transition", "standard transition");
    expect(changedSource).toBe(input.source);
    const actualChangedSource = input.source.replace("no formula and", "no equation or");
    expect(actualChangedSource).toHaveLength(input.source.length);
    const changed = fixture(actualChangedSource);
    const mutated = routeProfileSidecarWorkUnits({
      ...changed,
      content_profile: changed.profile,
      policy_fingerprint: changed.policy,
    });
    const changedIds = original.work_units.filter((unit) =>
      mutated.work_units.some((next) => next.work_unit_id === unit.work_unit_id && next.input_hash !== unit.input_hash),
    ).map((unit) => unit.work_unit_id);
    expect(changedIds.length).toBeGreaterThan(0);
    expect(changedIds.every((id) => id.startsWith("discourse-") || id.startsWith("formula-"))).toBe(true);
  });

  it("enforces mutually exclusive discourse/formula output and keeps public artifact shapes", () => {
    const input = fixture();
    const plan = routeProfileSidecarWorkUnits({
      ...input,
      content_profile: input.profile,
      policy_fingerprint: input.policy,
    });
    const discoursePacket = Object.values(plan.packets).find((packet) => packet.unit_kind === "profile_sidecar_discourse")!;
    const formulaPacket = Object.values(plan.packets).find((packet) => packet.unit_kind === "profile_sidecar_formula")!;
    const discourseArtifact = buildProfileSidecarSemanticArtifact(discoursePacket, {
      discourse_items: [{ lid: discoursePacket.visible_lids[0], mode: "informative", relations: [] }],
    });
    const formulaArtifact = buildProfileSidecarSemanticArtifact(formulaPacket, {
      formula_semantics: [{
        formula_lid: formulaPacket.formula_lids[0],
        context_lids: formulaPacket.visible_lids.filter((lid) => lid !== formulaPacket.formula_lids[0]),
        composition: {
          source_lid: formulaPacket.formula_lids[0],
          meaning: "表达上下文给出的关系。",
          terms: [],
          evidence_lids: [formulaPacket.formula_lids[0]],
        },
      }],
    });

    expect(discourseArtifact).toMatchObject({ content_hash: discoursePacket.input_hash, formula_semantics: [] });
    expect(formulaArtifact).toMatchObject({ content_hash: formulaPacket.input_hash, discourse_items: [] });
    expect(() => buildProfileSidecarSemanticArtifact(discoursePacket, { formula_semantics: [] })).toThrow("discourse unit");
    expect(() => buildProfileSidecarSemanticArtifact(formulaPacket, { discourse_items: [] })).toThrow("formula unit");
  });

  it("tracks committed semantic packets independently from deterministic skips", () => {
    const input = fixture();
    const plan = routeProfileSidecarWorkUnits({
      ...input,
      content_profile: input.profile,
      policy_fingerprint: input.policy,
    });
    const first = plan.work_units.find((unit) => !unit.deterministic_skip)!;
    const status = computeProfileSidecarRoutingStatus(plan, new Map([[first.work_unit_id, { content_hash: first.input_hash }]]));

    expect(status.committed).toBe(1);
    expect(status.pending).toBe(status.eligible - 1);
    expect(status.skipped).toBeGreaterThan(0);
    expect(status.done_ids).toEqual([first.work_unit_id]);
  });

  it("keeps input/write/status/batch on one discourse/formula semantic plan", () => {
    const input = fixture();
    const plan = routeProfileSidecarWorkUnits({ ...input, content_profile: input.profile, policy_fingerprint: input.policy });
    const discourse = Object.values(plan.packets).find((packet) => packet.unit_kind === "profile_sidecar_discourse")!;
    const formula = Object.values(plan.packets).find((packet) => packet.unit_kind === "profile_sidecar_formula")!;
    const skippedId = Object.keys(plan.skips)[0];
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-sidecar-router-cli-"));
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const fixturePath = path.join(__dirname, "fixtures", "profile-sidecar-semantic-units.md");
    const run = (script: string, args: string[]) => spawnSync(
      process.execPath,
      [tsx, path.join(repoRoot, "skills", "build", script), fixturePath, ...args, "--content-profile", "technical_learning"],
      { cwd: root, encoding: "utf8" },
    );

    const discourseInput = run("profile-sidecar-input.ts", [discourse.work_unit_id]);
    expect(discourseInput.status, discourseInput.stderr).toBe(0);
    expect(discourseInput.stdout).toContain("unit_kind: profile_sidecar_discourse");
    const formulaInput = run("profile-sidecar-input.ts", [formula.work_unit_id]);
    expect(formulaInput.status, formulaInput.stderr).toBe(0);
    expect(formulaInput.stdout).toContain("unit_kind: profile_sidecar_formula");
    const skippedInput = run("profile-sidecar-input.ts", [skippedId]);
    expect(skippedInput.status).toBe(1);
    expect(skippedInput.stderr).toContain("not model-eligible");

    const discourseCandidate = path.join(root, "discourse.json");
    writeFileSync(discourseCandidate, JSON.stringify({
      discourse_items: [{ lid: discourse.visible_lids[0], mode: "informative", relations: [] }],
    }), "utf8");
    const discourseWrite = run("profile-sidecar-write.ts", [discourse.work_unit_id, discourseCandidate]);
    expect(discourseWrite.status, discourseWrite.stderr).toBe(0);

    const formulaCandidate = path.join(root, "formula.json");
    writeFileSync(formulaCandidate, JSON.stringify({
      formula_semantics: [{
        formula_lid: formula.formula_lids[0],
        context_lids: formula.visible_lids.filter((lid) => lid !== formula.formula_lids[0]),
        composition: {
          source_lid: formula.formula_lids[0],
          meaning: "表达上下文给出的关系。",
          terms: [],
          evidence_lids: [formula.formula_lids[0]],
        },
      }],
    }), "utf8");
    const formulaWrite = run("profile-sidecar-write.ts", [formula.work_unit_id, formulaCandidate]);
    expect(formulaWrite.status, formulaWrite.stderr).toBe(0);

    const status = run("profile-sidecar-status.ts", []);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("done=2");
    const batch = run("profile-sidecar-batch.ts", ["--allow-partial"]);
    expect(batch.status, batch.stderr).toBe(0);
    const discoursePath = path.join(root, ".understand-book", "profile-sidecar-semantic-units", "discourse_index.json");
    const formulaPath = path.join(root, ".understand-book", "profile-sidecar-semantic-units", "formula_semantics.json");
    expect(existsSync(discoursePath)).toBe(true);
    expect(existsSync(formulaPath)).toBe(true);
    expect(JSON.parse(readFileSync(discoursePath, "utf8")).items).toHaveLength(1);
    expect(JSON.parse(readFileSync(formulaPath, "utf8")).items).toHaveLength(1);
  }, 20_000);
});
