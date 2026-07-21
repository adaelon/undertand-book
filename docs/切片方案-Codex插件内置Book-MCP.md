# 切片方案:Codex 插件内置 Book MCP

## 目标

安装 Windows Setup 并授权安装 Understand Book 插件后,Codex 新会话自动获得 canonical readonly Book tools,不要求用户手写 `codex mcp add` 或复制 MCP schema。

## 固定边界

- 工具名、输入 schema、validator 和 dispatch 继续只来自 `book-tool-contracts`;本切片只增加分发和启动能力。
- 一个 MCP 进程只绑定一本书。显式 CLI / `UNDERSTAND_BOOK_DIR` 优先,否则读取 Reader 最后打开书。
- visitor MCP 只读书基座,不打开 resident memory/profile/history/provider settings。
- 插件只带 manifest 与启动器;Setup 带 Windows MCP 二进制。
- 公共 Git plugin 与 Setup 是两个发布物;二者都发布后才算用户可用。

## 切片

### PM1 - 选书入口

- `book_mcp` 支持无参数启动并复用 Reader session 当前书。
- 单测覆盖优先级、缺失状态、显式无效输入和 session fallback。

### PM2 - 插件声明

- 根插件与 `plugins/understand-book` 同步 `.mcp.json`、Windows launcher 和 `mcpServers` manifest 字段。
- launcher 支持 `UNDERSTAND_BOOK_MCP_BIN` 测试/便携覆盖,默认读 Setup registry。

### PM3 - Setup sidecar

- release 前编译 `book_mcp` 并复制为 Tauri external binary。
- NSIS 安装目录同时含 Reader、build sidecar 与 `book-mcp.exe`。

### PM4 - 确定性验收

- 临时最小书通过打包二进制完成 MCP initialize/tools/list/tools/call。
- 插件 validator、根/公开副本 parity、release config、Rust workspace 与 Windows package gate 全绿。
- 从冻结提交构建 Setup,记录 size/SHA-256/version;不吸收用户既有 dirty 文件。

## 完成定义

- Codex 插件加载后出现 `book_*` 工具且 schema 来自现有单源 registry。
- 新线程绑定 Reader 最后打开书;切书后新线程绑定新书。
- 无 Reader 当前书或未安装 Setup 时启动明确失败,不静默选错书。
- 正式 Setup 确实携带 `book-mcp.exe`,公共插件快照具备 MCP 声明。
