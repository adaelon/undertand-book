# 切片方案 · Asset 一等对象(代码块/表/图/公式 进入文档世界状态)

> **定位**:切片1+ 独立刀,**与「切片1 前端阅读器」并列、互不混入**。源 `参考.md` 文档世界状态对照,§0.5 领域对齐见 `docs/adr/0029`;段/句粒度体检见 `docs/adr/0032`。
> **被消费的冻结契约**:`需求文档-V3.md §3.1`(NodeKind)+ `§4.1`(`book.manifest`);术语见 `CONTEXT.md`(asset 叶子 / 公式语义剖面)。
> **状态**:**已规划落档,未开工**。2026-06-25 修订:Formula 升格为第四类核心 asset。

---

## 0. §0.5 锁定决策摘要(全文见 ADR-0029)

1. **身份** = 带类型 LID 叶子;`NodeKind` 增 `Code/Table/Image/Formula`;占 span、进分区不变式、LID 单一寻址。
2. **原文** = 源标记确定性序列化(image=`![alt](src)`、code 保格式、table 保表文本、formula 保 LaTeX/MathML 源标记);`book.text` 返回它。
3. **读时可见** = `ManifestNode` 投影 `kind`,零新基础命令;`inspect_asset`=`book.text`+前端渲染;`inspect_formula` 额外消费 FormulaSemantics。
4. **类型闭集** = `{Code,Table,Image,Formula}`;公式不再是长尾。
5. **图谱层接纳 asset;Formula 高优先级增强**:公式必须产出 parameters/composition/context_links,agent 交互时优先喂入。
6. **段/句粒度先体检再选择**:导入前统计段落句数、长段占比、预计 LID 膨胀比,给出 `paragraph / hybrid / sentence` 三档建议,由用户确认粒度后再正式构建(见 ADR-0032)。公式/代码/表/图固定为不可句切 asset 叶子。

---

## 1. A1 切片总声明

- **做**:先跑段/句粒度体检报告,让用户在 `paragraph / hybrid / sentence` 中确认构建粒度;再让 code/table/image/formula 四类 asset 从 ingestion 入口起成为带类型的一等 LID 叶子——`NodeKind` 扩 + `ManifestNode` 暴露 `kind`(ts-rs 重生成);md/epub adapter **忠实识别并序列化** asset(修四类 bug:epub `<img>` 消失 / `<table>` 丢失 / `<pre>` 被 norm 拍平 / formula 被段落拍平或句切拆碎);公式额外产出 `FormulaSemantics`(参数、组合含义、上下文关系,均带 LID 证据);分区不变式自检仍绿;真书重建后 `book.manifest` 看得到 asset 叶子。
- **不做**(明确排除):
  - ❌ 多模态图描述(切片1+,走"标注来源"旁路、不进只读基座)
  - ❌ `footnote/figure-caption` 等长尾类型(实测驱动再加)
  - ❌ 新增 `book.assets(kind?)` 命令(manifest+kind 先够)
  - ❌ 前端 asset 渲染(属「切片1 前端」刀 + S10j)
  - ❌ table 子结构 LID(先存表文本,按行列检索留后)
  - ❌ 公式 CAS/符号推导证明(本刀做阅读语义剖面,不是数学求解器)
  - ❌ 旧基座自动迁移(重建获得 asset,承 ADR-0019)
  - ❌ 默认全书句级展开(必须经体检报告 + 用户确认;默认建议可为 hybrid)
- **完成判据**:① 粒度体检报告输出段/句统计、预计 LID 膨胀比与三档建议,用户确认构建粒度;② `NodeKind`/`ManifestNode` schema 扩 + ts-rs 生成含四类 asset 枚举;③ md/epub adapter 把 code/table/image/formula 识别成对应 kind 叶子、原文=源标记序列化、`partition.ts` 分区不变式测仍绿;④ 公式产出 FormulaSemantics,每个参数/组合解释/上下文关系都带 `source_lid` 或 `evidence_lids`;⑤ `book.manifest` 节点带 `kind`;⑥ 一本真书重建后 manifest 见 asset 叶子、`book.text` 取出源标记、公式语义剖面可被 agent 检索(**B2 真跑验**)。

---

## 2. A4 子切片(每步独立可验,依赖文件状态非会话内存)

> 语言归属:SA0=**TS**(packages/core 导入前体检);SA1=**Rust**(base-schema/read-tools);SA2–SA4=**TS**(packages/core);SA5=**TS + LLM 抽取契约**(公式语义剖面);SA6 跨段(真书重建)。

### SA0 · 段/句粒度体检报告:统计后再让用户选粒度 `[TS]`
- **做**:在正式构建 LID 前,对源书先跑确定性体检:统计段落数、估算句子数、每段句数分布(avg/p50/p90/max)、长段数量(如 >5 句、>10 句、>800 字符)、asset 候选数量(code/table/image/formula)、`paragraph / hybrid / sentence` 三档预计 LID 数与膨胀比。输出 `GranularityProfile` 报告和推荐档位;用户确认后再进入 SA1–SA6。
- **不做**:不让 LLM 判断粒度;不默认全书句级;不把 hybrid 的阈值写死成不可改契约(阈值由实测回填)。
- **判据**:给一本真书能产出可读报告;报告能说明推荐 `paragraph / hybrid / sentence` 的理由和 asset 数量影响;同一输入多次运行结果一致;用户未确认粒度时不进入正式构建。
- **触达**:`[ADR-0032/0008/0009/0029]`
- **实测落点**:本书 paragraph_count / sentence_count_estimate / p90 句数 / 预计 LID 膨胀比 / formula_count / 最终用户选择。

### SA1 · schema 扩:NodeKind 增四值 + ManifestNode 暴露 kind + FormulaSemantics `[Rust]`
- **做**:`base-schema::NodeKind` 增 `Code/Table/Image/Formula`(serde snake_case)。`read-tools::ManifestNode` 加 `kind` 字段(投影 `LidNode.kind`)。新增/导出 `FormulaSemantics` 相关 schema(参数、组合含义、上下文关系,带证据 LID)。ts-rs 重生成 `NodeKind.ts` + `ManifestNode` + `FormulaSemantics` 导出。
- **不做**:不碰 ingestion(SA2+);不加 book.assets 命令;不做公式数学求值。
- **判据**:`cargo test` 全绿 + clippy 净;`book.manifest` 返回每节点带 kind;生成 TS 类型含 `Formula`;FormulaSemantics 反序列化/序列化 roundtrip 绿。
- **触达**:`[ADR-0029/0008/0014/0021]`
- **实测落点**:ManifestNode 是否已 `#[derive(TS)]` 导出;前端 `switch(kind)` 穷举更新点清单;FormulaSemantics 字段是否需要单位/维度扩展。

### SA2 · md-adapter:识别 fenced code / table / image / formula `[TS]`
- **做**:`markdownToBlocks` 识别 ` ``` ` 围栏代码块(**整块为一个 leaf,内部空行不腰斩**,保留换行缩进)、markdown 表(`| … |` 连续行成 table 块)、独立 image 行(`![alt](src)`)、块级公式(`$$...$$`)与行内公式所在段的公式叶策略(优先块级公式独立 leaf;行内公式是否拆 leaf 由实测回填)→ 带 asset kind 的 `SourceBlock`;其余仍 paragraph。`SourceBlock` 扩携带 asset 类型。
- **不做**:不让句切拆公式;不把公式归普通 paragraph 后再靠 LLM 猜;不接 epub(SA3)。
- **判据**:`vitest` 覆盖 code/table/image/formula 四类识别 + 原文=源标记 + `partition.ts` 分区不变式仍绿(全覆盖无重叠)。
- **触达**:`[ADR-0029/0008]`
- **实测落点**:`SourceBlock` 如何携带 asset 类型(扩 `kind` 联合 vs 加 `assetKind?` 字段);围栏语言标签是否进 span;行内公式独立 leaf 还是段内 formula span。

### SA3 · epub-adapter:pre/table/img/math 忠实序列化(修四 bug)`[TS]`
- **做**:`<pre>`→code(**不 norm**、保留文本换行);`<table>`→table(序列化成确定性表文本,如保留单元格分隔);`<img>`→image(从 `alt`+`src` 合成 `![alt](src)`,进 source 占 span);MathML/公式节点→formula(保留 MathML 或可逆 LaTeX 源标记,不 norm)。LEAF/walk 逻辑相应扩展。
- **不做**:不做图片二进制提取(只留引用);不解析复杂嵌套表跨页;不把 MathML 转换错误静默吞掉。
- **判据**:`vitest` 覆盖四类(尤其 `<img>` 不再消失、`<pre>` 格式保留、MathML 不被 norm 拍平)+ 分区不变式绿。
- **触达**:`[ADR-0029/0008/0024]`
- **实测落点**:epub table 序列化目标格式(HTML 保留 / 转 md table / 纯文本);img 的 src 路径是否规范化;MathML 保留格式还是转 LaTeX。

### SA4 · segment:SourceBlock.kind 透传到 LidNode.kind `[TS]`
- **做**:`segment()` 把 asset 块映射为对应 `NodeKind`(Code/Table/Image/Formula)而非统一 `paragraph`;heading/正文段不变。公式/代码/表/图固定为不可句切叶子。
- **不做**:不改容器 span post-pass 逻辑;不让句级展开进入公式内部。
- **判据**:`vitest` 覆盖 asset 块产出正确 kind 的 LidNode + 容器 span 仍 ⊇ 子并集。
- **触达**:`[ADR-0029/0008/0032]`

### SA5 · FormulaSemantics:参数/组合/上下文关系抽取 + 证据闸 `[TS + LLM 契约]`
- **做**:对每个 Formula 叶子生成公式语义剖面: `parameters[]`(symbol, label/meaning, unit?, domain?, evidence_lids)、`composition`(整体含义与项的组合关系,source_lid=formula_lid,evidence_lids)、`context_links[]`(与邻近段落、概念、断言、图表代码的关系,带 evidence_lids)。抽取可由 LLM 生成候选,但输出必须过确定性 LID 证据闸:所有 evidence_lids 存在且包含 formula_lid 或上下文窗口内 LID;无证据解释进入 model_supplement/待确认,不进只读语义剖面。
- **不做**:不做符号代数求解;不证明公式正确性;不把无证据的常识解释写成书内事实。
- **判据**:fixture 公式能产出每个参数解释、组合含义、上下文关系;悬空 LID 被确定性丢弃;缺证据项标注为待确认/模型补充而非固化;agent 侧可从 FormulaSemantics 构造公式上下文提示。
- **触达**:`[ADR-0029/0004/0011/0014/0016]`
- **实测落点**:参数同名消歧规则;单位/维度字段是否入 schema;FormulaSemantics 是否进入全局目录摘要。

### SA6 · 真书重建验:manifest 见 asset + 公式语义可检索(B2 真跑)`[跨段]`
- **做**:用一本真书(md 或 epub,如 game-programming-patterns + 含公式样本书)跑预构建 → `book.manifest` 过滤 kind 见 code/table/image/formula 叶子;`book.text(asset_lid)` 取出源标记;公式语义剖面可由 agent/query 检索并用于回答;分区不变式自检 100%。
- **不做**:不验图像多模态理解质量(图谱层一视同仁,质量留金标准集后续)。
- **判据**:真书重建产物 manifest 含四类 asset 叶子 + 原文正确 + 公式参数/组合/上下文关系可查 + 分区不变式 100%(**B2 人工/脚本验**)。
- **触达**:`[ADR-0029/0019]`
- **实测落点**:asset 叶子占比 / formula 叶子占比 / 代码块不腰斩后窗口预算影响 / 公式语义剖面对 agent 回答质量的影响。

---

## 3. 完成判据复述

```
粒度体检报告产出 + 用户确认构建粒度
  ∧ NodeKind 扩 Code/Table/Image/Formula + ManifestNode 暴露 kind(ts-rs 生成)
  ∧ md/epub adapter 忠实识别+序列化 asset(修 img/table/pre/math 四类缺口)
  ∧ 原文 = 源标记确定性序列化(book.text 可取、可锚)
  ∧ FormulaSemantics 覆盖参数/组合含义/上下文关系且证据 LID 全真
  ∧ 分区不变式自检仍 100%
  ∧ 真书重建后 manifest 见四类 asset 叶子 + 公式语义可被 agent 使用(B2 真跑)
```

## 4. 实测数字回填清单(本刀跑完回填)

| 数字 | 回填 |
| --- | --- |
| 段落数 / 估算句子数 / p90 每段句数 | ADR-0032 |
| paragraph/hybrid/sentence 预计 LID 膨胀比 | ADR-0032 |
| 用户最终选择的构建粒度 | ADR-0032 |
| SourceBlock 携带 asset 类型的方式 | ADR-0029 |
| epub table 序列化目标格式 | ADR-0029 |
| MathML 保留格式 / LaTeX 转换策略 | ADR-0029 |
| 代码块不腰斩后对窗口预算影响 | ADR-0009 |
| asset 叶子占比 / formula 叶子占比 | ADR-0029 |
| FormulaSemantics 字段是否需要单位/维度扩展 | ADR-0029 |
