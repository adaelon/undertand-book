import { createHash } from "node:crypto";
import type { LidNode } from "./generated/LidNode";
import {
  evaluateModelInputBudget,
  type ModelInputBudgetProofV1,
  type ModelInputBudgetRequestV1,
} from "./model-input-budget";

export type ModelInputSliceBoundaryKind = "whole_lid" | "sentence" | "punctuation" | "line" | "grapheme";

export interface ModelInputSliceV1 {
  version: "model_input_slice.v1";
  source_fingerprint: string;
  parent_lid: string;
  ordinal: number;
  core_span_utf16: { start: number; end: number };
  context_span_utf16: { start: number; end: number };
  boundary_kind: ModelInputSliceBoundaryKind;
  core_sha256: string;
  context_sha256: string;
}

export interface ModelInputSliceRenderContextV1 {
  version: "model_input_slice_render_context.v1";
  parent_lid: string;
  ordinal: number;
  boundary_kind: ModelInputSliceBoundaryKind;
  core_span_utf16: ModelInputSliceV1["core_span_utf16"];
  context_span_utf16: ModelInputSliceV1["context_span_utf16"];
  context_before: string;
  core: string;
  context_after: string;
}

export interface RoutedModelInputSliceV1 {
  slice: ModelInputSliceV1;
  rendered_input: string;
  proof: ModelInputBudgetProofV1;
}

export interface ModelInputUnsplittableDraftV1 {
  version: "automatic_build_recovery_draft.v1";
  phase: "routing";
  code: "model_input_unsplittable";
  parent_lid: string;
  lid_kind: LidNode["kind"];
  reason: "atomic_input" | "no_safe_boundary" | "renderer_fixed_overhead";
  estimated_tokens: number;
  limit_tokens: number;
  retryable: false;
}

export type ModelInputSliceRouteResultV1 =
  | { status: "routed"; slices: RoutedModelInputSliceV1[]; coverage: ModelInputSliceCoverageV1 }
  | { status: "blocked"; recovery: ModelInputUnsplittableDraftV1 };

export interface ModelInputSliceCoverageV1 {
  version: "model_input_slice_coverage.v1";
  parent_lid: string;
  parent_span_utf16: { start: number; end: number };
  slice_count: number;
  expected_core_utf16: number;
  covered_core_utf16: number;
  gap_utf16: number;
  core_overlap_utf16: number;
  coverage_digest: string;
}

export interface RouteModelInputSlicesInputV1 {
  source: string;
  source_fingerprint: string;
  parent: LidNode;
  budget: Omit<ModelInputBudgetRequestV1, "rendered_input">;
  render: (input: ModelInputSliceRenderContextV1) => string;
  context_overlap_utf16?: number;
}

interface BoundaryCandidate {
  end: number;
  kind: ModelInputSliceBoundaryKind;
}

interface EvaluatedCandidate {
  routed: RoutedModelInputSliceV1;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function assertParent(source: string, parent: LidNode, sourceFingerprint: string): void {
  if (!sourceFingerprint || Buffer.byteLength(sourceFingerprint, "utf8") > 512) {
    throw new Error("source_fingerprint must be a non-empty bounded string");
  }
  if (!Number.isSafeInteger(parent.span.start) || !Number.isSafeInteger(parent.span.end)
    || parent.span.start < 0 || parent.span.end <= parent.span.start || parent.span.end > source.length) {
    throw new Error(`parent ${parent.lid} has an invalid UTF-16 span`);
  }
  if (parent.children.length) throw new Error(`model input slicing requires a leaf LID: ${parent.lid}`);
}

function codePointsWithOffsets(text: string): Array<{ value: string; start: number; end: number }> {
  const points: Array<{ value: string; start: number; end: number }> = [];
  let offset = 0;
  for (const value of text) {
    const start = offset;
    offset += value.length;
    points.push({ value, start, end: offset });
  }
  return points;
}

function isCombining(value: string): boolean {
  return /^\p{M}$/u.test(value);
}

function isVariationSelector(value: string): boolean {
  const code = value.codePointAt(0)!;
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isEmojiModifier(value: string): boolean {
  const code = value.codePointAt(0)!;
  return code >= 0x1f3fb && code <= 0x1f3ff;
}

function isRegionalIndicator(value: string): boolean {
  const code = value.codePointAt(0)!;
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

function graphemeEnds(text: string, absoluteStart: number): number[] {
  const points = codePointsWithOffsets(text);
  if (!points.length) return [];
  const ends: number[] = [];
  let regionalRun = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[index + 1];
    if (isRegionalIndicator(current.value)) regionalRun += 1;
    else regionalRun = 0;
    const joinsNext = next !== undefined && (
      (current.value === "\r" && next.value === "\n")
      || next.value === "\u200d"
      || current.value === "\u200d"
      || isCombining(next.value)
      || isVariationSelector(next.value)
      || isEmojiModifier(next.value)
      || (isRegionalIndicator(current.value) && isRegionalIndicator(next.value) && regionalRun % 2 === 1)
    );
    if (!joinsNext) ends.push(absoluteStart + current.end);
  }
  return ends;
}

function regexEnds(text: string, absoluteStart: number, pattern: RegExp): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(pattern)) ends.push(absoluteStart + match.index! + match[0].length);
  return ends;
}

function uniqueSorted(values: number[], start: number, end: number): number[] {
  return [...new Set(values.filter((value) => value > start && value <= end))].sort((left, right) => left - right);
}

function boundaryTiers(parent: LidNode, source: string): BoundaryCandidate[][] {
  const text = source.slice(parent.span.start, parent.span.end);
  const start = parent.span.start;
  const end = parent.span.end;
  if (parent.kind === "formula" || parent.kind === "image") return [];
  if (parent.kind === "code" || parent.kind === "table") {
    const lines = uniqueSorted(regexEnds(text, start, /\r\n|\n|\r/g), start, end)
      .filter((position) => position < end)
      .map((position) => ({ end: position, kind: "line" as const }));
    if (lines.length) lines.push({ end, kind: "line" });
    return lines.length ? [lines] : [];
  }
  const sentence = uniqueSorted(
    regexEnds(text, start, /[.!?。！？]+[\]）)】」』”’"']*/gu),
    start,
    end,
  ).map((position) => ({ end: position, kind: "sentence" as const }));
  const punctuation = uniqueSorted(
    regexEnds(text, start, /[,;:，；：、]+/gu),
    start,
    end,
  ).map((position) => ({ end: position, kind: "punctuation" as const }));
  const whitespace = uniqueSorted(
    regexEnds(text, start, /\s+/gu),
    start,
    end,
  ).map((position) => ({ end: position, kind: "grapheme" as const }));
  const grapheme = uniqueSorted(graphemeEnds(text, start), start, end)
    .map((position) => ({ end: position, kind: "grapheme" as const }));
  return [sentence, punctuation, whitespace, grapheme].filter((tier) => tier.length > 0);
}

function lowerBoundary(boundaries: number[], target: number, floor: number): number {
  let selected = floor;
  for (const boundary of boundaries) {
    if (boundary > target) break;
    if (boundary >= floor) selected = boundary;
  }
  return selected;
}

function upperBoundary(boundaries: number[], target: number, ceiling: number): number {
  for (const boundary of boundaries) {
    if (boundary >= target) return Math.min(boundary, ceiling);
  }
  return ceiling;
}

function makeSlice(input: RouteModelInputSlicesInputV1, candidate: BoundaryCandidate, ordinal: number, coreStart: number): {
  slice: ModelInputSliceV1;
  renderContext: ModelInputSliceRenderContextV1;
} {
  const overlap = input.context_overlap_utf16 ?? 0;
  if (!Number.isSafeInteger(overlap) || overlap < 0) throw new Error("context_overlap_utf16 must be a non-negative safe integer");
  const parentText = input.source.slice(input.parent.span.start, input.parent.span.end);
  const graphemes = graphemeEnds(parentText, input.parent.span.start);
  const contextStart = lowerBoundary(graphemes, Math.max(input.parent.span.start, coreStart - overlap), input.parent.span.start);
  const contextEnd = upperBoundary(graphemes, Math.min(input.parent.span.end, candidate.end + overlap), input.parent.span.end);
  const coreSpan = { start: coreStart, end: candidate.end };
  const contextSpan = { start: contextStart, end: contextEnd };
  const core = input.source.slice(coreSpan.start, coreSpan.end);
  const context = input.source.slice(contextSpan.start, contextSpan.end);
  const slice: ModelInputSliceV1 = {
    version: "model_input_slice.v1",
    source_fingerprint: input.source_fingerprint,
    parent_lid: input.parent.lid,
    ordinal,
    core_span_utf16: coreSpan,
    context_span_utf16: contextSpan,
    boundary_kind: candidate.kind,
    core_sha256: sha256(core),
    context_sha256: sha256(context),
  };
  return {
    slice,
    renderContext: {
      version: "model_input_slice_render_context.v1",
      parent_lid: input.parent.lid,
      ordinal,
      boundary_kind: candidate.kind,
      core_span_utf16: coreSpan,
      context_span_utf16: contextSpan,
      context_before: input.source.slice(contextSpan.start, coreSpan.start),
      core,
      context_after: input.source.slice(coreSpan.end, contextSpan.end),
    },
  };
}

function evaluateCandidate(
  input: RouteModelInputSlicesInputV1,
  candidate: BoundaryCandidate,
  ordinal: number,
  coreStart: number,
): EvaluatedCandidate | undefined {
  const built = makeSlice(input, candidate, ordinal, coreStart);
  const renderedInput = input.render(built.renderContext);
  const evaluated = evaluateModelInputBudget({ ...input.budget, rendered_input: renderedInput });
  if (evaluated.status !== "within_limit") return undefined;
  return { routed: { slice: built.slice, rendered_input: renderedInput, proof: evaluated.proof } };
}

function farthestFitting(
  input: RouteModelInputSlicesInputV1,
  candidates: BoundaryCandidate[],
  ordinal: number,
  coreStart: number,
): EvaluatedCandidate | undefined {
  const remaining = candidates.filter((candidate) => candidate.end > coreStart);
  let low = 0;
  let high = remaining.length - 1;
  let best: EvaluatedCandidate | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const evaluated = evaluateCandidate(input, remaining[middle], ordinal, coreStart);
    if (evaluated) {
      best = evaluated;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function blocked(
  input: RouteModelInputSlicesInputV1,
  wholeEvaluation: ReturnType<typeof evaluateModelInputBudget>,
  reason: ModelInputUnsplittableDraftV1["reason"],
): ModelInputSliceRouteResultV1 {
  const estimated = wholeEvaluation.status === "within_limit"
    ? wholeEvaluation.proof.estimated_rendered_tokens
    : wholeEvaluation.estimated_rendered_tokens;
  const limit = wholeEvaluation.status === "within_limit"
    ? wholeEvaluation.proof.effective_body_limit_tokens
    : wholeEvaluation.effective_body_limit_tokens;
  return {
    status: "blocked",
    recovery: {
      version: "automatic_build_recovery_draft.v1",
      phase: "routing",
      code: "model_input_unsplittable",
      parent_lid: input.parent.lid,
      lid_kind: input.parent.kind,
      reason,
      estimated_tokens: estimated,
      limit_tokens: limit,
      retryable: false,
    },
  };
}

export function validateModelInputSliceCoverage(input: {
  source: string;
  source_fingerprint: string;
  parent: LidNode;
  slices: ModelInputSliceV1[];
}): ModelInputSliceCoverageV1 {
  assertParent(input.source, input.parent, input.source_fingerprint);
  if (!input.slices.length) throw new Error("model input slices must not be empty");
  const ordered = [...input.slices].sort((left, right) => left.ordinal - right.ordinal);
  let cursor = input.parent.span.start;
  let covered = 0;
  let gap = 0;
  let overlap = 0;
  for (let index = 0; index < ordered.length; index++) {
    const slice = ordered[index];
    if (slice.version !== "model_input_slice.v1") throw new Error("model input slice version is invalid");
    if (slice.ordinal !== index) throw new Error("model input slice ordinals must be contiguous from zero");
    if (slice.source_fingerprint !== input.source_fingerprint || slice.parent_lid !== input.parent.lid) {
      throw new Error("model input slice identity does not match the current source or parent");
    }
    const core = slice.core_span_utf16;
    const context = slice.context_span_utf16;
    if (core.start < input.parent.span.start || core.end > input.parent.span.end || core.end <= core.start) {
      throw new Error("model input slice core span is outside the parent LID");
    }
    if (context.start < input.parent.span.start || context.end > input.parent.span.end
      || context.start > core.start || context.end < core.end) {
      throw new Error("model input slice context must contain core inside the parent LID");
    }
    if (core.start > cursor) gap += core.start - cursor;
    if (core.start < cursor) overlap += cursor - core.start;
    cursor = Math.max(cursor, core.end);
    covered += core.end - core.start;
    if (sha256(input.source.slice(core.start, core.end)) !== slice.core_sha256
      || sha256(input.source.slice(context.start, context.end)) !== slice.context_sha256) {
      throw new Error("model input slice digest does not match current canonical source bytes");
    }
  }
  if (cursor < input.parent.span.end) gap += input.parent.span.end - cursor;
  const expected = input.parent.span.end - input.parent.span.start;
  if (ordered[0].core_span_utf16.start !== input.parent.span.start
    || ordered.at(-1)!.core_span_utf16.end !== input.parent.span.end
    || gap !== 0 || overlap !== 0 || covered !== expected) {
    throw new Error(`model input slice coverage is not an exact partition: gap=${gap} overlap=${overlap}`);
  }
  const unsigned = {
    version: "model_input_slice_coverage.v1" as const,
    parent_lid: input.parent.lid,
    parent_span_utf16: { ...input.parent.span },
    slice_count: ordered.length,
    expected_core_utf16: expected,
    covered_core_utf16: covered,
    gap_utf16: gap,
    core_overlap_utf16: overlap,
  };
  return { ...unsigned, coverage_digest: sha256(stableJson({ ...unsigned, slices: ordered })) };
}

export function routeModelInputSlices(input: RouteModelInputSlicesInputV1): ModelInputSliceRouteResultV1 {
  assertParent(input.source, input.parent, input.source_fingerprint);
  const wholeCandidate: BoundaryCandidate = { end: input.parent.span.end, kind: "whole_lid" };
  const wholeBuilt = makeSlice(input, wholeCandidate, 0, input.parent.span.start);
  const wholeRendered = input.render(wholeBuilt.renderContext);
  const wholeEvaluation = evaluateModelInputBudget({ ...input.budget, rendered_input: wholeRendered });
  if (wholeEvaluation.status === "within_limit") {
    const routed = [{ slice: wholeBuilt.slice, rendered_input: wholeRendered, proof: wholeEvaluation.proof }];
    return {
      status: "routed",
      slices: routed,
      coverage: validateModelInputSliceCoverage({
        source: input.source,
        source_fingerprint: input.source_fingerprint,
        parent: input.parent,
        slices: routed.map((item) => item.slice),
      }),
    };
  }
  if (input.parent.kind === "formula" || input.parent.kind === "image") {
    return blocked(input, wholeEvaluation, "atomic_input");
  }
  const tiers = boundaryTiers(input.parent, input.source);
  if (!tiers.length) return blocked(input, wholeEvaluation, "no_safe_boundary");
  const routed: RoutedModelInputSliceV1[] = [];
  let cursor = input.parent.span.start;
  while (cursor < input.parent.span.end) {
    let selected: EvaluatedCandidate | undefined;
    for (const tier of tiers) {
      selected = farthestFitting(input, tier, routed.length, cursor);
      if (selected) break;
    }
    if (!selected) {
      const minimal = makeSlice(input, { end: Math.min(input.parent.span.end, cursor + 1), kind: "grapheme" }, routed.length, cursor);
      const minimalEvaluation = evaluateModelInputBudget({ ...input.budget, rendered_input: input.render(minimal.renderContext) });
      return blocked(
        input,
        minimalEvaluation,
        minimalEvaluation.status === "over_limit" ? "renderer_fixed_overhead" : "no_safe_boundary",
      );
    }
    routed.push(selected.routed);
    cursor = selected.routed.slice.core_span_utf16.end;
  }
  return {
    status: "routed",
    slices: routed,
    coverage: validateModelInputSliceCoverage({
      source: input.source,
      source_fingerprint: input.source_fingerprint,
      parent: input.parent,
      slices: routed.map((item) => item.slice),
    }),
  };
}
