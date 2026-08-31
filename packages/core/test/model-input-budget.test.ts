import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1 } from "../src/automatic-build-protocol";
import {
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  createExecutorTransportProfile,
  packExecutorTransportPayload,
  type ExecutorTransportChunkFrameV2,
  type ExecutorTransportPackResultV2,
  type ExecutorTransportProfileV2,
} from "../src/executor-transport";
import {
  evaluateModelExecutionBudget,
  evaluateModelInputBudget,
  migrateModelExecutionBudgetProofV2,
  migrateModelInputBudgetProofV1,
  validateModelExecutionBudgetProof,
  verifyModelExecutionBudgetProof,
  verifyModelInputBudgetProof,
  type ModelExecutionBudgetRequestV2,
  type ModelInputBudgetRequestV1,
} from "../src/model-input-budget";
import { DEFAULT_DISCOURSE_INPUT_TOKENS } from "../src/profile-sidecar-router";
import {
  buildWorkUnitCost,
  buildWorkUnitCostFromBudgetProof,
  createWorkUnitDescriptorV4,
  validateWorkUnitDescriptorV4,
} from "../src/stage-work-unit";

const PROMPT_SHA = createHash("sha256").update("prompt").digest("hex");

function request(overrides: Partial<ModelInputBudgetRequestV1> = {}): ModelInputBudgetRequestV1 {
  return {
    rendered_input: "abcdefghijklmnop",
    router_version: "test_router.v1",
    prompt_sha256: PROMPT_SHA,
    stage_body_limit_tokens: 4,
    executor_context_floor_tokens: 16,
    prompt_reserve_tokens: 4,
    protocol_reserve_tokens: 2,
    output_reserve_tokens: 4,
    safety_margin_tokens: 2,
    ...overrides,
  };
}

function executionEnvelope(segment: "semantic_prompt" | "semantic_input") {
  return (frame: ExecutorTransportChunkFrameV2): unknown => ({
    version: "synthetic_model_execution_input_chunk.v2",
    segment,
    ordinal: frame.ordinal,
    byte_range: frame.byte_range,
    payload_utf8: frame.payload_utf8,
    final_for_segment: frame.final,
  });
}

function packExecutionSegment(
  payload: string,
  segment: "semantic_prompt" | "semantic_input",
  transportProfile: ExecutorTransportProfileV2,
): ExecutorTransportPackResultV2 {
  return packExecutorTransportPayload({
    profile: transportProfile,
    payload_utf8: payload,
    envelope_for_chunk: executionEnvelope(segment),
  });
}

function executionRequest(
  overrides: Partial<Omit<ModelExecutionBudgetRequestV2, "input_transport_packs">> = {},
): ModelExecutionBudgetRequestV2 {
  const semanticPrompt = overrides.semantic_prompt ?? "Generate one strict JSON candidate.";
  const renderedInput = overrides.rendered_input ?? "abcdefghijklmnop";
  const transportProfile = overrides.transport_profile ?? CODEX_EXECUTOR_TRANSPORT_PROFILE_V2;
  return {
    semantic_prompt: semanticPrompt,
    rendered_input: renderedInput,
    router_version: "test_execution_router.v1",
    stage_body_limit_tokens: 6_000,
    executor_context_floor_tokens: 8_192,
    output_reserve_tokens: 1_024,
    safety_margin_tokens: 256,
    max_candidate_tokens: 1_024,
    transport_profile: transportProfile,
    ...overrides,
    input_transport_packs: [
      packExecutionSegment(semanticPrompt, "semantic_prompt", transportProfile),
      packExecutionSegment(renderedInput, "semantic_input", transportProfile),
    ],
  };
}

describe("model input budget evidence v2", () => {
  it("routes a 5,025-token production body and blocks one estimated token above 6,000", () => {
    expect(AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.stage_body_limit_tokens).toBe(6_000);
    expect(DEFAULT_DISCOURSE_INPUT_TOKENS)
      .toBe(AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.stage_body_limit_tokens);

    const within = evaluateModelInputBudget({
      rendered_input: "x".repeat(20_100),
      router_version: "production_budget_regression.v1",
      prompt_sha256: PROMPT_SHA,
      ...AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1,
    });
    expect(within.status).toBe("within_limit");
    if (within.status !== "within_limit") throw new Error("expected production proof");
    expect(within.proof).toMatchObject({
      estimated_rendered_tokens: 5_025,
      effective_body_limit_tokens: 6_000,
    });

    const over = evaluateModelInputBudget({
      rendered_input: "x".repeat(24_001),
      router_version: "production_budget_regression.v1",
      prompt_sha256: PROMPT_SHA,
      ...AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1,
    });
    expect(over).toMatchObject({
      status: "over_limit",
      estimated_rendered_tokens: 6_001,
      effective_body_limit_tokens: 6_000,
    });
  });

  it("passes exactly at the effective limit and blocks one estimated token above it", () => {
    const exact = evaluateModelInputBudget(request());
    expect(exact.status).toBe("within_limit");
    if (exact.status !== "within_limit") throw new Error("expected proof");
    expect(exact.proof.estimated_rendered_tokens).toBe(4);
    expect(exact.proof.effective_body_limit_tokens).toBe(4);

    const over = evaluateModelInputBudget(request({ rendered_input: "abcdefghijklmnopq" }));
    expect(over).toMatchObject({ status: "over_limit", estimated_rendered_tokens: 5, effective_body_limit_tokens: 4 });
  });

  it("compares input, versions, prompt identity, and every reserve directly without a proof wrapper", () => {
    const base = evaluateModelInputBudget(request({ stage_body_limit_tokens: 12 }));
    if (base.status !== "within_limit") throw new Error("expected base proof");
    const variants: Array<{
      change: Partial<ModelInputBudgetRequestV1>;
      proof_field: string;
    }> = [
      { change: { rendered_input: "abcdefghijklmnoq" }, proof_field: "rendered_input_sha256" },
      { change: { estimator_version: "weighted_codepoint_estimator.v2" }, proof_field: "estimator_version" },
      { change: { render_contract_version: "model_input_render.v2" }, proof_field: "render_contract_version" },
      { change: { router_version: "test_router.v2" }, proof_field: "router_version" },
      {
        change: { prompt_sha256: createHash("sha256").update("other prompt").digest("hex") },
        proof_field: "prompt_sha256",
      },
      { change: { stage_body_limit_tokens: 11 }, proof_field: "stage_body_limit_tokens" },
      { change: { executor_context_floor_tokens: 17 }, proof_field: "executor_context_floor_tokens" },
      { change: { prompt_reserve_tokens: 3 }, proof_field: "prompt_reserve_tokens" },
      { change: { protocol_reserve_tokens: 1 }, proof_field: "protocol_reserve_tokens" },
      { change: { output_reserve_tokens: 3 }, proof_field: "output_reserve_tokens" },
      { change: { safety_margin_tokens: 1 }, proof_field: "safety_margin_tokens" },
    ];
    for (const variant of variants) {
      const changed = evaluateModelInputBudget(request({ stage_body_limit_tokens: 12, ...variant.change }));
      expect(changed.status).toBe("within_limit");
      if (changed.status === "within_limit") {
        expect((changed.proof as unknown as Record<string, unknown>)[variant.proof_field])
          .not.toBe((base.proof as unknown as Record<string, unknown>)[variant.proof_field]);
      }
    }

    // H0_RED action: H2 removes proof_digest; validators and claim/execution re-read the
    // concrete fields exercised above, while rendered_input_sha256/prompt_sha256 stay semantic inputs.
    expect(Object.hasOwn(base.proof, "proof_digest") ? ["proof_digest"] : []).toEqual([]);
  });

  it("revalidates exact rendered bytes and rejects a tampered proof", () => {
    const result = evaluateModelInputBudget(request());
    if (result.status !== "within_limit") throw new Error("expected proof");
    expect(verifyModelInputBudgetProof(request().rendered_input, result.proof)).toBe(result.proof);
    expect(() => verifyModelInputBudgetProof("abcdefghijklmnoq", result.proof)).toThrow("does not match");
    expect(() => verifyModelInputBudgetProof(request().rendered_input, {
      ...result.proof,
      output_reserve_tokens: result.proof.output_reserve_tokens + 1,
    })).toThrow();
  });

  it("derives WorkUnitCost input tokens only from a verified proof", () => {
    const result = evaluateModelInputBudget(request());
    if (result.status !== "within_limit") throw new Error("expected proof");
    const cost = buildWorkUnitCostFromBudgetProof({
      rendered_input: request().rendered_input,
      proof: result.proof,
      visible_lids: 2,
      expected_output_items: 1,
    });
    expect(cost).toMatchObject({ estimated_input_tokens: 4, visible_lids: 2, expected_output_items: 1 });
    expect(() => buildWorkUnitCostFromBudgetProof({
      rendered_input: request().rendered_input,
      proof: result.proof,
      estimated_input_tokens: 99,
    } as never)).toThrow("must be derived");
  });

  it("keeps proof and over-limit diagnostics free of input, prompt text, paths, commands, and stderr", () => {
    const result = evaluateModelInputBudget(request({ rendered_input: "PRIVATE_BODY_SENTINEL" }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE_BODY_SENTINEL");
    expect(serialized).not.toContain("prompt\"");
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("command");
    expect(serialized).not.toContain("stderr");
  });
});

describe("model execution budget evidence v3", () => {
  it("does not treat an arbitrarily large dispatch cap as transport proof", () => {
    const syntheticDispatchLimit = 10_000_000;
    const renderedInput = "x".repeat(40_004);
    const evaluated = evaluateModelExecutionBudget(executionRequest({
      rendered_input: renderedInput,
      stage_body_limit_tokens: syntheticDispatchLimit,
    }));

    expect(evaluated.status).toBe("blocked");
    if (evaluated.status !== "blocked") throw new Error("expected execution budget block");
    expect(evaluated.reasons).toContain("context_limit");
    expect(evaluated.estimated_rendered_tokens).toBeLessThan(syntheticDispatchLimit);
  });

  it("validates transport fields, chunk count, renderer, prompt, and reserves without digest wrappers", () => {
    const input = executionRequest();
    const evaluated = evaluateModelExecutionBudget(input);
    expect(evaluated.status).toBe("within_limit");
    if (evaluated.status !== "within_limit") throw new Error("expected execution budget proof");
    expect(evaluated.proof).toMatchObject({
      version: "model_execution_budget_evidence.v3",
      input_chunk_count: 2,
      output_reserve_tokens: 1_024,
      max_candidate_tokens: 1_024,
    });
    expect(validateModelExecutionBudgetProof(
      evaluated.proof,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    )).toBe(evaluated.proof);
    expect(verifyModelExecutionBudgetProof(input, evaluated.proof)).toBe(evaluated.proof);

    const tampered = [
      {
        ...evaluated.proof,
        input_chunk_count: evaluated.proof.input_chunk_count + 1,
      },
      {
        ...evaluated.proof,
        render_contract_version: "model_input_render.v2-tampered",
      },
      {
        ...evaluated.proof,
        prompt_sha256: createHash("sha256").update("other prompt").digest("hex"),
      },
      {
        ...evaluated.proof,
        output_reserve_tokens: evaluated.proof.output_reserve_tokens + 1,
      },
    ];
    for (const proof of tampered) {
      expect(() => verifyModelExecutionBudgetProof(input, proof)).toThrow();
    }

    const changedProfile = createExecutorTransportProfile({
      carrier: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.carrier,
      session_protocol: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.session_protocol,
      max_tool_result_tokens: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_tool_result_tokens,
      max_tool_result_bytes: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_tool_result_bytes,
      result_envelope_reserve_tokens:
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.result_envelope_reserve_tokens,
      max_input_chunks: 1,
      max_candidate_request_tokens:
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_tokens,
      max_candidate_request_bytes:
        CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_bytes,
    });
    expect(() => verifyModelExecutionBudgetProof(
      executionRequest({ transport_profile: changedProfile }),
      evaluated.proof,
    )).toThrow(/transport chunk limit/i);

    const present = [
      Object.hasOwn(evaluated.proof, "proof_digest") ? "proof_digest" : undefined,
      Object.hasOwn(evaluated.proof, "transport_profile_digest") ? "transport_profile_digest" : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: H2 removes proof_digest and H4 compares the explicit transport version/caps
    // directly; the changed-profile rejection above remains the replacement failure branch.
    expect(present).toEqual([]);
  });

  it("requires both a bounded short carrier result and a candidate request that fits token and byte caps", () => {
    const short = evaluateModelExecutionBudget(executionRequest());
    expect(short.status).toBe("within_limit");

    const candidateBlocked = evaluateModelExecutionBudget(executionRequest({
      max_candidate_tokens: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_tokens + 1,
      output_reserve_tokens: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_candidate_request_tokens + 1,
    }));
    expect(candidateBlocked.status).toBe("blocked");
    if (candidateBlocked.status !== "blocked") throw new Error("expected candidate transport block");
    expect(candidateBlocked.reasons).toContain("candidate_transport");

    const byteBoundProfile = createExecutorTransportProfile({
      carrier: "codex_executor_mcp",
      session_protocol: "automatic_build_executor_session.v3",
      max_tool_result_tokens: 2_048,
      max_tool_result_bytes: 8_192,
      result_envelope_reserve_tokens: 256,
      max_input_chunks: 64,
      max_candidate_request_tokens: 2_048,
      max_candidate_request_bytes: 8_192,
    });
    const candidateByteBlocked = evaluateModelExecutionBudget(executionRequest({
      transport_profile: byteBoundProfile,
      max_candidate_tokens: 1_024,
      output_reserve_tokens: 1_024,
    }));
    expect(candidateByteBlocked.status).toBe("blocked");
    if (candidateByteBlocked.status !== "blocked") {
      throw new Error("expected candidate byte transport block");
    }
    expect(candidateByteBlocked.reasons).toContain("candidate_transport");

    const longCarrier = executionRequest({ rendered_input: "x".repeat(40_004) });
    const long = evaluateModelExecutionBudget(longCarrier);
    expect(long.status).toBe("blocked");
    if (long.status !== "blocked") throw new Error("expected long carrier block");
    expect(long.reasons).toContain("context_limit");
  });

  it("keeps V3 evidence and blocked diagnostics free of prompt, body, chunks, and paths", () => {
    const semanticPrompt = "PRIVATE_PROMPT_SENTINEL";
    const renderedInput = "PRIVATE_BODY_SENTINEL";
    const evaluated = evaluateModelExecutionBudget(executionRequest({
      semantic_prompt: semanticPrompt,
      rendered_input: renderedInput,
    }));
    const serialized = JSON.stringify(evaluated);
    expect(serialized).not.toContain(semanticPrompt);
    expect(serialized).not.toContain(renderedInput);
    expect(serialized).not.toContain("payload_utf8");
    expect(serialized).not.toContain("path");
  });

  it("validates a separate V4 descriptor shape without changing active V3 descriptors", () => {
    const evaluated = evaluateModelExecutionBudget(executionRequest());
    if (evaluated.status !== "within_limit") throw new Error("expected execution budget proof");
    const dependencyHash = "c".repeat(64);
    const descriptor = createWorkUnitDescriptorV4({
      target: {
        version: "build_target_ref.v2",
        workspace_dir: "C:\\synthetic-book",
        book_id: "synthetic-book",
        profile_id: "paper",
        input_fingerprint: "d".repeat(64),
      },
      stage: "book_structure",
      work_unit_id: "structure-unit-v4",
      kind: "structure_unit",
      input_basis: {
        kind: "artifact_reduction",
        dependency_artifacts: [{ work_unit_id: "child-1", artifact_hash: dependencyHash }],
        parent_lids: ["1"],
      },
      input_hash: evaluated.proof.rendered_input_sha256,
      execution_budget_proof: evaluated.proof,
      policy_fingerprint: {
        profile_id: "paper",
        profile_version: "paper.v1",
        stage_policy_version: "book_structure_policy.v2",
        router_version: evaluated.proof.router_version,
        prompt_sha256: evaluated.proof.prompt_sha256,
        schema_version: "book_structure_output.v1",
        quality_profile: "full",
      },
      evidence_lids: ["1"],
      dependencies: [{ artifact: "child-1", sha256: dependencyHash }],
      cost: buildWorkUnitCost({
        estimated_input_tokens: evaluated.proof.estimated_rendered_tokens,
        visible_lids: 1,
        expected_output_items: 1,
      }),
    }, CODEX_EXECUTOR_TRANSPORT_PROFILE_V2);

    expect(descriptor.version).toBe("automatic_build_work_unit.v4");
    expect(validateWorkUnitDescriptorV4(
      descriptor,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    )).toBe(descriptor);
    expect(() => validateWorkUnitDescriptorV4({
      ...descriptor,
      input_hash: "e".repeat(64),
    }, CODEX_EXECUTOR_TRANSPORT_PROFILE_V2)).toThrow(/input_hash/i);
  });
});

describe("H2 synthetic budget evidence migration", () => {
  it("migrates locked V1/V2 proof shapes to direct evidence with field parity", () => {
    const inputEvaluation = evaluateModelInputBudget(request());
    if (inputEvaluation.status !== "within_limit") throw new Error("expected input budget evidence");
    const legacyInput = {
      ...inputEvaluation.proof,
      version: "model_input_budget_proof.v1" as const,
      proof_digest: "a".repeat(64),
    };
    const migratedInput = migrateModelInputBudgetProofV1(
      JSON.parse(JSON.stringify(legacyInput)) as unknown,
    );
    expect(migratedInput).toEqual(inputEvaluation.proof);
    expect(migratedInput).not.toHaveProperty("proof_digest");

    const executionInput = executionRequest();
    const executionEvaluation = evaluateModelExecutionBudget(executionInput);
    if (executionEvaluation.status !== "within_limit") {
      throw new Error("expected execution budget evidence");
    }
    const legacyExecution = {
      ...executionEvaluation.proof,
      version: "model_execution_budget_proof.v2" as const,
      transport_profile_digest: "c".repeat(64),
      proof_digest: "b".repeat(64),
    };
    const migratedExecution = migrateModelExecutionBudgetProofV2(
      JSON.parse(JSON.stringify(legacyExecution)) as unknown,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    );
    expect(migratedExecution).toEqual(executionEvaluation.proof);
    expect(migratedExecution).not.toHaveProperty("proof_digest");
    expect(migratedExecution).not.toHaveProperty("transport_profile_digest");

    expect(() => migrateModelInputBudgetProofV1({
      ...legacyInput,
      output_reserve_tokens: legacyInput.output_reserve_tokens + 1,
    })).toThrow(/effective body limit/i);
  });
});
