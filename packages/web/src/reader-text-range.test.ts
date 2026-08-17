import { describe, expect, it } from "vitest";
import type { ManifestNode } from "./generated/ManifestNode";
import { splitUtf16Range } from "./reader-text-range";

function leaf(
  lid: string,
  start: number,
  end: number,
  kind: ManifestNode["kind"] = "paragraph",
): ManifestNode {
  return { lid, display_title: lid, children: [], span: { start, end }, kind };
}

function utf16Digest(value: string): string {
  return Array.from(
    { length: value.length },
    (_, index) => value.charCodeAt(index).toString(16).padStart(4, "0"),
  ).join("");
}

describe("splitUtf16Range", () => {
  it("losslessly splits ASCII, CJK, CRLF, emoji, whitespace gaps, and formula leaves", () => {
    const source = "ASCII\r\n  \u4e2d\u6587\ud83d\ude00 \n$E=mc^2$\r\n\u5c3e";
    const leaves = [
      leaf("1.1", 0, 5),
      leaf("1.2", 9, 13),
      leaf("1.3", 15, 23, "formula"),
      leaf("1.4", 25, 26),
    ];
    const singular = new Map([
      ["1.1", "ASCII"],
      ["1.2", "\u4e2d\u6587\ud83d\ude00"],
      ["1.3", "$E=mc^2$"],
      ["1.4", "\u5c3e"],
    ]);

    const split = splitUtf16Range({ lid: "1.1", text: source }, leaves);

    expect([...split.keys()]).toEqual(leaves.map((node) => node.lid));
    for (const node of leaves) {
      const ranged = split.get(node.lid);
      const single = singular.get(node.lid);
      expect(ranged).toBe(single);
      expect(ranged?.length).toBe(node.span.end - node.span.start);
      expect(utf16Digest(ranged ?? "")).toBe(utf16Digest(single ?? ""));
    }
  });

  it("accepts a single first/last leaf", () => {
    expect(splitUtf16Range(
      { lid: "1.1", text: "\ud83d\ude00" },
      [leaf("1.1", 20, 22)],
    )).toEqual(new Map([["1.1", "\ud83d\ude00"]]));
  });

  it.each([
    {
      label: "an empty request",
      reply: { lid: "1.1", text: "" },
      leaves: [],
    },
    {
      label: "a mismatched response identity",
      reply: { lid: "1.2", text: "AB" },
      leaves: [leaf("1.1", 0, 2)],
    },
    {
      label: "a mismatched response tail identity",
      reply: { lid: "1.1", end_lid: "1.3", text: "AB" },
      leaves: [leaf("1.1", 0, 1), leaf("1.2", 1, 2)],
    },
    {
      label: "a container node",
      reply: { lid: "1", text: "AB" },
      leaves: [{ ...leaf("1", 0, 2), children: ["1.1"] }],
    },
    {
      label: "duplicate LIDs",
      reply: { lid: "1.1", text: "AB" },
      leaves: [leaf("1.1", 0, 1), leaf("1.1", 1, 2)],
    },
    {
      label: "an invalid leaf span",
      reply: { lid: "1.1", text: "A" },
      leaves: [leaf("1.1", 1, 1)],
    },
    {
      label: "reverse leaf order",
      reply: { lid: "1.2", text: "AB" },
      leaves: [leaf("1.2", 1, 2), leaf("1.1", 0, 1)],
    },
    {
      label: "overlapping leaf spans",
      reply: { lid: "1.1", text: "ABC" },
      leaves: [leaf("1.1", 0, 2), leaf("1.2", 1, 3)],
    },
    {
      label: "a non-whitespace unowned gap",
      reply: { lid: "1.1", text: "AXB" },
      leaves: [leaf("1.1", 0, 1), leaf("1.2", 2, 3)],
    },
    {
      label: "a response with the wrong UTF-16 length",
      reply: { lid: "1.1", text: "A" },
      leaves: [leaf("1.1", 0, 2)],
    },
    {
      label: "a span that bisects a surrogate pair",
      reply: { lid: "1.1", text: "\ud83d\ude00" },
      leaves: [leaf("1.1", 0, 1), leaf("1.2", 1, 2)],
    },
  ])("fails closed for $label", ({ reply, leaves }) => {
    expect(() => splitUtf16Range(reply, leaves)).toThrow(/UTF-16 range/i);
  });
});
