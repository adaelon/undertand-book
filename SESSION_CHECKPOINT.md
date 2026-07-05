# SESSION_CHECKPOINT - 2026-07-05 18:28

## Freshness check
- Last committed base when written: `20b1be6 feat: add paper rule pack profile support`.
- This checkpoint is written immediately before the requested PF1-PF21 commit. On read, compare `git log -3` and `git status --short`; trust git if newer.

## What's in progress
Profile Plugin Framework PF1-PF8 is implemented and verified. Post-PF fixes PF9-PF21 are applied: packaged server classifies `/api/profile/manifest` as API; generic profile workspace shell is hidden for `technical_learning`; agent history modal teleports to `body`; right-rail Agent answer selections show `Note`; Source preview renders continuous quote context; quoted-source sends collapse into pending transcript turn; formula parameter symbols render as inline math; Agent answer selections preserve Markdown when saved as Note; right-rail Notes previews render Markdown and remain visible when collapsed; code/table/image assets render raw escaped text with softer code blocks; cross-LID highlights group into one visible Highlight card while preserving per-LID ranges; reader body/note/highlight/formula styling now follows a Claude-inspired warm visual system.

## Next steps (ready to hand off)
1. If the latest git commit includes PF1-PF21, start from the user's next request.
2. If commit/push was interrupted, run `git status --short` and stage only PF tracked files, generated PF TS contracts, `docs/代码链路.md`, and `SESSION_CHECKPOINT.md`.
3. Keep local artifacts untracked unless explicitly requested: `.fluid/`, `DESIGN-*.md`, dev logs, server logs, scratch Chinese reference markdown, `todo.md`, `understand-book.md`, `grill.md`.
4. Optional pre-commit rerun: `cargo test -p read-tools -p reader -p runtime -p server`; `npm run typecheck` and `npm run build` in `packages/web`; `.\node_modules\.bin\tsc.ps1 --noEmit --pretty false`; `git diff --check`.

## Uncommitted / unfinished
- At write time, PF/fix files are modified and intended for the requested commit: Rust PF/profile/layout/server files; web `App.vue`, `api.ts`, `ReaderPane.vue`, `RightRail.vue`, `selection.ts`, `style.css`; generated PF TS contracts; `docs/代码链路.md`; `SESSION_CHECKPOINT.md`.
- New generated PF TS files to include if still untracked: `AgentToolSpec.ts`, `ContentProfileId.ts`, `GuidedReadingPolicySpec.ts`, `LayoutPresetSlot.ts`, `LayoutPresetSpec.ts`, `LayoutRegion.ts`, `LayoutSize.ts`, `LayoutSizeKind.ts`, `PinnedEvidence.ts`, `ProfileDefaults.ts`, `ProfileManifest.ts`, `ProfileSummary.ts`, `ProjectionKind.ts`, `ProjectionSpec.ts`, `ReaderLayoutAction.ts`, `ReaderLayoutActionKind.ts`, `ReaderLayoutApplyOutcome.ts`, `ReaderLayoutEffect.ts`, `ReaderLayoutProposal.ts`, `ReaderLayoutState.ts`, `UiSlotKind.ts`, `UiSlotSpec.ts`.
- No known functional blocker remains. Playwright screenshot verification was cancelled; deterministic checks below passed.

## Cold-start reading sequence
1. `docs/切片方案-profile插件框架.md` - PF0-PF8 plan and acceptance.
2. `docs/adr/0061-profile-plugin-framework-预构建后端前端三模块按content-profile插拔.md` - manifest/profile registry boundary.
3. `docs/adr/0060-reader-ui-control-plane-agent布局控制-后端session-layout-state.md` - layout reducer/action/proposal boundary.
4. `docs/代码链路.md` - PF1-PF21 implementation trail.
5. `crates/read-tools/src/lib.rs` - Rust-owned manifest/layout/paper projection contracts and registry.
6. `crates/reader/src/lib.rs` - backend `ReaderLayoutState` reducer, proposal lifecycle, and highlight persistence.
7. `crates/runtime/src/orchestrator.rs` - runtime tools and `AgentEffect::Layout/LayoutProposal`.
8. `crates/server/src/lib.rs` - REST profile/layout/paper/highlight endpoints.
9. `crates/server/src/main.rs` - packaged static server API-vs-SPA fallback classifier, including `/api/profile/manifest`.
10. `packages/web/src/App.vue`, `packages/web/src/api.ts`, `packages/web/src/components/ReaderPane.vue`, `packages/web/src/components/RightRail.vue`, `packages/web/src/selection.ts`, `packages/web/src/style.css` - frontend manifest/layout sync, paper workbench slots, Markdown notes, source preview, raw asset rendering, cross-LID highlight grouping, and reader visual system.

## Decisions made this session
- PF follows ADR-0061: Rust owns shared contracts; backend registry exposes manifests; frontend consumes manifest and typed projections.
- PF follows ADR-0060: agent layout changes go through `reader.layout.apply`; backend owns session layout state, rev, proposal stale checks, and direct-vs-proposal risk split.
- PF7 uses existing PaperReadingGuide / metadata / lexicon / BookStructure projections only; it adds no new paper artifact or cross-paper UI.
- PF20 keeps highlight persistence per LID/range but groups one user cross-LID selection via `source_session_id=highlight-group:*` for UI cards and delete/edit actions.
- PF21 adapts `DESIGN-claude.md` warm cream/coral editorial visual language to the reader surface without changing data, selection, note, or highlight behavior.

## Verification
- `cargo test -p read-tools -p reader -p runtime -p server`: passed for PF backend/profile/layout flow.
- `cargo test -p server`: passed for `/api/profile/manifest` static fallback regression.
- `cargo test -p reader -p runtime -p server`: passed after `/reader/highlight` `source_session_id` passthrough.
- `.\node_modules\.bin\tsc.ps1 --noEmit --pretty false`: passed.
- `npm run typecheck` in `packages/web`: passed after PF frontend work, shell hiding, agent history modal, note popover, source preview, quoted-source send collapse, formula math rendering, Markdown note preservation, note preview rendering, collapsed preview visibility, raw asset rendering, cross-LID grouping, and PF21 reader visual comfort.
- `npm run build` in `packages/web`: passed after the same frontend slices.
- `git diff --check`: exit 0; only LF/CRLF warnings observed before PF21 docs refresh.
- Local Vite dev server `http://127.0.0.1:5173/`: returned 200 after PF21 visual changes.
