# SESSION_CHECKPOINT - 2026-07-03 00:04

## Freshness check
- Commit at write time: 071b044 fix: stabilize startup and folded note previews
- On read, compare with `git log --oneline -3`; if different, trust git log.

## What's in progress
P5 ReActAdapter + provider registry is implemented and tested, but not committed.

## Next steps (ready to hand off)
1. Review `git diff -- crates/runtime/src/lib.rs crates/runtime/src/orchestrator.rs crates/runtime/src/main.rs crates/server/src/main.rs crates/server/src/bin/book_mcp.rs docs/代码链路.md SESSION_CHECKPOINT.md`.
2. Decide whether to commit P5 now or first fix the known runtime viewport failures.
3. If committing, stage only P5 files plus docs/checkpoint and run `git status --short`.
4. Optional follow-up: investigate `reader.gotoLid`/viewport anchor staying at `1.5` in the two existing runtime failures.

## Uncommitted / unfinished
- P5 changed: `crates/runtime/src/lib.rs`, `crates/runtime/src/orchestrator.rs`, `crates/runtime/src/main.rs`, `crates/server/src/main.rs`, `crates/server/src/bin/book_mcp.rs`, `docs/代码链路.md`, `SESSION_CHECKPOINT.md`.
- Verification: `cargo test -p server` passed.
- Verification: `cargo test -p runtime` = 48 passed, 2 failed; failed tests are known pre-P5 viewport failures: `orchestrator::tests::guided_read_one_stop_pipeline` and `orchestrator::tests::agent_viewport_change_merges_into_single_goto_effect`.
- P5-specific tests passed: `react_parser*`, `provider_config_defaults_native_and_selects_react`, `native_and_react_adapters_converge_on_runtime_tool_results`, `react_protocol_error_maps_to_provider_error`.
- Unrelated untracked files remain intentionally untouched: `.fluid/`, `agent交互书.md`, `docs/预购建流程.md`, `grill.md`, `packages/web/vite-dev.log`, `server-stdout.log`, `server-stderr.log`, `todo.md`, `参考*.md`.

## Cold-start reading sequence
1. `docs/切片方案-profile深路径.md` - P5 scope and P4/P6 boundaries.
2. `docs/代码链路.md` - latest P5 entry plus S5/S6 adapter history.
3. `crates/runtime/src/lib.rs` - ProviderRegistry, ReActAdapter, NativeAdapter, ModelAdapter contracts.
4. `crates/runtime/src/orchestrator.rs` - Runtime-owned tool_specs/dispatch/run and P5 tests.
5. `crates/runtime/src/main.rs`, `crates/server/src/main.rs`, `crates/server/src/bin/book_mcp.rs` - registry construction paths.

## Decisions made this session
- P5 provider selection uses `UNDERSTAND_BOOK_PROVIDER=native|react`, default `native`, reusing existing OpenAI-compatible endpoint env vars.
- ReAct fallback only parses provider text into `AssistantTurn`; tool execution and ToolError envelopes stay in Runtime dispatch.
