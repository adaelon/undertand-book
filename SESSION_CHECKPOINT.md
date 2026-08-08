# SESSION_CHECKPOINT — 2026-08-08 19:41 +08:00

## 新鲜度自检

- 写入时最新 commit：`8b20596 fix(web): derive book ids and preserve imported inputs`。
- 读入时请比较 `git log --oneline -3`；若不一致，以 Git 与工作树为准。
- 工作树含 S0-S5 未提交主线、其他 tracked 旁支及大量 untracked 用户资产；不得撤销、清理或批量暂存。

## 当前在做什么

S5 发布 skill 收缩已完成并验收：root/release skill 改为语义规划与 `build.step` 四动作，专用 executor 只消费 opaque ref 与 code-issued session action；下一刀是 S6 packaged/live 兼容与恢复验收。

## 下一步（可直接接手）

1. 运行 `pnpm -C packages/core exec vitest run --maxWorkers=1 --no-file-parallelism automatic-build-driver automatic-build-handoff automatic-build-dispatch-runtime automatic-build-policy intent-artifact-mailbox`。
2. 运行 `pnpm -C packages/core typecheck`。
3. 运行 `node apps/desktop/scripts/build-sidecar.mjs`，刷新包含当前 skill/wrapper/runtime 的 Windows Sidecar。
4. 运行 `node apps/desktop/scripts/smoke-codex-build-intent.mjs`，验证 packaged build.step、用户决策与中断生命周期。
5. 运行 `node apps/desktop/scripts/assert-plugin-release.mjs`，验证 thin-plugin、Node/Sidecar parity 与发布 marker。

## 未提交 / 未完成

- S0-S5：driver、opaque public/private session、root/release skill、executor wrapper、prompt-provider gate、Sidecar 入口、测试与文档均已实现并验证，整条主线仍未提交。
- S5 生成产物：`apps/desktop/src-tauri/binaries/understand-book-build-x86_64-pc-windows-msvc.exe` 已重编；该路径未出现在 Git status 中。
- S6：扩展兼容矩阵、packaged/live 短路径 resume、显式 rollback 验收尚未执行。
- 其他 tracked/untracked 改动均为既有受保护资产，不属于本切片。

## 冷启动读序

1. `docs/adr/0101-deterministic-prebuild-protocol-ownership-and-codex-semantic-boundary.md` — 四动作、executor session 与 mailbox 边界。
2. `docs/切片方案-预构建确定性确认收口.md` §§3-6，重点 S5-S6 — 已完成 cutover 与下一步验收矩阵。
3. `skills/build/SKILL.md`、`plugins/understand-book/skills/build/SKILL.md`、`agents/automatic-build-dispatch-executor.md` — 当前发布 root/executor 合同。
4. `skills/build/automatic-build-driver.ts`、`packages/core/src/automatic-build-executor-session.ts` 及同名测试 — S1-S4 权威 reducer/session 行为。
5. `packages/core/test/automatic-build-handoff.test.ts`、`apps/desktop/scripts/assert-plugin-release.mjs`、`apps/desktop/scripts/smoke-automatic-build-parity.mjs` — S5/S6 发布门。
6. `docs/代码链路.md`、`docs/架构.md` — S0-S5 改动账本与端到端数据流。

## 本会话决策摘要

- S5 未新增架构决策；实现严格服从 ADR-0101 的责任迁移与 S6 rollback 边界。
- dispatch prompt-provider gate 只改验 session/opaque/action marker；driver、mailbox 与六个 semantic extractor prompt 语义不变。
- 发布 assertion 必须在 Sidecar 重编后执行，避免源码 wrapper 与嵌入 prompt 资产漂移。

## 验证证据

- `node apps/desktop/scripts/build-sidecar.mjs`：367 modules bundle 与 Windows Sidecar 编译通过。
- `node apps/desktop/scripts/assert-plugin-release.mjs`：通过；发布版本 `0.1.0+codex.20260802222600`，skill SHA-256 `4ce0b01f8fde458bb258d673750bf25768456afa536814d718b71ff910e4a11b`。
- `pnpm -C packages/core exec vitest run --maxWorkers=1 --no-file-parallelism automatic-build-driver automatic-build-executor-session automatic-build-handoff automatic-build-dispatch-runtime automatic-build-policy intent-artifact-mailbox`：7 文件 66/66；Windows 集成用例使用各自 15 秒预算，本次 `TEMP/TMP` 指向 E 盘专用目录以避开空间不足的系统盘。
- `pnpm -C packages/core typecheck`：通过。
