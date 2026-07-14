# SESSION_CHECKPOINT - 2026-07-14 23:04 +08:00

## Freshness check
- Commit at write time: `df05359 feat(web): govern explicit profile backfill`.
- This checkpoint is committed separately;compare with `git log --oneline -10` and trust newer implementation commits.

## Current state
Reliable profile memory M4 remains active. M4.1 governance,M4.2 Web UI,M4.3 Markdown v2,and M4.4 explicit historical backfill are complete. M4.5 privacy/E2E and the M4 total gate remain before goal completion.

## Completed slices
- M4 alignment `0426b8d`: ADR-0076 and governance/backfill/Markdown/privacy/UI boundaries.
- M4.1 `a085cc5` + `2879e1d` + `13fee97`: pure MemoryOp/governance reducers and resident typed HTTP.
- M4.2 `bb58fe8`: automatic-first Profile rail,Pending/evidence/status/rules,quiet update/undo,and responsive visual gate.
- M4.3 `6ca658a` + `441c660`: renderer extraction and revision-tagged/redacted/atomic Markdown v2.
- M4.4a `2b7886b`: durable HistoricalBackfillJob,source/capture separation,range/progress/retry/clear/forget reducers.
- M4.4b `05b4381`: upgrade baseline,one-turn resident executor,current-book API,and generated Web contracts.
- M4.4c `df05359`: explicit session/range controls,job progress/actions,active-only polling,and historical candidate labels.

## Verification
- M4.4a/b gates:memory 88,runtime 112,server 134;server backfill directed 4/4;strict clippy retained only frozen runtime/server whitelist categories.
- M4.4c final gate:Web 20 files/99 tests,typecheck,production build,and `git diff --check` passed.
- Playwright used the real resident `/profile/backfill` API at 1440x900 and 390x844:document/profile overflow 0,page script errors 0,and action geometry remained inside each job row.
- No explicit HistoricalBackfillJob means no history scan;only Queued/Running jobs create a 750ms Web poll;switch/unmount clears timer and invalidates requests.

## Key decisions
- `MemoryDocument` v2 remains the only durable truth;HTTP,Web,and Markdown are projections/adapters.
- Upgrade initializes the normal-review watermark to existing history without jobs;only an explicit frozen resident range backfills old semantic turns.
- Backfill preserves UserStated/AgentInferred source but records capture=historical_backfill and forces every candidate Pending.
- One scheduler tick processes one exact turn outside AppState lock;cancel/clear races discard provider output;retry resumes only the remainder.
- Web remains automatic-first;backfill is optional,terminal/no jobs do not poll,and task completion does not force-collapse user-opened details.
- Markdown remains one-way,revision-tagged,and redacted;visitor MCP has no profile/memory/backfill surface.

## Next steps (directly actionable)
1. Build a MEM-E01..E21 coverage ledger from existing test names;mark only genuinely uncovered rows for M4.5 implementation.
2. Locate/add the current-OS-user private storage gate around `MemoryStore::default_path` and resident startup;fail closed for profile persistence without blocking ordinary reading.
3. Add deterministic permission,Secret,and Sensitive end-to-end cases plus any missing MEM-E contract tests;do not claim application encryption.
4. Run `cargo test --workspace`,`pnpm test`,`pnpm --filter @understand-book/web build`,strict relevant clippy,and Playwright only where UI contracts require it.
5. Append the M4.5 code trail/update architecture,commit independently,then execute the M4 total gate and refresh this checkpoint.

## Uncommitted / unfinished
- M4.5 and the M4 total gate are not implemented.
- No tracked implementation changes should remain after this checkpoint commit.

## Cold-start reading sequence
1. `docs/切片方案-memory可靠画像升级.md` M4.5,§7,§8,and total-gate sections.
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` and `docs/adr/0076-profile-governance-and-backfill-ownership.md`.
3. `crates/memory/src/{lib,document,privacy,operation,markdown}.rs` path/privacy/persistence tests.
4. `crates/server/src/host.rs` resident startup and `crates/server/src/lib.rs` Secret/Sensitive/profile E2E tests.
5. `docs/架构.md` profile sections and the tail of `docs/代码链路.md`.

## Worktree
- After this checkpoint commit there should be no tracked M4.4 changes.
- Existing untracked materials,logs,screenshots,test results,and temporary directories belong to the user and remain untouched.
