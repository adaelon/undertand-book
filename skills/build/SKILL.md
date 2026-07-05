---
name: build
description: Turn a book (epub/md) into a read-only knowledge-graph base for anchored-reasoning reading. Deterministic LID segmentation + LLM semantic-edge extraction, gated.
argument-hint: ["<path-to-epub-or-md> [--full]"]
---

# /understand-book:build

> **调用形态**:插件 skill 强制命名空间 = `/<插件名>:<skill文件夹名>`。本插件 name
> `understand-book`(`.claude-plugin/plugin.json`)+ skill 文件夹 `build` ⇒ 命令
> **`/understand-book:build`**。读时启动是另一个 skill `/understand-book:read`(留 S7)。

> **状态:S1–S3 确定性骨架 + PB5/PB6/PB3 跨会话续建脚手架已实现。** 段切分(S1)/
> 窗口(S2)/ Pass1 输入组装·merge+闸·目录投影(S3)落 `packages/core` 单测全绿;Pass1、
> profile-sidecar、Pass2 的 status/input/write/batch 流程均落 `.build/`。
> 余:**真书 + 真 LLM 语义质量试跑**(专门子代理逐窗抽取/分类 → 固化 `.understand-book/` → 自检闸实测)。

把一本书(`$ARGUMENTS` 指向的 epub/md)预构建成只读知识图谱基座,产物落
`.understand-book/`。预构建期绑当前 agent harness(本 skill 在 harness 内跑,
harness 供 LLM)`[ADR-0003]`;读时是独立产品,启动走 `/understand-book:read`(留 S7)。

## content_profile / extraction rule pack `[ADR-0033/0048]`

当前默认 `content_profile = technical_learning`。现有 `pass1-local-extractor`、
`profile-sidecar-extractor`、`pass2-longrange-linker`、`book-structure-extractor`
的抽取规则属于 `technical_learning` 规则包,不是 Core 全局真理。

后续新增 `paper` 等 profile 时,只能替换/扩展这些固定插槽的规则:
`pass1_rules`、`profile_sidecar_rules`、`pass2_edge_contracts`、
`book_structure_rules`、`mcp_projection_rules`、`answer_policy`。profile 不得改变
LID、source/book.text、citation anchor、确定性 gate、Core 命令面或 memory 隔离。

`paper` 规则包必须同时覆盖两层抽取 `[ADR-0049]`:
- **PaperArgumentLayer**:problem / research_question / method / evidence / claim / limitation,
  每个判断必须带真实 LID evidence。
- **PaperMetadataLayer**:title / authors / affiliations / venue / year / DOI/arXiv/URL /
  keywords / field labels / references / dataset-code-funding links。正文来源带 LID evidence,
  用户或外部 resolver 来源必须标 source。

PaperArgumentLayer 不物化独立 `paper_argument.json` `[ADR-0053]`;它落在
BookStructure(`spine/throughlines/key_stops`) + graph(entity/concept/claim/edges) +
discourse sidecar(段落功能/语篇关系)中,由 MCP/读时按需投影。

PaperMetadataLayer 物化为独立 profile sidecar `paper_metadata.json` `[ADR-0050]`。
它不塞进 `book_structure.json` 或 graph schema;BookStructure 仍只表达
`spine + throughlines + key_stops`,graph 仍只表达 entity/concept/claim/edges。
`paper_metadata.json` 的业务字段必须统一使用 `MetadataField<T>` 来源信封
`{value, source, evidence_lids?, confidence?}` `[ADR-0051]`;禁止裸字符串/裸数组字段。
MVP 字段集固定为 title、authors、affiliations、venue、year、identifiers(DOI/arXiv/URL)、
keywords、field_labels、references、datasets、code_links、funding `[ADR-0052]`。
不得在 MVP 中顺手做 citation style normalization、author disambiguation、
institution canonicalization、BibTeX/CSL 完整兼容或 reference graph normalization。

`paper` 规则包还应产出双语辅助 profile artifact `paper_lexicon.json` `[ADR-0054]`:
只抽论文关键术语、缩写、方法名、领域术语、数据集/指标/模型名、高价值学术短语等。
英文 `source/book.text` 仍是唯一正文真相;禁止全文预翻译成中文,禁止把中文解释当 citation evidence。
普通单词、短语和句子理解走读时按需解释 + 用户 memory,不写入公共基座。
`paper_lexicon.json` MVP 只收录理解本论文必需的公共词项 `[ADR-0055]`:
paper-defined terms、method names、acronyms、domain terms、dataset/metric/model names、
影响论证理解的 recurring academic phrases。普通英语生词默认不收录;只有当它在本论文中
成为术语、论证关键词或固定搭配影响论证理解时才可进入。
每个 lexicon 条目必须带 `occurrences_lids`;只有论文英文原文明确给出定义时才填
`defined_at_lid` `[ADR-0056]`。不得把首次出现位置、中文解释或模型常识伪装成定义位置。
`paper_lexicon.json` 的预构建目标是术语索引 `[ADR-0057]`:必须保存 term、term_type、
occurrences_lids、defined_at_lid?、aliases?、acronym_expansion?。短中文 gloss 可选;
深度中文解释、句法拆解和面向用户水平的讲解留给读时按上下文生成。

`paper` 规则包还应提供 `PaperReadingGuide` MCP/读时 projection `[ADR-0058]`:
- `PaperReadingMode`: skim / close / deep。
- `PaperReadingStage`: passive / active / critical / creative。
- 论文十问:问题/input-output、问题性质、hypothesis、相关研究/关键人物、核心贡献、
  实验设计、数据集、结果是否支撑假设、贡献总结、下一步工作。
- `PaperCodebook`:由 paper_lexicon + paper_metadata + BookStructure + discourse + graph 组合。
- `AbstractReadingAid`:摘要英文原文 + 关键术语 + 短中文释义 + 逐句理解检查 + 用户中文复述。
- 读时入口:REST `GET /book/paper_reading_guide?mode=&stage=`,runtime tool
  `book.paper_reading_guide`,MCP tool `book_paper_reading_guide`。
- 单篇论文 MCP 还暴露 `book_paper_metadata` / `book_paper_lexicon` 作为本篇 dossier
  与多论文客户端候选对齐键;不得在单篇服务内新增 cross-paper / corpus 关系工具。
这些都是 projection,不得新增 `paper_questions.json`、Codebook 持久产物或第二套 paper truth。

## 参数
- `$ARGUMENTS`:书路径(epub / markdown)。`--full` = 忽略已有基座强制全量重建。

## 构建期子代理授权与质量优先级

用户已授权预构建期**直接调用专门子代理**完成贵语义步骤:
`pass1-local-extractor`、`profile-sidecar-extractor`、`pass2-longrange-linker`、`book-structure-extractor`。这些子代理是
build-time harness 能力的一部分;TS 脚本只负责状态、输入、写盘、hash、gate 和 batch 收口。

质量优先级:
- **sidecar 语义质量优先于 token 节省**。`discourse_index.json` 与 `formula_semantics.json`
  直接影响读时解释、公式理解和后续 Pass2 packet 质量,不得用低信息量通用填充换取快速 done。
- 禁止把“schema 合法”当作“语义完成”。确定性 gate 只能验证 LID/enum/shape,不能替 LLM 判断
  `local_function`、`relations`、公式参数含义是否读对。
- 如果专门子代理不可用、窗口无法真实抽取、或 classifier 无法逐候选判断,**停止并报告阻塞**;
  不得改用 deterministic generic sidecar、空泛 formula 解释、或 Pass2 reject-all 作为常规完成路径。
- `--allow-partial` 只允许 smoke/救急且需用户显式要求;不得用它绕过语义抽取质量。

## 编排骨架(8 段管线)
0. **段/句粒度体检**(确定性,`skills/build/granularity-profile.ts` 经 tsx · SA0 ✓ `[ADR-0032]`):输出 `GranularityProfile`,用户确认 `paragraph/hybrid/sentence` 后才进入正式构建。
1. **导入 + LID 段级切分**(确定性,`skills/build/split-lid.ts` 经 tsx · S1 ✓ `[ADR-0008]`)
2. **窗口切分**(LID 子树 + 双约束预算,`packages/core/src/window.ts`;CLI `skills/build/window-cli.ts` · S2 ✓ `[ADR-0009]`)
3. **Pass1 局部抽取**:`packages/core/src/pass1-input.ts` 把每窗口组装成带 LID 标注的正文 → subagent `pass1-local-extractor`(5 并发,见 `agents/`)逐窗口出 `{nodes, edges(local)}` · S3 ✓骨架 `[ADR-0010]`
4. **merge + 确定性图谱闸**(`packages/core/src/merge.ts:mergeAndGate`;按类型合并 occurrences + 悬空丢不重建 + 最小连坐 + 可观测报告 · S3 ✓ `[ADR-0011]`)
5. **全局目录确定性投影**(`packages/core/src/catalog.ts:projectCatalog` · S3 ✓ `[ADR-0010]`)
6. **PB6 profile sidecar + Pass2 长程边**:subagent `profile-sidecar-extractor` 产 `discourse_index.json` / `formula_semantics.json`;subagent `pass2-longrange-linker` 逐候选分类 long_range 边。
7. **PB7 BookStructure 结构地图**:subagent `book-structure-extractor` 先逐结构单元产 unit cards,再 stitching 出 `spine + throughlines + key_stops`,经 gate 固化 `book_structure.json`。
8. **自检闸 + 固化只读基座**(分区不变式 + 锚定率 ≥90%,产 `.understand-book/` · 下一刀)

## 跨会话续建(冷启动契约)`[ADR-0042 · PB5]`

> **状态:PB5 已实现(ADR-0042)。** CLI `build-status` / `emit-input` / `pass1-write` / `pass1-batch`(续建改造)+ core `build-resume.ts`(`pass1ContentHash` / `computeBuildStatus` / `buildPass1Artifact`)+ `book-id.ts`(`deriveBookId`)落地且单测绿。
>
> build 由 Claude 在环驱动,真书数十窗 Pass1 抽取**一个会话跑不完**(token/上下文耗尽是常态,非异常)。任一**新会话零上下文**,纯靠 `.understand-book/<bookId>/.build/` 中间产物接手。下面是冷启动续建 loop,与 SESSION_CHECKPOINT(C4/C5 会话热启动)同招——只是冷启的是"构建状态"。

```
1. tsx skills/build/build-status.ts <book> [--book-id <id>]
   → done/pending 窗口 id(= 重算窗口逐窗 content-hash 校验 .build/pass1/<id>.json)
   # bookId = deriveBookId(<book>):文件名 slug;非 ASCII 主导报错,用 --book-id 显式指定
2. 对每个 pending 窗口 id:
   a. tsx skills/build/emit-input.ts <book> <id>            # 现算该窗 [LID] 前缀正文到 stdout(不落盘)
   b. 交 subagent pass1-local-extractor 抽 {nodes, edges(local)} → 存临时 out.json
   c. tsx skills/build/pass1-write.ts <book> <id> out.json   # 重算 hash + 原子写 .build/pass1/<id>.json
   # token 快耗尽就停:已写的全部幸存,下个会话从 build-status 接着来
3. 全 done → tsx skills/build/pass1-batch.ts <book>          # 消费 .build/pass1/* → merge/gate/固化 base + sidecar
   # 仍有 pending → 拒绝收口并报 pending ids(--allow-partial 显式兜底,只收 done 窗)
```

> **命门**:`pass1-write` 的 content_hash 由 TS 从窗口正文重算(`buildPass1Artifact`),agent 绝不手算 hash——书/切分变了则受影响窗口 hash 失配、`build-status` 判 pending 重抽,杜绝陈旧静默复用。

铁律:
- **逐窗原子写**:每抽完一窗立刻写其 `pass1/<id>.json`,绝不攒到末尾批量写(会话死=半成品全丢)。
- **冷启动只信磁盘**:新会话不依赖上个会话上下文里的任何东西;窗口确定性重算、`build-status` 给真相。
- **content_hash 锚新鲜度**:书/切分/profile 规则变了 → 受影响窗口 hash 失配 → `build-status` 判 pending 重抽,绝不静默复用陈旧抽取。
- `.build/` 是 build-only,`Book::load` 不读。

## paper Pass1 profile-aware 输入 `[PP4]`

`emit-input` / `pass1-write` / `pass1-batch` 在 `--content-profile paper` 时使用 profile-aware Pass1 input:

```text
PAPER_PASS1_RULES
content_profile: paper
paper_subtype: research_article | survey
argument_slots: ...
paper_edge_rules: ...

TEXT
[LID] source text...
```

`technical_learning` 路径保持旧输入逐字不变。Pass1 `content_hash` 绑定 profile-aware input,因此同一 source 的 technical artifact 不会被 paper 构建静默复用。

## 基座 schema(单一真相源)
基座类型由 Rust 权威定义(`crates/base-schema`,serde+ts-rs+schemars),ts-rs
生成 TS 给预构建用 `[ADR-0021]`。S0 先打通该生成链路(本仓库 `crates/base-schema`
→ `packages/core/src/generated/`)。
## profile-sidecar 独立抽取趟 `[PB6]`

> `discourse_index.json` 与 `formula_semantics.json` 不属于 Pass1 收口;不要把它们塞进 `pass1-batch`。PB6 是第二条独立 profile artifact 抽取趟:复用同一 window/input/hash,但读写 `.build/profile-sidecar/`。PP5 起 `--content-profile paper` 会在 input 的 `TEXT` 段内注入 `PAPER_DISCOURSE_RULES`,并将 content_hash 绑定到 profile-aware input。

```text
1. tsx skills/build/profile-sidecar-status.ts <book> [--book-id <id>]
   -> 查看 `.build/profile-sidecar/<id>.json` 的 done/pending(content_hash 校验)
2. 对每个 pending window id:
   a. tsx skills/build/profile-sidecar-input.ts <book> <id>
      -> 输出 visible_lids + formula_lids + `[LID]` 正文
   b. 交给 subagent profile-sidecar-extractor
      -> 只产 {discourse_items, formula_semantics}
   c. tsx skills/build/profile-sidecar-write.ts <book> <id> out.json
      -> 原子写 `.build/profile-sidecar/<id>.json`
3. 全 done -> tsx skills/build/profile-sidecar-batch.ts <book>
   -> 只写 `discourse_index.json` / `formula_semantics.json`
```

铁律:
- profile-sidecar batch 不改 `base.json` / `source.txt` / `profile_metadata.json` / `long_range_candidates.json`。
- `formula_lids` 由 `LidNode.kind === "formula"` 确定性注入,LLM 不判断哪些 LID 是公式。
- 每个 pending window 必须交 `profile-sidecar-extractor` 做真实语义抽取;不得用模板化 discourse item
  或“以相邻原文为准”这类通用 formula 解释填满 sidecar。
- 对公式语义,宁可让无证据公式保持 pending/omit 后暴露质量缺口,也不要编造参数、单位或组合含义。
- pending 默认拒绝收口;`--allow-partial` 只用于 smoke/救急。
- paper discourse 标签只表示段落功能,不是最终论证结论;低置信标签应 omit。

## paper_metadata 独立抽取趟 `[PP2]`

> `paper_metadata.json` 只在 `--content-profile paper` 下运行。它是 PaperMetadataLayer 的独立 profile sidecar,不写入 `book_structure.json` 或 graph。

```text
1. tsx skills/build/paper-metadata-status.ts <book> [--book-id <id>] --content-profile paper
   -> 查看 `.build/paper-metadata/<id>.json` 的 done/pending(content_hash 校验)
2. 对每个 pending window id:
   a. tsx skills/build/paper-metadata-input.ts <book> <id> --content-profile paper
      -> 输出 visible_lids + requested_fields + `[LID]` 正文
   b. 交给 subagent paper-metadata-extractor
      -> 只产 `{paper_metadata: {...}}`
   c. tsx skills/build/paper-metadata-write.ts <book> <id> out.json --content-profile paper
      -> 校验 MetadataField envelope / LID evidence 后原子写 `.build/paper-metadata/<id>.json`
3. 全 done -> tsx skills/build/paper-metadata-batch.ts <book> --content-profile paper
   -> 合并字段,写 `paper_metadata.json`
```

铁律:
- 所有业务字段必须是 `{value, source, evidence_lids?, confidence?}`;裸字符串/裸数组直接 fail-fast。
- `front_matter` / `paper_text` 来源字段必须带真实 LID evidence。
- 不做 author disambiguation、institution canonicalization、BibTeX/CSL 或 reference graph。
- pending 默认拒绝收口;`--allow-partial` 只用于 smoke/救急。

## paper_lexicon 独立抽取趟 `[PP3]`

> `paper_lexicon.json` 只在 `--content-profile paper` 下运行。它是论文术语索引,不是普通英语词典或中文讲义。

```text
1. tsx skills/build/paper-lexicon-status.ts <book> [--book-id <id>] --content-profile paper
   -> 查看 `.build/paper-lexicon/<id>.json` 的 done/pending(content_hash 校验)
2. 对每个 pending window id:
   a. tsx skills/build/paper-lexicon-input.ts <book> <id> --content-profile paper
      -> 输出 visible_lids + requested_term_types + `[LID]` 正文
   b. 交给 subagent paper-lexicon-extractor
      -> 只产 `{entries:[...]}`
   c. tsx skills/build/paper-lexicon-write.ts <book> <id> out.json --content-profile paper
      -> 校验 term_type / occurrences_lids / defined_at_lid 后原子写 `.build/paper-lexicon/<id>.json`
3. 全 done -> tsx skills/build/paper-lexicon-batch.ts <book> --content-profile paper
   -> 合并去重,写 `paper_lexicon.json`
```

铁律:
- 每个条目必须有非空 `occurrences_lids`,且全是真实 LID。
- `defined_at_lid` 只在论文明确给出定义时填写,且必须也出现在 `occurrences_lids` 中。
- 不收普通英语生词;不得预生成长中文解释或全文翻译。
- pending 默认拒绝收口;`--allow-partial` 只用于 smoke/救急。

## Pass2 长程边编排 `[PB3 + PB6]`

> Pass2 必须在 Pass1 `pass1-batch` 与 PB6 `profile-sidecar-batch` 都收口后运行。它从正式 `base.json`、`discourse_index.json`、`formula_semantics.json` 装配 work packet,不再从临时 candidate JSON 读取 discourse/formula。PP6 起 `--content-profile paper` 也可执行 Pass2,并使用扩展后的 paper edge contracts。

```text
1. tsx skills/build/pass2-status.ts <book> [--book-id <id>]
   -> 生成确定性 long_range 候选视图,按 source-window packet hash 检查 `.build/pass2/<id>.json`
   -> pending = 有候选且缺少/过期 LLM 分类的窗口; skipped = 无候选窗口
2. 对每个 pending window id:
   a. tsx skills/build/pass2-input.ts <book> <id> [--book-id <id>]
      -> 输出 Pass2WorkPacket(source text + source_nodes + PB6 discourse/formula 投影 + candidate_targets)
   b. 交给 subagent pass2-longrange-linker
      -> 只分类 candidate_targets 为 {accepted_edges,pending_edges,rejected_candidates}
   c. tsx skills/build/pass2-write.ts <book> <id> out.json [--book-id <id>]
      -> 用 packet hash 原子写 `.build/pass2/<id>.json`
3. 全 candidate windows done -> tsx skills/build/pass2-batch.ts <book> [--book-id <id>]
   -> 写 `long_range_candidates.json`;用 PB3 gate 替换 `base.json` 中的 long_range 边;写 `pass2_audit.json`
```

PP6 paper edge types:
`claim_supported_by_evidence`, `method_supports_result`,
`hypothesis_tested_by_experiment`, `related_work_contrasts`,
`related_work_builds_on`, `limitation_motivates_future_work`。

铁律:
- `pass2-longrange-linker` 只分类给定候选,不得新增候选、节点或 local 边。
- 每个 pending candidate window 必须交 `pass2-longrange-linker` 逐候选分类;不得用“全部 rejected”
  作为省 token 的默认策略。批量拒绝只允许在每条候选都真实读证据后自然发生。
- `pass2-batch` 默认拒绝 pending;`--allow-partial` 只用于 smoke/救急。
- `pass2-batch` 替换旧 long_range 边,保留 local 边;不要手工编辑 `base.json`。

## BookStructure 结构地图编排 `[PB7]`

> BookStructure 必须在 `profile-sidecar-batch` 与 `pass2-batch` 都收口后运行。它只从公共书基座与 profile artifacts 装配输入,不读取 reader_profile / memory / note / highlight / 当前用户问题。PP7 起 `--content-profile paper` 会在 unit/stitch packet 中携带 `PAPER_BOOK_STRUCTURE_RULES`,但输出仍是共享 `book_structure.json`。

```text
1. tsx skills/build/book-structure-status.ts <book> [--book-id <id>]
   -> 根据 `base.json` / `discourse_index.json` / `formula_semantics.json` / `pass2_audit.json`
      重算结构单元 unit jobs,按 content hash 检查 `.build/book-structure/units/<lid>.json`
2. 对每个 pending unit job:
   a. tsx skills/build/book-structure-input.ts <book> unit:<lid> [--book-id <id>]
      -> 输出 BookStructureUnitSource(public artifacts + LID excerpts)
   b. 交给 subagent book-structure-extractor
      -> 只产 `{unit_card}`
   c. tsx skills/build/book-structure-write.ts <book> unit:<lid> out.json [--book-id <id>]
      -> 用 unit input hash 原子写 `.build/book-structure/units/<lid>.json`
3. 全 unit done:
   a. tsx skills/build/book-structure-input.ts <book> stitch [--book-id <id>]
      -> 输出全书 unit_cards + long_range_edges stitching packet
   b. 交给 subagent book-structure-extractor
      -> 只产 `{spine, throughlines, key_stops}`
   c. tsx skills/build/book-structure-write.ts <book> stitch out.json [--book-id <id>]
      -> 原子写 `.build/book-structure/stitch.json`
4. stitch done -> tsx skills/build/book-structure-batch.ts <book> [--book-id <id>]
   -> gate LID/evidence/enum/reference shape,写 `book_structure.json`
```

铁律:
- BookStructure batch 不改 `base.json` / `source.txt` / `discourse_index.json` / `formula_semantics.json` / `pass2_audit.json`。
- unit card 与 stitch 都必须交 `book-structure-extractor` 做真实结构判断;不得用章节标题模板或自由导读文章代替。
- 每个 summary / reason / throughline 都必须有真 LID evidence;悬空 LID/reference 由 deterministic gate 丢弃。
- paper profile 不新增 `paper_structure.json`,不把 title/authors/venue/references 等 metadata 塞进 BookStructure;metadata 仍在 `paper_metadata.json`。
- pending 默认拒绝收口;读时 Rust loader / guided-reading projection 只能在 `book_structure.json` 能生成并过 gate 后再做。
