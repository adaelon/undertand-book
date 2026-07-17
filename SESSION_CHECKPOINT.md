# SESSION_CHECKPOINT - 2026-07-17 14:02 +08:00

## 新鲜度自检
- 写入时修复 commit:`655a710 fix(desktop): migrate setup-owned Codex marketplace`;读入时先运行 `git log -3 --oneline` 与 `git status --short`,不一致时以 Git 和磁盘现状为准。
- Windows Setup 已从 detached `655a710` 快照重建;WD5 与本 checkpoint 待单独提交构建记录。

## 当前状态
Codex plugin marketplace 更新失败 goal 已完成:
- 同源且 Setup-owned:调用 `codex plugin marketplace upgrade`。
- source 变化且 receipt 匹配 plugin/marketplace 名并声明 `marketplace_added_by_setup=true`:迁移旧 marketplace、重装 plugin、替换 receipt。
- 迁移失败:恢复 receipt 中的旧 source 与迁移前 plugin 状态。
- 外部同名 marketplace:绝不自动 remove,返回人工处理提示。
- Codex config 内部文件、plugin manifest、预构建协议、UI、书库和 Provider 均未改变。

## 验证证据
- red:source change、same-source refresh、隐藏冲突恢复、外部冲突提示 4 条旧行为回归全部失败。
- green:plugin-manager 8/8;desktop 全量 16/16。
- `cargo fmt -p understand-book-desktop -- --check`、目标 `git diff --check`、desktop-only clippy `-D warnings` 通过。
- dependency clippy 严格模式仅被既有 `crates/read-tools` 6 条 lint 阻断,与 WD4 无关。
- 隔离真实 CLI:`CODEX_HOME/LOCALAPPDATA` 从旧本地同名 source 迁移到当前仓库;最终 `understand-book@understand-book` 0.1.0,receipt source 更新;真实用户 Codex 状态未修改。
- package:`pnpm -C apps/desktop package:windows` 退出 0;Web、sidecar、Rust release 与 NSIS 全部完成。

## Windows Setup
- 路径:`dist/UnderstandBookSetup.exe`(gitignored)。
- 来源:detached `655a7107336f627bd2ba3ecdd1386691c904a129`。
- 大小:`34,650,810` bytes。
- SHA-256:`995070276B9ACD674E8A4B797219711A9EAC49A2F41EBB64CDF3B23A5559B0A1`。
- file/product version:`0.1.0`;Authenticode:`NotSigned`。
- NSIS source、detached export 与主工作区 Setup 哈希一致;安装器未启动。

## 工作区边界
- PDF 原生选区 PE0-PE5:`PdfReaderPane.vue`、同名单测、`pdf-selection-actions.spec.ts`、ADR-0080、边界方案、`docs/architecture.md`、`docs/code-trail-S12-continuous-reader.md`;保持未提交。
- 任务前 Rust:`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`;保持未提交。
- 其余用户材料、日志、`.fluid/`、hybrid candidates、preview memory 与 test-results 均未处理。
- 两个 detached worktree 的 Git 元数据均已 prune;每个目录各残留 2 个、合计 13,208,064 bytes 的 pnpm 硬链接(总计约 26.4 MB),由活动 Vite/esbuild 占用。停止 4174 后可删除 `.tmp-translation-setup-worktree` 与 `.tmp-codex-marketplace-setup-worktree`。

## 运行服务
- Web:`http://127.0.0.1:4174/`,Vite PID `25156`,esbuild PID `18720`;收口检查 HTTP 200。
- Backend:`http://127.0.0.1:8794/`,此前 PID `22388`;`/desktop/status` 收口检查 HTTP 200。
- 安装器未运行;真实用户 Codex plugin/marketplace 未被本 goal 修改。

## 下一步(可直接接手)
1. 可运行 `dist/UnderstandBookSetup.exe` 做人工安装 smoke;当前包未签名,Windows 会按本机策略提示。
2. 安装后在 Reader 设置点击“安装或重试”,Setup-owned 旧 source 应自动迁移;外部 source 冲突应保留并显示人工指引。
3. 停止 4174 后删除两个残留 `.tmp-*-setup-worktree` 目录,再按需重启 Vite。

## 冷启动读序
1. `CONTEXT.md:Codex marketplace source migration` 与 ADR-0068 marketplace migration - 术语与所有权门禁。
2. `apps/desktop/src-tauri/src/plugin_manager.rs:install_with_runner/migrate_owned_marketplace` - 状态机、回滚和测试。
3. `docs/代码链路.md:WD4-WD5` 与 `docs/架构.md:Windows desktop distribution` - 实现链和构建证据。
4. `apps/desktop/README.md` - 发布、重试与外部 source 行为。

## 本会话决策摘要
- Marketplace source migration:仅自动迁移 Setup receipt 拥有的同名 marketplace(ADR-0068)。
- External conflict:保留外部 source,返回人工 remove/retry 指引(ADR-0068)。
- Build isolation:Setup 仅来自已提交 detached 快照。
