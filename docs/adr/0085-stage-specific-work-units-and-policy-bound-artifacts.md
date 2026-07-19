# ADR-0085 Stage-specific work units and policy-bound artifacts

Status: Accepted, 2026-07-18.
Revises: ADR-0009 as a universal semantic-stage partition.
Extends: ADR-0042 artifact freshness.

### §1 语义任务身份

**决策**:各 stage 自定工作单元并绑定策略身份。

**否决**:
- 全阶段复用 Pass1 窗口:坐标粒度会泄漏为语义粒度。
- 只按 source hash 判新鲜:无法识别 prompt、schema 与质量漂移。
- 运行中临时压缩输出:同一 stage 会混入不可比较的质量策略。

**命门**:LID 仍是证据坐标;工作单元不得改写 source/LID truth。
**何时回头**:版本化真书基准证明统一分区在成本与质量上稳定更优。
**展开**:[一键预构建执行面与成本治理](../修复方案-一键预构建执行面与成本治理.md)
