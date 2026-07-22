import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runImageObjectAuditCli } from "../scripts/run-image-object-audit";
import { projectImageObjectRegions } from "../src/image-object-projection";
import type { HybridAlignmentUnit, HybridChildProjection } from "../src/hybrid-alignment-v2";
import type { PdfTextGeometry } from "../src/pdf-geometry";

const FIXTURE = path.resolve(fileURLToPath(new URL(
  "fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer-image-object-audit.json",
  import.meta.url,
)));

describe("PR17 image object projection policy", () => {
  it("closes a unique object-order gap between proven neighboring assets", () => {
    const child = (
      lid: string,
      kind: HybridAlignmentUnit["child_lids"][number]["kind"],
      start: number,
    ) => ({ lid, kind, source_span: { start, end: start + 1 } });
    const children = [
      child("before", "text", 0),
      child("image-1", "image", 1),
      child("caption-1", "text", 2),
      child("image-2", "image", 3),
      child("missing-caption", "text", 4),
      child("image-3", "image", 5),
      child("caption-3", "text", 6),
    ];
    const units: HybridAlignmentUnit[] = children.map((item, index) => ({
      unit_id: `unit-${index}`,
      policy_version: "hybrid_alignment_unit_policy.v1",
      source_span: { ...item.source_span },
      diagnostic: "within_guard",
      metrics: { child_count: 1, source_utf16_length: 1, searchable_token_count: 1 },
      child_lids: [item],
    }));
    const projection = (
      lid: string,
      bbox?: [number, number, number, number],
    ): HybridChildProjection => ({
      lid,
      source_span: { ...children.find((item) => item.lid === lid)!.source_span },
      precision: bbox ? "char_exact" : "unmapped",
      regions: bbox ? [{ region_id: `${lid}-region`, pageIndex: 0, bbox }] : [],
      exact_source_spans: bbox ? [{ ...children.find((item) => item.lid === lid)!.source_span }] : [],
      selection_assignments: [],
      ...(bbox ? { primary_region: { region_id: `${lid}-region`, pageIndex: 0, bbox } } : {}),
      alignment: { unit_id: lid, reason: bbox ? "proven fixture anchor" : "unmapped fixture" },
    });
    const projections = [
      projection("before", [70, 210, 180, 222]),
      projection("image-1"),
      projection("caption-1", [85, 70, 145, 82]),
      projection("image-2"),
      projection("missing-caption"),
      projection("image-3"),
      projection("caption-3", [245, 70, 305, 82]),
    ];
    const geometry: PdfTextGeometry = { pages: [{
      pageIndex: 0,
      width: 600,
      height: 240,
      rotate: 0,
      view: [0, 0, 600, 240],
      chars: [],
      words: [],
      lines: [],
      objects: [
        { pageIndex: 0, objectIndex: 0, kind: "image_xobject", bbox: [80, 100, 150, 160] },
        { pageIndex: 0, objectIndex: 1, kind: "image_xobject", bbox: [155, 100, 225, 160] },
        { pageIndex: 0, objectIndex: 2, kind: "image_xobject", bbox: [230, 100, 300, 160] },
      ],
    }] };

    const result = projectImageObjectRegions(units, projections, geometry);
    expect(["image-1", "image-2", "image-3"].map((lid) => (
      result.find((item) => item.lid === lid)!.primary_region?.bbox
    ))).toEqual([
      [80, 100, 150, 160],
      [155, 100, 225, 160],
      [230, 100, 300, 160],
    ]);
  });

  it("requires explicit approved inputs for the image object audit", async () => {
    await expect(runImageObjectAuditCli([])).rejects.toThrow("--source requires an explicit path");
  });

  it("freezes the migration-aware 19-image replay without source or alt text", () => {
    const reportText = readFileSync(FIXTURE, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("f5901ac38244bc46676017de583b9bdbd311dc981f6c1487a5411495bbc2298b");
    expect(Buffer.byteLength(reportText)).toBe(22_203);
    expect(report).toMatchObject({
      version: "image_object_audit.v1",
      policy_version: "pdf_asset_region_policy.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      summary: {
        image_count: 19,
        image_only_unit_count: 19,
        asset_region_exact_count: 19,
        asset_unmapped_count: 0,
        unclassified_count: 0,
        invalid_evidence_count: 0,
        duplicate_object_ownership_count: 0,
        selection_assignment_count: 0,
        exact_source_span_count: 0,
        wrong_page_count: 0,
        wrong_column_count: 0,
        legacy_projection_reason_count: 0,
        legacy_a010_image_count: 19,
      },
    });
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt|original_src|"alt"/u);
  });
});
