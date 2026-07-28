import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  canStartNoteRecordPlacement,
  createPlacedNote,
  isMarkdownInlineNote,
  notePlacementCapability,
  reanchorPlacedNote,
  reconcilePlacedNoteCreate,
  reconcilePlacedNoteReanchor,
  useNotePlacementController,
  type NotePlacementDraftInput,
} from "./note-placement";

function draft(overrides: Partial<NotePlacementDraftInput> = {}): NotePlacementDraftInput {
  return {
    draft_id: "draft-a",
    book_id: "book-a",
    surface_kind: "markdown",
    source_fingerprint: "a".repeat(64),
    content: "agent answer excerpt",
    origin: { kind: "agent_answer", chat_session_id: "chat-a" },
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    mem_id: "mem-old",
    type: "note",
    layer: "long_term",
    book_id: "book-a",
    anchor: { lid: "1.1" },
    content: "existing note",
    note_placement: {
      kind: "lid_block" as const,
      source_fingerprint: "old-source",
      lid: "1.1",
    },
    ...overrides,
  };
}

describe("Note placement capability", () => {
  it("enables only the current completed surface", () => {
    expect(notePlacementCapability("markdown", { markdown: true, pdf: false })).toBe(true);
    expect(notePlacementCapability("pdf", { markdown: true, pdf: false })).toBe(false);
    expect(notePlacementCapability("pdf", { markdown: false, pdf: true })).toBe(true);
  });
});

describe("useNotePlacementController", () => {
  it("creates one draft, replaces it before submit, and cancels explicitly", () => {
    const controller = useNotePlacementController();

    expect(controller.createDraft(draft())).toBe(true);
    expect(controller.state.value).toMatchObject({
      phase: "placing",
      subject: { kind: "draft", draft_id: "draft-a" },
      draft: { content: "agent answer excerpt" },
    });

    expect(controller.createDraft(draft({ draft_id: "draft-b", content: "new excerpt" }))).toBe(true);
    expect(controller.state.value).toMatchObject({
      phase: "placing",
      subject: { kind: "draft", draft_id: "draft-b" },
      draft: { content: "new excerpt" },
    });

    expect(controller.cancel()).toBe(true);
    expect(controller.state.value).toEqual({ phase: "idle" });
  });

  it("drops a placing draft when book, surface, or source changes", () => {
    const controller = useNotePlacementController();
    controller.createDraft(draft());

    expect(controller.synchronizeContext({
      book_id: "book-b",
      surface_kind: "markdown",
      source_fingerprint: "a".repeat(64),
    })).toBe("discarded");
    expect(controller.state.value.phase).toBe("idle");

    controller.createDraft(draft());
    expect(controller.synchronizeContext({
      book_id: "book-a",
      surface_kind: "pdf",
      source_fingerprint: "a".repeat(64),
    })).toBe("discarded");

    controller.createDraft(draft());
    expect(controller.synchronizeContext({
      book_id: "book-a",
      surface_kind: "markdown",
      source_fingerprint: "b".repeat(64),
    })).toBe("discarded");
  });

  it("locks replacement and cancellation after target submission", () => {
    const controller = useNotePlacementController();
    controller.createDraft(draft());
    const frozen = controller.beginSaving({
      kind: "lid_block",
      source_fingerprint: "a".repeat(64),
      lid: "1.1",
    });

    expect(frozen).toMatchObject({
      phase: "saving",
      original_book_id: "book-a",
      target: { kind: "lid_block", lid: "1.1" },
    });
    expect(controller.cancel()).toBe(false);
    expect(controller.createDraft(draft({ draft_id: "draft-b" }))).toBe(false);
    expect(controller.state.value.phase).toBe("saving");
  });

  it("returns explicit failures to PLACING and uncertain failures through RECONCILING", () => {
    const controller = useNotePlacementController();
    controller.createDraft(draft());
    controller.beginSaving({
      kind: "lid_block",
      source_fingerprint: "a".repeat(64),
      lid: "1.1",
    });

    controller.saveFailed(new Error("write failed"));
    expect(controller.state.value).toMatchObject({ phase: "placing", error: "write failed" });
    if (controller.state.value.phase !== "placing") throw new Error("expected placing state");
    expect(controller.state.value.draft?.draft_id).toBe("draft-a");

    controller.beginSaving({
      kind: "lid_block",
      source_fingerprint: "a".repeat(64),
      lid: "1.1",
    });
    controller.reconcileRequired("connection lost");
    expect(controller.state.value).toMatchObject({ phase: "reconciling", reason: "connection lost" });
    expect(controller.cancel()).toBe(false);

    controller.reconciled("retry");
    expect(controller.state.value).toMatchObject({ phase: "placing", error: "connection lost" });
    controller.beginSaving({
      kind: "lid_block",
      source_fingerprint: "a".repeat(64),
      lid: "1.1",
    });
    controller.saveSucceeded();
    expect(controller.state.value).toEqual({ phase: "idle" });
  });

  it("starts current-source Markdown placement for body-placed and legacy records only", () => {
    const controller = useNotePlacementController();
    const stale = record();

    expect(canStartNoteRecordPlacement(stale, "markdown")).toBe(true);
    expect(controller.startRecord({
      record: stale,
      book_id: "book-a",
      surface_kind: "markdown",
      source_fingerprint: "current-source",
    })).toBe(true);
    expect(controller.state.value).toMatchObject({
      phase: "placing",
      subject: { kind: "record", mem_id: "mem-old" },
      record: { mem_id: "mem-old" },
      source_fingerprint: "current-source",
    });

    expect(controller.startRecord({
      record: record({ mem_id: "mem-legacy", note_placement: null }),
      book_id: "book-a",
      surface_kind: "markdown",
      source_fingerprint: "current-source",
    })).toBe(true);
    expect(controller.state.value).toMatchObject({
      phase: "placing",
      subject: { kind: "record", mem_id: "mem-legacy" },
    });

    expect(controller.startRecord({
      record: record({ selection_context: { ranges: [] }, note_placement: null }),
      book_id: "book-a",
      surface_kind: "markdown",
      source_fingerprint: "current-source",
    })).toBe(false);
    expect(controller.startRecord({
      record: record({ note_placement: { kind: "pdf_region" } }),
      book_id: "book-a",
      surface_kind: "markdown",
      source_fingerprint: "current-source",
    })).toBe(false);
  });

  it("keeps record placement locked after a real target is submitted", () => {
    const controller = useNotePlacementController();
    controller.startRecord({
      record: record(),
      book_id: "book-a",
      surface_kind: "markdown",
      source_fingerprint: "current-source",
    });
    controller.beginSaving({
      kind: "lid_block",
      source_fingerprint: "current-source",
      lid: "2.2",
    });

    expect(controller.cancel()).toBe(false);
    expect(controller.startRecord({
      record: record({ mem_id: "mem-other" }),
      book_id: "book-a",
      surface_kind: "markdown",
      source_fingerprint: "current-source",
    })).toBe(false);
    expect(controller.state.value).toMatchObject({ phase: "saving", original_book_id: "book-a" });
  });
});

describe("createPlacedNote", () => {
  it("creates long-term Notes and promotes an existing session Note without sending anchor authority", async () => {
    const placement = {
      kind: "lid_block" as const,
      source_fingerprint: "a".repeat(64),
      lid: "1.1",
    };
    const createdRecord = {
      mem_id: "mem-created",
      type: "note",
      layer: "long_term",
      book_id: "book-a",
      anchor: { lid: "1.1" },
      content: "agent answer excerpt",
      note_placement: placement,
    };
    const save = vi.fn().mockResolvedValue({ status: "CREATED", record: createdRecord });
    const promote = vi.fn();

    const created = await createPlacedNote(draft(), placement, { save, promote });
    expect(save).toHaveBeenCalledWith({
      type: "note",
      content: "agent answer excerpt",
      layer: "long_term",
      note_placement: placement,
    });
    expect(created).toMatchObject({ status: "CREATED", promoted: false, record: createdRecord });
    expect(promote).not.toHaveBeenCalled();

    const sessionRecord = { ...createdRecord, mem_id: "mem-session", layer: "session" };
    const promotedRecord = { ...sessionRecord, layer: "long_term" };
    save.mockResolvedValueOnce({ status: "EXISTING", record: sessionRecord });
    promote.mockResolvedValueOnce(promotedRecord);
    const existing = await createPlacedNote(draft(), placement, { save, promote });

    expect(promote).toHaveBeenCalledWith("mem-session");
    expect(existing).toMatchObject({ status: "EXISTING", promoted: true, record: promotedRecord });
  });
});

describe("Markdown record reanchor and reconciliation", () => {
  const target = {
    kind: "lid_block" as const,
    source_fingerprint: "current-source",
    lid: "2.2",
  };

  it("reanchors stale and legacy records by old mem_id without sending content authority", async () => {
    const old = record();
    const moved = { ...old, mem_id: "mem-new", anchor: { lid: "2.2" }, note_placement: target };
    const reanchor = vi.fn().mockResolvedValue(moved);

    await expect(reanchorPlacedNote(old, target, { reanchor })).resolves.toEqual(moved);
    expect(reanchor).toHaveBeenCalledWith("mem-old", target);

    const legacy = record({ mem_id: "mem-legacy", note_placement: null });
    reanchor.mockResolvedValueOnce({ ...legacy, mem_id: "mem-upgraded", note_placement: target });
    await expect(reanchorPlacedNote(legacy, target, { reanchor })).resolves.toMatchObject({
      mem_id: "mem-upgraded",
      note_placement: target,
    });

    const selectionBacked = record({ selection_context: { ranges: [] }, note_placement: null });
    await expect(reanchorPlacedNote(selectionBacked, target, { reanchor }))
      .rejects.toThrow("selection-backed");
  });

  it("uses authoritative records to distinguish committed, retryable, and missing reanchors", () => {
    const old = record();
    const moved = { ...old, mem_id: "mem-new", anchor: { lid: "2.2" }, note_placement: target };

    expect(reconcilePlacedNoteReanchor(old, target, [moved])).toEqual({
      outcome: "committed",
      record: moved,
    });
    expect(reconcilePlacedNoteReanchor(old, target, [old])).toEqual({
      outcome: "retry",
      record: old,
    });
    expect(reconcilePlacedNoteReanchor(old, target, [])).toEqual({ outcome: "missing" });
  });

  it("reconciles ambiguous creates only after a long-term target record is authoritative", () => {
    const placed = {
      ...record({ mem_id: "mem-created", content: "agent answer excerpt" }),
      note_placement: target,
    };
    expect(reconcilePlacedNoteCreate(draft({ source_fingerprint: "current-source" }), target, [placed]))
      .toEqual({ outcome: "committed", record: placed });
    expect(reconcilePlacedNoteCreate(
      draft({ source_fingerprint: "current-source" }),
      target,
      [{ ...placed, layer: "session" }],
    )).toEqual({ outcome: "retry" });
    expect(reconcilePlacedNoteCreate(draft({ source_fingerprint: "current-source" }), target, []))
      .toEqual({ outcome: "retry" });
  });

  it("projects only selection Notes and current-source lid placements inline", () => {
    expect(isMarkdownInlineNote(record(), "old-source")).toBe(true);
    expect(isMarkdownInlineNote(record(), "current-source")).toBe(false);
    expect(isMarkdownInlineNote(record({ note_placement: null }), "current-source")).toBe(false);
    expect(isMarkdownInlineNote(record({
      selection_context: {
        status: "resolved",
        raw_quote: "quote",
        resolved_quote: "quote",
        ranges: [{ lid: "1.1", range: { start: 0, end: 5 } }],
      },
      note_placement: null,
    }), "current-source")).toBe(true);
    expect(isMarkdownInlineNote(record({ note_placement: { kind: "pdf_region" } }), "current-source"))
      .toBe(false);
  });
});

describe("NP2a application gate", () => {
  it("routes unquoted Agent excerpts into the controller without a memory mutation", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const rightRail = readFileSync("src/components/RightRail.vue", "utf8");
    const start = app.indexOf("async function saveAgentSelection");
    const end = app.indexOf("async function syncAfterAgentSourceOpen", start);
    const saveAgentSelection = app.slice(start, end);

    expect(saveAgentSelection).toContain("if (!selectionContext)");
    expect(saveAgentSelection).toContain("await api.sourceFingerprint()");
    expect(saveAgentSelection).toContain("notePlacementController.createDraft");
    expect(saveAgentSelection).not.toContain("selectionContext?.ranges[0]?.lid ?? turn.questionAnchorLid");
    expect(saveAgentSelection.match(/await api\.save\(/g)).toHaveLength(1);
    expect(app).toContain("@note-placement-target=\"onMarkdownNotePlacementTarget\"");
    expect(app).toContain("notePlacementController.beginSaving(placement)");
    expect(app).toContain("await createPlacedNote");
    expect(app).toContain("reanchorPlacedNote");
    expect(app).toContain("reconcilePlacedNoteReanchor");
    expect(app).toContain("@place-note=\"startNotePlacement\"");
    expect(app).toContain("saving.original_book_id");
    expect(app).toContain("markdown: true");
    expect(app).toContain("pdf: true");
    const saveNoteStart = app.indexOf("async function saveNote");
    const saveNoteEnd = app.indexOf("async function deleteNote", saveNoteStart);
    const saveNote = app.slice(saveNoteStart, saveNoteEnd);
    expect(saveNote).toContain("await api.note(ed.lid, content)");
    expect(saveNote).toContain("selection_context: ed.selectionContext");

    const noteSelectionStart = app.indexOf("function noteSelection");
    const noteSelectionEnd = app.indexOf("function askSelection", noteSelectionStart);
    expect(app.slice(noteSelectionStart, noteSelectionEnd)).toContain("markdownSelectionContext(p)");

    const keepEffectStart = app.indexOf("async function keepEffect");
    const keepEffectEnd = app.indexOf("function notePlacementDraftId", keepEffectStart);
    expect(app.slice(keepEffectStart, keepEffectEnd)).toContain("await api.promote(e.mem_id)");
    expect(rightRail).toContain("unquotedNotePlacementAvailable");
    expect(rightRail).toContain("!turn.questionSelection && !props.unquotedNotePlacementAvailable");
  });
});
