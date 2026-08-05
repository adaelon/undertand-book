# SESSION_CHECKPOINT — 2026-08-05 17:43 +08:00

## 新鲜度自检

- 写入基线：`2e78108 fix(build): close installed executor handoff reliability`。
- 本文件与 BR1–BR10 同属一个待生成提交，提交无法在自身内容中嵌入最终 hash；读入时以 `git log --oneline -3` 中包含本文件的 `feat(build): close BR1-BR10 routable recovery` 为准。
- 写入边界为 86 个 BR 文件（55 个 tracked 变更、31 个新增文件）；其余用户旁支不得从 HEAD 重建、覆盖、清理或纳入 BR 提交。

## 当前在做什么

BR1–BR10 已闭合并由本 checkpoint 所在提交统一收口：预算可路由模型工作单元、v3 production routing、quality-v2、结构化 recovery、事务 publication、严格 close/replan、Node/Sidecar parity 与 thin-plugin release contract 均已完成。BR11 未授权、未启动。

## 下一步（可直接接手）

1. 运行 `git log --oneline -3`，确认 HEAD 为本 checkpoint 所在的 BR1–BR10 提交。
2. 运行 `git status --short`，确认 BR1–BR10 无残留；只应看到提交边界外的用户旁支、书籍、日志和临时项。
3. 只有用户明确授权 BR11 后，先用 `git rev-parse HEAD` 冻结 exact SHA，再按切片方案 BR11 在隔离 clean worktree 构建 Windows Setup。
4. BR11 安装唯一 cachebuster 后，从新 Codex task 加载安装态 thin plugin；不得从当前脏工作区直接发布。
5. 在受保护副本重放真实触发 EPUB，并用 deterministic synthetic fixture 跑到 `done`；不得修改原书、原 workspace 或降低 full 质量门。

## 未提交 / 未完成

- BR1–BR10：无；应全部位于本 checkpoint 所在提交。
- 用户旁支：6 个 tracked 改动（`crates/base-schema`、`crates/memory`、`crates/runtime` 与两份既有方案文档）及其他 untracked 书籍、handoff、日志、临时目录；均有意排除并受保护。
- BR11：clean-SHA Setup、安装态 thin plugin、隔离真书回放与合成全闭包尚未实施。

## 已验证

- `git diff --check` 通过，仅有仓库既有 LF→CRLF 提示。
- 本次提交前复验：5 个 BR10 release/close/handoff/routability 文件、33/33 用例通过；Core typecheck 通过。
- BR10 定向：release/close 15/15；Profile/release 17/17；handoff+routability 18/18；Core typecheck 通过。
- Sidecar 重建、十项 prompt 的 task/dispatch Node/Bun 字节 parity、plan/doctor/next/dispatch smoke、plugin release assertion 与 release-config/build-order assertion 均通过。
- Core 全量 104/104 文件、663/663 用例通过（单 worker，374.97 秒）；root/public skill SHA-256 均为 `78d17d6bba135fb5bae2b511db9b19174d39f41613e27c519ab903ec9b266b46`。

## 冷启动读序

1. `docs/adr/0100-budget-routable-model-work-units-and-truthful-build-recovery.md` — 六项冻结决策与禁区。
2. `docs/切片方案-预算可路由模型工作单元与构建恢复闭环.md` 的 BR10–BR11 与 §6 — release 完成态和下一授权边界。
3. `CONTEXT.md` 的“预算可路由性 / 模型输入片 / effect 返回·错误分类+recovery” — 术语权威。
4. `docs/architecture.md` 的 release v3、close coordinator 与 Pass1/Profile production v3 — 当前组件边界。
5. `docs/代码链路.md` 最近 BR10-A–BR10-D — release、Sidecar、skill 与回归账本。
6. `packages/core/src/{automatic-build-protocol,automatic-build-close,automatic-build-legacy,semantic-artifact}.ts`、`skills/build/automatic-build.ts` 与 release/handoff/routability tests — 核心证明链。
7. `skills/build/SKILL.md`、`plugins/understand-book/skills/build/SKILL.md` 与 `apps/desktop/scripts/{build-sidecar,smoke-automatic-build-parity,assert-plugin-release,assert-release-config}.mjs` — 薄插件与发布门。

## 本会话决策摘要

- BR1–BR10 以代码链路为权威合并为一个提交；BR11 和全部用户旁支排除。
- checkpoint 与目标代码同 commit 时，以包含它的 HEAD 为新鲜度权威，避免伪造不可自引用的提交 hash。
