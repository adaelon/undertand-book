# CONTEXT —— 术语表

> 纯术语表。只定义"词是什么意思",不含实现细节、不含决策(决策见 `docs/adr/`)。
> 凡此处定义与代码/对话冲突,以此处为准,冲突即点破。

## LID (Location ID)
书的语义单元 URI 方案。深度可变的有序路径(层级随书真实结构而定),硬保证:① 全局唯一 ② 同级有序(可计算前后/邻接)③ 可双向跳原文。下游不得假设固定段数。
状态:EXISTING(源自 需求文档-V2 §3.1)。

## 锚定 (anchor)
节点 / 边 / 引用必须绑定到**真实存在的 LID**。基数按类型分裂 `[ADR-0010]`:**实体 / 概念锚定一个或多个 LID**(`occurrences`,贯穿全书的身份),**断言 / 引用锚定单个 LID**(`source_lid`)。未锚定或锚定到不存在 LID 的对象,一律由确定性闸丢弃。`citations[]` 只放真 LID 即此义。

## occurrences(出现锚点集)
实体 / 概念节点的多锚点字段:该身份在书中出现过的全部 LID 列表。跨窗口同一实体靠 `id = entity:{normalized-name}` 归并为一个节点,各窗口贡献的 LID 并入 occurrences。直接兑现 `book.concept` 的"出现 LID 列表"。状态:NEW(详见 [docs/adr/0010])。

## Pass1 / Pass2(语义边两遍抽取)
构建期抽语义边的两个串行阶段 `[ADR-0010]`:**Pass1**(`pass1-local-extractor`)逐窗口抽实体/断言节点 + 局部边,merge 后确定性投影出全局目录;**Pass2**(`pass2-longrange-linker`)带全量全局目录逐窗口抽长程边、不产节点。两遍之间是**硬串行屏障**(全部 Pass1 完成→沉淀完整目录→才开 Pass2),因长程边两端可跨全书任意远窗口、Pass2 须见全量目录。各遍内 5 并发。状态:NEW(详见 [docs/adr/0010])。

## 边 scope(local / long_range)
语义边的来源标记:Pass1 产的同窗口内边记 `local`,Pass2 产的跨窗口边记 `long_range`。供读时质量度量、调试、按局部/长程分别统计召回。状态:NEW(详见 [docs/adr/0010])。

## 语义边 (semantic edge)
知识图谱中连接**实体 / 概念 / 断言**节点的边(如 builds_on / contradicts / exemplifies / cites)。区别于结构边(contains / LID 层级):语义边**无法被确定性解析**,由 LLM 在构建期读出,再过确定性图谱闸校验。
**读时角色** `[ADR-0011]`:边在读时是**召回路标**——其存在决定"捞哪些 LID 原文进证据集";`edge.type` **不当 LLM 推理的强先验**(关系让 LLM 从捞回原文现判),type 退居召回提示 / UI 展示 / 图谱导航。⇒ 错边碰不到引用真实性(结构红线焊死),最坏只污染检索精度。

## 确定性图谱闸 (deterministic graph gate)
图谱固化前的确定性校验闸 `[ADR-0011]`,对锚点真实性做**二元判定**:边端 / 节点锚点 LID 查 LID 全集(由切分层 [docs/adr/0008] 确立),存在则保留、不存在(LLM 幻觉)则**确定性丢弃且绝不重建**。最小连坐:边端节点缺失只丢边;断言 source_lid 悬空丢断言+其边;实体/概念部分 occurrence 悬空只剔该锚、全悬空才丢节点。**不自产"低置信"档**(置信是切分层属性,见下)。区别于切分层的**分区不变式闸**(后者管 LID 自身合法,是本闸前置)。状态:NEW(详见 [docs/adr/0011])。

## 局部边 / 长程边 (local / long-range edge)
- **局部边**:两端落在同一 LID 窗口内、读单个窗口即可抽出的边。
- **长程边**:两端跨窗口、读任一窗口都看不全、必须借「全局目录」才能连上的边(如"第2章的断言反驳第9章的断言")。

## 全局目录 (global catalog)
构建期第一遍抽取后沉淀的**扁平文本索引**(实体索引 + 断言索引,每条带锚定 LID + 一行摘要)。作用是充当"人造 wikilink":第二遍把目录连同窗口一起喂给 LLM,使其能把当前窗口的节点连到窗口外的远处节点。是我们替代"书没有 import / 没有 wikilink"的关键造物。

## 语境胶囊 (context capsule)
**已降格为 `book.context` 的读时确定性投影**,不再是物化产物 `[ADR-0012]`。原 V3 §3.5 把它列为模块A预组装产物(每 LID 预存"前置背景 LID + 同主题关联 LID + 概念锚点");工程层裁决砍掉物化:`book.context(lid, granularity)` 读时现场从最终图([docs/adr/0011])+ LID 物化路径树([docs/adr/0008])纯函数投影 near/mid/far,复用 `scope=auto` 同一套图谱遍历。理由:图谱遍历已毫秒级([docs/adr/0002]),物化是冗余抽象层 + 一致性风险源。**一切基础是图谱,不叠派生抽象层。** near/mid/far 三档 = 图谱具名遍历(near=树邻接+local边 / mid=经概念二跳的其他 occurrences / far=long_range边另一端),**累积半径 + 分层标注**(`far` 返回 near∪mid∪far,每条标 `{lid,layer,via}`)+ 每档**确定性 top-K 截断**(near 按 LID 距离 / mid 按共享概念数 / far 按边 weight,K 留实测),全量某概念走 `book.concept`。详见 [docs/adr/0013]。状态:NEW(详见 [docs/adr/0012] 降格 + [docs/adr/0013] 三档规则)。

## 窗口 (window)
构建期喂给 LLM 做一次抽取的一段连续 LID 跨度。**以章/节子树为基本单元**(超预算则子树内细分、过小则合并相邻同级,不跨卷);细分切点吸附 LID 边界,不腰斩句。批次的基本单元。详见 [docs/adr/0009]。

## 窗口预算 (window budget)
界定一个窗口能装多少的双约束:**输入硬闸**(正文 token ≤ 上下文窗口 × 安全系数 − 指令/目录/输出预留,放不下必拆)+ **输出软闸**(单窗口预期节点/边软上限,超则再拆)。具体数字留切片0实测。详见 [docs/adr/0009]。

## 融合批次 (fused batch)
把多个相邻小窗口打包进一次 subagent 抽取调用以省开销;产出仍按各原窗口的 LID 区间拆回。借自 U-A 的 fused-batch。状态:NEW(详见 [docs/adr/0009])。

## 边界重叠 (boundary overlap)
仅在"超大子树内部 token 细分"产生的**人工切点**处,让相邻窗口共享一小段 LID,使紧邻细关系被某窗口完整看到,确定性闸去重。子树语义边界处零重叠(跨边界关系=长程边,走 Pass2)。状态:NEW(详见 [docs/adr/0009])。

## 预构建期 / 读时 (build-time / read-time)
- **预构建期**:跑在 agent harness(Claude Code / Codex 等)里,一次性产出 `.understand-book` 产物。
- **读时**:阅读器运行中,与任何 harness 脱钩,独立产品。

## 阅读器 (reader)
第三层(消费)的产品形态。一个独立的阅读应用,集成确定性导航(②)+ LLM 问答(③)。由 plugin 启动的本地临时查询服务(localhost)支撑;读时与 agent harness 无关。

## LLM 后端 (LLM backend)
读时 ③ 用的大模型提供方,**用户自选**(Anthropic / OpenAI / 本地 Ollama 等),藏在本地查询服务的 provider 抽象层后。区别于预构建期由 harness 提供的 LLM。

## 书 agent / 模块 E (book agent)
读时"这本书的 agent"。承接用户对本书任何问题的**单一入口**,带 **memory** + **skills**,架在确定性导航(②)+ LLM 问答(③)之上,跑用户自选后端。运行时由我们在本地查询服务里**自建**(最小工具调用 loop + 记忆;弱后端走 ReAct 兜底)。详见 [docs/adr/0005]。

## 记忆层 (memory layer)
E 的记忆所在。**独立于只读基座、用户私有、可变、跨书**。两层:会话工作记忆(临时:当前对话+阅读位置)+ 长期记忆(持久:旅程/问答/兴趣/卡点/笔记)。book agent 读写但不拥有。详见 [docs/adr/0006]。
**记录模型** `[ADR-0015]`(参考 Codex `codex-rs/memories`):结构信封 + 散文 content + **记忆引用锚定**(见下)。命令面 `memory.save/recall/delete`(议题6 定);Codex 式两阶段后台 consolidation(Phase1 抽取阅读会话 / Phase2 合并+遗忘+usage 剪枝)+ 分层渐进披露产物留议题7。

## 记忆引用锚定 (memory citation)
记忆记录回溯到源位置的锚 `[ADR-0015]`,借自 Codex memory 的 `MemoryCitationEntry{path, line_range, note}`——把 Codex 的 `path:行号区间` 换成本项目的 **LID**:`citations:[{lid, book_id, note}]`。使 `memory.recall` 返回的每条记忆**可验证、可跳原文**,是引用红线([docs/adr/0004])在记忆层的延伸。区别于 book 的 `citations[]`(那是问答证据;此为记忆溯源)。状态:NEW(详见 [docs/adr/0015])。

## effect 返回 / 错误分类+recovery
- **effect 返回** `[ADR-0015]`:`reader.*` 变更命令返回"变更后的相关状态"(gotoLid→viewport、note→{id}…)而非裸 ack,使 agent 能确认动作、闭环、re-sync(配 `reader.state()` 只读会话态)。
- **错误分类 + recovery** `[ADR-0015]`:统一错误信封 `{error_code, category∈{validation,not_found,provider,budget,internal}, message, recovery?}`。category 分流瞬时(provider/budget,可重试)vs 永久(not_found/validation,改输入)错;`recovery`(nearest_valid_lid / suggestions[] / {retriable,after_ms})**仅供 agent 自纠、系统永不自动套用**(守禁宽松降级,体检 §14)。状态:NEW(详见 [docs/adr/0015])。

## 命令面 (command surface)
阅读器的命令可寻址引擎。人类能做的每个阅读器动作都暴露为具名、可参数化、agent 可调用的命令;GUI 是其上一层渲染。E 及任意外部 agent 与人类走**同一命令面**(人机对称、无特供),agent-CLI 普适。**一套面、三命名空间**:`book.*`(只读内容查询 ②③)/ `reader.*`(可变 UI 控制)/ `memory.*`(记忆层读写)。硬边界:reader/memory 不得写只读基座。详见 [docs/adr/0007]。
**命令面分层** `[ADR-0014]`:命令面即 agent 的 tool 集,按是否调 LLM 分两层——**确定性命令 = 叶子工具**(见下),**LLM 命令 = 自建最小运行时被无状态调一次的暴露**(`book.query/synthesize`,本身即 agent loop)。

## 叶子工具 (leaf tool)
确定性命令在"命令面即 agent tool 集"分层中的角色 `[ADR-0014]`:无 LLM、毫秒级、可组合的 primitive,agent loop 直接调它们捞素材。`book.manifest`(确定性拓扑)/ `book.context`(纯指针 near/mid/far,`{lid,layer,via}`)/ `book.text`(按 LID/区间取真原文)/ `book.concept`(概念全量 occurrences)即四个 book.* 叶子工具。区别于 LLM 命令(运行时暴露)。状态:NEW(详见 [docs/adr/0014])。

## 段 (paragraph / 叶子块)
切分的中间叶子单元 = 源格式的一个块级标记(md 段/列表项/引用块/代码块;epub p/li/blockquote/br)。**忠实映射源块的结构类型,不检测文学体裁**;诗行、对话轮靠块边界天然落位(非按体裁识别),裸 txt 退化到空行。切片0 的最深 LID 层。注:`code/table/image/formula` 四类块级标记是带类型的一等 **asset 叶子**(见下),非普通 paragraph;其中 formula 另有公式语义剖面。状态:NEW(详见 [docs/adr/0008/0029])。

## asset 叶子 (asset leaf)
代码块 / 表 / 图 / 公式四类**带类型的一等 LID 叶子** `[ADR-0029]`(`NodeKind ∈ {Code,Table,Image,Formula}`,闭集可扩展)。仍是 LID 树叶子:**占 source span、进分区不变式划分、用 LID 单一寻址**(不引第二套 asset_id)。**原文 = 源标记的确定性序列化**(image=`![alt](src)`、code 保留换行缩进、table 保留表文本、formula 保留 LaTeX/MathML 源标记),`book.text(asset_lid)` 返回它,确定性+忠实;`book.manifest` 节点带 `kind` 暴露可见性(零新基础命令,agent 过滤 kind 定位)。Code/Table/Image 作为普通可锚 LID 进入图谱;Formula 额外要求公式语义剖面(见下),让 agent 交互时能拿到参数、组合含义和上下文关系。多模态图理解(描述图)留切片1+、走"标注来源"旁路、**不进只读基座**。源自 `参考.md` 文档世界状态「让图/表/代码不从链路消失」并扩展到技术/数学书的公式状态。状态:NEW(详见 [docs/adr/0029])。

## 公式语义剖面 (FormulaSemantics)
Formula 叶子的高优先级读时语义对象 `[ADR-0029]`。除 `book.text(formula_lid)` 返回公式原文外,构建期还要固化 `parameters[]`(每个符号/参数的名称、含义、单位或取值域若原文给出、定义来源 LID)、`composition`(公式整体表达什么、各项如何组合)、`context_links[]`(公式与前后段落、概念、断言、图/表/代码的关系)。每条解释必须带 `source_lid` 或 `evidence_lids`,且这些 LID 由确定性闸校验真实存在。agent 解释公式、回答公式相关问题、生成追问时应优先把 FormulaSemantics 连同公式原文放入上下文;无证据的模型常识只能作为 model_supplement,不得伪装成书内事实。状态:NEW(详见 [docs/adr/0029])。

## 句 (sentence)
段下更深一层 LID 节点,由确定性句切(句末标点 + 引号/括号配对保护)从叶子块文本切出,每块 1..N 句。citation 与语义边的最细锚点。切片1+ 长出。状态:NEW(详见 [docs/adr/0008])。

## 物化路径 (materialized path)
LID 的字符串编码 = 各级序号点分串(如 `3.2.5.2`)。比较用**逐段数值**(非字典序),据此算同级有序 / 前后邻接 / 窗口范围切片。状态:NEW(详见 [docs/adr/0008])。

## 分区不变式 (partition invariant)
切分自检闸的核心断言:全部叶子 span 构成对原文内容的一次**划分**(全覆盖 + 无重叠),父 span ⊇ 子并集,同级数值递增,LID 全局唯一。破则打回 / 标低置信。状态:NEW(详见 [docs/adr/0008])。

## 最小 agent loop / 自建运行时 (minimal agent loop)
模块 E 的心脏:本地查询服务内置的 agent 运行时,U-A 没有、本项目净新自建 `[ADR-0005][ADR-0016]`。**双层嵌套**:
- **外层 = E 编排 loop**(会话级,有状态 messages+memory):LLM 自主调三命名空间命令(book/reader/memory),管多跳编排 + 会话态 + 主动策略;**双重停机**——正常停=LLM 给最终答(无工具请求)/ 硬闸=`max_turns`+token 预算,触顶诚实标 `incomplete`+`CONTEXT_BUDGET_EXCEEDED`,不静默截断。
- **内层 = `book.query` 自含 mini-loop**(无状态,被外层调一次,裸调即完整):**混合驱动**——确定性档位骨架管"捞什么"(scope 阶梯沿图谱确定性遍历捞 LID+真原文),LLM 管"够不够+答什么";**合一轮条件产出**`{sufficient,answer?,citations?,model_supplement?}`+**确定性交叉验停**(citations⊆证据集 LID 全集才留=结构红线读时落地;零有效 citation 强制外扩堵早停;`scope==global` 触顶堵晚停)。
状态:NEW(详见 [docs/adr/0016])。

## ModelAdapter (provider 适配层)
统一 loop 骨架与具体后端之间的薄序列化层 `[ADR-0016]`。loop 控制(档位推进/停机/citations 校验)**provider 无关恒定**,只通过 `complete(messages, tools?, schema?) → ParsedResponse` 跟模型打交道;两实现:**NativeAdapter**(原生 tools API + JSON mode,直接拿结构化)/ **ReActAdapter**(无原生 tool-calling 的弱后端:注入 ReAct/JSON 模板 + 解析文本回填成同一 ParsedResponse)。⇒ 弱后端只改输出解析方式、loop 行为恒定;结构红线([ADR-0004])靠确定性 citations 过滤,后端无关 100% 守。状态:NEW(详见 [docs/adr/0016])。

## book.query / book.synthesize(LLM 命令分工)
两个 LLM 命令按**输入形态**分工 `[ADR-0017]`:`book.query(query, anchor_lid?, scope=auto)` = NL 问题 + 单 anchor,系统**隐式检索 + scope 外扩**找证据(内层自含外扩 loop,[docs/adr/0016]);`book.synthesize(lids:[LID...], task?)` = 调用方**给定离散多 LID 集**,系统只在该范围内综合、**无外扩**。query 单 anchor+连续半径表达不了"就这几个不相邻 LID",synthesize 填此缺口(阅读器圈选多段 / E 编排已圈定)。synthesize 内部**确定性分批归并**(超预算 map-reduce:按 LID 顺序切批局部综合→归并,横向不出 lids、纵向不静默丢);响应**复用 query 骨架**(`citations[].role` 承载多 LID 对照,`scope_used`→`source_lids`+`batched`);`citations ⊆ 输入 lids`(结构红线范围更紧)。状态:NEW(详见 [docs/adr/0017])。

## scope-granularity 同轴半径 (coaxial retrieval radius)
`book.query` 的 scope 四档(`local/chapter/cross_chapter/global`)与 `book.context` 的 granularity 三档(`near/mid/far`)**同源**:reduce 到同一批已固化图谱原语(树邻接 / local 边 / 概念二跳 / long_range 边 / 子树范围,见 [docs/adr/0013]),只是**截断半径粗细不同**——near/mid/far 是半径轴上三个具名点,scope 四档是同轴更粗的检索广度档。非两套真相,内层 `retrieve(anchor, scope)` 与 `book.context` 投影复用同一遍历。状态:NEW(详见 [docs/adr/0016])。

## 构建侧增量(双轨变更检测 + 变更分级 + Pass2 受影响追踪 + 独立基座内容寻址)
书没变但构建器升级、或书小改时,不全量重建、复用旧基座未变部分的机制 `[ADR-0019]`。**只覆盖「构建侧」**(记忆侧迁移见下条 8b)。
- **双轨变更检测**:两类变更源正交分轨——**轨①文本 = Merkle 树**(`content_hash = H(本节点直接文本 ⊕ 有序子节点 content_hash)` 沿 LID 树聚合,根哈希一比知整书变否、不同则下钻 O(log n) 定位变更子树;LID 树天然是 Merkle 形状,见 [docs/adr/0008]);**轨②构建器 = 层版本戳**(`{split_algo_version, extract_prompt_version, model_id}`)。**铁律:content_hash 纯文本、绝不掺构建器版本**(掺入则版本升级全哈希失效退化全量)。不引入 rsync rolling hash(块边界=确定性 LID 切分,不漂移)。
- **变更分级 NONE/COSMETIC/STRUCTURAL**:由双轨确定性合成(无 LLM,守 B2)——split 版本变/树形状变(增删段章)=STRUCTURAL;叶内改字/prompt·model 变=COSMETIC;皆否=NONE。借 U-A `fingerprint.ts` 三级,把 flat per-file 换成树形 Merkle。
- **catalog_hash 节点集指纹闸**:`window.catalog_hash = H(该窗口投影进全局目录的节点条目集)`;全窗口 catalog_hash 不变 → 全局目录不变 → Pass2 全跳过。**Pass2 是否连坐的闸门是「节点集变没变」,非「窗口文本变没变」**。
- **Pass2 受影响追踪**:目录变时——删节点→悬空边确定性闸丢([docs/adr/0011]);变更/新增节点→只重抽「该节点窗口 + 旧图中与它有长程边的对端窗口」Pass2,非全书;「旧窗口←→新增节点」的新机会边接受构建期漏、读时 scope 外扩兜底(承 [docs/adr/0011] 长程边=召回路标)。首次构建仍全量零漏([docs/adr/0010] 不变)。
- **独立基座内容寻址**:增量=生产优化(拿旧基座当计算缓存),**产出独立新 book_id 基座(v2)、旧基座(v1)只读不动**——V3 §3.4「当新书重建不覆盖」字面落地,基座不引入 version 维度;磁盘由内容寻址/硬链接去重(逻辑独立、物理共享未变产物)。**增量 ≠ 原地更新**(原地 patch 违 §3.4 + 破记忆隔离)。
状态:NEW(详见 [docs/adr/0019])。

## 记忆迁移(v1→v2 跨基座 citation 重锚)
增量改版后([docs/adr/0019]),用户在旧基座 v1 积累的记忆如何延续到新基座 v2 的机制 `[ADR-0020]`(8b)。
- **真相源 = 消费 8a 确定性 LID diff**:同书增量,8a Merkle diff 确定性知 LID 演化 → `lid_migration_map: v1_lid → {status, v2_lid?}`;**非** [docs/adr/0006] 概念模糊对齐(那为「真不同的书」备,概念对齐仅 `{concept}` 锚兜底)。
- **引用红线不破**:citation 带 `book_id`([docs/adr/0015])+ v1 只读并存([docs/adr/0019]) ⇒ citation 永指真实 `(book_id,lid)`,失效就诚实**锚回 v1 历史版本**,不猜不降级。
- **三命运确定性重锚**:**stable**(v2 存在且原文等价)→ 投影 `{v2_lid, v2}`;**drift**(LID 同、原文改字)→ 投影 `{v2_lid, v2, drift:true}` 标「源文已变·需复核」+ 保留 v1 锚;**removed**(STRUCTURAL,v2 无对应)→ **不投影、不猜最近邻**,标 `orphaned`、citation 仍指 v1。
- **v1 记忆库永不改写 + 迁移=读时确定性投影非物化**:v1 记忆是历史事实+唯一真相源,recall(book_id:v2,lid) 时拿 map 现场投影(毫秒级查表),不批量物化 v2 记忆库(呼应 [docs/adr/0012]/[docs/adr/0013] 不物化派生视图)。removed 记忆 recall@v2 默认返回+标 orphaned(不隐藏,守 agent 上下文完整)。
- **来源三分迁移**:显式 save(note/highlight/qa)走 map;Phase1 推断 concept 锚走概念兜底、lid 证据走 map;**会话临时(position/dialogue)不迁移**(改版重读=新会话)。
状态:NEW(详见 [docs/adr/0020])。

## 命令面 REST 投影 (command surface REST projection)
读时 localhost 服务把**冻结命令面**(V3 §4)投影成 HTTP 的形式 `[ADR-0028]`:`book.*` 只读 → `GET`、`reader.*`/`memory.*` 可变 → `POST`,**端点名 = 命令名**,错误**原样透传** §4.4 分类信封。是命令面的网络面、非另立的第二套 API;前端 / agent / 人看同一张面([docs/adr/0007] 人机同命令面无特供)。状态:NEW(详见 [docs/adr/0028])。

## 连续正文渲染 / LID 隐形 (continuous prose rendering)
前端把视口 `visible_lids`(叶序滑动窗口,[docs/adr/0027])渲染成**一整列连续流动的正文** `[ADR-0028]`:不画每段框/分隔/LID 标号,阅读单位是连续文章而非 LID 片段。**LID 是隐形接缝**,只在被用到时(citation / 跳转 / 高亮锚)才显形——LID 之于阅读体验 ≈ HTML 之于网页(结构底座,非阅读单位)。状态:NEW(详见 [docs/adr/0028])。

## 读位感 (reading position sense)
替代"页码"的位置参照 `[ADR-0028]`:**章节定位**(从当前 anchor 上溯容器 LID,显示"第N章 …")+ **进度%**(`anchor_idx` / 叶总数,确定性)。只做导航 / 显示,**不做引用锚**。本项目**无一等页码**——页在 reflowable / 连续滚动模型里物理不存在,造页号不可复现(违锚定红线);印刷版 page-list 仅当源 EPUB 携带时作 LID 展示标签(切片1+),citation 恒为 LID。状态:NEW(详见 [docs/adr/0028])。

## 记忆 consolidation(确定性账本 + 用户主动 LLM 记忆 + 四层派生)
memory 层产物的生成机制 `[ADR-0038 修正 ADR-0018]`(命令面记录模型见 [docs/adr/0015])。**ADR-0038 推翻 ADR-0018 的「参照 Codex 两阶段后台自动抽推断」根基**(后台自动抽=不透明 + 记猜测,违最高原则、用户实测别扭),重定位为 Claude Code 式透明 memory:记确定事实 / 用户真说的话。
- **来源三分(重划)**:① 确定性账本(无 LLM,直存)= 真读过的 LID 历史 + `note/highlight/qa`(用户显式动作);② 用户主动 LLM 记忆(LLM,**agent judgment 触发 + 用户显式,前台读时非后台** `[ADR-0039 修正 ADR-0038]`)= 用户显式「记下 X」∨ agent 读时 judgment 觉得值得构建进对该读者的理解(偏好/关注/卡点);**「记什么」放宽到「构建用户上下文(含对用户的理解/推断)」+ 三护栏(透明落可见文件 / 用户可改可删 / 认知诚实标注+citation 锚真 LID)**;**落 `memory.save type=context`(区别于 `note`=用户逐字便签)、直接 `long_term` + 可删兜底**(砍确定性计数器、放宽 ADR-0038「只记事实」否决;确定性 reader_profile 派生仍不塞推断);③ 会话临时(`dialogue/position`,不持久)。
- **读时主动,非后台流水线**:agent 在 E loop 读时判断该记什么 → 调已有 `memory.save`,透明落可见文件、用户即时可改可删。**砍** Codex Phase1/Phase2 后台 + idle/claim/lease/锁/watermark/git diff(单机过度工程 + 后台=不透明)。
- **四层产物 = 物化只读派生 .md** `[ADR-0040]`:从 ①② 确定性聚合渲染成 `.md` 落盘(memory.json 同目录),**纯派生只读快照·save/delete 后整页单向覆写·真相源唯一 memory.json**(改东西走 memory.delete/编 json,手编 .md 无意义);物化但单向,折中 ADR-0038(物化)× ADR-0012/0020(不双向)。**v1 两层零 LLM**:`reader-profile.md`(单书常驻 = 已读集 + 关注点 note·highlight + 卡点 qa(LID 提问热度 + 真实问题文本,`[ADR-0041]`)+ context 按 generated_at 成长时间线)/ `阅读手册.md`(per-book × cross-book 双维;概念对齐留 ADR-0006)。`session 详档`/`raw 原料`两层**随 ADR-0038 砍 Phase1 失生产者,v1 不做**;LLM 表达层摘要留后续。
- **遗忘按来源分裂**:确定性产物**只用户显式 `memory.delete`**(是事实);主动记忆可 usage 剪枝。
状态:NEW(详见 [docs/adr/0038],修正 [docs/adr/0018])。

## qa 提问热度 / LID 价值信号 (qa heat)
读者对某 LID 的提问频次构成的**读者私人价值信号** `[ADR-0041]`:某 LID 被问得多 = 对**这个读者**更值钱(更难/更关键/更想懂)。qa = agent 用 `book.query` 答书内问题后存的真问答记录(`type=qa`,锚 query 的 anchor LID + 用户原问题),heat = 该 LID 的 qa 记录条数。属 ② 读者私人记忆(不写 book base、不跨读者聚合;"书内在价值"=跨读者聚合属 ① 世界模型,另开)。三消费方全锚 `anchor.lid`:**lid→count** 喂 `technical_learning_reorder` 在 **back 组**做卡点升权(压已读、count 分层 tiebreak weight×距离);**lid→问题文本** 经 `memory.recall(lid,type=qa)` 做 LID-local recall(到该 LID 看历史提问)+ `reader-profile.md` 透明展示。区别于 `note`(用户逐字便签)/ `context`(agent 构建的用户理解)。`puzzle_heat: BTreeMap<lid,u32>` 是其 reader_profile 派生形(替代旧 `puzzle_lids` 去重平表)。状态:NEW(详见 [docs/adr/0041])。

## agent 可撤销提议 (agent reversible proposal)
读时 E agent 在阅读器中对视图/标注的修改**是可撤销的提议、用户终裁** `[ADR-0030]`。agent **真执行**命令(守人机对称 [docs/adr/0007],命令面无特供),可撤销落**前端交互层**:用 effect 返回([docs/adr/0015])的反向命令 undo(goto 回原 anchor / `memory.delete(id)`)。**提议单元 = 一次对话回合**(`/agent/chat` 一次调用的全部副作用)= 事务性 undo。**agent 提议态 = 标注落 `layer=session`(临时),用户「保留」才升 `long_term`**(复用 memory 两层,零新字段;未处置走人则不污染长期记忆)。`orchestrator` 的 `OuterOutcome` 加 `effects[]`(副作用清单)+ `trace[]`(查询踪迹,对用户可见)承载之。状态:NEW(详见 [docs/adr/0030])。

## 读时会话边界 (reading session boundary)
对话会话的切分 = **用户显式控制** `[ADR-0030]`:用户点「新对话」手动清空 `messages`,**不按 idle 时间戳自动判定**(简化设计)。与 [docs/adr/0018] Phase1 的记忆抽取边界(idle/关书/退出)**解耦**——对话会话是用户交互意图,记忆抽取是后台流水线,各自独立。新会话**冷启动上下文 = memory.recall 兜底**(note/highlight/position,精炼 state 而非全量 messages,记大局不被细节淹没);完整轨迹摘要/reader-profile 常驻留 consolidation 刀。状态:NEW(详见 [docs/adr/0030])。

## route(导航原语)
图谱上的**确定性多跳导航原语** `[ADR-0034]`,零 LLM,只保证返回的 LID/边真实("确定性 LID 由 route 保证")。两形态:`route_from(at)` = **前沿式内核**(站在当前 LID 返回可走的下一步);`route_to(from, target)` = 同批边上跑 BFS 的确定性组合(派生)。区别于 `book.context`(单跳"相关点"):route 是把 context 链起来 + 按边语义排序成"可导航下一步"的多跳找路。route 内核是 Core(架在 book.context 上);教学性排序/过滤属 technical_learning policy。状态:NEW(详见 [docs/adr/0034])。

## 前沿 (frontier) / 导航类别 (navigation category)
`route_from` 的返回形状 `[ADR-0034]`:不是一条平铺 ranked list,而是按导航语义分的 **5 个类别**——`back`(前置/背景)/ `forward`(深入/承接)/ `concretize`(例证/具体)/ `cross`(关联/跨章)/ `continue`(顺读)。`edge_type → 类别` 是固定确定性映射表(Core),组内按 weight×距离 排序。意图直接落到类别("没懂"→back,"给例子"→concretize)。状态:NEW(详见 [docs/adr/0034])。

## 住户 / 访客 (resident / visitor)
读时两类 agent 的本质区别 `[ADR-0034][ADR-0035]`:**住户** = 我们的 agent,住在世界模型里,携带当前位置 + **这个读者的记忆**(reader_profile/memory),与读者有持续关系;**访客** = 外部 agent,只带自己的外来意图进来,对本书零记忆、无所有权。**能共享的不构成区别**(route/世界模型可借给访客);不可让渡的是 ②读者私人记忆。访客 = 临时住户 lite(拿临时会话+游标,够不到读者私人房间)。状态:NEW(详见 [docs/adr/0034/0035])。

## 三类记忆 (three memory classes)
读时记忆按可见性分三类 `[ADR-0035]`:**① 世界模型**(公共,可借:route/book.text/citation gate)/ **② 读者私人记忆**(durable + 读者所有 + 绝不外借:reader_profile/memory/viewport)/ **③ 访客会话记忆**(ephemeral + 访客交互所有:它问了啥、我们返了啥、它的"不对")。③ ≠ ②——给访客 session 记忆不破"私人房间不外借"。状态:NEW(详见 [docs/adr/0035])。

## 访客会话 (visitor session)
外部 agent 经 MCP 连接我们时的 ephemeral 会话 `[ADR-0035]`,**TCP 式握手/挥手**维护:握手发 `session_id`、传输期迭代引导(支持"不对"refine)、挥手即焚 + 超时 GC。内容 = `transcript`(交互记录)+ 临时**游标** `cursor{at_lid, last_frontier}`(访客自己的位置,≠ 读者 viewport)。绝不写入 ② 的 durable store。修订了 P7 原"无状态"假设(见 [docs/adr/0035])。状态:NEW(详见 [docs/adr/0035])。

## book_guide(访客向导命令)
外部 agent 投影的只读 LLM 命令 `[ADR-0035]`:`book_guide(intent, anchor?)` 返回 `意图→入口节点→route 路线(每步理由+证据 LID)`。是 `book_query` 的姊妹——**query 返答案,guide 返路线**。配访客会话态可跨调用 refine。返回全是真 LID/真边,外部可独立验证。状态:NEW(详见 [docs/adr/0035])。

## 反馈信号 (feedback signal)
带读 loop 中调整下一步的转向输入 `[ADR-0036]`。**唯一主信号 = 用户在停靠点的开放 NL 提问**(非闭集 token);viewport 偏离仅作弱旁路、memory/reader_profile 作慢先验、quiz 留后。区别于"agent 主动观测 viewport 行为推断"(已否决:弱代理误读违用户终裁)。状态:NEW(详见 [docs/adr/0036])。

## 导航轴 / 讲法轴 (navigation axis / explanation axis)
反馈意图的两个正交轴 `[ADR-0036]`:**导航轴**(去哪)落 `route_from` 的 5 类导航类别;**讲法轴**(怎么讲/多细/重讲)落 technical_learning policy 讲法层(复用 `book.synthesize` + reader_profile),不动 route。agent 据 NL 提问语义把信号定到 `{轴, route 类别, 可能的 target}`;裸"没懂"歧义靠结构兜底(确定性命令 `book.unvisited_back(at)` = `route_from(at).back ∩ (全集 \ read_lids)`,P3-2 落地)+ 可撤销提议 + 二次信号升级消解,不靠 LLM 神判;未读判定确定性,不靠 agent 心算交集。状态:NEW(详见 [docs/adr/0036])。

## TechnicalLearningAgentPolicy(带读教学整形)
technical_learning profile 对 `route_from` 5 类前沿的**确定性教学整形** `[ADR-0034 决策4/0037]`,与 `book.synthesize`「Core+policy」同构([docs/adr/0033] 决策5)。**reorder** = 按教学优先序重排 5 类分组(组间序;无 reader_profile 时取中性默认 `continue>back>concretize>forward>cross`,占位常量待实测/profile 回填);**过滤** = 剔空组。零 LLM、确定性可单测。落 **runtime**(非 read-tools Core,守 Core/Profile 分离;profile 偏见绝不渗进 route 内核,[docs/adr/0034] 否决);经新工具 `book.guided_route_from(at, k?)` 暴露(= route_from + 整形;裸 `book.route_from` 仍在,给访客/高级)。返回有序分组 `GuidedFrontier`(保分组导航语义,不平铺)。reader_profile 个性化(新手 back 置顶 / 已懂跳过)留 P4。状态:NEW(详见 [docs/adr/0037])。

## 构建工作区 (build workspace)
预构建期**单次构建**的中间产物目录 `[ADR-0042]`:`.understand-book/<bookId>/.build/`,build-only、`Book::load` 绝不读(区别于同级读时产物 base.json/source.txt/sidecar)。**只物化"贵且不可重算"的 LLM 输出**:唯一内容 = `pass1/<id>.json`(`{content_hash, nodes, edges}`,**一窗一文件、抽完即原子写**——会话可停在任意窗、已抽幸存);LID 树 / 窗口 / 输入正文等确定性派生一律用时从原书重算、不落盘(承 [docs/adr/0012] 不物化派生)。`<bookId>` 由 `deriveBookId(bookPath, override?)` 文件名 slug 派生(ASCII-safe,非 ASCII fail-fast 要 `--book-id`)。状态:NEW(详见 [docs/adr/0042])。

## 跨会话续建 (cross-session build resume)
Claude 在环驱动预构建时,**会话 token / 上下文耗尽后由新会话接着建**的机制 `[ADR-0042]`——真书数十窗 × Pass1 subagent 抽取一个会话跑不完,**跨会话是常态路径非异常**(承软工准则 A4 防上下文断裂)。物理前提 = **逐窗原子落盘**(每抽完一窗即写 `pass1/<id>.json`,旧"手工拼单一 outputs.json"会话死则全丢)。续建判定 = **存在性 + content-hash 校验,位置 id 键**(`content_hash = sha256(buildPass1Input(window).text)`;新会话重算窗口逐窗比对,在且一致 = done,缺失/不一致 = pending);**无状态位 / watermark / lock**(承 [docs/adr/0038][docs/adr/0039] 砍单机过度工程),中断 = 没文件 = pending(二值)。冷启动靠 **agent 续建契约**(写进 `skills/build/SKILL.md`,与 SESSION_CHECKPOINT C4/C5 同招):新 Claude `status <book>` 拿 pending → 逐窗 `emit-input` + subagent 抽取 + 原子写 → 全 done 跑 `pass1-batch` 收口(pending 默认拒绝收口)。区别于跨版本增量构建([docs/adr/0019],书改了复用旧基座 + LID 重锚)与内容寻址复用(留 [docs/adr/0042] 何时回头),二者本刀不做。状态:NEW(详见 [docs/adr/0042])。
