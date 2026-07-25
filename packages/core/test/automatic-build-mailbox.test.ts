import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  failAutomaticBuildTask,
  inspectAutomaticBuildTask,
  stageAutomaticBuildCandidate,
  submitAutomaticBuildCandidate,
} from "../src/automatic-build-mailbox";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { readAutomaticBuildAttemptRecord } from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-mailbox-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  const target = resolveAutomaticBuildTarget(source, root);
  const claim = claimAutomaticBuildTask(target, "pass1", "0", {
    owner: "mailbox-test",
    now: "2026-07-19T00:00:00.000Z",
    ttl_ms: 60_000,
  });
  if (claim.status !== "leased") throw new Error("expected lease");
  return { root, target, claim };
}

function candidateFile(root: string, value: unknown, name = "candidate-source.json"): string {
  const file = path.join(root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

describe("automatic build task mailbox", () => {
  it("normalizes no-BOM and single-BOM UTF-8 candidates to the same payload", () => {
    const noBom = fixture();
    const withBom = fixture();
    const payload = JSON.stringify({ nodes: [], edges: [] });
    const noBomSource = path.join(noBom.root, "candidate-no-bom.json");
    const bomSource = path.join(withBom.root, "candidate-bom.json");
    writeFileSync(noBomSource, Buffer.from(payload, "utf8"));
    writeFileSync(bomSource, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(payload, "utf8"),
    ]));

    const noBomRecord = stageAutomaticBuildCandidate(
      noBom.target,
      noBom.claim.lease_ref,
      noBom.claim.lease.token,
      noBomSource,
      { now: "2026-07-19T00:00:01.000Z" },
    );
    const bomRecord = stageAutomaticBuildCandidate(
      withBom.target,
      withBom.claim.lease_ref,
      withBom.claim.lease.token,
      bomSource,
      { now: "2026-07-19T00:00:01.000Z" },
    );

    expect(bomRecord.candidate_sha256).toBe(noBomRecord.candidate_sha256);
    expect(bomRecord.size_bytes).toBe(noBomRecord.size_bytes);
    expect(readFileSync(noBomRecord.candidate_path)).toEqual(Buffer.from(payload, "utf8"));
    expect(readFileSync(bomRecord.candidate_path)).toEqual(Buffer.from(payload, "utf8"));
  });

  it("rejects UTF-16 and non-BOM leading garbage", () => {
    const utf16 = fixture();
    const leadingGarbage = fixture();
    const payload = JSON.stringify({ nodes: [], edges: [] });
    const utf16Source = path.join(utf16.root, "candidate-utf16.json");
    const garbageSource = path.join(leadingGarbage.root, "candidate-leading-garbage.json");
    writeFileSync(utf16Source, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(payload, "utf16le"),
    ]));
    writeFileSync(garbageSource, `garbage${payload}`, "utf8");

    expect(() => stageAutomaticBuildCandidate(
      utf16.target,
      utf16.claim.lease_ref,
      utf16.claim.lease.token,
      utf16Source,
      { now: "2026-07-19T00:00:01.000Z" },
    )).toThrow("valid UTF-8 JSON");
    expect(() => stageAutomaticBuildCandidate(
      leadingGarbage.target,
      leadingGarbage.claim.lease_ref,
      leadingGarbage.claim.lease.token,
      garbageSource,
      { now: "2026-07-19T00:00:01.000Z" },
    )).toThrow("valid UTF-8 JSON");
  });

  it("stages only bounded valid JSON and rejects submit paths outside the attempt", () => {
    const { root, target, claim } = fixture();
    const invalid = path.join(root, "invalid.json");
    writeFileSync(invalid, "not json", "utf8");
    expect(() => stageAutomaticBuildCandidate(target, claim.lease_ref, claim.lease.token, invalid, {
      now: "2026-07-19T00:00:01.000Z",
    })).toThrow("valid JSON");

    const oversized = path.join(root, "oversized.json");
    writeFileSync(oversized, JSON.stringify({ value: "x".repeat(128) }), "utf8");
    expect(() => stageAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      oversized,
      { max_bytes: 32, now: "2026-07-19T00:00:01.000Z" },
    )).toThrow("exceeds");

    const source = candidateFile(root, { nodes: [], edges: [] });
    const staged = stageAutomaticBuildCandidate(target, claim.lease_ref, claim.lease.token, source, {
      now: "2026-07-19T00:00:01.000Z",
    });
    expect(path.dirname(staged.candidate_path)).toBe(path.dirname(claim.lease_ref));
    expect(() => submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      source,
      () => ({ artifact_path: path.join(root, "artifact.json") }),
      { now: "2026-07-19T00:00:02.000Z" },
    )).toThrow("candidate path");
  });

  it("does not record a submit revision for an expired lease", () => {
    const { root, target, claim } = fixture();
    const staged = stageAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      candidateFile(root, { nodes: [], edges: [] }),
      { now: "2026-07-19T00:00:01.000Z" },
    );
    expect(() => submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      () => ({ artifact_path: path.join(root, "artifact.json") }),
      { now: "2026-07-19T00:01:00.000Z" },
    )).toThrow("expired");
    expect(readAutomaticBuildAttemptRecord(target, "pass1", "0")).toMatchObject({ submit_revision: 0 });
  });

  it("commits once, replays the same receipt, and rejects changed candidate bytes", () => {
    const { root, target, claim } = fixture();
    const staged = stageAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      candidateFile(root, { nodes: [], edges: [] }),
      { now: "2026-07-19T00:00:01.000Z" },
    );
    const artifact = path.join(root, "artifact.json");
    let writes = 0;
    const writer = () => {
      writes += 1;
      writeFileSync(artifact, JSON.stringify({ content_hash: "hash-a", nodes: [], edges: [] }), "utf8");
      return { artifact_path: artifact, output_counts: { nodes: 0, edges: 0 } };
    };

    const first = submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      writer,
      { now: "2026-07-19T00:00:02.000Z" },
    );
    const second = submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      writer,
      { now: "2026-07-19T00:00:03.000Z" },
    );

    expect(second).toEqual(first);
    expect(writes).toBe(1);
    expect(readAutomaticBuildAttemptRecord(target, "pass1", "0")).toMatchObject({
      semantic_attempt: 1,
      lease_epoch: 1,
      submit_revision: 2,
    });
    expect(stageAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      path.join(root, "candidate-source.json"),
    ).candidate_sha256).toBe(staged.candidate_sha256);
    expect(first).toMatchObject({ state: "committed", candidate_sha256: staged.candidate_sha256 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4_096);
    expect(first).not.toHaveProperty("payload");
    expect(Object.values(first).some(Array.isArray)).toBe(false);

    writeFileSync(staged.candidate_path, JSON.stringify({ nodes: [{ id: "changed" }], edges: [] }), "utf8");
    expect(() => submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      writer,
      { now: "2026-07-19T00:00:04.000Z" },
    )).toThrow("candidate hash");
  });

  it("persists writer diagnostics, permits a controlled retry, and round-trips inspect/fail receipts", () => {
    const { root, target, claim } = fixture();
    const staged = stageAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      candidateFile(root, { nodes: [], edges: [] }),
      { now: "2026-07-19T00:00:01.000Z" },
    );
    expect(() => submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      () => { throw new Error("schema failure at /nodes"); },
      { now: "2026-07-19T00:00:02.000Z" },
    )).toThrow("schema failure");
    expect(inspectAutomaticBuildTask(target, claim.lease_ref, claim.lease.token)).toMatchObject({
      state: "retryable_failure",
      diagnostic_code: "writer_failed",
      candidate_sha256: staged.candidate_sha256,
    });

    const artifact = path.join(root, "artifact-after-retry.json");
    const receipt = submitAutomaticBuildCandidate(
      target,
      claim.lease_ref,
      claim.lease.token,
      staged.candidate_path,
      () => {
        writeFileSync(artifact, JSON.stringify({ content_hash: "hash-b" }), "utf8");
        return { artifact_path: artifact };
      },
      { now: "2026-07-19T00:00:03.000Z" },
    );
    expect(readAutomaticBuildAttemptRecord(target, "pass1", "0")).toMatchObject({
      semantic_attempt: 1,
      lease_epoch: 1,
      submit_revision: 2,
    });
    expect(inspectAutomaticBuildTask(target, claim.lease_ref, claim.lease.token)).toEqual(receipt);

    const other = fixture();
    const failed = failAutomaticBuildTask(
      other.target,
      other.claim.lease_ref,
      other.claim.lease.token,
      { diagnostic_code: "executor_failed", message: "provider unavailable", now: "2026-07-19T00:00:01.000Z" },
    );
    expect(failed).toMatchObject({ state: "retryable_failure", diagnostic_code: "executor_failed" });
    expect(JSON.parse(readFileSync(path.join(path.dirname(other.claim.lease_ref), "failure.json"), "utf8"))).toMatchObject({
      diagnostic_code: "executor_failed",
    });
  });
});
