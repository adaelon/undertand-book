import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceAutomaticBuildDispatch,
  finishAutomaticBuildDispatch,
  persistAutomaticBuildDispatch,
} from "../src/automatic-build-dispatch-runtime";
import { planAutomaticBuildExecutorDispatches } from "../src/automatic-build-dispatch";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { failAutomaticBuildTask, submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import {
  listAutomaticBuildStoredAttempts,
  readAutomaticBuildAttemptSnapshot,
} from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { buildWorkUnitCost, createWorkUnitDescriptor } from "../src/stage-work-unit";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-runtime-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA deterministic source.\n", "utf8");
  const target = resolveAutomaticBuildTarget(source, root);
  const policy = automaticBuildExtractionPolicy(
    "profile_sidecar",
    resolveContentProfile("technical_learning"),
    "full",
  );
  const descriptors = Array.from({ length: 8 }, (_, index) => createWorkUnitDescriptor({
    target: target.target_ref,
    stage: "profile_sidecar",
    work_unit_id: `formula-${index}`,
    kind: "profile_sidecar_formula",
    input_hash: createHash("sha256").update(`input-${index}`).digest("hex"),
    policy_fingerprint: policy,
    evidence_lids: [`p${index + 1}`],
    cost: buildWorkUnitCost({
      estimated_input_tokens: 181,
      visible_lids: 1,
      formula_lids: 1,
      expected_output_items: 1,
    }),
  }));
  const plan = planAutomaticBuildExecutorDispatches({
    target_ref: target.target_ref,
    stage: "profile_sidecar",
    work_units: descriptors,
    pending_ids: descriptors.map((descriptor) => descriptor.work_unit_id),
    available_agent_slots: 1,
  });
  expect(plan.dispatches).toHaveLength(1);
  const bindings = Object.fromEntries(descriptors.map((descriptor) => [descriptor.work_unit_id, {
    input_hash: descriptor.input_hash,
    policy_fingerprint: descriptor.policy_fingerprint,
  }]));
  return { root, target, descriptors, manifest: plan.dispatches[0], bindings };
}

function commit(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  advance: Extract<ReturnType<typeof advanceAutomaticBuildDispatch>, { status: "leased" }>,
  ordinal: number,
) {
  const candidate = JSON.stringify({ ordinal, marker: `PRIVATE_FORMULA_${ordinal}` });
  const candidatePath = path.join(path.dirname(advance.claim.lease_ref), "candidate.json");
  writeFileSync(candidatePath, candidate, "utf8");
  const artifactPath = path.join(target.workspace_dir, ".build", "profile-sidecar", `${advance.descriptor.work_unit_id}.json`);
  const receipt = submitAutomaticBuildCandidate(
    target,
    advance.claim.lease_ref,
    advance.claim.lease.token,
    candidatePath,
    (sourcePath) => {
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, readFileSync(sourcePath));
      return { artifact_path: artifactPath, output_counts: { formula_semantics: 1 } };
    },
    { now: advance.claim.lease.issued_at, completed_at: advance.claim.lease.issued_at },
  );
  expect(receipt.candidate_sha256).toBe(createHash("sha256").update(candidate).digest("hex"));
  return receipt;
}

function seedSemanticFailure(
  target: ReturnType<typeof resolveAutomaticBuildTarget>,
  workUnitId: string,
  owner: string,
  claimedAt: string,
  failedAt: string,
) {
  const claim = claimAutomaticBuildTask(target, "profile_sidecar", workUnitId, {
    owner,
    now: claimedAt,
    reserve_ttl_ms: 60_000,
    max_semantic_attempts: 3,
  });
  if (claim.status !== "leased") throw new Error(`expected seed lease for ${workUnitId}`);
  return failAutomaticBuildTask(target, claim.lease_ref, claim.lease.token, {
    diagnostic_code: "semantic_invalid",
    now: failedAt,
  });
}

describe("automatic build executor dispatch runtime", () => {
  it("runs an eight-task formula dispatch with one lease at a time and eight canonical receipts", () => {
    const { target, descriptors, manifest, bindings } = fixture();
    persistAutomaticBuildDispatch(target, manifest, {
      owner: `dispatch-runtime:${manifest.dispatch_id}`,
      created_at: "2026-07-25T04:00:00.000Z",
      reserve_ttl_ms: 60_000,
      run_ttl_ms: 1_800_000,
    });
    for (let index = 0; index < 8; index += 1) {
      const advanced = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
        descriptors,
        task_bindings: bindings,
        now: `2026-07-25T04:00:${String(index + 1).padStart(2, "0")}.000Z`,
      });
      expect(advanced.status).toBe("leased");
      if (advanced.status !== "leased") throw new Error("expected dispatch lease");
      expect(advanced.descriptor.work_unit_id).toBe(manifest.ordered_work_unit_ids[index]);
      expect(advanced.descriptor.input_hash).toBe(bindings[advanced.descriptor.work_unit_id].input_hash);
      commit(target, advanced, index);
      expect(Object.keys(readAutomaticBuildAttemptSnapshot(target).stages.profile_sidecar ?? {})).toHaveLength(index + 1);
    }
    const complete = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      now: "2026-07-25T04:00:20.000Z",
    });
    expect(complete.status).toBe("ready_to_finish");
    const receipt = finishAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      now: "2026-07-25T04:00:21.000Z",
    });
    expect(receipt).toMatchObject({ terminal_reason: "complete", unclaimed_work_unit_ids: [] });
    expect(receipt.task_receipts).toHaveLength(8);
    expect(new Set(receipt.task_receipts.map((item) => item.work_unit_id)).size).toBe(8);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_FORMULA_");
  });

  it("preserves three commits, recovers the fourth lease, and never claims the remaining suffix", () => {
    const { target, descriptors, manifest, bindings } = fixture();
    persistAutomaticBuildDispatch(target, manifest, {
      owner: `dispatch-interrupt:${manifest.dispatch_id}`,
      created_at: "2026-07-25T05:00:00.000Z",
      reserve_ttl_ms: 1_000,
      run_ttl_ms: 1_800_000,
    });
    for (let index = 0; index < 3; index += 1) {
      const advanced = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
        descriptors,
        task_bindings: bindings,
        now: `2026-07-25T05:00:0${index + 1}.000Z`,
      });
      if (advanced.status !== "leased") throw new Error("expected dispatch lease");
      commit(target, advanced, index);
    }
    const fourth = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      now: "2026-07-25T05:00:04.000Z",
    });
    expect(fourth.status).toBe("leased");
    const interrupted = finishAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      terminal_reason: "executor_interrupted",
      now: "2026-07-25T05:00:04.500Z",
    });
    expect(interrupted.task_receipts).toHaveLength(3);
    expect(interrupted.unclaimed_work_unit_ids).toEqual(manifest.ordered_work_unit_ids.slice(4));
    expect(Object.keys(readAutomaticBuildAttemptSnapshot(target).stages.profile_sidecar ?? {})).toEqual(
      manifest.ordered_work_unit_ids.slice(0, 4),
    );

    const recoveryPlan = planAutomaticBuildExecutorDispatches({
      target_ref: target.target_ref,
      stage: "profile_sidecar",
      work_units: descriptors,
      pending_ids: manifest.ordered_work_unit_ids.slice(3),
      available_agent_slots: 1,
    });
    const recovery = recoveryPlan.dispatches[0];
    persistAutomaticBuildDispatch(target, recovery, {
      owner: `dispatch-recovery:${recovery.dispatch_id}`,
      created_at: "2026-07-25T05:00:06.000Z",
      reserve_ttl_ms: 60_000,
      run_ttl_ms: 1_800_000,
    });
    const reclaimed = advanceAutomaticBuildDispatch(target, "profile_sidecar", recovery.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      now: "2026-07-25T05:00:06.000Z",
    });
    expect(reclaimed.status).toBe("leased");
    if (reclaimed.status !== "leased") throw new Error("expected recovered lease");
    expect(reclaimed.descriptor.work_unit_id).toBe(manifest.ordered_work_unit_ids[3]);
    expect(reclaimed.claim.execution_identity.lease_epoch).toBe(2);
    expect(listAutomaticBuildStoredAttempts(target, "profile_sidecar")
      .filter((attempt) => attempt.work_unit_id === manifest.ordered_work_unit_ids[3])).toHaveLength(2);
    expect(manifest.ordered_work_unit_ids.slice(4).some((workUnitId) => (
      readAutomaticBuildAttemptSnapshot(target).stages.profile_sidecar?.[workUnitId]
    ))).toBe(false);
  });

  it("uses a new dispatch run when a failed one-task manifest keeps the same planner identity", () => {
    const { target, descriptors, bindings } = fixture();
    const one = planAutomaticBuildExecutorDispatches({
      target_ref: target.target_ref,
      stage: "profile_sidecar",
      work_units: descriptors,
      pending_ids: [descriptors[0].work_unit_id],
      available_agent_slots: 1,
    }).dispatches[0];
    const firstRun = persistAutomaticBuildDispatch(target, one, {
      owner: `dispatch-failure:${one.dispatch_id}:1`,
      created_at: "2026-07-25T06:00:00.000Z",
      reserve_ttl_ms: 60_000,
      run_ttl_ms: 1_800_000,
    }).persisted;
    const first = advanceAutomaticBuildDispatch(target, "profile_sidecar", one.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      dispatch_run_id: firstRun.dispatch_run_id,
      now: "2026-07-25T06:00:01.000Z",
    });
    if (first.status !== "leased") throw new Error("expected first run lease");
    failAutomaticBuildTask(target, first.claim.lease_ref, first.claim.lease.token, {
      diagnostic_code: "semantic_invalid",
      now: "2026-07-25T06:00:02.000Z",
    });
    expect(advanceAutomaticBuildDispatch(target, "profile_sidecar", one.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      dispatch_run_id: firstRun.dispatch_run_id,
      now: "2026-07-25T06:00:03.000Z",
    }).status).toBe("ready_to_finish");
    expect(finishAutomaticBuildDispatch(target, "profile_sidecar", one.dispatch_id, {
      dispatch_run_id: firstRun.dispatch_run_id,
      now: "2026-07-25T06:00:04.000Z",
    }).terminal_reason).toBe("task_failure");

    const secondRun = persistAutomaticBuildDispatch(target, one, {
      owner: `dispatch-failure:${one.dispatch_id}:2`,
      created_at: "2026-07-25T06:01:00.000Z",
      reserve_ttl_ms: 60_000,
      run_ttl_ms: 1_800_000,
    }).persisted;
    expect(secondRun.dispatch_run_id).not.toBe(firstRun.dispatch_run_id);
    const retried = advanceAutomaticBuildDispatch(target, "profile_sidecar", one.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      dispatch_run_id: secondRun.dispatch_run_id,
      now: "2026-07-25T06:01:01.000Z",
    });
    expect(retried.status).toBe("leased");
    if (retried.status !== "leased") throw new Error("expected retry dispatch lease");
    expect(retried.claim.execution_identity.semantic_attempt).toBe(2);
  });

  it("partially finishes task_failure only after a terminal exhausted task and preserves the exact suffix", () => {
    const { target, descriptors, manifest, bindings } = fixture();
    const firstId = manifest.ordered_work_unit_ids[0];
    seedSemanticFailure(target, firstId, "seed-failure-1", "2026-07-25T07:00:00.000Z", "2026-07-25T07:00:01.000Z");
    seedSemanticFailure(target, firstId, "seed-failure-2", "2026-07-25T07:01:00.000Z", "2026-07-25T07:01:01.000Z");
    persistAutomaticBuildDispatch(target, manifest, {
      owner: `dispatch-exhausted:${manifest.dispatch_id}`,
      created_at: "2026-07-25T07:02:00.000Z",
      reserve_ttl_ms: 60_000,
      run_ttl_ms: 1_800_000,
    });
    const third = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      now: "2026-07-25T07:02:01.000Z",
      max_semantic_attempts: 3,
    });
    if (third.status !== "leased") throw new Error("expected third semantic lease");
    failAutomaticBuildTask(target, third.claim.lease_ref, third.claim.lease.token, {
      diagnostic_code: "semantic_invalid",
      now: "2026-07-25T07:02:02.000Z",
    });
    expect(advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      now: "2026-07-25T07:02:03.000Z",
      max_semantic_attempts: 3,
    })).toMatchObject({ status: "retry_exhausted", work_unit_id: firstId });
    const receipt = finishAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      terminal_reason: "task_failure",
      now: "2026-07-25T07:02:04.000Z",
    });
    expect(receipt.task_receipts).toHaveLength(1);
    expect(receipt.unclaimed_work_unit_ids).toEqual(manifest.ordered_work_unit_ids.slice(1));
  });

  it("rejects task_failure without a canonical retryable failure receipt", () => {
    const { target, manifest } = fixture();
    persistAutomaticBuildDispatch(target, manifest, {
      owner: `dispatch-no-failure:${manifest.dispatch_id}`,
      created_at: "2026-07-25T08:00:00.000Z",
      reserve_ttl_ms: 60_000,
      run_ttl_ms: 1_800_000,
    });
    expect(() => finishAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      terminal_reason: "task_failure",
      now: "2026-07-25T08:00:01.000Z",
    })).toThrow("canonical retryable failure");
  });

  it("rejects task_failure while a dispatch lease is active", () => {
    const { target, descriptors, manifest, bindings } = fixture();
    persistAutomaticBuildDispatch(target, manifest, {
      owner: `dispatch-active:${manifest.dispatch_id}`,
      created_at: "2026-07-25T09:00:00.000Z",
      reserve_ttl_ms: 60_000,
      run_ttl_ms: 1_800_000,
    });
    const first = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      now: "2026-07-25T09:00:01.000Z",
    });
    if (first.status !== "leased") throw new Error("expected first lease");
    failAutomaticBuildTask(target, first.claim.lease_ref, first.claim.lease.token, {
      diagnostic_code: "semantic_invalid",
      now: "2026-07-25T09:00:02.000Z",
    });
    const active = advanceAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      descriptors,
      task_bindings: bindings,
      now: "2026-07-25T09:00:03.000Z",
    });
    if (active.status !== "leased") throw new Error("expected active suffix lease");
    expect(() => finishAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      terminal_reason: "task_failure",
      now: "2026-07-25T09:00:04.000Z",
    })).toThrow("active lease");
  });

  it("rejects task_failure when the remaining work is not a strict unclaimed suffix", () => {
    const { target, manifest } = fixture();
    const owner = `dispatch-gap:${manifest.dispatch_id}`;
    persistAutomaticBuildDispatch(target, manifest, {
      owner,
      created_at: "2026-07-25T10:00:00.000Z",
      reserve_ttl_ms: 1_000,
      run_ttl_ms: 1_800_000,
    });
    seedSemanticFailure(
      target,
      manifest.ordered_work_unit_ids[0],
      owner,
      "2026-07-25T10:00:01.000Z",
      "2026-07-25T10:00:01.500Z",
    );
    const gap = claimAutomaticBuildTask(target, "profile_sidecar", manifest.ordered_work_unit_ids[2], {
      owner,
      now: "2026-07-25T10:00:02.000Z",
      reserve_ttl_ms: 1_000,
    });
    if (gap.status !== "leased") throw new Error("expected out-of-order gap lease");
    expect(() => finishAutomaticBuildDispatch(target, "profile_sidecar", manifest.dispatch_id, {
      terminal_reason: "task_failure",
      now: "2026-07-25T10:00:04.000Z",
    })).toThrow("strict unclaimed suffix");
  });
});
