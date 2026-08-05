import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { markdownToBlocks } from "../src/md-adapter";
import { renderPaperLexiconModelInput } from "../src/model-input-renderer";
import {
  buildPaperLexiconCandidateArtifact,
  computePaperLexiconRoutingStatus,
  routePaperLexiconWorkUnits,
} from "../src/paper-lexicon-router";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";

function fixture(sourceOverride?: string, maxInputTokens = 320) {
  const sourcePath = path.join(__dirname, "fixtures", "paper-lexicon-routing.md");
  const source = sourceOverride ?? readFileSync(sourcePath, "utf8");
  const lidNodes = segment(markdownToBlocks(source));
  const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
  const windows = splitWindows(lidNodes, source);
  const resolved = resolveAutomaticBuildTarget(sourcePath, path.resolve(__dirname, "..", "..", ".."));
  const target = { ...resolved.target_ref, profile_id: "paper" as const };
  const policy = automaticBuildExtractionPolicy("paper_lexicon", resolveContentProfile("paper"), "full");
  return { source, lidNodes, byLid, windows, target, policy, maxInputTokens };
}

describe("paper lexicon candidate router", () => {
  it("clusters recurring terms and acronyms before budgeted batching", () => {
    const input = fixture();
    const plan = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const clusters = Object.values(plan.packets).flatMap((packet) => packet.candidate_clusters);
    const keys = new Set(clusters.map((cluster) => cluster.normalized_key));
    const gold = [
      "signal to noise ratio",
      "delta rule attention",
      "memorydataset",
      "retrieval accuracy",
      "softmax attention",
    ];
    const recalled = gold.filter((key) => keys.has(key));

    expect(recalled).toEqual(gold);
    expect(recalled.length / clusters.length).toBeGreaterThanOrEqual(0.6);
    expect(clusters.filter((cluster) => cluster.normalized_key === "signal to noise ratio")).toHaveLength(1);
    const snr = clusters.find((cluster) => cluster.normalized_key === "signal to noise ratio")!;
    expect(snr.surface_forms).toEqual(expect.arrayContaining(["Signal-to-Noise Ratio", "SNR"]));
    expect(snr.occurrence_lids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(snr.occurrence_lids).size).toBe(snr.occurrence_lids.length);
    expect(snr.definition_lids.length).toBeGreaterThanOrEqual(1);
  });

  it("uses stable non-window batch ids and never crosses the configured input budget", () => {
    const input = fixture();
    const first = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const second = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const batches = first.work_units.filter((unit) => !unit.deterministic_skip);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((unit) => unit.work_unit_id.startsWith("lexicon-batch-"))).toBe(true);
    expect(batches.every((unit) => !/^\d+$/.test(unit.work_unit_id))).toBe(true);
    expect(Object.values(first.packets).every((packet) => packet.estimated_input_tokens <= input.maxInputTokens)).toBe(true);
    expect(second.plan_digest).toBe(first.plan_digest);
    expect(second.work_units.map((unit) => unit.work_unit_id)).toEqual(first.work_units.map((unit) => unit.work_unit_id));
  });

  it("accounts no-candidate areas as skips and source-binds only affected work", () => {
    const input = fixture();
    const original = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const skips = original.work_units.filter((unit) => unit.deterministic_skip?.code === "no_lexicon_candidate");
    expect(skips.length).toBeGreaterThan(0);

    const changedSource = input.source.replace("ordinary transition", "standard transition");
    expect(changedSource).toHaveLength(input.source.length);
    const changed = fixture(changedSource);
    const mutated = routePaperLexiconWorkUnits({
      ...changed,
      policy_fingerprint: changed.policy,
      max_input_tokens: changed.maxInputTokens,
    });
    expect(mutated.work_units.filter((unit) => !unit.deterministic_skip).map((unit) => unit.work_unit_id))
      .toEqual(original.work_units.filter((unit) => !unit.deterministic_skip).map((unit) => unit.work_unit_id));
    const changedSkips = original.work_units.filter((unit) =>
      unit.deterministic_skip
      && mutated.work_units.some((next) => next.work_unit_id === unit.work_unit_id && next.input_hash !== unit.input_hash),
    );
    expect(changedSkips).toHaveLength(1);
  });

  it("gates model output to routed clusters and retains real occurrence evidence", () => {
    const input = fixture();
    const plan = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const packet = Object.values(plan.packets).find((candidate) =>
      candidate.candidate_clusters.some((cluster) => cluster.surface_forms.includes("SNR")),
    )!;
    const artifact = buildPaperLexiconCandidateArtifact(packet, input.lidNodes, {
      entries: [{ term: "SNR", term_type: "acronym", occurrences_lids: [packet.visible_lids[0]] }],
    });
    const snrCluster = packet.candidate_clusters.find((cluster) => cluster.surface_forms.includes("SNR"))!;

    expect(artifact.content_hash).toBe(packet.input_hash);
    expect(artifact.entries[0].occurrences_lids).toEqual(snrCluster.occurrence_lids);
    expect(() => buildPaperLexiconCandidateArtifact(packet, input.lidNodes, {
      entries: [{ term: "ordinary transition", term_type: "domain_term", occurrences_lids: [packet.visible_lids[0]] }],
    })).toThrow("lexicon candidate out of scope");
  });

  it("tracks committed batches independently from skipped windows", () => {
    const input = fixture();
    const plan = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const first = plan.work_units.find((unit) => !unit.deterministic_skip)!;
    const status = computePaperLexiconRoutingStatus(plan, new Map([[first.work_unit_id, { content_hash: first.input_hash }]]));

    expect(status.committed).toBe(1);
    expect(status.pending).toBe(status.eligible - 1);
    expect(status.skipped).toBeGreaterThan(0);
    expect(status.done_ids).toEqual([first.work_unit_id]);
    expect(status.pending_ids).not.toContain(first.work_unit_id);
  });

  it("keeps input/write/status/batch on the same cluster plan", () => {
    const input = fixture(undefined, 6_000);
    const plan = routePaperLexiconWorkUnits({ ...input, policy_fingerprint: input.policy });
    const packet = Object.values(plan.packets)[0];
    const cluster = packet.candidate_clusters[0];
    const skippedId = Object.keys(plan.skip_windows)[0];
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-lexicon-router-cli-"));
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const fixturePath = path.join(__dirname, "fixtures", "paper-lexicon-routing.md");
    const run = (script: string, args: string[]) => spawnSync(
      process.execPath,
      [tsx, path.join(repoRoot, "skills", "build", script), fixturePath, ...args, "--content-profile", "paper"],
      { cwd: root, encoding: "utf8" },
    );

    const emitted = run("paper-lexicon-input.ts", [packet.work_unit_id]);
    expect(emitted.status, emitted.stderr).toBe(0);
    expect(emitted.stdout).toBe(renderPaperLexiconModelInput(packet));
    expect(packet.rendered_input_sha256).toBe(createHash("sha256").update(emitted.stdout).digest("hex"));

    const skipped = run("paper-lexicon-input.ts", [skippedId]);
    expect(skipped.status).toBe(1);
    expect(skipped.stderr).toContain("not model-eligible");

    const candidatePath = path.join(root, "candidate.json");
    writeFileSync(candidatePath, JSON.stringify({ entries: [{
      term: cluster.surface_forms[0],
      term_type: cluster.suggested_term_types[0],
      occurrences_lids: [cluster.occurrence_lids[0]],
    }] }), "utf8");
    const written = run("paper-lexicon-write.ts", [packet.work_unit_id, candidatePath]);
    expect(written.status, written.stderr).toBe(0);

    const status = run("paper-lexicon-status.ts", []);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("done=1");

    const batch = run("paper-lexicon-batch.ts", ["--allow-partial"]);
    expect(batch.status, batch.stderr).toBe(0);
    expect(JSON.parse(batch.stdout)).toMatchObject({
      version: "automatic_build_stage_batch_result.v1",
      stage: "paper_lexicon",
      publication: { receipt_ref: expect.stringMatching(/receipt\.json$/u) },
    });
    const publicArtifact = path.join(root, ".understand-book", "paper-lexicon-routing", "paper_lexicon.json");
    expect(existsSync(publicArtifact)).toBe(true);
    const lexicon = JSON.parse(readFileSync(publicArtifact, "utf8"));
    expect(lexicon.entries).toHaveLength(1);
    expect(lexicon.entries[0].occurrences_lids).toEqual(cluster.occurrence_lids);
  }, 15_000);
});
