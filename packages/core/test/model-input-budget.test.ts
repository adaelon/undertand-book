import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1 } from "../src/automatic-build-protocol";
import {
  evaluateModelInputBudget,
  verifyModelInputBudgetProof,
  type ModelInputBudgetRequestV1,
} from "../src/model-input-budget";
import { DEFAULT_DISCOURSE_INPUT_TOKENS } from "../src/profile-sidecar-router";
import { buildWorkUnitCostFromBudgetProof } from "../src/stage-work-unit";

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

describe("model input budget proof", () => {
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

  it("binds input, versions, prompt, and every reserve into the proof digest", () => {
    const base = evaluateModelInputBudget(request({ stage_body_limit_tokens: 12 }));
    if (base.status !== "within_limit") throw new Error("expected base proof");
    const variants: Array<Partial<ModelInputBudgetRequestV1>> = [
      { rendered_input: "abcdefghijklmnoq" },
      { estimator_version: "weighted_codepoint_estimator.v2" },
      { render_contract_version: "model_input_render.v2" },
      { router_version: "test_router.v2" },
      { prompt_sha256: createHash("sha256").update("other prompt").digest("hex") },
      { stage_body_limit_tokens: 11 },
      { executor_context_floor_tokens: 17 },
      { prompt_reserve_tokens: 3 },
      { protocol_reserve_tokens: 1 },
      { output_reserve_tokens: 3 },
      { safety_margin_tokens: 1 },
    ];
    for (const variant of variants) {
      const changed = evaluateModelInputBudget(request({ stage_body_limit_tokens: 12, ...variant }));
      expect(changed.status).toBe("within_limit");
      if (changed.status === "within_limit") expect(changed.proof.proof_digest).not.toBe(base.proof.proof_digest);
    }
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
