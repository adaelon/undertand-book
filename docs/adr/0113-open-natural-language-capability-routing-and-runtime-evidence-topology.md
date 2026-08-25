# ADR-0113 Open-natural-language capability routing and Runtime evidence topology

Status: Accepted, 2026-08-23.
Extends: ADR-0036 and ADR-0091.
Clarifies: ADR-0104 §1–§3.
Change type: [边界重构]。

Resident 当前只有两条能力发现路径：首轮 `turn_intent_classifier.v1` 以闭集短语预激活显式带读能力，延迟路径则让模型按工具名、description 与粗粒度 capability 调用 `tool.search`。前者是 Reader 写入口所需的高精度局部策略；后者却要求模型先知道不可见工具的内部名字。`book.structure` 同时承担只读结构证据规划和带读路线输入，又与 `reader.gotoLid` 一起落入粗粒度 `Navigation`，导致文档概述被迫经过副作用入口或退化为猜 LID。现有 `BookToolContract.use_when/do_not_use_when` 未进入 Runtime 发现索引，实施顺序见[切片方案](../切片方案-开放自然语言能力发现与Runtime证据拓扑.md)。

### §1 开放语义与有限 TaskNeed

**决策**:穷举系统能力，不穷举用户说法。

**否决**:
- 扩充摘要/概述短语表：同义表达和语言变体无穷，且会把只读概述伪装成带读。
- 为每个用户回合增加独立 LLM 分类调用：增加成本、延迟和新的失败面。
- 让 Runtime 从自由文本直接执行工具：会绕过模型的语义理解与工具取舍。

**命门**:模型通过常驻的小型能力目录和结构化 discovery call 提出 `scope + operation + required_capabilities`；Runtime 以真实 evidence state、content profile、权限和显式副作用意图补全 `TaskNeed` 后解析 `CapabilityPlan`。模型字段不得授予权限、伪造证据状态或把 read-only 请求升级为 Reader 写。`turn_intent_classifier.v1` 只保留为高风险显式带读 bootstrap，不升级为通用自然语言路由器。
**何时回头**:结构化 discovery 仍无法让受支持模型稳定表达 TaskNeed，且请求审计证明独立 planner 的收益大于额外调用成本时。

### §2 能力本体与 Routing Card

**决策**:ToolRegistry 以结构化能力卡完整声明可发现能力。

**否决**:
- 继续只索引 name/description/粗 capability：无法表达适用范围、禁用条件和副作用。
- 为 discovery 再维护一份手写工具目录：会与 schema、handler 和 BookToolContract 漂移。
- 继续以 `Navigation` 大桶标注结构、路线与 Reader 写：风险和用途无法分层。

**命门**:最小 capability 本体至少区分 `Discovery | SourceRead | LexicalLocate | SemanticEvidence | StructuralIndex | Synthesis | NavigationPlan | ReaderRead | ReaderWrite`；Routing Card 同源包含 `provides/scopes/operations/use_when/avoid_when/effects/preconditions/content_profiles/relative_cost`。`BookToolContract.use_when/do_not_use_when` 必须进入该卡，工具 schema、handler、权限和 output policy 仍由现有 Registry 单源拥有。
**何时回头**:能力值持续只服务单一工具或出现无法正交组合的 profile 特例时，合并或拆分本体并升级卡片版本。

### §3 按风险暴露而非按导航大类暴露

**决策**:只读结构规划与 Reader 副作用采用不同暴露阈值。

**否决**:
- 把全书概述塞进 `ExplicitGuidedRead`：会错误带出 Reader state、guide path 与 goto。
- 所有导航相关工具永久 Direct：普通局部解释承担无关 schema 和误调用面。
- 模型请求 `reader_write` 即视为授权：模型输出不能替代用户显式意图。

**命门**:`book.structure -> StructuralIndex + ReadOnly`，可作为 technical-learning/paper 的低风险首轮能力或由 document-scope need 高召回激活；`book.guide_path -> NavigationPlan + ReadOnly`；`reader.gotoLid -> ReaderWrite + ExplicitUserIntentRequired`。`source.present` 只在本轮已有证据时占 Direct 名额。能力暴露只改变下一次模型可见 schema，不执行工具或产生 effect。
**何时回头**:请求审计证明 `book.structure` 常驻带来可测错误路由或超出 schema 预算时，改为 Runtime need seed 的高召回激活，但不得重新绑定 ReaderWrite。

### §4 结构化、Unicode-aware 的工具发现

**决策**:`tool.search` 先精确过滤 capability，再用任务文本排序。

**否决**:
- 要求模型把用户问题翻译成 `book.structure`：内部工具名不应成为用户语义接口。
- 只增加中文同义词：形成另一份不完备词表。
- 让自由文本匹配覆盖权限/profile/hidden gate：排序信号不能改变安全边界。

**命门**:discovery 输入至少包含 `task/required_capabilities/scope/effect_mode/max_results`；Runtime 对 capability、profile、effect 和 precondition 做确定性过滤，`task` 只在合法候选内排序。文本检索复用 artifact search 的 Unicode normalization、CJK gram、多字段权重与稳定 tie-break；结果返回 `matched_fields/matched_capabilities/effect_mode/preconditions`，hidden 或无权限工具始终不可见。
**何时回头**:同 capability 工具增多且词法排序无法区分时，可增加受版本控制的 embedding rerank，但 deterministic filter 与稳定 fallback 必须保留。

### §5 LID provenance 与证据计划硬闸

**决策**:Runtime 以定位来源和证据拓扑阻断盲猜 LID。

**否决**:
- 只要 LID 恰好存在就允许读取：会奖励枚举目录和偶然命中。
- 仅靠 prompt 劝模型不要猜：错误路径仍可执行并被 no-progress 误判为进展。
- 把 locator 当作已观察证据：位置元数据不能支撑正文结论。

**命门**:`book.text` 的 LID 必须来自 `TurnLocatorLedger` 的用户明确 LID、已验证选区、Reader anchor、结构/搜索/query/context 结果或先前已验证证据；账本与 `turn evidence ledger` 分离。无用户 evidence 的 section/document synthesis 必须先有结构、搜索或查询产生的 evidence plan。`LID_NOT_FOUND` 后 Runtime 返回 `required_capability=structural_index` 并阻断继续 blind reads，直到合法 locator 注入。
**何时回头**:某类规范 LID 能由公开、可验证的确定性语法安全派生时，可新增 provenance origin，不得开放任意存在性探测。

### §6 阶段进展与最终收敛

**决策**:进展按任务阶段变化计算，不按参数不同计算。

**否决**:
- 每个不同 `book.text(lid)` 都算进展：连续猜 sibling LID 可耗尽循环。
- 工具轮数触顶后直接丢失回答机会：已有证据无法被终答利用。
- 把工具调用次数称为模型循环次数：UI 与真实停机语义不一致。

**命门**:最小阶段机为 `UNLOCATED -> LOCATED -> EVIDENCE_READY -> SYNTHESIZED -> FINAL`；同阶段无新 locator/evidence/capability/effect 的调用不重置 no-progress。最后一个合法工具批次后保留一次 tools-disabled finalization sampling；`TURN_LIMIT_EXCEEDED` 与 active-context、protocol、evidence-gate 错误保持不同错误码。UI 使用“model-tool loop limit”语义。
**何时回头**:真实轨迹出现不能映射到该阶段机的长任务时，仅扩展阶段，不退回参数差异计数。

### §7 英文 Prompt Authoring Policy

**决策**:仓库编写的模型指令与发现元数据统一使用英文。

**否决**:
- 翻译用户问题、选区或书内正文：会改变原始证据和用户语言。
- 把多语言分类短语视为 prompt 残留：分类器兼容数据不是模型指令。
- 只翻 base prompt、不翻工具 description/schema 与 Runtime wrapper：模型请求仍是混合编写语言。

**命门**:Resident base/policy、ad-hoc model system prompt、Runtime 生成的 prompt scaffold、ReAct compatibility instructions、模型可见工具 description 和 schema description 均以英文编写；用户消息、书内证据、引用、memory/profile 值和其他 untrusted payload 保持原文，最终回答继续跟随用户语言。用户界面、日志、错误本地化与 NL classifier literals 不在本策略范围。语义 prompt 变更必须升级对应 asset/replay revision，并由静态 allowlist 审计和请求级测试共同锁定。
**何时回头**:受控评测证明特定模型只在另一种指令语言下可靠时，可由 `ModelRuntimeProfile` 选择完整、版本化的单语资产，不允许在同一资产内临时混写。

### §8 既有 ADR 关系

**决策**:开放 NL 原则保留，闭集只服务高风险 bootstrap。

**否决**:
- 把 ADR-0104 的闭集解释为全局语义路由原则：与 ADR-0036 冲突。
- 删除显式带读 bootstrap：Reader 写入口会失去首轮高精度授权种子。
- 自动执行 Runtime 解析出的能力计划：暴露、调用和副作用必须继续分层。

**命门**:ADR-0036 的“开放 NL、下游闭集结构”继续成立；本 ADR 扩展 ADR-0091 §3 的 deferred discovery 输入与 Registry 元数据；ADR-0104 的 classifier 只种入显式带读所需能力，且不能因结构概述触发 ReaderWrite。任何 Reader effect 仍必须来自已暴露工具的合法调用并通过既有 permission/reducer/proposal 门。
**何时回头**:产品引入用户明确授权的自动巡航模式时另立 ADR，不从只读结构发现边界外溢。
