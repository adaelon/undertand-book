# ADR-0049 paper 规则包双层抽取 / 论证链服务单篇读懂 / 元数据服务多论文 MCP 候选对齐

状态:已接受(2026-07-05,PDF/paper §0.5 抽取内容边界)

## 背景
paper 规则包不能只抽“论文论证链”。用户明确需要保留论文源数据,以便后续由多论文 MCP 编排分析作者研究方向演进、某时期论文风潮、论文发表时同领域进度等上下文关系。与此同时,ADR-0047 已决定跨论文关系不在单篇预构建期生成,而由外部 MCP 客户端连接多个单篇论文 MCP 后运行时建立。因此 paper 预构建需要同时服务单篇读懂和未来跨论文候选对齐,但不得越界生成全局关系。

## 决策
1. **paper 规则包预构建抽两层**:PaperArgumentLayer 与 PaperMetadataLayer。
2. **PaperArgumentLayer 服务单篇读懂**:围绕 `problem -> research_question -> method -> evidence -> claim -> limitation` 组织本篇论文的可验证理解,用于阅读、问答、带读和单篇论文 MCP 自我说明。
3. **PaperMetadataLayer 服务多论文候选对齐**:记录 title、authors、affiliations、venue、year/date、DOI/arXiv/URL、keywords、field/topic labels、references、dataset/code/funding links 等公开事实,供外部 MCP 客户端做作者、时期、领域、引用、数据集、主题等候选匹配。
4. **metadata 不直接生成跨论文关系**:单篇预构建只记录本篇事实;`same_author`、`same_period`、`cites`、`topic_overlap` 等跨论文关系由多论文 MCP 编排运行时产生,或由用户显式保存为 memory/note。
5. **metadata 字段必须标来源**:来自论文正文/front matter 的字段带 LID evidence;来自用户手填、文件名、DOI/arXiv resolver 或其他外部来源的字段必须标 `source`,不得伪装成正文证据。
6. **论证链优先保证 LID 证据质量**:ArgumentLayer 中 claim/evidence/limitation 等判断必须带真实 LID evidence;证据不足宁可 omit/pending,不得填模板。

## 命门
- **两层用途不同**:ArgumentLayer 解释“这篇论文说服力在哪里”;MetadataLayer 帮外部系统找“这篇论文可和谁对齐”。
- **公开事实不等于正文证据**:外部 resolver 得到的 DOI/venue 可以有用,但不能冒充来自 `book.text`。
- **单篇不替多篇下结论**:本篇 metadata 只能提供候选连接点,不声称作者演进、领域风潮或时代上下文。

## 否决
- 只抽论证链、不抽 metadata:会削弱多论文 MCP 编排的对齐能力。
- metadata 驱动 MVP,论证链降级:会偏离“读懂单篇论文”的核心产品价值。
- 单篇预构建直接写跨论文关系:缺少其他论文证据,且违 ADR-0047。
- 无来源字段的 metadata:后续综合无法区分正文事实、用户输入和外部解析结果。

## 何时回头
- 多论文 MCP 编排反复需要某类 metadata 时,将其从可选字段提升为 paper 规则包必抽字段。
- 外部 resolver 稳定接入后,定义 resolver provenance 与冲突处理 ADR。
- 用户需要项目级文献库时,另立 ADR 定义人工确认后的 corpus artifact。

## 影响
- `CONTEXT.md` 新增 `PaperArgumentLayer`、`PaperMetadataLayer`。
- paper 规则包后续插槽设计必须同时覆盖论证链抽取与 metadata 来源标注。
- BookStructure 仍是共享 sidecar;PaperArgumentLayer/MetadataLayer 是规则包抽取目标与投影视图,不等于新增独立 Core schema。
