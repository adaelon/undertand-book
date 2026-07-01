# SESSION_CHECKPOINT - 2026-07-02 10:30

## Freshness check
- Commit at write time: `6113893` feat(web): S13a move notes back into seg loop, revert S12d overlay
- On read, compare with `git log -3`; if different, trust git log.

## What's in progress
S13a note-in-seg is implemented and committed; note cards render inside the prose seg loop per LID instead of a separate overlay. No active slice.

## Next steps (ready to hand off)
1. Optional browser smoke: start server + web dev, confirm notes appear after each segment, scroll-edge still works, keyboard fallback intact.
2. If smoke reveals roughness, create a new S13b slice; do not fold into S13a.
3. Consider cleaning duplicate `.note-source` / `.note-actions` style rules in style.css (pre-existing tech debt from S11n/S11p/S12d accumulation).

## Uncommitted / unfinished
- None for tracked S13a files.
- Unrelated untracked files left untouched: `.fluid/`, `agent交互书.md`, `docs/预购建流程.md`, `grill.md`, `packages/web/vite-dev.log`, `todo.md`, `参考2.md`, `参考_discourse_prompt.md`, `参考_硅基天启：灭世之技术推演.md`, `参考pass2.md`.

## Cold-start reading sequence
1. `docs/adr/0043-reader连续滚动视口-后端区间窗口-前端虚拟流-note-overlay.md` - S12 decisions (decision 7 revised by S13a).
2. `docs/代码链路.md` - S12a-S12e + S13a implementation trail.
3. `crates/reader/src/lib.rs` - interval viewport backend semantics.
4. `packages/web/src/api.ts` and `packages/web/src/App.vue` - viewport DTO, progress, buffer loading.
5. `packages/web/src/components/ReaderPane.vue`, `packages/web/src/components/TopBar.vue`, and `packages/web/src/style.css` - native scroll buffer, note-in-seg, keyboard fallback, no page buttons.

## Decisions made this session
- S13a: note cards reverted from independent overlay (S12d) to in-seg-loop rendering per LID; ADR-0043 decision 7 revised; verification passed `pnpm typecheck` + `pnpm build`.