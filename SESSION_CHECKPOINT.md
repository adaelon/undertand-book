# SESSION_CHECKPOINT - 2026-07-21 12:50 +08:00

## 新鲜度自检
- 当前待冻结切片:PM1-PM4 plugin-provided current-book Book MCP。
- plugin cachebuster:`0.1.0+codex.20260721044654`。
- 旧 Setup 仍为 `dist/UnderstandBookSetup.exe`,35,667,957 bytes,SHA-256 `B5B075915D66E33CA74046BAC4BB4A719945F9C526FA7EA6C88844F9F965E7A3`;本切片尚未重编替换。

## 当前在做什么
PM1-PM4 实现与主工作区验证已完成;下一步只暂存本切片文件、提交冻结快照,再从该提交的隔离 worktree 重编 Windows Setup。

## 已验证
1. `book_mcp` 选书优先级单测 5/5;`cargo test --workspace` 全绿。
2. root/public plugin validator 与 release parity 全绿。
3. release `book-mcp` 5,050,368 bytes,SHA-256 `82A5BD55DC2FE5A12CA67F73856C4CC8570DD6051AFAC3AE362A19440497D5F7`。
4. 插件 manifest launcher stdio smoke 完成 `tools/list` + `book_search_text`;隔离 `CODEX_HOME` 经 Codex CLI 安装后显示 installed/enabled。

## 下一步(可直接接手)
1. 精确暂存 PM 文件并提交;不得吸收用户既有 memory/profile/reader/server host/旧前端切片修改。
2. 从冻结提交创建 detached worktree,离线 frozen install 后执行 Windows package。
3. 核验 NSIS 中存在 `book-mcp.exe`,记录 Setup size/SHA-256/version,更新代码链路与本 checkpoint 后提交 release docs。

## 冷启动读序
1. `docs/adr/0089-plugin-provided-current-book-mcp-and-setup-sidecar.md` - 启动、选书、隐私和发布决策。
2. `docs/切片方案-Codex插件内置Book-MCP.md` - PM1-PM4 与完成定义。
3. `docs/架构.md` 的 Plugin-provided current-book Book MCP 段 - 当前数据流。
4. `docs/代码链路.md` 最后的 PM1-PM4 条目 - 文件、入口与验证证据。

## 本会话决策摘要
- Codex plugin 拥有 `.mcp.json` transport;不写全局 `[mcp_servers]`,避免 schema/config 漂移。
- 单进程绑定一本书:CLI -> env -> Reader session;显式无效值 fail closed,切书后新线程重绑。
- visitor MCP 只借 session 当前书路由指针,仍不读取 resident memory/profile/history/provider settings。
- Setup 打包 binary,Git plugin 打包 manifest/launcher;公共 rollout 需二者都发布。
