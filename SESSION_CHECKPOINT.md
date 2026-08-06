# SESSION_CHECKPOINT — 2026-08-06 15:47 +08:00

## 新鲜度自检

- 写入基线：`bc3b739 fix(build): bound Pass1 stitch reduction`。
- 本文件与当前实现、测试、文档均未提交；读入时先比较 `git log --oneline -3`，不一致时以 Git 和工作树为准。
- 工作树另有 6 个 tracked 用户旁支及大量 untracked 资料/日志，均受保护，不得撤销、覆盖或误纳入本修复。

## 当前在做什么

Retry 隔离、writer failure 终态与 Pass1 shadow CLI boundary 夹具迁移已实现且全量验证通过；当前只待用户审阅并决定是否按精确文件集合提交。

## 下一步（可直接接手）

1. 运行 `git diff --check`，确认仅有仓库既有 LF→CRLF 提示且无 whitespace error。
2. 审阅 `packages/core/test/pass1-shadow-cli.test.ts`：合法候选来自 frozen rendered child 0↔1，child 0↔4 负例仍被 adjacent-boundary gate 拒绝。
3. 审阅 retry 主线的 9 个实现/测试文件及 `docs/{代码链路,架构,切片方案-预算可路由模型工作单元与构建恢复闭环}.md`，保持 6 个 tracked 用户旁支与全部 untracked 项排除。
4. 若用户授权提交，只按审阅确认的精确 path stage；不得使用 `git add -A`，不得删除既有构建状态或 untracked 项。

## 未提交 / 未完成

- 目标主线（12 个 tracked 文件，含本 checkpoint）：`SESSION_CHECKPOINT.md`、`skills/build/automatic-build.ts`、`packages/core/src/{automatic-build-task-store,automatic-build-mailbox}.ts`、`packages/core/test/{automatic-build-lease,automatic-build-routing-v3,automatic-build-mailbox,pass1-shadow-cli}.test.ts`、`apps/desktop/scripts/smoke-workbench-sidecar.mjs`、`docs/{代码链路,架构,切片方案-预算可路由模型工作单元与构建恢复闭环}.md`。
- 已完成行为：executor reset 恢复窗口；shadow candidate 按 physical attempt + candidate SHA 隔离；writer 异常固化 `failure.json + result.json(outcome=failure)` 并返回 canonical failure receipt；CLI 测试候选只从 frozen adjacent projection 生成。
- 受保护 tracked 旁支（6 个）：`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{profile,review}.rs`、`crates/runtime/src/profile_api.rs`、`docs/切片方案-切片1前端阅读器.md`、`docs/预购建流程.md`。
- 全部 untracked 书籍、handoff、图片、日志、临时目录和测试产物（含 `.tmp-book-mcp-client.mjs`）均不属于本修复。

## 已验证

- Red：`pass1-shadow-cli` 0/1；旧夹具在五 child final stitch 中把 rendered child 0 直连 child 4，抛 `outside adjacent child boundary projections`。
- Green：`pass1-shadow-cli + pass1-reduction` 16/16；负例证明非相邻投影边仍 fail closed。
- Retry/mailbox/dispatch/lease/task-store 相关组合 43/43；Core typecheck 通过。
- 完整 Core：104/104 文件、669/669 用例通过，耗时 401.42 秒。
- `packages/core/src/pass1-reduction.ts` 与生产 digest/schema/policy/writer gate 本切片无 diff；架构未变，故本切片未改架构文档。

## 冷启动读序

1. `docs/adr/0100-budget-routable-model-work-units-and-truthful-build-recovery.md` — 不可降级的预算、恢复与质量边界。
2. `docs/代码链路.md:6066` 起的 BR6、Executor Reset、Shadow Candidate Retry、Writer Failure、Pass1 Shadow CLI Boundary — 当前账本与验证。
3. `packages/core/src/pass1-reduction.ts:1230` 起及 `agents/pass1-lid-stitcher.md` — bounded projection、verified children 与 adjacent-boundary 合同。
4. `packages/core/test/pass1-shadow-cli.test.ts` — 本轮唯一新增 test-only 修复及负回归。
5. `skills/build/automatic-build.ts:526`、`packages/core/src/automatic-build-mailbox.ts:410` 与三份对应回归测试 — retry/terminal-state 主线。

## 本会话决策摘要

- 真实 attempt 2 的 edge 6 是“端点不在 verified children”；本轮旧夹具是“端点均在 projection、但 child 0↔4 非相邻”，两类拒绝都应保留。
- 测试候选必须只消费 frozen rendered projection，不能从完整 child artifact payload 选端点。
- 未放宽 verified-children、adjacent-boundary、digest、schema、policy 或 writer gate；未删除或重建任何既有构建状态。
