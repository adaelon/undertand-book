import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord, NoteBodyPlacement } from "./api";
import {
  canStartNoteRecordPlacement,
  createPlacedNote,
  reanchorPlacedNote,
  reconcilePlacedNoteCreate,
  reconcilePlacedNoteReanchor,
  useNotePlacementController,
  type NotePlacementDraftInput,
} from "./note-placement";

const pdfPlacement: Extract<NoteBodyPlacement, { kind: "pdf_region" }> = {
  kind: "pdf_region",
  source_fingerprint: "a".repeat(64),
  lid: "1.1",
  source_map_version: "pdf_source_map.v1",
  source_map_config_hash: "cfg-v1",
  page_index: 0,
  region_id: "word-1",
};

function draft(): NotePlacementDraftInput {
  return {
    draft_id: "draft-pdf",
    book_id: "paper-a",
    surface_kind: "pdf",
    source_fingerprint: "a".repeat(64),
    content: "agent answer excerpt",
    origin: { kind: "agent_answer", chat_session_id: "chat-a" },
  };
}

function note(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    mem_id: "note-old",
    type: "note",
    layer: "long_term",
    book_id: "paper-a",
    anchor: { lid: "1.1", concept: null },
    content: "existing note",
    note_placement: pdfPlacement,
    ...overrides,
  };
}

describe("PDF Note placement flow", () => {
  it("locks an actual PDF target and creates or promotes by its full region identity", async () => {
    const controller = useNotePlacementController();
    expect(controller.createDraft(draft())).toBe(true);
    const saving = controller.beginSaving(pdfPlacement);
    expect(saving).toMatchObject({
      phase: "saving",
      surface_kind: "pdf",
      target: pdfPlacement,
    });
    expect(controller.cancel()).toBe(false);

    const session = note({ mem_id: "note-session", layer: "session" });
    const promoted = { ...session, layer: "long_term" };
    const save = vi.fn().mockResolvedValue({ status: "EXISTING", record: session });
    const promote = vi.fn().mockResolvedValue(promoted);
    await expect(createPlacedNote(draft(), pdfPlacement, { save, promote })).resolves.toEqual({
      status: "EXISTING",
      record: promoted,
      promoted: true,
    });
    expect(save).toHaveBeenCalledWith({
      type: "note",
      content: "agent answer excerpt",
      layer: "long_term",
      note_placement: pdfPlacement,
    });
    expect(promote).toHaveBeenCalledWith("note-session");
  });

  it("reanchors PDF and legacy records atomically and reconciles from authoritative reloads", async () => {
    const old = note();
    const moved = { ...old, mem_id: "note-new", note_placement: pdfPlacement };
    const reanchor = vi.fn().mockResolvedValue(moved);
    await expect(reanchorPlacedNote(old, pdfPlacement, { reanchor })).resolves.toEqual(moved);
    expect(reanchor).toHaveBeenCalledWith("note-old", pdfPlacement);

    const legacy = note({ mem_id: "legacy", note_placement: null });
    expect(canStartNoteRecordPlacement(legacy, "pdf")).toBe(true);
    expect(canStartNoteRecordPlacement(note({
      note_placement: { kind: "lid_block", source_fingerprint: "a".repeat(64), lid: "1.1" },
    }), "pdf")).toBe(false);

    expect(reconcilePlacedNoteCreate(draft(), pdfPlacement, [
      { ...moved, content: draft().content },
    ])).toMatchObject({ outcome: "committed", record: { mem_id: "note-new" } });
    expect(reconcilePlacedNoteReanchor(old, pdfPlacement, [moved]))
      .toMatchObject({ outcome: "committed", record: { mem_id: "note-new" } });
    expect(reconcilePlacedNoteReanchor(old, pdfPlacement, [old]))
      .toMatchObject({ outcome: "retry", record: { mem_id: "note-old" } });
    expect(reconcilePlacedNoteReanchor(old, pdfPlacement, [])).toEqual({ outcome: "missing" });
  });

  it("enables and wires the PDF capability without changing selection-backed Note handling", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const paneStart = app.indexOf("<PdfReaderPane");
    const pane = app.slice(paneStart, app.indexOf("/>", paneStart) + 2);
    expect(app).toContain("pdf: true");
    expect(app).toContain("async function onPdfNotePlacementTarget");
    expect(app).toContain("source_map_version: map.version");
    expect(app).toContain("source_map_config_hash: map.config_hash");
    expect(app).toContain("page_index: target.region.pageIndex");
    expect(app).toContain("region_id: target.region.region_id");
    expect(app).toContain("async function startNotePlacement");
    expect(app).toContain('const targetLabel = surface === "pdf" ? "PDF 正文区域" : "正文块";');
    expect(app).toContain('if (!note.selection_context && note.note_placement?.kind === "pdf_region")');
    expect(app).toContain("void startNotePlacement(note)");
    expect(app).toContain('pdfReselectTarget.value = { kind: "note", record: note }');
    expect(app).toContain("surface_kind: saving.surface_kind");
    expect(pane).toContain(":note-placement-active=");
    expect(pane).toContain('@note-placement-target="onPdfNotePlacementTarget"');
    expect(app).toContain('@place-note="startNotePlacement"');
  });
});
