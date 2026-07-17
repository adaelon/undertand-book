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

## 2026-07-16 PT4 PDF selection translation surface

**Touched**:
- `packages/web/src/App.vue:translatePdfSelection/PdfSelectionTranslationSurface` - adds the explicit Languages action without consuming the selection draft, disables other selection actions only while loading, and keeps both close paths available.
- `packages/web/src/components/PdfSelectionTranslationSurface.vue` - renders loading/error/ready states, Markdown and KaTeX output, copy/retry/settings/close actions, desktop clamp-and-flip placement, and a narrow-screen bottom sheet.
- `packages/web/src/components/PdfSelectionTranslationSurface.test.ts:PDF selection translation surface` - covers Markdown/KaTeX output, actions, loading/error controls, desktop placement, and mobile mode.
- `packages/web/pdf-selection-translation-visual.html` and `packages/web/src/pdf-selection-translation-visual.ts` - provide a real controller/component fixture with delayed success and failure Provider responses.
- `packages/web/playwright/pdf-selection-translation.spec.ts:PDF selection translation visual acceptance` - checks stable toolbar dimensions, loading gates, formula rendering, desktop viewport placement, and a 390px bottom sheet.

**Entry point**: select paper PDF text -> click the Languages `翻译` action -> `usePdfSelectionTranslation.start` -> independent translation surface.
**Test**: `pnpm test` (120 tests), `pnpm build`, and `playwright test pdf-selection-translation.spec.ts` (2 tests); desktop and 390px screenshots inspected for overlap and overflow.

## 2026-07-16 PT5 real-book translation acceptance and Windows installer

**Touched**:
- `.understand-book/1` with the configured real Provider - exercises the production `POST /reader/selection.translate` path against owned paper text, lexicon, selection-map capability, and cross-LID formula ranges.
- `dist/UnderstandBookSetup.exe` - rebuilds the Windows installer with PT0-PT4 PDF selection translation.
- `CONTEXT.md`, `docs/adr/0078-pdf-selection-translation-ephemeral-lock-free-bilingual-projection.md`, and `docs/切片方案-pdf选区翻译.md` - freeze the domain terms, decision boundary, slice contract, and acceptance matrix.

**Real Provider acceptance**:
- Ordinary sentence: `However, a detailed characterization...` -> `然而，对人类心脏异构体景观的详细描述仍然不完整。`
- Lexicon: `Alternative splicing...` uses the owned `paper_lexicon` gloss `可变剪接` in a faithful sentence translation.
- Formula Markdown: the Chinese result retains `$P_{adjusted} \leq 0.05$` and `$\geq 0.6$` verbatim for KaTeX rendering.
- Partial: a PDF-visible `devel-\nopment` raw quote translates cleanly while its canonical LID `2.27` range remains provenance/context.
- Error recovery: a forged resolved quote returns HTTP 400 `INVALID_SELECTION_CONTEXT`; the next valid request on the same server process returns HTTP 200.

**Entry point**: `.understand-book/1` -> isolated localhost server with real `.env` Provider -> production translation endpoint; then `UNDERSTAND_BOOK_MARKETPLACE_SOURCE=adaelon/undertand-book` -> `pnpm -C apps/desktop package:windows`.
**Test**: `cargo test -p runtime -p server` (144 + 149 tests), `pnpm test` (120 tests), `pnpm build`, and `playwright test pdf-selection-translation.spec.ts` (2 tests). Package exit 0; exported setup and Tauri NSIS bundle are both 34,646,190 bytes with SHA-256 `6B7AF182C01783D2FBAB7632D1E45B3F5DDFB0D964A43B4426E1DEC5EF893C55`.

## 2026-07-16 PDF translation icon visibility

**Touched**:
- `packages/web/src/components/PdfSelectionTranslationSurface.vue:primary icon buttons` - clears inherited global button padding and flex shrink, then gives Copy/Close fixed 40px hit areas with 22px, 2.2-stroke Lucide icons and visible button boundaries.
- `packages/web/src/components/PdfSelectionTranslationSurface.test.ts:fixed icon size` - locks the Copy/Close class and SVG size/stroke contract.
- `packages/web/playwright/pdf-selection-translation.spec.ts:desktop icon geometry` - verifies merged production CSS yields exact 40px buttons, zero horizontal padding, and 22px SVG bounds.
- `dist/UnderstandBookSetup.exe` - rebuilds the Windows installer with the visible Copy/Close controls.

**Entry point**: ready PDF selection translation surface -> Close in the header or Copy in the footer.
**Test**: red-green component regression (5 tests), full `pnpm test` (121 tests), `pnpm build`, and desktop/mobile Playwright (2 tests) with inspected screenshots. Package exit 0; exported setup and Tauri NSIS bundle are both 34,637,772 bytes with SHA-256 `177F2825C44EF0B82B8CB1281E898ECD3C4FBC7C6C249A185CFF1F58AF91896A`.

## 2026-07-16 PF0 PDF selection mapping stability decision

**Touched**:
- `docs/adr/0079-pdf-selection-banded-reading-order-and-conservative-resynchronization.md:§1-§3` - fixes the banded page-order, unique-anchor recovery, and resolved-only toolbar decisions.
- `docs/切片方案-pdf选区映射稳定性.md:PF0-PF4` - records the reproduced page-5 failure, frozen boundaries, independent implementation slices, and deterministic acceptance matrix.

**Entry point**: reproduced `.understand-book/1` PDF selection instability -> ADR-0079 -> PF1-PF4 implementation order.
**Test**: `git diff --check` for both new documents; links and UTF-8 content inspected.

## 2026-07-16 PF1 banded PDF reading order

**Touched**:
- `packages/core/src/hybrid-foundation.ts:horizontalLineBands/bandLinesInReadingOrder/pageLinesInReadingOrder` - partitions each PDF page by normalized horizontal whitespace before applying existing spanning/single/two-column ordering inside each band.
- `packages/core/src/hybrid-foundation.ts:ALIGNMENT_ALGORITHM` and `packages/core/src/zod.ts:AlignmentReportZ` - bump the artifact freshness contract to `banded_windowed_characters_v4`.
- `packages/core/test/hybrid-foundation.test.ts:keeps a top two-column body ahead of a dense lower figure band` - reproduces a right-column continuation hidden behind more than 240 words of lower figure text and locks its LID/selection-char mapping.

**Entry point**: PH5 `buildHybridFoundation` -> page geometry reading order -> block and selection-map alignment.
**Test**: red-green targeted regression; `pnpm test -- test/hybrid-foundation.test.ts` (16 tests) and `pnpm typecheck` in `packages/core`.

## 2026-07-16 PF2 conservative PDF paragraph resynchronization

**Touched**:
- `packages/core/src/hybrid-foundation.ts:bestLineMatchAt/findLinesForBlock` - keeps the 240-word local search first, then accepts recovery only for one unique 6+ token anchor on the current or following page.
- `packages/core/src/hybrid-foundation.ts:recoveryAnchorLineOccurrences` - preserves PDF line-end hyphenation semantics while retaining token-to-line provenance for the unique-anchor prefilter.
- `packages/core/src/hybrid-foundation.ts:PdfLineMatch/alignment reason` - marks recovered matches explicitly and lowers their confidence without changing LID/range truth.
- `packages/core/test/hybrid-foundation.test.ts:paragraph resynchronization regressions` - covers unique recovery, line-end hyphenation, repeated-anchor rejection, one-page distance, and post-recovery cursor continuity.

**Entry point**: a PH5 source block misses the local alignment window -> bounded deterministic recovery -> later blocks continue from the recovered cursor.
**Test**: red-green four-case regression; full `pnpm test` (223 tests) and `pnpm typecheck` in `packages/core`.

## 2026-07-16 PF3 resolved-only PDF selection toolbar

**Touched**:
- `packages/web/src/App.vue:PDF selection toolbar gate` - mounts the action toolbar only for an error or an owned partial/resolved draft, never for the pending resolving phase.
- `packages/web/playwright/pdf-selection-actions.spec.ts:pending and unresolved PDF selection never renders an action toolbar` - holds the resolve response for one second, checks the pending DOM synchronously, and proves native selection survives the unresolved response.

**Entry point**: `PdfReaderPane` mouseup capture -> `usePdfSelectionDraft.resolveCapture` -> toolbar appears only after a usable draft exists.
**Test**: red-green Playwright regression; full `pnpm test` (124 tests), `pnpm build`, and `playwright test pdf-selection-actions.spec.ts` (4 tests) in `packages/web`.

## 2026-07-16 PF4 real-book PDF selection mapping acceptance

**Touched**:
- `.understand-book/1:hybrid foundation artifacts` - atomically applies the audited `banded_windowed_characters_v4` candidate while preserving canonical source, original PDF, all 424 LIDs, and the semantic graph digest.
- `.understand-book/1/.build/hybrid-foundation-backup-2026-07-16T14-21-32-476Z` - retains the pre-PF4 artifact rollback point.
- `docs/切片方案-pdf选区映射稳定性.md:PF4` - records final mapping ratios, page-level selectable-character coverage, runtime behavior, and the rollback location.
- `docs/architecture.md:Major Data Flows/Decision Index` - records the banded order and bounded recovery contract and indexes ADR-0079.

**Entry point**: audited temp rebuild -> hard-gated atomic artifact apply -> live localhost API -> physical Chromium PDF selection.
**Test**: candidate and official hard gates pass; `206/258` alignable text and `29/29` headings map with no page regression; pages 5/6/7/10/11 selectable-character coverage rises to `41.7%/76.5%/39.7%/21.1%/86.2%`; physical mapped/unmapped selection proves resolved-only toolbar behavior. Final checks: Core `223` tests plus typecheck, Web `124` tests plus build, selection Playwright `4` tests, and server `pdf_selection_` `4` tests.

## 2026-07-17 PE0 PDF selection boundary decision

**Touched**:
- `docs/adr/0080-pdf-text-layer-native-selection-lifecycle.md:§1` - assigns native PDF selection ownership to the public PDF.js TextLayerBuilder lifecycle.
- `docs/切片方案-pdf选区边界稳定性.md:PE0-PE4` - freezes the reproduced line/paragraph-end expansion, repair boundary, slices, and deterministic acceptance matrix.

**Entry point**: physical PDF drag ending 2px past a text span -> expanded native Selection -> ADR-0080 -> PE1-PE4.
**Test**: both documents were read back as UTF-8; reciprocal links and the no-backend-change boundary were inspected.

## 2026-07-17 PE1 physical PDF trailing-boundary regression

**Touched**:
- `packages/web/playwright/pdf-selection-actions.spec.ts:boundaryPdfFixture/dragPastTextEnd` - adds real-pointer line-end and paragraph-end cases plus resolve-request capture.

**Entry point**: Playwright mouse down inside a PDF text span -> drag 2px beyond its right edge -> native Selection and resolve request.
**Test**: red run proves both cases fail before production changes: the line target includes two later lines and the paragraph target includes three later lines.

## 2026-07-17 PE2 PDF.js native selection ownership

**Touched**:
- `packages/web/src/components/PdfReaderPane.vue:renderTextLayer/textLayerTasks` - replaces the low-level TextLayer with public TextLayerBuilder ownership and retains each builder until deterministic cancel on rerender or unmount.
- `packages/web/src/components/PdfReaderPane.vue:.textLayer/.endOfContent styles` - scopes the PDF.js text and native-selection CSS contract to the reader text layer.
- `packages/web/src/components/PdfReaderPane.test.ts:TextLayerBuilder mocks/zoom lifecycle` - proves append/render wiring and cancellation before replacement builders are created.

**Entry point**: PDF page render -> TextLayerBuilder native selection lifecycle -> existing mouseup capture.
**Test**: `PdfReaderPane.test.ts` 9/9, Web typecheck, and physical line/paragraph trailing-whitespace Playwright 2/2.

## 2026-07-17 PE3 PDF selection boundary Web regression

**Touched**:
- `packages/web:production bundle` - compiles the scoped TextLayerBuilder integration without importing the global PDF viewer stylesheet.

**Entry point**: all Web reader interactions sharing PdfReaderPane after the native-selection ownership change.
**Test**: Web 24 files/124 tests; production typecheck/build; selection actions Playwright 6/6; translation and annotation Playwright 4/4. Built CSS contains only scoped `.textLayer/.endOfContent` selectors and no global `.pdfViewer/.toolbar` selectors.

## 2026-07-17 PE4 real-book PDF boundary acceptance and Windows installer

**Touched**:
- `.understand-book/1:pageIndex 5 native text layer` - exercises the production browser Selection and resolve request without changing canonical or mapping artifacts.
- `docs/architecture.md:Major Data Flows/Decision Index` - records TextLayerBuilder ownership, cancellation boundaries, and ADR-0080.
- `dist/UnderstandBookSetup.exe` - rebuilds the Windows installer from a detached `ea34a82` worktree containing only the production PdfReaderPane change.

**Entry point**: physical Chromium drag 2px beyond the frozen line/paragraph targets -> builder-stabilized Selection -> existing resolve API; then isolated `package:windows`.
**Test**: `Due to its tolerance` is 20/20 and `2A and 2B).` is 11/11; each native Selection/request has one rect and exact `raw_quote`, with HTTP 200 responses. The resolved line target renders one toolbar and the unresolved paragraph target renders none, preserving the existing gate. Packaging exits 0; exported Setup and NSIS bundle are both 34,754,425 bytes with SHA-256 `ECE6D45232EC4B69C89320D80F3F574BC4B143A0BAC13C94B9D60CE3D1D0D061`. The installer was not launched.

## 2026-07-17 PE5 PDF mid-line selection hit testing

**Touched**:
- `packages/web/src/components/PdfReaderPane.vue:.textLayer .endOfContent` - restores the official selector specificity so the expanded selection tail remains below text at effective `z-index: 0`.
- `packages/web/playwright/pdf-selection-actions.spec.ts:dragBetweenTextOffsets/physical selection can start in the middle` - calibrates character pixels with a Range, then uses only real mouse input to lock the native anchor and request quote.
- `packages/web/src/components/PdfReaderPane.test.ts:scoped endOfContent selector assertion` - prevents regression to the lower-specificity selector.
- `dist/UnderstandBookSetup.exe` - rebuilds the installer from a detached clean Rust tree plus the final PdfReaderPane production file.

**Entry point**: pointer down over a middle character -> TextLayerBuilder expands `.endOfContent` -> pointer move continues to hit the text span -> existing mouseup capture.
**Test**: red evidence shows offset 15 is correct on pointer down, then effective `z-index: 1` makes `.endOfContent` the top hit and collapses the caret to the outer wrapper. Green evidence: fixture selects `fixture text`; real pageIndex 5 selects/sends `its tolerance` with anchor 7, focus 20, and one rect. Selection actions 7/7, Web 24 files/124 tests, and production build pass. Final Setup/NSIS are both 34,761,794 bytes with SHA-256 `755096BA8E08E9CAF6DF30D9F9C2CB294FF3592CE7F0FF58379F2CF4618DB467`; installer not launched.

## 2026-07-17 TS1 PDF selection translation source-boundary red test

**Touched**:
- `crates/server/src/lib.rs:tests::selection_translation_prompt_limits_output_to_source_markdown` - characterizes a selected suffix whose reference context still contains an unselected prefix, then requires explicit source-only system and user-message roles.
- `docs/切片方案-pdf选区翻译源文边界.md:TS1` - freezes the prompt-first repair boundary and red-green acceptance sequence.

**Entry point**: `prepare_selection_translation` builds distinct `source_markdown` and full-LID context -> `selection_translation_prompt` serializes the Provider request.
**Test**: `cargo test -p server selection_translation_prompt_limits_output_to_source_markdown` fails only because the current system prompt lacks the exact-source rule; production prompt remains unchanged in this slice.

## 2026-07-17 TS2 PDF selection translation prompt source boundary

**Touched**:
- `crates/server/src/lib.rs:selection_translation_prompt` - declares `source_markdown` as the sole output scope, marks context as reference-only, and serializes full-LID context below `reference_only.context_blocks`.
- `crates/server/src/lib.rs:tests::selection_translation_prompt_limits_output_to_source_markdown` - turns the TS1 selected-suffix regression green without removing context or changing preparation budgets.

**Entry point**: `POST /reader/selection.translate` -> prepared source/context/terminology -> source-scoped structured Provider prompt.
**Test**: targeted source-boundary test 1/1, `cargo test -p server selection_translation_` 9/9, and `cargo test -p server` 154/154; `git diff --check` passes for the slice. Package-wide rustfmt check remains blocked by pre-existing formatting drift outside this change.

## 2026-07-17 TS3 real-book translation source-boundary acceptance

**Touched**:
- `.understand-book/1:pageIndex 1 Tissue Acquisition selection` - replays the exact 13-line native selection from `The heart was transected...` through the material transfer agreement.
- `.tmp-ts3-target/debug/server.exe` - isolates a newly built prompt implementation at `127.0.0.1:8795` without replacing or stopping the existing `8794` server.

**Entry point**: real selection-map rects -> `POST /reader/pdf_selection.resolve` -> identical `partial` translation request repeated five times against the configured Provider.
**Test**: resolver is HTTP 200 `partial` with 13 ranges; all 5 isolated translations plus one request after restarting the active `8794` backend are HTTP 200, retain selected `15` and `80`, start at the selected heart-transection sentence, end at the material transfer agreement, and exclude context-only `PRO00006097` and `STU00216333`.

## 2026-07-17 TS5 Windows installer rebuild

**Touched**:
- `02e123b fix(reader): constrain PDF translation to selected text` - freezes the exact source snapshot used for packaging and excludes the existing PE0-PE5, memory/profile, and other dirty-worktree changes.
- `dist/UnderstandBookSetup.exe` - replaces the ignored local installer with the NSIS export built from the detached snapshot.

**Entry point**: detached `02e123b` worktree -> offline frozen pnpm install -> `pnpm -C apps/desktop package:windows` -> exported Setup -> SHA-256 verification and copy to the main workspace.
**Test**: package command exits 0 after Web production build, sidecar build, Rust release compile, and NSIS bundling. The NSIS source, detached export, and final Setup are all 34,662,819 bytes with SHA-256 `2F431F7225FE7DB4F938E4F4C6ACD45217163C116E4E502AC0D58A0E8205E006`; file/product version is `0.1.0`. The installer is unsigned and was not launched.
