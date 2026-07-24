# SESSION_CHECKPOINT - 2026-07-24

## Freshness

- Latest committed slice: `a93efc6 build(desktop): release reviewed pdf setup`.
- Setup source snapshot: detached clean `396ac99 feat(pdf): publish reviewed foundation version`.
- On resume, compare `git log -4 --oneline`; if HEAD differs, re-audit this checkpoint against Git.

## Current Goal

Complete: AP1-AP10 from `docs/切片方案-Agent提示词与工具上下文治理.md` under ADR-0091 are implemented and verified. Preserve the main worktree's unrelated Rust/Reader/frontend-document edits and temporary artifacts.

## Agent Request Governance Progress

- AP0: ADR-0091, implementation slices, compact generation/consumption prompt v1, source coverage gates and terminology are frozen in docs.
- AP1: `AgentRequestAudit` samples each provider-neutral chat request without bodies, separates active input estimates, schema/body bytes and cumulative billed usage, and observes the current 27-tool surface.
- AP1 isolation: `OuterOutcome.request_audit` is `serde/TS skip`; tests prove it is absent from HTTP replies, persisted AgentHistory, public history Views and generated TypeScript contracts.
- AP1 verification: `cargo test -p runtime agent_request_audit` (2 passed) and `cargo test -p server agent_request_audit` (1 passed). Five synthetic fixtures are deterministic and contain no real-book text.
- AP2: `ModelRuntimeCatalog` resolves explicit override > exact/prefix catalog > versioned fallback; `ModelAdapter::chat` now accepts only a turn-frozen `AgentRequestPlan` with explicit instructions/input/tools/tool choice/parallel capability and active-context status.
- AP2 parity: Native explicitly sends auto/none plus `parallel_tool_calls=false`; ReAct consumes the same plan through its compatibility protocol. The existing `SYSTEM_PROMPT`, 27-tool exposure, stop semantics and warnings are unchanged.
- AP2 verification: `cargo test -p runtime agent_request_plan` (4 passed), Runtime full 182, Server full 186 plus book_mcp 5, AP1 regression, fmt and diff checks all passed.
- AP3: `ContextFragmentLedger` now owns keyed latest-revision projection for `reader.profile_snapshot`, `memory.operation_result` and `reader.paper_minimap_agent_context`; wrappers are turn-frozen and never appended to durable messages/history.
- AP3 privacy/identity: unchanged profile content reuses the same revision, changed content replaces it once, paper minimap state does not drift mid-loop, and durable user messages now keep the raw question without embedded map JSON.
- AP3 verification: `cargo test -p runtime context_fragment` (4 passed), `cargo test -p server profile_snapshot` (3 passed), Runtime full 184, Server full 187 plus book_mcp 5, fmt/diff checks all passed.
- AP4: `ToolRegistry` now hard-gates the private 27-spec declaration against duplicate names/handlers, missing handlers and Book alias/schema drift; every entry carries one typed handler, validator, capability set, result policy and parallel permission.
- AP4 dispatch: the live loop resolves model calls through the frozen registry and dispatches by `ToolHandlerId`; Native/ReAct receive `visible_specs()` from that same registry. The old hidden `book.manifest` dispatch bypass is closed, while all 27 visible schemas and sequential execution remain unchanged.
- AP4 verification: `cargo test -p runtime tool_registry` (4 passed), `cargo test -p runtime book_tool_characterization` (1 passed), Runtime full 188/188 and Rust fmt passed.
- AP5: `ToolExposurePlan` classifies the now 28-entry registry (27 prior tools plus `tool.search`) as direct/deferred/hidden from content profile, permissions, turn evidence and the frozen model schema budget. Ordinary local explanation exposes exactly 8 core read/source/discovery schemas.
- AP5 discovery: `tool.search` searches canonical registration metadata only, activates at most 6 deferred tools per call, never returns hidden tools and takes effect only in the next sampling. Calls not present in the sampled plan fail with `TOOL_NOT_EXPOSED`, including same-batch attempts after discovery.
- AP5 budget/isolation: direct tools are capped at 8; direct + activated schemas use the same JSON-array byte accounting as `AgentRequestAudit`; activated state is turn-local and is not persisted. Parallel execution remains disabled.
- AP5 verification: `cargo test -p runtime tool_exposure` (5 passed), Runtime full 193/193, Server full 187/187 plus book_mcp 5/5, Rust fmt and targeted diff checks passed.
- AP6 prompt assets: the monolithic `SYSTEM_PROMPT` is removed. `agent_prompt.rs` owns inherited base instructions plus versioned evidence/source/discovery/navigation/Reader/paper/memory/profile/finish modules, selected from the current sampled tool capabilities. `AgentRequestPlan.instruction_assets` records the exact base/module revisions sent to both providers.
- AP6 auto/bookkeeping: nonempty tool surfaces remain explicit `tool_choice=auto`, sufficient quoted passages can finish with zero calls, and the model no longer receives a forced `book.query -> memory.save(type=qa)` chain. Successful queries are observed and idempotently persisted as QA by Runtime without a model-visible memory call or trace step.
- AP6 no-progress: a canonical tool name/JSON-arguments fingerprint is keyed by evidence, activated tools, Reader state and Memory projection revision. Each completed call records before/after signatures, so an immediate same-argument or same-cursor retry fails with `AGENT_NO_PROGRESS` while a real intervening state change remains callable.
- AP6 constraints: source presentation/LID validation, sampled-tool visibility, sequential dispatch, explicit Reader effects and reducer-owned proposals are unchanged. Tests cover zero-tool quoted explanation, the Eq.9 one-read gap, reordered identical arguments, Runtime QA recording and conditional policy modules.
- AP6 verification: `cargo test -p runtime agent_tool_policy` (7 passed), `cargo test -p runtime source_presentation` (14 passed), Runtime full 200/200, Server full 187/187 plus book_mcp 5/5, Rust fmt and diff checks passed.
- AP7 projection: `tool_result.rs` wraps every active handler result in `tool_result_envelope.v1`; typed output policies cap individual bodies and a 48 KiB active-turn ledger retains fresh bodies through the next sample, then evicts only the oldest already-sampled body under pressure. Raw tool JSON remains byte-preserved in durable messages and trace digests.
- AP7 continuation/evidence: `book.text` cuts only at complete leaf-LID boundaries and emits a callable next range; context-truncated search emits a refine call while native pagination remains a distinct cursor continuation. Query/paper/profile/error have specialized bounded projectors. Only projected `model_body` enters the existing evidence whitelist; receipts and omitted tails cannot authorize source delivery.
- AP7 verification: `cargo test -p runtime tool_result_projection` (7 passed), Runtime full 207/207, Server full 187/187 plus book_mcp 5/5, Rust fmt and diff checks all passed.
- AP8 engine: `compaction.rs` owns `CompactionRequest -> CompactionDraft -> CompactionCheckpoint`, exact generation/consumption prompt assets, deterministic source/history/window identities, complete-turn chunking, current/incomplete raw retention, strict schema/coverage/reference/supersession/open-state validation and transitive hierarchical merge coverage. Only the draft is model-owned; compaction uses structured completion with no business tools or sensitive context bodies.
- AP8 projection/persistence: validated checkpoints project as synthetic system context in `base -> latest fragments -> checkpoint -> raw/new suffix` order. `AgentChatSession.compaction_checkpoint` is a private sidecar field excluded from public history views; candidate install is atomic, durable messages remain byte-equivalent, stale/failed checkpoints change neither memory nor disk, and restart resumes sampling from the sidecar.
- AP8 verification: `cargo test -p runtime compaction_checkpoint` (7 passed), `cargo test -p server agent_compaction_checkpoint` (1 passed), Runtime full 214/214, Server full 188/188 plus book_mcp 5/5, Rust fmt and diff checks all passed.
- AP9 automatic trigger: every planned sampling is measured as active input + output reserve + safety margin. Profile high water runs pre-turn compact before appending the new user message or mid-turn compact after Tool results; successful install rebuilds current fragments/checkpoint/raw suffix and continues the same business turn.
- AP9 stop semantics: cumulative billed usage is telemetry-only. Draft/validation/install failures are `COMPACTION_FAILED`, noncompactable or post-checkpoint physical overflow is `ACTIVE_CONTEXT_EXHAUSTED`, and tool-loop exhaustion is `TURN_LIMIT_EXCEEDED`; only legacy stored `CONTEXT_BUDGET_EXCEEDED` renders as context shortage.
- AP9 persistence/UI: Server installs raw messages plus private checkpoint through an atomic sink; all typed warnings survive persistence/restart/public history. RightRail distinguishes compaction failure, physical capacity and turn limit. Compaction is absent from business Tool trace, request audit and turn count.
- AP9 verification: `auto_compaction` 6/6, `active_context_budget` 1/1, `agent_warning_projection` 1/1; Runtime full 220/220; Server full 189/189 plus book_mcp 5/5; Web 26 files / 151 tests; Rust fmt/diff checks passed.
- AP10 provider parity: Native/ReAct consume the same sampled `AgentRequestPlan`; call/result/error/stop fixtures share Runtime semantics, compaction paths share one `CompactionDraft` schema/validator, and unknown models fail closed instead of inheriting guessed continuation or remote-compaction capability. ReAct protocol examples now come only from the current sampled tools; empty, unexposed or parallel provider output cannot become a false successful null answer.
- AP10 verified-selection convergence: server-resolved canonical selection text is current evidence. If more evidence is needed, the first sampling exposes only `book.context`, the second only `book.text`, and Runtime accepts at most one evidence call per response. After two calls it exits tool protocol and validates provider-neutral `selection_answer_synthesis.v1` JSON; DSML leakage or repeated contract violations fail closed.
- AP10 real-provider replay: on Transformer book LID `1.19.86.58.18`, Native answered the Chinese normalization question in 3 samplings after exactly `book.context` + `book.text`; ReAct answered in 1 sampling with zero calls. Both finished with no warning and no profile, memory or navigation activity.
- AP10 verification: `cargo test --workspace`, Rust fmt, Web 26 files / 151 tests and typecheck/build passed. Real exhaustive search returned 32 matches over 5 pages; real source delivery remained stable across restart without mutating history/book. Node/Bun v2 parity, plugin parity, workbench sidecar, packaged Book MCP, Rust release and NSIS passed.
- AP10 Setup: `dist/UnderstandBookSetup.exe`, 37,599,143 bytes, SHA-256 `AD0119C3FECB4B6C93CE3937AE8835B24CF2934A0F4B2A9EF9E0A1DE213AF0C0`, built 2026-07-24 14:08:53 +08:00.

## Completed PR20 Evidence

- Reviewed book version: `.understand-book/understanding-transformer-from-the-perspective-of-reviewed-v2`.
- Approved source/PDF/migration SHA-256: `feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43` / `9391b89821c97dd14e66937fd71d22bfcfc72357f8023daddc6fc6334c68b9b0` / `ead42b79890ceb606aa765b9f14e4127f24c65e20b775af76868722f957b94db`.
- Dual candidate digest: `cc056062004a7d8a72c176e70cfd0616ebf803ace67dcd1da4998276438e19e9` for both builds.
- PR8 coverage: baseline/matched 2,075/2,075; current 1,945; direct 1,499; map 446; removed 130; missing/unexpected/unknown reason 0.
- Wrong page/column, formal duplicate region/selection and material mismatch upgrade: all 0.
- Stable-only graph migration: 877 nodes / 1,003 edges -> 800 / 929. Old artifact and graph digests stayed unchanged.
- Publication transaction `release-cc056062004a7d8a`, journal revision 12, committed before sibling directory rename.
- Core 69 files / 439 tests + typecheck; Rust workspace and fmt; Server 185; Web 26 files / 150 tests + typecheck/build; Playwright 11; old/new real-book selection round trips all passed.

## Completed PR21 Evidence

- Source commit: clean detached `396ac99`; final release documentation commit: `a93efc6`.
- Plugin parity `0.1.0+codex.20260721044654`, release config, Node/Bun v2 parity, compiled workbench sidecar, Book MCP launcher, Web build, Rust release and NSIS all passed.
- NSIS bundle, detached export and final `dist/UnderstandBookSetup.exe`: 37,352,338 bytes; SHA-256 `D72ECC07400B3726951EB684586831BE084DF2A8B171FCDD61062949E9F4BEEE`; file/product version `0.1.0`; `NotSigned`.
- Workbench sidecar: 104,346,112 bytes / SHA-256 `6155E4528E971796127831D6B814210F7518DC2F538C0A9AECCEE1755414C9B8`.
- Book MCP: 5,052,416 bytes / SHA-256 `27146E3A8F6D3EFF188DD5B42ABB67724C0EDA10B13DAE397221E1F99946D2A9`.
- Installer was not started. Detached worktree was restored to clean `396ac99` after Tauri generation.

## Worktree Constraints

- C drive has 0 bytes free. Every Cargo/Node/package command must set workspace `TEMP/TMP`; use an E-drive `CARGO_TARGET_DIR`.
- Main worktree has user-owned changes in base-schema/memory/profile/reader/runtime/server host and the frontend reader slice document. Preserve and do not stage them.
- `SESSION_CHECKPOINT.md` is intentionally the uncommitted hot-start file; all PR21 release docs are committed in `a93efc6`.
