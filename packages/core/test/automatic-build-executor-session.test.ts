import { createSyntheticRoutabilityFixture, writePass1ProductionTaskArtifact } from "./helpers/model-input-routability-fixture";
import { prepareAutomaticBuildSnapshot } from "../src/build-orchestrator";
import { freezePass1ShadowTask } from "../src/pass1-reduction";
import { automaticBuildGenerationArtifactPath } from "../src/semantic-artifact";
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
  AutomaticBuildExecutorStaleGenerationSessionError,
  automaticBuildExecutorMcpErrorFromSessionError,
  heartbeatAutomaticBuildExecutorSession,
  issueAutomaticBuildOpaqueHandoff,
  interruptAutomaticBuildExecutorSession,
  nextAutomaticBuildExecutorInput,
  openAutomaticBuildExecutorSession,
  openAutomaticBuildExecutorSessionV3,
  runAutomaticBuildExecutorSessionCommand,
  startAutomaticBuildExecutorGeneration,
  submitAutomaticBuildExecutorCandidate,
  submitAutomaticBuildExecutorCandidateV3,
  type AutomaticBuildExecutorSessionResponseV1,
  type AutomaticBuildExecutorSessionResponseV3,
} from "../src/automatic-build-executor-session";
import { canonicalAutomaticBuildJson } from "../src/automatic-build-protocol";
import { BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3 } from "../src/build-executor-connection-capability";
import { createBuildExecutorToolAdapter } from "../src/build-executor-tool-adapter";
import {
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  measureExecutorTransportResponse,
} from "../src/executor-transport";
import {
  readAutomaticBuildAttemptSnapshot,
  readAutomaticBuildExecutionIdentity,
} from "../src/automatic-build-task-store";
import { readAutomaticBuildInputObservation } from "../src/automatic-build-metrics";
import { claimAutomaticBuildTask } from "../src/automatic-build-lease";
import { submitAutomaticBuildCandidate } from "../src/automatic-build-mailbox";
import { ExtractorContractError } from "../src/extractor-contract";
import { automaticBuildPolicyGenerationPath } from "../src/automatic-build-policy-generation";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";
import {
  automaticBuildDispatchFinish,
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";
import { createBuildExecutorMcpSession } from "../../../skills/build/build-executor-mcp";
import {
  inspectAutomaticBuildDispatchRecoveryGeneration,
  type AutomaticBuildRecoveryGenerationIdentity,
} from "../src/automatic-build-dispatch-runtime";

let priorRegistryRoot: string | undefined;
let priorSidecarSelf: string | undefined;

beforeEach(() => {
  priorRegistryRoot = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
  priorSidecarSelf = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
});

afterEach(() => {
  if (priorRegistryRoot === undefined) {
    delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
  } else {
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = priorRegistryRoot;
  }
  if (priorSidecarSelf === undefined) {
    delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
  } else {
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = priorSidecarSelf;
  }
});

function fixture(
  label: string,
  sourceBody = "A deterministic executor-open fixture.",
  heading = "Guide",
  handoffContract: "legacy_v1" | "current_v3" = "legacy_v1",
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
    accepted_plan_digest: plan.preflight.descriptor_plan_digest,
    available_agent_slots: 1,
    executor_dispatches: true,
    build_plan: buildPlan,
  });
  if (!("dispatches" in next.action) || !next.action.dispatches) {
    throw new Error("expected executor-open dispatch");
  }
  const currentEnvelope = next.action.dispatches[0];
  const target = resolveAutomaticBuildTarget(source, root);
  if (handoffContract === "current_v3") {
    return { root, registryRoot, source, target, buildPlan, plan, envelope: currentEnvelope };
  }
  const currentRecordPath = path.join(
    registryRoot,
    "opaque-handoffs",
    `${currentEnvelope.opaque_handoff_ref}.json`,
  );
  const currentRecord = JSON.parse(readFileSync(currentRecordPath, "utf8"));
  const legacyIdentity = {
    version: "automatic_build_opaque_handoff_identity.v1",
    kind: currentRecord.kind,
    target_ref: currentRecord.target_ref,
    target_locator: currentRecord.target_locator,
    owner_identity: currentRecord.owner_identity,
    handoff_path: currentRecord.handoff_path,
    handoff_sha256: currentRecord.handoff_sha256,
    handoff_byte_length: currentRecord.handoff_byte_length,
  };
  const legacyOpaqueHandoffRef = `abhandoff1_${createHash("sha256")
    .update(canonicalAutomaticBuildJson(legacyIdentity), "utf8")
    .digest("hex")}`;
  writeFileSync(path.join(
    registryRoot,
    "opaque-handoffs",
    `${legacyOpaqueHandoffRef}.json`,
  ), `${JSON.stringify({
    version: "automatic_build_opaque_handoff_record.v1",
    opaque_handoff_ref: legacyOpaqueHandoffRef,
    kind: currentRecord.kind,
    target_ref: currentRecord.target_ref,
    target_locator: currentRecord.target_locator,
    owner_identity: currentRecord.owner_identity,
    handoff_path: currentRecord.handoff_path,
    handoff_sha256: currentRecord.handoff_sha256,
    handoff_byte_length: currentRecord.handoff_byte_length,
    issued_at: currentRecord.issued_at,
  }, null, 2)}\n`, "utf8");
  return {
    root,
    registryRoot,
    source,
    target,
    buildPlan,
    plan,
    envelope: { ...currentEnvelope, opaque_handoff_ref: legacyOpaqueHandoffRef },
  };
}

function v3Fixture(
  label: string,
  sourceBody = "A deterministic executor-open fixture.",
  heading = "Guide",
) {
  return fixture(label, sourceBody, heading, "current_v3");
}

function currentRecoveryIdentity(
  value: ReturnType<typeof v3Fixture>,
  now: string,
): AutomaticBuildRecoveryGenerationIdentity {
  return inspectAutomaticBuildDispatchRecoveryGeneration(
    value.target,
    value.envelope.manifest.stage,
    value.envelope.manifest.dispatch_id,
    { now, dispatch_run_id: value.envelope.dispatch_run_id },
  ).recovery_identity;
}

function issueCurrentRecoveryHandoff(
  value: ReturnType<typeof v3Fixture>,
  now: string,
): { opaque_handoff_ref: string; recovery_identity: AutomaticBuildRecoveryGenerationIdentity } {
  const recoveryIdentity = currentRecoveryIdentity(value, now);
  const issued = issueAutomaticBuildOpaqueHandoff({
    target: value.target,
    kind: "public_dispatch",
    owner_identity: {
      version: "automatic_build_dispatch_owner_identity.v1",
      stage: value.envelope.manifest.stage,
      dispatch_id: value.envelope.manifest.dispatch_id,
      dispatch_run_id: value.envelope.dispatch_run_id,
    },
    recovery_identity: recoveryIdentity,
    executor_handoff: value.envelope.executor_handoff,
    issued_at: now,
  });
  return { opaque_handoff_ref: issued.opaque_handoff_ref, recovery_identity: recoveryIdentity };
}

function writeHistoricalV3Handoff(value: ReturnType<typeof v3Fixture>): {
  opaque_handoff_ref: string;
  record_path: string;
  bytes: Buffer;
} {
  const currentRecord = JSON.parse(readFileSync(path.join(
    value.registryRoot,
    "opaque-handoffs",
    `${value.envelope.opaque_handoff_ref}.json`,
  ), "utf8"));
  const identity = {
    version: "automatic_build_opaque_handoff_identity.v3",
    session_protocol: "automatic_build_executor_session.v3",
    kind: currentRecord.kind,
    target_ref: currentRecord.target_ref,
    target_locator: currentRecord.target_locator,
    owner_identity: currentRecord.owner_identity,
    handoff_path: currentRecord.handoff_path,
    handoff_sha256: currentRecord.handoff_sha256,
    handoff_byte_length: currentRecord.handoff_byte_length,
  };
  const opaqueHandoffRef = `abhandoff1_${createHash("sha256")
    .update(canonicalAutomaticBuildJson(identity), "utf8")
    .digest("hex")}`;
  const recordPath = path.join(value.registryRoot, "opaque-handoffs", `${opaqueHandoffRef}.json`);
  const bytes = Buffer.from(`${JSON.stringify({
    version: "automatic_build_opaque_handoff_record.v3",
    session_protocol: "automatic_build_executor_session.v3",
    opaque_handoff_ref: opaqueHandoffRef,
    kind: currentRecord.kind,
    target_ref: currentRecord.target_ref,
    target_locator: currentRecord.target_locator,
    owner_identity: currentRecord.owner_identity,
    handoff_path: currentRecord.handoff_path,
    handoff_sha256: currentRecord.handoff_sha256,
    handoff_byte_length: currentRecord.handoff_byte_length,
    issued_at: currentRecord.issued_at,
  }, null, 2)}\n`, "utf8");
  writeFileSync(recordPath, bytes);
  return { opaque_handoff_ref: opaqueHandoffRef, record_path: recordPath, bytes };
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
  response: AutomaticBuildExecutorSessionResponseV3,
): Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "DELIVER_INPUT" }> {
  expect(response.version).toBe("automatic_build_executor_session.v3");
  expect(response.action.kind).toBe("DELIVER_INPUT");
  if (response.action.kind !== "DELIVER_INPUT") throw new Error("expected DELIVER_INPUT executor action");
  return response.action;
}

function expectInputBatch(
  response: AutomaticBuildExecutorSessionResponseV3,
): Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "INPUT_BATCH" }> {
  expect(response.version).toBe("automatic_build_executor_session.v3");
  expect(response.action.kind).toBe("INPUT_BATCH");
  if (response.action.kind !== "INPUT_BATCH") throw new Error("expected INPUT_BATCH executor action");
  return response.action;
}

function expectGenerateV3(
  response: AutomaticBuildExecutorSessionResponseV3,
): Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "GENERATE" }> {
  expect(response.version).toBe("automatic_build_executor_session.v3");
  expect(response.action.kind).toBe("GENERATE");
  if (response.action.kind !== "GENERATE") throw new Error("expected V3 GENERATE executor action");
  return response.action;
}

function startV3Generation(
  value: ReturnType<typeof v3Fixture>,
  now: string,
): Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "GENERATE" }> {
  return startV3GenerationForHandoff(value.envelope.opaque_handoff_ref, now);
}

function startV3GenerationForHandoff(
  opaqueHandoffRef: string,
  now: string,
): Extract<AutomaticBuildExecutorSessionResponseV3["action"], { kind: "GENERATE" }> {
  const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
    opaqueHandoffRef,
    { now },
  ));
  const delivered = collectV3Delivery(delivery, now);
  return expectGenerateV3(startAutomaticBuildExecutorGeneration(delivered.start_request, { now }));
}

function collectV3Delivery(
  delivery: ReturnType<typeof expectDeliverInput>,
  now: string,
): {
  chunks: Array<ReturnType<typeof expectInputBatch>["batch"]["chunks"][number]>;
  batches: Array<ReturnType<typeof expectInputBatch>["batch"]>;
  start_request: {
    version: "automatic_build_executor_generation_start_request.v3";
    opaque_session_ref: string;
    generation_input_ref: string;
    confirmed_through_ordinal: number;
  };
} {
  const chunks: Array<ReturnType<typeof expectInputBatch>["batch"]["chunks"][number]> = [];
  const batches: Array<ReturnType<typeof expectInputBatch>["batch"]> = [];
  let request = delivery.next_request;
  for (let batchOrdinal = 0; batchOrdinal < 128; batchOrdinal += 1) {
    const batch = expectInputBatch(nextAutomaticBuildExecutorInput(request, { now })).batch;
    batches.push(batch);
    chunks.push(...batch.chunks);
    if (batch.final_for_generation) {
      return {
        chunks,
        batches,
        start_request: {
          version: "automatic_build_executor_generation_start_request.v3",
          opaque_session_ref: delivery.input_manifest.opaque_session_ref,
          generation_input_ref: delivery.input_manifest.generation_input_ref,
          confirmed_through_ordinal: batch.last_ordinal,
        },
      };
    }
    request = {
      version: "automatic_build_executor_input_next_request.v4",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      ack_through_ordinal: batch.last_ordinal,
    };
  }
  throw new Error("expected final V3 input batch");
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
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
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

  it("reissues the same V4 recovery handoff without rewriting its first issued timestamp", () => {
    const value = fixture(
      "reissue",
      "A deterministic executor-open fixture.",
      "Guide",
      "current_v3",
    );
    const reissued = issueAutomaticBuildOpaqueHandoff({
      target: value.target,
      kind: "public_dispatch",
      owner_identity: {
        version: "automatic_build_dispatch_owner_identity.v1",
        stage: value.envelope.manifest.stage,
        dispatch_id: value.envelope.manifest.dispatch_id,
        dispatch_run_id: value.envelope.dispatch_run_id,
      },
      recovery_identity: currentRecoveryIdentity(value, "2026-08-08T06:00:03.000Z"),
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
    expect(record).toMatchObject({
      version: "automatic_build_opaque_handoff_record.v4",
      recovery_identity: currentRecoveryIdentity(value, "2026-08-08T06:00:03.000Z"),
    });
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

  it("R1 rejects a 73-character V3 open without durable open or semantic attempt", () => {
    const value = v3Fixture("r1-short-open");
    expect(() => openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref.slice(0, -2)))
      .toThrow(/opaque_handoff_ref/);
    expect(existsSync(path.join(value.registryRoot, "executor-opens"))).toBe(false);
    expectNoAttempts(value);
    expectDeliverInput(openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref));
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

describe("automatic build bounded executor session V3", () => {
  it("A2 returns contiguous bounded batches and confirms the final ordinal only at generation.start", () => {
    const value = v3Fixture("v3-a2-batch-final-ack", deterministicUtf8Text("v3-a2", 20_000));
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-09-01T06:00:00.000Z" },
    ));
    expect(delivery.input_manifest.total_chunk_count).toBeGreaterThan(2);
    expect(delivery.next_request).toMatchObject({
      version: "automatic_build_executor_input_next_request.v4",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
    });

    expect(() => startAutomaticBuildExecutorGeneration({
      version: "automatic_build_executor_generation_start_request.v3",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      confirmed_through_ordinal: delivery.input_manifest.total_chunk_count - 1,
    }, { now: "2026-09-01T06:00:01.000Z" })).toThrow(/final batch|delivery/i);
    expectNoAttempts(value);

    const firstResponse = nextAutomaticBuildExecutorInput(delivery.next_request, {
      now: "2026-09-01T06:00:02.000Z",
    });
    const firstBatch = expectInputBatch(firstResponse).batch;
    expect(firstBatch.version).toBe("automatic_build_executor_input_batch.v1");
    expect(firstBatch.first_ordinal).toBe(0);
    expect(firstBatch.chunks.map((chunk) => chunk.ordinal))
      .toEqual(Array.from(
        { length: firstBatch.last_ordinal - firstBatch.first_ordinal + 1 },
        (_, index) => index,
      ));
    expect(nextAutomaticBuildExecutorInput(delivery.next_request, {
      now: "2026-09-01T06:00:03.000Z",
    })).toEqual(firstResponse);

    let finalBatch = firstBatch;
    while (!finalBatch.final_for_generation) {
      const response = nextAutomaticBuildExecutorInput({
        version: "automatic_build_executor_input_next_request.v4",
        opaque_session_ref: delivery.input_manifest.opaque_session_ref,
        generation_input_ref: delivery.input_manifest.generation_input_ref,
        ack_through_ordinal: finalBatch.last_ordinal,
      }, { now: "2026-09-01T06:00:04.000Z" });
      const batch = expectInputBatch(response).batch;
      expect(batch.first_ordinal).toBe(finalBatch.last_ordinal + 1);
      finalBatch = batch;
    }
    expectNoAttempts(value);

    expect(() => nextAutomaticBuildExecutorInput({
      version: "automatic_build_executor_input_next_request.v4",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      ack_through_ordinal: finalBatch.last_ordinal - 1,
    }, { now: "2026-09-01T06:00:05.000Z" })).toThrow(/ack|ordinal|order/i);

    const startRequest = {
      version: "automatic_build_executor_generation_start_request.v3" as const,
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      confirmed_through_ordinal: finalBatch.last_ordinal,
    };
    const generated = startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-09-01T06:00:06.000Z",
    });
    expect(expectGenerateV3(generated).semantic_attempt).toBe(1);
    expect(startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-09-01T06:00:07.000Z",
    })).toEqual(generated);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0 });
  }, 30_000);

  it("issues a current public recovery handoff directly as V4 without supersession state", () => {
    const value = v3Fixture("v3-direct-issue");
    const record = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "opaque-handoffs",
      `${value.envelope.opaque_handoff_ref}.json`,
    ), "utf8"));

    expect(record).toMatchObject({
      version: "automatic_build_opaque_handoff_record.v4",
      session_protocol: "automatic_build_executor_session.v3",
      opaque_handoff_ref: value.envelope.opaque_handoff_ref,
      kind: "public_dispatch",
      recovery_identity: currentRecoveryIdentity(value, "2026-08-31T07:00:00.000Z"),
    });
    expect(record).not.toHaveProperty("supersedes_opaque_handoff_ref");
    expect(existsSync(path.join(value.registryRoot, "executor-handoff-supersessions"))).toBe(false);
    expectDeliverInput(openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref, {
      now: "2026-08-31T07:00:01.000Z",
    }));
    expectNoAttempts(value);
  }, 30_000);

  it("keeps historical V3 record bytes unchanged while issuing the current V4 handoff", () => {
    const value = v3Fixture("v3-byte-preservation");
    const historical = writeHistoricalV3Handoff(value);

    expectDeliverInput(openAutomaticBuildExecutorSessionV3(historical.opaque_handoff_ref, {
      now: "2026-08-31T07:10:01.000Z",
    }));
    const reissued = issueAutomaticBuildOpaqueHandoff({
      target: value.target,
      kind: "public_dispatch",
      owner_identity: {
        version: "automatic_build_dispatch_owner_identity.v1",
        stage: value.envelope.manifest.stage,
        dispatch_id: value.envelope.manifest.dispatch_id,
        dispatch_run_id: value.envelope.dispatch_run_id,
      },
      recovery_identity: currentRecoveryIdentity(value, "2026-08-31T07:10:02.000Z"),
      executor_handoff: value.envelope.executor_handoff,
      issued_at: "2026-08-31T07:10:02.000Z",
    });

    expect(reissued.opaque_handoff_ref).toBe(value.envelope.opaque_handoff_ref);
    expect(readFileSync(historical.record_path)).toEqual(historical.bytes);
  }, 30_000);

  it("binds V4 refs to each recovery identity field and rejects a forged current identity", () => {
    const value = v3Fixture("v4-recovery-identity");
    const record = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "opaque-handoffs",
      `${value.envelope.opaque_handoff_ref}.json`,
    ), "utf8"));
    const identityFor = (recoveryIdentity: AutomaticBuildRecoveryGenerationIdentity) => ({
      version: "automatic_build_opaque_handoff_identity.v4",
      session_protocol: "automatic_build_executor_session.v3",
      kind: record.kind,
      target_ref: record.target_ref,
      target_locator: record.target_locator,
      owner_identity: record.owner_identity,
      recovery_identity: recoveryIdentity,
      handoff_path: record.handoff_path,
      handoff_sha256: record.handoff_sha256,
      handoff_byte_length: record.handoff_byte_length,
    });
    const refFor = (recoveryIdentity: AutomaticBuildRecoveryGenerationIdentity) => `abhandoff1_${createHash("sha256")
      .update(canonicalAutomaticBuildJson(identityFor(recoveryIdentity)), "utf8")
      .digest("hex")}`;
    const current = currentRecoveryIdentity(value, "2026-08-31T07:20:01.000Z");
    expect(value.envelope.opaque_handoff_ref).toBe(refFor(current));
    const variants = [
      { ...current, current_work_unit_id: `${current.current_work_unit_id}-next` },
      { ...current, semantic_attempt: current.semantic_attempt + 1 },
      { ...current, lease_epoch: current.lease_epoch + 1 },
    ];
    expect(new Set([refFor(current), ...variants.map(refFor)]).size).toBe(4);

    expect(() => issueAutomaticBuildOpaqueHandoff({
      target: value.target,
      kind: "public_dispatch",
      owner_identity: record.owner_identity,
      recovery_identity: variants[0],
      executor_handoff: value.envelope.executor_handoff,
      issued_at: "2026-08-31T07:20:01.000Z",
    })).toThrow(/recovery identity|current/i);
    expect(readdirSync(path.join(value.registryRoot, "opaque-handoffs"))).toHaveLength(1);
  }, 30_000);

  it("delivers prompt and input through bounded ordinals, then creates attempt 1 only at generation.start", () => {
    const value = v3Fixture("v3-two-phase");
    const opened = openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T07:00:01.000Z",
    });
    const delivery = expectDeliverInput(opened);
    expect(JSON.stringify(opened)).not.toMatch(/"semantic_prompt":|"semantic_input":|deterministic executor-open fixture/u);
    expect(measureExecutorTransportResponse(
      opened,
      "",
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    ).status).toBe("within_limit");
    expect(delivery.input_manifest).toMatchObject({
      version: "automatic_build_executor_input_manifest.v3",
      opaque_session_ref: delivery.next_request.opaque_session_ref,
      generation_input_ref: delivery.next_request.generation_input_ref,
      segments: [
        { kind: "semantic_prompt" },
        { kind: "semantic_input" },
      ],
    });
    const deliveryLedger = readFileSync(path.join(
      value.registryRoot,
      "executor-v3-delivery-sessions",
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
    const firstResponse = nextAutomaticBuildExecutorInput(delivery.next_request, {
      now: "2026-08-08T07:00:02.000Z",
    });
    expect(nextAutomaticBuildExecutorInput(delivery.next_request, {
      now: "2026-08-08T07:00:02.500Z",
    })).toEqual(firstResponse);
    const delivered = collectV3Delivery(delivery, "2026-08-08T07:00:03.000Z");
    for (const [ordinal, chunk] of delivered.chunks.entries()) {
      expect(chunk.ordinal).toBe(ordinal);
      expect(measureExecutorTransportResponse(
        chunk,
        chunk.payload_utf8,
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      ).status).toBe("within_limit");
      bodies.set(chunk.segment, `${bodies.get(chunk.segment) ?? ""}${chunk.payload_utf8}`);
      expectNoAttempts(value);
    }
    expect(bodies.get("semantic_prompt")).toBeTruthy();
    expect(bodies.get("semantic_input")).toContain("deterministic executor-open fixture");
    for (const segment of delivery.input_manifest.segments) {
      const body = bodies.get(segment.kind) ?? "";
      expect(Buffer.byteLength(body, "utf8")).toBe(segment.byte_length);
      expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(segment.sha256);
    }
    const reopenedBeforeStart = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      {
      now: "2026-08-08T07:01:31.000Z",
      },
    ));
    expect(reopenedBeforeStart.input_manifest).toEqual(delivery.input_manifest);
    const lastNonFinalBatch = delivered.batches.at(-2);
    if (lastNonFinalBatch) {
      expect(reopenedBeforeStart.next_request.ack_through_ordinal)
        .toBe(lastNonFinalBatch.last_ordinal);
    } else {
      expect(reopenedBeforeStart.next_request).not.toHaveProperty("ack_through_ordinal");
    }
    expectNoAttempts(value);

    const startRequest = delivered.start_request;
    const startPhases: string[] = [];
    const generatedResponse = startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-08-08T07:01:32.000Z",
      timing: { complete_phase: (phase) => startPhases.push(phase) },
    });
    expect(startPhases).toEqual(["current-state/claim", "input-render-or-reuse"]);
    const generated = expectGenerateV3(generatedResponse);
    expect(generated.semantic_attempt).toBe(1);
    expect(generated.output_contract).toMatchObject({
      version: "automatic_build_semantic_candidate_contract.v3",
      transport: {
        version: "candidate_transport_contract.v1",
        serialized_request_max_bytes:
          CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes,
        serialized_request_max_estimated_tokens:
          CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_tokens,
      },
    });
    expect(generated.output_contract.max_bytes)
      .toBe(generated.output_contract.transport.candidate_value_max_bytes);
    expect(generated.output_contract.max_bytes)
      .toBeLessThan(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes);
    expect(JSON.stringify(generatedResponse)).not.toMatch(/"semantic_prompt":|"semantic_input":|deterministic executor-open fixture/u);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0 });
    expect(startAutomaticBuildExecutorGeneration(startRequest, {
      now: "2026-08-08T07:01:33.000Z",
    })).toEqual(generatedResponse);
    const reopenedAfterStart = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      {
      now: "2026-08-08T07:01:34.000Z",
      },
    ));
    expect(reopenedAfterStart.input_manifest).toEqual(delivery.input_manifest);
    expect(reopenedAfterStart.next_request).not.toHaveProperty("ack_through_ordinal");
    expect(runAutomaticBuildExecutorSessionCommand({
      ...startRequest,
      now: "2026-08-08T07:01:35.000Z",
    })).toEqual(generatedResponse);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0 });
  }, 30_000);

  it("R1 starts from the public frozen input without invoking the stage renderer again", () => {
    const value = v3Fixture("v3-r1-frozen-input");
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-09-01T08:00:00.000Z" },
    ));
    const delivered = collectV3Delivery(delivery, "2026-09-01T08:00:01.000Z");
    const deliveredInput = delivered.chunks
      .filter((chunk) => chunk.segment === "semantic_input")
      .map((chunk) => chunk.payload_utf8)
      .join("");

    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = path.join(
      value.root,
      "renderer-must-not-run.exe",
    );
    const generated = expectGenerateV3(startAutomaticBuildExecutorGeneration(
      delivered.start_request,
      { now: "2026-09-01T08:00:02.000Z" },
    ));
    expect(generated.semantic_attempt).toBe(1);

    const taskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${generated.opaque_session_ref}.json`,
    ), "utf8"));
    expect(readAutomaticBuildInputObservation(taskSession.lease_ref)).toMatchObject({
      version: "automatic_build_input_observation.v3",
      input_bytes: Buffer.byteLength(deliveredInput, "utf8"),
      input_sha256: createHash("sha256").update(deliveredInput, "utf8").digest("hex"),
    });
  }, 30_000);

  it("RG4 projects a finished dispatch without creating an attempt or candidate action", () => {
    const value = v3Fixture("v3-r1-current-work-unit");
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-09-01T08:10:00.000Z" },
    ));
    const delivered = collectV3Delivery(delivery, "2026-09-01T08:10:01.000Z");
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
        now: "2026-09-01T08:10:02.000Z",
      },
    );

    const finished = startAutomaticBuildExecutorGeneration(delivered.start_request, {
      now: "2026-09-01T08:10:03.000Z",
    });
    expect(finished).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "interrupted" },
    });
    expect(JSON.stringify(finished)).not.toMatch(/candidate_sink_ref|GENERATE|semantic_attempt/u);
    expectNoAttempts(value);
  }, 30_000);

  it("H0 uses ordinal/range/body/schema checks without transport, chunk, output-contract, or ledger digests", () => {
    const value = v3Fixture("v3-h0-forbidden-fields", "x".repeat(20_000));
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-30T02:00:00.000Z" },
    ));
    const bodies = new Map<string, string>();
    const delivered = collectV3Delivery(delivery, "2026-08-30T02:00:01.000Z");
    const firstChunk = delivered.chunks[0];
    for (const [ordinal, chunk] of delivered.chunks.entries()) {
      expect(chunk.ordinal).toBe(ordinal);
      expect(chunk.byte_range.end - chunk.byte_range.start)
        .toBe(Buffer.byteLength(chunk.payload_utf8, "utf8"));
      bodies.set(chunk.segment, `${bodies.get(chunk.segment) ?? ""}${chunk.payload_utf8}`);
    }
    if (!firstChunk) throw new Error("expected H0 input chunks");
    for (const segment of delivery.input_manifest.segments) {
      const body = bodies.get(segment.kind) ?? "";
      expect(Buffer.byteLength(body, "utf8")).toBe(segment.byte_length);
      // Segment-level prompt/input content identity remains: it avoids storing another large body.
      expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(segment.sha256);
    }
    startAutomaticBuildExecutorGeneration(delivered.start_request, {
      now: "2026-08-30T02:00:02.000Z",
    });

    const deliveryRecord = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-v3-delivery-sessions",
      `${delivery.input_manifest.opaque_session_ref}.json`,
    ), "utf8"));
    const grantRecord = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-v3-generation-grants",
      `${delivery.input_manifest.opaque_session_ref}.json`,
    ), "utf8"));
    const receiptDirectory = path.join(value.registryRoot, "executor-v3-delivery-receipts");
    const receiptRecord = JSON.parse(readFileSync(path.join(
      receiptDirectory,
      readdirSync(receiptDirectory)[0]!,
    ), "utf8"));
    expect(Object.keys(receiptRecord).sort()).toEqual([
      "confirmed_at",
      "generation_input_ref",
      "opaque_session_ref",
      "ordinal",
      "version",
    ]);
    expect(receiptRecord).toMatchObject({
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      ordinal: 0,
    });
    expect(grantRecord).toMatchObject({
      final_delivered_ordinal: delivery.input_manifest.total_chunk_count - 1,
      output_schema_version: "automatic_build_semantic_candidate_contract.v3",
    });
    const present = [
      Object.hasOwn(delivery.input_manifest, "transport_profile_digest") ? "transport_profile_digest" : undefined,
      Object.hasOwn(firstChunk, "payload_sha256") ? "payload_sha256" : undefined,
      Object.hasOwn(deliveryRecord, "transport_profile_digest") ? "record.transport_profile_digest" : undefined,
      Object.hasOwn(deliveryRecord, "output_contract_digest") ? "record.output_contract_digest" : undefined,
      Object.hasOwn(grantRecord, "delivery_ledger_digest") ? "delivery_ledger_digest" : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: H4 Session V3 removes these wrappers and directly validates version,
    // ordinal/range/UTF-8 length, concatenated prompt/input bodies, and output schema version.
    expect(present).toEqual([]);
  }, 30_000);

  it("rehydrates completed input for a replacement child after generation.start without another attempt", () => {
    const value = v3Fixture("v3-post-start-rehydrate", "x".repeat(20_000));
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:05:01.000Z" },
    ));
    expect(delivery.input_manifest.total_chunk_count).toBeGreaterThan(2);

    const delivered = collectV3Delivery(delivery, "2026-08-08T07:05:02.000Z");
    const generatedResponse = startAutomaticBuildExecutorGeneration(delivered.start_request, {
      now: "2026-08-08T07:05:03.000Z",
    });
    expect(expectGenerateV3(generatedResponse).semantic_attempt).toBe(1);

    const replacementDelivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:05:04.000Z" },
    ));
    expect(replacementDelivery.input_manifest).toEqual(delivery.input_manifest);
    expect(replacementDelivery.next_request).not.toHaveProperty("ack_through_ordinal");

    const replayedBodies = new Map<string, string>();
    const replayed = collectV3Delivery(replacementDelivery, "2026-08-08T07:05:05.000Z");
    for (const [ordinal, chunk] of replayed.chunks.entries()) {
      expect(chunk.ordinal).toBe(ordinal);
      replayedBodies.set(
        chunk.segment,
        `${replayedBodies.get(chunk.segment) ?? ""}${chunk.payload_utf8}`,
      );
    }
    expect(replayed.start_request).toEqual(delivered.start_request);
    for (const segment of delivery.input_manifest.segments) {
      const body = replayedBodies.get(segment.kind) ?? "";
      expect(Buffer.byteLength(body, "utf8")).toBe(segment.byte_length);
      expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(segment.sha256);
    }
    expect(startAutomaticBuildExecutorGeneration(replayed.start_request, {
      now: "2026-08-08T07:05:07.000Z",
    })).toEqual(generatedResponse);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0 });
  }, 30_000);

  it("RG4 replaces an expired recovery generation with epoch 2 without consuming a semantic attempt", () => {
    const value = v3Fixture("rg4-expired-replacement");
    const firstDelivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T08:00:01.000Z" },
    ));
    const firstDelivered = collectV3Delivery(firstDelivery, "2026-08-08T08:00:02.000Z");
    const firstResponse = startAutomaticBuildExecutorGeneration(firstDelivered.start_request, {
      now: "2026-08-08T08:00:03.000Z",
    });
    const firstGeneration = expectGenerateV3(firstResponse);
    const startDirectory = path.join(value.registryRoot, "executor-v3-generation-starts");
    const firstStartEntries = readdirSync(startDirectory);
    expect(firstStartEntries).toHaveLength(1);
    const firstStartPath = path.join(startDirectory, firstStartEntries[0]);
    const firstStartBytes = readFileSync(firstStartPath);
    const firstTaskSessionPath = path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${firstGeneration.opaque_session_ref}.json`,
    );
    const firstTaskSessionBytes = readFileSync(firstTaskSessionPath);
    const firstSinkPath = path.join(
      value.registryRoot,
      "executor-v3-candidate-sinks",
      `${firstGeneration.opaque_session_ref}.json`,
    );
    const firstSinkBytes = readFileSync(firstSinkPath);

    const replacement = issueCurrentRecoveryHandoff(value, "2026-08-09T08:00:01.000Z");
    expect(replacement.recovery_identity).toMatchObject({ semantic_attempt: 1, lease_epoch: 2 });
    expect(replacement.opaque_handoff_ref).not.toBe(value.envelope.opaque_handoff_ref);

    let staleStartError: unknown;
    try {
      startAutomaticBuildExecutorGeneration(firstDelivered.start_request, {
        now: "2026-08-09T08:00:02.000Z",
      });
    } catch (error) {
      staleStartError = error;
    }
    expect(staleStartError).toMatchObject({
      name: "AutomaticBuildExecutorStaleGenerationSessionError",
      diagnostic_code: "stale_generation_session",
      phase: "generation_start",
    });

    const replacementDelivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      replacement.opaque_handoff_ref,
      { now: "2026-08-09T08:00:03.000Z" },
    ));
    const replacementDelivered = collectV3Delivery(
      replacementDelivery,
      "2026-08-09T08:00:04.000Z",
    );
    const replacementGeneration = expectGenerateV3(startAutomaticBuildExecutorGeneration(
      replacementDelivered.start_request,
      { now: "2026-08-09T08:00:05.000Z" },
    ));
    expect(replacementGeneration).toMatchObject({ semantic_attempt: 1 });
    expect(replacementGeneration.opaque_session_ref).not.toBe(firstGeneration.opaque_session_ref);
    expect(replacementGeneration.candidate_sink_ref).not.toBe(firstGeneration.candidate_sink_ref);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 2, failures: 0 });

    let expiredSubmitError: unknown;
    try {
      submitAutomaticBuildExecutorCandidateV3({
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: firstGeneration.opaque_session_ref,
        candidate_sink_ref: firstGeneration.candidate_sink_ref,
        candidate: { nodes: [], edges: [] },
      }, { now: "2026-08-09T08:00:06.000Z" });
    } catch (error) {
      expiredSubmitError = error;
    }
    expect(expiredSubmitError).toMatchObject({
      name: "AutomaticBuildLeaseExpiredError",
      diagnostic_code: "lease_expired",
    });
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: replacementGeneration.opaque_session_ref,
      candidate_sink_ref: replacementGeneration.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    }, { now: "2026-08-09T08:00:07.000Z" })).not.toThrow();

    expect(readFileSync(firstStartPath)).toEqual(firstStartBytes);
    expect(readFileSync(firstTaskSessionPath)).toEqual(firstTaskSessionBytes);
    expect(readFileSync(firstSinkPath)).toEqual(firstSinkBytes);
  }, 30_000);

  it("RG4 projects a candidate-free terminal action instead of replaying a committed start", () => {
    const value = v3Fixture("rg4-committed-start");
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T08:10:01.000Z" },
    ));
    const delivered = collectV3Delivery(delivery, "2026-08-08T08:10:02.000Z");
    const generated = expectGenerateV3(startAutomaticBuildExecutorGeneration(
      delivered.start_request,
      { now: "2026-08-08T08:10:03.000Z" },
    ));
    submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    }, { now: "2026-08-08T08:10:04.000Z" });

    const replay = startAutomaticBuildExecutorGeneration(delivered.start_request, {
      now: "2026-08-08T08:10:05.000Z",
    });
    expect(replay).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "committed" },
    });
    expect(JSON.stringify(replay)).not.toMatch(/candidate_sink_ref|GENERATE|semantic_attempt/u);
  }, 30_000);

  it("replays the same next request byte-identically and rejects unknown ordinals or cross-session refs", () => {
    const left = v3Fixture("v3-ordinal-left");
    const leftDelivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      left.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:10:01.000Z" },
    ));
    const first = nextAutomaticBuildExecutorInput(leftDelivery.next_request, {
      now: "2026-08-08T07:10:02.000Z",
    });
    const firstBatch = expectInputBatch(first).batch;
    for (let replay = 0; replay < 5; replay += 1) {
      expect(nextAutomaticBuildExecutorInput(leftDelivery.next_request, {
        now: "2026-08-08T07:10:03.000Z",
      })).toEqual(first);
    }
    if (firstBatch.final_for_generation) {
      expect(() => nextAutomaticBuildExecutorInput({
        ...leftDelivery.next_request,
        ack_through_ordinal: firstBatch.last_ordinal,
      }, { now: "2026-08-08T07:10:03.500Z" })).toThrow(/final batch|generation.start/i);
    } else {
      expect(nextAutomaticBuildExecutorInput({
        ...leftDelivery.next_request,
        ack_through_ordinal: firstBatch.last_ordinal,
      }, { now: "2026-08-08T07:10:03.500Z" }).action.kind).toBe("INPUT_BATCH");
    }

    expect(() => nextAutomaticBuildExecutorInput({
      ...leftDelivery.next_request,
      ack_through_ordinal: leftDelivery.input_manifest.total_chunk_count,
    }, { now: "2026-08-08T07:10:04.000Z" })).toThrow(/ordinal/i);
    expect(() => nextAutomaticBuildExecutorInput({
      ...leftDelivery.next_request,
      ack_through_ordinal: -1,
    }, { now: "2026-08-08T07:10:05.000Z" })).toThrow(/ack_through_ordinal/i);
    expect(() => nextAutomaticBuildExecutorInput({
      ...leftDelivery.next_request,
      generation_input_ref: `abinput1_${"0".repeat(64)}`,
      ack_through_ordinal: firstBatch.last_ordinal,
    }, { now: "2026-08-08T07:10:06.000Z" })).toThrow(/generation input ref|session/i);
    expectNoAttempts(left);
  }, 30_000);

  it("reopens at the first unconfirmed batch and keeps an interrupted delivery at attempt zero", () => {
    const value = v3Fixture("v3-resume", "x".repeat(20_000));
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:20:01.000Z" },
    ));
    expect(delivery.input_manifest.total_chunk_count).toBeGreaterThan(1);
    const firstResponse = nextAutomaticBuildExecutorInput(delivery.next_request, {
      now: "2026-08-08T07:20:02.000Z",
    });
    const first = expectInputBatch(firstResponse).batch;
    expect(openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref, {
      now: "2026-08-08T07:20:03.000Z",
    })).toEqual({
      ...openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref, {
        now: "2026-08-08T07:20:04.000Z",
      }),
    });
    expectNoAttempts(value);

    const reopened = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      value.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:20:06.000Z" },
    ));
    expect(reopened.next_request).not.toHaveProperty("ack_through_ordinal");
    expect(nextAutomaticBuildExecutorInput(reopened.next_request, {
      now: "2026-08-08T07:20:07.000Z",
    })).toEqual(firstResponse);
    expect(first.first_ordinal).toBe(0);
    expectNoAttempts(value);
  }, 30_000);

  it("rejects generation.start before complete delivery and leaves terminal dispatches body-free", () => {
    const pending = v3Fixture("v3-start-before-delivery");
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(
      pending.envelope.opaque_handoff_ref,
      { now: "2026-08-08T07:30:01.000Z" },
    ));
    expect(() => startAutomaticBuildExecutorGeneration({
      version: "automatic_build_executor_generation_start_request.v3",
      opaque_session_ref: delivery.input_manifest.opaque_session_ref,
      generation_input_ref: delivery.input_manifest.generation_input_ref,
      confirmed_through_ordinal: delivery.input_manifest.total_chunk_count - 1,
    }, { now: "2026-08-08T07:30:02.000Z" })).toThrow(/final batch|delivery/i);
    expectNoAttempts(pending);

    const terminal = v3Fixture("v3-terminal");
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
    const done = openAutomaticBuildExecutorSessionV3(terminal.envelope.opaque_handoff_ref, {
      now: "2026-08-08T07:30:04.000Z",
    });
    expect(done).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "interrupted" },
    });
    expect(JSON.stringify(done)).not.toMatch(/input_manifest|generation_grant|payload_utf8/u);
    expectNoAttempts(terminal);
  }, 30_000);

  it("P4 rejects a reducer when its accepted child disappears between open and input", () => {
    const value = createSyntheticRoutabilityFixture();
    process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = path.join(value.root, "registry");
    const prepared = prepareAutomaticBuildSnapshot(value.target, "pass1");
    if (prepared.status !== "ready") throw new Error("expected prepared source fragments");
    const stage = prepared.value.stages[0];
    for (const unit of stage.pending_work_units ?? []) {
      const task = stage.generation_tasks?.[unit.work_unit_id];
      if (task?.kind !== "pass1") throw new Error("expected Pass1 source task");
      freezePass1ShadowTask(value.target, task.task);
      writePass1ProductionTaskArtifact({ target: value.target, policy_generation_id: task.task.policy_generation_id,
        work_unit_id: unit.work_unit_id, marker: "Grounded child" });
    }
    const buildPlan = confirmedStandardBuildPlan(value.source_file, value.root);
    const plan = automaticBuildPlan(value.source_file, value.root, { build_plan: buildPlan });
    if (!plan.preflight) throw new Error("expected reducer preflight");
    const now = "2026-08-08T07:40:01.000Z";
    const next = automaticBuildNext(value.source_file, value.root, 1, { now, executor_dispatches: true,
      available_agent_slots: 1, build_plan: buildPlan, accepted_plan_digest: plan.preflight.descriptor_plan_digest });
    if (!("dispatches" in next.action) || !next.action.dispatches?.length) throw new Error("expected reducer dispatch");
    const envelope = next.action.dispatches[0];
    const task = next.snapshot.stages[0].generation_tasks?.[envelope.manifest.ordered_work_unit_ids[0]];
    if (task?.kind !== "pass1" || task.task.descriptor.input_basis.kind !== "artifact_reduction"
      || !("dependency_policy_generations" in task.task.route)) throw new Error("expected bound reducer dependencies");
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(envelope.opaque_handoff_ref, { now }));
    const child = task.task.route.dependency_policy_generations[0];
    unlinkSync(automaticBuildGenerationArtifactPath(value.target, "pass1", child.policy_generation_id, child.work_unit_id));
    expect(() => nextAutomaticBuildExecutorInput(delivery.next_request, { now })).toThrow(AutomaticBuildExecutorStaleGenerationSessionError);
  }, 30_000);

  it.each(["open", "batch", "start", "submit"] as const)("P4 rejects current policy drift before %s", phase => {
    const value = v3Fixture(`p4-policy-${phase}`);
    const now = "2026-08-08T07:40:01.000Z";
    const rejects = (operation: () => unknown) => {
      let error: unknown;
      try { operation(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AutomaticBuildExecutorStaleGenerationSessionError);
      const operationPhase = ({ open: "open", batch: "input_delivery", start: "generation_start", submit: "candidate_submit" } as const)[phase];
      expect(automaticBuildExecutorMcpErrorFromSessionError(error, operationPhase)).toMatchObject({
        category: "session", diagnostic_code: "stale_generation_session", phase: operationPhase,
      });
    };
    const drift = () => {
      const id = value.envelope.manifest.ordered_work_unit_ids[0];
      const binding = value.envelope.manifest.task_bindings![id];
      if (!("policy_generation_id" in binding)) throw new Error("expected generation binding");
      const file = automaticBuildPolicyGenerationPath(value.target, "pass1", binding.policy_generation_id);
      const record = JSON.parse(readFileSync(file, "utf8"));
      record.semantic_contract.schema_version = "changed-schema";
      writeFileSync(file, JSON.stringify(record));
    };
    if (phase === "open") {
      drift(); rejects(() => openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref, { now })); return;
    }
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(value.envelope.opaque_handoff_ref, { now }));
    if (phase === "batch") {
      drift(); rejects(() => nextAutomaticBuildExecutorInput(delivery.next_request, { now })); return;
    }
    const delivered = collectV3Delivery(delivery, now);
    if (phase === "start") {
      drift(); rejects(() => startAutomaticBuildExecutorGeneration(delivered.start_request, { now })); return;
    }
    const generated = expectGenerateV3(startAutomaticBuildExecutorGeneration(delivered.start_request, { now }));
    drift();
    rejects(() => submitAutomaticBuildExecutorCandidateV3({ version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: generated.opaque_session_ref, candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] } }, { now }));
  });

  it("submits one structured JsonValue through the bound sink with canonical replay and no path", () => {
    const value = v3Fixture("v3-structured-submit");
    const generated = startV3Generation(value, "2026-08-08T07:40:01.000Z");
    expect(generated.candidate_sink_ref).toMatch(/^absink1_[a-f0-9]{64}$/u);
    expect(generated).not.toHaveProperty("candidate_path");
    const request = {
      version: "automatic_build_executor_candidate_submit.v3" as const,
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    };

    const submitPhases: string[] = [];
    const first = submitAutomaticBuildExecutorCandidateV3(request, {
      now: "2026-08-08T07:40:02.000Z",
      timing: { complete_phase: (phase) => submitPhases.push(phase) },
    });
    expect(submitPhases).toEqual(["candidate-gate", "writer/commit"]);
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
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      ...request,
      candidate: { nodes: [], edges: [], changed: true },
    }, { now: "2026-08-08T07:40:04.000Z" })).toThrow(/candidate.*different|conflict/i);
  }, 30_000);

  it("keeps a temporarily unavailable candidate sink on the same attempt and replays the same value", () => {
    const value = v3Fixture("v3-candidate-sink-replay");
    const generated = startV3Generation(value, "2026-08-08T07:42:01.000Z");
    const taskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${generated.opaque_session_ref}.json`,
    ), "utf8")) as { lease_ref: string };
    const validationPath = path.join(path.dirname(taskSession.lease_ref), "validation.json");
    mkdirSync(validationPath);
    const request = {
      version: "automatic_build_executor_candidate_submit.v3" as const,
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    };

    let unavailable: unknown;
    try {
      submitAutomaticBuildExecutorCandidateV3(request, {
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
    submitAutomaticBuildExecutorCandidateV3(request, {
      now: "2026-08-08T07:42:03.000Z",
    });
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ failures: 0, semantic_attempt: 1, lease_epoch: 1, submit_revision: 1 });
  }, 30_000);

  it("delivers the previous writer field error to the next generation and commits its correction", () => {
    const value = v3Fixture("candidate-feedback");
    const first = startV3Generation(value, "2026-08-08T07:44:01.000Z");
    expect(first).not.toHaveProperty("retry_feedback");
    const session = JSON.parse(readFileSync(path.join(value.registryRoot, "executor-task-sessions",
      `${first.opaque_session_ref}.json`), "utf8"));
    const candidatePath = path.join(path.dirname(session.lease_ref), "candidate.json");
    writeFileSync(candidatePath, JSON.stringify({ type: "application" }));
    submitAutomaticBuildCandidate(value.target, session.lease_ref, session.lease_token, candidatePath, () => {
      throw new ExtractorContractError({ version: "automatic_build_extractor_diagnostic.v1",
        code: "schema_invalid", json_pointer: "/unit_card/candidate_key_stops/4/type",
        expected: "definition | formula | claim | example | turning_point | warning | summary", actual: "application" });
    }, { now: "2026-08-08T07:44:02.000Z" });
    const next = automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T07:44:03.000Z", available_agent_slots: 1,
      accepted_plan_digest: value.plan.preflight?.descriptor_plan_digest,
      executor_dispatches: true, build_plan: value.buildPlan,
    });
    if (!("dispatches" in next.action) || !next.action.dispatches?.length) throw new Error("expected retry dispatch");
    const ref = next.action.dispatches[0].opaque_handoff_ref;
    const delivery = expectDeliverInput(openAutomaticBuildExecutorSessionV3(ref, { now: "2026-08-08T07:44:04.000Z" }));
    const delivered = collectV3Delivery(delivery, "2026-08-08T07:44:04.000Z");
    const response = startAutomaticBuildExecutorGeneration(delivered.start_request, { now: "2026-08-08T07:44:05.000Z" });
    const second = expectGenerateV3(response);
    expect(second).toMatchObject({ semantic_attempt: 2, retry_feedback: {
      code: "schema_invalid", json_pointer: "/unit_card/candidate_key_stops/4/type",
      expected: "definition | formula | claim | example | turning_point | warning | summary",
    } });
    expect(startAutomaticBuildExecutorGeneration(delivered.start_request, { now: "2026-08-08T07:44:06.000Z" })).toEqual(response);
    expect(measureExecutorTransportResponse(response, "", CODEX_EXECUTOR_TRANSPORT_PROFILE_V2).status).toBe("within_limit");
    expect(submitAutomaticBuildExecutorCandidateV3({ version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: second.opaque_session_ref, candidate_sink_ref: second.candidate_sink_ref,
      candidate: { nodes: [], edges: [] } }, { now: "2026-08-08T07:44:07.000Z" })).toMatchObject({
        action: { kind: "DONE", status: "committed" },
      });
  }, 30_000);

  it("keeps an untyped downstream candidate rejection as a redacted internal writer failure", () => {
    const value = v3Fixture("v3-structured-schema-failure");
    const generated = startV3Generation(value, "2026-08-08T07:45:01.000Z");
    const response = submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
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

  it("returns committed after an intermediate current V4 generation submit", () => {
    const value = v3Fixture(
      "v4-intermediate-submit",
      Array.from({ length: 160 }, (_, index) => (
        `Paragraph ${index + 1} contains stable evidence for the current V4 submit fixture.`
      )).join("\n\n"),
    );
    expect(value.envelope.manifest.ordered_work_unit_ids).toHaveLength(3);
    const generated = startV3GenerationForHandoff(
      value.envelope.opaque_handoff_ref,
      "2026-09-02T03:30:01.000Z",
    );

    expect(submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    }, { now: "2026-09-02T03:30:02.000Z" })).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "committed" },
    });
  }, 30_000);

  it("RG7 reuses committed A/B bytes and recovers only C through a new V4 epoch", () => {
    const value = v3Fixture(
      "rg7-upgrade-reuse",
      Array.from({ length: 160 }, (_, index) => (
        `Paragraph ${index + 1} contains stable evidence for the RG7 upgrade fixture.`
      )).join("\n\n"),
    );
    const workUnitIds = value.envelope.manifest.ordered_work_unit_ids;
    expect(workUnitIds).toHaveLength(3);
    const [unitA, unitB, unitC] = workUnitIds;
    if (!unitA || !unitB || !unitC) throw new Error("expected RG7 A/B/C work units");
    const historical = writeHistoricalV3Handoff(value);

    const commitCurrent = (now: string) => {
      const generated = startV3GenerationForHandoff(historical.opaque_handoff_ref, now);
      const taskSession = JSON.parse(readFileSync(path.join(
        value.registryRoot,
        "executor-task-sessions",
        `${generated.opaque_session_ref}.json`,
      ), "utf8")) as {
        work_unit_id: string;
        lease_ref: string;
        semantic_attempt: number;
        lease_epoch: number;
      };
      submitAutomaticBuildExecutorCandidateV3({
        version: "automatic_build_executor_candidate_submit.v3",
        opaque_session_ref: generated.opaque_session_ref,
        candidate_sink_ref: generated.candidate_sink_ref,
        candidate: { nodes: [], edges: [] },
      }, { now });
      const receiptPath = path.join(path.dirname(taskSession.lease_ref), "receipt.json");
      const receiptBytes = readFileSync(receiptPath);
      const receipt = JSON.parse(receiptBytes.toString("utf8")) as { artifact_path: string };
      return {
        taskSession,
        receiptPath,
        receiptBytes,
        artifactPath: receipt.artifact_path,
        artifactBytes: readFileSync(receipt.artifact_path),
      };
    };

    const committedA = commitCurrent("2026-08-08T06:00:01.000Z");
    const committedB = commitCurrent("2026-08-08T06:00:02.000Z");
    expect([committedA.taskSession.work_unit_id, committedB.taskSession.work_unit_id])
      .toEqual([unitA, unitB]);
    const attemptsAfterAB = readAutomaticBuildAttemptSnapshot(value.target).stages.pass1;
    const frozenA = JSON.parse(JSON.stringify(attemptsAfterAB?.[unitA]));
    const frozenB = JSON.parse(JSON.stringify(attemptsAfterAB?.[unitB]));

    const planAfterAB = automaticBuildPlan(value.source, value.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: value.buildPlan,
    });
    expect(planAfterAB.snapshot.stages
      .find((stage) => stage.stage === "pass1")?.pending_work_units
      ?.map((unit) => unit.work_unit_id)).toEqual([unitC]);

    const staleC = startV3GenerationForHandoff(
      historical.opaque_handoff_ref,
      "2026-08-08T06:00:03.000Z",
    );
    const staleTaskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${staleC.opaque_session_ref}.json`,
    ), "utf8")) as {
      work_unit_id: string;
      lease_ref: string;
      semantic_attempt: number;
      lease_epoch: number;
    };
    expect(staleTaskSession).toMatchObject({
      work_unit_id: unitC,
      semantic_attempt: 1,
      lease_epoch: 1,
    });
    expect(existsSync(path.join(path.dirname(staleTaskSession.lease_ref), "receipt.json")))
      .toBe(false);

    const recovered = automaticBuildNext(value.source, value.root, 1, {
      now: "2026-08-08T07:00:00.000Z",
      accepted_plan_digest: value.plan.preflight?.descriptor_plan_digest,
      available_agent_slots: 1,
      executor_dispatches: true,
      build_plan: value.buildPlan,
    });
    if (!("dispatches" in recovered.action) || !recovered.action.dispatches) {
      throw new Error("expected RG7 recovered dispatch");
    }
    const recoveredEnvelope = recovered.action.dispatches.find((candidate) => (
      candidate.manifest.dispatch_id === value.envelope.manifest.dispatch_id
    ));
    if (!recoveredEnvelope) throw new Error("expected RG7 current dispatch recovery");
    expect(recoveredEnvelope.opaque_handoff_ref).not.toBe(historical.opaque_handoff_ref);
    expect(recoveredEnvelope.dispatch_slot_ref).toBe(value.envelope.dispatch_slot_ref);

    const currentC = startV3GenerationForHandoff(
      recoveredEnvelope.opaque_handoff_ref,
      "2026-08-08T07:00:01.000Z",
    );
    const currentTaskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${currentC.opaque_session_ref}.json`,
    ), "utf8")) as {
      work_unit_id: string;
      lease_ref: string;
      semantic_attempt: number;
      lease_epoch: number;
    };
    expect(currentTaskSession).toMatchObject({
      work_unit_id: unitC,
      semantic_attempt: 1,
      lease_epoch: 2,
    });
    expect(submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: currentC.opaque_session_ref,
      candidate_sink_ref: currentC.candidate_sink_ref,
      candidate: { nodes: [], edges: [] },
    }, { now: "2026-08-08T07:00:02.000Z" })).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "committed" },
    });

    expect(readFileSync(committedA.receiptPath)).toEqual(committedA.receiptBytes);
    expect(readFileSync(committedA.artifactPath)).toEqual(committedA.artifactBytes);
    expect(readFileSync(committedB.receiptPath)).toEqual(committedB.receiptBytes);
    expect(readFileSync(committedB.artifactPath)).toEqual(committedB.artifactBytes);
    expect(readFileSync(historical.record_path)).toEqual(historical.bytes);
    const finalAttempts = readAutomaticBuildAttemptSnapshot(value.target).stages.pass1;
    expect(finalAttempts?.[unitA]).toEqual(frozenA);
    expect(finalAttempts?.[unitB]).toEqual(frozenB);
    expect(finalAttempts?.[unitC]).toMatchObject({
      semantic_attempt: 1,
      lease_epoch: 2,
      failures: 0,
      submit_revision: 1,
    });
  }, 60_000);

  it("accepts realistic null source_lid candidates through the real MCP wrapper", () => {
    const value = v3Fixture(
      "v3-structured-null-source-lid",
      `T7_CLI_SEMANTIC_INPUT_SENTINEL\n${"bounded synthetic context ".repeat(900)}`,
      "T7 synthetic CLI fixture",
    );
    const mcp = createBuildExecutorMcpSession({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
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
        ) as AutomaticBuildExecutorSessionResponseV3,
      };
    };
    let current = call("executor.open", {
      version: "automatic_build_executor_open_request.v3",
      opaque_handoff_ref: value.envelope.opaque_handoff_ref,
    });
    for (let ordinal = 0; ordinal < 128; ordinal += 1) {
      expect(current.isError).toBe(false);
      const action = current.response.action;
      if (action.kind === "DELIVER_INPUT") {
        current = call("executor.input.next", action.next_request);
      } else if (action.kind === "INPUT_BATCH") {
        current = action.batch.final_for_generation
          ? call("executor.generation.start", {
              version: "automatic_build_executor_generation_start_request.v3",
              opaque_session_ref: action.batch.opaque_session_ref,
              generation_input_ref: action.batch.generation_input_ref,
              confirmed_through_ordinal: action.batch.last_ordinal,
            })
          : call("executor.input.next", {
              version: "automatic_build_executor_input_next_request.v4",
              opaque_session_ref: action.batch.opaque_session_ref,
              generation_input_ref: action.batch.generation_input_ref,
              ack_through_ordinal: action.batch.last_ordinal,
            });
      } else if (action.kind === "GENERATE") {
        current = call("executor.submit_candidate", {
          version: "automatic_build_executor_candidate_submit.v3",
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
    expect(current.response.version).toBe("automatic_build_executor_session.v3");
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

  it("RG6 records an owned token-oversized request before writer start and leaves forged sessions untouched", () => {
    const value = v3Fixture("v3-owned-transport-oversize");
    const generated = startV3Generation(value, "2026-09-02T03:00:01.000Z");
    const taskSession = JSON.parse(readFileSync(path.join(
      value.registryRoot,
      "executor-task-sessions",
      `${generated.opaque_session_ref}.json`,
    ), "utf8")) as { lease_ref: string };
    const attemptDirectory = path.dirname(taskSession.lease_ref);
    const response = submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: generated.opaque_session_ref,
      candidate_sink_ref: generated.candidate_sink_ref,
      candidate: {
        value: "界".repeat(
          generated.output_contract.transport.candidate_value_max_estimated_tokens + 1,
        ),
      },
    }, { now: "2026-09-02T03:00:02.000Z" });

    expect(response).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "retryable_failure" },
    });
    expect(existsSync(path.join(attemptDirectory, "candidate.json"))).toBe(false);
    expect(existsSync(path.join(attemptDirectory, "submission.json"))).toBe(false);
    expect(existsSync(path.join(attemptDirectory, "receipt.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(attemptDirectory, "failure.json"), "utf8")))
      .toMatchObject({
        state: "retryable_failure",
        failure_diagnostic: {
          version: "automatic_build_failure_diagnostic.v3",
          category: "transport",
          code: "candidate_request_too_large",
          phase: "generation",
        },
        metrics: {
          writer_started: false,
          failure_phase: "generation",
          output_bytes: 0,
        },
      });
    expect(JSON.parse(readFileSync(path.join(attemptDirectory, "result.json"), "utf8")))
      .toMatchObject({
        outcome: "failure",
        failure_diagnostic: {
          category: "transport",
          code: "candidate_request_too_large",
          phase: "generation",
        },
      });
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 1, submit_revision: 0 });
    expect(claimAutomaticBuildTask(
      value.target,
      value.envelope.manifest.stage,
      value.envelope.manifest.ordered_work_unit_ids[0],
      {
        owner: "rg6-retry",
        now: "2026-09-02T03:00:03.000Z",
        ttl_ms: 60_000,
      },
    )).toMatchObject({
      status: "leased",
      execution_identity: { semantic_attempt: 2, lease_epoch: 1, submit_revision: 0 },
    });

    const byteValue = v3Fixture("v3-owned-transport-byte-oversize");
    const byteGenerated = startV3Generation(byteValue, "2026-09-02T03:00:11.000Z");
    const byteTaskSession = JSON.parse(readFileSync(path.join(
      byteValue.registryRoot,
      "executor-task-sessions",
      `${byteGenerated.opaque_session_ref}.json`,
    ), "utf8")) as { lease_ref: string };
    expect(submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: byteGenerated.opaque_session_ref,
      candidate_sink_ref: byteGenerated.candidate_sink_ref,
      candidate: {
        value: "x".repeat(
          byteGenerated.output_contract.transport.candidate_value_max_bytes,
        ),
      },
    }, { now: "2026-09-02T03:00:12.000Z" })).toEqual({
      version: "automatic_build_executor_session.v3",
      action: { kind: "DONE", status: "retryable_failure" },
    });
    const byteAttemptDirectory = path.dirname(byteTaskSession.lease_ref);
    expect(existsSync(path.join(byteAttemptDirectory, "candidate.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(byteAttemptDirectory, "failure.json"), "utf8")))
      .toMatchObject({
        failure_diagnostic: {
          category: "transport",
          code: "candidate_request_too_large",
          phase: "generation",
        },
        metrics: { writer_started: false, output_bytes: 0 },
      });

    const forged = v3Fixture("v3-forged-transport-oversize");
    const forgedGenerated = startV3Generation(forged, "2026-09-02T03:01:01.000Z");
    const forgedTaskSession = JSON.parse(readFileSync(path.join(
      forged.registryRoot,
      "executor-task-sessions",
      `${forgedGenerated.opaque_session_ref}.json`,
    ), "utf8")) as { lease_ref: string };
    const forgedAttemptDirectory = path.dirname(forgedTaskSession.lease_ref);
    const before = readdirSync(forgedAttemptDirectory, { recursive: true }).map(String).sort();
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: `absession1_${"0".repeat(64)}`,
      candidate_sink_ref: `absink1_${"0".repeat(64)}`,
      candidate: { value: "界".repeat(4_096) },
    })).toThrow(/session|exist/i);
    expect(readdirSync(forgedAttemptDirectory, { recursive: true }).map(String).sort())
      .toEqual(before);
  }, 30_000);

  it("rejects V2 path submit and malformed, host, non-finite, deep, or unbound values before mailbox mutation", () => {
    const value = v3Fixture("v3-structured-rejections");
    const generated = startV3Generation(value, "2026-08-08T07:50:01.000Z");
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
    )).toThrow(/V3.*candidate_path|candidate_path.*V3/i);

    const validRequest = {
      version: "automatic_build_executor_candidate_submit.v3" as const,
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
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      ...validRequest,
      candidate: new Date("2026-08-08T00:00:00.000Z") as never,
    })).toThrow(/JSON value|host object/i);
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      ...validRequest,
      candidate: { value: Number.NaN },
    })).toThrow(/finite|JSON value/i);
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      ...validRequest,
      candidate: { value: Number.POSITIVE_INFINITY },
    })).toThrow(/finite|JSON value/i);
    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth < 80; depth += 1) deep = { child: deep };
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      ...validRequest,
      candidate: deep as never,
    })).toThrow(/depth|JSON value/i);
    expect(() => submitAutomaticBuildExecutorCandidateV3({
      ...validRequest,
      candidate_sink_ref: `absink1_${"0".repeat(64)}`,
    })).toThrow(/sink/i);

    expect(existsSync(mailbox)).toBe(false);
    expect(readAutomaticBuildAttemptSnapshot(value.target)
      .stages[value.envelope.manifest.stage]?.[value.envelope.manifest.ordered_work_unit_ids[0]])
      .toMatchObject({ semantic_attempt: 1, lease_epoch: 1, failures: 0, submit_revision: 0 });
  }, 30_000);
});
