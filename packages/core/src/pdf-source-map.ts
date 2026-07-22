export interface PdfPageRect {
  pageIndex: number;
  bbox: [number, number, number, number];
}

export interface PdfRegion extends PdfPageRect {
  region_id: string;
}

export interface PdfPageMeta {
  pageIndex: number;
  page_label?: string;
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  view: [number, number, number, number];
}

export interface PdfExcludedRegion {
  region_id: string;
  pageIndex: number;
  bbox: [number, number, number, number];
  reason: "header" | "footer" | "page_number" | "watermark" | "other";
}

export interface PdfSourceMapEntry {
  lid: string;
  source_span: { start: number; end: number };
  status: "word_mapped" | "line_fallback" | "block_fallback" | "unmapped" | "excluded";
  regions: PdfRegion[];
  primary_region?: PdfRegion;
  alignment: { confidence: number; reason?: string; trace_id?: string };
}

export interface PdfSourceMap {
  version: "pdf_source_map.v1";
  book_id: string;
  coordinate_system: {
    space: "pdf_user_space";
    origin: "bottom_left";
    unit: "pt";
    rotation_applied: false;
  };
  pages: PdfPageMeta[];
  entries: PdfSourceMapEntry[];
  excluded_regions: PdfExcludedRegion[];
  page_region_index: Record<string, string[]>;
  page_excluded_index: Record<string, string[]>;
  config_hash: string;
}

export interface PdfSelectionMapManifest {
  version: "pdf_selection_map.v1";
  book_id: string;
  coordinate_system: PdfSourceMap["coordinate_system"];
  config_hash: string;
  page_shards: Array<{
    pageIndex: number;
    page_label?: string;
    path: string;
    sha256: string;
  }>;
}

export interface PdfSelectionMapChar {
  char_index: number;
  text: string;
  rect: PdfPageRect;
  source_span: { start: number; end: number };
  lid?: string;
}

export interface PdfSelectionMapPageShard {
  version: "pdf_selection_map_page.v1";
  book_id: string;
  pageIndex: number;
  page_label?: string;
  chars: PdfSelectionMapChar[];
}

export type PdfProjectionPrecisionV2 = "char_exact" | "region_exact" | "partial" | "unmapped";

export interface PdfSourceMapEntryV2 {
  lid: string;
  source_span: { start: number; end: number };
  precision: PdfProjectionPrecisionV2;
  regions: PdfRegion[];
  exact_source_spans: Array<{ start: number; end: number }>;
  formula_display_text?: string;
  primary_region?: PdfRegion;
  alignment: { unit_id: string; reason: string; trace_id?: string };
}

export interface PdfSourceMapV2 {
  version: "pdf_source_map.v2";
  display_token_policy_version?: "pdf_display_token_policy.v1";
  book_id: string;
  coordinate_system: PdfSourceMap["coordinate_system"];
  pages: PdfPageMeta[];
  entries: PdfSourceMapEntryV2[];
  page_region_index: Record<string, string[]>;
  config_hash: string;
}

export interface PdfSelectionMapCharV2 {
  char_index: number;
  text: string;
  rect: PdfPageRect;
  source_span: { start: number; end: number };
  lid: string;
}

export interface PdfSelectionMapPageShardV2 {
  version: "pdf_selection_map_page.v2";
  book_id: string;
  pageIndex: number;
  page_label?: string;
  chars: PdfSelectionMapCharV2[];
}

export interface PdfSelectionMapManifestV2 {
  version: "pdf_selection_map.v2";
  book_id: string;
  coordinate_system: PdfSourceMap["coordinate_system"];
  config_hash: string;
  page_shards: Array<{
    pageIndex: number;
    page_label?: string;
    path: string;
    sha256: string;
  }>;
}

export function pdfUserSpaceCoordinateSystem(): PdfSourceMap["coordinate_system"] {
  return {
    space: "pdf_user_space",
    origin: "bottom_left",
    unit: "pt",
    rotation_applied: false,
  };
}
