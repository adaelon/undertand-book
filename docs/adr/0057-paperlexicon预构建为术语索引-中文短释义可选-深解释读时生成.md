# ADR-0057 paper_lexicon 预构建为术语索引 / 中文短释义可选 / 深解释读时生成

状态:已接受(2026-07-05,PDF/paper §0.5 lexicon 预构建价值)

## 背景
ADR-0054/0055/0056 已定义 BilingualAidLayer 与 `paper_lexicon.json` 的范围和证据规则。用户追问“预构建这个的意义是什么”,指出如果把 lexicon 做成预生成中文解释库,价值不清且容易膨胀。重新对齐后,lexicon 的预构建价值是:把本论文关键术语、缩写、方法名、数据集/指标/模型名等语言锚点提前索引化,而不是提前生成一套中文讲义。

## 决策
1. **paper_lexicon 预构建目标 = 论文术语索引**。
2. **预构建必须保存**:
```text
term
term_type
occurrences_lids
defined_at_lid?
aliases?
acronym_expansion?
```
3. **中文 gloss 可选且保持短释义**:可保存简短中文对译/提示,用于 UI 快速扫读,但不得替代英文原文。
4. **深度 explanation_zh 不作为预构建重点**:当前 LID 语境下“这个词为什么重要”、句法拆解、面向用户水平的中文讲解,由读时按需生成。
5. **预构建 lexicon 的价值**:降低读时识别成本、保持术语/缩写/别名一致、为 MCP/跨论文比较提供术语对齐候选。

## 命门
- **索引优先于解释**:预构建回答“哪些词重要、在哪里出现、是否被定义、有什么别名/缩写”,读时回答“这里怎么理解”。
- **短 gloss 不是论文事实**:它是中文辅助标签,证据仍是英文 LID。
- **不要把 lexicon 做成中文讲义**:长解释会随上下文和用户水平变化,更适合读时生成。

## 否决
- 预生成每个词的长中文解释:成本高、上下文不敏感、容易变成第二正文。
- 只保存中文解释而不保存 occurrences/aliases/acronym:失去索引价值。
- 把 gloss 当 citation evidence:违 BilingualAidLayer 红线。

## 何时回头
- 若读时重复生成同一术语解释成本高,可在 reader memory 或 projection cache 缓存用户级解释。
- 若某些领域固定术语需要高质量术语库,接入外部 terminology resolver 另开 ADR。

## 影响
- `CONTEXT.md` 将 `paper_lexicon.json` 定义为论文术语索引。
- `skills/build/SKILL.md` 同步:预构建必须产索引字段,短中文 gloss 可选,深解释留读时。
- 后续 schema 设计需加入 `term_type`,并弱化/可选 `explanation_zh`。
