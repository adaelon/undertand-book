# Agent 工具循环预算与 Linux 高亮修复生产发布记录

日期：2026-09-19
生产 release：`/opt/understand-book/releases/working-tree-c12cbb9-agent-loop-20260919-1050`
上一生产 release：`/opt/understand-book/releases/working-tree-8dea7b0-mobile-topbar-20260918-2110`

## 结论

当前工作树已同步到独立 Linux release，并在隔离端口验证后切入生产。Agent 能在每轮工具采样中看到当前轮、十二轮上限和剩余轮数；达到工具循环上限时，已经通过最终修复的回答不再被通用失败文案覆盖。2026-09-19 的 Markdown 源文本/DOM 双向坐标、规范引用和完整渲染后高亮修复也包含在同一个 release 中，并已通过 Linux Web 全量测试和生产构建。

## 同步范围与构建阻断修复

- 发布包包含当前工作树的受控源码、测试和文档，不包含 `.env`、`node_modules`、`target`、书库、memory 或 private 数据。服务器解包后的 release 共 1,372 个文件。
- 切换前在服务器 release 目录直接核对 `packages/web/src/markdown-source-map.ts`、`markdown-source-map.test.ts` 与 `App.vue`，确认 `createMarkdownDomSourceMap`、`markMarkdownDomSourceRanges`、`renderSegWithFocus`、`selectedRangesForElement` 和 `resolvedSelectionQuote` 均存在并已接线。
- 干净 Linux 构建首次暴露 `AnswerPatch.ts` 的跨目录错误 import。原因是 `AnswerPatch` 没有声明稳定的 ts-rs `export_to`，本机又有未纳入发布包的重复目录，偶然掩盖了错误。`crates/runtime/src/answer_stream.rs` 现与其他导出类型一样声明生成目录，测试改用 `AnswerPatch::export_all()`；生成文件引用恢复为 `./AgentAnswerView`。
- 修复后服务器执行冻结依赖安装、Web 全量测试、Web 正式构建、两项 Agent 定向测试及 release Server 构建。Web 为 54 个文件、283 项通过；构建只保留既有的大 chunk 警告。Runtime 的预算可见测试、Server 的上限终态保留测试及 AnswerPatch 导出测试均通过。

## 隔离验证

- 新 release 以 `understand-book` 账户运行在 `127.0.0.1:8788`，使用独立的 memory/private 目录，不读写生产聊天与私有成果。
- 首页、`/api/desktop/status`、`/api/agent/history` 均返回 200；首页与新 release 的 `packages/web/dist/index.html` 逐字节一致。
- 隔离进程收到 SIGTERM 后正常退出，8788 端口已释放。

## 生产切换与复验

- 切换前生产服务 active，仍指向上一 release；Agent 历史中没有 pending、running 或 finalizing turn。旧 drop-in 已备份到 `/opt/understand-book/acceptance/agent-loop-20260919-1050/evidence/10-release.before-working-tree-c12cbb9-agent-loop-20260919-1050.conf`。
- systemd drop-in 只替换 WorkingDirectory、Web dist 和启动脚本的 release 路径；Nginx、书库、memory、private 与 Provider 环境文件未修改。
- 切换后服务 active，实际 Server 可执行文件和 cwd 都来自新 release。`127.0.0.1:8787/`、状态 API、Agent 历史 API 与新 JS 资源 `/assets/index-DGR7RZzC.js` 均返回 200；线上首页与新 release 的 dist 逐字节一致。
- 切换前后的 Agent 历史响应逐字节一致：当前书仍为 `ai-agent-engineering`，active session 仍为 `chat_1789786041403_16`，共 6 个会话、11 个 turn、0 个进行中 turn。
- `nginx -t` 通过；8080 匿名 API 仍返回 401，80 端口返回 200。journal 记录旧进程干净停止、新进程正常监听 `127.0.0.1:8787`。

## 回滚入口

若新版本后续出现生产问题，只恢复上述备份 drop-in，执行 `systemctl daemon-reload` 并重启 `understand-book.service`。上一 release 保留未删除；回滚不得替换或删除书库、memory、private、聊天、笔记、高亮和画像数据。

## 已知限制

- 本次没有 8080 Basic Auth 凭据，因此只复核匿名 401、Nginx 配置和后端直连，没有宣称“认证后公网浏览器入口通过”。
- 为避免向生产历史制造测试对话，本次没有发起真实 Provider 问答。工具循环两项行为由定向测试覆盖，服务层由状态、历史与启动日志复验。
- 服务器没有匹配的 Chromium/Edge；Linux 上执行的是 54 文件/283 项 Web 测试及正式构建，没有把无浏览器环境表述成真实 Linux GUI 手工验收。
