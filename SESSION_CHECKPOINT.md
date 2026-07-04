# SESSION_CHECKPOINT - 2026-07-04 12:54

## Freshness check
- Commit at write time: `2a861aa fix(web): normalize quote source matching`
- On read, compare with `git log --oneline -3`; if different, trust git log.

## What's in progress
Frontend reader/Quote source slice is complete; next focus moves back to the prebuild workflow ("预构建/预购建") for stable build profiles, quality gates, and artifact policy.

## Next steps (ready to hand off)
1. Read `docs/预购建流程.md` and `docs/预构建画像-quantification-essence.md`; reconcile terminology if "预购建" is only a typo/alias of "预构建".
2. Inspect `skills/build/SKILL.md` plus `agents/profile-sidecar-extractor.md` and `agents/pass2-longrange-linker.md` for current prebuild contracts.
3. Run `git diff -- packages/core/src/md-adapter.ts packages/core/test/md-adapter.test.ts skills/build/SKILL.md agents/profile-sidecar-extractor.md` before touching prebuild code, because these files already have unrelated local edits.
4. Pick the next prebuild slice explicitly: deterministic rebuild entry, sidecar quality gate, artifact retention policy, or token/cost accounting.
5. If continuing the quantification book, run the relevant status command under `skills/build/*-status.ts` against `.understand-book/quantification-essence/source.txt`.

## Uncommitted / unfinished
- S14k frontend Quote source fix: committed as `2a861aa`; no S14k code is pending after the checkpoint commit.
- `SESSION_CHECKPOINT.md`: refreshed for the next prebuild focus and should be committed separately from the feature fix.
- Existing unrelated tracked edits remain unstaged: `agents/profile-sidecar-extractor.md`, `packages/core/src/md-adapter.ts`, `packages/core/test/md-adapter.test.ts`, `skills/build/SKILL.md`.
- Existing untracked material remains untouched: `.fluid/`, `DESIGN-apple.md`, `docs/预构建画像-quantification-essence.md`, `docs/预购建流程.md`, `grill.md`, logs, `todo.md`, and `参考*.md`.

## Verification
- `npm run typecheck` in `packages/web`: passed for S14k.
- `npm run build` in `packages/web`: passed for S14k.
- Chrome packaged smoke on `127.0.0.1:8796`: note quote `0.1%` fully highlighted source text containing Markdown source `0.1\%`.
- `git diff --check -- packages/web/src/App.vue packages/web/src/components/ReaderPane.vue packages/web/src/selection.ts docs/代码链路.md`: no whitespace errors; only CRLF warnings.

## Cold-start reading sequence
1. `CONTEXT.md` - glossary for LID, formula semantics sidecar, Pass1/Pass2, build/read phases.
2. `docs/预购建流程.md` - current prebuild workflow notes and intended process.
3. `docs/预构建画像-quantification-essence.md` - concrete size/window/artifact profile for the quantification book.
4. `skills/build/SKILL.md` - Pass1, PB6 profile-sidecar, Pass2 command loops, and quality red lines.
5. `agents/profile-sidecar-extractor.md`, `agents/pass2-longrange-linker.md` - subagent output contracts.
6. `docs/代码链路.md` - read S14d for real sidecar/Pass2 rebuild and S14k for Quote source/formula LID matching.
7. `packages/web/src/App.vue`, `packages/web/src/components/ReaderPane.vue`, `packages/web/src/selection.ts` - only needed if reopening frontend highlight behavior.

## Decisions made this session
- S14k Quote source matching: normalize Markdown-escaped punctuation before matching so `0.1\%` and `0.1%` compare equally, while LaTeX commands like `\rho` remain literal commands.
- S14k formula selection: formula LIDs are atomic highlight leaves; free selection maps through `App.selectionRanges` instead of KaTeX DOM text.
