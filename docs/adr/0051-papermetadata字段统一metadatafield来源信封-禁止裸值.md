# ADR-0051 PaperMetadata 字段统一 MetadataField 来源信封 / 禁止裸值

状态:已接受(2026-07-05,PDF/paper §0.5 metadata 字段形状)

## 背景
ADR-0050 已决定 PaperMetadataLayer 物化为独立 `paper_metadata.json`。metadata 将被多论文 MCP 编排用于作者、时期、领域、引用、数据集、主题等候选对齐。若字段只是裸字符串/数组,后续无法区分值来自论文正文、front matter、文件名、用户手填还是 DOI/arXiv resolver,也无法判断是否有 LID 证据。用户确认 metadata 字段应统一使用带来源的 envelope。

## 决策
1. **所有 paper metadata 业务字段使用 MetadataField envelope**。
2. **MetadataField 形状**:
```ts
type MetadataSource =
  | "front_matter"
  | "paper_text"
  | "user_supplied"
  | "filename"
  | "external_resolver";

type MetadataField<T> = {
  value: T;
  source: MetadataSource;
  evidence_lids?: string[];
  confidence?: number;
};
```
3. **正文可证字段必须带 LID evidence**:source 为 `front_matter` 或 `paper_text` 时,若字段来自 cleaned Markdown 正文,必须填 `evidence_lids`。
4. **外部/用户来源不得伪装正文证据**:`user_supplied`、`filename`、`external_resolver` 可以没有 `evidence_lids`,但必须保留 source。
5. **confidence 不替代证据**:confidence 只表示抽取/解析置信度;它不能让无 LID 的字段变成正文证据。
6. **数组字段也包 envelope**:authors、keywords、references 等集合字段可以选择 `MetadataField<Item[]>` 或 `MetadataField<Item>[]`,但元素/集合必须保留来源语义,不得退化为裸数组。

## 命门
- **来源是 metadata 的一等字段**:多论文 MCP 综合时必须知道可相信什么、该回查哪里。
- **LID evidence 只证明正文事实**:resolver 查到的 DOI 很有用,但不是 `book.text` 证据。
- **裸值会制造后续污染**:一旦 title/authors/year 失去来源,跨论文关系就无法审计。

## 否决
- `title: string` / `authors: string[]` 这类裸字段:来源丢失。
- 只在顶层写一个全局 `source`:同一 metadata 文件内字段可来自不同来源。
- 用 confidence 代替 evidence_lids:置信度不是可回跳证据。
- external resolver 结果默认覆盖正文字段:冲突处理另开,不得静默覆盖。

## 何时回头
- 需要表达多个候选值冲突时,扩展为 `candidates: MetadataField<T>[]` 或字段级 conflict 结构。
- resolver 稳定接入后,补充 resolver id、retrieved_at、raw payload hash。
- 引文条目字段稳定后,单独细化 `ReferenceMetadata` 的 envelope 粒度。

## 影响
- `CONTEXT.md` 新增 `MetadataField`,并将 `paper_metadata.json` 定义修正为字段统一 envelope。
- `skills/build/SKILL.md` 后续要求 paper metadata 输出禁止裸值。
- 本 ADR 不冻结 metadata 字段全集;后续 Grill 继续细化 MVP 字段清单。
