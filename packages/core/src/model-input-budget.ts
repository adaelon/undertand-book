import { createHash } from "node:crypto";
import { MODEL_INPUT_RENDER_CONTRACT_VERSION } from "./model-input-renderer";
import { estimateTokens } from "./window";

export const MODEL_INPUT_ESTIMATOR_VERSION = "weighted_codepoint_estimator.v1" as const;

export interface ModelInputBudgetProofV1 {
  version: "model_input_budget_proof.v1";
  estimator_version: string;
  render_contract_version: string;
  router_version: string;
  prompt_sha256: string;
  rendered_input_sha256: string;
  estimated_rendered_tokens: number;
  stage_body_limit_tokens: number;
  executor_context_floor_tokens: number;
  prompt_reserve_tokens: number;
  protocol_reserve_tokens: number;
  output_reserve_tokens: number;
  safety_margin_tokens: number;
  effective_body_limit_tokens: number;
  status: "within_limit";
  proof_digest: string;
}

export interface ModelInputBudgetRequestV1 {
  rendered_input: string;
  router_version: string;
  prompt_sha256: string;
  stage_body_limit_tokens: number;
  executor_context_floor_tokens: number;
  prompt_reserve_tokens: number;
  protocol_reserve_tokens: number;
  output_reserve_tokens: number;
  safety_margin_tokens: number;
  estimator_version?: string;
  render_contract_version?: string;
}

export interface ModelInputOverLimitV1 {
  version: "model_input_budget_evaluation.v1";
  status: "over_limit";
  estimator_version: string;
  render_contract_version: string;
  router_version: string;
  prompt_sha256: string;
  rendered_input_sha256: string;
  estimated_rendered_tokens: number;
  stage_body_limit_tokens: number;
  executor_context_floor_tokens: number;
  prompt_reserve_tokens: number;
  protocol_reserve_tokens: number;
  output_reserve_tokens: number;
  safety_margin_tokens: number;
  effective_body_limit_tokens: number;
}

export type ModelInputBudgetEvaluationV1 =
  | { status: "within_limit"; proof: ModelInputBudgetProofV1 }
  | ModelInputOverLimitV1;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function boundedIdentity(value: string, field: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 256) throw new Error(`${field} must be a non-empty bounded string`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Identity(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${field} must be a SHA-256 hex digest`);
  return value.toLowerCase();
}

function proofDigest(value: Omit<ModelInputBudgetProofV1, "proof_digest">): string {
  return sha256(stableJson(value));
}

const MODEL_INPUT_BUDGET_PROOF_KEYS = [
  "effective_body_limit_tokens",
  "estimated_rendered_tokens",
  "estimator_version",
  "executor_context_floor_tokens",
  "output_reserve_tokens",
  "prompt_reserve_tokens",
  "prompt_sha256",
  "proof_digest",
  "protocol_reserve_tokens",
  "render_contract_version",
  "rendered_input_sha256",
  "router_version",
  "safety_margin_tokens",
  "stage_body_limit_tokens",
  "status",
  "version",
] as const;

/**
 * Validate a persisted proof without requiring the private rendered body.
 *
 * This is the read-side gate used by planning and claiming. The executor-side
 * gate still calls `verifyModelInputBudgetProof`, which additionally hashes and
 * re-estimates the exact rendered bytes.
 */
export function validateModelInputBudgetProof(proof: ModelInputBudgetProofV1): ModelInputBudgetProofV1 {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new Error("budget proof must be an object");
  }
  const keys = Object.keys(proof).sort();
  if (keys.length !== MODEL_INPUT_BUDGET_PROOF_KEYS.length
    || keys.some((key, index) => key !== MODEL_INPUT_BUDGET_PROOF_KEYS[index])) {
    throw new Error("budget proof contains unsupported or missing fields");
  }
  if (proof.version !== "model_input_budget_proof.v1" || proof.status !== "within_limit") {
    throw new Error("budget proof version or status is invalid");
  }
  boundedIdentity(proof.estimator_version, "estimator_version");
  boundedIdentity(proof.render_contract_version, "render_contract_version");
  boundedIdentity(proof.router_version, "router_version");
  sha256Identity(proof.prompt_sha256, "prompt_sha256");
  sha256Identity(proof.rendered_input_sha256, "rendered_input_sha256");
  sha256Identity(proof.proof_digest, "proof_digest");
  const stageBodyLimitTokens = positiveSafeInteger(proof.stage_body_limit_tokens, "stage_body_limit_tokens");
  const executorContextFloorTokens = positiveSafeInteger(
    proof.executor_context_floor_tokens,
    "executor_context_floor_tokens",
  );
  const promptReserveTokens = nonNegativeSafeInteger(proof.prompt_reserve_tokens, "prompt_reserve_tokens");
  const protocolReserveTokens = nonNegativeSafeInteger(proof.protocol_reserve_tokens, "protocol_reserve_tokens");
  const outputReserveTokens = nonNegativeSafeInteger(proof.output_reserve_tokens, "output_reserve_tokens");
  const safetyMarginTokens = nonNegativeSafeInteger(proof.safety_margin_tokens, "safety_margin_tokens");
  const estimatedRenderedTokens = nonNegativeSafeInteger(
    proof.estimated_rendered_tokens,
    "estimated_rendered_tokens",
  );
  const effectiveBodyLimitTokens = nonNegativeSafeInteger(
    proof.effective_body_limit_tokens,
    "effective_body_limit_tokens",
  );
  const expectedEffectiveBodyLimit = Math.min(
    stageBodyLimitTokens,
    Math.max(
      0,
      executorContextFloorTokens
        - promptReserveTokens
        - protocolReserveTokens
        - outputReserveTokens
        - safetyMarginTokens,
    ),
  );
  if (effectiveBodyLimitTokens !== expectedEffectiveBodyLimit) {
    throw new Error("budget proof effective body limit is inconsistent with its reserves");
  }
  if (estimatedRenderedTokens > effectiveBodyLimitTokens) {
    throw new Error("budget proof exceeds its effective body limit");
  }
  const { proof_digest: _proofDigest, ...unsigned } = proof;
  if (proof.proof_digest !== proofDigest(unsigned)) {
    throw new Error("budget proof digest is invalid");
  }
  return proof;
}

export function evaluateModelInputBudget(input: ModelInputBudgetRequestV1): ModelInputBudgetEvaluationV1 {
  const estimatorVersion = boundedIdentity(
    input.estimator_version ?? MODEL_INPUT_ESTIMATOR_VERSION,
    "estimator_version",
  );
  const renderContractVersion = boundedIdentity(
    input.render_contract_version ?? MODEL_INPUT_RENDER_CONTRACT_VERSION,
    "render_contract_version",
  );
  const routerVersion = boundedIdentity(input.router_version, "router_version");
  const promptSha256 = sha256Identity(input.prompt_sha256, "prompt_sha256");
  const stageBodyLimitTokens = positiveSafeInteger(input.stage_body_limit_tokens, "stage_body_limit_tokens");
  const executorContextFloorTokens = positiveSafeInteger(
    input.executor_context_floor_tokens,
    "executor_context_floor_tokens",
  );
  const promptReserveTokens = nonNegativeSafeInteger(input.prompt_reserve_tokens, "prompt_reserve_tokens");
  const protocolReserveTokens = nonNegativeSafeInteger(input.protocol_reserve_tokens, "protocol_reserve_tokens");
  const outputReserveTokens = nonNegativeSafeInteger(input.output_reserve_tokens, "output_reserve_tokens");
  const safetyMarginTokens = nonNegativeSafeInteger(input.safety_margin_tokens, "safety_margin_tokens");
  const contextBodyLimit = executorContextFloorTokens
    - promptReserveTokens
    - protocolReserveTokens
    - outputReserveTokens
    - safetyMarginTokens;
  const effectiveBodyLimitTokens = Math.min(stageBodyLimitTokens, Math.max(0, contextBodyLimit));
  const estimatedRenderedTokens = estimateTokens(input.rendered_input);
  const renderedInputSha256 = sha256(input.rendered_input);
  const shared = {
    estimator_version: estimatorVersion,
    render_contract_version: renderContractVersion,
    router_version: routerVersion,
    prompt_sha256: promptSha256,
    rendered_input_sha256: renderedInputSha256,
    estimated_rendered_tokens: estimatedRenderedTokens,
    stage_body_limit_tokens: stageBodyLimitTokens,
    executor_context_floor_tokens: executorContextFloorTokens,
    prompt_reserve_tokens: promptReserveTokens,
    protocol_reserve_tokens: protocolReserveTokens,
    output_reserve_tokens: outputReserveTokens,
    safety_margin_tokens: safetyMarginTokens,
    effective_body_limit_tokens: effectiveBodyLimitTokens,
  };
  if (estimatedRenderedTokens > effectiveBodyLimitTokens) {
    return {
      version: "model_input_budget_evaluation.v1",
      status: "over_limit",
      ...shared,
    };
  }
  const unsigned: Omit<ModelInputBudgetProofV1, "proof_digest"> = {
    version: "model_input_budget_proof.v1",
    ...shared,
    status: "within_limit",
  };
  return {
    status: "within_limit",
    proof: { ...unsigned, proof_digest: proofDigest(unsigned) },
  };
}

export function verifyModelInputBudgetProof(
  renderedInput: string,
  proof: ModelInputBudgetProofV1,
): ModelInputBudgetProofV1 {
  validateModelInputBudgetProof(proof);
  const evaluated = evaluateModelInputBudget({
    rendered_input: renderedInput,
    estimator_version: proof.estimator_version,
    render_contract_version: proof.render_contract_version,
    router_version: proof.router_version,
    prompt_sha256: proof.prompt_sha256,
    stage_body_limit_tokens: proof.stage_body_limit_tokens,
    executor_context_floor_tokens: proof.executor_context_floor_tokens,
    prompt_reserve_tokens: proof.prompt_reserve_tokens,
    protocol_reserve_tokens: proof.protocol_reserve_tokens,
    output_reserve_tokens: proof.output_reserve_tokens,
    safety_margin_tokens: proof.safety_margin_tokens,
  });
  if (evaluated.status !== "within_limit") throw new Error("budget proof no longer fits the effective body limit");
  if (stableJson(evaluated.proof) !== stableJson(proof)) throw new Error("budget proof does not match rendered input or policy");
  return proof;
}
