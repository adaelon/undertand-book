import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFormulaSourceAst } from "../src/formula-source-ast";
import { runFormulaSourceAstAuditCli } from "../scripts/run-formula-source-ast-audit";

const FIXTURE_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));
const REAL_FORMULA_SOURCE_AUDIT = path.join(
  FIXTURE_ROOT,
  "external-formula-dense-transformer-formula-source-ast-audit.json",
);

describe("PR14 positioned formula source AST", () => {
  it("requires explicit source, descriptor, and migration inputs for formula AST audit", async () => {
    await expect(runFormulaSourceAstAuditCli([])).rejects.toThrow(/--source requires an explicit path/u);
  });

  it("freezes all migrated A001 source AST classifications without source text", () => {
    const reportText = readFileSync(REAL_FORMULA_SOURCE_AUDIT, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("2047b264274733183ec22a52c661d2f7697bbae040035e9e69d8295b1b62b5cf");
    expect(report).toMatchObject({
      version: "formula_source_ast_audit.v1",
      policy_version: "formula_source_ast.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      summary: {
        baseline_count: 47,
        replayed_count: 47,
        projectable_count: 46,
        missing_successor_count: 0,
        invalid_count: 0,
        unclassified_count: 0,
        classification_counts: {
          reviewed_formula_to_paragraph: 1,
          transparent_wrapper_projectable: 46,
        },
      },
    });
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });

  it("projects nested transparent wrappers with exact source spans", () => {
    const source = "Before $ \\underline{\\text{can \\textit{we} proceed?}} $ after";
    const start = source.indexOf("$");
    const end = source.lastIndexOf("$") + 1;
    const parsed = parseFormulaSourceAst(source, { start, end });

    expect(parsed).toMatchObject({
      version: "formula_source_ast.v1",
      status: "parsed",
      delimiter: "inline",
      projectable: true,
    });
    expect(parsed.nodes).toMatchObject([{
      kind: "command",
      command: "underline",
      category: "transparent_wrapper",
      children: [{
        kind: "command",
        command: "text",
        category: "transparent_wrapper",
      }],
    }]);
    expect(parsed.visible_tokens.map((token) => token.value).join(""))
      .toBe("can we proceed?");
    for (const token of parsed.visible_tokens) {
      expect(source.slice(token.source_span.start, token.source_span.end)).toBe(token.value);
    }
  });

  it("keeps multiline transparent content in source order", () => {
    const source = "$$\\underline{\\textbf{first line\nsecond line}}$$";
    const parsed = parseFormulaSourceAst(source, { start: 0, end: source.length });

    expect(parsed).toMatchObject({ status: "parsed", delimiter: "display", projectable: true });
    expect(parsed.visible_tokens.map((token) => token.value).join(""))
      .toBe("first line second line");
    expect(parsed.visible_tokens.map((token) => token.source_span.start))
      .toEqual([...parsed.visible_tokens.map((token) => token.source_span.start)].sort((a, b) => a - b));
  });

  it("retains glyph transforms as non-projectable structural nodes", () => {
    const source = "$ \\frac{x}{y} + \\sqrt{z} $";
    const parsed = parseFormulaSourceAst(source, { start: 0, end: source.length });

    expect(parsed).toMatchObject({ status: "parsed", projectable: false });
    expect(parsed.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "command", command: "frac", category: "glyph_transform" }),
      expect.objectContaining({ kind: "command", command: "sqrt", category: "glyph_transform" }),
    ]));
  });

  it("keeps existing simple style wrappers and scripts projectable", () => {
    const source = "$ \\boldsymbol{k}_i + \\mathrm{W} $";
    const parsed = parseFormulaSourceAst(source, { start: 0, end: source.length });
    const nested = parsed.nodes.flatMap((node) => [node, ...(node.children ?? [])]);

    expect(parsed).toMatchObject({ status: "parsed", projectable: true });
    expect(parsed.visible_tokens.map((token) => token.value).join("")).toBe("ki+W");
    expect(nested).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "command", command: "boldsymbol", category: "transparent_wrapper" }),
      expect.objectContaining({ kind: "script", relation: "subscript", category: "structural_relation" }),
      expect.objectContaining({ kind: "command", command: "mathrm", category: "transparent_wrapper" }),
    ]));
  });

  it("fails closed for unknown commands, nested delimiters, and unclosed groups", () => {
    const fixtures = [
      "$ \\mystery{x} $",
      "$ outer $ inner $ outer $",
      "$ \\underline{\\text{broken} $",
    ];

    for (const source of fixtures) {
      const parsed = parseFormulaSourceAst(source, { start: 0, end: source.length });
      expect(parsed.projectable, source).toBe(false);
      expect(parsed.status, source).not.toBe("parsed");
      expect(parsed.reason, source).toBeTruthy();
    }
  });
});
