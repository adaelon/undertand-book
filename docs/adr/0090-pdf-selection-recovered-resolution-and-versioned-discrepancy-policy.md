# ADR-0090 PDF selection recovered resolution and versioned discrepancy policy

Status: Accepted, 2026-07-22.
Extends: ADR-0074 and ADR-0082.

### §1 产物精度与选区可定位性

**决策**:产物精度与用户选区可定位性分层判定。

**否决**:
- 任一 `partial` entry 都显示部分定位:会把无害表示差异升级成用户风险。
- 按字符覆盖率自动升级:少量缺字也可能改变语义。

**命门**:完整性错误、实质字符缺失、歧义或非单调绑定仍必须 fail-closed。
**展开**:[PDF 选区可恢复定位切片方案](../切片方案-pdf选区可恢复定位.md)

### §2 解析依据

**决策**:`resolved` 正交记录 `exact | recovered` 解析依据。

**否决**:
- 增加第四种用户能力状态:重复 `resolved` 的动作矩阵并泄露内部诊断。
- 静默并入 `resolved` 且不留依据:无法度量容错命中和误升级。
- 对 `recovered` 继续显示警告:不能改善频繁“部分定位”的体验。

**命门**:`recovered` 不得改写 artifact 的 `char_exact | region_exact | partial | unmapped` 精度。
**展开**:[PDF 选区可恢复定位切片方案](../切片方案-pdf选区可恢复定位.md)

### §3 版本化差异白名单

**决策**:v1 只准入布局空白与已证明的连字符类表示差异。

**否决**:
- 忽略全部 Unicode dash:会吞掉范围标点、公式负号和真实语义差异。
- 把任意标点差异视为格式噪声:无法证明引用文本未被改变。
- 提供用户侧“宽松模式”:会让证据可靠性随偏好漂移。

**命门**:新增类别须独立登记真实样本、最小正例、语义反例与全量回归结果。
**何时回头**:OCR 或扫描件进入支持范围时建立独立策略版本。
**展开**:[PDF 选区可恢复定位切片方案](../切片方案-pdf选区可恢复定位.md)

### §4 可恢复操作边界

**决策**:`recovered` 通过同一门禁后获得 `resolved` 用户动作。

**否决**:
- 只去掉文案但继续禁用高亮和笔记:状态与能力仍然矛盾。
- 为缺失字符合成 glyph bbox:会把推断几何冒充字符证据。
- 用 raw quote 替换 canonical source:会破坏正文与 citation 真相。

**命门**:规范 range 只跨越已分类差异;PDF 只绘制已证实 glyph rect,末端标记必须有精确终点。
**展开**:[PDF 选区可恢复定位切片方案](../切片方案-pdf选区可恢复定位.md)

### §5 运行时容错与上游修复

**决策**:运行时保护旧产物,上游仍修复语义连字符投影。

**否决**:
- 只修 aligner:既有 partial artifact 仍持续打扰用户。
- 只让 Server 忽略连字符:新产物继续丢失可证明字符。
- 强制所有书先重建:把兼容性成本转嫁给用户。

**命门**:新构建应尽量产出 `exact`;`recovered` 是兼容防线而非质量目标。
**展开**:[PDF 选区可恢复定位切片方案](../切片方案-pdf选区可恢复定位.md)

### §6 发布门

**决策**:resolve、反向投影、持久化与 UI 同版闭合。

**否决**:
- 先放开 resolve 再补反向投影:保存后的标注无法稳定回显。
- 只用合成 fixture:无法证明真实 PDF 拖选行为。
- 只测当前长段落:容易过拟合单一错误形态。

**命门**:错误升级必须为零,旧 artifact recovered 与新 artifact exact 两条路径都须通过。
**展开**:[PDF 选区可恢复定位切片方案](../切片方案-pdf选区可恢复定位.md)

### §7 v2 完整简单公式表示差异

**修订**:2026-07-22 接受 `formula_representation`,策略升级为 `pdf_selection_recovery.v2`。

**决策**:只有源公式能确定性投影为同一可见字符序列、该序列在相邻精确文本锚之间唯一出现、且本次选区覆盖公式全部已证实 glyph 时,才允许把 LaTeX 源标记与 PDF 排版显示之间的差异判为 recovered。公式 entry 保持 `partial`,不得冒充普通 `char_exact`;canonical range 仍保存完整公式源码,PDF 只返回真实 glyph rect。

**否决**:
- 直接把 `region_exact` 公式开放给字符选区:区域存在不证明变量、下标或运算符完整。
- 对任意 LaTeX 调用宽松文本化:未知命令、结构重排与可见装饰可能改变语义或阅读顺序。
- 只比较覆盖率或公式首尾字符:中间缺下标、替换变量仍可能被误升级。

**命门**:缺任一显示字符、变量/运算符变化、只选中公式一部分、PDF 暴露未映射的 `_ { } ^ $` 等实质字符、未知 LaTeX 命令或跨页锚点时必须 fail-closed。正例为真实 Eq. 9 句中的 `W_{Ui}, W_{Di}`、`m`、`\boldsymbol{k}_i`、`\boldsymbol{v}_i`;强制反例为缺下标字符与 `W -> X` 变量替换。
**展开**:[PDF 选区可恢复定位切片方案](../切片方案-pdf选区可恢复定位.md)

### §8 v1 Markdown display token 与 glyph 等价

**修订**:2026-07-22 注册构建期 `pdf_display_token_policy.v1`；它不扩大运行时 `pdf_selection_recovery.v2` 的 accepted differences。

**决策**:Markdown 结构字符是否可见只由 positioned parser role 决定；heading/list marker 可从 display token 中排除，code 不继承 prose 规则。prose 字符仅接受弯/直单双引号、限定 hyphen 表示与 Unicode NFKC ligature 的逐字符等价；策略版本写入新 V2 source map 与 alignment report config，二者漂移或 Server 遇到显式未知版本时 fail-closed。历史 V2 两侧均缺字段时保持只读兼容。

**否决**:
- 删除所有 Markdown 标点或按首字符猜 heading/list：会吞掉 code 与正文实质字符。
- 忽略任意 Unicode dash：会混同范围 dash、em dash、数学负号和减法运算符。
- 仅凭 coverage 把缺冒号/句点升级：缺失标点仍可能改变语义或引用内容。

**命门**:parser role 不明、code 中引号/括号/减号、缺失标点、en/em/math minus 替换、跨产物 policy 漂移和未知版本均拒绝升级。真实书分类审计只证明类别归属，不改写当前 artifact precision；用户动作闭合仍受 PR14-PR20 发布门约束。

### §9 v1 公式 source AST 与透明 wrapper

**修订**:2026-07-22 注册构建期 `formula_source_ast.v1`，并把版本写入 V2 alignment config hash；历史 V2 report 可缺该字段。

**决策**:公式 source 必须由成熟 LaTeX parser 产生带 offset 的 AST，再由本地版本化适配层分类。`underline/text/textit/textbf` 与既有简单样式仅在闭合单参数 group 和完整子 token span 下透明；layout command 与上下标保留结构关系。text-mode 空白只可由同级已定位节点间的纯 whitespace gap 恢复。

**否决**:
- 扩充 `FORMULA_WRAPPER_COMMANDS` 后逐字符删命令：无法证明参数边界，也会把未知/损坏命令伪装成正文。
- 把 `frac/sum/sqrt/underbrace` 当 wrapper：这些节点产生或二维重排 glyph，必须由 PR16 做结构几何验证。
- 接受 parser 自动恢复的缺 group：语法容错不是 source-display 等价证据。

**命门**:unknown command、嵌套 math delimiter、缺 group、无位置 token、glyph transform 或不支持 AST node 均不得进入简单 source projection。PR14 的 projectable 只证明 source token，不证明 PR15 region、PR16 glyph assignment 或 PR20 正式发布。

### §10 v1 公式 page-column region locator

**修订**:2026-07-23 注册构建期 `pdf_formula_region_policy.v1`；版本写入 V2 source map 与 alignment report config/hash，历史 V2 两侧缺字段仍可读取。

**决策**:公式 region 只能在 PR12 独占 child window 中由 source signature、source order、单一 page/column lane 与相邻已证明 child 边界共同确定。一个 window 含多个公式时，必须存在唯一一条覆盖全部公式、顺序单调且 PDF 区间不重叠的完整候选链。standalone、单侧、段首和段末不要求虚构另一侧正文锚；PR15 新定位只产生 `region_exact`，不产生 source assignment。

**否决**:
- 按最近 paragraph bbox 或最近同名公式猜 region：会把布局邻近误当公式对象证据。
- 每个重复短式独立取第一个 occurrence：局部唯一不等于整链唯一，会使多个 LID 争用或错序。
- 让 signature 跨页/跨栏串接：PDF key 连续不证明它们属于同一公式对象。
- 因 PR15 找到 region 就复用 simple-display source assignment：几何对象证据不证明 source token/glyph 一一对应。

**命门**:多整链、跨 lane、相邻锚 lane 冲突必须 fail-closed；`formula has no unique bounded PDF gap` 继续归 PR16，unit 未定位继续归 PR18。所有有 region 的 A007 successor 必须与 reviewed page/column 一致，显式未知 locator policy 在 Core/Server 均拒绝。

### §11 v1 结构化公式 glyph 投影

**修订**:2026-07-23 注册构建期 `pdf_formula_glyph_policy.v1`；版本写入 V2 source map 与 alignment report config/hash，历史 V2 两侧缺字段仍可读取。

**决策**:PR14 positioned AST 被编译为有限、显式的 glyph token variants，每个 token 保留 source span。普通序列必须在 PR15/PR12 局部窗口中完整连续匹配；上下标、分数、根号、stack、求和/乘积 limits、accent/brace 还必须满足 AST group 的二维 `above/right_of` 关系。每个 PDF character ID 在一个公式内和公式之间都只能有一个 owner；不可见 source markup 不生成 bbox。成功结果保持 `partial`，selection shard 只写经证明的 glyph/source assignment。

**否决**:
- 按字符串覆盖率、首尾 glyph 或最长子序列升级：会掩盖缺下标、变量替换和中间运算符变化。
- 把任意 LaTeX command 删除后匹配：unknown command、结构重排和可见装饰没有等价证据。
- 为二维结构只验证字符顺序：PDF 提取顺序不能证明 numerator/denominator、上下标或 limits 的视觉关系。
- 让重复公式各自取第一个 match 或复用同一 PDF char：会制造跨 LID 双 owner。

**命门**:缺 glyph、变量/运算符变化、flat script、错误上下 lane、跨 page/column、多个完整链、未知 AST 结构和重复 character ID 均 fail-closed。unsupported standalone formula 只有在 unit 已唯一定位、仅含该 child 且全部 glyph 同一 page/column 时才允许对象级 `region_exact`，并且仍不得生成 selection assignment。Core 拒绝 map/report 版本漂移，Server 拒绝显式未知 policy；历史缺字段 V2 只保持兼容读取。

### §12 v1 Image 对象 region 与文本隔离

**修订**:2026-07-23 注册构建期 `pdf_asset_region_policy.v1`；版本写入 V2 source map 与 alignment report config/hash，历史 V2 两侧缺字段仍可读取。

**决策**:image leaf 只消费 PDF.js operator list 提取并变换到 PDF user space 的 image/inline/mask/Form bbox。绑定必须由 source image 顺序和以下唯一证据之一成立：前后已证明 source anchor 内等量完整对象链；相邻同页 caption 上方、横向重叠且阈值内的唯一对象；两个已证明 asset binding 之间等量唯一剩余对象链。成功只产生对象级 `region_exact`，不产生 exact source span 或 selection assignment。image-only unit 独立计数，不进入 text location quality 和 reason 分母。

**否决**:
- OCR 图片文字或用 Markdown alt 搜索 PDF：会把内容相似误当对象 ownership，且引入未版本化识别误差。
- 取最近对象、第一对象或按 draw order 强配：局部距离与绘制顺序不证明 source image 对应关系。
- 把 caption bbox 或整页 bbox 当 image region：会扩大导航/高亮区域并污染相邻正文选择。
- 把 image region 写入 selection shard：对象 region 没有 source character assignment，不能参与文本拖选。

**命门**:无对象、重复对象、候选数量不等、跨页错误候选、缺一侧必要边界或存在多条对象链时必须 `asset_unmapped`。每个 PDF object 最多一个 image owner；Core 拒绝 map/report 版本漂移，Server 拒绝显式未知 policy，历史缺字段 V2 只保持兼容读取。
