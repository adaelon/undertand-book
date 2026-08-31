import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { failAutomaticBuildTask } from "../src/automatic-build-mailbox";
import {
  automaticBuildTaskAttemptDirectory,
  nextAutomaticBuildExecutionIdentity,
  readAutomaticBuildRetryBoundary,
  readAutomaticBuildAttemptRecord,
  readAutomaticBuildAttemptSnapshot,
  recordAutomaticBuildRetryRecovery,
  recordAutomaticBuildAttemptEvent,
} from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import {
  createAutomaticBuildFailureDiagnostic,
  createAutomaticBuildFailureDiagnosticV3,
} from "../src/extractor-contract";
import {
  profileSidecarPolicyScopeFixture,
  type SyntheticAutomaticBuildAttemptScopeV1,
} from "./fixtures/profile-sidecar-contract-drift/policy-scope";

function targetFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-task-store-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
  return { root, target: resolveAutomaticBuildTarget(source, root) };
}

function exhaustPolicyScope(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  fixture: ReturnType<typeof profileSidecarPolicyScopeFixture>,
  failureDiagnostic: ReturnType<typeof createAutomaticBuildFailureDiagnostic>,
  eventPrefix: string,
): void {
  for (let semanticAttempt = 1; semanticAttempt <= 3; semanticAttempt += 1) {
    const claim = claimAutomaticBuildTask(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      {
        owner: `${eventPrefix}-owner-${semanticAttempt}`,
        now: `2026-08-10T00:00:0${semanticAttempt}.000Z`,
        descriptor: fixture.descriptor,
        binding: fixture.scope_a.task_binding,
        policy_generation: "v3_only",
        max_semantic_attempts: 3,
      },
    );
    if (claim.status !== "leased") throw new Error(`expected scope A attempt ${semanticAttempt}`);
    failAutomaticBuildTask(target, claim.lease_ref, claim.lease.token, {
      failure_diagnostic: failureDiagnostic,
      now: `2026-08-10T00:00:0${semanticAttempt}.100Z`,
    });
  }
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
      failure_diagnostic: createAutomaticBuildFailureDiagnostic({
        category: "schema",
        code: "schema_invalid",
        json_pointer: "/nodes/0",
        expected: "valid node",
      }),
      created_at: "2026-07-19T00:00:00.000Z",
    };

    recordAutomaticBuildAttemptEvent(target, input);
    recordAutomaticBuildAttemptEvent(target, input);

    expect(readAutomaticBuildAttemptSnapshot(target).stages.pass1?.["0"]).toMatchObject({
      failures: 1,
      last_error: "schema_invalid",
      last_failure_diagnostic: { category: "schema", code: "schema_invalid" },
      last_attempt: 1,
      next_attempt: 2,
    });
    expect(JSON.parse(readFileSync(path.join(
      automaticBuildTaskAttemptDirectory(target, "pass1", "0", 1),
      "result.json",
    ), "utf8"))).toMatchObject({
      version: "automatic_build_attempt_event.v3",
      failure_diagnostic: { category: "schema", code: "schema_invalid" },
    });
    expect(() => recordAutomaticBuildAttemptEvent(target, {
      ...input,
      event_id: "pass1:0:1:success",
      outcome: "success",
      failure_diagnostic: undefined,
    })).toThrow("conflicting terminal attempt event");
  });

  it("rejects transport and candidate-sink observations as terminal semantic failures", () => {
    const { target } = targetFixture();
    const claim = claimAutomaticBuildTask(target, "pass1", "phase-accounting", {
      owner: "phase-accounting-owner",
      now: "2026-08-26T00:00:00.000Z",
      ttl_ms: 60_000,
    });
    if (claim.status !== "leased") throw new Error("expected phase-accounting lease");
    const sinkFailure = createAutomaticBuildFailureDiagnosticV3({
      category: "executor",
      code: "candidate_sink_unavailable",
      phase: "candidate_sink",
    });

    expect(() => failAutomaticBuildTask(target, claim.lease_ref, claim.lease.token, {
      failure_diagnostic: sinkFailure,
      now: "2026-08-26T00:00:01.000Z",
    })).toThrow(/candidate_sink|semantic.*terminal|non-semantic/i);
    expect(() => recordAutomaticBuildAttemptEvent(target, {
      stage: "pass1",
      work_unit_id: "phase-accounting",
      attempt: claim.lease.attempt,
      event_id: "forged-candidate-sink-terminal",
      outcome: "failure",
      failure_diagnostic: sinkFailure,
      created_at: "2026-08-26T00:00:02.000Z",
    })).toThrow(/candidate_sink|semantic.*terminal|non-semantic/i);
    expect(existsSync(path.join(path.dirname(claim.lease_ref), "failure.json"))).toBe(false);
    expect(existsSync(path.join(path.dirname(claim.lease_ref), "result.json"))).toBe(false);
    expect(readAutomaticBuildAttemptRecord(target, "pass1", "phase-accounting")).toMatchObject({
      failures: 0,
      semantic_attempt: 1,
      lease_epoch: 1,
      submit_revision: 0,
    });
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
      last_error: "legacy_unclassified",
      last_failure_diagnostic: { category: "internal", code: "legacy_unclassified" },
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
      last_error: "legacy_unclassified",
      last_failure_diagnostic: { category: "internal", code: "legacy_unclassified" },
      last_attempt: 3,
      next_attempt: 4,
    });
    expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
  });

  it("dual-reads v2 free-text events only as legacy_unclassified", () => {
    const { target } = targetFixture();
    const attemptDir = automaticBuildTaskAttemptDirectory(target, "pass1", "legacy-v2", 1);
    const eventPath = path.join(attemptDir, "result.json");
    const legacyEvent = `${JSON.stringify({
      version: "automatic_build_attempt_event.v2",
      target_ref: target.target_ref,
      stage: "pass1",
      work_unit_id: "legacy-v2",
      attempt: 1,
      event_id: "pass1:legacy-v2:1:failure",
      outcome: "failure",
      diagnostic: "PRIVATE_LEGACY_EVENT_MESSAGE",
      created_at: "2026-07-19T00:00:00.000Z",
    }, null, 2)}\n`;
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(eventPath, legacyEvent, "utf8");

    const record = readAutomaticBuildAttemptRecord(target, "pass1", "legacy-v2");
    expect(record).toMatchObject({
      failures: 1,
      last_error: "legacy_unclassified",
      last_failure_diagnostic: { category: "internal", code: "legacy_unclassified" },
    });
    expect(JSON.stringify(record)).not.toContain("PRIVATE_LEGACY_EVENT_MESSAGE");
    expect(readFileSync(eventPath, "utf8")).toBe(legacyEvent);
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

  it("classifies legacy policy-fingerprint attempt digests as unscoped migration state", () => {
    const { target } = targetFixture();
    const fixture = profileSidecarPolicyScopeFixture(target);
    const attemptDir = automaticBuildTaskAttemptDirectory(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      1,
    );
    const leasePath = path.join(attemptDir, "lease.json");
    const legacyLease = `${JSON.stringify({
      version: "automatic_build_task_lease.v2",
      target_ref: target.target_ref,
      stage: fixture.descriptor.stage,
      work_unit_id: fixture.descriptor.work_unit_id,
      attempt: 1,
      phase: "reserved",
      owner: "legacy-policy-owner",
      token: "legacy-policy-token",
      reserved_at: "2026-08-02T00:00:00.000Z",
      reserve_expires_at: "2026-08-02T00:10:00.000Z",
      issued_at: "2026-08-02T00:00:00.000Z",
      expires_at: "2026-08-02T00:10:00.000Z",
      input_hash: fixture.descriptor.input_hash,
      policy_fingerprint: fixture.descriptor.policy_fingerprint,
      attempt_scope_digest: "a".repeat(64),
    }, null, 2)}\n`;
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(leasePath, legacyLease, "utf8");

    expect(nextAutomaticBuildExecutionIdentity(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      {
        max_semantic_attempts: 3,
        max_lease_epochs: 3,
        attempt_scope: fixture.scope_a,
      },
    )).toMatchObject({
      status: "policy_generation_migration_required",
      requested_attempt_scope_digest: fixture.scope_a.attempt_scope_digest,
      reason: "legacy_attempt_scope_ambiguous",
    });
    expect(readFileSync(leasePath, "utf8")).toBe(legacyLease);
  });

  it("counts semantic failures only inside the complete policy-bound attempt scope", () => {
    const { target } = targetFixture();
    const fixture = profileSidecarPolicyScopeFixture(target);
    exhaustPolicyScope(target, fixture, createAutomaticBuildFailureDiagnostic({
      category: "schema",
      code: "schema_invalid",
      json_pointer: "/discourse_items/0/local_summary",
      expected: "string length <= 200",
    }), "profile-sidecar-contract-drift");

    const nextFor = (attemptScope: SyntheticAutomaticBuildAttemptScopeV1) => (
      nextAutomaticBuildExecutionIdentity(
        target,
        fixture.descriptor.stage,
        fixture.descriptor.work_unit_id,
        {
          max_semantic_attempts: 3,
          max_lease_epochs: 3,
          attempt_scope: attemptScope,
        } as Parameters<typeof nextAutomaticBuildExecutionIdentity>[3] & {
          attempt_scope: SyntheticAutomaticBuildAttemptScopeV1;
        },
      )
    );

    expect(nextFor(fixture.scope_a)).toMatchObject({
      status: "retry_exhausted",
      semantic_attempt: 3,
      attempt_scope_digest: fixture.scope_a.attempt_scope_digest,
      failure_diagnostic: { category: "schema", code: "schema_invalid" },
    });
    expect(nextFor(fixture.scope_b)).toMatchObject({
      status: "ready",
      execution_identity: {
        semantic_attempt: 1,
        lease_epoch: 1,
        attempt_scope_digest: fixture.scope_b.attempt_scope_digest,
      },
    });
  });

  it("opens exactly one create-only retry window for an exact transient terminal boundary", () => {
    const { target } = targetFixture();
    const fixture = profileSidecarPolicyScopeFixture(target);
    exhaustPolicyScope(target, fixture, createAutomaticBuildFailureDiagnostic({
      category: "provider",
      code: "provider_timeout",
    }), "profile-sidecar-provider-timeout");

    const boundary = readAutomaticBuildRetryBoundary(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      fixture.scope_a.attempt_scope_digest,
    );
    expect(boundary).toMatchObject({
      version: "automatic_build_retry_boundary.v1",
      attempt_scope_digest: fixture.scope_a.attempt_scope_digest,
      exhausted_semantic_attempt: 3,
      required_recovery: "authorize_transient_retry",
    });
    if (!boundary) throw new Error("expected transient retry boundary");
    const terminalAttemptDir = automaticBuildTaskAttemptDirectory(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      3,
    );
    const terminalFailurePath = path.join(terminalAttemptDir, "failure.json");
    const terminalEventPath = path.join(terminalAttemptDir, "result.json");
    expect(boundary.terminal_receipt_sha256).toBe(
      createHash("sha256").update(readFileSync(terminalFailurePath)).digest("hex"),
    );
    expect(boundary.terminal_receipt_sha256).not.toBe(
      createHash("sha256").update(readFileSync(terminalEventPath)).digest("hex"),
    );
    const input = {
      ...boundary,
      stage: fixture.descriptor.stage,
      work_unit_id: fixture.descriptor.work_unit_id,
      decision_request_id: `abreq1_${"a".repeat(64)}`,
      created_at: "2026-08-10T00:00:10.000Z",
    };
    const first = recordAutomaticBuildRetryRecovery(target, input);
    expect(first).toMatchObject({
      version: "automatic_build_retry_recovery.v1",
      action: "open_same_scope_retry_window",
      terminal_receipt_sha256: boundary.terminal_receipt_sha256,
      diagnostic_digest: boundary.diagnostic_digest,
    });
    expect(recordAutomaticBuildRetryRecovery(target, input)).toEqual(first);
    expect(() => recordAutomaticBuildRetryRecovery(target, {
      ...input,
      decision_request_id: `abreq1_${"b".repeat(64)}`,
    })).toThrow("conflicting automatic build retry recovery receipt");

    expect(nextAutomaticBuildExecutionIdentity(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      {
        max_semantic_attempts: 3,
        max_lease_epochs: 3,
        attempt_scope: fixture.scope_a,
      },
    )).toMatchObject({
      status: "ready",
      execution_identity: { semantic_attempt: 4, lease_epoch: 1 },
    });
    const reopened = claimAutomaticBuildTask(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      {
        owner: "scope-a-recovered-owner",
        now: "2026-08-10T00:00:11.000Z",
        descriptor: fixture.descriptor,
        binding: fixture.scope_a.task_binding,
        policy_generation: "v3_only",
        max_semantic_attempts: 3,
      },
    );
    if (reopened.status !== "leased") throw new Error("expected one recovered semantic attempt");
    expect(reopened.execution_identity).toMatchObject({ semantic_attempt: 4, lease_epoch: 1 });
    failAutomaticBuildTask(target, reopened.lease_ref, reopened.lease.token, {
      failure_diagnostic: createAutomaticBuildFailureDiagnostic({
        category: "provider",
        code: "provider_timeout",
      }),
      now: "2026-08-10T00:00:11.100Z",
    });
    const exhaustedAgain = nextAutomaticBuildExecutionIdentity(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      {
        max_semantic_attempts: 3,
        max_lease_epochs: 3,
        attempt_scope: fixture.scope_a,
      },
    );
    expect(exhaustedAgain).toMatchObject({
      status: "retry_exhausted",
      semantic_attempt: 4,
      retry_boundary: { exhausted_semantic_attempt: 4 },
    });
    expect(() => recordAutomaticBuildRetryRecovery(target, input))
      .toThrow("terminal boundary changed");
    expect(() => recordAutomaticBuildAttemptEvent(target, {
      stage: fixture.descriptor.stage,
      work_unit_id: fixture.descriptor.work_unit_id,
      attempt: 3,
      event_id: "forged-scoped-reset",
      outcome: "reset",
    })).toThrow("scoped automatic build tasks require a guarded recovery receipt");
  });

  it("rejects deterministic, stale, and fabricated same-scope recovery without writing", () => {
    const { target } = targetFixture();
    const fixture = profileSidecarPolicyScopeFixture(target);
    exhaustPolicyScope(target, fixture, createAutomaticBuildFailureDiagnostic({
      category: "schema",
      code: "schema_invalid",
      json_pointer: "/discourse_items/0/local_summary",
      expected: "string length <= 200",
    }), "profile-sidecar-schema-invalid");
    const boundary = readAutomaticBuildRetryBoundary(
      target,
      fixture.descriptor.stage,
      fixture.descriptor.work_unit_id,
      fixture.scope_a.attempt_scope_digest,
    );
    if (!boundary) throw new Error("expected deterministic retry boundary");
    const recoveryPath = path.join(
      automaticBuildTaskAttemptDirectory(target, fixture.descriptor.stage, fixture.descriptor.work_unit_id, 3),
      "recovery.json",
    );
    const base = {
      ...boundary,
      stage: fixture.descriptor.stage,
      work_unit_id: fixture.descriptor.work_unit_id,
      decision_request_id: `abreq1_${"c".repeat(64)}`,
      created_at: "2026-08-10T00:00:10.000Z",
    };
    expect(() => recordAutomaticBuildRetryRecovery(target, base)).toThrow("does not allow same-scope retry recovery");
    expect(() => recordAutomaticBuildRetryRecovery(target, {
      ...base,
      terminal_receipt_sha256: "d".repeat(64),
    })).toThrow("terminal boundary changed");
    expect(() => recordAutomaticBuildRetryRecovery(target, {
      ...base,
      attempt_scope_digest: fixture.scope_b.attempt_scope_digest,
    })).toThrow("terminal boundary is not retry-exhausted");
    expect(existsSync(recoveryPath)).toBe(false);

    const nonTransientCase = targetFixture();
    const nonTransientFixture = profileSidecarPolicyScopeFixture(nonTransientCase.target);
    exhaustPolicyScope(nonTransientCase.target, nonTransientFixture, createAutomaticBuildFailureDiagnostic({
      category: "provider",
      code: "provider_failed",
    }), "profile-sidecar-provider-failed");
    const nonTransientBoundary = readAutomaticBuildRetryBoundary(
      nonTransientCase.target,
      nonTransientFixture.descriptor.stage,
      nonTransientFixture.descriptor.work_unit_id,
      nonTransientFixture.scope_a.attempt_scope_digest,
    );
    expect(nonTransientBoundary?.required_recovery).toBe("operator_fix");
    if (!nonTransientBoundary) throw new Error("expected non-transient provider boundary");
    expect(() => recordAutomaticBuildRetryRecovery(nonTransientCase.target, {
      ...nonTransientBoundary,
      stage: nonTransientFixture.descriptor.stage,
      work_unit_id: nonTransientFixture.descriptor.work_unit_id,
      decision_request_id: `abreq1_${"e".repeat(64)}`,
      created_at: "2026-08-10T00:00:10.000Z",
    })).toThrow("does not allow same-scope retry recovery");

    const staleCase = targetFixture();
    const staleFixture = profileSidecarPolicyScopeFixture(staleCase.target);
    exhaustPolicyScope(staleCase.target, staleFixture, createAutomaticBuildFailureDiagnostic({
      category: "provider",
      code: "provider_timeout",
    }), "profile-sidecar-stale-failure-receipt");
    const staleBoundary = readAutomaticBuildRetryBoundary(
      staleCase.target,
      staleFixture.descriptor.stage,
      staleFixture.descriptor.work_unit_id,
      staleFixture.scope_a.attempt_scope_digest,
    );
    if (!staleBoundary) throw new Error("expected stale receipt boundary");
    const staleAttemptDir = automaticBuildTaskAttemptDirectory(
      staleCase.target,
      staleFixture.descriptor.stage,
      staleFixture.descriptor.work_unit_id,
      3,
    );
    const staleFailurePath = path.join(staleAttemptDir, "failure.json");
    const staleFailureReceipt = JSON.parse(readFileSync(staleFailurePath, "utf8"));
    writeFileSync(staleFailurePath, `${JSON.stringify(staleFailureReceipt)}\n`, "utf8");
    const staleRecoveryPath = path.join(staleAttemptDir, "recovery.json");
    expect(() => recordAutomaticBuildRetryRecovery(staleCase.target, {
      ...staleBoundary,
      stage: staleFixture.descriptor.stage,
      work_unit_id: staleFixture.descriptor.work_unit_id,
      decision_request_id: `abreq1_${"f".repeat(64)}`,
      created_at: "2026-08-10T00:00:10.000Z",
    })).toThrow("terminal boundary changed");
    expect(existsSync(staleRecoveryPath)).toBe(false);

    const fabricatedCase = targetFixture();
    const fabricatedFixture = profileSidecarPolicyScopeFixture(fabricatedCase.target);
    exhaustPolicyScope(fabricatedCase.target, fabricatedFixture, createAutomaticBuildFailureDiagnostic({
      category: "provider",
      code: "provider_timeout",
    }), "profile-sidecar-fabricated-failure-receipt");
    const fabricatedBoundary = readAutomaticBuildRetryBoundary(
      fabricatedCase.target,
      fabricatedFixture.descriptor.stage,
      fabricatedFixture.descriptor.work_unit_id,
      fabricatedFixture.scope_a.attempt_scope_digest,
    );
    if (!fabricatedBoundary) throw new Error("expected fabricated receipt boundary");
    const fabricatedAttemptDir = automaticBuildTaskAttemptDirectory(
      fabricatedCase.target,
      fabricatedFixture.descriptor.stage,
      fabricatedFixture.descriptor.work_unit_id,
      3,
    );
    const fabricatedFailurePath = path.join(fabricatedAttemptDir, "failure.json");
    const fabricatedFailureReceipt = JSON.parse(readFileSync(fabricatedFailurePath, "utf8"));
    fabricatedFailureReceipt.attempt_scope_digest = fabricatedFixture.scope_b.attempt_scope_digest;
    writeFileSync(fabricatedFailurePath, `${JSON.stringify(fabricatedFailureReceipt, null, 2)}\n`, "utf8");
    const fabricatedRecoveryPath = path.join(fabricatedAttemptDir, "recovery.json");
    expect(() => recordAutomaticBuildRetryRecovery(fabricatedCase.target, {
      ...fabricatedBoundary,
      stage: fabricatedFixture.descriptor.stage,
      work_unit_id: fabricatedFixture.descriptor.work_unit_id,
      decision_request_id: `abreq1_${"0".repeat(64)}`,
      created_at: "2026-08-10T00:00:10.000Z",
    })).toThrow("invalid automatic build terminal failure receipt");
    expect(existsSync(fabricatedRecoveryPath)).toBe(false);
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
