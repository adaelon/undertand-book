import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
  createExecutorTransportProfile,
  measureExecutorTransportResponse,
  packExecutorTransportPayload,
  validateExecutorTransportPack,
  validateExecutorTransportProfile,
  type ExecutorTransportChunkFrameV1,
  type ExecutorTransportProfileV1,
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
  overrides: Partial<Omit<ExecutorTransportProfileV1, "version" | "carrier" | "session_protocol" | "profile_digest">> = {},
): ExecutorTransportProfileV1 {
  return createExecutorTransportProfile({
    carrier: "codex_executor_mcp",
    session_protocol: "automatic_build_executor_session.v2",
    max_tool_result_tokens: 2_048,
    max_tool_result_bytes: 8_192,
    result_envelope_reserve_tokens: 256,
    max_input_chunks: 64,
    max_candidate_request_tokens: 2_048,
    max_candidate_request_bytes: 8_192,
    ...overrides,
  });
}

function syntheticEnvelope(frame: ExecutorTransportChunkFrameV1): unknown {
  return {
    version: "synthetic_executor_input_chunk.v1",
    opaque_session_ref: `absession1_${"a".repeat(64)}`,
    generation_input_ref: `abinput1_${"b".repeat(64)}`,
    segment: "semantic_input",
    ordinal: frame.ordinal,
    byte_range: frame.byte_range,
    payload_utf8: frame.payload_utf8,
    payload_sha256: frame.payload_sha256,
    final_for_segment: frame.final,
    chunk_receipt: `abchunk1_${createHash("sha256").update([
      frame.ordinal,
      frame.byte_range.start,
      frame.byte_range.end,
      frame.payload_sha256,
    ].join(":"), "utf8").digest("hex")}`,
  };
}

describe("executor transport profile and response packer", () => {
  it("freezes the first conservative Codex executor carrier profile and rejects digest drift", () => {
    expect(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1).toMatchObject({
      version: "executor_transport_profile.v1",
      carrier: "codex_executor_mcp",
      session_protocol: "automatic_build_executor_session.v2",
      max_tool_result_tokens: 2_048,
      max_tool_result_bytes: 8_192,
    });
    expect(validateExecutorTransportProfile(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1))
      .toBe(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1);
    expect(() => validateExecutorTransportProfile({
      ...CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
      max_input_chunks: CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.max_input_chunks + 1,
    })).toThrow(/digest/i);
  });

  it("packs an exact 317,247-byte deterministic input into bounded canonical responses", () => {
    const payload = deterministicUtf8Text("executor-transport-317247", 317_247);
    const packed = packExecutorTransportPayload({
      profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V1,
      payload_utf8: payload,
      envelope_for_chunk: syntheticEnvelope,
    });

    expect(packed.status).toBe("within_limit");
    if (packed.status !== "within_limit") throw new Error("expected transport pack");
    expect(validateExecutorTransportPack(packed, CODEX_EXECUTOR_TRANSPORT_PROFILE_V1)).toBe(packed);
    expect(packed.payload_byte_length).toBe(317_247);
    expect(packed.chunk_count).toBeGreaterThan(1);
    expect(packed.chunk_count).toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.max_input_chunks);
    expect(packed.chunks.map((chunk) => chunk.payload_utf8).join("")).toBe(payload);

    let expectedStart = 0;
    for (const chunk of packed.chunks) {
      expect(chunk.byte_range.start).toBe(expectedStart);
      expect(chunk.byte_range.end - chunk.byte_range.start)
        .toBe(Buffer.byteLength(chunk.payload_utf8, "utf8"));
      expect(chunk.serialized_response_bytes)
        .toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.max_tool_result_bytes);
      expect(chunk.serialized_response_tokens)
        .toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.max_tool_result_tokens);
      expect(chunk.envelope_overhead_tokens)
        .toBeLessThanOrEqual(CODEX_EXECUTOR_TRANSPORT_PROFILE_V1.result_envelope_reserve_tokens);
      expect(chunk.payload_sha256)
        .toBe(createHash("sha256").update(chunk.payload_utf8, "utf8").digest("hex"));
      expectedStart = chunk.byte_range.end;
    }
    expect(expectedStart).toBe(317_247);
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
