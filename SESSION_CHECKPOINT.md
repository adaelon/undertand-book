# SESSION_CHECKPOINT - 2026-07-11 00:13

## 新鲜度自检
- 写入时实现/文档基准 commit:`3d209c4 docs: document prebuild workbench flow`。
- 本页在该基准后单独提交；读入时先比较 `git log --oneline -5` 与 `git status --short`，以 Git/worktree 为准。
- 本轮提交序列:`479c08a` Core runner -> `c49993e` Server controller -> `92ce701` Web Workbench -> `3d209c4` 流程文档。

## 当前主线
预构建 Build Workbench 已成为 paper profile 的 reader 前置控制面；冷启动先恢复完整工作台流程，再下钻来源终裁或单个 book 的运行状态。

## 预构建工作台流程
1. 导入 `paper.md + paper.pdf`，写未信任 input manifest 与 fingerprint。
2. 创建/复用 durable job；旧 fingerprint job 标为 `stale_input`，只保留审计。
3. Web 选择 stage/executor，Server 以固定 contract 启动 stage runner。
4. 来源决定齐备后仅重跑一次 reconciliation；通过 deterministic trust 或记录 valid `manual_override` accepted。
5. `hybrid_foundation` 把 accepted stage source 写成根 `source.txt/base.json/source_manifest/maps`，重新执行 hash/schema/artifact gates。
6. foundation gate 通过后 route 切到 reader；后续 paper projections 只能扩充 profile，不得改写 source truth。

## 已完成事实
- `trusted := unresolved.length == 0`；`accepted := trusted || valid manual_override`。
- Core/Server/Web 严格校验 mode、policy、accepted_at、残余计数和正整数 decision count；stale fingerprint 优先。
- residual diagnostics 永久保留；同 fingerprint valid override 不再复核或自动重跑，`ready_for_rerun=false`。
- 批量 LLM 仅逐项持久化高置信有效修订，失败项留人工，成功项不回滚。
- 历史 stale job 的 pending 不参与当前门禁；source done + foundation missing 时 Web 自动选中 `hybrid_foundation`。
- Runner 支持 durable heartbeat、interrupted/resume、failure summary、权限审计与有界 retention。
- Core `33 files / 187 tests` + typecheck；Runtime `59`；Server `77 lib + 4 static`；Web `6 files / 44 tests` + typecheck/build。
- `pnpm install --frozen-lockfile` 通过；真实 book `1` 为 source done、foundation missing、11 residual、ready job。

## 下一步(可直接接手)
1. 按 `docs/预购建流程.md` 启动本地 Server，打开 `.understand-book/1` 的 Build Workbench。
2. 刷新 `/book/build_workbench`，确认 source done、foundation missing、current job ready 且选择 `hybrid_foundation + builtin`。
3. 点击“启动所选阶段”，等待 job 完成；检查 events、failure summary 与 stdout/stderr。
4. 验证根 foundation artifacts 通过 gate、route 变为 reader，11 条 residual 仍仅作终裁审计。
5. 若来源复核再次出现，先检查 fingerprint/acceptance 完整性，不得重复验证同一终裁轮次。

## 未提交 / 未完成
- 真实 book `1`：待运行 `hybrid_foundation` 并完成 reader handoff 实测。
- 预构建 Workbench 实现与流程文档已进入上述四个本地 commit；本页单独提交。
- worktree 仍有 `.fluid`、Chrome profile、日志、截图、论文/参考资料和个人设计稿等无关未跟踪文件；保留且不要纳入功能提交。

## 冷启动读序
1. `docs/预购建流程.md` - Workbench 状态机、阶段、信任边界、恢复和经典抽取链。
2. `docs/架构.md` - App init、Build controller、deterministic runner、Interactive Workbench 与 source review 数据流。
3. `docs/切片方案-paper-pdf-first-hybrid.md` - §3.1 与 PH12-PH18 的阶段边界和完成条件。
4. `CONTEXT.md` - Build Workbench/controller/input manifest/executor contract/source decisions/manual override。
5. `crates/server/src/lib.rs` - job API、runner spawn、readiness、recovery 和 strict acceptance。
6. `packages/core/src/workbench-stage-runner.ts` / `skills/build/workbench-stage-runner.ts` - executable stage flow。
7. `packages/web/src/App.vue` / `components/BuildWorkbenchPane.vue` / `source-review-batch.ts` - 用户控制面与复核编排。
8. `docs/代码链路.md` 最新 Workbench 条目 / `docs/adr/0065-manual-source-override-after-single-review-rerun.md` - 变更索引与终裁决策。

## 本会话决策摘要
- ADR-0065：完整复核后只重跑一次；residual 进入 explicit accepted，不再循环复核。
- Checkpoint 冷启动入口改为预构建工作台端到端流程，单书终裁状态作为流程中的运行实例。
