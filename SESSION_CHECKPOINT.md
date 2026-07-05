# SESSION_CHECKPOINT - 2026-07-05 20:51

## Freshness check
- Last committed base when written: `e10b230 feat: implement profile framework reader refinements`.
- This checkpoint is written immediately before the requested PF22/PF23 commit+push. On read, compare `git log -3` and `git status --short`; trust git if newer.

## What's in progress
PF22/PF23 are implemented and verified. `NativeAdapter` now retries one transport-only `/chat/completions` failure, does not retry HTTP status responses, includes provider status response bodies in `PROVIDER_ERROR`, and maps internal dotted tool names such as `book.text` / `reader.goto` to provider-safe names such as `book_text` / `reader_goto` for native tool-calling before mapping responses back to internal names.

Next user-facing work is to run the paper content profile prebuild on a real cleaned paper/book input, not another fixture.

## Next steps (ready to hand off)
1. Confirm the real paper input path `<paper.md>` and optional `<paper.pdf>` / PDF source map. If the filename is non-ASCII-heavy, pick a stable `--book-id <id>`.
2. Start with status: `.\node_modules\.bin\tsx.ps1 skills\build\build-status.ts <paper.md> --content-profile paper --paper-subtype research_article [--book-id <id>]`.
3. For each pending Pass1 window: run `emit-input.ts`, send the output to `pass1-local-extractor`, then write with `pass1-write.ts ... --content-profile paper --paper-subtype research_article`.
4. When Pass1 is done, run `pass1-batch.ts <paper.md> --content-profile paper --paper-subtype research_article [--book-id <id>] [--original-pdf <paper.pdf>] [--pdf-source-map <map.json>]`.
5. Run the independent paper/profile loops with their `status -> input -> extractor -> write -> batch` scripts: `profile-sidecar-*`, `paper-metadata-*`, `paper-lexicon-*`, then `pass2-*`, then `book-structure-*`.
6. Do not use deterministic filler, generic discourse, empty formula explanations, or reject-all Pass2 as substitutes for the real extractors. Stop and report if a required extractor/subagent is unavailable.
7. After artifacts close, load the built directory with the server and smoke `/book/paper_metadata`, `/book/paper_lexicon`, `/book/paper_reading_guide`, plus the web paper slots.

## Uncommitted / unfinished
- Intended for the requested commit: `crates/runtime/src/lib.rs`, `docs/代码链路.md`, and this `SESSION_CHECKPOINT.md`.
- Keep local untracked artifacts out of the commit unless explicitly requested: `.fluid/`, `DESIGN-*.md`, dev/server logs, scratch Chinese reference markdown, `todo.md`, `understand-book.md`, `grill.md`.
- No known runtime blocker remains for the provider compatibility slice. The real paper prebuild has not started in this checkpoint.

## Cold-start reading sequence
1. `skills/build/SKILL.md` - paper profile-aware Pass1, profile sidecar, metadata, lexicon, Pass2, and build-resume rules.
2. `docs/预购建流程.md` - end-to-end prebuild mental model and extractor quality constraints.
3. `docs/切片方案-paper规则包.md` - paper profile scope, artifacts, and PP slice acceptance.
4. `docs/切片方案-profile插件框架.md` - profile plugin framework consumer/runtime/frontend boundary.
5. `docs/代码链路.md` - PF22/PF23 implementation trail and earlier paper/PF history.
6. `skills/build/*status.ts`, `*input.ts`, `*write.ts`, `*batch.ts` for the active stage.
7. `crates/runtime/src/lib.rs` - revisit only if native/ReAct provider behavior errors recur during paper smoke.

## Decisions made this session
- Native tool-calling exposes provider-safe function names but keeps internal runtime tool names dotted.
- HTTP status errors are not retried; their response body is surfaced to make provider 400/500 failures diagnosable.
- If a provider/model does not support native tools at all, prefer explicit `UNDERSTAND_BOOK_PROVIDER=react` or a future narrow body-based fallback, not blanket retry/fallback for every 400.

## Verification
- `cargo test -p runtime`: passed, 58 tests.
- `git diff --check`: exit 0; only LF/CRLF warnings.
