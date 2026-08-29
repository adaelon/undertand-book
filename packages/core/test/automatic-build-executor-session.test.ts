import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
  nextAutomaticBuildExecutorInput,
  openAutomaticBuildExecutorSession,
  openAutomaticBuildExecutorSessionV2,
  runAutomaticBuildExecutorSessionCommand,
  startAutomaticBuildExecutorGeneration,
  submitAutomaticBuildExecutorCandidate,
  submitAutomaticBuildExecutorCandidateV2,
  type AutomaticBuildExecutorSessionResponseV1,
  type AutomaticBuildExecutorSessionResponseV2,
} from "../src/automatic-build-executor-session";
import { canonicalAutomaticBuildJson } from "../src/automatic-build-protocol";
import { BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2 } from "../src/build-executor-connection-capability";
import { createBuildExecutorToolAdapter } from "../src/build-executor-tool-adapter";
import {
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
  measureExecutorTransportResponse,
} from "../src/executor-transport";
import {
  readAutomaticBuildAttemptSnapshot,
  readAutomaticBuildExecutionIdentity,
} from "../src/automatic-build-task-store";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import {
  automaticBuildDispatchFinish,
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";
import { createBuildExecutorMcpSession } from "../../../skills/build/build-executor-mcp";

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

function fixture(
  label: string,
  sourceBody = "A deterministic executor-open fixture.",
  heading = "Guide",
) {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-executor-open-${label}-`));
  const registryRoot = path.join(root, "driver-registry");
  process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registryRoot;
  const source = path.join(root, "guide.md");
  writeFileSync(source, `# ${heading}\n\n${sourceBody}\n`, "utf8");
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

function expectDeliverInput(
  response: AutomaticBuildExecutorSessionResponseV2,
): Extract<AutomaticBuildExecutorSessionResponseV2["action"], { kind: "DELIVER_INPUT" }> {
  expect(response.version).toBe("automatic_build_executor_session.v2");
  expect(response.action.kind).toBe("DELIVER_INPUT");
  if (response.action.kind !== "DELIVER_INPUT") throw new Error("expected DELIVER_INPUT executor action");
  return response.action;
}

function expectInputChunk(
  response: AutomaticBuildExecutorSessionResponseV2,
): Extract<AutomaticBuildExecutorSessionResponseV2["action"], { kind: "INPUT_CHUNK" }> {
  expect(response.version).toBe("automatic_build_executor_session.v2");
  expect(response.action.kind).toBe("INPUT_CHUNK");
  if (response.action.kind !== "INPUT_CHUNK") throw new Error("expected INPUT_CHUNK executor action");
  return response.action;
}

function expectGenerationGrant(
  response: AutomaticBuildExecutorSessionResponseV2,
): Extract<AutomaticBuildExecutorSessionResponseV2["action"], { kind: "GENERATION_GRANT" }> {
  expect(response.version).toBe("automatic_build_executor_session.v2");
  expect(response.action.kind).toBe("GENERATION_GRANT");
  if (response.action.kind !== "GENERATION_GRANT") {
    throw new Error("expected GENERATION_GRANT executor action");
  }
  return response.action;
}

function expectGenerateV2(
  response: AutomaticBuildExecutorSessionResponseV2,
): Extract<AutomaticBuildExecutorSessionResponseV2["action"], { kind: "GENERATE" }> {
  expect(response.version).toBe("automatic_build_executor_session.v2");
  expect(response.action.kind).toBe("GENERATE");
  if (response.action.kind !== "GENERATE") throw new Error("expected V2 GENERATE executor action");
  return response.action;
}

function startV2Generation(
  value: ReturnType<typeof fixture>,
  now: string,
): Extract<AutomaticBuildExecutorSessionResponseV2["action"], { kind: "GENERATE" }> {
  const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
    value.envelope.opaque_handoff_ref,
    { now },
  ));
  let request = delivery.next_request;
  for (let ordinal = 0; ordinal < 128; ordinal += 1) {
    const response = nextAutomaticBuildExecutorInput(request, { now });
    if (response.action.kind === "GENERATION_GRANT") {
      return expectGenerateV2(startAutomaticBuildExecutorGeneration({
        version: "automatic_build_executor_generation_start_request.v1",
        opaque_session_ref: response.action.grant.opaque_session_ref,
        generation_grant_ref: response.action.grant.generation_grant_ref,
      }, { now }));
    }
    const chunk = expectInputChunk(response).chunk;
    request = {
      version: "automatic_build_executor_input_next_request.v2",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      previous_chunk_receipt: chunk.chunk_receipt,
    };
  }
  throw new Error("expected V2 generation action");
}

function deterministicUtf8Text(seed: string, targetBytes: number): string {
  const patterns = ["ab界🙂", "cd文🚀", "ef模型🧭"] as const;
  const seedByte = createHash("sha256").update(seed, "utf8").digest()[0];
  const pattern = patterns[seedByte % patterns.length];
  const patternBytes = Buffer.byteLength(pattern, "utf8");
  const repetitions = Math.floor(targetBytes / patternBytes);
  const tail = String.fromCharCode(97 + seedByte % 26);
  const value = `${pattern.repeat(repetitions)}${tail.repeat(targetBytes - repetitions * patternBytes)}`;
  expect(Buffer.byteLength(value, "utf8")).toBe(targetBytes);
  return value;
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
  it("documents that the V1 GENERATE envelope would inline and overflow a 317,247-byte input", () => {
    const value = fixture("full-size-envelope");
    const current = openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T05:59:59.000Z",
    });
    const action = expectGenerate(current);
    const semanticInput = deterministicUtf8Text("executor-open-317247", 317_247);
    const syntheticFullSizeResponse: AutomaticBuildExecutorSessionResponseV1 = {
      ...current,
      action: { ...action, semantic_input: semanticInput },
    };
    const measured = measureExecutorTransportResponse(
      syntheticFullSizeResponse,
      semanticInput,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
    );

    expect(Object.hasOwn(action, "semantic_input")).toBe(true);
    expect(measured.status).toBe("blocked");
    expect(measured.blocking_reasons).toContain("byte_cap_exceeded");
    expect(measured.blocking_reasons).toContain("token_cap_exceeded");
    expect(measured.serialized_response).toContain("semantic_input");
  }, 15_000);

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
      last_failure_diagnostic: {
        category: "schema",
        code: "semantic_output_invalid",
      },
      semantic_attempt: 1,
      lease_epoch: 1,
    });
  }, 15_000);

  it("maps unknown V1 executor reports to generation/executor_failed without inventing writer facts", () => {
    const incidentCodes = [
      "semantic_input_tool_result_truncated",
      "executor_transport_closed",
      "candidate_source_command_failed",
    ];
    for (const [index, diagnosticCode] of incidentCodes.entries()) {
      const value = fixture(`unknown-executor-code-${index}`);
      const action = expectGenerate(openAutomaticBuildExecutorSession(value.envelope.opaque_handoff_ref, {
        now: `2026-08-08T06:35:0${index}.000Z`,
      }));
      failAutomaticBuildExecutorSession(action.opaque_session_ref, {
        diagnostic_code: diagnosticCode,
        message: `PRIVATE_EXECUTOR_DETAIL_${index}`,
        now: `2026-08-08T06:35:1${index}.000Z`,
      });
      const record = Object.values(readAutomaticBuildAttemptSnapshot(value.target)
        .stages[value.envelope.manifest.stage] ?? {})[0];
      expect(record).toMatchObject({
        failures: 1,
        semantic_attempt: 1,
        last_failure_diagnostic: {
          version: "automatic_build_failure_diagnostic.v3",
          category: "executor",
          code: "executor_failed",
          phase: "generation",
          reported_code_digest: createHash("sha256").update(diagnosticCode).digest("hex"),
        },
      });
      expect(JSON.stringify(record)).not.toMatch(/writer_failed|PRIVATE_EXECUTOR_DETAIL/u);
    }
  }, 30_000);

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

describe("automatic build bounded executor session V2", () => {
  it("delivers prompt and input through bounded receipts, then creates attempt 1 only at generation.start", () => {
    const value = fixture("v2-two-phase");
    const opened = openAutomaticBuildExecutorSessionV2(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T07:00:01.000Z",
    });
    const delivery = expectDeliverInput(opened);
    expect(JSON.stringify(opened)).not.toMatch(/"semantic_prompt":|"semantic_input":|deterministic executor-open fixture/u);
    expect(measureExecutorTransportResponse(
      opened,
      "",
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
    ).status).toBe("within_limit");
    expect(delivery.input_manifest).toMatchObject({
      version: "automatic_build_executor_input_manifest.v2",
      opaque_session_ref: delivery.next_request.opaque_session_ref,
      generation_input_ref: delivery.next_request.generation_input_ref,
      transport_profile_digest: CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.profile_digest,
      segments: [
        { kind: "semantic_prompt" },
        { kind: "semantic_input" },
      ],
    });
    const deliveryLedger = readFileSync(path.join(
      value.registryRoot,
      "executor-v2-delivery-sessions",
      `${delivery.input_manifest.opaque_session_ref}.json`,
    ), "utf8");
    expect(deliveryLedger).not.toMatch(/"semantic_prompt":|"semantic_input":|payload_utf8|deterministic executor-open fixture/u);
    expectNoAttempts(value);
    expect(readAutomaticBuildExecutionIdentity(
      value.target,
      value.envelope.manifest.stage,
      value.envelope.manifest.ordered_work_unit_ids[0],
    )).toBeUndefined();

    const bodies = new Map<string, string>();
    let request = delivery.next_request;
    let response = nextAutomaticBuildExecutorInput(request, {
      now: "2026-08-08T07:00:02.000Z",
    });
    let grantAction: ReturnType<typeof expectGenerationGrant> | undefined;
    for (let ordinal = 0; ordinal < 128; ordinal += 1) {
      if (response.action.kind === "GENERATION_GRANT") {
        grantAction = expectGenerationGrant(response);
        break;
      }
      const chunkAction = expectInputChunk(response);
      const chunk = chunkAction.chunk;
      expect(chunk.ordinal).toBe(ordinal);
      expect(measureExecutorTransportResponse(
        response,
        chunk.payload_utf8,
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
      ).status).toBe("within_limit");
      bodies.set(chunk.segment, `${bodies.get(chunk.segment) ?? ""}${chunk.payload_utf8}`);
      expectNoAttempts(value);
      request = {
        version: "automatic_build_executor_input_next_request.v2",
        opaque_session_ref: delivery.input_manifest.opaque_session_ref,
        generation_input_ref: delivery.input_manifest.generation_input_ref,
        previous_chunk_receipt: chunk.chunk_receipt,
      };
      response = nextAutomaticBuildExecutorInput(request, {
        now: `2026-08-08T07:00:${String(ordinal + 3).padStart(2, "0")}.000Z`,
      });
    }
    if (!grantAction) throw new Error("expected generation grant");
    expect(bodies.get("semantic_prompt")).toBeTruthy();
    expect(bodies.get("semantic_input")).toContain("deterministic executor-open fixture");
    for (const segment of delivery.input_manifest.segments) {
      const body = bodies.get(segment.kind) ?? "";
      expect(Buffer.byteLength(body, "utf8")).toBe(segment.byte_length);
      expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(segment.sha256);
    }
    expect(grantAction.grant).toMatchObject({
      version: "automatic_build_executor_generation_grant.v1",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
    });
    expect(nextAutomaticBuildExecutorInput(request, {
      now: "2026-08-08T07:01:30.000Z",
    })).toEqual(response);
    const reopenedBeforeStart = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      value.envelope.opaque_handoff_ref,
      {
      now: "2026-08-08T07:01:31.000Z",
      },
    ));
    expect(reopenedBeforeStart.input_manifest).toEqual(delivery.input_manifest);
    expect(reopenedBeforeStart.next_request).not.toHaveProperty("previous_chunk_receipt");
    expectNoAttempts(value);

    const startRequest = {
      version: "automatic_build_executor_generation_start_request.v1" as const,
      opaque_session_ref: grantAction.grant.opaque_session_ref,
      generation_grant_ref: grantAction.grant.generation_grant_ref,
    };
    const generatedResponse = startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-08-08T07:01:32.000Z",
    });
    const generated = expectGenerateV2(generatedResponse);
    expect(generated.semantic_attempt).toBe(1);
    expect(generated.output_contract.max_bytes)
      .toBe(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.max_candidate_request_bytes);
    expect(JSON.stringify(generatedResponse)).not.toMatch(/"semantic_prompt":|"semantic_input":|deterministic executor-open fixture/u);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0 });
    expect(startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-08-08T07:01:33.000Z",
    })).toEqual(generatedResponse);
    const reopenedAfterStart = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      value.envelope.opaque_handoff_ref,
      {
      now: "2026-08-08T07:01:34.000Z",
      },
    ));
    expect(reopenedAfterStart.input_manifest).toEqual(delivery.input_manifest);
    expect(reopenedAfterStart.next_request).not.toHaveProperty("previous_chunk_receipt");
    expect(runAutomaticBuildExecutorSessionCommand({
      ...startRequest,
      now: "2026-08-08T07:01:35.000Z",
    })).toEqual(generatedResponse);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0 });
  }, 30_000);

  it("rehydrates completed input for a replacement child after generation.start without another attempt", () => {
    const value = fixture("v2-post-start-rehydrate", "x".repeat(20_000));
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:05:01.000Z" },
    ));
    expect(delivery.input_manifest.total_chunk_count).toBeGreaterThan(2);

    let request = delivery.next_request;
    let grantAction: ReturnType<typeof expectGenerationGrant> | undefined;
    for (let ordinal = 0; ordinal < 128; ordinal += 1) {
      const response = nextAutomaticBuildExecutorInput(request, {
        now: "2026-08-08T07:05:02.000Z",
      });
      if (response.action.kind === "GENERATION_GRANT") {
        grantAction = expectGenerationGrant(response);
        break;
      }
      const chunk = expectInputChunk(response).chunk;
      request = {
        version: "automatic_build_executor_input_next_request.v2",
        opaque_session_ref: delivery.input_manifest.opaque_session_ref,
        generation_input_ref: delivery.input_manifest.generation_input_ref,
        previous_chunk_receipt: chunk.chunk_receipt,
      };
    }
    if (!grantAction) throw new Error("expected generation grant before replacement-child replay");

    const startRequest = {
      version: "automatic_build_executor_generation_start_request.v1" as const,
      opaque_session_ref: grantAction.grant.opaque_session_ref,
      generation_grant_ref: grantAction.grant.generation_grant_ref,
    };
    const generatedResponse = startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-08-08T07:05:03.000Z",
    });
    expect(expectGenerateV2(generatedResponse).semantic_attempt).toBe(1);

    const replacementDelivery = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:05:04.000Z" },
    ));
    expect(replacementDelivery.input_manifest).toEqual(delivery.input_manifest);
    expect(replacementDelivery.next_request).not.toHaveProperty("previous_chunk_receipt");

    const replayedBodies = new Map<string, string>();
    let replayResponse = nextAutomaticBuildExecutorInput(replacementDelivery.next_request, {
      now: "2026-08-08T07:05:05.000Z",
    });
    let replayedGrant: ReturnType<typeof expectGenerationGrant> | undefined;
    for (let ordinal = 0; ordinal < 128; ordinal += 1) {
      if (replayResponse.action.kind === "GENERATION_GRANT") {
        replayedGrant = expectGenerationGrant(replayResponse);
        break;
      }
      const chunk = expectInputChunk(replayResponse).chunk;
      expect(chunk.ordinal).toBe(ordinal);
      replayedBodies.set(
        chunk.segment,
        `${replayedBodies.get(chunk.segment) ?? ""}${chunk.payload_utf8}`,
      );
      replayResponse = nextAutomaticBuildExecutorInput({
        version: "automatic_build_executor_input_next_request.v2",
        opaque_session_ref: delivery.input_manifest.opaque_session_ref,
        generation_input_ref: delivery.input_manifest.generation_input_ref,
        previous_chunk_receipt: chunk.chunk_receipt,
      }, { now: "2026-08-08T07:05:06.000Z" });
    }
    if (!replayedGrant) throw new Error("expected generation grant after replacement-child replay");
    expect(replayedGrant.grant).toEqual(grantAction.grant);
    for (const segment of delivery.input_manifest.segments) {
      const body = replayedBodies.get(segment.kind) ?? "";
      expect(Buffer.byteLength(body, "utf8")).toBe(segment.byte_length);
      expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(segment.sha256);
    }
    expect(startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-08-08T07:05:07.000Z",
    })).toEqual(generatedResponse);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0 });
  }, 30_000);

  it("replays the same next request byte-identically and rejects unknown, tampered, or cross-session receipts", () => {
    const left = fixture("v2-receipt-left");
    const leftDelivery = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      left.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:10:01.000Z" },
    ));
    const first = nextAutomaticBuildExecutorInput(leftDelivery.next_request, {
      now: "2026-08-08T07:10:02.000Z",
    });
    const firstChunk = expectInputChunk(first).chunk;
    for (let replay = 0; replay < 5; replay += 1) {
      expect(nextAutomaticBuildExecutorInput(leftDelivery.next_request, {
        now: "2026-08-08T07:10:03.000Z",
      })).toEqual(first);
    }
    expect(nextAutomaticBuildExecutorInput({
      ...leftDelivery.next_request,
      previous_chunk_receipt: firstChunk.chunk_receipt,
    }, { now: "2026-08-08T07:10:03.500Z" }).action.kind)
      .toMatch(/INPUT_CHUNK|GENERATION_GRANT/u);

    expect(() => nextAutomaticBuildExecutorInput({
      ...leftDelivery.next_request,
      previous_chunk_receipt: `abchunk1_${"0".repeat(64)}`,
    }, { now: "2026-08-08T07:10:04.000Z" })).toThrow(/receipt/i);
    expect(() => nextAutomaticBuildExecutorInput({
      ...leftDelivery.next_request,
      previous_chunk_receipt: `${firstChunk.chunk_receipt.slice(0, -1)}${
        firstChunk.chunk_receipt.endsWith("0") ? "1" : "0"
      }`,
    }, { now: "2026-08-08T07:10:05.000Z" })).toThrow(/receipt/i);

    const right = fixture("v2-receipt-right");
    const rightDelivery = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      right.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:10:06.000Z" },
    ));
    const rightChunk = expectInputChunk(nextAutomaticBuildExecutorInput(rightDelivery.next_request, {
      now: "2026-08-08T07:10:07.000Z",
    })).chunk;
    expect(() => nextAutomaticBuildExecutorInput({
      ...leftDelivery.next_request,
      previous_chunk_receipt: rightChunk.chunk_receipt,
    }, { now: "2026-08-08T07:10:08.000Z" })).toThrow(/receipt|session/i);
    expectNoAttempts(left);
    expectNoAttempts(right);
  }, 30_000);

  it("reopens at the first unconfirmed chunk and keeps a multi-chunk interruption at attempt zero", () => {
    const value = fixture("v2-resume", "x".repeat(20_000));
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:20:01.000Z" },
    ));
    expect(delivery.input_manifest.total_chunk_count).toBeGreaterThan(2);
    const firstResponse = nextAutomaticBuildExecutorInput(delivery.next_request, {
      now: "2026-08-08T07:20:02.000Z",
    });
    const first = expectInputChunk(firstResponse).chunk;
    expect(openAutomaticBuildExecutorSessionV2(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T07:20:03.000Z",
    })).toEqual({
      ...openAutomaticBuildExecutorSessionV2(value.envelope.opaque_handoff_ref, {
        now: "2026-08-08T07:20:04.000Z",
      }),
    });
    expectNoAttempts(value);

    const secondResponse = nextAutomaticBuildExecutorInput({
      version: "automatic_build_executor_input_next_request.v2",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      previous_chunk_receipt: first.chunk_receipt,
    }, { now: "2026-08-08T07:20:05.000Z" });
    const second = expectInputChunk(secondResponse).chunk;
    const reopened = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:20:06.000Z" },
    ));
    expect(reopened.next_request.previous_chunk_receipt).toBe(first.chunk_receipt);
    expect(nextAutomaticBuildExecutorInput(reopened.next_request, {
      now: "2026-08-08T07:20:07.000Z",
    })).toEqual(secondResponse);
    expect(second.ordinal).toBe(1);
    expectNoAttempts(value);
  }, 30_000);

  it("rejects generation.start before complete delivery and leaves terminal dispatches body-free", () => {
    const pending = fixture("v2-start-before-delivery");
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV2(
      pending.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:30:01.000Z" },
    ));
    expect(() => startAutomaticBuildExecutorGeneration({
      version: "automatic_build_executor_generation_start_request.v1",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_grant_ref: `abgrant1_${"0".repeat(64)}`,
    }, { now: "2026-08-08T07:30:02.000Z" })).toThrow(/complete input delivery/i);
    expectNoAttempts(pending);

    const terminal = fixture("v2-terminal");
    automaticBuildDispatchFinish(
      terminal.source,
      terminal.root,
      terminal.envelope.manifest.stage,
      terminal.envelope.manifest.dispatch_id,
      {
        dispatch_run_id: terminal.envelope.dispatch_run_id,
        terminal_reason: "executor_interrupted",
        interruption: {
          diagnostic_code: "harness_cancelled",
          reporter: "root_supervisor",
          last_command_role: "unknown",
        },
        now: "2026-08-08T07:30:03.000Z",
      },
    );
    const done = openAutomaticBuildExecutorSessionV2(terminal.envelope.opaque_handoff_ref, {
      now: "2026-08-08T07:30:04.000Z",
    });
    expect(done).toEqual({
      version: "automatic_build_executor_session.v2",
      action: { kind: "DONE", status: "interrupted" },
    });
    expect(JSON.stringify(done)).not.toMatch(/input_manifest|generation_grant|payload_utf8/u);
    expectNoAttempts(terminal);
  }, 30_000);

  it("submits one structured JsonValue through the bound sink with canonical replay and no path", () => {
    const value = fixture("v2-structured-submit");
    const generated = startV2Generation(value, "2026-08-08T07:40:01.000Z");
    expect(generated.candidate_sink_ref).toMatch(/^absink1_[a-f0-9]{64}$/u);
    expect(generated).not.toHaveProperty("candidate_path");
    const request = {
      version: "automatic_build_executor_candidate_submit.v2" as const,
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    };

    const first = submitAutomaticBuildExecutorCandidateV2(request, {
      now: "2026-08-08T07:40:02.000Z",
    });
    const taskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${generated.opaque_session_ref}.json`,
    ), "utf8")) as { lease_ref: string };
    const mailbox = path.join(path.dirname(taskSession.lease_ref), "candidate.json");
    expect(readFileSync(mailbox, "utf8")).toBe("{\"edges\":[],\"nodes\":[]}\n");
    expect(JSON.stringify(first)).not.toMatch(/"nodes"|"edges"|candidate_path|candidate_sink_ref/u);

    expect(runAutomaticBuildExecutorSessionCommand({
      ...request,
      now: "2026-08-08T07:40:03.000Z",
    })).toEqual(first);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0, submit_revision: 2 });
    expect(() => submitAutomaticBuildExecutorCandidateV2({
      ...request,
      candidate: { nodes: [], edges: [], changed: true },
    }, { now: "2026-08-08T07:40:04.000Z" })).toThrow(/candidate.*different|conflict/i);
  }, 30_000);

  it("keeps a temporarily unavailable candidate sink on the same attempt and replays the same value", () => {
    const value = fixture("v2-candidate-sink-replay");
    const generated = startV2Generation(value, "2026-08-08T07:42:01.000Z");
    const taskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${generated.opaque_session_ref}.json`,
    ), "utf8")) as { lease_ref: string };
    const validationPath = path.join(path.dirname(taskSession.lease_ref), "validation.json");
    mkdirSync(validationPath);
    const request = {
      version: "automatic_build_executor_candidate_submit.v2" as const,
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    };

    let unavailable: unknown;
    try {
      submitAutomaticBuildExecutorCandidateV2(request, {
        now: "2026-08-08T07:42:02.000Z",
      });
    } catch (error) {
      unavailable = error;
    }
    expect(unavailable).toMatchObject({
      failure_diagnostic: {
        version: "automatic_build_failure_diagnostic.v3",
        category: "executor",
        code: "candidate_sink_unavailable",
        phase: "candidate_sink",
      },
    });
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ failures: 0, semantic_attempt: 1, lease_epoch: 1, submit_revision: 0 });

    rmSync(validationPath, { recursive: true });
    submitAutomaticBuildExecutorCandidateV2(request, {
      now: "2026-08-08T07:42:03.000Z",
    });
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ failures: 0, semantic_attempt: 1, lease_epoch: 1, submit_revision: 1 });
  }, 30_000);

  it("keeps an untyped downstream candidate rejection as a redacted internal writer failure", () => {
    const value = fixture("v2-structured-schema-failure");
    const generated = startV2Generation(value, "2026-08-08T07:45:01.000Z");
    const response = submitAutomaticBuildExecutorCandidateV2({
      version: "automatic_build_executor_candidate_submit.v2",
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { invalid_shape: true },
    }, { now: "2026-08-08T07:45:02.000Z" });

    expect(JSON.stringify(response)).not.toMatch(/invalid_shape|writer_failed|candidate_path/u);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({
        semantic_attempt: 1,
        lease_epoch: 1,
        failures: 1,
        submit_revision: 1,
        last_failure_diagnostic: {
          version: "automatic_build_failure_diagnostic.v3",
          category: "internal",
          code: "writer_failed",
          phase: "artifact_writer",
        },
      });
  }, 30_000);

  it("accepts realistic null source_lid candidates through the real MCP wrapper", () => {
    const value = fixture(
      "v2-structured-null-source-lid",
      `T7_CLI_SEMANTIC_INPUT_SENTINEL\n${"bounded synthetic context ".repeat(900)}`,
      "T7 synthetic CLI fixture",
    );
    const mcp = createBuildExecutorMcpSession({
      bootstrap_digest: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.session_protocol,
      session_private_root: value.registryRoot,
    });
    let id = 1;
    const call = (name: string, args: unknown) => {
      const rpc = mcp.handle_message({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name, arguments: args },
      }) as {
        result?: { content: Array<{ text: string }>; isError: boolean };
        error?: unknown;
      };
      expect(rpc.error).toBeUndefined();
      expect(rpc.result).toBeDefined();
      return {
        isError: rpc.result?.isError ?? true,
        response: JSON.parse(
          rpc.result?.content[0]?.text ?? "null",
        ) as AutomaticBuildExecutorSessionResponseV2,
      };
    };
    let current = call("executor.open", {
      version: "automatic_build_executor_open_request.v2",
      opaque_handoff_ref: value.envelope.opaque_handoff_ref,
    });
    for (let ordinal = 0; ordinal < 128; ordinal += 1) {
      expect(current.isError).toBe(false);
      const action = current.response.action;
      if (action.kind === "DELIVER_INPUT") {
        current = call("executor.input.next", action.next_request);
      } else if (action.kind === "INPUT_CHUNK") {
        current = call("executor.input.next", {
          version: "automatic_build_executor_input_next_request.v2",
          opaque_session_ref: action.chunk.opaque_session_ref,
          generation_input_ref: action.chunk.generation_input_ref,
          previous_chunk_receipt: action.chunk.chunk_receipt,
        });
      } else if (action.kind === "GENERATION_GRANT") {
        current = call("executor.generation.start", {
          version: "automatic_build_executor_generation_start_request.v1",
          opaque_session_ref: action.grant.opaque_session_ref,
          generation_grant_ref: action.grant.generation_grant_ref,
        });
      } else if (action.kind === "GENERATE") {
        current = call("executor.submit_candidate", {
          version: "automatic_build_executor_candidate_submit.v2",
          opaque_session_ref: action.opaque_session_ref,
          candidate_sink_ref: action.candidate_sink_ref,
          candidate: {
            nodes: [
              {
                id: "entity:t7_synthetic_cli_fixture",
                type: "entity",
                name: "T7 synthetic CLI fixture",
                occurrences: ["1.1"],
                source_lid: null,
              },
              {
                id: "entity:t7_cli_semantic_input_sentinel",
                type: "entity",
                name: "T7_CLI_SEMANTIC_INPUT_SENTINEL",
                occurrences: ["1.2"],
                source_lid: null,
              },
              {
                id: "concept:bounded_synthetic_context",
                type: "concept",
                name: "bounded synthetic context",
                occurrences: ["1.2"],
                source_lid: null,
              },
            ],
            edges: [],
          },
        });
        break;
      } else {
        throw new Error(`unexpected pre-submit MCP action: ${action.kind}`);
      }
    }

    expect(current.isError).toBe(false);
    expect(current.response.version).toBe("automatic_build_executor_session.v2");
    expect(["DELIVER_INPUT", "DONE"]).toContain(current.response.action.kind);
    if (current.response.action.kind === "DONE") expect(current.response.action.status).toBe("committed");
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({
        semantic_attempt: 1,
        lease_epoch: 1,
        failures: 0,
        submit_revision: 1,
      });
  }, 30_000);

  it("rejects V2 path submit and malformed, host, non-finite, deep, oversized, or unbound values before mailbox mutation", () => {
    const value = fixture("v2-structured-rejections");
    const generated = startV2Generation(value, "2026-08-08T07:50:01.000Z");
    const taskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${generated.opaque_session_ref}.json`,
    ), "utf8")) as { lease_ref: string };
    const mailbox = path.join(path.dirname(taskSession.lease_ref), "candidate.json");
    const source = path.join(value.root, "forbidden-v2-candidate.json");
    writeFileSync(source, "{\"edges\":[],\"nodes\":[]}\n", "utf8");
    expect(() => submitAutomaticBuildExecutorCandidate(
      generated.opaque_session_ref,
      source,
      { now: "2026-08-08T07:50:02.000Z" },
    )).toThrow(/V2.*candidate_path|candidate_path.*V2/i);

    const validRequest = {
      version: "automatic_build_executor_candidate_submit.v2" as const,
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    };
    const childCapability = Object.freeze({ connection: "expected-child" });
    const adapter = createBuildExecutorToolAdapter({
      authorize_connection: (capability) => capability === childCapability,
    });
    expect(() => adapter.call_tool("executor.submit_candidate", validRequest))
      .toThrow(/child connection capability/i);
    expect(() => adapter.call_tool(
      "executor.submit_candidate",
      validRequest,
      Object.freeze({ connection: "wrong-child" }),
    )).toThrow(/child connection capability/i);
    expect(existsSync(mailbox)).toBe(false);
    expect(() => runAutomaticBuildExecutorSessionCommand({
      ...validRequest,
      candidate_path: source,
    })).toThrow(/unsupported|missing|invalid fields/i);
    expect(() => submitAutomaticBuildExecutorCandidateV2({
      ...validRequest,
      candidate: new Date("2026-08-08T00:00:00.000Z") as never,
    })).toThrow(/JSON value|host object/i);
    expect(() => submitAutomaticBuildExecutorCandidateV2({
      ...validRequest,
      candidate: { value: Number.NaN },
    })).toThrow(/finite|JSON value/i);
    expect(() => submitAutomaticBuildExecutorCandidateV2({
      ...validRequest,
      candidate: { value: Number.POSITIVE_INFINITY },
    })).toThrow(/finite|JSON value/i);
    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth < 80; depth += 1) deep = { child: deep };
    expect(() => submitAutomaticBuildExecutorCandidateV2({
      ...validRequest,
      candidate: deep as never,
    })).toThrow(/depth|JSON value/i);
    expect(() => submitAutomaticBuildExecutorCandidateV2({
      ...validRequest,
      candidate: { value: "x".repeat(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.max_candidate_request_bytes) },
    })).toThrow(/byte|token|exceeds/i);
    expect(() => submitAutomaticBuildExecutorCandidateV2({
      ...validRequest,
      candidate_sink_ref: `absink1_${"0".repeat(64)}`,
    })).toThrow(/sink/i);

    expect(existsSync(mailbox)).toBe(false);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0, submit_revision: 0 });
  }, 30_000);
});
