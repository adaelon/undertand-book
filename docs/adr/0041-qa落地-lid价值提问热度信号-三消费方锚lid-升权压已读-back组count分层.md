# ADR-0041 qa 落地:qa = LID 价值/提问热度信号(读者私人)+ 三消费方锚 LID + 升权压已读 + back 组 count 分层

状态:已接受(2026-06-29,P4 qa 落地 §0.5 grill;回收 P4-2 `puzzle_lids` 恒空缺口)

## 背景

`qa` 自切片0 地基(`[ADR-0015]` type 闭集 / `[ADR-0018]` 来源三分)即设计为 ① 确定性账本的一类,`[ADR-0038]` 重定位后仍保留(① 无 LLM 直存,note/highlight/qa)。但 **P4-2 实现 `derive_reader_profile.puzzle_lids` 时,消费方(疑惑点维度)先于生产者就位** —— 没有任何地方 `save type=qa`,puzzle_lids / reader-profile.md「卡点」段恒空。P4 qa 落地前 grill,需求方层层逼问"账本怎么用",暴露三个根问题并逐一拍板:① qa 到底反映什么;② 只记 LID 则问题文本无消费方;③ 消费方具体怎么做。

## 决策

1. **qa = LID 价值/提问热度信号(读者私人 ②),非"问答 dump"**:某 LID 被问得多 = 对**这个读者**更值钱(更难/更关键/更想懂)。是 `[ADR-0035]` ② 读者私人记忆,**不写 book base、不跨读者聚合**。"哪段所有人都问 = 书内在价值"属 ① 世界模型,需跨读者聚合 + 撞 ② 不外借红线,**另开、不在本刀**。

2. **触发 = agent 用 `book.query` 答书内问题后存 qa**:"实质问题"无确定性判据(本质 agent judgment,承 `[ADR-0039]` context 同款"judgment 触发 + 事实存储"),但用**"是否需要 `book.query` 去答"**做近确定性兜底——需 query 答的 = 书内容实质问题 → 存 `memory.save(type=qa, anchor_lid=<query 的 anchor>, content=<用户原问题>)`;操作/闲聊/元问题不触发 query,自然不记。承 P3-1"停靠点 LID 只能取自工具返回"同招:确定性工具产物兜底,LLM 只做轻分类。

3. **存问题文本(qa = 真问答记录,非 LID tick)**:只存 LID 则问题语义永久丢失。content 存用户原问题,不同问题 = 不同 record(内容寻址),heat = **该 LID 的 qa 记录条数**。

4. **三消费方全部锚 `anchor.lid`**:
   - **lid→count → 确定性 back 组升权**(`technical_learning_reorder`,零 LLM,见决策5/6/7)。
   - **lid→问题文本 → LID-local recall**:agent 到/答某 LID 时 `memory.recall(lid, type=qa)` 拿该 LID 历史提问("你之前在这问过…")。复用现有 recall lid+type 过滤,**零新机制**;prompt 引导。
   - **lid→问题文本 → 透明展示**:`reader-profile.md` 卡点段渲染真实问题 + count(承 `[ADR-0040]` 已有 text 渲染模式)。

5. **升权压已读(asked overrides read)**:back 组内排序 Tier A 问过(卡点)/ Tier B 未读+没问过 / Tier C 读过+没问过(已读降权沉底)。**卡点 = 读过+问过冒顶**——不压过已读,qa 形同虚设(卡点天然是读过的项)。qa 量 difficulty/engagement,比已读量的 exposure 是更强的回看信号。

6. **作用面 = 仅 back 组(v1)**:back(回看前置)是 qa 升权唯一无歧义正确处,且完整兑现卡点-回看用例。`continue` 升权违顺读语义(问过的旧点压未读新点),`forward`/`concretize`/`cross` 无具体用例驱动(投机)。已读降权 uniform 5 类 vs qa 升权 back-only 的不对称由语义不同证成(看没看过 all-类降权 / 卡没卡住只 back 升权)。与 P3-2 `unvisited_back`(back ∩ **未读**)互补:一捞没见过、一捞卡住了。

7. **count 分层 lexicographic,不 blend**:Tier A 内 count 降序为主键、现有 `weight×距离` 仅 tiebreak。结构信号(边权×跳距)与行为信号(问几次)**不可公度**,乘/加进单一 score 需拍脑袋汇率 λ、难单测难解释;分层确定性可单测、可一句话解释。

## 命门

count 是**读时**从已完成账本排序卡点,**非写入触发闸**——区别于 `[ADR-0039]` 否决的"确定性计数器触发写记忆"。一旦 count 退化成"问 N 次才记 qa",就重开 ADR-0039 否决的机械阈值。qa 写入永远靠 agent judgment(决策2),count 只在读时给已存的卡点排序。

## 否决

- **qa = 跨读者聚合的书内在价值**:撞 ② 读者私人不外借红线(`[ADR-0035]`),单机也无多读者可聚;另开 + 先过红线。
- **只存 LID 不存 content**(heat=usage.count):语义消费方(LID-local recall / 透明展示)失生产者,qa 退化成提问 tick,薄到不值一刀。
- **布尔口径(问过 vs 没问过)**:丢掉"问得多=更卡"的频次信号,与"qa=价值热度"自相矛盾。
- **blend 权重进单一 score**:不可公度 + 拍脑袋 λ + 难测。
- **全 5 类升权**:`continue` 升权违顺读;`forward`/`concretize`/`cross` 投机。
- **未读永远排第一(qa 只在 tier 内排)**:卡点天然读过,会永沉未读之下,回看用例失效。
- **全局冷启动 recall dump**:LID-local recall(到 LID 才看其 qa)更聚焦、且免费(recall lid 过滤现成)。

## 何时回头

- count 噪声(3 次 vs 2 次是否真有意义)实测;是否需把 re-ask 的 `usage.count` 也加权进 heat。
- back 不够时再开 `concretize`/`cross` 升权(组间个性化另立项 + §0.5)。
- 跨读者"书内在价值"(多读者/云端场景出现时);届时设计 ① 世界模型侧聚合,不退回污染 ②。
- `reader-profile.md` 卡点段体积膨胀 → 承 `[ADR-0040]` usage/时间裁剪(不复活计数器做触发)。

## 影响

- **回收 P4-2 缺口**:`puzzle_lids` 恒空 → qa 落地后填充;派生物 `ReaderProfile.puzzle_lids: Vec<String>` → **`puzzle_heat: BTreeMap<String, u32>`**(lid→qa 记录条数)。
- **切片方案 P4** 加 qa 落地 A4 两子刀:**qa-1 生产**(save 引导 + enum + puzzle_heat + derive 聚合)/ **qa-2 消费**(back 组升权 + reader-profile.md 渲染问题 + LID-local recall prompt)。
- 修 **CONTEXT**「记忆 consolidation」(qa 落地 = 价值热度 + 三消费方)+ 新增「qa 提问热度 / LID 价值信号」术语。
- 承 [[ADR-0015]](qa type / recall)/[[ADR-0030]](recall 冷启动)/[[ADR-0034]][[ADR-0037]](教学整形 reorder)/[[ADR-0038]](① 账本 / ② 读者私人)/[[ADR-0039]](judgment 触发,count 非写闸)/[[ADR-0040]](透明 .md 渲染);守 [[quality-over-speed-correct-context]](事实热度非推断、确定性消费可单测)。
