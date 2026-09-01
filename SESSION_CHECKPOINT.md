# SESSION_CHECKPOINT — 2026-09-01 19:42 +08:00

## 新鲜度自检

- 写入时基线 commit：`1d617da feat(build): calibrate executor MCP timing`。
- 本页与 M1b/M2/A1/A2/R1/R2/W1/S1/S2 作为紧随其后的同一 commit 提交；该 commit 会因包含本页而在提交后才获得 hash，读入时以 `git log --oneline -3` 为准。

## 当前在做什么

`Executor 传输标定与协议往返压缩` 已收口到 S2：M1b→S1 的保留切片已实施并验证；S2 tail-balance A/B 因缺少完整 balanced root terminal lifecycle 被拒绝，生产 scheduler 未改。

## 下一步（可直接接手）

1. 从 `git log --oneline -3` 确认 M1 与 M1b→S2 两个提交均已落地。
2. 只有新的完整 same-host balanced terminal trace 能重新打开 S2；不得用 durable 9/9 代替 lifecycle tail。
3. 若继续优化，先从 ADR-0116 的停止条件声明新切片，不重开已拒绝的 A1 或 S2 实验。

## 未提交 / 未完成

- 本切片：无。
- 工作树仍有与本切片无关的既有修改和未跟踪文件；它们不属于本提交，不清理、不覆盖。

## 冷启动读序

1. `docs/切片方案-executor传输标定与协议往返压缩.md` — 读 D0→S2 的保留、拒绝与停止回执。
2. `docs/adr/0116-calibrated-executor-transport-budget-and-round-trip-reduction.md` — 读传输、批量领取、冻结输入、Writer 与调度决策。
3. `docs/代码链路.md` 末尾 M1b→S2 条目 — 还原代码入口、测试与性能证据索引。
4. `docs/架构.md` Executor Session V3 段 — 还原 batch/final-ack、frozen input、remaining-work 与 slot observation 数据流。
5. `docs/performance/understand-book-s1-real-scheduling-observation.json`、`docs/performance/understand-book-s2-tail-balance-trial.json` — 读 S2 分支选择与拒绝证据。

## 本会话决策摘要

- A1：专用角色没有 `functions.exec`，在 0 MCP/0 attempt/0 commit 时停止，生产指令不变（ADR-0116 §3）。
- A2：`input.next.v4` 以受测 64 KiB tier 返回连续 batch，final ordinal 由 `generation.start.v3` 原子确认（ADR-0116 §3）。
- R1/R2：public/private start 复用 create-only frozen input，保留 current identity、binding 与 output contract 校验（ADR-0116 §4）。
- W1：仅 proof-bound Pass1 writer 改为当前 deterministic build 进程内同步提交，其他 stage writer 不变（ADR-0116 §5）。
- S1/S2：tail idle-slot 下界大于 refill 上界；balanced 两次无完整 root terminal lifecycle，试验拒绝且 scheduler 不变（ADR-0116 §6）。

## 最近验证

- M1b→S2 实施期：相关 Core/Driver/Session/Transport/MCP/Observation/R7 测试、Core typecheck、Build Engine 与发布 parity 均通过；逐刀详情见 `docs/代码链路.md`。
- 提交前复验：Core typecheck；Driver 22/22；Session 互斥分组 15/15 + 15/15；其余 transport/MCP/observation/routing/handoff/release 测试 89/89；plugin source contract；改动 `.mjs` 语法；14 份本切片 evidence JSON 解析；staged diff check，全部通过。
