import { describe, expect, it } from "vitest";
import {
  buildFormulaGlyphPlan,
  findFormulaGlyphMatches,
  PDF_FORMULA_GLYPH_POLICY,
  type FormulaGlyphCandidate,
} from "../src/formula-glyph-projection";

function candidate(
  key: string,
  charIndex: number,
  bbox: [number, number, number, number],
): FormulaGlyphCandidate {
  return { key, pageIndex: 0, charIndex, bbox };
}

describe("PR16 formula glyph projection policy", () => {
  it("fails closed for an unknown command", () => {
    const source = "$ \\mystery{x} $";
    const plan = buildFormulaGlyphPlan(source, { start: 0, end: source.length });

    expect(plan).toMatchObject({
      version: PDF_FORMULA_GLYPH_POLICY.version,
      status: "unsupported",
      variants: [],
    });
    expect(findFormulaGlyphMatches(plan, [])).toEqual({
      matches: [],
      key_candidate_count: 0,
      geometry_rejection_count: 0,
    });
  });

  it("keeps visible delimiters and command glyph source spans", () => {
    const source = "$ f(x) + \\alpha $";
    const plan = buildFormulaGlyphPlan(source, { start: 0, end: source.length });

    expect(plan.status).toBe("supported");
    const tokens = plan.variants[0].tokens;
    expect(tokens.map((token) => token.alternatives[0])).toEqual([
      "f", "(", "x", ")", "+", "\u03b1",
    ]);
    const alpha = tokens.at(-1)!;
    expect(source.slice(alpha.source_span.start, alpha.source_span.end)).toBe("\\alpha");
  });

  it("requires large-operator limits to occupy their AST lanes", () => {
    const source = "$ \\sum_{i=1}^n x_i $";
    const plan = buildFormulaGlyphPlan(source, { start: 0, end: source.length });
    expect(plan).toMatchObject({ status: "supported", requires_geometry: true });
    const keys = plan.variants[0].tokens.map((token) => token.alternatives[0]);
    expect(keys).toHaveLength(7);

    const positioned = [
      candidate(keys[0], 0, [0, 116, 10, 128]),
      candidate(keys[1], 1, [11, 98, 17, 108]),
      candidate(keys[2], 2, [18, 98, 24, 108]),
      candidate(keys[3], 3, [25, 98, 31, 108]),
      candidate(keys[4], 4, [11, 136, 17, 146]),
      candidate(keys[5], 5, [34, 116, 42, 128]),
      candidate(keys[6], 6, [43, 100, 49, 110]),
    ];
    expect(findFormulaGlyphMatches(plan, positioned).matches).toHaveLength(1);

    const flat: FormulaGlyphCandidate[] = positioned.map((item) => ({
      ...item,
      bbox: [item.bbox[0], 116, item.bbox[2], 128],
    }));
    const rejected = findFormulaGlyphMatches(plan, flat);
    expect(rejected.matches).toEqual([]);
    expect(rejected.key_candidate_count).toBe(1);
    expect(rejected.geometry_rejection_count).toBe(1);
  });

  it("requires a selectable accent glyph to sit above its content", () => {
    const source = "$ \\hat{x} $";
    const plan = buildFormulaGlyphPlan(source, { start: 0, end: source.length });
    const glyphVariant = plan.variants.find((variant) => variant.tokens.length === 2)!;
    const [accentKey, contentKey] = glyphVariant.tokens.map((token) => token.alternatives[0]);

    expect(findFormulaGlyphMatches(plan, [
      candidate(accentKey, 0, [4, 136, 10, 142]),
      candidate(contentKey, 1, [2, 116, 12, 128]),
    ]).matches).toHaveLength(1);
    const rejected = findFormulaGlyphMatches(plan, [
      candidate(accentKey, 0, [4, 116, 10, 128]),
      candidate(contentKey, 1, [2, 116, 12, 128]),
    ]);
    expect(rejected.matches).toEqual([]);
    expect(rejected.geometry_rejection_count).toBeGreaterThan(0);

    expect(findFormulaGlyphMatches(plan, [
      candidate(contentKey, 0, [2, 116, 12, 128]),
    ]).matches).toHaveLength(1);
  });
});
