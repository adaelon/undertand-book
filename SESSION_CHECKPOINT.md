# SESSION_CHECKPOINT — 2026-08-09 17:01 +08:00

## 新鲜度自检

- 写入时最新 commit：`84faddc fix(build): scope handoff projections by invocation`。
- 写入时 `origin/main` 为 `e68d58f`；checkpoint 提交完成后推送本地新提交。
- 读入时比较 `git log --oneline -3`；若不一致，以 Git 与工作树为准。

## 当前在做什么

跨 invocation 复用过期 dispatch handoff 的 create-only 冲突已修复并提交；driver 13/13、两个 Windows handoff 时限用例及 Core typecheck 已通过，当前只剩 checkpoint 提交与 push。

## 下一步（可直接接手）

1. 运行 `git status --short`，继续保护既有 tracked/untracked 用户资产，不做批量暂存或清理。
2. 发布前运行 `node apps/desktop/scripts/build-sidecar.mjs`，把 `84faddc` 的 driver 修复编入 Windows Build Engine。
3. 运行 `node apps/desktop/scripts/smoke-automatic-build-parity.mjs`，验证 Node/Bun packaged `build.step` parity。
4. 使用更新后的 Sidecar 对原论文工作区重建 invocation，确认返回 `SPAWN_EXECUTORS` 而非非结构化失败。

## 未提交 / 未完成

- 本任务生产代码、回归测试与代码链路已提交；`SESSION_CHECKPOINT.md` 将作为独立 checkpoint 提交。
- `crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/profile.rs`、`crates/memory/src/review.rs`、`crates/runtime/src/profile_api.rs`：既有 tracked 修改，未触碰。
- `docs/代码链路.md`、`docs/切片方案-切片1前端阅读器.md`、`docs/预购建流程.md`：仍含既有未提交 hunk；本次代码链路条目已用独立索引内容提交。
- 大量 untracked 文档、handoff、日志、测试产物与临时目录均为既有受保护资产，未清理、未暂存。

## 冷启动读序

1. `docs/代码链路.md` 最后一条“跨 Invocation Handoff Projection 隔离” — 本切片改动与验证账本。
2. `skills/build/automatic-build-driver.ts:dispatchHandoffRefs` — invocation-scoped handoff projection 持久键。
3. `packages/core/test/automatic-build-driver.test.ts:lets a fresh invocation reuse an expired dispatch opaque handoff` — 红绿回归路径。
4. `packages/core/src/automatic-build-executor-session.ts:opaqueHandoffIdentity/opaqueHandoffRefFor` — invocation 无关的 opaque ref 权威身份。
5. `skills/build/automatic-build.ts:expandAction` — 过期 dispatch 的稳定 identity 与 handoff 复用入口。

## 本会话决策摘要

- projection 改为 `handoff-projections/<invocation_ref>/<opaque_handoff_ref>.json`；opaque handoff ref 与 executor 协议保持不变。
- 旧的全局 projection 不迁移、不删除；新 invocation 直接写入隔离目录，调用内 create-only 校验继续 fail closed。
- 未修改顶层通用错误文案，也未把 Reader 私有状态或语义候选引入 root 响应。
