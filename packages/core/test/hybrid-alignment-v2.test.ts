import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHybridChildWindowAuditCli } from "../scripts/run-hybrid-child-window-audit";
import { runHybridDisplayTokenAuditCli } from "../scripts/run-hybrid-display-token-audit";
import {
  alignHybridFoundationV2,
  formHybridAlignmentUnits,
  pdfAlignmentLines,
  projectHybridAlignmentChildren,
} from "../src/hybrid-alignment-v2";
import { extractPdfTextGeometry, type PdfTextGeometry } from "../src/pdf-geometry";

const FIXTURE_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));
const REAL_CHILD_WINDOW_AUDIT = path.join(
  FIXTURE_ROOT,
  "external-formula-dense-transformer-child-window-audit.json",
);
const REAL_DISPLAY_TOKEN_AUDIT = path.join(
  FIXTURE_ROOT,
  "external-formula-dense-transformer-display-token-audit.json",
);

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

function geometryFromPositionedChars(
  chars: Array<{ text: string; bbox: [number, number, number, number] }>,
): PdfTextGeometry {
  const geometryChars = chars.map((char, charIndex) => ({
    pageIndex: 0,
    charIndex,
    text: char.text,
    bbox: char.bbox,
  }));
  const bbox = geometryChars.reduce<[number, number, number, number]>((union, char) => ([
    Math.min(union[0], char.bbox[0]),
    Math.min(union[1], char.bbox[1]),
    Math.max(union[2], char.bbox[2]),
    Math.max(union[3], char.bbox[3]),
  ]), [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0, 0]);
  return {
    pages: [{
      pageIndex: 0,
      width: 600,
      height: 240,
      rotate: 0,
      view: [0, 0, 600, 240],
      words: [],
      chars: geometryChars,
      lines: [{
        pageIndex: 0,
        lineIndex: 0,
        text: geometryChars.map((char) => char.text).join(""),
        char_start: 0,
        char_end: geometryChars.length,
        bbox,
      }],
    }],
  };
}

function geometryWithObjects(
  lines: Array<{ text: string; bbox: [number, number, number, number] }>,
  objects: NonNullable<PdfTextGeometry["pages"][number]["objects"]>,
): PdfTextGeometry {
  const geometry = geometryFromPositionedLines(lines);
  geometry.pages[0].objects = objects;
  return geometry;
}

async function licensedFixture(name: string) {
  const dir = path.join(FIXTURE_ROOT, name);
  const source = readFileSync(path.join(dir, "source.md"), "utf8");
  const geometry = await extractPdfTextGeometry(new Uint8Array(readFileSync(path.join(dir, "paper.pdf"))));
  return { source, geometry };
}

describe("HF2-2 semantic-unit PDF alignment", () => {
  it("projects a uniquely bounded image XObject without selection assignments", () => {
    const source = "Before anchor.\n\n![diagram](diagram.png)\n\nFigure caption.\n\nAfter anchor.\n";
    const result = alignHybridFoundationV2(source, geometryWithObjects([
      { text: "Before anchor.", bbox: [70, 210, 180, 222] },
      { text: "Figure caption.", bbox: [90, 70, 190, 82] },
      { text: "After anchor.", bbox: [70, 40, 170, 52] },
    ], [{ pageIndex: 0, objectIndex: 0, kind: "image_xobject", bbox: [80, 95, 220, 190] }]));
    const image = result.projections.find((projection) => (
      result.units.some((unit) => unit.child_lids.some((child) => child.kind === "image" && child.lid === projection.lid))
    ))!;

    expect(image).toMatchObject({
      precision: "region_exact",
      regions: [{ pageIndex: 0, bbox: [80, 95, 220, 190] }],
      exact_source_spans: [],
      selection_assignments: [],
      alignment: { reason: expect.stringMatching(/^asset_region_exact:/u) },
    });
  });

  it("projects a uniquely bounded vector-only figure Form XObject", () => {
    const source = "Before anchor.\n\n![diagram](diagram.svg)\n\nFigure caption.\n";
    const result = alignHybridFoundationV2(source, geometryWithObjects([
      { text: "Before anchor.", bbox: [70, 210, 180, 222] },
      { text: "Figure caption.", bbox: [90, 70, 190, 82] },
    ], [{ pageIndex: 0, objectIndex: 0, kind: "form_xobject", bbox: [80, 95, 220, 190] }]));
    const imageLid = result.units.flatMap((unit) => unit.child_lids).find((child) => child.kind === "image")!.lid;

    expect(result.projections.find((projection) => projection.lid === imageLid)).toMatchObject({
      precision: "region_exact",
      alignment: { reason: expect.stringMatching(/^asset_region_exact:/u) },
    });
  });

  it("binds a same-row image group by source order despite small bbox jitter", () => {
    const source = [
      "Before anchor.",
      "",
      "![first](first.png)",
      "",
      "![second](second.png)",
      "",
      "![third](third.png)",
      "",
      "After anchor.",
      "",
    ].join("\n");
    const result = alignHybridFoundationV2(source, geometryWithObjects([
      { text: "Before anchor.", bbox: [70, 210, 180, 222] },
      { text: "After anchor.", bbox: [70, 40, 170, 52] },
    ], [
      { pageIndex: 0, objectIndex: 0, kind: "image_xobject", bbox: [230, 100, 300, 160] },
      { pageIndex: 0, objectIndex: 1, kind: "image_xobject", bbox: [80, 99, 150, 159] },
      { pageIndex: 0, objectIndex: 2, kind: "image_xobject", bbox: [155, 101, 225, 161] },
    ]));
    const imageLids = result.units.flatMap((unit) => unit.child_lids)
      .filter((child) => child.kind === "image")
      .map((child) => child.lid);

    expect(imageLids.map((lid) => result.projections.find((projection) => projection.lid === lid)!))
      .toMatchObject([
        { precision: "region_exact", primary_region: { bbox: [80, 99, 150, 159] } },
        { precision: "region_exact", primary_region: { bbox: [155, 101, 225, 161] } },
        { precision: "region_exact", primary_region: { bbox: [230, 100, 300, 160] } },
      ]);
  });

  it("fills one unique asset-order gap between proven neighboring image bindings", () => {
    const source = [
      "Before anchor.",
      "",
      "![first](first.png)",
      "",
      "First caption.",
      "",
      "![second](second.png)",
      "",
      "Caption absent from PDF.",
      "",
      "![third](third.png)",
      "",
      "Third caption.",
      "",
      "After anchor.",
      "",
    ].join("\n");
    const result = alignHybridFoundationV2(source, geometryWithObjects([
      { text: "Before anchor.", bbox: [70, 210, 180, 222] },
      { text: "First caption.", bbox: [85, 70, 145, 82] },
      { text: "Third caption.", bbox: [245, 70, 305, 82] },
      { text: "After anchor.", bbox: [70, 40, 170, 52] },
    ], [
      { pageIndex: 0, objectIndex: 0, kind: "image_xobject", bbox: [80, 100, 150, 160] },
      { pageIndex: 0, objectIndex: 1, kind: "image_xobject", bbox: [155, 100, 225, 160] },
      { pageIndex: 0, objectIndex: 2, kind: "image_xobject", bbox: [230, 100, 300, 160] },
    ]));
    const imageLids = result.units.flatMap((unit) => unit.child_lids)
      .filter((child) => child.kind === "image")
      .map((child) => child.lid);

    expect(imageLids.map((lid) => result.projections.find((projection) => projection.lid === lid)!))
      .toMatchObject([
        { precision: "region_exact", primary_region: { bbox: [80, 100, 150, 160] } },
        { precision: "region_exact", primary_region: { bbox: [155, 100, 225, 160] } },
        { precision: "region_exact", primary_region: { bbox: [230, 100, 300, 160] } },
      ]);
  });

  it("keeps surrounding text selection identical when image leaves are inserted", () => {
    const withoutImage = alignHybridFoundationV2(
      "Before anchor.\n\nAfter anchor.\n",
      geometryFromPositionedLines([
        { text: "Before anchor.", bbox: [70, 210, 180, 222] },
        { text: "After anchor.", bbox: [70, 40, 170, 52] },
      ]),
    );
    const withImage = alignHybridFoundationV2(
      "Before anchor.\n\n![diagram](diagram.png)\n\nAfter anchor.\n",
      geometryWithObjects([
        { text: "Before anchor.", bbox: [70, 210, 180, 222] },
        { text: "After anchor.", bbox: [70, 40, 170, 52] },
      ], [{ pageIndex: 0, objectIndex: 0, kind: "image_xobject", bbox: [80, 95, 220, 190] }]),
    );
    const textEvidence = (result: typeof withImage) => result.projections
      .filter((projection) => projection.selection_assignments.length > 0)
      .map((projection) => ({
        precision: projection.precision,
        pdf_chars: projection.selection_assignments.map((assignment) => (
          `${assignment.pageIndex}:${assignment.char_index}:${assignment.text}`
        )),
      }));

    expect(textEvidence(withImage)).toEqual(textEvidence(withoutImage));
  });

  it("fails closed when repeated image objects fit the same caption anchor", () => {
    const source = "Before anchor.\n\n![icon](icon.png)\n\nFigure caption.\n";
    const result = alignHybridFoundationV2(source, geometryWithObjects([
      { text: "Before anchor.", bbox: [70, 210, 180, 222] },
      { text: "Figure caption.", bbox: [90, 70, 190, 82] },
    ], [
      { pageIndex: 0, objectIndex: 0, kind: "image_xobject", bbox: [80, 95, 150, 150] },
      { pageIndex: 0, objectIndex: 1, kind: "image_xobject", bbox: [120, 95, 200, 150] },
    ]));
    const imageLid = result.units.flatMap((unit) => unit.child_lids).find((child) => child.kind === "image")!.lid;

    expect(result.projections.find((projection) => projection.lid === imageLid)).toMatchObject({
      precision: "unmapped",
      regions: [],
      alignment: { reason: expect.stringMatching(/^asset_unmapped:/u) },
    });
  });

  it.each([
    ["caption-only", []],
    ["cross-page object", [{ pageIndex: 0, objectIndex: 0, kind: "image_xobject" as const, bbox: [80, 20, 220, 90] as [number, number, number, number] }]],
  ])("fails closed for %s image evidence", (_case, objects) => {
    const source = "Before anchor.\n\n![missing](missing.png)\n\nFigure caption.\n";
    const geometry = geometryFromPages([["Before anchor."], ["Figure caption."]]);
    geometry.pages[0].objects = objects;
    const result = alignHybridFoundationV2(source, geometry);
    const imageLid = result.units.flatMap((unit) => unit.child_lids).find((child) => child.kind === "image")!.lid;

    expect(result.projections.find((projection) => projection.lid === imageLid)).toMatchObject({
      precision: "unmapped",
      alignment: { reason: expect.stringMatching(/^asset_unmapped:/u) },
    });
  });

  it("requires explicit source, PDF, descriptor, and migration inputs for child-window audit", async () => {
    await expect(runHybridChildWindowAuditCli([])).rejects.toThrow("--source requires an explicit path");
  });

  it("requires explicit source, PDF, descriptor, and migration inputs for display-token audit", async () => {
    await expect(runHybridDisplayTokenAuditCli([])).rejects.toThrow("--source requires an explicit path");
  });

  it("freezes the migrated A004/A005 child-window replay without source text", () => {
    const reportText = readFileSync(REAL_CHILD_WINDOW_AUDIT, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("bfdba059f610077ca360bcd25881eb5dda6a6277525a2a472a14d51b64b4d60a");
    expect(report).toMatchObject({
      version: "hybrid_child_window_audit.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      summary: {
        unit_count: 625,
        projection_count: 1945,
        wrong_window_assignment_count: 0,
        legacy_shared_cursor_reason_count: 0,
      },
      issues: {
        "PDF-A004": { baseline_count: 54, replayed_count: 51, removed_count: 3, missing_successor_count: 0 },
        "PDF-A005": { baseline_count: 129, replayed_count: 129, removed_count: 0, missing_successor_count: 0 },
      },
    });
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });

  it("freezes the migrated A002/A003 display-token classification without source text", () => {
    const reportText = readFileSync(REAL_DISPLAY_TOKEN_AUDIT, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("fe35ffe871b20f3e9493f043f9655dea758a3a7e8ad34ec620d924e2f95b73f6");
    expect(report).toMatchObject({
      version: "hybrid_display_token_audit.v1",
      policy_version: "pdf_display_token_policy.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      summary: { unit_count: 625, projection_count: 1945, unclassified_count: 0 },
      categories: {
        markdown_roles: {
          baseline_count: 8,
          replayed_count: 6,
          removed_count: 2,
          missing_successor_count: 0,
          classification_counts: { accepted_parser_role_display: 6, reviewed_source_removed: 2 },
        },
        punctuation_symbols: {
          baseline_count: 28,
          replayed_count: 20,
          removed_count: 8,
          missing_successor_count: 0,
          classification_counts: {
            accepted_glyph_representation: 11,
            material_punctuation_difference: 9,
            reviewed_source_removed: 8,
          },
        },
        layout_whitespace: {
          baseline_count: 23,
          replayed_count: 17,
          removed_count: 6,
          missing_successor_count: 0,
          classification_counts: { accepted_layout_whitespace_policy: 17, reviewed_source_removed: 6 },
        },
      },
    });
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });
  it("keeps a literal flat underscore formula fail-closed without affecting adjacent text", async () => {
    const { source, geometry } = await licensedFixture("licensed-inline-formula");
    const result = alignHybridFoundationV2(source, geometry);
    const paragraph = result.units.find((unit) => unit.child_lids.some((child) => child.kind === "formula"))!;
    const projections = result.projections.filter((projection) => paragraph.child_lids.some((child) => child.lid === projection.lid));

    expect(paragraph.child_lids.map((child) => child.kind)).toEqual(["text", "formula", "text"]);
    expect(result.locations.find((location) => location.unit.unit_id === paragraph.unit_id)?.status).toBe("located");
    expect(projections.map((projection) => projection.precision)).toEqual([
      "char_exact",
      "unmapped",
      "char_exact",
    ]);
    expect(projections.map((projection) => projection.primary_region?.bbox)).toEqual([
      [72, 660, 128.32444444444445, 672],
      undefined,
      [156.48666666666668, 660, 224.07600000000002, 672],
    ]);
    expect(projections[1].selection_assignments).toEqual([]);
    expect(projections[1]).not.toHaveProperty("formula_display_text");
  });

  it("projects transparent underline source tokens without deleting formula markup", () => {
    const source = "Before words $ \\underline{\\text{visible phrase}} $ after words.\n";
    const result = alignHybridFoundationV2(source, geometryFromPages([["Before words visible phrase after words."]]));
    const formulaLid = result.units
      .flatMap((unit) => unit.child_lids)
      .find((child) => child.kind === "formula")!.lid;
    const formula = result.projections.find((projection) => projection.lid === formulaLid)!;

    expect(formula).toMatchObject({
      precision: "partial",
      formula_display_text: "visible phrase",
      alignment: { reason: "complete simple formula display projection with source-markup gaps" },
    });
    expect(formula.exact_source_spans.length).toBeGreaterThan(0);
    expect(formula.exact_source_spans.every((span) => (
      span.start >= source.indexOf("visible") && span.end <= source.indexOf("phrase") + "phrase".length
    ))).toBe(true);
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

  it("locates a standalone display formula as a unique page-column region", () => {
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
      alignment: { reason: "complete formula glyph projection in unique formula region" },
    });
    expect(formula?.selection_assignments).toHaveLength(3);
  });

  it.each([
    ["left", "alpha anchor $x=y$\n"],
    ["right", "$x=y$ omega anchor\n"],
  ])("locates a formula with only a %s text anchor", (_side, source) => {
    const unit = formHybridAlignmentUnits(source)[0];
    const formula = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven one-sided local window",
      lines: pdfAlignmentLines(geometryFromPages([["alpha anchor x=y omega anchor"]])),
    }).find((projection) => (
      unit.child_lids.find((child) => child.lid === projection.lid)?.kind === "formula"
    ));

    expect(formula).toMatchObject({
      precision: "partial",
      regions: [{ pageIndex: 0 }],
      alignment: { reason: "complete formula glyph projection in unique formula region" },
    });
    expect(formula?.selection_assignments).toHaveLength(3);
  });

  it("uses a unique whole monotonic chain for repeated short formulas", () => {
    const source = "$n$ $n$\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const formulas = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven repeated formula window",
      lines: pdfAlignmentLines(geometryFromPages([["n n"]])),
    }).filter((projection) => (
      unit.child_lids.find((child) => child.lid === projection.lid)?.kind === "formula"
    ));

    expect(unit.child_lids.map((child) => child.kind)).toEqual(["formula", "formula"]);
    expect(formulas.map((projection) => projection.precision)).toEqual(["partial", "partial"]);
    expect(new Set(formulas.map((projection) => projection.primary_region?.bbox.join(","))).size).toBe(2);
  });

  it("projects PR15 whole-chain formula regions without reusing a PDF glyph", () => {
    const source = "left anchor $n$ $n$ right anchor\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const formulas = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven repeated formula window with bilateral text anchors",
      lines: pdfAlignmentLines(geometryFromPages([["left anchor n n right anchor"]])),
    }).filter((projection) => (
      unit.child_lids.find((child) => child.lid === projection.lid)?.kind === "formula"
    ));

    expect(formulas).toHaveLength(2);
    expect(formulas.map((projection) => projection.precision)).toEqual(["partial", "partial"]);
    expect(formulas.map((projection) => projection.selection_assignments.length)).toEqual([1, 1]);
    expect(new Set(formulas.flatMap((projection) => (
      projection.selection_assignments.map((assignment) => `${assignment.pageIndex}:${assignment.char_index}`)
    ))).size).toBe(2);
  });

  it("projects structural formula glyphs onto positioned source tokens", () => {
    const source = "$ x_i^2 + \\sqrt{y} $\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const formula = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven structural formula region",
      lines: pdfAlignmentLines(geometryFromPositionedChars([
        { text: "x", bbox: [72, 120, 80, 132] },
        { text: "i", bbox: [81, 112, 87, 120] },
        { text: "2", bbox: [88, 132, 94, 140] },
        { text: "+", bbox: [98, 120, 106, 132] },
        { text: "√", bbox: [110, 120, 120, 136] },
        { text: "y", bbox: [121, 120, 129, 132] },
      ])),
    })[0];

    expect(formula).toMatchObject({
      precision: "partial",
      formula_display_text: "xi2+√y",
      alignment: { reason: "complete structural formula glyph projection" },
    });
    expect(formula.selection_assignments.map((assignment) => assignment.text)).toEqual(["x", "i", "2", "+", "√", "y"]);
    expect(formula.selection_assignments.find((assignment) => assignment.text === "√")?.source_span)
      .toEqual({ start: source.indexOf("\\sqrt"), end: source.indexOf("\\sqrt") + "\\sqrt".length });
  });

  it("projects fraction arguments only when their two-dimensional lanes match the AST", () => {
    const source = "$ \\frac{x}{y} $\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const project = (numeratorY: number, denominatorY: number) => projectHybridAlignmentChildren(source, {
      unit,
      status: "located" as const,
      reason: "test-proven fraction window",
      lines: pdfAlignmentLines(geometryFromPositionedChars([
        { text: "x", bbox: [82, numeratorY, 90, numeratorY + 10] },
        { text: "y", bbox: [82, denominatorY, 90, denominatorY + 10] },
      ])),
    })[0];

    expect(project(124, 108)).toMatchObject({
      precision: "partial",
      formula_display_text: "xy",
      alignment: { reason: "complete structural formula glyph projection" },
    });
    expect(project(108, 124)).toMatchObject({
      precision: "unmapped",
      alignment: { reason: "formula glyph geometry conflicts with source AST" },
    });
  });

  it.each([
    ["missing subscript", "$ x_i $\n", [{ text: "x", bbox: [72, 120, 80, 132] }]],
    ["changed variable", "$ x_i $\n", [
      { text: "x", bbox: [72, 120, 80, 132] },
      { text: "j", bbox: [81, 112, 87, 120] },
    ]],
    ["changed operator", "$ x+y $\n", [
      { text: "x", bbox: [72, 120, 80, 132] },
      { text: "-", bbox: [82, 120, 90, 132] },
      { text: "y", bbox: [92, 120, 100, 132] },
    ]],
    ["flat subscript", "$ x_i $\n", [
      { text: "x", bbox: [72, 120, 80, 132] },
      { text: "i", bbox: [82, 120, 90, 132] },
    ]],
  ])("keeps %s formula evidence fail-closed", (_name, source, chars) => {
    const unit = formHybridAlignmentUnits(source)[0];
    const formula = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven invalid structural formula window",
      lines: pdfAlignmentLines(geometryFromPositionedChars(chars as Array<{
        text: string;
        bbox: [number, number, number, number];
      }>)),
    })[0];

    expect(formula.precision).toBe("unmapped");
    expect(formula.selection_assignments).toEqual([]);
    expect(formula.exact_source_spans).toEqual([]);
  });

  it("keeps a uniquely located unsupported standalone formula as object-only evidence", () => {
    const source = "$$ \\begin{aligned}x&=y\\\\z&=w\\end{aligned} $$\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const formula = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven standalone formula object",
      lines: pdfAlignmentLines(geometryFromPages([["x = y", "z = w"]])),
    })[0];

    expect(unit.child_lids).toHaveLength(1);
    expect(formula).toMatchObject({
      precision: "region_exact",
      alignment: { reason: "unique formula object region for unsupported source AST" },
    });
    expect(formula.regions).toHaveLength(2);
    expect(formula.selection_assignments).toEqual([]);
    expect(formula.exact_source_spans).toEqual([]);
  });

  it("fails closed when repeated formula signatures have multiple whole monotonic chains", () => {
    const source = "$n$ $n$\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const formulas = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven ambiguous formula window",
      lines: pdfAlignmentLines(geometryFromPages([["n n n"]])),
    }).filter((projection) => (
      unit.child_lids.find((child) => child.lid === projection.lid)?.kind === "formula"
    ));

    expect(formulas).toHaveLength(2);
    expect(formulas.every((projection) => (
      projection.precision === "unmapped"
      && projection.alignment.reason === "ambiguous_binding: multiple equal formula region chains"
      && projection.binding_candidate_count === projection.binding_rejections?.length
      && projection.binding_rejections?.length
      && projection.binding_rejections.every((rejection) => (
        rejection.competitor_ids.length > 0
        && rejection.constraint === "multiple_equal_monotonic_formula_chains"
      ))
    ))).toBe(true);
  });

  it.each([
    ["pages", geometryFromPages([["x"], ["y"]])],
    ["columns", geometryFromPositionedLines([
      { text: "x", bbox: [72, 180, 78, 192] },
      { text: "y", bbox: [360, 160, 366, 172] },
    ])],
  ])("refuses a formula signature that crosses page-column %s", (_kind, geometry) => {
    const source = "$xy$\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const formula = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven cross-lane window",
      lines: pdfAlignmentLines(geometry),
    })[0];

    expect(formula).toMatchObject({
      precision: "unmapped",
      regions: [],
      alignment: { reason: "formula signature crosses page-column lanes" },
    });
  });

  it("locates a standalone formula when the following source block starts on another page", () => {
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
    expect(formula.regions).toMatchObject([{ pageIndex: 0 }]);
    expect(formula.selection_assignments).toHaveLength(3);
    expect(formula.alignment.reason).toBe("complete formula glyph projection in unique formula region");
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

  it("projects parser-proven heading and list markers as non-visible structure", () => {
    const source = "# Heading title\n\n- Listed item\n";
    const result = alignHybridFoundationV2(source, geometryFromPages([["Heading title", "• Listed item"]]));

    expect(result.projections.map((projection) => projection.precision)).toEqual(["char_exact", "char_exact"]);
    expect(result.projections[0].exact_source_spans[0].start).toBe(source.indexOf("Heading"));
    expect(result.projections[1].exact_source_spans[0].start).toBe(source.indexOf("Listed"));
  });

  it("accepts prose typography but keeps the same substitutions material in code", () => {
    const proseSource = "The model's efficient office.\n";
    const prose = alignHybridFoundationV2(proseSource, geometryFromPages([["The model’s eﬃcient office."]]));
    const codeSource = "```python\nprint('office')\n```\n";
    const code = alignHybridFoundationV2(codeSource, geometryFromPages([["print(’office’) "]]));

    expect(prose.projections[0]).toMatchObject({ precision: "char_exact" });
    expect(code.projections[0].precision).not.toBe("char_exact");
  });

  it("keeps compatibility characters and case material in code", () => {
    const ligatureSource = "```text\nffi\n```\n";
    const ligature = alignHybridFoundationV2(ligatureSource, geometryFromPages([["ﬃ"]]));
    const caseSource = "```text\nAlpha\n```\n";
    const letterCase = alignHybridFoundationV2(caseSource, geometryFromPages([["alpha"]]));

    expect(ligature.projections[0].precision).not.toBe("char_exact");
    expect(letterCase.projections[0].precision).not.toBe("char_exact");
  });

  it("keeps prose quote equivalence out of formula projection", () => {
    const source = "value $x'$ tail\n";
    const result = alignHybridFoundationV2(source, geometryFromPages([["value x’ tail"]]));
    const formulaLid = result.units
      .flatMap((unit) => unit.child_lids)
      .find((child) => child.kind === "formula")?.lid;
    const formula = result.projections.find((projection) => projection.lid === formulaLid);

    expect(formula?.precision).not.toBe("region_exact");
  });

  it("keeps missing punctuation and dash or minus substitutions fail-closed", () => {
    const fixtures = [
      ["A result:\n", "A result"],
      ["alpha-beta\n", "alpha–beta"],
      ["alpha-beta\n", "alpha—beta"],
      ["alpha-beta\n", "alpha−beta"],
    ] as const;
    for (const [source, pdf] of fixtures) {
      expect(alignHybridFoundationV2(source, geometryFromPages([[pdf]])).projections[0].precision, pdf)
        .not.toBe("char_exact");
    }
  });

  it("fails closed when text anchors have more than one global monotonic chain", () => {
    const source = "repeat $x$ tail\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const projections = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven repeated local window",
      lines: pdfAlignmentLines(geometryFromPages([["repeat x tail repeat x tail"]])),
    });

    expect(projections.filter((projection) => (
      unit.child_lids.find((child) => child.lid === projection.lid)?.kind === "text"
    ))).toEqual([
      expect.objectContaining({
        precision: "unmapped",
        alignment: expect.objectContaining({ reason: "ambiguous_binding: multiple equal exact child chains" }),
        binding_rejections: expect.arrayContaining([expect.objectContaining({
          constraint: "multiple_equal_monotonic_exact_child_chains",
        })]),
      }),
      expect.objectContaining({
        precision: "unmapped",
        alignment: expect.objectContaining({ reason: "ambiguous_binding: multiple equal exact child chains" }),
        binding_rejections: expect.arrayContaining([expect.objectContaining({
          constraint: "multiple_equal_monotonic_exact_child_chains",
        })]),
      }),
    ]);
  });

  it("does not let a failed child advance or consume the following exact anchor", () => {
    const source = "alpha $x$ impossible $y$ omega\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const projections = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven child-local windows",
      lines: pdfAlignmentLines(geometryFromPages([["alpha x q y omega"]])),
    });
    const text = projections.filter((projection) => (
      unit.child_lids.find((child) => child.lid === projection.lid)?.kind === "text"
    ));

    expect(text.map((projection) => projection.precision)).toEqual(["char_exact", "unmapped", "char_exact"]);
    expect(text[1].alignment.reason).toBe("child has no deterministic projection inside its local PDF window");
    expect(text[2].selection_assignments.map((assignment) => assignment.text).join("")).toBe("omega");
  });

  it("refuses LCS when adjacent unresolved children would share one PDF window", () => {
    const source = "alphaished $x$ betaish\n";
    const unit = formHybridAlignmentUnits(source)[0];
    const projections = projectHybridAlignmentChildren(source, {
      unit,
      status: "located",
      reason: "test-proven shared unresolved window",
      lines: pdfAlignmentLines(geometryFromPages([["alphaXished x betaXish"]])),
    });
    const text = projections.filter((projection) => (
      unit.child_lids.find((child) => child.lid === projection.lid)?.kind === "text"
    ));

    expect(text).toHaveLength(2);
    expect(text.every((projection) => (
      projection.precision === "unmapped"
      && projection.alignment.reason === "child has no exclusive local PDF window"
    ))).toBe(true);
  });
});
