# SESSION_CHECKPOINT — 2026-07-04 18:39

## 新鲜度自检
- 写入时最新 commit: `71bbcf1 feat: add BookStructure sidecar runtime projection`
- 读入时请对比 `git log --oneline -3`;若不一致以 git log 为准。

## 当前在做什么
BookStructure 栈已提交:PB7 预构建 sidecar schema/tooling + P8 Rust 读时消费、REST/MCP 只读投影。当前会话剩余动作是 push;之后可进入 P3/P7 消费侧 UI/guide 编排。

## 下一步(可直接接手)
1. 若远端未更新,执行 `git push` 推送 `main`。
2. 进入 P3/P7 前,读 `crates/read-tools/src/lib.rs:Book::structure/guide_path` 与 `crates/server/src/mcp.rs:book_structure/book_guide_path`。
3. 设计前端/访客 UI 展示时,先决定 `StructureProjection` 与 `GuidePath` 的最小可视化入口。

## 未提交 / 未完成
- BookStructure PB7/P8 功能项:无,已提交到 `71bbcf1`。
- 既有无关 tracked 脏改动仍在: `agents/profile-sidecar-extractor.md`, `packages/core/src/md-adapter.ts`, `packages/core/test/md-adapter.test.ts`。
- 既有 untracked 材料仍在: `.fluid/`, `DESIGN-apple.md`, `docs/预构建画像-quantification-essence.md`, `docs/预购建流程.md`, `grill.md`, logs, `todo.md`, `参考*.md`, `agent交互书.md`。

## 冷启动读序
1. `CONTEXT.md` — BookStructure / spine / throughline / key_stop / structure projection / guide path 术语。
2. `docs/adr/0044-bookstructure预构建结构地图-带读先总览再停靠.md` — BookStructure sidecar 决策。
3. `docs/adr/0045-bookstructure读时消费与mcp投影.md` — P8 读时消费、guide_path、REST/MCP 投影决策。
4. `docs/代码链路.md` — 读 S14l-S14q,还原 PB7 到 P8 链路。
5. `docs/技术方案-架构蓝图.md` — 读 2.2/3.2/5,确认读时命令面与 Rust DAG。
6. `packages/core/src/book-structure.ts`, `skills/build/book-structure-*.ts`, `agents/book-structure-extractor.md` — PB7 build-loop。
7. `crates/read-tools/src/lib.rs`, `crates/runtime/src/orchestrator.rs`, `crates/server/src/lib.rs`, `crates/server/src/mcp.rs` — P8 runtime/REST/MCP 接入。
8. `.understand-book/quantification-essence/book_structure.json` — 真书 sidecar 样本(`spine=25 throughlines=7 key_stops=73`)。

## 本会话决策摘要
- ADR-0044: BookStructure 是公共预构建 sidecar,核心形状 `spine + throughlines + key_stops`。
- ADR-0045: `book_structure.json` 缺失可运行且显式 unavailable;存在但坏文件 fail-fast。
- P8 暴露面: resident `book.structure`/`book.guide_path`,REST `/book/structure` `/book/guide_path`,MCP `book_structure`/`book_guide_path` 均只读。

## 验证
- `cargo test`: passed。
- `rustfmt --check crates\read-tools\src\lib.rs crates\runtime\src\orchestrator.rs crates\server\src\lib.rs crates\server\src\mcp.rs`: passed。
- `npm run test -- book-structure` in `packages/core`: 1 file / 7 tests passed。
- `npm run typecheck` in `packages/core`: passed。
- `git diff --cached --check`: passed before feature commit。
- `cargo fmt -- --check`: 未作为通过项;当前会在既有未改文件 `crates/memory`, `crates/reader`, `crates/runtime/src/goldset.rs` 等报告格式漂移。
