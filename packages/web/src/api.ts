// 类型化命令面 REST 客户端 `[ADR-0028]`:前端经 `/api` dev proxy 打到 tiny_http。
// 端点名 = 命令名;book.*→GET、reader.*/memory.*/book.query→POST;错误透传 §4.4 信封。
import type { Manifest } from "./generated/Manifest";
import type { QueryResponse } from "./generated/QueryResponse";
import type { ToolError } from "./generated/ToolError";
import type { OuterOutcome } from "./generated/OuterOutcome";
import type { AgentEffect } from "./generated/AgentEffect";
import type { TraceStep } from "./generated/TraceStep";
import type { ProfileManifest } from "./generated/ProfileManifest";
import type { ProfileSummary } from "./generated/ProfileSummary";
import type { ReaderLayoutAction } from "./generated/ReaderLayoutAction";
import type { ReaderLayoutApplyOutcome } from "./generated/ReaderLayoutApplyOutcome";
import type { ReaderLayoutProposal } from "./generated/ReaderLayoutProposal";
import type { ReaderLayoutState } from "./generated/ReaderLayoutState";
import type { PaperReadingGuide } from "./generated/PaperReadingGuide";
import type { PaperReadingMode } from "./generated/PaperReadingMode";
import type { PaperReadingStage } from "./generated/PaperReadingStage";
import type { PaperMetadataProjection } from "./generated/PaperMetadataProjection";
import type { PaperLexiconProjection } from "./generated/PaperLexiconProjection";
import type { StructureProjection } from "./generated/StructureProjection";

export type {
  Manifest,
  QueryResponse,
  OuterOutcome,
  AgentEffect,
  TraceStep,
  ProfileManifest,
  ProfileSummary,
  ReaderLayoutAction,
  ReaderLayoutApplyOutcome,
  ReaderLayoutProposal,
  ReaderLayoutState,
  PaperReadingGuide,
  PaperReadingMode,
  PaperReadingStage,
  PaperMetadataProjection,
  PaperLexiconProjection,
  StructureProjection,
};

const BASE = "/api";

/** reader.* 会话态(符 V3 §4.2),与 Rust `Viewport`/`ReaderState` 对齐(memory 类型未走 ts-rs,在此手定)。 */
export interface Viewport {
  anchor_lid: string;
  top_lid: string;
  bottom_lid: string;
  width: number;
  visible_lids: string[];
}
export interface ViewportEffect {
  ok: boolean;
  viewport: Viewport;
}
export interface ReaderState {
  viewport: Viewport;
  open_panels: string[];
  selection: string | null;
  layout: ReaderLayoutState;
  profile: ProfileSummary;
}
export interface HighlightEffect {
  ok: boolean;
  highlight_id: string;
}
export interface NoteEffect {
  ok: boolean;
  note_id: string;
}
/** 段内字符区间(高亮选区,UTF-16 偏移,相对该 LID 文本)`[ADR-0031]`。 */
export interface TextRange {
  start: number;
  end: number;
}
/** memory 记录(符 V3 §4.3;JSON 字段 `type` = Rust mem_type 的 serde rename)。 */
export interface MemoryRecord {
  mem_id: string;
  type: string;
  layer: string;
  book_id: string;
  anchor: { lid?: string | null; concept?: string | null };
  content: string;
  range?: TextRange | null; // 高亮段内区间;note / 整段高亮为空 `[ADR-0031]`
  source_session_id?: string | null;
}
export interface BookText {
  lid: string;
  text: string;
}
export interface ImageAssetManifestEntry {
  kind: "image";
  lid: string;
  alt: string;
  original_src: string;
  source: "markdown" | "epub" | "data_uri";
  status: "available" | "missing" | "external" | "unsupported";
  stored_path: string | null;
  url_path: string | null;
  mime: string | null;
  sha256: string | null;
  size_bytes: number | null;
  warning: string | null;
}
export interface AssetManifest {
  version: "asset_manifest.v1";
  book_id: string;
  images: ImageAssetManifestEntry[];
}
export interface BookLibraryEntry {
  name: string;
  book_id: string;
  dir: string;
}
export interface BookLibraryResponse {
  root: string;
  books: BookLibraryEntry[];
}
export type PdfCapabilityStatus = "unavailable" | "available" | "degraded" | "stale" | "failed";
export interface PdfCapability {
  status: PdfCapabilityStatus;
  reason?: string;
  artifact_path?: string;
  report_path?: string;
  config_hash?: string;
}
export interface SourceManifestV2 {
  version: "source_manifest.v2";
  book_id: string;
  canonical_source: {
    kind: "reconciled_markdown";
    path: "source.txt";
    citation_anchor: "lid";
    sha256: string;
  };
  original_pdf?: {
    path: string;
    sha256: string;
    fingerprint?: string;
    citation_anchor: false;
  };
  capabilities: {
    view_pdf: PdfCapability;
    project_lid_to_pdf: PdfCapability;
    resolve_pdf_selection: PdfCapability;
    project_ranges_to_pdf: PdfCapability;
  };
}
export interface PdfPageRect {
  pageIndex: number;
  bbox: [number, number, number, number];
}
export interface PdfRegion extends PdfPageRect {
  region_id: string;
}
export interface PdfSourceMapEntry {
  lid: string;
  source_span: TextRange;
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
  pages: Array<{
    pageIndex: number;
    page_label?: string;
    width: number;
    height: number;
    rotate: 0 | 90 | 180 | 270;
    view: [number, number, number, number];
  }>;
  entries: PdfSourceMapEntry[];
  excluded_regions: PdfRegion[];
  page_region_index: Record<string, string[]>;
  page_excluded_index: Record<string, string[]>;
  config_hash: string;
}
export interface PdfSelectionResolveResponse {
  status: "resolved" | "partial" | "unresolved";
  ranges: Array<{
    lid: string;
    range: TextRange;
    source_span: TextRange;
    quote_markdown: string;
  }>;
  quote_markdown: string;
}
export interface PdfRangesProjectResponse {
  projections: Array<{
    lid: string;
    range?: TextRange | null;
    status: "exact" | "lid_region_fallback" | "unmapped";
    source_span?: TextRange | null;
    primary_region?: PdfRegion | null;
    regions: PdfRegion[];
  }>;
}
export interface FormulaParameter {
  symbol: string;
  label: string | null;
  meaning: string;
  unit: string | null;
  domain: string | null;
  evidence_lids: string[];
}
export interface FormulaComposition {
  source_lid: string;
  meaning: string;
  terms: string[];
  evidence_lids: string[];
}
export interface FormulaContextLink {
  target_lid: string;
  relation: string;
  description: string;
  evidence_lids: string[];
}
export interface FormulaSemantics {
  formula_lid: string;
  parameters: FormulaParameter[];
  composition: FormulaComposition;
  context_links: FormulaContextLink[];
}
export interface AskQuote {
  lid: string;
  quote: string;
}
export interface AgentChatTurn {
  user: string;
  outcome: OuterOutcome;
  question_anchor_lid: string | null;
  question_quote: AskQuote | null;
}
export interface AgentChatTurnSummary {
  user: string;
  question_anchor_lid: string | null;
  question_quote: AskQuote | null;
}
export interface AgentChatSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
  turns: AgentChatTurnSummary[];
}
export interface AgentChatSession {
  id: string;
  book_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: AgentChatTurn[];
}
export interface AgentHistoryResponse {
  active_session_id: string;
  sessions: AgentChatSessionSummary[];
  current: AgentChatSession;
}
export interface AgentChatMeta {
  display_user?: string;
  question_anchor_lid?: string | null;
  question_quote?: AskQuote | null;
}

/** 携带 §4.4 分类信封的错误(category/error_code 供 UI 分流瞬时 vs 永久)。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string,
    public category: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function http<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const raw = await res.text();
  const json: unknown = raw ? JSON.parse(raw) : null;
  if (!res.ok) {
    const e = json as ToolError | null;
    throw new ApiError(
      res.status,
      e?.error_code ?? `HTTP_${res.status}`,
      e?.category ?? "internal",
      e?.message ?? raw,
    );
  }
  return json as T;
}

function qs(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((kv): kv is [string, string] => kv[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export const api = {
  // ── book.*(只读 GET)──
  manifest: () => http<Manifest>("GET", "/book/manifest"),
  bookLibrary: () => http<BookLibraryResponse>("GET", "/book/library"),
  assetManifest: () => http<AssetManifest>("GET", "/book/asset_manifest"),
  sourceManifest: () => http<SourceManifestV2>("GET", "/book/source_manifest"),
  pdfSourceMap: () => http<PdfSourceMap>("GET", "/book/pdf_source_map"),
  pdfOriginalUrl: () => `${BASE}/book/pdf/original`,
  profileManifest: (profile_id?: "technical_learning" | "paper") =>
    http<ProfileManifest>("GET", `/profile/manifest${qs({ profile_id })}`),
  text: (lid: string, end?: string) =>
    http<BookText>("GET", `/book/text${qs({ lid, end })}`),
  structure: (at?: string) => http<StructureProjection>("GET", `/book/structure${qs({ at })}`),
  paperReadingGuide: (mode?: PaperReadingMode, stage?: PaperReadingStage) =>
    http<PaperReadingGuide>("GET", `/book/paper_reading_guide${qs({ mode, stage })}`),
  paperMetadata: () => http<PaperMetadataProjection>("GET", "/book/paper_metadata"),
  paperLexicon: () => http<PaperLexiconProjection>("GET", "/book/paper_lexicon"),
  formulaSemantics: (lid: string) =>
    http<FormulaSemantics>("GET", `/book/formula_semantics${qs({ lid })}`),
  openBook: (dir: string) => http<{ ok: boolean; book_id: string }>("POST", "/book/open", { dir }),

  // ── book.query(LLM 命令,POST)──
  query: (q: string, anchor_lid?: string) =>
    http<QueryResponse>("POST", "/book/query", { q, anchor_lid }),

  // ── reader.*(可变 POST,返 effect)──
  goto: (lid: string) => http<ViewportEffect>("POST", "/reader/goto", { lid }),
  scroll: (delta: number) => http<ViewportEffect>("POST", "/reader/scroll", { delta }),
  // range?:段内自由高亮 {start,end}(UTF-16 偏移);缺省=整段高亮 `[ADR-0031]`。
  highlight: (lid: string, range?: TextRange, sourceSessionId?: string) =>
    http<HighlightEffect>("POST", "/reader/highlight", { lid, range, source_session_id: sourceSessionId }),
  note: (lid: string, text: string) => http<NoteEffect>("POST", "/reader/note", { lid, text }),
  pdfSelectionResolve: (body: { pageIndex?: number; rects: Array<{ pageIndex?: number; bbox: [number, number, number, number] }> }) =>
    http<PdfSelectionResolveResponse>("POST", "/reader/pdf_selection.resolve", body),
  pdfRangesProject: (ranges: Array<{ lid: string; range?: TextRange }>) =>
    http<PdfRangesProjectResponse>("POST", "/reader/pdf_ranges.project", { ranges }),
  layoutApply: (body: {
    actions?: ReaderLayoutAction[];
    proposal_id?: string;
    base_layout_rev?: number;
  }) => http<ReaderLayoutApplyOutcome>("POST", "/reader/layout.apply", body),
  state: () => http<ReaderState>("POST", "/reader/state", {}),

  // ── memory.*(POST)──
  recall: (q: { book_id?: string; lid?: string; type?: string; layer?: string; text?: string } = {}) =>
    http<MemoryRecord[]>("POST", "/memory/recall", q),
  save: (r: { type: string; anchor_lid: string; content: string; layer?: string }) =>
    http<MemoryRecord>("POST", "/memory/save", r),
  delete: (mem_id: string) => http<{ ok: boolean }>("POST", "/memory/delete", { mem_id }),

  // ── agent.*(外层 E agent,POST)`[ADR-0030]` ──
  agentChat: (message: string, meta: AgentChatMeta = {}) =>
    http<OuterOutcome>("POST", "/agent/chat", { message, ...meta }),
  agentNew: () => http<{ ok: boolean; history: AgentHistoryResponse }>("POST", "/agent/new", {}),
  agentHistory: () => http<AgentHistoryResponse>("GET", "/agent/history"),
  agentHistorySelect: (session_id: string) =>
    http<AgentHistoryResponse>("POST", "/agent/history/select", { session_id }),
  agentHistoryDelete: (session_id: string) =>
    http<AgentHistoryResponse>("POST", "/agent/history/delete", { session_id }),
};
