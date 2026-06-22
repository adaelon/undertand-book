# ADR-0014 命令面分层:确定性命令=agent 叶子工具 / LLM 命令=运行时暴露;book.* 签名定型

状态:已接受(2026-06-22,工程层 grill 议题6 第一叉共识)

## 背景
工程层 grill 议题6(命令面命令签名)。V3 §4.1 给了 `book.*` 命令清单与 `book.query` 响应结构,但**入参签名、返回 schema、命令间分工**留白。翻 U-A([[ADR-0009]] 背景):U-A 是构建期 + 静态 dashboard,**无读时查询命令面**可借——读时命令面是本项目净新,可借的仅 `GraphNode/GraphEdge` 字段形态(我们的边形态 `{source,target,type,direction,weight,description,scope}` 已与 U-A 同构,多 `scope`)。

grill 中需求方立**最高原则**(落 memory `quality-over-speed-correct-context`):**回答质量第一,agent 上下文必须完全正确,速度放其次**;且"更丰富 ≠ 更正确"——构建期可能判错的 LLM 产物(边 description、edge.type 当强先验、生成式摘要)塞进 agent 推理上下文会使其更错。本 ADR 据此定型 `book.*`,并钻出一条命令面分层原则。

## 决策
1. **命令面即 agent 的 tool 集,分两层**(承 [[ADR-0007]] 一套面无特供 + [[ADR-0005]] E 工具集=三命名空间命令):
   - **确定性命令 = primitive 叶子工具**(`manifest/context/text/concept`):无 LLM、毫秒级、可组合,agent loop 直接调它们捞素材。
   - **LLM 命令 = 自建最小运行时([[ADR-0005]] 议题7)被无状态调用一次的暴露**(`query/synthesize`):内部跑 LLM + scope 外扩,本身就是 agent loop。⇒ **query/synthesize 的精确签名/分工并入议题7 设计**(loop 有哪些工具 + loop 怎么答 + 怎么暴露成命令,是同一块设计,分开 grill 会返工)。
2. **`book.context(lid, granularity, k?)` = 纯指针**:返 `{anchor, items:[{lid, layer, via}]}`,**不带原文/预览/节点 summary**;消费方按 LID 走 `book.text` 取全量真原文。`via` = 判别联合,每变体 = 确定性接入来源 + 该档确定性排序键:`{kind:"tree",rel}` / `{kind:"edge",scope,type,weight,direction}` / `{kind:"concept",name,shared_count}`。默认 top-K 截断(服务人类概览),`k="all"` 取该档全量(服务 agent 凑完整上下文),`k=<int>` 自定。累积分层(far 含 near∪mid∪far)沿 [[ADR-0013]]。
3. **新增 `book.text(lid, range?)`**:按 LID / LID 区间取真原文,纯确定性、只读、provider 无关。与纯指针 `book.context` 天生配对(context 给坐标 → text 取内容);兑现 LID 硬保证③"可双向跳原文" + [[ADR-0004]] "LLM 捞回真原文进证据集"的命令面入口。落在 `book.*`(原文是冻结只读基座的一部分)。
4. **`book.concept(name)`** → `{concept:{name, summary}, occurrences:[lid...](全量不截断), related_entities:[...]}`;按规范化名寻址、同名即同节点([[ADR-0010]] `id=concept:{name}`,实体消歧是未来事)。`summary` 是 Pass1 LLM 产、已冻结,**仅作展示标签,agent 推理以 occurrences 真原文为准、不拿 summary 当权威定义**。查不到 → `CONCEPT_NOT_FOUND` + 可选 `suggestions[]`(不自动替换,守 [[ADR-0011]]/§4.4 禁宽松降级)。
5. **`book.manifest()` = 纯确定性拓扑**:返 `{tree:[{lid,children,span}], stats_by_lid:{lid:{child_count,leaf_count,anchored_nodes}}}`。**砍掉"推荐路径""认知深度"**(不可证伪/需 LLM 现编,体检 B12 点名"认知深度不可观测");路径推荐交读时 E agent 现算,不烤进冻结基座。
6. **`book.query(query, anchor_lid?, scope?="auto")`**:`scope=auto` 的"证据不足→逐级外扩"循环**跑在 book.query 内部**(检索 anchor 局部→LLM 判证据→不足则顺图谱外扩重检→直到充分或触顶,返 `scope_used`)。**裸调 book.query 即得正确完整答案**([[ADR-0005]] 基线可用 + 用户原则);显式 `scope∈{local,chapter,cross_chapter,global}` 则单射定宽。**不设独立 fast/deep 旋钮**——深/快是外扩深度的涌现结果(体检 §12 不靠一刀切)。响应结构沿 V3 §4.1。

## 命门
- **用户最高原则贯穿全部选型**:只喂**确定性事实 + 真原文**给 agent 上下文;LLM 关系判断退居召回路标(承 [[ADR-0011]])。纯指针 context + book.text 取全文 = 比截断预览**更正确**(无失真),正是"正确性优先、速度放后"。
- **LLM 命令内部即 agent loop** ⇒ 议题6 的 LLM 命令设计与议题7 的运行时设计是同一块,故 query/synthesize 后移,避免无运行时模型时硬抠签名。
- `book.context` 截断不碰引用红线(context 不产 citations);`k=all` 兜底完整性,`book.concept` 兜底某概念全量。
- `book.text` 与 `reader.gotoLid` 职责分离:前者取数据(只读 book.*),后者移 UI 视口(可变 reader.*),不混命名空间可变性。

## 否决
- **context 带原文预览 / 带节点 {type,name,summary}**:截断预览给 agent 失真片段;summary 是 LLM 产、可能误导,违用户原则。
- **via 极小 {kind,ref}**:丢 weight/shared_count 等确定性排序事实,agent 看不到排名依据、拿不到二次排序键。
- **via 带整边对象(含 LLM description)/ 节点**:把构建期可能判错的 LLM 关系断言塞进 agent 上下文(违 [[ADR-0011]] 边作召回路标),且重新把内容塞回纯指针响应。
- **book.manifest 保留/重定义"推荐路径·认知深度"**:不可证伪修辞进全局视图;确定性算法产的"推荐路径"仍受 builds_on 错边污染([[ADR-0011]]),不值。
- **book.query 单射 + 外扩在 E**:裸调只得单射欠完整,正确性依赖 E 编排,违 [[ADR-0005]] 裸调基线 + 用户原则。
- **query/synthesize 当独立 RPC 在议题6 grill 完签名**:把同一块设计(运行时)劈两半,signature 与 runtime 反复互相依赖、返工。
- **另做一套 agent tool 通道**:违 [[ADR-0007]] 一套面无特供。

## 何时回头
- 切片0 实测填:`book.context` 各档概览默认 K 值(承 [[ADR-0013]]);`book.text` 区间取原文的体积上限。
- **议题7** 设计自建运行时时定 `book.query/synthesize` 精确签名与分工;若届时发现 `synthesize`(跨 LID 综合)与自含外扩的 `query` 无法清晰分工 → 评估砍 synthesize 全归 query(本 ADR 暂留 V3 §4.1 的 synthesize 条,不在议题6 定型)。
- 若某档 context 读时现算超毫秒级(稠密大图)→ 按 [[ADR-0012]]/[[ADR-0013]] 何时回头,把该档预算成确定性索引(局部优化),不复活物化胶囊。

## 影响
- **回填 V3**:§4.1 `book.*` 四确定性命令签名定型 + 新增 `book.text`;§2 模块A 矩阵 manifest 交付物删"推荐路径/认知深度";§4.1 `book.query` 补入参 `(query, anchor_lid?, scope?)`。`book.query/synthesize` 完整定型留议题7。
- **改议题编排**:议题6 第一叉(book.*)收口于确定性叶子工具;query/synthesize 移入议题7。议题6 续钻 reader.* / memory.* 签名 + 错误契约 error_code 枚举完整化。
- **新增 CONTEXT 术语**:叶子工具(leaf tool)/ 命令面分层(确定性叶子 vs LLM 运行时暴露)。
- 消费 [[ADR-0013]] 的 `{lid,layer,via}` 定 context schema;承 [[ADR-0011]] 边作召回路标定 via 取舍;承 [[ADR-0005]]/[[ADR-0007]] 定分层。
