import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPaperReadingGuideProjection } from "../src/paper-reading-guide-verification";
import { buildSourceManifestV2 } from "../src/source-manifest";
import { emptyReconciliationSummary, sha256Text } from "../src/source-reconciliation";

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function paperWorkspace(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "understand-book-guide-verification-"));
  const source = "# Abstract\n\nThis paper studies evidence-aware retrieval.\n";
  const bookId = "paper-guide";
  const header = {
    book_id: bookId,
    book_version: "v1",
    profile_id: "paper",
    profile_version: "paper.research_article.v1",
    core_schema_version: "core_v0",
    generated_at: "2026-07-11T00:00:00.000Z",
  };
  writeFileSync(path.join(workspace, "source.txt"), source, "utf8");
  writeJson(path.join(workspace, "base.json"), {
    book_id: bookId,
    lid_nodes: [
      { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: source.length }, children: ["1.1"] },
      { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 12, end: source.length }, children: [] },
    ],
    graph_nodes: [],
    graph_edges: [],
  });
  writeJson(path.join(workspace, "source_manifest.json"), buildSourceManifestV2({
    book_id: bookId,
    source_sha256: sha256Text(source),
    original_pdf_path: "paper.pdf",
    original_pdf_sha256: "sha-pdf",
    pdf_source_map_path: "pdf_source_map.json",
    pdf_selection_map_manifest_path: "pdf_selection_map/manifest.json",
    alignment_report_path: "alignment_report.json",
    config_hash: "cfg-a",
  }));
  writeJson(path.join(workspace, ".build", "source-reconciliation", "report.json"), {
    version: "source_reconciliation_report.v1",
    book_id: bookId,
    input_fingerprint: { paper_md_sha256: "sha-md", paper_pdf_sha256: "sha-pdf", config_hash: "cfg-a" },
    summary: { ...emptyReconciliationSummary(), verified: 1 },
    unresolved: [],
  });
  writeJson(path.join(workspace, "paper_metadata.json"), {
    header,
    title: { value: "Evidence-aware retrieval", source: "paper_text", evidence_lids: ["1.1"] },
  });
  writeJson(path.join(workspace, "paper_lexicon.json"), {
    header,
    entries: [{ term: "evidence-aware retrieval", term_type: "paper_defined_term", occurrences_lids: ["1.1"] }],
  });
  writeJson(path.join(workspace, "book_structure.json"), {
    header,
    spine: [{ lid: "1", role: "setup", summary: { text: "Introduces retrieval.", evidence_lids: ["1.1"] }, key_stop_ids: ["stop-1"], depends_on: [] }],
    throughlines: [{ id: "thread-1", name: "Evidence", summary: { text: "Tracks evidence.", evidence_lids: ["1.1"] }, lids: ["1.1"], key_stop_ids: ["stop-1"] }],
    key_stops: [{ id: "stop-1", lid: "1.1", type: "claim", reason: { text: "States the paper focus.", evidence_lids: ["1.1"] } }],
  });
  return workspace;
}

describe("PaperReadingGuide TypeScript projection gate", () => {
  it("verifies the artifacts needed for an available paper projection", () => {
    const workspace = paperWorkspace();

    expect(verifyPaperReadingGuideProjection(workspace)).toMatchObject({
      available: true,
      book_id: "paper-guide",
      lid_count: 2,
      metadata_field_count: 1,
      lexicon_entry_count: 1,
      throughline_count: 1,
      key_stop_count: 1,
    });
  });

  it("rejects metadata evidence that Rust Book::load would reject", () => {
    const workspace = paperWorkspace();
    const metadata = JSON.parse(readFileSync(path.join(workspace, "paper_metadata.json"), "utf8"));
    metadata.title.evidence_lids = ["9.9"];
    writeJson(path.join(workspace, "paper_metadata.json"), metadata);

    expect(() => verifyPaperReadingGuideProjection(workspace)).toThrow("dangling LID");
  });
});
