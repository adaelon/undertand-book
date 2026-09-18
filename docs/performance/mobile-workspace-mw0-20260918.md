# MW0 移动阅读工作区基线与安全接手

状态：本地基线与合同盘点完成；Linux 运行版本、真实 iPhone Safari、软键盘和系统后台行为未核验。记录时间：2026-09-18，Asia/Hong_Kong。

## 基线身份与保护

- 本地分支：`main`；HEAD：`8dea7b01290bba136f7332b01b20972d8a9d661f`，`feat(build): deliver prebuild recovery, bounded reads and structure evidence`。
- 接手时工作树：77 个 tracked 变更、258 个 untracked 顶层状态条目。Web 的 `App.vue`、`RightRail.vue`、`api.ts`、`agent-run-state.ts` 已含 RP5–RP7 未提交成果。
- 本任务触达文件已复制到 `tmp/mobile-workspace-mw0-baseline-20260918-1743/`；未执行 reset、checkout、stash、依赖升级或线上写操作。
- 当前工具链：Node `v24.9.0`、pnpm `10.34.2`、Playwright `1.61.1`。

## 区域、slot 与权威入口

| 用户入口/区域 | 当前组件 | 正式 slot | 权威状态或 API | MW0 结论 |
| --- | --- | --- | --- | --- |
| 目录、结构图、论文地图 | `LeftRail.vue` | `technical.structure_map`、`paper.structure_map` 可映射；其余左/底部 slot 未挂载 | `ReaderLayoutState`、论文地图 API、`reader.layout.apply` | 组件是综合导航壳，不能把它等同任意一个 slot |
| Markdown 正文 | `ReaderPane.vue` | 否；是 Reader 主表面 | Reader viewport、`reader.position.observe`、既有 goto | 设备几何变化不得调用 layout/goto |
| PDF 正文 | `PdfReaderPane.vue` | 否；是 Reader 主表面 | PDF/source-map/selection API | MW4 才处理容器重绘；MW0–MW3 保留现状 |
| 问答 | `RightRail.vue` 的 `agent` tab | `technical.agent`、`paper.agent` 可映射 | Agent history/run/SSE、`reader.layout.apply` 仅处理正式 slot | 本地 tab 切换不是正式 slot mutation |
| 笔记 | `RightRail.vue` 的 `notes` tab | 否 | memory API | 手机导航只改变前景，不伪造 slot |
| 成果、画像、轨迹、公式 | `RightRail.vue` 本地 tabs | 当前没有逐项同名正式 slot | 各自既有 API | 空间不足时进入同一辅助区域，不改后端布局 |
| 来源预览 | `RightRail.vue` 浮层 | 否 | `agentSourceResolve` | 预览无导航副作用 |
| 来源正文打开 | `RightRail.vue` → App 同步 | 否 | `agentSourceOpen` 恰好一次 | 成功后读取当前 Reader 状态；不得再补一次 goto |
| `technical.evidence`、`paper.evidence` | 当前无独立组件 | 是 | `reader.layout.apply` | 显示为未挂载能力，不把来源浮层冒充 evidence slot |
| `paper.abstract_aid`、`paper.codebook`、`paper.ten_questions` | 当前无逐 slot 宿主 | 是 | `reader.layout.apply` | MW0–MW3 不伪造已挂载状态 |

正式 slot 来自 profile manifest；当前 UI 的 `agent/artifacts/profile/trace/formula/notes` 是本地 tab 集合。后端 reducer 继续拥有 open/close/focus/preset/revision，设备侧投影只决定可见摆放。

## 响应式规则与滚动所有者

| 表面 | 当前纵向滚动所有者 | 横向/局部滚动 | 基线问题 |
| --- | --- | --- | --- |
| 目录 | `.left-rail`；目录内部 `.outline-list` | 顶栏 actions 可横滚 | ≤767px 时目录仍在正文上方占据文档流 |
| Markdown | `.reader-pane` | 代码/表格 `.asset-source` 局部横滚 | ≤767px 将整个工作区改成 block，正文与右栏串成长页面 |
| PDF | `.pdf-reader-pane` | 页面内部画布/文本层 | 容器尺寸变化重绘留给 MW4 |
| 问答 | `.right-rail` 固定壳；`.transcript` 与各 tab panel 内滚 | 代码块局部横滚 | ≤1023px 整个右栏排到正文下面，问答不能一步到达 |
| 来源与其他浮层 | fixed/sticky 浮层自身 | 内容按组件局部滚动 | 只使用 `window.innerHeight`，尚未统一 VisualViewport |

当前 CSS 在 ≤1023px 使用“左＋正文，右栏下一行”，在 ≤767px 使用 `display:block`，并以 `body { overflow-x:hidden }` 掩盖整页越界。这个行为与 MW2 的单区域/对照合同不符，是后续浏览器测试必须先红后绿的现状。

## 源码与运行版本对照

| 项目 | 结果 |
| --- | --- |
| 本地源码 | HEAD `8dea7b0` 加当前大体量未提交工作树；不是可复现发布提交 |
| 本地 Web 基线 | `pnpm -C packages/web typecheck` 通过；`pnpm -C packages/web test` 43 文件、230 项通过 |
| Linux 服务 | 当前主机没有可解析的 `reader-linux` SSH 别名；未取得服务 WorkingDirectory、release commit、Web dist 或 Server 二进制身份 |
| 公网入口 | 部署文档记录 HTTP Basic Auth 的 `:8080` 入口；本轮未使用凭据、未变更配置、未写线上私有数据 |

本地 HEAD 不能替代 Linux 版本证明。MW8 发布前必须在实际服务账户读取 release 目录 Git 提交、systemd WorkingDirectory/ExecStart、`UNDERSTAND_BOOK_WEB_DIST`，并核对页面/API 同版。

## 设备与故障基线

- 本轮没有连接真实 iPhone；机型、iOS/Safari、VisualViewport、软键盘、工具栏伸缩、旋转、长按手柄和后台/锁屏均标记为“真机未验证”。
- 当前实现可由源码确定复现：390×844 进入 block 布局，目录、正文、右栏纵向串联；844×390 仍落入 ≤1023px 的“右栏下一行”，不会因对照意图与实际高宽进入双区域。
- 当前 Markdown 选区仅由 prose `mouseup` 通知 App；触屏原生 `selectionchange`、输入控件排除、冻结快照和重复事件合并尚未实现。
- 当前选择提问在点击动作时消费 `hlPopover`，但浮层只由 mouseup 建立；移动端长按手柄路径没有确定性入口。
- 当前来源 resolve 和 open 已分离，打开正文只调用一次 `agentSourceOpen`；没有“返回回答/原读位”的前端返回点栈。
- PDF 重绘、RP 窄容器与运行恢复属于 MW4–MW7，MW0–MW3 不把这些风险标绿。

## 保留回归与下一刀入口

- 保留 Web 全量 43 文件/230 项；其中 `ReaderPane.test.ts`、`RightRail.test.ts`、PDF selection/note、Agent run、来源、RP 组件测试与本任务直接相关。
- MW1 新增纯投影红绿测试：732px 边界、临界高度、零尺寸、focus/compare/auto、输入优先、旧上下文 focus、未知 slot/preset，以及零 API 副作用。
- MW2 新增工作区/视口组件测试和移动浏览器场景：单区域一步切换、对照条件、稳定实例、动态视口、目录抽屉、44px 操作、无根横向溢出。
- MW3 新增选区与连续性测试：selectionchange、触屏/键盘、输入排除、冻结快照、UTF-16/emoji、来源返回点、草稿和语义锚点。

MW1 入口已解锁：MW0 的映射、滚动所有者、现状失败、保护范围和未核验项均已明确。
