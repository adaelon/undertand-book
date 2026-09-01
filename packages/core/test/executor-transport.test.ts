import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1,
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
  createExecutorTransportProfile,
  measureExecutorTransportResponse,
  packExecutorTransportBatches,
  packExecutorTransportPayload,
  validateExecutorTransportPack,
  validateExecutorTransportProfile,
  type ExecutorTransportChunkFrameV2,
  type ExecutorTransportDeliveryBatchLimitV1,
  type ExecutorTransportProfileV2,
} from "../src/executor-transport";

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

function profile(
  overrides: Partial<Omit<ExecutorTransportProfileV2, "version" | "carrier" | "session_protocol">> = {},
): ExecutorTransportProfileV2 {
  return createExecutorTransportProfile({
    carrier: "codex_executor_mcp",
    session_protocol: "automatic_build_executor_session.v3",
    max_tool_result_tokens: 2_048,
    max_tool_result_bytes: 8_192,
    result_envelope_reserve_tokens: 256,
    max_input_chunks: 64,
    max_candidate_request_tokens: 2_048,
    max_candidate_request_bytes: 8_192,
    ...overrides,
  });
}

function syntheticEnvelope(frame: ExecutorTransportChunkFrameV2): unknown {
  return {
    version: "synthetic_executor_input_chunk.v2",
    opaque_session_ref: `absession1_${"a".repeat(64)}`,
    generation_input_ref: `abinput1_${"b".repeat(64)}`,
    segment: "semantic_input",
    ordinal: frame.ordinal,
    byte_range: frame.byte_range,
    payload_utf8: frame.payload_utf8,
    final_for_segment: frame.final,
  };
}

describe("executor transport profile and response packer", () => {
  it("packs contiguous chunks to the exact MCP result byte boundary and splits at boundary plus one", () => {
    const packed = packExecutorTransportPayload({
      profile: profile({
        max_tool_result_tokens: 512,
        max_tool_result_bytes: 2_048,
        result_envelope_reserve_tokens: 256,
      }),
      payload_utf8: deterministicUtf8Text("executor-batch-boundary", 4_096),
      envelope_for_chunk: syntheticEnvelope,
    });
    if (packed.status !== "within_limit" || packed.chunks.length < 3) {
      throw new Error("expected at least three transport chunks for batch fixture");
    }
    const envelopeForChunks = (chunks: typeof packed.chunks) => ({
      version: "automatic_build_executor_session.v3",
      action: {
        kind: "INPUT_BATCH",
        batch: {
          version: "automatic_build_executor_input_batch.v1",
          chunks: chunks.map((chunk) => chunk.response),
          first_ordinal: chunks[0]?.ordinal,
          last_ordinal: chunks.at(-1)?.ordinal,
          final_for_generation: chunks.at(-1)?.final ?? false,
        },
      },
    });
    const twoChunkProbe = packExecutorTransportBatches({
      chunks: packed.chunks.slice(0, 2),
      limit: {
        ...CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1,
        max_chunks_per_batch: 2,
        max_batches_per_work_unit: 2,
        max_serialized_batch_bytes: Number.MAX_SAFE_INTEGER,
      },
      envelope_for_chunks: envelopeForChunks,
    });
    expect(twoChunkProbe.status).toBe("within_limit");
    if (twoChunkProbe.status !== "within_limit") throw new Error("expected two-chunk probe");
    const exactBytes = twoChunkProbe.batches[0].serialized_mcp_result_bytes;

    const limit = (maxSerializedBatchBytes: number): ExecutorTransportDeliveryBatchLimitV1 => ({
      ...CODEX_EXECUTOR_DELIVERY_BATCH_LIMIT_V1,
      max_chunks_per_batch: 2,
      max_batches_per_work_unit: packed.chunks.length,
      max_serialized_batch_bytes: maxSerializedBatchBytes,
    });
    const exact = packExecutorTransportBatches({
      chunks: packed.chunks,
      limit: limit(exactBytes),
      envelope_for_chunks: envelopeForChunks,
    });
    expect(exact.status).toBe("within_limit");
    if (exact.status !== "within_limit") throw new Error("expected exact-boundary batches");
    expect(exact.batches[0].chunks).toHaveLength(2);
    expect(exact.batches[0].serialized_mcp_result_bytes).toBe(exactBytes);

    const plusOne = packExecutorTransportBatches({
      chunks: packed.chunks,
      limit: limit(exactBytes - 1),
      envelope_for_chunks: envelopeForChunks,
    });
    expect(plusOne.status).toBe("within_limit");
    if (plusOne.status !== "within_limit") throw new Error("expected split batches");
    expect(plusOne.batches[0].chunks).toHaveLength(1);
    expect(plusOne.batches.flatMap((batch) => batch.chunks).map((chunk) => chunk.ordinal))
      .toEqual(packed.chunks.map((chunk) => chunk.ordinal));
  });

  it("freezes the V2 Codex executor carrier profile and rejects invalid direct fields", () => {
    expect(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2).toMatchObject({
      version: "executor_transport_profile.v2",
      carrier: "codex_executor_mcp",
      session_protocol: "automatic_build_executor_session.v3",
      max_tool_result_tokens: 2_048,
      max_tool_result_bytes: 8_192,
    });
    expect(validateExecutorTransportProfile(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2))
      .toBe(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2);
    expect(() => validateExecutorTransportProfile({
      ...CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      result_envelope_reserve_tokens: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_tool_result_tokens + 1,
    })).toThrow(/reserve/i);
  });

  it("packs an exact 317,247-byte deterministic input into bounded canonical responses", () => {
    const payload = deterministicUtf8Text("executor-transport-317247", 317_247);
    const packed = packExecutorTransportPayload({
      profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      payload_utf8: payload,
      envelope_for_chunk: syntheticEnvelope,
    });

    expect(packed.status).toBe("within_limit");
    if (packed.status !== "within_limit") throw new Error("expected transport pack");
    expect(validateExecutorTransportPack(
      packed,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      payload,
    )).toBe(packed);
    expect(packed.payload_byte_length).toBe(317_247);
    expect(packed.chunk_count).toBeGreaterThan(1);
    expect(packed.chunk_count).toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_input_chunks);
    expect(packed.chunks.map((chunk) => chunk.payload_utf8).join("")).toBe(payload);

    let expectedStart = 0;
    for (const chunk of packed.chunks) {
      expect(chunk.byte_range.start).toBe(expectedStart);
      expect(chunk.byte_range.end - chunk.byte_range.start)
        .toBe(Buffer.byteLength(chunk.payload_utf8, "utf8"));
      expect(chunk.serialized_response_bytes)
        .toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_tool_result_bytes);
      expect(chunk.serialized_response_tokens)
        .toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.max_tool_result_tokens);
      expect(chunk.envelope_overhead_tokens)
        .toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2.result_envelope_reserve_tokens);
      expectedStart = chunk.byte_range.end;
    }
    expect(expectedStart).toBe(317_247);
  });

  it("H0 compares profile fields, ordinal ranges, payload text, and serialized responses without transport summaries", () => {
    const payload = deterministicUtf8Text("executor-transport-h0", 20_003);
    const packed = packExecutorTransportPayload({
      profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      payload_utf8: payload,
      envelope_for_chunk: syntheticEnvelope,
    });
    expect(packed.status).toBe("within_limit");
    if (packed.status !== "within_limit") throw new Error("expected H0 transport pack");
    const first = packed.chunks[0];
    const measured = measureExecutorTransportResponse(
      first.response,
      first.payload_utf8,
      CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    );

    expect(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2).toMatchObject({
      version: "executor_transport_profile.v2",
      carrier: "codex_executor_mcp",
      session_protocol: "automatic_build_executor_session.v3",
      max_tool_result_tokens: 2_048,
      max_tool_result_bytes: 8_192,
    });
    expect(packed.chunks.map((chunk) => chunk.payload_utf8).join("")).toBe(payload);
    expect(first.byte_range.end - first.byte_range.start)
      .toBe(Buffer.byteLength(first.payload_utf8, "utf8"));
    expect(measured.serialized_response).toBe(first.serialized_response);

    const present = [
      Object.hasOwn(CODEX_EXECUTOR_TRANSPORT_PROFILE_V2, "profile_digest") ? "profile_digest" : undefined,
      Object.hasOwn(packed, "transport_profile_digest") ? "transport_profile_digest" : undefined,
      Object.hasOwn(packed, "payload_sha256") ? "payload_sha256" : undefined,
      Object.hasOwn(packed, "pack_digest") ? "pack_digest" : undefined,
      Object.hasOwn(first, "payload_sha256") ? "chunk.payload_sha256" : undefined,
      Object.hasOwn(first, "serialized_response_sha256") ? "serialized_response_sha256" : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: H4 deletes these summaries and validates the explicit profile fields,
    // ordinal/range/UTF-8 length, original payload, and serialized response exercised above.
    expect(present).toEqual([]);
  });

  it("checks token, byte, envelope-reserve, and max-chunk gates independently", () => {
    const tokenBlocked = measureExecutorTransportResponse(
      { payload_utf8: "界" },
      "界",
      profile({ max_tool_result_tokens: 3, result_envelope_reserve_tokens: 3 }),
    );
    expect(tokenBlocked.status).toBe("blocked");
    expect(tokenBlocked.blocking_reasons).toContain("token_cap_exceeded");

    const byteBlocked = measureExecutorTransportResponse(
      { payload_utf8: "x" },
      "x",
      profile({
        max_tool_result_tokens: 1_000,
        max_tool_result_bytes: 10,
        result_envelope_reserve_tokens: 1_000,
      }),
    );
    expect(byteBlocked.status).toBe("blocked");
    expect(byteBlocked.blocking_reasons).toContain("byte_cap_exceeded");

    const envelopeBlocked = measureExecutorTransportResponse(
      { payload_utf8: "x" },
      "x",
      profile({
        max_tool_result_tokens: 1_000,
        max_tool_result_bytes: 1_000,
        result_envelope_reserve_tokens: 0,
      }),
    );
    expect(envelopeBlocked.status).toBe("blocked");
    expect(envelopeBlocked.blocking_reasons).toContain("envelope_reserve_exceeded");

    const controlOnly = measureExecutorTransportResponse(
      { action: "DELIVER_INPUT", manifest_digest: "a".repeat(64) },
      "",
      profile({
        max_tool_result_tokens: 1_000,
        max_tool_result_bytes: 1_000,
        result_envelope_reserve_tokens: 0,
      }),
    );
    expect(controlOnly.status).toBe("within_limit");

    const chunksBlocked = packExecutorTransportPayload({
      profile: profile({
        max_tool_result_tokens: 1_000,
        max_tool_result_bytes: 1_024,
        result_envelope_reserve_tokens: 256,
        max_input_chunks: 1,
      }),
      payload_utf8: "x".repeat(2_000),
      envelope_for_chunk: syntheticEnvelope,
    });
    expect(chunksBlocked).toMatchObject({
      status: "blocked",
      code: "max_chunk_count_exceeded",
    });
  });

  it("accepts an exact serialized byte cap, preserves Unicode boundaries, and blocks one byte below", () => {
    const payload = "界🙂alpha";
    const generous = profile({ max_input_chunks: 1 });
    const initial = packExecutorTransportPayload({
      profile: generous,
      payload_utf8: payload,
      envelope_for_chunk: syntheticEnvelope,
    });
    if (initial.status !== "within_limit") throw new Error("expected initial transport pack");
    expect(initial.chunk_count).toBe(1);

    const exact = profile({
      max_tool_result_bytes: initial.chunks[0].serialized_response_bytes,
      max_input_chunks: 1,
    });
    const exactPack = packExecutorTransportPayload({
      profile: exact,
      payload_utf8: payload,
      envelope_for_chunk: syntheticEnvelope,
    });
    expect(exactPack.status).toBe("within_limit");
    if (exactPack.status !== "within_limit") throw new Error("expected exact transport pack");
    expect(exactPack.chunks[0].payload_utf8).toBe(payload);

    const below = profile({
      max_tool_result_bytes: initial.chunks[0].serialized_response_bytes - 1,
      max_input_chunks: 1,
    });
    expect(packExecutorTransportPayload({
      profile: below,
      payload_utf8: payload,
      envelope_for_chunk: syntheticEnvelope,
    })).toMatchObject({ status: "blocked", code: "max_chunk_count_exceeded" });
  });
});
