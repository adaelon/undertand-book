# SESSION_CHECKPOINT - 2026-07-05 14:20

## Freshness check
- Commit at write time: c4229ec feat(web): add all-notes rail and source preview
- This checkpoint is being committed together with the paper rule-pack implementation and Profile Plugin Framework docs; on read, compare with `git log -3` and trust git log if different.

## What's in progress
Paper rule-pack PP0-PP9 implementation and docs are ready to hand off; the next target is Profile Plugin Framework PF1, starting from the new slice plan.

## Next steps (ready to hand off)
1. Read `docs/切片方案-profile插件框架.md`; this is the current route map.
2. Read ADR-0061 and ADR-0060 to recover the Profile Plugin Framework and Reader UI Control Plane decisions.
3. Start PF1 with a narrow A1 declaration: Rust contract types plus ts-rs export for manifest/layout contracts.
4. Before coding PF1, inspect existing generated TS patterns in `packages/web/src/generated` and Rust export patterns in `crates/read-tools/src/lib.rs`.
5. Keep paper PP10 fixtures/goldens as a later validation slice unless explicitly pulled forward.

## Uncommitted / unfinished
- The commit that contains this checkpoint should include paper rule-pack implementation through PP0-PP9, paper rule-pack docs, ADR-0046~0061, and the Profile Plugin Framework slice plan.
- Exclude unrelated local artifacts such as `.fluid/`, dev logs, scratch reference markdown files, `DESIGN-apple.md`, `todo.md`, and `understand-book.md`.
- No PF1 code has started yet.

## Cold-start reading sequence
1. `docs/切片方案-profile插件框架.md` - Current execution plan and PF0-PF8 slice order.
2. `docs/adr/0061-profile-plugin-framework-预构建后端前端三模块按content-profile插拔.md` - Profile manifest/registry boundary.
3. `docs/adr/0060-reader-ui-control-plane-agent布局控制-后端session-layout-state.md` - Layout action/state/proposal boundary.
4. `CONTEXT.md` - Terms: Profile Plugin Framework, Reader UI Control Plane, paper profile, PaperReadingGuide.
5. `docs/切片方案-paper规则包.md` - Paper PP0-PP10 route map and acceptance.
6. `docs/代码链路.md` - PP8/PP9 and paper rule-pack implementation trail.
7. `skills/build/SKILL.md` - Current build skill and paper rule-pack commands.
8. `crates/read-tools/src/lib.rs` and `crates/runtime/src/orchestrator.rs` - Read-time projection and runtime tool surface.
9. `packages/core/src/content-profile.ts`, `packages/core/src/paper-metadata.ts`, `packages/core/src/paper-lexicon.ts` - TS-side paper/profile artifacts.

## Decisions made this session
- Profile Plugin Framework: prebuild, backend runtime/agent, and frontend consumption are all profile-pluggable; shared contract is Rust-owned and exported to TS. See ADR-0061.
- Reader UI Control Plane: agent changes reader layout only through typed JSON actions validated by backend session layout state. See ADR-0060.
- Current implementation handoff: commit paper rule-pack implementation and the newly settled Profile Plugin Framework docs together, then continue with PF1.
