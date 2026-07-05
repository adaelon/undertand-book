# ADR-0052 PaperMetadata MVP 字段集 / 只覆盖跨论文对齐常用键 / 规范化消歧留 resolver 层

状态:已接受(2026-07-05,PDF/paper §0.5 metadata MVP 字段边界)

## 背景
ADR-0050 定义 `paper_metadata.json` 为独立 profile sidecar,ADR-0051 定义字段必须使用 `MetadataField` 来源信封。下一步需要收敛 MVP 字段范围。metadata 的目标是给多论文 MCP 编排提供候选对齐键,而不是在第一版就实现完整书目数据库、作者消歧、机构规范化或引文图谱。

## 决策
1. **MVP 字段只覆盖高频跨论文对齐键**。
2. **MVP 字段清单**:
```text
title
authors
affiliations
venue
year
identifiers: DOI / arXiv / URL
keywords
field_labels
references
datasets
code_links
funding
```
3. **所有字段遵守 MetadataField envelope**:不得出现裸字符串或裸数组。
4. **references 只做原始条目与可抽取标识**:MVP 不要求把 references 解析成完整 citation graph。
5. **datasets / code_links / funding 只在原文明确出现时抽取**:无证据则 omit,不猜。
6. **field_labels 可以来自正文或规则包推断,但必须标来源和 confidence**:不得把低置信主题标签当作作者声明。

## 明确不做
- citation style normalization。
- author disambiguation。
- institution canonicalization。
- BibTeX / CSL 完整兼容。
- reference graph normalization。
- DOI/arXiv resolver 冲突合并策略。

## 命门
- **够用的对齐键优先**:MCP 客户端需要先能按作者、年份、主题、引用、数据集、代码链接筛候选。
- **规范化不是抽取 MVP**:消歧与规范化需要 resolver/corpus 视角,不能压进单篇预构建。
- **缺字段不是失败**:论文没有 dataset/code/funding 时应 omit,不是编造空泛值。

## 否决
- 第一版做完整 bibliographic database:范围过大,且需要外部 resolver 和人工校验。
- 把 author/institution canonical id 写进 MVP:单篇证据不足以消歧。
- 把 references 直接写成跨论文边:违 ADR-0047,缺目标论文证据。

## 何时回头
- 多论文 MCP 编排反复卡在作者/机构歧义时,另立 resolver/corpus ADR。
- 用户需要导入/导出 Zotero/BibTeX/CSL 时,单独定义 bibliographic compatibility slice。
- references 需要跨论文可验证链接时,基于多篇 `paper_metadata.json` 和用户确认产出 corpus artifact。

## 影响
- `CONTEXT.md` 新增 `PaperMetadata MVP 字段集`。
- `skills/build/SKILL.md` 同步 MVP 字段清单与明确排除项。
- 后续 schema 设计需覆盖这些字段,但不得顺手加入规范化/消歧能力。
