# SESSION_CHECKPOINT - 2026-07-14 17:40 +08:00

## Freshness check
- Commit at write time: `5db5b21 feat(memory): consolidate global profile candidates`.
- This checkpoint is committed separately; compare with `git log --oneline -8` and trust newer implementation commits.

## Current state
Reliable profile memory M3 is complete. Neutral, technical_learning, paper, and event-driven global consolidation are implemented, documented, independently committed, and have passed the M3 total gate.

## Completed slices
- M3.1 `8eaf17a`: versioned MemoryPolicy registry + Neutral/orphaned fallback.
- M3.2 `00e80a2`: technical_learning activity, evidence-backed review hypotheses, and typed hints.
- M3.3 `e4a0d87`: paper IDs/LIDs-only private projection and explicit mode/stage choices.
- M3.4 `5db5b21`: affected-key global promotion, Pending trust gate, and reverse reconciliation.
- Per-slice checkpoint commits: `1ff2a7e`, `0a25e16`, `a846d49`;this final checkpoint follows M3 total-gate evidence.

## Verification
- `cargo test -p read-tools -p memory -p runtime -p server`: 122/69/99/128 passed.
- `pnpm -C packages/web typecheck`: passed.
- strict clippy `--all-targets --no-deps -D warnings`: passed;memory has no exemption,other crates use only frozen 5/3/7-class baselines.
- M3.4 target rustfmt check and `git diff --check`: passed.
- Whole-repo rustfmt still reports pre-existing out-of-slice differences;no unrelated formatting was applied.

## Key decisions
- MemoryPolicy state is rebuildable and in-process;ProfileFact ledger remains the durable truth.
- Paper policy keeps public paper text/claims/gloss in sidecars and carries only guide IDs,term keys,and evidence LIDs.
- Global consolidation belongs to `crates/memory`,so source mutation,promotion index,job record,and revision share one atomic document commit.
- Consolidation reads affected ledger keys only;it never scans transcript/history or calls a model.
- At least two books plus three distinct evidence refs creates only an AgentInferred Global Pending candidate;confirmation is always explicit.
- Correction,expiry,forget,and evidence exclusion reverse-reconcile stale candidates;Book facts still override Global during resolution.

## Next stage (not started)
M4.1 Profile governance API. First align the contract for global/current-book facts,pending candidates,evidence,status,confirm/reject/correct/forget/change-scope,and collection rules. Every mutation must pass MemoryOp/validators and stale `document_revision` must conflict rather than overwrite.

## Cold-start reading sequence
1. `docs/切片方案-memory可靠画像升级.md` M4.1 and M4 total-gate sections.
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md`.
3. `crates/memory/src/{profile,operation,global_consolidation,review,document}.rs`.
4. `crates/runtime/src/profile_api.rs` and resident `/profile/memory` routes in `crates/server/src/lib.rs`.
5. `docs/架构.md` Event-driven global consolidation and the tail of `docs/代码链路.md`.

## Worktree
- After the final docs commit there should be no M3 tracked changes.
- Existing untracked materials,logs,screenshots,test results,and temporary directories belong to the user and remain untouched.
