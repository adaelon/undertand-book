# SESSION_CHECKPOINT - 2026-07-15 21:08 +08:00

## Freshness check
- Latest implementation commit: `8d2d6b0 feat: make book query referent-first`.
- This checkpoint is the immediate docs-only successor to that implementation commit; use `git log -2 --oneline` to confirm both commits.
- `dist/UnderstandBookSetup.exe` was built from an isolated detached worktree pinned to `8d2d6b0`, then copied into the main worktree after verification.

## Current state
- M6.1-M6.6 referent-first `book.query` is implemented, verified, committed, and packaged.
- Reliable profile memory M4 remains complete; its 21/21 release ledger is unchanged.
- M5 AgentHistory safety remains planned and was not implemented or folded into M6.
- The user explicitly selected M6, waived a new Grill, and authorized the implementation commit plus setup rebuild.

## M6 landed behavior
- Resident/REST/MCP/CLI/Web query surfaces require `BookQueryRequest {query,intent,targets,obligations,anchor_lid}` and return tagged `QueryOutcome`; legacy or incomplete plans fail before retrieval.
- `Book::referent_catalog` searches graph concepts/entities or the paper lexicon with graph fallback. Ranking is `RecallStrength -> lexical score -> anchor peer tie-break`; Top-12 applies fair target quotas and bounded previews.
- PlanGate/Resolver classifies every candidate, freezes one strong binding, preserves ambiguity, and permits at most three lexical probes plus one replacement retry.
- Evidence rereads full source LIDs from frozen bindings. One bounded expansion may read up to three remaining or graph/discourse/formula-reachable LIDs. Preview, gloss, sidecar, and model supplement cannot satisfy citations.
- The LLM judges every obligation as supported/uncertain/unsupported. Completion requires valid plan, bindings, coverage, source-grounded citations, and all obligations supported.
- `QueryAudit` stays out of tool results/messages and persists only in optional `TraceStep.query_audit`; its fields have serde defaults for early-M6 history compatibility.
- RightRail renders expanded QueryAudit; legacy traces still load. The obsolete anchor-scope ladder, `legacy_query`, and generated `QueryResponse.ts` were removed.
- Typed goldset fixtures freeze expected binding/status/citation LIDs. `goldset-topk` and `run_topk_replay` compare K=5/8/12/20 while all other budgets remain fixed; default K is 12.

## Defect baselines
- `learnability` with a far mu/sigma anchor freezes `concept:eta`, cites `2.1`, and records rank 1 / seed `2.1` in QueryAudit.
- `trend` freezes `concept:trend_strategy`, cites `2.2` in the frozen fixture, and records rank 1 / seed `2.2`; it does not bind `drift_mu`.

## Verification
- Rust gate passed: read-tools 125, runtime 143, server 137 tests.
- JS/Web gate passed: core 210, Web 100 tests; Web typecheck passed; production build passed with 1906 transformed modules.
- QRY-E01..E14 map to real automated tests in the M6 ledger. QRY-E01/E02 and runtime 143/143 were rerun after final audit/error-shape changes.
- Playwright visual verification passed at 1440x900 and 390x844 with expanded QueryAudit and zero horizontal overflow.
- `git diff --check` and ordinary clippy for read-tools/runtime/server passed. M6-introduced clippy warnings were removed.
- Strict `-D warnings` remains blocked by six pre-existing read-tools warnings outside M6. Full rustfmt still reports pre-existing debt in `runtime/memory_review.rs`, `runtime/profile_api.rs`, and `server/host.rs`; these were excluded from M6.
- Real-provider goldset/Top-K replay was not run; it remains optional and must retain raw QueryAudit if executed.

## Setup artifact
- Official command: `$env:UNDERSTAND_BOOK_MARKETPLACE_SOURCE='adaelon/undertand-book'; pnpm -C apps/desktop package:windows`.
- Artifact: `dist/UnderstandBookSetup.exe`; size `34,613,759` bytes; timestamp `2026-07-15 21:02:29 +08:00`.
- SHA-256: `2B14318FAB3A44399A88933AC27A16488125292228288BC65BF91D9E95D10A33`.
- The NSIS artifact is `NotSigned`; no signing configuration was introduced. The temporary detached worktree was removed after export and hash verification.

## Documentation
- `CONTEXT.md` defines implemented query ownership, referent/binding, PlanGate, structural gate, and expanded QueryAudit vocabulary.
- `docs/adr/0077-referent-first-query-and-structural-evidence-gates.md` records the accepted M6 decision and rejected alternatives.
- Architecture, code-chain, and slice-plan documents record the runtime chain, implementation trail, QRY-E01..E14 ledger, and completed M6 scope.

## Worktree boundaries
- Commit `8d2d6b0` contains only M6 code, Web, generated DTO, fixture, and documentation changes.
- Pre-existing tracked modifications in base-schema/memory/reader and unrelated untracked logs, screenshots, drafts, books, and temporary directories remain uncommitted and untouched.
- The setup artifact is exported output and is not part of the implementation commit.

## Next actions
1. Install/smoke-test `dist/UnderstandBookSetup.exe` on the target Windows account, then publish or push `8d2d6b0` when desired.
2. Optionally run `runtime <book_dir> goldset-topk <file.json>` against a configured real provider and retain the report plus raw QueryAudit; do not auto-tune from one run.
3. Implement M5 only as a separate user-authorized slice using MEM-E22..E24; do not infer that M6 completed it.

## Cold-start reading sequence
1. Read this checkpoint, then the M6 section and QRY-E01..E14 ledger in `docs/切片方案-memory可靠画像升级.md`.
2. Read ADR-0077 and the referent-first chain in `docs/架构.md`.
3. Follow `BookQueryRequest -> resolve_referents -> build_initial_query_evidence / targeted_expansion_lids -> structural_support_gate -> query_run_with_budgets`.
4. For surfaces/audit, inspect `runtime/orchestrator.rs`, server REST/MCP routes, `QueryAuditPanel.vue`, and `runtime/goldset.rs`.
