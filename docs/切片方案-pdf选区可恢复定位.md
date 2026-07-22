# 切片方案 - PDF 选区可恢复定位

> 状态:2026-07-22 PR0 已完成,PR1-PR6 待实现。
> 决策:[ADR-0090](adr/0090-pdf-selection-recovered-resolution-and-versioned-discrepancy-policy.md)。
> 既有边界:[ADR-0074](adr/0074-pdf-selection-actions-and-exact-user-annotation-projection.md)、[ADR-0082](adr/0082-hybrid-foundation-semantic-unit-alignment-and-degraded-reader.md)。

## 0. 冻结边界

1. `char_exact | region_exact | partial | unmapped` 继续表达 artifact 精度,不得被运行时容错改写。
2. 用户能力状态继续是 `resolved | partial | unresolved`;仅 `resolved` 增加正交的 `resolution_basis = exact | recovered`。
3. `recovered` 对用户显示为正常已定位,并获得与 `resolved/exact` 相同的 Highlight、Note、Ask 和 Translate 入口。
4. canonical `source.txt`、LID/range 与英文原文仍是正文和 citation 真相;raw quote 只保存用户实际选择。
5. 初始白名单只含布局空白与连字符类表示差异;不使用覆盖率阈值,不忽略任意标点,不加入 OCR 容错。
6. 运行时不得合成字符 bbox;高亮只绘制已有 glyph rect,Note 末端必须落在精确映射字符上。
7. 后续发现的新型无害差异按第 9 节单独准入,不得顺手扩展白名单。

## 1. 已复现故障

真实段落 `LID 1.19.84` 的 canonical source 长度为 666,selection shard 只覆盖 656 个字符。缺口是 6 个换行处空格和 4 个词内连字符:

```text
feed-forward  -> feedforward
short-term    -> shortterm
key-value     -> keyvalue
long-term     -> longterm
```

`hybrid-alignment-v2` 当前无条件删除 `\p{Pd}` 与 soft hyphen,因此这些字符没有 source assignment。Server 的选区完整性检查会忽略空白,但不会忽略 4 个连字符,最终把唯一、单调且正文完整的长选区判为 `partial`。实测没有其他低精度 region 碰撞,source alignment evidence 也已 verified,故障不属于选区过长、页框误撞或来源不可信。

## 2. 目标契约

```ts
type PdfSelectionResolution = "resolved" | "partial" | "unresolved";
type PdfSelectionResolutionBasis = "exact" | "recovered";
type RecoverableDifference = "layout_whitespace" | "hyphen_representation";

interface PdfSelectionResolveResponse {
  status: PdfSelectionResolution;
  resolution_basis?: PdfSelectionResolutionBasis;
  recovery_policy_version?: "pdf_selection_recovery.v1";
  recovered_differences?: RecoverableDifference[];
  ranges: PdfSemanticRange[];
  quote_markdown: string;
}
```

约束:

- `status !== "resolved"` 时不得返回 `resolution_basis`。
- `resolution_basis = recovered` 时必须返回非空、去重且稳定排序的 `recovered_differences`。
- 新字段保持可选,旧 Reader 忽略后仍按既有三态工作。
- 持久化 selection context 可选保存 `resolution_basis`;旧记录缺失时按 `exact` 兼容,但不得反向提升历史 `partial`。

确定性控制流:

```text
raw quote + canonical source + mapped hits + layout evidence
  -> 唯一、单调对齐失败                         => partial/unresolved
  -> 任一实质字符未覆盖                         => partial
  -> 所有字符均有已证实映射                     => resolved/exact
  -> 缺口全部命中 recovery.v1 且首尾锚精确       => resolved/recovered
  -> 其他情况                                   => partial
```

## 3. recovery.v1 判定表

| 类别 | 可恢复条件 | 必须拒绝的反例 |
|---|---|---|
| `layout_whitespace` | raw quote 与 canonical source 在对齐位置均为空白或等价空白 run;相邻实质字符精确、唯一、单调 | 字母/数字缺失;空白导致候选分词或锚点不唯一 |
| `hyphen_representation` | source/raw 同位置均为 `U+002D/U+00AD/U+2010/U+2011` 的等价连字符,或 PDF 行末 discretionary hyphen 有已验证行边界;相邻字母数字精确 | en/em dash、数学减号、范围标点、无行边界的 source/raw 增删、相邻字符未映射 |

公共拒绝条件:

- 任一字母、数字或非白名单标点缺失、增加、替换或重排。
- 多候选、跨列回退、页序倒退、重复 owner、region-only 字符或输入指纹失败。
- 首个或末个实质字符没有精确 glyph;Note terminal rect 无法确定。
- 只有“覆盖率很高”而没有逐差异分类证据。

## 4. PR0 - 决策、术语与切片落档

- **Do**:冻结用户状态、解析依据、初始白名单、兼容策略、动作边界和发布门。
- **Do not**:不修改运行时代码、schema 或正式 PDF artifact。
- **Done**:ADR-0090、`CONTEXT.md` 与本方案互链;每个后续切片都有输入、输出、正反例和确定性退出判据。

## 5. PR1 - 确定性差异分类器

- **Do**:在 Server 选区域内实现纯函数分类器,输入 raw quote、canonical source、mapped hits 与必要 layout evidence,输出 `exact | recovered(classes) | incomplete`。
- **Do not**:不接 route、不改 UI、不改 aligner、不按百分比放宽。
- **Red**:本段 6 空白 + 4 连字符被判 incomplete;缺少 `not`、数字、句号、数学减号或顺序变化被误判 recovered。
- **Green**:本段判 `recovered(layout_whitespace,hyphen_representation)`;Unicode 空白与受限连字符正例通过;所有语义反例、歧义和非单调样本保持 incomplete。
- **Done**:分类结果只由输入决定,类别顺序稳定,单元测试覆盖判定表全部行。

## 6. PR2 - resolve 与 range projection 同策略闭合

- **Do**:`pdf_selection.resolve` 读取 canonical source 并应用 PR1;只跨已分类缺口合并 canonical ranges,返回 `resolved/recovered`。`pdf_ranges.project` 对同一 range 复用相同 gap policy,返回同一 resolution basis 与已有 glyph rect。
- **Do not**:不合成缺口字符 bbox,不让 region-only/unmapped 提升,不改变 v1 行为。
- **Red**:当前段落仍返回 partial;recovered 后保存的 range 再投影为 partial;伪造 shard 字符或缺少 terminal rect 被升级。
- **Green**:旧 v2 artifact 对当前段落 resolve/project 均为 recovered;canonical quote/range 包含 4 个真实连字符;rect 只来自已证实 glyph;负例保持 partial/unmapped。
- **Done**:Rust route tests 覆盖 resolve -> project 往返,现有 Server PDF runtime 测试全绿。

## 7. PR3 - 持久化与 Web 用户体验

- **Do**:selection context 向后兼容增加可选 `resolution_basis`;Web 将 resolved/exact 与 resolved/recovered 映射到同一无警告动作矩阵,诊断数据保留但不显示“部分定位”。
- **Do not**:不隐藏真正 partial 的提示,不改变 unresolved 原生复制,不在 UI 暴露 recovery 类别说明。
- **Red**:recovered 仍隐藏 Highlight/Note 或显示部分定位;保存后刷新无法回显;历史 partial 被默认升级。
- **Green**:recovered 可 Highlight、Note、Ask、Translate,无部分定位文案;标注刷新后用 recovered projection 回显;旧 selection context 与真正 partial 行为不变。
- **Done**:TypeScript 类型、capability unit tests、组件测试和真实 PDF Playwright 桌面/390px 移动端全部通过。

## 8. PR4 - v2 连字符字符投影修复

- **Do**:修改 `hybrid-alignment-v2` 的字符投影,区分 source/PDF 共同存在的语义连字符与 PDF 行末 discretionary hyphen;前者保留 source assignment,后者只在确定性行边界规则下归一化。
- **Do not**:不把所有 `\p{Pd}` 恢复为 exact,不改变公式 minus,不针对单篇论文或固定单词打补丁。
- **Red**:`feed-forward/short-term/key-value/long-term` 的连字符没有 selection char;PDF 行末多出的断词符被错误写入 source span;en/em dash 与公式 minus 被错误吞掉。
- **Green**:source/PDF 同有的受支持连字符逐字符映射;discretionary line-end hyphen 不伪造 source 字符;现有跨行断词、双栏和 partial exact-subrange 测试保持绿色。
- **Done**:Core v2 unit/foundation/goldset tests 与 typecheck 全绿,错误页和重复绑定仍为零。

## 9. PR5 - 白名单扩展登记机制

- **Do**:把 recovery policy version 与类别集合集中声明,为诊断输出类别命中计数;在本文件维护准入登记表。
- **Do not**:不建立远程开关,不让配置静默改变证据语义,不预先加入尚未复现的标点类别。
- **Done**:未知类别 fail-closed;策略版本进入响应/测试快照;当前只有两类处于 accepted。

后续新增类别必须完成以下独立切片:

1. 保存不含私人正文的最小诊断特征,并提供可本地复现的真实失败样本。
2. 证明 raw/source/mapped 三通道之间没有实质字符变化和候选歧义。
3. 新增至少一个应 recovered 的正例和两个必须 partial 的语义反例。
4. 跑全量 Server/Core/Web PDF 测试与版本化 goldset;错误升级为零。
5. 在下表登记类别、证据、反例、策略版本和日期;只有边界改变时另立 ADR。

| 类别 | 状态 | 正例证据 | 强制反例 | 首次版本 |
|---|---|---|---|---|
| `layout_whitespace` | accepted | LID 1.19.84 的 6 个换行空格 | 字母缺失、分词歧义 | v1 |
| `hyphen_representation` | accepted | 4 个 source/raw 一致的词内连字符与行末断词 fixture | en/em dash、数学减号、无行边界增删 | v1 |
| `formula_representation` | accepted | Eq. 9 真书句的 4 个完整简单公式 source/display/glyph 闭环 | 缺下标字符、变量替换、部分公式选区、未知命令 | v2 |

## 10. PR6 - 真书重建与整版发布门

- **Do**:保留旧 artifact fixture 验证 recovered 路径;在临时目录重建真实论文 v2,验证 1.19.84 升为 exact;跑 resolve/project/保存/刷新物理拖选;通过后再替换正式 artifact、编译 Setup 并记录 hash。
- **Do not**:不直接覆盖正式 artifact,不只看全局覆盖率,不删除旧 artifact 兼容测试。
- **Done**:旧 artifact 当前段落显示已定位且 basis=recovered;新 artifact 同段 basis=exact;两者 Highlight/Note/Ask/Translate 行为一致;真正缺字 fixture 始终部分定位。
- **Done**:Core、Server、Web、Rust workspace、Playwright 与 Setup smoke 全绿;正式 artifact 指纹闭合,安装包大小和 SHA-256 落入代码链路。

## 11. 发布验收矩阵

| 层 | 必测契约 |
|---|---|
| Classifier | 两类白名单正例、字母/数字/标点/减号反例、唯一性、单调性、terminal anchor |
| Resolve | exact、recovered、partial、unresolved 四种内部结果稳定映射到三种用户状态 |
| Projection | recovered canonical range 可回显,只返回 proven rect,无 synthetic bbox |
| Persistence | 可选 basis 向后兼容,旧 partial 不升级,Note/Highlight 刷新稳定 |
| Web | recovered 无警告且动作完整,partial 警告与限制不回归,unresolved 原生复制 |
| Core | 语义连字符映射,discretionary hyphen 归一化,en/em dash 与 minus 不误吞 |
| Real PDF | 旧 artifact recovered、新 artifact exact、桌面/移动物理拖选与安装包 smoke |

禁止以“这次段落看起来正常”作为完成;必须同时证明白名单正例可恢复、语义反例不升级、保存后反向投影稳定。

## 12. PR7 - 同基线阅读顺序与完整公式表示恢复

- **Do**:保留与 spanning 分段处于同一视觉基线的右侧续段,并按横向顺序插入同一行;只为可确定性去除公式源标记且与唯一 PDF glyph 序列一致的完整简单公式生成 selection assignments 与 `formula_display_text`。
- **Do**:Server 只在一次选区覆盖公式全部显示字符时扩展为完整公式 canonical range,用 `formula_representation` 记录 recovered;反向投影复用相同证据并以末个真实 glyph 作为公式 terminal rect。
- **Do not**:不把 region evidence 升为字符证据,不接受未知 LaTeX 命令,不合成公式标记 bbox,不允许部分公式选区绕过 partial precision。
- **Red**:同基线 `, where` 被丢弃后在下一页误锚;Eq. 9 原句跨 4 个公式返回 partial;缺下标字符或 `W -> X` 被升级。
- **Green**:同基线分段顺序为左文本 -> 中间公式片段 -> 右续段;真书原句返回 `resolved/recovered`,4 次 `formula_representation`,9 个 canonical range 均能 exact 反向投影;两个语义反例保持 incomplete/partial。
- **Done**:隔离真书连续两次 digest 一致并事务写回;Core/Web/Rust workspace、production build、Playwright PDF actions 与正式 artifact 回放全绿。
