import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertActiveAutomaticBuildLease,
  claimAutomaticBuildTask,
  heartbeatAutomaticBuildLease,
} from "../src/automatic-build-lease";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { automaticBuildNext, automaticBuildPlan, type AutomaticBuildNextOptions } from "../../../skills/build/automatic-build";

const T0 = "2026-07-19T00:00:00.000Z";

function targetFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-lease-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  return { root, source, target: resolveAutomaticBuildTarget(source, root) };
}

function acceptedNext(source: string, root: string, options: AutomaticBuildNextOptions) {
  const plan = automaticBuildPlan(source, root, { requested_workers: 1, quality_profile: options.quality_profile });
  if (!plan.preflight) throw new Error("expected lease preflight");
  return automaticBuildNext(source, root, 1, { ...options, accepted_plan_digest: plan.preflight.plan_digest });
}

describe("automatic build task lease", () => {
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
    expect(claims.filter((claim) => (claim as { status: string }).status === "already_leased")).toHaveLength(2);
  });

  it("honors heartbeat and expiry boundaries and rejects the stale token", () => {
    const { target } = targetFixture();
    const first = claimAutomaticBuildTask(target, "pass1", "0", { owner: "owner-a", now: T0, ttl_ms: 1_000 });
    if (first.status !== "leased") throw new Error("expected initial lease");

    heartbeatAutomaticBuildLease(target, first.lease_ref, first.lease.token, {
      now: "2026-07-19T00:00:00.999Z",
      ttl_ms: 1_000,
    });
    expect(assertActiveAutomaticBuildLease(
      target,
      first.lease_ref,
      first.lease.token,
      "2026-07-19T00:00:01.000Z",
    ).attempt).toBe(1);
    expect(() => assertActiveAutomaticBuildLease(
      target,
      first.lease_ref,
      first.lease.token,
      "2026-07-19T00:00:01.999Z",
    )).toThrow("expired");

    const recovered = claimAutomaticBuildTask(target, "pass1", "0", {
      owner: "owner-b",
      now: "2026-07-19T00:00:02.000Z",
      ttl_ms: 1_000,
    });
    if (recovered.status !== "leased") throw new Error("expected recovered lease");
    expect(recovered.lease.attempt).toBe(2);
    expect(() => heartbeatAutomaticBuildLease(target, first.lease_ref, first.lease.token, {
      now: "2026-07-19T00:00:02.001Z",
      ttl_ms: 1_000,
    })).toThrow("expired");
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
      tasks: [{ task_id: "0", attempt_number: 2, lease: { owner: "root-c" } }],
    });
  });
});
