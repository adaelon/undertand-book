# SESSION_CHECKPOINT - 2026-07-18 00:28 +08:00

## 新鲜度自检
- 写入时基线 commit:`bc76459 docs(core): refresh canonicalization checkpoint`;HF2 完整状态随包含本文件的 commit 一起生效,其 hash 以 `git log -1` 为准。
- 读入时先运行 `git log -3 --oneline` 与 `git status --short`;本 checkpoint 记录的是未提交工作区,不得从 HEAD 猜测实现状态。
- 唯一实施/验收方案:`docs/修复方案-混合阅读基座语义单元对齐-v2.md`。

## 当前在做什么
HF2-0 至 HF2-7 已全部实现并通过整版发布门。生产 `workbench-stage-runner` 只调用 v2 builder/writer/validator,再通过正式原子 applier 发布完整 artifact 集;v1 仅保留 runtime 双读与显式 rerun 迁移兼容。

## 已完成切片
- HF2-0:版本化 goldset 与 external benchmark;真实 v1 基线 559/1100,重复绑定 117。
- HF2-1:最终 `source.txt` 指纹绑定 `source_alignment_evidence.v1`,stale 整份拒绝。
- HF2-2:semantic unit locator/projector,公式与短正文共同定位,四级 precision。
- HF2-3:v2 source/selection maps、alignment report、integrity/quality 分离;真实候选 duplicate 0、degraded、exact text span 66.27%。
- HF2-4:Rust read-tools/Reader/Server 双读 v1/v2,逐 entry precision fail-closed;read-tools 127、reader 54、server 157 全绿。
- HF2-5:Reader 非阻塞质量信息带、指标/Workbench 入口和逐选区动作矩阵;Web 140/140、typecheck/build、PDF Playwright 7/7。
- HF2-6:per-book lock + revision journal 原子应用完整 foundation 集;15 个故障点/恢复/锁/幂等与 runner 重试全绿;Core 268/268、typecheck。
- HF2-7:生产 v2 接线、磁盘 validator、隔离真实论文双跑、发布 runner、桌面/移动截图、sidecar smoke 与 Windows Setup 全部完成;Core 最终 272/272,Playwright 13/13。

## 发布证据
- 隔离真实论文两次生产构建均为 v2,integrity 7/7、wrong-page 0、duplicate binding 0、`degraded`;unit/text/formula/heading 为 88.62/69.34/32.95/97.67%,digest 均为 `adc21630a5b7af6552158aab7fd5f2c44b7ab5cf59dd9b1bf850591655801658`。
- 许可 goldset、Core 272/272 + typecheck、Web 140/140 + typecheck/build、Rust workspace、Playwright 13/13、编译 sidecar smoke、Tauri release + NSIS 均通过。
- Playwright 桌面/移动截图位于 `docs/screenshots/hf2-reader-degraded-desktop.png` 与 `docs/screenshots/hf2-reader-partial-mobile.png`,已检查并修复移动工具条越界。应用内浏览器 `agent.browsers.list()` 仍为空,没有把该不可用连接记为通过。
- `dist/UnderstandBookSetup.exe`:35,329,555 字节,SHA-256 `9A7E5214E5F56CAFD7457B51DCFB484881A04A34BFC5AF8549ACCC734238F1D8`,与 NSIS bundle 原件一致。

## 后续接手点
HF2 目标已闭环,没有待实现切片。若继续演进,从方案第 9 节的冻结发布门和 `run-hybrid-foundation-release-gate.ts` 开始,不得降低 precision、integrity 或失败原子性约束。

## 冻结边界
- 人工来源复核只确认 canonical text,不认证 PDF bbox。
- integrity 决定 stage 成败;quality 只决定 `full/degraded`。
- v2 selection shard 只含 `char_exact` 或 `partial` 中已证实的 exact 字符子区间;`region_exact/unmapped` 不得携带字符或升级。
- Reader 全局 degraded 不整体禁用操作,每个选择按最低 precision 决定能力。
- 失败恢复后官方 artifact 集只能是完整旧版或完整新版;不得改变语义图 ownership。

## 工作区注意
- 用户原有 Rust 修改仍包括 `crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`;不得覆盖。
- 本目标的 HF2-4 修改位于 `crates/read-tools/src/lib.rs`、`crates/server/src/lib.rs`;需与用户重叠改动谨慎区分。
- `.tmp-*`、日志、用户材料和其他 unrelated untracked 文件不属于本目标,不得清理或提交。

## 冷启动读序
1. 本 checkpoint 与 v2 修复方案 §4/§5/§8/§9。
2. `docs/adr/0082-hybrid-foundation-semantic-unit-alignment-and-degraded-reader.md`。
3. `packages/core/src/workbench-stage-runner.ts`、`hybrid-foundation-v2.ts`、`hybrid-foundation-apply.ts` 与 `scripts/run-hybrid-foundation-release-gate.ts`。
4. `packages/core/src/pdf-source-map.ts`、`source-manifest.ts`、`zod.ts` 与 HF2-0 goldset runner。
5. HF2-4/5 runtime/Web tests、`docs/架构.md` Hybrid foundation 数据流和方案 §9 发布门。
