import { describe, expect, it, vi } from "vitest";
import type {
  BuildWorkbenchSnapshot,
  SourceReviewDecision,
  SourceReviewLlmSuggestion,
} from "./api";
import {
  SOURCE_REVIEW_LLM_AUTO_APPLY_CONFIDENCE,
  SOURCE_REVIEW_LLM_BATCH_NOTE_PREFIX,
  evaluateSourceReviewLlmBatchEligibility,
  getSourceReviewAutoRerunRequest,
  getSourceReviewLlmBatchTargets,
  getSourceReviewManualOverride,
  runSourceReviewLlmBatch,
  type SourceReviewLlmBatchFailure,
  type SourceReviewLlmBatchState,
} from "./source-review-batch";

function makeSnapshot(
  blockIds: string[],
  decisions: SourceReviewDecision[] = [],
  bookId = "book-before",
): BuildWorkbenchSnapshot {
  return {
    version: "build_workbench_snapshot.v1",
    book_id: bookId,
    source_review: {
      report: null,
      unresolved: blockIds.map((id) => ({
        id,
        status: "needs_review",
        reason: "test",
        md_excerpt: `markdown for ${id}`,
        pdf_excerpt: `pdf for ${id}`,
        candidate_text: `candidate for ${id}`,
      })),
      review_draft_markdown: null,
      decisions: {
        version: "source_review_decisions.v1",
        decisions,
      },
      ready_for_rerun: false,
    },
  } as BuildWorkbenchSnapshot;
}

function makeSuggestion(
  blockId: string,
  overrides: Partial<SourceReviewLlmSuggestion> = {},
): SourceReviewLlmSuggestion {
  return {
    version: "source_review_llm_suggestion.v1",
    block_id: blockId,
    basis: "markdown_and_pdf_extracted_text",
    summary: "Use the reconciled text.",
    differences: [],
    recommendation: "manual_edit",
    replacement_text: `replacement for ${blockId}`,
    confidence: 0.92,
    warnings: [],
    ...overrides,
  };
}

function makeResolvedSnapshot(
  blockIds: string[],
  blockId: string,
  replacementText: string,
  bookId: string,
): BuildWorkbenchSnapshot {
  return makeSnapshot(blockIds, [{
    block_id: blockId,
    decision: "manual_edit",
    replacement_text: replacementText,
    resolved_at: "now",
  }], bookId);
}

function makeAutoRerunSnapshot(): BuildWorkbenchSnapshot {
  const snapshot = makeSnapshot(["block-1"], [{
    block_id: "block-1",
    decision: "manual_edit",
    replacement_text: "final text",
    resolved_at: "now",
  }]);
  snapshot.source_review.ready_for_rerun = true;
  snapshot.input = { manifest: null, fingerprint: null, ready: true };
  const stages = Object.fromEntries([
    "source_reconciliation",
    "hybrid_foundation",
    "pass1",
    "paper_metadata",
    "paper_lexicon",
    "profile_sidecar",
    "pass2",
    "book_structure",
    "paper_reading_guide",
  ].map((stage) => [stage, { stage, status: "blocked" }])) as unknown as BuildWorkbenchSnapshot["readiness"]["stages"];
  stages.source_reconciliation = {
    stage: "source_reconciliation",
    status: "needs_review",
    reason: "source reconciliation needs review",
  };
  snapshot.readiness = {
    status: "needs_review",
    route: "workbench",
    reasons: [],
    stages,
  };
  snapshot.jobs = [{
    version: "build_job_state.v1",
    job_id: "job-ready",
    book_id: snapshot.book_id,
    input_fingerprint: { paper_md_sha256: "md", paper_pdf_sha256: "pdf", config_hash: "config" },
    status: "ready",
    events: [],
    decision_requests: [],
    permission_requests: [],
    created_at: "1",
    updated_at: "2",
  }];
  return snapshot;
}

describe("source review LLM batch targets", () => {
  it("selects undecided and latest keep_blocked decisions in unresolved order", () => {
    const snapshot = makeSnapshot(["new", "accepted", "blocked", "superseded"], [
      { block_id: "accepted", decision: "accept_markdown", resolved_at: "1" },
      { block_id: "blocked", decision: "keep_blocked", resolved_at: "2" },
      { block_id: "superseded", decision: "keep_blocked", resolved_at: "3" },
      { block_id: "superseded", decision: "manual_edit", replacement_text: "done", resolved_at: "4" },
    ]);

    expect(getSourceReviewLlmBatchTargets(snapshot).map((block) => block.id)).toEqual(["new", "blocked"]);
  });

  it("keeps a recorded decision pending when its required evidence is absent", () => {
    const snapshot = makeSnapshot(["missing-pdf"], [
      { block_id: "missing-pdf", decision: "accept_pdf", resolved_at: "1" },
    ]);
    delete snapshot.source_review.unresolved[0]?.pdf_excerpt;

    expect(getSourceReviewLlmBatchTargets(snapshot).map((block) => block.id)).toEqual(["missing-pdf"]);
  });

  it("treats every recorded decision as stale when report and decision fingerprints differ", () => {
    const snapshot = makeSnapshot(["accepted"], [
      { block_id: "accepted", decision: "accept_markdown", resolved_at: "1" },
    ]);
    snapshot.source_review.report = { input_fingerprint: { md: "current", pdf: "same" } };
    snapshot.source_review.decisions!.input_fingerprint = { pdf: "same", md: "old" };

    expect(getSourceReviewLlmBatchTargets(snapshot).map((block) => block.id)).toEqual(["accepted"]);

    snapshot.source_review.decisions!.input_fingerprint = { pdf: "same", md: "current" };
    expect(getSourceReviewLlmBatchTargets(snapshot)).toEqual([]);
  });
});

describe("source review automatic rerun", () => {
  it("starts the builtin source reconciliation stage for the latest ready job", () => {
    expect(getSourceReviewAutoRerunRequest(makeAutoRerunSnapshot())).toEqual({
      job_id: "job-ready",
      stage: "source_reconciliation",
      executor: "manual",
      adapter_mode: "builtin",
    });
  });

  it.each([
    ["review is incomplete", (snapshot: BuildWorkbenchSnapshot) => { snapshot.source_review.ready_for_rerun = false; }],
    ["source evidence is stale", (snapshot: BuildWorkbenchSnapshot) => {
      snapshot.readiness.stages.source_reconciliation = {
        stage: "source_reconciliation",
        status: "stale",
        reason: "stale",
      };
    }],
    ["the job is already running", (snapshot: BuildWorkbenchSnapshot) => { snapshot.jobs[0]!.status = "running"; }],
    ["another user decision is pending", (snapshot: BuildWorkbenchSnapshot) => {
      snapshot.jobs[0]!.decision_requests = [{ status: "pending" }] as BuildWorkbenchSnapshot["jobs"][number]["decision_requests"];
    }],
  ])("does not start when %s", (_label, mutate) => {
    const snapshot = makeAutoRerunSnapshot();
    mutate(snapshot);
    expect(getSourceReviewAutoRerunRequest(snapshot)).toBeNull();
  });

  it("does not rerun or review residual blocks after a manual source override", () => {
    const snapshot = makeAutoRerunSnapshot();
    snapshot.source_review.report = {
      acceptance: {
        mode: "manual_override",
        policy: "single_review_then_override_v1",
        accepted_at: "3",
        residual_unresolved_count: 1,
        decision_count: 1,
      },
    };

    expect(getSourceReviewLlmBatchTargets(snapshot)).toEqual([]);
    expect(getSourceReviewAutoRerunRequest(snapshot)).toBeNull();
  });

  it.each([
    ["the policy is missing", {
      mode: "manual_override",
      accepted_at: "3",
      residual_unresolved_count: 1,
      decision_count: 1,
    }],
    ["the policy is unknown", {
      mode: "manual_override",
      policy: "unknown",
      accepted_at: "3",
      residual_unresolved_count: 1,
      decision_count: 1,
    }],
    ["accepted_at is blank", {
      mode: "manual_override",
      policy: "single_review_then_override_v1",
      accepted_at: "  ",
      residual_unresolved_count: 1,
      decision_count: 1,
    }],
    ["the residual count does not match", {
      mode: "manual_override",
      policy: "single_review_then_override_v1",
      accepted_at: "3",
      residual_unresolved_count: 0,
      decision_count: 1,
    }],
    ["the decision count is not positive", {
      mode: "manual_override",
      policy: "single_review_then_override_v1",
      accepted_at: "3",
      residual_unresolved_count: 1,
      decision_count: 0,
    }],
    ["the decision count is fractional", {
      mode: "manual_override",
      policy: "single_review_then_override_v1",
      accepted_at: "3",
      residual_unresolved_count: 1,
      decision_count: 1.5,
    }],
  ])("keeps review and automatic rerun active when %s", (_label, acceptance) => {
    const snapshot = makeAutoRerunSnapshot();
    snapshot.source_review.report = { acceptance };

    expect(getSourceReviewManualOverride(snapshot)).toBeNull();
    expect(getSourceReviewAutoRerunRequest(snapshot)).toEqual({
      job_id: "job-ready",
      stage: "source_reconciliation",
      executor: "manual",
      adapter_mode: "builtin",
    });
  });
});

describe("source review LLM batch eligibility", () => {
  it("accepts the threshold inclusively and trims the replacement", () => {
    expect(evaluateSourceReviewLlmBatchEligibility("block-1", makeSuggestion("block-1", {
      confidence: SOURCE_REVIEW_LLM_AUTO_APPLY_CONFIDENCE,
      replacement_text: "\n  final text  \n",
    }))).toEqual({
      eligible: true,
      replacement_text: "final text",
      confidence: SOURCE_REVIEW_LLM_AUTO_APPLY_CONFIDENCE,
    });
  });

  it.each([
    ["mismatched block", makeSuggestion("other"), "contract_failed"],
    ["blank replacement", makeSuggestion("block-1", { replacement_text: " \n " }), "contract_failed"],
    ["non-finite confidence", makeSuggestion("block-1", { confidence: Number.NaN }), "contract_failed"],
    ["low confidence", makeSuggestion("block-1", { confidence: 0.799 }), "low_confidence"],
    [
      "uncertain recommendation",
      makeSuggestion("block-1", { recommendation: "uncertain", replacement_text: "", confidence: 0.99 }),
      "uncertain",
    ],
  ])("rejects %s", (_label, suggestion, expectedKind) => {
    const result = evaluateSourceReviewLlmBatchEligibility("block-1", suggestion);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.failure.kind).toBe(expectedKind);
  });

  it("rejects malformed response objects as contract failures", () => {
    const result = evaluateSourceReviewLlmBatchEligibility("block-1", {
      block_id: "block-1",
      recommendation: "manual_edit",
      replacement_text: "text",
      confidence: 1,
    });

    expect(result).toMatchObject({
      eligible: false,
      failure: { block_id: "block-1", kind: "contract_failed" },
    });
  });
});

describe("runSourceReviewLlmBatch", () => {
  it("persists eligible items immediately and continues after every failure class", async () => {
    const blockIds = [
      "applied-1",
      "analysis-fail",
      "low",
      "uncertain",
      "contract",
      "resolve-fail",
      "applied-2",
      "excluded",
    ];
    const initial = makeSnapshot(blockIds, [
      { block_id: "applied-2", decision: "keep_blocked", resolved_at: "1" },
      { block_id: "excluded", decision: "accept_pdf", resolved_at: "2" },
    ]);
    const calls: string[] = [];
    const analyzedSuggestions: SourceReviewLlmSuggestion[] = [];
    const stateEvents: Readonly<SourceReviewLlmBatchState>[] = [];
    const suggestionEvents: Readonly<SourceReviewLlmSuggestion>[] = [];
    const failureEvents: Readonly<SourceReviewLlmBatchFailure>[] = [];
    const snapshotEvents: Readonly<BuildWorkbenchSnapshot>[] = [];

    const analyze = vi.fn(async (blockId: string) => {
      calls.push(`analyze:${blockId}`);
      if (blockId === "analysis-fail") throw new Error("provider unavailable");
      let suggestion = makeSuggestion(blockId);
      if (blockId === "low") suggestion = makeSuggestion(blockId, { confidence: 0.79 });
      if (blockId === "uncertain") suggestion = makeSuggestion(blockId, { recommendation: "uncertain" });
      if (blockId === "contract") suggestion = makeSuggestion("wrong-block");
      analyzedSuggestions.push(suggestion);
      return suggestion;
    });
    const resolve = vi.fn(async (payload: { block_id: string }) => {
      calls.push(`resolve:${payload.block_id}`);
      if (payload.block_id === "resolve-fail") throw new Error("write rejected");
      return makeResolvedSnapshot(
        blockIds,
        payload.block_id,
        `replacement for ${payload.block_id}`,
        `after-${payload.block_id}`,
      );
    });

    const result = await runSourceReviewLlmBatch({
      snapshot: initial,
      jobId: "job-1",
      analyze,
      resolve,
      onState: (state) => stateEvents.push(state),
      onSuggestion: (suggestion) => suggestionEvents.push(suggestion),
      onFailure: (failure) => failureEvents.push(failure),
      onSnapshot: (snapshot) => snapshotEvents.push(snapshot),
    });

    expect(calls).toEqual([
      "analyze:applied-1",
      "resolve:applied-1",
      "analyze:analysis-fail",
      "analyze:low",
      "analyze:uncertain",
      "analyze:contract",
      "analyze:resolve-fail",
      "resolve:resolve-fail",
      "analyze:applied-2",
      "resolve:applied-2",
    ]);
    expect(result.state).toMatchObject({
      status: "completed",
      total: 7,
      processed: 7,
      applied: 2,
      failed: 5,
      current_block_id: null,
    });
    expect(result.state.failures.map((failure) => [failure.block_id, failure.kind])).toEqual([
      ["analysis-fail", "analysis_failed"],
      ["low", "low_confidence"],
      ["uncertain", "uncertain"],
      ["contract", "contract_failed"],
      ["resolve-fail", "resolve_failed"],
    ]);
    expect(result.snapshot.book_id).toBe("after-applied-2");
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenNthCalledWith(1, {
      job_id: "job-1",
      block_id: "applied-1",
      decision: "manual_edit",
      replacement_text: "replacement for applied-1",
      note: `${SOURCE_REVIEW_LLM_BATCH_NOTE_PREFIX}; confidence=0.920`,
    });
    expect(failureEvents).toHaveLength(5);
    expect(snapshotEvents.map((snapshot) => snapshot.book_id)).toEqual(["after-applied-1", "after-applied-2"]);
    expect(suggestionEvents.map((suggestion) => suggestion.block_id)).toEqual([
      "applied-1",
      "low",
      "uncertain",
      "resolve-fail",
      "applied-2",
    ]);

    expect(stateEvents.at(-1)).toEqual(result.state);
    expect(stateEvents.every(Object.isFrozen)).toBe(true);
    expect(stateEvents.every((state) => Object.isFrozen(state.failures))).toBe(true);
    expect(failureEvents.every(Object.isFrozen)).toBe(true);
    expect(suggestionEvents.every(Object.isFrozen)).toBe(true);
    expect(snapshotEvents.every(Object.isFrozen)).toBe(true);
    expect(suggestionEvents[0]).not.toBe(analyzedSuggestions[0]);
    expect(snapshotEvents[0]).not.toBe(result.snapshot);
  });

  it("stops before the next target when cancellation is requested without rolling back success", async () => {
    const initial = makeSnapshot(["block-1", "block-2"]);
    let cancelled = false;
    const analyze = vi.fn(async (blockId: string) => makeSuggestion(blockId));
    const resolve = vi.fn(async (payload: { block_id: string }) => makeResolvedSnapshot(
      ["block-1", "block-2"],
      payload.block_id,
      `replacement for ${payload.block_id}`,
      `after-${payload.block_id}`,
    ));

    const result = await runSourceReviewLlmBatch({
      snapshot: initial,
      analyze,
      resolve,
      isCancelled: () => cancelled,
      onSnapshot: () => {
        cancelled = true;
      },
    });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.snapshot.book_id).toBe("after-block-1");
    expect(result.state).toMatchObject({
      status: "cancelled",
      total: 2,
      processed: 1,
      applied: 1,
      failed: 0,
      current_block_id: null,
    });
  });

  it("reports resolve failure when the returned snapshot did not persist a usable decision", async () => {
    const result = await runSourceReviewLlmBatch({
      snapshot: makeSnapshot(["block-1"]),
      analyze: async (blockId) => makeSuggestion(blockId),
      resolve: async () => makeSnapshot(["block-1"]),
    });

    expect(result.state).toMatchObject({
      status: "completed",
      processed: 1,
      applied: 0,
      failed: 1,
    });
    expect(result.state.failures[0]).toMatchObject({
      block_id: "block-1",
      kind: "resolve_failed",
    });
  });
});
