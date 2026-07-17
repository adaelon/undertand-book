# SESSION_CHECKPOINT - 2026-07-17 13:47 +08:00

## 新鲜度自检
- 写入时最新 commit:`0e2454f chore(build): record rebuilt Windows setup`;读入时先运行 `git log -3 --oneline` 与 `git status --short`,不一致时以 Git 和磁盘现状为准。
- 当前 goal:修复 Setup-owned Codex marketplace 的同源升级/source 迁移,提交后从干净快照重建 Setup。

## 当前在做什么
Codex plugin 更新流程 WD4 已实现并验证,尚待精确提交与 Windows installer 构建。

冻结边界:
- 同源且 Setup-owned:调用 `codex plugin marketplace upgrade`。
- source 变化且 receipt 同时匹配 plugin/marketplace 名并声明 `marketplace_added_by_setup=true`:移除旧 plugin/marketplace,添加新 source,重装并替换 receipt。
- 迁移失败:尽力恢复 receipt 中的旧 source 与迁移前 plugin 状态。
- 无 receipt、名称不匹配或外部拥有:绝不自动 remove;source 冲突返回人工处理提示。
- 不改 Codex config 内部文件格式、不改 plugin manifest/预构建协议/UI/书库/Provider。

## 验证证据
- red:source change、same-source refresh、隐藏冲突恢复、外部冲突提示 4 条测试均按旧行为失败。
- green:plugin-manager 8/8;desktop 全量 16/16。
- `cargo clippy -p understand-book-desktop --offline --no-deps -- -D warnings` 通过。
- dependency clippy 严格模式仍被既有 `crates/read-tools` 6 条 lint 阻断,与本切片无关。
- 隔离真实 CLI:`CODEX_HOME/LOCALAPPDATA` fixture 从旧本地同名 source 迁移到当前仓库;最终 `understand-book@understand-book` 0.1.0,receipt source 更新;真实用户 Codex 状态未修改。
- `cargo fmt -p understand-book-desktop -- --check` 与目标 `git diff --check` 通过。

## 下一步(可直接接手)
1. 仅暂存 `CONTEXT.md`、`SESSION_CHECKPOINT.md`、desktop README/plugin_manager、ADR-0068、`docs/架构.md`、`docs/代码链路.md`。
2. 审查 staged diff 后提交 `fix(desktop): migrate setup-owned Codex marketplace`。
3. 从新 commit 创建 detached worktree,离线 frozen pnpm install 后运行 `pnpm -C apps/desktop package:windows`。
4. 校验 NSIS/export/root Setup 大小、SHA-256、版本与签名状态,再更新 WD5/checkpoint 并提交构建记录。

## 未提交 / 未完成
- 本目标:`CONTEXT.md`、`SESSION_CHECKPOINT.md`、`apps/desktop/README.md`、`apps/desktop/src-tauri/src/plugin_manager.rs`、ADR-0068、`docs/架构.md`、`docs/代码链路.md`;代码已测,待 commit。
- PDF 原生选区 PE0-PE5:`PdfReaderPane.vue`、同名单测、`pdf-selection-actions.spec.ts`、ADR-0080、边界方案、`docs/architecture.md`、`docs/code-trail-S12-continuous-reader.md`;不得混入。
- 任务前 Rust:`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`;不得混入。
- 其余用户材料、日志、`.fluid/`、hybrid candidates、preview memory 与 test-results 均未处理。
- Windows Setup 尚未重建;当前 `dist/UnderstandBookSetup.exe` 仍是 `02e123b` 产物。

## 冷启动读序
1. `CONTEXT.md:Codex marketplace source migration` 与 ADR-0068 marketplace migration - 术语、所有权门禁与否决项。
2. `apps/desktop/src-tauri/src/plugin_manager.rs:install_with_runner/migrate_owned_marketplace` - 生产状态机、回滚与测试。
3. `docs/代码链路.md:WD4` 与 `docs/架构.md:Windows desktop distribution` - 调用链和架构索引。
4. `apps/desktop/README.md` - 发布与重试行为。

## 本会话决策摘要
- Marketplace source migration:仅自动迁移 Setup receipt 拥有的同名 marketplace(ADR-0068)。
- External conflict:保留外部 source,返回人工 remove/retry 指引(ADR-0068)。
- Build isolation:脏工作树不得直接打包,Setup 必须来自已提交 detached 快照。
