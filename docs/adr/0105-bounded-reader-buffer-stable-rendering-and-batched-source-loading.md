# ADR-0105 Bounded reader buffer, stable rendering, and batched source loading

Status: Accepted, 2026-08-11.
Extends: ADR-0014, ADR-0024 and ADR-0043.
Revises: ADR-0043 的虚拟流验收口径，以及 ADR-0014 的 Manifest 展示投影。
Change type: [纯技术]。

在 `e64d5f0` 上，Markdown reader 的 `mergeSegments` 只追加不回收，滚动探针反复扫描全部 `[data-lid]`，模板更新可重新执行 Markdown/KaTeX 与全量 annotation 过滤；启动还在首批正文前等待全部目录标题，边缘补页则逐 LID 请求正文和公式语义。`quantification-essence` 当前基座含 2,623 个正文叶和 893 个公式叶，会放大这些机制。尚无同版本端到端 trace，故它们仍是 High-value hypotheses，不是已测瓶颈；实施顺序见[切片方案](../切片方案-reader有界虚拟流与批量正文加载.md)。Performance Hints LID `1.7.2`、`1.9.2`、`1.12.2`、`1.8.5.2` 分别支持先测量、消除重复遍历、跳过不必要工作与批量跨越昂贵边界。

### §1 性能证据门

**决策**:先建立长书滚动基线再宣称收益。

**否决**:
- 以静态代码直接认定瓶颈:当前没有 profile、Long Task、heap 或请求瀑布。
- 只跑 Markdown 微基准:不能代表滚动、布局、网络与 Vue 更新的端到端路径。
- 先调大 preload/width:会改变输入规模并遮蔽缓冲增长。

**命门**:基线固定 `e64d5f0`，同一输入预热 2 次、正式 5 次，记录 20/500/1000/2623 叶检查点的帧间隔、Long Task、挂载 LID/DOM、heap、探针与 Markdown 调用、请求数和字节；正确性断言与性能计数同跑。
**何时回头**:若成本不随阅读深度增长且采样不落在这些路径，停止对应优化并按 trace 重新立项。

### §2 有界虚拟缓冲

**决策**:Markdown 正文只挂载有界连续缓冲。

**否决**:
- 继续 append-only:阅读深度会直接变成 DOM、布局与更新规模。
- 整窗替换:恢复 ADR-0043 已否决的跳屏与闪烁。
- 用分页隐藏增长:改变连续阅读模型与 LID 隐形契约。

**命门**:稳定态 `mounted_lids <= 3 * viewport.width`，默认最多 60 叶；一次插入/回收事务最多短暂到 `4 * width`，未完成回收前禁止第二次边缘加载。缓冲保持连续叶序，反向回收以稳定 render-item 高度账本和上下 spacer 补偿；Note 卡、图片和 KaTeX 均计入实测高度。非折叠原生选区或 Note 指针手势期间延后回收，手势结束先固化 LID/UTF-16 状态再清偿。
**何时回头**:若单个异常大叶本身即可突破 DOM/帧预算，另立叶内分块决策，不放宽全书缓冲上限。

### §3 滚动热路径

**决策**:滚动定位只处理可见注册项并按帧合并。

**否决**:
- 每个 scroll 事件 `querySelectorAll + getBoundingClientRect`:成本随累计 DOM 增长并强制布局读取。
- 只加时间节流:降低更新频率但不消除每次全量扫描。
- 在硬边缘拦截 wheel:数据未到时会把正常滚轮直接表现为卡死。

**命门**:LID 元素注册表与 IntersectionObserver 只维护挂载/可见候选，probe 和边缘 sentinel 每帧至多结算一次；当前 LID 仍取阅读区约 28% 探针，只有 LID 改变才 emit。预取提前触发，硬边缘保留浏览器原生停止行为，不 `preventDefault` 等待 I/O。
**何时回头**:若 WebView2 的 IntersectionObserver 在真实书上出现漏报，退回有界注册表的二分/可见集扫描，不退回全 DOM 查询。

### §4 稳定段渲染

**决策**:正文 HTML 与标注索引按 LID 失效。

**否决**:
- 父组件每次更新重算全部 `renderSeg`:当前 LID 变化可能重新进入 Markdown/KaTeX。
- 缓存最终带 `<mark>` HTML:focus、highlight 与选区失效边界会混入正文缓存。
- 缓存整本书:把 DOM 增长换成无界 JS heap。

**命门**:稳定 segment/render-item 组件隔离更新；基础 HTML 只由 `source_fingerprint + renderer_version + lid + text` 决定，annotation、focus、selected 与 Note 状态独立叠加。`annotationsByLid`、`highlightsByLid` 和 focus ranges 在输入 revision 改变时一次构建；正文与 HTML LRU 均不超过 `5 * viewport.width`，换书、换源或 renderer 版本变化时清空。
**何时回头**:若计数证明 Vue 已只重算受影响节点，保留索引但省去额外组件/缓存复杂度。

### §5 区间正文与公式批取

**决策**:连续缺页按 UTF-16 区间批取。

**否决**:
- `Promise.all(api.text × N)`:并发不消除请求、解析和共享状态锁边界次数。
- 继续增加并发:只重叠部分 latency，不能降低总资源成本。
- 按 UTF-8 字节或 Unicode scalar 拆分:会破坏既有 UTF-16 span、选区与引用边界。

**命门**:正文复用 `book.text(first_lid,end_lid)`，客户端用 Manifest 绝对 UTF-16 span 相对首 span 拆回逐 LID 文本，并逐项校验长度、顺序和范围；公式新增只读 `book.formula_semantics_range(start_lid,end_lid)`，只返回命中项，调用方据请求公式 LID 集建立正/负缓存。一个冷的连续缺页至多一次正文范围请求和一次公式范围请求。
**何时回头**:若 leaf span 不是受校验的有序区间或范围响应不能逐 LID 无损复原，批取必须失败关闭并保留旧逐 LID 路径作为显式回滚开关，不得猜分隔符。

### §6 首屏目录投影

**决策**:首批正文不等待目录标题。

**否决**:
- `await loadOutlineTitles`:目录规模直接进入 reader 首屏关键路径。
- 改成后台 N 个 `book.text`:虽不阻塞首屏，仍保留重叠请求风暴。
- 用 LLM 生成标题:为确定性展示引入成本、延迟和不稳定输出。

**命门**:ManifestNode 增加确定性 `display_title`：在节点 span 内取首个非空行、剥 Markdown heading marker、按 UTF-16 安全截至 80 units，空值回退 LID；目录和章节读位感共用该投影。初始化拿到 Manifest 后即可并行准备目录，reader state 与首个正文窗口不再等待任何标题正文请求。
**何时回头**:若真实格式存在高比例错误标题，再扩展确定性 title parser；不得恢复“为一行标题读取整个子树”。

### §7 发布与回滚

**决策**:虚拟化与批取分闸发布。

**否决**:
- 把缓冲、渲染、I/O 和标题合成一次大切换:失败时无法定位或独立回滚。
- 范围校验失败后静默展示近似文本:会污染 LID、引用和选区正确性。
- 永久保留双实现:长期分叉会让性能与正确性契约再次漂移。

**命门**:`bounded_buffer_v1` 与 `batched_hydration_v1` 在发布期独立开关；每刀同时锁定 goto/current LID、双向滚动锚、Highlight、Note 展开态、原生选区、图片与 KaTeX。长书门通过后删除旧 append-only 与逐 LID 正常路径；任何 correctness gate 失败立即关闭对应闸，不以性能结果覆盖。
**何时回头**:参考机和 WebView2 的端到端数据不能同时证明深度成本趋平时，保留已证实的独立改进并撤销未证实部分。
