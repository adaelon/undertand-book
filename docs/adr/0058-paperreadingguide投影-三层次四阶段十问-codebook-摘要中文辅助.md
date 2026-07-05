# ADR-0058 PaperReadingGuide 投影 / 三层次四阶段十问 / Codebook / 摘要中文辅助

状态:已接受(2026-07-05,PDF/paper §0.5 参考文献 insight 落档)

## 背景
参考《沈向洋、华刚:读科研论文的三个层次、四个阶段与十个问题》提出:读论文有速读、精读、研读三个层次;有消极、积极、批判、创造性四个阶段;读者应带着十个问题读论文;论文阅读是作者编码与读者解码之间的 Codebook 问题;中文母语用户读英文摘要时,翻译/复述过程能暴露理解漏洞。这些 insight 不应变成新的 Core schema 或全局数据库,而应进入 paper 规则包的读时/MCP 投影视图。

## 决策
1. **新增 PaperReadingGuide projection**:作为 paper 规则包的读时/MCP projection,从 BookStructure、graph、discourse、paper_metadata、paper_lexicon 和 `book.text` 组合生成“如何读这篇论文”的任务面。
2. **三层次映射为 PaperReadingMode**:
```text
skim  = 速读:标题 / 摘要 / 引言 / 贡献 / 是否值得读
close = 精读:问题 / 假设 / 方法 / 实验 / 证据 / 局限
deep  = 研读:复现 / 公式细节 / 实现路径 / 后续研究
```
3. **四阶段映射为 PaperReadingStage / answer policy**:
```text
passive  = 讲清这篇论文是什么
active   = 讲清它有什么用
critical = 挑假设、实验、证据、局限
creative = 推导可改进点、后续研究方向
```
4. **论文十问成为 paper MCP 标准问答面**:围绕问题/input-output、问题性质、hypothesis、相关研究/关键人物、核心贡献、实验设计、数据集、结果是否支撑假设、贡献总结、下一步工作组织回答。
5. **Codebook 由既有 artifact 组合**:`paper_lexicon.json` 解码术语/缩写/方法名,`paper_metadata.json` 给作者/领域/时间/引用上下文,BookStructure 给展开逻辑,discourse sidecar 给段落功能,graph 给 claim/evidence/limitation。
6. **AbstractReadingAid 加入 BilingualAidLayer**:针对摘要提供英文原文、关键术语、短中文释义、逐句理解检查和用户中文复述,帮助暴露没读懂的细节。
7. **不新增持久 truth**:PaperReadingGuide、十问回答、Codebook 和 AbstractReadingAid 都是 projection;不得复制 BookStructure/graph/discourse/metadata/lexicon 的事实。

## 命门
- **阅读任务面不是新数据库**:它组织已有证据,不制造第二套 paper truth。
- **十问答案必须可回证据**:凡声称来自论文的回答必须带 LID evidence;创造性建议或外部推断必须标 model_supplement / user reflection。
- **中文辅助不替代英文原文**:摘要中文复述是学习动作,不是 citation source。
- **阶段决定回答策略**:同一问题在 passive/critical/creative 阶段应有不同输出形态。

## 否决
- 为十问新增 `paper_questions.json`:问答面是 projection,答案随阅读阶段和用户问题变化。
- 为 Codebook 新增大一统产物:Codebook 是现有 artifacts 的组合视图。
- 把摘要全文预翻译作为只读基座:违 ADR-0054。
- 让 creative 阶段建议伪装成论文结论:必须区分论文证据与研究启发。

## 何时回头
- 如果 PaperReadingGuide projection 组合成本过高,先考虑读时缓存 projection,不新增持久 truth。
- 如果十问在真实使用中稳定沉淀为评审表,再评估可选 user/project-level note template。
- 如果摘要中文复述成为高频训练功能,另立 reader_profile / exercise policy ADR。

## 影响
- `CONTEXT.md` 新增 PaperReadingGuide projection、PaperReadingMode、PaperReadingStage、论文十问、PaperCodebook、AbstractReadingAid。
- `skills/build/SKILL.md` 后续应把 PaperReadingGuide 作为 paper 规则包的 MCP/读时 projection 契约。
- 不改 Core 命令面;不新增 `paper_questions.json` 或 Codebook 持久产物。
