# SESSION_CHECKPOINT - 2026-07-19 AP0-AP16 goal completion

## 当前 Goal 热启动
- Goal:`实现《一键预构建执行面与成本治理切片方案》全部 AP0-AP16`,实现与发布门禁均已完成;新任务 production default 已切到 v2。
- 已完成:AP0-AP16。AP1 canonical target;AP2 attempt store;AP3 lease/heartbeat/recovery;AP4 mailbox;AP5 executor-owned handoff;AP6 metrics;AP7 policy envelope;AP8 extractor single contract;AP9 framework;AP10 metadata;AP11 lexicon;AP12 discourse/formula units;AP13 preflight budget/cost scheduler;AP14 safe 1-3 worker release;AP15 quality/legacy/transaction publication;AP16 packaged release/real-paper replay/plugin install。
- 当前无未完成 AP。后续若继续工作,应以新需求创建新 Goal;不得把 AP16 已通过的真书回放、打包或插件安装误判为待办。
- 固定边界:Codex harness/专用 subagent 做推理;Build Engine Sidecar 不调用模型/provider;sidecar 只持久化 task/mailbox/metrics/gate;无 native/executor receipt 时 exact token 必须 unknown。
- 工作区很脏,包含用户既有 Rust/Web/临时文件与当前 Goal 未提交改动;不得清理、回退或把不相关文件归入切片。

## AP10 最新事实
- `paper_metadata_candidate.v2` 为 20-window CC0 fixture 产生 4 eligible/16 skipped,满足至少 80% 降幅;结构化 bibliography 确定性合并,歧义项才进模型。
- 真实 `Understanding Transformer` 只读校准:48 windows -> eligible `0,45`,46 skipped,下降 95.8%;跨 windows 22/23 确定性恢复 50 references。
- metadata input/write/status/batch/orchestrator 已同源消费 router;skipped unit 不 claim、不写空 artifact;batch 把 deterministic references 合入公共 sidecar。
- 定向 14/14、Core typecheck、Bun sidecar compile 与 compiled candidate/skip smoke 已绿。四进程 CLI 测试的默认 5s 超时已显式调整为 15s;最终 AP16 Core 全量为 339/339。

## AP11 最新事实
- `paper_lexicon_cluster.v2` 使用非数字稳定 batch ID;writer 拒绝候选外术语并补齐真实 occurrence LIDs;旧数字 artifact 不参与 v2 status。
- CC0 goldset:5/5 recall、5/8 candidate precision;预算 320 的测试 packet 均不越界。真实论文:458 clusters、18 batches、3 skips、max 5990/6000;旧 raw 628,公共 466 exact 对照 109。
- AP11 目标/contract/orchestrator/CLI 29/29;Core 53/53 文件、313/313 tests;typecheck、Bun compile、compiled cluster/skip smoke、diff check 全绿。

## AP12 最新事实
- `profile_sidecar_semantic_units.v2`:discourse/formula collection 互斥,skip 不生成 artifact,close 仍写既有 Reader schemas。
- 真实论文:738 discourse LIDs/89 groups/470 skipped;867 formulas/364 eligible/503 skipped,7 no-formula windows。AP13 必须在 claim 前如实暴露 453 个模型 units 与 cost,不得继续隐藏为 48 windows。
- AP12/contract/orchestrator 26/26;Core 54/54、320/320;typecheck、Bun compile、compiled 三路 smoke、diff check 全绿。

## AP13 完成事实
1. 已完成 `automatic_build_preflight.v1`:完整 descriptor accounting、cost/token distributions、quality/policy/worker/budget 和稳定 digest;AP6 exact usage 仅 observational,不参与 estimate/digest。
2. 已完成 `plan -> accepted next`:budget exceeded/preflight required/plan changed 均在 claim 前停止;接受回执 create-only;累计 cost 调度;AP14 前 `max_workers=1`。
3. 真实论文 profile-sidecar:1010 descriptors=453 eligible+557 skipped;cost total 203,958,P50/P95/max=291/1,422/2,103;估算 input 97,698,total 106,514-367,266;默认预算内。
4. 验证:AP13 定向 13/13;Core 55/55 files、324/324 tests;typecheck;Bun compile;compiled sidecar smoke 全绿。

## AP14 完成事实
1. 已完成 worker capacity:`min(requested,available_agent_slots,3,max_batch_score/max_parallel_cost 容量)`;availability 不进 plan digest;0 slots 不 claim。
2. 已完成 1/2/3 fake executor full pass1 replay:相同 task set 与 artifact_hash;所有 task attempt=1、无重复 task;3->1 slot shrink 完整续跑。
3. 已完成 bounded root receipt contract:最多 3*4096 bytes,candidate payload forbidden;每 task 独立 lease/mailbox/metrics,无共享 RMW。
4. 验证:AP14 定向 17/17;Core 56/56 files、328/328 tests;typecheck;Bun compile;compiled 3-worker/zero-slot smoke。当前环境未允许真实子代理;它不是唯一 release gate。

## AP15 完成事实
1. 已完成 `automatic_build_stage_quality_report.v1`:integrity 与 quality 分栏,router eligible-unit denominator,artifact-set digest,full/balanced/sparse floor,CC0 canonical digest。
2. 已完成 close fail-closed:空但 schema-valid v2 Pass1 返回 quality_gate_failed;六 stage public files 使用事务 promote/rollback。
3. 已完成 audit/migration:`legacy_policy_unknown` 不混入 v2;legacy_resume 仅 fresh+valid;v2_rebuild 先不可变 snapshot且不改原文件。
4. 真实只读 audit:173 legacy=48 Pass1+48 metadata+48 lexicon+29 profile;173 shape-valid,0 invalid;48 source-fresh+125 unknown;resume 不允许,建议 rebuild。验证 Core 57/335、typecheck、compile/smoke/diff 全绿。

## AP16 完成事实
1. `automatic_build_release.v1` 已把新任务默认协议切到 `automatic_build_protocol.v2`;legacy v1 仅能显式 `legacy_resume` 或 `v2_rebuild`,不会混成 v2 complete。
2. Node/tsx 与 packaged Bun sidecar 的完整 plan/unaccepted-next parity 通过;compiled workbench smoke 通过。sidecar SHA-256=`0A7CBDC61A1CE7083F2CF9DF64B17DAAD7A2D1478E46846B384A509DB22621A2`。
3. 真书双回放首次暴露并修复 Pass2 skip/quality 分母分裂:48 个零候选 window 现为 48 total / 0 eligible / 48 skipped,无空模型 artifact。第二个偏差是公共 header/verification 墙钟污染 publication hash;自动公共投影现使用规范化 timestamp,运行时钟只在 operational receipts。
4. 最终全新隔离双回放每轮 530 semantic artifacts,attempt 全部首次成功,六 stage quality 全绿;两轮 report digest 均为 `ea24b91e3f0cc725b7cff22b54cb9a8428dcd961c4af2cc7c943ab8653c8fcbb`,`identical=true`。原 workspace digest=`6f8e7f170d151d50454dc1c85c906c7b11859758c35bca839b4a198385ed4beb` 前后不变;无假 source workspace、shared ledger、root candidate relay。
5. 验证:Core 58 files / 339 tests + typecheck;Rust workspace 全量;Node/Bun parity;compiled smoke;Web production build;Tauri release + NSIS。`dist/UnderstandBookSetup.exe` 35,349,293 bytes,SHA-256=`BA123429DDC9DF97FB1FA2366E1471FB2679B95579A0538210C645D3DBA359DB`。
6. Plugin manifest/personal source/Codex cache 均为 `0.1.0+codex.20260719063845`;workspace/source/cache plugin validator 与 build skill validator 全绿;`understand-book@personal` installed=true、enabled=true。

# 历史 Checkpoint - 2026-07-18 22:04 +08:00

## 新鲜度自检
- 写入时最新 commit:`0895590 feat(hybrid): ship semantic-unit alignment v2`。
- 读入时先运行 `git log -3 --oneline` 与 `git status --short`;若 hash 不一致以 git 为准,若工作区仍脏则不得从 HEAD 推断未提交实现状态。
- 当前唯一主入口:`docs/预购建流程.md`;HF2 v2 已是 Workbench `hybrid_foundation` 阶段的既有基座,不再是当前主任务。

## 当前在做什么
把后续工作焦点切到 paper profile 的预构建流程与 Build Workbench,先恢复输入、durable job、来源复核、阶段门禁和 reader handoff 的真实现状,尚未冻结新的代码切片。

## 下一步(可直接接手)
1. 运行 `pnpm -C packages/core test -- build-workbench.test.ts workbench-stage-runner.test.ts`,确认 readiness、job 与固定 stage runner 基线。
2. 运行 `cargo test -p server build_workbench`,确认 `/book/build_workbench` 与 `/build_workbench/*` controller/readiness 路径。
3. 运行 `pnpm -C packages/web test -- BuildWorkbenchPane.test.ts` 和 `pnpm -C packages/web typecheck`,确认工作台交互与类型基线。
4. 对照 `docs/预购建流程.md` 主状态机,逐段核对 `detectBuildReadiness -> route_build_workbench_state -> App.applyWorkbenchAction`,记录第一个可复现偏差。
5. 基于该偏差声明一个 A1 小切片;未得到具体目标前不改 Workbench 代码,不沿用文档里的历史测试计数冒充当前结果。

## 未提交 / 未完成
- `SESSION_CHECKPOINT.md`:本次整页刷新,未提交。
- `CONTEXT.md`、`docs/代码链路.md`、`docs/adr/0083-unquoted-note-explicit-body-placement.md`、`docs/切片方案-无引用Note显式正文放置.md`:上一刀 Note 文档切片,未提交且与当前 Workbench 焦点正交。
- `crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`、`crates/server/src/host.rs`:用户既有修改,状态未重新验收,不得覆盖或归入 Workbench 切片。
- `docs/预购建流程.md` 的验证计数停留在 2026-07-10;`docs/切片方案-paper-pdf-first-hybrid.md` 顶部状态与 PH17/PH18 完成记录存在时间差,必须以代码和新测试为准。
- `.tmp-*`、日志、测试输出、论文输入及 `docs/预构建画像-quantification-essence.md` 等未跟踪材料不属于本次 checkpoint,不得清理或提交。
- 本次没有修改 Workbench 代码,也没有运行 Workbench 测试。

## 冷启动读序
1. `docs/预购建流程.md` - 当前唯一流程入口;完整读取定位、状态机、阶段、来源复核、恢复、代码入口与验证基线。
2. `docs/adr/0063-paper-pdf-first-reconciled-source-build-workbench.md` 与 `docs/adr/0082-hybrid-foundation-semantic-unit-alignment-and-degraded-reader.md` - source trust 与 v2 foundation 边界。
3. `docs/切片方案-paper-pdf-first-hybrid.md` 的 PH12-PH18 与 `docs/修复方案-混合阅读基座语义单元对齐-v2.md` §4/§5/§8/§9 - controller 与 foundation 发布门。
4. `packages/core/src/build-workbench.ts`、`workbench-stage-runner.ts`、`hybrid-foundation-v2.ts` 及对应 tests - readiness、durable stage 与 v2 写入真相。
5. `crates/server/src/lib.rs` 的 `/book/build_workbench`、`/build_workbench/*` routes、`route_build_workbench_state` 及同文件 Workbench tests - server controller/readiness。
6. `packages/web/src/components/BuildWorkbenchPane.vue`、`packages/web/src/App.vue` 的 Workbench handlers、`BuildWorkbenchPane.test.ts` 与 `surface-selection.ts` - 用户控制面与 reader/workbench 切换。
7. `skills/build/workbench-stage-runner.ts`、`packages/core/src/build-orchestrator.ts`、`docs/adr/0067-codex-plugin-one-command-prebuild.md`、`apps/desktop/scripts/smoke-workbench-sidecar.mjs` - plugin/sidecar 接线与真实 smoke 入口。
8. `docs/代码链路.md` 中 2026-07-10 至 2026-07-11 的 Workbench 条目和 2026-07-17/18 HF2 条目 - 改动账本与当前基础能力。

## 本会话决策摘要
- 热启动路由:主入口从 HF2 修复方案切换为 `docs/预购建流程.md`;HF2 v2 降为 Workbench 已完成依赖。
- Workbench 信任边界:job/UI 只负责编排,reader handoff 仍只认磁盘 artifact/hash/schema gate(见 ADR-0063)。
- Plugin 边界:paper 一键预构建只消费 Workbench 可信基座,不得绕过来源复核与 hybrid foundation(见 ADR-0067)。
