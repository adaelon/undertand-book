# ADR-0101 Deterministic prebuild protocol ownership and Codex semantic boundary

Status: Accepted, 2026-08-08.
Extends: ADR-0067, ADR-0084, ADR-0092, ADR-0096, ADR-0099 and ADR-0100.
Change type: 边界重构。

当前 `$understand-book-build` 仍要求 Codex root 或 executor subagent 解析固定协议、查文件、比较路径与摘要、聚合 receipt，并手工推进 `protocol-doctor -> plan -> next -> close -> replan`。这些客观判断与 Build Engine、Desktop/Core 已有 gate 重复，既消耗 harness 上下文，也把可恢复构建错误暴露为提示词执行风险。实施顺序见[切片方案](../切片方案-预构建确定性确认收口.md)。

## §1 确定性协议工作所有权

**决策**:凡由封闭输入和版本合同产生唯一结果的预构建工作，必须由对应权威代码执行并返回结构化结论。

**否决**:
- 继续让 Codex 重算文件、路径、长度、hash、schema、digest 或 receipt 结论：重复代码 gate 且不可稳定测试。
- 为缩短 skill 删除既有 gate：责任迁移不等于降低 source、artifact、quality 或发布门禁。
- 让 Sidecar 直连模型：会违反 ADR-0084 的 harness 推理所有权并引入第二套 provider 运行时。

**命门**:生产者与消费者两端需要的重验仍保留，但必须在代码中于使用点执行，失败关闭且不得由 LLM 目测替代。
**何时回头**:某项判断无法形成封闭输入、版本合同和客观期望结果时，才允许回到语义 agent 或用户决策。

## §2 Codex 外部动作面

**决策**:构建 driver 只返回 `SPAWN_EXECUTORS / WAIT / NEEDS_USER / DONE`；语义规划留在构建执行面之外。

**否决**:
- 向 root 暴露 `protocol-doctor/plan/next/close` 原始分支和命令数组：继续把内部状态机伪装成 agent 工作。
- 由 Sidecar 启动 Codex subagent：本地进程没有 harness 调度权限，也不能证明可用 agent 槽位。
- 依赖对话记忆保存 accepted digest、attempt 或完成状态：磁盘权威和跨会话恢复会失真。

**命门**:Codex 只提供自然语言语义、显式用户选择、实时可用槽位和 harness 生命周期观察；计划确认由代码把选择回执绑定当前 digest，driver 每次从权威磁盘状态重算。
**何时回头**:Codex 提供稳定、可验证的进程级 agent API 时，可把 spawn/wait 生命周期进一步下沉，但语义和用户授权仍不下沉。

## §3 Handoff 与 Mailbox 边界

**决策**:保留 handoff 与 task mailbox，`executor.open` 负责消费端原子重验，executor 只消费语义输入并产出候选正文。

**否决**:
- 删除 mailbox 并让 candidate 经 root 中转：破坏隐私、并发隔离、幂等提交和断点恢复。
- 让 root 或 executor 手工验证 handoff/mailbox 文件：消费端重验应由 bootstrap/submit helper 原子完成。
- 把 dispatch bundle 合并成新的语义 work unit：瞬时调度不得改变 artifact identity 或失败重做半径。

**命门**:root 永不读取 prompt、task input、candidate、raw goal 或 mailbox 内容；subagent 只回传有界完成信号，最终状态由代码重读 receipt 和 artifact。
**何时回头**:Harness 原生提供私有任务输入、结构化模型输出和持久 receipt mailbox 时，可用等价原语替换磁盘实现。

## §4 兼容与范围

**决策**:本次仅迁移执行责任，不改变 BuildPlan、work unit、artifact、freshness、quality、lease 或重试语义。

**否决**:
- 同时移除 `proof_digest/policy_set_digest` 等身份字段：那是独立的 freshness 简化决策和迁移项目。
- 重写既有任务、dispatch、mailbox 或 accepted artifact：会破坏 append-only 审计与普通 resume。
- 用 skill 静态文本替代行为回归：发布门必须覆盖真实薄插件、Sidecar、Desktop controller 和中断恢复。

**命门**:旧命令和协议在迁移期保持内部兼容与显式 rollback；新 driver 不复制 Reader-private store，也不改写历史状态。
**何时回头**:真实回放证明动作收口无法保持现有 artifact/receipt 语义或显著降低可诊断性时，回滚入口而不迁移用户数据。
