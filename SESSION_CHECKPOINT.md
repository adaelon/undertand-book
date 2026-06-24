# SESSION_CHECKPOINT — 2026-06-25 00:00

## Freshness check
- Commit at write time: ef0b085 feat: serve packaged reader and promote formula assets
- On read, compare with `git log -3`; if different, trust git log.

## What's in progress
S10e packaged reader server/startup and the Formula asset contract are committed. No asset implementation code has started.

## Next steps (ready to hand off)
1. If implementing asset work, open `docs/切片方案-asset一等对象.md` and start at SA0 `GranularityProfile`; do not jump directly to schema/adapter changes.
2. SA0 must count code/table/image/formula candidates and report formula_count plus paragraph/hybrid/sentence LID estimates.
3. SA1 then adds `NodeKind::Formula`, `ManifestNode.kind`, and FormulaSemantics schema/TS export.
4. For full manual product acceptance unrelated to asset, run `start.bat .understand-book\game-programming-patterns`, then verify browser UI + agent with `.env`.

## Uncommitted / unfinished
- `SESSION_CHECKPOINT.md`: refreshed after commit `ef0b085`; pending checkpoint commit only.
- Asset implementation code remains unstarted.
- S10h/S10i/S10j remain unstarted.

## Cold-start reading sequence
1. `docs/切片方案-asset一等对象.md` — authoritative next asset implementation plan; FormulaSemantics included.
2. `docs/adr/0029-asset一等对象-带类型lid叶子-image原文源标记序列化-manifest暴露kind-图谱层一视同仁.md` — revised asset decision with Formula.
3. `CONTEXT.md` — glossary terms `asset 叶子` and `公式语义剖面`.
4. `docs/adr/0032-段句粒度体检-先统计再选择paragraph-hybrid-sentence-避免默认全书句级.md` — required SA0 gate.
5. `docs/切片方案-切片1前端阅读器.md` §6 — S10j frontend consumption after asset work.
6. `docs/代码链路.md` — latest touched-symbol ledger.

## Decisions made this session
- S10e packaged server serves Vue `dist` and API on one tiny_http port; packaged SPA uses `/api/*`, and `main.rs` strips `/api` before frozen command-surface dispatch.
- `start.bat` is now the packaged product launcher; Vite dev mode is no longer the default double-process path.
- Formula is no longer a long-tail asset; `NodeKind` target set is `{Code,Table,Image,Formula}`.
- Formula requires FormulaSemantics: parameters, composition, and context links with real LID evidence.
- Formula leaves must not be sentence-split; they remain atomic asset leaves for span/partition purposes.