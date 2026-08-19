# ADR-0111 paper_lexicon 条目级拒绝与前向恢复

Status: Accepted, 2026-08-19.
Extends: ADR-0103 and ADR-0107. Change type: [纯技术].

### §1 条目级候选门禁

**决策**:结构、Schema 与证据校验通过后，`paper_lexicon` Writer 对每条 entry 独立执行严格候选门禁；精确规范化匹配或唯一、来源支撑的路由器过捕获修复可接受，其余条目拒绝，合法余项或空 artifact 仍提交。

**否决**:
- 任一越界 entry 抛错整批：一个可省略术语会耗尽语义重试并阻塞阶段 DAG。
- 任意子串或语义相似即接受：会绕过候选 shortlist 并放入模型幻觉。
- 静默丢弃：质量退化不可观察，也无法证明 Writer 实际执行了门禁。

**命门**:artifact 与 committed receipt 只记录 allowlisted warning code 和数量，不保存被拒候选、正文或路径；JSON/Schema/证据、任务身份、来源绑定及持久化完整性错误仍阻断整个 work unit。

### §2 前向发布隔离

**决策**:新代际使用 scoped ID 与 create-only policy lock。

**否决**:
- 原地改写旧单文件 policy lock：旧 scope 会被伪装成同代漂移。
- 复用旧 work-unit/artifact 路径：历史失败次数和候选产物会污染 successor。
- reset、迁移或删除旧账本：会破坏不可变审计与失败证据。

**命门**:`direct/fragment/reduce/skip` ID 绑定 stage-policy/router/prompt 摘要；claim 只新增按完整 policy digest 寻址的 generation lock，旧 lock/attempt/artifact 保持只读，新 scope 从 semantic attempt 1 开始。

**何时回头**:若 `paper_lexicon` 升为 V3 policy-set 协议，统一迁入正式 generation task；不得回退为原地覆盖。
