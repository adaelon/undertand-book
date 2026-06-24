# 切片方案 · Asset 一等对象(代码块/表/图 进入文档世界状态)

> **定位**:切片1+ 独立刀,**与「切片1 前端阅读器」并列、互不混入**。源 `参考.md` 文档世界状态对照,§0.5 领域对齐见 `docs/adr/0029`。
> **被消费的冻结契约**:`需求文档-V3.md §3.1`(NodeKind)+ `§4.1`(`book.manifest`);术语见 `CONTEXT.md`(asset 叶子)。
> **状态**:**已规划落档,未开工**。

---

## 0. §0.5 锁定决策摘要(全文见 ADR-0029)

1. **身份** = 带类型 LID 叶子;`NodeKind` 增 `Code/Table/Image`;占 span、进分区不变式、LID 单一寻址。
2. **原文** = 源标记确定性序列化(image=`![alt](src)`、code 保格式、table 保表文本);`book.text` 返回它。
3. **读时可见** = `ManifestNode` 投影 `kind`,零新命令;`inspect_asset`=`book.text`+前端渲染(③)。
4. **类型闭集** = `{Code,Table,Image}`,长尾留实测。
5. **图谱层一视同仁**,确定性图谱闸不改。

---

## 1. A1 切片总声明

- **做**:让 code/table/image 三类 asset 从 ingestion 入口起成为带类型的一等 LID 叶子——`NodeKind` 扩 + `ManifestNode` 暴露 `kind`(ts-rs 重生成);md/epub adapter **忠实识别并序列化** asset(修三 bug:epub `<img>` 消失 / `<table>` 丢失 / `<pre>` 被 norm 拍平);分区不变式自检仍绿;真书重建后 `book.manifest` 看得到 asset 叶子。
- **不做**(明确排除):
  - ❌ 多模态图描述(切片1+,走"标注来源"旁路、不进只读基座)
  - ❌ `formula/footnote/figure-caption` 等长尾类型(实测驱动再加)
  - ❌ 新增 `book.assets(kind?)` 命令(manifest+kind 已够)
  - ❌ 前端 asset 渲染(属「切片1 前端」刀 + 优化项③)
  - ❌ table 子结构 LID(先存表文本,按行列检索留后)
  - ❌ 旧基座自动迁移(重建获得 asset,承 ADR-0019)
- **完成判据**:① `NodeKind`/`ManifestNode` schema 扩 + ts-rs 生成含新枚举;② md/epub adapter 把 code/table/image 识别成对应 kind 叶子、原文=源标记序列化、`partition.ts` 分区不变式测仍绿;③ `book.manifest` 节点带 `kind`;④ 一本真书重建后 manifest 见 asset 叶子、`book.text` 取出源标记(**B2 真跑验**)。

---

## 2. A4 子切片(每步独立可验,依赖文件状态非会话内存)

> 语言归属:SA1=**Rust**(base-schema/read-tools);SA2–SA4=**TS**(packages/core);SA5 跨段(真书重建)。

### SA1 · schema 扩:NodeKind 增三值 + ManifestNode 暴露 kind `[Rust]`
- **做**:`base-schema::NodeKind` 增 `Code/Table/Image`(serde snake_case)。`read-tools::ManifestNode` 加 `kind` 字段(投影 `LidNode.kind`)。ts-rs 重生成 `NodeKind.ts` + 新增 `ManifestNode` 导出(若未导出)。
- **不做**:不碰 ingestion(SA2+);不加 book.assets 命令。
- **判据**:`cargo test` 全绿 + clippy 净;`book.manifest` 返回每节点带 kind;`packages/core/src/generated/NodeKind.ts` 含三新值。
- **触达**:`[ADR-0029/0008/0014/0021]`
- **实测落点**:ManifestNode 是否已 `#[derive(TS)]` 导出;前端 `switch(kind)` 穷举更新点清单。

### SA2 · md-adapter:识别 fenced code / table / image `[TS]`
- **做**:`markdownToBlocks` 识别 ` ``` ` 围栏代码块(**整块为一个 leaf,内部空行不腰斩**,保留换行缩进)、markdown 表(`| … |` 连续行成 table 块)、独立 image 行(`![alt](src)`)→ 带 asset kind 的 `SourceBlock`;其余仍 paragraph。`SourceBlock` 扩携带 asset 类型(见实测落点)。
- **不做**:不处理行内 image(段中 `![]()` 留段内,切片0 句级后再说);不接 epub(SA3)。
- **判据**:`vitest` 覆盖 code/table/image 三类识别 + 原文=源标记 + `partition.ts` 分区不变式仍绿(全覆盖无重叠)。
- **触达**:`[ADR-0029/0008]`
- **实测落点**:`SourceBlock` 如何携带 asset 类型(扩 `kind` 联合 vs 加 `assetKind?` 字段);围栏语言标签(```` ```rust ````)是否进 span。

### SA3 · epub-adapter:pre/table/img 忠实序列化(修三 bug)`[TS]`
- **做**:`<pre>`→code(**不 norm**、保留文本换行);`<table>`→table(序列化成确定性表文本,如保留单元格分隔);`<img>`→image(从 `alt`+`src` 合成 `![alt](src)`,进 source 占 span)。LEAF/walk 逻辑相应扩展。
- **不做**:不做图片二进制提取(只留引用);不解析复杂嵌套表跨页。
- **判据**:`vitest` 覆盖三类(尤其 `<img>` 不再消失、`<pre>` 格式保留)+ 分区不变式绿。
- **触达**:`[ADR-0029/0008/0024]`
- **实测落点**:epub table 序列化目标格式(HTML 保留 / 转 md table / 纯文本);img 的 src 路径是否规范化。

### SA4 · segment:SourceBlock.kind 透传到 LidNode.kind `[TS]`
- **做**:`segment()` 把 asset 块映射为对应 `NodeKind`(Code/Table/Image)而非统一 `paragraph`;heading/正文段不变。
- **不做**:不改容器 span post-pass 逻辑。
- **判据**:`vitest` 覆盖 asset 块产出正确 kind 的 LidNode + 容器 span 仍 ⊇ 子并集。
- **触达**:`[ADR-0029/0008]`

### SA5 · 真书重建验:manifest 见 asset(B2 真跑)`[跨段]`
- **做**:用一本真书(md 或 epub,如 game-programming-patterns)跑预构建 → `book.manifest` 过滤 kind 见 code/table/image 叶子;`book.text(asset_lid)` 取出源标记;分区不变式自检 100%。
- **不做**:不验语义抽取质量(图谱层一视同仁,质量留金标准集后续)。
- **判据**:真书重建产物 manifest 含 asset 叶子 + 原文正确 + 分区不变式 100%(**B2 人工/脚本验**)。
- **触达**:`[ADR-0029/0019]`
- **实测落点**:asset 叶子占比 / 代码块不腰斩后窗口预算影响(回填 ADR-0009)。

---

## 3. 完成判据复述

```
NodeKind 扩 Code/Table/Image + ManifestNode 暴露 kind(ts-rs 生成)
  ∧ md/epub adapter 忠实识别+序列化 asset(修 img/table/pre 三 bug)
  ∧ 原文 = 源标记确定性序列化(book.text 可取、可锚)
  ∧ 分区不变式自检仍 100%
  ∧ 真书重建后 manifest 见 asset 叶子(B2 真跑)
```

## 4. 实测数字回填清单(本刀跑完回填)

| 数字 | 回填 |
| --- | --- |
| SourceBlock 携带 asset 类型的方式 | ADR-0029 |
| epub table 序列化目标格式 | ADR-0029 |
| 代码块不腰斩后对窗口预算影响 | ADR-0009 |
| asset 叶子占比(真书实测) | ADR-0029 |
