import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { markdownToBlocks } from "../src/md-adapter";
import { renderPaperMetadataModelInput } from "../src/model-input-renderer";
import {
  computePaperMetadataRoutingStatus,
  routePaperMetadataWorkUnits,
} from "../src/paper-metadata-router";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";

function fixture(sourceOverride?: string) {
  const sourcePath = path.join(__dirname, "fixtures", "paper-metadata-routing.md");
  const source = sourceOverride ?? readFileSync(sourcePath, "utf8");
  const lidNodes = segment(markdownToBlocks(source));
  const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
  const windows = splitWindows(lidNodes, source);
  const resolved = resolveAutomaticBuildTarget(sourcePath, path.resolve(__dirname, "..", "..", ".."));
  const target = { ...resolved.target_ref, profile_id: "paper" as const };
  const policy = automaticBuildExtractionPolicy("paper_metadata", resolveContentProfile("paper"), "full");
  return { source, lidNodes, byLid, windows, target, policy };
}

describe("paper metadata candidate router", () => {
  it("reduces model work by at least 80% while keeping every metadata signal represented", () => {
    const input = fixture();
    const plan = routePaperMetadataWorkUnits({
      target: input.target,
      windows: input.windows,
      byLid: input.byLid,
      source: input.source,
      policy_fingerprint: input.policy,
    });
    const eligible = plan.work_units.filter((unit) => !unit.deterministic_skip);

    expect(input.windows).toHaveLength(20);
    expect(eligible.length).toBeLessThanOrEqual(Math.floor(input.windows.length * 0.2));
    expect(Object.values(plan.packets).flatMap((packet) => packet.signal_types)).toEqual(expect.arrayContaining([
      "front_matter",
      "bibliography_ambiguous",
      "dataset",
      "code_link",
      "funding",
      "identifier",
    ]));
    expect(Object.values(plan.packets).flatMap((packet) => packet.requested_fields)).toEqual(expect.arrayContaining([
      "title",
      "authors",
      "references",
      "datasets",
      "code_links",
      "funding",
      "identifiers.doi",
    ]));
  });

  it("parses structured bibliography entries deterministically and routes only ambiguous entries", () => {
    const input = fixture();
    const plan = routePaperMetadataWorkUnits({
      target: input.target,
      windows: input.windows,
      byLid: input.byLid,
      source: input.source,
      policy_fingerprint: input.policy,
    });
    const references = plan.deterministic_metadata.references;

    expect(references?.value).toEqual([{
      raw: "[1] Ada Example and Lin Sample. Deterministic routing for scholarly records. Journal of Synthetic Fixtures, 2024.",
    }]);
    expect(references?.source).toBe("paper_text");
    expect(references?.evidence_lids).toHaveLength(2);
    const bibliographyPacket = Object.values(plan.packets).find((packet) => packet.signal_types.includes("bibliography_ambiguous"));
    expect(bibliographyPacket).toMatchObject({ requested_fields: ["references"] });
    expect(bibliographyPacket?.text).toContain("[2] Incomplete citation fragment");

    const structuredLids = new Set(references?.evidence_lids);
    const structuredOnlyUnit = plan.work_units.find((unit) =>
      unit.deterministic_skip?.code === "deterministic_metadata_extracted"
      && unit.evidence_lids.some((lid) => structuredLids.has(lid)),
    );
    expect(structuredOnlyUnit).toBeDefined();
  });

  it("records no-signal skips, stable digests, and source-bound unit freshness", () => {
    const input = fixture();
    const original = routePaperMetadataWorkUnits({
      target: input.target,
      windows: input.windows,
      byLid: input.byLid,
      source: input.source,
      policy_fingerprint: input.policy,
    });
    const repeated = routePaperMetadataWorkUnits({
      target: input.target,
      windows: input.windows,
      byLid: input.byLid,
      source: input.source,
      policy_fingerprint: input.policy,
    });
    expect(repeated.plan_digest).toBe(original.plan_digest);
    expect(original.work_units.filter((unit) => unit.deterministic_skip?.code === "no_metadata_signal").length).toBeGreaterThan(0);

    const changedSource = input.source.replace("ordinary intermediate", "standard intermediate");
    expect(changedSource).toHaveLength(input.source.length);
    const changed = fixture(changedSource);
    const mutated = routePaperMetadataWorkUnits({
      target: changed.target,
      windows: changed.windows,
      byLid: changed.byLid,
      source: changed.source,
      policy_fingerprint: changed.policy,
    });
    const changedIds = original.work_units
      .filter((unit, index) => unit.input_hash !== mutated.work_units[index]?.input_hash)
      .map((unit) => unit.work_unit_id);
    expect(changedIds).toHaveLength(1);
    expect(mutated.plan_digest).not.toBe(original.plan_digest);
  });

  it("accounts eligible, committed, pending, and skipped units without fake artifacts", () => {
    const input = fixture();
    const plan = routePaperMetadataWorkUnits({
      target: input.target,
      windows: input.windows,
      byLid: input.byLid,
      source: input.source,
      policy_fingerprint: input.policy,
    });
    const first = plan.work_units.find((unit) => !unit.deterministic_skip)!;
    const status = computePaperMetadataRoutingStatus(plan, new Map([[Number(first.work_unit_id), { content_hash: first.input_hash }]]));

    expect(status).toMatchObject({
      total: 20,
      eligible: 4,
      committed: 1,
      pending: 3,
      skipped: 16,
      done_ids: [Number(first.work_unit_id)],
    });
    expect(status.pending_ids).not.toContain(Number(first.work_unit_id));
  });

  it("keeps input/write/status/batch on the same routed eligibility and deterministic merge", () => {
    const routedInput = fixture();
    const routed = routePaperMetadataWorkUnits({ ...routedInput, policy_fingerprint: routedInput.policy });
    const routedPacket = routed.packets["0"];
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-metadata-router-cli-"));
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const fixturePath = path.join(__dirname, "fixtures", "paper-metadata-routing.md");
    const run = (script: string, args: string[]) => spawnSync(
      process.execPath,
      [tsx, path.join(repoRoot, "skills", "build", script), fixturePath, ...args, "--content-profile", "paper"],
      { cwd: root, encoding: "utf8" },
    );

    const input = run("paper-metadata-input.ts", ["0"]);
    expect(input.status, input.stderr).toBe(0);
    expect(input.stdout).toBe(renderPaperMetadataModelInput(routedPacket));
    expect(routedPacket.rendered_input_sha256).toBe(createHash("sha256").update(input.stdout).digest("hex"));

    const skippedInput = run("paper-metadata-input.ts", ["1"]);
    expect(skippedInput.status).toBe(1);
    expect(skippedInput.stderr).toContain("not model-eligible: no_metadata_signal");

    const candidatePath = path.join(root, "candidate.json");
    writeFileSync(candidatePath, "{}", "utf8");
    const skippedWrite = run("paper-metadata-write.ts", ["1", candidatePath]);
    expect(skippedWrite.status).toBe(1);
    expect(skippedWrite.stderr).toContain("not model-eligible: no_metadata_signal");

    const status = run("paper-metadata-status.ts", []);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("eligible=4  skipped=16  done=0  pending=4");

    const batch = run("paper-metadata-batch.ts", ["--allow-partial"]);
    expect(batch.status, batch.stderr).toBe(0);
    expect(JSON.parse(batch.stdout)).toMatchObject({
      version: "automatic_build_stage_batch_result.v1",
      stage: "paper_metadata",
      publication: {
        transaction_id: expect.stringMatching(/^[a-f0-9]{64}$/u),
        receipt_ref: expect.stringMatching(/receipt\.json$/u),
      },
    });
    expect(batch.stderr).toContain("deterministic_references=1");
    const publicArtifact = path.join(root, ".understand-book", "paper-metadata-routing", "paper_metadata.json");
    expect(existsSync(publicArtifact)).toBe(true);
    const metadata = JSON.parse(readFileSync(publicArtifact, "utf8"));
    expect(metadata.references.value).toHaveLength(1);
    expect(metadata.references.value[0].raw).toContain("Deterministic routing for scholarly records");
  }, 15_000);
});
