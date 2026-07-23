# 切片方案 - PDF 选区全书适配闭环

> 状态:2026-07-23 PR8-PR19 已完成,PR20-PR21 待实施。
> 问题源:[PDF 选区适配问题总账](PDF选区适配问题总账.md)。
> 已完成前序:[PDF 选区可恢复定位](切片方案-pdf选区可恢复定位.md) PR1-PR7。
> 决策边界:[ADR-0082](adr/0082-hybrid-foundation-semantic-unit-alignment-and-degraded-reader.md)、[ADR-0090](adr/0090-pdf-selection-recovered-resolution-and-versioned-discrepancy-policy.md)。
> 变更类型:`[边界重构]`。

## 0. 对齐确认单

**FrozenIntent**:解决总账 PDF-A001 至 PDF-A011,使有完整确定性证据的正文、标题、列表、代码和公式选区不再显示“部分定位”;真实来源差异、歧义和无字符 PDF 对象继续 fail-closed。实施按独立 PR 推进,最终重建正式书、提交并重新编译 Windows Setup。

**本轮不做**:本文件只落实施方案和验收门,不修改 aligner、Server、Web、正式书 artifact 或 Setup。

**成功标准**:第 5 节问题覆盖矩阵全部闭合,第 7 节全书发布门全部通过,且不存在未分类的 `partial/unmapped` 原因。

**TermMap**:`Hybrid alignment unit`、`PDF projection precision`、`PDF selection resolution basis`、`Versioned alignment benchmark`、`PDF visual source map` 和 `PDF selection map` 均沿用 `CONTEXT.md`;本文新增名称只作为实现内部数据结构,不改变领域语义。

**RiskReceipt**:用户在获知该工作必须分阶段、不能靠局部白名单完成后要求继续落档。来源修复可能改变 LID 树,必须遵守 ADR-0019/0020 的新基座和确定性迁移边界,不得原地改坏旧引用。

## 1. 冻结边界

1. 不以“全叶节点 100% `char_exact`”为目标。公式源标记、图片和无字形对象本来就不等于逐字符正文;目标是每个用户可见选择得到与证据相符的能力。
2. 对 source/PDF 等价且 PDF.js 暴露字符的内容,最终必须是 `resolved/exact` 或 `resolved/recovered`;不得因 unit 过大、LCS 漂移、透明包装、Markdown 标记或已证明的 glyph 表示差异显示部分定位。
3. 字母、数字、运算符缺失或替换,候选歧义、错页、跨栏回退和重复 binding 继续 fail-closed。不得用覆盖率、编辑距离或“看起来像”升级。
4. `source.txt` 和 LID/range 仍是 citation 真相。PDF raw quote 只能证明用户看到什么,不能反向改写 canonical source。
5. 上游来源确实错误时走 source reconciliation/review。若修复改变树结构,生成新书基座与 `lid_migration_map`;旧基座和旧记忆保持只读,禁止猜最近邻。
6. 图片是对象投影,不是文本投影。图片无 selection char 不计入文本失败,但不能吞掉相邻正文或让正文选区降级。
7. 每个新增表示差异仍按 ADR-0090 单类准入:真实样本、最小正例、至少两个语义反例、版本号和全量回归缺一不可。
8. 每个 PR 先有 red characterization,再改实现;完成时立即更新问题总账状态和 `docs/代码链路.md`。改变主要数据流的 PR 同步更新 `docs/架构.md`。

## 2. 基线与终态不变量

冻结输入为总账第 3 节四个输入/config hash 和正式 artifact digest `bcc7c04a...cd3fd2`。当前 2,075 个叶节点为:

| Precision | 当前数量 |
|---|---:|
| `char_exact` | 657 |
| `partial` | 368 |
| `region_exact` | 79 |
| `unmapped` | 971 |

最终 runner 必须同时验证以下不变量:

```text
all 2,075 baseline leaves (or their deterministic migrated successors) classified
  AND current_candidate_leaf_coverage = 100%
  AND unexpected_reason_count = 0
  AND wrong_page_count = 0
  AND duplicate_region_binding_count = 0
  AND duplicate_selection_binding_count = 0
  AND material_mismatch_upgraded_count = 0
  AND source_equivalent_visible_selection_partial_count = 0
```

终态按内容种类解释:

| Kind | 必须达到的终态 |
|---|---|
| 正文/标题/列表 | 所有 material-equivalent 可见字符拥有唯一 source span;整句和任意连续子句 resolve/project 往返闭合 |
| Code | 先成为 code 资产而非 chapter/paragraph;经来源复核的可见代码字符可选择,未复核 material mismatch 明确阻断发布 |
| Formula | 所有 PDF.js 可选 glyph 绑定到公式可见 token;透明 wrapper 和任意已映射子公式可正常选择;无字符公式只允许对象级 region |
| Image | 具有对象 region 或显式 `asset_unmapped`;不进入文本 exact 分母,不影响相邻正文选区 |
| 真差异/歧义 | 保持 fail-closed,输出稳定具体原因;不得再归入含糊的“部分定位”适配桶 |

## 3. 依赖状态机

```text
PR8_FULL_BOOK_BENCHMARK
  -> PR9_STRUCTURAL_BLOCKS
  -> PR10_REVIEWED_SOURCE_REPAIR_AND_LID_MIGRATION
  -> PR11_BOUNDED_ALIGNMENT_UNITS
  -> PR12_CHILD_LOCAL_MONOTONIC_WINDOWS
  -> PR13_MARKDOWN_AND_GLYPH_DISPLAY_EQUIVALENCE
  -> PR14_FORMULA_SOURCE_AST_AND_TRANSPARENT_WRAPPERS
  -> PR15_FORMULA_GEOMETRY_LOCALIZATION
  -> PR16_STRUCTURAL_FORMULA_GLYPH_PROJECTION
  -> PR17_IMAGE_OBJECT_PROJECTION
  -> PR18_BINDING_CONFLICT_ELIMINATION
  -> PR19_RESOLVE_PROJECT_AND_WEB_CAPABILITY_CLOSE
  -> PR20_REAL_BOOK_ATOMIC_REBUILD
  -> PR21_SETUP_RELEASE
```

规则:

- PR9/PR10 先稳定 canonical source 与结构。其后任何算法 PR 不得偷偷修 source。
- PR11/PR12 先限制搜索空间。PR13-PR16 不得在宽 unit 或跨 child LCS 上增加容错。
- PR14 只建立公式 source/display 真相,PR15 只定位几何,PR16 才建立逐 glyph 绑定;三刀不得合并。
- PR17 的 image region 不进入 selection shard。PR18 只能消除有唯一证据的冲突,不能把 fail-closed 改成抢占成功。
- PR19 只消费已证明的 artifact 证据,不能在 Server/Web 重新猜映射。
- 任一前置门变红,PR20 不得替换正式 artifact,PR21 不得构建发布 Setup。

## 4. 实施切片

### PR8 - 全书版本化适配基准

**状态**:`completed`。正式基线为 2,075 leaves / 12 projection reasons / 43 sections；真实 audit 双次序列化一致且通过。

- **做**:扩展 existing external goldset descriptor,以 source span 指纹加旧 LID 记录 2,075 个叶节点、12 类 projection reason、43 个 section 统计和 A001-A011 标签;新增确定性 audit runner,输出 reason closure、迁移覆盖、错误页、重复 binding 和选择能力矩阵。
- **不做**:不改生产 aligner、Server policy、正式 artifact 或阈值。
- **Red**:现有 goldset 只报告聚合质量,无法证明 657+368+79+971 和 12 类 reason 完整闭合,也无法在 LID 改变后追踪同一 source 内容。
- **Green**:同一正式书连续两次 audit JSON 字节一致;总数、各 reason、各 section 与总账完全相等;任意删除、重复或改类一个 leaf 都使 runner 失败。
- **完成判据**:`hybrid-foundation-goldset.test.ts` 与新 audit test 全绿;external descriptor 不保存受版权保护正文,只保存 hash、span 指纹、LID 和预期类别。
- **主要触达**:`packages/core/src/hybrid-foundation-goldset.ts`、`packages/core/scripts/run-hybrid-foundation-release-gate.ts`、external descriptor/new audit fixture。

### PR9 - Markdown 结构块与代码边界

**状态**:`completed`。Core 已切换到带 UTF-16 source position 的 CommonMark/GFM/math AST；正式 source 不变，10 个 source-review proposal 与 463 个 LID 漂移输入已冻结给 PR10。

- **做**:用具备 source-position 的成熟 Markdown parser/插件链替代 `md-adapter.ts` 中不断增长的行级猜测;保留现有 UTF-16 span,正确区分 heading、list item、fenced/indented code、inline/display formula、table 和 image。对缺 fence 的长代码清单只生成 source-review proposal,不自动改成 code。
- **不做**:不修改 canonical source,不在 parser 中加入“E.4 后都是代码”这类书本特例,不改几何对齐。
- **Red**:本书 `# seed all`、`# project` 被切成 chapter 2-8;外层公式中的嵌套 math delimiter 产生损坏节点 `1.19.87.191.212 = $.}} $`。
- **Green**:许可 fixture 覆盖 prose heading/list/code comment/nested math;只有语法上受证明的 heading 才建容器,代码注释保持 code 内容;所有 source byte 仍被恰好一个 block span 覆盖。
- **完成判据**:`md-adapter.test.ts`、`segment.test.ts`、source partition/roundtrip 和 Core typecheck 全绿;本书输出一份待 PR10 复核的结构差异清单。

### PR10 - 来源实质差异复核与 LID 迁移

**状态**:`completed`。真实书 28 个 A011 与 10 个 PR9 proposal 已全部获得冻结决策；候选只消费 reviewed original Markdown 与 `arXiv:2505.19488v1` 官方 TeX，正式旧 source/base/maps/记忆均未修改。
- **做**:把 A011 的 28 个 material mismatch、缺 fence 的代码清单和损坏公式分段送入 existing source reconciliation/review;只接受来自原 Markdown、论文官方补充材料或人工逐项确认的修复。以新 book_id 构建候选 canonical source/base,生成 `lid_migration_map` 和旧问题项到新 LID 的确定性映射。
- **不做**:不从近似 PDF 文本或模型输出自动补字,不原地覆盖旧基座,不猜最近 LID,不把未确认差异转成 recovery 类别。
- **Red**:A011 字母/数字缺口仍被当作映射 bug;代码伪章节污染 LID 树;旧 Note/Highlight 在结构变化后静默指向新邻居。
- **Green**:28 项逐项得到 `reviewed_repaired | intentional_source_difference`;代码边界得到明确 review decision;stable/drift/removed migration 符合 ADR-0020,旧引用不被改写。
- **完成判据**:若目标书仍有未复核 material mismatch,本 PR 可以提交工具能力但第 7 节发布门保持红;要宣布“本书全部解决”,28 项和代码清单必须全部复核完成。
- **完成证据**:38 项决策为 25 `reviewed_repaired` + 13 `intentional_source_difference`；其中 A011 为 15 + 13。隔离双跑得到相同 `source/base/migration` SHA-256 `feb442...af43 / 589c60...f3f / ead42b...94db`；候选 1,945 leaves、2 个 code asset、0 parser proposal、partition coverage 1，迁移 `stable=1935 / content_drift=10 / removed=130` 且 candidate 漏配/重复均为 0。此处只批准 source review；语义图与正式发布仍明确等待 PR20 重建门。

### PR11 - 有界 alignment unit 构造

**状态**:`completed`。approved source 的 1,945 leaves 被确定性分为 625 units；多 child 越界、结构边界违规、漏配与重复均为 0。PR8 正式旧书审计也已接入同一版本化 unit gate 并保持通过。

- **做**:让 unit 只合并同一源 paragraph 内相邻的 text/formula children;heading、list block、code、table、image、caption 和 paragraph 边界均切断传播。加入版本化 guard:候选上限 `24 children / 1,200 UTF-16 units / 240 searchable tokens`;单个超限 child 作为 `oversize_singleton` 诊断,不得连带邻居。
- **不做**:不拆 LID,不按 PDF 页码写死 source 边界,不提高 fuzzy 容忍,不改变 child projector。
- **Red**:`unit-75/239/240/248/297/304` 仍形成 1,102-5,809 字符、29-84 children 的共享窗口。
- **Green**:相同 source 两次构造 unit 边界一致;除显式 singleton 外无 unit 越过 guard;高风险 unit 被切为独立可定位片段,相邻段失败不再连坐。
- **完成判据**:unit snapshot、inline formula、table/caption、code 和 cap boundary 测试全绿;PR8 报告中 `oversized_multi_child_unit_count=0`。
- **完成证据**:真实候选 unit audit 三次与入库 fixture 字节一致，SHA-256 `d33cdd00...b5cbc5a`；625 units / 1,945 children，`within_guard=621`、`oversize_singleton=4`、`oversized_multi_child=0`、`boundary_violation=0`，最大多 child unit 为 24 children / 1,090 UTF-16 / 184 searchable tokens。正式旧书 PR8 audit 为 675 units / 1,983 children，新增 unit closure 全绿且整体 `passed=true`。本 PR 不改变 child projector；standalone display formula 在 PR15 前仍按已有证据保持 partial/unmapped。

### PR12 - child 局部单调窗口

**状态**:`completed`。exact child anchors 由唯一最大单调非重叠链决定；未锚 child 只在相邻 anchors 的独占局部窗内运行 LCS，多 child 共享未分割窗口时整体 fail-closed。

- **做**:在 located unit 内先建立唯一强 child anchors,再用相邻已证实 anchor 划分 PDF key window;每个 child 只在自己的 window 内产生 exact/LCS candidates,以全局单调非重叠链选择唯一解。child 失败不推进共享 cursor,material PDF key 不得跨窗被 LCS 吞掉。
- **不做**:不新增表示白名单,不让 coverage 最高者自动胜出,不让前后 child 继承失败 child 的区域。
- **Red**:A004 的 54 个 paragraph 可跨 11-359 个额外字符仍产出 partial assignment;A005 的 129 个 child 在 unit 已定位时被 cursor 挤空。
- **Green**:wrong-window assignment 为 0;A004 每项变为局部 exact/明确 material mismatch;A005 每项得到独立候选或稳定具体拒绝原因,长度不再决定是否被丢弃。
- **完成判据**:合成重复短句、脚注、相邻栏、公式夹段和 129 项真实 audit 回放全绿;`has_unmatched_material_pdf` 不再来自跨 child 漂移。
- **完成证据**:approved source replay 覆盖 A004 全部 54 项（51 successor + 3 个 PR10 explicit removed）与 A005 全部 129 successor；`wrong_window_assignment_count=0`、旧共享 cursor reason 为 0。A004 successor 为 6 exact / 15 local material partial / 30 explicit unmapped；A005 为 29 exact / 5 partial / 95 explicit unmapped，没有用 coverage winner 强行升级。无正文报告双跑与 fixture SHA-256 均为 `bfdba059...b4d60a`。

### PR13 - Markdown 可见表示与 glyph 等价微切片

**状态**:`completed`。display token 只由 positioned Markdown role 产生，prose/code 使用不同等价策略；`pdf_display_token_policy.v1` 已写入 Core 新产物并由 Server 对显式未知版本 fail-closed。

- **做**:建立带 source span 的 display token 投影。heading `#` 是不可见结构标记,list `-` 与 PDF bullet 只在 parser 已证明的 list-marker role 下等价;正文 whitespace 使用既有换行证据。对 A003 的 28 项先真实 replay,再按 apostrophe、dash、ligature、标点缺失等类别各开 `PR13.x` 微切片并逐类登记 policy version。
- **不做**:不忽略任意 Markdown 字符或所有标点;code 中 `#`,引号、括号和减号始终是 material;缺句点/冒号若没有 glyph 证据不得 recovered。
- **Red**:heading 3、list 5 和 punctuation/symbol 28 仍混成 generic partial;代码标点可被 prose 规则误放行。
- **Green**:A002 八项按结构角色闭合;23 个 whitespace 项逐项 replay;A003 28 项分别进入 accepted representation 或 A011 material mismatch,不再存在“punctuation/symbol”未决大桶。
- **完成判据**:每个 accepted 类别有 1 个真实正例和至少 2 个语义反例;unknown role/category fail-closed;Server recovery policy 与 Core display token 版本相互校验。
- **完成证据**:approved source/PDF 无正文审计双跑一致，SHA-256 `fe35ffe8...b73f6`。A002 为 6 个 parser-role successor + 2 个 reviewed removal；28 个 punctuation/symbol 为 11 accepted glyph representation + 9 material punctuation + 8 removed；23 个 whitespace 为 17 个既有 `layout_whitespace` policy successor + 6 removed；missing/unclassified 均为 0。分类闭合不改写当前 precision，仍受公式/window 门影响的项继续 fail-closed，交由 PR14-PR19。Core 定向 5 files / 57 tests、全量 62 files / 384 tests、typecheck 与 Server 179+5 tests 全绿。

### PR14 - 公式 source AST 与透明 wrapper

**状态**:`completed`。`latex-utensils` positioned AST 已替代公式字符串命令删除器；`formula_source_ast.v1` 区分透明 wrapper、layout、structural relation、glyph transform 与 unknown command，并进入新 V2 config hash。

- **做**:采用成熟、可保留 source position 的 LaTeX parser,生成可见 token、结构关系和 source span;明确区分透明 wrapper、布局控制和产生/重排 glyph 的数学节点。`\underline/\text/\textit/\textbf` 仅在 AST 闭合且子 token 完整时透明;修复外层公式与内层 math delimiter 的结构分段。
- **不做**:不继续扩 `FORMULA_WRAPPER_COMMANDS` 字符串删除器,不把 `frac/sum/sqrt/underbrace` 当透明命令,不接 PDF geometry。
- **Red**:47 个 `\underline` formula 都没有 display evidence;损坏节点 `$.}} $` 仍存在;未知命令可因删字符串伪造可见文本。
- **Green**:A001 用户句、多行/单行 underline、嵌套 text style 和中部子句均保留正确 source span;未闭合 brace、未知命令和真正数学变换进入结构节点而非被忽略。
- **完成判据**:formula AST/token snapshot 与 roundtrip tests 全绿;47 个 underline 节点都有可解释 token 结果,但本 PR 不宣称几何已定位。
- **完成证据**:approved source 中 47 个 A001 baseline 全部命中 migration：46 个 formula successor 均为 `transparent_wrapper_projectable`，1 个 PR10 `content_drift` 已审核修复为 paragraph；missing/invalid/unclassified/parser proposal 均为 0。无正文审计双跑字节一致，SHA-256 `2047b264...b62b5cf`。Core 定向 4 files / 49 tests、全量 63 files / 392 tests、typecheck 全绿；未修改正式 source/base/maps/selection shards，也未接 PR15 geometry。

### PR15 - 不依赖双侧正文的公式几何定位

- **做**:在 PR12 child window 内用 formula token signature、source order、page/column lane 和相邻对象边界定位公式。支持双侧、单侧、段首/段末和 standalone display formula;重复短式只有唯一全局单调链时才绑定。
- **不做**:不生成 source assignment,不以邻接 paragraph bbox 代替公式 region,不跨页/跨栏猜最近候选。
- **Red**:27 个 formula 因缺同页同栏双侧锚而 partial;79 个 region-only 与大量 no-gap 依赖邻居偶然成功。
- **Green**:27 个 anchor-lack baseline successor 全部得到唯一 region、明确结构歧义、reviewed 改类或显式下游 owner;79 个 region-only successor 有区域者必须与 reviewed 页/栏标注一致,其余只能进入 PR16 glyph 或 PR18 unit locator owner;重复 `$n$/$TC^0$` fixture 保持 fail-closed 直到整链唯一。
- **完成判据**:公式 region wrong-page/wrong-column 为 0;“lacks same-page same-column anchors” reason 在本书归零;所有 successor 均有唯一分类,不得以 PR15 region 生成 source assignment。
- **完成证据**:`pdf_formula_region_policy.v1` 在 PR12 child window 内按 source order、page/column lane 和唯一完整单调链定位；单侧/段首/段末/standalone 可独立产出 `region_exact`，跨页/跨栏、相邻锚 lane 冲突和多整链显式拒绝。approved source 的 106 个 A007 baseline 全部命中 migration：57 unique region、9 existing display projection、21 explicit structural ambiguity、12 PR18 unit locator、6 PR16 glyph、1 reviewed non-formula；missing/unclassified、wrong-page、wrong-column、legacy anchor-lack reason、PR15 region assignment 和 cross-lane region 均为 0。58 个原 region-only successor 保有可比较几何且页/栏全匹配，22 个 anchor-lack successor 已在本刀解析/明确歧义/审核改类，其余有显式下游 owner。无正文审计三跑字节一致，68,128 bytes，SHA-256 `df0edd21...00c4bbd`；Core 定向 4 files / 52 tests、全量 64 files / 402 tests、typecheck，Server 180+5 tests 全绿；正式 source/base/maps/selection shards 未修改。

### PR16 - 复杂公式结构化 glyph 投影

**状态**:`completed`。`pdf_formula_glyph_policy.v1` 已把可证明公式 glyph 绑定到 positioned source token；不完整字形、错误二维关系、跨 lane 和候选冲突继续 fail-closed，并保留给 PR18/PR20 的显式 owner。

- **做**:把 PR14 AST 可见 token 与 PR15 region 内 PDF glyph 建立结构约束匹配。普通序列用局部单调链;上下标、分数、根号、求和/乘积 limits、accent/brace 按 AST 父子关系和二维几何 lane 验证。每个 glyph/source token 一对一或有显式合字证据,不可见源标记不合成 bbox。
- **不做**:不把公式渲染成图片再 OCR,不按字符串覆盖率升级,不让一个公式 token 争用另一公式 glyph。
- **Red**:314 no-gap、4 ambiguous 和 216 个“仅受支持命令仍不可恢复”公式没有结构证据;部分公式选择仍因“必须整式”显示 partial。
- **Green**:本书所有 PDF.js 可选 formula glyph 拥有 source token assignment;任意连续已映射子公式可 resolve/project;缺下标、变量替换、运算符变化和二维关系错误仍拒绝。
- **完成判据**:公式 reason 中 `no unique bounded gap / projection ambiguous / anchor lack` 均为 0;无字符或不可解析公式以明确对象级 reason 留在 `region_exact`,且不影响相邻正文。
- **完成证据**:approved source/PDF 的 830 个公式中，395 个公式产生 2,785 条 glyph assignment，全部为 `partial` 且 assignment source span、exact-span 覆盖、全局 PDF glyph ownership、reviewed page/column 校验均为 0 违规。其余 435 项闭合为 PR18 unit locator 278、binding conflict 53、lane ambiguity 51、glyph/material/geometry mismatch 52、unsupported source structure 1；没有按覆盖率升级。旧 A006 318 项经 migration 分类为 glyph projected 100、PR18 unit/binding 153、lane 28、mismatch 36、reviewed non-formula 1，missing/unclassified 为 0；三个旧公式 reason 均归零。无正文审计三跑字节一致，714,065 bytes，SHA-256 `5d22207e...38a000e`；缺下标、变量/运算符替换、错误分数/上下限 lane、未知命令和 flat underscore 反例继续拒绝。Core 全量 66 files / 416 tests、typecheck，Server 181+5 tests 与 Rust fmt check 全绿；正式 source/base/maps/selection shards 未修改。

### PR17 - Image 对象投影与文本隔离

- **做**:从 PDF.js operator list 提取 image/object bbox,以 source image 顺序、页内 caption anchor 和唯一候选约束生成 asset region;无法唯一绑定时记录 `asset_unmapped`。text alignment/unit/quality 统计排除 image-only token 要求,选区退化检查只看实际命中的文本 glyph/公式 glyph。
- **不做**:不 OCR 图片文字,不按 alt 文本搜索 PDF,不把整页或 caption bbox 当图片 bbox,不把 image region 写入 selection shard。
- **Red**:19 个 image-only unit 以“no searchable tokens”混入 text unmapped,并可能扩大相邻选择的 degraded region。
- **Green**:19 项全部转为 `asset_region_exact | asset_unmapped`;相邻正文选区不因图片 region partial;图片 LID 导航只在唯一 region 时启用。
- **完成判据**:image XObject、vector-only figure、重复图标、caption-only 和无图对象 fixtures 全绿;文本质量分母与选择能力不受 image 数量影响。
- **完成证据**:`pdf_asset_region_policy.v1` 从 PDF.js operator list 提取 raster/image mask/inline image 与 vector Form 的真实 bbox，以 source image 顺序、已证明前后锚、同页 caption 横向重叠和已绑定 asset 间唯一剩余对象链做 fail-closed 绑定。approved source/PDF 的 19 个 image successor 全部为 `asset_region_exact`：6 个 source-order anchor window、12 个唯一 caption candidate、1 个相邻 asset 唯一缺口；A010 migration 精确筛出 19 image，0 missing/unclassified、0 invalid evidence、0 duplicate object owner、0 wrong page/column、0 selection assignment、0 exact source span、0 legacy no-searchable projection reason。image-only unit 从 text location quality denominator 与 reason 统计排除，正文 selection glyph 在插图前后字节等价；region 永不进入 selection shard。无正文审计三跑均为 22,203 bytes，SHA-256 `f5901ac3...c2298b`；Core 全量 67 files / 431 tests、typecheck，Server 182+5 tests、Rust fmt 与 offline frozen install 全绿；正式 source/base/maps/selection shards 未修改。

### PR18 - Binding 冲突消除与候选归属

**状态**:`completed`。`pdf_binding_ownership_policy.v1` 已把跨 unit 竞争前移到 artifact 构造之前；同角色完整 glyph owner 可排除 partial 候选，结构角色不同或等证据多解整组 fail-closed，末端整项丢弃器已退出正常路径。

- **做**:在写 artifact 前汇总所有 child/formula/code candidates,按 source order、exclusive child window、结构角色和 glyph ownership 求唯一非重叠解;记录每个被拒候选的竞争者和约束。若仍有多个同分解,整组保持 fail-closed。
- **不做**:不按先到先得、LID 顺序或最高 coverage 抢 binding,不删除重复检测 integrity gate。
- **Red**:11 个 raw conflict 只能在末端全部丢弃;短公式和代码重叠没有可审计的前置归属原因。
- **Green**:已有 11 项在前置结构/窗口修复后得到唯一 owner 或稳定 `ambiguous_binding` 结果;本书正式候选的 raw duplicate region/selection binding 均为 0。
- **完成判据**:强制重复短式 fixture 仍 fail-closed;人为制造双 owner 时 integrity gate 必红;无末端“先生成再整体丢弃”的正常路径。
- **完成证据**:approved source/PDF 的候选阶段有 0 个竞争 region、15 个竞争 selection glyph，分成 2 个唯一 ownership 组；2 个越界 partial 候选被同角色完整 glyph owner 排除，resolved/formal raw region 与 selection duplicate 均为 0。全部 418 个本地/跨 unit 被拒候选都有 competitor、constraint 与 resource key，0 invalid、0 漏审；旧 A009 11 项经 migration 闭合为 3 unique owner、1 stable `ambiguous_binding`、6 reviewed removed、1 reviewed content drift。无正文审计四跑均为 6,228 bytes / SHA-256 `ae431d40...c38e8a`；PR16 公式审计保持 395 个公式/2,785 assignments 与 53 个 binding conflict，仅细化为 30 个等解公式链和 23 个 incomplete chain reason。Core owning 6 files / 76 tests、单 worker 全量 69 files / 437 tests、typecheck，Server 183+5 tests 与 Rust fmt 全绿；正式 source/base/maps/selection shards 未修改。

### PR19 - Resolve/project 与 Web 能力闭环

**状态**:`completed`。运行时现在只按 selection-shard glyph assignment 重建连续可见范围；resolve/project 共用公式 assignment catalog 与 terminal glyph 约束，Web 只消费 Server capability/diagnostic，不自行推断恢复规则。

- **做**:Server 从 display-token/formula-token assignments 重建用户实际可见 canonical ranges,允许任意连续已映射子句/子公式;resolve 与 range project 共用同一证据和 terminal glyph。Web 只按 `resolved | partial | unresolved` 能力显示动作,并把真正 material mismatch/ambiguous 诊断与可恢复表示差异区分。
- **不做**:不把 `region_exact` 相交本身作为一票 partial,不在 Web 猜 recovery,不为无 source token glyph 开启 Highlight/Note/Ask citation。
- **Red**:A001 完整句、任意 wrapper 中部、复杂公式子选区和跨 text/formula 选区仍被 region precision 强制 partial;保存后反向投影结果不同。
- **Green**:总账三个用户原句以及新增各类别真实选区均 `resolved`;Highlight/Note/Ask/Translate 可用且刷新回显;真正缺字、歧义和无 source glyph 选择保持受限。
- **完成判据**:Rust route、Memory roundtrip、Web capability/component 和 PDF.js Playwright desktop/390px 全绿;resolve -> save -> project 是幂等闭环。
- **完成证据**:approved source/PDF 隔离候选上，A001 完整跨 text/formula/text 句、wrapper 中段和复杂公式 `ϕ(k)⊤ϕ(q)` 三类真实可见范围均 `resolved/recovered`，反向 projection 对全部 range 返回 `exact`、完整 `covered_range` 和同一 terminal glyph；缺字/变量替换/缺 terminal 仍为 `material_or_ambiguous`，无 source glyph 为 `no_source_glyph`。Server 全量 185 tests、Memory selection-context 6 tests、Web 26 files / 150 tests、typecheck/production build、PDF.js Playwright 11 tests（desktop + 390px）与 Rust fmt 全绿；390px 截图确认状态和动作无重叠。正式 artifact 未在本刀切换，归 PR20。

### PR20 - 真书候选重建与原子切换

**状态**：`completed`。reviewed v2 作为独立 sibling book version 发布；旧书、旧图和旧记忆保持只读不变。

- **做**:在隔离目录从 PR10 approved source snapshot 连续重建两次;运行 PR8 全书 audit、Core/Server/Web/Rust 全量回归和真实 PDF.js 选区矩阵。若 source/LID 变化,先验证新基座与 migration map,再通过 existing journal applier 原子切换用户选择的新书版本。
- **不做**:不直接覆盖当前正式 artifact,不沿用旧 hash 下的总账数字,不因 exact ratio 上升忽略错页、冲突或未分类项。
- **完成判据**:第 7 节除 Setup 外全部为绿;两次 candidate digest 相同;旧基座/旧记忆仍可读;正式切换后 artifact、manifest、selection shards、semantic graph 和 migration identity 全闭合。
- **完成证据**:双构建 digest 均为 `cc056062...3e19e9`；PR8 baseline 2,075 / matched 2,075 / current 1,945，missing/unexpected/unknown reason 均为 0。wrong-page/column、formal duplicate region/selection 与 material-mismatch upgrade 均为 0。semantic graph 仅迁移 stable anchor，877/1,003 -> 800/929；旧 artifact/graph digest 发布前后不变。`release-cc056062004a7d8a` journal revision 12 committed 后发布 `understanding-transformer-from-the-perspective-of-reviewed-v2`。Core 69 files / 439 tests、Rust workspace、Server 185、Web 150、Playwright 11 与真实新旧书回放全绿。

### PR21 - 提交与 Windows Setup 发布

- **做**:只从 PR8-PR20 已提交的 clean frozen snapshot 构建 Setup;运行 plugin/release parity、Web production build、build/MCP sidecar smoke、Rust release 和 NSIS;记录 commit、size、SHA-256 和 version。
- **不做**:不吸收主工作区无关 dirty 文件,不在 Setup 构建中修测试,不启动安装器。
- **完成判据**:release gate 全绿;bundle/export/final Setup 字节与 hash 一致;`docs/代码链路.md`、问题总账 fixed 状态和 checkpoint 全部指向最终 commit/artifact。

## 5. 问题覆盖矩阵

| 问题 | 主修切片 | 防回归/收口 | 退出判据 |
|---|---|---|---|
| A001 透明 LaTeX wrapper | PR14 | PR16/PR19/PR20 | 47 underline 节点有 token 证据;用户句和中部子句均正常定位 |
| A002 Markdown 控制符 | PR9/PR13 | PR19/PR20 | heading/list 八项无 generic partial;code `#` 不误作 heading |
| A003 标点/glyph 表示 | PR13.x | PR19/PR20 | 28 项全部逐类 accepted 或转 A011,无宽泛标点白名单 |
| A004 LCS 跨 material PDF | PR11/PR12 | PR18/PR20 | 54 项无跨 child/window assignment,wrong-page 为 0 |
| A005 located child 丢失 | PR12 | PR20 | 129 项有局部结果或具体 material/ambiguity 原因,不再由 cursor 丢弃 |
| A006 复杂公式模型 | PR14/PR16 | PR19/PR20 | 314 no-gap 与 4 ambiguous reason 归零;可选 glyph 有 token owner |
| A007 双侧锚限制 | PR15 | PR16/PR20 | 27 anchor-lack reason 归零;79 region 页/栏正确 |
| A008 过大/未定位 unit | PR9-PR12 | PR20 | 45 个未定位 unit 逐项迁移闭合;multi-child unit 不越 guard |
| A009 binding 冲突 | PR12/PR18 | PR20 | raw/formal duplicate binding 均为 0;强制歧义仍 fail-closed |
| A010 image/code 模型 | PR9/PR10/PR17 | PR19/PR20 | code 不污染章节树;19 image 成为 asset 结果且不影响文本选择 |
| A011 source material 缺字 | PR10 | PR13/PR20 | 28 项均有 approved repair;未复核项阻断“全部解决”发布声明 |

覆盖闭合规则:

```text
for issue in PDF-A001..PDF-A011:
  require owner_slice
  require red_fixture
  require deterministic_green_gate
  require real_book_replay_or_explicit_intentional_reason
  require ledger_status == fixed | intentional
```

## 6. 每刀验证命令

按触达范围选取,但不得少于 owning row:

| 层 | 命令/验证 |
|---|---|
| Parser/Core 定向 | `pnpm -C packages/core test -- md-adapter.test.ts hybrid-alignment-v2.test.ts` |
| Foundation/goldset | `pnpm -C packages/core test -- hybrid-foundation-v2.test.ts hybrid-foundation-goldset.test.ts` |
| Core 静态/全量 | `pnpm -C packages/core typecheck`;`pnpm -C packages/core test` |
| Server | `cargo test -p server --lib`;定向 recovery/resolve/project tests |
| Memory/Reader | `cargo test -p memory`;`cargo test -p reader` |
| Web | `pnpm -C packages/web typecheck`;`pnpm -C packages/web test`;`pnpm -C packages/web build` |
| 全仓 | `pnpm test`;`cargo test --workspace` |
| 真书 | external release gate + PR8 adaptation audit + 同一输入双次 digest |
| 浏览器 | PDF.js desktop/390px Playwright:resolve,Highlight,Note,Ask,Translate,refresh project |
| Setup | `pnpm -C apps/desktop package:windows` + plugin/release parity + sidecar smoke |

每个 red fixture 必须先在该 PR 基线失败,不能在同一提交里只展示最终绿色。真书命令必须先校验 source/PDF/evidence/config hash;hash 改变即生成新 audit snapshot,不得复用旧 expected 数量。

## 7. 全书发布门

PR20/PR21 只有同时满足以下条件才可完成:

1. PR8 audit 对旧 2,075 项或其 deterministic migrated successors 覆盖 100%,并对候选书当前全部叶节点覆盖 100%,`unexpected_reason_count=0`。
2. 所有 material-equivalent、PDF.js 可见的 paragraph/code/formula 选择均为 `resolved/exact|recovered`;不再因 A001-A008/A010 的适配缺陷显示部分定位。
3. A011 28 项和损坏代码来源均有 approved canonical decision;任何未复核 material source difference 阻断“本书全部解决”。
4. wrong-page、wrong-column、raw/formal duplicate region binding、raw/formal duplicate selection binding 均为 0。
5. 强制缺字、变量替换、运算符变化、重复短式、跨页/跨栏和未知表示类别全部保持 fail-closed,`material_mismatch_upgraded_count=0`。
6. 总账三个真实用户选区以及每类正例完成 `resolve -> persist -> project` 往返,桌面和 390px 均无“部分定位”提示且动作完整。
7. image-only 节点不计入文本 exact 失败,不污染邻接选择;有唯一 region 才启用对象导航。
8. 输入相同的两次 candidate digest 一致;source/LID 变化按新基座与 migration map 交付,旧基座不变。
9. Core/Server/Memory/Reader/Web/Rust workspace、typecheck、production build、goldset、真书 audit、Playwright 和 Setup release gate 全绿。
10. `PDF选区适配问题总账.md` 每项状态更新为 `fixed | intentional`,并附最终 hash、计数、回放和测试证据;不得只写“覆盖率提高”。

## 8. 切片交付纪律

每个 PR 只解决本节声明的一层,按以下顺序收口:

```text
red fixture committed or demonstrably red
  -> implementation
  -> owning tests green
  -> broader regression green
  -> real-book audit delta explained
  -> issue ledger updated
  -> docs/代码链路.md appended
  -> commit
  -> checkpoint refreshed when pausing or changing slice
```

任何 PR 若需要扩大 `FrozenIntent`、新增 OCR、改变 citation 真相或放宽 material mismatch,必须停止并另立 ADR;不得在本方案中顺手吸收。
