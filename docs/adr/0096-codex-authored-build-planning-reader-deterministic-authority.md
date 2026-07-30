# ADR-0096 Codex-authored build planning and Reader deterministic authority

Status: Accepted, 2026-07-30.
Clarifies: ADR-0094 §§1、4 的 “Codex-designed” 执行归属。
Revises: ADR-0093 §§3、9 中 Codex 入口复用 Reader-side Planner 的实现映射;保留唯一 reader-private 计划权威。
Change type: 边界重构。

用户在 Codex task `019fb118-2a26-7022-873c-662bf5642a4b` 确认:Codex 入口应由当前 Codex 直接解释目标、选择或设计 Blueprint 并提交严格候选;Reader/Core 只提供当前书规划上下文、确定性验收、私有状态与发布。实施顺序见[切片方案](../切片方案-Codex主导构建规划与Reader确定性权威.md)。

### §1 Codex 语义规划权

**决策**:Codex 负责目标规划与 Blueprint 设计。

**否决**:
- Codex 只传 raw goal:Reader 模型会二次解释并可能丢失硬约束。
- Reader 模型重做 Codex 计划:产生双规划者与不可归因漂移。
- Codex 同时验收自己的候选:生成者与裁判同源。

**命门**:Codex 只提交严格数据候选,不能写 store、确认计划或绕过 Core gate。
**何时回头**:Codex 无法稳定构造受限候选且确定性修复不足时,只增加合同化辅助,不恢复隐式二次规划。

### §2 Reader/Core 确定性权威

**决策**:Reader/Core 保留状态、验收与发布权。

**否决**:
- intent/plan/artifact 全交给 Codex 会话:恢复、ACL 与 active overlay 无持久权威。
- Reader 接受未校验候选:source、scope、Blueprint 与 digest 可漂移。
- plugin 复制私有 store:形成双写与删除传播分叉。

**命门**:Reader 重读当前 source/Registry,Core 重算 schema、依赖、预算与 digest 后才可生成 draft。
**何时回头**:账户级远程控制面成为唯一状态权威时,另立 ADR 迁移所有权与删除传播。

### §3 有界规划上下文

**决策**:Reader 只向 Codex 投影有界规划上下文。

**否决**:
- 暴露完整私有 store:泄漏 raw goal、历史计划与失败正文。
- Codex 凭会话记忆猜 source/Registry:候选无法绑定当前书状态。
- 无 context digest 提交:inspect 与 draft 间可发生静默 TOCTOU。

**命门**:上下文只含 current book/source/profile、scope 摘要、Blueprint 摘要、合同上限与 canonical digest。
**何时回头**:精确局部 scope 无法由有界目录表达时,增加分页/opaque ref,不得暴露任意路径或正文。

### §4 双入口单编译器

**决策**:Codex 与 Reader UI 共用同一编译器。

**否决**:
- 删除 Reader UI 独立规划:桌面端离开 Codex 后不可用。
- 两入口各写一套 validator:同一候选会出现不同 plan/digest。
- Codex 缺能力时静默回退 Reader 模型:重新引入硬约束丢失。

**命门**:Codex 入口提交 candidate;Reader UI 可用 provider 产同形 candidate;两者随后走同一 resolve/compile/persist 路径。
**何时回头**:Reader UI 不再需要独立运行时,可删除 provider 入口,不改变候选与编译合同。

### §5 确认与 freshness

**决策**:确认仍绑定唯一 plan digest。

**否决**:
- 确认 Codex 自述而非 Reader 投影:用户看不到真实依赖与成本。
- candidate 确认后直接执行:尚未冻结 Blueprint、scope 与预算。
- context 漂移后沿用旧候选:计划基于过期 source 或 Registry。

**命门**:candidate 只生成 draft;用户仍确认 Reader 投影的精确 `plan_id + plan_digest`。
**何时回头**:计划摘要不足以识别高风险变更时,扩充投影字段,不把确认权交给 Agent。

### §6 结构化失败闭环

**决策**:每次控制器调用必须可归因终止。

**否决**:
- 空 stdout 归因为缺 Blueprint:没有因果证据。
- 只靠调用者猜退出状态:异步等待会丢失 exit code。
- 错误正文回显 raw goal/provider secret:破坏私有边界。

**命门**:正常失败返回有版本、阶段、错误码和 retryability 的脱敏 envelope;异常退出由 harness 保留数值 exit code。
**何时回头**:跨进程 tracing 成为统一基础设施时,错误 envelope 仍保留稳定用户恢复码。

### §7 兼容与切换

**决策**:新 Codex 入口经能力协商渐进切换。

**否决**:
- 原地改变 v1 命令语义:旧 plugin 会把 candidate 字段当协议错误。
- 重写已确认计划:破坏既有 digest 与审计。
- 新 plugin 自动降级 raw-goal draft:失败时又由 Reader 模型猜目标。

**命门**:v1、既有 plan/overlay 与 Reader UI 保持可读;新 plugin 缺 v2 能力时明确要求升级。
**何时回头**:支持窗口内已无 v1 plugin 调用且回滚期结束时,单独删除兼容入口。
