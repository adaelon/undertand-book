import type { FormulaSemantics, ImageAssetManifestEntry, Manifest } from "./api";

export type ReaderNodeKind = Manifest["tree"][number]["kind"];

export interface ReaderSegment {
  lid: string;
  text: string;
  kind: ReaderNodeKind;
  formula: FormulaSemantics | null;
  imageAsset: ImageAssetManifestEntry | null;
}
