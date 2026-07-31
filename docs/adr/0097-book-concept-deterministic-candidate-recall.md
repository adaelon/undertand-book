# ADR-0097 `book.concept` deterministic candidate recall

Status: Accepted, 2026-07-31.
Revises: ADR-0014 §4 的精确名称单节点契约。
Extends: ADR-0015 的显式失败语义与 ADR-0088 的确定性 Book 工具契约单源。
Change type: 边界重构。

`GraphNode.name` 是模型生成的展示标签，用户通常不会准确复述“模型与脚手架的消长关系”这类名称。用户已确认把 `book.concept` 改为确定性候选发现工具，同时保持 `book.query` 的合同与运行时行为不变。

### §1 概念发现职责

**决策**:`book.concept` 只确定性召回相关 concept/entity 候选，最终语义选择由看到完整问题的外层 Agent 完成。

**否决**:
- 继续按展示名称精确返回单节点:大量描述性节点不可由用户自然访问。
- 工具内部调用 LLM 选候选:复制 `book.query` 的 Agent loop 与 Provider 故障面。
- 多候选时报歧义错误:同一主题的不同侧面是正常结果，不是异常。

**命门**:候选不是最终回答；调用方选择一个或多个候选后，仍须用 `book.text` 读取完整原文。
**展开**:[切片方案](../切片方案-book-concept确定性候选召回.md)。

### §2 全书召回与严格排序

**决策**:全书召回按标签完整命中、标签词元命中、标签近似命中、occurrence 正文命中严格分层，弱信号不得累计越级。

**否决**:
- 用 anchor 过滤候选:当前位置会遮蔽远处更准确的节点。
- 把所有信号混成总分:大量正文弱命中可能压过标签强命中。
- 把 `node_id` 当查询地址:它是构建内图主键，不是跨重建稳定的公开键。

**命门**:同层依次按查询词覆盖率、不同命中词数、可选 anchor 距离和 `node_id` 排序；无匹配节点排除。
**展开**:[切片方案](../切片方案-book-concept确定性候选召回.md)。

### §3 有界、可解释的候选结果

**决策**:成功结果返回有界候选集，每项携带节点身份、完整 occurrences、可解释匹配信息与有限预览。

**否决**:
- 返回全部候选:正文召回会制造无界 MCP 载荷。
- 只返回 LID 指针:外层 Agent 必须对每个候选逐一读取才能选择。
- 把预览当完整证据:短窗只能解释召回原因，不能支撑最终回答。

**命门**:默认 12、`limit` 上限 50；返回 `matched_count/returned_count/truncated`，首版无分页；每项最多两条约 180 字符预览。
**展开**:[切片方案](../切片方案-book-concept确定性候选召回.md)。

### §4 零候选失败边界

**决策**:零候选继续返回 `CONCEPT_NOT_FOUND`；一个或多个候选均为成功。

**否决**:
- 以成功空集合表达未找到:削弱既有显式失败与 Agent 恢复分流。
- 自动降级 `book.search_text`:会把图谱概念发现静默替换成正文定位。
- 恢复精确单节点歧义错误:候选集本身就是显式消歧材料。

**命门**:错误只报告未找到和可行动恢复信息，不替调用方修改输入或选择结果。
**展开**:[切片方案](../切片方案-book-concept确定性候选召回.md)。

### §5 `book_concept.v2` 兼容边界

**决策**:逻辑合同升级为 `book_concept.v2`；精确名称保持语义可查，旧 `{name} -> Concept` wire shape 不保留。

**否决**:
- 同一工具按 `name/query` 返回两种结构:形成难以验证和消费的联合合同。
- 保留 `node_id` 直达模式:把内部图主键误升为公开地址。
- 原地冒充 v1 未变化:外部调用方无法识别破坏性响应升级。

**命门**:输入为 `{query, anchor_lid?, limit?}`；本 ADR 不规定调用方传原始问题还是提炼表达，只承诺对给定字符串确定性召回。
**展开**:[切片方案](../切片方案-book-concept确定性候选召回.md)。

### §6 所有权与 `book.query` 隔离

**决策**:`read-tools` 拥有候选召回，`book-tool-contracts` 拥有 v2 合同，Runtime/REST/MCP 只投影；`book.query` 行为冻结。

**否决**:
- 在 MCP/server 复制搜索实现:Resident、REST 与 MCP 会再次漂移。
- 借升级顺便改 `book.query`:无法归因回归，也扩大已冻结范围。
- 为 v2 新增第二套相似 matcher:排序和匹配原因会与现有 `ReferentCatalog` 漂移。

**命门**:共享 matcher 的重构必须由 `book.query` characterization 锁住；不得改变其 Provider、PlanGate、候选选择或失败语义。
**展开**:[切片方案](../切片方案-book-concept确定性候选召回.md)。
