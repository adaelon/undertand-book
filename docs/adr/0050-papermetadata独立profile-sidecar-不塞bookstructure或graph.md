# ADR-0050 PaperMetadata 独立 profile sidecar / 不塞 BookStructure 或 graph

状态:已接受(2026-07-05,PDF/paper §0.5 metadata 存储边界)

## 背景
ADR-0049 定义 paper 规则包同时抽取 PaperArgumentLayer 与 PaperMetadataLayer。ArgumentLayer 面向单篇读懂,与 BookStructure、graph、discourse 等阅读结构高度相关;MetadataLayer 则是 title、authors、venue、year、DOI/arXiv、references、dataset/code/funding links 等单篇公开事实,主要用于多论文 MCP 编排时做候选对齐。若把 metadata 塞进 BookStructure,会污染结构地图;若塞进 graph,会把书目字段误建模成实体/断言/边,提前冻结未实测的 schema。

## 决策
1. **PaperMetadataLayer 物化为独立 profile sidecar**:`paper_metadata.json` 承载单篇论文的书目/上下文元数据。
2. **不塞 BookStructure**:BookStructure 继续只表达 `spine + throughlines + key_stops`,服务带读、结构定位和 guide path。
3. **不塞 graph schema**:graph 继续表达 entity/concept/claim/edges;metadata 不新增 GraphNode/GraphEdge 类型。
4. **metadata 字段必须带来源**:正文/front matter 来源带 LID evidence;用户手填、文件名、DOI/arXiv resolver 或外部来源标 `source`。
5. **MCP projection 可读取 metadata sidecar**:单篇论文 MCP 可以用 `paper_metadata.json` 回答书目信息或为外部客户端提供对齐键,但不得据此单篇生成跨论文关系。
6. **sidecar 带 profile/version 头**:遵守 ADR-0033 profile artifact 版本头原则,便于后续迁移和冲突处理。

## 命门
- **metadata 是对齐键,不是阅读结构**:它辅助多论文编排,不该改变 BookStructure 的语义。
- **metadata 是公开事实,不是图谱关系**:是否形成作者演进、领域风潮、引用网络,必须等多篇证据进入 MCP 编排。
- **来源比字段本身更重要**:后续综合必须能区分正文证据、用户输入和外部 resolver。

## 否决
- 把 title/authors/venue/year 塞进 BookStructure summary/key_stops:污染带读结构地图。
- 为 metadata 新增 GraphNode.type / GraphEdge.type:过早 schema 扩张,且与当前 graph 语义边职责不符。
- 没有 provenance 的 metadata sidecar:多论文综合无法判断可信度和冲突来源。
- 单篇 metadata sidecar 直接产出 `same_author` / `same_period` / `topic_overlap`:违 ADR-0047,缺其他论文证据。

## 何时回头
- 多论文 MCP 编排中某类 metadata 反复升级为可验证关系时,另立 ADR 定义 project/corpus artifact。
- 外部 resolver 接入稳定后,补充 resolver provenance、冲突解决和刷新策略。
- paper metadata 被多个 profile 复用时,评估抽成通用 bibliographic sidecar。

## 影响
- `CONTEXT.md` 将 PaperMetadataLayer 定义为独立 `paper_metadata.json` profile artifact。
- `skills/build/SKILL.md` 后续应把 paper metadata 抽取作为 paper 规则包的独立 profile-sidecar 输出。
- 本 ADR 不定义最终 JSON schema;后续 Grill 继续细化字段形状和插槽归属。
