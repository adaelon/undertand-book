import { describe, expect, it } from "vitest";
import { buildSourceManifest } from "../src/source-manifest";
import { SourceManifestZ } from "../src/zod";

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
