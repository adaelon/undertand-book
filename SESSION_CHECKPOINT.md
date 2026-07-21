# SESSION_CHECKPOINT

Updated: 2026-07-21
Completed goal: implement all FT1-FT8 from `docs/切片方案-确定性全文定位与Book工具契约单源.md`.

## Frozen intent
- Canonical Book tool contract registry; no Resident/MCP/REST schema drift.
- Deterministic exhaustive lexical occurrence search over source.txt + base.json spans.
- No regex, fuzzy, synonym, formula AST, persistent index, or MCP private capability expansion.
- Agent workflow: LOCATE -> VERIFY -> EXPAND -> REASON -> DELIVER.

## Completed
- FT0-FT3: ADR/terms, characterization, no-I/O contracts registry, Resident/MCP/REST schema+validator projections and parity.
- FT4-FT5: exact/normalized provenance-aware occurrence engine, scope/order/cursor/page contract and two-pass bounded page materialization.
- FT6: `book.search_text` / `book_search_text` / REST `search_text` share one typed execution path; MCP remains Tier 1.
- FT7: location-first policy, literal-occurrence evidence, no-progress cursor guard and compact historical receipts.
- FT8: real-book Core/Resident/MCP replay, DeepSeek-v4-pro no-ambiguous-loop run, release performance and all gates.
- Design correction: leaf gaps may exist only when all gap text is Unicode whitespace; non-whitespace gaps fail closed.

## Verification
- `cargo test --workspace`: pass. Target counts: Contracts 8, ReadTools 152, Runtime 176, Server 170.
- `cargo test --release -p read-tools search_text_release_5_mib_p95_is_under_one_second -- --nocapture`: p95 671.3731 ms.
- `pnpm test`: Core 339/339 + Web 146/146; root workspace execution is serialized to avoid resource-contention timeouts.
- `pnpm build`: Web typecheck + production build pass.
- MCP stdio smoke: 5 pages, 32 exact occurrences, first LID `1.10.3.10`.
- DeepSeek-v4-pro real run: one `book.search_text`, no `book.query`/ambiguous loop.
- `git diff --check`: pass before final documentation update; rerun on handoff.

## Next
- No remaining FT slice. Preserve source-revision-bound gold assertions when the real book is rebuilt.

## Worktree cautions
- Preserve pre-existing user changes in memory/profile/reader/server host and unrelated untracked artifacts.
- Main FT files: contracts, read-tools, runtime orchestrator/lib, server mcp/lib+smoke, root package scripts, Cargo files/lock, FT docs and generated TS bindings.
