# 切片方案 · paper 规则包(英文论文阅读 + MCP 编排 + 双语辅助)

> **定位**:content profile / extraction rule pack 的第二个落地规则包。`technical_learning` 是当前默认规则包,`paper` 作为新增规则包接入同一 Core build pipeline。  
> **冻结决策**:ADR-0046 ~ ADR-0059。  
> **状态**:§0.5 Grill 已收口,未开工。当前不改代码;后续每个 PP 刀单独 A1 声明、单独验证。

---

## 0. §0.5 锁定决策摘要

1. **PDF MVP 形态** `[ADR-0046]`:用户提供 cleaned Markdown 作为正文真相;原版 PDF 是可选旁路附件;source map 可选但非 MVP 必需;内建 PDF/OCR normalizer 延后。
2. **跨论文关系归属** `[ADR-0047]`:跨论文比较/综述由外部 Claude/Codex 等 MCP 客户端连接多个单篇论文 MCP 后运行时编排;单篇预构建不生成全局 corpus graph。
3. **规则包化** `[ADR-0048]`:Core pipeline 固定;`technical_learning` 归档为默认规则包;`paper` 只替换/扩展固定插槽规则,不得改 LID/source/book.text/citation/gate/Core 命令面。
4. **双层抽取** `[ADR-0049]`:PaperArgumentLayer 服务单篇读懂;PaperMetadataLayer 服务多论文 MCP 候选对齐。
5. **metadata sidecar** `[ADR-0050~0052]`:`paper_metadata.json` 独立 profile sidecar;所有业务字段用 `MetadataField<T>` envelope;MVP 字段只覆盖跨论文对齐常用键。
6. **argument 不建新 sidecar** `[ADR-0053]`:PaperArgumentLayer 落在 BookStructure + graph + discourse sidecar 中,读时/MCP 按需投影。
7. **双语辅助** `[ADR-0054~0057]`:英文原文仍是唯一证据;`paper_lexicon.json` 是论文术语索引,不是中文讲义;普通词句解释走读时 + 用户 memory。
8. **阅读任务投影** `[ADR-0058]`:PaperReadingGuide projection 提供 skim/close/deep、passive/active/critical/creative、论文十问、PaperCodebook、AbstractReadingAid。
9. **subtype overlay** `[ADR-0059]`:`survey` 是 `paper` 内部 subtype,通过局部 overlay patch argument_shape / graph_edge_rules / metadata_extra_fields 等固定 slot;不得另起 `content_profile=survey` 或绕过 paper base 契约。

---

## 1. A1 阶段总声明

- **做**:把 `paper` 做成可插拔规则包,在不改变 Core 的前提下支持英文论文 cleaned Markdown 导入、paper metadata sidecar、paper lexicon sidecar、paper-specific argument 抽取规则、PaperReadingGuide MCP/读时 projection,并保留原 PDF 旁路附件能力。
- **不做**:
  - 不做内建 PDF/OCR normalizer。
  - 不把 page/bbox/source map 当 citation anchor。
  - 不新增 paper 专属 Core schema、`book.paper.*` 命令或独立 pipeline。
  - 不新增 `paper_argument.json`。
  - 不做跨论文 corpus graph、作者消歧、机构规范化、BibTeX/CSL 完整兼容。
  - 不全文预翻译中文,不把中文解释当证据。
- **完成判据**:能以 `content_profile=paper` 构建一篇 cleaned Markdown 英文论文,产出 `paper_metadata.json`、`paper_lexicon.json`、paper-aware BookStructure/graph/discourse artifacts,并通过读时/MCP projection 回答论文十问、提供 Codebook 和摘要中文辅助;所有论文事实回答可回到真实 LID evidence。

---

## 2. 规则包插槽契约

```text
Core pipeline 固定:
  load source -> segment LID -> split windows
  -> Pass1 -> profile-sidecar -> Pass2 -> BookStructure
  -> self-check/gate -> freeze base

paper rule pack 插槽:
  pass1_rules
  profile_sidecar_rules
  pass2_edge_contracts
  book_structure_rules
  paper_metadata_rules
  paper_lexicon_rules
  mcp_projection_rules
  answer_policy
```

规则包可以改变抽取关注点、prompt、edge contracts、projection 口径;不得改变 LID、source/book.text、citation anchor、确定性 gate、Core 命令面和 memory 隔离。

---

### 2.1 paper subtype overlay contract

`content_profile=paper` 先解析 paper base rules,再按 `paper_subtype` 叠加局部 overlay:

```text
Core pipeline
  -> paper.base rules
  -> paper.subtype.<primary_subtype> overlay
  -> paper.trait.* overlays
  -> user overrides
  -> validators
```

MVP 只要求支持:

```ts
type PaperSubtype = "research_article" | "survey";

interface PaperSubtypeOverlay {
  detect_rules?: Rule[];
  section_classification_rules?: Rule[];
  metadata_extra_fields?: FieldSpec[];
  argument_shape?: ArgumentShapeSpec;
  graph_edge_rules?: EdgeRule[];
  book_structure_rules?: StructureRule[];
  reading_guide_rules?: ProjectionRule[];
  validators?: Validator[];
}
```

`survey` overlay 的论证形状:

```text
field_scope
  -> taxonomy_axes
  -> literature_clusters
  -> comparison_dimensions
  -> synthesis_claims
  -> consensus_or_disagreement
  -> gaps_and_future_directions
```

综述对原文献的判断默认标 `claim_source=review_says`;只有接入原始论文 MCP 并验证后,才能标 `original_paper_verified`。

---

## 3. paper profile artifact 草案

### 3.1 ProfileArtifactHeader

沿用 ADR-0033 原则,所有 paper profile artifact 带版本头。

```ts
interface ProfileArtifactHeader {
  book_id: string;
  book_version: string;
  profile_id: "paper";
  profile_version: string;
  core_schema_version: string;
  generated_at: string;
}
```

### 3.2 paper_metadata.json

```ts
type MetadataSource =
  | "front_matter"
  | "paper_text"
  | "user_supplied"
  | "filename"
  | "external_resolver";

interface MetadataField<T> {
  value: T;
  source: MetadataSource;
  evidence_lids?: string[];
  confidence?: number;
}

interface PaperMetadata {
  header: ProfileArtifactHeader;
  title?: MetadataField<string>;
  authors?: MetadataField<Array<{ name: string; raw?: string }>>;
  affiliations?: MetadataField<string[]>;
  venue?: MetadataField<string>;
  year?: MetadataField<number>;
  identifiers?: {
    doi?: MetadataField<string>;
    arxiv?: MetadataField<string>;
    url?: MetadataField<string>;
  };
  keywords?: MetadataField<string[]>;
  field_labels?: MetadataField<string[]>;
  references?: MetadataField<Array<{ raw: string; identifiers?: Record<string, string> }>>;
  datasets?: MetadataField<string[]>;
  code_links?: MetadataField<string[]>;
  funding?: MetadataField<string[]>;
}
```

MVP 不做 canonical author id、institution id、CSL/BibTeX roundtrip、reference graph normalization。

### 3.3 paper_lexicon.json

```ts
type PaperTermType =
  | "paper_defined_term"
  | "method_name"
  | "acronym"
  | "domain_term"
  | "dataset_name"
  | "metric_name"
  | "model_name"
  | "academic_phrase";

interface PaperLexiconEntry {
  term: string;
  term_type: PaperTermType;
  occurrences_lids: string[];
  defined_at_lid?: string;
  aliases?: string[];
  acronym_expansion?: string;
  chinese_gloss?: string;
}

interface PaperLexicon {
  header: ProfileArtifactHeader;
  entries: PaperLexiconEntry[];
}
```

`occurrences_lids` 必填;`defined_at_lid` 仅限论文明确给出定义。深度中文解释、句法拆解和用户水平适配不预构建,读时生成。

---

## 4. A4 子切片顺序

### PP0 · 规则包入口与默认 technical_learning 归档

- **做**:为 build pipeline 引入显式 `content_profile` 概念,默认 `technical_learning`;现有 agent prompt / contracts / BookStructure 规则归档为 `technical_learning` rule pack。先做到行为不变。
- **不做**:不引入 paper 规则;不改现有产物语义。
- **判据**:不传 profile 时现有测试全绿;传 `technical_learning` 与默认行为等价;profile id 写入 profile artifacts header。
- **触达**:`skills/build/SKILL.md`, `agents/*`, build CLI/status/input/batch 相关脚本。

### PP0.5 · paper_subtype overlay resolver 与 survey skeleton

- **做**:在 `paper` 规则包内部引入 `paper_subtype` 与 overlay resolver,支持 `research_article` 默认 subtype 和 `survey` subtype skeleton;`survey` 只 patch argument_shape、metadata_extra_fields、graph_edge_rules、reading_guide_rules 等固定 slot;为综述 fixture 标注 `claim_source=review_says`。
- **不做**:不新增 `content_profile=survey`;不实现 full systematic review / meta-analysis;不接入原始论文 MCP 验证;不新增 `survey_argument.json`;不在 extractor 内散落 subtype if/else。
- **判据**:`content_profile=paper + paper_subtype=survey` 能 resolve 出 paper.base + survey overlay 的 effective rules;paper base invariants 被 validators 保留;最小 survey fixture 能产出 field_scope/taxonomy_axes/literature_clusters/comparison_dimensions/gaps 等候选结构;普通 research_article fixture 行为不变。
- **触达**:`[ADR-0059]`, rule registry / profile resolver / paper fixture。

### PP1 · PDF MVP 输入形态:Markdown canonical + optional PDF attachment

- **做**:构建入口接受 cleaned Markdown 作为 canonical source;可记录 optional original PDF attachment 路径/manifest 信息;source map 先只保留可选扩展点。
- **不做**:不解析 PDF;不 OCR;不承诺 LID 精确跳 PDF bbox。
- **判据**:Markdown 构建不受 PDF attachment 影响;没有 PDF 也可构建;有 PDF 时 metadata/manifest 能说明其为旁路附件。
- **触达**:`[ADR-0046]`

### PP2 · paper_metadata sidecar build flow

- **做**:新增 paper metadata 抽取/写入/批处理流程,产 `paper_metadata.json`;所有字段用 MetadataField envelope;支持 front_matter/paper_text/user_supplied/filename/external_resolver source。
- **不做**:不做 author disambiguation、institution canonicalization、BibTeX/CSL、reference graph。
- **判据**:fixture 论文能产出 MVP 字段;正文来源字段 evidence_lids 全真;裸字符串/裸数组输出被 gate 拒绝;缺字段允许 omit。
- **触达**:`[ADR-0050/0051/0052]`

### PP3 · paper_lexicon sidecar build flow

- **做**:新增 paper lexicon 抽取/写入/批处理流程,产 `paper_lexicon.json`;只收录理解本论文必需词项;每项必有 occurrences_lids;显式定义才有 defined_at_lid。
- **不做**:不做普通英语词典;不预生成长中文解释;不写用户私人词汇。
- **判据**:fixture 中方法名/缩写/数据集/指标能入 lexicon;普通词默认不入;无 occurrences 的条目被 gate 拒绝;首次出现不自动当定义。
- **触达**:`[ADR-0054~0057]`

### PP4 · paper Pass1 抽取规则

- **做**:为 paper rule pack 定义 Pass1 节点/局部边抽取规则,强化 research question、hypothesis、method、claim、evidence、limitation、dataset、metric、baseline、result 等对象的识别,但仍降成现有 entity/concept/claim/edge 形态。
- **不做**:不新增 GraphNode.type;不把 metadata 写入 graph;不做跨论文边。
- **判据**:fixture 中核心 claim/evidence/method/limitation 可被抽出并带 LID;悬空 LID 被 gate 丢弃;technical_learning fixture 不受影响。
- **触达**:`pass1-local-extractor` 的 profile-aware 规则。

### PP5 · paper discourse sidecar 规则

- **做**:扩展/替换 profile-sidecar 的 paper discourse 规则,识别 problem framing、related work positioning、method description、experiment setup、evidence report、result interpretation、limitation、future work 等段落功能。
- **不做**:不把 discourse 标签当最终推理结论;不强求每段都有高置信标签。
- **判据**:paper fixture 的 abstract/introduction/method/experiment/result/limitation 段落能被标注;低置信可 omit/pending;枚举/gate 规则清楚。
- **触达**:`profile-sidecar-extractor`, `discourse_index.json`。

### PP6 · paper Pass2 edge contracts

- **做**:定义 paper profile 的长程关系 contract,覆盖 method->result、claim->evidence、hypothesis->experiment、related_work->contrast/builds_on、limitation->future_work 等候选分类。
- **不做**:不自由发现跨论文关系;不接受 weak inference 入 base。
- **判据**:Pass2 work packet 能带 paper edge contracts;accepted_edges evidence 两侧非空且 LID 全真;weak 只进 pending/rejected。
- **触达**:`pass2-longrange-linker`, candidate builder。

### PP7 · paper BookStructure 规则

- **做**:复用 `book_structure.json`,为 paper 定义 spine/throughline/key_stop 选择策略:abstract/introduction/related work/method/experiment/result/discussion/limitation/conclusion 等结构单元映射到共享 shape。
- **不做**:不新增 `paper_structure.json`;不把 metadata 塞进 BookStructure。
- **判据**:fixture 论文能生成可读 spine、throughlines、key_stops;key_stop reason/evidence_lids 全真;metadata 仍在 paper_metadata。
- **触达**:`book-structure-extractor`, `book_structure.json`。

### PP8 · PaperReadingGuide projection

- **做**:实现 paper MCP/读时 projection,组合 BookStructure + graph + discourse + paper_metadata + paper_lexicon + book.text,提供 skim/close/deep、passive/active/critical/creative、论文十问、PaperCodebook、AbstractReadingAid。
- **不做**:不新增 `paper_questions.json`;不新增持久 Codebook;不把 creative 建议伪装成论文事实。
- **判据**:十问回答中论文事实带 LID evidence;model_supplement/user_reflection 明确标注;AbstractReadingAid 不生成全文翻译。
- **触达**:`[ADR-0058]`, MCP/read projection 层。

### PP9 · 单篇论文 MCP 投影与多论文编排边界

- **做**:让单篇论文 MCP 暴露本篇自我理解:metadata、lexicon、reading guide、query/synthesize evidence;外部 MCP 客户端可连接多个论文服务进行比较。
- **不做**:不在单篇 MCP 内生成跨论文全局关系;不写 corpus graph;不自动持久化跨论文综合。
- **判据**:两个 paper MCP 可以被同一客户端询问并返回各自 LID citations;综合结果默认只在会话层,显式保存才进 memory/note。
- **触达**:`[ADR-0047]`

### PP10 · fixture / golden tests / smoke

- **做**:准备最小英文研究论文 cleaned Markdown fixture,覆盖 front matter、abstract、method、experiment、result、references、acronyms、dataset/metric/code link;另准备最小 survey fixture,覆盖 taxonomy、comparison table/list、literature clusters、gaps。为 metadata、lexicon、discourse、BookStructure、ReadingGuide 建 golden 或 snapshot。
- **不做**:不以 LLM 自评作为唯一验收;不要求真实大论文一次跑完。
- **判据**:确定性 gate、schema validation、fixture snapshot、MCP projection smoke 全部可重复;没有客观判据的语义质量项标人工验收清单。
- **触达**:tests / fixtures / build smoke。

---

## 5. 总验收

```text
content_profile=technical_learning 行为不变
  ∧ content_profile=paper 可构建 cleaned Markdown 英文论文
  ∧ paper_metadata.json 字段全用 MetadataField envelope
  ∧ paper_lexicon.json 是术语索引且 occurrences_lids 全真
  ∧ PaperArgumentLayer 分布在 BookStructure + graph + discourse,无 paper_argument.json
  ∧ PaperReadingGuide projection 能回答十问并区分 evidence / supplement / reflection
  ∧ paper_subtype=survey 只通过 overlay patch 固定规则 slot,不突破 paper base invariants
  ∧ 综述转述原文献事实时区分 review_says / original_paper_verified
  ∧ 英文 source/book.text 仍是唯一 citation source
  ∧ 原版 PDF 只作为 optional sidecar attachment
```

## 6. 后续实测回填清单

| 项目 | 回填位置 |
| --- | --- |
| paper fixture 规模、窗口数、metadata 字段覆盖率 | ADR-0052 |
| lexicon 条目数、term_type 分布、普通词误收率 | ADR-0055/0057 |
| discourse 标签是否需要扩枚举 | ADR-0048/0053 |
| BookStructure 现有 role/key_stop 是否足够表达 paper | ADR-0044/0058 |
| ReadingGuide 十问回答的 evidence 覆盖率 | ADR-0058 |
| AbstractReadingAid 是否需要用户练习记录 | ADR-0054/0058 |
| survey subtype 的 taxonomy/comparison/gap 抽取稳定性 | ADR-0059 |
| review_says 与 original_paper_verified 的误标率 | ADR-0059 |
