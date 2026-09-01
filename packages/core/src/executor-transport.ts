import { canonicalAutomaticBuildJson } from "./automatic-build-protocol";
import { estimateTokens } from "./window";

export interface ExecutorTransportProfileV2 {
  version: "executor_transport_profile.v2";
  carrier: "codex_executor_mcp";
  session_protocol: "automatic_build_executor_session.v3";
  max_tool_result_tokens: number;
  max_tool_result_bytes: number;
  result_envelope_reserve_tokens: number;
  max_input_chunks: number;
  max_candidate_request_tokens: number;
  max_candidate_request_bytes: number;
}

export type ExecutorTransportProfileInputV2 = Omit<
  ExecutorTransportProfileV2,
  "version"
>;

export type ExecutorTransportBlockReasonV2 =
  | "token_cap_exceeded"
  | "byte_cap_exceeded"
  | "envelope_reserve_exceeded";

interface ExecutorTransportResponseMeasurementCommonV2 {
  version: "executor_transport_response_measurement.v2";
  payload_byte_length: number;
  payload_estimated_tokens: number;
  serialized_response: string;
  serialized_response_bytes: number;
  serialized_response_tokens: number;
  envelope_overhead_tokens: number;
}

export type ExecutorTransportResponseMeasurementV2 =
  | (ExecutorTransportResponseMeasurementCommonV2 & {
      status: "within_limit";
      blocking_reasons: [];
    })
  | (ExecutorTransportResponseMeasurementCommonV2 & {
      status: "blocked";
      blocking_reasons: ExecutorTransportBlockReasonV2[];
    });

export interface ExecutorTransportChunkFrameV2 {
  ordinal: number;
  byte_range: { start: number; end: number };
  payload_utf8: string;
  final: boolean;
}

export interface PackedExecutorTransportChunkV2 extends ExecutorTransportChunkFrameV2 {
  response: unknown;
  serialized_response: string;
  serialized_response_bytes: number;
  serialized_response_tokens: number;
  payload_estimated_tokens: number;
  envelope_overhead_tokens: number;
}

export interface ExecutorTransportPackWithinLimitV2 {
  version: "executor_transport_pack.v2";
  status: "within_limit";
  payload_byte_length: number;
  payload_estimated_tokens: number;
  chunk_count: number;
  input_delivery_overhead_tokens: number;
  chunks: PackedExecutorTransportChunkV2[];
}

export interface ExecutorTransportPackBlockedV2 {
  version: "executor_transport_pack.v2";
  status: "blocked";
  code: ExecutorTransportBlockReasonV2 | "max_chunk_count_exceeded";
  payload_byte_length: number;
  required_chunk_count: number;
  blocking_reasons: ExecutorTransportBlockReasonV2[];
}

export type ExecutorTransportPackResultV2 =
  | ExecutorTransportPackWithinLimitV2
  | ExecutorTransportPackBlockedV2;

export interface PackExecutorTransportPayloadRequestV2 {
  profile: ExecutorTransportProfileV2;
  payload_utf8: string;
  envelope_for_chunk: (frame: ExecutorTransportChunkFrameV2) => unknown;
}

export interface ExecutorTransportDeliveryBatchLimitV1 {
  version: "executor_transport_delivery_batch_limit.v1";
  max_chunks_per_batch: number;
  max_serialized_batch_bytes: number;
  max_batches_per_work_unit: number;
}

export interface PackedExecutorTransportBatchV1<TChunk extends { ordinal: number }> {
  first_ordinal: number;
  last_ordinal: number;
  chunks: TChunk[];
  response: unknown;
  serialized_mcp_result: string;
  serialized_mcp_result_bytes: number;
}

export type ExecutorTransportBatchPackResultV1<TChunk extends { ordinal: number }> =
  | {
      version: "executor_transport_batch_pack.v1";
      status: "within_limit";
      batch_count: number;
      batches: PackedExecutorTransportBatchV1<TChunk>[];
    }
  | {
      version: "executor_transport_batch_pack.v1";
      status: "blocked";
      code: "single_chunk_exceeds_batch_limit" | "max_batch_count_exceeded";
      required_batch_count: number;
    };

export const CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1 = Object.freeze({
  version: "executor_transport_delivery_batch_limit.v1" as const,
  max_chunks_per_batch: 8,
  max_serialized_batch_bytes: 65_536,
  max_batches_per_work_unit: 64,
});

const PROFILE_KEYS = [
  "carrier",
  "max_candidate_request_bytes",
  "max_candidate_request_tokens",
  "max_input_chunks",
  "max_tool_result_bytes",
  "max_tool_result_tokens",
  "result_envelope_reserve_tokens",
  "session_protocol",
  "version",
] as const;

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function createExecutorTransportProfile(
  input: ExecutorTransportProfileInputV2,
): ExecutorTransportProfileV2 {
  return validateExecutorTransportProfile({
    version: "executor_transport_profile.v2" as const,
    carrier: input.carrier,
    session_protocol: input.session_protocol,
    max_tool_result_tokens: input.max_tool_result_tokens,
    max_tool_result_bytes: input.max_tool_result_bytes,
    result_envelope_reserve_tokens: input.result_envelope_reserve_tokens,
    max_input_chunks: input.max_input_chunks,
    max_candidate_request_tokens: input.max_candidate_request_tokens,
    max_candidate_request_bytes: input.max_candidate_request_bytes,
  });
}

export function validateExecutorTransportProfile(
  profile: ExecutorTransportProfileV2,
): ExecutorTransportProfileV2 {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("executor transport profile must be an object");
  }
  const keys = Object.keys(profile).sort();
  if (keys.length !== PROFILE_KEYS.length
    || keys.some((key, index) => key !== PROFILE_KEYS[index])) {
    throw new Error("executor transport profile contains unsupported or missing fields");
  }
  if (profile.version !== "executor_transport_profile.v2"
    || profile.carrier !== "codex_executor_mcp"
    || profile.session_protocol !== "automatic_build_executor_session.v3") {
    throw new Error("executor transport profile identity is unsupported");
  }
  const maxToolResultTokens = positiveSafeInteger(
    profile.max_tool_result_tokens,
    "max_tool_result_tokens",
  );
  positiveSafeInteger(profile.max_tool_result_bytes, "max_tool_result_bytes");
  const envelopeReserve = nonNegativeSafeInteger(
    profile.result_envelope_reserve_tokens,
    "result_envelope_reserve_tokens",
  );
  if (envelopeReserve > maxToolResultTokens) {
    throw new Error("result envelope reserve exceeds the tool-result token cap");
  }
  positiveSafeInteger(profile.max_input_chunks, "max_input_chunks");
  positiveSafeInteger(profile.max_candidate_request_tokens, "max_candidate_request_tokens");
  positiveSafeInteger(profile.max_candidate_request_bytes, "max_candidate_request_bytes");
  return profile;
}

export const CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 = createExecutorTransportProfile({
  carrier: "codex_executor_mcp",
  session_protocol: "automatic_build_executor_session.v3",
  max_tool_result_tokens: 2_048,
  max_tool_result_bytes: 8_192,
  result_envelope_reserve_tokens: 256,
  max_input_chunks: 64,
  max_candidate_request_tokens: 2_048,
  max_candidate_request_bytes: 32_768,
});

export function serializeExecutorMcpToolResult(response: unknown): string {
  return canonicalAutomaticBuildJson({
    content: [{ type: "text", text: canonicalAutomaticBuildJson(response) }],
    isError: false,
  });
}

export function packExecutorTransportBatches<
  TChunk extends { ordinal: number },
>(input: {
  chunks: TChunk[];
  limit: ExecutorTransportDeliveryBatchLimitV1;
  envelope_for_chunks: (chunks: TChunk[]) => unknown;
}): ExecutorTransportBatchPackResultV1<TChunk> {
  const limit = input.limit;
  if (limit.version !== "executor_transport_delivery_batch_limit.v1") {
    throw new Error("executor delivery batch limit version is unsupported");
  }
  positiveSafeInteger(limit.max_chunks_per_batch, "max_chunks_per_batch");
  positiveSafeInteger(limit.max_serialized_batch_bytes, "max_serialized_batch_bytes");
  positiveSafeInteger(limit.max_batches_per_work_unit, "max_batches_per_work_unit");
  if (!Array.isArray(input.chunks) || input.chunks.length === 0) {
    throw new Error("executor delivery batch requires at least one chunk");
  }
  if (typeof input.envelope_for_chunks !== "function") {
    throw new Error("executor delivery batch envelope factory must be a function");
  }
  for (let index = 0; index < input.chunks.length; index += 1) {
    if (input.chunks[index]?.ordinal !== index) {
      throw new Error("executor delivery batch chunks must use contiguous ordinals");
    }
  }

  const batches: PackedExecutorTransportBatchV1<TChunk>[] = [];
  let start = 0;
  while (start < input.chunks.length) {
    if (batches.length >= limit.max_batches_per_work_unit) {
      return {
        version: "executor_transport_batch_pack.v1",
        status: "blocked",
        code: "max_batch_count_exceeded",
        required_batch_count: batches.length + 1,
      };
    }
    let best: PackedExecutorTransportBatchV1<TChunk> | undefined;
    const maxEnd = Math.min(input.chunks.length, start + limit.max_chunks_per_batch);
    for (let end = start + 1; end <= maxEnd; end += 1) {
      const chunks = input.chunks.slice(start, end);
      const response = input.envelope_for_chunks(chunks);
      const serializedMcpResult = serializeExecutorMcpToolResult(response);
      const serializedMcpResultBytes = Buffer.byteLength(serializedMcpResult, "utf8");
      if (serializedMcpResultBytes > limit.max_serialized_batch_bytes) break;
      best = {
        first_ordinal: chunks[0].ordinal,
        last_ordinal: chunks.at(-1)!.ordinal,
        chunks,
        response,
        serialized_mcp_result: serializedMcpResult,
        serialized_mcp_result_bytes: serializedMcpResultBytes,
      };
    }
    if (!best) {
      return {
        version: "executor_transport_batch_pack.v1",
        status: "blocked",
        code: "single_chunk_exceeds_batch_limit",
        required_batch_count: batches.length + 1,
      };
    }
    batches.push(best);
    start = best.last_ordinal + 1;
  }
  return {
    version: "executor_transport_batch_pack.v1",
    status: "within_limit",
    batch_count: batches.length,
    batches,
  };
}

export function measureExecutorTransportResponse(
  response: unknown,
  payloadUtf8: string,
  profile: ExecutorTransportProfileV2,
): ExecutorTransportResponseMeasurementV2 {
  validateExecutorTransportProfile(profile);
  if (typeof payloadUtf8 !== "string") throw new Error("executor transport payload must be a string");
  const serializedResponse = canonicalAutomaticBuildJson(response);
  const payloadEstimatedTokens = estimateTokens(payloadUtf8);
  const serializedResponseTokens = estimateTokens(serializedResponse);
  const envelopeOverheadTokens = Math.max(0, serializedResponseTokens - payloadEstimatedTokens);
  const serializedResponseBytes = Buffer.byteLength(serializedResponse, "utf8");
  const blockingReasons: ExecutorTransportBlockReasonV2[] = [];
  if (serializedResponseTokens > profile.max_tool_result_tokens) {
    blockingReasons.push("token_cap_exceeded");
  }
  if (serializedResponseBytes > profile.max_tool_result_bytes) {
    blockingReasons.push("byte_cap_exceeded");
  }
  // The reserve protects payload-bearing chunk responses from metadata growth.
  // Control-only responses have no payload to reserve space around; their
  // complete serialized shape is still enforced by the token and byte caps.
  if (payloadUtf8.length > 0
    && envelopeOverheadTokens > profile.result_envelope_reserve_tokens) {
    blockingReasons.push("envelope_reserve_exceeded");
  }
  const common: ExecutorTransportResponseMeasurementCommonV2 = {
    version: "executor_transport_response_measurement.v2",
    payload_byte_length: Buffer.byteLength(payloadUtf8, "utf8"),
    payload_estimated_tokens: payloadEstimatedTokens,
    serialized_response: serializedResponse,
    serialized_response_bytes: serializedResponseBytes,
    serialized_response_tokens: serializedResponseTokens,
    envelope_overhead_tokens: envelopeOverheadTokens,
  };
  return blockingReasons.length
    ? { ...common, status: "blocked", blocking_reasons: blockingReasons }
    : { ...common, status: "within_limit", blocking_reasons: [] };
}

function packedChunk(
  frame: ExecutorTransportChunkFrameV2,
  response: unknown,
  measurement: ExecutorTransportResponseMeasurementV2,
): PackedExecutorTransportChunkV2 {
  if (measurement.status !== "within_limit") {
    throw new Error("cannot create a packed chunk from a blocked response");
  }
  return {
    ...frame,
    response,
    serialized_response: measurement.serialized_response,
    serialized_response_bytes: measurement.serialized_response_bytes,
    serialized_response_tokens: measurement.serialized_response_tokens,
    payload_estimated_tokens: measurement.payload_estimated_tokens,
    envelope_overhead_tokens: measurement.envelope_overhead_tokens,
  };
}

function blockedPack(
  payloadUtf8: string,
  code: ExecutorTransportPackBlockedV2["code"],
  requiredChunkCount: number,
  blockingReasons: ExecutorTransportBlockReasonV2[] = [],
): ExecutorTransportPackBlockedV2 {
  return {
    version: "executor_transport_pack.v2",
    status: "blocked",
    code,
    payload_byte_length: Buffer.byteLength(payloadUtf8, "utf8"),
    required_chunk_count: requiredChunkCount,
    blocking_reasons: [...blockingReasons],
  };
}

export function packExecutorTransportPayload(
  input: PackExecutorTransportPayloadRequestV2,
): ExecutorTransportPackResultV2 {
  const profile = validateExecutorTransportProfile(input.profile);
  if (typeof input.payload_utf8 !== "string") {
    throw new Error("executor transport payload must be a string");
  }
  if (typeof input.envelope_for_chunk !== "function") {
    throw new Error("executor transport envelope factory must be a function");
  }
  const codePoints = Array.from(input.payload_utf8);
  const byteOffsets = new Array<number>(codePoints.length + 1);
  byteOffsets[0] = 0;
  for (let index = 0; index < codePoints.length; index += 1) {
    byteOffsets[index + 1] = byteOffsets[index] + Buffer.byteLength(codePoints[index], "utf8");
  }
  const chunks: PackedExecutorTransportChunkV2[] = [];

  const evaluateRange = (start: number, end: number): {
    end: number;
    frame: ExecutorTransportChunkFrameV2;
    response: unknown;
    measurement: ExecutorTransportResponseMeasurementV2;
  } => {
    const payload = codePoints.slice(start, end).join("");
    const frame: ExecutorTransportChunkFrameV2 = {
      ordinal: chunks.length,
      byte_range: { start: byteOffsets[start], end: byteOffsets[end] },
      payload_utf8: payload,
      final: end === codePoints.length,
    };
    const response = input.envelope_for_chunk(frame);
    return {
      end,
      frame,
      response,
      measurement: measureExecutorTransportResponse(response, payload, profile),
    };
  };

  if (codePoints.length === 0) {
    const empty = evaluateRange(0, 0);
    if (empty.measurement.status === "blocked") {
      return blockedPack(
        input.payload_utf8,
        empty.measurement.blocking_reasons[0] ?? "token_cap_exceeded",
        1,
        empty.measurement.blocking_reasons,
      );
    }
    chunks.push(packedChunk(empty.frame, empty.response, empty.measurement));
  }

  let start = 0;
  while (start < codePoints.length) {
    if (chunks.length >= profile.max_input_chunks) {
      return blockedPack(
        input.payload_utf8,
        "max_chunk_count_exceeded",
        chunks.length + 1,
      );
    }
    let low = start + 1;
    let high = codePoints.length;
    let best: ReturnType<typeof evaluateRange> | undefined;
    let firstBlocked: ExecutorTransportResponseMeasurementV2 | undefined;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const candidate = evaluateRange(start, end);
      if (candidate.measurement.status === "within_limit") {
        best = candidate;
        low = end + 1;
      } else {
        firstBlocked = candidate.measurement;
        high = end - 1;
      }
    }
    if (!best) {
      const smallest = evaluateRange(start, start + 1);
      const reasons = smallest.measurement.status === "blocked"
        ? smallest.measurement.blocking_reasons
        : firstBlocked?.status === "blocked"
          ? firstBlocked.blocking_reasons
          : [];
      return blockedPack(
        input.payload_utf8,
        reasons[0] ?? "token_cap_exceeded",
        chunks.length + 1,
        reasons,
      );
    }
    chunks.push(packedChunk(best.frame, best.response, best.measurement));
    start = best.end;
  }

  const unsigned = {
    version: "executor_transport_pack.v2" as const,
    status: "within_limit" as const,
    payload_byte_length: Buffer.byteLength(input.payload_utf8, "utf8"),
    payload_estimated_tokens: estimateTokens(input.payload_utf8),
    chunk_count: chunks.length,
    input_delivery_overhead_tokens: chunks.reduce(
      (total, chunk) => total + chunk.envelope_overhead_tokens,
      0,
    ),
    chunks,
  };
  return unsigned;
}

export function validateExecutorTransportPack(
  pack: ExecutorTransportPackWithinLimitV2,
  profile: ExecutorTransportProfileV2,
  expectedPayloadUtf8: string,
): ExecutorTransportPackWithinLimitV2 {
  validateExecutorTransportProfile(profile);
  if (typeof expectedPayloadUtf8 !== "string") {
    throw new Error("executor transport expected payload must be a string");
  }
  if (!pack || typeof pack !== "object" || Array.isArray(pack)
    || pack.version !== "executor_transport_pack.v2" || pack.status !== "within_limit") {
    throw new Error("executor transport pack is invalid");
  }
  const packKeys = [
    "chunk_count",
    "chunks",
    "input_delivery_overhead_tokens",
    "payload_byte_length",
    "payload_estimated_tokens",
    "status",
    "version",
  ];
  if (Object.keys(pack).sort().some((key, index) => key !== packKeys[index])
    || Object.keys(pack).length !== packKeys.length
    || !Array.isArray(pack.chunks)) {
    throw new Error("executor transport pack contains unsupported or missing fields");
  }
  nonNegativeSafeInteger(pack.payload_byte_length, "payload_byte_length");
  nonNegativeSafeInteger(pack.payload_estimated_tokens, "payload_estimated_tokens");
  positiveSafeInteger(pack.chunk_count, "chunk_count");
  nonNegativeSafeInteger(
    pack.input_delivery_overhead_tokens,
    "input_delivery_overhead_tokens",
  );
  if (pack.chunk_count !== pack.chunks.length || pack.chunk_count > profile.max_input_chunks) {
    throw new Error("executor transport pack chunk count is invalid");
  }
  let expectedByteStart = 0;
  let overheadTokens = 0;
  const payloadParts: string[] = [];
  for (let ordinal = 0; ordinal < pack.chunks.length; ordinal += 1) {
    const chunk = pack.chunks[ordinal];
    const chunkKeys = [
      "byte_range",
      "envelope_overhead_tokens",
      "final",
      "ordinal",
      "payload_estimated_tokens",
      "payload_utf8",
      "response",
      "serialized_response",
      "serialized_response_bytes",
      "serialized_response_tokens",
    ];
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)
      || Object.keys(chunk).sort().some((key, index) => key !== chunkKeys[index])
      || Object.keys(chunk).length !== chunkKeys.length
      || !chunk.byte_range || typeof chunk.byte_range !== "object"
      || Array.isArray(chunk.byte_range)
      || Object.keys(chunk.byte_range).sort().join(",") !== "end,start"
      || typeof chunk.payload_utf8 !== "string"
      || typeof chunk.serialized_response !== "string"
      || chunk.ordinal !== ordinal
      || chunk.byte_range.start !== expectedByteStart
      || chunk.byte_range.end < chunk.byte_range.start
      || chunk.final !== (ordinal === pack.chunks.length - 1)) {
      throw new Error("executor transport chunk ordering or range is invalid");
    }
    const chunkBytes = Buffer.byteLength(chunk.payload_utf8, "utf8");
    if (chunk.byte_range.end - chunk.byte_range.start !== chunkBytes
      || (chunkBytes === 0 && (pack.chunks.length !== 1 || expectedPayloadUtf8.length !== 0))) {
      throw new Error("executor transport chunk payload identity is invalid");
    }
    const measured = measureExecutorTransportResponse(chunk.response, chunk.payload_utf8, profile);
    if (measured.status !== "within_limit"
      || measured.serialized_response !== chunk.serialized_response
      || measured.serialized_response_bytes !== chunk.serialized_response_bytes
      || measured.serialized_response_tokens !== chunk.serialized_response_tokens
      || measured.payload_estimated_tokens !== chunk.payload_estimated_tokens
      || measured.envelope_overhead_tokens !== chunk.envelope_overhead_tokens) {
      throw new Error("executor transport chunk response measurement is invalid");
    }
    expectedByteStart = chunk.byte_range.end;
    overheadTokens += chunk.envelope_overhead_tokens;
    payloadParts.push(chunk.payload_utf8);
  }
  const payload = payloadParts.join("");
  if (expectedByteStart !== pack.payload_byte_length
    || Buffer.byteLength(payload, "utf8") !== pack.payload_byte_length
    || payload !== expectedPayloadUtf8
    || estimateTokens(payload) !== pack.payload_estimated_tokens
    || overheadTokens !== pack.input_delivery_overhead_tokens) {
    throw new Error("executor transport pack aggregate identity is invalid");
  }
  return pack;
}
