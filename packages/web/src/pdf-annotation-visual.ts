import { createApp, h } from "vue";
import type { MemoryRecord, PdfSourceMap, SourceManifestV2 } from "./api";
import PdfReaderPane from "./components/PdfReaderPane.vue";
import { renderMarkdown } from "./md";
import type { PdfUserAnnotationProjection } from "./pdf-annotation-projection";
import "./style.css";

const sourceMap: PdfSourceMap = {
  version: "pdf_source_map.v1",
  book_id: "annotation-visual",
  coordinate_system: {
    space: "pdf_user_space",
    origin: "bottom_left",
    unit: "pt",
    rotation_applied: false,
  },
  pages: [{
    pageIndex: 0,
    page_label: "1",
    width: 600,
    height: 800,
    rotate: 0,
    view: [0, 0, 600, 800],
  }],
  entries: [{
    lid: "1.1",
    source_span: { start: 0, end: 20 },
    status: "word_mapped",
    regions: [{ region_id: "automatic-region", pageIndex: 0, bbox: [40, 40, 560, 760] }],
    primary_region: { region_id: "automatic-region", pageIndex: 0, bbox: [40, 40, 560, 760] },
    alignment: { confidence: 1 },
  }],
  excluded_regions: [],
  page_region_index: { "0": ["automatic-region"] },
  page_excluded_index: {},
  config_hash: "annotation-visual-v1",
};

const sourceManifest: SourceManifestV2 = {
  version: "source_manifest.v2",
  book_id: "PDF 用户标注验收",
  canonical_source: {
    kind: "reconciled_markdown",
    path: "source.txt",
    citation_anchor: "lid",
    sha256: "source",
  },
  original_pdf: { path: "visual.pdf", sha256: "pdf", citation_anchor: false },
  capabilities: {
    view_pdf: { status: "available" },
    project_lid_to_pdf: { status: "available" },
    resolve_pdf_selection: { status: "available" },
    project_ranges_to_pdf: { status: "available" },
  },
};

function note(memId: string, content: string): MemoryRecord {
  return {
    mem_id: memId,
    type: "note",
    layer: "long_term",
    book_id: "annotation-visual",
    anchor: { lid: "1.1", concept: null },
    content,
    selection_context: {
      status: "resolved",
      raw_quote: "PDF selection",
      resolved_quote: "PDF selection",
      ranges: [{ lid: "1.1", range: { start: 10, end: 13 } }],
    },
  };
}

const noteA = note("note-a", "> PDF selection\n\n第一条精确定位笔记。内容用于检查桌面浮层与移动端底部面板。 ");
const noteB = note("note-b", "> PDF selection\n\n第二条同锚点笔记，用于验证聚合数量。 ");
const noteC = note("note-c", "> Nearby selection\n\n邻近锚点不会覆盖前一个 marker。 ");
const highlight: MemoryRecord = {
  mem_id: "highlight-a",
  type: "highlight",
  layer: "long_term",
  book_id: "annotation-visual",
  anchor: { lid: "1.1", concept: null },
  content: "Exact projected user highlight",
  range: { start: 0, end: 9 },
};

const annotationProjection: PdfUserAnnotationProjection = {
  highlights: [{
    mem_id: highlight.mem_id,
    record: highlight,
    rects: [
      { pageIndex: 0, bbox: [92, 690, 260, 710] },
      { pageIndex: 0, bbox: [92, 662, 210, 682] },
    ],
  }],
  note_markers: [
    {
      terminal_key: "0:1.1:10:13",
      anchor_rect: { pageIndex: 0, bbox: [558, 42, 570, 58] },
      notes: [noteA, noteB],
    },
    {
      terminal_key: "0:1.1:14:16",
      anchor_rect: { pageIndex: 0, bbox: [560, 45, 572, 61] },
      notes: [noteC],
    },
  ],
  location_by_mem_id: {
    "highlight-a": "exact",
    "note-a": "exact",
    "note-b": "exact",
    "note-c": "exact",
  },
};

createApp({
  render: () => h(PdfReaderPane, {
    sourceManifest,
    sourceMap,
    pdfUrl: "/missing-annotation-visual.pdf",
    activeLid: null,
    selectedLid: null,
    annotationProjection,
    renderMarkdown,
  }),
}).mount("#app");
