# SESSION_CHECKPOINT - 2026-07-14 20:38 +08:00

## Freshness check
- Commit at write time: `bb58fe8 feat(web): add profile governance surface`.
- This checkpoint is committed separately; compare with `git log --oneline -8` and trust newer implementation commits.

## Current state
Reliable profile memory M4 remains active. M4.1 Profile governance API and M4.2 Web profile/status UI are complete;M4.3-M4.5 and the M4 total gate remain required before the goal can be marked complete.

## Completed slices
- M4 alignment `0426b8d`: ADR-0076,CollectionRule/scope-change/backfill/Markdown/privacy/UI boundaries.
- M4.1a0 `a085cc5`: pure MemoryOp candidate-document reducer refactor.
- M4.1a `2879e1d`: ProfileGovernanceMutation reducer,exact-replay receipts,and CollectionRule gates.
- M4.1b `13fee97`: resident GET/POST governance HTTP,server-owned sensitive confirmation,generated Web types,and typed client.
- M4.2 `bb58fe8`: quiet Web updates/undo,Profile governance rail,Pending/evidence/status/rules UI,collapsed usage trace,and responsive visual repair.

## Verification
- `cargo test -p memory`: 76/76 passed at M4.1a.
- `cargo test -p runtime -p server`: 106/130 passed at M4.1b.
- `npm run typecheck` in `packages/web`: passed with generated JSON-number revisions.
- M4.2 Web gate:20 files/98 tests,`npm run typecheck`,and production `npm run build` passed;runtime remained 106/106.
- Playwright visual gate passed at 1440x900 and 390x844:document/panel horizontal overflow 0,outside controls 0;mobile right rail starts below the natural 96px topbar with no broken or overlapping labels.
- strict runtime/server clippy passed under only the frozen 3/7-class baselines;M4.1a memory strict clippy passed with no exemption.
- M4.2 runtime strict clippy passed with only the frozen 3-class baseline.
- `git diff --check`: passed. Whole-file rustfmt remains intentionally out of scope because the repo has pre-existing formatting differences.

## Key decisions
- `MemoryDocument` v2 remains the only durable truth;HTTP and Markdown are projections/adapters.
- Every governance action carries `expected_document_revision`;exact replay returns its receipt before revision checks,and operation-ID content reuse conflicts.
- GET exposes only Global/current-book facts and their evidence;Pending candidates and applicable collection rules are separate collections.
- Scope changes create Confirmed UserStated successors;they never edit facts in place.
- Collection rules affect future automatic/backfill capture only;explicit remember is a one-time exception and does not remove the rule.
- Sensitive remember/correct is process-local until the exact next-message acknowledgement;the client cannot forge the acknowledgement bit,and pending plaintext is `serde(skip)`.
- Web remains automatic-first:normal background updates do not require clicks;user actions are for centralized Pending review,sensitive confirmation,destructive forget,explicit backfill,and optional correction/governance.
- Web never patches profile truth locally:every action attaches the rendered revision,success reloads GET,and 409 reloads but never auto-replays a side effect.
- Undo is a new governance mutation(remember -> forget,correct -> successor correction),not an in-place history edit.
- Visitor MCP has no profile/memory route and never reads resident pending state.

## Next stage (not started)
M4.3 derived Markdown v2:keep `reader-profile.md` and `reading-handbook.md` one-way overwritten projections;render active fact ID/status,Global/Book sections,and raw activity while redacting Sensitive values. Same `projection_revision` must be byte-stable;forgotten values must be absent by grep;write failure must not roll back `MemoryDocument` truth but must remain diagnosable.

## Cold-start reading sequence
1. `docs/切片方案-memory可靠画像升级.md` M4.3 and M4 total-gate sections.
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` and `docs/adr/0076-profile-governance-and-backfill-ownership.md`.
3. Markdown renderer/refresh ownership in `crates/memory/src/lib.rs`,`crates/memory/src/markdown.rs`,and all `refresh_markdown` call sites.
4. Profile resolution/activity projection in `crates/memory/src/profile.rs` and current Markdown golden tests.
5. `docs/架构.md` Markdown/profile sections and the tail of `docs/代码链路.md`.

## Worktree
- After this checkpoint commit there should be no M4.1/M4.2 tracked changes.
- Existing untracked materials,logs,screenshots,test results,and temporary directories belong to the user and remain untouched.
