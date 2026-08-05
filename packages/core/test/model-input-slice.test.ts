import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LidNode } from "../src/generated/LidNode";
import {
  routeModelInputSlices,
  validateModelInputSliceCoverage,
  type ModelInputSliceRenderContextV1,
} from "../src/model-input-slice";
import { createSyntheticRoutabilityFixture } from "./helpers/model-input-routability-fixture";

const PROMPT_SHA = createHash("sha256").update("slice-test-prompt").digest("hex");

function budget(limit: number) {
  return {
    router_version: "model_input_slice_test.v1",
    prompt_sha256: PROMPT_SHA,
    stage_body_limit_tokens: limit,
    executor_context_floor_tokens: 100_000,
    prompt_reserve_tokens: 0,
    protocol_reserve_tokens: 0,
    output_reserve_tokens: 0,
    safety_margin_tokens: 0,
  };
}

function parent(source: string, kind: LidNode["kind"] = "paragraph", start = 0, end = source.length): LidNode {
  return { lid: "1.1", path: [1, 1], kind, span: { start, end }, children: [] };
}

function fragmentRenderer(input: ModelInputSliceRenderContextV1): string {
  if (input.boundary_kind === "whole_lid") return input.core;
  return [
    "CONTEXT_BEFORE",
    input.context_before,
    "CORE",
    input.core,
    "CONTEXT_AFTER",
    input.context_after,
  ].join("\n");
}

function assertSafeUtf16Cut(source: string, position: number): void {
  const before = source.charCodeAt(position - 1);
  const after = source.charCodeAt(position);
  expect(!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)).toBe(true);
  expect(source[position - 1] === "\r" && source[position] === "\n").toBe(false);
  expect(source[position - 1] === "\u200d" || source[position] === "\u200d").toBe(false);
  const next = source.slice(position).match(/^\P{M}*(\p{M})/u);
  if (source.slice(position).match(/^\p{M}/u)) expect(next).toBeNull();
}

describe("model input slicing", () => {
  it("keeps a fitting whole LID as one byte-identical fast-path slice", () => {
    const source = "A short paragraph.";
    const routed = routeModelInputSlices({
      source,
      source_fingerprint: "source-v1",
      parent: parent(source),
      budget: budget(100),
      render: fragmentRenderer,
    });
    expect(routed.status).toBe("routed");
    if (routed.status !== "routed") throw new Error("expected routed input");
    expect(routed.slices).toHaveLength(1);
    expect(routed.slices[0].slice).toMatchObject({ ordinal: 0, boundary_kind: "whole_lid" });
    expect(routed.slices[0].rendered_input).toBe(source);
    expect(routed.slices[0].proof.rendered_input_sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(routed.coverage).toMatchObject({ gap_utf16: 0, core_overlap_utf16: 0, covered_core_utf16: source.length });
  });

  it("routes the deterministic 6,992-token shape into stable exact-cover slices without changing source/LID identity", () => {
    const fixture = createSyntheticRoutabilityFixture();
    const paragraph = fixture.by_lid.get(fixture.paragraph_lid)!;
    const before = JSON.stringify({ source: fixture.identity.source_sha256, blocks: fixture.identity.source_blocks_sha256, lids: fixture.identity.lid_tree_sha256, spans: fixture.identity.lid_spans_sha256 });
    const route = () => routeModelInputSlices({
      source: fixture.source,
      source_fingerprint: fixture.identity.source_sha256,
      parent: paragraph,
      budget: budget(5_000),
      context_overlap_utf16: 64,
      render: fragmentRenderer,
    });
    const first = route();
    const second = route();
    expect(first.status).toBe("routed");
    expect(second).toEqual(first);
    if (first.status !== "routed") throw new Error("expected routed long paragraph");
    expect(first.slices.length).toBeGreaterThan(1);
    expect(first.slices.every((item) => item.proof.status === "within_limit")).toBe(true);
    expect(first.coverage).toMatchObject({
      parent_lid: fixture.paragraph_lid,
      gap_utf16: 0,
      core_overlap_utf16: 0,
      expected_core_utf16: fixture.paragraph_text.length,
      covered_core_utf16: fixture.paragraph_text.length,
    });
    const after = JSON.stringify({ source: fixture.identity.source_sha256, blocks: fixture.identity.source_blocks_sha256, lids: fixture.identity.lid_tree_sha256, spans: fixture.identity.lid_spans_sha256 });
    expect(after).toBe(before);
  });

  it("never cuts surrogate pairs, combining sequences, CRLF, or emoji ZWJ sequences", () => {
    const source = "A🙂e\u0301\r\n中，B👩\u200d💻C。D🙂e\u0301E";
    const routed = routeModelInputSlices({
      source,
      source_fingerprint: "unicode-v1",
      parent: parent(source),
      budget: budget(2),
      render: ({ core }) => core,
    });
    expect(routed.status).toBe("routed");
    if (routed.status !== "routed") throw new Error("expected Unicode route");
    expect(routed.slices.length).toBeGreaterThan(1);
    for (const item of routed.slices.slice(0, -1)) assertSafeUtf16Cut(source, item.slice.core_span_utf16.end);
    expect(routed.slices.map((item) => source.slice(
      item.slice.core_span_utf16.start,
      item.slice.core_span_utf16.end,
    )).join("")).toBe(source);
  });

  it.each(["code", "table", "formula", "image"] as const)(
    "blocks an over-limit atomic or unsafely splittable %s input without truncation",
    (kind) => {
      const source = "x".repeat(200);
      const routed = routeModelInputSlices({
        source,
        source_fingerprint: `${kind}-v1`,
        parent: parent(source, kind),
        budget: budget(1),
        render: ({ core }) => core,
      });
      expect(routed).toMatchObject({
        status: "blocked",
        recovery: { code: "model_input_unsplittable", parent_lid: "1.1", lid_kind: kind, retryable: false },
      });
      expect(JSON.stringify(routed)).not.toContain(source);
    },
  );

  it("rejects stale slices when source bytes, fingerprint, or parent span changes", () => {
    const source = "One sentence. Two sentence. Three sentence.";
    const currentParent = parent(source);
    const routed = routeModelInputSlices({
      source,
      source_fingerprint: "fresh-v1",
      parent: currentParent,
      budget: budget(2),
      render: ({ core }) => core,
    });
    if (routed.status !== "routed") throw new Error("expected route");
    const slices = routed.slices.map((item) => item.slice);
    const mutated = `X${source.slice(1)}`;
    expect(() => validateModelInputSliceCoverage({ source: mutated, source_fingerprint: "fresh-v1", parent: currentParent, slices })).toThrow("digest");
    expect(() => validateModelInputSliceCoverage({ source, source_fingerprint: "fresh-v2", parent: currentParent, slices })).toThrow("identity");
    expect(() => validateModelInputSliceCoverage({ source, source_fingerprint: "fresh-v1", parent: parent(source, "paragraph", 0, source.length - 1), slices })).toThrow();
  });

  it("satisfies exact partition for deterministic mixed-Unicode property samples", () => {
    const atoms = ["a", "中", "🙂", "e\u0301", "\r\n", "。", "，", " ", "👩\u200d💻"];
    let state = 0x5eed1234;
    const next = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state;
    };
    for (let sample = 0; sample < 40; sample++) {
      const source = Array.from({ length: 20 + (next() % 30) }, () => atoms[next() % atoms.length]).join("");
      const routed = routeModelInputSlices({
        source,
        source_fingerprint: `sample-${sample}`,
        parent: parent(source),
        budget: budget(3),
        context_overlap_utf16: 3,
        render: ({ core }) => core,
      });
      expect(routed.status, `sample ${sample}`).toBe("routed");
      if (routed.status !== "routed") continue;
      expect(routed.coverage).toMatchObject({ gap_utf16: 0, core_overlap_utf16: 0 });
      expect(routed.slices.map((item) => source.slice(
        item.slice.core_span_utf16.start,
        item.slice.core_span_utf16.end,
      )).join("")).toBe(source);
    }
  });
});
