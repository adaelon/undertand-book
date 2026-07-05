# ADR-0053 PaperArgument 不建独立 sidecar / 落在 BookStructure + graph + discourse 投影

状态:已接受(2026-07-05,PDF/paper §0.5 argument 存储边界)

## 背景
ADR-0049 定义 PaperArgumentLayer 围绕 `problem -> research_question -> method -> evidence -> claim -> limitation` 服务单篇论文读懂。随后已决定 PaperMetadataLayer 独立物化为 `paper_metadata.json`。需要进一步判断 ArgumentLayer 是否也要新增 `paper_argument.json`。现有系统已经有 BookStructure、graph 和 discourse sidecar,三者正好分别承载结构展开、论点/概念/语义边、段落功能与语篇关系。若再新增 paper_argument sidecar,会和这些 artifact 重叠,制造第二套论证真相。

## 决策
1. **不新增 `paper_argument.json`**。
2. **PaperArgumentLayer 落在现有 artifact 中**:
```text
BookStructure:
  论文整体展开、章节功能、spine/throughlines/key_stops

graph:
  claim / concept / entity / semantic edges

discourse sidecar:
  problem framing / method description / evidence report / limitation / future work 等段落功能
```
3. **MCP/读时按需投影 argument view**:单篇论文 MCP 可以提供 paper overview / claims / evidence / limitations 等视图,但这些视图从 BookStructure + graph + discourse sidecar 组合生成,不另存一套 truth。
4. **paper_metadata.json 只放 metadata**:metadata 与 argument 分层;metadata 不混入论证链。

## 命门
- **论证链不是新存储真相**:它是既有结构、图谱、语篇 artifact 的 paper-specific projection。
- **BookStructure 负责结构,graph 负责语义对象,discourse 负责段落功能**:三者组合足够表达论证链。
- **投影视图可定制,持久事实不复制**。

## 否决
- 新增 `paper_argument.json`:与 BookStructure/graph/discourse 重叠,增加一致性风险。
- 把所有 argument 信息塞进 BookStructure:claim/evidence/semantic edges 应留在 graph/discourse。
- 把 paper_metadata 和 argument 混在同一个 sidecar:书目对齐键与论证理解用途不同。

## 何时回头
- 如果 paper MCP projection 频繁需要高成本组合且性能不可接受,先考虑读时缓存 projection,而不是新增持久 truth。
- 如果 graph/discourse 无法表达某类论文论证对象,单独评估是否扩展对应 profile artifact。

## 影响
- `CONTEXT.md` 将 PaperArgumentLayer 标记为分布在 BookStructure + graph + discourse 的抽取目标/投影视图。
- `skills/build/SKILL.md` 后续应禁止新增 `paper_argument.json` 作为 MVP 产物。
- paper MCP projection 需从已有 artifact 组合出 argument view。
