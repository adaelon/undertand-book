# ADR-0092 Phase-aware automatic-build leases and executor dispatch bundles

Status: Accepted, 2026-07-25.
Extends: ADR-0084 and ADR-0085.
Change type: 边界重构。

Quantification Essence 的 `full` 真模型运行中,Pass1 固定 5 分钟租约只提交 3/18 个领取,46 个 work unit 产生 67 个 lease;随后 profile sidecar 剩余 398 个任务中 284 个为 P50 181-token 的公式任务。质量门一次通过,瓶颈位于租约、冷启动和批次调度。本 ADR 冻结恢复与调度边界;实施顺序见[切片方案](../切片方案-一键预构建租约与调度性能治理.md)。

### §1 分阶段任务租约

**决策**:任务先进入短期 `reserved` 租约,executor 首次成功接管输入后原子进入独立期限的 `running` 租约。

**否决**:
- Claim 起统一 5 分钟 TTL:冷启动先消耗执行期限,正常 P50 任务也会过期。
- 所有阶段统一 30 分钟 reservation:executor 未启动时恢复过慢。
- 依赖 extractor 主动 heartbeat 才能正常完成:模型忘记续租会制造重复执行。

**命门**:无历史时 running TTL 必须保守覆盖真实长任务;heartbeat 由 dispatcher 驱动且只作延长,不得成为正常完成的必要条件。
**何时回头**:Harness 提供可验证的进程级任务生命周期与取消 API 时,可用真实进程存活替代部分时间租约。
**展开**:[性能与成本复盘](../运行统计-2026-07-24-quantification-essence-full预构建性能与成本复盘.md#14-优化方案)

### §2 恢复与失败计数

**决策**:分别记录 `semantic_attempt`、`lease_epoch` 与 `submit_revision`,重试门禁只由版本化上限和对应诊断维度判定。

**否决**:
- 一个 `attempt` 同时表示推理失败、租约恢复和编码重传:磁盘编号与“最多三次”无法一致。
- 只统计 terminal failure:无 metrics 的过期 lease 可无限重复领取。
- 所有 expiry 都消耗语义重试:基础设施抖动会错误触发质量失败。

**命门**:`max_semantic_attempts=3`;lease epoch 另设 executor-instability 上限,过期 token 永久不能 submit,submit revision 不得改变候选语义。
**何时回头**:真实故障数据证明某类 provider failure 不应消耗 semantic attempt 时,以新诊断分类修订,不得靠重置计数绕过。
**展开**:[性能与成本复盘](../运行统计-2026-07-24-quantification-essence-full预构建性能与成本复盘.md#6-lease-失配与重复领取)

### §3 Executor 调度执行包

**决策**:一个专用 executor session 可消费同 target/stage/policy/kind 的有界 dispatch manifest,并通过 `dispatch.next` 逐个领取既有 work unit。

**否决**:
- 永久保持一 lease 一 subagent:短任务的启动成本高于语义执行。
- 首步就合并 router work unit:改变 input、artifact freshness 与失败重做半径。
- 当前即引入常驻进程 worker:Harness 尚无稳定进程级任务 API。

**命门**:同一时刻每个 dispatch 只激活一个 task lease;每个 task 独立 input/candidate/receipt/artifact,root 仍禁止接触 candidate payload。
**何时回头**:版本化真书基准证明跨任务上下文污染或串行 session 成本高于独立启动时,缩小 dispatch 上限或恢复一任务一 session。
**展开**:[切片方案](../切片方案-一键预构建租约与调度性能治理.md#4-目标执行链)

### §4 语义与调度边界

**决策**:调度执行包不改变 ADR-0085 的 work unit、router version、policy fingerprint 或 semantic artifact identity。

**否决**:
- 把 dispatch manifest 当成新 work unit:会让瞬时调度身份污染 artifact freshness。
- 混合多个 kind/policy 的任务:共享 executor 上下文会失去可比性。
- 为续建当前书静默迁移 sidecar router:已提交 artifact 与 pending plan 将不可审计。

**命门**:真正把多个 micro-unit 合成一次模型输入属于后续 semantic bundling,必须升级 router/policy 并单独通过质量 A/B 与显式 stage migration。
**何时回头**:调度级复用达到冷启动目标后,模型调用固定开销仍占主导且质量基准支持合并推理时。
**展开**:[ADR-0085](0085-stage-specific-work-units-and-policy-bound-artifacts.md)

### §5 性能账本与预算

**决策**:Preflight 分列全计划与剩余增量成本,用 append-only 生命周期事件和匹配模型历史预测三路 list-scheduling 墙钟区间。

**否决**:
- 只用 estimated tokens 判 `within_budget`:无法暴露数百次 agent start。
- 用最终 metrics 覆盖中间 failure:失败和过期成本会从 summary 消失。
- 把跨模型、router 或 harness 的时长混成 stage 均值:预测不可迁移。

**命门**:历史键至少绑定 stage/kind/router/model/reasoning/harness release;模型身份只进入 provenance 和性能历史,不使等价 artifact stale。
**何时回头**:样本不足时输出低置信区间并进入 `needs_user`,不得以虚假精度自动放行。
**展开**:[性能与成本复盘](../运行统计-2026-07-24-quantification-essence-full预构建性能与成本复盘.md#14-优化方案)

### §6 当前构建与发布

**决策**:保留已关闭 Pass1 和 3 个 fresh sidecar artifact;新调度协议只续领 pending work unit,不触发语义 stage 重建。

**否决**:
- 删除 Quantification Essence workspace 重跑:浪费已通过的质量产物。
- 以空输出或 `--allow-partial` 快速 close:改变用户冻结的 `full` 目标。
- 在修复调度前用整书比较模型:TTL 阈值会污染模型 A/B。

**命门**:生产切换前必须通过真实 harness/model 回放、quality gate、协议 parity 与中断续建;router 真变化时仍走显式 migration。
**何时回头**:现有 sidecar artifact 失去 policy freshness,或完整性/质量门失败。
**展开**:[性能与成本复盘](../运行统计-2026-07-24-quantification-essence-full预构建性能与成本复盘.md#13-当前构建的安全处理)
