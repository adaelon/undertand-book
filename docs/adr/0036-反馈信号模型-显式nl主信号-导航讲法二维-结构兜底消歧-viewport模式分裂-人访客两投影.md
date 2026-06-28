# ADR-0036 带读反馈信号模型 —— 显式 NL 主信号 + 导航/讲法二维 + 结构兜底消歧 + viewport 模式分裂 + 人/访客两投影

## 背景

ADR-0034 决策6 把人投影带读定为"挑停靠点 → goto → citation-gated 解释 → **停下等人**(继续/换路/退回/没懂)";ADR-0035 把访客带读定为"refine（不对）→ route + ③ 收敛"。两者都把"反馈"当作循环的转向输入,但**反馈信号本身是什么、怎么落到 route**留为 OPEN①。本 ADR 关掉它。无眼动;候选曾是 用户消息 / viewport 偏离 / memory / quiz。

## 决策

1. **显式 NL 提问 = 唯一主信号**:带读 loop 本就"停下等人",反馈 = 用户在停靠点的**下一句自由提问**。viewport 偏离 = **弱旁路**(见决策5),memory/reader_profile = **慢先验**(policy 整形,ADR-0034 决策4),quiz **留后**(无基建,且 quiz 是主动探测非被动反馈)。零行为推断,守用户终裁。

2. **反馈意图二维 + 开放 NL,不立闭集词表**:
   - **导航轴**(去哪)→ 落 `route_from` 的 5 类(back/forward/concretize/cross/continue)。
   - **讲法轴**(怎么讲/多细/重讲)→ 落 technical_learning policy 讲法层(复用 `book.synthesize` 调表达 + reader_profile),**不动 route**。
   - 信号是**开放 NL 提问**,不是 token 枚举。agent(住书里的 LLM)读提问语义,产出**结构化选择 `{轴, route 类别, 可能的 target 概念}`**;提问带 locus 时直接定轴定类("给例子"→concretize、"这跟反向传播啥关系"→cross + target),`target` 经 `book.concept`/`book.query` 解析入口 LID(ADR-0034 命门,在 route 之外)。
   - "继续/换路/退回/没懂"只是**例子**,不是用户必须说的枚举;闭集只在下游(NavCategory=Core、讲法动作=policy),用户面是开放 NL。

3. **裸信号"没懂"= 结构收窄 + 可撤销提议 + 二次信号升级,不靠 LLM 神判**:仅当提问无 locus("没懂""看不明白")才触发:
   ```
   back = route_from(at).back;  unvisited = back ∩ reader 未读前置(历史过滤)
   unvisited 为空      → 歧义消解为讲法轴:原地讲细/换讲法(零位移、可撤销),不反问
   unvisited 非空      → 歧义真存在:重讲 + 可撤销提议「先回看 X(前置)?」,用户终裁
   重讲后再次「没懂」   → 二次信号,升级走 back
   ```
   歧义不靠"两字神判",靠确定性结构砍可能性 → 砍到 1 个直接做、砍不到让用户裁、还不行靠下一个信号升级。

4. **人/访客 = 同骨架两插槽 + 终裁者不同**:决策2/3 的骨架对两投影同一,只换两个插槽:
   | | 人(住户) | 访客(外部 agent) |
   |---|---|---|
   | 历史来源插槽 | ② viewport + memory（durable 跨会话） | ③ cursor.last_frontier + transcript（ephemeral 本会话） |
   | 讲法整形插槽 | reader_profile 个性化 | 无 → 中立结构重述(讲法轴近乎塌缩,外部 agent 自读原文) |
   | 终裁者 | 用户 → 可撤销提议、等人选 | 访客自身 → "不对"即指令,直接换前沿分支,无提议-等待 |
   闭合 ADR-0035"访客=临时住户 lite":同一机制,非两套逻辑。

5. **viewport 偏离角色随模式分裂**:
   - **默认逐停靠点(turn-based)**:每回合开头读 `reader.state()`,`at = viewport.anchor_lid`——若偏离上次停靠点 = 用户自己导航走了 → **静默 re-sync**(rebase `at` 跟脚,不问、不打扰;透明度靠答案 citations 自带)。这是**跟随用户已做的导航**,非 agent 自动改路。
   - **自动巡航(opt-in)**:每步 goto 前读 state(),anchor 被用户挪走 = 用户用滚动**打断巡航** → 停巡航 + 问一句。"问"仅归属此处,是对用户主动打断的响应,非凭空骚扰。

## 命门

route 内核**全程零 LLM**:LLM 只把 NL 提问识别成 `{轴+类别+target}` 这个结构化选择,**不产路、不产 LID**;真 LID 由 `route_from`/`book.concept` 确定性给出。消歧同理——不让 LLM 对裸信号一次猜准,靠结构收窄 + 用户终裁 + 二次信号。一旦让 LLM 据反馈自由编路或自动改方向,就重开了 ADR-0034 关掉的幻觉门、破了用户终裁。

## 否决

- **隐式行为推断作主信号(viewport 偏离自动改路)**:viewport 偏离语义不明(找东西?跳过?回看?),自动改路 = 弱代理误读直接改方向,违用户终裁。
- **一维(全塞 route 5 类)**:"太快/讲法"不是空间导航,原地讲细 ≠ 跳别处,硬塞污染 route 纯空间语义。
- **立闭集反馈词表**:用户面应是开放 NL;词表化丢语义、逼用户学黑话,且 locus 信息(第几项、为什么)无处承载。
- **裸"没懂"靠 LLM 一次猜准轴**:两字信息量不足,必有系统性误判(把只需重讲的硬拽回前置)。
- **默认模式主动问"要我跟过去吗"**:turn-based 不该无故开口,主动问 = 打扰;"问"只在 opt-in 巡航被打断时出现。

## 何时回头

- 讲法轴对访客是否真完全塌缩(实测外部 agent 要不要中立重述)。
- viewport re-sync 的"偏离"判定:完全跟随 vs 仅大跳(跨章)才 rebase(占位,实测回填)。
- 二次"没懂"升级 back 前要不要先插一次反问。
- quiz 作为**主动探测**信号何时引入(与被动反馈正交,v1 留后)。

## 影响

- **P3**(人带读)判据加:消费 NL 提问→`{轴+类别}`、裸信号走结构兜底(`route_from.back ∩ 未读前置`)、viewport 静默 re-sync;"未读前置"的历史过滤在带读 loop/policy 层消费 ②,route 只给 back 组。
- **P7**(访客向导)判据加:访客反馈用 ③ 历史(`cursor.last_frontier`)、讲法轴塌缩为中立重述、访客自身终裁(无可撤销提议环节)。
- **P8**(route Core)不变:`route_from.back` 组本就在 5 类里;"未读"过滤不进 route 内核(消费历史在上层),route 零 LLM 不破。
- 不改 ADR-0034/0035 正文;本 ADR 是其"反馈维"的延伸。
