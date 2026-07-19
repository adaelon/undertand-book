import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import { automaticBuildUsageReceiptPath } from "../src/automatic-build-metrics";
import {
  automaticBuildExtractionPolicy,
  buildSemanticArtifactEnvelope,
  inspectSemanticArtifact,
  semanticArtifactMatches,
  semanticArtifactPayload,
} from "../src/semantic-artifact";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { SemanticArtifactEnvelopeV2Z } from "../src/zod";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-policy-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  return { root, target: resolveAutomaticBuildTarget(source, root) };
}

describe("automatic build policy-bound semantic artifacts", () => {
  it("makes every policy field part of freshness while keeping legacy payloads readable", () => {
    const { target } = fixture();
    const policy = automaticBuildExtractionPolicy("pass1", resolveContentProfile("technical_learning"), "full");
    const payload = { content_hash: "input-a", nodes: [], edges: [] };
    const envelope = buildSemanticArtifactEnvelope({
      target: target.target_ref,
      stage: "pass1",
      work_unit_id: "0",
      input_hash: "input-a",
      policy_fingerprint: policy,
      provenance: {
        executor: "codex-harness",
        model: "gpt-5.4-codex",
        attempt: 1,
        generated_at: "2026-07-19T00:00:00.000Z",
      },
      payload,
    });
    const expected = {
      target: target.target_ref,
      stage: "pass1" as const,
      work_unit_id: "0",
      input_hash: "input-a",
      policy_fingerprint: policy,
    };

    expect(SemanticArtifactEnvelopeV2Z.parse(envelope)).toEqual(envelope);
    expect(semanticArtifactMatches(envelope, expected)).toBe(true);
    const mutations = [
      { profile_id: "paper" },
      { profile_version: "technical_learning_v999" },
      { stage_policy_version: "pass1_policy.v999" },
      { router_version: "pass1_window.v999" },
      { prompt_sha256: "f".repeat(64) },
      { schema_version: "pass1_output.v999" },
      { quality_profile: "balanced" as const },
    ];
    for (const mutation of mutations) {
      expect(semanticArtifactMatches(envelope, {
        ...expected,
        policy_fingerprint: { ...policy, ...mutation },
      }), JSON.stringify(mutation)).toBe(false);
    }

    expect(inspectSemanticArtifact(payload, expected)).toEqual({
      format: "legacy_v1",
      policy_fresh: false,
      payload,
    });
    expect(semanticArtifactPayload(envelope)).toEqual(payload);
    expect(semanticArtifactPayload(payload)).toEqual(payload);
  });

  it("produces stable payload digests and records concrete model provenance", () => {
    const { target } = fixture();
    const policy = automaticBuildExtractionPolicy("paper_metadata", resolveContentProfile("paper"), "full");
    const input = {
      target: target.target_ref,
      stage: "paper_metadata" as const,
      work_unit_id: "3",
      input_hash: "input-b",
      policy_fingerprint: policy,
      payload: { content_hash: "input-b", metadata: { title: "Example" } },
    };
    const first = buildSemanticArtifactEnvelope({
      ...input,
      provenance: { executor: "codex-harness", model: "codex-test", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
    });
    const second = buildSemanticArtifactEnvelope({
      ...input,
      provenance: { executor: "codex-harness", model: "gpt-5.4-codex", attempt: 2, generated_at: "2026-07-19T00:01:00.000Z" },
    });
    expect(second.artifact_hash).toBe(first.artifact_hash);
    expect(second.provenance.model).toBe("gpt-5.4-codex");
    expect(() => buildSemanticArtifactEnvelope({
      ...input,
      provenance: { executor: "external-provider", model: "external-provider/model", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
    })).toThrow("model is not allowed");
  });

  it("freezes the quality policy on first claim and rejects in-place drift", () => {
    const { target } = fixture();
    const profile = resolveContentProfile("technical_learning");
    const full = automaticBuildExtractionPolicy("pass1", profile, "full");
    const balanced = automaticBuildExtractionPolicy("pass1", profile, "balanced");
    expect(claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "policy-full",
      now: "2026-07-19T00:00:00.000Z",
      ttl_ms: 60_000,
      binding: { input_hash: "input-0", policy_fingerprint: full },
    }).status).toBe("leased");
    expect(() => claimAutomaticBuildTask(target, "pass1", "1", {
      owner: "policy-balanced",
      now: "2026-07-19T00:00:01.000Z",
      ttl_ms: 60_000,
      binding: { input_hash: "input-1", policy_fingerprint: balanced },
    })).toThrow("policy_mismatch");
  });

  it("wraps a deterministic writer artifact at the mailbox boundary", () => {
    const { root, target } = fixture();
    const policy = automaticBuildExtractionPolicy("pass1", resolveContentProfile("technical_learning"), "full");
    const claimed = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "codex-harness",
      now: "2026-07-19T00:00:00.000Z",
      ttl_ms: 60_000,
      binding: { input_hash: "input-a", policy_fingerprint: policy },
    });
    if (claimed.status !== "leased") throw new Error("expected lease");
    const candidate = path.join(path.dirname(claimed.lease_ref), "candidate.json");
    writeFileSync(candidate, JSON.stringify({ nodes: [], edges: [] }), "utf8");
    writeFileSync(automaticBuildUsageReceiptPath(claimed.lease_ref), JSON.stringify({
      version: "automatic_build_usage_receipt.v1",
      source: "native",
      model: "gpt-5.4-codex",
      input_tokens: 10,
      output_tokens: 2,
    }), "utf8");
    const artifact = path.join(root, "artifact.json");
    const receipt = submitAutomaticBuildCandidate(target, claimed.lease_ref, claimed.lease.token, candidate, () => {
      writeFileSync(artifact, JSON.stringify({ content_hash: "input-a", nodes: [], edges: [] }), "utf8");
      return { artifact_path: artifact };
    }, { now: "2026-07-19T00:00:02.000Z" });
    const stored = JSON.parse(readFileSync(artifact, "utf8"));

    expect(stored).toMatchObject({
      version: "semantic_task_artifact.v2",
      input_hash: "input-a",
      policy_fingerprint: policy,
      provenance: { executor: "codex-harness", model: "gpt-5.4-codex", attempt: 1 },
      payload: { content_hash: "input-a", nodes: [], edges: [] },
    });
    expect(semanticArtifactMatches(stored, {
      target: target.target_ref,
      stage: "pass1",
      work_unit_id: "0",
      input_hash: "input-a",
      policy_fingerprint: policy,
    })).toBe(true);
    expect(receipt.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
