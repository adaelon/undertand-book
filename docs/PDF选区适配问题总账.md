# PDF 选区适配问题总账

本文持续记录 PDF 正文选区出现 `partial` / `unresolved` 的真实样本、确定性证据、影响范围和根因。它是问题清单与审计账本，不是宽松匹配白名单；任何修复仍须保持 material mismatch fail-closed。

## 1. 记录规则

每个问题必须记录：用户可见原文、canonical source 表示、LID/source span、PDF 页与几何、artifact 精度与字符证据、Server 判定链、同类影响面、允许修复的边界和必须保留的反例。只记录“看起来相似”而没有 artifact/代码证据的条目不得进入已确认状态。

状态取值：`confirmed`（根因闭合）、`needs-replay`（已有静态证据但缺真实选区回放）、`fixed`（有 red-green 和正式 artifact 回放）、`intentional`（安全边界要求保持降级）。

## 2. PDF-A001 `\underline` 包装的普通文本被当作不可恢复公式

**状态**：`confirmed`

**用户选区**：

> Inspired by the discussion above, can we propose a new associative memory model that integrates the advantages of both the kernel trick and the delta rule? Such a model would achieve more intelligent memory update management while simultaneously ensuring high memory recall accuracy.

**canonical source**：该问句不是 paragraph，而是夹在两个 paragraph LID 之间的公式节点：

```latex
Inspired by the discussion above,  $ \underline{\text{can we propose a new associative memory model that integrates the advantages of both the kernel trick and the delta rule?}} $ Such a model would achieve more intelligent memory update management while simultaneously ensuring high memory recall accuracy.
```

**确定性证据**：

| 项目 | 值 |
|---|---|
| 前段正文 | `1.19.87.191.24`, source `47392-47427`, `char_exact` |
| 下划线问句 | `1.19.87.191.25`, source `47427-47571`, pageIndex `11`, `region_exact` |
| 后段正文 | `1.19.87.191.26`, source `47571-47699`, `char_exact` |
| 问句 PDF regions | `[234.1869,269.2620,546.4180,279.2246]`; `[70.8660,257.3070,315.0646,267.2696]` |
| 问句字符证据 | `exact_source_spans=[]`; `formula_display_text` 缺失；selection assignments 缺失 |
| selection shard 缺口 | page 11 的 `char_index 2631-2752` 共 122 个位置未写入；前段止于 2630，后段始于 2753 |

**根因链**：

1. Markdown 分段把 `$ ... $` 内的整段普通英语识别为 `kind=formula`。
2. `formulaSourceCharacterKeys` 只接受固定 presentation/wrapper 命令；内部 `\text` 可接受，但外层 `\underline` 不在集合中，因此整个 source-display 字符投影返回 `null`。
3. Core 虽能用前后正文锚确定两行公式区域，却不能生成 `formula_display_text`、逐字符 source spans 和 selection assignments，只能落为 `region_exact`。
4. Server 的 `complete_formula_representations` 必须同时看到 `formula_display_text`、完整首尾 exact span 和全部选中 glyph；本节点三者均无，不能把 canonical LaTeX 替换为用户看到的问句。
5. `v2_selection_has_degraded_precision` 又会把任何与该 `region_exact` 区域相交的选择判为 degraded。即使前后正文都精确，最终状态仍必然是 `partial`。

**不是上一问题的重复**：该节点的两行区域和阅读顺序已经正确，不是同基线右续段丢失；失败发生在“source markup -> visible glyph”证据层。

**同类影响面**：本书共有 47 个包含 `\underline` 的 formula LID，0 个拥有 `formula_display_text`。正文 14 个（`partial=2`, `region_exact=2`, `unmapped=10`），References 及之后 33 个（`partial=6`, `region_exact=7`, `unmapped=20`）。正文节点包括 `1.19.86.57.88`, `1.19.86.58.8`, `1.19.86.58.13`, `1.19.87.2`, `1.19.87.191.25`, `1.19.87.191.93`, `1.19.87.191.113`, `1.19.87.191.159`, `1.19.87.191.208`, `1.19.87.191.219`, `1.19.87.191.248`, `1.19.87.192.3`, `1.19.87.192.42`, `1.19.87.192.79`。

**修复边界**：不能只把 `underline` 追加到字符串白名单后宣告完成。应把“保持可见字符序列的透明排版 wrapper”与“改变语义/生成 glyph 的数学命令”分层；前者只有在括号闭合、整段 glyph 唯一单调匹配、完整选择和反向投影均成立时才可 recovered。缺字符、变量改变、部分 wrapper 选择、嵌套边界损坏仍须 `partial`。

**必须回归**：本条完整选区；`\underline{\text{...}}` 多行与单行；仅选择问句中部；PDF 少一个字符；source 改一个单词；嵌套 `\textit`；未闭合花括号；包含真正数学变换的 wrapper。

## 3. 全书审计基线

**审计日期**：2026-07-22

**审计对象**：`.understand-book/understanding-transformer-from-the-perspective-of`

| 身份 | 值 |
|---|---|
| canonical source SHA-256 | `cb108cabb5198cf07820b5eb49e6d3094fdf870ae20b130c93539b721ed653c9` |
| PDF SHA-256 | `9391b89821c97dd14e66937fd71d22bfcfc72357f8023daddc6fc6334c68b9b0` |
| source alignment evidence SHA-256 | `14d64f4dacb7bb04c39c446051744712e5a45ffeb0963d499357d5f2ac869268` |
| hybrid config hash | `9be01ab91c94bbbd71c12017f7a32e31b6f0357bf4cc83219069e1e4b781723d` |
| 正式 artifact digest | `bcc7c04a716a390f2919b787683f74722abc0992ebc4cbba4baf6aee92cd3fd2` |
| PDF 页数 | 46（pageIndex `0-45`） |
| alignment units / located | 378 / 333 |
| leaf entries | 2,075 |
| quality tier | `degraded` |

审计按 source span 从 0 到 161,297 逐叶检查 `base.json` 与 `pdf_source_map.json`，再以内存方式从正式 PDF 重新提取 PDF.js geometry 并重放 `alignHybridFoundationV2`。重放前冲突消解得到 `partial=379, char_exact=657, unmapped=960, region_exact=79`；正式 artifact 将 11 个重复 PDF binding fail-closed 丢弃后为 `partial=368, char_exact=657, unmapped=971, region_exact=79`，差额与 `conflicted_lid_count=11` 完全一致。

## 4. 全量结果与用户体验含义

| Artifact 类别 | 数量 | 单节点选择的实际含义 |
|---|---:|---|
| `char_exact` paragraph | 657 | 本节点字符可精确选择；跨过相邻降级节点仍可能 partial |
| `partial` paragraph | 141 | 只有差异完全落入 recovery 白名单才可显示 resolved；否则 partial |
| `partial` formula + `formula_display_text` | 200 | 必须完整选择公式显示字符才可 recovered；只选公式一部分仍 intentional partial |
| `partial` formula，无显示证据 | 27 | 公式已找到但缺同页同栏前后锚；选择即 partial |
| `region_exact` formula | 79 | 只能导航/对象标记；矩形相交即触发 degraded precision |
| `unmapped` formula | 561 | 跨过时通常 partial，单独选择可能 unresolved |
| `unmapped` paragraph | 391 | 跨过时通常 partial，单独选择可能 unresolved |
| `unmapped` image | 19 | 无文字搜索 token；不应伪造成文本选择能力 |

以下 projection reason 对 2,075 个叶节点做到了无遗漏核算：

| Projection reason | 数量 | 归类 |
|---|---:|---|
| complete monotonic character projection | 657 | 正常 |
| partial monotonic character projection | 141 | PDF-A002/A003/A004/A005 |
| complete simple formula display projection | 200 | 完整公式可恢复，部分公式 intentional |
| formula text lacks same-page same-column anchors | 27 | PDF-A007 |
| unique formula region, no character evidence | 79 | PDF-A001/A007 |
| formula has no unique bounded PDF gap | 314 | PDF-A006 |
| formula projection ambiguous in located unit | 4 | PDF-A006 |
| child has no deterministic projection in located unit | 129 | PDF-A005 |
| alignment unit has no exact monotonic candidate | 433 | PDF-A008 |
| alignment unit has ambiguous forward candidates | 61 | PDF-A008 |
| binding conflict discarded | 11 | PDF-A009 |
| image unit has no searchable tokens | 19 | PDF-A010 |

结论：当前只有 657/2,075（31.66%）叶节点是逐字符 exact；按 source span 加权的正文 exact ratio 为 71.87%。`resolve_pdf_selection=available` 只表示接口可用，不表示任意正文选区都能 resolved。

## 5. 已确认根因总览

| ID | 根因 | 直接影响 | 性质 |
|---|---|---:|---|
| PDF-A001 | 透明 LaTeX wrapper 被视为未知公式命令 | `\underline` 47 节点，0 个显示证据 | 系统性 false negative |
| PDF-A002 | Markdown 控制符与 PDF 可见字符未分层 | heading 3，list marker 5 | source/display 表示差异 |
| PDF-A003 | 标点和 glyph 归一化覆盖不足 | 28 个 partial paragraph | 部分可安全适配，须逐类证明 |
| PDF-A004 | LCS 在 located unit 内跨越未匹配 PDF 实质字符 | 54 个 source 已全覆盖的 partial paragraph | 对齐漂移，不能白名单化 |
| PDF-A005 | unit 已定位，但 child 投影仍被整体丢弃 | 129 paragraph；81 个长度 >30 | child 边界/游标算法缺陷 |
| PDF-A006 | 公式 source/display/glyph 模型只覆盖“简单公式” | 314 no-gap + 4 ambiguous | 结构化公式适配不足 |
| PDF-A007 | 公式恢复依赖同页同栏双侧正文锚 | 27 partial + 79 region-only | 边界证据模型不足 |
| PDF-A008 | alignment unit 过大或 source/PDF token 序列不等价 | 23 no-candidate units / 433 leaves；3 ambiguous units / 61 leaves | unit 构造与定位缺陷 |
| PDF-A009 | 多个 LID 争用同一 PDF binding | 11 leaves | 正确 fail-closed，前置投影需消歧 |
| PDF-A010 | image 与代码清单缺少独立投影模型 | image 19；代码区大量 partial/unmapped | asset/code 适配缺失 |
| PDF-A011 | source 中实质字母/数字没有 PDF glyph 证据 | 28 个 partial paragraph | material mismatch，禁止白名单化 |

141 个 partial paragraph 的六类核算为：heading marker 3 + list marker 5 + punctuation/symbol 28 + whitespace-only 23 + PDF extra/LCS drift 54 + source material missing 28 = 141。

## 6. PDF-A002 Markdown 控制符未与可见文本分层

**状态**：`confirmed`

标题 source 保留 `#`，PDF 只显示标题文字；列表 source 使用 `-`，PDF 显示 `•`。这些字符不是正文语义缺失，但当前 recovery policy 只认识布局空白、排版连字符和完整简单公式，因此 raw quote 与 canonical quote 无法闭合。

**heading LIDs**：`1.1`, `7.1`, `8.1`。

**list LIDs**：`1.19.87.160`, `1.19.87.165`, `1.19.87.191.3`, `1.19.87.191.82`, `1.19.87.191.85`。

`7.1`/`8.1` 还暴露代码清单被 Markdown heading 规则误切的问题：Python/伪代码中的 `# ...` 被建立为 chapter/heading，而不是 code 行。

## 7. PDF-A003 标点和 glyph 表示未覆盖

**状态**：`confirmed`, 具体字符类别 `needs-replay`

28 个 paragraph 的 source exact spans 缺口只含标点/符号，常见为 ASCII apostrophe 对 PDF 弯引号、ASCII hyphen 对 en dash、冒号/句点缺 hit，以及代码字符串引号/括号。它们不能合并成一个“忽略标点”规则：词内 apostrophe、负号、范围 dash、代码引号的语义不同。

**LIDs**：`1.18.3`, `1.18.12`, `1.18.13`, `1.19.86.57.60`, `1.19.86.57.90`, `1.19.86.58.10`, `1.19.87.191.78`, `1.19.87.191.133`, `1.19.87.192.2`, `1.20.3.46`, `1.21.3`, `1.23.8`, `1.23.47`, `1.23.53`, `1.23.64`, `1.23.79`, `1.23.88`, `1.24.8.15`, `1.24.10.20`, `1.24.16.62`, `2.5`, `4.3`, `6.19`, `6.22`, `6.28`, `6.30`, `8.2`, `8.3`。

另有 23 个 paragraph 的缺口只含 whitespace，属于现有 `layout_whitespace` 候选：`1.19.80`, `1.19.86.57.21`, `1.19.86.57.33`, `1.19.86.58.20`, `1.19.87.50`, `1.19.87.191.8`, `1.19.87.191.13`, `1.19.87.191.47`, `1.23.24`, `1.23.37`, `1.23.107`, `1.24.7.2`, `1.24.9.6`, `1.24.10.52`, `1.24.13.7`, `1.24.13.11`, `1.24.17.21`, `6.4`, `6.13`, `6.14`, `6.18`, `6.29`, `8.4`。每个仍须用真实 raw quote 判断是否完整满足 v2 recovery，不因本表自动升级。

## 8. PDF-A004 partial LCS 跨过实质 PDF 字符

**状态**：`confirmed`

54 个 paragraph 的 trimmed source 已被 `exact_source_spans` 100% 覆盖，precision 仍为 partial，说明降级来自 `has_unmatched_material_pdf`。从 PDF.js 原始字符流重放后：8 个未在逐行检查中发现额外 material char，4 个跨 1-2 个，5 个跨 3-10 个，21 个跨 11-50 个，16 个跨 50 个以上。后两档共 37 个，不是可忽略排版噪声，而是 LCS 在宽 unit 内把一个 child 的字符配到后续正文、公式、脚注或相邻列。

最高漂移包括：`1.19.87.192.58` 359 chars/8 lines，`1.24.16.32` 349/6，`1.19.86.58.53` 278/10，`1.19.87.191.163` 190/3，`1.21.5` 180/5，`1.19.86.58.92` 171/4，`1.19.86.58.46` 156/3，`1.19.87.191.21` 154/3。此类问题必须收紧 child 边界与单调局部窗口，不能新增 recovery 类别掩盖。

**全部 LIDs**：`1.19.9`, `1.19.13`, `1.19.64`, `1.19.86.19`, `1.19.86.57.9`, `1.19.86.57.42`, `1.19.86.57.87`, `1.19.86.58.12`, `1.19.86.58.35`, `1.19.86.58.46`, `1.19.86.58.53`, `1.19.86.58.83`, `1.19.86.58.92`, `1.19.87.33`, `1.19.87.174`, `1.19.87.191.21`, `1.19.87.191.163`, `1.19.87.191.182`, `1.19.87.191.194`, `1.19.87.191.207`, `1.19.87.191.249`, `1.19.87.191.279`, `1.19.87.192.41`, `1.19.87.192.58`, `1.20.3.3`, `1.20.3.8`, `1.20.3.31`, `1.20.3.71`, `1.20.4.3`, `1.20.4.31`, `1.21.5`, `1.23.2`, `1.23.21`, `1.23.25`, `1.23.29`, `1.23.45`, `1.23.54`, `1.23.58`, `1.23.65`, `1.23.69`, `1.23.74`, `1.23.77`, `1.23.83`, `1.23.86`, `1.23.91`, `1.23.103`, `1.23.109`, `1.24.2.17`, `1.24.4.19`, `1.24.16.3`, `1.24.16.32`, `1.24.17.32`, `2.4`, `8.5`。

## 9. PDF-A011 source 实质字符没有 glyph 证据

**状态**：`confirmed`

28 个 partial paragraph 的未覆盖 source 字符包含字母或数字，不是空白、Markdown 标记或纯标点。正文样本包括 `1.19.86.57.12` 的大段字母缺失、`1.19.87.191.209` 的 `^0`、`1.19.87.192.74` 的 `z` 和 `1.19.87.192.82` 的整段后缀；代码区则集中表现为 OCR/空格化 source 与 PDF code glyph 序列不同。

**全部 LIDs**：`1.19.86.45`, `1.19.86.57.12`, `1.19.86.58.70`, `1.19.87.178`, `1.19.87.191.169`, `1.19.87.191.209`, `1.19.87.191.220`, `1.19.87.191.226`, `1.19.87.192.74`, `1.19.87.192.78`, `1.19.87.192.82`, `1.20.3.35`, `1.20.3.67`, `1.23.80`, `2.6`, `4.2`, `4.4`, `5.2`, `6.2`, `6.3`, `6.5`, `6.6`, `6.7`, `6.8`, `6.9`, `6.11`, `6.23`, `7.2`。

这些节点必须先修 source reconciliation、代码分块或 child 对齐，不能加入 recovery accepted differences。只有重新获得每个 material source char 的唯一 glyph assignment 后才可升为 exact。

## 10. PDF-A005 located unit 内的 child 被丢弃

**状态**：`confirmed`

129 个 paragraph 所在 unit 已成功定位，但 child 没有达到 50% LCS coverage、没有 source keys，或被前序 cursor/next-text 边界挤空，最终没有任何 region/selection assignment。长度分布为：`0-2=7`, `3-5=10`, `6-10=12`, `11-30=19`, `>30=81`。因此不能把该问题解释为“短句不够唯一”；多数是正常长段落。

典型长段包括 `1.18.15`（397 chars）、`1.19.86.57.16`（364）、`1.19.87.192.76`（418）、`1.19.87.192.80`（386）以及 `1.24.10.68`（3,676-char 代码/正文混合块）。根因是 unit 定位成功与 child 证据成功之间缺少可靠分界，当前 cursor 会受前面公式、表格和错配文本影响。

**全部 LIDs**：`1.14`, `1.16`, `1.18.15`, `1.19.15`, `1.19.17`, `1.19.86.21`, `1.19.86.23`, `1.19.86.25`, `1.19.86.27`, `1.19.86.57.14`, `1.19.86.57.16`, `1.19.86.57.44`, `1.19.86.57.89`, `1.19.86.57.92`, `1.19.86.58.3`, `1.19.86.58.14`, `1.19.86.58.37`, `1.19.86.58.39`, `1.19.86.58.41`, `1.19.86.58.43`, `1.19.86.58.45`, `1.19.86.58.55`, `1.19.86.58.57`, `1.19.86.58.61`, `1.19.86.58.63`, `1.19.86.58.65`, `1.19.86.58.68`, `1.19.86.58.72`, `1.19.86.58.74`, `1.19.86.58.94`, `1.19.87.35`, `1.19.87.157`, `1.19.87.159`, `1.19.87.162`, `1.19.87.164`, `1.19.87.167`, `1.19.87.169`, `1.19.87.171`, `1.19.87.173`, `1.19.87.176`, `1.19.87.180`, `1.19.87.182`, `1.19.87.184`, `1.19.87.186`, `1.19.87.188`, `1.19.87.190`, `1.19.87.191.15`, `1.19.87.191.17`, `1.19.87.191.23`, `1.19.87.191.80`, `1.19.87.191.92`, `1.19.87.191.112`, `1.19.87.191.115`, `1.19.87.191.165`, `1.19.87.191.167`, `1.19.87.191.171`, `1.19.87.191.173`, `1.19.87.191.175`, `1.19.87.191.177`, `1.19.87.191.179`, `1.19.87.191.184`, `1.19.87.191.186`, `1.19.87.191.196`, `1.19.87.191.211`, `1.19.87.191.213`, `1.19.87.191.215`, `1.19.87.191.217`, `1.19.87.191.222`, `1.19.87.191.224`, `1.19.87.191.228`, `1.19.87.191.230`, `1.19.87.191.232`, `1.19.87.191.234`, `1.19.87.191.236`, `1.19.87.191.238`, `1.19.87.191.240`, `1.19.87.191.242`, `1.19.87.191.244`, `1.19.87.191.246`, `1.19.87.191.247`, `1.19.87.191.251`, `1.19.87.191.253`, `1.19.87.191.255`, `1.19.87.191.257`, `1.19.87.191.259`, `1.19.87.191.261`, `1.19.87.191.263`, `1.19.87.191.265`, `1.19.87.191.267`, `1.19.87.191.269`, `1.19.87.191.271`, `1.19.87.191.273`, `1.19.87.192.4`, `1.19.87.192.43`, `1.19.87.192.60`, `1.19.87.192.62`, `1.19.87.192.76`, `1.19.87.192.80`, `1.20.3.5`, `1.20.3.10`, `1.20.3.33`, `1.20.3.48`, `1.20.3.50`, `1.20.3.52`, `1.20.3.54`, `1.20.3.56`, `1.20.3.58`, `1.20.3.73`, `1.20.4.5`, `1.20.4.33`, `1.21.7`, `1.21.9`, `1.23.23`, `1.23.27`, `1.23.38`, `1.23.56`, `1.23.60`, `1.23.85`, `1.23.93`, `1.24.9.16`, `1.24.10.68`, `1.24.12.77`, `1.24.12.85`, `1.24.12.87`, `1.24.12.89`, `1.24.12.91`, `1.24.16.25`, `1.24.16.64`, `1.24.17.34`。

## 11. PDF-A006/PDF-A007 公式适配缺口

本书 867 个 formula 节点的完整核算：

| 结果 | 数量 |
|---|---:|
| 完整简单公式可 recovered | 200 |
| 有区域但只有 region evidence | 79 |
| 已找到公式文本但缺同页同栏双侧锚 | 27 |
| located unit 内找不到唯一 bounded gap | 314 |
| located unit 内公式候选歧义 | 4 |
| 所在 unit 无 monotonic candidate | 210 |
| 所在 unit forward candidate 歧义 | 29 |
| binding 冲突后丢弃 | 4 |

451 个公式节点含至少一个不在当前透明命令集合中的命令；其中很多是 `\frac`, `\sum`, `\top`, `\kappa`, `\phi`, `\exp`, `\sqrt`, `\underbrace` 等真正会改变 glyph 的数学命令，不能像 `\underline` 一样直接忽略。另有 216 个只使用当前受支持命令/语法的公式仍然 region-only、anchor-partial 或 unmapped，证明问题不只在命令白名单，还包括 PDF glyph 表示、边界锚、unit 定位和阅读顺序。

`formula has no unique bounded PDF gap` 的 314 个节点按 source 长度分布为 `<=10:43`, `11-30:86`, `31-100:102`, `>100:83`。既有 `$t$`, `$S$`, `$o_t$`, `$TC^0$` 等短式，也有复杂展示公式；不能用统一长度阈值解决。

**无双侧锚的 27 个公式**：`1.18.19`, `1.19.86.29`, `1.19.86.57.72`, `1.19.86.58.28`, `1.19.86.58.29`, `1.19.86.58.30`, `1.19.86.58.32`, `1.19.86.58.36`, `1.19.87.2`, `1.19.87.12`, `1.19.87.47`, `1.19.87.156`, `1.19.87.191.93`, `1.19.87.191.118`, `1.19.87.191.138`, `1.19.87.191.212`, `1.19.87.191.216`, `1.19.87.192.75`, `1.20.3.11`, `1.23.6`, `1.23.11`, `1.23.12`, `1.23.41`, `1.23.49`, `1.23.113`, `1.24.4.24`, `1.24.6.10`。

其中 `1.19.87.191.212` 的 source 已损坏为 `$.}} $`，来自外层 `\underline{\text{...}}` 内再次嵌入 `$ TC^0 $` 后被 Markdown inline-formula 分段器切碎。这是 parser/segmentation 问题，不是几何适配。

**region-only 的 79 个公式**：`1.5`, `1.19.18`, `1.19.20`, `1.19.22`, `1.19.49`, `1.19.71`, `1.19.81`, `1.19.86.37`, `1.19.86.39`, `1.19.86.53`, `1.19.86.57.8`, `1.19.86.57.20`, `1.19.86.57.22`, `1.19.86.57.24`, `1.19.86.57.39`, `1.19.86.57.41`, `1.19.86.57.51`, `1.19.86.57.53`, `1.19.86.57.58`, `1.19.86.57.70`, `1.19.86.58.26`, `1.19.86.58.75`, `1.19.86.58.87`, `1.19.87.20`, `1.19.87.53`, `1.19.87.149`, `1.19.87.191.19`, `1.19.87.191.25`, `1.19.87.191.60`, `1.19.87.191.103`, `1.19.87.191.105`, `1.19.87.191.107`, `1.19.87.191.109`, `1.19.87.191.122`, `1.19.87.191.126`, `1.19.87.191.128`, `1.19.87.191.159`, `1.19.87.191.161`, `1.19.87.191.206`, `1.19.87.192.10`, `1.19.87.192.22`, `1.19.87.192.36`, `1.19.87.192.38`, `1.19.87.192.40`, `1.20.3.30`, `1.20.3.40`, `1.20.3.43`, `1.20.3.70`, `1.20.4.30`, `1.23.19`, `1.23.33`, `1.23.36`, `1.23.52`, `1.23.63`, `1.23.100`, `1.23.116`, `1.24.2.4`, `1.24.10.3`, `1.24.10.7`, `1.24.12.5`, `1.24.12.54`, `1.24.12.60`, `1.24.12.66`, `1.24.12.68`, `1.24.13.10`, `1.24.14.4`, `1.24.16.20`, `1.24.16.29`, `1.24.16.31`, `1.24.16.72`, `1.24.16.74`, `1.24.16.81`, `1.24.17.7`, `1.24.17.11`, `1.24.17.24`, `1.24.17.28`, `1.24.17.30`, `8.7.5`, `8.7.22`。

## 12. PDF-A008 全部未定位 alignment units

19 个 image-only unit 没有 searchable token，属于 asset 投影缺失：`unit-108`, `121`, `133`, `136`, `138`, `140`, `142`, `144`, `146`, `152`, `154`, `156`, `161`, `163`, `171`, `173`, `306`, `308`, `310`。

3 个 unit 有多个 forward candidate：

| Unit | Source span | Children | Evidence | 起始内容 |
|---|---:|---|---|---|
| `unit-104` | 54383-55374 | text 9 / formula 8 | reviewed_hint p13:14-24 | `overline{NC^k}` 的 circuit classes 列表 |
| `unit-301` | 142849-143097 | text 8 / formula 7 | reviewed_hint p38:57-59 | `For every alpha...` 重复数学陈述 |
| `unit-304` | 143868-144970 | text 15 / formula 14 | reviewed_hint p39:0-16 | GQA/`kappa_1` 推导段 |

23 个 unit 没有 exact monotonic candidate：

| Unit | Span | 叶节点数 | Evidence | 起始内容/主要根因 |
|---|---:|---:|---|---|
| `unit-36` | 12891-13343 | 15 | reviewed_hint p3:15-30 | 公式密集 retrieval 推导 |
| `unit-75` | 38931-42688 | 73 | reviewed_hint p10:0-53 | HTML table 与 72 个相邻公式/文本被合成一个 unit |
| `unit-109` | 57638-57961 | 3 | reviewed_hint p14:10-12 | Figure 1 caption + 公式 |
| `unit-143` | 71743-71853 | 2 | reviewed_hint p17:26-28 | DeltaFormer 子图 caption |
| `unit-145` | 72268-72375 | 2 | reviewed_hint p17:28-29 | DeltaFormer 子图 caption |
| `unit-159` | 78746-78954 | 1 | verified p18:44-45 | Curriculum Learning 段，source/PDF 字面不等价 |
| `unit-239` | 102740-107329 | 79 | reviewed_hint p25:70-p27:0 | Appendix A 长公式推导，4,589 chars |
| `unit-240` | 107331-109303 | 33 | reviewed_hint p27:0-66 | Gaussian/SoLU 长推导，1,972 chars |
| `unit-248` | 111778-117587 | 84 | reviewed_hint p28:26-p30:24 | B.2 多模型长推导，5,809 chars |
| `unit-269` | 130230-130275 | 1 | verified p33:50 | Markdown heading `### D.3.1...` |
| `unit-270` | 130277-130686 | 1 | verified p33:51-54 | GPU matrix inversion 正文 |
| `unit-271` | 130688-130957 | 11 | format_equivalent p33:55-56 | `I+A` 推导 |
| `unit-272` | 130959-131690 | 11 | reviewed_hint p34:0-17 | matrix inverse 连续展示公式 |
| `unit-273` | 131692-131727 | 1 | verified p34:18 | Markdown heading `### E...` |
| `unit-278` | 132708-133141 | 15 | reviewed_hint p35:9-13 | 初始化 key-value 推导 |
| `unit-280` | 133406-133614 | 9 | reviewed_hint p35:23-26 | Assumption 2 推导 |
| `unit-282` | 134715-134811 | 5 | format_equivalent p35:34 | exchange 结论短段 |
| `unit-289` | 135589-136812 | 28 | reviewed_hint p36:12-31 | Lemma 1 分情况证明 |
| `unit-295` | 138946-140253 | 26 | reviewed_hint p37:10-44 | `t=n+1` 多式推导 |
| `unit-297` | 140338-142653 | 30 | reviewed_hint p37:49-p38:52 | t-th step 多式推导 |
| `unit-335` | 151560-151569 | 1 | reviewed_hint p41:20 | 代码注释被切成 heading `# project` |
| `unit-348` | 154892-154943 | 1 | reviewed_hint p43:6-7 | code function signature |
| `unit-363` | 157227-157256 | 1 | reviewed_hint p44:0 | OCR/代码碎片 `em () :.4 f...` |

这里最显著的共同根因是 `formHybridAlignmentUnits` 的 formula-context 合并可跨越大量相邻块：只要 unit 已含 formula 且块间没有空行硬边界，就可能继续增长。大 unit 随后用首尾 token 和一个共享 cursor 投影所有 children；任一中段表格、脚注、公式表示差异都会扩大到整 unit。

## 13. PDF-A009 binding 冲突

11 个 raw projection 争用已分配的 PDF region/selection binding，正式构建正确地全部 fail-closed：公式 `1.19.87.191.170`, `.176`, `.195`, `.197`；paragraph `1.24.10.65`, `.66`, `.67`, `3.2`, `3.3`, `6.25`, `6.26`。前四个是重复出现的 `$n$` / `$TC^0$` 短式，后七个集中在代码清单，说明歧义主要来自短公式重复和代码 OCR/分块重叠。

## 14. 按阅读顺序的精度矩阵

每个叶节点归入最深 enclosing section；`1` 表示标题/作者等不属于子 section 的 front matter，`2-8` 是被 Markdown 误切成 chapter 的代码清单。该表覆盖全部 2,075 entries。

| Section | 内容 | Total | char_exact | partial | region_exact | unmapped |
|---|---|---:|---:|---:|---:|---:|
| `1` | front matter | 16 | 6 | 1 | 1 | 8 |
| `1.17` | Abstract | 7 | 7 | 0 | 0 | 0 |
| `1.18` | 1 Introduction | 19 | 13 | 4 | 0 | 2 |
| `1.19` | 2 Associative Memory（直属） | 85 | 41 | 26 | 6 | 12 |
| `1.19.86` | 2.1 Memory Capacity（直属） | 56 | 18 | 8 | 3 | 27 |
| `1.19.86.57` | 2.1.1 Kernel Mapping | 92 | 38 | 21 | 10 | 23 |
| `1.19.86.58` | 2.1.2 Vignette 1 | 94 | 27 | 20 | 3 | 44 |
| `1.19.87` | 2.2 Memory Update（直属） | 190 | 41 | 31 | 3 | 115 |
| `1.19.87.191` | 2.2.1 Vignette 2 | 283 | 82 | 55 | 13 | 133 |
| `1.19.87.192` | 2.2.2 Infinite ICL | 82 | 33 | 18 | 5 | 26 |
| `1.20` | 3 Experiments（直属） | 1 | 1 | 0 | 0 | 0 |
| `1.20.2` | 3.1 Multi-head | 6 | 5 | 1 | 0 | 0 |
| `1.20.3` | 3.2 Swap task | 94 | 30 | 13 | 4 | 47 |
| `1.20.4` | 3.3 DAG | 33 | 15 | 9 | 1 | 8 |
| `1.21` | 4 Conclusion | 12 | 5 | 3 | 0 | 4 |
| `1.22` | 5 Acknowledgements | 2 | 2 | 0 | 0 | 0 |
| `1.23` | References | 117 | 50 | 32 | 7 | 28 |
| `1.24` | Appendix（直属） | 1 | 1 | 0 | 0 | 0 |
| `1.24.2` | A | 131 | 10 | 2 | 1 | 118 |
| `1.24.3` | B heading | 1 | 1 | 0 | 0 | 0 |
| `1.24.4` | B.1 General Form | 48 | 25 | 12 | 0 | 11 |
| `1.24.5` | B.2 Representative Cases | 85 | 1 | 0 | 0 | 84 |
| `1.24.6` | C Delta Rule | 30 | 14 | 7 | 0 | 9 |
| `1.24.7` | D heading | 2 | 1 | 1 | 0 | 0 |
| `1.24.8` | D.1 Information Aggregation | 15 | 8 | 2 | 0 | 5 |
| `1.24.9` | D.2 Retrieval | 17 | 8 | 1 | 0 | 8 |
| `1.24.10` | D.3 Chunk-wise | 68 | 33 | 23 | 2 | 10 |
| `1.24.11` | D.3.1 Matrix Inversion | 24 | 0 | 0 | 0 | 24 |
| `1.24.12` | E State Tracking | 98 | 32 | 6 | 5 | 55 |
| `1.24.13` | E.1 Theorem 1 | 12 | 5 | 3 | 1 | 3 |
| `1.24.14` | E.1.1 Lemma 1 | 73 | 23 | 10 | 1 | 39 |
| `1.24.15` | E.1.2 Proof | 65 | 6 | 2 | 0 | 57 |
| `1.24.16` | E.2 Assumptions | 90 | 22 | 8 | 6 | 54 |
| `1.24.17` | E.3 Compression | 34 | 16 | 8 | 5 | 5 |
| `1.24.18` | E.4 Toy Experiment | 4 | 4 | 0 | 0 | 0 |
| `2` | code block: `# seed all` | 6 | 3 | 3 | 0 | 0 |
| `3` | code block: MHA | 3 | 1 | 0 | 0 | 2 |
| `4` | code block: `# project` | 4 | 1 | 3 | 0 | 0 |
| `5` | code block continuation | 2 | 0 | 1 | 0 | 1 |
| `6` | code/training listing | 30 | 8 | 18 | 0 | 4 |
| `7` | code list literal | 3 | 1 | 2 | 0 | 0 |
| `8` | plotting/training code | 6 | 1 | 5 | 0 | 0 |
| `8.7` | F Analytical Solution | 34 | 18 | 9 | 2 | 5 |

风险最集中区域是 Appendix A（118/131 unmapped）、B.2（84/85 unmapped）、D.3.1（24/24 unmapped）、E.1.2（57/65 unmapped），以及正文 2.2/两个 Vignette。Abstract 是唯一 7/7 全 exact 的正常章节。

## 15. 高风险 unit 排名

| Unit | Total | 非 char_exact | Span length | 起始内容 |
|---|---:|---:|---:|---|
| `unit-248` | 84 | 84 | 5,809 | B.2 Linear Attention 等长推导 |
| `unit-239` | 79 | 79 | 4,589 | Appendix A SNR 推导 |
| `unit-75` | 73 | 73 | 3,757 | memory update HTML table |
| `unit-240` | 33 | 33 | 1,972 | Gaussian/SoLU 推导 |
| `unit-297` | 30 | 30 | 2,315 | theorem proof |
| `unit-304` | 29 | 29 | 1,102 | GQA 推导，且候选歧义 |
| `unit-113` | 29 | 28 | 789 | Training phase + 多公式 |
| `unit-281` | 45 | 27 | 1,097 | State tracking 推导 |
| `unit-114` | 27 | 27 | 570 | Inference phase + 多公式 |
| `unit-295` | 26 | 26 | 1,307 | theorem proof |
| `unit-66` | 30 | 25 | 2,383 | MoE/gating 公式密集段 |
| `unit-119` | 39 | 21 | 1,875 | Infinite ICL 推导 |

## 16. 修复优先顺序

1. **先切 unit**：限制 formula-context unit 的最大 span/child 数，并以段落、表格、caption、页/栏和展示公式建立硬边界。否则后续字符规则会继续在数千字符窗口内漂移。
2. **再做 child 单调窗口**：每个 child 只能在相邻已证实 child 锚之间匹配；禁止 LCS 跨越大量未匹配 material PDF 字符。先消灭 PDF-A004/A005。
3. **分离 visible-text wrapper**：以解析结构处理 `underline/text/textit/textbf` 等保持 glyph 序列的包装，完整证据闭环后才加入 formula recovery。
4. **扩充表示差异必须逐类登记**：heading/list、apostrophe、dash 各自建立真实正例和语义反例，不设“忽略所有 Markdown/标点”。
5. **公式结构化投影**：复杂公式不能靠删除命令字符；需要 source AST/display glyph 对应或保持 region-only。
6. **代码与 asset 独立建模**：代码清单禁止进入 heading 解析，image 使用 asset region，不参与文本 exact 指标。

## 17. 确定性证据入口

| 证据 | 路径/符号 |
|---|---|
| canonical 原文 | `.understand-book/understanding-transformer-from-the-perspective-of/source.txt` |
| LID/kind/source span | `.understand-book/understanding-transformer-from-the-perspective-of/base.json` |
| precision/region/reason | `.understand-book/understanding-transformer-from-the-perspective-of/pdf_source_map.json` |
| selection chars | `.understand-book/understanding-transformer-from-the-perspective-of/pdf_selection_map/pages/*.json` |
| 全局指标 | `.understand-book/understanding-transformer-from-the-perspective-of/alignment_report.json` |
| reconciliation seeds | `.build/source-reconciliation/alignment-evidence.json` |
| unit 构造 | `packages/core/src/hybrid-alignment-v2.ts::formHybridAlignmentUnits` |
| unit 定位 | `packages/core/src/hybrid-alignment-v2.ts::locateHybridAlignmentUnits` |
| child/公式投影 | `packages/core/src/hybrid-alignment-v2.ts::projectHybridAlignmentChildren` |
| 透明公式命令门 | `packages/core/src/hybrid-alignment-v2.ts::formulaSourceCharacterKeys` |
| 完整公式恢复门 | `crates/server/src/lib.rs::complete_formula_representations` |
| partial 判定 | `crates/server/src/lib.rs::v2_selection_has_degraded_precision` |

## 18. 审计限制

本轮对正式 artifact 的每个叶节点和每个未定位 unit 做了静态全量审计，并用正式 PDF geometry 重放对齐；没有为 1,418 个非 `char_exact` 叶节点逐个执行人工拖选。文档中的“必然 partial/unresolved”来自当前 Server 门禁与证据缺失可直接推出；标为 `needs-replay` 的标点细类仍需后续真实 rect + raw_quote 正反例确认。任何 artifact 重建后必须用新的四个输入/配置 hash 另开审计快照，不能沿用本次数量。

## 19. PR8 版本化适配基准

**PR 状态**:`completed`；PDF-A001 至 PDF-A011 仍保持原状态，本 PR 不修改映射行为。

- external descriptor v2 以旧 LID、source span、span SHA-256 和结构化 expected 元数据冻结全部 2,075 个叶节点；不保存新增正文、quote 或 content 字段。
- baseline 闭合 12 类 projection reason、43 个最深 enclosing section 和 A001-A011 标签；标签计数为 `47/8/51/54/129/318/106/494/11/73/28`。
- audit runner 同时报告 baseline/current/migration coverage、reason/precision/section/issue closure、错误页、formal/raw duplicate binding 和 selection capability matrix；删除、重复、改类、错页及错误显式迁移均使测试失败。
- 正式 artifact 连续两次审计均为 `passed=true`，2,075 项全部 direct LID 命中，`wrong_page_count=0`，formal region/selection duplicate 均为 0；序列化输出 9,831 bytes，SHA-256 `db3891eff265680104c1efde28e6987dcdea015c9d0f5308e6df0ee7cd909334`。
- 验证：Core typecheck、PR8/goldset 定向 7 tests、Core 全量 59 files / 352 tests 全绿。
