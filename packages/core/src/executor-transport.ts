import { createHash } from "node:crypto";
import { canonicalAutomaticBuildJson } from "./automatic-build-protocol";
import { estimateTokens } from "./window";

export interface ExecutorTransportProfileV1 {
  version: "executor_transport_profile.v1";
  carrier: "codex_executor_mcp";
  session_protocol: "automatic_build_executor_session.v2";
  max_tool_result_tokens: number;
  max_tool_result_bytes: number;
  result_envelope_reserve_tokens: number;
  max_input_chunks: number;
  max_candidate_request_tokens: number;
  max_candidate_request_bytes: number;
  profile_digest: string;
}

export type ExecutorTransportProfileInputV1 = Omit<
  ExecutorTransportProfileV1,
  "version" | "profile_digest"
>;

export type ExecutorTransportBlockReasonV1 =
  | "token_cap_exceeded"
  | "byte_cap_exceeded"
  | "envelope_reserve_exceeded";

interface ExecutorTransportResponseMeasurementCommonV1 {
  version: "executor_transport_response_measurement.v1";
  transport_profile_digest: string;
  payload_sha256: string;
  payload_byte_length: number;
  payload_estimated_tokens: number;
  serialized_response: string;
  serialized_response_sha256: string;
  serialized_response_bytes: number;
  serialized_response_tokens: number;
  envelope_overhead_tokens: number;
}

export type ExecutorTransportResponseMeasurementV1 =
  | (ExecutorTransportResponseMeasurementCommonV1 & {
      status: "within_limit";
      blocking_reasons: [];
    })
  | (ExecutorTransportResponseMeasurementCommonV1 & {
      status: "blocked";
      blocking_reasons: ExecutorTransportBlockReasonV1[];
    });

export interface ExecutorTransportChunkFrameV1 {
  ordinal: number;
  byte_range: { start: number; end: number };
  payload_utf8: string;
  payload_sha256: string;
  final: boolean;
}

export interface PackedExecutorTransportChunkV1 extends ExecutorTransportChunkFrameV1 {
  response: unknown;
  serialized_response: string;
  serialized_response_sha256: string;
  serialized_response_bytes: number;
  serialized_response_tokens: number;
  payload_estimated_tokens: number;
  envelope_overhead_tokens: number;
}

export interface ExecutorTransportPackWithinLimitV1 {
  version: "executor_transport_pack.v1";
  status: "within_limit";
  transport_profile_digest: string;
  payload_sha256: string;
  payload_byte_length: number;
  payload_estimated_tokens: number;
  chunk_count: number;
  input_delivery_overhead_tokens: number;
  chunks: PackedExecutorTransportChunkV1[];
  pack_digest: string;
}

export interface ExecutorTransportPackBlockedV1 {
  version: "executor_transport_pack.v1";
  status: "blocked";
  code: ExecutorTransportBlockReasonV1 | "max_chunk_count_exceeded";
  transport_profile_digest: string;
  payload_sha256: string;
  payload_byte_length: number;
  required_chunk_count: number;
  blocking_reasons: ExecutorTransportBlockReasonV1[];
}

export type ExecutorTransportPackResultV1 =
  | ExecutorTransportPackWithinLimitV1
  | ExecutorTransportPackBlockedV1;

export interface PackExecutorTransportPayloadRequestV1 {
  profile: ExecutorTransportProfileV1;
  payload_utf8: string;
  envelope_for_chunk: (frame: ExecutorTransportChunkFrameV1) => unknown;
}

const PROFILE_KEYS = [
  "carrier",
  "max_candidate_request_bytes",
  "max_candidate_request_tokens",
  "max_input_chunks",
  "max_tool_result_bytes",
  "max_tool_result_tokens",
  "profile_digest",
  "result_envelope_reserve_tokens",
  "session_protocol",
  "version",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Identity(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

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

function profileDigest(value: ExecutorTransportProfileInputV1 & {
  version: "executor_transport_profile.v1";
}): string {
  return sha256(canonicalAutomaticBuildJson(value));
}

export function createExecutorTransportProfile(
  input: ExecutorTransportProfileInputV1,
): ExecutorTransportProfileV1 {
  const unsigned = {
    version: "executor_transport_profile.v1" as const,
    carrier: input.carrier,
    session_protocol: input.session_protocol,
    max_tool_result_tokens: input.max_tool_result_tokens,
    max_tool_result_bytes: input.max_tool_result_bytes,
    result_envelope_reserve_tokens: input.result_envelope_reserve_tokens,
    max_input_chunks: input.max_input_chunks,
    max_candidate_request_tokens: input.max_candidate_request_tokens,
    max_candidate_request_bytes: input.max_candidate_request_bytes,
  };
  return validateExecutorTransportProfile({
    ...unsigned,
    profile_digest: profileDigest(unsigned),
  });
}

export function validateExecutorTransportProfile(
  profile: ExecutorTransportProfileV1,
): ExecutorTransportProfileV1 {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("executor transport profile must be an object");
  }
  const keys = Object.keys(profile).sort();
  if (keys.length !== PROFILE_KEYS.length
    || keys.some((key, index) => key !== PROFILE_KEYS[index])) {
    throw new Error("executor transport profile contains unsupported or missing fields");
  }
  if (profile.version !== "executor_transport_profile.v1"
    || profile.carrier !== "codex_executor_mcp"
    || profile.session_protocol !== "automatic_build_executor_session.v2") {
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
  sha256Identity(profile.profile_digest, "profile_digest");
  const { profile_digest: _profileDigest, ...unsigned } = profile;
  if (profile.profile_digest !== profileDigest(unsigned)) {
    throw new Error("executor transport profile digest is invalid");
  }
  return profile;
}

export const CODEX_EXECUTOR_TRANSPORT_PROFILE_V1 = createExecutorTransportProfile({
  carrier: "codex_executor_mcp",
  session_protocol: "automatic_build_executor_session.v2",
  max_tool_result_tokens: 2_048,
  max_tool_result_bytes: 8_192,
  result_envelope_reserve_tokens: 256,
  max_input_chunks: 64,
  max_candidate_request_tokens: 2_048,
  max_candidate_request_bytes: 32_768,
});

export function measureExecutorTransportResponse(
  response: unknown,
  payloadUtf8: string,
  profile: ExecutorTransportProfileV1,
): ExecutorTransportResponseMeasurementV1 {
  validateExecutorTransportProfile(profile);
  if (typeof payloadUtf8 !== "string") throw new Error("executor transport payload must be a string");
  const serializedResponse = canonicalAutomaticBuildJson(response);
  const payloadEstimatedTokens = estimateTokens(payloadUtf8);
  const serializedResponseTokens = estimateTokens(serializedResponse);
  const envelopeOverheadTokens = Math.max(0, serializedResponseTokens - payloadEstimatedTokens);
  const serializedResponseBytes = Buffer.byteLength(serializedResponse, "utf8");
  const blockingReasons: ExecutorTransportBlockReasonV1[] = [];
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
  const common: ExecutorTransportResponseMeasurementCommonV1 = {
    version: "executor_transport_response_measurement.v1",
    transport_profile_digest: profile.profile_digest,
    payload_sha256: sha256(payloadUtf8),
    payload_byte_length: Buffer.byteLength(payloadUtf8, "utf8"),
    payload_estimated_tokens: payloadEstimatedTokens,
    serialized_response: serializedResponse,
    serialized_response_sha256: sha256(serializedResponse),
    serialized_response_bytes: serializedResponseBytes,
    serialized_response_tokens: serializedResponseTokens,
    envelope_overhead_tokens: envelopeOverheadTokens,
  };
  return blockingReasons.length
    ? { ...common, status: "blocked", blocking_reasons: blockingReasons }
    : { ...common, status: "within_limit", blocking_reasons: [] };
}

function packedChunk(
  frame: ExecutorTransportChunkFrameV1,
  response: unknown,
  measurement: ExecutorTransportResponseMeasurementV1,
): PackedExecutorTransportChunkV1 {
  if (measurement.status !== "within_limit") {
    throw new Error("cannot create a packed chunk from a blocked response");
  }
  return {
    ...frame,
    response,
    serialized_response: measurement.serialized_response,
    serialized_response_sha256: measurement.serialized_response_sha256,
    serialized_response_bytes: measurement.serialized_response_bytes,
    serialized_response_tokens: measurement.serialized_response_tokens,
    payload_estimated_tokens: measurement.payload_estimated_tokens,
    envelope_overhead_tokens: measurement.envelope_overhead_tokens,
  };
}

function packDigest(input: Omit<ExecutorTransportPackWithinLimitV1, "chunks" | "pack_digest"> & {
  chunks: PackedExecutorTransportChunkV1[];
}): string {
  return sha256(canonicalAutomaticBuildJson({
    version: input.version,
    status: input.status,
    transport_profile_digest: input.transport_profile_digest,
    payload_sha256: input.payload_sha256,
    payload_byte_length: input.payload_byte_length,
    payload_estimated_tokens: input.payload_estimated_tokens,
    chunk_count: input.chunk_count,
    input_delivery_overhead_tokens: input.input_delivery_overhead_tokens,
    chunks: input.chunks.map((chunk) => ({
      ordinal: chunk.ordinal,
      byte_range: chunk.byte_range,
      payload_sha256: chunk.payload_sha256,
      serialized_response_sha256: chunk.serialized_response_sha256,
      serialized_response_bytes: chunk.serialized_response_bytes,
      serialized_response_tokens: chunk.serialized_response_tokens,
      payload_estimated_tokens: chunk.payload_estimated_tokens,
      envelope_overhead_tokens: chunk.envelope_overhead_tokens,
      final: chunk.final,
    })),
  }));
}

function blockedPack(
  profile: ExecutorTransportProfileV1,
  payloadUtf8: string,
  code: ExecutorTransportPackBlockedV1["code"],
  requiredChunkCount: number,
  blockingReasons: ExecutorTransportBlockReasonV1[] = [],
): ExecutorTransportPackBlockedV1 {
  return {
    version: "executor_transport_pack.v1",
    status: "blocked",
    code,
    transport_profile_digest: profile.profile_digest,
    payload_sha256: sha256(payloadUtf8),
    payload_byte_length: Buffer.byteLength(payloadUtf8, "utf8"),
    required_chunk_count: requiredChunkCount,
    blocking_reasons: [...blockingReasons],
  };
}

export function packExecutorTransportPayload(
  input: PackExecutorTransportPayloadRequestV1,
): ExecutorTransportPackResultV1 {
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
  const chunks: PackedExecutorTransportChunkV1[] = [];

  const evaluateRange = (start: number, end: number): {
    end: number;
    frame: ExecutorTransportChunkFrameV1;
    response: unknown;
    measurement: ExecutorTransportResponseMeasurementV1;
  } => {
    const payload = codePoints.slice(start, end).join("");
    const frame: ExecutorTransportChunkFrameV1 = {
      ordinal: chunks.length,
      byte_range: { start: byteOffsets[start], end: byteOffsets[end] },
      payload_utf8: payload,
      payload_sha256: sha256(payload),
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
        profile,
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
        profile,
        input.payload_utf8,
        "max_chunk_count_exceeded",
        chunks.length + 1,
      );
    }
    let low = start + 1;
    let high = codePoints.length;
    let best: ReturnType<typeof evaluateRange> | undefined;
    let firstBlocked: ExecutorTransportResponseMeasurementV1 | undefined;
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
        profile,
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
    version: "executor_transport_pack.v1" as const,
    status: "within_limit" as const,
    transport_profile_digest: profile.profile_digest,
    payload_sha256: sha256(input.payload_utf8),
    payload_byte_length: Buffer.byteLength(input.payload_utf8, "utf8"),
    payload_estimated_tokens: estimateTokens(input.payload_utf8),
    chunk_count: chunks.length,
    input_delivery_overhead_tokens: chunks.reduce(
      (total, chunk) => total + chunk.envelope_overhead_tokens,
      0,
    ),
    chunks,
  };
  return { ...unsigned, pack_digest: packDigest(unsigned) };
}

export function validateExecutorTransportPack(
  pack: ExecutorTransportPackWithinLimitV1,
  profile: ExecutorTransportProfileV1,
): ExecutorTransportPackWithinLimitV1 {
  validateExecutorTransportProfile(profile);
  if (!pack || typeof pack !== "object" || Array.isArray(pack)
    || pack.version !== "executor_transport_pack.v1" || pack.status !== "within_limit") {
    throw new Error("executor transport pack is invalid");
  }
  if (pack.transport_profile_digest !== profile.profile_digest) {
    throw new Error("executor transport pack profile does not match");
  }
  sha256Identity(pack.payload_sha256, "payload_sha256");
  sha256Identity(pack.pack_digest, "pack_digest");
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
    if (chunk.ordinal !== ordinal
      || chunk.byte_range.start !== expectedByteStart
      || chunk.byte_range.end <= chunk.byte_range.start
      || chunk.final !== (ordinal === pack.chunks.length - 1)) {
      throw new Error("executor transport chunk ordering or range is invalid");
    }
    const chunkBytes = Buffer.byteLength(chunk.payload_utf8, "utf8");
    if (chunk.byte_range.end - chunk.byte_range.start !== chunkBytes
      || chunk.payload_sha256 !== sha256(chunk.payload_utf8)) {
      throw new Error("executor transport chunk payload identity is invalid");
    }
    const measured = measureExecutorTransportResponse(chunk.response, chunk.payload_utf8, profile);
    if (measured.status !== "within_limit"
      || measured.serialized_response !== chunk.serialized_response
      || measured.serialized_response_sha256 !== chunk.serialized_response_sha256
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
    || sha256(payload) !== pack.payload_sha256
    || estimateTokens(payload) !== pack.payload_estimated_tokens
    || overheadTokens !== pack.input_delivery_overhead_tokens) {
    throw new Error("executor transport pack aggregate identity is invalid");
  }
  const { pack_digest: _packDigest, ...unsigned } = pack;
  if (pack.pack_digest !== packDigest(unsigned)) {
    throw new Error("executor transport pack digest is invalid");
  }
  return pack;
}
