# ADR-0103 Extractor contract coherence and policy-scoped retry recovery

Status: Accepted, 2026-08-10.
Extends: ADR-0085, ADR-0092, ADR-0100 and ADR-0101.
Revises: ADR-0092 的语义尝试计数实现边界，以及 ADR-0100 §5 的耗尽恢复入口。
Change type: [纯技术]。

`profile_sidecar` 事故中，模型连续产出违反当前严格 Schema 的候选：历史诊断 16 次为 `local_summary` 超过 200，5 次为 `local_function` 非法枚举；最终三次依次为摘要超限、两次把 `problem_framing` 写入错误字段。第三次失败后同一 work unit 进入持久化 `retry_exhausted`。根因是提示词、Schema、尝试身份和恢复入口没有形成一个闭环，不是 Pass2、旧书产物迁移或模型偶发波动。实施顺序见[切片方案](../切片方案-抽取契约一致性与策略作用域重试恢复.md)。

## §1 抽取契约权威

**决策**:Zod 校验与模型约束共享同一声明。

**否决**:
- 只改提示正文:字段上限或枚举下次演进时仍会再次漂移。
- 放宽 `local_summary` Schema:会把确定性契约错误伪装成兼容。
- 依赖模型自行纠错:模型看不到的限制不能成为可靠反馈环。

**命门**:闭集枚举、必填性、nullable、数值/长度边界和 paper 字段提示均从同一类型化定义生成；手写提示只解释语义，不得重述这些机器约束。
**何时回头**:若 Schema 改由独立 IDL 生成，则 IDL 接替权威，Zod 与提示继续只做投影。

## §2 语义尝试作用域

**决策**:语义尝试按完整任务策略绑定计数。

**否决**:
- 只按 `stage + work_unit_id` 计数:旧 policy 的失败会污染新 policy。
- 仅绑定 `prompt_sha256`:输入、proof、schema 或质量策略变化仍会串账。
- 删除旧 attempt 后重算:破坏 append-only 审计和中断恢复证据。

**命门**:`attempt_scope_digest = sha256(canonical(target_ref, stage, work_unit_id, task_binding))`；physical attempt 全局单调，`semantic_attempt` 与耗尽上限只在同一 scope 内单调。
**何时回头**:若任务目录整体迁移到 generation-qualified store，可改变物理布局，但 scope 公式和历史可读性不变。

## §3 失败诊断

**决策**:失败账本保存有界类型化根因。

**否决**:
- 一律降格为 `writer_failed`:恢复层无法区分契约错与瞬时错。
- 解析自由文本 message:措辞变化会改变状态机分支。
- 保存 candidate 或正文:越过 executor 私有边界并扩大泄露面。

**命门**:receipt/attempt event 只保存 allowlisted category、code、JSON pointer、expected 摘要和 diagnostic digest；原 candidate、语义输入与任意路径仍不得越界。
**何时回头**:统一 tracing 成为诊断权威时，账本仍保留恢复分支所需的稳定 code 与 digest。

## §4 耗尽恢复

**决策**:重试只能经绑定前态的守卫式恢复。

**否决**:
- `retry_current` 无条件写 reset:未修好的确定性错误会被反复放行。
- `retry_current` 只写决定回执:用户会重新读到同一终态且无恢复入口。
- 暴露通用 `record-attempt reset`:调用者可绕过策略与诊断校验。

**命门**:scope 已变化则直接重新计划；同 scope 仅 allowlisted 瞬时故障可凭绑定终态和用户决定的 create-only recovery receipt 开一轮窗口；`schema_invalid`/evidence/policy 错必须先改变对应 scope。
**何时回头**:若 provider 提供可验证的服务恢复凭证，可用它替代用户确认，但仍须绑定同一终态。

## §5 前向发布与续跑

**决策**:提示修复以前向策略代际发布。

**否决**:
- 原地改写旧 policy lock/hash:旧 attempt 与 artifact 将失去可解释身份。
- 手工清空当前书任务目录:无法证明只解除本次耗尽且不可安全回滚。
- 把本次归为 legacy migration:当前失败候选和任务均已绑定 v2/v3 当前协议。

**命门**:发布 `profile_sidecar_policy.v2` 及新 prompt/policy-set digest；旧失败 scope 保留，新 scope 从 `semantic_attempt=1` 开始，安装态 parity 通过后才对真实书执行 `retry_current` 重读。
**何时回头**:若新策略无法通过隔离回放，保持旧 generation 只读阻塞并发布 forward fix，不回写旧历史。
