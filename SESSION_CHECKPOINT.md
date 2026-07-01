# SESSION_CHECKPOINT - 2026-07-01 21:05

## Freshness check
- Commit at write time: `27ebe84` docs: record continuous reader model plan
- On read, compare with `git log -3`; if different, trust git log.

## What's in progress
S12 continuous reader model is planned and ready to implement; next slice is S12a reader viewport interval semantics in `crates/reader`.

## Next steps (ready to hand off)
1. Open `crates/reader/src/lib.rs` and change `Viewport` to include `top_lid`, `bottom_lid`, `width`, `visible_lids`, and `anchor_lid`.
2. Replace `Reader { anchor_idx, radius }` with `top_idx` plus `width`, deriving `anchor_lid` from the interval midpoint.
3. Rewrite `Reader::scroll` so `delta` moves `top_idx`, clamps to the leaf range, and marks every new `visible_lids` leaf as read.
4. Rewrite `Reader::goto_lid` so a leaf or resolved container first leaf becomes `top_lid`.
5. Update reader tests, then run `cargo test -p reader` and `cargo test -p server`.

## Uncommitted / unfinished
- `SESSION_CHECKPOINT.md`: refreshed after S12 docs commit; pending checkpoint commit.
- Unrelated untracked files left untouched: `.fluid/`, `agent交互书.md`, `docs/预购建流程.md`, `grill.md`, `packages/web/vite-dev.log`, `todo.md`, `参考2.md`, `参考_discourse_prompt.md`, `参考_硅基天启：灭世之技术推演.md`, `参考pass2.md`.

## Cold-start reading sequence
1. `docs/adr/0043-reader连续滚动视口-后端区间窗口-前端虚拟流-note-overlay.md` - frozen continuous reader decisions.
2. `docs/切片方案-S12连续滚动阅读模型.md` - S12a-S12e implementation slices.
3. `docs/代码链路.md` - current project change trail including S12 docs entry.
4. `crates/reader/src/lib.rs` - current center-window reader implementation to replace in S12a.
5. `crates/server/src/lib.rs` - server projection of reader state and scroll/goto endpoints.
6. `packages/web/src/api.ts` - frontend Viewport DTO to update in S12b.
7. `packages/web/src/App.vue` and `packages/web/src/components/TopBar.vue` - current progress and page-button wiring.

## Decisions made this session
- ADR-0043 continuous reader model: viewport becomes a top..bottom interval, scroll moves top, goto lands target at top, progress uses top, notes move toward overlay, and TopBar page buttons are removed.
- S12 implementation plan: S12a reader interval semantics, S12b DTO/progress, S12c virtual buffer, S12d note overlay, S12e remove page buttons plus keyboard fallback.
