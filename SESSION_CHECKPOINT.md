# SESSION_CHECKPOINT — 2026-08-20 00:42 +08:00

## 新鲜度自检

- 写入时最新 commit：`db546cb revert(reader): restore pre-PHR body path`；分支 `main`，相对 `origin/main` ahead 2。
- 读入时先对比 `git log --oneline -3` 与 `git status --short`；若变化，以 Git 与工作树为准。
- Reader 回退前的完整 tracked 补丁与 13 个未跟踪实验文件位于 `.understand-book-reset-backups/reader-pre-phr-rollback-20260820/`。

## 当前在做什么

Reader 正文链已完成 PHR 前基线回退并提交；当前等待人工阅读体验或推送，不再继续 NPF/F1/PHR 优化。

## 下一步（可直接接手）

1. 运行 `cargo run -p understand-book-desktop`，用长书检查正文滚动、goto、Note 与 Highlight 的 PHR 前体验。
2. 若体验通过，运行 `git push origin main` 推送 `0ae10d4` 与 `db546cb`；当前未授权推送。
3. 独立审阅并处理下列既有无关工作树改动，不把它们并入 Reader 回退 commit。

## 未提交 / 未完成

- `crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{profile,review}.rs`、`crates/runtime/src/profile_api.rs`：回退前已有且已逐文件确认保持原内容。
- `docs/代码链路.md`：保留原有 NPF/Paper lexicon 历史，并追加 `2026-08-20 Reader 正文恢复 PHR 前基线` 验证条目；尚未提交，避免夹带同文件中的其他工作。
- `docs/切片方案-切片1前端阅读器.md`、`docs/预购建流程.md`：回退前已有且保持原内容。
- 大量既有未跟踪书稿、构建产物、性能证据与日志未清理；13 个被撤销的 NPF/F1 源文件另有精确备份。

## 冷启动读序

1. `docs/adr/0112-pre-phr-reader-body-path-rollback.md` — 回退边界、否决项与重新立项条件。
2. `docs/architecture.md` 的 `Web reader` 与开头两条 Reader data flow — 当前正文链和异步已读账本。
3. `packages/web/src/App.vue:hydrateSegments/mergeSegments/loadWindow` 与 `packages/web/src/components/ReaderPane.vue:checkBufferNeed/currentLidAtProbe` — 恢复后的生产路径。
4. `docs/代码链路.md` 尾部 `2026-08-20 Reader 正文恢复 PHR 前基线` — 文件级触达与验证结果。
5. `.understand-book-reset-backups/reader-pre-phr-rollback-20260820/README.md` — 如需找回被撤实验时的恢复入口。

## 本会话决策摘要

- ADR-0112：正文渲染、装载、缓冲、滚动及配套测试恢复到 `e64d5f0`，不改写 PHR 历史。
- 保留 `596a0cb`、`0ae10d4` build commits、`ef60060` 异步已读账本，以及 PHR commit 内与正文无关的真实书搜索测试修正。
- 未提交的 ADR-0108/0109/0110、NPF/F1 TypeScript 实验与方案文档已从活动工作区撤出并备份。

## 已完成验证

- Web Vitest：38 files / 215 tests；Playwright：15/15；production build（含 typecheck）通过。
- Rust：`read-tools` 161/161、`reader` 54/54、`server` 230/230、Book MCP 5/5；Desktop `cargo check` 通过。
