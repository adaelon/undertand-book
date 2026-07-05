# SESSION_CHECKPOINT - 2026-07-06 00:48

## Freshness Check
- Last committed base when written: `4966e9e fix: harden native provider compatibility`.
- This checkpoint is written immediately before the requested feature commit+push. On read, compare `git log -3` and `git status --short`; trust git if newer.

## Current Work
PF24-PF26 are implemented and verified:
- PF24 image assets: Markdown/EPUB/data-uri images are copied into `.understand-book/<bookId>/assets/images/`, indexed by `asset_manifest.json`, served by `/book/assets/...`, and rendered by the web reader/source preview.
- PF25 open-book picker: TopBar `Open book` opens a modal listing built `.understand-book/<book_id>` directories from `/book/library`, with manual path fallback.
- PF26 per-book progress: `session.json` now stores `current_book_dir` plus `books.{dir}.top_lid`, keeps old `{book_dir, top_lid}` compatibility, and restores each book to its own saved position.

## Next Steps
1. Commit and push the PF24-PF26 changes if not already committed.
2. Start the real paper prebuild only after the real input path is known. Do not guess from untracked scratch Markdown files.
3. For a real paper input, first run:
   `.\node_modules\.bin\tsx.ps1 skills\build\build-status.ts <paper.md|epub> --content-profile paper --paper-subtype research_article [--book-id <id>]`
4. Continue the paper pipeline in file-state order: Pass1 `status -> emit-input -> pass1-local-extractor -> pass1-write -> pass1-batch`, then `profile-sidecar-*`, `paper-metadata-*`, `paper-lexicon-*`, `pass2-*`, and `book-structure-*`.
5. Use only real extractor/subagent outputs for the paper build. Do not use deterministic filler, generic discourse, empty formula explanations, or reject-all Pass2 as substitutes.
6. After artifacts close, smoke the built paper with `/book/paper_metadata`, `/book/paper_lexicon`, `/book/paper_reading_guide`, `/book/asset_manifest`, and the web paper slots.

## Uncommitted / Unfinished
- Intended staged files for the feature commit include tracked changes under `crates/server`, `packages/core`, `packages/web`, `skills/build`, `docs/adr/0029-*`, `docs/切片方案-asset一等对象.md`, `docs/代码链路.md`, plus new `packages/core/src/asset-manifest.ts` and `packages/core/test/asset-manifest.test.ts`.
- Keep unrelated local artifacts out of the commit unless explicitly requested: `.fluid/`, `DESIGN-*.md`, dev/server logs, scratch Chinese reference Markdown, `todo.md`, `understand-book.md`, `grill.md`, and untracked docs not tied to this feature commit.
- The real paper prebuild has not started in this checkpoint because no concrete `<paper.md|epub>` input path was specified.

## Cold-Start Reading Sequence
1. `skills/build/SKILL.md` - paper profile-aware Pass1, profile sidecar, metadata, lexicon, Pass2, BookStructure, and resume rules.
2. `docs/预购建流程.md` - end-to-end prebuild mental model and extractor quality constraints.
3. `docs/切片方案-paper规则包.md` - paper profile scope, artifacts, and PP acceptance.
4. `docs/切片方案-profile插件框架.md` - profile plugin framework consumer/runtime/frontend boundary.
5. `docs/切片方案-asset一等对象.md` and `docs/adr/0029-*` - image asset/LID/source truth boundary.
6. `docs/代码链路.md` - PF24/PF25/PF26 implementation trail.
7. `crates/server/src/lib.rs`, `packages/web/src/App.vue`, and `packages/core/src/asset-manifest.ts` only if debugging the just-finished feature surfaces.

## Decisions Made
- Image render assets are a local render bundle, not citation truth; `source.txt` and LID remain the source/citation anchors.
- External HTTP(S) image URLs are recorded as external instead of downloaded during deterministic prebuild.
- Open-book discovery is local and conservative: only `.understand-book` child directories with `base.json` are listed.
- Reading progress is keyed by canonicalized book directory, with Windows verbatim path prefixes stripped for compatibility.

## Verification
- `npm run test -- asset-manifest` in `packages/core`: passed.
- `npm run test` in `packages/core`: passed.
- `npm run typecheck` in `packages/core`: passed.
- `npm run typecheck` and `npm run build` in `packages/web`: passed.
- `cargo test -p server`: passed, 47 lib tests plus main/bin tests.
- Root `.\node_modules\.bin\tsc.ps1 --noEmit --pretty false`: passed.
- `pass1-batch.ts understand-book.md --book-id understand-book-image-smoke --allow-partial`: produced `images=1 available=1`.
- `git diff --check`: passed; only LF/CRLF warnings.
