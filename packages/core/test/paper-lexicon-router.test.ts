import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runAutomaticBuildStageWriter } from "../../../skills/build/automatic-build";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { markdownToBlocks } from "../src/md-adapter";
import { renderPaperLexiconModelInput } from "../src/model-input-renderer";
import {
  buildPaperLexiconCandidateArtifact,
  computePaperLexiconRoutingStatus,
  paperLexiconArtifactHash,
  PAPER_LEXICON_WORK_UNIT_SCOPE_DIGEST,
  routePaperLexiconWorkUnits,
  routePaperLexiconWorkUnitsWithRecovery,
} from "../src/paper-lexicon-router";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";

function fixture(sourceOverride?: string, maxInputTokens = 600) {
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

  it("keeps a parameterized metric symbol separate from a following predicate phrase", () => {
    const source = [
      "# Metrics",
      "Distinct-n complements overlap metrics when evaluating generation diversity.",
      "Across all systems, Distinct-n complements overlap metrics without duplicating their signal.",
    ].join("\n\n");
    const input = fixture(source);
    const plan = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    expect(input.policy).toMatchObject({
      stage_policy_version: "paper_lexicon_policy.v2",
      router_version: "paper_lexicon_cluster.v4",
    });
    const clusters = Object.values(plan.packets).flatMap((packet) => packet.candidate_clusters);
    const distinctN = clusters.find((cluster) => cluster.normalized_key === "distinct n");

    expect(distinctN).toMatchObject({
      surface_forms: ["Distinct-n"],
      signals: expect.arrayContaining(["named_symbol"]),
      suggested_term_types: expect.arrayContaining(["metric_name"]),
    });
    expect(clusters.some((cluster) =>
      cluster.normalized_key === "distinct n complements overlap metrics",
    )).toBe(false);

    const packet = Object.values(plan.packets).find((candidate) =>
      candidate.candidate_clusters.some((cluster) => cluster.normalized_key === "distinct n"),
    )!;
    const legacyWorkUnitId = `lexicon-batch-${createHash("sha256")
      .update(packet.candidate_clusters.map((cluster) => cluster.normalized_key).join("\n"))
      .digest("hex")
      .slice(0, 16)}`;
    expect(packet.work_unit_id).not.toBe(legacyWorkUnitId);
    expect(packet.work_unit_id).toMatch(/^lexicon-batch-[a-f0-9]{64}-[a-f0-9]{16}$/u);
    expect(plan.work_units.every((unit) =>
      unit.work_unit_id.includes(`-${PAPER_LEXICON_WORK_UNIT_SCOPE_DIGEST}-`),
    )).toBe(true);
  });

  it("reconciles one source-backed clause-prefix term without opening substring matching", () => {
    const source = [
      "# Metrics",
      "Distinct-n complements overlap metrics when evaluating generation diversity.",
    ].join("\n\n");
    const input = fixture(source);
    const basePlan = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const basePacket = Object.values(basePlan.packets)[0];
    const occurrenceLid = basePacket.visible_lids[0];
    const legacyPacket = {
      ...basePacket,
      route: {
        version: "paper_lexicon_packet_route.v1" as const,
        role: "direct" as const,
        cluster_keys: ["distinct n complements overlap metrics"],
      },
      candidate_clusters: [{
        version: "paper_lexicon_candidate_cluster.v1" as const,
        normalized_key: "distinct n complements overlap metrics",
        surface_forms: ["Distinct-n complements overlap metrics"],
        occurrence_lids: [occurrenceLid],
        definition_lids: [],
        signals: ["technical_phrase" as const],
        suggested_term_types: ["metric_name" as const],
      }],
      visible_lids: [occurrenceLid],
    };

    const artifact = buildPaperLexiconCandidateArtifact(legacyPacket, input.lidNodes, {
      entries: [{ term: "Distinct-n", term_type: "metric_name", occurrences_lids: [occurrenceLid] }],
    });

    expect(artifact.entries).toHaveLength(1);
    expect(artifact.entries[0].term).toBe("Distinct-n");
    expect(artifact.warnings).toEqual([{
      version: "paper_lexicon_artifact_warning.v1",
      code: "candidate_reconciled",
      count: 1,
    }]);
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
    expect(Object.values(first.packets).every((packet) =>
      packet.input_budget_proof.prompt_sha256 === input.policy.prompt_sha256,
    )).toBe(true);
    expect(second.plan_digest).toBe(first.plan_digest);
    expect(second.work_units.map((unit) => unit.work_unit_id)).toEqual(first.work_units.map((unit) => unit.work_unit_id));
  });

  it("routes one oversized candidate cluster through exact-cover lexicon fragments", () => {
    const repeatedContext = "bounded retrieval context ".repeat(180);
    const source = [
      "# Study",
      `We define Adaptive Retrieval Architecture (ARA) as a retrieval model. ${repeatedContext}`,
      `Adaptive Retrieval Architecture (ARA) preserves evidence. ${repeatedContext}`,
      `Adaptive Retrieval Architecture (ARA) improves recall. ${repeatedContext}`,
    ].join("\n\n");
    const input = fixture(source, 420);
    const routed = routePaperLexiconWorkUnitsWithRecovery({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });

    expect(routed.status).toBe("ready");
    if (routed.status !== "ready") throw new Error("synthetic lexicon cluster should be safely splittable");
    const fragments = Object.values(routed.value.packets).filter((packet) =>
      packet.route.role === "fragment"
      && packet.candidate_clusters.some((cluster) => cluster.normalized_key === "adaptive retrieval architecture"),
    );

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.every((packet) =>
      packet.work_unit_id.startsWith(`lexicon-fragment-${PAPER_LEXICON_WORK_UNIT_SCOPE_DIGEST}-`),
    )).toBe(true);
    expect(fragments.every((packet) => packet.estimated_rendered_tokens <= input.maxInputTokens)).toBe(true);
    expect(fragments.every((packet) => packet.source_slices.length > 0)).toBe(true);
    expect(fragments.flatMap((packet) => packet.source_slices).every((slice) =>
      slice.version === "model_input_slice.v1" && slice.source_fingerprint.length === 64,
    )).toBe(true);
    const slicesByLid = new Map<string, (typeof fragments)[number]["source_slices"]>();
    for (const slice of fragments.flatMap((packet) => packet.source_slices)) {
      const slices = slicesByLid.get(slice.parent_lid) ?? [];
      slices.push(slice);
      slicesByLid.set(slice.parent_lid, slices);
    }
    for (const [lid, slices] of slicesByLid) {
      const parent = input.byLid.get(lid)!;
      const ordered = [...slices].sort((left, right) => left.core_span_utf16.start - right.core_span_utf16.start);
      expect(ordered[0].core_span_utf16.start).toBe(parent.span.start);
      expect(ordered.at(-1)!.core_span_utf16.end).toBe(parent.span.end);
      for (let index = 1; index < ordered.length; index += 1) {
        expect(ordered[index].core_span_utf16.start).toBe(ordered[index - 1].core_span_utf16.end);
      }
      expect(ordered.every((slice) => slice.core_sha256 === createHash("sha256")
        .update(input.source.slice(slice.core_span_utf16.start, slice.core_span_utf16.end))
        .digest("hex"))).toBe(true);
    }
  });

  it("returns structured model_input_unsplittable when renderer overhead cannot fit", () => {
    const input = fixture(undefined, 1);
    const routed = routePaperLexiconWorkUnitsWithRecovery({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });

    expect(routed).toMatchObject({
      status: "blocked",
      recovery: {
        version: "automatic_build_recovery.v1",
        phase: "routing",
        code: "model_input_unsplittable",
        stage: "paper_lexicon",
        retryable: false,
      },
    });
  });

  it("binds a lexicon reducer to fragment artifact hashes and emits one final cluster entry", () => {
    const repeatedContext = "bounded retrieval context ".repeat(30);
    const source = [
      "# Study",
      `We define Adaptive Retrieval Architecture (ARA) as a retrieval model. ${repeatedContext}`,
      `Adaptive Retrieval Architecture (ARA) preserves evidence. ${repeatedContext}`,
      `Adaptive Retrieval Architecture (ARA) improves recall. ${repeatedContext}`,
    ].join("\n\n");
    const input = fixture(source, 600);
    const initial = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
    });
    const fragments = Object.values(initial.packets).filter((packet) =>
      packet.route.role === "fragment"
      && packet.route.cluster_keys[0] === "adaptive retrieval architecture",
    );
    const existingArtifacts = new Map(fragments.map((packet, index) => {
      const artifact = buildPaperLexiconCandidateArtifact(packet, input.lidNodes, {
        entries: [{
          term: "ARA",
          term_type: index % 2 ? "model_name" : "acronym",
          occurrences_lids: [packet.visible_lids[0]],
        }],
      });
      expect(artifact.entries[0].occurrences_lids).toEqual([packet.visible_lids[0]]);
      return [packet.work_unit_id, { artifact_hash: paperLexiconArtifactHash(artifact), artifact }];
    }));
    const reduced = routePaperLexiconWorkUnits({
      ...input,
      policy_fingerprint: input.policy,
      max_input_tokens: input.maxInputTokens,
      existing_artifacts: existingArtifacts,
    });
    const reducer = Object.values(reduced.packets).find((packet) =>
      packet.route.role === "reduce"
      && packet.route.cluster_keys[0] === "adaptive retrieval architecture",
    )!;
    const reducerUnit = reduced.work_units.find((unit) => unit.work_unit_id === reducer.work_unit_id)!;

    expect(reducer.work_unit_id.startsWith(
      `lexicon-reduce-${PAPER_LEXICON_WORK_UNIT_SCOPE_DIGEST}-`,
    )).toBe(true);
    expect(reducer.reduction_children.map((child) => child.artifact_hash))
      .toEqual([...existingArtifacts.values()].map((artifact) => artifact.artifact_hash));
    expect(reducerUnit.dependencies).toEqual(reducer.reduction_children.map((child) => ({
      artifact: child.work_unit_id,
      sha256: child.artifact_hash,
    })).sort((left, right) => left.artifact.localeCompare(right.artifact)));
    const final = buildPaperLexiconCandidateArtifact(reducer, input.lidNodes, {
      entries: [{ term: "ARA", term_type: "model_name", occurrences_lids: [reducer.visible_lids[0]] }],
    });
    expect(final.route).toMatchObject({ role: "reduce", final: true });
    expect(final.entries).toHaveLength(1);
    const overfull = buildPaperLexiconCandidateArtifact(reducer, input.lidNodes, {
      entries: [
        { term: "ARA", term_type: "model_name", occurrences_lids: [reducer.visible_lids[0]] },
        { term: "Adaptive Retrieval Architecture", term_type: "acronym", occurrences_lids: [reducer.visible_lids[0]] },
      ],
    });
    expect(overfull.entries).toEqual([]);
    expect(overfull.warnings).toEqual([{
      version: "paper_lexicon_artifact_warning.v1",
      code: "candidate_rejected",
      count: 2,
    }]);
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
    const partiallyAccepted = buildPaperLexiconCandidateArtifact(packet, input.lidNodes, {
      entries: [
        { term: "SNR", term_type: "acronym", occurrences_lids: [packet.visible_lids[0]] },
        { term: "ordinary transition", term_type: "domain_term", occurrences_lids: [packet.visible_lids[0]] },
      ],
    });
    expect(partiallyAccepted.entries).toHaveLength(1);
    expect(partiallyAccepted.entries[0].term).toBe("SNR");
    expect(partiallyAccepted.warnings).toEqual([{
      version: "paper_lexicon_artifact_warning.v1",
      code: "candidate_rejected",
      count: 1,
    }]);

    const fullyRejected = buildPaperLexiconCandidateArtifact(packet, input.lidNodes, {
      entries: [{ term: "ordinary transition", term_type: "domain_term", occurrences_lids: [packet.visible_lids[0]] }],
    });
    expect(fullyRejected.entries).toEqual([]);
    expect(fullyRejected.warnings).toEqual([{
      version: "paper_lexicon_artifact_warning.v1",
      code: "candidate_rejected",
      count: 1,
    }]);
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

  it("projects bounded artifact warnings from the stage writer without candidate text", () => {
    const input = fixture(undefined, 6_000);
    const plan = routePaperLexiconWorkUnits({ ...input, policy_fingerprint: input.policy });
    const packet = Object.values(plan.packets)[0];
    const cluster = packet.candidate_clusters[0];
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-lexicon-warning-"));
    const fixturePath = path.join(__dirname, "fixtures", "paper-lexicon-routing.md");
    const resolved = resolveAutomaticBuildTarget(fixturePath, root);
    const target = {
      ...resolved,
      profile_id: "paper" as const,
      target_ref: { ...resolved.target_ref, profile_id: "paper" as const },
    };
    const candidatePath = path.join(root, "candidate-with-warning.json");
    const privateRejectedTerm = "PRIVATE_OUT_OF_SCOPE_TERM";
    writeFileSync(candidatePath, JSON.stringify({ entries: [
      {
        term: cluster.surface_forms[0],
        term_type: cluster.suggested_term_types[0],
        occurrences_lids: [cluster.occurrence_lids[0]],
      },
      {
        term: privateRejectedTerm,
        term_type: "domain_term",
        occurrences_lids: [cluster.occurrence_lids[0]],
      },
    ] }), "utf8");

    const result = runAutomaticBuildStageWriter(
      target,
      "paper_lexicon",
      packet.work_unit_id,
      candidatePath,
    );

    expect(result.writer_warnings).toEqual({ paper_lexicon_candidate_rejected: 1 });
    expect(JSON.stringify(result)).not.toContain(privateRejectedTerm);
    expect(readFileSync(result.artifact_path, "utf8")).not.toContain(privateRejectedTerm);
  }, 30_000);

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
    writeFileSync(candidatePath, JSON.stringify({ entries: [
      {
        term: cluster.surface_forms[0],
        term_type: cluster.suggested_term_types[0],
        occurrences_lids: [cluster.occurrence_lids[0]],
      },
      {
        term: "out-of-scope private candidate",
        term_type: "domain_term",
        occurrences_lids: [cluster.occurrence_lids[0]],
      },
    ] }), "utf8");
    const written = run("paper-lexicon-write.ts", [packet.work_unit_id, candidatePath]);
    expect(written.status, written.stderr).toBe(0);
    const committed = JSON.parse(readFileSync(path.join(
      root,
      ".understand-book",
      "paper-lexicon-routing",
      ".build",
      "paper-lexicon",
      `${packet.work_unit_id}.json`,
    ), "utf8"));
    expect(committed.warnings).toEqual([{
      version: "paper_lexicon_artifact_warning.v1",
      code: "candidate_rejected",
      count: 1,
    }]);

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
  }, 30_000);
});
