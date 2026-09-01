import assert from "node:assert/strict";

export const EXECUTOR_CARRIER_TIERS = [8, 16, 32, 64].map((kib) => kib * 1024) as readonly number[];
export const EXECUTOR_CARRIER_SHAPES = ["ascii", "cjk"] as const;

export type ExecutorCarrierShape = typeof EXECUTOR_CARRIER_SHAPES[number];
export type ExecutorCarrierMode = "direct_result" | "program_output";

export interface ExecutorCarrierPayloadV1 {
  version: "executor_carrier_payload.v1";
  serialized_result_bytes: number;
  content_utf8_bytes: number;
  shape: ExecutorCarrierShape;
  head_sentinel: string;
  body: string;
  pad: string;
  tail_sentinel: string;
}

export interface ExecutorCarrierCaseResultV1 {
  mode: ExecutorCarrierMode;
  shape: ExecutorCarrierShape;
  tier_bytes: number;
  status: "passed" | "failed";
  exact_result_bytes: number | null;
  raw_tail_complete: boolean;
  structure_closed: boolean;
  model_ack_complete: boolean;
  failure_kind: "host_rejected" | "trace_incomplete" | "model_ack_missing" | null;
}

export interface ExecutorCarrierCapacityEvidenceV1 {
  version: "executor_carrier_capacity_evidence.v1";
  status: "passed" | "bounded_failure";
  host_release: string;
  direct_result: { max_tested_passing_bytes: number; first_failed_bytes: number | null };
  program_output: { max_tested_passing_bytes: number; first_failed_bytes: number | null };
  cases: ExecutorCarrierCaseResultV1[];
}

function payloadSentinel(tierBytes: number, shape: ExecutorCarrierShape, edge: "HEAD" | "TAIL"): string {
  return `M2_${shape.toUpperCase()}_${tierBytes}_${edge}`;
}

function responseFor(id: string | number | null, payload: ExecutorCarrierPayloadV1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      isError: false,
    },
  };
}

export function createCarrierReadResponse(
  id: string | number | null,
  tierBytes: number,
  shape: ExecutorCarrierShape,
): { response: ReturnType<typeof responseFor>; serialized_line: string; payload: ExecutorCarrierPayloadV1 } {
  assert(EXECUTOR_CARRIER_TIERS.includes(tierBytes), "carrier tier is not in the bounded probe set");
  assert(EXECUTOR_CARRIER_SHAPES.includes(shape), "carrier shape is unsupported");
  let contentBytes = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const base: ExecutorCarrierPayloadV1 = {
      version: "executor_carrier_payload.v1",
      serialized_result_bytes: tierBytes,
      content_utf8_bytes: contentBytes,
      shape,
      head_sentinel: payloadSentinel(tierBytes, shape, "HEAD"),
      body: "",
      pad: "",
      tail_sentinel: payloadSentinel(tierBytes, shape, "TAIL"),
    };
    const baseLine = `${JSON.stringify(responseFor(id, base))}\n`;
    const remaining = tierBytes - Buffer.byteLength(baseLine, "utf8");
    assert(remaining >= 0, "carrier tier cannot hold its response envelope");
    const payload: ExecutorCarrierPayloadV1 = {
      ...base,
      body: shape === "ascii" ? "A".repeat(remaining) : "界".repeat(Math.floor(remaining / 3)),
      pad: shape === "ascii" ? "" : "x".repeat(remaining % 3),
    };
    const actualContentBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (actualContentBytes !== contentBytes) {
      contentBytes = actualContentBytes;
      continue;
    }
    const response = responseFor(id, payload);
    const serializedLine = `${JSON.stringify(response)}\n`;
    assert.equal(Buffer.byteLength(serializedLine, "utf8"), tierBytes);
    return { response, serialized_line: serializedLine, payload };
  }
  throw new Error("carrier response content length did not converge");
}

export function parseCarrierPayloadText(text: string): ExecutorCarrierPayloadV1 {
  const value = JSON.parse(text) as Partial<ExecutorCarrierPayloadV1>;
  assert.equal(value.version, "executor_carrier_payload.v1");
  assert(Number.isSafeInteger(value.serialized_result_bytes));
  assert(Number.isSafeInteger(value.content_utf8_bytes));
  assert(EXECUTOR_CARRIER_SHAPES.includes(value.shape as ExecutorCarrierShape));
  assert.equal(typeof value.head_sentinel, "string");
  assert.equal(typeof value.body, "string");
  assert.equal(typeof value.pad, "string");
  assert.equal(typeof value.tail_sentinel, "string");
  assert.equal(Buffer.byteLength(text, "utf8"), value.content_utf8_bytes);
  assert.equal(
    value.head_sentinel,
    payloadSentinel(value.serialized_result_bytes as number, value.shape as ExecutorCarrierShape, "HEAD"),
  );
  assert.equal(
    value.tail_sentinel,
    payloadSentinel(value.serialized_result_bytes as number, value.shape as ExecutorCarrierShape, "TAIL"),
  );
  return value as ExecutorCarrierPayloadV1;
}

function capacityFor(
  mode: ExecutorCarrierMode,
  cases: readonly ExecutorCarrierCaseResultV1[],
): { max_tested_passing_bytes: number; first_failed_bytes: number | null } {
  const relevant = cases.filter((item) => item.mode === mode);
  const passed = relevant.filter((item) => item.status === "passed").map((item) => item.tier_bytes);
  const failed = relevant.filter((item) => item.status === "failed").map((item) => item.tier_bytes);
  return {
    max_tested_passing_bytes: passed.length === 0 ? 0 : Math.max(...passed),
    first_failed_bytes: failed.length === 0 ? null : Math.min(...failed),
  };
}

export function buildCarrierCapacityEvidence(
  hostRelease: string,
  cases: readonly ExecutorCarrierCaseResultV1[],
): ExecutorCarrierCapacityEvidenceV1 {
  assert(/^codex-cli 0\.149\./u.test(hostRelease), "carrier evidence requires Codex 0.149");
  const ordered = [...cases].sort((left, right) => (
    left.mode.localeCompare(right.mode)
    || left.shape.localeCompare(right.shape)
    || left.tier_bytes - right.tier_bytes
  ));
  return {
    version: "executor_carrier_capacity_evidence.v1",
    status: ordered.some((item) => item.status === "failed") ? "bounded_failure" : "passed",
    host_release: hostRelease,
    direct_result: capacityFor("direct_result", ordered),
    program_output: capacityFor("program_output", ordered),
    cases: ordered,
  };
}
