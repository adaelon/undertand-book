# SESSION_CHECKPOINT — 2026-08-31 15:44 +08:00

## 新鲜度自检

- 写入时最新 commit：`4cc345f feat(build): land bounded executor T1-T8 rollout`。
- R0-R7 与本轮 R8 minimal 均位于该 commit 之后的工作树，尚未提交；读入时对比 `git log --oneline -3` 与目标路径 `git status --short`，不一致则以 Git/工作树为准。
- 双 manifest 仍是旧 `0.1.0+codex.20260828030148`；尚未运行 cachebuster helper、正式 reinstall、角色迁移或新 parent。

## 当前在做什么

R8 已从“V1/V2 控制状态全量迁移”收缩为“发布换代 + 旧历史只读 + 新确认计划/Session V3 接管”，下一步是解决正式安装来源后发布，并为用户指定 EPUB 创建 `standard_deep`、`pass2=disabled`、`max_parallel=3` 的精确计划。

- Pass1 close V1→V2 原地归档/替换已删除；旧 V1 原字节不变并返回 bounded recovery。
- Current public handoff 现在直接签发无 predecessor 字段的 V3 record；zero-open V2 supersession API、记录与 synthetic 转换已删除。
- Session V3、reader-private S4、legacy lease/dispatch 只读分类和按语义身份采用 accepted artifact 的现行复用分支保留。
- 编译 Sidecar 已刷新；T7 exact-four source/compiled smoke 通过且 final_status=committed。
- 安装源阻断：当前 `understand-book@understand-book` 来自 Git marketplace `https://github.com/adaelon/undertand-book.git`；personal marketplace 没有本地 entry。直接重装只会得到远端旧代码。

## 下一步（可直接接手）

1. 获取用户对安装来源的选择：推荐把本次 R8 运行切到独立 local marketplace；另一选择是先提交/推送远端再 upgrade Git marketplace。
2. 若选 local：按 `plugin-creator` helper 更新 `plugins/understand-book` cachebuster，把同一版本投影到根 manifest，运行 plugin validator/source+compiled release gate，再配置不覆盖 Git source 的 local marketplace 并安装。
3. 对精确已知 agent-only predecessor 运行备份式角色迁移，启动新 parent，运行 synthetic protocol doctor；未知 Agent 正文失败关闭。
4. 在新 parent 解析安装 Build Engine 与目标 EPUB，调用一次 `legacy-plan --pass2 disabled`，展示 code-issued 精确 projection 并等待确认。
5. 确认后创建 `max_parallel=3` invocation，先一个 slot canary，再按 first-terminal 补到最多三 child，执行至 `DONE` 或真实 `NEEDS_USER`。

## 未提交 / 未完成

- 已改未提交：R0-R7 大量源码/测试/文档，以及本轮 R8 minimal 的 close、direct V3 issuance、测试、Sidecar、ADR/架构/代码链路。
- 待完成：cachebuster、正式安装、known-predecessor role migration、新 parent、synthetic doctor、EPUB plan projection/确认、canary/wave、最终 evidence。
- 未触碰：用户真实旧 plan/policy/lease/dispatch/close/handoff/session/attempt/receipt、旧目标 accepted artifact、指定 EPUB 的 workspace/plan/invocation。
- 测试限制：完整 Session 文件 27/27 功能断言通过，但 126 秒单文件运行被已知 Vitest `onTaskUpdate` RPC timeout 置为 exit 1；相关短组 4/4 clean exit，driver rehydrate 1/1、S4 2/2、close 7/7、release marker 1/1、Core typecheck 与 compiled T7 smoke 均 clean exit。

## 冷启动读序

1. `docs/adr/0115-root-shared-executor-mcp-and-subagent-inheritance.md` — 读 §7、§12 的发布接管修订。
2. `docs/切片方案-root共享Executor-MCP注册与继承.md` — 读 R8、H4 修订、验证矩阵与 DoD。
3. `CONTEXT.md` — 读“发布接管”“语义复用身份”“共享 Executor MCP 注册”。
4. `docs/代码链路.md` — 读末尾两个“R8 发布接管收缩”条目；`docs/架构.md` 读 automatic-build-executor-session/direct V3 数据流。
5. `packages/core/src/automatic-build-close.ts:reconcileAutomaticBuildStageCloseResult`、`packages/core/src/automatic-build-executor-session.ts:issueAutomaticBuildOpaqueHandoff/validateV3OpaqueHandoffRecord`。
6. `C:/Users/Lenovo/.codex/skills/.system/plugin-creator/references/installing-and-updating.md` — 恢复 marketplace 来源阻断与更新流程。

## 本会话决策摘要

- §7 发布接管边界：旧控制状态只读，新 V3 计划接管；已落档到 ADR-0115 §7。
- §12 派生关闭结果重算：旧 close 不迁移，当前 projection 从当前事实重算；已落档到 ADR-0115 §12。
- Current public handoff：生产 issuer 直接 V3，不再先 V1 后 supersede；已落档到切片方案 H4/R8 与代码链路。
