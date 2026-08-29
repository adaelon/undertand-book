# SESSION_CHECKPOINT — 2026-08-29 12:59 +08:00

## 新鲜度自检

- 写入时父 commit：`19586a7 feat(runtime): complete capability routing and evidence topology`；分支 `main`。
- 本 checkpoint 与 T1-T8 源码、测试、agent/plugin、cachebuster、文档和脱敏证据同属其后的单一提交；读入时以实际 `git log --oneline -3` 为准。
- 提交范围只包含 T 系列；Memory/Profile、Reader、预构建评审、Debug Desktop smoke、private/tmp/handoff 与真实书工作区均未混入。

## 当前在做什么

T1-T8 工程改动已收口：有界 executor 传输、BookStructure V4 路由、结构化 candidate sink、阶段化失败账本、agent-only MCP、compiled/installed 发布门和 T8 replacement-child rehydration 均已落盘；真实书恢复仍在首个稳定 `bootstrap/protocol_incompatible` blocker 处停止，尚未到 durable `DONE`。

- 三项真实书 delivery 仍为 8/8、6/6、6/6；grant/start 各 3，semantic attempt 均为 1，attempt 2/candidate/failure/receipt 均为 0。
- 前后 12-file attempt digest 均为 `8df05d0397a32767776f126ac2f8950dd7e192602cef32084ba8d2629de6e7d5`；真实书 append-only 未破坏。
- source/installed Sidecar SHA-256 均为 `20ca697f9416d8a87d86babed02a108ac1f66b146d4cdaafaf4bf1a15601f51d`。
- 当前 published plugin version 为 `0.1.0+codex.20260828030148`；source contract 通过。
- installed doctor 的 release/prompt/handoff/root-negative/connection-capability 为绿；当前任务仍在 `executor_bootstrap` 与 `plugin_shape` 上 fail-closed。

## 下一步（可直接接手）

1. 取得用户明确的 executor 注册 scope：`personal`，或 `project` + 精确绝对 workspace root；按 published register-executor skill 原子安装，冲突时不覆盖。
2. 新建 Codex 任务，先在 synthetic/非真实书环境验证 installed doctor 全 compatible，且 custom agent 实际看到四个 agent-only MCP tools 并能 open/commit。
3. synthetic 门全绿后，从默认 driver registry 取回同一三个真实 ref；先恢复一个，terminal 后立即 durable reread；若仍 bootstrap/stream blocker，停止且不得 `retry_current`。
4. 同 attempt 的三项均 committed 后才运行正常 driver step 到 durable `DONE` 或首个新 typed blocker。
5. 刷新 `docs/performance/understand-book-t8-resume-codex-cli-release.json`、`docs/代码链路.md` 与本 checkpoint；继续重算 12-file attempt digest 和 Sidecar hash 守卫。

## 未提交 / 未完成

- T1-T8 工程实现：无未提交项；T8 真实书 durable recovery 仍未完成。
- 注册修复必须等待用户选择 scope，并且只在新的 Codex 任务激活；当前任务禁止假装 hot reload。
- 工作树仍保留不属于 T 系列的用户修改、书稿、构建产物、日志、handoff、测试临时目录与 private 状态；不得清理、覆盖或误提交。

## 验证状态

- `pnpm --filter @understand-book/core typecheck`：通过。
- T 定向 Core：其余 18 suites 172/172；修正 V2 prompt 迁移残留断言后 `automatic-build-handoff.test.ts` 16/16。
- `node apps/desktop/scripts/assert-plugin-release.mjs --source-contract-only`：通过，版本 `0.1.0+codex.20260828030148`。
- T7/T8 compiled、installed、真实 CLI 与真实书守卫证据见 `docs/performance/understand-book-t7-codex-cli-release.json`、`understand-book-t8-compiled-executor-release.json`、`understand-book-t8-synthetic-codex-cli-release.json`、`understand-book-t8-resume-codex-cli-release.json`。

## 冷启动读序

1. `docs/performance/understand-book-t8-resume-codex-cli-release.json` 全文 — 当前 release、真实书守卫、历史模型流与 bootstrap blocker。
2. `docs/切片方案-executor有界语义传输与候选提交闭环.md` 仅读 §3.8、T8、§7、§9 — 权限、可见性、恢复门和 DoD。
3. `docs/代码链路.md` 仅读 T8.2、T8.3、T8.4 — rehydration、安装态门与当前 blocker 账本。
4. `packages/core/src/automatic-build-executor-session.ts` 仅读 `deliveryProgressResponse`/`nextAutomaticBuildExecutorInput`；对应测试仅读 replacement-child regression。
5. `.codex/agents/understand-book-executor.toml`、`plugins/understand-book/assets/codex-agents/understand-book-executor.toml` 与 published register-executor `SKILL.md` 全文。

## 本会话决策摘要

- 提交边界：只提交 T1-T8；所有非 T 用户改动与运行产物保持 unstaged。
- Bootstrap 停止规则：当前 child `protocol_incompatible` 后停止，不启动其余 ref、不 reset、不 `retry_current`。
- 恢复准入：必须先在新任务的 synthetic 环境证明四工具 MCP 与 installed doctor 全绿，再触碰同一真实 ref。
- 注册激活边界：scope 必须由用户明确指定；安装成功也仅对新 Codex 任务生效。
