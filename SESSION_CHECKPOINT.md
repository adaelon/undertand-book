# SESSION_CHECKPOINT - 2026-07-15 01:02 +08:00

## Freshness check
- Commit at write time: `d466511 docs: close M4 release gate`.
- This checkpoint is committed separately;compare with `git log --oneline -10` and trust newer implementation commits.

## Current state
Reliable profile memory M4 is complete. M4.1 governance,M4.2 Web UI,M4.3 Markdown v2,M4.4 explicit historical backfill,and M4.5 privacy/E2E all passed their release gates. No required M4 implementation remains.

## Completed slices
- M4 alignment `0426b8d`: ADR-0076 and frozen governance/backfill/Markdown/privacy/UI boundaries.
- M4.1 `a085cc5` + `2879e1d` + `13fee97`: MemoryOp/governance reducers and resident typed HTTP.
- M4.2 `bb58fe8`: automatic-first Profile rail,Pending/evidence/status/rules,update/undo,and responsive visual gate.
- M4.3 `6ca658a` + `441c660`: renderer extraction and revision-tagged/redacted/atomic Markdown v2.
- M4.4 `2b7886b` + `05b4381` + `df05359`: durable explicit historical backfill,one-turn executor,API,and Web controls.
- M4.5a `1b14ea6`: current-user private storage gate,fail-closed empty Store,visible diagnostic,and reading-safe degradation.
- M4.5b `21b6c8c`: MEM-E01..E21 automated coverage ledger plus cross-book,forget-cache,stale-navigation,and repeated-intent tests.
- M4.5c `d466511`: workspace/Web/build/desktop-mobile production release gate record.

## Final verification
- `cargo test --workspace -- --test-threads=1`:all crates,desktop app,binaries,and doc tests passed.
- `pnpm test`:core 36 files/210 tests and Web 20 files/99 tests passed.
- `pnpm --filter @understand-book/web build`:typecheck + Vite production build passed(1903 modules).
- Relevant strict clippy passed;Memory has zero exemptions,Reader/Runtime/Server use only their frozen pre-existing category lists.
- Production Playwright at 1440x900 and 390x844 forced private-storage failure:stale diagnostic visible,PDF reading retained 14 items,document/panel horizontal overflow 0,page errors/request failures/unexpected HTTP errors 0.
- Nine `formula_semantics` 404 responses were accepted only because the existing client explicitly maps missing optional semantics to `null` and preserves source reading.

## Final boundaries
- `MemoryDocument` v2 remains the only durable truth;HTTP,Web,and Markdown are projections/adapters.
- Production resident hosts must use `MemoryStore::open_private`;permission enforcement/verification failure disables private reads,writes,review,and backfill without blocking ordinary navigation.
- Windows current-user DACL and Unix 0700/0600 are platform implementations behind the available/unavailable boundary;mobile hosts can inject app-private roots and later platform protection.
- Secret is never stored;Sensitive requires explicit plaintext acknowledgement;the project does not claim application-level encryption.
- Visitor MCP never opens resident private memory or mutates profile/review jobs.
- Historical semantic scans remain explicit frozen-range jobs;upgrade never scans old transcripts automatically.

## Next steps
1. User acceptance may exercise normal Profile remember/correct/forget/scope,explicit backfill,and visible status behavior.
2. Any post-M4 change starts a new aligned slice;mobile native storage protection,account sync,and application encryption remain separate scope.

## Uncommitted / unfinished
- No tracked M4 changes should remain after this checkpoint commit.
- Temporary release binaries,logs,and visual harness files are untracked and are not product artifacts.

## Cold-start reading sequence
1. `docs/切片方案-memory可靠画像升级.md` M4.5,§7,§8,and §8.1.
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` and `docs/adr/0076-profile-governance-and-backfill-ownership.md`.
3. `crates/memory/src/{private_storage,lib,privacy,operation,markdown,review}.rs`.
4. `crates/server/src/host.rs`,then profile/privacy routes and tests in `crates/server/src/lib.rs`.
5. `docs/架构.md` reader-private/profile sections and the tail of `docs/代码链路.md`.

## Worktree
- Existing unrelated untracked materials,logs,screenshots,test results,and temporary directories remain untouched.
