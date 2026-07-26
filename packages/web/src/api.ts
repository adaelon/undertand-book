// 类型化命令面 REST 客户端 `[ADR-0028]`:前端经 `/api` dev proxy 打到 tiny_http。
// 端点名 = 命令名;book.*→GET、reader.*/memory.*/book.query→POST;错误透传 §4.4 信封。
import type { Manifest } from "./generated/Manifest";
import type { BookQueryRequest } from "./generated/BookQueryRequest";
import type { QueryOutcome } from "./generated/QueryOutcome";
import type { ToolError } from "./generated/ToolError";
import type { OuterOutcome } from "./generated/OuterOutcome";
import type { AgentAnswerPart } from "./generated/AgentAnswerPart";
import type { AgentAnswerSource } from "./generated/AgentAnswerSource";
import type { AgentAnswerView } from "./generated/AgentAnswerView";
import type { AgentEffect } from "./generated/AgentEffect";
import type { TraceStep } from "./generated/TraceStep";
import type { QueryAudit } from "./generated/QueryAudit";
import type { HistoricalBackfillJobRequest } from "./generated/HistoricalBackfillJobRequest";
import type { HistoricalBackfillStartRequest } from "./generated/HistoricalBackfillStartRequest";
import type { HistoricalBackfillStateView } from "./generated/HistoricalBackfillStateView";
import type { ProfileManifest } from "./generated/ProfileManifest";
import type { ProfileInfluence } from "./generated/ProfileInfluence";
import type { ProfileCollectionRuleMatcherView } from "./generated/ProfileCollectionRuleMatcherView";
import type { ProfileCollectionRuleView } from "./generated/ProfileCollectionRuleView";
import type { ProfileFactDraftView } from "./generated/ProfileFactDraftView";
import type { ProfileGovernanceActionRequest } from "./generated/ProfileGovernanceActionRequest";
import type { ProfileGovernanceMutationRequest } from "./generated/ProfileGovernanceMutationRequest";
import type { ProfileGovernanceOutcomeView } from "./generated/ProfileGovernanceOutcomeView";
import type { ProfileGovernanceResponseView } from "./generated/ProfileGovernanceResponseView";
import type { ProfileMemoryState } from "./generated/ProfileMemoryState";
import type { ProfileMemoryUpdate } from "./generated/ProfileMemoryUpdate";
import type { ProfileMemoryUpdateKind } from "./generated/ProfileMemoryUpdateKind";
import type { ProfileSummary } from "./generated/ProfileSummary";
import type { ProfileUsageTrace } from "./generated/ProfileUsageTrace";
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
import type { PaperMinimapBase } from "./generated/PaperMinimapBase";
import type { ReaderPaperMinimapState } from "./generated/ReaderPaperMinimapState";
import type { PaperMinimapLensProjection } from "./generated/PaperMinimapLensProjection";
import type { PaperMinimapApplyOutcome } from "./generated/PaperMinimapApplyOutcome";
import type { PaperMinimapCommand } from "./generated/PaperMinimapCommand";
import type { PaperViewportPosition } from "./generated/PaperViewportPosition";
import type { PaperMinimapEffect } from "./generated/PaperMinimapEffect";

export type {
  Manifest,
  BookQueryRequest,
  QueryOutcome,
  OuterOutcome,
  AgentAnswerPart,
  AgentAnswerSource,
  AgentAnswerView,
  AgentEffect,
  TraceStep,
  QueryAudit,
  HistoricalBackfillJobRequest,
  HistoricalBackfillStartRequest,
  HistoricalBackfillStateView,
  ProfileManifest,
  ProfileInfluence,
  ProfileCollectionRuleMatcherView,
  ProfileCollectionRuleView,
  ProfileFactDraftView,
  ProfileGovernanceActionRequest,
  ProfileGovernanceMutationRequest,
  ProfileGovernanceOutcomeView,
  ProfileGovernanceResponseView,
  ProfileMemoryState,
  ProfileMemoryUpdate,
  ProfileMemoryUpdateKind,
  ProfileSummary,
  ProfileUsageTrace,
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
  PaperMinimapBase,
  ReaderPaperMinimapState,
  PaperMinimapLensProjection,
  PaperMinimapApplyOutcome,
  PaperMinimapCommand,
  PaperViewportPosition,
  PaperMinimapEffect,
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
export interface PaperMinimapStateResponse {
  base: PaperMinimapBase;
  state: ReaderPaperMinimapState;
  lens: PaperMinimapLensProjection | null;
  lens_error?: ToolError;
}
export interface PaperMinimapLocalization {
  book_id: string;
  book_version: string;
  base_map_rev: string;
  locale: "zh-CN";
  source: "llm" | "cache" | "fallback";
  region_labels: Record<string, string>;
  landmark_labels: Record<string, string>;
  warning: string | null;
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
export type SelectionResolution = "resolved" | "partial";
export type SelectionResolutionBasis = "exact" | "recovered";
export type PdfSelectionRecoveryDifference =
  | "layout_whitespace"
  | "hyphen_representation"
  | "formula_representation";

export type PdfSelectionRecoveryPolicyVersion =
  | "pdf_selection_recovery.v1"
  | "pdf_selection_recovery.v2";
export type PdfSelectionDiagnostic =
  | "material_or_ambiguous"
  | "insufficient_visible_evidence"
  | "no_source_glyph";
export interface SelectedRange {
  lid: string;
  range: TextRange;
}
export interface SelectionContext {
  status: SelectionResolution;
  resolution_basis?: SelectionResolutionBasis;
  raw_quote: string;
  resolved_quote: string;
  ranges: SelectedRange[];
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
  selection_context?: SelectionContext | null;
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
  route: "reader" | "workbench";
}
export interface BookLibraryResponse {
  root: string;
  books: BookLibraryEntry[];
}

export interface DesktopStatus {
  desktop_host: boolean;
  active_book: boolean;
  book_dir: string | null;
  library_root: string;
  library_root_available: boolean;
}
export type PdfCapabilityStatus = "unavailable" | "available" | "degraded" | "stale" | "failed";
export interface PdfCapability {
  status: PdfCapabilityStatus;
  reason?: string;
  artifact_path?: string;
  report_path?: string;
  config_hash?: string;
}
export interface PdfAlignmentQuality {
  policy_version: "hybrid_quality_policy.v1";
  tier: "full" | "degraded";
  unit_location_ratio: number;
  exact_text_span_ratio: number;
  exact_formula_ratio: number;
  heading_location_ratio: number;
  report_path: string;
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
  alignment_quality?: PdfAlignmentQuality;
}
export interface PdfPageRect {
  pageIndex: number;
  bbox: [number, number, number, number];
}
export interface PdfRegion extends PdfPageRect {
  region_id: string;
}
export interface PdfSourceMapEntryV1 {
  lid: string;
  source_span: TextRange;
  status: "word_mapped" | "line_fallback" | "block_fallback" | "unmapped" | "excluded";
  regions: PdfRegion[];
  primary_region?: PdfRegion;
  alignment: { confidence: number; reason?: string; trace_id?: string };
}
export interface PdfSourceMapEntryV2 {
  lid: string;
  source_span: TextRange;
  precision: "char_exact" | "region_exact" | "partial" | "unmapped";
  regions: PdfRegion[];
  exact_source_spans: TextRange[];
  primary_region?: PdfRegion;
  alignment: { unit_id: string; reason: string; trace_id?: string };
}
export type PdfSourceMapEntry = PdfSourceMapEntryV1 | PdfSourceMapEntryV2;

interface PdfSourceMapBase {
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
  page_region_index: Record<string, string[]>;
  config_hash: string;
}
export interface PdfSourceMapV1 extends PdfSourceMapBase {
  version: "pdf_source_map.v1";
  entries: PdfSourceMapEntryV1[];
  excluded_regions: PdfRegion[];
  page_excluded_index: Record<string, string[]>;
}
export interface PdfSourceMapV2 extends PdfSourceMapBase {
  version: "pdf_source_map.v2";
  entries: PdfSourceMapEntryV2[];
}
export type PdfSourceMap = PdfSourceMapV1 | PdfSourceMapV2;
export interface PdfSelectionResolveResponse {
  status: "resolved" | "partial" | "unresolved";
  diagnostic?: PdfSelectionDiagnostic;
  resolution_basis?: SelectionResolutionBasis;
  recovery_policy_version?: PdfSelectionRecoveryPolicyVersion;
  recovered_differences?: PdfSelectionRecoveryDifference[];
  recovered_difference_counts?: Partial<Record<PdfSelectionRecoveryDifference, number>>;
  ranges: Array<{
    lid: string;
    range: TextRange;
    source_span: TextRange;
    quote_markdown: string;
  }>;
  quote_markdown: string;
}
export type SelectionTranslationRequest = SelectionContext;
export interface SelectionTranslationResponse {
  translation_markdown: string;
  target_locale: "zh-CN";
}
export interface PdfRangesProjectResponse {
  projections: Array<{
    lid: string;
    range: TextRange;
    status: "exact" | "partial" | "unmapped";
    diagnostic?: PdfSelectionDiagnostic;
    resolution_basis?: SelectionResolutionBasis;
    recovery_policy_version?: PdfSelectionRecoveryPolicyVersion;
    recovered_differences?: PdfSelectionRecoveryDifference[];
    recovered_difference_counts?: Partial<Record<PdfSelectionRecoveryDifference, number>>;
    rects: Array<{
      pageIndex: number;
      bbox: [number, number, number, number];
      source_span: TextRange;
    }>;
    covered_range?: TextRange;
    terminal_rect?: {
      pageIndex: number;
      bbox: [number, number, number, number];
      source_span: TextRange;
    };
  }>;
}
export type BuildIntentMode = "read_now" | "standard_deep" | "goal_directed";
export type IntentArtifactType = "timeline" | "concept_map" | "comparison_table" | "argument_map";
export interface BuildIntentPlannerCandidateV1 {
  version: "build_intent_planner_candidate.v1";
  goal_kind: "learn" | "analyze" | "compare" | "write" | "reference" | "other";
  source_scope: { whole_book: boolean; lids: string[]; sections: string[] };
  desired_artifacts: IntentArtifactType[];
  usage_horizon: "one_off" | "project" | "long_term";
}
export interface BuildIntentV1 extends Omit<BuildIntentPlannerCandidateV1, "version"> {
  version: "build_intent.v1";
  intent_id: string;
  revision: number;
  book_id: string;
  source_fingerprint: string;
  content_profile: { id: "technical_learning"; version: "technical_learning_v0" } | { id: "paper"; version: "paper_v0" };
  user_goal: string;
  privacy: "reader_private";
  status: "draft" | "confirmed" | "superseded" | "stale_source" | "deleted";
  created_at: string;
  confirmed_at?: string;
  supersedes_intent_id?: string;
}
export interface BuildPlanEstimateV1 {
  input_tokens: { lower: number; upper: number; coverage: number };
  output_tokens: { lower: number; upper: number; coverage: number };
  wall_clock_minutes: { p50?: number; p95?: number; confidence: "none" | "low" | "medium" | "high" };
  unknown_stages: string[];
  historical_match: { stage: boolean; policy: boolean; model: boolean; harness: boolean; sample_count: number };
}
export interface BuildDecisionRequestV2 {
  version: "build_decision_request.v2";
  decision_id: string;
  job_id?: string;
  scope: { kind: "stage"; stage: BuildStageId } | { kind: "build_plan"; plan_id: string; plan_digest: string };
  kind: "build_intent_plan" | BuildDecisionRequest["kind"];
  options: Array<{ id: string; label: string; description?: string }>;
  status: "pending" | "answered";
}
export interface BuildPlanV1 {
  version: "build_plan.v1";
  plan_id: string;
  revision: number;
  book_id: string;
  source_fingerprint: string;
  content_profile: BuildIntentV1["content_profile"];
  recipe_id: "standard_deep" | "goal_directed";
  intent_id?: string;
  intent_digest?: string;
  public_stage_closure: string[];
  private_artifacts: Array<{
    artifact_id: string;
    artifact_type: IntentArtifactType;
    source_scope: BuildIntentPlannerCandidateV1["source_scope"];
    required_public_capabilities: string[];
    evidence_policy: "lid_required";
  }>;
  reuse: Array<{ artifact: string; freshness_digest: string }>;
  create: string[];
  excluded: Array<{ artifact: string; reason: string }>;
  estimate: BuildPlanEstimateV1;
  budget: { max_total_tokens?: number; max_wall_clock_minutes?: number; on_exceed: "needs_user" };
  status: "draft" | "confirmed" | "superseded" | "stale_source" | "completed";
  plan_digest: string;
  confirmation_source?: "reader_ui" | "codex_conversation" | "explicit_legacy_command";
  created_at: string;
  confirmed_at?: string;
}
export interface BuildIntentSelectionV1 {
  version: "build_intent_selection.v1";
  mode: BuildIntentMode;
  intent: BuildIntentV1 | null;
  intent_digest: string | null;
  plan: BuildPlanV1 | null;
  estimate_input: unknown | null;
  decision_request: BuildDecisionRequestV2 | null;
}
export interface IntentBuildInspectionV1 {
  version: "intent_build_inspection.v1";
  book_id: string;
  store_revision: number;
  intents: Array<{ intent_id: string; revision: number; status: BuildIntentV1["status"]; source_fingerprint: string }>;
  plans: Array<{ plan_id: string; revision: number; status: BuildPlanV1["status"]; plan_digest: string; intent_id?: string }>;
  active_overlay?: { intent_id: string; plan_id: string };
}
export interface BuildIntentResponseV1 {
  version: "build_intent_response.v1";
  selection: BuildIntentSelectionV1;
  inspection: IntentBuildInspectionV1;
}
export interface BuildIntentStatusResponseV1 {
  version: "build_intent_status_response.v1";
  inspection: IntentBuildInspectionV1;
}
export interface IntentTimelinePayloadV1 {
  items: Array<{ id: string; label: string; order_hint?: string; evidence_lids: string[] }>;
}
export interface IntentConceptMapPayloadV1 {
  nodes: Array<{ id: string; label: string; evidence_lids: string[] }>;
  links: Array<{ source: string; target: string; relation: string; evidence_lids: string[] }>;
}
export interface IntentComparisonTablePayloadV1 {
  rows: Array<{ subject: string; dimensions: Record<string, unknown>; evidence_lids: string[] }>;
}
export type IntentArgumentRole = "problem" | "method" | "evidence" | "result" | "limitation" | "future_work";
export interface IntentArgumentMapPayloadV1 {
  claims: Array<{ id: string; claim: string; role: IntentArgumentRole; evidence_lids: string[] }>;
  relations: Array<{ source: string; target: string; relation: string; evidence_lids: string[] }>;
}
type PendingIntentArtifactProjectionV1 = {
  artifact_id: string;
  state: "pending";
  payload?: never;
  payload_digest?: never;
  accepted_at?: never;
};
type AcceptedIntentArtifactProjectionV1<TType extends IntentArtifactType, TPayload> = {
  artifact_id: string;
  artifact_type: TType;
  state: "accepted";
  payload: TPayload;
  payload_digest: string;
  accepted_at: string;
};
export type IntentArtifactProjectionV1 =
  | (PendingIntentArtifactProjectionV1 & { artifact_type: IntentArtifactType })
  | AcceptedIntentArtifactProjectionV1<"timeline", IntentTimelinePayloadV1>
  | AcceptedIntentArtifactProjectionV1<"concept_map", IntentConceptMapPayloadV1>
  | AcceptedIntentArtifactProjectionV1<"comparison_table", IntentComparisonTablePayloadV1>
  | AcceptedIntentArtifactProjectionV1<"argument_map", IntentArgumentMapPayloadV1>;
export interface IntentArtifactOverlayV1 {
  version: "intent_artifact_overlay.v1";
  book_id: string;
  intent_id: string;
  plan_id: string;
  plan_digest: string;
  artifacts: IntentArtifactProjectionV1[];
}
export interface IntentArtifactOverlayResponseV1 {
  version: "intent_artifact_overlay_response.v1";
  overlay: IntentArtifactOverlayV1;
}
export type IntentBuildReaderUsageKind = "reader_ready" | "artifact_opened" | "artifact_cited";
export interface IntentBuildUsageAppendResultV1 {
  version: "intent_build_usage_append_result.v1";
  event_id: string;
  disposition: "created" | "existing";
}
export interface IntentBuildAblationReportV1 {
  version: "intent_build_ablation_report.v1";
  book_id: string;
  as_of: string;
  window_days: number;
  event_count: number;
  modes: Array<{
    mode: BuildIntentMode;
    selection_count: number;
    plan_revisions: Array<{
      plan_id: string;
      revision: number;
      plan_digest: string;
      confirmation_source: "reader_ui" | "codex_conversation" | "explicit_legacy_command";
      intent_id?: string;
    }>;
    estimate: { token_lower: number; token_upper: number; unknown_item_count: number };
    actual: {
      attempt_count: number;
      outcome_counts: Record<"committed" | "retryable_failure" | "needs_user" | "cancelled", number>;
      known_usage_attempts: number;
      unavailable_usage_attempts: number;
      known_usage_coverage: number;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      estimated_input_tokens: number;
      estimated_output_tokens: number;
      wall_clock_ms: number;
    };
    timing: { first_readable_ms: number | null; first_goal_artifact_ms: number | null };
    consumption_7d: {
      accepted_artifacts: number;
      opened_artifacts: number;
      cited_artifacts: number;
      open_rate: number | null;
      citation_rate: number | null;
      open_events: number;
      citation_events: number;
    };
    artifact_costs: Array<{
      artifact_type: IntentArtifactType;
      attempt_count: number;
      committed_attempts: number;
      failed_or_cancelled_attempts: number;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      wall_clock_ms: number;
    }>;
  }>;
  privacy: { raw_goal: false; artifact_body: false; lid_or_quote: false; user_profile: false };
  digest: string;
}
export type BuildRoute = "reader" | "workbench";
export type BuildReadinessStatus = "trusted_book" | "missing" | "incomplete" | "needs_review" | "stale_input";
export type BuildStageStatus = "blocked" | "missing" | "done" | "needs_review" | "stale" | "incomplete";
export type BuildJobStatus = "ready" | "running" | "needs_user" | "failed" | "done" | "stale_input" | "interrupted";
export type SourceReviewDecisionKind = "accept_markdown" | "accept_pdf" | "use_candidate" | "manual_edit" | "keep_blocked";
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
export type WorkbenchAdapterMode = "builtin" | "contract_only" | "fake_success" | "fake_failure" | "fake_permission";
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
    | "review_acceptance"
    | "artifact_conflict_resolution"
    | "continue_or_restart"
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
    | "stage_runner_spawned"
    | "stage_started"
    | "stage_completed"
    | "stage_blocked"
    | "stage_failed"
    | "readiness_recomputed"
    | "run_interrupted"
    | "job_recovered"
    | "executor_contract_written"
    | "executor_completed"
    | "executor_failed"
    | "source_review_decision_recorded"
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
    stdout_path?: string;
    stderr_path?: string;
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
  failure_summary?: {
    stage?: BuildStageId;
    run_id?: string;
    message: string;
    failed_at: string;
    exit_code?: number;
    stdout_path?: string;
    stderr_path?: string;
    recoverable?: boolean;
  };
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
export interface SourceReviewBlock {
  id: string;
  status: string;
  reason: string;
  md_excerpt?: string;
  pdf_excerpt?: string;
  candidate_text?: string;
  review_question?: string;
  md_context?: string;
  pdf_context?: string;
  pdf_page_index?: number;
  pdf_page_label?: string;
  pdf_line_start?: number;
  pdf_line_end?: number;
  comparison_score?: number;
  difference?: { markdown: string; pdf: string };
  evidence?: unknown;
}
export type SourceReviewLlmDifferenceKind =
  | "formatting"
  | "wording"
  | "number"
  | "symbol"
  | "missing_in_markdown"
  | "extra_in_markdown"
  | "order"
  | "extraction_noise"
  | "uncertain";
export type SourceReviewLlmRecommendation = "keep_markdown" | "use_pdf" | "manual_edit" | "uncertain";
export interface SourceReviewLlmDifference {
  kind: SourceReviewLlmDifferenceKind;
  markdown: string;
  pdf: string;
  explanation: string;
}
export interface SourceReviewLlmSuggestion {
  version: "source_review_llm_suggestion.v1";
  block_id: string;
  basis: "markdown_and_pdf_extracted_text";
  summary: string;
  differences: SourceReviewLlmDifference[];
  recommendation: SourceReviewLlmRecommendation;
  replacement_text: string;
  confidence: number;
  warnings: string[];
}
export interface SourceReviewDecision {
  block_id: string;
  decision: SourceReviewDecisionKind;
  replacement_text?: string;
  note?: string | null;
  block_status?: string | null;
  block_reason?: string | null;
  resolved_at: string;
}
export interface SourceReviewSnapshot {
  report: unknown | null;
  unresolved: SourceReviewBlock[];
  review_draft_markdown: string | null;
  decisions: {
    version: "source_review_decisions.v1";
    book_id?: string;
    stage?: "source_reconciliation";
    input_fingerprint?: unknown;
    decisions: SourceReviewDecision[];
    created_at?: string;
    updated_at?: string;
  } | null;
  ready_for_rerun: boolean;
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
  source_review: SourceReviewSnapshot;
  operations: {
    warnings: Array<{ code: string; message: string; job_id?: string | null; stage?: BuildStageId | null }>;
    permission_audit: Array<{
      audit_id: string;
      job_id: string;
      request_id: string;
      run_id?: string | null;
      executor?: ExecutorId | null;
      category?: ExecutorPermissionRequest["category"] | null;
      action_summary?: string | null;
      scope_hint?: ExecutorPermissionRequest["scope_hint"] | null;
      granted: boolean;
      resolved_at: string;
    }>;
    retention: {
      max_jobs: number;
      max_events_per_job: number;
      max_permission_audit_entries: number;
    };
  };
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
  ranges?: SelectedRange[];
  status?: SelectionResolution;
  resolution_basis?: SelectionResolutionBasis;
  raw_quote?: string;
  resolved_quote?: string;
}
export interface AgentQuestionQuoteView {
  label: string;
  quote: string;
  status?: SelectionResolution;
}
export interface AgentChatTurn {
  turn_id: string;
  user_turn_ordinal: number;
  user: string;
  status: "pending_assistant" | "completed" | "failed";
  outcome?: OuterOutcome | null;
  error?: { error_code: string; category: string; message: string } | null;
  question_source_label: string | null;
  question_quote: AgentQuestionQuoteView | null;
  effect_labels: string[];
}
export interface AgentChatTurnSummary {
  user: string;
  question_source_label: string | null;
  question_quote: AgentQuestionQuoteView | null;
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
export interface SourcePopupView {
  source_ref_id: string;
  label: string;
  highlighted_quote: string;
  context_before: string;
  context_after: string;
  stale: boolean;
  can_open_in_reader: boolean;
}
export interface SourceOpenView {
  source_ref_id: string;
  opened: boolean;
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
  desktopStatus: () => http<DesktopStatus>("GET", "/desktop/status"),
  // ── book.*(只读 GET)──
  manifest: () => http<Manifest>("GET", "/book/manifest"),
  bookLibrary: () => http<BookLibraryResponse>("GET", "/book/library"),
  assetManifest: () => http<AssetManifest>("GET", "/book/asset_manifest"),
  buildWorkbench: () => http<BuildWorkbenchSnapshot>("GET", "/book/build_workbench"),
  sourceManifest: () => http<SourceManifestV2>("GET", "/book/source_manifest"),
  pdfSourceMap: () => http<PdfSourceMap>("GET", "/book/pdf_source_map"),
  paperMinimap: () => http<PaperMinimapBase>("GET", "/book/paper_minimap"),
  pdfOriginalUrl: () => `${BASE}/book/pdf/original`,
  profileManifest: (profile_id?: "technical_learning" | "paper") =>
    http<ProfileManifest>("GET", `/profile/manifest${qs({ profile_id })}`),
  profileMemory: () => http<ProfileMemoryState>("GET", "/profile/memory"),
  profileMemoryApply: (mutation: ProfileGovernanceMutationRequest) =>
    http<ProfileGovernanceResponseView>("POST", "/profile/memory/apply", mutation),
  profileBackfill: () => http<HistoricalBackfillStateView>("GET", "/profile/backfill"),
  profileBackfillStart: (request: HistoricalBackfillStartRequest) =>
    http<HistoricalBackfillStateView>("POST", "/profile/backfill/start", request),
  profileBackfillCancel: (request: HistoricalBackfillJobRequest) =>
    http<HistoricalBackfillStateView>("POST", "/profile/backfill/cancel", request),
  profileBackfillRetry: (request: HistoricalBackfillJobRequest) =>
    http<HistoricalBackfillStateView>("POST", "/profile/backfill/retry", request),
  profileBackfillClear: (request: HistoricalBackfillJobRequest) =>
    http<HistoricalBackfillStateView>("POST", "/profile/backfill/clear", request),
  buildIntentStatus: () =>
    http<BuildIntentStatusResponseV1>("GET", "/build_intent/status"),
  buildIntentDraft: (payload: {
    mode: BuildIntentMode;
    user_goal?: string;
    budget?: BuildPlanV1["budget"];
  }) => http<BuildIntentResponseV1>("POST", "/build_intent/draft", payload),
  buildIntentEdit: (payload: {
    plan_id: string;
    user_goal?: string;
    candidate?: BuildIntentPlannerCandidateV1;
    budget?: BuildPlanV1["budget"];
  }) => http<BuildIntentResponseV1>("POST", "/build_intent/edit", payload),
  buildIntentEstimate: (plan_id: string) =>
    http<{ version: "build_plan_estimate_response.v1"; plan_id: string; plan_digest: string; estimate: BuildPlanEstimateV1 }>(
      "POST",
      "/build_intent/estimate",
      { plan_id },
    ),
  buildIntentConfirm: (plan_id: string, plan_digest: string) =>
    http<BuildIntentResponseV1>("POST", "/build_intent/confirm", { plan_id, plan_digest }),
  buildIntentReject: (plan_id: string) =>
    http<BuildIntentResponseV1>("POST", "/build_intent/reject", { plan_id }),
  intentArtifacts: () =>
    http<IntentArtifactOverlayResponseV1>("GET", "/build_intent/artifacts"),
  intentUsage: () =>
    http<IntentBuildAblationReportV1>("GET", "/build_intent/usage"),
  intentUsageEvent: (payload: {
    event_id: string;
    occurred_at: string;
    kind: IntentBuildReaderUsageKind;
    artifact_id?: string;
  }) => http<IntentBuildUsageAppendResultV1>("POST", "/build_intent/usage.event", payload),
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
  createBook: (payload: {
    book_id: string;
    display_title: string;
    paper_md_text: string;
    paper_pdf_base64: string;
  }) => http<BuildWorkbenchSnapshot>("POST", "/book/create", payload),

  // ── book.query(LLM 命令,POST)──
  query: (request: BookQueryRequest) =>
    http<QueryOutcome>("POST", "/book/query", request),
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
  workbenchJobStart: (payload: {
    job_id?: string;
    stage?: BuildStageId;
    executor?: ExecutorId;
    run_id?: string;
    adapter_mode?: WorkbenchAdapterMode;
  }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/job.start", payload),
  workbenchJobResume: (job_id: string) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/job.resume", { job_id }),
  workbenchJobEventAppend: (payload: { job_id: string; stage?: BuildStageId; message?: string; payload?: unknown }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/job.event.append", payload),
  workbenchDecisionResolve: (payload: { job_id: string; decision_id: string; answer: string }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/decision.resolve", payload),
  workbenchPermissionResolve: (payload: { job_id: string; request_id: string; granted: boolean }) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/permission.resolve", payload),
  workbenchSourceReviewResolve: (payload: {
    job_id?: string;
    block_id: string;
    decision: SourceReviewDecisionKind;
    replacement_text?: string;
    note?: string;
  }) => http<BuildWorkbenchSnapshot>("POST", "/build_workbench/source_review.resolve", payload),
  workbenchSourceReviewAnalyze: (block_id: string) =>
    http<SourceReviewLlmSuggestion>("POST", "/build_workbench/source_review.analyze", { block_id }),
  sidecarPlanDraft: (payload: {
    request: string;
    target_view?: "timeline" | "concept_map" | "comparison_table" | "argument_map" | "custom";
    lids?: string[];
    sections?: string[];
  }) => http<BuildWorkbenchSnapshot>("POST", "/build_workbench/sidecar_plan.draft", payload),
  sidecarPlanConfirm: (fields: Record<string, unknown>) =>
    http<BuildWorkbenchSnapshot>("POST", "/build_workbench/sidecar_plan.confirm", { fields }),

  // ── reader.*(可变 POST,返 effect)──
  goto: (lid: string) => http<ViewportEffect>("POST", "/reader/goto", { lid }),
  scroll: (delta: number) => http<ViewportEffect>("POST", "/reader/scroll", { delta }),
  // range?:段内自由高亮 {start,end}(UTF-16 偏移);缺省=整段高亮 `[ADR-0031]`。
  highlight: (lid: string, range?: TextRange, sourceSessionId?: string) =>
    http<HighlightEffect>("POST", "/reader/highlight", { lid, range, source_session_id: sourceSessionId }),
  note: (lid: string, text: string) => http<NoteEffect>("POST", "/reader/note", { lid, text }),
  pdfSelectionResolve: (body: { pageIndex?: number; raw_quote?: string; rects: Array<{ pageIndex?: number; bbox: [number, number, number, number] }> }) =>
    http<PdfSelectionResolveResponse>("POST", "/reader/pdf_selection.resolve", body),
  pdfSelectionTranslate: (body: SelectionTranslationRequest) =>
    http<SelectionTranslationResponse>("POST", "/reader/selection.translate", body),
  pdfRangesProject: (ranges: Array<{ lid: string; range: TextRange }>) =>
    http<PdfRangesProjectResponse>("POST", "/reader/pdf_ranges.project", { ranges }),
  layoutApply: (body: {
    actions?: ReaderLayoutAction[];
    proposal_id?: string;
    base_layout_rev?: number;
  }) => http<ReaderLayoutApplyOutcome>("POST", "/reader/layout.apply", body),
  paperMinimapState: () => http<PaperMinimapStateResponse>("POST", "/reader/paper_minimap.state", {}),
  paperMinimapLocalize: () => http<PaperMinimapLocalization>("POST", "/reader/paper_minimap.localize", {}),
  paperMinimapApply: (body: {
    base_state_rev: number;
    commands?: PaperMinimapCommand[];
    proposal_id?: string;
    dismiss_proposal_id?: string;
    undo_effect_id?: string;
    base_map_rev?: string;
    actor?: "user" | "agent";
    reason?: string;
    evidence_lids?: string[];
    trigger_turn_id?: string;
  }) => http<PaperMinimapApplyOutcome>("POST", "/reader/paper_minimap.apply", body),
  state: () => http<ReaderState>("POST", "/reader/state", {}),

  // ── memory.*(POST)──
  recall: (q: { book_id?: string; lid?: string; type?: string; layer?: string; text?: string } = {}) =>
    http<MemoryRecord[]>("POST", "/memory/recall", q),
  save: (r: { type: string; anchor_lid: string; content: string; layer?: string; selection_context?: SelectionContext }) =>
    http<MemoryRecord>("POST", "/memory/save", r),
  replace: (r: { mem_id: string; content: string; selection_context?: SelectionContext }) =>
    http<MemoryRecord>("POST", "/memory/replace", r),
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
  agentSourceResolve: (turn_id: string, source_ref_id: string) =>
    http<SourcePopupView>("POST", "/agent/source.resolve", { turn_id, source_ref_id }),
  agentSourceOpen: (turn_id: string, source_ref_id: string) =>
    http<SourceOpenView>("POST", "/agent/source.open", { turn_id, source_ref_id }),
};
