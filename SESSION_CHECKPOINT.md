# SESSION_CHECKPOINT — 2026-08-13 12:31 +08:00

## 新鲜度自检

- 写入时最新 commit：`e64d5f0 feat(runtime): close guided-read first-turn routing`；分支 `main`。
- 读入时请对比 `git log --oneline -3` 与 `git status --short`；若不一致，以 Git 与工作树为准。
- PHR0–PHR8 与本 checkpoint 均未提交、无 staged changes；工作树其他既有差异和 untracked 资产属于用户，禁止批量暂存、删除或回退。

## 当前在做什么

PHR8 已完成并验证：Manifest 为每个节点投影确定性 `display_title`，目录与 chapter read position 共用该字段；启动、首段和章节定位均不再发标题 `book.text` 请求，40/134/292 项目录规模下 title request 始终为 0。

## 下一步（可直接接手）

1. 用 `git diff -- crates/read-tools/src/lib.rs crates/server/src/lib.rs packages/web/src/generated/ManifestNode.ts packages/web/src/App.vue packages/web/playwright/note-body-placement.spec.ts packages/web/playwright/pdf-selection-actions.spec.ts docs/architecture.md docs/代码链路.md SESSION_CHECKPOINT.md` 审阅 PHR8 tracked diff。
2. 单独审阅 PHR8/共享 untracked：`packages/web/src/reader-manifest-title{,.test}.ts`、`reader-{hydration,text-range}.test.ts`、`playwright/{reader-performance,reader-bounded-buffer}.spec.ts`、切片方案。
3. 若要收成提交，按 `git status --short` 手工挑选 PHR0–PHR8 文件；显式排除受保护差异、scratch、handoff、日志、书籍与 executor-private 资产。
4. 若获准启动 PHR9，先读切片方案 §15，声明“真书回放、发布闸与旧路径删除”切片，并在删除 rollback 前跑默认 2+5 性能发布门。

## 未提交 / 未完成

- PHR0–PHR7 代码、测试、文档与报告仍在工作树，已验证、待审阅/commit；范围以 `git status --short` 与代码链路 PHR0–PHR7 条目为准。
- PHR8 tracked：`crates/read-tools/src/lib.rs`、`crates/server/src/lib.rs`、`packages/web/src/{App.vue,generated/ManifestNode.ts}`、两项既有 Playwright fixture、`docs/{architecture.md,代码链路.md}`、本 checkpoint。
- PHR8 新增 untracked：`packages/web/src/reader-manifest-title{,.test}.ts`；共享 untracked 且经 PHR8 增强：`reader-{hydration,text-range}.test.ts`、`playwright/{reader-performance,reader-bounded-buffer}.spec.ts`、切片方案。
- PHR8 验证：Rust read-tools 169/169、server 229/229 + book_mcp 5/5；Web 50 files / 301 tests；E2E 33/33（1 measured trace）；`typecheck`、production `build`、`test:perf-bundle`、`git diff --check` 通过，仅既有 ts-rs/chunk-size warning。
- Windows 端口 `4174` 落在系统 excluded range；E2E 用临时 `4400` 配置运行，临时配置与服务均已清理，未改正式 Playwright 配置。
- 受保护 tracked 差异：`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{profile,review}.rs`、`crates/runtime/src/profile_api.rs`、`docs/切片方案-切片1前端阅读器.md`、`docs/预购建流程.md`；不得混入。
- `.tmp-phr4-playwright/`、`.tmp-rust/`、`packages/web/test-results/` 为验证 scratch；其余未跟踪资产均未删除、未重置。
- PHR9 未启动；PHR8 无遗留实现项。

## 冷启动读序

1. `docs/切片方案-reader有界虚拟流与批量正文加载.md` §14–§15 — PHR8 完成证据与 PHR9 边界。
2. `docs/adr/0105-bounded-reader-buffer-stable-rendering-and-batched-source-loading.md` §6–§7 — Manifest 标题、发布与回滚契约。
3. `crates/read-tools/src/lib.rs:ManifestNode/manifest_display_title/Book::manifest`、`crates/server/src/lib.rs:book_tool_contract_has_schema_and_binding_parity` — Rust 投影与 REST/MCP parity。
4. `packages/web/src/reader-manifest-title{,.test}.ts`、`App.vue:init/loadChapter`、`playwright/reader-performance.spec.ts` — Web 共享投影与 0-request ledger。
5. `docs/代码链路.md` 最一条、`docs/architecture.md` Manifest title flow — PHR8 改动账本与蓝图。

## 本会话决策摘要

- PHR8 兑现 ADR-0105 §6：标题只来自 Manifest 确定性投影，禁止恢复同步或后台 N 个 `book.text`；未产生新 ADR，未启动 PHR9。
- `manifest_display_title` 逐行扫描节点 UTF-16 span，只解码首个非空行，避免为大容器复制整个正文。
