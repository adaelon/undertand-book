# MW7 运行恢复、辅助入口、认证与状态边界记录

日期：2026-09-18
基线：`8dea7b0`；在既有 MW0–MW6 与 RP 未提交工作树上增量实施。
结论：实现完成并通过本地确定性验证；正式 Linux 认证后入口、真实断网设备与 iPhone 后台生命周期留给 MW8 外部验收。

## 实现

- `useAgentRun` 在观察已知 turn 时先发起 `agentRun(turn_id)` 快照核对，并保持至多一个 EventSource。`visibilitychange`、`pageshow` 与 `online` 合并到同一在途核对；快照与 SSE 统一按 book/session/turn 和 `last_seq` 安装。
- 终态只通知一次。401/403 关闭事件订阅并显示认证状态；404 将原运行标为不可核对的 `interrupted`，不继续假装生成；临时断网保留原运行身份等待下次核对。
- App 恢复时核对当前 source/book 与 Agent history。其他窗口切书会使旧运行失效并重新初始化当前权威书；旧书回调不能装入新书。
- 创建请求响应未知时保留本地“提交结果待核对”记录，使用提交前 turn 集合与同会话历史发现已接受 turn；没有证据时不再次 POST。
- RightRail 的成果、画像待确认项、轨迹、公式和笔记均为显式 tab/tabpanel，移动导航可进入同一辅助树；关闭问答仍不调用取消接口，停止按钮继续使用原 cancel API。

## 验证

- 红测试先复现：生命周期恢复没有快照 GET、并发恢复未合并、缺少 401/404 分类、终态可能重复通知，以及未知创建结果没有确定性发现合同。
- MW7 定向：`useAgentRun`、run reducer、未知提交发现及 RightRail 共 29 项通过；与 MW9 合并后的定向集合 37/37 通过。
- Web 全量：53 文件、271 项通过；生产 build（含 `vue-tsc --noEmit`）通过。
- 移动工作区 Playwright：Chromium、WebKit、低高度横屏和桌面 12/12 通过。
- 2026-09-18 从当前工作机匿名访问正式公网根路径与 `/api/desktop/status` 均返回 401；未使用或记录密码。

## 已知限制

- 当前环境没有 `READER_URL`/认证变量，未执行认证后页面、PDF、SSE 与恢复闭环；401 只证明匿名访问仍被拒绝。
- POST 响应丢失、服务重启和断网完成通过确定性前端测试覆盖，尚未在正式 Linux 隔离实例注入。
- HTTP Basic Auth 仍不提供传输加密；本切片没有新增匿名 API、认证旁路或多设备会话隔离。
