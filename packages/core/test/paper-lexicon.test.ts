import { describe, expect, it } from "vitest";
import type { LidNode } from "../src/generated/LidNode";
import { buildProfileArtifactHeader } from "../src/profile-artifact";
import {
  buildPaperLexiconArtifact,
  buildPaperLexiconSidecar,
  buildPaperLexiconWindowInput,
  computePaperLexiconStatus,
} from "../src/paper-lexicon";
import { PaperLexiconZ } from "../src/zod";
import type { Window } from "../src/window";

const lids: LidNode[] = [
  { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 100 }, children: ["1.1", "1.2"] },
  { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 0, end: 40 }, children: [] },
  { lid: "1.2", path: [1, 2], kind: "paragraph", span: { start: 41, end: 90 }, children: [] },
];
const byLid = new Map(lids.map((node) => [node.lid, node]));
const header = buildProfileArtifactHeader({
  book_id: "paper-a",
  content_profile: "paper",
  generated_at: "2026-07-05T00:00:00.000Z",
});
const window0: Window = {
  id: 0,
  leafLids: ["1.1", "1.2"],
  tokens: 20,
  spans: [{ start: 0, end: 90 }],
  overBudget: false,
};

describe("PP3 paper lexicon", () => {
  it("materializes a headered lexicon with anchored term entries", () => {
    const sidecar = buildPaperLexiconSidecar(
      header,
      [
        {
          term: "Retrieval-Augmented Generation",
          term_type: "method_name",
          occurrences_lids: ["1.1", "1.2"],
          aliases: ["RAG"],
          acronym_expansion: "Retrieval-Augmented Generation",
          chinese_gloss: "检索增强生成",
        },
      ],
      lids,
    );

    PaperLexiconZ.parse(sidecar);
    expect(sidecar.header.profile_id).toBe("paper");
    expect(sidecar.entries[0].occurrences_lids).toEqual(["1.1", "1.2"]);
  });

  it("merges duplicate terms and preserves explicit definition anchors", () => {
    const sidecar = buildPaperLexiconSidecar(
      header,
      [
        { term: "RAG", term_type: "acronym", occurrences_lids: ["1.1"], defined_at_lid: "1.1", acronym_expansion: "Retrieval-Augmented Generation" },
        { term: "rag", term_type: "acronym", occurrences_lids: ["1.2"], aliases: ["retrieval augmented generation"] },
      ],
      lids,
    );

    expect(sidecar.entries).toHaveLength(1);
    expect(sidecar.entries[0]).toMatchObject({
      term: "RAG",
      defined_at_lid: "1.1",
      occurrences_lids: ["1.1", "1.2"],
    });
  });

  it("rejects missing occurrences, dangling LIDs, and definitions outside occurrences", () => {
    expect(() =>
      buildPaperLexiconSidecar(header, [{ term: "RAG", term_type: "acronym", occurrences_lids: [] }], lids),
    ).toThrow("occurrences_lids is required");
    expect(() =>
      buildPaperLexiconSidecar(header, [{ term: "RAG", term_type: "acronym", occurrences_lids: ["9.9"] }], lids),
    ).toThrow("dangling LID");
    expect(() =>
      buildPaperLexiconSidecar(header, [{ term: "RAG", term_type: "acronym", occurrences_lids: ["1.2"], defined_at_lid: "1.1" }], lids),
    ).toThrow("defined_at_lid must also appear");
  });

  it("rejects unsupported term types instead of accepting ordinary words", () => {
    expect(() =>
      buildPaperLexiconSidecar(
        header,
        [{ term: "demonstrate", term_type: "ordinary_word" as never, occurrences_lids: ["1.1"] }],
        lids,
      ),
    ).toThrow("term_type is invalid");
  });

  it("builds resumable window artifacts and status from content hashes", () => {
    const source = "RAG is defined here.\nRAG appears again.";
    const input = buildPaperLexiconWindowInput(window0, byLid, source);
    expect(input.requested_term_types).toContain("paper_defined_term");

    const artifact = buildPaperLexiconArtifact(window0, byLid, source, {
      entries: [{ term: "RAG", term_type: "acronym", occurrences_lids: ["1.1"], defined_at_lid: "1.1" }],
    });
    const status = computePaperLexiconStatus(
      [window0],
      byLid,
      source,
      new Map([[0, { content_hash: artifact.content_hash }]]),
    );

    expect(status).toEqual({ done: [0], pending: [] });
    expect(artifact.entries[0].term).toBe("RAG");
  });
});
