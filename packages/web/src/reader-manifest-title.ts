import type { ManifestNode } from "./generated/ManifestNode";

export interface ReaderOutlineItem {
  lid: string;
  kind: ManifestNode["kind"];
  depth: number;
  title: string;
}

export interface ReaderManifestTitleProjection {
  titleByLid: Map<string, string>;
  outline: ReaderOutlineItem[];
}

function displayTitle(node: ManifestNode): string {
  return node.display_title || node.lid;
}

export function projectReaderManifestTitles(
  tree: readonly ManifestNode[],
): ReaderManifestTitleProjection {
  const titleByLid = new Map(tree.map((node) => [node.lid, displayTitle(node)]));
  const outline = tree
    .filter((node) => (
      node.children.length > 0 || node.kind === "chapter" || node.kind === "section"
    ))
    .map((node) => ({
      lid: node.lid,
      kind: node.kind,
      depth: Math.min(node.lid.split(".").length - 1, 4),
      title: titleByLid.get(node.lid) ?? node.lid,
    }));
  return { titleByLid, outline };
}

export function manifestChapterTitle(
  titleByLid: ReadonlyMap<string, string>,
  anchorLid: string,
): string {
  const top = anchorLid.split(".")[0] ?? anchorLid;
  return titleByLid.get(top) ?? top;
}
