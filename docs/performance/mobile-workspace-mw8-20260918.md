# MW8 端到端验收、发布和回滚记录

日期：2026-09-18
基线：`8dea7b0`；验收对象为同一受保护工作树中的 MW1–MW7 与 MW9。
结论：本地定向验证、Linux 隔离实例直连验证与生产版本切换后的服务器直连复验通过，整体仍为**部分完成**；没有真实 iPhone、认证后的 Linux 正式入口或真实回滚复验证据。

## 已完成证据

- Web 全量 Vitest：53 文件、273 项通过；覆盖工作区投影、手机顶栏按需覆盖、原生 selectionchange、PDF 渲染代际/预算、RP 稳定 iframe、运行恢复、未知提交及阅读表面偏好。
- `pnpm -C packages/web build` 通过类型检查与生产构建；仅保留既有大 chunk 警告。
- `playwright.mobile.config.ts` 的 mobile Chromium、mobile WebKit、844×390 触控横屏和 1440×900 桌面共 12/12 通过；根横向溢出、同实例切区、冻结选区、代码展开及 IME 零误发送保持。
- 正式公网入口的匿名根路径与匿名 `/api/desktop/status` 均实测为 401；没有关闭全站认证。
- 发布说明已补充同版 Web/Server、运行恢复、显式阅读表面、认证后 SSE/PDF 复验及保留私人数据的回滚边界。

## Linux 隔离实例验证

- 当前未提交工作树以受限源码包同步至 `115.190.121.150:/opt/understand-book/acceptance/mw8-20260918-current/source`：1,439 个 Git 管理文件及源码、测试、文档目录中的新增文件；同步包不含 `.env`、`node_modules`、`target`、`tmp`、memory 或 private 数据。该目录先作为隔离验收源，生产切换记录见下一节。
- 远端按冻结锁文件安装依赖；旧缓存缺少 `@modelcontextprotocol/sdk@1.30.0`，联网补齐后 Web 全量 53 文件/271 项通过，生产类型检查与构建通过。`cargo build --offline --locked --release -p server --bin server -j 1` 在 veLinux x86_64 上通过。
- 当前 Server 与当前 Web dist 以 `understand-book` 服务账户运行于 `127.0.0.1:8788`，使用独立 memory/private 目录。首页、`/api/desktop/status`、书库切换、来源 manifest、PDF source map 与原始 PDF 均返回 200；PDF 响应为 `application/pdf`，样例大小 2,646,721 bytes。
- 一次隔离 Agent 请求返回 202，只创建 turn `turn_c9ee3535bbbe4a7c`。SSE 捕获到增量回答、模型/工具活动、`run.finalizing` 与一次 `run.completed`；最终快照为 `saved/completed`、`last_seq=51`、19 个活动、6 个来源、无错误。Server 优雅停止并重启后，当前书、同一 session/turn、序号、终态与来源数全部恢复，历史 turn 总数仍为 1。
- `cargo test --offline --locked --release -p server --test presentation_preview` 通过：2 项可执行测试通过，8 项依测试合同因缺少真实 Chromium/Edge 跳过，0 失败。原始响应、SSE、重启快照和日志保存在远端 `acceptance/mw8-20260918-current/evidence/`；验证实例已停止。
- 隔离验证前后生产 `understand-book.service` 均为 active，`127.0.0.1:8787/api/desktop/status` 为 200，8080 匿名 API 为 401，原 80 端口站点为 200。

## 生产切换与服务器直连复验

- 2026-09-18 20:37（Asia/Hong_Kong）将已完成上述 Linux 构建与隔离验证的工作树复制为独立 release：`/opt/understand-book/releases/working-tree-8dea7b0-mw8-20260918-2033`。release 内再次执行冻结依赖安装、Web 正式构建及 `cargo build --offline --locked --release -p server --bin server -j 1`，全部通过；切换前以 `understand-book` 账户在 `127.0.0.1:8788` 冒烟，首页和状态 API 均为 200。
- 切换前确认生产 Agent 没有 pending turn，并备份原 drop-in 到 `acceptance/mw8-20260918-current/evidence/10-release.before-working-tree-8dea7b0-mw8-20260918-2033.conf`。systemd 当前 `WorkingDirectory`、Web dist、启动脚本及实际 Server 进程均指向新 release，服务账户仍为 `understand-book`；旧 release `96215a67b24407c9ebe648718505cead683d5e44` 未删除，可用于回滚。
- 切换后服务为 active。`127.0.0.1:8787/`、`/api/desktop/status` 与既有 Agent history 均为 200；返回的首页与新 release 的 `packages/web/dist/index.html` 逐字节一致，新 JS 资源 `/assets/index-z4McdHLR.js` 为 200、1,543,780 bytes。
- 私人数据连续性已复核：当前书仍为 `ai-agent-engineering`，active session 仍为 `chat_1789521482450_14`，原有 3 个 turn 全部为 completed，没有因发布新增或重放 turn。8080 匿名 API 仍为 401，原 80 端口站点仍为 200，`nginx -t` 通过；启动日志只记录旧进程干净停止、新进程启动和监听 `127.0.0.1:8787`。
- 切换前后配置、状态、页面、API、历史和 journal 证据保存在远端 `acceptance/mw8-20260918-current/evidence/`。本次未改 Nginx、书库、memory、private 或 Provider 环境文件，也未制造生产 Agent 请求。

## 手机顶栏按需显示补丁

- 用户反馈手机端常驻全局顶栏占用阅读高度。`TopBar.vue` 在移动工作区中默认退出布局；`ReaderWorkspace.vue` 的底部导航新增“菜单”，按需将原顶栏作为覆盖层打开。目录、新对话、打开书和调试等原动作仍可达，执行动作或点击遮罩后收起；桌面顶栏保持原行为。
- `App.vue` 负责覆盖层开关和手机目录抽屉路由；从手机切回桌面投影时主动清除打开状态。CSS 在 `<1024px` 且仅限 reader 的 `mobile-collapsible` 顶栏使用 `display:none`，打开态改为固定覆盖层，因此关闭态不占工作区布局高度，loading/workbench 与桌面不受影响。
- 本地组件测试 9/9、Web 全量 53 文件/273 项、类型检查和生产构建通过。浏览器矩阵 12/12 覆盖 390×844 Chromium/WebKit、844×390 横屏及 1440×900 桌面，确定性断言手机工作区 `y=0`、菜单开闭、目录抽屉、新对话和桌面常驻顶栏。
- Linux 新 release `/opt/understand-book/releases/working-tree-8dea7b0-mobile-topbar-20260918-2110` 再次通过 Web 53/273 与正式构建；8788 隔离实例页面、状态、新 JS 均为 200，首页与新 dist 一致。2026-09-18 21:15 切入生产后服务 active，8787 页面/API/历史及新 JS/CSS 均为 200，生产 CSS 确认包含手机顶栏零布局占用规则。
- 切换后当前书、session 与原有 3 个 completed turn 保持，8080 匿名 API 401、80 端口 200、Nginx 配置通过。前一生产 release `working-tree-8dea7b0-mw8-20260918-2033` 与切换前 drop-in 均保留，证据位于既有远端 evidence 目录。

## 尚未完成

- G2/G4/G6/G7/G8/G11/G12 中要求真实 iPhone Safari、真实键盘/手柄/工具栏、旋转页或双栏 PDF 人工量测、后台/锁屏恢复、30 页资源观察与发布后桌面消费回归的部分没有证据。G10 只在 Linux 隔离直连实例证明了单次创建、SSE 终态与重启恢复，尚未经过 Nginx 认证入口的断网/响应丢失注入。
- 未提供 8080 的 `reader` Basic Auth 密码，因此只复核了匿名 401、Nginx 配置语法与直连后端；没有把 localhost 直连结果记为“认证后正式入口通过”。生产 systemd release 指针已经切换，但 Nginx 配置与认证文件未修改。
- 当前 Playwright 需要 Chromium v1228；服务器没有匹配浏览器，下载速度预计需半小时以上，已停止下载。Linux 真实页面的移动视口、Markdown/PDF 按钮与 canvas 浏览器检查未执行；本地 12/12 浏览器矩阵仍是该部分现有证据。
- 当前生产对象来自未提交工作树并以 `working-tree-*` 明示，不是发布提交。旧 drop-in 与旧 release 已保留，但没有为了演练而中断已通过的生产版本；因此尚无“前一 release + 新私人数据”的真实回滚复验证据。回滚合同保持：只恢复 systemd 的源码、Web dist、二进制引用，不删除聊天、笔记、高亮、画像或 RP 现场。

## 完成状态

`生产切换完成、服务器直连复验通过；MW8 整体仍为部分完成`。由于认证后正式入口、匹配浏览器、真实 iPhone 与真实回滚尚无证据，不得升级为“完整验收通过”或 MW8 整体“已部署并复验”。取得相应凭据与设备后，按 `docs/Linux阅读器部署.md` 的移动阅读发布核对继续。
