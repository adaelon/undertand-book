import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  alignHybridFoundationV2,
  formHybridAlignmentUnits,
  pdfAlignmentLines,
  projectHybridAlignmentChildren,
} from "../src/hybrid-alignment-v2";
import { extractPdfTextGeometry, type PdfTextGeometry } from "../src/pdf-geometry";

const FIXTURE_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));

function geometryFromPages(pages: string[][]): PdfTextGeometry {
  return {
    pages: pages.map((lines, pageIndex) => {
      let charIndex = 0;
      const height = 240;
      const lineData = lines.map((text, lineIndex) => {
        const start = charIndex;
        const chars = Array.from(text).map((value, offset) => ({
          pageIndex,
          charIndex: charIndex++,
          text: value,
          bbox: [72 + offset * 6, height - 40 - lineIndex * 20, 78 + offset * 6, height - 28 - lineIndex * 20] as [number, number, number, number],
        }));
        return { text, lineIndex, start, end: charIndex, chars };
      });
      return {
        pageIndex,
        width: 600,
        height,
        rotate: 0 as const,
        view: [0, 0, 600, height] as [number, number, number, number],
        words: [],
        chars: lineData.flatMap((line) => line.chars),
        lines: lineData.map((line) => ({
          pageIndex,
          lineIndex: line.lineIndex,
          text: line.text,
          char_start: line.start,
          char_end: line.end,
          bbox: [72, height - 40 - line.lineIndex * 20, 72 + line.text.length * 6, height - 28 - line.lineIndex * 20] as [number, number, number, number],
        })),
      };
    }),
  };
}

function geometryFromPositionedLines(
  lines: Array<{ text: string; bbox: [number, number, number, number] }>,
): PdfTextGeometry {
  let charIndex = 0;
  const lineData = lines.map(({ text, bbox }, lineIndex) => {
    const start = charIndex;
    const values = Array.from(text);
    const charWidth = (bbox[2] - bbox[0]) / Math.max(1, values.length);
    const chars = values.map((value, offset) => ({
      pageIndex: 0,
      charIndex: charIndex++,
      text: value,
      bbox: [
        bbox[0] + offset * charWidth,
        bbox[1],
        bbox[0] + (offset + 1) * charWidth,
        bbox[3],
      ] as [number, number, number, number],
    }));
    return { text, lineIndex, start, end: charIndex, bbox, chars };
  });
  return {
    pages: [{
      pageIndex: 0,
      width: 600,
      height: 240,
      rotate: 0,
      view: [0, 0, 600, 240],
      words: [],
      chars: lineData.flatMap((line) => line.chars),
      lines: lineData.map((line) => ({
        pageIndex: 0,
        lineIndex: line.lineIndex,
        text: line.text,
        char_start: line.start,
        char_end: line.end,
        bbox: line.bbox,
      })),
    }],
  };
}

async function licensedFixture(name: string) {
  const dir = path.join(FIXTURE_ROOT, name);
  const source = readFileSync(path.join(dir, "source.md"), "utf8");
  const geometry = await extractPdfTextGeometry(new Uint8Array(readFileSync(path.join(dir, "paper.pdf"))));
  return { source, geometry };
}

describe("HF2-2 semantic-unit PDF alignment", () => {
  it("projects short inline-formula children independently inside one located unit", async () => {
    const { source, geometry } = await licensedFixture("licensed-inline-formula");
    const result = alignHybridFoundationV2(source, geometry);
    const paragraph = result.units.find((unit) => unit.child_lids.some((child) => child.kind === "formula"))!;
    const projections = result.projections.filter((projection) => paragraph.child_lids.some((child) => child.lid === projection.lid));

    expect(paragraph.child_lids.map((child) => child.kind)).toEqual(["text", "formula", "text"]);
    expect(result.locations.find((location) => location.unit.unit_id === paragraph.unit_id)?.status).toBe("located");
    expect(projections.map((projection) => projection.precision)).toEqual([
      "char_exact",
      "region_exact",
      "char_exact",
    ]);
    expect(projections.map((projection) => projection.primary_region?.bbox)).toEqual([
      [72, 660, 128.32444444444445, 672],
      [133.9568888888889, 660, 150.85422222222223, 672],
      [156.48666666666668, 660, 224.07600000000002, 672],
    ]);
    expect(projections[1].selection_assignments).toEqual([]);
    expect(projections[1]).not.toHaveProperty("formula_display_text");
  });

  it("splits PDF.js merged two-column lines before locating and projecting children", async () => {
    const { source, geometry } = await licensedFixture("licensed-two-column-formula");
    const result = alignHybridFoundationV2(source, geometry);
    const formulaUnits = result.units.filter((unit) => unit.child_lids.some((child) => child.kind === "formula"));
    const formulaProjections = result.projections.filter((projection) => (
      formulaUnits.some((unit) => unit.child_lids.some((child) => child.lid === projection.lid))
    ));

    expect(result.locations.every((location) => location.status === "located")).toBe(true);
    expect(formulaUnits).toHaveLength(2);
    expect(formulaProjections.map((projection) => projection.precision)).toEqual([
      "char_exact", "partial", "char_exact",
      "char_exact", "partial", "char_exact",
    ]);
    expect(new Set(formulaProjections.map((projection) => projection.primary_region?.bbox.join(","))).size).toBe(6);
    expect(formulaProjections.slice(0, 3).every((projection) => projection.primary_region!.bbox[2] < 320)).toBe(true);
    expect(formulaProjections.slice(3).every((projection) => projection.primary_region!.bbox[0] >= 320)).toBe(true);
  });

  it("keeps a standalone display formula isolated until structural formula localization", () => {
    const source = [
      "# Display Formula",
      "",
      "Before alpha beta gamma delta.",
      "",
      "$$ x=y $$",
      "",
      "After epsilon zeta eta theta.",
      "",
    ].join("\n");
    const result = alignHybridFoundationV2(source, geometryFromPages([[
      "Display Formula",
      "Before alpha beta gamma delta.",
      "x=y",
      "After epsilon zeta eta theta.",
    ]]));
    const formulaUnit = result.units.find((unit) => unit.child_lids.some((child) => child.kind === "formula"))!;
    const formula = result.projections.find((projection) => (
      formulaUnit.child_lids.find((child) => child.kind === "formula")!.lid === projection.lid
    ));

    expect(formulaUnit.child_lids.map((child) => child.kind)).toEqual(["formula"]);
    expect(formula).toMatchObject({
      precision: "partial",
      regions: [{ pageIndex: 0 }],
      selection_assignments: [],
      alignment: { reason: "formula text is located but lacks same-page same-column anchors" },
    });
    expect(formula).not.toHaveProperty("formula_display_text");
  });

  it("keeps a cross-page formula partial even when the full unit is located", () => {
    const source = [
      "Before alpha beta gamma delta.",
      "",
      "$$ x=y $$",
      "",
      "After epsilon zeta eta theta.",
      "",
    ].join("\n");
    const result = alignHybridFoundationV2(source, geometryFromPages([
      ["Before alpha beta gamma delta.", "x=y"],
      ["After epsilon zeta eta theta."],
    ]));
    const formulaUnit = result.units.find((unit) => unit.child_lids.some((child) => child.kind === "formula"))!;
    const formulaChild = formulaUnit.child_lids.find((child) => child.kind === "formula")!;
    const formula = result.projections.find((projection) => projection.lid === formulaChild.lid)!;
    const formulaLocation = result.locations.find((location) => location.unit.unit_id === formulaUnit.unit_id)!;

    expect(formulaLocation.status).toBe("located");
    expect(formula.precision).toBe("partial");
    expect(formula.regions).toHaveLength(1);
    expect(formula.selection_assignments).toEqual([]);
    expect(formula).not.toHaveProperty("formula_display_text");
  });

  it("fails closed when a complete unit anchor is repeated", () => {
    const source = "# Title\n\nRepeated anchor alpha beta gamma.\n";
    const units = formHybridAlignmentUnits(source);
    const result = alignHybridFoundationV2(source, geometryFromPages([[
      "Title",
      "Repeated anchor alpha beta gamma.",
      "Repeated anchor alpha beta gamma.",
    ]]));

    expect(units).toHaveLength(2);
    expect(result.locations[1]).toMatchObject({
      status: "unmapped",
      reason: "alignment unit has ambiguous forward candidates",
    });
    expect(result.projections.filter((projection) => projection.lid === units[1].child_lids[0].lid))
      .toMatchObject([{ precision: "unmapped" }]);
  });

  it("does not reuse a candidate behind the monotonic cursor", () => {
    const source = "# First\n\n## Second\n";
    const result = alignHybridFoundationV2(source, geometryFromPages([["Second", "First"]]));

    expect(result.locations[0].status).toBe("located");
    expect(result.locations[1]).toMatchObject({
      status: "unmapped",
      reason: "alignment unit has no exact monotonic candidate",
    });
  });

  it("keeps short headings before wide body lines on a single-column page", () => {
    const source = [
      "# Abstract",
      "",
      "This deliberately wide paragraph follows the short heading in reading order.",
      "",
    ].join("\n");
    const result = alignHybridFoundationV2(source, geometryFromPages([[
      "Abstract",
      "This deliberately wide paragraph follows the short heading in reading order.",
    ]]));

    expect(result.locations.map((location) => location.status)).toEqual(["located", "located"]);
    expect(result.locations[0].token_span!.end).toBeLessThanOrEqual(result.locations[1].token_span!.start);
  });

  it("retains a right continuation beside a spanning segment on the same baseline", () => {
    const left = "The formula is W";
    const middleLeft = "V ReLU";
    const middleRight = "WK x";
    const right = ", where x is the input,";
    const lines = pdfAlignmentLines(geometryFromPositionedLines([
      { text: left, bbox: [70, 200, 347, 212] },
      { text: middleLeft, bbox: [339, 194, 375, 207] },
      { text: middleRight, bbox: [381, 195, 407, 207] },
      { text: right, bbox: [413, 200, 542, 212] },
      { text: "left lower one", bbox: [70, 170, 180, 182] },
      { text: "right lower one", bbox: [410, 170, 520, 182] },
      { text: "left lower two", bbox: [70, 150, 180, 162] },
      { text: "right lower two", bbox: [410, 150, 520, 162] },
    ]));
    const orderedText = lines.map((line) => line.text);

    expect(orderedText).toContain(right);
    expect(orderedText.indexOf(left)).toBeLessThan(orderedText.indexOf(middleLeft));
    expect(orderedText.indexOf(middleLeft)).toBeLessThan(orderedText.indexOf(middleRight));
    expect(orderedText.indexOf(middleRight)).toBeLessThan(orderedText.indexOf(right));
  });

  it("projects shared semantic hyphens instead of dropping their source assignments", () => {
    const sentence = "The feed-forward short-term key-value and long-term memories differ.";
    const source = `${sentence}\n`;
    const result = alignHybridFoundationV2(source, geometryFromPages([[sentence]]));
    const projection = result.projections[0];
    const hyphenOffsets = Array.from(source.matchAll(/-/gu), (match) => match.index);

    expect(projection.precision).toBe("char_exact");
    expect(hyphenOffsets).toHaveLength(4);
    for (const offset of hyphenOffsets) {
      expect(projection.selection_assignments).toContainEqual(expect.objectContaining({
        text: "-",
        source_span: { start: offset, end: offset + 1 },
      }));
    }
  });

  it("covers source word separators at proven same-column PDF line breaks", () => {
    const source = "Alpha beta gamma delta.\n";
    const result = alignHybridFoundationV2(source, geometryFromPages([[
      "Alpha beta",
      "gamma delta.",
    ]]));
    const projection = result.projections[0];
    const lineBreakSpace = source.indexOf(" gamma");

    expect(projection.precision).toBe("char_exact");
    expect(projection.exact_source_spans).toEqual([{ start: 0, end: source.trim().length }]);
    expect(projection.selection_assignments).toContainEqual(expect.objectContaining({
      text: "a",
      source_span: { start: lineBreakSpace - 1, end: lineBreakSpace + 1 },
    }));
  });

  it("uses aligned line starts when a short continuation has a coarse column label", () => {
    const source = "Alpha beta gamma delta.\n";
    const geometry = geometryFromPages([[
      "Alpha beta",
      "gamma delta.",
    ]]);
    const unit = formHybridAlignmentUnits(source)[0];
    const lines = pdfAlignmentLines(geometry);
    lines[1] = { ...lines[1], column: lines[0].column === 0 ? 1 : 0 };
    const projection = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven located lines",
      lines,
    })[0];

    expect(projection.precision).toBe("char_exact");
  });

  it("does not cover a missing source separator without a proven line break", () => {
    const source = "Alpha beta gamma delta.\n";
    const sameLine = alignHybridFoundationV2(source, geometryFromPages([[
      "Alpha betagamma delta.",
    ]]));
    const crossPage = alignHybridFoundationV2(source, geometryFromPages([
      ["Alpha beta"],
      ["gamma delta."],
    ]));
    const unit = formHybridAlignmentUnits(source)[0];
    const lines = pdfAlignmentLines(geometryFromPages([[
      "Alpha beta",
      "gamma delta.",
    ]]));
    lines[1] = {
      ...lines[1],
      column: lines[0].column === 0 ? 1 : 0,
      chars: lines[1].chars.map((char) => ({
        ...char,
        bbox: [char.bbox[0] + 250, char.bbox[1], char.bbox[2] + 250, char.bbox[3]],
      })),
    };
    const crossColumn = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven located lines",
      lines,
    })[0];

    expect(sameLine.projections[0].precision).not.toBe("char_exact");
    expect(crossPage.projections[0].precision).not.toBe("char_exact");
    expect(crossColumn.precision).toBe("partial");
  });

  it("maps supported semantic hyphen representations onto the source hyphen", () => {
    const source = "A key-value pair.\n";
    const sourceOffset = source.indexOf("-");
    for (const pdfHyphen of ["-", "\u00ad", "\u2010", "\u2011"]) {
      const result = alignHybridFoundationV2(
        source,
        geometryFromPages([[`A key${pdfHyphen}value pair.`]]),
      );
      expect(result.projections[0].precision, pdfHyphen.codePointAt(0)?.toString(16)).toBe("char_exact");
      expect(result.projections[0].selection_assignments).toContainEqual(expect.objectContaining({
        text: pdfHyphen,
        source_span: { start: sourceOffset, end: sourceOffset + 1 },
      }));
    }
  });

  it("ignores only a proven PDF line-end discretionary hyphen", () => {
    const source = "A hyphenated method remains reliable.\n";
    const geometry = geometryFromPages([[
      "A hyphen-",
      "ated method remains reliable.",
    ]]);
    const unit = formHybridAlignmentUnits(source)[0];
    const projection = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven located lines",
      lines: pdfAlignmentLines(geometry),
    })[0];

    expect(projection.precision).toBe("char_exact");
    expect(projection.selection_assignments.some((assignment) => assignment.text === "-")).toBe(false);
    expect(projection.exact_source_spans).toEqual([{ start: 0, end: source.trim().length }]);
  });

  it("keeps internal PDF hyphens and dash or minus changes fail-closed", () => {
    const fixtures = [
      "A hyphen-ated method remains reliable.",
      "A hyphen–ated method remains reliable.",
      "A hyphen—ated method remains reliable.",
      "A hyphen−ated method remains reliable.",
    ];
    for (const pdfText of fixtures) {
      const source = "A hyphenated method remains reliable.\n";
      const result = alignHybridFoundationV2(source, geometryFromPages([[pdfText]]));
      expect(result.projections[0].precision, pdfText).toBe("partial");
    }
  });

  it("preserves matching en dash, em dash, and mathematical minus characters", () => {
    const sentence = "alpha–beta—gamma − delta";
    const source = `${sentence}\n`;
    const result = alignHybridFoundationV2(source, geometryFromPages([[sentence]]));
    const projection = result.projections[0];

    expect(projection.precision).toBe("char_exact");
    for (const symbol of ["–", "—", "−"]) {
      const offset = source.indexOf(symbol);
      expect(projection.selection_assignments).toContainEqual(expect.objectContaining({
        text: symbol,
        source_span: { start: offset, end: offset + 1 },
      }));
    }
  });
});
