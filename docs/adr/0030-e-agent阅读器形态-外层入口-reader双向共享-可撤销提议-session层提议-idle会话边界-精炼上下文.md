# ADR-0030 E agent 阅读器形态:前端对话主入口=外层 E / reader 双向共享 / agent 动作=可撤销提议(前端层)/ session 层提议态 / 用户控制会话边界 + 精炼上下文

状态:已接受(2026-06-24,§0.5 领域对齐 Grill 共识;补 [[ADR-0028]] 未覆盖的「agent 在阅读器中的形态」)

## 背景
切片1 前端方案(S10a–e)只接了内层 `book.query`(单次无状态问答),而 V3 §5 的**外层 E 编排 loop**(`runtime::orchestrator::run`,会话级有状态、多跳、带 memory、能驱动 reader、S7 已测「问→跳转→高亮→记笔记」闭环)**从未进入阅读器**。且 `orchestrator::run` 内部 `Reader::new(book, …)` 自建临时 reader(锚在书首)——与 server `AppState` 持的前端 reader 不是同一个,ADR-0028 决策5「每轮把 viewport 喂 agent」无落地路径。用户进一步提出核心产品契约:**agent 对阅读器/标注的修改应是可撤销的提议、用户终裁,且查询踪迹对用户可见**。本 ADR 定 agent 在阅读器中的形态。最高原则贯穿(memory `quality-over-speed-correct-context`):agent 不擅自改变用户的视图与长期记忆。

## 决策(§0.5 三问 + 框架共识)
1. **前端对话主入口 = 外层 E agent**:`POST /agent/chat` → `orchestrator::run`(会话态 messages、自主多跳调三命名空间)。内层 `book.query` 退为 agent 的工具(可保留 `/book/query` 轻量端点旁路)。否决"主入口接内层 book.query"(丢 E agent 全部增量:多跳/会话态/主动策略/memory/驱动阅读器)。
2. **reader 双向共享**:改 `orchestrator::run` 签名,**删内部 `Reader::new`、改 `reader: &mut Reader` 注入**(与 `store` 对称注入);server `Mutex<AppState{book,store,reader}>` 把同一 reader 注入 `/agent/chat`。agent 看到并驱动用户眼前的视口——兑现 [[ADR-0028]] 决策5 + S7 闭环。否决 agent 自建临时 reader(位置不同步)/ 单向 seek 快照(agent 的 reader.* 前端看不到,闭环断)。
3. **agent 动作 = 可撤销提议,落前端交互层**:agent **真执行**(守 [[ADR-0007]] 人机对称——命令面无特供),前端用 `[ADR-0015]` 的 effect 返回做**反向命令** undo(goto 回原 anchor / `memory.delete(id)`)。`OuterOutcome` 加 `effects[]`(本回合副作用:goto 前后 anchor、highlight/note 的 id)+ `trace[]`(tool_calls 序列)两字段——**runtime 内部结构,非冻结命令面,向后兼容**。**提议单元 = 一次对话回合**(`/agent/chat` 一次调用的全部副作用)= 事务性 undo。否决后端 staging 暂存(破对称+重)/ memory 加 provenance 字段(把"提议"烤进持久真相层)。
4. **agent 提议标注落 `session` 层,确认升 `long_term`**:复用 V3 §5.3 memory 两层(会话工作记忆/长期记忆),**零新字段**。用户自己标注直接 `long_term`(现状不变);agent 标注 `layer=session`(临时提议),用户「保留」→ 同记录 `memory.save` 为 `long_term`;未处置走人 → session 不持久(不污染长期记忆)。
5. **五动作落地**:**goto**→一键返回回合前 anchor;**highlight/note**→提议态、询问保留(否则不升级);**回答**→**分屏**(左阅读区 ‖ 右对话区)+ 对话末「凝练成笔记」(`memory.save` note,content=对话摘要)/「丢弃」(不存);**查询踪迹**→`trace[]` 前端可见(`book.query` 检索范围 + citations 链)。
6. **会话边界 = 用户显式控制**:用户点「新对话」手动清 `messages`,**不做 idle 时间戳自动判定**(简化——阈值难调,且对话会话边界本不必与后台记忆抽取边界同源)。**新会话冷启动上下文 = memory recall 兜底**(note/highlight/position),让 agent 记大局、不被全量 messages 细节淹没注意力;完整"轨迹摘要 / reader-profile 常驻上下文"= [[ADR-0018]] consolidation 四层产物,**留 consolidation 刀(切片1+)**,接口"可扩展就绪"。否决 idle 自动判定会话边界(复杂、与 Phase1 记忆抽取边界耦合反绕)/ messages 无限累积(注意力稀释+token 炸)/ 把 consolidation 塞进前端刀。

## 命门
- **可撤销但真执行**:守命令面人机对称([[ADR-0007]]),可撤销是 UI 处置权、非后端真相分裂;effect 返回([[ADR-0015]])恰好就是 undo 所需的反向命令材料。
- **session/long_term 天然承载"提议/确认"**:不发明新状态字段,提议=会话工作记忆、确认=长期记忆。
- **对话会话边界与记忆抽取边界解耦**:对话会话由用户手动「新对话」控制(交互意图),Phase1 记忆抽取仍按 [[ADR-0018]] idle/关书/退出(后台流水线)——各自独立,不强行统一。
- **愿景与切片边界**:完整"轨迹摘要常驻"依赖 consolidation;切片1 `memory.recall` 兜底、接口就绪,不把 consolidation 拖进前端刀。

## 否决
- 主入口接内层 book.query(决策1)。
- agent 自建临时 reader / 单向 seek 快照(决策2)。
- 后端 staging 暂存 / memory 加 provenance 字段(决策3)。
- idle 自动判定会话边界 / messages 无限累积 / consolidation 塞进前端刀(决策6)。

## 何时回头
- 是否给「新对话」补一个 idle 软提示(默认纯手动,实测定)。
- 跨会话 messages 累积上限 / 截断策略。
- 轨迹摘要常驻上下文:consolidation 刀长出后接入(替换 memory.recall 兜底)。
- 提议确认 UX:逐条 vs 整回合事务、agent 翻页的视觉明示方式(实测)。

## 影响
- **改 runtime**:`orchestrator::run` 签名(注入 `reader`)+ `OuterOutcome` 加 `effects[]`/`trace[]`。
- **新增 server `/agent/chat` 端点**(切片1 补子切片)。
- **前端 agent 形态 UI**:分屏 + 提议确认/undo + 凝练成笔记/丢弃 + 踪迹展示(切片1 补子切片)。
- **关联优化项③**(`docs/参考对照-文档世界状态-优化登记.md` §B):查询踪迹可见 = ③ 的 agent 维度落地。
- **切片归属**:并入「切片1 前端阅读器」刀(补 S10f 后端 / S10g 前端),非独立刀。
- **承**:[[ADR-0028]](前端架构,本 ADR 补其 agent 形态)/ [[ADR-0007]](人机对称)/ [[ADR-0015]](effect 返回·标注单源·错误信封)/ [[ADR-0016]]·[[ADR-0026]](双层 loop·orchestrator)/ [[ADR-0005]]·[[ADR-0006]](E agent·memory 两层)/ [[ADR-0018]](consolidation·idle·四层产物)/ [[ADR-0011]](边作召回路标)/ V3 §5 + §6.1(契约冻结)。
