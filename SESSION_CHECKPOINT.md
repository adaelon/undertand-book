# SESSION_CHECKPOINT — 2026-09-18 21:45（Asia/Hong_Kong）

## 新鲜度自检

- 本页写入前 HEAD：`814e9a1 feat(agent): deliver rich presentation authoring`；本页将随 MW 提交进入其下一笔 commit。
- 本轮已形成：`499363f feat(build): land executor recovery and structure append`、`814e9a1 feat(agent): deliver rich presentation authoring`，以及包含本页的 MW 提交。
- 读入时先对比 `git log -4 --oneline`；若不一致，以 Git 为准。

## 当前在做什么

A/R、RP、MW 已按边界整理为三笔提交。MW0–MW7、MW9 本地定向验证完成；MW8 已完成 Linux 隔离直连、生产切换后的服务器直连复验和手机顶栏补丁发布，但完整外部验收仍为“部分完成”。

## 已验证状态

- A/R：Core 类型检查通过；146 条定向断言通过。Vitest 长文件仍会报告既有 `onTaskUpdate` worker 通信超时，单独复跑 Executor Session 的 44 条断言亦全部通过但 runner 保持同一非零错误。
- RP：Runtime 呈现定向 32/32；Server 呈现定向 19/19，7 项需真实 Chromium/Edge 的测试按合同忽略；既有 Windows/Linux 真实体验证据已归档。
- MW：Web 全量 53 文件/273 项、类型检查、生产构建及移动 Chromium/WebKit/横竖屏/桌面矩阵通过；Linux release 构建、隔离 SSE/重启恢复和生产直连复验通过。
- 生产 release 仍为 `/opt/understand-book/releases/working-tree-8dea7b0-mobile-topbar-20260918-2110`；源码提交后尚未按 commit release 重新发布。

## 下一步（可直接接手）

1. 获取 8080 `reader` Basic Auth 密码，以认证入口复验页面、API、PDF、SSE、同 turn 断网恢复和创建响应丢失；密码不得写入命令历史或证据。
2. 在具有 Playwright Chromium v1228 的环境连接 Linux 实例，执行 390×844 页面、Markdown/PDF 切换和 PDF canvas 检查。
3. 用真实 iPhone Safari 执行方案 §6.2 A–D、旋转/后台/锁屏/中文 IME/原生手柄并记录 viewport。
4. 在维护窗口真实回滚到保留 release，再前滚到基于新提交构建的 release；确认聊天、笔记、高亮、画像与 RP 现场连续。
5. 若需要清理工作树，先逐项识别剩余代码只读 MCP、质量评估、学习设计、临时证据与本地配置；不得整体 reset、checkout 或盲目 stash。

## 未提交 / 未完成

- 未完成：8080 认证后入口、匹配 Chromium 的 Linux 页面检查、真实 iPhone、双栏 PDF ≤2 CSS px 人工量测、30 页资源观察及真实回滚复验。
- 工作树仍保留不属于 A/R、RP、MW 的既有修改和大量本地产物；本轮不替用户提交或删除。
- 远端 `/opt/understand-book/repository` 的脏检出未处理；现行独立 release 不受影响，后续不得直接复用该目录发布。

## 冷启动读序

1. 本页；`git log -4 --oneline`；相关路径 `git status --short`。
2. `docs/切片方案-移动端阅读工作区与横竖屏适配.md` 的 MW7–MW9、§5–§8。
3. `docs/performance/mobile-workspace-mw7-20260918.md`、MW8、MW9；必要时回读 MW4–MW6。
4. `packages/web/src/useAgentRun.ts`、`agent-run-state.ts`、`agent-submission-recovery.ts` 及对应测试。
5. `packages/web/src/reader-surface.ts`、`components/ReaderWorkspace.vue`、`App.vue` 的表面选择与恢复路径。
6. `docs/Linux阅读器部署.md` 的“移动阅读发布核对”；`docs/架构.md` 与 `docs/代码链路.md` 的 MW 尾部记录。

## 本会话决策摘要

- 提交边界：A 与 R 同一提交；RP、MW 各自独立；共享 Web 文件用 MW0 基线拆分，其他本地工作不纳入。
- 移动布局：设备侧投影不新增后端布局真相；手机全局顶栏为按需覆盖层，关闭态零布局占用。
- 运行恢复：已知 turn 只按权威快照/SSE 接回；创建响应未知时先核对历史，不自动重提。
- 阅读表面：Markdown/PDF 偏好按设备与 `book_id + source_fingerprint` 保存，无可靠映射时明确降级而不猜位置。
