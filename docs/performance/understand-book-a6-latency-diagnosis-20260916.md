# A6 执行器耗时根因诊断

日期：2026-09-16。范围：Mastering Rust 隔离副本的关系选择阶段；只读分析，不改变构建代码、安装、任务、收据或派发状态。

## 结论

当前主要成本来自 BookStructure stitch 当前性检查重建整个阶段。Executor 的输入交付、启动和提交反复进入这条路径；输入冻结复用没有消除阶段重建。三槽补位另有一个独立问题：已派发、尚未领取租约的任务被再次选中，旧引用占用新增派发名额。关系选择的块对枚举产生 210 个任务，进一步放大每个任务的控制成本。

前次 P1–P4 提速有效，但验收负载是 Pass1/sidecar，文档明确保留 stitch 全局依赖。不能把该负载四工具约 4.07 秒的结果推广到本次 BookStructure 关系任务。A5 已记录实书副本准备耗时 43.922 秒，A6 则暴露了这一阶段成本被每个执行器操作反复支付的问题。

## 证据与口径

- 原任务：`01a0aa04-03de-7de0-8116-0dd80cc1363a`。原任务已暂停新增执行；本诊断没有恢复它。
- [原执行器时间记录](../../tmp/a6-perf-20260916.json)：9 个 repair、16 个 select。本文选择阶段统计只使用 16 个 select，全部为 `gpt-5.6-sol / low`。
- [只读阶段剖析结果](../../tmp/a6-profile-route.json)、[剖析入口](../../tmp/a6-profile-route.ts)、[CPU profile](../../tmp/a6-route.cpuprofile)：读取一个 `stitch:select:000015` 的阶段投影。
- [P1–P4 验收](understand-book-p1-p4-control-plane.md)、[A5 验收](understand-book-a5-release.md)。
- 本次复核已有时间记录、CPU 样本与当前源码，没有重新运行整书、真实模型或性能负载。
- 原统计脚本对偶数样本取上中位数。本文按中间两个样本的均值重算；原始数据保持不变。

| 16 个选择任务的指标 | 结果 |
|---|---:|
| 单任务墙钟中位数 | 400.786 秒 |
| 单任务四工具合计中位数 | 315.964 秒 |
| 扣除四工具的墙钟中位数 | 86.615 秒 |
| 全部工具耗时 / 全部任务耗时 | 77.250% |
| open 中位数 | 65.738 秒 |
| input.next 中位数 | 56.602 秒 |
| generation.start 中位数 | 91.714 秒 |
| submit_candidate 中位数 | 95.344 秒 |

各列中位数不能直接相加。非工具时间包括模型生成、启动、调度、消息处理等，不是纯模型推理时间。工具墙钟包含本地计算、工具传输与等待；下述本地剖析另行证明阶段重建的实质成本。

## 1. 单任务检查实际重建 628 个工作单元

入口链：`taskDescriptor` → `readAutomaticBuildTaskStage` → `buildAutomaticBuildSnapshotInternal` → `routeBookStructureProductionStage`。

- `packages/core/src/automatic-build-executor-session.ts:2292` 的冻结 descriptor 快路仅支持 Pass1/sidecar。BookStructure 在 `:2316` 重新路由；`parent_unit_lid === "stitch"` 时不提供 parent 限定。
- `packages/core/src/build-orchestrator.ts:2844` 仅按可选 parent 筛选单元，`:2864` 的 task-stage 入口没有按 selection work-unit ID 缩小整阶段输出。
- 同文件 `:1999` 遍历所有单元重新路由，`:2297` 重建所有关系选择工作。

只读剖析墙钟 **38.021 秒**，返回 **628 个 work units**；当时局部贡献 37/37、选择 16/210。

| 不重叠的主要调用子树 | CPU 采样归属时间 |
|---|---:|
| routeBookStructureUnitWorkUnitsV2 | 14.030 秒 |
| routeBookStructureRelationSelections | 9.258 秒 |
| assertNoActiveLegacyGenerationLease | 8.888 秒 |

样本中 task-stage 调用归属约 37.276 秒，采样时间与墙钟不完全相等。嵌套函数的 inclusive 时间不能重复累加。

BookStructure 目录一次检查执行 14,480 次 exists、4,188 次 readdir、5,789 次 read；读取约 7.74 MB。原 EPUB 读取本身只有约 3.3 毫秒。因此不是单纯“大文件读取慢”，而是重建、预算计算及大量小文件访问叠加。

**最小修复方向**：为 stitch/select/delta 提供与其冻结任务相符的定向当前性检查，核对当前策略、源绑定、实际依赖成果及输出合同；不重新生成无关单元与全体选择任务。全阶段规划仍由 Driver 在需要时负责。保留源变化、策略变化、依赖失效的拒绝行为。

## 2. 四工具反复支付同一阶段成本

`packages/core/src/automatic-build-executor-session.ts` 的调用位置：

- open：`:4445` 调用 `taskDescriptor`。
- input.next：`:4514` 进入 `resolveDeliverySessionContext`，后者在 `:4268` 调用 `taskDescriptor`。
- generation.start：`:4629` 经同一 context 核对，然后 `:4727` 再调用 `taskDescriptor`。
- submit：`:4988` 经 delivery context 核对，`:4997` 又调用 `taskDescriptor`；还存在其他任务解析路径。

冻结输入的复用发生在当前性检查之后，不能跳过上述全阶段路由。因此 start/submit 比 open/input 更慢有直接的调用链解释；这里不把静态调用次数当作完整运行时次数。

CPU 热点还包含 `packages/core/src/book-structure.ts:755` 的预算评估，以及 `packages/core/src/executor-transport.ts:459` 的逐块二分打包。每个候选范围都重新拼接、序列化和估算 token。关系路由每次分块失败后从头评估块对，重复生成大量预算证据。

**最小修复方向**：先消除整阶段重建；同一次请求内、无状态变更的重复解析共享结果。只有剩余剖析仍显示打包为主要成本时，再优化预算打包。无需先更换模型或提高并发上限。

## 3. 已派发但未领取租约的任务占用新增补位名额

`packages/core/src/automatic-build-dispatch-runtime.ts:671` 的 `dispatchPlanRuntimeState` 只在 claim 为 already_leased 或策略冲突状态时把 dispatch 计为 active。公开执行器到 `generation.start` 的 `:4774` 才推进领取租约；open 和输入交付期间已有 child，但尚不满足该 active 判据。

`automatic-build-dispatch-runtime.ts:791` 用 active 数加宿主提供的空槽数计算容量；`automatic-build-dispatch.ts:317` 再扣 active，并从未完成集合前部截取相应数量。尚未领取租约的旧 dispatch 仍在候选集合中，于是旧引用消耗新增名额。之后 Driver 重放引用、Root 去重都没有创造额外新任务。

同一天香港时间的实际序列：

| 时间 | 事件 |
|---|---|
| 20:25:04 | select_004 启动 |
| 20:25:08 | Root 请求 2 个空槽 |
| 20:27:14 | Driver 返回 select_004 的旧引用 + 1 个新引用 |
| 20:27:20 | select_005 启动 |
| 20:27:25 | Root 请求剩余 1 个空槽 |
| 20:29:35 | Driver 返回相同两个旧引用，没有第三个新引用 |

select_004 的 generation.start 为 20:27:54–20:29:24；select_005 为 20:30:12–20:31:42。调度初始状态读取时，它们处于尚未领取租约的阶段，与源码缺口吻合。这是分钟级正常执行路径，不是毫秒竞态。

**最小修复方向**：将已签发未终态 dispatch 的重放与新增补位分开。旧引用保留恢复语义，但不能占用本次“可新增 child”名额；沿用既有 slot/ref 和恢复记录，不把所有旧派发永久标记为活跃。

**针对性验收场景**：两个 child 已 open、尚未 generation.start，宿主报告一个空槽；本次必须提供一个不同的新 handoff。既有引用仍可重放，中断恢复不重复执行同一 slot。

## 4. 210 次选择及后续串行关系处理放大总耗时

`packages/core/src/book-structure-relation-routing.ts:121` 对固定索引分块枚举 `a <= b` 的全部块对。若没有单元素跳过，B 块产生 B(B+1)/2 次选择，210 与 20 块相符；实际已观察到的任务数是 210。单条索引会在多个任务里重复交付。

该文件 `:146` 将选中的组展开成去重条目对。`build-orchestrator.ts:2315` 依次应用关系 delta，在第一个未完成任务处 `:2321` 停止，因此当前实现的关系生成阶段一次只暴露一个 pending delta。这个阶段尚未实测，不能据此报告实际总调用数或墙钟，但选择结束不等于立即发布。

按当前单任务中位数 400.786 秒、210 项、始终满三槽机械折算，仅选择阶段约 **7.79 小时**；这不是完成时间预测，未计补位空档、Driver 延迟及后续关系任务。

**修复顺序**：先修单任务读取和补位，再用相同来源衡量选择工作的总成本。若调整全块对召回策略，必须保留非相邻、不同名称主题的语义召回验收；不能直接改成相邻块比较来缩短任务数。

## 验证边界与下一步

1. 实现定向当前性检查后，在同一冻结负载重测四工具及文件访问数；如果没有明显减少，就继续定位残余调用，不能宣称提速完成。源、策略和实际依赖变化仍须拒绝旧任务。
2. 用“已 open、未领取租约 + 一个真实空槽”的调度回归验证补位修复，同时保留中断恢复行为。
3. 用少量真实选择任务测单任务墙钟及满槽情况，再决定是否继续 210 项验收。

限制：本地 CPU profile 是一次带剖析的源码运行，不能与已安装程序的并发 MCP 墙钟逐秒等同。本次没有新修复，也没有修复后速度数据。Book MCP 当前原文 1.1 为《深入理解 ai agent》，不满足 Performance Hints 技能的书源要求；本报告依据项目源码与运行记录，不引用该书作性能依据。
