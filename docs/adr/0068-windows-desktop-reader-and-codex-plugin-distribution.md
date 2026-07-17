# ADR-0068 Windows desktop reader and Codex plugin distribution
Status: Accepted, 2026-07-11.

**决策**:以 per-user NSIS Setup 分发 Tauri 2 Reader、确定性 build sidecar 与公开 Git marketplace Codex plugin。

**否决**:
- Electron:重复引入 Node 桌面运行时,包体和进程边界更重。
- 重写 REST 为 Tauri IPC:破坏已验证的 Web/Server 命令面并扩大迁移面。
- 把插件永久捆死在 Setup 内:无法在 Codex 中独立安装和升级。
- 把 TS 构建核心重写成 Rust:形成高风险的双实现迁移。
- 全机器安装:App 与用户级 Codex/plugin/memory 所有权冲突。

**命门**:Reader 安装与 plugin 安装分事务;plugin 安装需明确授权且只认 CLI 验证后的 Codex 入口。sidecar 与 plugin 以 `automatic_build.v1` 握手,不兼容时 fail-fast。默认书库与外部 workspace 只建索引、不复制 truth。

**落地协议**:
- Setup 为 currentUser NSIS;Reader 进程内启动 random-loopback server,无书时只暴露 bootstrap 书库入口。
- Codex 探测顺序固定为 PATH,再扫描 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`;候选必须通过 `plugin --help`。
- release build 必须注入公开 Git `UNDERSTAND_BOOK_MARKETPLACE_SOURCE`;缺失时只允许 pending debug 包,正式导出拒绝继续。
- 安装回执位于 `%LOCALAPPDATA%/UnderstandBook/plugin-installation.json`;没有回执就不卸载已存在插件。
- sidecar 是 Bun 编译的单 exe,内嵌 extractor prompts 与确定性 TS pipeline;Codex plugin 包不携带 Node 依赖。

**何时回头**:Tauri/WebView2 无法稳定承载 localhost Reader,或 Codex 提供稳定的 App 原生 Git marketplace 安装协议以替代 CLI 检测。

## Marketplace source migration

**决策**:仅迁移 Setup receipt 拥有的同名 marketplace。

**否决**:
- 无条件 remove/re-add:可能删除用户自行管理的同名 source。
- 永远报错交给用户:使 Setup-owned 插件无法随发布 source 演进。
- 直接编辑 Codex config:绕过 CLI 契约并绑定内部存储格式。

**命门**:receipt 必须匹配 plugin/marketplace 名且 `marketplace_added_by_setup=true`;同源只调用 upgrade。
**何时回头**:Codex CLI 提供原子 source replace 或可验证的 marketplace ownership API。
