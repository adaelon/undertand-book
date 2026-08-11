# ADR-0104 Intent-seeded guided-reading tool exposure and resident navigation policy

Status: Accepted, 2026-08-11.
Extends: ADR-0034, ADR-0037, ADR-0044 and ADR-0045.
Revises: ADR-0091 §3 的首轮激活输入与 §4 的主动带读路由边界。
Change type: [边界重构]。

一次显式“带我读某章”的真实回合只走了 `book.search_text -> book.text -> final`，尽管该书的 BookStructure、guide path 与关键停靠点均可用。首轮导航工具被延迟暴露，而导航规则又只在导航工具可见后注入，形成循环依赖。实施顺序见[切片方案](../切片方案-主动带读首轮路由闭环.md)。

### §1 首轮导航能力

**决策**:显式带读意图预激活住户导航能力。

**否决**:
- 只依赖 `tool.search`:首轮看不到带读规则时仍可能直接用通用读取工具收敛。
- 所有回合直接暴露全部导航工具:普通问答持续承担无关 schema 与路由空间。
- 增加一次 LLM 意图分类:把确定性入场问题变成额外成本与新失败点。

**命门**:当前用户原文在首个预算计算和请求计划前经过版本化、高精度、可单测的闭集匹配；命中后按 ToolRegistry 的 `Navigation` capability 加 `reader.state`、`reader.gotoLid` 建立本回合激活集，仍服从 content profile、权限、hidden 与 schema 预算门。受支持模型配置必须证明完整允许组可容纳，不得把半套工具面当成功。
**何时回头**:真实误报/漏报表明闭集措辞不够时升级匹配器版本；不得用自动执行副作用补召回率。

### §2 常驻导航规则

**决策**:导航与带读规则在住户采样中常驻。

**否决**:
- 继续按当前可见工具条件注入:会保留“先看见工具才知道要发现工具”的循环。
- 只把规则写进工具 description:工具不可见时规则仍不可见。
- 恢复单体巨型 prompt:会撤销 ADR-0091 的模块化与请求审计边界。

**命门**:`resident-agent.policy.navigation` 独立于 `visible_tools` 注入 Resident 业务采样；显式带读须在必要定位后读取 Reader 状态与结构路线，校验候选原文，真实 goto 后只讲一个停靠点并停下，不能在 `search_text -> text` 后把整节一次性总结。缺少所需能力时仍以 `tool.search` 作通用回退。
**何时回头**:请求审计证明该小模块对非导航任务造成可测退化时，可缩短措辞但不得恢复可见性条件。

### §3 副作用与表面边界

**决策**:能力预激活与 Reader 副作用严格分离。

**否决**:
- 命中短语后由 Runtime 自动 goto:未经过模型取舍、原文自检与 Reader 命令校验。
- 复用 MCP `book_guide`:访客临时会话与住户 Reader 私有状态属于不同表面。
- 预激活全部 Reader 写工具:高亮、笔记、布局不属于带读入场能力。

**命门**:意图匹配只能改变工具暴露计划，不得调用 dispatch、修改 viewport/memory 或产生 effect；Goto 只能来自模型显式调用已暴露的 `reader.gotoLid`，继续经过当前住户会话、参数校验与既有 reducer/effect 边界。`book_guide` 不进入 Resident 注册表、激活组或轨迹。
**何时回头**:产品新增用户显式授权的自动巡航模式时另立决策，不从本次首轮曝光修复外溢。

### §4 回归证据

**决策**:带读发布同时通过结构回归与真模回放。

**否决**:
- FakeAdapter 预写 `tool.search`:只能证明执行器能跑，不能证明首轮输入已消除循环。
- 只断言 prompt 包含关键词:不能证明工具 schema、轨迹与 Goto effect 同时成立。
- 让模型自评“是否完成带读”:没有确定性判据。

**命门**:确定性测试必须锁定首轮 policy/tool 面、非带读面不膨胀、无预执行 effect，以及无 discovery 的单停靠点导航轨迹；发布门再以真实书与真实模型回放事故提示，结构化断言唯一 `reader.gotoLid` 调用与 Goto effect、目标属于 guide path、无 `book_guide`，且不得在仅 `search_text/text` 后终答。
**何时回头**:更换默认模型、导航 policy 版本、ToolExposurePlan 版本或 guide contract 时重跑真模门并保存新的有界回执。
