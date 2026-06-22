# ADR-0016 自建最小运行时(议题7 第一叉):双层 loop + 内层混合驱动 + 档位同轴 + 合一轮确定性验停 + 薄 ModelAdapter + 双重停机

状态:已接受(2026-06-22,工程层 grill 议题7 第一叉共识)

## 背景
议题7(自建最小 agent 运行时)。[[ADR-0005]] 定 E = 读时书 agent,心脏是"自建最小 agent loop(工具调用+记忆),弱后端退 ReAct",是 U-A 没有、本项目净新部分。[[ADR-0014]] 把 LLM 命令(`book.query/synthesize`)定义为"运行时被无状态调一次的暴露",其精确签名移入本议题与运行时同处设计。本叉钻**最小 agent loop 形态**:分层结构、内层外扩驱动、判停接口、弱后端退化、外层停机。最高原则(memory `quality-over-speed-correct-context`)贯穿:正确性优先,只喂确定性事实 + 真原文。

## 决策
1. **双层嵌套 loop**:
   - **外层** = E 的会话级编排 loop(有状态:messages + memory),LLM 自主调三命名空间命令(book/reader/memory,含 `book.query/synthesize`);管多跳编排 + 会话态 + 主动策略([[ADR-0005]] 真增量)。
   - **内层** = `book.query` 自含的**无状态** mini-loop,被外层当一个工具调一次;**裸调即得完整答案**([[ADR-0014]] 基线),不依赖 E。
2. **内层混合驱动**:确定性档位骨架管"捞什么"(scope 阶梯沿图谱确定性遍历捞 LID + 真原文),LLM 管"够不够 + 答什么"。呼应 B2(确定性检索 ⊥ LLM 语义判定)。
3. **scope/granularity 同轴半径统一**:`book.query` 的 scope 四档(`local/chapter/cross_chapter/global`)与 `book.context` 的 granularity 三档(`near/mid/far`)reduce 到同一批已固化图谱原语([[ADR-0013]]:树邻接 / local 边 / 概念二跳 / long_range 边 / 子树范围),只是**截断半径粗细不同,非两套真相**。near/mid/far = 半径轴三个具名点,scope 四档 = 同轴更粗的检索广度档。
4. **内层合一轮 · 条件产出 + 确定性交叉验停**:每轮 `LLM(q, 证据集)` → `{sufficient, answer?, citations?, model_supplement?}`;不充分轮轻量(只判停 + 缺啥提示),充分轮产 answer+citations。骨架**确定性校验 `citations ⊆ 证据集 LID 全集`**([[ADR-0004]] 结构红线读时落地)。**早停防护**:声称 sufficient 但零有效 citation → 不信、强制外扩;**晚停兜底**:`scope==global` 触顶。
5. **统一 loop 骨架 + 薄 ModelAdapter 分轨**:loop 控制(档位推进 / 停机 / citations 校验)**provider 无关恒定**;仅 `complete(messages, tools?, schema?) → ParsedResponse` 两实现——**NativeAdapter**(原生 tools API + JSON mode)/ **ReActAdapter**(注入 ReAct/JSON 模板 + 解析文本回填同一 ParsedResponse)。结构红线靠确定性 citations 过滤,弱后端乱吐 LID 也滤净、**100% 守**([[ADR-0004]]),弱后端只语义质量低(逐后端度量),碰不到引用真实性。
6. **外层双重停机 + 诚实标不完整**:正常停 = LLM 给最终答(无工具请求);硬闸 = `max_turns` + 累计 token 预算;触顶返 `{answer: 部分答, warning: CONTEXT_BUDGET_EXCEEDED, incomplete: true}`([[ADR-0015]] budget category),**不静默截断 / 不假装完整**。

## 命门
- **双层是 [[ADR-0005]]+[[ADR-0014]] 的必然**:`book.query` 须自含完整 loop(否则裸调不完整),E 又须在其上编排(否则无增量)。
- **混合驱动各归其位**:检索"可复现 / 不漏捞"归确定性,语义"充分性判定 + 作答"归 LLM;纯 LLM 自主外扩会漏捞(违正确性),纯确定性判停判不准语义充分性([[ADR-0014]] 深/快涌现需语义信号)。
- **"零有效 citation → 强制外扩"** 把充分性从纯 LLM 自评拉回部分确定性锚定——有无真 LID 支撑确定性可验,堵住混合驱动的早停漏洞。
- **薄 adapter 保 provider 无关行为骨架**([[ADR-0003]] §7.4):弱后端只改输出解析方式,loop 行为恒定;结构红线后端无关恒守([[ADR-0004]])。

## 否决
- **单层纯 LLM 自主**(E 与 query 共用 loop、无确定性外扩骨架):该捞哪些 LID 交 LLM → 漏捞,违正确性。
- **双层但内层零 LLM 判停**(确定性 `enough()` 外扩):证据充分性是语义判断,确定性启发式判不准(简单问烧 global / 复杂问早停),违 [[ADR-0014]]。
- **scope/granularity 两套独立体系**:同源却两套真相,易漂移、双倍维护。
- **内层分两轮**(判停轮 + 作答轮):判停轮无作答压力易虚报"够了",且多一次往返。
- **内层每轮全答 + LLM 自评 confidence**:外扩轮作废 answer 浪费;confidence 自评近 B2 红线(AI 输出+AI 评分自循环)。
- **两套独立 loop 实现**(原生 / ReAct 各一):行为漂移,违 provider 无关骨架,双倍维护。
- **只支持原生 tool-calling**:违 [[ADR-0005]](须退 ReAct)+ [[ADR-0003]](用户自选含纯 completion 后端如 Ollama)。
- **外层只 act.final 无硬闸**:LLM 绕圈无限烧用户自费后端([[ADR-0003]]),无终止保证。
- **外层固定步数无早停**:简单问也跑满,违 [[ADR-0014]] 深/快涌现。

## 何时回头
- 切片0 实测填:外层 `max_turns` + 累计 token 预算;内层各 scope 档检索体积上限;ReActAdapter 解析失败重试/降级策略。
- **议题7 第二叉**定 `book.query/synthesize` 精确签名与分工(synthesize 与自含外扩的 query 若无法清晰分工 → 评估并入 query,承 [[ADR-0014]] 何时回头)。
- 若实测 ReActAdapter 在某弱后端结构化解析失败率过高 → 评估更强约束 prompt / 重试,**不回退到两套独立 loop**。

## 影响
- **回填 V3**:§5.2(自建最小运行时 → 双层 loop 形态展开)、§4.1 `book.query`(内层 loop 机制 + scope 同轴)。
- **新增 CONTEXT 术语**:最小 agent loop(双层运行时)、ModelAdapter(provider 适配 / 原生·ReAct 分轨)、scope-granularity 同轴半径。
- **承**:[[ADR-0005]](E 自建运行时)/ [[ADR-0014]](LLM 命令=运行时暴露、book.* 叶子工具、边作召回路标)/ [[ADR-0013]](三档图谱原语)/ [[ADR-0004]](结构红线)/ [[ADR-0003]](provider 无关)/ [[ADR-0015]](budget 错误 + 诚实不降级)。
- **议题7 续**:第二叉(query/synthesize 精确签名)、第三/四叉(memory 两阶段 consolidation + 分层渐进披露产物)。
