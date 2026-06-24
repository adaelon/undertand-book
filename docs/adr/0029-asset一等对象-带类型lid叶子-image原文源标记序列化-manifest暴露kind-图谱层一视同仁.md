# ADR-0029 Asset 一等对象:带类型 LID 叶子(NodeKind 增 Code/Table/Image/Formula)/ 公式语义剖面高优先级 / manifest 暴露 kind 零新命令 / 图谱层接纳可锚 asset

状态:已接受(2026-06-24,§0.5 领域对齐 Grill 共识);已修订(2026-06-25,公式升格为第四类核心 asset)

## 背景
冷逸《文档世界状态(Knowhere)》一文主张 `observation ≠ state`,核心警告之一:**让表格、图片、代码不从链路里消失**。对照本项目(`docs/参考对照-文档世界状态-优化登记.md`):信念同源,但发现一处真实缺口——当前 asset **在 ingestion 入口就被拍平或丢弃**:
- `NodeKind = {Chapter,Section,Paragraph}` 无 asset 类型;
- `md-adapter.ts` 只识别 heading + 空行分段,代码块/引用/列表全聚成 `paragraph`,且代码块内空行会被错误分段;
- `epub-adapter.ts` 的 `<img>` 直接消失(非 LEAF、空元素被跳过)、`<table>` 内容基本丢失、`<pre>` 被 `norm` 把 `\s+`→单空格(换行缩进格式被毁)。

2026-06-25 进一步修订:数学/技术书里的**公式**不是长尾装饰,而是解释链路的核心状态。读时 agent 面对公式时,不能只看到一串 LaTeX/MathML 原文;它必须知道每个参数、组合表达式的含义、以及该公式与上下文段落/概念/断言的关系。否则 agent 会把公式当作普通文本跳过,回答质量和可验证性都会断裂。

本 ADR 把 asset 提升为**带类型的一等检索对象**,使图/表/代码/公式进入 Agent 的状态与动作空间。约束:只在冻结契约(V3 §6.1 基线 v1)上**只增不改**。

## 决策(§0.5 五问共识,含 2026-06-25 公式修订)
1. **asset = 带类型的 LID 叶子**。`NodeKind` 增 `Code/Table/Image/Formula`;asset 仍是 LID 树叶子、**占 span、进分区不变式划分**、用 **LID 单一寻址**。否决"旁挂 asset_type 属性"(类型与 kind 语义重叠、检索查两字段)、否决"独立 asset 注册表 + asset_id"(引第二套寻址,违"一切基础是 LID 树、不叠派生抽象层";单书 asset 就在树某位置,LID 已足够)。
2. **asset 叶子原文 = 源标记的确定性序列化**。image=`![alt](src)`(md 原样 / epub 从 `<img alt src>` 合成同形);code 保留换行缩进;table 保留表文本;formula 保留源公式标记(md `$...$`/`$$...$$`,epub MathML 或源 LaTeX 可逆文本)。`book.text(asset_lid)` 返回该原文,**确定性 + 忠实**;分区不变式天然满足(asset 在 source 占 span)。修掉现状 img 丢失 / table 丢失 / code 被 norm 拍平,并新增 formula 不被段落拍平或句切拆碎。
3. **读时可见性 = `ManifestNode.kind` + 既有 `book.text/context/concept/query` 组合,零新基础命令**。agent/UI 过滤 `kind` 定位 asset、用现有 `book.text`/`context` 取用;"列全书图/表/公式"= 拿 manifest 自行过滤 kind(确定性派生)。文章的 `inspect_asset` = `book.text(asset_lid)` + 前端渲染;公式的 `inspect_formula` = `book.text(formula_lid)` + 公式语义剖面(见决策4)。否决本轮新增 `book.assets(kind?)` 命令——实测证明跨章找 asset 高频且 manifest 全表过滤过重时再加。
4. **公式高于普通 asset:必须产出 FormulaSemantics 语义剖面**。每个 `Formula` 叶子除原文外,构建期还要抽取/固化一个可验证语义剖面:`parameters[]`(符号、读法/含义、单位/取值域若原文给出、定义来源 LID)、`composition`(公式整体在表达什么、各项如何组合)、`context_links[]`(与前后段、概念、断言、图/表/代码的关系)。该剖面是 agent 读公式时的高优先级上下文,但必须带 `source_lid`/`evidence_lids`;不允许无证据地把模型世界知识写进只读原文。
5. **类型闭集 = `{Code, Table, Image, Formula}`**。`Footnote/figure-caption` 等长尾留实测驱动再加(加值=只增不改)。Formula 已从长尾升格为核心类型,不再放在"何时回头"。
6. **图谱层接纳所有 asset,但 Formula 增强关系抽取**。Code/Table/Image 是普通可锚 LID:抽取期 LLM 读 asset 原文正常纳入 entity occurrences / claim source_lid / 边端。Formula 除普通锚定外,还必须让参数、组合含义、上下文关系进入图谱/目录可召回面;确定性图谱闸仍检查 LID 真实性,语义剖面中的每条解释都必须能回到公式 LID 或上下文 LID。

## 命门
- **asset 占 span 是一切的支点**:正因 asset 是占 source span 的叶子,分区不变式、citation 可锚、图谱闸接纳三者无需为 asset 开第二套寻址。
- **公式不是普通文本块**:公式原文只解决"不丢失",FormulaSemantics 才解决"agent 能解释"。参数/组合/上下文关系缺一,公式 asset 刀不算完成。
- **只增不改守冻结**:`NodeKind` 加枚举值 + `ManifestNode.kind` 加字段均为冻结契约允许的向后兼容增量,**不升基线版本号**;但前端 `switch(kind)`、预构建 schema 和 ts-rs 必须穷举处理 `Formula`。
- **忠实底线**:asset 原文恒为源的确定性序列化;LLM 派生(图描述、公式解释)永不伪装成原文,必须带来源标记与 LID 证据。

## 否决
- 旁挂 `asset_type` 属性 / 独立 asset 注册表(见决策1)。
- 预构建 LLM 描述写进 source(见决策2/4)。
- 新增 `book.assets` 命令作为第一步(见决策3)。
- 把公式继续留作长尾类型:技术/数学阅读里公式是核心解释对象,不是装饰。
- 只保存公式 LaTeX/MathML 而不抽参数和上下文关系:agent 仍然不知道公式在说什么。
- asset 在图谱层完全特殊化成第二套图:违 LID 地基;Formula 的增强关系必须仍回到现有 LID/图谱/目录体系。

## 何时回头
- **book.assets 索引命令**:跨章找 asset/公式实测为高频 agent 动作且 manifest 全表过滤过重时加。
- **image 多模态描述**:切片1+ 落地,走 model_supplement 诚实标注、不进只读基座。
- **table 结构化**:切片0+ 先存表文本;若需按行列检索,再评估 table 子结构 LID(承 [[ADR-0008]] 句级下探同款渐进)。
- **FormulaSemantics schema**:真书实测后若参数解释需要单位、维度、符号同名消歧等字段,按只增不改扩展。

## 影响
- **解优化项①**(`docs/参考对照-文档世界状态-优化登记.md` §C),关联已采纳的②冲突暴露 / ③证据路径可视化。
- **改 schema**:`base-schema` `NodeKind` 增 Code/Table/Image/Formula、`read-tools::ManifestNode` 加 `kind`;公式语义剖面新增 schema/导出到 `packages/core` 与(切片1)`packages/web`。
- **改 ingestion**:`md-adapter.ts`(识别 ``` 代码块/表/图/行内与块级公式,代码块不按空行腰斩)、`epub-adapter.ts`(`<img>`/`<table>`/`<pre>`/MathML 忠实序列化,pre/math 不 norm)、`segment.ts`(块 kind 透传)。
- **改抽取**:公式语义剖面作为 asset 刀新增子切片,抽取 parameters/composition/context_links 并过 LID 证据校验。
- **回填 V3**:§3.1(NodeKind 扩 asset)、§4.1(`book.manifest` 节点带 kind)、§5.2(agent 读公式时优先使用 FormulaSemantics)。
- **切片归属**:**独立新切片(切片1+),不混入正在路上的「切片1 前端阅读器」那一刀**。旧基座重建后才获得 asset(`split_algo_version` 变 = STRUCTURAL 重建,承 [[ADR-0019]]),不破读时契约。
- **承**:[[ADR-0008]](切分/段/分区不变式/物化路径)/ [[ADR-0024]](UTF-16 span 口径)/ [[ADR-0011]](图谱闸·边作召回路标)/ [[ADR-0014]](叶子工具·summary 仅展示标签)/ [[ADR-0012]](不物化派生层)/ [[ADR-0019]](增量重建)/ [[ADR-0028]](前端渲染 asset)/ [[ADR-0004]](引用红线)/ V3 §6.1(契约冻结基线)。
