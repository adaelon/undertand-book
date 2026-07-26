import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertActiveAutomaticBuildLease,
  claimAutomaticBuildTask,
  heartbeatAutomaticBuildLease,
  startAutomaticBuildLease,
} from "../src/automatic-build-lease";
import {
  automaticBuildTaskAttemptDirectory,
  recordAutomaticBuildAttemptEvent,
} from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { automaticBuildNext, automaticBuildPlan, type AutomaticBuildNextOptions } from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";

const T0 = "2026-07-19T00:00:00.000Z";

function targetFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-lease-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  return { root, source, target: resolveAutomaticBuildTarget(source, root) };
}

function acceptedNext(source: string, root: string, options: AutomaticBuildNextOptions) {
  const buildPlan = options.build_plan ?? confirmedStandardBuildPlan(source, root);
  const plan = automaticBuildPlan(source, root, {
    requested_workers: 1,
    quality_profile: options.quality_profile,
    build_plan: buildPlan,
  });
  if (!plan.preflight) throw new Error("expected lease preflight");
  return automaticBuildNext(source, root, 1, {
    protocol: "automatic_build_protocol.v2",
    ...options,
    build_plan: buildPlan,
    accepted_plan_digest: plan.preflight.plan_digest,
  });
}

describe("automatic build task lease", () => {
  it("uses independent ten minute reservation and thirty minute run defaults", () => {
    const { target } = targetFixture();
    const claim = claimAutomaticBuildTask(target, "pass1", "0", { owner: "owner-a", now: T0 });
    if (claim.status !== "leased") throw new Error("expected reserved lease");
    expect(claim.lease).toMatchObject({
      version: "automatic_build_task_lease.v2",
      phase: "reserved",
      reserve_expires_at: "2026-07-19T00:10:00.000Z",
    });
    expect(startAutomaticBuildLease(target, claim.lease_ref, claim.lease.token, {
      now: "2026-07-19T00:01:00.000Z",
    })).toMatchObject({
      phase: "running",
      run_expires_at: "2026-07-19T00:31:00.000Z",
    });
  });

  it("does not count an empty crashed attempt directory as a lease epoch", () => {
    const { target } = targetFixture();
    mkdirSync(automaticBuildTaskAttemptDirectory(target, "pass1", "0", 1), { recursive: true });
    const claim = claimAutomaticBuildTask(target, "pass1", "0", { owner: "owner-a", now: T0, ttl_ms: 1_000 });
    if (claim.status !== "leased") throw new Error("expected lease after empty directory");
    expect(claim.lease.attempt).toBe(2);
    expect(claim.execution_identity).toMatchObject({ semantic_attempt: 1, lease_epoch: 1 });
  });

  it("gives one owner the atomic claim and keeps competitors on the same attempt", async () => {
    const { target } = targetFixture();
    const claims = await Promise.all(["owner-a", "owner-b", "owner-c"].map((owner) => new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(claimAutomaticBuildTask(target, "pass1", "0", { owner, now: T0, ttl_ms: 30_000 }));
        } catch (error) {
          reject(error);
        }
      });
    })));

    const leased = claims.filter((claim) => (claim as { status: string }).status === "leased") as Array<{ lease: { attempt: number } }>;
    expect(leased).toHaveLength(1);
    expect(leased[0].lease.attempt).toBe(1);
    expect(claims[0]).toMatchObject({
      execution_identity: { semantic_attempt: 1, lease_epoch: 1, submit_revision: 0 },
    });
    expect(claims.filter((claim) => (claim as { status: string }).status === "already_leased")).toHaveLength(2);
  });

  it("honors heartbeat and expiry boundaries and rejects the stale token", () => {
    const { target } = targetFixture();
    const first = claimAutomaticBuildTask(target, "pass1", "0", { owner: "owner-a", now: T0, ttl_ms: 1_000 });
    if (first.status !== "leased") throw new Error("expected initial lease");

    expect(() => heartbeatAutomaticBuildLease(target, first.lease_ref, first.lease.token, {
      now: "2026-07-19T00:00:00.999Z",
      ttl_ms: 1_000,
    })).toThrow("running");
    startAutomaticBuildLease(target, first.lease_ref, first.lease.token, {
      now: "2026-07-19T00:00:00.999Z",
      run_ttl_ms: 1_000,
    });
    heartbeatAutomaticBuildLease(target, first.lease_ref, first.lease.token, {
      now: "2026-07-19T00:00:01.000Z",
      ttl_ms: 1_000,
    });
    expect(assertActiveAutomaticBuildLease(
      target,
      first.lease_ref,
      first.lease.token,
      "2026-07-19T00:00:01.999Z",
    ).attempt).toBe(1);
    expect(() => assertActiveAutomaticBuildLease(
      target,
      first.lease_ref,
      first.lease.token,
      "2026-07-19T00:00:02.000Z",
    )).toThrow("expired");

    const recovered = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "owner-b",
      now: "2026-07-19T00:00:02.001Z",
      ttl_ms: 1_000,
    });
    if (recovered.status !== "leased") throw new Error("expected recovered lease");
    expect(recovered.lease.attempt).toBe(2);
    expect(recovered.execution_identity).toMatchObject({
      semantic_attempt: 1,
      lease_epoch: 2,
      submit_revision: 0,
    });
    expect(() => heartbeatAutomaticBuildLease(target, first.lease_ref, first.lease.token, {
      now: "2026-07-19T00:00:02.002Z",
      ttl_ms: 1_000,
    })).toThrow("expired");
  });

  it("starts running once and gives a 16.2 minute executor an independent run deadline", () => {
    const { target } = targetFixture();
    const claim = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "owner-a",
      now: T0,
      reserve_ttl_ms: 600_000,
    });
    if (claim.status !== "leased") throw new Error("expected reserved lease");
    expect(claim.lease).toMatchObject({
      version: "automatic_build_task_lease.v2",
      phase: "reserved",
      reserved_at: T0,
      reserve_expires_at: "2026-07-19T00:10:00.000Z",
    });
    const started = startAutomaticBuildLease(target, claim.lease_ref, claim.lease.token, {
      now: "2026-07-19T00:02:30.000Z",
      run_ttl_ms: 1_800_000,
    });
    expect(started).toMatchObject({
      phase: "running",
      started_at: "2026-07-19T00:02:30.000Z",
      run_expires_at: "2026-07-19T00:32:30.000Z",
      execution_identity: { semantic_attempt: 1, lease_epoch: 1 },
    });
    expect(startAutomaticBuildLease(target, claim.lease_ref, claim.lease.token, {
      now: "2026-07-19T00:03:00.000Z",
      run_ttl_ms: 1,
    })).toEqual(started);
    expect(assertActiveAutomaticBuildLease(
      target,
      claim.lease_ref,
      claim.lease.token,
      "2026-07-19T00:18:42.000Z",
    )).toMatchObject({ attempt: 1 });
  });

  it("rejects a late start after reservation expiry without creating start state", () => {
    const { target } = targetFixture();
    const claim = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "owner-a",
      now: T0,
      reserve_ttl_ms: 1_000,
    });
    if (claim.status !== "leased") throw new Error("expected reserved lease");
    expect(() => startAutomaticBuildLease(target, claim.lease_ref, claim.lease.token, {
      now: "2026-07-19T00:00:01.000Z",
      run_ttl_ms: 10_000,
    })).toThrow("expired");
    expect(() => assertActiveAutomaticBuildLease(
      target,
      claim.lease_ref,
      claim.lease.token,
      "2026-07-19T00:00:01.000Z",
    )).toThrow("expired");
  });

  it("keeps expiry recovery in one semantic attempt and resets the lease epoch after semantic failure", () => {
    const { target } = targetFixture();
    const first = claimAutomaticBuildTask(target, "pass1", "0", { owner: "owner-a", now: T0, ttl_ms: 1_000 });
    if (first.status !== "leased") throw new Error("expected first lease");
    const second = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "owner-b",
      now: "2026-07-19T00:00:01.000Z",
      ttl_ms: 1_000,
    });
    if (second.status !== "leased") throw new Error("expected second lease");
    const third = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "owner-c",
      now: "2026-07-19T00:00:02.000Z",
      ttl_ms: 1_000,
    });
    if (third.status !== "leased") throw new Error("expected third lease");
    expect(third.execution_identity).toMatchObject({ semantic_attempt: 1, lease_epoch: 3 });

    recordAutomaticBuildAttemptEvent(target, {
      stage: "pass1",
      work_unit_id: "0",
      attempt: third.lease.attempt,
      event_id: "pass1:0:3:failure",
      outcome: "failure",
      diagnostic: "schema mismatch",
      created_at: "2026-07-19T00:00:02.100Z",
    });
    const semanticRetry = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "owner-d",
      now: "2026-07-19T00:00:02.200Z",
      ttl_ms: 1_000,
    });
    if (semanticRetry.status !== "leased") throw new Error("expected semantic retry lease");
    expect(semanticRetry.execution_identity).toMatchObject({
      semantic_attempt: 2,
      lease_epoch: 1,
      submit_revision: 0,
    });
  });

  it("returns independent semantic and lease exhaustion diagnostics", () => {
    const leaseCase = targetFixture();
    const lease1 = claimAutomaticBuildTask(leaseCase.target, "pass1", "0", {
      owner: "owner-a",
      now: T0,
      ttl_ms: 1_000,
      max_lease_epochs: 2,
    });
    if (lease1.status !== "leased") throw new Error("expected first lease");
    const lease2 = claimAutomaticBuildTask(leaseCase.target, "pass1", "0", {
      owner: "owner-b",
      now: "2026-07-19T00:00:01.000Z",
      ttl_ms: 1_000,
      max_lease_epochs: 2,
    });
    if (lease2.status !== "leased") throw new Error("expected second lease");
    expect(claimAutomaticBuildTask(leaseCase.target, "pass1", "0", {
      owner: "owner-c",
      now: "2026-07-19T00:00:02.000Z",
      ttl_ms: 1_000,
      max_lease_epochs: 2,
    })).toMatchObject({ status: "executor_instability", semantic_attempt: 1, lease_epoch: 2 });

    const semanticCase = targetFixture();
    for (let semanticAttempt = 1; semanticAttempt <= 3; semanticAttempt += 1) {
      const claim = claimAutomaticBuildTask(semanticCase.target, "pass1", "0", {
        owner: `owner-${semanticAttempt}`,
        now: `2026-07-19T00:00:0${semanticAttempt}.000Z`,
        ttl_ms: 10_000,
        max_semantic_attempts: 3,
      });
      if (claim.status !== "leased") throw new Error(`expected semantic lease ${semanticAttempt}`);
      recordAutomaticBuildAttemptEvent(semanticCase.target, {
        stage: "pass1",
        work_unit_id: "0",
        attempt: claim.lease.attempt,
        event_id: `pass1:0:${claim.lease.attempt}:failure`,
        outcome: "failure",
        diagnostic: "semantic failure",
        created_at: `2026-07-19T00:00:0${semanticAttempt}.100Z`,
      });
    }
    expect(claimAutomaticBuildTask(semanticCase.target, "pass1", "0", {
      owner: "owner-4",
      now: "2026-07-19T00:00:04.000Z",
      ttl_ms: 10_000,
      max_semantic_attempts: 3,
    })).toMatchObject({ status: "retry_exhausted", semantic_attempt: 3 });
  });

  it("does not reissue active work from next and recovers exactly one new attempt", () => {
    const { root, source } = targetFixture();
    const first = acceptedNext(source, root, { owner: "root-a", now: T0, lease_ttl_ms: 1_000 });
    expect(first.action).toMatchObject({
      kind: "extract",
      tasks: [{ task_id: "0", attempt_number: 1, lease: { owner: "root-a" } }],
    });

    expect(acceptedNext(source, root, {
      owner: "root-b",
      now: "2026-07-19T00:00:00.500Z",
      lease_ttl_ms: 1_000,
    }).action).toMatchObject({ kind: "waiting", reason: "active_leases", stage: "pass1" });

    const recovered = acceptedNext(source, root, {
      owner: "root-c",
      now: "2026-07-19T00:00:01.000Z",
      lease_ttl_ms: 1_000,
    });
    expect(recovered.action).toMatchObject({
      kind: "extract",
      tasks: [{
        task_id: "0",
        attempt_number: 1,
        execution_identity: { semantic_attempt: 1, lease_epoch: 2, submit_revision: 0 },
        lease: { owner: "root-c", attempt: 2 },
      }],
    });
  });

  it("surfaces executor instability from next without issuing a fourth lease epoch", () => {
    const { root, source } = targetFixture();
    for (let epoch = 0; epoch < 3; epoch += 1) {
      const result = acceptedNext(source, root, {
        owner: `root-${epoch + 1}`,
        now: `2026-07-19T00:00:0${epoch}.000Z`,
        lease_ttl_ms: 1_000,
      });
      expect(result.action).toMatchObject({
        kind: "extract",
        tasks: [{ execution_identity: { semantic_attempt: 1, lease_epoch: epoch + 1 } }],
      });
    }
    const blocked = acceptedNext(source, root, {
      owner: "root-4",
      now: "2026-07-19T00:00:03.000Z",
      lease_ttl_ms: 1_000,
    });
    expect(blocked.action).toMatchObject({
      kind: "needs_user",
      reason: "executor_instability",
      tasks: [{ task_id: "0", status: "executor_instability", semantic_attempt: 1, lease_epoch: 3 }],
    });
  });
});
