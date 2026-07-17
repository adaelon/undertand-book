import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  alignHybridFoundationV2,
  formHybridAlignmentUnits,
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
      "char_exact", "region_exact", "char_exact",
      "char_exact", "region_exact", "char_exact",
    ]);
    expect(new Set(formulaProjections.map((projection) => projection.primary_region?.bbox.join(","))).size).toBe(6);
    expect(formulaProjections.slice(0, 3).every((projection) => projection.primary_region!.bbox[2] < 320)).toBe(true);
    expect(formulaProjections.slice(3).every((projection) => projection.primary_region!.bbox[0] >= 320)).toBe(true);
  });

  it("forms one display-formula context and emits a bounded region_exact formula", () => {
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

    expect(formulaUnit.child_lids.map((child) => child.kind)).toEqual(["text", "formula", "text"]);
    expect(formula).toMatchObject({ precision: "region_exact", regions: [{ pageIndex: 0 }] });
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
    const formulaChild = result.units[0].child_lids.find((child) => child.kind === "formula")!;
    const formula = result.projections.find((projection) => projection.lid === formulaChild.lid)!;

    expect(result.locations[0].status).toBe("located");
    expect(formula.precision).toBe("partial");
    expect(formula.regions).toHaveLength(1);
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
});
