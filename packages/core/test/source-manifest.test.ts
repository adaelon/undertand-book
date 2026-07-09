import { describe, expect, it } from "vitest";
import { buildSourceManifest, buildSourceManifestV2 } from "../src/source-manifest";
import { SourceManifestV2Z, SourceManifestZ } from "../src/zod";

describe("PP1 source manifest", () => {
  it("records Markdown as the canonical source truth without PDF attachment", () => {
    const manifest = buildSourceManifest({
      book_id: "paper-a",
      source_path: "papers/paper-a.md",
    });

    expect(SourceManifestZ.parse(manifest)).toEqual(manifest);
    expect(manifest).toEqual({
      book_id: "paper-a",
      canonical_source: {
        kind: "markdown",
        path: "papers/paper-a.md",
        truth_file: "source.txt",
        participates_in_lid: true,
        citation_anchor: "lid",
      },
      attachments: [],
    });
  });

  it("records original PDF as a side preview attachment that cannot act as citation evidence", () => {
    const manifest = buildSourceManifest({
      book_id: "paper-a",
      source_path: "papers/paper-a.md",
      original_pdf_path: "papers/paper-a.pdf",
    });

    expect(SourceManifestZ.parse(manifest)).toEqual(manifest);
    expect(manifest.attachments).toEqual([
      {
        kind: "original_pdf",
        path: "papers/paper-a.pdf",
        role: "side_preview",
        participates_in_lid: false,
        citation_anchor: false,
        pdf_source_map: {
          status: "not_provided",
          may_project_lid_to_pdf_region: false,
          citation_anchor: false,
        },
      },
    ]);
  });

  it("keeps a source-map extension point without making PDF coordinates citation anchors", () => {
    const manifest = buildSourceManifest({
      book_id: "paper-a",
      source_path: "papers/paper-a.md",
      original_pdf_path: "papers/paper-a.pdf",
      pdf_source_map_path: "papers/paper-a.source-map.json",
    });

    expect(manifest.attachments[0].pdf_source_map).toEqual({
      status: "provided",
      path: "papers/paper-a.source-map.json",
      may_project_lid_to_pdf_region: true,
      citation_anchor: false,
    });
  });

  it("rejects invalid PDF attachment wiring before writing source_manifest.json", () => {
    expect(() =>
      buildSourceManifest({
        book_id: "paper-a",
        source_path: "papers/paper-a.md",
        original_pdf_path: "papers/paper-a.txt",
      }),
    ).toThrow(".pdf");
    expect(() =>
      buildSourceManifest({
        book_id: "paper-a",
        source_path: "papers/paper-a.md",
        pdf_source_map_path: "papers/paper-a.source-map.json",
      }),
    ).toThrow("requires original_pdf_path");
  });
});

describe("PH1 source_manifest.v2", () => {
  it("records reconciled source and all available PDF capabilities", () => {
    const manifest = buildSourceManifestV2({
      book_id: "paper-a",
      source_sha256: "sha-source",
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      original_pdf_fingerprint: "pdf-fp",
      pdf_source_map_path: "pdf_source_map.json",
      pdf_selection_map_manifest_path: "pdf_selection_map/manifest.json",
      alignment_report_path: "alignment_report.json",
      config_hash: "cfg",
    });

    expect(SourceManifestV2Z.parse(manifest)).toEqual(manifest);
    expect(SourceManifestZ.parse(manifest)).toEqual(manifest);
    expect(manifest.canonical_source).toEqual({
      kind: "reconciled_markdown",
      path: "source.txt",
      citation_anchor: "lid",
      sha256: "sha-source",
    });
    expect(manifest.original_pdf).toEqual({
      path: "paper.pdf",
      sha256: "sha-pdf",
      fingerprint: "pdf-fp",
      citation_anchor: false,
    });
    expect(manifest.capabilities.project_lid_to_pdf).toMatchObject({
      status: "available",
      artifact_path: "pdf_source_map.json",
      report_path: "alignment_report.json",
      config_hash: "cfg",
    });
    expect(manifest.capabilities.resolve_pdf_selection).toMatchObject({
      status: "available",
      artifact_path: "pdf_selection_map/manifest.json",
    });
  });

  it("makes PDF capabilities explicitly unavailable when artifacts are disabled", () => {
    const manifest = buildSourceManifestV2({
      book_id: "paper-a",
      source_sha256: "sha-source",
    });

    expect(SourceManifestV2Z.parse(manifest)).toEqual(manifest);
    expect(manifest.original_pdf).toBeUndefined();
    expect(manifest.capabilities).toEqual({
      view_pdf: { status: "unavailable", reason: "original PDF is not available" },
      project_lid_to_pdf: { status: "unavailable", reason: "pdf_source_map.v1 is not available" },
      resolve_pdf_selection: { status: "unavailable", reason: "pdf_selection_map.v1 is not available" },
      project_ranges_to_pdf: { status: "unavailable", reason: "pdf_source_map.v1 is not available" },
    });
  });

  it("accepts stale and degraded capability states for readiness detection", () => {
    const manifest = buildSourceManifestV2({
      book_id: "paper-a",
      source_sha256: "sha-source",
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      capability_overrides: {
        project_lid_to_pdf: {
          status: "stale",
          artifact_path: "pdf_source_map.json",
          report_path: "alignment_report.json",
          reason: "source hash changed",
        },
        resolve_pdf_selection: {
          status: "degraded",
          artifact_path: "pdf_selection_map/manifest.json",
          reason: "selection shards are partial",
        },
      },
    });

    expect(SourceManifestV2Z.parse(manifest)).toEqual(manifest);
    expect(manifest.capabilities.project_lid_to_pdf.status).toBe("stale");
    expect(manifest.capabilities.resolve_pdf_selection.status).toBe("degraded");
  });
});
