# SESSION_CHECKPOINT - 2026-07-14 16:41 +08:00

## Freshness check
- Commit at write time: `00e80a2 feat(runtime): add technical learning memory policy`.
- This checkpoint will be committed separately; on read compare with `git log --oneline -5` and trust newer implementation commits.

## What's in progress
Reliable profile memory M3.1-M3.2 are complete; M3.3 paper policy is active, with M3.4 global consolidation still pending.

## Next steps (ready to hand off)
1. Read `docs/切片方案-memory可靠画像升级.md` M3.3 and section 5.3; freeze the paper state, hint, and privacy contracts.
2. Read `crates/runtime/src/memory_policy.rs` and paper profile/minimap types; register paper v1 without changing shared Core ordering.
3. Add contract tests proving public paper facts stay outside private memory and user landmarks/preferences remain typed and evidence-backed.
4. Run runtime/server/full affected tests, Web typecheck, strict clippy, rustfmt target checks, and `git diff --check`.
5. Update `docs/架构.md` and `docs/代码链路.md`, commit M3.3 independently, then refresh this checkpoint before M3.4.

## Uncommitted / unfinished
- Tracked files: only this checkpoint before its docs commit.
- M3.3 paper policy and M3.4 global consolidation: not implemented.
- Existing untracked materials, logs, screenshots, test results, and temporary directories belong to the user and remain untouched.

## Cold-start reading sequence
1. `docs/切片方案-memory可靠画像升级.md` - M3.3 and section 5.3 contracts.
2. `docs/架构.md` - Runtime memory policy, Reader profile snapshot projection, and paper minimap flows.
3. `crates/runtime/src/memory_policy.rs` - registry and M3.1-M3.2 policy implementations.
4. `crates/read-tools/src/lib.rs` and paper profile/minimap types referenced by the M3.3 spec.
5. `docs/代码链路.md` - latest M3.2 entry and commit `00e80a2`.

## Decisions made this session
- ADR-0075 remains authoritative: policy state is rebuildable rather than a truth source; version mismatch falls back to Neutral; global inferred facts must remain Pending.
- M3.2: raw QA activity creates only evidence-backed Provisional NeedsReview, while only confirmed user statements can mark UserConfirmedUnderstood.
