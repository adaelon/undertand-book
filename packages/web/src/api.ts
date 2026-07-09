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
export type BuildRoute = "reader" | "workbench";
export type BuildReadinessStatus = "trusted_book" | "missing" | "incomplete" | "needs_review" | "stale_input";
export type BuildStageStatus = "blocked" | "missing" | "done" | "needs_review" | "stale" | "incomplete";
export type BuildJobStatus = "ready" | "running" | "needs_user" | "failed" | "done" | "stale_input";
export type BuildStageId =
  | "source_reconciliation"
  | "hybrid_foundation"
  | "pass1"
  | "paper_metadata"
  | "paper_lexicon"
  | "profile_sidecar"
  | "pass2"
  | "book_structure"
  | "paper_reading_guide";
export type ExecutorId = "codex" | "opencode" | "claude" | "manual";
export interface BuildStageReadiness {
  stage: BuildStageId;
  status: BuildStageStatus;
  reason?: string;
}
export interface BuildWorkbenchReadiness {
  route: BuildRoute;
  status: BuildReadinessStatus;
  reasons: string[];
  stages: Record<BuildStageId, BuildStageReadiness>;
}
export interface BuildDecisionRequest {
  decision_id: string;
  job_id: string;
  stage: BuildStageId;
  kind:
    | "source_reconciliation_mode"
    | "hybrid_source_strategy"
    | "alignment_repair_strategy"
    | "executor_selection"
    | "sidecar_plan";
  prompt: string;
  options: Array<{ id: string; label: string; description?: string }>;
  status: "pending" | "answered";
  answer?: string;
  created_at: string;
  resolved_at?: string;
}
export interface ExecutorPermissionRequest {
  request_id: string;
  run_id: string;
  executor: ExecutorId;
  category:
    | "sandbox_escalation"
    | "network"
    | "filesystem"
    | "mcp_tool"
    | "skill_script"
    | "shell_command"
    | "destructive_action"
    | "other";
  action_summary: string;
  scope_hint: "once" | "stage" | "job" | "profile";
  native?: unknown;
  status: "pending" | "granted" | "denied";
  created_at: string;
  resolved_at?: string;
}
export interface BuildJobEvent {
  event_id: string;
  job_id: string;
  created_at: string;
  type:
    | "job_created"
    | "job_reused"
    | "job_marked_stale"
    | "job_resumed"
    | "job_event_appended"
    | "executor_started"
    | "decision_requested"
    | "decision_resolved"
    | "permission_requested"
    | "permission_resolved";
  stage?: BuildStageId;
  message?: string;
  payload?: unknown;
}
export interface ActiveExecutorRun {
  run_id: string;
  stage: BuildStageId;
  unit_id?: string;
  executor: ExecutorId;
  telemetry?: {
    pid?: number;
    command?: string;
    started_at?: string;
    last_heartbeat_at?: string;
    tokens_used?: number;
    cost_usd?: number;
  };
}
export interface BuildJobState {
  version: "build_job_state.v1";
  job_id: string;
  book_id: string;
  input_fingerprint: {
    paper_md_sha256: string;
    paper_pdf_sha256: string;
    config_hash: string;
  };
  status: BuildJobStatus;
  active_run?: ActiveExecutorRun;
  events: BuildJobEvent[];
  decision_requests: BuildDecisionRequest[];
  permission_requests: ExecutorPermissionRequest[];
  created_at: string;
  updated_at: string;
}
export interface WorkbenchInputFingerprint {
  paper_md_sha256: string;
  paper_pdf_sha256: string;
  config_hash: string;
}
export interface WorkbenchInputManifest {
  version: "workbench_input_manifest.v1";
  book_id: string;
  profile_id: "paper";
  display_title: string;
  created_at: string;
  updated_at: string;
  inputs: {
    paper_md: {
      path: string;
      sha256: string;
      size_bytes: number;
      source: "uploaded_text" | "selected_path";
      original_path?: string | null;
    };
    paper_pdf: {
      path: string;
      sha256: string;
      size_bytes: number;
      source: "uploaded_base64" | "selected_path";
      original_path?: string | null;
    };
  };
  config_hash: string;
  fingerprint: WorkbenchInputFingerprint;
  trusted: false;
}
export interface SidecarFormDraft {
  version: "sidecar_form_draft.v1";
  fields: Array<{
    id: string;
    label: string;
    value: unknown;
    editable: boolean;
  }>;
  default_options?: Array<{
    target_view: string;
    label: string;
    description: string;
    output_contract?: unknown;
    validation_rules?: string[];
  }>;
}
export interface SidecarPlan {
  version: "sidecar_plan.v1";
  book_id?: string;
  plan_id?: string;
  status: "draft" | "confirmed" | "rejected";
  stage: "custom_sidecar";
  confirmation_required?: true;
  selected_option?: string;
  sidecar_generation_allowed: boolean;
  intent?: unknown;
  form_draft?: SidecarFormDraft;
  validation_rules?: string[];
  created_at?: string;
  confirmed_at?: string;
}
export interface BuildWorkbenchSnapshot {
  version: "build_workbench_snapshot.v1";
  book_id: string;
  readiness: BuildWorkbenchReadiness;
  input: {
    manifest: WorkbenchInputManifest | null;
    fingerprint: WorkbenchInputFingerprint | null;
    ready: boolean;
  };
  jobs: BuildJobState[];
  sidecar_plan: {
    plan: SidecarPlan | null;
    form_draft: SidecarFormDraft | null;
    build_spec: unknown | null;
  };
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
  buildWorkbench: () => http<BuildWorkbenchSnapshot>("GET", "/book/build_workbench"),
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
  workbenchInputImport: (payload: {
    target_dir?: string;
    book_id?: string;
    display_title?: string;
    paper_md_path?: string;
    paper_pdf_path?: string;
    paper_md_text?: string;
    paper_pdf_base64?: string;
  }) => http<BuildWorkbenchSnapshot>("POST", "/build_workbench/input.import", payload),
  workbenchJobCreate: () => http<BuildWorkbenchSnapshot>("POST", "/build_workbench/job.create", {}),
  workbenchJobStart: (payload: { job_id?: string; stage?: BuildStageId; executor?: ExecutorId; run_id?: string }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/job.start", payload),
  workbenchJobResume: (job_id: string) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/job.resume", { job_id }),
  workbenchJobEventAppend: (payload: { job_id: string; stage?: BuildStageId; message?: string; payload?: unknown }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/job.event.append", payload),
  workbenchDecisionResolve: (payload: { job_id: string; decision_id: string; answer: string }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/decision.resolve", payload),
  workbenchPermissionResolve: (payload: { job_id: string; request_id: string; granted: boolean }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/permission.resolve", payload),
  sidecarPlanConfirm: (fields: Record<string, unknown>) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/sidecar_plan.confirm", { fields }),

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
