# SESSION_CHECKPOINT - 2026-07-21 13:13 +08:00

## 新鲜度自检
- Setup 源码 commit:`167c804 fix(desktop): honor cargo target dir when exporting`;功能提交:`e07b580 feat(plugin): bundle current-book MCP`。
- plugin cachebuster:`0.1.0+codex.20260721044654`。
- 当前 Setup:`dist/UnderstandBookSetup.exe`,37,252,013 bytes,SHA-256 `D317DB822EA0A0BDA9A9A6BE7761899B99B24E8442F4CB1EEE2D8131276A14E1`,version 0.1.0。

## 当前在做什么
PM1-PM5 已实现、验证、提交并从 detached clean snapshot 重编 Windows Setup;只剩本 release 证据文档提交与临时 worktree 清理。

## 已验证
1. `cargo test --workspace` 全绿;新增 `book_mcp` 选书单测 5/5。
2. root/public plugin validator、release parity 与当前 Codex CLI 隔离安装全绿。
3. plugin manifest launcher 通过 Reader session 绑定临时书并完成 tools/list + `book_search_text`。
4. clean release `book-mcp.exe` 5,050,368 bytes,SHA-256 `D1C41E888194AD1FAADD123A712DBE9DC1B7DE1E02EA7A7A0824C89CFE7F1C1B`。
5. NSIS bundle、隔离导出、最终 Setup 三份哈希一致;安装器未运行。

## 使用边界
- 安装新 Setup 并在安装提示中同意 Codex plugin 后,新 Codex thread 自动加载 Book MCP;不再执行 `codex mcp add`。
- MCP 启动时绑定 Reader 最后打开书;Reader 切书后需要新 Codex thread。
- Git marketplace 仍是独立发布物;本地提交未 push 时,远端用户不会获得新 `.mcp.json`。

## 未提交 / 不得触碰
- 本 release 证据文档待提交;Setup 是 `.gitignore` 忽略产物。
- 工作树仍有用户既有 memory/profile/reader/server host、旧前端切片和资料文件,不得吸收或恢复。

## 冷启动读序
1. `docs/adr/0089-plugin-provided-current-book-mcp-and-setup-sidecar.md` - 启动、选书、隐私和发布决策。
2. `docs/切片方案-Codex插件内置Book-MCP.md` - PM1-PM4 与完成定义。
3. `docs/架构.md` 的 Plugin-provided current-book Book MCP 段 - 当前数据流。
4. `docs/代码链路.md` 最后的 PM1-PM5 条目 - 实现、验证与产物索引。
