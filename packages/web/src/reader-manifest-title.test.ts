import { describe, expect, it } from "vitest";
import type { ManifestNode } from "./generated/ManifestNode";
import {
  manifestChapterTitle,
  projectReaderManifestTitles,
} from "./reader-manifest-title";

function node(
  lid: string,
  displayTitle: string,
  kind: ManifestNode["kind"],
  children: string[] = [],
): ManifestNode {
  return {
    lid,
    display_title: displayTitle,
    children,
    span: { start: 0, end: 1 },
    kind,
  };
}

describe("reader Manifest title projection", () => {
  it("uses the same display_title for outline and chapter read position", () => {
    const tree = [
      node("1", "Deterministic chapter", "chapter", ["1.1"]),
      node("1.1", "Leaf text", "paragraph"),
      node("1.2", "Nested section", "section"),
    ];

    const projection = projectReaderManifestTitles(tree);

    expect(projection.outline).toEqual([
      { lid: "1", kind: "chapter", depth: 0, title: "Deterministic chapter" },
      { lid: "1.2", kind: "section", depth: 1, title: "Nested section" },
    ]);
    expect(manifestChapterTitle(projection.titleByLid, "1.1")).toBe("Deterministic chapter");
  });

  it("falls back to LID for an empty or absent top-level projection", () => {
    const projection = projectReaderManifestTitles([
      node("2", "", "chapter", ["2.1"]),
      node("2.1", "Leaf", "paragraph"),
    ]);

    expect(projection.outline[0]?.title).toBe("2");
    expect(manifestChapterTitle(projection.titleByLid, "2.1")).toBe("2");
    expect(manifestChapterTitle(projection.titleByLid, "9.1")).toBe("9");
  });
});
