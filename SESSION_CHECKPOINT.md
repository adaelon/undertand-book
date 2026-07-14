# SESSION_CHECKPOINT - 2026-07-14 21:20 +08:00

## Freshness check
- Commit at write time: `441c660 feat(memory): materialize profile markdown v2`.
- This checkpoint is committed separately;compare with `git log --oneline -10` and trust newer implementation commits.

## Current state
Reliable profile memory M4 remains active. M4.1 governance API,M4.2 Web governance UI,and M4.3 derived Markdown v2 are complete;M4.4 explicit historical backfill,M4.5 privacy/E2E,and the M4 total gate remain before goal completion.

## Completed slices
- M4 alignment `0426b8d`: ADR-0076 and governance/backfill/Markdown/privacy/UI boundaries.
- M4.1 `a085cc5` + `2879e1d` + `13fee97`: pure MemoryOp reducer,governance reducer,and resident typed HTTP.
- M4.2 `bb58fe8`: quiet update/undo,Profile rail,Pending/evidence/status/rules UI,usage trace,and responsive visual gate.
- M4.3a `6ca658a`: behavior-preserving Markdown renderer module extraction.
- M4.3b `441c660`: revision-tagged Markdown v2,active scope partitions,raw activity,privacy redaction,pair materialization,and derived status.

## Verification
- M4.3 final gate:`cargo test -p memory -p runtime -p server` passed 79/106/130.
- `crates/memory/src/markdown.rs:tests` covers stable bytes across document-only mutation,active/Pending scope behavior,Sensitive fact/key and legacy-record redaction,forget grep removal,and current/stale/missing/unreadable failure states.
- memory strict clippy passed with zero exemptions;target markdown rustfmt and `git diff --check` passed.
- M4.2 Web gate remains 20 files/98 tests,typecheck,production build,and 1440x900 + 390x844 Playwright geometry/screenshots.
- Runtime/server retain only their frozen ts-rs diagnostic output;no new warnings or test failures were introduced.

## Key decisions
- `MemoryDocument` v2 remains the only durable truth;HTTP,Web,and Markdown are projections/adapters.
- Markdown first-line markers carry only `profile-markdown.v2 + projection_revision`;status is derived by reading files and is never persisted as truth.
- Markdown includes Confirmed/Provisional facts only;Global and Book remain separate;Sensitive fact key/value and Sensitive/Secret QA/context text use one fixed redaction marker.
- Both Markdown files are staged and fsynced before either switch;truth commits first and projection failure never rolls it back.
- A document-only governance mutation leaves `projection_revision`,rendered bytes,and current file status unchanged.
- Web remains automatic-first;user clicks are limited to Pending/sensitive/destructive/explicit-backfill or optional governance actions.
- Visitor MCP has no profile/memory or backfill surface and never reads resident private state.

## Next steps (directly actionable)
1. Add durable `HistoricalBackfillJob` state/reducers in `crates/memory`,with frozen session turn bounds,progress,cancel/retry/clear,and partial-result tests.
2. Extend `crates/runtime/src/memory_review.rs` with a backfill extraction contract that preserves source refs and forces every candidate to Pending.
3. Add resident-only preview/start/cancel/retry/clear routes and executor wiring over the explicitly selected AgentHistory range;keep visitor/MCP absent.
4. Project backfill jobs/candidates through `profile_api` and add explicit controls/status to `ProfileMemoryPanel`.
5. Run deterministic memory/runtime/server/Web tests,append code trail/update architecture,commit M4.4,and refresh this checkpoint.

## Uncommitted / unfinished
- M4.4,M4.5,and the M4 total gate are not implemented.
- No tracked implementation changes should remain after this checkpoint commit.

## Cold-start reading sequence
1. `docs/切片方案-memory可靠画像升级.md` M4.4,M4.5,and total-gate sections plus `CONTEXT.md:HistoricalBackfillJob`.
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` and `docs/adr/0076-profile-governance-and-backfill-ownership.md`.
3. `crates/memory/src/review.rs` ReviewState/ReviewJob reducers and `crates/runtime/src/memory_review.rs` extractor contracts.
4. Resident AgentHistory/review coordinator/profile routes in `crates/server/src/lib.rs` and `crates/server/src/host.rs`.
5. `crates/runtime/src/profile_api.rs`,`packages/web/src/components/ProfileMemoryPanel.vue`,`docs/架构.md`,and the tail of `docs/代码链路.md`.

## Worktree
- After this checkpoint commit there should be no tracked M4.3 changes.
- Existing untracked materials,logs,screenshots,test results,and temporary directories belong to the user and remain untouched.
