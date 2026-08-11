# SESSION_CHECKPOINT — 2026-08-11 10:48 +08:00

## 新鲜度自检

- 写入时最新 commit: `7cffec5 fix(release): normalize plugin text line endings`。
- 读入时请对比 `git log --oneline -3`；若不一致，以 Git 与工作树为准。
- Executor Bootstrap EB0-EB7 不重开。ADR-0103/SR0-SR5 均已完成但未提交；无 staged changes。

## 当前在做什么

“抽取契约一致性与策略作用域重试恢复”已完成 SR5：profile-sidecar Zod/generated Markdown 共用字段合同，`profile_sidecar_policy.v2` 已前向发布并通过 Node/Bun/thin-plugin parity；SR6 隔离/安装态/真实续跑门仍关闭。

## 下一步（可直接接手）

1. 动手前声明 SR6：只执行 `docs/切片方案-抽取契约一致性与策略作用域重试恢复.md` 的隔离回放、installed parity 与受门禁真实续跑；不写 raw reset、不删任务树、不改 Pass2。
2. 串行运行 SR6“自动前置”列出的 10 个 Core test 文件、`pnpm --dir packages/core exec tsc --noEmit`、`node apps/desktop/scripts/smoke-automatic-build-parity.mjs` 和 `node apps/desktop/scripts/assert-plugin-release.mjs`。
3. 在 `packages/core/test/profile-sidecar-policy-replay.test.ts` 使用 `fixtures/profile-sidecar-contract-drift/policy-scope.ts` 构造 v1 三次 `schema_invalid` 耗尽，断言 v2 scope 从 semantic attempt 1 rebuild 且 scope A tree digest 不变。
4. 运行 `node apps/desktop/scripts/build-sidecar.mjs`，再从不含 repo `agents/` 的临时 thin-plugin 目录重复 synthetic scope A→B 提交/quality/publication gate。
5. 仅在 1-4 全绿后，先记录当前真实 target/policy-set/exhausted-scope/attempt-tree/public-artifact/lease 摘要，再经原 decision boundary 执行一次 `retry_current`；任何 scope/parity 漂移立即停止。

## 未提交 / 未完成

- SR5 production：`extractor-contract.ts`、profile prompt、同步脚本、semantic policy、release manifest 与 Sidecar hash gate 已完成；prompt SHA 为 `4d920312fe6d5f08b409b1854e2b91e92f5de4917eeeafe2dab489b91f3d7d6d`。
- SR5 tests/release：聚焦 27/27、扩展 profile routing/generation/quality 26/26、Core typecheck、sync `--check`、Bun Sidecar build、Node/Sidecar/thin-plugin smoke 与 plugin release parity 绿色。
- 扩展审计发现 `automatic-build-policy.test.ts` 两条 legacy V2 claim 用例仍使用 SR2 前的无 descriptor 调用合同；与 SR5 无因果关系，未放宽生产租约边界。
- SR0-SR4 的 production/tests/docs 差异仍未提交；SR6-SR7 未开始，当前真实书保持暂停且未写 reset/recovery/新 generation。
- `docs/架构.md`、切片方案与 `docs/代码链路.md` 已同步至 SR5；本地 Sidecar 二进制已重建用于 parity，但为 ignored 生成物。
- crates、既有用户文档、handoff、日志、executor-private、书籍和其他 untracked 资产为受保护差异；不得删除、重置、改写或批量暂存。

## 冷启动读序

1. `docs/adr/0103-extractor-contract-coherence-and-policy-scoped-retry-recovery.md` 全文 — 契约权威、scope、诊断、恢复和前向发布。
2. `docs/切片方案-抽取契约一致性与策略作用域重试恢复.md` 的 §2、§3.1、§3.2、§3.4、§3.6、SR5、SR6 与 §5-§6 — 已完成合同及下一刀门禁。
3. `CONTEXT.md` 的“分阶段任务租约 / 语义尝试 / 租约世代 / Executor 调度运行”与 `docs/架构.md` Automatic Build flow — append-only scope 历史。
4. `packages/core/src/extractor-contract.ts`、`automatic-build-protocol.ts`、`semantic-artifact.ts`、`agents/profile-sidecar-extractor.md`、`scripts/sync-extractor-contracts.ts` 与 `skills/build/sidecar-entry.ts` — SR5 单源和发布链。
5. `packages/core/test/fixtures/profile-sidecar-contract-drift/policy-scope.ts`、policy-generation/task-store/recovery/driver/release tests、两个 desktop parity scripts，以及 `docs/代码链路.md` 最后五条 — SR6 接手证据。

## 本会话决策摘要

- §SR5 契约单源：`ExtractorFieldContractV1` 同时生成 Zod 与 prompt 机器约束；手写 prompt 不再重述闭集、数值边界或跨字段 paper hints（见 ADR-0103 §1、切片方案 SR5）。
- §SR5 前向发布：Schema 保持 `profile_sidecar_output.v2`，policy 升为 `profile_sidecar_policy.v2`；v1→v2 必须 rebuild，旧 artifact/task/history 只读保留（见 ADR-0103 §5、架构 Automatic Build flow）。
