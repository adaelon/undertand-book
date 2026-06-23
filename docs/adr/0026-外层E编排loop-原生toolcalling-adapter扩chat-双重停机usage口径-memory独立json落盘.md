# ADR-0026 外层 E 编排 loop 落地(议题7 第三叉):原生 tool-calling + ModelAdapter 扩 chat + 双重停机 usage 口径 + memory 独立 JSON 落盘

状态:已接受(2026-06-23,切片0 S6 开工前 §0.5 对齐)

## 背景
[[ADR-0016]] 定双层 loop 形态,把外层 = E 会话级编排 loop(messages+memory、LLM 自主调三命名空间命令、双重停机)留作运行时设计;[[ADR-0025]] 落了内层 `book.query` mini-loop(`ModelAdapter::complete → ParsedResponse`)。S6 落外层 loop 切片0 最小版(Rust,`crates/runtime`),复用 `runtime::query` 当内层工具之一、复用同一 `ModelAdapter`/`NativeAdapter`。本 ADR 记四处工程决策:tool-calling 协议、adapter 扩法、双重停机 token 口径、memory 落盘形态。切片0 工具集 = `book.*`(query+4 叶子工具)+ `memory.save/recall`;**reader.\* 留 S7**;Phase1/2 consolidation、跨书、主动策略留切片1+/议题7。

## 决策
1. **外层 tool-calling = 原生 `tools`/`tool_calls`(NativeAdapter)**:走 OpenAI-兼容端点 function-calling——请求带 `tools` schema,模型吐 `assistant.tool_calls`,执行后追加 `role:tool` 结果(`tool_call_id` 配对)再请求下一回合。切片0 **砍 ReActAdapter**(范围矩阵),弱后端兜底留切片1+。承 [[ADR-0016]] 决策5(NativeAdapter 先行)。
2. **`ModelAdapter` 同 trait 加 `chat` 方法**:`chat(messages:&[Message], tools:&[ToolSpec]) → AssistantTurn{text?, tool_calls[]}`,与内层 `complete(CompletionRequest)→ParsedResponse` **并存不动**。`NativeAdapter` 同时实现两者(同一 `/chat/completions` 端点、两种请求形,共享端点配置)。loop 控制 provider 无关恒定,只经 `complete`/`chat` 触模型(承 [[ADR-0016]] 薄 adapter)。`messages` 模型 = `Vec<Message>`,role∈{system,user,assistant,tool},assistant 带 `tool_calls`、tool 带 `tool_call_id`+content。
3. **双重停机**:正常停 = 模型回合无 `tool_calls`(给最终答);硬闸 = `max_turns` 计数 **∨** 累计 `usage.total_tokens` 超 `TOKEN_BUDGET`(每回响应的 usage 真实权威值累加;某后端不返 usage 则退回确定性 `estimate_tokens` 兜底)。触顶返 `{answer:部分答, incomplete:true, warning:CONTEXT_BUDGET_EXCEEDED}`([[ADR-0015]] budget),**不静默截断/不假装完整**。`max_turns`+`TOKEN_BUDGET` 切片0 占位,实测回填 [[ADR-0016]]。
4. **memory 独立 JSON 落盘 + 来源不降级回喂**:
   - **落盘**:用户级目录单 JSON(默认 `~/.understand-book/memory/memory.json`,env 可覆),存 `Vec<Record>` 跨书,`save`=按 `mem_id` upsert 整文件重写、`recall`=线性过滤。**与只读基座 `.understand-book/<book_id>/` 物理隔离**([[ADR-0006]] 用户私有·跨书·隔离)。SQLite/git-text/两阶段 consolidation 留议题7([[ADR-0018]])。
   - **记录模型**:符 V3 §4.3 / [[ADR-0015]];切片0 type∈{note,highlight,position},`mem_id` 调用方传则 upsert、不传则 `mem_{hash(book_id|type|anchor_lid|content)}` 内容寻址确定性生成(同笔记两存=同 id 幂等去重)。
   - **citation 自动派生**:note/highlight 若未给 `citations`,自动 `citations=[{lid:anchor.lid, book_id}]`,兑现「recall 带可验证 LID citation」(引用红线延伸 [[ADR-0004]]/[[ADR-0015]])。
   - **recall 维度切片0**:`book_id`+`lid`+`type`+`layer` 精确 + `text` 子串;**`concept` 维度留切片1+**(跨书概念对齐 [[ADR-0006]],S6 不做跨书)。
   - **工具错误回喂不降级**:任一工具(含 memory)报错(如 `LID_NOT_FOUND`)→ `ToolError` 信封原样作 `role:tool` 结果回喂,LLM 见 recovery hint 自纠;系统**永不自动套用 recovery**([[ADR-0015]] 禁宽松降级)。

## 命门
- **chat 与 complete 并存而非替换**:内层 query 的合一轮 JSON 契约(`OUTPUT_CONTRACT`)与外层多轮 tool-calling 是两套请求形,强行合一会污染内层确定性验停;同 trait 并存让一个 adapter 对象贯穿两层、端点配置不重复(承 [[ADR-0016]] 薄 adapter)。
- **token 口径用真实 usage** 优于自估:外层多轮累计的是真实计费消耗,`estimate_tokens` 只兜底无 usage 的后端;触顶判定锚在真实值,诚实 incomplete 才有意义。
- **memory 物理隔离是 [[ADR-0006]] 硬不变式**,切片0 不做跨书但隔离现在就守(落用户级目录、不进 per-book 只读基座);否则 S7+ 跨书/迁移返工。
- **工具错误回喂 = 禁宽松降级在外层 loop 的落地**:不替 LLM 决定,只回喂信封+hint(承 [[ADR-0015]]/[[ADR-0011]])。

## 否决
- **外层用 ReAct 文本协议**:切片0 范围矩阵已砍;文本解析脆、与原生 function-calling 双倍维护,弱后端兜底留切片1+。
- **另起 `ChatAdapter` 独立 trait**:NativeAdapter 要实现两 trait、端点配置重复或得另抽底层结构,收益不抵(同一端点两请求形,同 trait 加方法更省)。
- **token 口径纯 `estimate_tokens`**:与真实计费偏差,触顶判定不准。
- **memory 落 `.understand-book/<book_id>/`**:违 [[ADR-0006]] 物理隔离 + 撞跨书。
- **memory 切片0 上 SQLite**:加 rusqlite(C 编译)重依赖、测试建临时 db,对 save/recall 最小验证偏重(serde_json 已在依赖)。
- **mem_id 用 uuid**:不可复现,违 A2 确定性单测;内容寻址既确定又幂等去重。
- **工具报错静默返最近邻 / 自动套 recovery**:毒化引用准确率([[ADR-0015]] 体检 §14)。

## 何时回头
- 外层 `max_turns` + `TOKEN_BUDGET` 实测回填 [[ADR-0016]](切片0 占位)。
- **glm-5.1 是否稳定支持原生 `tools`/`tool_calls`**:S6b 首次真跑实测(同 [[ADR-0025]] S5b 模式,真实 LLM 走人工验不入自动测);若 function-calling 不稳 → 加强约束 prompt / 评估开 ReActAdapter,不回退双套 loop。
- memory consolidation(Phase1/2)+ 四层产物 + 遗忘 + 跨书 recall:议题7 续 / [[ADR-0018]]。
- recall `text` 子串过窄(无语义召回)→ 切片1+ 评估词法/向量(守 [[ADR-0002]] 砍向量基调,先词法)。

**S6c 真跑回填(2026-06-23,glm-5.1 经 `.env` OpenAI-兼容端点,书 `game-programming-patterns`):**
- **glm-5.1 原生 `tools`/`tool_calls` 稳定**:一句「查证命令模式核心思想并记笔记」→ 外层 loop **10 轮自主多跳**(串接 `book.concept`/`book.query`/`book.text` + `memory.save`),正常终答(无 tool_calls)收敛、`incomplete=false`。NativeAdapter.chat 的 tool_calls/usage 解析兑现,**无需 ReActAdapter**(决策1 验证)。
- **双重停机 usage 口径兑现**:`usage.total_tokens` 累加 = 31608(远低于 120k budget)、turns=10(低于 12 cap),正常停而非硬闸触顶,`incomplete` 诚实为 false。
- **memory citation 自动派生 + 引用红线兑现**:落库 1 条 note,`anchor.lid="11"`、`citations=[{lid:"11",book_id}]`,确定性核查 LID 11 = 真 LID(`book.text 11` → "第2章 命令模式",可跳原文)。recall 可验证(决策4 兑现 [[ADR-0004]]/[[ADR-0015]])。
- `max_turns`/`TOKEN_BUDGET` 仍占位:单次 10/12 轮已偏近上限,待 S8 金标准集 + 更多查询观察后回填 [[ADR-0016]]。

## 影响
- **新增 `crates/runtime` 外层 loop + memory 模块**(切片0 最小版);回填 V3 §5.2(外层 loop 落地)/ §4.3(memory.save/recall 落地)。
- **承** [[ADR-0016]](双层 loop / 薄 adapter / 双重停机)/ [[ADR-0025]](内层 query 复用为工具)/ [[ADR-0005]](E 自建运行时)/ [[ADR-0006]](memory 隔离·跨书)/ [[ADR-0015]](记录模型 / 错误信封 / 禁宽松降级)/ [[ADR-0003]](provider 抽象 / `.env`)/ [[ADR-0004]](引用红线延伸记忆层)。
- **不回填 CONTEXT**:外层回合形态 / memory 落盘 / `AssistantTurn`/`Message` 是既有术语「最小 agent loop」「记忆层」「ModelAdapter」的**实现细节**,守 [[ADR-0021]] CONTEXT 纯术语纪律(承 [[ADR-0024]]/[[ADR-0025]] 先例)。
- **议题7 续**:第四叉(memory 两阶段 consolidation + 分层渐进披露产物)。
