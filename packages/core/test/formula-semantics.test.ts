import { describe, expect, it } from "vitest";
import { FormulaSemanticsZ } from "../src/zod";
import { formatFormulaSemanticsForPrompt, gateFormulaSemanticsCandidate } from "../src/formula-semantics";
import type { FormulaSemanticsCandidate } from "../src/formula-semantics";
import type { LidNode } from "../src/generated/LidNode";

const nodes: LidNode[] = [
  { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 50 }, children: ["1.1", "1.2", "1.3"] },
  { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 0, end: 10 }, children: [] },
  { lid: "1.2", path: [1, 2], kind: "formula", span: { start: 11, end: 20 }, children: [] },
  { lid: "1.3", path: [1, 3], kind: "paragraph", span: { start: 21, end: 50 }, children: [] },
  { lid: "2.1", path: [2, 1], kind: "paragraph", span: { start: 51, end: 80 }, children: [] },
];

function validCandidate(): FormulaSemanticsCandidate {
  return {
    formula_lid: "1.2",
    parameters: [
      {
        symbol: "E",
        label: "energy",
        meaning: "total energy expressed by the formula",
        unit: "joule",
        domain: null,
        evidence_lids: ["1.2", "1.3"],
      },
      {
        symbol: "m",
        label: "mass",
        meaning: "object mass from the surrounding explanation",
        unit: "kg",
        domain: null,
        evidence_lids: ["1.3"],
      },
    ],
    composition: {
      source_lid: "1.2",
      meaning: "Energy is mass scaled by the square of light speed.",
      terms: ["E", "m", "c^2"],
      evidence_lids: ["1.2"],
    },
    context_links: [
      {
        target_lid: "1.3",
        relation: "explained_by",
        description: "The following paragraph defines the symbols in the formula.",
        evidence_lids: ["1.3"],
      },
    ],
  };
}

describe("SA5 FormulaSemantics evidence gate", () => {
  it("accepts a fully evidenced candidate and formats agent context", () => {
    const result = gateFormulaSemanticsCandidate(validCandidate(), nodes, { contextLids: ["1.1", "1.3"] });
    expect(result.pending).toEqual([]);
    expect(result.semantics).not.toBeNull();
    FormulaSemanticsZ.parse(result.semantics);

    const prompt = formatFormulaSemanticsForPrompt(result.semantics!);
    expect(prompt).toContain("Formula 1.2");
    expect(prompt).toContain("Composition: Energy is mass scaled by the square of light speed.");
    expect(prompt).toContain("- E (energy): total energy expressed by the formula unit=joule [1.2, 1.3]");
    expect(prompt).toContain("- explained_by 1.3: The following paragraph defines the symbols in the formula. [1.3]");
  });

  it("drops dangling, out-of-context, and unevidenced explanations into pending", () => {
    const candidate = validCandidate();
    candidate.parameters = [
      ...candidate.parameters!,
      { symbol: "x", label: null, meaning: "invented symbol", unit: null, domain: null, evidence_lids: ["9.9"] },
      { symbol: "y", label: null, meaning: "outside context", unit: null, domain: null, evidence_lids: ["2.1"] },
      { symbol: "z", label: null, meaning: "no evidence", unit: null, domain: null, evidence_lids: [] },
    ];
    candidate.context_links = [
      ...candidate.context_links!,
      { target_lid: "9.9", relation: "claims", description: "missing target", evidence_lids: ["1.2"] },
      { target_lid: "2.1", relation: "claims", description: "outside context", evidence_lids: ["2.1"] },
    ];

    const result = gateFormulaSemanticsCandidate(candidate, nodes, { contextLids: ["1.1", "1.3"] });
    expect(result.semantics?.parameters.map((p) => p.symbol)).toEqual(["E", "m"]);
    expect(result.semantics?.context_links).toHaveLength(1);
    expect(result.pending.map((p) => p.reason)).toEqual([
      "dangling evidence_lids: 9.9",
      "evidence_lids outside formula context: 2.1",
      "missing evidence_lids",
      "target_lid does not exist: 9.9",
      "target_lid outside formula context: 2.1",
    ]);
  });

  it("refuses to emit read-only semantics when composition is not anchored to the formula", () => {
    const candidate = validCandidate();
    candidate.composition = { ...candidate.composition!, source_lid: "1.3" };
    const result = gateFormulaSemanticsCandidate(candidate, nodes, { contextLids: ["1.1", "1.3"] });
    expect(result.semantics).toBeNull();
    expect(result.pending).toContainEqual({
      kind: "composition",
      index: 0,
      reason: "composition source_lid must equal formula_lid",
      item: candidate.composition,
    });
  });

  it("refuses candidates whose formula_lid is not a formula node", () => {
    const candidate = { ...validCandidate(), formula_lid: "1.1" };
    const result = gateFormulaSemanticsCandidate(candidate, nodes, { contextLids: ["1.3"] });
    expect(result.semantics).toBeNull();
    expect(result.pending[0].reason).toBe("formula_lid is not a formula node: 1.1");
  });
});
