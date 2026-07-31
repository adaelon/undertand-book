# ADR-0098 — Pass2 作为 BookStructure 可选增强

Status: Accepted, 2026-07-31.
Change type: 边界重构。
Revises: ADR-0093 §5 standard_deep fixed closure.

## §1 Pass2 计划选择

**决策**:Pass2 由用户选择并绑定 BuildPlan。

**否决**:
- BookStructure 硬依赖 Pass2:无长程边也无法生成结构地图。
- 只在 skill 记住选择:恢复执行时无法验证已确认范围。

**命门**:未启用 Pass2 时 BookStructure 使用空长程边输入;启用时继续消费 accepted/pending 审计边;后生成 audit 必须改变 unit/stitch 输入哈希,使旧结构失效并重建。
**何时回头**:BookStructure 的确定性质量闸证明长程边是不可缺的完整性条件时。
**展开**:[ADR-0093 §4](0093-intent-confirmed-progressive-prebuild-and-reader-private-goal-artifacts.md#4-buildplan-与依赖闭包)
