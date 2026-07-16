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

## 规范化 Markdown 正文 (canonical Markdown source)
PDF 论文 MVP 的正文真相:用户用外部 OCR / PDF-to-Markdown 工具得到并清洗后的 Markdown 文件。构建管线只以该 Markdown 生成 `source/source.txt`、`SourceBlock[]`、`LID/span/book.text`;原版 PDF 不参与正文切分。状态:NEW(详见 [docs/adr/0046])。

## PDF 旁路附件 (PDF sidecar attachment)
与规范化 Markdown 正文配对保存的原版 PDF,用于旁路预览、人工核对和未来回跳。它不是正文真相,也不是 citation anchor;图谱节点、断言、引用、FormulaSemantics 证据仍必须锚定真实 LID。状态:NEW(详见 [docs/adr/0046])。

## PDF source map
可选的 Markdown 到 PDF 版面映射 sidecar,形如 `md_span -> page/bbox`。只有存在该映射时,阅读器才能从某个 LID 近似/精确回跳原 PDF 页框;没有 source map 时只提供 PDF 旁路打开/人工核对。source map 只做 provenance,不得替代 LID 成为证据锚。状态:NEW(详见 [docs/adr/0046])。

## paper profile
英语学术论文的 content profile / extraction rule pack:把输入按论文体裁理解为 abstract、introduction、method、results、discussion、references 等论文结构和论证功能的组合,用于约束后续抽取内容与抽取规则。它不是新的存储基座或锚定体系;所有证据、引用和读时命令仍复用 LID/source/book.text。状态:NEW(详见 [docs/adr/0046], [docs/adr/0048])。

## paper_subtype
`content_profile=paper` 内部的论文体裁分型,用于在 paper base rules 之上叠加局部抽取规则。它不是新的顶层 content profile,也不得覆盖 LID/source/book.text/citation anchor、PDF 旁路、paper_metadata、paper_lexicon、单篇 MCP 边界等 paper base 契约。状态:NEW(详见 [docs/adr/0059])。

## PaperSubtypeOverlay
paper_subtype 对 paper base rules 的局部覆盖层。它只能 patch `detect_rules`、`section_classification_rules`、`metadata_extra_fields`、`argument_shape`、`graph_edge_rules`、`book_structure_rules`、`reading_guide_rules`、`validators` 等固定 slot;不得新增 Core schema、独立 pipeline 或 subtype 专属持久 truth。状态:NEW(详见 [docs/adr/0059])。

## survey subtype
综述类论文在 `paper` 规则包下的 subtype。其论证形状以领域范围、分类轴、文献簇、比较维度、综合判断、共识/分歧和未来空白为核心,而不是强套普通研究论文的 problem/method/experiment/result 链。状态:NEW(详见 [docs/adr/0059])。

## paper claim source
paper 规则包中声明事实来源层级的标记。`review_says` 表示本综述作者的转述或综合;`original_paper_verified` 表示已通过接入原始论文 MCP 或等价证据验证一手论文事实。综述中对原文献的描述默认只能标为 `review_says`。状态:NEW(详见 [docs/adr/0059])。

## PaperArgumentLayer
paper 规则包预构建抽取的论证链层:围绕 `problem -> research_question -> method -> evidence -> claim -> limitation` 组织本篇论文的可验证理解。它不是独立 `paper_argument.json`;具体落在共享 BookStructure(`spine/throughlines/key_stops`)、graph(`entity/concept/claim/edges`) 与 discourse sidecar(段落功能/语篇关系)中,再由 MCP/读时投影视图组合出来。服务单篇读懂、论文 MCP 自我说明和跨论文比较时的证据回应;每个判断必须带真实 LID evidence。状态:BOUNDARY_CHANGE(详见 [docs/adr/0049], [docs/adr/0053])。

## PaperMetadataLayer
paper 规则包预构建抽取的书目/上下文元数据层:记录 title、authors、affiliations、venue、year/date、DOI/arXiv/URL、keywords、field/topic labels、references、dataset/code/funding links 等单篇公开事实。它服务未来多论文 MCP 编排的候选对齐,不直接生成跨论文关系。所有字段必须使用 MetadataField envelope 表达 value/source/evidence/confidence;来自正文的字段必须带 LID evidence;来自用户或外部 resolver 的字段必须标 source,不得伪装成正文证据。该层作为独立 profile sidecar `paper_metadata.json` 物化,不塞进 BookStructure 或 graph。状态:BOUNDARY_CHANGE(详见 [docs/adr/0049], [docs/adr/0050], [docs/adr/0051])。

## paper_metadata.json
paper 规则包的独立 profile artifact,承载 PaperMetadataLayer。它是单篇论文的公开书目/上下文事实 sidecar,带 profile/version 头;其业务字段统一使用 MetadataField envelope,供 MCP projection 和多论文 MCP 编排读取。它不是 BookStructure,不参与 LID 树/图谱 schema,也不直接生成跨论文关系。状态:BOUNDARY_CHANGE(详见 [docs/adr/0050], [docs/adr/0051])。

## PaperMetadata MVP 字段集
paper_metadata.json 的 MVP 字段边界:只覆盖跨论文 MCP 编排最常用的对齐键,包括 title、authors、affiliations、venue、year、identifiers(DOI/arXiv/URL)、keywords、field_labels、references、datasets、code_links、funding。MVP 不做 citation style normalization、author disambiguation、institution canonicalization、BibTeX/CSL 完整兼容或 reference graph normalization。状态:NEW(详见 [docs/adr/0052])。

## MetadataField
paper metadata 字段的统一来源信封:`{value, source, evidence_lids?, confidence?}`。`source` 标记字段来自 front_matter、paper_text、user_supplied、filename、external_resolver 等来源;`evidence_lids` 只在字段可由正文 LID 证明时填写;`confidence` 表示抽取/解析置信度,不得替代 LID evidence。状态:NEW(详见 [docs/adr/0051])。

## BilingualAidLayer
面向“中文母语用户阅读英文论文”的双语辅助层。英文 `source/book.text` 仍是唯一正文真相和 citation source;中文只作为解释、释义、术语说明、句法拆解和学习辅助,不得替代原文或成为证据锚。预构建只抽关键术语/缩写/高价值短语的 paper_lexicon;普通单词、短语和句子理解走读时按需解释 + 用户 memory。状态:NEW(详见 [docs/adr/0054])。

## paper_lexicon.json
paper 规则包的双语术语 profile artifact,本质是论文术语索引而非预生成中文讲义。它承载本论文公共的关键英文词项:论文自定义术语、方法名、缩写、领域术语、数据集/指标/模型名、影响论证理解的高价值学术短语等。MVP 只抽“理解本论文必需”的词项,不抽普通英语生词。每项优先保存 term、term_type、`occurrences_lids`、`defined_at_lid?`、aliases、acronym_expansion 等索引信息;可选短中文 gloss,但深度中文解释、句法拆解和面向用户水平的讲解留给读时按上下文生成。它不保存全文翻译,也不保存读者私人不会的词。状态:BOUNDARY_CHANGE(详见 [docs/adr/0054], [docs/adr/0055], [docs/adr/0056], [docs/adr/0057])。

## PaperReadingGuide projection
paper 规则包的读时/MCP 投影视图,把单篇论文的 BookStructure、graph、discourse、paper_metadata、paper_lexicon 组合成“如何读这篇论文”的任务面。它支持速读/精读/研读层次、消极/积极/批判/创造性阶段、论文十问、Codebook 解码和摘要中文理解辅助;不新增 Core schema,不复制持久 truth。状态:NEW(详见 [docs/adr/0058])。

## PaperReadingMode
PaperReadingGuide 的阅读层次: `skim`(速读:标题/摘要/引言/贡献/是否值得读)、`close`(精读:问题/假设/方法/实验/证据/局限)、`deep`(研读:复现/公式细节/实现路径/后续研究)。状态:NEW(详见 [docs/adr/0058])。

## PaperReadingStage
PaperReadingGuide 的阅读阶段: `passive`(知道论文是什么)、`active`(知道它有什么用)、`critical`(质疑假设/实验/证据/局限)、`creative`(提出改进点和后续研究方向)。状态:NEW(详见 [docs/adr/0058])。

## 论文十问 (paper reading questions)
paper 规则包的标准 MCP/读时问答面:围绕问题/input-output、问题性质、hypothesis、相关研究/关键人物、核心贡献、实验设计、数据集、结果是否支撑假设、贡献总结、下一步工作十类问题组织回答。回答必须回到真实 LID evidence 或明确标注为 model_supplement / user reflection。状态:NEW(详见 [docs/adr/0058])。

## PaperCodebook
帮助读者“解码”论文的组合视图,不是单独产物。由 `paper_lexicon.json`(术语/缩写/方法名)、`paper_metadata.json`(作者/领域/时间/引用上下文)、BookStructure(展开逻辑)、discourse sidecar(段落功能)和 graph(claim/evidence/limitation)共同构成。状态:NEW(详见 [docs/adr/0058])。

## AbstractReadingAid
BilingualAidLayer 在论文摘要上的特化投影:围绕 abstract 的英文原文、关键术语、短中文释义、逐句理解检查和用户中文复述来暴露理解漏洞。它不做全文预翻译,也不把中文复述当 citation evidence。状态:NEW(详见 [docs/adr/0058])。

## paper 消费层
paper profile 预构建产物与读时用户任务之间的产品入口层。第一版主入口是 Web reader 单篇交互阅读:围绕单篇论文的 PaperReadingGuide、PaperCodebook、AbstractReadingAid、metadata/lexicon 与 LID 原文证据帮助读者读懂本篇;不负责跨论文综合,不把读者私有理解写回公共 paper truth。状态:NEW(2026-07-05 §0.5 paper 消费层 grill)。

## content profile / extraction rule pack
挂在 Core build pipeline 固定插槽上的可插拔抽取规则包。它决定 Pass1 抽取关注点、profile-sidecar 语篇/公式规则、Pass2 edge contracts、BookStructure key_stop/throughline 选择策略、MCP/读时投影视图;但不得改变 LID、source/book.text、citation anchor、确定性闸或 Core 命令面。状态:NEW(详见 [docs/adr/0048])。

## Profile Plugin Framework
让 `content_profile` 同时驱动预构建、后端读时/agent、前端消费的插件框架。后端 registry 管 build rules、runtime policy、projection contracts、evidence gate 和 profile manifest;前端 registry 管 profile 组件槽位、布局渲染和交互 affordance。二者通过共享 profile contract / version 对齐;前端不得拥有 paper/book truth、plan truth 或 citation policy。状态:NEW(详见 [docs/adr/0061])。

## technical_learning rule pack
当前已有抽取规则的正式规则包名,覆盖工具书、教材、技术书、数学、金融、科学、管理等说明型学习材料。现有 `pass1-local-extractor`、`profile-sidecar-extractor`、`pass2-longrange-linker`、`book-structure-extractor` 的规则应收敛为该规则包的默认实现,而不是项目全局真理。状态:BOUNDARY_CHANGE(详见 [docs/adr/0033], [docs/adr/0048])。

## 单篇论文 MCP (single-paper MCP)
一篇已构建论文对外暴露的 MCP 服务/工具面:只负责回答、检索、解释、对照本论文内部的 LID 证据与 paper profile 产物。它不拥有跨论文全局关系,也不写全局 corpus graph。状态:NEW(详见 [docs/adr/0047])。

## 多论文 MCP 编排 (multi-paper MCP orchestration)
外部 MCP 客户端(如 Claude / Codex)同时连接多个单篇论文 MCP,在运行时按用户任务询问、比较、挑战和综合多篇论文,从而建立临时跨论文关系。跨论文关系默认是会话级综合;只有用户显式保存时才进入 memory/note。状态:NEW(详见 [docs/adr/0047])。

## 阅读器 (reader)
第三层(消费)的产品形态。一个独立的阅读应用,集成确定性导航(②)+ LLM 问答(③)。由 plugin 启动的本地临时查询服务(localhost)支撑;读时与 agent harness 无关。

## LLM 后端 (LLM backend)
读时 ③ 用的大模型提供方,**用户自选**(Anthropic / OpenAI / 本地 Ollama 等),藏在本地查询服务的 provider 抽象层后。区别于预构建期由 harness 提供的 LLM。

## 书 agent / 模块 E (book agent)
读时"这本书的 agent"。承接用户对本书任何问题的**单一入口**,带 **memory** + **skills**,架在确定性导航(②)+ LLM 问答(③)之上,跑用户自选后端。运行时由我们在本地查询服务里**自建**(最小工具调用 loop + 记忆;弱后端走 ReAct 兜底)。详见 [docs/adr/0005]。

## 记忆层 (memory layer)
E 的记忆所在。**独立于只读基座、用户私有、可变、跨书**。两层:会话工作记忆(临时:当前对话+阅读位置)+ 长期记忆(持久:旅程/问答/兴趣/卡点/笔记)。book agent 读写但不拥有。详见 [docs/adr/0006]。
**记录模型** `[ADR-0015]`(参考 Codex `codex-rs/memories`):结构信封 + 散文 content + **记忆引用锚定**(见下)。命令面 `memory.save/recall/delete`(议题6 定);Codex 式两阶段后台 consolidation(Phase1 抽取阅读会话 / Phase2 合并+遗忘+usage 剪枝)+ 分层渐进披露产物留议题7。

## Memory selection context
选区创建的 Note 可选携带的结构化来源上下文:保存 `resolved/partial` 状态、用户实际选择的 `raw_quote`、可验证的 `resolved_quote` 与按阅读顺序排列的完整 LID ranges。用户内容可保留 raw quote,但 citations 与精确投影只能使用 resolved quote/ranges。Note 的 `anchor.lid` 仍取首个 resolved LID用于语义定位和排序,PDF 行内标记取末 range 作为显示锚,citations 由 ranges 中的 LID 去重派生;普通旧 Note 无此字段且保持兼容。状态:BOUNDARY_CHANGE。

## Memory replace
Note 内容编辑使用的原子替换命令:验证旧 `mem_id` 后只更新 content,默认继承 anchor、selection context、citations 与 layer;写入失败时旧记录保持不变。重新定位必须走显式“重新选择”并提交新的 selection context,不得把内容编辑伪装成锚点迁移。状态:NEW。

## 记忆引用锚定 (memory citation)
记忆记录回溯到源位置的锚 `[ADR-0015]`,借自 Codex memory 的 `MemoryCitationEntry{path, line_range, note}`——把 Codex 的 `path:行号区间` 换成本项目的 **LID**:`citations:[{lid, book_id, note}]`。使 `memory.recall` 返回的每条记忆**可验证、可跳原文**,是引用红线([docs/adr/0004])在记忆层的延伸。区别于 book 的 `citations[]`(那是问答证据;此为记忆溯源)。状态:NEW(详见 [docs/adr/0015])。

## effect 返回 / 错误分类+recovery
- **effect 返回** `[ADR-0015]`:`reader.*` 变更命令返回"变更后的相关状态"(gotoLid→viewport、note→{id}…)而非裸 ack,使 agent 能确认动作、闭环、re-sync(配 `reader.state()` 只读会话态)。
- **错误分类 + recovery** `[ADR-0015]`:统一错误信封 `{error_code, category∈{validation,not_found,provider,budget,internal}, message, recovery?}`。category 分流瞬时(provider/budget,可重试)vs 永久(not_found/validation,改输入)错;`recovery`(nearest_valid_lid / suggestions[] / {retriable,after_ms})**仅供 agent 自纠、系统永不自动套用**(守禁宽松降级,体检 §14)。状态:NEW(详见 [docs/adr/0015])。

## 命令面 (command surface)
阅读器的命令可寻址引擎。人类能做的每个阅读器动作都暴露为具名、可参数化、agent 可调用的命令;GUI 是其上一层渲染。E 及任意外部 agent 与人类走**同一命令面**(人机对称、无特供),agent-CLI 普适。**一套面、三命名空间**:`book.*`(只读内容查询 ②③)/ `reader.*`(可变 UI 控制)/ `memory.*`(记忆层读写)。硬边界:reader/memory 不得写只读基座。详见 [docs/adr/0007]。
**命令面分层** `[ADR-0014]`:命令面即 agent 的 tool 集,按是否调 LLM 分两层——**确定性命令 = 叶子工具**(见下),**LLM 命令 = 自建最小运行时被无状态调一次的暴露**(`book.query/synthesize`,本身即 agent loop)。

## Reader UI Control Plane
阅读器页面布局与面板状态的可命令化控制面,属于 `reader.*` 可变 UI 会话态。agent 不直接操作 DOM,只能发受控 `ReaderLayoutAction`(如 open/close/focus slot、切换 layout preset、pin evidence),由后端 session layout state 校验并产出可撤销 effect,前端按 profile registry 渲染同步状态。它不写 book truth、paper truth、BookStructure 或 memory。状态:NEW(详见 [docs/adr/0060])。

## 叶子工具 (leaf tool)
确定性命令在"命令面即 agent tool 集"分层中的角色 `[ADR-0014]`:无 LLM、毫秒级、可组合的 primitive,agent loop 直接调它们捞素材。`book.manifest`(确定性拓扑)/ `book.context`(纯指针 near/mid/far,`{lid,layer,via}`)/ `book.text`(按 LID/区间取真原文)/ `book.concept`(概念全量 occurrences)即四个 book.* 叶子工具。区别于 LLM 命令(运行时暴露)。状态:NEW(详见 [docs/adr/0014])。

## 段 (paragraph / 叶子块)
切分的中间叶子单元 = 源格式的一个块级标记(md 段/列表项/引用块/代码块;epub p/li/blockquote/br)。**忠实映射源块的结构类型,不检测文学体裁**;诗行、对话轮靠块边界天然落位(非按体裁识别),裸 txt 退化到空行。切片0 的最深 LID 层。注:`code/table/image/formula` 四类块级标记是带类型的一等 **asset 叶子**(见下),非普通 paragraph;其中 formula 另有公式语义剖面。状态:NEW(详见 [docs/adr/0008/0029])。

## asset 叶子 (asset leaf)
代码块 / 表 / 图 / 公式四类**带类型的一等 LID 叶子** `[ADR-0029]`(`NodeKind ∈ {Code,Table,Image,Formula}`,闭集可扩展)。仍是 LID 树叶子:**占 source span、进分区不变式划分、用 LID 单一寻址**(不引第二套 asset_id)。**原文 = 源标记的确定性序列化**(image=`![alt](src)`、code 保留换行缩进、table 保留表文本、formula 保留 LaTeX/MathML 源标记),`book.text(asset_lid)` 返回它,确定性+忠实;`book.manifest` 节点带 `kind` 暴露可见性(零新基础命令,agent 过滤 kind 定位)。Code/Table/Image 作为普通可锚 LID 进入图谱;Formula 额外要求公式语义剖面(见下),让 agent 交互时能拿到参数、组合含义和上下文关系。多模态图理解(描述图)留切片1+、走"标注来源"旁路、**不进只读基座**。源自 `参考.md` 文档世界状态「让图/表/代码不从链路消失」并扩展到技术/数学书的公式状态。状态:NEW(详见 [docs/adr/0029])。

## 行内公式 LID (inline formula LID)
源段落内部的 `$...$` 或 EPUB 段内 MathML 公式也是 Formula 叶子 `[ADR-0029 执行回填]`:预构建切分时将其从所在文本段拆出为独立 `NodeKind=Formula` LID,公式前后的文字保留为相邻 paragraph LID。它不是段内 occurrence/span sidecar,不引入第二套公式 id;`book.text(formula_lid)` 返回公式源标记,PB6 `formula_lids`、`formula_semantics.json`、前端点击/Formula tab 均复用真实 formula LID 路径。状态:BOUNDARY_CHANGE(2026-07-03)。

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
- **内层 = `book.query` 自含 mini-loop**(无状态,被外层调一次,裸调即完整):外层提交自含问题、显式 referents 与回答义务;内层先从本地 ReferentCatalog 产候选并冻结唯一 binding,再围绕该 binding 回读来源 LID、由 LLM 判断开放语义支持度,最后由结构硬闸校验义务覆盖与 citations。anchor 仅是同级排序先验,不再定义检索边界。
状态:BOUNDARY_CHANGE(基础双层 loop 承 [docs/adr/0016],query 内层由 [docs/adr/0077] 修订)。

## ModelAdapter (provider 适配层)
统一 loop 骨架与具体后端之间的薄序列化层 `[ADR-0016]`。loop 控制(请求校验、候选/证据预算、停机、状态聚合、citations 校验)**provider 无关恒定**,只通过 `complete(messages, tools?, schema?) → ParsedResponse` 跟模型打交道;两实现:**NativeAdapter**(原生 tools API + JSON mode,直接拿结构化)/ **ReActAdapter**(无原生 tool-calling 的弱后端:注入 ReAct/JSON 模板 + 解析文本回填成同一 ParsedResponse)。弱后端只改输出解析方式;开放语义相关性由 LLM 判断,结构红线([docs/adr/0004])仍由确定性 citations 过滤。状态:BOUNDARY_CHANGE(详见 [docs/adr/0016][docs/adr/0077])。

## book.query / book.synthesize(LLM 命令分工)
两个 LLM 命令按**证据所有权**分工:`book.query(query,intent,targets,obligations,anchor_lid)` 只处理显式 referent 的语义问答,系统先解析 target、冻结唯一 referent,再围绕它隐式取证并回答;`anchor_lid` 只作弱排序先验。`book.synthesize(lids:[LID...], task?)` 由调用方拥有证据选择权,系统只在给定离散 LID 内综合、无检索、无外扩。章节主旨/论文贡献先用 `book.structure`/`book.guide_path`(technical book)或 `book.paper_reading_guide`(paper)选 LID 再 synthesize;当前 passage 优先 `book.text`/`book.context` 或已知 LID 的 synthesize;query 不承担文档级搜索,也不在答后重复调用 synthesize。两者 citations 都只能指向各自允许的来源 LID。状态:BOUNDARY_CHANGE(原分工承 [docs/adr/0017],query 边界由 [docs/adr/0077] 修订)。

## Query referent / frozen referent binding
**Query referent** 是外层 Agent 在 `book.query` 请求中显式声明、需要内层回答其语义问题的自然语言逻辑对象;它不是用户原话、anchor LID 或附近主题。内层 Resolver 必须把每个 target 映射到唯一 catalog candidate 后形成 **frozen referent binding**,取证期间不得再被 anchor 邻文或后来出现的候选替换。多义未消除则返回 ambiguous,无可接受候选则 unresolved,均不得生成语义答案。状态:NEW(详见 [docs/adr/0077])。

## ReferentCatalog
读时本地 referent 路由索引的统一名称:technical book 以 graph Concept/Entity 为目录,paper 以 paper lexicon 为主、graph Concept/Entity 为兜底。它通过名称、显式 alias/acronym 与自身 occurrence 文本产生候选,不依赖向量服务,也不要求构建期穷举所有别名。catalog、候选摘录、gloss 和图谱边都只是 routing artifact;只有候选冻结后回读的真实来源 LID 才能成为 query evidence。状态:NEW(详见 [docs/adr/0077])。

## Query obligation / PlanGate
**Query obligation** 是外层 Agent 随自含 query 一并声明的原子回答要求,只表达“这次必须回答什么”,不枚举定义、因果、类比、机制等关系逻辑,也不预先规定哪些来源可推出哪些关系。**PlanGate** 是内层对 query、targets 与 obligations 是否无损一致的语义 veto;缺项时只返回 invalid_plan 交外层修正,不得静默补题或缩题。状态:NEW(详见 [docs/adr/0077])。

## Query structural gate / semantic support assessment
`book.query` 的两类判定边界:**semantic support assessment** 由 LLM 阅读 frozen referent 的来源证据后开放判断每项 obligation 为 supported/uncertain/unsupported;程序不试图穷举知识关系。**Query structural gate** 只确定性检查请求合法、binding 唯一且冻结、每项 obligation 有 assessment、citation 位于证据包且 quote 来自对应真实 LID,再聚合 complete/partial/insufficient。排序分数不能补救结构闸失败。状态:NEW(详见 [docs/adr/0077])。

## QueryAudit
`book.query` 每次运行产生的旁路结构化审计:记录请求、候选、逐候选 fit、Resolver 结果、frozen bindings 及 selected round/rank、证据选择/预算/扩展/overflow、模型调用数、obligation assessments、citations 与结构闸结果。它供用户和开发者检查并随 resident Agent 回合历史持久化,但不进入 tool result、messages 或后续模型上下文,不充当来源证据,也不保存隐藏思维链。状态:NEW(详见 [docs/adr/0077])。

## scope-granularity 同轴半径 (legacy query retrieval)
`book.context` 的 near/mid/far 仍是从树邻接、local 边、概念二跳与 long_range 边确定性投影的累积半径 `[ADR-0013]`。`book.query` 原 local/chapter/cross_chapter/global anchor-scope 阶梯曾与它同轴,但该 query 用法已被 referent-first 取证取代:query 只能在 frozen referent 之后复用这些图谱/结构原语扩展证据,不得再以 anchor 为中心扫章或全书。状态:BOUNDARY_CHANGE([docs/adr/0077] 修订 [docs/adr/0016] 的 query 检索部分)。

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

## 区间视口 (interval viewport)
阅读器连续滚动模型中的后端视口 `[ADR-0043]`: `top_lid` 是当前阅读区间起点,`bottom_lid` 是当前阅读区间终点,`visible_lids` 是 `[top..top+width)` 叶序区间,`width` 是区间宽度。`anchor_lid` 仍由后端派生,表示区间中段叶,用于 agent/state 共享;它不再表示视觉中心或进度起点。`scroll(delta)` 移动 `top_lid`, `goto(lid)` 让目标叶成为 `top_lid`。状态:NEW(详见 [docs/adr/0043])。
## 虚拟阅读流 (virtual reader buffer)
前端连续阅读的渲染形态 `[ADR-0043]`:浏览器原生滚动驱动一条按叶序排列的长流,到缓冲边缘时调用 reader 区间视口命令补入新叶并回收旧叶。它是 `visible_lids` 的展示策略,不引入页码,不改变 LID 作为唯一引用锚。状态:NEW(详见 [docs/adr/0043])。
## note overlay
note 卡片的展示层 `[ADR-0043]`:note 内容仍来自 memory,overlay 只负责按当前可见 LID 过滤、定位和展示,避免 note 卡嵌入正文段落循环后污染虚拟列表的段高估算。highlight 仍是段内 `<mark>`。状态:NEW(详见 [docs/adr/0043])。
## 读位感 (reading position sense)
替代"页码"的位置参照 `[ADR-0028]`:**章节定位**(从当前 anchor 上溯容器 LID,显示"第N章 …")+ **进度%**(`anchor_idx` / 叶总数,确定性)。只做导航 / 显示,**不做引用锚**。本项目**无一等页码**——页在 reflowable / 连续滚动模型里物理不存在,造页号不可复现(违锚定红线);印刷版 page-list 仅当源 EPUB 携带时作 LID 展示标签(切片1+),citation 恒为 LID。状态:NEW(详见 [docs/adr/0028])。

## MemoryDocument
本地单用户、跨书的读者私人记忆真相源;统一容纳内容记录、画像事实及其审核状态,与只读书基座物理隔离。旧的裸记录数组是其待迁移前身,不是并列真相源。状态:BOUNDARY_CHANGE(详见 [docs/adr/0075])。

## ProfileFact
一条带来源、证据、信任状态和生命周期的结构化用户画像事实。`scope` 表示事实属于全局还是某本书,`applicability` 表示它适用于全部内容、某个 `content_profile`、论文 subtype 或领域;两者正交。状态:NEW(详见 [docs/adr/0075])。

## ProfileFactCapture (画像事实采集方式)
记录画像事实是在当前交互中采集,还是从用户选定的历史对话中回填;它与事实 `source` 正交。`HistoricalBackfill` 保留原始来源,但确认前始终为 `Pending`。状态:NEW(2026-07-14 M4 §0.5)。

## CollectionRule (画像采集规则)
用户对未来画像采集边界的持久规则,以画像事实类别、可选语义键与 `scope`/`applicability` 确定性限定哪些信息不得自动或回填进入画像。当前显式 `remember` 可作单次例外且不解除规则;已有事实只有经显式 `forget` 才清除。状态:NEW(2026-07-14 M4 §0.5)。

## ProfileScopeChange (画像作用域变更)
用户把既有画像事实显式重述到新 `scope` 的治理动作。它产生 `UserStated + Confirmed` 后继事实并 supersede 旧事实,不原地改写事实权威或审计链。状态:NEW(2026-07-14 M4 §0.5)。

## 显式画像证据记录 (explicit profile evidence record)
用户明确 remember 或 correct 画像时授权保留的来源原话,供 `ProfileFact` 审计与来源检查;它不是普通 context memory、不进入 snapshot,执行 forget 时必须与事实值一起物理删除。状态:NEW(详见 [docs/adr/0075])。

## 画像隐私分类 (profile privacy class)
画像写入前的三档确定性分类:`Normal` 可按显式意图保存,`Sensitive` 只允许用户明示并二次确认本地明文风险,`Secret` 在任何情况下都拒绝保存;分类 validator 可升级风险但不得降级。状态:NEW(详见 [docs/adr/0075])。

## ReaderPrivateStorageGate (读者私人存储闸)
保证本地明文读者记忆只对当前 OS 用户可读写的隐私边界。权限无法收紧或验证时必须停止私人 memory 读写并暴露可诊断状态,但不阻断不依赖私人记忆的普通阅读。状态:NEW(2026-07-14 M4 §0.5)。

## GlobalReaderProfile
从有效 `ProfileFact` 投影出的跨书稳定读者画像,只包含相关背景、领域能力、长期目标、稳定讲解偏好和长期约束。它不吸收单本阅读反应、临时情绪或普通 context memory。状态:NEW(详见 [docs/adr/0075])。

## BookReadingState
某一本书的读者私人阅读状态,由已读 LID、提问/笔记/高亮等原始行为信号、单本事实和当前 `MemoryPolicy` 投影组成。旧代码级 `ReaderProfile {read_lids, focus_lids, puzzle_heat}` 此后归入本术语;行为信号本身不证明困惑或掌握。状态:BOUNDARY_CHANGE(详见 [docs/adr/0075])。

## ReaderProfileSnapshot
runtime 在读者回合开始前从 `GlobalReaderProfile`、当前 `BookReadingState` 和适用事实组装的有界上下文视图。它自动注入住户 agent、可按账本重建,不是第二真相源,也不写入对话历史。状态:NEW(详见 [docs/adr/0075])。

## MemoryIntentGate
住户用户消息进入主 agent 前的显式记忆意图入口:结构化 UI 动作直接生成记忆操作,明确的“记住/纠正/忘记”表达才触发前台结构化抽取。未命中的普通表达不增加当前回答延迟,由后台审核兜底。状态:NEW(详见 [docs/adr/0075])。

## MemoryOp
由结构化 UI 动作或 `MemoryIntentGate` 前台抽取产生的 typed 画像记忆操作,统一表达 remember、correct 和 forget;它必须经过 source、scope、sensitivity 与 schema 校验后才能原子修改 `MemoryDocument`,不等同于普通 `memory.save(type=context)`。状态:NEW(详见 [docs/adr/0075])。

## ProfileGovernanceMutation (画像治理变更)
用户通过治理面发起的 typed 画像变更,由 `operation_id` 标识意图并以 `expected_document_revision` 保护并发状态。已成功的同 ID 同内容重放返回原结果,同 ID 异内容或未见请求的 stale revision 均冲突。状态:NEW(2026-07-14 M4 §0.5)。

## ProfileGovernanceSurface (画像治理面)
住户读者查看画像来源、集中审核并主动纠错的控制面,不是画像产生的必经流程。普通低风险更新保持自动且只给非阻塞通知;全局 Pending、敏感信息、不可逆 forget 与显式历史回填才要求用户主动动作。状态:NEW(2026-07-14 M4 §0.5)。

## ReviewJob / 记忆 consolidation
`ReviewJob` 是对住户会话未审核回合做增量事实抽取的持久任务;全局 consolidation 只消费已落账事实与跨书独立证据,生成待确认的全局候选。二者都由 runtime 调度并以 watermark 保证可恢复,不依赖主 agent 自愿调用 `memory.save/recall`。状态:BOUNDARY_CHANGE(详见 [docs/adr/0075])。

## HistoricalBackfillJob (历史画像回填任务)
用户显式发起、用于预览历史语义画像候选的持久任务,范围冻结为选定的住户会话及其当时的用户回合上界。其候选均以 `HistoricalBackfill + Pending` 进入集中审核;失败或取消保留已完成部分与进度,重试只补剩余范围,清除只移除任务与未确认候选,已确认事实只能经显式 `forget` 删除。状态:NEW(2026-07-14 M4 §0.5)。

## MemoryPolicy
`content_profile` 为读者记忆提供的语义解释策略:定义哪些私人信号值得提取、如何派生 profile-specific state、以及如何给快照候选排序。它不得改变 MemoryDocument、信任/删除规则、LID/citation 红线或直接生成自由文本提示;未知 profile 使用中性策略。状态:NEW(详见 [docs/adr/0075])。

## ProfileUsageTrace
一次住户回答对画像的可检查使用轨迹,区分 runtime 确定性注入的事实与模型声明实际参考的事实。模型声明不是客观因果证明,只能作为弱统计和用户解释入口。状态:NEW(详见 [docs/adr/0075])。

## ProfileMarkdownProjection (画像 Markdown 投影)
`reader-profile.md` 与 `reading-handbook.md` 是从画像真相源单向覆写的可检查派生视图,不接受反向写入。其 `current/stale/missing/unreadable` 状态由文件标记的 `projection_revision` 与当前真相源对比得出,不成为新的持久真相。状态:BOUNDARY_CHANGE(2026-07-14 M4 §0.5)。

## qa 提问活动 (qa activity)
读者在某 LID 留下的不同 qa 记录数,只证明发生过提问并构成私人关注信号,不单独证明困惑、难度或掌握程度。`technical_learning` 可将其用于回看排序,`paper` 等其他 MemoryPolicy 按自己的语义解释;`puzzle_heat` 仅是旧实现字段名。状态:BOUNDARY_CHANGE(详见 [docs/adr/0041], [docs/adr/0075])。

## agent 可撤销提议 (agent reversible proposal)
读时 E agent 在阅读器中对视图/标注的修改**是可撤销的提议、用户终裁** `[ADR-0030]`。agent **真执行**命令(守人机对称 [docs/adr/0007],命令面无特供),可撤销落**前端交互层**:用 effect 返回([docs/adr/0015])的反向命令 undo(goto 回原 anchor / `memory.delete(id)`)。**提议单元 = 一次对话回合**(`/agent/chat` 一次调用的全部副作用)= 事务性 undo。**agent 提议态 = 标注落 `layer=session`(临时),用户「保留」才升 `long_term`**(复用 memory 两层,零新字段;未处置走人则不污染长期记忆)。`orchestrator` 的 `OuterOutcome` 加 `effects[]`(副作用清单)+ `trace[]`(查询踪迹,对用户可见)承载之。状态:NEW(详见 [docs/adr/0030])。

## 读时会话边界 (reading session boundary)
对话会话的切分仍由用户显式控制 `[ADR-0030]`;idle 只触发 ReviewJob,不自动创建新对话。新对话、切书和 context compression 是记忆审核边界,新回合以自动 `ReaderProfileSnapshot` 冷启动而非依赖 agent 主动 recall。状态:BOUNDARY_CHANGE(详见 [docs/adr/0030], [docs/adr/0075])。

## agent 对话历史 (agent chat history)
住户 agent 的本地、读者私有、按 `book_id` 分组的可恢复对话会话列表 `[ADR-0030]`。它不是 memory 真相,但其中的用户回合可作为 ReviewJob 的画像证据引用;删除原会话不等同于执行 memory“忘记”,且历史绝不暴露给 visitor/MCP。状态:BOUNDARY_CHANGE(详见 [docs/adr/0030], [docs/adr/0075])。

## route(导航原语)
图谱上的**确定性多跳导航原语** `[ADR-0034]`,零 LLM,只保证返回的 LID/边真实("确定性 LID 由 route 保证")。两形态:`route_from(at)` = **前沿式内核**(站在当前 LID 返回可走的下一步);`route_to(from, target)` = 同批边上跑 BFS 的确定性组合(派生)。区别于 `book.context`(单跳"相关点"):route 是把 context 链起来 + 按边语义排序成"可导航下一步"的多跳找路。route 内核是 Core(架在 book.context 上);教学性排序/过滤属 technical_learning policy。状态:NEW(详见 [docs/adr/0034])。

## 前沿 (frontier) / 导航类别 (navigation category)
`route_from` 的返回形状 `[ADR-0034]`:不是一条平铺 ranked list,而是按导航语义分的 **5 个类别**——`back`(前置/背景)/ `forward`(深入/承接)/ `concretize`(例证/具体)/ `cross`(关联/跨章)/ `continue`(顺读)。`edge_type → 类别` 是固定确定性映射表(Core),组内按 weight×距离 排序。意图直接落到类别("没懂"→back,"给例子"→concretize)。状态:NEW(详见 [docs/adr/0034])。

## 住户 / 访客 (resident / visitor)
读时两类 agent 的本质区别 `[ADR-0034][ADR-0035]`:**住户**携带当前位置与自动注入的 `ReaderProfileSnapshot`,和读者有持续关系;**访客**只带外来意图和临时会话,不得读取、生成或修改读者私人记忆。可共享的是 route/世界模型,不可让渡的是读者私人层。状态:BOUNDARY_CHANGE(详见 [docs/adr/0034], [docs/adr/0035], [docs/adr/0075])。

## 三类记忆 (three memory classes)
读时记忆按可见性分三类 `[ADR-0035]`:**① 世界模型**(公共,可借:route/book.text/citation gate)/ **② 读者私人记忆**(durable + 读者所有:MemoryDocument/GlobalReaderProfile/BookReadingState)/ **③ 访客会话记忆**(ephemeral + 访客交互所有)。③ 不得成为②的证据来源。状态:BOUNDARY_CHANGE(详见 [docs/adr/0035], [docs/adr/0075])。

## 访客会话 (visitor session)
外部 agent 经 MCP 连接我们时的 ephemeral 会话 `[ADR-0035]`,**TCP 式握手/挥手**维护:握手发 `session_id`、传输期迭代引导(支持"不对"refine)、挥手即焚 + 超时 GC。内容 = `transcript`(交互记录)+ 临时**游标** `cursor{at_lid, last_frontier}`(访客自己的位置,≠ 读者 viewport)。绝不写入 ② 的 durable store。修订了 P7 原"无状态"假设(见 [docs/adr/0035])。状态:NEW(详见 [docs/adr/0035])。

## book_guide(访客向导命令)
外部 agent 投影的只读 LLM 命令 `[ADR-0035]`:`book_guide(intent, anchor?)` 返回 `意图→入口节点→route 路线(每步理由+证据 LID)`。是 `book_query` 的姊妹——**query 返答案,guide 返路线**。配访客会话态可跨调用 refine。返回全是真 LID/真边,外部可独立验证。状态:NEW(详见 [docs/adr/0035])。

## 反馈信号 (feedback signal)
带读 loop 中调整下一步的转向输入 `[ADR-0036]`。**唯一主信号 = 用户在停靠点的开放 NL 提问**(非闭集 token);viewport 偏离仅作弱旁路、`ReaderProfileSnapshot` 作慢先验,当前明确指令始终优先。状态:BOUNDARY_CHANGE(详见 [docs/adr/0036], [docs/adr/0075])。

## 导航轴 / 讲法轴 (navigation axis / explanation axis)
反馈意图的两个正交轴 `[ADR-0036]`:**导航轴**(去哪)落 `route_from` 的导航类别;**讲法轴**(怎么讲/多细/重讲)由当前 `MemoryPolicy` 消费 `BookReadingState` 与适用全局事实,不改变 route Core。裸“没懂”仍先使用确定性未读前置,不得把画像假设当成用户当前指令。状态:BOUNDARY_CHANGE(详见 [docs/adr/0036], [docs/adr/0075])。

## TechnicalLearningAgentPolicy(带读教学整形)
`technical_learning` 对 `route_from` 前沿和讲解方式的 profile policy `[ADR-0034][ADR-0037]`。它可消费已读与 qa/note/highlight 等原始活动及证据化学习假设,但不得从行为自动断言 novice/expert、掌握或卡点,也不得让 profile 偏见进入 route Core。状态:BOUNDARY_CHANGE(详见 [docs/adr/0037], [docs/adr/0075])。

## BookStructure(书籍结构地图)
content profile / extraction rule pack 驱动的预构建结构 sidecar `[ADR-0044/0048]`:描述一本书/论文的公共结构理解,用于“带我读”先讲总体框架/当前位置意义,再进入逐停靠点 route。它不是读时临时摘要、不是 `ReaderProfileSnapshot`、不是 memory;输入只来自公共书基座与 profile artifacts,不得混入用户私人层。状态:BOUNDARY_CHANGE(详见 [docs/adr/0044], [docs/adr/0048])。

## spine / throughline / key_stop
BookStructure 的三层骨架 `[ADR-0044]`:
- **spine**:书的教学展开主干,按结构单元表达“这本书如何展开”(如 setup/foundation/method/application/synthesis),保留阅读顺序和依赖。
- **throughline**:贯穿多个章节/单元的主题线,表达“一个问题如何跨书发展”,由 graph long_range、discourse、formula/pass2 evidence 支撑。
- **key_stop**:带读时值得停下讲的锚点(定义、核心公式、反直觉论断、转折、例子、总结段等),可被 spine 和 throughline 共同引用。状态:NEW(详见 [docs/adr/0044])。

## structure unit card
BookStructure 构建期的压缩中间卡片 `[ADR-0044]`:按章/节等结构单元从 LID tree、source excerpts、discourse summaries、graph claims/concepts、formula semantics 投影而来,记录单元 role、summary、candidate_key_stops、depends_on 和 evidence_lids。它是 stitching 全书 spine/throughlines 的输入,不是最终读时展示文案。状态:NEW(详见 [docs/adr/0044])。

## 结构投影 (structure projection)
BookStructure 在读时围绕某个 LID 投影出的结构解释 `[ADR-0045]`:回答“当前位置在全书/当前 spine/throughline/key_stop 中意味着什么”。它只消费公共 BookStructure sidecar 与真实 LID,不消费 `ReaderProfileSnapshot`、MemoryDocument 或读者 viewport。状态:BOUNDARY_CHANGE(详见 [docs/adr/0045], [docs/adr/0075])。

## 宏观带读路线 (guide path)
BookStructure 在读时提供的全书级带读路线 `[ADR-0045]`:按 spine 分段展开 key_stops,用于“先把这本书的重要地方过一遍”。它区别于 `guided_route_from`:guide path 是宏观路线,`guided_route_from` 是站在当前 LID 的局部转向前沿。状态:NEW(详见 [docs/adr/0045])。

## 带读目标自检 (guide target self-check)
非机械带读跳转的证据校验步骤 `[ADR-0045]`:LLM 可根据用户反馈选择候选 LID,但必须先读取该 LID 的真实原文与近邻上下文,判断是否满足目标,通过后才执行跳转。机械“继续/下一段”不触发此术语。状态:NEW(详见 [docs/adr/0045])。

## 构建工作区 (build workspace)
预构建期**单次构建**的中间产物目录 `[ADR-0042]`:`.understand-book/<bookId>/.build/`,build-only、`Book::load` 绝不读(区别于同级读时产物 base.json/source.txt/sidecar)。**只物化"贵且不可重算"的 LLM 输出**:唯一内容 = `pass1/<id>.json`(`{content_hash, nodes, edges}`,**一窗一文件、抽完即原子写**——会话可停在任意窗、已抽幸存);LID 树 / 窗口 / 输入正文等确定性派生一律用时从原书重算、不落盘(承 [docs/adr/0012] 不物化派生)。`<bookId>` 由 `deriveBookId(bookPath, override?)` 文件名 slug 派生(ASCII-safe,非 ASCII fail-fast 要 `--book-id`)。状态:NEW(详见 [docs/adr/0042])。

## 跨会话续建 (cross-session build resume)
Claude 在环驱动预构建时,**会话 token / 上下文耗尽后由新会话接着建**的机制 `[ADR-0042]`——真书数十窗 × Pass1 subagent 抽取一个会话跑不完,**跨会话是常态路径非异常**(承软工准则 A4 防上下文断裂)。物理前提 = **逐窗原子落盘**(每抽完一窗即写 `pass1/<id>.json`,旧"手工拼单一 outputs.json"会话死则全丢)。续建判定 = **存在性 + content-hash 校验,位置 id 键**(`content_hash = sha256(buildPass1Input(window).text)`;新会话重算窗口逐窗比对,在且一致 = done,缺失/不一致 = pending);**无状态位 / watermark / lock**(承 [docs/adr/0038][docs/adr/0039] 砍单机过度工程),中断 = 没文件 = pending(二值)。冷启动靠 **agent 续建契约**(写进 `skills/build/SKILL.md`,与 SESSION_CHECKPOINT C4/C5 同招):新 Claude `status <book>` 拿 pending → 逐窗 `emit-input` + subagent 抽取 + 原子写 → 全 done 跑 `pass1-batch` 收口(pending 默认拒绝收口)。区别于跨版本增量构建([docs/adr/0019],书改了复用旧基座 + LID 重锚)与内容寻址复用(留 [docs/adr/0042] 何时回头),二者本刀不做。状态:NEW(详见 [docs/adr/0042])。
## Hybrid paper source
Paper profile 的双源输入模型:Markdown 与原版 PDF 共同进入 source reconciliation,生成可信 `source.txt`;PDF-first reader 再用 map artifact 把 LID/range 投影回 PDF 页面。状态:BOUNDARY_CHANGE(见 [docs/adr/0063])。

## Source reconciliation
PDF-first paper build 中把 `paper.md + paper.pdf` 对齐、修复版面/编码差异、阻断内容冲突,并只在确定性门禁通过后产出可信 `source.txt/base.json` 的阶段。状态:NEW(见 [docs/adr/0063])。

## Source review decisions
Source reconciliation unresolved block 的用户复核记录,写入 `.build/source-reconciliation/review-decisions.json`。它只表达用户选择和备注,供后续 source reconciliation rerun/gate 消费;自身不生成可信 `source.txt`,也不能替代 content equivalence 与 realignment gate。状态:NEW(见 `docs/切片方案-paper-pdf-first-hybrid.md` PH16)。

## Bulk LLM source review decisions
用户在 Source reconciliation review surface 上一次明确选择,授权系统逐项请求 LLM 修订并把高置信、非 uncertain 的有效结果记录为 Source review decisions。批量操作允许部分成功:成功项保留决策,技术失败、无效输出、低置信或 uncertain 项继续留给用户逐项复核;它不是全有或全无事务,也不直接生成可信 `source.txt`。状态:BOUNDARY_CHANGE(见 `docs/切片方案-paper-pdf-first-hybrid.md` PH16)。

## Manual source override
Source review decisions 全部齐备后,系统只执行一次确定性 source reconciliation 重跑;若 reviewed draft 仍有 residual unresolved,用户终裁优先于这一次验证结果,该 reviewed draft 以显式 `manual_override` provenance 进入后续构建。残余报告必须保留用于审计,但不得再次生成同一轮来源复核或自动重跑。它不允许跳过首轮逐项复核,也不允许直接采用尚未持久化的 LLM suggestion。状态:BOUNDARY_CHANGE(见 [docs/adr/0065])。

## PDF visual source map
`pdf_source_map.json` 中从可信 LID/source span 到 PDF `pageIndex + bbox` 区域的轻量运行时映射。它用于把 citation、note、highlight 投影回 PDF 页面,但不替代 LID,也不是 citation anchor。状态:BOUNDARY_CHANGE(见 [docs/adr/0063])。

## PDF selection map
后端私有的 char-level、按页分片 PDF 反解 artifact,用于把 PDF 选区或语义 LID/range 转成可保存或可显示的 LID range / PDF rect。状态:NEW(见 [docs/adr/0063])。

## PDF 临时选区快照 (PDF selection draft)
PDF 原生拖选经 selection map 反解后形成的前端会话态:冻结规范 LID ranges、引用文本与工具条位置,只供用户显式选择高亮、笔记或 Ask AI;它不自动改变 reader 位置、不打开来源正文,在动作执行、取消或新选区替换时销毁。状态:NEW。

## PDF 选区翻译 (PDF selection translation)
BilingualAidLayer 对 PDF 临时选区提供的读时按需辅助:用户显式触发后,基于选中英文、规范 LID ranges 与论文术语上下文生成忠实中文译文。英文原文仍是唯一正文真相和 citation source;译文不进入 Agent 对话、不写 memory、不持久化。`paper_lexicon` 只在后台约束术语用词,不作为译文或独立展示内容。状态:NEW(2026-07-16 §0.5 PDF 选区翻译 Grill)。

## PDF 选区翻译浮层 (PDF selection translation surface)
锚在当前 PDF 选区旁、只显示中文译文的临时只读 surface。它不替换 PDF 正文,不承载术语讲解,关闭或产生新选区后销毁。状态:NEW(2026-07-16 §0.5 PDF 选区翻译 Grill)。

## PDF 用户标注投影 (PDF user annotation projection)
把用户主动保存的 Highlight 与 Note 从 memory 精确投影回原版 PDF 的可变展示层;它不显示自动 source-map regions,不改变 PDF/LID 真相,投影失败时不得用整段 bbox 猜测位置。状态:NEW。

## PDF 行内 Note 标记 (PDF inline note marker)
锚在 Note 持久化选区最后一个精确字符之后的小型交互标记;点击后打开与 Markdown Note 卡片一致的内容、编辑和删除界面。跨 LID/跨页选区以最后一个 range 作为显示锚,完整 ranges 保留为引用上下文;无法精确反向投影时只在 Notes 列表显示无法定位状态。状态:NEW。

## Ask AI 选区上下文 (Ask AI selection context)
Markdown 与 PDF 共用的临时引用草稿:保留现有首 LID 与完整 quote 展示,同时携带全部规范 ranges 和 `resolved/partial` 状态;它只在右栏等待用户输入问题,不自动发送、不写 memory、不改变 reader 位置,发送、清除或切换会话后销毁。状态:BOUNDARY_CHANGE。

## PDF-first reader surface
paper profile 的主阅读表面:中心区域在当前书具备可用 PDF capability 时渲染原版 PDF 页面,并通过 PDF visual source map 显示 LID 高亮、跳转和证据位置。Markdown/结构化正文仅作为调试、降级和未映射 LID 的 fallback 视图。状态:NEW(见 [docs/adr/0063])。

## Agentic paper minimap
paper reader 中常驻的辅助型全局导航:以 PDF 页/章节顺序为稳定坐标,默认只显示区域、当前位置和地标点,用户展开后才显示模式图层与局部论证关系。它不是摘要、阅读指南或第二主阅读面,agent 只能通过受控命令调整可撤销视图。状态:BOUNDARY_CHANGE(见 [docs/adr/0072])。

## Paper minimap base projection
由可信 LID tree、PDF visual source map、BookStructure、discourse 与 graph/Pass2 确定性组合的只读地图基座,包含区域、地标和证据化关系,不新增持久 paper truth。基础拓扑不可用时整图 unavailable;语义图层缺失时独立 degraded。状态:NEW(见 [docs/adr/0072])。

## Paper minimap mode lens
小地图的 `skim / abstract / deep` 展示口径:只改变地标筛选、强调和当前位置局部投影,不得重排 PDF/章节坐标,也不等同于 ReaderLayoutPreset。用户拥有模式控制权;agent 推断出的模式切换必须以 proposal 交由用户确认。状态:NEW(见 [docs/adr/0072])。

## Paper minimap position triad
小地图中相互独立的三个位置状态:`viewport_position` 表示用户实际看到的 PDF 范围,`selected_lid` 表示用户选择,`map_focus` 表示 agent 或用户当前强调。agent 改 map_focus 默认不触发正文导航。状态:NEW(见 [docs/adr/0072])。

## Paper minimap overlay
叠加在只读地图基座上的读者私有可变层:SessionOverlay 承载本会话焦点、强调和图层显隐,SavedUserOverlay 承载用户确认后跨会话保留的地标与覆盖。个人覆盖必须保留 provenance,不得改写派生地标或存入论文 workspace。状态:NEW(见 [docs/adr/0072])。

## Paper minimap action
人类与 resident agent 共用的 typed reader command,用于聚焦区域/地标、选择合法局部投影、调整图层和临时固定地标。后端 reducer 是最终权威:直接视图变化返回可撤销 effect,agent 推断的模式切换或长期状态变更返回 revision-bound proposal。状态:NEW(见 [docs/adr/0072])。

## 论文地图中文显示层 (paper minimap Chinese display layer)
面向中文母语读者的小地图可失效展示投影:首次加载时可由 LLM 把章节标题与地标描述批量转成中文,关系类型使用固定中文词表,模型、方法、数据集、指标和缩写等专有名词保留英文;英文正文、LID、citation、地图坐标与证据关系仍是唯一权威。结果按 book version 与 base fingerprint 缓存,滚动和跳转不得触发 LLM;Provider 不可用或输出无效时退回确定性中文类别与原始标签。状态:BOUNDARY_CHANGE(见 [docs/adr/0073])。

## Clean-room PDF extractor
不复制 AGPL 代码或资产的 PDF 抽取器实现边界。可以参考外部项目的架构分层和处理顺序,但不得复制源码、测试、模型、bundle、私有协议或受限资产;公共契约由本项目自定义。状态:NEW(见 [docs/adr/0063])。

## Alignment repair
PDF/Markdown 对齐失败时的可选修复机制。LLM 只能提出格式修复候选;是否进入可信 `source.txt` 必须由 content equivalence、确定性 aligner 和阈值决定,不得由 LLM 直接判断内容正确性或 page/bbox 正确性。状态:NEW(见 [docs/adr/0063])。

## Build Workbench
可信 `source.txt/base.json` 尚不存在、构建未完成或 source reconciliation 需要用户决策时使用的独立 build-mode 控制台。它承载 paper 输入上传/选择、draft workspace 创建、job 创建/续跑、server-side executor 启动、用户决策、执行权限审批、阶段 DAG、事件日志和 token/cost 观察;但不取代 `.build/<stage>` artifact 真相,也不把 job 状态当作 reader trust。状态:BOUNDARY_CHANGE(见 [docs/adr/0063] 与 `docs/切片方案-paper-pdf-first-hybrid.md` PH12-PH18)。

## Reader surface selection
paper workspace 的主界面由 reader trust gate 决定:未可信时必须显示 Build Workbench；一旦确定性 artifact readiness 给出 `route=reader`,当前构建流程立即进入 reader,历史 job 状态与界面偏好都不得阻塞或恢复 Workbench。可信书只允许用户从 reader 主动打开 Workbench 作为当前会话的诊断视图。状态:BOUNDARY_CHANGE(见 [docs/adr/0071],取代 [docs/adr/0066])。

## Build controller
Build Workbench 背后的服务端控制层:负责把上传的 `paper.md/paper.pdf` 固化为未信任输入 manifest,按 fingerprint 创建/复用 `.build/jobs/<job_id>.json`,启动 Codex/opencode/Claude/manual 等 executor adapter,把 stdout/stderr/heartbeat/权限请求/用户决策写成 job events,并在每次阶段结束后重新运行确定性 artifact gate。它只能驱动构建,不能绕过 `.build/<stage>` artifact/hash/schema gate。状态:NEW(见 `docs/切片方案-paper-pdf-first-hybrid.md` PH12-PH18)。

## 一键预构建 (guided automatic prebuild)
用户用一个命令授权 build orchestrator 自动推进适用阶段 DAG 的预构建方式。paper 的来源对齐与混合阅读基座仍由 Build Workbench 完成,一键命令从可信基座继续;非 paper 可从 Markdown/EPUB 原始输入开始。orchestrator 只在构建方向必须由用户裁决、需要额外权限或自动修复耗尽时暂停;普通阶段选择、执行器选择和恢复细节不暴露为用户工作。阶段是否完成仍只由 `.build/<stage>` artifact/hash/schema gate 判定,job、orchestrator 或 executor 的自述不能替代。状态:BOUNDARY_CHANGE(2026-07-11 §0.5)。

## Codex plugin
以 `.codex-plugin/plugin.json` 打包、由 Codex 安装和加载的本地预构建 harness 外壳。它通过 `$understand-book-build` 驱动现有确定性脚本与专用语义抽取契约,正常条件下一次调用完成、外部中断后按磁盘产物幂等续跑。paper 只消费 Build Workbench 已可信的混合阅读基座;非 paper 可从 Markdown/EPUB 原始输入开始。它不是 Web 内置模型 worker,不嵌入 Codex app-server,也不能绕过 artifact/hash/schema gate。状态:NEW(2026-07-11 §0.5)。

## Desktop Reader App
把现有 Vue reader 与 Rust localhost REST host 封装为 Windows 桌面应用的产品表面。第一版使用 Tauri 2 + WebView2,保留同源 REST 契约,支持无当前书启动、默认书库和外部 `.understand-book/<book_id>` workspace 注册且不复制产物。状态:BOUNDARY_CHANGE(详见 [docs/adr/0068])。

## 用户书库根目录 (user library root)
Desktop Reader App 中由当前用户选择、跨启动保持的唯一书库根路径,决定书库扫描范围与新建书写入位置。用户可选择普通父目录或现有 `.understand-book`;前者解析为其下的 `.understand-book`,后者直接复用。切换不迁移、不复制、不删除旧书库,当前已打开的书保持不变。状态:NEW(详见 [docs/adr/0069])。

## 桌面 Provider 设置 (desktop provider settings)
Desktop Reader App 当前用户为读时 LLM adapter 提供的模式、Base URL、Model 与 API Key 配置。保存成功后立即替换当前 server 的 adapter,不重启、不改变当前书与会话;保存只做确定性格式校验,不自动产生模型请求。API Key 暂按用户明确接受的风险明文保存在用户级设置中,界面不回显已存值。状态:NEW(详见 [docs/adr/0070])。

## Build Engine Sidecar
随 Desktop Reader App 安装、由 Codex plugin 调用但不直接展示的确定性预构建可执行程序 `understand-book-build.exe`。它承载 resolve/next/input/write/close/gate 与 protocol doctor,不执行语义模型;用户不需要安装 Node、pnpm 或 Cargo。状态:NEW(详见 [docs/adr/0068])。

## Windows Installer
用户首次运行的 per-user NSIS `UnderstandBookSetup.exe`:安装桌面阅读器与 Build Engine Sidecar,经明确授权后从公开 Git marketplace 安装 Codex plugin。阅读器安装与插件安装分事务;Codex/网络失败只产生可重试的待安装状态。状态:NEW(详见 [docs/adr/0068])。

## Plugin Installation Receipt
Windows Installer 对 Codex plugin 安装所有权的用户级记录。只有 `installed_by_reader_setup=true` 的插件才由阅读器卸载器默认提议移除;书库、`.understand-book` 与阅读记忆默认不删除。状态:NEW(详见 [docs/adr/0068])。

## Draft paper workspace
Build Workbench 接收 `paper.md + paper.pdf` 后形成的未信任论文构建目录。它可以保存 canonical 输入副本和 `.build/input/manifest.json`,但在 source reconciliation 与 artifact gate 通过前不得被 normal reader 当作可信书。状态:NEW(见 `docs/切片方案-paper-pdf-first-hybrid.md` PH12)。

## Workbench input manifest
Draft paper workspace 中记录原始 `paper.md/paper.pdf` 路径、sha256、profile、display title、config hash 与 current input fingerprint 的未信任 manifest。它只用于构建编排和 stale 判断,不替代 `.build/<stage>` accepted artifact。状态:NEW(见 `docs/切片方案-paper-pdf-first-hybrid.md` PH12)。

## Executor run contract
Build controller 为一次 server-side executor run 写出的未信任执行契约,包含 stage、scoped workdir、prompt、input manifest、允许输出路径、command summary 和权限策略。它只约束 executor 行为,不证明 stage artifact 可信。状态:NEW(见 `docs/切片方案-paper-pdf-first-hybrid.md` PH14)。

## BuildDecisionRequest
Build Workbench 中影响构建方向或阶段 readiness 的用户选择请求,区别于 Codex/opencode/Claude 等 executor 的工具权限请求。其答案必须写入 job event,若影响构建结果还要写入 stage decision artifact。状态:NEW(见 [docs/adr/0063])。
