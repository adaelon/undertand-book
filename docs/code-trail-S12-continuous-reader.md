# Code Trail · S12 continuous reader documentation

## 2026-07-01 S12 continuous reader model decision docs

**Touched**:
- `docs/adr/0043-reader连续滚动视口-后端区间窗口-前端虚拟流-note-overlay.md` - records the accepted continuous scrolling reader architecture.
- `docs/切片方案-S12连续滚动阅读模型.md` - decomposes implementation into S12a-S12e verifiable slices.

**Entry point**: future implementation starts at S12a reader viewport interval semantics.
**Test**: `rg "ADR-0043|S12a reader viewport interval semantics|连续滚动阅读模型" docs/adr docs/切片方案-S12连续滚动阅读模型.md docs/code-trail-S12-continuous-reader.md`.

## 2026-07-15 Reader annotation book isolation

**Touched**:
- `packages/web/src/App.vue:refreshAnnotations` - loads annotations with the active book ID and rejects responses from a book that is no longer active.
- `packages/web/src/reader-annotations.ts:recallBookAnnotations` - requests and defensively retains only records owned by the current book.
- `packages/web/src/reader-annotations.test.ts:reader annotation scope` - covers the cross-book Note and Highlight exclusion contract.

**Entry point**: reader window loading and annotation mutations call `refreshAnnotations` before rendering right-rail Notes, inline Notes, Highlights, and PDF projections.
**Test**: `pnpm test` (101 tests) and `pnpm build` in `packages/web`.

## 2026-07-15 Agent Note PDF provenance

**Touched**:
- `packages/web/src/App.vue:saveAgentSelection` - persists the originating question's selection context when saving an Agent answer excerpt as a Note.
- `packages/web/src/agent-note-selection.ts:selectionContextForAgentNote` - converts complete structured question provenance into a copied memory selection context without inventing legacy ranges.
- `packages/web/src/agent-note-selection.test.ts:Agent answer selection Note provenance` - covers provenance inheritance through exact PDF Note marker projection and the legacy fallback.

**Entry point**: selecting text in an Agent answer and invoking Save Note emits `save-answer-selection`, which calls `saveAgentSelection`.
**Test**: `pnpm test` (103 tests) and `pnpm build` in `packages/web`.

## 2026-07-15 PDF selection contiguous source ranges

**Touched**:
- `crates/server/src/lib.rs:route_pdf_selection_resolve` - emits ordered ranges for contiguous source runs instead of merging every selected character with the same LID across source gaps.
- `crates/server/src/lib.rs:tests::pdf_selection_splits_same_lid_source_gaps_into_exact_ranges` - reproduces the former over-wide range and verifies both split ranges project back to exact PDF geometry.

**Entry point**: a PDF text selection calls `/reader/pdf_selection.resolve`; the returned ranges are stored in Note selection context and later sent to `/reader/pdf_ranges.project` for inline markers.
**Test**: `cargo test -p server pdf_selection_` (4 tests) and `cargo test -p server` (138 tests).

## 2026-07-15 Current-book PDF Note setup rebuild

**Touched**:
- `dist/UnderstandBookSetup.exe` - rebuilds the Windows installer with current-book annotation recall, Agent Note selection ranges, and contiguous PDF source-range resolution.

**Entry point**: `UNDERSTAND_BOOK_MARKETPLACE_SOURCE=adaelon/undertand-book` -> `pnpm -C apps/desktop package:windows` -> `dist/UnderstandBookSetup.exe`.
**Test**: package exit 0; exported setup and Tauri NSIS bundle are both 34,623,533 bytes with SHA-256 `0B580CFA83FE9737B7FB5F90C24AB2979E0576428763A598FC975A4A328A530D`.
