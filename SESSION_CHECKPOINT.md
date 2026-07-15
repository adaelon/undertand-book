# SESSION_CHECKPOINT - 2026-07-15 23:19 +08:00

## Freshness check
- Commit at write time: `2dce7b8 fix: restore book-scoped PDF note markers`.
- On read, compare with `git log -3 --oneline`; if newer commits exist, trust Git.
- Verified installer: `dist/UnderstandBookSetup.exe`, 34,623,533 bytes, SHA-256 `0B580CFA83FE9737B7FB5F90C24AB2979E0576428763A598FC975A4A328A530D`, built 2026-07-15 23:02:34 +08:00.

## What's in progress
The book-scoped PDF annotation and Agent Note range repair is implemented and packaged; only post-install visual acceptance with newly created notes remains.

## Next steps (ready to hand off)
1. After the user closes the installed Reader and runs `dist/UnderstandBookSetup.exe`, open the affected PDF book and confirm its existing Highlight renders without the annotation-location-unavailable banner.
2. In an Agent conversation backed by a resolved PDF question selection, select answer text, save a new Note, and confirm the PDF body shows its Note marker.
3. If either check fails, query `/api/book/build_workbench`, `/api/memory/recall` with the active `book_id`, and `/api/reader/pdf_ranges.project` for that record's ranges before changing code.
4. Do not use legacy Agent Notes as acceptance evidence: records created without exact `selection_context.ranges` are intentionally not migrated.

## Uncommitted / unfinished
- This repair has no uncommitted source changes; implementation and tests are in `2dce7b8`.
- Pre-existing tracked modifications remain in `crates/base-schema/tests/roundtrip.rs`, `crates/memory/src/{lib,profile,review}.rs`, and `crates/reader/src/lib.rs`; they were not staged, reverted, or tested by this slice.
- Existing untracked logs, screenshots, drafts, books, test results, and temporary directories remain unrelated and untouched.
- Visual acceptance is pending because the new setup was built but not installed or launched by this session.

## Cold-start reading sequence
1. `docs/code-trail-S12-continuous-reader.md` - the three 2026-07-15 repair entries and setup fingerprint.
2. `packages/web/src/reader-annotations.ts` and its test, then `packages/web/src/App.vue:refreshAnnotations` - current-book recall and stale-response guard.
3. `packages/web/src/agent-note-selection.ts` and its test, then `packages/web/src/App.vue:saveAgentSelection` - structured Agent Note provenance without legacy range fabrication.
4. `crates/server/src/lib.rs:route_pdf_selection_resolve` and `pdf_selection_splits_same_lid_source_gaps_into_exact_ranges` - ordered contiguous source-run resolution and reverse-projection regression.
5. `packages/web/src/pdf-annotation-projection.ts` and `packages/web/src/components/PdfReaderPane.vue` - exact-only PDF strokes and Note marker rendering.

## Decisions made this session
- Reader annotations are recalled with the active `book_id` and defensively filtered client-side; logged in `docs/code-trail-S12-continuous-reader.md`.
- Agent answer Notes inherit only complete structured question ranges; legacy turns do not receive fabricated provenance.
- Same-LID PDF selection hits separated by source gaps become multiple ordered ranges; existing malformed Notes are not backfilled.
