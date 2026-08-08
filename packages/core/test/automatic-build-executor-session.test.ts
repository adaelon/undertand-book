import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failAutomaticBuildExecutorSession,
  heartbeatAutomaticBuildExecutorSession,
  issueAutomaticBuildOpaqueHandoff,
  interruptAutomaticBuildExecutorSession,
  openAutomaticBuildExecutorSession,
  submitAutomaticBuildExecutorCandidate,
  type AutomaticBuildExecutorSessionResponseV1,
} from "../src/automatic-build-executor-session";
import { canonicalAutomaticBuildJson } from "../src/automatic-build-protocol";
import { readAutomaticBuildAttemptSnapshot } from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import {
  automaticBuildDispatchFinish,
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";

let priorRegistryRoot: string | undefined;

beforeEach(() => {
  priorRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
});

afterEach(() => {
  if (priorRegistryRoot === undefined) {
    delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
  } else {
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = priorRegistryRoot;
  }
});

function fixture(label: string) {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-executor-open-${label}-`));
  const registryRoot = path.join(root, "driver-registry");
  process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registryRoot;
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA deterministic executor-open fixture.\n", "utf8");
  const buildPlan = confirmedStandardBuildPlan(source, root);
  const plan = automaticBuildPlan(source, root, {
    requested_workers: 1,
    available_agent_slots: 1,
    build_plan: buildPlan,
  });
  if (!plan.preflight) throw new Error("expected executor-open preflight");
  const next = automaticBuildNext(source, root, 1, {
    now: "2026-08-08T06:00:00.000Z",
    accepted_plan_digest: plan.preflight.plan_digest,
    available_agent_slots: 1,
    executor_dispatches: true,
    build_plan: buildPlan,
  });
  if (!("dispatches" in next.action) || !next.action.dispatches) {
    throw new Error("expected executor-open dispatch");
  }
  const envelope = next.action.dispatches[0];
  const target = resolveAutomaticBuildTarget(source, root);
  return { root, registryRoot, source, target, envelope };
}

function expectNoAttempts(value: ReturnType<typeof fixture>): void {
  expect(readAutomaticBuildAttemptSnapshot(value.target).stages).toEqual({});
}

function expectGenerate(
  response: AutomaticBuildExecutorSessionResponseV1,
): Extract<AutomaticBuildExecutorSessionResponseV1["action"], { kind: "GENERATE" }> {
  expect(response.version).toBe("automatic_build_executor_session.v1");
  expect(response.action.kind).toBe("GENERATE");
  if (response.action.kind !== "GENERATE") throw new Error("expected GENERATE executor action");
  return response.action;
}

function candidateFor(
  root: string,
  action: Extract<AutomaticBuildExecutorSessionResponseV1["action"], { kind: "GENERATE" }>,
  label: string,
): string {
  const contract = action.output_contract as {
    version?: unknown;
    input_hash?: unknown;
    work_unit_id?: unknown;
  };
  expect(contract.version).toBe("automatic_build_semantic_candidate_contract.v1");
  expect(contract.input_hash).toMatch(/^[a-f0-9]{64}$/u);
  expect(typeof contract.work_unit_id).toBe("string");
  const candidate = path.join(root, `candidate-${label}.json`);
  writeFileSync(candidate, `${JSON.stringify({
    nodes: [],
    edges: [],
  })}\n`, "utf8");
  return candidate;
}

function forgeOuterConsistentHandoff(
  value: ReturnType<typeof fixture>,
  handoffBytes: Buffer,
): string {
  writeFileSync(value.envelope.executor_handoff.path, handoffBytes);
  const handoffSha256 = createHash("sha256").update(handoffBytes).digest("hex");
  const manifest = JSON.parse(readFileSync(value.envelope.manifest_path, "utf8"));
  manifest.executor_handoff.sha256 = handoffSha256;
  manifest.executor_handoff.byte_length = handoffBytes.byteLength;
  writeFileSync(value.envelope.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const originalRecordPath = path.join(
    value.registryRoot,
    "opaque-handoffs",
    `${value.envelope.opaque_handoff_ref}.json`,
  );
  const record = JSON.parse(readFileSync(originalRecordPath, "utf8"));
  record.handoff_sha256 = handoffSha256;
  record.handoff_byte_length = handoffBytes.byteLength;
  const identity = {
    version: "automatic_build_opaque_handoff_identity.v1",
    kind: record.kind,
    target_ref: record.target_ref,
    target_locator: record.target_locator,
    owner_identity: record.owner_identity,
    handoff_path: record.handoff_path,
    handoff_sha256: record.handoff_sha256,
    handoff_byte_length: record.handoff_byte_length,
  };
  const opaqueHandoffRef = `abhandoff1_${createHash("sha256")
    .update(canonicalAutomaticBuildJson(identity), "utf8")
    .digest("hex")}`;
  record.opaque_handoff_ref = opaqueHandoffRef;
  writeFileSync(path.join(
    value.registryRoot,
    "opaque-handoffs",
    `${opaqueHandoffRef}.json`,
  ), `${canonicalAutomaticBuildJson(record)}\n`, "utf8");
  return opaqueHandoffRef;
}

describe("automatic build executor.open", () => {
  it("opens one create-only session and makes every replay resume the same first GENERATE lease", () => {
    const value = fixture("idempotent");

    const first = openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:00:01.000Z",
    });
    const replay = openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:00:02.000Z",
    });

    const generated = expectGenerate(first);
    expect(replay).toEqual(first);
    expect(generated.semantic_prompt).not.toContain("automatic_build_dispatch_executor.v1");
    expect(generated.semantic_input).toContain("deterministic executor-open fixture");
    expect(Object.keys(generated).sort()).toEqual([
      "kind",
      "opaque_session_ref",
      "output_contract",
      "semantic_input",
      "semantic_prompt",
    ]);
    expect(readdirSync(path.join(value.registryRoot, "executor-opens")))
      .toEqual([`${value.envelope.opaque_handoff_ref}.json`]);
    const attempts = readAutomaticBuildAttemptSnapshot(value.target).stages[value.envelope.manifest.stage] ?? {};
    expect(Object.keys(attempts)).toEqual([value.envelope.manifest.ordered_work_unit_ids[0]]);
    expect(Object.values(attempts)[0]?.last_attempt).toBe(1);
  }, 15_000);

  it("reissues the same opaque ref without rewriting its first issued timestamp", () => {
    const value = fixture("reissue");
    const reissued = issueAutomaticBuildOpaqueHandoff({
      target: value.target,
      kind: "public_dispatch",
      owner_identity: {
        version: "automatic_build_dispatch_owner_identity.v1",
        stage: value.envelope.manifest.stage,
        dispatch_id: value.envelope.manifest.dispatch_id,
        dispatch_run_id: value.envelope.dispatch_run_id,
      },
      executor_handoff: value.envelope.executor_handoff,
      issued_at: "2026-08-08T06:00:03.000Z",
    });

    expect(reissued.opaque_handoff_ref).toBe(value.envelope.opaque_handoff_ref);
    const record = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "opaque-handoffs",
      `${reissued.opaque_handoff_ref}.json`,
    ), "utf8"));
    expect(record.issued_at).toBe("2026-08-08T06:00:00.000Z");
    expectNoAttempts(value);
  });

  it("rejects malformed, overlong, and unknown refs without touching task state", () => {
    const value = fixture("bad-ref");

    expect(() => openAutomaticBuildExecutorSession("../escape")).toThrow(/ref/i);
    expect(() => openAutomaticBuildExecutorSession("x".repeat(1_025))).toThrow(/ref/i);
    expect(() => openAutomaticBuildExecutorSession(`abhandoff1_${"0".repeat(64)}`))
      .toThrow(/does not exist/i);
    expectNoAttempts(value);
  });

  it("rejects missing handoff and missing publish marker before task claim", () => {
    const missingHandoff = fixture("missing-handoff");
    unlinkSync(missingHandoff.envelope.executor_handoff.path);
    expect(() => openAutomaticBuildExecutorSession(missingHandoff.envelope.opaque_handoff_ref))
      .toThrow(/handoff/i);
    expectNoAttempts(missingHandoff);

    const missingMarker = fixture("missing-marker");
    unlinkSync(missingMarker.envelope.manifest_path);
    expect(() => openAutomaticBuildExecutorSession(missingMarker.envelope.opaque_handoff_ref))
      .toThrow(/dispatch|manifest|exist/i);
    expectNoAttempts(missingMarker);
  });

  it("rejects handoff bytes and manifest identity drift before task claim", () => {
    const handoffDrift = fixture("handoff-drift");
    writeFileSync(handoffDrift.envelope.executor_handoff.path, "{}\n", "utf8");
    expect(() => openAutomaticBuildExecutorSession(handoffDrift.envelope.opaque_handoff_ref))
      .toThrow(/handoff|digest|invalid/i);
    expectNoAttempts(handoffDrift);

    const manifestDrift = fixture("manifest-drift");
    const manifest = JSON.parse(readFileSync(manifestDrift.envelope.manifest_path, "utf8"));
    manifest.dispatch_run_id = "run-drifted";
    writeFileSync(manifestDrift.envelope.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    expect(() => openAutomaticBuildExecutorSession(manifestDrift.envelope.opaque_handoff_ref))
      .toThrow(/manifest|dispatch/i);
    expectNoAttempts(manifestDrift);
  });

  it("revalidates strict JSON and prompt hash even when every outer digest is rewritten", () => {
    const promptDrift = fixture("prompt-drift");
    const handoff = JSON.parse(readFileSync(promptDrift.envelope.executor_handoff.path, "utf8"));
    handoff.prompt_sha256 = "0".repeat(64);
    const promptDriftRef = forgeOuterConsistentHandoff(
      promptDrift,
      Buffer.from(`${JSON.stringify(handoff)}\n`, "utf8"),
    );
    expect(() => openAutomaticBuildExecutorSession(promptDriftRef))
      .toThrow(/handoff content|prompt|invalid/i);
    expectNoAttempts(promptDrift);

    const invalidJson = fixture("invalid-json");
    const invalidJsonRef = forgeOuterConsistentHandoff(
      invalidJson,
      Buffer.from("{not-json}\n", "utf8"),
    );
    expect(() => openAutomaticBuildExecutorSession(invalidJsonRef))
      .toThrow(/handoff JSON|invalid/i);
    expectNoAttempts(invalidJson);
  });

  it("rejects a symlinked published run before task claim", () => {
    const value = fixture("symlink");
    const runDirectory = path.dirname(value.envelope.manifest_path);
    const relocated = path.join(value.root, "relocated-dispatch-run");
    renameSync(runDirectory, relocated);
    mkdirSync(path.dirname(runDirectory), { recursive: true });
    symlinkSync(relocated, runDirectory, process.platform === "win32" ? "junction" : "dir");

    expect(() => openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref))
      .toThrow(/symlink/i);
    expectNoAttempts(value);
  });

  it("returns durable terminal state without creating an open record or task attempt", () => {
    const value = fixture("terminal");
    automaticBuildDispatchFinish(
      value.source,
      value.root,
      value.envelope.manifest.stage,
      value.envelope.manifest.dispatch_id,
      {
        dispatch_run_id: value.envelope.dispatch_run_id,
        terminal_reason: "executor_interrupted",
        interruption: {
          diagnostic_code: "harness_cancelled",
          reporter: "root_supervisor",
          last_command_role: "unknown",
        },
        now: "2026-08-08T06:00:04.000Z",
      },
    );

    expect(openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:00:05.000Z",
    })).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "DONE", status: "interrupted" },
    });
    expect(() => readdirSync(path.join(value.registryRoot, "executor-opens"))).toThrow();
    expectNoAttempts(value);
  });
});

describe("automatic build public executor session S3", () => {
  it("runs an ordered public dispatch through the code-owned candidate sink to a canonical terminal receipt", () => {
    const value = fixture("complete");
    let current = openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:10:01.000Z",
    });
    const sessionRefs: string[] = [];

    for (let ordinal = 0; current.action.kind === "GENERATE"; ordinal += 1) {
      expect(ordinal).toBeLessThan(16);
      const action = expectGenerate(current);
      sessionRefs.push(action.opaque_session_ref);
      current = submitAutomaticBuildExecutorCandidate(
        action.opaque_session_ref,
        candidateFor(value.root, action, String(ordinal)),
        { now: `2026-08-08T06:10:${String(ordinal + 2).padStart(2, "0")}.000Z` },
      );
    }

    expect(sessionRefs).toHaveLength(value.envelope.manifest.ordered_work_unit_ids.length);
    expect(current).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "DONE", status: "committed" },
    });
    expect(openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:11:00.000Z",
    })).toEqual(current);
    expect(JSON.stringify(current)).not.toMatch(/content_hash|nodes|edges|candidate|semantic_input/u);
  }, 15_000);

  it("replays an identical submit without another attempt and rejects a conflicting candidate", () => {
    const value = fixture("submit-replay");
    const action = expectGenerate(openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:20:01.000Z",
    }));
    const candidate = candidateFor(value.root, action, "stable");
    const first = submitAutomaticBuildExecutorCandidate(action.opaque_session_ref, candidate, {
      now: "2026-08-08T06:20:02.000Z",
    });
    const snapshot = readAutomaticBuildAttemptSnapshot(value.target);
    expect(submitAutomaticBuildExecutorCandidate(action.opaque_session_ref, candidate, {
      now: "2026-08-08T06:20:03.000Z",
    })).toEqual(first);
    expect(readAutomaticBuildAttemptSnapshot(value.target)).toEqual(snapshot);

    const conflict = path.join(value.root, "candidate-conflict.json");
    writeFileSync(conflict, "{\"different\":true}\n", "utf8");
    expect(() => submitAutomaticBuildExecutorCandidate(action.opaque_session_ref, conflict, {
      now: "2026-08-08T06:20:04.000Z",
    })).toThrow(/candidate.*different|conflict/i);
  }, 15_000);

  it("records semantic failure as a retryable task outcome", () => {
    const failedValue = fixture("semantic-failure");
    const failedAction = expectGenerate(openAutomaticBuildExecutorSession(failedValue.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:30:01.000Z",
    }));
    expect(failAutomaticBuildExecutorSession(failedAction.opaque_session_ref, {
      diagnostic_code: "semantic_output_invalid",
      now: "2026-08-08T06:30:02.000Z",
    })).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "DONE", status: "retryable_failure" },
    });
    const failedAttempts = readAutomaticBuildAttemptSnapshot(failedValue.target)
      .stages[failedValue.envelope.manifest.stage] ?? {};
    expect(Object.values(failedAttempts)[0]).toMatchObject({
      failures: 1,
      semantic_attempt: 1,
      lease_epoch: 1,
    });
  }, 15_000);

  it("resumes the same executor session after a heartbeat", () => {
    const heartbeatValue = fixture("heartbeat-resume");
    const heartbeatAction = expectGenerate(openAutomaticBuildExecutorSession(
      heartbeatValue.envelope.opaque_handoff_ref,
      { now: "2026-08-08T06:40:01.000Z" },
    ));
    expect(heartbeatAutomaticBuildExecutorSession(heartbeatAction.opaque_session_ref, {
      now: "2026-08-08T06:40:02.000Z",
      ttl_ms: 60_000,
    })).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "WAIT", retry_after_ms: 1_000 },
    });
    expect(expectGenerate(openAutomaticBuildExecutorSession(heartbeatValue.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:40:03.000Z",
    })).opaque_session_ref).toBe(heartbeatAction.opaque_session_ref);
  }, 15_000);

  it("persists executor interruption across reopen", () => {
    const interruptedValue = fixture("interrupted");
    const interruptedAction = expectGenerate(openAutomaticBuildExecutorSession(
      interruptedValue.envelope.opaque_handoff_ref,
      { now: "2026-08-08T06:50:01.000Z" },
    ));
    const interrupted = interruptAutomaticBuildExecutorSession(interruptedAction.opaque_session_ref, {
      diagnostic_code: "harness_cancelled",
      reporter: "executor",
      last_command_role: "task_input",
      now: "2026-08-08T06:50:02.000Z",
    });
    expect(interrupted).toEqual({
      version: "automatic_build_executor_session.v1",
      action: { kind: "DONE", status: "interrupted" },
    });
    expect(openAutomaticBuildExecutorSession(interruptedValue.envelope.opaque_handoff_ref, {
      now: "2026-08-08T06:50:03.000Z",
    })).toEqual(interrupted);
  }, 15_000);
});
import { createHash } from "node:crypto";
