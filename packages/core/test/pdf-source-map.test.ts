import { describe, expect, it } from "vitest";
import { pdfUserSpaceCoordinateSystem } from "../src/pdf-source-map";
import {
  PdfSelectionMapManifestZ,
  PdfSelectionMapPageShardZ,
  PdfSourceMapZ,
  SourceReconciliationReportZ,
} from "../src/zod";
import { emptyReconciliationSummary, sourceReconciliationTrusted } from "../src/source-reconciliation";

describe("PH1 PDF-first schema fixtures", () => {
  it("accepts verified and auto-repaired source reconciliation reports", () => {
    const summary = emptyReconciliationSummary();
    summary.verified = 2;
    summary.auto_repaired = 1;
    const report = {
      version: "source_reconciliation_report.v1" as const,
      book_id: "paper-a",
      input_fingerprint: {
        paper_md_sha256: "sha-md",
        paper_pdf_sha256: "sha-pdf",
        config_hash: "cfg",
      },
      summary,
      unresolved: [],
    };

    expect(SourceReconciliationReportZ.parse(report)).toEqual(report);
    expect(sourceReconciliationTrusted(report)).toBe(true);
  });

  it("keeps needs-review blocks unresolved so trusted output is blocked", () => {
    const summary = emptyReconciliationSummary();
    summary.verified = 1;
    summary.needs_review = 1;
    const report = {
      version: "source_reconciliation_report.v1" as const,
      book_id: "paper-a",
      input_fingerprint: {
        paper_md_sha256: "sha-md",
        paper_pdf_sha256: "sha-pdf",
        config_hash: "cfg",
      },
      summary,
      unresolved: [{ id: "block-2", status: "needs_review" as const, reason: "number differs" }],
    };

    expect(SourceReconciliationReportZ.parse(report)).toEqual(report);
    expect(sourceReconciliationTrusted(report)).toBe(false);
  });

  it("accepts a lightweight public PDF source map", () => {
    const coordinateSystem = pdfUserSpaceCoordinateSystem();
    const sourceMap = {
      version: "pdf_source_map.v1" as const,
      book_id: "paper-a",
      coordinate_system: coordinateSystem,
      pages: [{ pageIndex: 0, page_label: "1", width: 612, height: 792, rotate: 0 as const, view: [0, 0, 612, 792] }],
      entries: [
        {
          lid: "1.1",
          source_span: { start: 0, end: 12 },
          status: "word_mapped" as const,
          regions: [{ region_id: "r1", pageIndex: 0, bbox: [72, 700, 160, 720] }],
          primary_region: { region_id: "r1", pageIndex: 0, bbox: [72, 700, 160, 720] },
          alignment: { confidence: 0.99, trace_id: "t1" },
        },
      ],
      excluded_regions: [{ region_id: "e1", pageIndex: 0, bbox: [0, 760, 612, 792], reason: "header" as const }],
      page_region_index: { "0": ["r1"] },
      page_excluded_index: { "0": ["e1"] },
      config_hash: "cfg",
    };

    expect(PdfSourceMapZ.parse(sourceMap)).toEqual(sourceMap);
  });

  it("accepts backend-only sharded selection map fixtures", () => {
    const coordinateSystem = pdfUserSpaceCoordinateSystem();
    const manifest = {
      version: "pdf_selection_map.v1" as const,
      book_id: "paper-a",
      coordinate_system: coordinateSystem,
      config_hash: "cfg",
      page_shards: [{ pageIndex: 0, page_label: "1", path: "pages/0.json", sha256: "sha-page-0" }],
    };
    const page = {
      version: "pdf_selection_map_page.v1" as const,
      book_id: "paper-a",
      pageIndex: 0,
      page_label: "1",
      chars: [
        {
          char_index: 0,
          text: "A",
          rect: { pageIndex: 0, bbox: [72, 700, 78, 712] },
          source_span: { start: 0, end: 1 },
          lid: "1.1",
        },
      ],
    };

    expect(PdfSelectionMapManifestZ.parse(manifest)).toEqual(manifest);
    expect(PdfSelectionMapPageShardZ.parse(page)).toEqual(page);
  });
});
