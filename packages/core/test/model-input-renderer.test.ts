import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectRenderedModelInput,
  MODEL_INPUT_RENDER_CONTRACT_VERSION,
  renderBookStructureModelInput,
  renderModelInput,
  renderPaperLexiconModelInput,
  renderPaperMetadataModelInput,
  renderPass1ModelInput,
  renderPass2ModelInput,
  renderProfileSidecarModelInput,
} from "../src/model-input-renderer";
import type { BookStructureStitchPacket, BookStructureUnitSource } from "../src/book-structure";
import type { Pass2WorkPacket } from "../src/pass2-build";

describe("model input renderer", () => {
  it("preserves the Pass1 byte stream without adding a trailing newline", () => {
    const input = { text: "[1.1] first\n\n[1.2] second" };
    expect(renderPass1ModelInput(input)).toBe(input.text);
    expect(renderModelInput({ kind: "pass1_window", input })).toBe(input.text);
  });

  it("renders profile, metadata, and lexicon CLI documents with one frozen line contract", () => {
    const profile = {
      work_unit_id: "discourse-1-1",
      unit_kind: "profile_sidecar_discourse" as const,
      visible_lids: ["1.1"],
      formula_lids: [],
      text: "[1.1] Body",
    };
    expect(renderProfileSidecarModelInput(profile)).toBe([
      "PROFILE_SIDECAR_SEMANTIC_UNIT",
      "work_unit_id: discourse-1-1",
      "unit_kind: profile_sidecar_discourse",
      'visible_lids: ["1.1"]',
      "formula_lids: []",
      "",
      "TEXT",
      "[1.1] Body",
      "",
    ].join("\n"));

    const metadata = {
      window_id: 0,
      visible_lids: ["1.1"],
      signal_types: ["front_matter" as const],
      requested_fields: ["title"],
      text: "[1.1] A title",
    };
    expect(renderPaperMetadataModelInput(metadata)).toContain('signal_types: ["front_matter"]\n');
    expect(renderPaperMetadataModelInput(metadata).endsWith("[1.1] A title\n")).toBe(true);

    const lexicon = {
      work_unit_id: "lexicon-batch-test",
      route: {
        version: "paper_lexicon_packet_route.v1" as const,
        role: "direct" as const,
        cluster_keys: ["retrieval augmented generation"],
      },
      visible_lids: ["1.2"],
      requested_term_types: ["method_name" as const],
      candidate_clusters: [{
        version: "paper_lexicon_candidate_cluster.v1" as const,
        normalized_key: "retrieval augmented generation",
        surface_forms: ["RAG"],
        occurrence_lids: ["1.2"],
        definition_lids: ["1.2"],
        signals: ["explicit_term" as const],
        suggested_term_types: ["acronym" as const],
      }],
      source_slices: [{
        version: "model_input_slice.v1" as const,
        source_fingerprint: "a".repeat(64),
        parent_lid: "1.2",
        ordinal: 0,
        core_span_utf16: { start: 0, end: 3 },
        context_span_utf16: { start: 0, end: 3 },
        boundary_kind: "whole_lid" as const,
        core_sha256: "b".repeat(64),
        context_sha256: "b".repeat(64),
      }],
      reduction_children: [],
      text: "[1.2] RAG",
    };
    expect(renderPaperLexiconModelInput(lexicon)).toContain("candidate_clusters: [{");
    expect(renderPaperLexiconModelInput(lexicon)).toContain("source_slices: [{");
    expect(renderPaperLexiconModelInput(lexicon).endsWith("[1.2] RAG\n")).toBe(true);
  });

  it("uses the same pretty-JSON bytes for Pass2 and both BookStructure input kinds", () => {
    const pass2: Pass2WorkPacket = {
      packet_id: "pass2-window:0",
      source_window: { index: 0, leaf_lids: ["1.1"], title_path: ["1"], text: [{ lid: "1.1", text: "Body" }] },
      source_nodes: [],
      source_discourse: [],
      source_formula_semantics: [],
      candidate_targets: [],
      edge_type_contracts: {},
    };
    expect(renderPass2ModelInput(pass2)).toBe(`${JSON.stringify(pass2, null, 2)}\n`);

    const unit: BookStructureUnitSource = {
      job_id: "unit:1.1",
      unit_lid: "1.1",
      unit_kind: "paragraph",
      title_path: ["1"],
      leaf_lids: ["1.1"],
      excerpts: [{ lid: "1.1", text: "Body" }],
      graph_nodes: [],
      graph_edges: [],
      discourse_items: [],
      formula_semantics: [],
      pass2_edges: [],
    };
    const stitch: BookStructureStitchPacket = { job_id: "stitch", unit_cards: [], long_range_edges: [] };
    expect(renderBookStructureModelInput(unit)).toBe(`${JSON.stringify(unit, null, 2)}\n`);
    expect(renderModelInput({ kind: "structure_stitch", input: stitch })).toBe(`${JSON.stringify(stitch, null, 2)}\n`);
  });

  it("reports the exact UTF-8 bytes, hash, estimator value, and render contract", () => {
    const rendered = inspectRenderedModelInput({ kind: "pass1_window", input: { text: "你好abcd" } });
    expect(rendered).toMatchObject({
      version: "rendered_model_input.v1",
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
      byte_length: Buffer.byteLength("你好abcd", "utf8"),
      estimated_tokens: 3,
    });
    expect(rendered.sha256).toBe(createHash("sha256").update(rendered.text).digest("hex"));
  });
});
