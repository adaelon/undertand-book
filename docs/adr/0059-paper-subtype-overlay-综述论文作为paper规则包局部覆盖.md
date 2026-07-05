# ADR-0059 paper subtype overlay / 综述论文作为 paper 规则包局部覆盖

状态:已接受(2026-07-05, paper 规则包 §0.5 后续补充)

## 背景
`paper` 规则包已经固定为英文论文 content profile,但普通研究论文与综述类论文的论证形状不同。普通研究论文通常围绕 `problem -> method -> experiment -> result -> claim` 展开;综述论文更常围绕领域范围、分类轴、文献簇、比较维度、综合判断、共识/分歧和未来空白展开。若把综述做成新的顶层 `content_profile`,会复制 paper 的 LID、metadata、lexicon、PDF 旁路、MCP 投影等共同契约;若在 extractor 内散落 `if subtype === "survey"`,会让规则组合不可审计。

## 决策
1. **新增 `paper_subtype` 层**:`survey` 是 `content_profile=paper` 下的 subtype,不是新的顶层 profile。
2. **规则组合顺序固定**:
```text
Core pipeline
  -> paper.base rules
  -> paper.subtype.<primary_subtype> overlay
  -> paper.trait.* overlays
  -> user overrides
  -> validators
```
3. **subtype overlay 只 patch 固定 slot**:`detect_rules`、`section_classification_rules`、`metadata_extra_fields`、`argument_shape`、`graph_edge_rules`、`book_structure_rules`、`reading_guide_rules`、`validators`。
4. **paper base 不可被 subtype 覆盖**:cleaned Markdown 正文真相、LID citation anchor、原 PDF 旁路、`paper_metadata.json` 独立 sidecar、`paper_lexicon.json` 术语索引、无 `paper_argument.json`、单篇 MCP 不拥有跨论文数据库。
5. **`survey` overlay 的默认论证形状**:
```text
field_scope
  -> taxonomy_axes
  -> literature_clusters
  -> comparison_dimensions
  -> synthesis_claims
  -> consensus_or_disagreement
  -> gaps_and_future_directions
```
6. **综述转述必须标明事实来源**:`review_says` 表示本综述作者的转述/综合;只有接入原始论文 MCP 并验证后,才可标为 `original_paper_verified`。

## 命门
- subtype 改变抽取语义,不改变证据体系。
- `argument_shape.replace=true` 只能替换 argument slot,不能替换整个 `paper` 规则包。
- systematic review / meta-analysis 先作为 `survey` 上的 trait 候选,不急于升为顶层 subtype。

## 否决
- 新增 `content_profile=survey`:会复制 paper base 契约,并制造不必要的 Core 分支。
- 新增 `survey_argument.json`:违反 ADR-0053,论证仍应落在 BookStructure + graph + discourse 投影中。
- 在 extractor 里硬编码 subtype if/else:规则组合不可复用,也难以测试覆盖。
- 把综述中的原文献结论当作一手事实:除非连接并验证原始论文 MCP,否则只能说“综述作者如此报告”。

## 何时回头
- 当真实语料显示 `survey`、`systematic_review`、`meta_analysis` 的规则冲突超过 trait 能表达的范围时,再评估是否拆成多个 primary subtype。
- 当 subtype overlay 超过固定 slot 能表达的能力时,先扩展 overlay contract,不要下沉到 extractor 私有分支。

## 影响
- `CONTEXT.md` 增加 `paper_subtype`、`PaperSubtypeOverlay`、`survey subtype`、`review_says` / `original_paper_verified`。
- `docs/切片方案-paper规则包.md` 增加一个小切片,先支持 `survey` subtype overlay 的规则解析和 fixture。
- 不改变 ADR-0046~0058 的 base 约束,不新增 Core schema 或跨论文数据库。
