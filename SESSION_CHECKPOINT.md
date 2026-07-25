# SESSION_CHECKPOINT - 2026-07-25 BP8 收口

## 新鲜度自检

- 写入时基线 commit:`2df1af3 feat(agent): govern requests and compact active context`。
- BP1-BP8 合并在包含本页的同一个 commit；冷启动先以 `git log --oneline -3` 和 `git show --stat HEAD` 核对本页。

## 当前完成状态

主线 `docs/切片方案-一键预构建租约与调度性能治理.md` 的 BP1-BP8 已全部实现、验证并落档。生产新 claim 默认已从 `automatic_build_protocol.v2` 切换为 `automatic_build_protocol.v2_dispatch`；旧 v2 仍可显式选择，只读续建既有 task/artifact，不迁移、不重写。

已完成能力包括 candidate UTF-8/BOM 止血、三维执行身份、reserved/running lease、append-only 生命周期与 provenance、deterministic dispatch planner、multi-task executor handoff、墙钟预算/adaptive TTL/动态补位，以及 BP8 canonical protocol parity、protocol doctor 和 packaged/plugin release。

冻结总顺序仍是 `BP1-BP9 -> IP1-IP10 -> BP10`。下一实施切片是 BP9；不得提前做真实模型默认切换、router 迁移或历史删除。

## BP8 验收真相

- `pnpm -C packages/core test -- automatic-build`:13 files / 74 tests passed。
- `pnpm -C packages/core typecheck`:passed。
- 重编 packaged sidecar 后 `node apps/desktop/scripts/smoke-automatic-build-parity.mjs`:plan/doctor/next/dispatch/lease/receipt canonical byte parity、默认 dispatch、旧 v2 rollback passed。
- plugin cachebuster:`0.1.0+codex.20260725065404`；repo public、personal source、installed cache skill SHA-256 均为 `0587066c6ad2161f9b0ebc6fdcc3d50d4684fe9424c5c36607ebfdbc3fb71934`。
- 已安装 cache:`C:\Users\Lenovo\.codex\plugins\cache\personal\understand-book\0.1.0+codex.20260725065404`；旧 source 可恢复备份:`C:\Users\Lenovo\plugins\understand-book-backup-20260725065404`。
- 真实 Quantification packaged doctor 只读审计:Pass1 `46 fresh / 0 pending`；sidecar `3 fresh / 398 pending -> 65 dispatches`；`70` persisted attempts 均为 `legacy_inferred`；`49` v2 artifacts fresh。
- 全 workspace `517` 文件摘要前后均为 `F6148DCE49A9529DC8AF1C90FBBBB1C5B36FE744A4DA4F3713B70A50D5873FD4`，doctor 未 claim、未写 state。

## 关键入口

1. `packages/core/src/automatic-build-protocol.ts` - release v2、claim protocol resolver、canonical JSON。
2. `packages/core/src/automatic-build-dispatch.ts` - deterministic manifest planner、refill selector。
3. `packages/core/src/automatic-build-dispatch-runtime.ts` - accepted plan、run progress、task-by-task claim、bounded receipt。
4. `packages/core/src/automatic-build-budget.ts` - lifetime/remaining/scheduled cost、wall-clock evaluation、adaptive TTL。
5. `packages/core/src/automatic-build-task-store.ts`、`automatic-build-lease.ts`、`automatic-build-metrics.ts` - execution identity、phase lease、canonical lifecycle/provenance。
6. `skills/build/automatic-build.ts` - plan/next/dispatch CLI、protocol doctor、canonical stdout。
7. `skills/build/sidecar-entry.ts`、`apps/desktop/scripts/smoke-automatic-build-parity.mjs` - packaged entry 与 byte parity gate。
8. `apps/desktop/scripts/assert-plugin-release.mjs` - public/installed plugin release hash gate。

## 下一步

1. BP9 在隔离 benchmark namespace 使用真实 harness/model 回放固定 Quantification source/profile/policy。
2. 核对 Pass1 与 sidecar 的 quality floor、agent starts、dispatch wait、wall-clock prediction、恢复和 candidate 隔离。
3. BP9 只产性能发布结论，不覆盖当前 workspace、不切默认模型、不用 fake executor 冒充真实结果。
4. BP9 完成后再按冻结顺序进入 IP1-IP10；BP10 模型 A/B 最后进行。

## 冷启动读取顺序

1. `docs/切片方案-一键预构建租约与调度性能治理.md` - BP8 actual validation 与 BP9 gate。
2. `docs/adr/0092-phase-aware-automatic-build-leases-and-executor-dispatch-bundles.md` - lease、dispatch、预算与发布边界。
3. `docs/代码链路.md` 最后的 BP5-BP8 条目 - 已实现符号与验证入口。
4. `packages/core/src/automatic-build-protocol.ts`、`skills/build/automatic-build.ts` - 当前 production contract。
5. `docs/切片方案-需求驱动渐进式预构建.md` §6-§7 - BP9 后的 IP 顺序。

## 工作区边界

- 本轮 commit 只应包含 BP1-BP8 的 Core、build skill、sidecar smoke/release、ADR/方案/复盘、架构、代码链路和 checkpoint 文件。
- `CONTEXT.md` 同时含 ADR-0092/0093 与其他用户改动；只允许精确暂存 BP 对应 hunk，不能整文件暂存。
- 工作区还有用户拥有的 schema/memory/reader/runtime/server/frontend、IP 文档和临时文件；不得清理、回退或提交。
