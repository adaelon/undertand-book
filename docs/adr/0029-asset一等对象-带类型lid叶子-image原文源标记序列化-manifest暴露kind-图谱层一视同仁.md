# ADR-0029 Asset 一等对象:带类型 LID 叶子(NodeKind 增 Code/Table/Image)/ image 原文=源标记确定性序列化 / manifest 暴露 kind 零新命令 / 图谱层一视同仁

状态:已接受(2026-06-24,§0.5 领域对齐 Grill 共识;源自 `参考.md` 文档世界状态对照)

## 背景
冷逸《文档世界状态(Knowhere)》一文主张 `observation ≠ state`,核心警告之一:**让表格、图片、代码不从链路里消失**。对照本项目(`docs/参考对照-文档世界状态-优化登记.md`):信念同源,但发现一处真实缺口——当前 asset **在 ingestion 入口就被拍平或丢弃**:
- `NodeKind = {Chapter,Section,Paragraph}` 无 asset 类型;
- `md-adapter.ts` 只识别 heading + 空行分段,代码块/引用/列表全聚成 `paragraph`,且代码块内空行会被错误分段;
- `epub-adapter.ts` 的 `<img>` 直接消失(非 LEAF、空元素被跳过)、`<table>` 内容基本丢失、`<pre>` 被 `norm` 把 `\s+`→单空格(换行缩进格式被毁)。

本 ADR 把 asset 提升为**带类型的一等检索对象**,使图/表/代码进入 Agent 的状态与动作空间。约束:只在冻结契约(V3 §6.1 基线 v1)上**只增不改**。

## 决策(§0.5 五问共识)
1. **asset = 带类型的 LID 叶子**。`NodeKind` 增 `Code/Table/Image`;asset 仍是 LID 树叶子、**占 span、进分区不变式划分**、用 **LID 单一寻址**。否决"旁挂 asset_type 属性"(类型与 kind 语义重叠、检索查两字段)、否决"独立 asset 注册表 + asset_id"(引第二套寻址,违"一切基础是 LID 树、不叠派生抽象层";那是企业跨文档复用才需,单书 asset 就在树某位置、LID 已足够)。
2. **asset 叶子原文 = 源标记的确定性序列化**。image=`![alt](src)`(md 原样 / epub 从 `<img alt src>` 合成同形);code 保留换行缩进;table 保留表文本。`book.text(asset_lid)` 返回该原文,**确定性 + 忠实**;分区不变式天然满足(asset 在 source 占一段)。修掉现状 img 丢失 / table 丢失 / code 被 norm 拍平三个 bug。**多模态图理解**(描述图)留切片1+,作 `model_supplement` 同款"诚实标注来源"的可选增强,**不烤进只读基座**(承语境胶囊降格 [[ADR-0012]] + summary 仅展示标签 [[ADR-0014]])。否决"预构建期 LLM 描述写进 source"(LLM 产物进只读原文、不可复现、毒化 citation,违 B2)。
3. **读时可见性 = `ManifestNode` 投影 `kind`(向后兼容加字段),零新命令**。agent/UI 过滤 `kind` 定位 asset、用现有 `book.text`/`context` 取用;"列全书图/表"= 拿 manifest 自行过滤 kind(确定性派生)。文章的 `inspect_asset` = `book.text(asset_lid)` + 前端渲染(优化项③)。否决"新增 `book.assets(kind?)` 命令"(命令面膨胀;按类型列 asset 本可由 manifest+kind 确定性派生,新命令冗余)——实测证明跨章找 asset 是高频且全表过滤过重时再加(何时回头)。
4. **类型闭集 = `{Code, Table, Image}`**。`NodeKind` 是可扩展枚举,`Formula/Footnote/figure-caption` 等长尾留实测驱动再加(加值=只增不改)。
5. **图谱层一视同仁**。asset 叶子是普通可锚 LID:抽取期 LLM 读 asset 原文(code 全文 / table 文本 / image 的 alt marker)正常纳入 entity occurrences / claim source_lid / 边端。image alt 信息量低是**质量问题(召回精度),非模型问题**,不特殊化——由结构红线 + scope 外扩兜底([[ADR-0011]])。**确定性图谱闸无需改**:asset 占 span、进 LID 全集,天然被接纳做锚。

## 命门
- **asset 占 span 是一切的支点**:正因 asset 是占 source span 的叶子(决策1+2),分区不变式、citation 可锚、图谱闸接纳三者**全部免费获得**,无需为 asset 开任何特例。
- **只增不改守冻结**:`NodeKind` 加枚举值 + `ManifestNode` 加 `kind` 字段,均为冻结契约允许的向后兼容增量,**不升基线版本号**;但前端 `switch(kind)` 须处理新值,ts-rs 须重生成。
- **忠实底线**:asset 原文恒为源的确定性序列化,LLM 派生(图描述)永不进只读基座、永走"标注来源"旁路。

## 否决
- 旁挂 `asset_type` 属性 / 独立 asset 注册表(见决策1)。
- 预构建 LLM 描述写进 source(见决策2)。
- 新增 `book.assets` 命令(见决策3)。
- 一次铺到 formula/footnote(过度设计,长尾识别规则难写准;见决策4)。
- asset 在图谱层特殊化(无正当理由,违叶子平权;见决策5)。

## 何时回头
- **长尾类型**:formula/footnote/figure-caption 实测高频则加 `NodeKind` 值。
- **book.assets 索引命令**:跨章找 asset 实测为高频 agent 动作且 manifest 全表过滤过重时加。
- **image 多模态描述**:切片1+ 落地,走 model_supplement 诚实标注、不进只读基座。
- **table 结构化**:切片0+ 先存表文本;若需按行列检索,再评估 table 子结构 LID(承 [[ADR-0008]] 句级下探同款渐进)。

## 影响
- **解优化项①**(`docs/参考对照-文档世界状态-优化登记.md` §C),关联已采纳的②冲突暴露 / ③证据路径可视化。
- **改 schema**:`base-schema` `NodeKind` 增 Code/Table/Image、`read-tools::ManifestNode` 加 `kind`;ts-rs 重生成到 `packages/core` 与(切片1)`packages/web`。
- **改 ingestion**:`md-adapter.ts`(识别 ``` 代码块/表/图、代码块不按空行腰斩)、`epub-adapter.ts`(`<img>`/`<table>`/`<pre>` 忠实序列化、pre 不 norm)、`segment.ts`(块 kind 透传)。
- **回填 V3**:§3.1(NodeKind 扩 asset)、§4.1(`book.manifest` 节点带 kind)。
- **切片归属**:**独立新切片(切片1+),不混入正在路上的「切片1 前端阅读器」那一刀**。旧基座重建后才获得 asset(`split_algo_version` 变 = STRUCTURAL 重建,承 [[ADR-0019]]),不破读时契约。
- **承**:[[ADR-0008]](切分/段/分区不变式/物化路径)/ [[ADR-0024]](UTF-16 span 口径)/ [[ADR-0011]](图谱闸·边作召回路标)/ [[ADR-0014]](叶子工具·summary 仅展示标签)/ [[ADR-0012]](不物化派生层)/ [[ADR-0019]](增量重建)/ [[ADR-0028]](前端渲染 asset)/ [[ADR-0004]](引用红线)/ V3 §6.1(契约冻结基线)。
