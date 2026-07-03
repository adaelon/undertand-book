# SESSION_CHECKPOINT - 2026-07-03 10:28

## Freshness check
- Commit at write time: `d8de8bb feat(build): promote inline formulas to formula LIDs`
- On read, compare with `git log --oneline -3`; if different, trust git log.

## What's in progress
S14a 已完成并推送: Markdown/EPUB 行内公式会拆成真实 `NodeKind=Formula` LID,PB6 FormulaSemantics 解释字段改为中文,前端 Formula profile 文案改中文。

下一会话目标:对 `E:\allwork\download\agent\clamp\(2026-06-24)你认为量化的本质是什么？_栀染.md` 重新预构建 profile sidecar + Pass2。建议沿用显式 `--book-id quantification-essence`,因为该文件名含非 ASCII,且现有产物目录是 `.understand-book/quantification-essence`。

## Next steps (ready to hand off)
1. Run `git log --oneline -3` and confirm S14a commit is present.
2. Run `pnpm exec tsx skills/build/build-status.ts "E:\allwork\download\agent\clamp\(2026-06-24)你认为量化的本质是什么？_栀染.md" --book-id quantification-essence`.
3. If Pass1/base is stale or pending because S14a changed LID segmentation, refresh Pass1/base first via `emit-input` -> `pass1-write` -> `pass1-batch`.
4. Rebuild PB6: `profile-sidecar-status` -> pending windows `profile-sidecar-input` + `profile-sidecar-extractor` + `profile-sidecar-write` -> `profile-sidecar-batch`.
5. Rebuild Pass2: `pass2-status` -> pending windows `pass2-input` + `pass2-longrange-linker` + `pass2-write` -> `pass2-batch`.

## Uncommitted / unfinished
- `SESSION_CHECKPOINT.md`: refreshed after S14a; commit/push this checkpoint if not already committed.
- Untracked reference/log files intentionally untouched: `.fluid/`, `DESIGN-apple.md`, `agent交互书.md`, `docs/预购建流程.md`, `grill.md`, `packages/web/vite-dev.log`, `server-stdout.log`, `server-stderr.log`, `todo.md`, `参考*.md`.
- No known tracked code changes remain after S14a except this checkpoint refresh.

## Cold-start reading sequence
1. `CONTEXT.md` - read `行内公式 LID`, `asset 叶子`, `公式语义剖面`, `预构建期 / 读时`.
2. `docs/代码链路.md` - read `2026-07-03 S14a 行内公式升级为 Formula LID`.
3. `skills/build/SKILL.md` - read PB6 profile-sidecar loop and Pass2 loop.
4. `agents/profile-sidecar-extractor.md` - read FormulaSemantics Chinese language contract.
5. `packages/core/src/md-adapter.ts` and `packages/core/src/epub-adapter.ts` - confirm inline formula segmentation behavior.
6. `packages/core/src/profile-sidecar-build.ts` - confirm `formula_lids` derives from `NodeKind=Formula`.
7. `skills/build/{build-status,emit-input,pass1-write,pass1-batch,profile-sidecar-*,pass2-*}.ts` - use exact CLI behavior before running rebuild.
8. `docs/预购建流程.md` - optional context for build pipeline narration.

## Session decisions
- S14a inline formula policy: inline formulas are real Formula LIDs, not paragraph-internal occurrences.
- S14a language policy: FormulaSemantics human-facing explanations are Simplified Chinese; LIDs, symbols, source formula text, and closed enums remain unchanged.
- Next rebuild must account for possible LID churn; do not run sidecar/Pass2 against an old base if `build-status` reports stale Pass1 artifacts.
