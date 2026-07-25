import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  automaticBuildTaskAttemptDirectory,
  readAutomaticBuildAttemptRecord,
  readAutomaticBuildAttemptSnapshot,
  recordAutomaticBuildAttemptEvent,
} from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";

function targetFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-task-store-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  return { root, target: resolveAutomaticBuildTarget(source, root) };
}

describe("automatic build per-task attempt store", () => {
  it("records a terminal event once and rejects a conflicting result", () => {
    const { target } = targetFixture();
    const input = {
      stage: "pass1" as const,
      work_unit_id: "0",
      attempt: 1,
      event_id: "pass1:0:1:failure",
      outcome: "failure" as const,
      diagnostic: "schema mismatch",
      created_at: "2026-07-19T00:00:00.000Z",
    };

    recordAutomaticBuildAttemptEvent(target, input);
    recordAutomaticBuildAttemptEvent(target, input);

    expect(readAutomaticBuildAttemptSnapshot(target).stages.pass1?.["0"]).toMatchObject({
      failures: 1,
      last_error: "schema mismatch",
      last_attempt: 1,
      next_attempt: 2,
    });
    expect(() => recordAutomaticBuildAttemptEvent(target, {
      ...input,
      event_id: "pass1:0:1:success",
      outcome: "success",
    })).toThrow("conflicting terminal attempt event");
  });

  it("reads the v1 ledger without modifying it and continues with a monotonic attempt", () => {
    const { target } = targetFixture();
    const legacyPath = path.join(target.workspace_dir, ".build", "automatic-build", "attempts.json");
    const legacy = `${JSON.stringify({
      version: "automatic_build_attempts.v1",
      stages: { pass1: { "0": { failures: 2, last_error: "legacy failure", updated_at: "2026-07-18T00:00:00.000Z" } } },
    }, null, 2)}\n`;
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, legacy, "utf8");

    expect(readAutomaticBuildAttemptSnapshot(target).stages.pass1?.["0"]).toMatchObject({
      failures: 2,
      last_error: "legacy failure",
      last_attempt: 2,
      next_attempt: 3,
    });
    recordAutomaticBuildAttemptEvent(target, {
      stage: "pass1",
      work_unit_id: "0",
      attempt: 3,
      event_id: "pass1:0:3:failure",
      outcome: "failure",
      diagnostic: "v2 failure",
      created_at: "2026-07-19T00:00:00.000Z",
    });

    expect(readAutomaticBuildAttemptSnapshot(target).stages.pass1?.["0"]).toMatchObject({
      failures: 3,
      last_error: "v2 failure",
      last_attempt: 3,
      next_attempt: 4,
    });
    expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
  });

  it("infers execution identity from legacy v2 task directories without rewriting them", () => {
    const { target } = targetFixture();
    const attemptDir = automaticBuildTaskAttemptDirectory(target, "pass1", "0", 1);
    const leasePath = path.join(attemptDir, "lease.json");
    const legacyLease = `${JSON.stringify({
      version: "automatic_build_task_lease.v1",
      target_ref: target.target_ref,
      stage: "pass1",
      work_unit_id: "0",
      attempt: 1,
      owner: "legacy-owner",
      token: "legacy-token",
      issued_at: "2026-07-18T00:00:00.000Z",
      expires_at: "2026-07-18T00:05:00.000Z",
    }, null, 2)}\n`;
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(leasePath, legacyLease, "utf8");

    expect(readAutomaticBuildAttemptRecord(target, "pass1", "0")).toMatchObject({
      semantic_attempt: 1,
      lease_epoch: 1,
      submit_revision: 0,
      identity_source: "legacy_inferred",
    });
    expect(readFileSync(leasePath, "utf8")).toBe(legacyLease);
    expect(existsSync(path.join(attemptDir, "execution.json"))).toBe(false);
  });

  it("keeps 100 independently scheduled task events without a shared writable ledger", async () => {
    const { target } = targetFixture();
    await Promise.all(Array.from({ length: 100 }, (_, index) => new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try {
          const outcome = index % 3 === 0 ? "failure" : index % 3 === 1 ? "success" : "reset";
          recordAutomaticBuildAttemptEvent(target, {
            stage: "pass1",
            work_unit_id: String(index),
            attempt: 1,
            event_id: `pass1:${index}:1:${outcome}`,
            outcome,
            ...(outcome === "failure" ? { diagnostic: `failure ${index}` } : {}),
            created_at: "2026-07-19T00:00:00.000Z",
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    })));

    const snapshot = readAutomaticBuildAttemptSnapshot(target);
    expect(Object.keys(snapshot.stages.pass1 ?? {})).toHaveLength(100);
    expect(Object.values(snapshot.stages.pass1 ?? {}).filter((record) => record.failures === 1)).toHaveLength(34);
    const v2Root = path.join(target.workspace_dir, ".build", "automatic-build", "v2", "tasks");
    expect(readdirSync(v2Root, { recursive: true }).filter((entry) => /(?:result|reset)\.json$/.test(String(entry)))).toHaveLength(100);
    expect(existsSync(path.join(target.workspace_dir, ".build", "automatic-build", "attempts.json"))).toBe(false);
  });
});
