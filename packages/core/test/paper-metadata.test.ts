import { describe, expect, it } from "vitest";
import type { LidNode } from "../src/generated/LidNode";
import { buildProfileArtifactHeader } from "../src/profile-artifact";
import {
  buildPaperMetadataArtifact,
  buildPaperMetadataSidecar,
  buildPaperMetadataWindowInput,
  computePaperMetadataStatus,
  type PaperMetadataFields,
} from "../src/paper-metadata";
import { PaperMetadataZ } from "../src/zod";
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

describe("PP2 paper metadata", () => {
  it("materializes headered metadata fields with MetadataField envelopes", () => {
    const sidecar = buildPaperMetadataSidecar(
      header,
      [
        {
          title: { value: "A Paper", source: "front_matter", evidence_lids: ["1.1"], confidence: 0.99 },
          authors: { value: [{ name: "Ada Lovelace", raw: "Lovelace, A." }], source: "front_matter", evidence_lids: ["1.1"] },
          year: { value: 2026, source: "paper_text", evidence_lids: ["1.1"] },
          identifiers: { doi: { value: "10.1234/example", source: "paper_text", evidence_lids: ["1.2"] } },
          references: { value: [{ raw: "Smith 2020" }], source: "paper_text", evidence_lids: ["1.2"] },
        },
      ],
      lids,
    );

    PaperMetadataZ.parse(sidecar);
    expect(sidecar.header.profile_id).toBe("paper");
    expect(sidecar.title?.source).toBe("front_matter");
    expect(sidecar.identifiers?.doi?.evidence_lids).toEqual(["1.2"]);
  });

  it("merges array fields but keeps scalar fields deterministic first-wins", () => {
    const sidecar = buildPaperMetadataSidecar(
      header,
      [
        {
          title: { value: "First title", source: "front_matter", evidence_lids: ["1.1"] },
          keywords: { value: ["retrieval", "reading"], source: "paper_text", evidence_lids: ["1.1"] },
        },
        {
          title: { value: "Second title", source: "paper_text", evidence_lids: ["1.2"] },
          keywords: { value: ["reading", "metadata"], source: "paper_text", evidence_lids: ["1.2"] },
        },
      ],
      lids,
    );

    expect(sidecar.title?.value).toBe("First title");
    expect(sidecar.keywords?.value).toEqual(["retrieval", "reading", "metadata"]);
    expect(sidecar.keywords?.evidence_lids).toEqual(["1.1", "1.2"]);
  });

  it("rejects bare metadata values and text-derived fields without LID evidence", () => {
    expect(() => buildPaperMetadataSidecar(header, [{ title: "Bare title" } as unknown as PaperMetadataFields], lids)).toThrow(
      "MetadataField envelope",
    );
    expect(() =>
      buildPaperMetadataSidecar(header, [{ title: { value: "A Paper", source: "paper_text" } } as PaperMetadataFields], lids),
    ).toThrow("evidence_lids is required");
  });

  it("rejects dangling evidence LIDs", () => {
    expect(() =>
      buildPaperMetadataSidecar(
        header,
        [{ datasets: { value: ["Dataset A"], source: "paper_text", evidence_lids: ["9.9"] } }],
        lids,
      ),
    ).toThrow("dangling LID");
  });

  it("builds resumable window artifacts and status from content hashes", () => {
    const source = "Title and authors.\nMethod uses Dataset A.";
    const input = buildPaperMetadataWindowInput(window0, byLid, source);
    expect(input.requested_fields).toContain("identifiers.doi");
    expect(input.visible_lids).toEqual(["1.1", "1.2"]);

    const artifact = buildPaperMetadataArtifact(window0, byLid, source, {
      paper_metadata: {
        title: { value: "A Paper", source: "front_matter", evidence_lids: ["1.1"] },
      },
    });
    const status = computePaperMetadataStatus(
      [window0],
      byLid,
      source,
      new Map([[0, { content_hash: artifact.content_hash }]]),
    );

    expect(status).toEqual({ done: [0], pending: [] });
    expect(artifact.metadata.title?.value).toBe("A Paper");
  });
});
