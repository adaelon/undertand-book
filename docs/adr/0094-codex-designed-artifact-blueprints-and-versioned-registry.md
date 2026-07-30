# ADR-0094 Codex-designed artifact blueprints and versioned registry

Status: Accepted, 2026-07-29.
Revises: ADR-0093 §§4、6 and the fixed four-type target-artifact contract.
Change type: 边界重构。

现有 Planner、BuildPlan 与 artifact gate 实际只执行 timeline、concept map、comparison table、argument map 四类结构,顶层 `custom` 只是不可执行枚举。用户已在 Codex task `019fac59-f620-7233-8332-03df320ca875` 确认:产物应由 Codex 按目标设计,Runtime 继续拥有确定性验收权。实施顺序见[切片方案](../切片方案-需求驱动产物Blueprint与Agent访问.md)。

### §1 目标驱动 Blueprint

**决策**:Codex 按目标选择或设计 0..N 个受限数据型 Blueprint。

**否决**:
- 所有目标强制映射到既有四类:练习题、术语索引、实施清单等无法准确表达。
- 开放任意 JSON、代码或渲染器:无法确定性验收,并扩大执行与展示攻击面。
- 无匹配预设即返回 unsupported:把 Codex 的结构设计能力闲置。

**命门**:只允许 collection、table、graph、sequence、document 五种通用形态和受限 schema DSL,禁止自定义可执行代码与渲染器。
**何时回头**:真实需求证明通用形态无法无损表达稳定高频结构时,只扩展 DSL/shape 版本,不开放任意执行。

### §2 两层 Blueprint Registry

**决策**:Registry 分为系统预设与用户私有候选两层。

**否决**:
- 只保留系统模板:新目标仍会被预设集合卡死。
- 每次从零自由设计:相似需求形成不兼容 schema 动物园。
- 自动把私有候选发布为系统模板:未经人工评审即改变全局兼容面。

**命门**:优先复用但不强套;私有候选只保存 schema、路由元数据、版本和使用记录,不保存书中内容。
**何时回头**:跨用户共享或团队模板成为产品需求时,另立 ADR 定义发布、审阅、撤回与同步冲突。

### §3 一次计划确认

**决策**:BuildPlan 以 `blueprint_digest` 冻结完整 Blueprint,只确认一次。

**否决**:
- 计划确认后再确认 schema:增加第二道无增量价值的人机门槛。
- 只展示原始 JSON Schema:用户无法判断用途、结构与成本。
- Blueprint 不进入 `plan_digest`:确认后可静默改变产物合同。

**命门**:确认面只展示名称、用途、形态、关键字段与成本;任何 Blueprint、依赖或预算漂移均回到 `needs_user`。
**何时回头**:用户研究证明关键字段摘要不足以识别高风险 schema 时,扩充摘要,不拆成第二次确认。

### §4 Codex 生成与 Runtime 验收

**决策**:Codex 设计并生成,Runtime 校验结构、证据、规模和 digest。

**否决**:
- 由 Codex 自评 schema 与实例合格:生成者与裁判同源,没有确定性闭环。
- Runtime 按产物名称写专用分支:每个新 Blueprint 都迫使修改执行器。
- 只校验顶层 payload:单条记录可绕过 LID 证据与规模边界。

**命门**:每条 record/relation 必须符合 Blueprint、带 scope 内真实 LID;source/intent/plan/blueprint/payload digest 全匹配才可 accepted。
**何时回头**:若某类产物需要非数据型行为,作为独立 capability 评审,不得塞入 Blueprint DSL。

### §5 既有四类兼容

**决策**:既有四类降为版本化系统 Blueprint,旧 accepted v1 只读适配。

**否决**:
- 原地重写历史 accepted 文件:破坏 digest、审计与恢复证据。
- 立即删除 typed Reader view:造成已完成 IP7 的展示回归。
- 永久保留两套生成合同:新旧 Planner 与 gate 会继续漂移。

**命门**:旧文件按固定类型映射到内置 Blueprint 和稳定 record ref;新生成只写新合同,迁移期保持读取 parity。
**何时回头**:遥测证明受支持版本中已无 v1 存量且回滚窗口结束时,可单独删除适配器。

### §6 Blueprint v1 有界规范

**决策**:所有容器、文本、数值和 schema 复杂度必须显式有界。

**否决**:
- 开放 `$ref`、递归、正则或额外属性:会绕过本地确定性验收并扩大输入面。
- 为 comparison dimensions 放开任意 JSON schema:会把受限 DSL 退化为无界 JSON。

**命门**:系统 comparison preset 把任意旧 dimension 值规范化为 `name + value_json`;AA4 适配器负责转换,不改写 v1 accepted。
**何时回头**:稳定高频产物证明现有 primitive/object/array 无损表达不足时,新增 DSL 版本并保留旧 digest。
