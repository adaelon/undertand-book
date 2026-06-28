# ADR-0034 route 作为 Core 导航原语 + 确定性前沿 + 人/访客两投影

## 背景

两个 insight:① agent **主动带人看书**;② 我们的 agent **引导外部 agent** 找到它要的内容。Grill 结论:二者不是两个功能,是**一个确定性 route 机制的两种投影**。承 ADR-0033 的 mechanism/policy 分离——route 是知识图谱(local 边 / long_range 边 [PB3] / discourse 关系 [PB2] / 概念共现)的第一个"多跳导航"消费者。此前图谱只被单跳 `book.context` 消费,从未被"找路"消费过。

## 决策

1. **统一**:一个确定性 `route` 机制 + 两投影(人 / 外部 agent),不各写一套导航逻辑。

2. **确定性边界(命门级)**:`route` **零 LLM**,只保证返回的每个 LID、每条边都真实——这就是"确定性的 LID 由 route 保证"。LLM agent **住在书里**,用 route(+ context/concept/text/synthesize)一组工具,由**意图 + 持续反馈**驱动【何时调、调哪条、下一步去哪、怎么讲】——LLM 不只在末端解释,它是用法策略的主体。机制/策略切在**工具粒度**:route = 地面真相(LID 不会骗人),LLM = 怎么用的策略。

3. **route 形状**:`route_from(at)` **前沿式为内核**;`route_to(from, target)` = 同一批边上跑 BFS 的确定性组合。前沿式撑得起反馈驱动的局部导航(人说"太快/没懂/跳过"→当前位置重问前沿换一步);路径式预算全程,反馈一来即废,故为派生而非内核。

4. **层 + 排序分层**:`route_from` = **Core**,架在 `book.context` 之上(复用 near/mid/far 已投影好的全部边,Core 边与 profile artifact 都从 context 一个口进来,**零层违规**),只做**结构性确定性排序**。**教学性 reorder / 过滤 = technical_learning policy**(+ reader_profile),与 `book.synthesize`「Core + policy」同构(ADR-0033 决策5)。

5. **前沿形状**:`route_from` 返回**按导航语义分的 5 组**,而非一条平铺 ranked list:
   ```
   back       前置/背景   prerequisite, depends_on(向后)
   forward    深入/承接   builds_on, refines, elaborates(向前)
   concretize 例证/具体   exemplifies, applies, answers
   cross      关联/跨章   long_range(analogous/contrasts/supports…) + 概念共现
   continue   顺读       next_sibling / 阅读序
   ```
   `edge_type → 类别` 是固定确定性映射表(Core);组内按 weight × 距离 排序。意图直接落到类别("没懂"→back,"给例子"→concretize)。policy 在"组的取舍/排序"上整形,不重写 route。

6. **人投影控制模型**:默认**逐停靠点确认**——agent 用 route_from 挑下一停靠点 → 真 `reader.goto`(可撤销 `AgentEffect::Goto`,ADR-0030)→ citation-gated 解释 → 停下等人(继续/换路/退回/没懂)。**自动巡航**(连续 goto-讲到打断)为显式 opt-in,不做默认。

7. **世界模型可借、读者不可借**:route 的结构投影对外部 agent **可借**(访客面详见 ADR-0035);读者私人层(reader_profile / memory / viewport)**不可借**。外部 agent 拿**原始 Core 结构 route**(意图中立),人拿 **policy 教学整形过的 route**——同一 Core 内核,两投影各取所需。

## 命门

route 必须**零 LLM** 才守得住"确定性 LID"。一旦让 route 自己吃 NL / 编路线,就重开了 PB3 亲手关掉的"开放式 LLM 自由发现"幻觉门。NL 意图→图谱入口的解析放在 route **之外**(复用 `book.concept`/`book.query`),route 只吃结构化输入。

## 否决

- **route 内部 LLM 规划整条路线**:不可复现、不可单测、路线会幻觉,违 PB3 结论。
- **平铺 ranked list**:丢导航语义,意图驱动退化成"信分数",policy 整形失去抓手。
- **profile-aware 焊进 route 内核**:外部 agent 被迫吃我们的教学偏见 + reader_profile 渗进 Core,破 ADR-0033。
- **默认自动巡航**:方向盘默认交给 LLM,撤销沦为事后补救,违"用户终裁"红线。

## 何时回头

- 5 类导航类别是否够用(实测 `edge_type→类别` 覆盖率,有无落不进 5 类的边)。
- 结构排序 weight × 距离 的权重(占位,实测回填)。
- 默认逐停靠点是否太碎(实测带读体验,可能调成"几步一确认")。

## 影响

- `route` 是**新 Core 导航原语**;具体命令面落点(`book.route`? 还是 runtime 内部)与命名 **OPEN**,实现前 A1 再定。
- 人投影"主动带读"在切片 **P3** 消费它(本 ADR 触达 P3)。
- 外部 agent 投影 → **P7 访客面**,详见 **ADR-0035**(连接式访客会话)。
- 不改 ADR-0033 正文;本 ADR 是其 mechanism/policy 分离在"导航"维度的延伸。
