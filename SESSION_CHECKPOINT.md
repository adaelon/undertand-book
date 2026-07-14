# SESSION_CHECKPOINT - 2026-07-14 17:03 +08:00

## Freshness check
- Commit at write time: `e4a0d87 feat(runtime): add paper memory policy`.
- This checkpoint will be committed separately; on read compare with `git log --oneline -6` and trust newer implementation commits.

## What's in progress
Reliable profile memory M3.1-M3.3 are complete; M3.4 event-driven global consolidation is active and is the last implementation slice before the M3 total gate.

## Next steps (ready to hand off)
1. Read `docs/切片方案-memory可靠画像升级.md` sections 2.3, 4.4, 5.5, M3.4, and MEM-E07/E13; freeze affected-key and evidence-independence rules.
2. Read `crates/memory/src/{profile,review,operation,document}.rs`; identify the atomic mutation seam for Pending global candidates and reverse recomputation after correction/forget.
3. Add `crates/runtime/src/global_consolidation.rs` only if orchestration belongs outside MemoryStore; do not scan transcripts or auto-confirm inferred global facts.
4. Add deterministic contracts: one book never promotes; two books/three independent evidence produce only Pending; confirm affects the next snapshot; reject/expiry/evidence deletion retract candidates.
5. Run affected and full M3 tests, Web typecheck, strict clippy, rustfmt/diff checks; update architecture/code trail and commit M3.4 independently.

## Uncommitted / unfinished
- Tracked files: only this checkpoint before its docs commit.
- M3.4 event-driven global consolidation and the final M3 total gate: not implemented.
- Existing untracked materials, logs, screenshots, test results, and temporary directories belong to the user and remain untouched.

## Cold-start reading sequence
1. `docs/切片方案-memory可靠画像升级.md` - sections 2.3, 4.4, 5.5, M3.4, MEM-E07, and MEM-E13.
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` - trust and global promotion boundary.
3. `crates/memory/src/profile.rs` - fact identity, trust state, resolver, confirm/expire/forget.
4. `crates/memory/src/review.rs` and `crates/memory/src/document.rs` - atomic review commit and durable indexes/state.
5. `docs/架构.md` and `docs/代码链路.md` - completed M3.1-M3.3 data flows and latest commit `e4a0d87`.

## Decisions made this session
- ADR-0075 remains authoritative: consolidation consumes ledger facts and independent evidence only; inferred Global facts remain Pending until explicit confirmation.
- M3.3: PaperPolicyContext carries guide IDs/LIDs only; public paper text stays in sidecars, and mode/stage require confirmed UserStated paper-specific preferences.
