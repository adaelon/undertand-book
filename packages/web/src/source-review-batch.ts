import type {
  BuildWorkbenchSnapshot,
  SourceReviewBlock,
  SourceReviewDecision,
  SourceReviewLlmRecommendation,
  SourceReviewLlmSuggestion,
} from "./api";

export const SOURCE_REVIEW_LLM_AUTO_APPLY_CONFIDENCE = 0.8;
export const SOURCE_REVIEW_LLM_BATCH_NOTE_PREFIX = "批量 LLM 自动采用";
export const SOURCE_REVIEW_OVERLOAD_ABSOLUTE_COUNT = 100;
export const SOURCE_REVIEW_OVERLOAD_MIN_COUNT = 20;
export const SOURCE_REVIEW_OVERLOAD_UNRESOLVED_RATIO = 0.3;
export const SOURCE_REVIEW_OVERLOAD_UNMATCHED_RATIO = 0.15;
export const SOURCE_REVIEW_PAGE_GROUP_NOTE_PREFIX = "页面复核组保留 Markdown";

export type SourceReviewLoadReason =
  | "absolute_count"
  | "unresolved_density"
  | "unmatched_density";

export interface SourceReviewLoad {
  overloaded: boolean;
  unresolved_count: number;
  review_group_count: number;
  total_units: number | null;
  unresolved_ratio: number | null;
  unmatched_ratio: number | null;
  reason: SourceReviewLoadReason | null;
}

export interface SourceReviewPageGroup {
  id: string;
  pdf_page_index?: number;
  pdf_page_label?: string;
  blocks: SourceReviewBlock[];
}

export interface SourceReviewPageGroupResolvePayload {
  job_id?: string;
  block_id: string;
  decision: "accept_markdown";
  note: string;
}

export interface RunSourceReviewPageGroupDecisionOptions {
  snapshot: BuildWorkbenchSnapshot;
  groupId: string;
  jobId?: string;
  note?: string;
  resolve: (payload: SourceReviewPageGroupResolvePayload) => Promise<BuildWorkbenchSnapshot>;
  onSnapshot?: (snapshot: Readonly<BuildWorkbenchSnapshot>) => void;
}

export type SourceReviewLlmBatchFailureKind =
  | "analysis_failed"
  | "contract_failed"
  | "low_confidence"
  | "uncertain"
  | "resolve_failed";

export interface SourceReviewLlmBatchFailure {
  block_id: string;
  kind: SourceReviewLlmBatchFailureKind;
  message: string;
  confidence?: number;
  recommendation?: SourceReviewLlmRecommendation;
}

export interface SourceReviewLlmBatchState {
  status: "running" | "completed" | "cancelled";
  total: number;
  processed: number;
  applied: number;
  failed: number;
  current_block_id: string | null;
  failures: SourceReviewLlmBatchFailure[];
}

export type SourceReviewLlmBatchEligibility =
  | {
      eligible: true;
      replacement_text: string;
      confidence: number;
    }
  | {
      eligible: false;
      failure: SourceReviewLlmBatchFailure;
    };

export interface SourceReviewLlmBatchResolvePayload {
  job_id?: string;
  block_id: string;
  decision: "manual_edit";
  replacement_text: string;
  note: string;
}

export interface RunSourceReviewLlmBatchOptions {
  snapshot: BuildWorkbenchSnapshot;
  jobId?: string;
  analyze: (blockId: string) => Promise<SourceReviewLlmSuggestion>;
  resolve: (payload: SourceReviewLlmBatchResolvePayload) => Promise<BuildWorkbenchSnapshot>;
  onState?: (state: Readonly<SourceReviewLlmBatchState>) => void;
  onSuggestion?: (suggestion: Readonly<SourceReviewLlmSuggestion>) => void;
  onFailure?: (failure: Readonly<SourceReviewLlmBatchFailure>) => void;
  onSnapshot?: (snapshot: Readonly<BuildWorkbenchSnapshot>) => void;
  isCancelled?: () => boolean;
  formatError?: (error: unknown) => string;
}

const RECOMMENDATIONS = new Set<SourceReviewLlmRecommendation>([
  "keep_markdown",
  "use_pdf",
  "manual_edit",
  "uncertain",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && jsonValuesEqual(left[key], right[key]));
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Groups located blocks by PDF page while leaving every unlocated block independent. */
export function groupSourceReviewBlocks(blocks: SourceReviewBlock[]): SourceReviewPageGroup[] {
  const groups: SourceReviewPageGroup[] = [];
  const locatedGroups = new Map<number, SourceReviewPageGroup>();

  for (const block of blocks) {
    const pageIndex = nonNegativeCount(block.pdf_page_index);
    if (pageIndex === null) {
      groups.push({ id: `block:${block.id}`, blocks: [block] });
      continue;
    }

    let group = locatedGroups.get(pageIndex);
    if (!group) {
      group = {
        id: `page:${pageIndex}`,
        pdf_page_index: pageIndex,
        pdf_page_label: block.pdf_page_label,
        blocks: [],
      };
      locatedGroups.set(pageIndex, group);
      groups.push(group);
    }
    group.blocks.push(block);
  }

  return groups;
}

export function evaluateSourceReviewLoad(snapshot: BuildWorkbenchSnapshot): SourceReviewLoad {
  const unresolvedCount = snapshot.source_review.unresolved.length;
  const report = snapshot.source_review.report;
  const summary = isRecord(report) && isRecord(report.summary) ? report.summary : null;
  const summaryCounts = summary
    ? Object.values(summary).map(nonNegativeCount)
    : [];
  const completeSummary = summaryCounts.length > 0 && summaryCounts.every((count) => count !== null);
  const totalUnits = completeSummary
    ? (summaryCounts as number[]).reduce((total, count) => total + count, 0)
    : null;
  const mdUnmatched = summary ? nonNegativeCount(summary.md_unmatched) : null;
  const pdfUnmatched = summary ? nonNegativeCount(summary.pdf_unmatched) : null;
  const unresolvedRatio = totalUnits && totalUnits > 0 ? unresolvedCount / totalUnits : null;
  const unmatchedRatio = totalUnits && totalUnits > 0 && mdUnmatched !== null && pdfUnmatched !== null
    ? (mdUnmatched + pdfUnmatched) / totalUnits
    : null;

  let reason: SourceReviewLoadReason | null = null;
  if (unresolvedCount >= SOURCE_REVIEW_OVERLOAD_ABSOLUTE_COUNT) {
    reason = "absolute_count";
  } else if (
    unresolvedCount >= SOURCE_REVIEW_OVERLOAD_MIN_COUNT
    && unresolvedRatio !== null
    && unresolvedRatio >= SOURCE_REVIEW_OVERLOAD_UNRESOLVED_RATIO
  ) {
    reason = "unresolved_density";
  } else if (
    unresolvedCount >= SOURCE_REVIEW_OVERLOAD_MIN_COUNT
    && unmatchedRatio !== null
    && unmatchedRatio >= SOURCE_REVIEW_OVERLOAD_UNMATCHED_RATIO
  ) {
    reason = "unmatched_density";
  }

  return {
    overloaded: reason !== null,
    unresolved_count: unresolvedCount,
    review_group_count: groupSourceReviewBlocks(snapshot.source_review.unresolved).length,
    total_units: totalUnits,
    unresolved_ratio: unresolvedRatio,
    unmatched_ratio: unmatchedRatio,
    reason,
  };
}

function isSourceReviewLlmSuggestion(value: unknown): value is SourceReviewLlmSuggestion {
  if (!isRecord(value)) return false;
  if (value.version !== "source_review_llm_suggestion.v1") return false;
  if (value.basis !== "markdown_and_pdf_extracted_text") return false;
  if (typeof value.block_id !== "string" || typeof value.summary !== "string") return false;
  if (typeof value.replacement_text !== "string" || typeof value.confidence !== "number") return false;
  if (typeof value.recommendation !== "string"
    || !RECOMMENDATIONS.has(value.recommendation as SourceReviewLlmRecommendation)) return false;
  if (!Array.isArray(value.differences) || !Array.isArray(value.warnings)) return false;
  return value.warnings.every((warning) => typeof warning === "string");
}

function contractFailure(blockId: string, message: string): SourceReviewLlmBatchEligibility {
  return {
    eligible: false,
    failure: {
      block_id: blockId,
      kind: "contract_failed",
      message,
    },
  };
}

/** Mirrors the server rerun gate for one persisted decision. */
export function sourceReviewDecisionResolvesBlock(
  block: SourceReviewBlock,
  decision: SourceReviewDecision | undefined,
): boolean {
  if (!decision) return false;
  if (decision.decision === "accept_markdown") return typeof block.md_excerpt === "string";
  if (decision.decision === "accept_pdf") return typeof block.pdf_excerpt === "string";
  if (decision.decision === "use_candidate") return typeof block.candidate_text === "string";
  if (decision.decision === "manual_edit") return !!decision.replacement_text?.trim();
  return false;
}

/** Mirrors the server's report/decision input-fingerprint compatibility check. */
export function sourceReviewDecisionSetMatchesReport(snapshot: BuildWorkbenchSnapshot): boolean {
  const report = snapshot.source_review.report;
  const decisions = snapshot.source_review.decisions;
  if (!isRecord(report) || !Object.prototype.hasOwnProperty.call(report, "input_fingerprint")) return true;
  if (!decisions || !Object.prototype.hasOwnProperty.call(decisions, "input_fingerprint")) return true;
  return jsonValuesEqual(report.input_fingerprint, decisions.input_fingerprint);
}

/** Selects every unresolved block that is not currently usable by the rerun gate. */
export function getSourceReviewLlmBatchTargets(snapshot: BuildWorkbenchSnapshot): SourceReviewBlock[] {
  if (getSourceReviewManualOverride(snapshot)) return [];
  if (evaluateSourceReviewLoad(snapshot).overloaded) return [];
  if (!sourceReviewDecisionSetMatchesReport(snapshot)) return [...snapshot.source_review.unresolved];
  const latestDecisionByBlock = new Map(
    (snapshot.source_review.decisions?.decisions ?? []).map((decision) => [decision.block_id, decision]),
  );
  return snapshot.source_review.unresolved.filter((block) => {
    const decision = latestDecisionByBlock.get(block.id);
    return !sourceReviewDecisionResolvesBlock(block, decision);
  });
}

export const sourceReviewBatchTargets = getSourceReviewLlmBatchTargets;

function latestSourceReviewDecisionByBlock(snapshot: BuildWorkbenchSnapshot): Map<string, SourceReviewDecision> {
  const latest = new Map<string, SourceReviewDecision>();
  for (const decision of snapshot.source_review.decisions?.decisions ?? []) {
    latest.set(decision.block_id, decision);
  }
  return latest;
}

/** Persists one explicit page decision as existing atomic decisions, retaining partial success. */
export async function runSourceReviewPageGroupDecision(
  options: RunSourceReviewPageGroupDecisionOptions,
): Promise<BuildWorkbenchSnapshot> {
  const group = groupSourceReviewBlocks(options.snapshot.source_review.unresolved)
    .find((candidate) => candidate.id === options.groupId);
  if (!group) throw new Error(`SOURCE_REVIEW_PAGE_GROUP_NOT_FOUND: ${options.groupId}`);

  const decisionSetCurrent = sourceReviewDecisionSetMatchesReport(options.snapshot);
  const decisions = decisionSetCurrent
    ? latestSourceReviewDecisionByBlock(options.snapshot)
    : new Map<string, SourceReviewDecision>();
  const targets = group.blocks.filter((block) => (
    !sourceReviewDecisionResolvesBlock(block, decisions.get(block.id))
  ));
  let currentSnapshot = options.snapshot;

  for (const block of targets) {
    if (typeof block.md_excerpt !== "string") {
      throw new Error(`SOURCE_REVIEW_PAGE_GROUP_MISSING_MARKDOWN: ${block.id}`);
    }
    const nextSnapshot = await options.resolve({
      job_id: options.jobId,
      block_id: block.id,
      decision: "accept_markdown",
      note: options.note?.trim()
        || `${SOURCE_REVIEW_PAGE_GROUP_NOTE_PREFIX}; group=${options.groupId}`,
    });
    const persistedDecision = latestSourceReviewDecisionByBlock(nextSnapshot).get(block.id);
    if (
      !sourceReviewDecisionSetMatchesReport(nextSnapshot)
      || !sourceReviewDecisionResolvesBlock(block, persistedDecision)
    ) {
      throw new Error(`SOURCE_REVIEW_PAGE_GROUP_DECISION_NOT_PERSISTED: ${block.id}`);
    }
    currentSnapshot = nextSnapshot;
    options.onSnapshot?.(immutableSnapshot(currentSnapshot));
  }

  return currentSnapshot;
}

export interface SourceReviewAutoRerunRequest {
  job_id: string;
  stage: "source_reconciliation";
  executor: "manual";
  adapter_mode: "builtin";
}

export interface SourceReviewManualOverride {
  mode: "manual_override";
  policy: "single_review_then_override_v1";
  accepted_at: string;
  residual_unresolved_count: number;
  decision_count: number;
}

export function getSourceReviewManualOverride(
  snapshot: BuildWorkbenchSnapshot,
): SourceReviewManualOverride | null {
  const report = snapshot.source_review.report;
  if (!isRecord(report) || !isRecord(report.acceptance)) return null;
  const acceptance = report.acceptance;
  const residualCount = acceptance.residual_unresolved_count;
  const decisionCount = acceptance.decision_count;
  if (
    acceptance.mode !== "manual_override"
    || acceptance.policy !== "single_review_then_override_v1"
    || typeof acceptance.accepted_at !== "string"
    || !acceptance.accepted_at.trim()
    || typeof residualCount !== "number"
    || !Number.isInteger(residualCount)
    || residualCount !== snapshot.source_review.unresolved.length
    || typeof decisionCount !== "number"
    || !Number.isInteger(decisionCount)
    || decisionCount <= 0
  ) return null;
  return {
    mode: "manual_override",
    policy: "single_review_then_override_v1",
    accepted_at: acceptance.accepted_at,
    residual_unresolved_count: residualCount,
    decision_count: decisionCount,
  };
}

/** Returns the deterministic rerun request only when no other workbench gate is active. */
export function getSourceReviewAutoRerunRequest(
  snapshot: BuildWorkbenchSnapshot,
): SourceReviewAutoRerunRequest | null {
  if (getSourceReviewManualOverride(snapshot)) return null;
  if (!snapshot.input.ready || !snapshot.source_review.ready_for_rerun) return null;
  if (!sourceReviewDecisionSetMatchesReport(snapshot)) return null;
  if (snapshot.readiness.stages.source_reconciliation?.status === "stale") return null;
  const latestJob = [...snapshot.jobs]
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
    .at(-1);
  if (!latestJob || latestJob.status !== "ready") return null;
  if (latestJob.decision_requests.some((request) => request.status === "pending")) return null;
  if (latestJob.permission_requests.some((request) => request.status === "pending")) return null;
  return {
    job_id: latestJob.job_id,
    stage: "source_reconciliation",
    executor: "manual",
    adapter_mode: "builtin",
  };
}

/** Applies the runtime contract and auto-apply threshold to one model response. */
export function evaluateSourceReviewLlmBatchEligibility(
  blockId: string,
  suggestion: unknown,
): SourceReviewLlmBatchEligibility {
  if (!isSourceReviewLlmSuggestion(suggestion)) {
    return contractFailure(blockId, "LLM 返回不符合 source_review_llm_suggestion.v1 契约");
  }
  if (suggestion.block_id !== blockId) {
    return contractFailure(
      blockId,
      `LLM 返回的 block_id 不一致：预期 ${blockId}，实际 ${suggestion.block_id}`,
    );
  }
  if (suggestion.recommendation === "uncertain") {
    return {
      eligible: false,
      failure: {
        block_id: blockId,
        kind: "uncertain",
        message: "LLM 无法确定，保留人工复核",
        confidence: suggestion.confidence,
        recommendation: suggestion.recommendation,
      },
    };
  }
  if (!Number.isFinite(suggestion.confidence)) {
    return contractFailure(blockId, "LLM 置信度不是有效数值");
  }

  const replacementText = suggestion.replacement_text.trim();
  if (!replacementText) {
    return contractFailure(blockId, "LLM 修订结果为空");
  }
  if (suggestion.confidence < SOURCE_REVIEW_LLM_AUTO_APPLY_CONFIDENCE) {
    return {
      eligible: false,
      failure: {
        block_id: blockId,
        kind: "low_confidence",
        message: `LLM 置信度 ${Math.round(suggestion.confidence * 100)}%，低于自动采用阈值 ${Math.round(SOURCE_REVIEW_LLM_AUTO_APPLY_CONFIDENCE * 100)}%`,
        confidence: suggestion.confidence,
        recommendation: suggestion.recommendation,
      },
    };
  }

  return {
    eligible: true,
    replacement_text: replacementText,
    confidence: suggestion.confidence,
  };
}

export function sourceReviewLlmBatchNote(confidence: number): string {
  return `${SOURCE_REVIEW_LLM_BATCH_NOTE_PREFIX}; confidence=${confidence.toFixed(3)}`;
}

function defaultFormatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function immutableFailure(failure: SourceReviewLlmBatchFailure): SourceReviewLlmBatchFailure {
  return Object.freeze({ ...failure });
}

function immutableState(state: SourceReviewLlmBatchState): SourceReviewLlmBatchState {
  return Object.freeze({
    ...state,
    failures: Object.freeze(state.failures.map(immutableFailure)),
  }) as SourceReviewLlmBatchState;
}

function immutableSuggestion(suggestion: SourceReviewLlmSuggestion): SourceReviewLlmSuggestion {
  return Object.freeze({ ...suggestion });
}

function immutableSnapshot(snapshot: BuildWorkbenchSnapshot): BuildWorkbenchSnapshot {
  return Object.freeze({ ...snapshot });
}

export async function runSourceReviewLlmBatch(
  options: RunSourceReviewLlmBatchOptions,
): Promise<{ snapshot: BuildWorkbenchSnapshot; state: SourceReviewLlmBatchState }> {
  const reviewLoad = evaluateSourceReviewLoad(options.snapshot);
  if (reviewLoad.overloaded) {
    throw new Error(
      `SOURCE_REVIEW_OVERLOAD: ${reviewLoad.unresolved_count} unresolved blocks require deterministic realignment before batch LLM review`,
    );
  }
  const targets = getSourceReviewLlmBatchTargets(options.snapshot);
  let currentSnapshot = options.snapshot;
  const state: SourceReviewLlmBatchState = {
    status: "running",
    total: targets.length,
    processed: 0,
    applied: 0,
    failed: 0,
    current_block_id: null,
    failures: [],
  };
  const formatError = options.formatError ?? defaultFormatError;
  const emitState = () => options.onState?.(immutableState(state));
  const cancelled = () => options.isCancelled?.() === true;
  const recordFailure = (failure: SourceReviewLlmBatchFailure) => {
    state.failures.push(failure);
    state.processed += 1;
    state.failed += 1;
    state.current_block_id = null;
    options.onFailure?.(immutableFailure(failure));
    emitState();
  };

  emitState();

  for (const block of targets) {
    if (cancelled()) {
      state.status = "cancelled";
      break;
    }

    state.current_block_id = block.id;
    emitState();

    let suggestion: SourceReviewLlmSuggestion;
    try {
      suggestion = await options.analyze(block.id);
    } catch (error) {
      if (cancelled()) {
        state.status = "cancelled";
        break;
      }
      recordFailure({
        block_id: block.id,
        kind: "analysis_failed",
        message: formatError(error),
      });
      continue;
    }

    if (cancelled()) {
      state.status = "cancelled";
      break;
    }

    const eligibility = evaluateSourceReviewLlmBatchEligibility(block.id, suggestion);
    if (isSourceReviewLlmSuggestion(suggestion) && suggestion.block_id === block.id) {
      options.onSuggestion?.(immutableSuggestion(suggestion));
    }
    if (cancelled()) {
      state.status = "cancelled";
      break;
    }
    if (!eligibility.eligible) {
      recordFailure(eligibility.failure);
      continue;
    }

    try {
      currentSnapshot = await options.resolve({
        job_id: options.jobId,
        block_id: block.id,
        decision: "manual_edit",
        replacement_text: eligibility.replacement_text,
        note: sourceReviewLlmBatchNote(eligibility.confidence),
      });
    } catch (error) {
      recordFailure({
        block_id: block.id,
        kind: "resolve_failed",
        message: formatError(error),
        confidence: eligibility.confidence,
        recommendation: suggestion.recommendation,
      });
      continue;
    }

    options.onSnapshot?.(immutableSnapshot(currentSnapshot));
    const persistedDecision = [...(currentSnapshot.source_review.decisions?.decisions ?? [])]
      .reverse()
      .find((decision) => decision.block_id === block.id);
    if (
      !sourceReviewDecisionSetMatchesReport(currentSnapshot)
      || !sourceReviewDecisionResolvesBlock(block, persistedDecision)
    ) {
      recordFailure({
        block_id: block.id,
        kind: "resolve_failed",
        message: "服务器未返回可用于重跑的当前复核决定",
        confidence: eligibility.confidence,
        recommendation: suggestion.recommendation,
      });
      continue;
    }

    state.processed += 1;
    state.applied += 1;
    state.current_block_id = null;
    emitState();
  }

  if (state.status === "running") state.status = cancelled() ? "cancelled" : "completed";
  state.current_block_id = null;
  emitState();

  return {
    snapshot: currentSnapshot,
    state: immutableState(state),
  };
}
