import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHybridFoundation, assertHybridFoundationHardGates, writeHybridFoundationArtifacts } from "../src/hybrid-foundation";
import type { PdfTextGeometry } from "../src/pdf-geometry";
import {
  AlignmentReportZ,
  PdfSelectionMapManifestZ,
  PdfSelectionMapPageShardZ,
  PdfSourceMapZ,
  ReadOnlyBaseZ,
  SourceManifestV2Z,
} from "../src/zod";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-hybrid-"));
}

function geometryFromPages(pageLines: string[][]): PdfTextGeometry {
  return {
    pages: pageLines.map((lines, pageIndex) => {
      let charIndex = 0;
      const lineRanges = lines.map((line) => {
        const start = charIndex;
        charIndex += Array.from(line).length;
        return { start, end: charIndex };
      });
      const width = Math.max(600, ...lines.map((line) => 144 + line.length * 6));
      const height = Math.max(200, 80 + lines.length * 18);
      return {
        pageIndex,
        page_label: String(pageIndex + 1),
        width,
        height,
        rotate: 0,
        view: [0, 0, width, height],
        words: [],
        chars: lines.flatMap((line, lineIndex) =>
          Array.from(line).map((text, offset) => ({
            pageIndex,
            charIndex: lineRanges[lineIndex].start + offset,
            text,
            bbox: [72 + offset * 6, height - 60 - lineIndex * 18, 78 + offset * 6, height - 48 - lineIndex * 18],
          })),
        ),
        lines: lines.map((text, lineIndex) => ({
          pageIndex,
          lineIndex,
          text,
          char_start: lineRanges[lineIndex].start,
          char_end: lineRanges[lineIndex].end,
          bbox: [72, height - 60 - lineIndex * 18, 72 + text.length * 6, height - 48 - lineIndex * 18],
        })),
      };
    }),
  };
}

function geometryFromLines(lines: string[]): PdfTextGeometry {
  return geometryFromPages([lines]);
}

describe("PH5 hybrid foundation", () => {
  it("builds base, source manifest v2, PDF maps, selection shards, and alignment report", () => {
    const source = "# Title\n\nHello PDF\n";
    const artifacts = buildHybridFoundation({
      book_id: "paper-a",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      original_pdf_fingerprint: "pdf-fp",
      pdf_geometry: geometryFromLines(["Title", "Hello PDF"]),
    });

    expect(ReadOnlyBaseZ.parse(artifacts.base)).toEqual(artifacts.base);
    expect(SourceManifestV2Z.parse(artifacts.source_manifest)).toEqual(artifacts.source_manifest);
    expect(PdfSourceMapZ.parse(artifacts.pdf_source_map)).toEqual(artifacts.pdf_source_map);
    expect(PdfSelectionMapManifestZ.parse(artifacts.pdf_selection_map_manifest)).toEqual(artifacts.pdf_selection_map_manifest);
    expect(PdfSelectionMapPageShardZ.parse(artifacts.pdf_selection_map_pages[0])).toEqual(artifacts.pdf_selection_map_pages[0]);
    expect(AlignmentReportZ.parse(artifacts.alignment_report)).toEqual(artifacts.alignment_report);
    expect(() => assertHybridFoundationHardGates(artifacts)).not.toThrow();

    expect(artifacts.pdf_source_map.entries).toHaveLength(2);
    expect(artifacts.pdf_source_map.entries.every((entry) => entry.primary_region)).toBe(true);
    expect(artifacts.source_manifest.capabilities.view_pdf.status).toBe("available");
    expect(artifacts.source_manifest.capabilities.project_lid_to_pdf.status).toBe("degraded");
    expect(artifacts.alignment_report.hard_gates.all_entries_reference_leaf_lids).toBe(true);
    expect(artifacts.alignment_report.hard_gates.selection_page_hashes_match).toBe(true);
  });

  it("writes PH5 artifacts to the book output directory", () => {
    const source = "# Title\n\nHello PDF\n";
    const artifacts = buildHybridFoundation({
      book_id: "paper-a",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines(["Title", "Hello PDF"]),
    });
    const dir = tempDir();
    const written = writeHybridFoundationArtifacts(dir, source, artifacts);

    expect(existsSync(written.base_path)).toBe(true);
    expect(existsSync(written.source_path)).toBe(true);
    expect(existsSync(written.source_manifest_path)).toBe(true);
    expect(existsSync(written.pdf_source_map_path)).toBe(true);
    expect(existsSync(written.pdf_selection_map_manifest_path)).toBe(true);
    expect(written.pdf_selection_map_page_paths.every((p) => existsSync(p))).toBe(true);
    expect(existsSync(written.alignment_report_path)).toBe(true);
    expect(readFileSync(written.source_path, "utf8")).toBe(source);
  });

  it("prefers a nearby split heading over a later prose repetition", () => {
    const source = [
      "# Paper",
      "",
      "### Isoform Diversity Analysis",
      "",
      "### Differential Isoform Usage Analysis",
      "",
    ].join("\n");
    const artifacts = buildHybridFoundation({
      book_id: "paper-window",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromPages([
        ["Paper", "Isoform Diversity", "Analysis", "Differential Isoform Usage Analysis"],
        ["Later discussion says Isoform Diversity Analysis showed a secondary pattern."],
      ]),
    });

    expect(artifacts.pdf_source_map.entries[1].primary_region?.pageIndex).toBe(0);
    expect(artifacts.pdf_source_map.entries[2].primary_region?.pageIndex).toBe(0);
  });

  it("maps a paragraph anchor across consecutive PDF lines", () => {
    const source = "# Title\n\nA long paragraph spans PDF lines and should remain mapped.\n";
    const artifacts = buildHybridFoundation({
      book_id: "paper-multiline",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines([
        "Title",
        "A long paragraph spans PDF",
        "lines and should remain mapped.",
      ]),
    });

    expect(artifacts.pdf_source_map.entries[1].status).toBe("block_fallback");
    expect(artifacts.pdf_source_map.entries[1].regions).toHaveLength(2);
  });

  it("extends a matched paragraph through all PDF lines and assigns per-character source spans", () => {
    const paragraph = [
      "Alpha beta gamma delta epsilon zeta",
      "eta theta iota kappa lambda mu",
      "nu xi omicron pi rho sigma",
      "tau upsilon phi chi psi omega.",
    ];
    const source = `# Title\n\n${paragraph.join(" ")}\n`;
    const artifacts = buildHybridFoundation({
      book_id: "paper-character-selection",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines(["Title", ...paragraph]),
    });

    const entry = artifacts.pdf_source_map.entries[1];
    expect(entry.status).toBe("block_fallback");
    expect(entry.regions).toHaveLength(4);

    const selectionPage = artifacts.pdf_selection_map_pages[0];
    const tauCharIndex = geometryFromLines(["Title", ...paragraph]).pages[0].lines[4].char_start;
    const tau = selectionPage.chars.find((char) => char.char_index === tauCharIndex);
    const tauStart = source.indexOf("tau upsilon");
    expect(tau).toMatchObject({
      text: "t",
      lid: entry.lid,
      source_span: { start: tauStart, end: tauStart + 1 },
    });
    expect(new Set(
      selectionPage.chars
        .filter((char) => char.lid === entry.lid)
        .map((char) => `${char.source_span.start}:${char.source_span.end}`),
    ).size).toBeGreaterThan(20);
  });

  it("stops paragraph extension before a weakly matching following block", () => {
    const source = [
      "# Title",
      "",
      "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.",
      "",
      "## Omega unrelated section",
      "",
    ].join("\n");
    const artifacts = buildHybridFoundation({
      book_id: "paper-extension-boundary",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines([
        "Title",
        "Alpha beta gamma delta epsilon zeta",
        "eta theta iota kappa lambda mu",
        "nu xi omicron pi rho sigma",
        "Omega unrelated section",
      ]),
    });

    expect(artifacts.pdf_source_map.entries[1].regions).toHaveLength(3);
    expect(artifacts.pdf_source_map.entries[2]).toMatchObject({
      status: "line_fallback",
      regions: [{ pageIndex: 0 }],
    });
  });

  it("maps source blocks on both sides of an inline formula to one shared PDF line", () => {
    const source = "# Title\n\nAlpha beta gamma delta epsilon $ x $ zeta eta theta iota kappa\n";
    const geometry = geometryFromLines(["Title", "Alpha beta gamma delta epsilon x zeta eta theta iota kappa"]);
    geometry.pages[0].lines[1].bbox[2] = 250;
    const artifacts = buildHybridFoundation({
      book_id: "paper-shared-pdf-line",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometry,
    });

    const leading = artifacts.pdf_source_map.entries[1];
    const trailing = artifacts.pdf_source_map.entries[3];
    expect(leading.status).toBe("line_fallback");
    expect(trailing.status).toBe("line_fallback");
    expect(leading.regions[0].bbox).toEqual(trailing.regions[0].bbox);

    const page = artifacts.pdf_selection_map_pages[0];
    const lineStart = geometry.pages[0].lines[1].char_start;
    expect(page.chars.find((char) => char.char_index === lineStart)).toMatchObject({ lid: leading.lid });
    const zetaIndex = geometry.pages[0].chars.find((char) => char.charIndex >= lineStart && char.text === "z")!.charIndex;
    expect(page.chars.find((char) => char.char_index === zetaIndex)).toMatchObject({ lid: trailing.lid });
  });

  it("maps a paragraph across a hyphenated PDF line break", () => {
    const source = "# Title\n\nThe enriched pathway remains stable.\n";
    const artifacts = buildHybridFoundation({
      book_id: "paper-hyphenated-line-break",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines([
        "Title",
        "The en-",
        "riched pathway remains stable.",
      ]),
    });

    expect(artifacts.pdf_source_map.entries[1].status).toBe("block_fallback");
    expect(artifacts.pdf_source_map.entries[1].regions).toHaveLength(2);
  });

  it("normalizes semantic source hyphens and PDF line-break hyphens consistently", () => {
    const source = "# Title\n\nSingle-nuclei extraction remains stable.\n";
    const artifacts = buildHybridFoundation({
      book_id: "paper-semantic-hyphen",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines([
        "Title",
        "Single-",
        "nuclei extraction remains stable.",
      ]),
    });

    expect(artifacts.pdf_source_map.entries[1].status).toBe("block_fallback");
  });

  it("continues a mid-line paragraph anchor onto following PDF lines", () => {
    const source = "# Title\n\nTarget begins here and continues across another PDF line.\n";
    const geometry = geometryFromLines([
      "Title",
      "Several preceding words appear before Target begins here and continues",
      "across another PDF line.",
    ]);
    geometry.pages[0].lines[1].bbox[2] = 250;
    geometry.pages[0].lines[2].bbox[2] = 250;
    const artifacts = buildHybridFoundation({
      book_id: "paper-mid-line-anchor",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometry,
    });

    expect(artifacts.pdf_source_map.entries[1].status).toBe("block_fallback");
    expect(artifacts.pdf_source_map.entries[1].regions).toHaveLength(2);
  });

  it("ignores out-of-bounds PDF geometry lines as alignment candidates", () => {
    const source = "# Title\n\nTarget paragraph.\n";
    const geometry = geometryFromLines(["Title", "Target paragraph."]);
    geometry.pages[0].lines[1].bbox = [0, 0, geometry.pages[0].width + 100, geometry.pages[0].height + 100];

    const artifacts = buildHybridFoundation({
      book_id: "paper-invalid-geometry",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometry,
    });

    expect(artifacts.pdf_source_map.entries[1].status).toBe("unmapped");
    expect(artifacts.alignment_report.hard_gates.all_mapped_regions_in_page_bounds).toBe(true);
  });

  it("does not use tiny source fragments as contains anchors", () => {
    const source = "# Title\n\nat\n\n## Next Section\n";
    const artifacts = buildHybridFoundation({
      book_id: "paper-tiny-fragment",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines(["Title", "Samples were held at room temperature.", "Next Section"]),
    });

    expect(artifacts.pdf_source_map.entries[1].status).toBe("unmapped");
    expect(artifacts.pdf_source_map.entries[2].status).toBe("line_fallback");
  });

  it("aligns two-column pages by spatial reading order instead of PDF content-stream order", () => {
    const source = "# Clinical Perspective\n\nBody continuation.\n\n## Methods\n";
    const geometry = geometryFromPages([["Body continuation.", "Methods", "Clinical Perspective"]]);
    geometry.pages[0].height = 800;
    geometry.pages[0].view = [0, 0, geometry.pages[0].width, 800];
    geometry.pages[0].lines[0].bbox = [320, 600, 500, 612];
    geometry.pages[0].lines[1].bbox = [320, 500, 400, 512];
    geometry.pages[0].lines[2].bbox = [60, 700, 220, 712];

    const artifacts = buildHybridFoundation({
      book_id: "paper-two-column-order",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometry,
    });

    expect(artifacts.pdf_source_map.entries.map((entry) => entry.status)).toEqual([
      "line_fallback",
      "line_fallback",
      "line_fallback",
    ]);
  });

  it("keeps a short final line inside the full-width band before entering two columns", () => {
    const source = [
      "# Paper",
      "",
      "Full width opening alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu short continuation.",
      "",
      "## Full Width Next",
      "",
      "## Left Section",
      "",
      "Left body.",
      "",
      "## Right Section",
      "",
      "Right body.",
      "",
    ].join("\n");
    const geometry = geometryFromPages([[
      "Paper",
      "Full width opening alpha beta",
      "Downloaded furniture",
      "gamma delta epsilon zeta",
      "eta theta iota kappa lambda mu",
      "short continuation.",
      "Full Width Next",
      "Left Section",
      "Left body.",
      "Right Section",
      "Right body.",
    ]]);
    geometry.pages[0].height = 800;
    geometry.pages[0].view = [0, 0, 600, 800];
    const boxes = [
      [60, 750, 540, 762],
      [60, 700, 540, 712],
      [20, 690, 190, 698],
      [60, 680, 540, 692],
      [60, 660, 540, 672],
      [60, 640, 220, 652],
      [60, 600, 540, 612],
      [60, 550, 220, 562],
      [60, 530, 220, 542],
      [320, 550, 500, 562],
      [320, 530, 500, 542],
    ] as Array<[number, number, number, number]>;
    geometry.pages[0].lines.forEach((line, index) => { line.bbox = boxes[index]; });

    const artifacts = buildHybridFoundation({
      book_id: "paper-full-width-tail",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometry,
    });

    expect(artifacts.pdf_source_map.entries[1].regions).toHaveLength(4);
    expect(artifacts.pdf_source_map.entries.slice(2).every((entry) => entry.status === "line_fallback")).toBe(true);
  });

  it("rejects a foundation whose text mapping coverage is not reader-ready", () => {
    const source = "# Title\n\nOne missing block.\n\nTwo missing blocks.\n\nThree missing blocks.\n\nFour missing blocks.\n";
    const artifacts = buildHybridFoundation({
      book_id: "paper-low-coverage",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_geometry: geometryFromLines(["Title"]),
    });

    expect(artifacts.alignment_report.hard_gates.minimum_text_mapping_ratio).toBe(false);
    expect(() => assertHybridFoundationHardGates(artifacts)).toThrow(/mapping coverage/i);
  });
});
