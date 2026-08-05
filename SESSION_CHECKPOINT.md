# SESSION_CHECKPOINT — 2026-08-05 20:34 +08:00

## 新鲜度自检

- 写入基线：`6149e86 feat(build): close BR1-BR10 routable recovery`。
- 本文件与 stitch 修复同属待生成的 `fix(build): compact Pass1 stitch input` 提交；读入时以 `git log --oneline -3` 中包含本文件的实际 commit 为准。
- 目标提交边界仅含 4 个实现/测试文件、`docs/代码链路.md` 与本文件；6 个 tracked 用户旁支及全部 untracked 项受保护且不得纳入。

## 当前在做什么

BR1–BR10 后续 stitch 容量误判已闭合：模型输入只保留 child 的完整 nodes/edges，5000-token 硬闸、prompt、schema、policy set 和既有 BuildPlan 均不变；新 stitch identity 避免复用旧 blocked 规划，12 个 committed child 可原地复用。

## 下一步（可直接接手）

1. 运行 `git log --oneline -3`，确认 HEAD 含 `fix(build): compact Pass1 stitch input`。
2. 运行 `git status --short`，确认目标 6 文件无残留，只剩受保护的用户旁支、书籍、handoff、日志与临时项。
3. 若继续整书构建，只能在另一个授权任务的隔离副本中沿用 `23242160475f4d66.json`，不得重跑 `legacy-plan` 或直接写真实 workspace。
4. 只有用户明确授权 BR11 后，才从 exact clean SHA 构建/安装 Windows Setup 并执行隔离真书回放。

## 未提交 / 未完成

- Stitch 修复：应全部位于本 checkpoint 所在提交；若仍显示为修改则仅待 commit/push。
- 用户旁支：6 个 tracked 改动（`crates/base-schema`、`crates/memory`、`crates/runtime` 与两份既有方案文档）及其他 untracked 项，均有意排除并受保护。
- 整书构建与 BR11：不属于本修复提交，未在当前任务运行。

## 已验证

- `git diff --check` 通过，仅有仓库既有 LF→CRLF 提示。
- `pass1-reduction` 13/13；旧四 child 编码 `>5000`，紧凑编码 `<=5000`。
- `model-input-routability + automatic-build-release-v3 + automatic-build-release` 12/12。
- `automatic-build-handoff` 15/15；首次组合运行仅触发 5 秒环境墙钟，独立以 15 秒上限复跑全绿。
- Core typecheck、Node/Bun Sidecar parity、thin-plugin release assertion 通过。
- 先前只读真实路由复验：12 个 committed artifacts 与 16 个 task 目录未重建；window-1 为 `4938/5000`，新增仅 4 个 final stitch。

## 冷启动读序

1. `docs/adr/0100-budget-routable-model-work-units-and-truthful-build-recovery.md` — 预算、恢复与发布禁区。
2. `docs/代码链路.md` 的 BR10-E — 本修复的代码入口与验证账本。
3. `packages/core/src/model-input-renderer.ts` 与 `packages/core/src/pass1-reduction.ts` — 紧凑 payload 与 stitch identity。
4. `packages/core/test/pass1-reduction.test.ts` — 5105→硬闸内的现实 graph 回归。
5. `skills/build/automatic-build.ts`、`apps/desktop/scripts/smoke-automatic-build-parity.mjs` 与 `assert-plugin-release.mjs` — release doctor 与安装态同构门。

## 本会话决策摘要

- 紧凑编码属于兼容性修复：只删模型不消费的重复 route 元数据，不改变语义图、policy generation 或 BuildPlan。
- 仅升级未生成 stitch 的内部 identity；既有 committed child 不重建，真实整书构建不在本任务执行。
