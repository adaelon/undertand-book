import { ref } from "vue";
import type { MemoryRecord, NoteBodyPlacement, NoteSaveOutcome } from "./api";

export type NotePlacementSurface = "markdown" | "pdf";

export interface NotePlacementCapabilities {
  markdown: boolean;
  pdf: boolean;
}

export interface NotePlacementDraftInput {
  draft_id: string;
  book_id: string;
  surface_kind: NotePlacementSurface;
  source_fingerprint: string;
  content: string;
  origin: {
    kind: "agent_answer";
    chat_session_id: string;
  };
}

export type NotePlacementDraft = Readonly<NotePlacementDraftInput>;

export interface NotePlacementRecordInput {
  record: MemoryRecord;
  book_id: string;
  surface_kind: NotePlacementSurface;
  source_fingerprint: string;
}

export type PlacementSubject =
  | { kind: "draft"; draft_id: string }
  | { kind: "record"; mem_id: string };

interface PlacementSession {
  subject: PlacementSubject;
  draft: NotePlacementDraft | null;
  record: MemoryRecord | null;
  book_id: string;
  surface_kind: NotePlacementSurface;
  source_fingerprint: string;
}

export type NotePlacementState =
  | { phase: "idle" }
  | (PlacementSession & { phase: "placing"; error: string | null })
  | (PlacementSession & {
      phase: "saving";
      target: NoteBodyPlacement;
      original_book_id: string;
    })
  | (PlacementSession & {
      phase: "reconciling";
      target: NoteBodyPlacement;
      original_book_id: string;
      reason: string;
    });

export interface NotePlacementContext {
  book_id: string;
  surface_kind: NotePlacementSurface;
  source_fingerprint: string;
}

export type NotePlacementContextResult = "unchanged" | "discarded" | "locked";

const idleState = (): NotePlacementState => ({ phase: "idle" });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameContext(session: PlacementSession, context: NotePlacementContext): boolean {
  return session.book_id === context.book_id
    && session.surface_kind === context.surface_kind
    && session.source_fingerprint === context.source_fingerprint;
}

function targetMatchesSession(session: PlacementSession, target: NoteBodyPlacement): boolean {
  return target.source_fingerprint === session.source_fingerprint
    && ((session.surface_kind === "markdown" && target.kind === "lid_block")
      || (session.surface_kind === "pdf" && target.kind === "pdf_region"));
}

export function notePlacementCapability(
  surface: NotePlacementSurface,
  capabilities: NotePlacementCapabilities,
): boolean {
  return capabilities[surface];
}

export interface NotePlacementMutationPort {
  save(input: {
    type: "note";
    content: string;
    layer: "long_term";
    note_placement: NoteBodyPlacement;
  }): Promise<MemoryRecord | NoteSaveOutcome>;
  promote(memId: string): Promise<MemoryRecord>;
}

export function canStartNoteRecordPlacement(
  record: MemoryRecord,
  surface: NotePlacementSurface,
): boolean {
  if (record.type !== "note" || record.selection_context) return false;
  if (!record.note_placement) return true;
  return (surface === "markdown" && record.note_placement.kind === "lid_block")
    || (surface === "pdf" && record.note_placement.kind === "pdf_region");
}

export function isMarkdownInlineNote(
  record: MemoryRecord,
  currentSourceFingerprint: string | null,
): boolean {
  if (record.type !== "note") return false;
  if (record.selection_context) return true;
  return record.note_placement?.kind === "lid_block"
    && record.note_placement.source_fingerprint === currentSourceFingerprint
    && record.anchor.lid === record.note_placement.lid;
}

export interface PlacedNoteCreateResult {
  status: NoteSaveOutcome["status"];
  record: MemoryRecord;
  promoted: boolean;
}

function isNoteSaveOutcome(value: MemoryRecord | NoteSaveOutcome): value is NoteSaveOutcome {
  return "status" in value && "record" in value;
}

export async function createPlacedNote(
  draft: NotePlacementDraft,
  placement: NoteBodyPlacement,
  port: NotePlacementMutationPort,
): Promise<PlacedNoteCreateResult> {
  const placementMatchesDraft = placement.source_fingerprint === draft.source_fingerprint
    && ((draft.surface_kind === "markdown" && placement.kind === "lid_block")
      || (draft.surface_kind === "pdf" && placement.kind === "pdf_region"));
  if (!placementMatchesDraft) throw new Error("Note placement target does not match its draft context");

  const outcome = await port.save({
    type: "note",
    content: draft.content,
    layer: "long_term",
    note_placement: placement,
  });
  if (!isNoteSaveOutcome(outcome)) {
    throw new Error("Placed Note save did not return CREATED or EXISTING");
  }
  if (outcome.status === "EXISTING" && outcome.record.layer === "session") {
    return {
      status: outcome.status,
      record: await port.promote(outcome.record.mem_id),
      promoted: true,
    };
  }
  return { status: outcome.status, record: outcome.record, promoted: false };
}

export interface NoteReanchorMutationPort {
  reanchor(memId: string, placement: NoteBodyPlacement): Promise<MemoryRecord>;
}

function samePlacement(
  left: NoteBodyPlacement | null | undefined,
  right: NoteBodyPlacement,
): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === "lid_block" && right.kind === "lid_block") {
    return left.source_fingerprint === right.source_fingerprint && left.lid === right.lid;
  }
  if (left.kind !== "pdf_region" || right.kind !== "pdf_region") return false;
  return left.source_fingerprint === right.source_fingerprint
    && left.lid === right.lid
    && left.source_map_version === right.source_map_version
    && left.source_map_config_hash === right.source_map_config_hash
    && left.page_index === right.page_index
    && left.region_id === right.region_id;
}

export async function reanchorPlacedNote(
  record: MemoryRecord,
  placement: NoteBodyPlacement,
  port: NoteReanchorMutationPort,
): Promise<MemoryRecord> {
  if (record.selection_context) {
    throw new Error("selection-backed Notes require explicit reselection");
  }
  const surface = placement.kind === "lid_block" ? "markdown" : "pdf";
  if (!canStartNoteRecordPlacement(record, surface)) {
    throw new Error("Note placement cannot cross reader surfaces");
  }
  return port.reanchor(record.mem_id, placement);
}

export type PlacedNoteReconciliation =
  | { outcome: "committed"; record: MemoryRecord }
  | { outcome: "retry"; record?: MemoryRecord }
  | { outcome: "missing" };

export function reconcilePlacedNoteCreate(
  draft: NotePlacementDraft,
  placement: NoteBodyPlacement,
  records: MemoryRecord[],
): PlacedNoteReconciliation {
  const placed = records.find((record) =>
    record.type === "note"
    && record.book_id === draft.book_id
    && record.content === draft.content
    && samePlacement(record.note_placement, placement)
  );
  if (placed?.layer === "long_term") return { outcome: "committed", record: placed };
  return { outcome: "retry" };
}

export function reconcilePlacedNoteReanchor(
  original: MemoryRecord,
  placement: NoteBodyPlacement,
  records: MemoryRecord[],
): PlacedNoteReconciliation {
  const old = records.find((record) => record.mem_id === original.mem_id);
  if (old) return { outcome: "retry", record: old };
  const moved = records.find((record) =>
    record.type === "note"
    && record.book_id === original.book_id
    && record.content === original.content
    && record.layer === original.layer
    && samePlacement(record.note_placement, placement)
  );
  return moved ? { outcome: "committed", record: moved } : { outcome: "missing" };
}

export function useNotePlacementController() {
  const state = ref<NotePlacementState>(idleState());

  function createDraft(input: NotePlacementDraftInput): boolean {
    if (state.value.phase === "saving" || state.value.phase === "reconciling") return false;
    const draft: NotePlacementDraft = {
      ...input,
      origin: { ...input.origin },
    };
    state.value = {
      phase: "placing",
      subject: { kind: "draft", draft_id: draft.draft_id },
      draft,
      record: null,
      book_id: draft.book_id,
      surface_kind: draft.surface_kind,
      source_fingerprint: draft.source_fingerprint,
      error: null,
    };
    return true;
  }

  function startRecord(input: NotePlacementRecordInput): boolean {
    if (state.value.phase === "saving" || state.value.phase === "reconciling") return false;
    if (input.record.book_id !== input.book_id
      || !canStartNoteRecordPlacement(input.record, input.surface_kind)) {
      return false;
    }
    state.value = {
      phase: "placing",
      subject: { kind: "record", mem_id: input.record.mem_id },
      draft: null,
      record: input.record,
      book_id: input.book_id,
      surface_kind: input.surface_kind,
      source_fingerprint: input.source_fingerprint,
      error: null,
    };
    return true;
  }

  function cancel(): boolean {
    if (state.value.phase !== "placing") return false;
    state.value = idleState();
    return true;
  }

  function synchronizeContext(context: NotePlacementContext): NotePlacementContextResult {
    const current = state.value;
    if (current.phase === "idle" || sameContext(current, context)) return "unchanged";
    if (current.phase === "saving" || current.phase === "reconciling") return "locked";
    state.value = idleState();
    return "discarded";
  }

  function beginSaving(target: NoteBodyPlacement): Extract<NotePlacementState, { phase: "saving" }> | null {
    const current = state.value;
    if (current.phase !== "placing" || !targetMatchesSession(current, target)) return null;
    const saving: Extract<NotePlacementState, { phase: "saving" }> = {
      phase: "saving",
      subject: current.subject,
      draft: current.draft,
      record: current.record,
      book_id: current.book_id,
      surface_kind: current.surface_kind,
      source_fingerprint: current.source_fingerprint,
      target,
      original_book_id: current.book_id,
    };
    state.value = saving;
    return saving;
  }

  function saveFailed(error: unknown): boolean {
    const current = state.value;
    if (current.phase !== "saving") return false;
    state.value = {
      phase: "placing",
      subject: current.subject,
      draft: current.draft,
      record: current.record,
      book_id: current.book_id,
      surface_kind: current.surface_kind,
      source_fingerprint: current.source_fingerprint,
      error: errorMessage(error),
    };
    return true;
  }

  function reconcileRequired(reason: string): boolean {
    const current = state.value;
    if (current.phase !== "saving") return false;
    state.value = {
      ...current,
      phase: "reconciling",
      reason,
    };
    return true;
  }

  function reconciled(outcome: "committed" | "retry" | "missing"): boolean {
    const current = state.value;
    if (current.phase !== "reconciling") return false;
    if (outcome === "committed" || outcome === "missing") {
      state.value = idleState();
      return true;
    }
    state.value = {
      phase: "placing",
      subject: current.subject,
      draft: current.draft,
      record: current.record,
      book_id: current.book_id,
      surface_kind: current.surface_kind,
      source_fingerprint: current.source_fingerprint,
      error: current.reason,
    };
    return true;
  }

  function saveSucceeded(): boolean {
    if (state.value.phase !== "saving" && state.value.phase !== "reconciling") return false;
    state.value = idleState();
    return true;
  }

  return {
    state,
    createDraft,
    startRecord,
    cancel,
    synchronizeContext,
    beginSaving,
    saveFailed,
    reconcileRequired,
    reconciled,
    saveSucceeded,
  };
}
