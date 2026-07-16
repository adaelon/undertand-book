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

## 2026-07-15 PDF Note marker visibility toggle

**Touched**:
- `packages/web/src/components/PdfReaderPane.vue:toggleNoteMarkers/noteMarkersForPage` - adds an accessible header toggle that hides all inline Note markers without changing highlights or annotation projection data.
- `packages/web/src/components/PdfReaderPane.test.ts:PdfReaderPane exact annotation rendering` - covers default visibility, hide/show restoration, retained highlights, and closing an open Note surface.
- `packages/web/playwright/pdf-annotation.spec.ts:desktop/mobile PDF annotation acceptance` - verifies the toggle in real desktop and narrow browser viewports.

**Entry point**: the Eye/EyeOff button in the PDF reader header toggles component-local marker rendering.
**Test**: `pnpm test` (103 tests), `pnpm build`, and `playwright test pdf-annotation.spec.ts` (2 tests).

## 2026-07-16 PDF Note marker toggle setup rebuild

**Touched**:
- `dist/UnderstandBookSetup.exe` - rebuilds the Windows installer with the PDF Note marker visibility toggle.

**Entry point**: `UNDERSTAND_BOOK_MARKETPLACE_SOURCE=adaelon/undertand-book` -> `pnpm -C apps/desktop package:windows` -> `dist/UnderstandBookSetup.exe`.
**Test**: package exit 0; exported setup and Tauri NSIS bundle are both 34,620,383 bytes with SHA-256 `46B0718E4F36565CDEEDBD0325C2C03BBEC83F5CE4A1DE8929A2A1A08C0CB872`.

## 2026-07-16 Single Note marker count affordance

**Touched**:
- `packages/web/src/components/PdfReaderPane.vue:PDF Note marker template` - suppresses the visible count for one Note while retaining counts for exact-anchor aggregates.
- `packages/web/src/components/PdfReaderPane.test.ts:single Note marker rendering` - covers icon-only single markers and preserved accessible count metadata.
- `packages/web/playwright/pdf-annotation.spec.ts:desktop PDF annotation acceptance` - verifies a single marker has no visible number and a two-Note marker still shows `2`.

**Entry point**: exact PDF Note projection -> `PdfReaderPane` Note marker rendering.
**Test**: `pnpm test` (104 tests), `pnpm build`, and `playwright test pdf-annotation.spec.ts` (2 tests).

## 2026-07-16 Single Note marker setup rebuild

**Touched**:
- `dist/UnderstandBookSetup.exe` - rebuilds the Windows installer with icon-only single Note markers and aggregate-only counts.

**Entry point**: `UNDERSTAND_BOOK_MARKETPLACE_SOURCE=adaelon/undertand-book` -> `pnpm -C apps/desktop package:windows` -> `dist/UnderstandBookSetup.exe`.
**Test**: package exit 0; exported setup and Tauri NSIS bundle are both 34,616,812 bytes with SHA-256 `FFCA937D6D2BF478265A8496195F136EB70FFCD5DC0C51BD93054F8C22AFDD71`.

## 2026-07-16 PT0 PDF selection validation extraction

**Touched**:
- `crates/server/src/lib.rs:validate_and_rebuild_selection_quote` - validates non-empty, existing, in-bounds, book-ordered, non-overlapping UTF-16 ranges and rebuilds their canonical book quote.
- `crates/server/src/lib.rs:parse_question_quote` - reuses the shared validator while retaining the Ask AI-specific first-range LID and forged resolved-quote gates.
- `crates/server/src/lib.rs:tests::agent_chat_selection_ranges_rebuild_canonical_quote` - characterizes canonical reconstruction from ordered cross-LID ranges.
- `crates/server/src/lib.rs:tests::agent_chat_selection_ranges_reject_empty_out_of_order_and_overlap` - characterizes empty, out-of-order, and overlapping range rejection.
- `crates/server/src/lib.rs:tests::agent_chat_rejects_forged_canonical_selection_quote` - characterizes rejection of a client-forged resolved quote.

**Entry point**: `/agent/chat` structured `question_quote` validation; PT1 can reuse the same owned-book range validation before translation preparation.
**Test**: `cargo test -p server agent_chat_` (8 tests) and `cargo test -p server` (141 tests).

## 2026-07-16 PT1 PDF selection translation preparation and Provider contract

**Touched**:
- `crates/server/src/lib.rs:prepare_selection_translation` - validates paper selections, chooses resolved/partial source text, applies 4k source and 12k context budgets, deduplicates context LIDs, and selects at most 32 matching lexicon constraints.
- `crates/server/src/lib.rs:selection_translation_prompt/parse_selection_translation_output` - serializes untrusted inputs as JSON data and enforces the single-field non-empty 12k Markdown response contract.
- `crates/server/src/lib.rs:execute_selection_translation` - executes structured translation through a timeout-bound Provider adapter without adding an HTTP route.
- `crates/runtime/src/lib.rs:ProviderRegistry::adapter_from_config_with_timeout` - constructs Native/ReAct adapters whose `ureq` calls use the supplied request timeout.
- `crates/server/src/lib.rs:tests::selection_translation_*` - covers resolved/partial source choice, budgets, lexicon boundaries/aliases/policies, prompt injection boundaries, output rejection, and structured execution.
- `crates/runtime/src/lib.rs:tests::provider_registry_timeout_factory_bounds_native_requests` - proves the factory applies a real request timeout against a stalled local HTTP provider.

**Entry point**: PT2 will call `prepare_selection_translation` while holding `AppState`, then call `execute_selection_translation` after releasing it.
**Test**: `cargo test -p runtime` (144 tests) and `cargo test -p server` (147 tests).

## 2026-07-16 PT2 lock-free PDF selection translation endpoint

**Touched**:
- `crates/server/src/host.rs:route_selection_translation_request` - parses and prepares translation under the `AppState` lock, then executes the frozen Provider work after the guard is dropped.
- `crates/server/src/host.rs:start_server` - routes `POST /reader/selection.translate` through the two-phase handler and snapshots the current Provider configuration per request.
- `crates/server/src/host.rs:SelectionTranslationExecutor` - separates production Provider execution from deterministic blocking/error tests.
- `crates/server/src/host.rs:tests::selection_translation_executes_after_releasing_app_state_lock` - proves another Reader request can acquire and use `AppState` while translation is blocked in Provider execution.
- `crates/server/src/host.rs:tests::selection_translation_endpoint_classifies_method_request_provider_and_capability_errors` - fixes 405/400/404/502 contracts for method, request, selection-map, unconfigured, and Provider failures.
- `docs/architecture.md:Major Data Flows` - records the lock-in/lock-out translation flow and its ADR index.

**Entry point**: HTTP `POST /reader/selection.translate`; the response remains an ephemeral `translation_markdown + zh-CN` projection.
**Test**: `cargo test -p server selection_translation_` (8 tests) and `cargo test -p server` (149 tests).

## 2026-07-16 PT3 PDF selection translation API and controller

**Touched**:
- `packages/web/src/api.ts:SelectionTranslationRequest/SelectionTranslationResponse/api.pdfSelectionTranslate` - adds the typed `POST /reader/selection.translate` client contract without a client request ID.
- `packages/web/src/pdf-selection-translation.ts:usePdfSelectionTranslation` - owns loading/ready/error state, retry, request sequencing, typed errors, invalidation, and deliberately performs no caching or selection action.
- `packages/web/src/App.vue:pdfSelectionTranslation lifecycle wiring` - invalidates translation on new selection, existing action, book switch, viewport interaction, close, and unmount while leaving `usePdfSelectionDraft` independent.
- `packages/web/src/components/PdfReaderPane.vue:onViewportScroll` - emits viewport interaction for scrollbar/programmatic scrolling as well as wheel/pointer/zoom paths.
- `packages/web/src/pdf-selection-translation.test.ts:PDF selection translation controller` - covers exact request payload, stale success/failure, retry, every invalidation reason, no cache, and App/PdfReader lifecycle wiring.
- `docs/architecture.md:Major Data Flows` - records the independent controller state machine and stale-response sequence rule.

**Entry point**: `App.vue` constructs the controller against `api.pdfSelectionTranslate`; PT4 will expose `start()` from the selection toolbar and render its state.
**Test**: `pnpm test` (115 tests) and `pnpm build` in `packages/web`.
