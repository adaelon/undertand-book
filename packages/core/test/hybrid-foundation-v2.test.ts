import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHybridFoundationV2Integrity,
  buildHybridFoundationV2Candidate,
  resolveHybridProjectionConflicts,
  validateHybridFoundationV2ArtifactSet,
  writeHybridFoundationV2ArtifactSet,
} from "../src/hybrid-foundation-v2";
import type { HybridChildProjection } from "../src/hybrid-alignment-v2";
import { extractPdfTextGeometry, type PdfTextGeometry } from "../src/pdf-geometry";
import { reconcilePaperSource } from "../src/source-reconciliation";
import {
  AlignmentReportV2Z,
  PdfSelectionMapManifestV2Z,
  PdfSelectionMapPageShardV2Z,
  PdfSourceMapV2Z,
  SourceManifestV2Z,
} from "../src/zod";

const FIXTURE_ROOT = path.resolve(fileURLToPath(new URL("fixtures/hybrid-foundation-goldset/v1", import.meta.url)));

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function geometryFromLines(lines: string[]): PdfTextGeometry {
  let charIndex = 0;
  const height = 240;
  const lineData = lines.map((text, lineIndex) => {
    const start = charIndex;
    const chars = Array.from(text).map((value, offset) => ({
      pageIndex: 0,
      charIndex: charIndex++,
      text: value,
      bbox: [72 + offset * 6, height - 40 - lineIndex * 20, 78 + offset * 6, height - 28 - lineIndex * 20] as [number, number, number, number],
    }));
    return { text, lineIndex, start, end: charIndex, chars };
  });
  return {
    pages: [{
      pageIndex: 0,
      width: 600,
      height,
      rotate: 0,
      view: [0, 0, 600, height],
      words: [],
      chars: lineData.flatMap((line) => line.chars),
      lines: lineData.map((line) => ({
        pageIndex: 0,
        lineIndex: line.lineIndex,
        text: line.text,
        char_start: line.start,
        char_end: line.end,
        bbox: [72, height - 40 - line.lineIndex * 20, 72 + line.text.length * 6, height - 28 - line.lineIndex * 20],
      })),
    }],
  };
}

async function inlineFixture() {
  const dir = path.join(FIXTURE_ROOT, "licensed-inline-formula");
  const source = readFileSync(path.join(dir, "source.md"), "utf8");
  const pdfBytes = new Uint8Array(readFileSync(path.join(dir, "paper.pdf")));
  const geometry = await extractPdfTextGeometry(pdfBytes);
  return { source, pdfBytes, geometry };
}

describe("HF2-3 hybrid foundation v2 artifacts", () => {
  it("builds schema-valid full-quality maps while keeping unsupported formula displays region-only", async () => {
    const { source, pdfBytes, geometry } = await inlineFixture();
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "inline-v2",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: sha256(pdfBytes),
      pdf_geometry: geometry,
    });

    expect(PdfSourceMapV2Z.parse(artifacts.pdf_source_map)).toEqual(artifacts.pdf_source_map);
    expect(PdfSelectionMapManifestV2Z.parse(artifacts.pdf_selection_map_manifest)).toEqual(artifacts.pdf_selection_map_manifest);
    expect(PdfSelectionMapPageShardV2Z.parse(artifacts.pdf_selection_map_pages[0])).toEqual(artifacts.pdf_selection_map_pages[0]);
    expect(AlignmentReportV2Z.parse(artifacts.alignment_report)).toEqual(artifacts.alignment_report);
    expect(SourceManifestV2Z.parse(artifacts.source_manifest)).toEqual(artifacts.source_manifest);
    expect(() => assertHybridFoundationV2Integrity(artifacts)).not.toThrow();
    expect(artifacts.pdf_source_map.display_token_policy_version).toBe("pdf_display_token_policy.v1");
    expect(artifacts.alignment_report.quality).toMatchObject({
      tier: "full",
      unit_location_ratio: 1,
      exact_text_span_ratio: 1,
      exact_formula_ratio: 1,
      heading_location_ratio: 1,
    });
    const formula = artifacts.pdf_source_map.entries.find((entry) => entry.precision === "region_exact")!;
    expect(formula.exact_source_spans).toEqual([]);
    expect(artifacts.pdf_selection_map_pages.flatMap((page) => page.chars).some((char) => char.lid === formula.lid)).toBe(false);
    const charExactLids = new Set(artifacts.pdf_source_map.entries
      .filter((entry) => entry.precision === "char_exact")
      .map((entry) => entry.lid));
    expect(artifacts.pdf_selection_map_pages.flatMap((page) => page.chars)
      .every((char) => charExactLids.has(char.lid))).toBe(true);
  });

  it("serializes bounded simple formula display evidence into selection shards", () => {
    const source = "# Formula\n\nBefore alpha $ m $ after beta.\n";
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "simple-formula-display-v2",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: sha256("simple-formula-display"),
      pdf_geometry: geometryFromLines(["Formula", "Before alpha m after beta."]),
    });

    const formula = artifacts.pdf_source_map.entries.find((entry) => entry.formula_display_text)!;
    expect(formula).toMatchObject({ precision: "partial", formula_display_text: "m" });
    expect(formula.exact_source_spans.length).toBeGreaterThan(0);
    expect(artifacts.pdf_selection_map_pages.flatMap((page) => page.chars)
      .filter((char) => char.lid === formula.lid)
      .map((char) => char.text)).toEqual(["m"]);
    expect(() => assertHybridFoundationV2Integrity(artifacts)).not.toThrow();
  });

  it("round-trips a complete v2 disk set and rejects a tampered selection shard", async () => {
    const { source, pdfBytes, geometry } = await inlineFixture();
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "inline-v2-disk",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: sha256(pdfBytes),
      pdf_geometry: geometry,
    });
    const output = mkdtempSync(path.join(os.tmpdir(), "hybrid-foundation-v2-disk-"));

    writeHybridFoundationV2ArtifactSet(output, source, artifacts);
    const loaded = validateHybridFoundationV2ArtifactSet(output);
    expect(loaded.pdf_source_map.version).toBe("pdf_source_map.v2");
    expect(loaded.pdf_selection_map_manifest.version).toBe("pdf_selection_map.v2");
    expect(loaded.alignment_report.version).toBe("alignment_report.v2");

    const shardPath = path.join(output, "pdf_selection_map", loaded.pdf_selection_map_manifest.page_shards[0].path);
    const shard = JSON.parse(readFileSync(shardPath, "utf8"));
    shard.chars[0].text = "tampered";
    writeFileSync(shardPath, JSON.stringify(shard, null, 2), "utf8");
    expect(() => validateHybridFoundationV2ArtifactSet(output)).toThrow(/shard hash/i);
  });

  it("rejects display token policy drift across v2 artifacts", async () => {
    const { source, pdfBytes, geometry } = await inlineFixture();
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "display-policy-drift-v2",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: sha256(pdfBytes),
      pdf_geometry: geometry,
    });

    delete artifacts.pdf_source_map.display_token_policy_version;
    expect(() => assertHybridFoundationV2Integrity(artifacts)).toThrow(/display token policy/i);
  });

  it("allows only the proven exact characters of a partial LID in selection shards", async () => {
    const { source, pdfBytes, geometry } = await inlineFixture();
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "partial-v2-disk",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: sha256(pdfBytes),
      pdf_geometry: geometry,
    });
    const entry = artifacts.pdf_source_map.entries.find((candidate) => candidate.precision === "char_exact")!;
    entry.precision = "partial";
    const output = mkdtempSync(path.join(os.tmpdir(), "hybrid-foundation-v2-partial-"));
    writeHybridFoundationV2ArtifactSet(output, source, artifacts);

    expect(() => validateHybridFoundationV2ArtifactSet(output)).not.toThrow();
  });

  it("classifies safe low coverage as degraded without failing integrity", () => {
    const source = "# Title\n\nOne missing block.\n\nTwo missing blocks.\n\nThree missing blocks.\n";
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "degraded-v2",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "a".repeat(64),
      pdf_geometry: geometryFromLines(["Title"]),
    });

    expect(artifacts.alignment_report.quality.tier).toBe("degraded");
    expect(Object.values(artifacts.alignment_report.integrity).every(Boolean)).toBe(true);
    expect(() => assertHybridFoundationV2Integrity(artifacts)).not.toThrow();
    expect(artifacts.source_manifest.alignment_quality?.tier).toBe("degraded");
    expect(artifacts.source_manifest.capabilities.project_lid_to_pdf.status).toBe("degraded");
  });

  it("fails integrity when source alignment evidence has a stale fingerprint", () => {
    const source = "Trusted text.\n";
    const geometry = geometryFromLines(["Trusted text."]);
    const reconciliation = reconcilePaperSource({
      book_id: "stale-v2",
      markdown_source: source,
      pdf_geometry: geometry,
      input_fingerprint: {
        paper_md_sha256: "b".repeat(64),
        paper_pdf_sha256: "c".repeat(64),
        config_hash: "cfg",
      },
    });
    const staleEvidence = {
      ...reconciliation.alignment_evidence,
      input_fingerprint: {
        ...reconciliation.alignment_evidence.input_fingerprint,
        source_sha256: "d".repeat(64),
      },
    };
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "stale-v2",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "c".repeat(64),
      pdf_geometry: geometry,
      source_alignment_evidence: staleEvidence,
    });

    expect(artifacts.alignment_report.integrity.input_fingerprint_matches).toBe(false);
    expect(() => assertHybridFoundationV2Integrity(artifacts)).toThrow(/input_fingerprint_matches/);
  });

  it("rejects character claims on a region_exact entry", async () => {
    const { source, pdfBytes, geometry } = await inlineFixture();
    const artifacts = buildHybridFoundationV2Candidate({
      book_id: "invalid-v2",
      source_txt: source,
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: sha256(pdfBytes),
      pdf_geometry: geometry,
    });
    const invalid = structuredClone(artifacts.pdf_source_map);
    const formula = invalid.entries.find((entry) => entry.precision === "region_exact")!;
    formula.exact_source_spans = [{ ...formula.source_span }];

    expect(() => PdfSourceMapV2Z.parse(invalid)).toThrow(/region_exact/);
  });

  it("fails closed on ambiguous region and character ownership", () => {
    const projection = (lid: string, sourceStart: number): HybridChildProjection => ({
      lid,
      source_span: { start: sourceStart, end: sourceStart + 1 },
      precision: "char_exact",
      regions: [{ region_id: `${lid}-region`, pageIndex: 0, bbox: [10, 20, 30, 40] }],
      exact_source_spans: [{ start: sourceStart, end: sourceStart + 1 }],
      selection_assignments: [{
        pageIndex: 0,
        char_index: 7,
        text: "x",
        rect: { pageIndex: 0, bbox: [10, 20, 30, 40] },
        source_span: { start: sourceStart, end: sourceStart + 1 },
      }],
      primary_region: { region_id: `${lid}-region`, pageIndex: 0, bbox: [10, 20, 30, 40] },
      alignment: { unit_id: `${lid}-unit`, reason: "test projection" },
    });
    const result = resolveHybridProjectionConflicts([projection("lid-a", 0), projection("lid-b", 2)]);

    expect(result).toMatchObject({
      raw_duplicate_region_binding_count: 1,
      raw_duplicate_selection_binding_count: 1,
      conflicted_lid_count: 2,
    });
    expect(result.projections).toEqual(result.projections.map((candidate) => expect.objectContaining({
      precision: "unmapped",
      regions: [],
      exact_source_spans: [],
      selection_assignments: [],
      alignment: expect.objectContaining({ reason: expect.stringContaining("conflicts") }),
    })));
    expect(result.projections.every((candidate) => candidate.primary_region === undefined)).toBe(true);
  });
});
