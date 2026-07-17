import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HYBRID_FOUNDATION_ARTIFACT_PATHS,
  applyHybridFoundationArtifactSet,
  hybridFoundationArtifactSetDigest,
  mergeHybridFoundationBase,
  recoverHybridFoundationArtifactApplications,
  semanticGraphDigest,
} from "../src/hybrid-foundation-apply";
import type { ReadOnlyBase } from "../src/generated/ReadOnlyBase";

function base(): ReadOnlyBase {
  return {
    book_id: "paper-a",
    lid_nodes: [
      { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 20 }, children: ["1.1"] },
      { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 1, end: 20 }, children: [] },
    ],
    graph_nodes: [
      {
        id: "concept:alpha",
        type: "concept",
        name: "Alpha",
        occurrences: ["1.1"],
        source_lid: null,
      },
      {
        id: "claim:1.1:result",
        type: "claim",
        name: "Result",
        occurrences: [],
        source_lid: "1.1",
      },
    ],
    graph_edges: [
      {
        source: "concept:alpha",
        target: "claim:1.1:result",
        type: "supports",
        direction: "directed",
        scope: "local",
        weight: 1,
      },
    ],
  };
}

describe("hybrid foundation semantic graph ownership", () => {
  it("keeps the official semantic graph while adopting same-identity candidate LIDs", () => {
    const official = base();
    const candidate = base();
    candidate.lid_nodes[1] = {
      ...candidate.lid_nodes[1],
      span: { start: 2, end: 21 },
    };
    candidate.graph_nodes = [];
    candidate.graph_edges = [];

    const merged = mergeHybridFoundationBase(official, candidate);

    expect(merged.lid_nodes).toEqual(candidate.lid_nodes);
    expect(merged.graph_nodes).toEqual(official.graph_nodes);
    expect(merged.graph_edges).toEqual(official.graph_edges);
    expect(semanticGraphDigest(merged)).toBe(semanticGraphDigest(official));
  });

  it("rejects a candidate with different LID identity", () => {
    const official = base();
    const candidate = base();
    candidate.lid_nodes[1] = { ...candidate.lid_nodes[1], lid: "1.2", path: [1, 2] };

    expect(() => mergeHybridFoundationBase(official, candidate)).toThrow(/LID identity/i);
  });

  it("rejects dangling graph anchors and edge endpoints before staging", () => {
    const danglingAnchor = base();
    danglingAnchor.graph_nodes[0] = { ...danglingAnchor.graph_nodes[0], occurrences: ["9.9"] };
    expect(() => mergeHybridFoundationBase(danglingAnchor, base())).toThrow(/graph anchor/i);

    const danglingEdge = base();
    danglingEdge.graph_edges[0] = { ...danglingEdge.graph_edges[0], target: "claim:missing" };
    expect(() => mergeHybridFoundationBase(danglingEdge, base())).toThrow(/graph edge endpoint/i);
  });
});

function artifactFixture(): string {
  return mkdtempSync(path.join(os.tmpdir(), "hybrid-foundation-apply-"));
}

function writeArtifactSet(root: string, marker: "old" | "new"): void {
  mkdirSync(path.join(root, "pdf_selection_map", "pages"), { recursive: true });
  writeFileSync(path.join(root, "base.json"), JSON.stringify(base(), null, 2), "utf8");
  writeFileSync(path.join(root, "source.txt"), marker, "utf8");
  for (const relativePath of [
    "source_manifest.json",
    "pdf_source_map.json",
    "alignment_report.json",
    "pdf_selection_map/manifest.json",
    "pdf_selection_map/pages/0.json",
  ]) {
    writeFileSync(path.join(root, relativePath), JSON.stringify({ marker }, null, 2), "utf8");
  }
}

function validateArtifactSet(root: string): void {
  const marker = readFileSync(path.join(root, "source.txt"), "utf8");
  if (marker !== "old" && marker !== "new") throw new Error("fixture source marker is invalid");
  for (const relativePath of [
    "source_manifest.json",
    "pdf_source_map.json",
    "alignment_report.json",
    "pdf_selection_map/manifest.json",
    "pdf_selection_map/pages/0.json",
  ]) {
    const value = JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as { marker?: string };
    if (value.marker !== marker) throw new Error(`fixture artifact set is mixed: ${relativePath}`);
  }
}

function officialAndCandidate(): { root: string; book: string; candidate: string; oldDigest: string } {
  const root = artifactFixture();
  const book = path.join(root, "book");
  const candidate = path.join(root, "candidate");
  mkdirSync(book, { recursive: true });
  mkdirSync(candidate, { recursive: true });
  writeArtifactSet(book, "old");
  writeArtifactSet(candidate, "new");
  return { root, book, candidate, oldDigest: hybridFoundationArtifactSetDigest(book) };
}

describe("hybrid foundation atomic artifact application", () => {
  it("rolls every destructive rename and official validation failure back to the exact old set", () => {
    const failurePoints = [
      "after_prepare",
      ...HYBRID_FOUNDATION_ARTIFACT_PATHS.map((item) => `after_move_old:${item}`),
      ...HYBRID_FOUNDATION_ARTIFACT_PATHS.map((item) => `after_move_new:${item}`),
      "before_validate_official",
      "after_validate_official",
    ];

    for (const target of failurePoints) {
      const fixture = officialAndCandidate();
      expect(() => applyHybridFoundationArtifactSet({
        book_dir: fixture.book,
        candidate_dir: fixture.candidate,
        validate_artifact_set: validateArtifactSet,
        transaction_id: `fault-${failurePoints.indexOf(target)}`,
        fault_injector: (point) => {
          if (point === target) throw new Error(`injected failure at ${point}`);
        },
      }), target).toThrow(/injected failure/);
      expect(hybridFoundationArtifactSetDigest(fixture.book), target).toBe(fixture.oldDigest);
      expect(semanticGraphDigest(JSON.parse(readFileSync(path.join(fixture.book, "base.json"), "utf8")))).toBe(
        semanticGraphDigest(base()),
      );
      expect(existsSync(path.join(fixture.book, ".build", "hybrid-foundation-apply.lock"))).toBe(false);
    }
  }, 30_000);

  it("rejects an invalid candidate before moving any official artifact", () => {
    const fixture = officialAndCandidate();
    writeFileSync(path.join(fixture.candidate, "alignment_report.json"), JSON.stringify({ marker: "old" }), "utf8");

    expect(() => applyHybridFoundationArtifactSet({
      book_dir: fixture.book,
      candidate_dir: fixture.candidate,
      validate_artifact_set: validateArtifactSet,
      transaction_id: "invalid-candidate",
    })).toThrow(/mixed/);
    expect(hybridFoundationArtifactSetDigest(fixture.book)).toBe(fixture.oldDigest);
  });

  it("rolls back when validation rejects the complete new official set", () => {
    const fixture = officialAndCandidate();
    expect(() => applyHybridFoundationArtifactSet({
      book_dir: fixture.book,
      candidate_dir: fixture.candidate,
      validate_artifact_set: (root) => {
        validateArtifactSet(root);
        if (path.resolve(root) === path.resolve(fixture.book)
          && readFileSync(path.join(root, "source.txt"), "utf8") === "new") {
          throw new Error("injected official validation rejection");
        }
      },
      transaction_id: "validation-rejection",
    })).toThrow(/validation rejection/);
    expect(hybridFoundationArtifactSetDigest(fixture.book)).toBe(fixture.oldDigest);
  });

  it("recovers an interrupted mixed set on the next startup", () => {
    const fixture = officialAndCandidate();
    expect(() => applyHybridFoundationArtifactSet({
      book_dir: fixture.book,
      candidate_dir: fixture.candidate,
      validate_artifact_set: validateArtifactSet,
      transaction_id: "startup-recovery",
      recover_on_error: false,
      fault_injector: (point) => {
        if (point === "after_move_new:source.txt") throw new Error("simulated process exit");
      },
    })).toThrow(/simulated process exit/);
    expect(() => validateArtifactSet(fixture.book)).toThrow();

    const recovered = recoverHybridFoundationArtifactApplications({
      book_dir: fixture.book,
      validate_artifact_set: validateArtifactSet,
    });

    expect(recovered).toEqual([{ transaction_id: "startup-recovery", outcome: "rolled_back" }]);
    expect(hybridFoundationArtifactSetDigest(fixture.book)).toBe(fixture.oldDigest);
  });

  it("finishes a validated transaction as the new set and makes repeat apply idempotent", () => {
    const fixture = officialAndCandidate();
    expect(() => applyHybridFoundationArtifactSet({
      book_dir: fixture.book,
      candidate_dir: fixture.candidate,
      validate_artifact_set: validateArtifactSet,
      transaction_id: "validated-crash",
      recover_on_error: false,
      fault_injector: (point) => {
        if (point === "after_mark_validated") throw new Error("simulated exit after validation");
      },
    })).toThrow(/after validation/);

    expect(recoverHybridFoundationArtifactApplications({
      book_dir: fixture.book,
      validate_artifact_set: validateArtifactSet,
    })).toEqual([{ transaction_id: "validated-crash", outcome: "committed" }]);
    const newDigest = hybridFoundationArtifactSetDigest(fixture.book);
    expect(newDigest).toBe(hybridFoundationArtifactSetDigest(fixture.candidate));
    expect(semanticGraphDigest(JSON.parse(readFileSync(path.join(fixture.book, "base.json"), "utf8")))).toBe(
      semanticGraphDigest(base()),
    );

    const repeated = applyHybridFoundationArtifactSet({
      book_dir: fixture.book,
      candidate_dir: fixture.candidate,
      validate_artifact_set: validateArtifactSet,
      transaction_id: "repeat",
    });
    expect(repeated.status).toBe("already_current");
    expect(hybridFoundationArtifactSetDigest(fixture.book)).toBe(newDigest);
    expect(existsSync(path.join(
      fixture.book,
      ".build",
      "hybrid-foundation-transactions",
      "repeat",
    ))).toBe(false);
  });

  it("holds a per-book lock across the apply transaction", () => {
    const fixture = officialAndCandidate();
    let nestedError = "";
    applyHybridFoundationArtifactSet({
      book_dir: fixture.book,
      candidate_dir: fixture.candidate,
      validate_artifact_set: validateArtifactSet,
      transaction_id: "outer",
      fault_injector: (point) => {
        if (point !== "after_prepare") return;
        try {
          applyHybridFoundationArtifactSet({
            book_dir: fixture.book,
            candidate_dir: fixture.candidate,
            validate_artifact_set: validateArtifactSet,
            transaction_id: "inner",
          });
        } catch (error) {
          nestedError = error instanceof Error ? error.message : String(error);
        }
      },
    });
    expect(nestedError).toMatch(/already locked/i);
    expect(readFileSync(path.join(fixture.book, "source.txt"), "utf8")).toBe("new");
  });
});
