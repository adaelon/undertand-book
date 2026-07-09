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

function geometryFromLines(lines: string[]): PdfTextGeometry {
  let charIndex = 0;
  return {
    pages: [
      {
        pageIndex: 0,
        page_label: "1",
        width: 300,
        height: 200,
        rotate: 0,
        view: [0, 0, 300, 200],
        words: [],
        chars: lines.flatMap((line, lineIndex) =>
          Array.from(line).map((text, offset) => ({
            pageIndex: 0,
            charIndex: charIndex++,
            text,
            bbox: [72 + offset * 6, 120 - lineIndex * 18, 78 + offset * 6, 132 - lineIndex * 18],
          })),
        ),
        lines: lines.map((text, lineIndex) => ({
          pageIndex: 0,
          lineIndex,
          text,
          char_start: 0,
          char_end: text.length,
          bbox: [72, 120 - lineIndex * 18, 72 + text.length * 6, 132 - lineIndex * 18],
        })),
      },
    ],
  };
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
});
